/**
 * Local listener taste & behavioral profile for the Browser app.
 *
 * Persists play frequency, completion vs early skips, recency, mood preferences,
 * artist discoveries, and synced account likes in localStorage so recommendation
 * ranking and mood discovery learn from actual listening behavior without
 * blocking UI or sending personal telemetry off-device.
 */

const STORAGE_KEY = 'niko:taste:v1';
const MAX_TRACKS = 400;
const MAX_RECENT_SEQUENCE = 80;
const DAY_MS = 86_400_000;

export interface StoredTrackSignal {
  videoId: string;
  title: string;
  artist: string;
  plays: number;
  completions: number;
  totalSec: number;
  skips: number;
  earlySkips: number;
  firstSeenAt: number;
  lastPlayedAt: number;
  lastSkippedAt: number;
  liked?: boolean;
}

export interface TasteProfileData {
  version: 1;
  tracks: Record<string, StoredTrackSignal>;
  /** Most recent track videoIds first (for recency fatigue & anti-repetition). */
  recentTrackIds: string[];
  /** Mood IDs mapped to weighted preference score (updated on select + completions). */
  moods: Record<string, number>;
  /** Mood queue opener IDs recently served, to vary mood openings. */
  moodOpeners: Record<string, string[]>;
  /** Known liked videoIds (synced from YTM library & favorite button). */
  likedIds: string[];
  /** Artist first-seen timestamps (normalized lowercase lead name). */
  artistFirstSeen: Record<string, number>;
}

function emptyProfile(): TasteProfileData {
  return {
    version: 1,
    tracks: {},
    recentTrackIds: [],
    moods: {},
    moodOpeners: {},
    likedIds: [],
    artistFirstSeen: {},
  };
}

let cachedProfile: TasteProfileData | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getTasteProfile(): TasteProfileData {
  if (cachedProfile) return cachedProfile;
  const store = storage();
  if (!store) {
    cachedProfile = emptyProfile();
    return cachedProfile;
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) {
      cachedProfile = emptyProfile();
      return cachedProfile;
    }
    const parsed = JSON.parse(raw) as Partial<TasteProfileData> | null;
    if (!parsed || typeof parsed !== 'object') {
      cachedProfile = emptyProfile();
      return cachedProfile;
    }
    cachedProfile = {
      version: 1,
      tracks: parsed.tracks && typeof parsed.tracks === 'object' ? { ...parsed.tracks } : {},
      recentTrackIds: Array.isArray(parsed.recentTrackIds) ? parsed.recentTrackIds.slice(0, MAX_RECENT_SEQUENCE) : [],
      moods: parsed.moods && typeof parsed.moods === 'object' ? { ...parsed.moods } : {},
      moodOpeners: parsed.moodOpeners && typeof parsed.moodOpeners === 'object' ? { ...parsed.moodOpeners } : {},
      likedIds: Array.isArray(parsed.likedIds) ? parsed.likedIds : [],
      artistFirstSeen: parsed.artistFirstSeen && typeof parsed.artistFirstSeen === 'object' ? { ...parsed.artistFirstSeen } : {},
    };
    return cachedProfile;
  } catch {
    cachedProfile = emptyProfile();
    return cachedProfile;
  }
}

function persist(profile: TasteProfileData): void {
  pruneTracks(profile);
  cachedProfile = profile;
  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // Ignore quota errors
    }
  }
  listeners.forEach((fn) => fn());
}

export function subscribeTasteProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pruneTracks(profile: TasteProfileData): void {
  const entries = Object.values(profile.tracks);
  if (entries.length <= MAX_TRACKS) return;
  entries.sort((a, b) => {
    const weightA = a.plays * 3 + (a.liked ? 5 : 0) + (a.lastPlayedAt / DAY_MS) * 0.1 - a.earlySkips * 1.5;
    const weightB = b.plays * 3 + (b.liked ? 5 : 0) + (b.lastPlayedAt / DAY_MS) * 0.1 - b.earlySkips * 1.5;
    return weightB - weightA;
  });
  const keep = new Set(entries.slice(0, MAX_TRACKS).map((e) => e.videoId));
  for (const key of Object.keys(profile.tracks)) {
    if (!keep.has(key)) delete profile.tracks[key];
  }
}

function normalizedLeadArtists(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/\s*-\s*topic\b/gi, ' ')
    .split(/,|&|·|•|;|\bfeat\.?|\bft\.?|\bfeaturing|\bx\b|\bwith\b/i)
    .map((s) => s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export interface TrackEventInput {
  videoId: string;
  title: string;
  artist: string;
  playedSec: number;
  durationSec: number | null;
  completed?: boolean;
  moodId?: string | null;
}

/** Records sustained playback or completion of a track. */
export function recordTrackPlay(event: TrackEventInput, now = Date.now()): void {
  if (!event.videoId || !event.title) return;
  const profile = cloneProfile(getTasteProfile());
  const existing = profile.tracks[event.videoId];
  const duration = event.durationSec && event.durationSec > 0 ? event.durationSec : null;
  const isCompleted = event.completed === true || (duration !== null && event.playedSec >= Math.min(duration * 0.75, 180));
  const countsAsPlay = isCompleted || event.playedSec >= 25;

  const entry: StoredTrackSignal = existing
    ? { ...existing }
    : {
        videoId: event.videoId,
        title: event.title,
        artist: event.artist,
        plays: 0,
        completions: 0,
        totalSec: 0,
        skips: 0,
        earlySkips: 0,
        firstSeenAt: now,
        lastPlayedAt: now,
        lastSkippedAt: 0,
      };

  if (countsAsPlay) {
    entry.plays += 1;
    entry.lastPlayedAt = now;
  }
  if (isCompleted) entry.completions += 1;
  entry.totalSec += Math.max(0, Math.round(event.playedSec));
  profile.tracks[event.videoId] = entry;

  if (countsAsPlay) {
    profile.recentTrackIds = [event.videoId, ...profile.recentTrackIds.filter((id) => id !== event.videoId)].slice(
      0,
      MAX_RECENT_SEQUENCE,
    );
    for (const artist of normalizedLeadArtists(event.artist)) {
      if (!(artist in profile.artistFirstSeen)) {
        profile.artistFirstSeen[artist] = now;
      }
    }
    if (event.moodId && isCompleted) {
      profile.moods[event.moodId] = (profile.moods[event.moodId] ?? 0) + 0.6;
    }
  }

  persist(profile);
}

/** Records a manual skip (stronger penalty when skipped early before 30s & <35% duration). */
export function recordTrackSkip(
  event: Omit<TrackEventInput, 'completed'>,
  now = Date.now(),
): void {
  if (!event.videoId || !event.title) return;
  const profile = cloneProfile(getTasteProfile());
  const existing = profile.tracks[event.videoId];
  const duration = event.durationSec && event.durationSec > 0 ? event.durationSec : null;
  const isEarly =
    event.playedSec >= 1 &&
    event.playedSec < 30 &&
    (duration === null || duration >= 35) &&
    (duration === null || event.playedSec / duration < 0.35);

  const entry: StoredTrackSignal = existing
    ? { ...existing }
    : {
        videoId: event.videoId,
        title: event.title,
        artist: event.artist,
        plays: 0,
        completions: 0,
        totalSec: 0,
        skips: 0,
        earlySkips: 0,
        firstSeenAt: now,
        lastPlayedAt: 0,
        lastSkippedAt: now,
      };

  entry.skips += 1;
  if (isEarly) entry.earlySkips += 1;
  entry.lastSkippedAt = now;
  entry.totalSec += Math.max(0, Math.round(event.playedSec));
  profile.tracks[event.videoId] = entry;

  if (event.moodId && isEarly) {
    profile.moods[event.moodId] = Math.max(0, (profile.moods[event.moodId] ?? 0) - 0.3);
  }

  persist(profile);
}

/** Records user explicitly picking a mood station. */
export function recordMoodPick(moodId: string, openerTrackIds: string[] = []): void {
  const profile = cloneProfile(getTasteProfile());
  profile.moods[moodId] = (profile.moods[moodId] ?? 0) + 1.0;
  if (openerTrackIds.length) {
    const prev = profile.moodOpeners[moodId] ?? [];
    profile.moodOpeners[moodId] = [...openerTrackIds.slice(0, 6), ...prev].slice(0, 24);
  }
  persist(profile);
}

/** Updates local liked status immediately when user thumbs up / unlikes a song or library syncs. */
export function setTrackLiked(videoId: string, liked: boolean, meta?: { title: string; artist: string }, now = Date.now()): void {
  const profile = cloneProfile(getTasteProfile());
  const likedSet = new Set(profile.likedIds);
  if (liked) likedSet.add(videoId);
  else likedSet.delete(videoId);
  profile.likedIds = [...likedSet];

  const existing = profile.tracks[videoId];
  if (existing || meta) {
    const base: StoredTrackSignal = existing
      ? { ...existing }
      : {
          videoId,
          title: meta?.title ?? '',
          artist: meta?.artist ?? '',
          plays: 0,
          completions: 0,
          totalSec: 0,
          skips: 0,
          earlySkips: 0,
          firstSeenAt: now,
          lastPlayedAt: 0,
          lastSkippedAt: 0,
        };
    base.liked = liked;
    profile.tracks[videoId] = base;
  }
  persist(profile);
}

/** Batch-syncs liked song IDs from the user's YouTube Music library without wiping local stats. */
export function syncLikedIds(videoIds: string[]): void {
  if (!videoIds.length) return;
  const profile = cloneProfile(getTasteProfile());
  const next = new Set(profile.likedIds);
  let changed = false;
  for (const id of videoIds) {
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  profile.likedIds = [...next];
  persist(profile);
}

/** Clears local taste storage (useful for sign-out / tests). */
export function resetTasteProfile(): void {
  cachedProfile = emptyProfile();
  storage()?.removeItem(STORAGE_KEY);
  listeners.forEach((fn) => fn());
}

function cloneProfile(p: TasteProfileData): TasteProfileData {
  return {
    version: 1,
    tracks: { ...p.tracks },
    recentTrackIds: [...p.recentTrackIds],
    moods: { ...p.moods },
    moodOpeners: { ...p.moodOpeners },
    likedIds: [...p.likedIds],
    artistFirstSeen: { ...p.artistFirstSeen },
  };
}

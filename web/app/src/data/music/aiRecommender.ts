/**
 * Silent background AI & taste recommendation engine.
 *
 * Runs strictly behind the scenes (no user-facing AI UI or API-key config):
 * - Builds an acoustic & behavioural taste fingerprint from listening history,
 *   completions, skips, likes, and cached AutoMix audio analyses (BPM, energy, key).
 * - Optionally queries the backend `/api/ai/recommend` endpoint (server-side AI only)
 *   when a deployment backend URL is configured, degrading silently otherwise.
 * - Expands into unheard songs via artist similarity graphs, watch radios, and search,
 *   then caches clean, fan-upload-free picks for Home, Discover Mix, and AutoPlay.
 */

import { config } from '@/config';
import { getAllAnalyses } from '@/playback/automix/db';
import type { TrackAnalysis } from '@/playback/automix/analysis/types';
import { artistLine, artistSet } from '@/playback/queue/builder';
import { fetchArtist, fetchRadio, searchSongs } from './api';
import {
  isFanReuploadTrack,
  type AudioFeatureHint,
  type AudioTasteSignature,
  type MoodDefinition,
  type RankingMode,
  rankTracks,
  type ScoredCandidate,
} from './recommendations';
import type { TasteProfileData } from './tasteProfile';
import type { Track } from './types';

const CACHE_KEY = 'niko:ai-discovery:v1';
const CACHE_TTL_MS = 4 * 60 * 60_000;
const BACKEND_TIMEOUT_MS = 5000;

interface DiscoveryCacheEntry {
  fingerprint: string;
  updatedAt: number;
  tracks: Track[];
  recommendedIds: string[];
  avoidKeywords: string[];
}

interface BackendAIResponse {
  enabled: boolean;
  provider?: string;
  queries: string[];
  artists: string[];
  avoidKeywords?: string[];
}

const EMPTY_TRACKS: Track[] = [];
const listeners = new Set<() => void>();
let memCache: DiscoveryCacheEntry | null | undefined;
let cachedTracksView: Track[] = EMPTY_TRACKS;
let cachedFeatures = new Map<string, AudioFeatureHint>();
let latestSignature: AudioTasteSignature | null = null;
let inFlightKey: string | null = null;
let inFlightPromise: Promise<Track[]> | null = null;

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function subscribeAiDiscovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStorageCache(): DiscoveryCacheEntry | null {
  if (memCache !== undefined) return memCache;
  try {
    if (typeof localStorage === 'undefined') {
      memCache = null;
      return null;
    }
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      memCache = null;
      return null;
    }
    const parsed = JSON.parse(raw) as DiscoveryCacheEntry | null;
    if (!parsed || !Array.isArray(parsed.tracks) || typeof parsed.updatedAt !== 'number') {
      memCache = null;
      return null;
    }
    memCache = parsed;
    cachedTracksView = parsed.tracks;
    return parsed;
  } catch {
    memCache = null;
    return null;
  }
}

function writeStorageCache(entry: DiscoveryCacheEntry): void {
  memCache = entry;
  cachedTracksView = entry.tracks;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    }
  } catch {
    // Ignore storage quota errors cleanly.
  }
  notify();
}

/** Synchronous snapshot of cached background-discovered tracks matching listener taste. */
export function getCachedTasteDiscoveries(): Track[] {
  const cached = readStorageCache();
  return cached ? cachedTracksView : EMPTY_TRACKS;
}

/** Synchronous snapshot of IDs curated by background taste discovery. */
export function getCachedRecommendedIdSet(): ReadonlySet<string> {
  const cached = readStorageCache();
  return new Set(cached?.recommendedIds ?? []);
}

export function getCachedAudioProfile(): {
  signature: AudioTasteSignature | null;
  features: ReadonlyMap<string, AudioFeatureHint>;
} {
  return { signature: latestSignature, features: cachedFeatures };
}

/** Detects non-trivial Unicode scripts present in track titles & artist names. */
export function detectScripts(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of texts) {
    if (!raw) continue;
    if (/[\u0900-\u097F]/.test(raw)) counts.set('devanagari', (counts.get('devanagari') ?? 0) + 1);
    if (/[\u0B80-\u0BFF]/.test(raw)) counts.set('tamil', (counts.get('tamil') ?? 0) + 1);
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(raw)) counts.set('hangul', (counts.get('hangul') ?? 0) + 1);
    if (/[\u3040-\u30FF]/.test(raw)) counts.set('kana', (counts.get('kana') ?? 0) + 1);
    if (/[\u4E00-\u9FFF]/.test(raw)) counts.set('cjk', (counts.get('cjk') ?? 0) + 1);
    if (/[\u0600-\u06FF]/.test(raw)) counts.set('arabic', (counts.get('arabic') ?? 0) + 1);
    if (/[\u0400-\u04FF]/.test(raw)) counts.set('cyrillic', (counts.get('cyrillic') ?? 0) + 1);
    if (/[A-Za-z]/.test(raw)) counts.set('latin', (counts.get('latin') ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
}

/** Summarizes listener behaviour + acoustic analyses into a compact background taste profile. */
export function summarizeTasteForAI(
  profile: TasteProfileData,
  analyses: readonly TrackAnalysis[] = [],
): {
  fingerprint: string;
  topTracks: { videoId: string; title: string; artist: string }[];
  likedArtists: string[];
  skippedArtists: string[];
  signature: AudioTasteSignature;
  featureMap: Map<string, AudioFeatureHint>;
} {
  const likedSet = new Set(profile.likedIds);
  const scored = Object.values(profile.tracks)
    .map((sig) => {
      const liked = sig.liked === true || likedSet.has(sig.videoId);
      const rate = sig.plays > 0 ? sig.completions / sig.plays : 0;
      const weight = (liked ? 10 : 0) + sig.completions * 2.4 + sig.plays * 1.4 + rate * 3 - sig.earlySkips * 5;
      return { sig, liked, weight };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const topTracks = scored.slice(0, 12).map(({ sig }) => ({
    videoId: sig.videoId,
    title: sig.title,
    artist: sig.artist,
  }));

  const artistWeights = new Map<string, number>();
  const artistDisplay = new Map<string, string>();
  const skippedStats = new Map<string, { earlySkips: number; good: number; raw: string }>();

  for (const sig of Object.values(profile.tracks)) {
    const liked = sig.liked === true || likedSet.has(sig.videoId);
    const credits = [...artistSet(sig.artist)];
    const rawFirst = sig.artist.split(',')[0]?.trim() ?? '';
    const net = Math.max(0, sig.plays + sig.completions * 0.8 + (liked ? 3 : 0) - sig.earlySkips * 2);
    for (const a of credits) {
      if (net > 0) {
        artistWeights.set(a, (artistWeights.get(a) ?? 0) + net);
        if (!artistDisplay.has(a) && rawFirst) artistDisplay.set(a, rawFirst);
      }
      const prev = skippedStats.get(a) ?? { earlySkips: 0, good: 0, raw: rawFirst };
      skippedStats.set(a, {
        earlySkips: prev.earlySkips + sig.earlySkips,
        good: prev.good + sig.completions + (liked ? 1 : 0),
        raw: prev.raw || rawFirst,
      });
    }
  }

  const likedArtists = [...artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key]) => artistDisplay.get(key) ?? key);

  const avoidedKeys: string[] = [];
  const skippedArtists: string[] = [];
  for (const [key, st] of skippedStats) {
    if (st.earlySkips >= 2 && st.good === 0 && (artistWeights.get(key) ?? 0) === 0) {
      avoidedKeys.push(key);
      if (st.raw && skippedArtists.length < 8) skippedArtists.push(st.raw);
    }
  }

  const preferredScripts = detectScripts(topTracks.map((t) => `${t.title} ${t.artist}`));

  const featureMap = new Map<string, AudioFeatureHint>();
  let bpmSum = 0;
  let bpmWeight = 0;
  let energySum = 0;
  let energyWeight = 0;
  const keyCounts = new Map<string, number>();

  for (const a of analyses) {
    const camelot = a.camelot ? `${a.camelot.num}${a.camelot.letter}` : null;
    featureMap.set(a.fileKey, { bpm: a.bpm, energy: a.energy, camelot });
    const sig = profile.tracks[a.fileKey];
    const liked = likedSet.has(a.fileKey) || sig?.liked === true;
    const w = liked ? 3 : sig && (sig.completions > 0 || sig.plays > 0) && sig.earlySkips === 0 ? 1 + sig.completions * 0.5 : 0;
    if (w > 0) {
      if (a.bpm && a.bpm > 40 && a.bpm < 240) {
        bpmSum += a.bpm * w;
        bpmWeight += w;
      }
      if (Number.isFinite(a.energy) && a.energy > 0) {
        energySum += a.energy * w;
        energyWeight += w;
      }
      if (camelot) keyCounts.set(camelot, (keyCounts.get(camelot) ?? 0) + w);
    }
  }

  const topKeys = [...keyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k);

  const signature: AudioTasteSignature = {
    avgBpm: bpmWeight > 0 ? Math.round(bpmSum / bpmWeight) : null,
    avgEnergy: energyWeight > 0 ? Number((energySum / energyWeight).toFixed(2)) : null,
    topKeys,
    avoidedArtists: avoidedKeys,
    preferredScripts,
  };

  const fingerprint = [
    topTracks.slice(0, 5).map((t) => t.videoId).join(','),
    profile.likedIds.slice(-6).join(','),
    profile.recentTrackIds.slice(0, 4).join(','),
  ].join('|');

  return {
    fingerprint,
    topTracks,
    likedArtists,
    skippedArtists,
    signature,
    featureMap,
  };
}

async function fetchBackendAISeeds(params: {
  mode: RankingMode;
  mood?: MoodDefinition | null;
  summary: ReturnType<typeof summarizeTasteForAI>;
}): Promise<BackendAIResponse | null> {
  const base = config.partyServerUrl.trim().replace(/\/+$/, '');
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/ai/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        mode: params.mode,
        mood: params.mood?.title ?? '',
        topTracks: params.summary.topTracks.map((t) => ({ title: t.title, artist: t.artist })),
        likedArtists: params.summary.likedArtists,
        skippedArtists: params.summary.skippedArtists,
        preferredScripts: params.summary.signature.preferredScripts,
        audio:
          params.summary.signature.avgBpm !== null
            ? {
                avgBpm: params.summary.signature.avgBpm,
                avgEnergy: params.summary.signature.avgEnergy ?? 0.5,
                topKeys: params.summary.signature.topKeys ?? [],
              }
            : undefined,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<BackendAIResponse>;
    if (!data?.enabled) return null;
    return {
      enabled: true,
      provider: data.provider,
      queries: Array.isArray(data.queries) ? data.queries : [],
      artists: Array.isArray(data.artists) ? data.artists : [],
      avoidKeywords: Array.isArray(data.avoidKeywords) ? data.avoidKeywords : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Finds adjacent artists & fresh tracks silently in the background via YouTube Music graph. */
async function expandLocalTasteGraph(
  summary: ReturnType<typeof summarizeTasteForAI>,
  backendSeeds: BackendAIResponse | null,
  excludeArtists: Set<string>,
): Promise<Track[]> {
  const out: Track[] = [];
  const seenIds = new Set<string>();
  const push = (t: Track) => {
    if (!t.videoId || !t.title || t.unavailable || seenIds.has(t.videoId)) return;
    if (isFanReuploadTrack(t.title, artistLine(t))) return;
    const credits = [...artistSet(artistLine(t))];
    if (credits.length > 0 && credits.every((a) => excludeArtists.has(a))) return;
    seenIds.add(t.videoId);
    out.push(t);
  };

  // 1. Resolve any backend LLM-curated discovery queries first.
  const aiQueries = (backendSeeds?.queries ?? []).slice(0, 5);
  if (aiQueries.length > 0) {
    const queryResults = await Promise.all(
      aiQueries.map(async (q) => {
        try {
          return await searchSongs(q);
        } catch {
          return [];
        }
      }),
    );
    for (const songs of queryResults) {
      for (const track of songs.slice(0, 4)) push(track);
    }
  }

  // 2. Adjacent-artist expansion from top favorite artists' YouTube radio & related artist shelves.
  const seedTrackIds = summary.topTracks.slice(0, 3).map((t) => t.videoId);
  const radioTracks = await Promise.all(
    seedTrackIds.map(async (id) => {
      try {
        const res = await fetchRadio(id);
        return res.candidates.filter((c) => !c.isVideo).map((c) => c.track);
      } catch {
        return [];
      }
    }),
  );

  const channelIds = new Set<string>();
  for (const list of radioTracks) {
    for (const track of list) {
      push(track);
      for (const a of track.artists) {
        if (a.id && !excludeArtists.has(a.name.toLowerCase())) {
          channelIds.add(a.id);
        }
      }
    }
  }

  // Pull top unheard songs from up to 2 related artists discovered in radio.
  const artistPages = await Promise.all(
    [...channelIds].slice(0, 2).map(async (chId) => {
      try {
        return await fetchArtist(chId);
      } catch {
        return null;
      }
    }),
  );
  for (const page of artistPages) {
    if (!page) continue;
    for (const song of page.topSongs.slice(0, 8)) push(song);
    for (const shelf of page.shelves) {
      const lower = shelf.title.toLowerCase();
      if (!lower.includes('similar') && !lower.includes('fans') && !lower.includes('single') && !lower.includes('release')) {
        continue;
      }
      for (const item of shelf.items.slice(0, 4)) {
        if (item.kind === 'song') {
          push({
            videoId: item.id,
            title: item.title,
            artists: item.artists,
            album: item.album,
            durationSec: item.durationSec,
            explicit: item.explicit,
            thumbnail: item.thumbnail,
            index: null,
            plays: null,
          });
        }
      }
    }
  }

  // 3. Fallback curated taste query for backend AI artists if needed.
  if (out.length < 10 && backendSeeds?.artists.length) {
    const artistSearches = await Promise.all(
      backendSeeds.artists.slice(0, 2).map(async (name) => {
        try {
          return await searchSongs(name);
        } catch {
          return [];
        }
      }),
    );
    for (const songs of artistSearches) {
      for (const s of songs.slice(0, 4)) push(s);
    }
  }

  return out;
}

/**
 * Quietly refreshes cached background discoveries when listener taste has evolved or expired.
 * Never throws, never blocks rendering, and exposes zero user-facing AI UI.
 */
export async function warmBackgroundTasteAI(
  profile: TasteProfileData,
  mode: RankingMode = 'discovery',
  mood?: MoodDefinition | null,
): Promise<Track[]> {
  const analyses = await getAllAnalyses();
  const summary = summarizeTasteForAI(profile, analyses);
  latestSignature = summary.signature;
  cachedFeatures = summary.featureMap;

  if (!summary.topTracks.length && !summary.likedArtists.length) {
    return getCachedTasteDiscoveries();
  }

  const cacheKey = `${mode}:${mood?.id ?? ''}:${summary.fingerprint}`;
  const existing = readStorageCache();
  if (
    existing &&
    existing.fingerprint === cacheKey &&
    Date.now() - existing.updatedAt < CACHE_TTL_MS &&
    existing.tracks.length > 0
  ) {
    return existing.tracks;
  }

  if (inFlightKey === cacheKey && inFlightPromise) {
    return inFlightPromise;
  }

  inFlightKey = cacheKey;
  inFlightPromise = (async () => {
    try {
      const backendSeeds = await fetchBackendAISeeds({ mode, mood, summary });
      const avoidSet = new Set(summary.signature.avoidedArtists ?? []);
      const discovered = await expandLocalTasteGraph(summary, backendSeeds, avoidSet);
      if (!discovered.length) return getCachedTasteDiscoveries();

      const candidates: ScoredCandidate[] = discovered.map((track) => ({ track }));
      const aiIds = new Set(discovered.map((t) => t.videoId));
      const ranked = rankTracks(candidates, profile, {
        mode: 'discovery',
        mood,
        limit: 36,
        audioSignature: summary.signature,
        audioFeatures: summary.featureMap,
        aiRecommendedIds: aiIds,
      });

      if (ranked.length > 0) {
        writeStorageCache({
          fingerprint: cacheKey,
          updatedAt: Date.now(),
          tracks: ranked,
          recommendedIds: ranked.map((t) => t.videoId),
          avoidKeywords: backendSeeds?.avoidKeywords ?? [],
        });
      }
      return ranked;
    } catch {
      return getCachedTasteDiscoveries();
    } finally {
      if (inFlightKey === cacheKey) {
        inFlightKey = null;
        inFlightPromise = null;
      }
    }
  })();

  return inFlightPromise;
}

/**
 * Returns live & cached personalized taste candidates for station playback
 * (Discover Mix, New Release Mix, My Supermix, AutoPlay).
 */
export async function discoverForTaste(
  profile: TasteProfileData,
  mode: RankingMode,
  mood?: MoodDefinition | null,
): Promise<{
  tracks: Track[];
  signature: AudioTasteSignature | null;
  features: ReadonlyMap<string, AudioFeatureHint>;
  recommendedIds: ReadonlySet<string>;
}> {
  const cached = getCachedTasteDiscoveries();
  const warmed = cached.length >= 6 ? cached : await warmBackgroundTasteAI(profile, mode, mood);
  if (cached.length >= 6) {
    void warmBackgroundTasteAI(profile, mode, mood);
  }
  return {
    tracks: warmed.length ? warmed : cached,
    signature: latestSignature,
    features: cachedFeatures,
    recommendedIds: getCachedRecommendedIdSet(),
  };
}

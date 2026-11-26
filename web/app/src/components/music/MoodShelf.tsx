import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { PrefetchLink } from '@/components/PrefetchLink';
import { shelfHeader, shelfList, shelfSection } from '@/components/shelf';
import { PlayIcon } from '@/components/icons/Transport';
import type { MusicItem, Track } from '@/data/music/types';
import { fetchBrowse, fetchPlaylist, fetchRadio, fetchSearch } from '@/data/music/api';
import {
  CORE_MOODS,
  MOOD_CATEGORIES_BROWSE_ID,
  rankTracks,
  selectMoodPlaylists,
  type MoodDefinition,
  type ScoredCandidate,
} from '@/data/music/recommendations';
import { getTasteProfile, recordMoodPick } from '@/data/music/tasteProfile';
import { usePlayer } from '@/state/player';

const moodQueueCache = new Map<string, { tracks: Track[]; fetchedAt: number }>();
const MOOD_CACHE_MS = 10 * 60_000;

/**
 * Generates and starts a personalized, anti-repetitive queue for [mood].
 * Blends mood playlists with listener favorites while excluding contradictory or skipped tracks.
 */
export async function playMoodStation(mood: MoodDefinition): Promise<void> {
  const profile = getTasteProfile();
  const seed = Date.now();
  const recentOpeners = profile.moodOpeners[mood.id] ?? [];

  let candidates: ScoredCandidate[] = [];
  const cached = moodQueueCache.get(mood.id);
  if (cached && seed - cached.fetchedAt < MOOD_CACHE_MS && cached.tracks.length >= 16) {
    candidates = cached.tracks.map((track) => ({ track }));
  } else {
    try {
      const page = await fetchBrowse({ browseId: MOOD_CATEGORIES_BROWSE_ID, params: mood.params });
      const selected = selectMoodPlaylists(page, mood, profile, 4, seed);
      const loaded = await Promise.all(
        selected.map(async ({ item, shelfTitle }) => {
          try {
            const { page: playlist } = await fetchPlaylist(item.id);
            return playlist.tracks.map((track) => ({
              track,
              sourcePlaylistTitle: item.title,
              sourcePlaylistSubtitle: `${shelfTitle} ${item.subtitle}`,
            }));
          } catch {
            return [];
          }
        }),
      );
      candidates = loaded.flat();
    } catch {
      candidates = [];
    }

    // Fallback search when YTM category shelves return too few tracks
    if (candidates.length < 15) {
      for (const query of mood.fallbackQueries) {
        try {
          const searchRes = await fetchSearch(query);
          const playlistHit = searchRes.playlists.find((p: MusicItem) => p.kind === 'playlist');
          if (playlistHit) {
            const { page: playlist } = await fetchPlaylist(playlistHit.id);
            candidates.push(
              ...playlist.tracks.map((track) => ({
                track,
                sourcePlaylistTitle: playlistHit.title,
                sourcePlaylistSubtitle: playlistHit.subtitle,
              })),
            );
          }
          for (const song of searchRes.songs.slice(0, 10)) {
            candidates.push({
              track: {
                videoId: song.id,
                title: song.title,
                artists: song.artists,
                album: song.album,
                durationSec: song.durationSec,
                explicit: song.explicit,
                thumbnail: song.thumbnail,
                index: null,
                plays: null,
              },
              sourcePlaylistTitle: mood.title,
            });
          }
          if (candidates.length >= 25) break;
        } catch {
          // Continue to next query
        }
      }
    }

    if (candidates.length) {
      moodQueueCache.set(mood.id, { tracks: candidates.map((c) => c.track), fetchedAt: seed });
    }
  }

  // Blend in one watch radio seed from the user's proven favorites so familiar + discoveries mix naturally
  const favTrack = Object.values(profile.tracks)
    .filter((t) => (t.plays > 0 || t.liked) && t.earlySkips === 0)
    .sort((a, b) => (b.liked ? 5 : 0) + b.plays - ((a.liked ? 5 : 0) + a.plays))[0];
  if (favTrack) {
    try {
      const { candidates: radioCandidates } = await fetchRadio(favTrack.videoId);
      for (const c of radioCandidates.slice(0, 12)) {
        if (!c.isVideo) {
          candidates.push({
            track: c.track,
            isFamiliarSeed: true,
          });
        }
      }
    } catch {
      // Optional personal enrichment
    }
  }

  const ranked = rankTracks(candidates, profile, {
    mode: 'mood',
    mood,
    recentOpeners,
    nowMs: seed,
    limit: 50,
    seed,
  });

  if (!ranked.length) return;
  recordMoodPick(
    mood.id,
    ranked.slice(0, 5).map((t) => t.videoId),
  );
  usePlayer.getState().playTracks(ranked, 0, {
    title: `${mood.title} Mix`,
    type: 'home',
    id: `mood:${mood.id}`,
  });
}

import { MoodVectorArt } from './MoodArtwork';

export function MoodCard({ mood }: { mood: MoodDefinition }) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await playMoodStation(mood);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="group/card relative rounded-artwork-md">
        <MoodVectorArt moodId={mood.id} />
        <button
          type="button"
          onClick={() => void handleClick()}
          aria-busy={loading}
          aria-label={`Play ${mood.title} Mix`}
          className="absolute inset-0 z-1 rounded-[inherit]"
        />
        <div className="pointer-events-none absolute inset-0 z-2 rounded-[inherit] bg-lockup-hover opacity-0 transition-opacity duration-100 ease-in group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
          <span className="absolute bottom-2.5 left-2.5 grid size-[30px] place-items-center rounded-full bg-thin-material text-white [backdrop-filter:saturate(180%)_blur(60px)]">
            <PlayIcon size={16} />
          </span>
        </div>
      </div>
      <div className="mt-2 flex min-w-0 flex-col gap-px">
        <button
          type="button"
          onClick={() => void handleClick()}
          className="truncate text-left type-callout text-primary hover:underline"
        >
          {mood.title}
        </button>
        <span className="truncate type-callout text-secondary">{mood.tagline}</span>
      </div>
    </div>
  );
}

/**
 * Find Your Mood shelf for Home: 10 curated mood stations matching Niko's Liquid Glass visual language.
 */
export function MoodShelf() {
  return (
    <section className={shelfSection}>
      <h2 className={shelfHeader}>
        <PrefetchLink to="/moods" className="inline-flex items-center gap-0.5 hover:underline">
          <span>Find Your Mood</span>
          <ChevronRight size={17} strokeWidth={2.4} className="text-secondary" aria-hidden="true" />
        </PrefetchLink>
      </h2>
      <ul className={`${shelfList} [--rows:1] [--row-gap:24px] [--xs-width:144px] [--cols-s:4] [--cols-m:5] [--cols-l:6] [--cols-xl:6]`}>
        {CORE_MOODS.map((mood) => (
          <li key={mood.id}>
            <MoodCard mood={mood} />
          </li>
        ))}
      </ul>
    </section>
  );
}

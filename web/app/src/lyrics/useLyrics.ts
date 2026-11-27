import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { cleanSongSearchTerms, isThirdPartyUpload, pairedAudioTrack, resolveTrackModeVersion } from '@/data/music/api';
import type { Track } from '@/data/music/types';
import { usePlayer } from '@/state/player';
import { queryClient } from '@/lib/queryClient';
import { onGranted } from './http';
import { forgetLyrics, lookupLyrics, type LyricsResult, type SourceState } from './repository';
import { useLyricsSettings } from './settings';
import type { LyricsSourceId } from './sources';

const VIDEO_SPECIFIC_SOURCES = new Set<LyricsSourceId>(['youtube-captions', 'youtube-music']);

/** Per track: the provider the user picked in the panel, and how each provider's search went. */
interface LyricsUi {
  picked: Record<string, LyricsSourceId>;
  states: Record<string, Partial<Record<LyricsSourceId, SourceState>>>;
  pick: (videoId: string, source: LyricsSourceId | null) => void;
}

export const useLyricsUi = create<LyricsUi>()((set) => ({
  picked: {},
  states: {},
  pick: (videoId, source) =>
    set((s) => {
      const picked = { ...s.picked };
      if (source) picked[videoId] = source;
      else delete picked[videoId];
      return { picked };
    }),
}));

// A host the extension was refused for has been allowed: ask again.
onGranted(() => {
  forgetLyrics();
  void queryClient.invalidateQueries({ queryKey: ['lyrics'] });
});

function reportState(videoId: string, source: LyricsSourceId, state: SourceState) {
  useLyricsUi.setState((s) => ({ states: { ...s.states, [videoId]: { ...s.states[videoId], [source]: state } } }));
}

/** The playing track's lyrics, from the provider chain or the provider picked for it. */
export function useLyrics() {
  const videoId = usePlayer((s) => s.nowPlaying?.videoId ?? null);
  const title = usePlayer((s) => s.nowPlaying?.title ?? '');
  const artist = usePlayer((s) => s.nowPlaying?.artist ?? '');
  const knownDurationSec = usePlayer((s) => {
    const entry = s.queue[s.index]?.track;
    const raw = (entry?.videoId === s.nowPlaying?.videoId ? entry?.durationSec : null) || s.nowPlaying?.durationSec || 0;
    return raw > 0 ? Math.round(raw) : 0;
  });
  const only = useLyricsUi((s) => (videoId ? s.picked[videoId] : undefined));
  const order = useLyricsSettings((s) => s.order.filter((id) => !s.disabled.includes(id)).join(','));
  const preferSyllables = useLyricsSettings((s) => s.preferSyllables);
  const paired = videoId && !(only && VIDEO_SPECIFIC_SOURCES.has(only)) ? pairedAudioTrack(videoId) : null;
  const rawVideoId = paired?.videoId ?? videoId;
  const rawTitle = paired?.title || title;
  const rawArtist = (paired?.artists.map((a) => a.name).join(', ') || artist).trim();
  const cleanedTerms = cleanSongSearchTerms(rawTitle, rawArtist);
  const queryVideoId = rawVideoId;
  const queryTitle = cleanedTerms.title || rawTitle;
  const queryArtist = cleanedTerms.artist;

  return useQuery<LyricsResult | null>({
    queryKey: ['lyrics', queryVideoId, queryTitle, queryArtist, knownDurationSec, only ?? null, order, preferSyllables],
    enabled: !!queryVideoId && !!queryTitle,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const player = usePlayer.getState();
      const entry = player.queue[player.index];
      let resolvedTrack: Track | null = paired ?? null;
      const baseTrack =
        entry?.track ??
        (queryVideoId
          ? {
              videoId: queryVideoId,
              title: rawTitle,
              artists: rawArtist ? [{ name: rawArtist, id: null }] : [],
              album: null,
              durationSec: player.nowPlaying?.durationSec ?? (knownDurationSec || null),
              explicit: false,
              thumbnail: null,
              index: null,
              plays: null,
            }
          : null);
      if (!resolvedTrack && baseTrack && (!queryArtist || isThirdPartyUpload(baseTrack))) {
        resolvedTrack = await Promise.race([
          resolveTrackModeVersion(baseTrack, 'audio').catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
      }
      if (signal.aborted) return null;
      const effectiveTitle = resolvedTrack?.title ? cleanSongSearchTerms(resolvedTrack.title, '').title : queryTitle;
      const resolvedArtist = resolvedTrack?.artists.map((a) => a.name).join(', ').trim() ?? '';
      const effectiveArtist = resolvedArtist ? cleanSongSearchTerms(effectiveTitle, resolvedArtist).artist : queryArtist;
      const durationSec = resolvedTrack?.durationSec || entry?.track.durationSec || player.nowPlaying?.durationSec || knownDurationSec || 0;
      const album = resolvedTrack?.album?.name ?? entry?.track.album?.name ?? null;
      return lookupLyrics(
        {
          videoId: resolvedTrack?.videoId ?? queryVideoId!,
          title: effectiveTitle || queryTitle,
          artist: effectiveArtist,
          durationMs: Math.round(durationSec * 1000),
          album,
        },
        {
          ...(only && { only }),
          onSource: (source, state) => {
            if (!signal.aborted) reportState(videoId!, source, state);
          },
        },
      );
    },
  });
}

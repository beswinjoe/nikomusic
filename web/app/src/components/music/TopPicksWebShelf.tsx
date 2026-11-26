import { useEffect, useState, useSyncExternalStore } from 'react';
import { shelfHeader, shelfList, shelfSection } from '@/components/shelf';
import { PlayIcon } from '@/components/icons/Transport';
import { discoverForTaste, warmBackgroundTasteAI } from '@/data/music/aiRecommender';
import { fetchLibrary, fetchPlaylist, fetchRadio, fetchSearch } from '@/data/music/api';
import {
  featuredMoodForHour,
  rankTracks,
  type MoodDefinition,
  type RankingMode,
  type ScoredCandidate,
} from '@/data/music/recommendations';
import { getTasteProfile, subscribeTasteProfile, syncLikedIds } from '@/data/music/tasteProfile';
import type { MusicItem, Shelf } from '@/data/music/types';
import { artworkFallbackUrl, heroArtwork, sizedArtwork } from '@/lib/artwork';
import { usePlayer } from '@/state/player';
import { MoodGlyphSvg, MOOD_VISUALS } from './MoodArtwork';
import { playMoodStation } from './MoodShelf';

const RESIZABLE_ARTWORK = /googleusercontent\.com|ggpht\.com/;

/** Returns an ultra-sharp retina/8K-capable cover URL matching Home/Library artwork quality. */
function posterCoverUrl(url: string, displayWidth: number): string {
  return displayWidth >= 1000 ? heroArtwork(url, 4096) : sizedArtwork(url, displayWidth, 1);
}

type StationKind = 'supermix' | 'discover' | 'new-release' | 'mood-for-you';

interface StationCardModel {
  kind: StationKind;
  title: string;
  subtitle: string;
  accentFrom: string;
  accentTo: string;
  mood?: MoodDefinition;
  covers?: readonly string[];
  playlistId?: string | null;
}

const stationCoversCache = new Map<string, string[]>();

function collectShelfCovers(
  shelves: readonly Shelf[],
  preferWords: readonly string[],
  offset = 0,
  count = 4,
): string[] {
  const seen = new Set<string>();
  const preferredSquare: string[] = [];
  const preferredOther: string[] = [];
  const generalSquare: string[] = [];
  const generalOther: string[] = [];

  for (const shelf of shelves) {
    const titleLower = shelf.title.toLowerCase();
    const isPreferred = preferWords.some((w) => titleLower.includes(w));
    for (const item of shelf.items) {
      // Skip YouTube Music RDTMAK mix banners because they bake big watermark text & top-left badges into the image
      if (!item.thumbnail || item.id.startsWith('RDTMAK') || item.id.startsWith('VLRDTMAK')) continue;
      if (item.kind !== 'song' && item.kind !== 'album' && item.kind !== 'video' && item.kind !== 'playlist') {
        continue;
      }
      if (seen.has(item.thumbnail)) continue;
      seen.add(item.thumbnail);
      const isCleanSquare =
        RESIZABLE_ARTWORK.test(item.thumbnail) && (item.kind === 'song' || item.kind === 'album' || item.kind === 'playlist');
      if (isPreferred) {
        if (isCleanSquare) preferredSquare.push(item.thumbnail);
        else preferredOther.push(item.thumbnail);
      } else {
        if (isCleanSquare) generalSquare.push(item.thumbnail);
        else generalOther.push(item.thumbnail);
      }
    }
  }

  const ordered = [
    ...preferredSquare,
    ...generalSquare,
    ...preferredOther,
    ...generalOther,
  ];
  if (ordered.length <= count) return ordered;
  const start = offset % Math.max(1, ordered.length - count + 1);
  return ordered.slice(start, start + count);
}

function mixCardFromShelves(shelves: readonly Shelf[], matchWords: string[]): MusicItem | null {
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      const t = item.title.toLowerCase();
      if (matchWords.some((w) => t.includes(w)) && (item.kind === 'playlist' || item.id.startsWith('RDTMAK'))) {
        return item;
      }
    }
  }
  return null;
}

async function startPersonalizedStation(card: StationCardModel, homeShelves: readonly Shelf[]): Promise<void> {
  const profile = getTasteProfile();
  const seed = Date.now();
  const candidates: ScoredCandidate[] = [];

  if (card.playlistId) {
    try {
      const { page: playlist } = await fetchPlaylist(card.playlistId);
      for (const track of playlist.tracks) {
        candidates.push({
          track,
          sourcePlaylistTitle: playlist.title,
          sourcePlaylistSubtitle: playlist.subtitle,
          isNewRelease: card.kind === 'new-release',
        });
      }
    } catch {
      // Fallback below
    }
  }

  // Enrich with watch radio seeds from diverse liked & high-completion tracks across different artists
  const scoredSeeds = Object.values(profile.tracks)
    .filter((t) => (t.plays > 0 || t.liked) && t.earlySkips <= 1)
    .sort((a, b) => {
      const rateA = a.plays > 0 ? a.completions / a.plays : 0;
      const rateB = b.plays > 0 ? b.completions / b.plays : 0;
      const weightA = (a.liked ? 10 : 0) + a.plays * 1.4 + rateA * 6 - a.earlySkips * 5;
      const weightB = (b.liked ? 10 : 0) + b.plays * 1.4 + rateB * 6 - b.earlySkips * 5;
      return weightB - weightA;
    });

  const diverseSeedIds: string[] = [];
  const seenArtists = new Set<string>();
  for (const t of scoredSeeds) {
    const artistKey = t.artist.toLowerCase().split(',')[0]?.trim() ?? '';
    if (artistKey && seenArtists.has(artistKey) && diverseSeedIds.length >= 2) continue;
    if (artistKey) seenArtists.add(artistKey);
    diverseSeedIds.push(t.videoId);
    if (diverseSeedIds.length >= 4) break;
  }
  for (const likedId of profile.likedIds) {
    if (!diverseSeedIds.includes(likedId)) {
      diverseSeedIds.push(likedId);
      if (diverseSeedIds.length >= 4) break;
    }
  }

  const trackIds = [...diverseSeedIds];
  if (!trackIds.length) {
    for (const shelf of homeShelves) {
      const lower = shelf.title.toLowerCase();
      if (card.kind === 'new-release' && !lower.includes('new') && !lower.includes('quick')) continue;
      for (const item of shelf.items) {
        if (item.kind === 'song') trackIds.push(item.id);
        if (trackIds.length >= 4) break;
      }
      if (trackIds.length >= 4) break;
    }
  }

  const chosenSeeds = trackIds.slice(0, 3);
  const radios = await Promise.all(
    chosenSeeds.map(async (id) => {
      try {
        const res = await fetchRadio(id);
        return res.candidates.filter((c) => !c.isVideo).map((c) => c.track);
      } catch {
        return [];
      }
    }),
  );
  for (const track of radios.flat()) {
    candidates.push({
      track,
      isNewRelease: card.kind === 'new-release',
    });
  }

  // Cold-start / sparse fallback: incorporate non-history home songs or explore search
  if (candidates.length < 10) {
    for (const shelf of homeShelves) {
      const t = shelf.title.toLowerCase();
      if (t.includes('recent') || t.includes('history')) continue;
      for (const item of shelf.items) {
        if (item.kind !== 'song') continue;
        candidates.push({
          track: {
            videoId: item.id,
            title: item.title,
            artists: item.artists,
            album: item.album,
            durationSec: item.durationSec,
            explicit: item.explicit,
            thumbnail: item.thumbnail,
            index: null,
            plays: null,
          },
          isNewRelease: t.includes('new'),
        });
      }
    }
  }

  if (candidates.length < 8 && card.kind === 'new-release') {
    try {
      const search = await fetchSearch('new music releases hits playlist');
      const hit = search.playlists[0];
      if (hit) {
        const { page: pl } = await fetchPlaylist(hit.id);
        for (const track of pl.tracks) candidates.push({ track, isNewRelease: true });
      }
    } catch {
      // Best effort
    }
  }

  const mode: RankingMode =
    card.kind === 'discover' ? 'discovery' : card.kind === 'new-release' ? 'new-release' : 'supermix';

  // Incorporate silently curated background discoveries aligned to the listener's taste.
  const aiDiscovery = await discoverForTaste(profile, mode, card.mood).catch(() => null);
  if (aiDiscovery?.tracks.length) {
    for (const track of aiDiscovery.tracks) {
      candidates.push({
        track,
        isNewRelease: card.kind === 'new-release',
      });
    }
  }

  const ranked = rankTracks(candidates, profile, {
    mode,
    nowMs: seed,
    limit: 50,
    seed,
    audioSignature: aiDiscovery?.signature ?? null,
    audioFeatures: aiDiscovery?.features,
    aiRecommendedIds: aiDiscovery?.recommendedIds,
  });

  if (!ranked.length) return;
  usePlayer.getState().playTracks(ranked, 0, {
    title: card.title,
    type: 'home',
    id: `top-pick:${card.kind}`,
  });
}

function CardBackgroundArt({ card }: { card: StationCardModel }) {
  // Icons are strictly for Mood cards only (e.g. Happy Mix, Love, Sad)
  if (card.kind === 'mood-for-you' && card.mood) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-3 bottom-12 flex items-center justify-center"
        style={{ color: MOOD_VISUALS[card.mood.id].stroke }}
      >
        <MoodGlyphSvg
          moodId={card.mood.id}
          strokeWidth={3.1}
          className="h-[68%] w-[68%] opacity-45 transition-transform duration-300 group-hover/pick:scale-105"
        />
      </div>
    );
  }

  // Mix playlists (My Supermix, Discover Mix, New Release Mix) always use high-res clean cover art without muddy colour tinting
  const covers = card.covers ?? [];
  if (covers.length >= 4 && card.kind !== 'new-release') {
    return (
      <>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 grid grid-cols-2 grid-rows-2 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/pick:scale-[1.03]"
        >
          {covers.slice(0, 4).map((src, idx) => (
            <img
              key={`${card.kind}-${idx}-${src}`}
              src={posterCoverUrl(src, 420)}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover opacity-0 transition-opacity duration-300 ease-out data-loaded:opacity-100"
              onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
              onError={(e) => {
                const step = artworkFallbackUrl(e.currentTarget.src);
                if (step && step !== e.currentTarget.src) e.currentTarget.src = step;
              }}
            />
          ))}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[56%] bg-gradient-to-t from-black/82 via-black/32 to-transparent"
        />
      </>
    );
  }

  const heroCover = covers[0];
  if (heroCover) {
    return (
      <>
        <img
          src={posterCoverUrl(heroCover, 1200)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-0 transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] data-loaded:opacity-100 group-hover/pick:scale-[1.03]"
          onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
          onError={(e) => {
            const step = artworkFallbackUrl(e.currentTarget.src);
            if (step && step !== e.currentTarget.src) e.currentTarget.src = step;
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[56%] bg-gradient-to-t from-black/82 via-black/32 to-transparent"
        />
      </>
    );
  }

  return null;
}

function StationCard({
  card,
  onClick,
}: {
  card: StationCardModel;
  onClick: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);

  return (
    <button
      type="button"
      aria-busy={loading}
      onClick={() => {
        if (loading) return;
        setLoading(true);
        void onClick().finally(() => setLoading(false));
      }}
      className="group/pick artwork-stroke relative block aspect-square w-full overflow-hidden rounded-artwork-lg text-left transition-transform duration-150 ease-out active:scale-[0.98]"
      style={{
        background: `linear-gradient(145deg, ${card.accentFrom} 0%, ${card.accentTo} 100%)`,
      }}
    >
      <CardBackgroundArt card={card} />
      {card.kind === 'mood-for-you' && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-br from-white/15 via-transparent to-black/35"
        />
      )}
      {/* Pinned absolute inset-0 so long subtitles never stretch one card taller than others */}
      <div className="absolute inset-0 z-1 flex flex-col justify-between p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-white/90 uppercase [backdrop-filter:blur(12px)]">
            For You
          </span>
          <span className="grid size-7 place-items-center rounded-full bg-black/30 text-white opacity-0 transition-opacity duration-150 [backdrop-filter:saturate(180%)_blur(24px)] group-hover/pick:opacity-100 group-focus-visible/pick:opacity-100">
            <PlayIcon size={14} />
          </span>
        </div>
        <div className="mt-auto flex min-w-0 flex-col gap-0.5 text-white">
          <span className="truncate type-title-3-emphasized tracking-[-0.01em] drop-shadow-xs">{card.title}</span>
          <span className="line-clamp-2 text-[11px] leading-[14px] text-white/80">{card.subtitle}</span>
        </div>
      </div>
    </button>
  );
}

/**
 * Browser "Top Picks for You" personalized station shelf.
 * Differentiates Mood for You, My Supermix, Discover Mix, and New Release Mix with uniform square cards.
 */
export function TopPicksWebShelf({
  homeShelves,
  signedIn,
}: {
  homeShelves: readonly Shelf[];
  signedIn: boolean;
}) {
  const profile = useSyncExternalStore(subscribeTasteProfile, getTasteProfile, getTasteProfile);
  const [madeForYou, setMadeForYou] = useState<MusicItem[]>([]);
  const [mixCovers, setMixCovers] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!signedIn) {
      setMadeForYou([]);
      return;
    }
    let cancelled = false;
    void fetchLibrary('made-for-you')
      .then((page) => {
        if (!cancelled) setMadeForYou(page.data.grid);
      })
      .catch(() => {});
    void fetchLibrary('songs')
      .then((page) => {
        if (!cancelled) syncLikedIds(page.data.tracks.map((t) => t.videoId));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const featuredMood = featuredMoodForHour(new Date().getHours(), profile);
  useEffect(() => {
    if (!Object.keys(profile.tracks).length && !profile.likedIds.length) return;
    void warmBackgroundTasteAI(profile, 'discovery', featuredMood);
  }, [profile.likedIds.length, Object.keys(profile.tracks).length]);

  const allMixCandidates: Shelf[] = madeForYou.length
    ? [{ title: 'Made for you', strapline: null, layout: 'square', items: madeForYou, seeAll: null }, ...homeShelves]
    : [...homeShelves];

  const supermixItem = mixCardFromShelves(allMixCandidates, ['supermix']);
  const discoverItem = mixCardFromShelves(allMixCandidates, ['discover mix', 'discover', 'discovery']);
  const newReleaseItem = mixCardFromShelves(allMixCandidates, ['new release', 'new releases']);

  // Fetch clean real track covers inside each mix playlist so YTM watermark covers are never needed
  useEffect(() => {
    let cancelled = false;
    const entries: [StationKind, string | undefined][] = [
      ['supermix', supermixItem?.id],
      ['discover', discoverItem?.id],
      ['new-release', newReleaseItem?.id],
    ];
    for (const [kind, id] of entries) {
      if (!id) continue;
      const cached = stationCoversCache.get(id);
      if (cached) {
        setMixCovers((prev) => (prev[kind] ? prev : { ...prev, [kind]: cached }));
        continue;
      }
      void fetchPlaylist(id)
        .then(({ page }) => {
          const thumbs: string[] = [];
          const seen = new Set<string>();
          // Prefer clean square Googleusercontent/ggpht album covers first so collage tiles stay HD
          const sorted = [...page.tracks].sort((a, b) => {
            const aSq = a.thumbnail && RESIZABLE_ARTWORK.test(a.thumbnail) ? 1 : 0;
            const bSq = b.thumbnail && RESIZABLE_ARTWORK.test(b.thumbnail) ? 1 : 0;
            return bSq - aSq;
          });
          for (const t of sorted) {
            if (t.thumbnail && !seen.has(t.thumbnail)) {
              seen.add(t.thumbnail);
              thumbs.push(t.thumbnail);
              if (thumbs.length >= 4) break;
            }
          }
          if (thumbs.length) {
            stationCoversCache.set(id, thumbs);
            if (!cancelled) {
              setMixCovers((prev) => ({ ...prev, [kind]: thumbs }));
            }
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [supermixItem?.id, discoverItem?.id, newReleaseItem?.id]);

  const fallbackSupermixCovers = collectShelfCovers(homeShelves, ['quick', 'trending', 'hits', 'favourites'], 0, 4);
  const fallbackDiscoverCovers = collectShelfCovers(homeShelves, ['discover', 'recommend', 'similar', 'forgotten'], 4, 4);
  const fallbackNewReleaseCovers = collectShelfCovers(homeShelves, ['new release', 'new', 'fresh', 'latest'], 2, 1);

  const cards: { model: StationCardModel; run: () => Promise<void> }[] = [
    {
      model: {
        kind: 'mood-for-you',
        title: `${featuredMood.title} Mix`,
        subtitle: `Mood for You · ${featuredMood.tagline}`,
        accentFrom: featuredMood.accentFrom,
        accentTo: featuredMood.accentTo,
        mood: featuredMood,
      },
      run: () => playMoodStation(featuredMood),
    },
    {
      model: {
        kind: 'supermix',
        title: 'My Supermix',
        subtitle: 'Your favourites blended with fresh picks',
        accentFrom: '#1db954',
        accentTo: '#0c5227',
        covers: mixCovers['supermix']?.length ? mixCovers['supermix'] : fallbackSupermixCovers,
        playlistId: supermixItem?.id,
      },
      run: () =>
        startPersonalizedStation(
          {
            kind: 'supermix',
            title: 'My Supermix',
            subtitle: '',
            accentFrom: '',
            accentTo: '',
            playlistId: supermixItem?.id,
          },
          homeShelves,
        ),
    },
    {
      model: {
        kind: 'discover',
        title: 'Discover Mix',
        subtitle: 'Unheard tracks tuned to your taste',
        accentFrom: '#226ce0',
        accentTo: '#13316e',
        covers: mixCovers['discover']?.length ? mixCovers['discover'] : fallbackDiscoverCovers,
        playlistId: discoverItem?.id,
      },
      run: () =>
        startPersonalizedStation(
          {
            kind: 'discover',
            title: 'Discover Mix',
            subtitle: '',
            accentFrom: '',
            accentTo: '',
            playlistId: discoverItem?.id,
          },
          homeShelves,
        ),
    },
    {
      model: {
        kind: 'new-release',
        title: 'New Release Mix',
        subtitle: 'Latest drops matching artists you love',
        accentFrom: '#e0532c',
        accentTo: '#732110',
        covers: mixCovers['new-release']?.length ? mixCovers['new-release'] : fallbackNewReleaseCovers,
        playlistId: newReleaseItem?.id,
      },
      run: () =>
        startPersonalizedStation(
          {
            kind: 'new-release',
            title: 'New Release Mix',
            subtitle: '',
            accentFrom: '',
            accentTo: '',
            playlistId: newReleaseItem?.id,
          },
          homeShelves,
        ),
    },
  ];

  return (
    <section className={shelfSection}>
      <h2 className={shelfHeader}>Top Picks for You</h2>
      <ul className={`${shelfList} [--rows:1] [--row-gap:16px] [--xs-width:164px] [--cols-s:4] [--cols-m:4] [--cols-l:5] [--cols-xl:6]`}>
        {cards.map((entry) => (
          <li key={entry.model.kind}>
            <StationCard card={entry.model} onClick={entry.run} />
          </li>
        ))}
      </ul>
    </section>
  );
}

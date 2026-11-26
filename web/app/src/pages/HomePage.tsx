import { useEffect, useRef, useSyncExternalStore } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { MoodShelf } from '@/components/music/MoodShelf';
import { Shelves, TrackShelf } from '@/components/music/ShelfView';
import { TopPicksWebShelf } from '@/components/music/TopPicksWebShelf';
import { LoadError, LoadMoreError, NeedsExtension } from '@/components/music/States';
import { differentiateHomeShelves } from '@/data/music/recommendations';
import { useHome, useLibrary, useSignedIn, useYouTubeReady } from '@/data/music/queries';
import { getTasteProfile, subscribeTasteProfile } from '@/data/music/tasteProfile';
import type { Track } from '@/data/music/types';
import { HomeSkeleton } from '@/skeletons/PageSkeletons';
import { ShelfSkeleton } from '@/skeletons/ShelfSkeleton';
import {
  getCachedAudioProfile,
  getCachedRecommendedIdSet,
  getCachedTasteDiscoveries,
  subscribeAiDiscovery,
  warmBackgroundTasteAI,
} from '@/data/music/aiRecommender';
import { rankTracks } from '@/data/music/recommendations';

const RECENT_TITLE = 'Recently Played';
const RECENT_LIMIT = 20;
const RECENT_SOURCE = { title: RECENT_TITLE, type: 'home' as const };

/**
 * The account's listening history, newest first, one row per song
 * (YtMusicRepository.recentlyPlayed): the first 20, signed in only. The same
 * query as Library's Recently Played, so either page warms the other.
 */
function useRecentlyPlayed(): Track[] {
  const history = useLibrary('recent');
  const first = history.data?.pages[0]?.data.tracks ?? [];
  const seen = new Set<string>();
  return first.filter((t) => !seen.has(t.videoId) && seen.add(t.videoId)).slice(0, RECENT_LIMIT);
}

/** YouTube Music's home feed, as Apple's Home: Top Picks, Moods, and differentiated shelves. */
export default function HomePage() {
  const { missing } = useYouTubeReady();
  const signedIn = useSignedIn();
  const home = useHome();
  const recent = useRecentlyPlayed();
  const profile = useSyncExternalStore(subscribeTasteProfile, getTasteProfile, getTasteProfile);
  const backgroundDiscoveries = useSyncExternalStore(
    subscribeAiDiscovery,
    getCachedTasteDiscoveries,
    getCachedTasteDiscoveries,
  );
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recent.length && !Object.keys(profile.tracks).length && !profile.likedIds.length) return;
    void warmBackgroundTasteAI(profile, 'discovery');
  }, [recent.length, profile.likedIds.length, Object.keys(profile.tracks).length]);

  // Loads the next shelves before the bottom comes into view; after a failed
  // page it waits for Try Again rather than retrying on every scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !home.hasNextPage || home.isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !home.isFetchingNextPage) void home.fetchNextPage();
      },
      { root: document.getElementById('scrollable-page'), rootMargin: '600px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [home.hasNextPage, home.isFetchingNextPage, home.isFetchNextPageError, home.fetchNextPage]);

  if (missing) {
    return (
      <>
        <PageHeader title="Home" />
        <NeedsExtension />
      </>
    );
  }
  // Only a failed first page replaces the feed; a later one is shown under it.
  if (home.isError && !home.data) {
    return (
      <>
        <PageHeader title="Home" />
        <LoadError error={home.error} onRetry={() => void home.refetch()} />
      </>
    );
  }
  if (!home.data) return <HomeSkeleton />;

  // YouTube's feed can carry its own, older Recently Played; the history wins, as on the phone.
  const rawShelves = home.data.pages
    .flatMap((page) => page.data)
    .filter((shelf) => !(recent.length > 0 && shelf.title.trim().toLowerCase() === RECENT_TITLE.toLowerCase()));
  const mergedProfile = recent.length
    ? { ...profile, recentTrackIds: [...new Set([...recent.map((t) => t.videoId), ...profile.recentTrackIds])] }
    : profile;
  const shelves = differentiateHomeShelves(rawShelves, mergedProfile);
  const { signature: audioSignature, features: audioFeatures } = getCachedAudioProfile();
  const recentAndLiked = new Set([...recent.map((t) => t.videoId), ...mergedProfile.likedIds]);
  const tasteNewTracks = backgroundDiscoveries.length
    ? rankTracks(
        backgroundDiscoveries.filter((t) => !recentAndLiked.has(t.videoId)).map((t) => ({ track: t })),
        mergedProfile,
        {
          mode: 'discovery',
          limit: 16,
          audioSignature,
          audioFeatures,
          aiRecommendedIds: getCachedRecommendedIdSet(),
        },
      )
    : [];
  return (
    <>
      <PageHeader title="Home" />
      <TopPicksWebShelf homeShelves={shelves} signedIn={signedIn} />
      {recent.length > 0 && <TrackShelf title={RECENT_TITLE} to="/library/recent" tracks={recent} source={RECENT_SOURCE} />}
      <MoodShelf />
      {tasteNewTracks.length >= 4 && (
        <TrackShelf
          title="Picked for Your Taste"
          tracks={tasteNewTracks}
          source={{ title: 'Picked for Your Taste', type: 'home' }}
        />
      )}
      <Shelves shelves={shelves} />
      <div ref={sentinel} />
      {home.isFetchingNextPage && <ShelfSkeleton kind="square" />}
      {home.isFetchNextPageError && <LoadMoreError onRetry={() => void home.fetchNextPage()} />}
    </>
  );
}

import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowsePage, MusicItem, Shelf, Track } from './types';
import type { TrackAnalysis } from '../../playback/automix/analysis/types';
import { buildFeedbackSignals, detectScripts, summarizeTasteForAI } from './aiRecommender';
import {
  ALL_MOODS,
  CORE_MOODS,
  EXTENDED_MOODS,
  differentiateHomeShelves,
  enhanceAutoplayTracks,
  featuredMoodForHour,
  isContradictoryForMood,
  moodById,
  rankTracks,
  selectMoodPlaylists,
} from './recommendations';
import {
  getTasteProfile,
  recordMoodPick,
  recordTrackPlay,
  recordTrackSkip,
  resetTasteProfile,
  setTrackLiked,
} from './tasteProfile';

function track(videoId: string, title = `Track ${videoId}`, artist = `Artist ${videoId}`, album: string | null = null): Track {
  return {
    videoId,
    title,
    artists: artist.split(/,\s*/).map((name) => ({ name, id: null })),
    album: album ? { name: album, id: null } : null,
    durationSec: 210,
    explicit: false,
    thumbnail: null,
    index: null,
    plays: null,
  };
}

function shelfItem(id: string, kind: MusicItem['kind'], title = id, subtitle = ''): MusicItem {
  return {
    kind,
    id,
    title,
    subtitle,
    artists: [{ name: subtitle || 'Artist', id: null }],
    album: null,
    thumbnail: null,
    wide: false,
    durationSec: null,
    explicit: false,
  };
}

describe('Mood Discovery & Recommendation Engine (Web)', () => {
  beforeEach(() => {
    resetTasteProfile();
  });

  it('defines all 10 required mood categories with rules', () => {
    expect(CORE_MOODS.map((m) => m.id)).toEqual([
      'love',
      'sad',
      'energy',
      'chill',
      'focus',
      'party',
      'happy',
      'late-night',
      'road-trip',
      'nostalgia',
    ]);
    for (const mood of CORE_MOODS) {
      expect(mood.positiveKeywords.length).toBeGreaterThan(0);
      expect(mood.contradictoryKeywords.length).toBeGreaterThan(0);
      expect(mood.fallbackQueries.length).toBeGreaterThan(0);
    }
  });

  it('excludes contradictory tracks from mood queues', () => {
    const chill = moodById('chill');
    expect(
      isContradictoryForMood({ track: track('1', 'Beast Mode Gym Workout') }, chill),
    ).toBe(true);
    expect(
      isContradictoryForMood({ track: track('2', 'Sunday Morning Acoustic') }, chill),
    ).toBe(false);

    const sad = moodById('sad');
    const ranked = rankTracks(
      [
        { track: track('s1', 'Broken Heart Ballad', 'Singer A'), sourcePlaylistTitle: 'Heartbreak Hits' },
        { track: track('s2', 'Club Party Banger', 'DJ X'), sourcePlaylistTitle: 'Sad Songs' },
      ],
      getTasteProfile(),
      { mode: 'mood', mood: sad, seed: 1 },
    );
    expect(ranked.map((t) => t.videoId)).toEqual(['s1']);
  });

  it('ranks personalized listening history, likes, skips, and recency fatigue accurately', () => {
    const now = 1_700_000_000_000;
    // Play "fav" twice earlier (not just played), skip "annoying" early twice, play "recent" moments ago
    recordTrackPlay({ videoId: 'fav', title: 'Favorite', artist: 'Beloved', playedSec: 200, durationSec: 210, completed: true }, now - 5 * 86_400_000);
    setTrackLiked('fav', true, { title: 'Favorite', artist: 'Beloved' }, now - 5 * 86_400_000);

    recordTrackSkip({ videoId: 'annoying', title: 'Annoying', artist: 'Skip Artist', playedSec: 6, durationSec: 210 }, now - 60_000);
    recordTrackSkip({ videoId: 'annoying', title: 'Annoying', artist: 'Skip Artist', playedSec: 8, durationSec: 210 }, now - 30_000);

    recordTrackPlay({ videoId: 'recent', title: 'Overplayed Right Now', artist: 'Beloved', playedSec: 200, durationSec: 210, completed: true }, now - 300_000);

    const profile = getTasteProfile();
    const ranked = rankTracks(
      [
        { track: track('annoying', 'Annoying', 'Skip Artist') },
        { track: track('recent', 'Overplayed Right Now', 'Beloved') },
        { track: track('fav', 'Favorite', 'Beloved') },
        { track: track('newbie', 'Fresh Track By Beloved', 'Beloved') },
      ],
      profile,
      { mode: 'supermix', nowMs: now, seed: 10 },
    );

    expect(ranked.some((t) => t.videoId === 'annoying')).toBe(false);
    expect(ranked[0]!.videoId).toBe('fav');
    expect(ranked.findIndex((t) => t.videoId === 'newbie')).toBeLessThan(ranked.findIndex((t) => t.videoId === 'recent'));
  });

  it('handles cold-start new users with no history while capping artist repetition', () => {
    const candidates = Array.from({ length: 18 }, (_, i) => ({
      track: track(`t${i}`, `Track ${i}`, i < 10 ? 'Repeated Artist' : `Artist ${i}`),
    }));
    const queue = rankTracks(candidates, getTasteProfile(), {
      mode: 'mood',
      mood: moodById('happy'),
      limit: 12,
      seed: 42,
    });
    expect(queue.length).toBeGreaterThanOrEqual(8);
    const repeatCount = queue.filter((t) => t.artists[0]?.name === 'Repeated Artist').length;
    expect(repeatCount).toBeLessThanOrEqual(2);
  });

  it('excludes heard/liked tracks in discovery mode and boosts unfamiliar artists', () => {
    const now = 1_700_000_000_000;
    recordTrackPlay({ videoId: 'heard', title: 'Known Song', artist: 'Known Artist', playedSec: 180, durationSec: 200 }, now - 86_400_000);
    setTrackLiked('heard', true, { title: 'Known Song', artist: 'Known Artist' }, now);

    const discovery = rankTracks(
      [
        { track: track('heard', 'Known Song', 'Known Artist') },
        { track: track('unheard', 'Discovery Gem', 'Brand New Artist') },
      ],
      getTasteProfile(),
      { mode: 'discovery', nowMs: now, seed: 7 },
    );
    expect(discovery.map((t) => t.videoId)).toEqual(['unheard']);
  });

  it('de-duplicates audio and official video versions and differentiates home shelves', () => {
    const now = 1_700_000_000_000;
    recordTrackPlay({ videoId: 'vRecent', title: 'Morning Song', artist: 'Artist One', playedSec: 180, durationSec: 200 }, now);

    const deduped = rankTracks(
      [
        { track: track('a1', 'Kesariya', 'Arijit Singh') },
        { track: track('v1', 'Kesariya (Official Video)', 'Arijit Singh, Pritam') },
      ],
      getTasteProfile(),
      { mode: 'supermix', nowMs: now, seed: 3 },
    );
    expect(deduped).toHaveLength(1);

    const shelves: Shelf[] = [
      {
        title: 'Recently played',
        strapline: null,
        layout: 'tracks',
        items: [shelfItem('vRecent', 'song', 'Morning Song', 'Artist One')],
        seeAll: null,
      },
      {
        title: 'Quick Picks',
        strapline: null,
        layout: 'square',
        items: [
          shelfItem('PL_A', 'playlist', 'Pop Mix'),
          shelfItem('PL_B', 'playlist', 'Indie Mix'),
          shelfItem('PL_C', 'playlist', 'Rock Mix'),
        ],
        seeAll: null,
      },
      {
        title: 'Discover Mix',
        strapline: null,
        layout: 'square',
        items: [
          shelfItem('vRecent', 'song', 'Morning Song', 'Artist One'),
          shelfItem('PL_A', 'playlist', 'Pop Mix'),
          shelfItem('vNew1', 'song', 'Unheard 1', 'New A'),
          shelfItem('vNew2', 'song', 'Unheard 2', 'New B'),
          shelfItem('vNew3', 'song', 'Unheard 3', 'New C'),
        ],
        seeAll: null,
      },
    ];
    const diff = differentiateHomeShelves(shelves, getTasteProfile());
    const discover = diff.find((s) => s.title === 'Discover Mix')!;
    expect(discover.items.some((i: MusicItem) => i.id === 'vRecent' || i.id === 'PL_A')).toBe(false);
    expect(discover.items.length).toBe(3);
  });

  it('selects non-contradictory mood playlists & adapts featured mood by preference', () => {
    const page: BrowsePage = {
      title: 'Focus',
      shelves: [
        {
          title: 'Party Warmups',
          strapline: null,
          layout: 'square',
          items: [shelfItem('PL_PARTY', 'playlist', 'Club Bangers', 'Party hits')],
          seeAll: null,
        },
        {
          title: 'Deep Focus & Ambient',
          strapline: null,
          layout: 'square',
          items: [shelfItem('PL_FOCUS', 'playlist', 'Instrumental Study', 'Piano & ambient')],
          seeAll: null,
        },
      ],
      grid: [],
      tracks: [],
    };
    const picked = selectMoodPlaylists(page, moodById('focus'), getTasteProfile(), 2, 123);
    expect(picked.map((p) => p.item.id)).toEqual(['PL_FOCUS']);

    recordMoodPick('nostalgia', ['o1']);
    expect(featuredMoodForHour(18, getTasteProfile(), 42).id).toBeTypeOf('string');

    // AutoPlay enhancement removes skipped tracks cleanly
    recordTrackSkip({ videoId: 'bad', title: 'Bad Track', artist: 'X', playedSec: 4, durationSec: 200 });
    recordTrackSkip({ videoId: 'bad', title: 'Bad Track', artist: 'X', playedSec: 5, durationSec: 200 });
    const nextTracks = enhanceAutoplayTracks(
      [track('seed', 'Seed', 'Seed Artist')],
      [track('bad', 'Bad Track', 'X'), track('good', 'Good Track', 'Good Artist')],
      getTasteProfile(),
      5,
    );
    expect(nextTracks.map((t) => t.videoId)).toEqual(['good']);
  });

  it('provides all 10 core and 23 extended moods with distinct IDs and metadata', () => {
    expect(CORE_MOODS).toHaveLength(10);
    expect(EXTENDED_MOODS).toHaveLength(23);
    expect(ALL_MOODS).toHaveLength(33);
    expect(new Set(ALL_MOODS.map((m) => m.id)).size).toBe(33);

    for (const id of ['heartbreak', 'feeling-blue', 'after-hours', 'sleep', 'work'] as const) {
      const mood = moodById(id);
      expect(mood.id).toBe(id);
      expect(mood.fallbackQueries.length).toBeGreaterThan(0);
    }
  });

  it('builds background audio + script taste profiles and scores matching unheard music', () => {
    const now = 1_700_000_000_000;
    recordTrackPlay({ videoId: 't-fav', title: 'Midnight Drive', artist: 'SZA', playedSec: 190, durationSec: 200, completed: true }, now - 86_400_000);
    setTrackLiked('t-fav', true, { title: 'Midnight Drive', artist: 'SZA' }, now - 86_400_000);
    recordTrackSkip({ videoId: 't-skip1', title: 'Loud Track 1', artist: 'Skipped Band', playedSec: 4, durationSec: 200 }, now - 60_000);
    recordTrackSkip({ videoId: 't-skip2', title: 'Loud Track 2', artist: 'Skipped Band', playedSec: 6, durationSec: 200 }, now - 30_000);

    const profile = getTasteProfile();
    const analyses: TrackAnalysis[] = [
      {
        fileKey: 't-fav',
        path: 'youtube:t-fav',
        tags: { title: 'Midnight Drive', artist: 'SZA' },
        durationSec: 200,
        bpm: 96,
        beatIntervalSec: 60 / 96,
        firstDownbeatSec: 0.3,
        gridConfidence: 0.8,
        camelot: { num: 8, letter: 'A' },
        keyName: 'A minor',
        keyConfidence: 0.8,
        energy: 0.5,
        energyCurve: [],
        introEndSec: 5,
        outroStartSec: 190,
        analysisVersion: 9,
      },
    ];

    const summary = summarizeTasteForAI(profile, analyses);
    expect(summary.likedArtists).toContain('SZA');
    expect(summary.skippedArtists).toContain('Skipped Band');
    expect(summary.signature.avgBpm).toBe(96);
    expect(summary.signature.avgEnergy).toBe(0.5);
    expect(summary.signature.topKeys).toEqual(['8A']);
    expect(detectScripts(['Kesariya केसरिया', 'Sailor Song'])).toContain('latin');

    const audioFeatures = new Map([
      ['match', { bpm: 98, energy: 0.52, camelot: '8A' }],
      ['mismatch', { bpm: 170, energy: 0.95, camelot: '3B' }],
      ['skipped-artist', { bpm: 96, energy: 0.5, camelot: '8A' }],
    ]);

    const ranked = rankTracks(
      [
        { track: track('skipped-artist', 'Fresh Song', 'Skipped Band') },
        { track: track('mismatch', 'Hyper EDM Track', 'Random DJ') },
        { track: track('match', 'Velvet Rain', 'New Soul Artist') },
      ],
      profile,
      {
        mode: 'discovery',
        nowMs: now,
        seed: 9,
        audioSignature: summary.signature,
        audioFeatures,
        aiRecommendedIds: new Set(['match']),
      },
    );

    expect(ranked[0]!.videoId).toBe('match');
    expect(ranked.at(-1)!.videoId).toBe('skipped-artist');

    // Verify iterative feedback signal extraction for backend AI training loop
    setTrackLiked('match', true, { title: 'Velvet Rain', artist: 'New Soul Artist' }, now);
    recordTrackSkip({ videoId: 'mismatch', title: 'Hyper EDM Track', artist: 'Random DJ', playedSec: 4, durationSec: 200 }, now);
    const fb = buildFeedbackSignals(getTasteProfile(), [
      track('match', 'Velvet Rain', 'New Soul Artist'),
      track('mismatch', 'Hyper EDM Track', 'Random DJ'),
    ]);
    expect(fb.likedRecommendations.map((x) => x.title)).toEqual(['Velvet Rain']);
    expect(fb.skippedRecommendations.map((x) => x.title)).toEqual(['Hyper EDM Track']);
  });
});

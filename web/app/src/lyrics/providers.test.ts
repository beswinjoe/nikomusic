import { describe, expect, it } from 'vitest';
import { bestBiniHit, titlesMatch } from './providers';

describe('lyrics provider matching guards', () => {
  it('rejects wrong BiniLyrics hits (remixes/mashups/wrong duration) so wrong ISRCs never poison synced providers', () => {
    const hits = [
      {
        track_name: 'Californication / Love the Way You Lie / Mockingbird (Mixed)',
        artist_name: 'Red Hot Chili Peppers, Eminem',
        duration: 118,
        isrc: 'US23A8123748',
        lyricsUrl: 'https://lrc.red/s/US23A8123748.ttml',
      },
      {
        track_name: 'Mockingbird',
        artist_name: 'JULA',
        duration: 247,
        isrc: 'QT6ET2622623',
        lyricsUrl: 'https://lrc.red/s/QT6ET2622623.ttml',
      },
    ];
    expect(bestBiniHit(hits, 'Mockingbird', 'Eminem', 251_000)).toBeNull();

    const exact = bestBiniHit(
      [
        ...hits,
        {
          track_name: 'Mockingbird',
          artist_name: 'Eminem',
          duration: 250,
          isrc: 'USIR10400813',
          lyricsUrl: 'https://lrc.red/s/USIR10400813.ttml',
        },
      ],
      'Mockingbird',
      'Eminem',
      251_000,
    );
    expect(exact?.isrc).toBe('USIR10400813');
  });

  it('prevents short song titles like Low or One from substring-matching unrelated titles', () => {
    expect(titlesMatch('Slow', 'Low')).toBe(false);
    expect(titlesMatch('Follow', 'Low')).toBe(false);
    expect(titlesMatch('Someone', 'One')).toBe(false);
    expect(titlesMatch('Low', 'Low')).toBe(true);
    expect(titlesMatch('Sailor Song', 'Sailor Song')).toBe(true);
  });
});

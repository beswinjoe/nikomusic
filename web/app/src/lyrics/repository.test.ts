// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { line } from './model';
import { lookupLyrics } from './repository';
import { useLyricsSettings } from './settings';
import { cleanSongSearchTerms } from '@/data/music/api';
import { forLyricsSearch } from './sources';

vi.mock('./http', () => ({ lyricsGet: async () => null }));
vi.mock('./providers', () => ({
  lrclib: async () => ({ lines: [line(1000, 'line timed')], ttml: '<tt/>' }),
  // QQ's stand-in for an instrumental: "this song has no lyrics, please enjoy".
  betterLyricsPortato: async () => ({
    lines: [line(0, '此歌曲为没有填词的纯音乐，请您欣赏', { words: [{ startMs: 0, endMs: 5000, text: '此歌曲为没有填词的纯音乐，请您欣赏', syllables: [] }] })],
    ttml: '<tt/>',
  }),
  lyricsPlus: async () => ({
    lines: [line(1000, 'word', { words: [{ startMs: 1000, endMs: 1500, text: 'word', syllables: [] }] })],
    ttml: '<tt/>',
  }),
}));

describe('lookupLyrics', () => {
  it('asks again when "prefer syllable timing" changes', async () => {
    useLyricsSettings.setState({ order: ['lrclib', 'lyrics-plus'], disabled: [], preferSyllables: false });
    const track = { videoId: 'abcdefghijk', title: 'Song', artist: 'Artist', durationMs: 180_000, album: null };

    expect((await lookupLyrics(track))?.source).toBe('lrclib');
    useLyricsSettings.setState({ preferSyllables: true });
    expect((await lookupLyrics(track))?.source).toBe('lyrics-plus');
  });

  it("passes over a source that answers an instrumental with QQ's no-lyrics notice", async () => {
    useLyricsSettings.setState({ order: ['better-lyrics-portato', 'lrclib'], disabled: [], preferSyllables: false });
    const track = { videoId: 'instrumenta', title: 'Instrumental', artist: 'Artist', durationMs: 180_000, album: null };

    expect((await lookupLyrics(track))?.source).toBe('lrclib');
  });

  it('cleans music video packaging suffixes in forLyricsSearch without dropping versions', () => {
    expect(forLyricsSearch('Low - Official Music Video')).toBe('Low');
    expect(forLyricsSearch('Low | Official Video 4K')).toBe('Low');
    expect(forLyricsSearch('Low - Remix')).toBe('Low - Remix');
  });

  it('strips fake third-party lyric channels like 7clouds and recovers real artist/title hints', () => {
    expect(cleanSongSearchTerms('Sailor Song', '7clouds R&B')).toEqual({
      title: 'Sailor Song',
      artist: '',
    });
    expect(cleanSongSearchTerms('Gigi Perez - Sailor Song (Lyrics)', '7clouds R&B')).toEqual({
      title: 'Sailor Song',
      artist: 'Gigi Perez',
    });
    expect(cleanSongSearchTerms('Dracula', 'Tame Impala - Topic')).toEqual({
      title: 'Dracula',
      artist: 'Tame Impala',
    });
  });
});

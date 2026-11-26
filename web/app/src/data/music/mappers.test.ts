import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { YTMusic } from 'youtubei.js';
import { firstBrowseArtwork, mapAlbum, mapArtist, mapBrowse, mapCategories, mapHome, mapItem, mapPlaylist, mapSearch, mapShelves, mapSuggestions } from './mappers';
import type { BrowsePage } from './types';

// Real responses captured by web/scripts/capture-fixtures.mjs (prompt §0:
// parsers are tested against what YouTube actually sends). YouTube.js parses
// them exactly as it would a live response.

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/innertube/${name}.json`, import.meta.url)), 'utf8'));
const response = (name: string) => ({ success: true, status_code: 200, data: fixture(name) }) as never;
const actions = { session: { context: { client: {} } } } as never;

describe('home', () => {
  it('maps every carousel into a titled shelf with items', () => {
    const shelves = mapHome(new YTMusic.HomeFeed(response('browse-home'), actions));
    expect(shelves.length).toBeGreaterThan(1);
    for (const shelf of shelves) {
      expect(shelf.title).not.toBe('');
      expect(shelf.items.length).toBeGreaterThan(0);
      for (const item of shelf.items) {
        expect(item.id).not.toBe('');
        expect(item.title).not.toBe('');
        expect(item.thumbnail).toMatch(/^https:/);
      }
    }
    // This capture (signed out) holds playlist and album carousels only.
    expect(shelves.every((s) => s.layout === 'square' || s.layout === 'video')).toBe(true);
  });
});

describe('explore', () => {
  it('lays out a list of songs as a tracks shelf', () => {
    const explore = new YTMusic.Explore(response('browse-explore'));
    const trending = mapShelves(explore.sections).find((s) => s.items[0]?.kind === 'video' && s.layout === 'tracks');
    expect(trending?.items.length).toBeGreaterThan(0);
  });

  it('maps new releases as albums and new videos as wide', () => {
    const explore = new YTMusic.Explore(response('browse-explore'));
    const shelves = mapShelves(explore.sections);
    const albums = shelves.find((s) => s.items[0]?.kind === 'album');
    expect(albums?.layout).toBe('square');
    expect(albums?.seeAll?.browseId).toMatch(/^FEmusic_/);
    expect(shelves.some((s) => s.layout === 'video')).toBe(true);
  });
});

describe('album', () => {
  const album = mapAlbum('MPREb_test', new YTMusic.Album(response('browse-album')));

  it('reads the header', () => {
    expect(album.title).not.toBe('');
    expect(album.subtitle).toMatch(/•/);
    expect(album.meta).toMatch(/songs?|minutes?/i);
    expect(album.thumbnail).toMatch(/^https:/);
    expect(album.artists.length).toBeGreaterThan(0);
    expect(album.artists[0]!.id).toMatch(/^UC/);
    expect(album.playlistId).toMatch(/^OLAK/);
  });

  it('reads numbered tracks with durations', () => {
    expect(album.tracks.length).toBeGreaterThan(3);
    album.tracks.forEach((track, i) => {
      expect(track.videoId).toMatch(/^[\w-]{11}$/);
      expect(track.title).not.toBe('');
      expect(track.index).toBe(i + 1);
      expect(track.durationSec).toBeGreaterThan(0);
    });
  });
});

describe('playlist', () => {
  it('reads the header and tracks with artists and artwork', () => {
    const page = new YTMusic.Playlist(response('browse-playlist'), actions);
    const playlist = mapPlaylist('VLtest', page);
    expect(playlist.title).not.toBe('');
    expect(playlist.thumbnail).toMatch(/^https:/);
    expect(playlist.tracks.length).toBeGreaterThan(3);
    const track = playlist.tracks[0]!;
    expect(track.artists.length).toBeGreaterThan(0);
    expect(track.thumbnail).toMatch(/^https:/);
    expect(track.durationSec).toBeGreaterThan(0);
  });
});

describe('artist', () => {
  it('reads the hero, top songs and shelves', () => {
    const artist = mapArtist('UCtest', new YTMusic.Artist(response('browse-artist'), actions));
    expect(artist.name).not.toBe('');
    expect(artist.heroImage).toMatch(/^https:/);
    expect(artist.topSongs.length).toBeGreaterThan(0);
    expect(artist.shelves.some((s) => s.items[0]?.kind === 'album')).toBe(true);
    expect(artist.shelves.some((s) => s.layout === 'circle')).toBe(true);
  });
});

describe('search', () => {
  it('groups results by kind behind a top result', () => {
    const results = mapSearch(new YTMusic.Search(response('search-all'), actions, { is_filtered: false } as never));
    expect(results.top.length).toBeGreaterThan(1);
    expect(results.top[0]!.title).not.toBe('');
    expect(results.songs.length).toBeGreaterThan(0);
    expect(results.albums.length + results.playlists.length).toBeGreaterThan(0);
    const ids = [...results.songs, ...results.albums, ...results.artists, ...results.playlists, ...results.videos].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('suggestions', () => {
  it('splits completions into typed and remaining parts', async () => {
    // As YouTube.js's getSearchSuggestions reads them.
    const { Parser, YTNodes } = await import('youtubei.js');
    const parsed = Parser.parseResponse(fixture('search-suggestions'));
    const suggestions = mapSuggestions(parsed.contents_memo!.getType(YTNodes.SearchSuggestionsSection));
    expect(suggestions.queries.length).toBeGreaterThan(0);
    expect(suggestions.queries[0]!.typed + suggestions.queries[0]!.rest).toBe(suggestions.queries[0]!.text);
  });
});

describe('categories', () => {
  it('reads tile titles, colours and links from the raw moods page', () => {
    const groups = mapCategories(fixture('browse-moods-and-genres'));
    expect(groups.map((g) => g.title)).toEqual(expect.arrayContaining(['Genres']));
    const tile = groups[0]!.categories[0]!;
    expect(tile.title).not.toBe('');
    expect(tile.color).toMatch(/^rgb\(/);
    expect(tile.link.browseId).toBe('FEmusic_moods_and_genres_category');
  });

  it('borrows the tile cover from the first artwork on the page the tile opens', () => {
    const page = {
      title: 'Chill',
      shelves: [
        {
          title: 'Playlists',
          strapline: null,
          layout: 'square',
          items: [
            { thumbnail: null, wide: false },
            { thumbnail: 'https://img/shelf-cover.jpg', wide: false },
          ],
          seeAll: null,
        },
      ],
      grid: [{ thumbnail: 'https://img/grid-cover.jpg', wide: true }],
      tracks: [{ thumbnail: 'https://img/track-cover.jpg' }],
    } as unknown as BrowsePage;
    expect(firstBrowseArtwork(page)).toEqual({ thumbnail: 'https://img/shelf-cover.jpg', wide: false });
    expect(firstBrowseArtwork({ ...page, shelves: [] })).toEqual({ thumbnail: 'https://img/grid-cover.jpg', wide: true });
    expect(firstBrowseArtwork({ ...page, shelves: [], grid: [] })).toEqual({ thumbnail: 'https://img/track-cover.jpg', wide: false });
    expect(firstBrowseArtwork({ title: '', shelves: [], grid: [], tracks: [] })).toBeNull();
  });
});

describe('library albums mapping', () => {
  it('unwraps MPLA album wrappers and prefers album kind over heuristical video guesses', () => {
    const wrapped = mapItem({
      type: 'MusicTwoRowItem',
      title: { text: 'Currents' },
      subtitle: { text: 'Tame Impala • 2015' },
      item_type: 'video',
      thumbnail: [{ url: 'https://img/currents.jpg', width: 544, height: 544 }],
      endpoint: { payload: { browseId: 'MPLAMPREb_currents123' } },
      badges: [],
    } as never);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.kind).toBe('album');
    expect(wrapped!.id).toBe('MPREb_currents123');
    expect(wrapped!.wide).toBe(false);

    const privRelease = mapItem({
      type: 'MusicResponsiveListItem',
      title: 'Private Demo',
      subtitle: { text: 'Album • 2024' },
      item_type: 'endpoint',
      thumbnail: [],
      endpoint: { payload: { browseId: 'FEmusic_library_privately_owned_release_detail_abc' } },
      badges: [],
    } as never);
    expect(privRelease).not.toBeNull();
    expect(privRelease!.kind).toBe('album');
  });

  it('safely maps albums even with missing url or MusicDetailHeader', () => {
    const mapped = mapAlbum('MPREb_safe', {
      header: {
        title: { text: 'Test Album' },
        subtitle: { text: 'Album • 2024' },
        second_subtitle: { text: '5 songs' },
        thumbnail: [],
      } as never,
      contents: [] as never,
      sections: [] as never,
      url: 'not-a-valid-url',
    });
    expect(mapped.id).toBe('MPREb_safe');
    expect(mapped.title).toBe('Test Album');
    expect(mapped.playlistId).toBeNull();
    expect(mapped.tracks).toEqual([]);

    const browse = mapBrowse({ sections: [] }, 'Albums');
    expect(browse.title).toBe('Albums');
  });
});

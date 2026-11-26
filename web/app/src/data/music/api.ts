import type { YTMusic, YTNodes } from 'youtubei.js/web';
import type { Candidate } from '@/playback/queue/builder';
import { getInnertube, getMusicClient, getSignedInnertube } from '@/playback/youtube/innertube';
import { isExactArtistMatch, normalizedArtistName } from '@/lib/artistCredits';
import { LIBRARY_SECTIONS, LIKED_MUSIC_PLAYLIST, type LibrarySection } from './library';
import {
  mapAlbum,
  mapArtist,
  mapBrowse,
  mapCategories,
  mapHome,
  mapPlaylist,
  mapPlaylistTracks,
  mapSearch,
  mapShelves,
  mapSuggestions,
} from './mappers';
import type {
  AlbumPage,
  MusicItem,
  ArtistPage,
  BrowseLink,
  BrowsePage,
  CategoryGroup,
  PlaylistPage,
  SearchResults,
  Shelf,
  Suggestions,
  Track,
} from './types';

// The browse pages' requests, through YouTube.js's music namespace (prompt
// §5.1). Each returns a view model; continuations are passed back as opaque
// handles, so pages never see a YouTube.js object.

export interface Paged<T> {
  data: T;
  /** Fetches the next page; null when there isn't one. */
  next: (() => Promise<Paged<T>>) | null;
}

/**
 * YouTube often offers one more page than it has: the continuation comes back
 * empty and YouTube.js throws ("Continuation did not have any content"). That
 * is the end of the list, not a failure; anything else still is one.
 */
async function orEnd<T>(nextPage: () => Promise<Paged<T>>, empty: T): Promise<Paged<T>> {
  try {
    return await nextPage();
  } catch (error) {
    if (/did not have any content|no continuation/i.test(String(error))) return { data: empty, next: null };
    throw error;
  }
}

function homePage(feed: YTMusic.HomeFeed): Paged<Shelf[]> {
  return {
    data: mapHome(feed),
    next: feed.has_continuation ? () => orEnd(async () => homePage(await feed.getContinuation()), []) : null,
  };
}

export async function fetchHome(): Promise<Paged<Shelf[]>> {
  const yt = await getMusicClient();
  return homePage(await yt.music.getHomeFeed());
}

/** The New page: YouTube Music's Explore, minus its podcast and mood carousels (mappers drop those). */
export async function fetchExplore(): Promise<Shelf[]> {
  const yt = await getMusicClient();
  return mapShelves((await yt.music.getExplore()).sections);
}

/** Moods & genres, read raw because YouTube.js drops the tiles' colours. */
export async function fetchCategories(): Promise<CategoryGroup[]> {
  const yt = await getInnertube();
  const response = await yt.actions.execute('/browse', { browseId: 'FEmusic_moods_and_genres', client: 'YTMUSIC' });
  return mapCategories(response.data);
}

export async function fetchSearch(query: string): Promise<SearchResults> {
  const yt = await getMusicClient();
  return mapSearch(await yt.music.search(query));
}

/** YouTube Music's Songs shelf for [query]: what an import or a match is chosen from. */
export async function searchSongs(query: string): Promise<Track[]> {
  const yt = await getMusicClient();
  const search = await yt.music.search(query, { type: 'song' });
  const shelf = search.songs ?? search.contents?.find((c) => c.type === 'MusicShelf');
  return mapPlaylistTracks((shelf as { contents?: readonly unknown[] } | undefined)?.contents ?? []);
}

/** YouTube Music's Videos shelf for [query], used when resolving official music video cuts. */
export async function searchVideos(query: string): Promise<MusicItem[]> {
  const yt = await getMusicClient();
  const search = await yt.music.search(query, { type: 'video' });
  const shelf = search.videos ?? search.contents?.find((c) => c.type === 'MusicShelf');
  const contents = (shelf as { contents?: readonly unknown[] } | undefined)?.contents ?? [];
  const tracks = mapPlaylistTracks(contents);
  const items: MusicItem[] = tracks.map((mapped) => ({
    kind: 'video',
    id: mapped.videoId,
    title: mapped.title,
    subtitle: mapped.artists.map((a) => a.name).join(', '),
    artists: mapped.artists,
    album: mapped.album,
    thumbnail: mapped.thumbnail,
    wide: true,
    durationSec: mapped.durationSec,
    explicit: mapped.explicit,
  }));
  if (items.length) return items;
  return (await fetchSearch(query)).videos;
}

export async function fetchSuggestions(input: string): Promise<Suggestions> {
  const yt = await getInnertube();
  return mapSuggestions(await yt.music.getSearchSuggestions(input));
}

export async function fetchAlbum(id: string): Promise<AlbumPage> {
  const yt = await getMusicClient();
  const resolvedId = id.startsWith('MPLA') ? id.slice(4) : id;

  // Playlist-backed releases (OLAK5uy_ / VL) can occasionally land as album links.
  if (resolvedId.startsWith('OLAK') || resolvedId.startsWith('VL')) {
    const pl = await yt.music.getPlaylist(resolvedId);
    const header = pl.header as unknown as Record<string, unknown> | undefined;
    const mapped = mapPlaylist(resolvedId, pl);
    return {
      ...mapped,
      playlistId: resolvedId.replace(/^VL/, ''),
      more: mapShelves((pl as unknown as { page?: { contents_memo?: { getType?: (t: unknown) => unknown[] } } }) ? [] : []),
      ...(header ? {} : {}),
    };
  }

  try {
    return mapAlbum(resolvedId, await yt.music.getAlbum(resolvedId));
  } catch (primaryErr) {
    // Fallback for YouTube.js Album.js crashes (`MusicShelf` missing when `MusicPlaylistShelf` is used,
    // or privately owned / library-wrapped album releases).
    try {
      const signed = await getSignedInnertube().catch(() => yt);
      const { YTNodes } = await import('youtubei.js/web');
      const response = await signed.actions.execute('/browse', { browseId: resolvedId, client: 'YTMUSIC', parse: true });
      const memo = response.contents_memo;
      const header = memo?.getType(YTNodes.MusicResponsiveHeader, YTNodes.MusicDetailHeader)?.[0];
      const contents =
        memo?.getType(YTNodes.MusicShelf)?.[0]?.contents ??
        memo?.getType(YTNodes.MusicPlaylistShelf)?.[0]?.contents ??
        [];
      const sections = memo?.getType(YTNodes.MusicCarouselShelf) ?? [];
      return mapAlbum(resolvedId, {
        header,
        contents,
        sections,
        url: undefined,
      } as unknown as Parameters<typeof mapAlbum>[1]);
    } catch {
      throw primaryErr;
    }
  }
}

/** How many top songs an artist page lists, as on the phone. */
const ARTIST_TOP_SONGS = 20;

/**
 * An artist. The landing page only lists five songs, so its linked "Top
 * songs" playlist fills the list out (YtMusicRepository.artistPage); if that
 * fails, the five stand.
 */
export async function fetchArtist(id: string): Promise<ArtistPage> {
  const yt = await getMusicClient();
  const page = mapArtist(id, await yt.music.getArtist(id));
  const playlistId = page.topSongsSeeAll?.browseId;
  if (playlistId?.startsWith('VL') && page.topSongs.length < ARTIST_TOP_SONGS) {
    try {
      const { page: playlist } = await fetchPlaylist(playlistId);
      if (playlist.tracks.length > page.topSongs.length) page.topSongs = playlist.tracks.slice(0, ARTIST_TOP_SONGS);
    } catch {
      // The landing page's songs are still the right ones, just fewer.
    }
  }
  return page;
}

function playlistTracks(page: YTMusic.Playlist): Paged<Track[]> {
  return {
    data: mapPlaylistTracks(page.items),
    next: page.has_continuation ? () => orEnd(async () => playlistTracks(await page.getContinuation()), []) : null,
  };
}

/** The header and first page of tracks; `more` fetches the rest page by page. */
export async function fetchPlaylist(id: string): Promise<{ page: PlaylistPage; more: Paged<Track[]>['next'] }> {
  const yt = await getMusicClient();
  const playlist = await yt.music.getPlaylist(id);
  return { page: mapPlaylist(id, playlist), more: playlistTracks(playlist).next };
}

/** See All, moods and genres: whatever the browse id renders as. */
export async function fetchBrowse({ browseId, params }: BrowseLink): Promise<BrowsePage> {
  const yt = await getMusicClient();
  const { YTNodes } = await import('youtubei.js/web');
  const response = await yt.actions.execute('/browse', {
    browseId,
    ...(params && { params }),
    client: 'YTMUSIC',
    parse: true,
  });
  const memo = response.contents_memo;
  const sections = [
    ...(memo?.getType(YTNodes.Grid) ?? []),
    ...(memo?.getType(YTNodes.MusicCarouselShelf) ?? []),
    ...(memo?.getType(YTNodes.MusicShelf) ?? []),
    ...(memo?.getType(YTNodes.MusicPlaylistShelf) ?? []),
  ];
  const header = memo?.getType(YTNodes.MusicHeader)?.[0] ?? (response.header as unknown);
  return mapBrowse({ header, sections }, '');
}

// ---- Signed in (prompt §5.3) ------------------------------------------------------

type Raw = Record<string, unknown>;

/** Every object stored under [key], anywhere inside a raw response. */
function collect(root: unknown, key: string, out: Raw[] = []): Raw[] {
  if (Array.isArray(root)) for (const item of root) collect(item, key, out);
  else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Raw);
      else collect(v, key, out);
    }
  }
  return out;
}

function runsText(node: unknown): string {
  const n = node as { runs?: { text?: string }[]; simpleText?: string } | undefined;
  return n?.runs?.map((r) => r.text ?? '').join('') ?? n?.simpleText ?? '';
}

/** One library page, a page of it at a time: grids continue as grids, song lists as song lists. */
export async function fetchLibrary(section: LibrarySection): Promise<Paged<BrowsePage>> {
  const yt = await getSignedInnertube();
  const { YTNodes } = await import('youtubei.js/web');
  const { title, browseId } = LIBRARY_SECTIONS[section];
  const response = await yt.actions.execute('/browse', { browseId, client: 'YTMUSIC', parse: true });
  const memo = response.contents_memo;
  const grids = memo?.getType(YTNodes.Grid) ?? [];
  const lists = [...(memo?.getType(YTNodes.MusicShelf) ?? []), ...(memo?.getType(YTNodes.MusicPlaylistShelf) ?? [])];
  const carousels = memo?.getType(YTNodes.MusicCarouselShelf) ?? [];
  const page = mapBrowse({ sections: [...grids, ...lists, ...carousels] }, title);
  // Fallback: if memo held TwoRowItems/ResponsiveItems outside Grid/MusicShelf wrappers (e.g. album grids), extract them directly.
  if (!page.grid.length && !page.tracks.length && !page.shelves.length && memo) {
    const looseNodes = [
      ...(memo.getType(YTNodes.MusicTwoRowItem) ?? []),
      ...(memo.getType(YTNodes.MusicResponsiveListItem) ?? []),
    ];
    const loose = mapBrowse({ sections: [{ type: 'Grid', items: looseNodes }] }, title);
    page.grid = loose.grid;
  }
  // History is several lists ("Today", "Yesterday"); the rest is one grid or one list.
  const token = (grids[0]?.continuation ?? (lists.length === 1 ? lists[0]?.continuation : null)) || null;
  return { data: { ...page, title }, next: token ? () => orEnd(() => libraryContinuation(token, title), emptyPage(title)) : null };
}

const emptyPage = (title: string): BrowsePage => ({ title, shelves: [], grid: [], tracks: [] });

async function libraryContinuation(token: string, title: string): Promise<Paged<BrowsePage>> {
  const yt = await getSignedInnertube();
  const response = await yt.actions.execute('/browse', { continuation: token, client: 'YTMUSIC', parse: true });
  const contents = response.continuation_contents as unknown as
    | { type: string; items?: unknown[]; contents?: unknown[]; continuation?: string | null }
    | undefined;
  const section =
    contents?.type === 'GridContinuation'
      ? { type: 'Grid', items: contents.items ?? [] }
      : { type: 'MusicShelf', contents: contents?.contents ?? [] };
  const next = contents?.continuation || null;
  return {
    data: mapBrowse({ sections: [section] }, title),
    next: next ? () => orEnd(() => libraryContinuation(next, title), emptyPage(title)) : null,
  };
}

/** The user's playlists for the sidebar, in YouTube's order (most recent activity first). */
export async function fetchLibraryPlaylists(): Promise<MusicItem[]> {
  const { data } = await fetchLibrary('playlists');
  return data.grid.filter((item) => item.kind === 'playlist');
}

export type LikeStatus = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

/** The thumbs state YouTube Music shows on its player for this track. */
export async function fetchLikeStatus(videoId: string): Promise<LikeStatus> {
  const yt = await getSignedInnertube();
  const response = await yt.actions.execute('/next', { videoId, client: 'YTMUSIC' });
  const button = collect((response.data as Raw).playerOverlays, 'likeButtonRenderer')[0];
  const status = button?.likeStatus;
  return status === 'LIKE' || status === 'DISLIKE' ? status : 'INDIFFERENT';
}

/** Likes a track (it joins Liked Music) or takes the like back. */
export async function setTrackLiked(videoId: string, liked: boolean): Promise<void> {
  const yt = await getSignedInnertube();
  await yt.actions.execute(liked ? '/like/like' : '/like/removelike', { target: { videoId }, client: 'YTMUSIC' });
}

/** Adds an album or playlist to the library, or removes it: YouTube saves both by liking the list. */
export async function setListSaved(playlistId: string, saved: boolean): Promise<void> {
  const yt = await getSignedInnertube();
  await yt.actions.execute(saved ? '/like/like' : '/like/removelike', { target: { playlistId }, client: 'YTMUSIC' });
}

export interface PlaylistOption {
  playlistId: string;
  title: string;
}

/**
 * The playlists a track can be added to, as YouTube Music's "Save to
 * playlist" lists them. YouTube doesn't say which already hold the track
 * (adding is deduplicated instead), and its "Liked Music" entry is really a
 * like, which Favorite already does, so it's left out.
 */
export async function fetchPlaylistOptions(videoId: string): Promise<PlaylistOption[]> {
  const yt = await getSignedInnertube();
  const response = await yt.actions.execute('/playlist/get_add_to_playlist', { videoIds: [videoId], client: 'YTMUSIC' });
  return collect(response.data, 'playlistAddToOptionRenderer')
    .map((option) => ({
      playlistId: typeof option.playlistId === 'string' ? option.playlistId : '',
      title: runsText(option.title),
    }))
    .filter((option) => option.playlistId && option.playlistId !== LIKED_MUSIC_PLAYLIST && option.title);
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<void> {
  const yt = await getSignedInnertube();
  await yt.actions.execute('/browse/edit_playlist', {
    playlistId: playlistId.replace(/^VL/, ''),
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId, dedupeOption: 'DEDUPE_OPTION_SKIP' }],
    client: 'YTMUSIC',
  });
}

export type PlaylistPrivacy = 'PRIVATE' | 'PUBLIC' | 'UNLISTED';

/**
 * A new playlist holding [videoIds], as YtMusicRepository.createPlaylist
 * makes one (InnerTube `playlist/create`). Returns its id, without the VL.
 */
export async function createPlaylist(
  title: string,
  videoIds: string[],
  description = '',
  privacyStatus: PlaylistPrivacy = 'PRIVATE',
): Promise<string> {
  const yt = await getSignedInnertube();
  const response = await yt.actions.execute('/playlist/create', {
    title,
    description,
    privacyStatus,
    videoIds,
    client: 'YTMUSIC',
  });
  const id = (response.data as { playlistId?: string } | undefined)?.playlistId;
  if (!id) throw new Error('YouTube Music did not make the playlist');
  return id;
}

// ---- AutoPlay (phase 6) -------------------------------------------------------------

/**
 * A music video rather than the catalogue song: YouTube marks each watch
 * endpoint with its type, ATV for the song and OMV/UGC for videos. (A radio
 * seeded on a video id is all videos; one seeded on a song is mostly songs.)
 */
function musicVideoTypeOf(item: YTNodes.PlaylistPanelVideo): string | undefined {
  return (item.endpoint?.payload as { watchEndpointMusicSupportedConfigs?: { watchEndpointMusicConfig?: { musicVideoType?: string } } } | undefined)
    ?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
}

function isMusicVideo(item: YTNodes.PlaylistPanelVideo): boolean {
  const type = musicVideoTypeOf(item);
  return type !== undefined ? type !== 'MUSIC_VIDEO_TYPE_ATV' : !item.album;
}

const NON_ORIGINAL_CHANNEL_OR_TITLE =
  /\b(?:7clouds|shadow\s*music|koala\s*kontrol|taz\s*network|vibe\s*music|syrebralvibes|uniq\s*vibes|aura\s*melodic|chill\s*only|cloudkid|xefox|nightblue|wave\s*music|latin\s*hype|rap\s*city|trap\s*nation|bass\s*nation|lyrics?\s*hub|polar\s*records)\b/i;
const FAN_UPLOAD_KEYWORDS = /\b(?:lyric(?:s|al)?\s*video|lyrics\s+video|fan\s*made|sped\s*up|slowed(?:\s*\+\s*reverb)?|nightcore|8d\s*audio|karaoke|tribute)\b/i;

export function isThirdPartyUpload(track: Pick<Track, 'title' | 'artists'>): boolean {
  const names = track.artists.map((a) => a.name).join(' ');
  return NON_ORIGINAL_CHANNEL_OR_TITLE.test(names) || NON_ORIGINAL_CHANNEL_OR_TITLE.test(track.title) || FAN_UPLOAD_KEYWORDS.test(track.title);
}

/**
 * Returns true when a video cut is an authentic, official original video (OMV / official artist channel)
 * rather than a third-party fan re-upload (e.g. 7clouds, lyric video channels, UGC edits).
 */
export function isOriginalOfficialVideoCandidate({
  title,
  artists,
  musicVideoType,
  expectedArtistIds = [],
  uploaderChannelIds = [],
}: {
  title: string;
  artists: string;
  musicVideoType?: string;
  expectedArtistIds?: readonly (string | null | undefined)[];
  uploaderChannelIds?: readonly (string | null | undefined)[];
}): boolean {
  if (musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') return false;
  if (NON_ORIGINAL_CHANNEL_OR_TITLE.test(artists) || NON_ORIGINAL_CHANNEL_OR_TITLE.test(title)) {
    return false;
  }
  if (musicVideoType === 'MUSIC_VIDEO_TYPE_OMV') return true;
  const knownArtistIds = new Set(expectedArtistIds.filter((id): id is string => !!id));
  const channelMatchesArtist = uploaderChannelIds.some((id) => !!id && knownArtistIds.has(id));
  if (musicVideoType === 'MUSIC_VIDEO_TYPE_UGC') {
    return channelMatchesArtist && !FAN_UPLOAD_KEYWORDS.test(title);
  }
  if (FAN_UPLOAD_KEYWORDS.test(title)) return false;
  return true;
}

/** Extracts real `{ title, artist }` hints when a third-party YouTube upload puts `"Artist - Song"` in title and `"7clouds..."` as artist. */
export function cleanSongSearchTerms(title: string, artist: string): { title: string; artist: string } {
  const normalizedArtist = artist.replace(/\s*-\s*Topic$/i, '').trim();
  const cleanChannel = NON_ORIGINAL_CHANNEL_OR_TITLE.test(normalizedArtist) ? '' : normalizedArtist;
  const split = title.split(/\s[-–—]\s/);
  if (split.length >= 2 && !cleanChannel && split[0]!.trim() && split[1]!.trim()) {
    return {
      artist: split[0]!.replace(/\s*-\s*Topic$/i, '').trim(),
      title: split.slice(1).join(' - ').replace(/\s*[([]\s*(?:lyric(?:s|al)?(?:\s*video)?|official(?:\s*(?:music|lyric))?\s*(?:video|audio)|visualizer|m\/?v|audio|video|hd|4k)[^)\]]*[)\]]/gi, '').trim(),
    };
  }
  return {
    title: title
      .replace(/\s*[([]\s*(?:lyric(?:s|al)?\s*video|lyrics|official\s*(?:lyric\s*)?video|visualizer|m\/?v|hd|4k)[^)\]]*[)\]]/gi, '')
      .trim() || title.trim(),
    artist: cleanChannel,
  };
}

/** A station, and which cut it was seeded on: a music video's station is built from music videos. */
export interface Radio {
  candidates: Candidate[];
  /** [videoId] is itself a music video, not the catalogue song. */
  seedIsVideo: boolean;
}

/**
 * The radio YouTube Music would play after [videoId]: its "RDAMVM" mix, as
 * Innertube.next asks for it on the phone. Signed in it's the user's own
 * station.
 *
 * Most rows carry both cuts of a track, and which one is taken follows what
 * is playing: a music video's station stays on music videos, a song's on the
 * catalogue cuts. The seed's own row says which of the two it is.
 */
export async function fetchRadio(videoId: string): Promise<Radio> {
  const yt = await getMusicClient();
  const panel = await yt.music.getUpNext(videoId, true);
  const rows = panel.contents as unknown as Raw[];
  const seedCut = rows.flatMap(panelCuts).find((cut) => cut.video_id === videoId);
  const seedIsVideo = seedCut ? isMusicVideo(seedCut) : false;
  const candidates = rows
    .map((raw) => panelCandidate(raw, seedIsVideo))
    .filter((c): c is Candidate => c !== null)
    .filter((c) => !isThirdPartyUpload(c.track));
  return {
    candidates,
    seedIsVideo,
  };
}

/**
 * A watch-queue row's cuts. A wrapper pairs the two cuts of one track (song
 * and music video), with either as its primary.
 */
function panelCuts(raw: Raw): YTNodes.PlaylistPanelVideo[] {
  const cuts = (raw.type === 'PlaylistPanelVideoWrapper'
    ? [raw.primary, ...((raw.counterpart as unknown[] | undefined) ?? [])]
    : [raw]) as (YTNodes.PlaylistPanelVideo | null | undefined)[];
  return cuts.filter((c): c is YTNodes.PlaylistPanelVideo => c?.type === 'PlaylistPanelVideo');
}

/** One watch-queue row as a track: the catalogue song (the cut with an album), or its music video for [wantVideo]. */
function panelCandidate(raw: Raw, wantVideo = false): Candidate | null {
  const panelVideos = panelCuts(raw);
  const item = panelVideos.find((c) => isMusicVideo(c) === wantVideo) ?? panelVideos[0];
  if (!item?.video_id) return null;
  const thumbs = [...(item.thumbnail ?? [])].sort((a, b) => b.width - a.width);
  return {
    track: {
      videoId: item.video_id,
      title: item.title?.toString() ?? '',
      artists: (item.artists ?? []).map((a) => ({ name: a.name, id: a.channel_id ?? null })),
      album: item.album ? { name: item.album.name, id: item.album.id ?? null } : null,
      durationSec: item.duration?.seconds || null,
      explicit: (item.badges ?? []).some((b) => /explicit/i.test(JSON.stringify(b))),
      thumbnail: thumbs[0]?.url ?? null,
      index: null,
      plays: null,
    },
    isVideo: isMusicVideo(item),
  };
}

// ---- Player links ---------------------------------------------------------------

/**
 * The album and artist pages a track links out to (YtMusicRepository.trackLinks).
 * Queue rows from home cards often lack them; the track's own watch-queue
 * entry always names both.
 */
export async function fetchTrackLinks(videoId: string): Promise<Track | null> {
  const yt = await getMusicClient();
  const panel = await yt.music.getUpNext(videoId, false);
  // The row holding this video, by either of its cuts; its catalogue cut names the album.
  const row = (panel.contents as unknown as Raw[]).find((raw) => panelCuts(raw).some((cut) => cut.video_id === videoId));
  return (row && panelCandidate(row)?.track) ?? null;
}

/**
 * The page of the artist called exactly [name] (YtMusicRepository.findArtistPageId):
 * a name is not an identity, so only a result that answers to it exactly is
 * opened, never the nearest one.
 */
export async function findArtistPageId(name: string): Promise<string | null> {
  if (!normalizedArtistName(name)) return null;
  const results = await fetchSearch(name);
  return [...results.top, ...results.artists].find((item) => item.kind === 'artist' && isExactArtistMatch(item.title, name))?.id ?? null;
}

const versionPairCache = new Map<string, Track | null>();
const videoCutFlagCache = new Map<string, boolean>();
const originalVideoCutCache = new Map<string, boolean>();
const pendingVideoAvailability = new Map<string, Promise<boolean>>();

export function isKnownVideoCut(videoId: string): boolean {
  return videoCutFlagCache.get(videoId) === true;
}

/** Returns the paired catalogue audio track for a Video Mode cut, if resolved earlier. */
export function pairedAudioTrack(videoId: string): Track | null {
  return versionPairCache.get(`${videoId}:audio`) ?? null;
}

export function getCachedOriginalVideoSupport(videoId: string): boolean | undefined {
  if (versionPairCache.has(`${videoId}:video`)) {
    return versionPairCache.get(`${videoId}:video`) !== null;
  }
  if (versionPairCache.get(`${videoId}:audio`)) {
    return true;
  }
  return originalVideoCutCache.get(videoId);
}

/**
 * Checks whether [track] has a genuine original Music Video (without using generic video search).
 * Deduplicates concurrent lookups and caches the answer per track.
 */
export async function hasOriginalMusicVideo(track: Track): Promise<boolean> {
  const cached = getCachedOriginalVideoSupport(track.videoId);
  if (cached !== undefined) return cached;

  const existing = pendingVideoAvailability.get(track.videoId);
  if (existing) return existing;

  const job = (async () => {
    const video = await resolveTrackModeVersion(track, 'video').catch(() => null);
    if (video) return true;
    return originalVideoCutCache.get(track.videoId) === true;
  })().finally(() => {
    pendingVideoAvailability.delete(track.videoId);
  });

  pendingVideoAvailability.set(track.videoId, job);
  return job;
}

function normMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(official|music video|video|lyric video|audio|lyrics|hd|4k|visualizer|mv)\b/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f\u0900-\u0d7f]+/g, ' ')
    .trim();
}

function matchTokens(value: string): string[] {
  return normMatchText(value).split(' ').filter(Boolean);
}

function titlesTokenMatch(candidateTitle: string, targetTitle: string): boolean {
  const cTitle = normMatchText(candidateTitle);
  const tTitle = normMatchText(targetTitle);
  if (!cTitle || !tTitle) return false;
  if (cTitle === tTitle) return true;
  const cTokens = matchTokens(candidateTitle);
  const tTokens = matchTokens(targetTitle);
  if (!cTokens.length || !tTokens.length) return false;
  if (tTokens.length === 1 && tTokens[0]!.length <= 4) {
    return cTokens[0] === tTokens[0] && cTokens.length <= 3;
  }
  const cSet = new Set(cTokens);
  return tTokens.every((t) => cSet.has(t)) && cTokens.length <= tTokens.length + 3;
}

function scoreCutMatch(
  candidateTitle: string,
  candidateArtists: string,
  targetTitle: string,
  targetArtists: string,
  candidateDurationSec?: number | null,
  targetDurationSec?: number | null,
): number {
  const cTitle = normMatchText(candidateTitle);
  const tTitle = normMatchText(targetTitle);
  if (!cTitle || !tTitle) return 0;
  let score = cTitle === tTitle ? 4 : titlesTokenMatch(candidateTitle, targetTitle) ? 2 : 0;
  if (!score) return 0;
  const cArt = normMatchText(candidateArtists);
  const tArt = normMatchText(targetArtists);
  if (cArt && tArt && (cArt.includes(tArt) || tArt.includes(cArt))) score += 3;
  if (candidateDurationSec && targetDurationSec && candidateDurationSec > 0 && targetDurationSec > 0) {
    const diff = Math.abs(candidateDurationSec - targetDurationSec);
    if (diff <= 4) score += 4;
    else if (diff <= 10) score += 2;
    else if (diff > 20) score -= 4;
  }
  return score;
}

/**
 * Resolves the paired official original Music Video (`target = 'video'`) or Catalogue Song (`target = 'audio'`)
 * version of [track] using YouTube Music's watch-queue wrapper.
 * For Video Mode (`target = 'video'`), never falls back to third-party YouTube video search (such as 7clouds
 * or fan lyric uploads); returns null when no authentic original Music Video is paired.
 */
export async function resolveTrackModeVersion(track: Track, target: 'video' | 'audio'): Promise<Track | null> {
  const cacheKey = `${track.videoId}:${target}`;
  if (versionPairCache.has(cacheKey)) {
    return versionPairCache.get(cacheKey) ?? null;
  }

  const yt = await getMusicClient();
  try {
    const panel = await yt.music.getUpNext(track.videoId, false);
    const rows = panel.contents as unknown as Raw[];
    const row = rows.find((raw) => panelCuts(raw).some((cut) => cut.video_id === track.videoId));
    if (row) {
      const cuts = panelCuts(row);
      const currentCut = cuts.find((c) => c.video_id === track.videoId);
      if (currentCut) {
        const currentIsVid = isMusicVideo(currentCut);
        videoCutFlagCache.set(track.videoId, currentIsVid);
        if (currentIsVid) {
          originalVideoCutCache.set(
            track.videoId,
            isOriginalOfficialVideoCandidate({
              title: currentCut.title?.toString() ?? track.title,
              artists: (currentCut.artists ?? []).map((a) => a.name).join(', '),
              musicVideoType: musicVideoTypeOf(currentCut),
              expectedArtistIds: track.artists.map((a) => a.id),
              uploaderChannelIds: (currentCut.artists ?? []).map((a) => a.channel_id),
            }),
          );
        } else {
          originalVideoCutCache.set(
            track.videoId,
            cuts.some((c) => {
              if (c.video_id === track.videoId || !isMusicVideo(c)) return false;
              return isOriginalOfficialVideoCandidate({
                title: c.title?.toString() ?? '',
                artists: (c.artists ?? []).map((a) => a.name).join(', '),
                musicVideoType: musicVideoTypeOf(c),
                expectedArtistIds: track.artists.map((a) => a.id),
                uploaderChannelIds: (c.artists ?? []).map((a) => a.channel_id),
              });
            }),
          );
        }
      }

      if (target === 'video') {
        const videoCut = cuts.find((c) => {
          if (!isMusicVideo(c)) return false;
          return isOriginalOfficialVideoCandidate({
            title: c.title?.toString() ?? '',
            artists: (c.artists ?? []).map((a) => a.name).join(', '),
            musicVideoType: musicVideoTypeOf(c),
            expectedArtistIds: track.artists.map((a) => a.id),
            uploaderChannelIds: (c.artists ?? []).map((a) => a.channel_id),
          });
        });
        if (videoCut?.video_id) {
          const thumbs = [...(videoCut.thumbnail ?? [])].sort((a, b) => b.width - a.width);
          const merged: Track = {
            videoId: videoCut.video_id,
            title: videoCut.title?.toString() || track.title,
            artists: (videoCut.artists ?? []).length
              ? (videoCut.artists ?? []).map((a) => ({ name: a.name, id: a.channel_id ?? null }))
              : track.artists,
            album: track.album,
            durationSec: videoCut.duration?.seconds || track.durationSec,
            explicit: (videoCut.badges ?? []).some((b) => /explicit/i.test(JSON.stringify(b))) || track.explicit,
            thumbnail: thumbs[0]?.url ?? track.thumbnail,
            index: null,
            plays: null,
          };
          videoCutFlagCache.set(merged.videoId, true);
          originalVideoCutCache.set(merged.videoId, true);
          originalVideoCutCache.set(track.videoId, true);
          versionPairCache.set(cacheKey, merged);
          versionPairCache.set(`${merged.videoId}:audio`, track);
          return merged;
        }
        // Track has no authentic paired Official Music Video — do NOT fall back to 7clouds / YouTube search
        originalVideoCutCache.set(track.videoId, false);
        versionPairCache.set(cacheKey, null);
        return null;
      }

      const paired = panelCandidate(row, false);
      if (paired && !paired.isVideo) {
        videoCutFlagCache.set(paired.track.videoId, false);
        const merged: Track = {
          ...paired.track,
          title: paired.track.title || track.title,
          artists: paired.track.artists.length ? paired.track.artists : track.artists,
          album: paired.track.album ?? track.album,
        };
        versionPairCache.set(cacheKey, merged);
        versionPairCache.set(`${merged.videoId}:video`, track);
        return merged;
      }
    }
  } catch {
    if (target === 'video') return null;
  }

  if (target === 'video') {
    originalVideoCutCache.set(track.videoId, false);
    versionPairCache.set(cacheKey, null);
    return null;
  }

  const rawLeadArtist = track.artists[0]?.name ?? '';
  const cleanedTerms = cleanSongSearchTerms(track.title, rawLeadArtist);
  const query = [cleanedTerms.title, cleanedTerms.artist].filter(Boolean).join(' ').trim();
  if (!query) {
    versionPairCache.set(cacheKey, null);
    return null;
  }

  try {
    const songs = await searchSongs(query);
    let best: { song: Track; score: number } | null = null;
    for (const song of songs) {
      if (isThirdPartyUpload(song)) continue;
      const art = song.artists.map((a) => a.name).join(' ');
      const s = scoreCutMatch(
        song.title,
        art,
        cleanedTerms.title,
        cleanedTerms.artist,
        song.durationSec,
        track.durationSec,
      );
      if (s > 0 && (!best || s > best.score)) best = { song, score: s };
    }
    if (best && (cleanedTerms.artist || best.score >= 4)) {
      videoCutFlagCache.set(best.song.videoId, false);
      versionPairCache.set(cacheKey, best.song);
      versionPairCache.set(`${best.song.videoId}:video`, track);
      return best.song;
    }
  } catch {
    return null;
  }

  versionPairCache.set(cacheKey, null);
  return null;
}

import { Maximize, Minimize, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import {
  BackwardIcon,
  ForwardIcon,
  LyricsActiveIcon,
  LyricsIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  UpNextIcon,
} from '@/components/icons/Transport';
import { ExplicitBadge } from '@/components/music/ExplicitBadge';
import { FavoriteButton } from '@/components/music/FavoriteButton';
import { TrackMenu } from '@/components/music/TrackMenu';
import { albumHref } from '@/components/music/links';
import { MotionArtwork } from '@/components/music/MotionArtwork';
import { useTrackMotion } from '@/data/apple/motionArt';
import { artworkFallbackUrl, heroArtwork, sizedArtwork } from '@/lib/artwork';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { Credits, PageLink, pageLink } from './Lcd';
import { LyricsPanel } from './LyricsPanel';
import { MeshBackdrop } from './MeshBackdrop';
import { albumPageFor } from './nowPlayingLinks';
import { SleepTimerButton } from './SleepTimerMenu';
import { UpNext } from './UpNext';
import { MixWindowHighlight, NerdStats } from './NerdStats';
import { useScrubber } from './useScrubber';
import { fadeForVolume, VolumeControl } from './VolumeControl';

function useBrowserFullScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('fullscreenchange', onChange);
      return () => document.removeEventListener('fullscreenchange', onChange);
    },
    () => document.fullscreenElement !== null,
  );
}

/** The seek line under the track's names: thicker on hover, with the times beneath its ends. */
function Scrubber() {
  const { bar, elapsed, remaining, mixLabel, dragging, handlers } = useScrubber();
  return (
    <div className="group/scrub mt-3.5" data-dragging={dragging || undefined}>
      {/* A taller hit area than the line it carries. */}
      <div className="group/hit flex h-4 cursor-pointer touch-none items-center" {...handlers}>
        <div
          className="relative h-1 flex-1 overflow-hidden rounded-[999px] bg-quaternary transition-[height] duration-120 ease-in group-hover/hit:h-2 group-data-dragging/scrub:h-2"
          aria-hidden="true"
        >
          <MixWindowHighlight />
          <div
            ref={bar}
            className="relative size-full origin-left scale-x-(--progress) bg-white/95 transition-[background-color] duration-120 ease-in [--progress:0] group-hover/hit:bg-white group-data-dragging/scrub:bg-white"
          />
        </div>
      </div>
      <div className="relative mt-0.5 flex justify-between type-[500_11px/14px] tabular-nums text-tertiary">
        <span ref={elapsed} />
        <span ref={mixLabel} className="pointer-events-none absolute inset-x-0 text-center text-secondary opacity-0" aria-hidden="true">
          Mixing
        </span>
        <span ref={remaining} />
      </div>
    </div>
  );
}

const transportButton =
  'grid place-items-center rounded-full transition-[background-color,scale] duration-100 ease-in enabled:hover:bg-quinary enabled:active:scale-90 disabled:opacity-40';
// Shuffle and repeat, when on: full white on the mesh, where red would clash.
const toggle = `${transportButton} size-9 text-tertiary aria-pressed:text-primary`;
const skip = `${transportButton} size-12 text-primary`;

/** Shuffle, previous, play/pause, next, repeat. No volume: the pill keeps that. */
function Transport() {
  const hasTrack = usePlayer((s) => s.nowPlaying !== null);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const hasNext = usePlayer((s) => s.index + 1 < s.queue.length || s.repeat !== 'off' || (s.autoplay && s.index >= 0));
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const { togglePlay, next, previous, toggleShuffle, cycleRepeat } = usePlayer.getState();

  return (
    <div className="mx-auto mt-[clamp(8px,1.6vh,16px)] mb-0 flex h-13 w-[min(100%,315px)] items-center justify-between">
      <button className={toggle} aria-label="Shuffle" aria-pressed={shuffle} onClick={toggleShuffle}>
        <ShuffleIcon size={30} />
      </button>
      <button className={skip} disabled={!hasTrack} aria-label="Previous" onClick={previous}>
        <BackwardIcon size={40} />
      </button>
      <button className={`${transportButton} size-14 text-primary`} disabled={!hasTrack} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
        {playing ? <PauseIcon size={48} /> : <PlayIcon size={48} />}
      </button>
      <button className={skip} disabled={!hasTrack || !hasNext} aria-label="Next" onClick={next}>
        <ForwardIcon size={40} />
      </button>
      <button
        className={toggle}
        aria-label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
        aria-pressed={repeat !== 'off'}
        onClick={cycleRepeat}
      >
        {repeat === 'one' ? <RepeatOneIcon size={30} /> : <RepeatIcon size={30} />}
      </button>
    </div>
  );
}

// Close, browser full screen, the column toggles and the speaker, in the corners.
const chromeButton =
  'grid size-8 place-items-center rounded-full text-secondary transition-[background-color,color] duration-100 ease-in hover:bg-quinary hover:text-primary';
const chrome = `absolute z-2 ${chromeButton}`;
const artworkLayer =
  'absolute inset-0 size-full object-cover transition-[opacity,transform,filter] duration-900 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform,filter]';

/** Crossfades smoothly between poster URLs (up to 8K) with automatic stepdown fallback on CDN error. */
function HeroPoster({ src, className }: { src: string; className: string }) {
  const [settledSrc, setSettledSrc] = useState(src);
  const [pendingSrc, setPendingSrc] = useState<string | null>(null);
  const [pendingLoaded, setPendingLoaded] = useState(false);

  useEffect(() => {
    if (src === settledSrc) {
      setPendingSrc(null);
      setPendingLoaded(false);
      return;
    }
    setPendingSrc(src);
    setPendingLoaded(false);
  }, [src, settledSrc]);

  useEffect(() => {
    if (!pendingSrc || !pendingLoaded) return;
    const id = setTimeout(() => {
      setSettledSrc(pendingSrc);
      setPendingSrc(null);
      setPendingLoaded(false);
    }, 940);
    return () => clearTimeout(id);
  }, [pendingSrc, pendingLoaded]);

  return (
    <>
      <img
        src={settledSrc}
        alt=""
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => {
          const fallback = artworkFallbackUrl(settledSrc);
          if (fallback && fallback !== settledSrc) setSettledSrc(fallback);
        }}
        className={`${className} opacity-100 scale-100 blur-0`}
      />
      {pendingSrc && (
        <img
          key={pendingSrc}
          src={pendingSrc}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onLoad={() => setPendingLoaded(true)}
          onError={() => {
            const fallback = artworkFallbackUrl(pendingSrc);
            if (fallback && fallback !== pendingSrc) {
              setPendingSrc(fallback);
            } else {
              setPendingSrc(null);
              setPendingLoaded(false);
            }
          }}
          className={`${className} ${pendingLoaded ? 'opacity-100 scale-100 blur-0' : 'opacity-0 scale-[1.02] blur-[6px]'}`}
        />
      )}
    </>
  );
}

/**
 * The full-screen player (report §7): beside Lyrics or Up Next, the artwork sits
 * beside the right column; when neither column is open, a centered unzoomed
 * poster card sits in the middle above the track info and controls.
 */
export function FullScreenPlayer() {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  // The queue's row for what's playing: it carries the album and each artist's channel.
  const track = usePlayer((s) => {
    const entry = s.queue[s.index]?.track;
    return entry && entry.videoId === s.nowPlaying?.videoId ? entry : null;
  });
  // Apple's animated sleeve over the cover, as the phone's now-playing shows it.
  const motion = useTrackMotion(nowPlaying?.title, nowPlaying?.artist, track?.album?.name);
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const setFullScreen = useUi((s) => s.setFullScreen);
  // The right-hand column: the lyrics, Up Next, or nothing. Lyrics toggle bottom left, Up Next bottom right.
  // Keep Lyrics visible side-by-side when toggled on; never drop lyrics just because a video plays
  const [panel, setPanel] = useState<'lyrics' | 'queue' | null>('lyrics');
  const [volumeOpen, setVolumeOpen] = useState(false);
  const browserFullScreen = useBrowserFullScreen();
  const close = useRef<HTMLButtonElement>(null);
  // Whether this player put the page in the browser's full screen, so closing it leaves it again.
  const enteredBrowserFullScreen = useRef(false);

  // The column follows the toggle alone: whether this track has lyrics, and
  // from which provider, is the panel's own business to say.
  const showLyrics = panel === 'lyrics';
  const showQueue = panel === 'queue';
  const togglePanel = (p: 'lyrics' | 'queue') => {
    setPanel((on) => (on === p ? null : p));
  };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    return () => {
      if (enteredBrowserFullScreen.current && document.fullscreenElement) void document.exitFullscreen();
      opener?.focus({ preventScroll: true });
    };
  }, []);

  // A title, artist or album link went somewhere: get out of the way so the page shows.
  useEffect(() => {
    if (pathname !== openedAt.current) setFullScreen(false);
  }, [pathname, setFullScreen]);

  // Nothing left to show once the queue ends.
  useEffect(() => {
    if (!nowPlaying) setFullScreen(false);
  }, [nowPlaying, setFullScreen]);

  const toggleBrowserFullScreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      // The whole page, not this overlay: menus and dialogs portal to <body> and must stay visible.
      void document.documentElement.requestFullscreen().then(
        () => (enteredBrowserFullScreen.current = true),
        () => undefined,
      );
    }
  };

  if (!nowPlaying) return null;
  const { videoId, title, artist } = nowPlaying;
  const album = track?.album ?? null;
  // With a right-hand column; on narrow windows the video stays visible cleanly above lyrics/queue.
  const column = showLyrics || showQueue;
  const corner = `${chrome} transition-[background-color,color,opacity] duration-300`;

  return (
    <div
      // Over everything but menus and dialogs, which portal above it. The on-dark colours come from tokens.css (data-full-screen).
      // --art, the artwork's side: Apple's 461px at 1440px wide, and never taller than the screen leaves room for.
      className="fixed inset-0 z-[calc(var(--z-contextual-menus)-2)] isolate animate-enter overflow-hidden text-primary [--art:min(32vw,calc(100dvh-330px),520px)] motion-reduce:[animation-name:fade-in] max-md:[--art:min(82vw,calc(100dvh-340px),390px)]"
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      data-full-screen
      data-paused={!playing || undefined}
    >
      <MeshBackdrop artworkUrl={nowPlaying.artworkUrl} playing={playing} />

      {/* Subtle top scrim keeps close and fullscreen chrome legible over mobile top-docked artwork when a column is open */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-1 h-28 bg-gradient-to-b from-black/45 via-black/15 to-transparent transition-opacity duration-300 ${
          column ? 'md:opacity-0' : 'opacity-0'
        }`}
        aria-hidden="true"
      />

      <button ref={close} className={`${corner} top-4 left-5`} aria-label="Close" onClick={() => setFullScreen(false)}>
        <X size={20} />
      </button>
      {document.fullscreenEnabled && (
        <button
          className={`${corner} top-4 right-5`}
          aria-label={browserFullScreen ? 'Exit full screen' : 'Enter full screen'}
          onClick={toggleBrowserFullScreen}
        >
          {browserFullScreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      )}

      {/* Centered square poster card in non-lyrics mode (no viewport zoom), or side-by-side beside Lyrics/Up Next. */}
      <div
        className={
          column
            ? 'grid h-full items-center justify-center gap-x-[clamp(48px,7vw,144px)] px-[clamp(24px,9vw,144px)] py-16 max-md:grid-cols-[minmax(0,1fr)] max-md:grid-rows-[minmax(0,1fr)_auto] max-md:items-stretch max-md:gap-y-3 max-md:px-6 max-md:pt-[min(25dvh,190px)] max-md:pb-18 grid-cols-[var(--art)_minmax(0,38vw)]'
            : 'relative z-1 flex h-full flex-col items-center justify-center px-6 py-14 max-md:px-6 max-md:py-16'
        }
        data-lyrics={column || undefined}
      >
        <section
          className={
            column
              ? 'flex w-(--art) min-w-0 flex-col max-md:order-2 max-md:w-full'
              : 'relative z-1 mx-auto flex w-[max(var(--art),min(100%,320px))] max-w-full min-w-0 flex-col'
          }
          aria-label="Player"
        >
          {/* Poster card: unzoomed centered artwork card when lyrics/queue are closed; beside Lyrics/Up Next when open. */}
          <div
            className={
              column
                ? `max-md:pointer-events-none max-md:fixed max-md:inset-x-0 max-md:top-0 max-md:z-0 max-md:h-[min(30dvh,225px)] max-md:overflow-hidden max-md:[mask-image:linear-gradient(180deg,#000_48%,rgba(0,0,0,0.82)_74%,transparent_100%)] md:relative md:w-(--art) md:aspect-square md:overflow-hidden md:[mask-image:radial-gradient(96%_92%_at_50%_50%,#000_58%,rgba(0,0,0,0.72)_78%,transparent_98%)] md:transition-[scale,filter] md:duration-500 md:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none${
                    playing ? '' : ' md:scale-94'
                  }`
                : `relative mx-auto aspect-square w-(--art) max-w-full overflow-hidden rounded-[var(--radius-artwork-lg)] shadow-[0_24px_64px_rgb(0_0_0/0.46)] artwork-stroke transition-[transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none${
                    playing ? ' scale-100' : ' scale-[0.94]'
                  }`
            }
          >
            {nowPlaying.artworkUrl && (
              <>
                <div
                  className={`pointer-events-none absolute inset-0 -z-1 translate-y-2 scale-96 blur-[24px] saturate-200 opacity-35${
                    column ? ' max-md:hidden' : ''
                  }`}
                >
                  <HeroPoster
                    src={sizedArtwork(nowPlaying.artworkUrl, 60)}
                    className={artworkLayer}
                  />
                </div>
                <HeroPoster
                  src={heroArtwork(nowPlaying.artworkUrl, 7680)}
                  className={artworkLayer}
                />
              </>
            )}
            {/* Apple's motion artwork, cleanly layered above the poster. */}
            {motion && (
              <MotionArtwork
                key={motion.url}
                motion={motion}
                className="absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-600 ease-out data-ready:opacity-100"
                playing={playing}
              />
            )}
          </div>

          <div className="relative z-1 mt-[clamp(16px,2.8vh,26px)] flex items-center gap-3 max-md:mt-3.5">
            {/* As the mini player's: the title opens the album, each credited name its artist. */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <PageLink
                  className={`min-w-0 max-w-full self-start truncate type-[600_17px/22px] ${pageLink}`}
                  href={albumHref(album?.id ?? null)}
                  resolve={() => albumPageFor(videoId, album, [title, artist].filter(Boolean).join(' '))}
                >
                  {title}
                </PageLink>
                {track?.explicit && <ExplicitBadge size={14} />}
              </div>
              <span className="truncate type-title-3 text-secondary">
                {artist && <Credits videoId={videoId} line={artist} artists={track?.artists ?? []} className={pageLink} />}
                {artist && album?.name && ' — '}
                {album?.name && (
                  <PageLink
                    className={pageLink}
                    href={albumHref(album.id ?? null)}
                    resolve={() => albumPageFor(videoId, album, [title, artist].filter(Boolean).join(' '))}
                  >
                    {album.name}
                  </PageLink>
                )}
              </span>
              <NerdStats />
            </div>
            <SleepTimerButton
              className="flex h-8 min-w-8 flex-none items-center justify-center gap-1 rounded-full bg-quinary px-2 text-primary transition-colors hover:bg-quaternary aria-pressed:bg-white/22"
              placement="above-end"
            />
            <FavoriteButton
              videoId={nowPlaying.videoId}
              className="grid size-8 flex-none place-items-center rounded-full bg-quinary text-primary hover:bg-quaternary"
              size={18}
            />
            {track && (
              <TrackMenu
                track={track}
                className="grid size-8 flex-none place-items-center rounded-full bg-quinary text-primary hover:bg-quaternary"
                placement="above-end"
              />
            )}
          </div>

          <Scrubber />
          <Transport />
        </section>

        {showLyrics && (
          <section className="flex min-h-0 animate-fade-in self-stretch" aria-label="Lyrics">
            <LyricsPanel variant="full" />
          </section>
        )}
        {showQueue && (
          // Up Next in the right-hand column: the side panel's list, laid out as a column.
          <section
            className="flex min-h-0 animate-fade-in flex-col self-stretch [mask-image:linear-gradient(180deg,#000_calc(100%-80px),transparent)]"
            aria-label="Up Next"
          >
            <UpNext />
          </section>
        )}
      </div>

      <button
        className={`${corner} bottom-5 left-5 aria-pressed:text-primary`}
        aria-label="Lyrics"
        aria-pressed={showLyrics}
        onClick={() => togglePanel('lyrics')}
      >
        {showLyrics ? <LyricsActiveIcon size={18} /> : <LyricsIcon size={18} />}
      </button>
      {/* Up Next, with the speaker beside it: the level slides in over Up Next, as it does in the pill. */}
      <div
        className="group/actions absolute right-5 bottom-5 z-1 flex items-center [--volume-gap:36px] transition-opacity duration-300"
        data-volume-open={volumeOpen || undefined}
        onPointerLeave={() => setVolumeOpen(false)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVolumeOpen(false);
        }}
      >
        <button
          className={`${chromeButton} ${fadeForVolume} aria-pressed:text-primary`}
          aria-label="Up Next"
          aria-pressed={showQueue}
          onClick={() => togglePanel('queue')}
        >
          <UpNextIcon size={18} />
        </button>
        <VolumeControl open={volumeOpen} onOpen={() => setVolumeOpen(true)} className={chromeButton} iconSize={18} />
      </div>
    </div>
  );
}

import { AudioWaveform, ChevronLeft, ChevronRight, ListEnd, ListPlus, ListStart, Moon, MoreHorizontal, Plus, Star } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Menu, MenuHeader, MenuItem, MenuSeparator, type MenuPlacement } from '@/components/Menu';
import type { PlaylistPrivacy } from '@/data/music/api';
import {
  useAddToPlaylist,
  useCreatePlaylist,
  useLikeStatus,
  usePlaylistOptions,
  useSetLiked,
  useSignedIn,
} from '@/data/music/queries';
import type { Track } from '@/data/music/types';
import { SleepTimerMenuItems, SleepTimerSettingsRowStatus } from '@/shell/SleepTimerMenu';
import { usePlayer } from '@/state/player';

const PRIVACY_OPTIONS: { value: PlaylistPrivacy; label: string }[] = [
  { value: 'PRIVATE', label: 'Private' },
  { value: 'UNLISTED', label: 'Unlisted' },
  { value: 'PUBLIC', label: 'Public' },
];

function CreatePlaylistForm({
  videoId,
  onDone,
  onCancel,
}: {
  videoId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<PlaylistPrivacy>('PRIVATE');
  const create = useCreatePlaylist();
  const trimmed = title.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || create.isPending) return;
    create.mutate(
      { title: trimmed, videoIds: [videoId], privacyStatus },
      { onSuccess: () => onDone() },
    );
  };

  return (
    <form className="flex w-[236px] max-w-full flex-col gap-2.5 p-2" onSubmit={submit}>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Playlist name"
        maxLength={150}
        autoFocus
        aria-label="Playlist name"
        disabled={create.isPending}
        className="w-full rounded-[7px] border border-vibrant-divider bg-quinary px-2.5 py-1.5 text-[13px] text-primary placeholder:text-tertiary focus:border-white/40"
      />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Playlist privacy">
        {PRIVACY_OPTIONS.map((opt) => {
          const active = privacyStatus === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={create.isPending}
              onClick={() => setPrivacyStatus(opt.value)}
              className={`flex-1 rounded-[6px] px-2 py-1 text-[11px] font-medium transition-colors ${
                active ? 'bg-white/22 text-primary' : 'bg-quinary text-secondary hover:bg-quaternary hover:text-primary'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {create.isError && (
        <p className="text-[11px] text-destructive" role="alert">
          Couldn’t create playlist. Try again.
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          disabled={create.isPending}
          onClick={onCancel}
          className="rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-secondary hover:bg-quinary hover:text-primary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!trimmed || create.isPending}
          className="rounded-[6px] bg-white px-3 py-1 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}

function PlaylistChoices({ videoId, onDone, onBack }: { videoId: string; onDone: () => void; onBack: () => void }) {
  const options = usePlaylistOptions(videoId, true);
  const add = useAddToPlaylist();
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <>
        <MenuItem icon={<ChevronLeft size={14} />} onSelect={() => setCreating(false)}>
          Back
        </MenuItem>
        <MenuSeparator />
        <MenuHeader>New Playlist</MenuHeader>
        <CreatePlaylistForm videoId={videoId} onDone={onDone} onCancel={() => setCreating(false)} />
      </>
    );
  }

  return (
    <>
      <MenuItem icon={<ChevronLeft size={14} />} onSelect={onBack}>
        Back
      </MenuItem>
      <MenuSeparator />
      <MenuHeader>Add to Playlist</MenuHeader>
      <MenuItem icon={<Plus size={15} />} onSelect={() => setCreating(true)}>
        Create Playlist…
      </MenuItem>
      <MenuSeparator />
      {options.isPending && (
        <MenuItem disabled onSelect={() => {}}>
          Loading…
        </MenuItem>
      )}
      {options.isError && (
        <MenuItem disabled onSelect={() => {}}>
          Couldn’t load your playlists
        </MenuItem>
      )}
      {options.data?.length === 0 && (
        <MenuItem disabled onSelect={() => {}}>
          No playlists yet
        </MenuItem>
      )}
      {options.data?.map((option) => (
        <MenuItem
          key={option.playlistId}
          onSelect={() => {
            add.mutate({ playlistId: option.playlistId, videoId });
            onDone();
          }}
        >
          {option.title}
        </MenuItem>
      ))}
    </>
  );
}

/** Favorite and Add to Playlist: the account's actions, signed in only. */
function AccountItems({ track, onClose, onPlaylists }: { track: Track; onClose: () => void; onPlaylists: () => void }) {
  const status = useLikeStatus(track.videoId);
  const setLiked = useSetLiked();
  const liked = status.data === 'LIKE';
  return (
    <>
      <MenuSeparator />
      <MenuItem
        icon={<Star size={15} fill={liked ? 'currentColor' : 'none'} />}
        disabled={status.isPending}
        onSelect={() => {
          setLiked.mutate({ videoId: track.videoId, liked: !liked });
          onClose();
        }}
      >
        {liked ? 'Unfavorite' : 'Favorite'}
      </MenuItem>
      <MenuItem icon={<ListPlus size={15} />} trailing={<ChevronRight size={14} />} onSelect={onPlaylists}>
        Add to Playlist
      </MenuItem>
    </>
  );
}

function TrackMenuItems({ track, onClose }: { track: Track; onClose: () => void }) {
  const [view, setView] = useState<'main' | 'playlists' | 'sleep'>('main');
  const signedIn = useSignedIn();
  const sleepStatus = SleepTimerSettingsRowStatus();
  const automix = usePlayer((s) => s.automix);
  if (view === 'playlists') {
    return <PlaylistChoices videoId={track.videoId} onDone={onClose} onBack={() => setView('main')} />;
  }
  if (view === 'sleep') {
    return <SleepTimerMenuItems onClose={onClose} onBack={() => setView('main')} />;
  }
  const { playNext, addToQueue, setAutomix } = usePlayer.getState();
  return (
    <>
      <MenuItem icon={<ListStart size={15} />} onSelect={() => (onClose(), playNext([track]))}>
        Play Next
      </MenuItem>
      <MenuItem icon={<ListEnd size={15} />} onSelect={() => (onClose(), addToQueue([track]))}>
        Add to Queue
      </MenuItem>
      {signedIn && <AccountItems track={track} onClose={onClose} onPlaylists={() => setView('playlists')} />}
      <MenuSeparator />
      <MenuItem
        icon={<AudioWaveform size={15} />}
        checked={automix}
        onSelect={() => {
          setAutomix(!automix);
          onClose();
        }}
      >
        AutoMix
      </MenuItem>
      <MenuItem
        icon={<Moon size={15} />}
        trailing={
          <span className="inline-flex items-center gap-1 text-[11px]">
            {sleepStatus !== 'Off' ? sleepStatus : null}
            <ChevronRight size={14} />
          </span>
        }
        onSelect={() => setView('sleep')}
      >
        Sleep Timer
      </MenuItem>
    </>
  );
}

/**
 * The ⋯ button at the end of a track row (report §14): Play Next and Add to
 * Queue for everyone; Favorite and Add to Playlist signed in.
 */
export function TrackMenu({
  track,
  className,
  placement,
  onOpenChange,
}: {
  track: Track;
  className?: string;
  /** Where the menu opens from the button; the player's sit at the bottom of the window. */
  placement?: MenuPlacement;
  /** Told when the menu opens and closes; most mounts don't need to know. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => {
    onOpenChange?.(anchor !== null);
  }, [anchor, onOpenChange]);
  return (
    <>
      <button
        className={className}
        aria-label={`More options for ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-open={anchor !== null || undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(anchor ? null : event.currentTarget);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal size={18} strokeWidth={2} />
      </button>
      {anchor && (
        <Menu anchor={anchor} placement={placement} onClose={close} label={track.title}>
          <TrackMenuItems track={track} onClose={close} />
        </Menu>
      )}
    </>
  );
}

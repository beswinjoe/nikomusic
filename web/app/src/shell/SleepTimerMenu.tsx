import { Check, ChevronLeft, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Menu, MenuHeader, MenuItem, MenuSeparator, type MenuPlacement } from '@/components/Menu';
import {
  formatSleepRemaining,
  SLEEP_MAX_MINUTES,
  SLEEP_PRESETS,
  SLEEP_STEP_MINUTES,
  sleepFractionOf,
  sleepMinutesAt,
  useSleepTimer,
} from '@/playback/sleepTimer';

function useSleepRemainingMs(): number | null {
  const deadlineMs = useSleepTimer((s) => s.deadlineMs);
  const [remaining, setRemaining] = useState<number | null>(() =>
    deadlineMs === null ? null : Math.max(0, deadlineMs - Date.now()),
  );

  useEffect(() => {
    if (deadlineMs === null) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(Math.max(0, deadlineMs - Date.now()));
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [deadlineMs]);

  return remaining;
}

function formatDurationMinutes(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins} minutes`;
  if (mins === 0) return hrs === 1 ? '1 hour' : `${hrs} hours`;
  return `${hrs} hr ${mins} min`;
}

export function SleepTimerMenuItems({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack?: () => void;
}) {
  const { minutes, afterTrack, fadeOut, start, startAfterTrack, cancel, setFadeOut } = useSleepTimer();
  const remainingMs = useSleepRemainingMs();
  const [customView, setCustomView] = useState(false);
  const [customMinutes, setCustomMinutes] = useState<number>(() =>
    minutes && !(SLEEP_PRESETS as readonly number[]).includes(minutes) ? minutes : 90,
  );
  const running = remainingMs !== null || afterTrack;

  if (customView) {
    return (
      <>
        <MenuItem icon={<ChevronLeft size={14} />} onSelect={() => setCustomView(false)}>
          Back
        </MenuItem>
        <MenuSeparator />
        <MenuHeader>Custom Sleep Timer</MenuHeader>
        <div className="flex flex-col gap-2 px-2.5 py-2">
          <div className="flex items-center justify-between type-subhead-emphasized text-primary tabular-nums">
            <span>Duration</span>
            <span>{formatDurationMinutes(customMinutes)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={1 / ((SLEEP_MAX_MINUTES - SLEEP_STEP_MINUTES) / SLEEP_STEP_MINUTES)}
            value={sleepFractionOf(customMinutes)}
            aria-label="Custom sleep timer duration"
            onChange={(e) => setCustomMinutes(sleepMinutesAt(parseFloat(e.target.value)))}
            className="w-full accent-white"
          />
          <button
            type="button"
            className="mt-1 rounded-[7px] bg-white/15 px-3 py-1.5 text-center type-subhead-emphasized text-primary transition-colors hover:bg-white/25"
            onClick={() => {
              start(customMinutes);
              onClose();
            }}
          >
            Start Timer
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {onBack && (
        <>
          <MenuItem icon={<ChevronLeft size={14} />} onSelect={onBack}>
            Back
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuHeader>
        {afterTrack
          ? 'Pausing after current track'
          : remainingMs !== null
            ? `Pausing in ${formatSleepRemaining(remainingMs)}`
            : 'Sleep Timer'}
      </MenuHeader>
      <MenuItem
        checked={afterTrack}
        onSelect={() => {
          startAfterTrack();
          onClose();
        }}
      >
        End of Current Track
      </MenuItem>
      <MenuSeparator />
      {SLEEP_PRESETS.map((preset) => (
        <MenuItem
          key={preset}
          checked={!afterTrack && minutes === preset}
          onSelect={() => {
            start(preset);
            onClose();
          }}
        >
          {preset} minutes
        </MenuItem>
      ))}
      <MenuItem
        checked={!afterTrack && minutes !== null && !(SLEEP_PRESETS as readonly number[]).includes(minutes)}
        trailing={
          !afterTrack && minutes !== null && !(SLEEP_PRESETS as readonly number[]).includes(minutes)
            ? formatDurationMinutes(minutes)
            : undefined
        }
        onSelect={() => setCustomView(true)}
      >
        Custom…
      </MenuItem>
      <MenuSeparator />
      <MenuItem checked={fadeOut} onSelect={() => setFadeOut(!fadeOut)}>
        Fade Out Audio (30s)
      </MenuItem>
      {running && (
        <>
          <MenuSeparator />
          <MenuItem
            destructive
            onSelect={() => {
              cancel();
              onClose();
            }}
          >
            Turn Off Timer
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * Full-screen player button opening the Sleep Timer popover; displays live remaining countdown when active.
 */
export function SleepTimerButton({
  className,
  placement = 'above-end',
}: {
  className?: string;
  placement?: MenuPlacement;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const afterTrack = useSleepTimer((s) => s.afterTrack);
  const remainingMs = useSleepRemainingMs();
  const active = afterTrack || remainingMs !== null;

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={
          afterTrack
            ? 'Sleep timer: pause at end of track'
            : remainingMs !== null
              ? `Sleep timer: ${formatSleepRemaining(remainingMs)} remaining`
              : 'Sleep Timer'
        }
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-pressed={active}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget);
        }}
      >
        <Moon size={16} fill={active ? 'currentColor' : 'none'} />
        {active && (
          <span className="text-[11px] leading-none font-semibold tabular-nums">
            {afterTrack ? 'End' : formatSleepRemaining(remainingMs ?? 0)}
          </span>
        )}
      </button>
      {anchor && (
        <Menu anchor={anchor} placement={placement} onClose={() => setAnchor(null)} label="Sleep Timer">
          <SleepTimerMenuItems onClose={() => setAnchor(null)} />
        </Menu>
      )}
    </>
  );
}

export function SleepTimerSettingsRowStatus(): string {
  const afterTrack = useSleepTimer((s) => s.afterTrack);
  const remainingMs = useSleepRemainingMs();
  if (afterTrack) return 'End of track';
  if (remainingMs !== null) return `${formatSleepRemaining(remainingMs)} left`;
  return 'Off';
}

export { Check };

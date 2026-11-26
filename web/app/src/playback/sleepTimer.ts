import { create } from 'zustand';

/** Fixed duration presets offered in the Sleep Timer picker (matching Android SleepTimer.kt). */
export const SLEEP_PRESETS = [15, 30, 45, 60] as const;

export const SLEEP_STEP_MINUTES = 5;
export const SLEEP_MAX_MINUTES = 720;
export const SLEEP_FADE_DURATION_MS = 30_000;

const STORAGE_KEY = 'nikomusic:sleepTimer';

function loadFadeOutPreference(): boolean {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { fadeOut?: boolean };
    return parsed.fadeOut !== false;
  } catch {
    return true;
  }
}

function saveFadeOutPreference(fadeOut: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fadeOut }));
    }
  } catch {
    // Ignore storage quota / restricted context errors
  }
}

export function sleepMinutesAt(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const raw = SLEEP_STEP_MINUTES + clamped * (SLEEP_MAX_MINUTES - SLEEP_STEP_MINUTES);
  return Math.round(raw / SLEEP_STEP_MINUTES) * SLEEP_STEP_MINUTES;
}

export function sleepFractionOf(minutes: number): number {
  return (minutes - SLEEP_STEP_MINUTES) / (SLEEP_MAX_MINUTES - SLEEP_STEP_MINUTES);
}

/**
 * Computes linear volume attenuation (0.0..1.0) during the final 30 seconds before timer expiry.
 */
export function calculateSleepFadeVolume(
  remainingMs: number,
  fadeOutEnabled: boolean,
  fadeDurationMs = SLEEP_FADE_DURATION_MS,
): number {
  if (!fadeOutEnabled || remainingMs >= fadeDurationMs) return 1;
  if (remainingMs <= 0 || fadeDurationMs <= 0) return 0;
  return Math.max(0, Math.min(1, remainingMs / fadeDurationMs));
}

export function formatSleepRemaining(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface SleepTimerState {
  /** Monotonic wall deadline (`Date.now()`) when timed sleep stops, or null when inactive. */
  deadlineMs: number | null;
  /** Selected duration in minutes (preset or custom), or null when inactive / after-track. */
  minutes: number | null;
  /** True when set to pause after the currently playing track finishes. */
  afterTrack: boolean;
  /** Fade volume smoothly over the final 30 seconds before pausing. */
  fadeOut: boolean;
  start: (minutes: number) => void;
  startAfterTrack: () => void;
  cancel: () => void;
  setFadeOut: (fadeOut: boolean) => void;
}

export const useSleepTimer = create<SleepTimerState>()((set) => ({
  deadlineMs: null,
  minutes: null,
  afterTrack: false,
  fadeOut: loadFadeOutPreference(),

  start(minutes) {
    const clean = Math.max(1, Math.min(SLEEP_MAX_MINUTES, Math.round(minutes)));
    set({
      deadlineMs: Date.now() + clean * 60_000,
      minutes: clean,
      afterTrack: false,
    });
  },

  startAfterTrack() {
    set({
      deadlineMs: null,
      minutes: null,
      afterTrack: true,
    });
  },

  cancel() {
    set({
      deadlineMs: null,
      minutes: null,
      afterTrack: false,
    });
  },

  setFadeOut(fadeOut) {
    saveFadeOutPreference(fadeOut);
    set({ fadeOut });
  },
}));

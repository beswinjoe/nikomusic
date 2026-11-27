// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ./NOTICE.md in playback/automix.

import type { TrackAnalysis, VocalWindow } from '../analysis/types';
import type { Deck } from './deck';
import { gridOf, phraseAtOrBefore, phraseAtOrAfter, downbeatAtOrAfter, BEATS_PER_BAR, type Grid } from './grid';

export interface TransitionRequest {
  from: Deck;
  to: Deck;
  fromAnalysis: TrackAnalysis;
  toAnalysis: TrackAnalysis;
  /** Blend length in bars (of the outgoing track's tempo). */
  bars: number;
  /** Start at the outgoing track's next downbeat instead of its natural mix-out point. */
  forceNow?: boolean;
}

export interface TransitionPlan {
  /** AudioContext time the blend starts. */
  t0: number;
  /** Blend duration in seconds (output time). */
  durationSec: number;
  /** Incoming track position at t0. */
  mixInTrackTime: number;
  /** Outgoing track position at t0. */
  mixOutTrackTime: number;
  /** Rate the incoming deck plays at during the blend. */
  rate: number;
  /** True when grids were unusable and a plain crossfade was scheduled. */
  fallback: boolean;
  /**
   * NikoMusic: how the blend is played. 'blend' is AutoMix's beatmatch;
   * 'filter' the phone's DJ_FILTER for a pair that can't be beatmatched;
   * 'crossfade' AutoMix's fallback.
   */
  style: 'blend' | 'filter' | 'crossfade' | 'loop';
  /** NikoMusic: why a pair wasn't beatmatched, for stats for nerds. */
  reason: string | null;
}

/** Snapshot of the planned mix timing & cue points (for both seek-bar preview and scheduling). */
export interface PlannedMixTiming {
  style: 'blend' | 'filter' | 'crossfade';
  mixOutTrackTime: number;
  mixInTrackTime: number;
  durationSec: number;
  blendInputSec: number;
  rate: number;
  beatSec: number | null;
  reason: string | null;
}

// Below this, a beat-lock is more likely confidently WRONG than right (a
// 0.17 grid locked precisely off-beat) — a clean crossfade beats a bad
// beatmatch. 0.3 proved too aggressive on loose lofi (every mix fell back);
// 0.2-0.45 grids now beatmatch but only for the short 4-bar tier, so a
// wrong lock costs ~11s, not a 46s blend.
export const MIN_GRID_CONFIDENCE = 0.2;
// Bass swap depth: full on long blends with room for it; gentle on short
// blends so piano-led lows aren't gutted but the cross is still audible.
const KILL_DB = -12;
const SHORT_BLEND_KILL_DB = -6;
const FULL_SWAP_MIN_BARS = 8;

/** Trailing outgoing zone (in seconds) within which AutoMix places its mix-out. */
const OUTGOING_MIX_WINDOW_SEC = 28;
/** Minimum intro/play time preserved on normal-length outgoing tracks. */
const MIN_OUTGOING_CLEARANCE_SEC = 10;
/** Incoming cues never skip past this many seconds or this fraction of the incoming song. */
const MAX_INCOMING_CUE_SEC = 20;
const MAX_INCOMING_SKIP_FRACTION = 0.22;

/** Wall-clock caps so slow tracks or large bar settings never sound "overly mixed". */
const MIN_BLEND_SEC = 5;
const MAX_BLEND_SHORT_SEC = 10;
const MAX_BLEND_STANDARD_SEC = 14;
const MAX_BLEND_CALM_SEC = 16;
const MAX_FILTER_SEC = 10;
const FALLBACK_CROSSFADE_SEC = 8;
const VOCAL_ACTIVE = 0.3;
const VOCAL_CLASH_THRESHOLD = 0.25;

/**
 * Confidence-scaled blend length: the UI's bar count is a MAX, not a command.
 * Long overlaps are a house/techno assumption — two melodic tracks over a
 * shaky grid for 46s is mush, so weaker grids get shorter blends.
 */
export function effectiveBlendBars(
  requestedBars: number,
  fromConfidence: number,
  toConfidence: number,
): number {
  const conf = Math.min(fromConfidence, toConfidence);
  if (conf >= 0.6) return Math.min(requestedBars, 16);
  if (conf >= 0.45) return Math.min(requestedBars, 8);
  return Math.min(requestedBars, 4);
}

/**
 * Effective outro / content end on [analysis], guarded against premature
 * mid-track detection so a song is never chopped in half.
 */
export function effectiveContentEnd(analysis: TrackAnalysis): number {
  const dur = Math.max(0, analysis.durationSec);
  if (dur <= 0) return 0;
  const minOutro = dur >= 45 ? Math.max(dur * 0.72, dur - 32) : dur * 0.65;
  let end = analysis.outroStartSec !== null && Number.isFinite(analysis.outroStartSec)
    ? Math.max(minOutro, Math.min(dur, analysis.outroStartSec))
    : dur;
  // Trim genuine dead silence at the very end if an energy curve is available.
  const curve = analysis.energyCurve;
  if (curve.length >= 6) {
    const step = dur / curve.length;
    let i = curve.length - 1;
    while (i > Math.floor((minOutro / dur) * curve.length) && curve[i]! < 0.08) i--;
    const activeEnd = Math.min(dur, (i + 1) * step);
    if (activeEnd < end && dur - activeEnd <= 12) end = Math.max(minOutro, activeEnd);
  }
  return end;
}

function vocalFraction(vocals: VocalWindow[] | undefined, fromSec: number, toSec: number): number | null {
  if (!vocals?.length || toSec <= fromSec) return null;
  let total = 0;
  let sung = 0;
  for (const w of vocals) {
    const a = Math.max(0, Math.ceil((fromSec - w.startSec) * w.fps));
    const b = Math.min(w.curve.length, Math.floor((toSec - w.startSec) * w.fps));
    for (let i = a; i < b; i++) {
      total++;
      if ((w.curve[i] ?? 0) > VOCAL_ACTIVE) sung++;
    }
  }
  return total >= 4 ? sung / total : null;
}

function simultaneousVocalOverlap(
  fromAnalysis: TrackAnalysis,
  toAnalysis: TrackAnalysis,
  outStart: number,
  inStart: number,
  durationSec: number,
  rate: number,
): number {
  if (!fromAnalysis.vocals?.length || !toAnalysis.vocals?.length || durationSec <= 0) return 0;
  const steps = Math.max(4, Math.round(durationSec / 0.25));
  let covered = 0;
  let both = 0;
  const sampleAt = (vocals: VocalWindow[], t: number): number | null => {
    for (const w of vocals) {
      const idx = Math.round((t - w.startSec) * w.fps);
      if (idx >= 0 && idx < w.curve.length) return w.curve[idx] ?? 0;
    }
    return null;
  };
  for (let s = 0; s < steps; s++) {
    const dt = ((s + 0.5) / steps) * durationSec;
    const ov = sampleAt(fromAnalysis.vocals, outStart + dt);
    const iv = sampleAt(toAnalysis.vocals, inStart + dt * rate);
    if (ov === null || iv === null) continue;
    covered++;
    if (ov > VOCAL_ACTIVE && iv > VOCAL_ACTIVE) both++;
  }
  return covered >= 4 ? both / covered : 0;
}

function energyBetween(curve: number[], durationSec: number, fromSec: number, toSec: number): number | null {
  if (!curve.length || durationSec <= 0 || toSec <= fromSec) return null;
  const a = Math.max(0, Math.floor((fromSec / durationSec) * curve.length));
  const b = Math.min(curve.length, Math.ceil((toSec / durationSec) * curve.length));
  if (b <= a) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += curve[i] ?? 0;
  return sum / (b - a);
}

/**
 * Pick whole-bar blend length within [maxSec], returning whole musical bars
 * ([8, 6, 4, 2, 1]) so the mix stays crisp (~6-15 s) instead of dragging on.
 */
function pickMusicalBars(requestedMaxBars: number, barOutSec: number, maxSec: number, minBars = 2): number {
  const maxByTime = Math.max(1, Math.floor(maxSec / barOutSec));
  const limit = Math.min(requestedMaxBars, maxByTime);
  for (const tier of [8, 6, 4, 2, 1]) {
    if (tier <= limit && tier >= minBars && tier * barOutSec <= maxSec + 0.25) return tier;
  }
  return Math.max(1, Math.min(limit, Math.max(minBars, Math.floor(MIN_BLEND_SEC / barOutSec))));
}

/**
 * Scores bar-aligned candidate mix-out points inside the trailing mix window
 * (~10-28 s before the track ends) to land on a suitable low-vocal / phrase-end spot.
 */
function chooseSuitableMixOut(
  fromAnalysis: TrackAnalysis,
  grid: Grid,
  contentEnd: number,
  blendInputSec: number,
  outRate: number,
): number {
  const dur = fromAnalysis.durationSec;
  const minClearance = dur >= 45 ? Math.max(MIN_OUTGOING_CLEARANCE_SEC, dur * 0.72, dur - OUTGOING_MIX_WINDOW_SEC) : dur * 0.55;
  const tailMargin = Math.min(grid.barSec, 1.8);
  const rawLatest = Math.min(contentEnd - blendInputSec, dur - blendInputSec - tailMargin);
  const clampedLatest = Math.min(Math.max(minClearance, rawLatest), dur - Math.min(blendInputSec, Math.max(4, dur * 0.4)) - 0.3);
  if (clampedLatest <= minClearance + grid.barSec) {
    return Math.max(minClearance, clampedLatest);
  }

  const phraseAnchor = phraseAtOrBefore(grid, rawLatest);
  const candidates = new Set<number>();
  if (phraseAnchor >= minClearance && phraseAnchor <= clampedLatest + 0.2) {
    candidates.add(Math.min(phraseAnchor, clampedLatest));
  }
  const firstBar = downbeatAtOrAfter(grid, minClearance);
  for (let t = firstBar; t <= clampedLatest + 0.05; t += grid.barSec) {
    candidates.add(t);
  }
  candidates.add(clampedLatest);

  let bestTime = phraseAnchor >= minClearance && phraseAnchor <= clampedLatest ? phraseAnchor : clampedLatest;
  let bestScore = -Infinity;
  const phraseStep = grid.phraseSec;

  for (const cand of candidates) {
    const end = Math.min(dur, cand + blendInputSec);
    if (end - cand < Math.min(blendInputSec * 0.65, 4)) continue;
    let score = 0;

    // 1. Prefer points where outgoing vocals ease off or pause.
    const sung = vocalFraction(fromAnalysis.vocals, cand, end);
    if (sung !== null) score += (1 - sung) * 3.8;

    // 2. Reward natural post-chorus / outro energy drops entering the blend window.
    const eBefore = energyBetween(fromAnalysis.energyCurve, dur, Math.max(0, cand - blendInputSec), cand);
    const eInside = energyBetween(fromAnalysis.energyCurve, dur, cand, end);
    if (eBefore !== null && eInside !== null && eBefore > 0.05) {
      const drop = Math.max(0, (eBefore - eInside) / eBefore);
      score += drop * 1.6;
    }

    // 3. Phrase boundary alignment keeps musical structure clean.
    const phrasePhase = Math.abs((((cand - grid.downbeatSec) % phraseStep) + phraseStep) % phraseStep);
    if (phrasePhase < grid.barSec * 0.6 || phraseStep - phrasePhase < grid.barSec * 0.6) {
      score += 0.85;
    }

    // 4. Gently prefer closer to content end (~12-22 s before end) unless an earlier spot is meaningfully cleaner.
    score -= Math.max(0, clampedLatest - cand) * 0.065;

    if (score > bestScore) {
      bestScore = score;
      bestTime = cand;
    }
  }
  void outRate;
  return bestTime;
}

/**
 * Compute the planned AutoMix transition window & cue points cleanly for any track pair.
 * Shared between `AutoDJ.timeToMixOut` (bar highlight) and `scheduleTransition` (audio clock).
 */
export function planMixWindowTiming(params: {
  fromAnalysis: TrackAnalysis;
  toAnalysis: TrackAnalysis | null;
  requestedBars: number;
  outRate: number;
}): PlannedMixTiming {
  const { fromAnalysis, toAnalysis, requestedBars, outRate } = params;
  const fromGrid = gridOf(fromAnalysis);
  const toGrid = toAnalysis ? gridOf(toAnalysis) : null;
  const contentEnd = effectiveContentEnd(fromAnalysis);

  if (fromGrid === null || fromAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) {
    const room = Math.max(2, contentEnd);
    const durationSec = Math.min(FALLBACK_CROSSFADE_SEC, room * 0.45);
    const minOut = fromAnalysis.durationSec >= 45
      ? Math.max(MIN_OUTGOING_CLEARANCE_SEC, fromAnalysis.durationSec * 0.72, fromAnalysis.durationSec - OUTGOING_MIX_WINDOW_SEC)
      : fromAnalysis.durationSec * 0.55;
    const mixOutTrackTime = Math.max(minOut, contentEnd - durationSec);
    const maxCue = toAnalysis ? Math.min(6, toAnalysis.durationSec * MAX_INCOMING_SKIP_FRACTION) : 0;
    const mixInTrackTime = toAnalysis ? Math.min(toAnalysis.introEndSec ?? 0, maxCue) : 0;
    return {
      style: 'crossfade',
      mixOutTrackTime,
      mixInTrackTime,
      durationSec,
      blendInputSec: durationSec,
      rate: 1,
      beatSec: null,
      reason: 'this song has no beat grid at its end',
    };
  }

  const effectiveFromBpm = fromGrid.bpm * outRate;
  const barOutSec = (BEATS_PER_BAR * 60) / effectiveFromBpm;
  const safeToDur = toAnalysis?.durationSec ?? 180;
  const maxIncomingCue = Math.min(MAX_INCOMING_CUE_SEC, safeToDur * MAX_INCOMING_SKIP_FRACTION);

  let rate = 1;
  let beatMatched = false;
  let reason: string | null = null;
  if (!toAnalysis || !toGrid || toAnalysis.gridConfidence < MIN_GRID_CONFIDENCE) {
    reason = 'next song has no beat grid';
  } else {
    const rawRate = effectiveFromBpm / toGrid.bpm;
    rate = [rawRate, rawRate / 2, rawRate * 2].reduce((best, r) => (Math.abs(r - 1) < Math.abs(best - 1) ? r : best));
    if (!stretchAllowed(rate)) {
      reason = `tempos ${Math.round(Math.abs(rate - 1) * 100)}% apart`;
      rate = 1;
    } else {
      beatMatched = true;
    }
  }

  if (!beatMatched) {
    const bars = pickMusicalBars(Math.min(requestedBars, 6), barOutSec, MAX_FILTER_SEC, 2);
    const durationSec = Math.min(bars * barOutSec, Math.max(4, (fromAnalysis.durationSec - 0.3) * 0.4));
    const blendInputSec = durationSec * outRate;
    const mixOutTrackTime = chooseSuitableMixOut(fromAnalysis, fromGrid, contentEnd, blendInputSec, outRate);
    const mixInTrackTime =
      toGrid && toAnalysis ? Math.min(maxIncomingCue, toGrid.downbeatSec) : toAnalysis ? Math.min(2, toAnalysis.introEndSec ?? 0) : 0;
    return {
      style: 'filter',
      mixOutTrackTime,
      mixInTrackTime,
      durationSec,
      blendInputSec,
      rate: 1,
      beatSec: fromGrid.beatSec / outRate,
      reason,
    };
  }

  const confBars = effectiveBlendBars(requestedBars, fromAnalysis.gridConfidence, toAnalysis!.gridConfidence);
  const calmCap = requestedBars >= 16 ? MAX_BLEND_CALM_SEC : MAX_BLEND_STANDARD_SEC;
  const maxForDuration = fromAnalysis.durationSec < 45 ? Math.max(3, (fromAnalysis.durationSec - 0.5) * 0.35) : calmCap;
  let bars = pickMusicalBars(confBars, barOutSec, Math.min(calmCap, maxForDuration), fromAnalysis.durationSec < 45 ? 1 : 2);
  let durationSec = bars * barOutSec;
  let blendInputSec = durationSec * outRate;
  let mixOutTrackTime = chooseSuitableMixOut(fromAnalysis, fromGrid, contentEnd, blendInputSec, outRate);

  const introEnd = Math.min(toAnalysis!.introEndSec ?? 0, maxIncomingCue);
  const fullEnergyPhrase = phraseAtOrAfter(toGrid!, Math.max(introEnd, toGrid!.downbeatSec));
  let mixInTrackTime = fullEnergyPhrase - durationSec * rate;
  if (mixInTrackTime > maxIncomingCue) {
    const barIn = toGrid!.barSec;
    mixInTrackTime = Math.max(0, downbeatAtOrAfter(toGrid!, maxIncomingCue - barIn));
  }
  if (mixInTrackTime < toGrid!.downbeatSec) mixInTrackTime = toGrid!.downbeatSec;

  // Shrink slightly if vocals on both tracks compete during the overlap, and retry
  // a compact single-bar transition if heavy vocal overlap still persists.
  let clash = simultaneousVocalOverlap(fromAnalysis, toAnalysis!, mixOutTrackTime, mixInTrackTime, durationSec, rate);
  if (clash >= VOCAL_CLASH_THRESHOLD && durationSec > MAX_BLEND_SHORT_SEC) {
    bars = pickMusicalBars(confBars, barOutSec, MAX_BLEND_SHORT_SEC, 2);
    durationSec = bars * barOutSec;
    blendInputSec = durationSec * outRate;
    mixOutTrackTime = chooseSuitableMixOut(fromAnalysis, fromGrid, contentEnd, blendInputSec, outRate);
    mixInTrackTime = Math.min(maxIncomingCue, Math.max(toGrid!.downbeatSec, fullEnergyPhrase - durationSec * rate));
    clash = simultaneousVocalOverlap(fromAnalysis, toAnalysis!, mixOutTrackTime, mixInTrackTime, durationSec, rate);
  }
  if (clash >= VOCAL_CLASH_THRESHOLD && durationSec > Math.max(4, barOutSec)) {
    const minimalSec = Math.min(durationSec, Math.max(4, barOutSec));
    durationSec = minimalSec;
    blendInputSec = durationSec * outRate;
    mixOutTrackTime = chooseSuitableMixOut(fromAnalysis, fromGrid, contentEnd, blendInputSec, outRate);
    mixInTrackTime = Math.min(maxIncomingCue, Math.max(toGrid!.downbeatSec, fullEnergyPhrase - durationSec * rate));
  }

  return {
    style: 'blend',
    mixOutTrackTime,
    mixInTrackTime,
    durationSec,
    blendInputSec,
    rate,
    beatSec: fromGrid.beatSec / outRate,
    reason: null,
  };
}

/**
 * Schedule a phrase-aligned DJ blend on the Web Audio clock:
 * - incoming starts at its pre-full-energy phrase boundary, stretched to the
 *   outgoing tempo (capped to avoid long muddied overlaps)
 * - equal-power gain cross over the window
 * - bass swap over 1 bar at the midpoint, gentle high-shelf cross over the window
 * - outgoing stops at the end; incoming glides back to rate 1
 */
export function scheduleTransition(req: TransitionRequest): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis, bars, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const earliest = now + Math.max(from.scheduleAhead, to.scheduleAhead) + 0.1;

  const fromGrid = gridOf(fromAnalysis);
  const outRate = from.timeline.rateAt(now) || 1;
  const timing = planMixWindowTiming({
    fromAnalysis,
    toAnalysis,
    requestedBars: bars,
    outRate,
  });

  if (timing.style === 'crossfade' || fromGrid === null) {
    return scheduleFallback(req, earliest, timing.reason, timing.mixInTrackTime, timing.durationSec);
  }
  if (timing.style === 'filter') {
    const toGrid = gridOf(toAnalysis);
    return scheduleFilterMix(req, earliest, fromGrid, toGrid, timing);
  }

  const effectiveFromBpm = fromGrid.bpm * outRate;
  const barOutSec = BEATS_PER_BAR * (60 / effectiveFromBpm);
  const effBars = Math.max(1, Math.round(timing.durationSec / barOutSec));
  const durationSec = timing.durationSec;
  const rate = timing.rate;

  // --- outgoing mix-out point (track time) ---
  let mixOutTrackTime = timing.mixOutTrackTime;
  const fromPos = from.expectedTrackTime ?? 0;
  if (forceNow) {
    const earliestTrack = from.timeline.trackTimeAt(earliest) ?? fromPos;
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, earliestTrack);
  } else if (mixOutTrackTime < fromPos - 0.5) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  }

  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest, null, timing.mixInTrackTime, Math.min(FALLBACK_CROSSFADE_SEC, durationSec));
  }

  const mixInTrackTime = timing.mixInTrackTime;

  // --- schedule transport ---
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate });
  from.pauseAt(t0 + durationSec + 0.05);

  // --- gains: equal-power cross ---
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);

  // --- EQ: bass swap at midpoint over 1 bar, highs cross the whole window ---
  const swapDb = effBars >= FULL_SWAP_MIN_BARS ? KILL_DB : SHORT_BLEND_KILL_DB;
  const mid = t0 + durationSec / 2;
  to.eq.setGainAt('low', swapDb, t0 - 0.02);
  from.eq.rampGain('low', 0, swapDb, mid - barOutSec / 2, barOutSec);
  to.eq.rampGain('low', swapDb, 0, mid - barOutSec / 2, barOutSec);
  from.eq.rampGain('high', 0, -8, t0, durationSec);
  to.eq.setGainAt('high', -8, t0 - 0.02);
  to.eq.rampGain('high', -8, 0, t0, durationSec);

  // --- after the blend: outgoing cleanup + incoming rate glide to 1 ---
  const tEnd = t0 + durationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => {
    from.eq.reset();
    from.setVolume(1);
  });
  glideRateToUnity(to, rate, tEnd);

  return { t0, durationSec, mixInTrackTime, mixOutTrackTime, rate, fallback: false, style: 'blend', reason: null };
}

/**
 * NikoMusic: the bars the scheduler will use for this pair, so callers
 * match the capped, clarity-focused AutoMix length.
 */
export function plannedBars(
  requestedBars: number,
  fromAnalysis: TrackAnalysis,
  toAnalysis: TrackAnalysis | null,
  outRate: number,
): number {
  const fromGrid = gridOf(fromAnalysis);
  if (!fromGrid) return Math.min(requestedBars, 4);
  const barOutSec = fromGrid.barSec / outRate;
  const timing = planMixWindowTiming({ fromAnalysis, toAnalysis, requestedBars, outRate });
  return Math.max(1, Math.round(timing.durationSec / barOutSec));
}

/**
 * NikoMusic: how far the element blend may stretch the incoming song (the
 * user's call, 2026-10-23; the phone's STRETCH_WINDOW is 0.9..1.1). [rate] is
 * the incoming song's playback rate, outgoing BPM over incoming BPM:
 * - below 1, the incoming song is slowed down: at most 10%;
 * - above 1, it is sped up: at most 25%.
 * The loop mix ramps any gap; this is for the blend it falls back on.
 */
export function stretchAllowed(rate: number): boolean {
  return rate >= 1 ? rate - 1 <= MAX_SPEED_UP : 1 - rate <= MAX_SLOW_DOWN;
}
const MAX_SLOW_DOWN = 0.1;
const MAX_SPEED_UP = 0.25;

/**
 * NikoMusic, after the phone's DJ_FILTER (TransitionPlanner.kt): a pair that
 * can't be beatmatched still mixes on the outgoing track's phrase. The
 * incoming track starts on its own downbeat cleanly aligned on the outgoing one's,
 * at its own tempo, low-passed; the outgoing track drains away through a
 * rising high-pass; the bass hands over in one bar at the midpoint.
 */
function scheduleFilterMix(
  req: TransitionRequest,
  earliest: number,
  fromGrid: NonNullable<ReturnType<typeof gridOf>>,
  _toGrid: ReturnType<typeof gridOf>,
  timing: PlannedMixTiming,
): TransitionPlan {
  const { from, to, fromAnalysis, forceNow } = req;
  const ctx = from.ctx;
  const now = ctx.currentTime;
  const outRate = from.timeline.rateAt(now) || 1;
  const barOutSec = fromGrid.barSec / outRate;
  let durationSec = timing.durationSec;
  let blendInputSec = timing.blendInputSec;

  const fromPos = from.expectedTrackTime ?? 0;
  let mixOutTrackTime = timing.mixOutTrackTime;
  if (forceNow) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  } else if (mixOutTrackTime < fromPos - 0.5) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
  }
  let t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
  if (t0 === null || t0 < earliest) {
    mixOutTrackTime = downbeatAtOrAfter(fromGrid, from.timeline.trackTimeAt(earliest) ?? fromPos);
    t0 = from.timeline.ctxTimeAt(mixOutTrackTime, now);
    if (t0 === null) return scheduleFallback(req, earliest, timing.reason, timing.mixInTrackTime, FALLBACK_CROSSFADE_SEC);
  }

  // never past the outgoing track's end: shorten to the bars that still fit
  const room = fromAnalysis.durationSec - 0.3 - mixOutTrackTime;
  if (blendInputSec > room) {
    const fitBars = Math.max(1, Math.floor(room / fromGrid.barSec));
    durationSec = fitBars * barOutSec;
    blendInputSec = durationSec * outRate;
  }

  const mixInTrackTime = timing.mixInTrackTime;
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: 1 });
  from.pauseAt(t0 + durationSec + 0.05);
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);

  // filters: outgoing high-pass rises, incoming low-pass opens
  const hp = from.sweep.highpass.frequency;
  const lp = to.sweep.lowpass.frequency;
  hp.cancelScheduledValues(t0 - 0.03);
  lp.cancelScheduledValues(t0 - 0.03);
  hp.setValueAtTime(FILTER_OPEN_LOW_HZ, t0);
  hp.exponentialRampToValueAtTime(FILTER_HP_END_HZ, t0 + durationSec);
  lp.setValueAtTime(FILTER_LP_START_HZ, t0 - 0.02);
  lp.exponentialRampToValueAtTime(FILTER_OPEN_HIGH_HZ, t0 + durationSec);

  // bass hands over in one bar at the midpoint
  const mid = t0 + durationSec / 2;
  to.eq.setGainAt('low', KILL_DB, t0 - 0.02);
  from.eq.rampGain('low', 0, KILL_DB, mid - barOutSec / 2, barOutSec);
  to.eq.rampGain('low', KILL_DB, 0, mid - barOutSec / 2, barOutSec);

  const tEnd = t0 + durationSec;
  scheduleAfter(ctx, tEnd + 0.2, () => {
    from.eq.reset();
    from.resetSweep();
    to.resetSweep();
    from.setVolume(1);
  });
  return { t0, durationSec, mixInTrackTime, mixOutTrackTime, rate: 1, fallback: false, style: 'filter', reason: timing.reason };
}

/** A filter at these is as good as open. */
const FILTER_OPEN_LOW_HZ = 20;
const FILTER_OPEN_HIGH_HZ = 20000;
/** Where the outgoing high-pass ends: the body of the track gone, its top still trailing. */
const FILTER_HP_END_HZ = 1800;
/** Where the incoming low-pass starts: kick and bass only, the rest arriving as it opens. */
const FILTER_LP_START_HZ = 350;

/** No usable grid: plain equal-power volume fade, no beatmatch, no EQ moves. */
function scheduleFallback(
  req: TransitionRequest,
  earliest: number,
  reason: string | null = null,
  cueTime?: number,
  fadeSec?: number,
): TransitionPlan {
  const { from, to, fromAnalysis, toAnalysis } = req;
  const ctx = from.ctx;
  const fromPos = from.expectedTrackTime ?? 0;
  const remainingRoom = fromAnalysis.durationSec > 0 ? Math.max(2, fromAnalysis.durationSec - fromPos - 0.3) : FALLBACK_CROSSFADE_SEC;
  const durationSec = Math.min(fadeSec ?? FALLBACK_CROSSFADE_SEC, remainingRoom);
  const t0 = earliest;
  const mixInTrackTime = cueTime ?? Math.min(toAnalysis.introEndSec ?? 0, 6);
  to.playAt({ ctxTime: t0, trackTime: mixInTrackTime, rate: 1 });
  from.pauseAt(t0 + durationSec + 0.05);
  applyEqualPowerCross(from.gain.gain, to.gain.gain, t0, durationSec);
  scheduleAfter(ctx, t0 + durationSec + 0.2, () => {
    from.eq.reset();
    from.setVolume(1);
  });
  return {
    t0,
    durationSec,
    mixInTrackTime,
    mixOutTrackTime: fromPos,
    rate: 1,
    fallback: true,
    style: 'crossfade',
    reason,
  };
}

function applyEqualPowerCross(outParam: AudioParam, inParam: AudioParam, t0: number, durationSec: number): void {
  const N = 65;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
  }
  outParam.cancelScheduledValues(t0 - 0.03);
  inParam.cancelScheduledValues(t0 - 0.03);
  outParam.setValueAtTime(1, t0 - 0.02);
  inParam.setValueAtTime(0, t0 - 0.02);
  outParam.setValueCurveAtTime(fadeOut, t0, durationSec);
  inParam.setValueCurveAtTime(fadeIn, t0, durationSec);
}

/** Step the incoming deck's rate back to 1.0 in inaudible ~0.8% increments. */
function glideRateToUnity(deck: Deck, fromRate: number, startCtxTime: number): void {
  if (Math.abs(fromRate - 1) < 0.002) {
    deck.setRate(1, startCtxTime + 0.5);
    return;
  }
  const steps = 8;
  const stepSec = 3;
  for (let i = 1; i <= steps; i++) {
    const r = fromRate + (1 - fromRate) * (i / steps);
    deck.setRate(r, startCtxTime + i * stepSec);
  }
}

/** Fire a callback near an AudioContext time (cosmetic cleanup only). */
function scheduleAfter(ctx: AudioContext, ctxTime: number, fn: () => void): void {
  setTimeout(fn, Math.max(0, (ctxTime - ctx.currentTime) * 1000));
}

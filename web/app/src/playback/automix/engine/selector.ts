// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ./NOTICE.md in playback/automix.

import type { TrackAnalysis } from '../analysis/types';
import { camelotScore } from '../analysis/camelot';
import { MIN_GRID_CONFIDENCE } from './transition-scheduler';

export type EnergyDirection = -1 | 0 | 1;

export interface Candidate {
  analysis: TrackAnalysis;
  score: number;
  harmonic: boolean;
  reasons: { camelot: number; bpm: number; energy: number; repeat: number };
}

export interface SelectorOptions {
  energyDirection: EnergyDirection;
  /** Most-recently-played first. */
  recentFileKeys: string[];
  excludeFileKeys?: string[];
}

const BPM_HARD_LIMIT = 0.08; // ±8% stretchable
const BPM_FULL_SCORE = 0.04;

/**
 * Rank the library as next-track candidates: Camelot adjacency + BPM
 * proximity + energy direction - repetition. Harmonic matches sort first;
 * non-harmonic but tempo-compatible tracks are kept as a reserve so the
 * mix never strands.
 */
export function rankCandidates(
  current: TrackAnalysis,
  pool: TrackAnalysis[],
  opts: SelectorOptions,
): Candidate[] {
  const exclude = new Set([current.fileKey, ...(opts.excludeFileKeys ?? [])]);
  const noRepeat = new Set(opts.recentFileKeys.slice(0, Math.min(10, Math.floor(pool.length / 2))));
  const recentArtists = new Set(
    opts.recentFileKeys
      .slice(0, 3)
      .map((k) => pool.find((p) => p.fileKey === k)?.tags.artist)
      .filter(Boolean),
  );

  const candidates: Candidate[] = [];
  for (const a of pool) {
    if (exclude.has(a.fileKey) || noRepeat.has(a.fileKey)) continue;
    if (!a.bpm || !current.bpm) continue;

    const bpmRatio = bpmDistance(current.bpm, a.bpm);
    if (bpmRatio > BPM_HARD_LIMIT) continue;
    const bpmScore = bpmRatio <= BPM_FULL_SCORE ? 1 : 1 - (bpmRatio - BPM_FULL_SCORE) / (BPM_HARD_LIMIT - BPM_FULL_SCORE);

    const camelot = current.camelot && a.camelot ? camelotScore(current.camelot, a.camelot) : 0;

    const energyDelta = a.energy - current.energy;
    const energy =
      opts.energyDirection === 0
        ? Math.max(0, 0.5 - Math.abs(energyDelta) * 2)
        : Math.max(-0.5, Math.min(1, opts.energyDirection * energyDelta * 4));

    const repeat = recentArtists.has(a.tags.artist) ? -0.75 : 0;
    const lowGrid = a.gridConfidence < MIN_GRID_CONFIDENCE ? -0.5 : 0;

    candidates.push({
      analysis: a,
      score: camelot + bpmScore + energy + repeat + lowGrid,
      harmonic: camelot > 0,
      reasons: { camelot, bpm: bpmScore, energy, repeat },
    });
  }

  // rescue tier: nothing is tempo-compatible (e.g. one 130 BPM track in an
  // 85 BPM library) — offer harmonic-first picks anyway; the transition
  // scheduler refuses extreme stretches and plain-crossfades instead.
  if (candidates.length === 0) {
    for (const a of pool) {
      if (exclude.has(a.fileKey) || noRepeat.has(a.fileKey)) continue;
      if (!a.bpm) continue;
      const camelot = current.camelot && a.camelot ? camelotScore(current.camelot, a.camelot) : 0;
      candidates.push({
        analysis: a,
        score: camelot - 1,
        harmonic: false,
        reasons: { camelot, bpm: 0, energy: 0, repeat: 0 },
      });
    }
  }

  candidates.sort((x, y) => {
    if (x.harmonic !== y.harmonic) return x.harmonic ? -1 : 1;
    return y.score - x.score;
  });
  return candidates;
}

export interface SmoothTrackOrderItem {
  id: string;
  artist?: string;
  genreKey?: string;
  bpm?: number | null;
  camelot?: { num: number; letter: 'A' | 'B' } | null;
  energy?: number | null;
}

/**
 * Reorders station candidates smoothly around an anchor track, balancing BPM
 * reachability (accounting for half/double time), Camelot harmonic compatibility,
 * and energy continuity against artist and genre variety penalties.
 */
export function orderStationSmoothly<T extends SmoothTrackOrderItem>(
  anchor: SmoothTrackOrderItem | null,
  items: readonly T[],
  limit = items.length,
): T[] {
  if (items.length <= 1 || limit <= 0) return items.slice(0, Math.max(0, limit));
  const pool = [...items];
  const out: T[] = [];
  let current = anchor;
  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  let prevArtist = anchor?.artist?.toLowerCase().trim() || '';
  let prevGenre = anchor?.genreKey?.toLowerCase().trim() || '';

  while (out.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[i]!;
      let score = -i * 0.03;
      if (current?.bpm && cand.bpm && current.bpm > 0 && cand.bpm > 0) {
        const dist = bpmDistance(current.bpm, cand.bpm);
        score += dist <= 0.06 ? 2.4 - dist * 10 : dist <= 0.14 ? 1.2 - (dist - 0.06) * 6 : -1.5 - dist;
      }
      if (current?.camelot && cand.camelot) {
        score += camelotScore(current.camelot, cand.camelot);
      }
      if (current?.energy != null && cand.energy != null && Number.isFinite(current.energy) && Number.isFinite(cand.energy)) {
        score += Math.max(-1, 0.8 - Math.abs(cand.energy - current.energy) * 2.2);
      }
      const artist = cand.artist?.toLowerCase().trim() || '';
      if (artist) {
        if (artist === prevArtist) score -= 2.4;
        const prior = artistCounts.get(artist) ?? 0;
        if (prior > 0) score -= prior * 0.7;
      }
      const genre = cand.genreKey?.toLowerCase().trim() || '';
      if (genre) {
        // Prevent repeating the exact same genre/mood tag endlessly when variety is available.
        if (genre === prevGenre) score -= 0.75;
        const gPrior = genreCounts.get(genre) ?? 0;
        if (gPrior > 0) score -= gPrior * 0.35;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0]!;
    out.push(chosen);
    current = chosen;
    prevArtist = chosen.artist?.toLowerCase().trim() || '';
    if (prevArtist) artistCounts.set(prevArtist, (artistCounts.get(prevArtist) ?? 0) + 1);
    prevGenre = chosen.genreKey?.toLowerCase().trim() || '';
    if (prevGenre) genreCounts.set(prevGenre, (genreCounts.get(prevGenre) ?? 0) + 1);
  }
  return out;
}

/** Relative BPM distance accounting for half/double-time equivalence. */
function bpmDistance(a: number, b: number): number {
  const candidates = [b, b * 2, b / 2];
  return Math.min(...candidates.map((x) => Math.abs(x - a) / a));
}

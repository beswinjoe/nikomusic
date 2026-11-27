import { describe, expect, it, vi } from 'vitest';
vi.mock('signalsmith-stretch', () => ({ default: vi.fn() }));
import type { TrackAnalysis } from '../analysis/types';
import type { LoopChange, LoopDeck } from './loopDeck';
import { planLoopMix, scheduleLoopMix } from './loopMix';
import { orderStationSmoothly } from './selector';
import { planMixWindowTiming } from './transition-scheduler';

const SR = 1000;

function buffer(durationSec: number): AudioBuffer {
  const data = new Float32Array(Math.round(durationSec * SR)).fill(0.3);
  return { duration: durationSec, sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer;
}

function makeAnalysis(
  key: string,
  bpm: number,
  durationSec = 200,
  opts: {
    confidence?: number;
    camelot?: { num: number; letter: 'A' | 'B' } | null;
    vocals?: TrackAnalysis['vocals'];
    introEndSec?: number | null;
    outroStartSec?: number | null;
  } = {},
): TrackAnalysis {
  return {
    fileKey: key,
    path: '',
    tags: { title: key, artist: '' },
    durationSec,
    bpm,
    beatIntervalSec: 60 / bpm,
    firstDownbeatSec: 0.5,
    gridConfidence: opts.confidence ?? 0.9,
    camelot: opts.camelot ?? { num: 8, letter: 'B' },
    keyName: null,
    keyConfidence: 0.9,
    energy: 0.6,
    energyCurve: Array.from({ length: 40 }, () => 0.6),
    introEndSec: opts.introEndSec ?? 6,
    outroStartSec: opts.outroStartSec ?? durationSec - 16,
    analysisVersion: 9,
    vocals: opts.vocals ?? [],
  };
}

function vocalWindow(from: number, to: number, level: number) {
  const fps = 10;
  return { startSec: from, fps, curve: Array.from({ length: Math.round((to - from) * fps) }, () => level) };
}

describe('Smart Automix Web Timing & Selection', () => {
  it('plans smooth transitions for slow-to-slow, slow-to-fast octave fold, and fast-to-fast', () => {
    const slowA = makeAnalysis('s1', 76);
    const slowB = makeAnalysis('s2', 80);
    const slowPlan = planMixWindowTiming({ fromAnalysis: slowA, toAnalysis: slowB, requestedBars: 8, outRate: 1 });
    expect(slowPlan.style).toBe('blend');
    expect(slowPlan.durationSec).toBeGreaterThan(4);

    // 84 -> 166 BPM folds cleanly via half-time without excessive speed distortion
    const fastHalf = makeAnalysis('f1', 166);
    const octavePlan = planMixWindowTiming({ fromAnalysis: slowA, toAnalysis: fastHalf, requestedBars: 8, outRate: 1 });
    expect(octavePlan.style).toBe('blend');
    expect(Math.abs(octavePlan.rate - 1)).toBeLessThan(0.15);

    const fastA = makeAnalysis('fa', 126);
    const fastB = makeAnalysis('fb', 128);
    const fastPlan = planMixWindowTiming({ fromAnalysis: fastA, toAnalysis: fastB, requestedBars: 8, outRate: 1 });
    expect(fastPlan.style).toBe('blend');
  });

  it('shortens vocal-on-vocal overlaps and handles short tracks cleanly', () => {
    const vocalOut = makeAnalysis('vo', 124, 200, { vocals: [vocalWindow(160, 200, 0.8)] });
    const vocalIn = makeAnalysis('vi', 124, 200, { vocals: [vocalWindow(0, 40, 0.8)] });
    const longReq = planMixWindowTiming({ fromAnalysis: vocalOut, toAnalysis: vocalIn, requestedBars: 16, outRate: 1 });
    expect(longReq.durationSec).toBeLessThanOrEqual(10.1);

    const shortInterlude = makeAnalysis('short', 120, 20, { introEndSec: 1, outroStartSec: 16 });
    const shortPlan = planMixWindowTiming({
      fromAnalysis: shortInterlude,
      toAnalysis: makeAnalysis('n', 120),
      requestedBars: 8,
      outRate: 1,
    });
    expect(shortPlan.mixOutTrackTime).toBeGreaterThan(10);
    expect(shortPlan.durationSec).toBeLessThan(10);
  });

  it('keeps LoopMix overlap gains bounded below harsh +4.1 dB clipping peaks', () => {
    const out = makeAnalysis('lo', 120, 200, { vocals: [] });
    const inn = makeAnalysis('li', 120, 180, { vocals: [] });
    const plan = planLoopMix(out, buffer(200), inn, buffer(180), 0, { out: [], in: [] });
    expect(plan).not.toBeNull();

    const ramps: { side: 'out' | 'in'; t: number; v: number }[] = [];
    const deck = (side: 'out' | 'in') =>
      ({
        schedule: vi.fn<(c: LoopChange[]) => void>(),
        gain: {
          gain: {
            cancelScheduledValues: vi.fn(),
            setValueAtTime: vi.fn((v: number, t: number) => ramps.push({ side, t, v })),
            linearRampToValueAtTime: vi.fn((v: number, t: number) => ramps.push({ side, t, v })),
            exponentialRampToValueAtTime: vi.fn(),
          },
        },
        sweep: {
          highpass: { frequency: { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } },
          lowpass: { frequency: { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } },
        },
        eq: {
          cancelAt: vi.fn(),
          setGainAt: vi.fn(),
          rampGain: vi.fn(),
        },
      }) as unknown as LoopDeck;

    const times = scheduleLoopMix(plan!, deck('out'), deck('in'), 10);
    expect(times.elementAt).toBeGreaterThan(times.handoffAt);
    const byTime = new Map<string, { out?: number; in?: number }>();
    for (const r of ramps) {
      const k = r.t.toFixed(4);
      const entry = byTime.get(k) ?? {};
      entry[r.side] = r.v;
      byTime.set(k, entry);
    }
    for (const pair of byTime.values()) {
      if (pair.out != null && pair.in != null) {
        expect(pair.out + pair.in).toBeLessThanOrEqual(1.37);
      }
    }
    expect(ramps.some((r) => r.side === 'out' && Math.abs(r.v - 0.82) < 1e-6)).toBe(true);
    expect(ramps.some((r) => r.side === 'in' && Math.abs(r.v - 0.86) < 1e-6)).toBe(true);
  });

  it('orders station tracks smoothly balancing BPM, Camelot, and artist/genre variety', () => {
    const anchor = { id: 'seed', artist: 'Daft Punk', genreKey: 'electronic', bpm: 120, camelot: { num: 8, letter: 'B' as const }, energy: 0.7 };
    const ordered = orderStationSmoothly(anchor, [
      { id: 'clash', artist: 'Slipknot', genreKey: 'metal', bpm: 175, camelot: { num: 2, letter: 'A' as const }, energy: 0.98 },
      { id: 'repeatArtist', artist: 'Daft Punk', genreKey: 'electronic', bpm: 120, camelot: { num: 8, letter: 'B' as const }, energy: 0.7 },
      { id: 'smooth', artist: 'Justice', genreKey: 'synth', bpm: 122, camelot: { num: 9, letter: 'B' as const }, energy: 0.72 },
      { id: 'followup', artist: 'Parcels', genreKey: 'funk', bpm: 124, camelot: { num: 8, letter: 'A' as const }, energy: 0.68 },
    ]);
    expect(ordered[0]!.id).toBe('smooth');
  });
});

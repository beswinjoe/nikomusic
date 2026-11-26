// From AutoMix (https://github.com/heydavidf/automix), Copyright (C) 2026 David Finnegan.
// AGPL-3.0-only: see ./LICENSE and ./NOTICE.md in playback/automix.

/** Per-window RMS energy curve (normalized to peak = 1) + intro/outro detection. */

export function energyCurve(samples: Float32Array, sampleRate: number, windowSec: number): number[] {
  const windowSamples = Math.max(1, Math.round(windowSec * sampleRate));
  const curve: number[] = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    let acc = 0;
    for (let i = start; i < end; i++) acc += samples[i]! * samples[i]!;
    curve.push(Math.sqrt(acc / (end - start)));
  }
  const peak = Math.max(...curve, 1e-9);
  return curve.map((v) => v / peak);
}

export interface IntroOutro {
  introEndSec: number;
  outroStartSec: number;
}

/**
 * Intro = leading low-energy span within the opening 25% (capped at 28 s).
 * Outro = trailing low-energy tail within the closing ~35 s (>= 72% of song
 * for normal tracks), benchmarked against the track's 80th-percentile sustained
 * energy so a single loud peak never mislabels verses/bridges as an outro.
 */
export function detectIntroOutro(curve: number[], windowSec: number, durationSec: number): IntroOutro {
  if (!curve.length || durationSec <= 0 || windowSec <= 0) {
    return { introEndSec: 0, outroStartSec: durationSec };
  }
  const active = curve.filter((v) => v > 0.02).sort((a, b) => a - b);
  const p80 = active[Math.min(active.length - 1, Math.floor(active.length * 0.8))] ?? 1;
  const sustainedRef = Math.max(0.35, p80);
  const activeThresh = sustainedRef * 0.55;
  const tailDecayThresh = sustainedRef * 0.45;

  const maxIntro = durationSec >= 45 ? Math.min(28, durationSec * 0.25) : durationSec * 0.25;
  let introEnd = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    if (curve[i]! >= activeThresh && curve[i + 1]! >= activeThresh) {
      introEnd = i * windowSec;
      break;
    }
  }
  introEnd = Math.min(introEnd, maxIntro);

  const minOutro = durationSec >= 45 ? Math.max(durationSec * 0.72, durationSec - 35) : durationSec * 0.65;
  const earliestIdx = Math.max(0, Math.floor(minOutro / windowSec));
  let outroStart = durationSec;
  for (let i = curve.length - 2; i >= earliestIdx; i--) {
    if (curve[i]! >= activeThresh && curve[i + 1]! >= activeThresh) {
      const candidate = Math.min(durationSec, (i + 2) * windowSec);
      const tail = curve.slice(i + 2);
      const staysLow = tail.length === 0 || tail.every((v) => v < tailDecayThresh || tail.filter((x) => x >= activeThresh).length === 0);
      if (staysLow) outroStart = Math.max(minOutro, candidate);
      break;
    }
  }
  outroStart = Math.max(outroStart, minOutro);
  return { introEndSec: introEnd, outroStartSec: outroStart };
}

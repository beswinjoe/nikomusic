import { describe, expect, it, beforeEach } from 'vitest';
import { isOriginalOfficialVideoCandidate, isThirdPartyUpload } from '@/data/music/api';
import { artworkFallbackUrl, heroArtwork, sizedArtwork } from '@/lib/artwork';
import { markVideoUnavailable, suppressVideoPicture, useVideo } from '@/state/video';
import {
  browserSupportsDolbyAtmos,
  buildPreferredCodecs,
  pickAudioVariant,
  resolveStreamBadge,
  type SelectableAudioTrack,
} from './audioQuality';
import { detectIntroOutro } from '@/playback/automix/analysis/energy';
import type { TrackAnalysis } from '@/playback/automix/analysis/types';
import { planMixWindowTiming } from '@/playback/automix/engine/transition-scheduler';
import {
  calculateSleepFadeVolume,
  formatSleepRemaining,
  SLEEP_MAX_MINUTES,
  SLEEP_STEP_MINUTES,
  sleepFractionOf,
  sleepMinutesAt,
  useSleepTimer,
} from './sleepTimer';

function variant(
  id: string,
  audioCodec: string,
  kbps: number,
  sampleRate = 48000,
  channels = 2,
  drc = false,
): SelectableAudioTrack {
  return {
    id,
    audioCodec,
    originalAudioId: drc ? `${id}-drc` : id,
    audioBandwidth: kbps * 1000,
    bandwidth: kbps * 1000,
    audioSamplingRate: sampleRate,
    channelsCount: channels,
  };
}

describe('SleepTimer', () => {
  beforeEach(() => {
    useSleepTimer.getState().cancel();
    useSleepTimer.getState().setFadeOut(true);
  });

  it('maps custom slider fractions cleanly in 5-minute steps up to 12 hours', () => {
    expect(sleepMinutesAt(0)).toBe(SLEEP_STEP_MINUTES);
    expect(sleepMinutesAt(1)).toBe(SLEEP_MAX_MINUTES);
    expect(sleepMinutesAt(-0.5)).toBe(SLEEP_STEP_MINUTES);
    expect(sleepMinutesAt(1.5)).toBe(SLEEP_MAX_MINUTES);
    for (let m = SLEEP_STEP_MINUTES; m <= SLEEP_MAX_MINUTES; m += SLEEP_STEP_MINUTES) {
      expect(sleepMinutesAt(sleepFractionOf(m))).toBe(m);
    }
  });

  it('fades volume linearly across the final 30 seconds when enabled', () => {
    expect(calculateSleepFadeVolume(45_000, true)).toBe(1);
    expect(calculateSleepFadeVolume(30_000, true)).toBe(1);
    expect(calculateSleepFadeVolume(15_000, true)).toBeCloseTo(0.5, 3);
    expect(calculateSleepFadeVolume(7_500, true)).toBeCloseTo(0.25, 3);
    expect(calculateSleepFadeVolume(0, true)).toBe(0);
    expect(calculateSleepFadeVolume(5_000, false)).toBe(1);
  });

  it('starts timed and after-track modes cleanly and formats countdowns', () => {
    useSleepTimer.getState().start(30);
    expect(useSleepTimer.getState().minutes).toBe(30);
    expect(useSleepTimer.getState().afterTrack).toBe(false);
    expect(useSleepTimer.getState().deadlineMs).toBeTypeOf('number');

    useSleepTimer.getState().startAfterTrack();
    expect(useSleepTimer.getState().afterTrack).toBe(true);
    expect(useSleepTimer.getState().deadlineMs).toBeNull();

    expect(formatSleepRemaining(65_000)).toBe('1:05');
    expect(formatSleepRemaining(3_665_000)).toBe('1:01:05');
  });
});

describe('AudioQuality & Dolby Atmos', () => {
  it('prefers E-AC-3 / AC-3 ahead of stereo Opus when Dolby Atmos is enabled & supported', () => {
    const codecs = buildPreferredCodecs({
      dolbyAtmos: true,
      opusSupported: true,
      eac3Supported: true,
      ac3Supported: true,
    });
    expect(codecs).toEqual(['ec-3', 'ac-3', 'opus', 'mp4a']);

    const disabled = buildPreferredCodecs({
      dolbyAtmos: false,
      opusSupported: true,
      eac3Supported: true,
      ac3Supported: true,
    });
    expect(disabled).toEqual(['opus', 'mp4a']);
    expect(browserSupportsDolbyAtmos()).toEqual({ eac3: false, ac3: false });
  });

  it('selects Dolby Atmos, caps Low/Medium, prefers highest rate for Hi-Res Lossless, and avoids DRC', () => {
    const pool = [
      variant('251', 'opus', 160, 48000, 2, false),
      variant('251-drc', 'opus', 256, 48000, 2, true),
      variant('250', 'opus', 70, 48000, 2, false),
      variant('249', 'opus', 50, 48000, 2, false),
      variant('140', 'mp4a.40.2', 128, 44100, 2, false),
      variant('328', 'ec-3', 384, 48000, 6, false),
    ];

    // With Atmos enabled and ec-3 preferred -> chooses 6-channel E-AC-3
    const atmos = pickAudioVariant(pool, {
      preferredCodecs: ['ec-3', 'opus', 'mp4a'],
      quality: 'hi-res-lossless',
      dolbyAtmos: true,
    });
    expect(atmos?.id).toBe('328');

    // Low quality ceiling caps to <=80kbps (picks 250 = 70kbps instead of 251)
    const low = pickAudioVariant(pool, {
      preferredCodecs: ['opus', 'mp4a'],
      quality: 'low',
      dolbyAtmos: false,
    });
    expect(low?.id).toBe('250');

    // Hi-Res skips DRC 251-drc and selects highest sample-rate / non-DRC track
    const hiResPool = [
      variant('cd', 'flac', 1411, 44100, 2, false),
      variant('master', 'flac', 4608, 192000, 2, false),
    ];
    const hiRes = pickAudioVariant(hiResPool, {
      preferredCodecs: ['flac', 'opus', 'mp4a'],
      quality: 'hi-res-lossless',
      dolbyAtmos: false,
    });
    expect(hiRes?.id).toBe('master');
  });

  it('derives accurate stream badges without overclaiming compressed streams as lossless', () => {
    expect(
      resolveStreamBadge({
        codec: 'E-AC-3',
        bitrateKbps: 384,
        sampleRateHz: 48000,
        channels: 6,
        spatialAudio: true,
        quality: 'hi-res-lossless',
      }),
    ).toEqual({ kind: 'atmos', label: 'Dolby Atmos' });

    expect(
      resolveStreamBadge({
        codec: 'FLAC',
        bitrateKbps: 4608,
        sampleRateHz: 192000,
        channels: 2,
        spatialAudio: false,
        quality: 'hi-res-lossless',
      }),
    ).toEqual({ kind: 'hi-res-lossless', label: 'Hi-Res Lossless' });

    expect(
      resolveStreamBadge({
        codec: 'Opus',
        bitrateKbps: 160,
        sampleRateHz: 48000,
        channels: 2,
        spatialAudio: true,
        quality: 'hi-res-lossless',
      }),
    ).toEqual({ kind: 'spatial', label: 'Spatial Audio' });

    // Opus 160 under Hi-Res setting reports High Quality, not fake Lossless
    expect(
      resolveStreamBadge({
        codec: 'Opus',
        bitrateKbps: 160,
        sampleRateHz: 48000,
        channels: 2,
        spatialAudio: false,
        quality: 'hi-res-lossless',
      }),
    ).toEqual({ kind: 'high', label: 'High Quality · Best Stream' });
  });
});

describe('Video Mode original filtering & availability', () => {
  it('toggles video picture suppression and marks unavailable videos cleanly', () => {
    useVideo.setState({ videoId: 'vid123', suppressedVideoId: null, unavailableIds: {} });
    suppressVideoPicture('vid123');
    expect(useVideo.getState().suppressedVideoId).toBe('vid123');

    suppressVideoPicture(null);
    expect(useVideo.getState().suppressedVideoId).toBeNull();

    markVideoUnavailable('broken99');
    expect(useVideo.getState().unavailableIds['broken99']).toBe(true);
  });

  it('allows authentic OMV videos while rejecting 7clouds and non-original lyric uploads', () => {
    expect(
      isOriginalOfficialVideoCandidate({
        title: 'Low (Official Video)',
        artists: 'SZA',
        musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
      }),
    ).toBe(true);

    expect(
      isOriginalOfficialVideoCandidate({
        title: 'SZA - Low (Lyrics)',
        artists: '7clouds',
        musicVideoType: 'MUSIC_VIDEO_TYPE_UGC',
      }),
    ).toBe(false);

    expect(
      isOriginalOfficialVideoCandidate({
        title: 'Low - Lyric Video',
        artists: 'Random Channel',
        musicVideoType: 'MUSIC_VIDEO_TYPE_UGC',
      }),
    ).toBe(false);

    expect(
      isThirdPartyUpload({
        title: 'Sailor Song',
        artists: [{ name: '7clouds R&B', id: null }],
      }),
    ).toBe(true);

    expect(
      isThirdPartyUpload({
        title: 'Sailor Song',
        artists: [{ name: 'Gigi Perez', id: null }],
      }),
    ).toBe(false);
  });
});

describe('8K poster resolution & graceful fallback', () => {
  it('upgrades resizable Google, Apple, and YouTube posters up to 8K and steps down cleanly on error', () => {
    const gUrl = 'https://lh3.googleusercontent.com/abc123=w544-h544-l90-rj';
    const g8k = heroArtwork(gUrl, 7680);
    expect(g8k).toBe('https://lh3.googleusercontent.com/abc123=w7680-h7680-l95-rj');
    expect(artworkFallbackUrl(g8k)).toBe('https://lh3.googleusercontent.com/abc123=w4096-h4096-l95-rj');
    expect(artworkFallbackUrl('https://lh3.googleusercontent.com/abc123=w4096-h4096-l95-rj')).toBe(
      'https://lh3.googleusercontent.com/abc123=w2160-h2160-l95-rj',
    );
    expect(sizedArtwork(gUrl, 1200)).toContain('=w4096-h4096-l95-rj');

    const appleUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg';
    const a8k = heroArtwork(appleUrl, 7680);
    expect(a8k).toBe('https://is1-ssl.mzstatic.com/image/thumb/Music/7680x7680bb.jpg');
    expect(artworkFallbackUrl(a8k)).toBe('https://is1-ssl.mzstatic.com/image/thumb/Music/4096x4096bb.jpg');

    const ytUrl = 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg';
    const ytMax = heroArtwork(ytUrl, 7680);
    expect(ytMax).toBe('https://i.ytimg.com/vi/abc12345678/maxresdefault.jpg');
    expect(artworkFallbackUrl(ytMax)).toBe('https://i.ytimg.com/vi/abc12345678/sddefault.jpg');
  });
});

describe('AutoMix suitable exit point & concise blend timing', () => {
  function sampleTrack(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
    return {
      fileKey: 'track-a',
      path: 'youtube:track-a',
      tags: { title: 'The Wind', artist: 'John Michael Howell' },
      durationSec: 165,
      bpm: 80,
      beatIntervalSec: 60 / 80,
      firstDownbeatSec: 0.4,
      gridConfidence: 0.78,
      camelot: null,
      keyName: null,
      keyConfidence: 0,
      energy: 0.55,
      energyCurve: [],
      introEndSec: 4,
      outroStartSec: 165,
      vocals: [],
      analysisVersion: 9,
      ...overrides,
    };
  }

  it('never mislabels the middle of a dynamic song as an outro', () => {
    // 165 s track with one big peak near 45 s and ~0.50 sustained energy through 155 s
    const curve = Array.from({ length: 41 }, (_, i) => {
      if (i >= 10 && i <= 12) return 1.0;
      if (i >= 39) return 0.15;
      return 0.52;
    });
    const { introEndSec, outroStartSec } = detectIntroOutro(curve, 4, 165);
    expect(introEndSec).toBeLessThanOrEqual(28);
    expect(outroStartSec).toBeGreaterThanOrEqual(130);
  });

  it('caps slow-tempo blends instead of overmixing 40-50 seconds and prevents mid-song 0:42 exits', () => {
    const out = sampleTrack({
      durationSec: 165,
      bpm: 75,
      beatIntervalSec: 60 / 75,
      // Simulate stale mid-song outro from older analysis cache
      outroStartSec: 82.5,
    });
    const inn = sampleTrack({
      fileKey: 'track-b',
      durationSec: 190,
      bpm: 76,
      beatIntervalSec: 60 / 76,
      introEndSec: 12,
    });
    const timing = planMixWindowTiming({
      fromAnalysis: out,
      toAnalysis: inn,
      requestedBars: 16,
      outRate: 1,
    });
    expect(timing.style).toBe('blend');
    expect(timing.durationSec).toBeLessThanOrEqual(16.5);
    expect(timing.mixOutTrackTime).toBeGreaterThanOrEqual(165 - 28);
    expect(timing.mixInTrackTime).toBeLessThanOrEqual(20);
  });

  it('prefers low-vocal suitable windows around ~20 s before end and shortens clashes', () => {
    // Outgoing 180 s at 120 BPM (bar = 2 s): vocals end around 156 s (24 s before end)
    const fps = 5;
    const outVocals = Array.from({ length: Math.round(50 * fps) }, (_, i) => {
      const t = 130 + i / fps;
      return t >= 156 && t <= 172 ? 0.05 : 0.78;
    });
    const inVocals = Array.from({ length: Math.round(30 * fps) }, () => 0.78);

    const out = sampleTrack({
      durationSec: 180,
      bpm: 120,
      beatIntervalSec: 0.5,
      vocals: [{ startSec: 130, fps, curve: outVocals }],
    });
    const inn = sampleTrack({
      fileKey: 'track-b',
      durationSec: 180,
      bpm: 120,
      beatIntervalSec: 0.5,
      introEndSec: 16,
      vocals: [{ startSec: 0, fps, curve: inVocals }],
    });

    const timing = planMixWindowTiming({
      fromAnalysis: out,
      toAnalysis: inn,
      requestedBars: 8,
      outRate: 1,
    });
    expect(timing.mixOutTrackTime).toBeGreaterThanOrEqual(154);
    expect(timing.mixOutTrackTime).toBeLessThanOrEqual(168);
    expect(timing.durationSec).toBeLessThanOrEqual(14.5);
  });

  it('keeps filter mixes and fallback crossfades compact and within the ending zone', () => {
    const out = sampleTrack({ durationSec: 180, bpm: 90, beatIntervalSec: 60 / 90 });
    const farIn = sampleTrack({
      fileKey: 'fast',
      durationSec: 180,
      bpm: 140,
      beatIntervalSec: 60 / 140,
    });
    const filterTiming = planMixWindowTiming({
      fromAnalysis: out,
      toAnalysis: farIn,
      requestedBars: 16,
      outRate: 1,
    });
    expect(filterTiming.style).toBe('filter');
    expect(filterTiming.durationSec).toBeLessThanOrEqual(10.5);
    expect(filterTiming.mixOutTrackTime).toBeGreaterThanOrEqual(152);

    const noGridOut = sampleTrack({ durationSec: 180, bpm: null, beatIntervalSec: null, gridConfidence: 0 });
    const fallbackTiming = planMixWindowTiming({
      fromAnalysis: noGridOut,
      toAnalysis: farIn,
      requestedBars: 8,
      outRate: 1,
    });
    expect(fallbackTiming.style).toBe('crossfade');
    expect(fallbackTiming.durationSec).toBeLessThanOrEqual(8.5);
    expect(fallbackTiming.mixOutTrackTime).toBeGreaterThanOrEqual(152);
  });
});

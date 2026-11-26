/**
 * Streaming audio quality ceilings (Low up to Hi-Res Lossless) and Dolby Atmos preference
 * for Niko Music Web. Mirrors Android's AudioQuality rungs cleanly while honoring browser MSE
 * codec support honestly.
 */

export type AudioQualityTier = 'low' | 'medium' | 'high' | 'lossless' | 'hi-res-lossless';

export interface AudioQualityOption {
  id: AudioQualityTier;
  label: string;
  shortLabel: string;
  detail: string;
  hourly: string;
  /** Bitrate cap in kbps for YouTube streams (`Infinity` = best available). */
  maxYouTubeKbps: number;
  permitsLossless: boolean;
  permitsHiRes: boolean;
}

export const DEFAULT_AUDIO_QUALITY: AudioQualityTier = 'hi-res-lossless';

export const AUDIO_QUALITY_OPTIONS: readonly AudioQualityOption[] = [
  {
    id: 'hi-res-lossless',
    label: 'Hi-Res Lossless',
    shortLabel: 'Hi-Res Lossless',
    detail: 'Up to 24-bit / 192 kHz master quality where supported; best Opus/AAC otherwise',
    hourly: '900+ MB/hr',
    maxYouTubeKbps: Infinity,
    permitsLossless: true,
    permitsHiRes: true,
  },
  {
    id: 'lossless',
    label: 'Lossless',
    shortLabel: 'Lossless',
    detail: '16-bit / 44.1 kHz studio ceiling; highest uncompressed / best Opus stream',
    hourly: '300+ MB/hr',
    maxYouTubeKbps: Infinity,
    permitsLossless: true,
    permitsHiRes: false,
  },
  {
    id: 'high',
    label: 'High',
    shortLabel: 'High Quality',
    detail: 'Best available ~160–256 kbps Opus / AAC stream',
    hourly: '115 MB/hr',
    maxYouTubeKbps: Infinity,
    permitsLossless: false,
    permitsHiRes: false,
  },
  {
    id: 'medium',
    label: 'Medium',
    shortLabel: 'Medium',
    detail: 'Up to ~128 kbps · balanced quality and bandwidth',
    hourly: '60 MB/hr',
    maxYouTubeKbps: 144,
    permitsLossless: false,
    permitsHiRes: false,
  },
  {
    id: 'low',
    label: 'Low',
    shortLabel: 'Data Saver',
    detail: 'Up to ~64 kbps · lightest data usage',
    hourly: '30 MB/hr',
    maxYouTubeKbps: 80,
    permitsLossless: false,
    permitsHiRes: false,
  },
] as const;

export function audioQualityOption(tier: AudioQualityTier): AudioQualityOption {
  return AUDIO_QUALITY_OPTIONS.find((o) => o.id === tier) ?? AUDIO_QUALITY_OPTIONS[0]!;
}

/** Whether this browser's Media Source Extensions can decode Dolby Digital Plus (E-AC-3) / AC-3. */
export function browserSupportsDolbyAtmos(): { eac3: boolean; ac3: boolean } {
  if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
    return { eac3: false, ac3: false };
  }
  return {
    eac3: MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"'),
    ac3: MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"'),
  };
}

export function buildPreferredCodecs({
  dolbyAtmos,
  opusSupported,
  eac3Supported,
  ac3Supported,
}: {
  dolbyAtmos: boolean;
  opusSupported: boolean;
  eac3Supported: boolean;
  ac3Supported: boolean;
}): string[] {
  const base = opusSupported ? ['opus', 'mp4a'] : ['mp4a'];
  if (!dolbyAtmos) return base;
  const atmos: string[] = [];
  if (eac3Supported) atmos.push('ec-3');
  if (ac3Supported) atmos.push('ac-3');
  return [...atmos, ...base];
}

export interface SelectableAudioTrack {
  id?: string | number | null;
  active?: boolean;
  audioCodec: string | null;
  originalAudioId?: string | null;
  audioBandwidth?: number | null;
  bandwidth: number;
  audioSamplingRate?: number | null;
  channelsCount?: number | null;
}

/**
 * Selects the optimal audio variant honoring [preferredCodecs], [dolbyAtmos], and [quality] bitrate ceiling,
 * while ignoring Dynamic Range Compression (DRC) variants.
 */
export function pickAudioVariant<T extends SelectableAudioTrack>(
  variants: readonly T[],
  options: {
    preferredCodecs: readonly string[];
    quality: AudioQualityTier;
    dolbyAtmos: boolean;
  },
): T | null {
  const nonDrc = variants.filter((t) => !/drc/i.test(t.originalAudioId ?? ''));
  const pool = nonDrc.length ? nonDrc : [...variants];
  if (!pool.length) return null;

  const ceilingKbps = audioQualityOption(options.quality).maxYouTubeKbps;
  const kbpsOf = (t: T) => Math.round((t.audioBandwidth ?? t.bandwidth) / 1000);

  const filterCeiling = (list: T[]) => {
    if (!Number.isFinite(ceilingKbps)) return list;
    const within = list.filter((t) => kbpsOf(t) > 0 && kbpsOf(t) <= ceilingKbps);
    if (within.length) return within;
    // If every available rendition exceeds the cap, take the lowest bandwidth one
    return [...list].sort((a, b) => kbpsOf(a) - kbpsOf(b)).slice(0, 1);
  };

  for (const codec of options.preferredCodecs) {
    if (!options.dolbyAtmos && (codec === 'ec-3' || codec === 'ac-3')) continue;
    const matching = pool.filter((t) => t.audioCodec?.toLowerCase().startsWith(codec));
    if (!matching.length) continue;

    // For E-AC-3 / AC-3 Dolby Atmos, prefer multichannel (>2ch) highest bandwidth
    if (codec === 'ec-3' || codec === 'ac-3') {
      const sorted = [...matching].sort((a, b) => {
        const chDiff = (b.channelsCount ?? 2) - (a.channelsCount ?? 2);
        if (chDiff !== 0) return chDiff;
        return (b.audioBandwidth ?? b.bandwidth) - (a.audioBandwidth ?? a.bandwidth);
      });
      if (sorted[0]) return sorted[0];
    }

    const bounded = filterCeiling(matching);
    const best = [...bounded].sort((a, b) => {
      const rateDiff = (b.audioSamplingRate ?? 0) - (a.audioSamplingRate ?? 0);
      if (options.quality === 'hi-res-lossless' && rateDiff !== 0) return rateDiff;
      return (b.audioBandwidth ?? b.bandwidth) - (a.audioBandwidth ?? a.bandwidth);
    })[0];
    if (best) return best;
  }

  return pool.find((t) => t.active) ?? pool[0] ?? null;
}

export function isDolbyCodec(codec: string | null | undefined, channels?: number | null): boolean {
  if (!codec) return false;
  const lower = codec.toLowerCase();
  if (lower.includes('ec-3') || lower.includes('e-ac-3') || lower.includes('ac-3') || lower.includes('ac-4')) {
    return true;
  }
  return (channels ?? 2) > 2;
}

export function isLosslessCodec(codec: string | null | undefined, bitrateKbps?: number | null): boolean {
  if (!codec) return false;
  const lower = codec.toLowerCase();
  if (lower.includes('flac') || lower.includes('alac') || lower.includes('pcm') || lower.includes('wav')) {
    return true;
  }
  return (bitrateKbps ?? 0) >= 800;
}

export interface StreamBadgeDescriptor {
  kind: 'atmos' | 'hi-res-lossless' | 'lossless' | 'spatial' | 'high';
  label: string;
}

/** Derives the player's concise quality / immersive badge without overclaiming stream resolution. */
export function resolveStreamBadge({
  codec,
  bitrateKbps,
  sampleRateHz,
  channels,
  spatialAudio,
  quality,
}: {
  codec: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  spatialAudio: boolean;
  quality: AudioQualityTier;
}): StreamBadgeDescriptor | null {
  if (isDolbyCodec(codec, channels)) {
    return { kind: 'atmos', label: 'Dolby Atmos' };
  }
  if (isLosslessCodec(codec, bitrateKbps)) {
    const isHiRes = (sampleRateHz ?? 0) > 48_000;
    return isHiRes
      ? { kind: 'hi-res-lossless', label: 'Hi-Res Lossless' }
      : { kind: 'lossless', label: 'Lossless' };
  }
  if (spatialAudio) {
    return { kind: 'spatial', label: 'Spatial Audio' };
  }
  if (quality === 'hi-res-lossless' && (bitrateKbps ?? 0) >= 120) {
    return { kind: 'high', label: 'High Quality · Best Stream' };
  }
  if ((bitrateKbps ?? 0) >= 120) {
    return { kind: 'high', label: 'High Quality' };
  }
  return null;
}

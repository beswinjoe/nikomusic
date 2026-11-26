/**
 * Web Audio binaural Spatial Audio / stereo widener processor matching Niko Music's
 * Android SpatialAudioProcessor (mid/side width expansion + 11ms low-passed acoustic crossfeed)
 * with clickless smooth wet/dry bypass switching.
 */
export class WebSpatialProcessor {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private enabled = false;

  constructor(private readonly ctx: AudioContext) {
    this.input = new GainNode(ctx, { gain: 1 });
    this.output = new GainNode(ctx, { gain: 1 });
    this.dryGain = new GainNode(ctx, { gain: 1 });
    this.wetGain = new GainNode(ctx, { gain: 0 });

    // Dry path (exact passthrough when off or when native Dolby Atmos E-AC-3 plays)
    this.input.connect(this.dryGain).connect(this.output);

    // Wet spatial matrix path:
    //   Mid = 0.5 * (L + R), Side = 0.5 * (L - R) * WIDTH
    //   OutL = (Mid + Side + lowpass(delay(R)) * CROSSFEED) * MAKEUP
    //   OutR = (Mid - Side + lowpass(delay(L)) * CROSSFEED) * MAKEUP
    const WIDTH = 2.15;
    const MAKEUP = 0.84;
    const CROSSFEED = 0.22;
    const DELAY_SEC = 0.011;

    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });

    // Direct width gains per matrix coeff:
    //   L' = a * L + b * R, where a = 0.5*(1 + WIDTH)*MAKEUP, b = 0.5*(1 - WIDTH)*MAKEUP
    const selfGain = 0.5 * (1 + WIDTH) * MAKEUP;
    const oppGain = 0.5 * (1 - WIDTH) * MAKEUP;

    const lToL = new GainNode(ctx, { gain: selfGain });
    const rToL = new GainNode(ctx, { gain: oppGain });
    const rToR = new GainNode(ctx, { gain: selfGain });
    const lToR = new GainNode(ctx, { gain: oppGain });

    // Delayed low-passed opposite-ear crossfeed (outer-ear pinna cue simulation)
    const delayR = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: DELAY_SEC });
    const delayL = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: DELAY_SEC });
    const lpR = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2400, Q: 0.65 });
    const lpL = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2400, Q: 0.65 });
    const crossToL = new GainNode(ctx, { gain: CROSSFEED * MAKEUP });
    const crossToR = new GainNode(ctx, { gain: CROSSFEED * MAKEUP });

    // Gentle soft-knee compressor prevents inter-sample clipping after widening
    const limiter = new DynamicsCompressorNode(ctx, {
      threshold: -1.5,
      knee: 4,
      ratio: 8,
      attack: 0.002,
      release: 0.08,
    });

    this.input.connect(splitter);

    splitter.connect(lToL, 0);
    splitter.connect(rToL, 1);
    lToL.connect(merger, 0, 0);
    rToL.connect(merger, 0, 0);

    splitter.connect(rToR, 1);
    splitter.connect(lToR, 0);
    rToR.connect(merger, 0, 1);
    lToR.connect(merger, 0, 1);

    splitter.connect(delayR, 1);
    delayR.connect(lpR).connect(crossToL).connect(merger, 0, 0);

    splitter.connect(delayL, 0);
    delayL.connect(lpL).connect(crossToR).connect(merger, 0, 1);

    merger.connect(limiter).connect(this.wetGain).connect(this.output);
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(on ? 0 : 1, now, 0.02);
    this.wetGain.gain.setTargetAtTime(on ? 1 : 0, now, 0.02);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}

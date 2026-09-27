import { mulberry32, type Rng } from './rng';

/**
 * Tiny layer-based synthesis toolkit on top of an OfflineAudioContext.
 * Every sound in the bank is a sum of layers: filtered noise bursts, swept tones, modal
 * (damped-sinusoid) resonators and hand-shaped impulses, each with its own envelope.
 */

export type NoiseColor = 'white' | 'pink' | 'brown' | 'white2' | 'pink2' | 'brown2';
type FType = 'lp' | 'hp' | 'bp' | 'pk' | 'hs' | 'ls' | 'notch';
/** [type, freq, Q, gainDb, sweep] — sweep moves the frequency toward `to` with time constant `tau` from the layer start. */
export type FilterSpec = [FType, number, number?, number?, { to: number; tau: number; delay?: number }?];

const FTYPE: Record<FType, BiquadFilterType> = { lp: 'lowpass', hp: 'highpass', bp: 'bandpass', pk: 'peaking', hs: 'highshelf', ls: 'lowshelf', notch: 'notch' };

const NOISE_SECONDS = 6;
const noiseCache = new Map<number, Record<NoiseColor, AudioBuffer>>();

function genNoise(len: number, color: 'white' | 'pink' | 'brown', rng: Rng): Float32Array {
  const d = new Float32Array(len);
  if (color === 'white') {
    for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
  } else if (color === 'pink') {
    // Paul Kellet's refined pink filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (rng() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  }
  // Normalize to unit RMS-ish peak so colors are interchangeable in level.
  let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const k = 0.95 / (peak || 1);
  for (let i = 0; i < len; i++) d[i] *= k;
  return d;
}

export function noiseBuffers(sr: number): Record<NoiseColor, AudioBuffer> {
  let c = noiseCache.get(sr);
  if (c) return c;
  const rng = mulberry32(0xa11ce);
  const len = Math.floor(sr * NOISE_SECONDS);
  const mk = (color: 'white' | 'pink' | 'brown', ch: number) => {
    const b = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr });
    for (let i = 0; i < ch; i++) b.copyToChannel(genNoise(len, color, rng) as Float32Array<ArrayBuffer>, i);
    return b;
  };
  c = { white: mk('white', 1), pink: mk('pink', 1), brown: mk('brown', 1), white2: mk('white', 2), pink2: mk('pink', 2), brown2: mk('brown', 2) };
  noiseCache.set(sr, c);
  return c;
}

export interface LayerBase {
  t?: number;
  /** Attack time (linear ramp), seconds. 0 = instant. */
  a?: number;
  /** Hold at peak before decay. */
  hold?: number;
  /** Exponential decay time constant (1/e), seconds. -60 dB ≈ 6.9·tau. */
  tau: number;
  gain: number;
  f?: FilterSpec[];
  pan?: number;
  /** tanh saturation drive applied after the envelope. */
  drive?: number;
  dest?: AudioNode;
}

export interface NoiseLayer extends LayerBase { color?: NoiseColor; rate?: number }
export interface ToneLayer extends LayerBase {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  /** Time constant of the exponential pitch glide f0 → f1. */
  sweep?: number;
  /** Vibrato depth (fraction) and rate. */
  vib?: [number, number];
}
export interface Mode { f: number; tau: number; a: number }
export interface ModalLayer { t?: number; modes: Mode[]; gain: number; f?: FilterSpec[]; pan?: number; dest?: AudioNode; drive?: number }

export class Synth {
  readonly out: GainNode;
  readonly sr: number;
  readonly stereo: boolean;
  readonly noiseBuf: Record<NoiseColor, AudioBuffer>;
  private shaperCache = new Map<number, Float32Array<ArrayBuffer>>();

  constructor(readonly ctx: OfflineAudioContext, readonly rng: Rng, readonly dur: number) {
    this.sr = ctx.sampleRate;
    this.stereo = ctx.destination.channelCount > 1;
    this.out = ctx.createGain();
    this.noiseBuf = noiseBuffers(this.sr);
  }

  gainNode(v = 1): GainNode { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  bq(spec: FilterSpec, t0 = 0): BiquadFilterNode {
    const [type, f, q, g, sweep] = spec;
    const b = this.ctx.createBiquadFilter();
    b.type = FTYPE[type];
    const nyq = this.sr * 0.49;
    b.frequency.setValueAtTime(Math.min(f, nyq), 0);
    if (q !== undefined) b.Q.value = q; else b.Q.value = type === 'bp' ? 1 : 0.707;
    if (g !== undefined) b.gain.value = g;
    if (sweep) b.frequency.setTargetAtTime(Math.min(sweep.to, nyq), t0 + (sweep.delay ?? 0), sweep.tau);
    return b;
  }

  shaper(drive: number): WaveShaperNode {
    const ws = this.ctx.createWaveShaper();
    const key = Math.round(drive * 100);
    let curve = this.shaperCache.get(key);
    if (!curve) {
      const n = 4096; curve = new Float32Array(n);
      const norm = Math.tanh(drive);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * drive) / norm; }
      this.shaperCache.set(key, curve);
    }
    ws.curve = curve;
    ws.oversample = 'none'; // oversampling adds latency that would misalign driven vs clean layers
    return ws;
  }

  /** Connect a list of nodes in series, return the last. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Envelope gain node: 0 → peak (linear over a) → hold → exponential decay (tau). Returns node and the time it reaches ~-70 dB. */
  env(t: number, peak: number, a: number, hold: number, tau: number): { node: GainNode; end: number } {
    const g = this.ctx.createGain();
    const p = g.gain;
    p.setValueAtTime(0, 0);
    if (a > 0) { p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a); } else p.setValueAtTime(peak, t);
    if (hold > 0) p.setValueAtTime(peak, t + a + hold);
    p.setTargetAtTime(0, t + a + hold, tau);
    return { node: g, end: t + a + hold + tau * 8 };
  }

  private finish(src: AudioNode, l: LayerBase, t: number, end: number, envNode: GainNode) {
    const nodes: AudioNode[] = [src];
    for (const f of l.f ?? []) nodes.push(this.bq(f, t));
    nodes.push(envNode);
    if (l.drive) nodes.push(this.shaper(l.drive));
    if (this.stereo && l.pan) { const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, l.pan)); nodes.push(p); }
    this.chain(...nodes).connect(l.dest ?? this.out);
    return end;
  }

  noiseL(l: NoiseLayer): number {
    const t = Math.max(0, l.t ?? 0);
    const { node, end } = this.env(t, l.gain, l.a ?? 0, l.hold ?? 0, l.tau);
    const s = this.ctx.createBufferSource();
    const buf = this.noiseBuf[l.color ?? 'white'];
    s.buffer = buf;
    s.loop = true;
    if (l.rate) s.playbackRate.value = l.rate;
    const e = Math.min(end, this.dur);
    s.start(t, this.rng() * (buf.duration - 0.5));
    s.stop(e + 0.01);
    return this.finish(s, l, t, e, node);
  }

  toneL(l: ToneLayer): number {
    const t = Math.max(0, l.t ?? 0);
    const { node, end } = this.env(t, l.gain, l.a ?? 0, l.hold ?? 0, l.tau);
    const o = this.ctx.createOscillator();
    o.type = l.type ?? 'sine';
    o.frequency.setValueAtTime(l.f0, t);
    if (l.f1 !== undefined) o.frequency.setTargetAtTime(l.f1, t, l.sweep ?? 0.05);
    if (l.vib) {
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = l.vib[1];
      const lg = this.gainNode(l.f0 * l.vib[0]);
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t); lfo.stop(Math.min(end, this.dur) + 0.01);
    }
    const e = Math.min(end, this.dur);
    o.start(t); o.stop(e + 0.01);
    return this.finish(o, l, t, e, node);
  }

  /** Bank of damped sinusoids (struck-object resonances) excited at time t. */
  modal(l: ModalLayer): number {
    const t = Math.max(0, l.t ?? 0);
    const bus = this.gainNode(l.gain);
    let end = t;
    for (const m of l.modes) {
      if (m.f >= this.sr * 0.48) continue;
      const o = this.ctx.createOscillator();
      o.frequency.value = m.f;
      // Random start phase via a tiny detune trick is unnecessary: sine starting at 0 is click-free.
      const e = this.env(t, m.a, 0.0004, 0, m.tau);
      const stop = Math.min(e.end, this.dur);
      o.start(t); o.stop(stop + 0.01);
      o.connect(e.node).connect(bus);
      end = Math.max(end, stop);
    }
    const nodes: AudioNode[] = [bus];
    for (const f of l.f ?? []) nodes.push(this.bq(f, t));
    if (l.drive) nodes.push(this.shaper(l.drive));
    if (this.stereo && l.pan) { const p = this.ctx.createStereoPanner(); p.pan.value = l.pan; nodes.push(p); }
    this.chain(...nodes).connect(l.dest ?? this.out);
    return end;
  }

  /**
   * Hand-shaped pressure pulse. 'n' = N-wave (supersonic crack / muzzle shock: sharp rise, linear fall
   * through zero, sharp return), 'click' = single asymmetric spike.
   */
  impulse(o: { t?: number; width: number; gain: number; shape?: 'n' | 'click'; f?: FilterSpec[]; pan?: number; dest?: AudioNode }) {
    const t = Math.max(0, o.t ?? 0);
    const w = Math.max(2, Math.round(o.width * this.sr));
    const n = o.shape === 'click' ? w * 3 : w * 2 + 4;
    const b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: this.sr });
    const d = new Float32Array(n);
    if (o.shape === 'click') {
      for (let i = 0; i < n; i++) { const x = i / w; d[i] = x < 1 ? x : Math.exp(-(x - 1) * 2.2) * Math.cos((x - 1) * 2.5); }
    } else {
      // N-wave: instantaneous rise to +1, linear ramp to -1 over 2w, instantaneous return.
      for (let i = 0; i < 2 * w; i++) d[i] = 1 - i / w;
      d[2 * w] = -0.4; d[2 * w + 1] = -0.1;
    }
    b.copyToChannel(d, 0);
    const s = this.ctx.createBufferSource(); s.buffer = b;
    const g = this.gainNode(o.gain);
    const nodes: AudioNode[] = [s];
    for (const f of o.f ?? []) nodes.push(this.bq(f, t));
    nodes.push(g);
    if (this.stereo && o.pan) { const p = this.ctx.createStereoPanner(); p.pan.value = o.pan; nodes.push(p); }
    this.chain(...nodes).connect(o.dest ?? this.out);
    s.start(t);
  }

  /** Scatter `count` events between t0 and t1 with density falling off exponentially (k = decay per second). */
  scatter(count: number, t0: number, t1: number, k: number, fn: (t: number, i: number, u: number) => void) {
    for (let i = 0; i < count; i++) {
      const u = this.rng();
      // Inverse-CDF of truncated exponential.
      const span = t1 - t0;
      const x = k > 0 ? -Math.log(1 - u * (1 - Math.exp(-k * span))) / k : u * span;
      fn(t0 + x, i, x / span);
    }
  }

  /** Cloth/gear rustle: overlapping short band-limited noise swishes. */
  rustle(t: number, dur: number, gain: number, bright = 1, dest?: AudioNode) {
    const n = Math.max(2, Math.round(dur * 28));
    for (let i = 0; i < n; i++) {
      const tt = t + (i / n) * dur + (this.rng() - 0.5) * 0.02;
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, (tt - t) / dur)));
      this.noiseL({
        t: tt, a: 0.006 + this.rng() * 0.02, tau: 0.012 + this.rng() * 0.03, gain: gain * (0.35 + 0.65 * env) * (0.5 + this.rng()),
        color: 'pink', f: [['bp', (1200 + this.rng() * 3200) * bright, 0.9], ['hp', 350]], pan: (this.rng() - 0.5) * 0.6, dest,
      });
    }
  }
}

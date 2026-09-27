import { mulberry32 } from './rng';

/**
 * Procedural impulse responses (no recorded IRs allowed).
 * Outdoor urban: ground reflection + discrete building slapbacks (40–400 ms) + sparse, darkening diffuse tail.
 * Small interior: dense early reflections, short bright-ish tail, boxy low-mid modes.
 */
export interface IRSpec {
  seconds: number;
  /** RT60 of the diffuse tail. */
  rt60: number;
  /** Diffuse tail onset / fade-in. */
  preDelay: number;
  rise: number;
  /** One-pole lowpass cutoff at start and end of the tail (Hz) — models air/material HF damping over time. */
  lpStart: number;
  lpEnd: number;
  /** Discrete reflections: [delay s, gain, lowpass Hz, pan -1..1]. */
  taps: [number, number, number, number][];
  diffuseGain: number;
  /** Density of the diffuse tail 0..1 (sparse outdoor vs dense indoor). */
  density: number;
  seed: number;
}

export function makeIR(sr: number, spec: IRSpec): AudioBuffer {
  const len = Math.ceil(spec.seconds * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  const rng = mulberry32(spec.seed);
  const decay = Math.log(1000) / spec.rt60; // amplitude e-folding for -60 dB at rt60
  // diffuse tail with time-varying one-pole lowpass per channel
  let yl = 0, yr = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    if (t < spec.preDelay) continue;
    const tt = t - spec.preDelay;
    const env = Math.min(1, tt / spec.rise) * Math.exp(-decay * tt) * spec.diffuseGain;
    const u = Math.min(1, t / spec.seconds);
    const fc = spec.lpStart * Math.pow(spec.lpEnd / spec.lpStart, u);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    const nl = rng() < spec.density ? rng() * 2 - 1 : 0;
    const nr = rng() < spec.density ? rng() * 2 - 1 : 0;
    yl += a * (nl - yl); yr += a * (nr - yr);
    L[i] += yl * env / Math.sqrt(spec.density); R[i] += yr * env / Math.sqrt(spec.density);
  }
  // discrete reflections: short low-passed noise bursts
  for (const [delay, gain, lp, pan] of spec.taps) {
    const start = Math.floor(delay * sr);
    const n = Math.floor(0.004 * sr);
    const a = 1 - Math.exp((-2 * Math.PI * lp) / sr);
    let y = 0;
    const gl = gain * Math.sqrt((1 - pan) / 2) * 1.41, gr = gain * Math.sqrt((1 + pan) / 2) * 1.41;
    for (let k = 0; k < n * 3 && start + k < len; k++) {
      const x = k < n ? (rng() * 2 - 1) * (1 - k / n) : 0;
      y += a * (x - y);
      L[start + k] += y * gl * 3; R[start + k] += y * gr * 3;
    }
  }
  // remove DC
  for (const d of [L, R]) { let m = 0; for (let i = 0; i < len; i++) m += d[i]; m /= len; for (let i = 0; i < len; i++) d[i] -= m; }
  const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: sr });
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  return buf;
}

export function outdoorIR(sr: number): AudioBuffer {
  const r = mulberry32(77);
  const taps: IRSpec['taps'] = [[0.004, 0.5, 6000, 0]];
  let t = 0.045;
  for (let i = 0; i < 9; i++) {
    taps.push([t, 0.35 * Math.pow(0.8, i) * (0.7 + r() * 0.5), 4500 / (1 + i * 0.5), r() * 1.8 - 0.9]);
    t += 0.03 + r() * 0.07 * (1 + i * 0.3);
  }
  return makeIR(sr, { seconds: 2.4, rt60: 1.9, preDelay: 0.03, rise: 0.12, lpStart: 5500, lpEnd: 700, taps, diffuseGain: 0.22, density: 0.25, seed: 11 });
}

export function indoorIR(sr: number): AudioBuffer {
  const r = mulberry32(99);
  const taps: IRSpec['taps'] = [];
  for (let i = 0; i < 26; i++) { const t = 0.002 + r() * 0.03; taps.push([t, (0.5 - t * 10) * (0.5 + r() * 0.5), 3000 + r() * 5000, r() * 2 - 1]); }
  return makeIR(sr, { seconds: 1.0, rt60: 0.6, preDelay: 0.004, rise: 0.012, lpStart: 7000, lpEnd: 1800, taps, diffuseGain: 0.5, density: 1, seed: 21 });
}

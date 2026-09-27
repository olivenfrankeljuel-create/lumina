import * as THREE from 'three';

export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const DEG = Math.PI / 180;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number) => t * t * t;
export const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Damped harmonic spring over N channels. Semi-implicit Euler with fixed sub-steps so it is stable for any dt.
 * stiffness k (1/s^2), damping c (1/s). Critical damping: c = 2*sqrt(k).
 */
export class SpringN {
  readonly value: Float64Array;
  readonly velocity: Float64Array;
  readonly target: Float64Array;
  constructor(public readonly n: number, public stiffness: number, public damping: number) {
    this.value = new Float64Array(n);
    this.velocity = new Float64Array(n);
    this.target = new Float64Array(n);
  }
  static critical(n: number, freqHz: number, dampingRatio = 1): SpringN {
    const w = 2 * Math.PI * freqHz;
    return new SpringN(n, w * w, 2 * dampingRatio * w);
  }
  impulse(i: number, v: number): void { this.velocity[i] += v; }
  update(dt: number): void {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.n; i++) {
        const a = this.stiffness * (this.target[i] - this.value[i]) - this.damping * this.velocity[i];
        this.velocity[i] += a * h;
        this.value[i] += this.velocity[i] * h;
      }
    }
  }
  reset(): void { this.value.fill(0); this.velocity.fill(0); this.target.fill(0); }
}

/** Keyframed curve over N channels with per-key easing (value at key applies from that time). */
export type Key = [t: number, v: number[], ease?: (t: number) => number];

export class Track {
  constructor(public keys: Key[]) {
    keys.sort((a, b) => a[0] - b[0]);
  }
  get duration(): number { return this.keys[this.keys.length - 1][0]; }
  eval(t: number, out: number[] = []): number[] {
    const k = this.keys;
    if (t <= k[0][0]) return copyInto(out, k[0][1]);
    if (t >= k[k.length - 1][0]) return copyInto(out, k[k.length - 1][1]);
    let i = 0;
    while (i < k.length - 1 && k[i + 1][0] < t) i++;
    const a = k[i], b = k[i + 1];
    const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    const e = (b[2] ?? easeInOut)(u);
    const n = a[1].length;
    for (let j = 0; j < n; j++) out[j] = a[1][j] + (b[1][j] - a[1][j]) * e;
    out.length = n;
    return out;
  }
}
function copyInto(out: number[], v: number[]): number[] {
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  out.length = v.length;
  return out;
}

/** Transform (position + euler XYZ in radians) packed as 6 numbers. */
export type Xf = [number, number, number, number, number, number];

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
export function xfToMatrix(x: ArrayLike<number>, out: THREE.Matrix4): THREE.Matrix4 {
  _e.set(x[3], x[4], x[5], 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(new THREE.Vector3(x[0], x[1], x[2]), _q, _s);
}
export function applyXf(obj: THREE.Object3D, x: ArrayLike<number>): void {
  obj.position.set(x[0], x[1], x[2]);
  obj.rotation.set(x[3], x[4], x[5], 'YXZ');
}

/** Value noise 1D, smooth, deterministic (for breathing / idle wander). */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x), f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

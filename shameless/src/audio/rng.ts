/** Small deterministic RNG helpers so every sample bank renders identically run to run. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Uniform in [a, b). */
export const rr = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
/** v scaled by a random factor in [1 - frac, 1 + frac]. */
export const jit = (rng: Rng, v: number, frac: number) => v * (1 + (rng() * 2 - 1) * frac);
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-12, g));

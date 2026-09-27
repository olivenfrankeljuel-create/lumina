/** Tiny fast RNG + helpers used by FX recipes (no allocations). */
let s = 0x9e3779b9 | 0;

export function rand(): number {
  // xorshift32
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return (s >>> 0) / 4294967296;
}
export function seedRand(v: number): void { s = (v | 0) || 1; }
export const range = (a: number, b: number): number => a + (b - a) * rand();
export const chance = (p: number): boolean => rand() < p;
/** Integer count with fractional part resolved stochastically (keeps averages exact when scaled by quality). */
export function count(n: number): number {
  const f = Math.floor(n);
  return f + (rand() < n - f ? 1 : 0);
}

/** Integer hash -> [0,1). */
export function hash1(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

import * as THREE from 'three';

/**
 * Procedural decal atlas (4x4 cells): albedo+alpha (sRGB), tangent normal map (from a height
 * field), and an ORM-style map (R = heat/glow mask, G = roughness, B = metalness).
 * Painted on the CPU once at start-up.
 */
export const ATLAS_GRID = 4;

export const Cell = {
  ConcreteA: 0, ConcreteB: 1, MetalHole: 2, MetalDent: 3,
  WoodA: 4, WoodB: 5, PlasterA: 6, GlassA: 7,
  DirtA: 8, GlassB: 9, BloodA: 10, BloodB: 11,
  BloodDrip: 12, Scorch: 13, PlasterB: 14, SmallHole: 15,
} as const;

// ---------------------------------------------------------------- noise
function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, s: number, oct = 4): number {
  let a = 0.5, t = 0;
  for (let i = 0; i < oct; i++) { t += a * vnoise(x, y, s + i * 17); x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; a *= 0.5; }
  return t;
}
const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(e0: number, e1: number, x: number): number {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

interface Px { h: number; r: number; g: number; b: number; a: number; rough: number; metal: number; heat: number }
type Painter = (x: number, y: number, o: Px, s: number) => void;

// crack network helper: returns 0..1 crack intensity
function cracks(x: number, y: number, s: number, n: number, rMin: number, rMax: number, width: number): number {
  const r = Math.hypot(x, y);
  if (r < rMin || r > rMax) return 0;
  const ang = Math.atan2(y, x);
  let c = 0;
  for (let k = 0; k < n; k++) {
    const a0 = hash2(k, 3, s) * Math.PI * 2;
    const len = mix(rMin + 0.1, rMax, hash2(k, 5, s));
    if (r > len) continue;
    const jit = (vnoise(r * 9 + k * 3.1, k, s) - 0.5) * 0.5;
    let da = ang - a0 - jit;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const dist = Math.abs(da) * r;
    const w = width * (1 - r / len * 0.7);
    c = Math.max(c, smooth(w, 0, dist));
  }
  return c;
}

const concrete = (variant: number): Painter => (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const warp = (fbm(x * 2.2 + variant * 7, y * 2.2, s, 4) - 0.5) * 0.42;
  const rw = r + warp * (0.6 + r);
  const core = smooth(0.15, 0.04, rw + (vnoise(x * 9, y * 9, s + 3) - 0.5) * 0.06);
  const crater = smooth(0.36 + variant * 0.05, 0.2, rw);
  const chipN = fbm(x * 6.5 + 3, y * 6.5, s + 11, 3);
  const chips = smooth(0.62, 0.34, rw) * smooth(0.5, 0.56, chipN);
  const dust = Math.pow(smooth(0.98, 0.22, r + (fbm(x * 3, y * 3, s + 23, 4) - 0.5) * 0.45), 1.3);
  const cr = cracks(x, y, s + variant * 5, 6, 0.18, 0.85, 0.018);
  const grit = fbm(x * 24, y * 24, s + 41, 3);
  o.h = -Math.pow(crater, 1.4) * 0.9 - core * 0.8 + (grit - 0.5) * 0.35 * crater - chips * 0.25 - cr * 0.25;
  // fresh broken concrete is lighter than weathered surfaces; crater gets darker with depth
  const fresh = 0.55 + (grit - 0.5) * 0.25;
  let cr_ = 0.07, cg = 0.066, cb = 0.062; // soot / impact dust
  cr_ = mix(cr_, fresh, chips * 0.95); cg = mix(cg, fresh * 0.97, chips * 0.95); cb = mix(cb, fresh * 0.93, chips * 0.95);
  const craterCol = fresh * mix(0.75, 0.16, Math.pow(crater, 1.5));
  cr_ = mix(cr_, craterCol, crater); cg = mix(cg, craterCol * 0.97, crater); cb = mix(cb, craterCol * 0.93, crater);
  const dark = Math.max(core, cr * 0.85);
  o.r = mix(cr_, 0.012, dark); o.g = mix(cg, 0.012, dark); o.b = mix(cb, 0.012, dark);
  o.a = Math.max(smooth(0.44, 0.3, rw), chips, dust * 0.85 * (0.6 + 0.4 * grit), cr * 0.9);
  o.rough = 0.95; o.metal = 0; o.heat = 0;
};

const metalHole: Painter = (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  const petals = 0.5 + 0.5 * Math.sin(ang * 7 + vnoise(ang * 2, 0, s) * 3);
  const rw = r + (vnoise(x * 6, y * 6, s) - 0.5) * 0.05;
  const hole = smooth(0.11, 0.08, rw);
  const lip = smooth(0.08, 0.13, rw) * smooth(0.26 + petals * 0.05, 0.14, rw);
  const bare = smooth(0.34 + petals * 0.06, 0.2, rw);
  const scorch = smooth(0.62 + (fbm(x * 4, y * 4, s + 9) - 0.5) * 0.3, 0.25, r);
  const scuff = smooth(0.95, 0.4, r + (fbm(x * 5, y * 5, s + 19) - 0.5) * 0.4);
  const scratch = Math.pow(vnoise(ang * 30, r * 3, s + 7), 6) * smooth(0.6, 0.2, r);
  o.h = lip * 0.9 - hole * 1.0 + scratch * 0.1;
  let c = mix(0.05, 0.035, scorch); // scorched paint
  c = mix(c, 0.6, Math.max(bare * 0.9, scratch * 0.5));
  o.r = mix(c, 0.005, hole); o.g = mix(c * 0.99, 0.005, hole); o.b = mix(c * 0.97, 0.005, hole);
  o.a = Math.max(hole, bare, scorch * 0.75, scuff * 0.25);
  o.metal = Math.max(bare, scratch) * (1 - hole);
  o.rough = mix(0.75, 0.3, bare);
  o.heat = smooth(0.3, 0.1, r) * (1 - hole * 0.5);
};

const metalDent: Painter = (x, y, o, s) => {
  const qx = x * 0.55, qy = y * 1.5;
  const q = Math.hypot(qx, qy);
  const dent = smooth(0.5, 0.0, q);
  const scr = Math.pow(vnoise(x * 3, y * 60, s + 3), 4) * smooth(0.6, 0.1, q);
  const scorch = smooth(0.9, 0.3, Math.hypot(x * 0.7, y * 1.2) + (fbm(x * 4, y * 4, s) - 0.5) * 0.3);
  o.h = -dent * 0.7 + scr * 0.15;
  let c = mix(0.06, 0.04, scorch);
  c = mix(c, 0.62, sat(dent * 1.4) * 0.9 + scr * 0.4);
  o.r = c; o.g = c; o.b = c * 0.98;
  o.a = Math.max(smooth(0.55, 0.35, q), scorch * 0.6, scr);
  o.metal = sat(dent * 1.5 + scr);
  o.rough = mix(0.7, 0.28, sat(dent * 1.5));
  o.heat = smooth(0.3, 0.0, q);
};

const wood = (variant: number): Painter => (x, y, o, s) => {
  const qx = x * 1.35, qy = y * 0.75; // elongated along grain (y)
  const q = Math.hypot(qx, qy);
  const fib = vnoise(x * 38, y * 3.2, s + 1) * 0.6 + vnoise(x * 80, y * 6, s + 2) * 0.4;
  const rw = q + (fbm(x * 4, y * 2, s + variant * 13, 3) - 0.5) * 0.3;
  const core = smooth(0.13, 0.05, rw);
  const torn = smooth(0.24 + fib * 0.35, 0.12, rw);
  const dust = smooth(0.8, 0.3, q + (fbm(x * 3, y * 3, s + 5) - 0.5) * 0.4);
  o.h = torn * (fib - 0.3) * 0.8 - core * 1.2 - torn * 0.3;
  const fresh = 0.52 + fib * 0.22;
  let r = 0.09, g = 0.065, b = 0.045;
  r = mix(r, fresh, torn); g = mix(g, fresh * 0.74, torn); b = mix(b, fresh * 0.48, torn);
  o.r = mix(r, 0.03, core); o.g = mix(g, 0.02, core); o.b = mix(b, 0.012, core);
  o.a = Math.max(core, torn, dust * 0.3);
  o.rough = 0.9; o.metal = 0; o.heat = 0;
};

const plaster = (variant: number): Painter => (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const warp = (fbm(x * 2.5, y * 2.5, s + variant * 31, 4) - 0.5) * 0.4;
  const rw = r + warp * (0.5 + r);
  const core = smooth(0.12, 0.03, rw);
  const crater = smooth(0.52, 0.34, rw);
  const powder = smooth(1.0, 0.4, r + (fbm(x * 4, y * 4, s + 3, 4) - 0.5) * 0.55);
  const grit = fbm(x * 20, y * 20, s + 7, 3);
  const cr = cracks(x, y, s + 3, 4, 0.3, 0.8, 0.012);
  o.h = -Math.pow(crater, 1.2) * 0.8 - core * 0.6 + (grit - 0.5) * 0.3 * crater - cr * 0.2;
  const inner = mix(0.55, 0.3, Math.pow(crater, 2)) * (0.9 + grit * 0.2);
  let c = 0.82;
  c = mix(c, inner, crater);
  c = mix(c, 0.03, core);
  c = mix(c, 0.15, cr * 0.7);
  o.r = c; o.g = c * 0.985; o.b = c * 0.96;
  o.a = Math.max(smooth(0.58, 0.46, rw), powder * 0.55, cr * 0.8);
  o.rough = 0.95; o.metal = 0; o.heat = 0;
};

const glass = (variant: number): Painter => (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  const hole = smooth(0.06, 0.035, r);
  const crush = smooth(0.16 + vnoise(ang * 3, 0, s) * 0.06, 0.06, r);
  const radial = cracks(x, y, s + variant * 7, 11, 0.05, 0.98, 0.011);
  // concentric crack segments
  let conc = 0;
  for (let k = 0; k < 3; k++) {
    const rr = 0.24 + k * 0.2 + hash2(k, 1, s) * 0.08;
    const seg = vnoise(ang * 5 + k * 7, k, s + 5) > 0.45 ? 1 : 0;
    conc = Math.max(conc, smooth(0.008, 0, Math.abs(r - rr - (vnoise(ang * 8, k, s) - 0.5) * 0.04)) * seg);
  }
  const lines = Math.max(radial, conc * 0.8);
  o.h = -hole + lines * 0.5 + crush * (vnoise(x * 40, y * 40, s) - 0.5);
  const c = mix(0.75, 0.02, hole);
  o.r = c; o.g = c; o.b = c * 1.02;
  o.a = Math.max(hole, crush * 0.75, lines * 0.9);
  o.rough = 0.15; o.metal = 0; o.heat = 0;
};

const dirt: Painter = (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const rw = r + (fbm(x * 3, y * 3, s, 4) - 0.5) * 0.4;
  const crater = smooth(0.45, 0.1, rw);
  const clumps = smooth(0.55, 0.62, fbm(x * 9, y * 9, s + 4, 3)) * smooth(0.95, 0.4, rw);
  o.h = -crater * 0.8 + clumps * 0.6;
  let r_ = 0.2, g = 0.14, b = 0.09;
  const k = mix(1, 0.45, crater);
  r_ *= k; g *= k; b *= k;
  o.r = r_; o.g = g; o.b = b;
  o.a = Math.max(smooth(0.55, 0.3, rw) * 0.9, clumps * 0.9);
  o.rough = 1; o.metal = 0; o.heat = 0;
};

const blood = (variant: number): Painter => (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  const edge = (fbm(x * 3.5, y * 3.5, s + variant * 11, 4) - 0.5) * 0.35 + (vnoise(ang * 4, 0, s) - 0.5) * 0.12;
  const main = smooth(0.3 + edge, 0.24 + edge, r * (variant === 1 ? 1.2 : 1));
  // radial spatter droplets with tails
  let drops = 0;
  const n = 46;
  for (let k = 0; k < n; k++) {
    const a = hash2(k, 11, s + variant) * Math.PI * 2 + (variant === 1 ? 0 : 0);
    const bias = variant === 1 ? Math.cos(a) * 0.3 : 0;
    const d = mix(0.25, 0.92, Math.pow(hash2(k, 12, s + variant), 0.7)) + bias * 0.1;
    const rad = mix(0.008, 0.045, Math.pow(hash2(k, 13, s + variant), 2.5)) * (1.1 - d * 0.5);
    const cx = Math.cos(a) * d, cy = Math.sin(a) * d;
    // project onto radial axis: elongated tail toward the outside
    const dx = x - cx, dy = y - cy;
    const along = dx * Math.cos(a) + dy * Math.sin(a);
    const across = -dx * Math.sin(a) + dy * Math.cos(a);
    const stretch = along > 0 ? 2.8 : 1.0;
    const q = Math.hypot(along / stretch, across);
    drops = Math.max(drops, smooth(rad, rad * 0.6, q));
  }
  const m = Math.max(main, drops);
  const thick = main * smooth(0.3 + edge, 0.05, r);
  o.h = m * 0.25 + thick * 0.2;
  o.r = mix(0.3, 0.14, thick); o.g = mix(0.012, 0.004, thick); o.b = mix(0.012, 0.006, thick);
  o.a = m * 0.94;
  o.rough = 0.28; o.metal = 0; o.heat = 0;
};

const bloodDrip: Painter = (x, y, o, s) => {
  // splat at top, runs downward (-y)
  const cx = x, cy = y - 0.35;
  const r = Math.hypot(cx, cy);
  const edge = (fbm(x * 4, y * 4, s + 2, 4) - 0.5) * 0.3;
  const splat = smooth(0.32 + edge, 0.26 + edge, r);
  let runs = 0;
  for (let k = 0; k < 6; k++) {
    const rx = mix(-0.25, 0.25, hash2(k, 1, s));
    const len = mix(0.35, 1.2, hash2(k, 2, s));
    const w = mix(0.012, 0.03, hash2(k, 3, s));
    const wob = (vnoise(y * 6, k, s) - 0.5) * 0.03;
    const top = 0.2, bottom = top - len;
    if (y < top && y > bottom - w * 2) {
      const tdrop = smooth(bottom + w * 3, bottom, y); // bulb at the end
      const ww = w * (1 + tdrop * 0.8) * (0.7 + 0.3 * (y - bottom) / len);
      runs = Math.max(runs, smooth(ww, ww * 0.5, Math.abs(x - rx - wob)) * smooth(bottom - w * 2, bottom, y));
    }
  }
  const m = Math.max(splat, runs);
  o.h = m * 0.3;
  o.r = mix(0.28, 0.13, splat); o.g = 0.008; o.b = 0.01;
  o.a = m * 0.93;
  o.rough = 0.25; o.metal = 0; o.heat = 0;
};

const scorch: Painter = (x, y, o, s) => {
  const r = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  const streak = vnoise(ang * 9 / Math.PI, r * 2, s) * 0.6 + vnoise(ang * 23 / Math.PI, r * 4, s + 1) * 0.4;
  const n = fbm(x * 3, y * 3, s + 5, 4);
  const a = smooth(1.0, 0.1, r + (n - 0.5) * 0.35 - (streak - 0.5) * 0.35 * r);
  const center = smooth(0.35, 0.0, r);
  o.h = (n - 0.5) * 0.3 - center * 0.4;
  const c = mix(0.02, 0.05, n) * (1 - center * 0.4);
  o.r = c * 1.05; o.g = c; o.b = c * 0.9;
  o.a = sat(a * 1.05) * 0.95;
  o.rough = 1; o.metal = 0; o.heat = center * 0.6;
};

const smallHole: Painter = (x, y, o, s) => {
  const r = Math.hypot(x, y) + (vnoise(x * 8, y * 8, s) - 0.5) * 0.06;
  const hole = smooth(0.14, 0.07, r);
  const ring = smooth(0.55, 0.15, r);
  o.h = -hole;
  o.r = mix(0.05, 0.01, hole); o.g = o.r; o.b = o.r;
  o.a = Math.max(hole, ring * 0.5);
  o.rough = 0.9; o.metal = 0; o.heat = 0;
};

const PAINTERS: Painter[] = [
  concrete(0), concrete(1), metalHole, metalDent,
  wood(0), wood(1), plaster(0), glass(0),
  dirt, glass(1), blood(0), blood(1),
  bloodDrip, scorch, plaster(1), smallHole,
];
const NORMAL_STRENGTH = [5, 5, 4, 3, 4, 4, 4, 2, 3, 2, 2.5, 2.5, 2.5, 2, 4, 3];

const toSRGB = (c: number) => {
  c = sat(c);
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

export interface DecalAtlas { albedo: THREE.DataTexture; normal: THREE.DataTexture; orm: THREE.DataTexture }

export function generateDecalAtlas(cellSize: number, anisotropy: number): DecalAtlas {
  const C = cellSize, N = ATLAS_GRID, W = C * N;
  const albedo = new Uint8Array(W * W * 4);
  const normal = new Uint8Array(W * W * 4);
  const orm = new Uint8Array(W * W * 4);
  const hgt = new Float32Array(C * C);
  const px: Px = { h: 0, r: 0, g: 0, b: 0, a: 0, rough: 1, metal: 0, heat: 0 };
  const margin = 1.06; // leave transparent border for mip safety
  for (let cell = 0; cell < N * N; cell++) {
    const paint = PAINTERS[cell];
    const cx = (cell % N) * C, cy = Math.floor(cell / N) * C;
    const seed = 101 + cell * 37;
    for (let j = 0; j < C; j++) {
      for (let i = 0; i < C; i++) {
        const x = ((i + 0.5) / C * 2 - 1) * margin;
        const y = ((j + 0.5) / C * 2 - 1) * margin;
        px.h = 0; px.a = 0; px.heat = 0;
        paint(x, y, px, seed);
        const border = smooth(1.0, 0.94, Math.max(Math.abs(x), Math.abs(y)));
        const o = ((cy + j) * W + cx + i) * 4;
        albedo[o] = toSRGB(px.r); albedo[o + 1] = toSRGB(px.g); albedo[o + 2] = toSRGB(px.b);
        albedo[o + 3] = Math.round(sat(px.a * border) * 255);
        orm[o] = Math.round(sat(px.heat) * 255); orm[o + 1] = Math.round(sat(px.rough) * 255); orm[o + 2] = Math.round(sat(px.metal) * 255); orm[o + 3] = 255;
        hgt[j * C + i] = px.h * border;
      }
    }
    const k = NORMAL_STRENGTH[cell] * (C / 256);
    for (let j = 0; j < C; j++) {
      for (let i = 0; i < C; i++) {
        const l = hgt[j * C + Math.max(i - 1, 0)], r = hgt[j * C + Math.min(i + 1, C - 1)];
        const d = hgt[Math.max(j - 1, 0) * C + i], u = hgt[Math.min(j + 1, C - 1) * C + i];
        let nx = -(r - l) * 0.5 * k * 8 / (C / 64), ny = -(u - d) * 0.5 * k * 8 / (C / 64), nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
        const o = ((cy + j) * W + cx + i) * 4;
        normal[o] = Math.round((nx * 0.5 + 0.5) * 255); normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255); normal[o + 3] = 255;
      }
    }
  }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(albedo, true), normal: mk(normal, false), orm: mk(orm, false) };
}

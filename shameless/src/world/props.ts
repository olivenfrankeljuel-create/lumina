import * as THREE from 'three';
import { mk } from './builder';
import type { WCtx } from './context';
import { RNG } from './rng';
import { cylBetween, corrugated, extrudeProfile, displace, paint, roundedBox, twoSided, catenary, tubeAlong } from './geo';
import { D } from './textures';

/** Reusable prop generators. Coordinates: (x, y, z) = base centre on the ground, ry = yaw. */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Local->world helper for a prop frame. */
export class Frame {
  readonly c: number;
  readonly s: number;
  constructor(readonly x: number, readonly y: number, readonly z: number, readonly ry: number) {
    this.c = Math.cos(ry);
    this.s = Math.sin(ry);
  }
  /** local (lx, ly, lz) -> world */
  p(lx: number, ly: number, lz: number): THREE.Vector3 {
    return new THREE.Vector3(this.x + lx * this.c + lz * this.s, this.y + ly, this.z - lx * this.s + lz * this.c);
  }
  wx(lx: number, lz: number) { return this.x + lx * this.c + lz * this.s; }
  wz(lx: number, lz: number) { return this.z - lx * this.s + lz * this.c; }
  /** local direction -> world */
  d(lx: number, lz: number): THREE.Vector3 {
    return new THREE.Vector3(lx * this.c + lz * this.s, 0, -lx * this.s + lz * this.c);
  }
}

/** Box in a prop frame: local centre + size + extra local rotation. */
export function fb(w: WCtx, f: Frame, key: string, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, col: boolean = false, rx = 0, rz = 0, ry = 0) {
  w.b.box(key, f.wx(lx, lz), f.y + ly, f.wz(lx, lz), sx, sy, sz, { ry: f.ry + ry, rx, rz, col });
}

/** Add geometry defined in a prop frame's local space. */
export function fg(w: WCtx, f: Frame, key: string, g: THREE.BufferGeometry, lx = 0, ly = 0, lz = 0, ry = 0, rx = 0, rz = 0, uv: 'world' | 'keep' = 'world') {
  w.b.addT(key, g, f.wx(lx, lz), f.y + ly, f.wz(lx, lz), f.ry + ry, rx, rz, 1, 1, 1, uv);
}

/** Cover points on both long sides of an oriented footprint (local X = length). */
export function coverSides(w: WCtx, f: Frame, halfLen: number, halfDepth: number, both = true, ends = false) {
  const off = halfDepth + 0.55;
  const xs = halfLen > 1.2 ? [-halfLen * 0.55, halfLen * 0.55] : [0];
  for (const lx of xs) {
    const p = f.p(lx, 0, off), n = f.d(0, 1);
    w.addCover(p.x, f.y, p.z, n.x, n.z);
    if (both) {
      const q = f.p(lx, 0, -off), m = f.d(0, -1);
      w.addCover(q.x, f.y, q.z, m.x, m.z);
    }
  }
  if (ends) {
    for (const sgn of [-1, 1]) {
      const p = f.p(sgn * (halfLen + 0.55), 0, 0), n = f.d(sgn, 0);
      w.addCover(p.x, f.y, p.z, n.x, n.z);
    }
  }
}

// ------------------------------------------------------------------ crates / pallets / barrels
export function crate(w: WCtx, x: number, y: number, z: number, ry: number, sx = 1, sy = 0.8, sz = 0.8, kind: 'wood' | 'mil' | 'ply' = 'wood', col = true, v = 0) {
  const f = new Frame(x, y, z, ry);
  const body = kind === 'mil' ? mk('metal_painted_green', v % 3) : kind === 'ply' ? mk('plywood', v % 3) : mk('wood_planks', v % 4);
  const trim = kind === 'mil' ? mk('metal_painted_green', (v + 1) % 3) : kind === 'ply' ? mk('wood_pallet', v % 2) : mk('wood_pallet', v % 3);
  fb(w, f, body, 0, sy / 2, 0, sx - 0.04, sy - 0.04, sz - 0.04, false);
  const t = 0.05;
  // edge battens
  for (const sxn of [-1, 1]) for (const szn of [-1, 1]) fb(w, f, trim, sxn * (sx / 2 - t / 2), sy / 2, szn * (sz / 2 - t / 2), t, sy, t);
  for (const syn of [0, 1]) {
    const yy = syn ? sy - t / 2 : t / 2;
    fb(w, f, trim, 0, yy, sz / 2 - t / 2, sx - t * 2, t, t);
    fb(w, f, trim, 0, yy, -sz / 2 + t / 2, sx - t * 2, t, t);
    fb(w, f, trim, sx / 2 - t / 2, yy, 0, t, t, sz - t * 2);
    fb(w, f, trim, -sx / 2 + t / 2, yy, 0, t, t, sz - t * 2);
  }
  if (kind === 'wood' && sx > 0.7) {
    // diagonal brace on the long faces
    const diag = Math.hypot(sx - 0.1, sy - 0.1);
    const a = Math.atan2(sy - 0.1, sx - 0.1);
    fb(w, f, trim, 0, sy / 2, sz / 2 - 0.005, diag, 0.07, 0.03, false, 0, a);
    fb(w, f, trim, 0, sy / 2, -sz / 2 + 0.005, diag, 0.07, 0.03, false, 0, -a);
  }
  if (kind === 'mil') {
    // handles + stencil band
    fb(w, f, mk('metal_bare', 1), sx / 2 + 0.015, sy * 0.6, 0, 0.03, 0.04, 0.2);
    fb(w, f, mk('metal_bare', 1), -sx / 2 - 0.015, sy * 0.6, 0, 0.03, 0.04, 0.2);
    fb(w, f, mk('metal_bare', 0), 0, sy * 0.5, sz / 2 + 0.004, sx * 0.3, 0.03, 0.01);
  }
  if (col) w.b.colBox(x, y + sy / 2, z, sx, sy, sz, kind === 'mil' ? 'metal' : 'wood', ry);
}

export function crateStack(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, big = false) {
  const f = new Frame(x, y, z, ry);
  const n = big ? rng.int(3, 5) : rng.int(2, 3);
  let lx = 0;
  const kinds: ('wood' | 'mil' | 'ply')[] = ['wood', 'wood', 'mil', 'ply'];
  const kind = rng.pick(kinds);
  const placed: { lx: number; s: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.8, 1.15), h = rng.range(0.7, 1.0);
    const p = f.p(lx + s / 2, 0, rng.jit(0.1));
    crate(w, p.x, y, p.z, ry + rng.jit(0.12), s, h, rng.range(0.8, 1.05), kind, true, rng.int(0, 3));
    placed.push({ lx: lx + s / 2, s, h });
    lx += s + 0.04;
  }
  // second tier
  for (let i = 0; i < placed.length - 1; i++) {
    if (!rng.chance(big ? 0.7 : 0.45)) continue;
    const a = placed[i];
    const s = rng.range(0.7, 0.95);
    const p = f.p(a.lx + a.s * 0.3, 0, rng.jit(0.08));
    crate(w, p.x, y + a.h, p.z, ry + rng.jit(0.2), s, rng.range(0.6, 0.85), s * 0.9, kind, true, rng.int(0, 3));
  }
  const cf = new Frame(f.wx(lx / 2, 0), y, f.wz(lx / 2, 0), ry);
  coverSides(w, cf, lx / 2, 0.5, true, false);
}

export function pallet(w: WCtx, x: number, y: number, z: number, ry: number, v = 0) {
  const f = new Frame(x, y, z, ry);
  const key = mk('wood_pallet', v % 3);
  const L = 1.2, W = 1.0;
  for (let i = 0; i < 3; i++) fb(w, f, key, 0, 0.05, -W / 2 + 0.05 + i * (W - 0.1) / 2, L, 0.1, 0.1); // stringers
  for (let i = 0; i < 7; i++) fb(w, f, key, -L / 2 + 0.07 + i * (L - 0.14) / 6, 0.12, 0, 0.12, 0.022, W); // top deck
  for (let i = 0; i < 3; i++) fb(w, f, key, -L / 2 + 0.07 + i * (L - 0.14) / 2, 0.011, 0, 0.12, 0.022, W);
}

export function palletStack(w: WCtx, x: number, y: number, z: number, ry: number, n: number, rng: RNG) {
  for (let i = 0; i < n; i++) pallet(w, x + rng.jit(0.05), y + i * 0.144, z + rng.jit(0.05), ry + rng.jit(0.08), rng.int(0, 2));
  w.b.colBox(x, y + n * 0.072, z, 1.2, n * 0.144, 1.0, 'wood', ry);
}

const BARREL_MATS = ['metal_painted_blue', 'metal_painted_green', 'metal_rusty', 'metal_rusty', 'metal_painted_blue'] as const;
export function barrel(w: WCtx, x: number, y: number, z: number, rng: RNG, tipped = false, ry = 0) {
  const key = mk(rng.pick(BARREL_MATS), rng.int(0, 3));
  const r = 0.29, h = 0.88;
  const body = new THREE.CylinderGeometry(r, r, h, 14, 1, false);
  body.translate(0, h / 2, 0);
  // ribs
  const ribs: THREE.BufferGeometry[] = [];
  for (const yy of [0.02, h * 0.33, h * 0.66, h - 0.02]) {
    const t = new THREE.TorusGeometry(r + 0.004, 0.012, 4, 14);
    t.rotateX(Math.PI / 2);
    t.translate(0, yy, 0);
    ribs.push(t);
  }
  const lid = new THREE.CylinderGeometry(r * 0.12, r * 0.12, 0.02, 6);
  lid.translate(r * 0.55, h + 0.01, 0);
  const place = (g: THREE.BufferGeometry, k: string) => {
    if (tipped) w.b.addT(k, g, x, y + r, z, ry, 0, Math.PI / 2);
    else w.b.addT(k, g, x, y, z, ry, 0, 0, 1, 1, 1, 'keep');
  };
  // Scale cylinder UVs to meters so textures do not stretch.
  scaleUV(body, 2 * Math.PI * r, h);
  place(body, key);
  for (const t of ribs) place(t, key);
  place(lid, mk('metal_bare', 1));
  if (tipped) {
    w.b.colBox(x, y + r, z, h, r * 2, r * 2, 'metal', ry);
  } else w.b.colBox(x, y + h / 2, z, r * 1.8, h, r * 1.8, 'metal');
}

export function scaleUV(g: THREE.BufferGeometry, su: number, sv: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

export function barrelGroup(w: WCtx, x: number, y: number, z: number, rng: RNG) {
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.jit(0.3), rr = n === 1 ? 0 : 0.36 + rng.next() * 0.1;
    barrel(w, x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, rng);
  }
  if (rng.chance(0.4)) barrel(w, x + rng.jit(1.2) + 1.1, y, z + rng.jit(0.8), rng, true, rng.range(0, 6));
}

export function gasCylinder(w: WCtx, x: number, y: number, z: number, rng: RNG, lying = false) {
  const key = mk(rng.pick(['metal_painted_blue', 'metal_painted_green', 'metal_rusty'] as const), rng.int(0, 2));
  const g = new THREE.CylinderGeometry(0.15, 0.15, 0.95, 10);
  g.translate(0, 0.475, 0);
  const top = new THREE.SphereGeometry(0.15, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  top.translate(0, 0.95, 0);
  const valve = new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6);
  valve.translate(0, 1.12, 0);
  const collar = new THREE.CylinderGeometry(0.1, 0.1, 0.12, 8, 1, true);
  collar.translate(0, 1.1, 0);
  scaleUV(g, 0.94, 0.95);
  const rz = lying ? Math.PI / 2 : 0;
  const yy = lying ? y + 0.15 : y;
  const ry = rng.range(0, 6.28);
  w.b.addT(key, g, x, yy, z, ry, 0, rz, 1, 1, 1, 'keep');
  w.b.addT(key, top, x, yy, z, ry, 0, rz);
  w.b.addT(mk('metal_bare', 2), valve, x, yy, z, ry, 0, rz);
  w.b.addT(mk('metal_bare', 2), collar, x, yy, z, ry, 0, rz);
}

export function tire(w: WCtx, x: number, y: number, z: number, lying: boolean, ry = 0, rx = 0) {
  const g = new THREE.TorusGeometry(0.3, 0.11, 8, 16);
  scaleUV(g, 2, 0.5);
  if (lying) w.b.addT(mk('rubber', 0), g, x, y + 0.11, z, ry, Math.PI / 2 + rx, 0, 1, 1, 1.25, 'keep');
  else w.b.addT(mk('rubber', 0), g, x, y + 0.41, z, ry, rx, 0, 1, 1, 1.25, 'keep');
}

export function tireStack(w: WCtx, x: number, y: number, z: number, rng: RNG) {
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) tire(w, x + rng.jit(0.06), y + i * 0.27, z + rng.jit(0.06), true, 0, rng.jit(0.05));
  w.b.colBox(x, y + n * 0.135, z, 0.82, n * 0.27, 0.82, 'fabric');
  if (rng.chance(0.5)) tire(w, x + 0.75, y, z + rng.jit(0.3), false, rng.range(0, 3), -0.25);
}

// ------------------------------------------------------------------ barriers
export function jersey(w: WCtx, x: number, y: number, z: number, ry: number, len = 3, v = 0, cover = true) {
  const prof: [number, number][] = [[-0.3, 0], [0.3, 0], [0.3, 0.07], [0.12, 0.3], [0.08, 0.81], [-0.08, 0.81], [-0.12, 0.3], [-0.3, 0.07]];
  const g = extrudeProfile(prof, len, 0.01);
  // profile in XY, extruded along Z -> rotate so length runs along local X
  g.rotateY(Math.PI / 2);
  const f = new Frame(x, y, z, ry);
  fg(w, f, mk(v % 2 ? 'concrete_dirty' : 'concrete', v % 4), g);
  // lifting loops + scuffs
  fb(w, f, mk('metal_rusty', 0), -len / 2 + 0.4, 0.83, 0, 0.1, 0.05, 0.02);
  fb(w, f, mk('metal_rusty', 0), len / 2 - 0.4, 0.83, 0, 0.1, 0.05, 0.02);
  w.b.colBox(f.wx(0, 0), y + 0.4, f.wz(0, 0), len, 0.81, 0.42, 'concrete', ry);
  if (cover) coverSides(w, f, len / 2, 0.3);
}

/** Pillow-shaped sandbag template (0.55 x 0.14 x 0.32). */
let bagTemplate: THREE.BufferGeometry | null = null;
function bagGeo(): THREE.BufferGeometry {
  if (!bagTemplate) {
    const g = new THREE.BoxGeometry(1, 1, 1, 4, 2, 3);
    displace(g, (v) => {
      const ax = Math.abs(v.x * 2), az = Math.abs(v.z * 2), ay = Math.abs(v.y * 2);
      const edge = Math.max(ax, az);
      const pinch = 1 - 0.45 * Math.pow(edge, 3);
      v.y *= pinch;
      v.x *= 1 - 0.08 * ay * ay;
      v.z *= 1 - 0.18 * ay * ay;
      v.x *= 0.55;
      v.y *= 0.16;
      v.z *= 0.32;
      if (ax > 0.9) v.y *= 0.8;
    });
    bagTemplate = g;
  }
  return bagTemplate.clone();
}

export function sandbagWall(w: WCtx, x: number, y: number, z: number, ry: number, len: number, rows: number, rng: RNG, curve = 0, cover = true) {
  const f = new Frame(x, y, z, ry);
  const per = Math.max(1, Math.round(len / 0.52));
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? 0.26 : 0;
    const n = per - (r % 2 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const lx = -len / 2 + 0.26 + off + i * (len - 0.52) / Math.max(1, per - 1);
      const lz = curve * (lx * lx) / Math.max(1, len * len / 4) + rng.jit(0.02);
      const k = mk('sandbag', rng.int(0, 3));
      const g = bagGeo();
      fg(w, f, k, g, lx + rng.jit(0.02), 0.075 + r * 0.125, lz, rng.jit(0.06) + (curve ? -Math.atan(2 * curve * lx / (len * len / 4)) : 0), rng.jit(0.04), rng.jit(0.05));
    }
    // cross-bags (headers) on the back row for depth on low walls
  }
  // second (back) course for thicker walls
  if (rows >= 3) {
    for (let r = 0; r < rows - 1; r++) {
      const n = per - 1;
      for (let i = 0; i < n; i++) {
        const lx = -len / 2 + 0.52 + i * (len - 1.04) / Math.max(1, n - 1);
        const lz = -0.3 + curve * (lx * lx) / Math.max(1, len * len / 4);
        fg(w, f, mk('sandbag', rng.int(0, 3)), bagGeo(), lx, 0.075 + r * 0.125, lz, rng.jit(0.08), 0, rng.jit(0.04));
      }
    }
  }
  const h = rows * 0.125 + 0.03;
  w.b.colBox(f.wx(0, rows >= 3 ? -0.15 : 0), y + h / 2, f.wz(0, rows >= 3 ? -0.15 : 0), len, h, rows >= 3 ? 0.65 : 0.34, 'sand', ry);
  if (cover) coverSides(w, f, len / 2, 0.35);
}

/** Sandbag ring / U-shaped position. */
export function sandbagNest(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG) {
  const f = new Frame(x, y, z, ry);
  sandbagWall(w, f.wx(0, -1.2), y, f.wz(0, -1.2), ry, 3.2, 6, rng, 0, false);
  sandbagWall(w, f.wx(-1.75, 0), y, f.wz(-1.75, 0), ry + Math.PI / 2, 2.2, 6, rng, 0, false);
  sandbagWall(w, f.wx(1.75, 0), y, f.wz(1.75, 0), ry - Math.PI / 2, 2.2, 6, rng, 0, false);
  const p = f.p(0, 0, -0.4), n = f.d(0, 1);
  w.addCover(p.x, y, p.z, n.x, n.z);
  const q = f.p(0, 0, -2.2), m = f.d(0, -1);
  w.addCover(q.x, y, q.z, m.x, m.z);
}

export function hesco(w: WCtx, x: number, y: number, z: number, ry: number, n: number, rng: RNG, size = 1.1, cover = true) {
  const f = new Frame(x, y, z, ry);
  const wire = mk('metal_bare', 3);
  const liner = mk('canvas', rng.int(0, 2));
  const h = size * 1.0;
  for (let i = 0; i < n; i++) {
    const cx = -((n - 1) * size) / 2 + i * size;
    // bulging liner
    const g = new THREE.BoxGeometry(size - 0.04, h - 0.02, size - 0.04, 4, 4, 4);
    displace(g, (v) => {
      const b = 1 + 0.06 * (1 - Math.pow(Math.abs(v.y / (h / 2)), 2));
      v.x *= b;
      v.z *= b;
    });
    fg(w, f, liner, g, cx, h / 2, 0, rng.jit(0.02));
    // sand fill on top
    fb(w, f, mk('sand', 0), cx, h - 0.02, 0, size - 0.1, 0.04, size - 0.1);
    // wire mesh grid
    const gs = size / 4;
    for (const sz of [-1, 1]) {
      for (let k = 0; k <= 4; k++) {
        fb(w, f, wire, cx - size / 2 + k * gs, h / 2, sz * (size / 2 + 0.01), 0.012, h, 0.012);
        fb(w, f, wire, cx, (k * h) / 4, sz * (size / 2 + 0.01), size, 0.012, 0.012);
      }
    }
    for (const sx of [-1, 1]) {
      if (i > 0 && sx === -1) continue;
      for (let k = 0; k <= 4; k++) {
        fb(w, f, wire, cx + sx * (size / 2 + 0.01), h / 2, -size / 2 + k * gs, 0.012, h, 0.012);
        fb(w, f, wire, cx + sx * (size / 2 + 0.01), (k * h) / 4, 0, 0.012, 0.012, size);
      }
    }
  }
  w.b.colBox(x, y + h / 2, z, n * size, h, size, 'sand', ry);
  if (cover) coverSides(w, f, (n * size) / 2, size / 2);
}

// ------------------------------------------------------------------ rubble / debris / trash
export function rubble(w: WCtx, x: number, y: number, z: number, radius: number, rng: RNG, brick = true, col = true) {
  const h = radius * rng.range(0.35, 0.55);
  const mound = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  const seed = rng.range(0, 100);
  displace(mound, (v) => {
    const n = Math.sin(v.x * 5 + seed) * Math.cos(v.z * 4.3 + seed) * 0.12 + Math.sin(v.x * 11 + v.z * 9) * 0.05;
    v.x *= radius * (1 + n);
    v.z *= radius * (1 + n * 0.8);
    v.y = v.y * h * (1 + n * 1.5);
  });
  w.b.addT(mk(rng.chance(0.5) ? 'gravel' : 'concrete_dirty', rng.int(0, 3)), mound, x, y - 0.02, z);
  const n = Math.round(radius * radius * 10);
  const brickKey = mk(rng.chance(0.5) ? 'brick_red' : 'brick_tan', rng.int(0, 2));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * radius * 1.05;
    const hh = h * Math.max(0, 1 - (r / radius) ** 2) * 0.9;
    const big = rng.chance(0.15);
    const s = big ? rng.range(0.35, 0.7) : rng.range(0.1, 0.28);
    const key = brick && rng.chance(0.5) ? brickKey : mk('concrete', rng.int(0, 3));
    w.b.box(key, x + Math.cos(a) * r, y + hh + s * 0.25, z + Math.sin(a) * r, s * rng.range(0.8, 1.6), s * rng.range(0.4, 0.8), s * rng.range(0.7, 1.2), { ry: rng.range(0, 3), rx: rng.jit(0.6), rz: rng.jit(0.6) });
  }
  // rebar sticking out
  for (let i = 0; i < Math.round(radius * 2); i++) {
    const a = rng.range(0, 6.28), r = rng.next() * radius * 0.6;
    const p0 = V(x + Math.cos(a) * r, y + h * 0.4, z + Math.sin(a) * r);
    const p1 = p0.clone().add(V(rng.jit(0.8), rng.range(0.3, 1.1), rng.jit(0.8)));
    w.b.add(mk('metal_rusty', 1), cylBetween(p0, p1, 0.008, 4));
  }
  if (col && radius > 0.7) {
    w.b.colBox(x, y + h * 0.35, z, radius * 1.3, h * 0.7, radius * 1.3, 'gravel', rng.range(0, 3));
    if (h > 0.6) w.b.colBox(x, y + h * 0.7, z, radius * 0.7, h * 0.6, radius * 0.7, 'gravel');
  }
  w.decal(D.DIRT, V(x, y + 0.01, z), V(0, 1, 0), radius * 3.2, radius * 3.2, rng.range(0, 6));
}

export function debris(w: WCtx, x: number, y: number, z: number, spread: number, n: number, rng: RNG) {
  for (let i = 0; i < n; i++) {
    const px = x + rng.jit(spread), pz = z + rng.jit(spread);
    const t = rng.next();
    if (t < 0.35) w.b.box(mk('brick_red', rng.int(0, 2)), px, y + 0.035, pz, 0.22, 0.065, 0.1, { ry: rng.range(0, 3), rz: rng.jit(0.2) });
    else if (t < 0.6) w.b.box(mk('concrete', rng.int(0, 3)), px, y + 0.04, pz, rng.range(0.08, 0.3), rng.range(0.04, 0.12), rng.range(0.08, 0.25), { ry: rng.range(0, 3), rx: rng.jit(0.3) });
    else if (t < 0.75) w.b.box(mk('wood_planks', rng.int(0, 3)), px, y + 0.015, pz, rng.range(0.6, 1.8), 0.025, 0.1, { ry: rng.range(0, 3), rz: rng.jit(0.1) });
    else if (t < 0.85) { // cinder block
      w.b.box(mk('concrete', rng.int(0, 3)), px, y + 0.1, pz, 0.4, 0.2, 0.2, { ry: rng.range(0, 3) });
    } else if (t < 0.93) { // bottle
      const g = new THREE.CylinderGeometry(0.035, 0.035, 0.25, 6);
      w.b.addT(mk('glass_dirty', 0), g, px, y + 0.035, pz, rng.range(0, 3), 0, Math.PI / 2);
    } else { // can
      const g = new THREE.CylinderGeometry(0.033, 0.033, 0.12, 8);
      w.b.addT(mk('metal_bare', 2), g, px, y + 0.033, pz, rng.range(0, 3), 0, Math.PI / 2);
    }
  }
}

export function trashBags(w: WCtx, x: number, y: number, z: number, n: number, rng: RNG) {
  for (let i = 0; i < n; i++) {
    const g = new THREE.SphereGeometry(0.3, 10, 7);
    const seed = rng.range(0, 10);
    displace(g, (v) => {
      v.y *= v.y > 0 ? 0.9 : 0.55;
      const k = 1 + Math.sin(v.x * 17 + seed) * 0.08 + Math.cos(v.z * 13 + seed) * 0.08;
      v.x *= k; v.z *= k;
      if (v.y > 0.22) { v.x *= 0.5; v.z *= 0.5; } // tied neck
    });
    const s = rng.range(0.8, 1.2);
    w.b.addT(mk(rng.chance(0.8) ? 'plastic_black' : 'tarp', rng.int(0, 2)), g, x + rng.jit(0.5), y + 0.14 * s, z + rng.jit(0.5), rng.range(0, 6), rng.jit(0.3), rng.jit(0.3), s, s, s);
  }
  w.decal(D.PAPERS, V(x, y + 0.012, z), V(0, 1, 0), 2.2, 2.2, rng.range(0, 6));
}

export function cardboard(w: WCtx, x: number, y: number, z: number, rng: RNG, n = 3) {
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.3, 0.6);
    const flat = rng.chance(0.3);
    w.b.box(mk('plywood', 2 + (i % 2)), x + rng.jit(0.5), y + (flat ? 0.01 : s * 0.4), z + rng.jit(0.5), s, flat ? 0.02 : s * 0.8, s * 0.8, { ry: rng.range(0, 3) });
  }
}

export function cinderStack(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG) {
  const f = new Frame(x, y, z, ry);
  const rows = rng.int(2, 5);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      if (r === rows - 1 && rng.chance(0.3)) continue;
      fb(w, f, mk('concrete', (r + i) % 3), -0.41 + i * 0.41, 0.1 + r * 0.2, -0.1 + j * 0.2, 0.39, 0.19, 0.19, false, 0, 0, rng.jit(0.03));
    }
  }
  w.b.colBox(x, y + rows * 0.1, z, 1.2, rows * 0.2, 0.4, 'concrete', ry);
}

// ------------------------------------------------------------------ utility boxes, AC, tanks, dishes
export function acUnit(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, wallMount = false) {
  const f = new Frame(x, y, z, ry);
  const body = mk(rng.chance(0.6) ? 'metal_bare' : 'metal_painted_blue', rng.int(0, 3));
  const W = 0.82, H = 0.56, Dp = 0.3;
  fg(w, f, body, roundedBox(W, H, Dp, 0.03, 1), 0, H / 2 + 0.05, 0);
  // fan grille
  const ring = new THREE.TorusGeometry(0.2, 0.012, 4, 16);
  fg(w, f, mk('plastic_black', 0), ring, -0.14, H / 2 + 0.05, Dp / 2 + 0.005);
  const disc = new THREE.CircleGeometry(0.2, 16);
  fg(w, f, mk('plastic_black', 1), disc, -0.14, H / 2 + 0.05, Dp / 2 - 0.02);
  for (let i = -3; i <= 3; i++) fb(w, f, mk('metal_bare', 1), -0.14 + i * 0.055, H / 2 + 0.05, Dp / 2 + 0.008, 0.008, 0.4 - Math.abs(i) * 0.03, 0.008);
  // side vents
  for (let i = 0; i < 5; i++) fb(w, f, mk('plastic_black', 0), 0.26, 0.15 + i * 0.08, Dp / 2 + 0.003, 0.2, 0.02, 0.006);
  if (wallMount) {
    // L brackets to the wall behind (-z)
    for (const sx of [-0.3, 0.3]) {
      fb(w, f, mk('metal_rusty', 0), sx, 0.02, -0.05, 0.04, 0.04, Dp + 0.2);
      fb(w, f, mk('metal_rusty', 0), sx, 0.25, -Dp / 2 - 0.05, 0.04, 0.5, 0.04);
    }
    // refrigerant pipes going into the wall
    fb(w, f, mk('metal_bare', 2), W / 2 + 0.03, H / 2, -0.1, 0.03, 0.03, 0.25);
    w.decal(D.RUST, f.p(0, -0.35, -Dp / 2 - 0.19), f.d(0, 1), 0.8, 1.2, 0, 0.012);
  } else {
    // feet
    for (const sx of [-0.33, 0.33]) fb(w, f, mk('metal_rusty', 0), sx, 0.025, 0, 0.06, 0.05, Dp + 0.1);
  }
}

export function waterTank(w: WCtx, x: number, y: number, z: number, rng: RNG, onStand = true) {
  const f = new Frame(x, y, z, rng.range(0, 6));
  const r = rng.range(0.5, 0.68), h = rng.range(1.1, 1.5);
  const standH = onStand ? rng.range(0.6, 1.3) : 0.15;
  const key = rng.chance(0.65) ? mk('plastic_black', rng.int(0, 2)) : rng.chance(0.5) ? mk('metal_bare', rng.int(0, 3)) : mk('metal_painted_blue', rng.int(0, 2));
  const g = new THREE.CylinderGeometry(r, r * 1.02, h, 18, 3);
  // plastic tank ribs
  displace(g, (v) => {
    const rib = 1 + 0.02 * Math.cos((v.y / h) * Math.PI * 6);
    v.x *= rib; v.z *= rib;
  });
  scaleUV(g, 2 * Math.PI * r, h);
  fg(w, f, key, g, 0, standH + h / 2, 0, 0, 0, 0, 'keep');
  const dome = new THREE.SphereGeometry(r, 18, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.25, 1);
  fg(w, f, key, dome, 0, standH + h, 0);
  const cap = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 10);
  fg(w, f, key, cap, 0, standH + h + r * 0.25, 0);
  if (onStand) {
    const s = mk('metal_rusty', rng.int(0, 2));
    const e = r * 0.8;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) fb(w, f, s, sx * e, standH / 2, sz * e, 0.05, standH, 0.05);
    fb(w, f, s, 0, standH - 0.03, 0, e * 2 + 0.1, 0.05, e * 2 + 0.1);
    fb(w, f, s, 0, standH * 0.4, e, e * 2, 0.04, 0.04);
    fb(w, f, s, 0, standH * 0.4, -e, e * 2, 0.04, 0.04);
  } else {
    fb(w, f, mk('concrete', 1), 0, 0.075, 0, r * 2 + 0.1, 0.15, r * 2 + 0.1);
  }
  // outlet pipe
  const p0 = f.p(r * 0.9, standH + 0.1, 0), p1 = f.p(r * 0.9 + 0.3, standH + 0.1, 0);
  const p2 = f.p(r * 0.9 + 0.3, 0.05, 0);
  w.b.add(mk('metal_bare', 2), cylBetween(p0, p1, 0.025, 6));
  w.b.add(mk('metal_bare', 2), cylBetween(p1, p2, 0.025, 6));
  w.b.colBox(x, y + (standH + h) / 2, z, r * 1.8, standH + h, r * 1.8, 'metal');
}

export function satDish(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, onWall = false) {
  const f = new Frame(x, y, z, ry);
  const R = rng.range(0.3, 0.45);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) { const r = (i / 6) * R; pts.push(new THREE.Vector2(r, (r * r) / (R * 2.5))); }
  const dish = new THREE.LatheGeometry(pts, 16);
  const dish2 = twoSided(withIndex(dish), 0.004);
  const mat = mk(rng.chance(0.7) ? 'metal_bare' : 'metal_painted_blue', rng.int(0, 3));
  const hy = onWall ? 0 : 0.9;
  fg(w, f, mat, dish2, 0, hy + 0.1, 0.05, 0, Math.PI / 2 - 0.5);
  // LNB arm
  const base = f.p(0, hy - R * 0.5, 0.05), lnb = f.p(0, hy + 0.1 + R * 0.35, 0.05 + R * 0.95);
  w.b.add(mk('metal_bare', 2), cylBetween(base, lnb, 0.012, 4));
  fb(w, f, mk('plastic_black', 0), 0, hy + 0.1 + R * 0.35, 0.05 + R * 0.95, 0.06, 0.06, 0.1, false, -0.5);
  if (!onWall) {
    fb(w, f, mk('metal_bare', 3), 0, hy / 2 + 0.05, -0.05, 0.05, hy + 0.1, 0.05);
    fb(w, f, mk('metal_rusty', 1), 0, 0.02, -0.05, 0.5, 0.04, 0.5);
    fb(w, f, mk('concrete', 1), 0.18, 0.08, 0.15, 0.4, 0.16, 0.2);
  } else {
    fb(w, f, mk('metal_bare', 3), 0, 0.1, -0.12, 0.04, 0.04, 0.3);
  }
}

function withIndex(g: THREE.BufferGeometry) {
  if (!g.index) {
    const n = g.attributes.position.count;
    g.setIndex([...Array(n).keys()]);
  }
  return g;
}

export function antenna(w: WCtx, x: number, y: number, z: number, rng: RNG) {
  const h = rng.range(2.5, 4.5);
  const key = mk('metal_bare', 2);
  w.b.add(key, cylBetween(V(x, y, z), V(x, y + h, z), 0.02, 5));
  const ry = rng.range(0, 3);
  const f = new Frame(x, y, z, ry);
  for (let i = 0; i < rng.int(2, 5); i++) {
    const yy = h - 0.2 - i * 0.35;
    const len = 1.2 - i * 0.15;
    fb(w, f, key, 0, yy, 0, 0.015, 0.015, len);
    for (let k = 0; k < 5; k++) fb(w, f, key, 0, yy, -len / 2 + (k * len) / 4, 0.4 - i * 0.05, 0.01, 0.01);
  }
  // guy wires
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + ry;
    w.b.add(mk('metal_bare', 0), cylBetween(V(x, y + h * 0.7, z), V(x + Math.cos(a) * 1.4, y + 0.02, z + Math.sin(a) * 1.4), 0.004, 3));
  }
}

export function solarHeater(w: WCtx, x: number, y: number, z: number, ry: number) {
  const f = new Frame(x, y, z, ry);
  // tilted panel + horizontal tank
  fb(w, f, mk('glass_dirty', 0), 0, 0.75, 0, 1.8, 0.05, 1.3, false, -0.55);
  fb(w, f, mk('metal_bare', 1), 0, 0.72, 0, 1.86, 0.04, 1.36, false, -0.55);
  const tank = new THREE.CylinderGeometry(0.25, 0.25, 1.8, 12);
  fg(w, f, mk('metal_bare', 0), tank, 0, 1.25, -0.6, 0, 0, Math.PI / 2);
  for (const sx of [-0.8, 0.8]) {
    fb(w, f, mk('metal_rusty', 0), sx, 0.6, -0.55, 0.04, 1.2, 0.04);
    fb(w, f, mk('metal_rusty', 0), sx, 0.2, 0.5, 0.04, 0.4, 0.04);
  }
}

export function genset(w: WCtx, x: number, y: number, z: number, ry: number) {
  const f = new Frame(x, y, z, ry);
  fg(w, f, mk('metal_painted_green', 2), roundedBox(2.2, 1.3, 1.0, 0.04, 1), 0, 0.75, 0);
  fb(w, f, mk('metal_rusty', 1), 0, 0.05, 0, 2.3, 0.1, 1.05);
  for (let i = 0; i < 8; i++) fb(w, f, mk('plastic_black', 0), 0.6, 0.45 + i * 0.08, 0.505, 0.7, 0.025, 0.01);
  fb(w, f, mk('metal_bare', 1), -0.6, 0.8, 0.505, 0.4, 0.3, 0.01);
  const ex = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8);
  fg(w, f, mk('metal_rusty', 2), ex, 0.8, 1.6, -0.2);
  w.b.colBox(x, y + 0.7, z, 2.3, 1.4, 1.05, 'metal', ry);
  coverSides(w, f, 1.1, 0.5);
  w.decal(D.OIL, V(x, y + 0.01, z), V(0, 1, 0), 3, 2.5, ry);
}

export function dumpster(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG) {
  const f = new Frame(x, y, z, ry);
  const key = mk(rng.chance(0.5) ? 'metal_painted_green' : 'metal_painted_blue', rng.int(1, 3));
  const prof: [number, number][] = [[-0.85, 0.15], [0.85, 0.15], [1.0, 1.25], [-0.95, 1.25]];
  const g = extrudeProfile(prof, 1.8, 0.02);
  g.rotateY(Math.PI / 2);
  fg(w, f, key, g, 0, 0, 0, Math.PI / 2);
  // lid (half open)
  fb(w, f, mk('plastic_black', 1), 0, 1.3, -0.45, 1.85, 0.05, 1.0, false, 0.15);
  fb(w, f, mk('plastic_black', 1), 0, 1.32, 0.5, 1.85, 0.05, 1.0, false, -0.05);
  for (const sx of [-0.8, 0.8]) for (const sz of [-0.7, 0.7]) {
    const wg = new THREE.CylinderGeometry(0.08, 0.08, 0.05, 8);
    fg(w, f, mk('rubber', 0), wg, sx, 0.08, sz, 0, 0, Math.PI / 2);
  }
  fb(w, f, mk('metal_rusty', 0), 0, 0.9, 0.95, 1.9, 0.06, 0.06);
  w.b.colBox(x, y + 0.7, z, 1.9, 1.3, 2.0, 'metal', ry);
  coverSides(w, new Frame(x, y, z, ry + Math.PI / 2), 0.95, 0.95);
  trashBags(w, f.wx(1.4, 0.6), y, f.wz(1.4, 0.6), rng.int(1, 3), rng);
}

export function container(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, doorsOpen = false) {
  const f = new Frame(x, y, z, ry);
  const key = mk(rng.pick(['metal_painted_blue', 'metal_painted_green', 'metal_rusty'] as const), rng.int(0, 3));
  const L = 6.06, W = 2.44, H = 2.59;
  // corrugated side walls
  for (const sz of [-1, 1]) {
    const g = corrugated(L - 0.3, H - 0.3, 0.28, 0.06);
    fg(w, f, key, g, 0, H / 2, sz * (W / 2 - 0.04), sz > 0 ? 0 : Math.PI);
  }
  const g2 = corrugated(W - 0.3, H - 0.3, 0.28, 0.05);
  fg(w, f, key, g2, -L / 2 + 0.04, H / 2, 0, -Math.PI / 2);
  // roof
  fb(w, f, key, 0, H - 0.08, 0, L - 0.1, 0.06, W - 0.1);
  fb(w, f, key, 0, 0.1, 0, L, 0.16, W);
  // corner posts and rails
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) fb(w, f, key, sx * (L / 2 - 0.08), H / 2, sz * (W / 2 - 0.08), 0.16, H, 0.16);
  for (const sz of [-1, 1]) fb(w, f, key, 0, H - 0.08, sz * (W / 2 - 0.08), L, 0.16, 0.16);
  for (const sx of [-1, 1]) fb(w, f, key, sx * (L / 2 - 0.08), H - 0.08, 0, 0.16, 0.16, W);
  // doors on +X end
  const ang = doorsOpen ? 1.9 : 0;
  for (const sz of [-1, 1]) {
    const hinge = f.p(L / 2 - 0.02, 0, sz * (W / 2 - 0.1));
    const dir = new Frame(hinge.x, y, hinge.z, ry + (sz > 0 ? ang : -ang));
    const dg = corrugated(W / 2 - 0.12, H - 0.35, 0.3, 0.04);
    fg(w, dir, key, dg, 0.02, H / 2, -sz * (W / 4 - 0.06), Math.PI / 2 * 1);
    for (const lz of [-0.25, 0.25]) fb(w, dir, mk('metal_bare', 2), 0.06, H / 2, -sz * (W / 4 - 0.06) + lz, 0.03, H - 0.4, 0.03);
  }
  w.b.colBox(x, y + H / 2, z, L, H, W, 'metal', ry);
  coverSides(w, f, L / 2, W / 2, true, true);
}

export function fenceCorrugated(w: WCtx, x0: number, z0: number, x1: number, z1: number, h: number, rng: RNG) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = Math.atan2(-(z1 - z0), x1 - x0);
  const n = Math.max(1, Math.round(len / 1.8));
  const f = new Frame((x0 + x1) / 2, 0, (z0 + z1) / 2, ry);
  for (let i = 0; i < n; i++) {
    const seg = len / n;
    const lx = -len / 2 + seg * (i + 0.5);
    const key = mk(rng.chance(0.5) ? 'metal_rusty' : 'metal_corrugated', rng.int(0, 3));
    const hh = h * rng.range(0.9, 1.05);
    const g = twoSided(corrugated(seg + 0.08, hh, 0.13, 0.03), 0.01);
    fg(w, f, key, g, lx, hh / 2 + 0.05, rng.jit(0.03), rng.jit(0.04), rng.jit(0.03));
    fb(w, f, mk('wood_planks', 2), lx - seg / 2, h / 2, -0.06, 0.08, h + 0.1, 0.08);
  }
  fb(w, f, mk('wood_planks', 2), 0, h * 0.8, -0.06, len, 0.06, 0.04);
  fb(w, f, mk('wood_planks', 2), 0, h * 0.25, -0.06, len, 0.06, 0.04);
  w.b.colBox(f.x, h / 2, f.z, len, h, 0.12, 'metal', ry);
}

// ------------------------------------------------------------------ furniture
export function table(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, sx = 1.2, sz = 0.7) {
  const f = new Frame(x, y, z, ry);
  const k = mk(rng.chance(0.5) ? 'wood_painted' : 'wood_planks', rng.int(0, 3));
  fb(w, f, k, 0, 0.74, 0, sx, 0.04, sz);
  for (const a of [-1, 1]) for (const b of [-1, 1]) fb(w, f, k, a * (sx / 2 - 0.05), 0.36, b * (sz / 2 - 0.05), 0.05, 0.72, 0.05);
  w.b.colBox(x, y + 0.38, z, sx, 0.76, sz, 'wood', ry);
}

export function chair(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, plastic = true) {
  const f = new Frame(x, y, z, ry);
  const k = plastic ? mk(rng.chance(0.7) ? 'car_paint_white' : 'metal_painted_green', 3) : mk('wood_painted', rng.int(0, 3));
  fb(w, f, k, 0, 0.44, 0, 0.44, 0.03, 0.42);
  fb(w, f, k, 0, 0.7, -0.2, 0.44, 0.5, 0.03, false, -0.12);
  for (const a of [-1, 1]) for (const b of [-1, 1]) fb(w, f, k, a * 0.19, 0.22, b * 0.18, 0.03, 0.44, 0.03, false, b * 0.08, a * 0.08);
}

export function shelves(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, len = 1.8) {
  const f = new Frame(x, y, z, ry);
  const k = mk('metal_bare', rng.int(1, 3));
  for (const a of [-1, 1]) for (const b of [-1, 1]) fb(w, f, k, a * (len / 2 - 0.02), 1.0, b * 0.22, 0.035, 2.0, 0.035);
  for (let i = 0; i < 5; i++) {
    const yy = 0.1 + i * 0.45;
    fb(w, f, mk('plywood', 1), 0, yy, 0, len, 0.025, 0.46);
    // goods
    let lx = -len / 2 + 0.05;
    while (lx < len / 2 - 0.2) {
      const s = rng.range(0.12, 0.35);
      if (rng.chance(0.7)) fb(w, f, mk(rng.pick(['plywood', 'plastic_black', 'metal_painted_blue', 'canvas'] as const), rng.int(0, 3)), lx + s / 2, yy + 0.02 + s * 0.45, rng.jit(0.05), s, s * 0.9, rng.range(0.15, 0.35));
      lx += s + 0.03;
    }
  }
  w.b.colBox(x, y + 1.0, z, len, 2.0, 0.5, 'metal', ry);
}

export function mattress(w: WCtx, x: number, y: number, z: number, ry: number) {
  const f = new Frame(x, y, z, ry);
  fg(w, f, mk('canvas', 2), roundedBox(1.9, 0.18, 0.9, 0.06, 2), 0, 0.09, 0, 0, 0, 0);
}

export function sacks(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, n = 5) {
  const f = new Frame(x, y, z, ry);
  for (let i = 0; i < n; i++) {
    const g = bagGeo();
    g.scale(1.3, 2.2, 1.4);
    const lx = (i % 3) * 0.72 - 0.72, lz = Math.floor(i / 3) * 0.3;
    fg(w, f, mk(rng.chance(0.5) ? 'canvas' : 'sandbag', rng.int(0, 3)), g, lx + rng.jit(0.05), 0.17 + Math.floor(i / 3) * 0.3, lz, rng.jit(0.2));
  }
}

// ------------------------------------------------------------------ cloth / lines
/** Hanging cloth piece (flutter) at world position hanging from top edge. */
export function hangCloth(w: WCtx, x: number, y: number, z: number, ry: number, cw: number, ch: number, color: THREE.Color) {
  const g = new THREE.PlaneGeometry(cw, ch, 3, 4);
  g.translate(0, -ch / 2, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const weight = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = -pos.getY(i) / ch;
    weight[i] = t * t;
    pos.setZ(i, Math.sin(pos.getX(i) * 7) * 0.02);
  }
  paint(g, color);
  g.rotateY(ry);
  g.translate(x, y, z);
  const dir = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
  w.addFlutter('custom:cloth', g, weight, dir, 0.1);
}

const CLOTH_COLS = [0xd8d2c4, 0x2c4a7a, 0x8c2a2a, 0xe5e0d0, 0x3d5e3a, 0xc4a35a, 0x6e4b7c, 0x1d1d1d, 0xbfc7cf, 0xa55a3a, 0x4f7fa6];
export function clothesline(w: WCtx, a: THREE.Vector3, b: THREE.Vector3, rng: RNG, sag = 0.25) {
  const pts = catenary(a, b, sag, 12);
  w.b.add(mk('plastic_black', 0), tubeAlong(pts, 0.006, 3));
  const len = a.distanceTo(b);
  const ry = Math.atan2(-(b.z - a.z), b.x - a.x);
  let t = rng.range(0.05, 0.15);
  while (t < 0.92) {
    const cw = rng.range(0.35, 0.8), ch = rng.range(0.4, 0.9);
    const tt = t + cw / len / 2;
    if (tt > 0.95) break;
    const p = a.clone().lerp(b, tt);
    p.y -= sag * 4 * tt * (1 - tt);
    const c = new THREE.Color(rng.pick(CLOTH_COLS)).multiplyScalar(rng.range(0.75, 1.0));
    hangCloth(w, p.x, p.y, p.z, ry, cw, ch, c);
    t += cw / len + rng.range(0.02, 0.12);
  }
}

// ------------------------------------------------------------------ street furniture
export function streetLight(w: WCtx, x: number, y: number, z: number, ry: number) {
  const f = new Frame(x, y, z, ry);
  const pole = mk('metal_painted_green', 3);
  const g = new THREE.CylinderGeometry(0.06, 0.1, 7, 8);
  fg(w, f, pole, g, 0, 3.5, 0);
  fb(w, f, mk('concrete', 2), 0, 0.2, 0, 0.4, 0.4, 0.4);
  // curved arm
  const pts = [f.p(0, 6.8, 0), f.p(0.5, 7.3, 0), f.p(1.4, 7.4, 0), f.p(2.0, 7.3, 0)];
  w.b.add(pole, tubeAlong(pts, 0.045, 6));
  fb(w, f, mk('metal_bare', 2), 2.1, 7.22, 0, 0.6, 0.12, 0.28, false, 0, -0.08);
  fb(w, f, mk('glass_dirty', 0), 2.1, 7.15, 0, 0.5, 0.03, 0.22, false, 0, -0.08);
  w.b.colBox(x, y + 3.5, z, 0.2, 7, 0.2, 'metal');
}

export function powerPole(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG): { tops: THREE.Vector3[] } {
  const f = new Frame(x, y, z, ry);
  const H = rng.range(8.5, 9.5);
  const concrete = rng.chance(0.6);
  const g = new THREE.CylinderGeometry(concrete ? 0.1 : 0.12, concrete ? 0.17 : 0.15, H, concrete ? 8 : 7);
  scaleUV(g, 0.8, H);
  fg(w, f, concrete ? mk('concrete', rng.int(0, 3)) : mk('wood_planks', 3), g, 0, H / 2, 0, 0, 0, 0, 'keep');
  // crossarm with insulators
  const arm = mk('wood_planks', 2);
  fb(w, f, arm, 0, H - 0.4, 0, 0.1, 0.1, 2.0);
  fb(w, f, mk('metal_rusty', 0), 0, H - 0.75, 0.35, 0.03, 0.7, 0.03, false, 0.7);
  fb(w, f, mk('metal_rusty', 0), 0, H - 0.75, -0.35, 0.03, 0.7, 0.03, false, -0.7);
  const tops: THREE.Vector3[] = [];
  for (const lz of [-0.9, -0.3, 0.3, 0.9]) {
    const ins = new THREE.CylinderGeometry(0.035, 0.05, 0.14, 6);
    fg(w, f, mk('glass', 0), ins, 0, H - 0.28, lz);
    tops.push(f.p(0, H - 0.2, lz));
  }
  // transformer can on some
  if (rng.chance(0.35)) {
    const t = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 12);
    fg(w, f, mk('metal_bare', 2), t, 0.45, H - 2.0, 0);
    fb(w, f, mk('metal_rusty', 0), 0.2, H - 2.0, 0, 0.3, 0.08, 0.1);
  }
  // cable spaghetti / junction box
  fb(w, f, mk('metal_painted_green', 1), 0.16, 2.2, 0, 0.12, 0.5, 0.35);
  for (let i = 0; i < 3; i++) {
    const a = f.p(0.13, 2.4 + i * 0.1, rng.jit(0.1)), b = f.p(0.16, H - 1.2 - i * 0.4, rng.jit(0.1));
    w.b.add(mk('rubber', 0), cylBetween(a, b, 0.012, 3));
  }
  w.b.colBox(x, y + H / 2, z, 0.28, H, 0.28, concrete ? 'concrete' : 'wood');
  return { tops };
}

/** Sagging cable bundle between two points. */
export function cable(w: WCtx, a: THREE.Vector3, b: THREE.Vector3, sag: number, r = 0.012) {
  w.b.add(mk('rubber', 0), tubeAlong(catenary(a, b, sag, 14), r, 4));
}

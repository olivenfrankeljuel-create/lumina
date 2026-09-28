import * as THREE from 'three';
import { mk } from './builder';
import type { WCtx } from './context';
import { RNG, fbm } from './rng';
import { D } from './textures';
import { displace } from './geo';

/** Horizontal slab patch (top at y). Thin box so edges read as real paving. */
/** Every ground patch also gets a thick (1 m) collision slab whose top matches the visual surface. */
export function pad(w: WCtx, key: string, x0: number, z0: number, x1: number, z1: number, y: number, thick = 0.06, col = true) {
  w.b.boxMM(key, x0, y - thick, z0, x1, y, z1, false);
  if (col) groundCol(w, key, x0, z0, x1, z1, y);
}

export function groundCol(w: WCtx, key: string, x0: number, z0: number, x1: number, z1: number, y: number) {
  w.b.colBox((x0 + x1) / 2, y - 0.5, (z0 + z1) / 2, x1 - x0, 1, z1 - z0, w.b.surfaceOf(key));
}

/** Subdivided ground patch with subtle undulation (dirt / sand areas). */
export function softGround(w: WCtx, key: string, x0: number, z0: number, x1: number, z1: number, y: number, amp: number, seed: number) {
  const sx = Math.max(2, Math.round((x1 - x0) / 1.5)), sz = Math.max(2, Math.round((z1 - z0) / 1.5));
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, sx, sz);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  displace(g, (v) => {
    const edge = Math.min(v.x - x0, x1 - v.x, v.z - z0, z1 - v.z);
    const k = Math.min(1, edge / 1.5);
    v.y += (fbm(v.x * 0.25, v.z * 0.25, seed, 3) - 0.35) * amp * k;
  });
  w.b.add(key, g);
  groundCol(w, key, x0, z0, x1, z1, y);
}

/** Sidewalk strip with curb on the road side. roadSide: which edge (in x or z) touches the road. */
export function sidewalk(w: WCtx, x0: number, z0: number, x1: number, z1: number, roadSide: 'x0' | 'x1' | 'z0' | 'z1', rng: RNG, h = 0.15) {
  const paver = mk('concrete_floor', rng.int(0, 3));
  const curbKey = mk('concrete', rng.int(0, 3));
  const cw = 0.18;
  let cx0 = x0, cx1 = x1, cz0 = z0, cz1 = z1;
  if (roadSide === 'x0') cx1 = x0 + cw; else if (roadSide === 'x1') cx0 = x1 - cw; else if (roadSide === 'z0') cz1 = z0 + cw; else cz0 = z1 - cw;
  // curb (slightly taller, painted segments near crossings)
  const len = roadSide[0] === 'x' ? z1 - z0 : x1 - x0;
  const nseg = Math.max(1, Math.round(len / 1.0));
  const painted = rng.chance(0.35);
  for (let i = 0; i < nseg; i++) {
    const a = i / nseg, b = (i + 1) / nseg;
    const key = painted ? (i % 2 ? mk('plaster_white', 1) : mk('car_paint_red', 3)) : curbKey;
    if (roadSide[0] === 'x') w.b.boxMM(key, cx0, -0.05, z0 + (z1 - z0) * a, cx1, h + 0.01, z0 + (z1 - z0) * b - 0.006, false);
    else w.b.boxMM(key, x0 + (x1 - x0) * a, -0.05, cz0, x0 + (x1 - x0) * b - 0.006, h + 0.01, cz1, false);
  }
  const sx0 = roadSide === 'x0' ? x0 + cw : x0, sx1 = roadSide === 'x1' ? x1 - cw : x1;
  const sz0 = roadSide === 'z0' ? z0 + cw : z0, sz1 = roadSide === 'z1' ? z1 - cw : z1;
  w.b.boxMM(paver, sx0, -0.05, sz0, sx1, h, sz1, false);
  w.b.colBox((x0 + x1) / 2, (h - 0.05) / 2, (z0 + z1) / 2, x1 - x0, h + 0.05, z1 - z0, 'concrete');
  w.ground.push({ x0, z0, x1, z1, h });
  // broken pavers / sand / stains
  for (let i = 0; i < len / 4; i++) {
    const px = rng.range(sx0 + 0.3, sx1 - 0.3), pz = rng.range(sz0 + 0.3, sz1 - 0.3);
    w.decal(rng.pick([D.DIRT, D.SAND, D.OIL, D.CRACKS, D.PAPERS, D.DIRT]), new THREE.Vector3(px, h, pz), new THREE.Vector3(0, 1, 0), rng.range(0.8, 2.0), rng.range(0.8, 2.0), rng.range(0, 6), 0.008);
  }
}

/** Road markings, cracks, manholes, patches on an asphalt strip running along Z (x0..x1). */
export function roadDressingZ(w: WCtx, x0: number, x1: number, z0: number, z1: number, rng: RNG, centreLine = true) {
  const up = new THREE.Vector3(0, 1, 0);
  const cx = (x0 + x1) / 2;
  if (centreLine) {
    for (let z = z0 + 2; z < z1 - 2; z += 6) {
      if (rng.chance(0.12)) continue;
      w.decal(D.LINE, new THREE.Vector3(cx, 0.012, z + 1.5), up, 0.14, 3, 0, 0.004);
    }
  }
  for (const ex of [x0 + 0.35, x1 - 0.35]) {
    for (let z = z0 + 0.5; z < z1 - 0.5; z += 5) {
      if (rng.chance(0.25)) continue;
      w.decal(D.LINE, new THREE.Vector3(ex, 0.012, z + 2.5), up, 0.1, 5, 0, 0.004);
    }
  }
  const len = z1 - z0;
  for (let i = 0; i < len / 3; i++) {
    const px = rng.range(x0 + 0.5, x1 - 0.5), pz = rng.range(z0 + 1, z1 - 1);
    const cell = rng.pick([D.CRACKS, D.CRACKS, D.OIL, D.DIRT, D.SAND, D.PAPERS, D.CRACKS]);
    w.decal(cell, new THREE.Vector3(px, 0.012, pz), up, rng.range(1.0, 2.4), rng.range(1.0, 2.4), rng.range(0, 6), 0.004 + i * 0.00005);
  }
  // sand washed against curbs
  for (let z = z0; z < z1; z += rng.range(3, 7)) {
    for (const ex of [x0 + 0.4, x1 - 0.4]) if (rng.chance(0.6)) w.decal(D.SAND, new THREE.Vector3(ex, 0.012, z), up, rng.range(0.8, 1.6), rng.range(2, 4), 0, 0.005);
  }
  // repair patches
  for (let i = 0; i < len / 12; i++) {
    const px = rng.range(x0 + 1, x1 - 1), pz = rng.range(z0 + 1, z1 - 1);
    w.b.box(mk('asphalt', 3), px, 0.008, pz, rng.range(0.6, 1.4), 0.02, rng.range(0.6, 1.6), { ry: rng.jit(0.1) });
  }
  // manholes + drains
  for (let z = z0 + rng.range(4, 10); z < z1 - 2; z += rng.range(14, 24)) manhole(w, cx + rng.jit(1.5), z, rng);
  for (let z = z0 + 3; z < z1 - 2; z += rng.range(9, 15)) {
    for (const ex of [x0 + 0.25, x1 - 0.25]) if (rng.chance(0.5)) drain(w, ex, z, 0);
  }
}

export function manhole(w: WCtx, x: number, z: number, rng: RNG) {
  const disc = new THREE.CylinderGeometry(0.34, 0.34, 0.03, 20);
  w.b.addT(mk('metal_diamond_plate', 1), disc, x, 0.006, z, rng.range(0, 3));
  const ring = new THREE.TorusGeometry(0.37, 0.035, 4, 20);
  w.b.addT(mk('metal_rusty', 1), ring, x, 0.01, z, 0, Math.PI / 2, 0, 1, 1, 0.4);
  w.decal(D.OIL, new THREE.Vector3(x, 0.012, z), new THREE.Vector3(0, 1, 0), 1.4, 1.4, rng.range(0, 6), 0.004);
}

export function drain(w: WCtx, x: number, z: number, ry: number) {
  w.b.box(mk('metal_rusty', 2), x, 0.004, z, 0.4, 0.02, 0.8, { ry });
  for (let i = 0; i < 6; i++) w.b.box(mk('plastic_black', 0), x, 0.012, z - 0.32 + i * 0.13, 0.3, 0.004, 0.05, { ry });
}

/** Sand drift heaped against a wall running along X (dir +z outwards) or Z. */
export function sandDrift(w: WCtx, x: number, z: number, len: number, depth: number, h: number, ry: number, rng: RNG, y = 0) {
  const g = new THREE.PlaneGeometry(len, depth, Math.max(4, Math.round(len * 2)), 5);
  g.rotateX(-Math.PI / 2);
  // plane spans x in [-len/2, len/2], z in [-depth/2, depth/2]; wall at z=-depth/2
  const seed = rng.range(0, 100);
  displace(g, (v) => {
    const t = Math.min(1, Math.max(0, (v.z + depth / 2) / depth)); // 0 at wall, 1 at outer edge
    const along = (v.x + len / 2) / len;
    const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, along))) ** 0.6;
    const n = fbm(v.x * 0.8 + seed, v.z * 0.8, 3, 3);
    v.y = h * Math.pow(1 - t, 1.8) * taper * (0.6 + 0.8 * n) - 0.02;
  });
  g.translate(0, 0, depth / 2);
  w.b.addT(mk('sand', rng.int(0, 3)), g, x, y, z, ry);
}

/** Large outer terrain beyond the playable area: sand with rolling dunes further out. */
export function outerTerrain(w: WCtx) {
  const S = 1400, N = 90;
  const g = new THREE.PlaneGeometry(S, S, N, N);
  g.rotateX(-Math.PI / 2);
  displace(g, (v) => {
    const d = Math.max(Math.abs(v.x - 3), Math.abs(v.z)) - 95;
    if (d > 0) v.y = (fbm(v.x * 0.01, v.z * 0.01, 5, 4) - 0.3) * Math.min(1, d / 80) * 14 - 0.08;
    else v.y = -0.08;
  });
  w.b.add(mk('sand', 1), g);
}

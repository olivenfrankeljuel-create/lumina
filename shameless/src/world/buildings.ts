import * as THREE from 'three';
import { mk, type MatKey } from './builder';
import type { WCtx } from './context';
import { RNG } from './rng';
import { atlasQuad, blobPoints, cylBetween, corrugated, paint, twoSided } from './geo';
import { D, signRect, SIGN_COLS, SIGN_ROWS } from './textures';
import {
  Frame, fb, acUnit, waterTank, satDish, antenna, solarHeater, clothesline, crate, crateStack, tire, cinderStack,
  chair, table, shelves, mattress, sacks, debris, barrel, cardboard, gasCylinder, palletStack,
} from './props';

export type Face = 'n' | 's' | 'e' | 'w';
export const FH = 3.2; // storey height
export const BASE = 0.15; // ground floor level
export const WALL = 0.3;

export interface DoorSpec { f: Face; u: number; w?: number; kind?: 'door' | 'double' | 'shop' | 'arch' }

export interface BSpec {
  x0: number; z0: number; x1: number; z1: number;
  floors: number;
  style: 'plaster' | 'brick' | 'concrete';
  seed: number;
  /** Ground floor enterable (doors open, furnished interior). */
  enter?: boolean;
  /** Floor 1 enterable (requires interior stairs). */
  upper?: boolean;
  shops?: Face[];
  doors?: DoorSpec[];
  /** Faces without any openings (party walls / backs). */
  blank?: Face[];
  stairs?: { kind: 'interior' } | { kind: 'exterior'; f: Face; u0: number; dir: 1 | -1 };
  balconies?: { f: Face; floor: number; u: number; w?: number }[];
  parapet?: 'plain' | 'stepped' | 'rebar' | 'low';
  /** Roof reachable by players (exterior stairs) — props kept clear of the arrival. */
  roofProps?: boolean;
  /** Suppress facade dressing (backdrop buildings). */
  simple?: boolean;
}

export interface FaceFrame { f: Face; ox: number; oz: number; tx: number; tz: number; nx: number; nz: number; ry: number; L: number; uA: number; uB: number }

interface Opening { u0: number; u1: number; y0: number; y1: number; kind: 'window' | 'door' | 'double' | 'shop' | 'arch' | 'balcony'; floor: number }

const level = (k: number) => BASE + k * FH;

export function faceFrames(x0: number, z0: number, x1: number, z1: number): Record<Face, FaceFrame> {
  const mkF = (f: Face, ox: number, oz: number, tx: number, tz: number, nx: number, nz: number, L: number, ew: boolean): FaceFrame =>
    ({ f, ox, oz, tx, tz, nx, nz, ry: Math.atan2(-tz, tx), L, uA: ew ? WALL : 0, uB: ew ? L - WALL : L });
  return {
    s: mkF('s', x0, z1, 1, 0, 0, 1, x1 - x0, false),
    n: mkF('n', x1, z0, -1, 0, 0, -1, x1 - x0, false),
    e: mkF('e', x1, z1, 0, -1, 1, 0, z1 - z0, true),
    w: mkF('w', x0, z0, 0, 1, -1, 0, z1 - z0, true),
  };
}

/** Box in face space: u along facade, y up, d outward from the outer wall surface. */
export function fbox(w: WCtx, fr: FaceFrame, key: MatKey, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, col: boolean | string = false, rx = 0, rz = 0) {
  if (u1 < u0) [u0, u1] = [u1, u0];
  const uc = (u0 + u1) / 2, dc = (d0 + d1) / 2;
  w.b.box(key, fr.ox + fr.tx * uc + fr.nx * dc, (y0 + y1) / 2, fr.oz + fr.tz * uc + fr.nz * dc, u1 - u0, y1 - y0, d1 - d0, { ry: fr.ry, col: col as any, rx, rz });
}
export function fpt(fr: FaceFrame, u: number, y: number, d: number): THREE.Vector3 {
  return new THREE.Vector3(fr.ox + fr.tx * u + fr.nx * d, y, fr.oz + fr.tz * u + fr.nz * d);
}
export function fnorm(fr: FaceFrame) {
  return new THREE.Vector3(fr.nx, 0, fr.nz);
}
/** Matrix mapping face-local (x=u, y, z=d) into world. */
function faceMatrix(fr: FaceFrame, d = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(fr.tx, 0, fr.tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(fr.nx, 0, fr.nz));
  m.setPosition(fr.ox + fr.nx * d, 0, fr.oz + fr.nz * d);
  return m;
}
/** Prop frame standing on the face at u (local +z = outward normal). */
function faceProp(fr: FaceFrame, u: number, y: number, d: number): Frame {
  const p = fpt(fr, u, y, d);
  return new Frame(p.x, y, p.z, fr.ry);
}


let signCounter = 0;

export function building(w: WCtx, s: BSpec): void {
  const rng = new RNG(s.seed * 7919 + 17);
  const { x0, z0, x1, z1, floors } = s;
  const roofY = level(floors);
  const par = s.parapet ?? rng.pick(['plain', 'plain', 'stepped', 'rebar', 'low'] as const);
  const parH = par === 'low' ? 0.45 : par === 'rebar' ? 0.6 : 1.05;
  const frames = faceFrames(x0, z0, x1, z1);
  const faces: Face[] = ['n', 's', 'e', 'w'];

  // ---- materials
  const v = rng.int(0, 3);
  const wallKey = s.style === 'plaster' ? mk(rng.pick(['plaster_white', 'plaster_worn', 'plaster_worn'] as const), v)
    : s.style === 'brick' ? mk(rng.pick(['brick_tan', 'brick_tan', 'brick_red'] as const), v)
      : mk(rng.pick(['concrete', 'concrete_dirty'] as const), v);
  const trimKey = s.style === 'plaster' ? (rng.chance(0.5) ? mk('concrete', (v + 1) % 4) : mk('plaster_white', (v + 2) % 4)) : mk('concrete', (v + 1) % 4);
  const plinthKey = mk('concrete_dirty', (v + 2) % 4);
  const frameKey = mk(rng.pick(['wood_painted', 'metal_painted_green', 'metal_painted_blue', 'metal_bare'] as const), rng.int(0, 3));
  const shutterKey = mk(rng.pick(['wood_painted', 'wood_painted', 'metal_painted_green', 'metal_painted_blue'] as const), rng.int(0, 3));
  const doorKey = mk(rng.pick(['metal_painted_green', 'metal_painted_blue', 'wood_painted', 'metal_rusty'] as const), rng.int(0, 3));
  const interiorKey = mk(rng.pick(['plaster_worn', 'plaster_white'] as const), rng.int(0, 3));
  const floorKey = mk(rng.pick(['tile_floor', 'concrete_floor', 'concrete_floor'] as const), rng.int(0, 3));
  const slabKey = mk('concrete', rng.int(0, 3));
  const roofKey = mk(rng.pick(['concrete_dirty', 'concrete_dirty', 'gravel'] as const), rng.int(0, 3));
  const brickPatchKey = mk(rng.pick(['brick_red', 'brick_tan'] as const), rng.int(0, 3));
  const winStyle = rng.pick([0, 0, 1, 2] as const); // 0 shutters, 1 metal frames + grilles, 2 mixed
  const extStairs = s.stairs?.kind === 'exterior' ? s.stairs : null;
  const stairLen = extStairs ? stairTotalLen(roofY) : 0;

  // ---- openings
  const ops: Record<Face, Opening[]> = { n: [], s: [], e: [], w: [] };
  for (const d of s.doors ?? []) {
    const fr = frames[d.f];
    const kind = d.kind ?? 'door';
    const ww = d.w ?? (kind === 'door' ? 1.05 : kind === 'double' ? 1.7 : kind === 'shop' ? 2.8 : 2.3);
    const uc = d.u < 0 ? fr.L + d.u : d.u;
    const y1 = kind === 'door' ? BASE + 2.1 : kind === 'double' ? BASE + 2.3 : kind === 'shop' ? BASE + 2.5 : BASE + 2.9;
    ops[d.f].push({ u0: uc - ww / 2, u1: uc + ww / 2, y0: 0, y1: Math.min(y1, level(1) - 0.45), kind, floor: 0 });
  }
  const overlaps = (list: Opening[], u0: number, u1: number, floor: number, m = 0.45) => list.some((o) => o.floor === floor && u0 < o.u1 + m && u1 > o.u0 - m);
  const stairBlock = (f: Face, u0: number, u1: number) => {
    if (!extStairs || extStairs.f !== f) return false;
    const a = Math.min(extStairs.u0, extStairs.u0 + extStairs.dir * stairLen), b = Math.max(extStairs.u0, extStairs.u0 + extStairs.dir * stairLen);
    return u0 < b + 0.3 && u1 > a - 0.3;
  };
  for (const bal of s.balconies ?? []) {
    ops[bal.f].push({ u0: bal.u - 0.55, u1: bal.u + 0.55, y0: level(bal.floor), y1: level(bal.floor) + 2.2, kind: 'balcony', floor: bal.floor });
  }
  for (const f of faces) {
    if (s.blank?.includes(f)) continue;
    const fr = frames[f];
    const margin = 0.75;
    const usable = fr.uB - fr.uA - margin * 2;
    if (usable < 1.2) continue;
    const nb = Math.max(1, Math.round(usable / 3.3));
    const bw = usable / nb;
    const colW: number[] = [];
    for (let i = 0; i < nb; i++) colW.push(Math.min(bw - 0.7, rng.pick([1.0, 1.15, 1.3, 1.3])));
    const shopFace = s.shops?.includes(f);
    for (let k = 0; k < floors; k++) {
      for (let i = 0; i < nb; i++) {
        const uc = fr.uA + margin + bw * (i + 0.5);
        if (k === 0) {
          if (shopFace && bw > 2.6) {
            const sw = Math.min(bw - 0.55, rng.range(2.4, 3.2));
            if (!overlaps(ops[f], uc - sw / 2, uc + sw / 2, 0, 0.35) && !stairBlock(f, uc - sw / 2, uc + sw / 2))
              ops[f].push({ u0: uc - sw / 2, u1: uc + sw / 2, y0: 0, y1: BASE + 2.5, kind: 'shop', floor: 0 });
            continue;
          }
          if (rng.chance(0.3)) continue;
          const ww = Math.min(colW[i], 1.15);
          if (overlaps(ops[f], uc - ww / 2, uc + ww / 2, 0) || stairBlock(f, uc - ww / 2, uc + ww / 2)) continue;
          ops[f].push({ u0: uc - ww / 2, u1: uc + ww / 2, y0: level(0) + 0.95, y1: level(0) + 2.25, kind: 'window', floor: 0 });
        } else {
          if (rng.chance(0.12)) continue;
          const ww = colW[i];
          if (overlaps(ops[f], uc - ww / 2, uc + ww / 2, k) || stairBlock(f, uc - ww / 2, uc + ww / 2)) continue;
          ops[f].push({ u0: uc - ww / 2, u1: uc + ww / 2, y0: level(k) + 0.9, y1: level(k) + 2.3, kind: 'window', floor: k });
        }
      }
    }
    ops[f].sort((a, b) => a.u0 - b.u0);
  }

  // ---- structural walls (per floor band, cut around openings)
  const parGaps: Record<Face, [number, number][]> = { n: [], s: [], e: [], w: [] };
  if (extStairs) {
    const uEnd = extStairs.u0 + extStairs.dir * stairLen;
    parGaps[extStairs.f].push([Math.min(uEnd, uEnd - extStairs.dir * 1.3), Math.max(uEnd, uEnd - extStairs.dir * 1.3)]);
  }
  for (const f of faces) {
    const fr = frames[f];
    for (let k = 0; k < floors; k++) {
      const yb = k === 0 ? 0 : level(k), yt = k === floors - 1 ? roofY : level(k + 1);
      wallBand(w, fr, wallKey, yb, yt, fr.uA, fr.uB, -WALL, 0, ops[f].filter((o) => o.floor === k));
    }
    // parapet
    const pu: [number, number][] = [];
    let cur = fr.uA;
    for (const g of parGaps[f].sort((a, b) => a[0] - b[0])) { pu.push([cur, g[0]]); cur = g[1]; }
    pu.push([cur, fr.uB]);
    for (const [a, b] of pu) {
      if (b - a < 0.05) continue;
      fbox(w, fr, wallKey, a, b, roofY, roofY + parH, -0.22, 0, true);
      const ea = a <= fr.uA + 0.01 && (f === 'n' || f === 's') ? -0.05 : a;
      const eb = b >= fr.uB - 0.01 && (f === 'n' || f === 's') ? b + 0.05 : b;
      fbox(w, fr, trimKey, ea, eb, roofY + parH, roofY + parH + 0.07, -0.27, 0.05);
    }
    if (par === 'stepped' && !s.simple) {
      for (let u = fr.uA + 0.6; u < fr.uB - 0.6; u += 1.3) {
        if (parGaps[f].some(([a, b]) => u > a - 0.8 && u < b + 0.8)) continue;
        fbox(w, fr, wallKey, u - 0.35, u + 0.35, roofY + parH + 0.07, roofY + parH + 0.32, -0.2, 0);
        fbox(w, fr, wallKey, u - 0.17, u + 0.17, roofY + parH + 0.32, roofY + parH + 0.55, -0.2, 0);
        fbox(w, fr, trimKey, u - 0.2, u + 0.2, roofY + parH + 0.55, roofY + parH + 0.6, -0.23, 0.03);
      }
    }
  }

  // ---- slabs
  const ix0 = x0 + WALL, ix1 = x1 - WALL, iz0 = z0 + WALL, iz1 = z1 - WALL;
  w.b.boxMM(slabKey, ix0, 0, iz0, ix1, BASE - 0.02, iz1, true);
  w.b.boxMM(floorKey, ix0, BASE - 0.02, iz0, ix1, BASE, iz1, false);
  w.ground.push({ x0, z0, x1, z1, h: BASE });
  const longX = x1 - x0 >= z1 - z0;
  const intStairs = s.stairs?.kind === 'interior';
  // interior stair placement (ground -> floor 1) along the long axis, against the low-side wall
  const nSteps = 18, rise = FH / nSteps, run = 0.27, sLen = nSteps * run, sW = 1.05;
  const hole = intStairs
    ? longX ? { x0: ix0 + 0.4, x1: ix0 + 0.4 + sLen + 0.1, z0: iz0, z1: iz0 + sW + 0.05 } : { x0: ix0, x1: ix0 + sW + 0.05, z0: iz0 + 0.4, z1: iz0 + 0.4 + sLen + 0.1 }
    : null;
  for (let k = 1; k <= floors; k++) {
    const y = level(k);
    const isRoof = k === floors;
    const key = isRoof ? slabKey : slabKey;
    if (k === 1 && hole) slabWithHole(w, key, ix0, iz0, ix1, iz1, y - 0.25, y, hole);
    else w.b.boxMM(key, ix0, y - 0.25, iz0, ix1, y, iz1, true);
    if (isRoof) w.b.boxMM(roofKey, ix0, y, iz0, ix1, y + 0.02, iz1, false);
    else if (s.upper && k === 1) {
      if (hole) slabWithHole(w, floorKey, ix0, iz0, ix1, iz1, y, y + 0.015, hole, false);
      else w.b.boxMM(floorKey, ix0, y, iz0, ix1, y + 0.015, iz1, false);
    }
  }
  w.decks.push({ x0: ix0, z0: iz0, x1: ix1, z1: iz1, h: roofY });
  if (s.upper) w.decks.push({ x0: ix0, z0: iz0, x1: ix1, z1: iz1, h: level(1) });

  // ---- interior partitions per floor
  const lenAxis = longX ? ix1 - ix0 : iz1 - iz0;
  const nRooms = lenAxis > 13 ? 3 : lenAxis > 7.5 ? 2 : 1;
  const parts: number[] = [];
  for (let i = 1; i < nRooms; i++) {
    let p = (lenAxis * i) / nRooms + rng.jit(0.8);
    if (hole && i === 1) p = Math.max(p, sLen + 1.4);
    parts.push(p);
  }
  for (let k = 0; k < floors; k++) {
    const yb = level(k), yt = level(k + 1) - 0.25;
    for (const p of parts) {
      const doorAt = rng.range(0.9, (longX ? iz1 - iz0 : ix1 - ix0) - 0.9);
      if (longX) {
        const x = ix0 + p;
        partition(w, interiorKey, x, iz0, x, iz1, yb, yt, doorAt, !!(s.enter || (s.upper && k === 1)));
      } else {
        const z = iz0 + p;
        partition(w, interiorKey, ix0, z, ix1, z, yb, yt, doorAt, !!(s.enter || (s.upper && k === 1)));
      }
    }
  }

  // ---- interior stairs
  if (hole) {
    const f = longX ? new Frame(hole.x0, BASE, iz0 + sW / 2, 0) : new Frame(ix0 + sW / 2, BASE, hole.z0, -Math.PI / 2);
    stairFlight(w, f, mk('concrete', 2), nSteps, rise, run, sW, true);
    // railing around the hole on floor 1 (open long side + start end)
    const ry = level(1);
    const rail = mk('metal_painted_green', 1);
    if (longX) {
      railing(w, rail, new THREE.Vector3(hole.x0, ry, hole.z1), new THREE.Vector3(hole.x1 - 0.9, ry, hole.z1), 1.0);
      railing(w, rail, new THREE.Vector3(hole.x0, ry, iz0), new THREE.Vector3(hole.x0, ry, hole.z1), 1.0);
    } else {
      railing(w, rail, new THREE.Vector3(hole.x1, ry, hole.z0), new THREE.Vector3(hole.x1, ry, hole.z1 - 0.9), 1.0);
      railing(w, rail, new THREE.Vector3(ix0, ry, hole.z0), new THREE.Vector3(hole.x1, ry, hole.z0), 1.0);
    }
  }

  // ---- facades: trims, openings, dressing
  const doorsOpen = !!s.enter;
  for (const f of faces) {
    const fr = frames[f];
    const ns = f === 'n' || f === 's';
    const e0 = ns ? -0.06 : 0, e1 = ns ? fr.L + 0.06 : fr.L;
    // floor bands
    for (let k = 1; k < floors; k++) fbox(w, fr, trimKey, e0, e1, level(k) - 0.24, level(k) + 0.03, 0, s.style === 'brick' ? 0.04 : 0.055);
    // cornice
    fbox(w, fr, trimKey, e0, e1, roofY - 0.3, roofY - 0.12, 0, 0.07);
    fbox(w, fr, trimKey, ns ? e0 - 0.06 : e0, ns ? e1 + 0.06 : e1, roofY - 0.12, roofY + 0.02, 0, 0.13);
    // plinth
    const gops = ops[f].filter((o) => o.floor === 0 && o.y0 < 0.7);
    const spans = solidSpans(ns ? -0.04 : 0, ns ? fr.L + 0.04 : fr.L, gops);
    const plH = rng.range(0.45, 0.9);
    for (const [a, b] of spans) fbox(w, fr, plinthKey, a, b, 0, plH, 0, 0.04);
    // brick style: concrete frame (corner columns + intermediate)
    if (s.style === 'brick') {
      for (const u of [0.18, fr.L - 0.18]) if (ns) fbox(w, fr, trimKey, u - 0.2, u + 0.2, 0, roofY + parH, -0.2, 0.03);
      const step = fr.L / Math.max(1, Math.round(fr.L / 4.2));
      for (let u = step; u < fr.L - 1; u += step) {
        if (ops[f].some((o) => u > o.u0 - 0.2 && u < o.u1 + 0.2)) continue;
        fbox(w, fr, trimKey, u - 0.15, u + 0.15, 0, roofY, 0, 0.03);
      }
    }
    if (s.blank?.includes(f) && s.simple) continue;
    for (const o of ops[f]) {
      if (o.kind === 'window') dressWindow(w, fr, o, rng, { frameKey, shutterKey, trimKey, style: winStyle, ground: o.floor === 0, lockGround: !s.enter, simple: !!s.simple });
      else if (o.kind === 'shop') dressShop(w, fr, o, rng, doorsOpen, trimKey, !!s.simple);
      else if (o.kind === 'balcony') dressBalcony(w, fr, o, rng, trimKey, doorKey);
      else dressDoor(w, fr, o, rng, doorKey, frameKey, trimKey, doorsOpen);
    }
    if (s.simple) continue;
    // plaster damage revealing brick
    if (s.style !== 'brick') {
      const nd = rng.int(s.style === 'plaster' ? 1 : 0, s.style === 'plaster' ? 4 : 2);
      for (let i = 0; i < nd; i++) damagePatch(w, fr, rng, ops[f], roofY, wallKey, s.style === 'plaster' ? brickPatchKey : mk('concrete_dirty', 3));
    }
    // grime at base, streaks from roof, graffiti/posters on ground spans
    for (const [a, b] of spans) {
      if (b - a < 0.3) continue;
      const segs = Math.ceil((b - a) / 3.5);
      for (let i = 0; i < segs; i++) {
        const sa = a + ((b - a) * i) / segs, sb = a + ((b - a) * (i + 1)) / segs;
        const h = rng.range(0.7, 1.02);
        w.decal(D.GRIME, fpt(fr, (sa + sb) / 2, h / 2, 0.045), fnorm(fr), sb - sa + 0.02, h, 0, 0.004, rng.chance(0.5));
        if (rng.chance(0.2)) w.decal(D.DAMP, fpt(fr, (sa + sb) / 2, 0.4, 0.045), fnorm(fr), sb - sa, 0.8, 0, 0.006);
      }
    }
    const allSpans = solidSpans(fr.uA + 0.2, fr.uB - 0.2, ops[f].filter((o) => o.floor === 0));
    for (const [a, b] of allSpans) {
      const width = b - a;
      if (width > 2.0 && rng.chance(0.5)) {
        const cell = rng.pick([D.GRAFFITI_A, D.GRAFFITI_B, D.STENCIL, D.POSTERS, D.GRAFFITI_B]);
        const sz = cell === D.POSTERS ? rng.range(1.2, 1.6) : rng.range(1.5, Math.min(2.4, width - 0.3));
        const u = rng.range(a + sz / 2 + 0.1, b - sz / 2 - 0.1);
        w.decal(cell, fpt(fr, u, Math.min(level(1) - 0.5 - sz / 2, 0.6 + sz / 2 + rng.range(0, 0.4)), 0.004), fnorm(fr), sz, sz, rng.jit(0.05), 0.006);
      }
    }
    const nStreak = Math.round(fr.L / 5);
    for (let i = 0; i < nStreak; i++) {
      const u = rng.range(fr.uA + 1, fr.uB - 1), h = rng.range(1.5, 3.5);
      if (ops[f].some((o) => u > o.u0 - 1 && u < o.u1 + 1 && o.floor === floors - 1)) continue;
      w.decal(D.STREAKS, fpt(fr, u, roofY - 0.3 - h / 2, 0), fnorm(fr), rng.range(1.2, 2.5), h, 0, 0.008);
    }
    if (rng.chance(0.18)) {
      const u = rng.range(fr.uA + 1, fr.uB - 1), y = rng.range(1.2, roofY - 1.5);
      if (!ops[f].some((o) => u > o.u0 - 0.8 && u < o.u1 + 0.8 && y > o.y0 - 0.8 && y < o.y1 + 0.8)) w.decal(D.BULLETS, fpt(fr, u, y, 0), fnorm(fr), 1.3, 1.3, rng.range(0, 6), 0.007);
    }
    // drainpipe
    if (rng.chance(0.55) && !s.blank?.includes(f)) {
      const u = rng.chance(0.5) ? fr.uA + 0.28 : fr.uB - 0.28;
      if (!stairBlock(f, u - 0.2, u + 0.2)) drainPipe(w, fr, u, roofY, rng);
    }
    // facade cables
    if (!s.blank?.includes(f) && rng.chance(0.7)) {
      const y = roofY - 0.5 - rng.range(0, 0.2);
      const n = Math.max(1, Math.round(fr.L / 3));
      for (let c = 0; c < rng.int(1, 3); c++) {
        for (let i = 0; i < n; i++) {
          const a = fpt(fr, (fr.L * i) / n, y - c * 0.05, 0.05 + c * 0.02), b = fpt(fr, (fr.L * (i + 1)) / n, y - c * 0.05, 0.05 + c * 0.02);
          w.b.add(mk('rubber', 0), cylSag(a, b, 0.06 + c * 0.03));
        }
      }
      // vertical drop to a meter box
      const du = rng.range(fr.uA + 0.8, fr.uB - 0.8);
      if (!ops[f].some((o) => du > o.u0 - 0.4 && du < o.u1 + 0.4) && !stairBlock(f, du - 0.3, du + 0.3)) {
        w.b.add(mk('rubber', 0), cylBetween(fpt(fr, du, y, 0.05), fpt(fr, du, 1.9, 0.05), 0.012, 4));
        fbox(w, fr, mk('metal_bare', 2), du - 0.18, du + 0.18, 1.35, 1.9, 0, 0.14);
        fbox(w, fr, mk('plastic_black', 0), du - 0.12, du + 0.12, 1.45, 1.75, 0.14, 0.15);
      }
    }
  }

  // ---- exterior stairs
  if (extStairs) exteriorStairs(w, frames[extStairs.f], extStairs.u0, extStairs.dir, roofY, rng);

  // ---- interiors
  if (s.enter) furnish(w, rng, ix0, iz0, ix1, iz1, level(0), longX, parts, hole, 1);
  if (s.upper) furnish(w, rng, ix0, iz0, ix1, iz1, level(1), longX, parts, hole, 0.6);

  // ---- roof
  if (!s.simple) roofDressing(w, rng, s, par, parH, roofY, ix0, iz0, ix1, iz1, extStairs ? { fr: frames[extStairs.f], u: extStairs.u0 + extStairs.dir * stairLen, dir: extStairs.dir } : null);
  else if (rng.chance(0.6)) waterTank(w, rng.range(ix0 + 1, ix1 - 1), roofY, rng.range(iz0 + 1, iz1 - 1), rng, rng.chance(0.5));

  // ---- cover points: inside windows / doors of enterable buildings
  if (s.enter) {
    for (const f of faces) {
      const fr = frames[f];
      for (const o of ops[f]) {
        if (o.floor !== 0) continue;
        const uc = (o.u0 + o.u1) / 2;
        if (o.kind === 'window') {
          const p = fpt(fr, uc, BASE, -WALL - 0.5);
          w.addCover(p.x, BASE, p.z, -fr.nx, -fr.nz);
        } else if (o.kind === 'door' || o.kind === 'double' || o.kind === 'shop') {
          const p = fpt(fr, o.u0 - 0.55, BASE, -WALL - 0.45);
          if (o.u0 - 0.55 > fr.uA + 0.3) w.addCover(p.x, BASE, p.z, -fr.nx, -fr.nz);
        }
      }
    }
  }
}

// ======================================================================= helpers

function solidSpans(a: number, b: number, ops: { u0: number; u1: number }[]): [number, number][] {
  const out: [number, number][] = [];
  let cur = a;
  for (const o of [...ops].sort((p, q) => p.u0 - q.u0)) {
    if (o.u0 > cur) out.push([cur, o.u0]);
    cur = Math.max(cur, o.u1);
  }
  if (b > cur) out.push([cur, b]);
  return out;
}

function wallBand(w: WCtx, fr: FaceFrame, key: MatKey, yb: number, yt: number, uA: number, uB: number, d0: number, d1: number, ops: Opening[]) {
  let cur = uA;
  for (const o of ops) {
    if (o.u0 > cur) fbox(w, fr, key, cur, o.u0, yb, yt, d0, d1, true);
    if (o.y0 > yb) fbox(w, fr, key, o.u0, o.u1, yb, o.y0, d0, d1, true);
    if (o.y1 < yt) fbox(w, fr, key, o.u0, o.u1, o.y1, yt, d0, d1, true);
    cur = o.u1;
  }
  if (uB > cur) fbox(w, fr, key, cur, uB, yb, yt, d0, d1, true);
}

function slabWithHole(w: WCtx, key: MatKey, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, h: { x0: number; z0: number; x1: number; z1: number }, col = true) {
  w.b.boxMM(key, x0, y0, z0, h.x0, y1, z1, col);
  w.b.boxMM(key, h.x1, y0, z0, x1, y1, z1, col);
  w.b.boxMM(key, h.x0, y0, z0, h.x1, y1, h.z0, col);
  w.b.boxMM(key, h.x0, y0, h.z1, h.x1, y1, z1, col);
}

function partition(w: WCtx, key: MatKey, ax: number, az: number, bx: number, bz: number, yb: number, yt: number, doorAt: number, open: boolean) {
  const len = Math.hypot(bx - ax, bz - az);
  const tx = (bx - ax) / len, tz = (bz - az) / len;
  const ry = Math.atan2(-tz, tx);
  const seg = (u0: number, u1: number, y0: number, y1: number) => {
    const uc = (u0 + u1) / 2;
    w.b.box(key, ax + tx * uc, (y0 + y1) / 2, az + tz * uc, u1 - u0, y1 - y0, 0.14, { ry, col: true });
  };
  const dw = 0.95;
  seg(0, doorAt - dw / 2, yb, yt);
  seg(doorAt + dw / 2, len, yb, yt);
  seg(doorAt - dw / 2, doorAt + dw / 2, yb + 2.15, yt);
  if (!open) seg(doorAt - dw / 2, doorAt + dw / 2, yb, yb + 2.15);
}

function stairTotalLen(roofY: number) {
  const n = Math.ceil(roofY / 0.18);
  return n * 0.27 + 1.2 + 1.3;
}

/** Straight flight in frame f (local +x = up-run direction, local z = width centred). */
export function stairFlight(w: WCtx, f: Frame, key: MatKey, n: number, rise: number, run: number, width: number, solid: boolean, yBase = 0) {
  for (let i = 0; i < n; i++) {
    const top = yBase + (i + 1) * rise;
    const bot = solid ? yBase : top - 0.22;
    fb(w, f, key, i * run + run / 2, (top + bot) / 2, 0, run + 0.01, top - bot, width);
    // nosing lip
    fb(w, f, mk('concrete_dirty', 1), i * run + 0.02, top - 0.015, 0, 0.05, 0.03, width + 0.01);
  }
  if (!solid) {
    // sloped underside slab
    const H = n * rise, L = n * run;
    const a = Math.atan2(H, L);
    const len = Math.hypot(L, H);
    fb(w, f, key, L / 2 + 0.09, yBase + H / 2 - 0.25, 0, len, 0.12, width, false, 0, a);
  }
  // ramp collider (smooth walking)
  const H = n * rise;
  const x0 = -run, x1 = (n - 1) * run;
  const a = Math.atan2(H, x1 - x0);
  const len = Math.hypot(x1 - x0, H);
  const T = 0.12;
  const mx = (x0 + x1) / 2 + (T / 2) * Math.sin(a), my = yBase + H / 2 - (T / 2) * Math.cos(a);
  const p = f.p(mx, 0, 0);
  w.b.colBox(p.x, my, p.z, len, T, width, 'concrete', f.ry, 0, a);
}

function railing(w: WCtx, key: MatKey, a: THREE.Vector3, b: THREE.Vector3, h: number, col = true) {
  const len = a.distanceTo(b);
  const ry = Math.atan2(-(b.z - a.z), b.x - a.x);
  const f = new Frame((a.x + b.x) / 2, a.y, (a.z + b.z) / 2, ry);
  fb(w, f, key, 0, h, 0, len, 0.04, 0.04);
  fb(w, f, key, 0, h * 0.5, 0, len, 0.025, 0.025);
  const n = Math.max(1, Math.round(len / 1.2));
  for (let i = 0; i <= n; i++) fb(w, f, key, -len / 2 + (len * i) / n, h / 2, 0, 0.035, h, 0.035);
  if (col) w.b.colBox(f.x, a.y + h / 2, f.z, len, h, 0.06, 'metal', ry);
}

function cylSag(a: THREE.Vector3, b: THREE.Vector3, sag: number): THREE.BufferGeometry {
  const mid = a.clone().lerp(b, 0.5);
  mid.y -= sag;
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  return new THREE.TubeGeometry(curve, 6, 0.01, 3, false);
}

function drainPipe(w: WCtx, fr: FaceFrame, u: number, roofY: number, rng: RNG) {
  const key = mk(rng.pick(['metal_painted_green', 'plastic_black', 'metal_rusty'] as const), rng.int(0, 2));
  const top = fpt(fr, u, roofY + 0.2, 0.1), bot = fpt(fr, u, 0.35, 0.1);
  w.b.add(key, cylBetween(bot, top, 0.045, 8));
  // scupper through the parapet
  w.b.add(key, cylBetween(fpt(fr, u, roofY + 0.2, -0.3), top, 0.05, 8));
  // shoe
  w.b.add(key, cylBetween(bot, fpt(fr, u, 0.12, 0.3), 0.045, 8));
  for (let y = 1.2; y < roofY; y += 1.6) fbox(w, fr, mk('metal_rusty', 0), u - 0.06, u + 0.06, y, y + 0.04, 0, 0.1);
  w.decal(D.DAMP, fpt(fr, u, 0.5, 0), fnorm(fr), 1.1, 1.0, 0, 0.008);
}

// ------------------------------------------------------------------ openings dressing
interface WinOpts { frameKey: MatKey; shutterKey: MatKey; trimKey: MatKey; style: number; ground: boolean; lockGround: boolean; simple: boolean }

function dressWindow(w: WCtx, fr: FaceFrame, o: Opening, rng: RNG, op: WinOpts) {
  const ww = o.u1 - o.u0, wh = o.y1 - o.y0, uc = (o.u0 + o.u1) / 2;
  // sill + head
  fbox(w, fr, op.trimKey, o.u0 - 0.08, o.u1 + 0.08, o.y0 - 0.07, o.y0 + 0.005, -0.06, 0.07);
  fbox(w, fr, op.trimKey, o.u0 - 0.13, o.u1 + 0.13, o.y1, o.y1 + 0.2, 0, 0.035);
  if (op.style !== 1 && rng.chance(0.5)) {
    fbox(w, fr, op.trimKey, o.u0 - 0.1, o.u0, o.y0, o.y1, 0, 0.025);
    fbox(w, fr, op.trimKey, o.u1, o.u1 + 0.1, o.y0, o.y1, 0, 0.025);
  }
  // decorative arch relief above window (some buildings)
  if (op.style === 2 && !op.ground && rng.chance(0.6)) {
    const ext = new THREE.ExtrudeGeometry(ringShape(ww / 2 + 0.02, ww / 2 + 0.14), { depth: 0.04, bevelEnabled: false, curveSegments: 10 });
    const m = faceMatrix(fr, 0);
    m.multiply(new THREE.Matrix4().makeTranslation(uc, o.y1 + 0.2, 0));
    w.b.add(op.trimKey, ext, m);
  }
  // frame at d=-0.12 (set back in the reveal)
  const fd0 = -0.16, fd1 = -0.09;
  const fk = op.frameKey;
  const glassState = op.simple ? (rng.chance(0.6) ? 'glass' : 'dark') : rng.pick(['glass', 'glass', 'broken', 'none', 'glass'] as const);
  fbox(w, fr, fk, o.u0, o.u0 + 0.05, o.y0, o.y1, fd0, fd1);
  fbox(w, fr, fk, o.u1 - 0.05, o.u1, o.y0, o.y1, fd0, fd1);
  fbox(w, fr, fk, o.u0, o.u1, o.y1 - 0.05, o.y1, fd0, fd1);
  fbox(w, fr, fk, o.u0, o.u1, o.y0, o.y0 + 0.05, fd0, fd1);
  if (glassState !== 'none') {
    fbox(w, fr, fk, uc - 0.025, uc + 0.025, o.y0, o.y1, fd0, fd1);
    fbox(w, fr, fk, o.u0, o.u1, o.y1 - 0.42, o.y1 - 0.38, fd0, fd1);
  }
  if (glassState === 'glass' || glassState === 'dark') {
    fbox(w, fr, mk(rng.chance(0.7) ? 'glass_dirty' : 'glass', 0), o.u0 + 0.04, o.u1 - 0.04, o.y0 + 0.04, o.y1 - 0.04, -0.13, -0.125);
  } else if (glassState === 'broken') {
    // jagged shards left in the frame
    for (let i = 0; i < 3; i++) {
      const s = rng.range(0.15, 0.35);
      const sh = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(s, 0), new THREE.Vector2(rng.range(0, s), rng.range(0.2, 0.5))]);
      const g = new THREE.ShapeGeometry(sh);
      const m = faceMatrix(fr, -0.127);
      const cu = i === 0 ? o.u0 + 0.05 : i === 1 ? o.u1 - 0.05 - s : uc + 0.03;
      m.multiply(new THREE.Matrix4().makeTranslation(cu, o.y0 + 0.05, 0));
      w.b.add(mk('glass_dirty', 0), twoSided(g, 0.002), m);
    }
  }
  // curtain inside
  if (!op.simple && rng.chance(0.4)) {
    const c = new THREE.Color(rng.pick([0x8c2a2a, 0x2c4a7a, 0xd8d2c4, 0x4f6b3a, 0xb58b4a, 0x6e4b7c])).multiplyScalar(0.8);
    const cw = ww * rng.range(0.4, 0.7);
    const g = new THREE.PlaneGeometry(cw, wh - 0.1, 6, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 22) * 0.03);
    g.computeVertexNormals();
    paint(g, c);
    const m = faceMatrix(fr, -0.3);
    m.multiply(new THREE.Matrix4().makeTranslation(rng.chance(0.5) ? o.u0 + cw / 2 + 0.05 : o.u1 - cw / 2 - 0.05, (o.y0 + o.y1) / 2, 0));
    w.b.add('custom:cloth', g, m, 'keep');
  }
  // shutters
  const shutters = op.style === 0 ? rng.chance(0.8) : op.style === 2 ? rng.chance(0.4) : false;
  if (shutters && !op.simple) {
    const closed = rng.chance(0.25);
    for (const side of [-1, 1] as const) {
      const ang = closed ? 0 : rng.range(1.9, 3.0);
      const hingeU = side < 0 ? o.u0 : o.u1;
      shutterLeaf(w, fr, op.shutterKey, hingeU, o.y0 + 0.02, 0.035, ww / 2 - 0.01, wh - 0.04, side, closed ? 0 : (rng.chance(0.15) ? rng.range(0.6, 1.4) : ang), rng);
    }
  } else if (op.style === 1 || op.ground) {
    // grille
    if (op.ground || rng.chance(0.4)) {
      const gk = mk(rng.chance(0.5) ? 'metal_rusty' : 'metal_painted_green', rng.int(0, 2));
      const n = Math.max(3, Math.round(ww / 0.13));
      for (let i = 1; i < n; i++) fbox(w, fr, gk, o.u0 + (ww * i) / n - 0.009, o.u0 + (ww * i) / n + 0.009, o.y0, o.y1, -0.03, -0.012);
      for (const y of [o.y0 + 0.1, (o.y0 + o.y1) / 2, o.y1 - 0.1]) fbox(w, fr, gk, o.u0, o.u1, y - 0.015, y + 0.015, -0.035, -0.01);
    }
  }
  // lock ground windows of closed buildings
  if (op.ground && op.lockGround) {
    const c = fpt(fr, uc, 0, -WALL / 2);
    w.b.colBox(c.x, (o.y0 + o.y1) / 2, c.z, ww, wh, WALL, 'metal', fr.ry);
  }
  if (op.simple) return;
  // stains & cracks
  if (rng.chance(0.55)) w.decal(D.STREAKS, fpt(fr, uc, o.y0 - 0.07 - 0.6, 0), fnorm(fr), ww + 0.3, 1.2, 0, 0.006);
  if (rng.chance(0.25)) w.decal(D.CRACKS, fpt(fr, rng.chance(0.5) ? o.u0 - 0.25 : o.u1 + 0.25, o.y1 + 0.3, 0), fnorm(fr), 0.9, 0.9, rng.range(0, 6), 0.007);
  // wall AC under upper windows
  if (!op.ground && rng.chance(0.14)) {
    const f = faceProp(fr, uc + rng.jit(0.2), o.y0 - 0.95, 0.26);
    acUnit(w, f.x, f.y, f.z, fr.ry, rng, true);
  } else if (!op.ground && rng.chance(0.05)) {
    const p = fpt(fr, o.u1 + 0.35, o.y0 + 0.3, 0.15);
    satDish(w, p.x, p.y, p.z, fr.ry, rng, true);
  }
}

function ringShape(r0: number, r1: number) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r1, 0, Math.PI, false);
  s.lineTo(-r0, 0);
  s.absarc(0, 0, r0, Math.PI, 0, true);
  s.lineTo(r1, 0);
  return s;
}

/** Louvered shutter leaf hinged at hingeU; side -1 = left leaf (extends +u when closed). ang = open angle (0 closed, PI flat to wall). */
function shutterLeaf(w: WCtx, fr: FaceFrame, key: MatKey, hingeU: number, y0: number, d: number, lw: number, lh: number, side: -1 | 1, ang: number, rng: RNG) {
  // leaf direction in world: closed -> +t (left) / -t (right); rotate outward about vertical axis
  const t = new THREE.Vector3(fr.tx, 0, fr.tz).multiplyScalar(-side);
  const n = new THREE.Vector3(fr.nx, 0, fr.nz);
  const dir = t.clone().multiplyScalar(Math.cos(ang)).addScaledVector(n, Math.sin(ang));
  const hinge = fpt(fr, hingeU, 0, d);
  const ry = Math.atan2(-dir.z, dir.x);
  const f = new Frame(hinge.x, y0, hinge.z, ry);
  fb(w, f, key, 0.025, lh / 2, 0, 0.05, lh, 0.03);
  fb(w, f, key, lw - 0.025, lh / 2, 0, 0.05, lh, 0.03);
  fb(w, f, key, lw / 2, 0.04, 0, lw, 0.08, 0.03);
  fb(w, f, key, lw / 2, lh - 0.04, 0, lw, 0.08, 0.03);
  fb(w, f, key, lw / 2, lh * 0.5, 0, lw, 0.06, 0.03);
  const slats = Math.floor((lh - 0.2) / 0.075);
  for (let i = 0; i < slats; i++) {
    const y = 0.1 + i * 0.075 + 0.03;
    if (Math.abs(y - lh * 0.5) < 0.05) continue;
    fb(w, f, key, lw / 2, y, 0, lw - 0.1, 0.055, 0.01, false, 0.6);
  }
  if (rng.chance(0.3)) fb(w, f, mk('metal_rusty', 0), 0.02, lh * 0.8, 0, 0.06, 0.03, 0.04);
}

function dressDoor(w: WCtx, fr: FaceFrame, o: Opening, rng: RNG, doorKey: MatKey, frameKey: MatKey, trimKey: MatKey, open: boolean) {
  const ww = o.u1 - o.u0, uc = (o.u0 + o.u1) / 2;
  // threshold step
  fbox(w, fr, mk('concrete', 2), o.u0 - 0.06, o.u1 + 0.06, 0, BASE + 0.015, -WALL - 0.01, 0.16, true);
  if (o.kind === 'arch') {
    // arched passage: keystone band + reveal trim
    fbox(w, fr, trimKey, o.u0 - 0.25, o.u1 + 0.25, o.y1, o.y1 + 0.3, 0, 0.05);
    fbox(w, fr, trimKey, o.u0 - 0.2, o.u0, 0, o.y1, 0, 0.04);
    fbox(w, fr, trimKey, o.u1, o.u1 + 0.2, 0, o.y1, 0, 0.04);
    return;
  }
  // frame
  const fk = frameKey;
  fbox(w, fr, fk, o.u0, o.u0 + 0.06, BASE, o.y1, -0.2, -0.08);
  fbox(w, fr, fk, o.u1 - 0.06, o.u1, BASE, o.y1, -0.2, -0.08);
  fbox(w, fr, fk, o.u0, o.u1, o.y1 - 0.06, o.y1, -0.2, -0.08);
  // head trim + small canopy
  fbox(w, fr, trimKey, o.u0 - 0.15, o.u1 + 0.15, o.y1, o.y1 + 0.2, 0, 0.04);
  if (rng.chance(0.35)) {
    fbox(w, fr, mk('concrete', 1), o.u0 - 0.35, o.u1 + 0.35, o.y1 + 0.3, o.y1 + 0.4, 0, 0.7);
    fbox(w, fr, mk('metal_rusty', 0), o.u0 - 0.3, o.u0 - 0.26, o.y1 + 0.1, o.y1 + 0.3, 0, 0.5, false, 0.6);
    fbox(w, fr, mk('metal_rusty', 0), o.u1 + 0.26, o.u1 + 0.3, o.y1 + 0.1, o.y1 + 0.3, 0, 0.5, false, 0.6);
  }
  // leaves
  const leaves = o.kind === 'double' ? 2 : 1;
  const lw = (ww - 0.12) / leaves;
  const lh = o.y1 - BASE - 0.07;
  for (let i = 0; i < leaves; i++) {
    const side = i === 0 ? -1 : 1;
    const hingeU = side < 0 ? o.u0 + 0.06 : o.u1 - 0.06;
    const ang = open ? -rng.range(1.3, 1.75) : rng.chance(0.15) ? -0.25 : 0; // negative = swing inward
    const t = new THREE.Vector3(fr.tx, 0, fr.tz).multiplyScalar(-side);
    const n = new THREE.Vector3(fr.nx, 0, fr.nz);
    const dir = t.clone().multiplyScalar(Math.cos(ang)).addScaledVector(n, Math.sin(ang));
    const hinge = fpt(fr, hingeU, 0, -0.17);
    const f = new Frame(hinge.x, BASE + 0.01, hinge.z, Math.atan2(-dir.z, dir.x));
    fb(w, f, doorKey, lw / 2, lh / 2, 0, lw, lh, 0.05, !open);
    // panels / ribs on the steel doors
    fb(w, f, doorKey, lw / 2, lh * 0.72, 0.03, lw - 0.16, lh * 0.36, 0.015);
    fb(w, f, doorKey, lw / 2, lh * 0.27, 0.03, lw - 0.16, lh * 0.38, 0.015);
    fb(w, f, mk('metal_bare', 2), lw - 0.1, lh * 0.48, 0.05, 0.12, 0.03, 0.04);
  }
  if (!open) {
    const c = fpt(fr, uc, 0, -0.17);
    w.b.colBox(c.x, (BASE + o.y1) / 2, c.z, ww, o.y1 - BASE, 0.1, 'metal', fr.ry);
  }
  w.decal(D.GRIME, fpt(fr, uc, 0.6, 0.03), fnorm(fr), ww + 0.8, 1.2, 0, 0.006);
}

function dressShop(w: WCtx, fr: FaceFrame, o: Opening, rng: RNG, enter: boolean, trimKey: MatKey, simple: boolean) {
  const ww = o.u1 - o.u0, uc = (o.u0 + o.u1) / 2;
  const shutKey = mk(rng.pick(['metal_corrugated', 'metal_corrugated', 'metal_rusty', 'metal_painted_green', 'metal_painted_blue'] as const), rng.int(0, 3));
  fbox(w, fr, mk('concrete', 2), o.u0 - 0.05, o.u1 + 0.05, 0, BASE + 0.015, -WALL - 0.01, 0.12, true);
  // housing + guide rails
  const hy0 = o.y1 - 0.34;
  fbox(w, fr, shutKey, o.u0 - 0.04, o.u1 + 0.04, hy0, o.y1, -0.08, 0.2);
  fbox(w, fr, mk('metal_bare', 2), o.u0, o.u0 + 0.05, BASE, hy0, -0.02, 0.07);
  fbox(w, fr, mk('metal_bare', 2), o.u1 - 0.05, o.u1, BASE, hy0, -0.02, 0.07);
  // shutter panel
  const openFrac = enter ? rng.pick([1, 1, 0.85, 0.7]) : rng.pick([0, 0, 0.1, 0.35, 0.5]);
  const bottom = BASE + (hy0 - BASE) * openFrac;
  if (hy0 - bottom > 0.05) {
    const m = faceMatrix(fr, 0.03);
    m.multiply(new THREE.Matrix4().makeTranslation(uc, (bottom + hy0) / 2, 0));
    m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    const sheet = corrugated(hy0 - bottom, ww - 0.1, 0.075, 0.02);
    w.b.add(shutKey, twoSided(sheet, 0.01), m);
    fbox(w, fr, mk('metal_bare', 1), o.u0 + 0.05, o.u1 - 0.05, bottom, bottom + 0.06, 0.0, 0.07);
    if (rng.chance(0.4)) fbox(w, fr, mk('metal_bare', 3), uc - 0.06, uc + 0.06, bottom + 0.06, bottom + 0.14, 0.05, 0.08); // lock
    if (bottom < BASE + 1.3) {
      const c = fpt(fr, uc, 0, 0.03);
      w.b.colBox(c.x, (BASE + hy0) / 2, c.z, ww, hy0 - BASE, 0.08, 'metal', fr.ry);
    }
    if (!simple && rng.chance(0.35)) w.decal(rng.pick([D.GRAFFITI_A, D.GRAFFITI_B, D.STENCIL]), fpt(fr, uc, Math.max(bottom + 0.6, (bottom + hy0) / 2), 0.05), fnorm(fr), Math.min(ww - 0.3, 1.8), Math.min(hy0 - bottom - 0.1, 1.6), 0, 0.006);
  }
  if (simple) return;
  // sign board above
  if (rng.chance(0.8)) {
    const sy0 = o.y1 + 0.1, sy1 = o.y1 + 0.72;
    const su0 = o.u0 - rng.range(0, 0.3), su1 = o.u1 + rng.range(0, 0.3);
    fbox(w, fr, mk('metal_painted_blue', 2), su0, su1, sy0, sy1, 0.08, 0.13);
    const idx = signCounter++ % (SIGN_COLS * SIGN_ROWS);
    const g = atlasQuad(su1 - su0 - 0.06, sy1 - sy0 - 0.06, signRect(idx));
    const m = faceMatrix(fr, 0.132);
    m.multiply(new THREE.Matrix4().makeTranslation((su0 + su1) / 2, (sy0 + sy1) / 2, 0));
    w.b.add('custom:sign', g, m, 'keep');
    for (const u of [su0 + 0.2, su1 - 0.2]) fbox(w, fr, mk('metal_rusty', 0), u - 0.02, u + 0.02, sy0 + 0.1, sy1 - 0.1, 0, 0.08);
    w.decal(D.RUST, fpt(fr, (su0 + su1) / 2, sy0 - 0.5, 0.0), fnorm(fr), su1 - su0, 1.0, 0, 0.008);
  }
  // projecting (perpendicular) sign on the pier beside the shop
  if (rng.chance(0.3) && o.u0 > fr.uA + 0.6) {
    const u = o.u0 - 0.3, y0 = level(1) + 0.4, y1 = y0 + rng.range(1.0, 1.5);
    const idx = signCounter++ % (SIGN_COLS * SIGN_ROWS);
    for (const side of [-1, 1]) {
      const g = atlasQuad(y1 - y0 - 0.06, 0.62, signRect(idx));
      g.rotateZ(Math.PI / 2);
      const m = faceMatrix(fr, 0);
      m.multiply(new THREE.Matrix4().makeTranslation(u + side * 0.036, (y0 + y1) / 2, 0.55));
      m.multiply(new THREE.Matrix4().makeRotationY(side * Math.PI / 2));
      w.b.add('custom:sign', g, m, 'keep');
    }
    const c = fpt(fr, u, (y0 + y1) / 2, 0.55);
    w.b.box(mk('metal_painted_blue', 1), c.x, c.y, c.z, 0.07, y1 - y0, 0.68, { ry: fr.ry });
    fbox(w, fr, mk('metal_rusty', 0), u - 0.02, u + 0.02, y1 - 0.05, y1, 0, 0.9);
    fbox(w, fr, mk('metal_rusty', 0), u - 0.02, u + 0.02, y0, y0 + 0.05, 0, 0.3);
  }
  // awning
  if (rng.chance(0.4)) {
    const ay = o.y1 + 0.02, depth = rng.range(1.1, 1.6), drop = rng.range(0.35, 0.55);
    const cols = rng.pick([[0x9a2d25, 0xd9d0bb], [0x24506e, 0xd9d0bb], [0x3f6a3a, 0xe0d8c2], [0xb8862c, 0x6b3a28], [0x7a2a52, 0xd8cfc0]]);
    const nStr = Math.max(4, Math.round((ww + 0.2) / 0.3));
    const sw = (ww + 0.2) / nStr;
    for (let i = 0; i < nStr; i++) {
      const g = new THREE.PlaneGeometry(sw, Math.hypot(depth, drop), 1, 3);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) pos.setZ(k, -Math.sin(((pos.getY(k) / Math.hypot(depth, drop)) + 0.5) * Math.PI) * 0.06);
      g.computeVertexNormals();
      paint(g, new THREE.Color(cols[i % 2]).multiplyScalar(0.85));
      const m = faceMatrix(fr, 0);
      m.multiply(new THREE.Matrix4().makeTranslation(o.u0 - 0.1 + sw * (i + 0.5), ay - drop / 2, depth / 2));
      m.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2 + Math.atan2(drop, depth)));
      w.b.add('custom:cloth', g, m, 'keep');
      // valance
      const vg = new THREE.PlaneGeometry(sw, 0.22);
      paint(vg, new THREE.Color(cols[i % 2]).multiplyScalar(0.8));
      const vm = faceMatrix(fr, depth + 0.005);
      vm.multiply(new THREE.Matrix4().makeTranslation(o.u0 - 0.1 + sw * (i + 0.5), ay - drop - 0.11, 0));
      w.b.add('custom:cloth', vg, vm, 'keep');
    }
    // frame arms
    for (const u of [o.u0 - 0.08, o.u1 + 0.08]) {
      w.b.add(mk('metal_bare', 2), cylBetween(fpt(fr, u, ay, 0), fpt(fr, u, ay - drop, depth), 0.015, 4));
      w.b.add(mk('metal_bare', 2), cylBetween(fpt(fr, u, ay - drop - 0.5, 0), fpt(fr, u, ay - drop, depth * 0.9), 0.012, 4));
    }
  } else if (rng.chance(0.3)) {
    // corrugated metal canopy on brackets
    const depth = rng.range(1.0, 1.5);
    const sheet = corrugated(ww + 0.4, depth, 0.12, 0.03);
    const m = faceMatrix(fr, 0);
    m.multiply(new THREE.Matrix4().makeTranslation(uc, o.y1 + 0.12, depth / 2));
    m.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2 + 0.12));
    w.b.add(mk('metal_corrugated', rng.int(0, 3)), twoSided(sheet, 0.006), m);
    for (const u of [o.u0 - 0.1, o.u1 + 0.1]) w.b.add(mk('metal_rusty', 1), cylBetween(fpt(fr, u, o.y1 - 0.4, 0), fpt(fr, u, o.y1 + 0.05, depth * 0.9), 0.02, 4));
  }
  // goods outside shop front
  if (enter && rng.chance(0.5)) {
    const f = faceProp(fr, o.u0 - 0.5, BASE, 0.5);
    if (rng.chance(0.5)) crate(w, f.x, BASE, f.z, fr.ry + rng.jit(0.2), 0.6, 0.4, 0.45, 'ply', false, rng.int(0, 3));
    else sacks(w, f.x, BASE, f.z, fr.ry, rng, 3);
  }
}

function dressBalcony(w: WCtx, fr: FaceFrame, o: Opening, rng: RNG, trimKey: MatKey, doorKey: MatKey) {
  const uc = (o.u0 + o.u1) / 2;
  const bw = rng.range(2.4, 3.2), depth = rng.range(0.95, 1.25);
  const u0 = uc - bw / 2, u1 = uc + bw / 2, y = o.y0;
  fbox(w, fr, trimKey, u0, u1, y - 0.2, y, 0, depth, true);
  fbox(w, fr, mk('tile_floor', 2), u0 + 0.02, u1 - 0.02, y, y + 0.01, 0, depth - 0.02);
  // brackets
  for (const u of [u0 + 0.2, u1 - 0.2]) fbox(w, fr, trimKey, u - 0.08, u + 0.08, y - 0.55, y - 0.2, 0, depth * 0.6, false);
  const rk = mk(rng.pick(['metal_painted_green', 'metal_rusty', 'metal_painted_blue'] as const), rng.int(0, 2));
  const railH = 1.0;
  // front rail
  fbox(w, fr, rk, u0, u1, y + railH - 0.04, y + railH, depth - 0.05, depth - 0.01);
  fbox(w, fr, rk, u0, u1, y + 0.08, y + 0.11, depth - 0.05, depth - 0.02);
  const nb = Math.round(bw / 0.12);
  for (let i = 0; i <= nb; i++) {
    const u = u0 + 0.02 + ((bw - 0.04) * i) / nb;
    fbox(w, fr, rk, u - 0.009, u + 0.009, y, y + railH, depth - 0.04, depth - 0.022);
  }
  for (const u of [u0, u1]) {
    fbox(w, fr, rk, u - 0.02, u + 0.02, y + railH - 0.04, y + railH, 0, depth);
    for (let i = 1; i < 8; i++) fbox(w, fr, rk, u - 0.009, u + 0.009, y, y + railH, (depth * i) / 8 - 0.009, (depth * i) / 8 + 0.009);
  }
  const c = fpt(fr, uc, 0, depth - 0.03);
  w.b.colBox(c.x, y + railH / 2, c.z, bw, railH, 0.06, 'metal', fr.ry);
  for (const u of [u0, u1]) {
    const cc = fpt(fr, u, 0, depth / 2);
    w.b.colBox(cc.x, y + railH / 2, cc.z, 0.06, railH, depth, 'metal', fr.ry);
  }
  // door frame + open leaf
  fbox(w, fr, trimKey, o.u0 - 0.12, o.u1 + 0.12, o.y1, o.y1 + 0.18, 0, 0.04);
  const fk = doorKey;
  fbox(w, fr, fk, o.u0, o.u0 + 0.05, y, o.y1, -0.16, -0.09);
  fbox(w, fr, fk, o.u1 - 0.05, o.u1, y, o.y1, -0.16, -0.09);
  // laundry on the rail / plant pots
  if (rng.chance(0.6)) {
    for (let i = 0; i < rng.int(1, 3); i++) {
      const c2 = new THREE.Color(rng.pick([0xd8d2c4, 0x2c4a7a, 0x8c2a2a, 0x3d5e3a, 0xc4a35a])).multiplyScalar(0.85);
      const g = new THREE.PlaneGeometry(rng.range(0.4, 0.9), rng.range(0.5, 1.0), 2, 3);
      const gh = (g.parameters as { height: number }).height;
      paint(g, c2);
      const m = faceMatrix(fr, depth + 0.01);
      m.multiply(new THREE.Matrix4().makeTranslation(u0 + rng.range(0.4, bw - 0.4), y + railH - gh / 2 + 0.02, 0));
      w.b.add('custom:cloth', g, m, 'keep');
    }
  }
  w.decal(D.RUST, fpt(fr, uc, y - 0.2 - 0.6, 0), fnorm(fr), bw, 1.2, 0, 0.008);
  w.decks.push(balconyRect(fr, u0, u1, depth, y));
}

function balconyRect(fr: FaceFrame, u0: number, u1: number, depth: number, y: number) {
  const a = fpt(fr, u0, y, 0), b = fpt(fr, u1, y, depth);
  return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z), h: y };
}

function damagePatch(w: WCtx, fr: FaceFrame, rng: RNG, ops: Opening[], roofY: number, wallKey: MatKey, patchKey: MatKey) {
  for (let tries = 0; tries < 8; tries++) {
    const rx = rng.range(0.3, 1.1), ry = rng.range(0.22, 0.75);
    const u = rng.range(fr.uA + rx + 0.3, fr.uB - rx - 0.3);
    const y = rng.range(0.9 + ry, roofY - ry - 0.5);
    if (!(u > 0) || !(y > 0)) return;
    if (ops.some((o) => u + rx > o.u0 - 0.25 && u - rx < o.u1 + 0.25 && y + ry > o.y0 - 0.3 && y - ry < o.y1 + 0.3)) continue;
    const r = () => rng.next();
    const inner = blobPoints(u, y, rx, ry, r, 26, 0.5);
    const outer = inner.map((p) => new THREE.Vector2(u + (p.x - u) * 1.12 + rng.jit(0.03), y + (p.y - y) * 1.14 + rng.jit(0.03)));
    const patch = new THREE.ShapeGeometry(new THREE.Shape(inner));
    w.b.add(patchKey, patch, faceMatrix(fr, 0.006));
    const ring = new THREE.Shape(outer);
    ring.holes.push(new THREE.Path(inner.slice().reverse()));
    const rg = new THREE.ExtrudeGeometry(ring, { depth: 0.022, bevelEnabled: false });
    w.b.add(wallKey, rg, faceMatrix(fr, 0));
    // a few loose bricks at the base below large patches
    if (rx > 0.7 && y < 3 && rng.chance(0.5)) {
      for (let i = 0; i < 4; i++) {
        const p = fpt(fr, u + rng.jit(rx), 0.04, rng.range(0.1, 0.6));
        w.b.box(patchKey, p.x, 0.035, p.z, 0.22, 0.065, 0.1, { ry: rng.range(0, 3) });
      }
    }
    return;
  }
}

// ------------------------------------------------------------------ exterior stairs
function exteriorStairs(w: WCtx, fr: FaceFrame, u0: number, dir: 1 | -1, roofY: number, rng: RNG) {
  const H = roofY;
  const n = Math.ceil(H / 0.18);
  const rise = H / n, run = 0.27, width = 1.15;
  const n1 = Math.floor(n / 2), n2 = n - n1;
  const key = mk('concrete', rng.int(0, 3));
  // stair frame: local +x along face (dir), local z centred at d = width/2 outward
  const tx = fr.tx * dir, tz = fr.tz * dir;
  const ry = Math.atan2(-tz, tx);
  const zSign = Math.sin(ry) * fr.nx + Math.cos(ry) * fr.nz; // local +z vs outward normal
  const at = (along: number, y: number) => {
    const p = fpt(fr, u0 + dir * along, y, width / 2 + 0.02);
    return new Frame(p.x, y, p.z, ry);
  };
  const f1 = at(0, 0);
  stairFlight(w, f1, key, n1, rise, run, width, false, 0);
  const land1 = n1 * run;
  const y1 = n1 * rise;
  const fl = at(land1 + 0.6, 0);
  fb(w, fl, key, 0, y1 - 0.11, 0, 1.2, 0.22, width, true);
  // landing support column
  fb(w, fl, key, 0.4, (y1 - 0.22) / 2, 0.3 * zSign, 0.25, y1 - 0.22, 0.25, true);
  const f2 = at(land1 + 1.2, 0);
  stairFlight(w, f2, key, n2, rise, run, width, false, y1);
  const topAt = land1 + 1.2 + n2 * run;
  const ft = at(topAt + 0.65, 0);
  fb(w, ft, key, 0, H - 0.11, 0, 1.3, 0.22, width, true);
  fb(w, ft, key, 0, (H - 0.22) / 2, 0.3 * zSign, 0.25, H - 0.22, 0.25, true);
  // railings on the outer edge
  const rk = mk('metal_rusty', 1);
  const edge = (along: number, y: number) => fpt(fr, u0 + dir * along, y, width + 0.0);
  const rail = (a: THREE.Vector3, b: THREE.Vector3) => {
    w.b.add(rk, cylBetween(a.clone().setY(a.y + 0.95), b.clone().setY(b.y + 0.95), 0.025, 6));
    w.b.add(rk, cylBetween(a.clone().setY(a.y + 0.5), b.clone().setY(b.y + 0.5), 0.015, 5));
    const len = a.distanceTo(b);
    const np = Math.max(1, Math.round(len / 1.1));
    for (let i = 0; i <= np; i++) {
      const p = a.clone().lerp(b, i / np);
      w.b.add(rk, cylBetween(p, p.clone().setY(p.y + 0.95), 0.018, 5));
    }
    // collision fence
    const mid = a.clone().lerp(b, 0.5);
    const horiz = Math.hypot(b.x - a.x, b.z - a.z);
    const slope = Math.atan2(b.y - a.y, horiz);
    w.b.colBox(mid.x, mid.y + 0.5, mid.z, horiz / Math.cos(slope) + 0.05, 1.0, 0.06, 'metal', ry, 0, slope);
  };
  rail(edge(-run, rise * 0.5), edge(land1, y1));
  rail(edge(land1, y1), edge(land1 + 1.2, y1));
  rail(edge(land1 + 1.2, y1), edge(topAt, H));
  rail(edge(topAt, H), edge(topAt + 1.3, H));
  // end rail at top landing
  w.b.add(rk, cylBetween(fpt(fr, u0 + dir * (topAt + 1.3), H + 0.95, 0), fpt(fr, u0 + dir * (topAt + 1.3), H + 0.95, width), 0.025, 6));
  const ce = fpt(fr, u0 + dir * (topAt + 1.3), 0, width / 2);
  w.b.colBox(ce.x, H + 0.5, ce.z, 0.06, 1.0, width, 'metal', fr.ry);
  const c0 = fpt(fr, u0 + dir * (topAt + 0.65), 0, width + 0.5);
  w.addCover(c0.x, H, c0.z, fr.nx, fr.nz);
}

// ------------------------------------------------------------------ interiors
function furnish(w: WCtx, rng: RNG, ix0: number, iz0: number, ix1: number, iz1: number, y: number, longX: boolean, parts: number[], hole: { x0: number; z0: number; x1: number; z1: number } | null, density: number) {
  const len = longX ? ix1 - ix0 : iz1 - iz0;
  const bounds = [0, ...parts, len];
  for (let r = 0; r < bounds.length - 1; r++) {
    const a = bounds[r] + 0.2, b = bounds[r + 1] - 0.2;
    // room rect in world
    const rx0 = longX ? ix0 + a : ix0, rx1 = longX ? ix0 + b : ix1;
    const rz0 = longX ? iz0 : iz0 + a, rz1 = longX ? iz1 : iz0 + b;
    const occupied: [number, number, number, number][] = [];
    if (hole) occupied.push([hole.x0 - 0.6, hole.z0 - 0.3, hole.x1 + 0.6, hole.z1 + 0.6]);
    // keep door paths clear: centre band along the short axis is left mostly open
    const place = (sx: number, sz: number, fn: (x: number, z: number, ry: number) => void, wallHug = true) => {
      for (let t = 0; t < 10; t++) {
        let x: number, z: number, ry = 0;
        if (wallHug) {
          const side = rng.int(0, 3);
          if (side === 0) { x = rng.range(rx0 + sx / 2 + 0.1, rx1 - sx / 2 - 0.1); z = rz0 + sz / 2 + 0.08; ry = 0; }
          else if (side === 1) { x = rng.range(rx0 + sx / 2 + 0.1, rx1 - sx / 2 - 0.1); z = rz1 - sz / 2 - 0.08; ry = Math.PI; }
          else if (side === 2) { z = rng.range(rz0 + sx / 2 + 0.1, rz1 - sx / 2 - 0.1); x = rx0 + sz / 2 + 0.08; ry = -Math.PI / 2; }
          else { z = rng.range(rz0 + sx / 2 + 0.1, rz1 - sx / 2 - 0.1); x = rx1 - sz / 2 - 0.08; ry = Math.PI / 2; }
        } else {
          x = rng.range(rx0 + sx, rx1 - sx);
          z = rng.range(rz0 + sz, rz1 - sz);
          ry = rng.range(0, 6.28);
        }
        const hx = (Math.abs(Math.cos(ry)) * sx + Math.abs(Math.sin(ry)) * sz) / 2 + 0.05;
        const hz = (Math.abs(Math.sin(ry)) * sx + Math.abs(Math.cos(ry)) * sz) / 2 + 0.05;
        if (!(x - hx >= rx0 - 0.01 && x + hx <= rx1 + 0.01 && z - hz >= rz0 - 0.01 && z + hz <= rz1 + 0.01)) continue;
        if (occupied.some((o) => x + hx > o[0] && x - hx < o[2] && z + hz > o[1] && z - hz < o[3])) continue;
        occupied.push([x - hx, z - hz, x + hx, z + hz]);
        fn(x, z, ry);
        return true;
      }
      return false;
    };
    const items = Math.round(rng.range(1.5, 3.5) * density);
    for (let i = 0; i < items; i++) {
      const t = rng.next();
      if (t < 0.22) place(1.8, 0.5, (x, z, ry) => shelves(w, x, y, z, ry, rng));
      else if (t < 0.4) place(1.3, 0.8, (x, z, ry) => { table(w, x, y, z, ry, rng); if (rng.chance(0.7)) chair(w, x + 0.3, y, z + 0.6, ry + Math.PI + rng.jit(0.4), rng, false); }, false);
      else if (t < 0.55) place(2.0, 1.0, (x, z, ry) => crateStack(w, x - Math.cos(ry) * 0.8, y, z + Math.sin(ry) * 0.8, ry, rng));
      else if (t < 0.65) place(1.9, 0.9, (x, z, ry) => mattress(w, x, y, z, ry));
      else if (t < 0.75) place(2.2, 0.7, (x, z, ry) => sacks(w, x, y, z, ry, rng));
      else if (t < 0.85) place(1.3, 1.1, (x, z, ry) => { palletStack(w, x, y, z, ry, rng.int(2, 6), rng); }, false);
      else place(1, 1, (x, z) => { barrel(w, x, y, z, rng); if (rng.chance(0.5)) gasCylinder(w, x + 0.5, y, z, rng); });
    }
    // floor litter
    debris(w, (rx0 + rx1) / 2, y, (rz0 + rz1) / 2, Math.min(rx1 - rx0, rz1 - rz0) * 0.4, Math.round(6 * density), rng);
    if (rng.chance(0.5)) cardboard(w, rng.range(rx0 + 0.5, rx1 - 0.5), y, rng.range(rz0 + 0.5, rz1 - 0.5), rng, 2);
    w.decal(D.DIRT, new THREE.Vector3((rx0 + rx1) / 2, y + 0.005, (rz0 + rz1) / 2), new THREE.Vector3(0, 1, 0), Math.min(rx1 - rx0, 4), Math.min(rz1 - rz0, 4), rng.range(0, 6));
    // bare bulb on a wire
    const bx = (rx0 + rx1) / 2, bz = (rz0 + rz1) / 2;
    w.b.add(mk('rubber', 0), cylBetween(new THREE.Vector3(bx, y + FH - 0.25, bz), new THREE.Vector3(bx, y + FH - 0.7, bz), 0.006, 3));
    w.b.box(mk('glass', 0), bx, y + FH - 0.75, bz, 0.07, 0.1, 0.07);
  }
}

// ------------------------------------------------------------------ roofs
function roofDressing(w: WCtx, rng: RNG, s: BSpec, par: string, parH: number, roofY: number, ix0: number, iz0: number, ix1: number, iz1: number, arrival: { fr: FaceFrame; u: number; dir: number } | null) {
  const occupied: [number, number, number, number][] = [];
  if (arrival) {
    const p = fpt(arrival.fr, arrival.u - arrival.dir * 0.65, roofY, -2);
    occupied.push([p.x - 2.2, p.z - 2.2, p.x + 2.2, p.z + 2.2]);
  }
  const free = (x: number, z: number, r: number) => x - r > ix0 + 0.35 && x + r < ix1 - 0.35 && z - r > iz0 + 0.35 && z + r < iz1 - 0.35 && !occupied.some((o) => x + r > o[0] && x - r < o[2] && z + r > o[1] && z - r < o[3]);
  const spot = (r: number): [number, number] | null => {
    for (let t = 0; t < 14; t++) {
      const x = rng.range(ix0 + r + 0.4, ix1 - r - 0.4), z = rng.range(iz0 + r + 0.4, iz1 - r - 0.4);
      if (free(x, z, r)) { occupied.push([x - r, z - r, x + r, z + r]); return [x, z]; }
    }
    return null;
  };
  const area = (ix1 - ix0) * (iz1 - iz0);
  // bulkhead / roof room
  if (rng.chance(0.4) && area > 50) {
    const bw = rng.range(2.4, 3.6), bd = rng.range(2.2, 3.0);
    const sp = spot(Math.max(bw, bd) / 2 + 0.3);
    if (sp) {
      const [x, z] = sp;
      bulkhead(w, rng, x, roofY, z, bw, bd, rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]));
    }
  }
  for (let i = 0; i < rng.int(1, 3); i++) { const sp = spot(0.8); if (sp) waterTank(w, sp[0], roofY, sp[1], rng, rng.chance(0.6)); }
  for (let i = 0; i < rng.int(0, 3); i++) { const sp = spot(0.55); if (sp) acUnit(w, sp[0], roofY, sp[1], rng.pick([0, Math.PI / 2, Math.PI]), rng); }
  for (let i = 0; i < rng.int(1, 2); i++) { const sp = spot(0.6); if (sp) satDish(w, sp[0], roofY, sp[1], rng.range(0, 6), rng); }
  if (rng.chance(0.5)) { const sp = spot(0.4); if (sp) antenna(w, sp[0], roofY, sp[1], rng); }
  if (rng.chance(0.25)) { const sp = spot(1.2); if (sp) solarHeater(w, sp[0], roofY, sp[1], rng.pick([0, Math.PI])); }
  if (rng.chance(0.35)) {
    const sp = spot(0.5);
    if (sp) { if (rng.chance(0.5)) tire(w, sp[0], roofY, sp[1], true); else cinderStack(w, sp[0], roofY, sp[1], rng.range(0, 3), rng); }
  }
  if (rng.chance(0.3)) { const sp = spot(0.5); if (sp) chair(w, sp[0], roofY, sp[1], rng.range(0, 6), rng); }
  if (rng.chance(0.4) && (ix1 - ix0) > 5) {
    // clothesline across the roof
    const z = rng.range(iz0 + 1, iz1 - 1);
    const xa = ix0 + 0.6, xb = Math.min(ix1 - 0.6, xa + rng.range(3, 6));
    if (free((xa + xb) / 2, z, 0.3)) {
      for (const x of [xa, xb]) w.b.box(mk('metal_rusty', 1), x, roofY + 0.9, z, 0.04, 1.8, 0.04);
      clothesline(w, new THREE.Vector3(xa, roofY + 1.75, z), new THREE.Vector3(xb, roofY + 1.75, z), rng, 0.12);
    }
  }
  // rebar stubs at columns
  if (par === 'rebar') {
    const cols: [number, number][] = [[ix0 + 0.1, iz0 + 0.1], [ix1 - 0.1, iz0 + 0.1], [ix0 + 0.1, iz1 - 0.1], [ix1 - 0.1, iz1 - 0.1]];
    for (let x = ix0 + 4; x < ix1 - 2; x += 4) { cols.push([x, iz0 + 0.1]); cols.push([x, iz1 - 0.1]); }
    for (const [x, z] of cols) {
      const h = rng.range(0.4, 0.9);
      w.b.box(mk('concrete', 3), x, roofY + parH + h / 2, z, 0.32, h, 0.32, { col: true });
      for (const [ox, oz] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) {
        const a = new THREE.Vector3(x + ox, roofY + parH + h, z + oz);
        const b = a.clone().add(new THREE.Vector3(rng.jit(0.15), rng.range(0.6, 1.4), rng.jit(0.15)));
        w.b.add(mk('metal_rusty', 2), cylBetween(a, b, 0.009, 4));
      }
    }
  }
  // roof stains + sand
  for (let i = 0; i < 3; i++) {
    const x = rng.range(ix0 + 1, ix1 - 1), z = rng.range(iz0 + 1, iz1 - 1);
    w.decal(rng.pick([D.DIRT, D.OIL, D.SAND, D.DIRT]), new THREE.Vector3(x, roofY + 0.02, z), new THREE.Vector3(0, 1, 0), rng.range(1.5, 3.5), rng.range(1.5, 3.5), rng.range(0, 6));
  }
  // parapet-base grime along roof edges (inner side)
  if (s.roofProps && rng.chance(0.6)) {
    const sp = spot(1.1);
    if (sp) crateStack(w, sp[0], roofY, sp[1], rng.range(0, 3), rng);
  }
}

function bulkhead(w: WCtx, rng: RNG, x: number, y: number, z: number, bw: number, bd: number, ry: number) {
  const f = new Frame(x, y, z, ry);
  const key = mk(rng.pick(['plaster_worn', 'concrete_dirty', 'plaster_white'] as const), rng.int(0, 3));
  const H = 2.5;
  // walls with a door on local +z
  fb(w, f, key, 0, H / 2, -bd / 2 + 0.1, bw, H, 0.2, true);
  fb(w, f, key, -bw / 2 + 0.1, H / 2, 0, 0.2, H, bd, true);
  fb(w, f, key, bw / 2 - 0.1, H / 2, 0, 0.2, H, bd, true);
  const dw = 0.9;
  fb(w, f, key, (-bw / 2 + (-dw / 2)) / 2, H / 2, bd / 2 - 0.1, bw / 2 - dw / 2, H, 0.2, true);
  fb(w, f, key, (bw / 2 + dw / 2) / 2, H / 2, bd / 2 - 0.1, bw / 2 - dw / 2, H, 0.2, true);
  fb(w, f, key, 0, (2.1 + H) / 2, bd / 2 - 0.1, dw, H - 2.1, 0.2, true);
  fb(w, f, mk('metal_painted_green', rng.int(0, 2)), 0, 1.05, bd / 2 - 0.12, dw, 2.1, 0.05, true);
  fb(w, f, mk('concrete', 2), 0, H + 0.08, 0, bw + 0.2, 0.16, bd + 0.2, true);
  if (rng.chance(0.5)) waterTank(w, f.wx(0, -0.2), y + H + 0.16, f.wz(0, -0.2), rng, false);
  w.decal(D.STREAKS, f.p(0, H - 0.8, bd / 2 + 0.001), f.d(0, 1), bw, 1.6, 0, 0.008);
}

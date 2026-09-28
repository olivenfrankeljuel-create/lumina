import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Tuning } from './tuning';

export interface WorldQueries {
  /** Ray vs world + props. dir normalized. */
  ray(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { distance: number; point: THREE.Vector3; normal: THREE.Vector3; collider?: RAPIER.Collider } | null;
  /** Would a player capsule of `height` with its feet at `feet` overlap anything? */
  fits(feet: THREE.Vector3, height: number): boolean;
}

/**
 * A mantle/vault path. Horizontal motion is a cubic Hermite along `dir` whose end tangents are the entry
 * and exit speeds (momentum is carried through, never zeroed); vertical motion is a Hermite rise that
 * continues the incoming vertical velocity, so position and velocity are continuous at both ends.
 */
export interface MantlePlan {
  kind: 'mantle' | 'vault';
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** Height of the ledge top (world Y). */
  ledgeY: number;
  /** Ledge height above the starting feet. */
  height: number;
  duration: number;
  endCrouched: boolean;
  dir: THREE.Vector3;
  /** Horizontal distance along dir from start to end. */
  length: number;
  /** Horizontal speed along dir at start / end (m/s). */
  v0: number;
  v1: number;
  /** Lateral (perpendicular to dir) entry velocity, bled off during the move. */
  lateral: THREE.Vector3;
  /** Vertical speed at the start (m/s), continued into the rise. */
  startVy: number;
  /** Normalized time at which the rise (mantle) / apex (vault) is reached. */
  riseFrac: number;
  /** Vault apex feet height. */
  apexY: number;
}

export interface MantleInput {
  feet: THREE.Vector3;
  fwd: THREE.Vector3;
  grounded: boolean;
  /** Horizontal velocity. */
  vel: THREE.Vector3;
  vy: number;
  /** Ground height under the player (null if unknown/far). */
  groundY: number | null;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/** Why the last planMantle() call failed (debugging aid). */
export const mantleDebug = { reason: '' };

/**
 * Look for a mantleable ledge / vaultable wall in front of the player.
 * `fwd` is the horizontal facing direction (normalized).
 */
export function planMantle(q: WorldQueries, inp: MantleInput, T: Tuning): MantlePlan | null {
  const { feet, fwd, grounded } = inp;
  const R = T.radius;
  const maxH = grounded ? T.mantleMaxHeightGround : T.mantleMaxHeightAir;
  const along = Math.max(0, inp.vel.x * fwd.x + inp.vel.z * fwd.z);
  const reach = R + T.mantleReach + Math.min(along, 9) * T.mantleReachPerSpeed;

  // 1) find a wall face in front (several heights, nearest facing hit wins)
  let wallDist = Infinity;
  const minH = grounded ? T.mantleMinHeight : T.mantleMinHeightAir;
  const probeHeights = grounded ? [0.35, 0.7, 1.0, 1.25] : [0.03, 0.2, 0.45, 0.8, 1.2, 1.6, 1.85];
  for (const h of probeHeights) {
    if (h > maxH + 0.05) break;
    _o.copy(feet); _o.y += h;
    const hit = q.ray(_o, fwd, reach);
    if (!hit) continue;
    if (Math.abs(hit.normal.y) > 0.6) continue;
    if (hit.normal.x * fwd.x + hit.normal.z * fwd.z > -0.35) continue;
    if (hit.distance < wallDist) wallDist = hit.distance;
  }
  if (!isFinite(wallDist)) return fail('no wall');

  // 2) find the ledge top just past the wall face
  const face = new THREE.Vector3(feet.x + fwd.x * wallDist, feet.y, feet.z + fwd.z * wallDist);
  const topStart = maxH + 0.15;
  _o.set(face.x + fwd.x * 0.14, feet.y + topStart, face.z + fwd.z * 0.14);
  const top = q.ray(_o, DOWN, topStart - minH + 0.02);
  if (!top || top.distance < 0.01 || top.normal.y < 0.7) return fail(`no ledge top (${top ? top.distance.toFixed(2) + ' ny ' + top.normal.y.toFixed(2) : 'miss'})`);
  const ledgeY = top.point.y;
  const height = ledgeY - feet.y;
  if (height < minH || height > maxH) return fail(`height ${height.toFixed(2)}`);
  // mid-air: ignore small obstacles (curbs, low crates) — only real walls/ledges are grabbed
  if (!grounded && inp.groundY !== null && ledgeY - inp.groundY < T.mantleMinHeight) return fail('obstacle too low');

  // 3) room to rise at the current column
  _o.set(feet.x, ledgeY + 0.04, feet.z);
  if (!q.fits(_o, T.heightCrouch)) return fail('no room to rise');

  const dir = fwd.clone();
  const lateral = new THREE.Vector3(inp.vel.x - fwd.x * along, 0, inp.vel.z - fwd.z * along).clampLength(0, 1.5);
  /** Clear path over the top from the wall face out to distance L (chest height above the ledge). */
  const pathClear = (L: number) => {
    _o.set(face.x, ledgeY + 0.5, face.z);
    const h = q.ray(_o, fwd, Math.max(0.01, L - wallDist + R));
    return !h;
  };
  const common = { start: feet.clone(), ledgeY, height, dir, lateral, startVy: inp.vy };

  // 4) vault over thin, waist-high walls
  if (height <= T.vaultMaxHeight) {
    _o.set(face.x + fwd.x * (T.vaultMaxThickness + 0.05), ledgeY + 0.3, face.z + fwd.z * (T.vaultMaxThickness + 0.05));
    const deep = q.ray(_o, DOWN, 0.55);
    const thick = !!deep && Math.abs(deep.point.y - ledgeY) < 0.25;
    if (!thick) {
      const probe = T.vaultMaxThickness + 0.3;
      _o.set(face.x + fwd.x * probe, ledgeY - 0.08, face.z + fwd.z * probe);
      _d.copy(fwd).negate();
      const back = q.ray(_o, _d, probe);
      const thickness = back ? Math.max(0.02, probe - back.distance) : T.vaultMaxThickness;
      const apex = new THREE.Vector3(face.x + fwd.x * thickness * 0.5, ledgeY + 0.06, face.z + fwd.z * thickness * 0.5);
      if (q.fits(apex, T.heightCrouch)) {
        const v0 = along;
        const v1 = Math.max(T.vaultSpeedMul * v0, T.vaultMinSpeed);
        const dur = 0.42 + 0.1 * height;
        const lMin = wallDist + thickness + R + 0.3;
        const lDes = 0.5 * (v0 + v1) * dur;
        for (const L of lDes > lMin ? [lDes, lMin] : [lMin]) {
          const land = new THREE.Vector3(feet.x + fwd.x * L, 0, feet.z + fwd.z * L);
          _o.set(land.x, ledgeY + 0.2, land.z);
          const g = q.ray(_o, DOWN, height + 3.5);
          if (!g || g.point.y > ledgeY - 0.3) continue; // must come down on the far side
          if (L > lMin && !pathClear(L)) continue;
          land.y = g.point.y + T.skin;
          if (!q.fits(land, T.heightStand)) continue;
          return finalize({ ...common, kind: 'vault', end: land, duration: dur, endCrouched: false, length: L, v0, v1, riseFrac: 0.4, apexY: ledgeY + 0.08 });
        }
      }
    }
  }

  // 5) mantle up onto the top
  const highLedge = height > T.eyeStand - 0.2; // pulling up over something above the eyes kills momentum
  const v0 = highLedge ? Math.min(along, 1.0) : along;
  const v1 = Math.max(T.mantleExitMul * v0, T.mantleMinExit);
  const dur = 0.3 + 0.2 * height;
  const lMin = wallDist + R + 0.14;
  const lDes = 0.5 * (v0 + v1) * dur;
  for (const L of lDes > lMin ? [lDes, lMin] : [lMin]) {
    const end = new THREE.Vector3(feet.x + fwd.x * L, 0, feet.z + fwd.z * L);
    _o.set(end.x, ledgeY + 0.3, end.z);
    const g = q.ray(_o, DOWN, 0.5);
    if (!g || Math.abs(g.point.y - ledgeY) > 0.12) continue;
    if (L > lMin && !pathClear(L)) continue;
    end.y = g.point.y + T.skin;
    let endCrouched = false;
    if (!q.fits(end, T.heightStand)) {
      if (!q.fits(end, T.heightCrouch)) continue;
      endCrouched = true;
    }
    return finalize({ ...common, kind: 'mantle', end, duration: dur, endCrouched, length: L, v0, v1, riseFrac: 0.6, apexY: end.y });
  }
  return fail('no room on top');
}

/** Fit timing so the Hermite curves stay monotonic while keeping entry velocities continuous. */
function finalize(p: MantlePlan): MantlePlan {
  // horizontal: if there isn't room to carry the momentum (short top / constrained landing), shorten the
  // move and ease the exit speed down so the average speed matches the path (never overshoots/stalls)
  if (p.v0 * p.duration > 2 * p.length) p.duration = Math.max(0.26, (2 * p.length) / Math.max(p.v0, 1e-3));
  p.v0 = Math.min(p.v0, (2 * p.length) / p.duration);
  // mid-path speed 1.5·L/T − (v0+v1)/4 must not dip below the exit speed
  p.v1 = Math.max(0, Math.min(p.v1, (1.2 * p.length) / p.duration - 0.2 * p.v0));
  // vertical: the rise continues the current upward speed; rise sooner if that would overshoot
  const target = p.kind === 'vault' ? p.apexY : p.end.y;
  const dy = Math.max(0.01, target - p.start.y);
  if (p.startVy > 0 && p.startVy * p.duration * p.riseFrac > 3 * dy) p.riseFrac = Math.max(0.15, (3 * dy) / (p.startVy * p.duration));
  p.startVy = Math.max(p.startVy, -1.5);
  return p;
}

function fail(reason: string): null {
  mantleDebug.reason = reason;
  return null;
}

function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Cubic Hermite value and derivative (per unit u). */
function herm(a: number, b: number, m0: number, m1: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b + (u3 - u2) * m1;
}

/** Feet position along the mantle/vault path at normalized time t. */
export function evalMantle(p: MantlePlan, t: number, out: THREE.Vector3): THREE.Vector3 {
  t = clamp01(t);
  const T = p.duration;
  // horizontal: s(t) along dir from 0 to length with tangents v0·T and v1·T
  const s = herm(0, p.length, p.v0 * T, p.v1 * T, t);
  // lateral entry velocity bleeds off over the first ~third (smooth, no snap)
  const lk = Math.min(t, 0.35);
  const lat = T * (lk - (lk * lk) / 0.7); // ∫ (1 - t/0.35) dt
  out.x = p.start.x + p.dir.x * s + p.lateral.x * lat;
  out.z = p.start.z + p.dir.z * s + p.lateral.z * lat;
  const r = p.riseFrac;
  if (p.kind === 'mantle') {
    out.y = t < r ? herm(p.start.y, p.end.y, p.startVy * T * r, 0, t / r) : p.end.y;
  } else {
    if (t < r) out.y = herm(p.start.y, p.apexY, p.startVy * T * r, 0, t / r);
    else { const u = (t - r) / (1 - r); out.y = p.apexY + (p.end.y - p.apexY) * u * u; }
  }
  return out;
}

/** Vertical speed (m/s) at the end of the path (vault descent), for a continuous hand-off. */
export function mantleExitVy(p: MantlePlan): number {
  if (p.kind !== 'vault') return 0;
  return (2 * (p.end.y - p.apexY)) / ((1 - p.riseFrac) * p.duration);
}

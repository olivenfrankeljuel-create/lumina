import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Tuning } from './tuning';

export interface WorldQueries {
  /** Ray vs world + props. dir normalized. */
  ray(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { distance: number; point: THREE.Vector3; normal: THREE.Vector3; collider?: RAPIER.Collider } | null;
  /** Would a player capsule of `height` with its feet at `feet` overlap anything? */
  fits(feet: THREE.Vector3, height: number): boolean;
}

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
  /** Upward speed at the start (m/s), continued into the rise. */
  startVy: number;
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
export function planMantle(q: WorldQueries, feet: THREE.Vector3, fwd: THREE.Vector3, grounded: boolean, T: Tuning, speed = 0): MantlePlan | null {
  const R = T.radius;
  const maxH = grounded ? T.mantleMaxHeightGround : T.mantleMaxHeightAir;
  // reach further when running at it so a run + jump vaults a wall a stride away
  const reach = R + T.mantleReach + Math.min(Math.max(speed, 0), 7) * T.mantleReachPerSpeed;

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

  // 3) room to rise at the current column (tucked / crouch height)
  _o.set(feet.x, ledgeY + 0.04, feet.z);
  if (!q.fits(_o, T.heightCrouch)) return fail('no room to rise');

  const dir = fwd.clone();
  // 4) vault over thin, waist-high walls
  if (height <= T.vaultMaxHeight) {
    _o.set(face.x + fwd.x * (T.vaultMaxThickness + 0.05), ledgeY + 0.3, face.z + fwd.z * (T.vaultMaxThickness + 0.05));
    const deep = q.ray(_o, DOWN, 0.55);
    const thick = !!deep && Math.abs(deep.point.y - ledgeY) < 0.25;
    if (!thick) {
      // back face of the wall
      const probe = T.vaultMaxThickness + 0.3;
      _o.set(face.x + fwd.x * probe, ledgeY - 0.08, face.z + fwd.z * probe);
      _d.copy(fwd).negate();
      const back = q.ray(_o, _d, probe);
      const thickness = back ? Math.max(0.02, probe - back.distance) : T.vaultMaxThickness;
      const land = new THREE.Vector3(face.x + fwd.x * (thickness + R + 0.3), 0, face.z + fwd.z * (thickness + R + 0.3));
      _o.set(land.x, ledgeY + 0.2, land.z);
      const g = q.ray(_o, DOWN, height + 3.5);
      land.y = g ? g.point.y + T.skin : feet.y;
      // apex room over the wall and room to stand at the landing
      const apex = new THREE.Vector3(face.x + fwd.x * thickness * 0.5, ledgeY + 0.06, face.z + fwd.z * thickness * 0.5);
      if (q.fits(apex, T.heightCrouch) && q.fits(land, T.heightStand)) {
        return {
          kind: 'vault', start: feet.clone(), end: land, ledgeY, height,
          duration: 0.48 + 0.12 * height, endCrouched: false, dir, startVy: 0,
        };
      }
    }
  }

  // 5) mantle up onto the top
  const end = new THREE.Vector3(face.x + fwd.x * (R + 0.14), ledgeY + T.skin, face.z + fwd.z * (R + 0.14));
  let endCrouched = false;
  if (!q.fits(end, T.heightStand)) {
    if (!q.fits(end, T.heightCrouch)) return fail('no room on top');
    endCrouched = true;
  }
  return {
    kind: 'mantle', start: feet.clone(), end, ledgeY, height,
    duration: 0.3 + 0.2 * height, endCrouched, dir, startVy: 0,
  };
}

function fail(reason: string): null {
  mantleDebug.reason = reason;
  return null;
}

function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x; }
/** Cubic Hermite from a (with slope m0, in units per unit t) to b (zero end slope). */
function hermite(a: number, b: number, m0: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  // cap the initial slope so the curve never overshoots the target
  const m = Math.min(Math.max(m0, 0), 2.5 * Math.max(0, b - a));
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * b;
}
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeInQuad = (t: number) => t * t;

/** Feet position along the mantle/vault path at normalized time t. */
export function evalMantle(p: MantlePlan, t: number, out: THREE.Vector3): THREE.Vector3 {
  t = clamp01(t);
  if (p.kind === 'mantle') {
    const tUp = 0.62;
    const topY = p.ledgeY + 0.04;
    const xzK = easeInOutSine(clamp01((t - 0.28) / 0.72));
    out.x = p.start.x + (p.end.x - p.start.x) * xzK;
    out.z = p.start.z + (p.end.z - p.start.z) * xzK;
    // Hermite rise: starts with the player's current upward speed, eases into the ledge height
    out.y = hermite(p.start.y, topY, p.startVy * p.duration * tUp, clamp01(t / tUp)) + (p.end.y - topY) * xzK;
  } else {
    const tUp = 0.4;
    const apex = p.ledgeY + 0.08;
    out.y = t < tUp
      ? hermite(p.start.y, apex, p.startVy * p.duration * tUp, t / tUp)
      : apex + (p.end.y - apex) * easeInQuad((t - tUp) / (1 - tUp));
    const xzK = easeInOutSine(clamp01(t * 0.92 + 0.08 * t * t));
    out.x = p.start.x + (p.end.x - p.start.x) * xzK;
    out.z = p.start.z + (p.end.z - p.start.z) * xzK;
  }
  return out;
}

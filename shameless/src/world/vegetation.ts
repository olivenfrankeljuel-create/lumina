import * as THREE from 'three';
import { mk } from './builder';
import type { WCtx } from './context';
import { RNG } from './rng';
import { paint } from './geo';
import { D } from './textures';

const FROND: [number, number, number, number] = [0.02, 0.0, 0.48, 1.0];
const SHRUB: [number, number, number, number] = [0.52, 0.0, 0.98, 1.0];

/** Date palm: segmented, slightly leaning trunk, crown of arching alpha-card fronds + dead skirt. */
export function palm(w: WCtx, x: number, y: number, z: number, rng: RNG, height = 7) {
  const lean = new THREE.Vector3(rng.jit(1), 0, rng.jit(1)).normalize().multiplyScalar(rng.range(0.3, 1.1));
  const segs = Math.round(height / 0.28);
  const trunkKey = mk('wood_pallet', 2);
  let top = new THREE.Vector3(x, y, z);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const p0 = new THREE.Vector3(x + lean.x * t0 * t0, y + height * t0, z + lean.z * t0 * t0);
    const p1 = new THREE.Vector3(x + lean.x * t1 * t1, y + height * t1, z + lean.z * t1 * t1);
    const r0 = 0.2 - t0 * 0.05, r1 = 0.2 - t1 * 0.05;
    // each segment flares at its top: the characteristic leaf-base scales
    const g = new THREE.CylinderGeometry(r1 * 1.12, r0 * 0.92, p0.distanceTo(p1), 9, 1, true);
    g.translate(0, p0.distanceTo(p1) / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize()));
    g.rotateY(0);
    g.translate(p0.x, p0.y, p0.z);
    w.b.add(trunkKey, g);
    top = p1;
  }
  w.b.colBox(x + lean.x * 0.3, y + height / 2, z + lean.z * 0.3, 0.4, height, 0.4, 'wood');
  // crown
  const n = rng.int(20, 26);
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rng.jit(0.2);
    const up = i % 3 === 0 ? rng.range(0.7, 1.1) : rng.range(0.0, 0.7);
    frond(w, top, az, up, rng.range(2.6, 3.6), rng, false);
  }
  // dead skirt hanging down
  for (let i = 0; i < 9; i++) {
    const az = (i / 9) * Math.PI * 2 + rng.jit(0.3);
    frond(w, top.clone().add(new THREE.Vector3(0, -0.35, 0)), az, -1.25, rng.range(1.6, 2.3), rng, true);
  }
  // seed stalk clusters
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, 6.28);
    const g = new THREE.SphereGeometry(0.18, 6, 4);
    w.b.addT(mk('wood_pallet', 3), g, top.x + Math.cos(a) * 0.3, top.y - 0.4, top.z + Math.sin(a) * 0.3, 0, 0, 0, 1, 1.6, 1);
  }
}

function frond(w: WCtx, base: THREE.Vector3, az: number, up: number, len: number, rng: RNG, dead: boolean) {
  const segs = 6;
  const width = dead ? 0.6 : rng.range(1.2, 1.6);
  const g = new THREE.PlaneGeometry(width, len, 2, segs);
  g.translate(0, len / 2, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const weight = new Float32Array(pos.count);
  const droop = dead ? 0.1 : rng.range(0.6, 1.2);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / len;
    const xx = pos.getX(i);
    // arch: pitch starts at 'up' and bends down along length
    const ang = up - droop * t * t;
    const along = t * len;
    // integrate a simple arc: approximate position along curved path
    const r = along;
    const y = Math.sin(up) * r - droop * 0.35 * r * t;
    const h = Math.cos(up) * r;
    // V fold across the width
    const fold = Math.abs(xx) * 0.35;
    pos.setXYZ(i, xx * (1 - t * 0.5), y + fold, h);
    weight[i] = t * t;
    uv.setXY(i, (dead ? SHRUB : FROND)[0] + uv.getX(i) * ((dead ? SHRUB : FROND)[2] - (dead ? SHRUB : FROND)[0]), uv.getY(i));
    void ang;
  }
  g.computeVertexNormals();
  const c = dead ? new THREE.Color(0.55, 0.43, 0.28) : new THREE.Color().setHSL(0.16 + rng.jit(0.03), 0.3 + rng.jit(0.1), 0.42 + rng.jit(0.08));
  paint(g, c);
  g.rotateY(az);
  g.translate(base.x, base.y, base.z);
  w.addFlutter('custom:foliage', g, weight, new THREE.Vector3(1, 0.3, 0.4), dead ? 0.03 : 0.07);
}

/** Dry shrub: crossed vertical alpha cards. */
export function shrub(w: WCtx, x: number, y: number, z: number, rng: RNG, size = 1) {
  const cards = 3;
  const h = size * rng.range(0.6, 1.1), wd = size * rng.range(0.9, 1.4);
  for (let i = 0; i < cards; i++) {
    const g = new THREE.PlaneGeometry(wd, h, 1, 1);
    g.translate(0, h / 2, 0);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, SHRUB[0] + uv.getX(k) * (SHRUB[2] - SHRUB[0]), uv.getY(k));
    paint(g, new THREE.Color().setHSL(0.12 + rng.jit(0.03), 0.25, 0.5 + rng.jit(0.08)));
    g.rotateY((i / cards) * Math.PI + rng.jit(0.2));
    g.translate(x, y - 0.02, z);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const weight = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) weight[k] = pos.getY(k) > y + 0.1 ? 1 : 0;
    w.addFlutter('custom:foliage', g, weight, new THREE.Vector3(1, 0, 0.3), 0.04);
  }
  w.decal(D.DIRT, new THREE.Vector3(x, y + 0.01, z), new THREE.Vector3(0, 1, 0), wd * 1.6, wd * 1.6, rng.range(0, 6));
}

/** Planter (concrete box with soil) holding a palm or shrub. */
export function planter(w: WCtx, x: number, y: number, z: number, rng: RNG, withPalm: boolean) {
  const s = withPalm ? 1.4 : 1.0;
  w.b.box(mk('concrete', rng.int(0, 3)), x, y + 0.25, z, s, 0.5, s, { col: true });
  w.b.box(mk('dirt', 1), x, y + 0.46, z, s - 0.16, 0.06, s - 0.16);
  if (withPalm) palm(w, x, y + 0.45, z, rng, rng.range(6, 8.5));
  else shrub(w, x, y + 0.48, z, rng, 0.8);
  w.addCover(x, y, z + s / 2 + 0.55, 0, 1);
  w.addCover(x, y, z - s / 2 - 0.55, 0, -1);
}

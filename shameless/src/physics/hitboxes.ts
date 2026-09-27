import * as THREE from 'three';

export type HitRegion = 'head' | 'torso' | 'limb';

export interface HitboxShapeOptions {
  /** Offset of the shape centre in the object's local (bone) frame, meters. */
  offset?: THREE.Vector3;
  /** Extra local rotation of the shape relative to the object. */
  rotation?: THREE.Quaternion;
}

/**
 * Oriented hitbox following an Object3D (usually a bone). Dimensions are in world meters; the object's
 * world rotation orients the shape and its world scale is ignored (so bones under a scaled rig still work).
 */
export interface Hitbox {
  object: THREE.Object3D;
  enemyId: number;
  region: HitRegion;
  kind: 'box' | 'capsule';
  half: THREE.Vector3; // box half extents (local axes)
  radius: number; // capsule radius
  halfHeight: number; // capsule segment half length (along local Y)
  offset: THREE.Vector3;
  rotation: THREE.Quaternion | null;
  // cached world transform
  center: THREE.Vector3;
  quat: THREE.Quaternion;
  invQuat: THREE.Quaternion;
  axis: THREE.Vector3; // world capsule axis
  boundR: number;
  stamp: number;
}

export interface HitboxHit {
  t: number;
  normal: THREE.Vector3;
  hb: Hitbox;
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export function makeHitbox(object: THREE.Object3D, enemyId: number, region: HitRegion, kind: 'box' | 'capsule', half: THREE.Vector3, radius: number, halfHeight: number, opts?: HitboxShapeOptions): Hitbox {
  const hb: Hitbox = {
    object, enemyId, region, kind, half: half.clone(), radius, halfHeight,
    offset: opts?.offset?.clone() ?? new THREE.Vector3(),
    rotation: opts?.rotation?.clone() ?? null,
    center: new THREE.Vector3(), quat: new THREE.Quaternion(), invQuat: new THREE.Quaternion(), axis: new THREE.Vector3(0, 1, 0),
    boundR: kind === 'box' ? half.length() : radius + halfHeight,
    stamp: -1,
  };
  return hb;
}

/**
 * Convert a contract box (half extents) into the best-fitting primitive: an elongated box with a
 * roughly round cross-section becomes a capsule along its long axis (limbs), everything else stays a box.
 */
export function fitHitbox(object: THREE.Object3D, enemyId: number, region: HitRegion, half: THREE.Vector3): Hitbox {
  const e = [half.x, half.y, half.z];
  let long = 0;
  for (let i = 1; i < 3; i++) if (e[i] > e[long]) long = i;
  const o1 = e[(long + 1) % 3], o2 = e[(long + 2) % 3];
  const cross = Math.max(o1, o2), crossMin = Math.min(o1, o2);
  if (e[long] >= 1.5 * cross && crossMin >= 0.7 * cross) {
    const radius = cross;
    const halfHeight = Math.max(0, e[long] - radius);
    let rotation: THREE.Quaternion | undefined;
    if (long === 0) rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
    else if (long === 2) rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    return makeHitbox(object, enemyId, region, 'capsule', half, radius, halfHeight, { rotation });
  }
  return makeHitbox(object, enemyId, region, 'box', half, 0, 0);
}

/** Refresh the cached world transform from object.matrixWorld (does not recompute the matrix). */
export function updateHitbox(hb: Hitbox, stamp: number): void {
  if (hb.stamp === stamp) return;
  hb.stamp = stamp;
  hb.object.matrixWorld.decompose(_p, _q, _s);
  hb.quat.copy(_q);
  if (hb.rotation) hb.quat.multiply(hb.rotation);
  hb.center.copy(hb.offset).applyQuaternion(_q).add(_p);
  hb.invQuat.copy(hb.quat).invert();
  hb.axis.copy(Y).applyQuaternion(hb.quat);
}

/** Ray vs oriented box. dir must be normalized. Returns distance or -1. */
function rayOBB(origin: THREE.Vector3, dir: THREE.Vector3, hb: Hitbox, maxDist: number, outNormal: THREE.Vector3): number {
  _o.copy(origin).sub(hb.center).applyQuaternion(hb.invQuat);
  _d.copy(dir).applyQuaternion(hb.invQuat);
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 1;
  const o = [_o.x, _o.y, _o.z], d = [_d.x, _d.y, _d.z], h = [hb.half.x, hb.half.y, hb.half.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < -h[i] || o[i] > h[i]) return -1;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (-h[i] - o[i]) * inv, t2 = (h[i] - o[i]) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  const t = Math.max(0, tmin);
  if (t > maxDist) return -1;
  outNormal.set(0, 0, 0);
  if (axis >= 0 && tmin >= 0) {
    outNormal.setComponent(axis, sign);
    outNormal.applyQuaternion(hb.quat);
  } else outNormal.copy(dir).negate();
  return t;
}

/** Ray vs capsule (segment centre ± axis*halfHeight, radius). */
function rayCapsule(origin: THREE.Vector3, dir: THREE.Vector3, hb: Hitbox, maxDist: number, outNormal: THREE.Vector3): number {
  const r = hb.radius;
  _a.copy(hb.axis).multiplyScalar(-hb.halfHeight).add(hb.center);
  _b.copy(hb.axis).multiplyScalar(hb.halfHeight).add(hb.center);
  const t = rayCapsuleRaw(origin, dir, _a, _b, r);
  if (t < 0 || t > maxDist) return -1;
  // normal: from closest point on segment to hit point
  _tmp.copy(origin).addScaledVector(dir, t);
  closestOnSegment(_tmp, _a, _b, _oa);
  outNormal.copy(_tmp).sub(_oa);
  if (outNormal.lengthSq() < 1e-12) outNormal.copy(dir).negate(); else outNormal.normalize();
  return t;
}

/** Returns ray distance to capsule [a,b] radius r (0 if origin inside), or -1. */
export function rayCapsuleRaw(ro: THREE.Vector3, rd: THREE.Vector3, pa: THREE.Vector3, pb: THREE.Vector3, r: number): number {
  _ba.copy(pb).sub(pa);
  _oa.copy(ro).sub(pa);
  const baba = _ba.dot(_ba);
  // inside test
  closestOnSegment(ro, pa, pb, _tmp);
  if (_tmp.distanceToSquared(ro) <= r * r) return 0;
  if (baba < 1e-10) return raySphere(ro, rd, pa, r);
  const bard = _ba.dot(rd), baoa = _ba.dot(_oa), rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const a = baba - bard * bard;
  let b = baba * rdoa - baoa * bard;
  let c = baba * oaoa - baoa * baoa - r * r * baba;
  let h = b * b - a * c;
  if (a > 1e-10 && h >= 0) {
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;
    // caps
    const cap = y <= 0 ? pa : pb;
    return raySphere(ro, rd, cap, r);
  }
  // parallel to axis or missed cylinder: test caps
  const t1 = raySphere(ro, rd, pa, r), t2 = raySphere(ro, rd, pb, r);
  if (t1 < 0) return t2;
  if (t2 < 0) return t1;
  return Math.min(t1, t2);
}

export function raySphere(ro: THREE.Vector3, rd: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ocx = ro.x - c.x, ocy = ro.y - c.y, ocz = ro.z - c.z;
  const b = ocx * rd.x + ocy * rd.y + ocz * rd.z;
  const cc = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
  if (cc <= 0) return 0;
  const h = b * b - cc;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : -1;
}

export function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

/** Does the ray pass within `r` of `c` before maxDist? (cheap bounding-sphere reject) */
export function rayNearSphere(ro: THREE.Vector3, rd: THREE.Vector3, c: THREE.Vector3, r: number, maxDist: number): boolean {
  const ocx = c.x - ro.x, ocy = c.y - ro.y, ocz = c.z - ro.z;
  const tc = ocx * rd.x + ocy * rd.y + ocz * rd.z;
  const d2 = ocx * ocx + ocy * ocy + ocz * ocz;
  if (tc < -r && d2 > r * r) return false;
  if (tc - r > maxDist) return false;
  return d2 - tc * tc <= r * r;
}

export function rayHitbox(origin: THREE.Vector3, dir: THREE.Vector3, hb: Hitbox, maxDist: number, outNormal: THREE.Vector3): number {
  if (!rayNearSphere(origin, dir, hb.center, hb.boundR, maxDist)) return -1;
  return hb.kind === 'box' ? rayOBB(origin, dir, hb, maxDist, outNormal) : rayCapsule(origin, dir, hb, maxDist, outNormal);
}

/**
 * Per-enemy hitbox group with a cached bounding sphere so a ray rejects whole enemies with one test.
 */
export class HitboxSet {
  readonly byEnemy = new Map<number, { boxes: Hitbox[]; center: THREE.Vector3; radius: number; stamp: number }>();
  stamp = 0;

  add(hb: Hitbox): void {
    hb.object.updateWorldMatrix(true, false);
    let g = this.byEnemy.get(hb.enemyId);
    if (!g) this.byEnemy.set(hb.enemyId, (g = { boxes: [], center: new THREE.Vector3(), radius: 0, stamp: -1 }));
    g.boxes.push(hb);
    g.stamp = -1;
    hb.stamp = -1;
  }

  remove(enemyId: number): void {
    this.byEnemy.delete(enemyId);
  }

  invalidate(): void {
    this.stamp++;
  }

  private refresh(g: { boxes: Hitbox[]; center: THREE.Vector3; radius: number; stamp: number }): void {
    if (g.stamp === this.stamp) return;
    g.stamp = this.stamp;
    const c = g.center.set(0, 0, 0);
    for (const hb of g.boxes) { updateHitbox(hb, this.stamp); c.add(hb.center); }
    c.multiplyScalar(1 / Math.max(1, g.boxes.length));
    let r = 0;
    for (const hb of g.boxes) r = Math.max(r, hb.center.distanceTo(c) + hb.boundR);
    g.radius = r;
  }

  /** Nearest hitbox per enemy along the ray (sorted by distance). */
  intersectAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitboxHit[]): HitboxHit[] {
    const n = new THREE.Vector3();
    for (const g of this.byEnemy.values()) {
      this.refresh(g);
      if (!rayNearSphere(origin, dir, g.center, g.radius, maxDist)) continue;
      let best: HitboxHit | null = null;
      for (const hb of g.boxes) {
        const t = rayHitbox(origin, dir, hb, best ? best.t : maxDist, n);
        if (t >= 0 && (!best || t < best.t)) best = { t, normal: n.clone(), hb };
      }
      if (best) out.push(best);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  intersectNearest(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): HitboxHit | null {
    const n = new THREE.Vector3();
    let best: HitboxHit | null = null;
    let limit = maxDist;
    for (const g of this.byEnemy.values()) {
      this.refresh(g);
      if (!rayNearSphere(origin, dir, g.center, g.radius, limit)) continue;
      for (const hb of g.boxes) {
        const t = rayHitbox(origin, dir, hb, limit, n);
        if (t >= 0 && t <= limit) {
          if (!best) best = { t, normal: n.clone(), hb };
          else { best.t = t; best.normal.copy(n); best.hb = hb; }
          limit = t;
        }
      }
    }
    return best;
  }

  /** Debug: all hitboxes with fresh transforms. */
  all(): Hitbox[] {
    const r: Hitbox[] = [];
    for (const g of this.byEnemy.values()) { this.refresh(g); r.push(...g.boxes); }
    return r;
  }
}


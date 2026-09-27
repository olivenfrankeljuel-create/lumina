import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION, ADDITION } from 'three-bvh-csg';

/**
 * Geometry toolkit for hard-surface weapon modeling in code.
 * Conventions (weapon space): X = right, Y = up, -Z = toward the muzzle. Units: meters.
 * 2D profiles:
 *   side  profile (u = forward, v = up), extruded across X, centered on x=0
 *   top   profile (u = right,  v = forward), extruded upward along +Y
 *   front profile (u = right,  v = up), extruded along -Z (from z=0 to z=-length)
 */

export type P2 = [number, number];

/** Polygon with per-corner fillets (quadratic). radius 0 = sharp. */
export function filletPath<T extends THREE.Path>(target: T, pts: P2[], radii: number | number[] = 0): T {
  const n = pts.length;
  const rad = (i: number) => (Array.isArray(radii) ? radii[i] ?? 0 : radii);
  const A: THREE.Vector2[] = [], B: THREE.Vector2[] = [], P: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector2(...pts[i]);
    const prev = new THREE.Vector2(...pts[(i - 1 + n) % n]);
    const next = new THREE.Vector2(...pts[(i + 1) % n]);
    const d1 = prev.clone().sub(p), d2 = next.clone().sub(p);
    const l1 = d1.length(), l2 = d2.length();
    d1.normalize(); d2.normalize();
    const r = rad(i);
    let t = 0;
    if (r > 0) {
      const ang = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
      t = Math.min(r / Math.tan(ang / 2), l1 * 0.49, l2 * 0.49);
      if (!isFinite(t)) t = 0;
    }
    P.push(p);
    A.push(p.clone().addScaledVector(d1, t));
    B.push(p.clone().addScaledVector(d2, t));
  }
  target.moveTo(B[0].x, B[0].y);
  for (let k = 1; k <= n; k++) {
    const i = k % n;
    target.lineTo(A[i].x, A[i].y);
    if (A[i].distanceTo(B[i]) > 1e-7) target.quadraticCurveTo(P[i].x, P[i].y, B[i].x, B[i].y);
  }
  return target;
}
export const shape = (pts: P2[], radii: number | number[] = 0) => filletPath(new THREE.Shape(), pts, radii);
export const path = (pts: P2[], radii: number | number[] = 0) => filletPath(new THREE.Path(), pts, radii);

export function rrect(cx: number, cy: number, w: number, h: number, r: number): P2[] {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  void r;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
export const rrectShape = (cx: number, cy: number, w: number, h: number, r: number) => shape(rrect(cx, cy, w, h, r), r);
export const rrectPath = (cx: number, cy: number, w: number, h: number, r: number) => path(rrect(cx, cy, w, h, r), r);
export function circlePath(cx: number, cy: number, r: number, cw = false): THREE.Path {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, Math.PI * 2, cw);
  return p;
}
export function circleShape(cx: number, cy: number, r: number): THREE.Shape {
  const p = new THREE.Shape();
  p.absarc(cx, cy, r, 0, Math.PI * 2, false);
  return p;
}

export interface ExtOpts { bevel?: number; bevelSegs?: number; curveSegs?: number; bevelT?: number }

function extrude(sh: THREE.Shape | THREE.Shape[], depth: number, o: ExtOpts = {}): THREE.BufferGeometry {
  const bevel = o.bevel ?? 0;
  const bt = o.bevelT ?? bevel;
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(1e-5, depth - 2 * bt),
    bevelEnabled: bevel > 0,
    bevelThickness: bt,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: o.bevelSegs ?? 3,
    curveSegments: o.curveSegs ?? 8,
    steps: 1,
  });
  g.translate(0, 0, -(depth - 2 * bt) / 2);
  return g;
}

/** Side profile (u forward, v up) extruded across X with total width `width`, centered at x = xc. */
export function extrudeSide(sh: THREE.Shape | THREE.Shape[], width: number, o: ExtOpts = {}, xc = 0): THREE.BufferGeometry {
  const g = extrude(sh, width, o);
  g.rotateY(Math.PI / 2); // local x(u) -> -z, local z -> x
  g.translate(xc, 0, 0);
  return g;
}
/** Top/plan profile (u right, v forward) extruded upward from y0 to y0+height. */
export function extrudeTop(sh: THREE.Shape | THREE.Shape[], height: number, o: ExtOpts = {}, y0 = 0): THREE.BufferGeometry {
  const g = extrude(sh, height, o);
  g.translate(0, 0, height / 2);
  g.rotateX(-Math.PI / 2); // local y(v) -> -z, local z -> +y
  g.translate(0, y0, 0);
  return g;
}
/** Front cross-section (u right, v up) extruded along -Z from z0 to z0-length. */
export function extrudeFront(sh: THREE.Shape | THREE.Shape[], length: number, o: ExtOpts = {}, z0 = 0): THREE.BufferGeometry {
  const g = extrude(sh, length, o);
  g.translate(0, 0, z0 - length / 2);
  return g;
}

/** Lathe around the Z axis: points are [radius, distance forward]; starts at z = z0 and goes toward -Z. */
export function latheZ(pts: P2[], segs = 32, z0 = 0, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(pts.map(([r, d]) => new THREE.Vector2(Math.max(r, 0), d)), segs, phiStart, phiLength);
  g.rotateX(-Math.PI / 2); // y(d) -> -z
  g.translate(0, 0, z0);
  return g;
}
/** Lathe around an arbitrary axis given by from->to direction; pts [radius, distance along axis]. */
export function latheAxis(pts: P2[], origin: THREE.Vector3, dir: THREE.Vector3, segs = 24): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(pts.map(([r, d]) => new THREE.Vector2(Math.max(r, 0), d)), segs);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate(origin.x, origin.y, origin.z);
  return g;
}

/** Cylinder between two points. */
export function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, segs = 16, open = false): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), segs, 1, open);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Rounded box (all edges rounded with radius r), centered. */
export function roundBox(w: number, h: number, d: number, r: number, segs = 3): THREE.BufferGeometry {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = extrudeFront(rrectShape(0, 0, w, h, r), d, { bevel: r, bevelSegs: segs, curveSegs: segs * 2 }, d / 2);
  return g;
}
/** Chamfered box (flat chamfer c). */
export function chamferBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const pts: P2[] = [[-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c], [w / 2, h / 2 - c], [w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c], [-w / 2, -h / 2 + c]];
  return extrudeFront(shape(pts), d, { bevel: c, bevelSegs: 1, curveSegs: 1 }, d / 2);
}

/** Plain (sharp) box, centered at (x,y,z). */
export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

// ------------------------------------------------------------------------------------------------
// Normalization / CSG / merge
// ------------------------------------------------------------------------------------------------

/** Non-indexed, attributes exactly position/normal/uv, no groups. */
export function norm(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let r = g.index ? g.toNonIndexed() : g;
  if (!r.attributes.normal) r.computeVertexNormals();
  if (!r.attributes.uv) r.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(r.attributes.position.count * 2), 2));
  for (const k of Object.keys(r.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') r.deleteAttribute(k);
  r.clearGroups();
  r.morphAttributes = {};
  return r;
}

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal', 'uv'];
evaluator.useGroups = false;

/** a minus each of bs (CSG). Inputs must be closed meshes. */
export function csgSub(a: THREE.BufferGeometry, ...bs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!bs.length) return a;
  let acc = new Brush(norm(a));
  acc.updateMatrixWorld();
  // Merge cutters into one brush (cutters may overlap each other; union them first).
  const cut = new Brush(merge(bs.map(norm)));
  cut.updateMatrixWorld();
  const res = evaluator.evaluate(acc, cut, SUBTRACTION);
  return norm(res.geometry);
}
export function csgUnion(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const A = new Brush(norm(a)), B = new Brush(norm(b));
  A.updateMatrixWorld(); B.updateMatrixWorld();
  return norm(evaluator.evaluate(A, B, ADDITION).geometry);
}

export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(list.map(norm), false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

/** Smooth normals across edges below `angle` (radians), crisp above. */
export function crease(g: THREE.BufferGeometry, angle = 40 * Math.PI / 180): THREE.BufferGeometry {
  return toCreasedNormals(norm(g), angle);
}

/** Box-projected UVs in meters * scale (consistent texel density across parts). */
export function boxUV(g: THREE.BufferGeometry, scale = 1, offset = new THREE.Vector3()): THREE.BufferGeometry {
  const pos = g.attributes.position, nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).add(offset);
    n.fromBufferAttribute(nor, i);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u: number, v: number;
    if (ax >= ay && ax >= az) { u = p.z * Math.sign(n.x || 1); v = p.y; }
    else if (ay >= az) { u = p.x; v = p.z * Math.sign(n.y || 1); }
    else { u = -p.x * Math.sign(n.z || 1); v = p.y; }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Final prep for a static part: creased normals + meter-space box UVs. */
export function finish(g: THREE.BufferGeometry, creaseDeg = 40, uvScale = 1): THREE.BufferGeometry {
  const c = crease(g, creaseDeg * Math.PI / 180);
  boxUV(c, uvScale);
  c.computeBoundingBox();
  c.computeBoundingSphere();
  return c;
}

/** Applies fn to every vertex position (and recomputes nothing — call finish after). */
export function warp(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    fn(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  return g;
}

/** Matrix helper: rotate (euler XYZ, radians) then translate. */
export function xform(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Superellipsoid-ish rounded blob: sphere mapped through |c|^e, scaled. Good for palms/pads. */
export function blob(rx: number, ry: number, rz: number, e = 0.6, ws = 24, hs = 16): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const f = (c: number) => Math.sign(c) * Math.pow(Math.abs(c), e);
    pos.setXYZ(i, f(x) * rx, f(y) * ry, f(z) * rz);
  }
  g.computeVertexNormals();
  return g;
}

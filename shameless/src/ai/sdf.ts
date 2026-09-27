/**
 * Signed-distance-field modelling kit used to sculpt the soldier: smooth primitives, smooth boolean ops,
 * a narrow-band surface-nets mesher with vertex projection, analytic normals and SDF ambient occlusion.
 * Everything runs once at load time on the CPU; results are cached as BufferGeometries.
 */
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

export const simplifierReady = MeshoptSimplifier.ready;

export type Op = 'add' | 'sub' | 'int';
export type V3 = [number, number, number];

export interface Prim {
  kind: 0 | 1 | 2 | 3 | 4; // 0 ellipsoid, 1 round cone, 2 round box, 3 capped cylinder, 4 plane
  op: Op;
  k: number; // smoothing radius for the boolean op
  /** center (ell/box) or endpoint A (cone/cyl) or plane normal */
  ax: number; ay: number; az: number;
  /** endpoint B (cone/cyl) */
  bx: number; by: number; bz: number;
  /** radii / half extents */
  r0: number; r1: number; r2: number;
  round: number;
  /** world->local rotation (row-major 3x3), null for axis aligned */
  m: Float64Array | null;
  bb: Float64Array; // aabb min xyz, max xyz (inflated by k)
  /** optional per-primitive tag (e.g. region id) */
  tag: number;
}

const INF = 1e9;

function rotInv(q?: THREE.Quaternion | THREE.Euler | null): Float64Array | null {
  if (!q) return null;
  const qq = q instanceof THREE.Euler ? new THREE.Quaternion().setFromEuler(q) : q;
  const m = new THREE.Matrix4().makeRotationFromQuaternion(qq).transpose(); // inverse rotation
  const e = m.elements; // column-major
  return new Float64Array([e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
}

function mkBB(minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number, pad: number) {
  return new Float64Array([minx - pad, miny - pad, minz - pad, maxx + pad, maxy + pad, maxz + pad]);
}

function base(kind: Prim['kind'], op: Op, k: number): Prim {
  return { kind, op, k, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r0: 0, r1: 0, r2: 0, round: 0, m: null, bb: mkBB(-INF, -INF, -INF, INF, INF, INF, 0), tag: 0 };
}

export function ell(c: V3, r: V3, opt: { op?: Op; k?: number; rot?: THREE.Euler | THREE.Quaternion; tag?: number } = {}): Prim {
  const p = base(0, opt.op ?? 'add', opt.k ?? 0);
  [p.ax, p.ay, p.az] = c; [p.r0, p.r1, p.r2] = r; p.m = rotInv(opt.rot); p.tag = opt.tag ?? 0;
  const R = Math.max(...r);
  p.bb = p.m ? mkBB(c[0] - R, c[1] - R, c[2] - R, c[0] + R, c[1] + R, c[2] + R, p.k) : mkBB(c[0] - r[0], c[1] - r[1], c[2] - r[2], c[0] + r[0], c[1] + r[1], c[2] + r[2], p.k);
  return p;
}

export function cone(a: V3, b: V3, ra: number, rb: number, opt: { op?: Op; k?: number; tag?: number } = {}): Prim {
  const p = base(1, opt.op ?? 'add', opt.k ?? 0);
  [p.ax, p.ay, p.az] = a; [p.bx, p.by, p.bz] = b; p.r0 = ra; p.r1 = rb; p.tag = opt.tag ?? 0;
  const R = Math.max(ra, rb);
  p.bb = mkBB(Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.min(a[2], b[2]) - R, Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R, Math.max(a[2], b[2]) + R, p.k);
  return p;
}
export const cap = (a: V3, b: V3, r: number, opt: { op?: Op; k?: number; tag?: number } = {}) => cone(a, b, r, r, opt);

export function box(c: V3, half: V3, opt: { op?: Op; k?: number; rot?: THREE.Euler | THREE.Quaternion; round?: number; tag?: number } = {}): Prim {
  const p = base(2, opt.op ?? 'add', opt.k ?? 0);
  [p.ax, p.ay, p.az] = c; [p.r0, p.r1, p.r2] = half; p.round = Math.min(opt.round ?? 0.004, Math.min(...half) * 0.95); p.m = rotInv(opt.rot); p.tag = opt.tag ?? 0;
  const R = Math.hypot(...half);
  p.bb = p.m ? mkBB(c[0] - R, c[1] - R, c[2] - R, c[0] + R, c[1] + R, c[2] + R, p.k) : mkBB(c[0] - half[0], c[1] - half[1], c[2] - half[2], c[0] + half[0], c[1] + half[1], c[2] + half[2], p.k);
  return p;
}

export function cyl(a: V3, b: V3, r: number, opt: { op?: Op; k?: number; round?: number; tag?: number } = {}): Prim {
  const p = base(3, opt.op ?? 'add', opt.k ?? 0);
  [p.ax, p.ay, p.az] = a; [p.bx, p.by, p.bz] = b; p.r0 = r; p.round = opt.round ?? 0.002; p.tag = opt.tag ?? 0;
  p.bb = mkBB(Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r, p.k);
  return p;
}

/** Half-space: inside where dot(p, n) > d is FALSE, i.e. keeps dot(p,n) <= d when used with 'int'. */
export function plane(n: V3, d: number, opt: { op?: Op; k?: number } = {}): Prim {
  const p = base(4, opt.op ?? 'int', opt.k ?? 0);
  const l = Math.hypot(...n);
  p.ax = n[0] / l; p.ay = n[1] / l; p.az = n[2] / l; p.r0 = d;
  return p;
}

/** Mirror a primitive across x=0 (rotations mirrored too). */
export function mirrorX(p: Prim): Prim {
  const q: Prim = { ...p, bb: new Float64Array(p.bb), m: p.m ? new Float64Array(p.m) : null };
  if (p.kind === 4) { q.ax = -p.ax; return q; }
  q.ax = -p.ax; q.bx = -p.bx;
  q.bb[0] = -p.bb[3]; q.bb[3] = -p.bb[0];
  if (q.m) {
    // M' = S M S with S = diag(-1,1,1)
    const m = p.m!;
    q.m = new Float64Array([m[0], -m[1], -m[2], -m[3], m[4], m[5], -m[6], m[7], m[8]]);
  }
  return q;
}

// ---------------------------------------------------------------- evaluation

function primDist(p: Prim, x: number, y: number, z: number): number {
  switch (p.kind) {
    case 0: { // ellipsoid
      let px = x - p.ax, py = y - p.ay, pz = z - p.az;
      if (p.m) { const m = p.m; const tx = m[0] * px + m[1] * py + m[2] * pz, ty = m[3] * px + m[4] * py + m[5] * pz, tz = m[6] * px + m[7] * py + m[8] * pz; px = tx; py = ty; pz = tz; }
      const ax = px / p.r0, ay = py / p.r1, az = pz / p.r2;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const bx = ax / p.r0, by = ay / p.r1, bz = az / p.r2;
      const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
      if (k1 < 1e-9) return -Math.min(p.r0, p.r1, p.r2);
      return (k0 * (k0 - 1)) / k1;
    }
    case 1: { // round cone
      const bax = p.bx - p.ax, bay = p.by - p.ay, baz = p.bz - p.az;
      const l2 = bax * bax + bay * bay + baz * baz;
      const rr = p.r0 - p.r1;
      const a2 = l2 - rr * rr;
      const il2 = 1 / l2;
      const pax = x - p.ax, pay = y - p.ay, paz = z - p.az;
      const yy = pax * bax + pay * bay + paz * baz;
      const zz = yy - l2;
      const xvx = pax * l2 - bax * yy, xvy = pay * l2 - bay * yy, xvz = paz * l2 - baz * yy;
      const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
      const y2 = yy * yy * l2;
      const z2 = zz * zz * l2;
      const k = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.r1;
      if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.r0;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - p.r0;
    }
    case 2: { // rounded box
      let px = x - p.ax, py = y - p.ay, pz = z - p.az;
      if (p.m) { const m = p.m; const tx = m[0] * px + m[1] * py + m[2] * pz, ty = m[3] * px + m[4] * py + m[5] * pz, tz = m[6] * px + m[7] * py + m[8] * pz; px = tx; py = ty; pz = tz; }
      const r = p.round;
      const qx = Math.abs(px) - p.r0 + r, qy = Math.abs(py) - p.r1 + r, qz = Math.abs(pz) - p.r2 + r;
      const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
      return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
    }
    case 3: { // capped cylinder (rounded)
      const rd = p.round;
      const bax = p.bx - p.ax, bay = p.by - p.ay, baz = p.bz - p.az;
      const pax = x - p.ax, pay = y - p.ay, paz = z - p.az;
      const baba = bax * bax + bay * bay + baz * baz;
      const paba = pax * bax + pay * bay + paz * baz;
      const cx = pax * baba - bax * paba, cy = pay * baba - bay * paba, cz = paz * baba - baz * paba;
      const L = Math.sqrt(baba);
      const xx = Math.sqrt(cx * cx + cy * cy + cz * cz) - (p.r0 - rd) * baba;
      const yy = Math.abs(paba - baba * 0.5) - baba * 0.5 + rd * L;
      const x2 = xx * xx, y2 = yy * yy * baba;
      const d = Math.max(xx, yy) < 0 ? -Math.min(x2, y2) : (xx > 0 ? x2 : 0) + (yy > 0 ? y2 : 0);
      return (Math.sign(d) * Math.sqrt(Math.abs(d))) / baba - rd;
    }
    case 4:
      return x * p.ax + y * p.ay + z * p.az - p.r0;
  }
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number): number { return -smin(-a, -b, k); }

function bbDist(bb: Float64Array, x: number, y: number, z: number): number {
  const dx = Math.max(bb[0] - x, 0, x - bb[3]);
  const dy = Math.max(bb[1] - y, 0, y - bb[4]);
  const dz = Math.max(bb[2] - z, 0, z - bb[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface SdfGroup {
  prims: Prim[];
  /** Additive displacement (wrinkles, folds), evaluated only near the surface. */
  disp?: (x: number, y: number, z: number) => number;
  /** Max |disp| — used for bounds and narrow band. */
  dispAmp?: number;
}

export function evalGroup(g: SdfGroup, x: number, y: number, z: number): number {
  let d = INF;
  const prims = g.prims;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (p.op === 'add') {
      if (d < INF && bbDist(p.bb, x, y, z) >= d + p.k) continue;
      d = smin(d, primDist(p, x, y, z), p.k);
    } else if (p.op === 'sub') {
      if (p.kind !== 4 && bbDist(p.bb, x, y, z) >= -d + p.k) continue;
      d = smax(d, -primDist(p, x, y, z), p.k);
    } else {
      d = smax(d, primDist(p, x, y, z), p.k);
    }
  }
  if (g.disp && d < 0.05) d += g.disp(x, y, z);
  return d;
}

export function groupBounds(g: SdfGroup): THREE.Box3 {
  const b = new THREE.Box3();
  for (const p of g.prims) {
    if (p.op !== 'add') continue;
    b.expandByPoint(new THREE.Vector3(p.bb[0], p.bb[1], p.bb[2]));
    b.expandByPoint(new THREE.Vector3(p.bb[3], p.bb[4], p.bb[5]));
  }
  b.expandByScalar((g.dispAmp ?? 0) + 0.01);
  return b;
}

// ---------------------------------------------------------------- surface nets

export interface RawMesh { pos: Float32Array; nrm: Float32Array; idx: Uint32Array }

export function meshGroup(g: SdfGroup, h: number, bounds?: THREE.Box3): RawMesh {
  const bb = bounds ?? groupBounds(g);
  const f = (x: number, y: number, z: number) => evalGroup(g, x, y, z);
  const ox = bb.min.x, oy = bb.min.y, oz = bb.min.z;
  const nx = Math.ceil((bb.max.x - ox) / h) + 2, ny = Math.ceil((bb.max.y - oy) / h) + 2, nz = Math.ceil((bb.max.z - oz) / h) + 2;
  const N = nx * ny * nz;
  const val = new Float32Array(N);
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // Narrow band via 4^3 blocks.
  const B = 4;
  const halfDiag = (h * B * Math.sqrt(3)) / 2 + h * 1.5 + (g.dispAmp ?? 0);
  for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
    const ei = Math.min(bi + B, nx), ej = Math.min(bj + B, ny), ek = Math.min(bk + B, nz);
    const cx = ox + ((bi + ei - 1) / 2) * h, cy = oy + ((bj + ej - 1) / 2) * h, cz = oz + ((bk + ek - 1) / 2) * h;
    const dc = f(cx, cy, cz);
    if (Math.abs(dc) > halfDiag * 1.25) {
      for (let k = bk; k < ek; k++) for (let j = bj; j < ej; j++) for (let i = bi; i < ei; i++) val[id(i, j, k)] = dc;
    } else {
      for (let k = bk; k < ek; k++) for (let j = bj; j < ej; j++) for (let i = bi; i < ei; i++) val[id(i, j, k)] = f(ox + i * h, oy + j * h, oz + k * h);
    }
  }
  // Cell vertices.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const P: number[] = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const v = val[id(i + corner[c][0], j + corner[c][1], k + corner[c][2])]; cv[c] = v; if (v < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
      sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
      sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
      n++;
    }
    cellVert[cid(i, j, k)] = P.length / 3;
    P.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h);
  }
  // Project onto the surface + normals.
  const nv = P.length / 3;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  const e = h * 0.3;
  const grad = (x: number, y: number, z: number, out: number[]) => {
    // tetrahedral gradient
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
    let gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
    const l = Math.hypot(gx, gy, gz) || 1;
    out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
  };
  const gtmp = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const x0 = x, y0 = y, z0 = z;
    for (let it = 0; it < 2; it++) {
      const d = f(x, y, z);
      grad(x, y, z, gtmp);
      x -= gtmp[0] * d; y -= gtmp[1] * d; z -= gtmp[2] * d;
    }
    // keep inside the cell neighbourhood (avoid folding across thin features)
    const dx = x - x0, dy = y - y0, dz = z - z0, dl = Math.hypot(dx, dy, dz);
    if (dl > h * 0.9) { const s = (h * 0.9) / dl; x = x0 + dx * s; y = y0 + dy * s; z = z0 + dz * s; }
    grad(x, y, z, gtmp);
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    nrm[v * 3] = gtmp[0]; nrm[v * 3 + 1] = gtmp[1]; nrm[v * 3 + 2] = gtmp[2];
  }
  // Quads.
  const I: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    // split along the shorter diagonal
    const dAC = dist2(pos, a, c), dBD = dist2(pos, b, d);
    if (dAC <= dBD) I.push(a, b, c, a, c, d); else I.push(a, b, d, b, c, d);
  };
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = val[id(i, j, k)] < 0;
    if (j > 0 && k > 0 && v0 !== (val[id(i + 1, j, k)] < 0)) // x edge
      quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], !v0);
    if (i > 0 && k > 0 && v0 !== (val[id(i, j + 1, k)] < 0)) // y edge
      quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)], cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], !v0);
    if (i > 0 && j > 0 && v0 !== (val[id(i, j, k + 1)] < 0)) // z edge
      quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], !v0);
  }
  // Fix winding against the SDF normal (robust to the quad ordering conventions above).
  const idx = new Uint32Array(I);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const nx_ = nrm[a * 3] + nrm[b * 3] + nrm[c * 3], ny_ = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1], nz_ = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2];
    if (cx * nx_ + cy * ny_ + cz * nz_ < 0) { idx[t + 1] = c; idx[t + 2] = b; }
  }
  return { pos, nrm, idx };
}

function dist2(p: Float32Array, a: number, b: number) {
  const x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2];
  return x * x + y * y + z * z;
}

/** SDF ambient occlusion per vertex against an arbitrary distance function. */
export function computeAO(m: RawMesh, sdf: (x: number, y: number, z: number) => number, strength = 1): Float32Array {
  const n = m.pos.length / 3;
  const ao = new Float32Array(n);
  const steps = [0.008, 0.02, 0.04, 0.07, 0.11];
  for (let v = 0; v < n; v++) {
    const px = m.pos[v * 3], py = m.pos[v * 3 + 1], pz = m.pos[v * 3 + 2];
    const nx = m.nrm[v * 3], ny = m.nrm[v * 3 + 1], nz = m.nrm[v * 3 + 2];
    let occ = 0, w = 1;
    for (const s of steps) {
      const d = sdf(px + nx * s, py + ny * s, pz + nz * s);
      occ += (w * Math.max(0, s - d)) / s;
      w *= 0.62;
    }
    ao[v] = Math.max(0.18, Math.min(1, 1 - occ * 0.55 * strength));
  }
  return ao;
}

/**
 * Error-bounded decimation (meshoptimizer), normal-aware. Surface nets oversample flat areas heavily;
 * this typically removes 70-85% of the triangles with no visible change. Call after `await simplifierReady`.
 */
export function simplifyMesh(m: RawMesh, maxError: number, normalWeight = 0.35): RawMesh {
  if (!MeshoptSimplifier.supported) return m;
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(m.idx, m.pos, 3, m.nrm, 3, [normalWeight, normalWeight, normalWeight], null, 0, maxError, ['ErrorAbsolute']);
  const remap = new Int32Array(m.pos.length / 3).fill(-1);
  let n = 0;
  for (let i = 0; i < idx.length; i++) if (remap[idx[i]] < 0) remap[idx[i]] = n++;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    pos[r * 3] = m.pos[v * 3]; pos[r * 3 + 1] = m.pos[v * 3 + 1]; pos[r * 3 + 2] = m.pos[v * 3 + 2];
    nrm[r * 3] = m.nrm[v * 3]; nrm[r * 3 + 1] = m.nrm[v * 3 + 1]; nrm[r * 3 + 2] = m.nrm[v * 3 + 2];
  }
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = remap[idx[i]];
  return { pos, nrm, idx: out };
}

import * as THREE from 'three';
import type { GameContext, MaterialName } from '../core/types';
import type { Surface } from '../core/events';

/**
 * Material key: "<MaterialName>|<variant>" for library materials, "custom:<id>" for world-owned
 * canvas materials (decals, signs, foliage, cloth). Every static piece of geometry is pushed into a
 * batch per key and merged at the end, so draw calls ~= number of keys (x spatial chunks).
 */
export type MatKey = string;

export const WEAR = [0.12, 0.35, 0.6, 0.85];
/** Large-surface materials keep 4 tint/wear variants; everything else is folded to 2 (draw-call budget). */
const RICH = new Set<MaterialName>(['plaster_white', 'plaster_worn', 'brick_tan', 'brick_red', 'concrete', 'concrete_dirty']);
export function mk(name: MaterialName, variant = 0): MatKey {
  const v = RICH.has(name) ? variant % 4 : variant % 2 === 0 ? 0 : 3;
  return `${name}|${v}`;
}
export function parseKey(key: MatKey): { name: MaterialName; variant: number } {
  const [n, v] = key.split('|');
  return { name: n as MaterialName, variant: Number(v ?? 0) };
}

export interface BoxOpts {
  ry?: number;
  rx?: number;
  rz?: number;
  /** true = collide with the material's surface, or a Surface to override. Default false. */
  col?: boolean | Surface;
  uv?: 'world' | 'keep';
}

export interface ColBox {
  c: THREE.Vector3;
  s: THREE.Vector3;
  q: THREE.Quaternion;
  surface: Surface;
}

/** Raw geometry piece (world space) waiting to be merged. */
interface Piece { p: Float32Array; n: Float32Array; uv: Float32Array; c: Float32Array | null; i: Uint32Array; cx: number; cz: number }

const tmpM = new THREE.Matrix4();
const tmpN = new THREE.Matrix3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const BOX_P = UNIT_BOX.attributes.position.array as Float32Array;
const BOX_N = UNIT_BOX.attributes.normal.array as Float32Array;
const BOX_I = new Uint32Array(UNIT_BOX.index!.array as ArrayLike<number>);

function worldUVArr(p: Float32Array, n: Float32Array, out: Float32Array) {
  const cnt = p.length / 3;
  for (let i = 0; i < cnt; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let u: number, v: number;
    if (ay >= ax && ay >= az) { u = x; v = z; }
    else if (ax >= az) { u = nx > 0 ? -z : z; v = y; }
    else { u = nz > 0 ? x : -x; v = y; }
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
}

/** Project world-space UVs (meters) by dominant normal axis so textures stay consistent across merged boxes. */
export function worldUV(geo: THREE.BufferGeometry): void {
  const p = geo.attributes.position.array as Float32Array;
  const n = geo.attributes.normal.array as Float32Array;
  const uv = new Float32Array((p.length / 3) * 2);
  worldUVArr(p, n, uv);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class Builder {
  readonly batches = new Map<MatKey, Piece[]>();
  readonly customMats = new Map<string, THREE.Material>();
  readonly colBoxes: ColBox[] = [];
  readonly colGeos: { geo: THREE.BufferGeometry; surface: Surface }[] = [];
  /** Keys whose meshes must not cast shadows (decals, far horizon). */
  readonly noShadow = new Set<MatKey>();
  /** Keys that should not be chunked spatially. */
  readonly noChunk = new Set<MatKey>();
  tris = 0;

  constructor(readonly ctx: GameContext) {}

  surfaceOf(key: MatKey): Surface {
    if (key.startsWith('custom:')) return key === 'custom:cloth' ? 'fabric' : key === 'custom:foliage' ? 'wood' : 'concrete';
    return this.ctx.materials.surfaceOf(parseKey(key).name);
  }

  private push(key: MatKey, pc: Piece) {
    let list = this.batches.get(key);
    if (!list) this.batches.set(key, (list = []));
    list.push(pc);
    this.tris += pc.i.length / 3;
  }

  /** Push geometry (consumed — do not reuse after). Optional world matrix applied. */
  add(key: MatKey, geo: THREE.BufferGeometry, m?: THREE.Matrix4, uv: 'world' | 'keep' = 'world'): void {
    if (m) geo.applyMatrix4(m);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const p = new Float32Array(geo.attributes.position.array as ArrayLike<number>);
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { console.warn('[world] NaN geometry', key); geo.dispose(); return; }
    const n = new Float32Array(geo.attributes.normal.array as ArrayLike<number>);
    let u: Float32Array;
    if (uv === 'world' || !geo.attributes.uv) { u = new Float32Array((p.length / 3) * 2); worldUVArr(p, n, u); }
    else u = new Float32Array(geo.attributes.uv.array as ArrayLike<number>);
    const c = geo.attributes.color ? new Float32Array(geo.attributes.color.array as ArrayLike<number>) : null;
    let idx: Uint32Array;
    if (geo.index) idx = new Uint32Array(geo.index.array as ArrayLike<number>);
    else { idx = new Uint32Array(p.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i; }
    let cx = 0, cz = 0;
    const cnt = p.length / 3;
    for (let i = 0; i < cnt; i++) { cx += p[i * 3]; cz += p[i * 3 + 2]; }
    geo.dispose();
    this.push(key, { p, n, uv: u, c, i: idx, cx: cx / Math.max(1, cnt), cz: cz / Math.max(1, cnt) });
  }

  /** Add geometry transformed by position/rotation(Euler YXZ order)/scale. */
  addT(key: MatKey, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1, uv: 'world' | 'keep' = 'world'): void {
    tmpE.set(rx, ry, rz, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
    this.add(key, geo, tmpM, uv);
  }

  /** Oriented box, written directly into a piece (fast path — most of the world is boxes). */
  box(key: MatKey, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: BoxOpts = {}): void {
    if (!(sx > 0.0005 && sy > 0.0005 && sz > 0.0005)) return;
    const ry = o.ry ?? 0, rx = o.rx ?? 0, rz = o.rz ?? 0;
    tmpE.set(rx, ry, rz, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(tmpV.set(cx, cy, cz), tmpQ, tmpS.set(sx, sy, sz));
    const e = tmpM.elements;
    tmpN.setFromMatrix4(tmpM.makeRotationFromQuaternion(tmpQ));
    const r = tmpN.elements;
    tmpM.compose(tmpV.set(cx, cy, cz), tmpQ, tmpS.set(sx, sy, sz));
    const p = new Float32Array(72), n = new Float32Array(72);
    for (let i = 0; i < 24; i++) {
      const x = BOX_P[i * 3], y = BOX_P[i * 3 + 1], z = BOX_P[i * 3 + 2];
      p[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      p[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      p[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const a = BOX_N[i * 3], b = BOX_N[i * 3 + 1], c = BOX_N[i * 3 + 2];
      n[i * 3] = r[0] * a + r[3] * b + r[6] * c;
      n[i * 3 + 1] = r[1] * a + r[4] * b + r[7] * c;
      n[i * 3 + 2] = r[2] * a + r[5] * b + r[8] * c;
    }
    const uv = new Float32Array(48);
    worldUVArr(p, n, uv);
    this.push(key, { p, n, uv, c: null, i: BOX_I, cx, cz });
    if (o.col) this.colBox(cx, cy, cz, sx, sy, sz, typeof o.col === 'string' ? o.col : this.surfaceOf(key), ry, rx, rz);
  }

  /** Axis-aligned box from min/max corners. */
  boxMM(key: MatKey, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: boolean | Surface = false): void {
    this.box(key, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), { col });
  }

  colBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, surface: Surface, ry = 0, rx = 0, rz = 0): void {
    if (sx <= 0.001 || sy <= 0.001 || sz <= 0.001) return;
    tmpE.set(rx, ry, rz, 'YXZ');
    this.colBoxes.push({ c: new THREE.Vector3(cx, cy, cz), s: new THREE.Vector3(sx, sy, sz), q: new THREE.Quaternion().setFromEuler(tmpE), surface });
  }

  colGeo(geo: THREE.BufferGeometry, surface: Surface): void {
    this.colGeos.push({ geo, surface });
  }

  materialFor(key: MatKey): THREE.Material {
    if (key.startsWith('custom:')) return this.customMats.get(key)!;
    const { name, variant } = parseKey(key);
    return this.ctx.materials.get(name, { seed: variant * 7919 + 13, wear: WEAR[variant % 4] });
  }

  /** Merge all batches into meshes. Large batches are split into spatial chunks for frustum culling. */
  build(chunkSize = 64, chunkTriThreshold = 30000): THREE.Group {
    const group = new THREE.Group();
    group.name = 'world-static';
    for (const [key, pieces] of this.batches) {
      if (!pieces.length) continue;
      const mat = this.materialFor(key);
      let total = 0;
      for (const pc of pieces) total += pc.i.length / 3;
      const buckets = new Map<string, Piece[]>();
      if (total > chunkTriThreshold && !this.noChunk.has(key)) {
        for (const pc of pieces) {
          const id = `${Math.floor(pc.cx / chunkSize)},${Math.floor(pc.cz / chunkSize)}`;
          let b = buckets.get(id);
          if (!b) buckets.set(id, (b = []));
          b.push(pc);
        }
      } else buckets.set('all', pieces);
      for (const [cid, list] of buckets) {
        const geo = mergePieces(list);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `${key}@${cid}`;
        mesh.matrixAutoUpdate = false;
        mesh.userData.surface = this.surfaceOf(key);
        mesh.userData.matKey = key;
        if (this.noShadow.has(key)) mesh.userData.noShadow = true;
        group.add(mesh);
      }
    }
    this.batches.clear();
    return group;
  }

  /** Invisible collision proxies, one box mesh per collision box (physics may turn them into cuboids). */
  buildColliders(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'world-colliders';
    const geoCache = new Map<string, THREE.BoxGeometry>();
    for (const b of mergeColBoxes(this.colBoxes)) {
      const k = `${b.s.x.toFixed(3)},${b.s.y.toFixed(3)},${b.s.z.toFixed(3)}`;
      let geo = geoCache.get(k);
      if (!geo) geoCache.set(k, (geo = new THREE.BoxGeometry(b.s.x, b.s.y, b.s.z)));
      const m = new THREE.Mesh(geo);
      m.position.copy(b.c);
      m.quaternion.copy(b.q);
      m.userData.surface = b.surface;
      m.userData.collider = 'box';
      m.visible = false;
      group.add(m);
    }
    for (const g of this.colGeos) {
      const m = new THREE.Mesh(g.geo);
      m.userData.surface = g.surface;
      m.visible = false;
      group.add(m);
    }
    group.updateMatrixWorld(true);
    return group;
  }
}

function mergePieces(list: Piece[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  const hasColor = list.some((p) => p.c);
  for (const pc of list) { nv += pc.p.length / 3; ni += pc.i.length; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
  const C = hasColor ? new Float32Array(nv * 3).fill(1) : null;
  const I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const pc of list) {
    P.set(pc.p, vo * 3);
    N.set(pc.n, vo * 3);
    U.set(pc.uv, vo * 2);
    if (C && pc.c) C.set(pc.c, vo * 3);
    const idx = pc.i;
    for (let k = 0; k < idx.length; k++) I[io + k] = idx[k] + vo;
    vo += pc.p.length / 3;
    io += idx.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Greedy merge of axis-aligned collision boxes (identity or quarter-turn yaw) that share an exact
 * cross-section and touch/overlap along one axis. Cuts the collider count several-fold (wall piers,
 * floor slabs and stacked bands collapse into long cuboids). Rotated boxes pass through unchanged.
 */
function mergeColBoxes(boxes: ColBox[]): ColBox[] {
  type A = { min: number[]; max: number[]; surface: Surface };
  const aabbs: A[] = [];
  const out: ColBox[] = [];
  const e = new THREE.Euler();
  for (const b of boxes) {
    e.setFromQuaternion(b.q, 'YXZ');
    const qy = e.y / (Math.PI / 2);
    const aligned = Math.abs(e.x) < 1e-4 && Math.abs(e.z) < 1e-4 && Math.abs(qy - Math.round(qy)) < 1e-4;
    if (!aligned) { out.push(b); continue; }
    const swap = Math.abs(Math.round(qy)) % 2 === 1;
    const sx = swap ? b.s.z : b.s.x, sz = swap ? b.s.x : b.s.z;
    aabbs.push({ min: [b.c.x - sx / 2, b.c.y - b.s.y / 2, b.c.z - sz / 2], max: [b.c.x + sx / 2, b.c.y + b.s.y / 2, b.c.z + sz / 2], surface: b.surface });
  }
  const r = (v: number) => Math.round(v * 500);
  let list = aabbs;
  for (let pass = 0; pass < 2; pass++) {
    for (const axis of [0, 2, 1]) {
      const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
      const groups = new Map<string, A[]>();
      for (const a of list) {
        const k = `${a.surface}|${r(a.min[o1])}|${r(a.max[o1])}|${r(a.min[o2])}|${r(a.max[o2])}`;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = []));
        g.push(a);
      }
      const next: A[] = [];
      for (const g of groups.values()) {
        g.sort((p, q) => p.min[axis] - q.min[axis]);
        let cur = g[0];
        for (let i = 1; i < g.length; i++) {
          const a = g[i];
          if (a.min[axis] <= cur.max[axis] + 0.002) {
            cur = { min: cur.min.slice(), max: cur.max.slice(), surface: cur.surface };
            cur.max[axis] = Math.max(cur.max[axis], a.max[axis]);
          } else { next.push(cur); cur = a; }
        }
        next.push(cur);
      }
      list = next;
    }
  }
  for (const a of list) {
    out.push({
      c: new THREE.Vector3((a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, (a.min[2] + a.max[2]) / 2),
      s: new THREE.Vector3(a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]),
      q: new THREE.Quaternion(),
      surface: a.surface,
    });
  }
  return out;
}

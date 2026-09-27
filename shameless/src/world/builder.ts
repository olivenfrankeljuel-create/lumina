import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, MaterialName } from '../core/types';
import type { Surface } from '../core/events';

/**
 * Material key: "<MaterialName>|<variant>" for library materials, "custom:<id>" for world-owned
 * canvas materials (decals, signs, foliage, cloth). Every static piece of geometry is pushed into a
 * batch per key and merged at the end, so draw calls ~= number of keys (x spatial chunks).
 */
export type MatKey = string;

const WEAR = [0.12, 0.35, 0.6, 0.85];
export function mk(name: MaterialName, variant = 0): MatKey {
  return `${name}|${variant}`;
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

interface ColBox {
  c: THREE.Vector3;
  s: THREE.Vector3;
  q: THREE.Quaternion;
  surface: Surface;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** Project world-space UVs (meters) by dominant normal axis so textures stay consistent across merged boxes. */
export function worldUV(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = nor.getX(i) > 0 ? -z : z; v = y; }
    else { u = nor.getZ(i) > 0 ? x : -x; v = y; }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function normalize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') geo.deleteAttribute(k);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geo.clearGroups();
  geo.morphAttributes = {};
  return geo;
}

export class Builder {
  readonly batches = new Map<MatKey, THREE.BufferGeometry[]>();
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
    if (key.startsWith('custom:')) return 'concrete';
    return this.ctx.materials.surfaceOf(parseKey(key).name);
  }

  /** Push geometry (consumed — do not reuse after). Optional world matrix applied. */
  add(key: MatKey, geo: THREE.BufferGeometry, m?: THREE.Matrix4, uv: 'world' | 'keep' = 'world'): void {
    if (m) geo.applyMatrix4(m);
    normalize(geo);
    if (uv === 'world') worldUV(geo);
    let list = this.batches.get(key);
    if (!list) this.batches.set(key, (list = []));
    list.push(geo);
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }

  /** Add geometry transformed by position/rotation(Euler YXZ order)/scale. */
  addT(key: MatKey, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1, uv: 'world' | 'keep' = 'world'): void {
    tmpE.set(rx, ry, rz, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
    this.add(key, geo, tmpM, uv);
  }

  box(key: MatKey, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: BoxOpts = {}): void {
    if (sx <= 0.0005 || sy <= 0.0005 || sz <= 0.0005) return;
    const g = UNIT_BOX.clone();
    this.addT(key, g, cx, cy, cz, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0, sx, sy, sz, o.uv ?? 'world');
    if (o.col) this.colBox(cx, cy, cz, sx, sy, sz, typeof o.col === 'string' ? o.col : this.surfaceOf(key), o.ry ?? 0, o.rx ?? 0, o.rz ?? 0);
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

  /** Merge all batches into meshes. Large batches are split into spatial chunks for frustum culling. */
  build(chunkSize = 44, chunkTriThreshold = 12000): THREE.Group {
    const group = new THREE.Group();
    group.name = 'world-static';
    for (const [key, geos] of this.batches) {
      if (!geos.length) continue;
      let mat: THREE.Material;
      if (key.startsWith('custom:')) mat = this.customMats.get(key)!;
      else {
        const { name, variant } = parseKey(key);
        mat = this.ctx.materials.get(name, { seed: variant * 7919 + 13, wear: WEAR[variant % 4] });
      }
      let total = 0;
      for (const g of geos) total += g.index!.count / 3;
      const buckets = new Map<string, THREE.BufferGeometry[]>();
      if (total > chunkTriThreshold && !this.noChunk.has(key)) {
        for (const g of geos) {
          g.computeBoundingBox();
          g.boundingBox!.getCenter(tmpV);
          const id = `${Math.floor(tmpV.x / chunkSize)},${Math.floor(tmpV.z / chunkSize)}`;
          let b = buckets.get(id);
          if (!b) buckets.set(id, (b = []));
          b.push(g);
        }
      } else buckets.set('all', geos);
      for (const [cid, list] of buckets) {
        const hasColor = list.some((g) => g.attributes.color);
        if (hasColor) for (const g of list) if (!g.attributes.color) {
          const c = new Float32Array(g.attributes.position.count * 3).fill(1);
          g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        }
        const merged = mergeGeometries(list, false);
        if (!merged) { console.warn('[world] merge failed for', key); continue; }
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = `${key}@${cid}`;
        mesh.matrixAutoUpdate = false;
        mesh.userData.surface = this.surfaceOf(key);
        mesh.userData.matKey = key;
        if (this.noShadow.has(key)) mesh.userData.noShadow = true;
        group.add(mesh);
      }
      for (const g of geos) g.dispose();
    }
    this.batches.clear();
    return group;
  }

  /** Invisible collision proxies, one box mesh per collision box (physics may turn them into cuboids). */
  buildColliders(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'world-colliders';
    const bySurface = new Map<Surface, THREE.BufferGeometry[]>();
    // Boxes: individual meshes with real dimensions (cheap for physics to convert to cuboids).
    for (const b of this.colBoxes) {
      const geo = new THREE.BoxGeometry(b.s.x, b.s.y, b.s.z);
      const m = new THREE.Mesh(geo);
      m.position.copy(b.c);
      m.quaternion.copy(b.q);
      m.userData.surface = b.surface;
      m.userData.collider = 'box';
      m.visible = false;
      group.add(m);
    }
    for (const g of this.colGeos) {
      let l = bySurface.get(g.surface);
      if (!l) bySurface.set(g.surface, (l = []));
      l.push(normalize(g.geo));
    }
    for (const [surface, list] of bySurface) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged);
      m.userData.surface = surface;
      m.visible = false;
      group.add(m);
    }
    group.updateMatrixWorld(true);
    return group;
  }
}

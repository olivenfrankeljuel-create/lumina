import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, World } from '../core/types';
import { WCtx } from './context';
import { buildMap, BOUNDS } from './map';
import { makeClothTexture, makeDecalAtlas, makeFarFacadeTexture, makeFoliageAtlas, makeSignAtlas } from './textures';
import { parseKey } from './builder';

/**
 * World: "Old Town" — dusty Middle-Eastern town blocks at golden hour.
 * All geometry is generated in code and merged per material (+ spatial chunks).
 * See map.ts for the layout description.
 */
export interface WorldExt extends World {
  /** Highest walkable surface at (x,z) at or below y + 0.5 (floors, roofs, balconies, ground). */
  surfaceHeight(x: number, z: number, y: number): number | null;
  readonly bounds: { x0: number; x1: number; z0: number; z1: number };
  readonly stats: { drawables: number; triangles: number; colliders: number; coverPoints: number };
}

interface FlutterMesh { mesh: THREE.Mesh; base: Float32Array; wamp: Float32Array; dir: Float32Array; phase: Float32Array }

export async function createWorld(ctx: GameContext): Promise<World> {
  const t0 = performance.now();
  const w = new WCtx(ctx, 1337);

  // ---- world-owned canvas materials
  const decalTex = makeDecalAtlas();
  const signTex = makeSignAtlas();
  const foliageTex = makeFoliageAtlas();
  const clothTex = makeClothTexture();
  const farTex = makeFarFacadeTexture();
  const tTex = performance.now();
  const cm = w.b.customMats;
  cm.set('custom:decal', new THREE.MeshStandardMaterial({
    name: 'world-decal', map: decalTex, transparent: true, depthWrite: false, polygonOffset: true,
    polygonOffsetFactor: -2, polygonOffsetUnits: -4, roughness: 0.95, metalness: 0, envMapIntensity: 0.6,
  }));
  cm.set('custom:sign', new THREE.MeshStandardMaterial({ name: 'world-sign', map: signTex, roughness: 0.62, metalness: 0.15 }));
  cm.set('custom:cloth', new THREE.MeshStandardMaterial({ name: 'world-cloth', map: clothTex, vertexColors: true, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 }));
  cm.set('custom:produce', new THREE.MeshStandardMaterial({ name: 'world-produce', vertexColors: true, roughness: 0.55, metalness: 0 }));
  cm.set('custom:foliage', new THREE.MeshStandardMaterial({ name: 'world-foliage', map: foliageTex, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 }));
  cm.set('custom:far', new THREE.MeshStandardMaterial({ name: 'world-far', map: farTex, roughness: 0.95, metalness: 0 }));
  cm.set('custom:mountain', new THREE.MeshStandardMaterial({ name: 'world-mountain', color: 0xa99478, roughness: 1, metalness: 0 }));
  w.b.noShadow.add('custom:decal');
  (cm.get('custom:foliage') as THREE.MeshStandardMaterial).shadowSide = THREE.DoubleSide;

  buildMap(w);
  const tMap = performance.now();

  const root = new THREE.Group();
  root.name = 'world';
  const tris = w.b.tris;
  const statics = w.b.build();
  root.add(statics);
  const tMerge = performance.now();

  // ---- flutter (cloth, tarps, foliage): CPU-animated merged meshes
  const flutters: FlutterMesh[] = [];
  for (const [key, pieces] of w.flutter) {
    const geos: THREE.BufferGeometry[] = [];
    const wamp: number[] = [], dir: number[] = [], phase: number[] = [];
    for (const p of pieces) {
      const g = p.geo;
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.color) {
        const c = new Float32Array(g.attributes.position.count * 3).fill(1);
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      geos.push(g);
      for (let i = 0; i < g.attributes.position.count; i++) {
        wamp.push(p.weight[i] * p.amp);
        dir.push(p.dir.x, p.dir.y, p.dir.z);
        phase.push(p.phase);
      }
    }
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.boundingSphere!.radius += 1;
    const mat = key.startsWith('custom:') ? cm.get(key)! : ctx.materials.get(parseKey(key).name, { seed: parseKey(key).variant * 7919 + 13 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `flutter:${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.userData.surface = 'fabric';
    (merged.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
    flutters.push({ mesh, base: new Float32Array(merged.attributes.position.array as Float32Array), wamp: new Float32Array(wamp), dir: new Float32Array(dir), phase: new Float32Array(phase) });
  }

  ctx.scene.add(root);
  ctx.pipeline.setupShadows(root);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.noShadow) { m.castShadow = false; m.receiveShadow = !String(m.userData.matKey).startsWith('custom:far') && m.userData.matKey !== 'custom:mountain'; }
    if (m.userData.matKey === 'custom:decal') m.renderOrder = 1;
  });

  // ---- collision
  const tShadow = performance.now();
  const colliders = w.b.buildColliders();
  ctx.physics.addStatic(colliders);
  const tPhys = performance.now();
  console.info(`[world] timings ms: textures ${(tTex - t0).toFixed(0)}, map ${(tMap - tTex).toFixed(0)}, merge ${(tMerge - tMap).toFixed(0)}, flutter+shadows ${(tShadow - tMerge).toFixed(0)}, physics ${(tPhys - tShadow).toFixed(0)}`);

  // ---- height lookup (0.5 m grid of ground-level pads; decks for elevated queries)
  const CELL = 0.5;
  const gw = Math.ceil((BOUNDS.x1 - BOUNDS.x0) / CELL), gh = Math.ceil((BOUNDS.z1 - BOUNDS.z0) / CELL);
  const grid = new Float32Array(gw * gh);
  for (const r of w.ground) {
    const i0 = Math.max(0, Math.floor((r.x0 - BOUNDS.x0) / CELL)), i1 = Math.min(gw - 1, Math.ceil((r.x1 - BOUNDS.x0) / CELL) - 1);
    const j0 = Math.max(0, Math.floor((r.z0 - BOUNDS.z0) / CELL)), j1 = Math.min(gh - 1, Math.ceil((r.z1 - BOUNDS.z0) / CELL) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * gw + i] = Math.max(grid[j * gw + i], r.h);
  }
  const inBounds = (x: number, z: number) => x >= BOUNDS.x0 && x <= BOUNDS.x1 && z >= BOUNDS.z0 && z <= BOUNDS.z1;
  const groundHeight = (x: number, z: number): number | null => {
    if (!inBounds(x, z)) return null;
    const i = Math.min(gw - 1, Math.floor((x - BOUNDS.x0) / CELL)), j = Math.min(gh - 1, Math.floor((z - BOUNDS.z0) / CELL));
    return grid[j * gw + i];
  };
  const surfaceHeight = (x: number, z: number, y: number): number | null => {
    const g = groundHeight(x, z);
    if (g === null) return null;
    let best = g;
    for (const d of w.decks) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1 && d.h <= y + 0.5 && d.h > best) best = d.h;
    return best;
  };

  // ---- validate cover points (drop any that ended up inside geometry)
  const inv = new THREE.Matrix4(), m4 = new THREE.Matrix4(), lp = new THREE.Vector3();
  const boxes = w.b.colBoxes.filter((b) => b.s.y < 30);
  const blocked = (p: THREE.Vector3) => {
    for (const b of boxes) {
      if (Math.abs(p.x - b.c.x) > b.s.x + b.s.z || Math.abs(p.z - b.c.z) > b.s.x + b.s.z) continue;
      m4.compose(b.c, b.q, new THREE.Vector3(1, 1, 1));
      inv.copy(m4).invert();
      lp.copy(p).applyMatrix4(inv);
      if (Math.abs(lp.x) < b.s.x / 2 + 0.25 && Math.abs(lp.y) < b.s.y / 2 && Math.abs(lp.z) < b.s.z / 2 + 0.25) return true;
    }
    return false;
  };
  const cover = w.cover.filter((c) => {
    if (!inBounds(c.position.x, c.position.z)) return false;
    const g = surfaceHeight(c.position.x, c.position.z, c.position.y + 0.3) ?? 0;
    c.position.y = Math.max(c.position.y, g);
    return !blocked(new THREE.Vector3(c.position.x, c.position.y + 0.9, c.position.z));
  });

  const flutterTmp = { t: 0 };
  let drawables = 0;
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) drawables++; });
  const world: WorldExt = {
    root,
    bounds: BOUNDS,
    playerSpawns: [
      { position: new THREE.Vector3(0, 0.02, 62.5), yaw: 0 },
      { position: new THREE.Vector3(-12, 0.02, 62.5), yaw: 0.15 },
      { position: new THREE.Vector3(12, 0.02, 62.8), yaw: -0.15 },
    ],
    enemySpawns: w.enemySpawns,
    coverPoints: cover,
    groundHeight,
    surfaceHeight,
    stats: { drawables, triangles: Math.round(tris), colliders: colliders.children.length, coverPoints: cover.length },
    update(_dt, time) {
      flutterTmp.t = time;
      for (const f of flutters) {
        const pos = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        const n = f.wamp.length;
        for (let i = 0; i < n; i++) {
          const a = f.wamp[i];
          const i3 = i * 3;
          if (a === 0) continue;
          const bx = f.base[i3], by = f.base[i3 + 1], bz = f.base[i3 + 2];
          const ph = f.phase[i];
          const s = Math.sin(time * 2.3 + ph + bx * 0.35 + bz * 0.2) * 0.65 + Math.sin(time * 5.9 + ph * 1.7 + by * 1.3) * 0.35;
          arr[i3] = bx + f.dir[i3] * a * s;
          arr[i3 + 1] = by + f.dir[i3 + 1] * a * s;
          arr[i3 + 2] = bz + f.dir[i3 + 2] * a * s;
        }
        pos.needsUpdate = true;
      }
    },
  };
  console.info(`[world] built in ${(performance.now() - t0).toFixed(0)} ms: ${drawables} meshes, ${Math.round(tris / 1000)}k tris, ${colliders.children.length} colliders, ${cover.length} cover points, ${w.enemySpawns.length} enemy spawns`);
  return world;
}

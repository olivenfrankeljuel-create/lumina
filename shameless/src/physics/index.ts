import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, Physics, RaycastHit } from '../core/types';
import type { Surface } from '../core/events';
import { GROUP, GROUPS, interactionGroups } from './groups';
import { HitboxSet, fitHitbox, makeHitbox, rayCapsuleRaw, closestOnSegment, type HitRegion, type HitboxShapeOptions, type Hitbox } from './hitboxes';
import { DynamicBodies, type DynamicBody, type DynamicBodyOptions, type ImpactInfo } from './dynamics';

export { GROUP, GROUPS, interactionGroups } from './groups';
export type { DynamicBody, DynamicBodyOptions, ImpactInfo } from './dynamics';
export type { Hitbox, HitRegion, HitboxShapeOptions } from './hitboxes';

/** Fixed simulation rate for dynamic bodies. */
export const PHYSICS_HZ = 60;
const FIXED_DT = 1 / PHYSICS_HZ;
const MAX_SUBSTEPS = 5;

/** How far behind an entry point we probe for the exit face (wall thickness). */
const PENETRATION_PROBE = 1.5;

/**
 * Relative "hardness" per meter of material for bullet penetration: a bullet with penetration power P
 * (in meters of wood-equivalent) can pass `P / resistance` meters of the material.
 */
export const PENETRATION_RESISTANCE: Record<Surface, number> = {
  wood: 1, plaster: 1.3, fabric: 0.3, glass: 0.4, flesh: 0.8, dirt: 4, sand: 5, gravel: 5,
  brick: 5, concrete: 7, asphalt: 7, tile: 3, metal: 9, water: 2,
};

export interface RaycastOptions {
  ignorePlayer?: boolean;
  ignoreEnemies?: boolean;
  /** Also skip world/props (hitboxes + player only). */
  ignoreWorld?: boolean;
  /** Skip props/dynamic bodies (static world only). */
  ignoreProps?: boolean;
  /** Ignore a specific collider (e.g. a grenade's own). */
  excludeCollider?: RAPIER.Collider;
  /** Skip the wall-thickness probe (slightly cheaper). */
  noThickness?: boolean;
}

export interface ExtRaycastHit extends RaycastHit {
  /** Rapier collider that was hit (world/prop hits). */
  collider?: RAPIER.Collider | null;
  /** Material thickness along the ray from `point` to the exit face (m). Infinity if thicker than 1.5 m. */
  thickness?: number;
  /** Where the ray leaves the hit solid (if thickness is finite). */
  exitPoint?: THREE.Vector3;
  /** True when the ray hit the player capsule. */
  player?: boolean;
  /** Hitbox that was hit (enemy hits). */
  hitbox?: Hitbox;
}

export interface JointOptions {
  type: 'spherical' | 'revolute' | 'fixed';
  /** Anchor in body A's local frame. */
  anchorA: THREE.Vector3;
  /** Anchor in body B's local frame. */
  anchorB: THREE.Vector3;
  /** Revolute hinge axis (local, shared). */
  axis?: THREE.Vector3;
  /** Revolute angle limits [min,max] radians. */
  limits?: [number, number];
  /** Allow the two jointed bodies to collide with each other (default false). */
  contacts?: boolean;
}

/** Physics plus the extra helpers other modules can use via `physicsExt(ctx.physics)`. */
export interface ShamelessPhysics extends Physics {
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts?: RaycastOptions): ExtRaycastHit | null;
  /** Every hit along the ray (world/props with thickness + nearest hitbox per enemy + player), nearest first. */
  raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts?: RaycastOptions): ExtRaycastHit[];
  /**
   * Bullet with wall penetration. `power` is in meters of wood-equivalent (e.g. SMG 0.15, rifle 0.35, LMG/sniper 0.6):
   * each solid crossed costs thickness × PENETRATION_RESISTANCE[surface]; flesh costs 0.25 per body.
   * Returns every surface/enemy hit in order with the damage multiplier remaining at that point; the last
   * entry with `stopped: true` is where the bullet ended (if it hit something it couldn't pass).
   */
  raycastPenetrating(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, power: number, opts?: RaycastOptions): { hit: ExtRaycastHit; damageScale: number; stopped: boolean }[];
  /** Static-world line of sight test (ignores props, enemies and the player). */
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
  /** Sphere cast against world + props. Returns distance to first contact or null. */
  sphereCast(origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number): { distance: number; point: THREE.Vector3; normal: THREE.Vector3; surface: Surface; collider: RAPIER.Collider } | null;
  /** Register a capsule hitbox along the object's local axis (default Y). */
  registerHitboxCapsule(object: THREE.Object3D, enemyId: number, region: HitRegion, radius: number, halfHeight: number, opts?: HitboxShapeOptions & { axis?: 'x' | 'y' | 'z' }): void;
  /** Register a box hitbox with an optional local offset/rotation (always a box, no capsule fitting). */
  registerHitboxBox(object: THREE.Object3D, enemyId: number, region: HitRegion, halfExtents: THREE.Vector3, opts?: HitboxShapeOptions): void;
  /** Debug access to current hitboxes (world transforms refreshed). */
  hitboxes(): Hitbox[];
  /** Mark hitbox transforms stale (they refresh lazily from matrixWorld once per step otherwise). */
  invalidateHitboxes(): void;
  /** Spawn a dynamic rigid body (shell casing, grenade, prop, ragdoll part). Synced to opts.object with interpolation. */
  spawnDynamic(opts: DynamicBodyOptions): DynamicBody;
  removeDynamic(b: DynamicBody): void;
  /** Joint two dynamic bodies (ragdolls). Returns the Rapier joint. */
  createJoint(a: DynamicBody, b: DynamicBody, opts: JointOptions): RAPIER.ImpulseJoint;
  /** Radial impulse on dynamic bodies (also applied automatically on the 'explosion' event). strength ≈ Δv (m/s) at centre. */
  applyExplosion(center: THREE.Vector3, radius: number, strength: number): void;
  readonly dynamicBodies: readonly DynamicBody[];
  /** Max live debris bodies (oldest evicted). Default 96. */
  maxDebris: number;
  /** Interpolation factor (0..1) between the last two fixed steps. */
  readonly alpha: number;
  readonly fixedDt: number;
  /** Number of fixed steps taken so far. */
  readonly stepCount: number;
  surfaceOfCollider(c: RAPIER.Collider | null | undefined): Surface;
  objectOfCollider(c: RAPIER.Collider | null | undefined): THREE.Object3D | null;
  /** Remove every static collider created from `object` (and its descendants) by addStatic. */
  removeStatic(object: THREE.Object3D): void;
  /** Player capsule used for enemy bullets (set by the player module). null disables. */
  setPlayerCapsule(a: THREE.Vector3 | null, b?: THREE.Vector3, radius?: number): void;
  /** Make freshly-added colliders visible to queries immediately (called automatically before queries). */
  flush(): void;
  /** Number of static colliders (debug). */
  readonly staticCount: number;
}

/** Access the extended physics API from a GameContext's `physics`. */
export function physicsExt(p: Physics): ShamelessPhysics {
  return p as ShamelessPhysics;
}

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _dir = new THREE.Vector3();

function isValidSurfaceName(ctx: GameContext, name: unknown): Surface | null {
  if (typeof name !== 'string' || !ctx.materials) return null;
  try { return ctx.materials.surfaceOf(name as never) ?? null; } catch { return null; }
}

export async function createPhysics(ctx: GameContext): Promise<ShamelessPhysics> {
  await initRapier();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const colliderInfo = new Map<number, { object: THREE.Object3D | null; surface: Surface; static: boolean; source?: THREE.Object3D }>();
  const hitboxes = new HitboxSet();
  let dirty = false;
  let accumulator = 0;
  let alpha = 0;
  let stepCount = 0;
  let staticCount = 0;
  const ballCache = new Map<number, RAPIER.Ball>();
  const playerCap = { enabled: false, a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.35 };

  const info = {
    surfaceOfCollider(c: RAPIER.Collider | null | undefined): Surface { return (c && colliderInfo.get(c.handle)?.surface) || 'concrete'; },
    register(c: RAPIER.Collider, object: THREE.Object3D | null, surface: Surface) { colliderInfo.set(c.handle, { object, surface, static: false }); },
    unregister(c: RAPIER.Collider) { colliderInfo.delete(c.handle); },
  };
  const dyn = new DynamicBodies(world, RAPIER, info, () => { dirty = true; });

  function flush() {
    if (!dirty) return;
    dirty = false;
    // A zero-length step rebuilds the broad-phase so newly created colliders become queryable.
    world.timestep = 0;
    world.step();
    world.timestep = FIXED_DT;
  }

  function surfaceFor(mesh: THREE.Object3D, fallback: Surface): Surface {
    // mesh or nearest ancestor userData.surface wins, then the material's tag, then the addStatic argument.
    for (let o: THREE.Object3D | null = mesh; o; o = o.parent) {
      if (o.userData?.surface) return o.userData.surface as Surface;
    }
    const mat = (mesh as THREE.Mesh).material;
    const m = Array.isArray(mat) ? mat[0] : mat;
    if (m) {
      if (m.userData?.surface) return m.userData.surface as Surface;
      const s = isValidSurfaceName(ctx, m.userData?.materialName) ?? isValidSurfaceName(ctx, m.name || undefined);
      if (s) return s;
    }
    return fallback;
  }

  /** Every vertex at a bbox corner and all 8 corners used → an (oriented) box. */
  function isBoxGeometry(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, bb: THREE.Box3): boolean {
    if (pos.count > 36 || pos.count < 8) return false;
    const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
    const eps = Math.max(sx, sy, sz) * 1e-4 + 1e-6;
    if (sx < eps || sy < eps || sz < eps) return false;
    let mask = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const bx = Math.abs(x - bb.min.x) < eps ? 0 : Math.abs(x - bb.max.x) < eps ? 1 : -1;
      const by = Math.abs(y - bb.min.y) < eps ? 0 : Math.abs(y - bb.max.y) < eps ? 1 : -1;
      const bz = Math.abs(z - bb.min.z) < eps ? 0 : Math.abs(z - bb.max.z) < eps ? 1 : -1;
      if (bx < 0 || by < 0 || bz < 0) return false;
      mask |= 1 << (bx | (by << 1) | (bz << 2));
    }
    return mask === 0xff;
  }

  function addCuboid(bb: THREE.Box3, matrix: THREE.Matrix4): RAPIER.Collider {
    matrix.decompose(_p, _q, _s);
    const c = bb.getCenter(_v).applyMatrix4(matrix);
    const hx = Math.max(0.005, ((bb.max.x - bb.min.x) / 2) * Math.abs(_s.x));
    const hy = Math.max(0.005, ((bb.max.y - bb.min.y) / 2) * Math.abs(_s.y));
    const hz = Math.max(0.005, ((bb.max.z - bb.min.z) / 2) * Math.abs(_s.z));
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(c.x, c.y, c.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setCollisionGroups(GROUPS.world)
      .setFriction(0.8);
    return world.createCollider(desc);
  }

  function addTrimesh(geom: THREE.BufferGeometry, matrix: THREE.Matrix4): RAPIER.Collider | null {
    const pos = geom.attributes.position;
    if (!pos || pos.count < 3) return null;
    const verts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      verts[i * 3] = _v.x; verts[i * 3 + 1] = _v.y; verts[i * 3 + 2] = _v.z;
    }
    let indices: Uint32Array;
    if (geom.index) {
      const src = geom.index.array;
      const start = geom.drawRange.start, end = Math.min(src.length, geom.drawRange.count === Infinity ? src.length : start + geom.drawRange.count);
      indices = new Uint32Array(Math.floor((end - start) / 3) * 3);
      for (let i = 0; i < indices.length; i++) indices[i] = src[start + i];
    } else {
      indices = new Uint32Array(Math.floor(pos.count / 3) * 3);
      for (let i = 0; i < indices.length; i++) indices[i] = i;
    }
    if (indices.length < 3) return null;
    let desc: RAPIER.ColliderDesc;
    try { desc = RAPIER.ColliderDesc.trimesh(verts, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES); }
    catch { desc = RAPIER.ColliderDesc.trimesh(verts, indices); }
    desc.setCollisionGroups(GROUPS.world).setFriction(0.8);
    try { return world.createCollider(desc); }
    catch {
      const plain = RAPIER.ColliderDesc.trimesh(verts, indices).setCollisionGroups(GROUPS.world);
      return world.createCollider(plain);
    }
  }

  function addHull(geom: THREE.BufferGeometry, matrix: THREE.Matrix4): RAPIER.Collider | null {
    const pos = geom.attributes.position;
    const pts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { _v.fromBufferAttribute(pos, i).applyMatrix4(matrix); pts[i * 3] = _v.x; pts[i * 3 + 1] = _v.y; pts[i * 3 + 2] = _v.z; }
    const desc = RAPIER.ColliderDesc.convexHull(pts);
    if (!desc) return null;
    return world.createCollider(desc.setCollisionGroups(GROUPS.world).setFriction(0.8));
  }

  function addMeshWithMatrix(mesh: THREE.Mesh, matrix: THREE.Matrix4, surface: Surface, source: THREE.Object3D) {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom?.attributes?.position;
    if (!pos) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    if (bb.isEmpty()) return;
    const mode = mesh.userData.collider as string | undefined; // 'box' | 'hull' | 'mesh'
    let c: RAPIER.Collider | null = null;
    if (mode === 'box' || (mode !== 'mesh' && mode !== 'hull' && isBoxGeometry(pos, bb))) c = addCuboid(bb, matrix);
    else if (mode === 'hull') c = addHull(geom, matrix);
    else c = addTrimesh(geom, matrix);
    if (c) {
      colliderInfo.set(c.handle, { object: mesh, surface, static: true, source });
      staticCount++;
    }
  }

  const api: ShamelessPhysics = {
    world,
    rapier: RAPIER,
    get alpha() { return alpha; },
    get stepCount() { return stepCount; },
    get staticCount() { return staticCount; },
    fixedDt: FIXED_DT,
    get dynamicBodies() { return dyn.list; },
    get maxDebris() { return dyn.maxDebris; },
    set maxDebris(v: number) { dyn.maxDebris = v; },

    addStatic(object, surface = 'concrete') {
      object.updateWorldMatrix(true, true);
      const visit = (o: THREE.Object3D) => {
        if (o.userData?.noCollide) return;
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && !o.userData.__physicsStatic) {
          o.userData.__physicsStatic = true; // adding the same mesh twice (e.g. child then root) is a no-op
          const s = surfaceFor(mesh, surface);
          const inst = o as THREE.InstancedMesh;
          if (inst.isInstancedMesh) {
            const im = new THREE.Matrix4();
            for (let i = 0; i < inst.count; i++) {
              inst.getMatrixAt(i, im);
              _m.multiplyMatrices(inst.matrixWorld, im);
              addMeshWithMatrix(mesh, _m.clone(), s, object);
            }
          } else addMeshWithMatrix(mesh, mesh.matrixWorld, s, object);
        }
        for (const c of o.children) visit(c);
      };
      visit(object);
      dirty = true;
    },

    removeStatic(object) {
      const set = new Set<THREE.Object3D>();
      object.traverse((o) => set.add(o));
      for (const [h, inf] of [...colliderInfo]) {
        if (!inf.static || !inf.object || !set.has(inf.object)) continue;
        const c = world.getCollider(h);
        if (c) world.removeCollider(c, false);
        delete inf.object.userData.__physicsStatic;
        colliderInfo.delete(h);
        staticCount--;
      }
      dirty = true;
    },

    raycast(origin, dir, maxDist, opts) {
      flush();
      _dir.copy(dir).normalize();
      let best: ExtRaycastHit | null = null;
      if (!opts?.ignoreWorld) {
        const r = new RAPIER.Ray(origin, _dir);
        const h = world.castRayAndGetNormal(r, maxDist, true, undefined, opts?.ignoreProps ? GROUPS.queryWorld : GROUPS.queryBullet, opts?.excludeCollider);
        if (h) best = makeWorldHit(origin, _dir, h.collider, h.timeOfImpact, h.normal, !opts?.noThickness);
      }
      const limit = best ? best.distance : maxDist;
      if (!opts?.ignoreEnemies) {
        const hb = hitboxes.intersectNearest(origin, _dir, limit);
        if (hb) best = makeHitboxHit(origin, _dir, hb.t, hb.normal, hb.hb);
      }
      if (!opts?.ignorePlayer) {
        const t = rayPlayer(origin, _dir, best ? best.distance : maxDist);
        if (t >= 0) best = makePlayerHit(origin, _dir, t);
      }
      return best;
    },

    raycastAll(origin, dir, maxDist, opts) {
      flush();
      const d = new THREE.Vector3().copy(dir).normalize();
      const out: ExtRaycastHit[] = [];
      if (!opts?.ignoreWorld) {
        const r = new RAPIER.Ray(origin, d);
        world.intersectionsWithRay(r, maxDist, true, (h) => {
          out.push(makeWorldHit(origin, d, h.collider, h.timeOfImpact, h.normal, !opts?.noThickness));
          return true;
        }, undefined, opts?.ignoreProps ? GROUPS.queryWorld : GROUPS.queryBullet, opts?.excludeCollider);
      }
      if (!opts?.ignoreEnemies) {
        for (const h of hitboxes.intersectAll(origin, d, maxDist, [])) out.push(makeHitboxHit(origin, d, h.t, h.normal, h.hb));
      }
      if (!opts?.ignorePlayer) {
        const t = rayPlayer(origin, d, maxDist);
        if (t >= 0) out.push(makePlayerHit(origin, d, t));
      }
      out.sort((a, b) => a.distance - b.distance);
      return out;
    },

    raycastPenetrating(origin, dir, maxDist, power, opts) {
      const out: { hit: ExtRaycastHit; damageScale: number; stopped: boolean }[] = [];
      let remaining = Math.max(0, power);
      let scale = 1;
      for (const h of api.raycastAll(origin, dir, maxDist, opts)) {
        const cost = h.enemyId !== undefined || h.player ? 0.25
          : (h.thickness ?? Infinity) * (PENETRATION_RESISTANCE[h.surface] ?? 5);
        const stopped = !(cost <= remaining) || h.player === true;
        out.push({ hit: h, damageScale: scale, stopped });
        if (stopped) break;
        remaining -= cost;
        // lose up to half the damage per obstacle, proportional to how much of the power it ate
        if (h.enemyId === undefined) scale *= 1 - 0.5 * Math.min(1, cost / Math.max(1e-3, power));
        else scale *= 0.8;
      }
      return out;
    },

    lineOfSight(from, to) {
      flush();
      const d = _dir.copy(to).sub(from);
      const len = d.length();
      if (len < 1e-4) return true;
      d.multiplyScalar(1 / len);
      const h = world.castRay(new RAPIER.Ray(from, d), len, true, undefined, GROUPS.queryWorld);
      return !h || h.timeOfImpact >= len - 1e-3;
    },

    sphereCast(origin, dir, radius, maxDist) {
      flush();
      const d = new THREE.Vector3().copy(dir).normalize();
      let shape = ballCache.get(radius);
      if (!shape) { shape = new RAPIER.Ball(radius); if (ballCache.size < 32) ballCache.set(radius, shape); }
      const h = world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, d, shape, 0, maxDist, true, undefined, GROUPS.queryBullet);
      if (!h) return null;
      return {
        distance: h.time_of_impact,
        point: new THREE.Vector3(h.witness1.x, h.witness1.y, h.witness1.z),
        normal: new THREE.Vector3(h.normal1.x, h.normal1.y, h.normal1.z),
        surface: info.surfaceOfCollider(h.collider),
        collider: h.collider,
      };
    },

    registerHitbox(object, enemyId, region, halfExtents) {
      hitboxes.add(fitHitbox(object, enemyId, region, halfExtents));
    },
    registerHitboxBox(object, enemyId, region, halfExtents, opts) {
      hitboxes.add(makeHitbox(object, enemyId, region, 'box', halfExtents, 0, 0, opts));
    },
    registerHitboxCapsule(object, enemyId, region, radius, halfHeight, opts) {
      let rotation = opts?.rotation?.clone();
      const axis = opts?.axis ?? 'y';
      if (axis !== 'y') {
        const q = axis === 'x' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2) : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        rotation = rotation ? rotation.multiply(q) : q;
      }
      hitboxes.add(makeHitbox(object, enemyId, region, 'capsule', new THREE.Vector3(radius, halfHeight + radius, radius), radius, halfHeight, { offset: opts?.offset, rotation }));
    },
    unregisterHitboxes(enemyId) { hitboxes.remove(enemyId); },
    hitboxes() { return hitboxes.all(); },
    invalidateHitboxes() { hitboxes.invalidate(); },

    spawnDynamic(opts) { return dyn.spawn(opts); },
    removeDynamic(b) { dyn.remove(b); },
    createJoint(a, b, o) {
      let data: RAPIER.JointData;
      const aa = { x: o.anchorA.x, y: o.anchorA.y, z: o.anchorA.z }, ab = { x: o.anchorB.x, y: o.anchorB.y, z: o.anchorB.z };
      if (o.type === 'revolute') {
        const ax = o.axis ?? new THREE.Vector3(1, 0, 0);
        data = RAPIER.JointData.revolute(aa, ab, { x: ax.x, y: ax.y, z: ax.z });
      } else if (o.type === 'fixed') data = RAPIER.JointData.fixed(aa, { x: 0, y: 0, z: 0, w: 1 }, ab, { x: 0, y: 0, z: 0, w: 1 });
      else data = RAPIER.JointData.spherical(aa, ab);
      const j = world.createImpulseJoint(data, a.body, b.body, true);
      j.setContactsEnabled(!!o.contacts);
      if (o.type === 'revolute' && o.limits) (j as RAPIER.RevoluteImpulseJoint).setLimits(o.limits[0], o.limits[1]);
      return j;
    },
    applyExplosion(center, radius, strength) { dyn.explosion(center, radius, strength); },

    surfaceOfCollider(c) { return info.surfaceOfCollider(c ?? null); },
    objectOfCollider(c) { return (c && colliderInfo.get(c.handle)?.object) || null; },
    setPlayerCapsule(a, b, radius) {
      if (!a) { playerCap.enabled = false; return; }
      playerCap.enabled = true;
      playerCap.a.copy(a);
      playerCap.b.copy(b ?? a);
      playerCap.r = radius ?? 0.35;
    },
    flush,

    step(dt) {
      flush();
      accumulator += Math.min(Math.max(dt, 0), 0.25);
      let n = 0;
      while (accumulator >= FIXED_DT && n < MAX_SUBSTEPS) {
        dyn.preStep();
        world.step();
        dyn.postStep(FIXED_DT);
        accumulator -= FIXED_DT;
        n++;
        stepCount++;
      }
      if (n === MAX_SUBSTEPS && accumulator > FIXED_DT) accumulator = FIXED_DT * 0.5; // spiral-of-death guard
      alpha = accumulator / FIXED_DT;
      dyn.sync(alpha);
      hitboxes.invalidate();
    },
  };

  function makeWorldHit(origin: THREE.Vector3, d: THREE.Vector3, collider: RAPIER.Collider, toi: number, n: { x: number; y: number; z: number }, thickness: boolean): ExtRaycastHit {
    const inf = colliderInfo.get(collider.handle);
    const point = new THREE.Vector3().copy(origin).addScaledVector(d, toi);
    const hit: ExtRaycastHit = {
      point,
      normal: new THREE.Vector3(n.x, n.y, n.z),
      distance: toi,
      surface: inf?.surface ?? 'concrete',
      object: inf?.object ?? null,
      collider,
    };
    if (hit.normal.lengthSq() < 1e-8) hit.normal.copy(d).negate();
    if (thickness) {
      // probe backwards from beyond the entry point to find the exit face of the same collider
      const start = _p.copy(point).addScaledVector(d, PENETRATION_PROBE);
      const back = new RAPIER.Ray(start, { x: -d.x, y: -d.y, z: -d.z });
      const t = collider.castRay(back, PENETRATION_PROBE, true);
      if (t >= 0 && t < PENETRATION_PROBE - 1e-3) {
        hit.thickness = PENETRATION_PROBE - t;
        hit.exitPoint = new THREE.Vector3().copy(start).addScaledVector(d, -t);
      } else hit.thickness = Infinity;
    }
    return hit;
  }

  function makeHitboxHit(origin: THREE.Vector3, d: THREE.Vector3, t: number, n: THREE.Vector3, hb: Hitbox): ExtRaycastHit {
    return {
      point: new THREE.Vector3().copy(origin).addScaledVector(d, t),
      normal: n.clone(), distance: t, surface: 'flesh', object: hb.object,
      enemyId: hb.enemyId, region: hb.region, hitbox: hb,
    };
  }

  function makePlayerHit(origin: THREE.Vector3, d: THREE.Vector3, t: number): ExtRaycastHit {
    const point = new THREE.Vector3().copy(origin).addScaledVector(d, t);
    const c = closestOnSegment(point, playerCap.a, playerCap.b, new THREE.Vector3());
    const normal = point.clone().sub(c);
    if (normal.lengthSq() < 1e-8) normal.copy(d).negate(); else normal.normalize();
    return { point, normal, distance: t, surface: 'flesh', object: null, player: true };
  }

  const _cp = new THREE.Vector3();
  function rayPlayer(origin: THREE.Vector3, d: THREE.Vector3, maxDist: number): number {
    if (!playerCap.enabled) return -1;
    // rays that start at/near the player (own shots, incl. from a leaned camera) never hit the player
    closestOnSegment(origin, playerCap.a, playerCap.b, _cp);
    if (_cp.distanceToSquared(origin) <= (playerCap.r + 0.6) ** 2) return -1;
    const t = rayCapsuleRaw(origin, d, playerCap.a, playerCap.b, playerCap.r);
    return t >= 0 && t <= maxDist ? t : -1;
  }

  // Explosions push loose bodies around.
  ctx.events?.on('explosion', (e) => dyn.explosion(e.position, e.radius * 1.5, 9));

  return api;
}

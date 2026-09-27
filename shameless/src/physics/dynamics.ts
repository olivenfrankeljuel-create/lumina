import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Surface } from '../core/events';
import { GROUPS } from './groups';

export type DynamicKind = 'debris' | 'prop' | 'ragdoll';

export interface ImpactInfo {
  /** Approximate closing speed at impact, m/s. */
  speed: number;
  position: THREE.Vector3;
  /** Surface of the thing that was hit. */
  surface: Surface;
  other: RAPIER.Collider | null;
}

export interface DynamicBodyOptions {
  shape: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'convex';
  /** box: half extents (m). */
  halfExtents?: THREE.Vector3;
  /** sphere/capsule/cylinder radius (m). */
  radius?: number;
  /** capsule/cylinder half height of the straight part (m), along local Y. */
  halfHeight?: number;
  /** convex: local-space points (x,y,z,...), e.g. geometry.attributes.position.array. */
  points?: Float32Array;
  /** Local offset of the collider inside the body (e.g. centre of a bone's mesh). */
  colliderOffset?: THREE.Vector3;
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  angularVelocity?: THREE.Vector3;
  /** Total mass (kg). Default: density 1000*volume-ish from Rapier (density option). */
  mass?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  /** Collision group preset. 'debris' (default) ignores other debris and the player. */
  kind?: DynamicKind;
  /** Continuous collision detection for fast small bodies (grenades, casings). Default true for debris/prop. */
  ccd?: boolean;
  /** Visual synced (with interpolation) to the body. Should have no rotated/scaled parents (e.g. child of scene). */
  object?: THREE.Object3D;
  /** Auto-remove after this many seconds. */
  lifetime?: number;
  /** Called when the body is removed (expired, evicted from the debris cap, or remove()). */
  onRemove?: (b: DynamicBody) => void;
  /** Called on significant impacts (≥ minImpactSpeed, default 1 m/s), rate-limited. */
  onImpact?: (e: ImpactInfo) => void;
  minImpactSpeed?: number;
  /** Surface of this body for bullet impacts / other bodies' onImpact. */
  surface?: Surface;
  /** Arbitrary user data. */
  userData?: unknown;
}

export interface DynamicBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly object: THREE.Object3D | null;
  readonly kind: DynamicKind;
  /** Seconds since spawn. */
  readonly age: number;
  readonly alive: boolean;
  userData: unknown;
  /** Interpolated render transform (valid after each physics.step). */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  applyImpulse(impulse: THREE.Vector3, atPoint?: THREE.Vector3): void;
  setVelocity(v: THREE.Vector3): void;
  remove(): void;
}

interface Internal extends DynamicBody {
  alive: boolean;
  age: number;
  lifetime: number;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  prevVel: THREE.Vector3;
  impactCooldown: number;
  minImpact: number;
  onImpact?: (e: ImpactInfo) => void;
  onRemove?: (b: DynamicBody) => void;
  sleepingSynced: boolean;
}

export interface ColliderInfoLookup {
  surfaceOfCollider(c: RAPIER.Collider | null): Surface;
  register(c: RAPIER.Collider, object: THREE.Object3D | null, surface: Surface): void;
  unregister(c: RAPIER.Collider): void;
}

export class DynamicBodies {
  readonly list: Internal[] = [];
  maxDebris = 96;
  private debrisCount = 0;

  constructor(private world: RAPIER.World, private R: typeof RAPIER, private info: ColliderInfoLookup, private markDirty: () => void) {}

  spawn(o: DynamicBodyOptions): DynamicBody {
    const R = this.R;
    const kind = o.kind ?? 'debris';
    const q = o.quaternion ?? new THREE.Quaternion();
    const bd = R.RigidBodyDesc.dynamic()
      .setTranslation(o.position.x, o.position.y, o.position.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setCcdEnabled(o.ccd ?? kind !== 'ragdoll')
      .setLinearDamping(o.linearDamping ?? (kind === 'debris' ? 0.05 : 0.02))
      .setAngularDamping(o.angularDamping ?? (kind === 'ragdoll' ? 0.8 : 0.2))
      .setGravityScale(o.gravityScale ?? 1);
    if (o.velocity) bd.setLinvel(o.velocity.x, o.velocity.y, o.velocity.z);
    if (o.angularVelocity) bd.setAngvel({ x: o.angularVelocity.x, y: o.angularVelocity.y, z: o.angularVelocity.z });
    const body = this.world.createRigidBody(bd);
    let cd: RAPIER.ColliderDesc | null = null;
    switch (o.shape) {
      case 'box': { const h = o.halfExtents ?? new THREE.Vector3(0.1, 0.1, 0.1); cd = R.ColliderDesc.cuboid(h.x, h.y, h.z); break; }
      case 'sphere': cd = R.ColliderDesc.ball(o.radius ?? 0.1); break;
      case 'capsule': cd = R.ColliderDesc.capsule(o.halfHeight ?? 0.1, o.radius ?? 0.1); break;
      case 'cylinder': cd = R.ColliderDesc.cylinder(o.halfHeight ?? 0.1, o.radius ?? 0.1); break;
      case 'convex': cd = o.points ? R.ColliderDesc.convexHull(o.points) : null; break;
    }
    if (!cd) cd = R.ColliderDesc.ball(o.radius ?? 0.1);
    if (o.colliderOffset) cd.setTranslation(o.colliderOffset.x, o.colliderOffset.y, o.colliderOffset.z);
    cd.setFriction(o.friction ?? 0.6).setRestitution(o.restitution ?? (kind === 'debris' ? 0.35 : 0.2));
    if (o.mass !== undefined) cd.setMass(o.mass);
    else if (o.density !== undefined) cd.setDensity(o.density);
    cd.setCollisionGroups(kind === 'debris' ? GROUPS.debris : kind === 'prop' ? GROUPS.prop : GROUPS.ragdoll);
    const collider = this.world.createCollider(cd, body);
    this.info.register(collider, o.object ?? null, o.surface ?? (kind === 'ragdoll' ? 'flesh' : 'metal'));
    this.markDirty();

    const self = this;
    const pos = new THREE.Vector3().copy(o.position);
    const quat = new THREE.Quaternion().copy(q);
    const b: Internal = {
      body, collider, object: o.object ?? null, kind, age: 0, alive: true, userData: o.userData,
      position: pos, quaternion: quat,
      lifetime: o.lifetime ?? Infinity,
      prevPos: pos.clone(), prevQuat: quat.clone(), currPos: pos.clone(), currQuat: quat.clone(),
      prevVel: o.velocity?.clone() ?? new THREE.Vector3(),
      impactCooldown: 0, minImpact: o.minImpactSpeed ?? 1,
      onImpact: o.onImpact, onRemove: o.onRemove, sleepingSynced: false,
      applyImpulse(imp, at) {
        if (!b.alive) return;
        if (at) body.applyImpulseAtPoint({ x: imp.x, y: imp.y, z: imp.z }, { x: at.x, y: at.y, z: at.z }, true);
        else body.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
        b.sleepingSynced = false;
      },
      setVelocity(v) { if (b.alive) { body.setLinvel({ x: v.x, y: v.y, z: v.z }, true); b.sleepingSynced = false; } },
      remove() { self.remove(b); },
    };
    if (b.object) { b.object.position.copy(pos); b.object.quaternion.copy(quat); }
    this.list.push(b);
    if (kind === 'debris') {
      this.debrisCount++;
      if (this.debrisCount > this.maxDebris) {
        const oldest = this.list.find((x) => x.kind === 'debris' && x.alive);
        if (oldest) this.remove(oldest);
      }
    }
    return b;
  }

  remove(b: DynamicBody): void {
    const i = b as Internal;
    if (!i.alive) return;
    i.alive = false;
    if (i.kind === 'debris') this.debrisCount--;
    this.info.unregister(i.collider);
    this.world.removeRigidBody(i.body);
    const idx = this.list.indexOf(i);
    if (idx >= 0) this.list.splice(idx, 1);
    if (i.onRemove) i.onRemove(i);
    else if (i.object?.parent) i.object.parent.remove(i.object);
  }

  /** Before each fixed substep: remember previous transform & velocity. */
  preStep(): void {
    for (const b of this.list) {
      if (b.body.isSleeping()) continue;
      b.prevPos.copy(b.currPos);
      b.prevQuat.copy(b.currQuat);
      const v = b.body.linvel();
      b.prevVel.set(v.x, v.y, v.z);
    }
  }

  /** After each fixed substep. */
  postStep(dt: number): void {
    const tmp = new THREE.Vector3();
    for (let k = this.list.length - 1; k >= 0; k--) {
      const b = this.list[k];
      b.age += dt;
      if (b.age >= b.lifetime) { this.remove(b); continue; }
      if (b.body.isSleeping()) continue;
      const t = b.body.translation(), r = b.body.rotation();
      b.currPos.set(t.x, t.y, t.z);
      b.currQuat.set(r.x, r.y, r.z, r.w);
      if (b.currPos.y < -200) { this.remove(b); continue; }
      b.impactCooldown -= dt;
      if (b.onImpact && b.impactCooldown <= 0) {
        const v = b.body.linvel();
        tmp.set(v.x, v.y, v.z).sub(b.prevVel);
        // a sudden velocity change larger than gravity alone could cause = impact
        const dv = tmp.length() - 9.81 * dt * 1.5;
        if (dv >= b.minImpact) {
          let other: RAPIER.Collider | null = null;
          this.world.contactPairsWith(b.collider, (c2) => { if (!other) other = c2; });
          if (other) {
            b.impactCooldown = 0.06;
            b.onImpact({ speed: dv, position: b.currPos.clone(), surface: this.info.surfaceOfCollider(other), other });
          }
        }
      }
    }
  }

  /** Interpolate render transforms: alpha in [0,1] between previous and current fixed step. */
  sync(alpha: number): void {
    for (const b of this.list) {
      const sleeping = b.body.isSleeping();
      if (sleeping && b.sleepingSynced) continue;
      b.sleepingSynced = sleeping;
      const a = sleeping ? 1 : alpha;
      b.position.copy(b.prevPos).lerp(b.currPos, a);
      b.quaternion.copy(b.prevQuat).slerp(b.currQuat, a);
      if (b.object) { b.object.position.copy(b.position); b.object.quaternion.copy(b.quaternion); }
    }
  }

  explosion(center: THREE.Vector3, radius: number, strength: number): void {
    const d = new THREE.Vector3();
    for (const b of this.list) {
      d.copy(b.currPos).sub(center);
      const dist = d.length();
      if (dist > radius) continue;
      const f = strength * (1 - dist / radius) * b.body.mass();
      d.normalize(); d.y += 0.35; d.normalize().multiplyScalar(f);
      b.body.applyImpulse({ x: d.x, y: d.y, z: d.z }, true);
      b.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * f * 0.05, y: (Math.random() - 0.5) * f * 0.05, z: (Math.random() - 0.5) * f * 0.05 }, true);
      b.sleepingSynced = false;
    }
  }
}

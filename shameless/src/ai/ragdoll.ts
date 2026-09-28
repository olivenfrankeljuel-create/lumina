/**
 * Rapier ragdoll for the soldier rig: 15 bodies (pelvis, abdomen, chest, head, upper/lower arms, thighs,
 * calves, feet) joined with spherical joints (spine, neck, shoulders, hips, ankles) and limited revolute hinges
 * (elbows, knees). Bodies are created from the current animated pose and inherit its velocity; the killing
 * shot adds an impulse at the hit point. Bodies drive the bones every frame; undriven bones (clavicles,
 * twist, hands, toes) keep their last local rotation.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext } from '../core/types';
import { physicsExt } from '../physics';
import type { DynamicBody } from '../physics/dynamics';
import { ARM, B, BONE_COUNT, PARENT, REST } from './rig';
import { basisMap } from './pose';

const restPos = REST.map((p) => new THREE.Vector3(...p));
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

interface PartDef {
  bone: number;
  /** end bone (defines the axis) or null for box/sphere parts */
  end: number | null;
  shape: 'capsule' | 'box' | 'sphere';
  radius?: number;
  half?: [number, number, number];
  /** centre offset in bone frame (rest axes) for box/sphere */
  center?: [number, number, number];
  mass: number;
  /** rest hinge / side axis (bone frame) */
  side: THREE.Vector3;
  extra?: number; // capsule extension past the end bone (hands, feet)
}

const armSide = (s: 1 | -1) => {
  const S = restPos[s === 1 ? B.uarmL : B.uarmR], E = restPos[s === 1 ? B.farmL : B.farmR], W = restPos[s === 1 ? B.handL : B.handR];
  const u = W.clone().sub(S).normalize();
  const pole = E.clone().sub(S).addScaledVector(u, -E.clone().sub(S).dot(u)).normalize();
  return new THREE.Vector3().crossVectors(pole, u).normalize();
};

const PARTS: PartDef[] = [
  { bone: B.hips, end: null, shape: 'box', half: [0.15, 0.09, 0.1], center: [0, 0.0, -0.01], mass: 12, side: X },
  { bone: B.spine, end: null, shape: 'box', half: [0.14, 0.1, 0.1], center: [0, 0.1, 0.0], mass: 10, side: X },
  { bone: B.spine2, end: null, shape: 'box', half: [0.16, 0.13, 0.11], center: [0, 0.09, 0.0], mass: 17, side: X },
  { bone: B.head, end: null, shape: 'sphere', radius: 0.105, center: [0, 0.095, 0.01], mass: 5, side: X },
  { bone: B.uarmL, end: B.farmL, shape: 'capsule', radius: 0.052, mass: 2.4, side: armSide(1) },
  { bone: B.farmL, end: B.handL, shape: 'capsule', radius: 0.042, mass: 2.0, side: armSide(1), extra: 0.1 },
  { bone: B.uarmR, end: B.farmR, shape: 'capsule', radius: 0.052, mass: 2.4, side: armSide(-1) },
  { bone: B.farmR, end: B.handR, shape: 'capsule', radius: 0.042, mass: 2.0, side: armSide(-1), extra: 0.1 },
  { bone: B.thighL, end: B.calfL, shape: 'capsule', radius: 0.075, mass: 9, side: X },
  { bone: B.calfL, end: B.footL, shape: 'capsule', radius: 0.055, mass: 4.5, side: X },
  { bone: B.footL, end: null, shape: 'box', half: [0.05, 0.045, 0.12], center: [0, -0.04, 0.06], mass: 1.2, side: X },
  { bone: B.thighR, end: B.calfR, shape: 'capsule', radius: 0.075, mass: 9, side: X },
  { bone: B.calfR, end: B.footR, shape: 'capsule', radius: 0.055, mass: 4.5, side: X },
  { bone: B.footR, end: null, shape: 'box', half: [0.05, 0.045, 0.12], center: [0, -0.04, 0.06], mass: 1.2, side: X },
];

/** [parentPartIndex, childPartIndex, joint bone (pivot at its origin), type] */
const JOINTS: [number, number, number, 'spherical' | 'revolute'][] = [
  [0, 1, B.spine, 'spherical'],
  [1, 2, B.spine2, 'spherical'],
  [2, 3, B.neck, 'spherical'],
  [2, 4, B.uarmL, 'spherical'],
  [4, 5, B.farmL, 'revolute'],
  [2, 6, B.uarmR, 'spherical'],
  [6, 7, B.farmR, 'revolute'],
  [0, 8, B.thighL, 'spherical'],
  [8, 9, B.calfL, 'revolute'],
  [9, 10, B.footL, 'spherical'],
  [0, 11, B.thighR, 'spherical'],
  [11, 12, B.calfR, 'revolute'],
  [12, 13, B.footR, 'spherical'],
];

/** Bones driven by each part (first = the part's own bone). */
const DRIVES: number[][] = [[B.hips], [B.spine, B.spine1], [B.spine2], [B.neck, B.head], [B.uarmL], [B.farmL, B.twistL], [B.uarmR], [B.farmR, B.twistR], [B.thighL], [B.calfL], [B.footL], [B.thighR], [B.calfR], [B.footR]];

// per-part alignment: body frame (Y along bone, X = hinge) expressed in the bone frame
const ALIGN = PARTS.map((p) => {
  if (p.end === null) return new THREE.Quaternion();
  const dir = restPos[p.end].clone().sub(restPos[p.bone]).normalize();
  return basisMap(Y, X, dir, p.side);
});
const PART_LEN = PARTS.map((p) => (p.end === null ? 0 : restPos[p.end].distanceTo(restPos[p.bone]) + (p.extra ?? 0)));

export class Ragdoll {
  readonly bodies: DynamicBody[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  private localRest: THREE.Quaternion[] = [];
  private driven = new Set<number>();
  alive = true;
  age = 0;

  /**
   * @param modelRot/modelPos pose (model space) at the moment of death
   * @param root     character root (world), scale uniform model scale
   * @param vel      current linear velocity of the character (world)
   */
  constructor(
    private ctx: GameContext,
    modelRot: readonly THREE.Quaternion[],
    modelPos: readonly THREE.Vector3[],
    private root: THREE.Object3D,
    private scale: number,
    vel: THREE.Vector3,
  ) {
    const phys = physicsExt(ctx.physics);
    for (let i = 0; i < BONE_COUNT; i++) {
      const p = PARENT[i];
      this.localRest.push(p < 0 ? modelRot[i].clone() : modelRot[p].clone().invert().multiply(modelRot[i]));
    }
    const rq = root.quaternion, rp = root.position;
    const wq = new THREE.Quaternion(), wp = new THREE.Vector3();
    PARTS.forEach((part, k) => {
      DRIVES[k].forEach((b) => this.driven.add(b));
      wq.copy(rq).multiply(modelRot[part.bone]).multiply(ALIGN[k]);
      const bonePosW = wp.copy(modelPos[part.bone]).multiplyScalar(this.scale).applyQuaternion(rq).add(rp);
      let center: THREE.Vector3;
      const s = this.scale;
      if (part.end !== null) center = new THREE.Vector3(0, (PART_LEN[k] * s) / 2, 0).applyQuaternion(wq).add(bonePosW);
      else center = new THREE.Vector3(...(part.center ?? [0, 0, 0])).multiplyScalar(s).applyQuaternion(_q.copy(rq).multiply(modelRot[part.bone])).add(bonePosW);
      const opts = {
        position: center, quaternion: wq.clone(), velocity: vel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3)),
        mass: part.mass, friction: 0.9, restitution: 0.05, linearDamping: 0.15, angularDamping: 1.6, kind: 'ragdoll' as const, ccd: k === 3 || k >= 4,
        surface: 'flesh' as const,
      };
      let body: DynamicBody;
      if (part.shape === 'capsule') body = phys.spawnDynamic({ ...opts, shape: 'capsule', radius: part.radius! * s, halfHeight: Math.max(0.01, (PART_LEN[k] * s) / 2 - part.radius! * s * 0.7) });
      else if (part.shape === 'sphere') body = phys.spawnDynamic({ ...opts, shape: 'sphere', radius: part.radius! * s });
      else body = phys.spawnDynamic({ ...opts, shape: 'box', halfExtents: new THREE.Vector3(...part.half!).multiplyScalar(s) });
      this.bodies.push(body);
    });
    // joints at the pivot bone origin
    for (const [a, b, pivotBone, type] of JOINTS) {
      const A = this.bodies[a], Bb = this.bodies[b];
      const pw = new THREE.Vector3().copy(modelPos[pivotBone]).multiplyScalar(this.scale).applyQuaternion(rq).add(rp);
      const anchorA = pw.clone().sub(A.body.translation() as THREE.Vector3).applyQuaternion(_q.copy(A.body.rotation() as THREE.Quaternion).invert());
      const anchorB = pw.clone().sub(Bb.body.translation() as THREE.Vector3).applyQuaternion(_q.copy(Bb.body.rotation() as THREE.Quaternion).invert());
      if (type === 'revolute') {
        // hinge: local X of both bodies; limit to one-sided flexion (sign from the rest bend direction)
        const knee = pivotBone === B.calfL || pivotBone === B.calfR;
        const lim: [number, number] = knee ? [-2.4, 0.05] : [-2.5, 0.05];
        this.joints.push(phys.createJoint(A, Bb, { type: 'revolute', anchorA, anchorB, axis: X, limits: lim }));
      } else {
        this.joints.push(phys.createJoint(A, Bb, { type: 'spherical', anchorA, anchorB }));
      }
    }
  }

  /** Impulse at a world point (killing shot / explosion). Applied to the closest body. */
  impulse(point: THREE.Vector3, impulse: THREE.Vector3) {
    let best = this.bodies[2], bd = Infinity;
    for (const b of this.bodies) {
      const t = b.body.translation();
      const d = (t.x - point.x) ** 2 + (t.y - point.y) ** 2 + (t.z - point.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    best.applyImpulse(impulse, point);
    // a share to the torso so the whole body reacts
    this.bodies[2].applyImpulse(impulse.clone().multiplyScalar(0.35));
    this.bodies[0].applyImpulse(impulse.clone().multiplyScalar(0.2));
  }

  /** Write body transforms into model-space rotations/positions (then Animator.apply-style write). */
  sync(modelRot: THREE.Quaternion[], modelPos: THREE.Vector3[]) {
    const invRoot = _q2.copy(this.root.quaternion).invert();
    // driven bones
    const bodyQ: THREE.Quaternion[] = [];
    this.bodies.forEach((b, k) => {
      const q = new THREE.Quaternion().copy(b.quaternion);
      bodyQ.push(q);
      const boneModel = _q3.copy(invRoot).multiply(q).multiply(_q4.copy(ALIGN[k]).invert());
      modelRot[PARTS[k].bone].copy(boneModel);
    });
    // pelvis position from the hips body
    const hipsPart = PARTS[0];
    const c = _v1.copy(this.bodies[0].position);
    const off = _v2.set(...(hipsPart.center as [number, number, number])).multiplyScalar(this.scale).applyQuaternion(_q3.copy(this.root.quaternion).multiply(modelRot[B.hips]));
    modelPos[B.hips].copy(c.sub(off)).sub(this.root.position).applyQuaternion(invRoot).divideScalar(this.scale);
    // secondary driven bones
    modelRot[B.spine1].copy(modelRot[B.spine]);
    modelRot[B.neck].copy(modelRot[B.spine2]).slerp(modelRot[B.head], 0.5);
    modelRot[B.twistL].copy(modelRot[B.farmL]);
    modelRot[B.twistR].copy(modelRot[B.farmR]);
    // everything else: keep its local rotation relative to the parent
    for (let i = 1; i < BONE_COUNT; i++) {
      if (this.driven.has(i) || i === B.spine1 || i === B.neck || i === B.twistL || i === B.twistR) continue;
      modelRot[i].copy(modelRot[PARENT[i]]).multiply(this.localRest[i]);
    }
    // positions by FK (only hips needed for apply, but callers may want world bones)
    for (let i = 2; i < BONE_COUNT; i++) {
      const p = PARENT[i];
      modelPos[i].copy(restPos[i]).sub(restPos[p]).applyQuaternion(modelRot[p]).add(modelPos[p]);
    }
  }

  /** Average speed of the bodies (for settle detection). */
  speed(): number {
    let s = 0;
    for (const b of this.bodies) { const v = b.body.linvel(); s += Math.hypot(v.x, v.y, v.z); }
    return s / this.bodies.length;
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    const w = this.ctx.physics.world;
    for (const j of this.joints) { try { w.removeImpulseJoint(j, true); } catch { /* body removal also removes joints */ } }
    for (const b of this.bodies) b.remove();
  }
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
void ARM;

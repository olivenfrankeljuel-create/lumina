/**
 * Procedural animation for the soldier rig. Everything is solved in model space (the `scaled` group of the
 * character; +Z forward, +X = character's left) and converted to local bone quaternions at the end.
 *
 * Layers, in order:
 *   locomotion  — gait phase, stride-matched foot trajectories (no sliding), idle foot planting with
 *                 turn-in-place re-stepping, pelvis bob/sway/twist, crouch, foot IK to ground height
 *   upper body  — aim twist/pitch distributed over the spine, lean (cover peek), breathing, hit flinch
 *   weapon      — rifle placed from the chest (low ready / shouldered aim / sprint carry blend), recoil,
 *                 keyframed reload (left hand + magazine path)
 *   arms        — two-bone IK to the rifle grip and handguard with elbow poles and forearm twist
 *   head        — look-at with cheek weld when aiming
 */
import * as THREE from 'three';
import { ARM, B, BONE_COUNT, PARENT, REST } from './rig';
import { RIFLE } from './rifle';
import { restHandFrame } from './character';

const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const sstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (cur: number, target: number, rate: number, dt: number) => lerp(cur, target, 1 - Math.exp(-rate * dt));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const restPos = REST.map((p) => new THREE.Vector3(...p));
const restOff = restPos.map((p, i) => (PARENT[i] < 0 ? p.clone() : p.clone().sub(restPos[PARENT[i]])));

/** Rotation taking frame (a0,b0) onto (a1,b1) — a is primary, b is orthogonalised against a. */
export function basisMap(a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, out = Q()): THREE.Quaternion {
  const m0 = _frame(a0, b0, _m0), m1 = _frame(a1, b1, _m1);
  m0.transpose();
  _m2.multiplyMatrices(m1, m0);
  return out.setFromRotationMatrix(_m2);
}
const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _fa = V(), _fb = V(), _fc = V();
function _frame(a: THREE.Vector3, b: THREE.Vector3, m: THREE.Matrix4) {
  _fa.copy(a).normalize();
  _fb.copy(b).addScaledVector(_fa, -b.dot(_fa));
  if (_fb.lengthSq() < 1e-8) _fb.copy(Math.abs(_fa.y) < 0.9 ? Y : X).addScaledVector(_fa, -(Math.abs(_fa.y) < 0.9 ? _fa.y : _fa.x));
  _fb.normalize();
  _fc.crossVectors(_fa, _fb);
  return m.makeBasis(_fa, _fb, _fc);
}

const eulerQ = (y: number, x: number, z: number, out = Q()) => out.setFromEuler(_e.set(x, y, z, 'YXZ'));
const _e = new THREE.Euler();

/** Look rotation: +Z along fwd, +Y as close to up as possible. */
function lookRot(fwd: THREE.Vector3, up: THREE.Vector3, out = Q()) {
  const z = _la.copy(fwd).normalize();
  const x = _lb.crossVectors(up, z);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = _lc.crossVectors(z, x);
  _m0.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m0);
}
const _la = V(), _lb = V(), _lc = V();

/** Solve a two-bone chain; returns elbow/knee position (end clamped to reach). */
function twoBone(S: THREE.Vector3, a: number, b: number, T: THREE.Vector3, pole: THREE.Vector3, outE: THREE.Vector3, outT: THREE.Vector3) {
  const d = _t1.subVectors(T, S);
  let len = d.length();
  const maxL = (a + b) * 0.9995, minL = Math.abs(a - b) + 1e-3;
  const dir = d.normalize();
  len = clamp(len, minL, maxL);
  outT.copy(S).addScaledVector(dir, len);
  const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = _t2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
  perp.normalize();
  outE.copy(S).addScaledVector(dir, cosA * a).addScaledVector(perp, sinA * a);
}
const _t1 = V(), _t2 = V();

// rest frames needed by IK
const THIGH_L = restPos[B.calfL].clone().sub(restPos[B.thighL]).length();
const CALF_L = restPos[B.footL].clone().sub(restPos[B.calfL]).length();
const restThighDir = [B.thighL, B.thighR].map((t) => restPos[t + 1].clone().sub(restPos[t]).normalize());
const restCalfDir = [B.calfL, B.calfR].map((t) => restPos[t + 1].clone().sub(restPos[t]).normalize());
const armRest = [1, -1].map((side) => {
  const o = side === 1 ? 0 : 5;
  const S = restPos[B.uarmL + o], E = restPos[B.farmL + o], W = restPos[B.handL + o];
  const u = W.clone().sub(S).normalize();
  const pole = E.clone().sub(S).addScaledVector(u, -E.clone().sub(S).dot(u)).normalize();
  const uaDir = E.clone().sub(S).normalize(), faDir = W.clone().sub(E).normalize();
  const side_ = V().crossVectors(pole, u).normalize();
  const hf = restHandFrame(side as 1 | -1);
  const gripOff = hf.hy.clone().multiplyScalar(0.078).addScaledVector(hf.hn, 0.043);
  return { uaDir, faDir, side: side_, pole, hf, gripOff };
});

// ------------------------------------------------------------------ reload keyframes (left hand)

/** Keyframes: t (0..1 of reload), space ('rifle' | 'chest'), position, grip weight on mag. */
const RELOAD_KEYS: { t: number; sp: 'rifle' | 'chest'; p: [number, number, number]; mag: 0 | 1 }[] = [
  { t: 0.0, sp: 'rifle', p: [0, 0.052, 0.36], mag: 0 },
  { t: 0.12, sp: 'rifle', p: [0.01, -0.03, 0.15], mag: 0 },
  { t: 0.2, sp: 'rifle', p: [0.012, -0.07, 0.17], mag: 1 }, // grab mag
  { t: 0.3, sp: 'rifle', p: [0.03, -0.2, 0.16], mag: 1 }, // strip mag
  { t: 0.42, sp: 'chest', p: [0.03, -0.14, 0.26], mag: 1 }, // stow / grab fresh from pouch
  { t: 0.52, sp: 'chest', p: [0.04, -0.12, 0.24], mag: 1 },
  { t: 0.66, sp: 'rifle', p: [0.02, -0.12, 0.17], mag: 1 },
  { t: 0.74, sp: 'rifle', p: [0.012, -0.068, 0.165], mag: 1 }, // insert, rock in
  { t: 0.8, sp: 'rifle', p: [0.01, -0.05, 0.14], mag: 0 },
  { t: 0.86, sp: 'rifle', p: [-0.045, 0.08, 0.2], mag: 0 }, // over the top to the charging handle
  { t: 0.9, sp: 'rifle', p: [-0.05, 0.085, 0.12], mag: 0 }, // rack
  { t: 1.0, sp: 'rifle', p: [0, 0.052, 0.36], mag: 0 },
];

export interface FootState { plant: THREE.Vector3; yaw: number; stepT: number; from: THREE.Vector3; fromYaw: number; to: THREE.Vector3; toYaw: number; wasStance: boolean }

export class Animator {
  // ---- inputs (set by the brain every frame)
  aimDir = new THREE.Vector3(0, 0, 1); // world
  aim = 0; // 0 low ready .. 1 shouldered
  carry = 0; // sprint / patrol carry
  crouch = 0;
  lean = 0; // -1 left .. +1 right (character's right)
  /** Extra "alert" stance tension 0..1 (tighter stance, weapon closer). */
  tension = 0;

  // ---- outputs
  readonly modelRot: THREE.Quaternion[] = Array.from({ length: BONE_COUNT }, Q);
  readonly modelPos: THREE.Vector3[] = Array.from({ length: BONE_COUNT }, V);
  readonly riflePos = V();
  readonly rifleRot = Q();
  readonly magPos = V();
  readonly magRot = Q();
  magAttached = true;
  /** Fires when a foot plants (world position) */
  onFootstep: ((side: 0 | 1, pos: THREE.Vector3) => void) | null = null;

  // ---- internal state
  phase = 0;
  private sAim = 0; private sCarry = 0; private sCrouch = 0; private sLean = 0; private sMove = 0; private sRun = 0;
  private sHipYaw = 0; private sAimYaw = 0; private sAimPitch = 0;
  private speed = 0;
  private moveDir = V().set(0, 0, 1);
  private recoil = 0; private recoilV = 0;
  private hitAxis = V().set(1, 0, 0); private hit = 0; private hitV = 0;
  private reloadT = -1; private reloadDur = 2.4;
  private breath = Math.random() * 10;
  private time = Math.random() * 100;
  feet: FootState[] = [0, 1].map(() => ({ plant: V(), yaw: 0, stepT: -1, from: V(), fromYaw: 0, to: V(), toYaw: 0, wasStance: true }));
  private initialized = false;
  /** Freeze time advance (dev: hold a pose). */
  frozen = false;
  dbg: Record<string, number> = {};

  fire(kick = 1) { this.recoilV += 9 * kick; }
  hitReact(dirWorld: THREE.Vector3, rootQuat: THREE.Quaternion, strength: number) {
    const d = _v1.copy(dirWorld).setY(0).normalize().applyQuaternion(_q1.copy(rootQuat).invert());
    this.hitAxis.crossVectors(Y, d).normalize();
    this.hitV += 6 * strength;
  }
  startReload(dur = 2.4) { if (this.reloadT < 0) { this.reloadT = 0; this.reloadDur = dur; } }
  get reloading() { return this.reloadT >= 0; }

  /**
   * @param root   world placement group (position = feet, quaternion = body yaw), updated
   * @param scale  uniform model scale
   * @param vel    world velocity (m/s)
   * @param ground world ground height query
   */
  update(dt: number, root: THREE.Object3D, scale: number, vel: THREE.Vector3, ground: (x: number, z: number) => number | null) {
    dt = this.frozen || !(dt > 0) ? 0 : Math.min(dt, 0.1);
    this.time += dt;
    this.breath += dt;
    const invRoot = _q2.copy(root.quaternion).invert();
    // ---------------------------------------------------------------- smoothed params
    const lv = _v2.copy(vel).setY(0).applyQuaternion(invRoot).divideScalar(scale);
    const spd = lv.length();
    this.speed = damp(this.speed, spd, 8, dt);
    if (spd > 0.05) this.moveDir.lerp(lv.normalize(), 1 - Math.exp(-10 * dt)).normalize();
    this.sMove = damp(this.sMove, sstep(0.08, 0.7, this.speed), 6, dt);
    this.sRun = damp(this.sRun, sstep(2.0, 4.0, this.speed), 4, dt);
    this.sAim = damp(this.sAim, this.aim, 7, dt);
    this.sCarry = damp(this.sCarry, this.carry, 5, dt);
    this.sCrouch = damp(this.sCrouch, this.crouch, 5, dt);
    this.sLean = damp(this.sLean, this.lean, 6, dt);
    const aimL = _v3.copy(this.aimDir).applyQuaternion(invRoot).normalize();
    this.sAimYaw = damp(this.sAimYaw, clamp(Math.atan2(aimL.x, aimL.z), -1.6, 1.6), 10, dt);
    this.sAimPitch = damp(this.sAimPitch, clamp(Math.asin(clamp(aimL.y, -1, 1)), -1.1, 1.1), 10, dt);
    // springs
    this.recoilV += (-220 * this.recoil - 22 * this.recoilV) * dt; this.recoil += this.recoilV * dt;
    this.hitV += (-90 * this.hit - 9 * this.hitV) * dt; this.hit += this.hitV * dt;
    if (this.reloadT >= 0) { this.reloadT += dt / this.reloadDur; if (this.reloadT >= 1) this.reloadT = -1; }

    const move = this.sMove, run = this.sRun, crouch = this.sCrouch;
    // ---------------------------------------------------------------- gait
    const T = lerp(lerp(1.1, 0.7, run), 1.3, crouch * (1 - run));
    if (this.speed > 0.05) this.phase = (this.phase + dt / T) % 1;
    const L = this.speed * T;
    const beta = lerp(0.6, 0.37, run);
    const m = this.moveDir;
    // hips follow move direction partially (strafe/backpedal)
    let mAng = Math.atan2(m.x, m.z);
    if (mAng > Math.PI / 2 + 0.2) mAng -= Math.PI; else if (mAng < -Math.PI / 2 - 0.2) mAng += Math.PI;
    const stanceBlade = (1 - move) * lerp(0.35, 0.2, crouch) * (0.4 + 0.6 * this.sAim);
    const hipYawT = clamp(mAng * 0.45, -0.7, 0.7) * move - stanceBlade + this.sAimYaw * 0.35 * (1 - move);
    this.sHipYaw = damp(this.sHipYaw, hipYawT, 6, dt);

    // world helpers
    root.updateMatrixWorld();
    const toWorld = (p: THREE.Vector3, out: THREE.Vector3) => out.copy(p).multiplyScalar(scale).applyQuaternion(root.quaternion).add(root.position);
    const toModel = (p: THREE.Vector3, out: THREE.Vector3) => out.copy(p).sub(root.position).applyQuaternion(invRoot).divideScalar(scale);
    const gy = (x: number, z: number) => ground(x, z) ?? root.position.y;
    const rootYaw = 2 * Math.atan2(root.quaternion.y, root.quaternion.w);

    const footTargets: THREE.Vector3[] = [V(), V()];
    const footYaw = [0, 0], footPitch = [0, 0], toeBend = [0, 0];
    for (let f = 0; f < 2; f++) {
      const side = f === 0 ? 1 : -1;
      // idle base stance (combat blade: left foot forward)
      const base = _v4.set(side * lerp(0.115, 0.14, crouch), 0, f === 0 ? lerp(0.07, 0.2, crouch) : lerp(-0.1, -0.2, crouch));
      base.x += Math.sin(this.sHipYaw) * base.z * 0.0;
      const baseYaw = f === 0 ? 0.18 : -0.42 + this.sHipYaw * 0.3;
      // gait target (model)
      const psi = (this.phase + f * 0.5) % 1;
      let along = 0, lift = 0, pitch = 0;
      const Lh = L * beta;
      if (psi < beta) {
        const s = psi / beta;
        along = Lh * (0.5 - s);
        pitch = s > 0.7 ? -((s - 0.7) / 0.3) * 0.5 : 0; // heel rise before toe-off (toe down => +pitch)... negative here means heel up
      } else {
        const s = (psi - beta) / (1 - beta);
        const e = s * s * s * (s * (s * 6 - 15) + 10);
        along = Lh * (-0.5 + e);
        lift = lerp(0.085, 0.2, run) * Math.pow(Math.sin(Math.PI * Math.pow(s, 0.85)), 1) * (1 - 0.3 * crouch);
        pitch = s < 0.35 ? lerp(0.6, 0, s / 0.35) : s > 0.75 ? -lerp(0, 0.35, (s - 0.75) / 0.25) : 0;
        pitch = -pitch; // toe-down during toe-off, toe-up at heel strike
      }
      const gaitBase = _v5.set(side * lerp(0.1, 0.075, run), 0, 0);
      const gaitYaw = clamp(mAng * 0.45, -0.7, 0.7) + side * 0.06;
      const gait = _v6.copy(gaitBase).addScaledVector(m, along);
      // world positions for both modes
      const gW = toWorld(gait, V());
      const bW = toWorld(base, V());
      // idle planting
      const fs = this.feet[f];
      const idleYawW = rootYaw + baseYaw;
      if (!this.initialized) { fs.plant.copy(bW); fs.yaw = idleYawW; }
      if (move < 0.5) {
        if (fs.stepT < 0) {
          const other = this.feet[1 - f];
          const err = Math.hypot(fs.plant.x - bW.x, fs.plant.z - bW.z);
          const yerr = Math.abs(wrap(fs.yaw - idleYawW));
          if ((err > 0.17 || yerr > 0.55) && other.stepT < 0 && (f === 0 || err > 0.22 || yerr > 0.7)) {
            fs.stepT = 0; fs.from.copy(fs.plant); fs.fromYaw = fs.yaw;
          }
        }
        if (fs.stepT >= 0) {
          fs.stepT += dt / 0.3;
          const s = Math.min(1, fs.stepT);
          const e = s * s * (3 - 2 * s);
          fs.plant.lerpVectors(fs.from, bW, e);
          fs.yaw = fs.fromYaw + wrap(idleYawW - fs.fromYaw) * e;
          fs.plant.y = Math.sin(Math.PI * s) * 0.06;
          if (fs.stepT >= 1) { fs.stepT = -1; fs.plant.y = 0; this.onFootstep?.(f as 0 | 1, fs.plant); }
        }
      } else {
        fs.plant.copy(gW); fs.plant.y = 0; fs.yaw = rootYaw + gaitYaw; fs.stepT = -1;
      }
      // footstep events from gait
      const stance = psi < beta;
      if (stance && !fs.wasStance && move > 0.4) this.onFootstep?.(f as 0 | 1, gW);
      fs.wasStance = stance;
      // blend idle plant vs gait (world), then back to model
      const idleM = toModel(_v7.copy(fs.plant).setY(0), V());
      idleM.y = fs.plant.y / scale;
      const tgt = footTargets[f].copy(idleM).lerp(_v8.copy(gait).setY(lift), move);
      // ground
      const w = toWorld(tgt, _v9);
      const g = gy(w.x, w.z);
      tgt.y += (g - root.position.y) / scale;
      footYaw[f] = lerp(wrap(fs.yaw - rootYaw), gaitYaw, move);
      footPitch[f] = pitch * move;
      // crouch: back foot on the ball of the foot
      if (f === 1) { footPitch[f] += 0.55 * crouch * (1 - move); toeBend[f] = -0.55 * crouch * (1 - move); }
      if (pitch * move > 0) toeBend[f] += -pitch * move * 0.9;
    }
    this.initialized = true;

    // ---------------------------------------------------------------- pelvis
    const R = this.modelRot, P = this.modelPos;
    const walkBob = -0.022 * Math.cos(4 * Math.PI * this.phase);
    const runBob = -0.04 * Math.cos(4 * Math.PI * (this.phase - beta * 0.5) + Math.PI);
    const bob = lerp(walkBob, runBob, run) * move;
    const breathe = Math.sin(this.breath * 1.6);
    const hips = P[B.hips].copy(restPos[B.hips]);
    hips.y += bob - crouch * 0.37 - 0.012 * (1 - move) * this.sAim - Math.abs(this.sLean) * 0.03;
    hips.x += 0.022 * Math.cos(2 * Math.PI * this.phase) * move * (1 - run) + (1 - move) * (0.015 * Math.sin(this.time * 0.35));
    hips.z += -0.03 * crouch * (1 - move) + run * 0.02;
    // lean shifts the pelvis sideways (peeking)
    hips.x += -this.sLean * 0.1;
    const twist = 0.13 * Math.sin(2 * Math.PI * this.phase) * move * (1 - 0.3 * run);
    const tilt = 0.06 * move + 0.14 * run + crouch * 0.42 + 0.05 * this.sAim * (1 - move);
    const roll = 0.045 * Math.sin(2 * Math.PI * this.phase) * move * (1 - run) + this.sLean * 0.08;
    eulerQ(this.sHipYaw + twist, tilt, roll, R[B.hips]);

    // keep feet reachable: lower pelvis if needed
    let drop = 0;
    for (let f = 0; f < 2; f++) {
      const hj = _v1.copy(restOff[f === 0 ? B.thighL : B.thighR]).applyQuaternion(R[B.hips]).add(hips);
      const ank = footTargets[f];
      const hd = Math.hypot(hj.x - ank.x, hj.z - ank.z);
      const Lmax = (THIGH_L + CALF_L) * 0.985;
      const allowed = Math.sqrt(Math.max(0.01, Lmax * Lmax - hd * hd));
      const need = hj.y - (ank.y + 0.088) - allowed;
      if (need > drop) drop = need;
    }
    hips.y -= drop;

    // ---------------------------------------------------------------- spine
    const upperYaw = this.sAimYaw - this.sHipYaw - twist;
    this.dbg = { aimYaw: this.sAimYaw, hipYaw: this.sHipYaw, twist, upperYaw, pitch: this.sAimPitch, tilt, counterTilt: 0 };
    const pitchUp = -this.sAimPitch * (0.45 + 0.2 * this.sAim);
    const lean = this.sLean * 0.42;
    const counterTilt = -(tilt - 0.06 * move - 0.12 * run) * 0.75; // stay upright when crouching
    const breathP = breathe * 0.012 * (1 - run);
    const hitQ = _q3.setFromAxisAngle(this.hitAxis, clamp(this.hit, -0.6, 0.6));
    eulerQ(upperYaw * 0.25, counterTilt * 0.4 + pitchUp * 0.2 + run * 0.05, lean * 0.3 - roll * 0.6, _q4); R[B.spine].multiplyQuaternions(R[B.hips], _q4);
    eulerQ(upperYaw * 0.35, counterTilt * 0.3 + pitchUp * 0.3, lean * 0.35, _q4); R[B.spine1].multiplyQuaternions(R[B.spine], _q4);
    R[B.spine1].premultiply(_q5.slerpQuaternions(_qI, hitQ, 0.5));
    eulerQ(upperYaw * 0.4, counterTilt * 0.3 + pitchUp * 0.5 + breathP, lean * 0.35, _q4); R[B.spine2].multiplyQuaternions(R[B.spine1], _q4);
    R[B.spine2].premultiply(_q5.slerpQuaternions(_qI, hitQ, 0.6));

    // FK positions for the core
    const fk = (i: number) => P[i].copy(restOff[i]).applyQuaternion(R[PARENT[i]]).add(P[PARENT[i]]);
    P[B.root].set(0, 0, 0); R[B.root].identity();
    fk(B.spine); fk(B.spine1); fk(B.spine2);

    // clavicles: slight forward/up shrug when shouldering
    const shrug = this.sAim * 0.12 + this.sCarry * 0.05;
    eulerQ(-0.18 * this.sAim, 0, 0.03 + shrug * 0.4, _q4); R[B.clavL].multiplyQuaternions(R[B.spine2], _q4);
    eulerQ(0.22 * this.sAim, 0, -0.05 - shrug * 0.6, _q4); R[B.clavR].multiplyQuaternions(R[B.spine2], _q4);
    fk(B.clavL); fk(B.clavR); fk(B.uarmL); fk(B.uarmR); fk(B.neck);

    // ---------------------------------------------------------------- weapon placement
    const chestQ = R[B.spine2], chestP = P[B.spine2];
    const aimFwd = _v1.set(Math.sin(this.sAimYaw) * Math.cos(this.sAimPitch), Math.sin(this.sAimPitch), Math.cos(this.sAimYaw) * Math.cos(this.sAimPitch));
    // shoulder pocket
    const pocket = _v2.set(-0.118, 0.13, 0.1).applyQuaternion(chestQ).add(chestP);
    // aim (shouldered)
    const qAim = lookRot(aimFwd, Y, _qa);
    // cant a touch and breathe
    qAim.multiply(eulerQ(Math.sin(this.time * 0.7) * 0.006, -breathe * 0.004, -0.04, _q4));
    const pAim = _va.copy(RIFLE.butt).applyQuaternion(qAim).negate().add(pocket);
    // low ready: muzzle ~40deg down, slightly inboard; butt stays near the pocket
    const lowFwd = _v3.copy(aimFwd).applyAxisAngle(Y, 0.22);
    const lowRight = _v4.crossVectors(Y, lowFwd).normalize();
    lowFwd.applyAxisAngle(lowRight, 0.72 - this.tension * 0.2).normalize();
    const qLow = lookRot(lowFwd, Y, _qb).multiply(eulerQ(0, 0, -0.18, _q4));
    const pocketLow = _v5.set(-0.11, 0.08, 0.13).applyQuaternion(chestQ).add(chestP);
    const pLow = _vb.copy(RIFLE.butt).applyQuaternion(qLow).negate().add(pocketLow);
    // sprint / patrol carry: across the body, muzzle forward-left-down, held at the right hip
    const carryFwd = _v6.set(0.5, -0.32, 0.8).normalize().applyQuaternion(_q5.setFromAxisAngle(Y, this.sHipYaw * 0.5 + upperYaw * 0.4));
    const qCarry = lookRot(carryFwd, Y, _qc).multiply(eulerQ(0, 0, -0.55, _q4));
    const pCarry = _vc.set(-0.12, 0.93 + hips.y - restPos[B.hips].y + 0.14, 0.2).applyQuaternion(_q5.setFromAxisAngle(Y, this.sHipYaw * 0.5));
    pCarry.x += hips.x; pCarry.z += hips.z;
    // blend
    this.rifleRot.slerpQuaternions(qLow, qAim, this.sAim);
    this.riflePos.lerpVectors(pLow, pAim, this.sAim);
    this.rifleRot.slerp(qCarry, this.sCarry);
    this.riflePos.lerp(pCarry, this.sCarry);
    // reload pose: rifle canted and pulled in
    const rl = this.reloadT >= 0 ? Math.sin(Math.PI * clamp(this.reloadT * 1.15, 0, 1)) : 0;
    if (rl > 0) {
      this.rifleRot.multiply(eulerQ(0.1 * rl, -0.25 * rl, 0.55 * rl, _q4));
      _v7.set(0.02, -0.04, -0.06).applyQuaternion(chestQ);
      this.riflePos.addScaledVector(_v7, rl);
    }
    // recoil
    const rfwd = _v7.copy(Z).applyQuaternion(this.rifleRot);
    this.riflePos.addScaledVector(rfwd, -this.recoil * 0.035);
    this.riflePos.y += this.recoil * 0.006;
    this.rifleRot.multiply(eulerQ(0, -this.recoil * 0.07, 0, _q4));

    // ---------------------------------------------------------------- hands
    const gripW = _v8.copy(RIFLE.grip).applyQuaternion(this.rifleRot).add(this.riflePos);
    const thumbR = _v9.copy(RIFLE.gripAxis).applyQuaternion(this.rifleRot);
    const palmR = _v10.set(0.6, 0, 0.8).applyQuaternion(this.rifleRot);
    const handR = basisMap(armRest[1].hf.ht, armRest[1].hf.hn, thumbR, palmR, _qd);
    // left hand
    let guardW = _v11.copy(RIFLE.handguard);
    let thumbL = _v12.set(0, 0, 1), palmL = _v13.set(-0.45, 0.89, 0);
    let magInHand = false;
    if (this.reloadT >= 0) {
      const t = this.reloadT;
      let k = 0;
      while (k < RELOAD_KEYS.length - 2 && RELOAD_KEYS[k + 1].t < t) k++;
      const a = RELOAD_KEYS[k], b = RELOAD_KEYS[k + 1];
      const u = sstep(0, 1, (t - a.t) / Math.max(1e-3, b.t - a.t));
      const pa = keyPos(a, this.rifleRot, this.riflePos, chestQ, chestP, _v14), pb = keyPos(b, this.rifleRot, this.riflePos, chestQ, chestP, _v15);
      guardW = _v11.lerpVectors(pa, pb, u);
      guardW.applyQuaternion(_q5.copy(this.rifleRot).invert()).sub(_v16.copy(this.riflePos).applyQuaternion(_q5)); // to rifle local
      magInHand = a.mag === 1 && (b.mag === 1 || u < 0.5);
      const w = sstep(0.08, 0.2, t) * (1 - sstep(0.82, 0.97, t));
      thumbL = _v12.set(0, 0, 1).lerp(_v17.set(0.2, -0.2, 0.95), w).normalize();
      palmL = _v13.set(-0.45, 0.89, 0).lerp(_v17.set(-0.9, 0.1, -0.2), w).normalize();
    }
    const guardM = _v18.copy(guardW).applyQuaternion(this.rifleRot).add(this.riflePos);
    const handL = basisMap(armRest[0].hf.ht, armRest[0].hf.hn, thumbL.applyQuaternion(this.rifleRot), palmL.applyQuaternion(this.rifleRot), _qe);
    // magazine
    this.magAttached = !magInHand;
    if (magInHand) {
      this.magRot.copy(handL).multiply(_q5.setFromUnitVectors(Z, Z));
      // mag hangs from the palm: place magwell point slightly above grip centre
      this.magPos.copy(guardM).addScaledVector(_v17.set(0, 1, 0).applyQuaternion(this.rifleRot), 0.075);
      this.magRot.copy(this.rifleRot).multiply(eulerQ(0, 0, 0.3, _q4));
    }

    // ---------------------------------------------------------------- arm IK
    this.solveArm(0, guardM, handL);
    this.solveArm(1, gripW, handR);

    // ---------------------------------------------------------------- legs
    for (let f = 0; f < 2; f++) {
      const t = f === 0 ? B.thighL : B.thighR;
      fk(t);
      const S = P[t];
      const fy = footYaw[f];
      const fq = eulerQ(fy, footPitch[f], 0, _q4);
      // ankle target, compensating pivot (toe-off pivots on the ball, heel strike on the heel)
      const ank = _v1.copy(footTargets[f]);
      ank.y += 0.088;
      const pch = footPitch[f];
      if (pch > 0) ank.y += Math.sin(pch) * 0.13; else ank.y += Math.sin(-pch) * 0.05;
      const side = f === 0 ? 1 : -1;
      const pole = _v2.set(Math.sin(fy) + side * 0.12, 0, Math.cos(fy)).applyAxisAngle(Y, 0).normalize();
      const E = _v3, Tt = _v4;
      twoBone(S, THIGH_L, CALF_L, ank, pole, E, Tt);
      const dThigh = _v5.subVectors(E, S).normalize();
      const dCalf = _v6.subVectors(Tt, E).normalize();
      const sideAx = _v7.crossVectors(pole, _v8.subVectors(Tt, S).normalize()).normalize();
      basisMap(restThighDir[f], X, dThigh, sideAx, R[t]);
      fk(t + 1);
      basisMap(restCalfDir[f], X, dCalf, sideAx, R[t + 1]);
      fk(t + 2);
      R[t + 2].copy(fq);
      fk(t + 3);
      R[t + 3].copy(fq).multiply(_q5.setFromAxisAngle(X, toeBend[f]));
    }

    // ---------------------------------------------------------------- head
    const cheek = this.sAim * (1 - this.sCarry);
    eulerQ(this.sAimYaw * 0.4, -this.sAimPitch * 0.4, 0, _q4);
    R[B.neck].copy(chestQ).slerp(_q4, 0.45);
    fk(B.head);
    eulerQ(this.sAimYaw + cheek * 0.05, -this.sAimPitch + cheek * 0.2 + run * 0.05, -cheek * 0.18 + this.sLean * 0.1, R[B.head]);
    // limit head vs neck
    R[B.head].premultiply(_q5.slerpQuaternions(_qI, hitQ, 0.9));
  }

  private solveArm(side: 0 | 1, target: THREE.Vector3, handQ: THREE.Quaternion) {
    const R = this.modelRot, P = this.modelPos;
    const o = side === 0 ? 0 : 5;
    const ar = armRest[side];
    const S = P[B.uarmL + o];
    const wrist = _va.copy(ar.gripOff).applyQuaternion(handQ).negate().add(target);
    const chestQ = R[B.spine2];
    const pole = side === 1 ? _vb.set(-0.55, -0.75, -0.3) : _vb.set(0.35, -0.9, -0.05);
    pole.applyQuaternion(chestQ).normalize();
    const E = _vc, W = _v19;
    twoBone(S, ARM.UA_LEN, ARM.FA_LEN, wrist, pole, E, W);
    const dU = _v20.subVectors(E, S).normalize();
    const dF = _v21.subVectors(W, E).normalize();
    const u = _v22.subVectors(W, S).normalize();
    const sideAx = _v23.crossVectors(pole, u).normalize();
    basisMap(ar.uaDir, ar.side, dU, sideAx, R[B.uarmL + o]);
    P[B.farmL + o].copy(restOff[B.farmL + o]).applyQuaternion(R[B.uarmL + o]).add(S);
    const fa = basisMap(ar.faDir, ar.side, dF, sideAx, R[B.farmL + o]);
    // hand, forearm twist (half of the hand's roll about the forearm axis)
    R[B.handL + o].copy(handQ);
    const rel = _q6.copy(fa).invert().multiply(handQ);
    const ax = _v24.copy(ar.faDir);
    const proj = ax.dot(_v25.set(rel.x, rel.y, rel.z));
    const tw = _q7.set(ax.x * proj, ax.y * proj, ax.z * proj, rel.w).normalize();
    R[B.twistL + o].copy(fa).multiply(_q8.slerpQuaternions(_qI, tw, 0.55));
    P[B.twistL + o].copy(restOff[B.twistL + o]).applyQuaternion(R[B.farmL + o]).add(P[B.farmL + o]);
    P[B.handL + o].copy(restOff[B.handL + o]).applyQuaternion(R[B.twistL + o]).add(P[B.twistL + o]);
  }

  /** Write the solved pose into THREE bones. */
  apply(bones: THREE.Bone[]) {
    const R = this.modelRot;
    bones[B.hips].position.copy(this.modelPos[B.hips]);
    for (let i = 1; i < BONE_COUNT; i++) {
      const p = PARENT[i];
      bones[i].quaternion.copy(_q1.copy(R[p]).invert().multiply(R[i]));
    }
  }

  /** World transform of a bone from the current solve. */
  boneWorld(i: number, root: THREE.Object3D, scale: number, outPos: THREE.Vector3, outQuat?: THREE.Quaternion) {
    outPos.copy(this.modelPos[i]).multiplyScalar(scale).applyQuaternion(root.quaternion).add(root.position);
    if (outQuat) outQuat.copy(root.quaternion).multiply(this.modelRot[i]);
    return outPos;
  }
}

function keyPos(k: (typeof RELOAD_KEYS)[number], rq: THREE.Quaternion, rp: THREE.Vector3, cq: THREE.Quaternion, cp: THREE.Vector3, out: THREE.Vector3) {
  out.set(...k.p);
  if (k.sp === 'rifle') return out.applyQuaternion(rq).add(rp);
  return out.applyQuaternion(cq).add(cp);
}

const _qI = new THREE.Quaternion();
const _q1 = Q(), _q2 = Q(), _q3 = Q(), _q4 = Q(), _q5 = Q(), _q6 = Q(), _q7 = Q(), _q8 = Q();
const _qa = Q(), _qb = Q(), _qc = Q(), _qd = Q(), _qe = Q();
const _v1 = V(), _v2 = V(), _v3 = V(), _v4 = V(), _v5 = V(), _v6 = V(), _v7 = V(), _v8 = V(), _v9 = V(), _v10 = V();
const _v11 = V(), _v12 = V(), _v13 = V(), _v14 = V(), _v15 = V(), _v16 = V(), _v17 = V(), _v18 = V(), _v19 = V(), _v20 = V();
const _v21 = V(), _v22 = V(), _v23 = V(), _v24 = V(), _v25 = V();
const _va = V(), _vb = V(), _vc = V();

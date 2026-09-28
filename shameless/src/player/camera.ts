import * as THREE from 'three';
import type { Tuning } from './tuning';

/** 1D gradient (Perlin) noise in [-1,1], deterministic per seed. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const n0 = grad(i, seed) * f;
  const n1 = grad(i + 1, seed) * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (n0 + (n1 - n0) * u) * 2;
}
function grad(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h & 0xffff) / 0xffff) * 2 - 1;
}
/** Two octaves of noise1. */
export function fbm1(x: number, seed: number): number {
  return noise1(x, seed) * 0.7 + noise1(x * 2.13 + 17.1, seed + 101) * 0.3;
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Semi-implicit damped spring (value, velocity). */
export class Spring {
  x = 0;
  v = 0;
  constructor(public omega = 12, public zeta = 0.55) {}
  impulse(v: number): void { this.v += v; }
  update(dt: number, target = 0): number {
    const w = this.omega, z = this.zeta;
    // substep for stability on long frames
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -w * w * (this.x - target) - 2 * z * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(): void { this.x = 0; this.v = 0; }
}

export interface CameraInputs {
  eye: THREE.Vector3; // world eye position (already stair-smoothed, no lean)
  yaw: number;
  pitch: number;
  lean: number; // -1..1 (smoothed)
  leanAllowed: number; // 0..1 fraction of lean distance free of walls
  stridePhase: number; // 0..1
  bobWeight: number; // 0..~1.5
  sprintBlend: number;
  tacBlend: number;
  slideBlend: number;
  ads: number;
  strafe: number; // -1..1 lateral velocity normalized, for subtle roll
  mantle: number; // 0..1 mantle curve (0 when not mantling)
  deathBlend: number;
  fovBase: number;
  fovKick: number;
  dt: number;
  time: number;
}

/**
 * First-person camera rig: stride bob, sprint sway, landing spring, recoil (kick + recovery),
 * trauma shake, lean offset/roll, slide roll, FOV kicks.
 */
export class CameraRig {
  readonly landY = new Spring(11, 0.75);
  readonly landPitch = new Spring(10, 0.75);
  readonly punchPitch = new Spring(14, 0.45);
  readonly punchYaw = new Spring(14, 0.45);
  readonly punchRoll = new Spring(12, 0.45);
  /** Recoverable recoil target and the smoothed value actually applied. */
  readonly recoilTarget = new THREE.Vector2();
  readonly recoil = new THREE.Vector2();
  /** Portion of recoil that is being transferred into the aim (yaw/pitch). */
  readonly pendingAim = new THREE.Vector2();
  lastRecoilTime = -10;
  trauma = 0;
  fov = 75;
  /** Final offsets (for consumers). */
  readonly bobOffset = new THREE.Vector3();
  roll = 0;
  private right = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private T: Tuning) {
    this.fov = T.baseFov;
  }

  addRecoil(pitch: number, yaw: number, time: number): void {
    const f = this.T.recoilRecoverFraction;
    this.recoilTarget.x += pitch * f;
    this.recoilTarget.y += yaw * f;
    this.pendingAim.x += pitch * (1 - f);
    this.pendingAim.y += yaw * (1 - f);
    this.lastRecoilTime = time;
  }

  addShake(intensity: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, intensity));
  }

  /** Landing: impact speed m/s. */
  /**
   * Landing: dip scales with fall height (hop ≈ 2.4 cm, 3 m ≈ 9 cm, 6 m ≈ 18 cm); hard landings add a
   * 4° pitch kick and a roll. Springs have ζ = 0.75, peak ≈ 0.44·v/ω.
   */
  land(fallHeight: number, hard: boolean): void {
    const h = Math.max(0, fallHeight);
    const dip = Math.min(0.25, 0.025 * Math.min(h, 1) + 0.0325 * Math.max(0, h - 1));
    const pitch = hard ? 0.07 : 0.004 + 0.006 * Math.min(h, 3) / 3;
    this.landY.impulse(-dip * this.landY.omega / 0.37);
    this.landPitch.impulse(-pitch * this.landPitch.omega / 0.44);
    if (hard) this.punchRoll.impulse((Math.random() < 0.5 ? -1 : 1) * 0.03 * this.punchRoll.omega / 0.57);
  }

  jump(): void {
    this.landY.impulse(-0.2);
    this.landPitch.impulse(0.08);
  }

  punch(pitch: number, yaw: number, roll: number): void {
    this.punchPitch.impulse(pitch);
    this.punchYaw.impulse(yaw);
    this.punchRoll.impulse(roll);
  }

  /** Transfer part of the recoil into the aim; returns the delta to add to (pitch, yaw). */
  consumeAim(dt: number, out: THREE.Vector2): THREE.Vector2 {
    const k = 1 - Math.exp(-this.T.recoilKickRate * dt);
    out.set(this.pendingAim.x * k, this.pendingAim.y * k);
    this.pendingAim.sub(out);
    return out;
  }

  update(i: CameraInputs): void {
    const T = this.T, dt = i.dt, cam = this.camera;
    // ---- recoil: kick toward target, recover after a short delay ----
    this.recoil.x = damp(this.recoil.x, this.recoilTarget.x, T.recoilKickRate, dt);
    this.recoil.y = damp(this.recoil.y, this.recoilTarget.y, T.recoilKickRate, dt);
    if (i.time - this.lastRecoilTime > T.recoilRecoverDelay) {
      this.recoilTarget.x = damp(this.recoilTarget.x, 0, T.recoilRecoverRate, dt);
      this.recoilTarget.y = damp(this.recoilTarget.y, 0, T.recoilRecoverRate, dt);
    }

    // ---- stride bob ----
    const adsK = 1 - 0.85 * i.ads;
    const w = Math.min(1.4, i.bobWeight) * adsK * (1 - i.slideBlend) * (1 - i.mantle);
    const run = Math.min(1, i.sprintBlend + i.tacBlend * 0.4);
    const ampY = THREE.MathUtils.lerp(T.bobWalkY, T.bobSprintY * (1 + 0.3 * i.tacBlend), run) * w;
    const ampX = THREE.MathUtils.lerp(T.bobWalkX, T.bobSprintX * (1 + 0.3 * i.tacBlend), run) * w;
    const ph = i.stridePhase * Math.PI * 2;
    // vertical: lowest at each footfall (phase 0 and 0.5), smooth rounded arcs
    const bobY = -ampY * (0.5 + 0.5 * Math.cos(ph * 2));
    const bobX = ampX * Math.sin(ph);
    const bobRoll = (T.bobSprintRoll * run * 1.0 + 0.002) * Math.sin(ph) * w;
    const bobYaw = T.bobSprintYaw * run * Math.sin(ph + 0.6) * w;
    const bobPitch = 0.004 * run * w * Math.cos(ph * 2);

    // ---- springs ----
    const landY = this.landY.update(dt);
    const landPitch = this.landPitch.update(dt);
    const pp = this.punchPitch.update(dt), py = this.punchYaw.update(dt), pr = this.punchRoll.update(dt);

    // ---- shake (trauma²) ----
    this.trauma = Math.max(0, this.trauma - T.shakeDecay * dt);
    const s = this.trauma * this.trauma;
    const st = i.time * T.shakeFrequency;
    const shPitch = s * T.shakeMaxAngle * fbm1(st, 1);
    const shYaw = s * T.shakeMaxAngle * fbm1(st, 2);
    const shRoll = s * T.shakeMaxRoll * fbm1(st, 3);
    const shX = s * T.shakeMaxOffset * fbm1(st, 4), shY = s * T.shakeMaxOffset * fbm1(st, 5);

    // ---- lean / slide / mantle roll ----
    const leanD = i.lean * T.leanDistance * i.leanAllowed;
    const leanRoll = -i.lean * T.leanRoll;
    const slideRoll = T.slideRoll * i.slideBlend;
    const strafeRoll = -i.strafe * 0.008 * (1 - i.slideBlend);
    const mantleRoll = 0.05 * Math.sin(i.mantle * Math.PI);
    const mantlePitch = -0.09 * Math.sin(i.mantle * Math.PI);
    const deathRoll = 0.5 * i.deathBlend;

    // ---- compose ----
    this.right.set(Math.cos(i.yaw), 0, -Math.sin(i.yaw));
    this.fwd.set(-Math.sin(i.yaw), 0, -Math.cos(i.yaw));
    this.bobOffset.set(bobX, bobY + landY, 0);
    cam.position.copy(i.eye)
      .addScaledVector(this.right, leanD + bobX + shX)
      .add(this.up.set(0, bobY + landY + shY - Math.abs(i.lean) * 0.05 * i.leanAllowed, 0));
    const pitch = i.pitch + this.recoil.x + landPitch + pp + shPitch + bobPitch + mantlePitch;
    const yaw = i.yaw + this.recoil.y + py + shYaw + bobYaw;
    this.roll = leanRoll + slideRoll + strafeRoll + bobRoll + pr + shRoll + mantleRoll + deathRoll;
    cam.rotation.set(THREE.MathUtils.clamp(pitch, -1.55, 1.55), yaw, this.roll, 'YXZ');

    // ---- FOV ----
    const targetFov = i.fovBase + i.fovKick;
    this.fov = damp(this.fov, targetFov, T.fovLerp, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  reset(): void {
    this.landY.reset(); this.landPitch.reset(); this.punchPitch.reset(); this.punchYaw.reset(); this.punchRoll.reset();
    this.recoil.set(0, 0); this.recoilTarget.set(0, 0); this.pendingAim.set(0, 0); this.trauma = 0;
  }
}

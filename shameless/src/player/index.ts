import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, PlayerState } from '../core/types';
import type { Surface } from '../core/events';
import type { Action } from '../core/Input';
import { physicsExt, GROUPS, type ShamelessPhysics } from '../physics';
import { TUNING, type Tuning } from './tuning';
import { CameraRig, damp } from './camera';
import { planMantle, evalMantle, mantleExitVy, type MantlePlan, type WorldQueries } from './mantle';

export { mantleDebug } from './mantle';

export { TUNING } from './tuning';
export type { Tuning } from './tuning';

export type Stance = 'stand' | 'crouch' | 'prone';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector2();

function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }

/**
 * CoD-style first-person controller on a Rapier KinematicCharacterController capsule.
 * Implements the PlayerState contract plus extra read-only state for weapons/HUD/audio (see getters).
 */
export class PlayerController implements PlayerState {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  health: number;
  /** Tuning table (shared object; mutate to tweak live). */
  readonly tuning: Tuning;
  /** Weapon mobility multiplier on ground speed (1 = rifle). */
  moveSpeedScale = 1;
  /** Seconds after death before an automatic respawn; <= 0 disables (orchestrator calls respawn()). */
  autoRespawnDelay = 0;
  /** Disable all movement/look input (menus, cutscenes). */
  inputEnabled = true;

  // ---- internal state ----
  private _grounded = false;
  private _stance: Stance = 'stand';
  private _sprinting = false;
  private _tac = false;
  private sprintLatch = false;
  private lastSprintPress = -10;
  private tacMeter = 1;
  private tacIdle = 0;
  private _sliding = false;
  private slideTime = 0;
  private slideCooldown = 0;
  private slideDir = new THREE.Vector3();
  private slideSpeed = 0;
  private slideAir = 0;
  private _lean = 0;
  private leanAllowed = 1;
  private _alive = true;
  private deathTime = 0;
  private lastDamageTime = -100;
  private height: number;
  private eye: number;
  private coyote = 0;
  private jumpBuffer = 0;
  private lastJumpPress = -10;
  private noSnapTime = 0;
  private airTime = 0;
  private takeoffSpeed = 0;
  private crouchHeldTime = -1;
  private crouchPronePending = false;
  private mantle: { plan: MantlePlan; t: number; wasSprinting: boolean; wasTac: boolean } | null = null;
  private sprintOut = 0;
  private slideWasSprint = false;
  private slideWasTac = false;
  private lastSlideEnd = -10;
  private slideDurMul = 1;
  private lastJumpTime = -10;
  private landSlowTimer = 0;
  private landSlowMul = 1;
  /** Stance height animation (smoothstep from → to over dur). */
  private hAnim = { from: 1.8, to: 1.8, t: 0, dur: 0 };
  /** Camera feet-height follower (critically damped, velocity feed-forward). */
  private camY = 0;
  private camE = 0;
  private camEV = 0;
  private camRate = 0;
  private camRateTarget = 0;
  private camReset = true;
  /** Vertical step discontinuity measured this frame (fed to the camera follower). */
  private stepExcess = 0;
  private airPeakY = 0;
  private blockedFrames = 0;
  private airMantleCheck = 0;
  private _stridePhase = 0;
  private lastFootIndex = 0;
  private _bobWeight = 0;
  private _sprintBlend = 0;
  private _tacBlend = 0;
  private _slideBlend = 0;
  private _crouchBlend = 0;
  private _speed = 0;
  private _lastLandImpact = 0;
  private _landTime = -10;
  private groundNormal = new THREE.Vector3(0, 1, 0);
  private groundSurface: Surface = 'concrete';
  private groundDist = 0;
  private time = 0;
  private spawnIndex = 0;
  private readonly _eyePos = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3(0, 0, -1);
  private readonly _right = new THREE.Vector3(1, 0, 0);
  private readonly wishDir = new THREE.Vector3();
  private wishF = 0;
  private wishS = 0;

  private readonly phys: ShamelessPhysics;
  private readonly R: typeof RAPIER;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private readonly collider: RAPIER.Collider;
  private readonly rig: CameraRig;
  private readonly queries: WorldQueries;

  constructor(private ctx: GameContext, tuning: Tuning = TUNING) {
    this.tuning = tuning;
    const T = tuning;
    this.health = T.maxHealth;
    this.height = T.heightStand;
    this.eye = T.eyeStand;
    this.phys = physicsExt(ctx.physics);
    this.R = this.phys.rapier;
    const R = this.R, world = this.phys.world;

    this.collider = world.createCollider(
      R.ColliderDesc.capsule(this.halfHeightFor(this.height), T.radius).setCollisionGroups(GROUPS.player),
    );
    this.kcc = world.createCharacterController(T.skin);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    this.kcc.enableAutostep(0.45, 0.12, false);
    this.kcc.enableSnapToGround(0.4);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(85);

    this.rig = new CameraRig(ctx.camera, T);

    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const capShapes = new Map<number, RAPIER.Capsule>();
    this.queries = {
      ray: (origin, dir, maxDist) => {
        ray.origin = { x: origin.x, y: origin.y, z: origin.z };
        ray.dir = { x: dir.x, y: dir.y, z: dir.z };
        const h = world.castRayAndGetNormal(ray, maxDist, true, undefined, GROUPS.queryCharacter, this.collider);
        if (!h) return null;
        return {
          distance: h.timeOfImpact,
          point: new THREE.Vector3(origin.x + dir.x * h.timeOfImpact, origin.y + dir.y * h.timeOfImpact, origin.z + dir.z * h.timeOfImpact),
          normal: new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z),
          collider: h.collider,
        };
      },
      fits: (feet, height) => {
        const key = Math.round(height * 1000);
        let shape = capShapes.get(key);
        if (!shape) capShapes.set(key, (shape = new R.Capsule(this.halfHeightFor(height), T.radius - 0.015)));
        const c = { x: feet.x, y: feet.y + height / 2 + 0.01, z: feet.z };
        return world.intersectionWithShape(c, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, GROUPS.queryCharacter, this.collider) === null;
      },
    };

    const spawn = ctx.world?.playerSpawns?.[0];
    this.placeAt(spawn?.position ?? new THREE.Vector3(), spawn?.yaw ?? 0, 0);
  }

  // ---------------- contract getters ----------------
  get eyeHeight(): number { return this.eye; }
  get grounded(): boolean { return this._grounded; }
  get sprinting(): boolean { return this._sprinting; }
  get crouched(): boolean { return this._stance !== 'stand' && !this._sliding; }
  get sliding(): boolean { return this._sliding; }
  get lean(): number { return this._lean; }
  get maxHealth(): number { return this.tuning.maxHealth; }
  get alive(): boolean { return this._alive; }

  // ---------------- extra state (for weapons / HUD / audio) ----------------
  /** 0..1 stride cycle (two footsteps per cycle; footfalls at 0 and 0.5). */
  get stridePhase(): number { return this._stridePhase; }
  /** 0..~1.4 bob amplitude weight (0 idle / airborne, 1 at walk speed). */
  get bobWeight(): number { return this._bobWeight; }
  /** Horizontal speed, m/s. */
  get speed(): number { return this._speed; }
  /** Horizontal speed / tactical sprint speed, 0..1+ */
  get speedNormalized(): number { return this._speed / this.tuning.tacSprintSpeed; }
  /** 0 idle .. 1 at walk speed (clamped). */
  get moveBlend(): number { return clamp(this._speed / this.tuning.walkSpeed, 0, 1); }
  get tacSprinting(): boolean { return this._tac; }
  /** Smoothed 0..1 sprint amount (weapon lowered/sprint pose). */
  get sprintBlend(): number { return this._sprintBlend; }
  /** Smoothed 0..1 tactical sprint amount (weapon held up/away). */
  get tacSprintBlend(): number { return this._tacBlend; }
  /** 0..1 remaining tactical sprint stamina. */
  get tacSprintMeter(): number { return this.tacMeter; }
  get stance(): Stance { return this._stance; }
  get prone(): boolean { return this._stance === 'prone'; }
  /** 0 standing .. 1 crouched/slide height (smoothed). */
  get crouchBlend(): number { return this._crouchBlend; }
  get slideBlend(): number { return this._slideBlend; }
  /** 0..1 progress through the current slide (by time), 0 when not sliding. */
  get slideProgress(): number { return this._sliding ? clamp(this.slideTime / this.tuning.slideMaxTime, 0, 1) : 0; }
  get mantling(): boolean { return this.mantle !== null; }
  get vaulting(): boolean { return this.mantle?.plan.kind === 'vault'; }
  /** 0..1 progress of the current mantle/vault. */
  get mantleProgress(): number { return this.mantle ? clamp(this.mantle.t / this.mantle.plan.duration, 0, 1) : 0; }
  /** Height of the ledge being mantled relative to where it started (m). */
  get mantleHeight(): number { return this.mantle?.plan.height ?? 0; }
  /** Seconds airborne (0 when grounded). */
  get airborneTime(): number { return this.airTime; }
  /** Impact speed of the last landing (m/s) and seconds since it. */
  get lastLandImpact(): number { return this._lastLandImpact; }
  get timeSinceLanding(): number { return this.time - this._landTime; }
  /** World position of the camera (after bob/lean/shake), updated each frame. */
  get eyePosition(): THREE.Vector3 { return this._eyePos; }
  /** Horizontal facing vectors. */
  get forward(): THREE.Vector3 { return this._fwd; }
  get right(): THREE.Vector3 { return this._right; }
  /** Current recoverable recoil offset (x = pitch, y = yaw), radians. */
  get recoilOffset(): THREE.Vector2 { return this.rig.recoil; }
  /** Current camera bob offset in view space (m). */
  get bobOffset(): THREE.Vector3 { return this.rig.bobOffset; }
  /** Camera roll (rad) incl. lean/slide. */
  get cameraRoll(): number { return this.rig.roll; }
  /** Ground surface under the player. */
  get surface(): Surface { return this.groundSurface; }
  /** Local move input (-1..1): x = strafe, y = forward. */
  get moveInput(): THREE.Vector2 { return new THREE.Vector2(this.wishS, this.wishF); }
  /** True while the weapon shouldn't fire (sprinting, tac sprint, mantling, dead). */
  get weaponBlocked(): boolean { return !this._alive || this.mantle !== null || this._sprinting || this.sprintOut > 0 || this.proneTransition; }
  /** Seconds until the weapon may fire after leaving sprint (0.24 s) / tactical sprint (0.42 s); full value while sprinting. */
  get sprintOutRemaining(): number { return this._sprinting ? (this._tac ? this.tuning.tacSprintOutTime : this.tuning.sprintOutTime) : this.sprintOut; }
  /** True while going into / out of prone (weapon unavailable). */
  get proneTransition(): boolean {
    const a = this.hAnim, pr = this.tuning.heightProne + 0.05;
    return a.t < a.dur && (a.from <= pr || a.to <= pr);
  }
  /** 0..1 damage recency (1 right after being hit, fades over ~1 s). */
  get hurtBlend(): number { return clamp(1 - (this.time - this.lastDamageTime), 0, 1); }
  /** Health regen active. */
  get regenerating(): boolean { return this._alive && this.health < this.maxHealth && this.time - this.lastDamageTime > this.tuning.regenDelay; }

  // ---------------- contract methods ----------------
  addRecoil(pitch: number, yaw: number): void { this.rig.addRecoil(pitch, yaw, this.time); }
  addCameraShake(intensity: number): void { this.rig.addShake(intensity); }
  /** Spring-based view punch (radians/s impulses), e.g. melee, flinch. */
  addViewPunch(pitch: number, yaw: number, roll = 0): void { this.rig.punch(pitch, yaw, roll); }
  /** Stop sprinting (weapons call this when firing/ADS begins). */
  cancelSprint(): void {
    if (this._sprinting) this.sprintOut = this._tac ? this.tuning.tacSprintOutTime : this.tuning.sprintOutTime;
    this.sprintLatch = false; this._sprinting = false; this._tac = false;
  }

  damage(amount: number, fromDir: THREE.Vector3 | null): void {
    if (!this._alive || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.lastDamageTime = this.time;
    const k = Math.min(1, amount / 60);
    this.rig.addShake(0.12 + 0.35 * k);
    let side = (Math.random() - 0.5) * 2;
    if (fromDir) {
      // fromDir = direction the damage travelled; flinch away from the source
      side = clamp(fromDir.x * this._right.x + fromDir.z * this._right.z, -1, 1);
    }
    this.rig.punch(0.25 + 0.5 * k, side * 0.3 * (0.4 + k), side * 0.25 * k);
    this.ctx.events.emit('player:damaged', { amount, health: this.health, fromDir });
    if (this.health <= 0) this.die();
  }

  respawn(): void {
    const spawns = this.ctx.world?.playerSpawns ?? [];
    let spawn = spawns[this.spawnIndex % Math.max(1, spawns.length)];
    const enemies = this.ctx.enemies?.enemies;
    if (spawns.length > 1 && enemies && enemies.length) {
      let best = -1;
      for (const s of spawns) {
        let minD = Infinity;
        for (const e of enemies) if (e.alive) minD = Math.min(minD, e.position.distanceToSquared(s.position));
        if (minD > best) { best = minD; spawn = s; }
      }
    } else this.spawnIndex++;
    this.health = this.tuning.maxHealth;
    this._alive = true;
    this.lastDamageTime = -100;
    this.placeAt(spawn?.position ?? new THREE.Vector3(), spawn?.yaw ?? 0, 0);
    this.ctx.events.emit('player:respawn', {});
  }

  /** Teleport (feet position) and reset movement state. */
  placeAt(feet: THREE.Vector3, yaw = this.yaw, pitch = 0): void {
    const T = this.tuning;
    this.position.copy(feet);
    this.position.y += T.skin + 0.01;
    this.velocity.set(0, 0, 0);
    this.yaw = yaw; this.pitch = pitch;
    this._stance = 'stand'; this.height = T.heightStand; this.eye = T.eyeStand;
    this._sliding = false; this.mantle = null; this._sprinting = this._tac = this.sprintLatch = false;
    this._lean = 0; this.airTime = 0; this.deathTime = 0;
    this._grounded = false; this.tacMeter = 1; this.sprintOut = 0; this.landSlowTimer = 0;
    this.hAnim = { from: T.heightStand, to: T.heightStand, t: 0, dur: 0 };
    this.camReset = true;
    this.collider.setHalfHeight(this.halfHeightFor(this.height));
    this.syncCollider();
    this.rig.reset();
    this.updateFacing();
    this.updateCamera(0);
  }

  // ---------------- main update ----------------
  update(dtRaw: number): void {
    const dt = Math.min(Math.max(dtRaw, 0), 0.05);
    if (dt <= 0) return;
    this.time += dt;
    const T = this.tuning;
    const input = this.ctx.input;
    this.phys.flush();
    const on = (a: Action) => this.inputEnabled && this._alive && input.down.has(a);
    const pressed = (a: Action) => this.inputEnabled && this._alive && input.pressed.has(a);

    // ---- look ----
    if (this.inputEnabled && this._alive) {
      this.yaw -= input.mouseDX * input.sensitivity;
      this.pitch -= input.mouseDY * input.sensitivity;
    }
    this.rig.consumeAim(dt, _aim);
    this.pitch = clamp(this.pitch + _aim.x, -1.53, 1.53);
    this.yaw += _aim.y;
    this.updateFacing();

    // ---- wish direction ----
    this.wishF = (on('forward') ? 1 : 0) - (on('back') ? 1 : 0);
    this.wishS = (on('right') ? 1 : 0) - (on('left') ? 1 : 0);
    this.wishDir.set(0, 0, 0).addScaledVector(this._fwd, this.wishF).addScaledVector(this._right, this.wishS);
    const hasWish = this.wishDir.lengthSq() > 0;
    if (hasWish) this.wishDir.normalize();

    // ---- timers ----
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.noSnapTime = Math.max(0, this.noSnapTime - dt);
    if (pressed('jump')) { this.jumpBuffer = T.jumpBuffer; this.lastJumpPress = this.time; }
    const ads = this.ctx.weapons?.adsAmount ?? 0;

    // ---- death ----
    if (!this._alive) {
      this.deathTime += dt;
      if (this.autoRespawnDelay > 0 && this.deathTime >= this.autoRespawnDelay) { this.respawn(); return; }
    }

    // ---- mantle in progress ----
    if (this.mantle) {
      this.updateMantle(dt);
      this.finishFrame(dt, ads);
      return;
    }

    // ---- stance input ----
    this.handleStanceInput(dt, pressed, on);

    // ---- sprint ----
    this.updateSprint(dt, pressed, on, ads);

    // ---- jump / mantle ----
    if (this.jumpBuffer > 0 && this._alive) {
      if (this.tryStartMantle(this._grounded)) {
        this.jumpBuffer = 0;
        this.finishFrame(dt, ads);
        return;
      }
      if (this._stance === 'prone') {
        this.jumpBuffer = 0;
        this.setStance('crouch');
      } else if (this._stance === 'crouch' && !this._sliding && this._grounded) {
        this.jumpBuffer = 0;
        this.setStance('stand');
      } else if (this._grounded || this.coyote > 0) {
        this.jumpBuffer = 0;
        this.doJump();
      }
    } else if (!this._grounded && this._alive && this.wishF > 0 && this.velocity.y < 4.5 && (on('jump') || this.time - this.lastJumpPress < 0.7)) {
      // mid-air mantle: moving forward into a ledge shortly after pressing jump (or while holding it)
      this.airMantleCheck -= dt;
      if (this.airMantleCheck <= 0) {
        this.airMantleCheck = 0;
        if (this.tryStartMantle(false)) { this.finishFrame(dt, ads); return; }
      }
    }

    // ---- velocity ----
    const vh = _v.set(this.velocity.x, 0, this.velocity.z);
    if (this._sliding) this.updateSlideVelocity(dt, vh, hasWish);
    else if (this._grounded) this.groundAccelerate(dt, vh, hasWish, ads);
    else this.airAccelerate(dt, vh, hasWish, ads);
    this.velocity.x = vh.x; this.velocity.z = vh.z;
    if (this._grounded && this.velocity.y <= 0) this.velocity.y = -2;
    else this.velocity.y = Math.max(-T.maxFallSpeed, this.velocity.y - T.gravity * dt);

    // ---- move ----
    this.move(dt);

    this.finishFrame(dt, ads);
  }

  // ---------------- pieces ----------------
  private halfHeightFor(h: number): number { return Math.max(0.01, h / 2 - this.tuning.radius); }

  private syncCollider(): void {
    this.collider.setTranslation({ x: this.position.x, y: this.position.y + this.height / 2, z: this.position.z });
  }

  private updateFacing(): void {
    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  private setStance(s: Stance): boolean {
    if (s === this._stance) return true;
    const T = this.tuning;
    const h = s === 'stand' ? T.heightStand : s === 'crouch' ? T.heightCrouch : T.heightProne;
    if (h > this.height + 0.01 && !this.queries.fits(this.position, h)) return false;
    this._stance = s;
    if (s !== 'stand') this.cancelSprint();
    return true;
  }

  private handleStanceInput(dt: number, pressed: (a: Action) => boolean, on: (a: Action) => boolean): void {
    const T = this.tuning;
    if (pressed('crouch')) {
      this.crouchHeldTime = 0;
      this.crouchPronePending = false;
      if (this._sliding) {
        this.endSlide('crouch');
      } else if (this._sprinting && this._grounded && this._speed >= T.slideMinEntrySpeed && this.slideCooldown <= 0) {
        this.startSlide();
      } else if (this._stance === 'stand') {
        this.setStance('crouch');
        this.crouchPronePending = true;
      } else if (this._stance === 'crouch') {
        if (!this.setStance('stand')) this.crouchPronePending = true;
      } else {
        this.setStance('crouch');
      }
    }
    if (this.crouchHeldTime >= 0) {
      if (on('crouch')) {
        this.crouchHeldTime += dt;
        // hold crouch → prone (CoD)
        if (this.crouchPronePending && this.crouchHeldTime > 0.38 && this._grounded && !this._sliding) {
          this.setStance('prone');
          this.crouchPronePending = false;
        }
      } else this.crouchHeldTime = -1;
    }
    if (this._stance === 'prone' && !this._grounded) this.setStance('crouch');
  }

  private updateSprint(dt: number, pressed: (a: Action) => boolean, on: (a: Action) => boolean, ads: number): void {
    const T = this.tuning;
    if (pressed('sprint')) {
      if (this._sliding) {
        // slide cancel into sprint (keeps tactical sprint if the slide came from it)
        const wasTac = this.slideWasTac;
        this.endSlide('stand');
        this.sprintLatch = true;
        this._tac = wasTac && this.tacMeter > 0;
      } else {
        if (this._stance !== 'stand') this.setStance('stand');
        const dbl = this.time - this.lastSprintPress < T.doubleTapWindow;
        if ((this._sprinting || dbl) && this.tacMeter > 0.15) this._tac = true;
        this.sprintLatch = true;
      }
      this.lastSprintPress = this.time;
    }
    if (on('sprint') && this.wishF > 0 && !this.sprintLatch && this._stance === 'stand') this.sprintLatch = true;
    if (pressed('fire') || on('ads') || ads > 0.3) this.cancelSprint();
    const forwardEnough = this.wishF > 0;
    if (!forwardEnough) this.sprintLatch = false;
    const canSprint = this.sprintLatch && forwardEnough && this._stance === 'stand' && !this._sliding && this._alive;
    const wasSprinting = this._sprinting, wasTac = this._tac;
    if (this._grounded || !canSprint) this._sprinting = canSprint;
    if (!this._sprinting) this._tac = false;
    // tactical sprint stamina: drains on the ground and in the air; no recharge while sprinting
    if (this._tac) {
      this.tacMeter -= dt / T.tacSprintDuration;
      this.tacIdle = 0;
      if (this.tacMeter <= 0) { this.tacMeter = 0; this._tac = false; }
    } else if (this._sprinting) {
      this.tacIdle = 0;
    } else {
      this.tacIdle += dt;
      if (this.tacIdle > T.tacSprintRechargeDelay) this.tacMeter = Math.min(1, this.tacMeter + dt / T.tacSprintRechargeTime);
    }
    this.updateSprintOut(dt, wasSprinting, wasTac);
  }

  /** Sprint-out timer: the weapon comes up 0.24 s after sprint, 0.42 s after tactical sprint. */
  private updateSprintOut(dt: number, wasSprinting: boolean, wasTac: boolean): void {
    const T = this.tuning;
    if (this._sprinting) this.sprintOut = this._tac ? T.tacSprintOutTime : T.sprintOutTime;
    else if (wasSprinting) this.sprintOut = wasTac ? T.tacSprintOutTime : T.sprintOutTime;
    else this.sprintOut = Math.max(0, this.sprintOut - dt);
  }

  private targetSpeed(ads: number): number {
    const T = this.tuning;
    let s: number;
    if (this._stance === 'prone') s = T.proneSpeed;
    else if (this._stance === 'crouch') s = T.crouchSpeed;
    else if (this._sprinting) s = this._tac ? T.tacSprintSpeed : T.sprintSpeed;
    else s = T.walkSpeed;
    if (!this._sprinting) {
      const f = this.wishF, sd = this.wishS;
      const len = Math.hypot(f, sd) || 1;
      const fn = f / len;
      const dirMul = fn < -0.1 ? T.backMul : THREE.MathUtils.lerp(T.strafeMul, 1, Math.max(0, fn));
      s *= dirMul;
    }
    s *= THREE.MathUtils.lerp(1, T.adsMul, clamp(ads, 0, 1)) * this.moveSpeedScale;
    s *= THREE.MathUtils.lerp(1, T.leanMoveMul, Math.abs(this._lean));
    return s;
  }

  /**
   * Ground movement: the velocity component along the wish direction ramps toward the target speed
   * (eased: 90 % of walk in ~0.18 s, then a 9 m/s² ramp into sprint/tac), sideways velocity is removed
   * quickly (turning follows the view), and stopping uses friction with a soft tail (~0.28 s from walk).
   */
  private groundAccelerate(dt: number, vh: THREE.Vector3, hasWish: boolean, ads: number): void {
    const T = this.tuning;
    const slow = this.landSlowTimer > 0 ? this.landSlowMul : 1;
    if (!hasWish) {
      const sp = vh.length();
      const ns = Math.max(0, sp - Math.max(sp, T.stopMinSpeed) * T.stopFriction * dt);
      if (sp > 1e-6) vh.multiplyScalar(ns / sp);
      return;
    }
    const ts = this.targetSpeed(ads) * slow;
    const w = this.wishDir;
    let along = vh.x * w.x + vh.z * w.z;
    let px = vh.x - w.x * along, pz = vh.z - w.z * along;
    if (along < ts) {
      const accel = along < T.walkSpeed * 0.98
        ? clamp((ts - along) * T.groundAccelRate, 3, T.groundAccelMax)
        : T.sprintAccel;
      along = Math.min(ts, along + accel * dt);
    } else {
      along = Math.max(ts, along - Math.max(along, T.stopMinSpeed) * T.stopFriction * dt);
    }
    const pl = Math.hypot(px, pz);
    if (pl > 1e-6) {
      const np = Math.max(0, pl - Math.max(pl * T.groundAccelRate, T.turnAccel) * dt);
      px *= np / pl; pz *= np / pl;
    }
    vh.set(w.x * along + px, 0, w.z * along + pz);
  }

  private airAccelerate(dt: number, vh: THREE.Vector3, hasWish: boolean, ads: number): void {
    const T = this.tuning;
    const before = vh.length();
    if (hasWish) {
      vh.addScaledVector(this.wishDir, T.airAccel * dt);
      // never faster in the air than you took off or than the current state allows on the ground
      const cap = Math.max(this.takeoffSpeed, this.targetSpeed(ads));
      const after = vh.length();
      if (after > cap && after > before) vh.multiplyScalar(Math.max(before, cap) / after);
    }
    vh.multiplyScalar(Math.max(0, 1 - T.airDrag * dt));
  }

  private doJump(): void {
    const T = this.tuning;
    const fatigue = this.time - this.lastJumpTime < T.jumpFatigueWindow ? T.jumpFatigueMul : 1;
    const vy = Math.sqrt(2 * T.gravity * T.jumpHeight * fatigue);
    if (this._sliding) {
      // slide-jump keeps the slide direction but exits at no more than sprint speed, and resumes sprint/tac
      const hs = Math.min(this.slideSpeed, T.sprintSpeed);
      this.velocity.x = this.slideDir.x * hs; this.velocity.z = this.slideDir.z * hs;
      const wasSprint = this.slideWasSprint, wasTac = this.slideWasTac;
      this.endSlide('stand');
      if (wasSprint && this._stance === 'stand' && this.wishF > 0) {
        this.sprintLatch = true;
        this._sprinting = true;
        this._tac = wasTac && this.tacMeter > 0;
      }
    }
    this.velocity.y = vy;
    this._grounded = false;
    this.coyote = 0;
    this.noSnapTime = 0.2;
    this.lastJumpTime = this.time;
    this.airPeakY = this.position.y;
    this.takeoffSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.rig.jump();
    this.ctx.events.emit('player:jump', { position: this.position.clone() });
  }

  private startSlide(): void {
    const T = this.tuning;
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (hs > 0.5) this.slideDir.set(this.velocity.x / hs, 0, this.velocity.z / hs);
    else this.slideDir.copy(this._fwd);
    // entry × 1.1 (no floor), capped at 1.15 × tac speed; a repeat slide within 1.5 s gets no boost and is shorter
    const repeat = this.time - this.lastSlideEnd < T.slideRepeatWindow;
    this.slideSpeed = Math.min(hs * (repeat ? 1 : T.slideBoostMul), T.tacSprintSpeed * T.slideMaxMul);
    this.slideDurMul = repeat ? T.slideRepeatDurationMul : 1;
    this.slideWasSprint = this._sprinting;
    this.slideWasTac = this._tac;
    this._sliding = true;
    this.slideTime = 0;
    this.slideAir = 0;
    this._stance = 'crouch';
    this._sprinting = false; this._tac = false;
    this.rig.punch(-0.1, 0, -0.15);
    this.ctx.events.emit('player:slide', { position: this.position.clone() });
  }

  private endSlide(to: 'stand' | 'crouch'): void {
    if (!this._sliding) return;
    this._sliding = false;
    this.slideCooldown = this.tuning.slideCooldown;
    this.lastSlideEnd = this.time;
    if (to === 'stand') { if (!this.setStance('stand')) this._stance = 'crouch'; }
    else this._stance = 'crouch';
  }

  private updateSlideVelocity(dt: number, vh: THREE.Vector3, hasWish: boolean): void {
    const T = this.tuning;
    this.slideTime += dt;
    // limited steering toward the wish direction
    if (hasWish && this.wishDir.dot(this.slideDir) > -0.2) {
      const cross = this.slideDir.x * this.wishDir.z - this.slideDir.z * this.wishDir.x;
      const ang = clamp(Math.atan2(cross, this.slideDir.dot(this.wishDir)), -T.slideSteer * dt, T.slideSteer * dt);
      const c = Math.cos(ang), s = Math.sin(ang);
      const x = this.slideDir.x * c - this.slideDir.z * s, z = this.slideDir.x * s + this.slideDir.z * c;
      this.slideDir.set(x, 0, z).normalize();
    }
    const dm = this.slideDurMul;
    const decel = (this.slideTime < T.slideEarlyTime * dm ? T.slideDecelEarly : T.slideDecelLate) / dm;
    // slope: accelerate downhill, brake uphill
    const n = this.groundNormal;
    const slopeA = T.gravity * T.slideSlopeGain * (n.x * this.slideDir.x + n.z * this.slideDir.z);
    this.slideSpeed = Math.max(0, this.slideSpeed + (slopeA - decel) * dt);
    if (!this._grounded) this.slideAir += dt; else this.slideAir = 0;
    vh.copy(this.slideDir).multiplyScalar(this.slideSpeed);
    const on = (a: Action) => this.inputEnabled && this.ctx.input.down.has(a);
    if (this.slideSpeed < T.slideEndSpeed || this.slideTime > T.slideMaxTime * dm || this.slideAir > 0.25) {
      const toSprint = on('sprint') && this.wishF > 0;
      const wasTac = this.slideWasTac;
      this.endSlide(toSprint ? 'stand' : 'crouch');
      if (toSprint && this._stance === 'stand') { this.sprintLatch = true; this._tac = wasTac && this.tacMeter > 0; }
    }
  }

  private move(dt: number): void {
    const T = this.tuning;
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    if (this.noSnapTime > 0 || this.velocity.y > 0) this.kcc.disableSnapToGround();
    else this.kcc.enableSnapToGround(this._grounded ? 0.4 : 0.1);
    this.syncCollider();
    const flags = this.R.QueryFilterFlags.EXCLUDE_SENSORS;
    this.kcc.computeColliderMovement(this.collider, desired, flags, GROUPS.queryCharacter);
    const m1 = this.kcc.computedMovement();
    const mv = { x: m1.x, y: m1.y, z: m1.z };
    const wasGrounded = this._grounded;
    const vyBefore = this.velocity.y;
    this.position.x += mv.x; this.position.y += mv.y; this.position.z += mv.z;
    this.syncCollider();
    let kccGrounded = this.kcc.computedGrounded();

    const dh = Math.hypot(desired.x, desired.z);
    let ah = Math.hypot(mv.x, mv.z);
    const climbed = mv.y > desired.y + 0.004;
    // Autostep eats part of the horizontal move on the frame it steps; spend the remainder in extra
    // passes so stairs are climbed at full speed (no per-riser speed dips).
    if (wasGrounded && dh > 1e-5 && ah < dh * 0.98) {
      const ux = desired.x / dh, uz = desired.z / dh;
      for (let pass = 0; pass < 4; pass++) {
        const along = mv.x * ux + mv.z * uz;
        const rem = dh - Math.max(0, along);
        if (rem < dh * 0.02) break;
        this.kcc.computeColliderMovement(this.collider, { x: ux * rem, y: -0.002, z: uz * rem }, flags, GROUPS.queryCharacter);
        const m2 = this.kcc.computedMovement();
        if (Math.hypot(m2.x, m2.z) < 1e-4) break;
        this.position.x += m2.x; this.position.y += m2.y; this.position.z += m2.z;
        mv.x += m2.x; mv.y += m2.y; mv.z += m2.z;
        this.syncCollider();
        kccGrounded = kccGrounded || this.kcc.computedGrounded();
      }
      ah = Math.hypot(mv.x, mv.z);
    }
    // snap-down / autostep can also push slightly further than asked: trim back along the path
    if (dh > 1e-5 && ah > dh * 1.005) {
      const k = (ah - dh) / ah;
      this.position.x -= mv.x * k; this.position.z -= mv.z * k;
      mv.x *= 1 - k; mv.z *= 1 - k;
      ah = dh;
      this.syncCollider();
    }

    // clip horizontal velocity against walls (not when the loss came from climbing a step/slope)
    const blocked = dh > 1e-5 && ah < dh * 0.9 && !climbed;
    this.blockedFrames = blocked ? this.blockedFrames + 1 : 0;
    if (blocked && (!wasGrounded || this.blockedFrames >= 2)) {
      const k = ah / dh;
      if (ah > 1e-6) {
        const sp = Math.hypot(this.velocity.x, this.velocity.z) * k;
        this.velocity.x = (mv.x / ah) * sp; this.velocity.z = (mv.z / ah) * sp;
        if (this._sliding) { this.slideDir.set(mv.x / ah, 0, mv.z / ah); this.slideSpeed = sp; }
      } else {
        this.velocity.x = 0; this.velocity.z = 0;
        if (this._sliding) this.slideSpeed = 0;
      }
    }
    // ceiling
    if (desired.y > 0 && mv.y < desired.y * 0.5) this.velocity.y = Math.min(this.velocity.y, 0);

    // ground probe (surface, normal, distance)
    this.probeGround();
    const grounded = kccGrounded || (this.groundDist < 0.06 && this.velocity.y <= 0);
    this._grounded = grounded && this.velocity.y <= 0.01;
    // snap-to-ground can leave the capsule a few mm inside the floor: lift it back out
    // (and on flat ground pin it to the rest height so the camera doesn't creep by millimetres)
    const ny = this.groundNormal.y;
    if (this._grounded && ny > 0.7 && isFinite(this.groundDist)) {
      const expected = T.skin + T.radius * (1 / ny - 1); // rest gap under the centre on a slope
      const diff = expected - this.groundDist;
      const fix = ny > 0.995 ? (diff > -0.03 && diff < 0.2 ? diff : 0) : (diff > 0.004 && diff < 0.2 ? diff : 0);
      if (fix !== 0) { this.position.y += fix; mv.y += fix; this.groundDist += fix; this.syncCollider(); }
    }

    // Vertical motion beyond what the ground slope under the centre explains (stairs, curbs, snap-down)
    // is smoothed by the camera follower; slopes and ramps are followed exactly.
    if (wasGrounded && this._grounded) {
      const gny = Math.max(0.2, this.groundNormal.y);
      const dy = mv.y;
      const slopeDy = ah * (Math.sqrt(1 - gny * gny) / gny) + 0.002;
      this.stepExcess = Math.sign(dy) * Math.max(0, Math.abs(dy) - slopeDy);
    }
    // look-ahead: fit a line through the ground heights 0.15–0.75 m ahead; the part of that slope the
    // ground under the centre doesn't already explain (i.e. stairs) sets the camera's glide rate
    this.camRateTarget = 0;
    const hsp = ah / dt;
    if (this._grounded && hsp > 0.3) {
      const ux = mv.x / ah, uz = mv.z / ah;
      let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
      for (let i = 1; i <= 5; i++) {
        const d = 0.15 * i;
        const g = this.queries.ray(_v2.set(this.position.x + ux * d, this.position.y + 0.7, this.position.z + uz * d), DOWN, 1.5);
        if (!g || g.distance < 0.02 || g.normal.y < 0.7) { n = 0; break; }
        const hy = g.point.y + T.skin - this.position.y;
        sx += d; sy += hy; sxx += d * d; sxy += d * hy; n++;
      }
      if (n >= 3) {
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        const gny = Math.max(0.2, this.groundNormal.y);
        const centre = Math.sqrt(1 - gny * gny) / gny; // |tan| of the surface under the centre
        const extra = Math.sign(slope) * Math.max(0, Math.abs(slope) - centre);
        this.camRateTarget = clamp(extra * 0.92, -1.2, 1.2) * hsp;
      }
    }
    if (!this._grounded) this.airPeakY = Math.max(this.airPeakY, this.position.y);
    if (this._grounded) {
      if (!wasGrounded) this.onLand(-vyBefore, Math.max(0, this.airPeakY - this.position.y));
      this.coyote = T.coyoteTime;
      this.airTime = 0;
      if (this.velocity.y < 0) this.velocity.y = -2;
    } else {
      if (wasGrounded) {
        this.airPeakY = this.position.y;
        this.takeoffSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        if (this.velocity.y < 0) this.velocity.y = 0; // walked off a ledge: start falling from rest
      }
      this.airTime += dt;
    }
    this._speed = ah / dt;
    if (this.position.y < -60) this.respawn();
  }

  private probeGround(): void {
    const hit = this.queries.ray(_v2.set(this.position.x, this.position.y + 0.25, this.position.z), DOWN, 1.25);
    if (hit) {
      this.groundDist = hit.distance - 0.25;
      this.groundNormal.copy(hit.normal);
      this.groundSurface = this.phys.surfaceOfCollider(hit.collider);
    } else {
      this.groundDist = Infinity;
      this.groundNormal.set(0, 1, 0);
    }
  }

  private onLand(impact: number, fallHeight?: number, fromVault = false): void {
    const T = this.tuning;
    this._lastLandImpact = impact;
    this._landTime = this.time;
    const fallH = fallHeight ?? (impact * impact) / (2 * T.gravity);
    const hard = impact >= T.hardLandSpeed;
    if (impact > 1) {
      this.rig.land(fallH, hard);
      if (hard) this.rig.addShake(0.35);
      this.ctx.events.emit('player:land', { position: this.position.clone(), impactSpeed: impact, surface: this.groundSurface });
    }
    // landing slow-down: 0.75× for 0.2 s, hard landings 0.5× for 0.35 s (sliding keeps its momentum)
    if (impact >= 3 && !this._sliding && !fromVault) {
      this.landSlowMul = hard ? T.hardLandSlowMul : T.landSlowMul;
      this.landSlowTimer = hard ? T.hardLandSlowTime : T.landSlowTime;
      const hs = Math.hypot(this.velocity.x, this.velocity.z);
      const cap = Math.max(T.walkSpeed * this.landSlowMul, hs * (hard ? 0.6 : 0.85));
      if (hs > cap) { this.velocity.x *= cap / hs; this.velocity.z *= cap / hs; }
    }
    if (impact > T.fallDamageSpeed) this.damage((impact - T.fallDamageSpeed) * T.fallDamagePerMs, null);
    this.lastFootIndex = Math.floor(this._stridePhase * 2);
  }

  private tryStartMantle(grounded: boolean): boolean {
    if (this._stance === 'prone' || !this._alive) return false;
    const groundY = isFinite(this.groundDist) ? this.position.y - this.groundDist : null;
    const plan = planMantle(this.queries, {
      feet: this.position, fwd: this._fwd, grounded,
      vel: _v2.set(this.velocity.x, 0, this.velocity.z), vy: grounded ? 0 : this.velocity.y, groundY,
    }, this.tuning);
    if (!plan) return false;
    const wasTac = this._tac || (this._sliding && this.slideWasTac);
    this.mantle = { plan, t: 0, wasSprinting: this.sprintLatch || this._sprinting || (this._sliding && this.slideWasSprint), wasTac };
    if (this._sliding) this.endSlide(plan.endCrouched ? 'crouch' : 'stand');
    if (this._sprinting) this.sprintOut = this._tac ? this.tuning.tacSprintOutTime : this.tuning.sprintOutTime;
    this._sprinting = false; this._tac = false;
    this.rig.punch(plan.kind === 'vault' ? -0.08 : -0.15, 0, 0.08);
    this.ctx.events.emit('player:mantle', { position: this.position.clone(), height: plan.height, vault: plan.kind === 'vault' });
    return true;
  }

  private updateMantle(dt: number): void {
    const m = this.mantle!;
    m.t += dt;
    const k = Math.min(1, m.t / m.plan.duration);
    const prev = _v2.copy(this.position);
    evalMantle(m.plan, k, this.position);
    if (k >= 1) {
      // spend the rest of the frame moving at the exit velocity so speed stays continuous
      const left = m.t - m.plan.duration;
      this.position.x += m.plan.dir.x * m.plan.v1 * left;
      this.position.z += m.plan.dir.z * m.plan.v1 * left;
    }
    this.syncCollider();
    this.velocity.copy(this.position).sub(prev).divideScalar(dt);
    this._speed = Math.hypot(this.velocity.x, this.velocity.z);
    this._grounded = false;
    if (k >= 1) {
      this.mantle = null;
      const p = m.plan;
      this._stance = p.endCrouched ? 'crouch' : 'stand';
      // hand off with the path's exit velocity (continuous with the curve's end tangent)
      this.velocity.set(p.dir.x * p.v1, mantleExitVy(p), p.dir.z * p.v1);
      if (m.wasSprinting && !p.endCrouched && this.wishF > 0) {
        this.sprintLatch = true;
        this._sprinting = true;
        this._tac = m.wasTac && this.tacMeter > 0;
      }
      this.probeGround();
      this._grounded = this.groundDist < 0.08;
      this.takeoffSpeed = p.v1;
      if (this._grounded) {
        const impact = -this.velocity.y;
        this.velocity.y = -2;
        this.airTime = 0;
        if (impact > 1) this.onLand(impact, Math.max(0, p.apexY - p.end.y), p.kind === 'vault');
      }
    }
  }

  /** Stance height, lean, blends, stride/footsteps, health, camera. */
  private finishFrame(dt: number, ads: number): void {
    const T = this.tuning;
    // ---- capsule height: smoothstep transitions with CoD-like stance timings ----
    const targetH = !this._alive ? T.heightProne
      : this.mantle ? (this.mantle.plan.endCrouched ? T.heightCrouch : T.heightStand)
      : this._sliding ? T.heightSlide
      : this._stance === 'prone' ? T.heightProne
      : this._stance === 'crouch' ? T.heightCrouch : T.heightStand;
    const an = this.hAnim;
    if (Math.abs(targetH - an.to) > 1e-4) {
      an.from = this.height; an.to = targetH; an.t = 0;
      an.dur = this.stanceDuration(this.height, targetH);
    }
    an.t += dt;
    const u = an.dur > 0 ? clamp(an.t / an.dur, 0, 1) : 1;
    let newH = an.from + (an.to - an.from) * (u * u * (3 - 2 * u));
    if (newH > this.height + 1e-5 && !this.mantle && !this.queries.fits(this.position, newH)) {
      newH = this.height; // blocked overhead — stay low
      an.t -= dt;
      if (this._stance === 'stand' && targetH === T.heightStand) this._stance = 'crouch';
    }
    if (newH !== this.height) {
      this.height = newH;
      this.collider.setHalfHeight(this.halfHeightFor(newH));
      this.syncCollider();
    }
    this.eye = this._alive ? this.eyeForHeight(this.height) : damp(this.eye, 0.35, 4, dt);
    this._crouchBlend = clamp((T.heightStand - this.height) / (T.heightStand - T.heightCrouch), 0, 1.5);
    this.landSlowTimer = Math.max(0, this.landSlowTimer - dt);

    // ---- lean ----
    const leanInput = (this.inputEnabled && this._alive ? ((this.ctx.input.down.has('leanRight') ? 1 : 0) - (this.ctx.input.down.has('leanLeft') ? 1 : 0)) : 0);
    const leanOk = !this._sprinting && !this._sliding && !this.mantle && this._alive;
    this._lean = damp(this._lean, leanOk ? leanInput : 0, 3 / T.leanTime, dt);
    if (Math.abs(this._lean) < 1e-3) this._lean = 0;
    let freeFrac = 1;
    if (this._lean !== 0) {
      const eyeC = _v2.set(this.position.x, this.position.y + this.eye, this.position.z);
      const dir = _v.copy(this._right).multiplyScalar(Math.sign(this._lean));
      const hit = this.phys.sphereCast(eyeC, dir, 0.16, T.leanDistance + 0.05);
      if (hit) freeFrac = clamp((hit.distance - 0.02) / T.leanDistance, 0, 1);
    }
    this.leanAllowed = damp(this.leanAllowed, freeFrac, freeFrac < this.leanAllowed ? 40 : 10, dt);

    // ---- blends ----
    this._sprintBlend = damp(this._sprintBlend, this._sprinting ? 1 : 0, 9, dt);
    this._tacBlend = damp(this._tacBlend, this._tac ? 1 : 0, 7, dt);
    this._slideBlend = damp(this._slideBlend, this._sliding ? 1 : 0, this._sliding ? 12 : 7, dt);

    // ---- stride / footsteps ----
    const moving = this._grounded && !this._sliding && !this.mantle;
    if (moving && this._speed > 0.25) {
      const stepLen = 0.9 + this._speed * 0.17;
      this._stridePhase = (this._stridePhase + (this._speed * dt) / (2 * stepLen)) % 1;
      const idx = Math.floor(this._stridePhase * 2);
      if (idx !== this.lastFootIndex) {
        this.lastFootIndex = idx;
        this.ctx.events.emit('player:footstep', {
          surface: this.groundSurface, position: this.position.clone(), speed: this._speed,
          sprinting: this._sprinting, crouched: this._stance !== 'stand',
        });
      }
    }
    this._bobWeight = damp(this._bobWeight, moving ? clamp(this._speed / T.walkSpeed, 0, 1.5) : 0, 8, dt);

    // ---- health ----
    if (this._alive && this.health < T.maxHealth && this.time - this.lastDamageTime > T.regenDelay) {
      this.health = Math.min(T.maxHealth, this.health + T.regenRate * dt);
    }

    // ---- camera height follower ----
    this.updateCamY(dt, this.stepExcess);
    this.stepExcess = 0;

    // ---- enemy-bullet capsule ----
    const r = T.radius;
    this.phys.setPlayerCapsule(
      _v.set(this.position.x, this.position.y + r, this.position.z),
      _v2.set(this.position.x, this.position.y + Math.max(r, this.height - r), this.position.z), r,
    );

    this.updateCamera(dt, ads);
  }

  /** Stance transition time between two capsule heights (s). */
  private stanceDuration(from: number, to: number): number {
    const T = this.tuning;
    const bucket = (h: number) => h < (T.heightProne + T.heightSlide) / 2 ? 0 : h < (T.heightSlide + T.heightCrouch) / 2 ? 1 : h < (T.heightCrouch + T.heightStand) / 2 ? 2 : 3;
    const H = [T.heightProne, T.heightSlide, T.heightCrouch, T.heightStand];
    const a = bucket(from), b = bucket(to);
    let d: number;
    if (!this._alive) d = 0.6;
    else if (b === 1) d = T.tToSlide;
    else if (a === 1) d = b === 3 ? T.tSlideOut + 0.05 : b === 0 ? T.tCrouchProne : T.tSlideOut;
    else if (a === 3 && b === 2 || a === 2 && b === 3) d = T.tStandCrouch;
    else if (a === 2 && b === 0) d = T.tCrouchProne;
    else if (a === 3 && b === 0) d = T.tStandProne;
    else if (a === 0 && b === 2) d = T.tProneCrouch;
    else if (a === 0 && b === 3) d = T.tProneStand;
    else d = T.tStandCrouch;
    // partial transitions (reversing mid-way) take proportionally less time
    const nominal = Math.abs(H[b] - H[a]);
    const frac = nominal > 1e-3 ? clamp(Math.abs(to - from) / nominal, 0.3, 1) : 1;
    return d * frac;
  }

  /**
   * Camera feet-height follower. The camera sits at feet + e, where e absorbs only the vertical jumps the
   * ground slope can't explain (stair risers, curbs, snap-downs) and decays as a critically damped
   * 2nd-order system (ω = camYOmega) with the estimated stair climb rate as velocity feed-forward:
   * ramps, jumps, falls and mantles are followed exactly, stairs become a steady glide with ~zero mean
   * lag, and camera position and velocity stay continuous.
   */
  private updateCamY(dt: number, excess: number): void {
    const T = this.tuning;
    const y = this.position.y;
    if (this.camReset) { this.camE = 0; this.camEV = 0; this.camRate = 0; this.camReset = false; this.camY = y; return; }
    if (excess !== 0) this.camE = clamp(this.camE - excess, -0.6, 0.6);
    // climb-rate estimate from the step stream (decays quickly once the steps stop)
    this.camRate = damp(this.camRate, this.camRateTarget, 14, dt);
    const w = T.camYOmega;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -w * w * this.camE - 2 * w * (this.camEV - this.camRate);
      this.camEV += a * h;
      this.camE += this.camEV * h;
    }
    this.camE = clamp(this.camE, -0.6, 0.6);
    this.camY = y + this.camE;
  }

  private eyeForHeight(h: number): number {
    const T = this.tuning;
    const pts: [number, number][] = [[T.heightProne, T.eyeProne], [T.heightSlide, T.eyeSlide], [T.heightCrouch, T.eyeCrouch], [T.heightStand, T.eyeStand]];
    if (h <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (h <= pts[i][0]) {
        const k = (h - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k;
      }
    }
    return T.eyeStand;
  }

  private updateCamera(dt: number, ads = 0): void {
    const T = this.tuning;
    const eye = _v.set(this.position.x, this.camY + this.eye, this.position.z);
    const hs = this._speed;
    const strafe = clamp((this.velocity.x * this._right.x + this.velocity.z * this._right.z) / T.walkSpeed, -1, 1);
    const fovBase = this.ctx.weapons?.fovTarget ?? T.baseFov;
    const fovKick = (T.fovSprint * this._sprintBlend + (T.fovTacSprint - T.fovSprint) * this._tacBlend + T.fovSlide * this._slideBlend) * (1 - clamp(ads, 0, 1));
    this.rig.update({
      eye, yaw: this.yaw, pitch: this.pitch, lean: this._lean, leanAllowed: this.leanAllowed,
      stridePhase: this._stridePhase, bobWeight: this._bobWeight, sprintBlend: this._sprintBlend, tacBlend: this._tacBlend,
      slideBlend: this._slideBlend, ads, strafe: hs > 0.1 ? strafe : 0,
      mantle: this.mantle ? Math.sin(Math.PI * clamp(this.mantle.t / this.mantle.plan.duration, 0, 1)) : 0,
      deathBlend: this._alive ? 0 : clamp(this.deathTime * 1.5, 0, 1),
      fovBase, fovKick, dt, time: this.time,
    });
    this._eyePos.copy(this.ctx.camera.position);
  }

  private die(): void {
    if (!this._alive) return;
    this._alive = false;
    this.deathTime = 0;
    this._sliding = false; this.mantle = null; this.cancelSprint();
    this.rig.addShake(0.6);
    this.ctx.events.emit('player:died', {});
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

function moveTowards(v: THREE.Vector3, target: THREE.Vector3, maxDelta: number): void {
  const dx = target.x - v.x, dz = target.z - v.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) { v.x = target.x; v.z = target.z; return; }
  v.x += (dx / d) * maxDelta; v.z += (dz / d) * maxDelta;
}

export async function createPlayer(ctx: GameContext): Promise<PlayerState> {
  return new PlayerController(ctx);
}

/** Typed access to the extra player API from `ctx.player`. */
export function playerExt(p: PlayerState): PlayerController {
  return p as PlayerController;
}

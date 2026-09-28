/** Movement / camera tuning (meters, seconds, radians). Mutable at runtime via `player.tuning`. */
export const TUNING = {
  // ---- body ----
  radius: 0.34,
  heightStand: 1.8,
  heightCrouch: 1.22,
  heightSlide: 1.0,
  heightProne: 0.74,
  eyeStand: 1.62,
  eyeCrouch: 1.08,
  eyeSlide: 0.84,
  eyeProne: 0.42,
  skin: 0.02,

  // ---- stance transition times (s, smoothstep) ----
  tStandCrouch: 0.2,
  tCrouchProne: 0.55,
  tStandProne: 0.75,
  tProneCrouch: 0.6,
  tProneStand: 0.8,
  tToSlide: 0.16,
  tSlideOut: 0.22,

  // ---- ground speeds (m/s) ----
  walkSpeed: 4.8,
  sprintSpeed: 7.2,
  tacSprintSpeed: 8.6,
  crouchSpeed: 3.0,
  proneSpeed: 1.05,
  backMul: 0.7,
  strafeMul: 0.8,
  /** Movement speed multiplier at full ADS (weapon may also scale via moveSpeedScale). */
  adsMul: 0.55,
  /** Movement multiplier at full lean. */
  leanMoveMul: 0.5,

  // ---- acceleration ----
  /** Below walk speed: accel = clamp(Δv · rate, 3, max) — eases out, 90 % of walk in ~0.18 s. */
  groundAccelRate: 12.8,
  groundAccelMax: 40,
  /** Walk → sprint → tac ramp (m/s²): ~0.27 s walk→sprint. */
  sprintAccel: 9,
  /** Stopping friction: v -= max(v, stopMinSpeed) · stopFriction · dt (~0.28 s soft tail from walk). */
  stopFriction: 6,
  stopMinSpeed: 2.5,
  /** How fast velocity sideways to the wish direction is removed (m/s²). */
  turnAccel: 40,
  airAccel: 10,
  airDrag: 0.15,

  // ---- vertical ----
  gravity: 20,
  jumpHeight: 0.95,
  /** A jump within this long of the previous one only reaches jumpFatigueMul × height. */
  jumpFatigueWindow: 1.0,
  jumpFatigueMul: 0.8,
  coyoteTime: 0.1,
  jumpBuffer: 0.15,
  maxFallSpeed: 45,
  /** Impact speed (m/s) above which landing hurts, and damage per m/s beyond it. */
  fallDamageSpeed: 12.5,
  fallDamagePerMs: 21,
  /** Landing slow-down (every landing ≥ 3 m/s) and hard landing (impact ≥ hardLandSpeed). */
  landSlowTime: 0.2,
  landSlowMul: 0.75,
  hardLandSpeed: 10,
  hardLandSlowTime: 0.35,
  hardLandSlowMul: 0.5,

  // ---- sprint ----
  tacSprintDuration: 4.0,
  tacSprintRechargeDelay: 1.2,
  tacSprintRechargeTime: 3.5,
  doubleTapWindow: 0.32,
  /** Weapon may fire this long after leaving sprint / tactical sprint. */
  sprintOutTime: 0.24,
  tacSprintOutTime: 0.42,

  // ---- slide ----
  slideMinEntrySpeed: 5.2,
  slideBoostMul: 1.1,
  /** Slide speed cap relative to tactical sprint speed. */
  slideMaxMul: 1.15,
  slideDecelEarly: 4.5,
  slideDecelLate: 8.5,
  slideEarlyTime: 0.4,
  slideEndSpeed: 3.1,
  slideMaxTime: 1.25,
  slideSteer: 1.4, // rad/s
  slideCooldown: 0.8,
  /** A slide within this long of the previous one gets no boost and repeatDurationMul × duration. */
  slideRepeatWindow: 1.5,
  slideRepeatDurationMul: 0.75,
  slideSlopeGain: 0.9,

  // ---- mantle / vault ----
  mantleMinHeight: 0.42,
  /** Mid-air the ledge may be closer to the feet (jumping at a waist-high wall vaults it). */
  mantleMinHeightAir: 0.03,
  mantleMaxHeightGround: 1.35,
  mantleMaxHeightAir: 1.95,
  mantleReach: 0.35, // beyond capsule radius
  mantleReachPerSpeed: 0.03, // extra reach per m/s of horizontal speed
  vaultMaxHeight: 1.35,
  vaultMaxThickness: 0.75,
  /** Vault keeps ≥ this × entry speed; mantle exits at mantleExitMul × entry. */
  vaultSpeedMul: 0.85,
  vaultMinSpeed: 3.0,
  mantleExitMul: 0.8,
  mantleMinExit: 1.0,

  // ---- lean ----
  leanDistance: 0.38,
  leanRoll: 0.07,
  leanTime: 0.12,

  // ---- camera ----
  baseFov: 75,
  /** Movement FOV kicks (the player owns all of them; weapons.fovTarget = base + ADS only). */
  fovSprint: 1.5,
  fovTacSprint: 3,
  fovSlide: 2,
  fovLerp: 8,
  bobWalkY: 0.014,
  bobWalkX: 0.010,
  bobSprintY: 0.026,
  bobSprintX: 0.018,
  bobSprintRoll: 0.010,
  bobSprintYaw: 0.006,
  slideRoll: -0.07,
  recoilKickRate: 40,
  recoilRecoverDelay: 0.09,
  recoilRecoverRate: 5.5,
  /** Fraction of recoil that recovers on its own (the rest stays in the aim, CoD-style). */
  recoilRecoverFraction: 0.12,
  shakeDecay: 1.5,
  shakeMaxAngle: 0.045,
  shakeMaxRoll: 0.06,
  shakeMaxOffset: 0.03,
  shakeFrequency: 17,
  /** Camera height follower (critically damped, velocity feed-forward) natural frequency, rad/s. */
  camYOmega: 22,

  // ---- health ----
  maxHealth: 150,
  regenDelay: 4,
  regenRate: 75,
};

export type Tuning = typeof TUNING;

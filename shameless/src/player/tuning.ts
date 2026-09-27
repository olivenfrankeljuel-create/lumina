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
  /** Seconds (approx.) for a stance height change. */
  stanceTime: 0.16,
  skin: 0.02,

  // ---- ground speeds (m/s) ----
  walkSpeed: 4.6,
  sprintSpeed: 6.1,
  tacSprintSpeed: 6.8,
  crouchSpeed: 2.5,
  proneSpeed: 1.05,
  backMul: 0.82,
  strafeMul: 0.92,
  /** Movement speed multiplier at full ADS (weapon may also scale via moveSpeedScale). */
  adsMul: 0.6,

  // ---- acceleration (m/s²) ----
  groundAccel: 34,
  sprintAccel: 16,
  groundDecel: 30,
  airAccel: 10,
  /** Air speed limit = max(takeoff horizontal speed, this). */
  airMinSpeedCap: 4.6,
  airDrag: 0.15,

  // ---- vertical ----
  gravity: 20,
  jumpHeight: 0.95,
  coyoteTime: 0.1,
  jumpBuffer: 0.15,
  maxFallSpeed: 45,
  /** Impact speed (m/s) above which landing hurts, and damage per m/s beyond it. */
  fallDamageSpeed: 12.5,
  fallDamagePerMs: 14,

  // ---- sprint ----
  tacSprintDuration: 4.0,
  tacSprintRechargeDelay: 1.2,
  tacSprintRechargeTime: 3.5,
  doubleTapWindow: 0.32,

  // ---- slide ----
  slideMinEntrySpeed: 5.2,
  slideBoostMin: 8.0,
  slideBoostMax: 9.2,
  slideBoostMul: 1.12,
  slideDecelEarly: 4.5,
  slideDecelLate: 8.5,
  slideEarlyTime: 0.4,
  slideEndSpeed: 3.1,
  slideMaxTime: 1.25,
  slideSteer: 1.4, // rad/s
  slideCooldown: 0.35,
  slideSlopeGain: 0.9,

  // ---- mantle / vault ----
  mantleMinHeight: 0.42,
  /** Mid-air the ledge may be closer to the feet (jumping at a waist-high wall vaults it). */
  mantleMinHeightAir: 0.03,
  mantleMaxHeightGround: 1.35,
  mantleMaxHeightAir: 1.95,
  mantleReach: 0.62, // beyond capsule radius
  mantleReachPerSpeed: 0.08, // extra reach per m/s of horizontal speed
  vaultMaxHeight: 1.35,
  vaultMaxThickness: 0.75,

  // ---- lean ----
  leanDistance: 0.38,
  leanRoll: 0.13,
  leanTime: 0.12,

  // ---- camera ----
  baseFov: 75,
  fovSprint: 2,
  fovTacSprint: 7,
  fovSlide: 5,
  fovLerp: 8,
  bobWalkY: 0.014,
  bobWalkX: 0.010,
  bobSprintY: 0.026,
  bobSprintX: 0.018,
  bobSprintRoll: 0.010,
  bobSprintYaw: 0.006,
  slideRoll: -0.07,
  slideCamPitch: 0.0,
  recoilKickRate: 40,
  recoilRecoverDelay: 0.09,
  recoilRecoverRate: 5.5,
  /** Fraction of recoil that recovers on its own (the rest stays in the aim). */
  recoilRecoverFraction: 0.55,
  shakeDecay: 1.5,
  shakeMaxAngle: 0.045,
  shakeMaxRoll: 0.06,
  shakeMaxOffset: 0.03,
  shakeFrequency: 17,
  stairSmoothRate: 16,

  // ---- health ----
  maxHealth: 100,
  regenDelay: 4,
  regenRate: 50,
};

export type Tuning = typeof TUNING;

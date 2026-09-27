import * as THREE from 'three';
import type { GameContext, WeaponSystem } from '../core/types';
import { createGunMaterials } from './materials';
import { buildRifle } from './rifle';
import { buildPistol } from './pistol';
import type { WeaponModel } from './model';
import { ArmRig, HandPose, POSE_FLAT, POSE_RELAXED, clonePose, lerpPose, solveGrip, xfToMatrix4, wristFrame } from './arms';
import { SpringN, Track, clamp, damp, lerp, noise1, smootherstep, smoothstep, rng, DEG } from './math';
import { rifleReload, pistolReload, inspectTrack, switchTrack, ReloadAnim, GRIP, MAGSEAT } from './anims';
import { MuzzleFlash, MuzzleSmoke, BrassEjector } from './effects';

type V6 = [number, number, number, number, number, number];

interface WeaponDef {
  id: string;
  model: WeaponModel;
  rpm: number;
  auto: boolean;
  dmg: [number, number];
  range: [number, number];
  magSize: number;
  hipSpread: number; adsSpread: number; bloomShot: number; bloomMax: number; moveSpread: number; airSpread: number;
  recoilV: number; recoilH: number[]; recoilHScale: number; recoilRand: number; adsRecoilMul: number;
  vmKick: number; vmRise: number; vmRoll: number;
  adsTime: number; adsFov: number;
  hip: V6; sprint: V6; tac: V6; slide: V6;
  elbowR: THREE.Vector3; elbowL: THREE.Vector3; shoulderR: THREE.Vector3; shoulderL: THREE.Vector3;
  reloadTac: ReloadAnim; reloadEmpty: ReloadAnim; inspect: Track;
  shell: 'rifle' | 'pistol';
  switchTime: number;
  // runtime
  ammo: number; reserve: number; chambered: boolean;
  rightM: THREE.Matrix4; leftM: THREE.Matrix4; magToWrist: THREE.Matrix4;
  poseR: HandPose; poseRIndexOff: HandPose; poseL: HandPose; poseLMag: HandPose;
}

const RIFLE_H = [0, 0.25, 0.45, 0.35, 0.1, -0.2, -0.45, -0.55, -0.35, 0.05, 0.4, 0.6, 0.45, 0.1, -0.25, -0.55, -0.45, -0.05, 0.35, 0.55, 0.35, -0.05, -0.4, -0.55, -0.25, 0.15, 0.45, 0.4, 0.05, -0.25];

export interface WeaponDebug {
  /** Freeze procedural idle/sway noise (deterministic screenshots). */
  freezeIdle: boolean;
  forceAds: number | null;
  forceSprint: 0 | 1 | 2 | null; // 1 sprint, 2 tactical sprint
  forceSlide: boolean;
  select(id: string): void;
  reloadAt(fraction: number, empty: boolean): void;
  inspectAt(t: number): void;
  fireAndAdvance(t: number): void;
  advance(t: number): void;
  look(dx: number, dy: number): void;
  reset(): void;
  setFireMode(mode: 'auto' | 'semi'): void;
  readonly state: Record<string, unknown>;
}

export async function createWeaponSystem(ctx: GameContext): Promise<WeaponSystem & { debug: WeaponDebug; viewmodel: THREE.Group }> {
  const mats = createGunMaterials(ctx);
  const vmScene = ctx.pipeline.viewmodelScene;
  const vmCam = ctx.pipeline.viewmodelCamera;
  const baseFov = ctx.camera.fov;

  // ------------------------------------------------------------------ scene graph
  const vmRoot = new THREE.Group();
  vmRoot.name = 'viewmodel';
  vmRoot.matrixAutoUpdate = false;
  vmScene.add(vmRoot);
  const holder = new THREE.Group();
  holder.name = 'weaponHolder';
  holder.matrixAutoUpdate = false;
  vmRoot.add(holder);
  const armR = new ArmRig(mats, false);
  const armL = new ArmRig(mats, true);

  // ------------------------------------------------------------------ weapons
  const rifle = buildRifle(mats);
  const pistol = buildPistol(mats);

  const prepHands = (m: WeaponModel) => {
    const rightM = xfToMatrix4(m.rightGrip.wrist);
    const leftM = xfToMatrix4(m.leftGrip.wrist);
    return { rightM, leftM };
  };

  // Rifle grip frames (authored from contact point, finger direction and back-of-hand normal)
  {
    const gAxis = new THREE.Vector3(0, -0.957, 0.289);
    void gAxis;
    rifle.rightGrip.wrist = matToXf(wristFrame(new THREE.Vector3(0.0215, -0.083, 0.052), new THREE.Vector3(-0.30, -0.26, -0.92), new THREE.Vector3(0.93, 0.05, 0.32)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0)));
    rifle.leftGrip.wrist = matToXf(wristFrame(new THREE.Vector3(-0.058, -0.052, -0.315), new THREE.Vector3(0.93, 0.2, -0.3), new THREE.Vector3(-0.42, -0.9, 0.0)));
    pistol.rightGrip.wrist = matToXf(wristFrame(new THREE.Vector3(0.022, -0.074, 0.050), new THREE.Vector3(-0.28, -0.3, -0.91), new THREE.Vector3(0.93, 0.05, 0.3)));
    pistol.leftGrip.wrist = matToXf(wristFrame(new THREE.Vector3(-0.045, -0.100, 0.02), new THREE.Vector3(0.62, 0.35, -0.7), new THREE.Vector3(-0.75, -0.6, -0.2)));
  }

  const mkDef = (m: WeaponModel, o: Partial<WeaponDef>): WeaponDef => {
    const { rightM, leftM } = prepHands(m);
    const def = {
      id: m.id, model: m, rightM, leftM, magToWrist: new THREE.Matrix4(),
      poseR: POSE_RELAXED, poseRIndexOff: POSE_RELAXED, poseL: POSE_RELAXED, poseLMag: POSE_RELAXED,
      chambered: true,
      ...o,
    } as WeaponDef;
    return def;
  };

  const defs: WeaponDef[] = [
    mkDef(rifle, {
      rpm: 800, auto: true, dmg: [30, 22], range: [28, 60], magSize: 30, ammo: 30, reserve: 150,
      hipSpread: 2.4 * DEG, adsSpread: 0.08 * DEG, bloomShot: 0.35 * DEG, bloomMax: 2.2 * DEG, moveSpread: 1.8 * DEG, airSpread: 4 * DEG,
      recoilV: 0.0074, recoilH: RIFLE_H, recoilHScale: 0.0034, recoilRand: 0.0011, adsRecoilMul: 0.72,
      vmKick: 1.25, vmRise: 1.1, vmRoll: 0.9,
      adsTime: 0.25, adsFov: baseFov * 0.78,
      hip: [0.098, -0.108, -0.232, 0.012, 0.035, 0.0],
      sprint: [-0.035, -0.04, 0.03, -0.45, 0.62, 0.40],
      tac: [-0.06, 0.03, 0.045, 0.95, 0.35, 0.95],
      slide: [-0.02, -0.02, 0.01, 0.02, 0.08, 0.32],
      elbowR: new THREE.Vector3(0.24, -0.40, 0.02), elbowL: new THREE.Vector3(-0.17, -0.38, -0.30),
      shoulderR: new THREE.Vector3(0.22, -0.22, 0.25), shoulderL: new THREE.Vector3(-0.22, -0.22, 0.2),
      reloadTac: rifleReload(false), reloadEmpty: rifleReload(true), inspect: inspectTrack('rifle'),
      shell: 'rifle', switchTime: 0.26,
    }),
    mkDef(pistol, {
      rpm: 420, auto: false, dmg: [34, 24], range: [15, 35], magSize: 17, ammo: 17, reserve: 68,
      hipSpread: 2.0 * DEG, adsSpread: 0.12 * DEG, bloomShot: 0.6 * DEG, bloomMax: 2.5 * DEG, moveSpread: 1.4 * DEG, airSpread: 3.5 * DEG,
      recoilV: 0.011, recoilH: [0, 0.3, -0.2, 0.4, -0.35, 0.2, -0.1, 0.3, -0.3, 0.1], recoilHScale: 0.004, recoilRand: 0.002, adsRecoilMul: 0.75,
      vmKick: 1.1, vmRise: 2.0, vmRoll: 0.6,
      adsTime: 0.2, adsFov: baseFov * 0.85,
      hip: [0.075, -0.078, -0.30, 0.03, 0.05, 0.0],
      sprint: [-0.03, -0.07, 0.06, -0.6, 0.4, 0.5],
      tac: [-0.05, 0.05, 0.06, 1.0, 0.3, 0.6],
      slide: [-0.02, -0.02, 0.01, 0.02, 0.1, 0.35],
      elbowR: new THREE.Vector3(0.20, -0.36, -0.03), elbowL: new THREE.Vector3(-0.12, -0.38, -0.05),
      shoulderR: new THREE.Vector3(0.2, -0.2, 0.25), shoulderL: new THREE.Vector3(-0.2, -0.2, 0.25),
      reloadTac: pistolReload(false, matToXf(pistol.magSeat)), reloadEmpty: pistolReload(true, matToXf(pistol.magSeat)), inspect: inspectTrack('pistol'),
      shell: 'pistol', switchTime: 0.22,
    }),
  ];

  // Solve hand poses once per weapon (fingers wrap the actual surfaces).
  for (const d of defs) {
    const m = d.model;
    // off hand on the magazine: authored in magazine space (mag front toward -Z, body down -Y)
    const w = wristFrame(new THREE.Vector3(-0.0255, -0.066, -0.028), new THREE.Vector3(0.12, 0.25, -1), new THREE.Vector3(-1, 0.05, 0.1));
    if (m.kind === 'pistol') w.copy(wristFrame(new THREE.Vector3(-0.024, -0.075, -0.012), new THREE.Vector3(0.1, 0.15, -1), new THREE.Vector3(-1, 0.05, 0.1)));
    // wristFrame expects the palm contact; convert contact->wrist (palm center is 4.5cm up the hand, 1.6cm palmar)
    d.magToWrist.copy(contactToWrist(w));
    d.poseLMag = solveGrip(armL.hand, d.magToWrist, m.leftPoses.mag, POSE_FLAT, { maxFlex: [1.5, 1.7, 1.3] });
    d.rightM = contactToWrist(d.rightM);
    d.leftM = contactToWrist(d.leftM);
    d.poseR = solveGrip(armR.hand, d.rightM, m.rightGrip, POSE_FLAT);
    d.poseRIndexOff = clonePose(d.poseR);
    d.poseRIndexOff.f[0] = [0.1, 0.12, 0.06];
    d.poseRIndexOff.s[0] = 0.0;
    d.poseL = solveGrip(armL.hand, d.leftM, m.leftGrip, POSE_FLAT);
  }

  // Now attach arms & weapons
  vmRoot.add(armR.group, armL.group);
  for (const d of defs) { holder.add(d.model.root); d.model.root.visible = false; }

  // ------------------------------------------------------------------ effects
  const flash = new MuzzleFlash();
  holder.add(flash.group);
  holder.add(flash.light);
  const smoke = new MuzzleSmoke();
  vmRoot.add(smoke.group);
  const worldFlash = new THREE.PointLight(0xffb070, 0, 9, 2);
  ctx.scene.add(worldFlash);
  const brass = new BrassEjector(mats, (c, vel, kind) => {
    // hand the casing to the world FX system
    const p = c.getWorldPosition(new THREE.Vector3());
    const pc = p.clone().applyMatrix4(vmCam.matrixWorldInverse);
    const world = vmToWorld(pc, new THREE.Vector3());
    const v = vel.clone().applyQuaternion(ctx.camera.getWorldQuaternion(new THREE.Quaternion())).add(ctx.player.velocity);
    ctx.events.emit('shell:eject', { position: world, velocity: v, kind });
  });
  vmRoot.add(brass.group);

  // ------------------------------------------------------------------ state
  let cur = 0;
  let pending = -1; // weapon switching to
  let switchPhase: 'none' | 'lower' | 'raise' = 'none';
  let switchT = 0;
  const sw = switchTrack();
  let adsLin = 0, adsE = 0;
  let sprintBlend = 0, tacBlend = 0, slideBlend = 0, crouchBlend = 0;
  let tacActive = false, lastSprintPress = -10;
  let cooldown = 0;
  let shotIndex = 0, lastShotTime = -10;
  let bloom = 0;
  let spreadAngle = 0;
  let reloadT = -1, reloadEmpty = false;
  let reloadEventsFired = new Set<number>();
  let inspectT = -1;
  let boltT = 10, boltLocked = false, boltRelease = 1;
  let dustOpen = false;
  let dustAngle = 0, dustVel = 0;
  let triggerPull = 0;
  let fireMode: 'auto' | 'semi' = 'auto';
  let dryFireCooldown = 0;
  let stride = 0;
  let time = 0;
  let wasGrounded = true;
  const oldMagFree = { active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), ang: new THREE.Vector3() };

  // springs (6 channels: x y z pitch yaw roll)
  const swaySpring = SpringN.critical(6, 5.5, 0.62);
  const impulseSpring = SpringN.critical(6, 4.5, 0.5);
  const recoilSpring = SpringN.critical(6, 8.5, 0.42);
  const recoilSlow = SpringN.critical(6, 2.6, 0.9);
  const lookVel = new THREE.Vector2();

  const rand = rng(1337);

  // temps
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const poseXf: number[] = [0, 0, 0, 0, 0, 0];
  const tmpArr: number[] = [];
  const handPoseTmp = clonePose(POSE_RELAXED);
  const handPoseTmp2 = clonePose(POSE_RELAXED);
  const debug: WeaponDebug = {
    freezeIdle: false, forceAds: null, forceSprint: null, forceSlide: false,
    select(id: string) { const i = defs.findIndex((d) => d.id === id); if (i >= 0) { activate(i); } },
    reloadAt(f: number, empty: boolean) {
      const d = defs[cur];
      startReload(empty);
      const anim = reloadEmpty ? d.reloadEmpty : d.reloadTac;
      stepFixed(anim.duration * f);
    },
    inspectAt(t: number) { inspectT = 0; stepFixed(t); },
    fireAndAdvance(t: number) { shoot(); stepFixed(t); },
    advance(t: number) { stepFixed(t); },
    look(dx: number, dy: number) { lookVel.set(dx, dy); },
    reset() {
      reloadT = -1; inspectT = -1; switchPhase = 'none'; adsLin = adsE = 0; sprintBlend = tacBlend = slideBlend = 0;
      swaySpring.reset(); impulseSpring.reset(); recoilSpring.reset(); recoilSlow.reset(); bloom = 0; boltT = 10; boltLocked = false;
      const d = defs[cur]; d.ammo = d.magSize; lookVel.set(0, 0); oldMagFree.active = false; triggerPull = 0;
    },
    setFireMode(m) { fireMode = m; },
    get state() { return { cur: defs[cur].id, adsE, sprintBlend, tacBlend, reloadT, inspectT, ammo: defs[cur].ammo, spread: spreadAngle }; },
  };
  let stepping = false;
  function stepFixed(t: number) {
    stepping = true;
    const dt = 1 / 60;
    let left = t;
    while (left > 1e-6) { const h = Math.min(dt, left); update(h); left -= h; }
    stepping = false;
  }

  function activate(i: number) {
    defs.forEach((d, j) => (d.model.root.visible = j === i));
    cur = i;
    reloadT = -1; inspectT = -1;
    const m = defs[i].model;
    resetMags(m);
  }
  function resetMags(m: WeaponModel) {
    m.mag.visible = true;
    m.mag.matrixAutoUpdate = true;
    applyMatrix(m.mag, m.magSeat);
    m.magNew.visible = false;
    oldMagFree.active = false;
  }
  activate(0);

  function startReload(empty: boolean) {
    const d = defs[cur];
    reloadT = 0;
    reloadEmpty = empty;
    reloadEventsFired = new Set();
    inspectT = -1;
    resetMags(d.model);
    ctx.events.emit('weapon:reload', { weaponId: d.id, stage: 'start', empty });
  }

  // ------------------------------------------------------------------ helpers
  function matToXfLocal(m: THREE.Matrix4): number[] { return matToXf(m); }
  void matToXfLocal;

  /** Maps a viewmodel camera-space point to a world-space point along the same screen ray. */
  function vmToWorld(pc: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const dist = pc.length();
    _v.copy(pc).applyMatrix4(vmCam.projectionMatrix);
    ctx.camera.updateMatrixWorld();
    const camPos = _v2.setFromMatrixPosition(ctx.camera.matrixWorld);
    out.set(_v.x, _v.y, 0.5).unproject(ctx.camera).sub(camPos).normalize();
    return out.multiplyScalar(dist).add(camPos);
  }
  function nodeCamSpace(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld).applyMatrix4(vmCam.matrixWorldInverse);
  }

  // ------------------------------------------------------------------ firing
  function shoot() {
    const d = defs[cur];
    const m = d.model;
    if (time - lastShotTime > 0.32) shotIndex = 0;
    lastShotTime = time;
    d.ammo--;
    cooldown += 60 / d.rpm;
    triggerPull = 1;
    ctx.camera.updateMatrixWorld();
    const origin = ctx.camera.getWorldPosition(new THREE.Vector3());
    const fwd = ctx.camera.getWorldDirection(new THREE.Vector3());
    // spread cone (uniform in disc)
    const ang = spreadAngle * Math.sqrt(rand());
    const phi = rand() * Math.PI * 2;
    const right = new THREE.Vector3().setFromMatrixColumn(ctx.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(ctx.camera.matrixWorld, 1);
    const dir = fwd.clone().addScaledVector(right, Math.cos(phi) * Math.tan(ang)).addScaledVector(up, Math.sin(phi) * Math.tan(ang)).normalize();

    // muzzle in world space (viewmodel muzzle mapped onto the world camera's screen ray)
    vmRoot.updateMatrixWorld(true);
    const muzzleCam = nodeCamSpace(m.muzzle, new THREE.Vector3());
    const muzzleWorld = vmToWorld(muzzleCam, new THREE.Vector3());
    ctx.events.emit('weapon:fire', { weaponId: d.id, origin: origin.clone(), dir: dir.clone(), muzzle: muzzleWorld.clone(), suppressed: false });

    const hit = ctx.physics.raycast(origin, dir, 400, { ignorePlayer: true });
    const end = hit ? hit.point.clone() : origin.clone().addScaledVector(dir, 400);
    if (hit) {
      if (hit.enemyId !== undefined) {
        const t = smoothstep(d.range[0], d.range[1], hit.distance);
        const dmg = lerp(d.dmg[0], d.dmg[1], t);
        // region multiplier (head x2.x etc.) is applied by EnemyManager.applyHit based on `region`
        ctx.enemies.applyHit(hit.enemyId, dmg, hit.point.clone(), dir.clone(), hit.region ?? 'torso');
      } else {
        ctx.events.emit('bullet:impact', { point: hit.point.clone(), normal: hit.normal.clone(), surface: hit.surface, object: hit.object ?? undefined, dir: dir.clone() });
      }
    }
    ctx.events.emit('bullet:tracer', { from: muzzleWorld.clone(), to: end, enemy: false });

    // camera recoil (designed pattern + noise), reduced in ADS
    const adsMul = lerp(1, d.adsRecoilMul, adsE);
    const i = shotIndex;
    const first = i < 3 ? 1.25 - i * 0.08 : 1 + Math.min(0.15, i * 0.006);
    const pv = d.recoilV * first * adsMul * (1 + (rand() - 0.5) * 0.25);
    const ph = (d.recoilH[i % d.recoilH.length] * d.recoilHScale + (rand() - 0.5) * d.recoilRand) * adsMul;
    ctx.player.addRecoil(pv, -ph);
    ctx.player.addCameraShake(m.kind === 'rifle' ? 0.12 : 0.18);
    shotIndex++;

    // viewmodel recoil
    const vk = lerp(1, 0.45, adsE);
    recoilSpring.impulse(2, d.vmKick * vk * (0.9 + rand() * 0.2));            // back
    recoilSpring.impulse(1, 0.12 * vk);                                      // up
    recoilSpring.impulse(3, d.vmRise * vk * (0.85 + rand() * 0.3));          // muzzle rise
    recoilSpring.impulse(4, (rand() - 0.5) * 0.9 * vk);                      // yaw jitter
    recoilSpring.impulse(5, (rand() - 0.5) * 2 * d.vmRoll * vk);             // roll jitter
    recoilSpring.impulse(0, (rand() - 0.5) * 0.12 * vk);
    recoilSlow.impulse(2, 0.18 * vk);
    recoilSlow.impulse(3, 0.10 * vk);

    // spread bloom
    bloom = Math.min(d.bloomMax, bloom + d.bloomShot);

    // effects
    flash.fire(m.kind === 'rifle' ? 1.0 : 0.7, m.kind === 'rifle', adsE);
    worldFlash.position.copy(muzzleWorld);
    worldFlash.intensity = 6;
    boltT = 0;
    if (m.dustCover && !dustOpen) { dustOpen = true; dustVel = -40; }
    const smokePos = muzzleCam.clone();
    const smokeDir = new THREE.Vector3(0, 0, -1).applyQuaternion(m.muzzle.getWorldQuaternion(_q)).applyQuaternion(_q.setFromRotationMatrix(vmCam.matrixWorldInverse));
    smoke.emit(smokePos, smokeDir, smoke.heat);
    // brass
    const ep = nodeCamSpace(m.eject, new THREE.Vector3());
    const gq = new THREE.Quaternion().setFromRotationMatrix(_m.copy(holder.matrix));
    const ev = new THREE.Vector3(1, 0.55 + rand() * 0.2, 0.25 + rand() * 0.2).applyQuaternion(gq).multiplyScalar(m.kind === 'rifle' ? 2.6 : 2.0);
    brass.eject(ep, ev, gq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))), d.shell);
    if (d.ammo <= 0) { boltLocked = true; d.chambered = false; }
  }

  // ------------------------------------------------------------------ per-frame
  const input = ctx.input;
  ctx.events.on('player:jump', () => { impulseSpring.impulse(1, -0.35); impulseSpring.impulse(3, -0.5); });
  ctx.events.on('player:land', (e) => {
    const s = clamp(e.impactSpeed / 8, 0.15, 1.2);
    impulseSpring.impulse(1, -0.9 * s); impulseSpring.impulse(3, -1.4 * s); impulseSpring.impulse(5, (rand() - 0.5) * s);
  });
  ctx.events.on('player:footstep', () => {
    // phase-lock the bob so the low point lands on the footstep
    const target = Math.round((stride - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
    stride = lerp(stride, target, 0.35);
  });

  function update(dt: number) {
    time += dt;
    const d = defs[cur];
    const m = d.model;
    const p = ctx.player;
    const dbg = debug;

    // --- inputs
    const firing = !stepping && input.down.has('fire');
    const firePressed = !stepping && input.pressed.has('fire');
    const adsHeld = dbg.forceAds !== null ? dbg.forceAds > 0.5 : input.down.has('ads');
    if (!stepping) {
      if (input.pressed.has('weapon1') && cur !== 0) requestSwitch(0);
      if (input.pressed.has('weapon2') && cur !== 1) requestSwitch(1);
      if (input.pressed.has('swap')) requestSwitch((pending >= 0 ? pending : cur) === 0 ? 1 : 0);
      if (input.pressed.has('inspect') && reloadT < 0 && switchPhase === 'none') inspectT = 0;
      if (input.pressed.has('reload') && reloadT < 0 && switchPhase === 'none' && d.ammo < d.magSize && d.reserve > 0) startReload(d.ammo <= 0);
      if (input.pressed.has('sprint')) {
        if (time - lastSprintPress < 0.35 || p.sprinting) tacActive = true;
        lastSprintPress = time;
      }
    }
    const sprintState = dbg.forceSprint !== null ? dbg.forceSprint : p.sprinting && p.grounded ? (tacActive ? 2 : 1) : 0;
    if (!p.sprinting && dbg.forceSprint === null) tacActive = false;

    // --- blends
    const canAds = reloadT < 0 && switchPhase === 'none' && sprintState === 0;
    const adsTarget = dbg.forceAds !== null ? dbg.forceAds : adsHeld && canAds ? 1 : 0;
    const prevAds = adsLin;
    adsLin = clamp(adsLin + (adsTarget > adsLin ? 1 : -1) * dt / d.adsTime, Math.min(adsTarget, adsLin), Math.max(adsTarget, adsLin));
    if (dbg.forceAds !== null && stepping === false) adsLin = dbg.forceAds;
    adsE = smootherstep(0, 1, adsLin);
    if ((prevAds < 0.5) !== (adsLin < 0.5)) ctx.events.emit('weapon:ads', { active: adsLin >= 0.5 });
    sprintBlend = damp(sprintBlend, sprintState === 1 ? 1 : 0, 9, dt);
    tacBlend = damp(tacBlend, sprintState === 2 ? 1 : 0, 8, dt);
    slideBlend = damp(slideBlend, p.sliding || dbg.forceSlide ? 1 : 0, 10, dt);
    crouchBlend = damp(crouchBlend, p.crouched ? 1 : 0, 8, dt);
    if (sprintState > 0 && inspectT >= 0) inspectT = -1;

    // --- switching
    if (switchPhase === 'lower') {
      switchT += dt;
      if (switchT >= sw.lower.duration) {
        activate(pending);
        pending = -1;
        switchPhase = 'raise';
        switchT = 0;
      }
    } else if (switchPhase === 'raise') {
      switchT += dt;
      if (switchT >= sw.raise.duration) switchPhase = 'none';
    }

    // --- reload progression
    if (reloadT >= 0) {
      const anim = reloadEmpty ? d.reloadEmpty : d.reloadTac;
      reloadT += dt;
      anim.events.forEach(([t, stage], idx) => {
        if (reloadT >= t && !reloadEventsFired.has(idx)) {
          reloadEventsFired.add(idx);
          ctx.events.emit('weapon:reload', { weaponId: d.id, stage, empty: reloadEmpty });
          if (stage === 'magin') {
            const need = d.magSize - Math.max(0, d.ammo);
            const take = Math.min(need, d.reserve);
            d.reserve -= take; d.ammo += take;
            impulseSpring.impulse(1, 0.25); impulseSpring.impulse(3, 0.35);
          }
          if (stage === 'magout') { impulseSpring.impulse(1, -0.12); }
          if (stage === 'bolt') { boltLocked = false; boltRelease = 0; d.chambered = true; impulseSpring.impulse(2, 0.35); impulseSpring.impulse(5, 0.4); }
        }
      });
      if (anim.drop && reloadT >= anim.dropAt && !oldMagFree.active && reloadT < anim.oldMagHiddenAt) {
        oldMagFree.active = true;
        m.mag.updateMatrix();
        oldMagFree.pos.copy(m.mag.position);
        oldMagFree.rot.copy(m.mag.rotation);
        oldMagFree.vel.set(0, -0.5, 0);
        oldMagFree.ang.set(-1.5 + rand(), (rand() - 0.5) * 2, (rand() - 0.5) * 3);
      }
      if (reloadT >= anim.duration) {
        reloadT = -1;
        resetMags(m);
        if (!boltLocked) d.chambered = true;
        ctx.events.emit('weapon:reload', { weaponId: d.id, stage: 'end', empty: reloadEmpty });
      }
    }
    if (inspectT >= 0) { inspectT += dt; if (inspectT >= d.inspect.duration) inspectT = -1; }

    // --- firing
    cooldown = Math.max(0, cooldown - dt);
    dryFireCooldown -= dt;
    const busy = reloadT >= 0 || switchPhase !== 'none' || sprintBlend > 0.3 || tacBlend > 0.3;
    const wantFire = (d.auto && fireMode === 'auto') ? firing : firePressed;
    if (wantFire && !busy) {
      if (inspectT >= 0) inspectT = -1;
      if (d.ammo > 0 && cooldown <= 0) shoot();
      else if (d.ammo <= 0 && firePressed && dryFireCooldown <= 0) {
        ctx.events.emit('weapon:dryfire', { weaponId: d.id });
        dryFireCooldown = 0.25;
        if (d.reserve > 0) startReload(true);
      }
    }
    if (!firing) cooldown = Math.min(cooldown, 0.02);
    triggerPull = damp(triggerPull, firing && !busy ? 1 : 0, 30, dt);

    // --- spread
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    bloom = Math.max(0, bloom - dt * (time - lastShotTime > 0.12 ? 7 : 1.5) * DEG);
    const moveK = clamp(speed / 4.5, 0, 1.4);
    const target = lerp(d.hipSpread * (p.crouched ? 0.8 : 1) + moveK * d.moveSpread + (p.grounded ? 0 : d.airSpread), d.adsSpread + moveK * d.moveSpread * 0.1, adsE) + bloom * lerp(1, 0.25, adsE);
    spreadAngle = damp(spreadAngle, target, 14, dt);

    // --- look sway
    if (!stepping) lookVel.set(input.mouseDX * input.sensitivity / Math.max(dt, 1e-3), input.mouseDY * input.sensitivity / Math.max(dt, 1e-3));
    const swayK = lerp(1, 0.18, adsE);
    const lx = clamp(lookVel.x * 0.022, -0.075, 0.075) * swayK, ly = clamp(lookVel.y * 0.022, -0.06, 0.06) * swayK;
    swaySpring.target[0] = -lx * 0.35; swaySpring.target[1] = ly * 0.3;
    swaySpring.target[3] = ly; swaySpring.target[4] = lx; swaySpring.target[5] = -lx * 0.9;
    swaySpring.update(dt);
    impulseSpring.update(dt);
    recoilSpring.update(dt);
    recoilSlow.update(dt);

    // landing detection fallback (if the player module does not emit events)
    if (p.grounded && !wasGrounded) { /* handled by player:land event when available */ }
    wasGrounded = p.grounded;

    // --- bob
    const grounded = p.grounded ? 1 : 0;
    const cycle = sprintState > 0 ? 4.4 : 3.3;
    stride += (2 * Math.PI * speed / cycle) * dt * grounded;
    const bobA = clamp(speed / 4.5, 0, 1.6) * grounded * lerp(1, 0.12, adsE);
    const sp = sprintBlend + tacBlend;
    const bx = Math.sin(stride) * 0.0065 * bobA * (1 + sp * 0.8);
    const by = -Math.abs(Math.cos(stride)) * 0.0075 * bobA * (1 + sp * 0.9) + 0.0035 * bobA;
    const bRoll = Math.sin(stride) * 0.022 * bobA * (1 + sp);
    const bYaw = Math.sin(stride) * 0.012 * bobA;
    const bPitch = Math.cos(stride * 2) * 0.012 * bobA * (1 + sp * 1.4);

    // --- idle breathing
    const idleK = dbg.freezeIdle ? 0 : lerp(1, 0.3, adsE) * (1 - clamp(bobA, 0, 1) * 0.5);
    const br = time * 1.35;
    const iy = (Math.sin(br) * 0.0011 + noise1(time * 0.35, 1) * 0.0006) * idleK;
    const ipitch = (Math.sin(br + 0.7) * 0.0035 + noise1(time * 0.3, 2) * 0.0035) * idleK;
    const iyaw = noise1(time * 0.27, 3) * 0.005 * idleK;
    const iroll = noise1(time * 0.22, 4) * 0.004 * idleK;

    // --- compose pose (camera space, rotation about pivot)
    const pv = m.pivot;
    const ads: V6 = [-(m.sightPoint.x - pv.x), -(m.sightPoint.y - pv.y), -m.eyeRelief - (m.sightPoint.z - pv.z), 0, 0, 0];
    for (let i = 0; i < 6; i++) poseXf[i] = lerp(d.hip[i], ads[i], adsE);
    const nonAds = 1 - adsE;
    for (let i = 0; i < 6; i++) {
      poseXf[i] += d.sprint[i] * sprintBlend * nonAds + d.tac[i] * tacBlend * nonAds + d.slide[i] * slideBlend * nonAds;
    }
    poseXf[1] -= 0.006 * crouchBlend * nonAds; poseXf[5] -= 0.04 * crouchBlend * nonAds;
    poseXf[5] += p.lean * 0.1 * nonAds;
    // animation layers
    if (reloadT >= 0) {
      const anim = reloadEmpty ? d.reloadEmpty : d.reloadTac;
      anim.gun.eval(reloadT, tmpArr);
      for (let i = 0; i < 6; i++) poseXf[i] += tmpArr[i];
    }
    if (inspectT >= 0) { d.inspect.eval(inspectT, tmpArr); for (let i = 0; i < 6; i++) poseXf[i] += tmpArr[i]; }
    if (switchPhase !== 'none') {
      (switchPhase === 'lower' ? sw.lower : sw.raise).eval(switchT, tmpArr);
      for (let i = 0; i < 6; i++) poseXf[i] += tmpArr[i];
    }
    const sv = swaySpring.value, iv = impulseSpring.value, rv = recoilSpring.value, rs = recoilSlow.value;
    poseXf[0] += bx + sv[0] + iv[0] + rv[0] * 0.02;
    poseXf[1] += by + iy + sv[1] + iv[1] * 0.03 + rv[1] * 0.02;
    poseXf[2] += iv[2] * 0.03 + rv[2] * 0.02 + rs[2] * 0.03;
    poseXf[3] += bPitch + ipitch + sv[3] + iv[3] * 0.03 + rv[3] * 0.03 + rs[3] * 0.03;
    poseXf[4] += bYaw + iyaw + sv[4] + iv[4] * 0.03 + rv[4] * 0.03;
    poseXf[5] += bRoll + iroll + sv[5] + iv[5] * 0.03 + rv[5] * 0.03;

    // holder = T(pos) * R(rot) * T(-pivot)
    _e.set(poseXf[3], poseXf[4], poseXf[5], 'YXZ');
    _q.setFromEuler(_e);
    holder.matrix.compose(_v.set(poseXf[0], poseXf[1], poseXf[2]), _q, _s).multiply(_m.makeTranslation(-pv.x, -pv.y, -pv.z));
    holder.matrixWorldNeedsUpdate = true;
    vmCam.updateMatrixWorld();
    vmRoot.matrix.copy(vmCam.matrixWorld);
    vmRoot.matrixWorldNeedsUpdate = true;

    // --- moving parts
    // bolt / slide cycle: fast rearward stroke, return; lock back on empty
    boltT += dt;
    const cyc = m.kind === 'rifle' ? 0.058 : 0.07;
    let bo = boltT < cyc * 0.4 ? boltT / (cyc * 0.4) : Math.max(0, 1 - (boltT - cyc * 0.4) / (cyc * 0.6));
    if (boltLocked && boltT >= cyc * 0.4) bo = 1;
    if (!boltLocked && boltRelease < 1) { boltRelease = Math.min(1, boltRelease + dt / 0.05); bo = Math.max(bo, 1 - boltRelease); }
    m.bolt.position.z = bo * m.boltTravel;
    if (m.dustCover) {
      const target = dustOpen ? -1.95 : 0;
      dustVel += ((target - dustAngle) * 900 - dustVel * 18) * dt;
      dustAngle += dustVel * dt;
      if (dustOpen && dustAngle < -1.95) { dustAngle = -1.95; dustVel = -dustVel * 0.35; }
      m.dustCover.rotation.z = dustAngle;
    }
    m.trigger.rotation.x = -0.22 * triggerPull;
    if (m.boltCatch) {
      const bc = reloadT >= 0 && reloadEmpty && d.reloadEmpty.boltCatch ? d.reloadEmpty.boltCatch.eval(reloadT, tmpArr)[0] : 0;
      m.boltCatch.rotation.x = (boltLocked ? -0.12 : 0) + bc * 0.2;
    }
    if (m.selector) m.selector.rotation.x = fireMode === 'auto' ? -Math.PI : -Math.PI / 2;

    // --- magazines
    const anim = reloadT >= 0 ? (reloadEmpty ? d.reloadEmpty : d.reloadTac) : null;
    let handMag: THREE.Matrix4 | null = null;
    if (anim) {
      const t = reloadT;
      // old mag
      if (oldMagFree.active) {
        oldMagFree.vel.y -= 9.8 * dt;
        oldMagFree.pos.addScaledVector(oldMagFree.vel, dt);
        oldMagFree.rot.x += oldMagFree.ang.x * dt; oldMagFree.rot.y += oldMagFree.ang.y * dt; oldMagFree.rot.z += oldMagFree.ang.z * dt;
        m.mag.position.copy(oldMagFree.pos); m.mag.rotation.copy(oldMagFree.rot);
        m.mag.visible = t < anim.oldMagHiddenAt;
      } else if (t >= anim.oldMagHandFrom && t < anim.oldMagHiddenAt) {
        anim.magPath.eval(t, tmpArr);
        handMag = xfToMatrix4(tmpArr, _m2);
        applyMatrix(m.mag, handMag);
      } else if (t >= anim.oldMagHiddenAt) {
        m.mag.visible = false;
      }
      if (t >= anim.newMagFrom) {
        m.magNew.visible = true;
        if (t < anim.seatAt) {
          anim.magPath.eval(t, tmpArr);
          handMag = xfToMatrix4(tmpArr, _m2);
          applyMatrix(m.magNew, handMag);
        } else {
          applyMatrix(m.magNew, m.magSeat);
          handMag = _m2.copy(m.magSeat);
        }
      }
      if (!handMag) handMag = _m2.copy(m.magSeat);
    }

    // --- hands
    // right hand: rigid on the grip; index on trigger / off trigger
    const indexOff = Math.max(sprintBlend, tacBlend, anim ? anim.indexOff.eval(reloadT, tmpArr)[0] : 0, inspectT >= 0 ? smoothstep(0, 0.3, inspectT) * (1 - smoothstep(d.inspect.duration - 0.3, d.inspect.duration, inspectT)) : 0, switchPhase !== 'none' ? 1 : 0);
    lerpPose(d.poseR, d.poseRIndexOff, indexOff, handPoseTmp);
    handPoseTmp.f[0][0] += 0.12 * triggerPull; handPoseTmp.f[0][1] += 0.18 * triggerPull;
    armR.hand.applyPose(handPoseTmp);
    const rightCam = _m.multiplyMatrices(holder.matrix, d.rightM);
    const elbowFollow = _v.set(poseXf[0] - d.hip[0], poseXf[1] - d.hip[1], poseXf[2] - d.hip[2]);
    armR.update(rightCam, _v2.copy(d.elbowR).addScaledVector(elbowFollow, 0.6), d.shoulderR);

    // left hand
    let leftGun: THREE.Matrix4;
    if (anim && handMag) {
      anim.left.eval(reloadT, tmpArr);
      const free = resolveWrist(tmpArr, d, m.magSeat);
      const w = anim.onMag.eval(reloadT, [])[0];
      const onMag = _m.multiplyMatrices(handMag, d.magToWrist);
      leftGun = blendMatrices(free, onMag, w);
      const pw = anim.pose.eval(reloadT, []);
      // pose weights: grip, magGrip, flat, relaxed
      const tot = pw[0] + pw[1] + pw[2] + pw[3] || 1;
      lerpPose(POSE_RELAXED, d.poseL, pw[0] / tot, handPoseTmp2);
      blendInto(handPoseTmp2, d.poseLMag, pw[1] / tot);
      blendInto(handPoseTmp2, POSE_FLAT, pw[2] / tot);
      armL.hand.applyPose(handPoseTmp2);
    } else {
      leftGun = d.leftM;
      armL.hand.applyPose(d.poseL);
    }
    const leftCam = new THREE.Matrix4().multiplyMatrices(holder.matrix, leftGun);
    const lw = _v.setFromMatrixPosition(leftCam);
    const lHint = _v2.copy(d.elbowL).addScaledVector(elbowFollow, 0.6);
    // keep the elbow below/behind the wrist when the hand travels (reload)
    lHint.y = Math.min(lHint.y, lw.y - 0.2);
    armL.update(leftCam, lHint, d.shoulderL);

    // --- reticle
    if (m.lens && m.reticle) {
      vmRoot.updateMatrixWorld(true);
      m.lens.updateWorldMatrix(true, false);
      const camWorld = _v.setFromMatrixPosition(vmCam.matrixWorld);
      m.reticle.uniforms.uCamLocal.value.copy(camWorld).applyMatrix4(_m.copy(m.lens.matrixWorld).invert());
      m.reticle.uniforms.uTime.value = time;
      m.reticle.uniforms.uADS.value = adsE;
    }

    // --- effects
    flash.group.position.copy(m.muzzle.position).applyMatrix4(m.root.matrix);
    flash.light.position.copy(flash.group.position).add(_v.set(0.01, 0.03, 0.03));
    flash.update(dt);
    worldFlash.intensity = Math.max(0, worldFlash.intensity - dt * 160);
    const camVel = _v.set(0, 0, 0);
    smoke.update(dt, camVel);
    brass.update(dt, camVel);

    // --- outputs
    ctx.pipeline.setADS(adsE);
  }

  function requestSwitch(i: number) {
    if (i === cur && switchPhase === 'none') return;
    pending = i;
    if (switchPhase === 'none' || switchPhase === 'raise') { switchPhase = 'lower'; switchT = 0; }
    reloadT = -1; inspectT = -1;
    resetMags(defs[cur].model);
    ctx.events.emit('weapon:switch', { weaponId: defs[i].id });
  }

  function resolveWrist(x: number[], d: WeaponDef, magSeat: THREE.Matrix4): THREE.Matrix4 {
    if (x[0] === GRIP[0]) return d.leftM;
    if (x[0] === MAGSEAT[0]) return new THREE.Matrix4().multiplyMatrices(magSeat, d.magToWrist);
    return xfToMatrix4(x);
  }

  const sys = {
    get currentId() { return defs[cur].id; },
    get ammoInMag() { return defs[cur].ammo; },
    get magSize() { return defs[cur].magSize; },
    get reserveAmmo() { return defs[cur].reserve; },
    get adsAmount() { return adsE; },
    get reloading() { return reloadT >= 0; },
    get fovTarget() { return lerp(baseFov + tacBlend * 4 + sprintBlend * 2, defs[cur].adsFov, adsE); },
    get spread() { return clamp(spreadAngle / (8 * DEG), 0, 1); },
    update(dt: number) { update(dt); },
    debug,
    viewmodel: vmRoot,
  };
  return sys;
}

// ---------------------------------------------------------------------------------------------
function matToXf(m: THREE.Matrix4): [number, number, number, number, number, number] {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return [p.x, p.y, p.z, e.x, e.y, e.z];
}
function applyMatrix(o: THREE.Object3D, m: THREE.Matrix4) {
  m.decompose(o.position, o.quaternion, o.scale);
}
const _bp = new THREE.Vector3(), _bp2 = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bq2 = new THREE.Quaternion(), _bs = new THREE.Vector3();
function blendMatrices(a: THREE.Matrix4, b: THREE.Matrix4, w: number): THREE.Matrix4 {
  a.decompose(_bp, _bq, _bs);
  b.decompose(_bp2, _bq2, _bs);
  _bp.lerp(_bp2, w);
  _bq.slerp(_bq2, w);
  return new THREE.Matrix4().compose(_bp, _bq, new THREE.Vector3(1, 1, 1));
}
function blendInto(out: HandPose, b: HandPose, w: number) {
  if (w <= 0) return;
  // out = out + (b - out) * w' where w is the absolute share; accumulate normalized
  lerpPose(out, b, w, out);
}
/** The authoring helper gives the palm contact point; the wrist sits 4.5cm back along the hand and 1.6cm dorsal. */
function contactToWrist(frame: THREE.Matrix4): THREE.Matrix4 {
  return frame.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.016, 0.045));
}

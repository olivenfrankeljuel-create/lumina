import * as THREE from 'three';
import { createGame, createRenderer, detectQuality, tick } from '../../core/Game';
import { EventBus } from '../../core/events';
import { Input } from '../../core/Input';
import type { GameContext, PlayerState, RaycastHit, MaterialName } from '../../core/types';
import { createMaterialLibrary } from '../../materials';
import { createRenderPipeline } from '../../render';
import { createWeaponSystem } from '../../weapons';
import type { WeaponDebug } from '../../weapons';

/**
 * Weapon/viewmodel dev scene.
 *   /?scene=weapon            lightweight: real materials + render pipeline + weapons, small backdrop, stub player/physics.
 *                             Rendering is on demand and driven by window.__shameless.api (deterministic poses).
 *   /?scene=weapon&full       the full game via createGame({ noEnemies: true }), same API.
 *   /?scene=weapon&live       lightweight scene with a normal game loop (click to lock the pointer: WASD, shift, mouse).
 * API: await pose(name, arg?) with name in
 *   hip | ads | fire(t) | adsfire(t) | sprint | tac | slide | reload(frac) | reloadEmpty(frac) | inspect(t) | look(dx) |
 *   pistol | pistolAds | pistolFire(t) | pistolReload(frac) | pistolReloadEmpty(frac) | switch(t)
 * view(yaw, pitch), hud(bool), fireMode('auto'|'semi'), state()
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const live = params.has('live');
  const ctx = params.has('full') ? await createGame({ container, uiRoot, shotMode: !live, noEnemies: true }) : await createLight(container);
  window.__shameless.ctx = ctx;
  const dbg = (ctx.weapons as unknown as { debug: WeaponDebug }).debug;
  ctx.events.emit('game:state', { state: 'playing' });

  if (live) {
    ctx.renderer.domElement.addEventListener('click', () => ctx.input.requestLock());
    let last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
      last = now;
      if (ctx.hud) tick(ctx, dt);
      else { ctx.time += dt; ctx.player.update(dt); ctx.weapons.update(dt); ctx.pipeline.render(dt); ctx.input.endFrame(); }
      window.__shameless.frame++;
    };
    requestAnimationFrame(loop);
    window.__shameless.ready = true;
    return;
  }

  dbg.freezeIdle = true;
  let dirty = 3;
  const settle = () => dbg.advance(0.8);
  const prep = (id: string, ads: number, sprint: 0 | 1 | 2 | null = 0) => {
    dbg.reset();
    dbg.select(id);
    dbg.forceAds = ads;
    dbg.forceSprint = sprint;
    dbg.forceSlide = false;
    settle();
  };
  const poses: Record<string, (a?: number) => void> = {
    hip: () => prep('m4', 0),
    ads: () => prep('m4', 1),
    fire: (t = 0.03) => { prep('m4', 0); dbg.fireAndAdvance(t); },
    adsfire: (t = 0.03) => { prep('m4', 1); dbg.fireAndAdvance(t); },
    sprint: () => prep('m4', 0, 1),
    tac: () => prep('m4', 0, 2),
    slide: () => { prep('m4', 0); dbg.forceSlide = true; settle(); },
    reload: (f = 0.3) => { prep('m4', 0); dbg.reloadAt(f, false); },
    reloadEmpty: (f = 0.6) => { prep('m4', 0); dbg.reloadAt(f, true); },
    inspect: (t = 1.2) => { prep('m4', 0); dbg.inspectAt(t); },
    pistol: () => prep('m17', 0),
    pistolAds: () => prep('m17', 1),
    pistolFire: (t = 0.03) => { prep('m17', 0); dbg.fireAndAdvance(t); },
    pistolReload: (f = 0.5) => { prep('m17', 0); dbg.reloadAt(f, false); },
    pistolReloadEmpty: (f = 0.75) => { prep('m17', 0); dbg.reloadAt(f, true); },
    look: (dx = 3) => { prep('m4', 0); dbg.look(dx, 0); dbg.advance(0.12); },
  };
  let waiters: (() => void)[] = [];
  const rendered = () => new Promise<void>((res) => waiters.push(res));
  window.__shameless.api = {
    async pose(name: string, arg?: number) { poses[name](arg); dirty = 2; await rendered(); return dbg.state; },
    async view(yaw: number, pitch: number) { ctx.player.yaw = yaw; ctx.player.pitch = pitch; dirty = 2; await rendered(); },
    async hud(on: boolean) { uiRoot.style.display = on ? '' : 'none'; dirty = 1; await rendered(); },
    rendered() { dirty = Math.max(dirty, 1); return rendered(); },
    fireMode(m: 'auto' | 'semi') { dbg.setFireMode(m); },
    state() { return dbg.state; },
  };
  poses.hip();

  const loop = () => {
    requestAnimationFrame(loop);
    if (dirty > 0) {
      ctx.player.update(1 / 60);
      ctx.pipeline.render(1 / 60);
      ctx.input.endFrame();
      dirty--;
      if (dirty === 0) { gpuSync(ctx.renderer); const w = waiters; waiters = []; w.forEach((f) => f()); }
    }
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

/** Minimal context: materials, render pipeline, a small backdrop, stub physics/player/enemies, real weapons. */
async function createLight(container: HTMLElement): Promise<GameContext> {
  const quality = detectQuality(true);
  const renderer = createRenderer(container, quality);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 1500);
  scene.add(camera);
  const ctx = { renderer, scene, camera, quality, input: new Input(renderer.domElement), events: new EventBus(), time: 0 } as unknown as GameContext;
  ctx.materials = createMaterialLibrary();
  await ctx.materials.init(renderer);

  // backdrop: a courtyard corner (ground, two walls, a few props)
  const world = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: MaterialName, x: number, y: number, z: number, ry = 0) => {
    const m = new THREE.Mesh(geo, ctx.materials.get(mat));
    m.position.set(x, y, z); m.rotation.y = ry;
    world.add(m);
    return m;
  };
  const ground = add(new THREE.PlaneGeometry(80, 80), 'concrete_floor', 0, 0, 0);
  ground.rotation.x = -Math.PI / 2;
  add(new THREE.BoxGeometry(30, 6, 0.4), 'brick_tan', 0, 3, -14);
  add(new THREE.BoxGeometry(0.4, 6, 30), 'plaster_worn', -9, 3, -4);
  add(new THREE.BoxGeometry(1.2, 1.2, 1.2), 'wood_pallet', 2.2, 0.6, -7);
  add(new THREE.BoxGeometry(1.0, 1.0, 1.0), 'wood_planks', 3.0, 0.5, -5.8, 0.4);
  add(new THREE.BoxGeometry(2.4, 2.6, 6), 'metal_painted_green', -4.5, 1.3, -9, 0.1);
  add(new THREE.BoxGeometry(3, 0.9, 0.6), 'sandbag', -0.8, 0.45, -5);
  scene.add(world);
  ctx.world = { root: world, playerSpawns: [{ position: new THREE.Vector3(0, 0, 0), yaw: 0 }], enemySpawns: [], coverPoints: [], groundHeight: () => 0, update() {} };
  const ray = new THREE.Raycaster();
  ctx.physics = {
    world: null as never, rapier: null as never,
    addStatic() {}, registerHitbox() {}, unregisterHitboxes() {}, step() {},
    raycast(origin, dir, maxDist): RaycastHit | null {
      ray.set(origin, dir); ray.far = maxDist;
      const h = ray.intersectObject(world, true)[0];
      if (!h) return null;
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      return { point: h.point, normal: n, distance: h.distance, surface: 'concrete', object: h.object };
    },
  };
  ctx.pipeline = await createRenderPipeline(ctx);
  ctx.pipeline.setupShadows(world);

  // stub player: eye camera, recoil applied to the view, simple WASD for live mode
  const velocity = new THREE.Vector3();
  const recoil = new THREE.Vector2();
  const position = new THREE.Vector3(0.4, 0, 0.5);
  const p = {
    position, velocity, eyeHeight: 1.62, yaw: 0.12, pitch: -0.02,
    grounded: true, sprinting: false, crouched: false, sliding: false, lean: 0,
    stridePhase: 0, bobWeight: 0, speed: 0, sprintBlend: 0, tacSprinting: false, tacSprintBlend: 0,
    mantling: false, mantleProgress: 0, crouchBlend: 0, slideBlend: 0, cameraRoll: 0,
    health: 100, maxHealth: 100, alive: true,
    cancelSprint() { p.sprinting = false; },
    addRecoil(pp: number, yy: number) { recoil.x += pp; recoil.y += yy; },
    addCameraShake() {}, damage() {}, respawn() {},
    update(dt: number) {
      const i = ctx.input;
      p.yaw -= i.mouseDX * i.sensitivity; p.pitch -= i.mouseDY * i.sensitivity;
      p.pitch += recoil.x; p.yaw += recoil.y; recoil.set(0, 0);
      const f = (i.down.has('forward') ? 1 : 0) - (i.down.has('back') ? 1 : 0);
      const s = (i.down.has('right') ? 1 : 0) - (i.down.has('left') ? 1 : 0);
      p.sprinting = i.down.has('sprint') && f > 0 && !i.down.has('fire') && !i.down.has('ads');
      const speed = p.sprinting ? 6.5 : 4.2;
      velocity.set(Math.sin(p.yaw) * -f + Math.cos(p.yaw) * s, 0, Math.cos(p.yaw) * -f - Math.sin(p.yaw) * s);
      if (velocity.lengthSq() > 0) velocity.normalize().multiplyScalar(speed);
      position.addScaledVector(velocity, dt);
      p.speed = velocity.length();
      p.bobWeight = p.speed / 4.2;
      p.stridePhase = (p.stridePhase + dt * p.speed / (p.sprinting ? 3.6 : 3.0)) % 1;
      p.sprintBlend += ((p.sprinting ? 1 : 0) - p.sprintBlend) * (1 - Math.exp(-dt * 10));
      camera.position.set(position.x, position.y + p.eyeHeight, position.z);
      camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
      camera.updateMatrixWorld();
    },
  };
  ctx.player = p as unknown as PlayerState;
  ctx.enemies = { enemies: [], applyHit() {}, update() {} };
  ctx.player.update(0);
  ctx.weapons = await createWeaponSystem(ctx);
  return ctx;
}

/** Blocks until the GPU has finished the queued frame (so screenshots don't time out on SwiftShader). */
function gpuSync(r: { getContext(): WebGLRenderingContext | WebGL2RenderingContext }) {
  const gl = r.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

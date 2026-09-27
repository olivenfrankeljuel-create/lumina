import * as THREE from 'three';
import { createGame, createRenderer, detectQuality } from '../../core/Game';
import { EventBus } from '../../core/events';
import { Input } from '../../core/Input';
import type { GameContext, World } from '../../core/types';
import { createMaterialLibrary } from '../../materials';
import { createRenderPipeline } from '../../render';
import { createPhysics } from '../../physics';
import { createPlayer } from '../../player';
import { createFX } from '../../fx';
import { simplifierReady } from '../../ai/sdf';
import { buildCharacter, PRESET_VARIANTS, characterCacheStats, buildStats } from '../../ai/character';

/**
 * AI / character dev scene.
 *   /?scene=ai            lightweight backdrop (own courtyard, real materials/render/physics/player/fx)
 *   /?scene=ai&full=1     full createGame() world
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const ctx = params.has('full') ? await createGame({ container, uiRoot, shotMode: true, noEnemies: true }) : params.has('clay') ? await createClay(container) : await createLite(container);
  window.__shameless.ctx = ctx;
  await simplifierReady;
  const t0 = performance.now();
  const chars = (params.has('nochars') ? [] : PRESET_VARIANTS).map((v, i) => {
    const c = buildCharacter(ctx, v);
    c.root.position.set((i - 1.5) * 1.1, 0, -4);
    ctx.scene.add(c.root);
    return c;
  });
  console.warn('build ms', (performance.now() - t0).toFixed(0), JSON.stringify(characterCacheStats()), buildStats.join('\n'));
  const cam = { pos: new THREE.Vector3(0, 1.3, 0.5), look: new THREE.Vector3(0, 1.0, -4), fov: 40 };
  const api = {
    cam(px: number, py: number, pz: number, lx: number, ly: number, lz: number, fov = 40) { cam.pos.set(px, py, pz); cam.look.set(lx, ly, lz); cam.fov = fov; },
    chars,
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;
  const dbg = { err: '', tickMs: 0, ticks: 0 };
  (window as unknown as { __aiDbg: unknown }).__aiDbg = dbg;
  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    const tt = performance.now();
    try {
      tickWithCamera(ctx, dt, () => {
        ctx.camera.position.copy(cam.pos);
        ctx.camera.lookAt(cam.look);
        ctx.camera.fov = cam.fov;
        ctx.camera.updateProjectionMatrix();
      });
    } catch (e) {
      dbg.err = String((e as Error)?.stack ?? e);
    }
    dbg.tickMs = performance.now() - tt;
    dbg.ticks++;
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

function tickWithCamera(ctx: GameContext, dt: number, camFn: () => void) {
  ctx.time += dt;
  ctx.player.update(dt);
  camFn();
  ctx.weapons.update(dt);
  ctx.enemies.update(dt);
  ctx.physics.step(dt);
  ctx.world.update(dt, ctx.time);
  ctx.fx.update(dt);
  ctx.audio.update(dt);
  ctx.hud.update(dt);
  ctx.pipeline.render(dt);
  ctx.input.endFrame();
}

/** Minimal game context with a small courtyard (walls, low cover), skipping the heavy world/audio/hud. */
async function createLite(container: HTMLElement): Promise<GameContext> {
  const quality = detectQuality(true);
  const renderer = createRenderer(container, quality);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 1500);
  scene.add(camera);
  const ctx = { renderer, scene, camera, quality, input: new Input(renderer.domElement), events: new EventBus(), time: 0 } as unknown as GameContext;
  ctx.materials = createMaterialLibrary();
  await ctx.materials.init(renderer);
  ctx.pipeline = await createRenderPipeline(ctx);
  ctx.physics = await createPhysics(ctx);
  ctx.world = buildCourtyard(ctx);
  ctx.player = await createPlayer(ctx);
  ctx.weapons = { currentId: 'm4', ammoInMag: 30, magSize: 30, reserveAmmo: 90, adsAmount: 0, reloading: false, fovTarget: 75, spread: 0, update() {} };
  ctx.enemies = { enemies: [], applyHit() {}, update() {} };
  ctx.fx = await createFX(ctx);
  ctx.audio = { async resume() {}, setMasterVolume() {}, update() {} };
  ctx.hud = { update() {}, showMenu() {}, hideMenu() {} };
  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); ctx.pipeline.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();
  return ctx;
}

function buildCourtyard(ctx: GameContext): World {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2), ctx.materials.get('concrete_floor'));
  ground.userData.surface = 'concrete';
  root.add(ground);
  const addBox = (x: number, z: number, w: number, h: number, d: number, mat: Parameters<GameContext['materials']['get']>[0], ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ctx.materials.get(mat));
    m.position.set(x, h / 2, z); m.rotation.y = ry;
    root.add(m);
    return m;
  };
  addBox(0, -30, 40, 6, 1, 'brick_tan');
  addBox(-20, -12, 1, 5, 36, 'plaster_worn');
  addBox(20, -12, 1, 5, 36, 'concrete_dirty');
  addBox(-6, -12, 3, 1.0, 0.7, 'concrete');
  addBox(5, -14, 2.4, 1.05, 0.8, 'sandbag');
  addBox(-1, -19, 1.2, 1.2, 1.2, 'wood_pallet', 0.3);
  addBox(10, -20, 3, 1.0, 0.7, 'concrete', -0.4);
  addBox(-11, -21, 2.6, 1.0, 0.9, 'sandbag', 0.2);
  addBox(-4, -24, 1.2, 3, 1.2, 'concrete');
  addBox(6, -26, 4, 3, 0.6, 'brick_red');
  addBox(-14, -8, 0.6, 3, 4, 'concrete_dirty');
  addBox(13, -9, 1.5, 2.6, 1.5, 'metal_painted_green');
  addBox(0, -3, 3, 1.0, 0.7, 'concrete');
  ctx.scene.add(root);
  ctx.pipeline.setupShadows(root);
  ctx.physics.addStatic(root);
  return {
    root,
    playerSpawns: [{ position: new THREE.Vector3(0, 0, 0), yaw: 0 }],
    enemySpawns: [new THREE.Vector3(-8, 0, -27), new THREE.Vector3(0, 0, -28), new THREE.Vector3(8, 0, -28), new THREE.Vector3(15, 0, -22), new THREE.Vector3(-15, 0, -25), new THREE.Vector3(4, 0, -22)],
    coverPoints: [],
    groundHeight: (x, z) => (Math.abs(x) < 80 && Math.abs(z) < 80 ? 0 : null),
    update() {},
  };
}

/** Fast-iteration context: plain forward renderer, flat library-free materials, simple lights. */
async function createClay(container: HTMLElement): Promise<GameContext> {
  const quality = { tier: 1 as const, pixelRatio: 1, shadowMapSize: 2048 };
  const renderer = createRenderer(container, quality);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8a9199);
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 500);
  scene.add(camera);
  const ctx = { renderer, scene, camera, quality, input: new Input(renderer.domElement), events: new EventBus(), time: 0 } as unknown as GameContext;
  const COL: Record<string, number> = {
    cloth_multicam: 0x8c8266, cloth_olive: 0x5d5e48, cloth_black: 0x2a2a2a, glove_leather: 0x5a4a3a, skin: 0xc79a7c, rubber: 0x2c2b29,
    canvas: 0x9a8d70, plastic_black: 0x262626, gun_polymer_black: 0x222222, metal_painted_green: 0x4f5540, glass: 0x303a38, gun_parkerized: 0x2e2e2c, gun_wood: 0x7a4a28, concrete_floor: 0x8d8a84,
  };
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  ctx.materials = {
    envMap: null,
    async init() {},
    get(name) {
      let m = cache.get(name);
      if (!m) { m = new THREE.MeshStandardMaterial({ color: COL[name] ?? 0x808080, roughness: name === 'glass' ? 0.1 : 0.85 }); cache.set(name, m); }
      return m;
    },
    surfaceOf() { return 'concrete'; },
  };
  scene.add(new THREE.HemisphereLight(0xcfd8e8, 0x5a5048, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
  sun.position.set(-3, 6, 5); sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 30 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  sun.target.position.set(0, 0, -4);
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 1.4);
  rim.position.set(4, 3, -9); rim.target.position.set(0, 1, -4);
  scene.add(rim, rim.target);
  ctx.pipeline = {
    viewmodelScene: new THREE.Scene(), viewmodelCamera: new THREE.PerspectiveCamera(), sun,
    render() { renderer.render(scene, camera); }, setSize() {}, setADS() {}, setDamage() {}, flash() {},
    setupShadows(o) { o.traverse((c) => { if ((c as THREE.Mesh).isMesh) c.castShadow = c.receiveShadow = true; }); }, dispose() {},
  };
  ctx.physics = await createPhysics(ctx);
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), ctx.materials.get('concrete_floor'));
  ground.receiveShadow = true;
  root.add(ground);
  scene.add(root);
  ctx.physics.addStatic(root);
  ctx.world = { root, playerSpawns: [{ position: new THREE.Vector3(), yaw: 0 }], enemySpawns: [new THREE.Vector3(0, 0, -20)], coverPoints: [], groundHeight: () => 0, update() {} };
  const pos = new THREE.Vector3();
  ctx.player = {
    position: pos, velocity: new THREE.Vector3(), eyeHeight: 1.65, yaw: 0, pitch: 0, grounded: true, sprinting: false, crouched: false, sliding: false, lean: 0,
    health: 100, maxHealth: 100, alive: true, addRecoil() {}, addCameraShake() {}, damage(a) { ctx.player.health -= a; }, update() {}, respawn() {},
  };
  ctx.weapons = { currentId: 'm4', ammoInMag: 30, magSize: 30, reserveAmmo: 90, adsAmount: 0, reloading: false, fovTarget: 75, spread: 0, update() {} };
  ctx.enemies = { enemies: [], applyHit() {}, update() {} };
  ctx.fx = { update() {} };
  ctx.audio = { async resume() {}, setMasterVolume() {}, update() {} };
  ctx.hud = { update() {}, showMenu() {}, hideMenu() {} };
  const onResize = () => { camera.aspect = container.clientWidth / container.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(container.clientWidth, container.clientHeight); };
  window.addEventListener('resize', onResize);
  onResize();
  return ctx;
}

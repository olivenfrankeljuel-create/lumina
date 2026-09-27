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
  const ctx = params.has('full') ? await createGame({ container, uiRoot, shotMode: true, noEnemies: true }) : await createLite(container);
  window.__shameless.ctx = ctx;
  await simplifierReady;
  const t0 = performance.now();
  const chars = PRESET_VARIANTS.map((v, i) => {
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
  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tickWithCamera(ctx, dt, () => {
      ctx.camera.position.copy(cam.pos);
      ctx.camera.lookAt(cam.look);
      ctx.camera.fov = cam.fov;
      ctx.camera.updateProjectionMatrix();
    });
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

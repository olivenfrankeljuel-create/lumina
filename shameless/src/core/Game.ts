import * as THREE from 'three';
import { EventBus } from './events';
import { Input } from './Input';
import type { GameContext, Quality } from './types';
import { createMaterialLibrary } from '../materials';
import { createRenderPipeline } from '../render';
import { createPhysics } from '../physics';
import { createWorld } from '../world';
import { createPlayer } from '../player';
import { createWeaponSystem } from '../weapons';
import { createEnemyManager } from '../ai';
import { createFX } from '../fx';
import { createAudio } from '../audio';
import { createHUD } from '../ui';

export interface GameOptions {
  container: HTMLElement;
  uiRoot: HTMLElement;
  /** Screenshot/test mode: no menu, no pointer lock, fixed timestep. */
  shotMode?: boolean;
  quality?: Partial<Quality>;
  /** Skip spawning enemies (useful for dev scenes). */
  noEnemies?: boolean;
}

export function detectQuality(shotMode: boolean): Quality {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const tier = (q !== null ? Number(q) : shotMode ? 2 : 2) as Quality['tier'];
  return {
    tier,
    pixelRatio: Math.min(window.devicePixelRatio, tier >= 3 ? 2 : tier === 2 ? 1.5 : 1),
    shadowMapSize: tier >= 3 ? 4096 : tier === 2 ? 2048 : 1024,
  };
}

export function createRenderer(container: HTMLElement, quality: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the post stack
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}

/** Builds every subsystem in dependency order. Modules may only touch ctx fields created before them during construction. */
export async function createGame(opts: GameOptions): Promise<GameContext> {
  const quality = { ...detectQuality(!!opts.shotMode), ...opts.quality };
  const renderer = createRenderer(opts.container, quality);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, opts.container.clientWidth / opts.container.clientHeight, 0.05, 1500);
  scene.add(camera);

  const ctx = {
    renderer, scene, camera, quality,
    input: new Input(renderer.domElement),
    events: new EventBus(),
    time: 0,
  } as unknown as GameContext;

  ctx.materials = createMaterialLibrary();
  await ctx.materials.init(renderer);
  ctx.pipeline = await createRenderPipeline(ctx);
  ctx.physics = await createPhysics(ctx);
  ctx.world = await createWorld(ctx);
  ctx.player = await createPlayer(ctx);
  ctx.weapons = await createWeaponSystem(ctx);
  ctx.enemies = await createEnemyManager(ctx, { count: opts.noEnemies ? 0 : undefined });
  ctx.fx = await createFX(ctx);
  ctx.audio = await createAudio(ctx);
  ctx.hud = await createHUD(ctx, opts.uiRoot);

  const onResize = () => {
    const w = opts.container.clientWidth, h = opts.container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    ctx.pipeline.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();
  return ctx;
}

/** One simulation + render tick, in canonical system order. */
export function tick(ctx: GameContext, dt: number): void {
  ctx.time += dt;
  ctx.player.update(dt);
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

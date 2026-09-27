import * as THREE from 'three';
import { EventBus } from '../../core/events';
import { Input } from '../../core/Input';
import type { EnemyInfo, GameContext, PlayerState, WeaponSystem } from '../../core/types';
import { createHUD } from '../../ui';

/**
 * UI dev scene: real game (shot mode) as the background, with the HUD driven by a mock
 * player / weapon / enemy layer so every HUD state can be forced deterministically.
 *
 * window.__shameless.api:
 *   normal() combat() lowHealth() reload() lowAmmo() noAmmo() menu() pause() settings() menuSettings() death()
 *   pose(yawDeg, pitchDeg) interact(text) freeze(ms) hud (raw HUD) mock {player, weapons, enemies}
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const hiddenUi = document.createElement('div'); // the game's own HUD instance lives here, unseen
  let ctx: GameContext;
  const lite = new URLSearchParams(location.search).has('lite');
  let tick = liteTick;
  try {
    if (lite) throw new Error('lite mode');
    // Dynamic import: in lite mode we never touch the other modules (they may be mid-edit).
    const game = await import('../../core/Game');
    tick = game.tick;
    ctx = await game.createGame({ container, uiRoot: hiddenUi, shotMode: true, noEnemies: true });
  } catch (err) {
    console.warn('[ui scene] createGame failed, using fallback backdrop', err);
    ctx = fallbackContext(container);
  }
  window.__shameless.ctx = ctx;

  // ---------------------------------------------------------------- mocks
  const real = ctx.player;
  const mp = {
    get position() { return real.position; },
    get velocity() { return real.velocity; },
    eyeHeight: 1.65,
    get yaw() { return real.yaw; }, set yaw(v: number) { real.yaw = v; },
    get pitch() { return real.pitch; }, set pitch(v: number) { real.pitch = v; },
    grounded: true, sprinting: false, crouched: false, sliding: false, lean: 0,
    health: 100, maxHealth: 100, alive: true,
    addRecoil() {}, addCameraShake() {},
    damage(amount: number, fromDir: THREE.Vector3 | null) {
      mp.health = Math.max(0, mp.health - amount);
      ctx.events.emit('player:damaged', { amount, health: mp.health, fromDir });
    },
    update() {},
    respawn() { mp.health = 100; mp.alive = true; },
  };

  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const mw: Mutable<WeaponSystem> = {
    currentId: 'm4', ammoInMag: 24, magSize: 30, reserveAmmo: 90, adsAmount: 0, reloading: false, fovTarget: 75, spread: 0.12,
    update() {},
  };

  const base = real.position.clone();
  const enemyList: EnemyInfo[] = [
    [14, -22], [-18, -12], [26, 6], [-6, -38], [4, 30], [-30, 18], [36, -30], [-12, 44],
  ].map(([x, z], id) => ({ id, position: new THREE.Vector3(base.x + x, 0, base.z + z), alive: true, alerted: false }));
  const me = { enemies: enemyList, applyHit() {}, update() {} };

  const hctx = Object.create(ctx) as GameContext;
  hctx.player = mp as unknown as PlayerState;
  hctx.weapons = mw;
  hctx.enemies = me;
  const hud = await createHUD(hctx, uiRoot);
  ctx.hud = hud; // tick() drives our instance

  // ---------------------------------------------------------------- helpers
  const setPose = (yawDeg: number, pitchDeg: number) => {
    real.yaw = (yawDeg * Math.PI) / 180;
    real.pitch = (pitchDeg * Math.PI) / 180;
  };
  /** World direction toward a source at a heading relative to where the player looks. */
  const dirAt = (relDeg: number) => {
    const h = -real.yaw + (relDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  };
  const kill = (id: number, headshot: boolean) => {
    const e = enemyList[id];
    ctx.events.emit('enemy:hit', { enemyId: id, point: e.position.clone(), normal: new THREE.Vector3(0, 0, 1), dir: new THREE.Vector3(0, 0, -1), damage: 40, headshot, killed: true });
    e.alive = false;
    ctx.events.emit('enemy:killed', { enemyId: id, headshot, position: e.position.clone(), weaponId: mw.currentId });
  };
  const reset = () => {
    hud.dev.unfreeze();
    hud.dev.clear();
    hud.dev.closeSettings();
    if (hud.dev.state() === 'menu') hud.hideMenu();
    if (hud.dev.state() === 'paused') hud.dev.resume();
    mp.respawn();
    Object.assign(mw, { currentId: 'm4', ammoInMag: 24, magSize: 30, reserveAmmo: 90, adsAmount: 0, reloading: false, spread: 0.12 });
    hud.dev.interact(null);
    hud.dev.equipment(2, 2);
  };
  const frames = (n: number) => new Promise<void>((res) => {
    const target = window.__shameless.frame + n;
    const poll = () => (window.__shameless.frame >= target ? res() : requestAnimationFrame(poll));
    poll();
  });

  const api = {
    hud, mock: { player: mp, weapons: mw, enemies: me },
    pose: setPose,
    freeze: (ms: number) => hud.dev.freeze(ms),
    interact: (t: string | null, k?: string, s?: string) => hud.dev.interact(t, k, s),
    async normal() {
      reset();
      setPose(20, 2);
      ctx.events.emit('enemy:fire', { enemyId: 0, origin: enemyList[0].position.clone(), dir: new THREE.Vector3() });
      ctx.events.emit('enemy:fire', { enemyId: 2, origin: enemyList[2].position.clone(), dir: new THREE.Vector3() });
      await frames(3);
    },
    async combat() {
      reset();
      setPose(20, 2);
      mw.ammoInMag = 17; mw.spread = 0.35;
      ctx.events.emit('enemy:fire', { enemyId: 3, origin: enemyList[3].position.clone(), dir: new THREE.Vector3() });
      kill(0, false);
      await frames(2);
      kill(1, true);
      await frames(2);
      ctx.events.emit('enemy:hit', { enemyId: 2, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), dir: new THREE.Vector3(0, 0, -1), damage: 40, headshot: true, killed: true });
      await frames(1);
      hud.dev.freeze(150);
    },
    async lowHealth() {
      reset();
      setPose(-40, 0);
      mp.health = 100;
      mp.damage(30, dirAt(-70));
      await frames(4);
      mp.damage(28, dirAt(150));
      await frames(3);
      mp.damage(24, dirAt(40));
      await frames(2);
    },
    async reload() {
      reset();
      setPose(60, 4);
      mw.ammoInMag = 0; mw.reserveAmmo = 90;
      await frames(3);
      hud.dev.freeze(400);
    },
    async lowAmmo() {
      reset();
      setPose(60, 4);
      mw.ammoInMag = 5; mw.reserveAmmo = 60;
      await frames(3);
      hud.dev.freeze(400);
    },
    async noAmmo() {
      reset();
      mw.ammoInMag = 0; mw.reserveAmmo = 0;
      await frames(3);
      hud.dev.freeze(400);
    },
    async interactPrompt() {
      reset();
      hud.dev.interact('M4 CARBINE', 'F', 'HOLD TO SWAP');
      await frames(3);
      hud.dev.freeze(400);
    },
    async menu() {
      reset();
      setPose(-30, 6);
      hud.showMenu();
      await frames(3);
      hud.dev.freeze(900);
    },
    async pause() {
      reset();
      setPose(40, 0);
      await frames(2);
      hud.dev.pause();
      await frames(2);
      hud.dev.freeze(400);
    },
    async settings() {
      await api.pause();
      hud.dev.openSettings();
      await frames(2);
      hud.dev.freeze(400);
    },
    async menuSettings() {
      await api.menu();
      hud.dev.openSettings();
      await frames(2);
      hud.dev.freeze(400);
    },
    async death() {
      reset();
      setPose(-10, -4);
      mp.damage(60, dirAt(120));
      await frames(2);
      mp.health = 0;
      hud.dev.die({ name: 'HOSTILE GUNNER', weapon: 'AK-47', weaponKind: 'rifle', distance: 23 });
      hud.dev.deathElapsed(2.1);
      await frames(2);
      hud.dev.freeze(1200);
    },
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;

  setPose(20, 2);
  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(ctx, dt);
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

function liteTick(ctx: GameContext, dt: number): void {
  ctx.time += dt;
  ctx.player.update(dt);
  ctx.hud.update(dt);
  ctx.pipeline.render(dt);
  ctx.input.endFrame();
}

/** Minimal stand-in when the full game can't be built (other modules mid-change). */
function fallbackContext(container: HTMLElement): GameContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9bccb);
  scene.fog = new THREE.Fog(0xa9bccb, 40, 260);
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 1000);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x6b5a45, 1.4));
  const sun = new THREE.DirectionalLight(0xfff0dd, 2.5);
  sun.position.set(40, 80, 30);
  scene.add(sun);
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, far: 300 });
  // sky gradient
  const sky = document.createElement('canvas');
  sky.width = 4; sky.height = 256;
  const sg = sky.getContext('2d')!;
  const grd = sg.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#5f86b3'); grd.addColorStop(0.5, '#b9cbd8'); grd.addColorStop(0.56, '#e6ddcc'); grd.addColorStop(1, '#8a7a66');
  sg.fillStyle = grd; sg.fillRect(0, 0, 4, 256);
  const skyTex = new THREE.CanvasTexture(sky);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0xc9d2d6, 30, 220);
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8b7b63, roughness: 1 }));
  ground.receiveShadow = true;
  root.add(ground);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(10, 240).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d3c3a, roughness: 0.9 }));
  road.position.set(0, 0.02, 0);
  root.add(road);
  const cols = [0xb8ad99, 0x8f8a80, 0xa4927a, 0x6f6a62, 0xc9c1b0, 0x9c7b62];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let gx = -4; gx <= 4; gx++) for (let gz = -4; gz <= 4; gz++) {
    if (Math.abs(gx) <= 0 || rnd() < 0.3) continue;
    const w = 6 + rnd() * 9, d = 6 + rnd() * 9, hgt = 3 + Math.floor(rnd() * 4) * 3;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), new THREE.MeshStandardMaterial({ color: cols[Math.floor(rnd() * cols.length)], roughness: 0.9 }));
    b.position.set(gx * 22 + (rnd() - 0.5) * 6, hgt / 2, gz * 22 + (rnd() - 0.5) * 6);
    b.rotation.y = rnd() < 0.3 ? (rnd() - 0.5) * 0.8 : 0;
    b.castShadow = b.receiveShadow = true;
    root.add(b);
  }
  for (let i = 0; i < 30; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.6, 6), new THREE.MeshStandardMaterial({ color: [0x3f5f7a, 0x8a3b2c, 0x4f6b3a][i % 3], roughness: 0.6, metalness: 0.3 }));
    c.position.set((rnd() - 0.5) * 120, 1.3, (rnd() - 0.5) * 120);
    c.rotation.y = rnd() * Math.PI;
    c.castShadow = c.receiveShadow = true;
    root.add(c);
  }
  scene.add(root);
  const player = {
    position: new THREE.Vector3(5.5, 0, 12), velocity: new THREE.Vector3(), eyeHeight: 1.65, yaw: 0, pitch: 0,
    grounded: true, sprinting: false, crouched: false, sliding: false, lean: 0, health: 100, maxHealth: 100, alive: true,
    addRecoil() {}, addCameraShake() {}, damage() {}, respawn() {},
    update() { camera.position.set(player.position.x, 1.65, player.position.z); camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ'); },
  };
  let lastKey = '';
  const vignette = document.createElement('div');
  vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center, rgba(120,0,0,0) 45%, rgba(110,0,0,0.55) 85%, rgba(60,0,0,0.85) 100%);mix-blend-mode:multiply';
  container.appendChild(vignette);
  const ctx = {
    renderer, scene, camera, time: 0,
    input: new Input(renderer.domElement),
    events: new EventBus(),
    quality: { tier: 2, pixelRatio: 1, shadowMapSize: 1024 },
    pipeline: {
      // Only re-render when the camera moves: the backdrop is static, and SwiftShader is slow.
      render() {
        camera.updateMatrixWorld();
        const key = camera.matrixWorld.elements.map((v) => v.toFixed(4)).join(',');
        if (key === lastKey) return;
        lastKey = key;
        renderer.render(scene, camera);
      }, setDamage(v: number) {
        // stand-in for the render module's low-health grade
        vignette.style.opacity = String(v);
      },
      setADS() {}, flash() {}, setSize() {}, setupShadows() {}, dispose() {} },
    physics: { world: null, step() {} },
    world: { root, playerSpawns: [], enemySpawns: [], coverPoints: [], groundHeight: () => 0, update() {} },
    player,
    weapons: { update() {} },
    enemies: { enemies: [], update() {} },
    fx: { update() {} },
    audio: { setMasterVolume() {}, update() {}, resume: async () => {} },
    hud: { update() {} },
  };
  return ctx as unknown as GameContext;
}

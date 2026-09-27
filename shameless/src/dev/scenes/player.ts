import * as THREE from 'three';
import { EventBus, type GameEvents } from '../../core/events';
import { Input, type Action } from '../../core/Input';
import type { GameContext, Quality, World, WeaponSystem } from '../../core/types';
import { createPhysics, physicsExt } from '../../physics';
import { createPlayer, playerExt } from '../../player';

/**
 * Movement test course (isolated: own renderer/lights/geometry + physics + player; no other modules).
 * Lanes along -Z, all starting at z = 0:
 *   x=0   long corridor (speed tests)          x=10  stairs up/down (0.2 m risers)
 *   x=20  20° ramp up, 35° ramp down           x=30  vault wall (1.0 m thin) / mantle block (1.1 m) / high ledge (1.75 m) / 3 m wall
 *   x=40  curbs 0.15/0.3, crates, 1.4 m tunnel  x=50  pillar for lean peeking      x=60 6 m tower (fall test)
 * window.__shameless.api drives it headlessly (see tools/player-test.mjs).
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const quality: Quality = { tier: 1, pixelRatio: 1, shadowMapSize: 1024 };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fa6bb);
  scene.fog = new THREE.Fog(0x8fa6bb, 40, 160);
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 400);
  scene.add(camera);

  const ctx = {
    renderer, scene, camera, quality,
    input: new Input(renderer.domElement),
    events: new EventBus(),
    time: 0,
  } as unknown as GameContext;

  // ---- lights ----
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x5a4a3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 150 });
  sun.target.position.set(30, 0, -20);
  scene.add(sun, sun.target);

  // ---- procedural grid materials ----
  const gridTex = (base: string, line: string, cells = 4) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      if ((x + y) % 2) { g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect((x * 256) / cells, (y * 256) / cells, 256 / cells, 256 / cells); }
    }
    g.strokeStyle = line; g.lineWidth = 3;
    for (let i = 0; i <= cells; i++) {
      g.beginPath(); g.moveTo((i * 256) / cells, 0); g.lineTo((i * 256) / cells, 256); g.stroke();
      g.beginPath(); g.moveTo(0, (i * 256) / cells); g.lineTo(256, (i * 256) / cells); g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  // world-space UVs (triplanar-ish by box projection) so the grid is 1 m everywhere
  const worldUV = (geo: THREE.BufferGeometry, m: THREE.Matrix4) => {
    geo.applyMatrix4(m);
    geo.computeVertexNormals();
    const p = geo.attributes.position, n = geo.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u / 4; uv[i * 2 + 1] = v / 4; // texture = 4x4 cells of 1 m
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  };
  const mats = {
    floor: new THREE.MeshStandardMaterial({ map: gridTex('#8a8d90', '#5e6164'), roughness: 0.9 }),
    wall: new THREE.MeshStandardMaterial({ map: gridTex('#a4886e', '#6f5a48'), roughness: 0.85 }),
    wood: new THREE.MeshStandardMaterial({ map: gridTex('#9b7a52', '#6b5132'), roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ map: gridTex('#7b8792', '#4d5761'), roughness: 0.5, metalness: 0.4 }),
    orange: new THREE.MeshStandardMaterial({ map: gridTex('#c9772f', '#8b4d17'), roughness: 0.7 }),
    blue: new THREE.MeshStandardMaterial({ map: gridTex('#4f79a8', '#2f4d70'), roughness: 0.7 }),
  };

  const root = new THREE.Group();
  scene.add(root);
  /** Box with its world UVs baked (geometry transformed; mesh at identity so the physics cuboid fast-path still applies). */
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, surface: string, rotY = 0, rotX = 0) => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    const geo = worldUV(new THREE.BoxGeometry(w, h, d).toNonIndexed(), new THREE.Matrix4());
    const mesh = new THREE.Mesh(geo, mat);
    // keep the box in local space (for cuboid colliders) but compute world UVs from world coords
    const tmp = geo.clone().applyMatrix4(m);
    worldUV(tmp, new THREE.Matrix4());
    geo.setAttribute('uv', tmp.attributes.uv);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rotX, rotY, 0, 'YXZ');
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.surface = surface;
    root.add(mesh);
    return mesh;
  };

  // floor (thick slab so nothing tunnels)
  box(240, 1, 240, 30, -0.5, -40, mats.floor, 'concrete');

  // Lane A: corridor
  box(0.3, 3, 90, -3, 1.5, -45, mats.wall, 'brick');
  box(0.3, 3, 90, 3, 1.5, -45, mats.wall, 'brick');

  // Lane B: stairs up (10 × 0.2 m) → 3 m platform → stairs down
  const bx = 10;
  for (let i = 0; i < 10; i++) box(2.4, 0.2 * (i + 1), 0.3, bx, 0.1 * (i + 1), -4 - i * 0.3 - 0.15, mats.wood, 'wood');
  box(2.4, 2.0, 3, bx, 1.0, -4 - 3 - 1.5, mats.wood, 'wood');
  for (let i = 0; i < 10; i++) box(2.4, 2.0 - 0.2 * (i + 1), 0.3, bx, (2.0 - 0.2 * (i + 1)) / 2, -10 - i * 0.3 - 0.15, mats.wood, 'wood');

  // Lane C: ramps (trimesh via a merged non-box geometry) — 20° up to 3 m, platform, 35° down
  {
    const up = 3 / Math.tan((20 * Math.PI) / 180), down = 3 / Math.tan((35 * Math.PI) / 180);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(up, 3); shape.lineTo(up + 3, 3); shape.lineTo(up + 3 + down, 0); shape.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: false });
    // shape X → world -Z, extrude Z → world X
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(20 - 1.2, 0, -3);
    worldUV(geo, m);
    const mesh = new THREE.Mesh(geo, mats.metal);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.surface = 'metal';
    root.add(mesh);
  }

  // Lane D: mantle / vault
  box(2.4, 1.0, 0.3, 30, 0.5, -6, mats.orange, 'brick'); // thin waist-high wall → vault
  box(2.4, 1.1, 3.0, 30, 0.55, -16, mats.blue, 'concrete'); // thick block → mantle on top
  box(2.4, 1.75, 3.0, 30, 0.875, -26, mats.blue, 'concrete'); // chest+ ledge → jump + mantle
  box(2.4, 3.0, 1.0, 30, 1.5, -36, mats.wall, 'brick'); // too tall

  // Lane E: curbs, crates, low tunnel
  box(2.4, 0.15, 1.0, 40, 0.075, -4, mats.floor, 'concrete');
  box(2.4, 0.3, 1.0, 40, 0.15, -8, mats.floor, 'concrete');
  box(0.8, 0.8, 0.8, 38.5, 0.4, -12, mats.wood, 'wood', 0.3);
  box(0.8, 0.8, 0.8, 41.2, 0.4, -13, mats.wood, 'wood', -0.2);
  box(0.8, 0.8, 0.8, 41.0, 1.2, -13.1, mats.wood, 'wood', 0.1);
  // tunnel: two walls + roof, 1.4 m clearance, from z=-18 to -24
  box(0.3, 1.4, 6, 38.6, 0.7, -21, mats.wall, 'brick');
  box(0.3, 1.4, 6, 41.4, 0.7, -21, mats.wall, 'brick');
  box(3.1, 0.3, 6, 40, 1.55, -21, mats.wall, 'brick');

  // Lane F: pillar for lean
  box(1.2, 3, 1.2, 50, 1.5, -6, mats.wall, 'brick');
  box(0.6, 1.8, 0.6, 52.5, 0.9, -14, mats.orange, 'metal');

  // Lane G: 6 m tower + 12 m tower for fall tests
  box(3, 6, 3, 60, 3, -6, mats.metal, 'metal');
  box(3, 12, 3, 66, 6, -6, mats.metal, 'metal');

  // simple stand-in viewmodel so roll/tilt read in screenshots
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.5), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
  gun.position.set(0.16, -0.15, -0.35);
  camera.add(gun);

  // ---- modules ----
  ctx.physics = await createPhysics(ctx);
  const world: World = {
    root,
    playerSpawns: [{ position: new THREE.Vector3(0, 0, 0), yaw: 0 }],
    enemySpawns: [],
    coverPoints: [],
    groundHeight: () => 0,
    update() {},
  };
  ctx.world = world;
  ctx.physics.addStatic(root, 'concrete');
  ctx.player = await createPlayer(ctx);
  const player = playerExt(ctx.player);
  const phys = physicsExt(ctx.physics);

  // fake weapon (for ADS / FOV tests); undefined by default to exercise the guard
  const fakeWeapon = { currentId: 'test', ammoInMag: 30, magSize: 30, reserveAmmo: 90, adsAmount: 0, reloading: false, fovTarget: 75, spread: 0 } as unknown as WeaponSystem & { adsAmount: number; fovTarget: number; update(dt: number): void };
  fakeWeapon.update = () => {};

  // ---- event log ----
  const events: { t: number; type: string; data: Record<string, unknown> }[] = [];
  const log = <K extends keyof GameEvents>(type: K) => ctx.events.on(type, (p) => {
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as object)) d[k] = v instanceof THREE.Vector3 ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : v;
    events.push({ t: +ctx.time.toFixed(3), type, data: d });
  });
  (['player:footstep', 'player:jump', 'player:land', 'player:slide', 'player:damaged', 'player:died', 'player:respawn'] as const).forEach(log);

  // ---- HUD readout ----
  const hud = document.createElement('pre');
  hud.style.cssText = 'position:absolute;left:10px;top:8px;margin:0;color:#fff;font:12px/1.35 monospace;text-shadow:0 1px 2px #000;';
  uiRoot.appendChild(hud);
  const cross = document.createElement('div');
  cross.style.cssText = 'position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;background:#fff;border-radius:2px;box-shadow:0 0 2px #000';
  uiRoot.appendChild(cross);

  const snapshot = () => ({
    t: +ctx.time.toFixed(3),
    pos: [+player.position.x.toFixed(3), +player.position.y.toFixed(3), +player.position.z.toFixed(3)],
    vel: [+player.velocity.x.toFixed(3), +player.velocity.y.toFixed(3), +player.velocity.z.toFixed(3)],
    speed: +player.speed.toFixed(3),
    grounded: player.grounded, sprinting: player.sprinting, tac: player.tacSprinting, crouched: player.crouched,
    stance: player.stance, sliding: player.sliding, mantling: player.mantling, vaulting: player.vaulting,
    lean: +player.lean.toFixed(3), eyeHeight: +player.eyeHeight.toFixed(3),
    camY: +camera.position.y.toFixed(3), camX: +camera.position.x.toFixed(3), roll: +player.cameraRoll.toFixed(4),
    pitch: +camera.rotation.x.toFixed(4), yaw: +camera.rotation.y.toFixed(4),
    fov: +camera.fov.toFixed(2), health: +player.health.toFixed(1), alive: player.alive,
    stride: +player.stridePhase.toFixed(3), bob: +player.bobWeight.toFixed(3), surface: player.surface,
  });

  const updateHud = () => {
    const s = snapshot();
    hud.textContent = `pos ${s.pos.map((v) => v.toFixed(2)).join(' ')}  speed ${s.speed.toFixed(2)} m/s  vy ${s.vel[1].toFixed(2)}\n` +
      `${s.stance}${s.sliding ? ' SLIDE' : ''}${s.sprinting ? (s.tac ? ' TAC-SPRINT' : ' SPRINT') : ''}${s.mantling ? (s.vaulting ? ' VAULT' : ' MANTLE') : ''}${s.grounded ? '' : ' AIR'}` +
      `  lean ${s.lean.toFixed(2)}  fov ${s.fov.toFixed(1)}  hp ${s.health.toFixed(0)}  ${s.surface}`;
  };

  const tickSim = (dt: number) => {
    ctx.time += dt;
    ctx.player.update(dt);
    ctx.physics.step(dt);
    ctx.input.endFrame();
  };
  const render = () => {
    updateHud();
    renderer.render(scene, camera);
  };

  const DT = 1 / 60;
  const setHeld = (hold: Action[]) => {
    const want = new Set(hold);
    for (const a of [...ctx.input.down]) if (!want.has(a)) ctx.input.simulate(a, false);
    for (const a of want) if (!ctx.input.down.has(a)) ctx.input.simulate(a, true);
  };

  const api = {
    ctx, player, physics: phys, events, snapshot, render, THREE,
    teleport(x: number, y: number, z: number, yaw = 0, pitch = 0) {
      setHeld([]);
      ctx.input.endFrame();
      player.placeAt(new THREE.Vector3(x, y, z), yaw, pitch);
      // settle onto the ground
      for (let i = 0; i < 10; i++) tickSim(DT);
      return snapshot();
    },
    /** Simulate `seconds` at 60 Hz holding `hold` actions. `tap` actions are pressed on the first frame only. */
    sim(seconds: number, hold: Action[] = [], opts: { tap?: Action[]; every?: number; mouse?: [number, number]; yaw?: number } = {}) {
      const n = Math.round(seconds / DT);
      const samples: ReturnType<typeof snapshot>[] = [];
      const every = opts.every ?? 0;
      let maxSpeed = 0, minCamY = Infinity, maxY = -Infinity, minY = Infinity;
      for (let i = 0; i < n; i++) {
        const h = [...hold];
        if (i === 0 && opts.tap) h.push(...opts.tap);
        setHeld(h);
        if (opts.mouse) { ctx.input.mouseDX = opts.mouse[0]; ctx.input.mouseDY = opts.mouse[1]; }
        if (opts.yaw !== undefined) player.yaw = opts.yaw;
        tickSim(DT);
        maxSpeed = Math.max(maxSpeed, player.speed);
        minCamY = Math.min(minCamY, camera.position.y);
        maxY = Math.max(maxY, player.position.y);
        minY = Math.min(minY, player.position.y);
        if (every && i % every === 0) samples.push(snapshot());
      }
      return { final: snapshot(), samples, maxSpeed: +maxSpeed.toFixed(3), minCamY: +minCamY.toFixed(3), maxY: +maxY.toFixed(3), minY: +minY.toFixed(3) };
    },
    /** Step until predicate(snapshot) is true or timeout; returns time taken. */
    until(pred: string, hold: Action[] = [], timeout = 5) {
      const f = new Function('s', `return (${pred});`) as (s: ReturnType<typeof snapshot>) => boolean;
      let t = 0;
      while (t < timeout) {
        setHeld(hold);
        tickSim(DT);
        t += DT;
        if (f(snapshot())) return { t: +t.toFixed(3), s: snapshot() };
      }
      return { t: -1, s: snapshot() };
    },
    release() { setHeld([]); ctx.input.endFrame(); },
    setWeapon(on: boolean, ads = 0, fov = 75) {
      if (on) { fakeWeapon.adsAmount = ads; fakeWeapon.fovTarget = fov; ctx.weapons = fakeWeapon; }
      else (ctx as { weapons?: unknown }).weapons = undefined;
    },
    clearEvents() { events.length = 0; },
  };
  window.__shameless.ctx = ctx;
  window.__shameless.api = api as unknown as Record<string, unknown>;

  const onResize = () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener('resize', onResize);
  // click to lock + play interactively
  renderer.domElement.addEventListener('click', () => ctx.input.requestLock());

  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const s = window.__shameless;
    if (s.paused) { last = now; return; }
    const dt = s.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tickSim(dt);
    render();
    s.frame++;
  };
  if (!params.has('manual')) requestAnimationFrame(loop);
  else render();
  window.__shameless.ready = true;
}

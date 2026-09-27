import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect } from 'postprocessing';
import { EventBus, type Surface } from '../../core/events';
import type { GameContext, Quality, RaycastHit } from '../../core/types';
import { createFX, type FXExtras } from '../../fx';

/**
 * FX test range: a self-contained golden-hour backdrop (concrete wall, plaster wall, painted steel
 * plate, wooden crate, dirt + sand patches, glass pane, asphalt ground) with a minimal GameContext
 * so the FX module can be exercised independently of the other (in-flux) modules.
 *
 * window.__shameless.api:
 *   view(name)                    camera presets: wall, metal, crate, dirt, glass, plaster, sand, overview, street, sun
 *   hit(surface, n?, spread?)     bullet impacts on the matching object (fired from the camera)
 *   shoot(n, targetName?)         full weapon event chain: fire + tracer + impact + casing
 *   explode(x?, y?, z?, r?)       explosion
 *   blood(killed?, headshot?)     enemy hit in front of the wall
 *   tracers(n?)                   player + enemy tracers across the view
 *   casings(n?)                   ejected brass
 *   pause() / play() / step(n)    deterministic time control (1/60 s steps)
 *   stats()
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  // local copies of core/Game helpers so this scene does not pull every module into its graph
  const qp = new URLSearchParams(location.search).get('q');
  const tier = (qp !== null ? Number(qp) : 2) as Quality['tier'];
  const quality: Quality = { tier, pixelRatio: 1, shadowMapSize: tier >= 3 ? 4096 : 2048 };
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.05, 1500);
  scene.add(camera);

  // ------------------------------------------------------------ lighting (golden hour, low side sun)
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.74, 0.46), 5.0);
  sun.position.set(22, 7.5, 6);
  sun.target.position.set(0, 0, -3);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.66, 0.9), new THREE.Color(0.42, 0.33, 0.24), 1.1);
  scene.add(hemi);

  // sky dome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSun: { value: sun.position.clone().normalize() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 uSun;
      void main(){ float h = clamp(vDir.y, -0.2, 1.0);
        vec3 zen = vec3(0.18, 0.32, 0.62), hor = vec3(1.05, 0.72, 0.45), gnd = vec3(0.3, 0.25, 0.2);
        vec3 c = mix(hor, zen, pow(max(h, 0.0), 0.55));
        if (h < 0.0) c = mix(hor, gnd, min(-h * 6.0, 1.0));
        float s = max(dot(normalize(vDir), uSun), 0.0);
        c += vec3(1.0, 0.65, 0.35) * (pow(s, 12.0) * 0.8 + pow(s, 900.0) * 30.0);
        gl_FragColor = vec4(c * 1.4, 1.0); }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), skyMat);
  scene.add(sky);
  scene.fog = new THREE.Fog(new THREE.Color(0.95, 0.72, 0.5), 60, 500);

  // environment (IBL) from the sky
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat));
  const env = pmrem.fromScene(envScene, 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.5;

  // ------------------------------------------------------------ backdrop
  const pickables: THREE.Mesh[] = [];
  const add = (mesh: THREE.Mesh, surface: Surface, name: string) => {
    mesh.userData.surface = surface; mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh); pickables.push(mesh);
    return mesh;
  };
  const T = makeTextures(renderer);
  const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: 0.92 })), 'asphalt', 'ground');
  T.asphalt.repeat.set(20, 20);
  const wall = add(new THREE.Mesh(new THREE.BoxGeometry(8, 4.5, 0.4),
    new THREE.MeshStandardMaterial({ map: T.concrete, roughness: 0.9 })), 'concrete', 'wall');
  wall.position.set(0.5, 2.25, -5.2);
  const plaster = add(new THREE.Mesh(new THREE.BoxGeometry(5, 4.5, 0.4),
    new THREE.MeshStandardMaterial({ map: T.plaster, roughness: 0.95 })), 'plaster', 'plaster');
  plaster.position.set(-5.6, 2.25, -4.2); plaster.rotation.y = 0.5;
  const plate = add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 0.05),
    new THREE.MeshStandardMaterial({ map: T.metal, roughness: 0.45, metalness: 0.7 })), 'metal', 'metal');
  plate.position.set(3.3, 0.9, -3.4); plate.rotation.y = -0.45;
  const crate = add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1),
    new THREE.MeshStandardMaterial({ map: T.wood, roughness: 0.85 })), 'wood', 'crate');
  crate.position.set(-1.6, 0.55, -3.0); crate.rotation.y = 0.35;
  const dirt = add(new THREE.Mesh(new THREE.CircleGeometry(2.0, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: T.dirt, roughness: 1 })), 'dirt', 'dirt');
  dirt.position.set(1.2, 0.006, -1.6);
  const sand = add(new THREE.Mesh(new THREE.CircleGeometry(1.6, 48).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: T.sand, roughness: 1 })), 'sand', 'sand');
  sand.position.set(-3.6, 0.006, -0.6);
  const glass = add(new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 0.012),
    new THREE.MeshPhysicalMaterial({ color: 0xcfe6e8, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.25, envMapIntensity: 1.5 })), 'glass', 'glass');
  glass.position.set(5.6, 1.3, -4.4); glass.rotation.y = -0.6;
  glass.castShadow = false;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.08, 0.1), new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.6 }));
  frame.position.set(0, -0.79, 0); glass.add(frame);
  const f2 = frame.clone(); f2.position.y = 0.79; glass.add(f2);
  // a few props for depth
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(3, 6 + i * 1.5, 3), new THREE.MeshStandardMaterial({ map: T.concrete, roughness: 0.9, color: 0xc8b8a8 }));
    b.position.set(-14 + i * 6, (6 + i * 1.5) / 2, -16 - (i % 2) * 5);
    b.castShadow = b.receiveShadow = true;
    scene.add(b);
  }

  // ------------------------------------------------------------ minimal GameContext
  const raycaster = new THREE.Raycaster();
  const events = new EventBus();
  let shake = 0, flashAmt = 0;
  const physics = {
    raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RaycastHit | null {
      raycaster.set(origin, dir); raycaster.far = maxDist;
      const hits = raycaster.intersectObjects(pickables, false);
      const h = hits[0];
      if (!h || !h.face) return null;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.dot(dir) > 0) n.negate();
      return { point: h.point.clone(), normal: n, distance: h.distance, surface: h.object.userData.surface as Surface, object: h.object };
    },
  };
  const ctx = {
    renderer, scene, camera, events, quality, time: 0,
    materials: { envMap: env },
    pipeline: { sun, flash(i: number) { flashAmt = Math.max(flashAmt, i); }, setupShadows() {}, viewmodelScene: new THREE.Scene() },
    physics,
    world: { groundHeight: () => 0 },
    player: { addCameraShake(i: number) { shake = Math.max(shake, i); } },
  } as unknown as GameContext;
  window.__shameless.ctx = ctx;

  const fx = (await createFX(ctx)) as unknown as FXExtras & { update(dt: number): void };

  // ------------------------------------------------------------ post (bloom + ACES, like the game's post stack)
  let composer: EffectComposer | null = null;
  try {
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.3, intensity: 0.9, radius: 0.7 });
    composer.addPass(new EffectPass(camera, bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }), new SMAAEffect()));
  } catch (e) {
    console.warn('post failed, rendering direct', e);
    composer = null;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); composer?.setSize(w, h);
  };
  window.addEventListener('resize', resize); resize();

  // ------------------------------------------------------------ camera presets
  const views: Record<string, [number, number, number, number, number, number]> = {
    overview: [0.5, 1.75, 4.5, 0.3, 1.1, -4],
    wall: [0.2, 1.6, -2.2, 0.4, 1.4, -5],
    wallfar: [0.3, 1.7, 1.5, 0.4, 1.5, -5],
    metal: [2.1, 1.3, -1.6, 3.3, 1.0, -3.4],
    crate: [-1.0, 1.3, -0.9, -1.6, 0.7, -3.0],
    dirt: [1.3, 1.5, 1.2, 1.2, 0.2, -1.6],
    sand: [-3.0, 1.4, 1.8, -3.6, 0.2, -0.6],
    glass: [4.3, 1.4, -2.6, 5.6, 1.3, -4.4],
    plaster: [-3.8, 1.6, -1.8, -5.4, 1.4, -4.2],
    street: [0.5, 1.7, 6, 0.5, 1.0, -8],
    sun: [-4, 1.6, 3, 8, 1.2, -1.5],
    explosion: [0.5, 1.8, 9, 0.8, 1.6, -2],
  };
  const setView = (name: string) => {
    const v = views[name] ?? views.overview;
    camera.position.set(v[0], v[1], v[2]);
    camera.lookAt(v[3], v[4], v[5]);
    camera.updateMatrixWorld();
  };
  setView('overview');

  // ------------------------------------------------------------ weapon event helpers
  const tmpDir = new THREE.Vector3();
  const right = new THREE.Vector3(), upv = new THREE.Vector3(), fwd = new THREE.Vector3();
  const camBasis = () => {
    camera.updateMatrixWorld();
    camera.matrixWorld.extractBasis(right, upv, fwd);
    fwd.negate();
  };
  const objFor = (s: string) => pickables.find((m) => m.userData.surface === s || m.name === s) ?? wall;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  /** fire one bullet from the camera toward a jittered point of the object */
  const fireAt = (target: THREE.Object3D, spread: number, full: boolean) => {
    camBasis();
    const tp = new THREE.Vector3();
    target.getWorldPosition(tp);
    if (target === ground) tp.set(camera.position.x, 0, camera.position.z - 3);
    const toT = tp.clone().sub(camera.position).normalize();
    const d = toT.add(new THREE.Vector3((rnd() - 0.5) * spread, (rnd() - 0.5) * spread, (rnd() - 0.5) * spread)).normalize();
    const hit = physics.raycast(camera.position, d, 200);
    const muzzle = camera.position.clone().addScaledVector(right, 0.12).addScaledVector(upv, -0.1).addScaledVector(fwd, 0.7);
    if (full) {
      events.emit('weapon:fire', { weaponId: 'm4', origin: camera.position.clone(), dir: d.clone(), muzzle, suppressed: false });
      const port = camera.position.clone().addScaledVector(right, 0.1).addScaledVector(upv, -0.12).addScaledVector(fwd, 0.35);
      const ev = right.clone().multiplyScalar(2.6).addScaledVector(upv, 1.6).addScaledVector(fwd, 0.4);
      events.emit('shell:eject', { position: port, velocity: ev, kind: 'rifle' });
    }
    if (!hit) return null;
    if (full) events.emit('bullet:tracer', { from: muzzle, to: hit.point, enemy: false });
    events.emit('bullet:impact', { point: hit.point, normal: hit.normal, surface: hit.surface, object: hit.object ?? undefined, dir: d });
    return hit;
  };

  // ------------------------------------------------------------ loop & time control
  let paused = false;
  let manual = false;
  const update = (dt: number) => {
    ctx.time += dt;
    fx.update(dt);
    shake = Math.max(0, shake - dt * 2);
    flashAmt = Math.max(0, flashAmt - dt * 3);
  };
  const render = () => { if (composer) composer.render(); else renderer.render(scene, camera); };
  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const s = window.__shameless;
    const dt = s.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!manual) {
      if (!paused && !s.paused) update(dt);
      render();
    }
    s.frame++;
  };

  const api = {
    view: setView,
    /** manual mode: the rAF loop stops rendering; drive with step()/render()/capture() */
    manual(on: boolean) { manual = on; },
    render,
    capture() { return renderer.domElement.toDataURL('image/png'); },
    pause() { paused = true; },
    play() { paused = false; },
    step(n = 1) { for (let i = 0; i < n; i++) update(1 / 60); },
    hit(surface: string, n = 1, spread = 0.12) {
      const o = objFor(surface);
      for (let i = 0; i < n; i++) fireAt(o, spread, false);
    },
    shoot(n = 1, target = 'wall', spread = 0.05) {
      const o = objFor(target);
      for (let i = 0; i < n; i++) { fireAt(o, spread, true); update(1 / 12); }
    },
    burst(n = 20, target = 'wall', spread = 0.1) {
      const o = objFor(target);
      for (let i = 0; i < n; i++) { fireAt(o, spread, true); update(0.09); }
    },
    explode(x = 0.8, y = 0, z = -1.8, r = 5) { fx.explosion(new THREE.Vector3(x, y, z), r); },
    blood(killed = true, headshot = false) {
      camBasis();
      const p = new THREE.Vector3(0.3 + rnd() * 0.6, 1.35, -3.6);
      const d = p.clone().sub(camera.position).normalize();
      events.emit('enemy:hit', { enemyId: 1, point: p, normal: d.clone().negate(), dir: d, damage: 30, headshot, killed });
    },
    tracers(n = 6) {
      for (let i = 0; i < n; i++) {
        const enemy = i % 2 === 1;
        const from = enemy ? new THREE.Vector3(-8 + rnd() * 4, 1.4 + rnd(), -30) : camera.position.clone().add(new THREE.Vector3(0.15, -0.1, -0.6));
        const to = enemy ? new THREE.Vector3(2 + rnd() * 3, 0.5 + rnd() * 2, 8) : new THREE.Vector3(-2 + rnd() * 4, 0.5 + rnd() * 2.5, -5);
        fx.tracer(from, to, enemy);
      }
    },
    casings(n = 10) {
      for (let i = 0; i < n; i++) {
        camBasis();
        const port = camera.position.clone().addScaledVector(right, 0.1).addScaledVector(upv, -0.12).addScaledVector(fwd, 0.35);
        const ev = right.clone().multiplyScalar(2.2 + rnd()).addScaledVector(upv, 1.4 + rnd()).addScaledVector(fwd, 0.3);
        events.emit('shell:eject', { position: port, velocity: ev, kind: i % 3 === 2 ? 'pistol' : 'rifle' });
        update(0.1);
      }
    },
    gust() { fx.gust(); },
    /** fullscreen debug view of a generated texture: 'flip' (rgb normals), 'flipa' (alpha), 'flipb' (thickness), 'decal', 'decaln' */
    showTex(which: string | null) {
      scene.getObjectByName('dbgTex')?.removeFromParent();
      if (!which) return;
      const tex = which.startsWith('flip') ? fx.textures.flipbook : which === 'decaln' ? fx.textures.decalNormal : fx.textures.decalAlbedo;
      const mode = which === 'flipa' ? 1 : which === 'flipb' ? 2 : which === 'decal' ? 3 : 0;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { t: { value: tex }, mode: { value: mode } }, depthTest: false, depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * vec2(0.5625, 1.0), 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D t; uniform int mode; varying vec2 vUv; void main(){ vec4 c = texture2D(t, vUv); vec3 o = mode==1 ? vec3(c.a) : mode==2 ? vec3(c.b) : mode==3 ? mix(vec3(0.5), c.rgb, c.a) : c.rgb; gl_FragColor = vec4(o, 1.0); }',
      }));
      m.name = 'dbgTex'; m.frustumCulled = false; m.renderOrder = 999;
      scene.add(m);
    },
    debug(kind: string, x: number, y: number, z: number) { fx.debug(kind, new THREE.Vector3(x, y, z)); },
    /** show only FX objects whose name contains one of the given substrings ([] = show all) */
    only(names: string[]) { fx.group.traverse((o) => { if (o === fx.group || !o.name) return; o.visible = !names.length || names.some((n) => o.name.includes(n)); }); },
    ambient(on: boolean) { fx.setAmbient(on); },
    stats() { return { ...fx.stats(), shake, flash: flashAmt }; },
    dir: tmpDir,
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
  void uiRoot;
}

// ---------------------------------------------------------------- procedural backdrop textures
function makeTextures(renderer: THREE.WebGLRenderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const make = (size: number, paint: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    paint(g, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = aniso;
    return t;
  };
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const noise = (g: CanvasRenderingContext2D, n: number, amp: number) => {
    const d = g.getImageData(0, 0, n, n);
    for (let i = 0; i < d.data.length; i += 4) {
      const k = (r() - 0.5) * amp;
      d.data[i] += k; d.data[i + 1] += k; d.data[i + 2] += k;
    }
    g.putImageData(d, 0, 0);
  };
  const blotches = (g: CanvasRenderingContext2D, n: number, count: number, col: string, rmin: number, rmax: number, alpha: number) => {
    g.fillStyle = col;
    for (let i = 0; i < count; i++) {
      g.globalAlpha = alpha * r();
      g.beginPath(); g.arc(r() * n, r() * n, rmin + r() * (rmax - rmin), 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  };
  return {
    concrete: make(512, (g, n) => {
      g.fillStyle = '#8d8983'; g.fillRect(0, 0, n, n);
      blotches(g, n, 300, '#6f6a64', 4, 40, 0.25);
      blotches(g, n, 200, '#a29d95', 3, 30, 0.2);
      // vertical rain streaks
      for (let i = 0; i < 60; i++) { g.globalAlpha = 0.08 * r(); g.fillStyle = '#4d4944'; g.fillRect(r() * n, r() * n * 0.4, 2 + r() * 6, n * (0.2 + r() * 0.6)); }
      g.globalAlpha = 0.5; g.strokeStyle = '#5a5650'; g.lineWidth = 2; g.strokeRect(0, 0, n, n);
      g.globalAlpha = 1;
      noise(g, n, 22);
    }, 1),
    plaster: make(512, (g, n) => {
      g.fillStyle = '#d9d2c4'; g.fillRect(0, 0, n, n);
      blotches(g, n, 200, '#c4bba9', 5, 50, 0.25);
      blotches(g, n, 40, '#9d9383', 5, 30, 0.15);
      noise(g, n, 10);
    }),
    metal: make(512, (g, n) => {
      g.fillStyle = '#3f5a3c'; g.fillRect(0, 0, n, n);
      blotches(g, n, 120, '#2e4630', 3, 30, 0.35);
      blotches(g, n, 60, '#6b5a44', 2, 14, 0.3);
      g.strokeStyle = '#9aa39a';
      for (let i = 0; i < 80; i++) { g.globalAlpha = 0.25 * r(); g.lineWidth = 0.5 + r(); g.beginPath(); const x = r() * n, y = r() * n; g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 80, y + (r() - 0.5) * 20); g.stroke(); }
      g.globalAlpha = 1;
      noise(g, n, 10);
    }),
    wood: make(512, (g, n) => {
      const planks = 5;
      for (let p = 0; p < planks; p++) {
        const y0 = (p / planks) * n, h = n / planks;
        const base = 110 + r() * 30;
        g.fillStyle = `rgb(${base},${base * 0.72},${base * 0.45})`; g.fillRect(0, y0, n, h);
        for (let k = 0; k < 40; k++) { g.globalAlpha = 0.15; g.fillStyle = r() > 0.5 ? '#4d3520' : '#b08a5c'; g.fillRect(0, y0 + r() * h, n, 1 + r() * 2); }
        g.globalAlpha = 0.8; g.fillStyle = '#2a1c10'; g.fillRect(0, y0, n, 3); g.globalAlpha = 1;
      }
      noise(g, n, 14);
    }),
    dirt: make(512, (g, n) => {
      g.fillStyle = '#5e4a36'; g.fillRect(0, 0, n, n);
      blotches(g, n, 500, '#473626', 2, 16, 0.4);
      blotches(g, n, 400, '#7a6650', 1, 6, 0.5);
      noise(g, n, 30);
      // soft edge
      const grd = g.createRadialGradient(n / 2, n / 2, n * 0.35, n / 2, n / 2, n * 0.5);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(60,55,50,0.6)');
      g.fillStyle = grd; g.fillRect(0, 0, n, n);
    }),
    sand: make(512, (g, n) => {
      g.fillStyle = '#b89c72'; g.fillRect(0, 0, n, n);
      blotches(g, n, 300, '#a08560', 3, 20, 0.3);
      noise(g, n, 24);
    }),
    asphalt: make(256, (g, n) => {
      g.fillStyle = '#4a4744'; g.fillRect(0, 0, n, n);
      blotches(g, n, 300, '#3b3937', 1, 8, 0.4);
      blotches(g, n, 300, '#6a6560', 0.5, 2, 0.5);
      noise(g, n, 30);
    }),
  };
}

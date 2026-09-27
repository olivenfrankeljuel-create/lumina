import * as THREE from 'three';
import type { GameContext, Quality } from '../../core/types';
import { createRenderPipeline } from '../../render';

/**
 * Render lighting test: sky, fog/aerial perspective, cascaded shadows, AO, grading, viewmodel.
 * URL: /?scene=render[&q=0..3][&view=N]
 * window.__shameless.api: { view(n), pipeline, tuning, apply(), setADS, setDamage, flash }
 */

function noiseTexture(size: number, base: [number, number, number], amp: number, seed: number, scale = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const grid = new Float32Array(64 * 64).map(() => rnd());
  const vn = (x: number, y: number, p: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (a: number, b: number) => grid[((b % p) + p) % p * 64 + (((a % p) + p) % p)];
    const a = at(xi, yi), b = at(xi + 1, yi), cc = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let n = 0, am = 0.5, f = 4 * scale;
    for (let o = 0; o < 5; o++) { n += vn((x / size) * f, (y / size) * f, f) * am; am *= 0.5; f *= 2; }
    const k = 1 + (n - 0.5) * amp * 2 + (rnd() - 0.5) * amp * 0.5;
    const i = (y * size + x) * 4;
    img.data[i] = Math.min(255, base[0] * k * 255); img.data[i + 1] = Math.min(255, base[1] * k * 255);
    img.data[i + 2] = Math.min(255, base[2] * k * 255); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function srgb(r: number, g: number, b: number): [number, number, number] { return [r, g, b]; }

// local copies of core/Game helpers so this scene's module graph stays isolated from other
// workstreams (their edits would otherwise hot-reload the page mid-screenshot)
function detectQuality(): Quality {
  const q = new URLSearchParams(location.search).get('q');
  const tier = (q !== null ? Number(q) : 2) as Quality['tier'];
  return { tier, pixelRatio: Math.min(window.devicePixelRatio, tier >= 3 ? 2 : tier === 2 ? 1.5 : 1), shadowMapSize: tier >= 3 ? 4096 : tier === 2 ? 2048 : 1024 };
}
function createRenderer(container: HTMLElement, quality: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}

export default async function (container: HTMLElement, _uiRoot: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const quality: Quality = detectQuality();
  const renderer = createRenderer(container, quality);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.05, 1500);
  scene.add(camera);
  const ctx = { renderer, scene, camera, quality, time: 0 } as unknown as GameContext;
  const pipeline = await createRenderPipeline(ctx);
  ctx.pipeline = pipeline;

  // ---------------- materials
  const groundTex = noiseTexture(512, srgb(0.62, 0.52, 0.4), 0.22, 11, 2);
  groundTex.repeat.set(60, 60);
  const plasterTex = noiseTexture(256, srgb(0.78, 0.7, 0.58), 0.12, 5, 1);
  plasterTex.repeat.set(3, 2);
  const concreteTex = noiseTexture(256, srgb(0.56, 0.54, 0.5), 0.18, 7, 2);
  const mat = {
    ground: new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 }),
    plaster: new THREE.MeshStandardMaterial({ map: plasterTex, roughness: 0.9 }),
    plaster2: new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.66, 0.55, 0.42, THREE.SRGBColorSpace), roughness: 0.92 }),
    concrete: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.85 }),
    wood: new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.45, 0.32, 0.2, THREE.SRGBColorSpace), roughness: 0.8 }),
    metalGreen: new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.24, 0.3, 0.2, THREE.SRGBColorSpace), roughness: 0.55, metalness: 0.2 }),
  };

  const world = new THREE.Group();
  scene.add(world);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), mat.ground);
  world.add(ground);

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, ry = 0) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y + h / 2, z); b.rotation.y = ry; world.add(b); return b;
  };

  // plaster building with a doorway (L-shaped walls) on the left
  box(12, 7, 0.4, -9, 0, -6, mat.plaster);
  box(0.4, 7, 10, -15, 0, -1, mat.plaster);
  box(3, 4, 0.4, -1.5, 0, -6, mat.plaster);
  box(3, 3, 0.4, -1.5, 4, -6, mat.plaster);
  box(12.6, 0.3, 10.4, -9, 7, -1, mat.concrete); // roof slab overhang
  // ledge / parapet
  box(12.6, 0.6, 0.3, -9, 7.3, -6.1, mat.plaster2);
  // columns
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 4.2, 24), mat.concrete);
    c.position.set(3 + i * 3, 2.1, -10); world.add(c);
  }
  box(12, 0.5, 2, 7.5, 4.2, -10, mat.concrete);
  // crates / barriers
  box(1.2, 1.2, 1.2, 2, 0, -2, mat.wood, 0.3);
  box(1.2, 1.2, 1.2, 3.1, 0, -2.6, mat.wood, -0.2);
  box(1.0, 1.0, 1.0, 2.6, 1.2, -2.3, mat.wood, 0.7);
  box(3, 1.0, 0.6, -2.5, 0, 0.5, mat.concrete, 0.1);
  box(2.2, 2.4, 1.2, 6, 0, -4, mat.metalGreen, -0.4);
  // spheres: roughness / metalness ladder
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 2; j++) {
      const sm = new THREE.MeshStandardMaterial({
        color: j === 0 ? new THREE.Color().setRGB(0.7, 0.68, 0.64, THREE.SRGBColorSpace) : new THREE.Color().setRGB(0.95, 0.78, 0.55, THREE.SRGBColorSpace),
        roughness: 0.05 + i * 0.18, metalness: j,
      });
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.35, 48, 32), sm);
      s.position.set(-3 + i * 0.9, 0.35 + j * 0, 2.5 - j * 1.0);
      world.add(s);
    }
  }
  // distant town blocks for haze depth cues
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 30 + Math.pow(rnd(), 0.7) * 520;
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 40;
    if (Math.abs(x) < 20 && z > -30 && z < 20) continue;
    const w = 6 + rnd() * 14, h = 4 + rnd() * 14, d = 6 + rnd() * 14;
    box(w, h, d, x, 0, z, rnd() > 0.5 ? mat.plaster : mat.plaster2, rnd() * 0.3);
  }
  // a tower far away
  box(6, 45, 6, -60, 0, -260, mat.plaster2);
  box(3, 30, 3, 120, 0, -380, mat.concrete);
  pipeline.setupShadows(world);
  // minimal physics stand-in so the pipeline's viewmodel sun-occlusion raycasts work here
  const rc = new THREE.Raycaster();
  (ctx as unknown as { physics: unknown }).physics = {
    raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) {
      rc.set(origin, dir); rc.far = maxDist;
      const h = rc.intersectObject(world, true)[0];
      return h ? { point: h.point, normal: h.face?.normal ?? new THREE.Vector3(0, 1, 0), distance: h.distance, surface: 'concrete', object: h.object } : null;
    },
  };

  // ---------------- viewmodel stub gun
  const gun = new THREE.Group();
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1b1b1a, roughness: 0.55, metalness: 0.0 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.35, metalness: 1.0 });
  const fde = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.55, 0.45, 0.32, THREE.SRGBColorSpace), roughness: 0.6 });
  const g = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); gun.add(me); return me;
  };
  g(new THREE.BoxGeometry(0.05, 0.07, 0.34), steel, 0, 0, 0);
  g(new THREE.BoxGeometry(0.056, 0.06, 0.3), fde, 0, 0.005, -0.3);
  const barrel = g(new THREE.CylinderGeometry(0.011, 0.011, 0.3, 16).rotateX(Math.PI / 2), steel, 0, 0.012, -0.55);
  barrel.name = 'barrel';
  g(new THREE.BoxGeometry(0.035, 0.12, 0.06), polymer, 0, -0.08, -0.05).rotation.x = 0.25;
  g(new THREE.BoxGeometry(0.03, 0.1, 0.045), polymer, 0, -0.07, 0.12).rotation.x = -0.35;
  g(new THREE.BoxGeometry(0.045, 0.06, 0.22), polymer, 0, -0.005, 0.26);
  g(new THREE.BoxGeometry(0.02, 0.03, 0.06), steel, 0, 0.05, -0.02);
  // hand/glove stub
  const glove = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.25, 0.22, 0.18, THREE.SRGBColorSpace), roughness: 0.8 });
  g(new THREE.SphereGeometry(0.045, 24, 16).scale(1.0, 0.8, 1.6), glove, 0.0, -0.05, -0.3);
  gun.position.set(0.12, -0.115, -0.3);
  gun.rotation.set(0.02, 0.05, 0);
  pipeline.viewmodelCamera.add(gun);

  // ---------------- views
  const views: { pos: [number, number, number]; yaw: number; pitch: number }[] = [
    { pos: [4, 1.7, 7], yaw: 0.25, pitch: -0.02 },      // 0: main: sun behind-right, long shadows into the scene
    { pos: [-2, 1.7, -3], yaw: -2.2, pitch: 0.1 },      // 1: toward the sun (backlit, shafts)
    { pos: [6, 1.7, 9], yaw: 0.6, pitch: -0.05 },       // 2: across the building, front/side lit
    { pos: [-9, 1.6, -9.5], yaw: -2.75, pitch: 0.05 },  // 3: in the building's shadow
    { pos: [18, 14, 30], yaw: 0.45, pitch: -0.28 },     // 4: elevated overview, distance haze
  ];
  const setView = (n: number) => {
    const v = views[n] ?? views[0];
    camera.position.set(...v.pos);
    camera.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  setView(Number(params.get('view') ?? 0));

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); pipeline.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  onResize();

  window.__shameless.ctx = ctx;
  window.__shameless.api = {
    pipeline, view: setView, camera, gun,
    tuning: pipeline.debug.tuning, apply: pipeline.debug.applyTuning, debug: pipeline.debug,
  };

  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (window.__shameless.paused) { last = now; return; }
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.time += dt;
    pipeline.render(dt);
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

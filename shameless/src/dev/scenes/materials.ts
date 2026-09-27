import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createMaterialLibrary, ALL_MATERIALS, type MaterialOptionsExt } from '../../materials';
import type { MaterialName } from '../../core/types';

/**
 * Material lookdev.
 *   ?scene=materials&page=0            contact sheet (8 per page, 4x2 viewports): wall panel + floor + sphere + rounded box
 *   ?scene=materials&list=a,b,c        contact sheet of given materials
 *   ?scene=materials&m=brick_red       close-up: wall/floor corner, sphere, box under grazing sun
 *        &view=wall|close|floor|sphere|far|box   camera preset
 *        &sun=az,el                    sun azimuth/elevation in degrees
 *        &tile=2&seed=3&wear=0.5&map=world|object|uv
 *        &texres=2048 &aniso=4 &exp=1 &env=0.9
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const params = new URLSearchParams(location.search);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(params.get('exp') ?? 1.0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const lib = createMaterialLibrary();
  const t0 = performance.now();
  await lib.init(renderer);
  const tInit = performance.now() - t0;

  const scene = new THREE.Scene();
  scene.environment = lib.envMap;
  scene.environmentIntensity = Number(params.get('env') ?? 0.9);
  const skyCol = new THREE.Color(0x9fb2c4).convertSRGBToLinear();
  scene.background = skyCol;
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.02, 400);

  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.8, 0.58), 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(new THREE.Color(0.55, 0.65, 0.85), new THREE.Color(0.35, 0.28, 0.2), 0.25));

  const setSun = (azDeg: number, elDeg: number, dist = 30) => {
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
    sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(sun.target.position);
  };
  const label = (text: string, css: string) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:absolute;font:600 13px/1.2 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:2px 6px;border-radius:3px;white-space:nowrap;' + css;
    uiRoot.appendChild(el);
  };
  const optsFromUrl = (): MaterialOptionsExt => {
    const o: MaterialOptionsExt = {};
    if (params.get('tile')) o.tileSize = Number(params.get('tile'));
    if (params.get('seed')) o.seed = Number(params.get('seed'));
    if (params.get('wear')) o.wear = Number(params.get('wear'));
    if (params.get('map')) o.mapping = params.get('map') as MaterialOptionsExt['mapping'];
    return o;
  };
  const isArch = (n: string) => !/^(gun_|cloth_|glove|skin|car_|chrome|plastic|emissive|rubber)/.test(n);
  const neutral = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.19, 0.18), roughness: 0.9 });
  const single = params.get('m') as MaterialName | null;
  let draw: () => void;
  const prof: string[] = [];

  if (single && params.get('view') === 'maps') {
    // ---------------- raw baked maps, each tiled 2x2 to check seamless tiling
    const set = lib.textures(single)!;
    const panes: [string, THREE.Texture, string][] = [
      ['albedo (sRGB)', set.albedo, 'vec3 c = t.rgb;'],
      ['normal', set.normal, 'vec3 c = t.rgb;'],
      ['height', set.normal, 'vec3 c = vec3(t.a);'],
      ['AO', set.orm, 'vec3 c = vec3(t.r);'],
      ['roughness', set.orm, 'vec3 c = vec3(t.g);'],
      ['metal (r) / mask (g) / opacity (b)', set.orm, 'vec3 c = vec3(t.b, t.a, 0.0);'],
    ];
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    const qs = new THREE.Scene();
    qs.add(quad);
    const qc = new THREE.Camera();
    const W = container.clientWidth, H = container.clientHeight;
    const cw = Math.floor(W / 3), ch = Math.floor(H / 2);
    const zoom = Number(params.get('zoom') ?? 2);
    const mats = panes.map(([name, tex, code], i) => {
      label(name, `left:${(i % 3) * cw + 8}px;top:${Math.floor(i / 3) * ch + 8}px`);
      return new THREE.ShaderMaterial({
        uniforms: { t0: { value: tex }, uOp: { value: set.albedo } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D t0; uniform sampler2D uOp; varying vec2 vUv; void main(){ vec2 uv = vUv * ${zoom.toFixed(2)}; vec4 t = texture2D(t0, uv); ${code} ${i === 5 ? 'c.b = texture2D(uOp, uv).a;' : ''} gl_FragColor = vec4(c, 1.0); ${i === 0 ? 'gl_FragColor.rgb = pow(c, vec3(1.0/2.2));' : ''} }`,
      });
    });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setScissorTest(true);
    label(single, 'left:50%;bottom:10px;transform:translate(-50%,0)');
    draw = () => {
      mats.forEach((m, i) => {
        const x = (i % 3) * cw, y = H - (Math.floor(i / 3) + 1) * ch;
        quad.material = m;
        renderer.setViewport(x, y, cw, ch);
        renderer.setScissor(x, y, cw, ch);
        renderer.render(qs, qc);
      });
    };
  } else if (single) {
    // ---------------- close-up
    const o = optsFromUrl();
    const arch = isArch(single);
    const mat = lib.get(single, arch ? o : { mapping: 'object', ...o });
    const matWorld = lib.get(single, { ...o, mapping: o.mapping ?? 'world' });
    const view = params.get('view') ?? (arch ? 'wall' : 'sphere');
    if (view === 'far') {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(60, 0.2, 60), matWorld);
      floor.position.set(0, -0.1, 0);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(40, 8, 0.3), matWorld);
      wall.position.set(0, 4, -12);
      floor.receiveShadow = wall.receiveShadow = true;
      wall.castShadow = true;
      scene.add(floor, wall);
      camera.position.set(6, 1.7, 14);
      camera.lookAt(-2, 1.5, -12);
      camera.fov = 60;
    } else {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 6), matWorld);
      floor.position.set(0, -0.1, 0);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 0.25), matWorld);
      wall.position.set(0, 1.6, -3.0);
      const wall2 = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.2, 6), matWorld);
      wall2.position.set(-3.0, 1.6, 0);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 96, 64), mat);
      sphere.position.set(0.6, 0.5, -1.2);
      const box = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.4, 0.4, 4, 0.03), mat);
      box.position.set(-0.6, 0.2, -1.6);
      box.rotation.y = 0.5;
      for (const m of [floor, wall, wall2, sphere, box]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
      if (view === 'wall') { camera.position.set(1.4, 1.5, -1.3); camera.lookAt(-0.2, 1.3, -3.0); camera.fov = 45; }
      else if (view === 'close') { camera.position.set(0.5, 1.45, -2.25); camera.lookAt(-0.1, 1.3, -2.9); camera.fov = 40; }
      else if (view === 'floor') { camera.position.set(0.8, 1.3, 1.2); camera.lookAt(0, 0, -0.2); camera.fov = 50; }
      else if (view === 'box') { camera.position.set(-0.2, 0.7, -0.6); camera.lookAt(-0.6, 0.2, -1.6); camera.fov = 40; }
      else { camera.position.set(1.2, 1.0, 0.2); camera.lookAt(0.6, 0.5, -1.2); camera.fov = 35; }
    }
    sun.target.position.set(0, 0, -1.5);
    const [az, el] = (params.get('sun') ?? '-65,22').split(',').map(Number);
    setSun(az, el);
    const ext = view === 'far' ? 40 : 8;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, far: 80 });
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    label(`${single}  ${JSON.stringify(o)}  view=${view}`, 'left:50%;bottom:10px;transform:translate(-50%,0)');
    draw = () => renderer.render(scene, camera);
  } else {
    // ---------------- contact sheet: 4 x 2 viewports, one shared mini-set with swapped materials
    const perPage = 8;
    const page = Number(params.get('page') ?? 0);
    const names = (params.get('list')?.split(',') as MaterialName[] | undefined) ?? ALL_MATERIALS.slice(page * perPage, page * perPage + perPage);
    const cols = 4, rows = 2;
    const ground = new THREE.Mesh(new THREE.BoxGeometry(8, 0.1, 8), neutral);
    ground.position.y = -0.05;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 0.12), neutral);
    wall.position.set(0, 0.9, -0.55);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 1.5), neutral);
    floor.position.set(0, 0.02, 0.26);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.34, 96, 64), neutral);
    sphere.position.set(-0.42, 0.38, 0.28);
    const box = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.32, 0.32, 4, 0.025), neutral);
    box.position.set(0.5, 0.2, 0.3);
    box.rotation.y = 0.6;
    for (const m of [ground, wall, floor, sphere, box]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
    const cellMats = names.map((n) => {
      const arch = isArch(n);
      return {
        name: n,
        world: lib.get(n, {}),
        obj: lib.get(n, arch ? {} : { mapping: 'object' }),
        arch,
      };
    });
    const W = container.clientWidth, H = container.clientHeight;
    const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
    camera.fov = 38;
    camera.aspect = cw / ch;
    camera.position.set(1.15, 1.35, 2.75);
    camera.lookAt(0, 0.55, -0.05);
    camera.updateProjectionMatrix();
    sun.target.position.set(0, 0, 0);
    const [az, el] = (params.get('sun') ?? '-55,30').split(',').map(Number);
    setSun(az, el, 12);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, far: 40 });
    cellMats.forEach((c, i) => label(c.name, `left:${(i % cols) * cw + 8}px;top:${Math.floor(i / cols) * ch + ch - 26}px`));
    renderer.setScissorTest(true);
    draw = () => {
      renderer.autoClear = true;
      cellMats.forEach((c, i) => {
        const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
        wall.material = c.world;
        floor.material = c.arch ? c.world : neutral;
        sphere.material = c.obj;
        box.material = c.obj;
        renderer.setViewport(x, y, cw, ch);
        renderer.setScissor(x, y, cw, ch);
        const tc = performance.now();
        renderer.render(scene, camera);
        if (params.has('prof')) {
          const px = new Uint8Array(4);
          const gl = renderer.getContext();
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          prof.push(`${c.name} ${(performance.now() - tc).toFixed(0)}ms`);
        }
      });
    };
  }

  const info = document.createElement('div');
  info.style.cssText = 'position:absolute;left:8px;top:8px;font:12px monospace;color:#fff;background:rgba(0,0,0,.5);padding:4px 6px;white-space:pre';
  uiRoot.appendChild(info);

  const t1 = performance.now();
  draw();
  { // block until the GPU has finished (bakes + first frame), so screenshots don't time out
    const gl = renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
  const tFirst = performance.now() - t1;
  const total = lib.bakeStats.reduce((a, b) => a + b.ms, 0);
  info.textContent = `init ${tInit.toFixed(0)}ms  bake ${total.toFixed(0)}ms (${lib.bakeStats.length})  first frame ${tFirst.toFixed(0)}ms`;
  if (params.has('stats')) info.textContent += '\n' + lib.bakeStats.map((s) => `${s.name} ${s.ms.toFixed(0)}`).join('\n');
  if (params.has('noinfo')) info.remove();
  if (prof.length) { info.textContent += '\n' + prof.join('\n'); console.log(prof.join(' | ')); }

  // Static scene: render only when something changed (SwiftShader frames are very slow).
  let dirty = 0;
  window.__shameless.api = { lib, scene, camera, sun, renderer, setSun, redraw: () => { dirty = 1; } };
  const loop = () => {
    requestAnimationFrame(loop);
    if (dirty > 0 || params.has('animate')) { draw(); dirty--; }
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

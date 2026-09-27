import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createMaterialLibrary } from '../../materials';
import type { GameContext } from '../../core/types';
import { createGunMaterials } from '../../weapons/materials';
import { buildRifle } from '../../weapons/rifle';
import { buildPistol } from '../../weapons/pistol';
import { ArmRig, solveGrip, POSE_FLAT } from '../../weapons/arms';
import { xfToMatrix4 } from '../../weapons/arms';

/**
 * Beauty turntable: the rifle (or pistol) alone under studio-ish 3rd-person lighting to judge modeling detail.
 * API (window.__shameless.api): view(yaw, pitch, dist, target?), weapon('m4'|'m17'), hands(bool), magOut(bool)
 */
export default async function (container: HTMLElement, _ui: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const materials = createMaterialLibrary();
  await materials.init(renderer);
  const ctx = { renderer, materials } as unknown as GameContext;
  const mats = createGunMaterials(ctx);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  scene.background = new THREE.Color(0x1b1d20);

  const key = new THREE.DirectionalLight(0xfff2e0, 3.2);
  key.position.set(-0.6, 1.2, 0.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.1, far: 5 });
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.002;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xb8d4ff, 2.2);
  rim.position.set(0.8, 0.6, -1.0);
  scene.add(rim);
  const fill = new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 0.5);
  scene.add(fill);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.2;
  floor.receiveShadow = true;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(30, container.clientWidth / container.clientHeight, 0.01, 20);
  const rifle = buildRifle(mats);
  const pistol = buildPistol(mats);
  const holder = new THREE.Group();
  scene.add(holder);
  holder.add(rifle.root);
  // center the rifle roughly on its bounding box
  rifle.root.position.set(0, 0, 0.14);
  pistol.root.position.set(0, 0.02, 0.09);

  // Optional hands on the weapon (to judge grip)
  const armR = new ArmRig(mats, false), armL = new ArmRig(mats, true);
  const handsGroup = new THREE.Group();
  handsGroup.add(armR.group, armL.group);
  handsGroup.visible = false;
  let current = rifle;
  const poseHands = () => {
    const w = current;
    const rw = xfToMatrix4(w.rightGrip.wrist), lw = xfToMatrix4(w.leftGrip.wrist);
    const pr = solveGrip(armR.hand, rw, w.rightGrip, POSE_FLAT);
    const pl = solveGrip(armL.hand, lw, w.leftGrip, POSE_FLAT);
    armR.hand.applyPose(pr); armL.hand.applyPose(pl);
    const base = w.root.matrix.clone();
    w.root.updateMatrix();
    const R = w.root.matrix.clone().multiply(rw), L = w.root.matrix.clone().multiply(lw);
    armR.update(R, new THREE.Vector3(0.22, -0.30, 0.3), new THREE.Vector3(0.3, -0.1, 0.5));
    armL.update(L, new THREE.Vector3(-0.2, -0.28, -0.05), new THREE.Vector3(-0.3, -0.1, 0.4));
    void base;
  };
  holder.add(handsGroup);

  let yaw = -Math.PI / 2 - 0.35, pitch = 0.15, dist = 1.25;
  const target = new THREE.Vector3(0, -0.01, -0.1);
  const place = () => {
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    camera.lookAt(target);
  };
  place();

  window.__shameless.api = {
    view(y: number, p: number, d: number, t?: [number, number, number]) { yaw = y; pitch = p; dist = d; if (t) target.set(...t); place(); },
    weapon(id: string) {
      holder.remove(current.root);
      current = id === 'm17' ? pistol : rifle;
      holder.add(current.root);
      if (handsGroup.visible) poseHands();
    },
    hands(on: boolean) { handsGroup.visible = on; if (on) poseHands(); },
    magOut(on: boolean) {
      current.mag.position.y = on ? -0.12 : new THREE.Vector3().setFromMatrixPosition(current.magSeat).y;
    },
    boltBack(on: boolean) { current.bolt.position.z = on ? current.boltTravel : 0; if (current.dustCover) current.dustCover.rotation.z = on ? -1.9 : 0; },
    stats() {
      let tris = 0, meshes = 0;
      current.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { meshes++; const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
      return { tris, meshes };
    },
  };
  window.__shameless.ctx = ctx;

  const resize = () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  // Render on demand (SwiftShader is slow): every API call marks the frame dirty.
  let dirty = 1;
  let waiters: (() => void)[] = [];
  const api = window.__shameless.api as Record<string, (...a: unknown[]) => unknown>;
  for (const k of Object.keys(api)) {
    const f = api[k];
    api[k] = async (...a: unknown[]) => { const r = f(...a); dirty = 1; await new Promise<void>((res) => waiters.push(res)); return r; };
  }
  api.rendered = () => new Promise<void>((res) => { dirty = 1; waiters.push(res); });
  const loop = () => {
    requestAnimationFrame(loop);
    if (dirty > 0) {
      renderer.render(scene, camera);
      dirty--;
      if (dirty === 0) { const w = waiters; waiters = []; w.forEach((f) => f()); }
    }
    window.__shameless.frame++;
  };
  loop();
  window.__shameless.ready = true;
}

/**
 * Simplified AK-pattern rifle modelled in code, plus the enemy muzzle flash.
 * Rifle frame: origin = centre of the pistol grip (right-hand grip point), +Z = muzzle, +Y = up, +X = left.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/types';
import { characterMaterial } from './character';

export const RIFLE = {
  grip: new THREE.Vector3(0, 0, 0),
  /** Pistol-grip axis, bottom -> top. */
  gripAxis: new THREE.Vector3(0, 0.94, 0.34).normalize(),
  handguard: new THREE.Vector3(0, 0.052, 0.36),
  butt: new THREE.Vector3(0, 0.035, -0.355),
  muzzle: new THREE.Vector3(0, 0.078, 0.655),
  magwell: new THREE.Vector3(0, 0.02, 0.118),
  sightHeight: 0.135,
};

function extrudeSide(pts: [number, number][], width: number, bevel = 0.004): THREE.BufferGeometry {
  // profile in (z, y) plane, extruded along x (centered)
  const s = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  // shape x->z, shape y->y, extrude z->x
  const m = new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  g.translate(-(width - bevel * 2) / 2, 0, 0);
  // flip winding (the axis swap mirrors)
  const idx = g.index;
  if (idx) { for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); } }
  else { const p = g.attributes.position; for (let i = 0; i < p.count; i += 3) { for (const att of Object.values(g.attributes)) { const t = [] as number[]; for (let k = 0; k < att.itemSize; k++) t.push(att.getComponent(i + 1, k)); for (let k = 0; k < att.itemSize; k++) { att.setComponent(i + 1, k, att.getComponent(i + 2, k)); att.setComponent(i + 2, k, t[k]); } } } }
  g.computeVertexNormals();
  return g;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}
function cylZ(r0: number, r1: number, z0: number, z1: number, y: number, x = 0, seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  return n;
}
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list.map(clean), false)!;
  // flat AO attribute so the character material patch works
  g.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(1), 1));
  return g;
}

export interface RifleGeoms { metal: THREE.BufferGeometry; furniture: THREE.BufferGeometry; mag: THREE.BufferGeometry }
let cached: Record<string, RifleGeoms> = {};

export function rifleGeometry(polymer: boolean): RifleGeoms {
  const key = polymer ? 'p' : 'w';
  if (cached[key]) return cached[key];
  const metal: THREE.BufferGeometry[] = [];
  const furn: THREE.BufferGeometry[] = [];
  const bore = RIFLE.muzzle.y;
  // receiver + dust cover
  metal.push(boxAt(0.046, 0.058, 0.3, 0, 0.068, 0.118));
  metal.push(cylZ(0.022, 0.022, -0.02, 0.245, 0.092, 0, 14));
  metal.push(boxAt(0.05, 0.012, 0.03, 0, 0.046, 0.22)); // magwell lip
  metal.push(boxAt(0.012, 0.02, 0.05, -0.028, 0.065, 0.045)); // selector lever
  metal.push(cylZ(0.006, 0.006, 0.185, 0.215, 0.085, -0.036, 6)); // charging handle
  // trigger guard
  metal.push(boxAt(0.012, 0.006, 0.075, 0, 0.0, 0.07));
  metal.push(boxAt(0.012, 0.04, 0.006, 0, 0.018, 0.105));
  metal.push(boxAt(0.006, 0.02, 0.006, 0, 0.022, 0.06, 0.3)); // trigger
  // rear sight block
  metal.push(boxAt(0.034, 0.028, 0.05, 0, 0.113, 0.27));
  metal.push(boxAt(0.03, 0.012, 0.08, 0, 0.132, 0.3));
  // barrel, gas block, front sight, muzzle brake
  metal.push(cylZ(0.0105, 0.0095, 0.26, 0.6, bore, 0, 12));
  metal.push(cylZ(0.009, 0.009, 0.28, 0.48, bore + 0.035, 0, 10)); // gas tube (visible front)
  metal.push(boxAt(0.024, 0.05, 0.03, 0, bore + 0.018, 0.49));
  metal.push(boxAt(0.02, 0.07, 0.022, 0, bore + 0.03, 0.585));
  metal.push(cylZ(0.004, 0.004, 0.575, 0.595, bore + 0.07, 0, 6));
  metal.push(cylZ(0.0135, 0.013, 0.6, 0.66, bore, 0, 12));
  metal.push(cylZ(0.0035, 0.0035, 0.44, 0.58, bore - 0.02, 0, 6)); // cleaning rod
  // stock
  if (polymer) {
    furn.push(extrudeSide([[-0.02, 0.1], [-0.36, 0.078], [-0.365, -0.055], [-0.33, -0.058], [-0.13, 0.02], [-0.02, 0.03]], 0.04));
  } else {
    furn.push(extrudeSide([[-0.02, 0.1], [-0.36, 0.074], [-0.365, -0.06], [-0.33, -0.062], [-0.14, 0.018], [-0.02, 0.032]], 0.04));
  }
  metal.push(boxAt(0.044, 0.14, 0.012, 0, 0.008, -0.362)); // butt plate
  // pistol grip
  furn.push(extrudeSide([[0.034, 0.042], [0.0, 0.042], [-0.045, -0.085], [-0.012, -0.095], [0.018, -0.07], [0.03, 0.0]], 0.03, 0.006));
  // handguards
  furn.push(extrudeSide([[0.27, 0.098], [0.48, 0.098], [0.49, 0.058], [0.47, 0.035], [0.29, 0.035], [0.265, 0.06]], 0.05, 0.008));
  furn.push(extrudeSide([[0.275, 0.1], [0.46, 0.1], [0.45, 0.13], [0.3, 0.13]], 0.042, 0.008));
  // magazine: curved banana profile
  const mag: THREE.BufferGeometry[] = [];
  const magPts: [number, number][] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) { const t = i / N; const a = t * 0.55; magPts.push([0.095 + Math.sin(a) * 0.2 - 0.0, 0.045 - Math.sin(a + 0.3) * 0.22 + Math.sin(0.3) * 0.22]); }
  const back = magPts.map(([z, y]) => [z, y] as [number, number]);
  const front = magPts.map(([z, y], i) => { const t = i / N; return [z + 0.06 + t * 0.012, y + t * 0.012] as [number, number]; }).reverse();
  mag.push(extrudeSide([...back, ...front], 0.028, 0.004));
  const g: RifleGeoms = { metal: merge(metal), furniture: merge(furn), mag: merge(mag) };
  // magazine origin at magwell so it can be animated/detached
  g.mag.translate(-RIFLE.magwell.x, -RIFLE.magwell.y, -RIFLE.magwell.z);
  cached[key] = g;
  return g;
}

export interface RifleModel { group: THREE.Group; mag: THREE.Mesh; flash: MuzzleFlash }

export function buildRifle(ctx: GameContext, polymer: boolean): RifleModel {
  const geo = rifleGeometry(polymer);
  const group = new THREE.Group();
  const metal = new THREE.Mesh(geo.metal, characterMaterial(ctx, 'gun_parkerized', 0xffffff));
  const furn = new THREE.Mesh(geo.furniture, polymer ? characterMaterial(ctx, 'gun_polymer_black', 0xffffff) : characterMaterial(ctx, 'gun_wood', 0xffffff));
  const mag = new THREE.Mesh(geo.mag, polymer ? characterMaterial(ctx, 'gun_polymer_black', 0x9a6a3a) : characterMaterial(ctx, 'gun_parkerized', 0xffffff));
  mag.position.copy(RIFLE.magwell);
  for (const m of [metal, furn, mag]) { m.castShadow = true; m.receiveShadow = true; }
  group.add(metal, furn, mag);
  const flash = new MuzzleFlash();
  flash.group.position.copy(RIFLE.muzzle);
  group.add(flash.group);
  return { group, mag, flash };
}

// ------------------------------------------------------------------ muzzle flash

let flashTex: THREE.Texture | null = null;
let flashSideTex: THREE.Texture | null = null;

function makeFlashTextures() {
  if (flashTex) return;
  const mk = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // front view: 4-5 pointed star with hot core
  flashTex = mk(128, 128, (g) => {
    g.translate(64, 64);
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 60);
    grd.addColorStop(0, 'rgba(255,250,230,1)'); grd.addColorStop(0.15, 'rgba(255,215,140,0.95)'); grd.addColorStop(0.45, 'rgba(255,140,40,0.45)'); grd.addColorStop(1, 'rgba(255,90,10,0)');
    g.fillStyle = grd;
    for (let i = 0; i < 5; i++) {
      g.save(); g.rotate((i / 5) * Math.PI * 2 + 0.3);
      g.beginPath(); g.moveTo(-9, 0); g.quadraticCurveTo(0, -62, 9, 0); g.fill(); g.restore();
    }
    g.beginPath(); g.arc(0, 0, 22, 0, Math.PI * 2); g.fill();
  });
  // side view: elongated cone with side jets (AK brake)
  flashSideTex = mk(256, 64, (g) => {
    const grd = g.createLinearGradient(0, 0, 256, 0);
    grd.addColorStop(0, 'rgba(255,245,220,1)'); grd.addColorStop(0.3, 'rgba(255,200,110,0.9)'); grd.addColorStop(1, 'rgba(255,110,20,0)');
    g.fillStyle = grd;
    g.beginPath(); g.moveTo(0, 26); g.quadraticCurveTo(120, 8, 250, 32); g.quadraticCurveTo(120, 56, 0, 38); g.fill();
    for (let i = 0; i < 3; i++) {
      g.beginPath(); const x = 20 + i * 26; g.moveTo(x, 32); g.lineTo(x + 18, 6 - i * 2); g.lineTo(x + 10, 32); g.lineTo(x + 18, 58 + i * 2); g.fill();
    }
  });
}

export class MuzzleFlash {
  group = new THREE.Group();
  private t = 0;
  constructor() {
    makeFlashTextures();
    const mat = (tex: THREE.Texture) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(3, 2.6, 2.2) });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mat(flashTex!));
    const side = new THREE.PlaneGeometry(0.34, 0.085).translate(0.17, 0, 0).rotateY(-Math.PI / 2);
    const sm = mat(flashSideTex!);
    const s1 = new THREE.Mesh(side, sm);
    const s2 = new THREE.Mesh(side, sm); s2.rotation.z = Math.PI / 2;
    this.group.add(front, s1, s2);
    this.group.visible = false;
    this.group.traverse((o) => { o.renderOrder = 10; (o as THREE.Mesh).castShadow = false; });
  }
  fire(rng: () => number) {
    this.t = 0.045;
    this.group.visible = true;
    this.group.rotation.z = rng() * Math.PI * 2;
    const s = 0.75 + rng() * 0.5;
    this.group.scale.set(s, s, 0.8 + rng() * 0.6);
  }
  update(dt: number) {
    if (this.t <= 0) return;
    this.t -= dt;
    if (this.t <= 0) this.group.visible = false;
  }
  get active() { return this.t > 0; }
}

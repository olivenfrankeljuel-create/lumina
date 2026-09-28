import * as THREE from 'three';
import type { FX, GameContext } from '../core/types';
import type { Surface } from '../core/events';
import { generateSmokeFlipbook } from './flipbook';
import { SmokeLayer, SmokeParams } from './smoke';
import { StreakLayer, StreakParams } from './streaks';
import { Motes } from './motes';
import { BodyPool, BodyParams } from './bodies';
import { DecalSystem } from './decals';
import { Cell, generateDecalAtlas } from './decalAtlas';
import { FlashLights } from './lights';
import { rand, range, chance, count } from './rng';

/**
 * SHAMELESS visual effects.
 *
 * Everything is pooled and instanced: 1 draw call for all lit smoke/dust/fire/blood mist, 1 for
 * all sparks/grains/droplets/tracers, 1 for ambient motes, 3-4 for debris/casings, 2 for decals.
 * Particle motion is analytic on the GPU (upload once at spawn), so steady-state CPU cost is a few
 * uniforms plus the tiny rigid-body sims for chunks and casings.
 */
export interface FXExtras {
  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, dir: THREE.Vector3): void;
  explosion(position: THREE.Vector3, radius: number): void;
  blood(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, killed: boolean, headshot: boolean): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3, enemy: boolean): void;
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, suppressed: boolean, enemy: boolean): void;
  casing(pos: THREE.Vector3, vel: THREE.Vector3, kind: 'rifle' | 'pistol'): void;
  setAmbient(on: boolean): void;
  gust(): void;
  readonly time: number;
  readonly group: THREE.Group;
  stats(): Record<string, number>;
  debug(kind: string, p: THREE.Vector3): void;
  readonly textures: { flipbook: THREE.Texture; decalAlbedo: THREE.Texture; decalNormal: THREE.Texture };
}

/** Dev/test overrides (set before createFX). */
export const fxOptions = { flipRes: 0, muzzleLight: true };

interface Tier {
  mult: number; smoke: number; streaks: number; decals: number; bigDecals: number; debris: number; casings: number;
  motes: number; lights: number; flipRes: number; atlasCell: number; smokeShadows: boolean; casingLife: number;
}
const TIERS: Tier[] = [
  { mult: 0.45, smoke: 512, streaks: 1024, decals: 96, bigDecals: 16, debris: 48, casings: 24, motes: 160, lights: 1, flipRes: 1024, atlasCell: 128, smokeShadows: false, casingLife: 5 },
  { mult: 0.7, smoke: 1024, streaks: 2048, decals: 150, bigDecals: 24, debris: 96, casings: 40, motes: 320, lights: 2, flipRes: 1024, atlasCell: 256, smokeShadows: true, casingLife: 8 },
  { mult: 1.0, smoke: 1536, streaks: 3072, decals: 200, bigDecals: 32, debris: 128, casings: 64, motes: 480, lights: 3, flipRes: 2048, atlasCell: 256, smokeShadows: true, casingLife: 12 },
  { mult: 1.3, smoke: 2048, streaks: 4096, decals: 256, bigDecals: 48, debris: 192, casings: 96, motes: 700, lights: 3, flipRes: 2048, atlasCell: 256, smokeShadows: true, casingLife: 18 },
];

// ------------------------------------------------------------------ scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _hv = new THREE.Vector3(); // helper-private cone output
const _pg = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _refl = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _res = new THREE.Vector2();
const _sunDir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

function basis(n: THREE.Vector3): void {
  if (Math.abs(n.y) < 0.99) _t1.crossVectors(n, _up).normalize();
  else _t1.set(1, 0, 0).cross(n).normalize();
  _t2.crossVectors(n, _t1);
}
/** Random direction around axis a (unit) with cone spread s (0 = exact, 1 ≈ hemisphere). Result in out. */
function cone(a: THREE.Vector3, s: number, out: THREE.Vector3): THREE.Vector3 {
  basis(a);
  const phi = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * s;
  out.copy(a).addScaledVector(_t1, Math.cos(phi) * r).addScaledVector(_t2, Math.sin(phi) * r).normalize();
  return out;
}

interface SurfaceLook {
  dust: [number, number, number];
  chip: [number, number, number];
  grain: [number, number, number];
  decal: number[];
  decalSize: [number, number];
  tint: [number, number, number];
}
const LOOK: Partial<Record<Surface, SurfaceLook>> = {
  concrete: { dust: [0.68, 0.65, 0.6], chip: [0.5, 0.48, 0.45], grain: [0.4, 0.38, 0.35], decal: [Cell.ConcreteA, Cell.ConcreteB], decalSize: [0.22, 0.3], tint: [1, 1, 1] },
  brick: { dust: [0.6, 0.42, 0.33], chip: [0.5, 0.26, 0.18], grain: [0.45, 0.25, 0.18], decal: [Cell.ConcreteA, Cell.ConcreteB], decalSize: [0.22, 0.28], tint: [1, 0.72, 0.62] },
  asphalt: { dust: [0.36, 0.35, 0.33], chip: [0.12, 0.12, 0.12], grain: [0.18, 0.18, 0.17], decal: [Cell.ConcreteA, Cell.ConcreteB], decalSize: [0.2, 0.26], tint: [0.5, 0.5, 0.5] },
  tile: { dust: [0.75, 0.74, 0.7], chip: [0.8, 0.78, 0.74], grain: [0.7, 0.7, 0.68], decal: [Cell.PlasterA, Cell.PlasterB], decalSize: [0.18, 0.24], tint: [0.9, 0.9, 0.9] },
  plaster: { dust: [0.86, 0.85, 0.81], chip: [0.85, 0.84, 0.8], grain: [0.8, 0.79, 0.76], decal: [Cell.PlasterA, Cell.PlasterB], decalSize: [0.28, 0.36], tint: [1, 1, 1] },
  metal: { dust: [0.42, 0.41, 0.4], chip: [0.3, 0.3, 0.3], grain: [0.2, 0.2, 0.2], decal: [Cell.MetalHole, Cell.MetalHole, Cell.MetalDent], decalSize: [0.12, 0.15], tint: [1, 1, 1] },
  wood: { dust: [0.52, 0.42, 0.31], chip: [0.58, 0.42, 0.26], grain: [0.45, 0.32, 0.2], decal: [Cell.WoodA, Cell.WoodB], decalSize: [0.17, 0.23], tint: [1, 1, 1] },
  dirt: { dust: [0.36, 0.28, 0.2], chip: [0.26, 0.19, 0.13], grain: [0.2, 0.14, 0.09], decal: [Cell.DirtA], decalSize: [0.26, 0.34], tint: [1, 1, 1] },
  gravel: { dust: [0.48, 0.44, 0.38], chip: [0.4, 0.38, 0.35], grain: [0.3, 0.27, 0.23], decal: [Cell.DirtA], decalSize: [0.24, 0.3], tint: [0.9, 0.95, 1] },
  sand: { dust: [0.74, 0.63, 0.46], chip: [0.6, 0.5, 0.36], grain: [0.62, 0.52, 0.37], decal: [Cell.DirtA], decalSize: [0.26, 0.32], tint: [1, 1, 1] },
  glass: { dust: [0.8, 0.82, 0.84], chip: [0.75, 0.85, 0.9], grain: [0.8, 0.85, 0.9], decal: [Cell.GlassA, Cell.GlassB], decalSize: [0.34, 0.5], tint: [1, 1, 1] },
  fabric: { dust: [0.45, 0.43, 0.38], chip: [0.3, 0.3, 0.28], grain: [0.35, 0.33, 0.3], decal: [Cell.SmallHole], decalSize: [0.09, 0.12], tint: [1, 1, 1] },
  water: { dust: [0.8, 0.83, 0.86], chip: [0.7, 0.75, 0.8], grain: [0.7, 0.75, 0.8], decal: [], decalSize: [0, 0], tint: [1, 1, 1] },
};

export async function createFX(ctx: GameContext): Promise<FX & FXExtras> {
  const tier = TIERS[Math.max(0, Math.min(3, ctx.quality?.tier ?? 2))];
  const Q = tier.mult;
  const renderer = ctx.renderer;
  const group = new THREE.Group();
  group.name = 'fx';
  ctx.scene.add(group);

  // ---------------------------------------------------------------- resources
  const flip = generateSmokeFlipbook(renderer, fxOptions.flipRes || tier.flipRes);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const atlas = generateDecalAtlas(tier.atlasCell, aniso);
  const envMap = (ctx.materials && ctx.materials.envMap) || null;

  const smoke = new SmokeLayer(tier.smoke, flip);
  const streaks = new StreakLayer(tier.streaks);
  const motes = new Motes(tier.motes);
  smoke.mesh.receiveShadow = tier.smokeShadows;
  group.add(smoke.mesh, streaks.mesh, motes.mesh);

  const holes = new DecalSystem(atlas, tier.decals, envMap, 'fx:decals');
  const bigDecals = new DecalSystem(atlas, tier.bigDecals, envMap, 'fx:bigdecals');
  group.add(holes.mesh, bigDecals.mesh);

  // debris geometries
  const chunkGeo = (() => {
    const g = new THREE.IcosahedronGeometry(0.5, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      const k = 0.7 + 0.5 * (h - Math.floor(h));
      pos.setXYZ(i, x * k, y * k * 0.8, z * k);
    }
    g.computeVertexNormals();
    return g;
  })();
  const splinterGeo = (() => {
    const g = new THREE.CylinderGeometry(0.15, 0.5, 1, 4, 1);
    g.rotateY(Math.PI / 4);
    return g;
  })();
  const shardGeo = (() => {
    const g = new THREE.BufferGeometry();
    const v = [0, 0.5, 0.03, -0.35, -0.5, 0.03, 0.45, -0.3, 0.03, 0, 0.5, -0.03, 0.45, -0.3, -0.03, -0.35, -0.5, -0.03];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex([0, 1, 2, 3, 4, 5, 0, 2, 4, 0, 4, 3, 1, 5, 4, 1, 4, 2, 0, 3, 5, 0, 5, 1]);
    g.computeVertexNormals();
    return g;
  })();
  const casingGeo = (() => {
    // 5.56 case profile along +Y, unit length ~1 (scaled per kind): rim, body, shoulder, neck
    const pts = [
      [0, 0], [0.105, 0], [0.105, 0.02], [0.088, 0.03], [0.088, 0.055], [0.102, 0.065], [0.1, 0.72], [0.082, 0.8], [0.064, 0.83], [0.064, 1.0], [0.05, 1.0],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.LatheGeometry(pts, 10);
    g.translate(0, -0.5, 0);
    return g;
  })();

  const chunkMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMap });
  const splinterMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMap });
  const shardMat = new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, envMap, envMapIntensity: 2 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 1, envMap, envMapIntensity: 1.2 });

  const chunks = new BodyPool(chunkGeo, chunkMat, tier.debris);
  const splinters = new BodyPool(splinterGeo, splinterMat, Math.round(tier.debris * 0.6));
  const shards = new BodyPool(shardGeo, shardMat, Math.round(tier.debris * 0.5));
  const casings = new BodyPool(casingGeo, brassMat, tier.casings);
  casings.kind = 1;
  chunks.mesh.name = 'fx:chunks'; splinters.mesh.name = 'fx:splinters'; shards.mesh.name = 'fx:shards'; casings.mesh.name = 'fx:casings';
  if (tier.mult >= 1) { casings.mesh.castShadow = true; chunks.mesh.castShadow = true; }
  casings.mesh.receiveShadow = chunks.mesh.receiveShadow = splinters.mesh.receiveShadow = true;
  group.add(chunks.mesh, splinters.mesh, shards.mesh, casings.mesh);

  const flashes = new FlashLights(group, tier.lights);

  const S = new SmokeParams();
  const K = new StreakParams();
  const B = new BodyParams();

  let time = 0;
  let ambientOn = true;
  const wind = new THREE.Vector3(0.55, 0, 0.25);
  const windBase = new THREE.Vector3(0.9, 0, 0.4).normalize();
  let gustTimer = 4 + rand() * 6;
  let barrelHeat = 0;

  // lighting estimates for non-lights materials (grains/droplets) and fallback ambient
  const litEstimate = new THREE.Color(1, 1, 1);
  let ambientScan = 0;
  let sunIntensity = 3;
  const ambientAdd = smoke.material.uniforms.uAmbientAdd.value as THREE.Color;

  function scanLights(): void {
    let amb = 0;
    const ac = _col.setRGB(0, 0, 0);
    let found = false;
    ctx.scene.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || !o.visible) return;
      if ((o as THREE.HemisphereLight).isHemisphereLight) {
        const h = o as THREE.HemisphereLight;
        ac.r += (h.color.r + h.groundColor.r) * 0.5 * h.intensity; ac.g += (h.color.g + h.groundColor.g) * 0.5 * h.intensity; ac.b += (h.color.b + h.groundColor.b) * 0.5 * h.intensity;
        found = true; amb += h.intensity;
      } else if ((o as THREE.AmbientLight).isAmbientLight || (o as THREE.LightProbe).isLightProbe) {
        ac.r += l.color.r * l.intensity; ac.g += l.color.g * l.intensity; ac.b += l.color.b * l.intensity;
        found = true; amb += l.intensity;
      }
    });
    const sun = ctx.pipeline?.sun;
    sunIntensity = sun ? sun.intensity : 3;
    if (!found) {
      // scene lit by IBL only: give particles a plausible sky ambient
      ac.setRGB(0.55, 0.62, 0.75).multiplyScalar(Math.max(0.6, sunIntensity * 0.35));
      ambientAdd.copy(ac);
    } else ambientAdd.setRGB(0, 0, 0);
    // grains: albedo * (sun + ambient) / PI  (rough average orientation)
    const sy = sun ? Math.max(0.2, _sunDir.copy(sun.position).sub(sun.target.position).normalize().y) : 0.5;
    const sc = sun ? sun.color : _col.setRGB(1, 1, 1);
    litEstimate.setRGB(
      (sc.r * sunIntensity * (0.35 + 0.4 * sy) + ac.r) / Math.PI,
      (sc.g * sunIntensity * (0.35 + 0.4 * sy) + ac.g) / Math.PI,
      (sc.b * sunIntensity * (0.35 + 0.4 * sy) + ac.b) / Math.PI,
    );
  }

  // ---------------------------------------------------------------- helpers
  function camDist(p: THREE.Vector3): number {
    return ctx.camera.getWorldPosition(_cam).distanceTo(p);
  }
  function lod(p: THREE.Vector3): number {
    const d = camDist(p);
    return d < 20 ? 1 : d < 45 ? 0.65 : d < 90 ? 0.35 : d < 160 ? 0.15 : 0;
  }
  const _rayO = new THREE.Vector3();
  function floorBelow(p: THREE.Vector3, fallbackDrop = 1.6): number {
    _rayO.copy(p).addScaledVector(_up, 0.05);
    try {
      const hit = ctx.physics?.raycast(_rayO, _down, 30, { ignoreEnemies: true, ignorePlayer: true });
      if (hit) return hit.point.y;
    } catch { /* physics mid-change */ }
    try {
      const g = ctx.world?.groundHeight?.(p.x, p.z);
      if (g !== null && g !== undefined && g <= p.y + 0.05) return g;
    } catch { /* ignore */ }
    return p.y - fallbackDrop;
  }

  function puff(p: THREE.Vector3, n: THREE.Vector3, rgb: readonly number[], n0: number, size: number, life: number, speed: number, spread: number, opacity: number, accelY = 0.1, drag = 4, growPow = 4.5): void {
    for (let i = 0; i < n0; i++) {
      cone(n, spread, _hv);
      const sp = speed * range(0.5, 1.2);
      S.reset().at(p);
      S.px += n.x * size * 0.15; S.py += n.y * size * 0.15; S.pz += n.z * size * 0.15;
      S.vel(_hv.x * sp, _hv.y * sp, _hv.z * sp);
      S.life = life * range(0.75, 1.25);
      S.size0 = size * range(0.18, 0.3); S.size1 = size * range(0.8, 1.2);
      S.rot = rand() * 6.283; S.rotSpeed = range(-0.9, 0.9);
      S.drag = drag; S.accelY = accelY;
      S.frame0 = range(0, 6); S.frameRate = range(0.8, 1.0);
      const shade = range(0.9, 1.08);
      S.color(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, opacity * range(0.8, 1.1));
      S.plane(n, p);
      S.fadeIn = 0.012; S.fadePow = 1.6; S.growPow = growPow * range(0.8, 1.2);
      smoke.spawn(S);
    }
  }

  function grains(p: THREE.Vector3, n: THREE.Vector3, axis: THREE.Vector3, rgb: readonly number[], n0: number, speed: number, spread: number, width: number, life: number, floorY: number): void {
    for (let i = 0; i < n0; i++) {
      cone(axis, spread, _hv);
      const sp = speed * range(0.4, 1.2);
      K.reset().at(p).vel(_hv.x * sp, _hv.y * sp, _hv.z * sp);
      K.life = life * range(0.6, 1.3);
      K.width = width * range(0.6, 1.4);
      K.stretch = 0.035; K.drag = range(0.8, 2); K.gravity = 9.8;
      const shade = range(0.8, 1.15);
      K.color(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, 0.95);
      K.cool = 0; K.additive = 0; K.restitution = 0.25;
      K.floor(floorY);
      streaks.spawn(K);
    }
  }

  function sparks(p: THREE.Vector3, axis: THREE.Vector3, n0: number, speed: number, spread: number, bright: number, life: number, floorY: number, width = 0.007): void {
    for (let i = 0; i < n0; i++) {
      cone(axis, spread, _hv);
      const sp = speed * range(0.35, 1.25);
      K.reset().at(p).vel(_hv.x * sp, _hv.y * sp, _hv.z * sp);
      K.life = life * range(0.4, 1.3);
      K.width = width * range(0.6, 1.3);
      K.stretch = range(0.018, 0.035);
      K.drag = range(1.0, 3.0); K.gravity = 9.8;
      const b = bright * range(0.6, 1.4);
      K.color(1.0 * b, 0.62 * b, 0.28 * b, 1);
      K.cool = 1; K.additive = 1; K.restitution = 0.35;
      K.floor(floorY);
      streaks.spawn(K);
    }
  }

  function flashDot(p: THREE.Vector3, size: number, r: number, g: number, b: number, life: number): void {
    K.reset().at(p);
    K.life = life; K.width = size; K.stretch = 0; K.drag = 0; K.gravity = 0;
    K.color(r, g, b, 1); K.cool = 0; K.additive = 1; K.constant = 1;
    streaks.spawn(K);
  }

  function debris(pool: BodyPool, p: THREE.Vector3, n: THREE.Vector3, axis: THREE.Vector3, rgb: readonly number[], n0: number, sMin: number, sMax: number, speed: number, spread: number, floorY: number, shape: 'chunk' | 'splinter' | 'shard', life = 3.5): void {
    for (let i = 0; i < n0; i++) {
      cone(axis, spread, _hv);
      const sp = speed * range(0.4, 1.2);
      B.px = p.x + n.x * 0.02; B.py = p.y + n.y * 0.02; B.pz = p.z + n.z * 0.02;
      B.vx = _hv.x * sp; B.vy = _hv.y * sp; B.vz = _hv.z * sp;
      B.ax = range(-25, 25); B.ay = range(-25, 25); B.az = range(-25, 25);
      const s = range(sMin, sMax);
      if (shape === 'splinter') { B.sx = s * 0.18; B.sy = s; B.sz = s * 0.12; }
      else if (shape === 'shard') { B.sx = s; B.sy = s * range(0.7, 1.3); B.sz = s; }
      else { B.sx = s * range(0.7, 1.2); B.sy = s * range(0.6, 1.1); B.sz = s * range(0.7, 1.2); }
      _e.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
      _q.setFromEuler(_e);
      B.qx = _q.x; B.qy = _q.y; B.qz = _q.z; B.qw = _q.w;
      B.life = life * range(0.7, 1.3);
      B.floorY = floorY;
      B.nx = n.x; B.ny = n.y; B.nz = n.z; B.d = -(n.x * p.x + n.y * p.y + n.z * p.z);
      B.restitution = shape === 'shard' ? 0.2 : 0.3; B.friction = 0.5; B.drag = 0.3;
      const shade = range(0.8, 1.2);
      B.r = rgb[0] * shade; B.g = rgb[1] * shade; B.b = rgb[2] * shade;
      B.lieFlat = shape === 'splinter' ? 1 : 0;
      pool.spawn(B);
    }
  }

  // ---------------------------------------------------------------- recipes
  function impact(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, dir: THREE.Vector3): void {
    if (surface === 'flesh') return; // handled by enemy:hit
    const L = lod(point);
    if (L <= 0) return;
    const look = LOOK[surface] ?? LOOK.concrete!;
    const m = Q * L;
    _n.copy(normal).normalize();
    const n = _n;
    const p = _p.copy(point);
    // reflection of the bullet direction, and a jet axis between normal and reflection
    _refl.copy(dir).addScaledVector(n, -2 * dir.dot(n)).normalize();
    _v3.copy(n).multiplyScalar(1.3).add(_refl).normalize(); // jet axis
    const jet = _v3;
    const near = L >= 1;
    const floorY = near ? floorBelow(p) : p.y - 1.5;

    switch (surface) {
      case 'metal': {
        flashDot(p, 0.09, 14, 9, 5, 0.045);
        flashDot(p, 0.28, 2.2, 1.2, 0.5, 0.06);
        _v2.copy(n).multiplyScalar(0.6).add(_refl).normalize();
        sparks(p, _v2, count(18 * m + 4), 11, 0.75, 14, 0.4, floorY);
        sparks(p, n, count(6 * m), 5, 1.0, 8, 0.25, floorY, 0.005);
        puff(p, n, look.dust, count(1.5 * m + 0.5), 0.35, 0.9, 1.0, 0.5, 0.28, 0.25);
        grains(p, n, jet, look.grain, count(4 * m), 4, 0.8, 0.004, 0.5, floorY);
        break;
      }
      case 'wood': {
        puff(p, n, look.dust, count(2 * m + 1), 0.55, 1.6, 1.4, 0.55, 0.45);
        puff(p, jet, look.dust, count(2 * m), 0.3, 0.6, 6, 0.3, 0.45, 0, 9);
        if (near) debris(splinters, p, n, jet, look.chip, count(7 * m + 2), 0.03, 0.08, 4.5, 0.8, floorY, 'splinter');
        grains(p, n, jet, look.grain, count(10 * m), 6, 0.7, 0.004, 0.7, floorY);
        break;
      }
      case 'dirt': case 'sand': case 'gravel': {
        const heavy = surface !== 'sand';
        // upward-biased plume axis
        _v2.copy(n).add(_up).normalize().lerp(jet, 0.3).normalize();
        for (let i = 0; i < count(7 * m + 3); i++) {
          cone(_v2, 0.3, _v);
          const sp = range(4, 11) * (heavy ? 1 : 0.8);
          S.reset().at(p).vel(_v.x * sp, _v.y * sp, _v.z * sp);
          S.life = range(1.3, 2.2); S.size0 = range(0.08, 0.16); S.size1 = range(0.7, 1.2);
          S.rot = rand() * 6.28; S.rotSpeed = range(-1, 1); S.drag = range(3.2, 4.5); S.accelY = heavy ? -2.6 : -1.6;
          S.frame0 = range(0, 8); S.frameRate = 0.9; S.growPow = 4;
          const sh = range(0.8, 1.1);
          S.color(look.dust[0] * sh, look.dust[1] * sh, look.dust[2] * sh, range(0.7, 0.9));
          S.plane(n, p); S.fadeIn = 0.01; S.fadePow = 1.4;
          smoke.spawn(S);
        }
        puff(p, n, look.dust, count(3 * m + 1), 1.2, 2.2, 1.2, 1.0, 0.4, 0.05, 3, 3);
        grains(p, n, _v2, look.grain, count((heavy ? 30 : 40) * m + 6), 7, 0.45, heavy ? 0.014 : 0.007, 1.0, floorY);
        if (near && heavy) debris(chunks, p, n, _v2, look.chip, count(4 * m + 1), 0.01, 0.028, 4, 0.5, floorY, 'chunk', 2.5);
        break;
      }
      case 'glass': {
        flashDot(p, 0.05, 3, 3.2, 3.5, 0.04);
        puff(p, n, look.dust, count(1.5 * m + 0.5), 0.3, 0.8, 1.2, 0.5, 0.25);
        if (near) {
          debris(shards, p, n, n, look.chip, count(8 * m + 3), 0.012, 0.04, 3, 0.9, floorY, 'shard', 4);
          // shards also fall out the far side
          _v2.copy(n).negate();
          const fy2 = floorBelow(_pg.copy(p).addScaledVector(dir, 0.3));
          debris(shards, _pg.copy(p).addScaledVector(n, -0.03), _v2, dir, look.chip, count(5 * m), 0.012, 0.035, 2, 0.6, fy2, 'shard', 4);
        }
        // glints
        for (let i = 0; i < count(8 * m); i++) {
          cone(n, 0.9, _v);
          const sp = range(1.5, 4.5);
          K.reset().at(p).vel(_v.x * sp, _v.y * sp, _v.z * sp);
          K.life = range(0.3, 0.7); K.width = 0.004; K.stretch = 0.02; K.drag = 1.5; K.gravity = 9.8;
          K.color(2.5, 2.7, 3.0, 1); K.cool = 0; K.additive = 1; K.floor(floorY);
          streaks.spawn(K);
        }
        break;
      }
      case 'water': {
        _v2.copy(n).add(_up).normalize();
        grains(p, n, _v2, look.grain, count(22 * m + 4), 4.5, 0.4, 0.006, 0.8, floorY - 0.02);
        puff(p, _v2, look.dust, count(3 * m + 1), 0.5, 0.9, 3, 0.35, 0.4, -2, 5);
        break;
      }
      case 'fabric': {
        puff(p, n, look.dust, count(1.5 * m + 0.5), 0.3, 0.8, 1.0, 0.6, 0.3);
        grains(p, n, jet, look.grain, count(4 * m), 3, 0.8, 0.003, 0.5, floorY);
        break;
      }
      default: {
        // concrete, brick, asphalt, tile, plaster
        const powder = surface === 'plaster' || surface === 'tile';
        const size = powder ? 1.6 : 1.35;
        flashDot(p, 0.06, 4, 3.2, 2.2, 0.03);
        puff(p, n, look.dust, count(3 * m + 1), size, powder ? 2.4 : 1.9, 1.6, 0.6, powder ? 0.55 : 0.45, 0.06, 4, 5);
        puff(p, jet, look.dust, count(4 * m + 1), 0.75, 0.9, 10, 0.3, 0.7, 0, 8, 4);
        grains(p, n, jet, look.chip, count(18 * m + 5), 8, 0.6, 0.011, 0.75, floorY);
        if (near) debris(chunks, p, n, jet, look.chip, count(7 * m + 2), 0.008, 0.026, 5, 0.75, floorY, 'chunk');
        if (surface !== 'plaster' && chance(0.14)) sparks(p, _refl, count(4 * m + 1), 7, 0.6, 9, 0.2, floorY, 0.005);
        break;
      }
    }

    // decal
    if (look.decal.length && L >= 0.15) {
      const cell = look.decal[(rand() * look.decal.length) | 0];
      const size = range(look.decalSize[0], look.decalSize[1]);
      _col.setRGB(look.tint[0], look.tint[1], look.tint[2]);
      const heat = surface === 'metal' ? 1 : 0;
      holes.add(p, n, cell, size, rand() * Math.PI * 2, _col, surface === 'sand' ? 0.55 : 1, heat, time, false, cell === Cell.MetalDent ? 1.4 : 1);
    }
  }

  function blood(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, killed: boolean, headshot: boolean): void {
    const L = lod(point);
    if (L <= 0) return;
    const m = Q * L;
    const p = _p.copy(point);
    _n.copy(normal).normalize();
    const big = headshot ? 1.35 : killed ? 1.15 : 1;
    // exit mist (along bullet) + entry puff (back toward shooter)
    for (let i = 0; i < count(4 * m + 2); i++) {
      const exit = i % 3 !== 2;
      cone(exit ? dir : _n, exit ? 0.45 : 0.7, _v);
      const sp = exit ? range(1.5, 3.5) : range(0.6, 1.5);
      S.reset().at(p).vel(_v.x * sp, _v.y * sp, _v.z * sp);
      S.life = range(0.4, 0.7) * big; S.size0 = 0.08 * big; S.size1 = range(0.4, 0.65) * big; S.growPow = 5;
      S.rot = rand() * 6.28; S.rotSpeed = range(-1.5, 1.5); S.drag = 6; S.accelY = -0.4;
      S.frame0 = range(4, 14); S.frameRate = 0.7;
      S.color(range(0.11, 0.16), 0.008, 0.007, range(0.75, 0.95));
      S.fadeIn = 0.02; S.fadePow = 1.3; S.scatter = 0.35; S.normalStrength = 0.7;
      smoke.spawn(S);
    }
    const floorY = floorBelow(p, 1.2);
    // droplets
    for (let i = 0; i < count((headshot ? 22 : 12) * m + 3); i++) {
      cone(chance(0.75) ? dir : _n, 0.55, _v);
      const sp = range(1.5, 6);
      K.reset().at(p).vel(_v.x * sp, _v.y * sp, _v.z * sp);
      K.life = range(0.35, 0.8); K.width = range(0.003, 0.008); K.stretch = 0.03; K.drag = 1.2; K.gravity = 9.8;
      K.color(0.1, 0.005, 0.004, 0.95); K.cool = 0; K.additive = 0; K.restitution = 0; K.floor(floorY);
      streaks.spawn(K);
    }
    // wall splatter behind the target
    if (killed || headshot || chance(0.35)) {
      const reach = killed ? 3.2 : 2.0;
      let hit = null;
      try { hit = ctx.physics?.raycast(_v2.copy(p).addScaledVector(dir, 0.25), dir, reach, { ignoreEnemies: true, ignorePlayer: true }) ?? null; } catch { hit = null; }
      if (hit && hit.surface !== 'flesh' && hit.surface !== 'water') {
        const dist = hit.distance;
        const falloff = 1 - dist / (reach + 0.5);
        const size = (killed ? range(0.7, 1.1) : range(0.35, 0.55)) * (0.6 + 0.6 * falloff) * big;
        const vertical = Math.abs(hit.normal.y) < 0.5;
        const drip = vertical && chance(0.5);
        _v.copy(hit.normal).normalize();
        bigDecals.add(hit.point, _v, drip ? Cell.BloodDrip : chance(0.5) ? Cell.BloodA : Cell.BloodB, size, rand() * Math.PI * 2, null, 0.95 * Math.min(1, falloff + 0.3), 0, time, drip);
      }
    }
    if (killed && chance(0.8)) {
      _v.set(p.x + dir.x * 0.4, floorY, p.z + dir.z * 0.4);
      if (p.y - floorY < 2.2) bigDecals.add(_v, _up, chance(0.5) ? Cell.BloodA : Cell.BloodB, range(0.35, 0.6), rand() * 6.28, null, 0.8, 0, time);
    }
  }

  function tracer(from: THREE.Vector3, to: THREE.Vector3, enemy: boolean): void {
    _v.subVectors(to, from);
    const dist = _v.length();
    if (dist < 1.5) return;
    _v.divideScalar(dist);
    const speed = enemy ? 240 : 300;
    const len = Math.min(dist * 0.5, enemy ? 4.5 : 6);
    const r = enemy ? 26 : 22, g = enemy ? 6 : 10, b = enemy ? 2.4 : 3.6;
    // core + halo
    for (let k = 0; k < 2; k++) {
      K.reset().at(from).vel(_v.x * speed, _v.y * speed, _v.z * speed);
      K.life = dist / speed; K.stretch = len / speed; K.drag = 0.0005; K.gravity = 0;
      K.width = k === 0 ? 0.022 : 0.09;
      const s = k === 0 ? 1 : 0.08;
      K.color(r * s, g * s, b * s, 1); K.cool = 0; K.additive = 1; K.constant = 1;
      streaks.spawn(K);
    }
  }

  function muzzle(pos: THREE.Vector3, dir: THREE.Vector3, suppressed: boolean, enemy: boolean): void {
    const L = lod(pos);
    if (!suppressed) {
      const k = enemy ? 0.8 : 1;
      if (fxOptions.muzzleLight) flashes.trigger(time, pos, 1.0, 0.62, 0.3, sunIntensity * 4.5 * k + 6, enemy ? 6 : 8, 0.05, false);
      if (enemy && L > 0) {
        _v.copy(pos).addScaledVector(dir, 0.08);
        flashDot(_v, 0.12, 20, 11, 4, 0.05);
        flashDot(_v, 0.45, 2.5, 1.2, 0.4, 0.05);
        // short forward flame streak
        K.reset().at(pos).vel(dir.x * 6, dir.y * 6, dir.z * 6);
        K.life = 0.045; K.width = 0.06; K.stretch = 0.05; K.drag = 0; K.gravity = 0;
        K.color(14, 7, 2.5, 1); K.cool = 0; K.additive = 1; K.constant = 1;
        streaks.spawn(K);
      }
    }
    if (!enemy) barrelHeat = Math.min(1.5, barrelHeat + 0.1);
    if (L <= 0) return;
    const heatK = enemy ? 0.6 : 0.45 + barrelHeat * 0.5;
    for (let i = 0; i < (suppressed ? 2 : 1 + (chance(0.5 * Q) ? 1 : 0)); i++) {
      cone(dir, 0.35, _v);
      const sp = range(1.2, 3);
      S.reset().at(pos);
      S.px += dir.x * 0.08; S.py += dir.y * 0.08; S.pz += dir.z * 0.08;
      S.vel(_v.x * sp, _v.y * sp + 0.15, _v.z * sp);
      S.life = range(0.7, 1.2); S.size0 = 0.035; S.size1 = range(0.2, 0.32);
      S.rot = rand() * 6.28; S.rotSpeed = range(-1.5, 1.5); S.drag = 4.5; S.accelY = 0.35;
      S.frame0 = range(10, 20); S.frameRate = 0.7;
      S.color(0.66, 0.64, 0.62, 0.2 * heatK * (suppressed ? 1.3 : 1));
      S.fadeIn = 0.06; S.fadePow = 1.3; S.softMul = 0.5;
      smoke.spawn(S);
    }
  }

  function casing(pos: THREE.Vector3, vel: THREE.Vector3, kind: 'rifle' | 'pistol'): void {
    const len = kind === 'rifle' ? 0.045 : 0.019;
    const rad = kind === 'rifle' ? 0.0048 : 0.0049;
    B.px = pos.x; B.py = pos.y; B.pz = pos.z;
    B.vx = vel.x * range(0.9, 1.1) + range(-0.2, 0.2); B.vy = vel.y * range(0.9, 1.1); B.vz = vel.z * range(0.9, 1.1) + range(-0.2, 0.2);
    B.ax = range(-30, 30); B.ay = range(-8, 8); B.az = range(-30, 30);
    // lathe radius is 0.105 of unit length: real case radius ~4.8mm (5.56) / 4.9mm (9mm)
    B.sx = B.sz = rad / 0.105;
    B.sy = len;
    _e.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
    _q.setFromEuler(_e);
    B.qx = _q.x; B.qy = _q.y; B.qz = _q.z; B.qw = _q.w;
    B.life = tier.casingLife * range(0.9, 1.1);
    B.floorY = floorBelow(pos, 1.5);
    B.nx = B.ny = B.nz = B.d = 0;
    B.restitution = 0.42; B.friction = 0.6; B.drag = 0.2;
    const tone = range(0.9, 1.05);
    B.r = 0.95 * tone; B.g = 0.68 * tone; B.b = 0.34 * tone;
    B.lieFlat = 1;
    casings.spawn(B);
    // faint wisp from the ejection port
    S.reset().at(pos).vel(vel.x * 0.2, 0.3, vel.z * 0.2);
    S.life = 0.6; S.size0 = 0.02; S.size1 = 0.12; S.drag = 3; S.accelY = 0.4; S.frame0 = 20; S.frameRate = 0.6;
    S.color(0.7, 0.68, 0.66, 0.12); S.rot = rand() * 6.28;
    smoke.spawn(S);
  }

  function explosion(position: THREE.Vector3, radius: number): void {
    const R = Math.max(1, radius);
    const p = _p.copy(position);
    const L = Math.max(0.35, lod(p));
    const m = Q * L;
    const floorY = floorBelow(p, 0.5);
    const onGround = p.y - floorY < R * 0.6;
    const gp = _v3.set(p.x, onGround ? floorY : p.y, p.z);
    const s = R / 5;
    // light + camera
    flashes.trigger(time, _v.copy(p).addScaledVector(_up, 0.8), 1.0, 0.55, 0.22, (sunIntensity * 8 + 50) * s, R * 6, 0.45, true);
    const d = camDist(p);
    try { ctx.player?.addCameraShake(THREE.MathUtils.clamp(1.4 * (1 - d / (R * 9)), 0, 1.4)); } catch { /* ignore */ }
    try { ctx.pipeline?.flash(THREE.MathUtils.clamp(0.7 * (1 - d / (R * 7)), 0, 0.7)); } catch { /* ignore */ }

    // blinding core
    flashDot(_v.copy(p).addScaledVector(_up, 0.5 * s), 1.3 * s, 24, 13, 5, 0.06);
    flashDot(_v, 4 * s, 2.0, 0.9, 0.3, 0.1);
    // fireball: hot, fast-expanding lit+emissive puffs that cool into dark smoke
    for (let i = 0; i < count(14 * m + 5); i++) {
      cone(_up, 0.95, _v2);
      const sp = range(3, 10) * s;
      S.reset().at(p);
      S.py += 0.3 * s;
      S.vel(_v2.x * sp, _v2.y * sp * 0.8 + 1, _v2.z * sp);
      S.life = range(1.0, 1.7); S.size0 = range(0.6, 1.0) * s; S.size1 = range(2.4, 3.6) * s; S.growPow = 5;
      S.rot = rand() * 6.28; S.rotSpeed = range(-1.2, 1.2); S.drag = 4.5; S.accelY = 2.5;
      S.frame0 = range(0, 6); S.frameRate = 0.9;
      S.color(0.1, 0.09, 0.08, 1);
      S.heat = range(1.0, 1.25); S.fadeIn = 0.01; S.fadePow = 1.0; S.scatter = 0.4;
      if (onGround) S.plane(_up, gp);
      smoke.spawn(S);
    }
    // dark smoke billowing out around the fireball
    for (let i = 0; i < count(10 * m + 4); i++) {
      cone(_up, 1.0, _v2);
      const sp = range(4, 9) * s;
      S.reset().at(p);
      S.py += 0.5 * s;
      S.vel(_v2.x * sp, _v2.y * sp * 0.7 + 1.5, _v2.z * sp);
      S.life = range(2.5, 4); S.size0 = range(0.6, 1.0) * s; S.size1 = range(3.0, 4.2) * s; S.growPow = 4;
      S.rot = rand() * 6.28; S.rotSpeed = range(-0.8, 0.8); S.drag = 3.2; S.accelY = 1.2;
      S.frame0 = range(0, 10); S.frameRate = 0.8;
      const sh = range(0.7, 1.0);
      S.color(0.1 * sh, 0.095 * sh, 0.09 * sh, range(0.75, 0.95));
      S.delay = range(0.03, 0.1); S.fadeIn = 0.03; S.fadePow = 1.3; S.scatter = 0.6;
      if (onGround) S.plane(_up, gp);
      smoke.spawn(S);
    }
    // dirt jets
    if (onGround) {
      for (let i = 0; i < count(8 * m + 3); i++) {
        cone(_up, 0.6, _v2);
        const sp = range(9, 18) * Math.sqrt(s);
        S.reset().at(gp).vel(_v2.x * sp, _v2.y * sp, _v2.z * sp);
        S.life = range(1.4, 2.4); S.size0 = 0.3 * s; S.size1 = range(1.4, 2.2) * s;
        S.rot = rand() * 6.28; S.rotSpeed = range(-0.8, 0.8); S.drag = range(3, 4.5); S.accelY = -3.5;
        S.frame0 = range(0, 10); S.frameRate = 0.9;
        const sh = range(0.8, 1.1);
        S.color(0.3 * sh, 0.24 * sh, 0.18 * sh, 0.9);
        S.plane(_up, gp); S.fadeIn = 0.02; S.fadePow = 1.4; S.delay = 0.02;
        smoke.spawn(S);
      }
      // ground-hugging shock dust
      for (let i = 0; i < count(12 * m + 4); i++) {
        const a = rand() * 6.283;
        const sp = range(7, 13) * Math.sqrt(s);
        S.reset().at(gp);
        S.py += 0.2;
        S.vel(Math.cos(a) * sp, range(0.2, 1.2), Math.sin(a) * sp);
        S.life = range(1.8, 3.2); S.size0 = 0.5 * s; S.size1 = range(1.8, 3) * s;
        S.rot = rand() * 6.28; S.rotSpeed = range(-0.5, 0.5); S.drag = 2.6; S.accelY = 0.15;
        S.frame0 = range(0, 12); S.frameRate = 0.9;
        S.color(0.55, 0.49, 0.41, 0.55);
        S.plane(_up, gp); S.fadeIn = 0.03; S.fadePow = 1.3; S.softMul = 0.8;
        smoke.spawn(S);
      }
      // shockwave ring on the ground
      S.reset().at(gp);
      S.life = 0.55; S.size0 = 0.6 * s; S.size1 = R * 1.6;
      S.drag = 1; S.accelY = 0; S.frame0 = 30; S.frameRate = 0.4; S.rot = rand() * 6.28;
      S.color(0.6, 0.55, 0.47, 0.5); S.plane(_up, gp); S.orient = 1; S.fadeIn = 0.0; S.fadePow = 1.2; S.normalStrength = 0.5;
      smoke.spawn(S);
    }
    // lingering smoke column (rises, spreads, drifts with wind)
    for (let i = 0; i < count(12 * m + 5); i++) {
      const a = rand() * 6.283, rr = rand() * R * 0.3;
      S.reset().at(gp);
      S.px += Math.cos(a) * rr; S.pz += Math.sin(a) * rr; S.py += range(0.3, 1.5) * s;
      S.vel(range(-0.5, 0.5), range(1.5, 4.5) * s, range(-0.5, 0.5));
      S.life = range(6, 11); S.size0 = range(1.0, 1.6) * s; S.size1 = range(3.5, 5.5) * s;
      S.rot = rand() * 6.28; S.rotSpeed = range(-0.3, 0.3); S.drag = 0.9; S.accelY = 0.35;
      S.frame0 = range(0, 8); S.frameRate = 0.9;
      const sh = range(0.8, 1.15);
      S.color(0.2 * sh, 0.185 * sh, 0.17 * sh, range(0.55, 0.75));
      S.delay = range(0.08, 0.5); S.fadeIn = 0.1; S.fadePow = 1.2; S.softMul = 0.7;
      if (onGround) S.plane(_up, gp);
      smoke.spawn(S);
    }
    // embers / sparks
    sparks(p, _up, count(45 * m + 10), 20 * Math.sqrt(s), 1.0, 16, 1.2, floorY, 0.012);
    // dirt clods + debris chunks
    grains(gp, _up, _up, [0.2, 0.15, 0.1], count(40 * m + 8), 12 * Math.sqrt(s), 0.8, 0.012, 1.5, floorY);
    debris(chunks, _pg.copy(gp).addScaledVector(_up, 0.1), _up, _up, [0.28, 0.25, 0.22], count(22 * m + 6), 0.02, 0.07, 11 * Math.sqrt(s), 0.8, floorY, 'chunk', 5);
    // scorch
    if (onGround) bigDecals.add(_v.set(p.x, floorY, p.z), _up, Cell.Scorch, R * range(1.2, 1.6), rand() * 6.28, null, 0.95, 0.25, time);
  }

  function gust(): void {
    const cam = ctx.camera.getWorldPosition(_cam);
    // start upwind of a point in front of the camera so the gust sweeps through the view
    ctx.camera.getWorldDirection(_v2);
    _v2.y = 0;
    if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, -1);
    _v2.normalize();
    _v.copy(cam).addScaledVector(_v2, range(5, 12)).addScaledVector(windBase, -range(3, 6));
    const fy = floorBelow(_v, 1.6);
    if (cam.y - fy > 6) return; // not near the ground
    _v.y = fy;
    const look = LOOK.sand!;
    for (let i = 0; i < count(7 * Q + 2); i++) {
      S.reset().at(_v);
      S.px += range(-2, 2); S.pz += range(-2, 2); S.py += range(0.1, 0.6);
      const sp = range(2.5, 4.5);
      S.vel(windBase.x * sp, range(0.1, 0.5), windBase.z * sp);
      S.life = range(3, 5); S.size0 = range(0.4, 0.8); S.size1 = range(1.8, 3);
      S.rot = rand() * 6.28; S.rotSpeed = range(-0.4, 0.4); S.drag = 0.6; S.accelY = 0.05;
      S.frame0 = range(20, 40); S.frameRate = 0.4;
      S.color(look.dust[0] * 0.85, look.dust[1] * 0.85, look.dust[2] * 0.85, range(0.12, 0.2));
      S.nx = 0; S.ny = 1; S.nz = 0; S.d = -fy;
      S.fadeIn = 0.3; S.fadePow = 1; S.softMul = 0.9; S.delay = range(0, 0.8);
      smoke.spawn(S);
    }
    for (let i = 0; i < count(18 * Q + 4); i++) {
      K.reset();
      K.px = _v.x + range(-3, 3); K.py = fy + range(0.02, 0.4); K.pz = _v.z + range(-3, 3);
      const sp = range(3.5, 6.5);
      K.vel(windBase.x * sp, range(0.2, 1.2), windBase.z * sp);
      K.life = range(0.8, 1.8); K.width = 0.0022; K.stretch = 0.05; K.drag = 0.4; K.gravity = 2.5;
      K.color(look.grain[0], look.grain[1], look.grain[2], 0.8); K.cool = 0; K.additive = 0; K.restitution = 0.5; K.floor(fy);
      K.delay = range(0, 1.2);
      streaks.spawn(K);
    }
  }

  // ---------------------------------------------------------------- events
  const ev = ctx.events;
  ev.on('bullet:impact', (e) => impact(e.point, e.normal, e.surface, e.dir));
  ev.on('bullet:tracer', (e) => tracer(e.from, e.to, e.enemy));
  ev.on('weapon:fire', (e) => muzzle(e.muzzle, e.dir, e.suppressed, false));
  ev.on('enemy:fire', (e) => muzzle(e.origin, e.dir, false, true));
  ev.on('shell:eject', (e) => casing(e.position, e.velocity, e.kind));
  ev.on('explosion', (e) => explosion(e.position, e.radius));
  ev.on('enemy:hit', (e) => blood(e.point, e.normal, e.dir, e.killed, e.headshot));
  ev.on('player:land', (e) => {
    if (e.impactSpeed < 4.5) return;
    const look = LOOK[e.surface] ?? LOOK.concrete!;
    puff(e.position, _up, look.dust, count(3 * Q + 1), 0.6, 1.2, 1.2, 1.4, 0.25, 0, 5);
  });
  ev.on('player:slide', (e) => {
    puff(e.position, _up, LOOK.concrete!.dust, count(3 * Q + 1), 0.7, 1.4, 1.0, 1.2, 0.22, 0, 4);
  });
  ev.on('grenade:bounce', (e) => {
    if (e.speed < 2) return;
    const look = LOOK[e.surface] ?? LOOK.concrete!;
    puff(e.position, _up, look.dust, count(2 * Q + 1), 0.35, 0.9, 1.0, 1.0, 0.3, 0, 5);
  });

  scanLights();

  const fx: FX & FXExtras = {
    group,
    textures: { flipbook: flip, decalAlbedo: atlas.albedo, decalNormal: atlas.normal },
    get time() { return time; },
    impact, explosion, blood, tracer, muzzle, casing, gust,
    setAmbient(on: boolean) { ambientOn = on; motes.mesh.visible = on; },
    update(dt: number) {
      time += dt;
      if ((ambientScan -= dt) <= 0) { scanLights(); ambientScan = 2; }
      barrelHeat = Math.max(0, barrelHeat - dt * 0.5);
      // slowly varying wind
      const w = 0.45 + 0.25 * Math.sin(time * 0.13) + 0.1 * Math.sin(time * 0.71);
      wind.copy(windBase).multiplyScalar(w);
      renderer.getDrawingBufferSize(_res);
      const cam = ctx.camera.getWorldPosition(_cam);
      smoke.setTime(time);
      smoke.material.uniforms.uWind.value.copy(wind);
      streaks.setTime(time, _res.x, _res.y, litEstimate);
      motes.update(time, cam, _res.x, _res.y, wind);
      holes.update(time); bigDecals.update(time);
      flashes.update(time);
      if (dt > 0) {
        chunks.update(dt); splinters.update(dt); shards.update(dt); casings.update(dt);
        if (ambientOn && (gustTimer -= dt) <= 0) { gust(); gustTimer = range(7, 16); }
      }
      smoke.flush();
      streaks.flush();
    },
    debug(kind: string, p: THREE.Vector3) {
      if (kind === 'flash') flashDot(p, 0.28, 2.2, 1.2, 0.5, 0.5);
      if (kind === 'flash2') flashDot(p, 0.09, 14, 9, 5, 0.5);
      if (kind === 'spark') sparks(p, _up, 1, 3, 0.1, 10, 0.5, p.y - 1);
      if (kind === 'ms1') { _v2.set(0, 0.3, 1).normalize(); sparks(p, _v2, 18, 11, 0.75, 14, 0.4, p.y - 1); }
      if (kind === 'ms2') { _v2.set(0, 0, 1); sparks(p, _v2, 6, 5, 1.0, 8, 0.25, p.y - 1, 0.005); }
      if (kind === 'mg') { _v2.set(0, 0, 1); grains(p, _v2, _v2, [0.2, 0.2, 0.2], 4, 4, 0.8, 0.004, 0.5, p.y - 1); }
      if (kind.startsWith('decal')) {
        const cell = Number(kind.slice(5));
        _v2.set(0, 0, 1);
        (cell >= 10 && cell <= 13 ? bigDecals : holes).add(p, _v2, cell, 0.7, 0, null, 1, cell === 2 || cell === 3 ? 1 : 0, time, cell === 12);
      }
      if (kind === 'grain') grains(p, _up, _up, [0.3, 0.3, 0.3], 1, 3, 0.1, 0.01, 0.5, p.y - 1);
    },
    stats() {
      return {
        time, smoke: smoke.liveCount, streaks: streaks.liveCount(), decals: holes.count, bigDecals: bigDecals.count,
        tier: ctx.quality?.tier ?? -1,
      };
    },
  };
  return fx;
}

import * as THREE from 'three';
import type { MaterialLibrary, MaterialName, MaterialOptions } from '../core/types';
import type { Surface } from '../core/events';
import { Baker, type BakedSet } from './baker';
import { patchMaterial, type InjectFlags } from './inject';
import { DEFS } from './defs';
import type { Mapping, MatDef } from './defs/types';
import { createSkyEnvironment } from './env';

export { shGlobals } from './inject';
export { createSkyEnvironment } from './env';
export type { Mapping } from './defs/types';

/**
 * Extra, non-contract options. `mapping` overrides the material's default projection:
 *  - 'world'  : world-space triplanar (static level geometry; texel density from tileSize, no UVs needed)
 *  - 'object' : triplanar in the mesh's local space (moving / skinned meshes: weapons, characters, props)
 *  - 'uv'     : mesh UVs, tileSize = UV units per texture tile
 */
export interface MaterialOptionsExt extends MaterialOptions {
  mapping?: Mapping;
}

export const ALL_MATERIALS = Object.keys(DEFS) as MaterialName[];

const MAP_INDEX: Record<Mapping, 0 | 1 | 2> = { world: 0, object: 1, uv: 2 };

function hashSeed(n: number): number {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
function rand01(seed: number, k: number): number {
  return hashSeed(seed * 7919 + k * 104729) / 4294967296;
}
function nameSeed(name: string): number {
  return [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 9973;
}

function qualityTier(): number {
  const q = new URLSearchParams(location.search).get('q');
  return q !== null ? Math.max(0, Math.min(3, Number(q) | 0)) : 2;
}

export type MaterialLibraryExt = MaterialLibrary & {
  get(name: MaterialName, opts?: MaterialOptionsExt): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** Force-generate textures for a list of materials (e.g. behind a loading screen). */
  prewarm(names: MaterialName[]): void;
  /** Baked texture set of a material (generates it if needed). */
  textures(name: MaterialName): BakedSet | null;
  readonly bakeStats: { name: string; ms: number }[];
};

export function createMaterialLibrary(): MaterialLibraryExt {
  let renderer: THREE.WebGLRenderer | null = null;
  let baker: Baker | null = null;
  let macro: THREE.Texture | null = null;
  let envMap: THREE.Texture | null = null;
  let baseRes = 1024;
  let pomSteps = 16;
  const sets = new Map<MaterialName, BakedSet>();
  const cache = new Map<string, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>();
  const bakeStats: { name: string; ms: number }[] = [];

  function texturesFor(name: MaterialName): BakedSet | null {
    let set = sets.get(name);
    if (set) return set;
    if (!baker) return null;
    const def = DEFS[name];
    const res = THREE.MathUtils.clamp(THREE.MathUtils.floorPowerOfTwo(baseRes * (def.res ?? 1)), 128, 2048);
    const t0 = performance.now();
    set = baker.bake({ glsl: def.glsl, res, depth: def.depth, tile: def.tile, cavity: def.cavity ?? 1, seed: nameSeed(name) });
    bakeStats.push({ name, ms: performance.now() - t0 });
    sets.set(name, set);
    return set;
  }

  function build(name: MaterialName, opts: MaterialOptionsExt): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
    const def: MatDef = DEFS[name];
    const set = texturesFor(name);
    const physical = !!(def.physical || def.glass);
    const m = physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
    m.name = name;
    m.roughness = 1;
    m.metalness = 1;
    if (!set) return m;
    const mapping = opts.mapping ?? def.mapping ?? 'world';
    const tile = opts.tileSize ?? def.tile;
    const wear = THREE.MathUtils.clamp((def.wear ?? 0) + (opts.wear ?? 0), 0, 1);
    const dust = THREE.MathUtils.clamp((def.dust ?? 0) + (opts.wear ?? 0) * 0.5, 0, 1);
    const seed = opts.seed;
    const offset = new THREE.Vector3();
    const tint = new THREE.Vector3(1, 1, 1);
    if (seed !== undefined) {
      offset.set(rand01(seed, 1), rand01(seed, 2), rand01(seed, 3));
      const v = def.seedVar ?? 1;
      const val = 1 + (rand01(seed, 4) - 0.5) * 0.14 * v;
      const warm = (rand01(seed, 5) - 0.5) * 0.08 * v;
      tint.set(val * (1 + warm), val, val * (1 - warm * 1.4));
    }
    const flags: InjectFlags = {
      mapping: MAP_INDEX[mapping],
      pomSteps: def.pom && mapping === 'world' ? pomSteps : 0,
      stochastic: !!def.stochastic,
      glass: !!def.glass,
      emissive: !!def.emissive,
      edgeWear: !!def.edge && mapping !== 'world',
      dust: (def.dust ?? 0) > 0 || (opts.wear ?? 0) > 0,
    };
    const edge = def.edge ?? [0.5, 0.5, 0.5, 0.4];
    const uniforms: Record<string, THREE.IUniform> = {
      shA: { value: set.albedo },
      shN: { value: set.normal },
      shO: { value: set.orm },
      shMacro: { value: macro },
      shScale: { value: 1 / tile },
      shOffset: { value: offset },
      shTint: { value: tint },
      shWear: { value: wear },
      shPomDepth: { value: (def.pom ?? 0) / tile },
      shNormalScale: { value: def.normalScale ?? 1 },
      shMacroAmt: { value: def.macro ?? 0.05 },
      shDustAmt: { value: dust },
      shEdge: { value: new THREE.Vector4(...edge) },
    };
    patchMaterial(m, flags, uniforms);
    m.userData.sh = { name, uniforms, flags, tile };
    if (def.glass) {
      m.transparent = true;
      m.depthWrite = false;
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor;
      m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    def.setup?.(m);
    return m;
  }

  return {
    get envMap() { return envMap; },
    get bakeStats() { return bakeStats; },
    async init(r: THREE.WebGLRenderer) {
      renderer = r;
      const url = new URLSearchParams(location.search);
      const tier = qualityTier();
      baker = new Baker(r, url.has('aniso') ? Number(url.get('aniso')) : tier <= 0 ? 4 : 16);
      const override = Number(url.get('texres'));
      baseRes = override > 0 ? override : tier <= 0 ? 512 : tier === 3 ? 2048 : 1024;
      pomSteps = tier <= 0 ? 0 : tier === 1 ? 10 : tier === 2 ? 16 : 24;
      macro = baker.bakeMacro(512).texture;
      envMap = createSkyEnvironment(r);
    },
    get(name: MaterialName, opts: MaterialOptionsExt = {}) {
      const o = opts;
      if (!DEFS[name]) throw new Error(`unknown material ${name}`);
      const key = `${name}|${o.tileSize ?? ''}|${o.seed ?? ''}|${o.wear ?? ''}|${o.mapping ?? ''}`;
      let m = cache.get(key);
      if (!m) {
        m = build(name, o);
        cache.set(key, m);
      }
      return m;
    },
    surfaceOf(name: MaterialName): Surface {
      return DEFS[name]?.surface ?? 'concrete';
    },
    prewarm(names: MaterialName[]) {
      for (const n of names) texturesFor(n);
    },
    textures(name: MaterialName) {
      return texturesFor(name);
    },
  };
}

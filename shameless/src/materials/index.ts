import * as THREE from 'three';
import type { MaterialLibrary, MaterialName, MaterialOptions } from '../core/types';
import type { Surface } from '../core/events';

// STUB — replaced by the materials workstream.
export function createMaterialLibrary(): MaterialLibrary {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  return {
    envMap: null,
    async init() {},
    get(name: MaterialName, _opts?: MaterialOptions) {
      let m = cache.get(name);
      if (!m) {
        const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
        m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((h % 360) / 360, 0.15, 0.45), roughness: 0.8 });
        cache.set(name, m);
      }
      return m;
    },
    surfaceOf(name: MaterialName): Surface {
      if (name.startsWith('metal') || name.startsWith('gun') || name === 'chrome') return 'metal';
      if (name.startsWith('wood') || name === 'plywood') return 'wood';
      if (name.startsWith('glass')) return 'glass';
      if (['dirt', 'mud', 'grass_dry'].includes(name)) return 'dirt';
      if (name === 'sand' || name === 'sandbag') return 'sand';
      return 'concrete';
    },
  };
}

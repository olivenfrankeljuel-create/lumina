import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, Physics, RaycastHit } from '../core/types';
import type { Surface } from '../core/events';

// STUB — replaced/extended by the player+physics workstream.
export async function createPhysics(_ctx: GameContext): Promise<Physics> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const colliderInfo = new Map<number, { object: THREE.Object3D; surface: Surface }>();
  const hitboxes: { object: THREE.Object3D; enemyId: number; region: 'head' | 'torso' | 'limb'; half: THREE.Vector3 }[] = [];
  const tmpBox = new THREE.Box3();
  const ray = new THREE.Ray();
  const inv = new THREE.Matrix4();
  const hitP = new THREE.Vector3();

  return {
    world, rapier: RAPIER,
    addStatic(object, surface = 'concrete') {
      object.updateWorldMatrix(true, true);
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
        const pos = g.attributes.position;
        const verts = new Float32Array(pos.count * 3);
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); verts.set([v.x, v.y, v.z], i * 3); }
        const idx = new Uint32Array(pos.count); for (let i = 0; i < idx.length; i++) idx[i] = i;
        const c = world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx));
        colliderInfo.set(c.handle, { object: mesh, surface: (mesh.userData.surface as Surface) ?? surface });
      });
    },
    raycast(origin, dir, maxDist, opts): RaycastHit | null {
      let best: RaycastHit | null = null;
      const r = new RAPIER.Ray(origin, dir);
      const h = world.castRayAndGetNormal(r, maxDist, true);
      if (h) {
        const info = colliderInfo.get(h.collider.handle);
        best = { point: origin.clone().addScaledVector(dir, h.timeOfImpact), normal: new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z), distance: h.timeOfImpact, surface: info?.surface ?? 'concrete', object: info?.object ?? null };
      }
      if (!opts?.ignoreEnemies) {
        for (const hb of hitboxes) {
          hb.object.updateWorldMatrix(true, false);
          inv.copy(hb.object.matrixWorld).invert();
          ray.set(origin, dir).applyMatrix4(inv);
          tmpBox.min.copy(hb.half).negate(); tmpBox.max.copy(hb.half);
          if (!ray.intersectBox(tmpBox, hitP)) continue;
          hitP.applyMatrix4(hb.object.matrixWorld);
          const d = hitP.distanceTo(origin);
          if (d < maxDist && (!best || d < best.distance)) best = { point: hitP.clone(), normal: dir.clone().negate(), distance: d, surface: 'flesh', object: hb.object, enemyId: hb.enemyId, region: hb.region };
        }
      }
      return best;
    },
    registerHitbox(object, enemyId, region, halfExtents) { hitboxes.push({ object, enemyId, region, half: halfExtents.clone() }); },
    unregisterHitboxes(enemyId) { for (let i = hitboxes.length - 1; i >= 0; i--) if (hitboxes[i].enemyId === enemyId) hitboxes.splice(i, 1); },
    step(dt) { world.timestep = Math.min(dt, 1 / 30); world.step(); },
  };
}

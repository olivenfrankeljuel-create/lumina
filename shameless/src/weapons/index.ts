import * as THREE from 'three';
import type { GameContext, WeaponSystem } from '../core/types';

// STUB — replaced by the weapons workstream.
export async function createWeaponSystem(ctx: GameContext): Promise<WeaponSystem> {
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.6), ctx.materials.get('gun_parkerized'));
  gun.position.set(0.18, -0.16, -0.4);
  ctx.pipeline.viewmodelScene.add(gun);
  let cooldown = 0;
  const w = {
    currentId: 'm4', ammoInMag: 30, magSize: 30, reserveAmmo: 120, adsAmount: 0, reloading: false, fovTarget: 75, spread: 0.2,
    update(dt: number) {
      cooldown -= dt;
      if (ctx.input.down.has('fire') && cooldown <= 0 && w.ammoInMag > 0) {
        cooldown = 0.075; w.ammoInMag--;
        const origin = ctx.camera.getWorldPosition(new THREE.Vector3());
        const dir = ctx.camera.getWorldDirection(new THREE.Vector3());
        ctx.events.emit('weapon:fire', { weaponId: 'm4', origin, dir, muzzle: origin.clone(), suppressed: false });
        const hit = ctx.physics.raycast(origin, dir, 500);
        if (hit?.enemyId !== undefined) ctx.enemies.applyHit(hit.enemyId, 30, hit.point, dir, hit.region ?? 'torso');
        else if (hit) ctx.events.emit('bullet:impact', { point: hit.point, normal: hit.normal, surface: hit.surface, object: hit.object ?? undefined, dir });
        ctx.player.addRecoil(0.006, (Math.random() - 0.5) * 0.004);
      }
      if (ctx.input.pressed.has('reload')) { w.reserveAmmo -= w.magSize - w.ammoInMag; w.ammoInMag = w.magSize; }
    },
  };
  return w;
}

import * as THREE from 'three';
import type { EnemyInfo, EnemyManager, GameContext } from '../core/types';

// STUB — replaced by the AI/characters workstream.
export async function createEnemyManager(ctx: GameContext, opts: { count?: number } = {}): Promise<EnemyManager> {
  const enemies: (EnemyInfo & { mesh: THREE.Mesh; hp: number })[] = [];
  const spawns = ctx.world.enemySpawns.slice(0, opts.count ?? ctx.world.enemySpawns.length);
  spawns.forEach((s, id) => {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2), ctx.materials.get('cloth_olive'));
    mesh.position.copy(s).setY(s.y + 0.9);
    ctx.scene.add(mesh);
    ctx.physics.registerHitbox(mesh, id, 'torso', new THREE.Vector3(0.3, 0.9, 0.3));
    enemies.push({ id, position: mesh.position, alive: true, alerted: false, mesh, hp: 100 });
  });
  return {
    enemies,
    applyHit(id, dmg, point, dir, region) {
      const e = enemies[id];
      if (!e?.alive) return;
      e.hp -= dmg * (region === 'head' ? 3 : 1);
      const killed = e.hp <= 0;
      ctx.events.emit('enemy:hit', { enemyId: id, point, normal: dir.clone().negate(), dir, damage: dmg, headshot: region === 'head', killed });
      if (killed) { e.alive = false; e.mesh.visible = false; ctx.physics.unregisterHitboxes(id); ctx.events.emit('enemy:killed', { enemyId: id, headshot: region === 'head', position: e.position.clone(), weaponId: 'm4' }); }
    },
    update() {},
  };
}

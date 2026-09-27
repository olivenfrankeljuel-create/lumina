import * as THREE from 'three';
import type { GameContext, PlayerState } from '../core/types';

// STUB — replaced by the player+physics workstream.
export async function createPlayer(ctx: GameContext): Promise<PlayerState> {
  const spawn = ctx.world.playerSpawns[0];
  const position = spawn.position.clone();
  const velocity = new THREE.Vector3();
  const recoil = new THREE.Vector2();
  const p: PlayerState = {
    position, velocity, eyeHeight: 1.65, yaw: spawn.yaw, pitch: 0,
    grounded: true, sprinting: false, crouched: false, sliding: false, lean: 0,
    health: 100, maxHealth: 100, alive: true,
    addRecoil(pitch, yaw) { recoil.x += pitch; recoil.y += yaw; },
    addCameraShake() {},
    damage(amount, fromDir) { p.health = Math.max(0, p.health - amount); ctx.events.emit('player:damaged', { amount, health: p.health, fromDir }); },
    respawn() { position.copy(spawn.position); p.health = 100; },
    update(dt) {
      const i = ctx.input;
      p.yaw -= i.mouseDX * i.sensitivity; p.pitch -= i.mouseDY * i.sensitivity;
      p.pitch += recoil.x; p.yaw += recoil.y; recoil.set(0, 0);
      p.pitch = THREE.MathUtils.clamp(p.pitch, -1.5, 1.5);
      const f = (i.down.has('forward') ? 1 : 0) - (i.down.has('back') ? 1 : 0);
      const s = (i.down.has('right') ? 1 : 0) - (i.down.has('left') ? 1 : 0);
      const speed = i.down.has('sprint') ? 7 : 4.5;
      velocity.set(Math.sin(p.yaw) * -f + Math.cos(p.yaw) * s, 0, Math.cos(p.yaw) * -f - Math.sin(p.yaw) * s).normalize().multiplyScalar(f || s ? speed : 0);
      position.addScaledVector(velocity, dt);
      ctx.camera.position.set(position.x, position.y + p.eyeHeight, position.z);
      ctx.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    },
  };
  return p;
}

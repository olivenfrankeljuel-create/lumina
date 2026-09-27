import * as THREE from 'three';
import type { GameContext, World } from '../core/types';

// STUB — replaced by the world workstream.
export async function createWorld(ctx: GameContext): Promise<World> {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), ctx.materials.get('dirt'));
  root.add(ground);
  for (let i = 0; i < 12; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(4, 2 + (i % 4) * 2, 4), ctx.materials.get('concrete'));
    const a = (i / 12) * Math.PI * 2;
    b.position.set(Math.cos(a) * 20, b.geometry.parameters.height / 2, Math.sin(a) * 20);
    root.add(b);
  }
  ctx.scene.add(root);
  ctx.pipeline.setupShadows(root);
  ctx.physics.addStatic(root);
  return {
    root,
    playerSpawns: [{ position: new THREE.Vector3(0, 0, 0), yaw: 0 }],
    enemySpawns: [new THREE.Vector3(10, 0, -25), new THREE.Vector3(-12, 0, -22), new THREE.Vector3(0, 0, -30)],
    coverPoints: [],
    groundHeight: (x, z) => (Math.abs(x) < 100 && Math.abs(z) < 100 ? 0 : null),
    update() {},
  };
}

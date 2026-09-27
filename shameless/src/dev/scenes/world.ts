import * as THREE from 'three';
import { createGame, tick } from '../../core/Game';

/**
 * World dev scene: full game (no enemies) with a free camera for level-art review.
 * API (window.__shameless.api):
 *   cam(x, y, z, yaw, pitch, fov?)  — free camera (yaw 0 looks -Z / north)
 *   shot(name)                      — named camera shot (see SHOTS)
 *   look(x,y,z, tx,ty,tz, fov?)     — camera at a point looking at a target
 *   player()                        — return control to the player controller
 *   stats()                         — draw calls / triangles of the last frame + world stats
 */
const SHOTS: Record<string, [number, number, number, number, number, number?]> = {
  street: [2.2, 1.72, 53, 0.02, -0.03, 70],
  alley: [-21.6, 1.7, 47, 0.06, -0.02, 70],
  courtyard: [29.5, 1.7, 15.5, -0.72, 0.02, 70],
  rooftop: [13.6, 6.55 + 1.7, 15.2, 0.62, -0.2, 70],
  interior: [-11.2, 1.8, 16.8, 0.08, -0.04, 72],
  closeup: [-2.4, 1.6, 38.6, 1.45, 0.02, 60],
  market: [7.2, 1.75, 10.2, 1.1, -0.06, 70],
  overview: [58, 42, 70, 0.66, -0.45, 60],
  north: [1.5, 1.7, -61, Math.PI + 0.05, 0.0, 70],
  service: [22.4, 1.7, 50, 0.0, -0.02, 70],
  plaza: [-3, 1.7, -10.5, Math.PI - 0.1, -0.02, 72],
  alleymid: [-28.5, 1.7, 13.5, 0.1, 0.0, 72],
};

export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const ctx = await createGame({ container, uiRoot, shotMode: true, noEnemies: true });
  window.__shameless.ctx = ctx;
  uiRoot.style.display = 'none';
  ctx.pipeline.viewmodelScene.visible = false;
  let free: { x: number; y: number; z: number; yaw: number; pitch: number; fov: number } | null = null;
  let target: THREE.Vector3 | null = null;
  const origUpdate = ctx.player.update.bind(ctx.player);
  ctx.player.update = (dt: number) => {
    if (!free) return origUpdate(dt);
    ctx.camera.position.set(free.x, free.y, free.z);
    if (target) ctx.camera.lookAt(target);
    else ctx.camera.rotation.set(free.pitch, free.yaw, 0, 'YXZ');
    if (ctx.camera.fov !== free.fov) { ctx.camera.fov = free.fov; ctx.camera.updateProjectionMatrix(); }
  };
  const info = ctx.renderer.info;
  info.autoReset = false;
  let last = { calls: 0, triangles: 0 };
  const api = {
    cam(x: number, y: number, z: number, yaw: number, pitch: number, fov = 70) { free = { x, y, z, yaw, pitch, fov }; target = null; },
    look(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 70) { free = { x, y, z, yaw: 0, pitch: 0, fov }; target = new THREE.Vector3(tx, ty, tz); },
    shot(name: string) { const s = SHOTS[name]; if (!s) return `unknown shot ${name}`; api.cam(s[0], s[1], s[2], s[3], s[4], s[5] ?? 70); return name; },
    shots: () => Object.keys(SHOTS),
    player() { free = null; },
    stats() { return { ...last, world: (ctx.world as unknown as { stats: unknown }).stats, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length }; },
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;
  const q = new URLSearchParams(location.search).get('shotname');
  api.shot(q ?? 'street');
  let lastT = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    info.reset();
    tick(ctx, dt);
    last = { calls: info.render.calls, triangles: info.render.triangles };
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

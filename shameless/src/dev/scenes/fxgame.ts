import * as THREE from 'three';
import { createGame, tick } from '../../core/Game';
import type { FXExtras } from '../../fx';

/**
 * FX integration check inside the real game (all modules, no enemies).
 * window.__shameless.api:
 *   look(yaw, pitch)             pose the player camera
 *   fireAt(ndcX, ndcY, n)        raycast from the camera through a screen point and emit the
 *                                full weapon-less event chain (impact + tracer + casing)
 *   explode(dist)                explosion on the ground `dist` meters ahead
 *   blood(dist)                  killed-enemy blood hit `dist` meters ahead
 *   manual(on) / step(n) / render() / capture()
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const ctx = await createGame({ container, uiRoot, shotMode: true, noEnemies: true });
  window.__shameless.ctx = ctx;
  ctx.events.emit('game:state', { state: 'playing' });
  const fx = ctx.fx as unknown as FXExtras;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let manual = false;
  const step = (n: number) => { for (let i = 0; i < n; i++) tick(ctx, 1 / 60); };

  const api = {
    manual(on: boolean) { manual = on; },
    step,
    render() { ctx.pipeline.render(0); },
    capture() { return ctx.renderer.domElement.toDataURL('image/png'); },
    look(yaw: number, pitch: number) { ctx.player.yaw = yaw; ctx.player.pitch = pitch; step(1); },
    fireAt(x = 0, y = 0, n = 1, spread = 0.02) {
      const hits: string[] = [];
      for (let i = 0; i < n; i++) {
        ctx.camera.updateMatrixWorld();
        ndc.set(x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread);
        ray.setFromCamera(ndc, ctx.camera);
        const o = ray.ray.origin.clone(), d = ray.ray.direction.clone();
        const hit = ctx.physics.raycast(o, d, 300, { ignorePlayer: true });
        const muzzle = o.clone().addScaledVector(d, 0.8).add(new THREE.Vector3(0, -0.12, 0));
        ctx.events.emit('weapon:fire', { weaponId: 'fx', origin: o, dir: d, muzzle, suppressed: false });
        if (hit) {
          ctx.events.emit('bullet:impact', { point: hit.point.clone(), normal: hit.normal.clone(), surface: hit.surface, object: hit.object ?? undefined, dir: d });
          ctx.events.emit('bullet:tracer', { from: muzzle, to: hit.point.clone(), enemy: false });
          hits.push(`${hit.surface}@${hit.distance.toFixed(1)}`);
        }
        step(5);
      }
      return hits;
    },
    explode(dist = 12) {
      const p = ctx.camera.getWorldPosition(new THREE.Vector3());
      const d = ctx.camera.getWorldDirection(new THREE.Vector3()); d.y = 0; d.normalize();
      p.addScaledVector(d, dist);
      p.y = ctx.world.groundHeight(p.x, p.z) ?? 0;
      fx.explosion(p, 5);
    },
    blood(dist = 4) {
      const p = ctx.camera.getWorldPosition(new THREE.Vector3());
      const d = ctx.camera.getWorldDirection(new THREE.Vector3());
      p.addScaledVector(d, dist);
      ctx.events.emit('enemy:hit', { enemyId: 1, point: p, normal: d.clone().negate(), dir: d, damage: 50, headshot: false, killed: true });
    },
    stats() { return fx.stats(); },
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;

  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const s = window.__shameless;
    const dt = s.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!manual && !s.paused) tick(ctx, dt);
    s.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

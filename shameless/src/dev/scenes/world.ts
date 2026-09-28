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
  courtyard: [33.5, 1.7, 17.5, -0.55, 0.02, 72],
  rooftop: [10.5, 6.55 + 1.7, 25.5, 0.35, -0.22, 72],
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
    cam(x: number, y: number, z: number, yaw: number, pitch: number, fov = 70) { free = { x, y, z, yaw, pitch, fov }; target = null; budget = BUDGET; },
    look(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 70) { free = { x, y, z, yaw: 0, pitch: 0, fov }; target = new THREE.Vector3(tx, ty, tz); budget = BUDGET; },
    /** Render n more frames (SwiftShader is slow: frames are only rendered on demand). */
    render(n = BUDGET) { budget = n; },
    /** Continuous rendering (for interactive use in a real browser). */
    live() { budget = Infinity; },
    shot(name: string) { const s = SHOTS[name]; if (!s) return `unknown shot ${name}`; api.cam(s[0], s[1], s[2], s[3], s[4], s[5] ?? 70); return name; },
    shots: () => Object.keys(SHOTS),
    player() { free = null; },
    keys() {
      const m = new Map<string, { n: number; tris: number }>();
      ctx.world.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const k = String(mesh.userData.matKey ?? mesh.name);
        const e = m.get(k) ?? { n: 0, tris: 0 };
        e.n++;
        e.tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
        m.set(k, e);
      });
      return [...m.entries()].sort((a, b) => b[1].tris - a[1].tris).map(([k, e]) => `${k}:${e.n}:${Math.round(e.tris / 1000)}k`).join(' ');
    },
    /** Downward raycasts at every spawn and on a 2 m grid over the playable bounds; returns misses. */
    selfcheck() {
      const down = new THREE.Vector3(0, -1, 0);
      const miss: string[] = [];
      const probe = (x: number, z: number, tag: string, y0 = 40) => {
        const h = ctx.physics.raycast(new THREE.Vector3(x, y0, z), down, 80, { ignoreEnemies: true, ignorePlayer: true });
        if (!h) miss.push(`${tag}(${x.toFixed(1)},${z.toFixed(1)})`);
        return h;
      };
      for (const s of ctx.world.playerSpawns) probe(s.position.x, s.position.z, 'player');
      for (const s of ctx.world.enemySpawns) {
        const h = probe(s.x, s.z, 'enemy', s.y + 1.5);
        if (h && Math.abs(h.point.y - s.y) > 0.3) miss.push(`enemy-height(${s.x},${s.z}) hit ${h.point.y.toFixed(2)} vs ${s.y.toFixed(2)}`);
      }
      const b = (ctx.world as unknown as { bounds: { x0: number; x1: number; z0: number; z1: number } }).bounds;
      let n = 0;
      for (let x = b.x0 + 0.5; x < b.x1; x += 2) for (let z = b.z0 + 0.5; z < b.z1; z += 2) { probe(x, z, 'grid'); n++; }
      const res = { probes: n, misses: miss.length, list: miss.slice(0, 40), staticColliders: (ctx.physics as unknown as { staticCount?: number }).staticCount };
      console.info('[world selfcheck]', JSON.stringify(res));
      return res;
    },
    stats() { return { ...last, world: (ctx.world as unknown as { stats: unknown }).stats, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length }; },
  };
  window.__shameless.api = api as unknown as Record<string, unknown>;
  const params = new URLSearchParams(location.search);
  const BUDGET = Number(params.get('budget') ?? 4);
  let budget = params.has('live') ? Infinity : BUDGET;
  const q = params.get('shotname');
  api.shot(q ?? 'street');
  api.selfcheck();
  let lastT = performance.now();
  const px = new Uint8Array(4);
  // Frames are rendered only while budget > 0; the frame counter advances only on idle frames so the
  // screenshot tool's frame waits complete after the budgeted renders are done (keeps capture fast).
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (budget > 0) {
      budget--;
      info.reset();
      tick(ctx, dt);
      last = { calls: info.render.calls, triangles: info.render.triangles };
      // force GPU sync so idle frames (and screenshots) only start after the GPU finished this frame
      if (budget !== Infinity) { const gl = ctx.renderer.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      if (budget === Infinity) window.__shameless.frame++;
      return;
    }
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

import { createGame, tick } from '../../core/Game';

/** Example dev scene: full game, no enemies, camera posed via the player. */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const ctx = await createGame({ container, uiRoot, shotMode: true, noEnemies: true });
  window.__shameless.ctx = ctx;
  ctx.player.yaw = 0.4;
  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(ctx, dt);
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

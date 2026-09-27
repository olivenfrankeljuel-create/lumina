import { createGame, tick } from '../../core/Game';
import type { WeaponDebug } from '../../weapons';

/**
 * Weapon/viewmodel dev scene: full game (no enemies) with deterministic pose API.
 *   /?scene=weapon          on-demand rendering, driven by window.__shameless.api
 *   /?scene=weapon&live     normal game loop (click to lock the pointer and play)
 * API: pose(name, arg?) with name in
 *   hip | ads | fire(t) | adsfire(t) | sprint | tac | slide | reload(frac) | reloadEmpty(frac) | inspect(t) |
 *   pistol | pistolAds | pistolFire(t) | pistolReload(frac) | pistolReloadEmpty(frac) | switch(t) | look(dx)
 * view(yaw, pitch), hud(bool), fireMode('auto'|'semi')
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const live = new URLSearchParams(location.search).has('live');
  const ctx = await createGame({ container, uiRoot, shotMode: !live, noEnemies: true });
  window.__shameless.ctx = ctx;
  const dbg = (ctx.weapons as unknown as { debug: WeaponDebug }).debug;
  ctx.events.emit('game:state', { state: 'playing' });

  if (live) {
    const start = () => ctx.input.requestLock();
    ctx.renderer.domElement.addEventListener('click', start);
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
    return;
  }

  dbg.freezeIdle = true;
  let dirty = 3;
  const settle = () => dbg.advance(0.8);
  const prep = (id: string, ads: number, sprint: 0 | 1 | 2 | null = 0) => {
    dbg.reset();
    dbg.select(id);
    dbg.forceAds = ads;
    dbg.forceSprint = sprint;
    dbg.forceSlide = false;
    settle();
  };
  const poses: Record<string, (a?: number) => void> = {
    hip: () => prep('m4', 0),
    ads: () => prep('m4', 1),
    fire: (t = 0.03) => { prep('m4', 0); dbg.fireAndAdvance(t); },
    adsfire: (t = 0.03) => { prep('m4', 1); dbg.fireAndAdvance(t); },
    sprint: () => prep('m4', 0, 1),
    tac: () => prep('m4', 0, 2),
    slide: () => { prep('m4', 0); dbg.forceSlide = true; settle(); },
    reload: (f = 0.3) => { prep('m4', 0); dbg.reloadAt(f, false); },
    reloadEmpty: (f = 0.6) => { prep('m4', 0); dbg.reloadAt(f, true); },
    inspect: (t = 1.2) => { prep('m4', 0); dbg.inspectAt(t); },
    pistol: () => prep('m17', 0),
    pistolAds: () => prep('m17', 1),
    pistolFire: (t = 0.03) => { prep('m17', 0); dbg.fireAndAdvance(t); },
    pistolReload: (f = 0.5) => { prep('m17', 0); dbg.reloadAt(f, false); },
    pistolReloadEmpty: (f = 0.75) => { prep('m17', 0); dbg.reloadAt(f, true); },
    look: (dx = 3) => { prep('m4', 0); dbg.look(dx, 0); dbg.advance(0.12); },
  };
  let waiters: (() => void)[] = [];
  const rendered = () => new Promise<void>((res) => waiters.push(res));
  window.__shameless.api = {
    async pose(name: string, arg?: number) { poses[name](arg); dirty = 2; await rendered(); return dbg.state; },
    async view(yaw: number, pitch: number) { ctx.player.yaw = yaw; ctx.player.pitch = pitch; dirty = 2; await rendered(); },
    async hud(on: boolean) { uiRoot.style.display = on ? '' : 'none'; dirty = 1; await rendered(); },
    rendered() { dirty = Math.max(dirty, 1); return rendered(); },
    fireMode(m: 'auto' | 'semi') { dbg.setFireMode(m); },
    state() { return dbg.state; },
  };
  poses.hip();

  const loop = () => {
    requestAnimationFrame(loop);
    if (dirty > 0) {
      ctx.player.update(1 / 60);
      ctx.pipeline.render(1 / 60);
      ctx.input.endFrame();
      dirty--;
      if (dirty === 0) { const w = waiters; waiters = []; w.forEach((f) => f()); }
    }
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

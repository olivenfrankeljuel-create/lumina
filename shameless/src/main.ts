import { createGame, tick } from './core/Game';
import type { GameContext } from './core/types';

declare global {
  interface Window {
    /** Test/screenshot hook: tools/shot.mjs waits for ready and counts frames. */
    __shameless: { ready: boolean; frame: number; ctx?: GameContext; api?: Record<string, unknown>; paused?: boolean; fixedDt?: number };
  }
}

window.__shameless = { ready: false, frame: 0 };
const params = new URLSearchParams(location.search);
const container = document.getElementById('app')!;
const uiRoot = document.getElementById('ui')!;

async function runDevScene(name: string) {
  const scenes = import.meta.glob('./dev/scenes/*.ts');
  const key = `./dev/scenes/${name}.ts`;
  if (!scenes[key]) {
    uiRoot.innerHTML = `<pre style="color:#fff;padding:20px">Unknown scene "${name}". Available:\n${Object.keys(scenes).map((k) => k.slice(13, -3)).join('\n')}</pre>`;
    return;
  }
  const mod = (await scenes[key]()) as { default: (c: HTMLElement, ui: HTMLElement) => Promise<void> };
  await mod.default(container, uiRoot);
}

async function runGame() {
  const shotMode = params.has('shot');
  const ctx = await createGame({ container, uiRoot, shotMode, noEnemies: params.has('noenemies') });
  window.__shameless.ctx = ctx;

  let playing = shotMode;
  if (!shotMode) {
    ctx.hud.showMenu();
    const start = async () => {
      if (playing) { ctx.input.requestLock(); return; }
      playing = true;
      ctx.hud.hideMenu();
      ctx.input.requestLock();
      await ctx.audio.resume();
      ctx.events.emit('game:state', { state: 'playing' });
    };
    uiRoot.addEventListener('click', start);
    ctx.renderer.domElement.addEventListener('click', start);
    window.addEventListener('shameless:start', start);
  } else {
    ctx.events.emit('game:state', { state: 'playing' });
  }

  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const s = window.__shameless;
    if (s.paused) return;
    const dt = s.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(ctx, dt);
    s.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

const scene = params.get('scene');
(scene ? runDevScene(scene) : runGame()).catch((err) => {
  console.error(err);
  uiRoot.innerHTML = `<pre style="color:#f55;padding:20px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});

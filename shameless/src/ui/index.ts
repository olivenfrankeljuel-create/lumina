import type { GameContext, HUD } from '../core/types';

// STUB — replaced by the UI workstream.
export async function createHUD(ctx: GameContext, root: HTMLElement): Promise<HUD> {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;right:40px;bottom:30px;color:#fff;font:600 28px system-ui';
  root.appendChild(el);
  const menu = document.createElement('div');
  menu.style.cssText = 'position:absolute;inset:0;display:none;place-items:center;background:#000a;color:#fff;font:700 48px system-ui;pointer-events:auto;cursor:pointer';
  menu.textContent = 'SHAMELESS — CLICK TO PLAY';
  root.appendChild(menu);
  return {
    update() { el.textContent = `${ctx.weapons.ammoInMag} / ${ctx.weapons.reserveAmmo}`; },
    showMenu() { menu.style.display = 'grid'; },
    hideMenu() { menu.style.display = 'none'; },
  };
}

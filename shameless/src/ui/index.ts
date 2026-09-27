import '@fontsource/barlow-condensed/latin-400.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow-condensed/latin-800.css';
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow/latin-700.css';
import './hud.css';

import * as THREE from 'three';
import type { GameContext, HUD } from '../core/types';
import {
  DAMAGE_ARC, ICON_FLASH, ICON_FRAG, ICON_HEADSHOT, ICON_OBJECTIVE, ICON_ROUND, WEAPON_ICONS, medalSvg, type WeaponKind,
} from './icons';
import { MapBuilder, MinimapView, type Blip } from './minimap';
import { DeathScreen, MainMenu, PauseMenu, SettingsPanel, h } from './menus';
import { applySettings, loadSettings, saveSettings } from './settings';

type UIState = 'menu' | 'playing' | 'paused' | 'dead';

/** Extra hooks for dev scenes / tests (not part of the HUD contract). */
export interface HUDDev {
  state(): UIState;
  pause(): void;
  resume(): void;
  openSettings(): void;
  closeSettings(): void;
  die(info?: Partial<KillerInfo>): void;
  deathElapsed(t: number): void;
  interact(text: string | null, key?: string, sub?: string): void;
  equipment(frag: number, flash: number): void;
  /** Pause every running CSS/WAAPI animation at `ms` into its timeline (for screenshots). */
  freeze(ms: number): void;
  /** Drop every transient (hitmarker, feed, popups, medals, damage arcs). */
  clear(): void;
  unfreeze(): void;
  mapReady(): boolean;
}

interface KillerInfo { name: string; weapon: string; weaponKind: WeaponKind; distance: number | null }

// ------------------------------------------------------------------ weapon metadata

const WEAPONS: Record<string, { name: string; kind: WeaponKind; mode: 'AUTO' | 'SEMI' | 'BURST' | 'PUMP' | 'BOLT' }> = {
  m4: { name: 'M4', kind: 'rifle', mode: 'AUTO' },
  m4a1: { name: 'M4A1', kind: 'rifle', mode: 'AUTO' },
  ak: { name: 'AK-47', kind: 'rifle', mode: 'AUTO' },
  ak47: { name: 'AK-47', kind: 'rifle', mode: 'AUTO' },
  akm: { name: 'AKM', kind: 'rifle', mode: 'AUTO' },
  mcw: { name: 'MCW', kind: 'rifle', mode: 'AUTO' },
  scar: { name: 'SCAR-H', kind: 'rifle', mode: 'AUTO' },
  mp5: { name: 'MP5', kind: 'smg', mode: 'AUTO' },
  mp7: { name: 'MP7', kind: 'smg', mode: 'AUTO' },
  smg: { name: 'SMG', kind: 'smg', mode: 'AUTO' },
  pistol: { name: 'M17', kind: 'pistol', mode: 'SEMI' },
  m9: { name: 'M9', kind: 'pistol', mode: 'SEMI' },
  m17: { name: 'M17', kind: 'pistol', mode: 'SEMI' },
  glock: { name: 'GS45', kind: 'pistol', mode: 'SEMI' },
  deagle: { name: '.50 GS', kind: 'pistol', mode: 'SEMI' },
  shotgun: { name: 'M870', kind: 'shotgun', mode: 'PUMP' },
  m870: { name: 'M870', kind: 'shotgun', mode: 'PUMP' },
  sniper: { name: 'MORS', kind: 'sniper', mode: 'BOLT' },
  lmg: { name: 'PULEMYOT', kind: 'lmg', mode: 'AUTO' },
};

export function weaponInfo(id: string): { name: string; kind: WeaponKind; mode: string } {
  const k = id.toLowerCase();
  if (WEAPONS[k]) return WEAPONS[k];
  const kind: WeaponKind =
    /pistol|glock|m9|m17|1911|deagle|p226|usp/.test(k) ? 'pistol'
    : /smg|mp5|mp7|uzi|vector|mp9|p90/.test(k) ? 'smg'
    : /shot|870|spas|m1014|saiga/.test(k) ? 'shotgun'
    : /snip|awp|m24|svd|l115|kar|mors|dmr/.test(k) ? 'sniper'
    : /lmg|m249|pkm|rpk/.test(k) ? 'lmg' : 'rifle';
  const mode = kind === 'pistol' ? 'SEMI' : kind === 'shotgun' ? 'PUMP' : kind === 'sniper' ? 'BOLT' : 'AUTO';
  return { name: id.toUpperCase().replace(/[_-]+/g, ' '), kind, mode };
}

const MEDALS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'FURY KILL', 'FRENZY KILL', 'SUPER KILL', 'MEGA KILL'];
const ENEMY_ROLES = ['RIFLEMAN', 'GUNNER', 'SCOUT', 'BREACHER', 'MARKSMAN', 'SENTRY'];
const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

const DEG = 180 / Math.PI;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Tiny text cache so we only touch the DOM when a value actually changes. */
function textSetter(el: HTMLElement) {
  let last: string | null = null;
  return (v: string) => { if (v !== last) { last = v; el.textContent = v; } };
}

// ================================================================== createHUD

export async function createHUD(ctx: GameContext, root: HTMLElement): Promise<HUD & { dev: HUDDev }> {
  const params = new URLSearchParams(location.search);
  const testMode = params.has('shot') || params.has('scene');

  const ui = h('div', 'sh-root');
  ui.dataset.state = 'playing';
  root.appendChild(ui);
  const hud = h('div', 'sh-hud');
  ui.appendChild(hud);

  const settings = loadSettings(ctx);
  applySettings(ctx, settings);
  if (settings.quality !== ctx.quality.tier) applySettings(ctx, settings, 'quality');

  let state: UIState = 'playing';
  let clock = 0;
  const setState = (s: UIState, emit = false) => {
    if (s === state) return;
    state = s;
    ui.dataset.state = s;
    if (emit) ctx.events.emit('game:state', { state: s });
  };

  // ---------------------------------------------------------------- compass
  const COMPASS_W = 36; // em
  const COMPASS_RANGE = 150; // degrees visible
  const EM_PER_DEG = COMPASS_W / COMPASS_RANGE;
  const compass = h('div', 'sh-compass sh-hide-dead');
  const strip = h('div', 'sh-cmp-strip');
  {
    const parts: string[] = [];
    for (let d = -180; d <= 540; d += 5) {
      const n = wrap360(d);
      const x = ((d + 180) * EM_PER_DEG).toFixed(3);
      const mid = n % 15 === 0;
      parts.push(`<i class="sh-cmp-tick${mid ? ' mid' : ''}" style="left:${x}em"></i>`);
      if (CARDINALS[n] !== undefined) parts.push(`<span class="sh-cmp-lbl${n % 90 === 0 ? ' card' : ' inter'}" style="left:${x}em"><b>${CARDINALS[n]}</b></span>`);
      else if (n % 15 === 0) parts.push(`<span class="sh-cmp-lbl" style="left:${x}em">${n}</span>`);
    }
    strip.innerHTML = parts.join('');
  }
  compass.appendChild(strip);
  const cmpEnemies: HTMLDivElement[] = [];
  for (let i = 0; i < 8; i++) { const e = h('div', 'sh-cmp-enemy'); compass.appendChild(e); cmpEnemies.push(e); }
  compass.appendChild(h('div', 'sh-cmp-caret'));
  hud.appendChild(compass);
  const cmpRead = h('div', 'sh-cmp-read sh-hide-dead');
  hud.appendChild(cmpRead);
  const setHeading = textSetter(cmpRead);
  let lastStripX = Infinity;

  // ---------------------------------------------------------------- minimap
  const mapBuilder = new MapBuilder(ctx);
  const minimap = new MinimapView(mapBuilder.layout);
  minimap.rotate = settings.minimapRotate;
  minimap.el.classList.add('sh-hide-dead');
  hud.appendChild(minimap.el);

  // ---------------------------------------------------------------- objective + score
  const obj = h('div', 'sh-obj sh-hide-dead');
  obj.innerHTML = `
    <div class="sh-obj-head">${ICON_OBJECTIVE}<span class="t">OBJECTIVE</span></div>
    <div class="sh-obj-line"><span class="d">Eliminate all hostiles</span><span class="sh-obj-count"></span></div>
    <div class="sh-obj-bar"><i></i></div>
    <div class="sh-score"><span class="sh-score-lbl">SCORE</span><span class="sh-score-val">0</span></div>`;
  hud.appendChild(obj);
  const objCount = obj.querySelector<HTMLElement>('.sh-obj-count')!;
  const objBar = obj.querySelector<HTMLElement>('.sh-obj-bar i')!;
  const objHeadT = textSetter(obj.querySelector<HTMLElement>('.sh-obj-head .t')!);
  const objDesc = textSetter(obj.querySelector<HTMLElement>('.sh-obj-line .d')!);
  const scoreVal = obj.querySelector<HTMLElement>('.sh-score-val')!;
  let lastObjKey = '';

  // ---------------------------------------------------------------- kill feed
  const feed = h('div', 'sh-feed');
  hud.appendChild(feed);
  const feedRows: { el: HTMLDivElement; t: number; leaving: boolean }[] = [];
  const addFeed = (html: string) => {
    const el = h('div', 'sh-feed-row', html);
    feed.appendChild(el);
    el.animate([{ opacity: 0, transform: 'translateX(1.5em)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    feedRows.push({ el, t: clock, leaving: false });
    while (feedRows.length > 5) feedRows.shift()!.el.remove();
  };

  // ---------------------------------------------------------------- centre: crosshair, hitmarker, damage
  const center = h('div', 'sh-center');
  hud.appendChild(center);
  const dmgLayer = h('div', 'sh-dmg');
  center.appendChild(dmgLayer);
  const ch = h('div', 'sh-ch');
  const chT = h('i', 'v'), chB = h('i', 'v'), chL = h('i', 'h'), chR = h('i', 'h'), chDot = h('i', 'dot');
  ch.append(chT, chB, chL, chR, chDot);
  center.appendChild(ch);
  const hit = h('div', 'sh-hit');
  for (const a of [45, 135, 225, 315]) {
    const i = h('i');
    i.style.transform = `rotate(${a}deg) translateX(0.42em)`;
    hit.appendChild(i);
  }
  center.appendChild(hit);
  let chSpread = 0, chLastGap = -1, chHidden = false;

  const arcs = Array.from({ length: 6 }, () => {
    const el = h('div', 'sh-dmg-arc', DAMAGE_ARC);
    dmgLayer.appendChild(el);
    return { el, dir: new THREE.Vector3(), age: 99, life: 1.6, lastRot: '', lastOp: '' };
  });

  // ---------------------------------------------------------------- score popup + medals
  const pop = h('div', 'sh-pop');
  pop.innerHTML = `<div class="sh-pop-pts"></div><div class="sh-pop-reasons"></div>`;
  hud.appendChild(pop);
  const popPts = pop.querySelector<HTMLElement>('.sh-pop-pts')!;
  const popReasons = pop.querySelector<HTMLElement>('.sh-pop-reasons')!;
  let popTotal = 0, popAge = 99, popLastOp = '';
  const medal = h('div', 'sh-medal');
  medal.innerHTML = `<div class="sh-medal-icon"></div><div class="sh-medal-name"></div><div class="sh-medal-sub"></div>`;
  hud.appendChild(medal);

  // ---------------------------------------------------------------- prompts
  const prompt = h('div', 'sh-prompt');
  hud.appendChild(prompt);
  let promptKey = '';
  const interact = h('div', 'sh-interact');
  hud.appendChild(interact);

  // ---------------------------------------------------------------- health
  const health = h('div', 'sh-health sh-hide-dead');
  health.innerHTML = `
    <div class="sh-health-top">
      <div class="sh-health-lbl"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 1h4v5h5v4h-5v5H6v-5H1V6h5z"/></svg>HEALTH</div>
      <div class="sh-health-num">100</div>
    </div>
    <div class="sh-health-bar"><i class="lag"></i><i class="fill"></i><i class="seg"></i></div>`;
  hud.appendChild(health);
  const hpNum = textSetter(health.querySelector<HTMLElement>('.sh-health-num')!);
  const hpFill = health.querySelector<HTMLElement>('.fill')!;
  const hpLag = health.querySelector<HTMLElement>('.lag')!;
  let lastHpFrac = -1;

  // ---------------------------------------------------------------- weapon panel
  const wp = h('div', 'sh-weapon sh-hide-dead');
  wp.innerHTML = `
    <div class="sh-equip">
      <div class="sh-eq" data-k="lethal"><span class="key">G</span><span class="ico">${ICON_FRAG}</span><span class="n">2</span></div>
      <div class="sh-eq" data-k="tactical"><span class="key">4</span><span class="ico">${ICON_FLASH}</span><span class="n">2</span></div>
    </div>
    <div class="sh-wname"></div>
    <div class="sh-wmain">
      <div class="sh-wleft"><div class="sh-wicon"></div></div>
      <div class="sh-ammo">
        <div class="sh-mag">0</div>
        <div class="sh-ammo-side"><div class="sh-firemode"></div><div class="sh-reserve">0</div></div>
      </div>
    </div>
    <div class="sh-pips"></div>`;
  hud.appendChild(wp);
  const wName = textSetter(wp.querySelector<HTMLElement>('.sh-wname')!);
  const wIcon = wp.querySelector<HTMLElement>('.sh-wicon')!;
  const wMag = textSetter(wp.querySelector<HTMLElement>('.sh-mag')!);
  const wMagEl = wp.querySelector<HTMLElement>('.sh-mag')!;
  const wRes = textSetter(wp.querySelector<HTMLElement>('.sh-reserve')!);
  const wMode = wp.querySelector<HTMLElement>('.sh-firemode')!;
  const wPips = wp.querySelector<HTMLElement>('.sh-pips')!;
  const eqLethal = wp.querySelector<HTMLElement>('[data-k=lethal]')!;
  const eqTact = wp.querySelector<HTMLElement>('[data-k=tactical]')!;
  let pipEls: HTMLElement[] = [];
  let lastWeapon = '', lastMagSize = -1, lastAmmo = -1, lastPipFilled = -1, lastWClass = '';
  let frags = 2, flashes = 2;
  const setEquip = () => {
    eqLethal.querySelector('.n')!.textContent = String(frags);
    eqTact.querySelector('.n')!.textContent = String(flashes);
    eqLethal.classList.toggle('empty', frags <= 0);
    eqTact.classList.toggle('empty', flashes <= 0);
  };
  setEquip();

  // ---------------------------------------------------------------- menus
  const layerHost = h('div');
  ui.appendChild(layerHost);
  const settingsPanel = new SettingsPanel(settings, (key) => {
    applySettings(ctx, settings, key);
    if (key === 'minimapRotate') minimap.rotate = settings.minimapRotate;
    saveSettings(settings);
  });
  let menuYaw: number | null = null;
  const play = () => {
    window.dispatchEvent(new Event('shameless:start'));
    // main.ts hides the menu on first start; after "quit to menu" it only re-locks the pointer.
    if (state === 'menu') { api.hideMenu(); ctx.events.emit('game:state', { state: 'playing' }); }
  };
  const mainMenu = new MainMenu(mapBuilder.layout, { play, settings: () => settingsPanel.show() }, () => ctx.enemies.enemies.length);
  mapBuilder.onReady = () => { if (state === 'menu') mainMenu.drawMap(); };
  const pauseMenu = new PauseMenu({
    resume: () => resume(),
    settings: () => settingsPanel.show(),
    restart: () => { ctx.player.respawn(); resume(); },
    quit: () => {
      pauseMenu.hide();
      setPaused(false);
      api.showMenu();
      ctx.events.emit('game:state', { state: 'menu' });
    },
  });
  const death = new DeathScreen();
  layerHost.append(death.el, mainMenu.el, pauseMenu.el, settingsPanel.el);
  settingsPanel.onClose = () => settingsPanel.hide();
  settingsPanel.onToggle = (open) => ui.classList.toggle('sh-settings-open', open);

  const setPaused = (p: boolean) => { if (!testMode) window.__shameless.paused = p; };
  const stats = { kills: 0, headshots: 0, shots: 0, hits: 0, score: 0, start: 0 };
  const pause = () => {
    if (state !== 'playing') return;
    setState('paused', true);
    pauseMenu.setStats({ kills: stats.kills, headshots: stats.headshots, accuracy: stats.shots ? Math.min(1, stats.hits / stats.shots) : 0, score: stats.score, time: ctx.time - stats.start });
    pauseMenu.show();
    setPaused(true);
  };
  const resume = () => {
    if (state !== 'paused') return;
    settingsPanel.hide();
    pauseMenu.hide();
    setPaused(false);
    setState('playing', true);
    window.dispatchEvent(new Event('shameless:start')); // main.ts: re-request pointer lock (inside this click gesture)
  };

  let hadLock = false;
  document.addEventListener('pointerlockchange', () => {
    const locked = !!document.pointerLockElement;
    if (locked) { hadLock = true; return; }
    if (hadLock && !testMode && state === 'playing') pause();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (settingsPanel.open) { settingsPanel.hide(); return; }
  });

  // ---------------------------------------------------------------- events
  const firedAt = new Map<number, number>();
  const alertAt = new Map<number, number>();
  let multi = 0, lastKillT = -99;
  let hitPulse = 0;
  let lastAttacker: { id: number; dist: number } | null = null;

  const showHit = (kill: boolean, head: boolean) => {
    hit.className = `sh-hit${kill ? ' kill' : ''}${head ? ' head' : ''}`;
    hit.getAnimations().forEach((a) => a.cancel());
    const s0 = head ? 1.9 : kill ? 1.6 : 1.4;
    hit.animate(
      [
        { opacity: 1, transform: `scale(${s0})` },
        { opacity: 1, transform: 'scale(1)', offset: 0.18 },
        { opacity: 1, transform: 'scale(1)', offset: kill ? 0.6 : 0.45 },
        { opacity: 0, transform: `scale(${kill ? 1.12 : 1})` },
      ],
      { duration: kill ? 560 : 340, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' },
    );
  };

  const addScore = (pts: number, reason: string, bonus?: number) => {
    stats.score += pts;
    scoreVal.textContent = stats.score.toLocaleString('en-US');
    if (popAge > 1.9) { popTotal = 0; popReasons.innerHTML = ''; }
    popTotal += pts;
    popAge = 0;
    popPts.textContent = `+${popTotal}`;
    popPts.style.opacity = '1';
    popPts.animate([{ transform: 'scale(1.35)', color: '#ffffff' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1)' });
    if (reason) {
      const r = h('div', 'sh-pop-reason', `${reason}${bonus ? `<em>+${bonus}</em>` : ''}`);
      popReasons.appendChild(r);
      while (popReasons.children.length > 3) popReasons.firstElementChild!.remove();
      r.animate([{ opacity: 0, transform: 'translateY(-0.4em)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    }
  };

  const showMedal = (name: string, sub: string, tier: number) => {
    medal.querySelector('.sh-medal-icon')!.innerHTML = medalSvg(tier, tier >= 3 ? '#ffb21e' : '#d5f23a');
    medal.querySelector('.sh-medal-name')!.textContent = name;
    medal.querySelector('.sh-medal-sub')!.textContent = sub;
    medal.getAnimations().forEach((a) => a.cancel());
    medal.animate(
      [
        { opacity: 0, transform: 'translateX(-50%) scale(1.7)' },
        { opacity: 1, transform: 'translateX(-50%) scale(0.96)', offset: 0.1 },
        { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.14 },
        { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.85 },
        { opacity: 0, transform: 'translateX(-50%) scale(1)' },
      ],
      { duration: 2300, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' },
    );
  };

  ctx.events.on('weapon:fire', () => { stats.shots++; });
  ctx.events.on('enemy:hit', (e) => {
    stats.hits++;
    showHit(e.killed, e.headshot);
  });
  ctx.events.on('enemy:killed', (e) => {
    stats.kills++;
    if (e.headshot) stats.headshots++;
    const w = weaponInfo(e.weaponId || ctx.weapons.currentId);
    addFeed(`<span class="me">YOU</span><span class="wpn">${WEAPON_ICONS[w.kind]}</span>${e.headshot ? `<span class="hs">${ICON_HEADSHOT}</span>` : ''}<span class="foe">${ENEMY_ROLES[e.enemyId % ENEMY_ROLES.length]}</span>`);
    multi = clock - lastKillT < 4 ? multi + 1 : 1;
    lastKillT = clock;
    const dist = e.position.distanceTo(ctx.player.position);
    addScore(100, 'KILL');
    if (e.headshot) addScore(50, 'HEADSHOT', 50);
    if (dist > 40) addScore(50, 'LONGSHOT', 50);
    if (multi >= 2) {
      addScore(50 * (multi - 1), MEDALS[Math.min(multi, MEDALS.length - 1)], 50 * (multi - 1));
      showMedal(MEDALS[Math.min(multi, MEDALS.length - 1)], `${multi} KILLS`, multi);
    } else if (e.headshot) {
      showMedal('HEADSHOT', 'PRECISION KILL', 1);
    } else if (dist > 40) {
      showMedal('LONGSHOT', `${Math.round(dist)}M`, 1);
    }
  });
  ctx.events.on('score', (e) => addScore(e.points, e.reason.toUpperCase()));
  ctx.events.on('enemy:fire', (e) => firedAt.set(e.enemyId, clock));
  ctx.events.on('enemy:alert', (e) => alertAt.set(e.enemyId, clock));
  ctx.events.on('grenade:throw', () => { frags = Math.max(0, frags - 1); setEquip(); });
  const tmpV = new THREE.Vector3();
  ctx.events.on('player:damaged', (e) => {
    hitPulse = Math.min(1, Math.max(hitPulse, 0.35 + e.amount / 45));
    if (!e.fromDir) return;
    const d = tmpV.set(e.fromDir.x, 0, e.fromDir.z);
    if (d.lengthSq() < 1e-6) return;
    d.normalize();
    // Refresh an arc already pointing roughly that way, else recycle the oldest.
    let slot = arcs.find((a) => a.age < a.life && a.dir.dot(d) > 0.94);
    if (!slot) slot = arcs.reduce((a, b) => (b.age > a.age ? b : a));
    slot.dir.copy(d);
    slot.age = 0;
    slot.life = 1.4 + Math.min(1, e.amount / 40) * 0.8;
    // Best guess at the attacker for the death card.
    let best = -0.2, bestId = -1, bestDist = 0;
    for (const en of ctx.enemies.enemies) {
      if (!en.alive) continue;
      const dx = en.position.x - ctx.player.position.x, dz = en.position.z - ctx.player.position.z;
      const L = Math.hypot(dx, dz) || 1;
      const dot = (dx * d.x + dz * d.z) / L;
      if (dot > best) { best = dot; bestId = en.id; bestDist = L; }
    }
    if (bestId >= 0) lastAttacker = { id: bestId, dist: bestDist };
  });

  const killerInfo = (): KillerInfo => ({
    name: lastAttacker ? `HOSTILE ${ENEMY_ROLES[lastAttacker.id % ENEMY_ROLES.length]}` : 'HOSTILE FORCES',
    weapon: 'AK-47',
    weaponKind: 'rifle',
    distance: lastAttacker ? lastAttacker.dist : null,
  });
  const enterDeath = (info?: Partial<KillerInfo>) => {
    if (state === 'dead') return;
    setState('dead', true);
    death.show({ ...killerInfo(), ...info });
    api.dev.interact(null);
  };
  death.onRespawn = () => {
    ctx.player.respawn();
    leaveDeath();
  };
  const leaveDeath = () => {
    if (state !== 'dead') return;
    death.hide();
    hitPulse = 0;
    for (const a of arcs) a.age = 99;
    lastAttacker = null;
    frags = 2; flashes = 2; setEquip();
    setState('playing', true);
  };
  ctx.events.on('player:died', () => enterDeath());
  ctx.events.on('player:respawn', () => leaveDeath());
  ctx.events.on('game:state', (e) => {
    // Keep in sync when another system drives the state (main.ts emits 'playing' on start).
    if (e.state === 'playing' && state === 'menu') api.hideMenu();
  });
  let wasAlive = true;
  // Interact prompts until a typed event exists: window.dispatchEvent(new CustomEvent('shameless:prompt', { detail: { text, key, sub } }))
  window.addEventListener('shameless:prompt', (e) => {
    const d = (e as CustomEvent<{ text: string | null; key?: string; sub?: string } | null>).detail;
    api.dev.interact(d?.text ?? null, d?.key, d?.sub);
  });

  // ---------------------------------------------------------------- per-frame
  const fovCone = () => ctx.camera.fov * ctx.camera.aspect * 0.9;

  const update = (dt: number) => {
    clock += dt;
    const p = ctx.player, w = ctx.weapons;
    mapBuilder.step();

    // state transitions driven by game state
    if (state === 'playing' && ctx.input.pressed.has('pause')) pause();
    const aliveNow = p.alive && p.health > 0;
    if (wasAlive && !aliveNow && state === 'playing') enterDeath();
    if (!wasAlive && aliveNow && state === 'dead' && !death.active) leaveDeath();
    wasAlive = aliveNow;
    if (state === 'dead') death.update(dt, ctx.input.pressed.has('jump'));
    if (state === 'menu') {
      // Slow cinematic pan behind the main menu.
      p.yaw += dt * 0.035;
      return;
    }

    const heading = wrap360(-p.yaw * DEG);

    // compass
    const sx = -(heading + 180) * EM_PER_DEG + COMPASS_W / 2;
    if (Math.abs(sx - lastStripX) > 0.002) {
      lastStripX = sx;
      strip.style.transform = `translate3d(${sx.toFixed(3)}em,0,0)`;
      const hr = Math.round(heading) % 360;
      const card = CARDINALS[Math.round(heading / 45) * 45 % 360];
      setHeading(Math.abs(wrap180(heading - Math.round(heading / 45) * 45)) < 8 ? `${card} ${hr}` : String(hr));
    }

    // enemy markers (compass + minimap)
    const blips: Blip[] = [];
    let ci = 0;
    for (const e of ctx.enemies.enemies) {
      if (!e.alive) continue;
      const tf = clock - (firedAt.get(e.id) ?? -99);
      const ta = clock - (alertAt.get(e.id) ?? -99);
      let alpha = 0, kind: Blip['kind'] = 'enemy';
      if (tf < 3) alpha = tf < 2 ? 1 : 3 - tf;
      else if (ta < 2) { alpha = 0.7 * (ta < 1.2 ? 1 : (2 - ta) / 0.8); kind = 'enemyFaint'; }
      if (alpha <= 0) continue;
      blips.push({ x: e.position.x, z: e.position.z, alpha, kind });
      if (ci < cmpEnemies.length) {
        const bearing = Math.atan2(e.position.x - p.position.x, -(e.position.z - p.position.z)) * DEG;
        const rel = wrap180(bearing - heading);
        if (Math.abs(rel) < COMPASS_RANGE / 2) {
          const el = cmpEnemies[ci++];
          el.style.display = 'block';
          el.style.transform = `translate3d(${(COMPASS_W / 2 + rel * EM_PER_DEG).toFixed(3)}em,0,0)`;
          el.style.opacity = alpha.toFixed(2);
        }
      }
    }
    for (let i = ci; i < cmpEnemies.length; i++) if (cmpEnemies[i].style.display !== 'none') cmpEnemies[i].style.display = 'none';

    minimap.draw(p.position.x, p.position.z, heading / DEG, blips, fovCone());

    // objective
    const total = ctx.enemies.enemies.length;
    let alive = 0;
    for (const e of ctx.enemies.enemies) if (e.alive) alive++;
    const killed = total - alive;
    const key = `${killed}/${total}`;
    if (key !== lastObjKey) {
      lastObjKey = key;
      objCount.innerHTML = `<b>${killed}</b> / ${total}`;
      objBar.style.transform = `scaleX(${total ? killed / total : 0})`;
      const done = total > 0 && alive === 0;
      obj.classList.toggle('done', done);
      objHeadT(done ? 'OBJECTIVE COMPLETE' : 'OBJECTIVE');
      objDesc(done ? 'Area secured' : 'Eliminate all hostiles');
    }

    // kill feed expiry
    for (let i = feedRows.length - 1; i >= 0; i--) {
      const r = feedRows[i];
      if (!r.leaving && clock - r.t > 6) {
        r.leaving = true;
        const a = r.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(1em)' }], { duration: 300, fill: 'forwards' });
        a.onfinish = () => { r.el.remove(); const k = feedRows.indexOf(r); if (k >= 0) feedRows.splice(k, 1); };
      }
    }

    // crosshair
    const hide = w.adsAmount > 0.35 || p.sprinting || state !== 'playing';
    if (hide !== chHidden) { chHidden = hide; ch.classList.toggle('hidden', hide); }
    chSpread += (w.spread - chSpread) * Math.min(1, dt * 20);
    const gap = 0.5 + chSpread * 2.6 + (p.grounded ? 0 : 0.6);
    if (Math.abs(gap - chLastGap) > 0.004) {
      chLastGap = gap;
      const L = 0.8;
      chT.style.transform = `translate3d(0,${(-gap - L).toFixed(3)}em,0)`;
      chB.style.transform = `translate3d(0,${gap.toFixed(3)}em,0)`;
      chL.style.transform = `translate3d(${(-gap - L).toFixed(3)}em,0,0)`;
      chR.style.transform = `translate3d(${gap.toFixed(3)}em,0,0)`;
    }

    // damage arcs
    for (const a of arcs) {
      if (a.age > a.life) { if (a.lastOp !== '0') { a.lastOp = '0'; a.el.style.opacity = '0'; } continue; }
      a.age += dt;
      const bearing = Math.atan2(a.dir.x, -a.dir.z) * DEG;
      const rel = wrap180(bearing - heading);
      const rot = `rotate(${rel.toFixed(1)}deg)`;
      const t = a.age / a.life;
      const op = (t < 0.06 ? t / 0.06 : 1 - Math.pow((t - 0.06) / 0.94, 1.6)).toFixed(2);
      if (rot !== a.lastRot) { a.lastRot = rot; a.el.style.transform = rot; }
      if (op !== a.lastOp) { a.lastOp = op; a.el.style.opacity = op; }
    }

    // score popup fade
    if (popAge < 3) {
      popAge += dt;
      const op = popAge < 1.5 ? '1' : Math.max(0, 1 - (popAge - 1.5) / 0.45).toFixed(2);
      if (op !== popLastOp) { popLastOp = op; pop.style.opacity = op; }
    }

    // health + render damage
    const frac = Math.max(0, Math.min(1, p.health / p.maxHealth));
    if (Math.abs(frac - lastHpFrac) > 0.001) {
      lastHpFrac = frac;
      hpFill.style.transform = `scaleX(${frac.toFixed(4)})`;
      hpLag.style.transform = `scaleX(${frac.toFixed(4)})`;
      hpNum(String(Math.ceil(p.health)));
      health.classList.toggle('low', frac < 0.35);
    }
    hitPulse = Math.max(0, hitPulse - dt * 1.6);
    const low = Math.max(0, Math.min(1, (0.6 - frac) / 0.6));
    ctx.pipeline.setDamage(state === 'dead' ? 1 : Math.min(1, Math.max(low * 0.9, hitPulse)));

    // weapon panel
    if (w.currentId !== lastWeapon) {
      lastWeapon = w.currentId;
      const info = weaponInfo(w.currentId);
      wName(info.name);
      wIcon.innerHTML = WEAPON_ICONS[info.kind];
      const rounds = info.mode === 'AUTO' ? 3 : info.mode === 'BURST' ? 3 : 1;
      wMode.innerHTML = ICON_ROUND.repeat(rounds);
      wMode.title = info.mode;
      lastMagSize = -1;
    }
    if (w.magSize !== lastMagSize) {
      lastMagSize = w.magSize;
      const n = Math.min(w.magSize, 40);
      wPips.innerHTML = '<i></i>'.repeat(n);
      pipEls = Array.from(wPips.children) as HTMLElement[];
      lastPipFilled = -1;
    }
    if (w.ammoInMag !== lastAmmo) {
      if (w.ammoInMag < lastAmmo && lastAmmo >= 0) {
        // subtle tick on fire (compositor-only)
        wMagEl.animate([{ transform: 'translateY(-0.04em)' }, { transform: 'none' }], { duration: 70 });
      }
      lastAmmo = w.ammoInMag;
      wMag(String(w.ammoInMag));
    }
    wRes(String(w.reserveAmmo));
    const filled = w.magSize > 40 ? Math.round((w.ammoInMag / w.magSize) * 40) : w.ammoInMag;
    if (filled !== lastPipFilled) {
      lastPipFilled = filled;
      const n = pipEls.length;
      for (let i = 0; i < n; i++) pipEls[i].classList.toggle('spent', i >= filled);
    }
    const lowAmmo = w.ammoInMag > 0 && w.ammoInMag <= Math.max(1, Math.floor(w.magSize * 0.25));
    const empty = w.ammoInMag === 0;
    const wcls = `${lowAmmo ? ' low' : ''}${empty ? ' empty' : ''}${w.reloading ? ' reloading' : ''}`;
    if (wcls !== lastWClass) { lastWClass = wcls; wp.className = `sh-weapon sh-hide-dead${wcls}`; }

    // reload / ammo prompt
    let pk = '';
    if (state === 'playing' && !w.reloading) {
      if (empty && w.reserveAmmo <= 0) pk = 'none';
      else if (empty) pk = 'reload';
      else if (lowAmmo) pk = w.reserveAmmo > 0 ? 'reloadlow' : 'low';
    }
    if (pk !== promptKey) {
      promptKey = pk;
      if (pk === 'none') { prompt.className = 'sh-prompt on danger'; prompt.innerHTML = 'NO AMMO'; }
      else if (pk === 'reload') { prompt.className = 'sh-prompt on'; prompt.innerHTML = '<span class="sh-key">R</span>RELOAD'; }
      else if (pk === 'reloadlow') { prompt.className = 'sh-prompt on warn'; prompt.innerHTML = '<span class="sh-key">R</span>LOW AMMO'; }
      else if (pk === 'low') { prompt.className = 'sh-prompt on warn'; prompt.innerHTML = 'LOW AMMO'; }
      else prompt.className = 'sh-prompt';
      if (pk) prompt.animate([{ transform: 'translateX(-50%) scale(1.15)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  };

  let frozen: Animation[] = [];
  const api: HUD & { dev: HUDDev } = {
    update,
    showMenu() {
      settingsPanel.hide();
      pauseMenu.hide();
      death.hide();
      if (state !== 'menu') menuYaw = ctx.player.yaw;
      setState('menu');
      mainMenu.show();
    },
    hideMenu() {
      mainMenu.hide();
      settingsPanel.hide();
      if (menuYaw !== null) { ctx.player.yaw = menuYaw; menuYaw = null; }
      if (state === 'menu') { setState('playing'); stats.start = ctx.time; }
    },
    dev: {
      state: () => state,
      pause: () => pause(),
      resume: () => resume(),
      openSettings: () => settingsPanel.show(),
      closeSettings: () => settingsPanel.hide(),
      die: (info) => enterDeath(info),
      deathElapsed: (t) => death.setElapsed(t),
      interact(text, key = 'F', sub = '') {
        if (!text) { interact.classList.remove('on'); return; }
        interact.innerHTML = `<span class="sh-key">${key}</span>${sub ? `<small>${sub}</small>` : ''}${text}`;
        interact.classList.add('on');
      },
      equipment(f, fl) { frags = f; flashes = fl; setEquip(); },
      freeze(ms) {
        frozen = document.getAnimations().filter((a) => !(a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.classList.contains('sh-grain')));
        for (const a of frozen) { a.pause(); a.currentTime = ms; }
      },
      unfreeze() { for (const a of frozen) a.play(); frozen = []; },
      clear() {
        for (const el of [hit, medal, popPts]) el.getAnimations().forEach((a) => a.cancel());
        hit.style.opacity = '0';
        medal.style.opacity = '0';
        popAge = 99; popLastOp = '0'; pop.style.opacity = '0'; popReasons.innerHTML = ''; popTotal = 0;
        for (const r of feedRows) r.el.remove();
        feedRows.length = 0;
        for (const a of arcs) a.age = 99;
        hitPulse = 0;
      },
      mapReady: () => mapBuilder.layout.ready,
    },
  };
  return api;
}

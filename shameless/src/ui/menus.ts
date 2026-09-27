import { ICON_BRAND, ICON_CHEVRON, ICON_SKULL, WEAPON_ICONS, type WeaponKind } from './icons';
import { DEFAULTS, QUALITY_NAMES, type Settings } from './settings';
import type { MapLayout } from './minimap';

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Stop clicks inside menus from reaching uiRoot (main.ts starts the game on any uiRoot click). */
function isolate(el: HTMLElement): void {
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'dblclick', 'contextmenu'] as const) {
    el.addEventListener(t, (e) => e.stopPropagation());
  }
}

let grainURL = '';
function grain(): HTMLDivElement {
  if (!grainURL) {
    const c = document.createElement('canvas');
    c.width = c.height = 192;
    const g = c.getContext('2d')!;
    const img = g.createImageData(192, 192);
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (rnd() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainURL = c.toDataURL();
  }
  const d = h('div', 'sh-grain');
  d.style.backgroundImage = `url(${grainURL})`;
  return d;
}

function toast(parent: HTMLElement, title: string, sub: string): void {
  let t = parent.querySelector<HTMLDivElement>('.sh-toast');
  if (!t) { t = h('div', 'sh-toast'); parent.appendChild(t); }
  t.innerHTML = `${title}<small>${sub}</small>`;
  t.getAnimations().forEach((a) => a.cancel());
  t.animate(
    [
      { opacity: 0, transform: 'translate(-50%, 0.6em)' },
      { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.08 },
      { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.85 },
      { opacity: 0, transform: 'translate(-50%, 0)' },
    ],
    { duration: 2600, easing: 'ease-out', fill: 'forwards' },
  );
}

const chevrons = `<span class="sh-play-arrows">${ICON_CHEVRON}${ICON_CHEVRON}${ICON_CHEVRON}</span>`;

interface ItemDef { id: string; label: string; tag?: string; tagNew?: boolean; dim?: boolean }

function itemList(defs: ItemDef[], onPick: (id: string) => void, onHover?: (id: string) => void): { el: HTMLDivElement; select(id: string): void } {
  const el = h('div', 'sh-items');
  const nodes = new Map<string, HTMLButtonElement>();
  defs.forEach((d, i) => {
    const b = h('button', `sh-btn sh-item${d.dim ? ' dim' : ''}`);
    b.innerHTML = `<span class="sh-item-idx">${String(i + 1).padStart(2, '0')}</span><span class="sh-item-lbl">${d.label}</span>${d.tag ? `<span class="sh-item-tag${d.tagNew ? ' new' : ''}">${d.tag}</span>` : ''}`;
    b.addEventListener('click', () => onPick(d.id));
    b.addEventListener('mouseenter', () => onHover?.(d.id));
    b.addEventListener('focus', () => onHover?.(d.id));
    nodes.set(d.id, b);
    el.appendChild(b);
  });
  return {
    el,
    select(id) { for (const [k, n] of nodes) n.classList.toggle('sel', k === id); },
  };
}

// ------------------------------------------------------------------ main menu

interface CardInfo { k: string; t: string; d: string; chips: [string, boolean][]; stats: [string, string][] }

export class MainMenu {
  readonly el: HTMLDivElement;
  private card: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement;
  private list: ReturnType<typeof itemList>;
  private cards: Record<string, CardInfo>;

  constructor(
    private layout: MapLayout,
    handlers: { play(): void; settings(): void },
    hostiles: () => number,
  ) {
    this.el = h('div', 'sh-layer sh-menu sh-main');
    isolate(this.el);
    this.el.append(h('div', 'sh-glow'), h('div', 'sh-glow b'), h('div', 'sh-shade'), grain());

    const top = h('div', 'sh-topbar');
    top.innerHTML = `
      <div class="sh-brand">${ICON_BRAND}<span>SHAMELESS</span></div>
      <div class="sh-player">
        <div style="text-align:right"><div class="sh-player-name">OPERATOR</div><div class="sh-player-sub">TASK FORCE · ONLINE</div></div>
        <div class="sh-lvl">01</div>
      </div>`;
    this.el.appendChild(top);

    const left = h('div', 'sh-mm-left');
    left.innerHTML = `
      <div class="sh-over">CAMPAIGN · ACT I</div>
      <div class="sh-title">SHAMELESS</div>
      <div class="sh-tagline">NO RULES · NO RETREAT</div>`;
    this.cards = {
      campaign: {
        k: 'MISSION 01', t: 'DEAD GROUND',
        d: 'Insert at dawn. Clear the compound of hostile forces and secure the area before reinforcements arrive.',
        chips: [['CAMPAIGN', true], ['REGULAR', false]],
        stats: [[String(hostiles() || 12), 'HOSTILES'], ['REGULAR', 'DIFFICULTY'], ['06:40', 'LOCAL TIME']],
      },
      multiplayer: {
        k: 'ONLINE', t: 'MULTIPLAYER',
        d: 'Matchmaking servers are unavailable in this build. Deploy to the campaign to play offline.',
        chips: [['OFFLINE', false]],
        stats: [['0', 'PLAYERS'], ['—', 'PING'], ['—', 'PLAYLIST']],
      },
      operators: {
        k: 'LOADOUT', t: 'OPERATORS',
        d: 'Customize your operator, weapons and equipment. Additional operators unlock through campaign progression.',
        chips: [['1 / 1 UNLOCKED', false]],
        stats: [['M4', 'PRIMARY'], ['FRAG', 'LETHAL'], ['STUN', 'TACTICAL']],
      },
      settings: {
        k: 'OPTIONS', t: 'SETTINGS',
        d: 'Adjust mouse sensitivity, field of view, audio and graphics quality. Changes apply immediately.',
        chips: [['SYSTEM', false]],
        stats: [['MOUSE', ''], ['VIDEO', ''], ['AUDIO', '']],
      },
    };
    this.list = itemList(
      [
        { id: 'campaign', label: 'CAMPAIGN', tag: 'ACT I', tagNew: true },
        { id: 'multiplayer', label: 'MULTIPLAYER', tag: 'OFFLINE', dim: true },
        { id: 'operators', label: 'OPERATORS' },
        { id: 'settings', label: 'SETTINGS' },
      ],
      (id) => {
        if (id === 'campaign') { this.list.select(id); this.showCard(id); }
        else if (id === 'settings') handlers.settings();
        else if (id === 'multiplayer') toast(this.el, 'MULTIPLAYER UNAVAILABLE', 'Unable to reach matchmaking servers. Offline campaign only.');
        else toast(this.el, 'OPERATORS', 'Operator customization unlocks after Mission 01.');
      },
      (id) => this.showCard(id),
    );
    this.list.select('campaign');
    left.appendChild(this.list.el);
    const play = h('button', 'sh-btn sh-play');
    play.innerHTML = `<div><div class="sh-play-lbl">PLAY</div><div class="sh-play-sub">MISSION 01 · DEAD GROUND</div></div>${chevrons}`;
    play.addEventListener('click', () => handlers.play());
    left.appendChild(play);
    this.el.appendChild(left);
    this.list.el.addEventListener('mouseleave', () => this.showCard('campaign'));

    this.card = h('div', 'sh-card');
    this.mapCanvas = h('canvas');
    this.el.appendChild(this.card);

    const foot = h('div', 'sh-footer');
    foot.innerHTML = `
      <div class="sh-hints">
        <div class="sh-hint"><span class="sh-key">LMB</span>SELECT</div>
        <div class="sh-hint"><span class="sh-key">ESC</span>PAUSE IN GAME</div>
        <div class="sh-hint"><span class="sh-key">W A S D</span>MOVE</div>
      </div>
      <div class="sh-ver">SHAMELESS · v0.1.0 · BUILD 2609</div>`;
    this.el.appendChild(foot);
    this.showCard('campaign');
  }

  private shown = '';
  private showCard(id: string): void {
    if (id === this.shown) return;
    this.shown = id;
    const c = this.cards[id];
    this.card.innerHTML = `
      <div class="sh-card-map"><div class="sh-card-tagrow">${c.chips.map(([t, a]) => `<span class="sh-chip${a ? ' acc' : ''}">${t}</span>`).join('')}</div></div>
      <div class="sh-card-body">
        <div class="sh-card-k">${c.k}</div>
        <div class="sh-card-t">${c.t}</div>
        <div class="sh-card-d">${c.d}</div>
        <div class="sh-card-stats">${c.stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      </div>`;
    this.card.querySelector('.sh-card-map')!.prepend(this.mapCanvas);
    this.drawMap();
    this.card.animate([{ opacity: 0.4, transform: 'translateY(0.4em)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  /** Draw the level layout into the mission card. */
  drawMap(): void {
    const L = this.layout;
    const c = this.mapCanvas;
    const w = 600, hgt = 250;
    c.width = w; c.height = hgt;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b0e0e';
    g.fillRect(0, 0, w, hgt);
    if (!L.ready) return;
    const s = Math.max(w / L.canvas.width, hgt / L.canvas.height) * 1.15;
    g.save();
    g.translate(w / 2, hgt / 2);
    g.rotate(-0.12);
    g.drawImage(L.canvas, -L.canvas.width * s / 2, -L.canvas.height * s / 2, L.canvas.width * s, L.canvas.height * s);
    g.restore();
    // cool grade + scanline-free objective marker
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = 'rgba(150,170,175,1)';
    g.fillRect(0, 0, w, hgt);
    g.globalCompositeOperation = 'source-over';
    const cx = w * 0.52, cy = hgt * 0.46;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, 70);
    rg.addColorStop(0, 'rgba(213,242,58,0.28)');
    rg.addColorStop(1, 'rgba(213,242,58,0)');
    g.fillStyle = rg;
    g.fillRect(cx - 70, cy - 70, 140, 140);
    g.strokeStyle = 'rgba(213,242,58,0.95)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, 22, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#d5f23a';
    g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx + 7, cy); g.lineTo(cx, cy + 7); g.lineTo(cx - 7, cy); g.closePath(); g.fill();
    g.font = '600 13px "Barlow Condensed", sans-serif';
    g.fillStyle = 'rgba(213,242,58,0.95)';
    g.fillText('OBJ  A', cx + 30, cy + 5);
  }

  show(): void { this.el.classList.add('on'); this.drawMap(); }
  hide(): void { this.el.classList.remove('on'); }
}

// ------------------------------------------------------------------ pause menu

export class PauseMenu {
  readonly el: HTMLDivElement;
  private stats: HTMLDivElement;
  private list: ReturnType<typeof itemList>;

  constructor(handlers: { resume(): void; settings(): void; restart(): void; quit(): void }) {
    this.el = h('div', 'sh-layer sh-menu sh-pause');
    isolate(this.el);
    this.el.append(h('div', 'sh-shade'), grain());
    const left = h('div', 'sh-pause-left');
    left.innerHTML = `
      <div class="sh-over">PAUSED</div>
      <div class="sh-pause-title">DEAD GROUND</div>
      <div class="sh-pause-sub">Mission 01 · Clear the compound of hostile forces</div>`;
    this.list = itemList(
      [
        { id: 'resume', label: 'RESUME' },
        { id: 'settings', label: 'SETTINGS' },
        { id: 'restart', label: 'RESTART CHECKPOINT' },
        { id: 'quit', label: 'QUIT TO MAIN MENU' },
      ],
      (id) => (handlers as unknown as Record<string, () => void>)[id](),
      (id) => this.list.select(id),
    );
    this.list.select('resume');
    left.appendChild(this.list.el);
    this.el.appendChild(left);
    this.stats = h('div', 'sh-stats');
    this.el.appendChild(this.stats);
    const foot = h('div', 'sh-footer');
    foot.innerHTML = `
      <div class="sh-hints">
        <div class="sh-hint"><span class="sh-key">LMB</span>SELECT</div>
        <div class="sh-hint"><span class="sh-key">ESC</span>BACK</div>
      </div>
      <div class="sh-ver">SHAMELESS · v0.1.0</div>`;
    this.el.appendChild(foot);
  }

  setStats(s: { kills: number; headshots: number; accuracy: number; score: number; time: number }): void {
    const mm = Math.floor(s.time / 60), ss = Math.floor(s.time % 60);
    this.stats.innerHTML = `
      <div class="sh-card-k">MISSION STATS</div>
      <div class="sh-stats-grid">
        <div><b>${s.kills}</b><span>KILLS</span></div>
        <div><b>${s.headshots}</b><span>HEADSHOTS</span></div>
        <div><b>${Math.round(s.accuracy * 100)}%</b><span>ACCURACY</span></div>
        <div><b>${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}</b><span>MISSION TIME</span></div>
        <div style="grid-column: span 2"><b style="color:var(--accent)">${s.score.toLocaleString('en-US')}</b><span>SCORE</span></div>
      </div>`;
  }

  show(): void {
    this.list.select('resume');
    this.el.classList.add('on');
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }
  hide(): void { this.el.classList.remove('on'); }
}

// ------------------------------------------------------------------ settings

interface RowDef {
  key: keyof Settings;
  label: string;
  desc: string;
  note?: string;
  kind: 'range' | 'select';
  min?: number; max?: number; step?: number; fmt?: (v: number) => string;
  options?: string[];
}

const ROWS: { section: string; rows: RowDef[] }[] = [
  {
    section: 'MOUSE',
    rows: [{
      key: 'sensitivity', label: 'Mouse Sensitivity', kind: 'range', min: 1, max: 20, step: 0.25, fmt: (v) => v.toFixed(2),
      desc: 'Adjusts how far the camera turns per unit of mouse movement. Aim-down-sights sensitivity scales from this value.',
    }],
  },
  {
    section: 'VIDEO',
    rows: [
      {
        key: 'fov', label: 'Field of View', kind: 'range', min: 60, max: 110, step: 1, fmt: (v) => String(Math.round(v)),
        desc: 'Horizontal-ish field of view of the world camera. Higher values show more of the battlefield at the cost of target size.',
      },
      {
        key: 'quality', label: 'Graphics Quality', kind: 'select', options: [...QUALITY_NAMES],
        desc: 'Overall preset for resolution scale, shadows and post-processing. Lower it if the frame rate drops below your display refresh rate.',
        note: 'SOME CHANGES APPLY ON RESTART',
      },
    ],
  },
  {
    section: 'AUDIO',
    rows: [{
      key: 'volume', label: 'Master Volume', kind: 'range', min: 0, max: 100, step: 1, fmt: (v) => String(Math.round(v)),
      desc: 'Overall loudness of the game mix: weapons, effects, ambience and music.',
    }],
  },
  {
    section: 'INTERFACE',
    rows: [{
      key: 'minimapRotate', label: 'Minimap Rotation', kind: 'select', options: ['FIXED NORTH', 'ROTATING'],
      desc: 'Rotating keeps your facing direction pointing up on the minimap. Fixed keeps north up.',
    }],
  },
];

export class SettingsPanel {
  readonly el: HTMLDivElement;
  private desc: HTMLDivElement;
  private refreshers: (() => void)[] = [];
  onClose: () => void = () => {};
  onToggle: (open: boolean) => void = () => {};

  constructor(private s: Settings, private onChange: (key: keyof Settings) => void) {
    this.el = h('div', 'sh-layer sh-menu sh-settings');
    isolate(this.el);
    this.el.append(h('div', 'sh-shade'), grain());
    const head = h('div', 'sh-set-head');
    head.innerHTML = `<div class="sh-over">OPTIONS</div><div class="sh-set-title">SETTINGS</div>`;
    const tabs = h('div', 'sh-set-tabs');
    this.el.appendChild(head);
    head.appendChild(tabs);
    const body = h('div', 'sh-set-body');
    this.el.appendChild(body);
    this.desc = h('div', 'sh-desc');
    this.el.appendChild(this.desc);

    const sections: HTMLDivElement[] = [];
    const tabEls: HTMLButtonElement[] = [];
    const selectTab = (i: number) => {
      sections.forEach((s, k) => (s.style.display = k === i ? '' : 'none'));
      tabEls.forEach((t, k) => t.classList.toggle('on', k === i));
      const first = ROWS[i].rows[0];
      this.describe(first);
    };
    ROWS.forEach((sec, si) => {
      const t = h('button', 'sh-btn sh-set-tab', sec.section);
      t.addEventListener('click', () => selectTab(si));
      tabs.appendChild(t);
      tabEls.push(t);
      const secEl = h('div');
      for (const r of sec.rows) secEl.appendChild(this.row(r));
      body.appendChild(secEl);
      sections.push(secEl);
    });
    // Show every section's rows under the first tab: with only a handful of options a single list reads better.
    const all = h('button', 'sh-btn sh-set-tab', 'ALL');
    tabs.prepend(all);
    const showAll = () => {
      sections.forEach((s) => (s.style.display = ''));
      tabEls.forEach((t) => t.classList.remove('on'));
      all.classList.add('on');
      this.describe(ROWS[0].rows[0]);
    };
    all.addEventListener('click', showAll);
    tabEls.forEach((t) => t.addEventListener('click', () => all.classList.remove('on')));
    showAll();

    const foot = h('div', 'sh-footer');
    foot.innerHTML = `<div class="sh-hints"><button class="sh-btn sh-hint" data-a="back"><span class="sh-key">ESC</span>BACK</button><button class="sh-btn sh-hint" data-a="reset"><span class="sh-key">R</span>RESET TO DEFAULTS</button></div><div class="sh-ver">CHANGES SAVE AUTOMATICALLY</div>`;
    foot.querySelector('[data-a=back]')!.addEventListener('click', () => this.onClose());
    foot.querySelector('[data-a=reset]')!.addEventListener('click', () => {
      for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
        if (this.s[k] !== DEFAULTS[k]) { (this.s as any)[k] = DEFAULTS[k]; this.onChange(k); }
      }
      this.refresh();
    });
    this.el.appendChild(foot);
  }

  private describe(r: RowDef): void {
    this.desc.innerHTML = `<div class="sh-card-k">${ROWS.find((s) => s.rows.includes(r))!.section}</div><div class="sh-desc-t">${r.label.toUpperCase()}</div><div class="sh-desc-d">${r.desc}</div>${r.note ? `<div class="sh-desc-note">${r.note}</div>` : ''}`;
  }

  private row(r: RowDef): HTMLDivElement {
    const row = h('div', 'sh-row');
    row.innerHTML = `<div class="sh-row-lbl">${r.label}</div>`;
    const ctl = h('div', 'sh-row-ctl');
    row.appendChild(ctl);
    row.addEventListener('mouseenter', () => this.describe(r));
    if (r.kind === 'range') {
      const input = h('input', 'sh-range') as HTMLInputElement;
      input.type = 'range';
      input.min = String(r.min); input.max = String(r.max); input.step = String(r.step);
      const val = h('div', 'sh-row-val');
      const sync = () => {
        const v = this.s[r.key] as number;
        input.value = String(v);
        input.style.setProperty('--p', `${((v - r.min!) / (r.max! - r.min!)) * 100}%`);
        val.textContent = r.fmt!(v);
      };
      input.addEventListener('input', () => {
        (this.s as any)[r.key] = Number(input.value);
        sync();
        this.onChange(r.key);
      });
      ctl.append(input, val);
      this.refreshers.push(sync);
      sync();
    } else {
      const opts = r.options!;
      const get = () => (r.key === 'minimapRotate' ? (this.s.minimapRotate ? 1 : 0) : (this.s[r.key] as number));
      const set = (i: number) => {
        (this.s as any)[r.key] = r.key === 'minimapRotate' ? i === 1 : i;
        sync();
        this.onChange(r.key);
      };
      const wrap = h('div', 'sh-sel');
      const l = h('button', 'sh-btn sh-sel-arrow l', ICON_CHEVRON);
      const rr = h('button', 'sh-btn sh-sel-arrow', ICON_CHEVRON);
      const mid = h('div');
      const v = h('div', 'sh-sel-val');
      const pips = h('div', 'sh-sel-pips', opts.map(() => '<i></i>').join(''));
      mid.append(v, pips);
      wrap.append(l, mid, rr);
      ctl.appendChild(wrap);
      l.addEventListener('click', () => set((get() - 1 + opts.length) % opts.length));
      rr.addEventListener('click', () => set((get() + 1) % opts.length));
      const sync = () => {
        const i = get();
        v.textContent = opts[i];
        pips.querySelectorAll('i').forEach((p, k) => p.classList.toggle('on', k === i));
      };
      this.refreshers.push(sync);
      sync();
    }
    return row;
  }

  refresh(): void { this.refreshers.forEach((f) => f()); }
  get open(): boolean { return this.el.classList.contains('on'); }
  show(): void {
    this.refresh();
    this.el.classList.add('on');
    this.onToggle(true);
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  }
  hide(): void {
    if (!this.open) return;
    this.el.classList.remove('on');
    this.onToggle(false);
  }
}

// ------------------------------------------------------------------ death screen

export class DeathScreen {
  readonly el: HTMLDivElement;
  private count: HTMLElement;
  private bar: HTMLElement;
  private killer: HTMLDivElement;
  private total = 5;
  private t = 0;
  active = false;
  onRespawn: () => void = () => {};

  constructor() {
    this.el = h('div', 'sh-layer sh-death');
    this.el.innerHTML = `
      <div class="sh-shade"></div>
      <div class="sh-death-top">
        <div class="sh-death-over">KILLED IN ACTION</div>
        <div class="sh-death-title">YOU DIED</div>
        <div class="sh-death-rule"></div>
      </div>
      <div class="sh-killer"></div>
      <div class="sh-respawn">
        <div class="sh-respawn-t">RESPAWNING IN <b>5</b></div>
        <div class="sh-respawn-bar"><i></i></div>
        <div class="sh-respawn-hint"><span class="sh-key">SPACE</span>SKIP</div>
      </div>`;
    this.count = this.el.querySelector('.sh-respawn-t b')!;
    this.bar = this.el.querySelector('.sh-respawn-bar i')!;
    this.killer = this.el.querySelector('.sh-killer')!;
  }

  show(info: { name: string; weapon: string; weaponKind: WeaponKind; distance: number | null; headshot?: boolean }, seconds = 5): void {
    this.total = seconds;
    this.t = 0;
    this.active = true;
    this.killer.innerHTML = `
      <div class="sh-killer-av">${ICON_SKULL}</div>
      <div class="sh-killer-main">
        <div class="sh-killer-k">KILLED BY</div>
        <div class="sh-killer-n">${info.name}</div>
        <div class="sh-killer-w"><span class="ico">${WEAPON_ICONS[info.weaponKind]}</span>${info.weapon}</div>
      </div>
      <div class="sh-killer-side"><b>${info.distance === null ? '—' : Math.round(info.distance) + 'm'}</b><span>DISTANCE</span></div>`;
    this.el.classList.add('on');
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });
    this.el.querySelector('.sh-death-title')!.animate(
      [{ opacity: 0, letterSpacing: '0.3em', filter: 'blur(6px)' }, { opacity: 1, letterSpacing: '0.08em', filter: 'blur(0)' }],
      { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    this.killer.animate([{ opacity: 0, transform: 'translate(-50%, 1em)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 500, delay: 350, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    this.render();
  }

  private lastSec = -1;
  private render(): void {
    const left = Math.max(0, this.total - this.t);
    const sec = Math.ceil(left);
    if (sec !== this.lastSec) { this.lastSec = sec; this.count.textContent = String(sec); }
    this.bar.style.transform = `scaleX(${(this.t / this.total).toFixed(4)})`;
  }

  update(dt: number, skip: boolean): void {
    if (!this.active) return;
    this.t += dt;
    if (skip && this.t > 1) this.t = this.total;
    this.render();
    if (this.t >= this.total) {
      this.active = false;
      this.onRespawn();
    }
  }

  /** Dev: hold the countdown at a given elapsed time. */
  setElapsed(t: number): void { this.t = t; this.render(); }

  hide(): void { this.active = false; this.el.classList.remove('on'); }
}

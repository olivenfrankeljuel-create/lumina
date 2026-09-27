import * as THREE from 'three';
import { SOUND_DEFS, DEF_BY_NAME, renderBank, renderSound, type BusName } from '../../audio/bank';
import { AudioEngine } from '../../audio/engine';
import { AudioDirector } from '../../audio/director';
import { analyze, drawSheet, drawContact, type Metrics } from '../../audio/dev/analysis';

/**
 * Audio verification scene (no WebGL needed). Renders the full sample bank offline plus mix scenarios
 * through the real engine graph (buses, reverb, ducking, master dynamics), and exposes measurement /
 * export helpers on window.__shameless.api for tools/audio-render.mjs.
 */
const SR = 48000;
const BUS_DB: Record<BusName, number> = { weapons: 20 * Math.log10(0.7), sfx: 20 * Math.log10(0.6), ambience: 20 * Math.log10(0.26), hud: 20 * Math.log10(0.56), ui: 20 * Math.log10(0.5) };

function toB64(bufs: AudioBuffer[], gap = 0.25): { b64: string; ch: number; sr: number } {
  const ch = Math.max(...bufs.map((b) => b.numberOfChannels));
  const gapN = Math.round(gap * SR);
  const total = bufs.reduce((a, b) => a + b.length + gapN, 0);
  const out = new Int16Array(total * ch);
  let o = 0;
  for (const b of bufs) {
    for (let i = 0; i < b.length; i++) for (let c = 0; c < ch; c++) {
      const v = b.getChannelData(Math.min(c, b.numberOfChannels - 1))[i];
      out[(o + i) * ch + c] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    o += b.length + gapN;
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(s), ch, sr: SR };
}

type Scenario = (E: AudioEngine, D: AudioDirector) => number; // returns duration

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const EYE = V(0, 1.7, 0);
const FWD = V(0, 0, -1);

function fireBurst(D: AudioDirector, t0: number, n: number, rpm: number, id = 'm4', suppressed = false, impactDist = 25, surface: 'concrete' | 'metal' | 'dirt' = 'concrete') {
  const dt = 60 / rpm;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    D.fire({ weaponId: id, origin: EYE, dir: FWD, muzzle: EYE, suppressed }, t);
    D.shell({ position: V(0.15, 1.5, -0.3), velocity: V(1.5, 1.2, 0.3), kind: /pistol|m9/.test(id) ? 'pistol' : 'rifle' }, t + 0.01);
    const p = V((Math.random() - 0.5) * 1.5, 1.2 + (Math.random() - 0.5), -impactDist);
    D.impact({ point: p, normal: V(0, 0, 1), surface, dir: FWD }, t + impactDist / 900);
  }
}

const SCENARIOS: Record<string, Scenario> = {
  mix_rifle_auto_outdoor: (E, D) => { D.startAmbience(0); fireBurst(D, 0.4, 30, 750); return 5.5; },
  mix_rifle_auto_indoor: (E, D) => { E.setIndoor(1, 0); D.startAmbience(0); fireBurst(D, 0.4, 30, 750, 'm4', false, 6); return 5.5; },
  mix_single_shots: (_E, D) => {
    const ids = ['m4', 'mp5', 'pistol_m9', 'sniper_ax50', 'shotgun_870', 'm4'];
    ids.forEach((id, i) => fireBurst(D, 0.2 + i * 1.6, 1, 600, id, i === 5));
    return 10;
  },
  mix_suppressed_auto: (_E, D) => { fireBurst(D, 0.3, 20, 800, 'm4', true); return 3.5; },
  mix_enemy_distances: (_E, D) => {
    [8, 35, 110, 300].forEach((d, i) => {
      for (let k = 0; k < 3; k++) D.enemyFire({ enemyId: 1, origin: V(d * 0.7, 1.6, -d * 0.7), dir: V(-0.7, 0, 0.7) }, 0.3 + i * 2.6 + k * 0.11);
    });
    return 11.5;
  },
  mix_explosion_near: (E, D) => {
    D.startAmbience(0);
    fireBurst(D, 0.3, 8, 750);
    D.explosion({ position: V(-4, 0.2, -6), radius: 6, damage: 100 }, 1.6);
    fireBurst(D, 3.2, 10, 750);
    return 8;
  },
  mix_firefight: (E, D) => {
    D.startAmbience(0);
    for (let s = 0; s < 14; s++) D.footstep({ surface: s < 7 ? 'concrete' : 'gravel', position: EYE, speed: 6.5, sprinting: true, crouched: false }, 0.1 + s * 0.3);
    D.slide({ position: EYE }, 4.3);
    fireBurst(D, 4.9, 6, 750);
    for (let k = 0; k < 5; k++) D.enemyFire({ enemyId: 2, origin: V(20, 1.6, -30), dir: V(-0.5, 0, 0.8) }, 1.0 + k * 0.1);
    D.whiz({ point: V(0.8, 1.8, -0.5), dir: V(-0.5, 0, 0.8) }, 1.1);
    D.impact({ point: V(1.2, 0.9, -1.5), normal: V(0, 1, 0), surface: 'concrete', dir: V(-0.5, 0, 0.8) }, 1.2);
    D.impact({ point: V(-1.5, 1.2, -2), normal: V(0, 1, 0), surface: 'metal', dir: V(-0.5, 0, 0.8) }, 1.35);
    D.enemyHit({ enemyId: 2, point: V(20, 1.5, -30), normal: V(0, 0, 1), dir: FWD, damage: 30, headshot: false, killed: false }, 5.0);
    D.enemyHit({ enemyId: 2, point: V(20, 1.5, -30), normal: V(0, 0, 1), dir: FWD, damage: 30, headshot: false, killed: false }, 5.16);
    D.enemyHit({ enemyId: 2, point: V(20, 1.8, -30), normal: V(0, 0, 1), dir: FWD, damage: 90, headshot: true, killed: true }, 5.32);
    D.enemyKilled({ enemyId: 2, headshot: true, position: V(20, 0, -30), weaponId: 'm4' }, 5.32);
    D.reload({ weaponId: 'm4', stage: 'start', empty: true }, 6.3);
    D.reload({ weaponId: 'm4', stage: 'magout', empty: true }, 6.6);
    D.reload({ weaponId: 'm4', stage: 'magin', empty: true }, 7.4);
    D.reload({ weaponId: 'm4', stage: 'bolt', empty: true }, 8.0);
    D.reload({ weaponId: 'm4', stage: 'end', empty: true }, 8.4);
    D.ads({ active: true }, 8.8);
    fireBurst(D, 9.1, 3, 750);
    return 11;
  },
  mix_foley: (_E, D) => {
    const st = ['start', 'magout', 'magin', 'bolt', 'end'] as const;
    st.forEach((s, i) => D.reload({ weaponId: 'm4', stage: s, empty: true }, 0.2 + i * 0.7));
    D.ads({ active: true }, 4); D.ads({ active: false }, 4.8);
    D.switchWeapon({ weaponId: 'pistol' }, 5.5);
    D.dryfire({ weaponId: 'm4' }, 6.6);
    D.jump({ position: EYE }, 7.2); D.land({ position: EYE, impactSpeed: 7, surface: 'concrete' }, 7.8);
    return 9;
  },
  mix_lowhealth: (E, D) => {
    D.startAmbience(0);
    D.damaged({ amount: 40, health: 30, fromDir: V(1, 0, 0) }, 0.3);
    for (let t = 0; t < 7; t += 1 / 60) D.update(1 / 60, { health: t < 0.3 ? 70 : 22, maxHealth: 100, alive: true }, t);
    return 7.5;
  },
  mix_ambience: (_E, D) => {
    D.startAmbience(0);
    D.ambTimers = { gunfire: 2, dog: 6, drone: 9, clank: 4, boom: 16 };
    for (let t = 0; t < 22; t += 1 / 30) D.update(1 / 30, null, t);
    return 24;
  },
};

export default async function (_container: HTMLElement, uiRoot: HTMLElement) {
  const status = document.createElement('pre');
  status.style.cssText = 'color:#ddd;padding:16px;font:13px monospace';
  uiRoot.appendChild(status);
  status.textContent = 'rendering bank...';
  const t0 = performance.now();
  const bank = await renderBank(SOUND_DEFS, SR, undefined, 4);
  const renderMs = performance.now() - t0;
  const t1 = performance.now();
  await renderBank(SOUND_DEFS.filter((d) => d.tier === 0), SR, undefined, 4);
  const criticalMs = performance.now() - t1;
  status.textContent = `bank rendered in ${renderMs.toFixed(0)} ms (critical tier ${criticalMs.toFixed(0)} ms), ${bank.size} sounds`;

  const mixes = new Map<string, AudioBuffer>();
  const renderMix = async (name: string, dynamics = true) => {
    const sc = SCENARIOS[name];
    // dry-run to get duration
    const probe = new OfflineAudioContext(2, 128, SR);
    const dur = sc(new AudioEngine(probe), new AudioDirector(new AudioEngine(probe)));
    const off = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(dur * SR), sampleRate: SR });
    const E = new AudioEngine(off, off.destination, 1234, dynamics);
    for (const d of SOUND_DEFS) { const b = bank.get(d.name); if (b) E.addSound(d.name, b, d); }
    E.setListener(EYE, FWD, V(0, 1, 0));
    const D = new AudioDirector(E);
    sc(E, D);
    const buf = await off.startRendering();
    mixes.set(name, buf);
    return buf;
  };

  const exportOne = (name: string, bufs: AudioBuffer[], extra = '') => {
    const m = analyze(name, bufs);
    const png = drawSheet(name, bufs, m, extra).toDataURL('image/png');
    return { metrics: m, png, wav: toB64(bufs) };
  };

  window.__shameless.api = {
    renderMs, criticalMs,
    list: () => SOUND_DEFS.map((d) => d.name),
    mixList: () => Object.keys(SCENARIOS),
    props: (name: string) => { const d = DEF_BY_NAME.get(name)!; return { cat: d.cat, bus: d.bus, gainDb: d.gainDb, busDb: BUS_DB[d.bus] }; },
    exportSound: (name: string) => {
      const d = DEF_BY_NAME.get(name)!;
      return exportOne(name, bank.get(name)!, `  cat=${d.cat} bus=${d.bus} gain=${d.gainDb}dB`);
    },
    exportMix: async (name: string, dynamics = true) => { const b = await renderMix(name, dynamics); return exportOne(dynamics ? name : `${name}_nodyn`, [b]); },
    metricsOnly: (name: string): Metrics => analyze(name, bank.get(name)!),
    /** Sequential per-sound render cost (ms), most expensive first. */
    profile: async () => {
      const out: [string, number][] = [];
      for (const d of SOUND_DEFS) { const a = performance.now(); await renderSound(d, SR); out.push([d.name, performance.now() - a]); }
      return out.sort((a, b) => b[1] - a[1]);
    },
    contact: () => drawContact(SOUND_DEFS.filter((d) => d.cat !== 'ambience').map((d) => ({ name: d.name, buf: bank.get(d.name)![0] })), 6).toDataURL('image/png'),
  };
  const loop = () => { requestAnimationFrame(loop); window.__shameless.frame++; };
  requestAnimationFrame(loop);
  window.__shameless.ready = true;
}

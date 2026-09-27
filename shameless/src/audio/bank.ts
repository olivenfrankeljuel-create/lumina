import { Synth } from './synth';
import { mulberry32, hashStr, dbToGain } from './rng';
import * as W from './recipes/weapons';
import * as X from './recipes/world';
import * as U from './recipes/ui';

export type BusName = 'weapons' | 'sfx' | 'ambience' | 'hud' | 'ui';
export type Category = 'gun' | 'tail' | 'foley' | 'impact' | 'world' | 'step' | 'hud' | 'ui' | 'body' | 'ambience';

export interface SoundProps {
  bus: BusName;
  /** Playback gain in dB applied on top of the normalized sample. */
  gainDb: number;
  /** Max concurrent voices of this sound; the oldest is faded out when exceeded. */
  voices: number;
  /** Random playback-rate jitter (fraction) and gain jitter (dB) per trigger. */
  pj: number;
  gj: number;
  /** Reverb send (0..1). */
  send: number;
  /** Distance model (spatial sounds): full level inside ref, gain = ref / (ref + roll·(d − ref)), culled beyond maxDist. */
  ref: number;
  roll: number;
  maxDist: number;
  /** Higher = less likely to be stolen by the global voice cap. */
  prio: number;
}

export interface SoundDef extends SoundProps {
  name: string;
  cat: Category;
  dur: number;
  ch: 1 | 2;
  n: number;
  render: (s: Synth, v: number) => void;
  /** Peak normalization target of the loudest variant. */
  peakDb: number;
  /** If set, the sound is a seamless loop; this many extra seconds are rendered and crossfaded into the start. */
  loop?: number;
  /** 0 = needed immediately (weapons, impacts, hud), 1 = can stream in after startup. */
  tier: 0 | 1;
}

const CAT_DEFAULTS: Record<Category, Omit<SoundProps, never> & { tier: 0 | 1 }> = {
  gun: { bus: 'weapons', gainDb: 0, voices: 4, pj: 0.025, gj: 1.0, send: 0.35, ref: 6, roll: 0.6, maxDist: 600, prio: 10, tier: 0 },
  tail: { bus: 'weapons', gainDb: -5, voices: 6, pj: 0.04, gj: 1.5, send: 0, ref: 6, roll: 0.6, maxDist: 600, prio: 6, tier: 0 },
  foley: { bus: 'sfx', gainDb: -7, voices: 3, pj: 0.03, gj: 1.5, send: 0.08, ref: 2, roll: 1, maxDist: 30, prio: 5, tier: 0 },
  impact: { bus: 'sfx', gainDb: -1, voices: 10, pj: 0.07, gj: 2, send: 0.3, ref: 3, roll: 1.1, maxDist: 160, prio: 4, tier: 0 },
  world: { bus: 'sfx', gainDb: -2, voices: 8, pj: 0.03, gj: 1.5, send: 0.4, ref: 8, roll: 0.6, maxDist: 900, prio: 7, tier: 0 },
  step: { bus: 'sfx', gainDb: -9, voices: 6, pj: 0.05, gj: 2, send: 0.12, ref: 2, roll: 1.4, maxDist: 45, prio: 3, tier: 0 },
  body: { bus: 'sfx', gainDb: -8, voices: 3, pj: 0.03, gj: 1, send: 0.05, ref: 2, roll: 1, maxDist: 40, prio: 6, tier: 1 },
  hud: { bus: 'hud', gainDb: 0, voices: 3, pj: 0.015, gj: 0.5, send: 0, ref: 1, roll: 1, maxDist: 1, prio: 9, tier: 0 },
  ui: { bus: 'ui', gainDb: -10, voices: 2, pj: 0.01, gj: 0.3, send: 0, ref: 1, roll: 1, maxDist: 1, prio: 8, tier: 1 },
  ambience: { bus: 'ambience', gainDb: -6, voices: 3, pj: 0.02, gj: 1, send: 0.5, ref: 50, roll: 0.5, maxDist: 5000, prio: 1, tier: 1 },
};

function def(name: string, cat: Category, dur: number, ch: 1 | 2, n: number, render: (s: Synth, v: number) => void, o: Partial<SoundDef> = {}): SoundDef {
  const { tier, ...props } = CAT_DEFAULTS[cat];
  return { name, cat, dur, ch, n, render, peakDb: -1, tier, ...props, ...o };
}

export const SOUND_DEFS: SoundDef[] = [
  // ---- player weapons (stereo, non-spatial) ----
  def('rifle_core', 'gun', 0.7, 2, 6, (s) => W.gunCore(s, W.RIFLE)),
  def('smg_core', 'gun', 0.55, 2, 6, (s) => W.gunCore(s, W.SMG), { gainDb: -0.8 }),
  def('pistol_core', 'gun', 0.55, 2, 6, (s) => W.gunCore(s, W.PISTOL), { gainDb: -1 }),
  def('sniper_core', 'gun', 1.0, 2, 4, (s) => W.gunCore(s, W.SNIPER), { voices: 2 }),
  def('shotgun_core', 'gun', 0.9, 2, 4, (s) => W.gunCore(s, W.SHOTGUN), { voices: 2 }),
  def('supp_core', 'gun', 0.45, 2, 6, (s) => W.suppressed(s), { gainDb: -8, send: 0.15 }),
  def('tail_out', 'tail', 2.8, 2, 4, (s) => W.tailOutdoor(s)),
  def('tail_in', 'tail', 0.7, 2, 4, (s) => W.tailIndoor(s), { gainDb: -4 }),
  def('dryfire', 'foley', 0.2, 2, 3, (s) => W.dryFire(s), { gainDb: -8 }),
  def('mag_out', 'foley', 0.45, 2, 3, (s) => W.magOut(s)),
  def('mag_in', 'foley', 0.55, 2, 3, (s) => W.magIn(s)),
  def('bolt_release', 'foley', 0.35, 2, 3, (s) => W.boltRelease(s), { gainDb: -7 }),
  def('charge_handle', 'foley', 0.55, 2, 2, (s) => W.chargingHandle(s), { gainDb: -7 }),
  def('reload_rustle', 'foley', 0.6, 2, 3, (s) => W.reloadRustle(s), { gainDb: -14 }),
  def('ads_in', 'foley', 0.35, 2, 3, (s) => W.adsIn(s), { gainDb: -14 }),
  def('ads_out', 'foley', 0.3, 2, 3, (s) => W.adsOut(s), { gainDb: -16 }),
  def('weapon_switch', 'foley', 0.6, 2, 3, (s) => W.weaponSwitch(s), { gainDb: -11 }),
  def('grenade_pin', 'foley', 0.35, 2, 2, (s) => W.grenadePin(s), { tier: 1 }),
  def('throw_whoosh', 'foley', 0.45, 2, 2, (s) => W.throwWhoosh(s), { tier: 1 }),

  // ---- world (mono, spatialized) ----
  def('enemy_rifle', 'world', 0.7, 1, 5, (s) => W.gunCore(s, W.ENEMY_RIFLE), { gainDb: -5 }),
  def('rifle_distant', 'world', 2.0, 1, 4, (s) => W.distantShot(s), { gainDb: -4, send: 0.6 }),
  def('whiz', 'world', 0.3, 1, 5, (s) => X.whizBy(s), { gainDb: 5, send: 0.05, ref: 2, roll: 1, maxDist: 20, voices: 4 }),
  def('explosion', 'world', 3.5, 1, 3, (s) => X.explosion(s), { gainDb: 4, voices: 3, ref: 10, roll: 0.5, prio: 10 }),
  def('explosion_far', 'world', 4.0, 1, 2, (s) => X.explosionFar(s), { gainDb: 1, voices: 2, ref: 10, roll: 0.5, prio: 9, send: 0.6 }),
  def('grenade_bounce', 'impact', 0.3, 1, 3, (s) => X.grenadeBounce(s), { gainDb: -6, tier: 1 }),
  def('casing_rifle', 'impact', 0.8, 1, 5, (s) => X.casing(s, 'rifle', 'hard'), { gainDb: -16, voices: 4, send: 0.05, ref: 1.5, maxDist: 25 }),
  def('casing_rifle_metal', 'impact', 0.9, 1, 3, (s) => X.casing(s, 'rifle', 'metal'), { gainDb: -16, voices: 4, send: 0.05, ref: 1.5, maxDist: 25 }),
  def('casing_pistol', 'impact', 0.6, 1, 4, (s) => X.casing(s, 'pistol', 'hard'), { gainDb: -17, voices: 4, send: 0.05, ref: 1.5, maxDist: 25 }),
  def('casing_soft', 'impact', 0.3, 1, 3, (s) => X.casing(s, 'rifle', 'soft'), { gainDb: -20, voices: 3, send: 0.02, ref: 1.5, maxDist: 20 }),
  def('imp_concrete', 'impact', 0.45, 1, 6, (s) => X.impactConcrete(s)),
  def('imp_metal', 'impact', 0.9, 1, 5, (s) => X.impactMetal(s), { gainDb: -5 }),
  def('imp_wood', 'impact', 0.4, 1, 4, (s) => X.impactWood(s)),
  def('imp_dirt', 'impact', 0.55, 1, 4, (s) => X.impactDirt(s)),
  def('imp_sand', 'impact', 0.55, 1, 3, (s) => X.impactDirt(s, true)),
  def('imp_glass', 'impact', 1.3, 1, 3, (s) => X.impactGlass(s), { gainDb: -3 }),
  def('imp_flesh', 'impact', 0.3, 1, 5, (s) => X.impactFlesh(s), { gainDb: -3, send: 0.1 }),
  def('imp_water', 'impact', 0.6, 1, 3, (s) => X.impactWater(s), { gainDb: -6 }),
  def('ricochet', 'impact', 0.7, 1, 3, (s) => X.ricochet(s), { gainDb: -10, voices: 2 }),
  ...(['concrete', 'dirt', 'gravel', 'metal', 'wood', 'water'] as const).map((surf) =>
    def(`step_${surf}`, 'step', 0.3, 1, 6, (s) => X.footstep(s, surf), { gainDb: surf === 'metal' ? -11 : -9 })),
  def('gear_rattle', 'step', 0.35, 1, 5, (s) => X.gearRattle(s), { gainDb: -15 }),
  def('jump', 'body', 0.4, 1, 3, (s) => X.jump(s), { gainDb: -12, tier: 0 }),
  def('land', 'body', 0.45, 1, 3, (s) => X.land(s), { gainDb: -9, tier: 0 }),
  def('mantle', 'body', 1.0, 1, 3, (s) => X.mantle(s, false), { gainDb: -9, tier: 0 }),
  def('vault', 'body', 0.8, 1, 3, (s) => X.mantle(s, true), { gainDb: -9, tier: 0 }),
  def('slide', 'body', 1.1, 1, 2, (s) => X.slide(s), { gainDb: -11 }),
  def('bodyfall', 'body', 0.7, 1, 3, (s) => X.bodyFall(s), { gainDb: -6, send: 0.2, ref: 3, maxDist: 60 }),

  // ---- hud / ui / player ----
  def('hitmarker', 'hud', 0.1, 1, 4, (s) => U.hitmarker(s)),
  def('kill_confirm', 'hud', 0.25, 1, 3, (s) => U.killConfirm(s), { gainDb: 0 }),
  def('headshot', 'hud', 0.4, 1, 3, (s) => U.headshot(s), { gainDb: -2 }),
  def('ui_click', 'ui', 0.08, 1, 2, (s) => U.uiClick(s)),
  def('ui_hover', 'ui', 0.06, 1, 1, (s) => U.uiHover(s), { gainDb: -18 }),
  def('hurt_hit', 'body', 0.4, 2, 3, (s) => U.hurtHit(s), { gainDb: -2, bus: 'hud', tier: 0 }),
  def('heartbeat', 'body', 0.55, 1, 2, (s) => U.heartbeat(s), { gainDb: -3, bus: 'hud' }),
  def('breath_in', 'body', 0.9, 1, 3, (s) => U.breathIn(s), { gainDb: -16, bus: 'hud' }),
  def('breath_out', 'body', 1.1, 1, 3, (s) => U.breathOut(s), { gainDb: -17, bus: 'hud' }),

  // ---- ambience ----
  def('amb_wind', 'ambience', 24, 2, 1, (s) => U.ambWind(s), { loop: 3, peakDb: -3, gainDb: -12 }),
  def('amb_town', 'ambience', 24, 2, 1, (s) => U.ambTown(s), { loop: 3, peakDb: -3, gainDb: -14 }),
  def('amb_dog', 'ambience', 1.6, 1, 3, (s) => U.dogBark(s), { gainDb: -8 }),
  def('amb_drone', 'ambience', 11, 1, 1, (s) => U.ambDrone(s), { gainDb: -16 }),
  def('amb_clank', 'ambience', 1.5, 1, 3, (s) => U.ambClank(s), { gainDb: -8 }),
];

export const DEF_BY_NAME = new Map(SOUND_DEFS.map((d) => [d.name, d]));

// ---------------- rendering ----------------

export async function renderVariant(d: SoundDef, v: number, sr: number): Promise<AudioBuffer> {
  const extra = d.loop ?? 0;
  const len = Math.ceil((d.dur + extra) * sr);
  const ctx = new OfflineAudioContext({ numberOfChannels: d.ch, length: len, sampleRate: sr });
  const rng = mulberry32(hashStr(d.name) ^ Math.imul(v + 1, 0x9e3779b1));
  const s = new Synth(ctx, rng, len / sr);
  d.render(s, v);
  // 2nd-order DC blocker on every sound (brown noise and asymmetric shapers leak DC)
  const dcb = ctx.createBiquadFilter(); dcb.type = 'highpass'; dcb.frequency.value = 18; dcb.Q.value = -3;
  s.out.connect(dcb).connect(ctx.destination);
  const buf = await ctx.startRendering();
  return post(buf, d, sr);
}

function post(buf: AudioBuffer, d: SoundDef, sr: number): AudioBuffer {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  if (d.loop) {
    const L = Math.round(d.dur * sr), X = Math.round(d.loop * sr);
    const out = new AudioBuffer({ length: L, numberOfChannels: chans.length, sampleRate: sr });
    chans.forEach((c, ci) => {
      const o = new Float32Array(L);
      o.set(c.subarray(0, L));
      for (let i = 0; i < X; i++) { const u = i / X; o[i] = c[i] * Math.sin(u * Math.PI / 2) + c[L + i] * Math.cos(u * Math.PI / 2); }
      out.copyToChannel(o, ci);
    });
    return out;
  }
  // Trim trailing silence below -84 dB of peak, then fade the last 6 ms.
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  const thr = peak * 6e-5;
  let last = 0;
  for (const c of chans) for (let i = c.length - 1; i > last; i--) if (Math.abs(c[i]) > thr) { last = i; break; }
  const fade = Math.round(0.006 * sr);
  const len = Math.min(buf.length, last + fade + 1);
  const out = new AudioBuffer({ length: Math.max(len, 32), numberOfChannels: chans.length, sampleRate: sr });
  chans.forEach((c, ci) => {
    const o = c.slice(0, out.length);
    for (let i = 0; i < fade && i < o.length; i++) o[o.length - 1 - i] *= i / fade;
    out.copyToChannel(o, ci);
  });
  return out;
}

function normalize(bufs: AudioBuffer[], peakDb: number) {
  let peak = 0;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
  if (peak <= 0) return;
  const k = dbToGain(peakDb) / peak;
  for (const b of bufs) for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
}

export async function renderSound(d: SoundDef, sr: number): Promise<AudioBuffer[]> {
  const bufs: AudioBuffer[] = [];
  for (let v = 0; v < d.n; v++) bufs.push(await renderVariant(d, v, sr));
  normalize(bufs, d.peakDb);
  return bufs;
}

/** Render many sounds with bounded concurrency (each variant is its own OfflineAudioContext). */
export async function renderBank(defs: SoundDef[], sr: number, onSound?: (d: SoundDef, bufs: AudioBuffer[]) => void, concurrency = 4): Promise<Map<string, AudioBuffer[]>> {
  const out = new Map<string, AudioBuffer[]>();
  let next = 0;
  const worker = async () => {
    while (next < defs.length) {
      const d = defs[next++];
      try {
        const bufs = await renderSound(d, sr);
        out.set(d.name, bufs);
        onSound?.(d, bufs);
      } catch (e) {
        console.warn(`[audio] failed to render ${d.name}`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

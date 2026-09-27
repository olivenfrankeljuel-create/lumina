import type { Synth } from '../synth';
import { rr, jit } from '../rng';

/**
 * Gunshot anatomy (what a CoD-style close-mic'd weapon is built from):
 *  1. muzzle shock: N-wave pressure pulse, sub-millisecond rise -> the "crack"
 *  2. crack noise: bright broadband burst, few ms
 *  3. bark: band-limited mid noise (0.5–2 kHz), tens of ms, saturated -> "character"
 *  4. body/punch: pitched-down sine thump 150 -> 50 Hz, heavily driven -> chest hit
 *  5. boom: low-passed brown noise sub-bass bloom
 *  6. mechanics: bolt/slide modal clacks at t=0 and when the action returns
 *  7. close air: short early-reflection bloom (the environmental tail is a separate layer)
 * Everything is summed into a glue saturator so the transient is dense and loud.
 */
export interface GunParams {
  crack: { gain: number; width: number; tau: number; hp: number; pk: number };
  bark: { f: number; q: number; tau: number; gain: number; drive: number };
  body: { f0: number; f1: number; sweep: number; tau: number; gain: number; drive: number };
  boom: { lp: number; tau: number; gain: number };
  mid: { f: number; tau: number; gain: number };
  mech: { times: number[]; f: number; gain: number; ring: number };
  air: { tau: number; gain: number; lp: number };
  glue: number;
}

export function gunCore(s: Synth, p: GunParams) {
  const r = s.rng;
  const bus = s.gainNode(1);
  const glue = s.shaper(p.glue);
  const hp = s.bq(['hp', 28, 0.6]);
  bus.connect(glue).connect(hp).connect(s.out);
  const d = bus;
  const w = (v: number, f = 0.12) => jit(r, v, f);

  // 1. muzzle shock
  s.impulse({ t: 0, width: w(p.crack.width, 0.2), gain: w(p.crack.gain, 0.1), f: [['hp', p.crack.hp * 0.6, 0.5]], dest: d });
  // 2. crack noise (instant attack)
  s.noiseL({ t: 0, a: 0, tau: w(p.crack.tau, 0.2), gain: w(p.crack.gain * 0.9, 0.12), color: 'white2', f: [['hp', w(p.crack.hp), 0.7], ['pk', w(p.crack.pk, 0.15), 1.1, 6]], dest: d });
  // 3. bark
  s.noiseL({ t: 0, a: 0.0004, tau: w(p.bark.tau, 0.18), gain: w(p.bark.gain, 0.12), color: 'white', f: [['bp', w(p.bark.f, 0.15), p.bark.q], ['lp', 6000]], drive: p.bark.drive, dest: d });
  // 4. body punch
  s.toneL({ t: 0, f0: w(p.body.f0, 0.08), f1: w(p.body.f1, 0.08), sweep: w(p.body.sweep, 0.2), a: 0.0012, tau: w(p.body.tau, 0.15), gain: w(p.body.gain, 0.1), drive: p.body.drive, dest: d });
  // 5. boom
  s.noiseL({ t: 0.001, a: 0.003, tau: w(p.boom.tau, 0.2), gain: w(p.boom.gain, 0.15), color: 'brown', f: [['lp', w(p.boom.lp, 0.15), 0.9]], drive: 1.5, dest: d });
  // 5b. punch: saturated low-mid muzzle blast (where most real close-mic energy sits)
  s.noiseL({ t: 0, a: 0.0015, tau: w(p.mid.tau, 0.2), gain: w(p.mid.gain, 0.15), color: 'white', f: [['bp', w(p.mid.f, 0.15), 0.9]], drive: 1.8, dest: d });
  // 6. mechanics
  for (let i = 0; i < p.mech.times.length; i++) {
    const t = Math.max(0.0005, w(p.mech.times[i], 0.1));
    const f = w(p.mech.f, 0.08) * (i === 0 ? 1 : 0.86);
    const g = p.mech.gain * (i === 0 ? 1 : 0.75) * rr(r, 0.8, 1.2);
    s.modal({
      t, gain: g, dest: d, pan: rr(r, -0.15, 0.15), modes: [
        { f, tau: 0.018 * p.mech.ring, a: 1 },
        { f: f * w(1.62, 0.04), tau: 0.014 * p.mech.ring, a: 0.8 },
        { f: f * w(2.51, 0.04), tau: 0.01 * p.mech.ring, a: 0.6 },
        { f: f * w(3.73, 0.05), tau: 0.006 * p.mech.ring, a: 0.45 },
        { f: f * 0.47, tau: 0.012 * p.mech.ring, a: 0.5 },
      ],
    });
    s.noiseL({ t, tau: 0.0025, gain: g * 1.4, f: [['hp', 2500]], dest: d });
  }
  // 7. close air bloom (stereo, decorrelated)
  s.noiseL({ t: 0.003, a: 0.008, tau: w(p.air.tau, 0.2), gain: w(p.air.gain, 0.2), color: 'pink2', f: [['lp', p.air.lp, 0.7, undefined, { to: p.air.lp * 0.35, tau: 0.08 }], ['hp', 120]], dest: d });
}

export const RIFLE: GunParams = {
  crack: { gain: 1.4, width: 0.0003, tau: 0.004, hp: 1200, pk: 3000 },
  bark: { f: 1100, q: 0.8, tau: 0.024, gain: 1.3, drive: 2.0 },
  body: { f0: 165, f1: 68, sweep: 0.016, tau: 0.04, gain: 0.9, drive: 1.8 },
  boom: { lp: 180, tau: 0.045, gain: 0.5 },
  mid: { f: 280, tau: 0.035, gain: 1.2 },
  mech: { times: [0.0008, 0.042], f: 2250, gain: 0.3, ring: 1 },
  air: { tau: 0.12, gain: 0.3, lp: 4200 },
  glue: 1.4,
};
export const SMG: GunParams = {
  crack: { gain: 1.35, width: 0.00026, tau: 0.0032, hp: 1400, pk: 3500 },
  bark: { f: 1350, q: 0.9, tau: 0.019, gain: 1.25, drive: 1.9 },
  body: { f0: 180, f1: 78, sweep: 0.014, tau: 0.032, gain: 0.75, drive: 1.7 },
  boom: { lp: 200, tau: 0.035, gain: 0.35 },
  mid: { f: 340, tau: 0.028, gain: 1.1 },
  mech: { times: [0.0008, 0.03], f: 2700, gain: 0.34, ring: 0.9 },
  air: { tau: 0.1, gain: 0.26, lp: 4800 },
  glue: 1.4,
};
export const PISTOL: GunParams = {
  crack: { gain: 1.4, width: 0.00022, tau: 0.003, hp: 1600, pk: 3800 },
  bark: { f: 1600, q: 1.0, tau: 0.016, gain: 1.2, drive: 1.9 },
  body: { f0: 210, f1: 95, sweep: 0.01, tau: 0.02, gain: 0.5, drive: 1.4 },
  boom: { lp: 220, tau: 0.022, gain: 0.18 },
  mid: { f: 420, tau: 0.024, gain: 1.0 },
  mech: { times: [0.0008, 0.024], f: 3100, gain: 0.26, ring: 1.1 },
  air: { tau: 0.09, gain: 0.24, lp: 5000 },
  glue: 1.4,
};
export const SNIPER: GunParams = {
  crack: { gain: 1.5, width: 0.00042, tau: 0.0055, hp: 1000, pk: 2600 },
  bark: { f: 850, q: 0.7, tau: 0.04, gain: 1.35, drive: 2.3 },
  body: { f0: 150, f1: 55, sweep: 0.022, tau: 0.07, gain: 1.0, drive: 2.0 },
  boom: { lp: 160, tau: 0.09, gain: 0.7 },
  mid: { f: 240, tau: 0.055, gain: 1.3 },
  mech: { times: [0.0008], f: 1900, gain: 0.12, ring: 1.4 },
  air: { tau: 0.22, gain: 0.4, lp: 3600 },
  glue: 1.6,
};
export const SHOTGUN: GunParams = {
  crack: { gain: 1.2, width: 0.0005, tau: 0.0065, hp: 900, pk: 2300 },
  bark: { f: 700, q: 0.6, tau: 0.045, gain: 1.4, drive: 2.3 },
  body: { f0: 135, f1: 52, sweep: 0.025, tau: 0.065, gain: 1.05, drive: 2.0 },
  boom: { lp: 170, tau: 0.08, gain: 0.75 },
  mid: { f: 230, tau: 0.06, gain: 1.35 },
  mech: { times: [0.0008], f: 1700, gain: 0.1, ring: 1.2 },
  air: { tau: 0.22, gain: 0.4, lp: 3200 },
  glue: 1.6,
};
/** Enemy AK-pattern rifle: lower bark, heavier body — mono, spatialized at runtime. */
export const ENEMY_RIFLE: GunParams = {
  crack: { gain: 1.35, width: 0.00034, tau: 0.0045, hp: 1100, pk: 2700 },
  bark: { f: 900, q: 0.75, tau: 0.028, gain: 1.35, drive: 2.1 },
  body: { f0: 155, f1: 62, sweep: 0.018, tau: 0.045, gain: 0.9, drive: 1.8 },
  boom: { lp: 170, tau: 0.05, gain: 0.5 },
  mid: { f: 260, tau: 0.04, gain: 1.2 },
  mech: { times: [0.0008, 0.05], f: 1900, gain: 0.1, ring: 1 },
  air: { tau: 0.12, gain: 0.26, lp: 3800 },
  glue: 1.5,
};

export function suppressed(s: Synth) {
  const r = s.rng;
  const bus = s.gainNode(1);
  bus.connect(s.shaper(1.3)).connect(s.bq(['hp', 45, 0.6])).connect(s.out);
  const d = bus;
  // "thwp": band-limited gas puff, softened attack (the can strips the muzzle shock)
  s.noiseL({ t: 0, a: 0.0009, tau: jit(r, 0.014, 0.2), gain: 1.3, color: 'white', f: [['bp', jit(r, 1050, 0.15), 0.8], ['lp', 5000]], drive: 1.6, dest: d });
  s.noiseL({ t: 0, a: 0.0006, tau: jit(r, 0.022, 0.2), gain: 0.35, color: 'white2', f: [['hp', 3500]], dest: d });
  // short can thump
  s.toneL({ t: 0, f0: jit(r, 150, 0.08), f1: jit(r, 80, 0.08), sweep: 0.012, a: 0.0015, tau: jit(r, 0.018, 0.15), gain: 0.55, drive: 1.2, dest: d });
  s.noiseL({ t: 0.0005, a: 0.002, tau: 0.02, gain: 0.45, color: 'white', f: [['bp', 320, 0.9]], drive: 1.3, dest: d });
  // the action is now the dominant high-frequency element: unlock clack + bolt return "chk"
  const f = jit(r, 2350, 0.08);
  for (const [t, g] of [[0.0008, 0.5], [jit(r, 0.045, 0.1), 0.55]] as const) {
    s.modal({ t, gain: g * rr(r, 0.85, 1.15), dest: d, pan: rr(r, -0.2, 0.2), modes: [
      { f, tau: 0.018, a: 1 }, { f: f * 1.58, tau: 0.014, a: 0.8 }, { f: f * 2.47, tau: 0.01, a: 0.6 }, { f: f * 3.9, tau: 0.006, a: 0.4 }, { f: f * 0.51, tau: 0.012, a: 0.55 },
    ] });
    s.noiseL({ t, tau: 0.003, gain: g * 1.3, f: [['hp', 2200]], dest: d });
    s.noiseL({ t, a: 0.001, tau: 0.008, gain: g * 0.6, color: 'brown', f: [['lp', 500]], dest: d });
  }
  s.noiseL({ t: 0.004, a: 0.01, tau: 0.06, gain: 0.12, color: 'pink2', f: [['lp', 3000], ['hp', 200]], dest: d });
}

/**
 * Outdoor environmental tail: the signature "rolling" slapback of a gunshot off buildings —
 * discrete low-passed echoes that get darker and more diffuse, over a low rumble bloom.
 */
export function tailOutdoor(s: Synth) {
  const r = s.rng;
  const d = s.gainNode(1);
  d.connect(s.bq(['hp', 50, 0.6])).connect(s.out);
  // diffuse body of the reverberant field: darkens as it decays (-60 dB ≈ 2.4 s)
  s.noiseL({ t: 0.015, a: 0.05, tau: rr(r, 0.33, 0.38), gain: 0.3, color: 'pink2', f: [['lp', 2600, 0.7, undefined, { to: 450, tau: 0.35 }], ['hp', 140]], dest: d });
  // low rolling rumble: noise, not a tone
  s.noiseL({ t: 0.03, a: 0.09, tau: rr(r, 0.3, 0.36), gain: 0.35, color: 'brown2', f: [['lp', 240, 0.7]], dest: d });
  // discrete slapbacks off buildings: each a darker, softer copy of the shot
  let t = rr(r, 0.045, 0.08);
  for (let i = 0; i < 8; i++) {
    const k = Math.pow(0.74, i) * rr(r, 0.75, 1.1);
    const lp = 5000 / (1 + i * 0.55);
    const pan = rr(r, -0.9, 0.9);
    s.noiseL({ t, a: 0.0015 + i * 0.0015, tau: 0.018 + i * 0.012, gain: 0.8 * k, color: 'white', f: [['bp', rr(r, 800, 1400) / (1 + i * 0.12), 0.7], ['lp', lp]], pan, dest: d });
    s.noiseL({ t: t + 0.001, a: 0.003 + i * 0.002, tau: 0.03 + i * 0.012, gain: 0.7 * k, color: 'white', f: [['bp', rr(r, 200, 320), 0.9]], pan: pan * 0.6, dest: d });
    t += rr(r, 0.045, 0.13) * (1 + i * 0.18);
  }
}

/** Small-interior tail: dense early reflections, a flutter echo between parallel walls and a short boxy ring. */
export function tailIndoor(s: Synth) {
  const r = s.rng;
  const d = s.gainNode(1);
  d.connect(s.bq(['hp', 90, 0.6])).connect(s.out);
  for (let i = 0; i < 22; i++) {
    const t = rr(r, 0.002, 0.035);
    s.noiseL({ t, tau: rr(r, 0.002, 0.006), gain: rr(r, 0.15, 0.45) * (1 - t * 12), color: 'white', f: [['bp', rr(r, 600, 4000), 0.8]], pan: rr(r, -1, 1), dest: d });
  }
  // flutter echo: evenly spaced, decaying, getting darker
  const period = rr(r, 0.011, 0.019);
  const fpan = rr(r, -0.6, 0.6);
  for (let i = 0, t = 0.02; t < 0.3; i++, t += period * rr(r, 0.97, 1.03)) {
    s.noiseL({ t, tau: 0.003, gain: 0.35 * Math.exp(-t / 0.07), color: 'white', f: [['bp', 2200 / (1 + i * 0.05), 0.9]], pan: i % 2 ? fpan : -fpan, dest: d });
  }
  s.noiseL({ t: 0.003, a: 0.006, tau: rr(r, 0.08, 0.1), gain: 0.55, color: 'pink2', f: [['pk', rr(r, 250, 420), 2, 6], ['lp', 5000, 0.7, undefined, { to: 1500, tau: 0.12 }], ['hp', 110]], dest: d });
  s.modal({ t: 0.004, gain: 0.08, dest: d, modes: [
    { f: rr(r, 95, 130), tau: 0.08, a: 1 }, { f: rr(r, 170, 220), tau: 0.065, a: 0.7 }, { f: rr(r, 260, 330), tau: 0.05, a: 0.5 },
  ] });
}

/** Distant gunshot: no crack, dull pop plus a long rolling low-passed echo train. */
export function distantShot(s: Synth) {
  const r = s.rng;
  const d = s.gainNode(1);
  d.connect(s.bq(['hp', 40, 0.6])).connect(s.out);
  s.noiseL({ t: 0, a: 0.002, tau: jit(r, 0.028, 0.2), gain: 0.9, color: 'white', f: [['bp', jit(r, 480, 0.2), 0.7], ['lp', 1400]], drive: 1.6, dest: d });
  s.toneL({ t: 0, f0: jit(r, 110, 0.1), f1: 45, sweep: 0.03, a: 0.004, tau: 0.07, gain: 0.8, drive: 2, dest: d });
  s.noiseL({ t: 0.002, a: 0.01, tau: jit(r, 0.13, 0.2), gain: 0.8, color: 'brown', f: [['lp', 170]], dest: d });
  s.noiseL({ t: 0.03, a: 0.08, tau: jit(r, 0.5, 0.2), gain: 0.35, color: 'pink', f: [['lp', 650, 0.7, undefined, { to: 250, tau: 0.5 }], ['hp', 60]], dest: d });
  let t = rr(r, 0.12, 0.25);
  for (let i = 0; i < 5; i++) {
    const k = Math.pow(0.65, i);
    s.noiseL({ t, a: 0.006, tau: 0.05 + i * 0.03, gain: 0.45 * k, color: 'brown', f: [['lp', 500 / (1 + i * 0.3)]], dest: d });
    t += rr(r, 0.12, 0.3);
  }
}

// ---------------- handling foley ----------------

function click(s: Synth, t: number, f: number, gain: number, ring = 1, pan = 0, dest?: AudioNode) {
  const r = s.rng;
  s.impulse({ t, width: 0.00012, gain: gain * 0.8, shape: 'click', f: [['hp', f * 0.6]], pan, dest });
  s.modal({ t, gain, pan, dest, modes: [
    { f: jit(r, f, 0.06), tau: 0.012 * ring, a: 1 }, { f: jit(r, f * 1.71, 0.05), tau: 0.009 * ring, a: 0.7 },
    { f: jit(r, f * 2.63, 0.05), tau: 0.006 * ring, a: 0.5 }, { f: jit(r, f * 0.55, 0.05), tau: 0.01 * ring, a: 0.35 },
  ] });
}

function scrape(s: Synth, t: number, dur: number, f0: number, f1: number, gain: number, pan = 0, dest?: AudioNode) {
  s.noiseL({ t, a: dur * 0.3, hold: dur * 0.4, tau: dur * 0.25, gain, color: 'white', f: [['bp', f0, 1.4, undefined, { to: f1, tau: dur * 0.6 }], ['hp', 600]], pan, dest });
  // grain of the metal-on-metal contact
  const n = Math.round(dur * 120);
  for (let i = 0; i < n; i++) s.noiseL({ t: t + (i / n) * dur, tau: 0.0012, gain: gain * 0.5 * s.rng(), f: [['hp', 3000]], pan, dest });
}

function thunk(s: Synth, t: number, lp: number, gain: number, tau = 0.02, pan = 0, dest?: AudioNode) {
  s.noiseL({ t, a: 0.001, tau, gain, color: 'brown', f: [['lp', lp]], pan, dest });
}

export function dryFire(s: Synth) {
  const r = s.rng;
  click(s, 0.002, jit(r, 2600, 0.08), 0.8, 1.2);
  thunk(s, 0.002, 500, 0.4, 0.01);
  click(s, jit(r, 0.07, 0.15), jit(r, 3400, 0.08), 0.25, 0.8);
}

export function magOut(s: Synth) {
  const r = s.rng;
  const p = rr(r, 0.1, 0.3);
  click(s, 0.005, jit(r, 3000, 0.1), 0.6, 1, p);           // release button
  scrape(s, 0.02, jit(r, 0.09, 0.2), 1800, 2600, 0.6, p);  // mag sliding out of well
  thunk(s, 0.1, 450, 0.45, 0.025, p);                       // mag free
  for (let i = 0; i < 4; i++) click(s, rr(r, 0.1, 0.2), rr(r, 4500, 7000), 0.12, 0.6, p); // rounds rattle
  s.rustle(0.08, 0.25, 0.12);
}

export function magIn(s: Synth) {
  const r = s.rng;
  const p = rr(r, 0.05, 0.25);
  scrape(s, 0.0, jit(r, 0.1, 0.2), 1500, 2800, 0.65, p);
  const seat = jit(r, 0.13, 0.12);
  click(s, seat, jit(r, 1900, 0.1), 1.0, 1.3, p);          // seat "chk"
  thunk(s, seat, 320, 0.8, 0.025, p);
  // palm slap
  const slap = seat + rr(r, 0.14, 0.2);
  s.noiseL({ t: slap, a: 0.0008, tau: 0.012, gain: 0.55, color: 'pink', f: [['lp', 1600], ['hp', 120]], pan: p });
  thunk(s, slap, 260, 0.5, 0.02, p);
  click(s, slap + 0.002, jit(r, 1700, 0.1), 0.3, 1, p);
  s.rustle(0.0, 0.3, 0.1);
}

export function boltRelease(s: Synth) {
  const r = s.rng;
  const p = rr(r, 0.0, 0.2);
  click(s, 0.002, jit(r, 3500, 0.1), 0.3, 0.6, p);         // catch pressed
  const t = jit(r, 0.03, 0.2);
  // bolt slamming home: sharp heavy clack with a spring ring
  s.impulse({ t, width: 0.0002, gain: 0.8, f: [['hp', 900]], pan: p });
  s.modal({ t, gain: 0.9, pan: p, modes: [
    { f: jit(r, 1250, 0.08), tau: 0.035, a: 1 }, { f: jit(r, 2650, 0.06), tau: 0.03, a: 0.9 }, { f: jit(r, 4100, 0.06), tau: 0.02, a: 0.7 },
    { f: jit(r, 6300, 0.06), tau: 0.012, a: 0.5 }, { f: jit(r, 9100, 0.06), tau: 0.006, a: 0.35 },
  ] });
  s.modal({ t: t + 0.001, gain: 0.08, pan: p, modes: [{ f: jit(r, 720, 0.1), tau: 0.14, a: 1 }, { f: jit(r, 1530, 0.1), tau: 0.09, a: 0.6 }] });
  thunk(s, t, 280, 0.9, 0.022, p);
  s.noiseL({ t, tau: 0.004, gain: 0.5, f: [['hp', 3000]], pan: p });
}

export function chargingHandle(s: Synth) {
  const r = s.rng;
  const p = rr(r, 0.0, 0.2);
  click(s, 0.004, 3200, 0.35, 0.8, p);
  scrape(s, 0.01, 0.11, 2200, 3200, 0.4, p);
  click(s, 0.12, jit(r, 2200, 0.1), 0.55, 1, p);           // rear stop
  thunk(s, 0.12, 400, 0.4, 0.015, p);
  const t = jit(r, 0.3, 0.1);
  scrape(s, t - 0.03, 0.03, 2600, 3200, 0.2, p);
  s.modal({ t, gain: 0.95, pan: p, modes: [
    { f: jit(r, 1150, 0.08), tau: 0.035, a: 1 }, { f: jit(r, 2500, 0.06), tau: 0.03, a: 0.9 }, { f: jit(r, 3900, 0.06), tau: 0.018, a: 0.7 }, { f: jit(r, 6000, 0.06), tau: 0.01, a: 0.5 },
  ] });
  s.impulse({ t, width: 0.0002, gain: 0.8, f: [['hp', 900]], pan: p });
  thunk(s, t, 260, 0.9, 0.025, p);
}

export function reloadRustle(s: Synth) {
  const r = s.rng;
  s.rustle(0, 0.45, 0.28);
  s.noiseL({ t: 0.02, a: 0.08, tau: 0.08, gain: 0.25, color: 'pink', f: [['lp', 900], ['hp', 120]] });
  click(s, rr(r, 0.08, 0.3), rr(r, 3500, 5500), 0.12, 0.8, rr(r, -0.4, 0.4));
}

export function adsIn(s: Synth) {
  const r = s.rng;
  s.rustle(0, jit(r, 0.14, 0.2), 0.3, 1.1);
  s.noiseL({ t: 0, a: 0.05, tau: 0.05, gain: 0.3, color: 'pink2', f: [['lp', 1100], ['hp', 150]] });
  click(s, jit(r, 0.12, 0.2), jit(r, 2600, 0.12), 0.18, 1, rr(r, -0.2, 0.2)); // cheek weld / gear settle
  thunk(s, 0.12, 300, 0.2, 0.02);
}

export function adsOut(s: Synth) {
  const r = s.rng;
  s.rustle(0, jit(r, 0.12, 0.2), 0.22, 0.9);
  s.noiseL({ t: 0, a: 0.04, tau: 0.05, gain: 0.2, color: 'pink2', f: [['lp', 900], ['hp', 150]] });
}

export function weaponSwitch(s: Synth) {
  const r = s.rng;
  s.rustle(0, 0.35, 0.3);
  s.noiseL({ t: 0.02, a: 0.1, tau: 0.08, gain: 0.3, color: 'pink2', f: [['lp', 800], ['hp', 100]] });
  for (let i = 0; i < 5; i++) click(s, rr(r, 0.05, 0.3), rr(r, 1800, 5000), rr(r, 0.08, 0.2), 0.8, rr(r, -0.5, 0.5));
  // sling swivel clink
  s.modal({ t: rr(r, 0.1, 0.25), gain: 0.1, pan: rr(r, -0.5, 0.5), modes: [{ f: rr(r, 4200, 5200), tau: 0.06, a: 1 }, { f: rr(r, 7000, 8200), tau: 0.03, a: 0.6 }] });
  const t = jit(r, 0.36, 0.1);
  click(s, t, jit(r, 1800, 0.1), 0.7, 1.2);                // shouldered / mounted clack
  thunk(s, t, 300, 0.6, 0.02);
}

export function grenadePin(s: Synth) {
  const r = s.rng;
  scrape(s, 0, 0.06, 3500, 5000, 0.2);
  s.modal({ t: 0.06, gain: 0.35, modes: [{ f: jit(r, 3600, 0.05), tau: 0.09, a: 1 }, { f: jit(r, 5900, 0.05), tau: 0.06, a: 0.6 }, { f: jit(r, 8300, 0.05), tau: 0.03, a: 0.4 }] });
  click(s, 0.06, 2500, 0.3);
}

export function throwWhoosh(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.12, tau: 0.08, gain: 0.6, color: 'pink2', f: [['bp', 450, 1.2, undefined, { to: 1400, tau: 0.08 }], ['hp', 150]] });
  s.rustle(0, 0.25, 0.2);
  // spoon flying off
  s.modal({ t: rr(r, 0.12, 0.2), gain: 0.12, pan: rr(r, -0.5, 0.5), modes: [{ f: jit(r, 4800, 0.05), tau: 0.05, a: 1 }, { f: jit(r, 7300, 0.05), tau: 0.03, a: 0.5 }] });
}

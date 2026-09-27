import type { Synth } from '../synth';
import { rr, jit } from '../rng';

// ---------------- shell casings ----------------

/** Brass casing bouncing: each contact excites the case's inharmonic modes, bounce intervals shrink geometrically. */
export function casing(s: Synth, kind: 'rifle' | 'pistol', surf: 'hard' | 'metal' | 'soft') {
  const r = s.rng;
  const base = kind === 'rifle' ? rr(r, 3900, 4700) : rr(r, 5200, 6200);
  const ratios = [1, 1.59 + rr(r, -0.04, 0.04), 2.31 + rr(r, -0.05, 0.05), 2.9 + rr(r, -0.06, 0.06), 3.7];
  let t = 0.002, interval = rr(r, 0.09, 0.14) * (kind === 'rifle' ? 1 : 0.8), amp = 1;
  const bounces = surf === 'soft' ? 2 : kind === 'rifle' ? Math.round(rr(r, 4, 7)) : Math.round(rr(r, 3, 5));
  for (let i = 0; i < bounces; i++) {
    const pan = rr(r, -0.2, 0.2);
    if (surf === 'soft') {
      s.noiseL({ t, tau: 0.004, gain: amp * 0.6, color: 'pink', f: [['bp', rr(r, 900, 1500), 1], ['lp', 2500]], pan });
      s.modal({ t, gain: amp * 0.12, f: [['lp', 3500]], modes: ratios.slice(0, 3).map((k, j) => ({ f: base * k, tau: 0.008, a: 1 / (j + 1) })) });
    } else {
      s.impulse({ t, width: 0.00008, gain: amp * 0.6, shape: 'click', f: [['hp', 2500]], pan });
      s.noiseL({ t, tau: 0.002, gain: amp * 0.7, f: [['hp', 3000]], pan });
      const ring = (surf === 'metal' ? 1.6 : 1) * (i === 0 ? 1 : 0.7);
      // each contact excites the modes differently depending on how the case lands
      s.modal({ t, gain: amp * 0.45, pan, modes: ratios.map((k, j) => ({ f: base * k * rr(r, 0.995, 1.005), tau: rr(r, 0.015, 0.045) * ring / (1 + j * 0.25), a: rr(r, 0.1, 1) })) });
      if (surf === 'metal') s.modal({ t, gain: amp * 0.18, pan, modes: [{ f: rr(r, 700, 1100), tau: 0.08, a: 1 }, { f: rr(r, 1700, 2300), tau: 0.05, a: 0.6 }] });
    }
    t += interval; interval *= rr(r, 0.55, 0.7); amp *= rr(r, 0.45, 0.65);
  }
  // final roll: fast tiny chatter
  if (surf !== 'soft') {
    const n = Math.round(rr(r, 4, 9));
    for (let i = 0; i < n; i++) {
      const tt = t + i * rr(r, 0.012, 0.03);
      s.modal({ t: tt, gain: amp * 0.25 * rr(r, 0.3, 1), modes: ratios.slice(0, 3).map((k) => ({ f: base * k, tau: 0.015, a: rr(r, 0.3, 1) })) });
    }
  }
}

// ---------------- bullet impacts ----------------

function grit(s: Synth, count: number, t0: number, t1: number, k: number, fLo: number, fHi: number, gain: number) {
  const r = s.rng;
  s.scatter(count, t0, t1, k, (t, _i, u) => {
    s.noiseL({ t, tau: rr(r, 0.0008, 0.003), gain: gain * (1 - u * 0.8) * rr(r, 0.3, 1), f: [['bp', rr(r, fLo, fHi), 1.5]] });
  });
}

export function impactConcrete(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0, width: 0.00015, gain: 0.9, f: [['hp', 1200]] });
  s.noiseL({ t: 0, tau: jit(r, 0.005, 0.2), gain: 1.0, f: [['hp', jit(r, 1600, 0.2)], ['pk', jit(r, 3500, 0.2), 1, 5]] });
  s.noiseL({ t: 0, a: 0.001, tau: jit(r, 0.02, 0.2), gain: 0.8, color: 'pink', f: [['bp', jit(r, 420, 0.2), 0.9]], drive: 1.5 });
  s.toneL({ t: 0, f0: jit(r, 220, 0.1), f1: 90, sweep: 0.01, a: 0.0008, tau: 0.018, gain: 0.5 });
  grit(s, Math.round(rr(r, 14, 26)), 0.004, 0.35, 12, 1800, 7000, 0.5);
  s.noiseL({ t: 0.004, a: 0.015, tau: jit(r, 0.08, 0.2), gain: 0.14, color: 'white', f: [['hp', 2200], ['lp', 9000]] }); // dust hiss
}

export function impactMetal(s: Synth) {
  const r = s.rng;
  const f = rr(r, 1250, 2300);
  s.impulse({ t: 0, width: 0.0001, gain: 0.9, f: [['hp', 2000]] });
  s.noiseL({ t: 0, tau: 0.003, gain: 0.8, f: [['hp', 2500]] });
  // plate-like inharmonic ping
  s.modal({ t: 0, gain: 0.5, modes: [
    { f, tau: rr(r, 0.12, 0.25), a: 1 }, { f: f * jit(r, 2.32, 0.03), tau: rr(r, 0.08, 0.18), a: 0.7 },
    { f: f * jit(r, 3.87, 0.03), tau: rr(r, 0.05, 0.12), a: 0.5 }, { f: f * jit(r, 5.1, 0.03), tau: 0.05, a: 0.35 },
    { f: f * jit(r, 0.47, 0.05), tau: 0.09, a: 0.45 },
  ] });
  // body clang
  s.modal({ t: 0, gain: 0.35, modes: [{ f: rr(r, 380, 620), tau: 0.08, a: 1 }, { f: rr(r, 850, 1100), tau: 0.06, a: 0.6 }] });
  s.noiseL({ t: 0, a: 0.001, tau: 0.015, gain: 0.4, color: 'pink', f: [['bp', 700, 1]] });
  grit(s, 6, 0.005, 0.1, 20, 4000, 9000, 0.25);
}

export function ricochet(s: Synth) {
  const r = s.rng;
  const f0 = rr(r, 2600, 3800), f1 = rr(r, 900, 1500), dur = rr(r, 0.3, 0.5);
  s.toneL({ t: 0.01, f0, f1, sweep: dur * 0.6, a: 0.015, hold: dur * 0.3, tau: dur * 0.3, gain: 0.3, vib: [0.01, rr(r, 25, 45)] });
  s.noiseL({ t: 0.01, a: 0.02, hold: dur * 0.3, tau: dur * 0.3, gain: 0.35, f: [['bp', f0, 6, undefined, { to: f1, tau: dur * 0.6 }]] });
}

export function impactWood(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0, width: 0.0002, gain: 0.7, f: [['hp', 800]] });
  s.noiseL({ t: 0, tau: 0.006, gain: 0.7, f: [['bp', jit(r, 2200, 0.2), 0.9]] });
  s.modal({ t: 0, gain: 0.8, modes: [
    { f: rr(r, 170, 240), tau: rr(r, 0.018, 0.028), a: 1 }, { f: rr(r, 330, 450), tau: 0.02, a: 0.8 }, { f: rr(r, 620, 800), tau: 0.015, a: 0.5 }, { f: rr(r, 1100, 1400), tau: 0.01, a: 0.35 },
  ] });
  s.noiseL({ t: 0, a: 0.001, tau: 0.03, gain: 0.5, color: 'brown', f: [['lp', 500]] });
  grit(s, Math.round(rr(r, 8, 16)), 0.003, 0.15, 20, 1200, 4500, 0.35); // splinters
}

export function impactDirt(s: Synth, sand = false) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.0005, tau: 0.004, gain: 0.5, f: [['bp', 2400, 0.8]] });
  s.noiseL({ t: 0, a: 0.001, tau: jit(r, 0.03, 0.2), gain: 1.0, color: 'brown', f: [['lp', jit(r, 420, 0.2)]], drive: 1.5 });
  s.noiseL({ t: 0.002, a: 0.006, tau: jit(r, sand ? 0.1 : 0.07, 0.2), gain: 0.4, color: 'pink', f: [['bp', sand ? 2600 : 1400, 0.6], ['lp', 6000]] }); // spray
  s.scatter(Math.round(rr(r, 20, 35)), 0.02, 0.45, 6, (t, _i, u) => {
    s.noiseL({ t, tau: rr(r, 0.001, 0.004), gain: 0.25 * (1 - u * 0.7) * rr(r, 0.3, 1), color: 'pink', f: [['bp', rr(r, 800, sand ? 5000 : 3000), 1.2]] });
  });
}

export function impactGlass(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0, width: 0.0001, gain: 1, f: [['hp', 2500]] });
  s.noiseL({ t: 0, tau: 0.012, gain: 0.9, f: [['hp', 3500]] });
  s.noiseL({ t: 0, a: 0.001, tau: 0.02, gain: 0.4, color: 'pink', f: [['bp', 900, 0.8]] });
  // shards: bright random modal tinkles, dense at first then sparse
  s.scatter(Math.round(rr(r, 45, 70)), 0.004, 1.1, 4, (t, _i, u) => {
    const f = rr(r, 2500, 9500);
    s.modal({ t, gain: 0.22 * (1 - u * 0.6) * rr(r, 0.3, 1), pan: 0, modes: [
      { f, tau: rr(r, 0.015, 0.09), a: 1 }, { f: f * rr(r, 1.4, 2.7), tau: rr(r, 0.01, 0.05), a: rr(r, 0.2, 0.7) },
    ] });
  });
  s.scatter(6, 0.1, 0.8, 3, (t) => { // larger chunks hitting the ground
    s.modal({ t, gain: 0.2, modes: [{ f: rr(r, 1400, 2600), tau: 0.05, a: 1 }, { f: rr(r, 3200, 4800), tau: 0.03, a: 0.6 }] });
    s.noiseL({ t, tau: 0.003, gain: 0.25, f: [['hp', 2000]] });
  });
}

export function impactFlesh(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.0015, tau: jit(r, 0.035, 0.2), gain: 1.0, color: 'brown', f: [['lp', jit(r, 280, 0.2)]], drive: 2 });
  s.toneL({ t: 0, f0: jit(r, 150, 0.1), f1: 60, sweep: 0.02, a: 0.002, tau: 0.035, gain: 0.7, drive: 1.5 });
  s.noiseL({ t: 0, a: 0.0008, tau: jit(r, 0.01, 0.2), gain: 0.6, color: 'pink', f: [['bp', jit(r, 1100, 0.2), 1.3]] }); // smack
  s.noiseL({ t: 0.004, a: 0.004, tau: 0.045, gain: 0.3, color: 'pink', f: [['bp', 700, 2, undefined, { to: 320, tau: 0.04 }]] }); // wet
  s.noiseL({ t: 0, tau: 0.006, gain: 0.25, f: [['hp', 2500]] }); // cloth/gear tick
}

export function impactWater(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.002, tau: 0.06, gain: 0.8, color: 'pink', f: [['bp', 1100, 0.7, undefined, { to: 2600, tau: 0.05 }]] });
  s.noiseL({ t: 0, a: 0.001, tau: 0.02, gain: 0.5, color: 'brown', f: [['lp', 300]] });
  s.scatter(Math.round(rr(r, 10, 18)), 0.02, 0.5, 5, (t) => { // droplets/bubbles: short upward chirps
    const f = rr(r, 700, 2400);
    s.toneL({ t, f0: f, f1: f * 1.8, sweep: 0.008, a: 0.001, tau: 0.01, gain: 0.12 * rr(r, 0.3, 1) });
  });
}

// ---------------- enemy near-miss ----------------

/** Supersonic near miss: sharp N-wave snap + band-swept "zip" of the passing round. */
export function whizBy(s: Synth) {
  const r = s.rng;
  // supersonic snap: N-wave + bright burst + a tiny slap from nearby surfaces
  s.impulse({ t: 0.002, width: jit(r, 0.00028, 0.2), gain: 1.2, f: [['hp', 900, 0.6]] });
  s.noiseL({ t: 0.002, tau: 0.004, gain: 1.1, f: [['hp', 1800], ['pk', 4000, 1, 4]] });
  s.noiseL({ t: 0.002, a: 0.0008, tau: 0.012, gain: 0.45, f: [['bp', 1200, 0.8]] });
  s.noiseL({ t: rr(r, 0.012, 0.025), tau: 0.012, gain: 0.25, color: 'pink', f: [['bp', 1500, 0.7], ['lp', 5000]] });
  // "zip" of the passing round, falling pitch (doppler)
  const f0 = rr(r, 3800, 5500), f1 = rr(r, 900, 1500);
  s.noiseL({ t: 0.0, a: rr(r, 0.008, 0.016), tau: rr(r, 0.04, 0.06), gain: 0.9, color: 'white', f: [['bp', f0, 2.2, undefined, { to: f1, tau: 0.05 }]] });
  s.noiseL({ t: 0.004, a: 0.01, tau: 0.05, gain: 0.3, color: 'pink', f: [['lp', 900], ['hp', 150]] }); // air push
  s.toneL({ t: 0.002, f0: f0 * 0.5, f1: f1 * 0.5, sweep: 0.05, a: 0.015, tau: 0.04, gain: 0.06 });
}

// ---------------- explosions ----------------

export function explosion(s: Synth) {
  const r = s.rng;
  const d = s.gainNode(1);
  d.connect(s.shaper(1.4)).connect(s.bq(['hp', 24, 0.6])).connect(s.out);
  // shock front: long N-wave + broadband crack
  s.impulse({ t: 0, width: 0.0012, gain: 1.2, f: [['hp', 120, 0.6]], dest: d });
  s.noiseL({ t: 0, tau: jit(r, 0.018, 0.2), gain: 1.3, f: [['hp', 350]], drive: 1.5, dest: d });
  // "whump": saturated low-mid blast
  s.noiseL({ t: 0, a: 0.002, tau: jit(r, 0.11, 0.2), gain: 1.4, color: 'white', f: [['bp', jit(r, 180, 0.2), 0.8], ['lp', 1200]], drive: 2.5, dest: d });
  // chest thump (short sine, no tonal ringing)
  s.toneL({ t: 0, f0: jit(r, 95, 0.1), f1: jit(r, 38, 0.1), sweep: 0.06, a: 0.003, tau: jit(r, 0.12, 0.15), gain: 1.0, drive: 1.6, dest: d });
  // noisy low rumble body + long rolling tail
  s.noiseL({ t: 0.003, a: 0.015, tau: jit(r, 0.42, 0.2), gain: 0.9, color: 'brown', f: [['lp', 220]], drive: 1.6, dest: d });
  s.noiseL({ t: 0, a: 0.004, tau: jit(r, 0.25, 0.2), gain: 0.6, color: 'pink', f: [['bp', jit(r, 550, 0.2), 0.6], ['lp', 3000, 0.7, undefined, { to: 500, tau: 0.3 }]], drive: 1.5, dest: d });
  s.noiseL({ t: 0, a: 0.001, tau: 0.07, gain: 0.45, color: 'white', f: [['hp', 1800]], dest: d });
  s.noiseL({ t: 0.2, a: 0.35, tau: 0.75, gain: 0.35, color: 'brown', f: [['lp', 140]], dest: d });
  // debris: clods, stones, metal bits, sand rain
  s.scatter(Math.round(rr(r, 60, 90)), 0.12, 2.6, 1.5, (t, _i, u) => {
    const kind = r();
    const g = 0.22 * (1 - u * 0.7) * rr(r, 0.3, 1);
    if (kind < 0.45) s.noiseL({ t, a: 0.001, tau: rr(r, 0.01, 0.03), gain: g * 1.2, color: 'brown', f: [['lp', rr(r, 400, 900)]], dest: d });
    else if (kind < 0.85) s.noiseL({ t, tau: rr(r, 0.002, 0.006), gain: g, f: [['bp', rr(r, 1200, 4500), 1.3]], dest: d });
    else s.modal({ t, gain: g * 0.6, dest: d, modes: [{ f: rr(r, 1800, 5000), tau: rr(r, 0.03, 0.08), a: 1 }, { f: rr(r, 5000, 8000), tau: 0.02, a: 0.5 }] });
  });
  s.noiseL({ t: 0.35, a: 0.4, tau: 0.6, gain: 0.08, color: 'pink', f: [['bp', 2200, 0.5]], dest: d });
}

export function explosionFar(s: Synth) {
  const r = s.rng;
  const d = s.gainNode(1);
  d.connect(s.shaper(1.3)).connect(s.bq(['hp', 22, 0.6])).connect(s.out);
  s.toneL({ t: 0, f0: jit(r, 70, 0.1), f1: 32, sweep: 0.08, a: 0.01, tau: 0.16, gain: 0.8, drive: 1.5, dest: d });
  s.noiseL({ t: 0, a: 0.004, tau: 0.12, gain: 1.1, color: 'white', f: [['bp', 140, 0.8], ['lp', 600]], drive: 2, dest: d });
  s.noiseL({ t: 0, a: 0.03, tau: 0.6, gain: 0.8, color: 'brown', f: [['lp', 160]], drive: 1.5, dest: d });
  s.noiseL({ t: 0, a: 0.006, tau: 0.12, gain: 0.35, color: 'pink', f: [['bp', 350, 0.7], ['lp', 900]], dest: d });
  let t = rr(r, 0.25, 0.45);
  for (let i = 0; i < 5; i++) { s.noiseL({ t, a: 0.03, tau: 0.25 + i * 0.1, gain: 0.35 * Math.pow(0.7, i), color: 'brown', f: [['lp', 220]], dest: d }); t += rr(r, 0.3, 0.6); }
}

// ---------------- footsteps & movement ----------------

export type StepSurf = 'concrete' | 'dirt' | 'gravel' | 'metal' | 'wood' | 'water';

export function footstep(s: Synth, surf: StepSurf) {
  const r = s.rng;
  const heel = 0.003, toe = heel + rr(r, 0.035, 0.065);
  const toeK = rr(r, 0.4, 0.65);
  for (const [t, k] of [[heel, 1], [toe, toeK]] as const) {
    s.noiseL({ t, a: 0.002, tau: jit(r, 0.02, 0.2), gain: 0.6 * k, color: 'brown', f: [['lp', jit(r, 200, 0.2)]] }); // weight thud
    switch (surf) {
      case 'concrete':
        s.noiseL({ t, a: 0.0015, tau: jit(r, 0.012, 0.25), gain: 0.4 * k, color: 'white', f: [['bp', jit(r, 2800, 0.25), 0.8]] });
        s.impulse({ t, width: 0.0001, gain: 0.25 * k, shape: 'click', f: [['hp', 2000]] });
        grit(s, Math.round(rr(r, 2, 6)), t + 0.004, t + 0.05, 30, 4000, 9000, 0.15 * k);
        break;
      case 'dirt':
        s.noiseL({ t, a: 0.004, tau: jit(r, 0.035, 0.25), gain: 0.35 * k, color: 'pink', f: [['bp', jit(r, 1200, 0.25), 0.7]] });
        s.scatter(Math.round(rr(r, 8, 16)), t, t + 0.08, 20, (tt) => s.noiseL({ t: tt, tau: rr(r, 0.001, 0.003), gain: 0.18 * k * rr(r, 0.3, 1), color: 'pink', f: [['bp', rr(r, 700, 2800), 1.2]] }));
        break;
      case 'gravel':
        s.noiseL({ t, a: 0.004, tau: jit(r, 0.05, 0.25), gain: 0.3 * k, color: 'pink', f: [['bp', jit(r, 2200, 0.2), 0.7]] });
        s.scatter(Math.round(rr(r, 30, 55)), t, t + 0.13, 14, (tt) => s.noiseL({ t: tt, tau: rr(r, 0.0008, 0.0025), gain: 0.28 * k * rr(r, 0.2, 1), f: [['bp', rr(r, 1500, 6500), 1.4]] }));
        break;
      case 'metal': {
        const f = rr(r, 190, 320);
        s.modal({ t, gain: 0.3 * k, modes: [{ f, tau: rr(r, 0.04, 0.06), a: 1 }, { f: f * 1.71, tau: 0.045, a: 0.7 }, { f: f * 2.93, tau: 0.035, a: 0.5 }, { f: f * 4.3, tau: 0.025, a: 0.35 }, { f: f * 6.1, tau: 0.018, a: 0.25 }] });
        s.impulse({ t, width: 0.0001, gain: 0.3 * k, shape: 'click', f: [['hp', 2500]] });
        s.noiseL({ t, tau: 0.008, gain: 0.25 * k, f: [['bp', 3000, 0.8]] });
        break;
      }
      case 'wood': {
        const f = rr(r, 120, 180);
        s.modal({ t, gain: 0.5 * k, modes: [{ f, tau: 0.025, a: 1 }, { f: f * 2.1, tau: 0.02, a: 0.6 }, { f: f * 3.4, tau: 0.012, a: 0.4 }] });
        s.noiseL({ t, a: 0.001, tau: 0.01, gain: 0.3 * k, color: 'pink', f: [['bp', 1500, 0.9]] });
        if (r() < 0.4) s.noiseL({ t: t + 0.01, a: 0.03, tau: 0.05, gain: 0.08, f: [['bp', rr(r, 500, 800), 8, undefined, { to: rr(r, 700, 1000), tau: 0.05 }]] }); // creak
        break;
      }
      case 'water':
        s.noiseL({ t, a: 0.004, tau: 0.06, gain: 0.45 * k, color: 'pink', f: [['bp', 900, 0.7, undefined, { to: 2200, tau: 0.04 }]] });
        s.scatter(6, t + 0.01, t + 0.2, 8, (tt) => { const f = rr(r, 800, 2000); s.toneL({ t: tt, f0: f, f1: f * 1.7, sweep: 0.008, a: 0.001, tau: 0.008, gain: 0.06 }); });
        break;
    }
  }
}

export function gearRattle(s: Synth) {
  const r = s.rng;
  s.rustle(0, jit(r, 0.2, 0.2), 0.25, 1.1);
  s.scatter(Math.round(rr(r, 5, 11)), 0.01, 0.22, 6, (t) => {
    const f = rr(r, 1800, 5500);
    s.modal({ t, gain: rr(r, 0.06, 0.16), pan: rr(r, -0.4, 0.4), modes: [{ f, tau: rr(r, 0.008, 0.025), a: 1 }, { f: f * rr(r, 1.5, 2.6), tau: 0.008, a: 0.5 }] });
  });
  s.noiseL({ t: rr(r, 0.02, 0.08), a: 0.001, tau: 0.012, gain: 0.25, color: 'brown', f: [['lp', 350]] }); // pouch bump
}

export function jump(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.002, tau: 0.02, gain: 0.5, color: 'brown', f: [['lp', 220]] });
  s.noiseL({ t: 0, a: 0.002, tau: 0.02, gain: 0.25, f: [['bp', 2400, 0.8]] });
  s.rustle(0.01, 0.25, 0.3);
  s.noiseL({ t: 0.02, a: 0.08, tau: 0.07, gain: 0.25, color: 'pink', f: [['lp', 900], ['hp', 120]] });
  gearBits(s, 0.02, 0.25, 6);
}

function gearBits(s: Synth, t0: number, t1: number, n: number, g = 0.12) {
  const r = s.rng;
  s.scatter(n, t0, t1, 5, (t) => {
    const f = rr(r, 1800, 5000);
    s.modal({ t, gain: rr(r, 0.4, 1) * g, modes: [{ f, tau: rr(r, 0.01, 0.03), a: 1 }, { f: f * rr(r, 1.6, 2.5), tau: 0.01, a: 0.5 }] });
  });
}

export function land(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.002, tau: jit(r, 0.05, 0.2), gain: 1, color: 'brown', f: [['lp', 170]], drive: 1.8 });
  s.toneL({ t: 0, f0: jit(r, 95, 0.1), f1: 48, sweep: 0.03, a: 0.002, tau: 0.06, gain: 0.7, drive: 1.5 });
  s.noiseL({ t: 0, a: 0.002, tau: 0.02, gain: 0.3, color: 'pink', f: [['bp', 1800, 0.8]] });
  s.rustle(0, 0.2, 0.3);
  gearBits(s, 0.005, 0.2, 9, 0.16);
}

export function slide(s: Synth) {
  const r = s.rng;
  const dur = jit(r, 0.75, 0.1);
  s.noiseL({ t: 0, a: 0.04, hold: dur * 0.5, tau: dur * 0.25, gain: 0.45, color: 'pink', f: [['bp', jit(r, 1300, 0.15), 0.6, undefined, { to: 800, tau: dur }], ['hp', 250]] });
  s.noiseL({ t: 0, a: 0.03, hold: dur * 0.5, tau: dur * 0.25, gain: 0.5, color: 'brown', f: [['lp', 280]] });
  s.scatter(Math.round(dur * 90), 0.02, dur, 1.5, (t, _i, u) => s.noiseL({ t, tau: rr(r, 0.001, 0.003), gain: 0.22 * (1 - u * 0.6) * rr(r, 0.2, 1), f: [['bp', rr(r, 1200, 6000), 1.3]] }));
  s.rustle(0, dur * 0.8, 0.22);
  gearBits(s, 0.0, 0.3, 6);
}

export function bodyFall(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.003, tau: jit(r, 0.06, 0.2), gain: 1, color: 'brown', f: [['lp', 200]], drive: 1.8 });
  s.noiseL({ t: 0, a: 0.002, tau: 0.03, gain: 0.35, color: 'pink', f: [['bp', 900, 0.8]] });
  const t2 = rr(r, 0.12, 0.22);
  s.noiseL({ t: t2, a: 0.003, tau: 0.05, gain: 0.6, color: 'brown', f: [['lp', 240]], drive: 1.5 });
  s.rustle(0, 0.35, 0.25);
  // weapon clatter
  const tc = rr(r, 0.08, 0.25);
  s.modal({ t: tc, gain: 0.25, modes: [{ f: rr(r, 700, 1000), tau: 0.05, a: 1 }, { f: rr(r, 1600, 2200), tau: 0.04, a: 0.8 }, { f: rr(r, 3000, 4200), tau: 0.025, a: 0.5 }] });
  s.noiseL({ t: tc, tau: 0.004, gain: 0.3, f: [['hp', 2000]] });
  s.modal({ t: tc + rr(r, 0.08, 0.14), gain: 0.12, modes: [{ f: rr(r, 800, 1100), tau: 0.04, a: 1 }, { f: rr(r, 2000, 2600), tau: 0.03, a: 0.6 }] });
}

export function grenadeBounce(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.001, tau: 0.018, gain: 0.8, color: 'brown', f: [['lp', 400]] });
  s.modal({ t: 0, gain: 0.45, modes: [{ f: rr(r, 650, 900), tau: 0.05, a: 1 }, { f: rr(r, 1500, 1900), tau: 0.04, a: 0.7 }, { f: rr(r, 2900, 3600), tau: 0.025, a: 0.5 }] });
  s.noiseL({ t: 0, tau: 0.004, gain: 0.35, f: [['hp', 2000]] });
}

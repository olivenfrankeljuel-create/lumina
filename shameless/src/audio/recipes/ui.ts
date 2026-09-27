import type { Synth } from '../synth';
import { rr, jit, type Rng } from '../rng';

// ---------------- HUD feedback ----------------

/** The CoD hitmarker "tick": a crisp, dry, slightly crunchy high click with a short metallic body. */
export function hitmarker(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0.001, width: 0.00008, gain: 0.7, shape: 'click', f: [['hp', 1500]] });
  s.noiseL({ t: 0.001, tau: jit(r, 0.0045, 0.15), gain: 0.9, f: [['bp', jit(r, 4200, 0.08), 1.1], ['hp', 1800]] });
  s.modal({ t: 0.001, gain: 0.4, modes: [
    { f: jit(r, 1850, 0.03), tau: 0.011, a: 1 }, { f: jit(r, 3150, 0.03), tau: 0.009, a: 0.8 }, { f: jit(r, 4800, 0.03), tau: 0.006, a: 0.6 }, { f: jit(r, 6900, 0.03), tau: 0.004, a: 0.4 },
  ] });
  s.toneL({ t: 0.001, f0: 520, f1: 380, sweep: 0.01, a: 0.0005, tau: 0.007, gain: 0.18 });
}

/** Kill confirm: heavier double-tick with a low punch (the red-X hitmarker). */
export function killConfirm(s: Synth) {
  const r = s.rng;
  hitmarker(s);
  s.toneL({ t: 0.001, f0: jit(r, 170, 0.05), f1: 80, sweep: 0.012, a: 0.001, tau: 0.02, gain: 0.8, drive: 1.5 });
  s.noiseL({ t: 0.001, a: 0.001, tau: 0.02, gain: 0.5, color: 'brown', f: [['lp', 350]] });
  const t2 = jit(r, 0.045, 0.1);
  s.noiseL({ t: t2, tau: 0.006, gain: 0.55, f: [['bp', 3000, 1], ['hp', 1500]] });
  s.modal({ t: t2, gain: 0.35, modes: [{ f: jit(r, 1500, 0.03), tau: 0.02, a: 1 }, { f: jit(r, 2550, 0.03), tau: 0.015, a: 0.7 }, { f: jit(r, 3900, 0.03), tau: 0.01, a: 0.5 }] });
  s.noiseL({ t: t2, a: 0.001, tau: 0.02, gain: 0.25, color: 'pink', f: [['bp', 900, 1]] });
}

/** Headshot: helmet "tink" + crunch. */
export function headshot(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0.001, width: 0.00008, gain: 0.7, shape: 'click', f: [['hp', 2000]] });
  const f = rr(r, 2300, 2700);
  s.modal({ t: 0.001, gain: 0.45, modes: [
    { f, tau: rr(r, 0.045, 0.06), a: 1 }, { f: f * 1.63, tau: 0.04, a: 0.6 }, { f: f * 2.41, tau: 0.03, a: 0.5 }, { f: f * 3.3, tau: 0.02, a: 0.35 },
  ] });
  s.noiseL({ t: 0.001, a: 0.0008, tau: 0.02, gain: 0.8, color: 'pink', f: [['bp', 1400, 1]], drive: 2 }); // crunch
  s.noiseL({ t: 0.012, a: 0.0008, tau: 0.012, gain: 0.35, color: 'white', f: [['bp', 2600, 1.2]] }); // bone crack
  s.noiseL({ t: 0.001, tau: 0.004, gain: 0.5, f: [['hp', 3000]] });
  s.toneL({ t: 0.001, f0: 200, f1: 90, sweep: 0.015, a: 0.001, tau: 0.03, gain: 0.45 });
}

export function uiClick(s: Synth) {
  const r = s.rng;
  s.impulse({ t: 0.001, width: 0.00006, gain: 0.35, shape: 'click', f: [['hp', 2500]] });
  s.toneL({ t: 0.001, f0: jit(r, 1400, 0.04), f1: 1150, sweep: 0.01, a: 0.0006, tau: 0.006, gain: 0.5 });
  s.toneL({ t: 0.001, f0: jit(r, 2800, 0.04), a: 0.0006, tau: 0.006, gain: 0.2 });
}

export function uiHover(s: Synth) {
  s.toneL({ t: 0.001, f0: 2100, f1: 2300, sweep: 0.01, a: 0.002, tau: 0.01, gain: 0.3 });
}

// ---------------- player body ----------------

export function hurtHit(s: Synth) {
  const r = s.rng;
  s.noiseL({ t: 0, a: 0.002, tau: jit(r, 0.06, 0.2), gain: 1, color: 'brown', f: [['lp', 170]], drive: 2.2 });
  s.toneL({ t: 0, f0: jit(r, 85, 0.1), f1: 42, sweep: 0.03, a: 0.002, tau: 0.06, gain: 0.8, drive: 1.6 });
  s.noiseL({ t: 0, a: 0.001, tau: 0.02, gain: 0.4, color: 'pink', f: [['bp', 700, 0.8], ['lp', 1500]] });
  s.noiseL({ t: 0.005, a: 0.02, tau: 0.08, gain: 0.25, color: 'pink2', f: [['lp', 900], ['hp', 100]] }); // body shake cloth
}

export function heartbeat(s: Synth) {
  const r = s.rng;
  const beat = (t: number, f: number, g: number) => {
    s.toneL({ t, f0: f * 1.3, f1: f, sweep: 0.02, a: 0.008, tau: 0.045, gain: g, drive: 1.5 });
    s.noiseL({ t, a: 0.006, tau: 0.03, gain: g * 0.5, color: 'brown', f: [['lp', 110]] });
  };
  beat(0.005, jit(r, 52, 0.05), 1);
  beat(jit(r, 0.2, 0.08), jit(r, 60, 0.05), 0.65);
}

function breath(s: Synth, inhale: boolean) {
  const r = s.rng;
  const dur = inhale ? jit(r, 0.45, 0.15) : jit(r, 0.6, 0.15);
  const formants = inhale ? [[1300, 2], [2700, 3], [3800, 4]] : [[850, 2], [1700, 3], [2900, 4]];
  const bus = s.gainNode(1);
  bus.connect(s.bq(['hp', 400])).connect(s.bq(['lp', inhale ? 7000 : 5000])).connect(s.out);
  for (const [f, q] of formants) {
    s.noiseL({ t: 0.01, a: inhale ? dur * 0.7 : dur * 0.15, hold: inhale ? dur * 0.15 : dur * 0.35, tau: dur * 0.2, gain: 0.5 / q * 2, color: 'pink', f: [['bp', jit(r, f, 0.06), q]], dest: bus });
  }
  s.noiseL({ t: 0.01, a: dur * 0.5, hold: dur * 0.2, tau: dur * 0.2, gain: 0.1, color: 'white', f: [['hp', 4000]], dest: bus });
}
export const breathIn = (s: Synth) => breath(s, true);
export const breathOut = (s: Synth) => breath(s, false);

// ---------------- ambience ----------------

/** Smooth random control curve in [0,1] built from a few slow sines. */
function smoothCurve(r: Rng, n: number, seconds: number, rates: number[]): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const comps = rates.map((hz) => ({ hz: hz * rr(r, 0.8, 1.25), ph: r() * Math.PI * 2, a: rr(r, 0.5, 1) }));
  const sum = comps.reduce((a, b) => a + b.a, 0);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * seconds;
    let v = 0; for (const k of comps) v += k.a * Math.sin(t * k.hz * Math.PI * 2 + k.ph);
    c[i] = 0.5 + 0.5 * (v / sum);
  }
  return c;
}

export function ambWind(s: Synth) {
  const r = s.rng, T = s.dur;
  const n = Math.ceil(T * 50);
  const layer = (color: 'brown2' | 'pink2' | 'white2', filters: [BiquadFilterType, number, number][], gainLo: number, gainHi: number, rates: number[], fMod?: [number, number]) => {
    const src = s.ctx.createBufferSource();
    src.buffer = s.noiseBuf[color]; src.loop = true;
    const nodes: AudioNode[] = [src];
    const bqs = filters.map(([type, f, q]) => { const b = s.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; nodes.push(b); return b; });
    const g = s.ctx.createGain(); nodes.push(g);
    const curve = smoothCurve(r, n, T, rates);
    const gc = new Float32Array(n); for (let i = 0; i < n; i++) gc[i] = gainLo + (gainHi - gainLo) * curve[i] ** 1.5;
    g.gain.setValueCurveAtTime(gc, 0, T);
    if (fMod) { const fc = new Float32Array(n); for (let i = 0; i < n; i++) fc[i] = fMod[0] + (fMod[1] - fMod[0]) * curve[i]; bqs[0].frequency.setValueCurveAtTime(fc, 0, T); }
    s.chain(...nodes).connect(s.out);
    src.start(0, r() * 3); src.stop(T);
  };
  layer('brown2', [['lowpass', 220, 0.7]], 0.25, 0.9, [0.05, 0.11, 0.23]);
  layer('pink2', [['bandpass', 600, 0.6], ['highpass', 180, 0.7]], 0.05, 0.35, [0.07, 0.13, 0.31], [380, 900]);
  layer('white2', [['bandpass', 1200, 9]], 0.0, 0.05, [0.04, 0.09, 0.2], [900, 1700]); // faint whistle through gaps
}

export function ambTown(s: Synth) {
  const r = s.rng, T = s.dur;
  // distant traffic / generators
  s.noiseL({ t: 0, a: 1, hold: T, tau: 1, gain: 0.55, color: 'brown2', f: [['lp', 160], ['hp', 35]] });
  s.noiseL({ t: 0, a: 1, hold: T, tau: 1, gain: 0.08, color: 'pink2', f: [['bp', 450, 0.5], ['lp', 1200]] });
  s.toneL({ t: 0, f0: 100, a: 2, hold: T, tau: 1, gain: 0.012 }); // far generator hum
  s.toneL({ t: 0, f0: 150.3, a: 2, hold: T, tau: 1, gain: 0.006 });
  // distant metal clanks with echo
  for (let i = 0; i < 5; i++) {
    const t = rr(r, 1, T - 3);
    const f = rr(r, 400, 900);
    for (let e = 0; e < 3; e++) s.modal({ t: t + e * rr(r, 0.18, 0.3), gain: 0.05 * Math.pow(0.45, e), pan: rr(r, -0.9, 0.9), f: [['lp', 1400]], modes: [{ f, tau: 0.12, a: 1 }, { f: f * 2.2, tau: 0.08, a: 0.6 }, { f: f * 3.1, tau: 0.05, a: 0.3 }] });
  }
  // a few distant birds
  for (let i = 0; i < 4; i++) {
    let t = rr(r, 1, T - 3); const pan = rr(r, -0.9, 0.9); const f = rr(r, 2800, 4200);
    const n = Math.round(rr(r, 2, 5));
    for (let k = 0; k < n; k++) { s.toneL({ t, f0: f, f1: f * rr(r, 1.1, 1.35), sweep: 0.03, a: 0.01, hold: 0.04, tau: 0.02, gain: 0.012, pan }); t += rr(r, 0.12, 0.2); }
  }
}

export function dogBark(s: Synth) {
  const r = s.rng;
  const bus = s.gainNode(1);
  bus.connect(s.bq(['hp', 250])).connect(s.bq(['lp', 3500])).connect(s.out);
  const barks = Math.round(rr(r, 2, 3));
  let t = 0.02;
  for (let i = 0; i < barks; i++) {
    const f0 = rr(r, 380, 520);
    const src = s.ctx.createOscillator(); src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * 0.8, t);
    src.frequency.linearRampToValueAtTime(f0 * 1.35, t + 0.03);
    src.frequency.linearRampToValueAtTime(f0 * 0.75, t + 0.14);
    const e = s.env(t, 1, 0.008, 0.05, 0.035);
    const mix = s.gainNode(1);
    for (const [f, q, g] of [[850, 4, 1], [1800, 5, 0.6], [2900, 6, 0.3]]) { const b = s.bq(['bp', jit(r, f, 0.05), q]); const gg = s.gainNode(g); src.connect(b).connect(gg).connect(mix); }
    mix.connect(e.node).connect(bus);
    src.start(t); src.stop(Math.min(s.dur, e.end));
    s.noiseL({ t, a: 0.008, hold: 0.04, tau: 0.03, gain: 0.25, color: 'pink', f: [['bp', 1400, 1.5]], dest: bus });
    t += rr(r, 0.28, 0.45);
  }
}

/**
 * Distant loudspeaker-like vocal drone: slow melismatic line (hijaz-flavoured scale) through vowel formants,
 * band-limited like a far PA horn. Played very quietly, far away, with heavy reverb.
 */
export function ambDrone(s: Synth) {
  const r = s.rng, T = s.dur;
  const root = rr(r, 196, 220);
  const scale = [0, 1.1, 4, 5, 7]; // semitones: 1, b2, 3, 4, 5
  const n = Math.ceil(T * 100);
  const curve = new Float32Array(n);
  // build a phrase: held notes with smooth ornamental glides
  const notes: { t: number; st: number }[] = [];
  let t = 0; let deg = 0;
  while (t < T) { notes.push({ t, st: scale[deg] }); t += rr(r, 0.5, 1.4); deg = Math.max(0, Math.min(scale.length - 1, deg + (r() < 0.55 ? 1 : -1))); }
  for (let i = 0; i < n; i++) {
    const tt = (i / (n - 1)) * T;
    let k = 0; while (k < notes.length - 1 && notes[k + 1].t <= tt) k++;
    const a = notes[k], b = notes[Math.min(k + 1, notes.length - 1)];
    const span = Math.max(0.01, b.t - a.t);
    const u = Math.min(1, Math.max(0, ((tt - a.t) / span - 0.75) / 0.25));
    const st = a.st + (b.st - a.st) * (u * u * (3 - 2 * u));
    curve[i] = root * Math.pow(2, st / 12) * (1 + 0.006 * Math.sin(tt * 2 * Math.PI * 5.2));
  }
  const o = s.ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueCurveAtTime(curve, 0, T);
  const env = s.ctx.createGain();
  env.gain.setValueAtTime(0, 0); env.gain.linearRampToValueAtTime(1, 1.2); env.gain.setValueAtTime(1, T - 2.5); env.gain.linearRampToValueAtTime(0, T - 0.05);
  const mix = s.gainNode(1);
  for (const [f, q, g] of [[720, 6, 1], [1150, 7, 0.55], [2600, 9, 0.25]]) { const b = s.bq(['bp', f, q]); const gg = s.gainNode(g); o.connect(b).connect(gg).connect(mix); }
  mix.connect(env).connect(s.bq(['hp', 420])).connect(s.bq(['lp', 2800])).connect(s.shaper(1.8)).connect(s.out);
  o.start(0); o.stop(T);
}

export function ambClank(s: Synth) {
  const r = s.rng;
  const f = rr(r, 300, 700);
  for (let e = 0; e < 4; e++) {
    s.modal({ t: 0.01 + e * rr(r, 0.2, 0.35), gain: 0.6 * Math.pow(0.4, e), f: [['lp', 1800 / (1 + e)]], modes: [{ f, tau: 0.15, a: 1 }, { f: f * 2.4, tau: 0.09, a: 0.6 }, { f: f * 3.3, tau: 0.05, a: 0.4 }] });
    s.noiseL({ t: 0.01 + e * 0.25, tau: 0.01, gain: 0.3 * Math.pow(0.4, e), color: 'brown', f: [['lp', 500]] });
  }
}

import type { BusName, SoundProps } from './bank';
import { dbToGain, mulberry32, type Rng } from './rng';
import { indoorIR, outdoorIR } from './reverb';

export interface Vec3 { x: number; y: number; z: number }

export interface PlayOpts {
  /** Absolute context time; default = now. */
  when?: number;
  /** Extra linear gain. */
  gain?: number;
  /** Playback-rate multiplier (before jitter). */
  rate?: number;
  variant?: number;
  /** World position → HRTF-spatialized with distance attenuation, air absorption and propagation delay. */
  pos?: Vec3;
  /** Stereo pan for non-spatial sounds. */
  pan?: number;
  /** Extra low-pass cutoff (Hz). */
  lowpass?: number;
  /** Reverb send override (0..1). */
  send?: number;
  bus?: BusName;
  loop?: boolean;
  fadeIn?: number;
  /** Delay spatial sounds by distance / speed of sound. */
  propagate?: boolean;
  /** Sound path is blocked: muffled and quieter. */
  occluded?: boolean;
  /** Skip random pitch/gain/filter jitter. */
  exact?: boolean;
}

export interface Voice {
  name: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  nodes: AudioNode[];
  start: number;
  end: number;
  prio: number;
  done: boolean;
  /** Current nominal gain (for tail stealing / attenuation). */
  level: number;
}

const SPEED_OF_SOUND = 343;

/**
 * Mixer + voice manager. Works on any BaseAudioContext so the whole mix (buses, reverb, ducking,
 * master dynamics) can be rendered offline for measurement.
 *
 * voice: src → gain → [lowpass] → [tone eq] → HRTF panner | stereo panner → bus
 *                                  └→ send → reverb (outdoor/indoor convolvers crossfaded by `indoor`)
 * buses: weapons ─┐
 *        sfx → sfxDuck ─┼→ world → ringLP → healthLP → worldDuck → master → glue comp → limiter → clipper → out
 *        ambience → ambDuck ─┤
 *        hud ────────┘                           tinnitus ─┘
 *        ui ─────────────────────────────────────────────→ master
 */
export class AudioEngine {
  readonly master: GainNode;
  readonly buses: Record<BusName, GainNode>;
  readonly ambDuck: GainNode;
  /** Ambience is muffled and pulled down indoors. */
  readonly ambLP: BiquadFilterNode;
  private ambIndoor: GainNode;
  readonly sfxDuck: GainNode;
  readonly world: GainNode;
  readonly ringLP: BiquadFilterNode;
  readonly healthLP: BiquadFilterNode;
  readonly worldDuck: GainNode;
  readonly glue: DynamicsCompressorNode;
  readonly limiter: DynamicsCompressorNode;
  readonly revSend: GainNode;
  private revOutG: GainNode;
  private revInG: GainNode;
  readonly banks = new Map<string, AudioBuffer[]>();
  readonly props = new Map<string, SoundProps>();
  readonly voices: Voice[] = [];
  readonly listener: Vec3 = { x: 0, y: 0, z: 0 };
  maxVoices = 56;
  hrtf = true;
  indoor = 0;
  private lastVariant = new Map<string, number>();
  private rng: Rng;

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode = ctx.destination, seed = 1234, masterDynamics = true) {
    this.rng = mulberry32(seed);
    const c = ctx;
    const g = (v = 1) => { const n = c.createGain(); n.gain.value = v; return n; };

    // master dynamics: glue compressor → brickwall-ish limiter → soft clipper ceiling at -0.3 dBFS
    this.master = g(1);
    this.glue = c.createDynamicsCompressor();
    this.glue.threshold.value = -16; this.glue.knee.value = 8; this.glue.ratio.value = 3; this.glue.attack.value = 0.012; this.glue.release.value = 0.15;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -4; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.12;
    const clip = c.createWaveShaper();
    clip.curve = softClipCurve(0.78, 0.962);
    clip.oversample = 'none';
    if (masterDynamics) this.master.connect(this.glue).connect(this.limiter).connect(clip).connect(dest);
    else this.master.connect(dest);

    // world chain
    this.worldDuck = g(1);
    this.healthLP = c.createBiquadFilter(); this.healthLP.type = 'lowpass'; this.healthLP.frequency.value = 20000; this.healthLP.Q.value = -3;
    this.ringLP = c.createBiquadFilter(); this.ringLP.type = 'lowpass'; this.ringLP.frequency.value = 20000; this.ringLP.Q.value = -3;
    this.world = g(1);
    this.world.connect(this.ringLP).connect(this.healthLP).connect(this.worldDuck).connect(this.master);

    this.ambDuck = g(1);
    this.sfxDuck = g(1);
    this.buses = { weapons: g(0.7), sfx: g(0.6), ambience: g(0.26), hud: g(0.56), ui: g(0.5) };
    this.buses.weapons.connect(this.world);
    this.buses.sfx.connect(this.sfxDuck).connect(this.world);
    this.ambLP = c.createBiquadFilter(); this.ambLP.type = 'lowpass'; this.ambLP.frequency.value = 20000; this.ambLP.Q.value = -3;
    this.ambIndoor = g(1);
    this.buses.ambience.connect(this.ambDuck).connect(this.ambLP).connect(this.ambIndoor).connect(this.world);
    this.buses.hud.connect(this.world);
    this.buses.ui.connect(this.master);

    // reverb: high-passed send → two convolvers crossfaded by indoor factor
    this.revSend = g(1);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 160;
    this.revOutG = g(1); this.revInG = g(0);
    const convOut = c.createConvolver(); convOut.buffer = outdoorIR(c.sampleRate);
    const convIn = c.createConvolver(); convIn.buffer = indoorIR(c.sampleRate);
    const ret = g(0.55);
    this.revSend.connect(hp);
    hp.connect(this.revOutG).connect(convOut).connect(ret);
    hp.connect(this.revInG).connect(convIn).connect(ret);
    ret.connect(this.world);
  }

  get now() { return this.ctx.currentTime; }

  addSound(name: string, bufs: AudioBuffer[], props: SoundProps) { this.banks.set(name, bufs); this.props.set(name, props); }

  has(name: string) { return this.banks.has(name); }

  /** A suspended realtime context would queue sounds and blast them all on resume — drop them instead. */
  private isLive() {
    return !(typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state !== 'running');
  }

  distance(p: Vec3) { const dx = p.x - this.listener.x, dy = p.y - this.listener.y, dz = p.z - this.listener.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

  play(name: string, o: PlayOpts = {}): Voice | null {
    const bufs = this.banks.get(name);
    const pr = this.props.get(name);
    if (!bufs || !pr || !bufs.length) return null;
    if (!this.isLive()) return null;
    const c = this.ctx;
    const r = this.rng;
    let when = Math.max(c.currentTime, o.when ?? c.currentTime);
    let gain = dbToGain(pr.gainDb) * (o.gain ?? 1);
    let lowpass = o.lowpass ?? 22000;
    let send = o.send ?? pr.send;
    let dist = 0;

    if (o.pos) {
      dist = this.distance(o.pos);
      if (dist > pr.maxDist) return null;
      const att = dist <= pr.ref ? 1 : pr.ref / (pr.ref + pr.roll * (dist - pr.ref));
      gain *= att;
      // air absorption: progressively darker with distance
      lowpass = Math.min(lowpass, 20000 / (1 + dist / 45));
      // wet/dry: reverb falls off slower than the direct sound
      send *= Math.sqrt(att) * 1.2;
      if (o.occluded) { gain *= 0.45; lowpass = Math.min(lowpass, 1400 + 3000 / (1 + dist / 10)); send *= 1.3; }
      if (o.propagate) when += dist / SPEED_OF_SOUND;
    }
    if (gain < 0.0015) return null;

    // voice limiting: per sound, then global (liveness judged at the trigger time so offline scheduling behaves too)
    this.reap();
    const live = (v: Voice) => !v.done && v.end > when && v.start <= when + 0.001;
    const same = this.voices.filter((v) => v.name === name && live(v));
    if (same.length >= pr.voices) this.stop(same[0], 0.012, when);
    const alive = this.voices.filter(live);
    if (alive.length >= this.maxVoices) {
      let victim: Voice | null = null;
      for (const v of alive) if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.start < victim.start)) victim = v;
      if (victim && victim.prio <= pr.prio) this.stop(victim, 0.02, when); else if (victim) return null;
    }

    // variant: random, never the same one twice in a row
    let vi = o.variant ?? Math.floor(r() * bufs.length);
    if (o.variant === undefined && bufs.length > 1 && vi === this.lastVariant.get(name)) vi = (vi + 1 + Math.floor(r() * (bufs.length - 1))) % bufs.length;
    this.lastVariant.set(name, vi);
    const buf = bufs[vi % bufs.length];

    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = !!o.loop;
    const jitter = !o.exact;
    src.playbackRate.value = (o.rate ?? 1) * (jitter ? 1 + (r() * 2 - 1) * pr.pj : 1);
    if (jitter) gain *= dbToGain((r() * 2 - 1) * pr.gj);

    const vg = c.createGain();
    if (o.fadeIn) { vg.gain.setValueAtTime(0, when); vg.gain.linearRampToValueAtTime(gain, when + o.fadeIn); } else vg.gain.value = gain;
    const nodes: AudioNode[] = [src, vg];
    let tail: AudioNode = vg;
    src.connect(vg);
    if (lowpass < 19000) {
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lowpass; lp.Q.value = -3;
      tail.connect(lp); tail = lp; nodes.push(lp);
    }
    if (jitter && pr.bus !== 'ui' && pr.bus !== 'ambience') {
      // per-trigger tone variation so rapid repeats never sound identical / comb-filter
      const eq = c.createBiquadFilter(); eq.type = 'peaking';
      eq.frequency.value = 700 * Math.pow(2, r() * 3); eq.Q.value = 0.9; eq.gain.value = (r() * 2 - 1) * 2.5;
      tail.connect(eq); tail = eq; nodes.push(eq);
    }
    if (send > 0.001) { const sg = c.createGain(); sg.gain.value = send; tail.connect(sg).connect(this.revSend); nodes.push(sg); }
    if (o.pos) {
      const p = c.createPanner();
      p.panningModel = this.hrtf && gain > 0.02 ? 'HRTF' : 'equalpower';
      p.distanceModel = 'linear'; p.rolloffFactor = 0; p.refDistance = 1; p.maxDistance = 10000;
      if (p.positionX) { p.positionX.value = o.pos.x; p.positionY.value = o.pos.y; p.positionZ.value = o.pos.z; } else p.setPosition(o.pos.x, o.pos.y, o.pos.z);
      tail.connect(p); tail = p; nodes.push(p);
    } else if (o.pan) {
      const sp = c.createStereoPanner(); sp.pan.value = Math.max(-1, Math.min(1, o.pan));
      tail.connect(sp); tail = sp; nodes.push(sp);
    }
    tail.connect(this.buses[o.bus ?? pr.bus]);

    src.start(when);
    const dur = buf.duration / src.playbackRate.value;
    const v: Voice = { name, src, gain: vg, nodes, start: when, end: o.loop ? Infinity : when + dur, prio: pr.prio, done: false, level: gain };
    src.onended = () => this.cleanup(v);
    this.voices.push(v);
    return v;
  }

  stop(v: Voice, fade = 0.02, at?: number) {
    if (v.done) return;
    v.done = true;
    const t = Math.max(this.ctx.currentTime, at ?? this.ctx.currentTime);
    try {
      if (t < v.start) { v.src.stop(); return; }
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, fade / 3);
      v.src.stop(t + fade * 2.5);
      v.end = Math.min(v.end, t + fade * 2.5);
    } catch { /* already stopped */ }
  }

  private cleanup(v: Voice) {
    v.done = true;
    for (const n of v.nodes) try { n.disconnect(); } catch { /* ignore */ }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Drop finished voices whose onended hasn't fired (e.g. suspended context). */
  private reap() {
    const t = this.ctx.currentTime;
    // only in realtime: offline contexts sit at t=0 while the whole timeline is scheduled
    if (t <= 0) return;
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end + 0.25 < t) this.cleanup(this.voices[i]);
  }

  /**
   * Tail stealing: pull down every still-sounding voice of `name` by `factor` at `when`.
   * Rapid fire then keeps its punch instead of piling reverberant tails into a wall.
   */
  attenuate(name: string, factor: number, when = this.now, tau = 0.02) {
    for (const v of this.voices) {
      if (v.done || v.name !== name || v.end <= when || v.start >= when) continue;
      v.level *= factor;
      v.gain.gain.setTargetAtTime(v.level, when, tau);
    }
  }

  /** Sidechain-style duck of a gain node: fast dip to `to`, hold, slow recovery. */
  duck(node: GainNode, to: number, when = this.now, attack = 0.008, hold = 0.06, release = 0.5) {
    const p = node.gain;
    p.cancelScheduledValues(when);
    p.setTargetAtTime(to, when, attack);
    p.setTargetAtTime(1, when + attack * 3 + hold, release);
  }

  setIndoor(f: number, when = this.now) {
    this.indoor = f;
    this.revOutG.gain.setTargetAtTime(1 - 0.8 * f, when, 0.15);
    this.revInG.gain.setTargetAtTime(f, when, 0.15);
    this.ambLP.frequency.setTargetAtTime(20000 * Math.pow(1500 / 20000, f), when, 0.2);
    this.ambIndoor.gain.setTargetAtTime(1 - 0.45 * f, when, 0.2);
  }

  /** Explosion ear damage: low-pass sweep on the world mix, dip, and a tinnitus tone. */
  earRing(intensity: number, when = this.now) {
    const k = Math.max(0, Math.min(1, intensity));
    if (k <= 0.02) return;
    const low = 20000 * Math.pow(250 / 20000, k); // k=1 → 250 Hz
    const hold = 0.3 + 1.2 * k, rec = 1.5 + 3.5 * k;
    // let the blast itself through (~70 ms) before the hearing "shuts down"
    const t0 = when + 0.07;
    const f = this.ringLP.frequency;
    f.cancelScheduledValues(when);
    f.setTargetAtTime(low, t0, 0.03);
    f.setValueAtTime(low, t0 + 0.2);
    f.setValueAtTime(low, t0 + hold);
    f.exponentialRampToValueAtTime(20000, t0 + hold + rec);
    const d = this.worldDuck.gain;
    d.cancelScheduledValues(when);
    d.setTargetAtTime(1 - 0.5 * k, t0, 0.06);
    d.setTargetAtTime(1, t0 + hold, rec * 0.4);
    when = t0;
    // tinnitus: two close sines beating slightly, bypasses the muffling (it's "in your head")
    const c = this.ctx;
    const tg = c.createGain(); tg.gain.value = 0;
    const base = 3700 + this.rng() * 500;
    const o1 = c.createOscillator(); o1.frequency.value = base;
    const o2 = c.createOscillator(); o2.frequency.value = base * 1.0013;
    const lvl = 0.035 * k;
    tg.gain.setValueAtTime(0, when);
    tg.gain.linearRampToValueAtTime(lvl, when + 0.12);
    tg.gain.setValueAtTime(lvl, when + hold * 0.6);
    tg.gain.setTargetAtTime(0, when + hold * 0.6, rec * 0.3);
    o1.connect(tg); o2.connect(tg); tg.connect(this.master);
    const end = when + hold + rec * 2.5;
    o1.start(when); o2.start(when); o1.stop(end); o2.stop(end);
    o2.onended = () => { tg.disconnect(); };
  }

  setListener(pos: Vec3, fwd: Vec3, up: Vec3) {
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }
}

function softClipCurve(knee: number, ceil: number): Float32Array<ArrayBuffer> {
  const n = 8193; const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

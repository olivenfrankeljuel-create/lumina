import type { GameEvents, Surface } from '../core/events';
import type { AudioEngine, Vec3 } from './engine';
import { mulberry32, rr, type Rng } from './rng';

export type WeaponClass = 'rifle' | 'smg' | 'pistol' | 'sniper' | 'shotgun';

export function weaponClass(id: string): WeaponClass {
  const s = id.toLowerCase();
  if (/pistol|m9|1911|glock|p226|p320|usp|deagle|eagle|x12|x13|renetti|sidearm|handgun|revolver|magnum|\.50gs|sykov|9mm_daemon/.test(s)) return 'pistol';
  if (/smg|mp5|mp7|mp9|uzi|vector|p90|mpx|ump|mac1|mac-1|pdw|striker|vel|bas-p|wsp|lachmann.?sub|kastov.?74u|aug.?smg/.test(s)) return 'smg';
  if (/shotgun|870|m4sg|model.?680|r9|725|spas|aa-?12|pump|bryson|expedite|riveter|lockwood|haymaker|lockwood|marine.?sp/.test(s)) return 'shotgun';
  if (/sniper|awp|l115|ax50|ax-50|hdr|kar98|mors|katt|kat-amr|m82|barrett|dmr|marksman|sks|mk14|ebr|svd|m24|sp-r|longbow|victus|intervention|lr.?7/.test(s)) return 'sniper';
  return 'rifle';
}

const CLASS_TAIL: Record<WeaponClass, { g: number; rate: number; suppRate: number }> = {
  rifle: { g: 1, rate: 1, suppRate: 1 },
  smg: { g: 0.72, rate: 1.08, suppRate: 1.08 },
  pistol: { g: 0.6, rate: 1.12, suppRate: 1.15 },
  sniper: { g: 1.35, rate: 0.84, suppRate: 0.9 },
  shotgun: { g: 1.25, rate: 0.9, suppRate: 0.92 },
};

const IMPACT: Record<Surface, { name: string; rate?: number; lp?: number; gain?: number }> = {
  concrete: { name: 'imp_concrete' }, brick: { name: 'imp_concrete', rate: 0.94 }, plaster: { name: 'imp_concrete', rate: 1.08, gain: 0.85 },
  asphalt: { name: 'imp_concrete', rate: 0.9, lp: 7000 }, tile: { name: 'imp_concrete', rate: 1.15 },
  metal: { name: 'imp_metal' }, wood: { name: 'imp_wood' }, dirt: { name: 'imp_dirt' }, gravel: { name: 'imp_dirt', rate: 1.12 },
  sand: { name: 'imp_sand' }, glass: { name: 'imp_glass' }, flesh: { name: 'imp_flesh' },
  fabric: { name: 'imp_dirt', rate: 1.2, lp: 2200, gain: 0.7 }, water: { name: 'imp_water' },
};

const STEP: Record<Surface, string> = {
  concrete: 'step_concrete', brick: 'step_concrete', plaster: 'step_concrete', asphalt: 'step_concrete', tile: 'step_concrete', glass: 'step_concrete',
  dirt: 'step_dirt', sand: 'step_dirt', fabric: 'step_dirt', flesh: 'step_dirt', gravel: 'step_gravel', metal: 'step_metal', wood: 'step_wood', water: 'step_water',
};

export interface DirectorEnv {
  /** Ray against static world only; used for occlusion and casing landing surface. */
  raycast?(origin: Vec3, dir: Vec3, maxDist: number): { distance: number; surface: Surface; point: Vec3 } | null;
}

export interface PlayerAudioState { health: number; maxHealth: number; alive: boolean }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Turns game events into layered, mixed sound. Every handler takes an optional absolute `when` so it can be driven offline. */
export class AudioDirector {
  private rng: Rng = mulberry32(99);
  private stepSide = 1;
  private lastFlesh = { t: -1, p: { x: 0, y: 0, z: 0 } };
  private lastWhiz = -1;
  private casingsInFlight = 0;
  private nextBeat = 0;
  private nextBreath = 0;
  private breathIn = true;
  private lowTarget = 20000;
  private deadMuffle = 0;
  private pauseMuffle = 0;
  private beds: { v: ReturnType<AudioEngine['play']>; name: string }[] = [];
  ambTimers: Record<string, number> = {};
  ambienceOn = false;
  /** Listener right vector (for panning non-spatial directional cues). */
  right: Vec3 = { x: 1, y: 0, z: 0 };

  constructor(readonly E: AudioEngine, readonly env: DirectorEnv = {}) {}

  private now(when?: number) { return when ?? this.E.now; }

  occluded(p: Vec3): boolean {
    if (!this.env.raycast) return false;
    const L = this.E.listener;
    const d = sub(p, L); const dist = len(d);
    if (dist < 2) return false;
    const hit = this.env.raycast(L, norm(d), dist);
    return !!hit && hit.distance < dist - 1.2;
  }

  // ---------- player weapon ----------
  fire(e: GameEvents['weapon:fire'], when?: number) {
    const t = this.now(when);
    const E = this.E;
    const cls = weaponClass(e.weaponId);
    const ct = CLASS_TAIL[cls];
    const out = 1 - E.indoor, ind = E.indoor;
    if (e.suppressed) {
      E.play('supp_core', { when: t, rate: ct.suppRate, pan: rr(this.rng, -0.04, 0.04) });
      if (out > 0.05) E.play('tail_out', { when: t, gain: 0.16 * ct.g * out, lowpass: 2200, rate: ct.rate });
      if (ind > 0.05) E.play('tail_in', { when: t, gain: 0.25 * ct.g * ind, lowpass: 3000, rate: ct.rate });
      E.duck(E.ambDuck, 0.75, t, 0.01, 0.03, 0.3);
    } else {
      // tail stealing: older shots' tails and bodies step back so each new shot punches through
      E.attenuate('tail_out', 0.6, t); E.attenuate('tail_in', 0.6, t); E.attenuate(`${cls}_core`, 0.7, t);
      E.play(`${cls}_core`, { when: t, pan: rr(this.rng, -0.04, 0.04) });
      if (out > 0.05) E.play('tail_out', { when: t, gain: ct.g * Math.sqrt(out), rate: ct.rate });
      if (ind > 0.05) E.play('tail_in', { when: t, gain: ct.g * Math.sqrt(ind), rate: ct.rate });
      E.duck(E.ambDuck, 0.25, t, 0.004, 0.1, 0.8);
      E.duck(E.sfxDuck, 0.65, t, 0.002, 0.03, 0.12);
    }
  }

  dryfire(_e: GameEvents['weapon:dryfire'], when?: number) { this.E.play('dryfire', { when: this.now(when) }); }

  reload(e: GameEvents['weapon:reload'], when?: number) {
    const t = this.now(when);
    const cls = weaponClass(e.weaponId);
    const rate = cls === 'pistol' ? 1.12 : cls === 'smg' ? 1.05 : 1;
    switch (e.stage) {
      case 'start': this.E.play('reload_rustle', { when: t }); break;
      case 'magout': this.E.play('mag_out', { when: t, rate }); break;
      case 'magin': this.E.play('mag_in', { when: t, rate }); break;
      case 'bolt': this.E.play(cls === 'rifle' || cls === 'smg' ? (e.empty ? 'bolt_release' : 'charge_handle') : 'bolt_release', { when: t, rate: cls === 'pistol' ? 1.25 : cls === 'sniper' ? 0.85 : rate }); break;
      case 'end': this.E.play('ads_out', { when: t, gain: 0.7 }); break;
    }
  }

  ads(e: GameEvents['weapon:ads'], when?: number) { this.E.play(e.active ? 'ads_in' : 'ads_out', { when: this.now(when) }); }
  switchWeapon(_e: GameEvents['weapon:switch'], when?: number) { this.E.play('weapon_switch', { when: this.now(when) }); }

  shell(e: GameEvents['shell:eject'], when?: number) {
    if (this.casingsInFlight > 3) return;
    const t = this.now(when);
    // where does it land? ray straight down from the ejection point
    const hit = this.env.raycast?.(e.position, { x: 0, y: -1, z: 0 }, 4) ?? null;
    const h = hit ? hit.distance : 1.3;
    const vy = e.velocity.y, g = 9.81;
    const fall = (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0.05, h))) / g;
    const surf = hit?.surface ?? 'concrete';
    const soft = surf === 'dirt' || surf === 'sand' || surf === 'fabric' || surf === 'flesh' || surf === 'water' || surf === 'gravel';
    const name = soft ? 'casing_soft' : surf === 'metal' ? (e.kind === 'pistol' ? 'casing_pistol' : 'casing_rifle_metal') : e.kind === 'pistol' ? 'casing_pistol' : 'casing_rifle';
    const pos = hit ? hit.point : { x: e.position.x + e.velocity.x * fall, y: e.position.y - h, z: e.position.z + e.velocity.z * fall };
    this.casingsInFlight++;
    const land = t + fall;
    this.E.play(name, { when: land, pos, gain: rr(this.rng, 0.55, 1) });
    // bookkeeping without timers (works offline too)
    const dec = () => { this.casingsInFlight = Math.max(0, this.casingsInFlight - 1); };
    if (typeof setTimeout !== 'undefined' && when === undefined) setTimeout(dec, fall * 1000); else dec();
  }

  // ---------- bullets ----------
  impact(e: GameEvents['bullet:impact'], when?: number) {
    const t = this.now(when);
    const m = IMPACT[e.surface] ?? IMPACT.concrete;
    if (e.surface === 'flesh') { if (this.fleshDupe(e.point, t)) return; this.markFlesh(e.point, t); }
    this.E.play(m.name, { when: t, pos: e.point, rate: m.rate, lowpass: m.lp, gain: m.gain, propagate: true });
    if ((e.surface === 'metal' && this.rng() < 0.3) || ((e.surface === 'concrete' || e.surface === 'brick' || e.surface === 'asphalt') && this.rng() < 0.08)) {
      this.E.play('ricochet', { when: t + 0.005, pos: e.point, propagate: true });
    }
  }

  private fleshDupe(p: Vec3, t: number) { return Math.abs(t - this.lastFlesh.t) < 0.03 && len(sub(p, this.lastFlesh.p)) < 0.8; }
  private markFlesh(p: Vec3, t: number) { this.lastFlesh = { t, p: { x: p.x, y: p.y, z: p.z } }; }

  whiz(e: GameEvents['bullet:whizby'], when?: number) { this.whizAt(e.point, this.now(when)); }

  private whizAt(point: Vec3, t: number) {
    if (Math.abs(t - this.lastWhiz) < 0.06) return;
    this.lastWhiz = t;
    this.E.play('whiz', { when: t, pos: point });
    this.E.duck(this.E.ambDuck, 0.6, t, 0.005, 0.05, 0.4);
  }

  /** Fallback near-miss detection when AI doesn't emit whizby: enemy tracer passing within 3.5 m of the listener. */
  tracer(e: GameEvents['bullet:tracer'], when?: number) {
    if (!e.enemy) return;
    const t = this.now(when);
    const L = this.E.listener;
    const ab = sub(e.to, e.from); const l2 = dot(ab, ab);
    if (l2 < 1e-6) return;
    const u = dot(sub(L, e.from), ab) / l2;
    if (u <= 0.02 || u >= 1.05) return;
    const c = { x: e.from.x + ab.x * u, y: e.from.y + ab.y * u, z: e.from.z + ab.z * u };
    const d = len(sub(c, L));
    if (d > 3.5 || d < 0.05) return;
    const travel = (Math.sqrt(l2) * u) / 900; // ~900 m/s round
    this.whizAt(c, t + travel);
  }

  // ---------- enemies ----------
  enemyFire(e: GameEvents['enemy:fire'], when?: number) {
    const t = this.now(when);
    const E = this.E;
    const d = E.distance(e.origin);
    const occluded = this.occluded(e.origin);
    const wc = clamp01((75 - d) / 50), wd = clamp01((d - 12) / 30);
    if (wc > 0.02) E.play('enemy_rifle', { when: t, pos: e.origin, gain: wc, propagate: true, occluded });
    if (wd > 0.02) E.play('rifle_distant', { when: t, pos: e.origin, gain: wd, propagate: true, occluded });
    if (d < 30) E.duck(E.ambDuck, 0.5, t, 0.01, 0.05, 0.6);
  }

  enemyFootstep(e: GameEvents['enemy:footstep'], when?: number) {
    this.E.play(STEP[e.surface] ?? 'step_concrete', { when: this.now(when), pos: e.position, gain: 0.8, occluded: this.E.distance(e.position) > 8 && this.occluded(e.position) });
  }

  enemyAlert(e: GameEvents['enemy:alert'], when?: number) {
    this.E.play('weapon_switch', { when: this.now(when), pos: e.position, gain: 0.8, bus: 'sfx' });
  }

  enemyHit(e: GameEvents['enemy:hit'], when?: number) {
    const t = this.now(when);
    if (!this.fleshDupe(e.point, t)) { this.markFlesh(e.point, t); this.E.play('imp_flesh', { when: t, pos: e.point }); }
    if (e.killed) return; // kill sounds come from enemy:killed
    this.E.play('hitmarker', { when: t });
    if (e.headshot) this.E.play('headshot', { when: t, gain: 0.8 });
  }

  enemyKilled(e: GameEvents['enemy:killed'], when?: number) {
    const t = this.now(when);
    this.E.play('kill_confirm', { when: t });
    if (e.headshot) this.E.play('headshot', { when: t });
    this.E.play('bodyfall', { when: t + rr(this.rng, 0.35, 0.65), pos: e.position });
  }

  // ---------- player ----------
  damaged(e: GameEvents['player:damaged'], when?: number) {
    const t = this.now(when);
    let pan = 0;
    if (e.fromDir) pan = Math.max(-0.7, Math.min(0.7, dot(norm(e.fromDir), this.right)));
    this.E.play('hurt_hit', { when: t, pan, gain: 0.6 + 0.4 * clamp01(e.amount / 40) });
    this.E.duck(this.E.worldDuck, 0.7, t, 0.005, 0.05, 0.25);
  }

  died(when?: number) {
    const t = this.now(when);
    this.deadMuffle = 1;
    this.E.healthLP.frequency.cancelScheduledValues(t);
    this.E.healthLP.frequency.setTargetAtTime(350, t, 0.4);
    this.lowTarget = 350;
    this.E.play('hurt_hit', { when: t, gain: 1 });
  }

  respawn(when?: number) {
    const t = this.now(when);
    this.deadMuffle = 0;
    this.E.healthLP.frequency.cancelScheduledValues(t);
    this.E.healthLP.frequency.setTargetAtTime(20000, t, 0.3);
    this.lowTarget = 20000;
    this.nextBeat = 0;
  }

  footstep(e: GameEvents['player:footstep'], when?: number) {
    const t = this.now(when);
    this.stepSide = -this.stepSide;
    const speedK = clamp01(0.4 + e.speed / 7);
    const g = (e.crouched ? 0.4 : e.sprinting ? 1.25 : 0.85) * speedK;
    this.E.play(STEP[e.surface] ?? 'step_concrete', { when: t, gain: g, pan: 0.12 * this.stepSide, lowpass: e.crouched ? 3500 : undefined, rate: e.sprinting ? 1.04 : 1 });
    if (e.sprinting) this.E.play('gear_rattle', { when: t + 0.01, gain: 0.9, pan: -0.1 * this.stepSide });
    else if (!e.crouched && this.rng() < 0.3) this.E.play('gear_rattle', { when: t + 0.01, gain: 0.35 });
  }

  jump(_e: GameEvents['player:jump'], when?: number) { this.E.play('jump', { when: this.now(when) }); }

  land(e: GameEvents['player:land'], when?: number) {
    const t = this.now(when);
    const k = clamp01((e.impactSpeed - 1.5) / 8);
    if (k <= 0) return;
    this.E.play('land', { when: t, gain: 0.35 + 0.65 * k });
    this.E.play(STEP[e.surface] ?? 'step_concrete', { when: t, gain: 0.8 + 0.5 * k, rate: 0.92 });
  }

  slide(_e: GameEvents['player:slide'], when?: number) { this.E.play('slide', { when: this.now(when) }); }

  grenadeThrow(_e: GameEvents['grenade:throw'], when?: number) {
    const t = this.now(when);
    this.E.play('grenade_pin', { when: t });
    this.E.play('throw_whoosh', { when: t + 0.05 });
  }

  grenadeBounce(e: GameEvents['grenade:bounce'], when?: number) {
    this.E.play('grenade_bounce', { when: this.now(when), pos: e.position, gain: clamp01(e.speed / 8), lowpass: e.surface === 'dirt' || e.surface === 'sand' ? 1500 : undefined });
  }

  explosion(e: GameEvents['explosion'], when?: number) {
    const t = this.now(when);
    const E = this.E;
    const d = E.distance(e.position);
    const occluded = this.occluded(e.position);
    const near = clamp01((140 - d) / 90), far = clamp01((d - 25) / 60);
    const arrive = t + d / 343;
    if (near > 0.02) E.play('explosion', { when: t, pos: e.position, gain: near, propagate: true, occluded });
    if (far > 0.02) E.play('explosion_far', { when: t, pos: e.position, gain: far, propagate: true, occluded });
    // environment rumble: the gun tail slowed right down
    const envK = Math.max(near, 0.35 * far) * (occluded ? 0.6 : 1);
    if (1 - E.indoor > 0.05) E.play('tail_out', { when: arrive, rate: 0.55, gain: 1.3 * envK * (1 - E.indoor), exact: true });
    if (E.indoor > 0.05) E.play('tail_in', { when: arrive, rate: 0.6, gain: 1.2 * envK * E.indoor, exact: true });
    const ring = Math.max(6, e.radius * 3);
    if (d < ring) E.earRing(Math.pow(1 - d / ring, 0.8), arrive);
    E.duck(E.ambDuck, 0.15, arrive, 0.01, 0.4, 1.5);
  }

  // ---------- ui ----------
  uiClick() { this.E.play('ui_click'); }
  uiHover() { this.E.play('ui_hover'); }

  gameState(e: GameEvents['game:state']) {
    this.pauseMuffle = e.state === 'paused' || e.state === 'menu' ? 1 : 0;
    if (e.state === 'playing') { this.wantAmbience = true; this.startAmbience(); }
    if (e.state === 'dead' && !this.deadMuffle) this.died();
  }

  // ---------- ambience ----------
  startAmbience(at?: number) {
    if (this.ambienceOn) return;
    if (!this.E.has('amb_wind') || !this.E.has('amb_town')) return; // bank still rendering; retried from update()
    this.ambienceOn = true;
    const t = at ?? this.E.now;
    for (const name of ['amb_wind', 'amb_town']) this.beds.push({ name, v: this.E.play(name, { when: t, loop: true, fadeIn: 3, exact: true }) });
    this.ambTimers = { gunfire: t + rr(this.rng, 6, 15), dog: t + rr(this.rng, 25, 60), drone: t + rr(this.rng, 30, 60), clank: t + rr(this.rng, 8, 20), boom: t + rr(this.rng, 60, 140) };
  }

  stopAmbience() {
    for (const b of this.beds) if (b.v) this.E.stop(b.v, 1);
    this.beds = []; this.ambienceOn = false;
  }

  private farPoint(dMin: number, dMax: number, yMin = 5, yMax = 30): Vec3 {
    const a = this.rng() * Math.PI * 2, d = rr(this.rng, dMin, dMax), L = this.E.listener;
    return { x: L.x + Math.cos(a) * d, y: L.y + rr(this.rng, yMin, yMax), z: L.z + Math.sin(a) * d };
  }

  private ambience(t: number) {
    const T = this.ambTimers, r = this.rng, E = this.E;
    if (t > T.gunfire) {
      // distant firefight: bursts or single taps, sometimes answered from elsewhere
      const exchanges = r() < 0.35 ? 2 : 1;
      let tt = t;
      for (let x = 0; x < exchanges; x++) {
        const p = this.farPoint(160, 480);
        const burst = r() < 0.6 ? Math.round(rr(r, 3, 8)) : Math.round(rr(r, 1, 3));
        const gap = burst > 3 ? rr(r, 0.085, 0.12) : rr(r, 0.35, 0.8);
        for (let i = 0; i < burst; i++) E.play('rifle_distant', { when: tt + i * gap, pos: p, gain: 0.6, bus: 'ambience', lowpass: 2500, send: 0.8 });
        tt += burst * gap + rr(r, 0.6, 2);
      }
      T.gunfire = t + rr(r, 9, 32);
    }
    if (t > T.dog) { E.play('amb_dog', { when: t, pos: this.farPoint(90, 220, 0, 5), lowpass: 2500, send: 0.7 }); T.dog = t + rr(r, 45, 110); }
    if (t > T.drone) { E.play('amb_drone', { when: t, pos: this.farPoint(350, 600, 20, 40), lowpass: 2200, send: 0.9, exact: true }); T.drone = t + rr(r, 160, 300); }
    if (t > T.clank) { E.play('amb_clank', { when: t, pos: this.farPoint(40, 120, 0, 10), send: 0.7 }); T.clank = t + rr(r, 14, 40); }
    if (t > T.boom) { E.play('explosion_far', { when: t, pos: this.farPoint(500, 900), gain: 0.35, bus: 'ambience', send: 0.8 }); T.boom = t + rr(r, 90, 220); }
  }

  // ---------- per-frame ----------
  /** `at` overrides the clock (offline rendering drives virtual time). */
  update(dt: number, p: PlayerAudioState | null, at?: number) {
    const E = this.E;
    const t = at ?? E.now;
    if (!this.ambienceOn && this.wantAmbience) this.startAmbience();
    if (this.ambienceOn) this.ambience(t);
    if (!p) return;
    const h = p.maxHealth > 0 ? p.health / p.maxHealth : 1;
    const low = p.alive ? clamp01((0.4 - h) / 0.3) : 0;
    // continuous muffling from low health / pause / death
    let target = 20000 * Math.pow(2800 / 20000, low * 0.85);
    if (this.pauseMuffle) target = Math.min(target, 900);
    if (this.deadMuffle) target = Math.min(target, 350);
    if (Math.abs(Math.log(target / this.lowTarget)) > 0.05) {
      this.lowTarget = target;
      E.healthLP.frequency.setTargetAtTime(target, t, 0.25);
    }
    if (low > 0 && p.alive) {
      if (t >= this.nextBeat) {
        E.play('heartbeat', { when: Math.max(t, this.nextBeat), gain: 0.35 + 0.65 * low });
        this.nextBeat = Math.max(t, this.nextBeat) + (1.0 - 0.38 * low);
      }
    } else this.nextBeat = t;
    if (h < 0.5 && p.alive) {
      if (t >= this.nextBreath) {
        const k = clamp01((0.5 - h) / 0.35);
        E.play(this.breathIn ? 'breath_in' : 'breath_out', { when: t, gain: 0.4 + 0.6 * k });
        this.nextBreath = t + (this.breathIn ? rr(this.rng, 0.7, 0.9) : rr(this.rng, 0.9, 1.3)) * (1.2 - 0.4 * k);
        this.breathIn = !this.breathIn;
      }
    } else { this.nextBreath = t; this.breathIn = true; }
    void dt;
  }

  wantAmbience = false;
}

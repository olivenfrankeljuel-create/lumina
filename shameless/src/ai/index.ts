/**
 * Enemy manager: OpFor soldiers with CoD-style combat readability.
 *
 * Perception: vision cone + line-of-sight raycasts feeding an awareness meter, hearing of player gunfire,
 * near-miss suppression, squad callouts. Behaviour: patrol -> investigate / alert (callout) -> combat
 * (take cover, peek-and-burst, reposition, flank, suppressed cower, retreat at low HP, search the last known
 * position). Shooting uses human-ish reaction times and an accuracy model that improves with time-on-target
 * and degrades with range, player speed, suppression and own movement. Waves respawn when a squad is wiped.
 */
import * as THREE from 'three';
import type { EnemyInfo, EnemyManager, GameContext } from '../core/types';
import type { Surface } from '../core/events';
import { physicsExt } from '../physics';
import { PRESET_VARIANTS, randomVariant, type Variant } from './character';
import { SoldierVisual } from './soldier';
import { Ragdoll } from './ragdoll';
import { NavGrid, type CoverSpot } from './nav';
import { simplifierReady } from './sdf';
import { B, REST } from './rig';
import { mulberry32 } from './rng';

export type AiState = 'patrol' | 'investigate' | 'alert' | 'move_cover' | 'cover' | 'peek' | 'advance' | 'flank' | 'retreat' | 'search' | 'dead';

const TUNE = {
  hp: 100,
  headMult: 4, limbMult: 0.7,
  walk: 1.45, run: 4.3, crouchWalk: 1.2,
  visionRange: 75, fovCalm: 0.55, fovAlert: 1.2, // half-angle cos-space via radians
  hearRange: 75, hearSuppressed: 14,
  rpm: 600, burstMin: 3, burstMax: 6,
  dmgMin: 8, dmgMax: 13,
  maxShooters: 3,
  corpseTime: 20,
  waveDelay: 4.5,
};

interface Enemy extends EnemyInfo {
  vis: SoldierVisual;
  hp: number;
  state: AiState;
  stateT: number;
  yaw: number;
  vel: THREE.Vector3;
  path: THREE.Vector3[] | null;
  pathI: number;
  goal: THREE.Vector3 | null;
  moveMode: 'walk' | 'run' | 'crouch';
  repathT: number;
  cover: CoverSpot | null;
  peekSide: -1 | 0 | 1;
  awareness: number;
  lastKnown: THREE.Vector3;
  lastSeenT: number;
  canSee: boolean;
  seeT: number;
  percT: number;
  targetTime: number; // continuous time with target acquired
  reaction: number;
  burst: number;
  fireCd: number;
  ammo: number;
  suppression: number;
  shooting: boolean;
  decideT: number;
  retreated: boolean;
  patrolHome: THREE.Vector3;
  alertDelay: number;
  ragdoll: Ragdoll | null;
  deadT: number;
  rng: () => number;
  stuckT: number;
  lastPos: THREE.Vector3;
  cycles: number;
  footT: number;
}

export interface EnemyManagerExt extends EnemyManager {
  /** Dev/debug access. */
  readonly debug: {
    list: Enemy[];
    log: string[];
    nav: NavGrid;
    covers: CoverSpot[];
    spawn(pos: THREE.Vector3, variant?: Variant, yaw?: number): Enemy;
    setPassive(p: boolean): void;
    kill(id: number, dir?: THREE.Vector3): void;
  };
}

export async function createEnemyManager(ctx: GameContext, opts: { count?: number } = {}): Promise<EnemyManagerExt> {
  await simplifierReady;
  const phys = physicsExt(ctx.physics);
  const nav = new NavGrid(ctx);
  const rng = mulberry32(1337);
  const list: Enemy[] = [];
  const byId = new Map<number, Enemy>();
  const enemies: EnemyInfo[] = [];
  const log: string[] = [];
  let nextId = 0;
  let passive = false;
  let waveT = -1;
  let wave = 0;
  const count = opts.count ?? ctx.world.enemySpawns.length;

  // variant pool: presets + a few seeded randoms (geometry cached per unique part)
  const pool: Variant[] = [...PRESET_VARIANTS, randomVariant(11), randomVariant(23)];

  // cover
  let covers: CoverSpot[] = ctx.world.coverPoints.map((c) => ({ position: c.position.clone(), normal: c.normal.clone().setY(0).normalize(), low: true, owner: -1 }));
  const classifyCover = (c: CoverSpot) => {
    const o = c.position.clone(); o.y += 1.45;
    c.low = !phys.raycast(o, c.normal.clone().negate(), 1.2, { ignoreEnemies: true, ignorePlayer: true });
  };
  covers.forEach(classifyCover);
  if (covers.length < 6 && count > 0) {
    const box = new THREE.Box3();
    [...ctx.world.enemySpawns, ...ctx.world.playerSpawns.map((s) => s.position)].forEach((p) => box.expandByPoint(p));
    box.expandByVector(new THREE.Vector3(18, 0, 18));
    covers = covers.concat(nav.generateCover(box.min, box.max));
  }

  // muzzle light pool (fixed count so shader programs don't change)
  const lights: { l: THREE.PointLight; t: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const l = new THREE.PointLight(0xffb070, 0, 9, 2);
    l.castShadow = false;
    ctx.scene.add(l);
    lights.push({ l, t: 0 });
  }
  const flashLight = (p: THREE.Vector3) => {
    let best = lights[0];
    for (const x of lights) if (x.t < best.t) best = x;
    best.l.position.copy(p);
    best.l.intensity = 22;
    best.t = 0.05;
  };

  const say = (e: Enemy | null, msg: string) => {
    const line = `[ai] t=${ctx.time.toFixed(2)} #${e ? e.id : '-'} ${msg}`;
    log.push(line);
    if (log.length > 400) log.shift();
    if (DEBUG_LOG) console.info(line);
  };
  const setState = (e: Enemy, s: AiState, why = '') => {
    if (e.state === s) return;
    say(e, `${e.state} -> ${s}${why ? ' (' + why + ')' : ''}`);
    e.state = s; e.stateT = 0;
  };

  // ------------------------------------------------------------------ spawning
  function spawn(pos: THREE.Vector3, variant?: Variant, yaw?: number): Enemy {
    const id = nextId++;
    const r = mulberry32(id * 7919 + 3);
    const v = variant ?? pool[Math.floor(r() * pool.length)];
    const vis = new SoldierVisual(ctx, v, r() < 0.5);
    const p = pos.clone();
    p.y = ctx.world.groundHeight(p.x, p.z) ?? p.y;
    vis.root.position.copy(p);
    const y0 = yaw ?? Math.atan2(ctx.player.position.x - p.x, ctx.player.position.z - p.z) + (r() - 0.5) * 1.2;
    vis.root.rotation.y = y0;
    ctx.scene.add(vis.root);
    ctx.pipeline.setupShadows(vis.root);
    vis.rifle.flash.group.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false; });
    const e: Enemy = {
      id, position: vis.root.position, alive: true, alerted: false,
      vis, hp: TUNE.hp, state: 'patrol', stateT: 0, yaw: y0, vel: new THREE.Vector3(),
      path: null, pathI: 0, goal: null, moveMode: 'walk', repathT: 0,
      cover: null, peekSide: 0, awareness: 0, lastKnown: ctx.player.position.clone(), lastSeenT: -99, canSee: false, seeT: 0, percT: r() * 0.2,
      targetTime: 0, reaction: 0, burst: 0, fireCd: 0, ammo: 30, suppression: 0, shooting: false, decideT: 0, retreated: false,
      patrolHome: p.clone(), alertDelay: -1, ragdoll: null, deadT: 0, rng: r, stuckT: 0, lastPos: p.clone(), cycles: 0, footT: 0,
    };
    vis.anim.onFootstep = (_side, fp) => {
      if (e.footT > 0) return;
      e.footT = 0.2;
      ctx.events.emit('enemy:footstep', { enemyId: e.id, position: fp.clone(), surface: surfaceBelow(fp) });
    };
    registerHitboxes(e);
    list.push(e); byId.set(id, e); enemies.push(e);
    say(e, `spawn ${v.headgear}/${v.face}/${v.vest} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    return e;
  }

  function surfaceBelow(p: THREE.Vector3): Surface {
    const h = phys.raycast(_o.set(p.x, p.y + 0.4, p.z), _dn, 1.0, { ignoreEnemies: true, ignorePlayer: true });
    return h?.surface ?? 'concrete';
  }

  function registerHitboxes(e: Enemy) {
    const b = e.vis.char.bones, s = e.vis.scale;
    const Y = new THREE.Vector3(0, 1, 0);
    const cap = (bone: number, end: number, r: number, region: 'limb' | 'torso') => {
      const a = new THREE.Vector3(...REST[bone]), c = new THREE.Vector3(...REST[end]);
      const len = a.distanceTo(c) * s;
      const dir = c.clone().sub(a).normalize();
      phys.registerHitboxCapsule(b[bone], e.id, region, r * s, Math.max(0.01, len / 2 - r * s * 0.5), { offset: dir.clone().multiplyScalar(len / 2 / s), rotation: new THREE.Quaternion().setFromUnitVectors(Y, dir) });
    };
    phys.registerHitboxBox(b[B.head], e.id, 'head', new THREE.Vector3(0.1, 0.12, 0.11).multiplyScalar(s), { offset: new THREE.Vector3(0, 0.1, 0.01) });
    phys.registerHitboxBox(b[B.spine2], e.id, 'torso', new THREE.Vector3(0.19, 0.15, 0.15).multiplyScalar(s), { offset: new THREE.Vector3(0, 0.08, 0) });
    phys.registerHitboxBox(b[B.spine], e.id, 'torso', new THREE.Vector3(0.17, 0.12, 0.13).multiplyScalar(s), { offset: new THREE.Vector3(0, 0.08, 0) });
    phys.registerHitboxBox(b[B.hips], e.id, 'torso', new THREE.Vector3(0.17, 0.1, 0.13).multiplyScalar(s), { offset: new THREE.Vector3(0, -0.02, 0) });
    cap(B.uarmL, B.farmL, 0.06, 'limb'); cap(B.farmL, B.handL, 0.05, 'limb');
    cap(B.uarmR, B.farmR, 0.06, 'limb'); cap(B.farmR, B.handR, 0.05, 'limb');
    cap(B.thighL, B.calfL, 0.085, 'limb'); cap(B.calfL, B.footL, 0.065, 'limb');
    cap(B.thighR, B.calfR, 0.085, 'limb'); cap(B.calfR, B.footR, 0.065, 'limb');
  }

  function spawnWave() {
    wave++;
    const spawns = ctx.world.enemySpawns.slice();
    const pp = ctx.player.position;
    // prefer far spawns
    spawns.sort((a, b) => b.distanceToSquared(pp) - a.distanceToSquared(pp));
    const n = Math.min(count, spawns.length);
    const far = spawns.filter((s) => s.distanceTo(pp) > 14);
    const use = (far.length >= n ? far : spawns).slice(0, Math.max(n, 1));
    for (let i = 0; i < n; i++) {
      const e = spawn(use[i % use.length].clone().add(new THREE.Vector3((rng() - 0.5) * 1.5, 0, (rng() - 0.5) * 1.5)));
      if (wave > 1) { e.alerted = true; e.awareness = 0.7; e.lastKnown.copy(pp); setState(e, 'search', 'wave'); }
    }
    say(null, `wave ${wave}: ${n} enemies`);
  }

  // ------------------------------------------------------------------ hearing / suppression
  ctx.events.on('weapon:fire', (ev) => {
    for (const e of list) {
      if (!e.alive) continue;
      const d = e.position.distanceTo(ev.origin);
      if (d < (ev.suppressed ? TUNE.hearSuppressed : TUNE.hearRange)) {
        e.lastKnown.copy(ctx.player.position);
        if (!e.alerted) {
          if (d < 40 || e.awareness > 0.3) alert(e, 'heard gunfire', 0.2 + e.rng() * 0.5);
          else if (e.state === 'patrol') { setState(e, 'investigate', 'distant gunfire'); goTo(e, ev.origin, 'walk'); }
        }
      }
      // near miss -> suppression
      const c = _v1.copy(e.position); c.y += 1.2;
      const t = _v2.subVectors(c, ev.origin).dot(ev.dir);
      if (t > 0) {
        const closest = _v3.copy(ev.origin).addScaledVector(ev.dir, t);
        const miss = closest.distanceTo(c);
        if (miss < 1.6) {
          e.suppression = Math.min(1, e.suppression + 0.22 * (1.6 - miss));
          if (!e.alerted) alert(e, 'shot at', 0.1);
        }
      }
    }
  });
  ctx.events.on('bullet:impact', (ev) => {
    for (const e of list) {
      if (!e.alive) continue;
      const d = e.position.distanceTo(ev.point);
      if (d < 2.2) e.suppression = Math.min(1, e.suppression + 0.12);
    }
  });

  function alert(e: Enemy, why: string, delay = 0) {
    if (!e.alive || e.alerted) return;
    e.alerted = true;
    e.awareness = 1;
    e.alertDelay = delay;
    setState(e, 'alert', why);
    ctx.events.emit('enemy:alert', { enemyId: e.id, position: e.position.clone() });
    // squad callout: nearby allies react after a beat
    for (const o of list) {
      if (o === e || !o.alive || o.alerted) continue;
      if (o.position.distanceTo(e.position) < 45) {
        o.lastKnown.copy(e.lastKnown);
        setTimeoutGame(0.5 + o.rng() * 0.9, () => alert(o, `callout from #${e.id}`, 0.1));
      }
    }
  }

  const timers: { t: number; fn: () => void }[] = [];
  const setTimeoutGame = (t: number, fn: () => void) => timers.push({ t, fn });

  // ------------------------------------------------------------------ movement
  function goTo(e: Enemy, target: THREE.Vector3, mode: Enemy['moveMode']) {
    e.goal = target.clone();
    e.moveMode = mode;
    e.path = nav.findPath(e.position, target);
    e.pathI = 0;
    e.repathT = 2.5;
    if (!e.path) { e.goal = null; return false; }
    return true;
  }
  const atGoal = (e: Enemy) => !e.path || e.pathI >= e.path.length;

  function steer(e: Enemy, dt: number) {
    const desired = _v1.set(0, 0, 0);
    if (e.path && e.pathI < e.path.length) {
      const wp = e.path[e.pathI];
      const to = _v2.subVectors(wp, e.position).setY(0);
      const d = to.length();
      const last = e.pathI === e.path.length - 1;
      if (d < (last ? 0.25 : 0.45)) { e.pathI++; }
      else {
        const speed = e.moveMode === 'run' ? TUNE.run : e.moveMode === 'crouch' ? TUNE.crouchWalk : TUNE.walk;
        const slow = last ? Math.min(1, d / 1.2) : 1;
        desired.copy(to).divideScalar(d).multiplyScalar(speed * Math.max(0.35, slow));
      }
    }
    // separation
    for (const o of list) {
      if (o === e || !o.alive) continue;
      const dx = e.position.x - o.position.x, dz = e.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.3 && d2 > 1e-4) { const d = Math.sqrt(d2); desired.x += (dx / d) * (1.2 - d) * 2.5; desired.z += (dz / d) * (1.2 - d) * 2.5; }
    }
    // accelerate
    const acc = e.moveMode === 'run' ? 9 : 7;
    e.vel.x += THREE.MathUtils.clamp(desired.x - e.vel.x, -acc * dt, acc * dt);
    e.vel.z += THREE.MathUtils.clamp(desired.z - e.vel.z, -acc * dt, acc * dt);
    // collide with nav grid: stop moving into blocked cells
    const nx = e.position.x + e.vel.x * dt, nz = e.position.z + e.vel.z * dt;
    const [cx, cz] = nav.cellOf(nx, nz);
    if (!nav.walkable(cx, cz)) {
      const [ox, oz] = nav.cellOf(e.position.x, e.position.z);
      if (nav.walkable(cx, oz)) e.vel.z = 0; else if (nav.walkable(ox, cz)) e.vel.x = 0; else e.vel.set(0, 0, 0);
    }
    e.position.x += e.vel.x * dt;
    e.position.z += e.vel.z * dt;
    const g = ctx.world.groundHeight(e.position.x, e.position.z);
    if (g !== null) e.position.y += (g - e.position.y) * Math.min(1, dt * 12);
    // stuck detection
    e.repathT -= dt;
    if (e.goal && e.repathT <= 0) {
      if (e.position.distanceTo(e.lastPos) < 0.3 && !atGoal(e)) { e.stuckT++; goTo(e, e.goal, e.moveMode); }
      e.lastPos.copy(e.position);
      e.repathT = 1.5;
    }
  }

  function faceYaw(e: Enemy, target: number, rate: number, dt: number) {
    let d = target - e.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    e.yaw += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  // ------------------------------------------------------------------ perception
  const playerChest = (out: THREE.Vector3) => out.copy(ctx.player.position).setY(ctx.player.position.y + (ctx.player.crouched ? 0.85 : 1.25));
  const playerHead = (out: THREE.Vector3) => out.copy(ctx.player.position).setY(ctx.player.position.y + ctx.player.eyeHeight - 0.05);

  function perceive(e: Enemy, dt: number) {
    e.percT -= dt;
    if (e.percT > 0) return;
    const step = 0.15;
    e.percT = step;
    if (!ctx.player.alive) { e.canSee = false; return; }
    const eye = e.vis.eye(_v1);
    const target = playerChest(_v2);
    const to = _v3.subVectors(target, eye);
    const dist = to.length();
    to.divideScalar(dist);
    const fwd = _v4.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    const ang = Math.acos(THREE.MathUtils.clamp(fwd.x * to.x + fwd.z * to.z, -1, 1) / Math.max(1e-3, Math.hypot(to.x, to.z)));
    const fov = e.alerted ? TUNE.fovAlert : TUNE.fovCalm + (e.state === 'investigate' ? 0.3 : 0);
    let see = false;
    if (dist < TUNE.visionRange && (ang < fov || dist < 3)) {
      see = phys.lineOfSight(eye, target) || phys.lineOfSight(eye, playerHead(_v5));
    }
    e.canSee = see;
    if (see) {
      e.lastKnown.copy(ctx.player.position);
      e.lastSeenT = ctx.time;
      if (!e.alerted) {
        const speed = Math.hypot(ctx.player.velocity.x, ctx.player.velocity.z);
        const rate = (1.4 - dist / TUNE.visionRange) * (ctx.player.crouched ? 0.55 : 1) * (1 + speed * 0.12) * (ang < 0.35 ? 1.6 : 1);
        e.awareness += rate * step * 1.1;
        if (e.awareness >= 1 || dist < 6) alert(e, `spotted player at ${dist.toFixed(0)}m`, 0.35 + e.rng() * 0.3);
      }
    } else if (!e.alerted) {
      e.awareness = Math.max(0, e.awareness - step * 0.15);
    }
  }

  // ------------------------------------------------------------------ cover selection
  function pickCover(e: Enemy, mode: 'fight' | 'retreat' | 'flank' | 'advance'): CoverSpot | null {
    const pp = ctx.player.position;
    const myD = e.position.distanceTo(pp);
    const pfwd = _v6.set(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw));
    let best: CoverSpot | null = null, bestS = -Infinity;
    const cands: { c: CoverSpot; s: number }[] = [];
    for (const c of covers) {
      if (c.owner >= 0 && c.owner !== e.id) continue;
      const dP = c.position.distanceTo(pp);
      if (dP < 7 || dP > 55) continue;
      const travel = c.position.distanceTo(e.position);
      if (travel > 28) continue;
      const toP = _v7.subVectors(pp, c.position).setY(0).normalize();
      const protect = -toP.dot(c.normal); // player behind the obstacle
      if (protect < 0.35) continue;
      let s = protect * 3 - travel * 0.09;
      if (mode === 'fight') s += -Math.abs(dP - 17) * 0.08;
      if (mode === 'advance') s += (myD - dP) * 0.25 - (dP < 10 ? 3 : 0);
      if (mode === 'retreat') s += (dP - myD) * 0.3;
      if (mode === 'flank') {
        const fromP = _v8.subVectors(c.position, pp).setY(0).normalize();
        s += (1 - fromP.dot(pfwd)) * 2.2 - (dP > myD + 6 ? 2 : 0);
      }
      // spread out from squadmates
      for (const o of list) if (o !== e && o.alive && o.cover && o.cover.position.distanceTo(c.position) < 3) s -= 2.5;
      if (c === e.cover) s += mode === 'fight' ? 0.8 : -3;
      s += e.rng() * 0.4;
      cands.push({ c, s });
    }
    cands.sort((a, b) => b.s - a.s);
    // verify top candidates with raycasts: hidden when crouched, visible when peeking
    for (const { c, s } of cands.slice(0, 6)) {
      const o = _v1.copy(c.position); o.y += 0.95;
      const tgt = playerChest(_v2);
      const hidden = !phys.lineOfSight(o, tgt);
      if (!hidden) continue;
      const peekO = _v3.copy(c.position); peekO.y += c.low ? 1.5 : 1.45;
      if (!c.low) { const side = _v4.set(c.normal.z, 0, -c.normal.x).multiplyScalar(0.65); peekO.add(side); }
      const canPeek = phys.lineOfSight(peekO, tgt) || (!c.low && phys.lineOfSight(peekO.addScaledVector(_v4, -2), tgt));
      const sc = s + (canPeek ? 1.5 : -1);
      if (sc > bestS) { bestS = sc; best = c; }
    }
    return best;
  }

  function takeCover(e: Enemy, c: CoverSpot, why: string, mode: Enemy['moveMode'] = 'run') {
    if (e.cover) e.cover.owner = -1;
    e.cover = c; c.owner = e.id;
    if (goTo(e, c.position, mode)) setState(e, 'move_cover', why);
    else { c.owner = -1; e.cover = null; }
  }

  const coverSafe = (c: CoverSpot) => {
    const o = _v1.copy(c.position); o.y += 0.95;
    return !phys.lineOfSight(o, playerChest(_v2));
  };

  // ------------------------------------------------------------------ shooting
  let shooters = 0;
  function fireShot(e: Enemy) {
    const vis = e.vis;
    vis.root.updateMatrixWorld(true);
    const muzzle = vis.muzzle(_v1);
    const chest = playerChest(_v2);
    const dist = muzzle.distanceTo(chest);
    const pspeed = Math.hypot(ctx.player.velocity.x, ctx.player.velocity.z);
    // accuracy model
    const settle = Math.min(1, e.targetTime / 3.5);
    let p = 0.12 + 0.46 * settle;
    p *= THREE.MathUtils.clamp(1.25 - dist / 45, 0.3, 1.1);
    p /= 1 + pspeed * 0.16;
    if (ctx.player.crouched) p *= 0.8;
    p *= 1 - e.suppression * 0.6;
    if (e.vel.lengthSq() > 1) p *= 0.45;
    if ((ctx.player as { sliding?: boolean }).sliding) p *= 0.5;
    const hit = e.rng() < p;
    const target = _v3.copy(chest);
    if (hit) {
      target.x += (e.rng() - 0.5) * 0.3; target.y += (e.rng() - 0.5) * 0.5; target.z += (e.rng() - 0.5) * 0.3;
    } else {
      // miss: pass close by (readable near misses), biased high/wide
      const side = _v4.set(chest.z - muzzle.z, 0, muzzle.x - chest.x).normalize();
      const m = 0.45 + e.rng() * 1.3;
      target.addScaledVector(side, (e.rng() < 0.5 ? -1 : 1) * m * (0.4 + e.rng() * 0.6));
      target.y += (e.rng() - 0.35) * m;
      // lead error vs moving player
      target.addScaledVector(ctx.player.velocity, -0.12 * e.rng());
    }
    const dir = _v5.subVectors(target, muzzle).normalize();
    ctx.events.emit('enemy:fire', { enemyId: e.id, origin: muzzle.clone(), dir: dir.clone() });
    vis.rifle.flash.fire(e.rng);
    flashLight(muzzle);
    vis.anim.fire(0.8 + e.rng() * 0.4);
    const h = phys.raycast(muzzle, dir, 200, { ignoreEnemies: true });
    const end = h ? h.point.clone() : muzzle.clone().addScaledVector(dir, 200);
    ctx.events.emit('bullet:tracer', { from: muzzle.clone(), to: end, enemy: true });
    if (h && (h as { player?: boolean }).player) {
      const dmg = THREE.MathUtils.lerp(TUNE.dmgMin, TUNE.dmgMax, e.rng()) * THREE.MathUtils.clamp(1.2 - dist / 80, 0.6, 1.1);
      ctx.player.damage(dmg, _v6.subVectors(e.position, ctx.player.position).setY(0).normalize().clone());
    } else {
      if (h) ctx.events.emit('bullet:impact', { point: h.point.clone(), normal: h.normal.clone(), surface: h.surface, object: h.object ?? undefined, dir: dir.clone() });
      // whizby near the player's head
      const head = playerHead(_v6);
      const t = _v7.subVectors(head, muzzle).dot(dir);
      if (t > 0 && (!h || h.distance > t)) {
        const cp = _v8.copy(muzzle).addScaledVector(dir, t);
        if (cp.distanceTo(head) < 2.4) ctx.events.emit('bullet:whizby', { point: cp.clone(), dir: dir.clone() });
      }
    }
    e.ammo--;
  }

  /** Aim & fire logic, shared by every combat state. Returns true while shooting. */
  function combatFire(e: Enemy, dt: number, allowed: boolean) {
    if (e.canSee && allowed && e.ammo > 0 && !e.vis.anim.reloading) {
      e.targetTime += dt;
      e.reaction -= dt;
      if (e.reaction <= 0) {
        if (!e.shooting) { if (shooters >= TUNE.maxShooters) return false; e.shooting = true; shooters++; }
        e.fireCd -= dt;
        if (e.fireCd <= 0) {
          if (e.burst <= 0) {
            e.burst = TUNE.burstMin + Math.floor(e.rng() * (TUNE.burstMax - TUNE.burstMin + 1));
            e.fireCd = 0.35 + e.rng() * 0.7 + e.suppression * 0.8;
            return true;
          }
          fireShot(e);
          e.burst--;
          e.fireCd = 60 / TUNE.rpm * (0.9 + e.rng() * 0.25);
        }
        return true;
      }
    } else {
      if (!e.canSee) { e.targetTime = Math.max(0, e.targetTime - dt * 0.5); e.reaction = 0.28 + e.rng() * 0.35 + (e.suppression * 0.3); }
    }
    if (e.shooting) { e.shooting = false; shooters--; }
    return false;
  }

  // ------------------------------------------------------------------ per-state behaviour
  function think(e: Enemy, dt: number) {
    e.stateT += dt;
    e.suppression = Math.max(0, e.suppression - dt * 0.18);
    const pp = ctx.player.position;
    const toP = _v9.subVectors(pp, e.position).setY(0);
    const distP = toP.length();
    const yawToP = Math.atan2(toP.x, toP.z);
    const yawToLK = Math.atan2(e.lastKnown.x - e.position.x, e.lastKnown.z - e.position.z);
    const a = e.vis.anim;
    let aimW = 0, carry = 0, crouch = 0, lean = 0, faceTarget = true, tension = 0;
    const lowHP = e.hp < 35;

    if (!e.alerted && passive) { /* dev: frozen patrol */ }
    switch (e.state) {
      case 'patrol': {
        faceTarget = false;
        if ((!e.path || atGoal(e)) && e.stateT > 2 + e.rng() * 3) {
          const r = 6 + e.rng() * 8, th = e.rng() * Math.PI * 2;
          const tgt = _v1.set(e.patrolHome.x + Math.cos(th) * r, 0, e.patrolHome.z + Math.sin(th) * r);
          if (!passive) goTo(e, tgt, 'walk');
          e.stateT = 0;
        }
        break;
      }
      case 'investigate': {
        tension = 0.6; aimW = 0.25; faceTarget = false;
        if (atGoal(e) || e.stateT > 12) { setState(e, 'patrol', 'nothing found'); e.awareness = 0.3; }
        break;
      }
      case 'alert': {
        // callout + raise weapon + turn toward threat
        e.vel.multiplyScalar(0.8);
        e.path = null;
        aimW = 0.7; tension = 1;
        e.alertDelay -= dt;
        if (e.alertDelay <= 0 && e.stateT > 0.35) {
          const c = pickCover(e, 'fight');
          if (c) takeCover(e, c, 'seek cover'); else setState(e, 'advance', 'no cover');
        }
        break;
      }
      case 'move_cover': {
        const d = e.cover ? e.cover.position.distanceTo(e.position) : 0;
        carry = d > 3 ? 1 : 0;
        aimW = d > 3 ? 0 : 0.6;
        faceTarget = d < 4;
        crouch = d < 1.5 && e.cover?.low ? 0.7 : 0;
        combatFire(e, dt, d > 6 && distP < 30 && e.id % 3 === 0); // some shoot on the move
        if (atGoal(e)) { setState(e, 'cover', 'arrived'); e.decideT = 1 + e.rng() * 1.5; e.cycles = 0; }
        if (e.stateT > 14) { setState(e, 'cover', 'timeout'); }
        break;
      }
      case 'cover': {
        // hidden: crouched behind low cover or flat against high cover
        const c = e.cover;
        if (!c) { setState(e, 'advance', 'lost cover'); break; }
        crouch = c.low ? 1 : 0.25;
        aimW = 0.3; tension = 1;
        if (e.ammo < 12 && !a.reloading) { a.startReload(2.3 + e.rng() * 0.4); e.ammo = 30; say(e, 'reloading'); }
        e.decideT -= dt;
        if (!coverSafe(c) && e.stateT > 0.8) {
          const nc = pickCover(e, lowHP ? 'retreat' : 'fight');
          if (nc && nc !== c) { takeCover(e, nc, 'cover compromised'); break; }
        }
        if (lowHP && !e.retreated) {
          const nc = pickCover(e, 'retreat');
          e.retreated = true;
          if (nc) { takeCover(e, nc, `retreat hp=${e.hp.toFixed(0)}`); setState(e, 'retreat', 'low hp'); break; }
        }
        if (e.decideT <= 0 && !a.reloading) {
          e.cycles++;
          const since = ctx.time - e.lastSeenT;
          if (since > 7 && e.cycles > 2) { setState(e, 'search', 'lost contact'); goTo(e, e.lastKnown, 'walk'); break; }
          const r = e.rng();
          if (e.cycles > 2 && r < 0.22 && list.filter((o) => o.alive).length > 1) {
            const nc = pickCover(e, 'flank');
            if (nc && nc !== c) { takeCover(e, nc, 'flanking'); setState(e, 'flank'); break; }
          } else if (e.cycles > 2 && r < 0.4 && distP > 14) {
            const nc = pickCover(e, 'advance');
            if (nc && nc !== c) { takeCover(e, nc, 'advancing'); break; }
          }
          // peek
          if (e.suppression > 0.65 && e.rng() < 0.6) { e.decideT = 0.8 + e.rng(); say(e, `pinned (supp ${e.suppression.toFixed(2)})`); break; }
          setState(e, 'peek');
          e.reaction = 0.3 + e.rng() * 0.35;
          e.peekSide = c.low ? 0 : peekSideFor(c);
          e.decideT = 1.6 + e.rng() * 1.6;
        }
        break;
      }
      case 'peek': {
        const c = e.cover;
        if (!c) { setState(e, 'advance'); break; }
        crouch = c.low ? 0.05 : 0;
        lean = c.low ? 0 : e.peekSide;
        aimW = 1; tension = 1;
        const firing = combatFire(e, dt, e.stateT > 0.25);
        e.decideT -= dt;
        if ((e.decideT <= 0 && !firing && e.burst <= 0) || e.suppression > 0.8 || (e.stateT > 1.2 && !e.canSee) || e.ammo <= 0) {
          if (e.shooting) { e.shooting = false; shooters--; }
          setState(e, 'cover', e.ammo <= 0 ? 'empty' : e.suppression > 0.8 ? 'suppressed' : 'duck');
          e.decideT = 0.9 + e.rng() * 1.8 + e.suppression * 3;
        }
        break;
      }
      case 'flank':
      case 'retreat': {
        carry = 1; faceTarget = false;
        if (atGoal(e)) { setState(e, 'cover', 'in position'); e.decideT = 0.5; }
        if (e.stateT > 16) setState(e, 'cover', 'timeout');
        break;
      }
      case 'advance': {
        // no cover: walk toward the player while shooting
        aimW = 1; tension = 1;
        if (!e.path || atGoal(e) || e.stateT > 3) {
          const c = pickCover(e, 'fight');
          if (c) { takeCover(e, c, 'found cover'); break; }
          if (distP > 12) goTo(e, _v1.copy(pp).addScaledVector(toP.normalize(), -10), 'walk');
          e.stateT = 0;
        }
        combatFire(e, dt, true);
        break;
      }
      case 'search': {
        aimW = 0.8; tension = 1; faceTarget = false;
        if (e.canSee) { const c = pickCover(e, 'fight'); if (c) takeCover(e, c, 'reacquired'); else setState(e, 'advance', 'reacquired'); break; }
        if (!e.path || atGoal(e)) {
          if (e.stateT > 6) { goTo(e, _v1.copy(e.lastKnown).add(new THREE.Vector3((e.rng() - 0.5) * 10, 0, (e.rng() - 0.5) * 10)), 'walk'); e.stateT = 0; }
        }
        break;
      }
    }
    if (e.state !== 'peek' && e.state !== 'advance' && e.state !== 'move_cover' && e.shooting) { e.shooting = false; shooters--; }

    // facing
    const moving = e.vel.lengthSq() > 0.3;
    let wantYaw = e.yaw;
    if (e.alerted && faceTarget) wantYaw = e.canSee ? yawToP : yawToLK;
    else if (moving) wantYaw = Math.atan2(e.vel.x, e.vel.z);
    if (e.state === 'cover' && e.cover) wantYaw = Math.atan2(-e.cover.normal.x, -e.cover.normal.z) * 0.3 + (e.canSee ? yawToP : yawToLK) * 0.7;
    faceYaw(e, wantYaw, moving ? 4 : 6, dt);
    e.vis.root.rotation.y = e.yaw;

    // anim params
    const aimDir = _v1;
    if (e.alerted) {
      const tgt = e.canSee ? playerChest(_v2) : _v2.copy(e.lastKnown).setY(e.lastKnown.y + 1.2);
      e.vis.eye(_v3);
      aimDir.subVectors(tgt, _v3).normalize();
      if (!faceTarget && moving) aimDir.set(Math.sin(e.yaw), -0.1, Math.cos(e.yaw)).normalize();
    } else {
      aimDir.set(Math.sin(e.yaw + Math.sin(ctx.time * 0.4 + e.id) * 0.5), -0.08, Math.cos(e.yaw + Math.sin(ctx.time * 0.4 + e.id) * 0.5)).normalize();
    }
    a.aimDir.copy(aimDir);
    a.aim = aimW; a.carry = e.moveMode === 'run' && moving ? Math.max(carry, 0.8) : carry;
    a.crouch = crouch + e.suppression * 0.3 * (e.state === 'cover' ? 1 : 0);
    a.lean = lean; a.tension = tension;
    distP;
  }

  function peekSideFor(c: CoverSpot): -1 | 1 {
    const tgt = playerChest(_v2);
    const right = _v4.set(c.normal.z, 0, -c.normal.x); // 90deg from normal
    for (const s of [1, -1] as const) {
      const o = _v3.copy(c.position).addScaledVector(right, 0.65 * s); o.y += 1.45;
      if (phys.lineOfSight(o, tgt)) {
        // lean param +1 = character's right; character faces -normal, its right = cross(fwd, up)...
        const fwd = _v5.copy(c.normal).negate();
        const charRight = _v6.set(-fwd.z, 0, fwd.x);
        return (charRight.dot(right) * s > 0 ? 1 : -1);
      }
    }
    return 1;
  }

  // ------------------------------------------------------------------ damage / death
  function die(e: Enemy, point: THREE.Vector3, dir: THREE.Vector3, headshot: boolean, force: number) {
    e.alive = false;
    e.hp = 0;
    if (e.shooting) { e.shooting = false; shooters--; }
    if (e.cover) { e.cover.owner = -1; e.cover = null; }
    phys.unregisterHitboxes(e.id);
    setState(e, 'dead', headshot ? 'headshot' : 'killed');
    const vis = e.vis;
    vis.animated = false;
    try {
      e.ragdoll = new Ragdoll(ctx, vis.anim.modelRot, vis.anim.modelPos, vis.root, vis.scale, e.vel.clone());
      const imp = dir.clone().setY(Math.max(dir.y, 0.05)).normalize().multiplyScalar(force);
      e.ragdoll.impulse(point, imp);
    } catch (err) {
      console.warn('[ai] ragdoll failed', err);
      e.ragdoll = null;
    }
    dropRifle(e, dir);
    e.deadT = 0;
  }

  function dropRifle(e: Enemy, dir: THREE.Vector3) {
    const g = e.vis.rifle.group;
    g.updateMatrixWorld(true);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    g.matrixWorld.decompose(wp, wq, ws);
    ctx.scene.add(g);
    g.position.copy(wp); g.quaternion.copy(wq); g.scale.set(1, 1, 1);
    e.vis.rifle.flash.group.visible = false;
    const center = new THREE.Vector3(0, 0.03, 0.12).applyQuaternion(wq);
    try {
      phys.spawnDynamic({ shape: 'box', halfExtents: new THREE.Vector3(0.025, 0.07, 0.45), colliderOffset: center.applyQuaternion(wq.clone().invert()), position: wp, quaternion: wq, velocity: dir.clone().multiplyScalar(1.5).add(e.vel), angularVelocity: new THREE.Vector3(e.rng() * 4 - 2, e.rng() * 4 - 2, e.rng() * 4 - 2), mass: 3.5, kind: 'prop', object: g, lifetime: TUNE.corpseTime + 3, surface: 'metal', onRemove: () => g.removeFromParent() });
    } catch { /* physics without dynamics: leave it in place */ }
  }

  function removeCorpse(e: Enemy) {
    e.ragdoll?.dispose();
    e.ragdoll = null;
    e.vis.root.removeFromParent();
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    const j = enemies.indexOf(e);
    if (j >= 0) enemies.splice(j, 1);
    byId.delete(e.id);
  }

  // ------------------------------------------------------------------ initial wave
  if (count > 0) spawnWave();

  const mgr: EnemyManagerExt = {
    enemies,
    applyHit(enemyId, damage, point, dir, region) {
      const e = byId.get(enemyId);
      if (!e || !e.alive) return;
      const mult = region === 'head' ? TUNE.headMult : region === 'limb' ? TUNE.limbMult : 1;
      const dmg = damage * mult;
      e.hp -= dmg;
      const killed = e.hp <= 0;
      const headshot = region === 'head';
      ctx.events.emit('enemy:hit', { enemyId, point: point.clone(), normal: dir.clone().negate(), dir: dir.clone(), damage: dmg, headshot, killed });
      if (killed) {
        die(e, point, dir, headshot, THREE.MathUtils.clamp(dmg * 1.4, 30, 110) * (headshot ? 1.2 : 1));
        ctx.events.emit('enemy:killed', { enemyId, headshot, position: e.position.clone(), weaponId: ctx.weapons?.currentId ?? 'unknown' });
        say(e, `killed (${region}, ${dmg.toFixed(0)} dmg)`);
      } else {
        e.vis.anim.hitReact(dir, e.vis.root.quaternion, Math.min(1.5, dmg / 25));
        e.suppression = Math.min(1, e.suppression + 0.35);
        e.lastKnown.copy(ctx.player.position);
        e.reaction = Math.max(e.reaction, 0.35);
        e.targetTime *= 0.5;
        if (!e.alerted) alert(e, 'wounded', 0.2);
        say(e, `hit ${region} ${dmg.toFixed(0)} hp=${e.hp.toFixed(0)}`);
      }
    },
    update(dt) {
      if (dt <= 0) dt = 0;
      dt = Math.min(dt, 0.1);
      for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { const f = timers[i].fn; timers.splice(i, 1); f(); } }
      for (const l of lights) { if (l.t > 0) { l.t -= dt; if (l.t <= 0) l.l.intensity = 0; } }
      const ground = (x: number, z: number) => ctx.world.groundHeight(x, z);
      let alive = 0;
      for (const e of list.slice()) {
        if (e.alive) {
          alive++;
          e.footT -= dt;
          if (!passive) perceive(e, dt);
          think(e, passive ? 0 : dt);
          if (!passive) steer(e, dt); else e.vel.set(0, 0, 0);
          e.vis.velocity.copy(e.vel);
          e.vis.update(dt, ground);
        } else {
          e.deadT += dt;
          e.vis.update(dt, ground);
          if (e.ragdoll) {
            e.ragdoll.age += dt;
            e.ragdoll.sync(e.vis.anim.modelRot, e.vis.anim.modelPos);
            e.vis.anim.apply(e.vis.char.bones);
            // fade: settle, then sink below ground and remove
            if (e.deadT > TUNE.corpseTime) {
              if (e.ragdoll.alive && e.deadT > TUNE.corpseTime) { e.ragdoll.dispose(); }
            }
          }
          if (e.deadT > TUNE.corpseTime) {
            e.vis.root.position.y -= dt * 0.35;
            if (e.deadT > TUNE.corpseTime + 2.5) removeCorpse(e);
          }
        }
        e.vis.root.updateMatrixWorld(true);
      }
      phys.invalidateHitboxes?.();
      if (count > 0 && alive === 0) {
        if (waveT < 0) waveT = TUNE.waveDelay;
        waveT -= dt;
        if (waveT <= 0) { waveT = -1; spawnWave(); }
      }
    },
    debug: {
      list, log, nav, covers, spawn,
      setPassive(p: boolean) { passive = p; },
      kill(id: number, dir = new THREE.Vector3(0, 0, -1)) {
        const e = byId.get(id);
        if (!e) return;
        const p = new THREE.Vector3();
        e.vis.anim.boneWorld(B.spine2, e.vis.root, e.vis.scale, p);
        mgr.applyHit(id, 1000, p, dir.clone().normalize(), 'torso');
      },
    },
  };
  return mgr;
}

let DEBUG_LOG = new URLSearchParams(location.search).has('ailog');
export function setAiLogging(on: boolean) { DEBUG_LOG = on; }

const _o = new THREE.Vector3(), _dn = new THREE.Vector3(0, -1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3(), _v9 = new THREE.Vector3();

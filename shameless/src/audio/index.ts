import * as THREE from 'three';
import type { AudioSystem, GameContext } from '../core/types';
import { SOUND_DEFS, renderBank, type SoundDef } from './bank';
import { AudioEngine, type Vec3 } from './engine';
import { AudioDirector } from './director';

export { AudioEngine } from './engine';
export { AudioDirector, weaponClass } from './director';

/** Dev/test handle to the live engine (read by src/dev/scenes/audio-game.ts). */
export const audioDebug: { engine?: AudioEngine; director?: AudioDirector; ctx?: AudioContext; ready?: Promise<void>; criticalMs?: number } = {};

/**
 * Audio system: every sound is synthesized at startup into sample banks (OfflineAudioContext,
 * several variations each), then mixed live through HRTF panners, procedural-IR reverb,
 * ducking buses and a master compressor/limiter. See engine.ts for the graph.
 */
export async function createAudio(ctx: GameContext): Promise<AudioSystem> {
  let ac: AudioContext;
  try {
    ac = new AudioContext({ latencyHint: 'interactive' });
  } catch (e) {
    console.warn('[audio] WebAudio unavailable', e);
    return { async resume() {}, setMasterVolume() {}, update() {} };
  }

  const engine = new AudioEngine(ac);
  engine.hrtf = ctx.quality.tier >= 1;
  engine.maxVoices = ctx.quality.tier >= 2 ? 64 : 40;

  const up = new THREE.Vector3(0, 1, 0);
  const tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3();
  const raycast = (o: Vec3, d: Vec3, max: number) => {
    const phys = ctx.physics;
    if (!phys) return null;
    tmpO.set(o.x, o.y, o.z); tmpD.set(d.x, d.y, d.z).normalize();
    const h = phys.raycast(tmpO, tmpD, max, { ignorePlayer: true, ignoreEnemies: true });
    return h ? { distance: h.distance, surface: h.surface, point: { x: h.point.x, y: h.point.y, z: h.point.z } } : null;
  };
  const director = new AudioDirector(engine, { raycast });

  // --- sample banks: rendered in the background (critical sounds first) so game startup isn't blocked ---
  const sr = ac.sampleRate;
  const add = (d: SoundDef, bufs: AudioBuffer[]) => engine.addSound(d.name, bufs, d);
  const t0 = performance.now();
  audioDebug.engine = engine; audioDebug.director = director; audioDebug.ctx = ac;
  audioDebug.ready = renderBank(SOUND_DEFS.filter((d) => d.tier === 0), sr, add, 3)
    .then(() => { audioDebug.criticalMs = performance.now() - t0; return renderBank(SOUND_DEFS.filter((d) => d.tier === 1), sr, add, 2); })
    .then(() => { console.info(`[audio] banks ready: critical ${audioDebug.criticalMs?.toFixed(0)} ms, all ${(performance.now() - t0).toFixed(0)} ms`); });

  // --- events ---
  const ev = ctx.events;
  const D = director;
  ev.on('weapon:fire', (e) => D.fire(e));
  ev.on('weapon:dryfire', (e) => D.dryfire(e));
  ev.on('weapon:reload', (e) => D.reload(e));
  ev.on('weapon:ads', (e) => D.ads(e));
  ev.on('weapon:switch', (e) => D.switchWeapon(e));
  ev.on('shell:eject', (e) => D.shell(e));
  ev.on('bullet:tracer', (e) => D.tracer(e));
  ev.on('bullet:impact', (e) => D.impact(e));
  ev.on('bullet:whizby', (e) => D.whiz(e));
  ev.on('enemy:hit', (e) => D.enemyHit(e));
  ev.on('enemy:killed', (e) => D.enemyKilled(e));
  ev.on('enemy:fire', (e) => D.enemyFire(e));
  ev.on('enemy:alert', (e) => D.enemyAlert(e));
  ev.on('enemy:footstep', (e) => D.enemyFootstep(e));
  ev.on('player:damaged', (e) => D.damaged(e));
  ev.on('player:died', () => D.died());
  ev.on('player:respawn', () => D.respawn());
  ev.on('player:footstep', (e) => D.footstep(e));
  ev.on('player:jump', (e) => D.jump(e));
  ev.on('player:land', (e) => D.land(e));
  ev.on('player:slide', (e) => D.slide(e));
  ev.on('grenade:throw', (e) => D.grenadeThrow(e));
  ev.on('grenade:bounce', (e) => D.grenadeBounce(e));
  ev.on('explosion', (e) => D.explosion(e));
  ev.on('game:state', (e) => D.gameState(e));

  // UI feedback without a dedicated event: menu buttons anywhere in the document.
  const isButton = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, [role="button"], [data-sfx]');
  document.addEventListener('click', (e) => { if (isButton(e.target)) D.uiClick(); }, true);
  document.addEventListener('pointerover', (e) => { if (isButton(e.target) && !(e.relatedTarget instanceof Element && isButton(e.relatedTarget) && (e.relatedTarget as Element).closest('button') === (e.target as Element).closest('button'))) D.uiHover(); }, true);
  // Browsers only allow audio after a gesture; resume on the first one even if main.ts doesn't call resume().
  const kick = () => { if (ac.state !== 'running') void ac.resume(); };
  window.addEventListener('pointerdown', kick, true);
  window.addEventListener('keydown', kick, true);

  // --- environment probe: indoor/outdoor from raycasts around the listener ---
  const camPos = new THREE.Vector3(), fwd = new THREE.Vector3(), camUp = new THREE.Vector3(), right = new THREE.Vector3();
  const probeDirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
  let probeTimer = 0, indoorTarget = 0, indoor = 0;
  const probe = () => {
    if (!ctx.physics) return;
    const roof = ctx.physics.raycast(camPos, up, 40, { ignorePlayer: true, ignoreEnemies: true });
    let walls = 0, wallDist = 0;
    for (const d of probeDirs) {
      const h = ctx.physics.raycast(camPos, d, 25, { ignorePlayer: true, ignoreEnemies: true });
      if (h) { walls++; wallDist += h.distance; }
    }
    const avg = walls ? wallDist / walls : 25;
    if (roof) indoorTarget = walls >= 3 && avg < 14 ? 1 : walls >= 2 ? 0.7 : 0.45;
    else indoorTarget = walls >= 3 && avg < 6 ? 0.25 : 0; // narrow alley: a touch of slap
  };

  let started = false;
  return {
    async resume() {
      if (ac.state !== 'running') await ac.resume();
      if (!started) { started = true; director.wantAmbience = true; director.startAmbience(); }
    },
    setMasterVolume(v: number) {
      engine.master.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), ac.currentTime, 0.03);
    },
    update(dt: number) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      camPos.setFromMatrixPosition(cam.matrixWorld);
      fwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
      camUp.set(0, 1, 0).transformDirection(cam.matrixWorld);
      right.crossVectors(fwd, camUp).normalize();
      engine.setListener(camPos, fwd, camUp);
      director.right = { x: right.x, y: right.y, z: right.z };
      probeTimer -= dt;
      if (probeTimer <= 0) {
        probeTimer = 0.2;
        try { probe(); } catch { /* physics mid-change */ }
      }
      const k = 1 - Math.exp(-dt / 0.35);
      indoor += (indoorTarget - indoor) * k;
      if (Math.abs(indoor - engine.indoor) > 0.02) engine.setIndoor(indoor);
      const p = ctx.player;
      director.update(dt, p ? { health: p.health, maxHealth: p.maxHealth, alive: p.alive } : null);
    },
  };
}

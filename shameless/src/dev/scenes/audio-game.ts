import * as THREE from 'three';
import { createGame, tick } from '../../core/Game';
import { audioDebug } from '../../audio';

/**
 * Audio integration check inside the real game: builds the full game, resumes audio, fires a scripted
 * sequence of gameplay events through ctx.events and reports engine state (voices, indoor factor, errors).
 */
export default async function (container: HTMLElement, uiRoot: HTMLElement) {
  const t0 = performance.now();
  const ctx = await createGame({ container, uiRoot, shotMode: true, noEnemies: true });
  const buildMs = performance.now() - t0;
  window.__shameless.ctx = ctx;
  const E = audioDebug.engine!;
  let phase = 'resuming';
  const tRes = performance.now();
  let resumeMs = -1, banksMs = -1;
  void ctx.audio.resume().then(() => { resumeMs = performance.now() - tRes; phase = 'banks'; return audioDebug.ready; })
    .then(() => { banksMs = performance.now() - tRes; phase = 'script'; script(); });
  const errors: string[] = [];
  let maxVoices = 0;
  let updateMs = 0, updates = 0;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const script = () => {
    const ev = ctx.events;
    const cam = ctx.camera.getWorldPosition(new THREE.Vector3());
    const fwd = ctx.camera.getWorldDirection(new THREE.Vector3());
    const at = (ms: number, fn: () => void) => setTimeout(() => { try { fn(); } catch (e) { errors.push(String(e)); } }, ms);
    for (let i = 0; i < 25; i++) at(100 + i * 80, () => {
      ev.emit('weapon:fire', { weaponId: 'm4', origin: cam, dir: fwd, muzzle: cam, suppressed: false });
      ev.emit('shell:eject', { position: cam.clone().add(V(0.1, -0.2, 0)), velocity: V(1.5, 1, 0), kind: 'rifle' });
      ev.emit('bullet:impact', { point: cam.clone().addScaledVector(fwd, 20), normal: V(0, 1, 0), surface: i % 2 ? 'concrete' : 'metal', dir: fwd });
    });
    at(2300, () => ev.emit('enemy:hit', { enemyId: 1, point: cam.clone().addScaledVector(fwd, 15), normal: V(0, 0, 1), dir: fwd, damage: 30, headshot: false, killed: false }));
    at(2400, () => ev.emit('enemy:killed', { enemyId: 1, headshot: true, position: cam.clone().addScaledVector(fwd, 15), weaponId: 'm4' }));
    at(2600, () => ev.emit('enemy:fire', { enemyId: 2, origin: cam.clone().add(V(30, 0, -30)), dir: V(-1, 0, 1).normalize() }));
    at(2650, () => ev.emit('bullet:tracer', { from: cam.clone().add(V(30, 0, -30)), to: cam.clone().add(V(-5, 0.5, 5)), enemy: true }));
    at(2800, () => ev.emit('explosion', { position: cam.clone().add(V(5, -1, -5)), radius: 6, damage: 80 }));
    at(3000, () => ev.emit('player:damaged', { amount: 30, health: 20, fromDir: V(1, 0, 0) }));
    at(3200, () => ev.emit('weapon:reload', { weaponId: 'm4', stage: 'magout', empty: true }));
    at(3300, () => { for (let k = 0; k < 8; k++) ev.emit('player:footstep', { surface: 'gravel', position: cam, speed: 6, sprinting: true, crouched: false }); });
    at(3400, () => ev.emit('game:state', { state: 'playing' }));
  };
  const origUpdate = ctx.audio.update.bind(ctx.audio);
  ctx.audio.update = (dt: number) => {
    const a = performance.now();
    try { origUpdate(dt); } catch (e) { errors.push(String(e)); }
    updateMs += performance.now() - a; updates++;
  };

  let last = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = window.__shameless.fixedDt ?? Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(ctx, dt);
    maxVoices = Math.max(maxVoices, E.voices.filter((v) => !v.done && v.end > E.now).length);
    window.__shameless.frame++;
  };
  requestAnimationFrame(loop);
  window.__shameless.api = {
    stats: () => ({
      phase, resumeMs, banksMs, buildMs, criticalMs: audioDebug.criticalMs, state: audioDebug.ctx?.state, sampleRate: audioDebug.ctx?.sampleRate, banks: E.banks.size,
      voices: E.voices.length, maxVoices, indoor: E.indoor, audioUpdateMsAvg: updateMs / Math.max(1, updates), errors,
      listener: { ...E.listener },
    }),
  };
  window.__shameless.ready = true;
}

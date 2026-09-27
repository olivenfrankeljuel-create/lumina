import type { GameContext } from '../core/types';

export interface Settings {
  /** 1..20, 5 == Input default (0.0022 rad/px) */
  sensitivity: number;
  fov: number;
  /** 0..100 */
  volume: number;
  quality: 0 | 1 | 2 | 3;
  minimapRotate: boolean;
}

export const DEFAULTS: Settings = { sensitivity: 5, fov: 75, volume: 80, quality: 2, minimapRotate: true };
const KEY = 'shameless.settings.v1';

export function loadSettings(ctx: GameContext): Settings {
  let s: Settings = { ...DEFAULTS, quality: ctx.quality.tier };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch { /* private mode etc. */ }
  // An explicit ?q= in the URL wins over the stored preference.
  if (new URLSearchParams(location.search).has('q')) s.quality = ctx.quality.tier;
  return s;
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const QUALITY_NAMES = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'] as const;

/** Push settings into the running game (all of them, or just `changed`). */
export function applySettings(ctx: GameContext, s: Settings, changed?: keyof Settings): void {
  if (!changed || changed === 'sensitivity') ctx.input.sensitivity = 0.0022 * (s.sensitivity / 5);
  if (!changed || changed === 'volume') {
    try { ctx.audio.setMasterVolume(s.volume / 100); } catch { /* audio may be a stub */ }
  }
  if (!changed || changed === 'fov') {
    // NOTE: the player camera may lerp FOV itself; see contract note in the UI report.
    ctx.camera.fov = s.fov;
    ctx.camera.updateProjectionMatrix();
  }
  if (changed === 'quality') {
    const tier = s.quality;
    ctx.quality.tier = tier;
    ctx.quality.pixelRatio = Math.min(window.devicePixelRatio, tier >= 3 ? 2 : tier === 2 ? 1.5 : 1);
    ctx.quality.shadowMapSize = tier >= 3 ? 4096 : tier === 2 ? 2048 : 1024;
    ctx.renderer.setPixelRatio(ctx.quality.pixelRatio);
    // Game.ts listens for resize and forwards to renderer + pipeline.setSize.
    window.dispatchEvent(new Event('resize'));
  }
}

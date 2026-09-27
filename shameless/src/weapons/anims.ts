import { Track, Key, easeInOut, easeOut, easeIn, easeOutBack } from './math';

/**
 * Keyframed animation data. All transforms are Xf = [x, y, z, pitch, yaw, roll] (radians, YXZ order).
 *  gun  : camera-space offset added to the weapon pose (rotation about the weapon pivot)
 *  mag  : weapon-space transform of the magazine held by the off hand
 *  left : weapon-space free wrist transform (used where onMag < 1); special key values are resolved at runtime:
 *         'G' = handguard grip, 'M' = mag grip at the seated position
 */
export type Stage = 'magout' | 'magin' | 'bolt';
export interface ReloadAnim {
  duration: number;
  events: [number, Stage][];
  gun: Track;
  /** mag held by the hand (old mag while extracting, new one while inserting) */
  magPath: Track;
  /** old mag: [start pull, hidden at]; if drop = true the old mag falls freely from dropAt */
  oldMagHandFrom: number;
  oldMagHiddenAt: number;
  drop: boolean;
  dropAt: number;
  newMagFrom: number;
  seatAt: number;
  left: Track;
  onMag: Track;
  /** hand pose weights [grip, magGrip, flat, relaxed] */
  pose: Track;
  /** right-hand index off the trigger (0..1) */
  indexOff: Track;
  boltCatch?: Track;
  /** time the bolt/slide is released (empty) */
  boltAt?: number;
}

const Z6 = [0, 0, 0, 0, 0, 0];
const k = (t: number, v: number[], e?: (t: number) => number): Key => [t, v, e];

// Sentinel encodings for runtime-resolved wrist keys (x = 1000 -> grip, 2000 -> mag seat grip).
export const GRIP = [1000, 0, 0, 0, 0, 0];
export const MAGSEAT = [2000, 0, 0, 0, 0, 0];

export function rifleReload(empty: boolean): ReloadAnim {
  const S = [0, -0.0035, -0.1125, 0, 0, 0];
  if (!empty) {
    return {
      duration: 2.2,
      events: [[0.5, 'magout'], [1.4, 'magin']],
      gun: new Track([
        k(0, Z6), k(0.3, [-0.022, 0.028, 0.012, 0.12, 0.10, -0.46]), k(0.42, [-0.024, 0.030, 0.014, 0.13, 0.10, -0.47]),
        k(0.56, [-0.026, 0.040, 0.012, 0.16, 0.11, -0.50], easeOut), k(0.8, [-0.028, 0.032, 0.012, 0.12, 0.12, -0.52]),
        k(1.2, [-0.03, 0.030, 0.010, 0.11, 0.12, -0.55]), k(1.4, [-0.03, 0.022, 0.012, 0.12, 0.12, -0.52], easeIn),
        k(1.52, [-0.03, 0.046, 0.010, 0.20, 0.12, -0.53], easeOut), k(1.72, [-0.022, 0.024, 0.01, 0.09, 0.08, -0.36]),
        k(2.2, Z6),
      ]),
      magPath: new Track([
        k(0.38, S), k(0.52, [0, -0.062, -0.108, -0.08, 0, 0], easeIn), k(0.64, [-0.035, -0.16, -0.09, -0.35, 0.2, 0.45]),
        k(0.85, [-0.11, -0.34, -0.03, -0.8, 0.5, 1.0], easeIn),
        k(1.0, [-0.09, -0.32, -0.08, 0.5, 0.3, 0.8]), k(1.2, [-0.012, -0.105, -0.12, 0.22, 0.05, 0.1], easeOut),
        k(1.32, [0, -0.036, -0.118, 0.10, 0, 0]), k(1.4, [0, -0.0075, -0.1125, 0, 0, 0], easeIn), k(1.52, S, easeOut),
      ]),
      oldMagHandFrom: 0.38, oldMagHiddenAt: 0.9, drop: false, dropAt: 99, newMagFrom: 0.9, seatAt: 1.52,
      left: new Track([k(0, GRIP), k(0.3, MAGSEAT), k(1.52, MAGSEAT), k(1.62, [-0.04, -0.125, -0.12, 0.3, 0, -0.4]), k(1.95, GRIP)]),
      onMag: new Track([k(0, [0]), k(0.28, [0]), k(0.3, [1]), k(1.52, [1]), k(1.56, [0])]),
      pose: new Track([k(0, [1, 0, 0, 0]), k(0.22, [0, 0, 0, 1]), k(0.32, [0, 1, 0, 0]), k(1.5, [0, 1, 0, 0]), k(1.6, [0, 0, 0, 1]), k(1.9, [1, 0, 0, 0])]),
      indexOff: new Track([k(0, [0]), k(0.2, [1]), k(1.9, [1]), k(2.15, [0])]),
    };
  }
  return {
    duration: 2.8,
    events: [[0.22, 'magout'], [1.24, 'magin'], [1.9, 'bolt']],
    gun: new Track([
      k(0, Z6), k(0.22, [-0.02, 0.026, 0.012, 0.12, 0.10, -0.45]), k(0.3, [-0.02, 0.034, 0.012, 0.15, 0.10, -0.47], easeOut),
      k(1.0, [-0.028, 0.03, 0.01, 0.10, 0.12, -0.55]), k(1.24, [-0.03, 0.022, 0.012, 0.12, 0.12, -0.52], easeIn),
      k(1.34, [-0.03, 0.044, 0.01, 0.19, 0.12, -0.53], easeOut), k(1.6, [-0.03, 0.03, 0.02, 0.1, 0.25, -0.72]),
      k(1.86, [-0.032, 0.028, 0.02, 0.1, 0.26, -0.74]), k(1.92, [-0.03, 0.036, 0.03, 0.16, 0.24, -0.70], easeOut),
      k(2.25, [-0.02, 0.02, 0.01, 0.07, 0.1, -0.35]), k(2.8, Z6),
    ]),
    magPath: new Track([
      k(0.55, [-0.1, -0.33, -0.05, 0.6, 0.3, 0.8]), k(0.9, [-0.09, -0.30, -0.08, 0.5, 0.3, 0.8]),
      k(1.05, [-0.012, -0.105, -0.12, 0.22, 0.05, 0.1], easeOut), k(1.16, [0, -0.036, -0.118, 0.10, 0, 0]),
      k(1.24, [0, -0.0075, -0.1125, 0, 0, 0], easeIn), k(1.34, S, easeOut),
    ]),
    oldMagHandFrom: 99, oldMagHiddenAt: 1.2, drop: true, dropAt: 0.2, newMagFrom: 0.55, seatAt: 1.34,
    left: new Track([
      k(0, GRIP), k(0.5, [-0.09, -0.30, 0.02, 0.5, 0.2, -1.2]), k(0.55, [-0.1, -0.32, 0.03, 0.5, 0.2, -1.2]),
      k(0.9, MAGSEAT), k(1.34, MAGSEAT),
      // palm to the bolt catch (left side of the lower), fingers up/forward
      k(1.62, [-0.075, -0.035, -0.055, 0.0, 1.35, -0.3]), k(1.84, [-0.052, -0.030, -0.067, 0.0, 1.35, -0.25], easeIn),
      k(1.92, [-0.05, -0.030, -0.072, 0.0, 1.35, -0.25], easeOut), k(2.05, [-0.07, -0.05, -0.1, 0.0, 1.2, -0.3]),
      k(2.4, GRIP),
    ]),
    onMag: new Track([k(0, [0]), k(0.55, [0]), k(0.56, [1]), k(1.34, [1]), k(1.4, [0])]),
    pose: new Track([k(0, [1, 0, 0, 0]), k(0.2, [0, 0, 0, 1]), k(0.5, [0, 1, 0, 0]), k(1.34, [0, 1, 0, 0]), k(1.5, [0, 0, 1, 0]), k(2.0, [0, 0, 1, 0]), k(2.35, [1, 0, 0, 0])]),
    indexOff: new Track([k(0, [0]), k(0.1, [0.4]), k(0.2, [1]), k(2.5, [1]), k(2.75, [0])]),
    boltCatch: new Track([k(0, [0]), k(1.86, [0]), k(1.9, [1]), k(2.0, [0])]),
    boltAt: 1.9,
  };
}

export function pistolReload(empty: boolean, seat: number[]): ReloadAnim {
  const S = seat;
  const A = (d: number) => [S[0], S[1] - d * 0.98, S[2] + d * 0.2, S[3], S[4], S[5]];
  const dur = empty ? 1.95 : 1.65;
  return {
    duration: dur,
    events: empty ? [[0.18, 'magout'], [1.0, 'magin'], [1.45, 'bolt']] : [[0.18, 'magout'], [1.0, 'magin']],
    gun: new Track([
      k(0, Z6), k(0.2, [-0.03, 0.03, 0.02, 0.18, 0.28, -0.32]), k(0.9, [-0.035, 0.035, 0.02, 0.2, 0.3, -0.36]),
      k(1.0, [-0.035, 0.028, 0.02, 0.18, 0.3, -0.34], easeIn), k(1.08, [-0.035, 0.05, 0.02, 0.26, 0.3, -0.35], easeOut),
      ...(empty ? [k(1.4, [-0.03, 0.035, 0.03, 0.2, 0.2, -0.2]), k(1.47, [-0.03, 0.045, 0.04, 0.3, 0.2, -0.18], easeOut)] : []),
      k(dur, Z6),
    ]),
    magPath: new Track([
      k(0.45, [-0.06, -0.30, 0.06, 0.4, 0.3, 0.6]), k(0.75, [-0.03, -0.16, 0.03, 0.1, 0.1, 0.2], easeOut),
      k(0.9, A(0.04)), k(1.0, A(0.004), easeIn), k(1.08, S, easeOut),
    ]),
    oldMagHandFrom: 99, oldMagHiddenAt: 0.9, drop: true, dropAt: 0.16, newMagFrom: 0.45, seatAt: 1.08,
    left: new Track([
      k(0, GRIP), k(0.35, [-0.07, -0.28, 0.07, 0.4, 0.2, -1.0]), k(0.45, MAGSEAT), k(1.08, MAGSEAT),
      k(1.2, [-0.06, -0.10, 0.02, 0.2, 0.2, -0.8]), k(dur - 0.15, GRIP),
    ]),
    onMag: new Track([k(0, [0]), k(0.45, [0]), k(0.46, [1]), k(1.08, [1]), k(1.14, [0])]),
    pose: new Track([k(0, [1, 0, 0, 0]), k(0.2, [0, 0, 0, 1]), k(0.42, [0, 1, 0, 0]), k(1.08, [0, 1, 0, 0]), k(1.2, [0, 0, 0, 1]), k(dur - 0.1, [1, 0, 0, 0])]),
    indexOff: new Track([k(0, [0]), k(0.12, [1]), k(dur - 0.25, [1]), k(dur - 0.05, [0])]),
    boltAt: empty ? 1.45 : undefined,
  };
}

/** Inspect: show the left side, then roll over to the right side (ejection port), then back. */
export function inspectTrack(kind: 'rifle' | 'pistol'): Track {
  const s = kind === 'pistol' ? 1.25 : 1;
  return new Track([
    k(0, Z6), k(0.7, [-0.05, 0.05 * s, 0.05, 0.22, 0.95, 0.38], easeInOut), k(1.5, [-0.055, 0.056 * s, 0.055, 0.28, 1.0, 0.44]),
    k(2.2, [0.005, 0.06 * s, 0.04, 0.22, -0.55, -1.15], easeInOut), k(2.9, [0.0, 0.056 * s, 0.045, 0.25, -0.6, -1.2]),
    k(3.5, Z6, easeInOut),
  ]);
}

export function switchTrack(): { lower: Track; raise: Track } {
  const low = [0.01, -0.2, 0.06, -0.75, 0.15, 0.35];
  return {
    lower: new Track([k(0, Z6), k(0.26, low, easeIn)]),
    raise: new Track([k(0, low), k(0.42, Z6, easeOutBack)]),
  };
}

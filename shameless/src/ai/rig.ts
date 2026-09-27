/**
 * Humanoid rig definition (25 bones). Bind pose has identity bone rotations; each bone's frame is aligned with
 * the character's model space (+Y up, +Z forward, +X = character's LEFT). Posing is done in model space
 * (see pose.ts) and converted to local quaternions.
 */
import * as THREE from 'three';

export const B = {
  root: 0, hips: 1, spine: 2, spine1: 3, spine2: 4, neck: 5, head: 6,
  clavL: 7, uarmL: 8, farmL: 9, twistL: 10, handL: 11,
  clavR: 12, uarmR: 13, farmR: 14, twistR: 15, handR: 16,
  thighL: 17, calfL: 18, footL: 19, toeL: 20,
  thighR: 21, calfR: 22, footR: 23, toeR: 24,
} as const;
export const BONE_COUNT = 25;
export const BONE_NAMES = Object.keys(B);

export const PARENT: number[] = [
  -1, 0, 1, 2, 3, 4, 5,
  4, 7, 8, 9, 10,
  4, 12, 13, 14, 15,
  1, 17, 18, 19,
  1, 21, 22, 23,
];

type P3 = [number, number, number];
const v = (x: number, y: number, z: number): P3 => [x, y, z];

// Arm rest directions (left side; right mirrored).
const SH: P3 = [0.178, 1.462, -0.018];
const UA_DIR = new THREE.Vector3(0.66, -0.735, 0.15).normalize();
const FA_DIR = new THREE.Vector3(0.56, -0.74, 0.37).normalize();
const UA_LEN = 0.285, FA_LEN = 0.255;
const EL: P3 = [SH[0] + UA_DIR.x * UA_LEN, SH[1] + UA_DIR.y * UA_LEN, SH[2] + UA_DIR.z * UA_LEN];
const TW: P3 = [EL[0] + FA_DIR.x * FA_LEN * 0.55, EL[1] + FA_DIR.y * FA_LEN * 0.55, EL[2] + FA_DIR.z * FA_LEN * 0.55];
const WR: P3 = [EL[0] + FA_DIR.x * FA_LEN, EL[1] + FA_DIR.y * FA_LEN, EL[2] + FA_DIR.z * FA_LEN];

/** Rest (bind) positions in model space, meters, character 1.80 m tall. */
export const REST: P3[] = [
  v(0, 0, 0), // root
  v(0, 0.975, -0.005), // hips
  v(0, 1.075, -0.012), // spine
  v(0, 1.2, -0.02), // spine1
  v(0, 1.33, -0.022), // spine2
  v(0, 1.522, -0.03), // neck
  v(0, 1.618, -0.012), // head
  v(0.028, 1.468, 0.01), SH, EL, TW, WR, // left arm
  v(-0.028, 1.468, 0.01), [-SH[0], SH[1], SH[2]], [-EL[0], EL[1], EL[2]], [-TW[0], TW[1], TW[2]], [-WR[0], WR[1], WR[2]],
  v(0.093, 0.93, -0.005), v(0.1, 0.515, 0.012), v(0.106, 0.088, -0.022), v(0.112, 0.024, 0.118),
  v(-0.093, 0.93, -0.005), v(-0.1, 0.515, 0.012), v(-0.106, 0.088, -0.022), v(-0.112, 0.024, 0.118),
];

export const ARM = { SH, EL, WR, TW, UA_DIR, FA_DIR, UA_LEN, FA_LEN, HAND_LEN: 0.17 };
export const LEG = { THIGH_LEN: 0, CALF_LEN: 0 };
LEG.THIGH_LEN = dist(REST[B.thighL], REST[B.calfL]);
LEG.CALF_LEN = dist(REST[B.calfL], REST[B.footL]);

function dist(a: P3, b: P3) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

export function restVec(i: number): THREE.Vector3 { return new THREE.Vector3(...REST[i]); }

/** Build a fresh THREE skeleton in bind pose. */
export function buildSkeleton(): { bones: THREE.Bone[]; skeleton: THREE.Skeleton } {
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = new THREE.Bone();
    b.name = BONE_NAMES[i];
    const p = PARENT[i];
    if (p < 0) b.position.set(...REST[i]);
    else b.position.set(REST[i][0] - REST[p][0], REST[i][1] - REST[p][1], REST[i][2] - REST[p][2]);
    bones.push(b);
    if (p >= 0) bones[p].add(b);
  }
  bones[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { bones, skeleton };
}

// ------------------------------------------------------------ skin weights

export type Region = 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'head';

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function segProj(px: number, py: number, pz: number, a: P3, b: P3): { t: number; d: number } {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  let t = ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / l2;
  const tc = Math.min(1, Math.max(0, t));
  const dx = px - (a[0] + bx * tc), dy = py - (a[1] + by * tc), dz = pz - (a[2] + bz * tc);
  return { t, d: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}

/** Chain weights: joints along a polyline; u = arc length of projection on the nearest segment. */
function chainWeights(p: THREE.Vector3, pts: P3[], bones: number[], blend: number[], out: Map<number, number>, scale: number) {
  // pts: n+1 points, bones: n bones (bone i covers segment i), blend: half-width at joint i (between bone i-1 and i), len n
  let best = Infinity, bu = 0;
  const cum: number[] = [0];
  for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + dist(pts[i], pts[i + 1]));
  for (let i = 0; i < pts.length - 1; i++) {
    const { t, d } = segProj(p.x, p.y, p.z, pts[i], pts[i + 1]);
    if (d < best - 1e-6) { best = d; bu = cum[i] + Math.min(1, Math.max(i === 0 ? -1 : 0, t)) * (cum[i + 1] - cum[i]); }
  }
  for (let i = 0; i < bones.length; i++) {
    const lo = i === 0 ? 0 : ss(cum[i] - blend[i], cum[i] + blend[i], bu);
    const hi = i === bones.length - 1 ? 0 : ss(cum[i + 1] - blend[i + 1], cum[i + 1] + blend[i + 1], bu);
    const w = (i === 0 ? 1 : lo) - hi;
    if (w > 1e-4) out.set(bones[i], (out.get(bones[i]) ?? 0) + w * scale);
  }
}

const L = (i: number) => REST[i];
const HEADTOP: P3 = [0, 1.8, 0.0];

function torsoChain(p: THREE.Vector3, out: Map<number, number>, s: number) {
  // vertical chain by height
  const y = p.y;
  const J = [REST[B.spine][1], REST[B.spine1][1], REST[B.spine2][1], REST[B.neck][1] - 0.02, REST[B.head][1] - 0.005];
  const W = [0.05, 0.06, 0.07, 0.035, 0.03];
  const bones = [B.hips, B.spine, B.spine1, B.spine2, B.neck, B.head];
  for (let i = 0; i < bones.length; i++) {
    const lo = i === 0 ? 1 : ss(J[i - 1] - W[i - 1], J[i - 1] + W[i - 1], y);
    const hi = i === bones.length - 1 ? 0 : ss(J[i] - W[i], J[i] + W[i], y);
    const w = lo - hi;
    if (w > 1e-4) out.set(bones[i], (out.get(bones[i]) ?? 0) + w * s);
  }
}

function armChain(p: THREE.Vector3, side: 1 | -1, out: Map<number, number>, s: number) {
  const o = side === 1 ? 0 : 5;
  const mx = (q: P3): P3 => [q[0] * side, q[1], q[2]];
  const handEnd: P3 = [WR[0] + FA_DIR.x * 0.17, WR[1] + FA_DIR.y * 0.17, WR[2] + FA_DIR.z * 0.17];
  const pts: P3[] = [mx([0.0, 1.43, -0.02]), mx([0.03, 1.468, 0.01]), mx(SH), mx(EL), mx(TW), mx(WR), mx(handEnd)];
  chainWeights(p, pts, [B.spine2, B.clavL + o, B.uarmL + o, B.farmL + o, B.twistL + o, B.handL + o], [0, 0.03, 0.055, 0.05, 0.06, 0.025], out, s);
}

function legChain(p: THREE.Vector3, side: 1 | -1, out: Map<number, number>, s: number) {
  const o = side === 1 ? 0 : 4;
  const hip = L(B.thighL + o), knee = L(B.calfL + o), ankle = L(B.footL + o), ball = L(B.toeL + o);
  const ankleY = ankle[1];
  if (p.y < ankleY + 0.075 && p.z > ankle[2] - 0.2) {
    // foot / boot area: blend calf->foot by height, foot->toe by z
    const wFoot = 1 - ss(ankleY + 0.005, ankleY + 0.075, p.y);
    const wToe = ss(ball[2] - 0.005, ball[2] + 0.035, p.z) * wFoot;
    const wCalf = 1 - wFoot;
    if (wCalf > 1e-4) out.set(B.calfL + o, (out.get(B.calfL + o) ?? 0) + wCalf * s);
    if (wFoot - wToe > 1e-4) out.set(B.footL + o, (out.get(B.footL + o) ?? 0) + (wFoot - wToe) * s);
    if (wToe > 1e-4) out.set(B.toeL + o, (out.get(B.toeL + o) ?? 0) + wToe * s);
    return;
  }
  const pelvis: P3 = [0.0, 1.02, -0.005];
  chainWeights(p, [pelvis, hip, knee, ankle, [ankle[0], ankle[1] - 0.2, ankle[2]]], [B.hips, B.thighL + o, B.calfL + o, B.footL + o], [0, 0.07, 0.06, 0.03], out, s);
}

/** Approximate signed distance to each body region (for soft region blending). */
function regionDist(p: THREE.Vector3, r: Region): number {
  const cd = (a: P3, b: P3, rad: number) => segProj(p.x, p.y, p.z, a, b).d - rad;
  switch (r) {
    case 'torso': return Math.min(cd([0, 0.95, -0.02], [0, 1.4, -0.02], 0.15), cd([0, 1.42, -0.03], [0, 1.52, -0.03], 0.1));
    case 'head': return cd([0, 1.54, -0.02], HEADTOP, 0.085);
    case 'armL': return cd(SH, WR, 0.05);
    case 'armR': return cd([-SH[0], SH[1], SH[2]], [-WR[0], WR[1], WR[2]], 0.05);
    case 'legL': return Math.min(cd(L(B.thighL), L(B.footL), 0.07), cd(L(B.footL), L(B.toeL), 0.05));
    case 'legR': return Math.min(cd(L(B.thighR), L(B.footR), 0.07), cd(L(B.footR), L(B.toeR), 0.05));
  }
}

export interface WeightOpts {
  regions?: Region[];
  /** Force every vertex to a single bone. */
  bone?: number;
  /** Blend temperature (m) between regions. */
  temp?: number;
}

/** Skin weights (top 4) for a rest-pose position. */
export function skinWeights(p: THREE.Vector3, opts: WeightOpts = {}): { idx: number[]; w: number[] } {
  if (opts.bone !== undefined) return { idx: [opts.bone, 0, 0, 0], w: [1, 0, 0, 0] };
  const regions = opts.regions ?? ['torso', 'head', 'armL', 'armR', 'legL', 'legR'];
  const T = opts.temp ?? 0.022;
  const ds = regions.map((r) => regionDist(p, r));
  const m = Math.min(...ds);
  const ws = ds.map((d) => Math.exp(-(d - m) / T));
  const tot = ws.reduce((a, b) => a + b, 0);
  const out = new Map<number, number>();
  regions.forEach((r, i) => {
    const s = ws[i] / tot;
    if (s < 1e-3) return;
    if (r === 'torso' || r === 'head') torsoChain(p, out, s);
    else if (r === 'armL') armChain(p, 1, out, s);
    else if (r === 'armR') armChain(p, -1, out, s);
    else if (r === 'legL') legChain(p, 1, out, s);
    else legChain(p, -1, out, s);
  });
  const arr = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = arr.reduce((a, b) => a + b[1], 0) || 1;
  const idx = [0, 0, 0, 0], w = [0, 0, 0, 0];
  arr.forEach(([b, ww], i) => { idx[i] = b; w[i] = ww / sum; });
  return { idx, w };
}

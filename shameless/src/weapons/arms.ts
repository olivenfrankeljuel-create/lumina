import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GunMaterials } from './materials';
import { blob, finish, latheZ, merge, roundBox, xform, P2 } from './geom';
import type { HandGrip, SDF } from './model';

/**
 * First-person arms: rigid-segment gloved hands (tapered elliptic capsules that overlap at the joints so
 * there are never gaps), a sculpted palm, knuckle armor, glove cuffs, and combat-shirt sleeves.
 *
 * Hand space (right hand): origin = wrist joint, fingers toward -Z, back of hand +Y, thumb toward -X.
 * The left hand is the same rig mirrored with scale.x = -1 (its thumb is toward +X of its frame).
 */

export interface HandPose {
  /** index, middle, ring, pinky: [mcp, pip, dip] flex (radians, positive curls toward the palm) */
  f: number[][];
  /** abduction per finger (radians, + toward the thumb) */
  s: number[];
  /** thumb: [cmcFlex, cmcAbd, mcpFlex, ipFlex, roll] */
  t: number[];
}

export const clonePose = (p: HandPose): HandPose => ({ f: p.f.map((a) => a.slice()), s: p.s.slice(), t: p.t.slice() });
export function lerpPose(a: HandPose, b: HandPose, k: number, out: HandPose = clonePose(a)): HandPose {
  for (let i = 0; i < 4; i++) { for (let j = 0; j < 3; j++) out.f[i][j] = a.f[i][j] + (b.f[i][j] - a.f[i][j]) * k; out.s[i] = a.s[i] + (b.s[i] - a.s[i]) * k; }
  for (let j = 0; j < 5; j++) out.t[j] = a.t[j] + (b.t[j] - a.t[j]) * k;
  return out;
}
export const POSE_RELAXED: HandPose = { f: [[0.35, 0.45, 0.25], [0.4, 0.55, 0.3], [0.45, 0.6, 0.3], [0.5, 0.65, 0.35]], s: [0.05, 0, -0.05, -0.12], t: [0.2, 0.3, 0.2, 0.2, 0] };
export const POSE_FLAT: HandPose = { f: [[0.1, 0.12, 0.08], [0.1, 0.12, 0.08], [0.12, 0.14, 0.1], [0.14, 0.16, 0.1]], s: [0.06, 0, -0.06, -0.14], t: [0.1, 0.45, 0.1, 0.1, 0] };
export const POSE_FIST: HandPose = { f: [[1.4, 1.6, 0.9], [1.45, 1.65, 0.95], [1.45, 1.65, 0.95], [1.45, 1.6, 0.9]], s: [0.05, 0, -0.05, -0.1], t: [0.5, 0.1, 0.6, 0.6, 0] };

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * Tapered capsule with elliptic cross-section along -Z from z=0 to z=-L.
 * (w0,h0) half-width/half-height at the base, (w1,h1) at the end. The end cap can be flattened (fingertip pad).
 */
function segment(L: number, w0: number, h0: number, w1: number, h1: number, tip = false): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.CapsuleGeometry(1, 1, 8, 16);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-5);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // capsule axis Y in [-1.5, 1.5]; cylinder part [-0.5, 0.5]
    const t = THREE.MathUtils.clamp(y + 0.5, 0, 1);
    const w = THREE.MathUtils.lerp(w0, w1, t), h = THREE.MathUtils.lerp(h0, h1, t);
    let ax: number;
    if (y < -0.5) ax = (y + 0.5) * Math.min(w0, h0) * 1.0;
    else if (y > 0.5) ax = L + (y - 0.5) * Math.min(w1, h1) * (tip ? 1.25 : 1.0);
    else ax = t * L;
    // cross-section: x = width, z = height (dorsal +). Palmar pad slightly fuller.
    let hy = z * h;
    if (z < 0) hy *= 1.08;
    let wx = x * w;
    if (tip && y > 0.5) { const k = (y - 0.5); hy *= 1 - 0.18 * k; }
    pos.setXYZ(i, wx, hy, -ax);
  }
  g.computeVertexNormals();
  return g;
}

interface FingerDef { mcp: THREE.Vector3; len: [number, number, number]; r: [number, number, number, number]; spread: number }

const FINGERS: FingerDef[] = [
  { mcp: new THREE.Vector3(-0.0275, 0.0005, -0.0865), len: [0.045, 0.027, 0.0225], r: [0.0102, 0.0094, 0.0086, 0.0080], spread: 0.05 },
  { mcp: new THREE.Vector3(-0.0088, 0.0012, -0.0905), len: [0.049, 0.031, 0.0235], r: [0.0106, 0.0098, 0.0089, 0.0082], spread: 0.0 },
  { mcp: new THREE.Vector3(0.0100, 0.0005, -0.0880), len: [0.046, 0.029, 0.0225], r: [0.0101, 0.0093, 0.0085, 0.0078], spread: -0.05 },
  { mcp: new THREE.Vector3(0.0268, -0.0015, -0.0800), len: [0.037, 0.0225, 0.020], r: [0.0092, 0.0085, 0.0078, 0.0072], spread: -0.12 },
];
const THUMB = {
  cmc: new THREE.Vector3(-0.0215, -0.0095, -0.0165),
  // rest direction and palm-facing axis of the thumb metacarpal
  dir: new THREE.Vector3(-0.52, -0.42, -0.74).normalize(),
  len: [0.047, 0.034, 0.029] as [number, number, number],
  r: [0.0132, 0.0112, 0.0100, 0.0088],
};

function palmGeometry(): THREE.BufferGeometry {
  const g = blob(1, 1, 1, 0.42, 36, 24);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // z: +1 = wrist, -1 = knuckles
    const t = (1 - z) / 2; // 0 wrist .. 1 knuckles
    let zz = THREE.MathUtils.lerp(0.010, -0.089, t);
    zz -= 0.006 * (1 - x * x) * Math.pow(t, 6); // knuckle arc (middle finger furthest)
    const hw = THREE.MathUtils.lerp(0.0285, 0.0395, Math.pow(t, 0.7));
    let xx = x * hw;
    // thumb side is fuller near the wrist (thenar)
    if (x < 0) xx *= 1 + 0.12 * (1 - t);
    const top = 0.0118 + 0.0035 * (1 - x * x);
    const bot = 0.0150 + 0.004 * Math.max(0, 1 - Math.abs(x + 0.2) * 1.3) * (1 - t * 0.6);
    let yy = y > 0 ? y * top : y * bot;
    // slight cupping of the palm
    if (y < 0) yy += 0.003 * (1 - x * x) * (1 - Math.abs(t - 0.5) * 2);
    // taper to the knuckle row thickness
    yy *= THREE.MathUtils.lerp(1.0, 0.82, Math.pow(t, 3));
    pos.setXYZ(i, xx, yy, zz);
  }
  g.computeVertexNormals();
  return g;
}

function thenarGeometry(): THREE.BufferGeometry {
  const g = blob(0.0135, 0.012, 0.028, 0.7, 20, 14);
  g.rotateY(0.55);
  g.rotateZ(-0.35);
  g.translate(-0.020, -0.009, -0.024);
  return g;
}

/** Sleeve: cloth tube along +Z from the wrist toward the elbow, with folds. */
function sleeveGeometry(len: number, r0: number, r1: number, seed: number): THREE.BufferGeometry {
  const radial = 28, rings = 36;
  const g = new THREE.CylinderGeometry(1, 1, 1, radial, rings, true);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  let m = mergeVertices(g, 1e-5);
  const pos = m.attributes.position;
  const rnd = (a: number, b: number) => Math.sin(a * 12.9898 + b * 78.233 + seed * 3.1) * 0.5 + 0.5;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = y + 0.5; // 0 wrist .. 1 elbow
    const ang = Math.atan2(z, x);
    let r = THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.8));
    // compression folds near the cuff + long drape folds
    const f1 = Math.sin(t * 38 + Math.sin(ang * 2 + seed) * 1.6) * 0.0028 * (1 - t * 0.7);
    const f2 = Math.sin(ang * 3 + t * 5 + seed) * 0.0022;
    const f3 = (rnd(Math.floor(t * 9), Math.floor((ang + Math.PI) * 2)) - 0.5) * 0.0015;
    r += f1 + f2 + f3;
    // cuff band
    if (t < 0.07) r -= 0.0025 * (1 - t / 0.07);
    // slightly elliptic
    pos.setXYZ(i, Math.cos(ang) * r * 1.06, -Math.sin(ang) * r * 0.92, t * len);
  }
  m.computeVertexNormals();
  return m;
}

function forearmUnderGeometry(len: number): THREE.BufferGeometry {
  // hidden core so nothing is see-through if the sleeve opens up
  return latheZ([[0, -len], [0.036, -len * 0.7], [0.030, -0.05], [0.024, 0], [0, 0]], 16, 0);
}

// ---------------------------------------------------------------------------------------------
// Hand rig
// ---------------------------------------------------------------------------------------------

interface Joint { node: THREE.Group; len: number; r0: number; r1: number }

export class HandRig {
  readonly root = new THREE.Group();
  readonly fingers: Joint[][] = [];
  readonly thumb: Joint[] = [];
  readonly thumbBase = new THREE.Group();
  readonly pose: HandPose = clonePose(POSE_RELAXED);
  constructor(mats: GunMaterials, readonly mirrored: boolean) {
    this.root.name = mirrored ? 'handL' : 'handR';
    this.root.matrixAutoUpdate = false;
    const glove = mats.glove, pad = mats.gloveKnuckle, fabric = mats.gloveFabric;
    // palm
    const palm = new THREE.Mesh(finish(merge([palmGeometry(), thenarGeometry()]), 60), glove);
    this.root.add(palm);
    // dorsal fabric panel + knuckle armor
    const dorsal = blob(0.034, 0.004, 0.036, 0.5, 20, 12);
    dorsal.translate(0, 0.0135, -0.042);
    const guard = blob(0.036, 0.0062, 0.0105, 0.38, 24, 12);
    guard.translate(0.0005, 0.0122, -0.0835);
    guard.rotateZ(0);
    const guardArc = guard.attributes.position;
    for (let i = 0; i < guardArc.count; i++) {
      const x = guardArc.getX(i);
      guardArc.setZ(i, guardArc.getZ(i) - 0.006 * (1 - (x / 0.036) ** 2) + 0.0);
      guardArc.setY(i, guardArc.getY(i) + 0.002 * (1 - (x / 0.036) ** 2));
    }
    guard.computeVertexNormals();
    this.root.add(new THREE.Mesh(finish(dorsal, 60), fabric));
    this.root.add(new THREE.Mesh(finish(guard, 60), pad));
    // wrist strap (velcro) on the back of the hand
    const strap = xform(roundBox(0.050, 0.0045, 0.018, 0.002), 0.002, 0.0118, 0.004);
    this.root.add(new THREE.Mesh(finish(strap, 50), pad));

    // fingers
    FINGERS.forEach((fd, fi) => {
      const chain: Joint[] = [];
      let parent: THREE.Object3D = this.root;
      for (let j = 0; j < 3; j++) {
        const node = new THREE.Group();
        node.rotation.order = 'YXZ';
        if (j === 0) node.position.copy(fd.mcp);
        else node.position.set(0, 0, -fd.len[j - 1]);
        parent.add(node);
        const L = fd.len[j];
        const r0 = fd.r[j], r1 = fd.r[j + 1];
        const geo = segment(L, r0, r0 * 0.9, r1, r1 * 0.88, j === 2);
        node.add(new THREE.Mesh(finish(geo, 70), glove));
        if (j === 0) {
          // knuckle pad on the proximal phalanx
          const kp = xform(roundBox(r0 * 1.35, 0.0034, L * 0.42, 0.0016), 0, r0 * 0.86, -L * 0.62);
          node.add(new THREE.Mesh(finish(kp, 50), pad));
        }
        if (j === 1) {
          const kp = xform(roundBox(r0 * 1.2, 0.0028, L * 0.4, 0.0013), 0, r0 * 0.84, -L * 0.45);
          node.add(new THREE.Mesh(finish(kp, 50), pad));
        }
        chain.push({ node, len: L, r0, r1 });
        parent = node;
      }
      this.fingers.push(chain);
    });
    // thumb
    this.thumbBase.position.copy(THUMB.cmc);
    this.thumbBase.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), THUMB.dir);
    // roll the thumb so its pad faces the fingers
    this.thumbBase.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.05));
    this.root.add(this.thumbBase);
    let parent: THREE.Object3D = this.thumbBase;
    for (let j = 0; j < 3; j++) {
      const node = new THREE.Group();
      node.rotation.order = 'YXZ';
      if (j > 0) node.position.set(0, 0, -THUMB.len[j - 1]);
      parent.add(node);
      const L = THUMB.len[j];
      const r0 = THUMB.r[j], r1 = THUMB.r[j + 1];
      const geo = segment(L, r0, r0 * (j === 0 ? 0.85 : 0.88), r1, r1 * 0.86, j === 2);
      node.add(new THREE.Mesh(finish(geo, 70), glove));
      if (j === 1) {
        const kp = xform(roundBox(r0 * 1.1, 0.003, L * 0.5, 0.0013), 0, r0 * 0.84, -L * 0.5);
        node.add(new THREE.Mesh(finish(kp, 50), pad));
      }
      this.thumb.push({ node, len: L, r0, r1 });
      parent = node;
    }
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.applyPose(this.pose);
  }

  applyPose(p: HandPose): void {
    if (p !== this.pose) {
      for (let i = 0; i < 4; i++) { for (let j = 0; j < 3; j++) this.pose.f[i][j] = p.f[i][j]; this.pose.s[i] = p.s[i]; }
      for (let j = 0; j < 5; j++) this.pose.t[j] = p.t[j];
    }
    for (let i = 0; i < 4; i++) {
      const ch = this.fingers[i];
      ch[0].node.rotation.set(-p.f[i][0], p.s[i] + FINGERS[i].spread * 0, 0);
      ch[1].node.rotation.set(-p.f[i][1], 0, 0);
      ch[2].node.rotation.set(-p.f[i][2], 0, 0);
    }
    const t = p.t;
    this.thumb[0].node.rotation.set(-t[0], t[1], t[4]);
    this.thumb[1].node.rotation.set(-t[2], 0, 0);
    this.thumb[2].node.rotation.set(-t[3], 0, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Grip solver: curls each finger joint until the segment touches the weapon surface.
// ---------------------------------------------------------------------------------------------
const _p = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

function segmentClearance(j: Joint, sdf: SDF, toGun: THREE.Matrix4, squeeze: number, samples = 6): number {
  let worst = Infinity;
  _m.multiplyMatrices(toGun, j.node.matrixWorld);
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    // sample along the axis plus the palmar surface points
    const r = THREE.MathUtils.lerp(j.r0, j.r1, u);
    _p.set(0, 0, -j.len * u - (s === samples ? r * 0.8 : 0)).applyMatrix4(_m);
    const d = sdf(_p) - r * (1 - squeeze);
    if (d < worst) worst = d;
  }
  return worst;
}

export interface SolveOpts { maxFlex?: [number, number, number]; minFlex?: number; step?: number }

/**
 * Solves finger (and optionally thumb) curl for `hand` placed at weapon-space wrist matrix `wrist`.
 * The hand root must not have a parent (it is posed directly in weapon space during the solve).
 */
export function solveGrip(hand: HandRig, wristMatrix: THREE.Matrix4, grip: HandGrip, base: HandPose = POSE_FLAT, opts: SolveOpts = {}): HandPose {
  const pose = clonePose(base);
  if (grip.spread !== undefined) for (let i = 0; i < 4; i++) pose.s[i] = base.s[i] * grip.spread;
  const squeeze = grip.squeeze ?? 0.2;
  const maxF = opts.maxFlex ?? [1.55, 1.75, 1.35];
  const minF = opts.minFlex ?? -0.15;
  const step = opts.step ?? 0.025;
  const parent = hand.root.parent;
  hand.root.matrix.copy(wristMatrix);
  if (hand.mirrored) hand.root.matrix.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  const identity = new THREE.Matrix4();
  // Solve in weapon space: treat the hand root matrix as world
  const solveChain = (chain: Joint[], setAngle: (j: number, a: number) => void, fixed: number[] | null, maxes: number[]) => {
    if (fixed) { fixed.forEach((a, j) => setAngle(j, a)); return; }
    for (let j = 0; j < chain.length; j++) {
      for (let k = j + 1; k < chain.length; k++) setAngle(k, 0);
      let best = minF;
      for (let a = minF; a <= maxes[j]; a += step) {
        setAngle(j, a);
        hand.root.updateMatrixWorld(true);
        let clear = Infinity;
        for (let k = j; k < chain.length; k++) clear = Math.min(clear, segmentClearance(chain[k], grip.sdf, identity, squeeze));
        if (clear < 0) break;
        best = a;
      }
      setAngle(j, best);
    }
    // natural coupling: distal follows middle a bit
    hand.root.updateMatrixWorld(true);
  };
  const fixedIndex = grip.index ?? null;
  for (let i = 0; i < 4; i++) {
    const set = (j: number, a: number) => { pose.f[i][j] = a; hand.applyPose(pose); };
    solveChain(hand.fingers[i], set, i === 0 ? fixedIndex : null, maxF);
  }
  if (grip.thumb) {
    for (let j = 0; j < 5; j++) pose.t[j] = grip.thumb[j];
    hand.applyPose(pose);
  } else {
    // solve thumb mcp/ip only, keep base cmc
    const set = (j: number, a: number) => { if (j === 0) pose.t[2] = a; else pose.t[3] = a; hand.applyPose(pose); };
    const chain = [hand.thumb[1], hand.thumb[2]];
    solveChain(chain, set, null, [1.0, 1.2]);
  }
  hand.applyPose(pose);
  if (!parent) hand.root.matrix.identity();
  return pose;
}

// ---------------------------------------------------------------------------------------------
// Arm (hand + forearm/sleeve), positioned each frame in camera (viewmodel) space.
// ---------------------------------------------------------------------------------------------
export class ArmRig {
  readonly group = new THREE.Group();
  readonly hand: HandRig;
  readonly forearm = new THREE.Group();
  readonly upper = new THREE.Group();
  private readonly fLen = 0.27;
  constructor(mats: GunMaterials, readonly left: boolean) {
    this.group.name = left ? 'armL' : 'armR';
    this.hand = new HandRig(mats, left);
    this.group.add(this.hand.root);
    this.forearm.matrixAutoUpdate = false;
    this.upper.matrixAutoUpdate = false;
    // glove cuff (attached to forearm so it hides the wrist joint)
    const cuff = latheZ([[0.0, -0.05], [0.031, -0.045], [0.0305, -0.012], [0.0295, 0.0], [0.0272, 0.010], [0.0215, 0.012]], 28, 0.0);
    cuff.scale(1.12, 0.88, 1);
    const cuffStrap = xform(roundBox(0.040, 0.006, 0.020, 0.002), 0, 0.0265, 0.024);
    this.forearm.add(new THREE.Mesh(finish(merge([cuff]), 60), mats.gloveFabric));
    this.forearm.add(new THREE.Mesh(finish(cuffStrap, 50), mats.gloveKnuckle));
    // sleeve
    const sl = sleeveGeometry(this.fLen + 0.05, 0.041, 0.052, left ? 2.1 : 0.7);
    sl.translate(0, 0, 0.034);
    this.forearm.add(new THREE.Mesh(finish(sl, 80), mats.sleeve));
    // sleeve cuff hem
    const hem = latheZ([[0.0398, -0.013], [0.0428, -0.012], [0.0425, -0.001], [0.0395, 0]], 28, 0);
    hem.scale(1.06, 0.92, 1);
    hem.translate(0, 0, 0.034);
    this.forearm.add(new THREE.Mesh(finish(hem, 60), mats.cuff));
    const core = forearmUnderGeometry(this.fLen);
    this.forearm.add(new THREE.Mesh(finish(core, 60), mats.gloveFabric));
    this.group.add(this.forearm);
    // upper arm sleeve (rarely visible)
    const up = sleeveGeometry(0.30, 0.055, 0.062, left ? 5.3 : 3.3);
    this.upper.add(new THREE.Mesh(finish(up, 80), mats.sleeve));
    this.group.add(this.upper);
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  private _q = new THREE.Quaternion();
  private _x = new THREE.Vector3();
  private _y = new THREE.Vector3();
  private _z = new THREE.Vector3();
  private _w = new THREE.Vector3();
  private _e = new THREE.Vector3();
  private _mm = new THREE.Matrix4();

  /**
   * wrist: hand matrix in camera space (unmirrored frame). elbowHint/shoulder: camera space.
   */
  update(wrist: THREE.Matrix4, elbowHint: THREE.Vector3, shoulder: THREE.Vector3): void {
    const h = this.hand.root;
    h.matrix.copy(wrist);
    if (this.left) h.matrix.multiply(this._mm.makeScale(-1, 1, 1));
    h.matrixWorldNeedsUpdate = true;
    // forearm: from wrist toward the elbow hint, twisted to follow the back of the hand
    this._w.setFromMatrixPosition(wrist);
    this._z.copy(elbowHint).sub(this._w).normalize(); // +Z toward elbow
    this._y.setFromMatrixColumn(wrist, 1).normalize(); // hand dorsal
    // wrist can only twist so much: blend dorsal with a neutral "up" to avoid candy-wrapping
    this._x.crossVectors(this._y, this._z).normalize();
    this._y.crossVectors(this._z, this._x).normalize();
    const f = this.forearm.matrix.makeBasis(this._x, this._y, this._z);
    // push the forearm origin slightly back so the cuff overlaps the palm base
    f.setPosition(this._w.x, this._w.y, this._w.z);
    this.forearm.matrixWorldNeedsUpdate = true;
    this._e.copy(this._w).addScaledVector(this._z, this.fLen);
    // upper arm: from elbow toward the shoulder
    const uz = this._z.clone();
    const dir = shoulder.clone().sub(this._e).normalize();
    const ux = new THREE.Vector3().crossVectors(this._y, dir).normalize();
    const uy = new THREE.Vector3().crossVectors(dir, ux).normalize();
    this.upper.matrix.makeBasis(ux, uy, dir).setPosition(this._e.x, this._e.y, this._e.z);
    this.upper.matrixWorldNeedsUpdate = true;
    void uz;
  }
  get elbow(): THREE.Vector3 { return this._e; }
}

/** Builds a wrist matrix from a position, the finger direction (-Z of hand) and back-of-hand normal (+Y). */
export function wristFrame(pos: THREE.Vector3, fingerDir: THREE.Vector3, dorsal: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const z = fingerDir.clone().normalize().negate();
  const x = new THREE.Vector3().crossVectors(dorsal, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return out.makeBasis(x, y, z).setPosition(pos);
}

export function matrixToXf(m: THREE.Matrix4): [number, number, number, number, number, number] {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  return [p.x, p.y, p.z, e.x, e.y, e.z];
}
export function xfToMatrix4(x: ArrayLike<number>, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x[3], x[4], x[5], 'YXZ'));
  return out.compose(new THREE.Vector3(x[0], x[1], x[2]), q, new THREE.Vector3(1, 1, 1));
}
export type { P2 };

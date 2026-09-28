/**
 * OpFor soldier, sculpted in code from SDF primitives (see sdf.ts), meshed with surface nets, skinned to the
 * 25-bone rig with spatially blended weights, and baked with SDF ambient occlusion.
 *
 * Clothing is layered like the real thing: skin < shirt / pants < gloves / boots < armour & pouches < helmet.
 * Each layer is its own closed surface, so material borders are clean geometric edges (no texture seams).
 */
import * as THREE from 'three';
import type { GameContext, MaterialName } from '../core/types';
import { ARM, B, REST, buildSkeleton, skinWeights, type WeightOpts, type Region } from './rig';
import { box, cap, cone, cyl, ell, meshGroup, simplifyMesh, computeAO, evalGroup, groupBounds, mirrorX, plane, type Prim, type SdfGroup, type V3 } from './sdf';
import { fbm3, mulberry32, pick, range, type Rng } from './rng';

// ------------------------------------------------------------------ variants

export type Headgear = 'helmet_cover' | 'helmet_bare' | 'beanie' | 'cap';
export type FaceWear = 'balaclava' | 'shemagh' | 'gasmask' | 'none';
export type Vest = 'plate' | 'chestrig';

export interface Variant {
  headgear: Headgear;
  face: FaceWear;
  vest: Vest;
  backpack: 'assault' | 'radio' | 'hydration';
  kneepads: boolean;
  goggles: boolean;
  headset: boolean;
  shirtMat: MaterialName;
  pantsMat: MaterialName;
  shirtTint: number;
  pantsTint: number;
  gearTint: number;
  gloveTint: number;
  bootTint: number;
  faceTint: number;
  helmetTint: number;
  skinTint: number;
  height: number; // scale
  bulk: number; // 0..1 extra girth
}

const GEAR_COLORS = [0x8a7a5c, 0x5d5f45, 0x3b3d33, 0x6e6450, 0x2a2a28, 0x74694e];
const SKIN = [0xc79a7c, 0xa77a5a, 0x8a5e42, 0xd8b095, 0x6e4a35];

export function randomVariant(seed: number): Variant {
  const r = mulberry32(seed * 9973 + 17);
  const head = pick(r, ['helmet_cover', 'helmet_cover', 'helmet_bare', 'beanie', 'cap'] as Headgear[]);
  const face = head === 'beanie' || head === 'cap' ? pick(r, ['balaclava', 'shemagh', 'balaclava'] as FaceWear[]) : pick(r, ['balaclava', 'shemagh', 'gasmask', 'balaclava'] as FaceWear[]);
  const camo = r() < 0.6;
  return {
    headgear: head,
    face,
    vest: r() < 0.7 ? 'plate' : 'chestrig',
    backpack: pick(r, ['assault', 'radio', 'hydration'] as const),
    kneepads: r() < 0.7,
    goggles: head.startsWith('helmet') && face !== 'gasmask' && r() < 0.5,
    headset: head !== 'cap' && r() < 0.7,
    shirtMat: camo ? 'cloth_multicam' : pick(r, ['cloth_olive', 'cloth_black'] as MaterialName[]),
    pantsMat: camo ? (r() < 0.8 ? 'cloth_multicam' : 'cloth_olive') : pick(r, ['cloth_olive', 'cloth_olive', 'cloth_black'] as MaterialName[]),
    shirtTint: tintJitter(r, 0xffffff, 0.08),
    pantsTint: tintJitter(r, 0xffffff, 0.08),
    gearTint: tintJitter(r, pick(r, GEAR_COLORS), 0.06),
    gloveTint: pick(r, [0x2a2723, 0x6b5a45, 0x3b3a33]),
    bootTint: pick(r, [0x6f5a42, 0x3a3128, 0x8a7355, 0x2b2825]),
    faceTint: pick(r, [0x1d1d1c, 0x2c2e27, 0x3a3830]),
    helmetTint: pick(r, [0x55583f, 0x6e6450, 0x3f4035]),
    skinTint: pick(r, SKIN),
    height: range(r, 0.975, 1.03),
    bulk: r(),
  };
}

function tintJitter(r: Rng, hex: number, amt: number): number {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h + (r() - 0.5) * amt * 0.3, THREE.MathUtils.clamp(hsl.s + (r() - 0.5) * amt, 0, 1), THREE.MathUtils.clamp(hsl.l * (1 + (r() - 0.5) * amt * 2), 0, 1));
  return c.getHex();
}

/** Four hand-picked looks for the lineup (dev scene) and the first wave. */
export const PRESET_VARIANTS: Variant[] = [
  { ...randomVariant(1), headgear: 'helmet_cover', face: 'balaclava', vest: 'plate', backpack: 'assault', kneepads: true, goggles: false, headset: true, shirtMat: 'cloth_multicam', pantsMat: 'cloth_multicam', gearTint: 0x7d7055, helmetTint: 0x6e6450, faceTint: 0x1d1d1c, gloveTint: 0x2a2723, bootTint: 0x6f5a42, shirtTint: 0xffffff, pantsTint: 0xffffff, height: 1.0, bulk: 0.6 },
  { ...randomVariant(2), headgear: 'helmet_bare', face: 'shemagh', vest: 'chestrig', backpack: 'radio', kneepads: false, goggles: true, headset: false, shirtMat: 'cloth_olive', pantsMat: 'cloth_olive', gearTint: 0x5d5f45, helmetTint: 0x55583f, faceTint: 0x9b8a6a, gloveTint: 0x6b5a45, bootTint: 0x8a7355, shirtTint: 0xe8e6da, pantsTint: 0xcfcab8, height: 0.985, bulk: 0.3 },
  { ...randomVariant(3), headgear: 'beanie', face: 'balaclava', vest: 'plate', backpack: 'hydration', kneepads: true, goggles: false, headset: true, shirtMat: 'cloth_black', pantsMat: 'cloth_olive', gearTint: 0x2d2d2a, helmetTint: 0x2a2a28, faceTint: 0x2c2e27, gloveTint: 0x2a2723, bootTint: 0x3a3128, shirtTint: 0xffffff, pantsTint: 0xa8a48f, height: 1.02, bulk: 0.9 },
  { ...randomVariant(4), headgear: 'helmet_cover', face: 'gasmask', vest: 'plate', backpack: 'radio', kneepads: true, goggles: false, headset: true, shirtMat: 'cloth_multicam', pantsMat: 'cloth_olive', gearTint: 0x6e6450, helmetTint: 0x6e6450, faceTint: 0x1d1d1c, gloveTint: 0x3b3a33, bootTint: 0x2b2825, shirtTint: 0xf0eee6, pantsTint: 0xd8d4c4, height: 1.005, bulk: 0.45 },
];

// ------------------------------------------------------------------ helpers

const V = (x: number, y: number, z: number): V3 => [x, y, z];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mir = (a: V3): V3 => [-a[0], a[1], a[2]];
const both = (ps: Prim[]) => [...ps, ...ps.map(mirrorX)];
const eul = (x: number, y: number, z: number) => new THREE.Euler(x, y, z);
const qFromBasis = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

const SH = ARM.SH as V3, EL = ARM.EL as V3, WR = ARM.WR as V3;
const J = (i: number) => REST[i] as V3;

/** Hand frame at rest for the left hand: y = along fingers, x = palm normal (towards the gripped object), z = thumb side. */
export function restHandFrame(side: 1 | -1): { hy: THREE.Vector3; hn: THREE.Vector3; ht: THREE.Vector3 } {
  const hy = ARM.FA_DIR.clone(); hy.x *= side;
  const hn = new THREE.Vector3(-side, -0.05, -0.25);
  hn.addScaledVector(hy, -hn.dot(hy)).normalize();
  const ht = new THREE.Vector3().crossVectors(hn, hy).normalize();
  if (ht.z < 0) ht.negate();
  return { hy, hn, ht };
}

// ------------------------------------------------------------------ body parts

function clothDisp(seed: number, amp: number, freq: number) {
  return (x: number, y: number, z: number) => {
    // anisotropic folds: stretched horizontally so creases wrap around limbs, plus fine noise
    const n1 = fbm3(x * freq, y * freq * 2.6, z * freq, 3, seed);
    const n2 = fbm3(x * freq * 3.1, y * freq * 3.1, z * freq * 3.1, 2, seed + 7);
    return -Math.abs(n1) * amp * 1.2 + n2 * amp * 0.35;
  };
}

function shirtGroup(v: Variant): SdfGroup {
  const b = 1 + v.bulk * 0.06;
  const prims: Prim[] = [
    ell(V(0, 1.33, -0.012), V(0.172 * b, 0.165, 0.122 * b), { k: 0 }),
    ell(V(0, 1.375, 0.03), V(0.16 * b, 0.1, 0.098 * b), { k: 0.05 }), // pecs
    ell(V(0, 1.3, -0.045), V(0.172 * b, 0.155, 0.1 * b), { k: 0.05 }), // lats
    ell(V(0, 1.16, 0.0), V(0.152 * b, 0.15, 0.112 * b), { k: 0.06 }), // abdomen
    ell(V(0, 1.03, -0.008), V(0.16 * b, 0.1, 0.113 * b), { k: 0.05 }), // waist (tucked)
    cone(V(0, 1.44, -0.03), V(0, 1.575, -0.022), 0.07, 0.062, { k: 0.035 }), // mock neck collar
    ...both([
      cone(V(0.02, 1.485, -0.035), V(0.15, 1.468, -0.028), 0.058, 0.05, { k: 0.04 }), // traps
      ell(V(0.19, 1.438, -0.012), V(0.07 * b, 0.075, 0.072 * b), { k: 0.035, rot: eul(0, 0, 0.5) }), // deltoid
      cone(SH, EL, 0.061 * b, 0.049, { k: 0.03 }), // upper sleeve
      ell(lerp3(SH, EL, 0.45), V(0.05 * b, 0.075, 0.052 * b), { k: 0.03, rot: eul(0, 0, 0.72) }), // bicep/tricep mass
      cone(EL, lerp3(EL, WR, 0.93), 0.05, 0.041, { k: 0.02 }), // forearm sleeve
      ell(lerp3(EL, WR, 0.25), V(0.047, 0.07, 0.048), { k: 0.03, rot: eul(0.3, 0, 0.64) }), // forearm mass
      box(add(lerp3(SH, EL, 0.3), V(0.045, 0.01, 0.018)), V(0.012, 0.055, 0.045), { k: 0.012, round: 0.01, rot: eul(0.1, 0.35, 0.72) }), // sleeve pocket
    ]),
    plane(V(0, -1, 0), -0.975, { k: 0.01 }), // cut bottom (tucked into pants)
  ];
  return { prims, disp: clothDisp(11, 0.0045, 14), dispAmp: 0.006 };
}

function pantsGroup(v: Variant): SdfGroup {
  const b = 1 + v.bulk * 0.05;
  const hip = J(B.thighL), knee = J(B.calfL), ank = J(B.footL);
  const prims: Prim[] = [
    ell(V(0, 1.0, -0.012), V(0.168 * b, 0.12, 0.123 * b), { k: 0 }),
    ell(V(0, 0.885, 0.0), V(0.085, 0.07, 0.085), { k: 0.06 }), // crotch fill
    ...both([
      ell(V(0.078, 0.93, -0.062), V(0.093 * b, 0.105, 0.088 * b), { k: 0.05 }), // glute
      cone(add(hip, V(0.004, 0.02, 0)), knee, 0.098 * b, 0.064, { k: 0.05 }),
      ell(V(0.1, 0.74, 0.028), V(0.075 * b, 0.16, 0.07 * b), { k: 0.05 }), // quads
      ell(add(knee, V(0, 0, 0.012)), V(0.06, 0.066, 0.064), { k: 0.03 }),
      cone(knee, add(ank, V(0, 0.07, 0.0)), 0.06, 0.052, { k: 0.03 }), // calf (baggy)
      ell(V(0.104, 0.37, -0.028), V(0.058, 0.1, 0.058), { k: 0.04 }), // calf muscle
      ell(add(ank, V(0, 0.2, 0.005)), V(0.064, 0.05, 0.064), { k: 0.05 }), // blousing over boot
      box(V(0.172, 0.715, 0.008), V(0.024, 0.085, 0.072), { k: 0.015, round: 0.018, rot: eul(0.04, 0, 0.03) }), // cargo pocket
      box(V(0.172, 0.795, 0.008), V(0.027, 0.012, 0.075), { k: 0.008, round: 0.008, rot: eul(0.04, 0, 0.03) }), // pocket flap
    ]),
    plane(V(0, 1, 0), 1.09, { k: 0.01 }),
  ];
  return { prims, disp: clothDisp(23, 0.005, 12), dispAmp: 0.007 };
}

function headSkinGroup(): SdfGroup {
  const prims: Prim[] = [
    ell(V(0, 1.708, -0.004), V(0.076, 0.098, 0.095)), // cranium
    ell(V(0, 1.642, 0.03), V(0.064, 0.062, 0.072), { k: 0.04 }), // face / jaw
    ell(V(0, 1.603, 0.058), V(0.03, 0.024, 0.03), { k: 0.025 }), // chin
    ell(V(0, 1.716, 0.072), V(0.062, 0.02, 0.026), { k: 0.02 }), // brow ridge
    cone(V(0, 1.703, 0.09), V(0, 1.662, 0.106), 0.008, 0.012, { k: 0.012 }), // nose bridge
    ell(V(0, 1.66, 0.1), V(0.017, 0.012, 0.012), { k: 0.01 }), // nose tip/wings
    cone(V(0, 1.5, -0.035), V(0, 1.64, -0.005), 0.056, 0.05, { k: 0.03 }), // neck
    ...both([
      ell(V(0.043, 1.668, 0.06), V(0.028, 0.02, 0.026), { k: 0.025 }), // cheekbones
      ell(V(0.078, 1.678, -0.006), V(0.011, 0.03, 0.02), { k: 0.008 }), // ears
      ell(V(0.032, 1.692, 0.093), V(0.017, 0.011, 0.016), { op: 'sub', k: 0.012 }), // eye sockets
    ]),
  ];
  return { prims };
}

function eyesGroup(): SdfGroup {
  return { prims: both([ell(V(0.031, 1.691, 0.08), V(0.0105, 0.0095, 0.0105))]) };
}

function balaclavaGroup(): SdfGroup {
  const prims: Prim[] = [
    ell(V(0, 1.708, -0.004), V(0.081, 0.103, 0.1)),
    ell(V(0, 1.642, 0.03), V(0.069, 0.066, 0.077), { k: 0.045 }),
    ell(V(0, 1.604, 0.058), V(0.034, 0.027, 0.034), { k: 0.03 }),
    cone(V(0, 1.7, 0.092), V(0, 1.662, 0.11), 0.01, 0.015, { k: 0.02 }),
    cone(V(0, 1.47, -0.035), V(0, 1.64, -0.005), 0.066, 0.056, { k: 0.035 }),
    ell(V(0, 1.49, -0.03), V(0.085, 0.035, 0.08), { k: 0.04 }), // bunched at the collar
    ...both([ell(V(0.078, 1.678, -0.006), V(0.016, 0.034, 0.024), { k: 0.012 })]),
    box(V(0, 1.694, 0.1), V(0.062, 0.019, 0.06), { op: 'sub', k: 0.012, round: 0.014 }), // eye slot
  ];
  return { prims, disp: clothDisp(31, 0.0025, 20), dispAmp: 0.003 };
}

function shemaghGroup(): SdfGroup {
  const prims: Prim[] = [
    ell(V(0, 1.712, -0.006), V(0.088, 0.107, 0.105)),
    ell(V(0, 1.635, 0.03), V(0.082, 0.07, 0.088), { k: 0.05 }),
    cone(V(0, 1.47, -0.03), V(0, 1.64, 0.0), 0.085, 0.07, { k: 0.04 }),
    ell(V(0, 1.5, 0.0), V(0.11, 0.05, 0.1), { k: 0.05 }), // wrapped bulk at collar
    ell(V(0.0, 1.6, 0.08), V(0.07, 0.045, 0.04), { k: 0.03 }),
    box(V(0, 1.694, 0.11), V(0.066, 0.021, 0.07), { op: 'sub', k: 0.014, round: 0.016 }),
  ];
  return {
    prims,
    disp: (x, y, z) => {
      // strong wrapping folds: diagonal bands
      const band = Math.sin((y * 1.0 + x * 0.35) * 110 + fbm3(x * 20, y * 20, z * 20, 2, 5) * 3);
      return -Math.abs(band) * 0.004 + fbm3(x * 30, y * 30, z * 30, 2, 9) * 0.0025;
    },
    dispAmp: 0.007,
  };
}

function gasmaskGroups(): { mask: SdfGroup; lens: SdfGroup; canister: SdfGroup } {
  const mask: SdfGroup = {
    prims: [
      ell(V(0, 1.662, 0.05), V(0.075, 0.085, 0.07)),
      ell(V(0, 1.612, 0.1), V(0.04, 0.038, 0.038), { k: 0.03 }), // snout
      cyl(V(0, 1.608, 0.12), V(0, 1.604, 0.142), 0.022, { k: 0.008, round: 0.004 }), // voicemitter
      ...both([ell(V(0.035, 1.692, 0.1), V(0.028, 0.026, 0.02), { k: 0.012 })]), // lens rims
      ...both([cap(V(0.07, 1.7, 0.03), V(0.086, 1.72, -0.05), 0.008, { k: 0.01 })]), // straps
    ],
  };
  const lens: SdfGroup = { prims: both([ell(V(0.035, 1.692, 0.113), V(0.023, 0.021, 0.012))]) };
  const canister: SdfGroup = { prims: [cyl(V(0.045, 1.6, 0.1), V(0.1, 1.575, 0.14), 0.036, { round: 0.006 }), cyl(V(0.04, 1.603, 0.096), V(0.06, 1.595, 0.11), 0.02, { k: 0.01 })] };
  return { mask, lens, canister };
}

// ------------------------------------------------------------------ hands & feet

function gloveGroup(side: 1 | -1): SdfGroup {
  const { hy, hn, ht } = restHandFrame(side);
  const W = new THREE.Vector3(WR[0] * side, WR[1], WR[2]);
  const P = (a: number, n: number, t: number): V3 => {
    const p = W.clone().addScaledVector(hy, a).addScaledVector(hn, n).addScaledVector(ht, t);
    return [p.x, p.y, p.z];
  };
  const rot = qFromBasis(hn, hy, ht); // box local x = palm normal, y = finger dir, z = thumb
  const prims: Prim[] = [
    cone(P(-0.055, 0, 0), P(0.012, 0, 0), 0.037, 0.034, { k: 0 }), // cuff (over sleeve)
    box(P(0.05, 0.0, -0.002), [0.019, 0.047, 0.041], { rot, round: 0.017, k: 0.03 }), // palm
    ell(P(0.036, 0.012, 0.022), [0.016, 0.028, 0.02], { rot, k: 0.02 }), // thenar
  ];
  // fingers curl around a grip cylinder (axis = thumb dir)
  const rc = 0.02;
  const C = { a: 0.078, n: 0.019 + rc + 0.004 };
  const offs = [0.027, 0.009, -0.009, -0.026];
  const lens = [[0.044, 0.027, 0.022], [0.047, 0.03, 0.024], [0.045, 0.029, 0.023], [0.037, 0.022, 0.019]];
  offs.forEach((t, f) => {
    const Ka = 0.097 - Math.abs(t) * 0.25, Kn = -0.005;
    let da = Ka - C.a, dn = Kn - C.n;
    const R = Math.hypot(da, dn);
    let th = Math.atan2(dn, da);
    let prev = P(Ka, Kn, t);
    let r = 0.0102 - f * 0.0004;
    for (const L of lens[f]) {
      th += L / R;
      const q = P(C.a + Math.cos(th) * R, C.n + Math.sin(th) * R, t);
      prims.push(cone(prev, q, r, r * 0.92, { k: 0.006 }));
      prev = q; r *= 0.92;
    }
  });
  // thumb wraps over the front of the grip
  prims.push(cone(P(0.02, 0.005, 0.03), P(0.058, 0.026, 0.042), 0.013, 0.011, { k: 0.014 }));
  prims.push(cone(P(0.058, 0.026, 0.042), P(0.083, 0.052, 0.03), 0.011, 0.0095, { k: 0.006 }));
  // hard knuckle guard on the back of the hand
  prims.push(box(P(0.088, -0.022, 0.0), [0.008, 0.014, 0.04], { rot, round: 0.006, k: 0.008 }));
  return { prims, disp: (x, y, z) => fbm3(x * 60, y * 60, z * 60, 2, 3) * 0.0012, dispAmp: 0.0015 };
}

function bootGroup(): { upper: SdfGroup; sole: SdfGroup } {
  const ank = J(B.footL);
  const upper: SdfGroup = {
    prims: [
      cone(add(ank, V(0, -0.02, -0.004)), add(ank, V(-0.002, 0.155, 0.006)), 0.056, 0.058, { k: 0 }), // shaft
      ell(add(ank, V(0, 0.16, 0.006)), V(0.062, 0.02, 0.062), { k: 0.02 }), // padded collar
      cone(V(0.106, 0.058, -0.058), V(0.113, 0.048, 0.155), 0.05, 0.04, { k: 0.04 }), // foot
      ell(V(0.113, 0.05, 0.158), V(0.047, 0.036, 0.05), { k: 0.03 }), // toe box
      ell(V(0.106, 0.06, -0.06), V(0.046, 0.05, 0.045), { k: 0.03 }), // heel counter
      box(V(0.11, 0.1, 0.07), V(0.028, 0.012, 0.075), { k: 0.02, round: 0.01, rot: eul(-0.5, 0, 0) }), // tongue / laces
    ],
    disp: (x, y, z) => {
      const lace = z > 0.02 && z < 0.14 && y > 0.06 ? Math.max(0, Math.sin(z * 190) - 0.6) * 0.0035 : 0;
      return fbm3(x * 45, y * 45, z * 45, 2, 4) * 0.0015 - lace;
    },
    dispAmp: 0.004,
  };
  const sole: SdfGroup = {
    prims: [
      box(V(0.109, 0.016, 0.048), V(0.054, 0.017, 0.148), { round: 0.014 }),
      box(V(0.107, 0.02, -0.055), V(0.05, 0.021, 0.045), { round: 0.012, k: 0.01 }), // heel block
      box(V(0.109, 0.0, 0.02), V(0.06, 0.004, 0.02), { op: 'sub', round: 0.002, k: 0.003 }), // arch gap
    ],
    disp: (x, y, z) => (y < 0.012 ? -Math.max(0, Math.sin(z * 160) * Math.sin(x * 140)) * 0.003 : 0),
    dispAmp: 0.003,
  };
  return { upper, sole };
}

// ------------------------------------------------------------------ gear

function kneepadGroup(): SdfGroup {
  const knee = J(B.calfL);
  const c = add(knee, V(0.002, -0.01, 0.068));
  return {
    prims: [
      box(c, V(0.047, 0.07, 0.02), { round: 0.02, rot: eul(-0.05, 0, 0) }),
      ell(add(c, V(0, 0, 0.012)), V(0.042, 0.06, 0.018), { k: 0.012 }),
      box(add(c, V(0, 0, -0.07)), V(0.072, 0.013, 0.075), { round: 0.012, k: 0.01 }), // strap loop (hidden inside pants mostly)
      box(add(c, V(0, 0, -0.068)), V(0.063, 0.02, 0.066), { op: 'sub', round: 0.02, k: 0.004 }),
    ],
  };
}

function helmetGroups(v: Variant): SdfGroup[] {
  const out: SdfGroup[] = [];
  const c = V(0, 1.728, -0.006);
  const covered = v.headgear === 'helmet_cover';
  const shell: SdfGroup = {
    prims: [
      ell(c, V(0.115, 0.11, 0.13)),
      ell(add(c, V(0, 0.03, 0.01)), V(0.108, 0.1, 0.12), { k: 0.03 }),
      ell(c, V(0.1, 0.096, 0.115), { op: 'sub', k: 0.004 }),
      plane(V(0, -1, -0.3), -(1.68 + 0.3 * 0.0), { k: 0.008 }), // brim cut, rises at the front
      // high-cut ear openings
      ...both([box(V(0.11, 1.662, 0.0), V(0.05, 0.05, 0.068), { op: 'sub', round: 0.04, k: 0.01 })]),
      ...both([box(V(0.113, 1.712, 0.005), V(0.007, 0.011, 0.065), { k: 0.004, round: 0.003 })]), // ARC rails
    ],
    disp: covered ? (x, y, z) => { const n = fbm3(x * 28, y * 28, z * 28, 3, 41); return -Math.abs(n) * 0.004 + n * 0.001; } : undefined,
    dispAmp: covered ? 0.005 : 0,
  };
  out.push(shell);
  return out;
}

function helmetHardware(v: Variant): SdfGroup {
  const prims: Prim[] = [
    box(V(0, 1.785, 0.113), V(0.026, 0.022, 0.012), { round: 0.006, rot: eul(-0.5, 0, 0) }), // NVG shroud
    box(V(0, 1.768, 0.126), V(0.016, 0.012, 0.012), { round: 0.004, k: 0.004 }),
    box(V(0, 1.765, -0.135), V(0.045, 0.028, 0.018), { round: 0.01, rot: eul(0.55, 0, 0) }), // counterweight pouch
  ];
  if (v.headset) {
    prims.push(...both([
      cyl(V(0.095, 1.672, 0.0), V(0.125, 1.672, 0.0), 0.037, { round: 0.012 }), // ear cup
      cyl(V(0.12, 1.672, 0.0), V(0.13, 1.672, 0.0), 0.026, { round: 0.005, k: 0.004 }),
      cap(V(0.113, 1.69, 0.0), V(0.118, 1.715, 0.004), 0.008, { k: 0.006 }), // arm to rail
      cap(V(-0.0, 1.655, 0.1), V(0.1, 1.655, 0.03), 0.003, { k: 0.002 }), // boom mic (left only after mirror trim)
    ]).filter((p, i) => !(i === 7)));
  }
  return { prims };
}

function gogglesGroups(onHelmet: boolean): { frame: SdfGroup; lens: SdfGroup } {
  const y = onHelmet ? 1.78 : 1.694, z = onHelmet ? 0.11 : 0.1;
  const rot = eul(onHelmet ? -0.9 : 0.05, 0, 0);
  const frame: SdfGroup = {
    prims: [
      box(V(0, y, z), V(0.078, 0.028, 0.02), { round: 0.016, rot }),
      box(V(0, y, z + 0.006), V(0.068, 0.02, 0.03), { op: 'sub', round: 0.012, rot, k: 0.003 }),
      ...both([cap(V(0.075, y, z - 0.01), V(0.105, y + 0.0, z - 0.09), 0.009, { k: 0.01 })]), // strap
    ],
  };
  const lens: SdfGroup = { prims: [box(V(0, y, z + 0.004), V(0.07, 0.021, 0.008), { round: 0.008, rot })] };
  return { frame, lens };
}

function headband(rx: number, top: number, base: number): Prim[] {
  const out: Prim[] = [];
  const N = 8;
  let prev: V3 | null = null;
  for (let i = 0; i <= N; i++) {
    const t = -Math.PI / 2 + (i / N) * Math.PI;
    const p: V3 = [rx * Math.sin(t), base + (top - base) * Math.cos(t), -0.005];
    if (prev) out.push(cap(prev, p, 0.0075, { k: 0.004 }));
    prev = p;
  }
  return out;
}

function beanieGroup(): SdfGroup {
  return {
    prims: [ell(V(0, 1.735, -0.006), V(0.087, 0.088, 0.103)), plane(V(0, -1, -0.25), -1.705, { k: 0.01 }), ell(V(0, 1.7, -0.006), V(0.089, 0.018, 0.105), { k: 0.012 })],
    // knit ribs running vertically + a folded cuff band
    disp: (x, y, z) => Math.abs(Math.sin(Math.atan2(x, z + 0.006) * 70)) * 0.0012 + (y < 1.715 ? -0.001 : 0),
    dispAmp: 0.002,
  };
}

function capGroup(): SdfGroup {
  return {
    prims: [
      ell(V(0, 1.742, -0.004), V(0.087, 0.075, 0.1)), plane(V(0, -1, 0), -1.706, { k: 0.006 }),
      box(V(0, 1.708, 0.12), V(0.075, 0.005, 0.045), { round: 0.004, k: 0.01, rot: eul(0.2, 0, 0) }), // brim
    ],
    disp: (x, y, z) => fbm3(x * 30, y * 30, z * 30, 2, 13) * 0.002,
    dispAmp: 0.002,
  };
}

function vestGroups(v: Variant): { carrier: SdfGroup; pouches: SdfGroup; mags: SdfGroup } {
  const b = 1 + v.bulk * 0.05;
  const nylon = (seed: number) => (x: number, y: number, z: number) => fbm3(x * 50, y * 50, z * 50, 2, seed) * 0.0012;
  const carrier: Prim[] = [];
  if (v.vest === 'plate') {
    // cummerbund shell first (intersections only affect what came before)
    carrier.push(
      ell(V(0, 1.18, -0.005), V(0.195 * b, 0.3, 0.155 * b)),
      ell(V(0, 1.18, -0.005), V(0.178 * b, 0.29, 0.14 * b), { op: 'sub' }),
      plane(V(0, 1, 0), 1.25, { k: 0.01 }),
      plane(V(0, -1, 0), -1.09, { k: 0.01 }),
      box(V(0, 1.27, 0.148 * b), V(0.135, 0.165, 0.03), { round: 0.022, rot: eul(-0.06, 0, 0), k: 0.02 }), // front plate bag
      box(V(0, 1.285, -0.157 * b), V(0.135, 0.17, 0.03), { round: 0.022, rot: eul(0.05, 0, 0), k: 0.02 }), // back plate bag
      box(V(0, 1.44, -0.18 * b), V(0.03, 0.012, 0.02), { round: 0.006, k: 0.005 }), // drag handle
      ...both([
        box(V(0.098, 1.445, 0.118), V(0.035, 0.05, 0.012), { round: 0.01, rot: eul(-0.55, 0, 0), k: 0.02 }), // shoulder straps
        box(V(0.1, 1.495, 0.0), V(0.036, 0.012, 0.11), { round: 0.01, rot: eul(0, 0, -0.12), k: 0.03 }),
        box(V(0.098, 1.45, -0.128), V(0.035, 0.05, 0.012), { round: 0.01, rot: eul(0.5, 0, 0), k: 0.02 }),
      ]),
    );
  } else {
    // chest rig: pouch panel + X harness
    carrier.push(
      box(V(0, 1.22, 0.138 * b), V(0.15, 0.085, 0.025), { round: 0.015, rot: eul(-0.1, 0, 0) }),
      ...both([
        box(V(0.1, 1.4, 0.1), V(0.022, 0.12, 0.012), { round: 0.008, rot: eul(-0.45, 0, -0.15), k: 0.02 }),
        box(V(0.1, 1.49, -0.02), V(0.024, 0.01, 0.1), { round: 0.008, rot: eul(0, 0, -0.1), k: 0.03 }),
        cap(V(0.08, 1.44, -0.13), V(-0.1, 1.2, -0.13), 0.012, { k: 0.02 }), // X straps on back
      ]),
      box(V(0, 1.18, -0.005), V(0.17 * b, 0.018, 0.14 * b), { round: 0.012, k: 0.01 }), // waist strap
    );
  }
  const pouches: Prim[] = [];
  const mags: Prim[] = [];
  const front = v.vest === 'plate' ? 0.19 * b : 0.176 * b;
  const py = v.vest === 'plate' ? 1.2 : 1.225;
  for (let i = -1; i <= 1; i++) {
    const x = i * 0.078;
    pouches.push(box(V(x, py, front), V(0.034, 0.068, 0.022), { round: 0.012, k: 0.004 }));
    pouches.push(box(V(x, py + 0.064, front + 0.004), V(0.035, 0.012, 0.024), { round: 0.008, k: 0.004 })); // bungee top
    mags.push(box(V(x, py + 0.082, front + 0.001), V(0.024, 0.02, 0.012), { round: 0.005, rot: eul(0.15, 0, 0) }));
  }
  if (v.vest === 'plate') {
    pouches.push(box(V(0, 1.39, 0.186 * b), V(0.085, 0.048, 0.016), { round: 0.012 })); // admin pouch
    pouches.push(...both([cyl(V(0.19 * b, 1.13, 0.075), V(0.19 * b, 1.22, 0.075), 0.034, { round: 0.012 })])); // frag pouches
    pouches.push(box(V(-0.2 * b, 1.165, -0.03), V(0.022, 0.05, 0.05), { round: 0.012 })); // IFAK side
  } else {
    pouches.push(...both([box(V(0.19, 1.225, 0.1), V(0.03, 0.06, 0.028), { round: 0.012, rot: eul(0, 0.6, 0) })]));
  }
  return {
    carrier: { prims: carrier, disp: nylon(51), dispAmp: 0.0015 },
    pouches: { prims: pouches, disp: nylon(52), dispAmp: 0.0015 },
    mags: { prims: mags },
  };
}

function beltGroup(v: Variant): SdfGroup {
  const b = 1 + v.bulk * 0.05;
  return {
    prims: [
      ell(V(0, 1.02, -0.012), V(0.182 * b, 0.2, 0.135 * b)),
      ell(V(0, 1.02, -0.012), V(0.166 * b, 0.19, 0.12 * b), { op: 'sub' }),
      plane(V(0, 1, 0), 1.052, { k: 0.006 }),
      plane(V(0, -1, 0), -0.998, { k: 0.006 }),
      box(V(0, 1.024, 0.135 * b), V(0.03, 0.022, 0.012), { round: 0.005, k: 0.004 }), // buckle
      box(V(-0.12, 0.985, -0.12), V(0.05, 0.06, 0.03), { round: 0.02, k: 0.006, rot: eul(0, 0.7, 0) }), // dump pouch
      box(V(0.14, 0.99, -0.095), V(0.03, 0.05, 0.03), { round: 0.012, k: 0.006, rot: eul(0, -0.9, 0) }), // pouch
    ],
  };
}

function holsterGroup(): { holster: SdfGroup; pistol: SdfGroup } {
  const holster: SdfGroup = {
    prims: [
      box(V(-0.178, 0.8, 0.012), V(0.022, 0.085, 0.048), { round: 0.016, rot: eul(0.12, 0, 0.05) }),
      box(V(-0.16, 0.86, 0.0), V(0.03, 0.012, 0.075), { round: 0.008, k: 0.01 }), // leg strap
      box(V(-0.155, 0.93, -0.01), V(0.018, 0.08, 0.018), { round: 0.008, k: 0.01 }), // drop strap
    ],
  };
  const pistol: SdfGroup = { prims: [box(V(-0.178, 0.9, -0.006), V(0.014, 0.036, 0.018), { round: 0.006, rot: eul(-0.3, 0, 0.05) })] };
  return { holster, pistol };
}

function backGroups(v: Variant): { pack: SdfGroup; hard: SdfGroup | null } {
  const back = v.vest === 'plate' ? -0.19 : -0.16;
  if (v.backpack === 'assault') {
    return {
      pack: {
        prims: [
          box(V(0, 1.27, back - 0.075), V(0.13, 0.19, 0.07), { round: 0.05 }),
          box(V(0, 1.4, back - 0.14), V(0.1, 0.07, 0.025), { round: 0.02, k: 0.02 }),
          box(V(0, 1.2, back - 0.15), V(0.09, 0.08, 0.018), { round: 0.02, k: 0.02 }),
          ...both([box(V(0.13, 1.25, back - 0.07), V(0.012, 0.012, 0.075), { round: 0.005, k: 0.006 }), box(V(0.13, 1.33, back - 0.07), V(0.012, 0.012, 0.075), { round: 0.005, k: 0.006 })]),
        ],
        disp: (x, y, z) => { const n = fbm3(x * 22, y * 22, z * 22, 3, 61); return -Math.abs(n) * 0.005; },
        dispAmp: 0.005,
      },
      hard: null,
    };
  }
  if (v.backpack === 'radio') {
    return {
      pack: { prims: [box(V(0.07, 1.28, back - 0.04), V(0.045, 0.085, 0.035), { round: 0.015 }), box(V(-0.07, 1.26, back - 0.035), V(0.05, 0.07, 0.03), { round: 0.02 })] },
      hard: {
        prims: [
          box(V(0.07, 1.375, back - 0.04), V(0.032, 0.018, 0.025), { round: 0.006 }),
          cyl(V(0.08, 1.39, back - 0.04), V(0.08, 1.42, back - 0.04), 0.008, { round: 0.003, k: 0.004 }),
          cone(V(0.08, 1.42, back - 0.04), V(0.1, 1.72, back - 0.07), 0.005, 0.0025, { k: 0.004 }), // antenna
          cap(V(0.03, 1.39, back - 0.02), V(0.12, 1.47, 0.03), 0.006, { k: 0.01 }), // PTT cable
        ],
      },
    };
  }
  return {
    pack: {
      prims: [box(V(0, 1.27, back - 0.045), V(0.105, 0.16, 0.042), { round: 0.035 }), cyl(V(0.06, 1.44, back - 0.05), V(0.07, 1.46, back - 0.02), 0.008, { k: 0.006 })],
      disp: (x, y, z) => { const n = fbm3(x * 26, y * 26, z * 26, 3, 71); return -Math.abs(n) * 0.004; },
      dispAmp: 0.004,
    },
    hard: null,
  };
}

// ------------------------------------------------------------------ assembly

interface PartDef {
  key: string;
  group: SdfGroup;
  h: number;
  mat: MaterialName;
  tint: number;
  weights: WeightOpts;
  uv: 'cyl' | 'box';
  rough?: number;
  metal?: number;
  aoStrength?: number;
  shadow?: boolean;
  /** decimation error (m) */
  err?: number;
}

function partsFor(v: Variant): PartDef[] {
  const P: PartDef[] = [];
  const body: Region[] = ['torso', 'armL', 'armR', 'legL', 'legR'];
  const vkey = `b${Math.round(v.bulk * 4)}`;
  P.push({ key: 'shirt' + vkey, group: shirtGroup(v), h: 0.0105, mat: v.shirtMat, tint: v.shirtTint, weights: { regions: ['torso', 'head', 'armL', 'armR'] }, uv: 'cyl' });
  P.push({ key: 'pants' + vkey, group: pantsGroup(v), h: 0.011, mat: v.pantsMat, tint: v.pantsTint, weights: { regions: ['torso', 'legL', 'legR'] }, uv: 'cyl' });
  P.push({ key: 'headskin', group: headSkinGroup(), h: 0.0055, mat: 'skin', tint: v.skinTint, weights: { regions: ['head'] }, uv: 'cyl' });
  P.push({ key: 'eyes', group: eyesGroup(), h: 0.004, mat: 'plastic_black', tint: 0x302a26, weights: { bone: B.head }, uv: 'box', rough: 0.15, shadow: false });
  const gl = gloveGroup(1);
  P.push({ key: 'gloveL', group: gl, h: 0.0048, mat: 'glove_leather', tint: v.gloveTint, weights: { regions: ['armL'] }, uv: 'box' });
  P.push({ key: 'gloveR', group: gloveGroup(-1), h: 0.0048, mat: 'glove_leather', tint: v.gloveTint, weights: { regions: ['armR'] }, uv: 'box' });
  const boots = bootGroup();
  const mirG = (g: SdfGroup): SdfGroup => ({ ...g, prims: g.prims.map(mirrorX), disp: g.disp ? (x, y, z) => g.disp!(-x, y, z) : undefined });
  P.push({ key: 'bootL', group: boots.upper, h: 0.0065, mat: 'glove_leather', tint: v.bootTint, weights: { regions: ['legL'] }, uv: 'box' });
  P.push({ key: 'bootR', group: mirG(boots.upper), h: 0.0065, mat: 'glove_leather', tint: v.bootTint, weights: { regions: ['legR'] }, uv: 'box' });
  P.push({ key: 'soleL', group: boots.sole, h: 0.0055, mat: 'rubber', tint: 0x3a3632, weights: { regions: ['legL'] }, uv: 'box' });
  P.push({ key: 'soleR', group: mirG(boots.sole), h: 0.0055, mat: 'rubber', tint: 0x3a3632, weights: { regions: ['legR'] }, uv: 'box' });
  if (v.kneepads) {
    const k = kneepadGroup();
    P.push({ key: 'kneeL', group: k, h: 0.005, mat: 'plastic_black', tint: 0x4a4a44, weights: { regions: ['legL'] }, uv: 'box', rough: 0.55 });
    P.push({ key: 'kneeR', group: mirG(k), h: 0.005, mat: 'plastic_black', tint: 0x4a4a44, weights: { regions: ['legR'] }, uv: 'box', rough: 0.55 });
  }
  // face
  if (v.face === 'balaclava') P.push({ key: 'balaclava', group: balaclavaGroup(), h: 0.0055, mat: 'cloth_black', tint: v.faceTint, weights: { regions: ['head', 'torso'] }, uv: 'cyl' });
  else if (v.face === 'shemagh') P.push({ key: 'shemagh', group: shemaghGroup(), h: 0.006, mat: 'canvas', tint: v.faceTint, weights: { regions: ['head', 'torso'] }, uv: 'cyl' });
  else if (v.face === 'gasmask') {
    const gm = gasmaskGroups();
    P.push({ key: 'balaclava', group: balaclavaGroup(), h: 0.0055, mat: 'cloth_black', tint: v.faceTint, weights: { regions: ['head', 'torso'] }, uv: 'cyl' });
    P.push({ key: 'gasmask', group: gm.mask, h: 0.0045, mat: 'rubber', tint: 0x2a2a28, weights: { bone: B.head }, uv: 'box', rough: 0.6 });
    P.push({ key: 'gaslens', group: gm.lens, h: 0.004, mat: 'glass', tint: 0x6a7a70, weights: { bone: B.head }, uv: 'box', rough: 0.05, shadow: false });
    P.push({ key: 'gascan', group: gm.canister, h: 0.0045, mat: 'metal_painted_green', tint: 0x6a6a55, weights: { bone: B.head }, uv: 'box' });
  }
  // headgear
  if (v.headgear === 'helmet_cover' || v.headgear === 'helmet_bare') {
    const hs = helmetGroups(v);
    P.push({ key: 'helmet_' + v.headgear, group: hs[0], h: 0.0055, mat: v.headgear === 'helmet_cover' ? 'cloth_multicam' : 'metal_painted_green', tint: v.headgear === 'helmet_cover' ? 0xe0dccc : v.helmetTint, weights: { bone: B.head }, uv: 'box', rough: v.headgear === 'helmet_bare' ? 0.7 : undefined });
    P.push({ key: 'helmhw' + (v.headset ? 'h' : ''), group: helmetHardware(v), h: 0.0045, mat: 'plastic_black', tint: 0x3a3a36, weights: { bone: B.head }, uv: 'box', rough: 0.5 });
    if (v.goggles) {
      const g = gogglesGroups(true);
      P.push({ key: 'gogframe', group: g.frame, h: 0.004, mat: 'rubber', tint: 0x2a2a28, weights: { bone: B.head }, uv: 'box' });
      P.push({ key: 'goglens', group: g.lens, h: 0.004, mat: 'glass', tint: 0x9a7a40, weights: { bone: B.head }, uv: 'box', shadow: false });
    }
  } else if (v.headgear === 'beanie') {
    P.push({ key: 'beanie', group: beanieGroup(), h: 0.0055, mat: 'cloth_black', tint: v.helmetTint, weights: { bone: B.head }, uv: 'cyl' });
    if (v.headset) P.push({ key: 'headset', group: { prims: both([cyl(V(0.085, 1.672, 0.0), V(0.118, 1.672, 0.0), 0.036, { round: 0.012 })]).concat(headband(0.104, 1.832, 1.69)) }, h: 0.0045, mat: 'plastic_black', tint: 0x3a3a36, weights: { bone: B.head }, uv: 'box' });
  } else {
    P.push({ key: 'cap', group: capGroup(), h: 0.0055, mat: v.shirtMat, tint: v.shirtTint, weights: { bone: B.head }, uv: 'box' });
  }
  // torso gear
  const vg = vestGroups(v);
  P.push({ key: 'vest' + v.vest + vkey, group: vg.carrier, h: 0.0065, mat: 'canvas', tint: v.gearTint, weights: { regions: ['torso'] }, uv: 'box' });
  P.push({ key: 'pouch' + v.vest + vkey, group: vg.pouches, h: 0.0055, mat: 'canvas', tint: shade(v.gearTint, 0.94), weights: { regions: ['torso'] }, uv: 'box' });
  P.push({ key: 'mags' + v.vest + vkey, group: vg.mags, h: 0.0045, mat: 'gun_polymer_black', tint: 0x6a4a2a, weights: { regions: ['torso'] }, uv: 'box' });
  P.push({ key: 'belt' + vkey, group: beltGroup(v), h: 0.0065, mat: 'canvas', tint: shade(v.gearTint, 0.85), weights: { regions: ['torso'] }, uv: 'box' });
  const hol = holsterGroup();
  P.push({ key: 'holster', group: hol.holster, h: 0.0055, mat: 'plastic_black', tint: 0x3a3a34, weights: { regions: ['legR'] }, uv: 'box' });
  P.push({ key: 'pistol', group: hol.pistol, h: 0.0045, mat: 'gun_polymer_black', tint: 0x999999, weights: { regions: ['legR'] }, uv: 'box' });
  const bg = backGroups(v);
  P.push({ key: 'pack' + v.backpack + v.vest, group: bg.pack, h: 0.0075, mat: 'canvas', tint: shade(v.gearTint, 1.05), weights: { regions: ['torso'] }, uv: 'box' });
  if (bg.hard) P.push({ key: 'packhw' + v.backpack + v.vest, group: bg.hard, h: 0.004, mat: 'plastic_black', tint: 0x2e2e2c, weights: { bone: B.spine2 }, uv: 'box' });
  void body;
  return P;
}

function shade(hex: number, f: number) { return new THREE.Color(hex).multiplyScalar(f).getHex(); }

// ------------------------------------------------------------------ geometry build + cache

const geoCache = new Map<string, THREE.BufferGeometry>();
export const buildStats: string[] = [];

function buildGeometry(part: PartDef, allGroups: { g: SdfGroup; bb: THREE.Box3 }[]): THREE.BufferGeometry {
  const t0 = performance.now();
  const fine = meshGroup(part.group, part.h);
  const raw = simplifyMesh(fine, part.err ?? 0.0006);
  const t1 = performance.now();
  const tmpBB = new THREE.Vector3();
  const total = (x: number, y: number, z: number) => {
    let d = 1e9;
    tmpBB.set(x, y, z);
    for (const { g, bb } of allGroups) {
      if (bb.distanceToPoint(tmpBB) > Math.min(d, 0.12)) continue;
      d = Math.min(d, evalGroup(g, x, y, z));
    }
    return d;
  };
  const ao = computeAO(raw, total, part.aoStrength ?? 1);
  const t2 = performance.now();
  const n = raw.pos.length / 3;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), uv = new Float32Array(n * 2);
  const p = new THREE.Vector3();
  const cache = new Map<string, { idx: number[]; w: number[] }>();
  for (let i = 0; i < n; i++) {
    p.set(raw.pos[i * 3], raw.pos[i * 3 + 1], raw.pos[i * 3 + 2]);
    // weights vary slowly: quantize to 4mm for caching
    const key = `${Math.round(p.x * 250)},${Math.round(p.y * 250)},${Math.round(p.z * 250)}`;
    let sw = cache.get(key);
    if (!sw) { sw = skinWeights(p, part.weights); cache.set(key, sw); }
    for (let k = 0; k < 4; k++) { skinIndex[i * 4 + k] = sw.idx[k]; skinWeight[i * 4 + k] = sw.w[k]; }
    // UVs in meters (for 'uv' mapping fallback; library uses object-space triplanar by default for us)
    if (part.uv === 'cyl') {
      uv[i * 2] = Math.atan2(p.x, p.z) * 0.18; uv[i * 2 + 1] = p.y;
    } else {
      const ax = Math.abs(raw.nrm[i * 3]), ay = Math.abs(raw.nrm[i * 3 + 1]), az = Math.abs(raw.nrm[i * 3 + 2]);
      if (ax > ay && ax > az) { uv[i * 2] = p.z; uv[i * 2 + 1] = p.y; } else if (ay > az) { uv[i * 2] = p.x; uv[i * 2 + 1] = p.z; } else { uv[i * 2] = p.x; uv[i * 2 + 1] = p.y; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(raw.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(raw.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  g.setIndex(new THREE.BufferAttribute(raw.idx, 1));
  g.computeBoundingSphere();
  buildStats.push(`${part.key}: mesh ${(t1 - t0).toFixed(0)} ao ${(t2 - t1).toFixed(0)} w ${(performance.now() - t2).toFixed(0)} tris ${fine.idx.length / 3}->${raw.idx.length / 3}`);
  return g;
}

// ------------------------------------------------------------------ materials

const matCache = new Map<string, THREE.Material>();

/** Clone a library material, add baked-AO + tint. Keeps the library's own shader patch (chained). */
export function characterMaterial(ctx: GameContext, name: MaterialName, tint: number, rough?: number, metal?: number): THREE.Material {
  const key = `${name}|${tint}|${rough ?? ''}|${metal ?? ''}`;
  let m = matCache.get(key);
  if (m) return m;
  const base = ctx.materials.get(name, { mapping: 'object', seed: 3 } as never) as THREE.MeshStandardMaterial;
  const c = base.clone() as THREE.MeshStandardMaterial;
  const origCompile = base.onBeforeCompile;
  const origKey = base.customProgramCacheKey?.bind(base);
  c.color.multiply(new THREE.Color(tint));
  if (rough !== undefined) c.roughness = rough;
  if (metal !== undefined) c.metalness = metal;
  c.onBeforeCompile = (shader, r) => {
    origCompile.call(base, shader, r);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float ao;\nvarying float vAiAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAiAO = ao;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAiAO;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  {
    float aiAO = vAiAO;
    reflectedLight.indirectDiffuse *= aiAO;
    reflectedLight.indirectSpecular *= aiAO * aiAO;
    reflectedLight.directDiffuse *= mix(0.55, 1.0, aiAO);
    reflectedLight.directSpecular *= mix(0.4, 1.0, aiAO);
  }`);
  };
  c.customProgramCacheKey = () => (origKey ? origKey() : '') + '|aiAO';
  matCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ public: character instance

export interface CharacterModel {
  root: THREE.Group; // world placement (feet), yaw
  scaled: THREE.Group; // uniform height scale lives here
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  meshes: THREE.SkinnedMesh[];
  variant: Variant;
}

export function buildCharacter(ctx: GameContext, v: Variant): CharacterModel {
  const parts = partsFor(v);
  const groups = parts.map((p) => ({ g: p.group, bb: groupBounds(p.group) }));
  const { bones, skeleton } = buildSkeleton();
  const root = new THREE.Group();
  const scaled = new THREE.Group();
  scaled.scale.setScalar(v.height);
  root.add(scaled);
  scaled.add(bones[0]);
  const meshes: THREE.SkinnedMesh[] = [];
  for (const part of parts) {
    let geo = geoCache.get(part.key);
    if (!geo) { geo = buildGeometry(part, groups); geoCache.set(part.key, geo); }
    const mat = characterMaterial(ctx, part.mat, part.tint, part.rough, part.metal);
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.castShadow = part.shadow !== false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    mesh.name = part.key;
    scaled.add(mesh);
    meshes.push(mesh);
  }
  return { root, scaled, bones, skeleton, meshes, variant: v };
}

export function characterCacheStats() { let tris = 0; geoCache.forEach((g) => (tris += (g.index?.count ?? 0) / 3)); return { parts: geoCache.size, tris }; }

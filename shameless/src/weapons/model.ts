import * as THREE from 'three';
import type { GunMaterials } from './materials';
import { finish, merge } from './geom';

/** Signed distance function in weapon space (meters). */
export type SDF = (p: THREE.Vector3) => number;

export interface HandGrip {
  /** Wrist transform in weapon space: position + euler (YXZ). */
  wrist: [number, number, number, number, number, number];
  /** Surface the fingers wrap around (weapon space). */
  sdf: SDF;
  /** Fixed index finger flex (e.g. on trigger) instead of solving; null = solve. */
  index?: [number, number, number] | null;
  /** Thumb solve on/off; fixed thumb angles otherwise [cmcFlex, cmcAbd, mcp, ip, roll]. */
  thumb?: [number, number, number, number, number] | null;
  spread?: number;
  /** Weapon-space point the index finger pad should rest on (e.g. trigger face). */
  indexTarget?: THREE.Vector3;
  /** Weapon-space point the thumb tip should reach. */
  thumbTarget?: THREE.Vector3;
  /** Target skin gap (fraction of finger radius that may sink into the surface). */
  squeeze?: number;
}

export interface WeaponModel {
  id: string;
  kind: 'rifle' | 'pistol';
  root: THREE.Group;
  /** Muzzle exit; local -Z is the bore direction. */
  muzzle: THREE.Object3D;
  /** Ejection port; local +X is ejection direction. */
  eject: THREE.Object3D;
  /** Point on the sight line where the eye aligns in ADS (weapon space). */
  sightPoint: THREE.Vector3;
  /** Distance from eye to sightPoint in ADS. */
  eyeRelief: number;
  /** Lens frame used by the reticle shader (lens plane at origin, axis -Z). */
  lens?: THREE.Object3D;
  reticle?: THREE.ShaderMaterial;
  /** Reciprocating part (bolt carrier / slide): moves +Z by boltTravel when cycling. */
  bolt: THREE.Object3D;
  boltTravel: number;
  /** Magazine currently in the weapon (animated during reload) + its seated local transform. */
  mag: THREE.Group;
  magSeat: THREE.Matrix4;
  /** Fresh magazine brought in by the off hand during reload. */
  magNew: THREE.Group;
  /** Grip point on the magazine for the off hand, in magazine space. */
  magHandle: THREE.Matrix4;
  trigger: THREE.Object3D;
  dustCover?: THREE.Object3D;
  boltCatch?: THREE.Object3D;
  selector?: THREE.Object3D;
  hammerOrStriker?: THREE.Object3D;
  /** Weapon-space pivot used for recoil / sway rotation (roughly the grip). */
  pivot: THREE.Vector3;
  rightGrip: HandGrip;
  leftGrip: HandGrip;
  /** Off-hand poses referenced by animations (weapon space). */
  leftPoses: Record<string, HandGrip>;
  /** Parts that should render in the viewmodel with the flash light, etc. */
  dispose(): void;
}

/** Collects geometry per material bucket, finishes (crease + UV) and merges into meshes. */
export class PartBuilder {
  private buckets = new Map<keyof GunMaterials, THREE.BufferGeometry[]>();
  constructor(private mats: GunMaterials) {}
  add(mat: keyof GunMaterials, g: THREE.BufferGeometry, creaseDeg = 40): void {
    const f = finish(g, creaseDeg);
    let b = this.buckets.get(mat);
    if (!b) this.buckets.set(mat, (b = []));
    b.push(f);
  }
  /** Adds already-finished geometry as-is. */
  addRaw(mat: keyof GunMaterials, g: THREE.BufferGeometry): void {
    let b = this.buckets.get(mat);
    if (!b) this.buckets.set(mat, (b = []));
    b.push(g);
  }
  build(name: string): THREE.Group {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [mat, list] of this.buckets) {
      const m = new THREE.Mesh(merge(list), this.mats[mat]);
      m.name = `${name}:${String(mat)}`;
      m.castShadow = true;
      m.receiveShadow = true;
      grp.add(m);
    }
    this.buckets.clear();
    return grp;
  }
}

// ---------------- SDF primitives ----------------
const _v = new THREE.Vector3();
/** Elliptic cylinder along axis a->b with half widths (rx along `side`, ry perpendicular), rounded ends. */
export function sdEllipticCapsule(a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, rx: number, ry: number): SDF {
  const ax = b.clone().sub(a);
  const len = ax.length();
  ax.normalize();
  const sx = side.clone().sub(ax.clone().multiplyScalar(side.dot(ax))).normalize();
  const sy = ax.clone().cross(sx).normalize();
  const rmin = Math.min(rx, ry);
  return (p) => {
    _v.copy(p).sub(a);
    const t = THREE.MathUtils.clamp(_v.dot(ax), 0, len);
    const along = _v.dot(ax) - t;
    const x = _v.dot(sx) / rx, y = _v.dot(sy) / ry;
    const radial = (Math.hypot(x, y) - 1) * rmin;
    if (along === 0) return radial;
    return Math.hypot(Math.max(radial, 0), along) + Math.min(radial, 0);
  };
}
/** Axis-aligned rounded box (center c, half extents h, rounding r). */
export function sdRoundBox(c: THREE.Vector3, h: THREE.Vector3, r: number): SDF {
  return (p) => {
    const qx = Math.abs(p.x - c.x) - h.x + r, qy = Math.abs(p.y - c.y) - h.y + r, qz = Math.abs(p.z - c.z) - h.z + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}
/** Oriented rounded box: matrix maps box-local -> weapon space. */
export function sdOrientedBox(m: THREE.Matrix4, h: THREE.Vector3, r: number): SDF {
  const inv = m.clone().invert();
  const f = sdRoundBox(new THREE.Vector3(), h, r);
  const tmp = new THREE.Vector3();
  return (p) => f(tmp.copy(p).applyMatrix4(inv));
}
export function sdCapsule(a: THREE.Vector3, b: THREE.Vector3, r: number): SDF {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const tmp = new THREE.Vector3();
  return (p) => {
    const t = THREE.MathUtils.clamp(tmp.copy(p).sub(a).dot(ab) / l2, 0, 1);
    return tmp.copy(a).addScaledVector(ab, t).distanceTo(p) - r;
  };
}
export const sdUnion = (...fs: SDF[]): SDF => (p) => { let d = Infinity; for (const f of fs) d = Math.min(d, f(p)); return d; };

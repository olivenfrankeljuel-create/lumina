import * as THREE from 'three';
import type { GunMaterials } from './materials';
import { createReticleMaterial, engravingTexture } from './materials';
import {
  P2, shape, path, rrectShape, rrectPath, circlePath, extrudeSide, extrudeTop, extrudeFront, latheZ, latheAxis,
  csgSub, box, roundBox, chamferBox, xform, cylinderBetween, finish, merge,
} from './geom';
import { gripWrist } from './arms';
import { PartBuilder, WeaponModel, sdEllipticCapsule, sdRoundBox, sdUnion, SDF, sdOrientedBox } from './model';

/**
 * M4A1-style carbine, modeled entirely in code.
 * Weapon space: bore axis along Z at y = 0, z = 0 at the rear face of the upper receiver, muzzle toward -Z.
 */

// Key dimensions (meters)
const RAIL_TOP = 0.0263;
const WIN_CY = 0.0302; // holo window center above the rail top (sight line)
const UPPER_TOP = 0.0175;
const SEAM = -0.0115;
const UPPER_LEN = 0.178;
const HG_REAR = -0.1805, HG_FRONT = -0.47;
const MUZZLE_Z = -0.556;
const GRIP_RAKE = 0.35;

/** Picatinny rail: continuous spine + individual teeth. z0 (rear) -> z1 (front, more negative). */
export function picatinny(z0: number, z1: number, base = UPPER_TOP): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const b = base - UPPER_TOP; // vertical offset
  const spine = shape([
    [-0.0078, UPPER_TOP + b - 0.0005], [0.0078, UPPER_TOP + b - 0.0005], [0.0078, 0.0200 + b], [0.0106, 0.0226 + b],
    [0.0106, 0.0232 + b], [-0.0106, 0.0232 + b], [-0.0106, 0.0226 + b], [-0.0078, 0.0200 + b],
  ]);
  out.push(extrudeFront(spine, z0 - z1, { bevel: 0.0003, bevelSegs: 1 }, z0));
  const tooth = shape([
    [-0.0106, 0.0231 + b], [0.0106, 0.0231 + b], [0.0106, 0.0238 + b], [0.0081, RAIL_TOP + b], [-0.0081, RAIL_TOP + b], [-0.0106, 0.0238 + b],
  ]);
  const pitch = 0.01, slot = 0.0052, tl = pitch - slot;
  const n = Math.floor((z0 - z1 - 0.002) / pitch);
  const start = z0 - ((z0 - z1) - n * pitch) / 2 - slot / 2;
  for (let i = 0; i < n; i++) {
    const zc = start - i * pitch;
    out.push(extrudeFront(tooth, tl, { bevel: 0.00035, bevelSegs: 1 }, zc));
  }
  return out;
}

/** 5.56 cartridge along -Z (bullet forward), base at z = 0. */
export function cartridge556(): { brass: THREE.BufferGeometry; tip: THREE.BufferGeometry } {
  const brass = latheZ([
    [0, 0], [0.0045, 0], [0.0048, 0.0004], [0.0048, 0.0011], [0.0040, 0.0013], [0.0040, 0.0020], [0.0047, 0.0026],
    [0.0045, 0.036], [0.0034, 0.0395], [0.0029, 0.0400], [0.0029, 0.0455], [0, 0.0455],
  ], 16);
  const tip = latheZ([[0, 0.0445], [0.00285, 0.0445], [0.00285, 0.050], [0.0022, 0.054], [0.0010, 0.0565], [0, 0.0572]], 16);
  return { brass, tip };
}

function buildMagazine(mats: GunMaterials, loaded: boolean): THREE.Group {
  const pb = new PartBuilder(mats);
  // Curved STANAG/PMAG body in mag-local space: origin = rear-top of body, u forward, v up.
  const K = 0.85; // curvature coefficient
  const H = 0.19;
  const D = 0.0635;
  const ur = (v: number) => K * v * v;
  const front: P2[] = [], rear: P2[] = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const v = -H * (i / N);
    front.push([D + ur(v) + (-v) * 0.012, v]);
    rear.push([ur(v), v]);
  }
  const bodyPts: P2[] = [...front, ...rear.reverse()];
  const body = shape(bodyPts, 0.0);
  pb.add('polymerFde', extrudeSide(body, 0.0228, { bevel: 0.0024, bevelSegs: 3, curveSegs: 2 }), 50);
  // Ribs: horizontal texture band near the base (both sides) + vertical stiffener rib
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const v0 = -0.136 - k * 0.0105;
      const pts: P2[] = [];
      const vA = v0, vB = v0 - 0.0045;
      pts.push([ur(vA) + 0.008, vA], [D + ur(vA) - vA * 0.012 - 0.008, vA], [D + ur(vB) - vB * 0.012 - 0.008, vB], [ur(vB) + 0.008, vB]);
      pb.add('polymerFde', extrudeSide(shape(pts, 0.001), 0.0022, { bevel: 0.0006, bevelSegs: 2 }, side * 0.0112), 50);
    }
    // vertical spine rib along the rear (slightly inset)
    const rib: P2[] = [];
    const M = 10;
    for (let i = 0; i <= M; i++) { const v = -0.012 - (0.11 * i) / M; rib.push([ur(v) + 0.0105, v]); }
    for (let i = M; i >= 0; i--) { const v = -0.012 - (0.11 * i) / M; rib.push([ur(v) + 0.0145, v]); }
    pb.add('polymerFde', extrudeSide(shape(rib, 0.0), 0.0018, { bevel: 0.0005, bevelSegs: 2, curveSegs: 1 }, side * 0.0114), 50);
  }
  // Floorplate: flared, tilted with the curve at the base.
  {
    const vb = -H;
    const slope = 2 * K * vb; // du/dv
    const ang = Math.atan(slope); // tilt
    const cu = (ur(vb) + D + ur(vb) - vb * 0.012) / 2;
    const fp = shape([[-0.038, 0.004], [0.040, 0.004], [0.043, -0.004], [0.040, -0.0125], [-0.038, -0.0125], [-0.041, -0.004]], [0.002, 0.002, 0.004, 0.004, 0.004, 0.004]);
    const g = extrudeSide(fp, 0.0272, { bevel: 0.0025, bevelSegs: 3 });
    g.rotateX(-ang);
    g.translate(0, vb, -cu);
    pb.add('polymerFde', g, 50);
  }
  // Feed lips rim (top), follower, cartridges
  {
    const outer = shape([[0.004, 0], [0.056, 0], [0.058, 0.004], [0.050, 0.0085], [0.010, 0.0085], [0.004, 0.004]], 0.001);
    pb.add('polymerFde', extrudeSide(outer, 0.0205, { bevel: 0.0008, bevelSegs: 2 }), 45);
  }
  const grp = pb.build(loaded ? 'magNew' : 'mag');
  const fol = new THREE.Mesh(finish(xform(roundBox(0.016, 0.004, 0.050, 0.0012), 0, 0.0092, -0.031)), mats.follower);
  fol.name = 'follower';
  grp.add(fol);
  if (loaded) {
    const c = cartridge556();
    const brass = new THREE.Mesh(finish(merge([xform(c.brass.clone(), 0.0028, 0.0138, -0.008)])), mats.brass);
    const tip = new THREE.Mesh(finish(xform(c.tip.clone(), 0.0028, 0.0138, -0.008)), mats.copper);
    const brass2 = new THREE.Mesh(finish(xform(c.brass.clone(), -0.0030, 0.0125, -0.006)), mats.brass);
    const tip2 = new THREE.Mesh(finish(xform(c.tip.clone(), -0.0030, 0.0125, -0.006)), mats.copper);
    grp.add(brass, tip, brass2, tip2);
    fol.visible = false;
  }
  grp.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return grp;
}

export function buildRifle(mats: GunMaterials): WeaponModel {
  const root = new THREE.Group();
  root.name = 'm4';
  const pb = new PartBuilder(mats);

  // ---------------------------------------------------------------- Upper receiver (anodized)
  {
    const xs: P2[] = [[-0.0112, SEAM], [0.0112, SEAM], [0.0112, 0.0112], [0.0079, UPPER_TOP], [-0.0079, UPPER_TOP], [-0.0112, 0.0112]];
    let up = extrudeFront(shape(xs, [0.0008, 0.0008, 0.002, 0.001, 0.001, 0.002]), UPPER_LEN, { bevel: 0.0009, bevelSegs: 2 }, 0);
    // Ejection port recess (right side), CH channel at the rear top, front-bottom relief
    const cutters = [
      box(0.02, 0.0172, 0.058, 0.0165, 0.0026, -0.081),
    ];
    up = csgSub(up, ...cutters);
    pb.add('anodized', up, 35);
    // raised reinforcement band around the front (barrel nut area) on each side
    pb.add('anodized', extrudeSide(shape([[0.150, SEAM + 0.001], [UPPER_LEN, SEAM + 0.001], [UPPER_LEN, 0.010], [0.150, 0.010]], 0.002), 0.0238, { bevel: 0.0008, bevelSegs: 2 }), 35);
    // Brass deflector (right)
    pb.add('anodized', extrudeSide(shape([[0.028, -0.004], [0.047, -0.004], [0.047, 0.0135], [0.036, 0.0135]], [0.001, 0.001, 0.002, 0.003]), 0.0065, { bevel: 0.0012, bevelSegs: 2 }, 0.0132), 35);
    // Forward assist housing + plunger (right, angled back/out)
    const faO = new THREE.Vector3(0.006, 0.0045, -0.040);
    const faD = new THREE.Vector3(0.42, 0.06, 1).normalize();
    pb.add('anodized', latheAxis([[0, 0], [0.0078, 0], [0.0078, 0.029], [0.0070, 0.031], [0, 0.031]], faO, faD, 24), 40);
    // teardrop housing boss blending the FA into the receiver side
    pb.add('anodized', extrudeSide(shape([[0.004, -0.004], [0.046, -0.004], [0.060, 0.004], [0.046, 0.0125], [0.004, 0.0125]], [0.002, 0.004, 0.006, 0.004, 0.002]), 0.0055, { bevel: 0.0018, bevelSegs: 3 }, 0.0122), 40);
    const btnO = faO.clone().addScaledVector(faD, 0.031);
    const btnProf: P2[] = [[0, -0.004], [0.0058, -0.004], [0.0058, 0.0035], [0.0052, 0.0048], [0.0035, 0.0056], [0, 0.0058]];
    pb.add('steelDark', latheAxis(btnProf, btnO, faD, 20), 40);
    // Receiver pins (upper side of pivot / takedown lugs)
  }
  // Upper rail
  for (const g of picatinny(-0.002, -UPPER_LEN + 0.001)) pb.add('anodized', g, 35);

  // ---------------------------------------------------------------- Lower receiver (anodized)
  {
    const prof: P2[] = [
      [-0.004, SEAM], [0.186, SEAM], [0.191, -0.0145], [0.1915, -0.0215], [0.186, -0.0285],
      [0.104, -0.0295], [0.104, -0.046], [0.020, -0.046], [0.004, -0.040], [-0.008, -0.030], [-0.011, -0.020], [-0.010, SEAM],
    ];
    const radii = [0.001, 0.001, 0.003, 0.004, 0.003, 0.002, 0.003, 0.006, 0.006, 0.006, 0.004, 0.001];
    const lower = extrudeSide(shape(prof, radii), 0.0216, { bevel: 0.0011, bevelSegs: 2 });
    pb.add('anodized', lower, 35);
    // Magazine well (hollow), with flared lip
    const mwOuter = shape([[-0.0139, 0.1035], [0.0139, 0.1035], [0.0139, 0.1868], [-0.0139, 0.1868]], [0.002, 0.002, 0.004, 0.004]);
    mwOuter.holes.push(rrectPath(0, 0.1452, 0.0238, 0.0668, 0.0025));
    pb.add('anodized', extrudeTop(mwOuter, 0.050, { bevel: 0.0009, bevelSegs: 2 }, -0.0715), 35);
    const lip = shape([[-0.0152, 0.1010], [0.0152, 0.1010], [0.0152, 0.1895], [-0.0152, 0.1895]], [0.003, 0.003, 0.005, 0.005]);
    lip.holes.push(rrectPath(0, 0.1452, 0.0250, 0.0700, 0.003));
    pb.add('anodized', extrudeTop(lip, 0.006, { bevel: 0.0014, bevelSegs: 3 }, -0.0735), 35);
    // Front-of-magwell grip ribs
    for (let i = 0; i < 5; i++) {
      pb.add('anodized', xform(chamferBox(0.022, 0.0022, 0.003, 0.0006), 0, -0.030 - i * 0.0068, -0.1872), 35);
    }
    // Receiver-extension boss (buffer tube thread housing)
    pb.add('anodized', latheZ([[0, 0], [0.0155, 0], [0.0168, 0.0013], [0.0168, 0.0115], [0.0155, 0.013], [0, 0.013]], 28, 0.011), 35);
    // Takedown / pivot pin heads (left and right), trigger & hammer pins
    for (const side of [-1, 1]) {
      const px = side * 0.0108;
      pb.add('steelDark', cylinderBetween(new THREE.Vector3(px, -0.0175, -0.1855), new THREE.Vector3(px + side * 0.0011, -0.0175, -0.1855), 0.0028, 0.0027, 16), 40);
      pb.add('steelDark', cylinderBetween(new THREE.Vector3(px, -0.0205, 0.0010), new THREE.Vector3(px + side * 0.0011, -0.0205, 0.0010), 0.0028, 0.0027, 16), 40);
      pb.add('steelDark', cylinderBetween(new THREE.Vector3(px, -0.0345, -0.0660), new THREE.Vector3(px + side * 0.0006, -0.0345, -0.0660), 0.0019, 0.0018, 12), 40);
      pb.add('steelDark', cylinderBetween(new THREE.Vector3(px, -0.0325, -0.0430), new THREE.Vector3(px + side * 0.0006, -0.0325, -0.0430), 0.0019, 0.0018, 12), 40);
    }
    // Mag release button + fence (right side)
    pb.add('steelDark', cylinderBetween(new THREE.Vector3(0.0105, -0.030, -0.0975), new THREE.Vector3(0.0138, -0.030, -0.0975), 0.0046, 0.0044, 20), 40);
    pb.add('anodized', extrudeSide(shape([[0.088, -0.0425], [0.104, -0.0425], [0.104, -0.036], [0.092, -0.036]], 0.002), 0.004, { bevel: 0.001, bevelSegs: 2 }, 0.0118), 35);
    // Trigger guard (polymer, enlarged)
    const tgO = shape([[0.1045, -0.0450], [0.1045, -0.0545], [0.0930, -0.0665], [0.0470, -0.0665], [0.0380, -0.0590], [0.0380, -0.0450]], [0.001, 0.004, 0.006, 0.006, 0.004, 0.001]);
    tgO.holes.push(path([[0.0985, -0.0482], [0.0980, -0.0535], [0.0900, -0.0615], [0.0500, -0.0615], [0.0445, -0.0570], [0.0445, -0.0482]], [0.001, 0.003, 0.004, 0.004, 0.003, 0.001]));
    pb.add('polymer', extrudeSide(tgO, 0.0118, { bevel: 0.0018, bevelSegs: 3 }), 50);
  }
  // Roll-mark decals (left side of the lower / magwell): safe/semi/auto + maker mark
  {
    const tex = engravingTexture([
      { text: 'SHAMELESS ARMS', x: 12, y: 30, size: 30, bold: true },
      { text: 'M4A1  CAL 5.56 MM', x: 12, y: 70, size: 26 },
      { text: 'SER  SH-041127', x: 12, y: 104, size: 22 },
    ]);
    const m = mats.engrave.clone();
    m.map = tex; m.alphaMap = null; m.opacity = 0.55;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.052, 0.013), m);
    pl.rotation.y = -Math.PI / 2;
    pl.position.set(-0.0142, -0.046, -0.145);
    pl.renderOrder = 1;
    root.add(pl);
    const t2 = engravingTexture([
      { text: 'SAFE', x: 8, y: 26, size: 22, bold: true },
      { text: 'SEMI', x: 8, y: 64, size: 22, bold: true },
      { text: 'AUTO', x: 8, y: 102, size: 22, bold: true },
    ], 128, 128);
    const m2 = mats.engrave.clone();
    m2.map = t2; m2.opacity = 0.6;
    const pl2 = new THREE.Mesh(new THREE.PlaneGeometry(0.010, 0.010), m2);
    pl2.rotation.y = -Math.PI / 2;
    pl2.position.set(-0.0109, -0.0255, -0.018);
    pl2.renderOrder = 1;
    root.add(pl2);
  }

  // ---------------------------------------------------------------- Pistol grip (polymer), MOE-style, raked 20deg
  {
    const TH = GRIP_RAKE, u0 = 0.017, v0 = -0.043;
    const tf = ([b, a]: P2): P2 => [u0 + b * Math.cos(TH) + a * Math.sin(TH), v0 + a * Math.cos(TH) - b * Math.sin(TH)];
    const g: P2[] = ([
      [0.021, 0.006], [0.0225, -0.010], [0.0195, -0.021], [0.0235, -0.044], [0.0225, -0.074], [0.0195, -0.097], [0.0155, -0.104],
      [-0.0235, -0.104], [-0.0275, -0.097], [-0.0295, -0.070], [-0.0265, -0.040], [-0.0225, -0.019], [-0.0245, -0.007],
      [-0.0365, 0.0035], [-0.0385, 0.0105], [-0.028, 0.0135], [0.000, 0.009],
    ] as P2[]).map(tf);
    const r = [0.002, 0.004, 0.006, 0.02, 0.02, 0.008, 0.004, 0.004, 0.008, 0.02, 0.02, 0.006, 0.006, 0.004, 0.003, 0.004, 0.002];
    pb.add('polymer', extrudeSide(shape(g, r), 0.0305, { bevel: 0.0062, bevelSegs: 4, curveSegs: 6 }), 55);
    // stippled panels (slightly raised) on both sides
    const panel = shape(([[0.017, -0.030], [0.0185, -0.060], [0.0155, -0.090], [-0.022, -0.090], [-0.024, -0.060], [-0.019, -0.030]] as P2[]).map(tf), [0.004, 0.01, 0.004, 0.004, 0.01, 0.004]);
    for (const side of [-1, 1]) pb.add('rubber', extrudeSide(panel, 0.0016, { bevel: 0.0005, bevelSegs: 2 }, side * 0.0146), 50);
    // storage cap at the bottom
    const cap = shape(([[0.0135, -0.101], [0.0135, -0.1085], [-0.0215, -0.1085], [-0.0215, -0.101]] as P2[]).map(tf), 0.002);
    pb.add('polymer', extrudeSide(cap, 0.0255, { bevel: 0.002, bevelSegs: 2 }), 50);
  }

  // ---------------------------------------------------------------- Trigger (animated)
  const trigger = new THREE.Group();
  trigger.name = 'trigger';
  trigger.position.set(0, -0.0345, -0.066);
  {
    const tp: P2[] = [[0.0715, -0.040], [0.0712, -0.049], [0.0678, -0.0565], [0.0605, -0.0625], [0.0575, -0.0610], [0.0625, -0.0555], [0.0655, -0.049], [0.0660, -0.040]];
    const g = extrudeSide(shape(tp, [0, 0.004, 0.004, 0.001, 0.001, 0.004, 0.004, 0]), 0.0062, { bevel: 0.0009, bevelSegs: 2 });
    g.translate(0, 0.0345, 0.066);
    trigger.add(new THREE.Mesh(finish(g, 45), mats.parkerized));
  }
  root.add(trigger);

  // ---------------------------------------------------------------- Selector (left, animated)
  const selector = new THREE.Group();
  selector.name = 'selector';
  selector.position.set(-0.0108, -0.0225, -0.030);
  {
    const hub = cylinderBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.0022, 0, 0), 0.0052, 0.0050, 20);
    const lever = extrudeSide(shape([[0, -0.0025], [0.0155, -0.0019], [0.0165, 0], [0.0155, 0.0019], [0, 0.0025]], [0, 0.001, 0.001, 0.001, 0]), 0.0022, { bevel: 0.0006, bevelSegs: 2 }, -0.0024);
    selector.add(new THREE.Mesh(finish(merge([hub, lever]), 45), mats.steelDark));
    selector.rotation.x = -Math.PI / 2; // lever pointing down = FIRE
  }
  root.add(selector);
  // ambi selector stub (right)
  pb.add('steelDark', cylinderBetween(new THREE.Vector3(0.0108, -0.0225, -0.030), new THREE.Vector3(0.0128, -0.0225, -0.030), 0.0045, 0.0043, 16), 40);

  // ---------------------------------------------------------------- Bolt catch (left, animated)
  const boltCatch = new THREE.Group();
  boltCatch.name = 'boltCatch';
  boltCatch.position.set(-0.0118, -0.0165, -0.0965);
  {
    const bc = shape([[-0.0045, 0.002], [0.0045, 0.002], [0.0050, -0.012], [0.0068, -0.0165], [0.0060, -0.0205], [-0.0060, -0.0205], [-0.0065, -0.016], [-0.0040, -0.012]], [0.001, 0.001, 0.002, 0.002, 0.002, 0.002, 0.002, 0.001]);
    const g = extrudeSide(bc, 0.0030, { bevel: 0.0008, bevelSegs: 2 });
    // ribbed paddle texture
    const ribs: THREE.BufferGeometry[] = [g];
    for (let i = 0; i < 3; i++) ribs.push(box(0.001, 0.0008, 0.010, -0.0017, -0.0165 - i * 0.0014, 0));
    boltCatch.add(new THREE.Mesh(finish(merge(ribs), 45), mats.steelDark));
  }
  root.add(boltCatch);

  // ---------------------------------------------------------------- Buffer tube, castle nut, end plate (anodized)
  {
    pb.add('anodized', latheZ([[0, 0], [0.0128, 0], [0.0146, 0.002], [0.0146, 0.176], [0, 0.176]], 28, 0.195), 35);
    // castle nut with notches
    let nut = latheZ([[0, 0], [0.0178, 0], [0.0180, 0.001], [0.0180, 0.0085], [0.0175, 0.0095], [0, 0.0095]], 28, 0.0225);
    const notches: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI + Math.PI / 6;
      const n = box(0.004, 0.05, 0.0045, 0, 0, 0.0155);
      n.rotateZ(a);
      notches.push(n);
    }
    nut = csgSub(nut, ...notches);
    pb.add('steelDark', nut, 35);
    // end plate with QD sling loop (left)
    pb.add('steelDark', extrudeFront(shape([[-0.019, -0.022], [0.016, -0.022], [0.016, 0.009], [-0.019, 0.009]], 0.004), 0.0022, { bevel: 0.0005, bevelSegs: 1 }, 0.0245), 40);
    const qd = latheAxis([[0, 0], [0.0068, 0], [0.0068, 0.009], [0.0055, 0.0095], [0, 0.0095]], new THREE.Vector3(-0.0135, -0.010, 0.0175), new THREE.Vector3(-1, 0, 0), 20);
    pb.add('steelDark', csgSub(qd, cylinderBetween(new THREE.Vector3(-0.012, -0.010, 0.0175), new THREE.Vector3(-0.030, -0.010, 0.0175), 0.0036, 0.0036, 16)), 40);
  }

  // ---------------------------------------------------------------- Stock (FDE polymer), CTR-style
  {
    const S = 0.080; // stock front z
    const P = (pts: P2[]) => pts.map(([u, v]) => [-(u + S), v] as P2); // u = distance behind the stock front
    const W = 0.0355;
    // main body: tube housing + triangular butt section
    const body = shape(P([
      [0, 0.0165], [0.006, 0.0205], [0.080, 0.0215], [0.150, 0.0265], [0.172, 0.0335], [0.181, 0.0345],
      [0.184, -0.093], [0.180, -0.1035], [0.170, -0.1035], [0.098, -0.047], [0.064, -0.0245], [0.006, -0.0235], [0, -0.019],
    ]), [0.004, 0.006, 0.04, 0.03, 0.01, 0.003, 0.004, 0.004, 0.006, 0.02, 0.01, 0.004, 0.003]);
    // sling slot through the rear toe
    body.holes.push(path(P([[0.150, -0.0835], [0.1665, -0.0835], [0.1665, -0.0725], [0.150, -0.0725]]), 0.003));
    let stock = extrudeSide(body, W, { bevel: 0.0055, bevelSegs: 4, curveSegs: 6 });
    // shallow recessed side panels (both sides)
    const pocket = shape(P([[0.088, 0.0085], [0.162, 0.0155], [0.166, 0.009], [0.166, -0.058], [0.160, -0.063], [0.104, -0.030], [0.090, -0.004]]), [0.004, 0.006, 0.004, 0.006, 0.004, 0.006, 0.006]);
    const cutL = extrudeSide(pocket, 0.006, {}, -W / 2 - 0.0015);
    const cutR = extrudeSide(pocket, 0.006, {}, W / 2 + 0.0015);
    stock = csgSub(stock, cutL, cutR);
    pb.add('polymerFde', stock, 55);
    // cheek riser strip on top (slightly raised), follows the comb line
    pb.add('polymerFde', extrudeSide(shape(P([[0.060, 0.0195], [0.150, 0.0245], [0.166, 0.0305], [0.155, 0.0335], [0.060, 0.0245]]), [0.002, 0.01, 0.003, 0.006, 0.003]), 0.020, { bevel: 0.004, bevelSegs: 3 }), 55);
    // Butt pad (rubber) with grooves
    const bp = shape(P([[0.180, 0.0355], [0.192, 0.0355], [0.196, -0.098], [0.186, -0.1075]]), [0.004, 0.006, 0.006, 0.004]);
    let pad = extrudeSide(bp, W + 0.003, { bevel: 0.0048, bevelSegs: 3 });
    const grooves: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 11; i++) { const v = 0.024 - i * 0.0115; const uu = 0.192 + (0.0355 - v) * 0.03; grooves.push(box(0.05, 0.0016, 0.004, 0, v, S + uu + 0.0028)); }
    pad = csgSub(pad, ...grooves);
    pb.add('rubber', pad, 50);
    // Adjustment latch lever under the tube housing + QD socket on the side
    pb.add('polymer', extrudeSide(shape(P([[0.012, -0.0225], [0.058, -0.0235], [0.061, -0.0305], [0.054, -0.0325], [0.018, -0.0295]]), [0.001, 0.002, 0.003, 0.003, 0.002]), 0.0125, { bevel: 0.0016, bevelSegs: 2 }), 50);
    for (const side of [-1, 1]) {
      const qd = latheAxis([[0, 0], [0.0068, 0], [0.0068, 0.0025], [0.0058, 0.0032], [0, 0.0032]], new THREE.Vector3(side * (W / 2 - 0.0012), -0.004, S + 0.030), new THREE.Vector3(side, 0, 0), 20);
      pb.add('steelDark', csgSub(qd, cylinderBetween(new THREE.Vector3(side * (W / 2 - 0.001), -0.004, S + 0.030), new THREE.Vector3(side * (W / 2 + 0.01), -0.004, S + 0.030), 0.0036, 0.0036, 16)), 40);
    }
  }

  // ---------------------------------------------------------------- Handguard (M-LOK, anodized)
  {
    const hgY0 = -0.0305, hgX = 0.0212;
    const xs: P2[] = [[-0.0125, hgY0], [0.0125, hgY0], [hgX, hgY0 + 0.0095], [hgX, 0.0105], [0.0118, UPPER_TOP], [-0.0118, UPPER_TOP], [-hgX, 0.0105], [-hgX, hgY0 + 0.0095]];
    const sh = shape(xs, [0.003, 0.003, 0.003, 0.003, 0.002, 0.002, 0.003, 0.003]);
    sh.holes.push(path([[-0.0102, hgY0 + 0.0028], [0.0102, hgY0 + 0.0028], [hgX - 0.0028, hgY0 + 0.012], [hgX - 0.0028, 0.0092], [0.0098, UPPER_TOP - 0.0028], [-0.0098, UPPER_TOP - 0.0028], [-hgX + 0.0028, 0.0092], [-hgX + 0.0028, hgY0 + 0.012]], 0.002));
    let hg = extrudeFront(sh, HG_REAR - HG_FRONT, { bevel: 0.0012, bevelSegs: 2 }, HG_REAR);
    const cut: THREE.BufferGeometry[] = [];
    const slot = (L: number, W: number) => rrectShape(0, 0, L, W, W / 2 - 0.0002);
    for (let i = 0; i < 6; i++) {
      const zc = -0.212 - i * 0.042;
      // side slots (3 & 9 o'clock)
      for (const s of [-1, 1]) {
        const g = extrudeSide(slot(0.030, 0.0072), 0.012, {}, s * hgX);
        g.translate(0, -0.004, zc);
        cut.push(g);
      }
      // bottom slots
      if (i < 6) {
        const g = extrudeTop(rrectShape(0, 0, 0.0072, 0.030, 0.0034), 0.012, {}, hgY0 - 0.006);
        g.translate(0, 0, zc);
        cut.push(g);
      }
      // lower 45-degree facets: small lightening slots
      for (const s of [-1, 1]) {
        const g = extrudeSide(slot(0.020, 0.0048), 0.012, {});
        g.rotateZ(-s * 0.845);
        g.translate(s * 0.0185, hgY0 + 0.0048, zc - 0.021);
        cut.push(g);
      }
    }
    // Upper diagonal lightening windows
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 1]) {
        const g = extrudeSide(slot(0.016, 0.0042), 0.01, {});
        g.rotateZ(s * 1.02);
        g.translate(s * 0.0185, 0.0142, -0.233 - i * 0.042);
        cut.push(g);
      }
    }
    hg = csgSub(hg, ...cut);
    pb.add('anodized', hg, 35);
    // Barrel-nut ring between upper and handguard
    pb.add('anodized', latheZ([[0, 0], [0.0170, 0], [0.0170, 0.004], [0, 0.004]], 28, -UPPER_LEN + 0.0005), 35);
    // Front QD socket (left)
    const qd = latheAxis([[0, 0], [0.0062, 0], [0.0062, 0.0035], [0.0052, 0.0042], [0, 0.0042]], new THREE.Vector3(-hgX + 0.0005, -0.004, -0.448), new THREE.Vector3(-1, 0, 0), 20);
    pb.add('steelDark', csgSub(qd, cylinderBetween(new THREE.Vector3(-hgX, -0.004, -0.448), new THREE.Vector3(-hgX - 0.01, -0.004, -0.448), 0.0035, 0.0035, 16)), 40);
    // Handstop at the front bottom
    const hs = extrudeSide(shape([[0.395, hgY0 + 0.001], [0.430, hgY0 + 0.001], [0.426, hgY0 - 0.0095], [0.418, hgY0 - 0.0115]], [0.001, 0.001, 0.003, 0.004]), 0.0145, { bevel: 0.0025, bevelSegs: 3 });
    pb.add('polymer', hs, 55);
  }
  for (const g of picatinny(HG_REAR - 0.001, HG_FRONT + 0.001)) pb.add('anodized', g, 35);

  // ---------------------------------------------------------------- Barrel + gas block + muzzle brake (parkerized)
  {
    pb.add('parkerized', latheZ([[0, 0], [0.0098, 0], [0.0098, 0.180], [0.0093, 0.185], [0.0093, 0.322], [0.0078, 0.3235], [0.0078, 0.332], [0, 0.332]], 24, -0.172), 40);
    // gas block (hidden mostly, visible through slots)
    pb.add('parkerized', xform(roundBox(0.021, 0.024, 0.022, 0.003), 0, 0.002, -0.385), 40);
    // gas tube
    pb.add('steelDark', cylinderBetween(new THREE.Vector3(0, 0.0122, -0.175), new THREE.Vector3(0, 0.0122, -0.380), 0.0024, 0.0024, 10), 40);
    // Muzzle brake with side ports
    const mz0 = -0.4985;
    let brake = latheZ([[0.0034, 0], [0.0098, 0], [0.0116, 0.0025], [0.0116, 0.0525], [0.0108, 0.0575], [0.0064, 0.0585], [0.0034, 0.0585], [0.0034, 0]], 32, mz0);
    const ports: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) ports.push(box(0.03, 0.0115 - i * 0.0012, 0.0052, 0, 0, mz0 - 0.0165 - i * 0.0115));
    ports.push(box(0.0045, 0.02, 0.0045, 0, 0.012, mz0 - 0.050));
    for (let i = 0; i < 2; i++) ports.push(box(0.0032, 0.02, 0.0032, i ? 0.0045 : -0.0045, 0.012, mz0 - 0.043));
    brake = csgSub(brake, ...ports);
    pb.add('parkerized', brake, 35);
    // wrench flats / crush washer
    pb.add('steelDark', latheZ([[0, 0], [0.0103, 0], [0.0103, 0.0025], [0, 0.0025]], 6, mz0 + 0.0025), 40);
  }

  // ---------------------------------------------------------------- Iron sights (folded) - rear on upper, front on handguard
  {
    const rear = (z: number) => {
      const base = extrudeFront(shape([[-0.0128, 0.0208], [0.0128, 0.0208], [0.0128, RAIL_TOP + 0.0055], [-0.0128, RAIL_TOP + 0.0055]], [0.001, 0.001, 0.0025, 0.0025]), 0.030, { bevel: 0.0009, bevelSegs: 2 }, z);
      const leaf = extrudeSide(shape([[0.002, RAIL_TOP + 0.0055], [0.028, RAIL_TOP + 0.0055], [0.026, RAIL_TOP + 0.0102], [0.010, RAIL_TOP + 0.0108], [0.004, RAIL_TOP + 0.009]], [0.001, 0.001, 0.002, 0.002, 0.002]), 0.019, { bevel: 0.0012, bevelSegs: 2 });
      leaf.translate(0, 0, z);
      return [base, leaf];
    };
    for (const g of rear(-0.004)) pb.add('polymer', g, 45);
    const front = (z: number) => {
      const base = extrudeFront(shape([[-0.0128, 0.0208], [0.0128, 0.0208], [0.0128, RAIL_TOP + 0.0055], [-0.0128, RAIL_TOP + 0.0055]], [0.001, 0.001, 0.0025, 0.0025]), 0.026, { bevel: 0.0009, bevelSegs: 2 }, z);
      const leaf = extrudeSide(shape([[0.0, RAIL_TOP + 0.0055], [0.024, RAIL_TOP + 0.0055], [0.022, RAIL_TOP + 0.0115], [0.004, RAIL_TOP + 0.0095]], [0.001, 0.001, 0.002, 0.002]), 0.016, { bevel: 0.0012, bevelSegs: 2 });
      leaf.translate(0, 0, z);
      return [base, leaf];
    };
    for (const g of front(-0.437)) pb.add('polymer', g, 45);
  }

  // ---------------------------------------------------------------- Charging handle (ambi, rear top)
  {
    const ch = shape([[-0.0048, 0.012], [-0.0048, -0.001], [-0.0180, -0.0030], [-0.0215, -0.0065], [-0.0205, -0.0105], [0.0205, -0.0105], [0.0215, -0.0065], [0.0180, -0.0030], [0.0048, -0.001], [0.0048, 0.012]],
      [0, 0.002, 0.003, 0.003, 0.002, 0.002, 0.003, 0.003, 0.002, 0]);
    // top profile (x right, forward) -> extrude upward; wings sit just behind the upper's rear face
    const g = extrudeTop(ch, 0.0060, { bevel: 0.0012, bevelSegs: 2 }, 0.0168);
    pb.add('anodized', g, 40);
  }

  // ---------------------------------------------------------------- Holographic sight (EXPS-style)
  const optic = new THREE.Group();
  optic.name = 'optic';
  optic.position.set(0, RAIL_TOP, -0.036);
  const ob = new PartBuilder(mats);
  let lensFrame: THREE.Object3D;
  let reticle: THREE.ShaderMaterial;
  {
    const HW = 0.0212, HB = 0.0115, HT = 0.0515;
    const WW = 0.0316, WH = 0.0250;
    // mount: clamp block around the rail
    const mount = shape([[-0.0152, -0.0062], [-0.0112, -0.0062], [-0.0112, -0.0035], [-0.0085, 0.0003], [0.0085, 0.0003], [0.0112, -0.0035], [0.0112, -0.0062], [0.0152, -0.0062], [0.0162, 0.0082], [-0.0162, 0.0082]],
      [0.001, 0.0005, 0.0005, 0.0005, 0.0005, 0.0005, 0.0005, 0.001, 0.002, 0.002]);
    ob.add('anodized', extrudeFront(mount, 0.078, { bevel: 0.0012, bevelSegs: 2 }, -0.010), 35);
    // cross bolt / QD lever on the left
    ob.add('steelDark', cylinderBetween(new THREE.Vector3(-0.0162, -0.0005, -0.060), new THREE.Vector3(-0.0184, -0.0005, -0.060), 0.0040, 0.0038, 18), 40);
    const lever = extrudeSide(shape([[0.020, -0.0038], [0.062, -0.0030], [0.064, 0.0014], [0.020, 0.0038]], [0.002, 0.002, 0.002, 0.002]), 0.0030, { bevel: 0.0009, bevelSegs: 2 }, -0.0192);
    ob.add('steelDark', lever, 40);
    ob.add('steelDark', cylinderBetween(new THREE.Vector3(0.0162, -0.0005, -0.060), new THREE.Vector3(0.0178, -0.0005, -0.060), 0.0045, 0.0045, 6), 40);
    // lower body (electronics / battery)
    ob.add('anodized', extrudeFront(shape([[-0.0188, 0.0075], [0.0188, 0.0075], [0.0188, 0.0172], [-0.0188, 0.0172]], [0.0025, 0.0025, 0.001, 0.001]), 0.102, { bevel: 0.0016, bevelSegs: 3 }, -0.001), 35);
    // rear deck: sloped cover with two buttons on top, two on the left side
    const deck = shape([[-0.0180, 0.0165], [0.0180, 0.0165], [0.0175, 0.0200], [-0.0175, 0.0200]], 0.001);
    ob.add('anodized', extrudeFront(deck, 0.020, { bevel: 0.0012, bevelSegs: 2 }, -0.003), 35);
    for (const x of [-0.0074, 0.0074]) ob.add('rubber', xform(roundBox(0.0092, 0.0036, 0.0092, 0.0016), x, 0.0212, -0.012), 50);
    for (const z of [-0.009, -0.020]) ob.add('rubber', xform(roundBox(0.0032, 0.0060, 0.0075, 0.0013), -0.0192, 0.0122, z), 50);
    // hood with window
    const hood = shape([[-HW, HB], [HW, HB], [HW, HT - 0.010], [HW - 0.0075, HT], [-HW + 0.0075, HT], [-HW, HT - 0.010]], [0.001, 0.001, 0.007, 0.007, 0.007, 0.007]);
    hood.holes.push(rrectPath(0, WIN_CY, WW, WH, 0.004));
    ob.add('anodized', extrudeFront(hood, 0.074, { bevel: 0.0018, bevelSegs: 3 }, -0.024), 35);
    // hood side screws
    for (const side of [-1, 1]) for (const z of [-0.036, -0.086]) ob.add('steelDark', cylinderBetween(new THREE.Vector3(side * HW, 0.040, z), new THREE.Vector3(side * (HW + 0.0009), 0.040, z), 0.0017, 0.0016, 10), 40);
    // windage/elevation turrets (right side)
    ob.add('anodized', cylinderBetween(new THREE.Vector3(HW, 0.030, -0.074), new THREE.Vector3(HW + 0.0032, 0.030, -0.074), 0.0050, 0.0046, 18), 40);
    ob.add('anodized', cylinderBetween(new THREE.Vector3(0.0188, 0.0125, -0.050), new THREE.Vector3(0.0215, 0.0125, -0.050), 0.0040, 0.0038, 16), 40);
    // battery cap (transverse, front-bottom), knurled cap on the right
    ob.add('anodized', cylinderBetween(new THREE.Vector3(-0.0192, 0.0102, -0.090), new THREE.Vector3(0.0192, 0.0102, -0.090), 0.0080, 0.0080, 24), 40);
    const knurl: P2[] = [[0, 0], [0.0090, 0]];
    for (let i = 0; i < 4; i++) knurl.push([0.0090, 0.0012 + i * 0.0014], [0.0084, 0.0018 + i * 0.0014]);
    knurl.push([0.0088, 0.0066], [0.0080, 0.0074], [0, 0.0074]);
    ob.add('steelDark', latheAxis(knurl, new THREE.Vector3(0.0189, 0.0102, -0.090), new THREE.Vector3(1, 0, 0), 24), 40);
    optic.add(ob.build('optic'));
    // Lenses
    lensFrame = new THREE.Object3D();
    lensFrame.name = 'lens';
    lensFrame.position.set(0, WIN_CY, -0.032);
    reticle = createReticleMaterial();
    reticle.uniforms.uWindow.value.set(WW / 2, WH / 2, 0.004, 0);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(WW, WH), reticle);
    lens.renderOrder = 10;
    lensFrame.add(lens);
    optic.add(lensFrame);
    const fg = new THREE.MeshStandardMaterial({ color: 0x6fa8d8, metalness: 1, roughness: 0.04, transparent: true, opacity: 0.16, depthWrite: false });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(WW, WH), fg);
    front.position.set(0, WIN_CY, -0.094);
    front.renderOrder = 9;
    optic.add(front);
  }
  root.add(optic);

  // ---------------------------------------------------------------- Bolt carrier (visible in the ejection port)
  const bolt = new THREE.Group();
  bolt.name = 'bolt';
  {
    const bcg = latheZ([[0, 0], [0.0082, 0], [0.0082, 0.085], [0, 0.085]], 20, -0.035);
    const cut = box(0.01, 0.006, 0.030, 0.0082, 0.004, -0.085);
    const g = csgSub(bcg, cut);
    g.translate(0, 0.0028, 0);
    bolt.add(new THREE.Mesh(finish(g, 40), mats.parkerized));
    // bolt head lugs visible at the front of the port
    const head = latheZ([[0, 0], [0.0062, 0], [0.0062, 0.012], [0, 0.012]], 12, -0.118);
    head.translate(0, 0.0028, 0);
    bolt.add(new THREE.Mesh(finish(head, 40), mats.steelDark));
  }
  root.add(bolt);

  // ---------------------------------------------------------------- Dust cover (animated)
  const dustCover = new THREE.Group();
  dustCover.name = 'dustCover';
  dustCover.position.set(0.0122, -0.0058, -0.081);
  {
    const dc = extrudeSide(shape([[-0.029, 0], [0.029, 0], [0.029, 0.0172], [-0.029, 0.0172]], 0.0015), 0.0012, { bevel: 0.0003, bevelSegs: 1 });
    const ridge = box(0.0012, 0.0022, 0.050, 0.0008, 0.012, 0);
    const pin = cylinderBetween(new THREE.Vector3(0, 0, 0.030), new THREE.Vector3(0, 0, -0.030), 0.0013, 0.0013, 8);
    dustCover.add(new THREE.Mesh(finish(merge([dc, ridge, pin]), 45), mats.steelDark));
  }
  root.add(dustCover);

  // ---------------------------------------------------------------- Magazines
  const magSeat = new THREE.Matrix4().makeTranslation(0, -0.0035, -0.1125);
  const mag = buildMagazine(mats, false);
  mag.matrixAutoUpdate = true;
  mag.position.setFromMatrixPosition(magSeat);
  root.add(mag);
  const magNew = buildMagazine(mats, true);
  magNew.visible = false;
  root.add(magNew);
  // grip point on the mag for the off hand: middle of the body, slightly below the magwell
  const magHandle = new THREE.Matrix4().makeTranslation(0, -0.095, -0.036);

  // ---------------------------------------------------------------- Static parts mesh
  const statics = pb.build('m4-static');
  root.add(statics);

  // ---------------------------------------------------------------- Sockets
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, MUZZLE_Z - 0.001);
  root.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.013, 0.004, -0.075);
  root.add(eject);

  // ---------------------------------------------------------------- Hand grips
  // Pistol grip SDF (elliptic capsule along the grip axis)
  const gripSdf: SDF = sdUnion(
    sdEllipticCapsule(new THREE.Vector3(0, -0.050, -0.0146), new THREE.Vector3(0, -0.130, 0.0146), new THREE.Vector3(1, 0, 0), 0.0152, 0.0235),
    sdRoundBox(new THREE.Vector3(0, -0.056, -0.071), new THREE.Vector3(0.006, 0.011, 0.034), 0.004), // trigger guard (index/middle rest)
  );
  const hgSdf: SDF = sdUnion(
    sdRoundBox(new THREE.Vector3(0, -0.0065, -0.325), new THREE.Vector3(0.0212, 0.024, 0.145), 0.007),
    sdRoundBox(new THREE.Vector3(0, 0.022, -0.325), new THREE.Vector3(0.0106, 0.005, 0.145), 0.001),
  );
  const magSdf: SDF = (p) => 0; void magSdf;

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const rightGrip = {
    wrist: gripWrist(V(0.015, -0.077, 0.026), V(0.1, -0.33, -0.94), V(0.996, 0.034, 0.094)),
    sdf: gripSdf,
    index: null,
    thumb: null,
    indexTarget: V(0.0, -0.051, -0.075),
    thumbTarget: V(-0.022, -0.036, -0.030),
    squeeze: 0.25,
  };
  const leftGrip = {
    wrist: gripWrist(V(-0.045, -0.042, -0.315), V(0.9, -0.2, -0.35), V(-0.42, -0.9, 0.0)),
    sdf: hgSdf,
    index: null,
    thumb: null,
    thumbTarget: V(-0.026, 0.003, -0.395),
    squeeze: 0.25,
  };
  // Off hand gripping the magazine body (reload) - pose authored in mag space, converted at runtime
  const magBody = sdOrientedBox(new THREE.Matrix4().makeTranslation(0, -0.090, -0.040), new THREE.Vector3(0.0114, 0.085, 0.032), 0.004);

  const model: WeaponModel = {
    id: 'm4', kind: 'rifle', root, muzzle, eject,
    sightPoint: new THREE.Vector3(0, RAIL_TOP + WIN_CY, -0.068),
    eyeRelief: 0.088,
    lens: lensFrame, reticle,
    bolt, boltTravel: 0.058,
    mag, magSeat, magNew, magHandle,
    trigger, dustCover, boltCatch, selector,
    pivot: new THREE.Vector3(0, -0.06, -0.02),
    rightGrip, leftGrip,
    leftPoses: {
      // off hand on the magazine, in magazine space (mag front toward -Z, body down -Y)
      mag: { wrist: gripWrist(V(-0.0255, -0.075, -0.030), V(0.12, 0.25, -1), V(-1, 0.05, 0.1)), sdf: magBody, index: null, thumb: null, squeeze: 0.2, thumbTarget: V(-0.0135, -0.035, -0.004) },
    },
    dispose() {
      root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    },
  };
  return model;
}

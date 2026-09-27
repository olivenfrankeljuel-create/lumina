import * as THREE from 'three';
import type { GunMaterials } from './materials';
import { P2, shape, path, extrudeSide, extrudeFront, latheZ, csgSub, box, roundBox, xform, cylinderBetween, finish, merge } from './geom';
import { PartBuilder, WeaponModel, sdEllipticCapsule, sdUnion, SDF, sdOrientedBox } from './model';

/**
 * M17-style striker-fired pistol. Weapon space: bore along Z at y = 0, z = 0 at the slide's rear face.
 */
const SLIDE_LEN = 0.184;
const SLIDE_TOP = 0.0225;
const SLIDE_BOT = -0.0065;
const GRIP_ANGLE = 0.32; // radians from vertical (rakes back)

function pistolMag(mats: GunMaterials, loaded: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = loaded ? 'magNew' : 'mag';
  // mag-local: origin = top rear of mag body, body extends down along -Y (in the grip-aligned frame), front toward -Z
  const body = extrudeSide(shape([[0, 0], [0.031, 0], [0.033, -0.004], [0.033, -0.112], [-0.001, -0.112], [-0.001, -0.004]], [0.001, 0.003, 0.002, 0.002, 0.002, 0.002]), 0.0205, { bevel: 0.0012, bevelSegs: 2 });
  g.add(new THREE.Mesh(finish(body, 45), mats.steelDark));
  const base = extrudeSide(shape([[-0.004, -0.110], [0.036, -0.110], [0.037, -0.117], [0.030, -0.1215], [-0.003, -0.1215], [-0.006, -0.116]], [0.001, 0.001, 0.003, 0.003, 0.003, 0.002]), 0.0262, { bevel: 0.0022, bevelSegs: 3 });
  g.add(new THREE.Mesh(finish(base, 50), mats.polymer));
  const fol = new THREE.Mesh(finish(xform(roundBox(0.016, 0.004, 0.026, 0.001), 0, 0.001, -0.016)), mats.follower);
  g.add(fol);
  if (loaded) {
    const c = latheZ([[0, 0], [0.0049, 0], [0.0049, 0.0010], [0.0045, 0.0013], [0.0048, 0.0018], [0.0048, 0.0190], [0, 0.0190]], 14);
    const b = latheZ([[0, 0.0185], [0.0045, 0.0185], [0.0044, 0.022], [0.0032, 0.0268], [0.0, 0.0285]], 14);
    const brass = new THREE.Mesh(finish(xform(c, 0.002, 0.0055, -0.002)), mats.brass);
    const tip = new THREE.Mesh(finish(xform(b, 0.002, 0.0055, -0.002)), mats.copper);
    g.add(brass, tip);
    fol.visible = false;
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function buildPistol(mats: GunMaterials): WeaponModel {
  const root = new THREE.Group();
  root.name = 'm17';
  const pb = new PartBuilder(mats);

  // ---------------------------------------------------------------- Slide (moving)
  const slide = new THREE.Group();
  slide.name = 'slide';
  {
    const xs: P2[] = [[-0.01275, SLIDE_BOT], [0.01275, SLIDE_BOT], [0.01275, 0.0148], [0.0086, SLIDE_TOP], [-0.0086, SLIDE_TOP], [-0.01275, 0.0148]];
    let s = extrudeFront(shape(xs, [0.0008, 0.0008, 0.0025, 0.0012, 0.0012, 0.0025]), SLIDE_LEN, { bevel: 0.0011, bevelSegs: 2 }, 0);
    const cut: THREE.BufferGeometry[] = [];
    // rear serrations (both sides), slanted
    for (let i = 0; i < 8; i++) {
      for (const side of [-1, 1]) {
        const g = box(0.004, 0.019, 0.0013, side * 0.0137, 0.004, 0);
        g.rotateX(0.14);
        g.translate(0, 0, -0.012 - i * 0.0036);
        cut.push(g);
      }
    }
    // front serrations
    for (let i = 0; i < 6; i++) {
      for (const side of [-1, 1]) {
        const g = box(0.004, 0.017, 0.0013, side * 0.0137, 0.0035, 0);
        g.rotateX(-0.14);
        g.translate(0, 0, -0.132 - i * 0.0036);
        cut.push(g);
      }
    }
    // ejection port (top right)
    cut.push(box(0.022, 0.02, 0.040, 0.0085, 0.0185, -0.070));
    // lightening cut on top front (M17 style window)
    cut.push(box(0.009, 0.006, 0.050, 0, SLIDE_TOP + 0.0012, -0.130));
    // front nose chamfer at the bottom
    const nose = box(0.04, 0.02, 0.03, 0, SLIDE_BOT - 0.0085, -SLIDE_LEN + 0.004);
    nose.rotateX(0.0);
    cut.push(xform(box(0.04, 0.012, 0.03), 0, SLIDE_BOT - 0.0045, -SLIDE_LEN - 0.012, 0.5, 0, 0));
    // muzzle bore opening + guide rod hole
    cut.push(cylinderBetween(new THREE.Vector3(0, 0, -SLIDE_LEN + 0.03), new THREE.Vector3(0, 0, -SLIDE_LEN - 0.01), 0.0072, 0.0072, 20));
    cut.push(cylinderBetween(new THREE.Vector3(0, -0.0045, -SLIDE_LEN + 0.02), new THREE.Vector3(0, -0.0045, -SLIDE_LEN - 0.01), 0.0035, 0.0035, 14));
    s = csgSub(s, ...cut);
    const sb = new PartBuilder(mats);
    sb.add('parkerized', s, 35);
    // rear sight (notch) and front sight
    let rs = extrudeFront(shape([[-0.0105, SLIDE_TOP - 0.001], [0.0105, SLIDE_TOP - 0.001], [0.0095, SLIDE_TOP + 0.0068], [-0.0095, SLIDE_TOP + 0.0068]], [0.0005, 0.0005, 0.0012, 0.0012]), 0.011, { bevel: 0.0008, bevelSegs: 2 }, -0.004);
    rs = csgSub(rs, box(0.0034, 0.01, 0.03, 0, SLIDE_TOP + 0.0068, -0.009));
    sb.add('steelDark', rs, 40);
    sb.add('steelDark', extrudeFront(shape([[-0.0018, SLIDE_TOP - 0.001], [0.0018, SLIDE_TOP - 0.001], [0.0016, SLIDE_TOP + 0.0068], [-0.0016, SLIDE_TOP + 0.0068]], 0.0004), 0.006, { bevel: 0.0005, bevelSegs: 1 }, -SLIDE_LEN + 0.013), 40);
    // striker cover plate at the rear
    sb.add('polymer', xform(roundBox(0.012, 0.012, 0.0016, 0.0015), 0, 0.006, 0.0002), 50);
    // extractor (right side)
    sb.add('steelDark', xform(roundBox(0.0016, 0.0036, 0.024, 0.0006), 0.0128, 0.0105, -0.046), 50);
    const slideMesh = sb.build('slide');
    slide.add(slideMesh);
    // sight dots (tritium): rear two, front one
    for (const x of [-0.0062, 0.0062]) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.00125, 14), mats.sightDot);
      d.position.set(x, SLIDE_TOP + 0.0035, 0.0012);
      slide.add(d);
    }
    const fd = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 14), mats.sightDot);
    fd.position.set(0, SLIDE_TOP + 0.0045, -SLIDE_LEN + 0.0132);
    slide.add(fd);
  }
  root.add(slide);

  // ---------------------------------------------------------------- Barrel (static; hood visible in port)
  {
    const bar = latheZ([[0.0038, 0], [0.0068, 0], [0.0068, 0.132], [0.0060, 0.1325], [0.0038, 0.1325], [0.0038, 0]], 20, -0.052);
    pb.add('steelDark', bar, 40);
    pb.add('parkerized', xform(roundBox(0.0165, 0.0130, 0.040, 0.0012), 0, 0.0082, -0.070), 40);
  }

  // ---------------------------------------------------------------- Frame (polymer)
  {
    const fr: P2[] = [
      [-0.004, SLIDE_BOT + 0.0005], [0.178, SLIDE_BOT + 0.0005], [0.178, -0.0195], [0.096, -0.0215], [0.093, -0.0405], [0.086, -0.0472], [0.052, -0.0472], [0.044, -0.041],
      [0.040, -0.030], [0.004, -0.030], [-0.012, -0.022], [-0.019, -0.0165], [-0.010, -0.0115],
    ];
    const s = shape(fr, [0.001, 0.001, 0.003, 0.002, 0.004, 0.006, 0.006, 0.004, 0.003, 0.003, 0.004, 0.004, 0.002]);
    s.holes.push(path([[0.0875, -0.0225], [0.0870, -0.0395], [0.0815, -0.0428], [0.0545, -0.0428], [0.0495, -0.0395], [0.0490, -0.0225]], [0.002, 0.003, 0.004, 0.004, 0.003, 0.002]));
    pb.add('polymer', extrudeSide(s, 0.0232, { bevel: 0.0022, bevelSegs: 3 }), 50);
    // accessory rail cross-slots on the dust cover
    for (let i = 0; i < 3; i++) pb.add('polymer', xform(roundBox(0.021, 0.0028, 0.0055, 0.0008), 0, -0.0215, -0.118 - i * 0.017), 45);
    // Grip (thicker), raked back
    const gp: P2[] = [
      [0.043, -0.024], [0.040, -0.046], [0.034, -0.068], [0.027, -0.092], [0.019, -0.118], [0.017, -0.124],
      [-0.023, -0.113], [-0.020, -0.090], [-0.012, -0.062], [-0.008, -0.040], [-0.010, -0.022], [0.010, -0.018],
    ];
    const gs = shape(gp, [0.002, 0.008, 0.01, 0.01, 0.006, 0.003, 0.004, 0.01, 0.01, 0.006, 0.004, 0.002]);
    pb.add('polymer', extrudeSide(gs, 0.0305, { bevel: 0.0055, bevelSegs: 4, curveSegs: 6 }), 55);
    // grip texture panels
    const panel = shape([[0.030, -0.052], [0.022, -0.080], [0.014, -0.108], [-0.014, -0.100], [-0.008, -0.072], [-0.003, -0.050]], [0.004, 0.006, 0.004, 0.004, 0.006, 0.004]);
    for (const side of [-1, 1]) pb.add('rubber', extrudeSide(panel, 0.0016, { bevel: 0.0005, bevelSegs: 2 }, side * 0.0138), 50);
    // slide stop lever (left) + takedown lever + manual safety
    pb.add('steelDark', extrudeSide(shape([[0.036, -0.0085], [0.074, -0.0085], [0.076, -0.0125], [0.050, -0.0130], [0.044, -0.0175], [0.036, -0.0165]], [0.001, 0.001, 0.001, 0.002, 0.002, 0.002]), 0.0022, { bevel: 0.0006, bevelSegs: 2 }, -0.0126), 45);
    pb.add('steelDark', extrudeSide(shape([[0.080, -0.0090], [0.092, -0.0090], [0.092, -0.0150], [0.080, -0.0150]], 0.002), 0.0020, { bevel: 0.0005, bevelSegs: 1 }, -0.0125), 45);
    pb.add('steelDark', extrudeSide(shape([[0.004, -0.0130], [0.018, -0.0130], [0.020, -0.0170], [0.004, -0.0185]], 0.0015), 0.0024, { bevel: 0.0006, bevelSegs: 2 }, -0.0127), 45);
    // mag release (left, behind trigger guard)
    pb.add('polymer', xform(roundBox(0.004, 0.008, 0.009, 0.0015), -0.0125, -0.036, -0.041), 45);
  }
  // Trigger
  const trigger = new THREE.Group();
  trigger.position.set(0, -0.022, -0.074);
  {
    const tp: P2[] = [[0.0775, -0.022], [0.0770, -0.030], [0.0730, -0.037], [0.0670, -0.0410], [0.0650, -0.0395], [0.0695, -0.035], [0.0718, -0.029], [0.0720, -0.022]];
    const g = extrudeSide(shape(tp, [0, 0.003, 0.003, 0.001, 0.001, 0.003, 0.003, 0]), 0.0062, { bevel: 0.0009, bevelSegs: 2 });
    g.translate(0, 0.022, 0.074);
    trigger.add(new THREE.Mesh(finish(g, 45), mats.polymer));
  }
  root.add(trigger);

  // Magazines (grip-aligned)
  const magRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -GRIP_ANGLE * 0.62);
  const magSeat = new THREE.Matrix4().compose(new THREE.Vector3(0, -0.004, -0.0065 - 0.0), magRot, new THREE.Vector3(1, 1, 1));
  // position the mag so it sits inside the grip: rear-top at (z = -0.004)
  magSeat.setPosition(0, -0.013, -0.0035);
  const mag = pistolMag(mats, false);
  mag.position.setFromMatrixPosition(magSeat);
  mag.quaternion.copy(magRot);
  root.add(mag);
  const magNew = pistolMag(mats, true);
  magNew.visible = false;
  root.add(magNew);
  const magHandle = new THREE.Matrix4().makeTranslation(0, -0.10, -0.016);

  root.add(pb.build('m17-static'));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -SLIDE_LEN - 0.002);
  root.add(muzzle);
  const eject = new THREE.Object3D();
  eject.position.set(0.010, 0.016, -0.068);
  root.add(eject);

  const gripSdf: SDF = sdUnion(
    sdEllipticCapsule(new THREE.Vector3(0, -0.028, -0.015), new THREE.Vector3(0, -0.112, 0.012), new THREE.Vector3(1, 0, 0), 0.0152, 0.0205),
  );
  // support hand wraps the grip + the shooting hand's fingers (approximated as a fatter capsule in front)
  const supportSdf: SDF = sdUnion(
    sdEllipticCapsule(new THREE.Vector3(0.0, -0.036, -0.032), new THREE.Vector3(0.0, -0.112, -0.012), new THREE.Vector3(1, 0, 0), 0.030, 0.024),
  );
  const model: WeaponModel = {
    id: 'm17', kind: 'pistol', root, muzzle, eject,
    sightPoint: new THREE.Vector3(0, SLIDE_TOP + 0.0055, -0.009),
    eyeRelief: 0.26,
    bolt: slide, boltTravel: 0.034,
    mag, magSeat, magNew, magHandle,
    trigger,
    pivot: new THREE.Vector3(0, -0.04, 0.0),
    rightGrip: { wrist: [0.012, -0.066, 0.040, 0, 0, 0], sdf: gripSdf, index: [0.5, 0.95, 0.4], thumb: null, squeeze: 0.25 },
    leftGrip: { wrist: [-0.030, -0.080, 0.030, 0, 0, 0], sdf: supportSdf, index: null, thumb: null, squeeze: 0.2 },
    leftPoses: { mag: { wrist: [0, 0, 0, 0, 0, 0], sdf: sdOrientedBox(new THREE.Matrix4().makeTranslation(0, -0.08, -0.016), new THREE.Vector3(0.012, 0.06, 0.019), 0.003), squeeze: 0.2 } },
    dispose() { root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); },
  };
  void merge;
  return model;
}

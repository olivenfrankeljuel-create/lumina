// temporary node harness (deleted before hand-off)
import * as THREE from 'three';
import { HandRig, solveGrip, POSE_FLAT, xfToMatrix4 } from './arms';
import { buildRifle } from './rifle';
import { buildPistol } from './pistol';
const M = new THREE.MeshStandardMaterial();
const mats: any = new Proxy({}, { get: () => M });
(globalThis as any).document = { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }), width: 0, height: 0 }) };
const rifle = buildRifle(mats);
const hr = new HandRig(mats, false), hl = new HandRig(mats, true);
const show = (name: string, r: { pose: any; wrist: THREE.Matrix4 }, grip: any, hand: HandRig) => {
  console.log(name, 'fingers', JSON.stringify(r.pose.f.map((a: number[]) => a.map((x) => +x.toFixed(2)))), 'thumb', r.pose.t.map((x: number) => +x.toFixed(2)));
  hand.root.matrix.copy(r.wrist); if (hand.mirrored) hand.root.matrix.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  hand.applyPose(r.pose); hand.root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  hand.fingers.forEach((ch, i) => {
    const ds = ch.map((j) => { j.node.updateWorldMatrix(true, false); p.set(0, 0, -j.len).applyMatrix4(j.node.matrixWorld); return `${grip.sdf(p).toFixed(4)}@(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})`; });
    console.log('  f' + i, ds.join('  '));
  });
  const tt = hand.thumb[2]; tt.node.updateWorldMatrix(true, false); p.set(0, 0, -tt.len).applyMatrix4(tt.node.matrixWorld);
  console.log('  thumb tip', grip.sdf(p).toFixed(4), p.toArray().map((x) => x.toFixed(3)).join(','));
  p.setFromMatrixPosition(r.wrist); console.log('  wrist', p.toArray().map((x) => x.toFixed(3)).join(','));
};
show('R', solveGrip(hr, xfToMatrix4(rifle.rightGrip.wrist), rifle.rightGrip, POSE_FLAT), rifle.rightGrip, hr);
show('L', solveGrip(hl, xfToMatrix4(rifle.leftGrip.wrist), rifle.leftGrip, POSE_FLAT), rifle.leftGrip, hl);

show('Lmag', solveGrip(hl, xfToMatrix4(rifle.leftPoses.mag.wrist), rifle.leftPoses.mag, POSE_FLAT, { maxFlex: [1.5, 1.7, 1.3] }), rifle.leftPoses.mag, hl);
const pistol = buildPistol(mats);
show('PR', solveGrip(hr, xfToMatrix4(pistol.rightGrip.wrist), pistol.rightGrip, POSE_FLAT), pistol.rightGrip, hr);
show('PL', solveGrip(hl, xfToMatrix4(pistol.leftGrip.wrist), pistol.leftGrip, POSE_FLAT), pistol.leftGrip, hl);

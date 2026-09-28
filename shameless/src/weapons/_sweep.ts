import * as THREE from 'three';
import { HandRig, solveGrip, POSE_FLAT, xfToMatrix4, gripWrist } from './arms';
import { buildRifle } from './rifle';
const M = new THREE.MeshStandardMaterial();
const mats: any = new Proxy({}, { get: () => M });
(globalThis as any).document = { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }), width: 0, height: 0 }) };
const rifle = buildRifle(mats);
const hl = new HandRig(mats, true);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const p = new THREE.Vector3();
for (const cx of [-0.030, -0.045]) for (const fd of [[0.93, 0.2, -0.3], [0.9, -0.2, -0.35], [0.8, 0.45, -0.3]]) {
  const grip = { ...rifle.leftGrip, wrist: gripWrist(V(cx, -0.042, -0.315), V(fd[0], fd[1], fd[2]), V(-0.42, -0.9, 0.0)) };
  const r = solveGrip(hl, xfToMatrix4(grip.wrist), grip, POSE_FLAT);
  hl.root.matrix.copy(r.wrist).multiply(new THREE.Matrix4().makeScale(-1, 1, 1)); hl.applyPose(r.pose); hl.root.updateMatrixWorld(true);
  let score = 0; const rows: string[] = [];
  hl.fingers.forEach((ch) => { const ds = ch.map((j) => { p.set(0, 0, -j.len * 0.5).applyMatrix4(j.node.matrixWorld); const d = grip.sdf(p) - j.r0; score += Math.abs(d); return d.toFixed(3); }); rows.push(ds.join('/')); });
  p.setFromMatrixPosition(r.wrist);
  console.log(cx, fd.join(','), 'score', score.toFixed(3), rows.join(' | '), 'wrist', p.toArray().map((x) => x.toFixed(3)).join(','), 'f', JSON.stringify(r.pose.f.map((a) => a.map((x) => +x.toFixed(2)))));
}

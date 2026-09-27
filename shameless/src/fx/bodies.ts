import * as THREE from 'three';

/**
 * Pooled rigid-ish bodies drawn with one InstancedMesh: debris chunks, splinters, glass shards,
 * brass casings. Simple, allocation-free physics: gravity, drag, spin, bounce off a floor height
 * (found once per spawn by a raycast) and optionally off the plane of the surface they came from.
 */
export class BodyParams {
  px = 0; py = 0; pz = 0;
  vx = 0; vy = 0; vz = 0;
  ax = 0; ay = 0; az = 0; // angular velocity (rad/s)
  sx = 0.02; sy = 0.02; sz = 0.02;
  life = 3;
  floorY = -1e9;
  nx = 0; ny = 0; nz = 0; d = 0;
  restitution = 0.35;
  friction = 0.55;
  drag = 0.4;
  r = 0.5; g = 0.5; b = 0.5;
  /** 1 = settles lying on its side (casings) */
  lieFlat = 0;
  qx = 0; qy = 0; qz = 0; qw = 1;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export interface BodyHitCallback { (x: number, y: number, z: number, speed: number, kind: number): void }

export class BodyPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private pos: Float32Array; private vel: Float32Array; private ang: Float32Array;
  private rot: Float32Array; private scl: Float32Array; private plane: Float32Array;
  private misc: Float32Array; // age, life, floorY, restitution, friction, drag, lieFlat, settled
  private alive: Uint8Array;
  private head = 0;
  private anyAlive = false;
  onBounce: BodyHitCallback | null = null;
  kind = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.cap = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) { this.mesh.setMatrixAt(i, ZERO); this.mesh.setColorAt(i, _c.setRGB(1, 1, 1)); }
    this.pos = new Float32Array(capacity * 3); this.vel = new Float32Array(capacity * 3); this.ang = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 4); this.scl = new Float32Array(capacity * 3); this.plane = new Float32Array(capacity * 4);
    this.misc = new Float32Array(capacity * 8);
    this.alive = new Uint8Array(capacity);
  }

  spawn(b: BodyParams): void {
    // prefer a dead slot near the head
    let i = this.head;
    for (let k = 0; k < this.cap; k++) {
      const s = (this.head + k) % this.cap;
      if (!this.alive[s]) { i = s; break; }
    }
    this.head = (i + 1) % this.cap;
    this.alive[i] = 1;
    this.anyAlive = true;
    const i3 = i * 3, i4 = i * 4, i8 = i * 8;
    this.pos[i3] = b.px; this.pos[i3 + 1] = b.py; this.pos[i3 + 2] = b.pz;
    this.vel[i3] = b.vx; this.vel[i3 + 1] = b.vy; this.vel[i3 + 2] = b.vz;
    this.ang[i3] = b.ax; this.ang[i3 + 1] = b.ay; this.ang[i3 + 2] = b.az;
    this.rot[i4] = b.qx; this.rot[i4 + 1] = b.qy; this.rot[i4 + 2] = b.qz; this.rot[i4 + 3] = b.qw;
    this.scl[i3] = b.sx; this.scl[i3 + 1] = b.sy; this.scl[i3 + 2] = b.sz;
    this.plane[i4] = b.nx; this.plane[i4 + 1] = b.ny; this.plane[i4 + 2] = b.nz; this.plane[i4 + 3] = b.d;
    const m = this.misc;
    m[i8] = 0; m[i8 + 1] = b.life; m[i8 + 2] = b.floorY; m[i8 + 3] = b.restitution; m[i8 + 4] = b.friction; m[i8 + 5] = b.drag; m[i8 + 6] = b.lieFlat; m[i8 + 7] = 0;
    this.mesh.setColorAt(i, _c.setRGB(b.r, b.g, b.b));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (!this.anyAlive) return;
    let any = false;
    const P = this.pos, V = this.vel, A = this.ang, R = this.rot, S = this.scl, PL = this.plane, M = this.misc;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3, i4 = i * 4, i8 = i * 8;
      M[i8] += dt;
      const age = M[i8], life = M[i8 + 1];
      if (age >= life) { this.alive[i] = 0; this.mesh.setMatrixAt(i, ZERO); continue; }
      any = true;
      const settled = M[i8 + 7] > 0.5;
      const rad = Math.max(S[i3], S[i3 + 1], S[i3 + 2]) * 0.5;
      if (!settled && dt > 0) {
        const drag = Math.max(0, 1 - M[i8 + 5] * dt);
        V[i3] *= drag; V[i3 + 1] = (V[i3 + 1] - 9.81 * dt) * drag; V[i3 + 2] *= drag;
        P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        // spin
        const wx = A[i3], wy = A[i3 + 1], wz = A[i3 + 2];
        const wl = Math.hypot(wx, wy, wz);
        _q.set(R[i4], R[i4 + 1], R[i4 + 2], R[i4 + 3]);
        if (wl > 1e-4) {
          _ax.set(wx / wl, wy / wl, wz / wl);
          _dq.setFromAxisAngle(_ax, wl * dt);
          _q.premultiply(_dq);
        }
        // surface plane (wall it flew off)
        const nx = PL[i4], ny = PL[i4 + 1], nz = PL[i4 + 2];
        if (nx * nx + ny * ny + nz * nz > 0.5) {
          const dist = nx * P[i3] + ny * P[i3 + 1] + nz * P[i3 + 2] + PL[i4 + 3] - rad;
          if (dist < 0) {
            P[i3] -= nx * dist; P[i3 + 1] -= ny * dist; P[i3 + 2] -= nz * dist;
            const vn = V[i3] * nx + V[i3 + 1] * ny + V[i3 + 2] * nz;
            if (vn < 0) {
              const k = (1 + M[i8 + 3]) * vn;
              V[i3] -= k * nx; V[i3 + 1] -= k * ny; V[i3 + 2] -= k * nz;
            }
          }
        }
        // floor
        const fy = M[i8 + 2] + rad * (M[i8 + 6] > 0.5 ? 0.25 : 0.6);
        if (P[i3 + 1] < fy) {
          P[i3 + 1] = fy;
          if (V[i3 + 1] < 0) {
            const speed = -V[i3 + 1];
            V[i3 + 1] = speed * M[i8 + 3];
            V[i3] *= M[i8 + 4]; V[i3 + 2] *= M[i8 + 4];
            A[i3] *= 0.6; A[i3 + 1] *= 0.6; A[i3 + 2] *= 0.6;
            if (speed > 0.6 && this.onBounce) this.onBounce(P[i3], P[i3 + 1], P[i3 + 2], speed, this.kind);
            if (V[i3 + 1] < 0.35 && Math.hypot(V[i3], V[i3 + 2]) < 0.25) {
              M[i8 + 7] = 1;
              V[i3] = V[i3 + 1] = V[i3 + 2] = 0;
              if (M[i8 + 6] > 0.5) {
                // lie on the side: long axis (local Y) horizontal, keep heading
                _ax.set(0, 1, 0).applyQuaternion(_q);
                _ax.y = 0;
                if (_ax.lengthSq() < 1e-4) _ax.set(1, 0, 0);
                _ax.normalize();
                _q.setFromUnitVectors(_up, _ax);
              }
            }
          }
        }
        R[i4] = _q.x; R[i4 + 1] = _q.y; R[i4 + 2] = _q.z; R[i4 + 3] = _q.w;
      }
      const fade = Math.min(1, (life - age) / 0.5);
      _p.set(P[i3], P[i3 + 1] - (1 - fade) * rad, P[i3 + 2]);
      _q.set(R[i4], R[i4 + 1], R[i4 + 2], R[i4 + 3]);
      _s.set(S[i3] * fade, S[i3 + 1] * fade, S[i3 + 2] * fade);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anyAlive = any;
  }
}

import * as THREE from 'three';
import type { GunMaterials } from './materials';
import { flameSideTexture, flameStarTexture, glowTexture, smokeTexture } from './materials';
import { cartridge556 } from './rifle';
import { finish, latheZ, merge } from './geom';

/**
 * Viewmodel-space weapon effects: layered muzzle flash (side flame cards + front star + core glow + flicker light),
 * muzzle smoke wisps, and ejected brass that flies out of the port and is handed off to the world FX system.
 */
export class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private side: THREE.Mesh[] = [];
  private star: THREE.Mesh;
  private core: THREE.Sprite;
  private sideTex: THREE.Texture[];
  private starTex: THREE.Texture[];
  private t = 1;
  private life = 0.05;
  private rand = Math.random;

  constructor() {
    this.sideTex = [0, 1, 2, 3].map((i) => flameSideTexture(i + 1));
    this.starTex = [0, 1, 2].map((i) => flameStarTexture(i + 3, 4 + i));
    const mk = (tex: THREE.Texture) => new THREE.MeshBasicMaterial({
      map: tex, color: new THREE.Color(3.2, 2.2, 1.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
    });
    // cross of side cards along the bore (-Z); plane is built with the muzzle at its local origin
    const planeG = new THREE.PlaneGeometry(1, 0.5);
    planeG.translate(0.5, 0, 0);
    planeG.rotateY(Math.PI / 2); // extend toward -Z
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(planeG, mk(this.sideTex[i]));
      m.rotation.z = (i / 3) * Math.PI;
      m.renderOrder = 20;
      this.side.push(m);
      this.group.add(m);
    }
    const starG = new THREE.PlaneGeometry(1, 1);
    this.star = new THREE.Mesh(starG, mk(this.starTex[0]));
    this.star.renderOrder = 21;
    this.group.add(this.star);
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(2.5, 1.7, 1.0), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.core.renderOrder = 22;
    this.group.add(this.core);
    this.light = new THREE.PointLight(0xffb070, 0, 2.5, 2);
    this.group.visible = false;
  }

  /** Brake style: side ports throw flame sideways (horizontal), less forward. */
  fire(scale = 1, brake = true, ads = 0): void {
    const r = this.rand;
    this.t = 0;
    this.life = 0.035 + r() * 0.02;
    this.group.visible = true;
    const s = scale * (0.85 + r() * 0.35);
    for (let i = 0; i < this.side.length; i++) {
      const m = this.side[i];
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.map = this.sideTex[Math.floor(r() * this.sideTex.length)];
      const len = (0.07 + r() * 0.07) * s * (brake ? 0.8 : 1.2);
      m.scale.set(len, len * (0.5 + r() * 0.5), 1);
      m.rotation.z = (i / this.side.length) * Math.PI + (r() - 0.5) * 0.6 + (brake ? 0 : r() * 3);
    }
    // front star faces the camera-ish (perpendicular to bore), random spin
    const sm = this.star.material as THREE.MeshBasicMaterial;
    sm.map = this.starTex[Math.floor(r() * this.starTex.length)];
    const ss = (0.06 + r() * 0.05) * s * (1 - ads * 0.35);
    this.star.scale.set(ss * (brake ? 1.6 : 1.0), ss, 1);
    this.star.rotation.z = brake ? (r() - 0.5) * 0.3 : r() * Math.PI;
    this.star.position.z = -0.01;
    this.core.scale.setScalar((0.08 + r() * 0.04) * s);
    this.core.position.z = -0.012;
  }

  update(dt: number): void {
    this.t += dt;
    const k = 1 - this.t / this.life;
    if (k <= 0) {
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    const f = k * k;
    for (const m of this.side) (m.material as THREE.MeshBasicMaterial).opacity = f;
    (this.star.material as THREE.MeshBasicMaterial).opacity = f;
    this.core.material.opacity = f;
    this.light.intensity = 3.5 * f * (0.7 + Math.random() * 0.3);
  }
  get active(): boolean { return this.group.visible; }
}

interface Puff { sprite: THREE.Sprite; vel: THREE.Vector3; age: number; life: number; size: number; spin: number }

export class MuzzleSmoke {
  readonly group = new THREE.Group();
  private puffs: Puff[] = [];
  private pool: THREE.Sprite[] = [];
  private tex: THREE.Texture[];
  heat = 0;
  constructor() {
    this.tex = [0, 1, 2].map((i) => smokeTexture(i + 1));
    for (let i = 0; i < 24; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex[i % 3], color: 0xd8d6d2, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      s.renderOrder = 15;
      this.group.add(s);
      this.pool.push(s);
    }
  }
  /** pos/dir in the group's (camera) space. */
  emit(pos: THREE.Vector3, dir: THREE.Vector3, amount: number): void {
    this.heat = Math.min(1, this.heat + 0.08);
    const n = amount > 0.5 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const sp = this.pool.find((p) => !p.visible);
      if (!sp) return;
      sp.visible = true;
      sp.position.copy(pos).addScaledVector(dir, 0.01 + Math.random() * 0.02);
      const v = dir.clone().multiplyScalar(0.25 + Math.random() * 0.35);
      v.x += (Math.random() - 0.5) * 0.12; v.y += 0.05 + Math.random() * 0.08;
      this.puffs.push({ sprite: sp, vel: v, age: 0, life: 0.5 + Math.random() * 0.6 + this.heat * 0.6, size: 0.02 + Math.random() * 0.02, spin: (Math.random() - 0.5) * 2 });
    }
  }
  update(dt: number, camVelocity: THREE.Vector3): void {
    this.heat = Math.max(0, this.heat - dt * 0.3);
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { p.sprite.visible = false; this.puffs.splice(i, 1); continue; }
      p.vel.multiplyScalar(Math.exp(-dt * 3.5));
      p.vel.y += dt * 0.06;
      p.sprite.position.addScaledVector(p.vel, dt).addScaledVector(camVelocity, -dt);
      const s = p.size * (1 + k * 4);
      p.sprite.scale.setScalar(s);
      const m = p.sprite.material;
      m.rotation += p.spin * dt;
      m.opacity = 0.16 * Math.sin(Math.min(1, k * 3) * Math.PI * 0.5) * (1 - k);
    }
  }
}

interface Casing { mesh: THREE.Group; vel: THREE.Vector3; ang: THREE.Vector3; age: number; handed: boolean }

/** Brass casings in viewmodel space; after a short flight they are handed to world FX via onHandoff. */
export class BrassEjector {
  readonly group = new THREE.Group();
  private live: Casing[] = [];
  private pool: { rifle: THREE.Group[]; pistol: THREE.Group[] } = { rifle: [], pistol: [] };
  constructor(mats: GunMaterials, private onHandoff: (c: THREE.Group, vel: THREE.Vector3, kind: 'rifle' | 'pistol') => void) {
    const rc = cartridge556();
    const caseR = finish(latheZ([
      [0, 0], [0.0045, 0], [0.0048, 0.0004], [0.0048, 0.0011], [0.0040, 0.0013], [0.0040, 0.0020], [0.0047, 0.0026],
      [0.0045, 0.036], [0.0034, 0.0395], [0.0029, 0.0400], [0.0029, 0.0445], [0.0024, 0.0445], [0.0024, 0.041], [0, 0.041],
    ], 12), 50);
    void rc;
    const caseP = finish(latheZ([[0, 0], [0.0049, 0], [0.0049, 0.0010], [0.0045, 0.0013], [0.0048, 0.0018], [0.0048, 0.0190], [0.0042, 0.0190], [0.0042, 0.017], [0, 0.017]], 12), 50);
    for (let i = 0; i < 10; i++) {
      for (const kind of ['rifle', 'pistol'] as const) {
        const g = new THREE.Group();
        const m = new THREE.Mesh(kind === 'rifle' ? caseR : caseP, mats.brass);
        m.position.z = kind === 'rifle' ? 0.022 : 0.0095; // center the casing on its group origin
        g.add(m);
        g.visible = false;
        this.group.add(g);
        this.pool[kind].push(g);
      }
    }
    void merge;
  }
  eject(pos: THREE.Vector3, vel: THREE.Vector3, quat: THREE.Quaternion, kind: 'rifle' | 'pistol'): void {
    const g = this.pool[kind].find((p) => !p.visible) ?? this.live.find((c) => c.mesh.userData.kind === kind)?.mesh;
    if (!g) return;
    const existing = this.live.findIndex((c) => c.mesh === g);
    if (existing >= 0) this.live.splice(existing, 1);
    g.userData.kind = kind;
    g.visible = true;
    g.position.copy(pos);
    g.quaternion.copy(quat);
    this.live.push({
      mesh: g, vel: vel.clone(), age: 0, handed: false,
      ang: new THREE.Vector3((Math.random() - 0.5) * 18, 20 + Math.random() * 25, (Math.random() - 0.5) * 12),
    });
  }
  update(dt: number, camVelocity: THREE.Vector3): void {
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = this.live.length - 1; i >= 0; i--) {
      const c = this.live[i];
      c.age += dt;
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt).addScaledVector(camVelocity, -dt);
      e.set(c.ang.x * dt, c.ang.y * dt, c.ang.z * dt);
      c.mesh.quaternion.multiply(q.setFromEuler(e));
      if (c.age > 0.22) {
        if (!c.handed) this.onHandoff(c.mesh, c.vel, c.mesh.userData.kind);
        c.mesh.visible = false;
        this.live.splice(i, 1);
      }
    }
  }
}

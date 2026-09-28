import * as THREE from 'three';
import type { WCtx } from './context';
import { RNG, fbm } from './rng';
import { mk } from './builder';
import { paint } from './geo';

/**
 * Distant city silhouette (low-detail blocks with window texture, domes, minarets, towers)
 * and a mountain ring. Not collidable, no shadow casting.
 */
export function horizon(w: WCtx, rng: RNG) {
  const far = 'custom:far';
  w.b.noShadow.add(far);
  const cx = 3, cz = 0;
  const blocks: [number, number, number][] = [];
  // Rings of blocks between radius 95 and 260 (outside the backdrop buildings)
  for (let i = 0; i < 260; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(98, 280);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const bw = rng.range(8, 22), bd = rng.range(8, 20);
    const h = rng.range(5, 13) * (r < 140 ? 1 : 0.85) + (rng.chance(0.04) ? rng.range(6, 14) : 0);
    blocks.push([x, z, h]);
    farBox(w, far, x, h / 2, z, bw, h, bd, rng.range(0, Math.PI));
    // parapet + roof clutter silhouettes
    if (rng.chance(0.5)) farBox(w, far, x + rng.jit(bw / 3), h + 0.9, z + rng.jit(bd / 3), rng.range(1.5, 3), 1.8, rng.range(1.5, 3), 0);
    if (rng.chance(0.3)) {
      const t = new THREE.CylinderGeometry(0.7, 0.7, 1.4, 8);
      w.b.addT(far, t, x + rng.jit(bw / 3), h + 1.2, z + rng.jit(bd / 3), 0, 0, 0, 1, 1, 1, 'keep');
    }
  }
  // Mosque domes + minarets
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng.jit(0.4) + 0.3;
    const r = rng.range(120, 220);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    farBox(w, far, x, 5, z, 20, 10, 20, a);
    const dome = new THREE.SphereGeometry(7, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    w.b.addT(far, dome, x, 10, z, 0, 0, 0, 1, 1.15, 1, 'keep');
    const drum = new THREE.CylinderGeometry(7.2, 7.2, 1.5, 20);
    w.b.addT(far, drum, x, 10, z, 0, 0, 0, 1, 1, 1, 'keep');
    for (const off of [-1, 1]) {
      const mx = x + Math.cos(a + Math.PI / 2) * 14 * off, mz = z + Math.sin(a + Math.PI / 2) * 14 * off;
      if (i % 2 === 1 && off > 0) continue;
      const H = rng.range(30, 42);
      const shaft = new THREE.CylinderGeometry(1.1, 1.5, H, 10);
      w.b.addT(far, shaft, mx, H / 2, mz, 0, 0, 0, 1, 1, 1, 'keep');
      const bal = new THREE.CylinderGeometry(2.2, 1.6, 1.2, 12);
      w.b.addT(far, bal, mx, H * 0.78, mz, 0, 0, 0, 1, 1, 1, 'keep');
      const top = new THREE.CylinderGeometry(0.9, 1.0, 4, 10);
      w.b.addT(far, top, mx, H + 2, mz, 0, 0, 0, 1, 1, 1, 'keep');
      const cone = new THREE.ConeGeometry(1.1, 4.5, 10);
      w.b.addT(far, cone, mx, H + 6.2, mz, 0, 0, 0, 1, 1, 1, 'keep');
    }
  }
  // Water tower + telecom mast + a couple of tall concrete blocks
  {
    const a = 2.3, r = 150;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const stem = new THREE.CylinderGeometry(2, 3, 28, 12);
    w.b.addT(far, stem, x, 14, z, 0, 0, 0, 1, 1, 1, 'keep');
    const bowl = new THREE.SphereGeometry(9, 16, 8);
    w.b.addT(far, bowl, x, 32, z, 0, 0, 0, 1, 0.55, 1, 'keep');
  }
  {
    const a = -0.9, r = 175;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.CylinderGeometry(0.25, 0.6, 55, 4);
      w.b.addT(far, leg, x + Math.cos(i * 2.09) * 2, 27.5, z + Math.sin(i * 2.09) * 2, 0, 0, 0, 1, 1, 1, 'keep');
    }
    for (let k = 0; k < 4; k++) farBox(w, far, x, 30 + k * 7, z, 1.2, 1.4, 1.2, k);
  }
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(190, 260);
    const h = rng.range(22, 34);
    farBox(w, far, cx + Math.cos(a) * r, h / 2, cz + Math.sin(a) * r, rng.range(14, 22), h, rng.range(14, 22), a);
  }
  // Mountains
  const mk2 = 'custom:mountain';
  w.b.noShadow.add(mk2);
  w.b.noChunk.add(mk2);
  const seg = 220, rings = 7;
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const r = 520 + t * 380;
      const ridge = fbm(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 91, 5);
      const peak = Math.pow(ridge, 1.8) * 150 + 18;
      const prof = Math.sin(Math.min(1, t * 1.25) * Math.PI) * (0.55 + 0.45 * fbm(a * 9, t * 4, 3, 3));
      const hh = (j === 0 || j === rings) ? -20 : peak * prof;
      pos.push(cx + Math.cos(a) * r, hh, cz + Math.sin(a) * r);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  mg.setIndex(idx);
  mg.computeVertexNormals();
  w.b.add(mk2, mg, undefined, 'world');
  void mk;
}

function farBox(w: WCtx, key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry: number) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  // UV in meters / 8 so the window texture repeats per ~8m (2 floors)
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const su = nx > 0.5 ? sz : sx, sv = ny > 0.5 ? sz : sy;
    uv.setXY(i, (uv.getX(i) * su) / 8, (uv.getY(i) * sv) / 8);
  }
  paint(g, FAR_COLS[Math.floor(Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453)) % FAR_COLS.length]);
  w.b.addT(key, g, x, y, z, ry, 0, 0, 1, 1, 1, 'keep');
}

const FAR_COLS = [0xd8c8a8, 0xc4ae8c, 0xb09a7c, 0xe2d6c0, 0xa89880, 0xc8b89c, 0x9c8c78, 0xd0b894].map((c) => new THREE.Color(c));

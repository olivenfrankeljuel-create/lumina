import * as THREE from 'three';
import { mk } from './builder';
import type { WCtx } from './context';
import { RNG } from './rng';
import { Frame, fb, fg, coverSides, scaleUV, debris } from './props';
import { cylBetween } from './geo';
import { D } from './textures';

/** Extrude a side profile (x = length, y = height) across the car width (local z). */
function body(pts: [number, number][], width: number, bevel = 0.04): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  return g;
}

function arch(cx: number, cy: number, r: number, n = 8): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - (i / n) * Math.PI;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function wheel(w: WCtx, f: Frame, lx: number, lz: number, r: number, width: number, burned: boolean, rng: RNG, sink = 0) {
  const side = Math.sign(lz);
  if (!burned) {
    const tire = new THREE.CylinderGeometry(r, r, width, 20, 1);
    scaleUV(tire, 2 * Math.PI * r, width);
    fg(w, f, mk('rubber', 1), tire, lx, r - sink, lz, 0, Math.PI / 2, 0, 'keep');
    // sidewall bulge ring
    const ring = new THREE.TorusGeometry(r * 0.82, r * 0.16, 6, 20);
    fg(w, f, mk('rubber', 1), ring, lx, r - sink, lz + side * width * 0.42, 0, 0, 0);
  }
  const rimR = burned ? r * 0.72 : r * 0.62;
  const rim = new THREE.CylinderGeometry(rimR, rimR, width * 0.85, 14, 1);
  fg(w, f, mk(burned ? 'metal_rusty' : 'metal_bare', burned ? 3 : 1), rim, lx, (burned ? rimR : r) - sink, lz, 0, Math.PI / 2, 0);
  // hub + lug studs
  const hub = new THREE.CylinderGeometry(rimR * 0.35, rimR * 0.4, 0.06, 10);
  fg(w, f, mk(burned ? 'metal_rusty' : 'chrome', 0), hub, lx, (burned ? rimR : r) - sink, lz + side * width * 0.44, 0, Math.PI / 2, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    fb(w, f, mk(burned ? 'metal_rusty' : 'metal_bare', 2), lx + Math.cos(a) * rimR * 0.7, (burned ? rimR : r) - sink + Math.sin(a) * rimR * 0.7, lz + side * width * 0.43, 0.05, 0.05, 0.03);
  }
  void rng;
}

/** Toyota-Hilux-like pickup: ~5.3 x 1.8 x 1.8 m. Local +x = front. */
export function pickup(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, paint: 'car_paint_white' | 'car_paint_red' = 'car_paint_white', technical = false) {
  const f = new Frame(x, y, z, ry);
  const P = mk(paint, rng.int(1, 3));
  const W = 1.8;
  // cab + hood with front wheel arch
  const cab: [number, number][] = [
    [-0.62, 0.5], ...arch(1.62, 0.42, 0.48), [2.52, 0.5], [2.66, 0.62], [2.68, 0.96], [2.5, 1.08], [1.32, 1.15], [0.58, 1.76], [-0.42, 1.8], [-0.62, 1.72],
  ];
  fg(w, f, P, body(cab, W, 0.05), 0, 0, 0);
  // bed lower with rear arch
  const bed: [number, number][] = [[-2.68, 0.55], ...arch(-1.72, 0.42, 0.48), [-0.64, 0.55], [-0.64, 0.82], [-2.68, 0.82]];
  fg(w, f, P, body(bed, W, 0.03), 0, 0, 0);
  // bed walls
  fb(w, f, P, -1.66, 0.97, W / 2 - 0.04, 2.04, 0.3, 0.07);
  fb(w, f, P, -1.66, 0.97, -W / 2 + 0.04, 2.04, 0.3, 0.07);
  fb(w, f, P, -2.64, 0.97, 0, 0.07, 0.3, W - 0.02); // tailgate
  fb(w, f, P, -0.68, 1.0, 0, 0.07, 0.36, W - 0.02);
  fb(w, f, mk('plastic_black', 0), -1.66, 1.13, W / 2 - 0.04, 2.04, 0.03, 0.09);
  fb(w, f, mk('plastic_black', 0), -1.66, 1.13, -W / 2 + 0.04, 2.04, 0.03, 0.09);
  fb(w, f, mk('metal_diamond_plate', 0), -1.66, 0.83, 0, 1.9, 0.02, W - 0.16);
  // windows
  const G = mk('glass', 0);
  const ws = Math.atan2(1.76 - 1.15, 0.58 - 1.32);
  fb(w, f, G, (1.32 + 0.58) / 2 + 0.02, (1.15 + 1.76) / 2 + 0.02, 0, Math.hypot(0.74, 0.61) - 0.06, 0.02, W - 0.22, false, 0, ws);
  for (const sz of [-1, 1]) {
    const side = new THREE.Shape([new THREE.Vector2(1.22, 1.2), new THREE.Vector2(0.56, 1.7), new THREE.Vector2(-0.4, 1.73), new THREE.Vector2(-0.52, 1.2)]);
    const g = new THREE.ShapeGeometry(side);
    fg(w, f, G, g, 0, 0, sz * (W / 2 + 0.003), sz > 0 ? 0 : Math.PI, 0, 0);
    // door seams + handles + mirror
    fb(w, f, mk('plastic_black', 0), 0.35, 0.85, sz * (W / 2 + 0.002), 0.012, 0.65, 0.01);
    fb(w, f, mk('chrome', 0), 0.12, 1.05, sz * (W / 2 + 0.012), 0.14, 0.03, 0.02);
    fb(w, f, mk('plastic_black', 0), 1.2, 1.25, sz * (W / 2 + 0.1), 0.08, 0.14, 0.18);
    // B-pillar trim
    fb(w, f, mk('plastic_black', 0), -0.46, 1.46, sz * (W / 2 + 0.004), 0.1, 0.52, 0.01);
    wheel(w, f, 1.62, sz * (W / 2 - 0.13), 0.39, 0.27, false, rng);
    wheel(w, f, -1.72, sz * (W / 2 - 0.13), 0.39, 0.27, false, rng);
    // side step
    fb(w, f, mk('plastic_black', 1), 0.3, 0.45, sz * (W / 2 - 0.02), 1.5, 0.05, 0.14);
    // mud flaps
    fb(w, f, mk('rubber', 0), 1.02, 0.35, sz * (W / 2 - 0.15), 0.02, 0.3, 0.25);
  }
  fb(w, f, G, -0.6, 1.4, 0, 0.02, 0.4, W - 0.3, false, 0, 0.1);
  // front: grille, bumper, lights
  fb(w, f, mk('plastic_black', 0), 2.69, 0.8, 0, 0.04, 0.26, 1.0);
  for (let i = 0; i < 4; i++) fb(w, f, mk('chrome', 0), 2.71, 0.7 + i * 0.065, 0, 0.02, 0.018, 1.0);
  fb(w, f, mk('chrome', 1), 2.72, 0.53, 0, 0.14, 0.18, W - 0.04);
  for (const sz of [-1, 1]) {
    fb(w, f, mk('glass', 0), 2.64, 0.93, sz * 0.7, 0.08, 0.12, 0.3, false, 0, -0.3);
    fb(w, f, mk('car_paint_red', 0), -2.7, 0.95, sz * 0.8, 0.04, 0.22, 0.12);
  }
  // rear bumper + hitch
  fb(w, f, mk('metal_bare', 1), -2.74, 0.52, 0, 0.12, 0.14, W - 0.04);
  fb(w, f, mk('metal_rusty', 0), -2.85, 0.45, 0, 0.18, 0.06, 0.06);
  // undercarriage / chassis dark
  fb(w, f, mk('metal_rusty', 3), 0, 0.42, 0, 5.0, 0.12, 1.2);
  // roll bar + bed cargo
  const rb = mk('metal_bare', 2);
  for (const sz of [-1, 1]) {
    w.b.add(rb, cylBetween(f.p(-0.85, 0.85, sz * 0.8), f.p(-0.85, 1.85, sz * 0.72), 0.035, 8));
    w.b.add(rb, cylBetween(f.p(-0.85, 1.6, sz * 0.78), f.p(-1.5, 1.08, sz * 0.84), 0.03, 8));
  }
  w.b.add(rb, cylBetween(f.p(-0.85, 1.85, -0.72), f.p(-0.85, 1.85, 0.72), 0.035, 8));
  if (technical) {
    // DShK-like mount
    w.b.add(mk('metal_rusty', 1), cylBetween(f.p(-1.6, 0.84, 0), f.p(-1.6, 1.8, 0), 0.06, 8));
    fb(w, f, mk('gun_parkerized', 0), -1.4, 1.9, 0, 0.9, 0.16, 0.16);
    w.b.add(mk('gun_parkerized', 0), cylBetween(f.p(-1.0, 1.92, 0), f.p(0.3, 1.98, 0), 0.03, 6));
    fb(w, f, mk('metal_painted_green', 1), -1.55, 1.9, 0.25, 0.25, 0.2, 0.15);
  } else {
    fb(w, f, mk('wood_planks', 1), -1.9, 0.98, -0.3, 0.8, 0.3, 0.6, false, 0, 0, 0.3);
    fb(w, f, mk('metal_painted_green', 2), -2.3, 1.07, 0.5, 0.35, 0.45, 0.17);
    fb(w, f, mk('metal_painted_green', 2), -2.3, 1.07, 0.3, 0.35, 0.45, 0.17);
    fb(w, f, mk('tarp', 1), -1.3, 0.9, 0.4, 0.9, 0.12, 0.7, false, 0.05, 0.1);
  }
  // collision: lower body + cab
  const c1 = f.p(0, 0, 0);
  w.b.colBox(c1.x, y + 0.72, c1.z, 5.4, 0.62, W, 'metal', ry);
  const c2 = f.p(0.15, 0, 0);
  w.b.colBox(c2.x, y + 1.4, c2.z, 1.4, 0.8, W - 0.1, 'metal', ry);
  coverSides(w, f, 2.4, W / 2, true, true);
  w.decal(D.OIL, new THREE.Vector3(x, y + 0.012, z), new THREE.Vector3(0, 1, 0), 2.4, 1.6, ry);
}

/** Sedan. burned = charred shell on rims, no glass, scorched ground. */
export function sedan(w: WCtx, x: number, y: number, z: number, ry: number, rng: RNG, burned: boolean, paint: 'car_paint_white' | 'car_paint_red' = 'car_paint_white') {
  const sink = burned ? 0.14 : 0;
  const f = new Frame(x, y - sink, z, ry);
  const tilt = burned ? rng.jit(0.03) : 0;
  const P = burned ? mk('metal_rusty', 3) : mk(paint, rng.int(0, 3));
  const W = 1.74;
  const lower: [number, number][] = [
    [-2.25, 0.42], ...arch(-1.35, 0.36, 0.42), ...arch(1.4, 0.36, 0.42), [2.2, 0.42], [2.3, 0.55], [2.3, 0.78], [2.1, 0.88], [0.9, 0.95], [-1.5, 0.98], [-2.2, 0.95], [-2.3, 0.78], [-2.3, 0.55],
  ];
  fg(w, f, P, body(lower, W, 0.05), 0, 0, 0, 0, 0, tilt);
  // cabin pillars + roof
  const C = burned ? mk('metal_rusty', 2) : P;
  const roofY = 1.42;
  fb(w, f, C, -0.2, roofY, 0, 1.55, 0.05, W - 0.2, false, 0, tilt);
  for (const sz of [-1, 1]) {
    const zz = sz * (W / 2 - 0.12);
    // A pillar
    fb(w, f, C, 0.95, 1.18, zz, 0.07, 0.93, 0.07, false, 0, 1.04);
    // B pillar
    fb(w, f, C, -0.12, 1.18, zz, 0.08, 0.5, 0.07);
    // C pillar
    fb(w, f, C, -1.22, 1.2, zz, 0.08, 0.7, 0.07, false, 0, -0.9);
    // wheels
    wheel(w, f, 1.4, sz * (W / 2 - 0.12), 0.33, 0.22, burned, rng, 0);
    wheel(w, f, -1.35, sz * (W / 2 - 0.12), 0.33, 0.22, burned, rng, 0);
    if (!burned) {
      const side = new THREE.Shape([new THREE.Vector2(1.28, 0.98), new THREE.Vector2(0.6, 1.38), new THREE.Vector2(-0.93, 1.38), new THREE.Vector2(-1.42, 0.98)]);
      fg(w, f, mk('glass', 0), new THREE.ShapeGeometry(side), 0, 0, sz * (W / 2 - 0.1), sz > 0 ? 0 : Math.PI);
      fb(w, f, mk('chrome', 0), 0.2, 0.86, sz * (W / 2 + 0.005), 0.12, 0.025, 0.02);
      fb(w, f, mk('chrome', 0), -0.8, 0.86, sz * (W / 2 + 0.005), 0.12, 0.025, 0.02);
      fb(w, f, mk('plastic_black', 0), -0.3, 0.7, sz * (W / 2 + 0.004), 0.012, 0.55, 0.01);
      fb(w, f, mk('plastic_black', 0), 0.72, 1.05, sz * (W / 2 + 0.08), 0.07, 0.1, 0.14);
    }
  }
  if (!burned) {
    fb(w, f, mk('glass', 0), 0.95, 1.18, 0, 0.93, 0.02, W - 0.25, false, 0, -0.53);
    fb(w, f, mk('glass', 0), -1.22, 1.2, 0, 0.7, 0.02, W - 0.25, false, 0, 0.67);
    fb(w, f, mk('chrome', 0), 2.32, 0.5, 0, 0.1, 0.14, W - 0.05);
    fb(w, f, mk('chrome', 0), -2.32, 0.5, 0, 0.1, 0.14, W - 0.05);
    fb(w, f, mk('plastic_black', 0), 2.31, 0.7, 0, 0.03, 0.16, 0.8);
    for (const sz of [-1, 1]) {
      fb(w, f, mk('glass', 0), 2.27, 0.73, sz * 0.65, 0.06, 0.12, 0.3);
      fb(w, f, mk('car_paint_red', 0), -2.3, 0.78, sz * 0.66, 0.04, 0.14, 0.26);
    }
    // interior: seats + dash
    fb(w, f, mk('cloth_black', 0), -0.2, 0.9, 0, 0.5, 0.35, W - 0.3);
    fb(w, f, mk('cloth_black', 0), -0.4, 1.15, 0, 0.12, 0.45, W - 0.3, false, 0, 0.2);
    fb(w, f, mk('plastic_black', 0), 0.75, 0.98, 0, 0.35, 0.12, W - 0.2);
  } else {
    // charred interior: seat springs/frames, steering ring, sagging roof
    fb(w, f, mk('metal_rusty', 3), -0.2, 0.62, 0.35, 0.5, 0.05, 0.5);
    fb(w, f, mk('metal_rusty', 3), -0.2, 0.62, -0.35, 0.5, 0.05, 0.5);
    fb(w, f, mk('metal_rusty', 3), -0.42, 0.9, 0.35, 0.05, 0.55, 0.5, false, 0, 0.25);
    fb(w, f, mk('metal_rusty', 3), -0.42, 0.9, -0.35, 0.05, 0.55, 0.5, false, 0, 0.25);
    fb(w, f, mk('metal_rusty', 3), -1.0, 0.65, 0, 0.6, 0.05, W - 0.3);
    const ring = new THREE.TorusGeometry(0.18, 0.018, 4, 12);
    fg(w, f, mk('metal_rusty', 2), ring, 0.4, 1.0, 0.35, Math.PI / 2, 0.5, 0);
    // hood popped open
    fb(w, f, mk('metal_rusty', 3), 1.55, 1.05, 0, 1.2, 0.03, W - 0.1, false, 0, 0.35);
    // debris / glass around
    debris(w, x, y, z, 3, 16, rng);
    w.decal(D.SCORCH, new THREE.Vector3(x, y + 0.013, z), new THREE.Vector3(0, 1, 0), 6.5, 4.5, ry + rng.jit(0.3));
    w.decal(D.OIL, new THREE.Vector3(x + rng.jit(1), y + 0.016, z + rng.jit(1)), new THREE.Vector3(0, 1, 0), 2.5, 2.0, rng.range(0, 6));
  }
  const c = f.p(0, 0, 0);
  w.b.colBox(c.x, y - sink + 0.62, c.z, 4.6, 0.72, W, 'metal', ry);
  const c2 = f.p(-0.25, 0, 0);
  w.b.colBox(c2.x, y - sink + 1.2, c2.z, 2.2, 0.45, W - 0.2, 'metal', ry);
  coverSides(w, f, 2.1, W / 2, true, false);
}

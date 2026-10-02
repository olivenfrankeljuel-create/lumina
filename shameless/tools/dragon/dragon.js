// Low-poly textured dragon, built procedurally and exported as GLB.
// Runs in the browser (driven by tools/dragon/build.mjs). Faceted (flat-shaded) geometry, one 1024² texture
// atlas shared by every part: base color, tangent-space normal map, and an emissive map for the eyes.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- texture atlas
const ATLAS = 1024;
const PAD = 6;
// [x, y, w, h] in pixels; uv (0,0) is the top-left of the image (glTF convention, flipY = false)
const REGION = {
  scales: [0, 0, 512, 512],
  belly: [512, 0, 256, 512],
  horn: [768, 0, 128, 512],
  claw: [896, 0, 128, 512],
  membrane: [0, 512, 512, 512],
  eye: [512, 512, 128, 128],
  mouth: [640, 512, 128, 128],
  wingskin: [768, 512, 256, 512],
};

function uvIn(region, u, v) {
  const [x, y, w, h] = REGION[region];
  u = Math.min(1, Math.max(0, u));
  v = Math.min(1, Math.max(0, v));
  return [(x + PAD + u * (w - 2 * PAD)) / ATLAS, (y + PAD + v * (h - 2 * PAD)) / ATLAS];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintAtlas() {
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS;
    return [c, c.getContext('2d')];
  };
  const [colC, col] = mk();
  const [hC, ht] = mk(); // height (for the normal map)
  const [emC, em] = mk();
  const rand = rng(1337);
  col.fillStyle = '#5a1418';
  col.fillRect(0, 0, ATLAS, ATLAS);
  ht.fillStyle = '#808080';
  ht.fillRect(0, 0, ATLAS, ATLAS);
  em.fillStyle = '#000';
  em.fillRect(0, 0, ATLAS, ATLAS);

  const clip = (ctx, r, fn) => {
    const [x, y, w, h] = REGION[r];
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x, y);
    fn(w, h);
    ctx.restore();
  };

  // Scales: overlapping rounded scales, tileable on both axes, darker toward the edges of each scale.
  const scalePattern = (r, hue, light, size) =>
    clip(col, r, (w, h) => {
      const g = col.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, `hsl(${hue},62%,${light - 6}%)`);
      g.addColorStop(0.5, `hsl(${hue},64%,${light + 3}%)`);
      g.addColorStop(1, `hsl(${hue},62%,${light - 6}%)`);
      col.fillStyle = g;
      col.fillRect(0, 0, w, h);
      const sw = size, sh = size * 0.8;
      const rows = Math.ceil(h / sh) + 2;
      const cols = Math.ceil(w / sw) + 2;
      for (let j = -1; j < rows; j++) {
        for (let i = -1; i < cols; i++) {
          const cx = i * sw + (j % 2 ? sw / 2 : 0);
          const cy = j * sh;
          const l = light + (rand() - 0.5) * 9;
          const hh = hue + (rand() - 0.5) * 8;
          const sg = col.createRadialGradient(cx, cy + sh * 0.2, 1, cx, cy + sh * 0.35, sw * 0.62);
          sg.addColorStop(0, `hsl(${hh},66%,${l + 9}%)`);
          sg.addColorStop(0.7, `hsl(${hh},64%,${l}%)`);
          sg.addColorStop(1, `hsl(${hh},60%,${l - 12}%)`);
          col.fillStyle = sg;
          col.beginPath();
          col.ellipse(cx, cy + sh * 0.3, sw * 0.56, sh * 0.85, 0, 0, Math.PI);
          col.fill();
          col.strokeStyle = `hsla(${hh},50%,${l - 22}%,0.85)`;
          col.lineWidth = 1.5;
          col.stroke();
        }
      }
    });
  const scaleHeight = (r, size) =>
    clip(ht, r, (w, h) => {
      const sw = size, sh = size * 0.8;
      for (let j = -1; j < Math.ceil(h / sh) + 2; j++) {
        for (let i = -1; i < Math.ceil(w / sw) + 2; i++) {
          const cx = i * sw + (j % 2 ? sw / 2 : 0);
          const cy = j * sh;
          const g = ht.createRadialGradient(cx, cy + sh * 0.1, 1, cx, cy + sh * 0.3, sw * 0.6);
          g.addColorStop(0, '#d8d8d8');
          g.addColorStop(1, '#383838');
          ht.fillStyle = g;
          ht.beginPath();
          ht.ellipse(cx, cy + sh * 0.3, sw * 0.56, sh * 0.85, 0, 0, Math.PI);
          ht.fill();
        }
      }
    });
  scalePattern('scales', 356, 28, 32);
  scaleHeight('scales', 32);
  scalePattern('wingskin', 352, 22, 22);
  scaleHeight('wingskin', 22);

  // Belly: warm plates in horizontal bands (bands run across the body; v runs along it).
  clip(col, 'belly', (w, h) => {
    const band = 28;
    for (let y = 0; y < h; y += band) {
      const l = 58 + (rand() - 0.5) * 6;
      const g = col.createLinearGradient(0, y, 0, y + band);
      g.addColorStop(0, `hsl(36,52%,${l + 8}%)`);
      g.addColorStop(0.75, `hsl(32,48%,${l}%)`);
      g.addColorStop(1, `hsl(26,45%,${l - 22}%)`);
      col.fillStyle = g;
      col.fillRect(0, y, w, band);
    }
    for (let i = 0; i < 900; i++) {
      col.fillStyle = `rgba(80,45,20,${rand() * 0.12})`;
      col.fillRect(rand() * w, rand() * h, 2, 2);
    }
    const sg = col.createLinearGradient(0, 0, w, 0);
    sg.addColorStop(0, 'rgba(90,20,24,0.55)');
    sg.addColorStop(0.18, 'rgba(90,20,24,0)');
    sg.addColorStop(0.82, 'rgba(90,20,24,0)');
    sg.addColorStop(1, 'rgba(90,20,24,0.55)');
    col.fillStyle = sg;
    col.fillRect(0, 0, w, h);
  });
  clip(ht, 'belly', (w, h) => {
    for (let y = 0; y < h; y += 28) {
      const g = ht.createLinearGradient(0, y, 0, y + 28);
      g.addColorStop(0, '#b0b0b0');
      g.addColorStop(0.8, '#909090');
      g.addColorStop(1, '#202020');
      ht.fillStyle = g;
      ht.fillRect(0, y, w, 28);
    }
  });

  // Horn / spikes: dark base (v=0) to ivory tip (v=1), with growth rings.
  clip(col, 'horn', (w, h) => {
    const g = col.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3a2a22');
    g.addColorStop(0.35, '#8a7458');
    g.addColorStop(1, '#efe4c6');
    col.fillStyle = g;
    col.fillRect(0, 0, w, h);
    for (let y = 8; y < h * 0.8; y += 14 + rand() * 10) {
      col.strokeStyle = `rgba(40,25,15,${0.25 + rand() * 0.25})`;
      col.lineWidth = 2;
      col.beginPath();
      col.moveTo(0, y);
      for (let x = 0; x <= w; x += 16) col.lineTo(x, y + (rand() - 0.5) * 4);
      col.stroke();
    }
  });
  clip(ht, 'horn', (w, h) => {
    for (let y = 8; y < h * 0.8; y += 16) {
      ht.fillStyle = '#505050';
      ht.fillRect(0, y, w, 3);
    }
  });

  // Claws / teeth tips: near-black keratin.
  clip(col, 'claw', (w, h) => {
    const g = col.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2e2622');
    g.addColorStop(1, '#0e0c0b');
    col.fillStyle = g;
    col.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      col.strokeStyle = 'rgba(120,100,90,0.15)';
      col.beginPath();
      const x = rand() * w;
      col.moveTo(x, 0);
      col.lineTo(x + (rand() - 0.5) * 10, h);
      col.stroke();
    }
  });

  // Wing membrane: translucent-looking leathery skin with veins and mottling.
  clip(col, 'membrane', (w, h) => {
    const g = col.createRadialGradient(w * 0.15, h * 0.15, 10, w * 0.5, h * 0.5, w * 0.8);
    g.addColorStop(0, '#8a2a30');
    g.addColorStop(1, '#4a1420');
    col.fillStyle = g;
    col.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      col.fillStyle = `rgba(${rand() < 0.5 ? '30,5,10' : '150,60,55'},${rand() * 0.12})`;
      col.beginPath();
      col.arc(rand() * w, rand() * h, 4 + rand() * 18, 0, Math.PI * 2);
      col.fill();
    }
  });
  const veins = (ctx, color, width) =>
    clip(ctx, 'membrane', (w, h) => {
      const vr = rng(99);
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        let x = vr() * w * 0.2, y = vr() * h * 0.2;
        const ang = 0.15 + (i / 9) * 1.3 + (vr() - 0.5) * 0.2;
        let lw = width;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 14; s++) {
          x += Math.cos(ang + (vr() - 0.5) * 0.6) * 40;
          y += Math.sin(ang + (vr() - 0.5) * 0.6) * 40;
          ctx.lineTo(x, y);
          if (vr() < 0.25) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + (vr() - 0.5) * 80, y + vr() * 70);
            ctx.moveTo(x, y);
          }
        }
        ctx.lineWidth = lw;
        ctx.stroke();
      }
    });
  veins(col, 'rgba(40,6,12,0.55)', 3);
  veins(ht, '#c8c8c8', 4);

  // Eye: amber iris with a slit pupil; also the only emissive region.
  const eye = (ctx, glow) =>
    clip(ctx, 'eye', (w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      g.addColorStop(0, glow ? '#ffd040' : '#fff070');
      g.addColorStop(0.6, glow ? '#ff7a10' : '#ffa21a');
      g.addColorStop(1, glow ? '#401000' : '#5a1a00');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w * 0.07, h * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  eye(col, false);
  eye(em, true);

  clip(col, 'mouth', (w, h) => {
    col.fillStyle = '#3e0c14';
    col.fillRect(0, 0, w, h);
  });

  // Height → tangent-space normal map (OpenGL convention: +Y up in the image).
  const hd = ht.getImageData(0, 0, ATLAS, ATLAS).data;
  const [nC, nctx] = mk();
  const out = nctx.createImageData(ATLAS, ATLAS);
  const H = (x, y) => hd[(((y + ATLAS) % ATLAS) * ATLAS + ((x + ATLAS) % ATLAS)) * 4] / 255;
  const k = 2.2;
  for (let y = 0; y < ATLAS; y++) {
    for (let x = 0; x < ATLAS; x++) {
      const nx = (H(x - 1, y) - H(x + 1, y)) * k;
      const ny = (H(x, y + 1) - H(x, y - 1)) * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * ATLAS + x) * 4;
      out.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  nctx.putImageData(out, 0, 0);

  const tex = (canvas, srgb, mime) => {
    const t = new THREE.CanvasTexture(canvas);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.userData.mimeType = mime;
    return t;
  };
  return {
    map: tex(colC, true, 'image/jpeg'),
    normalMap: tex(nC, false, 'image/png'),
    emissiveMap: tex(emC, true, 'image/jpeg'),
  };
}

// ---------------------------------------------------------------- geometry
/** Triangle soup: every triangle has its own vertices, so computeVertexNormals() yields faceted normals. */
class Soup {
  constructor() {
    this.pos = [];
    this.uv = [];
  }
  /** Adds a triangle; if `inside` is given, winding is flipped so the face points away from it. */
  tri(a, b, c, ua, ub, uc, inside) {
    if (inside) {
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const cen = a.clone().add(b).add(c).divideScalar(3).sub(inside);
      if (n.dot(cen) < 0) {
        [b, c] = [c, b];
        [ub, uc] = [uc, ub];
      }
    }
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...ua, ...ub, ...uc);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    return g;
  }
}

/**
 * Tube along a polyline with elliptical cross-sections. radii[i] is a number or [rx, ry]; 0 collapses the
 * ring to a point (a tip). opts: sides, up (frame reference), region | belly (region for underside quads),
 * tile (world length per texture repeat along v; default: whole length maps to 0..1), roll (radians).
 */
function loft(soup, pts, radii, opts = {}) {
  const sides = opts.sides ?? 6;
  const upRef = opts.up ?? V(0, 1, 0);
  const region = opts.region ?? 'scales';
  const rings = [];
  const centers = pts;
  let total = 0;
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push((total += pts[i].distanceTo(pts[i - 1])));
  for (let i = 0; i < pts.length; i++) {
    const t = new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    let side = new THREE.Vector3().crossVectors(upRef, t);
    if (side.lengthSq() < 1e-6) side = V(1, 0, 0);
    side.normalize();
    const up = new THREE.Vector3().crossVectors(t, side).normalize();
    const r = radii[i];
    const [rx, ry] = Array.isArray(r) ? r : [r, r];
    if (rx === 0 && ry === 0) {
      rings.push(null);
      continue;
    }
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = Math.PI / 2 + (k / sides) * Math.PI * 2 + (opts.roll ?? 0);
      ring.push(pts[i].clone().addScaledVector(side, Math.cos(a) * rx).addScaledVector(up, Math.sin(a) * ry));
    }
    rings.push(ring);
  }
  const vOf = (i) => (opts.tile ? along[i] / opts.tile : along[i] / total);
  const regionFor = (k) => {
    if (!opts.belly) return region;
    const a = Math.PI / 2 + ((k + 0.5) / sides) * Math.PI * 2 + (opts.roll ?? 0);
    return Math.sin(a) < -0.3 ? opts.belly : region;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const inside = centers[i].clone().add(centers[i + 1]).multiplyScalar(0.5);
    let v0 = vOf(i), v1 = vOf(i + 1);
    if (opts.tile) {
      // keep each segment inside the atlas cell: wrap, and shift back if it would overflow
      const f = Math.floor(v0);
      v0 -= f;
      v1 -= f;
      if (v1 > 1) {
        v0 -= v1 - 1;
        v1 = 1;
      }
    }
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      const reg = regionFor(k);
      const u0 = k / sides, u1 = (k + 1) / sides;
      if (A && B) {
        soup.tri(A[k], A[k2], B[k2], uvIn(reg, u0, v0), uvIn(reg, u1, v0), uvIn(reg, u1, v1), inside);
        soup.tri(A[k], B[k2], B[k], uvIn(reg, u0, v0), uvIn(reg, u1, v1), uvIn(reg, u0, v1), inside);
      } else if (A) {
        soup.tri(A[k], A[k2], pts[i + 1], uvIn(reg, u0, v0), uvIn(reg, u1, v0), uvIn(reg, (u0 + u1) / 2, v1), inside);
      } else if (B) {
        soup.tri(pts[i], B[k2], B[k], uvIn(reg, (u0 + u1) / 2, v0), uvIn(reg, u1, v1), uvIn(reg, u0, v1), inside);
      }
    }
  }
  // flat caps on open ends
  const cap = (ring, center, inner, v) => {
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      soup.tri(center, ring[k], ring[k2], uvIn(region, 0.5, v), uvIn(region, k / sides, v), uvIn(region, (k + 1) / sides, v), inner);
    }
  };
  if (rings[0]) cap(rings[0], pts[0], pts[1], 0);
  const n = pts.length - 1;
  if (rings[n]) cap(rings[n], pts[n], pts[n - 1], 1);
  return rings;
}

/** Simple cone (spike, claw, tooth, horn) with `sides` facets. */
function cone(soup, base, tip, r, region, sides = 4, up) {
  loft(soup, [base, tip], [r, 0], { sides, region, up });
}

/** Low-poly diamond eye. */
function eyeball(soup, c, out, size) {
  const n = out.clone().normalize();
  const a = new THREE.Vector3().crossVectors(n, V(0, 1, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(a, n).normalize();
  const front = c.clone().addScaledVector(n, size * 0.6);
  const back = c.clone().addScaledVector(n, -size * 0.6);
  const ring = [
    c.clone().addScaledVector(b, size * 0.7),
    c.clone().addScaledVector(a, size),
    c.clone().addScaledVector(b, -size * 0.7),
    c.clone().addScaledVector(a, -size),
  ];
  const ruv = [uvIn('eye', 0.5, 0), uvIn('eye', 1, 0.5), uvIn('eye', 0.5, 1), uvIn('eye', 0, 0.5)];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    soup.tri(front, ring[k], ring[k2], uvIn('eye', 0.5, 0.5), ruv[k], ruv[k2], c);
    soup.tri(back, ring[k2], ring[k], uvIn('mouth', 0.5, 0.5), uvIn('mouth', 0, 0), uvIn('mouth', 1, 1), c);
  }
}

function buildDragon() {
  const body = new Soup();
  const wings = new Soup();

  // ---- spine: tail tip → hips → chest → S-neck → head → nose
  const spine = [
    V(0.75, 0.1, -3.05), V(0.62, 0.14, -2.75), V(0.38, 0.22, -2.35), V(0.12, 0.34, -1.95), V(0.0, 0.5, -1.5),
    V(0, 0.68, -1.05), V(0, 0.86, -0.6), V(0, 0.92, -0.1), V(0, 0.98, 0.35), V(0, 1.1, 0.72),
    V(0, 1.38, 0.98), V(0, 1.72, 1.08), V(0, 1.98, 1.2), V(0, 2.12, 1.42), V(0, 2.14, 1.6),
    V(0, 2.1, 1.82), V(0, 2.05, 2.0), V(0, 2.02, 2.1),
  ];
  const rad = [
    [0.03, 0.025], [0.06, 0.05], [0.09, 0.08], [0.13, 0.12], [0.17, 0.16],
    [0.22, 0.22], [0.31, 0.3], [0.36, 0.37], [0.35, 0.36], [0.25, 0.26],
    [0.17, 0.18], [0.14, 0.15], [0.13, 0.14], [0.16, 0.15], [0.16, 0.13],
    [0.11, 0.085], [0.07, 0.055], [0.035, 0.03],
  ];
  const rings = loft(body, spine, rad, { sides: 8, belly: 'belly', region: 'scales', tile: 1.3 });

  // ---- dorsal spikes from the tail to the back of the skull
  for (let i = 1; i <= 13; i++) {
    const top = rings[i][0];
    const t = new THREE.Vector3().subVectors(spine[i + 1], spine[i - 1]).normalize();
    const ry = rad[i][1];
    const h = 0.05 + ry * 0.55;
    const tip = top.clone().add(V(0, h, 0)).addScaledVector(t, -h * 0.7);
    cone(body, top.clone().addScaledVector(t, 0.0), tip, 0.02 + ry * 0.2, 'horn', 4, t);
  }

  // ---- tail spade
  const tailDir = new THREE.Vector3().subVectors(spine[0], spine[1]).normalize();
  const tip = spine[0];
  loft(body, [tip.clone().addScaledVector(tailDir, -0.05), tip.clone().addScaledVector(tailDir, 0.12), tip.clone().addScaledVector(tailDir, 0.38)],
    [[0.03, 0.02], [0.17, 0.025], 0], { sides: 4, region: 'wingskin' });

  // ---- lower jaw (mouth slightly open), mouth interior, teeth
  loft(body, [V(0, 1.98, 1.42), V(0, 1.9, 1.72), V(0, 1.83, 1.94), V(0, 1.8, 2.02)],
    [[0.12, 0.06], [0.095, 0.045], [0.05, 0.03], 0], { sides: 6, region: 'scales', belly: 'belly' });
  for (const s of [-1, 1]) {
    for (const [z, h] of [[1.68, 0.07], [1.8, 0.06], [1.92, 0.05]]) {
      const y = 2.13 - (z - 1.6) * 0.32 - 0.1;
      cone(body, V(s * 0.065 * (2.1 - z) * 2.2, y + 0.02, z), V(s * 0.06 * (2.1 - z) * 2.2, y - h, z + 0.01), 0.015, 'horn', 3);
    }
    cone(body, V(s * 0.05, 1.9, 1.86), V(s * 0.05, 1.98, 1.87), 0.014, 'horn', 3);
  }

  // ---- eyes, brow spikes, horns, cheek frills
  for (const s of [-1, 1]) {
    eyeball(body, V(s * 0.118, 2.2, 1.66), V(s * 0.85, 0.35, 0.4), 0.04);
    cone(body, V(s * 0.1, 2.24, 1.62), V(s * 0.14, 2.32, 1.5), 0.03, 'horn', 4);
    loft(body, [V(s * 0.08, 2.2, 1.46), V(s * 0.13, 2.34, 1.28), V(s * 0.19, 2.42, 1.06), V(s * 0.22, 2.4, 0.86)],
      [0.055, 0.042, 0.026, 0], { sides: 5, region: 'horn' });
    cone(body, V(s * 0.14, 2.06, 1.5), V(s * 0.26, 2.1, 1.3), 0.035, 'horn', 4);
    cone(body, V(s * 0.12, 2.0, 1.44), V(s * 0.22, 1.98, 1.26), 0.03, 'horn', 4);
  }

  // ---- legs + feet (toes with claws)
  const foot = (s, ankle, len) => {
    for (const spread of [-0.45, 0, 0.45]) {
      const dir = V(Math.sin(spread) * s, 0, Math.cos(spread));
      const a = ankle.clone().add(V(0, -0.02, 0));
      const b = a.clone().addScaledVector(dir, len).setY(0.045);
      loft(body, [a, b], [0.05, 0.035], { sides: 5, region: 'scales' });
      cone(body, b, b.clone().addScaledVector(dir, 0.09).setY(0.0), 0.03, 'claw', 4, V(0, 1, 0));
    }
    // dewclaw / heel spur
    cone(body, ankle.clone().add(V(0, 0.02, -0.03)), ankle.clone().add(V(0, 0.0, -0.13)), 0.025, 'claw', 4);
  };
  for (const s of [-1, 1]) {
    // front
    loft(body, [V(s * 0.24, 1.0, 0.42), V(s * 0.38, 0.62, 0.36), V(s * 0.37, 0.24, 0.52), V(s * 0.37, 0.08, 0.6)],
      [0.15, 0.1, 0.075, 0.065], { sides: 6, up: V(0, 0, 1), region: 'scales' });
    foot(s, V(s * 0.37, 0.08, 0.6), 0.14);
    // hind (thick thigh, reverse hock)
    loft(body, [V(s * 0.26, 0.88, -0.55), V(s * 0.42, 0.56, -0.28), V(s * 0.4, 0.26, -0.6), V(s * 0.4, 0.08, -0.44)],
      [0.22, 0.15, 0.08, 0.07], { sides: 6, up: V(0, 0, 1), region: 'scales' });
    foot(s, V(s * 0.4, 0.08, -0.44), 0.16);
  }

  // ---- wings: bones in the body mesh, membranes in a double-sided mesh
  for (const s of [-1, 1]) {
    const X = (v) => V(v.x * s, v.y, v.z);
    const root = X(V(0.14, 1.24, 0.48));
    const elbow = X(V(0.78, 1.78, 0.24));
    const wrist = X(V(1.3, 2.4, 0.02));
    const f1 = X(V(2.7, 2.55, -0.55));
    const f2 = X(V(2.45, 1.55, -0.98));
    const f3 = X(V(1.7, 1.02, -1.08));
    const attach = X(V(0.1, 1.12, -0.5));
    loft(body, [root, elbow, wrist], [0.075, 0.055, 0.045], { sides: 5, region: 'wingskin' });
    for (const f of [f1, f2, f3]) loft(body, [wrist, f], [0.035, 0.006], { sides: 4, region: 'wingskin' });
    cone(body, wrist, wrist.clone().add(X(V(0.05, 0.18, 0.12))), 0.03, 'claw', 4); // thumb claw
    for (const f of [f1, f2, f3]) {
      const d = new THREE.Vector3().subVectors(f, wrist).normalize();
      cone(body, f, f.clone().addScaledVector(d, 0.08), 0.012, 'claw', 3);
    }

    // scalloped trailing edge
    const scallop = (a, b, toward, k) => a.clone().lerp(b, 0.5).lerp(toward, k);
    const m12 = scallop(f1, f2, wrist, 0.22);
    const m23 = scallop(f2, f3, wrist, 0.2);
    const m3a = scallop(f3, attach, elbow, 0.18);
    // planar projection into the membrane cell
    const e1 = new THREE.Vector3().subVectors(f1, root).normalize();
    const n = new THREE.Vector3().subVectors(f3, root).cross(e1).normalize();
    const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
    const all = [root, elbow, wrist, f1, f2, f3, attach, m12, m23, m3a];
    const pr = all.map((p) => [new THREE.Vector3().subVectors(p, root).dot(e1), new THREE.Vector3().subVectors(p, root).dot(e2)]);
    const minU = Math.min(...pr.map((p) => p[0])), maxU = Math.max(...pr.map((p) => p[0]));
    const minV = Math.min(...pr.map((p) => p[1])), maxV = Math.max(...pr.map((p) => p[1]));
    const muv = (p) => {
      const d = new THREE.Vector3().subVectors(p, root);
      return uvIn('membrane', (d.dot(e1) - minU) / (maxU - minU), (d.dot(e2) - minV) / (maxV - minV));
    };
    const T = (a, b, c) => wings.tri(a, b, c, muv(a), muv(b), muv(c));
    T(wrist, f1, m12); T(wrist, m12, f2); T(wrist, f2, m23); T(wrist, m23, f3);
    T(elbow, wrist, f3); T(elbow, f3, m3a); T(elbow, m3a, attach); T(elbow, attach, root);
  }

  return { body: body.geometry(), wings: wings.geometry() };
}

// ---------------------------------------------------------------- scene, export, preview
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(1200, 900);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const tex = paintAtlas();
const geo = buildDragon();
const matOpts = { ...tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 2.5, roughness: 0.62, metalness: 0.0 };
const bodyMat = new THREE.MeshStandardMaterial({ ...matOpts, name: 'DragonSkin' });
const wingMat = new THREE.MeshStandardMaterial({ ...matOpts, name: 'DragonWing', side: THREE.DoubleSide, roughness: 0.75 });
const dragon = new THREE.Group();
dragon.name = 'Dragon';
const bodyMesh = new THREE.Mesh(geo.body, bodyMat);
bodyMesh.name = 'DragonBody';
const wingMesh = new THREE.Mesh(geo.wings, wingMat);
wingMesh.name = 'DragonWings';
dragon.add(bodyMesh, wingMesh);

const exportScene = new THREE.Scene();
exportScene.add(dragon);

window.__stats = {
  triangles: (geo.body.attributes.position.count + geo.wings.attributes.position.count) / 3,
  bodyTris: geo.body.attributes.position.count / 3,
  wingTris: geo.wings.attributes.position.count / 3,
};

window.__exportGLB = async () => {
  const buf = await new GLTFExporter().parseAsync(exportScene, { binary: true });
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  window.__glb = buf;
  return btoa(bin);
};

// Preview: reload the exported GLB (round-trip check) and render it.
const camera = new THREE.PerspectiveCamera(32, 1200 / 900, 0.05, 100);
window.__preview = async () => {
  const gltf = await new GLTFLoader().parseAsync(window.__glb, '');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x232830);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.4;
  const sun = new THREE.DirectionalLight(0xfff0dd, 3.0);
  sun.position.set(4, 7, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 25 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x9fc0ff, 1.6);
  rim.position.set(-5, 3, -4);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(8, 48), new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  gltf.scene.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  scene.add(gltf.scene);
  window.__view = (yaw, pitch, dist, tx = 0, ty = 1.2, tz = -0.2) => {
    camera.position.set(tx + Math.sin(yaw) * Math.cos(pitch) * dist, ty + Math.sin(pitch) * dist, tz + Math.cos(yaw) * Math.cos(pitch) * dist);
    camera.lookAt(tx, ty, tz);
    renderer.render(scene, camera);
  };
  window.__view(0.7, 0.15, 8.5);
};
window.__ready = true;

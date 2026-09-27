import * as THREE from 'three';
import { RNG, fbm } from './rng';

/**
 * Canvas-generated atlases owned by the world: decals (grime, stains, graffiti, posters, cracks,
 * road paint...), shop signage with Arabic script, foliage alpha cards, cloth weave.
 */

export const D = {
  GRIME: 0, STREAKS: 1, GRAFFITI_A: 2, GRAFFITI_B: 3, STENCIL: 4, POSTERS: 5, CRACKS: 6, BULLETS: 7,
  OIL: 8, DIRT: 9, LINE: 10, SCORCH: 11, PAPERS: 12, SAND: 13, DAMP: 14, RUST: 15,
} as const;

const DECAL_GRID = 4;
export function decalRect(cell: number): [number, number, number, number] {
  const cx = cell % DECAL_GRID, cy = Math.floor(cell / DECAL_GRID);
  const pad = 2 / 2048;
  // canvas y down -> uv v up
  return [cx / DECAL_GRID + pad, 1 - (cy + 1) / DECAL_GRID + pad, (cx + 1) / DECAL_GRID - pad, 1 - cy / DECAL_GRID - pad];
}

export const SIGN_COLS = 4, SIGN_ROWS = 8;
export function signRect(i: number): [number, number, number, number] {
  const cx = i % SIGN_COLS, cy = Math.floor(i / SIGN_COLS) % SIGN_ROWS;
  return [cx / SIGN_COLS, 1 - (cy + 1) / SIGN_ROWS, (cx + 1) / SIGN_COLS, 1 - cy / SIGN_ROWS];
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

function tex(c: HTMLCanvasElement, srgb = true, mips = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Per-pixel painter for one atlas cell. fn returns [r,g,b,a] 0..255 or null (transparent). */
function paintCell(g: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number, fn: (u: number, v: number) => [number, number, number, number] | null) {
  const img = g.getImageData(ox, oy, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = fn(x / w, y / h);
      if (!r) continue;
      const i = (y * w + x) * 4;
      // alpha-over onto existing
      const a = r[3] / 255, ea = d[i + 3] / 255;
      const oa = a + ea * (1 - a);
      if (oa <= 0) continue;
      d[i] = (r[0] * a + d[i] * ea * (1 - a)) / oa;
      d[i + 1] = (r[1] * a + d[i + 1] * ea * (1 - a)) / oa;
      d[i + 2] = (r[2] * a + d[i + 2] * ea * (1 - a)) / oa;
      d[i + 3] = oa * 255;
    }
  }
  g.putImageData(img, ox, oy);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function edgeFade(u: number, v: number, m = 0.12) {
  return smooth(0, m, u) * smooth(0, m, 1 - u) * smooth(0, m, v) * smooth(0, m, 1 - v);
}

function spray(g: CanvasRenderingContext2D, color: string, blur: number, draw: () => void) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = blur;
  g.strokeStyle = color;
  g.fillStyle = color;
  draw();
  g.restore();
}

export function makeDecalAtlas(): THREE.CanvasTexture {
  const S = 2048, C = S / DECAL_GRID;
  const [cv, g] = canvas(S, S);
  const rng = new RNG(4242);
  const at = (cell: number) => [(cell % DECAL_GRID) * C, Math.floor(cell / DECAL_GRID) * C] as const;

  // GRIME: dark dirt rising from the base of walls, noisy top edge, splash spots.
  {
    const [ox, oy] = at(D.GRIME);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const h = 1 - v; // 0 at bottom
      const n = fbm(u * 9, v * 5, 11, 5);
      const edge = 0.55 + (n - 0.5) * 0.7;
      let a = smooth(edge, edge - 0.45, h) * (0.45 + 0.55 * fbm(u * 30, v * 30, 3, 3));
      a *= smooth(0, 0.08, u) * smooth(0, 0.08, 1 - u);
      const spots = fbm(u * 60, v * 60, 7, 2);
      if (h < 0.35 && spots > 0.68) a = Math.max(a, 0.5);
      return [58 + n * 20, 46 + n * 14, 34 + n * 8, a * 235];
    });
  }
  // STREAKS: vertical water/dirt streaks from the top.
  {
    const [ox, oy] = at(D.STREAKS);
    const cols: number[] = [];
    for (let i = 0; i < 64; i++) cols.push(rng.range(0.15, 1));
    paintCell(g, ox, oy, C, C, (u, v) => {
      const ci = Math.floor(u * 64);
      const len = cols[ci];
      const w = Math.sin((u * 64 - ci) * Math.PI);
      let a = smooth(len, len * 0.3, v) * w * (0.3 + 0.7 * fbm(u * 100, v * 8, 2, 3));
      a *= smooth(0, 0.1, u) * smooth(0, 0.1, 1 - u);
      a = Math.max(a, smooth(0.12, 0, v) * 0.5 * fbm(u * 20, v * 20, 9, 3));
      return [48, 44, 40, a * 200];
    });
  }
  // GRAFFITI A: latin tag, spray style.
  {
    const [ox, oy] = at(D.GRAFFITI_A);
    g.save();
    g.beginPath(); g.rect(ox, oy, C, C); g.clip();
    const words = ['R3BEL', 'KAOS', 'ZERO'];
    spray(g, 'rgba(20,20,22,0.9)', 8, () => {
      g.font = 'italic bold 150px Impact, "DejaVu Sans", sans-serif';
      g.lineWidth = 10; g.lineJoin = 'round';
      g.translate(ox + 40, oy + 300); g.rotate(-0.12);
      g.strokeText(words[0], 0, 0);
    });
    g.restore();
    g.save();
    g.beginPath(); g.rect(ox, oy, C, C); g.clip();
    spray(g, 'rgba(190,40,30,0.85)', 6, () => {
      g.font = 'bold 90px Impact, "DejaVu Sans", sans-serif';
      g.translate(ox + 90, oy + 420); g.rotate(-0.05);
      g.fillText('1776', 0, 0);
    });
    spray(g, 'rgba(30,70,160,0.8)', 5, () => {
      g.lineWidth = 7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(ox + 30, oy + 140);
      for (let i = 0; i < 8; i++) g.quadraticCurveTo(ox + 60 + i * 55, oy + 60 + (i % 2) * 120, ox + 80 + i * 55, oy + 140);
      g.stroke();
    });
    // drips
    for (let i = 0; i < 18; i++) {
      const x = ox + rng.range(50, 480), y = oy + rng.range(240, 330);
      g.fillStyle = 'rgba(20,20,22,0.8)';
      g.fillRect(x, y, 3, rng.range(20, 110));
    }
    g.restore();
  }
  // GRAFFITI B: Arabic slogan spray.
  {
    const [ox, oy] = at(D.GRAFFITI_B);
    g.save();
    g.beginPath(); g.rect(ox, oy, C, C); g.clip();
    g.direction = 'rtl';
    spray(g, 'rgba(15,15,15,0.92)', 5, () => {
      g.font = 'bold 120px "Noto Naskh Arabic", "Segoe UI", Tahoma, "DejaVu Sans", sans-serif';
      g.textAlign = 'center';
      g.fillText('الحرية', ox + C / 2, oy + 220);
    });
    spray(g, 'rgba(170,25,20,0.9)', 5, () => {
      g.font = 'bold 80px "Noto Naskh Arabic", "Segoe UI", Tahoma, "DejaVu Sans", sans-serif';
      g.textAlign = 'center';
      g.fillText('لا للحرب', ox + C / 2, oy + 360);
    });
    for (let i = 0; i < 14; i++) {
      g.fillStyle = 'rgba(20,20,20,0.75)';
      g.fillRect(ox + rng.range(120, 400), oy + rng.range(210, 240), 3, rng.range(15, 80));
    }
    g.restore();
  }
  // STENCIL: faction symbol + number, faded.
  {
    const [ox, oy] = at(D.STENCIL);
    g.save();
    g.translate(ox + C / 2, oy + C / 2);
    spray(g, 'rgba(25,25,25,0.85)', 3, () => {
      g.lineWidth = 26;
      g.beginPath(); g.arc(0, -40, 150, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(-100, 60); g.lineTo(0, -170); g.lineTo(100, 60); g.stroke();
      g.font = 'bold 70px "DejaVu Sans Mono", monospace';
      g.textAlign = 'center';
      g.fillText('A-17', 0, 200);
    });
    g.restore();
    paintCell(g, ox, oy, C, C, (u, v) => {
      const n = fbm(u * 25, v * 25, 31, 4);
      return n > 0.6 ? [150, 140, 125, (n - 0.6) * 500] : null; // weathering erase-ish
    });
  }
  // POSTERS: torn overlapping posters.
  {
    const [ox, oy] = at(D.POSTERS);
    const cols = ['#d8c9a8', '#c9523e', '#e6dcc4', '#5f7f9a', '#d3b152'];
    for (let i = 0; i < 5; i++) {
      const w = rng.range(150, 230), h = rng.range(200, 300);
      const x = ox + rng.range(20, C - w - 20), y = oy + rng.range(20, C - h - 20);
      g.save();
      g.translate(x + w / 2, y + h / 2);
      g.rotate(rng.jit(0.08));
      g.fillStyle = cols[i % cols.length];
      g.beginPath();
      g.moveTo(-w / 2, -h / 2);
      for (let k = 0; k <= 10; k++) g.lineTo(-w / 2 + (w * k) / 10, -h / 2 + rng.range(0, 10));
      for (let k = 0; k <= 10; k++) g.lineTo(w / 2 - rng.range(0, 8), -h / 2 + (h * k) / 10);
      for (let k = 10; k >= 0; k--) g.lineTo(-w / 2 + (w * k) / 10, h / 2 - rng.range(0, k > 5 ? 60 : 10));
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(30,25,20,0.8)';
      g.fillRect(-w / 2 + 15, -h / 2 + 20, w - 30, 30);
      for (let k = 0; k < 6; k++) g.fillRect(-w / 2 + 15, -h / 2 + 70 + k * 18, rng.range(40, w - 30), 7);
      g.fillStyle = 'rgba(40,40,40,0.55)';
      g.beginPath(); g.arc(0, h / 4, w / 5, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    paintCell(g, ox, oy, C, C, (u, v) => {
      const n = fbm(u * 18, v * 18, 5, 4);
      return [120, 100, 70, clamp01((n - 0.35) * 1.2) * 110];
    });
  }
  // CRACKS
  {
    const [ox, oy] = at(D.CRACKS);
    g.save();
    g.strokeStyle = 'rgba(25,20,16,0.9)';
    g.lineCap = 'round';
    const crack = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
      g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y);
      for (let i = 0; i < len; i++) {
        a += rng.jit(0.5);
        x += Math.cos(a) * 9; y += Math.sin(a) * 9;
        g.lineTo(x, y);
        if (depth < 3 && rng.chance(0.08)) { g.stroke(); crack(x, y, a + rng.jit(1.2), len * 0.5, w * 0.6, depth + 1); g.lineWidth = w; g.beginPath(); g.moveTo(x, y); }
      }
      g.stroke();
    };
    for (let i = 0; i < 4; i++) crack(ox + C / 2, oy + C / 2, (i / 4) * Math.PI * 2 + rng.jit(0.4), 26, 4, 0);
    g.restore();
  }
  // BULLETS: cluster of impacts.
  {
    const [ox, oy] = at(D.BULLETS);
    for (let i = 0; i < 26; i++) {
      const x = ox + C / 2 + rng.jit(200) * rng.next(), y = oy + C / 2 + rng.jit(200) * rng.next();
      const r = rng.range(7, 15);
      const gr = g.createRadialGradient(x, y, 0, x, y, r * 3);
      gr.addColorStop(0, 'rgba(200,190,170,0.9)');
      gr.addColorStop(0.5, 'rgba(170,160,140,0.5)');
      gr.addColorStop(1, 'rgba(170,160,140,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(20,16,12,0.95)'; g.beginPath(); g.arc(x, y, r * 0.8, 0, Math.PI * 2); g.fill();
    }
  }
  // OIL stain on ground
  {
    const [ox, oy] = at(D.OIL);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = fbm(u * 6, v * 6, 21, 5);
      const a = smooth(0.95, 0.4, d + (n - 0.5) * 0.9) * (0.5 + 0.5 * fbm(u * 40, v * 40, 2, 2));
      return [18, 16, 14, a * 200];
    });
  }
  // DIRT patch
  {
    const [ox, oy] = at(D.DIRT);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = fbm(u * 5, v * 5, 41, 5);
      const a = smooth(1, 0.3, d + (n - 0.5) * 1.0) * (0.55 + 0.45 * fbm(u * 50, v * 50, 4, 3));
      const t = fbm(u * 20, v * 20, 8, 3);
      return [110 + t * 40, 88 + t * 30, 62 + t * 20, a * 225];
    });
  }
  // LINE: worn road paint
  {
    const [ox, oy] = at(D.LINE);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const n = fbm(u * 8, v * 40, 51, 5);
      const a = (n > 0.38 ? 1 : 0) * edgeFade(u, v, 0.03) * (0.75 + 0.25 * fbm(u * 60, v * 60, 3, 2));
      return [222, 214, 190, a * 235];
    });
  }
  // SCORCH
  {
    const [ox, oy] = at(D.SCORCH);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = fbm(u * 7, v * 7, 61, 5);
      const a = smooth(1, 0.1, d + (n - 0.5) * 0.8);
      return [12, 10, 9, a * 235];
    });
  }
  // PAPERS: litter
  {
    const [ox, oy] = at(D.PAPERS);
    const cols = ['#e8e2d2', '#d9d0bb', '#c7c0ae', '#a9c1d1', '#d8b0a0', '#ffffff'];
    for (let i = 0; i < 22; i++) {
      g.save();
      g.translate(ox + rng.range(40, C - 40), oy + rng.range(40, C - 40));
      g.rotate(rng.range(0, 6.28));
      const w = rng.range(18, 60), h = rng.range(14, 70);
      g.fillStyle = rng.pick(cols);
      g.beginPath(); g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, -h / 2 + rng.jit(5)); g.lineTo(w / 2 + rng.jit(5), h / 2); g.lineTo(-w / 2, h / 2 + rng.jit(6)); g.closePath(); g.fill();
      g.fillStyle = 'rgba(60,50,40,0.35)';
      g.fillRect(-w / 2 + 3, -h / 2 + 4, w - 6, 2);
      g.restore();
    }
    for (let i = 0; i < 10; i++) { // cigarette butts, bottle caps
      g.fillStyle = rng.chance(0.5) ? '#d9c28e' : '#8a8a8a';
      g.fillRect(ox + rng.range(20, C - 20), oy + rng.range(20, C - 20), rng.range(4, 10), 4);
    }
  }
  // SAND blot
  {
    const [ox, oy] = at(D.SAND);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const d = Math.hypot((u - 0.5) * 1.1, v - 0.5) * 2;
      const n = fbm(u * 4, v * 4, 71, 5);
      const a = smooth(1, 0.2, d + (n - 0.5) * 1.1);
      const t = fbm(u * 70, v * 70, 5, 2);
      return [196 + t * 25, 168 + t * 20, 124 + t * 14, a * 240];
    });
  }
  // DAMP base
  {
    const [ox, oy] = at(D.DAMP);
    paintCell(g, ox, oy, C, C, (u, v) => {
      const h = 1 - v;
      const n = fbm(u * 6, v * 3, 81, 5);
      const a = smooth(0.35 + n * 0.5, 0.05, h) * smooth(0, 0.15, u) * smooth(0, 0.15, 1 - u);
      return [52, 50, 38, a * 170];
    });
  }
  // RUST streaks
  {
    const [ox, oy] = at(D.RUST);
    const cols: number[] = [];
    for (let i = 0; i < 20; i++) cols.push(rng.range(0.3, 1));
    paintCell(g, ox, oy, C, C, (u, v) => {
      const ci = Math.floor(u * 20);
      const w = Math.sin((u * 20 - ci) * Math.PI);
      const a = smooth(cols[ci], 0, v) * w * smooth(0.2, 0.5, Math.abs(u - 0.5) < 0.3 ? 1 : 0.4) * fbm(u * 60, v * 10, 1, 3);
      return [120, 62, 30, a * 230];
    });
  }
  return tex(cv);
}

// ---------------------------------------------------------------- signs
const SHOPS: [string, string][] = [
  ['سوق الأمل', 'AL AMAL MARKET'], ['مخبز النور', 'AL NOOR BAKERY'], ['صيدلية الشفاء', 'PHARMACY'], ['مطعم الشام', 'RESTAURANT'],
  ['بقالة', 'GROCERY  0770 412 118'], ['حلويات', 'SWEETS'], ['كهرباء وتبريد', 'ELECTRIC & A/C'], ['مقهى', 'CAFE'],
  ['ورشة سيارات', 'AUTO REPAIR'], ['فندق الواحة', 'OASIS HOTEL'], ['خياط', 'TAILOR'], ['هاتف نقال', 'MOBILE PHONES'],
  ['عطور', 'PERFUMES'], ['ذهب ومجوهرات', 'GOLD & JEWELRY'], ['لحوم طازجة', 'BUTCHER'], ['خضار وفواكه', 'FRUIT & VEG'],
  ['مكتبة', 'BOOKS'], ['حلاق', 'BARBER'], ['ملابس', 'CLOTHING'], ['أدوات منزلية', 'HOUSEWARES'],
  ['صرافة', 'EXCHANGE'], ['مخزن', 'STORAGE'], ['شركة النقل', 'TRANSPORT CO.'], ['عيادة', 'CLINIC'],
  ['كافتيريا', 'CAFETERIA'], ['إطارات', 'TIRES'], ['دهانات', 'PAINTS'], ['مواد بناء', 'BUILDING SUPPLY'],
  ['قرطاسية', 'STATIONERY'], ['ألبان', 'DAIRY'], ['أقمشة', 'FABRICS'], ['بنزين', 'FUEL'],
];
const SIGN_BG = ['#2f6a3e', '#8c2a22', '#24486e', '#e3dccb', '#c9a43a', '#1f1f1f', '#6b3a64', '#d6d0c0', '#3c7a7a', '#a4532a'];

export function makeSignAtlas(): THREE.CanvasTexture {
  const W = 2048, H = 1024, CW = W / SIGN_COLS, CH = H / SIGN_ROWS;
  const [cv, g] = canvas(W, H);
  const rng = new RNG(99);
  for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
    const ox = (i % SIGN_COLS) * CW, oy = Math.floor(i / SIGN_COLS) * CH;
    const bg = SIGN_BG[i % SIGN_BG.length];
    const light = bg === '#e3dccb' || bg === '#d6d0c0' || bg === '#c9a43a';
    const fg = light ? rng.pick(['#9b1d16', '#1d3d73', '#1b1b1b', '#1f5a2c']) : rng.pick(['#f4efe0', '#f2d15b', '#ffffff']);
    g.fillStyle = bg;
    g.fillRect(ox, oy, CW, CH);
    g.strokeStyle = fg; g.lineWidth = 5; g.globalAlpha = 0.85;
    g.strokeRect(ox + 8, oy + 8, CW - 16, CH - 16);
    g.globalAlpha = 1;
    const [ar, en] = SHOPS[i % SHOPS.length];
    g.fillStyle = fg;
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.font = 'bold 58px "Noto Naskh Arabic", "Segoe UI", Tahoma, "DejaVu Sans", sans-serif';
    g.fillText(ar, ox + CW - 28, oy + 72);
    g.direction = 'ltr';
    g.textAlign = 'left';
    g.font = 'bold 26px "DejaVu Sans Condensed", "Arial Narrow", sans-serif';
    g.fillText(en, ox + 26, oy + CH - 22);
    // logo circle
    if (rng.chance(0.6)) {
      g.beginPath(); g.arc(ox + 60, oy + 50, 30, 0, Math.PI * 2); g.fill();
      g.fillStyle = bg; g.beginPath(); g.arc(ox + 60, oy + 50, 18, 0, Math.PI * 2); g.fill();
    }
  }
  // weathering: sun fade, dirt, rust drips from bolts
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = fbm(x / 40, y / 40, 3, 4);
      const fade = 0.18 + n * 0.25;
      const cy = (y % CH) / CH;
      const dirt = (0.08 + cy * 0.18) * fbm(x / 9, y / 9, 7, 3);
      for (let k = 0; k < 3; k++) {
        let v = d[i + k];
        v = v + (215 - v) * fade; // sun bleaching toward dusty white
        v = v * (1 - dirt) + 70 * dirt;
        d[i + k] = v;
      }
    }
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, W), y = Math.floor(rng.range(0, SIGN_ROWS)) * CH + rng.range(0, 30);
    const gr = g.createLinearGradient(x, y, x, y + 70);
    gr.addColorStop(0, 'rgba(110,55,25,0.55)');
    gr.addColorStop(1, 'rgba(110,55,25,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, rng.range(2, 6), 70);
  }
  return tex(cv);
}

// ---------------------------------------------------------------- foliage
/** 1024x512: left half = palm frond (base at bottom), right half = dry shrub clump. */
export function makeFoliageAtlas(): THREE.CanvasTexture {
  const [cv, g] = canvas(1024, 512);
  const rng = new RNG(7);
  // Frond: rachis up the middle, leaflets angled outward toward tip.
  const fx = 256;
  g.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    const t = i / 70;
    const y = 500 - t * 490;
    const len = (Math.sin(Math.min(1, t * 1.25) * Math.PI) * 0.85 + 0.15) * 230 * (0.8 + rng.next() * 0.3);
    for (const side of [-1, 1]) {
      const dry = rng.next();
      const col = dry > 0.7 ? `rgb(${150 + rng.int(0, 30)},${120 + rng.int(0, 20)},${70 + rng.int(0, 20)})` : `rgb(${70 + rng.int(0, 40)},${90 + rng.int(0, 30)},${40 + rng.int(0, 20)})`;
      g.strokeStyle = col;
      g.lineWidth = 7 - t * 3;
      const a = -Math.PI / 2 + side * (0.75 + rng.jit(0.15));
      const ex = fx + Math.cos(a) * len * side * side, ey = y + Math.sin(a) * len * 0.45 + len * 0.12;
      g.beginPath();
      g.moveTo(fx, y);
      g.quadraticCurveTo(fx + (ex - fx) * 0.5, y - len * 0.25, ex, ey);
      g.stroke();
    }
  }
  g.strokeStyle = '#6b5a38';
  g.lineWidth = 9;
  g.beginPath(); g.moveTo(fx, 512); g.lineTo(fx, 8); g.stroke();
  // Shrub clump
  for (let i = 0; i < 260; i++) {
    const x = 768 + rng.jit(220) * Math.sqrt(rng.next()), base = 512;
    const h = rng.range(120, 460) * (1 - Math.abs(x - 768) / 300);
    const col = rng.chance(0.55) ? `rgb(${120 + rng.int(0, 50)},${105 + rng.int(0, 40)},${60 + rng.int(0, 25)})` : `rgb(${80 + rng.int(0, 30)},${88 + rng.int(0, 25)},${45 + rng.int(0, 20)})`;
    g.strokeStyle = col;
    g.lineWidth = rng.range(2, 5);
    g.beginPath();
    g.moveTo(x, base);
    g.quadraticCurveTo(x + rng.jit(40), base - h * 0.5, x + rng.jit(90), base - h);
    g.stroke();
  }
  const t = tex(cv);
  return t;
}

/** Soft woven fabric luminance texture, tinted via vertex colors. */
export function makeClothTexture(): THREE.CanvasTexture {
  const S = 256;
  const [cv, g] = canvas(S, S);
  paintCell(g, 0, 0, S, S, (u, v) => {
    const weave = 0.9 + 0.1 * Math.sin(u * S * 1.6) * Math.sin(v * S * 1.6);
    const n = 0.75 + 0.25 * fbm(u * 8, v * 8, 3, 4);
    const c = 235 * weave * n;
    return [c, c, c, 255];
  });
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Sky-facing horizon silhouette colors are done by materials; this gives distant buildings window specks. */
export function makeFarFacadeTexture(): THREE.CanvasTexture {
  const S = 256;
  const [cv, g] = canvas(S, S);
  g.fillStyle = '#b9a88c';
  g.fillRect(0, 0, S, S);
  const rng = new RNG(5);
  paintCell(g, 0, 0, S, S, (u, v) => {
    const n = fbm(u * 6, v * 6, 13, 4);
    return [180 + n * 40, 165 + n * 35, 135 + n * 30, 255];
  });
  for (let fy = 0; fy < 8; fy++) {
    for (let fx = 0; fx < 8; fx++) {
      if (rng.chance(0.2)) continue;
      g.fillStyle = rng.chance(0.3) ? '#3a3530' : '#5b544a';
      g.fillRect(fx * 32 + 9, fy * 32 + 10, 13, 15);
    }
  }
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

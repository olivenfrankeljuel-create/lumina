import * as THREE from 'three';
import type { MatDef } from './types';

export const tile_floor: MatDef = {
  surface: 'tile', tile: 0.8, depth: 0.004, pom: 0.004, wear: 0.35, dust: 0.3, macro: 0.06, cavity: 1.0,
  glsl: /* glsl */ `
// Encaustic cement tiles, 20cm, 8-point star + ring + corner arcs, 3mm grout.
void gen(vec2 uv, inout Surf s) {
  vec2 tp = uv * 4.0;
  vec2 tc = floor(tp);
  vec2 p = fract(tp) - 0.5;
  vec4 th = hash4(vec3(mod(tc, 4.0), 9.0));
  float edgeD = (0.5 - max(abs(p.x), abs(p.y))) * 0.2; // meters to tile edge
  float chipN = fbm(uv, 60.0, 3, 1.0) * 0.5 + 0.5;
  float cornerChip = smoothstep(0.02, 0.0, length(abs(p) - 0.5) * 0.2 - chipN * 0.012 * step(0.7, th.x));
  float tileM = smoothstep(0.0012, 0.0022, edgeD + (chipN - 0.5) * 0.0008) * (1.0 - cornerChip);
  float bevel = smoothstep(0.0, 0.004, edgeD);
  // pattern
  vec2 a = abs(p);
  float sq1 = max(a.x, a.y);
  float sq2 = (a.x + a.y) * 0.7071;
  float star = 1.0 - smoothstep(0.155, 0.16, min(sq1, sq2) );
  float starIn = 1.0 - smoothstep(0.075, 0.08, min(sq1, sq2));
  float r = length(p);
  float ring = smoothstep(0.235, 0.24, r) * (1.0 - smoothstep(0.265, 0.27, r));
  float rc = length(a - 0.5);
  float arc = smoothstep(0.19, 0.195, rc) * (1.0 - smoothstep(0.225, 0.23, rc));
  float cornerFill = 1.0 - smoothstep(0.12, 0.125, rc);
  float border = smoothstep(0.455, 0.46, sq1);
  vec3 cream = srgb(vec3(206, 194, 170));
  vec3 terra = srgb(vec3(158, 80, 56));
  vec3 slate = srgb(vec3(62, 74, 82));
  vec3 ochre = srgb(vec3(190, 150, 86));
  vec3 col = cream;
  col = mix(col, slate, ring);
  col = mix(col, terra, star);
  col = mix(col, ochre, starIn);
  col = mix(col, slate, arc);
  col = mix(col, terra, cornerFill);
  col = mix(col, slate * 1.2, border * (1.0 - cornerFill));
  // cement tile mottling + pigment speckle
  float mott = fbm(uv, 24.0, 4, 2.0) * 0.5 + 0.5;
  float speck = fbm(uv, 400.0, 2, 3.0) * 0.5 + 0.5;
  col *= 0.9 + 0.12 * mott + 0.06 * speck;
  // traffic wear: faded, lighter & rougher
  float wearN = smoothstep(0.35, 0.8, fbm(uv + warp(uv, 2.0, 2, 0.1, 4.0), 2.0, 5, 5.0) * 0.5 + 0.5);
  col = mix(col, mix(col, cream * 0.95, 0.35) * 1.05, wearN * 0.7);
  // hairline cracks through a few tiles
  float cr = cracks(uv, 6.0, 0.015, 0.35, 6.0) * tileM;
  col *= 1.0 - cr * 0.5;
  vec3 grout = srgb(vec3(120, 114, 104)) * (0.8 + 0.3 * chipN);
  col = mix(grout, col * (0.85 + 0.15 * bevel), tileM);
  float stain = smoothstep(0.62, 0.9, fbm(uv, 6.0, 5, 7.0) * 0.5 + 0.5);
  col = mix(col, col * vec3(0.78, 0.72, 0.64), stain * 0.6);
  s.albedo = col;
  s.height = mix(0.3 + chipN * 0.1, 0.85 + bevel * 0.1 + speck * 0.02 - cr * 0.3 + (th.y - 0.5) * 0.05, tileM);
  s.rough = clamp(mix(0.92, 0.52 + wearN * 0.25 + speck * 0.06 + stain * 0.1, tileM), 0.0, 1.0);
  s.ao = mix(0.7, 1.0, tileM);
  s.mask = clamp((1.0 - tileM) + cr + (1.0 - bevel) * 0.5, 0.0, 1.0);
}
`,
};

export const roof_tiles: MatDef = {
  surface: 'tile', tile: 1.2, depth: 0.05, pom: 0.045, wear: 0.3, dust: 0.3, macro: 0.08, cavity: 1.0,
  glsl: /* glsl */ `
// Terracotta barrel tiles: 6 columns (caps/pans alternate), 4 courses per tile. v = down-slope.
void gen(vec2 uv, inout Surf s) {
  vec2 g = uv * vec2(6.0, 4.0);
  float col_ = floor(g.x), row = floor(g.y);
  vec2 f = fract(g);
  float isCap = mod(col_, 2.0);
  vec4 th = hash4(vec3(mod(col_, 6.0), mod(row, 4.0), 7.0));
  // caps narrower and overlap pans: cap profile over the column centre, pan profile concave
  float x = f.x - 0.5;
  float capP = sqrt(max(0.0, 1.0 - (x * 2.0) * (x * 2.0)));
  float panP = 0.35 + 0.65 * (x * 2.0) * (x * 2.0);
  // course overlap: each tile thickest at its lower edge (f.y ~ 0) and tucked under the course above
  float slope = (1.0 - f.y);
  float lip = smoothstep(0.0, 0.04, f.y);
  float h = isCap > 0.5 ? 0.45 + capP * 0.5 : 0.1 + panP * 0.3;
  h += slope * 0.08;
  h *= mix(0.85, 1.0, lip);
  float grain = fbm(uv, 300.0, 2, 1.0) * 0.5 + 0.5;
  float mott = fbm(uv + th.xy, 18.0, 4, 2.0) * 0.5 + 0.5;
  h += grain * 0.015;
  vec3 c0 = srgb(vec3(172, 88, 58)), c1 = srgb(vec3(190, 112, 72)), c2 = srgb(vec3(128, 64, 46));
  vec3 c = mix(c0, c1, th.x);
  c = mix(c, c2, step(0.85, th.y));
  c *= 0.85 + 0.25 * mott;
  c *= 0.92 + 0.1 * grain;
  // dirt / dust in the pans and at course lips, lime-mortar at cap ends
  float pan = 1.0 - isCap;
  float dirtM = pan * (1.0 - smoothstep(0.2, 0.7, abs(x) * 2.0)) * 0.5 + (1.0 - lip) * 0.6;
  c = mix(c, srgb(vec3(108, 86, 66)), dirtM * 0.6);
  float mortar = isCap * (1.0 - smoothstep(0.0, 0.1, f.y)) * step(0.6, th.z);
  c = mix(c, srgb(vec3(176, 168, 150)), mortar);
  float st = streaks(uv, 24.0, 3.0);
  c *= 1.0 - st * 0.15;
  s.albedo = c;
  s.height = h;
  s.rough = clamp(0.78 + grain * 0.1 + dirtM * 0.1, 0.0, 1.0);
  s.ao = mix(0.55, 1.0, lip) * mix(0.75, 1.0, isCap > 0.5 ? 1.0 : smoothstep(0.1, 0.45, abs(x)));
  s.mask = clamp(dirtM + st * 0.3, 0.0, 1.0);
}
`,
};

export const sandbag: MatDef = {
  surface: 'sand', tile: 0.8, depth: 0.004, wear: 0.3, dust: 0.35, macro: 0.08, cavity: 1.0, seedVar: 1.6,
  glsl: /* glsl */ `
// Woven polypropylene tape (4mm) with creases, sand dust and frayed fibres.
void gen(vec2 uv, inout Surf s) {
  vec2 F = vec2(200.0);
  vec2 p = uv * F;
  vec2 c = floor(p), f = fract(p);
  float over = mod(c.x + c.y, 2.0);
  float tapeX = smoothstep(0.0, 0.18, f.y) * smoothstep(1.0, 0.82, f.y); // horizontal tape body
  float tapeY = smoothstep(0.0, 0.18, f.x) * smoothstep(1.0, 0.82, f.x);
  float hx = tapeX * (0.75 + 0.25 * sin(f.x * PI));
  float hy = tapeY * (0.75 + 0.25 * sin(f.y * PI));
  float wv = mix(hx, hy, over);
  float tapeShade = mix(hash1(vec2(0.0, c.y), vec2(1.0, F.y), 1.0), hash1(vec2(c.x, 0.0), vec2(F.x, 1.0), 2.0), over);
  // folds & creases
  float crease = ridged(uv + warp(uv, 3.0, 2, 0.05, 3.0), vec2(4.0), 4, 4.0);
  float folds = fbm(uv, 3.0, 4, 5.0);
  float dirtN = fbm(uv + warp(uv, 5.0, 2, 0.03, 6.0), 6.0, 5, 7.0) * 0.5 + 0.5;
  float fuzz = fbm(uv, 512.0, 2, 8.0) * 0.5 + 0.5;
  vec3 base = srgb(vec3(172, 152, 112));
  vec3 col = base * (0.86 + 0.18 * tapeShade) * (0.9 + 0.1 * wv);
  col = mix(col, srgb(vec3(150, 128, 96)), smoothstep(0.5, 0.85, dirtN) * 0.7);
  col *= 1.0 - smoothstep(0.75, 0.95, crease) * 0.25;
  col = mix(col, srgb(vec3(196, 178, 140)), (1.0 - wv) * 0.25); // sand in the gaps
  s.albedo = col;
  s.height = 0.3 + wv * 0.25 + folds * 0.15 + smoothstep(0.6, 0.95, crease) * 0.2 + fuzz * 0.03;
  s.rough = 0.88 + fuzz * 0.08 - wv * 0.06;
  s.mask = clamp((1.0 - wv) * 0.6 + smoothstep(0.5, 0.9, dirtN) * 0.4, 0.0, 1.0);
}
`,
};

export const tarp: MatDef = {
  surface: 'fabric', tile: 2.0, depth: 0.01, wear: 0.25, dust: 0.3, macro: 0.08, cavity: 0.8,
  glsl: /* glsl */ `
// Laminated woven polyethylene tarp (blue), creased, sun-faded.
void gen(vec2 uv, inout Surf s) {
  vec2 F = vec2(320.0);
  vec2 p = uv * F; vec2 f = fract(p), c = floor(p);
  float grid = max(1.0 - smoothstep(0.0, 0.2, min(f.x, 1.0 - f.x)), 1.0 - smoothstep(0.0, 0.2, min(f.y, 1.0 - f.y)));
  float over = mod(c.x + c.y, 2.0);
  float wv = mix(sin(f.y * PI), sin(f.x * PI), over) * 0.5 + 0.5;
  vec2 w = warp(uv, 2.0, 3, 0.1, 1.0);
  float crease = ridged(uv + w, vec2(3.0), 5, 2.0);
  float wrinkles = fbm(uv + w, vec2(6.0, 3.0), 5, 0.55, 3.0);
  float fade = smoothstep(0.3, 0.8, fbm(uv + w * 0.5, 3.0, 5, 4.0) * 0.5 + 0.5);
  float dirtN = smoothstep(0.55, 0.85, fbm(uv, 5.0, 5, 5.0) * 0.5 + 0.5);
  vec3 blue = mix(srgb(vec3(34, 84, 148)), srgb(vec3(92, 130, 166)), fade * 0.8);
  vec3 col = blue * (0.94 + 0.06 * wv);
  col *= 1.0 - smoothstep(0.7, 0.95, crease) * 0.2;
  col = mix(col, col * 1.3 + 0.04, smoothstep(0.85, 0.98, crease) * 0.5); // whitened stress creases
  col = mix(col, srgb(vec3(120, 104, 84)), dirtN * 0.6);
  s.albedo = col;
  s.height = 0.4 + wrinkles * 0.3 + smoothstep(0.6, 0.98, crease) * 0.25 + wv * 0.015 - grid * 0.01;
  s.rough = clamp(0.5 + fade * 0.15 + dirtN * 0.3 + grid * 0.05, 0.0, 1.0);
  s.mask = clamp(dirtN + (1.0 - crease) * 0.2, 0.0, 1.0);
}
`,
};

const CLOTH_SHEEN = (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial, color = 0.5, rough = 0.8) => {
  const p = m as THREE.MeshPhysicalMaterial;
  p.sheen = 1;
  p.sheenColor = new THREE.Color(color, color, color);
  p.sheenRoughness = rough;
};

export const canvas: MatDef = {
  surface: 'fabric', tile: 1.0, depth: 0.003, wear: 0.3, dust: 0.3, macro: 0.08, cavity: 0.8, physical: true,
  setup: (m) => CLOTH_SHEEN(m, 0.25, 0.8),
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float wv = weave(uv, vec2(300.0), 1.0);
  float slub = fbm(uv, vec2(4.0, 300.0), 2, 0.5, 2.0) * 0.5 + 0.5; // thread thickness variation
  float slub2 = fbm(uv, vec2(300.0, 4.0), 2, 0.5, 3.0) * 0.5 + 0.5;
  float folds = fbm(uv + warp(uv, 2.0, 2, 0.05, 4.0), 3.0, 4, 5.0);
  float stain = smoothstep(0.55, 0.85, fbm(uv + warp(uv, 4.0, 3, 0.05, 6.0), 4.0, 5, 7.0) * 0.5 + 0.5);
  float fade = fbm(uv, 2.0, 4, 8.0) * 0.5 + 0.5;
  vec3 col = mix(srgb(vec3(98, 96, 68)), srgb(vec3(122, 118, 88)), fade);
  col *= 0.84 + 0.2 * wv + 0.06 * (slub - 0.5) + 0.06 * (slub2 - 0.5);
  col = mix(col, col * vec3(0.7, 0.66, 0.6), stain * 0.6);
  s.albedo = col;
  s.height = 0.35 + wv * 0.35 + folds * 0.2 + slub * 0.05;
  s.rough = 0.9 + 0.06 * (1.0 - wv);
  s.mask = clamp((1.0 - wv) * 0.5 + stain * 0.4, 0.0, 1.0);
}
`,
};

export const rubber: MatDef = {
  surface: 'fabric', tile: 0.5, depth: 0.0008, wear: 0.2, dust: 0.25, macro: 0.05, cavity: 0.6,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float g = fbm(uv, 256.0, 3, 1.0) * 0.5 + 0.5;
  float scuff = smoothstep(0.6, 0.85, fbm(uv + warp(uv, 6.0, 2, 0.03, 2.0), vec2(4.0, 16.0), 5, 0.5, 3.0) * 0.5 + 0.5);
  float bloom = smoothstep(0.5, 0.9, fbm(uv, 5.0, 4, 4.0) * 0.5 + 0.5); // grey UV-oxidised bloom
  vec3 col = srgb(vec3(34, 34, 35)) * (0.9 + 0.15 * g);
  col = mix(col, srgb(vec3(66, 64, 62)), bloom * 0.5);
  col = mix(col, srgb(vec3(24, 24, 24)), scuff * 0.5);
  s.albedo = col;
  s.height = 0.5 + g * 0.2 - scuff * 0.05;
  s.rough = clamp(0.82 + g * 0.08 - scuff * 0.2 + bloom * 0.06, 0.0, 1.0);
  s.mask = g * 0.4;
}
`,
};

const glassGen = (dirty: boolean) => /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float dustN = fbm(uv + warp(uv, 3.0, 3, 0.05, 1.0), 4.0, 6, 2.0) * 0.5 + 0.5;
  // rain-washed vertical channels through the dust
  float runs = streaks(uv, 36.0, 3.0);
  float spots_ = spots(uv, 60.0, 0.5, 0.1, 0.35, 4.0).x;
  float smudge = smoothstep(0.55, 0.8, fbm(uv, vec2(6.0, 3.0), 5, 0.5, 5.0) * 0.5 + 0.5);
  float dust = ${dirty ? 'clamp(0.35 + dustN * 0.5 - runs * 0.45 + spots_ * 0.3 + smoothstep(0.25, 0.0, uv.y) * 0.2, 0.0, 1.0)' : 'clamp(smoothstep(0.55, 0.9, dustN) * 0.25 + spots_ * 0.15 + smudge * 0.06, 0.0, 1.0)'};
  s.albedo = mix(vec3(0.02, 0.025, 0.025), srgb(vec3(150, 134, 112)), smoothstep(0.02, 0.3, dust));
  s.opacity = mix(${dirty ? '0.12' : '0.06'}, 0.8, dust);
  s.height = 0.5 + dust * 0.1;
  s.rough = clamp(0.03 + dust * 0.75 + smudge * 0.12, 0.0, 1.0);
  s.metal = 0.0;
  s.mask = dust;
}
`;

const setupGlass = (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial) => {
  const p = m as THREE.MeshPhysicalMaterial;
  p.ior = 1.52;
  p.specularIntensity = 1;
};
export const glass: MatDef = { surface: 'glass', tile: 1.5, depth: 0.0002, glass: true, macro: 0.0, mapping: 'world', glsl: glassGen(false), setup: setupGlass, res: 0.5 };
export const glass_dirty: MatDef = { surface: 'glass', tile: 1.5, depth: 0.0003, glass: true, macro: 0.05, mapping: 'world', glsl: glassGen(true), setup: setupGlass, res: 0.5 };

export const emissive_light: MatDef = {
  surface: 'glass', tile: 0.6, depth: 0.001, emissive: true, mapping: 'object', macro: 0.0, res: 0.25, cavity: 0.3,
  setup: (m) => { m.emissive = new THREE.Color(1.0, 0.9, 0.74); m.emissiveIntensity = 7; },
  glsl: /* glsl */ `
// Prismatic diffuser: mask channel = emissive strength.
void gen(vec2 uv, inout Surf s) {
  vec2 p = fract(uv * 64.0) - 0.5;
  float prism = 1.0 - max(abs(p.x), abs(p.y)) * 2.0;
  float n = fbm(uv, 8.0, 3, 1.0) * 0.5 + 0.5;
  s.albedo = srgb(vec3(226, 222, 212));
  s.height = 0.5 + prism * 0.3;
  s.rough = 0.35;
  s.mask = 0.85 + 0.1 * prism + 0.05 * n;
}
`,
};

const carPaint = (rgb: string) => /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float peel = fbm(uv, 120.0, 3, 1.0) * 0.5 + 0.5;
  float dustN = fbm(uv + warp(uv, 4.0, 3, 0.04, 2.0), 5.0, 6, 3.0) * 0.5 + 0.5;
  float spl = smoothstep(0.6, 0.8, fbm(uv, vec2(8.0, 3.0), 5, 0.55, 4.0) * 0.5 + 0.5 + smoothstep(0.3, 0.0, uv.y) * 0.3);
  float sc = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = hash1(vec2(float(i), 2.0), vec2(64.0), 5.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 20.0 + fbm(uv, 6.0, 2, 6.0 + float(i)) * 0.3) - 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.006, ln)) * smoothstep(0.62, 0.8, noiseT(uv, vec2(8.0), 7.0 + float(i)) * 0.5 + 0.5));
  }
  vec3 paint = srgb(vec3(${rgb}));
  vec3 col = paint * (0.97 + 0.03 * peel);
  col = mix(col, col * 0.8 + 0.08, sc * 0.6);
  s.albedo = col;
  s.height = 0.5 + peel * 0.05 - sc * 0.2;
  s.rough = 0.25 + peel * 0.05 + sc * 0.3;
  s.mask = clamp(smoothstep(0.4, 0.8, dustN) * 0.7 + spl, 0.0, 1.0);
}
`;
const setupCar = (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial) => {
  const p = m as THREE.MeshPhysicalMaterial;
  p.clearcoat = 1;
  p.clearcoatRoughness = 0.06;
};
export const car_paint_white: MatDef = { surface: 'metal', tile: 1.0, depth: 0.0003, physical: true, mapping: 'object', wear: 0.35, dust: 0.3, macro: 0.03, cavity: 0.3, glsl: carPaint('214, 212, 204'), setup: setupCar, res: 0.5 };
export const car_paint_red: MatDef = { surface: 'metal', tile: 1.0, depth: 0.0003, physical: true, mapping: 'object', wear: 0.35, dust: 0.3, macro: 0.03, cavity: 0.3, glsl: carPaint('150, 22, 20'), setup: setupCar, res: 0.5 };

export const chrome: MatDef = {
  surface: 'metal', tile: 0.5, depth: 0.0002, mapping: 'object', wear: 0.1, macro: 0.02, cavity: 0.3, res: 0.5,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float sm = smoothstep(0.5, 0.85, fbm(uv + warp(uv, 4.0, 2, 0.05, 1.0), 6.0, 6, 2.0) * 0.5 + 0.5);
  vec3 pit = spots(uv, 120.0, 0.12, 0.1, 0.3, 3.0);
  s.albedo = mix(vec3(0.55, 0.556, 0.554), srgb(vec3(120, 90, 70)), pit.x * 0.6);
  s.metal = 1.0 - pit.x * 0.5;
  s.height = 0.5 - pit.x * 0.1;
  s.rough = 0.06 + sm * 0.14 + pit.x * 0.3;
  s.mask = sm * 0.5;
}
`,
};

export const plastic_black: MatDef = {
  surface: 'wood', tile: 0.4, depth: 0.0003, mapping: 'object', wear: 0.2, dust: 0.2, macro: 0.03, cavity: 0.5, res: 0.5,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float st = spots(uv, 160.0, 0.9, 0.3, 0.55, 1.0).x;
  float g = fbm(uv, 300.0, 2, 2.0) * 0.5 + 0.5;
  float scuff = smoothstep(0.62, 0.85, fbm(uv + warp(uv, 5.0, 2, 0.03, 3.0), vec2(6.0, 20.0), 5, 0.5, 4.0) * 0.5 + 0.5);
  vec3 col = srgb(vec3(32, 32, 33)) * (0.92 + 0.1 * g);
  col = mix(col, srgb(vec3(70, 70, 70)), scuff * 0.5);
  s.albedo = col;
  s.height = 0.5 + st * 0.15 + g * 0.05;
  s.rough = clamp(0.45 + st * 0.1 + scuff * 0.2, 0.0, 1.0);
  s.mask = scuff * 0.3;
}
`,
};

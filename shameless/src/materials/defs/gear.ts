import * as THREE from 'three';
import type { MatDef } from './types';

const sheen = (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial, c: number, r: number) => {
  const p = m as THREE.MeshPhysicalMaterial;
  p.sheen = 1;
  p.sheenColor = new THREE.Color(c, c, c);
  p.sheenRoughness = r;
};

// ------------------------------------------------------------------ weapons
export const gun_parkerized: MatDef = {
  surface: 'metal', tile: 0.3, depth: 0.00025, mapping: 'object', wear: 0.35, macro: 0.04, cavity: 0.4,
  edge: [0.56, 0.565, 0.57, 0.28],
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec4 cr = worleyT(uv, 320.0, 1.0, 1.0);           // phosphate crystals (~1mm)
  float micro = fbm(uv, 700.0, 2, 2.0) * 0.5 + 0.5;
  float tool = fbm(uv, vec2(3.0, 420.0), 3, 0.5, 3.0) * 0.5 + 0.5;   // machining marks under coating
  float handle = smoothstep(0.45, 0.8, fbm(uv + warp(uv, 3.0, 2, 0.05, 4.0), 3.0, 5, 5.0) * 0.5 + 0.5);
  float oil = smoothstep(0.55, 0.8, fbm(uv, 5.0, 5, 6.0) * 0.5 + 0.5);
  float sc = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = hash1(vec2(float(i), 5.0), vec2(64.0), 7.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 16.0 + fbm(uv, 5.0, 2, 8.0 + float(i)) * 0.3) - 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.006, ln)) * smoothstep(0.64, 0.8, noiseT(uv, vec2(6.0), 9.0 + float(i)) * 0.5 + 0.5));
  }
  vec3 base = srgb(vec3(66, 67, 64)) * (0.88 + 0.2 * cr.z) * (0.95 + 0.08 * micro);
  vec3 col = mix(base, base * 1.25 + 0.012, handle * 0.35);
  col = mix(col, vec3(0.5, 0.505, 0.51), sc * 0.8);
  s.albedo = col;
  s.metal = clamp(0.3 + handle * 0.25 + sc * 0.7, 0.0, 1.0);
  s.height = 0.5 + (1.0 - cr.x) * 0.2 + micro * 0.1 + tool * 0.1 - sc * 0.3;
  s.rough = clamp(0.58 + cr.z * 0.1 + micro * 0.06 - handle * 0.16 - oil * 0.18 - sc * 0.25, 0.0, 1.0);
  s.mask = clamp(cr.x * 0.5 + (1.0 - handle) * 0.3, 0.0, 1.0);
}
`,
};

const polymer = (rgb: string, scuff: string) => /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec3 st = spots(uv, 220.0, 0.95, 0.35, 0.6, 1.0);          // molded stipple
  float grain = fbm(uv, 500.0, 2, 2.0) * 0.5 + 0.5;
  float flow = fbm(uv + warp(uv, 4.0, 2, 0.04, 3.0), 6.0, 4, 4.0) * 0.5 + 0.5; // mould flow marks
  float scuffN = smoothstep(0.62, 0.85, fbm(uv + warp(uv, 6.0, 2, 0.02, 5.0), vec2(6.0, 24.0), 5, 0.5, 6.0) * 0.5 + 0.5);
  float polish = smoothstep(0.5, 0.85, fbm(uv, 3.0, 4, 7.0) * 0.5 + 0.5);
  vec3 col = srgb(vec3(${rgb})) * (0.94 + 0.06 * flow + 0.04 * grain);
  col = mix(col, srgb(vec3(${scuff})), scuffN * 0.5);
  s.albedo = col;
  s.height = 0.5 + st.x * 0.25 + grain * 0.05 - scuffN * 0.05;
  s.rough = clamp(0.62 + st.x * 0.08 - polish * 0.2 + scuffN * 0.15 + grain * 0.04, 0.0, 1.0);
  s.mask = clamp((1.0 - st.x) * 0.3 + scuffN * 0.3, 0.0, 1.0);
}
`;
export const gun_polymer_black: MatDef = {
  surface: 'wood', tile: 0.25, depth: 0.0002, mapping: 'object', wear: 0.3, macro: 0.03, cavity: 0.5,
  edge: [0.045, 0.045, 0.047, 0.4], glsl: polymer('38, 38, 40', '70, 68, 64'),
};
export const gun_polymer_fde: MatDef = {
  surface: 'wood', tile: 0.25, depth: 0.0002, mapping: 'object', wear: 0.3, macro: 0.03, cavity: 0.5,
  edge: [0.24, 0.18, 0.12, 0.42], glsl: polymer('152, 128, 96', '118, 98, 76'),
};

export const gun_anodized: MatDef = {
  surface: 'metal', tile: 0.3, depth: 0.0001, mapping: 'object', wear: 0.3, macro: 0.03, cavity: 0.3,
  edge: [0.86, 0.865, 0.87, 0.3],
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float brush = fbm(uv, vec2(2.0, 800.0), 3, 0.6, 1.0) * 0.5 + 0.5;
  float mill = sin((uv.x + fbm(uv, 3.0, 2, 2.0) * 0.01) * TAU * 180.0) * 0.5 + 0.5;
  float handle = smoothstep(0.5, 0.85, fbm(uv, 3.0, 5, 3.0) * 0.5 + 0.5);
  float sc = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = hash1(vec2(float(i), 7.0), vec2(64.0), 4.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 14.0 + fbm(uv, 5.0, 2, 5.0 + float(i)) * 0.3) - 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.005, ln)) * smoothstep(0.66, 0.82, noiseT(uv, vec2(6.0), 6.0 + float(i)) * 0.5 + 0.5));
  }
  vec3 col = vec3(0.075, 0.075, 0.08) * (0.92 + 0.1 * brush);
  col = mix(col, vec3(0.8, 0.81, 0.82), sc * 0.85);
  s.albedo = col;
  s.metal = 1.0;
  s.height = 0.5 + brush * 0.1 + mill * 0.05 - sc * 0.3;
  s.rough = clamp(0.4 + brush * 0.06 - handle * 0.1 - sc * 0.1, 0.0, 1.0);
  s.mask = (1.0 - handle) * 0.3;
}
`,
};

// ------------------------------------------------------------------ soldier
const RIPSTOP = /* glsl */ `
float ripstop(vec2 uv, float threads, float grid) {
  float wv = weave(uv, vec2(threads), 50.0);
  vec2 g = fract(uv * grid);
  float line = max(1.0 - smoothstep(0.0, 0.06, min(g.x, 1.0 - g.x)), 1.0 - smoothstep(0.0, 0.06, min(g.y, 1.0 - g.y)));
  return wv * 0.7 + line * 0.35;
}
`;

export const cloth_multicam: MatDef = {
  surface: 'fabric', tile: 0.6, depth: 0.0012, mapping: 'object', wear: 0.3, dust: 0.25, macro: 0.05, cavity: 0.7, physical: true,
  edge: [0.45, 0.4, 0.32, 0.95],
  setup: (m) => sheen(m, 0.35, 0.75),
  glsl: RIPSTOP + /* glsl */ `
float blob(vec2 uv, float F, float t, float s) {
  vec2 q = uv + warp(uv, F * 0.5, 3, 0.35 / F, s + 1.0);
  float n = fbm(q, vec2(F), 4, 0.45, s) * 0.5 + 0.5;
  return smoothstep(t, t + 0.03, n);
}
void gen(vec2 uv, inout Surf s) {
  vec3 tan_ = srgb(vec3(184, 168, 132));
  vec3 green = srgb(vec3(132, 132, 96));
  vec3 brown = srgb(vec3(140, 116, 86));
  vec3 midGreen = srgb(vec3(118, 122, 84));
  vec3 dBrown = srgb(vec3(100, 80, 60));
  vec3 dGreen = srgb(vec3(82, 90, 62));
  vec3 cream = srgb(vec3(214, 204, 176));
  float grad = fbm(uv, vec2(1.0, 2.0), 3, 0.5, 1.0) * 0.5 + 0.5;
  vec3 col = mix(tan_, green, smoothstep(0.3, 0.7, grad));
  float b1 = blob(uv, 5.0, 0.55, 10.0);
  col = mix(col, mix(brown, midGreen, smoothstep(0.35, 0.65, grad)), b1);
  float b2 = blob(uv + 0.31, 8.0, 0.64, 20.0);
  col = mix(col, mix(dBrown, dGreen, smoothstep(0.4, 0.6, grad + (hash1(floor(uv * 3.0), vec2(3.0), 3.0) - 0.5) * 0.4)), b2);
  // cream twig/branch strokes: thin warped ridges
  vec2 tq = uv + warp(uv, 6.0, 3, 0.03, 30.0);
  float twig = ridged(tq, vec2(6.0, 10.0), 3, 31.0);
  float twigMask = smoothstep(0.55, 0.7, fbm(uv, 4.0, 3, 32.0) * 0.5 + 0.5);
  col = mix(col, cream, smoothstep(0.88, 0.9, twig) * twigMask * (1.0 - b2));
  float w = ripstop(uv, 360.0, 120.0);
  float fade = fbm(uv, 2.0, 3, 40.0) * 0.5 + 0.5;
  col = mix(col, col * 0.9 + srgb(vec3(150, 140, 118)) * 0.12, fade * 0.5);
  col *= 0.86 + 0.2 * w;
  float dirtN = smoothstep(0.55, 0.85, fbm(uv + warp(uv, 3.0, 2, 0.05, 41.0), 4.0, 5, 42.0) * 0.5 + 0.5);
  col = mix(col, col * vec3(0.78, 0.72, 0.64), dirtN * 0.5);
  s.albedo = col;
  s.height = 0.4 + w * 0.4 + fbm(uv, 4.0, 3, 43.0) * 0.1;
  s.rough = 0.88 + (1.0 - w) * 0.08;
  s.mask = clamp((1.0 - w) * 0.4 + dirtN * 0.5, 0.0, 1.0);
}
`,
};

const plainCloth = (rgb: string, faded: string) => RIPSTOP + /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float w = ripstop(uv, 360.0, 120.0);
  float fade = smoothstep(0.35, 0.85, fbm(uv + warp(uv, 3.0, 2, 0.05, 1.0), 3.0, 5, 2.0) * 0.5 + 0.5);
  float dirtN = smoothstep(0.55, 0.85, fbm(uv + warp(uv, 3.0, 2, 0.05, 3.0), 4.0, 5, 4.0) * 0.5 + 0.5);
  float slub = fbm(uv, vec2(3.0, 360.0), 2, 0.5, 5.0) * 0.5 + 0.5;
  vec3 col = mix(srgb(vec3(${rgb})), srgb(vec3(${faded})), fade * 0.6);
  col *= 0.86 + 0.2 * w + 0.05 * (slub - 0.5);
  col = mix(col, col * vec3(0.8, 0.75, 0.68) + srgb(vec3(40, 34, 26)) * 0.3, dirtN * 0.5);
  s.albedo = col;
  s.height = 0.4 + w * 0.4 + fbm(uv, 4.0, 3, 6.0) * 0.1;
  s.rough = 0.88 + (1.0 - w) * 0.08;
  s.mask = clamp((1.0 - w) * 0.4 + dirtN * 0.5, 0.0, 1.0);
}
`;
export const cloth_olive: MatDef = {
  surface: 'fabric', tile: 0.6, depth: 0.0012, mapping: 'object', wear: 0.3, dust: 0.25, macro: 0.05, cavity: 0.7, physical: true,
  edge: [0.2, 0.2, 0.15, 0.95], setup: (m) => sheen(m, 0.3, 0.75), glsl: plainCloth('82, 84, 62', '112, 112, 88'),
};
export const cloth_black: MatDef = {
  surface: 'fabric', tile: 0.6, depth: 0.0012, mapping: 'object', wear: 0.3, dust: 0.3, macro: 0.05, cavity: 0.7, physical: true,
  edge: [0.07, 0.07, 0.07, 0.95], setup: (m) => sheen(m, 0.22, 0.7), glsl: plainCloth('30, 30, 32', '54, 54, 56'),
};

export const glove_leather: MatDef = {
  surface: 'fabric', tile: 0.15, depth: 0.0006, mapping: 'object', wear: 0.3, macro: 0.04, cavity: 1.0, physical: true,
  edge: [0.3, 0.22, 0.14, 0.5], setup: (m) => sheen(m, 0.12, 0.5),
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec4 v = voronoiT(uv + warp(uv, 8.0, 2, 0.006, 1.0), 55.0, 0.9, 2.0);      // pebble grain
  float peb = sqrt(smoothstep(0.0, 0.35, v.x));
  vec4 v2 = voronoiT(uv, 150.0, 0.9, 3.0);
  float fine = sqrt(smoothstep(0.0, 0.3, v2.x));
  float crease = ridged(uv + warp(uv, 3.0, 2, 0.04, 4.0), vec2(3.0, 8.0), 4, 5.0);
  float creaseL = smoothstep(0.8, 0.97, crease);
  float polish = smoothstep(0.45, 0.8, fbm(uv, 3.0, 4, 6.0) * 0.5 + 0.5);
  float dirtN = smoothstep(0.5, 0.85, fbm(uv, 5.0, 4, 7.0) * 0.5 + 0.5);
  vec3 col = mix(srgb(vec3(132, 100, 70)), srgb(vec3(158, 122, 86)), v.y * 0.5 + polish * 0.4);
  col *= 0.85 + 0.2 * peb;
  col *= 1.0 - creaseL * 0.18;
  col = mix(col, col * vec3(0.8, 0.76, 0.7), dirtN * 0.3);
  s.albedo = col;
  s.height = 0.4 + peb * 0.35 + fine * 0.1 - creaseL * 0.35;
  s.rough = clamp(0.62 - polish * 0.18 + (1.0 - peb) * 0.12 + creaseL * 0.1, 0.0, 1.0);
  s.mask = clamp((1.0 - peb) * 0.5 + creaseL * 0.5 + dirtN * 0.4, 0.0, 1.0);
}
`,
};

export const skin: MatDef = {
  surface: 'flesh', tile: 0.12, depth: 0.00025, mapping: 'object', wear: 0.0, macro: 0.05, cavity: 0.6, physical: true,
  setup: (m) => sheen(m, 0.12, 0.45),
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec3 pore = spots(uv, 140.0, 0.8, 0.12, 0.28, 1.0);
  vec3 pore2 = spots(uv + 0.5, 260.0, 0.6, 0.12, 0.25, 2.0);
  float wr1 = fbm(uv, vec2(40.0, 240.0), 3, 0.5, 3.0);
  float wr2 = fbm(uv, vec2(240.0, 40.0), 3, 0.5, 4.0);
  float lines = min(1.0 - abs(wr1), 1.0 - abs(wr2));
  float blotch = fbm(uv + warp(uv, 3.0, 2, 0.05, 5.0), 4.0, 5, 6.0) * 0.5 + 0.5;
  vec3 frk = spots(uv, 30.0, 0.25, 0.1, 0.3, 7.0);
  vec3 col = mix(srgb(vec3(186, 134, 104)), srgb(vec3(196, 124, 100)), smoothstep(0.4, 0.8, blotch) * 0.6);
  col = mix(col, srgb(vec3(150, 100, 76)), frk.x * 0.4);
  col *= 1.0 - pore.x * 0.08;
  s.albedo = col;
  s.height = 0.6 - pore.x * 0.35 - pore2.x * 0.15 - smoothstep(0.9, 1.0, lines) * 0.1;
  s.rough = clamp(0.48 + blotch * 0.1 + pore.x * 0.12, 0.0, 1.0);
  s.mask = pore.x * 0.3;
}
`,
};

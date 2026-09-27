import type { MatDef } from './types';

export const asphalt: MatDef = {
  surface: 'asphalt', tile: 4.0, depth: 0.006, stochastic: true, wear: 0.3, dust: 0.3, macro: 0.08, cavity: 0.9,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  // aggregate: stones 4-12mm (texel ~4mm at 1024)
  vec4 ag = worleyT(uv, 420.0, 1.0, 1.0);
  float stone = smoothstep(0.5, 0.25, ag.x) * step(0.45, ag.z);
  vec4 ag2 = worleyT(uv, 180.0, 1.0, 2.0);
  float bigStone = smoothstep(0.5, 0.2, ag2.x) * step(0.72, ag2.z);
  float fines = fbm(uv, 700.0, 2, 3.0) * 0.5 + 0.5;
  // wear: binder eroded in wheel paths / macro areas exposes stones
  float worn = smoothstep(0.35, 0.75, fbm(uv + warp(uv, 2.0, 3, 0.08, 4.0), 3.0, 5, 5.0) * 0.5 + 0.5);
  // long cracks + fine alligator crazing in a few zones
  float crL = cracks(uv, 5.0, 0.008, 0.5, 9.0);
  vec2 cq = uv + warp(uv, 6.0, 3, 0.012, 6.0);
  vec4 vc = voronoiT(cq, 30.0, 0.85, 7.0);
  float crackZone = smoothstep(0.62, 0.75, fbm(uv, 3.0, 4, 8.0) * 0.5 + 0.5);
  float allig = (1.0 - smoothstep(0.0, 0.02 + 0.03 * fines, vc.x)) * crackZone * smoothstep(0.35, 0.6, noiseT(uv, 60.0, 19.0) * 0.5 + 0.5);
  float cr = max(allig * 0.8, crL);
  // tar-sealed crack lines (glossy, narrow, slightly raised)
  float sealN = voronoiT(uv + warp(uv, 3.0, 3, 0.02, 10.0), 4.0, 0.9, 11.0).x;
  float seal = (1.0 - smoothstep(0.006, 0.012, sealN)) * smoothstep(0.5, 0.62, fbm(uv, 4.0, 3, 12.0) * 0.5 + 0.5);
  // repair patches: irregular outline, darker and smoother
  vec2 pw = uv + warp(uv, 4.0, 3, 0.04, 20.0);
  vec2 pc = floor(pw * 3.0); vec3 ph = hash3(pc, vec2(3.0), 13.0);
  vec2 pf = fract(pw * 3.0);
  vec2 pr = abs(pf - 0.5 - (ph.xy - 0.5) * 0.3) - vec2(0.12 + ph.z * 0.12, 0.1 + ph.x * 0.12);
  float patchD = max(pr.x, pr.y) + fbm(uv, 40.0, 3, 14.0) * 0.012;
  float patchM = (1.0 - smoothstep(-0.002, 0.002, patchD)) * step(0.6, ph.z);
  float patchEdge = (1.0 - smoothstep(0.0, 0.01, abs(patchD))) * step(0.6, ph.z);
  // oil / tyre drip stains
  float oil = smoothstep(0.62, 0.85, fbm(uv + warp(uv, 6.0, 2, 0.02, 15.0), 6.0, 5, 16.0) * 0.5 + 0.5);
  vec3 binder = srgb(vec3(70, 69, 67)) * (0.88 + 0.24 * fines);
  vec3 stoneCol = mix(srgb(vec3(96, 93, 88)), srgb(vec3(122, 114, 104)), fract(ag.z * 13.7));
  vec3 col = mix(binder, stoneCol, (stone * (0.25 + 0.5 * worn) + bigStone * 0.55));
  col *= 0.92 + 0.14 * (fbm(uv, 8.0, 4, 18.0) * 0.5 + 0.5);
  col = mix(col, srgb(vec3(56, 55, 54)) * (0.9 + 0.2 * fines), patchM);
  col = mix(col, srgb(vec3(34, 34, 35)), seal);
  col = mix(col, col * vec3(0.62, 0.6, 0.58), oil * 0.6);
  col *= 1.0 - cr * 0.35;
  col *= 1.0 - patchEdge * 0.15;
  col = mix(col, col * 1.12 + 0.01, worn * 0.25 * (1.0 - patchM)); // sun bleached
  s.albedo = col;
  float h = 0.6 + (stone * (0.12 + 0.12 * worn) + bigStone * 0.2) + fines * 0.06 - cr * 0.45;
  h = mix(h, 0.66 + fines * 0.04, patchM);
  h = mix(h, 0.7, seal * 0.9);
  h -= patchEdge * 0.05;
  s.height = h;
  s.rough = clamp(0.84 + fines * 0.08 - seal * 0.4 - oil * 0.3 - patchM * 0.1 - stone * 0.05, 0.0, 1.0);
  s.ao = 1.0 - cr * 0.4;
  s.mask = clamp(cr + (1.0 - stone) * 0.4 * worn + oil * 0.2, 0.0, 1.0);
}
`,
};

export const dirt: MatDef = {
  surface: 'dirt', tile: 3.0, depth: 0.02, stochastic: true, wear: 0.1, dust: 0.1, macro: 0.1, cavity: 1.2,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 wq = uv + warp(uv, 4.0, 4, 0.03, 1.0);
  float big = fbm(wq, 4.0, 6, 2.0) * 0.5 + 0.5;
  float clods = fbm(uv, 64.0, 4, 3.0) * 0.5 + 0.5;
  float grain = fbm(uv, 400.0, 2, 4.0) * 0.5 + 0.5;
  // pebbles
  vec3 pb = spots(uv, 90.0, 0.12, 0.15, 0.45, 5.0);
  vec3 pb2 = spots(uv + 0.23, 220.0, 0.25, 0.2, 0.5, 6.0);
  float peb = pb.x;
  float pebS = pb2.x;
  // dried-mud cracks in low areas
  vec4 vc = voronoiT(uv + warp(uv, 8.0, 2, 0.01, 7.0), 18.0, 0.9, 8.0);
  float dryZone = smoothstep(0.42, 0.3, big) * smoothstep(0.4, 0.6, noiseT(uv, 6.0, 30.0) * 0.5 + 0.5);
  float cr = (1.0 - smoothstep(0.0, 0.03 + 0.03 * clods, vc.x)) * dryZone;
  // scuffs / tracks: directional smears
  float scuff = fbm(uv + warp(uv, 3.0, 2, 0.05, 9.0), vec2(6.0, 48.0), 4, 0.5, 10.0) * 0.5 + 0.5;
  float h = 0.45 + big * 0.25 + clods * 0.12 + grain * 0.05 + scuff * 0.04 - cr * 0.2;
  h = max(h, 0.5 + peb * 0.35 * (0.8 + 0.2 * pb.y));
  h = max(h, 0.45 + pebS * 0.2 + big * 0.2);
  vec3 soil = mix(srgb(vec3(124, 98, 72)), srgb(vec3(156, 128, 96)), big);
  soil *= 0.85 + 0.25 * clods;
  soil = mix(soil, srgb(vec3(96, 76, 58)), smoothstep(0.62, 0.8, 1.0 - big) * 0.5); // damp dark
  soil *= 0.92 + 0.12 * grain;
  vec3 pebCol = mix(srgb(vec3(146, 128, 104)), srgb(vec3(108, 90, 72)), pb.y);
  vec3 col = mix(soil, pebCol, peb * 0.85);
  col = mix(col, mix(srgb(vec3(160, 138, 108)), srgb(vec3(118, 100, 80)), pb2.y), pebS * 0.5);
  col *= 1.0 - cr * 0.2;
  // footprint / tyre scuffs: lighter compacted bands
  col = mix(col, col * 1.08, smoothstep(0.6, 0.8, scuff) * 0.6);
  s.albedo = col;
  s.height = h;
  s.rough = clamp(0.9 + grain * 0.06 - peb * 0.12 - smoothstep(0.62, 0.8, 1.0 - big) * 0.1, 0.0, 1.0);
  s.ao = 1.0;
  s.mask = clamp(cr + (1.0 - big) * 0.4, 0.0, 1.0);
}
`,
};

export const sand: MatDef = {
  surface: 'sand', tile: 3.0, depth: 0.012, stochastic: true, wear: 0.0, dust: 0.0, macro: 0.07, cavity: 0.7,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  // wind ripples: ~8-10cm wavelength, meandering
  vec2 w = warp(uv, 3.0, 4, 0.06, 1.0);
  float ph = (uv.y + w.y + 0.08 * fbm(uv, 2.0, 3, 2.0)) * 30.0 + fbm(uv, vec2(12.0, 6.0), 3, 0.5, 3.0) * 1.5;
  float rip = fract(ph);
  float ripple = smoothstep(0.0, 0.75, rip) * (1.0 - smoothstep(0.75, 1.0, rip)); // asymmetric (lee side steep)
  float ripAmt = smoothstep(0.25, 0.6, fbm(uv, 3.0, 4, 4.0) * 0.5 + 0.5);
  float grain = fbm(uv, 600.0, 2, 5.0) * 0.5 + 0.5;
  float grainC = hash1(floor(uv * 1024.0), vec2(1024.0), 6.0);
  float big = fbm(uv + w, 4.0, 5, 7.0) * 0.5 + 0.5;
  vec3 pb = spots(uv, 120.0, 0.08, 0.2, 0.45, 8.0);
  float h = 0.35 + big * 0.3 + ripple * 0.2 * ripAmt + grain * 0.04;
  h = max(h, 0.45 + big * 0.3 + pb.x * 0.2);
  vec3 c0 = srgb(vec3(206, 178, 134)), c1 = srgb(vec3(186, 156, 114));
  vec3 col = mix(c1, c0, big * 0.7 + ripple * ripAmt * 0.3);
  // dark heavy minerals collect in ripple troughs
  col = mix(col, srgb(vec3(150, 124, 94)), (1.0 - ripple) * ripAmt * 0.3);
  col *= 0.9 + 0.16 * grainC;
  col = mix(col, srgb(vec3(130, 118, 104)), pb.x * 0.7);
  s.albedo = col;
  s.height = h;
  s.rough = 0.92 + grain * 0.06 - grainC * 0.04;
  s.mask = (1.0 - ripple) * 0.3;
}
`,
};

export const gravel: MatDef = {
  surface: 'gravel', tile: 1.2, depth: 0.03, pom: 0.03, wear: 0.1, dust: 0.25, macro: 0.08, cavity: 1.4,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 q = uv + warp(uv, 24.0, 2, 0.004, 1.0);
  vec4 v = voronoiT(q, 44.0, 0.95, 2.0);
  vec4 v2 = voronoiT(uv + 0.5, 110.0, 0.95, 3.0);
  vec4 v3 = voronoiT(uv + 0.25, 23.0, 0.9, 4.0);
  // stones: domes, flattened tops, random size -> border distance threshold
  float sz = 0.08 + 0.12 * fract(v.y * 7.3);
  float st = smoothstep(sz * 0.2, sz + 0.25, v.x);
  float dome = sqrt(st);
  float small = sqrt(smoothstep(0.03, 0.3, v2.x));
  float bigS = sqrt(smoothstep(0.05, 0.35, v3.x)) * step(0.8, v3.y);
  float surf = fbm(uv, 256.0, 3, 5.0) * 0.5 + 0.5;
  float h = max(dome * (0.55 + 0.35 * fract(v.y * 13.1)), small * 0.4);
  h = max(h, bigS * 0.95);
  h += surf * 0.05;
  // colors: limestone greys, tan, few red/dark
  float pick = bigS > 0.01 && bigS * 0.95 >= h - surf * 0.05 - 0.001 ? v3.y : (dome * (0.55 + 0.35 * fract(v.y * 13.1)) >= small * 0.4 ? v.y : v2.y);
  vec3 c = mix(srgb(vec3(170, 164, 152)), srgb(vec3(186, 166, 134)), smoothstep(0.3, 0.6, fract(pick * 3.7)));
  c = mix(c, srgb(vec3(120, 114, 108)), step(0.82, fract(pick * 11.3)));
  c = mix(c, srgb(vec3(150, 108, 84)), step(0.93, fract(pick * 5.1)));
  c *= 0.82 + 0.3 * surf;
  vec3 dirtC = srgb(vec3(110, 94, 76));
  float inGap = 1.0 - smoothstep(0.12, 0.35, h);
  vec3 col = mix(c, dirtC, inGap);
  col *= 0.75 + 0.25 * smoothstep(0.0, 0.6, h);
  s.albedo = col;
  s.height = h;
  s.rough = mix(0.7 + surf * 0.15, 0.95, inGap);
  s.ao = 0.6 + 0.4 * smoothstep(0.0, 0.5, h);
  s.mask = inGap;
}
`,
};

export const grass_dry: MatDef = {
  surface: 'dirt', tile: 2.0, depth: 0.02, stochastic: true, wear: 0.0, dust: 0.1, macro: 0.12, cavity: 1.2,
  glsl: /* glsl */ `
// Dry, sun-bleached grass tufts over dusty soil.
float blades(vec2 uv, float F, float density, float s, out float shade) {
  vec2 p = uv * F; vec2 i = floor(p), f = fract(p);
  float best = 0.0; shade = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y);
    for (int k = 0; k < 3; k++) {
      vec3 h = hash3(i + o, vec2(F), s + float(k) * 3.0);
      if (h.z > density) continue;
      vec2 a = o + h.xy - f;
      float ang = h.z * 40.0 + float(k);
      vec2 dir = vec2(cos(ang), sin(ang));
      float len = 0.8 + 1.2 * fract(h.x * 9.1);
      float t = clamp(dot(-a, dir), 0.0, len);
      vec2 cp = a + dir * t;
      float wdt = 0.07 * (1.0 - t / len * 0.7);
      float d = length(cp);
      float m = 1.0 - smoothstep(wdt * 0.5, wdt, d);
      float hh = m * (0.5 + 0.5 * (1.0 - t / len)) * (0.6 + 0.4 * fract(h.y * 7.7));
      if (hh > best) { best = hh; shade = fract(h.x * 31.7); }
    }
  }
  return best;
}
void gen(vec2 uv, inout Surf s) {
  float big = fbm(uv + warp(uv, 3.0, 3, 0.05, 1.0), 4.0, 5, 2.0) * 0.5 + 0.5;
  float cover = smoothstep(0.3, 0.6, big);
  float grain = fbm(uv, 300.0, 2, 3.0) * 0.5 + 0.5;
  vec3 soil = mix(srgb(vec3(128, 104, 78)), srgb(vec3(152, 128, 96)), grain);
  float sh1, sh2;
  float b1 = blades(uv, 40.0, 0.9 * cover + 0.1, 4.0, sh1);
  float b2 = blades(uv + 0.37, 90.0, 0.95 * cover + 0.15, 5.0, sh2);
  float h = 0.2 + grain * 0.1 + big * 0.1;
  vec3 col = soil;
  vec3 straw = mix(srgb(vec3(186, 164, 110)), srgb(vec3(150, 132, 86)), sh2);
  straw = mix(straw, srgb(vec3(132, 126, 90)), step(0.85, sh2) * 0.6); // few greyish-green
  float hb2 = 0.35 + b2 * 0.45;
  if (b2 > 0.01 && hb2 > h) { h = hb2; col = straw * (0.7 + 0.4 * b2); }
  vec3 straw1 = mix(srgb(vec3(200, 178, 124)), srgb(vec3(160, 140, 96)), sh1);
  float hb1 = 0.45 + b1 * 0.55;
  if (b1 > 0.01 && hb1 > h) { h = hb1; col = straw1 * (0.7 + 0.4 * b1); }
  s.albedo = col;
  s.height = h;
  s.rough = 0.85 + grain * 0.1;
  s.ao = 0.55 + 0.45 * h;
  s.mask = 1.0 - h;
}
`,
};

export const mud: MatDef = {
  surface: 'dirt', tile: 3.0, depth: 0.03, stochastic: true, wear: 0.0, macro: 0.08, cavity: 1.0,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 wq = uv + warp(uv, 3.0, 4, 0.05, 1.0);
  float big = fbm(wq, 3.0, 6, 2.0) * 0.5 + 0.5;
  // tyre ruts along v
  float rx = uv.x + fbm(uv, vec2(2.0, 3.0), 3, 0.5, 3.0) * 0.03;
  float rut = sin(rx * TAU * 3.0);
  float tread = sin(uv.y * TAU * 120.0 + fbm(uv, 8.0, 2, 4.0) * 2.0) * smoothstep(0.6, 0.9, -rut);
  float clods = fbm(uv, 48.0, 4, 5.0) * 0.5 + 0.5;
  float grain = fbm(uv, 360.0, 2, 6.0) * 0.5 + 0.5;
  float h = 0.35 + big * 0.35 + rut * 0.08 + clods * 0.1 + tread * 0.02 + grain * 0.03;
  float water = 0.53;
  float wet = smoothstep(water + 0.08, water, h);
  float puddle = smoothstep(water + 0.005, water - 0.005, h);
  vec3 c = mix(srgb(vec3(96, 78, 60)), srgb(vec3(122, 100, 76)), clods);
  c = mix(c, c * 0.55, wet); // wet darkening
  c = mix(c, srgb(vec3(58, 48, 38)), puddle * 0.7);
  // dried crust on high spots
  float dry = smoothstep(0.62, 0.75, h);
  c = mix(c, srgb(vec3(140, 120, 96)), dry * 0.6);
  s.albedo = c;
  s.height = max(h, water - 0.002 + grain * 0.002 * (1.0 - puddle));
  s.rough = mix(mix(0.8 + grain * 0.1, 0.35, wet), 0.04, puddle);
  s.rough = mix(s.rough, 0.95, dry);
  s.mask = wet * 0.3;
}
`,
};

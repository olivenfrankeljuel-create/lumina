import type { MatDef } from './types';

/** Shared GLSL: board layout + grain. Boards run along x. */
const WOOD_LIB = /* glsl */ `
struct Board { vec2 local; float id; float edgeY; float edgeX; float lenM; };
// rows: boards per tile (across y). tileM: tile size in meters. twoJoints: probability of a second joint.
Board board(vec2 uv, float rows, float tileM, float gapM, float s) {
  Board b;
  float row = floor(uv.y * rows);
  float ry = fract(uv.y * rows);
  vec3 h = hash3(vec2(row, 0.0), vec2(rows, 1.0), s);
  float j0 = h.x;
  float xl = fract(uv.x - j0);
  float j1 = 0.35 + 0.3 * h.y;
  float seg = (h.z > 0.45 && xl > j1) ? 1.0 : 0.0;
  float segStart = seg > 0.5 ? j1 : 0.0;
  float segEnd = (h.z > 0.45 && seg < 0.5) ? j1 : 1.0;
  b.local = vec2((xl - segStart) * tileM, ry * tileM / rows);
  b.lenM = (segEnd - segStart) * tileM;
  b.id = row * 7.0 + seg + 1.0;
  b.edgeY = min(ry, 1.0 - ry) * tileM / rows;       // meters to long edge
  b.edgeX = min(xl - segStart, segEnd - xl) * tileM; // meters to butt joint
  return b;
}
// Grain in tile space (periodic); off = per-board offset. Returns (fiber, rings, knot).
vec3 grain(vec2 uv, vec2 off, float rows, float s) {
  vec2 q = uv + off;
  float w = fbm(q, vec2(2.0, rows * 2.0), 4, 0.5, s) * 0.8 + fbm(q, vec2(1.0, rows), 2, 0.5, s + 5.0) * 1.5;
  float ringCoord = q.y * rows * 5.0 + w * 2.0;
  float rings = fract(ringCoord);
  float late = smoothstep(0.55, 0.8, rings) * (1.0 - smoothstep(0.85, 1.0, rings));
  float fiber = fbm(q, vec2(6.0, rows * 40.0), 3, 0.6, s + 9.0) * 0.35 + fbm(q, vec2(3.0, rows * 120.0), 2, 0.6, s + 19.0) * 0.25 + 0.5;
  return vec3(fiber, late, rings);
}
`;

export const wood_planks: MatDef = {
  surface: 'wood', tile: 2.0, depth: 0.008, pom: 0.008, wear: 0.35, dust: 0.25, macro: 0.08, cavity: 1.2,
  glsl: WOOD_LIB + /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  const float rows = 12.0;          // 16.7cm boards
  Board b = board(uv, rows, 2.0, 0.004, 1.0);
  vec4 bh = hash4(vec3(b.id, 1.0, 2.0));
  vec2 off = vec2(bh.x * 7.0, bh.y * 3.0);
  // knots shift grain
  vec3 g = grain(uv, off, rows, 3.0);
  vec3 kn = spots(uv + off * 0.0 + vec2(bh.z, 0.0), 6.0, 0.35, 0.05, 0.1, 4.0);
  float fiber = g.x, late = g.y;
  float check = (1.0 - smoothstep(0.0, 0.025, abs(fbm(uv + off, vec2(3.0, rows * 3.0), 3, 0.5, 5.0)))) * smoothstep(0.6, 0.85, noiseT(uv + off, vec2(6.0, rows), 6.0) * 0.5 + 0.5);
  float gapY = smoothstep(0.0015, 0.0045, b.edgeY);
  float gapX = smoothstep(0.0005, 0.0025, b.edgeX);
  float edgeRound = smoothstep(0.0, 0.01, b.edgeY) * smoothstep(0.0, 0.006, b.edgeX);
  float cup = (b.local.y / (2.0 / rows) - 0.5); cup = 1.0 - cup * cup * 4.0;   // boards cup
  // nails: two near each butt end
  vec2 nl = vec2(min(b.local.x, b.lenM - b.local.x) - 0.035, abs(b.local.y - 2.0 / rows * 0.5) - 0.045);
  float nd = length(nl);
  float nail = 1.0 - smoothstep(0.0035, 0.0055, nd);
  float nailStain = (1.0 - smoothstep(0.004, 0.012 + 0.006 * fiber, nd));
  float weather = smoothstep(0.3, 0.8, fbm(uv + off * 0.2, vec2(3.0, 6.0), 4, 0.5, 7.0) * 0.5 + 0.5 + bh.w * 0.3 - 0.15);
  vec3 brown = mix(srgb(vec3(122, 92, 64)), srgb(vec3(150, 116, 82)), bh.x);
  vec3 grey = mix(srgb(vec3(132, 124, 112)), srgb(vec3(156, 148, 134)), bh.y);
  vec3 col = mix(brown, grey, weather);
  col *= 0.8 + 0.4 * fiber;
  col *= 1.0 - late * 0.28;
  col = mix(col, col * 0.6, kn.x);
  col *= 1.0 - check * 0.3;
  col = mix(col, srgb(vec3(60, 44, 34)), nailStain * 0.35);
  col = mix(col, vec3(0.2), nail);
  col *= 0.75 + 0.25 * edgeRound;
  float st = streaks(uv, 30.0, 8.0);
  col *= 1.0 - st * 0.12;
  float h = 0.75 + cup * 0.06 + fiber * 0.08 + late * (0.04 + 0.1 * weather) - check * 0.25 + kn.x * 0.04;
  h = mix(0.05, h, gapY * gapX);
  h -= (1.0 - edgeRound) * 0.08;
  h += nail * 0.02;
  s.albedo = mix(srgb(vec3(40, 32, 26)), col, gapY * gapX);
  s.height = h;
  s.rough = clamp(0.78 + fiber * 0.08 + weather * 0.08 - nail * 0.3, 0.0, 1.0);
  s.metal = nail * 0.6;
  s.ao = mix(0.4, 1.0, gapY * gapX);
  s.mask = clamp((1.0 - edgeRound) * 0.7 + check + (1.0 - gapY * gapX) + st * 0.3, 0.0, 1.0);
}
`,
};

export const wood_pallet: MatDef = {
  surface: 'wood', tile: 1.2, depth: 0.004, wear: 0.3, dust: 0.25, macro: 0.07, cavity: 1.0,
  glsl: WOOD_LIB + /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  const float rows = 12.0;          // 10cm slats
  Board b = board(uv, rows, 1.2, 0.002, 11.0);
  vec4 bh = hash4(vec3(b.id, 3.0, 4.0));
  vec2 off = vec2(bh.x * 5.0, bh.y * 2.0);
  vec3 g = grain(uv, off, 8.0, 12.0);
  float fuzz = fbm(uv, 512.0, 2, 13.0) * 0.5 + 0.5;
  // bandsaw marks: slightly curved bands across the grain
  float saw = sin((uv.x + off.x + 0.02 * sin(uv.y * TAU * rows)) * TAU * 90.0 + bh.z * 6.0) * 0.5 + 0.5;
  vec3 kn = spots(uv + vec2(bh.z, bh.w), 5.0, 0.4, 0.04, 0.08, 14.0);
  float edge = smoothstep(0.0, 0.004, b.edgeY) * smoothstep(0.0, 0.003, b.edgeX);
  vec3 col = mix(srgb(vec3(178, 146, 102)), srgb(vec3(196, 168, 124)), bh.x);
  col = mix(col, srgb(vec3(150, 136, 116)), smoothstep(0.6, 0.95, bh.y) * 0.7); // greyed slats
  col *= 0.88 + 0.18 * g.x;
  col *= 1.0 - g.y * 0.15;
  col = mix(col, srgb(vec3(120, 84, 52)), kn.x * 0.8);
  col *= 0.94 + 0.08 * saw;
  float dirtN = smoothstep(0.55, 0.85, fbm(uv, 5.0, 5, 15.0) * 0.5 + 0.5);
  col = mix(col, col * vec3(0.7, 0.66, 0.6), dirtN * 0.6);
  col *= 0.8 + 0.2 * edge;
  s.albedo = col;
  s.height = 0.6 + fuzz * 0.08 + saw * 0.06 + g.x * 0.04 - (1.0 - edge) * 0.3 + kn.x * 0.05;
  s.rough = clamp(0.84 + fuzz * 0.1 - kn.x * 0.1, 0.0, 1.0);
  s.mask = clamp((1.0 - edge) + dirtN * 0.3, 0.0, 1.0);
}
`,
};

export const wood_painted: MatDef = {
  surface: 'wood', tile: 2.0, depth: 0.006, pom: 0.006, wear: 0.3, dust: 0.25, macro: 0.07, cavity: 1.1,
  glsl: WOOD_LIB + /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  const float rows = 14.0;
  Board b = board(uv, rows, 2.0, 0.003, 21.0);
  vec4 bh = hash4(vec3(b.id, 5.0, 6.0));
  vec2 off = vec2(bh.x * 7.0, bh.y * 3.0);
  vec3 g = grain(uv, off, rows, 22.0);
  float gapY = smoothstep(0.001, 0.0035, b.edgeY);
  float gapX = smoothstep(0.0005, 0.002, b.edgeX);
  float edgeRound = smoothstep(0.0, 0.008, b.edgeY) * smoothstep(0.0, 0.005, b.edgeX);
  // paint peels along the grain: anisotropic noise + edges peel first
  float pn = fbm(uv + warp(uv, 6.0, 2, 0.01, 23.0), vec2(8.0, 48.0), 6, 0.55, 24.0) * 0.5 + 0.5;
  float peelZone = smoothstep(0.35, 0.75, fbm(uv, 3.0, 4, 25.0) * 0.5 + 0.5);
  float pv = pn + (1.0 - edgeRound) * 0.25 + g.y * 0.06 + peelZone * 0.18;
  float bare = smoothstep(0.72, 0.725, pv);
  float lift = smoothstep(0.66, 0.72, pv) * (1.0 - bare);     // curling paint edge
  // alligator cracking in remaining paint
  vec4 ac = voronoiT(uv + warp(uv, 20.0, 2, 0.003, 26.0), vec2(40.0, 160.0).x, 0.9, 27.0);
  float craze = (1.0 - smoothstep(0.0, 0.04, ac.x)) * peelZone * (1.0 - bare);
  vec3 paint = mix(srgb(vec3(56, 124, 126)), srgb(vec3(112, 162, 150)), smoothstep(0.3, 0.9, fbm(uv, 4.0, 4, 28.0) * 0.5 + 0.5 + peelZone * 0.2));
  paint *= 0.94 + 0.06 * (fbm(uv, 200.0, 2, 29.0) * 0.5 + 0.5);
  vec3 wood = mix(srgb(vec3(128, 120, 108)), srgb(vec3(112, 90, 68)), bh.z) * (0.85 + 0.2 * g.x) * (1.0 - g.y * 0.2);
  vec3 col = mix(paint, wood, bare);
  col *= 1.0 - craze * 0.35 - lift * 0.1;
  col *= 0.8 + 0.2 * edgeRound;
  float st = streaks(uv, 28.0, 30.0);
  col *= 1.0 - st * 0.15;
  float h = mix(0.8 + lift * 0.06 - craze * 0.1, 0.7 + g.y * 0.06 + g.x * 0.03, bare);
  h = mix(0.05, h, gapY * gapX) - (1.0 - edgeRound) * 0.1;
  s.albedo = mix(srgb(vec3(36, 32, 28)), col, gapY * gapX);
  s.height = h;
  s.rough = clamp(mix(0.62 + peelZone * 0.15, 0.86, bare) + craze * 0.1, 0.0, 1.0);
  s.ao = mix(0.4, 1.0, gapY * gapX);
  s.mask = clamp(bare * 0.5 + craze + (1.0 - edgeRound) + st * 0.3, 0.0, 1.0);
}
`,
};

export const plywood: MatDef = {
  surface: 'wood', tile: 1.22, depth: 0.0015, wear: 0.25, dust: 0.25, macro: 0.06, cavity: 0.8,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  // rotary-cut face veneer: broad wavy figure along x
  vec2 w = warp(uv, 2.0, 4, 0.05, 1.0);
  float fig = fbm(uv + w, vec2(1.0, 6.0), 4, 0.5, 2.0);
  float bands = fract((uv.y + w.y * 0.6) * 9.0 + fig * 1.6);
  float late = smoothstep(0.6, 0.85, bands) * (1.0 - smoothstep(0.9, 1.0, bands));
  float fiber = fbm(uv, vec2(8.0, 220.0), 3, 0.6, 3.0) * 0.5 + 0.5;
  // veneer seams (face made of 2-3 strips)
  float seamX = abs(fract(uv.y * 3.0 + 0.17) - 0.5);
  float seam = 1.0 - smoothstep(0.0, 0.002, abs(seamX - 0.5) * 1.22 / 3.0);
  // football patches
  vec2 pc = fract(uv * vec2(2.0, 3.0)) - 0.5;
  vec3 ph = hash3(floor(uv * vec2(2.0, 3.0)), vec2(2.0, 3.0), 4.0);
  vec2 pp = (pc - (ph.xy - 0.5) * 0.5) * vec2(1.0, 2.2);
  float pd = length(pp * vec2(0.6, 1.0));
  float patchM = (1.0 - smoothstep(0.075, 0.08, pd)) * step(0.55, ph.z);
  float patchEdge = (1.0 - smoothstep(0.0, 0.006, abs(pd - 0.078))) * step(0.55, ph.z);
  vec3 kn = spots(uv, 5.0, 0.3, 0.04, 0.07, 5.0);
  vec3 c0 = srgb(vec3(198, 166, 120)), c1 = srgb(vec3(176, 140, 96));
  vec3 col = mix(c0, c1, late * 0.8 + fig * 0.2);
  col *= 0.9 + 0.14 * fiber;
  col = mix(col, srgb(vec3(206, 176, 128)) * (0.9 + 0.14 * fiber), patchM);
  col = mix(col, srgb(vec3(110, 76, 48)), kn.x * 0.8 * (1.0 - patchM));
  col *= 1.0 - patchEdge * 0.25 - seam * 0.2;
  // water stains (tide rings)
  float wsN = fbm(uv + warp(uv, 3.0, 3, 0.05, 6.0), 3.0, 5, 7.0) * 0.5 + 0.5;
  float ws = smoothstep(0.62, 0.64, wsN) * (1.0 - smoothstep(0.64, 0.7, wsN)) + smoothstep(0.64, 0.8, wsN) * 0.4;
  col = mix(col, col * vec3(0.72, 0.64, 0.56), ws);
  s.albedo = col;
  s.height = 0.6 + fiber * 0.08 + late * 0.1 - patchEdge * 0.3 - seam * 0.3 + kn.x * 0.04;
  s.rough = clamp(0.72 + fiber * 0.1 - late * 0.05 + ws * 0.05, 0.0, 1.0);
  s.mask = clamp(patchEdge + seam + ws * 0.5, 0.0, 1.0);
}
`,
};

export const gun_wood: MatDef = {
  surface: 'wood', tile: 0.35, depth: 0.0006, mapping: 'object', wear: 0.2, macro: 0.03, cavity: 0.6,
  edge: [0.2, 0.12, 0.07, 0.5],
  glsl: /* glsl */ `
// Oiled walnut stock: dense grain, open pores, handling polish.
void gen(vec2 uv, inout Surf s) {
  vec2 w = warp(uv, 2.0, 4, 0.06, 1.0);
  float fig = fbm(uv + w, vec2(2.0, 5.0), 5, 0.5, 2.0);
  float rings = fract((uv.y + w.y) * 14.0 + fig * 2.0);
  float late = smoothstep(0.5, 0.85, rings) * (1.0 - smoothstep(0.9, 1.0, rings));
  float fiber = fbm(uv, vec2(6.0, 180.0), 3, 0.6, 3.0) * 0.5 + 0.5;
  // pores: tiny elongated dark specks
  vec2 pp = uv * vec2(90.0, 360.0);
  vec3 ph = hash3(floor(pp), vec2(90.0, 360.0), 4.0);
  vec2 pf = fract(pp) - ph.xy;
  float pore = (1.0 - smoothstep(0.1, 0.3, length(pf * vec2(0.4, 1.6)))) * step(0.5, ph.z);
  float fleck = smoothstep(0.7, 0.9, fbm(uv, vec2(4.0, 40.0), 4, 0.5, 5.0) * 0.5 + 0.5);
  vec3 dark = srgb(vec3(70, 38, 22)), light = srgb(vec3(122, 72, 40));
  vec3 col = mix(light, dark, late * 0.8 + fig * 0.2 + 0.1);
  col *= 0.88 + 0.2 * fiber;
  col = mix(col, srgb(vec3(150, 96, 56)), fleck * 0.35);
  col *= 1.0 - pore * 0.5;
  float polish = smoothstep(0.4, 0.8, fbm(uv, 3.0, 4, 6.0) * 0.5 + 0.5);
  s.albedo = col;
  s.height = 0.6 + fiber * 0.05 - pore * 0.3 + late * 0.04;
  s.rough = clamp(0.5 - polish * 0.15 + pore * 0.3 + fiber * 0.06, 0.0, 1.0);
  s.mask = pore * 0.5 + (1.0 - polish) * 0.3;
}
`,
};

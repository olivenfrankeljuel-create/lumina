import type { MatDef } from './types';

/** Walls: plaster, concrete, brick. Height 1 = outermost surface. */

export const plaster_white: MatDef = {
  surface: 'plaster', tile: 2.0, depth: 0.012, wear: 0.35, dust: 0.25, macro: 0.06, stochastic: true, cavity: 1.0,
  glsl: /* glsl */ `
// Painted cement render: trowel undulation + diagonal strokes, sand grain, repaired patches, chips, hairline cracks.
void gen(vec2 uv, inout Surf s) {
  vec2 w1 = warp(uv, 4.0, 3, 0.03, 1.0);
  float undul = fbm(uv + w1, 6.0, 4, 2.0);                                   // trowel waviness
  vec2 dq = vec2(uv.x + uv.y, uv.x - uv.y);                                  // diagonal (periodic) frame
  float strokes = fbm(dq + w1, vec2(3.0, 28.0), 3, 0.5, 3.0);                // float strokes
  float grain = fbm(uv, 360.0, 3, 5.0) * 0.5 + 0.5;
  float grainC = fbm(uv, 180.0, 2, 6.0) * 0.5 + 0.5;
  vec3 sp = spots(uv, 240.0, 0.06, 0.15, 0.35, 7.0);                          // sand pits
  float splat = smoothstep(0.58, 0.64, fbm(uv + warp(uv, 16.0, 2, 0.006, 8.0), 40.0, 3, 9.0) * 0.5 + 0.5);
  // repaired patch: crisp outline, flatter, cooler white
  float pN = fbm(uv + warp(uv, 3.0, 4, 0.05, 10.0), 2.0, 6, 11.0) * 0.5 + 0.5;
  float patchM = smoothstep(0.64, 0.642, pN);
  float patchLip = smoothstep(0.625, 0.642, pN) * (1.0 - patchM);
  // chips down to grey render
  float cN = fbm(uv + warp(uv, 8.0, 3, 0.01, 12.0), 7.0, 7, 13.0) * 0.5 + 0.5;
  float chip = smoothstep(0.735, 0.738, cN);
  float chipRim = smoothstep(0.715, 0.735, cN) * (1.0 - chip);
  float cr = max(cracks(uv, 7.0, 0.006, 0.4, 14.0), cracks(uv + 0.37, 16.0, 0.012, 0.3, 15.0) * 0.7);

  float h = 0.6 + undul * 0.12 + strokes * 0.08 + grain * 0.06 + grainC * 0.12 + splat * 0.1 - sp.x * 0.05;
  h = mix(h, 0.73 + undul * 0.05 + grain * 0.04, patchM) + patchLip * 0.04;
  h = mix(h, 0.35 + grainC * 0.12 + grain * 0.08, chip) - cr * 0.3;

  vec3 paint = srgb(vec3(214, 207, 192));
  vec3 col = paint * (0.955 + 0.06 * (fbm(uv, 8.0, 4, 16.0) * 0.5 + 0.5)) * (0.97 + 0.045 * grain);
  col = mix(col, srgb(vec3(204, 202, 194)) * (0.97 + 0.04 * grain), patchM);
  col *= 1.0 - chipRim * 0.08;
  vec3 render = mix(srgb(vec3(146, 140, 128)), srgb(vec3(170, 162, 146)), grainC) * (0.9 + 0.15 * grain);
  col = mix(col, render, chip);
  // dirt: water runs from above, faint yellowing
  float st = streaks(uv, 28.0, 17.0);
  float yell = smoothstep(0.5, 0.9, fbm(uv + w1, 3.0, 5, 18.0) * 0.5 + 0.5);
  col *= mix(vec3(1.0), vec3(0.9, 0.86, 0.78), st * 0.7);
  col *= mix(vec3(1.0), vec3(0.97, 0.94, 0.86), yell);
  col *= 1.0 - cr * 0.25;
  col *= 1.0 - sp.x * 0.05;
  s.albedo = col;
  s.height = h;
  s.rough = clamp(0.84 + grain * 0.08 - patchM * 0.05 + chip * 0.06 + st * 0.04 - splat * 0.04, 0.0, 1.0);
  s.ao = 1.0 - cr * 0.3;
  s.mask = clamp(cr + chip * 0.6 + sp.x * 0.5 + st * 0.3 + (1.0 - grain) * 0.2, 0.0, 1.0);
}
`,
};

export const plaster_worn: MatDef = {
  surface: 'plaster', tile: 2.5, depth: 0.018, pom: 0.018, wear: 0.5, dust: 0.3, macro: 0.08, cavity: 1.2,
  glsl: /* glsl */ `
// Ochre render with large areas fallen off, exposing brick underneath.
void gen(vec2 uv, inout Surf s) {
  // bricks underneath: 10 x 32 per tile (25cm x 7.8cm)
  vec2 bp = uv * vec2(10.0, 32.0);
  float row = floor(bp.y);
  bp.x += mod(row, 2.0) * 0.5;
  vec2 bc = floor(bp), bf = fract(bp);
  vec3 bh = hash3(bc, vec2(10.0, 32.0), 3.0);
  vec2 dm = min(bf, 1.0 - bf) * vec2(0.25, 0.078);
  float de = min(dm.x, dm.y) + noiseT(uv, 160.0, 4.0) * 0.0015;
  float brick = smoothstep(0.004, 0.009, de);
  vec3 brickCol = mix(srgb(vec3(150, 92, 64)), srgb(vec3(178, 128, 88)), bh.x) * (0.8 + 0.3 * (fbm(uv, 64.0, 3, 5.0) * 0.5 + 0.5));
  vec3 mortar = srgb(vec3(150, 140, 122)) * (0.85 + 0.25 * (fbm(uv, 200.0, 2, 6.0) * 0.5 + 0.5));
  vec3 under = mix(mortar, brickCol, brick);
  float underH = 0.1 + brick * (0.12 + bh.y * 0.04) + fbm(uv, 180.0, 3, 7.0) * 0.03;

  // plaster coverage
  vec2 wq = uv + warp(uv, 3.0, 5, 0.08, 10.0);
  float cov = fbm(wq, 3.0, 7, 11.0) * 0.5 + 0.5;
  float holeT = 0.35;
  float hole = 1.0 - smoothstep(holeT - 0.01, holeT + 0.002, cov);
  float rim = smoothstep(holeT - 0.01, holeT + 0.06, cov) * (1.0 - smoothstep(holeT + 0.06, holeT + 0.12, cov));
  // scratch coat remains around holes (grey render)
  float scratch = (1.0 - smoothstep(holeT + 0.015, holeT + 0.04, cov)) * (1.0 - hole);

  float grain = fbm(uv, 300.0, 3, 12.0) * 0.5 + 0.5;
  float knock = smoothstep(0.5, 0.65, fbm(uv + warp(uv, 8.0, 2, 0.01, 13.0), 30.0, 4, 14.0) * 0.5 + 0.5);
  float cr = cracks(uv, 6.0, 0.008, 0.45, 15.0);
  float plasterH = 0.82 + knock * 0.06 + grain * 0.05 - cr * 0.3;
  float scratchH = 0.55 + grain * 0.12 + fbm(uv, 60.0, 3, 16.0) * 0.05;

  vec3 paint = srgb(vec3(196, 170, 128));
  paint *= 0.9 + 0.14 * (fbm(uv, 8.0, 5, 17.0) * 0.5 + 0.5);
  // faded / chalky paint and sun bleaching
  float fade = fbm(uv + warp(uv, 4.0, 3, 0.04, 18.0), 5.0, 5, 19.0) * 0.5 + 0.5;
  paint = mix(paint, srgb(vec3(214, 200, 172)), smoothstep(0.45, 0.8, fade) * 0.6);
  vec3 scratchCol = srgb(vec3(160, 152, 138)) * (0.85 + 0.25 * grain);
  vec3 col = paint * (0.95 + 0.05 * knock);
  col = mix(col, scratchCol, scratch);
  col = mix(col, under, hole);
  // dirt streaks and stains
  float st = streaks(uv, 24.0, 20.0);
  col *= 1.0 - st * 0.22;
  col *= 1.0 - rim * 0.1;
  col *= 1.0 - cr * 0.3;
  float h = mix(mix(plasterH, scratchH, scratch), underH, hole);
  s.albedo = col;
  s.height = h;
  s.rough = mix(mix(0.84 + grain * 0.08, 0.92, scratch), 0.9, hole) + st * 0.03;
  s.ao = 1.0 - hole * 0.25 * (1.0 - brick);
  s.mask = clamp(hole * 0.7 + rim * 0.5 + cr + st * 0.4, 0.0, 1.0);
}
`,
};

const CONCRETE_GLSL = /* glsl */ `
// Cast-in-place concrete: formwork seams, tie holes with rust runs, bug holes, pour lines, water stains.
void gen(vec2 uv, inout Surf s) {
  float grain = fbm(uv, 480.0, 3, 1.0) * 0.5 + 0.5;
  float sand = fbm(uv, 160.0, 3, 2.0) * 0.5 + 0.5;
  // bug holes (air voids)
  vec3 bug = spots(uv, 90.0, 0.035, 0.08, 0.3, 3.0);
  vec3 bug2 = spots(uv + 0.5, 260.0, 0.06, 0.12, 0.35, 4.0);
  float voids = max(bug.x, bug2.x * 0.7);
  // formwork: plywood panel seams every half tile horizontally and vertically (1.2m)
  vec2 pf = fract(uv * 2.0);
  vec2 pd = min(pf, 1.0 - pf) * 1.2; // meters to seam
  float seamV = 1.0 - smoothstep(0.0, 0.004, pd.x);
  float seamH = 1.0 - smoothstep(0.0, 0.004, pd.y);
  float seamFin = max(seamV, seamH);
  // subtle plywood grain imprint in each panel
  float ply = fbm(uv + warp(uv, 4.0, 2, 0.02, 5.0), vec2(6.0, 120.0), 4, 0.55, 6.0);
  // tie holes: 2 x 2 grid per panel
  vec2 tp = fract(uv * 4.0) - 0.5;
  float tr = length(tp * 0.6); // meters
  float tie = 1.0 - smoothstep(0.011, 0.014, tr);
  float tieRim = (1.0 - smoothstep(0.014, 0.022, tr)) * (1.0 - tie);
  // rust / water run below tie holes
  float below = (1.0 - smoothstep(0.004, 0.018 + 0.01 * (noiseT(uv, vec2(40.0, 4.0), 7.0) * 0.5 + 0.5), abs(tp.x * 0.6 + noiseT(uv, vec2(8.0, 16.0), 8.0) * 0.004)))
    * step(tp.y, 0.0) * (1.0 - smoothstep(0.0, 0.08 + 0.1 * hash1(floor(uv * 4.0), vec2(4.0), 9.0), -tp.y * 0.6));
  // pour lines (lifts) : horizontal bands of color change
  float lift = noiseT(vec2(uv.x * 0.0, uv.y), vec2(1.0, 6.0), 10.0) * 0.5 + 0.5;
  // big mottling
  float mott = fbm(uv + warp(uv, 3.0, 3, 0.05, 11.0), 4.0, 6, 12.0) * 0.5 + 0.5;
  float cr = cracks(uv, 5.0, 0.006, 0.35, 13.0);
  float st = streaks(uv, 30.0, 14.0);
  float drip = streaks(uv + 0.31, 60.0, 15.0);

  float orange = fbm(uv, 64.0, 3, 17.0) * 0.5 + 0.5;
  float h = 0.6 + sand * 0.08 + grain * 0.04 + orange * 0.1 + ply * 0.08 - voids * 0.35 + seamFin * 0.08 + fbm(uv, 5.0, 3, 16.0) * 0.1;
  h -= tie * 0.25 - tieRim * 0.03;
  h -= cr * 0.3;

  vec3 base = srgb(vec3(152, 146, 134));
  vec3 col = base * (0.9 + 0.16 * mott) * (0.96 + 0.06 * lift);
  col *= 0.94 + 0.1 * sand;
  col = mix(col, srgb(vec3(172, 166, 154)), smoothstep(0.6, 0.9, grain) * 0.35); // light aggregate fines
  col *= 1.0 - voids * 0.12;
  vec3 plug = srgb(vec3(128, 124, 116)) * (0.85 + 0.2 * sand);
  col = mix(col, plug, tie);
  col *= 1.0 - tieRim * 0.12;
  col = mix(col, srgb(vec3(120, 92, 70)), below * 0.3);
  // per-panel tone (each formwork pour slightly different)
  vec3 panelH = hash3(floor(uv * 2.0), vec2(2.0), 17.0);
  col *= 0.95 + 0.1 * panelH.x;
  col = mix(col, col * vec3(1.03, 1.0, 0.95), panelH.y * 0.5);
  col *= 1.0 - st * 0.18 - drip * 0.1;
  col *= 1.0 - cr * 0.3;
  col *= 1.0 - seamFin * 0.06;

#ifdef DIRTY
  // soot / smoke blackening, oil & damp stains, spalled patches
  float soot = smoothstep(0.45, 0.85, fbm(uv + warp(uv, 3.0, 4, 0.08, 30.0), 3.0, 6, 31.0) * 0.5 + 0.5);
  float damp = smoothstep(0.5, 0.8, fbm(uv + warp(uv, 4.0, 3, 0.05, 32.0), vec2(4.0, 2.0), 5, 0.5, 33.0) * 0.5 + 0.5);
  float spallN = fbm(uv + warp(uv, 6.0, 3, 0.03, 34.0), 6.0, 6, 35.0) * 0.5 + 0.5;
  float spall = smoothstep(0.7, 0.705, spallN);
  float spallRim = smoothstep(0.68, 0.7, spallN) * (1.0 - spall);
  float cr2 = cracks(uv + 0.5, 9.0, 0.01, 0.45, 36.0);
  vec3 agg = mix(srgb(vec3(130, 124, 112)), srgb(vec3(168, 156, 136)), step(0.5, worleyT(uv, 160.0, 1.0, 37.0).z));
  col = mix(col, agg * (0.8 + 0.3 * sand), spall);
  col *= 1.0 - spallRim * 0.2;
  col = mix(col, col * vec3(0.42, 0.4, 0.38), soot * 0.75);
  col = mix(col, col * vec3(0.72, 0.7, 0.66), damp * 0.5);
  col = mix(col, col * 0.75, st * 0.5);
  col *= 1.0 - cr2 * 0.3;
  h -= spall * (0.3 + 0.1 * sand) + cr2 * 0.3;
  cr = max(cr, cr2);
  voids = max(voids, spall * 0.5);
#endif
  s.albedo = col;
  s.height = h;
  s.rough = clamp(0.84 + grain * 0.08 - drip * 0.05 + voids * 0.08 + below * 0.04, 0.0, 1.0);
  s.ao = 1.0 - tie * 0.25;
  s.mask = clamp(voids + cr + st * 0.5 + tie * 0.5 + seamFin * 0.5, 0.0, 1.0);
}
`;

export const concrete: MatDef = {
  surface: 'concrete', tile: 2.4, depth: 0.01, wear: 0.35, dust: 0.25, macro: 0.08, cavity: 1.0,
  glsl: CONCRETE_GLSL,
};

export const concrete_dirty: MatDef = {
  surface: 'concrete', tile: 2.4, depth: 0.008, wear: 0.6, dust: 0.3, macro: 0.1, cavity: 1.2,
  glsl: '#define DIRTY\n' + CONCRETE_GLSL,
};

export const concrete_floor: MatDef = {
  surface: 'concrete', tile: 4.0, depth: 0.004, wear: 0.3, dust: 0.35, macro: 0.08, cavity: 1.0,
  glsl: /* glsl */ `
// Troweled slab: saw-cut joints every 4m, power-trowel swirls, exposed aggregate wear, stains, cracks.
void gen(vec2 uv, inout Surf s) {
  float grain = fbm(uv, 700.0, 2, 1.0) * 0.5 + 0.5;
  float sand = fbm(uv, 240.0, 3, 2.0) * 0.5 + 0.5;
  // saw cut joints on tile borders (6mm wide, 4m pitch)
  vec2 e = min(uv, 1.0 - uv) * 4.0;
  float joint = 1.0 - smoothstep(0.002, 0.004, min(e.x, e.y));
  float jointEdge = (1.0 - smoothstep(0.004, 0.012, min(e.x, e.y))) * (1.0 - joint);
  // power trowel swirl marks: arcs from overlapping circles
  vec4 tw = worleyT(uv, 7.0, 0.8, 3.0);
  float arcs = sin(tw.x * 90.0 + fbm(uv, 16.0, 2, 4.0) * 3.0) * 0.5 + 0.5;
  float swirl = arcs * smoothstep(0.1, 0.5, tw.x) * 0.6;
  // traffic wear exposing fine aggregate
  float wearN = smoothstep(0.4, 0.8, fbm(uv + warp(uv, 2.0, 3, 0.1, 5.0), 3.0, 5, 6.0) * 0.5 + 0.5);
  vec4 ag = worleyT(uv, 300.0, 1.0, 7.0);
  float aggr = smoothstep(0.5, 0.2, ag.x) * step(0.45, ag.z) * wearN;
  float cr = cracks(uv, 4.0, 0.004, 0.4, 8.0);
  float oil = smoothstep(0.6, 0.78, fbm(uv + warp(uv, 5.0, 2, 0.03, 9.0), 5.0, 5, 10.0) * 0.5 + 0.5);
  float rustSt = smoothstep(0.7, 0.85, fbm(uv, 7.0, 5, 11.0) * 0.5 + 0.5);
  float mott = fbm(uv + warp(uv, 3.0, 3, 0.05, 12.0), 5.0, 6, 13.0) * 0.5 + 0.5;
  float blot = fbm(uv + warp(uv, 6.0, 3, 0.02, 30.0), 10.0, 6, 31.0) * 0.5 + 0.5;
  float speckD = spots(uv, 400.0, 0.3, 0.2, 0.45, 32.0).x;
  vec3 col = srgb(vec3(152, 147, 136)) * (0.8 + 0.32 * mott) * (0.93 + 0.12 * sand);
  col = mix(col, col * vec3(0.84, 0.82, 0.8), smoothstep(0.5, 0.75, blot) * 0.7);  // damp / dirt blotches
  col *= 1.0 - speckD * 0.15;
  col *= 1.0 - swirl * 0.06;
  col = mix(col, mix(srgb(vec3(120, 114, 104)), srgb(vec3(176, 166, 148)), ag.z), aggr * 0.8);
  col = mix(col, col * vec3(0.5, 0.48, 0.46), oil * 0.75);
  col = mix(col, srgb(vec3(126, 90, 60)), rustSt * 0.35);
  col *= 1.0 - cr * 0.35;
  col = mix(col, srgb(vec3(88, 82, 74)), joint);
  col *= 1.0 - jointEdge * 0.1;
  s.albedo = col;
  s.height = 0.7 + sand * 0.04 + grain * 0.03 + swirl * 0.04 + aggr * 0.05 - cr * 0.3 - joint * 0.6 - jointEdge * 0.05;
  s.rough = clamp(0.72 + grain * 0.08 + sand * 0.05 - swirl * 0.12 - wearN * 0.1 + aggr * 0.1 - oil * 0.35 + rustSt * 0.05, 0.0, 1.0);
  s.ao = 1.0 - joint * 0.5;
  s.mask = clamp(cr + joint + jointEdge * 0.5 + oil * 0.3 + (1.0 - sand) * 0.2, 0.0, 1.0);
}
`,
};

export const brick_tan: MatDef = {
  surface: 'brick', tile: 1.92, depth: 0.012, pom: 0.012, wear: 0.35, dust: 0.3, macro: 0.07, cavity: 1.2,
  glsl: /* glsl */ `
// Weathered yellow/tan clay brick (24 x 7 cm), near-flush sandy mortar, eroded arrises.
void gen(vec2 uv, inout Surf s) {
  vec2 N = vec2(8.0, 24.0);
  vec2 bp = uv * N;
  float row = floor(bp.y);
  bp.x += mod(row, 2.0) * 0.5;
  vec2 bc = floor(bp);
  vec2 bf = fract(bp);
  vec4 bh = hash4(vec3(mod(bc.x, N.x), row, 5.0));
  vec2 size = vec2(0.24, 0.08);
  vec2 d2 = min(bf, 1.0 - bf) * size;
  float erosion = fbm(uv, 48.0, 4, 1.0) * 0.0025 + fbm(uv, 300.0, 2, 2.0) * 0.0007;
  float d = min(d2.x, d2.y) - 0.006 + erosion;
  float cornerD = length(max(vec2(0.014) - min(bf, 1.0 - bf) * size, 0.0));
  float cornerChip = step(0.011, cornerD + (fbm(uv, 90.0, 3, 13.0) * 0.5 + 0.5) * 0.006 - 0.003) * step(0.6, bh.z);
  d = min(d, mix(d, -0.002, cornerChip));
  float brick = smoothstep(-0.0005, 0.0008, d);
  float rnd = smoothstep(0.0, 0.007, d);
  float face = fbm(uv, 80.0, 4, 3.0) * 0.5 + 0.5;
  float sandN = fbm(uv, 500.0, 2, 4.0) * 0.5 + 0.5;
  float pits = spots(uv, 160.0, 0.1, 0.1, 0.3, 5.0).x;
  float erodeFace = smoothstep(0.6, 0.64, fbm(uv + warp(uv, 10.0, 2, 0.01, 6.0), 12.0, 5, 7.0) * 0.5 + 0.5 + (bh.z - 0.5) * 0.3);
  float tilt = (bf.x - 0.5) * (bh.y - 0.5) * 0.06 + (bf.y - 0.5) * (bh.x - 0.5) * 0.04;
  float bH = 0.72 + (bh.y - 0.5) * 0.08 + tilt + face * 0.06 + sandN * 0.03 - pits * 0.08 - erodeFace * 0.12;
  bH = mix(0.45, bH, rnd);
  float mN = fbm(uv, 220.0, 3, 8.0) * 0.5 + 0.5;
  float mH = 0.42 + mN * 0.1;
  float h = mix(mH, bH, brick);
  vec3 b0 = srgb(vec3(196, 164, 118)), b1 = srgb(vec3(178, 138, 94)), b2 = srgb(vec3(208, 184, 142));
  vec3 bcol = mix(b0, b1, bh.x);
  bcol = mix(bcol, b2, smoothstep(0.7, 1.0, bh.z));
  if (bh.w > 0.94) bcol = srgb(vec3(160, 112, 78));
  bcol *= 0.86 + 0.22 * (fbm(uv + bh.xy, 20.0, 4, 9.0) * 0.5 + 0.5);
  bcol *= 0.94 + 0.08 * sandN;
  bcol = mix(bcol, bcol * 1.06, erodeFace);
  bcol *= 1.0 - pits * 0.1;
  bcol *= 0.9 + 0.1 * sin(bf.x * PI);                // fire flashing: darker ends
  bcol *= 1.0 - (1.0 - smoothstep(0.0, 0.03, d)) * 0.12; // grimy arrises
  vec3 mcol = srgb(vec3(184, 170, 146)) * (0.82 + 0.25 * mN);
  vec3 col = mix(mcol, bcol, brick);
  col *= 0.9 + 0.1 * rnd;
  float st = streaks(uv, 24.0, 10.0);
  col *= 1.0 - st * 0.18;
  float soot = smoothstep(0.65, 0.9, fbm(uv + warp(uv, 3.0, 3, 0.05, 11.0), 3.0, 5, 12.0) * 0.5 + 0.5);
  col = mix(col, col * vec3(0.66, 0.62, 0.58), soot * 0.5);
  s.albedo = col;
  s.height = h;
  s.rough = mix(0.94, 0.84 + face * 0.08 + erodeFace * 0.04, brick);
  s.ao = mix(0.8, 1.0, rnd);
  s.mask = clamp((1.0 - brick) * 0.8 + (1.0 - rnd) * 0.3 + st * 0.3 + pits * 0.4, 0.0, 1.0);
}
`,
};

export const brick_red: MatDef = {
  surface: 'brick', tile: 1.8, depth: 0.014, pom: 0.014, wear: 0.3, dust: 0.25, macro: 0.06, cavity: 0.8,
  glsl: /* glsl */ `
// Running-bond red clay brick, 21.5 x 6.5 cm, 1 cm recessed mortar. 8 x 24 bricks per 1.8m tile.
void gen(vec2 uv, inout Surf s) {
  vec2 N = vec2(8.0, 24.0);
  vec2 bp = uv * N;
  float row = floor(bp.y);
  bp.x += mod(row, 2.0) * 0.5;
  vec2 bc = floor(bp);
  vec2 bf = fract(bp);
  vec2 cellId = vec2(mod(bc.x, N.x), row);
  vec4 bh = hash4(vec3(cellId, 3.0));
  // distances to brick edge in meters
  vec2 size = vec2(0.225, 0.075);
  vec2 d2 = min(bf, 1.0 - bf) * size;
  float edgeNoise = fbm(uv, 48.0, 3, 4.0) * 0.0006 + fbm(uv, 480.0, 2, 5.0) * 0.0005;
  float d = min(d2.x - 0.005, d2.y - 0.005) + edgeNoise + (bh.w - 0.5) * 0.001;
  float cornerD = length(max(vec2(0.014) - min(bf, 1.0 - bf) * size, 0.0));
  float cornerChip = step(0.011, cornerD + (fbm(uv, 90.0, 3, 16.0) * 0.5 + 0.5) * 0.006 - 0.003) * step(0.55, bh.z);
  d = min(d, mix(d, -0.002, cornerChip));
  float brick = smoothstep(-0.0005, 0.0005, d);
  float rnd = smoothstep(0.0, 0.006, d);
  // brick face
  vec2 lp = bf * size; // local meters
  float face = fbm(uv, 90.0, 4, 6.0) * 0.5 + 0.5;
  float pits = spots(uv, 180.0, 0.12, 0.1, 0.3, 7.0).x;
  float spall = smoothstep(0.7, 0.705, fbm(uv + warp(uv, 16.0, 2, 0.01, 8.0), 16.0, 5, 9.0) * 0.5 + 0.5 + (bh.z - 0.5) * 0.2);
  vec3 speck = spots(uv, 420.0, 0.25, 0.15, 0.4, 18.0);
  float tilt = (bf.x - 0.5) * (bh.y - 0.5) * 0.08 + (bf.y - 0.5) * (bh.x - 0.5) * 0.05;
  float sandF = fbm(uv, 300.0, 2, 17.0) * 0.5 + 0.5;
  float brickH = 0.78 + (bh.y - 0.5) * 0.12 + tilt + face * 0.07 + sandF * 0.06 - pits * 0.06 - spall * (0.12 + 0.04 * sandF) - speck.x * 0.03;
  brickH = mix(0.4, brickH, rnd);
  // mortar: recessed, sandy
  float mortarN = fbm(uv, 260.0, 3, 10.0) * 0.5 + 0.5;
  float mortarH = 0.26 + mortarN * 0.1 + fbm(uv, 40.0, 2, 11.0) * 0.05;
  float h = mix(mortarH, brickH, brick);

  // colors
  vec3 c0 = srgb(vec3(148, 66, 46));
  vec3 c1 = srgb(vec3(172, 92, 62));
  vec3 c2 = srgb(vec3(116, 52, 40));
  vec3 bcol = mix(c0, c1, bh.x);
  bcol = mix(bcol, c2, smoothstep(0.75, 1.0, bh.z));
  if (bh.w > 0.93) bcol = srgb(vec3(86, 48, 40)); // over-fired clinker
  // mottling / firing marks within brick
  float mott = fbm(uv + vec2(bh.x, bh.y), 24.0, 4, 12.0) * 0.5 + 0.5;
  bcol *= 0.82 + 0.3 * mott;
  bcol *= 0.94 + 0.1 * face;
  bcol = mix(bcol, bcol * vec3(1.12, 1.08, 1.02), spall);
  bcol *= 1.0 - speck.x * (speck.y > 0.5 ? 0.3 : -0.2);                       // iron spots / sand grains
  bcol *= 0.92 + 0.16 * smoothstep(-0.3, 0.3, (bf.x - 0.5) * (bh.y - 0.5) + (bf.y - 0.5) * (bh.x - 0.5)); // flash
  bcol *= 1.0 - pits * 0.12;
  bcol *= 0.9 + 0.1 * sin(bf.x * PI);
  // edge darkening/soot at brick edges
  bcol *= 0.9 + 0.1 * rnd;
  vec3 mcol = srgb(vec3(178, 170, 154)) * (0.82 + 0.3 * mortarN);
  vec3 col = mix(mcol, bcol, brick);
  // efflorescence (salt) and dirt streaks
  float eff = smoothstep(0.62, 0.9, fbm(uv + warp(uv, 4.0, 3, 0.05, 13.0), 5.0, 6, 14.0) * 0.5 + 0.5) * (0.4 + 0.6 * (1.0 - rnd));
  col = mix(col, srgb(vec3(196, 188, 174)), eff * 0.45);
  float st = streaks(uv, 20.0, 15.0);
  col *= 1.0 - st * 0.2;
  s.albedo = col;
  s.height = h;
  s.rough = mix(0.93, 0.8 + face * 0.1 - bh.y * 0.05 + spall * 0.1 + sandF * 0.05, brick) + eff * 0.04;
  s.ao = mix(0.85, 1.0, rnd);
  s.mask = clamp((1.0 - brick) * 0.9 + (1.0 - rnd) * 0.4 + st * 0.3 + pits * 0.5, 0.0, 1.0);
}
`,
};

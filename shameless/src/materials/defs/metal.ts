import type { MatDef } from './types';

/** Painted steel sheet with primer/rust/bare-steel chip layers, rivet seam, scratches and rust runs. */
const paintedSteel = (paint: string, faded: string) => /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec3 paintC = srgb(vec3(${paint}));
  vec3 fadedC = srgb(vec3(${faded}));
  float grain = fbm(uv, 400.0, 2, 1.0) * 0.5 + 0.5;
  float peel = fbm(uv, 180.0, 3, 2.0) * 0.5 + 0.5; // orange peel
  // horizontal seam at v = 0 with a rivet row 12mm above it (tile 1.5m -> rivets every 7.5cm)
  float vy = (uv.y > 0.5 ? uv.y - 1.0 : uv.y) * 1.5;   // signed meters from seam
  float dv = abs(vy);
  float rd = length(vec2((fract(uv.x * 20.0) - 0.5) * 0.075, vy - 0.012));
  float rivet = 1.0 - smoothstep(0.0045, 0.0065, rd);
  float rivetDome = sqrt(max(0.0, 1.0 - rd / 0.0065));
  // chips: paint -> primer -> rust -> steel
  vec2 cq = uv + warp(uv, 12.0, 3, 0.006, 3.0);
  float cn = fbm(cq, 10.0, 7, 4.0) * 0.5 + 0.5;
  float wearZone = smoothstep(0.45, 0.8, fbm(uv, 3.0, 4, 5.0) * 0.5 + 0.5);
  float t = 0.72 - 0.12 * wearZone;
  float chip = smoothstep(t, t + 0.006, cn);
  float primer = smoothstep(t + 0.01, t + 0.016, cn);
  float rust = smoothstep(t + 0.03, t + 0.05, cn + 0.02 * grain);
  float steel = smoothstep(t + 0.08, t + 0.09, cn);
  // around rivets and seam rust bleeds
  float rustRing = (1.0 - smoothstep(0.006, 0.014, rd)) * smoothstep(0.3, 0.7, noiseT(uv, 40.0, 6.0) * 0.5 + 0.5);
  rust = max(rust, rustRing * 0.8);
  // rust runs below chips / rivets: vertical smear upward-sampled
  float run = 0.0;
  for (int i = 1; i <= 8; i++) {
    vec2 o = vec2(noiseT(uv, vec2(60.0, 4.0), 7.0) * 0.002, float(i) * 0.012);
    float c2 = fbm(cq + o, 10.0, 5, 4.0) * 0.5 + 0.5;
    run += smoothstep(t + 0.03, t + 0.06, c2) * (1.0 - float(i) / 9.0);
  }
  run = clamp(run * 0.35, 0.0, 1.0) * (1.0 - chip);
  run *= smoothstep(0.3, 0.7, noiseT(uv, vec2(40.0, 3.0), 8.0) * 0.5 + 0.5);
  // scratches
  float sc = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = hash1(vec2(float(i), 0.0), vec2(64.0), 9.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 p = uv * vec2(24.0, 24.0);
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 40.0 + fbm(uv, 12.0, 2, 10.0 + float(i)) * 0.4) - 0.5);
    float seg = smoothstep(0.62, 0.8, noiseT(uv + dir * 0.1, vec2(12.0), 11.0 + float(i)) * 0.5 + 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.012, ln)) * seg);
  }
  vec3 pc = mix(paintC, fadedC, smoothstep(0.3, 0.8, fbm(uv + warp(uv, 4.0, 2, 0.05, 12.0), 4.0, 5, 13.0) * 0.5 + 0.5));
  pc *= 0.94 + 0.08 * peel;
  vec3 primerC = srgb(vec3(126, 64, 44));
  vec3 rustC = mix(srgb(vec3(104, 52, 26)), srgb(vec3(150, 82, 40)), fbm(uv, 90.0, 3, 14.0) * 0.5 + 0.5);
  vec3 steelC = vec3(0.52, 0.52, 0.53);
  vec3 col = pc;
  col = mix(col, primerC, primer * (1.0 - rust));
  col = mix(col, rustC, rust);
  col = mix(col, steelC, steel * 0.9);
  col = mix(col, rustC * 0.9, run * 0.75);
  col = mix(col, pc * 1.25 + 0.02, sc * (1.0 - chip) * 0.6);
  col *= 1.0 - (1.0 - rivetDome) * rivet * 0.2;
  float metal = steel * 0.9;
  float h = 0.6 + peel * 0.02 + grain * 0.01 - chip * 0.08 - rust * 0.02 * grain - steel * 0.02 - sc * 0.04;
  h += rivet * rivetDome * 0.35;
  h += (1.0 - smoothstep(0.0, 0.003, dv)) * -0.1;
  s.albedo = col;
  s.height = h;
  s.metal = metal;
  s.rough = clamp(mix(0.5 + peel * 0.06 + wearZone * 0.1, 0.85 + grain * 0.1, rust) - steel * 0.35 + sc * 0.1 + run * 0.15, 0.0, 1.0);
  s.ao = 1.0;
  s.mask = clamp(chip * 0.6 + run + (1.0 - smoothstep(0.0, 0.006, dv)) + rustRing * 0.5, 0.0, 1.0);
}
`;

export const metal_painted_green: MatDef = {
  surface: 'metal', tile: 1.5, depth: 0.0015, wear: 0.25, dust: 0.25, macro: 0.05, cavity: 0.8,
  glsl: paintedSteel('72, 88, 60', '112, 122, 92'),
};
export const metal_painted_blue: MatDef = {
  surface: 'metal', tile: 1.5, depth: 0.0015, wear: 0.25, dust: 0.25, macro: 0.05, cavity: 0.8,
  glsl: paintedSteel('46, 88, 130', '108, 140, 160'),
};

export const metal_rusty: MatDef = {
  surface: 'metal', tile: 1.5, depth: 0.004, wear: 0.2, dust: 0.2, macro: 0.08, cavity: 1.2,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  vec2 q = uv + warp(uv, 6.0, 4, 0.02, 1.0);
  float r1 = fbm(q, 6.0, 7, 2.0) * 0.5 + 0.5;
  float r2 = fbm(uv, 48.0, 4, 3.0) * 0.5 + 0.5;
  float grain = fbm(uv, 420.0, 2, 4.0) * 0.5 + 0.5;
  // pitting
  vec3 pit = spots(uv, 140.0, 0.45, 0.15, 0.45, 5.0);
  vec3 pit2 = spots(uv + 0.3, 50.0, 0.25, 0.2, 0.5, 6.0);
  // flaking scale (voronoi flakes lifting)
  vec4 fl = voronoiT(uv + warp(uv, 12.0, 2, 0.005, 7.0), 30.0, 0.9, 8.0);
  float flakeZone = smoothstep(0.55, 0.75, r1);
  float flake = smoothstep(0.02, 0.08, fl.x) * flakeZone;
  float flakeEdge = (1.0 - smoothstep(0.0, 0.03, fl.x)) * flakeZone;
  // remaining paint islands
  float paintM = smoothstep(0.32, 0.3, r1) * (1.0 - smoothstep(0.6, 0.62, r2));
  vec3 dark = srgb(vec3(72, 40, 24));
  vec3 mid = srgb(vec3(122, 62, 30));
  vec3 orange = srgb(vec3(166, 92, 42));
  vec3 col = mix(dark, mid, smoothstep(0.25, 0.6, r1));
  col = mix(col, orange, smoothstep(0.55, 0.85, r2) * 0.8);
  col *= 0.85 + 0.25 * grain;
  col = mix(col, dark * 0.8, pit.x * 0.7 + pit2.x * 0.5);
  col = mix(col, mid * (0.9 + 0.3 * (fl.y)), flake * 0.5);
  col *= 1.0 - flakeEdge * 0.4;
  vec3 paint = srgb(vec3(86, 96, 78)) * (0.9 + 0.2 * grain);
  col = mix(col, paint, paintM);
  float h = 0.55 + r2 * 0.1 + grain * 0.06 - pit.x * 0.2 - pit2.x * 0.25 + flake * (0.06 + fl.y * 0.06) + paintM * 0.08;
  s.albedo = col;
  s.height = h;
  s.metal = 0.0;
  s.rough = clamp(0.8 + grain * 0.12 - paintM * 0.3 - smoothstep(0.7, 0.9, r2) * 0.1, 0.0, 1.0);
  s.ao = 1.0 - flakeEdge * 0.3;
  s.mask = clamp(pit.x + pit2.x + flakeEdge, 0.0, 1.0);
}
`,
};

export const metal_corrugated: MatDef = {
  surface: 'metal', tile: 1.52, depth: 0.018, pom: 0.016, wear: 0.25, dust: 0.3, macro: 0.08, cavity: 0.6,
  glsl: /* glsl */ `
// Galvanized corrugated sheet, 76mm pitch (20 per tile), vertical corrugations, nail rows, rust runs.
void gen(vec2 uv, inout Surf s) {
  float ph = uv.x * 20.0;
  float prof = 0.5 + 0.5 * cos(ph * TAU);  // 1 at crest
  float grain = fbm(uv, 500.0, 2, 1.0) * 0.5 + 0.5;
  // zinc spangle crystals
  vec4 sp = worleyT(uv, 70.0, 1.0, 2.0);
  float spangle = sp.z;
  // white rust (zinc oxide) and red rust
  vec2 q = uv + warp(uv, 4.0, 3, 0.03, 3.0);
  float ox = smoothstep(0.55, 0.75, fbm(q, 5.0, 6, 4.0) * 0.5 + 0.5);
  // nails: every other crest at v = 0.25 and 0.75
  float cx = (floor(ph) + 0.0) ;
  vec2 np = vec2((fract(ph) - 0.0) , 0.0);
  float ndx = min(fract(ph), 1.0 - fract(ph)) / 20.0 * 1.52;
  float nrow = min(abs(fract(uv.y * 2.0) - 0.5), 1.0) / 2.0 * 1.52;
  float oddCrest = step(0.5, mod(floor(ph + 0.5), 2.0));
  float nd = length(vec2(ndx, nrow));
  float nail = (1.0 - smoothstep(0.004, 0.006, nd)) * oddCrest;
  float nailRust = (1.0 - smoothstep(0.006, 0.02, nd)) * oddCrest;
  // rust runs downward from nails: below the nail row (v decreasing from row)
  float below = fract(uv.y * 2.0) - 0.5; // <0 below row
  float runW = 0.004 + 0.01 * (noiseT(uv, vec2(20.0, 8.0), 5.0) * 0.5 + 0.5);
  float runLen = 0.15 + 0.25 * hash1(vec2(floor(ph + 0.5), floor(uv.y * 2.0)), vec2(20.0, 2.0), 6.0);
  float run = (1.0 - smoothstep(runW * 0.3, runW, ndx + noiseT(uv, vec2(40.0, 16.0), 7.0) * 0.002)) * step(below, 0.0) * (1.0 - smoothstep(0.0, runLen, -below)) * oddCrest;
  run *= 0.5 + 0.5 * (noiseT(uv, vec2(20.0, 60.0), 8.0) * 0.5 + 0.5);
  // general red rust in troughs & overlap bottom edge
  float rustN = fbm(uv + warp(uv, 8.0, 2, 0.01, 9.0), 8.0, 6, 10.0) * 0.5 + 0.5;
  float rust = smoothstep(0.62, 0.75, rustN + (1.0 - prof) * 0.12 + smoothstep(0.08, 0.0, uv.y) * 0.2);
  // streaks from rain
  float st = streaks(uv, 40.0, 11.0);
  vec3 zinc = mix(vec3(0.50, 0.52, 0.53), vec3(0.62, 0.63, 0.64), spangle) * (0.9 + 0.15 * grain);
  vec3 oxC = srgb(vec3(178, 180, 176));
  vec3 rustC = mix(srgb(vec3(112, 58, 30)), srgb(vec3(156, 90, 44)), rustN);
  vec3 col = zinc;
  float metal = 1.0;
  col = mix(col, oxC * (0.85 + 0.2 * grain), ox * 0.8);
  metal = mix(metal, 0.0, ox * 0.8);
  col = mix(col, rustC, max(rust, max(run, nailRust)));
  metal *= 1.0 - max(rust, max(run, nailRust));
  col = mix(col, col * 0.7, st * 0.4);
  col = mix(col, vec3(0.35), nail);
  s.albedo = col;
  s.height = prof * 0.9 + grain * 0.02 + nail * 0.08 - rust * 0.01;
  s.metal = metal;
  s.rough = clamp(0.42 + spangle * 0.12 + grain * 0.1 + ox * 0.35 + rust * 0.4 + st * 0.1, 0.0, 1.0);
  s.ao = 1.0;
  s.mask = clamp((1.0 - prof) * 0.6 + run + st * 0.5, 0.0, 1.0);
}
`,
};

export const metal_bare: MatDef = {
  surface: 'metal', tile: 1.0, depth: 0.0006, wear: 0.15, dust: 0.1, macro: 0.05, cavity: 0.5,
  glsl: /* glsl */ `
void gen(vec2 uv, inout Surf s) {
  float brush = fbm(uv, vec2(3.0, 700.0), 3, 0.6, 1.0) * 0.5 + 0.5;       // rolling / brushing lines
  float grind = fbm(uv + warp(uv, 4.0, 2, 0.05, 2.0), vec2(40.0, 160.0), 3, 0.5, 3.0) * 0.5 + 0.5; // grinder marks
  float smudge = fbm(uv + warp(uv, 6.0, 3, 0.04, 4.0), 6.0, 6, 5.0) * 0.5 + 0.5;
  float rustSp = smoothstep(0.68, 0.8, fbm(uv, 12.0, 6, 6.0) * 0.5 + 0.5);
  vec3 pit = spots(uv, 200.0, 0.25 * rustSp + 0.02, 0.2, 0.5, 7.0);
  float sc = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = hash1(vec2(float(i), 3.0), vec2(64.0), 8.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 30.0 + fbm(uv, 8.0, 2, 9.0 + float(i)) * 0.3) - 0.5);
    float seg = smoothstep(0.6, 0.78, noiseT(uv, vec2(10.0), 10.0 + float(i)) * 0.5 + 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.01, ln)) * seg);
  }
  vec3 steel = vec3(0.54, 0.545, 0.55) * (0.93 + 0.08 * brush);
  vec3 rustC = srgb(vec3(128, 70, 38));
  vec3 col = mix(steel, steel * 0.85, smoothstep(0.4, 0.8, smudge) * 0.5);
  col = mix(col, rustC, max(rustSp * 0.7, pit.x));
  s.albedo = col;
  s.height = 0.5 + brush * 0.1 + grind * 0.05 - sc * 0.2 - pit.x * 0.2;
  s.metal = 1.0 - max(rustSp * 0.7, pit.x);
  s.rough = clamp(0.28 + brush * 0.08 + grind * 0.06 + smoothstep(0.4, 0.8, smudge) * 0.15 + rustSp * 0.4 - sc * 0.1, 0.0, 1.0);
  s.mask = clamp(smudge * 0.5 + pit.x, 0.0, 1.0);
}
`,
};

export const metal_diamond_plate: MatDef = {
  surface: 'metal', tile: 0.6, depth: 0.0025, pom: 0.0025, wear: 0.3, dust: 0.3, macro: 0.05, cavity: 1.0,
  glsl: /* glsl */ `
// Aluminium tread plate: raised lozenges alternating +/-45 deg, ~30mm pitch.
float lozenge(vec2 p, float ang) {
  float c = cos(ang), s = sin(ang);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  q = abs(q) / vec2(0.36, 0.075);
  float d = length(vec2(max(q.x - 0.8, 0.0), q.y)) + 0.0 * q.x;
  float e = q.x / 1.0 * 0.0;
  // tapered ends
  float taper = q.y / (1.0 - 0.8 * smoothstep(0.3, 1.0, q.x)) ;
  return max(q.x, taper);
}
void gen(vec2 uv, inout Surf s) {
  vec2 N = vec2(20.0);
  vec2 p = uv * N;
  vec2 c = floor(p), f = fract(p) - 0.5;
  float ang = mod(c.x + c.y, 2.0) < 0.5 ? 0.785398 : -0.785398;
  float d = lozenge(f, ang);
  float lz = 1.0 - smoothstep(0.85, 1.0, d);
  float dome = sqrt(max(0.0, 1.0 - d * d * 0.9)) * lz;
  float grain = fbm(uv, 400.0, 2, 1.0) * 0.5 + 0.5;
  float roll = fbm(uv, vec2(2.0, 300.0), 3, 0.5, 2.0) * 0.5 + 0.5;
  float dirtZ = smoothstep(0.4, 0.8, fbm(uv + warp(uv, 3.0, 2, 0.05, 3.0), 4.0, 5, 4.0) * 0.5 + 0.5);
  float sc = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = hash1(vec2(float(i), 1.0), vec2(64.0), 5.0) * PI;
    vec2 dir = vec2(cos(a), sin(a));
    float ln = abs(fract(dot(uv, vec2(-dir.y, dir.x)) * 18.0 + fbm(uv, 6.0, 2, 6.0 + float(i)) * 0.3) - 0.5);
    sc = max(sc, (1.0 - smoothstep(0.0, 0.008, ln)) * smoothstep(0.6, 0.8, noiseT(uv, vec2(8.0), 7.0 + float(i)) * 0.5 + 0.5));
  }
  vec3 alu = vec3(0.70, 0.71, 0.72) * (0.92 + 0.1 * roll);
  vec3 dirtC = srgb(vec3(92, 80, 66));
  float low = 1.0 - lz;
  vec3 col = mix(alu * 0.9, alu * 1.05, dome);           // polished tops
  col = mix(col, dirtC, low * dirtZ * 0.75);
  col = mix(col, alu * 0.75, grain * 0.2);
  s.albedo = col;
  s.height = 0.3 + dome * 0.6 + grain * 0.02 - sc * 0.05;
  s.metal = 1.0 - low * dirtZ * 0.75;
  s.rough = clamp(0.45 + roll * 0.1 - dome * 0.18 + low * dirtZ * 0.4 + sc * 0.1, 0.0, 1.0);
  s.mask = low;
}
`,
};

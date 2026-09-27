/**
 * GLSL library for procedural texture generation. Every function works in "tile space":
 * `uv` in [0,1)^2 covers exactly one texture tile, and integer frequencies make the
 * result periodic across the tile borders (seamless tiling by construction).
 */
export const NOISE_GLSL = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
uniform float uSeed;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float remap(float x, float a, float b) { return clamp((x - a) / (b - a), 0.0, 1.0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** sRGB (0..255 authored) to linear albedo. */
vec3 srgb(vec3 c) { c /= 255.0; return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 srgbHex(float r, float g, float b) { return srgb(vec3(r, g, b)); }

// ---------------------------------------------------------------- hashing (pcg3d, integer exact)
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// c: integer cell (as float), per: period (cells), s: salt
vec3 hash3(vec2 c, vec2 per, float s) {
  vec2 w = mod(c, per);
  uvec3 u = pcg3d(uvec3(uvec2(ivec2(w) + 4096), uint(int(uSeed) * 131 + int(s) * 7919 + 1)));
  return vec3(u) * (1.0 / 4294967295.0);
}
float hash1(vec2 c, vec2 per, float s) { return hash3(c, per, s).x; }
vec2 hash2(vec2 c, vec2 per, float s) { return hash3(c, per, s).xy; }
// Non-periodic hash for arbitrary ids.
vec4 hash4(vec3 c) {
  uvec3 u = pcg3d(uvec3(ivec3(floor(c)) + 32768) + uvec3(uint(uSeed) * 977u));
  uvec3 v = pcg3d(u ^ uvec3(0x9E3779B9u));
  return vec4(vec3(u), float(v.x)) * (1.0 / 4294967295.0);
}

// ---------------------------------------------------------------- value / gradient noise
float vnoise(vec2 p, vec2 per, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash1(i, per, s), b = hash1(i + vec2(1, 0), per, s);
  float c = hash1(i + vec2(0, 1), per, s), d = hash1(i + vec2(1, 1), per, s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 grad2(vec2 c, vec2 per, float s) { float a = hash1(c, per, s) * TAU; return vec2(cos(a), sin(a)); }
/** Periodic gradient noise, ~[-1,1]. */
float gnoise(vec2 p, vec2 per, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i, per, s), f);
  float b = dot(grad2(i + vec2(1, 0), per, s), f - vec2(1, 0));
  float c = dot(grad2(i + vec2(0, 1), per, s), f - vec2(0, 1));
  float d = dot(grad2(i + vec2(1, 1), per, s), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.41;
}
/** Tile-space gradient noise with integer frequency F (can be anisotropic). */
float noiseT(vec2 uv, vec2 F, float s) { return gnoise(uv * F, F, s); }
float noiseT(vec2 uv, float F, float s) { return gnoise(uv * F, vec2(F), s); }
/** fbm in tile space, ~[-1,1]. Frequency doubles per octave (stays periodic). */
float fbm(vec2 uv, vec2 F, int oct, float gain, float s) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    sum += amp * gnoise(uv * F, F, s + float(i) * 13.0);
    norm += amp; amp *= gain; F *= 2.0;
  }
  return sum / norm;
}
float fbm(vec2 uv, float F, int oct, float s) { return fbm(uv, vec2(F), oct, 0.5, s); }
/** Ridged fbm, [0,1], sharp creases. */
float ridged(vec2 uv, vec2 F, int oct, float s) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoise(uv * F, F, s + float(i) * 17.0));
    sum += amp * n * n; norm += amp; amp *= 0.5; F *= 2.0;
  }
  return sum / norm;
}
/** Periodic domain warp offset (tile units). */
vec2 warp(vec2 uv, float F, int oct, float amt, float s) {
  return vec2(fbm(uv, vec2(F), oct, 0.5, s), fbm(uv, vec2(F), oct, 0.5, s + 71.0)) * amt;
}

// ---------------------------------------------------------------- cellular
/** Periodic Worley. Returns (F1, F2, cellHash, 0). jit in [0,1]. */
vec4 worley(vec2 p, vec2 per, float jit, float s) {
  vec2 i = floor(p), f = fract(p);
  float F1 = 9.0, F2 = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y);
    vec3 h = hash3(i + o, per, s);
    vec2 r = o + 0.5 + jit * (h.xy - 0.5) - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; id = h.z; } else if (d < F2) { F2 = d; }
  }
  return vec4(sqrt(F1), sqrt(F2), id, 0.0);
}
vec4 worleyT(vec2 uv, float F, float jit, float s) { return worley(uv * F, vec2(F), jit, s); }
/** Periodic Voronoi with exact border distance (IQ). Returns (borderDist, cellHash, toCenter.xy). */
vec4 voronoi(vec2 p, vec2 per, float jit, float s) {
  vec2 n = floor(p), f = fract(p);
  vec2 mg, mr; float md = 8.0; float id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j);
    vec3 h = hash3(n + g, per, s);
    vec2 r = g + 0.5 + jit * (h.xy - 0.5) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; id = h.z; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(i, j);
    vec3 h = hash3(n + g, per, s);
    vec2 r = g + 0.5 + jit * (h.xy - 0.5) - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec4(md, id, mr);
}
vec4 voronoiT(vec2 uv, float F, float jit, float s) { return voronoi(uv * F, vec2(F), jit, s); }

// ---------------------------------------------------------------- scattered features
/** Periodic scattered round spots (pits, pores, pebbles). Returns (mask 0..1 soft, id, dist). */
vec3 spots(vec2 uv, float F, float density, float rMin, float rMax, float s) {
  vec2 p = uv * F; vec2 i = floor(p), f = fract(p);
  float m = 0.0, id = 0.0, dd = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y);
    vec3 h = hash3(i + o, vec2(F), s);
    if (h.z > density) continue;
    vec2 c = o + h.xy - f;
    float r = mix(rMin, rMax, fract(h.z * 17.13));
    float d = length(c) / r;
    if (d < dd) { dd = d; id = fract(h.z * 93.7); }
    m = max(m, 1.0 - smoothstep(0.6, 1.0, d));
  }
  return vec3(m, id, dd);
}

// ---------------------------------------------------------------- material building blocks
/** Hairline cracks: warped Voronoi borders, masked to sparse regions. Returns crack depth 0..1. */
float cracks(vec2 uv, float F, float width, float coverage, float s) {
  vec2 q = uv + warp(uv, F * 0.5, 3, 0.35 / F, s + 5.0);
  vec4 v = voronoiT(q, F, 0.9, s);
  float fine = fbm(uv, F * 4.0, 3, s + 9.0) * 0.5 + 0.5;
  float line = 1.0 - smoothstep(0.0, width * (0.4 + fine), v.x);
  float mask = smoothstep(1.0 - coverage, 1.0 - coverage + 0.15, fbm(uv, F * 0.5, 3, s + 21.0) * 0.5 + 0.5);
  return line * mask;
}
/** Vertical streaks (water/rust runs): long in y, thin in x. Returns 0..1. */
float streaks(vec2 uv, float fx, float s) {
  float n = fbm(uv + vec2(0.0, fbm(uv, vec2(fx * 0.25, 2.0), 2, 0.5, s + 3.0) * 0.02), vec2(fx, 1.0), 5, 0.55, s) * 0.5 + 0.5;
  float n2 = noiseT(uv, vec2(fx * 0.125, 2.0), s + 7.0) * 0.5 + 0.5;
  return saturate((n - 0.45) * 2.5) * smoothstep(0.35, 0.8, n2);
}
/** Paint chips: returns 1 where paint is missing. */
float chips(vec2 uv, float F, float amount, float s) {
  float n = fbm(uv + warp(uv, F, 3, 0.1 / F, s + 2.0), F, 6, s) * 0.5 + 0.5;
  return smoothstep(1.0 - amount, 1.0 - amount + 0.015, n);
}
/** Plain weave (threads along x and y), returns height 0..1. F = threads per tile. */
float weave(vec2 uv, vec2 F, float s) {
  vec2 p = uv * F;
  vec2 c = floor(p), f = fract(p);
  float checker = mod(c.x + c.y, 2.0);
  float tx = sin(f.y * PI);             // warp thread profile (runs along x)
  float ty = sin(f.x * PI);             // weft thread profile (runs along y)
  float over = mix(tx * (0.6 + 0.4 * sin(f.x * PI)), ty * (0.6 + 0.4 * sin(f.y * PI)), checker);
  float j = hash1(vec2(c.x, 0.0), vec2(F.x, 1.0), s) * 0.25 + hash1(vec2(0.0, c.y), vec2(1.0, F.y), s + 1.0) * 0.25;
  return over * (0.8 + j);
}
/** Twill (2/1 diagonal) weave height. */
float twill(vec2 uv, vec2 F, float s) {
  vec2 p = uv * F;
  vec2 c = floor(p), f = fract(p);
  float k = mod(c.x + c.y, 3.0);
  float warpUp = step(0.5, k);
  float tx = pow(sin(f.y * PI), 0.7), ty = pow(sin(f.x * PI), 0.7);
  float j = hash1(vec2(c.x, 0.0), vec2(F.x, 1.0), s) * 0.3;
  return mix(ty, tx, warpUp) * (0.75 + j);
}
`;

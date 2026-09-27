import * as THREE from 'three';

/**
 * Procedural 8x8 flipbook of a billowing smoke puff, rendered once on the GPU.
 *
 * Each cell is a frame of a puff that expands, churns and dissipates. The puff is modelled as a
 * smooth union of sphere caps (cauliflower billows) displaced by animated fbm, which yields a real
 * height field -> analytic pseudo-normals, so billboards shade like volumes under a side sun.
 *
 * Channels: R,G = tangent-space normal xy (0.5 bias), B = normalized thickness, A = coverage/alpha.
 */
export const FLIP_GRID = 8;
export const FLIP_FRAMES = FLIP_GRID * FLIP_GRID;

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uGrid;
uniform float uSeed;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
// billowy (turbulence-like) fbm: rounded lumps
float bfbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0)); p = p * 2.13 + vec3(4.1, 1.3, 7.7); a *= 0.5; }
  return s;
}

float h1(float i, float k) { return hash13(vec3(i * 7.13 + uSeed, k * 3.71, 11.3)); }

// Height of the puff surface at p (cell space, -1..1) for normalized time t.
float heightAt(vec2 p, float t) {
  float grow = 0.62 + 0.38 * (1.0 - pow(1.0 - t, 1.6));
  // animated domain warp: billows roll and churn outward
  vec3 q = vec3(p * 1.35, t * 1.7 + uSeed);
  vec2 warp = vec2(fbm(q), fbm(q + vec3(5.2, 1.3, 2.8))) - 0.5;
  p += warp * (0.3 + 0.3 * t);
  float acc = 0.0;
  const float K = 7.5;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    vec2 r = vec2(h1(fi, 1.0), h1(fi, 2.0));
    float ang = r.x * 6.2831 + t * (h1(fi, 6.0) - 0.5) * 1.6;
    float rad = sqrt(r.y) * 0.5;
    vec2 c = vec2(cos(ang), sin(ang) * 0.85 + 0.06) * rad * grow;
    float sr = mix(0.16, 0.36, h1(fi, 4.0)) * mix(1.2, 0.7, rad / 0.5) * grow;
    float d = length(p - c);
    float hh = d < sr ? sqrt(sr * sr - d * d) : (sr - d);
    hh *= 0.85 + 0.35 * h1(fi, 5.0);
    acc += exp(K * hh);
  }
  float h = log(acc) / K;
  // cauliflower micro-billows + fine turbulence
  h += (bfbm(vec3(p * 5.2, t * 1.1 + uSeed * 1.7)) - 0.5) * 0.2 * grow;
  h += (fbm(vec3(p * 13.0, t * 1.5 + 3.0)) - 0.5) * 0.05;
  return h;
}

void main() {
  vec2 cell = floor(vUv * uGrid);
  vec2 local = fract(vUv * uGrid);
  float frame = cell.x + cell.y * uGrid;
  float t = frame / (uGrid * uGrid - 1.0);
  vec2 p = (local * 2.0 - 1.0) * 1.05;

  float e = 0.012;
  float h = heightAt(p, t);
  float hx = heightAt(p + vec2(e, 0.0), t);
  float hy = heightAt(p + vec2(0.0, e), t);

  // dissipation: threshold rises with time so the puff thins and breaks into wisps
  float thr = mix(-0.06, 0.16, pow(t, 1.2));
  float cov = smoothstep(0.0, 0.34 + 0.12 * t, h - thr);
  cov = cov * cov * (3.0 - 2.0 * cov);
  // internal density variation + late wispy break-up
  float wisp = fbm(vec3(p * 4.0, t * 2.0 + 7.0));
  cov *= mix(0.75, 1.0, fbm(vec3(p * 9.0, t + 11.0)));
  cov *= mix(1.0, smoothstep(0.3, 0.7, wisp), smoothstep(0.2, 1.0, t) * 0.85);
  // keep inside the cell
  cov *= smoothstep(1.0, 0.78, length(p));

  vec2 g = vec2(hx - h, hy - h) / e;
  vec3 n = normalize(vec3(-g * 0.55, 1.0));
  float thick = clamp((h - thr) / 0.55, 0.0, 1.0);

  gl_FragColor = vec4(n.xy * 0.5 + 0.5, thick, cov);
}
`;

export function generateSmokeFlipbook(renderer: THREE.WebGLRenderer, size: number, seed = 3.7): THREE.Texture {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { uGrid: { value: FLIP_GRID }, uSeed: { value: seed } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevTone = renderer.toneMapping;
  renderer.autoClear = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevTone;

  quad.geometry.dispose();
  mat.dispose();
  return rt.texture;
}

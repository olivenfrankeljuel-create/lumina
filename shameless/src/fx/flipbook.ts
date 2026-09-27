import * as THREE from 'three';

/**
 * Procedural 8x8 flipbook of a billowing smoke puff, rendered once on the GPU in two passes.
 *
 * Pass 1 ray-marches a 3D billowy density field per frame (the puff expands, churns and
 * dissipates over the 64 frames) and stores coverage, optical thickness and the
 * transmittance-weighted depth of the visible "surface" of the volume.
 * Pass 2 turns that depth into tangent-space pseudo-normals (plus a spherical bias), so the
 * billboards shade like volumes under a low side sun.
 *
 * Final channels: R,G = normal xy (0.5 bias), B = normalized thickness, A = coverage.
 */
export const FLIP_GRID = 8;
export const FLIP_FRAMES = FLIP_GRID * FLIP_GRID;

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const noise = /* glsl */ `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
`;

const fragDensity = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uGrid;
uniform float uSeed;
${noise}
// billowy noise: rounded lumps (cauliflower)
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float billow(vec3 p) {
  float a = 0.55, s = 0.0;
  for (int i = 0; i < 4; i++) {
    float n = vnoise(p) * 2.0 - 1.0;
    s += a * (1.0 - sqrt(n * n + 0.015)); // softened crease
    p = ROT * p * 2.07 + vec3(4.1, 1.3, 7.7);
    a *= 0.42;
  }
  return s;
}

float density(vec3 p, float t, float R) {
  // noise space expands with the puff so billows grow, and slowly churns (rolls outward)
  vec3 q = p / R;
  float roll = t * 0.9;
  vec3 nq = ROT * (q * 1.7) + vec3(uSeed, uSeed * 1.3, roll);
  nq += (vec3(vnoise(nq * 0.8 + 3.1), vnoise(nq * 0.8 + 9.4), vnoise(nq * 0.8 + 5.7)) - 0.5) * 0.5;
  float b = billow(nq);
  float r = length(q * vec3(1.0, 1.08, 1.0));
  float base = 1.0 - r;
  float d = base * 1.35 + (b - 0.6) * 2.3;
  // dissipation: the puff thins out and breaks into wisps
  d -= t * t * 0.55;
  d *= smoothstep(1.3, 0.8, r);
  return clamp(d, 0.0, 1.0) * mix(1.0, 0.45, t);
}

void main() {
  vec2 cell = floor(vUv * uGrid);
  vec2 local = fract(vUv * uGrid);
  float frame = cell.x + cell.y * uGrid;
  float t = frame / (uGrid * uGrid - 1.0);
  vec2 xy = (local * 2.0 - 1.0) * 1.04;
  float R = mix(0.42, 0.9, 1.0 - pow(1.0 - t, 1.7));

  const int STEPS = 22;
  float zr = R * 1.05;
  float dz = 2.0 * zr / float(STEPS);
  float tau = 0.0;
  float T = 1.0;
  float zw = 0.0, ww = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float z = zr - (float(i) + 0.5) * dz; // front (+z, toward viewer) to back
    vec3 p = vec3(xy, z);
    if (dot(p, p) > zr * zr * 1.3) continue;
    float d = density(p, t, R);
    float st = d * dz * 4.0;
    float w = T * (1.0 - exp(-st));
    zw += z * w; ww += w;
    tau += st;
    T *= exp(-st);
  }
  float cov = 1.0 - exp(-tau);
  cov *= smoothstep(1.0, 0.72, length(xy));
  float zs = ww > 1e-4 ? zw / ww : 0.0;
  gl_FragColor = vec4(zs * 0.5 + 0.5, clamp(tau / 3.0, 0.0, 1.0), 0.0, cov);
}
`;

const fragNormal = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uGrid;
uniform vec2 uTexel;
void main() {
  vec4 c = texture2D(uSrc, vUv);
  vec2 local = fract(vUv * uGrid);
  vec2 ex = vec2(uTexel.x * 2.0, 0.0), ey = vec2(0.0, uTexel.y * 2.0);
  vec4 l = texture2D(uSrc, vUv - ex), r = texture2D(uSrc, vUv + ex);
  vec4 d = texture2D(uSrc, vUv - ey), u = texture2D(uSrc, vUv + ey);
  // gradient of the surface depth (in cell units)
  float cellTexels = 1.0 / (uTexel.x * uGrid);
  // pseudo-normals: mostly from the optical-thickness gradient (smooth, volumetric),
  // with a touch of the surface-depth gradient for billow detail
  vec2 gz = vec2(r.r - l.r, u.r - d.r) * cellTexels * 0.25;
  vec2 gt = vec2(r.g - l.g, u.g - d.g) * cellTexels * 0.25;
  vec2 sph = local * 2.0 - 1.0;
  vec3 n = normalize(vec3(-gt * 0.35 - gz * 0.25 + sph * 0.25, 1.0));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, c.g, c.a);
}
`;

export function generateSmokeFlipbook(renderer: THREE.WebGLRenderer, size: number, seed = 3.7): THREE.Texture {
  const mkRT = (mips: boolean, type: THREE.TextureDataType) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type, format: THREE.RGBAFormat, generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
      magFilter: mips ? THREE.LinearFilter : THREE.NearestFilter,
      depthBuffer: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  };
  const rtA = mkRT(false, THREE.HalfFloatType);
  const rtB = mkRT(true, THREE.UnsignedByteType);
  rtB.texture.anisotropy = 4;

  const matA = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: fragDensity, uniforms: { uGrid: { value: FLIP_GRID }, uSeed: { value: seed } }, depthTest: false, depthWrite: false });
  const matB = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: fragNormal,
    uniforms: { uSrc: { value: rtA.texture }, uGrid: { value: FLIP_GRID }, uTexel: { value: new THREE.Vector2(1 / size, 1 / size) } },
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), matA);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevTone = renderer.toneMapping;
  renderer.autoClear = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rtA);
  renderer.render(scene, cam);
  quad.material = matB;
  renderer.setRenderTarget(rtB);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.toneMapping = prevTone;

  quad.geometry.dispose();
  matA.dispose(); matB.dispose();
  rtA.dispose();
  return rtB.texture;
}

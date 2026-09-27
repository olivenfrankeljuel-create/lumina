import * as THREE from 'three';

/**
 * Physically based single-scattering atmosphere (Rayleigh + Mie + ozone), evaluated
 * - on the CPU (sun transmittance -> sun light color, sky irradiance -> ground bounce),
 * - on the GPU (baked once into a small HDR cube: the "atmosphere LUT" used by the sky dome,
 *   the aerial-perspective fog and the IBL capture).
 * Units: km for distances, coefficients per km. Radiance is scaled into scene units so that the
 * sun's illuminance at the ground equals `sunIlluminance` (three.js light intensity units).
 */

export interface AtmosphereParams {
  /** Sun elevation above horizon, degrees. */
  elevation: number;
  /** Sun azimuth, degrees (0 = +Z/south, 90 = +X). */
  azimuth: number;
  /** Mie turbidity multiplier (dust/haze). 1 = clear. */
  turbidity: number;
  /** Target sun illuminance on the ground in scene units (DirectionalLight intensity). */
  sunIlluminance: number;
  /** Artistic multiplier on sky radiance (1 = physical ratio). */
  skyGain: number;
  /** Ground albedo for the lower hemisphere of the environment. */
  groundAlbedo: THREE.Color;
  /** Cloud coverage 0..1 */
  cloudCoverage: number;
  /** Isotropic multiple-scattering approximation (fraction of sun). */
  multiScatter: number;
  /** Artistic tint on the direct sun (luminance preserved). */
  sunTint: THREE.Color;
  /** How much of the low sky the IBL treats as occluded by surrounding buildings (0..1). */
  surroundAmount: number;
}

export const DEFAULT_ATMOSPHERE: AtmosphereParams = {
  elevation: 19,
  azimuth: 53,
  turbidity: 4.5,
  sunIlluminance: 3.6,
  skyGain: 1.15,
  groundAlbedo: new THREE.Color(0.34, 0.27, 0.2),
  cloudCoverage: 0.38,
  multiScatter: 0.1,
  sunTint: new THREE.Color(1.05, 0.93, 0.78),
  surroundAmount: 0.6,
};

const RE = 6360, RA = 6420, H_R = 8.0, H_M = 1.2, VIEW_ALT = 0.05;
const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3];
const BETA_O = [0.65e-3, 1.881e-3, 0.085e-3];
// dust: slightly more scattering in red, more absorption in blue
const MIE_SCAT_TINT = [1.0, 0.97, 0.92];
const MIE_EXT_TINT = [1.1, 1.12, 1.18];
const BETA_M = 3.996e-3;
const MIE_G = 0.76;

export function sunDirection(p: AtmosphereParams, out = new THREE.Vector3()): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(p.elevation), az = THREE.MathUtils.degToRad(p.azimuth);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
}

function raySphereFar(oy: number, dx: number, dy: number, dz: number, r: number, ox = 0, oz = 0): number {
  // origin (ox, oy, oz) relative to planet center
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}
function raySphereNear(oy: number, dx: number, dy: number, dz: number, r: number, ox = 0, oz = 0): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b - Math.sqrt(d);
}

function ozone(h: number) { return Math.max(0, 1 - Math.abs(h - 25) / 15); }

/** Optical depth (R, M, O) from point (x,y,z) (planet-centered, km) along dir to the top of the atmosphere. */
function opticalDepth(x: number, y: number, z: number, dx: number, dy: number, dz: number, steps: number): [number, number, number] | null {
  const tg = raySphereNear(y, dx, dy, dz, RE, x, z);
  if (tg > 0) return null; // blocked by ground
  const t = raySphereFar(y, dx, dy, dz, RA, x, z);
  const ds = t / steps;
  let r = 0, m = 0, o = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const px = x + dx * s, py = y + dy * s, pz = z + dz * s;
    const h = Math.sqrt(px * px + py * py + pz * pz) - RE;
    r += Math.exp(-h / H_R) * ds; m += Math.exp(-h / H_M) * ds; o += ozone(h) * ds;
  }
  return [r, m, o];
}

function transmittance(od: [number, number, number] | null, turb: number): number[] {
  if (!od) return [0, 0, 0];
  return [0, 1, 2].map((c) => Math.exp(-(BETA_R[c] * od[0] + BETA_M * turb * MIE_EXT_TINT[c] * od[1] + BETA_O[c] * od[2])));
}

function phaseR(mu: number) { return (3 / (16 * Math.PI)) * (1 + mu * mu); }
function phaseM(mu: number, g: number) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
}

/** Unscaled single-scattered sky radiance (for sun irradiance 1) in direction d. */
function skyRadianceCPU(d: THREE.Vector3, sun: THREE.Vector3, turb: number, ms: number): number[] {
  const oy = RE + VIEW_ALT;
  const dy = Math.max(d.y, 0.0);
  const dl = Math.hypot(d.x, dy, d.z) || 1;
  const dx = d.x / dl, dyy = dy / dl, dz = d.z / dl;
  const tMax = raySphereFar(oy, dx, dyy, dz, RA);
  const steps = 24;
  const ds = tMax / steps;
  const mu = dx * sun.x + dyy * sun.y + dz * sun.z;
  const pr = phaseR(mu), pm = phaseM(mu, MIE_G);
  const sumR = [0, 0, 0];
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const px = dx * s, py = oy + dyy * s, pz = dz * s;
    const h = Math.sqrt(px * px + py * py + pz * pz) - RE;
    const hr = Math.exp(-h / H_R) * ds, hm = Math.exp(-h / H_M) * ds, ho = ozone(h) * ds;
    odR += hr * 0.5; odM += hm * 0.5; odO += ho * 0.5;
    const tv = transmittance([odR, odM, odO], turb);
    const tl = transmittance(opticalDepth(px, py, pz, sun.x, sun.y, sun.z, 6), turb);
    for (let c = 0; c < 3; c++) {
      const scatR = BETA_R[c] * hr, scatM = BETA_M * turb * MIE_SCAT_TINT[c] * hm;
      sumR[c] += tv[c] * (tl[c] * (scatR * pr + scatM * pm) + (scatR + scatM) * ms);
    }
    odR += hr * 0.5; odM += hm * 0.5; odO += ho * 0.5;
  }
  return sumR;
}

export interface AtmosphereState {
  params: AtmosphereParams;
  sunDir: THREE.Vector3;
  /** Scene-unit irradiance of the sun at the ground (color * intensity). */
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Scale from unit-sun radiance to scene units. */
  scale: number;
  /** Sun color at cloud altitude (scene units). */
  cloudSunColor: THREE.Color;
  /** Sky irradiance on an upward facing surface (scene units). */
  skyIrradiance: THREE.Color;
  /** Irradiance of the ground plane (sun + sky), used for bounce/lower env hemisphere. */
  groundRadiance: THREE.Color;
  /** Average horizon radiance (fog tint reference). */
  horizonColor: THREE.Color;
  multiScatter: number;
}

export function computeAtmosphere(params: AtmosphereParams): AtmosphereState {
  const sunDir = sunDirection(params);
  const turb = params.turbidity;
  const ms = params.multiScatter;
  const tSun = transmittance(opticalDepth(0, RE + VIEW_ALT, 0, sunDir.x, sunDir.y, sunDir.z, 64), turb);
  const tint = params.sunTint;
  tSun[0] *= tint.r; tSun[1] *= tint.g; tSun[2] *= tint.b;
  const lum = 0.2126 * tSun[0] + 0.7152 * tSun[1] + 0.0722 * tSun[2];
  const scale = params.sunIlluminance / Math.max(lum, 1e-4);
  const sunColor = new THREE.Color(tSun[0] / lum, tSun[1] / lum, tSun[2] / lum);
  const tCloud = transmittance(opticalDepth(0, RE + 7, 0, sunDir.x, sunDir.y, sunDir.z, 32), turb);
  const cloudSunColor = new THREE.Color(tCloud[0] * scale * tint.r, tCloud[1] * scale * tint.g, tCloud[2] * scale * tint.b);

  // cosine-weighted sky irradiance on the ground (upper hemisphere)
  const irr = [0, 0, 0];
  const d = new THREE.Vector3();
  const N_EL = 8, N_AZ = 16;
  for (let i = 0; i < N_EL; i++) {
    const el = ((i + 0.5) / N_EL) * (Math.PI / 2);
    const cosT = Math.sin(el);
    const dOmega = Math.cos(el) * (Math.PI / 2 / N_EL) * (2 * Math.PI / N_AZ);
    for (let j = 0; j < N_AZ; j++) {
      const az = ((j + 0.5) / N_AZ) * Math.PI * 2;
      d.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      const L = skyRadianceCPU(d, sunDir, turb, ms);
      for (let c = 0; c < 3; c++) irr[c] += L[c] * cosT * dOmega;
    }
  }
  const skyIrradiance = new THREE.Color(irr[0] * scale * params.skyGain, irr[1] * scale * params.skyGain, irr[2] * scale * params.skyGain);
  const sunGround = sunDir.y * params.sunIlluminance;
  const a = params.groundAlbedo;
  const groundRadiance = new THREE.Color(
    (a.r / Math.PI) * (sunGround * sunColor.r + skyIrradiance.r),
    (a.g / Math.PI) * (sunGround * sunColor.g + skyIrradiance.g),
    (a.b / Math.PI) * (sunGround * sunColor.b + skyIrradiance.b),
  );
  const hz = [0, 0, 0];
  for (let j = 0; j < 8; j++) {
    const az = (j / 8) * Math.PI * 2;
    const L = skyRadianceCPU(d.set(Math.sin(az), 0.02, Math.cos(az)), sunDir, turb, ms);
    for (let c = 0; c < 3; c++) hz[c] += (L[c] * scale * params.skyGain) / 8;
  }
  return {
    params, sunDir, sunColor, sunIntensity: params.sunIlluminance, scale, cloudSunColor, skyIrradiance, groundRadiance,
    horizonColor: new THREE.Color(hz[0], hz[1], hz[2]), multiScatter: ms,
  };
}

// ---------------------------------------------------------------------------------------------
// GLSL

export const ATMOSPHERE_GLSL = /* glsl */`
#define RE 6360.0
#define RA 6420.0
#define H_R 8.0
#define H_M 1.2
#define VIEW_ALT ${VIEW_ALT.toFixed(3)}
const vec3 BETA_R = vec3(${BETA_R.map((v) => v.toExponential(4)).join(',')});
const vec3 BETA_O = vec3(${BETA_O.map((v) => v.toExponential(4)).join(',')});
const vec3 MIE_SCAT_TINT = vec3(${MIE_SCAT_TINT.join(',')});
const vec3 MIE_EXT_TINT = vec3(${MIE_EXT_TINT.join(',')});
#define BETA_M ${BETA_M.toExponential(4)}
#define MIE_G ${MIE_G.toFixed(3)}
#define PI_A 3.14159265

float raySphereFarA(vec3 o, vec3 d, float r) {
  float b = dot(o, d); float c = dot(o, o) - r * r; float disc = b * b - c;
  if (disc < 0.0) return -1.0; return -b + sqrt(disc);
}
float raySphereNearA(vec3 o, vec3 d, float r) {
  float b = dot(o, d); float c = dot(o, o) - r * r; float disc = b * b - c;
  if (disc < 0.0) return -1.0; return -b - sqrt(disc);
}
float ozoneA(float h) { return max(0.0, 1.0 - abs(h - 25.0) / 15.0); }
vec3 extinctionA(vec3 od, float turb) {
  return BETA_R * od.x + BETA_M * turb * MIE_EXT_TINT * od.y + BETA_O * od.z;
}
vec3 sunTransmittanceA(vec3 p, vec3 s, float turb) {
  if (raySphereNearA(p, s, RE) > 0.0) return vec3(0.0);
  float t = raySphereFarA(p, s, RA);
  const int N = 8; float ds = t / float(N); vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + s * ((float(i) + 0.5) * ds);
    float h = length(q) - RE;
    od += vec3(exp(-h / H_R), exp(-h / H_M), ozoneA(h)) * ds;
  }
  return exp(-extinctionA(od, turb));
}
float phaseRA(float mu) { return 3.0 / (16.0 * PI_A) * (1.0 + mu * mu); }
float phaseMA(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI_A) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}
// single scattering + cheap multiple scattering, unit sun irradiance
vec3 skyRadianceA(vec3 d, vec3 s, float turb, float ms) {
  d.y = max(d.y, 0.0); d = normalize(d);
  vec3 o = vec3(0.0, RE + VIEW_ALT, 0.0);
  float tMax = raySphereFarA(o, d, RA);
  const int N = 32;
  float mu = dot(d, s);
  float pr = phaseRA(mu), pm = phaseMA(mu, MIE_G);
  vec3 od = vec3(0.0); vec3 sum = vec3(0.0);
  float prevT = 0.0;
  for (int i = 0; i < N; i++) {
    // quadratic step distribution: dense near the viewer where the haze is
    float f0 = float(i) / float(N), f1 = float(i + 1) / float(N);
    float t0 = tMax * f0 * f0, t1 = tMax * f1 * f1;
    float ds = t1 - t0; float t = 0.5 * (t0 + t1);
    vec3 p = o + d * t;
    float h = length(p) - RE;
    vec3 dens = vec3(exp(-h / H_R), exp(-h / H_M), ozoneA(h)) * ds;
    od += dens * 0.5;
    vec3 tv = exp(-extinctionA(od, turb));
    vec3 tl = sunTransmittanceA(p, s, turb);
    vec3 scR = BETA_R * dens.x; vec3 scM = BETA_M * turb * MIE_SCAT_TINT * dens.y;
    sum += tv * (tl * (scR * pr + scM * pm) + (scR + scM) * ms);
    od += dens * 0.5;
  }
  return sum;
}
`;

const COMMON_NOISE_GLSL = /* glsl */`
float hashA(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

/** Sky dome shader: atmosphere cube + analytic sun disk/aureole + procedural high clouds. */
function skyMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'ShamelessSky',
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform samplerCube tAtmo;
      uniform sampler2D tNoise;
      uniform vec3 sunDir;
      uniform vec3 sunRadiance;     // radiance of the disk (clamped for HDR sanity)
      uniform vec3 sunColor;        // illuminance color at ground
      uniform vec3 cloudSun;        // sun color at cloud altitude
      uniform vec3 horizonColor;
      uniform vec3 groundRadiance;
      uniform float coverage;
      uniform float time;
      uniform float envMode;        // 1 = rendering into the environment (no sun disk, ground below)
      uniform vec3 surroundColor;
      uniform float surroundAmount;
      varying vec3 vDir;
      ${COMMON_NOISE_GLSL}
      float hgPhase(float mu, float g) { float g2 = g*g; return (1.0 - g2) / (4.0*3.14159265*pow(1.0 + g2 - 2.0*g*mu, 1.5)); }
      float cloudField(vec2 p) {
        // p in km on the cloud plane; streaky cirrus + patchy altocumulus
        vec2 wind = vec2(0.004, 0.0015) * time;
        mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
        vec2 q = rot * p * 0.045 + wind;
        float streak = texture2D(tNoise, q * vec2(1.0, 0.28)).r;
        float warp = texture2D(tNoise, q * 0.5 + 0.37).g;
        float body = texture2D(tNoise, q * 1.3 + vec2(warp * 0.35, 0.0)).b;
        float detail = texture2D(tNoise, q * 5.1 + warp * 0.2).a;
        float d = streak * 0.55 + body * 0.35 + detail * 0.22 - 0.06;
        return smoothstep(1.0 - coverage, 1.0 - coverage + 0.32, d) * (0.65 + 0.35 * detail);
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 atmo = textureCube(tAtmo, vec3(d.x, max(d.y, 0.0), d.z)).rgb;
        vec3 col = atmo;
        float mu = dot(d, sunDir);
        if (d.y > 0.0) {
          // clouds: plane at 7 km
          float t = 7.0 / max(d.y, 0.02);
          vec2 p = d.xz * t;
          float c = cloudField(p);
          float fade = smoothstep(0.015, 0.2, d.y);
          c *= fade;
          // thin cloud lighting: strong forward scattering + ambient from the sky
          float ph = hgPhase(mu, 0.55) * 2.4 + hgPhase(mu, -0.2) * 0.7;
          vec3 amb = horizonColor * 0.9 + atmo * 0.4;
          vec3 cloudCol = cloudSun * ph * (0.55 + 0.45 * c) * 0.22 + amb * 0.75;
          // aerial perspective on distant clouds
          float haze = 1.0 - exp(-t / 120.0);
          cloudCol = mix(cloudCol, atmo, haze * 0.8);
          col = mix(col, cloudCol, c * 0.85);
          if (envMode < 0.5) {
            // sun disk with limb darkening + tight aureole
            float cosR = 0.99998;  // ~0.36 deg radius (slightly enlarged for readability)
            float disk = smoothstep(cosR - 0.000012, cosR + 0.000004, mu);
            float r = clamp((1.0 - mu) / (1.0 - cosR), 0.0, 1.0);
            float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r)));
            col += sunRadiance * disk * limb * (1.0 - c * 0.9);
            col += sunColor * hgPhase(mu, 0.985) * 0.02 * (1.0 - c * 0.6);
          }
        }
        if (envMode > 0.5 && d.y >= 0.0) {
          // urban canyon: the low sky is mostly occluded by warm plaster facades (lit + shaded mix)
          float s = (1.0 - smoothstep(0.0, 0.3, d.y)) * surroundAmount;
          col = mix(col, surroundColor, s);
        }
        if (d.y < 0.0) {
          if (envMode > 0.5) {
            // lit dusty ground blending into the surrounding town near the horizon
            float h = pow(clamp(1.0 + d.y * 4.0, 0.0, 1.0), 3.0);
            col = mix(groundRadiance, surroundColor, h);
          } else {
            col = mix(atmo, horizonColor * 0.85, clamp(-d.y * 4.0, 0.0, 1.0));
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    toneMapped: false,
    fog: false,
  });
}

/** Tileable multi-octave value noise (CPU), 4 channels of different character. */
export function makeNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rand = (x: number, y: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const valueNoise = (x: number, y: number, period: number, seed: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const m = (a: number) => ((a % period) + period) % period;
    const a = rand(m(xi), m(yi), seed), b = rand(m(xi + 1), m(yi), seed);
    const c = rand(m(xi), m(yi + 1), seed), d = rand(m(xi + 1), m(yi + 1), seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x: number, y: number, base: number, oct: number, seed: number, ridge = false) => {
    let sum = 0, amp = 0.5, norm = 0, f = base;
    for (let o = 0; o < oct; o++) {
      let n = valueNoise((x * f) / size, (y * f) / size, f, seed + o * 17);
      if (ridge) n = 1 - Math.abs(n * 2 - 1);
      sum += n * amp; norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = Math.round(fbm(x, y, 4, 5, 1) * 255);
      data[i + 1] = Math.round(fbm(x, y, 3, 4, 2) * 255);
      data[i + 2] = Math.round(fbm(x, y, 6, 5, 3, true) * 255);
      data[i + 3] = Math.round(fbm(x, y, 16, 3, 4) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export interface SkySystem {
  state: AtmosphereState;
  /** HDR cube of the clear atmosphere (no clouds, no sun disk). */
  atmoCube: THREE.CubeTexture;
  dome: THREE.Mesh;
  envMap: THREE.Texture;
  uniforms: Record<string, THREE.IUniform>;
  rebuild(params: AtmosphereParams): void;
  update(time: number): void;
  dispose(): void;
}

export function createSky(renderer: THREE.WebGLRenderer, params: AtmosphereParams, cubeSize: number): SkySystem {
  const noise = makeNoiseTexture(256);
  const atmoRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
    type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const bakeUniforms = {
    sunDir: { value: new THREE.Vector3() },
    scale: { value: 1 },
    turb: { value: params.turbidity },
    ms: { value: 0.06 },
  };
  const bakeMat = new THREE.ShaderMaterial({
    name: 'ShamelessAtmosphereBake',
    uniforms: bakeUniforms,
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 sunDir; uniform float scale; uniform float turb; uniform float ms;
      varying vec3 vDir;
      ${ATMOSPHERE_GLSL}
      void main() { gl_FragColor = vec4(skyRadianceA(normalize(vDir), sunDir, turb, ms) * scale, 1.0); }`,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  });
  const bakeScene = new THREE.Scene();
  const bakeBox = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), bakeMat);
  bakeBox.frustumCulled = false;
  bakeScene.add(bakeBox);
  const cubeCam = new THREE.CubeCamera(0.1, 10, atmoRT);

  const uniforms: Record<string, THREE.IUniform> = {
    tAtmo: { value: atmoRT.texture },
    tNoise: { value: noise },
    sunDir: { value: new THREE.Vector3() },
    sunRadiance: { value: new THREE.Vector3() },
    sunColor: { value: new THREE.Vector3() },
    cloudSun: { value: new THREE.Vector3() },
    horizonColor: { value: new THREE.Vector3() },
    groundRadiance: { value: new THREE.Vector3() },
    coverage: { value: params.cloudCoverage },
    time: { value: 0 },
    envMode: { value: 0 },
    surroundColor: { value: new THREE.Vector3() },
    surroundAmount: { value: params.surroundAmount },
  };
  const dome = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), skyMaterial(uniforms));
  dome.frustumCulled = false;
  dome.renderOrder = 1e6; // last among opaques: early-z rejects covered pixels
  dome.name = 'ShamelessSkyDome';
  (dome as THREE.Object3D).castShadow = false;
  dome.receiveShadow = false;

  const envScene = new THREE.Scene();
  const envDome = new THREE.Mesh(dome.geometry, dome.material);
  envDome.frustumCulled = false;
  envScene.add(envDome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;

  const sys: SkySystem = {
    state: null as unknown as AtmosphereState,
    atmoCube: atmoRT.texture,
    dome,
    envMap: null as unknown as THREE.Texture,
    uniforms,
    rebuild(p: AtmosphereParams) {
      const st = computeAtmosphere(p);
      sys.state = st;
      bakeUniforms.sunDir.value.copy(st.sunDir);
      bakeUniforms.scale.value = st.scale * p.skyGain;
      bakeUniforms.turb.value = p.turbidity;
      bakeUniforms.ms.value = st.multiScatter;
      cubeCam.update(renderer, bakeScene);
      uniforms.sunDir.value.copy(st.sunDir);
      const sc = st.sunColor;
      const diskR = 900; // clamped disk radiance (physical would be ~5e4)
      uniforms.sunRadiance.value.set(sc.r * diskR, sc.g * diskR, sc.b * diskR);
      uniforms.sunColor.value.set(sc.r * st.sunIntensity, sc.g * st.sunIntensity, sc.b * st.sunIntensity);
      uniforms.cloudSun.value.set(st.cloudSunColor.r, st.cloudSunColor.g, st.cloudSunColor.b);
      uniforms.horizonColor.value.set(st.horizonColor.r, st.horizonColor.g, st.horizonColor.b);
      uniforms.groundRadiance.value.set(st.groundRadiance.r, st.groundRadiance.g, st.groundRadiance.b);
      // facades: ~40% sunlit (at grazing-ish incidence), 60% in shade; plaster albedo ~0.55
      const sc2 = st.sunColor, si = st.sunIntensity * 0.45, sk = st.skyIrradiance;
      uniforms.surroundColor.value.set(
        (0.55 / Math.PI) * (0.4 * si * sc2.r + 0.6 * sk.r),
        (0.52 / Math.PI) * (0.4 * si * sc2.g + 0.6 * sk.g),
        (0.46 / Math.PI) * (0.4 * si * sc2.b + 0.6 * sk.b));
      uniforms.surroundAmount.value = p.surroundAmount;
      uniforms.coverage.value = p.cloudCoverage;
      uniforms.envMode.value = 1;
      const prev = envRT;
      envRT = pmrem.fromScene(envScene, 0, 0.1, 10);
      uniforms.envMode.value = 0;
      sys.envMap = envRT.texture;
      prev?.dispose();
    },
    update(time: number) {
      uniforms.time.value = time;
    },
    dispose() {
      atmoRT.dispose(); envRT?.dispose(); pmrem.dispose(); noise.dispose(); bakeMat.dispose();
      (dome.material as THREE.Material).dispose(); dome.geometry.dispose();
    },
  };
  sys.rebuild(params);
  return sys;
}

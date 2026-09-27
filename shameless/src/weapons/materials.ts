import * as THREE from 'three';
import type { GameContext, MaterialName } from '../core/types';

/**
 * Weapon/arms materials. Base materials come from ctx.materials (owned by the materials lead);
 * we clone them and layer a procedural edge-wear / cavity-grime pass on top keyed to screen-space
 * curvature (derivatives of the interpolated normal), with noise in object space so it does not swim.
 */

export interface WearParams {
  wear: number;          // 0..1 amount of edge wear
  wearColor: THREE.Color; // exposed substrate color
  wearMetal: number;
  wearRough: number;
  cavity: number;         // 0..1 grime in concave areas
  edgeLo: number;         // curvature (1/m) where wear starts
  edgeHi: number;
  noiseScale: number;
}

interface Fallback { color: number; rough: number; metal: number }

const FALLBACKS: Partial<Record<MaterialName, Fallback>> = {
  gun_anodized: { color: 0x1d1e20, rough: 0.42, metal: 0.55 },
  gun_parkerized: { color: 0x2a2a2a, rough: 0.55, metal: 0.7 },
  gun_polymer_black: { color: 0x1a1a1b, rough: 0.62, metal: 0.0 },
  gun_polymer_fde: { color: 0x9a8161, rough: 0.66, metal: 0.0 },
  glove_leather: { color: 0x3b3a36, rough: 0.8, metal: 0.0 },
  cloth_multicam: { color: 0x6f6a52, rough: 0.95, metal: 0.0 },
  cloth_olive: { color: 0x4d4f3a, rough: 0.95, metal: 0.0 },
  cloth_black: { color: 0x1c1c1e, rough: 0.92, metal: 0.0 },
  rubber: { color: 0x151515, rough: 0.85, metal: 0.0 },
  plastic_black: { color: 0x121213, rough: 0.5, metal: 0.0 },
  chrome: { color: 0xc8c8c8, rough: 0.15, metal: 1.0 },
  skin: { color: 0xb08a72, rough: 0.6, metal: 0.0 },
};

function looksLikeStub(m: THREE.MeshStandardMaterial): boolean {
  return !m.map && !m.normalMap && !m.roughnessMap;
}

export function wearMaterial(base: THREE.Material, p: Partial<WearParams>): THREE.MeshStandardMaterial {
  const src = base as THREE.MeshStandardMaterial;
  const m = src.clone() as THREE.MeshStandardMaterial;
  const params: WearParams = {
    wear: 0.8, wearColor: new THREE.Color(0.7, 0.7, 0.7), wearMetal: 1, wearRough: 0.3, cavity: 0.5,
    edgeLo: 180, edgeHi: 700, noiseScale: 1, ...p,
  };
  const uniforms = {
    uWear: { value: params.wear },
    uWearColor: { value: params.wearColor },
    uWearMetal: { value: params.wearMetal },
    uWearRough: { value: params.wearRough },
    uCavity: { value: params.cavity },
    uEdge: { value: new THREE.Vector2(params.edgeLo, params.edgeHi) },
    uNoiseScale: { value: params.noiseScale },
  };
  const prev = src.onBeforeCompile;
  const prevKey = src.customProgramCacheKey?.bind(src);
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWearPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWearPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWearPos;
uniform float uWear; uniform vec3 uWearColor; uniform float uWearMetal; uniform float uWearRough; uniform float uCavity; uniform vec2 uEdge; uniform float uNoiseScale;
float wHash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float wNoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(wHash(i),wHash(i+vec3(1,0,0)),f.x), mix(wHash(i+vec3(0,1,0)),wHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(wHash(i+vec3(0,0,1)),wHash(i+vec3(1,0,1)),f.x), mix(wHash(i+vec3(0,1,1)),wHash(i+vec3(1,1,1)),f.x),f.y), f.z); }
`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float wearMask = 0.0; float cavMask = 0.0;
{
  vec3 wn = normalize(vNormal);
  vec3 wp = -vViewPosition;
  vec3 dnx = dFdx(wn), dny = dFdy(wn), dpx = dFdx(wp), dpy = dFdy(wp);
  float curv = 0.5 * (dot(dnx, dpx) / max(dot(dpx, dpx), 1e-12) + dot(dny, dpy) / max(dot(dpy, dpy), 1e-12));
  vec3 np = vWearPos * uNoiseScale;
  float n1 = wNoise(np * 1400.0) * 0.45 + wNoise(np * 380.0) * 0.35 + wNoise(np * 90.0) * 0.2;
  float edge = smoothstep(uEdge.x, uEdge.y, curv + (n1 - 0.5) * uEdge.x * 1.2);
  wearMask = clamp(edge * uWear * smoothstep(0.3, 0.62, n1 + 0.15), 0.0, 1.0);
  cavMask = smoothstep(uEdge.x * 0.6, uEdge.y, -curv) * uCavity;
  // subtle large-scale handling grime / sheen variation
  float grime = wNoise(np * 40.0);
  diffuseColor.rgb *= mix(0.9, 1.08, grime);
  diffuseColor.rgb = mix(diffuseColor.rgb, uWearColor, wearMask);
  diffuseColor.rgb *= 1.0 - cavMask * 0.55;
}
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, uWearRough, wearMask);
roughnessFactor = min(1.0, roughnessFactor + cavMask * 0.25);
`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uWearMetal, wearMask);
`);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|gunwear';
  return m;
}

export interface GunMaterials {
  anodized: THREE.MeshStandardMaterial;
  parkerized: THREE.MeshStandardMaterial;
  steelDark: THREE.MeshStandardMaterial;
  polymer: THREE.MeshStandardMaterial;
  polymerFde: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  gloveKnuckle: THREE.MeshStandardMaterial;
  gloveFabric: THREE.MeshStandardMaterial;
  sleeve: THREE.MeshStandardMaterial;
  cuff: THREE.MeshStandardMaterial;
  follower: THREE.MeshStandardMaterial;
  engrave: THREE.MeshStandardMaterial;
  sightDot: THREE.MeshStandardMaterial;
}

export function createGunMaterials(ctx: GameContext): GunMaterials {
  type Opts = { tileSize?: number; seed?: number; wear?: number; mapping?: 'object' | 'world' | 'uv' };
  const get = (name: MaterialName, opts?: Opts) => {
    let base: THREE.MeshStandardMaterial;
    try { base = ctx.materials.get(name, { mapping: 'object', ...opts } as never) as THREE.MeshStandardMaterial; }
    catch { base = new THREE.MeshStandardMaterial(); }
    return base;
  };
  /**
   * Real library materials (patched by the materials lead: object-space triplanar + curvature edge wear) are used
   * as-is (they must not be cloned: their shader patch lives in a closure). On stub materials we apply our own
   * edge-wear layer and sane PBR fallbacks so the viewmodel still reads correctly.
   */
  const W = (name: MaterialName, wp: Partial<WearParams>, opts?: Opts) => {
    const base = get(name, opts);
    if (base.userData?.sh) return base;
    const m = wearMaterial(base, wp);
    const fb = FALLBACKS[name];
    if (fb && looksLikeStub(m)) { m.color.setHex(fb.color); m.roughness = fb.rough; m.metalness = fb.metal; }
    if (!m.envMap && ctx.materials.envMap) m.envMap = ctx.materials.envMap;
    return m;
  };

  const anodized = W('gun_anodized', { wear: 0.85, wearColor: new THREE.Color(0.62, 0.62, 0.6), wearMetal: 1, wearRough: 0.32, cavity: 0.6 }, { tileSize: 0.4 });
  const parkerized = W('gun_parkerized', { wear: 0.55, wearColor: new THREE.Color(0.42, 0.42, 0.43), wearMetal: 1, wearRough: 0.3, cavity: 0.5 }, { tileSize: 0.25 });
  const steelDark = W('gun_parkerized', { wear: 0.3, wearColor: new THREE.Color(0.35, 0.35, 0.36), wearMetal: 1, wearRough: 0.35, cavity: 0.6 }, { tileSize: 0.2, seed: 3 });
  const polymer = W('gun_polymer_black', { wear: 0.35, wearColor: new THREE.Color(0.2, 0.2, 0.2), wearMetal: 0, wearRough: 0.45, cavity: 0.5 }, { tileSize: 0.2 });
  const polymerFde = W('gun_polymer_fde', { wear: 0.4, wearColor: new THREE.Color(0.78, 0.68, 0.52), wearMetal: 0, wearRough: 0.5, cavity: 0.55 }, { tileSize: 0.2 });
  const rubber = W('rubber', { wear: 0.0, cavity: 0.4 }, { tileSize: 0.1 });
  const glove = W('glove_leather', { wear: 0.25, wearColor: new THREE.Color(0.35, 0.33, 0.3), wearMetal: 0, wearRough: 0.7, cavity: 0.5, edgeLo: 120, edgeHi: 500 }, { tileSize: 0.05 });
  const gloveKnuckle = W('rubber', { wear: 0.2, wearColor: new THREE.Color(0.18, 0.18, 0.18), wearMetal: 0, wearRough: 0.6, cavity: 0.6 }, { tileSize: 0.08, seed: 7 });
  const gloveFabric = W('cloth_black', { wear: 0, cavity: 0.5 }, { tileSize: 0.12 });
  const sleeve = W('cloth_multicam', { wear: 0, cavity: 0.6 }, { tileSize: 0.4 });
  const cuff = W('cloth_olive', { wear: 0, cavity: 0.5 }, { tileSize: 0.25 });

  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1, roughness: 0.28, envMap: ctx.materials.envMap ?? null });
  const copper = new THREE.MeshStandardMaterial({ color: 0xb5714a, metalness: 1, roughness: 0.3, envMap: ctx.materials.envMap ?? null });
  const follower = new THREE.MeshStandardMaterial({ color: 0x5b5d5f, metalness: 0, roughness: 0.55 });
  const engrave = new THREE.MeshStandardMaterial({ color: 0x8a8a88, metalness: 0.9, roughness: 0.45, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const sightDot = new THREE.MeshStandardMaterial({ color: 0x223322, emissive: new THREE.Color(0.6, 1.0, 0.3), emissiveIntensity: 1.2, roughness: 0.3 });
  return { anodized, parkerized, steelDark, polymer, polymerFde, rubber, brass, copper, glove, gloveKnuckle, gloveFabric, sleeve, cuff, follower, engrave, sightDot };
}

// ------------------------------------------------------------------------------------------------
// Holographic / red-dot lens with a reticle projected at infinity.
// The reticle is evaluated from the view ray expressed in the optic's local frame, so it always sits on
// the optic's axis (parallax-free), regardless of where the eye is relative to the window.
// ------------------------------------------------------------------------------------------------
export function createReticleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
      uColor: { value: new THREE.Color(1.0, 0.08, 0.04) },
      uIntensity: { value: 6.0 },
      uRing: { value: 0.032 },   // ring radius (radians, stylized)
      uDot: { value: 0.0018 },   // center dot radius (radians)
      uTint: { value: new THREE.Color(0.55, 0.75, 0.9) },
      uTime: { value: 0 },
      uWindow: { value: new THREE.Vector4(0.0148, 0.0112, 0.004, 0) }, // half extents + corner radius for the lens mask
      uADS: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vLocal;
      varying vec3 vViewPos;
      varying vec3 vViewNormal;
      void main() {
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uCamLocal; uniform vec3 uColor; uniform float uIntensity; uniform float uRing; uniform float uDot;
      uniform vec3 uTint; uniform float uTime; uniform vec4 uWindow; uniform float uADS;
      varying vec3 vLocal; varying vec3 vViewPos; varying vec3 vViewNormal;
      float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      void main() {
        vec3 d = normalize(vLocal - uCamLocal);
        // angular coordinates of the view ray relative to the optic axis (-Z), in radians (tangent space)
        vec2 a = d.xy / max(-d.z, 1e-4);
        float r = length(a);
        float px = max(fwidth(r), 1e-6);
        float ringW = uRing * 0.075;
        float ring = 1.0 - smoothstep(ringW * 0.5 - px, ringW * 0.5 + px, abs(r - uRing));
        // ring tick marks (EOTech-style) at 12/3/6/9 o'clock, just inside the ring
        vec2 aa = abs(a);
        float tickLen = uRing * 0.28;
        float tv = (1.0 - smoothstep(ringW * 0.4 - px, ringW * 0.4 + px, aa.x)) * step(uRing - tickLen, aa.y) * step(aa.y, uRing);
        float th = (1.0 - smoothstep(ringW * 0.4 - px, ringW * 0.4 + px, aa.y)) * step(uRing - tickLen, aa.x) * step(aa.x, uRing);
        float dotv = 1.0 - smoothstep(uDot - px, uDot + px, r);
        float shape = max(max(ring, dotv), max(tv, th));
        float glow = exp(-abs(r - uRing) / (uRing * 0.09)) * 0.22 + exp(-r / (uDot * 3.0)) * 0.35;
        // holographic grain flicker
        float grain = fract(sin(dot(floor(a * 3000.0), vec2(12.9898, 78.233)) + uTime * 0.0) * 43758.5453);
        float ret = (shape * (0.85 + 0.15 * grain) + glow) * uIntensity;
        // window mask so the reticle never renders on the frame
        float m = 1.0 - smoothstep(-0.0004, 0.0002, sdRoundRect(vLocal.xy - vec2(0.0, 0.0), uWindow.xy, uWindow.z));
        // coating tint + fake reflection (view-space fresnel)
        vec3 V = normalize(-vViewPos);
        float fres = pow(1.0 - abs(dot(V, normalize(vViewNormal))), 3.0);
        vec3 refl = uTint * (0.05 + 0.5 * fres) * (0.7 + 0.3 * sin(vLocal.x * 300.0 + vLocal.y * 200.0));
        vec3 col = uColor * ret * m + refl * m;
        float alpha = clamp(0.1 + fres * 0.3 + ret * 0.5, 0.0, 1.0) * m;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------------------------------------------------------
// Procedural canvas textures for muzzle flash / smoke.
// ------------------------------------------------------------------------------------------------
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}
function tex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Side-on flame tongue: muzzle at the left edge center, flame toward +x. */
export function flameSideTexture(seed: number): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const len = 90 + rnd() * 150;
    const ang = (rnd() - 0.5) * 0.5;
    const w = 6 + rnd() * 16;
    const x0 = rnd() * 20;
    g.save();
    g.translate(x0, 64);
    g.rotate(ang);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,240,200,0.55)');
    grad.addColorStop(0.35, 'rgba(255,170,70,0.35)');
    grad.addColorStop(1, 'rgba(255,90,20,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -w * 0.3);
    g.quadraticCurveTo(len * 0.35, -w, len, 0);
    g.quadraticCurveTo(len * 0.35, w, 0, w * 0.3);
    g.closePath();
    g.fill();
    g.restore();
  }
  const core = g.createRadialGradient(10, 64, 0, 10, 64, 60);
  core.addColorStop(0, 'rgba(255,255,240,1)');
  core.addColorStop(0.4, 'rgba(255,200,120,0.5)');
  core.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, 256, 128);
  return tex(c);
}

/** Front-on star burst (viewed down the bore). */
export function flameStarTexture(seed: number, spikes: number): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  let s = seed * 7919 + 104729;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.globalCompositeOperation = 'lighter';
  g.translate(128, 128);
  const off = rnd() * Math.PI;
  for (let i = 0; i < spikes; i++) {
    const a = off + (i / spikes) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
    const len = 60 + rnd() * 66;
    const w = 10 + rnd() * 12;
    g.save();
    g.rotate(a);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,245,210,0.9)');
    grad.addColorStop(0.4, 'rgba(255,170,60,0.55)');
    grad.addColorStop(1, 'rgba(255,80,10,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -w);
    g.quadraticCurveTo(len * 0.3, -w * 0.5, len, 0);
    g.quadraticCurveTo(len * 0.3, w * 0.5, 0, w);
    g.closePath();
    g.fill();
    g.restore();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 70);
  core.addColorStop(0, 'rgba(255,255,245,1)');
  core.addColorStop(0.3, 'rgba(255,210,140,0.7)');
  core.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = core;
  g.beginPath(); g.arc(0, 0, 70, 0, Math.PI * 2); g.fill();
  return tex(c);
}

export function glowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,230,190,1)');
  r.addColorStop(0.2, 'rgba(255,170,90,0.6)');
  r.addColorStop(0.5, 'rgba(255,110,40,0.15)');
  r.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return tex(c);
}

export function smokeTexture(seed: number): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  let s = seed * 3301 + 17;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 40; i++) {
    const x = 64 + (rnd() - 0.5) * 60, y = 64 + (rnd() - 0.5) * 60, r = 10 + rnd() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rnd() * 0.08;
    gr.addColorStop(0, `rgba(235,235,235,${a})`);
    gr.addColorStop(1, 'rgba(235,235,235,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  }
  return tex(c);
}

/** Canvas decal (engraving / roll mark). Light glyphs on transparent background. */
export function engravingTexture(lines: { text: string; x: number; y: number; size: number; bold?: boolean }[], w = 512, h = 128): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.textBaseline = 'middle';
  for (const l of lines) {
    g.font = `${l.bold ? '700' : '500'} ${l.size}px "Arial Narrow", Arial, sans-serif`;
    g.fillText(l.text, l.x, l.y);
  }
  const t = tex(c);
  t.anisotropy = 8;
  return t;
}

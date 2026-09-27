import * as THREE from 'three';
import { FLIP_FRAMES, FLIP_GRID } from './flipbook';
import { InstancePool } from './pool';

/**
 * Lit, soft, flipbook billboard particles: smoke, dust, dirt plumes, blood mist, fireballs.
 *
 * Motion is analytic (closed-form drag + constant acceleration + wind), so a particle's data is
 * uploaded once at spawn and never touched again; per frame only `uTime` changes.
 *
 * Lighting uses three's light uniforms (lights: true): every directional/sun light with a
 * wrap-diffuse + forward-scatter model against the flipbook pseudo-normals, sun shadows via
 * getShadowMask(), hemisphere/ambient/probe irradiance, and point lights (muzzle/explosion flashes
 * light the smoke). Soft fade against the scene is analytic: every particle carries the plane of
 * the surface it was spawned from (wall, floor) and fades where the view ray meets that plane.
 */

export const SMOKE_STRIDE = 36;

/** Mutable spawn descriptor (fill, then call spawn) – avoids per-spawn allocations. */
export class SmokeParams {
  px = 0; py = 0; pz = 0;
  vx = 0; vy = 0; vz = 0;
  life = 1;
  size0 = 0.2; size1 = 1;
  rot = 0; rotSpeed = 0;
  drag = 2; accelY = 0.3;
  frame0 = 0; frameRate = 1;
  r = 0.5; g = 0.5; b = 0.5; opacity = 1;
  /** soft plane: n.x n.y n.z d (n·x + d = 0); n = 0 disables */
  nx = 0; ny = 0; nz = 0; d = 0;
  heat = 0;
  normalStrength = 1;
  orient = 0; // 1 = lies in the plane (shockwave rings)
  fadeIn = 0.05;
  fadePow = 1.5;
  softMul = 0.5;
  delay = 0;
  scatter = 1;
  /** size growth curve: 1 - (1 - x)^growPow (higher = faster initial expansion) */
  growPow = 2.6;
  reset(): this {
    this.vx = this.vy = this.vz = 0; this.rot = 0; this.rotSpeed = 0; this.drag = 2; this.accelY = 0.3;
    this.frame0 = 0; this.frameRate = 1; this.opacity = 1; this.nx = this.ny = this.nz = this.d = 0;
    this.heat = 0; this.normalStrength = 1; this.orient = 0; this.fadeIn = 0.05; this.fadePow = 1.5; this.softMul = 0.5;
    this.delay = 0; this.scatter = 1; this.growPow = 2.6;
    return this;
  }
  plane(n: THREE.Vector3, p: THREE.Vector3): this {
    this.nx = n.x; this.ny = n.y; this.nz = n.z; this.d = -(n.x * p.x + n.y * p.y + n.z * p.z);
    return this;
  }
  at(p: THREE.Vector3): this { this.px = p.x; this.py = p.y; this.pz = p.z; return this; }
  vel(x: number, y: number, z: number): this { this.vx = x; this.vy = y; this.vz = z; return this; }
  color(r: number, g: number, b: number, a = 1): this { this.r = r; this.g = g; this.b = b; this.opacity = a; return this; }
}

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>

attribute vec4 iPos;   // p0.xyz, t0
attribute vec4 iVel;   // v0.xyz, life
attribute vec4 iSize;  // size0, size1, rot0, rotSpeed
attribute vec4 iPhys;  // drag, accelY, frame0, frameRate
attribute vec4 iColor; // albedo, opacity
attribute vec4 iPlane; // soft plane
attribute vec4 iFx;    // heat, normalStrength, orient, fadeIn
attribute vec4 iFx2;   // fadePow, softMul, scatter, mirror
attribute vec4 iFx3;   // growPow, -, -, -

uniform float uTime;
uniform vec3 uWind;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
varying vec3 vViewPos;
varying vec4 vPlane;
varying float vFrame;
varying float vHeat;
varying float vNStr;
varying float vSoft;
varying float vScatter;
varying vec3 vT;
varying vec3 vB;
varying vec3 vN;

void main() {
  float age = uTime - iPos.w;
  float life = iVel.w;
  float x = age / life;
  if (life <= 0.0 || x < 0.0 || x >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float k = max(iPhys.x, 0.001);
  vec3 acc = vec3(0.0, iPhys.y, 0.0) + uWind * k;
  vec3 vt = acc / k;
  float e = exp(-k * age);
  vec3 p = iPos.xyz + vt * age + (iVel.xyz - vt) * (1.0 - e) / k;

  float grow = 1.0 - pow(1.0 - x, iFx3.x);
  float size = mix(iSize.x, iSize.y, grow);
  float rot = iSize.z + iSize.w * (1.0 - exp(-1.5 * age)) / 1.5;
  vec2 cs = vec2(cos(rot), sin(rot));
  vec2 c = position.xy;
  vec2 rc = vec2(c.x * cs.x - c.y * cs.y, c.x * cs.y + c.y * cs.x);

  vec3 wpos;
  if (iFx.z > 0.5) {
    vec3 n = iPlane.xyz;
    vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    wpos = p + (t * rc.x + b * rc.y) * size + n * 0.03;
    mat3 vm = mat3(viewMatrix);
    vec3 tv = normalize(vm * t), bv = normalize(vm * b);
    vT = normalize(tv * cs.x + bv * cs.y);
    vB = normalize(-tv * cs.y + bv * cs.x);
    vN = normalize(vm * n);
  } else {
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    wpos = p + (camRight * rc.x + camUp * rc.y) * size;
    vT = vec3(cs.x, cs.y, 0.0);
    vB = vec3(-cs.y, cs.x, 0.0);
    vN = vec3(0.0, 0.0, 1.0);
  }

  vec4 worldPosition = vec4(wpos, 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>

  vUv = iFx2.w > 0.5 ? vec2(1.0 - uv.x, uv.y) : uv;
  float fadeIn = smoothstep(0.0, max(iFx.w, 1e-4), x);
  float fadeOut = pow(1.0 - x, iFx2.x);
  vColor = vec4(iColor.rgb, iColor.a * fadeIn * fadeOut);
  vWorld = wpos;
  vViewPos = mvPosition.xyz;
  vPlane = iPlane;
  vFrame = min(iPhys.z + x * iPhys.w * ${(FLIP_FRAMES - 1).toFixed(1)}, ${(FLIP_FRAMES - 1).toFixed(1)});
  vHeat = iFx.x * pow(max(1.0 - x * 1.6, 0.0), 1.4);
  vNStr = iFx.y;
  vSoft = max(0.03, size * iFx2.y);
  vScatter = iFx2.z;

  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uFlip;
uniform vec3 uAmbientAdd;
uniform vec2 uNearFade;
uniform float uHeatIntensity;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
varying vec3 vViewPos;
varying vec4 vPlane;
varying float vFrame;
varying float vHeat;
varying float vNStr;
varying float vSoft;
varying float vScatter;
varying vec3 vT;
varying vec3 vB;
varying vec3 vN;

vec2 cellUv(float f, vec2 uv) {
  return (vec2(mod(f, ${FLIP_GRID.toFixed(1)}), floor(f / ${FLIP_GRID.toFixed(1)})) + uv) / ${FLIP_GRID.toFixed(1)};
}

vec3 fireRamp(float t) {
  vec3 c = mix(vec3(0.0), vec3(0.55, 0.04, 0.0), smoothstep(0.0, 0.3, t));
  c = mix(c, vec3(1.0, 0.32, 0.03), smoothstep(0.25, 0.55, t));
  c = mix(c, vec3(1.0, 0.72, 0.25), smoothstep(0.5, 0.8, t));
  c = mix(c, vec3(1.0, 0.95, 0.8), smoothstep(0.8, 1.0, t));
  return c;
}

float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

void main() {
  #include <logdepthbuf_fragment>
  float fi = floor(vFrame);
  float fr = vFrame - fi;
  vec4 ta = texture2D(uFlip, cellUv(fi, vUv));
  vec4 tb = texture2D(uFlip, cellUv(min(fi + 1.0, ${(FLIP_FRAMES - 1).toFixed(1)}), vUv));
  vec4 tex = mix(ta, tb, fr);

  float alpha = tex.a * vColor.a;

  // analytic soft fade against the spawn surface plane
  vec3 rd = vWorld - cameraPosition;
  float tf = length(rd);
  rd /= tf;
  float pn = dot(vPlane.xyz, vPlane.xyz);
  if (pn > 0.5) {
    float camSide = dot(vPlane.xyz, cameraPosition) + vPlane.w;
    float denom = dot(vPlane.xyz, rd);
    if (camSide > 0.0 && denom < -1e-4) {
      float ts = -camSide / denom;
      alpha *= clamp((ts - tf) / vSoft, 0.0, 1.0);
    }
  }
  alpha *= smoothstep(uNearFade.x, uNearFade.y, tf);
  if (alpha < 0.003) discard;

  vec2 nxy = (tex.rg * 2.0 - 1.0) * vNStr;
  vec3 nts = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
  vec3 N = normalize(vT * nts.x + vB * nts.y + vN * nts.z);
  vec3 V = normalize(-vViewPos);
  float thick = tex.b;

  vec3 direct = vec3(0.0);
  IncidentLight il;
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {{
    getDirectionalLightInfo(directionalLights[i], il);
    float ndl = dot(N, il.direction);
    float wrap = max((ndl + 0.8) / 1.8, 0.0);
    float scat = phaseHG(dot(V, -il.direction), 0.6) * 4.0 * vScatter * (1.0 - thick * 0.85);
    // wrap diffuse + multiple-scattering transmission through thin parts + forward scatter
    direct += il.color * (wrap * wrap * mix(1.0, 0.8, thick) + 0.18 * (1.0 - thick) + scat);}
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_SUN_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_SUN_LIGHTS; i++) {{
    getSunLightInfo(sunLights[i], il);
    float ndl = dot(N, il.direction);
    float wrap = max((ndl + 0.8) / 1.8, 0.0);
    float scat = phaseHG(dot(V, -il.direction), 0.6) * 4.0 * vScatter * (1.0 - thick * 0.85);
    // wrap diffuse + multiple-scattering transmission through thin parts + forward scatter
    direct += il.color * (wrap * wrap * mix(1.0, 0.8, thick) + 0.18 * (1.0 - thick) + scat);}
  }
  #pragma unroll_loop_end
  #endif
  #ifdef USE_SHADOWMAP
  direct *= getShadowMask();
  #endif

  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_POINT_LIGHTS; i++) {{
    getPointLightInfo(pointLights[i], vViewPos, il);
    float ndl = dot(N, il.direction);
    direct += il.color * (max(ndl, 0.0) * 0.4 + 0.2);}
  }
  #pragma unroll_loop_end
  #endif

  vec3 irr = ambientLightColor + uAmbientAdd;
  #if defined( USE_LIGHT_PROBES )
  irr += getLightProbeIrradiance(lightProbe, N);
  #endif
  #if NUM_HEMI_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {{
    irr += getHemisphereLightIrradiance(hemisphereLights[i], N);}
  }
  #pragma unroll_loop_end
  #endif
  irr *= mix(1.0, 0.78, thick);

  vec3 col = vColor.rgb * (direct + irr) * RECIPROCAL_PI;

  // fire / incandescence
  float temp = clamp(vHeat * (0.2 + 0.85 * thick), 0.0, 1.0);
  vec3 emis = fireRamp(temp) * pow(temp, 2.2) * uHeatIntensity;
  col = col * (1.0 - clamp(vHeat, 0.0, 1.0) * 0.7) + emis;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
  #endif
  // premultiplied; hot parts become partly additive
  float outA = alpha * (1.0 - clamp(vHeat, 0.0, 1.0) * 0.55);
  gl_FragColor = vec4(gl_FragColor.rgb * alpha, outA);
}
`;

export class SmokeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private pool: InstancePool;
  private data: Float32Array;

  constructor(capacity: number, flipbook: THREE.Texture) {
    this.pool = new InstancePool(capacity, SMOKE_STRIDE);
    this.data = this.pool.data;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.pool.buffer;
    const names = ['iPos', 'iVel', 'iSize', 'iPhys', 'iColor', 'iPlane', 'iFx', 'iFx2', 'iFx3'];
    names.forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    geo.instanceCount = capacity;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.lights,
        THREE.UniformsLib.fog,
        {
          uFlip: { value: flipbook },
          uTime: { value: 0 },
          uWind: { value: new THREE.Vector3() },
          uAmbientAdd: { value: new THREE.Color(0, 0, 0) },
          uNearFade: { value: new THREE.Vector2(0.12, 0.7) },
          uHeatIntensity: { value: 16 },
        },
      ]),
      lights: true,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    // UniformsUtils.merge clones textures' owners fine, but make sure the flipbook is the shared instance
    this.material.uniforms.uFlip.value = flipbook;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'fx:smoke';
  }

  get liveCount(): number { return this.pool.liveEstimate(this.time); }
  private time = 0;

  setTime(t: number): void {
    this.time = t;
    this.material.uniforms.uTime.value = t;
  }

  spawn(p: SmokeParams): void {
    const o = this.pool.alloc(this.time + p.delay, p.life);
    const d = this.data;
    d[o] = p.px; d[o + 1] = p.py; d[o + 2] = p.pz; d[o + 3] = this.time + p.delay;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = p.life;
    d[o + 8] = p.size0; d[o + 9] = p.size1; d[o + 10] = p.rot; d[o + 11] = p.rotSpeed;
    d[o + 12] = p.drag; d[o + 13] = p.accelY; d[o + 14] = p.frame0; d[o + 15] = p.frameRate;
    d[o + 16] = p.r; d[o + 17] = p.g; d[o + 18] = p.b; d[o + 19] = p.opacity;
    d[o + 20] = p.nx; d[o + 21] = p.ny; d[o + 22] = p.nz; d[o + 23] = p.d;
    d[o + 24] = p.heat; d[o + 25] = p.normalStrength; d[o + 26] = p.orient; d[o + 27] = p.fadeIn;
    d[o + 28] = p.fadePow; d[o + 29] = p.softMul; d[o + 30] = p.scatter; d[o + 31] = Math.random() < 0.5 ? 1 : 0;
    d[o + 32] = p.growPow; d[o + 33] = 0; d[o + 34] = 0; d[o + 35] = 0;
  }

  flush(): void { this.pool.flush(); }
}

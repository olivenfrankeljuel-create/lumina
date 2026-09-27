import * as THREE from 'three';
import { InstancePool } from './pool';

/**
 * Velocity-aligned, motion-stretched streak particles in one draw call:
 *  - additive emissive (sparks, embers, glints, tracers, flash dots)   mode.w = 1
 *  - lit alpha (dust grains, dirt clods, blood droplets, splinter streaks) mode.w = 0
 * Blending is premultiplied (ONE, ONE_MINUS_SRC_ALPHA): additive instances write alpha 0.
 *
 * Head and tail are the analytic trajectory at `age` and `age - stretch`, so streaks curve
 * under gravity/drag exactly like real long-exposure sparks. Quads are expanded in screen space
 * with a minimum pixel width (and matching energy falloff) so thin sparks never alias to nothing.
 * Optional plane bounce (mirror about the spawn/floor plane with restitution).
 */
export const STREAK_STRIDE = 24;

export class StreakParams {
  px = 0; py = 0; pz = 0;
  vx = 0; vy = 0; vz = 0;
  life = 0.5;
  width = 0.01; stretch = 0.02; drag = 1; gravity = 9.8;
  r = 1; g = 1; b = 1; a = 1;
  nx = 0; ny = 0; nz = 0; d = 0;
  cool = 1; constant = 0; restitution = 0.3; additive = 1;
  delay = 0;
  reset(): this {
    this.vx = this.vy = this.vz = 0; this.drag = 1; this.gravity = 9.8; this.a = 1;
    this.nx = this.ny = this.nz = this.d = 0; this.cool = 1; this.constant = 0; this.restitution = 0.3; this.additive = 1; this.delay = 0;
    return this;
  }
  at(p: THREE.Vector3): this { this.px = p.x; this.py = p.y; this.pz = p.z; return this; }
  vel(x: number, y: number, z: number): this { this.vx = x; this.vy = y; this.vz = z; return this; }
  color(r: number, g: number, b: number, a = 1): this { this.r = r; this.g = g; this.b = b; this.a = a; return this; }
  plane(n: THREE.Vector3, p: THREE.Vector3): this {
    this.nx = n.x; this.ny = n.y; this.nz = n.z; this.d = -(n.x * p.x + n.y * p.y + n.z * p.z);
    return this;
  }
  floor(y: number): this { this.nx = 0; this.ny = 1; this.nz = 0; this.d = -y; return this; }
}

const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec4 iPos;   // p0, t0
attribute vec4 iVel;   // v0, life
attribute vec4 iParam; // width, stretch, drag, gravity
attribute vec4 iColor; // rgb, alpha
attribute vec4 iPlane; // bounce plane
attribute vec4 iMode;  // cool, constant, restitution, additive

uniform float uTime;
uniform vec2 uRes;
uniform vec3 uLit;

varying vec4 vCol;
varying vec3 vSeg; // along px, across px, length px
varying float vW;
varying float vAdd;

vec3 posAt(float t) {
  float k = max(iParam.z, 0.0005);
  vec3 acc = vec3(0.0, -iParam.w, 0.0);
  vec3 vt = acc / k;
  float e = exp(-k * t);
  vec3 p = iPos.xyz + vt * t + (iVel.xyz - vt) * (1.0 - e) / k;
  if (dot(iPlane.xyz, iPlane.xyz) > 0.5) {
    float d = dot(iPlane.xyz, p) + iPlane.w;
    if (d < 0.0) p -= iPlane.xyz * d * (1.0 + iMode.z);
  }
  return p;
}

void main() {
  float life = iVel.w;
  float age = uTime - iPos.w;
  float x = age / max(life, 1e-5);
  if (life <= 0.0 || x < 0.0 || x >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3 head = posAt(age);
  vec3 tail = posAt(max(age - iParam.y, 0.0));
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 hc = vp * vec4(head, 1.0);
  vec4 tc = vp * vec4(tail, 1.0);
  const float nearW = 0.06;
  if (hc.w < nearW && tc.w < nearW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (tc.w < nearW) tc = mix(tc, hc, (nearW - tc.w) / (hc.w - tc.w));
  if (hc.w < nearW) hc = mix(hc, tc, (nearW - hc.w) / (tc.w - hc.w));

  vec2 halfRes = 0.5 * uRes;
  vec2 hs = hc.xy / hc.w * halfRes;
  vec2 ts = tc.xy / tc.w * halfRes;
  vec2 dir = hs - ts;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float pxH = iParam.x * projectionMatrix[1][1] * halfRes.y / hc.w;
  float pxT = iParam.x * projectionMatrix[1][1] * halfRes.y / tc.w;
  float wMax = max(pxH, pxT);
  const float minPx = 0.85;
  float energy = clamp(wMax / minPx, 0.05, 1.0);
  pxH = max(pxH, minPx); pxT = max(pxT, minPx);

  bool isHead = position.x > 0.0;
  vec4 base = isHead ? hc : tc;
  float w = isHead ? pxH : pxT;
  vec2 off = perp * position.y * w + dir * position.x * w;
  base.xy += off / halfRes * base.w;
  gl_Position = base;
  #include <logdepthbuf_vertex>

  vSeg = vec3(isHead ? len + w : -w, position.y * w, len);
  vW = w;

  // colour over life
  vec3 col = iColor.rgb;
  float a = iColor.a * energy;
  if (iMode.x > 0.5) {
    float temp = 1.0 - x;
    col *= mix(vec3(1.0, 0.22, 0.04), vec3(1.0), pow(temp, 1.5)) * (0.25 + 0.75 * temp);
  }
  if (iMode.y > 0.5) a *= 1.0 - smoothstep(0.9, 1.0, x);
  else a *= pow(1.0 - x, 1.2);
  // energy spreads over the streak length (long exposure): keep it gentle
  a *= mix(1.0, clamp(3.0 * w / (len + 3.0 * w), 0.35, 1.0), iMode.w);
  vAdd = iMode.w;
  if (iMode.w < 0.5) col *= uLit;
  vCol = vec4(col, a);

  vec4 mvPosition = viewMatrix * vec4(head, 1.0);
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
varying vec4 vCol;
varying vec3 vSeg;
varying float vW;
varying float vAdd;
void main() {
  #include <logdepthbuf_fragment>
  float along = vSeg.x;
  float da = max(max(-along, along - vSeg.z), 0.0);
  float d = length(vec2(da, vSeg.y)) / vW;
  float q = max(0.0, 1.0 - d * d);
  float prof = q * q * (0.35 + 0.65 * exp(-d * d * 6.0));
  // brighter head, dimmer tail (only meaningful once the streak is longer than it is wide)
  float h = clamp(along / max(vSeg.z, 1e-3), 0.0, 1.0);
  float tailK = mix(1.0, mix(0.35, 1.0, h), clamp(vSeg.z / (2.0 * vW), 0.0, 1.0));
  float a = vCol.a * prof * tailK;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vAdd > 0.5 ? vec3(0.0) : fogColor, fogFactor);
  #endif
  gl_FragColor = vec4(gl_FragColor.rgb * a, vAdd > 0.5 ? 0.0 : a);
}
`;

export class StreakLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private pool: InstancePool;
  private data: Float32Array;
  private time = 0;

  constructor(capacity: number) {
    this.pool = new InstancePool(capacity, STREAK_STRIDE);
    this.data = this.pool.data;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.pool.buffer;
    ['iPos', 'iVel', 'iParam', 'iColor', 'iPlane', 'iMode'].forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(ib, 4, i * 4)));
    geo.instanceCount = capacity;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1920, 1080) }, uLit: { value: new THREE.Color(1, 1, 1) } },
      ]),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'fx:streaks';
  }

  setTime(t: number, resX: number, resY: number, lit: THREE.Color): void {
    this.time = t;
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uRes.value.set(resX, resY);
    u.uLit.value.copy(lit);
  }

  spawn(p: StreakParams): void {
    const t0 = this.time + p.delay;
    const o = this.pool.alloc(t0, p.life);
    const d = this.data;
    d[o] = p.px; d[o + 1] = p.py; d[o + 2] = p.pz; d[o + 3] = t0;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = p.life;
    d[o + 8] = p.width; d[o + 9] = p.stretch; d[o + 10] = p.drag; d[o + 11] = p.gravity;
    d[o + 12] = p.r; d[o + 13] = p.g; d[o + 14] = p.b; d[o + 15] = p.a;
    d[o + 16] = p.nx; d[o + 17] = p.ny; d[o + 18] = p.nz; d[o + 19] = p.d;
    d[o + 20] = p.cool; d[o + 21] = p.constant; d[o + 22] = p.restitution; d[o + 23] = p.additive;
  }

  flush(): void { this.pool.flush(); }
  liveCount(): number { return this.pool.liveEstimate(this.time); }
}

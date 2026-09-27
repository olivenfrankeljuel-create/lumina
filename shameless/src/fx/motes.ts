import * as THREE from 'three';
import { rand } from './rng';

/**
 * Ambient dust motes drifting around the camera. Fully GPU-animated (wrap-around box that is
 * fixed in world space), lit by the sun through the shadow map so motes only sparkle inside
 * sunbeams, with a strong forward-scattering phase (they glint when looking toward the sun).
 */
const vertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
attribute vec4 iSeed;
uniform float uTime;
uniform vec3 uCam;
uniform float uBox;
uniform vec3 uWind;
uniform vec2 uRes;
uniform float uSize;
varying vec2 vUv;
varying float vA;
varying vec3 vViewPos;
void main() {
  float ph = iSeed.w * 6.2831;
  vec3 wob = vec3(sin(uTime * 0.31 + ph), sin(uTime * 0.23 + ph * 1.7) * 0.6, cos(uTime * 0.27 + ph * 2.3)) * 0.35;
  vec3 drift = uWind * uTime * (0.6 + 0.8 * fract(iSeed.w * 7.3)) + wob + vec3(0.0, -0.02 * uTime, 0.0);
  vec3 f = fract(iSeed.xyz + (drift - uCam) / uBox);
  vec3 p = uCam + (f - 0.5) * uBox;
  vec3 ef = abs(f - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.65, 1.0, max(ef.x, max(ef.y, ef.z)));

  vec4 worldPosition = vec4(p, 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;
  float px = uSize * (0.6 + 0.8 * fract(iSeed.w * 13.1)) * projectionMatrix[1][1] * 0.5 * uRes.y / max(-mvPosition.z, 0.01);
  float energy = clamp(px / 1.3, 0.0, 1.0);
  px = max(px, 1.3);
  vec4 clip = projectionMatrix * mvPosition;
  clip.xy += position.xy * px / (0.5 * uRes) * clip.w;
  gl_Position = clip;
  vUv = position.xy;
  float dist = -mvPosition.z;
  vA = edge * energy * energy * smoothstep(0.25, 0.8, dist) * (0.7 + 0.3 * sin(uTime * 2.0 + ph * 3.0));
  vViewPos = mvPosition.xyz;
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
uniform vec3 uTint;
uniform float uIntensity;
varying vec2 vUv;
varying float vA;
varying vec3 vViewPos;
float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
void main() {
  float r2 = dot(vUv, vUv);
  float a = vA * exp(-r2 * 3.0);
  if (a < 0.003) discard;
  vec3 V = normalize(-vViewPos);
  vec3 light = vec3(0.0);
  IncidentLight il;
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {{
    getDirectionalLightInfo(directionalLights[i], il);
    light += il.color * (phaseHG(dot(V, -il.direction), 0.7) * 5.0 + 0.08);}
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_SUN_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_SUN_LIGHTS; i++) {{
    getSunLightInfo(sunLights[i], il);
    light += il.color * (phaseHG(dot(V, -il.direction), 0.7) * 5.0 + 0.08);}
  }
  #pragma unroll_loop_end
  #endif
  #ifdef USE_SHADOWMAP
  light *= getShadowMask();
  #endif
  vec3 col = uTint * light * uIntensity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    a *= 1.0 - fogFactor;
  #endif
  gl_FragColor = vec4(gl_FragColor.rgb * a, 0.0);
}
`;

export class Motes {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(count: number, box = 14) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.lights,
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: box },
          uWind: { value: new THREE.Vector3(0.3, 0.02, 0.1) }, uRes: { value: new THREE.Vector2(1920, 1080) },
          uSize: { value: 0.0035 }, uTint: { value: new THREE.Color(1.0, 0.93, 0.82) }, uIntensity: { value: 1.0 },
        },
      ]),
      lights: true,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 13;
    this.mesh.name = 'fx:motes';
  }
  update(t: number, cam: THREE.Vector3, resX: number, resY: number, wind: THREE.Vector3): void {
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(cam);
    u.uRes.value.set(resX, resY);
    u.uWind.value.copy(wind).multiplyScalar(0.35);
  }
}

import * as THREE from 'three';

/**
 * onBeforeCompile patch for MeshStandardMaterial / MeshPhysicalMaterial.
 *
 * Mapping modes (define SH_MAP):
 *   0 world  — triplanar in world space (meters / tileSize). Box faces take one projection (cheap, exact,
 *              with analytic tangent frames and optional parallax occlusion mapping); curved surfaces blend.
 *   1 object — triplanar in the mesh's own (pre-skinning) space: texture sticks to moving/skinned meshes.
 *   2 uv     — mesh UVs scaled by 1/tileSize.
 * Also: stochastic anti-tiling (SH_STOCH), macro variation, per-instance seed offset/tint, runtime wear
 * (cavity grime + dust on up-facing surfaces + ground-contact grime), Toksvig-style specular AA,
 * specular occlusion and micro-shadowing from the packed AO.
 */

export interface InjectFlags {
  mapping: 0 | 1 | 2;
  pomSteps: number; // 0 = off
  stochastic: boolean;
  glass: boolean;
  emissive: boolean;
  edgeWear: boolean;
  dust: boolean;
}

export const shGlobals = {
  shGroundY: { value: 0 },
  shDustColor: { value: new THREE.Color(0.42, 0.34, 0.25) },
  shPomFade: { value: 14 },
};

const VERT_PARS = /* glsl */ `
varying vec3 shPos;
varying vec3 shNrm;
varying vec2 shUv;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 shPos;
varying vec3 shNrm;
varying vec2 shUv;
uniform sampler2D shA;
uniform sampler2D shN;
uniform sampler2D shO;
uniform sampler2D shMacro;
uniform float shScale;
uniform vec3 shOffset;
uniform vec3 shTint;
uniform float shWear;
uniform float shPomDepth;
uniform float shNormalScale;
uniform float shMacroAmt;
uniform float shDustAmt;
uniform float shGroundY;
uniform vec3 shDustColor;
uniform float shPomFade;
uniform vec4 shEdge; // rgb = edge-wear color (bare material), a = edge roughness

struct ShTex { vec4 a; vec4 n; vec4 o; };

ShTex shFetch(vec2 uv, vec2 dx, vec2 dy) {
  ShTex t;
  t.a = textureGrad(shA, uv, dx, dy);
  t.n = textureGrad(shN, uv, dx, dy);
  t.o = textureGrad(shO, uv, dx, dy);
  return t;
}

ShTex shSample(vec2 uv, vec2 dx, vec2 dy) {
#ifdef SH_STOCH
  // Inigo Quilez "texture repetition" technique 3: per-region random offsets blended on a slow noise.
  float k = textureLod(shMacro, uv * 0.13 + 0.371, 0.0).a;
  float l = k * 8.0;
  float fi = floor(l), ff = l - fi;
  vec2 offA = sin(vec2(3.0, 7.0) * fi) * 13.7;
  vec2 offB = sin(vec2(3.0, 7.0) * (fi + 1.0)) * 13.7;
  ShTex a = shFetch(uv + offA, dx, dy);
  ShTex b = shFetch(uv + offB, dx, dy);
  float t = smoothstep(0.25, 0.75, ff + (b.n.a - a.n.a) * 0.6);
  a.a = mix(a.a, b.a, t); a.n = mix(a.n, b.n, t); a.o = mix(a.o, b.o, t);
  return a;
#else
  return shFetch(uv, dx, dy);
#endif
}

#if SH_POM > 0
vec2 shParallax(vec2 uv, vec3 V, vec2 dx, vec2 dy, float depth) {
  // V: tangent-space direction to the eye (z > 0). depth in uv units.
  float steps = mix(float(SH_POM), float(SH_POM) * 0.35, V.z);
  float layer = 1.0 / steps;
  vec2 delta = V.xy / max(V.z, 0.2) * depth * layer;
  float cur = 0.0;
  vec2 cuv = uv;
  float d = 1.0 - textureGrad(shN, cuv, dx, dy).a;
  for (int i = 0; i < SH_POM; i++) {
    if (cur >= d) break;
    cuv -= delta;
    d = 1.0 - textureGrad(shN, cuv, dx, dy).a;
    cur += layer;
  }
  vec2 puv = cuv + delta;
  float after = d - cur;
  float before = (1.0 - textureGrad(shN, puv, dx, dy).a) - cur + layer;
  float w = after / min(after - before, -1e-4);
  return mix(cuv, puv, clamp(w, 0.0, 1.0));
}
#endif

// Cotangent frame from precomputed derivatives (safe to call inside non-uniform branches).
mat3 shTangentFrame(vec3 q0, vec3 q1, vec2 st0, vec2 st1, vec3 surf_norm) {
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}

// Accumulators
vec3 shAccA; float shAccOp; vec4 shAccO; vec3 shAccN; vec4 shAccM; float shAccH;

void shAccumulate(ShTex t, float w, vec3 nOut, vec4 mac) {
  shAccA += t.a.rgb * w; shAccOp += t.a.a * w; shAccO += t.o * w; shAccN += nOut * w; shAccM += mac * w; shAccH += t.n.a * w;
}

vec3 shDecodeN(vec4 n) {
  vec3 v = n.xyz * 2.0 - 1.0;
  v.xy *= shNormalScale;
  return v;
}

// One planar projection of the triplanar set (world/object space). axis: 0=x 1=y 2=z
void shProject(int axis, vec3 P, vec3 dPx, vec3 dPy, vec3 gN, float w, bool pom, vec3 q0, vec3 q1, vec3 normalV) {
  float sgn = gN[axis] >= 0.0 ? 1.0 : -1.0;
  vec2 uv, dx, dy; vec3 T, B;
  if (axis == 0) {
    uv = vec2(-sgn * P.z, P.y); dx = vec2(-sgn * dPx.z, dPx.y); dy = vec2(-sgn * dPy.z, dPy.y);
    T = vec3(0.0, 0.0, -sgn); B = vec3(0.0, 1.0, 0.0);
  } else if (axis == 1) {
    uv = vec2(P.x, -sgn * P.z); dx = vec2(dPx.x, -sgn * dPx.z); dy = vec2(dPy.x, -sgn * dPy.z);
    T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 0.0, -sgn);
  } else {
    uv = vec2(sgn * P.x, P.y); dx = vec2(sgn * dPx.x, dPx.y); dy = vec2(sgn * dPy.x, dPy.y);
    T = vec3(sgn, 0.0, 0.0); B = vec3(0.0, 1.0, 0.0);
  }
  vec2 uv0 = uv;
#if SH_POM > 0 && SH_MAP == 0
  if (pom) {
    vec3 V = normalize(cameraPosition - shPos);
    vec3 Vt = vec3(dot(V, T), dot(V, B), dot(V, gN));
    float fade = 1.0 - smoothstep(shPomFade * 0.6, shPomFade, length(cameraPosition - shPos));
    if (fade > 0.0 && Vt.z > 0.0) uv = shParallax(uv, Vt, dx, dy, shPomDepth * fade);
  }
#endif
  ShTex t = shSample(uv, dx, dy);
  vec4 mac = textureGrad(shMacro, uv0 * 0.137 + shOffset.xy * 0.1, dx * 0.137, dy * 0.137);
  vec3 n = shDecodeN(t.n);
#if SH_MAP == 0
  vec3 nOut = T * n.x + B * n.y + gN * n.z;
#else
  mat3 tbn = shTangentFrame(q0, q1, dx, dy, normalV);
  #ifdef DOUBLE_SIDED
    tbn[0] *= (gl_FrontFacing ? 1.0 : -1.0);
    tbn[1] *= (gl_FrontFacing ? 1.0 : -1.0);
  #endif
  vec3 nOut = tbn * n;
#endif
  shAccumulate(t, w, nOut, mac);
}
`;

const FRAG_MAIN = /* glsl */ `
{
  shAccA = vec3(0.0); shAccOp = 0.0; shAccO = vec4(0.0); shAccN = vec3(0.0); shAccM = vec4(0.0); shAccH = 0.0;
  vec3 shWorldN = vec3(0.0, 1.0, 0.0);
#if SH_MAP == 2
  {
    vec2 uv = shUv / shScale + shOffset.xy;
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    ShTex t = shSample(uv, dx, dy);
    vec4 mac = textureGrad(shMacro, uv * 0.137, dx * 0.137, dy * 0.137);
    mat3 tbn = shTangentFrame(dFdx(-vViewPosition), dFdy(-vViewPosition), dx, dy, normal);
    #ifdef DOUBLE_SIDED
      tbn[0] *= faceDirection; tbn[1] *= faceDirection;
    #endif
    shAccumulate(t, 1.0, tbn * shDecodeN(t.n), mac);
    shWorldN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  }
#else
  vec3 gN = normalize(shNrm);
  #ifdef DOUBLE_SIDED
    gN *= faceDirection;
  #endif
  vec3 P = shPos * shScale + shOffset;
  vec3 dPx = dFdx(P), dPy = dFdy(P);
  vec3 w = pow(abs(gN), vec3(10.0));
  w /= (w.x + w.y + w.z);
  int dom = (w.x > w.y && w.x > w.z) ? 0 : (w.y > w.z ? 1 : 2);
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  if (w.x > 0.02) shProject(0, P, dPx, dPy, gN, w.x, dom == 0 && w.x > 0.9, q0, q1, normal);
  if (w.y > 0.02) shProject(1, P, dPx, dPy, gN, w.y, dom == 1 && w.y > 0.9, q0, q1, normal);
  if (w.z > 0.02) shProject(2, P, dPx, dPy, gN, w.z, dom == 2 && w.z > 0.9, q0, q1, normal);
  float wsum = (w.x > 0.02 ? w.x : 0.0) + (w.y > 0.02 ? w.y : 0.0) + (w.z > 0.02 ? w.z : 0.0);
  shAccA /= wsum; shAccOp /= wsum; shAccO /= wsum; shAccM /= wsum; shAccH /= wsum;
  #if SH_MAP == 0
    shWorldN = gN;
    normal = normalize((viewMatrix * vec4(shAccN, 0.0)).xyz);
  #else
    shWorldN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    normal = normalize(shAccN);
  #endif
#endif
#if SH_MAP == 2
  normal = normalize(shAccN);
#endif

  // Specular AA: shortened (mip-averaged) normals -> extra roughness (Toksvig).
  float shNLen = length(shAccN);
  float shRough = shAccO.g;
  float shVar = clamp((1.0 - shNLen) / max(shNLen, 0.05), 0.0, 1.0);
  shRough = sqrt(min(1.0, shRough * shRough + shVar * 2.0));

  vec3 alb = shAccA * shTint;
  float mask = shAccO.a;
  // macro variation (breaks tiling on large surfaces)
  alb *= 1.0 + (shAccM.r - 0.5) * 2.0 * shMacroAmt;
  alb = mix(alb, alb * vec3(1.06, 0.99, 0.92), (shAccM.g - 0.5) * 2.0 * shMacroAmt * 2.0);
  shRough = clamp(shRough + (shAccM.g - 0.5) * shMacroAmt * 0.6, 0.02, 1.0);

  // runtime wear: cavity grime, dust
  float wear = shWear;
  float patches = smoothstep(0.35, 0.75, shAccM.b);
  float grime = clamp(mask * (0.35 + 0.65 * patches) * wear * 1.6, 0.0, 1.0);
  alb *= mix(1.0, 0.55, grime);
  shRough = mix(shRough, max(shRough, 0.85), grime * 0.7);
#ifdef SH_DUST
  float up = smoothstep(0.35, 0.95, shWorldN.y);
  float dust = clamp(shDustAmt * (0.3 + 0.7 * patches) * (0.25 + up * 1.1) * (0.6 + 0.4 * (1.0 - shAccH)), 0.0, 1.0);
  #if SH_MAP == 0
    float ground = (1.0 - smoothstep(0.0, 0.9 + shAccM.r * 0.6, shPos.y - shGroundY)) * (1.0 - abs(shWorldN.y));
    alb = mix(alb, alb * vec3(0.72, 0.66, 0.6), ground * min(1.0, wear * 1.5));
    dust = clamp(dust + ground * wear * 0.5 * patches, 0.0, 1.0);
  #endif
  alb = mix(alb, shDustColor, dust * 0.85);
  shRough = mix(shRough, 0.92, dust);
  float shMetalDust = 1.0 - dust;
#else
  float shMetalDust = 1.0;
#endif
#ifdef SH_EDGEWEAR
  {
    vec3 cn = shNrm; vec3 cp = shPos;
    float curv = length(fwidth(cn)) / max(length(fwidth(cp)), 1e-5);
    float e = smoothstep(90.0, 450.0, curv) * smoothstep(0.35, 0.65, shAccM.b + (shAccH - 0.5) * 0.3) * clamp(wear * 1.5, 0.0, 1.0);
    alb = mix(alb, shEdge.rgb, e);
    shRough = mix(shRough, shEdge.a, e);
    shAccO.b = mix(shAccO.b, 1.0, e);
  }
#endif
  diffuseColor.rgb *= alb;
  diffuseColor.a *= shAccOp;
  roughnessFactor = clamp(roughness * shRough, 0.02, 1.0);
  metalnessFactor = clamp(metalness * shAccO.b * shMetalDust, 0.0, 1.0);
  shAO = shAccO.r;
  shEmis = mask;
#ifdef SH_DUST
  shCC = 1.0 - clamp(max(grime, dust) * 1.2, 0.0, 1.0);
#else
  shCC = 1.0 - grime;
#endif
}
`;

const AO_FRAG = /* glsl */ `
{
  float ao = shAO;
  reflectedLight.indirectDiffuse *= ao;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ao;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ao;
  #endif
  float shDotNV = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(shDotNV, ao, material.roughness);
  float micro = mix(1.0, ao, 0.6);
  reflectedLight.directDiffuse *= micro;
  reflectedLight.directSpecular *= micro;
}
`;

const GLASS_OUT = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
// premultiplied output: reflections stay at full strength while the body is see-through
gl_FragColor = vec4((totalDiffuse + totalEmissiveRadiance) * diffuseColor.a + totalSpecular, diffuseColor.a);
`;

export function flagsKey(f: InjectFlags): string {
  return `sh${f.mapping}p${f.pomSteps}s${+f.stochastic}g${+f.glass}e${+f.emissive}w${+f.edgeWear}d${+f.dust}`;
}

export function patchMaterial(
  mat: THREE.MeshStandardMaterial,
  flags: InjectFlags,
  uniforms: Record<string, THREE.IUniform>,
) {
  const key = flagsKey(flags);
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, shGlobals);
    const defs = [
      `#define SH_MAP ${flags.mapping}`,
      `#define SH_POM ${flags.pomSteps}`,
      flags.stochastic ? '#define SH_STOCH' : '',
      flags.edgeWear ? '#define SH_EDGEWEAR' : '',
      flags.dust ? '#define SH_DUST' : '',
    ].join('\n');

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${defs}\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n#if SH_MAP == 1\n shNrm = objectNormal;\n#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n#if SH_MAP == 1\n shPos = transformed;\n#endif`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
#if SH_MAP == 0
  vec4 shWp = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    shWp = batchingMatrix * shWp;
  #endif
  #ifdef USE_INSTANCING
    shWp = instanceMatrix * shWp;
  #endif
  shWp = modelMatrix * shWp;
  shPos = shWp.xyz;
  shNrm = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
#elif SH_MAP == 2
  shUv = uv;
#endif`,
      );

    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${defs}\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', 'float shAO = 1.0; float shEmis = 0.0; float shCC = 1.0;')
      .replace('#include <normal_fragment_maps>', FRAG_MAIN)
      .replace('#include <aomap_fragment>', AO_FRAG)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n material.clearcoat *= shCC;\n#endif');
    if (flags.emissive) fs = fs.replace('#include <emissivemap_fragment>', '').replace('// accumulation', 'totalEmissiveRadiance *= shEmis;\n// accumulation');
    if (flags.glass) fs = fs.replace('#include <opaque_fragment>', GLASS_OUT);
    shader.fragmentShader = fs;
  };
}

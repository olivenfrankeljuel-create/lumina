import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise';

/**
 * GPU texture baker. A material generator is a GLSL function
 *   void gen(vec2 uv, inout Surf s)
 * evaluated once per texel of a periodic tile. Pass 1 writes the raw surface (albedo, height, roughness,
 * metalness, AO, grime mask, opacity) into a half-float MRT; pass 2 derives a tangent-space normal
 * map from the height field (wrapped Sobel), multiplies cavity AO and packs the final mipmapped
 * 8-bit textures:
 *   albedo  (sRGB)   rgb = base color, a = opacity
 *   normal  (linear) rgb = tangent-space normal, a = height (for parallax occlusion mapping)
 *   orm     (linear) r = AO, g = roughness, b = metalness, a = grime/cavity mask (runtime wear)
 */

export const SURF_GLSL = /* glsl */ `
struct Surf {
  vec3 albedo;   // linear base color
  float height;  // 0..1 (1 = top)
  float rough;
  float metal;
  float ao;      // explicit AO (cavity AO from height is added automatically)
  float mask;    // where grime/dust accumulates at runtime (0..1)
  float opacity;
  float emissive;
};
`;

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const genFrag = (body: string) => /* glsl */ `
precision highp float;
precision highp int;
uniform vec2 uRes;
${NOISE_GLSL}
${SURF_GLSL}
${body}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  Surf s;
  s.albedo = vec3(0.5); s.height = 0.5; s.rough = 0.8; s.metal = 0.0; s.ao = 1.0; s.mask = 0.0; s.opacity = 1.0; s.emissive = 0.0;
  gen(uv, s);
  o0 = vec4(s.albedo, s.height);
  o1 = vec4(s.rough, s.metal, s.ao, s.mask);
  o2 = vec4(s.opacity, s.emissive, 0.0, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D tA;
uniform sampler2D tB;
uniform sampler2D tC;
uniform int uMode;
uniform float uBump;      // height-units -> slope per texel
uniform float uCavity;    // cavity AO strength
uniform int uRes;
out vec4 o;
float H(ivec2 p) { return texelFetch(tA, (p + uRes) % uRes, 0).a; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(tA, p, 0);
  if (uMode == 0) {
    vec4 C = texelFetch(tC, p, 0);
    o = vec4(clamp(A.rgb, vec3(0.012), vec3(0.92)), clamp(C.x, 0.0, 1.0));
  } else if (uMode == 1) {
    float tl = H(p + ivec2(-1, 1)), t = H(p + ivec2(0, 1)), tr = H(p + ivec2(1, 1));
    float l = H(p + ivec2(-1, 0)), r = H(p + ivec2(1, 0));
    float bl = H(p + ivec2(-1, -1)), b = H(p + ivec2(0, -1)), br = H(p + ivec2(1, -1));
    float gx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0;
    float gy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / 8.0;
    vec3 n = normalize(vec3(-gx * uBump, -gy * uBump, 1.0));
    o = vec4(n * 0.5 + 0.5, clamp(A.a, 0.0, 1.0));
  } else {
    vec4 B = texelFetch(tB, p, 0);
    // cavity AO: how far this texel sits below its neighbourhood at two radii
    float h = A.a, s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398 + 0.3;
      vec2 d = vec2(cos(a), sin(a));
      s1 += H(p + ivec2(d * 3.0));
      s2 += H(p + ivec2(d * 12.0));
    }
    s1 /= 8.0; s2 /= 8.0;
    float cav = clamp(1.0 - uCavity * (max(s1 - h, 0.0) * 1.2 + max(s2 - h, 0.0) * 0.8), 0.25, 1.0);
    o = vec4(clamp(B.z * cav, 0.0, 1.0), clamp(B.x, 0.03, 1.0), clamp(B.y, 0.0, 1.0), clamp(B.w, 0.0, 1.0));
  }
}
`;

const MACRO_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform vec2 uRes;
${NOISE_GLSL}
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float a = fbm(uv + warp(uv, 2.0, 3, 0.15, 3.0), 3.0, 5, 1.0) * 0.5 + 0.5;
  float b = fbm(uv, 5.0, 5, 2.0) * 0.5 + 0.5;
  float c = fbm(uv + warp(uv, 4.0, 2, 0.08, 7.0), 6.0, 6, 3.0) * 0.5 + 0.5;
  float d = noiseT(uv, 4.0, 4.0) * 0.5 + 0.5;
  o = vec4(saturate((a - 0.5) * 1.6 + 0.5), saturate((b - 0.5) * 1.6 + 0.5), saturate((c - 0.5) * 1.8 + 0.5), saturate((d - 0.5) * 1.3 + 0.5));
}
`;

export interface BakeParams {
  glsl: string;
  res: number;
  /** Relief depth in meters for the full 0..1 height range. */
  depth: number;
  /** Tile size in meters the relief depth refers to. */
  tile: number;
  cavity: number;
  seed: number;
}

export interface BakedSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
  targets: THREE.WebGLRenderTarget[];
}

export class Baker {
  private scene = new THREE.Scene();
  private cam = new THREE.Camera();
  private quad: THREE.Mesh;
  private finalMat: THREE.RawShaderMaterial;
  private floatOk: boolean;
  readonly aniso: number;

  constructor(private renderer: THREE.WebGLRenderer, maxAniso = 16) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.floatOk = !!renderer.extensions.get('EXT_color_buffer_float') || !!renderer.extensions.get('EXT_color_buffer_half_float');
    this.aniso = Math.min(maxAniso, renderer.capabilities.getMaxAnisotropy());
    this.finalMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FINAL_FRAG,
      uniforms: {
        tA: { value: null }, tB: { value: null }, tC: { value: null },
        uMode: { value: 0 }, uBump: { value: 1 }, uCavity: { value: 1 }, uRes: { value: 1 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  private draw(mat: THREE.Material, target: THREE.WebGLRenderTarget) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.xr.enabled = prevXr;
  }

  private finalTarget(res: number, srgb: boolean): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      anisotropy: this.aniso,
    });
    return rt;
  }

  bake(p: BakeParams): BakedSet {
    const res = p.res;
    const raw = new THREE.WebGLRenderTarget(res, res, {
      count: 3,
      type: this.floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    const gen = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: genFrag(p.glsl),
      uniforms: { uRes: { value: new THREE.Vector2(res, res) }, uSeed: { value: p.seed } },
      depthTest: false, depthWrite: false,
    });
    this.draw(gen, raw);
    gen.dispose();

    const albedo = this.finalTarget(res, true);
    const normal = this.finalTarget(res, false);
    const orm = this.finalTarget(res, false);
    const u = this.finalMat.uniforms;
    u.tA.value = raw.textures[0];
    u.tB.value = raw.textures[1];
    u.tC.value = raw.textures[2];
    u.uRes.value = res;
    // slope = dh * depth / texelSize
    u.uBump.value = p.depth / (p.tile / res);
    u.uCavity.value = p.cavity;
    u.uMode.value = 0; this.draw(this.finalMat, albedo);
    u.uMode.value = 1; this.draw(this.finalMat, normal);
    u.uMode.value = 2; this.draw(this.finalMat, orm);
    raw.dispose();
    return { albedo: albedo.texture, normal: normal.texture, orm: orm.texture, targets: [albedo, normal, orm] };
  }

  bakeMacro(res: number): THREE.WebGLRenderTarget {
    const rt = this.finalTarget(res, false);
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: MACRO_FRAG,
      uniforms: { uRes: { value: new THREE.Vector2(res, res) }, uSeed: { value: 17 } },
      depthTest: false, depthWrite: false,
    });
    this.draw(m, rt);
    m.dispose();
    return rt;
  }

  dispose() {
    this.finalMat.dispose();
    this.quad.geometry.dispose();
  }
}

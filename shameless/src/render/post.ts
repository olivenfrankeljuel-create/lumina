import * as THREE from 'three';
import { Pass, Effect, EffectAttribute, BlendFunction } from 'postprocessing';

const FS_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

function fsMaterial(name: string, uniforms: Record<string, THREE.IUniform>, frag: string, defines: Record<string, string | number> = {}) {
  return new THREE.ShaderMaterial({
    name, uniforms, defines, vertexShader: FS_VERT, fragmentShader: frag,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Atmosphere pass: height fog + aerial perspective (matched to the sky cube) + dust Mie glow +
// screen-space sun shafts. World layer only (runs before the viewmodel composite).

export interface FogSettings {
  density: number;      // extinction at base height, per meter
  falloff: number;      // 1/m
  baseHeight: number;   // m
  aerial: number;       // uniform extinction per meter (distant haze)
  mie: number;          // dust forward-scatter strength
  shafts: number;       // sun-shaft strength
}

export class AtmospherePass extends Pass {
  readonly uniforms: Record<string, THREE.IUniform>;
  private maskMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  shaftsEnabled = true;
  private worldCamera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera, atmoCube: THREE.Texture, private shaftScale = 0.25) {
    super('AtmospherePass');
    this.worldCamera = camera;
    this.needsDepthTexture = true;
    this.rtA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.uniforms = {
      tDiffuse: { value: null }, tDepth: { value: null }, tAtmo: { value: atmoCube }, tShafts: { value: this.rtA.texture },
      projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Vector3(1, 1, 1) },
      density: { value: 0.004 }, falloff: { value: 0.03 }, baseHeight: { value: 0 }, aerial: { value: 0.0006 },
      mie: { value: 0.3 }, shafts: { value: 0.0 }, fogAmount: { value: 1.0 },
    };
    this.fullscreenMaterial = fsMaterial('ShamelessAtmosphere', this.uniforms, /* glsl */`
      precision highp float;
      uniform sampler2D tDiffuse; uniform highp sampler2D tDepth; uniform samplerCube tAtmo; uniform sampler2D tShafts;
      uniform mat4 projInv; uniform mat4 camWorld; uniform vec3 camPos; uniform vec3 sunDir; uniform vec3 sunColor;
      uniform float density, falloff, baseHeight, aerial, mie, shafts, fogAmount;
      varying vec2 vUv;
      float hg(float mu, float g) { float g2 = g*g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0*g*mu, 1.5)); }
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float z = texture2D(tDepth, vUv).r;
        vec3 sh = texture2D(tShafts, vUv).rgb * shafts;
        if (z >= 1.0) { gl_FragColor = vec4(c.rgb + sh, c.a); return; }
        vec4 vp = projInv * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
        vp /= vp.w;
        vec3 wp = (camWorld * vec4(vp.xyz, 1.0)).xyz;
        vec3 ray = wp - camPos; float dist = length(ray); vec3 v = ray / max(dist, 1e-4);
        // analytic exponential height fog integral
        float fy = v.y * dist * falloff;
        float heightTerm = abs(fy) > 1e-3 ? (1.0 - exp(-fy)) / fy : 1.0 - 0.5 * fy;
        float od = density * exp(-(camPos.y - baseHeight) * falloff) * dist * heightTerm + aerial * dist;
        od *= fogAmount;
        vec3 T = exp(-od * vec3(0.92, 1.0, 1.1));
        vec3 dir = normalize(vec3(v.x, clamp(v.y, 0.0, 0.08) + 0.01, v.z));
        vec3 ins = textureCube(tAtmo, dir).rgb;
        float mu = dot(v, sunDir);
        ins += sunColor * (hg(mu, 0.72) * mie);
        vec3 col = c.rgb * T + ins * (1.0 - T);
        col += sh * (1.0 - T.g * 0.7);
        gl_FragColor = vec4(col, c.a);
      }`);

    const maskUniforms = {
      tDiffuse: { value: null }, tDepth: { value: null }, sunUv: { value: new THREE.Vector2() }, aspect: { value: 1 },
      sunColor: { value: new THREE.Vector3() },
    };
    this.maskMat = fsMaterial('ShamelessShaftMask', maskUniforms, /* glsl */`
      uniform sampler2D tDiffuse; uniform highp sampler2D tDepth; uniform vec2 sunUv; uniform float aspect; uniform vec3 sunColor;
      varying vec2 vUv;
      void main() {
        float z = texture2D(tDepth, vUv).r;
        vec2 d = (vUv - sunUv) * vec2(aspect, 1.0);
        float fall = exp(-dot(d, d) * 5.0);
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // sky pixels only; clamp so the disk doesn't dominate
        float m = z >= 1.0 ? min(l, 4.0) * 0.25 : 0.0;
        gl_FragColor = vec4(sunColor * m * fall, 1.0);
      }`);
    const blurUniforms = { tInput: { value: null }, sunUv: { value: new THREE.Vector2() }, stepScale: { value: 1 } };
    this.blurMat = fsMaterial('ShamelessShaftBlur', blurUniforms, /* glsl */`
      uniform sampler2D tInput; uniform vec2 sunUv; uniform float stepScale;
      varying vec2 vUv;
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      void main() {
        const int N = 20;
        vec2 delta = (sunUv - vUv) * (stepScale / float(N));
        vec2 uv = vUv + delta * ign(gl_FragCoord.xy);
        vec3 acc = vec3(0.0); float w = 1.0, wsum = 0.0;
        for (int i = 0; i < N; i++) {
          acc += texture2D(tInput, uv).rgb * w; wsum += w; w *= 0.96; uv += delta;
        }
        gl_FragColor = vec4(acc / wsum, 1.0);
      }`);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maskMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  override setDepthTexture(depthTexture: THREE.Texture): void {
    this.uniforms.tDepth.value = depthTexture;
    this.maskMat.uniforms.tDepth.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.shaftScale)), h = Math.max(1, Math.round(height * this.shaftScale));
    this.rtA.setSize(w, h); this.rtB.setSize(w, h);
    this.maskMat.uniforms.aspect.value = width / Math.max(1, height);
  }

  private _v = new THREE.Vector3();
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.worldCamera;
    const u = this.uniforms;
    u.tDiffuse.value = inputBuffer.texture;
    u.projInv.value.copy(cam.projectionMatrixInverse);
    u.camWorld.value.copy(cam.matrixWorld);
    u.camPos.value.setFromMatrixPosition(cam.matrixWorld);

    // sun shafts
    let shaftVis = 0;
    if (this.shaftsEnabled && u.shafts.value > 0) {
      const sd = u.sunDir.value as THREE.Vector3;
      const p = this._v.copy(sd).multiplyScalar(1000).add(u.camPos.value).project(cam);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const facing = fwd.dot(sd);
      shaftVis = THREE.MathUtils.smoothstep(facing, 0.0, 0.45) * (1.0 - THREE.MathUtils.smoothstep(Math.max(Math.abs(p.x), Math.abs(p.y)), 1.3, 2.2));
      if (shaftVis > 0.001) {
        const suv = new THREE.Vector2(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
        this.maskMat.uniforms.tDiffuse.value = inputBuffer.texture;
        this.maskMat.uniforms.sunUv.value.copy(suv);
        (this.maskMat.uniforms.sunColor.value as THREE.Vector3).copy(u.sunColor.value);
        this.quad.material = this.maskMat;
        renderer.setRenderTarget(this.rtB); renderer.render(this.quadScene, this.quadCam);
        this.blurMat.uniforms.sunUv.value.copy(suv);
        this.quad.material = this.blurMat;
        this.blurMat.uniforms.tInput.value = this.rtB.texture; this.blurMat.uniforms.stepScale.value = 1.0;
        renderer.setRenderTarget(this.rtA); renderer.render(this.quadScene, this.quadCam);
        this.blurMat.uniforms.tInput.value = this.rtA.texture; this.blurMat.uniforms.stepScale.value = 0.3;
        renderer.setRenderTarget(this.rtB); renderer.render(this.quadScene, this.quadCam);
        u.tShafts.value = this.rtB.texture;
      }
    }
    const baseShafts = u.shafts.value;
    u.shafts.value = baseShafts * shaftVis;
    if (shaftVis <= 0.001) u.shafts.value = 0;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
    u.shafts.value = baseShafts;
  }

  override dispose(): void {
    super.dispose();
    this.rtA.dispose(); this.rtB.dispose(); this.maskMat.dispose(); this.blurMat.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Viewmodel pass: renders the first-person scene into its own HDR target (own depth) and composites
// it (premultiplied) over the world, with ADS depth of field applied to the weapon periphery.

export class ViewmodelPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  readonly uniforms: Record<string, THREE.IUniform>;
  private vmScene: THREE.Scene;
  private vmCamera: THREE.PerspectiveCamera;
  beforeRender: (() => void) | null = null;
  afterRender: (() => void) | null = null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super('ViewmodelPass');
    this.vmScene = scene; this.vmCamera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
    this.target.texture.name = 'Viewmodel';
    this.uniforms = {
      tDiffuse: { value: null }, tVM: { value: this.target.texture }, dof: { value: 0 },
      texel: { value: new THREE.Vector2() }, aspect: { value: 1 },
    };
    this.fullscreenMaterial = fsMaterial('ShamelessViewmodelComposite', this.uniforms, /* glsl */`
      uniform sampler2D tDiffuse; uniform sampler2D tVM; uniform float dof; uniform vec2 texel; uniform float aspect;
      varying vec2 vUv;
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      void main() {
        vec4 w = texture2D(tDiffuse, vUv);
        vec4 vm = texture2D(tVM, vUv);
        if (dof > 0.001) {
          vec2 d = (vUv - vec2(0.5)) * vec2(aspect, 1.0);
          float r = dof * smoothstep(0.06, 0.42, length(d)) * 9.0;  // blur radius in pixels
          if (r > 0.35) {
            vec4 acc = vm; float phi = ign(gl_FragCoord.xy) * 6.2831;
            const int N = 12;
            for (int i = 0; i < N; i++) {
              float fr = sqrt((float(i) + 0.5) / float(N));
              float th = float(i) * 2.39996 + phi;
              acc += texture2D(tVM, vUv + vec2(cos(th), sin(th)) * fr * r * texel);
            }
            vm = acc / float(N + 1);
          }
        }
        gl_FragColor = vec4(w.rgb * (1.0 - clamp(vm.a, 0.0, 1.0)) + vm.rgb, w.a);
      }`);
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.uniforms.texel.value.set(1 / width, 1 / height);
    this.uniforms.aspect.value = width / Math.max(1, height);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    this.beforeRender?.();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.vmScene, this.vmCamera);
    renderer.setClearColor(clearColor, clearAlpha);
    this.afterRender?.();
    this.uniforms.tDiffuse.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void { super.dispose(); this.target.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Grade effect: exposure, flash, white balance, log contrast, saturation, filmic tonemap,
// lift/gamma/gain + split toning, vignette, damage (desaturate + red edges).

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', /* glsl */`
      uniform float exposure; uniform float flash; uniform float damage; uniform float ads;
      uniform vec3 wb; uniform float contrast; uniform float saturation;
      uniform vec3 lift; uniform vec3 gammaV; uniform vec3 gain;
      uniform vec3 shadowTint; uniform vec3 highlightTint;
      uniform float vignette; uniform float tonemapMode;
      vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
      vec3 acesFitted(vec3 c) {
        const mat3 ACESIn = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
        const mat3 ACESOut = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
        c = ACESIn * (c / 0.6);
        c = RRTAndODTFit(c);
        return clamp(ACESOut * c, 0.0, 1.0);
      }
      vec3 agxContrast(vec3 x) {
        vec3 x2 = x * x; vec3 x4 = x2 * x2;
        return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
      }
      vec3 agx(vec3 c) {
        const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
        const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
        c = inset * c;
        c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
        c = agxContrast(c);
        c = outset * c;
        return clamp(pow(max(c, 0.0), vec3(2.2)), 0.0, 1.0);
      }
      // Uchimura "GT" filmic curve: linear mid section, controllable toe (c) and shoulder
      vec3 gtTonemap(vec3 x) {
        const float P = 1.0, a = 1.0, m = 0.2, l = 0.35, c = 1.12, b = 0.0;
        float l0 = ((P - m) * l) / a;
        float S0 = m + l0, S1 = m + a * l0;
        float C2 = (a * P) / (P - S1), CP = -C2 / P;
        vec3 w0 = 1.0 - smoothstep(0.0, m, x);
        vec3 w2 = step(m + l0, x);
        vec3 w1 = 1.0 - w0 - w2;
        vec3 T = m * pow(max(x, 0.0) / m, vec3(c)) + b;
        vec3 S = P - (P - S1) * exp(CP * (x - S0));
        vec3 L = m + a * (x - m);
        return clamp(T * w0 + L * w1 + S * w2, 0.0, 1.0);
      }
      vec3 gtFilmic(vec3 c) {
        // hue-stable: tonemap luminance-ish max channel, then roll saturated highlights towards white
        vec3 t = gtTonemap(c);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float lt = gtTonemap(vec3(l)).x;
        vec3 hp = c * (lt / max(l, 1e-5));
        float k = smoothstep(0.55, 1.0, lt);
        return clamp(mix(hp, t, 0.5 + 0.5 * k), 0.0, 1.0);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = max(inputColor.rgb, 0.0) * exposure * (1.0 + flash * 5.0);
        c *= wb;
        float l0 = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // contrast in log space around mid grey
        vec3 lc = log2(max(c, 1e-6) / 0.18) * contrast;
        c = 0.18 * exp2(lc);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, saturation * (1.0 - damage * 0.65)), 0.0);
        c = tonemapMode < 0.5 ? acesFitted(c) : tonemapMode < 1.5 ? agx(c) : gtFilmic(c);
        // lift / gamma / gain in display space
        vec3 g = pow(max(c, 0.0), vec3(1.0 / 2.2));
        float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
        g *= mix(shadowTint, vec3(1.0), smoothstep(0.0, 0.45, lum));
        g *= mix(vec3(1.0), highlightTint, smoothstep(0.45, 1.0, lum));
        g = g * gain + lift * (1.0 - g);
        g = pow(max(g, 0.0), 1.0 / gammaV);
        // vignette (optical falloff) + damage red edges
        vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
        float r = length(d);
        float vig = 1.0 - vignette * smoothstep(0.35, 1.05, r) - ads * 0.18 * smoothstep(0.25, 0.9, r);
        g *= vig;
        float edge = smoothstep(0.25, 0.95, r + damage * 0.2);
        g = mix(g, g * vec3(0.9, 0.18, 0.12) + vec3(0.32, 0.0, 0.0), damage * edge * 0.85);
        g = mix(g, vec3(1.0), clamp(flash, 0.0, 1.0) * 0.85);
        outputColor = vec4(pow(clamp(g, 0.0, 1.0), vec3(2.2)), inputColor.a);
      }`, {
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, THREE.Uniform>([
        ['exposure', new THREE.Uniform(1.0)], ['flash', new THREE.Uniform(0)], ['damage', new THREE.Uniform(0)], ['ads', new THREE.Uniform(0)],
        ['wb', new THREE.Uniform(new THREE.Vector3(1, 1, 1))], ['contrast', new THREE.Uniform(1.0)], ['saturation', new THREE.Uniform(1.0)],
        ['lift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))], ['gammaV', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['shadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))], ['highlightTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['vignette', new THREE.Uniform(0.3)], ['tonemapMode', new THREE.Uniform(0)],
      ]),
    });
  }
  u(name: string): THREE.Uniform { return this.uniforms.get(name)!; }
}

// ---------------------------------------------------------------------------------------------
// Final effect: edge chromatic aberration, edge blur (damage/ADS), luminance-weighted film grain.

export class FinalEffect extends Effect {
  constructor() {
    super('FinalEffect', /* glsl */`
      uniform float ca; uniform float edgeBlur; uniform float grain; uniform float seed;
      float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 dc = uv - 0.5;
        float r2 = dot(dc * vec2(aspect, 1.0), dc * vec2(aspect, 1.0));
        vec3 col = inputColor.rgb;
        if (ca > 0.0) {
          vec2 off = dc * r2 * ca;
          col.r = texture2D(inputBuffer, uv - off).r;
          col.b = texture2D(inputBuffer, uv + off).b;
        }
        if (edgeBlur > 0.001) {
          float e = smoothstep(0.08, 0.5, r2) * edgeBlur;
          if (e > 0.02) {
            vec3 acc = col; float rad = e * 6.0;
            for (int i = 0; i < 8; i++) {
              float th = float(i) * 0.785398 + hash12(gl_FragCoord.xy) * 0.78;
              acc += texture2D(inputBuffer, uv + vec2(cos(th), sin(th)) * texelSize * rad).rgb;
            }
            col = mix(col, acc / 9.0, min(1.0, e * 2.0));
          }
        }
        // grain in perceptual space, strongest in the mid-tones
        vec3 g = pow(max(col, 0.0), vec3(1.0 / 2.2));
        float lum = dot(g, vec3(0.299, 0.587, 0.114));
        float n = hash12(gl_FragCoord.xy + seed * 113.0) + hash12(gl_FragCoord.xy * 1.37 + seed * 71.0) - 1.0;
        g += n * grain * (0.35 + lum * (1.0 - lum) * 2.6);
        outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, THREE.Uniform>([
        ['ca', new THREE.Uniform(0.0)], ['edgeBlur', new THREE.Uniform(0)], ['grain', new THREE.Uniform(0.03)], ['seed', new THREE.Uniform(0)],
      ]),
    });
  }
  u(name: string): THREE.Uniform { return this.uniforms.get(name)!; }
}

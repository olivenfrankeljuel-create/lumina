import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

/**
 * Cascaded sun shadows built on three r186's native SunLight (2-3 cascades in one atlas, applied by
 * the stock lighting chunks to EVERY lit material — no per-material setup needed).
 * We subclass the shadow to (a) use a more logarithmic split so the near cascade is crisp,
 * (b) pass each cascade's texel scale to the shader for per-cascade bias/filter radius.
 * The global PCF filter is replaced with a wider rotated Vogel-disk kernel.
 */

let CASCADES = 2;
const FADE = 0.12;
const _lightOrientationMatrix = new THREE.Matrix4();
const _viewToLightMatrix = new THREE.Matrix4();
const _lightDirection = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());

export class CascadedSunShadow extends SunLightShadow {
  /** 0 = uniform splits, 1 = logarithmic. */
  splitLambda = 0.78;
  /** Minimum near-cascade far distance, meters. */
  minSplit = 8;

  constructor() {
    super();
    const self = this as unknown as {
      _cameras: THREE.OrthographicCamera[]; _matrices: THREE.Matrix4[]; _frustums: THREE.Frustum[];
      _cascadeData: THREE.Vector4[]; _viewports: THREE.Vector4[]; _cascadeSplits: number[];
      _viewportCount: number; _frameExtents: THREE.Vector2;
    };
    while (self._cameras.length < CASCADES) {
      self._cameras.push(new THREE.OrthographicCamera());
      self._matrices.push(new THREE.Matrix4());
      self._frustums.push(new THREE.Frustum());
      self._cascadeData.push(new THREE.Vector4());
    }
    while (self._viewports.length < CASCADES) self._viewports.push(new THREE.Vector4());
    self._cascadeSplits = new Array(CASCADES + 1).fill(0);
    self._viewportCount = CASCADES;
    self._frameExtents.set(CASCADES, 1);
  }

  override updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    if (viewCamera === undefined) return;
    const self = this as unknown as {
      _viewports: THREE.Vector4[]; _cascadeSplits: number[]; _cascadeData: THREE.Vector4[];
      _cameras: THREE.OrthographicCamera[]; _matrices: THREE.Matrix4[]; _frustums: THREE.Frustum[];
      _updateMatrix(c: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, v: THREE.Vector4): void;
    };
    const cam = viewCamera as THREE.PerspectiveCamera;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 2) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 2) / this.mapSize.y);
    for (let i = 0; i < CASCADES; i++) self._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = this.mapSize.x * (1 - 2 * insetX), resY = this.mapSize.y * (1 - 2 * insetY);
    const res = Math.min(resX, resY);
    const near = cam.near;
    const far = Math.max(near + 1e-6, Math.min(this.camera.far, cam.far));
    const splits = self._cascadeSplits;
    splits[0] = near;
    for (let i = 1; i < CASCADES; i++) {
      const a = i / CASCADES;
      const uni = near + (far - near) * a;
      const log = near * Math.pow(far / near, a);
      splits[i] = Math.max(this.minSplit, uni * (1 - this.splitLambda) + log * this.splitLambda);
    }
    splits[CASCADES] = far;

    _lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDirection)) > 0.99) _up.set(0, 0, 1);
    _lightOrientationMatrix.lookAt(_center.set(0, 0, 0), _lightDirection, _up);
    _viewToLightMatrix.copy(_lightOrientationMatrix).transpose().multiply(cam.matrixWorld);

    const inv = cam.projectionMatrixInverse;
    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const n = _near[i].set(x, y, -1).applyMatrix4(inv);
      _far[i].copy(n).multiplyScalar(far / near);
      n.applyMatrix4(_viewToLightMatrix);
      _far[i].applyMatrix4(_viewToLightMatrix);
      globalMaxZ = Math.max(globalMaxZ, n.z, _far[i].z);
    }
    globalMaxZ += Math.min(far, 120);
    const shadowNear = this.camera.near;
    let texel0 = 1;
    for (let i = 0; i < CASCADES; i++) {
      const cNear = i === 0 ? splits[0] : self._cascadeData[i - 1].z;
      const cFar = splits[i + 1];
      const fadeStart = cFar - FADE * (cFar - splits[i]);
      const na = (cNear - near) / (far - near), fa = (cFar - near) / (far - near);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], na);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], fa);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) { r2 = Math.max(r2, _corners[j].distanceToSquared(_center)); minZ = Math.min(minZ, _corners[j].z); }
      let radius = Math.ceil(Math.sqrt(r2)); // integer radius: stable texel size while the camera rotates
      radius /= 1 - 1 / res;
      const tx = (2 * radius) / resX, ty = (2 * radius) / resY;
      _center.x = Math.round(_center.x / tx) * tx;
      _center.y = Math.round(_center.y / ty) * ty;
      if (i === 0) texel0 = tx;
      // w = texel size ratio relative to cascade 0 (used for bias / filter radius scaling in the shader)
      self._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, tx / texel0);
      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientationMatrix);
      const c = self._cameras[i];
      c.position.copy(_center);
      c.quaternion.setFromRotationMatrix(_lightOrientationMatrix);
      c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
      c.near = shadowNear;
      c.far = globalMaxZ - minZ + 2 * shadowNear;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
      self._updateMatrix(c, self._matrices[i], self._frustums[i], self._viewports[i]);
    }
  }
}

export function createSunLight(mapSize: number, maxDistance: number): SunLight {
  const sun = new SunLight(0xffffff, 3);
  const shadow = new CascadedSunShadow();
  shadow.mapSize.set(mapSize, mapSize);
  shadow.camera.near = 0.5;
  shadow.camera.far = maxDistance;
  shadow.bias = -0.00012;
  shadow.normalBias = 0.025;
  shadow.radius = 2.2;
  sun.shadow = shadow;
  sun.castShadow = true;
  sun.name = 'ShamelessSun';
  return sun;
}

let patched = false;
/**
 * Replace three's 5-tap PCF with an N-tap rotated Vogel disk (hardware 2x2 PCF per tap), set the
 * sun cascade count, and make cascades scale their normal bias by the cascade texel size.
 * Must run before any lit material compiles and before createSunLight().
 */
export function patchShadowChunks(taps: number, cascades: 2 | 3): void {
  if (patched) return;
  patched = true;
  CASCADES = cascades;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  let src = C.shadowmap_pars_fragment;
  src = src.replace(/#define SUN_LIGHT_CASCADES \d+/, `#define SUN_LIGHT_CASCADES ${cascades}`);
  const pcf = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/;
  if (pcf.test(src)) {
    src = src.replace(pcf, `{
				float sAcc = 0.0;
				for ( int k = 0; k < ${taps}; k ++ ) {
					sAcc += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( k, ${taps}, phi ) * shadowRadius * texelSize, shadowCoord.z ) );
				}
				shadow = sAcc / ${taps}.0;
				}`);
  } else console.warn('[render] PCF chunk pattern not found; using stock filter');

  const sunFn = /float getSunShadow\([\s\S]*?return shadow;\s*\}/;
  if (sunFn.test(src)) {
    src = src.replace(sunFn, `float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {
			float viewDepth = vSunShadowWorldPosition.w;
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			float shadow = 1.0;
			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];
				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {
					float k = max( cascade.w, 1.0 );
					vec4 swp = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias * k, 1.0 );
					float cascadeShadow = getShadow(
						shadowMap,
						sunLightShadow.shadowMapSize,
						sunLightShadow.shadowIntensity,
						sunLightShadow.shadowBias * sqrt( k ),
						max( 1.5, sunLightShadow.shadowRadius / pow( k, 0.25 ) ),
						sunShadowMatrix[ cascadeOffset + i ] * swp
					);
					shadow = mix( cascadeShadow, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );
				}
			}
			return shadow;
		}`);
  } else console.warn('[render] getSunShadow pattern not found; using stock cascades');
  C.shadowmap_pars_fragment = src;
}

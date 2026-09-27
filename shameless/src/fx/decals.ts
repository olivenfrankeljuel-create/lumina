import * as THREE from 'three';
import { ATLAS_GRID, type DecalAtlas } from './decalAtlas';

/**
 * Pooled projected-quad decals (bullet holes, blood, scorch) in one InstancedMesh.
 * Lit with MeshStandardMaterial (normal-mapped crater, per-cell roughness/metalness), atlas cell
 * chosen per instance, polygon offset against z-fighting. The oldest ~15% fade out before being
 * recycled (driven by a sequence counter uniform, no per-frame uploads). Metal holes glow hot for
 * a moment after the hit (emissive mask in the ORM atlas R channel).
 */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _down = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class DecalSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private seq = 0;
  private aCell: THREE.InstancedBufferAttribute;
  private aDecal: THREE.InstancedBufferAttribute;
  private uniforms = { uSeqHead: { value: 0 }, uMax: { value: 1 }, uTime: { value: 0 } };

  constructor(atlas: DecalAtlas, capacity: number, envMap: THREE.Texture | null, name: string) {
    this.cap = capacity;
    this.uniforms.uMax.value = capacity;
    const mat = new THREE.MeshStandardMaterial({
      map: atlas.albedo,
      normalMap: atlas.normal,
      roughnessMap: atlas.orm,
      metalnessMap: atlas.orm,
      roughness: 1,
      metalness: 1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      envMap: envMap ?? null,
    });
    mat.normalScale.set(1, 1);
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aCell;
attribute vec4 aDecal;
uniform float uSeqHead;
uniform float uMax;
uniform float uTime;
varying float vDecalA;
varying float vHeat;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vec2 dUv = uv * aCell.z + aCell.xy;
#ifdef USE_MAP
vMapUv = dUv;
#endif
#ifdef USE_NORMALMAP
vNormalMapUv = dUv;
#endif
#ifdef USE_ROUGHNESSMAP
vRoughnessMapUv = dUv;
#endif
#ifdef USE_METALNESSMAP
vMetalnessMapUv = dUv;
#endif
float seqAge = uSeqHead - aCell.w;
vDecalA = aDecal.x * (1.0 - smoothstep(uMax * 0.85, uMax, seqAge));
vHeat = aDecal.z * exp(-max(uTime - aDecal.y, 0.0) * 2.2);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vDecalA;
varying float vHeat;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.a *= vDecalA;
if (diffuseColor.a < 0.004) discard;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_ROUGHNESSMAP
{
  float hm = texture2D(roughnessMap, vRoughnessMapUv).r;
  float hv = hm * vHeat;
  totalEmissiveRadiance += mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.55, 0.15), clamp(hv, 0.0, 1.0)) * hv * 30.0;
}
#endif`);
    };
    mat.customProgramCacheKey = () => 'fx-decal';

    const geo = new THREE.PlaneGeometry(1, 1);
    this.aCell = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aDecal = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aCell.setUsage(THREE.DynamicDrawUsage);
    this.aDecal.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', this.aCell);
    geo.setAttribute('aDecal', this.aDecal);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) { this.mesh.setMatrixAt(i, ZERO); this.mesh.setColorAt(i, _c.setRGB(1, 1, 1)); }
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.mesh.name = name;
  }

  /**
   * @param alignDown when true, the decal's local -Y is aligned with world down (drips)
   */
  add(point: THREE.Vector3, normal: THREE.Vector3, cell: number, size: number, angle: number,
    tint: THREE.Color | null, opacity = 1, heat = 0, time = 0, alignDown = false, aspect = 1): void {
    const i = this.seq % this.cap;
    this.seq++;
    _q.setFromUnitVectors(_z, normal);
    if (alignDown && Math.abs(normal.y) < 0.9) {
      _down.set(0, -1, 0).addScaledVector(normal, normal.y).normalize(); // world down projected on plane
      _ld.set(0, -1, 0).applyQuaternion(_q);
      let a = Math.acos(THREE.MathUtils.clamp(_ld.dot(_down), -1, 1));
      _s.crossVectors(_ld, _down);
      if (_s.dot(normal) < 0) a = -a;
      angle = a + angle * 0.15;
    }
    _q2.setFromAxisAngle(normal, angle);
    _q.premultiply(_q2);
    _p.copy(point).addScaledVector(normal, 0.003);
    _s.set(size * aspect, size, 1);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, tint ?? _c.setRGB(1, 1, 1));
    const col = cell % ATLAS_GRID, row = Math.floor(cell / ATLAS_GRID);
    this.aCell.setXYZW(i, col / ATLAS_GRID, row / ATLAS_GRID, 1 / ATLAS_GRID, this.seq);
    this.aDecal.setXYZW(i, opacity, time, heat, 0);
    this.aCell.addUpdateRange(i * 4, 4); this.aCell.needsUpdate = true;
    this.aDecal.addUpdateRange(i * 4, 4); this.aDecal.needsUpdate = true;
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16); this.mesh.instanceMatrix.needsUpdate = true;
    const ic = this.mesh.instanceColor!;
    ic.addUpdateRange(i * 3, 3); ic.needsUpdate = true;
    this.uniforms.uSeqHead.value = this.seq;
  }

  update(time: number): void { this.uniforms.uTime.value = time; }
  get count(): number { return Math.min(this.seq, this.cap); }
}

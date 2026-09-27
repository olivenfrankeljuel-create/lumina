import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, EdgeDetectionMode, BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { GameContext, RenderPipeline } from '../core/types';
import { createSky, DEFAULT_ATMOSPHERE, type AtmosphereParams, type SkySystem } from './atmosphere';
import { createSunLight, patchShadowChunks } from './shadows';
import { AtmospherePass, ViewmodelPass, GradeEffect, FinalEffect } from './post';

/**
 * SHAMELESS render pipeline.
 *
 *  world RenderPass (HDR half-float, depth) -> N8AO (GTAO-like) -> Atmosphere (height fog, aerial
 *  perspective matched to the sky, dust glow, sun shafts) -> Viewmodel (own depth, composited
 *  premultiplied, ADS DOF) -> Bloom + Grade (exposure, ACES, LGG, vignette, damage, flash)
 *  -> SMAA -> Final (edge CA, edge blur, grain, dither) -> screen.
 */

export interface RenderTuning {
  exposure: number;
  fog: { density: number; falloff: number; baseHeight: number; aerial: number; mie: number; shafts: number };
  bloom: { intensity: number; threshold: number };
  grade: {
    contrast: number; saturation: number; wb: [number, number, number];
    lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number];
    shadowTint: [number, number, number]; highlightTint: [number, number, number];
    vignette: number; grain: number; tonemap: 'aces' | 'agx' | 'gt';
  };
  ao: { radius: number; intensity: number; falloff: number };
  envIntensity: number;
}

export const DEFAULT_TUNING: RenderTuning = {
  exposure: 1.05,
  fog: { density: 0.0022, falloff: 0.045, baseHeight: 0, aerial: 0.0007, mie: 0.25, shafts: 0.35 },
  bloom: { intensity: 0.55, threshold: 1.6 },
  grade: {
    contrast: 1.08, saturation: 0.9, wb: [1.02, 1.0, 0.97],
    lift: [0.018, 0.018, 0.026], gamma: [1.0, 1.0, 1.0], gain: [1.02, 1.0, 0.97],
    shadowTint: [0.97, 1.0, 1.04], highlightTint: [1.03, 1.0, 0.95],
    vignette: 0.28, grain: 0.022, tonemap: 'gt',
  },
  ao: { radius: 1.6, intensity: 2.2, falloff: 0.6 },
  envIntensity: 1.0,
};

export interface RenderDebugApi {
  sky: SkySystem;
  tuning: RenderTuning;
  applyTuning(): void;
  setAtmosphere(p: Partial<AtmosphereParams> & { sunTintRGB?: [number, number, number] }): void;
  composer: EffectComposer;
  setAO(enabled: boolean): void;
  setMotionBlur(enabled: boolean): void;
  aoPass: N8AOPostPass | null;
}

type SunLike = THREE.Light & { shadow: THREE.LightShadow; target: THREE.Object3D };

export async function createRenderPipeline(ctx: GameContext): Promise<RenderPipeline & { debug: RenderDebugApi }> {
  const { renderer, scene, camera } = ctx;
  const tier = ctx.quality.tier;
  const tuning: RenderTuning = JSON.parse(JSON.stringify(DEFAULT_TUNING));

  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = true;
  patchShadowChunks(tier >= 3 ? 16 : tier === 2 ? 12 : 8, tier >= 2 ? 3 : 2);

  // ---- sky / atmosphere / environment
  const atmoParams: AtmosphereParams = { ...DEFAULT_ATMOSPHERE, groundAlbedo: DEFAULT_ATMOSPHERE.groundAlbedo.clone(), sunTint: DEFAULT_ATMOSPHERE.sunTint.clone() };
  const sky = createSky(renderer, atmoParams, tier <= 1 ? 96 : 160);
  scene.add(sky.dome);
  scene.background = null;
  scene.fog = null;
  scene.environment = sky.envMap;
  scene.environmentIntensity = tuning.envIntensity;

  // ---- sun (cascaded shadows, native SunLight)
  const shadowSize = tier >= 3 ? 2560 : tier === 2 ? 2048 : tier === 1 ? 1536 : 1024;
  const shadowDistance = tier >= 3 ? 180 : tier === 2 ? 140 : tier === 1 ? 110 : 80;
  const sunLight = createSunLight(shadowSize, shadowDistance);
  // duck-type DirectionalLight: some consumers read sun.target
  const sunTarget = new THREE.Object3D();
  (sunLight as unknown as SunLike).target = sunTarget;
  scene.add(sunLight, sunTarget);
  const sun = sunLight as unknown as THREE.DirectionalLight;

  const applySun = () => {
    const st = sky.state;
    sunLight.position.copy(st.sunDir).multiplyScalar(200);
    sunLight.color.copy(st.sunColor);
    sunLight.intensity = st.sunIntensity;
  };
  applySun();

  // ---- viewmodel scene: lit by a view-space copy of the sun + the same rotated IBL
  const viewmodelScene = new THREE.Scene();
  viewmodelScene.name = 'viewmodel';
  const viewmodelCamera = new THREE.PerspectiveCamera(55, camera.aspect, 0.01, 20);
  viewmodelScene.add(viewmodelCamera);
  const vmSun = new THREE.DirectionalLight(0xffffff, 1);
  viewmodelScene.add(vmSun, vmSun.target);
  viewmodelScene.environment = sky.envMap;
  viewmodelScene.environmentIntensity = tuning.envIntensity;
  let vmSunVis = 1; // smoothed "is the player in sunlight" (raycast)
  let vmVisInit = false;

  // ---- composer
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, stencilBuffer: false, depthBuffer: true, multisampling: 0 });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  let aoPass: N8AOPostPass | null = null;
  aoPass = new N8AOPostPass(scene, camera, size.x, size.y);
  const aoCfg = aoPass.configuration;
  aoCfg.gammaCorrection = false;
  aoCfg.aoRadius = tuning.ao.radius;
  aoCfg.distanceFalloff = tuning.ao.falloff;
  aoCfg.intensity = tuning.ao.intensity;
  aoCfg.color = new THREE.Color(0, 0, 0);
  aoCfg.halfRes = tier <= 1;
  aoCfg.depthAwareUpsampling = true;
  aoCfg.screenSpaceRadius = false;
  aoPass.setQualityMode(tier >= 3 ? 'High' : tier === 2 ? 'Medium' : tier === 1 ? 'Low' : 'Performance');
  composer.addPass(aoPass);

  const atmoPass = new AtmospherePass(camera, sky.atmoCube, tier >= 2 ? 0.5 : 0.25);
  atmoPass.shaftsEnabled = tier >= 1;
  composer.addPass(atmoPass);

  const vmPass = new ViewmodelPass(viewmodelScene, viewmodelCamera);
  composer.addPass(vmPass);

  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD, mipmapBlur: true, luminanceThreshold: tuning.bloom.threshold, luminanceSmoothing: 0.4,
    intensity: tuning.bloom.intensity, radius: 0.72, levels: tier <= 0 ? 5 : 7,
  });
  const grade = new GradeEffect();
  composer.addPass(new EffectPass(camera, bloom, grade));

  const smaa = new SMAAEffect({
    preset: tier >= 3 ? SMAAPreset.ULTRA : tier === 2 ? SMAAPreset.HIGH : tier === 1 ? SMAAPreset.MEDIUM : SMAAPreset.LOW,
    edgeDetectionMode: EdgeDetectionMode.COLOR,
  });
  composer.addPass(new EffectPass(camera, smaa));
  const finalFx = new FinalEffect();
  const finalPass = new EffectPass(camera, finalFx);
  finalPass.dithering = true;
  composer.addPass(finalPass);

  // ---- tuning
  const applyTuning = () => {
    const f = tuning.fog, au = atmoPass.uniforms;
    au.density.value = f.density; au.falloff.value = f.falloff; au.baseHeight.value = f.baseHeight;
    au.aerial.value = f.aerial; au.mie.value = f.mie; au.shafts.value = f.shafts;
    const st = sky.state;
    au.sunDir.value.copy(st.sunDir);
    au.sunColor.value.set(st.sunColor.r * st.sunIntensity, st.sunColor.g * st.sunIntensity, st.sunColor.b * st.sunIntensity);
    bloom.intensity = tuning.bloom.intensity;
    bloom.luminanceMaterial.threshold = tuning.bloom.threshold;
    const g = tuning.grade;
    grade.u('contrast').value = g.contrast; grade.u('saturation').value = g.saturation;
    (grade.u('wb').value as THREE.Vector3).fromArray(g.wb);
    (grade.u('lift').value as THREE.Vector3).fromArray(g.lift);
    (grade.u('gammaV').value as THREE.Vector3).fromArray(g.gamma);
    (grade.u('gain').value as THREE.Vector3).fromArray(g.gain);
    (grade.u('shadowTint').value as THREE.Vector3).fromArray(g.shadowTint);
    (grade.u('highlightTint').value as THREE.Vector3).fromArray(g.highlightTint);
    grade.u('vignette').value = g.vignette;
    grade.u('tonemapMode').value = g.tonemap === 'aces' ? 0 : g.tonemap === 'agx' ? 1 : 2;
    finalFx.u('grain').value = g.grain;
    if (aoPass) {
      aoPass.configuration.aoRadius = tuning.ao.radius;
      aoPass.configuration.intensity = tuning.ao.intensity;
      aoPass.configuration.distanceFalloff = tuning.ao.falloff;
    }
    scene.environmentIntensity = tuning.envIntensity;
    viewmodelScene.environmentIntensity = tuning.envIntensity;
  };
  applyTuning();

  // ---- dynamic state
  let ads = 0, damage = 0, flashAmt = 0, time = 0;
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _o = new THREE.Vector3();
  const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _fwd = new THREE.Vector3();
  const _euler = new THREE.Euler();
  const savedEnvRot = new Map<THREE.Material, THREE.Euler>();

  const sunVisibility = (): number => {
    const phys = ctx.physics as GameContext['physics'] | undefined;
    if (!phys || typeof phys.raycast !== 'function') return 1;
    const sd = sky.state.sunDir;
    camera.getWorldPosition(_o);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    _fwd.setFromMatrixColumn(camera.matrixWorld, 2).negate();
    // sample points around where the weapon is (right/down/forward of the eye)
    const pts: [number, number, number][] = [[0.12, -0.12, 0.35], [0.2, -0.18, 0.1], [0.02, -0.08, 0.6]];
    let vis = 0;
    for (const [r, u, f] of pts) {
      _v.copy(_o).addScaledVector(_right, r).addScaledVector(_up, u).addScaledVector(_fwd, f);
      try {
        const hit = phys.raycast(_v, sd, 250, { ignorePlayer: true, ignoreEnemies: true });
        vis += hit ? 0 : 1;
      } catch { vis += 1; }
    }
    return vis / pts.length;
  };

  vmPass.beforeRender = () => {
    // rotate world sun + env into viewmodel space: vmDir = vmCamQ * camQ^-1 * worldDir
    camera.getWorldQuaternion(_q);
    viewmodelCamera.updateMatrixWorld();
    viewmodelCamera.getWorldQuaternion(_q2);
    const toVm = _q2.clone().multiply(_q.clone().invert());
    const st = sky.state;
    vmSun.position.copy(st.sunDir).applyQuaternion(toVm).multiplyScalar(10);
    vmSun.target.position.set(0, 0, 0);
    vmSun.color.copy(st.sunColor);
    vmSun.intensity = st.sunIntensity * (0.06 + 0.94 * vmSunVis);
    // env lookup = R^T * n, want camQ * vmCamQ^-1 * n  ->  R = vmCamQ * camQ^-1
    _euler.setFromQuaternion(toVm);
    viewmodelScene.environmentRotation.copy(_euler);
    // materials that carry their own envMap use material.envMapRotation
    viewmodelScene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        const sm = mm as THREE.MeshStandardMaterial;
        if (sm.envMap && sm.envMapRotation) {
          if (!savedEnvRot.has(sm)) savedEnvRot.set(sm, sm.envMapRotation.clone());
          sm.envMapRotation.copy(_euler);
        }
      }
    });
  };
  vmPass.afterRender = () => {
    for (const [m, e] of savedEnvRot) (m as THREE.MeshStandardMaterial).envMapRotation.copy(e);
    savedEnvRot.clear();
  };

  const setSize = (w: number, h: number) => {
    composer.setSize(w, h, false);
    viewmodelCamera.aspect = w / Math.max(1, h);
    viewmodelCamera.updateProjectionMatrix();
  };
  setSize(renderer.domElement.clientWidth || size.x, renderer.domElement.clientHeight || size.y);

  const pipeline: RenderPipeline & { debug: RenderDebugApi } = {
    viewmodelScene, viewmodelCamera, sun,
    render(dt: number) {
      time += dt;
      camera.updateMatrixWorld();
      if (viewmodelCamera.aspect !== camera.aspect) {
        viewmodelCamera.aspect = camera.aspect;
        viewmodelCamera.updateProjectionMatrix();
      }
      sky.update(time);
      // viewmodel sun occlusion (world shadows onto the gun, coarse)
      const target = sunVisibility();
      if (!vmVisInit) { vmSunVis = target; vmVisInit = true; }
      vmSunVis += (target - vmSunVis) * (1 - Math.exp(-dt * 10));
      // transient effects
      flashAmt *= Math.exp(-dt * 5.5);
      if (flashAmt < 1e-3) flashAmt = 0;
      grade.u('exposure').value = tuning.exposure;
      grade.u('flash').value = flashAmt;
      grade.u('damage').value = damage;
      grade.u('ads').value = ads;
      vmPass.uniforms.dof.value = ads;
      finalFx.u('ca').value = (tier >= 1 ? 0.004 : 0) + damage * 0.02 + flashAmt * 0.01;
      finalFx.u('edgeBlur').value = Math.max(damage * 0.9, ads * 0.35);
      finalFx.u('seed').value = (time * 60) % 1000;
      composer.render(dt);
    },
    setSize,
    setADS(a: number) { ads = THREE.MathUtils.clamp(a, 0, 1); },
    setDamage(a: number) { damage = THREE.MathUtils.clamp(a, 0, 1); },
    flash(intensity: number) { flashAmt = Math.min(1.5, Math.max(flashAmt, intensity)); },
    setupShadows(object: THREE.Object3D) {
      object.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh && !(c as THREE.InstancedMesh).isInstancedMesh) return;
        if (c.userData.noShadow) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const transparent = mats.every((mm) => mm && mm.transparent && mm.opacity < 0.6);
        m.castShadow = !transparent;
        m.receiveShadow = true;
      });
    },
    dispose() {
      composer.dispose();
      sky.dispose();
      scene.remove(sky.dome, sunLight, sunTarget);
      sunLight.dispose();
    },
    debug: {
      sky, tuning, applyTuning, composer, aoPass,
      setAtmosphere(p: Partial<AtmosphereParams> & { sunTintRGB?: [number, number, number] }) {
        Object.assign(atmoParams, p);
        if (p.sunTintRGB) atmoParams.sunTint = new THREE.Color(...p.sunTintRGB);
        sky.rebuild(atmoParams);
        scene.environment = sky.envMap;
        viewmodelScene.environment = sky.envMap;
        applySun();
        applyTuning();
      },
      setAO(enabled: boolean) { if (aoPass) aoPass.enabled = enabled; },
      setMotionBlur() { /* not implemented yet */ },
    },
  };
  return pipeline;
}

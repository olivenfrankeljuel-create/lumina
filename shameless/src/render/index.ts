import * as THREE from 'three';
import type { GameContext, RenderPipeline } from '../core/types';

// STUB — replaced by the render workstream.
export async function createRenderPipeline(ctx: GameContext): Promise<RenderPipeline> {
  const { renderer, scene, camera } = ctx;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene.background = new THREE.Color(0x9fb4c8);
  scene.fog = new THREE.Fog(0x9fb4c8, 60, 400);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6b5a45, 1.2));
  const sun = new THREE.DirectionalLight(0xfff0dd, 3);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(ctx.quality.shadowMapSize);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 250 });
  scene.add(sun, sun.target);
  const viewmodelScene = new THREE.Scene();
  const viewmodelCamera = new THREE.PerspectiveCamera(55, camera.aspect, 0.01, 10);
  viewmodelScene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6b5a45, 1.5));
  renderer.autoClear = false;
  return {
    viewmodelScene, viewmodelCamera, sun,
    render() {
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      viewmodelCamera.aspect = camera.aspect;
      viewmodelCamera.updateProjectionMatrix();
      renderer.render(viewmodelScene, viewmodelCamera);
    },
    setSize() {},
    setADS() {},
    setDamage() {},
    flash() {},
    setupShadows(o) { o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = c.receiveShadow = true; } }); },
    dispose() {},
  };
}

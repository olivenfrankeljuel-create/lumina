import * as THREE from 'three';

/**
 * Fallback golden-hour sky environment (PMREM) for lookdev and for anyone who needs an IBL before the
 * render pipeline installs its own scene.environment. Not assigned to materials.
 */
export function createSkyEnvironment(
  renderer: THREE.WebGLRenderer,
  sunDir = new THREE.Vector3(-0.6, 0.28, -0.75).normalize(),
): THREE.Texture {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 zenith = vec3(0.16, 0.30, 0.62);
        vec3 horizon = vec3(1.05, 0.78, 0.52);
        vec3 ground = vec3(0.30, 0.22, 0.15);
        float t = pow(clamp(y, 0.0, 1.0), 0.45);
        vec3 sky = mix(horizon, zenith, t);
        float mu = max(dot(d, uSun), 0.0);
        sky += vec3(1.6, 0.9, 0.45) * pow(mu, 8.0) * 0.8 + vec3(1.2, 0.7, 0.35) * pow(mu, 64.0) * 2.0;
        sky += vec3(60.0, 42.0, 26.0) * smoothstep(0.9995, 0.99975, mu);
        vec3 gnd = ground * (0.6 + 0.4 * smoothstep(-0.4, 0.0, y));
        vec3 col = y > 0.0 ? sky : mix(horizon * 0.55, gnd, smoothstep(0.0, -0.08, y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  mat.dispose();
  return rt.texture;
}

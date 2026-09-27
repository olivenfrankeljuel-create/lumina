import * as THREE from 'three';

/**
 * Fixed pool of point lights for muzzle / explosion / impact flashes. The lights always stay in
 * the scene (intensity 0 when idle) so the light count never changes and no shaders recompile.
 */
export class FlashLights {
  readonly lights: THREE.PointLight[] = [];
  private t0: Float32Array;
  private dur: Float32Array;
  private peak: Float32Array;
  private shape: Uint8Array; // 0 = muzzle (1-2 frames, hard cut), 1 = explosion (smooth decay)
  private next = 0;

  constructor(group: THREE.Object3D, count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffaa66, 0, 8, 2);
      l.castShadow = false;
      l.name = `fx:flash${i}`;
      group.add(l);
      this.lights.push(l);
    }
    this.t0 = new Float32Array(count).fill(-100);
    this.dur = new Float32Array(count).fill(0.01);
    this.peak = new Float32Array(count);
    this.shape = new Uint8Array(count);
  }

  /** Reserve slot 0 for explosions when >1 light; muzzle flashes rotate through the rest. */
  trigger(time: number, pos: THREE.Vector3, r: number, g: number, b: number, intensity: number, distance: number, duration: number, explosion: boolean): void {
    const n = this.lights.length;
    if (n === 0) return;
    let i: number;
    if (explosion || n === 1) i = 0;
    else { i = 1 + (this.next++ % (n - 1)); }
    // don't let a muzzle flash stomp a live explosion on a shared single light
    if (n === 1 && !explosion && this.shape[0] === 1 && time - this.t0[0] < this.dur[0] * 0.6) return;
    const l = this.lights[i];
    l.position.copy(pos);
    l.color.setRGB(r, g, b);
    l.distance = distance;
    this.t0[i] = time; this.dur[i] = duration; this.peak[i] = intensity; this.shape[i] = explosion ? 1 : 0;
  }

  update(time: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      const age = time - this.t0[i];
      const d = this.dur[i];
      let k = 0;
      if (age >= 0 && age < d) {
        const x = age / d;
        k = this.shape[i] === 1 ? Math.pow(1 - x, 2.2) * (0.85 + 0.15 * Math.sin(age * 90)) : (x < 0.5 ? 1 : 1 - (x - 0.5) * 2);
      }
      this.lights[i].intensity = this.peak[i] * k;
    }
  }
}

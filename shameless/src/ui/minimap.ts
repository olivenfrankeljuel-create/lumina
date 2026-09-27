import * as THREE from 'three';
import type { GameContext } from '../core/types';

/**
 * Minimap: a top-down "layout" texture of the level built once (progressively, a few thousand
 * downward rays per frame against the static physics world), then blitted rotated/translated
 * into a small canvas every frame. Falls back to mesh footprints if raycasting yields nothing.
 */

export interface MapLayout {
  canvas: HTMLCanvasElement;
  minX: number; minZ: number;
  /** metres per canvas pixel */
  mpp: number;
  ready: boolean;
}

export interface Blip { x: number; z: number; alpha: number; kind: 'enemy' | 'enemyFaint' }

const FLAGS_STATIC_ONLY = 2 | 4 | 8; // EXCLUDE_KINEMATIC | EXCLUDE_DYNAMIC | EXCLUDE_SENSORS

export class MapBuilder {
  layout: MapLayout;
  private heights!: Float32Array;
  private grounds!: Float32Array;
  private nx = 0; private nz = 0; private cell = 1;
  private cursor = 0;
  private topY = 50;
  private hits = 0;
  private started = false;
  private failed = false;
  private framesWaited = 0;
  onReady: (() => void) | null = null;

  constructor(private ctx: GameContext) {
    this.layout = { canvas: document.createElement('canvas'), minX: -50, minZ: -50, mpp: 1, ready: false };
  }

  private init(): void {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    this.ctx.world.root.updateWorldMatrix(true, true);
    this.ctx.world.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
      if (!isFinite(tmp.min.x) || tmp.max.x - tmp.min.x > 2000) return;
      box.union(tmp);
    });
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 20, 50));
    const clampL = 300;
    box.min.x = Math.max(box.min.x, -clampL); box.min.z = Math.max(box.min.z, -clampL);
    box.max.x = Math.min(box.max.x, clampL); box.max.z = Math.min(box.max.z, clampL);
    const ex = box.max.x - box.min.x, ez = box.max.z - box.min.z;
    this.cell = Math.max(0.5, Math.max(ex, ez) / 360);
    this.nx = Math.ceil(ex / this.cell); this.nz = Math.ceil(ez / this.cell);
    this.layout.minX = box.min.x; this.layout.minZ = box.min.z;
    this.topY = box.max.y + 5;
    this.heights = new Float32Array(this.nx * this.nz).fill(NaN);
    this.grounds = new Float32Array(this.nx * this.nz).fill(NaN);
    this.started = true;
  }

  /** Call every frame until layout.ready. */
  step(budget = 5000): void {
    if (this.layout.ready || this.failed) return;
    // Rapier's broad-phase only knows colliders after a physics step: wait a few frames.
    if (this.framesWaited++ < 3) return;
    try {
      if (!this.started) this.init();
      const phys = this.ctx.physics;
      const R = phys.rapier;
      const ray = new R.Ray({ x: 0, y: this.topY, z: 0 }, { x: 0, y: -1, z: 0 });
      const total = this.nx * this.nz;
      const end = Math.min(total, this.cursor + budget);
      const maxToi = this.topY + 200;
      for (let i = this.cursor; i < end; i++) {
        const ix = i % this.nx, iz = (i / this.nx) | 0;
        const x = this.layout.minX + (ix + 0.5) * this.cell;
        const z = this.layout.minZ + (iz + 0.5) * this.cell;
        ray.origin.x = x; ray.origin.y = this.topY; ray.origin.z = z;
        const h = phys.world.castRay(ray, maxToi, true, FLAGS_STATIC_ONLY);
        if (h) { this.heights[i] = this.topY - h.timeOfImpact; this.hits++; }
        const g = this.ctx.world.groundHeight(x, z);
        this.grounds[i] = g === null ? NaN : g;
      }
      this.cursor = end;
      if (end >= total) this.finish();
    } catch (err) {
      console.warn('[ui] minimap raycast build failed, using footprints', err);
      this.failed = true;
      this.buildFromFootprints();
    }
  }

  private finish(): void {
    if (this.hits === 0) { this.buildFromFootprints(); return; }
    const { nx, nz } = this;
    // Local terrain estimate: groundHeight() if the world gives it, else a 9x9 min filter of hit heights.
    const terrain = new Float32Array(nx * nz);
    const R = Math.max(2, Math.round(6 / this.cell));
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const g = this.grounds[i];
      if (!isNaN(g)) { terrain[i] = g; continue; }
      let m = Infinity;
      for (let dz = -R; dz <= R; dz += 2) for (let dx = -R; dx <= R; dx += 2) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const h = this.heights[jz * nx + jx];
        if (!isNaN(h) && h < m) m = h;
      }
      terrain[i] = m === Infinity ? NaN : m;
    }
    const img = new ImageData(nx, nz);
    const d = img.data;
    const solid = (i: number) => {
      const h = this.heights[i];
      return !isNaN(h) && h - terrain[i] > 1.3;
    };
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const o = i * 4;
      const h = this.heights[i];
      const inMap = !isNaN(h) || !isNaN(this.grounds[i]);
      if (!inMap) { d[o + 3] = 0; continue; }
      if (solid(i)) {
        // Edge detection: any 4-neighbour not solid -> outline.
        const edge = (ix > 0 && !solid(i - 1)) || (ix < nx - 1 && !solid(i + 1)) || (iz > 0 && !solid(i - nx)) || (iz < nz - 1 && !solid(i + nx));
        const hh = Math.min(1, (h - terrain[i]) / 14);
        const v = edge ? 238 : 150 + hh * 50;
        d[o] = v; d[o + 1] = v + 2; d[o + 2] = v - 4; d[o + 3] = edge ? 235 : 150;
      } else {
        // Walkable ground: subtle, with slight relief shading from height.
        const t = isNaN(h) ? 0 : Math.max(-1, Math.min(1, (h - terrain[i]) / 1.3));
        const v = 62 + t * 22;
        d[o] = v; d[o + 1] = v + 4; d[o + 2] = v; d[o + 3] = 110;
      }
    }
    this.paint(img);
  }

  private paint(img: ImageData): void {
    const src = document.createElement('canvas');
    src.width = img.width; src.height = img.height;
    src.getContext('2d')!.putImageData(img, 0, 0);
    // Upscale with smoothing for soft anti-aliased building edges.
    const scale = Math.max(1, Math.round(900 / Math.max(img.width, img.height)));
    const c = this.layout.canvas;
    c.width = img.width * scale; c.height = img.height * scale;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    this.layout.mpp = this.cell / scale;
    this.layout.ready = true;
    this.onReady?.();
  }

  /** Fallback: project each mesh's local bounding box footprint (handles rotation). */
  private buildFromFootprints(): void {
    if (!this.started) {
      try { this.init(); } catch { return; }
    }
    const { nx, nz } = this;
    const scale = Math.max(1, Math.round(900 / Math.max(nx, nz)));
    const c = this.layout.canvas;
    c.width = nx * scale; c.height = nz * scale;
    const g = c.getContext('2d')!;
    const pxm = scale / this.cell;
    g.fillStyle = 'rgba(62,66,62,0.43)';
    g.fillRect(0, 0, c.width, c.height);
    const v = new THREE.Vector3();
    this.ctx.world.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const bb = m.geometry.boundingBox ?? (m.geometry.computeBoundingBox(), m.geometry.boundingBox!);
      const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      const s = m.getWorldScale(v);
      if (sy * s.y < 1.5 || sx * s.x > 80 || sz * s.z > 80) return;
      const corners = [[bb.min.x, bb.min.z], [bb.max.x, bb.min.z], [bb.max.x, bb.max.z], [bb.min.x, bb.max.z]];
      g.beginPath();
      corners.forEach(([x, z], k) => {
        v.set(x, bb.min.y, z).applyMatrix4(m.matrixWorld);
        const px = (v.x - this.layout.minX) * pxm, pz = (v.z - this.layout.minZ) * pxm;
        k ? g.lineTo(px, pz) : g.moveTo(px, pz);
      });
      g.closePath();
      g.fillStyle = 'rgba(160,165,158,0.6)';
      g.fill();
      g.strokeStyle = 'rgba(238,240,234,0.9)';
      g.lineWidth = Math.max(1, scale * 0.6);
      g.stroke();
    });
    this.layout.mpp = this.cell / scale;
    this.layout.ready = true;
    this.onReady?.();
  }
}

/** Per-frame minimap renderer. */
export class MinimapView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private wPx = 0; private hPx = 0; private dpr = 1;
  /** metres shown across the minimap */
  span = 110;
  rotate = true;
  private north: HTMLDivElement;

  constructor(private layout: MapLayout) {
    this.el = document.createElement('div');
    this.el.className = 'sh-minimap';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.north = document.createElement('div');
    this.north.className = 'sh-mm-north';
    this.north.textContent = 'N';
    this.el.appendChild(this.north);
    const frame = document.createElement('div');
    frame.className = 'sh-mm-frame';
    this.el.appendChild(frame);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.wPx = Math.max(1, Math.round(r.width * this.dpr));
      this.hPx = Math.max(1, Math.round(r.height * this.dpr));
      this.canvas.width = this.wPx; this.canvas.height = this.hPx;
    }).observe(this.el);
  }

  draw(px: number, pz: number, headingRad: number, blips: Blip[], fovDeg: number): void {
    const g = this.g, W = this.wPx, H = this.hPx;
    if (!W) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const scale = W / this.span; // screen px per metre
    const rot = this.rotate ? -headingRad : 0;
    const cx = W / 2, cy = H * 0.56;
    // map layer
    const L = this.layout;
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    if (L.ready) {
      g.imageSmoothingEnabled = true;
      const s = scale * L.mpp;
      g.drawImage(L.canvas, (L.minX - px) * scale, (L.minZ - pz) * scale, L.canvas.width * s, L.canvas.height * s);
    }
    // subtle 25 m grid
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    const grid = 25, ext = this.span;
    const gx0 = Math.floor((px - ext) / grid) * grid, gz0 = Math.floor((pz - ext) / grid) * grid;
    g.beginPath();
    for (let x = gx0; x <= px + ext; x += grid) { g.moveTo((x - px) * scale, (gz0 - pz) * scale); g.lineTo((x - px) * scale, (pz + ext - pz) * scale); }
    for (let z = gz0; z <= pz + ext; z += grid) { g.moveTo((gx0 - px) * scale, (z - pz) * scale); g.lineTo((px + ext - px) * scale, (z - pz) * scale); }
    g.stroke();
    // enemy blips (drawn in world-rotated space, but as screen-aligned dots)
    for (const b of blips) {
      const bx = (b.x - px) * scale, bz = (b.z - pz) * scale;
      const r = (b.kind === 'enemy' ? 3.6 : 3) * this.dpr * (W / (240 * this.dpr)) ;
      g.globalAlpha = b.alpha;
      g.beginPath(); g.arc(bx, bz, r + 1.4 * this.dpr, 0, Math.PI * 2);
      g.fillStyle = 'rgba(20,0,0,0.65)'; g.fill();
      g.beginPath(); g.arc(bx, bz, r, 0, Math.PI * 2);
      g.fillStyle = b.kind === 'enemy' ? '#ff3b2f' : '#ff7a6e'; g.fill();
    }
    g.globalAlpha = 1;
    g.restore();

    // view cone + player arrow (screen space, always pointing up when rotating)
    g.save();
    g.translate(cx, cy);
    if (!this.rotate) g.rotate(headingRad);
    const half = (fovDeg * Math.PI) / 360;
    const coneR = H * 0.75;
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, coneR);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, coneR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    g.closePath();
    g.fill();
    const a = 7.5 * (W / 240);
    g.beginPath();
    g.moveTo(0, -a * 1.25); g.lineTo(a * 0.85, a * 0.95); g.lineTo(0, a * 0.45); g.lineTo(-a * 0.85, a * 0.95); g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 2 * this.dpr;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.stroke();
    g.fillStyle = '#f2f5e6';
    g.fill();
    g.restore();

    // north marker on the frame edge
    this.placeNorth(rot);
  }

  private lastNorth = '';
  private placeNorth(rot: number): void {
    // Project the north direction (0,-1) rotated by `rot` onto the square border.
    const dx = Math.sin(rot) * 1, dy = -Math.cos(rot);
    const cyN = 0.56;
    // distance to edge along ray from (0.5, 0.56) in unit square
    const tx = dx > 0 ? (1 - 0.5) / dx : dx < 0 ? (0 - 0.5) / dx : Infinity;
    const ty = dy > 0 ? (1 - cyN) / dy : dy < 0 ? (0 - cyN) / dy : Infinity;
    const t = Math.min(tx, ty);
    // keep the badge fully inside the frame
    const x = Math.min(0.93, Math.max(0.07, 0.5 + dx * t)), y = Math.min(0.93, Math.max(0.07, cyN + dy * t));
    const key = `${(x * 100).toFixed(1)},${(y * 100).toFixed(1)}`;
    if (key === this.lastNorth) return;
    this.lastNorth = key;
    this.north.style.transform = `translate(calc(${(x * 100).toFixed(2)}cqw - 50%), calc(${(y * 100).toFixed(2)}cqh - 50%))`;
  }
}

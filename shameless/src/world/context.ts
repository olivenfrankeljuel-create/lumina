import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { Builder, type MatKey, worldUV } from './builder';
import { RNG } from './rng';
import { atlasQuad } from './geo';
import { decalRect } from './textures';

export interface Rect { x0: number; z0: number; x1: number; z1: number; h: number }

/** Geometry that flutters in the wind: per-vertex weight (0 = pinned, 1 = free). */
interface FlutterPiece { geo: THREE.BufferGeometry; weight: Float32Array; phase: number; dir: THREE.Vector3; amp: number }

export class WCtx {
  readonly b: Builder;
  readonly rng: RNG;
  readonly cover: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
  /** Ground-level walkable pads (street, sidewalk, interior ground floors). */
  readonly ground: Rect[] = [];
  /** Elevated walkable surfaces (upper floors, roofs, balconies). */
  readonly decks: Rect[] = [];
  readonly flutter = new Map<MatKey, FlutterPiece[]>();
  readonly enemySpawns: THREE.Vector3[] = [];

  constructor(readonly ctx: GameContext, seed: number) {
    this.b = new Builder(ctx);
    this.rng = new RNG(seed);
  }

  addCover(x: number, y: number, z: number, nx: number, nz: number): void {
    const n = new THREE.Vector3(nx, 0, nz).normalize();
    this.cover.push({ position: new THREE.Vector3(x, y, z), normal: n });
  }

  /**
   * Decal quad. Position is the surface point; normal is surface normal; w/h size; rot rotates in-plane.
   * For vertical surfaces "up" is world Y; for horizontal ones rot picks the orientation.
   */
  decal(cell: number, p: THREE.Vector3, n: THREE.Vector3, w: number, h: number, rot = 0, offset = 0.012, flipU = false): void {
    const r = decalRect(cell);
    const rect: [number, number, number, number] = flipU ? [r[2], r[1], r[0], r[3]] : r;
    const g = atlasQuad(w, h, rect);
    const nn = n.clone().normalize();
    const up = Math.abs(nn.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3().crossVectors(up, nn).normalize();
    const yAxis = new THREE.Vector3().crossVectors(nn, xAxis).normalize();
    const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, nn);
    if (rot) m.multiply(new THREE.Matrix4().makeRotationZ(rot));
    m.setPosition(p.x + nn.x * offset, p.y + nn.y * offset, p.z + nn.z * offset);
    this.b.add('custom:decal', g, m, 'keep');
  }

  /** Register a fluttering piece (already in world space). weight per vertex. */
  addFlutter(key: MatKey, geo: THREE.BufferGeometry, weight: Float32Array, dir: THREE.Vector3, amp = 0.08, uv: 'world' | 'keep' = 'keep'): void {
    if (uv === 'world') worldUV(geo);
    let l = this.flutter.get(key);
    if (!l) this.flutter.set(key, (l = []));
    l.push({ geo, weight, phase: this.rng.range(0, 6.28), dir: dir.clone().normalize(), amp });
  }
}

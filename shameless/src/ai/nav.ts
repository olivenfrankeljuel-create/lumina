/**
 * Lazy navigation grid (0.5 m cells) built on demand from World.groundHeight + Rapier shape queries against
 * static geometry, A* with octile heuristic and wall-clearance cost, and string-pulled paths.
 * Also generates cover spots when the world provides none.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext } from '../core/types';

const CELL = 0.5;
const UNKNOWN = 0, WALK = 1, BLOCK = 2;

export interface CoverSpot { position: THREE.Vector3; normal: THREE.Vector3; low: boolean; owner: number }

export class NavGrid {
  private state = new Map<number, number>();
  private height = new Map<number, number>();
  private shape: RAPIER.Cuboid;
  private flags: number;
  private rot = { x: 0, y: 0, z: 0, w: 1 };
  queries = 0;

  constructor(private ctx: GameContext) {
    const R = ctx.physics.rapier;
    this.shape = new R.Cuboid(0.2, 0.62, 0.2);
    this.flags = R.QueryFilterFlags.ONLY_FIXED | R.QueryFilterFlags.EXCLUDE_SENSORS;
  }

  private key(ix: number, iz: number) { return ((ix + 32768) << 16) | (iz + 32768); }
  cellOf(x: number, z: number): [number, number] { return [Math.floor(x / CELL), Math.floor(z / CELL)]; }
  center(ix: number, iz: number, out = new THREE.Vector3()) { return out.set((ix + 0.5) * CELL, this.groundAt(ix, iz), (iz + 0.5) * CELL); }

  groundAt(ix: number, iz: number): number {
    const k = this.key(ix, iz);
    let h = this.height.get(k);
    if (h === undefined) { h = this.ctx.world.groundHeight((ix + 0.5) * CELL, (iz + 0.5) * CELL) ?? NaN; this.height.set(k, h); }
    return h;
  }

  walkable(ix: number, iz: number): boolean {
    const k = this.key(ix, iz);
    let s = this.state.get(k) ?? UNKNOWN;
    if (s === UNKNOWN) {
      const g = this.groundAt(ix, iz);
      if (Number.isNaN(g)) s = BLOCK;
      else {
        this.queries++;
        const pos = { x: (ix + 0.5) * CELL, y: g + 0.3 + 0.62, z: (iz + 0.5) * CELL };
        const hit = this.ctx.physics.world.intersectionWithShape(pos, this.rot, this.shape, this.flags);
        s = hit ? BLOCK : WALK;
      }
      this.state.set(k, s);
    }
    return s === WALK;
  }

  /** Walkable and not stepping more than 0.45 m relative to a neighbour. */
  private canStep(ax: number, az: number, bx: number, bz: number) {
    if (!this.walkable(bx, bz)) return false;
    return Math.abs(this.groundAt(ax, az) - this.groundAt(bx, bz)) < 0.45;
  }

  private clearance(ix: number, iz: number): number {
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && !this.walkable(ix + dx, iz + dz)) n++;
    return n;
  }

  nearestWalkable(p: THREE.Vector3, radius = 4): THREE.Vector3 | null {
    const [cx, cz] = this.cellOf(p.x, p.z);
    for (let r = 0; r <= radius / CELL; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (this.walkable(cx + dx, cz + dz)) return this.center(cx + dx, cz + dz);
      }
    }
    return null;
  }

  /** A* path (world points, excluding start). Null if no path. */
  findPath(from: THREE.Vector3, to: THREE.Vector3, maxExpand = 4000): THREE.Vector3[] | null {
    let [sx, sz] = this.cellOf(from.x, from.z);
    let [gx, gz] = this.cellOf(to.x, to.z);
    if (!this.walkable(sx, sz)) { const n = this.nearestWalkable(from, 1.5); if (!n) return null; [sx, sz] = this.cellOf(n.x, n.z); }
    if (!this.walkable(gx, gz)) { const n = this.nearestWalkable(to, 3); if (!n) return null; [gx, gz] = this.cellOf(n.x, n.z); }
    const K = (x: number, z: number) => this.key(x, z);
    const open = new MinHeap();
    const g = new Map<number, number>();
    const came = new Map<number, number>();
    const pos = new Map<number, [number, number]>();
    const h = (x: number, z: number) => { const dx = Math.abs(x - gx), dz = Math.abs(z - gz); return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)); };
    const sk = K(sx, sz), gk = K(gx, gz);
    g.set(sk, 0); pos.set(sk, [sx, sz]);
    open.push(sk, h(sx, sz));
    const closed = new Set<number>();
    let found = false, expand = 0;
    let bestK = sk, bestH = h(sx, sz);
    while (open.size) {
      const k = open.pop()!;
      if (closed.has(k)) continue;
      closed.add(k);
      if (k === gk) { found = true; break; }
      if (++expand > maxExpand) break;
      const [x, z] = pos.get(k)!;
      const hk = h(x, z);
      if (hk < bestH) { bestH = hk; bestK = k; }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        if (!this.canStep(x, z, nx, nz)) continue;
        if (dx && dz && (!this.walkable(x + dx, z) || !this.walkable(x, z + dz))) continue; // no corner cutting
        const nk = K(nx, nz);
        if (closed.has(nk)) continue;
        const cost = (dx && dz ? Math.SQRT2 : 1) + this.clearance(nx, nz) * 0.35;
        const ng = g.get(k)! + cost;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng); came.set(nk, k); pos.set(nk, [nx, nz]);
          open.push(nk, ng + h(nx, nz) * 1.05);
        }
      }
    }
    const endK = found ? gk : bestK;
    if (!found && bestH > 6) return null;
    const cells: [number, number][] = [];
    let k: number | undefined = endK;
    while (k !== undefined && k !== sk) { cells.push(pos.get(k)!); k = came.get(k); }
    cells.reverse();
    // string pulling
    const pts: THREE.Vector3[] = [];
    let anchor: [number, number] = [sx, sz];
    for (let i = 0; i < cells.length; i++) {
      const next = cells[i + 1];
      if (next && this.lineWalkable(anchor, next)) continue;
      pts.push(this.center(cells[i][0], cells[i][1]));
      anchor = cells[i];
    }
    if (found) { const last = to.clone(); last.y = this.ctx.world.groundHeight(last.x, last.z) ?? last.y; if (pts.length) pts[pts.length - 1] = last; else pts.push(last); }
    return pts;
  }

  /** Supercover line test over the grid. */
  lineWalkable(a: [number, number], b: [number, number]): boolean {
    let [x0, z0] = a; const [x1, z1] = b;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    let px = x0, pz = z0;
    for (let n = 0; n < 200; n++) {
      if (!this.walkable(x0, z0) || Math.abs(this.groundAt(x0, z0) - this.groundAt(px, pz)) > 0.45) return false;
      if (this.clearance(x0, z0) > 2) return false;
      if (x0 === x1 && z0 === z1) return true;
      px = x0; pz = z0;
      const e2 = 2 * err;
      if (e2 > -dz && e2 < dx) { // diagonal step: require both sides
        if (!this.walkable(x0 + sx, z0) || !this.walkable(x0, z0 + sz)) return false;
      }
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
    }
    return false;
  }

  /** Generate cover spots next to static geometry inside a box region. */
  generateCover(min: THREE.Vector3, max: THREE.Vector3): CoverSpot[] {
    const out: CoverSpot[] = [];
    const [x0, z0] = this.cellOf(min.x, min.z), [x1, z1] = this.cellOf(max.x, max.z);
    const phys = this.ctx.physics;
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    for (let iz = z0; iz <= z1; iz += 1) for (let ix = x0; ix <= x1; ix += 1) {
      if (!this.walkable(ix, iz)) continue;
      // blocked neighbours (4-dir) give the cover normal
      let nx = 0, nz = 0;
      if (!this.walkable(ix + 1, iz)) nx -= 1;
      if (!this.walkable(ix - 1, iz)) nx += 1;
      if (!this.walkable(ix, iz + 1)) nz -= 1;
      if (!this.walkable(ix, iz - 1)) nz += 1;
      if (!nx && !nz) continue;
      if ((ix + iz) % 2) continue; // thin out
      const p = this.center(ix, iz);
      const n = new THREE.Vector3(nx, 0, nz).normalize();
      // height of the obstacle: ray toward it at 1.45 m
      o.copy(p).setY(p.y + 1.45); d.copy(n).negate();
      const high = phys.raycast(o, d, 1.0, { ignoreEnemies: true, ignorePlayer: true });
      o.setY(p.y + 0.8);
      const lowHit = phys.raycast(o, d, 1.0, { ignoreEnemies: true, ignorePlayer: true });
      if (!lowHit) continue;
      out.push({ position: p, normal: n, low: !high, owner: -1 });
    }
    return out;
  }
}

class MinHeap {
  private k: number[] = [];
  private p: number[] = [];
  get size() { return this.k.length; }
  push(key: number, pri: number) {
    const k = this.k, p = this.p;
    k.push(key); p.push(pri);
    let i = k.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= p[i]) break;
      [k[i], k[j]] = [k[j], k[i]]; [p[i], p[j]] = [p[j], p[i]];
      i = j;
    }
  }
  pop(): number | undefined {
    const k = this.k, p = this.p;
    if (!k.length) return undefined;
    const top = k[0];
    const lk = k.pop()!, lp = p.pop()!;
    if (k.length) {
      k[0] = lk; p[0] = lp;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && p[l] < p[m]) m = l;
        if (r < k.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [k[i], k[m]] = [k[m], k[i]]; [p[i], p[m]] = [p[m], p[i]];
        i = m;
      }
    }
    return top;
  }
}

import * as THREE from 'three';

/**
 * Ring-buffer allocator over an interleaved instanced buffer.
 * Prefers dead slots near the head so long-lived particles (lingering smoke) are not stomped by
 * bursts of short ones. Tracks dirty ranges and uploads only what changed (addUpdateRange).
 */
export class InstancePool {
  readonly data: Float32Array;
  readonly buffer: THREE.InstancedInterleavedBuffer;
  private death: Float32Array;
  private head = 0;
  private ranges: number[] = []; // pairs lo,hi (inclusive slot indices)
  private lo = -1;
  private hi = -1;

  constructor(readonly capacity: number, readonly stride: number) {
    this.data = new Float32Array(capacity * stride);
    // mark all slots dead: t0 far in the past with tiny life (for layouts where [3]=t0,[7]=life)
    this.death = new Float32Array(capacity).fill(-1);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, stride, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
  }

  /** Returns the float offset of the allocated slot. */
  alloc(t0: number, life: number): number {
    const cap = this.capacity;
    let slot = this.head;
    const now = t0;
    // look ahead a few slots for a dead one
    for (let i = 0; i < 12; i++) {
      const s = (this.head + i) % cap;
      if (this.death[s] <= now) { slot = s; break; }
    }
    this.head = (slot + 1) % cap;
    this.death[slot] = t0 + life;
    this.markDirty(slot);
    return slot * this.stride;
  }

  private markDirty(i: number): void {
    if (this.lo < 0) { this.lo = this.hi = i; return; }
    if (i >= this.lo && i <= this.hi) return;
    if (i === this.hi + 1) { this.hi = i; return; }
    if (i === this.lo - 1) { this.lo = i; return; }
    this.ranges.push(this.lo, this.hi);
    this.lo = this.hi = i;
  }

  flush(): void {
    if (this.lo < 0) return;
    this.ranges.push(this.lo, this.hi);
    const r = this.ranges;
    if (r.length > 16) {
      // many scattered writes: upload everything once
      this.buffer.addUpdateRange(0, this.data.length);
    } else {
      for (let i = 0; i < r.length; i += 2) this.buffer.addUpdateRange(r[i] * this.stride, (r[i + 1] - r[i] + 1) * this.stride);
    }
    this.buffer.needsUpdate = true;
    r.length = 0;
    this.lo = this.hi = -1;
  }

  liveEstimate(now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.death[i] > now) n++;
    return n;
  }
}

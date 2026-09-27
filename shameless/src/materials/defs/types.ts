import type * as THREE from 'three';
import type { Surface } from '../../core/events';

export type Mapping = 'world' | 'object' | 'uv';

export interface MatDef {
  /** GLSL: `void gen(vec2 uv, inout Surf s)` over one periodic tile. */
  glsl: string;
  /** Default meters per texture tile. */
  tile: number;
  /** Relief depth (m) of the full height range, at the default tile size. Drives normal strength. */
  depth: number;
  mapping?: Mapping;
  /** Parallax occlusion depth in meters (0/undefined = off). World mapping only. */
  pom?: number;
  /** Stochastic anti-tiling (only for non-structured, noise-like materials). */
  stochastic?: boolean;
  /** Resolution multiplier relative to the quality-tier base size. */
  res?: number;
  /** Baseline wear (cavity grime + ground grime) 0..1. */
  wear?: number;
  /** Baseline dust amount 0..1 (requires dust). */
  dust?: number;
  /** Macro value/hue variation amount (0..0.2 typical). */
  macro?: number;
  /** Cavity AO strength from height (default 1). */
  cavity?: number;
  normalScale?: number;
  physical?: boolean;
  glass?: boolean;
  emissive?: boolean;
  /** Curvature-driven edge wear: bare color (linear) + roughness. */
  edge?: [number, number, number, number];
  /** Per-seed tint variation strength (0..1). */
  seedVar?: number;
  surface: Surface;
  setup?: (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial) => void;
}

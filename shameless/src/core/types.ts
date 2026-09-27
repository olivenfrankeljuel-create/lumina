import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EventBus, Surface } from './events';
import type { Input } from './Input';

/**
 * Module contracts. Each subsystem lives in its own folder and implements one of
 * these interfaces; main.ts wires them together through GameContext.
 * Change a contract only when the owning module and all consumers are updated together.
 */

export interface Quality {
  /** 0 = low (software GL / screenshots fast path), 1 = medium, 2 = high, 3 = ultra */
  tier: 0 | 1 | 2 | 3;
  pixelRatio: number;
  shadowMapSize: number;
}

// ---------- render/ ----------
export interface RenderPipeline {
  /** Render one frame: world scene + first-person viewmodel + post stack. */
  render(dt: number): void;
  setSize(width: number, height: number): void;
  /** Scene + camera the first-person weapon/arms are drawn in (separate FOV, drawn over the world). */
  readonly viewmodelScene: THREE.Scene;
  readonly viewmodelCamera: THREE.PerspectiveCamera;
  /** Main directional sun light (cascaded shadows). */
  readonly sun: THREE.DirectionalLight;
  /** 0..1 aim-down-sights blend, drives DOF / vignette. */
  setADS(amount: number): void;
  /** 0..1 low-health / damage intensity, drives desaturation, vignette, chromatic aberration. */
  setDamage(amount: number): void;
  /** Transient screen effects. */
  flash(intensity: number): void;
  /** Register meshes that should receive/cast shadows and be part of CSM setup. */
  setupShadows(object: THREE.Object3D): void;
  dispose(): void;
}

// ---------- materials/ ----------
export type MaterialName =
  | 'concrete' | 'concrete_dirty' | 'concrete_floor' | 'brick_red' | 'brick_tan' | 'plaster_white' | 'plaster_worn'
  | 'asphalt' | 'dirt' | 'sand' | 'gravel' | 'grass_dry' | 'mud'
  | 'metal_painted_green' | 'metal_painted_blue' | 'metal_rusty' | 'metal_corrugated' | 'metal_bare' | 'metal_diamond_plate'
  | 'wood_planks' | 'wood_pallet' | 'wood_painted' | 'plywood'
  | 'tile_floor' | 'roof_tiles' | 'sandbag' | 'tarp' | 'canvas' | 'rubber' | 'glass' | 'glass_dirty'
  | 'gun_parkerized' | 'gun_polymer_black' | 'gun_polymer_fde' | 'gun_anodized' | 'gun_wood'
  | 'cloth_multicam' | 'cloth_olive' | 'cloth_black' | 'glove_leather' | 'skin'
  | 'car_paint_white' | 'car_paint_red' | 'chrome' | 'plastic_black' | 'emissive_light';

export interface MaterialOptions {
  /** World-space texture repeat (meters per texture tile). Default depends on material. */
  tileSize?: number;
  /** Per-instance tint/variation seed. */
  seed?: number;
  /** Extra wear/dirt 0..1. */
  wear?: number;
}

export interface MaterialLibrary {
  /** Must be awaited once before get(): generates textures on the GPU. */
  init(renderer: THREE.WebGLRenderer): Promise<void>;
  get(name: MaterialName, opts?: MaterialOptions): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** Surface type used for impact FX/audio. */
  surfaceOf(name: MaterialName): Surface;
  /** Environment map for IBL (PMREM), available after init. */
  readonly envMap: THREE.Texture | null;
}

// ---------- physics/ ----------
export interface RaycastHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: Surface;
  object: THREE.Object3D | null;
  /** Set when the ray hit an enemy hitbox. */
  enemyId?: number;
  /** Hitbox region, for damage multipliers. */
  region?: 'head' | 'torso' | 'limb';
  /** Material thickness along the ray from `point` (m); Infinity if > 1.5 m. World/prop hits only. */
  thickness?: number;
  exitPoint?: THREE.Vector3;
  /** True when the ray hit the player capsule. */
  player?: boolean;
}

export interface Physics {
  readonly world: RAPIER.World;
  readonly rapier: typeof RAPIER;
  /** Add a static triangle-mesh or box collider for a mesh (uses world transform). */
  addStatic(object: THREE.Object3D, surface?: Surface): void;
  /** Hitscan against world + registered hitboxes. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts?: { ignorePlayer?: boolean; ignoreEnemies?: boolean }): RaycastHit | null;
  /** Register a dynamic hitbox (capsule/box following a bone) for an enemy. */
  registerHitbox(object: THREE.Object3D, enemyId: number, region: 'head' | 'torso' | 'limb', halfExtents: THREE.Vector3): void;
  unregisterHitboxes(enemyId: number): void;
  step(dt: number): void;
}

// ---------- world/ ----------
export interface World {
  readonly root: THREE.Group;
  readonly playerSpawns: { position: THREE.Vector3; yaw: number }[];
  readonly enemySpawns: THREE.Vector3[];
  /** Waypoints for AI patrol / cover. */
  readonly coverPoints: { position: THREE.Vector3; normal: THREE.Vector3 }[];
  /** Nav helper: ground height at xz, or null if outside the map. */
  groundHeight(x: number, z: number): number | null;
  update(dt: number, time: number): void;
}

// ---------- player/ ----------
export interface PlayerState {
  readonly position: THREE.Vector3; // feet
  readonly velocity: THREE.Vector3;
  readonly eyeHeight: number;
  yaw: number;
  pitch: number;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  readonly crouched: boolean;
  readonly sliding: boolean;
  readonly lean: number; // -1..1
  readonly stridePhase: number; // 0..1, footfalls at 0 and 0.5
  readonly bobWeight: number;
  readonly speed: number; // horizontal m/s
  readonly sprintBlend: number; // 0..1 smoothed
  readonly tacSprinting: boolean;
  readonly tacSprintBlend: number;
  readonly mantling: boolean;
  readonly mantleProgress: number;
  readonly crouchBlend: number;
  readonly slideBlend: number;
  readonly cameraRoll: number;
  /** Seconds until the weapon may fire after leaving sprint/tac-sprint (sprint-out time). */
  readonly sprintOutRemaining: number;
  cancelSprint(): void;
  health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  /** Camera kick/offsets applied by weapons (recoil), consumed by the player camera. */
  addRecoil(pitch: number, yaw: number): void;
  addCameraShake(intensity: number): void;
  damage(amount: number, fromDir: THREE.Vector3 | null): void;
  update(dt: number): void;
  respawn(): void;
}

// ---------- weapons/ ----------
export interface WeaponSystem {
  readonly currentId: string;
  readonly ammoInMag: number;
  readonly magSize: number;
  readonly reserveAmmo: number;
  readonly adsAmount: number; // 0..1
  readonly reloading: boolean;
  /** Target world FOV while aiming (the player camera lerps to it). */
  readonly fovTarget: number;
  /** 0..1, crosshair bloom for HUD. */
  readonly spread: number;
  update(dt: number): void;
}

// ---------- ai/ ----------
export interface EnemyInfo {
  id: number;
  position: THREE.Vector3;
  alive: boolean;
  alerted: boolean;
}

export interface EnemyManager {
  readonly enemies: readonly EnemyInfo[];
  applyHit(enemyId: number, damage: number, point: THREE.Vector3, dir: THREE.Vector3, region: 'head' | 'torso' | 'limb'): void;
  update(dt: number): void;
}

// ---------- fx/ ----------
export interface FX {
  update(dt: number): void;
}

// ---------- audio/ ----------
export interface AudioSystem {
  /** Must be called from a user gesture. */
  resume(): Promise<void>;
  setMasterVolume(v: number): void;
  update(dt: number): void;
}

// ---------- ui/ ----------
export interface HUD {
  update(dt: number): void;
  showMenu(): void;
  hideMenu(): void;
}

export interface GameContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: Input;
  events: EventBus;
  quality: Quality;
  /** Seconds since start (game time). */
  time: number;
  materials: MaterialLibrary;
  pipeline: RenderPipeline;
  physics: Physics;
  world: World;
  player: PlayerState;
  weapons: WeaponSystem;
  enemies: EnemyManager;
  fx: FX;
  audio: AudioSystem;
  hud: HUD;
}

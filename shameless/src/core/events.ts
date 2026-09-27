import type * as THREE from 'three';

export type Surface =
  | 'concrete' | 'brick' | 'metal' | 'wood' | 'dirt' | 'sand' | 'gravel'
  | 'glass' | 'flesh' | 'fabric' | 'water' | 'plaster' | 'asphalt' | 'tile';

export interface GameEvents {
  'weapon:fire': { weaponId: string; origin: THREE.Vector3; dir: THREE.Vector3; muzzle: THREE.Vector3; suppressed: boolean };
  'weapon:dryfire': { weaponId: string };
  'weapon:reload': { weaponId: string; stage: 'start' | 'magout' | 'magin' | 'bolt' | 'end'; empty: boolean };
  'weapon:ads': { active: boolean };
  'weapon:switch': { weaponId: string };
  'shell:eject': { position: THREE.Vector3; velocity: THREE.Vector3; kind: 'rifle' | 'pistol' };
  'bullet:tracer': { from: THREE.Vector3; to: THREE.Vector3; enemy: boolean };
  'bullet:impact': { point: THREE.Vector3; normal: THREE.Vector3; surface: Surface; object?: THREE.Object3D; dir: THREE.Vector3 };
  'bullet:whizby': { point: THREE.Vector3; dir: THREE.Vector3 };
  'enemy:hit': { enemyId: number; point: THREE.Vector3; normal: THREE.Vector3; dir: THREE.Vector3; damage: number; headshot: boolean; killed: boolean };
  'enemy:killed': { enemyId: number; headshot: boolean; position: THREE.Vector3; weaponId: string };
  'enemy:fire': { enemyId: number; origin: THREE.Vector3; dir: THREE.Vector3 };
  'enemy:alert': { enemyId: number; position: THREE.Vector3 };
  'enemy:footstep': { enemyId: number; position: THREE.Vector3; surface: Surface };
  'player:damaged': { amount: number; health: number; fromDir: THREE.Vector3 | null };
  'player:died': Record<string, never>;
  'player:respawn': Record<string, never>;
  'player:footstep': { surface: Surface; position: THREE.Vector3; speed: number; sprinting: boolean; crouched: boolean };
  'player:jump': { position: THREE.Vector3 };
  'player:land': { position: THREE.Vector3; impactSpeed: number; surface: Surface };
  'player:slide': { position: THREE.Vector3 };
  'player:mantle': { position: THREE.Vector3; height: number; vault: boolean };
  'grenade:throw': { origin: THREE.Vector3; velocity: THREE.Vector3 };
  'grenade:bounce': { position: THREE.Vector3; surface: Surface; speed: number };
  'explosion': { position: THREE.Vector3; radius: number; damage: number };
  'score': { points: number; reason: string };
  'game:state': { state: 'menu' | 'playing' | 'paused' | 'dead' };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}

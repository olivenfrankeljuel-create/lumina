/**
 * Collision groups (Rapier InteractionGroups: high 16 bits = membership, low 16 bits = filter).
 * Two colliders interact when (a.membership & b.filter) && (b.membership & a.filter).
 */
export const GROUP = {
  /** Static level geometry (addStatic). */
  WORLD: 1 << 0,
  /** The player character capsule (not part of Rapier ray queries — tested analytically). */
  PLAYER: 1 << 1,
  /** Small, cosmetic bodies (shell casings, gibs, debris): collide with world + props only. */
  DEBRIS: 1 << 2,
  /** Gameplay dynamic bodies (grenades, physics props): block the player and bullets. */
  PROP: 1 << 3,
  /** Ragdoll parts: collide with world, props and other ragdolls. */
  RAGDOLL: 1 << 4,
  ALL: 0xffff,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

export const GROUPS = {
  world: interactionGroups(GROUP.WORLD, GROUP.ALL),
  player: interactionGroups(GROUP.PLAYER, GROUP.WORLD | GROUP.PROP),
  debris: interactionGroups(GROUP.DEBRIS, GROUP.WORLD | GROUP.PROP),
  // Props don't collide with the (query-only) player capsule during the solver step, so grenades spawned
  // at the eye don't explode out of it; the character controller still collides with props via its query.
  prop: interactionGroups(GROUP.PROP, GROUP.WORLD | GROUP.PROP | GROUP.RAGDOLL),
  ragdoll: interactionGroups(GROUP.RAGDOLL, GROUP.WORLD | GROUP.PROP | GROUP.RAGDOLL),
  /** Query filter: what the character controller collides with. */
  queryCharacter: interactionGroups(GROUP.ALL, GROUP.WORLD | GROUP.PROP),
  /** Query filter: what bullets hit (hitboxes are tested separately). */
  queryBullet: interactionGroups(GROUP.ALL, GROUP.WORLD | GROUP.PROP),
  /** Query filter: static world only (ground probes, line of sight). */
  queryWorld: interactionGroups(GROUP.ALL, GROUP.WORLD),
} as const;

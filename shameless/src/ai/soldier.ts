/** Visual soldier: skinned character + rifle + animator, kept in sync each frame. */
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { buildCharacter, type CharacterModel, type Variant } from './character';
import { buildRifle, type RifleModel } from './rifle';
import { Animator } from './pose';
import { B } from './rig';

export class SoldierVisual {
  readonly char: CharacterModel;
  readonly rifle: RifleModel;
  readonly anim = new Animator();
  readonly root: THREE.Group;
  readonly velocity = new THREE.Vector3();
  /** When false the animator is bypassed (ragdoll drives the bones). */
  animated = true;
  private magHome = new THREE.Vector3();

  constructor(ctx: GameContext, v: Variant, polymer: boolean) {
    this.char = buildCharacter(ctx, v);
    this.root = this.char.root;
    this.rifle = buildRifle(ctx, polymer);
    this.char.scaled.add(this.rifle.group);
    this.magHome.copy(this.rifle.mag.position);
  }

  get scale() { return this.char.scaled.scale.x; }

  update(dt: number, ground: (x: number, z: number) => number | null) {
    this.rifle.flash.update(dt);
    if (!this.animated) return;
    const a = this.anim;
    a.update(dt, this.root, this.scale, this.velocity, ground);
    a.apply(this.char.bones);
    this.rifle.group.position.copy(a.riflePos);
    this.rifle.group.quaternion.copy(a.rifleRot);
    const mag = this.rifle.mag;
    if (a.magAttached) {
      mag.position.copy(this.magHome); mag.quaternion.identity();
    } else {
      // magazine follows the left hand: convert model-space target to rifle-local
      const inv = _q.copy(a.rifleRot).invert();
      mag.position.copy(a.magPos).sub(a.riflePos).applyQuaternion(inv);
      mag.quaternion.copy(inv).multiply(a.magRot);
    }
  }

  /** Muzzle world position/direction. */
  muzzle(outPos: THREE.Vector3, outDir?: THREE.Vector3) {
    this.rifle.flash.group.getWorldPosition(outPos);
    if (outDir) outDir.set(0, 0, 1).applyQuaternion(this.rifle.group.getWorldQuaternion(_q));
    return outPos;
  }

  /** Eye (head) world position from the last solve. */
  eye(out: THREE.Vector3) {
    this.anim.boneWorld(B.head, this.root, this.scale, out);
    out.y += 0.08 * this.scale;
    return out;
  }
}
const _q = new THREE.Quaternion();

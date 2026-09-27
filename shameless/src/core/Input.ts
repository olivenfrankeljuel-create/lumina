export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'sprint'
  | 'fire' | 'ads' | 'reload' | 'interact' | 'grenade' | 'melee' | 'weapon1' | 'weapon2'
  | 'swap' | 'leanLeft' | 'leanRight' | 'pause' | 'inspect';

const KEYMAP: Record<string, Action> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', KeyC: 'crouch', ControlLeft: 'crouch', ShiftLeft: 'sprint',
  KeyR: 'reload', KeyF: 'interact', KeyG: 'grenade', KeyV: 'melee',
  Digit1: 'weapon1', Digit2: 'weapon2', KeyQ: 'leanLeft', KeyE: 'leanRight',
  Escape: 'pause', KeyI: 'inspect', KeyX: 'swap',
};

/** Keyboard + mouse state. `pressed` is true only on the frame the action went down. */
export class Input {
  readonly down = new Set<Action>();
  readonly pressed = new Set<Action>();
  readonly released = new Set<Action>();
  mouseDX = 0;
  mouseDY = 0;
  sensitivity = 0.0022;
  locked = false;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      this.down.delete(a);
      this.released.add(a);
    });
    element.addEventListener('mousedown', (e) => {
      const a: Action | null = e.button === 0 ? 'fire' : e.button === 2 ? 'ads' : null;
      if (!a) return;
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    });
    window.addEventListener('mouseup', (e) => {
      const a: Action | null = e.button === 0 ? 'fire' : e.button === 2 ? 'ads' : null;
      if (!a) return;
      this.down.delete(a);
      this.released.add(a);
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) this.down.clear();
    });
  }

  requestLock(): void {
    this.element.requestPointerLock?.();
  }

  /** Programmatic control for tests/screenshots. */
  simulate(action: Action, isDown: boolean): void {
    if (isDown) { if (!this.down.has(action)) this.pressed.add(action); this.down.add(action); }
    else { this.down.delete(action); this.released.add(action); }
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}

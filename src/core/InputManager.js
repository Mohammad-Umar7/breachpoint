/**
 * InputManager — keyboard, mouse and Pointer Lock.
 *
 * Design notes:
 *  - Mouse deltas are *accumulated* between frames and drained by the player
 *    each frame. Raw `movementX/Y` events can fire several times per frame at
 *    high polling rates; summing them keeps aim 1:1 regardless of frame rate.
 *  - `isDown()` reports held state, `wasPressed()` reports an edge that is
 *    cleared once per frame by `endFrame()`.
 *  - All listeners are registered on `document`/`window` and removed by
 *    `dispose()` so the game can be torn down and rebuilt without leaking.
 */

export const KEY_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  // Shift doubles as sprint and, while scoped, as the breath-hold key.
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  reload: ['KeyR'],

  // Loadout slots: primary / secondary / knife / grenade
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  lastWeapon: ['KeyX'],
  quickMelee: ['KeyV'],
  quickGrenade: ['KeyG'],
  inspect: ['KeyT'],

  // Tactical peeking
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],

  zoomToggle: ['KeyB'],
  flashlight: ['KeyF'],
  pause: ['Escape', 'KeyP'],
  stats: ['F3'],
});

export class InputManager {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    /** @type {Set<string>} currently held key codes */
    this.keys = new Set();
    /** @type {Set<string>} keys that went down since the last endFrame() */
    this.keysPressed = new Set();
    /** @type {Set<string>} keys released since the last endFrame() */
    this.keysReleased = new Set();

    /** @type {Set<number>} held mouse buttons (0 = left, 2 = right) */
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseReleased = new Set();

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;

    this.pointerLocked = false;
    this.enabled = true;

    /** Consumers can hook this to react to lock loss (e.g. auto-pause). */
    this.onPointerLockChange = null;
    /** Fired when the user requests pause with the keyboard. */
    this.onPauseRequested = null;

    this._bind();
  }

  // ------------------------------------------------------------------ setup
  _bind() {
    this._onKeyDown = (e) => {
      // Stop the browser scrolling / quick-find while playing.
      if (SWALLOWED_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'F3') e.preventDefault();

      this.keys.add(e.code);
      this.keysPressed.add(e.code);

      if (KEY_BINDINGS.pause.includes(e.code)) {
        this.onPauseRequested?.(e.code);
      }
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.keysReleased.add(e.code);
    };

    this._onMouseDown = (e) => {
      if (!this.pointerLocked) return;
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    };

    this._onMouseUp = (e) => {
      this.mouseButtons.delete(e.button);
      this.mouseReleased.add(e.button);
    };

    this._onMouseMove = (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      // Chrome can report absurd spikes when the pointer re-locks; clamp them.
      const dx = clampSpike(e.movementX);
      const dy = clampSpike(e.movementY);
      this.mouseDX += dx;
      this.mouseDY += dy;
    };

    this._onWheel = (e) => {
      if (!this.pointerLocked) return;
      e.preventDefault();
      this.wheelDelta += Math.sign(e.deltaY);
    };

    this._onContextMenu = (e) => e.preventDefault();

    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        // Never leave a button "stuck down" when focus is lost.
        this.mouseButtons.clear();
        this.keys.clear();
      }
      this.onPointerLockChange?.(this.pointerLocked);
    };

    this._onPointerLockError = () => {
      console.warn('[Input] Pointer lock request failed.');
      this.pointerLocked = false;
      this.onPointerLockChange?.(false);
    };

    this._onBlur = () => {
      this.keys.clear();
      this.mouseButtons.clear();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
  }

  // ------------------------------------------------------------ pointer lock
  requestPointerLock() {
    if (this.pointerLocked) return;
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    // Chrome returns a promise when `unadjustedMovement` is requested; if raw
    // input is unsupported it rejects and we retry with the plain call.
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        try {
          this.canvas.requestPointerLock();
        } catch (err) {
          console.warn('[Input] Pointer lock unavailable.', err);
        }
      });
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ query
  isDown(action) {
    const codes = KEY_BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    const codes = KEY_BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this.keysPressed.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = KEY_BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this.keysReleased.has(c)) return true;
    return false;
  }

  isMouseDown(button) {
    return this.mouseButtons.has(button);
  }

  mouseWasPressed(button) {
    return this.mousePressed.has(button);
  }

  mouseWasReleased(button) {
    return this.mouseReleased.has(button);
  }

  /** Drains the accumulated look delta. Call exactly once per frame. */
  consumeLookDelta(out) {
    out.x = this.mouseDX;
    out.y = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  consumeWheel() {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  /** Clears one-frame edge state. Call at the very end of the frame. */
  endFrame() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
  }

  /** Drop all held/edge state — used when the game is paused or reset. */
  clearAll() {
    this.keys.clear();
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mouseButtons.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
  }
}

const SWALLOWED_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Tab', 'F3',
]);

const MAX_MOUSE_STEP = 260;
function clampSpike(v) {
  if (!Number.isFinite(v)) return 0;
  return v > MAX_MOUSE_STEP ? MAX_MOUSE_STEP : v < -MAX_MOUSE_STEP ? -MAX_MOUSE_STEP : v;
}

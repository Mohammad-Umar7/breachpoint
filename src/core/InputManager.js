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
  /**
   * Take the scout drone out, and put it away again — one key, both ways.
   *
   * It has to be in this frozen literal rather than assigned at runtime for two
   * reasons. `Object.freeze` makes a later `KEY_BINDINGS.drone = [...]` throw in
   * strict mode, which every module is; and `BOUND_KEYS` is derived from this
   * object once at module load, so a binding added afterwards would never get
   * its `preventDefault` and Ctrl+Z — crouch plus drone — would reach the
   * browser's undo instead of the game.
   */
  drone: ['KeyZ'],
  /**
   * Put a carried flag down, for passing it to a teammate.
   *
   * Took over KeyF from a `flashlight` binding that nothing had ever read —
   * the game has no flashlight. A dead binding on a good key.
   */
  dropFlag: ['KeyF'],
  pause: ['Escape', 'KeyP'],
  stats: ['F3'],
  /** Held, not toggled — the scoreboard shows for as long as you hold it. */
  scoreboard: ['Tab'],
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
    /**
     * Whether the game wants the mouse at all.
     *
     * True between requestPointerLock() and exitPointerLock() — that is, while
     * a match is being played — and it is what tells a click on the canvas to
     * re-acquire a lock that was refused, rather than doing it in a menu.
     */
    this.wantsPointerLock = false;
    /** True once navigator.keyboard.lock() has been granted — see _lockKeyboard. */
    this._keyboardLocked = false;
    /** Set by Escape/P so a deliberate exit is not treated as a browser hiccup. */
    this._pauseRequested = false;
    /** Pending "the lock really is gone" report. See _onPointerLockChange. */
    this._lockLossTimer = 0;
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
      // While locked, the game owns every key it binds — see BOUND_KEYS for
      // why (Ctrl+W / Ctrl+D / Ctrl+R collisions with crouch).
      if (this.pointerLocked && BOUND_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'F3') e.preventDefault();

      this.keys.add(e.code);
      this.keysPressed.add(e.code);

      if (KEY_BINDINGS.pause.includes(e.code)) {
        // Marks the pointer-lock loss that follows as deliberate, so it is
        // reported at once instead of going through the recovery delay.
        this._pauseRequested = true;
        this.onPauseRequested?.(e.code);
      }
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.keysReleased.add(e.code);
    };

    this._onMouseDown = (e) => {
      /*
       * A click while the game wants the mouse and does not have it RE-ASKS.
       *
       * The request made when a match starts nearly always fails, and for a
       * reason no retry inside the game can fix: pointer lock needs transient
       * user activation, and starting a match is a chain of asynchronous work
       * — connect, agree a room, build the arena — so by the time the game is
       * ready the click that began it has long since stopped counting. The
       * player arrives in a live match with a visible cursor and a mouse that
       * does nothing, which reads as the game being broken rather than as one
       * missing permission.
       *
       * A click IS a fresh activation, so asking here always works. The event
       * is swallowed rather than passed on: this click bought the lock, and
       * firing a weapon with it would mean the first shot of every match is
       * one the player did not aim.
       */
      if (!this.pointerLocked) {
        if (this.wantsPointerLock && this.enabled) this._plainPointerLock();
        return;
      }
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

    /*
     * Kill the browser context menu everywhere, not just over the canvas.
     *
     * Right mouse is aim-down-sights, so the menu must never appear — and when
     * it does it takes pointer lock with it, which drops the player into the
     * pause screen. Bound to the canvas alone it was easy to miss: any
     * right-click that landed while the lock was not held, or on any element
     * other than the canvas, opened the menu as normal.
     */
    this._onContextMenu = (e) => e.preventDefault();

    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.pointerLocked) {
        clearTimeout(this._lockLossTimer);
        this._lockLossTimer = 0;
        this._lockKeyboard();
        this.onPointerLockChange?.(true);
        return;
      }

      this._unlockKeyboard();
      // Never leave a button "stuck down" when focus is lost.
      this.mouseButtons.clear();
      this.keys.clear();

      /*
       * Losing the lock does not always mean the player wants to stop.
       *
       * Pressing Escape does, and that is reported at once so the pause menu
       * feels instant. Everything else — a context menu that slipped through,
       * a re-lock racing an exit, a browser hiccup — is transient, and
       * reporting it immediately is what made the pause screen "randomly open"
       * while right-clicking or holding Ctrl.
       *
       * So an unrequested loss gets one silent attempt to recover, and is only
       * reported if the lock is really gone a moment later.
       */
      if (this._pauseRequested) {
        this._pauseRequested = false;
        this.onPointerLockChange?.(false);
        return;
      }

      clearTimeout(this._lockLossTimer);
      this._lockLossTimer = setTimeout(() => {
        this._lockLossTimer = 0;
        if (document.pointerLockElement === this.canvas) return;   // it came back
        this.onPointerLockChange?.(false);
      }, 220);
    };

    this._onPointerLockError = () => {
      /*
       * A failed REQUEST is not a lost lock.
       *
       * Chrome refuses a request that arrives too soon after an exit, or while
       * another is in flight — both routine. Treating that as "the player left
       * the game" pauses a match that never stopped, which is the other half
       * of the menu opening on its own.
       */
      console.warn('[Input] Pointer lock request failed.');
      if (document.pointerLockElement === this.canvas) return;
      this.pointerLocked = false;
    };

    /*
     * Anything that can take the input away has to drop every held button.
     *
     * A `mousedown` is only recorded while the pointer is locked, but a
     * `mouseup` that never arrives leaves the trigger latched down — and an
     * automatic weapon fires on `isMouseDown` alone, so the gun keeps
     * shooting with nobody touching the mouse. blur covers most of it;
     * visibilitychange covers switching tab or workspace, which does not
     * always raise blur first, and pointerup is a second chance at the
     * release in environments that deliver one and not the other.
     */
    this._onBlur = () => {
      this.keys.clear();
      this.mouseButtons.clear();
    };

    this._onVisibility = () => {
      if (document.hidden) this._onBlur();
    };

    this._onPointerUp = (e) => {
      this.mouseButtons.delete(e.button);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('pointerup', this._onPointerUp);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('contextmenu', this._onContextMenu, { capture: true });
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
  }

  // ------------------------------------------------------------ pointer lock
  requestPointerLock() {
    this.wantsPointerLock = true;
    if (this.pointerLocked) return;

    // `unadjustedMovement` asks for raw, unaccelerated mouse input — and it is
    // only available in a SECURE CONTEXT (https, or localhost).
    //
    // This mattered far more than it looks. On an insecure origin — which a LAN
    // address like http://192.168.1.50:5173 is — Chrome rejects the promise.
    // The old code retried with the plain call inside .catch(), but by the time
    // a rejected promise's handler runs, the transient user activation from the
    // click has expired, so the retry is refused as well. Both attempts fail
    // silently, pointer lock never engages, and the game renders perfectly at
    // full frame rate while the mouse does nothing at all. It presents as the
    // game being completely stuck rather than as a permissions problem.
    //
    // So: only ask for raw input where it can actually be granted, and
    // otherwise make the plain request synchronously, still inside the gesture.
    if (!window.isSecureContext) {
      this._plainPointerLock();
      return;
    }

    let p;
    try {
      p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    } catch {
      this._plainPointerLock();
      return;
    }
    if (p && typeof p.catch === 'function') {
      // Must not be left unhandled: a refusal here is routine (the document
      // not focused, a request too soon after an exit) and an unhandled
      // rejection is noise that hides real errors.
      p.catch(() => this._plainPointerLock());
    }
  }

  /**
   * Capture the keys the browser refuses to hand over.
   *
   * `preventDefault()` covers most Ctrl combinations, but a few are reserved by
   * the browser itself and never reach the page's default-prevention at all —
   * Ctrl+W above everything, which is *crouch + forward* and would close the
   * tab mid-match. The Keyboard Lock API exists for exactly this, and is the
   * only way to hold on to those keys.
   *
   * It is only granted in fullscreen, so this is best-effort: it succeeds for
   * players in fullscreen and quietly does nothing otherwise. Nothing depends
   * on it — it is a second layer over the preventDefault path.
   */
  _lockKeyboard() {
    const kb = navigator.keyboard;
    if (!kb?.lock || this._keyboardLocked) return;
    // Naming the keys rather than locking everything keeps Escape working, so
    // there is always a way out of the game.
    kb.lock(['KeyW', 'KeyT', 'KeyN', 'KeyD', 'KeyR', 'KeyS', 'KeyA', 'KeyF', 'KeyP'])
      .then(() => { this._keyboardLocked = true; })
      .catch(() => { /* not fullscreen, or unsupported — preventDefault still applies */ });
  }

  _unlockKeyboard() {
    if (!this._keyboardLocked) return;
    this._keyboardLocked = false;
    try { navigator.keyboard?.unlock?.(); } catch { /* noop */ }
  }

  _plainPointerLock() {
    try {
      // Newer Chrome returns a PROMISE from the no-argument form too, so the
      // try/catch alone is not enough — a refusal rejects asynchronously and
      // surfaces as an unhandled rejection in the console rather than being
      // caught here. Swallow it explicitly.
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => console.warn('[Input] Pointer lock refused.', err?.message ?? err));
      }
    } catch (err) {
      console.warn('[Input] Pointer lock unavailable.', err);
    }
  }

  exitPointerLock() {
    this.wantsPointerLock = false;
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
    clearTimeout(this._lockLossTimer);
    this._unlockKeyboard();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('pointerup', this._onPointerUp);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('contextmenu', this._onContextMenu, { capture: true });
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
  }
}

const SWALLOWED_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Tab', 'F3',
]);

/**
 * Every key the game binds, flattened.
 *
 * While pointer lock is held, ALL of these get `preventDefault()` — not just
 * the scroll keys above. The reason is modifier collisions: crouch is bound to
 * Ctrl, so crouch-walking is Ctrl+W, crouch-strafing right is Ctrl+D, and
 * crouch-reloading is Ctrl+R. Those are Chrome's close-tab, bookmark and
 * reload shortcuts. Crouching and moving would pop the bookmark dialog or
 * reload the page mid-match.
 *
 * Escape is deliberately excluded — it has to keep working to release pointer
 * lock, otherwise there is no way out of the game.
 */
const BOUND_KEYS = new Set(
  Object.entries(KEY_BINDINGS)
    .flatMap(([, codes]) => codes)
    .filter((code) => code !== 'Escape'),
);

const MAX_MOUSE_STEP = 260;
function clampSpike(v) {
  if (!Number.isFinite(v)) return 0;
  return v > MAX_MOUSE_STEP ? MAX_MOUSE_STEP : v < -MAX_MOUSE_STEP ? -MAX_MOUSE_STEP : v;
}

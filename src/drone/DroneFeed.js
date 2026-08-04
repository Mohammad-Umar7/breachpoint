/**
 * DroneFeed — the drone's camera, rendered into a small texture at 20 Hz.
 *
 * WHAT IT IS
 * ----------
 * One `WebGLRenderTarget` and one extra `renderer.render()` per feed frame,
 * from the POV camera `DroneActor` owns. `DroneScreen` samples the result. That
 * is the whole class; everything below is about what it costs and what breaks
 * if the lifecycle is got wrong.
 *
 * WHY IT IS NOT ScopeRenderer
 * ---------------------------
 * The scope is the existing precedent for "a live view from another camera on a
 * surface", and three things about it are deliberately NOT copied:
 *
 *  1. THE COLOUR TRANSFORM. `SCOPE_FRAG` tone maps and sRGB-encodes the captured
 *     image itself, because the scope is composited by a raw overlay drawn
 *     straight to the canvas AFTER the composer has finished — nothing else was
 *     ever going to transform it. The drone panel is ordinary view-model
 *     geometry drawn INSIDE the composer by `ViewModelPass`, so `OutputPass`
 *     transforms it along with the rest of the frame. Doing it here as well
 *     would apply the curve twice, which is the same 2-4x brightness error the
 *     scope's comment records, in the opposite direction. See `DroneScreen`.
 *  2. THE LISTENERS. `ScopeRenderer` subscribes to `quality` and `renderScale`
 *     and throws away both unsubscribe closures, so a `Game` that is disposed
 *     and rebuilt leaves a dead renderer rebuilding a disposed target for the
 *     life of the page. Every subscription here is stored and released.
 *  3. THE SIZE. The scope reads the DRAWING BUFFER size because its shader is
 *     positioned from `gl_FragCoord`. Nothing here is: the target is a fixed
 *     4:3 and the quad is a fixed 4:3, so this class never touches the window
 *     resize path and cannot inherit the devicePixelRatio bug that bit it.
 *
 * THE COST LEVER
 * --------------
 * A second full scene render is the most expensive thing the drone does, so it
 * is paid for three times over: a quarter-VGA target, 20 Hz instead of the
 * frame rate, and `shadowMap.autoUpdate` forced off for the duration of the one
 * pass. The feed therefore shows last frame's shadow map, which on a 640x480
 * panel refreshed every 50 ms is not something anyone can see, and it halves
 * the number of shadow passes the frame does.
 */

import * as THREE from 'three';
import { DRONE } from '../net/protocol.js';

/**
 * Feed resolution by quality preset. 4:3 in every case, because the POV camera
 * and the panel quad are both fixed at 4:3 — a mismatch here would stretch the
 * picture rather than letterbox it, and it would do so silently.
 */
const FEED_SIZE = Object.freeze({
  low: Object.freeze([256, 192]),
  medium: Object.freeze([512, 384]),
  high: Object.freeze([640, 480]),
  ultra: Object.freeze([640, 480]),
});
const DEFAULT_SIZE = FEED_SIZE.high;

/**
 * The Low preset drops the feed to 12 Hz as well as to 256x192.
 *
 * Low is the preset the `PerformanceGovernor` steps down TO when the machine is
 * already missing frames, so it is exactly the moment a second scene render is
 * least affordable. Held frames are far cheaper than a lower main frame rate.
 */
const LOW_FEED_HZ = 12;

export class DroneFeed {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(renderer, scene, settings) {
    this.renderer = renderer;
    this.scene = scene;
    this.settings = settings;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.target = null;
    /** @type {import('./DroneScreen.js').DroneScreen|null} the panel showing it */
    this.screen = null;

    /** Wall-clock deadline for the next feed frame, in `performance.now()` ms. */
    this._nextFrameAt = 0;

    /**
     * Every `settings.onChange` closure, kept so `dispose()` can release them.
     *
     * Not optional bookkeeping: the listener captures `this`, and `Settings`
     * outlives `Game`. Dropping them is what leaves a disposed DroneFeed
     * rebuilding a render target on a disposed renderer every time the player
     * touches the graphics menu, for the rest of the session.
     */
    this._unsubscribes = [];

    this._createTarget();

    /*
     * Both keys, and `renderScale` is not redundant.
     *
     * `Settings.set('quality', ...)` writes the new preset value FIRST and then
     * emits every individual key the preset governs before emitting `quality`
     * itself — so on a `PerformanceGovernor` step-down, `renderScale` arrives
     * first and `_createTarget` already reads the new preset. Subscribing to it
     * is what re-points the panel at the earliest possible emission instead of
     * leaving it on a disposed texture for the rest of that fan-out. The size
     * guard inside `_createTarget` makes whichever of the two arrives second
     * cost nothing.
     */
    const onBudgetChanged = () => this._createTarget();
    this._unsubscribes.push(this.settings.onChange('quality', onBudgetChanged));
    this._unsubscribes.push(this.settings.onChange('renderScale', onBudgetChanged));
  }

  /** The texture the panel samples. Changes identity whenever the target does. */
  get texture() { return this.target?.texture ?? null; }

  /** Feed frames per second at the current preset. */
  get hz() {
    return this.settings.get('quality') === 'low' ? LOW_FEED_HZ : DRONE.feedHz;
  }

  /**
   * Point a panel at this feed. Also the only way `_createTarget` knows who to
   * re-point when the target is rebuilt underneath it.
   *
   * @param {import('./DroneScreen.js').DroneScreen|null} screen
   */
  attach(screen) {
    this.screen = screen ?? null;
    this._pointScreenAtTarget();
  }

  /**
   * Build (or rebuild) the render target for the current preset.
   *
   * `HalfFloatType` + `NoColorSpace` because what is captured is raw linear
   * radiance, exactly as the main frame's composer target holds it — the
   * transform to display space happens once, at the end, for both.
   */
  _createTarget() {
    const [w, h] = FEED_SIZE[this.settings.get('quality')] ?? DEFAULT_SIZE;
    // Identity guard. A preset change emits several keys and this is subscribed
    // to two of them; rebuilding twice would throw away a perfectly good GPU
    // allocation and hand the panel a second new texture in the same tick.
    if (this.target && this.target.width === w && this.target.height === h) return;

    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      // No MSAA, ever. The panel is deliberately a low-resolution CRT with
      // scanlines drawn over it; resolving multisamples for something that is
      // then aliased on purpose is pure cost.
      samples: 0,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    // The next render must draw rather than hold: the new target is empty, and
    // a held frame here means a black panel until the throttle next elapses.
    this._nextFrameAt = 0;
    this._pointScreenAtTarget();
  }

  /**
   * Hand the panel the current texture and its size.
   *
   * Called on every rebuild, and that is the whole reason `attach` exists. The
   * `PerformanceGovernor` steps the quality preset down mid-match with no user
   * action at all, which disposes the target the panel's material is still
   * holding — and a disposed render-target texture does not draw the last good
   * frame, it draws black, with nothing thrown and nothing logged.
   *
   * The size goes with it because the panel's scanline pitch is one line per
   * SOURCE row; left stale it would draw 480 lines over a 192-line image and
   * turn the picture into a moire.
   */
  _pointScreenAtTarget() {
    if (!this.screen || !this.target) return;
    const material = this.screen.material;
    if (!material) return;
    material.uniforms.uFeed.value = this.target.texture;
    material.uniforms.uFeedSize.value.set(this.target.width, this.target.height);
    material.needsUpdate = true;
  }

  /**
   * Render one feed frame, if one is due.
   *
   * Call it from `Game._render`, after `renderer.info.reset()` so its draw
   * calls show up in the HUD's counter rather than hiding, and before
   * `postfx.render(dt)` so the panel drawn by `ViewModelPass` this frame is
   * sampling this frame's capture.
   *
   * @param {THREE.PerspectiveCamera|null} camera the drone's POV camera
   * @param {boolean} piloting
   * @returns {boolean} true if a frame was actually drawn
   */
  renderFeed(camera, piloting) {
    if (!piloting || !camera || !this.target) return false;

    const now = performance.now();
    if (now < this._nextFrameAt) return false;
    // Set from NOW rather than advanced by a period, so a long frame cannot
    // leave a debt that makes the feed run flat out to catch up — which is
    // exactly the wrong response to the machine already being behind.
    this._nextFrameAt = now + 1000 / this.hz;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    /*
     * Read the flag rather than assuming it is true.
     *
     * Restoring it to a hardcoded `true` would silently switch shadows back on
     * for anybody who had turned them off, and it would do so from inside a
     * subsystem that has no business having an opinion about the main frame.
     */
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;

    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, camera);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    return true;
  }

  dispose() {
    for (const off of this._unsubscribes) off();
    this._unsubscribes.length = 0;
    this.target?.dispose();
    this.target = null;
    this.screen = null;
  }
}

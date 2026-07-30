/**
 * SensitivityManager — turns raw mouse deltas into camera rotation.
 *
 * Everything to do with "how fast does the view turn" lives here so the aim
 * feel is consistent and tunable from one place:
 *
 *   - A human-friendly 0.1 – 5.0 dial (1.0 = default) mapped to radians/pixel.
 *   - Independent horizontal / vertical trim.
 *   - Zoom-compensated ADS and scope multipliers, so a 6x scope doesn't feel
 *     6x twitchier than the hip-fire view.
 *   - Optional mouse smoothing and (opt-in) acceleration.
 *
 * Zoom compensation: turning rate is scaled by tan(adsFov/2) / tan(baseFov/2).
 * This keeps the *on-screen* travel of the crosshair constant regardless of
 * zoom, which is what makes high-magnification optics usable.
 */

import { clamp, damp } from './MathUtils.js';

/** Radians of view rotation per pixel of mouse movement at sensitivity 1.0. */
const RAD_PER_PIXEL = 0.0012;

export class SensitivityManager {
  /** @param {import('./Settings.js').Settings} settings */
  constructor(settings) {
    this.settings = settings;
    this.smoothX = 0;
    this.smoothY = 0;
  }

  /**
   * Convert a frame's accumulated mouse delta into yaw/pitch deltas.
   *
   * @param {{x:number, y:number}} raw    accumulated movementX / movementY
   * @param {number} dt                   frame delta, seconds
   * @param {object} ctx
   * @param {number} ctx.adsProgress      0 = hip, 1 = fully aimed
   * @param {number} ctx.scopeProgress    0 = no scope, 1 = fully scoped
   * @param {number} ctx.baseFov          the un-zoomed vertical FOV, degrees
   * @param {number} ctx.currentFov       the current vertical FOV, degrees
   * @param {number} [ctx.extraScale]     e.g. breath-hold steadying
   * @returns {{yaw:number, pitch:number}} radians (yaw is subtractive)
   */
  compute(raw, dt, ctx) {
    const s = this.settings;

    let dx = raw.x;
    let dy = raw.y;

    // --- optional acceleration: faster flicks turn further -----------------
    if (s.get('mouseAcceleration')) {
      const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-4); // px/s
      // Gentle curve: +0% at rest, up to +45% on a fast flick.
      const accel = 1 + clamp(speed / 6000, 0, 0.45);
      dx *= accel;
      dy *= accel;
    }

    // --- optional smoothing: trades a little latency for steadier aim ------
    if (s.get('mouseSmoothing')) {
      this.smoothX = damp(this.smoothX, dx, 38, dt);
      this.smoothY = damp(this.smoothY, dy, 38, dt);
      dx = this.smoothX;
      dy = this.smoothY;
    } else {
      this.smoothX = dx;
      this.smoothY = dy;
    }

    // --- base rate --------------------------------------------------------
    const base = clamp(s.get('sensitivity'), 0.05, 6) * RAD_PER_PIXEL;

    // --- aim multiplier ---------------------------------------------------
    // A scoped optic *replaces* the ADS multiplier rather than stacking with
    // it. Stacking them (plus the weapon's own trim, plus zoom compensation)
    // compounded to 2.8% of hip-fire speed on a 5x scope, which is unusable.
    const adsMul = lerpMul(1, s.get('adsSensitivity'), ctx.adsProgress);
    const scopeMul = s.get('scopeSensitivity');
    const userMul = lerpMul(adsMul, scopeMul, ctx.scopeProgress);

    // --- zoom compensation ------------------------------------------------
    // Raising the FOV ratio to a power lets the player choose how much
    // magnification is allowed to slow the view:
    //   1.0 = physically correct (crosshair travels the same distance across
    //         the screen at 1x and 9x, so a 9x scope turns 9x slower)
    //   0.0 = magnification ignored; scoped turns as fast as hip fire
    // Full compensation is technically right but reads as sluggish, so the
    // default sits around half way.
    const k = clamp(s.get('zoomCompensation'), 0, 1);
    const zoomMul = Math.pow(fovRatio(ctx.currentFov, ctx.baseFov), k);

    const scale = base * userMul * zoomMul * (ctx.extraScale ?? 1);
    const invert = s.get('invertY') ? -1 : 1;

    return {
      yaw: -dx * scale * s.get('sensitivityX'),
      pitch: -dy * scale * s.get('sensitivityY') * invert,
    };
  }

  /** Reset smoothing state — call when the pointer is (re)locked. */
  reset() {
    this.smoothX = 0;
    this.smoothY = 0;
  }
}

function lerpMul(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * How fast the crosshair travels across the *screen* compared with hip fire,
 * for the given aim state. Because zoom compensation cancels the FOV term,
 * this is simply the user multiplier times the weapon's own trim — which is
 * the number a player actually feels. Used for the live settings readout.
 *
 * @param {import('./Settings.js').Settings} settings
 * @param {'hip'|'ads'|'scope'} mode
 * @param {number} weaponTrim  the weapon's `adsSensitivity`
 */
export function effectiveAimSpeed(settings, mode, weaponTrim = 1, magnification = 1) {
  if (mode === 'hip') return 1;
  const user = mode === 'scope'
    ? settings.get('scopeSensitivity')
    : settings.get('adsSensitivity');
  const k = clamp(settings.get('zoomCompensation'), 0, 1);
  // How fast the view actually turns, relative to hip fire — the number a
  // player means when they say "sensitivity".
  return user * weaponTrim * Math.pow(magnification, -k);
}

/**
 * Ratio of the projected half-heights of two FOVs. At 1x this is 1; at high
 * zoom it shrinks, slowing the view proportionally to the magnification.
 */
function fovRatio(currentFovDeg, baseFovDeg) {
  const cur = Math.tan((currentFovDeg * Math.PI) / 360);
  const base = Math.tan((baseFovDeg * Math.PI) / 360);
  if (base <= 1e-5) return 1;
  return clamp(cur / base, 0.05, 1);
}

export { RAD_PER_PIXEL };

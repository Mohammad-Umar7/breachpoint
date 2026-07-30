/**
 * ADSSystem — everything about aiming down sights.
 *
 * Owns the aim intent (hold vs toggle), the 0..1 blend that drives the view
 * model into the sight line, the world FOV, scope engagement, adjustable
 * zoom, optical sway and the breath-hold mechanic.
 *
 * Two distinct progress values matter:
 *
 *   `progress`       0..1  how far the weapon has moved into the sight line.
 *                          Drives view-model position, FOV, spread and sway.
 *   `scopeProgress`  0..1  how "inside the glass" we are. Only non-zero for
 *                          weapons with `optic.scoped`, and only once the
 *                          weapon is nearly shouldered — this is what fades in
 *                          the scope overlay, so you never see the scope
 *                          picture while the rifle is still swinging up.
 *
 * The blend curve is a smootherstep rather than a linear ramp: it leaves the
 * hip pose quickly, settles into the sight gently, and never feels like a
 * teleport or a slow drag.
 */

import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/MathUtils.js';
import { opticMagnification, fovForMagnification } from './WeaponDefinitions.js';

const MOUSE_RIGHT = 2;

/** Scope glass only takes over once the weapon is essentially shouldered. */
const SCOPE_ENGAGE = 0.86;

export class ADSSystem {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../core/InputManager.js').InputManager} input
   */
  constructor(settings, input, audio) {
    this.settings = settings;
    this.input = input;
    this.audio = audio;

    this.progress = 0;
    this.scopeProgress = 0;
    this.toggleState = false;
    this.enabled = true;

    /** Selected zoom step for optics with multiple magnifications. */
    this.zoomIndex = 0;

    // --- breath hold ---
    this.holding = false;
    this.breath = 1;          // 1 = full, 0 = spent
    this.swayPhase = Math.random() * 100;
    this.sway = new THREE.Vector2();

    this._lastAdsIntent = false;
    this._wasScoped = false;
  }

  /** True when the current weapon presents a full scope overlay. */
  isScopedWeapon(weapon) {
    return !!weapon?.def?.optic?.scoped && !weapon.def.noAds;
  }

  /** Current magnification for the equipped weapon. */
  magnification(weapon) {
    if (!weapon) return 1;
    return opticMagnification(weapon.def, this.zoomIndex);
  }

  /** Number of selectable zoom steps (1 = not adjustable). */
  zoomSteps(weapon) {
    const mags = weapon?.def?.optic?.magnifications;
    return Array.isArray(mags) ? mags.length : 1;
  }

  /** Cycle to the next zoom step. Only meaningful while scoped. */
  cycleZoom(weapon) {
    const steps = this.zoomSteps(weapon);
    if (steps <= 1) return false;
    this.zoomIndex = (this.zoomIndex + 1) % steps;
    this.audio?.play('scopeZoom');
    return true;
  }

  /**
   * Compute this frame's aim intent from input + the hold/toggle setting.
   * @param {import('./Weapon.js').Weapon} weapon
   * @param {boolean} allowed  false while dead, sprinting-locked, switching…
   */
  computeIntent(weapon, allowed) {
    if (!allowed || !this.enabled || !weapon || weapon.def.noAds) {
      this.toggleState = false;
      return false;
    }

    if (this.settings.get('aimMode') === 'toggle') {
      if (this.input.mouseWasPressed(MOUSE_RIGHT)) this.toggleState = !this.toggleState;
      return this.toggleState;
    }

    this.toggleState = false;
    return this.input.isMouseDown(MOUSE_RIGHT);
  }

  /**
   * Advance the ADS blend.
   *
   * @param {number} dt
   * @param {import('./Weapon.js').Weapon} weapon
   * @param {boolean} intent
   * @param {object} ctx  { holdBreathPressed, moving }
   */
  update(dt, weapon, intent, ctx = {}) {
    const def = weapon?.def;
    const adsTime = Math.max(0.05, def?.adsTime ?? 0.2);

    // --- main blend ------------------------------------------------------
    // Raise slightly faster than we lower: snappy to aim, relaxed to drop.
    const rate = intent ? 1 / adsTime : 1 / (adsTime * 0.82);
    const target = intent ? 1 : 0;
    const step = rate * dt;
    if (this.progress < target) this.progress = Math.min(target, this.progress + step);
    else if (this.progress > target) this.progress = Math.max(target, this.progress - step);

    // --- scope engagement -------------------------------------------------
    const scoped = this.isScopedWeapon(weapon);
    const rawScope = scoped ? clamp((this.progress - SCOPE_ENGAGE) / (1 - SCOPE_ENGAGE), 0, 1) : 0;
    // Fade the glass a touch more smoothly than the raw threshold.
    this.scopeProgress = damp(this.scopeProgress, rawScope, 26, dt);
    if (this.scopeProgress < 0.002) this.scopeProgress = 0;

    if (scoped) {
      const nowScoped = this.scopeProgress > 0.5;
      if (nowScoped && !this._wasScoped) this.audio?.play('scopeIn');
      else if (!nowScoped && this._wasScoped) this.audio?.play('scopeOut');
      this._wasScoped = nowScoped;
    } else {
      this._wasScoped = false;
    }

    // --- entry / exit sound for regular optics ---------------------------
    if (intent !== this._lastAdsIntent) {
      if (!scoped) this.audio?.play('adsIn', { volume: intent ? 0.9 : 0.6 });
      this._lastAdsIntent = intent;
    }

    // Zoom index resets when the optic is fully lowered so you always come
    // back up at the magnification you last chose *while* scoped.
    if (this.progress === 0 && this.zoomIndex >= this.zoomSteps(weapon)) this.zoomIndex = 0;

    this._updateBreath(dt, weapon, ctx);
    this._updateSway(dt, weapon, ctx);
  }

  _updateBreath(dt, weapon, ctx) {
    const optic = weapon?.def?.optic;
    const canHold = !!optic?.breathHold && this.scopeProgress > 0.4;

    if (canHold && ctx.holdBreathPressed && this.breath > 0.02) {
      if (!this.holding) this.audio?.play('breathIn', { volume: 0.5 });
      this.holding = true;
      this.breath = Math.max(0, this.breath - dt / (optic.holdDuration ?? 3.5));
      if (this.breath <= 0.02) this.audio?.play('breathOut', { volume: 0.6 });
    } else {
      if (this.holding) this.audio?.play('breathOut', { volume: 0.45 });
      this.holding = false;
      const recovery = optic?.holdRecovery ?? 5;
      this.breath = Math.min(1, this.breath + dt / recovery);
    }
  }

  _updateSway(dt, weapon, ctx) {
    const optic = weapon?.def?.optic;
    const amp = optic?.swayAmplitude ?? 0;
    if (amp <= 0 || this.scopeProgress <= 0.001) {
      this.sway.set(0, 0);
      return;
    }

    this.swayPhase += dt;

    // Two out-of-phase sine pairs read as an unsteady hand rather than a
    // mechanical wobble. Holding your breath nearly stops it.
    const steady = this.holding && this.breath > 0.02 ? 0.06 : 1;
    const moveMul = 1 + clamp(ctx.moving ?? 0, 0, 1) * 2.2;
    const a = amp * this.scopeProgress * steady * moveMul;

    const t = this.swayPhase;
    this.sway.x = (Math.sin(t * 0.83) * 0.6 + Math.sin(t * 1.71 + 1.3) * 0.4) * a;
    this.sway.y = (Math.cos(t * 0.67) * 0.6 + Math.sin(t * 1.31 + 0.7) * 0.4) * a * 0.8;
  }

  // ------------------------------------------------------------------ query
  /** Target world FOV in degrees for the current aim state. */
  targetFov(weapon, baseFov) {
    if (!weapon || this.progress <= 0) return baseFov;
    const mag = this.magnification(weapon);
    const aimed = fovForMagnification(baseFov, mag);
    // Ease the FOV on the same smootherstep as the model movement so the
    // zoom and the gun arrive together.
    return lerp(baseFov, aimed, smootherStep(this.progress));
  }

  /** Spread multiplier contributed by aiming (1 = hip fire). */
  spreadMultiplier(weapon) {
    const m = weapon?.def?.adsSpreadMul ?? 0.15;
    return lerp(1, m, smootherStep(this.progress));
  }

  /** Movement speed multiplier while aiming. */
  moveSpeedMultiplier(weapon) {
    const m = weapon?.def?.adsMoveSpeedMul ?? 0.75;
    return lerp(1, m, this.progress);
  }

  /** Per-weapon sensitivity multiplier, blended in with the aim. */
  weaponSensitivityMultiplier(weapon) {
    const m = weapon?.def?.adsSensitivity ?? 0.8;
    return lerp(1, m, this.progress);
  }

  /** True once the sight picture is trustworthy enough to hide the crosshair. */
  get hidesCrosshair() {
    return this.progress > 0.55;
  }

  reset() {
    this.progress = 0;
    this.scopeProgress = 0;
    this.toggleState = false;
    this.zoomIndex = 0;
    this.holding = false;
    this.breath = 1;
    this.sway.set(0, 0);
    this._lastAdsIntent = false;
    this._wasScoped = false;
  }
}

/** 6t^5 - 15t^4 + 10t^3 — zero first *and* second derivative at both ends. */
export function smootherStep(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * RecoilSystem — camera kick and view-model kick, driven by learnable patterns.
 *
 * The model deliberately mirrors what competitive shooters do, because it is
 * the only model where "pull down to control the spray" actually works:
 *
 *   aimPitch(camera) = player.pitch + recoil.pitch
 *
 * Each shot pushes `targetPitch/targetYaw` by the next entry in the weapon's
 * pattern (plus a small jitter). `currentPitch/currentYaw` chase those targets
 * with a spring, so the kick is visible rather than instantaneous. After
 * `recoveryDelay` of not firing, the targets decay back to zero and the view
 * returns.
 *
 * Because recoil is *additive* to the player's own aim, a player who drags the
 * mouse down mid-spray permanently lowers `player.pitch`; when the recoil
 * recovers, the crosshair settles below where it started — exactly the
 * behaviour that makes patterns learnable.
 *
 * Situational multipliers stack: moving, crouching, airborne and aiming all
 * scale the per-shot magnitude.
 */

import { DEG2RAD, clamp, damp, randRange } from '../core/MathUtils.js';

export class RecoilSystem {
  /** @param {import('../core/Settings.js').Settings} [settings] */
  constructor(settings = null) {
    this.settings = settings;
    // --- camera recoil (radians) ---
    this.targetPitch = 0;
    this.targetYaw = 0;
    this.currentPitch = 0;
    this.currentYaw = 0;
    this.velPitch = 0;
    this.velYaw = 0;

    // --- view-model kick ---
    this.kickZ = 0;        // metres pushed back toward the camera
    this.kickZVel = 0;
    this.kickPitch = 0;    // radians the model rotates up
    this.kickPitchVel = 0;
    this.kickRoll = 0;
    this.kickRollVel = 0;

    // --- pattern state ---
    this.shotIndex = 0;
    this.timeSinceShot = 999;
    this.recoveryDelay = 0.1;
    this.recoveryRate = 8;
    this.patternResetTime = 0.42;

    /** Extra one-shot screen shake requested by the last shot. */
    this.pendingShake = 0;
  }

  /**
   * Register a shot.
   *
   * @param {object} def       weapon definition
   * @param {object} state
   * @param {number} state.adsProgress   0..1
   * @param {boolean} state.crouching
   * @param {boolean} state.airborne
   * @param {number} state.moveSpeed01   0..1 normalised horizontal speed
   * @returns {number} screen-shake trauma for this shot
   */
  fire(def, state) {
    const r = def.recoil;
    const pattern = r.pattern;

    // Long enough between shots and the pattern starts again from the top.
    if (this.timeSinceShot > this.patternResetTime) this.shotIndex = 0;

    const entry = pattern[Math.min(this.shotIndex, pattern.length - 1)];
    this.shotIndex++;
    this.timeSinceShot = 0;
    this.recoveryDelay = r.recoveryDelay;
    this.recoveryRate = r.recovery;

    // --- situational scaling -------------------------------------------
    let scale = this.settings ? clamp(this.settings.get('recoilScale'), 0, 2) : 1;
    if (state.adsProgress > 0) scale *= 1 + (r.adsMul - 1) * state.adsProgress;
    if (state.crouching) scale *= r.crouchMul;
    if (state.airborne) scale *= r.airMul;
    else if (state.moveSpeed01 > 0.05) scale *= 1 + (r.moveMul - 1) * state.moveSpeed01;

    // --- camera kick -----------------------------------------------------
    const pitch = (entry[0] + randRange(-r.randomPitch, r.randomPitch)) * scale;
    const yaw = (entry[1] + randRange(-r.randomYaw, r.randomYaw)) * scale;

    this.targetPitch += pitch * DEG2RAD;
    this.targetYaw += yaw * DEG2RAD;

    // --- view-model kick -------------------------------------------------
    this.kickZVel += r.kickback * 66 * scale;
    this.kickPitchVel += r.kickRot * DEG2RAD * 42 * scale;
    this.kickRollVel += randRange(-1, 1) * r.kickRot * DEG2RAD * 16 * scale;

    this.pendingShake = r.shake * scale * (1 - state.adsProgress * 0.35);
    return this.pendingShake;
  }

  /** Advance springs and recovery. Frame-rate independent. */
  update(dt) {
    this.timeSinceShot += dt;

    // --- recovery: decay the accumulated target back to centre ----------
    if (this.timeSinceShot > this.recoveryDelay) {
      const k = 1 - Math.exp(-this.recoveryRate * dt);
      this.targetPitch -= this.targetPitch * k;
      this.targetYaw -= this.targetYaw * k;
      if (Math.abs(this.targetPitch) < 1e-5) this.targetPitch = 0;
      if (Math.abs(this.targetYaw) < 1e-5) this.targetYaw = 0;
    }

    /*
     * The springs are SUB-STEPPED, and that is not a refinement — without it
     * they explode on a slow machine and the view spins.
     *
     * Explicit Euler on a spring is only stable while `damping * dt < 2`. Past
     * that the damping term overshoots zero and flips the velocity's sign with
     * a LARGER magnitude than it had, so every frame amplifies the last. With
     * damping 26 the limit is dt = 77 ms, about 13 fps, and the stiffness term
     * pulls the practical limit up to roughly 18 fps.
     *
     * Camera recoil is added directly to the player's aim, so a diverging
     * spring is a spinning screen. Measured firing a rifle: at 20 fps the peak
     * was 0.14 rad, at 15 fps it reached 3.2e7 rad — five million rotations.
     *
     * It showed up on shooting because that is when the springs are excited,
     * and it showed up on a weak laptop because that is where a frame takes
     * long enough — muzzle flash, particles and audio all landing at once.
     *
     * Chopping a long frame into steps of at most 1/120 s keeps the same
     * tuning and the same feel at every frame rate, and simply cannot diverge.
     */
    const MAX_STEP = 1 / 120;
    let remaining = Math.min(dt, 0.25);   // a tab-switch gap is not a frame
    while (remaining > 1e-6) {
      const h = remaining > MAX_STEP ? MAX_STEP : remaining;
      remaining -= h;

      // --- spring the visible recoil toward the target ------------------
      // Stiff enough to read as a snap, damped enough not to oscillate.
      const stiffness = 320;
      const damping = 26;
      this.velPitch += ((this.targetPitch - this.currentPitch) * stiffness - this.velPitch * damping) * h;
      this.velYaw += ((this.targetYaw - this.currentYaw) * stiffness - this.velYaw * damping) * h;
      this.currentPitch += this.velPitch * h;
      this.currentYaw += this.velYaw * h;

      // --- view-model kick springs --------------------------------------
      this.kickZVel += (-this.kickZ * 250 - this.kickZVel * 23) * h;
      this.kickZ += this.kickZVel * h;
      this.kickPitchVel += (-this.kickPitch * 230 - this.kickPitchVel * 22) * h;
      this.kickPitch += this.kickPitchVel * h;
      this.kickRollVel += (-this.kickRoll * 200 - this.kickRollVel * 20) * h;
      this.kickRoll += this.kickRollVel * h;
    }
  }

  /** How far into the current pattern we are, 0..1 (for the HUD). */
  patternProgress(def) {
    const n = def?.recoil?.pattern?.length ?? 1;
    return clamp(this.shotIndex / n, 0, 1);
  }

  /** Called when the weapon changes or the player stops firing entirely. */
  resetPattern() {
    this.shotIndex = 0;
  }

  /** Full reset — new life, weapon swap, restart. */
  reset() {
    this.targetPitch = this.targetYaw = 0;
    this.currentPitch = this.currentYaw = 0;
    this.velPitch = this.velYaw = 0;
    this.kickZ = this.kickZVel = 0;
    this.kickPitch = this.kickPitchVel = 0;
    this.kickRoll = this.kickRollVel = 0;
    this.shotIndex = 0;
    this.timeSinceShot = 999;
  }

  /** Smoothly drain recoil without a hard snap (used when swapping weapons). */
  softReset(dt) {
    this.targetPitch = damp(this.targetPitch, 0, 14, dt);
    this.targetYaw = damp(this.targetYaw, 0, 14, dt);
  }
}

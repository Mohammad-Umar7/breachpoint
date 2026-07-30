/**
 * LeanSystem — tactical left/right peeking on Q and E.
 *
 * The camera slides sideways and rolls slightly, letting you clear a corner
 * with only your head exposed. Because the camera itself moves, the bullet
 * origin and aim direction follow automatically — you really can shoot around
 * the corner you are peeking past.
 *
 * Wall safety: before the lean is applied, a ray is cast from the eye along
 * the lean direction. The permitted lean distance is clamped to whatever
 * clearance actually exists, so the camera can never end up inside geometry.
 * The clamp is smoothed, so sliding along a wall eases the lean in and out
 * rather than snapping it.
 */

import * as THREE from 'three';
import { clamp, damp, DEG2RAD } from '../core/MathUtils.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';

const MAX_OFFSET = 0.48;        // metres of lateral travel at full lean
const MAX_ROLL = 13 * DEG2RAD;  // camera roll at full lean
const MAX_PITCH_DIP = 0.6 * DEG2RAD;
const CLEARANCE = 0.28;         // keep the camera this far off the wall
const LEAN_RATE = 7.5;          // how quickly the lean blends

export class LeanSystem {
  /**
   * @param {import('../core/InputManager.js').InputManager} input
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(input, settings, physics) {
    this.input = input;
    this.settings = settings;
    this.physics = physics;

    /** -1 = fully left, +1 = fully right. */
    this.amount = 0;
    /** Raw intent before wall clamping. */
    this.intent = 0;
    /** Toggle state for each side when leanMode is 'toggle'. */
    this.toggleLeft = false;
    this.toggleRight = false;
    this.enabled = true;

    this.offset = 0;   // metres, signed
    this.roll = 0;     // radians, signed
    this.limitLeft = 1;
    this.limitRight = 1;

    this._right = new THREE.Vector3();
    this._origin = new THREE.Vector3();
  }

  /** Movement is slower while peeking — you are off-balance. */
  get speedMultiplier() {
    return 1 - Math.abs(this.amount) * 0.42;
  }

  get isLeaning() {
    return Math.abs(this.amount) > 0.02;
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {THREE.Vector3} ctx.eyePosition   current head position
   * @param {number} ctx.yaw
   * @param {any} ctx.excludeCollider         the player's own collider
   * @param {boolean} ctx.allowed             false while dead / in menus
   */
  update(dt, ctx) {
    // ---------------------------------------------------------- intent
    if (!ctx.allowed || !this.enabled) {
      this.intent = 0;
      this.toggleLeft = this.toggleRight = false;
    } else if (this.settings.get('leanMode') === 'toggle') {
      if (this.input.wasPressed('leanLeft')) {
        this.toggleLeft = !this.toggleLeft;
        if (this.toggleLeft) this.toggleRight = false;
      }
      if (this.input.wasPressed('leanRight')) {
        this.toggleRight = !this.toggleRight;
        if (this.toggleRight) this.toggleLeft = false;
      }
      this.intent = (this.toggleRight ? 1 : 0) - (this.toggleLeft ? 1 : 0);
    } else {
      this.toggleLeft = this.toggleRight = false;
      const l = this.input.isDown('leanLeft') ? 1 : 0;
      const r = this.input.isDown('leanRight') ? 1 : 0;
      this.intent = r - l;
    }

    // ------------------------------------------------- wall clearance
    // Cast both ways every frame so the limit is already correct the instant
    // the player starts to lean.
    this._right.set(Math.cos(ctx.yaw), 0, -Math.sin(ctx.yaw));
    this._origin.copy(ctx.eyePosition);

    this.limitRight = this._probe(this._right, ctx.excludeCollider);
    this._right.negate();
    this.limitLeft = this._probe(this._right, ctx.excludeCollider);

    const limit = this.intent > 0 ? this.limitRight : this.intent < 0 ? this.limitLeft : 1;
    const target = clamp(this.intent, -1, 1) * limit;

    // Ease out a little faster than in, so returning to cover feels prompt.
    const rate = Math.abs(target) < Math.abs(this.amount) ? LEAN_RATE * 1.35 : LEAN_RATE;
    this.amount = damp(this.amount, target, rate, dt);
    if (Math.abs(this.amount) < 0.001) this.amount = 0;

    this.offset = this.amount * MAX_OFFSET;
    this.roll = -this.amount * MAX_ROLL;
    this.pitchDip = -Math.abs(this.amount) * MAX_PITCH_DIP;
  }

  /**
   * @returns {number} 0..1 fraction of MAX_OFFSET that fits in this direction
   */
  _probe(direction, excludeCollider) {
    const probe = MAX_OFFSET + CLEARANCE;
    const hit = this.physics.raycast(this._origin, direction, probe, {
      excludeCollider,
      filter: (tag) =>
        !!tag &&
        (tag.kind === TAG_KIND.WORLD || tag.kind === TAG_KIND.PROP || tag.kind === TAG_KIND.EXPLOSIVE),
    });
    if (!hit) return 1;
    return clamp((hit.distance - CLEARANCE) / MAX_OFFSET, 0, 1);
  }

  /** Apply the lean to a camera position (world space). */
  applyToPosition(position, yaw) {
    if (this.offset === 0) return position;
    position.x += Math.cos(yaw) * this.offset;
    position.z += -Math.sin(yaw) * this.offset;
    return position;
  }

  reset() {
    this.amount = 0;
    this.intent = 0;
    this.offset = 0;
    this.roll = 0;
    this.pitchDip = 0;
    this.toggleLeft = false;
    this.toggleRight = false;
  }
}

export { MAX_OFFSET as LEAN_MAX_OFFSET };

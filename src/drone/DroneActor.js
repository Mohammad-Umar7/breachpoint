/**
 * DroneActor — the pilot's own drone: one collider, one camera, no mesh.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * IT DOES NOT DRAW ANYTHING. Every chassis in the world, INCLUDING this one,
 * is drawn by `DroneObjects` from the interpolated snapshot sample, and hit
 * tested there too. That split is the whole reason there is exactly one
 * creation rule, one interpolation rule and one raycast for drones: a locally
 * drawn chassis would be a second one, and the two would disagree the instant
 * the server refused a drive report — the pilot would watch their own robot
 * sitting in a doorway while everybody else shot at it a metre away.
 *
 * IT DOES NOT DECIDE THAT IT EXISTS. Creation and destruction are server
 * events. This class is spawned when `MSG.DRONESTATE ev:DEPLOYED` arrives and
 * destroyed when the server says so, which is what makes two players
 * disagreeing about whether a drone is there impossible.
 *
 * WHY THE COLLIDER IS TAGGED AS A PLAYER
 * --------------------------------------
 * It is a robot, and the obvious thing would be a fifth `TAG_KIND`. Tagging it
 * `PLAYER` is strictly better, because of what every existing filter already
 * says:
 *
 *   - every bullet raycast filters `tag.kind !== TAG_KIND.PLAYER`, so the
 *     pilot's own rounds pass through their own drone in physics exactly as
 *     everyone else's do, and ALL drone hits on ALL clients resolve through the
 *     single analytic hit test. A new kind would have made the pilot the only
 *     person in the match whose bullets stopped on it — a divergence that
 *     surfaces months later as an unreproducible bug report.
 *   - `hasLineOfSight`, `LeanSystem._probe` and the wall-proximity probe are
 *     allowlists of WORLD/PROP/EXPLOSIVE, so a drone correctly does not block a
 *     grenade's blast or stop somebody leaning round a corner.
 *   - the player's footstep-surface probe and headroom check both filter PLAYER
 *     out, so standing over a drone reports the floor beneath it rather than
 *     metal, and does not stop you standing up.
 *
 * That is the right behaviour in all five places for zero edits outside this
 * file, and no risk of the new kind being silently absent from a filter nobody
 * remembered. The collider still collides with walls, furniture and stairs,
 * because `computeColliderMovement` filters only sensors and never reads tags.
 */

import * as THREE from 'three';
import { DRONE } from '../net/protocol.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { SURFACE } from '../core/AssetManager.js';
import { LAYER_WORLD } from '../fx/ScopeRenderer.js';
import { clamp, angleDelta, DEG2RAD } from '../core/MathUtils.js';
import { stepDroneMotion } from './droneMotion.js';

/** Capsule: 0.39 m long overall, 0.28 m tall. A footstool with tracks. */
const HALF_HEIGHT = 0.055;
const RADIUS = 0.14;

/** The world's own gravity, so a drone shoved off a table falls like one. */
const GRAVITY = -24;
const MAX_FALL = -30;

/**
 * How hard the camera's yaw chases the chassis' yaw. ~90 ms of lag.
 *
 * A lens bolted rigidly to something turning at `DRONE.turnRate` is unwatchable
 * on a small low-refresh panel: every steering tap snaps the picture and the
 * feed reads as a strobe rather than as a view of a room. Only the yaw is
 * damped, so the horizon stays put.
 */
const CAM_YAW_LAMBDA = 11;

/** Below this, the drone has left the level and is not coming back. */
const VOID_Y = -12;

export class DroneActor {
  /**
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(physics) {
    this.physics = physics;
    this.controller = physics.droneController;
    this.body = null;
    this.collider = null;

    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.renderPosition = new THREE.Vector3();
    this.yaw = 0;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.grounded = false;

    /** True between `spawn()` and `destroy()`; nothing steps while false. */
    this.active = false;

    /**
     * Latched when a step could not be trusted, and read by DroneSystem, which
     * recalls the drone.
     *
     * A latch rather than a callback on purpose. A `this.onFault = null` hook
     * fired from inside this file with nothing assigning it is precisely the
     * dangling wiring `test/contracts.mjs` exists to catch, and the owner that
     * would assign it (DroneSystem) does not exist yet.
     */
    this.faulted = false;

    /** Written every frame by DroneSystem; read by the fixed step. */
    this.input = { throttle: 0, steer: 0 };

    /*
     * The POV camera.
     *
     * `LAYER_WORLD` only, and the screen quad that displays this feed lives on
     * `LAYER_VIEWMODEL`, so the camera structurally cannot see the panel it is
     * being drawn onto. No read-write feedback loop is possible and no
     * hide-the-mesh dance is ever needed.
     *
     * The aspect is a FIXED 4:3, matching the render target, which is why this
     * camera never touches the window resize path and cannot inherit the
     * device-pixel-ratio bug that has bitten the scope.
     */
    this.camera = new THREE.PerspectiveCamera(DRONE.camFov, 4 / 3, 0.03, 300);
    this.camera.layers.set(LAYER_WORLD);
    this.camYaw = 0;

    // Scratch — reused so a piloting frame allocates nothing.
    this._state = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
    this._desired = { x: 0, y: 0, z: 0 };
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  // ------------------------------------------------------------------ setup
  /**
   * Put a drone on the floor at the point the SERVER chose.
   *
   * @param {THREE.Vector3|{x,y,z}} position
   * @param {number} yaw
   */
  spawn(position, yaw = 0) {
    this.position.set(position.x, position.y, position.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.yaw = yaw;
    this.camYaw = yaw;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.grounded = false;
    this.faulted = false;
    this.input.throttle = 0;
    this.input.steer = 0;

    if (!this.body) {
      // `createCharacterBody` asserts its arguments are finite, which matters
      // here more than anywhere else in the game: this position came off a
      // socket rather than out of a level file.
      const { body, collider } = this.physics.createCharacterBody(
        this.position, HALF_HEIGHT, RADIUS,
        { kind: TAG_KIND.PLAYER, surface: SURFACE.METAL, drone: true },
      );
      this.body = body;
      this.collider = collider;
    } else {
      this.body.setTranslation(this.position, true);
      this.body.setNextKinematicTranslation(this.position);
    }
    this.active = true;
  }

  // ============================================================ fixed update
  /**
   * Runs inside the fixed physics step, immediately before `world.step()` —
   * the same band `Player.fixedUpdate` runs in, and for the same reason.
   *
   * @param {number} dt fixed timestep (1/60)
   */
  fixedUpdate(dt) {
    if (!this.active || !this.body || this.faulted) return;

    this.prevPosition.copy(this.position);

    this._state.x = this.position.x;
    this._state.z = this.position.z;
    this._state.yaw = this.yaw;
    this._state.vx = this.vx;
    this._state.vz = this.vz;

    const next = stepDroneMotion(this._state, this.input, dt);
    if (!next.ok) {
      this._fault('the motion integrator refused the step');
      return;
    }
    this.yaw = next.yaw;
    this.vx = next.vx;
    this.vz = next.vz;

    // Gravity, which the integrator deliberately knows nothing about — it is
    // pure arithmetic on a plane, and everything vertical is the character
    // controller's business: stairs, kerbs, and driving off the edge of a
    // landing.
    this.vy = this.grounded && this.vy <= 0
      ? -2 // stick to slopes, exactly as the player does
      : Math.max(MAX_FALL, this.vy + GRAVITY * dt);

    this._desired.x = next.x - this.position.x;
    this._desired.y = this.vy * dt;
    this._desired.z = next.z - this.position.z;

    this.controller.computeColliderMovement(
      this.collider,
      this._desired,
      this.physics.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const moved = this.controller.computedMovement();

    const nx = this.position.x + moved.x;
    const ny = this.position.y + moved.y;
    const nz = this.position.z + moved.z;

    /*
     * Check the controller's answer BEFORE writing it, because nothing after
     * this line will.
     *
     * `setNextKinematicTranslation` takes a NaN without complaint; the void net
     * below is `ny < VOID_Y`, and `NaN < -12` is false, so it does not fire;
     * and what the value reaches is the broad phase, where it silently disables
     * every raycast on the map. Refusing to write and recalling the drone costs
     * one player one gadget. Writing it costs everybody in the room the floor.
     */
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
      this._fault('the character controller returned a non-finite movement');
      return;
    }

    this.position.set(nx, ny, nz);
    this.body.setNextKinematicTranslation(this.position);

    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;

    // Ordered AFTER the finite check on purpose — see above.
    if (this.position.y < VOID_Y) this._fault('the drone fell out of the level');
  }

  /**
   * Stop, latch, and say so once.
   *
   * Loudly and exactly once, in the spirit of `applyExplosion`'s refusal: a
   * drone that has stopped moving for no visible reason is a bug report, and
   * the console line is the only thing that turns it into a fixable one.
   */
  _fault(why) {
    if (this.faulted) return;
    this.faulted = true;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    console.error('[Drone] %s — the drone is halted and will be recalled.', why);
  }

  // ========================================================== render update
  /**
   * @param {number} dt    frame delta
   * @param {number} alpha physics interpolation factor 0..1
   */
  update(dt, alpha) {
    if (!this.active) return;

    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);

    // A frame delta that is not a number would put a NaN into the camera
    // quaternion and the feed would render nothing at all, with no error —
    // cheaper to refuse the smoothing for one frame.
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this.camYaw += angleDelta(this.camYaw, this.yaw) * (1 - Math.exp(-CAM_YAW_LAMBDA * step));

    this.camera.position.set(
      this.renderPosition.x,
      this.renderPosition.y + DRONE.camHeight,
      this.renderPosition.z,
    );
    // Tilted UP: from 0.19 m off the floor, everything worth looking at is
    // above the lens, and a level camera spends most of its pixels on carpet.
    this._euler.set(DRONE.camPitch * DEG2RAD, this.camYaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
  }

  // --------------------------------------------------------------- server
  /**
   * Take the server's word for where the drone actually is.
   *
   * A refused drive report comes back with the authoritative pose, and moving
   * to it is the only correct response. Dropping the correction is how two
   * machines diverge without limit — the same reasoning the player's own
   * snap-back records, and the reason the server answers a rejection at all
   * instead of silently discarding it.
   */
  snapTo(x, y, z, yaw) {
    if (!this.body) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    if (Number.isFinite(yaw)) {
      this.yaw = yaw;
      this.camYaw = yaw;
    }
    this.body.setTranslation(this.position, true);
    this.body.setNextKinematicTranslation(this.position);
  }

  // -------------------------------------------------------------- teardown
  destroy() {
    this.active = false;
    this.input.throttle = 0;
    this.input.steer = 0;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    if (!this.body) return;
    /*
     * `removeBody`, never `setBodyEnabled(false)`.
     *
     * A disabled body's collider is still in the broad phase and still answers
     * ray queries, so a drone that had been "hidden" would go on stopping
     * bullets in mid-air over an empty patch of floor. That is what the
     * exploding barrels taught, and it is worse here, because a recalled drone
     * leaves nothing visible to blame.
     */
    this.physics.removeBody(this.body);
    this.body = null;
    this.collider = null;
  }
}

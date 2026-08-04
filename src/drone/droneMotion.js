/**
 * droneMotion — how the scout drone steers, as arithmetic and nothing else.
 *
 * WHY THIS IS A SEPARATE, PURE FILE
 * ---------------------------------
 * Everything downstream of this arithmetic is unguarded, and fails silently.
 * `setNextKinematicTranslation` accepts a NaN without complaint. The void net
 * that would otherwise be the last line of defence is written `y < -12`, and
 * `NaN < -12` is FALSE, so a poisoned position sails straight through it. What
 * it reaches is Rapier's broad phase, where one non-finite number disables
 * EVERY raycast on the map: no ground under anyone's feet, no walls, no hit
 * registration — nothing thrown, nothing logged, and the level still rendering
 * perfectly. That is the bug `assertFinite` in PhysicsWorld.js was written for,
 * and this is the one code path that can produce it from numbers that arrived
 * over a socket rather than from a level file.
 *
 * So the arithmetic that could produce such a number lives here, with no THREE,
 * no Rapier and no DOM, where `test/drone-motion.mjs` can hammer it with every
 * degenerate input in plain Node in a few milliseconds. The moment this file
 * needs a Vector3 it stops being testable and the guard stops being proven.
 *
 * THE CONTRACT
 * ------------
 *   - `ok: false` means "this is not a pose; do not write it anywhere". The
 *     caller must refuse the step and recall the drone.
 *   - The returned numbers are ALWAYS finite, including when `ok` is false, so
 *     a caller that forgets to check gets a stationary drone rather than a map
 *     whose raycasts have all stopped answering. Never a mix of the two.
 *   - Horizontal speed never exceeds `DRONE.speed`, which is the rate the
 *     server refills its drive budget at. A client that could outrun that would
 *     be corrected every few reports, and a correction looks exactly like lag.
 */

import { DRONE } from '../net/protocol.js';

/**
 * Metres per second squared, up to speed and back to a stop.
 *
 * A tracked robot is not a car: it is at full speed in about a fifth of a
 * second. Faster than this and the chassis reads as weightless; slower and the
 * feed's ~110 ms of interpolation delay makes it feel like driving through
 * treacle, because the picture is always behind the stick.
 */
const ACCEL = 14;
const DECEL = 20;

/**
 * Reverse is slower than forward, exactly as the player's backpedal is.
 *
 * Without it, backing out of a room you have just been spotted in is strictly
 * better than turning round, and every pilot drives backwards.
 */
const REVERSE_SCALE = 0.55;

/**
 * The largest step this will integrate.
 *
 * It is called from the fixed 60 Hz step, so in honest use `dt` is always
 * 1/60. Anything near this ceiling means the tab was asleep, and integrating it
 * would produce one displacement the server refuses as a teleport anyway — so
 * refusing here is both safer and closer to what the server will do with it.
 */
const MAX_DT = 0.1;

const TWO_PI = Math.PI * 2;

/**
 * Advance the chassis by one step.
 *
 * Tank drive: throttle along the chassis' own forward axis, steering as a yaw
 * rate. There is deliberately no strafe — it is a tracked robot, and the
 * absence of one is also what guarantees the target velocity is never larger
 * than `DRONE.speed` by construction rather than by a clamp somebody has to
 * remember.
 *
 * @param {{x:number, z:number, yaw:number, vx:number, vz:number}} state
 * @param {{throttle:number, steer:number}} input  each -1..1; anything outside
 *   is clamped rather than refused, because a stuck key and a hostile client
 *   look identical from here and neither should be able to move the drone
 *   further than a legitimate one.
 * @param {number} dt seconds
 * @returns {{x:number, z:number, yaw:number, vx:number, vz:number, ok:boolean}}
 */
export function stepDroneMotion(state, input, dt) {
  // Sanitise the incoming pose FIRST, so that every return path below — the
  // refusals included — has finite numbers to hand back.
  const x0 = finiteOr(state?.x);
  const z0 = finiteOr(state?.z);
  const yaw0 = finiteOr(state?.yaw);

  const usable =
    Number.isFinite(state?.x) && Number.isFinite(state?.z) && Number.isFinite(state?.yaw)
    && Number.isFinite(state?.vx) && Number.isFinite(state?.vz)
    && Number.isFinite(input?.throttle) && Number.isFinite(input?.steer)
    && Number.isFinite(dt) && dt > 0 && dt <= MAX_DT;
  if (!usable) return halt(x0, z0, yaw0);

  const throttle = clampUnit(input.throttle);
  const steer = clampUnit(input.steer);

  // ---- steering -------------------------------------------------------
  // Yaw integrates first, so the throttle pushes where the chassis points at
  // the END of the step. The other order makes a turning drone crab outwards,
  // which on a 0.19 m camera reads as the whole room sliding sideways.
  const yaw = wrapAngle(yaw0 + steer * DRONE.turnRate * dt);

  // ---- throttle -------------------------------------------------------
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const targetSpeed = DRONE.speed * throttle * (throttle < 0 ? REVERSE_SCALE : 1);
  const targetX = forwardX * targetSpeed;
  const targetZ = forwardZ * targetSpeed;

  const rate = (throttle === 0 ? DECEL : ACCEL) * dt;
  let vx = approach(state.vx, targetX, rate);
  let vz = approach(state.vz, targetZ, rate);

  /*
   * And a ceiling on the result.
   *
   * `approach` never overshoots, so honest driving is already inside the disc;
   * this catches a velocity that arrived absurd — a corrupted state object, or
   * a future caller folding explosion knockback into it — before it becomes a
   * displacement the server refuses.
   *
   * `Math.hypot`, NOT `Math.sqrt(vx * vx + vz * vz)`. The squares of two large
   * but perfectly finite components overflow to Infinity, so the scale becomes
   * `speed / Infinity` = 0 and the drone is silently teleported to a dead stop
   * instead of being clamped to top speed — a stationary robot with no error
   * anywhere, which reads as a lost link. `Math.hypot` is specified to survive
   * intermediate overflow; the obvious spelling is not.
   */
  const speed = Math.hypot(vx, vz);
  if (speed > DRONE.speed && speed > 1e-9) {
    const k = DRONE.speed / speed;
    vx *= k;
    vz *= k;
  }

  const x = x0 + vx * dt;
  const z = z0 + vz * dt;

  /*
   * The backstop.
   *
   * Nothing above can reach it with finite inputs today, and that is the point.
   * It is here so that a later edit which CAN — a new term, a different clamp,
   * the hypot above quietly rewritten as a sqrt — fails as one refused step
   * that recalls one drone, rather than as a map on which nobody can be shot.
   */
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)
    || !Number.isFinite(vx) || !Number.isFinite(vz)) {
    return halt(x0, z0, yaw0);
  }

  return { x, z, yaw, vx, vz, ok: true };
}

/* ------------------------------------------------------------------ helpers */

/**
 * The refusal: stay exactly where you were, with no velocity.
 *
 * Standing still is the only safe answer. Returning zeros would teleport a
 * drone that had been driving happily to the world origin the first time a
 * single frame arrived with a bad `dt`.
 */
function halt(x, z, yaw) {
  return { x, z, yaw, vx: 0, vz: 0, ok: false };
}

function finiteOr(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/**
 * Fold an angle into [-PI, PI].
 *
 * A modulo, not the `while (a > PI) a -= TWO_PI` loop the same job is usually
 * written as. That loop is fine for an angle that drifted by a few turns and is
 * an infinite loop for one that arrived at 1e300 — finite, so no guard above
 * catches it, and the process never returns from this function. Long sessions
 * are exactly where large angles come from.
 */
function wrapAngle(a) {
  const w = a % TWO_PI;
  return w > Math.PI ? w - TWO_PI : w < -Math.PI ? w + TWO_PI : w;
}

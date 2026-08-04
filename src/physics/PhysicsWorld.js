/**
 * PhysicsWorld — thin, game-oriented wrapper around Rapier 3D.
 *
 * Responsibilities:
 *  - Own the Rapier `World` and run it on a **fixed 60 Hz timestep** with an
 *    accumulator, so simulation is identical regardless of display refresh.
 *  - Keep a `colliderHandle -> tag` map. Rapier colliders can't carry JS
 *    references, so this is how a raycast hit becomes "that barrel".
 *  - Track every dynamic body paired with a Three.js mesh and interpolate
 *    their transforms for rendering (removes jitter on 144 Hz displays).
 *  - Provide the raycast / explosion helpers the rest of the game needs.
 *
 * Rapier's compat build inlines its WASM as base64, so `init()` needs no
 * network request and cannot 404.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { SURFACE } from '../core/AssetManager.js';

/** Categories used by raycast filters and impact effects. */
export const TAG_KIND = Object.freeze({
  WORLD: 'world',
  PROP: 'prop',
  EXPLOSIVE: 'explosive',
  PLAYER: 'player',
});

const ZERO_VEC = { x: 0, y: 0, z: 0 };

let rapierReady = null;

/** Idempotently initialise the Rapier WASM module. */
export function initRapier() {
  if (!rapierReady) {
    rapierReady = RAPIER.init().then(() => RAPIER);
  }
  return rapierReady;
}

/**
 * Refuse to build a collider out of numbers that are not numbers.
 *
 * ONE non-finite value is enough to take the whole map down with it. Rapier
 * puts every collider's AABB into a shared broad-phase, a NaN bound poisons
 * the structure, and from then on EVERY raycast on that map returns nothing —
 * no ground under the player, no walls, no hit registration. Nothing throws
 * and nothing is logged; the map simply stops existing to queries while
 * continuing to render perfectly.
 *
 * That cost an afternoon. Six barrels were built with `{x, y, z}` half-extents
 * where a cylinder wanted `{y, r}`, so the radius was `undefined`, and the
 * symptom was a player falling through a floor that was visibly there.
 *
 * Loud and immediate, because a collider that cannot be built correctly must
 * never reach the broad phase.
 */
function assertFinite(where, values) {
  for (const [key, v] of Object.entries(values)) {
    if (!Number.isFinite(v)) {
      throw new Error(
        `[Physics] ${where}: "${key}" is ${v}. A non-finite collider dimension `
        + 'poisons the broad phase and silently disables every raycast on the map.');
    }
  }
}

/**
 * And refuse a rotation that is not a rotation.
 *
 * Separate only because a quaternion is optional at both call sites that take
 * one. The specific failure it catches is a missing `w`: a caller assembling
 * `{x, y, z}` by hand — which is what every other argument in this file looks
 * like — hands Rapier a quaternion it normalises to something arbitrary, and
 * the collider ends up rotated away from the mesh it belongs to. That is a wall
 * you can walk through while looking straight at it, with nothing thrown.
 */
function assertRotation(where, quat) {
  if (!quat) return;
  assertFinite(`${where} rotation`, {
    qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w,
  });
}

export class PhysicsWorld {
  constructor() {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -24.0, z: 0 });

    // 60 Hz fixed step. Gravity is deliberately stronger than real life —
    // it makes jumps feel snappy, which is standard for shooters.
    this.fixedDt = 1 / 60;
    this.world.timestep = this.fixedDt;
    this.maxSubSteps = 5;
    this.accumulator = 0;
    this.alpha = 0;

    /** @type {Map<number, object>} collider handle → tag */
    this.tags = new Map();
    /** @type {Array} dynamic bodies paired with meshes for render sync */
    this.syncBodies = [];
    /** @type {Set<any>} all dynamic bodies (used by explosion queries) */
    this.dynamicBodies = new Set();

    // One controller per kind of character, so their tuning can differ. They
    // hold no state between calls, so a single controller per kind is enough
    // however many bodies use it.
    this.playerController = this._makeController(0.02, {
      autostepHeight: 0.45,
      // Must not exceed the depth of a single stair tread, or the controller
      // refuses to step up at all and the player grinds to a halt against the
      // flight. The mezzanine stairs use a 0.18 m run, so this has to sit
      // comfortably below that.
      autostepMinWidth: 0.12,
      snapToGround: 0.35,
      maxSlope: 52,
      minSlideSlope: 44,
      characterMass: 82,
    });
    /*
     * The scout drone: 0.39 m long, 0.28 m tall, and nothing like a person.
     *
     * It gets its own controller rather than borrowing the player's because
     * every number here is a fraction of the player's, and a robot given a
     * 0.45 m autostep climbs a kitchen counter.
     */
    this.droneController = this._makeController(0.02, {
      // A kerb, a floor lip, a stair tread. Above the treads it has to climb
      // and below the furniture it must not.
      autostepHeight: 0.14,
      // Must not exceed the depth of a single stair tread, exactly as the
      // player's must not — the house authors its interior flights with a
      // 0.24 m run specifically so a robot this size can climb them, so this
      // has to sit comfortably below that or the drone grinds to a halt
      // against the bottom step and the upper floors are unreachable.
      autostepMinWidth: 0.08,
      // Shorter than the player's, because a chassis 0.11 m off the ground
      // that snapped down 0.35 m would be pulled through a stair nosing.
      snapToGround: 0.12,
      maxSlope: 38,
      minSlideSlope: 34,
      // Light enough that shoving a crate with it looks like a toy pushing
      // furniture, which is what it is.
      characterMass: 6,
    });

    // Scratch objects — reused to keep the frame allocation-free.
    this._v = { x: 0, y: 0, z: 0 };
    this._v2 = { x: 0, y: 0, z: 0 };
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._tmpVec = new THREE.Vector3();
    this._tmpStart = new THREE.Vector3();
  }

  _makeController(offset, cfg) {
    const c = this.world.createCharacterController(offset);
    c.enableAutostep(cfg.autostepHeight, cfg.autostepMinWidth, true);
    c.enableSnapToGround(cfg.snapToGround);
    c.setMaxSlopeClimbAngle((cfg.maxSlope * Math.PI) / 180);
    c.setMinSlopeSlideAngle((cfg.minSlideSlope * Math.PI) / 180);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setCharacterMass(cfg.characterMass);
    c.setSlideEnabled(true);
    return c;
  }

  // ------------------------------------------------------------------ tags
  tag(collider, tagObject) {
    this.tags.set(collider.handle, tagObject);
    return collider;
  }

  getTag(collider) {
    return collider ? this.tags.get(collider.handle) ?? null : null;
  }

  untag(collider) {
    this.tags.delete(collider.handle);
  }

  // ------------------------------------------------------------- factories
  /**
   * Static level geometry.
   * @param {THREE.Vector3|{x,y,z}} pos  centre
   * @param {{x,y,z}} half               half extents
   * @param {THREE.Quaternion} [quat]
   */
  createStaticBox(pos, half, quat = null, tag = null, friction = 0.9) {
    assertFinite('createStaticBox', {
      x: pos.x, y: pos.y, z: pos.z, hx: half.x, hy: half.y, hz: half.z,
    });
    assertRotation('createStaticBox', quat);
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
    if (quat) bodyDesc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setFriction(friction)
      .setRestitution(0.02);
    const collider = this.world.createCollider(colDesc, body);
    this.tag(collider, tag ?? { kind: TAG_KIND.WORLD, surface: SURFACE.CONCRETE });
    return { body, collider };
  }

  /** Pushable crate / debris. */
  createDynamicBox(pos, half, opts = {}) {
    // Destructured BEFORE the guard, so the guard can see the rotation too.
    // Reading fields off `opts` one at a time later is how a field ends up
    // undefined without anyone noticing — `x > undefined` is false, so the
    // check that should have caught it passes.
    const {
      mass = 24,
      friction = 0.7,
      restitution = 0.05,
      linearDamping = 0.25,
      angularDamping = 0.45,
      quat = null,
      tag = null,
      mesh = null,
    } = opts;
    assertFinite('createDynamicBox', {
      x: pos.x, y: pos.y, z: pos.z, hx: half.x, hy: half.y, hz: half.z,
    });
    assertRotation('createDynamicBox', quat);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setCcdEnabled(false);
    if (quat) bodyDesc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });

    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setFriction(friction)
      .setRestitution(restitution)
      .setMass(mass);
    const collider = this.world.createCollider(colDesc, body);
    this.tag(collider, tag ?? { kind: TAG_KIND.PROP, surface: SURFACE.WOOD });

    this.dynamicBodies.add(body);
    if (mesh) this.linkMesh(body, mesh);
    return { body, collider };
  }

  /** Barrel-shaped dynamic body. */
  createDynamicCylinder(pos, halfHeight, radius, opts = {}) {
    // `radius` is the one that has actually been undefined in practice: a
    // cylinder takes {y, r}, and a caller copying the box call passes {x,y,z}.
    assertFinite('createDynamicCylinder', {
      x: pos.x, y: pos.y, z: pos.z, halfHeight, radius,
    });
    const {
      mass = 30,
      friction = 0.6,
      restitution = 0.08,
      linearDamping = 0.2,
      angularDamping = 0.5,
      tag = null,
      mesh = null,
    } = opts;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinearDamping(linearDamping)
        .setAngularDamping(angularDamping)
    );
    const colDesc = RAPIER.ColliderDesc.cylinder(halfHeight, radius)
      .setFriction(friction)
      .setRestitution(restitution)
      .setMass(mass);
    const collider = this.world.createCollider(colDesc, body);
    this.tag(collider, tag ?? { kind: TAG_KIND.PROP, surface: SURFACE.METAL });

    this.dynamicBodies.add(body);
    if (mesh) this.linkMesh(body, mesh);
    return { body, collider };
  }

  /** Kinematic capsule used by the player and by the scout drone. */
  createCharacterBody(pos, halfHeight, radius, tag) {
    /*
     * This was the last collider factory with no guard on it, and the only one
     * whose caller is not level-building code that runs once at load.
     *
     * A character capsule is built from a LIVE position — a spawn point, or in
     * the drone's case wherever the server says its owner was standing — so
     * unlike a wall it can be built from a number that arrived over a socket.
     * A single non-finite value here does not misplace one capsule; it poisons
     * the broad phase and every raycast on the map stops answering, so the
     * floor, the walls and hit registration all quietly cease to exist while
     * the level goes on rendering perfectly.
     */
    assertFinite('createCharacterBody', {
      x: pos.x, y: pos.y, z: pos.z, halfHeight, radius,
    });
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z)
    );
    const colDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setFriction(0.0);
    const collider = this.world.createCollider(colDesc, body);
    this.tag(collider, tag);
    return { body, collider };
  }

  /** Extra collider attached to an existing body. */
  addSphereCollider(body, offsetY, radius, tag) {
    // Same broad phase, same consequence. A head sphere offset by a NaN takes
    // the whole map's raycasts down with it, and the body it hangs off is
    // perfectly fine, which is what makes it hard to find afterwards.
    assertFinite('addSphereCollider', { offsetY, radius });
    const colDesc = RAPIER.ColliderDesc.ball(radius).setTranslation(0, offsetY, 0);
    const collider = this.world.createCollider(colDesc, body);
    this.tag(collider, tag);
    return collider;
  }

  /**
   * Take a body out of (or back into) the simulation.
   *
   * `RigidBody.setEnabled` exists from Rapier 0.12 onward; older builds fall
   * back to parking the body far below the arena with gravity switched off,
   * which is functionally equivalent for our purposes.
   */
  setBodyEnabled(body, enabled, restorePosition = null) {
    if (!body) return;
    if (typeof body.setEnabled === 'function') {
      body.setEnabled(enabled);
      if (enabled && restorePosition) body.setTranslation(restorePosition, true);
      return;
    }
    if (enabled) {
      body.setGravityScale(1, true);
      if (restorePosition) body.setTranslation(restorePosition, true);
    } else {
      body.setLinvel(ZERO_VEC, true);
      body.setAngvel(ZERO_VEC, true);
      body.setGravityScale(0, true);
      body.setTranslation({ x: 0, y: -500, z: 0 }, true);
    }
  }

  removeBody(body) {
    if (!body) return;
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.untag(body.collider(i));
    this.unlinkMesh(body);
    this.dynamicBodies.delete(body);
    this.world.removeRigidBody(body);
  }

  // ------------------------------------------------------- mesh <-> physics
  /** Pair a dynamic body with a mesh; transforms are interpolated on render. */
  linkMesh(body, mesh) {
    const t = body.translation();
    const r = body.rotation();
    this.syncBodies.push({
      body,
      mesh,
      prevPos: new THREE.Vector3(t.x, t.y, t.z),
      currPos: new THREE.Vector3(t.x, t.y, t.z),
      prevQuat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      currQuat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    });
  }

  unlinkMesh(body) {
    const i = this.syncBodies.findIndex((e) => e.body === body);
    if (i !== -1) this.syncBodies.splice(i, 1);
  }

  /** Capture post-step transforms so render can interpolate between them. */
  _captureTransforms() {
    for (let i = 0; i < this.syncBodies.length; i++) {
      const e = this.syncBodies[i];
      e.prevPos.copy(e.currPos);
      e.prevQuat.copy(e.currQuat);
      const t = e.body.translation();
      const r = e.body.rotation();
      e.currPos.set(t.x, t.y, t.z);
      e.currQuat.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Write interpolated transforms into the Three.js meshes. */
  syncMeshes() {
    const a = this.alpha;
    for (let i = 0; i < this.syncBodies.length; i++) {
      const e = this.syncBodies[i];
      e.mesh.position.lerpVectors(e.prevPos, e.currPos, a);
      e.mesh.quaternion.copy(e.prevQuat).slerp(e.currQuat, a);
    }
  }

  // ------------------------------------------------------------------ step
  /**
   * Advance the simulation. `onFixedStep(dt)` runs immediately *before* each
   * `world.step()` and is where kinematic characters set their next position.
   */
  step(dt, onFixedStep) {
    // Clamp huge frames (tab switch, breakpoint) so we never death-spiral.
    this.accumulator += Math.min(dt, 0.25);

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      onFixedStep?.(this.fixedDt);
      this.world.step();
      this._captureTransforms();
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;
    this.alpha = this.accumulator / this.fixedDt;
    return steps;
  }

  // -------------------------------------------------------------- queries
  /**
   * Cast a ray and return the first hit as a plain object, or null.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir       must be normalised
   * @param {number} maxDist
   * @param {object} [opts]
   * @param {any} [opts.excludeCollider]
   * @param {any} [opts.excludeBody]
   * @param {(tag:object, collider:any) => boolean} [opts.filter]
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number,
   *            collider:any, body:any, tag:object|null}|null}
   */
  raycast(origin, dir, maxDist, opts = {}) {
    this._ray.origin.x = origin.x;
    this._ray.origin.y = origin.y;
    this._ray.origin.z = origin.z;
    this._ray.dir.x = dir.x;
    this._ray.dir.y = dir.y;
    this._ray.dir.z = dir.z;

    let predicate;
    if (opts.filter) {
      predicate = (collider) => {
        const tag = this.tags.get(collider.handle) ?? null;
        return opts.filter(tag, collider);
      };
    }

    const hit = this.world.castRayAndGetNormal(
      this._ray,
      maxDist,
      true, // treat the interior of shapes as solid
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      opts.excludeCollider ?? undefined,
      opts.excludeBody ?? undefined,
      predicate
    );
    if (!hit) return null;

    const toi = hitDistance(hit);
    const collider = hit.collider;
    const n = hit.normal;
    return {
      point: new THREE.Vector3(
        origin.x + dir.x * toi,
        origin.y + dir.y * toi,
        origin.z + dir.z * toi
      ),
      normal: new THREE.Vector3(n ? n.x : 0, n ? n.y : 1, n ? n.z : 0),
      distance: toi,
      collider,
      body: collider ? collider.parent() : null,
      tag: this.getTag(collider),
    };
  }

  /**
   * Cheap boolean line-of-sight test against world geometry and props only, so
   * a blast is stopped by a wall but not by the people standing in it.
   */
  /**
   * @param {number} [skipNear] metres to step the ray forward before testing.
   *   A blast asks this question from INSIDE the thing that exploded, and a
   *   collider you are already within must not count as blocking your view
   *   out of it — a grenade reported no line of sight to the person standing
   *   over it because the ray hit the grenade's own body at distance zero.
   */
  hasLineOfSight(from, to, extraFilter = null, skipNear = 0) {
    this._tmpVec.subVectors(to, from);
    const dist = this._tmpVec.length();
    if (dist < 0.05) return true;
    this._tmpVec.divideScalar(dist);

    // Start a little way along the ray, past anything the origin sits inside.
    const start = skipNear > 0 && dist > skipNear + 0.1
      ? this._tmpStart.copy(from).addScaledVector(this._tmpVec, skipNear)
      : from;
    const span = skipNear > 0 && dist > skipNear + 0.1 ? dist - skipNear : dist;

    const hit = this.raycast(start, this._tmpVec, span - 0.05, {
      filter: (tag) => {
        if (!tag) return false;
        if (tag.kind === TAG_KIND.WORLD || tag.kind === TAG_KIND.PROP || tag.kind === TAG_KIND.EXPLOSIVE) {
          return extraFilter ? extraFilter(tag) : true;
        }
        return false;
      },
    });
    return hit === null;
  }

  // ------------------------------------------------------------- impulses
  applyImpulse(body, impulse, point = null) {
    if (!body) return;
    if (point) {
      body.applyImpulseAtPoint(impulse, point, true);
    } else {
      body.applyImpulse(impulse, true);
    }
  }

  /**
   * Radial impulse with distance falloff.
   *
   * `strength` is a true impulse in N·s (mass x velocity), so a 320 N·s blast
   * gives an 18 kg crate roughly 18 m/s at the epicentre and tails off with
   * `falloff^1.5` — sharper than linear, gentler than inverse-square, which
   * reads best in-game.
   *
   * @returns {Array<{body:any, distance:number, falloff:number}>} affected bodies
   */
  applyExplosion(center, radius, strength) {
    /*
     * Refuse a blast that is not a number.
     *
     * `dist > undefined` is FALSE, so an undefined radius does not mean "no
     * explosion" — it means every dynamic body in the world is in range, each
     * gets a NaN impulse, and the solver is poisoned for the rest of the
     * match. One barrel with a missing field dropped the player through the
     * floor. Better to do nothing, loudly.
     */
    if (!Number.isFinite(radius) || !Number.isFinite(strength) || radius <= 0) {
      console.error('[Physics] applyExplosion ignored: radius=%o strength=%o', radius, strength);
      return [];
    }
    const affected = [];
    for (const body of this.dynamicBodies) {
      if (!body.isDynamic()) continue;
      const t = body.translation();
      const dx = t.x - center.x;
      const dy = t.y - center.y;
      const dz = t.z - center.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;

      const falloff = 1 - dist / radius;
      const inv = dist > 0.001 ? 1 / dist : 0;
      const mag = strength * Math.pow(falloff, 1.5);

      // Bias upward so debris lifts and tumbles rather than only sliding.
      this._v.x = dx * inv * mag;
      this._v.y = (dy * inv + 0.8) * mag;
      this._v.z = dz * inv * mag;
      body.applyImpulse(this._v, true);

      // A modest spin sells the blast without making crates into gyroscopes.
      this._v2.x = (Math.random() - 0.5) * mag * 0.03;
      this._v2.y = (Math.random() - 0.5) * mag * 0.03;
      this._v2.z = (Math.random() - 0.5) * mag * 0.03;
      body.applyTorqueImpulse(this._v2, true);

      affected.push({ body, distance: dist, falloff });
    }
    return affected;
  }

  dispose() {
    this.tags.clear();
    this.syncBodies.length = 0;
    this.dynamicBodies.clear();
    try {
      this.world.free();
    } catch (err) {
      console.warn('[Physics] world.free() failed:', err);
    }
    this.world = null;
  }
}

/**
 * Rapier renamed `RayColliderToi.toi` to `timeOfImpact` between minor
 * versions. Read whichever exists so the game works across 0.12–0.15.
 */
export function hitDistance(hit) {
  const v = hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi;
  return typeof v === 'number' ? v : 0;
}

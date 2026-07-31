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

    // One shared controller for NPCs (used strictly sequentially) and a
    // dedicated one for the player so their tuning can differ.
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
    this.npcController = this._makeController(0.02, {
      autostepHeight: 0.4,
      autostepMinWidth: 0.2,
      snapToGround: 0.4,
      maxSlope: 50,
      minSlideSlope: 46,
      characterMass: 78,
    });

    // Scratch objects — reused to keep the frame allocation-free.
    this._v = { x: 0, y: 0, z: 0 };
    this._v2 = { x: 0, y: 0, z: 0 };
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._tmpVec = new THREE.Vector3();
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

  /** Kinematic capsule used by the player. */
  createCharacterBody(pos, halfHeight, radius, tag) {
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
  hasLineOfSight(from, to, extraFilter = null) {
    this._tmpVec.subVectors(to, from);
    const dist = this._tmpVec.length();
    if (dist < 0.05) return true;
    this._tmpVec.divideScalar(dist);

    const hit = this.raycast(from, this._tmpVec, dist - 0.05, {
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

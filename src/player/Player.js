/**
 * Player — first-person controller.
 *
 * Movement runs on the **fixed physics step** (`fixedUpdate`) using Rapier's
 * `KinematicCharacterController`, which handles wall sliding, slopes, stairs
 * (auto-step) and ground snapping. Look, camera bob, recoil, lean and shake
 * run on the **render frame**, and the body position is interpolated between
 * the last two physics steps, so aiming is always as smooth as the display
 * allows regardless of the simulation rate.
 *
 * Camera transform =
 *     interpolated body position
 *   + eye height (crouch-aware)
 *   + lean offset (wall-clamped)
 *   + landing dip
 *   + view bob
 *   + screen shake
 *   with rotation = yaw/pitch + weapon recoil + optic sway + lean roll + shake
 *
 * Recoil and optic sway are folded into the *camera*, not just the view model,
 * so where you see is exactly where you shoot.
 */

import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/MathUtils.js';
import { PLAYER_MAX_HEALTH } from '../net/protocol.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { SURFACE } from '../core/AssetManager.js';
import { footstepSoundFor } from '../audio/AudioManager.js';

const RADIUS = 0.35;
const HALF_STAND = 0.60;   // capsule cylinder half-height standing => 1.90 m tall
const HALF_CROUCH = 0.22;  // => 1.14 m tall
const EYE_FROM_TOP = 0.23; // eyes sit this far below the top of the capsule

const SPEED_WALK = 5.6;
const SPEED_SPRINT = 8.9;
const SPEED_CROUCH = 2.8;
const ACCEL_GROUND = 78;
const DECEL_GROUND = 62;
const ACCEL_AIR = 22;
const AIR_CONTROL = 0.55;
const GRAVITY = -24;
const JUMP_VELOCITY = 7.9;
const MAX_FALL = -55;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.16;
const MAX_PITCH = Math.PI / 2 - 0.02;

export class Player {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   * @param {import('../core/InputManager.js').InputManager} input
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../audio/AudioManager.js').AudioManager} audio
   * @param {import('../fx/ParticleManager.js').ParticleManager} fx
   * @param {import('../core/SensitivityManager.js').SensitivityManager} sens
   * @param {import('./LeanSystem.js').LeanSystem} lean
   */
  constructor(camera, physics, input, settings, audio, fx, sens, lean) {
    this.camera = camera;
    this.physics = physics;
    this.input = input;
    this.settings = settings;
    this.audio = audio;
    this.fx = fx;
    this.sens = sens;
    this.lean = lean;

    // --- transform state -------------------------------------------------
    this.position = new THREE.Vector3(0, 1.1, 20);
    this.prevPosition = this.position.clone();
    this.renderPosition = this.position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    // --- movement state --------------------------------------------------
    this.grounded = false;
    this.wasGrounded = false;
    this.crouching = false;
    this.sprinting = false;
    this.halfHeight = HALF_STAND;
    this.targetHalfHeight = HALF_STAND;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.fallSpeed = 0;
    this.alive = true;
    this.enabled = true;
    this.speed01 = 0;

    // --- vitals ----------------------------------------------------------
    this.maxHealth = PLAYER_MAX_HEALTH;
    this.health = 100;
    this.maxArmor = 100;
    this.armor = 50;
    this.lastDamageTime = -99;

    // --- feel ------------------------------------------------------------
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.trauma = 0;
    this.shakeTime = 0;
    this.extraFov = 0;         // set by WeaponSystem (ADS)
    this.adsProgress = 0;      // set by WeaponSystem
    this.scopeProgress = 0;    // set by WeaponSystem
    this.sprintFov = 0;
    this.smoothLook = new THREE.Vector2();
    this.stepDistance = 0;
    this.currentSurface = SURFACE.CONCRETE;
    this._surfaceCheckTimer = 0;

    /** Multipliers written by WeaponSystem each frame. */
    this.weaponSpeedMul = 1;
    this.adsSpeedMul = 1;
    /**
     * Set by WeaponSystem while the trigger is held or the sights are coming
     * up. Sprinting stows the weapon, so wanting to shoot has to end the
     * sprint — otherwise you fire from a lowered gun, which looks wrong.
     */
    this.sprintSuppressed = false;
    /** Optic sway (radians) written by WeaponSystem; folded into the camera. */
    this.opticSway = new THREE.Vector2();
    /** Camera recoil source — assigned by WeaponSystem. */
    this.recoil = null;

    // --- scratch ---------------------------------------------------------
    this._look = { x: 0, y: 0 };
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._desired = { x: 0, y: 0, z: 0 };
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._down = new THREE.Vector3(0, -1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
    this._eyeWorld = new THREE.Vector3();

    this._createBody();

    /** Collision filter for the character controller: ignore enemy bodies. */
    this._movementFilter = (collider) => {
      const tag = this.physics.getTag(collider);
      return !tag || tag.kind !== TAG_KIND.ENEMY;
    };

    /** Callbacks wired up by Game. */
    this.onDeath = null;
    this.onDamage = null;
    this.onHeal = null;
  }

  _createBody() {
    const { body, collider } = this.physics.createCharacterBody(
      this.position, HALF_STAND, RADIUS,
      { kind: TAG_KIND.PLAYER, surface: SURFACE.FLESH, player: this }
    );
    this.body = body;
    this.collider = collider;
    this.controller = this.physics.playerController;
  }

  // ------------------------------------------------------------------ setup
  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.renderPosition.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.armor = 50;
    this.alive = true;
    this.enabled = true;
    this.crouching = false;
    this.sprinting = false;
    this.sprintSuppressed = false;
    this.halfHeight = HALF_STAND;
    this.targetHalfHeight = HALF_STAND;
    this.collider.setHalfHeight(HALF_STAND);
    this.trauma = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.speed01 = 0;
    this.lean?.reset();
    this.sens?.reset();
    this.body.setTranslation(position, true);
    this.body.setNextKinematicTranslation(position);
  }

  get eyeHeight() {
    return this.halfHeight + RADIUS - EYE_FROM_TOP;
  }

  /** World position of the eye *before* lean/bob — used for lean probing. */
  getHeadPosition(out = this._eyeWorld) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Normalised aim direction, including recoil, sway and lean. */
  getAimDirection(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
  }

  /** Combined movement speed multiplier from every source. */
  get speedMultiplier() {
    return this.weaponSpeedMul * this.adsSpeedMul * (this.lean?.speedMultiplier ?? 1);
  }

  // ============================================================ fixed update
  /**
   * Runs inside the fixed physics step, immediately before `world.step()`.
   * @param {number} dt fixed timestep (1/60)
   */
  fixedUpdate(dt) {
    if (!this.alive) {
      this.prevPosition.copy(this.position);
      return;
    }

    this.prevPosition.copy(this.position);

    // ---- crouch / stand -------------------------------------------------
    const wantCrouch = this.enabled && this.input.isDown('crouch');
    if (wantCrouch) {
      this.targetHalfHeight = HALF_CROUCH;
    } else if (this.targetHalfHeight !== HALF_STAND) {
      if (this._hasHeadroom()) this.targetHalfHeight = HALF_STAND;
    }
    this.crouching = this.targetHalfHeight === HALF_CROUCH;

    if (Math.abs(this.halfHeight - this.targetHalfHeight) > 0.0005) {
      const prevHalf = this.halfHeight;
      this.halfHeight = damp(this.halfHeight, this.targetHalfHeight, 16, dt);
      // Keep the feet planted: the capsule centre moves by the height change.
      const delta = this.halfHeight - prevHalf;
      this.position.y += this.grounded ? delta : 0;
      this.collider.setHalfHeight(this.halfHeight);
    }

    // ---- input ----------------------------------------------------------
    let ix = 0;
    let iz = 0;
    if (this.enabled) {
      if (this.input.isDown('forward')) iz -= 1;
      if (this.input.isDown('back')) iz += 1;
      if (this.input.isDown('left')) ix -= 1;
      if (this.input.isDown('right')) ix += 1;
    }
    const hasInput = ix !== 0 || iz !== 0;

    // Sprinting requires forward input, a lowered weapon and both feet on the
    // ground. You can never sprint while scoped.
    this.sprinting =
      this.enabled &&
      this.input.isDown('sprint') &&
      iz < 0 &&
      !this.crouching &&
      this.grounded &&
      this.adsProgress < 0.2 &&
      !this.sprintSuppressed &&
      !this.lean?.isLeaning;

    // ---- wish direction in world space ----------------------------------
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this._wish.set(0, 0, 0);
    if (hasInput) {
      this._wish.addScaledVector(this._forward, -iz);
      this._wish.addScaledVector(this._right, ix);
      this._wish.normalize();
    }

    const baseSpeed = this.crouching ? SPEED_CROUCH : this.sprinting ? SPEED_SPRINT : SPEED_WALK;
    // Strafing and backpedalling are slower — no crab-walking at full tilt.
    const dirPenalty = iz > 0 ? 0.82 : ix !== 0 && iz === 0 ? 0.9 : 1;
    const maxSpeed = baseSpeed * this.speedMultiplier * dirPenalty;

    // ---- horizontal acceleration ---------------------------------------
    const accel = this.grounded ? ACCEL_GROUND : ACCEL_AIR * AIR_CONTROL;
    const targetX = this._wish.x * maxSpeed;
    const targetZ = this._wish.z * maxSpeed;

    if (hasInput) {
      this.velocity.x = approach(this.velocity.x, targetX, accel * dt);
      this.velocity.z = approach(this.velocity.z, targetZ, accel * dt);
    } else if (this.grounded) {
      this.velocity.x = approach(this.velocity.x, 0, DECEL_GROUND * dt);
      this.velocity.z = approach(this.velocity.z, 0, DECEL_GROUND * dt);
    } else {
      // Slight drag in the air so bunny hopping doesn't accumulate speed.
      this.velocity.x *= Math.max(0, 1 - 0.35 * dt);
      this.velocity.z *= Math.max(0, 1 - 0.35 * dt);
    }

    // Clamp on the ground only, so explosive knockback can still launch you.
    if (this.grounded) {
      const hs = Math.hypot(this.velocity.x, this.velocity.z);
      if (hs > maxSpeed * 1.02) {
        const k = (maxSpeed * 1.02) / hs;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
    }

    // ---- jump -----------------------------------------------------------
    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    // The edge itself is latched in updateLook() at render rate — see the note
    // there. Here we only age the buffer out and spend it.
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.velocity.y = JUMP_VELOCITY;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.grounded = false;
      this.audio.play('jump', { volume: 0.7 });
    }

    // ---- gravity --------------------------------------------------------
    this.velocity.y = Math.max(MAX_FALL, this.velocity.y + GRAVITY * dt);
    if (this.grounded && this.velocity.y < 0) this.velocity.y = -2; // stick to slopes

    // ---- move & resolve collisions --------------------------------------
    this._desired.x = this.velocity.x * dt;
    this._desired.y = this.velocity.y * dt;
    this._desired.z = this.velocity.z * dt;

    // Enemies are deliberately excluded from the player's collision solve.
    // If they weren't, a squad pressing into you would shove you across the
    // map — the character controller resolves that overlap every single step.
    this.controller.computeColliderMovement(
      this.collider,
      this._desired,
      this.physics.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this._movementFilter
    );
    const moved = this.controller.computedMovement();

    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation(this.position);

    if (Math.abs(moved.y - this._desired.y) > 1e-4 && this._desired.y > 0) {
      this.velocity.y = Math.min(this.velocity.y, 0); // bonked head
    }

    this.wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    // ---- landing --------------------------------------------------------
    if (!this.wasGrounded && this.grounded) {
      const impact = clamp(-this.fallSpeed / 18, 0, 1.6);
      if (impact > 0.06) {
        this.landDipVel -= impact * 0.42;
        this.addShake(impact * 0.22);
        this.audio.play('land', { volume: clamp(impact * 0.9, 0.15, 1) });
        if (impact > 0.35) {
          this._tmp.copy(this.position);
          this._tmp.y -= this.halfHeight + RADIUS;
          this.fx.spawnLandingDust(this._tmp, clamp(impact, 0.3, 1.4));
        }
        if (-this.fallSpeed > 26) this.applyDamage((-this.fallSpeed - 26) * 2.6, null, 'fall');
      }
      this.velocity.y = 0;
    }
    this.fallSpeed = this.grounded ? 0 : this.velocity.y;

    // ---- footsteps -------------------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed01 = clamp(speed / SPEED_WALK, 0, 1.6);

    if (this.grounded) {
      this.stepDistance += speed * dt;
      const stride = this.crouching ? 1.5 : this.sprinting ? 2.35 : 1.95;
      if (this.stepDistance >= stride && speed > 0.8) {
        this.stepDistance = 0;
        this.audio.play(footstepSoundFor(this.currentSurface), {
          volume: this.crouching ? 0.32 : this.sprinting ? 1.0 : 0.68,
        });
        this.onFootstep?.(this.sprinting ? 16 : this.crouching ? 3 : 8);
      }
    } else {
      this.stepDistance = Math.min(this.stepDistance, 1.2);
    }

    // ---- surface under foot (throttled: 8 Hz is plenty) -----------------
    this._surfaceCheckTimer -= dt;
    if (this._surfaceCheckTimer <= 0) {
      this._surfaceCheckTimer = 0.12;
      this._tmp.copy(this.position);
      const hit = this.physics.raycast(this._tmp, this._down, this.halfHeight + RADIUS + 0.4, {
        excludeCollider: this.collider,
        filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER && tag.kind !== TAG_KIND.ENEMY,
      });
      this.currentSurface = hit?.tag?.surface ?? SURFACE.CONCRETE;
    }

    // Safety net: if the player somehow leaves the arena, respawn them.
    if (this.position.y < -12) {
      this.applyDamage(35, null, 'void');
      this.position.set(0, 2, 22);
      this.velocity.set(0, 0, 0);
      this.body.setTranslation(this.position, true);
    }
  }

  /** Is there room to stand up? */
  _hasHeadroom() {
    this._tmp.copy(this.position);
    const needed = (HALF_STAND - this.halfHeight) + 0.12;
    const hit = this.physics.raycast(this._tmp, this._up, this.halfHeight + RADIUS + needed, {
      excludeCollider: this.collider,
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
    });
    return hit === null;
  }

  // ========================================================== render update
  /**
   * Mouse look. Called at the *start* of the frame, before the physics step,
   * so movement uses this frame's facing rather than the previous frame's.
   */
  updateLook(dt) {
    // ---- latch the jump edge ------------------------------------------
    // This has to happen at RENDER rate even though the jump itself is applied
    // in fixedUpdate, because `wasPressed` is a single-frame edge that
    // `input.endFrame()` wipes at the end of every rendered frame — while
    // fixedUpdate only runs when the accumulator crosses 1/60 s.
    //
    // At 60 fps those line up and nothing is lost. At 240 fps — which is what
    // this actually ran at — only one rendered frame in four steps physics, so
    // three out of four Space presses were cleared before fixedUpdate ever saw
    // them. It presented as the jump key being unreliable and needing several
    // taps, and it got worse the higher the frame rate went.
    //
    // Latching here means the press is recorded the instant it arrives; the
    // fixed step then consumes the buffer whenever it next runs.
    if (this.enabled && this.alive && this.input.wasPressed('jump')) {
      this.jumpBuffer = JUMP_BUFFER;
    }

    this.input.consumeLookDelta(this._look);
    if (!this.enabled || !this.alive) {
      this._look.x = this._look.y = 0;
    }

    const delta = this.sens.compute(this._look, dt, {
      adsProgress: this.adsProgress,
      scopeProgress: this.scopeProgress,
      baseFov: this.settings.get('fov'),
      currentFov: this.camera.fov,
      extraScale: this.weaponSensMul ?? 1,
    });

    this.yaw += delta.yaw;
    this.pitch += delta.pitch;
    this.pitch = clamp(this.pitch, -MAX_PITCH, MAX_PITCH);

    // Keep yaw in a sane range to avoid float drift over long sessions.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // Smoothed look delta feeds weapon sway.
    this.smoothLook.x = damp(this.smoothLook.x, clamp(this._look.x, -40, 40), 14, dt);
    this.smoothLook.y = damp(this.smoothLook.y, clamp(this._look.y, -40, 40), 14, dt);
  }

  /**
   * @param {number} dt   frame delta
   * @param {number} alpha physics interpolation factor 0..1
   */
  update(dt, alpha) {
    this._updateShake(dt);
    this._updateBob(dt);
    this._updateLean(dt);
    this._updateCamera(dt, alpha);
  }

  _updateShake(dt) {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.shakeTime += dt;
  }

  _updateBob(dt) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const target = this.grounded ? clamp(speed / SPEED_WALK, 0, 1.35) : 0;
    this.bobAmount = damp(this.bobAmount, target, 9, dt);
    const rate = this.sprinting ? 12.8 : 9.5;
    this.bobPhase += dt * rate * Math.max(0.001, this.bobAmount);

    // Landing dip: critically damped spring back to 0.
    this.landDipVel += (-this.landDip * 120 - this.landDipVel * 15) * dt;
    this.landDip += this.landDipVel * dt;
    this.landDip = clamp(this.landDip, -0.35, 0.12);
  }

  _updateLean(dt) {
    if (!this.lean) return;
    this.lean.update(dt, {
      eyePosition: this.getHeadPosition(),
      yaw: this.yaw,
      excludeCollider: this.collider,
      allowed: this.enabled && this.alive,
    });
  }

  _updateCamera(dt, alpha) {
    // Interpolate the physics position for jitter-free motion.
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);

    let x = this.renderPosition.x;
    let y = this.renderPosition.y + this.eyeHeight + this.landDip;
    let z = this.renderPosition.z;

    // --- lean: lateral offset, already clamped against walls ---
    const leanOffset = this.lean?.offset ?? 0;
    if (leanOffset !== 0) {
      x += Math.cos(this.yaw) * leanOffset;
      z += -Math.sin(this.yaw) * leanOffset;
    }

    // --- view bob ---
    let rollBob = 0;
    const bobScale = 1 - this.adsProgress * 0.8;
    if (this.settings.get('viewBob') && this.bobAmount > 0.001) {
      const amp = this.bobAmount * (this.crouching ? 0.018 : 0.032) * bobScale;
      y += Math.sin(this.bobPhase * 2) * amp;
      const side = Math.sin(this.bobPhase) * amp * 0.9;
      x += this._right.x * side;
      z += this._right.z * side;
      rollBob = Math.sin(this.bobPhase) * this.bobAmount * 0.012 * bobScale;
    }

    // --- shake ---
    let shakeX = 0, shakeY = 0, shakeRoll = 0;
    const traumaScale = this.settings.get('screenShake');
    if (this.trauma > 0.0001 && traumaScale > 0) {
      const t2 = this.trauma * this.trauma * traumaScale;
      const t = this.shakeTime;
      shakeX = noise1(t * 31.0) * t2 * 0.045;
      shakeY = noise1(t * 27.3 + 11.7) * t2 * 0.045;
      shakeRoll = noise1(t * 21.1 + 4.2) * t2 * 0.035;
      x += noise1(t * 19.0 + 7.0) * t2 * 0.06;
      y += noise1(t * 23.0 + 3.0) * t2 * 0.06;
    }

    this.camera.position.set(x, y, z);

    // --- rotation: aim + recoil + optic sway + lean roll + shake ---
    const rPitch = this.recoil?.currentPitch ?? 0;
    const rYaw = this.recoil?.currentYaw ?? 0;
    this._euler.set(
      clamp(this.pitch + rPitch + this.opticSway.y + shakeY + (this.lean?.pitchDip ?? 0), -MAX_PITCH, MAX_PITCH),
      this.yaw + rYaw + this.opticSway.x + shakeX,
      rollBob + shakeRoll + (this.lean?.roll ?? 0),
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(this._euler);

    // --- FOV ---
    this.sprintFov = damp(this.sprintFov, this.sprinting ? 7 : 0, 8, dt);
    const targetFov = clamp(this.settings.get('fov') + this.sprintFov + this.extraFov, 20, 140);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      // Snap when the change is tiny, damp when it's a real zoom.
      this.camera.fov = damp(this.camera.fov, targetFov, 22, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------- combat
  /** 0..~1 screen shake trauma; accumulates and decays. */
  addShake(amount) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  /**
   * @param {number} amount
   * @param {THREE.Vector3|null} sourcePosition  used for the directional HUD marker
   * @param {string} [cause]
   */
  applyDamage(amount, sourcePosition = null, cause = 'bullet') {
    if (!this.alive || amount <= 0) return 0;

    // Armour soaks 60% of incoming damage until it runs out.
    let remaining = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.6);
      this.armor -= absorbed;
      remaining -= absorbed;
    }
    this.health = Math.max(0, this.health - remaining);
    this.lastDamageTime = performance.now() / 1000;

    this.addShake(clamp(amount / 55, 0.06, 0.5));
    this.audio.play('playerHurt', { volume: clamp(amount / 30, 0.3, 1) });
    this.onDamage?.(amount, sourcePosition, cause);

    if (this.health <= 0) this._die();
    return amount;
  }

  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    const gained = this.health - before;
    if (gained > 0) this.onHeal?.(gained);
    return gained;
  }

  addArmor(amount) {
    const before = this.armor;
    this.armor = Math.min(this.maxArmor, this.armor + amount);
    return this.armor - before;
  }

  /** Explosive knockback — applied straight to velocity. */
  applyImpulse(vec) {
    this.velocity.add(vec);
    this.grounded = false;
    this.coyote = 0;
  }

  _die() {
    this.alive = false;
    this.enabled = false;
    this.audio.play('playerDeath');
    this.onDeath?.();
  }

  dispose() {
    this.physics.removeBody(this.body);
  }
}

/* ------------------------------------------------------------------ helpers */

function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Cheap deterministic 1D value noise in [-1, 1] for screen shake. */
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i);
  const b = hash1(i + 1);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export { lerp, SPEED_WALK };

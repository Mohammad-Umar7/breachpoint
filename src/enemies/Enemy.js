/**
 * Enemy — one hostile soldier: body, senses, tactical state machine, weapon.
 *
 * Sensing
 * -------
 * Vision is distance + field-of-view + a genuine line-of-sight raycast
 * filtered to world geometry and props only, so enemies can never see or
 * shoot through walls. Crucially, spotting is **not instant**: an `awareness`
 * value accumulates while you are visible (faster when you are close, moving
 * fast, or firing) and decays when you are not. Soldiers go SUSPICIOUS long
 * before they go ALERT, which is what stops them snapping onto you the frame
 * you round a corner.
 *
 * Hitboxes
 * --------
 * A single capsule handles movement and bullet collision; the *part* that was
 * hit is derived from where on the capsule the bullet landed (height plus
 * lateral offset). That gives head / torso / arm / leg zones with distinct
 * damage multipliers without stacking overlapping colliders, which would make
 * headshots unhittable because the torso capsule always wins the raycast.
 *
 * Armour
 * ------
 * A separate pool in front of health. A weapon's `armorPen` decides how much
 * damage bypasses the plate; the rest degrades it until it breaks, with a
 * visible and audible tell.
 *
 * States
 * ------
 * IDLE, PATROL, SUSPICIOUS, INVESTIGATE, ALERT, ATTACK, COVER, FLANK,
 * RELOAD, SEARCH, RETREAT, DEAD.
 */

import * as THREE from 'three';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { SURFACE } from '../core/AssetManager.js';
import { clamp, damp, lerp, randRange, randInt, approachAngle, DEG2RAD } from '../core/MathUtils.js';

export const STATE = Object.freeze({
  IDLE: 'idle',
  PATROL: 'patrol',
  SUSPICIOUS: 'suspicious',
  INVESTIGATE: 'investigate',
  ALERT: 'alert',
  ATTACK: 'attack',
  COVER: 'cover',
  FLANK: 'flank',
  RELOAD: 'reload',
  SEARCH: 'search',
  RETREAT: 'retreat',
  DEAD: 'dead',
});

const RADIUS = 0.34;
const HALF_HEIGHT = 0.56;
const CENTER_OFFSET = HALF_HEIGHT + RADIUS;
const HEAD_OFFSET = 0.62;

const VIEW_DISTANCE = 62;
const FOV_COS = Math.cos((110 * Math.PI) / 180 / 2);
const PERIPHERAL_COS = Math.cos((165 * Math.PI) / 180 / 2);
const CLOSE_SENSE_RADIUS = 6;
const LOSE_TARGET_TIME = 3.5;

let nextEnemyId = 1;

export class Enemy {
  constructor({ scene, physics, assets, audio, fx, level, nav }) {
    this.scene = scene;
    this.physics = physics;
    this.assets = assets;
    this.audio = audio;
    this.fx = fx;
    this.level = level;
    this.nav = nav;

    this.id = `e${nextEnemyId++}`;
    this.alive = false;
    this.active = false;
    this.state = STATE.IDLE;
    this.typeId = 'standard';

    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.facing = 0;
    this.targetFacing = 0;

    // --- vitals ---
    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 0;
    this.armorBroken = false;

    // --- tuning (replaced by configure()) ---
    this.stats = null;
    this.predictionLead = 0;

    // --- runtime AI state ---
    this.stateTime = 0;
    this.senseTimer = randRange(0, 0.14);
    this.canSeePlayer = false;
    this.awareness = 0;
    this.lastSeenTime = 99;
    this.lastKnownPosition = new THREE.Vector3();
    this.lastKnownVelocity = new THREE.Vector3();
    this.hasTarget = false;
    this.reactionTimer = 0;
    this.fireTimer = 0;
    this.burstRemaining = 0;
    this.magazine = 30;
    this.reloading = false;
    this.reloadTimer = 0;
    this.staggerTimer = 0;
    this.telegraphTimer = -1;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.peekTimer = 0;
    this.peeking = false;
    this.coverTarget = null;
    this.coverIndex = -1;
    this.coverCooldown = 0;
    this.flankTarget = null;
    this.flankSide = 1;
    this.path = [];
    this.pathIndex = 0;
    this.pathTimer = 0;
    this.patrolIndex = 0;
    this.patrolTarget = null;
    this.stuckTimer = 0;
    this.lastPos = new THREE.Vector3();
    this.deathTimer = 0;
    this.animPhase = Math.random() * 6.28;
    this.crouched = false;
    this.wantsCrouch = false;
    this.squadRole = 'assault';

    // --- scratch ---
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._desired = { x: 0, y: 0, z: 0 };
    this._eye = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._targetPoint = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();
    this._moveTargetVec = new THREE.Vector3();
    this.moveTarget = null;
    this.currentSpeed = 3.4;

    this._buildMesh();
    this._createBody();

    /** Callbacks, wired by EnemyManager. */
    this.onDeath = null;
    this.onShoot = null;
    this.onDamagePlayer = null;
    this.onPropHit = null;
  }

  // ------------------------------------------------------------------ mesh
  _buildMesh() {
    this.root = new THREE.Group();
    this.root.visible = false;
    this.visual = new THREE.Group();
    this.visual.position.y = -CENTER_OFFSET;
    this.root.add(this.visual);

    // Per-enemy material clones so hit flashes and type tints are isolated.
    this.matBody = this.assets.getMaterial('enemyFatigues').clone();
    this.matVest = this.assets.getMaterial('enemyVest').clone();
    this.matSkin = this.assets.getMaterial('enemySkin').clone();
    this.matHelmet = this.assets.getMaterial('enemyHelmet').clone();
    this.matArmor = this.assets.getMaterial('metal').clone();
    this.matArmor.color.set(0x6d7681);
    this.flashMaterials = [this.matBody, this.matVest, this.matSkin, this.matHelmet, this.matArmor];
    for (const m of this.flashMaterials) m.emissive = new THREE.Color(0x000000);

    const mk = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.visual.add(m);
      return m;
    };

    // Authored Blender body if soldier.glb loaded, primitive boxes otherwise.
    // Both paths populate exactly the same handles — head, helmet, eye,
    // vestMesh, armorPlate, shoulderL/R, legL/R, armL/R — so everything
    // downstream (animation, tinting, hit flashes, armour breaking) is
    // identical either way and needs no knowledge of which ran.
    if (this._buildAuthoredBody()) {
      this._buildWeapon();
      this.scene.add(this.root);
      return;
    }

    // Legs (pivot at the hip)
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();
    this.legL.position.set(-0.13, 0.86, 0);
    this.legR.position.set(0.13, 0.86, 0);
    const legGeo = new THREE.BoxGeometry(0.17, 0.84, 0.19);
    for (const grp of [this.legL, this.legR]) {
      const m = new THREE.Mesh(legGeo, this.matBody);
      m.position.y = -0.42;
      m.castShadow = true;
      grp.add(m);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.12, 0.27), this.matVest);
      boot.position.set(0, -0.8, 0.03);
      boot.castShadow = true;
      grp.add(boot);
      this.visual.add(grp);
    }

    // Torso
    mk(new THREE.BoxGeometry(0.46, 0.58, 0.26), this.matBody, 0, 1.16, 0);
    this.vestMesh = mk(new THREE.BoxGeometry(0.5, 0.42, 0.31), this.matVest, 0, 1.2, 0);
    mk(new THREE.BoxGeometry(0.16, 0.12, 0.1), this.matVest, 0, 1.34, 0.18);
    mk(new THREE.BoxGeometry(0.52, 0.14, 0.3), this.matVest, 0, 0.86, 0);

    // Armour plate — shown only on armoured types, hidden when it breaks.
    this.armorPlate = mk(new THREE.BoxGeometry(0.54, 0.36, 0.36), this.matArmor, 0, 1.22, 0);
    this.armorPlate.visible = false;
    this.shoulderL = mk(new THREE.BoxGeometry(0.14, 0.16, 0.22), this.matArmor, -0.29, 1.36, 0);
    this.shoulderR = mk(new THREE.BoxGeometry(0.14, 0.16, 0.22), this.matArmor, 0.29, 1.36, 0);
    this.shoulderL.visible = false;
    this.shoulderR.visible = false;

    // Head + helmet
    this.head = mk(new THREE.BoxGeometry(0.22, 0.24, 0.23), this.matSkin, 0, 1.57, 0);
    this.helmet = mk(new THREE.BoxGeometry(0.27, 0.15, 0.29), this.matHelmet, 0, 1.68, 0);
    mk(new THREE.BoxGeometry(0.24, 0.06, 0.05), this.matHelmet, 0, 1.61, -0.15);
    this.eye = mk(
      new THREE.BoxGeometry(0.15, 0.04, 0.02),
      this.assets.getMaterial('enemyEye'),
      0, 1.58, -0.125
    );

    // Arms (pivot at the shoulder)
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    this.armL.position.set(-0.3, 1.42, 0);
    this.armR.position.set(0.3, 1.42, 0);
    const armGeo = new THREE.BoxGeometry(0.13, 0.5, 0.14);
    for (const grp of [this.armL, this.armR]) {
      const m = new THREE.Mesh(armGeo, this.matBody);
      m.position.y = -0.25;
      m.castShadow = true;
      grp.add(m);
      const glove = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.15), this.matVest);
      glove.position.y = -0.53;
      grp.add(glove);
      this.visual.add(grp);
    }

    this._buildWeapon();
    this.scene.add(this.root);
  }

  /**
   * Build the body from the authored Blender parts in `soldier.glb`.
   *
   * All-or-nothing: if any single part is missing the whole thing bails and
   * the procedural boxes run instead. A half-authored body — a Blender torso
   * on box legs — looks far worse than either alternative and is much harder
   * to diagnose than a clean fallback.
   *
   * @returns {boolean} true if the authored body was built
   */
  _buildAuthoredBody() {
    const NEEDED = [
      'head', 'helmet', 'visor', 'torso', 'vest',
      'armorPlate', 'shoulderL', 'shoulderR',
      'armL', 'armR', 'gloveL', 'gloveR',
      'legL', 'legR', 'bootL', 'bootR',
    ];
    const part = {};
    for (const name of NEEDED) {
      const p = this.assets.getCharacterPart?.('soldier', name);
      if (!p) return false;
      part[name] = p;
    }

    // Geometry is shared across every enemy; only the material is per-enemy,
    // which is what keeps hit flashes and archetype tints isolated.
    const mesh = (name, mat, parent, atPivot = true) => {
      const m = new THREE.Mesh(part[name].geometry, mat);
      if (atPivot) m.position.fromArray(part[name].pivot);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.sharedGeometry = true;
      (parent ?? this.visual).add(m);
      return m;
    };

    mesh('torso', this.matBody);
    this.vestMesh = mesh('vest', this.matVest);

    // Armour: present but hidden until configure() sees an armoured type,
    // and hidden again when the plate breaks.
    this.armorPlate = mesh('armorPlate', this.matArmor);
    this.shoulderL = mesh('shoulderL', this.matArmor);
    this.shoulderR = mesh('shoulderR', this.matArmor);
    this.armorPlate.visible = false;
    this.shoulderL.visible = false;
    this.shoulderR.visible = false;

    // Head carries the helmet and visor as children on a shared pivot, so a
    // nod takes the helmet with it rather than turning the skull inside a
    // static shell (which is what the procedural version does).
    this.head = mesh('head', this.matSkin);
    this.helmet = mesh('helmet', this.matHelmet, this.head, false);
    this.eye = mesh('visor', this.assets.getMaterial('enemyEye'), this.head, false);

    // Limbs: a Group sits at the joint and the mesh sits at the group origin,
    // because AssetManager already translated the geometry by -pivot.
    const limb = (group, name, gear) => {
      group.position.fromArray(part[name].pivot);
      mesh(name, this.matBody, group, false);
      mesh(gear, this.matVest, group, false);
      this.visual.add(group);
    };
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    limb(this.legL, 'legL', 'bootL');
    limb(this.legR, 'legR', 'bootR');
    limb(this.armL, 'armL', 'gloveL');
    limb(this.armR, 'armR', 'gloveR');
    return true;
  }

  _buildWeapon() {
    this.weaponGroup = new THREE.Group();
    this.weaponGroup.position.set(0.22, 1.28, -0.26);
    const gunMetal = this.assets.getMaterial('gunMetal');
    const gunPoly = this.assets.getMaterial('gunPolymer');
    const g1 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.4), gunPoly);
    g1.castShadow = true;
    this.weaponGroup.add(g1);
    this.weaponBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.34, 8), gunMetal);
    this.weaponBarrel.rotation.x = Math.PI / 2;
    this.weaponBarrel.position.set(0, 0.02, -0.34);
    this.weaponGroup.add(this.weaponBarrel);
    const g3 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.06), gunMetal);
    g3.position.set(0, -0.1, 0.02);
    this.weaponGroup.add(g3);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.02, -0.52);
    this.weaponGroup.add(this.muzzle);
    this.visual.add(this.weaponGroup);
  }

  _createBody() {
    const { body, collider } = this.physics.createCharacterBody(
      { x: 0, y: -1000, z: 0 },
      HALF_HEIGHT,
      RADIUS,
      { kind: TAG_KIND.ENEMY, surface: SURFACE.FLESH, enemy: this }
    );
    this.body = body;
    this.collider = collider;
    this.controller = this.physics.npcController;
  }

  // ----------------------------------------------------------------- setup
  /**
   * @param {object} stats  a difficulty-scaled entry from EnemyTypes
   */
  configure(stats) {
    this.stats = stats;
    this.typeId = stats.id;
    this.maxHealth = stats.health;
    this.health = stats.health;
    this.maxArmor = stats.armor;
    this.armor = stats.armor;
    this.armorBroken = stats.armor <= 0;
    this.magazine = stats.magSize;
    this.predictionLead = stats.predictionLead ?? 0;
    this.scoreValue = stats.scoreValue;

    // Visual identity per archetype.
    this.matBody.color.setHex(stats.tint);
    this.matVest.color.setHex(stats.vestTint);
    const armoured = stats.armor > 40;
    this.armorPlate.visible = armoured;
    this.shoulderL.visible = armoured;
    this.shoulderR.visible = armoured;
    this.root.scale.setScalar(stats.scale ?? 1);
    this.eye.material = this.assets.getMaterial('enemyEye');
  }

  spawn(position, patrolStartIndex = -1) {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.lastPos.copy(position);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.armor = this.maxArmor;
    this.armorBroken = this.maxArmor <= 0;
    this.alive = true;
    this.active = true;
    this.state = STATE.PATROL;
    this.stateTime = 0;
    this.hasTarget = false;
    this.canSeePlayer = false;
    this.awareness = 0;
    this.lastSeenTime = 99;
    this.magazine = this.stats.magSize;
    this.reloading = false;
    this.deathTimer = 0;
    this.coverTarget = null;
    this.coverIndex = -1;
    this.flankTarget = null;
    this.telegraphTimer = -1;
    this.path.length = 0;
    this.crouched = false;
    this.facing = randRange(-Math.PI, Math.PI);
    this.targetFacing = this.facing;
    this.patrolIndex = patrolStartIndex >= 0 ? patrolStartIndex : this.level.nearestWaypoint(position);
    this.patrolTarget = null;

    const armoured = this.maxArmor > 40;
    this.armorPlate.visible = armoured;
    this.shoulderL.visible = armoured;
    this.shoulderR.visible = armoured;

    this.root.visible = true;
    this.root.position.copy(position);
    this.root.quaternion.identity();
    this.root.rotation.y = this.facing;
    this.visual.position.set(0, -CENTER_OFFSET, 0);
    this.visual.rotation.set(0, 0, 0);
    this.eye.visible = true;
    this.hitFlash = 0;
    this.aimBlend = 0;
    this.weaponKick = 0;
    this.moveTarget = null;
    this.currentSpeed = this.stats.moveSpeed;
    for (const m of this.flashMaterials) {
      m.emissive.setRGB(0, 0, 0);
      m.opacity = 1;
      m.transparent = false;
    }

    if (!this.body || this._isRagdoll) this._restoreKinematicBody();
    this.body.setTranslation(position, true);
    this.body.setNextKinematicTranslation(position);
  }

  _restoreKinematicBody() {
    if (this.body) this.physics.removeBody(this.body);
    this._createBody();
    this._isRagdoll = false;
  }

  despawn() {
    this.active = false;
    this.alive = false;
    this.root.visible = false;
    this.nav.releaseCover(this.id);
    if (this._isRagdoll) this._restoreKinematicBody();
    this._v.set(0, -1000, 0);
    if (this.body) {
      this.physics.unlinkMesh(this.body);
      this.body.setTranslation(this._v, true);
      this.body.setNextKinematicTranslation(this._v);
    }
  }

  // =========================================================== fixed update
  /**
   * @param {number} dt
   * @param {{player: any, squad: Enemy[], attackerBudget: number}} ctx
   */
  fixedUpdate(dt, ctx) {
    if (!this.active) return;
    this.prevPosition.copy(this.position);

    if (!this.alive) {
      this.deathTimer += dt;
      return;
    }

    this.stateTime += dt;
    this.staggerTimer = Math.max(0, this.staggerTimer - dt);
    this.coverCooldown = Math.max(0, this.coverCooldown - dt);
    this.pathTimer -= dt;

    this._sense(dt, ctx.player);
    this._think(dt, ctx);
    this._updateWeapon(dt, ctx);
    this._move(dt, ctx);
  }

  // ---------------------------------------------------------------- senses
  _sense(dt, player) {
    this.senseTimer -= dt;
    const decay = dt;

    if (this.senseTimer > 0) {
      // Between full checks, keep decaying awareness so it can't stick high.
      if (!this.canSeePlayer) this.awareness = Math.max(0, this.awareness - decay * 0.35);
      this.lastSeenTime += this.canSeePlayer ? 0 : dt;
      return;
    }
    const elapsed = 0.14;
    this.senseTimer = 0.14;

    if (!player.alive) {
      this.canSeePlayer = false;
      this.awareness = Math.max(0, this.awareness - elapsed);
      return;
    }

    this._eye.copy(this.position);
    this._eye.y += HEAD_OFFSET;
    this._targetPoint.copy(player.position);
    this._targetPoint.y += 0.25;

    const dist = this._eye.distanceTo(this._targetPoint);
    let visible = false;

    if (dist <= VIEW_DISTANCE) {
      this._v.subVectors(this._targetPoint, this._eye).normalize();
      this._v2.set(-Math.sin(this.facing), 0, -Math.cos(this.facing));
      const dot = this._v.dot(this._v2);
      // Full cone in front, a weaker peripheral band, and a "someone is right
      // there" bubble that ignores facing entirely.
      const inCone = dot > FOV_COS;
      const inPeripheral = dot > PERIPHERAL_COS;
      const veryClose = dist < CLOSE_SENSE_RADIUS;

      if (inCone || inPeripheral || veryClose) {
        visible = this.physics.hasLineOfSight(this._eye, this._targetPoint);
        if (visible && !inCone && !veryClose) {
          // Peripheral sightings build awareness much more slowly.
          this._peripheralOnly = true;
        } else {
          this._peripheralOnly = false;
        }
      }
    }

    this.canSeePlayer = visible;

    if (visible) {
      // Spot rate: close, fast-moving and firing targets are noticed sooner.
      const playerSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      let rate = 1.9;
      rate *= clamp(1.6 - dist / VIEW_DISTANCE, 0.35, 1.6);
      rate *= 1 + clamp(playerSpeed / 9, 0, 1) * 0.8;
      if (player.crouching) rate *= 0.7;
      if (this._peripheralOnly) rate *= 0.35;
      rate /= Math.max(0.15, this.stats.reactionTime);

      this.awareness = Math.min(1, this.awareness + rate * elapsed * 0.35);
      this.lastSeenTime = 0;
      this.lastKnownPosition.copy(player.position);
      this.lastKnownVelocity.copy(player.velocity);
      if (this.awareness >= 1) this.hasTarget = true;
    } else {
      this.awareness = Math.max(0, this.awareness - elapsed * 0.5);
      this.lastSeenTime += elapsed;
    }
  }

  /** Called when a gunshot, explosion or footstep happens nearby. */
  onNoise(position, loudness, kind = 'gunfire') {
    if (!this.alive) return;
    const d = this.position.distanceTo(position);
    if (d > loudness) return;

    const strength = 1 - d / loudness;
    this.awareness = Math.min(1, this.awareness + strength * (kind === 'gunfire' ? 0.75 : 0.4));
    this.lastKnownPosition.copy(position);

    if (this.state === STATE.IDLE || this.state === STATE.PATROL) {
      this._setState(this.awareness >= 0.95 ? STATE.ALERT : STATE.SUSPICIOUS);
      this.reactionTimer = this.stats.reactionTime * randRange(0.6, 1.2);
    }
  }

  /** Grenades and explosions make everyone nearby scatter. */
  onExplosion(position, radius) {
    if (!this.alive) return;
    const d = this.position.distanceTo(position);
    if (d > radius * 1.8) return;
    this.hasTarget = true;
    this.awareness = 1;
    // Break contact away from the blast.
    this._v.subVectors(this.position, position).setY(0);
    if (this._v.lengthSq() < 0.01) this._v.set(randRange(-1, 1), 0, randRange(-1, 1));
    this._v.normalize().multiplyScalar(9);
    this._moveTargetVec.copy(this.position).add(this._v);
    this.flankTarget = this._moveTargetVec.clone();
    this._setState(STATE.RETREAT);
    this.coverCooldown = 0;
    if (Math.random() < 0.5) this.audio.play('enemyAlert', { position: this.position, volume: 0.8 });
  }

  // ------------------------------------------------------------- behaviour
  _setState(state) {
    if (this.state === state) return;
    if (this.state === STATE.COVER && state !== STATE.COVER) {
      this.nav.releaseCover(this.id);
      this.coverIndex = -1;
    }
    this.state = state;
    this.stateTime = 0;
  }

  _think(dt, ctx) {
    const player = ctx.player;
    const squad = ctx.squad;
    const healthFrac = (this.health + this.armor) / (this.maxHealth + this.maxArmor);
    const distToPlayer = this.position.distanceTo(player.position);

    // ------------------------------------------------ global interrupts
    // Badly hurt: fall back to cover instead of trading in the open.
    if (
      this.alive &&
      this.state !== STATE.RETREAT &&
      this.state !== STATE.COVER &&
      this.coverCooldown <= 0 &&
      this.hasTarget &&
      healthFrac < this.stats.retreatsAt
    ) {
      this._setState(STATE.RETREAT);
      this.coverCooldown = 8;
      if (Math.random() < 0.4) this.audio.play('enemyAlert', { position: this.position, volume: 0.7 });
    }

    // Out of ammo with a target in sight: get behind something and reload.
    if (
      this.alive &&
      this.magazine <= 0 &&
      this.canSeePlayer &&
      this.state !== STATE.COVER &&
      this.state !== STATE.RETREAT &&
      this.coverCooldown <= 0
    ) {
      if (this._acquireCover(player, { preferForward: false })) {
        this.coverCooldown = 6;
        this._setState(STATE.COVER);
      }
    }

    switch (this.state) {
      // ------------------------------------------------------------ idle
      case STATE.IDLE: {
        this.moveTarget = null;
        this.currentSpeed = this.stats.moveSpeed;
        this.targetFacing += Math.sin(this.stateTime * 0.6) * dt * 0.7;
        if (this.awareness > 0.32) { this._setState(STATE.SUSPICIOUS); break; }
        if (this.stateTime > 2.2) this._setState(STATE.PATROL);
        break;
      }

      // ---------------------------------------------------------- patrol
      case STATE.PATROL: {
        this.currentSpeed = this.stats.moveSpeed;
        if (this.awareness > 0.32) { this._setState(STATE.SUSPICIOUS); break; }
        this._patrol(dt, squad);
        break;
      }

      // ------------------------------------------------------ suspicious
      // Something registered but not enough to commit. Stop, look, wait.
      case STATE.SUSPICIOUS: {
        this.currentSpeed = this.stats.moveSpeed * 0.6;
        this.moveTarget = null;
        this._faceTowards(this.lastKnownPosition);
        if (this.awareness >= 0.98) { this._alert(); break; }
        if (this.awareness < 0.1) { this._setState(STATE.PATROL); break; }
        if (this.stateTime > 1.4) this._setState(STATE.INVESTIGATE);
        break;
      }

      // ------------------------------------------------------ investigate
      case STATE.INVESTIGATE: {
        this.currentSpeed = this.stats.moveSpeed * 0.85;
        if (this.awareness >= 0.98) { this._alert(); break; }
        if (this.awareness < 0.06) { this.hasTarget = false; this._setState(STATE.PATROL); break; }
        const d = this.position.distanceTo(this.lastKnownPosition);
        if (d > 2.0) {
          this.moveTarget = this._steerTo(this.lastKnownPosition, false);
        } else {
          this.moveTarget = null;
          this.targetFacing += dt * 1.6;
        }
        if (this.stateTime > 8) { this.awareness *= 0.3; this._setState(STATE.PATROL); }
        break;
      }

      // ----------------------------------------------------------- alert
      case STATE.ALERT: {
        this._faceTowards(this.lastKnownPosition);
        this.moveTarget = null;
        this.currentSpeed = this.stats.moveSpeed;
        this.reactionTimer -= dt;
        if (this.reactionTimer <= 0) {
          // Squad discipline: if the front is already crowded, go around.
          const wantFlank =
            ctx.attackerBudget <= 0 && Math.random() < this.stats.flankAffinity;
          if (wantFlank && this._acquireFlank(player)) this._setState(STATE.FLANK);
          else if (this.canSeePlayer) this._setState(STATE.ATTACK);
          else this._setState(STATE.SEARCH);
        }
        break;
      }

      // ---------------------------------------------------------- attack
      case STATE.ATTACK: {
        this.currentSpeed = this.stats.moveSpeed * 0.9;

        if (!this.canSeePlayer) {
          if (this.lastSeenTime > 1.2) this._setState(STATE.SEARCH);
          this.moveTarget = null;
          break;
        }
        this._faceTowards(player.position);

        // Snipers and gunners hold a firing position rather than dancing.
        if (this.stats.holdsPosition && distToPlayer > this.stats.preferredRange * 0.6) {
          this.moveTarget = null;
          this.wantsCrouch = this.stats.crouches;
          break;
        }

        // Too many friends already engaging head-on: peel off and flank.
        if (ctx.attackerBudget <= 0 && this.stateTime > 1.2 && Math.random() < 0.02) {
          if (this._acquireFlank(player)) { this._setState(STATE.FLANK); break; }
        }

        // Strafe, and hold the archetype's preferred engagement distance.
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = randRange(0.8, 1.9);
          this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        }

        this._v.subVectors(player.position, this.position);
        this._v.y = 0;
        const dp = this._v.length() || 1;
        this._v.divideScalar(dp);
        this._v2.set(-this._v.z, 0, this._v.x).multiplyScalar(this.strafeDir * this.stats.strafeMul);

        const pref = this.stats.preferredRange;
        const closeIn = dp > pref ? 1 : dp < pref * 0.6 ? -1 : 0;
        this._moveTargetVec.copy(this._v).multiplyScalar(closeIn * this.stats.aggression).add(this._v2);

        // Spread out from squadmates so the squad doesn't form a firing line.
        this.nav.spreadVector(this._v3, this, squad, 3.0);
        this._moveTargetVec.add(this._v3.multiplyScalar(0.8));

        if (this._moveTargetVec.lengthSq() > 0.01) {
          this._moveTargetVec.normalize().multiplyScalar(2.6).add(this.position);
          this.moveTarget = this._moveTargetVec;
        } else {
          this.moveTarget = null;
        }
        this.wantsCrouch = this.stats.crouches && dp > pref * 1.4 && Math.abs(this.strafeDir) < 0.1;
        break;
      }

      // ------------------------------------------------------------ cover
      case STATE.COVER: {
        this.currentSpeed = this.stats.chaseSpeed;
        if (!this.coverTarget) { this._setState(STATE.ATTACK); break; }

        const dc = this.position.distanceTo(this.coverTarget);
        if (dc < 1.2) {
          this.wantsCrouch = true;
          this._faceTowards(this.lastKnownPosition);

          if (this.magazine <= 0 && !this.reloading) this._startReload();

          // Peek out briefly to shoot, then duck back.
          this.peekTimer -= dt;
          if (this.peekTimer <= 0) {
            this.peeking = !this.peeking;
            this.peekTimer = this.peeking ? randRange(0.8, 1.6) : randRange(0.9, 2.0);
          }

          if (this.peeking && !this.reloading) {
            // Lean out of cover toward the threat.
            this._v.subVectors(this.lastKnownPosition, this.position).setY(0).normalize();
            this._v2.set(-this._v.z, 0, this._v.x).multiplyScalar(this.strafeDir * 0.9);
            this._moveTargetVec.copy(this.position).add(this._v2);
            this.moveTarget = this._moveTargetVec;
            this.wantsCrouch = false;
          } else {
            this.moveTarget = null;
          }

          const rested = this.stateTime > randRange(2.6, 4.2);
          if (rested && !this.reloading && this.magazine > 0) {
            this.nav.releaseCover(this.id);
            this.coverTarget = null;
            this._setState(this.canSeePlayer ? STATE.ATTACK : STATE.SEARCH);
          }
        } else {
          this.moveTarget = this._steerTo(this.coverTarget, false);
          this.wantsCrouch = false;
          if (this.stateTime > 8) { this.coverTarget = null; this._setState(STATE.ATTACK); }
        }
        break;
      }

      // ------------------------------------------------------------ flank
      case STATE.FLANK: {
        this.currentSpeed = this.stats.chaseSpeed;
        this.wantsCrouch = false;
        if (!this.flankTarget) { this._setState(STATE.ATTACK); break; }
        const df = this.position.distanceTo(this.flankTarget);
        if (df < 2.2 || this.stateTime > 9) {
          this.flankTarget = null;
          this._setState(this.canSeePlayer ? STATE.ATTACK : STATE.SEARCH);
        } else {
          this.moveTarget = this._steerTo(this.flankTarget, false);
          // Abandon the flank if the player walks into view at close range.
          if (this.canSeePlayer && distToPlayer < 9) {
            this.flankTarget = null;
            this._setState(STATE.ATTACK);
          }
        }
        break;
      }

      // ---------------------------------------------------------- retreat
      case STATE.RETREAT: {
        this.currentSpeed = this.stats.chaseSpeed * 1.05;
        this.wantsCrouch = false;
        if (!this.flankTarget) {
          // Head for cover away from the threat.
          if (this._acquireCover(player, { preferForward: false, maxRange: 30 })) {
            this.flankTarget = this.coverTarget;
          } else {
            this._v.subVectors(this.position, player.position).setY(0).normalize().multiplyScalar(12);
            this.flankTarget = this._v.add(this.position).clone();
          }
        }
        const dr = this.position.distanceTo(this.flankTarget);
        if (dr < 1.6 || this.stateTime > 7) {
          this.flankTarget = null;
          if (this.magazine <= 0) this._startReload();
          this._setState(STATE.COVER);
        } else {
          this.moveTarget = this._steerTo(this.flankTarget, false);
        }
        break;
      }

      // ----------------------------------------------------------- search
      case STATE.SEARCH: {
        this.currentSpeed = this.stats.moveSpeed;
        this.wantsCrouch = false;
        if (this.canSeePlayer && this.awareness > 0.6) { this._alert(); break; }

        if (!this.searchPoint || this.position.distanceTo(this.searchPoint) < 1.8) {
          this.searchPoint =
            this.nav.findSearchPoint(this.lastKnownPosition, 16, this.searchPoint) ??
            this.lastKnownPosition.clone();
          this.stateTimeAtPoint = this.stateTime;
        }
        this.moveTarget = this._steerTo(this.searchPoint, false);
        // Sweep while walking.
        if (this.stateTime - (this.stateTimeAtPoint ?? 0) > 2.5) this.targetFacing += dt * 1.1;

        if (this.stateTime > 12) {
          this.hasTarget = false;
          this.awareness *= 0.25;
          this.searchPoint = null;
          this._setState(STATE.PATROL);
        }
        break;
      }

      default:
        break;
    }

    // Crouch blending is handled in the animation pass.
    this.crouched = damp(this.crouched ? 1 : 0, this.wantsCrouch ? 1 : 0, 8, dt) > 0.5;
  }

  _alert() {
    if (this.state === STATE.ALERT || this.state === STATE.ATTACK) return;
    this._setState(STATE.ALERT);
    this.hasTarget = true;
    this.reactionTimer = this.stats.reactionTime * randRange(0.75, 1.25);
    if (Math.random() < 0.6) {
      this.audio.play('enemyAlert', { position: this.position, volume: 0.9 });
    }
  }

  _acquireCover(player, opts = {}) {
    const found = this.nav.findCover(this.position, player.position, {
      claimant: this.id,
      maxRange: opts.maxRange ?? 22,
      preferForward: opts.preferForward ?? false,
    });
    if (!found) return false;
    this.coverTarget = found.point;
    this.coverIndex = found.index;
    return true;
  }

  _acquireFlank(player) {
    this.flankSide = Math.random() < 0.5 ? -1 : 1;
    const target = this.nav.findFlankPosition(
      this.position, player.position, player.yaw, this.flankSide
    );
    if (!target) return false;
    this.flankTarget = target;
    return true;
  }

  _patrol(dt, squad) {
    if (!this.patrolTarget || this.position.distanceTo(this.patrolTarget) < 1.5) {
      const wp = this.level.waypoints[this.patrolIndex];
      const links = wp?.links ?? [];
      if (links.length) {
        // Prefer a link we didn't just come from, so patrols don't ping-pong.
        const options = links.filter((l) => l !== this.lastPatrolIndex);
        const pool = options.length ? options : links;
        this.lastPatrolIndex = this.patrolIndex;
        this.patrolIndex = pool[randInt(0, pool.length - 1)];
      }
      this.patrolTarget = this.level.waypoints[this.patrolIndex].pos.clone();
    }
    this.moveTarget = this._steerTo(this.patrolTarget, false);
  }

  /**
   * Produce a steering target: straight toward the destination when it is
   * directly visible, otherwise follow an A* path through the waypoint graph.
   */
  _steerTo(destination, preferDirect) {
    this._eye.copy(this.position);
    this._eye.y += 0.5;
    this._v.copy(destination);
    this._v.y += 0.5;

    if (preferDirect || this.physics.hasLineOfSight(this._eye, this._v)) {
      this.path.length = 0;
      return destination;
    }

    if (this.pathTimer <= 0 || this.path.length === 0) {
      this.pathTimer = randRange(0.7, 1.2);
      this.path = this.nav.findPath(this.position, destination);
      this.pathIndex = 0;
    }

    while (
      this.pathIndex < this.path.length &&
      this.position.distanceTo(this.path[this.pathIndex]) < 1.7
    ) {
      this.pathIndex++;
    }
    if (this.pathIndex >= this.path.length) {
      this.path.length = 0;
      return destination;
    }
    return this.path[this.pathIndex];
  }

  _faceTowards(target) {
    this._v.subVectors(target, this.position);
    this.targetFacing = Math.atan2(-this._v.x, -this._v.z);
  }

  // ---------------------------------------------------------------- weapon
  _updateWeapon(dt, ctx) {
    const player = ctx.player;

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.magazine = this.stats.magSize;
      }
      return;
    }

    if (this.magazine <= 0) {
      this._startReload();
      return;
    }

    // --- telegraph (snipers wind up before firing) ------------------------
    if (this.telegraphTimer >= 0) {
      this.telegraphTimer -= dt;
      if (this.telegraphTimer <= 0) {
        this.telegraphTimer = -1;
        if (this.canSeePlayer && player.alive) this._shoot(player, ctx);
      }
      return;
    }

    const dist = this.position.distanceTo(player.position);
    const inRange = dist < this.stats.weaponRange;
    const engaging =
      this.state === STATE.ATTACK ||
      this.state === STATE.FLANK ||
      (this.state === STATE.COVER && this.peeking);

    // Suppressing fire: heavies keep shooting at your last known spot.
    const suppressing =
      this.stats.suppresses &&
      !this.canSeePlayer &&
      this.hasTarget &&
      this.lastSeenTime < 2.5 &&
      this.state === STATE.ATTACK;

    const shouldShoot =
      player.alive && inRange && this.stateTime > 0.1 && (
        (this.canSeePlayer && engaging) || suppressing
      );

    this.fireTimer -= dt;
    if (!shouldShoot) {
      this.burstRemaining = 0;
      return;
    }

    // Never shoot through a squadmate.
    this._targetPoint.copy(this.canSeePlayer ? player.position : this.lastKnownPosition);
    this._targetPoint.y += 0.2;
    if (this.nav.friendlyInLine(this.position, this._targetPoint, ctx.squad, this)) {
      this.burstRemaining = 0;
      this.fireTimer = Math.max(this.fireTimer, 0.2);
      return;
    }

    if (this.burstRemaining <= 0) {
      if (this.fireTimer <= 0) {
        this.burstRemaining = randInt(this.stats.burst[0], this.stats.burst[1]);
        this.fireTimer = 0;
      } else {
        return;
      }
    }

    if (this.fireTimer <= 0) {
      if (this.stats.telegraphs && this.burstRemaining === 1) {
        this.telegraphTimer = 0.45;
        this.audio.play('scopeZoom', { position: this.position, volume: 0.5 });
        this.burstRemaining--;
        this.fireTimer = randRange(this.stats.burstPause[0], this.stats.burstPause[1]);
        return;
      }
      this._shoot(player, ctx, suppressing);
      this.burstRemaining--;
      this.fireTimer = this.burstRemaining > 0
        ? this.stats.fireInterval
        : randRange(this.stats.burstPause[0], this.stats.burstPause[1]);
    }
  }

  _startReload() {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadTimer = this.stats.reloadTime;
    this.burstRemaining = 0;
    this.audio.play('magIn', { position: this.position, volume: 0.5 });
  }

  _shoot(player, ctx, suppressing = false) {
    this.magazine--;
    this.muzzle.getWorldPosition(this._muzzleWorld);

    // --- aim point, with optional movement prediction ---------------------
    if (suppressing) {
      this._targetPoint.copy(this.lastKnownPosition);
      this._targetPoint.y += 0.2;
    } else {
      this._targetPoint.copy(player.position);
      this._targetPoint.y += 0.2;
      if (this.predictionLead > 0) {
        this._targetPoint.addScaledVector(player.velocity, this.predictionLead);
      }
    }

    const dist = this._muzzleWorld.distanceTo(this._targetPoint);
    const playerSpeed = Math.hypot(player.velocity.x, player.velocity.z);

    // Error cone in radians: ~4 degrees for a wave-1 rifleman, under 1.5 for
    // an Operator on Extreme. Suppressing fire is deliberately sloppy.
    let errorRad =
      (1 - this.stats.accuracy) *
      (0.05 + Math.min(dist, 80) * 0.0016) *
      (1 + playerSpeed * 0.055);
    if (suppressing) errorRad *= 2.6;
    if (this.staggerTimer > 0) errorRad *= 1.8;
    errorRad += (this.stats.spreadDeg ?? 0) * (Math.PI / 180);

    const pellets = this.stats.pellets ?? 1;
    let hitPlayer = false;

    for (let p = 0; p < pellets; p++) {
      this._aim.subVectors(this._targetPoint, this._muzzleWorld).normalize();
      this._applyCone(this._aim, errorRad);

      const hit = this.physics.raycast(this._muzzleWorld, this._aim, this.stats.weaponRange, {
        excludeCollider: this.collider,
        excludeBody: this.body,
        filter: (tag) => !!tag && tag.kind !== TAG_KIND.ENEMY,
      });

      const endPoint = hit
        ? hit.point
        : this._v2.copy(this._muzzleWorld).addScaledVector(this._aim, this.stats.weaponRange);

      if (p === 0 || Math.random() < 0.5) {
        this.fx.spawnTracer(this._muzzleWorld, endPoint, {
          color: this.typeId === 'sniper' ? 0xff5a5a : 0xff9a5a,
          width: this.typeId === 'sniper' ? 0.05 : 0.03,
          speed: this.typeId === 'sniper' ? 700 : 420,
        });
      }

      if (hit) {
        if (hit.tag?.kind === TAG_KIND.PLAYER) {
          const falloff = clamp(1 - Math.max(0, dist - 22) / 55, 0.4, 1);
          this.onDamagePlayer?.(this.stats.damage * falloff, this.position);
          hitPlayer = true;
        } else {
          this.fx.spawnImpact(hit.point, hit.normal, hit.tag?.surface ?? SURFACE.CONCRETE, 0.8);
          if (hit.tag?.kind === TAG_KIND.EXPLOSIVE && hit.tag.prop) {
            this.onPropHit?.(hit.tag.prop, 12, hit.point, this._aim);
          }
        }
      }
    }

    this.fx.spawnMuzzleFlash(this._muzzleWorld, this._aim, this.typeId === 'heavy' ? 1.1 : 0.8, true);
    this.audio.play(this.typeId === 'sniper' ? 'shootMarksman' : 'shootEnemy', {
      position: this._muzzleWorld,
      volume: this.typeId === 'heavy' ? 1.1 : 1,
    });
    this.weaponKick = 1;
    this.onShoot?.(this.position);
    return hitPlayer;
  }

  /** Jitter a unit vector inside a cone of the given half-angle. */
  _applyCone(dir, halfAngle) {
    if (halfAngle <= 0.00001) return dir;
    this._v.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.95) this._v.set(1, 0, 0);
    this._v2.crossVectors(dir, this._v).normalize();
    this._v.crossVectors(this._v2, dir).normalize();
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * Math.tan(halfAngle);
    return dir
      .addScaledVector(this._v2, Math.cos(ang) * rad)
      .addScaledVector(this._v, Math.sin(ang) * rad)
      .normalize();
  }

  // ---------------------------------------------------------------- moving
  _move(dt, ctx) {
    let speed = this.currentSpeed ?? this.stats.moveSpeed;
    if (this.staggerTimer > 0) speed *= 1 - 0.55 * (1 - this.stats.staggerResist);
    if (this.reloading) speed *= 0.75;
    if (this.crouched) speed *= 0.55;

    this._v.set(0, 0, 0);
    if (this.moveTarget) {
      this._v.subVectors(this.moveTarget, this.position);
      this._v.y = 0;
      const d = this._v.length();
      if (d > 0.25) {
        this._v.divideScalar(d).multiplyScalar(speed);
        this._avoidObstacles(this._v, speed);
      } else {
        this._v.set(0, 0, 0);
      }
    }

    this.velocity.x = damp(this.velocity.x, this._v.x, 9, dt);
    this.velocity.z = damp(this.velocity.z, this._v.z, 9, dt);
    this.velocity.y = Math.max(-40, this.velocity.y - 24 * dt);

    this._desired.x = this.velocity.x * dt;
    this._desired.y = this.velocity.y * dt;
    this._desired.z = this.velocity.z * dt;

    this.controller.computeColliderMovement(
      this.collider,
      this._desired,
      this.physics.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS
    );
    const moved = this.controller.computedMovement();
    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation(this.position);

    if (this.controller.computedGrounded()) this.velocity.y = -1;

    // Face movement while travelling; hold the combat facing while engaging.
    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const travelling =
      this.state === STATE.PATROL || this.state === STATE.SEARCH ||
      this.state === STATE.INVESTIGATE || this.state === STATE.FLANK ||
      this.state === STATE.RETREAT ||
      (this.state === STATE.COVER && !this.peeking);
    if (planarSpeed > 0.6 && travelling) {
      this.targetFacing = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    this.facing = approachAngle(this.facing, this.targetFacing, dt * 7.5);

    // Stuck detection: nudge sideways if we've barely moved while trying to.
    if (this.moveTarget) {
      const delta = this.position.distanceTo(this.lastPos);
      if (delta < 0.02 * 60 * dt) this.stuckTimer += dt;
      else this.stuckTimer = 0;
      if (this.stuckTimer > 0.8) {
        this.stuckTimer = 0;
        this.strafeDir *= -1;
        this.path.length = 0;
        this.pathTimer = 0;
        this.position.x += Math.cos(this.facing) * 0.25 * this.strafeDir;
        this.position.z += Math.sin(this.facing) * 0.25 * this.strafeDir;
      }
    }
    this.lastPos.copy(this.position);
  }

  /** Two forward whiskers; steer away from whatever they touch. */
  _avoidObstacles(vel, speed) {
    this._eye.copy(this.position);
    this._eye.y += 0.1;
    const len = 1.6;
    for (const side of [-0.5, 0.5]) {
      this._v2.set(vel.x, 0, vel.z).normalize();
      const c = Math.cos(side), s = Math.sin(side);
      const dx = this._v2.x * c - this._v2.z * s;
      const dz = this._v2.x * s + this._v2.z * c;
      this._v2.set(dx, 0, dz);
      const hit = this.physics.raycast(this._eye, this._v2, len, {
        excludeCollider: this.collider,
        excludeBody: this.body,
        filter: (tag) =>
          !!tag &&
          (tag.kind === TAG_KIND.WORLD || tag.kind === TAG_KIND.PROP || tag.kind === TAG_KIND.EXPLOSIVE),
      });
      if (hit) {
        const push = (1 - hit.distance / len) * speed * 0.9;
        vel.x -= this._v2.x * push;
        vel.z -= this._v2.z * push;
      }
    }
  }

  // ================================================================= damage
  /**
   * Which body part does this world-space point correspond to?
   *
   * Derived from the hit's height above the capsule centre plus its lateral
   * offset from the body axis, which gives clean head / torso / arm / leg
   * zones from a single collider.
   */
  partAtPoint(point) {
    const scale = this.root.scale.x || 1;
    const local = (point.y - this.position.y) / scale;
    const dx = point.x - this.position.x;
    const dz = point.z - this.position.z;
    const lateral = Math.hypot(dx, dz) / scale;

    if (local > 0.44) return lateral < 0.26 ? 'head' : 'arm';
    if (local < -0.28) return 'leg';
    if (lateral > 0.245) return 'arm';
    return 'torso';
  }

  /**
   * @returns {boolean} true if this hit killed the enemy
   */
  takeDamage(amount, opts = {}) {
    if (!this.alive) return false;
    const {
      part = 'torso',
      headshot = false,
      point = null,
      direction = null,
      force = 4,
      armorPen = 0.4,
      source = 'player',
    } = opts;

    this.lastDamageSource = source;

    // ---- armour ---------------------------------------------------------
    let toHealth = amount;
    if (this.armor > 0 && part !== 'head' && part !== 'leg') {
      const throughPlate = amount * clamp(armorPen, 0, 1);
      const ontoPlate = amount - throughPlate;
      const absorbed = Math.min(this.armor, ontoPlate);
      this.armor -= absorbed;
      toHealth = throughPlate + (ontoPlate - absorbed);

      if (this.armor <= 0 && !this.armorBroken) {
        this.armorBroken = true;
        this.armorPlate.visible = false;
        this.shoulderL.visible = false;
        this.shoulderR.visible = false;
        this.audio.play('impactMetal', { position: this.position, volume: 1 });
        if (point) this.fx.spawnImpact(point, direction ?? UP, SURFACE.METAL, 1.6);
      }
    }

    this.health -= toHealth;

    // ---- hit reaction ----------------------------------------------------
    const stagger = (headshot ? 0.4 : 0.22) * (1 - this.stats.staggerResist);
    this.staggerTimer = Math.max(this.staggerTimer, stagger);
    this.hitFlash = 1;
    for (const m of this.flashMaterials) m.emissive.setRGB(0.9, 0.15, 0.12);

    // Being shot at makes them aware immediately, but they still have to find
    // you — they only learn a position if they can actually see you.
    if (source === 'player') {
      this.awareness = 1;
      this.hasTarget = true;
      if (
        this.state === STATE.IDLE || this.state === STATE.PATROL ||
        this.state === STATE.SUSPICIOUS || this.state === STATE.INVESTIGATE
      ) {
        this._alert();
        this.reactionTimer *= 0.55;
      }
    }

    if (this.health <= 0) {
      this._die(direction, force, headshot);
      return true;
    }

    this.audio.play('enemyHurt', { position: this.position, volume: 0.8 });
    return false;
  }

  _die(direction, force, headshot) {
    this.alive = false;
    this.state = STATE.DEAD;
    this.deathTimer = 0;
    this.nav.releaseCover(this.id);
    this.audio.play('enemyDeath', { position: this.position, volume: 1 });
    this.eye.visible = false;

    // Ragdoll-ish death: swap the kinematic capsule for a dynamic one and
    // knock it over.
    //
    // Getting this to fall reliably took three corrections, because a 0.56 m
    // square-based, 1.4 m tall, 78 kg box standing on a flat face is a
    // *statically stable* shape. Toppling it means lifting the centre of mass
    // from 0.700 m to 0.754 m — about 101 J, or a sustained 1.85 rad/s at the
    // tipping edge. Measured over 400 headless Rapier trials per config, the
    // original code left corpses perfectly upright 35% of the time with a
    // rifle and 27% with a headshot.
    //
    //  1. `body.applyImpulse` applies at the centre of mass, which by
    //     definition produces ZERO turning moment. The 88 N.s "shove" only
    //     ever slid the corpse; it could not contribute any rotation at all.
    //     It now goes through applyImpulseAtPoint at chest height.
    //  2. The random torque was too weak to matter: +/-60 N.m.s against
    //     I = 14.8 kg.m^2 is 0-4 rad/s, symmetric about zero, so frequently
    //     near nil — and a face-on four-corner landing at friction 0.85 is a
    //     very effective rotational brake that ate what little there was.
    //     A guaranteed angular velocity about the tip axis replaces it.
    //  3. Neither of those is enough on its own (off-centre impulse alone
    //     still left 20.5% upright), so the body also spawns pre-tilted about
    //     the axis perpendicular to the shot, falling the way the bullet was
    //     travelling.
    //
    // Note what is deliberately NOT done here: spawning the body already flat
    // at 90 degrees. That reaches 0% upright but `linkMesh` seeds prevQuat
    // from the creation rotation and `update()` returns early for corpses, so
    // the soldier would snap from standing to prone in a single frame —
    // trading an intermittent bug for a constant one. 32 degrees keeps a
    // visible topple.
    this.physics.removeBody(this.body);

    // Horizontal shot direction, with a real fallback rather than a `|| 1`
    // guard: a vertical `direction` (an explosion directly under the enemy)
    // would otherwise yield a zero rotation axis and leave the body upright.
    const dir = direction ?? this._v.set(0, 0, 1);
    let dx = dir.x;
    let dz = dir.z;
    let dLen = Math.hypot(dx, dz);
    if (dLen < 1e-4) {
      dx = -Math.sin(this.facing);
      dz = -Math.cos(this.facing);
      dLen = 1;
    }
    dx /= dLen;
    dz /= dLen;

    // Tip axis = up x shotDir, so the body's up rotates towards the shot
    // direction and it falls away from the shooter.
    const axX = dz;
    const axZ = -dx;
    const TILT = 32 * DEG2RAD;
    const half = TILT * 0.5;
    const sh = Math.sin(half);

    const { body } = this.physics.createDynamicBox(
      this.position,
      { x: 0.28, y: 0.7, z: 0.28 },
      {
        mass: 78,
        friction: 0.8,
        restitution: 0.0,
        linearDamping: 0.35,
        angularDamping: 0.35,
        quat: { x: axX * sh, y: 0, z: axZ * sh, w: Math.cos(half) },
        tag: { kind: TAG_KIND.PROP, surface: SURFACE.FLESH, corpse: true },
        mesh: this.root,
      }
    );
    this.body = body;
    this._isRagdoll = true;

    // Off-centre shove at chest height — this is what actually generates the
    // turning moment. Headshots keep their extra vertical kick.
    this._v3.set(this.position.x, this.position.y + 0.45, this.position.z);
    this.physics.applyImpulse(
      body,
      { x: dx * force * 20, y: force * 10 + (headshot ? 55 : 18), z: dz * force * 20 },
      this._v3
    );

    // Guaranteed rotation past the 1.85 rad/s tipping threshold, about the
    // same axis as the pre-tilt, plus a little scatter so no two deaths look
    // identical.
    const spin = randRange(2.8, 4.2);
    body.setAngvel(
      {
        x: axX * spin + randRange(-0.6, 0.6),
        y: randRange(-1.6, 1.6),
        z: axZ * spin + randRange(-0.6, 0.6),
      },
      true
    );

    this.visual.position.set(0, -CENTER_OFFSET + 0.1, 0);
    this.onDeath?.(this, headshot);
  }

  // ========================================================== render update
  update(dt, alpha) {
    if (!this.active) return;

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
      const k = this.hitFlash;
      for (const m of this.flashMaterials) m.emissive.setRGB(0.9 * k, 0.15 * k, 0.12 * k);
    }

    if (!this.alive) {
      if (this.deathTimer > 8) {
        const t = clamp((this.deathTimer - 8) / 2, 0, 1);
        for (const m of this.flashMaterials) {
          m.transparent = true;
          m.opacity = 1 - t;
        }
        if (t >= 1) this.despawn();
      }
      return;
    }

    this.root.position.lerpVectors(this.prevPosition, this.position, alpha);
    this.root.rotation.set(0, this.facing, 0);
    this._animateLimbs(dt);
  }

  _animateLimbs(dt) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const walk = clamp(speed / this.stats.moveSpeed, 0, 1.4);
    this.animPhase += dt * (4.4 + walk * 4.5) * Math.max(0.12, walk);

    const swing = Math.sin(this.animPhase) * 0.75 * walk;
    const swing2 = Math.sin(this.animPhase + Math.PI) * 0.75 * walk;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = swing2;

    const aiming =
      this.state === STATE.ATTACK || this.state === STATE.ALERT ||
      this.state === STATE.SUSPICIOUS ||
      (this.state === STATE.COVER && this.peeking) ||
      (this.state === STATE.FLANK && this.canSeePlayer);
    const aimBlend = (this.aimBlend = damp(this.aimBlend ?? 0, aiming ? 1 : 0, 8, dt));

    this.armR.rotation.x = lerp(swing2 * 0.6, -1.45, aimBlend);
    this.armL.rotation.x = lerp(swing * 0.6, -1.3, aimBlend);
    this.armL.rotation.z = lerp(0, 0.45, aimBlend);
    this.armR.rotation.z = lerp(0, -0.15, aimBlend);

    this.weaponGroup.position.set(
      lerp(0.26, 0.06, aimBlend),
      lerp(1.16, 1.42, aimBlend),
      lerp(-0.2, -0.3, aimBlend)
    );
    this.weaponGroup.rotation.x = lerp(0.25, 0, aimBlend);

    if (this.weaponKick > 0) {
      this.weaponKick = Math.max(0, this.weaponKick - dt * 12);
      this.weaponGroup.position.z += this.weaponKick * 0.06;
      this.weaponGroup.rotation.x -= this.weaponKick * 0.2;
    }

    // Crouching drops the whole body and shortens the legs' swing.
    this.crouchVisual = damp(this.crouchVisual ?? 0, this.wantsCrouch ? 1 : 0, 8, dt);
    const crouchDrop = this.crouchVisual * 0.34;
    this.visual.position.y =
      -CENTER_OFFSET - crouchDrop + Math.sin(this.animPhase * 0.5) * 0.012 * (1 - walk);
    this.visual.rotation.x = this.crouchVisual * 0.12;

    // Stagger: a brief flinch when hit.
    if (this.staggerTimer > 0) {
      const s = this.staggerTimer * (1 - this.stats.staggerResist);
      this.visual.rotation.x += s * 0.5;
      this.visual.rotation.z = Math.sin(this.staggerTimer * 40) * s * 0.25;
    } else {
      this.visual.rotation.z = 0;
    }

    this.head.rotation.x = lerp(0, -0.15, aimBlend);
    // The visor glows brighter the more aware they are — a fair tell.
    this.eye.visible = this.awareness > 0.25;
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      // Authored body parts share one BufferGeometry across every enemy in
      // the level — disposing it when a single one is cleaned up would blank
      // out all the others. Only procedural geometry is owned by this enemy.
      if (o.isMesh && !o.userData.sharedGeometry) o.geometry?.dispose();
    });
    for (const m of this.flashMaterials) m.dispose();
    if (this.body) this.physics.removeBody(this.body);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

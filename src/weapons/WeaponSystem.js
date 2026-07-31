/**
 * WeaponSystem — the player's loadout and all shooting logic.
 *
 * Slots: 1 primary, 2 secondary, 3 knife, 4 grenade. The primary/secondary
 * pair comes from the loadout chosen in the menu; knife and grenades are
 * always carried.
 *
 * Shooting is **hitscan** for most weapons: a ray is cast from the exact
 * centre of the screen (the camera position, along its forward axis — which
 * already includes recoil, optic sway and lean), jittered inside the current
 * spread cone. The visual tracer is fired from the gun's muzzle toward the
 * same impact point, which is what makes shots read as accurate while still
 * looking like they came out of the barrel.
 *
 * Sniper rifles instead fire **simulated projectiles** with travel time and
 * gravity drop, swept with a ray between each step so nothing is tunnelled
 * through.
 */

import * as THREE from 'three';
import { Weapon, WEAPON_STATE } from './Weapon.js';
import { WEAPON_DEFS, getWeaponDef } from './WeaponDefinitions.js';
import { ADSSystem } from './ADSSystem.js';
import { RecoilSystem } from './RecoilSystem.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { SURFACE } from '../core/AssetManager.js';
import { impactSoundFor } from '../audio/AudioManager.js';
import { clamp, randRange } from '../core/MathUtils.js';

const MOUSE_LEFT = 0;

/** Loadout slot order. */
export const SLOTS = ['primary', 'secondary', 'melee', 'throwable'];

export class WeaponSystem {
  constructor({ camera, player, physics, fx, audio, settings, input, assets, viewModel, adsSystem }) {
    this.camera = camera;
    this.player = player;
    this.physics = physics;
    this.fx = fx;
    this.audio = audio;
    this.settings = settings;
    this.input = input;
    this.assets = assets;
    this.viewModel = viewModel;

    /** @type {Map<string, Weapon>} every weapon, instantiated once. */
    this.pool = new Map();
    for (const def of WEAPON_DEFS) {
      const w = new Weapon(def, assets);
      this.pool.set(def.id, w);
      viewModel.addWeapon(w);
    }

    this.ads = adsSystem ?? new ADSSystem(settings, input, audio);
    this.recoil = new RecoilSystem(settings);
    player.recoil = this.recoil;

    /** @type {Weapon[]} the four carried weapons, indexed by slot. */
    this.slots = [];
    this.currentIndex = 0;
    this.previousIndex = 1;
    this.current = null;
    this.quickMeleeReturn = -1;

    this.enabled = true;
    this.shotsFired = 0;
    this.shotsHit = 0;
    /** Seconds of remembered trigger press, used to bridge the sprint raise. */
    this.fireBuffer = 0;
    /** This frame's raw aim request; cancels a sprint. Set in update(). */
    this.aimIntent = false;

    // --- projectiles (sniper rounds) -------------------------------------
    this.projectiles = [];
    for (let i = 0; i < 24; i++) {
      this.projectiles.push({
        alive: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        gravity: 0,
        life: 0,
        weaponId: null,
        travelled: 0,
      });
    }

    // --- thrown grenades --------------------------------------------------
    this.grenades = [];

    // --- callbacks (wired by Game) ---
    this.onHit = null;

    /**
     * Multiplayer hooks, installed by Game while connected to a match.
     *
     * remoteHitTest(origin, dir, maxDist) returns the nearest other player on
     * the ray, or null. Other players carry no physics colliders on purpose
     * (see RemotePlayers.raycast), so they are tested separately and take
     * precedence whenever they are nearer than whatever the physics ray struck.
     *
     * onRemoteHit(hit) reports the claim to the server, which decides the
     * damage. Nothing here applies damage locally.
     */
    this.remoteHitTest = null;
    this.onRemoteHit = null;
    this.onKill = null;
    this.onShotFired = null;
    this.onPropHit = null;
    this.onGrenadeExplode = null;

    // --- scratch ---
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._spreadDir = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._shellVel = new THREE.Vector3();
    this._impulse = { x: 0, y: 0, z: 0 };
    this._point = { x: 0, y: 0, z: 0 };

    this.applyLoadout(settings.get('loadoutPrimary'), settings.get('loadoutSecondary'));
  }

  // ------------------------------------------------------------- loadout
  /**
   * Build the carried set. Unknown ids fall back to sensible defaults so a
   * stale saved loadout can never leave the player unarmed.
   */
  /**
   * @param {string} primaryId
   * @param {string} secondaryId
   * @param {{preserveAmmo?: boolean}} [opts]
   *   `preserveAmmo` skips the ammo reset entirely. Used when the loadout is
   *   changed DURING a match, where a reset would make the pause menu a free
   *   instant reload — swap the gun in your hands out and back and it returns
   *   with a full magazine.
   *
   *   It has to skip ALL of them, not just the ones still carried. The pool
   *   holds one instance per weapon, so a gun that leaves the loadout and
   *   comes back is the same object with its magazine intact; resetting
   *   "newly added" weapons therefore refilled exactly the ones being abused.
   *
   *   A weapon genuinely brought in for the first time still arrives loaded,
   *   because its ammo has sat untouched since the last spawn.
   */
  applyLoadout(primaryId, secondaryId, { preserveAmmo = false } = {}) {
    const primary = this.pool.get(primaryId) ?? this.pool.get('rifle');
    const secondary = this.pool.get(secondaryId) ?? this.pool.get('pistol');
    const knife = this.pool.get('knife');
    const grenade = this.pool.get('grenade');

    for (const w of this.pool.values()) w.onHolster();

    this.slots = [primary, secondary, knife, grenade];
    if (!preserveAmmo) {
      for (const w of this.slots) w.resetAmmo();
    }

    this.currentIndex = 0;
    this.previousIndex = 1;
    this.current = this.slots[0];
    this.current.onEquip();
    this.recoil.reset();
    this.ads.reset();
  }

  get adsProgress() { return this.ads.progress; }
  get scopeProgress() { return this.ads.scopeProgress; }

  // ================================================================= update
  update(dt) {
    const alive = this.player.alive && this.enabled;

    if (alive) {
      this._handleSwitching();
      this._handleReload();
      this._handleInspect();
    }

    // Read AFTER _handleSwitching, never before it.
    //
    // `_handleSwitching` can replace `this.current` mid-frame, and every
    // consumer below has to see the weapon the player actually just selected.
    // Capturing it above meant the *outgoing* weapon was handed to
    // `viewModel.update()` at the end of the same frame — and the visibility
    // line there re-showed the group that `onHolster()` had just hidden, so
    // the old weapon stayed on screen permanently. Selecting the knife left
    // the 1.24 m AWM drawn over the top of the 0.33 m knife, which is why the
    // HUD said COMBAT KNIFE while the screen showed a sniper rifle.
    //
    // It also fixes three one-frame errors on every switch: ADS gating used
    // the outgoing weapon's `noAds`, `weaponSpeedMul` used its move penalty,
    // and the incoming weapon's raise animation lost its first frame.
    const w = this.current;

    // --- ADS -------------------------------------------------------------
    // Sprinting deliberately does NOT block this.
    //
    // It used to: `!(player.sprinting && ads.progress < 0.05)`. That deadlocks.
    // Aiming was refused while sprinting, so ads.progress stayed at 0; sprint
    // is only cancelled once ads.progress passes 0.02; so the sprint never
    // ended and aiming was never permitted. Holding Shift made the aim button
    // do nothing whatsoever — you had to let go of Shift first.
    //
    // The trigger never had this problem because it suppresses the sprint
    // directly rather than going through ADS progress. Aim now does the same:
    // the intent cancels the sprint (see _handleFiring), the player drops to
    // walking pace, and the weapon comes up — which is what every other
    // shooter does.
    const adsAllowed = alive && !w.def.noAds && !w.blocksAds;
    const intent = this.ads.computeIntent(w, adsAllowed);
    /** Read by _handleFiring to end the sprint. */
    this.aimIntent = intent;

    if (alive && this.ads.scopeProgress > 0.4) {
      // Mouse wheel and B cycle a variable-zoom optic while scoped.
      const wheel = this.input.consumeWheel();
      if (wheel !== 0 || this.input.wasPressed('zoomToggle')) this.ads.cycleZoom(w);
    }

    this.ads.update(dt, w, intent, {
      holdBreathPressed: this.input.isDown('sprint'),
      moving: this.player.speed01,
    });

    // Feed aim state back to the player: FOV, sensitivity, speed, sway.
    const baseFov = this.settings.get('fov');
    this.player.adsProgress = this.ads.progress;
    this.player.scopeProgress = this.ads.scopeProgress;
    this.player.extraFov = this.ads.targetFov(w, baseFov) - baseFov;
    this.player.weaponSensMul = this.ads.weaponSensitivityMultiplier(w);
    this.player.adsSpeedMul = this.ads.moveSpeedMultiplier(w);
    this.player.weaponSpeedMul = w.def.moveSpeedMul ?? 1;
    this.player.opticSway.set(this.ads.sway.x, this.ads.sway.y);

    // --- recoil -----------------------------------------------------------
    this.recoil.update(dt);

    // --- firing -----------------------------------------------------------
    if (alive) this._handleFiring(dt);

    // --- weapon state -----------------------------------------------------
    w.update(dt, (name) => this.audio.play(name, { volume: 0.9 }), this.ads.progress);

    // --- projectiles & grenades ------------------------------------------
    this._updateProjectiles(dt);
    this._updateGrenades(dt);

    // --- view model -------------------------------------------------------
    this.viewModel.update(dt, {
      weapon: w,
      adsProgress: this.ads.progress,
      scopeProgress: this.ads.scopeProgress,
      recoil: this.recoil,
      lookDelta: this.player.smoothLook,
      speed01: this.player.speed01,
      sprinting: this.player.sprinting,
      crouching: this.player.crouching,
      grounded: this.player.grounded,
      verticalVelocity: this.player.velocity.y,
      lean: this.player.lean?.amount ?? 0,
      wallProximity: this._wallProximity(),
      reloadCurve: w.reloadCurve,
      equip: w.switchProgress,
    });
  }

  // ------------------------------------------------------------ switching
  _handleSwitching() {
    let target = -1;
    if (this.input.wasPressed('slot1')) target = 0;
    else if (this.input.wasPressed('slot2')) target = 1;
    else if (this.input.wasPressed('slot3')) target = 2;
    else if (this.input.wasPressed('slot4')) target = 3;
    else if (this.input.wasPressed('lastWeapon')) target = this.previousIndex;

    // Quick melee / quick grenade: swap in, use, swap back.
    if (this.input.wasPressed('quickMelee') && this.currentIndex !== 2) {
      this.quickMeleeReturn = this.currentIndex;
      target = 2;
    } else if (this.input.wasPressed('quickGrenade') && this.currentIndex !== 3) {
      if (this.slots[3].magazine > 0 || this.slots[3].reserve > 0) {
        this.quickMeleeReturn = this.currentIndex;
        target = 3;
      }
    }

    // The wheel cycles weapons unless a scope is using it for zoom.
    if (target === -1 && this.ads.scopeProgress <= 0.4) {
      const wheel = this.input.consumeWheel();
      if (wheel !== 0) {
        target = (this.currentIndex + (wheel > 0 ? 1 : -1) + this.slots.length) % this.slots.length;
      }
    }

    if (target >= 0 && target < this.slots.length) this.switchTo(target);
  }

  switchTo(index) {
    if (index === this.currentIndex) return;
    const next = this.slots[index];
    if (!next) return;
    if (this.current.state === WEAPON_STATE.SWITCHING) return;
    if (this.current.state === WEAPON_STATE.MELEE) return;

    this.previousIndex = this.currentIndex;
    this.current.onHolster();
    this.currentIndex = index;
    this.current = next;
    this.current.onEquip();
    this.ads.reset();
    this.recoil.resetPattern();
    this.viewModel.cancelInspect();
    this.audio.play('weaponSwitch');
  }

  _handleReload() {
    if (this.input.wasPressed('reload')) {
      if (this.current.startReload()) {
        this.ads.toggleState = false;
        this.viewModel.cancelInspect();
        if (this.current.def.reloadType === 'shells') this.audio.play('magOut', { volume: 0.6 });
      }
    }
    // Auto-reload when the magazine runs dry and reserves remain.
    if (
      this.current.isEmpty &&
      this.current.canReload &&
      this.current.state === WEAPON_STATE.IDLE
    ) {
      this.current.startReload();
    }
  }

  _handleInspect() {
    if (this.input.wasPressed('inspect') && !this.current.isBusy && this.ads.progress < 0.05) {
      if (this.viewModel.startInspect()) this.audio.play('weaponSwitch', { volume: 0.5 });
    }
  }

  // ------------------------------------------------------------------ fire
  _handleFiring(dt) {
    const w = this.current;
    const def = w.def;

    // --- trigger intent ---------------------------------------------------
    // A semi-auto press is a single-frame edge, so it is buffered: if it
    // lands while the weapon is still coming up out of the sprint pose the
    // click is remembered rather than swallowed.
    const triggerHeld = this.input.isMouseDown(MOUSE_LEFT);
    if (this.input.mouseWasPressed(MOUSE_LEFT)) this.fireBuffer = 0.3;
    else this.fireBuffer = Math.max(0, this.fireBuffer - dt);

    // Wanting to shoot (or aim) ends the sprint, so the weapon comes up.
    // `aimIntent` is the raw request from this frame, and it has to be here
    // rather than relying on ads.progress alone — progress cannot start rising
    // until the sprint has already been cancelled.
    this.player.sprintSuppressed =
      triggerHeld || this.fireBuffer > 0 || this.aimIntent || this.ads.progress > 0.02;

    // The weapon has to actually be shouldered before it can fire.
    const weaponStowed = this.viewModel.sprintBlend > 0.25;

    // --- burst continuation -----------------------------------------------
    if (w.burstRemaining > 0) {
      w.burstTimer -= dt;
      if (w.burstTimer <= 0 && w.canFire()) {
        this.fire();
        w.burstRemaining--;
        w.burstTimer = w.fireInterval;
        if (w.burstRemaining <= 0) w.cooldown = def.burstCooldown ?? 0.3;
      }
      return;
    }

    const wantFire = def.automatic ? triggerHeld : this.fireBuffer > 0;
    if (!wantFire) return;
    if (weaponStowed) return;   // still raising out of the sprint pose

    this.viewModel.cancelInspect();
    // The buffer exists only to bridge the sprint raise; once the weapon is
    // up, a semi-auto click is spent whether or not the shot lands.
    if (!def.automatic) this.fireBuffer = 0;

    // --- melee ------------------------------------------------------------
    if (def.melee) {
      if (w.canFire()) this._swingMelee();
      return;
    }

    // --- throwable --------------------------------------------------------
    if (def.throwable) {
      if (w.canFire() && w.magazine > 0) this._throwGrenade();
      else if (w.cooldown <= 0 && w.magazine <= 0 && w.reserve <= 0) {
        this.audio.play('dryFire');
        w.cooldown = 0.35;
      }
      return;
    }

    // --- dry fire ---------------------------------------------------------
    if (w.magazine <= 0) {
      if (w.cooldown <= 0) {
        this.audio.play('dryFire');
        w.cooldown = 0.25;
        if (w.canReload) w.startReload();
      }
      return;
    }

    if (w.state === WEAPON_STATE.RELOADING && def.reloadType !== 'shells') return;
    if (!w.canFire()) return;

    // --- burst start ------------------------------------------------------
    if (def.burstCount > 1) {
      this.fire();
      w.burstRemaining = def.burstCount - 1;
      w.burstTimer = w.fireInterval;
      return;
    }

    this.fire();
  }

  /** Fire one round (or one shell's worth of pellets). */
  fire() {
    const w = this.current;
    const def = w.def;
    const player = this.player;

    w.consumeShot();
    this.shotsFired++;

    // --- recoil -----------------------------------------------------------
    const shake = this.recoil.fire(def, {
      adsProgress: this.ads.progress,
      crouching: player.crouching,
      airborne: !player.grounded,
      moveSpeed01: clamp(player.speed01, 0, 1),
    });
    player.addShake(shake);

    // --- audio + world-space muzzle light ---------------------------------
    this.audio.play(def.fireSound, { volume: 1 });
    w.getMuzzleWorldPosition(this._muzzle);
    // Dimmed while aiming — at ADS the muzzle is inside the sight cone, so a
    // full-strength flash bloom would wash out the sight picture.
    const flashTame = 1 - this.ads.progress * 0.45;
    this.fx.pulseLight(
      this._muzzle, 0xffc070,
      8 * def.muzzleFlashScale * flashTame,
      11 * def.muzzleFlashScale, 0.05
    );

    // --- shell casing -----------------------------------------------------
    if (def.shellVelocity[1] > 0) {
      w.getEjectWorldPosition(this._tmp);
      this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const [sx, sy, sz] = def.shellVelocity;
      this._shellVel
        .set(0, 0, 0)
        .addScaledVector(this._right, sx * randRange(0.8, 1.2))
        .addScaledVector(this._up, sy * randRange(0.8, 1.2))
        .addScaledVector(this._dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion), sz)
        .add(player.velocity);
      this.fx.spawnShell(this._tmp, this._shellVel, this._groundYNear(this._tmp), def.category === 'shotgun' ? 1.5 : 1);
    }

    // --- aim --------------------------------------------------------------
    this.camera.getWorldPosition(this._origin);
    player.getAimDirection(this._dir);

    const spread = w.getSpread({
      moving: clamp(player.speed01, 0, 1),
      airborne: !player.grounded,
      crouching: player.crouching,
      adsSpreadMul: this.ads.spreadMultiplier(w),
    });

    // --- resolve -----------------------------------------------------------
    let anyHit = false;
    let anyHeadshot = false;
    let killed = false;
    let totalDamage = 0;
    let lastPoint = null;

    if (def.projectile) {
      this._spawnProjectile(this._origin, this._dir, spread, w);
    } else {
      for (let p = 0; p < (def.pellets ?? 1); p++) {
        const r = this._castBullet(this._origin, this._dir, spread, w, p === 0);
        if (r?.hitEnemy) {
          anyHit = true;
          totalDamage += r.damage;
          if (r.headshot) anyHeadshot = true;
          if (r.killed) killed = true;
          lastPoint = r.point;
        }
      }
      if (anyHit) this._registerHit(totalDamage, anyHeadshot, killed, lastPoint);
    }

    // Gunfire is loud — let the AI hear it.
    const loudness = def.category === 'sniper' ? 60
      : def.category === 'shotgun' || def.category === 'lmg' ? 45
      : def.category === 'pistol' ? 30 : 38;
    this.onShotFired?.(this._origin, loudness);
  }

  _registerHit(damage, headshot, killed, point) {
    this.shotsHit++;
    this.onHit?.({ damage, headshot, killed, point });
    this.audio.play(headshot ? 'hitmarkerHead' : 'hitmarker');
  }

  /**
   * Jitter a direction inside the spread cone using uniform disc sampling.
   */
  _applySpread(out, baseDir, spreadRad) {
    out.copy(baseDir);
    if (spreadRad <= 0.00001) return out;
    this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * Math.tan(spreadRad);
    return out
      .addScaledVector(this._right, Math.cos(a) * r)
      .addScaledVector(this._up, Math.sin(a) * r)
      .normalize();
  }

  /**
   * Cast one hitscan bullet, apply damage and spawn impact effects.
   * @returns {object|null}
   */
  _castBullet(origin, baseDir, spreadRad, weapon, isPrimaryPellet) {
    const def = weapon.def;
    this._applySpread(this._spreadDir, baseDir, spreadRad);

    const hit = this.physics.raycast(origin, this._spreadDir, def.range, {
      excludeCollider: this.player.collider,
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
    });

    // Other players are tested separately from the physics world and take
    // precedence when nearer, so a round cannot pass through someone standing
    // in front of a wall.
    const reach = hit ? hit.distance : def.range;
    const remote = this.remoteHitTest ? this.remoteHitTest(origin, this._spreadDir, reach) : null;

    // --- tracer ---
    this._end.copy(origin).addScaledVector(this._spreadDir, remote ? remote.distance : reach);
    if (isPrimaryPellet || (def.pellets ?? 1) <= 3 || Math.random() < 0.45) {
      this.fx.spawnTracer(this._muzzle, this._end, {
        color: def.tracerColor,
        width: def.tracerWidth,
        speed: def.tracerSpeed,
      });
    }

    if (remote) return this._resolveRemoteHit(remote, this._spreadDir, weapon);
    if (!hit) return null;
    return this._resolveImpact(hit, this._spreadDir, weapon, hit.distance);
  }

  /**
   * A hit on another player.
   *
   * Plays the local feedback — impact, blood, hit marker — and reports the
   * claim upstream. Deliberately does NOT compute or apply damage: the server
   * owns that, and the HIT message it sends back is what moves anyone's health.
   * Applying it here as well would double-count, and would let a tampered
   * client decide how hard it hits.
   */
  _resolveRemoteHit(remote, direction, weapon) {
    const def = weapon.def;
    const headshot = remote.part === 'head';

    this._tmp2.copy(direction).negate();
    this.fx.spawnImpact(remote.point, this._tmp2, SURFACE.FLESH, headshot ? 1.6 : 1);
    this.fx.spawnBloodBurst(remote.point, direction, headshot ? 1.5 : 1);
    this.audio.play(impactSoundFor(SURFACE.FLESH), { position: remote.point, volume: 0.8 });

    this.onRemoteHit?.({
      victimId: remote.id,
      part: remote.part,
      point: remote.point,
      distance: remote.distance,
      weaponId: def.id,
      headshot,
    });

    // `killed` stays false: only the server can confirm a kill and it announces
    // one over the wire. Guessing here would flash a phantom kill on screen.
    return {
      hitEnemy: true, remote: true, headshot, killed: false,
      damage: weapon.damageAtRange(remote.distance), point: remote.point,
    };
  }

  /** Shared impact handling for hitscan bullets and projectiles. */
  _resolveImpact(hit, direction, weapon, distance) {
    const def = weapon.def;
    const tag = hit.tag;
    const surface = tag?.surface ?? SURFACE.CONCRETE;

    // ---------------------------------------------------------- enemies
    if (tag?.kind === TAG_KIND.ENEMY && tag.enemy && tag.enemy.alive) {
      // The hit zone is derived from where on the body the round landed.
      const part = tag.enemy.partAtPoint(hit.point);
      const headshot = part === 'head';
      let damage = weapon.damageAtRange(distance);
      if (headshot) damage *= def.headMul;
      else if (part === 'limb') damage *= def.limbMul;

      const killed = tag.enemy.takeDamage(damage, {
        part,
        headshot,
        point: hit.point,
        direction,
        force: def.category === 'shotgun' ? 6 : def.category === 'sniper' ? 9 : 4,
        armorPen: def.armorPen ?? 0.4,
        source: 'player',
      });

      this.fx.spawnImpact(hit.point, hit.normal, SURFACE.FLESH, headshot ? 1.6 : 1);
      this.fx.spawnBloodBurst(hit.point, direction, headshot ? 1.5 : 1);
      this.audio.play(impactSoundFor(SURFACE.FLESH), { position: hit.point, volume: 0.8 });

      const behind = this.physics.raycast(hit.point, direction, 3.5, {
        excludeCollider: hit.collider,
        filter: (t) => !!t && (t.kind === TAG_KIND.WORLD || t.kind === TAG_KIND.PROP),
      });
      if (behind) this.fx.addDecal(behind.point, behind.normal, 'blood', randRange(0.3, 0.6));

      if (killed) this.onKill?.(tag.enemy, headshot);
      return { hitEnemy: true, damage, headshot, killed, point: hit.point };
    }

    // ------------------------------------------------- explosive barrels
    if (tag?.kind === TAG_KIND.EXPLOSIVE && tag.prop) {
      this.onPropHit?.(tag.prop, weapon.damageAtRange(distance), hit.point, direction);
      this.fx.spawnImpact(hit.point, hit.normal, SURFACE.METAL, 1);
      this.audio.play(impactSoundFor(SURFACE.METAL), { position: hit.point, volume: 0.75 });
      this._pushBody(hit, def, direction);
      return { hitEnemy: false };
    }

    // ------------------------------------------------------ pushable props
    if (tag?.kind === TAG_KIND.PROP) this._pushBody(hit, def, direction);

    // ------------------------------------------------------------- world
    this.fx.spawnImpact(hit.point, hit.normal, surface, 1);
    this.audio.play(impactSoundFor(surface), { position: hit.point, volume: 0.7 });
    if (surface !== SURFACE.GLASS && Math.random() < 0.22) {
      this.audio.play('ricochet', { position: hit.point, volume: 0.5 });
    }
    return { hitEnemy: false };
  }

  // ----------------------------------------------------------- projectiles
  _spawnProjectile(origin, baseDir, spreadRad, weapon) {
    const p = this.projectiles.find((x) => !x.alive);
    if (!p) {
      // Pool exhausted (extremely unlikely) — fall back to hitscan so the
      // shot is never silently lost.
      const r = this._castBullet(origin, baseDir, spreadRad, weapon, true);
      if (r?.hitEnemy) this._registerHit(r.damage, r.headshot, r.killed, r.point);
      return;
    }

    this._applySpread(this._spreadDir, baseDir, spreadRad);
    const proj = weapon.def.projectile;
    p.alive = true;
    p.pos.copy(origin).addScaledVector(this._spreadDir, 0.4);
    p.prev.copy(p.pos);
    p.vel.copy(this._spreadDir).multiplyScalar(proj.speed);
    p.gravity = proj.gravity;
    p.life = 0;
    p.travelled = 0;
    p.weaponId = weapon.id;
    p.tracerFrom = this._muzzle.clone();
  }

  _updateProjectiles(dt) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life += dt;
      p.prev.copy(p.pos);
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);

      this._tmp.subVectors(p.pos, p.prev);
      const step = this._tmp.length();
      p.travelled += step;
      if (step > 1e-5) {
        this._tmp.divideScalar(step);
        const hit = this.physics.raycast(p.prev, this._tmp, step, {
          excludeCollider: this.player.collider,
          filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
        });

        // Other players have to be tested separately, exactly as _castBullet
        // does — they are drawn by RemotePlayers and are NOT in the physics
        // world, so a physics raycast can never return one.
        //
        // Without this a projectile weapon simply cannot hit anybody in
        // multiplayer. The sniper is the only projectile weapon in the game,
        // which is why hit registration looked like it depended on who was
        // holding what: hitscan players landed shots, the sniper's rounds flew
        // straight through their target and carried on to the wall behind.
        const reach = hit ? hit.distance : step;
        const remote = this.remoteHitTest ? this.remoteHitTest(p.prev, this._tmp, reach) : null;

        if (remote) {
          const weapon = this.pool.get(p.weaponId);
          // Falloff uses the distance the round has actually flown, not the
          // length of this one step.
          const r = this._resolveRemoteHit(
            { ...remote, distance: p.travelled - step + remote.distance },
            this._tmp,
            weapon,
          );
          if (r?.hitEnemy) this._registerHit(r.damage, r.headshot, r.killed, r.point);
          this.fx.spawnTracer(p.tracerFrom ?? p.prev, remote.point, {
            color: weapon.def.tracerColor,
            width: weapon.def.tracerWidth,
            speed: weapon.def.tracerSpeed,
          });
          p.alive = false;
          continue;
        }

        if (hit) {
          const weapon = this.pool.get(p.weaponId);
          const r = this._resolveImpact(hit, this._tmp, weapon, p.travelled);
          if (r?.hitEnemy) this._registerHit(r.damage, r.headshot, r.killed, r.point);
          this.fx.spawnTracer(p.tracerFrom ?? p.prev, hit.point, {
            color: weapon.def.tracerColor,
            width: weapon.def.tracerWidth,
            speed: weapon.def.tracerSpeed,
          });
          p.alive = false;
          continue;
        }
      }

      // Draw the trail in segments so a long-range shot streaks properly.
      const weapon = this.pool.get(p.weaponId);
      this.fx.spawnTracer(p.tracerFrom ?? p.prev, p.pos, {
        color: weapon.def.tracerColor,
        width: weapon.def.tracerWidth,
        speed: 4000,
        trail: 14,
      });
      p.tracerFrom = null;

      if (p.life > 2.5 || p.travelled > weapon.def.range) p.alive = false;
    }
  }

  // -------------------------------------------------------------- grenades
  _throwGrenade() {
    const w = this.current;
    const def = w.def;
    w.consumeShot();
    this.audio.play(def.fireSound);
    this.viewModel.cancelInspect();

    this.camera.getWorldPosition(this._origin);
    this.player.getAimDirection(this._dir);
    this._tmp.copy(this._origin).addScaledVector(this._dir, 0.6);

    // Throw along the aim with a little lift, inheriting player momentum.
    this._tmp2.copy(this._dir).multiplyScalar(def.throwSpeed);
    this._tmp2.y += 2.2;
    this._tmp2.add(this.player.velocity);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 8),
      this.assets.getMaterial('enemyVest')
    );
    mesh.castShadow = true;
    this.fx.scene.add(mesh);

    const { body } = this.physics.createDynamicBox(
      this._tmp,
      { x: 0.07, y: 0.07, z: 0.07 },
      {
        mass: 0.45,
        friction: 0.7,
        restitution: 0.35,
        linearDamping: 0.12,
        angularDamping: 0.25,
        tag: { kind: TAG_KIND.PROP, surface: SURFACE.METAL, grenade: true },
        mesh,
      }
    );
    body.applyImpulse({ x: this._tmp2.x * 0.45, y: this._tmp2.y * 0.45, z: this._tmp2.z * 0.45 }, true);
    body.applyTorqueImpulse({ x: randRange(-0.05, 0.05), y: randRange(-0.05, 0.05), z: randRange(-0.05, 0.05) }, true);

    this.grenades.push({ body, mesh, fuse: def.fuseTime, def });

    // Out of grenades in the "magazine" — pull another from reserve.
    if (w.magazine <= 0 && w.reserve > 0) w.startReload();
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;

      const t = g.body.translation();
      this._tmp.set(t.x, t.y, t.z);
      this.onGrenadeExplode?.(this._tmp.clone(), g.def);

      this.physics.removeBody(g.body);
      this.fx.scene.remove(g.mesh);
      g.mesh.geometry.dispose();
      this.grenades.splice(i, 1);
    }
  }

  clearGrenades() {
    for (const g of this.grenades) {
      this.physics.removeBody(g.body);
      this.fx.scene.remove(g.mesh);
      g.mesh.geometry.dispose();
    }
    this.grenades.length = 0;
    for (const p of this.projectiles) p.alive = false;
  }

  // ----------------------------------------------------------------- melee
  _swingMelee() {
    const w = this.current;
    if (!w.startMelee()) return;
    this.audio.play(w.def.fireSound);
    w.cooldown = w.fireInterval;

    // Resolve the hit slightly into the swing, at the moment the blade lands.
    setTimeout(() => this._resolveMelee(w), (w.def.hitTime ?? 0.15) * 1000);
  }

  _resolveMelee(weapon) {
    if (!this.player.alive) return;
    const def = weapon.def;
    this.camera.getWorldPosition(this._origin);
    this.player.getAimDirection(this._dir);

    // A small fan of rays approximates a swept blade without a shapecast.
    const angles = [0, -0.14, 0.14, -0.26, 0.26];
    for (const a of angles) {
      this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._spreadDir.copy(this._dir).addScaledVector(this._right, Math.tan(a)).normalize();
      const hit = this.physics.raycast(this._origin, this._spreadDir, def.range, {
        excludeCollider: this.player.collider,
        filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
      });
      if (!hit) continue;

      if (hit.tag?.kind === TAG_KIND.ENEMY && hit.tag.enemy?.alive) {
        const enemy = hit.tag.enemy;
        const part = enemy.partAtPoint(hit.point);
        const headshot = part === 'head';
        // Backstab: are we behind them?
        this._tmp.set(-Math.sin(enemy.facing), 0, -Math.cos(enemy.facing));
        this._tmp2.subVectors(enemy.position, this._origin).setY(0).normalize();
        const behind = this._tmp.dot(this._tmp2) > 0.35;
        const damage = def.damage * (behind ? def.backstabMul : 1) * (headshot ? def.headMul : 1);

        const killed = enemy.takeDamage(damage, {
          part,
          headshot,
          point: hit.point,
          direction: this._spreadDir,
          force: 7,
          armorPen: def.armorPen,
          source: 'player',
        });
        this.fx.spawnBloodBurst(hit.point, this._spreadDir, 1.4);
        this.audio.play('knifeHit', { position: hit.point });
        this._registerHit(damage, headshot, killed, hit.point);
        if (killed) this.onKill?.(enemy, headshot);
        return;
      }

      if (hit.distance < def.range * 0.8) {
        this.fx.spawnImpact(hit.point, hit.normal, hit.tag?.surface ?? SURFACE.CONCRETE, 0.5);
        this.audio.play('knifeHitWall', { position: hit.point, volume: 0.6 });
        return;
      }
    }
  }

  // --------------------------------------------------------------- helpers
  /** Bullets carry momentum: nudge whatever dynamic body they hit. */
  _pushBody(hit, def, direction) {
    if (!hit.body || !hit.body.isDynamic?.()) return;
    const force = (def.category === 'shotgun' ? 0.55 : def.category === 'sniper' ? 2.2 : 0.9) * 30;
    this._impulse.x = direction.x * force;
    this._impulse.y = direction.y * force + 2.5;
    this._impulse.z = direction.z * force;
    this._point.x = hit.point.x;
    this._point.y = hit.point.y;
    this._point.z = hit.point.z;
    this.physics.applyImpulse(hit.body, this._impulse, this._point);
  }

  /** Approximate floor height under a point, for shell casing bounces. */
  _groundYNear(pos) {
    const hit = this.physics.raycast(pos, DOWN, 6, {
      excludeCollider: this.player.collider,
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER && tag.kind !== TAG_KIND.ENEMY,
    });
    return hit ? hit.point.y : 0;
  }

  /** 0..1 — how close the muzzle is to poking through geometry. */
  _wallProximity() {
    this.camera.getWorldPosition(this._origin);
    this.player.getAimDirection(this._dir);
    const probe = 1.1;
    const hit = this.physics.raycast(this._origin, this._dir, probe, {
      excludeCollider: this.player.collider,
      filter: (tag) =>
        !!tag &&
        (tag.kind === TAG_KIND.WORLD || tag.kind === TAG_KIND.PROP || tag.kind === TAG_KIND.EXPLOSIVE),
    });
    return hit ? clamp(1 - hit.distance / probe, 0, 1) : 0;
  }

  // ------------------------------------------------------------------ ammo
  /**
   * Give ammunition. Prioritises the current weapon, then spills over.
   * @returns {number} rounds actually added
   */
  addAmmo(fraction = 0.35) {
    let added = 0;
    const order = [this.current, ...this.slots.filter((w) => w !== this.current)];
    for (const w of order) {
      if (!Number.isFinite(w.def.maxReserve) || w.def.maxReserve <= 0) continue;
      added += w.addReserve(Math.ceil(w.def.maxReserve * fraction));
    }
    return added;
  }

  needsAmmo() {
    return this.slots.some(
      (w) => Number.isFinite(w.def.maxReserve) && w.def.maxReserve > 0 && w.reserve < w.def.maxReserve
    );
  }

  hudState() {
    const w = this.current;
    const spread = w.getSpread({
      moving: clamp(this.player.speed01, 0, 1),
      airborne: !this.player.grounded,
      crouching: this.player.crouching,
      adsSpreadMul: this.ads.spreadMultiplier(w),
    });
    return {
      name: w.name,
      short: w.def.short,
      category: w.def.category,
      magazine: Number.isFinite(w.def.magSize) ? w.magazine : '∞',
      magSize: w.def.magSize,
      reserve: w.def.maxReserve > 0 ? w.reserve : '—',
      mode: w.def.burstCount > 1 ? `BURST ${w.def.burstCount}` : w.def.automatic ? 'AUTO' : 'SEMI',
      reloading: w.state === WEAPON_STATE.RELOADING,
      reloadProgress: w.reloadProgress,
      needsReload: w.magazine === 0 && w.reserve > 0,
      slot: this.currentIndex,
      slots: this.slots.map((s) => ({
        short: s.def.short,
        empty: Number.isFinite(s.def.magSize) && s.magazine <= 0 && s.reserve <= 0,
      })),
      spread,
      ads: this.ads.progress,
      scope: this.ads.scopeProgress,
      zoom: this.ads.magnification(w),
      zoomSteps: this.ads.zoomSteps(w),
      breath: this.ads.breath,
      holdingBreath: this.ads.holding,
      accuracy: this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0,
    };
  }

  reset() {
    this.clearGrenades();
    this.applyLoadout(this.settings.get('loadoutPrimary'), this.settings.get('loadoutSecondary'));
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.fireBuffer = 0;
    this.player.sprintSuppressed = false;
    this.viewModel.reset();
  }

  dispose() {
    this.clearGrenades();
    for (const w of this.pool.values()) {
      this.viewModel.removeWeapon(w);
      w.dispose();
    }
    this.pool.clear();
    this.slots.length = 0;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

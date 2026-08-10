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
import { WEAPON_DEFS } from './WeaponDefinitions.js';
import { ADSSystem } from './ADSSystem.js';
import { RecoilSystem } from './RecoilSystem.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { SURFACE } from '../core/AssetManager.js';
import { impactSoundFor } from '../audio/AudioManager.js';
import { clamp, randRange } from '../core/MathUtils.js';

const MOUSE_LEFT = 0;

/**
 * How long one shot keeps you flagged as firing, for everyone else's benefit.
 *
 * Inputs go out at 30 Hz (LIMITS/INPUT_HZ) while this runs per frame, so a
 * flag raised for a single frame is dropped about half the time — a semi-auto
 * click would reach the other players only when it happened to land on a send.
 * 0.15 s clears that comfortably and is still shorter than the slowest
 * automatic's cycle, so it never runs a burst on past its last round.
 */
const FIRING_HOLD_SEC = 0.15;

/** Phases of a quick melee / quick grenade. See `_updateQuickUse`. */
const QUICK_IDLE = 0;
const QUICK_ARRIVING = 1;   // gadget is coming up; use it once it is ready
const QUICK_USING = 2;      // used; go back as soon as the action is finished

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
    /** Slot to go back to when a quick melee / quick grenade is done, or -1. */
    this.quickMeleeReturn = -1;
    /** QUICK_IDLE | QUICK_ARRIVING | QUICK_USING. See `_updateQuickUse`. */
    this._quickPhase = QUICK_IDLE;

    this.enabled = true;
    this.shotsFired = 0;
    this.shotsHit = 0;
    /** Seconds of remembered trigger press, used to bridge the sprint raise. */
    this.fireBuffer = 0;
    /**
     * Seconds left on "this player is shooting", for the wire. NOT `fireBuffer`.
     *
     * These two look interchangeable and are opposites. `fireBuffer` is an
     * INTENT that is deliberately spent the moment the shot goes out
     * (see `_handleFiring`), so reading it to answer "are they firing?" is
     * false for every semi-automatic in the game — which is why other players
     * were animated strolling along while shooting at you. This is set BY the
     * shot, and held long enough to survive the 30 Hz input throttle so a
     * single click still reaches the people watching.
     */
    this.firingFor = 0;
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
     * onShotResolved(claims, weaponId) reports ONE trigger pull to the server,
     * which decides the damage. Nothing here applies damage locally.
     *
     * It fires for every shot, including one that hit nothing — `claims` is
     * simply empty. That matters because the server relays gunfire to the rest
     * of the room off the back of this message: when it was only sent on a
     * hit, a missed shot produced no muzzle flash, no tracer and no report for
     * anyone else, so being shot at and missed was completely silent.
     */
    this.remoteHitTest = null;
    this.onShotResolved = null;
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

    // Decayed HERE rather than in `_handleFiring`, which only runs while alive
    // — otherwise dying mid-burst would leave the flag latched on for good.
    this.firingFor = Math.max(0, this.firingFor - dt);

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

    // Runs after the trigger so a quick melee cannot beat a real shot to the
    // frame, and only while alive — dying mid-swing must not swap a corpse's
    // weapon back and re-show a view model.
    if (alive) this._updateQuickUse();
    else if (this._quickPhase !== QUICK_IDLE) this._endQuickUse();

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

    /*
     * Quick melee / quick grenade: swap in, USE, swap back.
     *
     * Only the first third of that ever happened. `quickMeleeReturn` was
     * written here and read absolutely nowhere — three lines in the whole
     * repo, all of them writes — so V and G were exact duplicates of the 3 and
     * 4 keys: the knife came up, no swing played, and it stayed in your hands
     * until you pressed 1. `_updateQuickUse` below is the missing two thirds.
     */
    if (this.input.wasPressed('quickMelee') && this.currentIndex !== 2) {
      this.quickMeleeReturn = this.currentIndex;
      this._quickPhase = QUICK_ARRIVING;
      target = 2;
    } else if (this.input.wasPressed('quickGrenade') && this.currentIndex !== 3) {
      if (this.slots[3].magazine > 0 || this.slots[3].reserve > 0) {
        this.quickMeleeReturn = this.currentIndex;
        this._quickPhase = QUICK_ARRIVING;
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

  /**
   * Drive a quick melee / quick grenade through "use it, then give me my gun
   * back". Runs after firing, so a swing started this frame is already visible.
   *
   * Everything here is written to FAIL SAFE — the worst outcome of any guard
   * being wrong is that you keep holding the gadget, which is exactly what the
   * game did before, rather than a stuck slot or a lost weapon.
   */
  _updateQuickUse() {
    if (this._quickPhase === QUICK_IDLE) return;
    const w = this.current;
    const def = w?.def;

    // The player overruled us with a slot key, or a reset swapped the loadout.
    // Let go rather than yanking a gun out of their hands later.
    if (!def || (!def.melee && !def.throwable)) { this._endQuickUse(); return; }

    if (this._quickPhase === QUICK_ARRIVING) {
      // Wait out the raise. `switchTo` sets SWITCHING, and swinging through
      // that would play the animation from halfway up.
      if (w.state !== WEAPON_STATE.IDLE || !w.canFire()) return;
      if (def.melee) this._swingMelee();
      else if (w.magazine > 0) this._throwGrenade();
      else { this._endQuickUse(); return; }      // nothing left to throw
      this._quickPhase = QUICK_USING;
      return;
    }

    // QUICK_USING. A swing has to finish; a grenade has already left the hand
    // on the frame it was thrown, and any "pull another" reload it started is
    // cancelled cleanly by `onHolster`.
    if (w.state === WEAPON_STATE.MELEE) return;
    const back = this.quickMeleeReturn;
    this._endQuickUse();
    if (back >= 0 && back < this.slots.length) this.switchTo(back);
  }

  _endQuickUse() {
    this._quickPhase = QUICK_IDLE;
    this.quickMeleeReturn = -1;
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

  /**
   * Put a gadget in the player's hands, remembering the gun they had.
   *
   * `switchTo` cannot be reused for this and cannot be made to. It early-returns
   * on an unchanged index and it only ever indexes `slots`, and a gadget is in
   * neither — it lives in `pool` and nowhere else, which is exactly what keeps
   * it off the number keys, out of the wheel and out of the loadout browser.
   *
   * So both of these work against a POOL REFERENCE and deliberately leave
   * `currentIndex` alone. That is what makes `restoreWeapon` land back on the
   * weapon you were holding rather than on slot 0, and it is why they are five
   * lines each instead of a flag threaded through the switching logic.
   *
   * @returns {boolean} true if the swap actually happened
   */
  equipGadget(id) {
    const gadget = this.pool.get(id);
    if (!gadget || gadget === this.current) return false;
    this.current.onHolster();
    this.current = gadget;
    this.current.onEquip();
    this.ads.reset();
    this.recoil.resetPattern();
    this.viewModel.cancelInspect();
    this.audio.play('weaponSwitch');
    return true;
  }

  /**
   * Put the carried weapon back.
   *
   * Goes through `onHolster`/`onEquip` rather than assigning `current`, because
   * `onEquip` is what sets `switchProgress` to 0 — which is the raise animation.
   * Assigning it directly would have the gun simply appear, fully shouldered, in
   * the same frame the terminal vanished.
   *
   * @returns {boolean} true if a gadget was actually being held
   */
  restoreWeapon() {
    const back = this.slots[this.currentIndex];
    if (!back || back === this.current) return false;
    this.current.onHolster();
    this.current = back;
    this.current.onEquip();
    this.ads.reset();
    this.recoil.resetPattern();
    this.viewModel.cancelInspect();
    this.audio.play('weaponSwitch');
    return true;
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
    // Long enough that one click survives the input throttle, short enough
    // that letting go of an automatic drops the pose almost at once. Every
    // automatic in the game cycles faster than this, so a held trigger keeps
    // refreshing it and the shouldered pose holds for the whole burst.
    this.firingFor = FIRING_HOLD_SEC;

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
      /*
       * Report the shot NOW, with no hits.
       *
       * A projectile's hit is resolved frames later, in flight, and reports
       * itself separately. Leaving the trigger pull unreported meant the
       * sniper produced no muzzle flash, no tracer and no report for anyone
       * else until the round landed — and nothing at all if it missed. It is
       * the loudest weapon in the game and the one whose position most needs
       * giving away, and it was the only silent one.
       */
      this.onShotResolved?.([], def.id);
    } else {
      // One claim per trigger pull, however many pellets it throws — see the
      // note in _resolveRemoteHit. Always an array, even for a single-bullet
      // weapon: the batch is what gets reported at the end of the shot, and a
      // shot that hit nobody still has to be reported so the rest of the room
      // sees the muzzle flash.
      this._pelletBatch = [];

      for (let p = 0; p < (def.pellets ?? 1); p++) {
        const r = this._castBullet(this._origin, this._dir, spread, w, p === 0);
        if (r?.hitPlayer) {
          anyHit = true;
          totalDamage += r.damage;
          if (r.headshot) anyHeadshot = true;
          if (r.killed) killed = true;
          lastPoint = r.point;
        }
      }

      // Send the whole spread as one claim, then stop batching. Reported even
      // when empty — a miss is a shot the room still needs to see and hear.
      const batch = this._pelletBatch;
      this._pelletBatch = null;
      this.onShotResolved?.(batch, def.id);

      if (anyHit) this._registerHit(totalDamage, anyHeadshot, killed, lastPoint);
    }

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

    const claim = {
      victimId: remote.id,
      part: remote.part,
      point: remote.point,
      distance: remote.distance,
      weaponId: def.id,
      headshot,
    };
    /*
     * Pellets are BATCHED, not reported one at a time.
     *
     * Each report is a separate message to the server, and the server's
     * fire-rate limiter charges one token per message. A nine-pellet shotgun
     * blast therefore spent nine tokens against a five-token budget: most of
     * the pellets were discarded, and the ones that were not drained the
     * bucket so the NEXT shot was thrown away too. The gun read as doing
     * roughly half its damage and then misfiring.
     *
     * Collected here and sent as one claim per trigger pull, which is also
     * what the server already expects — it accepts several hits in a message
     * for pellet weapons specifically.
     */
    /*
     * Inside a trigger pull, collect. Outside one, report immediately.
     *
     * A sniper round resolves frames after the trigger was pulled — the batch
     * for that shot is long closed — and a knife swing resolves outside the
     * hitscan path entirely. Pushing those into a batch that nothing will ever
     * send is how a hit silently does nothing, which is exactly the fault that
     * made projectile weapons and the knife useless in multiplayer once
     * before.
     */
    if (this._pelletBatch) this._pelletBatch.push(claim);
    else this.onShotResolved?.([claim], def.id);

    // `killed` stays false: only the server can confirm a kill and it announces
    // one over the wire. Guessing here would flash a phantom kill on screen.
    return {
      hitPlayer: true, remote: true, headshot, killed: false,
      damage: weapon.damageAtRange(remote.distance), point: remote.point,
    };
  }

  /** Shared impact handling for hitscan bullets and projectiles. */
  _resolveImpact(hit, direction, weapon, distance) {
    const def = weapon.def;
    const tag = hit.tag;
    const surface = tag?.surface ?? SURFACE.CONCRETE;

    // ------------------------------------------------- explosive barrels
    if (tag?.kind === TAG_KIND.EXPLOSIVE && tag.prop) {
      this.onPropHit?.(tag.prop, weapon.damageAtRange(distance), hit.point, direction);
      this.fx.spawnImpact(hit.point, hit.normal, SURFACE.METAL, 1, tag?.prop?.body ?? null);
      this.audio.play(impactSoundFor(SURFACE.METAL), { position: hit.point, volume: 0.75 });
      this._pushBody(hit, def, direction);
      return { hitPlayer: false };
    }

    // ------------------------------------------------------ pushable props
    if (tag?.kind === TAG_KIND.PROP) this._pushBody(hit, def, direction);

    // ------------------------------------------------------------- world
    this.fx.spawnImpact(hit.point, hit.normal, surface, 1, tag?.prop?.body ?? null);
    this.audio.play(impactSoundFor(surface), { position: hit.point, volume: 0.7 });
    if (surface !== SURFACE.GLASS && Math.random() < 0.22) {
      this.audio.play('ricochet', { position: hit.point, volume: 0.5 });
    }
    return { hitPlayer: false };
  }

  // ----------------------------------------------------------- projectiles
  _spawnProjectile(origin, baseDir, spreadRad, weapon) {
    const p = this.projectiles.find((x) => !x.alive);
    if (!p) {
      // Pool exhausted (extremely unlikely) — fall back to hitscan so the
      // shot is never silently lost.
      const r = this._castBullet(origin, baseDir, spreadRad, weapon, true);
      if (r?.hitPlayer) this._registerHit(r.damage, r.headshot, r.killed, r.point);
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
          if (r?.hitPlayer) this._registerHit(r.damage, r.headshot, r.killed, r.point);
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
          if (r?.hitPlayer) this._registerHit(r.damage, r.headshot, r.killed, r.point);
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

    /*
     * The thrown grenade is the AUTHORED model, not a sphere.
     *
     * The frag you hold is `grenade.glb` — the one built in Blender — but the
     * one that left your hand was a twelve-segment sphere with a dark
     * material on it. Two different objects for the same grenade, and the
     * moment it mattered (watching it bounce into a room) you saw the wrong
     * one. The sphere stays as a fallback for a missing or failed model,
     * which is how every other asset here degrades.
     */
    const mesh = this._buildThrownGrenade();
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

  /**
   * The mesh for a grenade in flight.
   *
   * Cloned from the authored model so the thing bouncing across the floor is
   * the same object you were holding. Object3D.clone() shares geometry AND
   * materials with the source, so each throw costs a handful of Object3Ds and
   * no GPU memory — and, because the materials are shared, no shader compile.
   *
   * Scaled to the physics body rather than trusted: the view model is authored
   * at whatever size reads well in first person, which is not necessarily the
   * 14 cm the collider is.
   */
  _buildThrownGrenade() {
    const DIAMETER = 0.14;                       // matches the 0.07 half-extent
    const source = this.assets.getModel?.('grenade');

    if (source) {
      const model = source.clone(true);
      model.traverse((o) => {
        if (!o.isMesh) return;
        // The source is a view model on the weapon layer, which the world
        // camera cannot see. A grenade in the air is world geometry.
        o.layers.set(0);
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = true;
      });
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const largest = Math.max(size.x, size.y, size.z);
      if (largest > 1e-4) model.scale.multiplyScalar(DIAMETER / largest);

      // Centre it on its own bounds so it spins about its middle rather than
      // about whatever origin the model was authored around.
      const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(DIAMETER / (largest || 1));
      model.position.sub(centre);

      const holder = new THREE.Group();
      holder.add(model);
      return holder;
    }

    // No model loaded — the same progressive-enhancement fallback every other
    // asset here uses.
    const fallback = new THREE.Mesh(
      new THREE.SphereGeometry(DIAMETER / 2, 12, 8),
      this.assets.getMaterial('darkGear'),
    );
    fallback.userData.ownsGeometry = true;
    return fallback;
  }


  /**
   * Free a thrown grenade's mesh.
   *
   * ONLY the fallback sphere owns its geometry. A cloned model shares both
   * geometry and materials with the source in AssetManager — disposing those
   * would blank out the grenade in your hands and every one thrown after it,
   * and a Group has no `.geometry` to dispose in the first place.
   */
  _disposeGrenadeMesh(mesh) {
    if (mesh?.userData?.ownsGeometry) mesh.geometry?.dispose();
  }
  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;

      const t = g.body.translation();
      this._tmp.set(t.x, t.y, t.z);

      /*
       * Take the grenade OUT of the world before it goes off.
       *
       * The blast does a line-of-sight test from its own centre, and the
       * grenade's collider was still there to be hit — at distance zero, by a
       * ray starting inside it. So a frag at your feet reported no line of
       * sight to you and did nothing at all: the one weapon that could not
       * hurt the person holding it.
       */
      this.physics.removeBody(g.body);

      this.onGrenadeExplode?.(this._tmp.clone(), g.def);
      this.fx.scene.remove(g.mesh);
      this._disposeGrenadeMesh(g.mesh);
      this.grenades.splice(i, 1);
    }
  }

  clearGrenades() {
    for (const g of this.grenades) {
      this.physics.removeBody(g.body);
      this.fx.scene.remove(g.mesh);
      this._disposeGrenadeMesh(g.mesh);
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

      /*
       * Other players are tested separately, because they are drawn by
       * RemotePlayers and are NOT in the physics world — a physics raycast can
       * never return one.
       *
       * Without this the knife could not touch another player at all: every
       * ray in the fan found either level geometry or nothing, so a melee
       * swing in multiplayer was guaranteed to do nothing. Same omission that
       * made projectile weapons pass straight through people.
       */
      const reach = hit ? hit.distance : def.range;
      const remote = this.remoteHitTest
        ? this.remoteHitTest(this._origin, this._spreadDir, reach)
        : null;

      if (remote) {
        const r = this._resolveRemoteHit(remote, this._spreadDir, weapon);
        // Same reasoning as the impact branch above: a blade on a chassis is
        // the wall sound, not the flesh one.
        this.audio.play('knifeHit',
          { position: remote.point });
        if (r?.hitPlayer) this._registerHit(r.damage, r.headshot, r.killed, r.point);
        return;
      }

      if (!hit) continue;

      if (hit.distance < def.range * 0.8) {
        this.fx.spawnImpact(hit.point, hit.normal, hit.tag?.surface ?? SURFACE.CONCRETE, 0.5,
          hit.tag?.prop?.body ?? null);
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
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
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

  /**
   * The two things the OTHER players need to know about our weapon.
   *
   * Both exist so `Game._playerFlags` never has to reach into a Weapon's
   * internals to pack the wire. It used to, and it read the wrong field —
   * see `firingFor`.
   */
  /** Are we shooting, as an onlooker would judge it? */
  get firingNow() { return this.firingFor > 0; }

  /** Are we reloading? Held across every phase of a shell-by-shell reload. */
  get reloading() { return this.current?.state === WEAPON_STATE.RELOADING; }

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
    this.firingFor = 0;
    // Or a quick-melee interrupted by a map change would try to put you back
    // into a slot from the loadout you were carrying before it.
    this._endQuickUse();
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

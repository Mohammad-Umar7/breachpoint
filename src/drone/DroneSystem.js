/**
 * DroneSystem — the mode switch, and the one seam the drone has into the game.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Deploying a drone takes the player's hands, their feet, their mouse and their
 * weapon away and gives them back afterwards. That is nine borrowed switches
 * across five different subsystems, and every one of them is a latch: set it and
 * fail to clear it and the player spends the rest of the round unable to sprint,
 * unable to lean, or unable to shoot, with nothing thrown and nothing logged.
 *
 * So exactly ONE file in `src/drone/` is allowed to touch `weapons`, `player`,
 * `input`, `ads` or `lean`, and this is it. Everything else in the feature —
 * the collider, the camera, the chassis, the feed, the panel — knows nothing
 * about the rest of the game and could be deleted without leaving a switch
 * behind. That is what makes the drone a subsystem rather than a mode.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * -----------------------------------
 * `viewModel.holder.visible`. Two places already write it — the respawn path
 * and the death path in `wireNetwork.js` — and a third writer means whichever
 * runs last each frame wins, which is a flicker rather than a bug anyone can
 * find. This class
 * is not even GIVEN the view model, so writing it is not something a later edit
 * here can do by accident. The terminal appears and disappears through
 * `equipGadget`/`restoreWeapon`, which go through `onHolster`/`onEquip` like
 * every other weapon swap in the game.
 *
 * WHAT IS NOT HERE YET
 * --------------------
 * The live feed (`DroneFeed`), the panel it is drawn on (`DroneScreen`) and the
 * chassis everybody else sees (`DroneObjects`) are separate files that land
 * after this one. This class deliberately does not import them, so that it
 * remains the only place the borrowed switches live and the drawing code cannot
 * quietly start reaching for them.
 */

import { DRONE, DRONE_CMD, DRONE_EVENT, INPUT_HZ } from '../net/protocol.js';
import { getMap } from '../world/maps/index.js';
import { DroneActor } from './DroneActor.js';

/** The weapon id of the handset. Must match the entry in `WEAPON_DEFS`. */
const GADGET_ID = 'dronectl';

/**
 * STOWED -> DEPLOYING -> PILOTING -> STOWING -> STOWED.
 *
 * DEPLOYING and STOWING are not decoration. DEPLOYING is the animation the
 * deploy round trip hides inside, which is what lets a drone's EXISTENCE be a
 * server event rather than a prediction two players can disagree about; STOWING
 * is the tail of putting the handset away, so the weapon comes back up while the
 * player is still watching rather than after they have already been given the
 * controls back.
 */
export const DRONE_MODE = Object.freeze({
  STOWED: 'stowed',
  DEPLOYING: 'deploying',
  PILOTING: 'piloting',
  STOWING: 'stowing',
});

/** Largest frame delta this will integrate — an alt-tabbed tab, otherwise. */
const MAX_DT = 0.25;

export class DroneSystem {
  /**
   * Every collaborator is injected rather than reached for, because the whole
   * value of this file is that the list of things it can touch is short enough
   * to read in one go. `test/drone-mode.mjs` passes recording stubs for all of
   * them and asserts on the writes.
   *
   * @param {object} deps
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} deps.physics
   * @param {import('../player/Player.js').Player} deps.player
   * @param {import('../weapons/WeaponSystem.js').WeaponSystem} deps.weapons
   * @param {import('../weapons/ADSSystem.js').ADSSystem} deps.ads
   * @param {import('../player/LeanSystem.js').LeanSystem} deps.lean
   * @param {import('../core/InputManager.js').InputManager} deps.input
   * @param {import('../net/NetworkClient.js').NetworkClient} deps.net
   * @param {import('../ui/MenuManager.js').MenuManager} [deps.menus]
   */
  constructor({ physics, player, weapons, ads, lean, input, net, menus }) {
    this.physics = physics;
    this.player = player;
    this.weapons = weapons;
    this.ads = ads;
    this.lean = lean;
    this.input = input;
    this.net = net;
    this.menus = menus ?? null;

    this.state = DRONE_MODE.STOWED;
    /** Seconds left of the DEPLOYING or STOWING animation. */
    this.timer = 0;

    /**
     * Whether the CURRENT map has a drone on it at all.
     *
     * False until a map says otherwise, so the key does nothing on every map
     * that has not opted in — including before the first `onMapChanged`.
     */
    this.available = false;

    /** @type {DroneActor|null} the pilot's local simulation, while one exists. */
    this.actor = null;

    /** The server has told us a drone of ours is in the room. */
    this._deployed = false;
    /**
     * What we last TOLD the server about looking through it.
     *
     * Named apart from the `piloting` getter on purpose: that one is the mode
     * this class is in, this one is the last thing the server was told, and the
     * two are deliberately allowed to differ for the frames in between.
     */
    this._pilotSent = false;
    /** When the last drive report went out — reports are throttled to INPUT_HZ. */
    this._lastDriveAt = 0;

    // --- HUD mirrors. The server owns all three; these are only for drawing.
    this.hp = DRONE.maxHealth;
    this.batteryMs = DRONE.batteryMs;
    this.cooldownUntil = 0;
    /** Why the last drone stopped existing — DRONE_EVENT, or null. */
    this.lastLoss = null;

    /*
     * Chain onto the loadout hook rather than replacing it.
     *
     * `applyLoadout` rebuilds `slots` and force-equips slot 0, so a loadout
     * change while the handset is out would leave `current` pointing at a rifle
     * with the terminal still counted as held — and `restoreWeapon` would then
     * put back a weapon that is no longer in the loadout. Force-stowing FIRST
     * makes the swap happen from a normal state.
     *
     * Game assigns this hook in `_bindUi`, long before this class is built, so
     * the previous handler is captured and called. Overwriting it would have
     * silently stopped loadout changes applying at all, which is a far worse
     * bug than the one this is preventing.
     */
    if (this.menus) {
      this._previousLoadoutHook = this.menus.onLoadoutChanged;
      this.menus.onLoadoutChanged = (...args) => {
        this.onLoadoutChanged();
        this._previousLoadoutHook?.(...args);
      };
    }
  }

  /** True only while the player is actually looking through the drone. */
  get piloting() { return this.state === DRONE_MODE.PILOTING; }

  // ================================================================== input
  /**
   * Read the drone key and the sticks.
   *
   * MUST run before `Player.updateLook`. That function drains the accumulated
   * mouse delta whether or not it is enabled to use it, and the same is true of
   * every other consume-and-clear on the input manager — anything reading after
   * it gets zeroes with no error anywhere.
   */
  updateInput() {
    if (this.input.wasPressed('drone')) {
      if (this.state === DRONE_MODE.STOWED) this.deploy();
      else if (this.state !== DRONE_MODE.STOWING) this.recall();
    }

    if (!this.actor?.active) return;

    /*
     * Tank drive: throttle along the chassis' own nose, steering as a yaw rate.
     *
     * Keys, not the mouse, and that is forced rather than chosen: the entry
     * sequence sets `input.enabled = false`, and `InputManager._onMouseMove`
     * drops every delta while that is false, so there is no mouse motion to
     * read. Steering as a RATE is also the right model for a tracked robot —
     * `DRONE.turnRate` is radians per second — where a mouse would give an
     * angle.
     *
     * Positive steer is LEFT, matching `stepDroneMotion`, which matches the
     * player's own yaw convention. Getting this backwards produces a drone that
     * drives perfectly and turns the wrong way, which reads as inverted
     * controls rather than as a sign error.
     */
    const { piloting } = this;
    this.actor.input.throttle = piloting
      ? (this.input.isDown('forward') ? 1 : 0) - (this.input.isDown('back') ? 1 : 0)
      : 0;
    this.actor.input.steer = piloting
      ? (this.input.isDown('left') ? 1 : 0) - (this.input.isDown('right') ? 1 : 0)
      : 0;

    /*
     * Drain the wheel, every piloting frame, and throw it away.
     *
     * Normally `WeaponSystem` drains it — either to cycle weapons or to change
     * a scope's zoom — and it is switched off. `wheelDelta` only ever
     * accumulates, so an undrained wheel would sit there for the whole flight
     * and be spent the instant the weapon system came back: the player lands
     * their drone and their gun changes on its own.
     */
    if (piloting) this.input.consumeWheel();
  }

  // ============================================================ fixed update
  /**
   * Runs inside BOTH of Game's `physics.step` closures — the playing one and
   * the game-over one. A drone whose owner has just died must keep simulating,
   * or it freezes mid-floor while the server goes on moving it for everybody
   * else until the despawn lands.
   */
  fixedUpdate(dt) {
    if (this.actor?.active) this.actor.fixedUpdate(dt);
  }

  // ========================================================== render update
  /**
   * @param {number} dt    frame delta
   * @param {number} alpha physics interpolation factor 0..1
   */
  update(dt, alpha) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, MAX_DT)) : 0;

    if (this.state === DRONE_MODE.DEPLOYING) {
      this.timer -= step;
      // BOTH conditions. The animation finishing early would put the player
      // behind a camera that does not exist yet; the drone arriving early would
      // cut the animation the round trip is hiding inside.
      if (this._deployed && this.timer <= 0) this._beginPiloting();
    } else if (this.state === DRONE_MODE.STOWING) {
      this.timer -= step;
      if (this.timer <= 0) {
        this._exit();
        this.state = DRONE_MODE.STOWED;
      }
    }

    if (!this.actor?.active) return;
    this.actor.update(step, alpha);

    /*
     * `faulted` is a latch the actor sets when a step could not be trusted — a
     * non-finite pose out of the integrator or the character controller. It
     * stops moving itself and it is THIS class's job to notice, because a
     * halted drone with no explanation is a bug report and a recalled one is a
     * player pressing the key again.
     */
    if (this.actor.faulted) {
      this.recall();
      return;
    }

    this._reportDrive();
  }

  /**
   * Tell the server where we have driven it, at the same rate we report our own
   * body — and unconditionally while a drone exists, piloting or not.
   *
   * Not an optimisation to skip: `DRONE.staleMs` despawns a drone whose owner
   * has gone quiet, and the drive report is the only thing that resets that
   * clock. A parked drone that stopped reporting would be deleted three seconds
   * later, and the pilot would have no idea why.
   */
  _reportDrive() {
    const now = performance.now();
    if (now - this._lastDriveAt < 1000 / INPUT_HZ) return;
    this._lastDriveAt = now;
    this.net?.sendDroneDrive({ position: this.actor.position, yaw: this.actor.yaw });
  }

  // ============================================================== the switch
  /**
   * Ask for a drone and take the handset out.
   *
   * The request carries NO position — see `DRONE_CMD.DEPLOY`. The borrowed
   * switches are taken NOW rather than when the drone arrives, because the
   * ~0.9 s pull-it-out-of-your-pocket animation is exactly what the round trip
   * hides inside, and a player who could still run and shoot during it would be
   * getting the animation for free.
   *
   * @returns {boolean} true if a request actually went out
   */
  deploy() {
    if (this.state !== DRONE_MODE.STOWED) return false;
    if (!this.available) return false;
    if (!this.net?.connected) return false;
    if (!this.player.alive) return false;

    this._enter();
    this.state = DRONE_MODE.DEPLOYING;
    this.timer = DRONE.deployMs / 1000;
    this._deployed = false;
    this.lastLoss = null;
    this.net.sendDroneCmd(DRONE_CMD.DEPLOY);
    return true;
  }

  /**
   * Tell the server whether we are looking through the drone.
   *
   * Its own call rather than a line inside the transitions because the server
   * treats it as its own fact: the battery measures time UNDER POWER, and
   * `handleShot` refuses a shot from a player whose `piloting` is set. Both of
   * those are about where the operator's attention is, not about whether a
   * chassis exists.
   *
   * @returns {boolean} true if a message actually went out
   */
  pilot(on) {
    const want = !!on;
    if (want === this._pilotSent) return false;
    /*
     * Never claim to be piloting a drone the server has not confirmed, and
     * never un-claim one it has already despawned: `despawnDrone` clears
     * `piloting` itself, and a PILOT with no drone out is refused privately
     * with a reason the player never asked for, which surfaces as a warning
     * banner for something they did not do.
     */
    if (!this._deployed) return false;
    this._pilotSent = want;
    this.net?.sendDroneCmd(DRONE_CMD.PILOT, { on: want ? 1 : 0 });
    return true;
  }

  /**
   * Bring it home deliberately. Starts the stow animation; the controls come
   * back when that finishes.
   *
   * @returns {boolean} true if there was something to recall
   */
  recall() {
    if (this.state !== DRONE_MODE.DEPLOYING && this.state !== DRONE_MODE.PILOTING) return false;
    this.pilot(false);
    /*
     * Sent even while DEPLOYING, when the server may not have spawned one yet.
     * `despawnDrone` returns false and says nothing at all when there is no
     * drone, so a recall that crosses a deploy in flight is a silent no-op
     * rather than a denial — and if the deploy did land first, this is what
     * takes it away again.
     */
    this.net?.sendDroneCmd(DRONE_CMD.RECALL);
    this._releaseDrone();
    this.state = DRONE_MODE.STOWING;
    this.timer = DRONE.stowMs / 1000;
    return true;
  }

  /**
   * Put everything back, right now, from any state.
   *
   * The panic exit: a map switch, a world reset, leaving the match, or dying.
   * No animation, because in every one of those cases the frame after this one
   * is already showing something else. Idempotent — calling it from STOWED
   * writes nothing at all, which matters because it is called from four
   * different places that can easily overlap.
   *
   * @returns {boolean} true if there was anything to undo
   */
  abort() {
    if (this.state === DRONE_MODE.STOWED) return false;
    this.pilot(false);
    this.net?.sendDroneCmd(DRONE_CMD.RECALL);
    this._releaseDrone();
    this._exit();
    this.state = DRONE_MODE.STOWED;
    this.timer = 0;
    return true;
  }

  // ------------------------------------------------------------- transitions
  _beginPiloting() {
    this.state = DRONE_MODE.PILOTING;
    this.timer = 0;
    this.pilot(true);
  }

  /**
   * Take the controls, in this order.
   *
   * `input.clearAll()` FIRST, so nothing held at the moment of pressing the key
   * — a held trigger, a held W — is still latched down when the systems that
   * read it come back.
   *
   * `player.sprintSuppressed = false` on this edge as well as the other one,
   * because it is only ever written inside `WeaponSystem._handleFiring`, and
   * that is skipped entirely once `weapons.enabled` is false. Deploying with
   * the trigger held would otherwise latch it true for the rest of the life:
   * the player lands their drone and can never sprint again, with nothing to
   * point at.
   */
  _enter() {
    this.input.clearAll();
    this.player.sprintSuppressed = false;
    this.weapons.enabled = false;
    this.ads.enabled = false;
    this.lean.enabled = false;
    this.player.enabled = false;
    this.input.enabled = false;
    this.weapons.equipGadget(GADGET_ID);
  }

  /**
   * Give them back, in this order, and the order is load-bearing.
   *
   * `input.clearAll()` first, so a direction held while driving does not become
   * a step the moment the body starts listening again.
   *
   * `weapons.restoreWeapon()` while the weapon system is still DISABLED, so the
   * raise animation `onEquip` starts is already running on the first frame that
   * is allowed to draw it — put back afterwards and the first frame shows the
   * gun fully shouldered before it drops to be raised.
   *
   * `sprintSuppressed` cleared before `player.enabled`, so the first frame the
   * player moves in sees a clean sprint state rather than a stale latch.
   *
   * `input.enabled` last of all, so nothing above it acts on input from a frame
   * in which the controls were still borrowed.
   */
  _exit() {
    this.input.clearAll();
    this.weapons.restoreWeapon();
    this.weapons.enabled = true;
    this.ads.enabled = true;
    this.lean.enabled = true;
    this.player.sprintSuppressed = false;
    this.player.enabled = true;
    this.input.enabled = true;
  }

  /** Tear the local simulation down. Never leaves a collider behind. */
  _releaseDrone() {
    this._deployed = false;
    this._pilotSent = false;
    this.actor?.destroy();
    this.actor = null;
  }

  // ================================================================= server
  /**
   * One `MSG.DRONESTATE`, already decoded by `NetworkClient`.
   *
   * A method rather than an `onDroneState` hook on purpose: a hook declared
   * here and fired from here with nothing assigning it is exactly the dangling
   * wiring `test/contracts.mjs` exists to catch. `wireNetwork.js` calls this.
   *
   * @param {{isSelfOwner:boolean, event:number, hp:number|null,
   *          battery:number|null, position:number[]|null, yaw:number|null}} s
   */
  onServerEvent(s) {
    // Somebody else's drone. HIT in particular is private to the ATTACKER, so
    // shooting a stranger's robot arrives here with their id on it.
    if (!s?.isSelfOwner) return;

    if (typeof s.hp === 'number') this.hp = s.hp;
    if (typeof s.battery === 'number') this.batteryMs = s.battery;

    switch (s.event) {
      case DRONE_EVENT.DEPLOYED:
        this._onDeployed(s);
        break;

      case DRONE_EVENT.CORRECT:
        // A refused drive report, answered with the truth. Taking it is the
        // only correct response — dropping it leaves this machine simulating
        // forward from a pose the server never accepted.
        if (s.position) {
          this.actor?.snapTo(s.position[0], s.position[1], s.position[2], s.yaw ?? undefined);
        }
        break;

      case DRONE_EVENT.DESTROYED:
      case DRONE_EVENT.RECALLED:
      case DRONE_EVENT.LOST:
      case DRONE_EVENT.EXPIRED:
        this._onDroneGone(s.event);
        break;

      case DRONE_EVENT.DENIED:
        // The refusal itself is shown by wireNetwork, which shows every DENIED
        // the same way. What has to happen HERE is putting the controls back:
        // the handset came out the instant the key was pressed, and without
        // this the player would be stood frozen holding a terminal that is
        // never going to show anything.
        if (this.state === DRONE_MODE.DEPLOYING) this.abort();
        break;

      default:
        break;
    }
  }

  _onDeployed(s) {
    this._deployed = true;
    this.hp = typeof s.hp === 'number' ? s.hp : DRONE.maxHealth;
    this.batteryMs = typeof s.battery === 'number' ? s.battery : DRONE.batteryMs;

    /*
     * A drone that arrives while we are no longer asking for one — the tail of
     * a deploy that crossed a cancel in flight — is taken back off the map
     * before it is ever given a collider. Checked BEFORE the actor is built,
     * because a body created and destroyed in the same frame is still a body
     * that went into the broad phase.
     */
    if (this.state !== DRONE_MODE.DEPLOYING) {
      this.net?.sendDroneCmd(DRONE_CMD.RECALL);
      this._releaseDrone();
      return;
    }

    const p = s.position;
    /*
     * No physics world, or a pose that is not three finite numbers, and we do
     * not guess. `createCharacterBody` asserts finiteness and throws, and this
     * number came off a socket rather than out of a level file — the one place
     * in the game where that is true. A drone we cannot place is one we recall:
     * that costs one player one gadget, where a poisoned collider costs
     * everybody in the room every raycast on the map.
     */
    if (!this.physics || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) {
      this.recall();
      return;
    }

    if (!this.actor) this.actor = new DroneActor(this.physics);
    this.actor.spawn({ x: p[0], y: p[1], z: p[2] }, Number.isFinite(s.yaw) ? s.yaw : 0);
  }

  /**
   * The server has taken it off the map, for any of the four reasons.
   *
   * Never predicted and never argued with: membership of the snapshot's `d`
   * array is the only thing that decides a drone exists, and this is the event
   * that says the row has gone.
   */
  _onDroneGone(event) {
    this.lastLoss = event;
    this._releaseDrone();
    // Mirrored locally for the HUD only. The server owns the real deadline and
    // will refuse an early redeploy with the time remaining, so a mirror that
    // has drifted is corrected the moment it matters.
    this.cooldownUntil = performance.now() + DRONE.redeployCooldownMs;

    if (this.state === DRONE_MODE.PILOTING || this.state === DRONE_MODE.DEPLOYING) {
      this.state = DRONE_MODE.STOWING;
      this.timer = DRONE.stowMs / 1000;
    }
  }

  // ================================================================== gating
  /**
   * The MAP decides whether the feature exists here.
   *
   * Read off the map definition rather than compared against an id, so adding a
   * second drone map is one field on that map and nothing else. `getMap` never
   * throws and falls back to the default for an unknown id, and a map that has
   * never heard of drones simply has no `drone` field — `undefined === true` is
   * false, which is the answer we want.
   */
  onMapChanged(mapId) {
    this.available = getMap(mapId)?.drone === true;
    if (!this.available) this.abort();
  }

  /**
   * The loadout changed. Called by the hook this class chained in its
   * constructor, and safe to call directly.
   */
  onLoadoutChanged() {
    this.abort();
  }

  // ===================================================================== HUD
  hudState() {
    const now = performance.now();
    return {
      available: this.available,
      mode: this.state,
      piloting: this.piloting,
      /** 0..1 through whichever animation is running, 0 when none is. */
      transition: this.timer > 0 ? 1 - this.timer / this._animationLength() : 0,
      deployed: this._deployed,
      hp: this.hp,
      maxHp: DRONE.maxHealth,
      battery: Math.max(0, Math.min(1, this.batteryMs / DRONE.batteryMs)),
      cooldownMs: Math.max(0, this.cooldownUntil - now),
      lastLoss: this.lastLoss,
    };
  }

  _animationLength() {
    if (this.state === DRONE_MODE.DEPLOYING) return DRONE.deployMs / 1000;
    if (this.state === DRONE_MODE.STOWING) return DRONE.stowMs / 1000;
    return 1;
  }

  // ================================================================ teardown
  dispose() {
    this.abort();
    // Hand the loadout hook back exactly as it was found. Left in place, it
    // would go on calling `abort()` on a disposed system for the life of the
    // page — and on the next Game, whose drone system is a different object.
    if (this.menus && this._previousLoadoutHook !== undefined) {
      this.menus.onLoadoutChanged = this._previousLoadoutHook;
      this._previousLoadoutHook = undefined;
    }
    this.actor?.destroy();
    this.actor = null;
  }
}

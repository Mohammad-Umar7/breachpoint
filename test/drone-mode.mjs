/**
 * The drone's mode switch.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deploying a drone borrows seven switches from five subsystems the drone does
 * not own — the weapon system, the ADS blend, the lean probe, the player, and
 * the input manager — and hands them all back afterwards. Every one of them is
 * a LATCH. Nothing throws when one is left set; the player simply spends the
 * rest of the round unable to sprint, unable to lean, or unable to shoot, with
 * no error anywhere and nothing on screen to point at. That is the single most
 * expensive failure this feature can have, and it is invisible to every other
 * kind of test.
 *
 * `player.sprintSuppressed` is the worst of them and has a test of its own. It
 * is only ever written inside `WeaponSystem._handleFiring`, which is skipped
 * entirely once `weapons.enabled` is false — so deploying with the trigger held
 * latches it true and NOTHING will ever clear it again.
 *
 * There is no engine here and no browser: `DroneSystem` is built against
 * recording stubs and every assertion is about what it wrote and in what order,
 * which is exactly what a running game cannot show you.
 *
 *   node test/drone-mode.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DroneSystem, DRONE_MODE } from '../src/drone/DroneSystem.js';
import { DRONE, DRONE_CMD, DRONE_EVENT } from '../src/net/protocol.js';
import { WEAPON_DEFS, weaponsForSlot } from '../src/weapons/WeaponDefinitions.js';
import { KEY_BINDINGS } from '../src/core/InputManager.js';
import { MAPS, getMap } from '../src/world/maps/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/* =========================================================================
   The rig.

   Every borrowed switch is a real accessor that appends to one shared log, so
   the assertions can be about ORDER and not merely about the end state. Half
   the value here is in the sequencing: restoring the weapon after the weapon
   system is re-enabled, or enabling input before the sprint latch is cleared,
   both leave every field with the right value and still misbehave for a frame.
   ========================================================================= */
function makeRig() {
  const log = [];

  /** Replace `fields` with accessors that record every write. */
  const watch = (name, obj, fields) => {
    for (const f of fields) {
      let v = obj[f];
      Object.defineProperty(obj, f, {
        get: () => v,
        set: (next) => { v = next; log.push(`${name}.${f}=${next}`); },
        enumerable: true,
        configurable: true,
      });
    }
    return obj;
  };

  const player = watch('player', { alive: true, enabled: true, sprintSuppressed: false },
    ['enabled', 'sprintSuppressed']);
  const ads = watch('ads', { enabled: true }, ['enabled']);
  const lean = watch('lean', { enabled: true }, ['enabled']);

  const weapons = watch('weapons', {
    enabled: true,
    held: null,
    equipGadget(id) { log.push(`weapons.equipGadget(${id})`); this.held = id; return true; },
    restoreWeapon() { log.push('weapons.restoreWeapon()'); this.held = null; return true; },
  }, ['enabled']);

  const input = watch('input', {
    enabled: true,
    keys: new Set(),
    pressed: new Set(),
    wheel: 0,
    clearAll() {
      log.push('input.clearAll()');
      this.keys.clear();
      this.pressed.clear();
      this.wheel = 0;
    },
    consumeWheel() { log.push('input.consumeWheel()'); const w = this.wheel; this.wheel = 0; return w; },
    isDown(action) { return this.keys.has(action); },
    wasPressed(action) { return this.pressed.has(action); },
  }, ['enabled']);

  const sent = [];
  const net = {
    connected: true,
    sendDroneCmd(c, payload = {}) { sent.push({ c, ...payload }); },
    sendDroneDrive({ position, yaw }) { sent.push({ c: 'drive', position, yaw }); },
  };

  /*
   * A validating physics stub, in the spirit of the one `test/maps.mjs` builds
   * every map against: it refuses a non-finite dimension outright rather than
   * accepting it, because a single one of those poisons Rapier's broad phase
   * and silently disables every raycast on the map.
   */
  const bodies = [];
  const physics = {
    droneController: {
      computeColliderMovement() {},
      computedMovement: () => ({ x: 0, y: 0, z: 0 }),
      computedGrounded: () => true,
    },
    createCharacterBody(pos, halfHeight, radius) {
      for (const [k, v] of Object.entries({ x: pos.x, y: pos.y, z: pos.z, halfHeight, radius })) {
        if (!Number.isFinite(v)) throw new Error(`createCharacterBody got a non-finite ${k}`);
      }
      const body = { alive: true, setTranslation() {}, setNextKinematicTranslation() {} };
      bodies.push(body);
      return { body, collider: {} };
    },
    removeBody(body) { body.alive = false; },
  };

  const menus = { onLoadoutChanged: null };
  const loadoutCalls = [];
  menus.onLoadoutChanged = () => { loadoutCalls.push(log.length); };

  const system = new DroneSystem({ physics, player, weapons, ads, lean, input, net, menus });

  return {
    log, sent, bodies, loadoutCalls,
    player, weapons, ads, lean, input, net, menus, system,
    /** Everything written since the marker, as one array. */
    since: (mark) => log.slice(mark),
    mark: () => log.length,
  };
}

/**
 * Run the clock forward in real frames.
 *
 * One giant `update(0.9)` will not do: the system clamps a frame delta to a
 * quarter of a second, deliberately, so that an alt-tabbed tab coming back does
 * not integrate three minutes of animation in a single step. A test that passed
 * a whole animation in one call would be testing a code path the game never
 * takes.
 */
function advance(system, seconds, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) system.update(step, 1);
}

/** Take a rig all the way to PILOTING, the way the game does. */
function toPiloting(rig, { position = [3, 1, -2], yaw = 0.5 } = {}) {
  /*
   * `available` is set by hand rather than through `onMapChanged`.
   *
   * The map that declares `drone: true` is built separately and is not on disk
   * here yet, and a test that quietly examines nothing is worse than no test at
   * all. So the GATE is proven below, against every map that really is
   * registered; what is under test in this rig is the SWITCH.
   */
  rig.system.available = true;
  rig.system.deploy();
  rig.system.onServerEvent({
    isSelfOwner: true,
    event: DRONE_EVENT.DEPLOYED,
    hp: DRONE.maxHealth,
    battery: DRONE.batteryMs,
    position,
    yaw,
  });
  // Run the pull-it-out-of-your-pocket animation out.
  advance(rig.system, DRONE.deployMs / 1000 + 0.05);
  return rig;
}

const ENTER_SEQUENCE = [
  'input.clearAll()',
  'player.sprintSuppressed=false',
  'weapons.enabled=false',
  'ads.enabled=false',
  'lean.enabled=false',
  'player.enabled=false',
  'input.enabled=false',
  'weapons.equipGadget(dronectl)',
];

const EXIT_SEQUENCE = [
  'input.clearAll()',
  'weapons.restoreWeapon()',
  'weapons.enabled=true',
  'ads.enabled=true',
  'lean.enabled=true',
  'player.sprintSuppressed=false',
  'player.enabled=true',
  'input.enabled=true',
];

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('--- taking the controls ---');
{
  const rig = makeRig();
  rig.system.available = true;
  const mark = rig.mark();
  const ok = rig.system.deploy();

  check('pressing deploy takes every borrowed switch, in order',
    ok && same(rig.since(mark), ENTER_SEQUENCE),
    same(rig.since(mark), ENTER_SEQUENCE) ? `${ENTER_SEQUENCE.length} writes`
      : rig.since(mark).join(' | '));

  check('the deploy request carries no position at all',
    rig.sent.length === 1 && rig.sent[0].c === DRONE_CMD.DEPLOY
    && Object.keys(rig.sent[0]).length === 1,
    JSON.stringify(rig.sent[0]));

  check('and the state machine is waiting for the server, not assuming',
    rig.system.state === DRONE_MODE.DEPLOYING && rig.system.actor === null,
    'a drone exists when the server says so and not before');
}

console.log('\n--- giving them back ---');
{
  const rig = toPiloting(makeRig());
  check('the server event plus the animation puts us in PILOTING',
    rig.system.state === DRONE_MODE.PILOTING && rig.system.actor?.active === true);

  const mark = rig.mark();
  rig.system.recall();
  // STOWING holds the controls for the tail of the animation, then releases.
  check('recall does not hand anything back until the stow finishes',
    rig.system.state === DRONE_MODE.STOWING && rig.since(mark).length === 0,
    rig.since(mark).join(' | ') || 'nothing written yet');

  advance(rig.system, DRONE.stowMs / 1000 + 0.05);
  check('the exit sequence restores every switch, in order',
    rig.system.state === DRONE_MODE.STOWED && same(rig.since(mark), EXIT_SEQUENCE),
    same(rig.since(mark), EXIT_SEQUENCE) ? `${EXIT_SEQUENCE.length} writes`
      : rig.since(mark).join(' | '));

  check('and the collider is removed, never merely disabled',
    rig.bodies.length === 1 && rig.bodies[0].alive === false,
    'a disabled body still answers ray queries');
}

console.log('\n--- the sprint latch ---');
{
  /*
   * THE BUG THIS GUARDS.
   *
   * `sprintSuppressed` is written in exactly one place — `_handleFiring` — and
   * that is skipped while `weapons.enabled` is false. Deploy with the trigger
   * held and it is latched true for the rest of the life: the player lands
   * their drone and can never sprint again, with nothing thrown, nothing
   * logged, and no way to tell it from the game feeling sluggish.
   */
  const rig = makeRig();
  // The trigger is held at the exact moment the drone key is pressed.
  rig.player.sprintSuppressed = true;
  toPiloting(rig);
  check('the ENTRY edge clears a latch the trigger left behind',
    rig.player.sprintSuppressed === false,
    'nothing else runs while the weapon system is off, so nothing else can');

  // And the same again on the way out, for anything that sets it while the
  // drone is out. Both edges, because only one of them being right is a bug
  // that hides until the other path is the one taken.
  rig.player.sprintSuppressed = true;
  rig.system.recall();
  advance(rig.system, DRONE.stowMs / 1000 + 0.05);
  check('and the EXIT edge clears it again',
    rig.player.sprintSuppressed === false);
}

console.log('\n--- abort ---');
{
  const restored = (rig) =>
    rig.system.state === DRONE_MODE.STOWED
    && rig.player.enabled === true && rig.player.sprintSuppressed === false
    && rig.weapons.enabled === true && rig.weapons.held === null
    && rig.ads.enabled === true && rig.lean.enabled === true
    && rig.input.enabled === true;

  const fromDeploying = makeRig();
  fromDeploying.system.available = true;
  fromDeploying.system.deploy();
  fromDeploying.system.abort();
  check('abort from DEPLOYING converges on STOWED with everything restored',
    restored(fromDeploying));

  const fromPiloting = toPiloting(makeRig());
  fromPiloting.system.abort();
  check('abort from PILOTING converges on STOWED with everything restored',
    restored(fromPiloting) && fromPiloting.bodies[0].alive === false);

  const fromStowing = toPiloting(makeRig());
  fromStowing.system.recall();
  fromStowing.system.abort();
  check('abort from STOWING converges on STOWED with everything restored',
    restored(fromStowing));

  /*
   * Idempotence is not a nicety here. `abort()` is called from four places —
   * building a level, resetting the world, leaving a match, and dying — and
   * two of those routinely happen in the same frame. A second abort that ran
   * the exit sequence again would re-enable input and clear the sprint latch
   * on a player the FIRST one had already handed back, which is how a
   * "harmless" duplicate call turns into a spectator who can walk around.
   */
  const twice = toPiloting(makeRig());
  twice.system.abort();
  const mark = twice.mark();
  const second = twice.system.abort();
  check('abort twice in a row writes nothing the second time',
    second === false && twice.since(mark).length === 0,
    twice.since(mark).join(' | ') || 'no writes');
}

console.log('\n--- the two things that yank the controls away ---');
{
  const rig = toPiloting(makeRig());
  const mark = rig.mark();
  rig.menus.onLoadoutChanged();
  /*
   * `applyLoadout` rebuilds `slots` and force-equips slot 0. Changing loadout
   * while the handset is out would leave `current` on a weapon the terminal
   * thinks it is standing in for, and `restoreWeapon` would then put back a gun
   * that is no longer carried. Stowing FIRST means the rebuild happens from a
   * normal state.
   */
  check('changing loadout while piloting force-stows before anything else',
    rig.system.state === DRONE_MODE.STOWED
    && rig.loadoutCalls.length === 1
    && rig.loadoutCalls[0] === mark + EXIT_SEQUENCE.length,
    `stow wrote ${rig.loadoutCalls[0] - mark} entries before the loadout applied`);

  check('and the hook it chained onto still runs',
    rig.loadoutCalls.length === 1,
    'replacing it instead of chaining would silently stop loadout changes working');

  const disposed = toPiloting(makeRig());
  const hookBefore = disposed.menus.onLoadoutChanged;
  disposed.system.dispose();
  check('dispose gives the loadout hook back exactly as it was found',
    disposed.menus.onLoadoutChanged !== hookBefore
    && typeof disposed.menus.onLoadoutChanged === 'function'
    && disposed.system.state === DRONE_MODE.STOWED);
}

console.log('\n--- the map gate ---');
{
  const rig = toPiloting(makeRig());
  rig.system.onMapChanged('warehouse');
  check("a map that does not declare a drone turns it off and force-stows",
    rig.system.available === false && rig.system.state === DRONE_MODE.STOWED
    && rig.player.enabled === true);

  const keyOnly = makeRig();
  keyOnly.system.onMapChanged('warehouse');
  keyOnly.input.pressed.add('drone');
  keyOnly.system.updateInput();
  check('and the drone key does nothing whatsoever there',
    keyOnly.system.state === DRONE_MODE.STOWED && keyOnly.sent.length === 0
    && keyOnly.log.length === 0,
    keyOnly.log.join(' | ') || 'no writes, no messages');

  /*
   * Every REGISTERED map, both ways round, rather than one id spelled out.
   * The map that declares a drone lands separately; this is written so that
   * the day it does, it is already covered — and so that a map accidentally
   * declaring one is caught the same day.
   */
  const wrong = MAPS.filter((m) => {
    const s = makeRig().system;
    s.onMapChanged(m.id);
    return s.available !== (m.drone === true);
  }).map((m) => m.id);
  check('`available` follows each map definition\'s own `drone` field',
    wrong.length === 0,
    wrong.join(', ') || `${MAPS.length} maps: `
      + MAPS.map((m) => `${m.id}=${m.drone === true}`).join(', '));

  const unknown = makeRig().system;
  unknown.onMapChanged('a-map-from-a-newer-server');
  check('an unrecognised map id is "no drone here" rather than a throw',
    unknown.available === false,
    `getMap falls back to ${getMap('a-map-from-a-newer-server').id}, which declares none`);
}

console.log('\n--- the server has the last word ---');
{
  const denied = makeRig();
  denied.system.available = true;
  denied.system.deploy();
  denied.system.onServerEvent({
    isSelfOwner: true, event: DRONE_EVENT.DENIED, why: 'drone rebooting — 7s',
  });
  check('a refused deploy puts the controls straight back',
    denied.system.state === DRONE_MODE.STOWED && denied.player.enabled === true
    && denied.weapons.held === null,
    'otherwise the player is frozen holding a terminal that will never light up');

  const destroyed = toPiloting(makeRig());
  destroyed.system.onServerEvent({
    isSelfOwner: true, event: DRONE_EVENT.DESTROYED, hp: 0, by: 9,
  });
  advance(destroyed.system, DRONE.stowMs / 1000 + 0.05);
  check('a destroyed drone stows the handset and frees the collider',
    destroyed.system.state === DRONE_MODE.STOWED
    && destroyed.system.actor === null
    && destroyed.bodies[0].alive === false
    && destroyed.system.hudState().cooldownMs > 0);

  const other = toPiloting(makeRig());
  other.system.onServerEvent({ isSelfOwner: false, event: DRONE_EVENT.DESTROYED, hp: 0 });
  check("somebody else's drone being destroyed does nothing to ours",
    other.system.state === DRONE_MODE.PILOTING && other.system.actor?.active === true);

  const corrected = toPiloting(makeRig());
  corrected.system.onServerEvent({
    isSelfOwner: true, event: DRONE_EVENT.CORRECT, position: [11, 2, -4], yaw: 1.25,
  });
  check('a refused drive report snaps the local drone to the truth',
    corrected.system.actor.position.x === 11 && corrected.system.actor.yaw === 1.25,
    'dropping the correction is how two machines diverge without limit');

  /*
   * A pose that is not three finite numbers must never reach
   * `createCharacterBody`. This is the ONE place in the game where a collider
   * dimension arrives off a socket rather than out of a level file, and one
   * non-finite number there disables every raycast on the map.
   */
  const poisoned = makeRig();
  poisoned.system.available = true;
  poisoned.system.deploy();
  let threw = null;
  try {
    poisoned.system.onServerEvent({
      isSelfOwner: true, event: DRONE_EVENT.DEPLOYED, position: [1, Number.NaN, 3], yaw: 0,
    });
  } catch (err) { threw = err; }
  check('a non-finite deploy pose is refused rather than handed to the broad phase',
    threw === null && poisoned.bodies.length === 0
    && poisoned.system.state === DRONE_MODE.STOWING,
    threw ? `threw: ${threw.message}` : 'no body was ever created; the drone is recalled');
}

console.log('\n--- while piloting ---');
{
  const rig = toPiloting(makeRig());
  rig.input.keys.add('forward');
  rig.input.keys.add('left');
  rig.input.wheel = 3;
  rig.system.updateInput();
  check('the sticks drive the chassis, tank-style',
    rig.system.actor.input.throttle === 1 && rig.system.actor.input.steer === 1,
    'positive steer is left, matching stepDroneMotion and the player yaw');

  /*
   * Nothing else drains the wheel while the weapon system is off, and
   * `wheelDelta` only accumulates. Left alone it is spent the instant the
   * weapon system comes back — the player lands their drone and their gun
   * changes on its own.
   */
  check('the mouse wheel is drained every piloting frame and thrown away',
    rig.input.wheel === 0 && rig.log.filter((l) => l === 'input.consumeWheel()').length === 1);

  const back = makeRig();
  const flying = toPiloting(back);
  flying.input.pressed.add('drone');
  flying.system.updateInput();
  check('the same key that deployed it brings it home',
    flying.system.state === DRONE_MODE.STOWING
    && flying.sent.some((m) => m.c === DRONE_CMD.RECALL));
}

console.log('\n--- the handset is a real weapon ---');
{
  const term = WEAPON_DEFS.find((w) => w.id === 'dronectl');
  check('dronectl is in WEAPON_DEFS', !!term,
    'which is how the server derives HELD_WEAPON_IDS, and how other players see it');

  check("it sits in the 'gadget' slot", term?.slot === 'gadget',
    'so weaponsForSlot and the loadout browser cannot reach it');
  check('it cannot be picked in a loadout',
    !weaponsForSlot('primary').includes(term) && !weaponsForSlot('secondary').includes(term));
  check('it is not on any number key',
    !['melee', 'throwable'].includes(term?.slot),
    'WeaponSystem.SLOTS lists primary/secondary/melee/throwable, and gadget is none of them');

  check('it does no damage', term?.damage === 0,
    'which is also what keeps it out of test/damage-falloff.mjs');
  check('it cannot aim down sights', term?.noAds === true);
  check('it is marked as a gadget', term?.gadget === true,
    'read by Weapon._buildMuzzleFlash, which gives it no flash quads and no light');

  /*
   * `buildViewModel` adds an authored scene WITHOUT cloning it, so two
   * definitions naming the same model reparent geometry out of each other's
   * group — one weapon works and the other is empty. The terminal is
   * procedural and names no model at all, which is the strongest form of "not
   * shared" there is, and it is also what keeps `test/contracts.mjs` honest:
   * every modelId there has to resolve to a file that is really loaded.
   */
  const sharing = WEAPON_DEFS.filter((w) => w !== term && w.modelId === term?.modelId);
  check('its view model is shared with no other definition', sharing.length === 0,
    term?.modelId ? `modelId ${term.modelId}` : 'procedural — it names no model id');
  const classes = WEAPON_DEFS.filter((w) => w !== term && w.modelClass === term?.modelClass);
  check('and its procedural model class is its own', classes.length === 0,
    `modelClass ${term?.modelClass}`);
}

console.log('\n--- the key, and the one thing this file must never touch ---');
{
  check('a `drone` action is bound', Array.isArray(KEY_BINDINGS.drone)
    && KEY_BINDINGS.drone.length > 0,
    KEY_BINDINGS.drone?.join(', '));

  const bound = Object.entries(KEY_BINDINGS)
    .filter(([action]) => action !== 'drone')
    .flatMap(([, codes]) => codes);
  check('and it does not collide with an existing binding',
    KEY_BINDINGS.drone.every((c) => !bound.includes(c)));

  /*
   * THE THIRD WRITER.
   *
   * `viewModel.holder.visible` already has two: the respawn path and the death
   * path in wireNetwork.js. A third means whichever runs last in a frame wins,
   * and the symptom is a weapon that flickers rather than an error anybody can
   * find. `DroneSystem` is not even given the view model, so this is checked
   * from the source: the constructor taking one back is the change that would
   * make the mistake possible again.
   */
  const src = readFileSync(join(ROOT, 'src/drone/DroneSystem.js'), 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('DroneSystem never writes viewModel.holder.visible',
    !/holder\s*\.\s*visible/.test(code) && !/\.visible\s*=/.test(code),
    'three places already fight over it');
  check('and is never even handed the view model',
    !/\bviewModel\b/.test(code),
    'so a later edit here cannot become the fourth writer by accident');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

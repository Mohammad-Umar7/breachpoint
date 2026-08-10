/**
 * FALL OUT OF THE WORLD, COME BACK, AND BE ABLE TO PLAY.
 *
 * WHY THIS EXISTS
 * ---------------
 * This bug has now been "fixed" nine times. Every fix was aimed at the fall,
 * every one shipped without a test, and every one came back from play wearing
 * a new costume: stuck in the air, shot on the way down, stuck at the base,
 * and finally a base/air/base flicker ending in a player who could not move.
 *
 * The last two shared one cause: coming back to life was done by hand, in the
 * network handler, three fields at a time, when a full revive is nineteen. The
 * one it missed — `fellOutOfWorld` — was then read by Game's void guard, which
 * killed the player again on the spawn, every frame, forever.
 *
 * So this file does not test the fall. It tests the three rules that make the
 * whole class of bug impossible:
 *
 *   1. THE VOID NET NEVER PLACES THE PLAYER. It latches and stops. Whoever
 *      owns the world does the placing — the server online, Game offline. A
 *      client that moves itself has its next input refused as a teleport, and
 *      that refusal is the mid-air frame in the flicker.
 *   2. THERE IS EXACTLY ONE FUNCTION THAT REVIVES THE LOCAL PLAYER, and it
 *      resets every field. Proven not by reading the fields back but by
 *      WALKING: run the real character controller and check the player moves.
 *   3. A SERVER CORRECTION IS NEVER A RESPAWN. The server labels which kind of
 *      placement it is sending; the client no longer infers it from its own
 *      aliveness, which is what turned an anti-cheat snap-back into a
 *      resurrection in mid-air.
 *
 * REAL CODE, NOT A MODEL: the real Rapier world, the real capsule, the real
 * `Player.fixedUpdate`, the real `NetworkClient` message handler. The only
 * stubs are the things that need a browser — audio, particles, mouse.
 *
 * ON THE PRE-FIX TREE (eedc2f6) THIS FAILS 9 OF 15, including "AND THE PLAYER
 * CAN ACTUALLY MOVE AGAIN — 0.00 m", which is the bug as the player described
 * it.
 */

import * as THREE from 'three';
import { initRapier, PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { Player } from '../src/player/Player.js';
import { NetworkClient } from '../src/net/NetworkClient.js';
import * as protocol from '../src/net/protocol.js';

const { MSG, PLAYER_START_ARMOR } = protocol;
/*
 * A namespace import with a fallback, not `import { SP_KIND }`, so that a tree
 * without the label still RUNS and reports which behaviours are missing. A
 * named import would collapse every result below into one SyntaxError, which
 * tells you nothing about what is broken.
 */
const SP_KIND = protocol.SP_KIND ?? { SPAWN: 's', CORRECTION: 'c' };

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); } else {
    failed++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
};

/* ------------------------------------------------------------------ stubs */

/** Keys the test can hold down. */
function stubInput() {
  const held = new Set();
  return {
    held,
    isDown: (a) => held.has(a),
    wasPressed: () => false,
    consumeLookDelta: (out) => { out.x = 0; out.y = 0; return out; },
    requestPointerLock() {},
  };
}
const stubAudio = { play() {} };
const stubFx = { spawnLandingDust() {} };
const stubSettings = { get: () => 90, onChange() {} };
const stubSens = { compute: () => ({ yaw: 0, pitch: 0 }), reset() {} };
const stubLean = {
  offset: 0, amount: 0, isLeaning: false, speedMultiplier: 1,
  update() {}, reset() {},
};

/* ------------------------------------------------------------------- world
 *
 * A 40 m slab and nothing else. The player is dropped past its edge, which is
 * how it happens on OUTPOST: the floor reaches 28, the arena reaches 44, and
 * the sixteen metres in between have nothing under them.
 */
await initRapier();
const physics = new PhysicsWorld();
physics.createStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 20 });

const camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 500);
const input = stubInput();
const player = new Player(
  camera, physics, input, stubSettings, stubAudio, stubFx, stubSens, stubLean,
);

const VOID_Y = -10;                       // stands in for voidDeathY(mapId)
const SPAWN = new THREE.Vector3(3, 1.1, 4);
player.voidY = VOID_Y;

const DT = 1 / 60;
/** The real fixed step followed by the real physics step, n times. */
function sim(n) {
  for (let i = 0; i < n; i++) { player.fixedUpdate(DT); physics.world.step(); }
}
/** How far the player travels horizontally in half a second of holding W. */
function walkDistance() {
  const from = player.position.clone();
  input.held.add('forward');
  sim(30);
  input.held.delete('forward');
  return Math.hypot(player.position.x - from.x, player.position.z - from.z);
}

/* ---------------------------------------------------------------- 0. control
 *
 * Or every check below would pass just as happily against a player who could
 * never move in the first place.
 */
player.spawn(SPAWN, 0);
sim(20);
check('a living player on the floor can walk', walkDistance() > 1.5,
  `${walkDistance().toFixed(2)} m in 0.5 s`);

/* -------------------------------------------- 1. the void net does not place
 *
 * FAILS PRE-FIX: the net teleports to `voidRespawn` on the spot. That jump is
 * at least 9 m against a server step limit of 8, so the next input is refused
 * and the client is snapped back to the last accepted position — in open air.
 */
/*
 * `voidRespawn` is a field the fixed Player does not have and does not read.
 * It is set here ON PURPOSE: it is the destination the old void net teleported
 * itself to, and without it this check passes vacuously against the broken
 * code — exactly the mistake server/void-test.js documents making three
 * separate times. Handing the player a destination and watching it refuse to
 * use one is the assertion.
 */
player.voidRespawn = SPAWN.clone();
player.spawn(new THREE.Vector3(60, 2, 0), 0);   // off the side of the slab
let fellAt = null;
for (let i = 0; i < 600 && !player.fellOutOfWorld; i++) {
  sim(1);
  if (player.fellOutOfWorld) fellAt = player.position.clone();
}

check('falling out of the world latches, once', player.fellOutOfWorld === true);
check('...and kills the local player', player.alive === false && player.health === 0);
check('...and does NOT move them: no placement without an authority',
  !!fellAt && fellAt.y < VOID_Y && Math.hypot(fellAt.x - SPAWN.x, fellAt.z - SPAWN.z) > 1,
  fellAt ? `died at ${fellAt.toArray().map((v) => v.toFixed(1)).join(', ')}` : 'never fell');

// And it holds still, so every input from here on reports a position under the
// server's rescue plane. Hopping back above it is how the server missed it.
const frozen = player.position.clone();
sim(30);
check('...and holds still under the plane so the server can see it',
  player.position.distanceTo(frozen) < 1e-6,
  `drifted ${player.position.distanceTo(frozen).toExponential(1)} m in 0.5 s`);

/* ----------------------------------------------------- 2. one revive, no rust
 *
 * FAILS PRE-FIX: `Player.revive` does not exist. What the network path does
 * instead is `player.alive = true` by hand, which leaves `fellOutOfWorld`
 * latched — and one frame later Game's guard kills the player on the spawn.
 */
check('Player has a single revive entry point', typeof player.revive === 'function');

// Dirty every field a death or a fall touches, the way a real match would. A
// local `_die()` from fall damage clears `enabled`, and nothing but a revive
// puts it back — so pre-fix it stayed false across every server respawn for
// the rest of the session.
player.enabled = false;
player.armor = 0;
player.crouching = true;
player.targetHalfHeight = 0.22;
player.trauma = 1;

player.revive?.(SPAWN);

check('revive puts you back alive, unlatched and under your own control',
  player.alive === true && player.fellOutOfWorld === false && player.enabled === true,
  `alive=${player.alive} latched=${player.fellOutOfWorld} enabled=${player.enabled}`);
check('revive restores the vitals the server just granted',
  player.health === player.maxHealth && player.armor === PLAYER_START_ARMOR,
  `hp=${player.health} armor=${player.armor}`);
check('revive stands you back up',
  player.crouching === false && Math.abs(player.halfHeight - 0.6) < 1e-6);
check('revive does not leave the interpolator smearing across the map',
  player.prevPosition.distanceTo(player.position) < 1e-6
  && player.renderPosition.distanceTo(player.position) < 1e-6);
check('revive puts the physics body there too',
  Math.hypot(
    player.body.translation().x - SPAWN.x,
    player.body.translation().z - SPAWN.z,
  ) < 1e-3);

// THE ONE THAT MATTERS. "Stuck at the base" was a player who was alive on
// paper and could not move. So move.
sim(20);
check('AND THE PLAYER CAN ACTUALLY MOVE AGAIN', walkDistance() > 1.5,
  `${walkDistance().toFixed(2)} m in 0.5 s after a fall and a revive`);

/* ------------------------------------------------- 3. a correction is not life
 *
 * FAILS PRE-FIX: `wasDead` is inferred from `isSelfDead()`, so any correction
 * arriving while we have killed ourselves is executed as a respawn — standing
 * us up, alive, at whatever position the server last accepted, which mid-fall
 * is a point in open air beside the map.
 */
// Nothing here connects; the message handler is driven directly. The shim is
// for older trees whose constructor read a bare `location` — without it this
// section throws instead of reporting, and a crash is not a test result.
globalThis.location ??= { protocol: 'http:', hostname: 'localhost' };
const net = new NetworkClient({ url: 'ws://localhost:8787' });
net.selfId = 'me';
net.isSelfDead = () => true;               // we fell; we believe we are dead

let revived = null, corrected = null;
net.onRespawn = (sp) => { revived = sp; };
net.onCorrection = (sp) => { corrected = sp; };

const midAir = [44, -9.4, 0];
net._handle({ t: MSG.MATCH, sp: midAir, spk: SP_KIND.CORRECTION });
check('an anti-cheat correction is never a respawn, even when we think we died',
  corrected !== null && revived === null,
  `correction=${JSON.stringify(corrected)} respawn=${JSON.stringify(revived)}`);

revived = null; corrected = null;
net._handle({ t: MSG.MATCH, sp: [3, 1.1, 4], spk: SP_KIND.SPAWN });
check('a spawn still is one', revived !== null && corrected === null,
  `respawn=${JSON.stringify(revived)}`);

// And a spawn revives you whether or not you thought you were dead: the server
// has just set alive, full health and full armour on its side, and a client
// mirroring only some of that is the whole bug.
net.isSelfDead = () => false;
revived = null; corrected = null;
net._handle({ t: MSG.MATCH, sp: [3, 1.1, 4], spk: SP_KIND.SPAWN });
check('a spawn revives a client that did not know it had died',
  revived !== null && corrected === null);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

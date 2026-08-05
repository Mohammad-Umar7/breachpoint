/**
 * WALK THE MAPS WITH THE REAL PHYSICS.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/maps.mjs` ends with a flood fill over standing positions, and it is
 * genuinely useful — but it is a model of the character controller, not the
 * controller. It has already been proven insufficient: the broken VILLA, whose
 * partitions were all built ninety degrees out and which spawned players into
 * sealed rooms, passed all three versions of that fill. It reads `_box`
 * geometry and nothing else, so it cannot see a ramp, cannot see a rotated
 * piece, and cannot see anything the controller does with autostep, slope
 * limits, snap-to-ground or capsule shape.
 *
 * So this file does not model anything. It boots Rapier, builds the level with
 * the real `PhysicsWorld`, makes the same 1.90 m capsule the player gets, and
 * walks it — 60 Hz, real gravity, the real `KinematicCharacterController` with
 * the real 0.45 m autostep — from one named place in the house to the next.
 *
 * A route that a player is meant to walk must be walkable WITHOUT JUMPING. The
 * walker has no jump. If it cannot get there on foot, neither can anyone who
 * has not thought to press space, and the last two houses failed exactly there:
 * "the place i spawned i had no way to go somewhere i had to jump and all".
 *
 * WHAT IT STILL CANNOT SEE
 * ------------------------
 * Whether the map is any FUN. It proves the house is connected and that no
 * route needs a jump. It cannot tell you a room is boring, a sightline is
 * unfair, or a corner is a bad place to spawn. Those need a person.
 */

import * as THREE from 'three';
import { initRapier, PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { Level } from '../src/world/Level.js';
import { getMap } from '../src/world/maps/index.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); } else {
    failed++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/* --------------------------------------------------------- the real player
 *
 * Every number here is READ FROM Player.js rather than retyped, because a
 * walker built on a capsule of the wrong size proves nothing about the one the
 * game actually uses — and a copied constant is a constant that drifts.
 */
const P = await import('../src/player/Player.js');
const SRC = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../src/player/Player.js', import.meta.url), 'utf8'));
const num = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = (-?[\\d.]+)`));
  if (!m) throw new Error(`Player.js no longer defines ${name}`);
  return Number(m[1]);
};
const RADIUS = num('RADIUS');
const HALF_STAND = num('HALF_STAND');
const SPEED_WALK = P.SPEED_WALK;
const GRAVITY = num('GRAVITY');

/** Materials by name, made on demand — the real ones need a canvas. */
function stubAssets() {
  const cache = new Map();
  return {
    getMaterial(n) {
      if (!cache.has(n)) cache.set(n, new THREE.MeshStandardMaterial({ name: n }));
      return cache.get(n);
    },
    getModel() { return null; },
    ownGeometry(g) { return g; },
  };
}
const stubSettings = { get: (k) => (k === 'shadowQuality' ? 'medium' : null), onChange() {} };

await initRapier();

/**
 * Walk a capsule from `start` through `waypoints`, on foot, and report where
 * it stopped.
 *
 * The steering is deliberately stupid: face the next waypoint, walk flat out,
 * fall under gravity. No pathfinding, no jumping, no unsticking. A route that
 * needs cleverness to follow is a route a player will fail too.
 */
function walk(physics, start, waypoints, { budget = 14 } = {}) {
  const pos = new THREE.Vector3(start[0], start[1], start[2]);
  const { body, collider } = physics.createCharacterBody(pos, HALF_STAND, RADIUS, null);
  const controller = physics.playerController;
  const dt = 1 / 60;
  const desired = new THREE.Vector3();
  const vel = new THREE.Vector3();

  const trail = [];
  let leg = 0, t = 0, stuckFor = 0;
  const last = new THREE.Vector3().copy(pos);

  while (leg < waypoints.length && t < budget) {
    const target = waypoints[leg];
    const dx = target[0] - pos.x, dz = target[2] - pos.z;
    const flat = Math.hypot(dx, dz);

    /*
     * Arrival is 0.6 m on the flat AND within 1.2 m vertically.
     *
     * The height test is what makes a waypoint on the landing mean the
     * landing. Without it, standing in the hall directly beneath the balcony
     * counts as having reached the balcony — which is precisely how a check
     * can certify an upper floor nobody can climb to.
     */
    if (flat < 0.6 && Math.abs(target[1] - pos.y) < 1.2) {
      trail.push({ leg, t: t.toFixed(1), pos: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)] });
      leg++; stuckFor = 0; last.copy(pos);
      continue;
    }

    vel.x = (dx / flat) * SPEED_WALK;
    vel.z = (dz / flat) * SPEED_WALK;
    vel.y = Math.max(-55, vel.y + GRAVITY * dt);

    desired.set(vel.x * dt, vel.y * dt, vel.z * dt);
    controller.computeColliderMovement(collider, desired, physics.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = controller.computedMovement();
    pos.x += moved.x; pos.y += moved.y; pos.z += moved.z;
    body.setNextKinematicTranslation(pos);
    if (controller.computedGrounded()) vel.y = -2;

    physics.world.step();
    t += dt;

    // Progress check: 0.25 s of going nowhere is being stuck against something.
    if (pos.distanceTo(last) < 0.05) {
      stuckFor += dt;
      if (stuckFor > 0.25) break;
    } else { stuckFor = 0; last.copy(pos); }
  }

  physics.removeBody(body);
  return {
    reached: leg,
    of: waypoints.length,
    stoppedAt: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)],
    seconds: +t.toFixed(1),
    timedOut: t >= budget,
    trail,
  };
}

/**
 * ROUTES.
 *
 * Named after what a player would call them, and chosen to cover every room in
 * the house at least once in each direction — the point is not that some path
 * exists but that the OBVIOUS path works.
 */
/*
 * Heights are the CAPSULE CENTRE, not the floor: 0.95 m above whatever you are
 * standing on. Writing 3.6 for the upper floor puts the walker's feet at 2.65,
 * a metre inside the slab, and it then spends the whole route being squeezed
 * out of the floor it is supposed to be walking on. GROUND and UPPER exist so
 * that number is stated once.
 */
const GROUND = 1.0;
const UPPER = 3.6 + 0.95;

const ROUTES = {
  lodge: [
    ['hall, south end to the top of the stairs',
      [0, GROUND, 7.6], [[0, GROUND, 5.0], [0, UPPER, -2.0]]],

    // The staircase stands in the middle of the hall, so every ground route
    // that crosses the house has to pass down one side of it. That is the map
    // working as intended — but it means a route drawn straight up x=0 walks
    // into the stairs and climbs them, which is what the first draft did.
    /*
     * The waypoints inside the rooms go ROUND the furniture, because the
     * counter and the car are solid and 2 m deep. The first draft aimed at the
     * middle of both and reported the map broken; it was the route that was
     * broken, and the distinction is the whole reason the failure message
     * prints the coordinate it stopped at.
     */
    ['ground floor, west side: hall to kitchen to living and back',
      [0, GROUND, 7.6], [[-2.3, GROUND, 6.0], [-2.3, GROUND, -4.9],
        [-5.2, GROUND, -6.6], [-5.2, GROUND, -2.2], [-7.7, GROUND, -2.2],
        [-7.7, GROUND, 0.2], [-5.5, GROUND, 3.0], [-2.3, GROUND, 4.3],
        [0, GROUND, 7.6]]],
    ['ground floor, east side: hall to garage to den and back',
      [0, GROUND, 7.6], [[2.3, GROUND, 6.0], [2.3, GROUND, -4.9],
        [5.2, GROUND, -7.4], [5.2, GROUND, -2.2], [7.7, GROUND, -2.2],
        [7.7, GROUND, 2.0], [2.3, GROUND, 4.3], [0, GROUND, 7.6]]],

    ['upstairs: landing to both north rooms and on into both south rooms',
      [0, UPPER, -3.0], [[0, UPPER, -4.9], [-7.7, UPPER, -4.9], [-7.7, UPPER, 4.0],
        [-7.7, UPPER, -4.9], [0, UPPER, -4.9], [7.7, UPPER, -4.9],
        [7.7, UPPER, 4.0]]],

    /*
     * Down the flight in ONE leg, from the head of the stairs to the hall.
     *
     * A waypoint halfway along, at ground height, would sit two metres inside
     * the staircase — the walker arrives directly above it, cannot descend to
     * it, and reports the map broken. The stair is 6.12 m of run: nothing
     * between its two ends is at either end's height.
     */
    ['back down the stairs and out to the south end of the hall',
      [0, UPPER, -3.0], [[0, UPPER, 0.3], [0, GROUND, 7.6]]],

    /*
     * And the one the last two houses actually failed. A player who takes the
     * far upstairs room must be able to LEAVE it on foot — the balcony drop is
     * a shortcut you may choose, never the only way out.
     */
    ['from the far upstairs bedroom back to the hall without jumping once',
      [-7.7, UPPER, 4.0], [[-7.7, UPPER, -2.5], [-7.7, UPPER, -4.9],
        [-2.0, UPPER, -4.9], [0, UPPER, 0.3], [0, GROUND, 7.6]]],

    ['past the staircase on the west side of the hall',
      [0, GROUND, 7.6], [[-2.3, GROUND, 6.0], [-2.3, GROUND, 0.0], [0, GROUND, -6.0]]],
    ['past the staircase on the east side of the hall',
      [0, GROUND, 7.6], [[2.3, GROUND, 6.0], [2.3, GROUND, 0.0], [0, GROUND, -6.0]]],
  ],
};

for (const [mapId, routes] of Object.entries(ROUTES)) {
  const map = getMap(mapId);
  console.log(`\n--- walking ${map.name} on foot, no jumping ---`);

  for (const [name, start, waypoints] of routes) {
    /*
     * A FRESH WORLD PER ROUTE.
     *
     * Rapier's query pipeline is only correct after a `world.step()` following
     * a rebuild, and a capsule left lying in the geometry from the last route
     * is a collider the next walker can catch on. Rebuilding is a fraction of
     * a second and removes both hazards.
     */
    const physics = new PhysicsWorld();
    const scene = new THREE.Scene();
    const level = new Level(scene, physics, stubAssets(), stubSettings, null, map);
    level.build();
    physics.world.step();

    const r = walk(physics, start, waypoints);
    check(`${map.name} — ${name}`,
      r.reached === r.of,
      r.reached === r.of
        ? `${r.of} legs in ${r.seconds}s`
        : `stopped on leg ${r.reached + 1}/${r.of} at [${r.stoppedAt}] after ${r.seconds}s`
          + `${r.timedOut ? ' (ran out of time)' : ' (wedged)'}`);

    level.dispose();
    physics.dispose();
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

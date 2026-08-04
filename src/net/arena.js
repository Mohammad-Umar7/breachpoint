/**
 * arena.js — the parts of a map that BOTH the browser and the game server
 * have to agree on.
 *
 * Kept deliberately tiny and dependency-free (no THREE, no Node) because the
 * server imports it directly. The server does not need a map's geometry,
 * materials, textures or lighting — it only needs to know where a player may
 * legally appear and roughly where the world ends.
 *
 * This exists so spawn points have ONE definition. They were once literals
 * inside Level, and if the server kept its own copy the two would drift the
 * first time a map was edited — the symptom being players spawning inside
 * walls on a server nobody thought to update.
 *
 * ONE ENTRY PER MAP
 * -----------------
 * Everything here is keyed by map id. Adding a map means adding an entry here
 * AND a geometry module under `src/world/maps/`, and `test/contracts.mjs`
 * checks the two lists match — a map with geometry but no spawns would
 * otherwise drop everybody at the origin, inside whatever is built there.
 */

import { TEAM } from './modes.js';

/** The map a fresh install plays, and the fallback for anything unrecognised. */
export const DEFAULT_MAP_ID = 'warehouse';

/**
 * Per-map spawn points, as [x, z] on the ground plane.
 *
 * Spread wide on purpose: the server picks whichever is furthest from the
 * nearest living player, so a well-distributed set is what stops spawn-camping
 * without any extra logic.
 */
export const ARENAS = Object.freeze({
  /** The original industrial yard. About 70 m across. */
  warehouse: Object.freeze({
    spawnY: 1.1,
    /*
     * Two of these used to be unplayable, and had been since the map was
     * written: [0, -32] stood inside a shipping container, and [-8, -14] sat a
     * quarter of a metre from an interior wall — closer than the player's own
     * radius, so you spawned clipping into it and were shoved out. Neither is
     * visible in any way except by standing there. `test/maps.mjs` now checks
     * every point against the map's own footprints.
     */
    spawnPoints: Object.freeze([
      [-30, -30], [30, -30], [-30, 30], [30, 30], [5.5, -32],
      [-32, 0], [32, 0], [8, -14], [-9.8, -14], [22, 18], [-22, 18], [0, -22],
      [0, 26], // the original single-player start
    ]),
    /*
     * Axis-aligned bounds with generous margin. Used only as an absurdity
     * check on reported positions — a client claiming to be 900 m away or
     * 200 m in the air is rejected. Not a substitute for collision, which
     * still happens in the browser.
     */
    bounds: Object.freeze({
      minX: -60, maxX: 60,
      minY: -12, maxY: 60,
      minZ: -60, maxZ: 60,
    }),

    /*
     * Capture the Flag: bases on OPPOSITE CORNERS, not opposite ends.
     *
     * The warehouse sits across the middle, so a corner-to-corner run has to
     * commit to going through it or around it — a choice — where an
     * end-to-end run down one side would be the same route every time.
     *
     * Team spawns sit behind each base, so defenders start between the
     * attacker and the flag rather than beside it.
     */
    ctf: Object.freeze({
      bases: Object.freeze({
        [TEAM.RED]: Object.freeze([-26, -26]),
        [TEAM.BLUE]: Object.freeze([26, 26]),
      }),
      spawns: Object.freeze({
        [TEAM.RED]: Object.freeze([[-30, -30], [-22, -31], [-31, -22], [-32, -12], [-12, -32]]),
        [TEAM.BLUE]: Object.freeze([[30, 30], [22, 31], [31, 22], [32, 12], [12, 32]]),
      }),
    }),
  }),

  /**
   * OUTPOST — a sandstone trading post, 50 m across.
   *
   * Spawns hug the compound wall and the four gateways, well clear of the
   * market square in the middle: the whole map funnels inward, so putting
   * anybody down near the centre would be dropping them into the fight rather
   * than near it.
   */
  outpost: Object.freeze({
    spawnY: 1.1,
    /*
     * All twelve sit in the open CROSS between the four corner blocks, never
     * in a corner. The blocks span 10.5 to 21.5 on both axes, so anything with
     * both coordinates in that band is inside a building — which is exactly
     * what the first set of points did, putting players in a wall at ground
     * level. `test/maps.mjs` now checks every spawn against the map's own
     * footprints for this reason.
     */
    spawnPoints: Object.freeze([
      [0, -21], [0, 21], [-21, 0], [21, 0],
      [-7, -21], [7, -21], [-7, 21], [7, 21],
      [-21, -7], [-21, 7], [21, -7], [21, 7],
    ]),
    bounds: Object.freeze({
      minX: -44, maxX: 44,
      minY: -12, maxY: 50,
      minZ: -44, maxZ: 44,
    }),

    /*
     * Bases in the north and south arms of the cross, behind the gateways.
     *
     * The only routes between them cross the market square or thread the
     * arcade, which is where the fighting already happens — so the flag run
     * uses the map rather than going round the outside of it.
     */
    ctf: Object.freeze({
      bases: Object.freeze({
        [TEAM.RED]: Object.freeze([0, -19]),
        [TEAM.BLUE]: Object.freeze([0, 19]),
      }),
      spawns: Object.freeze({
        [TEAM.RED]: Object.freeze([[0, -21], [-7, -21], [7, -21], [-21, -7], [21, -7]]),
        [TEAM.BLUE]: Object.freeze([[0, 21], [-7, 21], [7, 21], [-21, 7], [21, 7]]),
      }),
    }),
  }),

  /**
   * MANOR — one sealed country house, 30 x 26 m over three storeys.
   *
   * EVERY SPAWN IS ON THE GROUND FLOOR, and that is not a compromise — it is
   * the map. `arenaFor` carries a single scalar `spawnY` per map, so mixing
   * floors is not expressible here anyway, and the house is built around the
   * consequence: every one-way route in it (six balustrade drops, the laundry
   * chute, the linen hatch, the collapsed attic floor) runs DOWNWARD, into the
   * respawn traffic, as does a drop through any of the four stairwell openings
   * — the great stair, the service stair, the loft stair and the box-room
   * stair. You start downstairs and fight upward; the geometry keeps dragging
   * the fight back down to meet the next wave, which is what stops the top of a
   * three-storey map deciding it.
   *
   * The box-room stair is the newest of the four and the reason there are four:
   * the loft stair was the attic's ONLY way in, so a single player at the head
   * of it held the whole top storey by watching one hole in a floor. See the
   * header of `maps/manor.js`.
   */
  manor: Object.freeze({
    spawnY: 1.1,
    /*
     * Thirteen points spread across eight of the ten ground-floor rooms, none
     * in a staircase and none in the open middle of the hall.
     *
     * Every one is derived from the room table in `maps/manor.js` — the CLEAR
     * interiors, not the wall centre lines — and `test/maps.mjs` re-checks all
     * thirteen against the footprints the map actually builds, with the 0.40 m
     * player radius as the margin. The furniture that matters to that check is
     * only what spans y = 1.1: the car body (0.35-1.45), the piano, the
     * long-case clock, the larder towers, the bookcases and the gallery
     * columns. The waist-high pieces (island 0.95, dining table 0.78, sofas
     * 0.46) stop below the spawn capsule's centre and cannot bury anybody.
     */
    spawnPoints: Object.freeze([
      [-11.5, -10.5], // kitchen, west of the island
      [-6.8, -8.0],   // kitchen, by the door to the dining room
      [-2.5, -10.5],  // dining, north of the table
      [2.6, -9.0],    // rear lobby, clear of the service stair
      [-11.0, -2.5],  // long gallery, north end
      [11.5, 9.8],    // study, east
      [7.0, 7.4],     // study, west
      [2.5, 7.0],     // entrance hall, north
      [-2.6, 10.6],   // entrance hall, by the front door
      [10.5, 2.0],    // conservatory, south bay
      [7.6, -11.4],   // garage, north-west of the car
      [-1.0, 1.5],    // stair hall, east of the great stair
      [11.0, -3.0],   // conservatory, north bay
    ]),
    /*
     * Generous, and taller than the house: it is only 13 m to the ridge, but a
     * player thrown off the attic by a blast has to stay legal all the way
     * down, and the garden outside the glass is part of the world too.
     */
    bounds: Object.freeze({
      minX: -34, maxX: 34,
      minY: -12, maxY: 40,
      minZ: -32, maxZ: 32,
    }),

    /*
     * Bases in diagonally opposite corners of the house — the kitchen in the
     * far north-west, the study in the far south-east, 27.0 m apart.
     *
     * The carrier has to choose between the spine (kitchen, dining, hall,
     * entrance hall, study) and the service diagonal (kitchen, long gallery,
     * living room, or lobby, garage, conservatory, study). Both cross rooms
     * where the fighting already is, and neither is a straight line: the arch
     * screen chops the spine into three slots and the conservatory makes the
     * diagonal cross a double-height space that two galleries and a bridge
     * overlook.
     *
     * THE TWO SPAWN SETS ARE MATCHED, and that is checked rather than eyeballed.
     * An earlier pair had BLUE averaging 12.3 m from its own flag against RED's
     * 8.5, with two BLUE points closer to the enemy base than to their own —
     * so a BLUE defender killed on the flag was pushed 22 m away while RED's
     * worst case was 15. `pickSpawn` maximises distance from the living, which
     * means it actively seeks that worst case out. `test/maps.mjs` now asserts
     * both teams' mean and maximum own-base distances agree to within a metre,
     * and that no spawn is nearer the enemy base than its own.
     */
    /**
     * The scout drone, mirrored from `manorMap.drone` in maps/manor.js.
     *
     * The server cannot import THREE and therefore cannot read a map module,
     * so the one decision lives in the map and its consequence is copied here.
     * `test/contracts.mjs` asserts the two agree, because a map that says yes
     * and an arena that says no is a key that does nothing with no error.
     *
     *   maxY   the drone is a GROUND robot. This is just above the attic floor
     *          so a client cannot claim to have driven one up the stairwell
     *          void and parked it against the ridge, watching the whole house.
     *   leash  how far it may get from where the server deployed it. Measured
     *          from the deploy point, never from the last accepted position —
     *          a leash that walks with the drone is not a leash.
     */
    drone: Object.freeze({ maxY: 8.6, leash: 26 }),

    ctf: Object.freeze({
      bases: Object.freeze({
        [TEAM.RED]: Object.freeze([-10.0, -9.4]),
        [TEAM.BLUE]: Object.freeze([10.0, 8.8]),
      }),
      spawns: Object.freeze({
        [TEAM.RED]: Object.freeze([[-11.5, -10.5], [-6.8, -8.0], [-2.5, -10.5], [2.6, -9.0], [-11.0, -2.5]]),
        [TEAM.BLUE]: Object.freeze([[11.5, 9.8], [7.0, 7.4], [2.5, 7.0], [-2.6, 10.6], [10.5, 2.0]]),
      }),
    }),
  }),
});

/** Every map id, in menu order. */
export const MAP_IDS = Object.freeze(Object.keys(ARENAS));

export function isValidMapId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ARENAS, id);
}

/**
 * The arena for a map id, falling back rather than throwing.
 *
 * An unknown id reaching here means a client asked for a map this server does
 * not have — an old build, or a hand-edited message. Falling back puts them
 * somewhere real; throwing would take the whole room down with them.
 */
export function arenaFor(mapId) {
  return ARENAS[mapId] ?? ARENAS[DEFAULT_MAP_ID];
}

export function isInsideArena(x, y, z, mapId = DEFAULT_MAP_ID) {
  const b = arenaFor(mapId).bounds;
  return x >= b.minX && x <= b.maxX
    && y >= b.minY && y <= b.maxY
    && z >= b.minZ && z <= b.maxZ;
}

/**
 * Pick the spawn point furthest from every living player.
 *
 * @param {Array<{x:number,z:number,alive:boolean}>} occupied
 * @param {() => number} rand   injected so the server stays testable
 * @param {string} mapId
 */
export function pickSpawn(occupied, rand = Math.random, mapId = DEFAULT_MAP_ID, team = TEAM.NONE) {
  const arena = arenaFor(mapId);
  /*
   * A team spawns at its OWN end.
   *
   * Without this a defender can appear in the enemy base, which in Capture the
   * Flag is not a spawn — it is a free capture. Falling back to the shared set
   * matters too: a map with no CTF block still has to be playable rather than
   * putting everybody at the origin.
   */
  const points = (team !== TEAM.NONE && arena.ctf?.spawns?.[team]) || arena.spawnPoints;
  const y = arena.spawnY;

  const living = occupied.filter((p) => p.alive);
  if (!living.length) {
    const [x, z] = points[Math.floor(rand() * points.length)];
    return { x, y, z };
  }

  let best = null;
  let bestScore = -Infinity;
  for (const [x, z] of points) {
    let nearest = Infinity;
    for (const p of living) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < nearest) nearest = d;
    }
    // Small random tiebreak so repeated deaths do not always reuse one corner.
    const score = nearest + rand() * 2.0;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y, z };
    }
  }
  return best;
}

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
   * VILLA — a modern house 26 x 22 m over three storeys, all of them looking
   * into the same room.
   *
   * EVERY SPAWN IS ON THE GROUND FLOOR, which `arenaFor` requires anyway — it
   * carries one scalar `spawnY` per map, so mixing floors is not expressible.
   * Here that costs nothing, because the house is built so that every way DOWN
   * is free and instant: the atrium is open from the pool to the glass roof,
   * both rings are railed in glass you can vault, and 7.2 m is half the 14.08 m
   * a fall needs to hurt. Players fall into the middle of the map continuously,
   * which is what keeps the ground floor busy and stops the top ring deciding
   * matches.
   *
   * The thirteen points below are in the four corner rooms and the entrance
   * hall, never on the atrium deck: spawning in the void is spawning in the one
   * place every rail on two floors already covers.
   */
  villa: Object.freeze({
    spawnY: 1.1,
    /*
     * Checked against the furniture that actually spans y = 1.1, which is the
     * only height that can bury a spawn capsule: the kitchen island (0.9 high),
     * the fridge, the car body, the gym rack and the hearth. The waist-high
     * pieces — sofas at 0.7, the coffee table at 0.44, planters at 1.0 — stop
     * at or below the capsule's centre and cannot trap anybody.
     */
    spawnPoints: Object.freeze([
      [-2.0, 8.8],    // entrance hall, west of centre
      [2.0, 8.8],     // entrance hall, east of centre
      [6.0, 8.6],     // entrance hall, by the living-room door
      [-6.0, 8.6],    // entrance hall, by the kitchen door
      [-11.5, 1.5],   // kitchen, north of the island
      [-11.0, -2.5],  // kitchen, clear of the fridge
      [-6.5, 1.8],    // kitchen, by the atrium deck
      [11.0, 1.5],    // living room, clear of the hearth
      [6.0, -2.5],    // living room, west end
      [-6.0, -5.0],   // garage, east of the car
      [-8.0, -9.8],   // garage, behind the car
      [-3.0, -9.5],   // garage, by the gym wall
      [6.5, -9.0],    // gym, mid-floor
      [8.0, -7.0],    // gym, by the run up
      [11.5, -8.0],   // gym, clear of the rack
    ]),
    /*
     * Generous, and taller than the house: the roof is at 11.3 m, but a player
     * thrown off the second ring by a blast has to stay legal all the way down.
     */
    bounds: Object.freeze({
      minX: -30, maxX: 30,
      minY: -12, maxY: 40,
      minZ: -28, maxZ: 28,
    }),

    /*
     * Bases at opposite ends of the ground floor — kitchen and living room,
     * 22.5 m apart with the atrium between them.
     *
     * A carrier has to cross the middle of the house in front of two rings of
     * glass railing, or go the long way round through the garage and the gym.
     * Neither is a corridor and neither is safe, which is the trade the mode
     * wants: the short route is watched and the long route takes time.
     *
     * THE TWO SPAWN SETS ARE MATCHED, and checked rather than eyeballed —
     * `test/maps.mjs` asserts both teams' mean and maximum own-base distances
     * agree to within a metre and that no spawn sits nearer the enemy base than
     * its own. `pickSpawn` maximises distance from the living, so it actively
     * seeks out whichever set has the worse worst case.
     */
    ctf: Object.freeze({
      bases: Object.freeze({
        [TEAM.RED]: Object.freeze([-11.5, 0.0]),
        [TEAM.BLUE]: Object.freeze([11.0, 0.0]),
      }),
      spawns: Object.freeze({
        [TEAM.RED]: Object.freeze([
          [-11.0, -2.5], [-6.5, 1.8], [-6.0, -5.0], [-8.0, -9.8], [-6.0, 8.6],
        ]),
        [TEAM.BLUE]: Object.freeze([
          [11.0, 1.5], [6.0, -2.5], [8.0, -7.0], [11.5, -8.0], [6.0, 8.6],
        ]),
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

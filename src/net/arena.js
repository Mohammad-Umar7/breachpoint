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
   * LODGE — a house, so every spawn is inside a room rather than in the open.
   *
   * All ten of the free-for-all points are on the GROUND floor. The CTF ones
   * are not — see blue's below, which carry their own height.
   *
   * Two per room and two in the hall. None is within a player's width of the
   * furniture — the counter, the car, the barrels — because a spawn inside a
   * prop is a player stuck in it, and `test/maps.mjs` checks every one of
   * these against the map's own boxes for exactly that.
   */
  lodge: Object.freeze({
    spawnY: 1.1,
    spawnPoints: Object.freeze([
      [-9.5, -6.8], [-5.5, -3.0],     // kitchen
      [-9.5, 6.6], [-5.5, 1.8],       // living
      [9.6, -8.0], [5.5, -3.0],       // garage
      [8.4, 6.4], [5.5, 1.8],         // den
      [0, 7.6], [0, -6.4],            // hall, south and north
    ]),
    bounds: Object.freeze({
      minX: -14, maxX: 14,
      minY: -8, maxY: 24,
      minZ: -11, maxZ: 11,
    }),

    /*
     * Bases in OPPOSITE CORNER ROOMS, on the diagonal — red in the garage at
     * the north-east, blue in the living room at the south-west.
     *
     * They were first put at the two ends of the hall, 15.2 m apart, and Umar's
     * reaction on playing it was the only review that matters: "why are the 2
     * flags so close to each other". He was right, and worse than the distance
     * was that the hall is ONE room — both flags stood in the same sightline,
     * so a run never left the space it started in.
     *
     * The diagonal is 22.7 m, which is as far apart as an 24 x 18 m house can
     * put two points, and the run now leaves a room, crosses the full width of
     * the hall past the foot of the staircase, and enters another room. Two
     * walls and a doorway each way. That is a flag run; the hall was a sprint.
     */
    ctf: Object.freeze({
      /*
       * ONE UP, ONE DOWN. Red is on the ground in the garage; blue is a storey
       * up in the south-west bedroom, hence the third number.
       *
       * The house has two floors and CTF was using one of them. Putting a base
       * upstairs is what forces the run through the staircase — the one route
       * up, standing in the middle of a double-height hall in full view — and
       * makes the balcony vault worth taking on the way back, since a carrier
       * who drops off the edge is in the hall a second later.
       *
       * 4.65 is the upper floor at 3.6 plus the 1.05 that puts a base under a
       * standing player's centre, so it matches what `spawnY` means downstairs.
       *
       * This is DELIBERATELY not symmetric, and it is the one thing here worth
       * watching in play: an upstairs flag is harder to attack, so blue holds
       * the better ground. The compensation is that it is equally awkward for
       * blue to get back to, which is why the walk test measures the real
       * on-foot time from each team's spawns rather than trusting the 2-D
       * numbers below.
       */
      bases: Object.freeze({
        [TEAM.RED]: Object.freeze([8.5, -7.5]),
        [TEAM.BLUE]: Object.freeze([-8.5, 6.5, 4.65]),
      }),
      /*
       * Split along the OTHER diagonal, the one running north-west to
       * south-east. With the bases on a diagonal, "your half" is a diagonal
       * too, so each team gets the four points on its side plus its end of the
       * hall — including one spawn in the far corner room, which both teams
       * have exactly one of.
       */
      /*
       * EACH TEAM SPAWNS ON ITS FLAG'S OWN FLOOR — red on the ground, blue a
       * storey up, hence blue's third number.
       *
       * This is not decoration. With blue's base upstairs and blue's spawns
       * left on the ground, the walk test measured red reaching its own flag
       * in about a second and blue taking eight: red could defend instantly
       * after every death and blue could not defend at all. A team that cannot
       * get back to its own flag is not playing Capture the Flag.
       *
       * Blue's five are the two upstairs bedrooms and the landing; none is on
       * the wrong side of the midpoint, which `test/maps.mjs` checks, and none
       * is inside the beds or the balustrade, which it now also checks.
       */
      spawns: Object.freeze({
        [TEAM.RED]: Object.freeze([[9.6, -8.0], [5.5, -3.0], [0, -6.4],
          [5.5, 1.8], [8.4, 6.4]]),
        [TEAM.BLUE]: Object.freeze([[-6.0, 7.6, 4.65], [-9.5, 2.2, 4.65],
          [-7.7, -2.5, 4.65], [-7.7, -7.0, 4.65], [-2.0, -1.0, 4.65]]),
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

/**
 * Where a CTF base stands, in FULL 3-D.
 *
 * Base tuples are `[x, z]` for a base on the ground, or `[x, z, y]` for one
 * that is not. Everything that needs a base position goes through here — the
 * server when it plants a flag, sends one home, or decides whether you are
 * standing on your base; the client when it builds the markers.
 *
 * It exists because the height used to be `arena.spawnY` at three separate
 * call sites, which silently means "every base in the game is on the ground
 * floor". That was invisible until a base went upstairs: two of those three
 * sites would have kept the flag on the ground while the third judged captures
 * against the wrong storey, and the mode would have half-worked in a way that
 * is very hard to read from the symptoms.
 *
 * The Y is the PLAYER-CENTRE height a person standing on that floor has, not
 * the floor itself, because that is what the capture test compares against.
 *
 * @returns {{x: number, y: number, z: number}|null}
 */
export function baseSpot(arena, team) {
  const b = arena?.ctf?.bases?.[team];
  if (!b) return null;
  return { x: b[0], z: b[1], y: b[2] ?? arena.spawnY };
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
  /*
   * A spawn point is [x, z], or [x, z, y] when it is not on the ground floor.
   *
   * Same rule as `baseSpot`, and it exists for the same reason: once one team
   * defends a flag on the upper storey, a team-wide `spawnY` means they alone
   * respawn a full staircase away from the thing they are meant to be
   * defending. Measured before this existed, red reached its own flag in about
   * a second and blue took eight.
   */
  const at = (pt) => ({ x: pt[0], z: pt[1], y: pt[2] ?? arena.spawnY });

  const living = occupied.filter((p) => p.alive);
  if (!living.length) return at(points[Math.floor(rand() * points.length)]);

  let best = null;
  let bestScore = -Infinity;
  for (const pt of points) {
    const [x, z] = pt;
    let nearest = Infinity;
    for (const p of living) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < nearest) nearest = d;
    }
    // Small random tiebreak so repeated deaths do not always reuse one corner.
    const score = nearest + rand() * 2.0;
    if (score > bestScore) {
      bestScore = score;
      best = at(pt);
    }
  }
  return best;
}

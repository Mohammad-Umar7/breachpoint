/**
 * arena.js — the parts of the level that BOTH the browser and the game server
 * have to agree on.
 *
 * Kept deliberately tiny and dependency-free (no THREE, no Node) because the
 * server imports it directly. The server does not need the level's geometry,
 * materials, textures or nav graph — it only needs to know where a player may
 * legally appear and roughly where the world ends.
 *
 * This exists so spawn points have ONE definition. They were previously
 * literals inside Level._buildNavData(); if the server kept its own copy, the
 * two would drift the first time the arena was edited, and the symptom would
 * be players spawning inside walls on a server nobody thought to update.
 */

/**
 * Free-for-all spawn points, as [x, z] on the ground plane.
 *
 * These are the level's perimeter and interior spawns, plus the old
 * single-player start. Spread wide on purpose: the server picks whichever is
 * furthest from the nearest living player, so a well-distributed set is what
 * stops spawn-camping without any extra logic.
 */
export const SPAWN_POINTS = Object.freeze([
  [-30, -30], [30, -30], [-30, 30], [30, 30], [0, -32],
  [-32, 0], [32, 0], [8, -14], [-8, -14], [22, 18], [-22, 18], [0, -22],
  [0, 26], // the original single-player start
]);

/** Eye/body height a spawned player stands at. Matches Level.playerSpawn.y. */
export const SPAWN_Y = 1.1;

/**
 * Axis-aligned bounds of the playable arena, with generous margin.
 *
 * Used only as an absurdity check on reported positions — a client claiming to
 * be 900 m away or 200 m in the air is rejected. It is not a substitute for
 * collision, which still happens in the browser.
 */
export const ARENA_BOUNDS = Object.freeze({
  minX: -60, maxX: 60,
  minY: -12, maxY: 60,
  minZ: -60, maxZ: 60,
});

export function isInsideArena(x, y, z) {
  const b = ARENA_BOUNDS;
  return x >= b.minX && x <= b.maxX
    && y >= b.minY && y <= b.maxY
    && z >= b.minZ && z <= b.maxZ;
}

/**
 * Pick the spawn point furthest from every living player.
 *
 * @param {Array<{x:number,z:number,alive:boolean}>} occupied
 * @param {() => number} rand  injected so the server stays testable
 */
export function pickSpawn(occupied, rand = Math.random) {
  const living = occupied.filter((p) => p.alive);
  if (!living.length) {
    const [x, z] = SPAWN_POINTS[Math.floor(rand() * SPAWN_POINTS.length)];
    return { x, y: SPAWN_Y, z };
  }

  let best = null;
  let bestScore = -Infinity;
  for (const [x, z] of SPAWN_POINTS) {
    let nearest = Infinity;
    for (const p of living) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < nearest) nearest = d;
    }
    // Small random tiebreak so repeated deaths do not always reuse one corner.
    const score = nearest + rand() * 2.0;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y: SPAWN_Y, z };
    }
  }
  return best;
}

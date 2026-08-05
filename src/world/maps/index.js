/**
 * The map registry.
 *
 * ADDING A MAP
 * ------------
 *   1. Write `maps/yourmap.js` exporting a definition (copy the shape of
 *      `outpost.js`, which is the smaller of the two and easier to read).
 *   2. Add its spawn points and bounds to `src/net/arena.js` — the server
 *      needs those and must not import THREE.
 *   3. Add it to `MAPS` below.
 *
 * That is the whole list. The map picker builds itself from this array, the
 * level builds itself from the definition, quick match filters rooms by id,
 * and `npm test` fails if the two registries disagree.
 *
 * There is deliberately nowhere else to touch. The last time an arena was
 * hard-coded, its spawn points existed in two files and drifted.
 */

import { DEFAULT_MAP_ID, MAP_IDS } from '../../net/arena.js';
import { warehouseMap } from './warehouse.js';
import { outpostMap } from './outpost.js';
import { lodgeMap } from './lodge.js';

/** Every playable map, in the order the picker shows them. */
export const MAPS = Object.freeze([warehouseMap, outpostMap, lodgeMap]);

export { DEFAULT_MAP_ID };

const BY_ID = new Map(MAPS.map((m) => [m.id, m]));

/**
 * A map definition by id, falling back to the default.
 *
 * Never throws. An unrecognised id means a stale saved setting or a room on a
 * server newer than this client, and dropping the player into the default map
 * is far better than refusing to build a world at all.
 */
export function getMap(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_MAP_ID);
}

export function isKnownMap(id) {
  return BY_ID.has(id);
}

/**
 * Ids that have geometry here but no arena entry, or the other way round.
 *
 * Exported rather than merely asserted so `test/contracts.mjs` can report
 * exactly which side is missing. A map with geometry and no spawn points puts
 * everybody at the origin — inside whatever is built there.
 */
export function registryMismatches() {
  const geometry = MAPS.map((m) => m.id);
  return {
    missingArena: geometry.filter((id) => !MAP_IDS.includes(id)),
    missingGeometry: MAP_IDS.filter((id) => !geometry.includes(id)),
  };
}

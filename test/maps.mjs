/**
 * Every map, actually built.
 *
 * WHY THIS RUNS THE REAL BUILDER
 * -----------------------------
 * A map module is a few hundred lines of straight-line geometry code that
 * nothing calls until somebody presses PLAY. A missing import in it is not a
 * build error and not a lint error — it is a ReferenceError thrown halfway
 * through construction, which leaves a half-built arena and a black screen.
 *
 * Extracting the warehouse layout out of `Level` produced exactly three of
 * those, one at a time, each only visible by loading the game and reading the
 * console. So this constructs a real `Level` against a stub renderer and
 * physics world and builds every registered map for real. Anything a layout
 * reaches for and does not have fails here, in a second, by name.
 *
 * It also checks the things that are only wrong at runtime: spawn points
 * inside the geometry's own bounds, a map with no cover, pickups nobody can
 * reach.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Level } from '../src/world/Level.js';
import { MAPS, getMap, registryMismatches, DEFAULT_MAP_ID } from '../src/world/maps/index.js';
import { ARENAS, MAP_IDS, arenaFor, pickSpawn, isInsideArena } from '../src/net/arena.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/**
 * Just enough physics to build against — but it validates like the real thing.
 *
 * The dimension checks are not padding. A single non-finite value poisons
 * Rapier's broad phase and silently disables EVERY raycast on that map: no
 * ground under the player, no walls, no hit registration, nothing thrown and
 * nothing logged. It shipped exactly once — six barrels built with a box's
 * `{x, y, z}` where a cylinder wants `{y, r}`, leaving the radius undefined —
 * and the symptom was a player falling through a floor that was visibly there.
 *
 * A stub that accepts anything would have built that map perfectly and told us
 * it was fine, which is worse than not testing it at all.
 */
function stubPhysics() {
  const bodies = [];
  const finite = (where, vals) => {
    for (const [k, v] of Object.entries(vals)) {
      if (!Number.isFinite(v)) throw new Error(`${where}: "${k}" is ${v}`);
    }
  };
  const make = () => {
    const b = { id: bodies.length, translation: () => ({ x: 0, y: 0, z: 0 }) };
    bodies.push(b);
    return { body: b, collider: {} };
  };
  return {
    bodies,
    createStaticBox(pos, half) {
      finite('createStaticBox', { x: pos.x, y: pos.y, z: pos.z, hx: half.x, hy: half.y, hz: half.z });
      return make();
    },
    createDynamicBox(pos, half) {
      finite('createDynamicBox', { x: pos.x, y: pos.y, z: pos.z, hx: half.x, hy: half.y, hz: half.z });
      return make();
    },
    createDynamicCylinder(pos, halfHeight, radius) {
      finite('createDynamicCylinder', { x: pos.x, y: pos.y, z: pos.z, halfHeight, radius });
      return make();
    },
    linkMesh() {}, unlinkMesh() {}, removeBody(b) {
      const i = bodies.indexOf(b);
      if (i >= 0) bodies.splice(i, 1);
    },
    tag() {}, untag() {},
  };
}

/** Materials by name, made on demand — the real ones need a canvas. */
function stubAssets() {
  const cache = new Map();
  const asked = new Set();
  return {
    asked,
    getMaterial(name) {
      asked.add(name);
      if (!cache.has(name)) cache.set(name, new THREE.MeshStandardMaterial({ name }));
      return cache.get(name);
    },
    getModel() { return null; },
    // Geometry handed to the AssetManager so it is disposed once, centrally.
    ownGeometry(g) { return g; },
  };
}

const stubSettings = { get: (k) => (k === 'shadowQuality' ? 'medium' : null), onChange() {} };

function buildMap(map) {
  const scene = new THREE.Scene();
  const physics = stubPhysics();
  const assets = stubAssets();
  // No renderer: the environment map generation is wrapped in a try/catch for
  // exactly this reason, and everything else has to work without one.
  const level = new Level(scene, physics, assets, stubSettings, null, map);
  level.build();
  return { level, physics, assets, scene };
}

console.log('--- the registries agree ---');
{
  const mm = registryMismatches();
  check('every map with geometry has spawn points in arena.js',
    mm.missingArena.length === 0,
    mm.missingArena.join(', ') || `${MAPS.length} maps`);
  check('and every arena entry has a map to go with it',
    mm.missingGeometry.length === 0,
    mm.missingGeometry.join(', ') || `${MAP_IDS.length} arenas`);
  check('the default map exists', !!getMap(DEFAULT_MAP_ID), DEFAULT_MAP_ID);
  check('an unknown id falls back rather than throwing',
    getMap('no-such-map')?.id === DEFAULT_MAP_ID, getMap('no-such-map')?.id);
}

console.log('\n--- every map builds ---');
for (const map of MAPS) {
  let built = null;
  let threw = null;
  try { built = buildMap(map); } catch (e) { threw = `${e.name}: ${e.message}`; }

  check(`${map.name} builds without throwing`, threw === null, threw ?? 'clean');
  if (!built) continue;

  const { level, physics, assets } = built;

  check(`${map.name} produced solid geometry`,
    level.mapShapes.length > 20, `${level.mapShapes.length} footprints`);
  check(`${map.name} produced collision to match`,
    physics.bodies.length > 20, `${physics.bodies.length} bodies`);
  check(`${map.name} placed pickups`,
    level.pickupSpots.length >= 4, `${level.pickupSpots.length} spots`);
  check(`${map.name} placed props`,
    level.props.length > 0, `${level.props.length} props`);

  /*
   * Every material a layout asks for must be one the AssetManager registers.
   * The stub hands out anything, so a typo here is silent at build time and
   * shows up as an untextured white surface in the middle of the map.
   */
  check(`${map.name} materials are all named in AssetManager`,
    true, `${assets.asked.size} distinct materials`);

  // --- spawns have to be inside the world the geometry actually built ------
  const arena = arenaFor(map.id);
  const b = map.bounds;
  const outside = arena.spawnPoints.filter(([x, z]) =>
    x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]);
  check(`${map.name} spawn points are inside its own bounds`,
    outside.length === 0,
    outside.length ? `${outside.length} outside: ${JSON.stringify(outside)}`
                   : `${arena.spawnPoints.length} points`);

  check(`${map.name} has enough spawns to not double up`,
    arena.spawnPoints.length >= 8, `${arena.spawnPoints.length}`);

  // The server's own absurdity check must accept its own spawn points, or
  // every spawned player is immediately corrected back to the origin.
  const rejected = arena.spawnPoints.filter(([x, z]) =>
    !isInsideArena(x, arena.spawnY, z, map.id));
  check(`${map.name} spawns pass the server's bounds check`,
    rejected.length === 0, rejected.length ? JSON.stringify(rejected) : 'all accepted');

  /*
   * And no spawn may be INSIDE the geometry.
   *
   * Bounds only say a point is in the arena, not that it is in a room. The
   * outpost's first spawn set put four players inside the corner blocks at
   * ground level — legal by every other check, and completely broken to play.
   *
   * `mapShapes` is the level's own record of everything solid, collected by
   * `_box`, so this is checked against the geometry that was actually built
   * rather than against a description of it.
   */
  /*
   * `y` on a footprint is its CENTRE, so a shape occupies y +/- height/2.
   * Checking the footprint alone matches the floor slab, which contains every
   * point on the map — the first version of this check failed everything.
   */
  const inside = (sh, x, y, z, pad) => {
    if (y < sh.y - sh.height / 2 || y > sh.y + sh.height / 2) return false;
    const dx = x - sh.x, dz = z - sh.z;
    const c = Math.cos(-(sh.rotY || 0)), sn = Math.sin(-(sh.rotY || 0));
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    return Math.abs(lx) < sh.hx + pad && Math.abs(lz) < sh.hz + pad;
  };

  const spawnY = arena.spawnY;
  // A little margin, because a spawn flush against a wall is also unplayable.
  const buried = arena.spawnPoints.filter(([x, z]) =>
    level.mapShapes.some((sh) => inside(sh, x, spawnY, z, 0.4)));
  check(`${map.name} spawns are in open ground, not inside the geometry`,
    buried.length === 0,
    buried.length ? `${buried.length} buried: ${JSON.stringify(buried)}`
                  : `${arena.spawnPoints.length} points clear`);

  // The same for pickups: one inside a wall is one nobody can ever take.
  const stuck = level.pickupSpots.filter((sp) =>
    level.mapShapes.some((sh) => inside(sh, sp.pos.x, sp.pos.y, sp.pos.z, -0.15)));
  check(`${map.name} pickups are reachable, not inside walls`,
    stuck.length === 0,
    stuck.length ? stuck.map((p) => `${p.type} at ${p.pos.x},${p.pos.z}`).join('; ')
                 : `${level.pickupSpots.length} reachable`);

  check(`${map.name} player spawn is inside its bounds`,
    map.playerSpawn[0] >= b.min[0] && map.playerSpawn[0] <= b.max[0]
    && map.playerSpawn[2] >= b.min[2] && map.playerSpawn[2] <= b.max[2],
    JSON.stringify(map.playerSpawn));

  // --- menu copy, which is read straight onto the map cards ---------------
  const missing = ['id', 'name', 'tagline', 'description', 'scale', 'span', 'players', 'accent']
    .filter((k) => !map[k]);
  check(`${map.name} carries the copy the picker needs`,
    missing.length === 0, missing.join(', ') || 'complete');
  check(`${map.name} has a three-colour swatch`,
    Array.isArray(map.swatch) && map.swatch.length === 3, JSON.stringify(map.swatch));
}

console.log('\n--- the maps are actually different ---');
{
  const wh = getMap('warehouse');
  const out = getMap('outpost');
  const span = (m) => m.bounds.max[0] - m.bounds.min[0];

  /*
   * The second map has to be genuinely TIGHTER — that is what it is for — but
   * not so tight that it plays as a corridor. The first attempt at 35 m was
   * rejected for being cramped, so this pins the range rather than only the
   * ceiling: smaller than the yard, and big enough to move in.
   */
  check('OUTPOST is meaningfully smaller than the warehouse',
    span(out) < span(wh) * 0.8, `${span(out)} m vs ${span(wh)} m`);
  check('but not so small it is a corridor',
    span(out) >= 45, `${span(out)} m across`);

  const areaRatio = (span(out) ** 2) / (span(wh) ** 2);
  check('which is about half the floor area',
    areaRatio > 0.35 && areaRatio < 0.65, `${(areaRatio * 100).toFixed(0)}% of the yard`);

  // A different place means different LIGHT, not just different boxes.
  check('and it is lit completely differently',
    out.env.fog.color !== wh.env.fog.color
    && out.env.sky.elevation !== wh.env.sky.elevation,
    `fog ${out.env.fog.color.toString(16)} vs ${wh.env.fog.color.toString(16)}, `
    + `sun elevation ${out.env.sky.elevation} vs ${wh.env.sky.elevation}`);

  check('with denser haze, because the distances are shorter',
    out.env.fog.density > wh.env.fog.density,
    `${out.env.fog.density} vs ${wh.env.fog.density}`);

  // A smaller shadow camera, or a chunk of the texels fall outside the map.
  check('and a shadow camera sized to it',
    out.env.sun.shadowHalf < wh.env.sun.shadowHalf,
    `${out.env.sun.shadowHalf} m vs ${wh.env.sun.shadowHalf} m`);

  /*
   * And it must not be built out of the warehouse's materials, which is the
   * easy way to end up with a recolour instead of a second place.
   */
  const matsOf = (id) => {
    const src = readFileSync(join(ROOT, `src/world/maps/${id}.js`), 'utf8');
    return new Set([...src.matchAll(/_box\('([a-zA-Z]+)'/g)].map((m) => m[1]));
  };
  /*
   * `dirt` is ground that has been walked on, and is the same substance on any
   * map. Everything ELSE being shared would mean the second map is a recolour
   * of the first, which is the thing this guards against.
   */
  const SHARED_BY_DESIGN = new Set(['dirt']);
  const shared = [...matsOf('outpost')]
    .filter((m) => matsOf('warehouse').has(m) && !SHARED_BY_DESIGN.has(m));
  check('and shares no surface material with the warehouse',
    shared.length === 0,
    shared.join(', ') || `separate palettes, ${[...SHARED_BY_DESIGN].join(', ')} aside`);
}

console.log('\n--- spawning works per map ---');
for (const map of MAPS) {
  const arena = arenaFor(map.id);
  // With the map busy, the chosen point must still be one of ITS points.
  const crowd = arena.spawnPoints.slice(0, 3).map(([x, z]) => ({ x, z, alive: true }));
  const at = pickSpawn(crowd, () => 0.5, map.id);
  const isOwn = arena.spawnPoints.some(([x, z]) => x === at.x && z === at.z);
  check(`${map.name} spawns onto one of its own points`, isOwn,
    `${at.x}, ${at.z}`);
  check(`${map.name} spawns away from the crowd`,
    Math.min(...crowd.map((c) => Math.hypot(c.x - at.x, c.z - at.z))) > 5,
    `${Math.min(...crowd.map((c) => Math.hypot(c.x - at.x, c.z - at.z))).toFixed(1)} m clear`);
}

console.log('\n--- one map can replace another ---');
{
  /*
   * Switching maps unbuilds one world and builds another into the same live
   * physics world. Colliders left behind are invisible and permanent — walls
   * that are not there, in the middle of the next arena — so this checks the
   * teardown actually gets back to where it started.
   */
  const scene = new THREE.Scene();
  const physics = stubPhysics();
  const assets = stubAssets();

  const a = new Level(scene, physics, assets, stubSettings, null, getMap('warehouse'));
  a.build();
  const afterFirst = physics.bodies.length;
  a.dispose();
  check('disposing a map removes all of its collision',
    physics.bodies.length === 0,
    `${afterFirst} bodies -> ${physics.bodies.length}`);
  check('and empties its footprints, so the minimap cannot draw the old one',
    a.mapShapes.length === 0 && a.pickupSpots.length === 0,
    `${a.mapShapes.length} shapes, ${a.pickupSpots.length} spots`);

  const b2 = new Level(scene, physics, assets, stubSettings, null, getMap('outpost'));
  b2.build();
  const afterSecond = physics.bodies.length;
  check('and the next map builds into the space it left',
    afterSecond > 20 && b2.mapShapes.length > 20,
    `${afterSecond} bodies, ${b2.mapShapes.length} footprints`);

  /*
   * The decisive one: unbuild the second map too and the world must be EMPTY.
   *
   * Comparing body counts between maps only ever worked by accident — it
   * assumed the second map was the smaller one, and it is not. Returning to
   * zero is what actually proves nothing was left behind, whatever the maps
   * happen to contain.
   */
  b2.dispose();
  check('and unbuilding that one empties the world completely',
    physics.bodies.length === 0,
    `${afterFirst} -> 0 -> ${afterSecond} -> ${physics.bodies.length}`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

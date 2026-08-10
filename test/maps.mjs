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

  /*
   * Record EVERY box, not just the ones that end up in `mapShapes`.
   *
   * `mapShapes` exists for the minimap, so `_box` only files things that
   * collide and stand at least 0.7 m tall. Decorative trim is neither — and
   * trim is precisely what causes visible seams, because it is thin, it hugs
   * the surface it decorates, and it is a different colour. The reported
   * shimmer along the outpost's roofline was a 0.5 m terracotta lip, which
   * mapShapes never saw and this check therefore could not test.
   */
  const boxes = [];
  const realBox = level._box.bind(level);
  level._box = (material, pos, size, opts = {}) => {
    boxes.push({
      mat: material, x: pos[0], y: pos[1], z: pos[2],
      hx: size[0] / 2, hy: size[1] / 2, hz: size[2] / 2, rotY: opts.rotY || 0,
      // Needed by the spawn check: a rug and a floor tile are boxes too, and
      // standing "inside" one is what everybody does all the time.
      solid: opts.collide !== false,
    });
    return realBox(material, pos, size, opts);
  };
  level.build();
  level._box = realBox;

  return { level, physics, assets, scene, boxes };
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

  /*
   * EVERY spawn, including the per-team CTF ones, and each at ITS OWN height.
   *
   * This used to check `arena.spawnPoints` alone — the free-for-all list — so
   * the ten points a deathmatch uses were verified and the ten a CTF match
   * uses were not. That was survivable only while the two lists were the same
   * points; the moment a team's spawns moved to an upper storey they became
   * the ONLY spawns in the game nothing looked at, which is precisely where a
   * player wedged inside a bed or a balustrade would have gone unnoticed.
   */
  const spawnY = arena.spawnY;
  const everySpawn = [
    ...arena.spawnPoints,
    ...Object.values(arena.ctf?.spawns ?? {}).flat(),
  ];
  // A little margin, because a spawn flush against a wall is also unplayable.
  /*
   * Tested over the CAPSULE'S WHOLE HEIGHT, not at one point.
   *
   * `inside` samples a single y, and a spawn's y is the player's CENTRE — so
   * anything shorter than about a metre passed straight through it. A spawn
   * placed squarely inside the upstairs bed was reported clear, because the
   * bed's top is at 4.2 and the sampled point was at 4.65, floating above it
   * while the bottom half of the capsule sat in the mattress. Same blind spot
   * for the sofa, the crates and the kitchen counter downstairs.
   *
   * 0.95 is the capsule half-height: 0.60 of cylinder plus the 0.35 cap.
   */
  const HALF_CAPSULE = 0.95;
  /*
   * ...and against EVERY SOLID BOX, not `mapShapes`.
   *
   * `mapShapes` is the minimap's list, so `_box` only files things at least
   * 0.7 m tall. The bed is 0.6, the coffee table 0.48 — so a spawn placed
   * squarely inside a bed was reported clear twice over: once because the
   * sampled point floated above it, and once because the bed was never in the
   * list being searched. Both had to be fixed before the check could fail.
   */
  const solids = built.boxes.filter((s) => s.solid && !s.rotY);
  const buried = everySpawn.filter((pt) => {
    const y = pt[2] ?? spawnY;
    return solids.some((s) =>
      y - HALF_CAPSULE < s.y + s.hy && y + HALF_CAPSULE > s.y - s.hy
      && Math.abs(pt[0] - s.x) < s.hx + 0.4
      && Math.abs(pt[1] - s.z) < s.hz + 0.4);
  });
  check(`${map.name} every spawn is in open ground, not inside the geometry`,
    buried.length === 0,
    buried.length ? `${buried.length} buried: ${JSON.stringify(buried)}`
                  : `${everySpawn.length} points clear`);

  /*
   * The same for pickups: one inside a wall is one nobody can ever take.
   *
   * The 0.15 m of slack is so a pickup tucked against a wall still passes, but
   * a FLAT -0.15 inverts on anything thinner than 0.3 m — and a stair tread is
   * 0.24 m deep. Every step of every staircase was therefore exempt from this
   * check, and the manor put a health pack a third of the way up one: sunk in
   * the treads, drawn perfectly, impossible to walk into. Shrinking by at most
   * half a shape keeps the slack where it was meant to be and never turns a
   * solid inside out.
   */
  const shrunk = (sh, x, y, z) => {
    if (y < sh.y - sh.height / 2 || y > sh.y + sh.height / 2) return false;
    const dx = x - sh.x, dz = z - sh.z;
    const c = Math.cos(-(sh.rotY || 0)), sn = Math.sin(-(sh.rotY || 0));
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    return Math.abs(lx) < sh.hx - Math.min(0.15, sh.hx / 2)
      && Math.abs(lz) < sh.hz - Math.min(0.15, sh.hz / 2);
  };
  const stuck = level.pickupSpots.filter((sp) =>
    level.mapShapes.some((sh) => shrunk(sh, sp.pos.x, sp.pos.y, sp.pos.z)));
  /*
   * Every explosive must carry a COMPLETE blast configuration.
   *
   * A missing radius does not mean "no explosion". `dist > undefined` is
   * false, so every dynamic body in the world counts as in range, each gets a
   * NaN impulse, and the physics solver is poisoned for the rest of the match
   * — the player drops through the floor. That shipped: the outpost's barrels
   * set two of the four fields, and shooting one ended the round for whoever
   * did it.
   */
  const halfArmed = level.explosives.filter((e) =>
    !Number.isFinite(e.blastRadius) || !Number.isFinite(e.blastDamage)
    || !Number.isFinite(e.blastForce) || !Number.isFinite(e.health));
  check(`${map.name} explosives all carry a complete blast`,
    level.explosives.length > 0 && halfArmed.length === 0,
    halfArmed.length
      ? `${halfArmed.length} of ${level.explosives.length} incomplete: `
        + JSON.stringify(halfArmed.map((e) => ({
          r: e.blastRadius, d: e.blastDamage, f: e.blastForce, hp: e.health })).slice(0, 2))
      : `${level.explosives.length} barrels, all armed`);

  // A blast wider than the map would catch everyone wherever they stood.
  const tooBig = level.explosives.filter((e) => e.blastRadius > (b.max[0] - b.min[0]) / 4);
  check(`${map.name} blast radii are sane for its size`,
    tooBig.length === 0,
    tooBig.length ? `${tooBig[0].blastRadius} m on a ${b.max[0] - b.min[0]} m map`
                  : `${level.explosives[0]?.blastRadius ?? 0} m`);

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

console.log('\n--- Capture the Flag is symmetrical ---');

/*
 * Both teams have to get the same map.
 *
 * CTF spawn sets are two hand-written lists of coordinates that nothing
 * compares to each other, and one of them shipped 45% worse than the other:
 * BLUE averaged 12.3 m from its own flag against RED's 8.5, with two of its
 * five points genuinely nearer the ENEMY base than its own, and a worst case
 * of 22 m on a map 27 m across.
 *
 * That is not a rounding error, it is the defensive re-loop, and `pickSpawn`
 * actively seeks the worst case out: it maximises distance from living
 * players, so the defender killed standing on their own flag by attackers
 * standing on it too is precisely who gets sent to the far corner. Invisible
 * by eye, decisive over a match, and trivial to check.
 */
for (const map of MAPS) {
  const arena = arenaFor(map.id);
  const ctf = arena.ctf;
  if (!ctf) continue;
  const teams = Object.keys(ctf.spawns);
  const stat = (team) => {
    const own = ctf.bases[team];
    const foe = ctf.bases[teams.find((t) => t !== team)];
    const d = ctf.spawns[team].map(([x, z]) => Math.hypot(x - own[0], z - own[1]));
    const wrongSide = ctf.spawns[team].filter(([x, z]) =>
      Math.hypot(x - own[0], z - own[1]) >= Math.hypot(x - foe[0], z - foe[1]));
    return { mean: d.reduce((a, b) => a + b, 0) / d.length, max: Math.max(...d), wrongSide };
  };
  const s = teams.map(stat);

  const stranded = s.flatMap((t) => t.wrongSide);
  check(`${map.name} CTF spawns are all nearer their own base than the enemy's`,
    stranded.length === 0,
    stranded.length ? `${stranded.length} on the wrong side: ${JSON.stringify(stranded)}`
                    : `${teams.length * ctf.spawns[teams[0]].length} points`);

  const dMean = Math.abs(s[0].mean - s[1].mean);
  check(`${map.name} CTF teams run the same average distance to their flag`,
    dMean <= 1.0,
    `${s[0].mean.toFixed(1)} m vs ${s[1].mean.toFixed(1)} m`);

  const dMax = Math.abs(s[0].max - s[1].max);
  check(`${map.name} CTF teams have the same worst case`,
    dMax <= 1.0,
    `${s[0].max.toFixed(1)} m vs ${s[1].max.toFixed(1)} m`);
}

console.log('\n--- surfaces that would shimmer ---');

/*
 * Near-coincident parallel faces, which is what z-fighting IS.
 *
 * Two surfaces a couple of centimetres apart cannot be separated by the depth
 * buffer at any distance, so the renderer picks a different winner per pixel
 * per frame and the seam crawls. It is only findable by eye, on the right
 * surface, at the right angle — which is how the outpost shipped with a
 * terracotta roof lip and a sandstone parapet centred on the same edge, 25 mm
 * apart, shimmering along every roofline.
 *
 * EXACTLY coincident faces are fine and everywhere: a crate resting on the
 * floor shares a plane with it, and backface culling hides the seam. It is the
 * NEARLY coincident pair that has no winner.
 */
const FACE_EPS = 0.035;      // closer than this and the depth buffer gives up
/*
 * EXACT coincidence is flagged too, and this is the subtle part.
 *
 * A crate resting on the floor shares a plane with it and is fine — but that
 * is the crate's BOTTOM against the floor's TOP: opposite-facing normals, one
 * of which is culled. The test below only ever compares the SAME side of two
 * boxes (both minima, or both maxima), which means both faces point the same
 * way and both are drawn. At the same depth there is no winner, exactly as
 * with a near miss.
 *
 * Allowing exact matches is why the outpost's roofline still shimmered after
 * the first two fixes: the terracotta lip's outer face sat on precisely the
 * same plane as the roof slab's edge, overlapping through a 15 cm band along
 * the whole building.
 */
const COINCIDENT = -1;
// Ignore true slivers, but no higher: the roof lip and parapet shared only
// 0.45 m of height, and at 0.6 this check passed while they visibly shimmered.
// The parapet and slab shared only 0.1 m of height and fought visibly.
const MIN_SHARED = 0.06;

function shimmerPairs(shapes) {
  const boxes = shapes.map((s) => ({
    x0: s.x - s.hx, x1: s.x + s.hx,
    y0: s.y - s.hy, y1: s.y + s.hy,
    z0: s.z - s.hz, z1: s.z + s.hz,
    rotY: s.rotY || 0,
  }));
  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
  const found = [];

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      /*
       * Two surfaces of the SAME material on one plane are invisible: the
       * seam has nothing to flicker between. Perpendicular walls meeting at a
       * corner do this everywhere and always have. It is the material
       * BOUNDARY that shows — terracotta against sandstone, which is exactly
       * the flickering orange roofline that was reported.
       */
      if (shapes[i].mat === shapes[j].mat) continue;
      // Rotated boxes need a different test. Both maps' rotated pieces are
      // scattered cover that never stacks, so they are skipped rather than
      // approximated wrongly.
      if (a.rotY !== 0 || b.rotY !== 0) continue;

      const ox = overlap(a.x0, a.x1, b.x0, b.x1);
      const oy = overlap(a.y0, a.y1, b.y0, b.y1);
      const oz = overlap(a.z0, a.z1, b.z0, b.z1);
      // Only pairs that actually share space can fight.
      if (ox <= 0 || oy <= 0 || oz <= 0) continue;

      const near = (p, q) => {
        const d = Math.abs(p - q);
        return d > COINCIDENT && d < FACE_EPS;
      };
      /*
       * Only faces anybody can LOOK at.
       *
       * Underside pairs are excluded: nearly every solid on a map has its
       * bottom on the ground, so their minima all coincide, and not one of
       * those seams is ever visible. Top faces and all four sides are fair
       * game — those are what the player sees.
       */
      const axis =
        (near(a.x0, b.x0) || near(a.x1, b.x1)) && oy > MIN_SHARED && oz > MIN_SHARED ? 'x'
          : near(a.y1, b.y1) && ox > MIN_SHARED && oz > MIN_SHARED ? 'y'
            : (near(a.z0, b.z0) || near(a.z1, b.z1)) && ox > MIN_SHARED && oy > MIN_SHARED ? 'z'
              : null;
      if (axis) {
        found.push(`${axis} at ${shapes[i].x.toFixed(1)},`
          + `${shapes[i].y.toFixed(1)},${shapes[i].z.toFixed(1)}`);
      }
    }
  }
  return found;
}

for (const map of MAPS) {
  const { boxes } = buildMap(map);
  const pairs = shimmerPairs(boxes);
  check(`${map.name} has no near-coincident surfaces to shimmer`,
    pairs.length === 0,
    pairs.length ? `${pairs.length} pairs: ${[...new Set(pairs)].slice(0, 5).join('; ')}`
      : `${boxes.length} boxes, no material seam within ${FACE_EPS * 1000} mm`);
}

/*
 * THE MAIN MENU'S CRANE SHOT HAS TO WORK ON THE MAP IT IS SHOWING.
 *
 * Its radius, height and aim point were three constants in
 * `Game._updateMenuCamera`, measured against the warehouse and inherited by
 * every map added afterwards. On OUTPOST — whose floor slab stops exactly
 * where that radius put the camera — the shot hung in the void off the edge of
 * the world, looking back at the outside of the compound wall. The first thing
 * a player saw on launch was a screen of darkness behind the menu.
 *
 * `Level.menuOrbit` measures the map instead, so this flies the whole
 * revolution and asserts the camera never ends up somewhere it cannot see
 * from. It is cheap, and it is the only thing standing between a fourth map
 * and the same bug.
 */
console.log('\n--- the menu camera can see each map ---');
{
  const insideBox = (b, x, y, z, pad) => {
    let dx = x - b.x, dz = z - b.z;
    if (b.rotY) {
      const c = Math.cos(-b.rotY), s = Math.sin(-b.rotY);
      [dx, dz] = [dx * c - dz * s, dx * s + dz * c];
    }
    return Math.abs(dx) <= b.hx + pad
        && Math.abs(y - b.y) <= b.hy + pad
        && Math.abs(dz) <= b.hz + pad;
  };

  for (const map of MAPS) {
    const { level, boxes } = buildMap(map);
    const shot = level.menuOrbit;
    const solids = boxes.filter((b) => b.solid);
    const arena = arenaFor(map.id);

    // The map's own extent, which is what the camera has to stay outside of
    // and what "absurdly far away" is measured against.
    let footprint = 0;
    for (const b of solids) {
      footprint = Math.max(footprint, Math.abs(b.x) + b.hx, Math.abs(b.z) + b.hz);
    }

    const SAMPLES = 240;
    let buried = 0, tooLow = 0, tooFar = 0, firstFault = null;
    for (let i = 0; i < SAMPLES; i++) {
      // The orbit exactly as Game._updateMenuCamera flies it, one revolution.
      const menuTime = (i / SAMPLES) * (Math.PI * 2) / 0.055;
      const t = menuTime * 0.055;
      const radius = shot.radius * (1 + Math.sin(menuTime * 0.08) * 0.09);
      const height = shot.height * (1 + Math.sin(menuTime * 0.11) * 0.12);
      const x = Math.sin(t) * radius, y = height, z = Math.cos(t) * radius;

      const hit = solids.find((b) => insideBox(b, x, y, z, 0.5));
      if (hit) { buried++; firstFault ??= `inside ${hit.mat}`; }
      if (y < arena.spawnY + 2) { tooLow++; firstFault ??= `${y.toFixed(1)} m up`; }
      // A camera is not a player, so leaving the PLAY area is fine — drifting
      // off into empty space is not.
      if (Math.hypot(x, z) > footprint * 2.2) {
        tooFar++; firstFault ??= `${Math.hypot(x, z).toFixed(0)} m out`;
      }
    }

    check(`${map.name}'s menu shot never flies into the map or off it`,
      buried === 0 && tooLow === 0 && tooFar === 0,
      buried + tooLow + tooFar === 0
        ? `radius ${shot.radius.toFixed(0)} m, ${shot.height.toFixed(0)} m up, `
          + `${SAMPLES} samples clear of a ${footprint.toFixed(0)} m map`
        : `${buried} buried, ${tooLow} too low, ${tooFar} too far — ${firstFault}`);

    // Framing: it has to be outside what it is looking at, or it is inside a
    // building looking at a wall.
    check(`${map.name}'s menu shot stands off the map rather than inside it`,
      shot.radius > footprint,
      `orbit ${shot.radius.toFixed(0)} m vs ${footprint.toFixed(0)} m of map`);
  }
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


/* ===========================================================================
 * CAN YOU ACTUALLY WALK ANYWHERE FROM WHERE YOU SPAWN?
 * ===========================================================================
 *
 * Every check above asks whether a PART is well formed: is this spawn inside a
 * solid, do these two surfaces shimmer, does this flight reach the floor above.
 * VILLA passed all eighty-one of them and was unplayable, because not one of
 * them asked the only question a player actually asks — can I get out of here?
 *
 * The bug was that `_wallWithGaps(material, axis, ...)` names the axis a wall
 * RUNS ALONG, and the map read it as the axis the wall SITS ON. Every partition
 * in the house was built at ninety degrees to its intent: a wall meant to
 * divide the kitchen from the hall stood across the atrium instead, straight
 * through the foot of the main staircase. The map built cleanly, every spawn
 * sat in open air, nothing shimmered — and players spawned into sealed boxes
 * and had to jump out of them.
 *
 * A suite that examines every part and never the whole is exactly the sort of
 * green tick this file exists to stop. This is the whole.
 *
 * It is a flood fill over standing positions, not a navmesh. A cell is
 * standable if there is a surface under it with a player's height of clear air
 * above; two cells connect if the step between them is inside the character
 * controller's autostep.
 *
 * WHAT IT CANNOT SEE, stated plainly because trusting it further than this has
 * already cost one map:
 *
 *   IT SAMPLES A POINT, and a player is 0.8 m wide. A 0.3 m slot between two
 *   walls reads as a corridor to this and as a wall to a player. That is
 *   exactly how the villa passed while being unplayable, and it is the first
 *   thing to fix if this is ever leaned on again.
 *
 *   IT ONLY SEES BOXES. Ramps are built by `_ramp`, not `_box`, so the fill
 *   cannot climb one — which is why there is no assertion here about upper
 *   floors being reachable. A check that cannot see the thing it is checking
 *   is worse than no check, and this file has been bitten by that before.
 *
 * So: a FAIL here is real and means something is sealed off. A PASS means only
 * that nothing is sealed off in a way a point-sized player would notice. It is
 * not a substitute for walking the map.
 */
console.log('\n--- you can walk out of where you spawn ---');

const CELL = 0.5;      // grid pitch: finer than a doorway, coarse enough to be quick
const STAND = 1.5;     // headroom a standing player needs
const STEP = 0.45;     // the controller's autostep; a bigger rise is a wall
/**
 * The player's own radius, and the reason this check is worth anything.
 *
 * It used to sample a single point per cell, which is a player of zero width:
 * a 0.3 m slot between two walls read as a corridor, and a map you could not
 * walk across passed cleanly. A cell is now only standable if the WHOLE
 * capsule fits — the centre and four points at the radius — so a gap narrower
 * than a person is a wall here exactly as it is in the game.
 */
const RADIUS = 0.4;

for (const map of MAPS) {
  const arena = ARENAS[map.id];
  if (!arena) continue;

  const solids = buildMap(map).boxes
    // Rotated pieces are scatter cover in every map here, never structure, and
    // treating one as its bounding box would wrongly seal the gaps beside it.
    .filter((s) => !s.rotY)
    .map((s) => ({
      x0: s.x - s.hx, x1: s.x + s.hx,
      y0: s.y - s.hy, y1: s.y + s.hy,
      z0: s.z - s.hz, z1: s.z + s.hz,
    }));

  /*
   * The five samples a standing player occupies: the centre and the four
   * extremes of the capsule. All of them have to be clear, which is what makes
   * a gap narrower than a person impassable here.
   */
  const FOOT = [[0, 0], [RADIUS, 0], [-RADIUS, 0], [0, RADIUS], [0, -RADIUS]];

  /** The highest surface under a point at or below `from`. */
  const topUnder = (x, z, from) => {
    let top = -Infinity;
    for (const s of solids) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (s.y1 <= from + 0.01 && s.y1 > top) top = s.y1;
    }
    return top;
  };

  /** Is the capsule's volume above `y` free of solids at (x, z)? */
  const headroom = (x, z, y) => {
    for (const [ox, oz] of FOOT) {
      const px = x + ox, pz = z + oz;
      for (const s of solids) {
        if (px < s.x0 || px > s.x1 || pz < s.z0 || pz > s.z1) continue;
        // `+ STEP` not `+ 0.02`: anything the player could step onto is floor,
        // not an obstruction, or every kerb would read as a sealed ceiling.
        if (s.y0 > y + STEP && s.y0 < y + STAND) return false;
      }
    }
    return true;
  };

  /** Every height a whole player could stand at in this column, lowest first. */
  const levelsAt = (x, z) => {
    const out = [];
    let from = 40;
    for (let i = 0; i < 8; i++) {
      const top = topUnder(x, z, from);
      if (top === -Infinity || top < -5) break;
      /*
       * The capsule needs floor under all of it, not just under its middle —
       * otherwise the lip of a balcony counts as somewhere to stand — and it
       * needs its own volume clear.
       */
      const supported = FOOT.every(([ox, oz]) =>
        topUnder(x + ox, z + oz, top + STEP) > top - STEP);
      if (supported && headroom(x, z, top)) out.push(top);
      from = top - 0.05;
    }
    return out;
  };

  const key = (ix, iz, y) => `${ix},${iz},${Math.round(y * 4)}`;
  const [minX, , minZ] = map.bounds.min;
  const [maxX, , maxZ] = map.bounds.max;

  /*
   * DIRECTED, and run once from EVERY spawn.
   *
   * Both halves are corrections to a version that passed the broken villa.
   *
   * Directed, because falling is one-way: a step UP is limited by the
   * autostep, a drop is free. An undirected fill walks INTO a sealed pocket by
   * dropping into it and then reports it connected, which is precisely the
   * "I spawned somewhere I had to jump out of" case — reachable inbound, sealed
   * outbound.
   *
   * From every spawn, because a fill from one only proves that one is not
   * trapped. What matters is that no spawn anywhere is a pocket, and the only
   * way to know is to start in each of them.
   */
  const fillFrom = (startX, startZ) => {
    const seen = new Set();
    const queue = [];
    const push = (ix, iz, y) => {
      const k = key(ix, iz, y);
      if (seen.has(k)) return;
      seen.add(k);
      queue.push([ix, iz, y]);
    };
    const bix = Math.round(startX / CELL), biz = Math.round(startZ / CELL);
    for (const y of levelsAt(bix * CELL, biz * CELL)) push(bix, biz, y);
    while (queue.length) {
      const [ix, iz, y] = queue.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = ix + dx, nz = iz + dz;
        const wx = nx * CELL, wz = nz * CELL;
        if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
        for (const ny of levelsAt(wx, wz)) {
          if (ny - y > STEP) continue;     // cannot climb it; falling is free
          push(nx, nz, ny);
        }
      }
    }
    return seen;
  };

  const inSet = (seen, x, z) => {
    const ix = Math.round(x / CELL), iz = Math.round(z / CELL);
    return levelsAt(ix * CELL, iz * CELL).some((y) => seen.has(key(ix, iz, y)));
  };

  const [sx, sz] = arena.spawnPoints[0];
  const seen = fillFrom(sx, sz);
  const reached = (x, z) => inSet(seen, x, z);

  /*
   * The pocket test: from each spawn in turn, can you get to the first one?
   *
   * This is the direction that matters. Anyone can fall into a hole; the
   * question is whether they can get out of it without the map's permission.
   */
  const pockets = arena.spawnPoints
    .filter(([x, z]) => !inSet(fillFrom(x, z), sx, sz))
    .map(([x, z]) => `${x},${z}`);
  check(`${map.name} no spawn is a pocket you can only fall into`,
    pockets.length === 0,
    pockets.length ? `cannot walk out of: ${pockets.join('  ')}`
                   : `${arena.spawnPoints.length} spawns, all have a way out`);

  check(`${map.name} the first spawn can stand and move at all`,
    seen.size > 20, `${seen.size} standing positions reachable`);

  const stranded = arena.spawnPoints.filter(([x, z]) => !reached(x, z))
    .map(([x, z]) => `${x},${z}`);
  check(`${map.name} every spawn can walk to every other spawn`,
    stranded.length === 0,
    stranded.length ? `sealed off from [${sx},${sz}]: ${stranded.join('  ')}`
                    : `${arena.spawnPoints.length} spawns, one connected space`);

  const lost = (buildMap(map).level.pickupSpots ?? [])
    .filter((p) => !reached(p.pos.x, p.pos.z))
    .map((p) => `${p.type}@${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`);
  check(`${map.name} every pickup can be walked to`,
    lost.length === 0, lost.length ? lost.join('  ') : 'all reachable');

}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

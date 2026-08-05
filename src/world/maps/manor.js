/**
 * MANOR — one sealed country house at dawn, 30 x 26 m over three storeys.
 *
 * The other two maps are OUTDOORS and are read at thirty to seventy metres.
 * This one is read at three to eight, which changes everything: there is no
 * sky over your head, no long lane to hold, and every corner is a doorway
 * somebody is about to come through. It is the close-quarters map.
 *
 * HOW IT PLAYS
 * ------------
 * Ten rooms on the ground floor, ten above them, and an attic over the lot.
 *
 *   GROUND   the ring: kitchen, dining, rear lobby and garage across the
 *            north; long gallery, stair hall and conservatory across the
 *            middle; living room, entrance hall and study across the south.
 *            Every room has at least two doors, so nothing is a dead end and
 *            nothing can be held from one angle.
 *   FIRST    bedrooms and landings on the same walls, reached by the great
 *            stair out of the hall, the service stair out of the lobby, or —
 *            if you are already up here — not at all.
 *   ATTIC    one long boarded room under the rafters, entered at both ends: the
 *            loft stair against the west wall and the box-room stair climbing
 *            west across the upper hall. Head height at the ridge, crouch
 *            height at the eaves, and the best pickups in the house.
 *
 * WHY EVERY ROUTE DOWN IS ONE-WAY
 * -------------------------------
 * There are exactly four ways UP (the great stair, the service stair, the loft
 * stair, the box-room stair) and nine ways DOWN: six balustrade drops, the
 * laundry chute, the linen hatch and the hole where the attic floor has given
 * way. Height in a sealed building would otherwise be a fortress — you would
 * take the attic, watch two staircases and never leave. The drops mean the top
 * of the house leaks players downward into the respawn traffic on the ground
 * floor, which is where the spawns all are and where the flags both sit.
 *
 * The stair openings are not in that nine. You can drop through any of them,
 * but you land on treads you could have walked up, so they are shortcuts rather
 * than one-way routes and are not counted as either.
 *
 * AND WHY THE ATTIC HAS TWO WAYS IN
 * ---------------------------------
 * It had one, and that made the top storey exactly the fortress the paragraph
 * above exists to prevent. Not because the loft stair is hard to get to — the
 * west landing it climbs out of has THREE doors, to the central landing, the
 * master bedroom and the guest bedroom — but because the ATTIC had one opening.
 * A player at the head of that flight was watching a single hole in a floor,
 * and holding it closed the best pickups in the house and a sixth of the map
 * for the price of never moving.
 *
 * The box-room stair is the answer, and it is deliberately as far from the loft
 * stair as the house allows: 20.0 m between their feet, 17.7 m between their
 * heads, in opposite quarters of a 19.8 x 25.0 m attic, with the L of party
 * wall in `buildAttic` standing across the line between them. The two heads
 * cannot see each other, and from anywhere within 2.5 m of the top of the loft
 * stair — the one square of boards that was worth standing on, back to the west
 * wall, on top of your own way out — the box-room head is not visible at all.
 * It also comes off a room with four ways into it against the west landing's
 * three. The two routes share nothing below the attic except the central
 * landing at the top of the great stair — the busiest room on the floor, and
 * the one place a single player provably cannot hold.
 *
 * BE PRECISE ABOUT WHAT THAT WALL DOES, because the temptation is to overclaim
 * it. Two thirds of the attic can still see both openings. That is fine: those
 * are positions in the middle of 25 m of open boards, ten metres from either
 * head, with nothing at your back and both stairs feeding players in behind
 * you. Holding the attic from there is not holding it, it is standing in it.
 * What the wall removes is the one place where watching both cost nothing.
 *
 * THE CONSERVATORY IS THE EXCEPTION THAT MAKES IT WORK
 * ---------------------------------------------------
 * One space runs the full height of the house: a glazed double-height room on
 * the east side, overlooked by two galleries and a bridge. It is the only
 * place in the map where you can be shot from a storey you cannot see, and the
 * only place the dawn sun actually reaches — so it is bright, dangerous, and
 * directly on the flag run. Everything else is lamplight.
 *
 * Layout is written with the toolkit on `Level`; spawn points, bounds and the
 * CTF bases live in `src/net/arena.js`, because the server needs them and must
 * not import THREE.
 */

import * as THREE from 'three';
import { SURFACE } from '../../core/AssetManager.js';
import { TAG_KIND } from '../../physics/PhysicsWorld.js';
import { randRange } from '../../core/MathUtils.js';

/* ------------------------------------------------------------- dimensions */

/**
 * The shell. `IN` is the CLEAR interior — the face of the plaster, not the
 * centre line of the wall.
 *
 * Every floor plate in this file is sized to `IN` (or to a room's clear
 * interior) rather than to a wall's centre, and that is not a detail. A plate
 * that runs to a centre line overlaps the wall it passes through, which leaves
 * two different materials sharing an edge — the shimmer `test/maps.mjs` looks
 * for. Ending a plate exactly ON a wall face means the two only touch, and
 * touching surfaces have nothing to flicker between.
 */
const IN = { x0: -14.5, x1: 14.5, z0: -12.5, z1: 12.5 };
/** Outer face of the brickwork. The inner plaster leaf lands on `IN`. */
const OUT = { x0: -15.0, x1: 15.0, z0: -13.0, z1: 13.0 };

const G_CEIL = 4.0;          // underside of the first floor
const F_BOT = 4.0, F_TOP = 4.4;   // the first-floor structural plate
const F_CEIL = 8.0;          // underside of the attic
const A_BOT = 8.0, A_TOP = 8.4;   // the attic plate
const WALL_TOP = 10.0;       // where the brickwork stops and the roof starts
const EAVES = 10.2;
const RIDGE = 13.2;
const ROOF_RUN = 13.6;       // ridge (z = 0) to eaves overhang

/** Internal partitions are two 0.2 m leaves, so each room gets its own finish. */
const LEAF = 0.2;

/**
 * The rooms, as CLEAR interiors.
 *
 * Written out rather than derived because everything else is derived from
 * THESE: the floor finishes, the ceilings, the wall runs and the spawn points
 * in arena.js. One table, one truth.
 */
const R = {
  kitchen: { x0: -14.5, x1: -5.7, z0: -12.5, z1: -6.2 },
  dining: { x0: -5.3, x1: 0.8, z0: -12.5, z1: -6.2 },
  lobby: { x0: 1.2, x1: 5.3, z0: -12.5, z1: -6.2 },
  garage: { x0: 5.7, x1: 14.5, z0: -12.5, z1: -6.2 },
  gallery: { x0: -14.5, x1: -8.2, z0: -5.8, z1: 4.8 },
  hall: { x0: -7.8, x1: 5.3, z0: -5.8, z1: 4.8 },
  cons: { x0: 5.7, x1: 14.5, z0: -5.8, z1: 4.8 },
  living: { x0: -14.5, x1: -4.2, z0: 5.2, z1: 12.5 },
  entrance: { x0: -3.8, x1: 5.3, z0: 5.2, z1: 12.5 },
  study: { x0: 5.7, x1: 14.5, z0: 5.2, z1: 12.5 },
};

/**
 * The great stair: one straight flight out of the hall, climbing north.
 *
 * THE TREAD DIMENSIONS ARE DERIVED, not picked. 0.24 m of run with a rise
 * taken from the storey height keeps this flight and the loft stair at the
 * same pitch whatever the floor heights become — change a storey and the
 * stairs follow it instead of quietly becoming unclimbable.
 */
const STAIR = {
  x: -6.4, w: 2.6, fromZ: 4.4, steps: 34, rise: F_TOP / 34, run: 0.24,
};
const STAIR_TOP_Z = STAIR.fromZ - STAIR.steps * STAIR.run;   // -3.76
/** First floor to attic, on the same terms. */
const LOFT = { steps: 32, rise: (A_TOP - F_TOP) / 32, run: 0.24, fromZ: 3.4 };
const LOFT_TOP_Z = LOFT.fromZ - LOFT.steps * LOFT.run;       // -4.28

/**
 * The attic's SECOND way in: a straight flight across the upper hall, climbing
 * west off the interior face of the x = 5.5 partition.
 *
 * Identical arithmetic to the loft stair — 32 steps, 0.24 m of run, the rise
 * derived from the storey height — for the reason above. 0.125 over 0.24 is
 * 27.5 degrees against the player's 52 degree limit, which TIES the loft stair
 * for the shallowest pitch in the house rather than beating it: the two are
 * the same expression, so they are the same angle to the last digit, and they
 * will still be if the storey height ever moves.
 *
 * It is the LONG way to the attic all the same, and the length is in the
 * APPROACH, not the climb. Both flights are 32 x 0.24 = 7.68 m of run for the
 * same 4.0 m of rise. What costs is the walk to the foot: 17.9 m from the head
 * of the great stair to here against 12.2 m to the loft stair, measured as a
 * player walks it rather than straight through the walls. So the price of this
 * route is distance and nothing else — and only the service stair, which is a
 * genuine shortcut, charges you the scout instead.
 *
 * `z` is the centre of a 1.4 m band in a 7.3 m room, and it is chosen rather
 * than left over. NORTH IS -z IN THIS HOUSE, so read the two constraints that
 * pin it in that order: SOUTH of here the roof closes — it is down to 1.81 m
 * over the boards at the south wall, and a 1.90 m player cannot stand at the
 * head. NORTH of here the flight would land within 1.4 m of the arch screen at
 * z = 5.0 and turn both of its gaps into a corridor running down the side of a
 * staircase, and its west end would stand 1.42 m in front of the living-room
 * door at x = -4.0, z 7.2..8.6 — a four-metre wall across a doorway.
 */
const BOXROOM = {
  steps: 32, rise: (A_TOP - F_TOP) / 32, run: 0.24, fromX: 5.3, z: 9.3, w: 1.4,
};
const BOXROOM_TOP_X = BOXROOM.fromX - BOXROOM.steps * BOXROOM.run;   // -2.38

/** Holes. Named because every one of them is a route, not an accident. */
const HOLE = {
  stairwell: { x0: -7.8, x1: -5.0, z0: STAIR_TOP_Z, z1: 4.8 },
  service: { x0: 3.5, x1: 5.1, z0: -12.5, z1: -6.6 },
  consN: { x0: 5.7, x1: 9.0, z0: -3.6, z1: 2.6 },
  consS: { x0: 11.4, x1: 14.5, z0: -3.6, z1: 2.6 },
  chute: { x0: -13.6, x1: -12.6, z0: -8.4, z1: -7.4 },
  chimney: { x0: -14.5, x1: -13.7, z0: 7.5, z1: 10.5 },
  bathroom: { x0: 5.7, x1: 14.5, z0: -12.5, z1: -6.2 },
  loft: { x0: -14.5, x1: -13.0, z0: LOFT_TOP_Z, z1: 3.5 },
  collapse: { x0: -3.0, x1: 0.5, z0: -1.0, z1: 2.0 },
  linen: { x0: 1.4, x1: 2.4, z0: -9.0, z1: -8.0 },
  /*
   * The box-room stairwell. Every bound is DERIVED from the flight rather than
   * typed next to it, and both halves of that matter.
   *
   * `x0` is the computed top of the climb, exactly as `loft`'s `z0` is
   * LOFT_TOP_Z: with a 3.60 m storey and a 1.90 m player, boards left over any
   * part of the top two metres of a four-metre climb make the flight
   * unwalkable, so the opening has to span the whole footprint and its far edge
   * has to move if the run ever does.
   *
   * The z bounds are the same expression `_stairs` builds the treads from, so
   * the plate's cut lines and the treads' faces are the SAME doubles. Typing
   * 8.6 and 10.0 here instead would put them a fraction of a micron apart —
   * invisible, and enough to turn a clean abutment into an overlap the shimmer
   * check has to reason about.
   */
  boxroom: {
    x0: BOXROOM_TOP_X, x1: BOXROOM.fromX,
    z0: BOXROOM.z - BOXROOM.w / 2, z1: BOXROOM.z + BOXROOM.w / 2,
  },
};

/* ----------------------------------------------------------------- helpers */

/**
 * A SEALED horizontal plate: one rectangle, minus any number of holes.
 *
 * Hand-authoring a floor with four openings in it is how a map ends up with a
 * two-centimetre slot somebody falls through, so the subtraction is done here
 * instead. Every hole edge becomes a cut line, the resulting cells that fall
 * inside a hole are dropped, and the survivors are merged along x. The pieces
 * therefore only ever ABUT — never overlap — which is also what keeps the
 * whole plate invisible to the shimmer check.
 */
function plate(level, material, rect, y0, y1, holes = [], opts = {}) {
  const xs = new Set([rect.x0, rect.x1]);
  const zs = new Set([rect.z0, rect.z1]);
  for (const h of holes) {
    if (h.x0 > rect.x0 && h.x0 < rect.x1) xs.add(h.x0);
    if (h.x1 > rect.x0 && h.x1 < rect.x1) xs.add(h.x1);
    if (h.z0 > rect.z0 && h.z0 < rect.z1) zs.add(h.z0);
    if (h.z1 > rect.z0 && h.z1 < rect.z1) zs.add(h.z1);
  }
  const ux = [...xs].sort((a, b) => a - b);
  const uz = [...zs].sort((a, b) => a - b);
  const y = (y0 + y1) / 2;
  const h = y1 - y0;

  for (let j = 0; j < uz.length - 1; j++) {
    const za = uz[j], zb = uz[j + 1];
    const zc = (za + zb) / 2;
    let runStart = null;
    const emit = (end) => {
      if (runStart === null) return;
      level._box(material, [(runStart + end) / 2, y, zc], [end - runStart, h, zb - za], opts);
      runStart = null;
    };
    for (let i = 0; i < ux.length - 1; i++) {
      const xa = ux[i], xb = ux[i + 1];
      const xc = (xa + xb) / 2;
      const cut = holes.some((k) => xc > k.x0 && xc < k.x1 && zc > k.z0 && zc < k.z1);
      if (cut) emit(xa);
      else if (runStart === null) runStart = xa;
    }
    emit(ux[ux.length - 1]);
  }
}

/**
 * A two-leaf internal partition: a different finish on each side.
 *
 * A house is not one material. The kitchen wall is glazed tile on the kitchen
 * side and plaster on the dining side, and that is most of what tells you which
 * room you are standing in when you come through a door at speed. Two 0.2 m
 * leaves that meet exactly on the centre line cost one extra merged batch and
 * nothing else — they only touch, so nothing shimmers between them.
 *
 * `matA` faces the LOWER coordinate, `matB` the higher.
 */
function partition(level, axis, at, from, to, gaps, opts = {}) {
  const {
    matA, matB, baseY = 0, height = G_CEIL, doorH = 2.4, tile = 1.6,
  } = opts;
  level._wallWithGaps(matA, axis, at - LEAF / 2, from, to, height, LEAF, gaps,
    { baseY, doorH, tile });
  level._wallWithGaps(matB, axis, at + LEAF / 2, from, to, height, LEAF, gaps,
    { baseY, doorH, tile });
}

/**
 * A brass threshold under a doorway.
 *
 * The floor finishes stop at the wall faces, so without these there is a
 * 100 mm trench across every opening — invisible, and felt as a stumble every
 * single time you run through a door. Brass because the palette reserves it
 * for things you touch or cross: a player learns in one match that brass means
 * a route, and there is no more literal route marker than a threshold.
 */
function threshold(level, axis, at, from, to) {
  const c = (from + to) / 2;
  const len = to - from;
  if (axis === 'x') level._box('brassTrim', [c, -0.05, at], [len, 0.1, LEAF * 2], { tile: 0.8 });
  else level._box('brassTrim', [at, -0.05, c], [LEAF * 2, 0.1, len], { tile: 0.8 });
}

/**
 * A balustrade run with GAPS, and the gaps are the point.
 *
 * Each one is a one-way route down. Six of them face the stairwell and the
 * conservatory, which is what stops the first floor being a balcony you can
 * hold indefinitely — you can always leave, downward, into the fight.
 */
function balustrade(level, axis, at, from, to, topY, gaps = []) {
  const segs = [];
  let cursor = from;
  for (const [gs, ge] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (gs > cursor) segs.push([cursor, gs]);
    cursor = Math.max(cursor, ge);
  }
  if (cursor < to) segs.push([cursor, to]);

  for (const [s, e] of segs) {
    const len = e - s;
    if (len <= 0.08) continue;
    const c = (s + e) / 2;
    // Panel and cap only TOUCH: the cap's underside is the panel's top face,
    // so the two never share a plane anybody can see both sides of.
    if (axis === 'x') {
      level._box('walnut', [c, topY + 0.44, at], [len, 0.88, 0.12], { tile: 1 });
      level._box('brassTrim', [c, topY + 0.94, at], [len, 0.12, 0.22], { collide: false, tile: 0.6 });
    } else {
      level._box('walnut', [at, topY + 0.44, c], [0.12, 0.88, len], { tile: 1 });
      level._box('brassTrim', [at, topY + 0.94, c], [0.22, 0.12, len], { collide: false, tile: 0.6 });
    }
  }
}

/**
 * A hanging light fitting: the only reason a sealed house is playable.
 *
 * The stem is measured DOWN from the ceiling it hangs off rather than up from
 * the shade, so its top face lands exactly on the slab above instead of a
 * couple of centimetres inside it. Two faces that near each other is the
 * shimmer `test/maps.mjs` exists to catch, and a lamp is the one fitting a
 * player stares straight at.
 */
function lamp(level, x, ceilY, z, w = 0.6, drop = 0.8) {
  const gy = ceilY - drop;
  level._box('brassTrim', [x, (gy + 0.13 + ceilY) / 2, z],
    [0.07, ceilY - gy - 0.13, 0.07], { collide: false, tile: 0.5 });
  level._box('lampGlow', [x, gy, z], [w, 0.26, w], { collide: false, tile: 1 });
}

/**
 * A framed portrait, hung on `wallFace` and standing PROUD of it.
 *
 * Frame and canvas abut rather than intersect, and the frame's back face lands
 * on the plaster rather than a centimetre inside it — three surfaces, no two
 * of them sharing a plane.
 *
 * `axis` is the axis the WALL runs along, so 'z' means a wall at a fixed x.
 * `dir` is +1 when the picture hangs on the higher-coordinate side.
 */
function portrait(level, axis, wallFace, along, y, w, h, dir) {
  const t = 0.06;
  const frame = wallFace + dir * (t / 2);
  const canvas = wallFace + dir * (t + t / 4);
  if (axis === 'x') {
    level._box('walnut', [along, y, frame], [w, h, t], { collide: false, tile: 0.8 });
    level._box('carpetOx', [along, y, canvas], [w - 0.24, h - 0.24, t * 0.5],
      { collide: false, tile: 0.8 });
  } else {
    level._box('walnut', [frame, y, along], [t, h, w], { collide: false, tile: 0.8 });
    level._box('carpetOx', [canvas, y, along], [t * 0.5, h - 0.24, w - 0.24],
      { collide: false, tile: 0.8 });
  }
}

/* ------------------------------------------------------------------ shell */

/**
 * The outer walls: a brick leaf outside, a plaster leaf inside.
 *
 * The inner leaf spans the INTERIOR only, never the full outer rectangle. Run
 * to the corners it would cross the returning wall's inner leaf, and two
 * different materials crossing at a corner with the same wall head height is
 * a coincident face along the whole junction.
 */
function buildShell(level) {
  const H = WALL_TOP;
  const oT = 0.3;

  // Brick, the full rectangle, corners overlapping (same material, so free).
  level._box('manorBrick', [0, H / 2, OUT.z0 + oT / 2], [30, H, oT], { tile: 2 });
  level._box('manorBrick', [0, H / 2, OUT.z1 - oT / 2], [30, H, oT], { tile: 2 });
  level._box('manorBrick', [OUT.x0 + oT / 2, H / 2, 0], [oT, H, 26], { tile: 2 });
  // The east wall is broken by the conservatory: piers and glazing, below.
  for (const [z0, z1] of [[OUT.z0, -6.0], [5.0, OUT.z1]]) {
    level._box('manorBrick', [OUT.x1 - oT / 2, H / 2, (z0 + z1) / 2], [oT, H, z1 - z0], { tile: 2 });
  }

  // Plaster, interior only.
  level._box('plasterCream', [0, H / 2, IN.z0 - LEAF / 2], [29, H, LEAF], { tile: 1.6 });
  level._box('plasterCream', [0, H / 2, IN.z1 + LEAF / 2], [29, H, LEAF], { tile: 1.6 });
  level._box('plasterCream', [IN.x0 - LEAF / 2, H / 2, 0], [LEAF, H, 25], { tile: 1.6 });
  for (const [z0, z1] of [[IN.z0, -6.0], [5.0, IN.z1]]) {
    level._box('plasterCream', [IN.x1 + LEAF / 2, H / 2, (z0 + z1) / 2], [LEAF, H, z1 - z0], { tile: 1.6 });
  }

  // Plinth course outside, so the house sits on something.
  level._box('limestone', [0, 0.3, OUT.z0 - 0.2], [30.8, 0.6, 0.4], { tile: 1 });
  level._box('limestone', [0, 0.3, OUT.z1 + 0.2], [30.8, 0.6, 0.4], { tile: 1 });
  level._box('limestone', [OUT.x0 - 0.2, 0.3, 0], [0.4, 0.6, 26.8], { tile: 1 });
  level._box('limestone', [OUT.x1 + 0.2, 0.3, 0], [0.4, 0.6, 26.8], { tile: 1 });
}

/**
 * The conservatory's east wall: brick piers with tall glazed bays between.
 *
 * Every bay is plinth, glass, head — three boxes stacked so each only touches
 * the next. The glazing bars stand clear of the glass rather than through it,
 * for the same reason.
 */
function buildConservatoryWall(level) {
  const PIERS = [[-6.0, -5.2], [-1.4, -0.6], [4.2, 5.0]];
  for (const [z0, z1] of PIERS) {
    level._box('manorBrick', [14.75, WALL_TOP / 2, (z0 + z1) / 2],
      [0.5, WALL_TOP, z1 - z0], { tile: 1.6 });
  }

  const BAYS = [[-5.2, -1.4], [-0.6, 4.2]];
  for (const [z0, z1] of BAYS) {
    const zc = (z0 + z1) / 2;
    const d = z1 - z0;
    level._box('limestone', [14.75, 0.2, zc], [0.5, 0.4, d], { tile: 1 });
    level._box('manorGlass', [14.7, 4.0, zc], [0.2, 7.2, d], { tile: 1 });
    level._box('manorBrick', [14.75, (7.6 + WALL_TOP) / 2, zc],
      [0.5, WALL_TOP - 7.6, d], { tile: 1.6 });

    // Glazing bars, standing INSIDE the glass rather than inside it.
    for (let k = 1; k <= 3; k++) {
      const bz = z0 + (d * k) / 4;
      level._box('brassTrim', [14.48, 4.0, bz], [0.14, 7.1, 0.1], { collide: false, tile: 0.5 });
    }
    for (const by of [2.2, 4.6, 6.4]) {
      level._box('brassTrim', [14.48, by, zc], [0.14, 0.1, d - 0.2], { collide: false, tile: 0.5 });
    }
  }
}

/* ------------------------------------------------------------------ floors */

function buildFloors(level) {
  // Raft under everything. 0.6 m thick so it never registers as a minimap
  // footprint, and one metre of it under the walls so nothing can fall out.
  level._box('screedFloor', [0, -0.4, 0], [31, 0.6, 27],
    { tile: 4, surface: SURFACE.CONCRETE });

  // Room finishes, each exactly its own clear interior.
  const FINISH = [
    ['emeraldTile', R.kitchen], ['oakFloor', R.dining], ['limestone', R.lobby],
    ['screedFloor', R.garage], ['oakFloor', R.gallery], ['marbleChequer', R.hall],
    ['limestone', R.cons], ['oakFloor', R.living], ['marbleChequer', R.entrance],
    ['oakFloor', R.study],
  ];
  for (const [mat, r] of FINISH) {
    plate(level, mat, r, -0.1, 0, [], { tile: 2 });
  }

  // The first-floor plate. Oak boards throughout except the bathroom, which is
  // laid out separately so the two only ever meet edge to edge.
  plate(level, 'oakFloor', IN, F_BOT, F_TOP, [
    HOLE.stairwell, HOLE.service, HOLE.consN, HOLE.consS,
    HOLE.chute, HOLE.chimney, HOLE.bathroom,
  ], { tile: 2.2 });
  plate(level, 'emeraldTile', HOLE.bathroom, F_BOT, F_TOP, [], { tile: 1.4 });

  // The attic covers the main block only — the east wing is two storeys under
  // a flat lead roof, and the conservatory is glass all the way up.
  plate(level, 'atticBoard', { x0: IN.x0, x1: 5.3, z0: IN.z0, z1: IN.z1 },
    A_BOT, A_TOP,
    [HOLE.loft, HOLE.collapse, HOLE.linen, HOLE.chimney, HOLE.boxroom], { tile: 2.2 });
}

/* ------------------------------------------------------- the ground floor */

function buildGroundWalls(level) {
  const P = (axis, at, from, to, gaps, matA, matB, doorH = 2.4) =>
    partition(level, axis, at, from, to, gaps, { matA, matB, doorH });

  // North band: kitchen | dining | lobby | garage.
  P('z', -5.5, IN.z0, -6.2, [[-9.9, -8.5]], 'emeraldTile', 'plasterCream');
  P('z', 1.0, IN.z0, -6.2, [[-9.0, -7.6]], 'plasterCream', 'plasterCream');
  P('z', 5.5, IN.z0, -6.2, [[-11.4, -10.0]], 'plasterCream', 'manorBrick');

  // The spine wall across the house at z = -6.
  P('x', -6.0, IN.x0, -5.5, [[-12.2, -10.8]], 'emeraldTile', 'plasterCream');
  P('x', -6.0, -5.5, 5.5, [[-3.0, -1.6], [2.6, 4.0]], 'plasterCream', 'plasterCream');
  P('x', -6.0, 5.5, IN.x1, [[9.2, 10.6]], 'manorBrick', 'manorBrick');

  // Middle band: gallery | hall | conservatory.
  P('z', -8.0, -5.8, 4.8, [[-3.6, -2.2], [1.8, 3.2]], 'walnut', 'plasterCream');
  P('z', 5.5, -5.8, 4.8, [[-4.4, -3.0]], 'plasterCream', 'manorBrick');

  /*
   * The arch screen. Three openings rather than a door, which is what chops
   * the house's long diagonal into slots instead of a corridor: you can see
   * the far side of it from the kitchen, and you still have to pick one.
   */
  P('x', 5.0, IN.x0, -8.0, [[-12.0, -10.6]], 'plasterCream', 'wallpaperRose');
  partition(level, 'x', 5.0, -8.0, 5.5, [[-6.6, -4.6], [-1.6, 1.4], [3.0, 4.6]],
    { matA: 'manorBrick', matB: 'manorBrick', doorH: 3.0, tile: 1.4 });
  P('x', 5.0, 5.5, IN.x1, [[9.0, 10.4]], 'manorBrick', 'walnut');

  // South band: living | entrance hall | study.
  P('z', -4.0, 5.2, IN.z1, [[7.2, 8.6]], 'wallpaperRose', 'plasterCream');
  P('z', 5.5, 5.2, IN.z1, [[8.8, 10.2]], 'plasterCream', 'walnut');

  // Every opening gets its brass sill.
  for (const [axis, at, from, to] of [
    ['z', -5.5, -9.9, -8.5], ['z', 1.0, -9.0, -7.6], ['z', 5.5, -11.4, -10.0],
    ['x', -6.0, -12.2, -10.8], ['x', -6.0, -3.0, -1.6], ['x', -6.0, 2.6, 4.0],
    ['x', -6.0, 9.2, 10.6],
    ['z', -8.0, -3.6, -2.2], ['z', -8.0, 1.8, 3.2], ['z', 5.5, -4.4, -3.0],
    ['x', 5.0, -12.0, -10.6], ['x', 5.0, -6.6, -4.6], ['x', 5.0, -1.6, 1.4],
    ['x', 5.0, 3.0, 4.6], ['x', 5.0, 9.0, 10.4],
    ['z', -4.0, 7.2, 8.6], ['z', 5.5, 8.8, 10.2],
  ]) threshold(level, axis, at, from, to);
}

/** Beams under the first floor, so the reception rooms are not flat lids. */
function buildBeams(level) {
  // `x0` overrides where a beam starts, which the living room needs: run to
  // the wall and it would end flush against the chimney breast standing in
  // front of it, two materials sharing one plane down the whole return.
  const beam = (r, count, x0 = r.x0) => {
    for (let i = 1; i <= count; i++) {
      const z = r.z0 + ((r.z1 - r.z0) * i) / (count + 1);
      level._box('rafterOak', [(x0 + r.x1) / 2, G_CEIL - 0.16, z],
        [r.x1 - x0, 0.32, 0.28], { collide: false, tile: 1 });
    }
  };
  beam(R.kitchen, 3);
  beam(R.dining, 2);
  beam(R.living, 3, -13.7);
  beam(R.entrance, 3);
  beam(R.study, 3);
  beam(R.gallery, 4);
}

/* ------------------------------------------------------------- staircases */

function buildStairs(level) {
  /*
   * The great stair: one straight flight up the west side of the hall.
   *
   * Straight rather than dog-legged on purpose. A turn gives the defender a
   * blind half-landing to hold; a straight run is a commitment in full view of
   * the hall, which is the trade for it being the fastest way up.
   */
  level._stairs('walnut', [STAIR.x, 0, STAIR.fromZ], [0, -1],
    STAIR.steps, STAIR.rise, STAIR.run, STAIR.w);

  // Stepped newels down the open side, and a brass rail following the pitch.
  for (let i = 0; i < STAIR.steps; i++) {
    const top = STAIR.rise * (i + 1);
    const z = STAIR.fromZ - STAIR.run * (i + 0.5);
    level._box('walnut', [-5.06, top + 0.45, z], [0.12, 0.9, STAIR.run], { tile: 0.8 });
  }
  level._ramp('brassTrim',
    [-5.06, (STAIR.rise + 0.9 + F_TOP + 0.9) / 2, (STAIR.fromZ + STAIR_TOP_Z) / 2],
    0.12, STAIR.steps * STAIR.run, STAIR.steps * STAIR.rise,
    { rotY: Math.PI, thickness: 0.1, surface: SURFACE.METAL });

  /*
   * The service stair, out of the rear lobby. Bare pine, no rail, half the
   * width and DELIBERATELY STEEP — a 0.20 m rise where the great stair has
   * 0.13. It is a shortcut, and being unpleasant to climb is the price of it:
   * the lobby is only 6.3 m deep, so a shallow flight would not have fitted
   * there anyway.
   */
  level._stairs('pineStep', [4.3, 0, -12.32], [0, 1], 22, 0.2, 0.26, 1.4);

  // The loft stair, hugging the west wall of the upper landing.
  level._stairs('pineStep', [-13.8, F_TOP, LOFT.fromZ], [0, -1],
    LOFT.steps, LOFT.rise, LOFT.run, 1.4);

  /*
   * The box-room stair: the attic's second way in, out of the upper hall.
   *
   * ITS FOOT IS AGAINST x = 5.3 BECAUSE THAT IS AS FAR EAST AS THE HOUSE GOES.
   * The attic plate stops there; the same line is the interior face of the
   * first-floor partition and the base of the east gable, so the flight comes
   * out inside the attic's own east end. Past x = 5.7 there is no third storey
   * at all — the east wing is the flat lead deck and the conservatory's glazed
   * roof — and a flight there would arrive on top of a house that is meant to
   * be sealed.
   *
   * THAT PARTITION IS NOT BLANK BEHIND THE FOOT. The nursery door is cut in the
   * same line at z 8.8..10.2, so 1.2 m of the flight's 1.4 m foot backs onto an
   * opening rather than onto masonry — only z 8.6..8.8 has wall behind it, and
   * the rest has a lintel starting at y = 6.6 and nothing under it. Two things
   * follow, and both are the reason to leave this where it is rather than
   * assume it was an accident:
   *
   *   THE GOOD ONE. The nursery is the only room on this floor with a single
   *   door, and this gives it a second thing to be — a private approach to the
   *   attic that never crosses the upper hall at all.
   *   THE PRICE. A defender in that door looks straight down the only strip the
   *   flight can be boarded from. Boarding needs a tread inside the 0.45 m
   *   autostep, which is treads 0-2 over x 4.58..5.30 walking, or 0-9 over
   *   x 2.90..5.30 with a jump. All of it is within three metres of the jamb.
   *   That is not the loft stair's problem in miniature: the nursery has no
   *   other way out, so holding its door costs the holder every other route in
   *   the house, and the strip is overlooked from both bands of the upper hall
   *   and from the flight standing over it.
   *
   * Bare pine and no rail, like the other two back stairs. BOTH SIDES ARE OPEN
   * FOR THE BOTTOM THIRTEEN TREADS — up to tread 12 at x 2.30, the last one a
   * standing capsule can occupy and still clear the attic plate's underside at
   * y = 8.0 — so the first 1.63 m of the climb can be left sideways into either
   * half of the room. Above that the plate closes both reveals and the flight
   * behaves like every other stair through a floor: forward, back, or a drop
   * into the well. That is not a fault and it is not special to this flight;
   * it is written down so nobody plans a fight round side exits it has not got.
   *
   * 7.68 m of run in a 9.10 m room — the flight's foot lands exactly on the
   * partition's face at x = 5.30, so there is no reveal behind it to fall into
   * and nothing to trim. The 1.42 m left at the west end is the walk-around,
   * and it is the only crossing at this end between the hall's 3.4 m north band
   * and its 2.5 m south one. The other crossing is 8 m away, at the far end of
   * the flight over treads 0-2 and in the nursery door's line, so
   * anything standing in the walk-around costs the room half its circulation —
   * which is why the press was moved out of it. Twice. See `buildUpstairs`.
   */
  level._stairs('pineStep', [BOXROOM.fromX, F_TOP, BOXROOM.z], [-1, 0],
    BOXROOM.steps, BOXROOM.rise, BOXROOM.run, BOXROOM.w);
}

/* -------------------------------------------------------- the first floor */

function buildFirstFloorWalls(level) {
  const P = (axis, at, from, to, gaps, matA, matB) =>
    partition(level, axis, at, from, to, gaps,
      { matA, matB, baseY: F_TOP, height: F_CEIL - F_TOP, doorH: 2.2 });

  P('z', -5.5, IN.z0, -6.2, [[-9.9, -8.5]], 'wallpaperRose', 'wallpaperRose');
  P('z', 1.0, IN.z0, -6.2, [[-9.0, -7.6]], 'plasterCream', 'plasterCream');
  P('z', 5.5, IN.z0, -6.2, [[-11.4, -10.0]], 'plasterCream', 'emeraldTile');

  P('x', -6.0, IN.x0, -5.5, [[-12.2, -10.8]], 'wallpaperRose', 'plasterCream');
  P('x', -6.0, -5.5, 5.5, [[-3.0, -1.6], [2.6, 4.0]], 'plasterCream', 'plasterCream');
  P('x', -6.0, 5.5, IN.x1, [], 'emeraldTile', 'manorBrick');

  /*
   * ONE door out of the west landing, not two, and it sits north of the
   * stairwell on purpose. The ground floor has two openings on this line; up
   * here the stairwell runs from z = -3.76 to the arch screen, so the second
   * of them would have opened onto a four-metre drop with no rail and no
   * warning. A drop has to be something you choose.
   */
  P('z', -8.0, -5.8, 4.8, [[-5.6, -4.2]], 'walnut', 'plasterCream');
  P('z', 5.5, -5.8, 4.8, [[-5.0, -3.8], [3.2, 4.4]], 'plasterCream', 'manorBrick');

  P('x', 5.0, IN.x0, -8.0, [[-12.0, -10.6]], 'plasterCream', 'wallpaperRose');
  P('x', 5.0, -8.0, 5.5, [[-6.6, -4.6], [-1.6, 1.4], [3.0, 4.6]], 'plasterCream', 'plasterCream');
  P('x', 5.0, 5.5, IN.x1, [], 'manorBrick', 'walnut');

  P('z', -4.0, 5.2, IN.z1, [[7.2, 8.6]], 'wallpaperRose', 'plasterCream');
  P('z', 5.5, 5.2, IN.z1, [[8.8, 10.2]], 'plasterCream', 'wallpaperRose');
}

/**
 * The six drops.
 *
 * Two off the stairwell, one off each conservatory gallery, two off the
 * bridge. They are gaps in a balustrade rather than marked hatches because a
 * player should find them by looking, and then use them without thinking.
 */
function buildBalustrades(level) {
  balustrade(level, 'z', -4.94, STAIR_TOP_Z, 4.8, F_TOP, [[-1.4, 0.2], [2.6, 4.0]]);

  balustrade(level, 'x', -3.66, 5.7, 14.5, F_TOP, [[9.0, 11.4], [12.6, 13.9]]);
  balustrade(level, 'x', 2.66, 5.7, 14.5, F_TOP, [[9.0, 11.4], [6.4, 7.7]]);
  balustrade(level, 'z', 8.94, -3.6, 2.6, F_TOP, [[-0.9, 0.4]]);
  balustrade(level, 'z', 11.46, -3.6, 2.6, F_TOP, [[-2.9, -1.6]]);

  // The chute and the hatch get a brass kerb rather than a rail: you are meant
  // to be able to step into them.
  const rim = (h, y) => {
    level._box('brassTrim', [(h.x0 + h.x1) / 2, y + 0.05, h.z0 - 0.06],
      [h.x1 - h.x0 + 0.24, 0.1, 0.12], { collide: false, tile: 0.5 });
    level._box('brassTrim', [(h.x0 + h.x1) / 2, y + 0.05, h.z1 + 0.06],
      [h.x1 - h.x0 + 0.24, 0.1, 0.12], { collide: false, tile: 0.5 });
    level._box('brassTrim', [h.x0 - 0.06, y + 0.05, (h.z0 + h.z1) / 2],
      [0.12, 0.1, h.z1 - h.z0], { collide: false, tile: 0.5 });
    level._box('brassTrim', [h.x1 + 0.06, y + 0.05, (h.z0 + h.z1) / 2],
      [0.12, 0.1, h.z1 - h.z0], { collide: false, tile: 0.5 });
  };
  rim(HOLE.chute, F_TOP);
  rim(HOLE.linen, A_TOP);

  /*
   * The box-room stairwell gets the same brass, but on its two LONG sides only.
   *
   * `rim` would wrap all four, and the x1 bar it adds would land at x
   * 5.30..5.42 — inside the east gable's brick base, brass and brick sharing an
   * x0 face over the whole 1.4 m. That side needs nothing anyway: it IS the
   * gable. Nor does x0, which is where the top tread comes up flush with the
   * boards and there is no drop to mark.
   *
   * The long sides do need it. Seven and a half metres of missing floor in a
   * dark boarded room reads as a hole in the map rather than a hole in the
   * house, and brass is the one thing this palette says "route" with — the
   * chute and the linen hatch are marked the same way for the same reason.
   */
  for (const zEdge of [HOLE.boxroom.z0 - 0.06, HOLE.boxroom.z1 + 0.06]) {
    level._box('brassTrim',
      [(HOLE.boxroom.x0 + HOLE.boxroom.x1) / 2, A_TOP + 0.05, zEdge],
      [HOLE.boxroom.x1 - HOLE.boxroom.x0, 0.1, 0.12], { collide: false, tile: 0.5 });
  }

  /*
   * Broken joists round the collapse, so it reads as a failure and not a hatch.
   * They sit ON the boards rather than level with them: a splintered oak end
   * flush with the floor it fell out of is two materials on one plane.
   *
   * EACH ONE HAS TO SPRING FROM THE SURVIVING FLOOR. They used to span
   * z0+0.06 .. z0+1.06 — entirely inside the opening, with a six-centimetre
   * gap between the boards' cut edge and the joist's near end. From the storey
   * below, where this hole is a hole in the CEILING, that read as four dark
   * timbers hanging in mid-air with nothing holding them: it was reported as
   * stair treads floating in the ceiling, and floating is exactly what they
   * were. Now they start 0.35 m back under the intact boards, so the eye can
   * see what they are still attached to.
   */
  const JOIST_BURIED = 0.35;   // how far each one reaches back under the floor
  const JOIST_LEN = 1.0;
  for (const x of [-2.4, -1.6, -0.8, 0.0]) {
    level._box('rafterOak',
      [x, A_TOP - 0.18, HOLE.collapse.z0 - JOIST_BURIED + JOIST_LEN / 2],
      [0.16, 0.24, JOIST_LEN], { collide: false, tile: 0.6 });
  }
  level._box('rafterOak', [(HOLE.collapse.x0 + HOLE.collapse.x1) / 2, A_TOP + 0.12,
    HOLE.collapse.z1 + 0.14], [3.5, 0.24, 0.28], { collide: false, tile: 0.6 });
}

/* --------------------------------------------------------- the attic roof */

function buildRoof(level) {
  // Two slopes to a ridge over the main block. Ramps, not boxes, so the pitch
  // is real rather than a staircase of slabs.
  const width = 5.7 - OUT.x0 + 0.6;
  const cx = (OUT.x0 - 0.6 + 5.7) / 2;
  const rise = RIDGE - EAVES;
  level._ramp('slateRoof', [cx, (EAVES + RIDGE) / 2, -ROOF_RUN / 2],
    width, ROOF_RUN, rise, { thickness: 0.45, surface: SURFACE.METAL });
  level._ramp('slateRoof', [cx, (EAVES + RIDGE) / 2, ROOF_RUN / 2],
    width, ROOF_RUN, rise, { rotY: Math.PI, thickness: 0.45, surface: SURFACE.METAL });
  level._box('slateRoof', [cx, RIDGE + 0.16, 0], [width, 0.3, 0.7], { collide: false, tile: 1.4 });

  /*
   * Crow-stepped gables, west and east.
   *
   * Stepped rather than triangular because the toolkit is axis-aligned boxes —
   * and because a stepped gable is what a house of this period actually has.
   * All manorBrick, so the steps cannot fight one another.
   */
  const gable = (xc, t, base) => {
    // The base only exists on the east gable — the west one is the shell wall,
    // which already stands here. Its z extent stops on the INTERIOR face of
    // the end walls so it meets their plaster rather than crossing it.
    if (base) {
      level._box('manorBrick', [xc, (A_BOT + WALL_TOP) / 2, 0],
        [t, WALL_TOP - A_BOT, IN.z1 - IN.z0], { tile: 1.6 });
    }
    for (let k = 0; k < 5; k++) {
      const y0 = WALL_TOP + k * 0.64;
      const halfZ = (ROOF_RUN * (RIDGE - (y0 + 0.64))) / (RIDGE - EAVES);
      if (halfZ < 0.3) continue;
      level._box('manorBrick', [xc, y0 + 0.32, 0], [t, 0.64, Math.min(halfZ * 2, 26)], { tile: 1.6 });
    }
  };
  gable(OUT.x0 + 0.15, 0.3, false);
  gable(5.5, 0.4, true);

  // The east wing: two storeys under a flat lead deck behind a parapet.
  for (const [z0, z1] of [[IN.z0, -6.0], [5.0, IN.z1]]) {
    level._box('slateRoof', [(5.7 + IN.x1) / 2, (A_BOT + A_TOP) / 2, (z0 + z1) / 2],
      [IN.x1 - 5.7, A_TOP - A_BOT, z1 - z0], { tile: 2, surface: SURFACE.METAL });
  }

  /*
   * The conservatory's own glazed roof, and the lantern above it.
   *
   * `manorGlass` writes depth, which is why a lantern can sit behind a roof
   * pane and still sort correctly — see the note on the material.
   */
  level._box('manorGlass', [(5.7 + IN.x1) / 2, (F_CEIL + F_CEIL + 0.24) / 2, -0.5],
    [IN.x1 - 5.7, 0.24, 10.8], { tile: 2 });
  // Glazing bars stop clear of the wall heads at either end. Run to them and
  // the bar's top face lands 20 mm under the brickwork's, along ten metres.
  for (const x of [7.5, 10.0, 12.5]) {
    level._box('brassTrim', [x, F_CEIL - 0.09, -0.5], [0.12, 0.14, 10.4], { collide: false, tile: 0.6 });
  }
  // Lantern: four glazed sides on a brass kerb, capped.
  for (const [dx, dz, sx, sz] of [[0, -2.2, 4.4, 0.2], [0, 2.2, 4.4, 0.2],
    [-2.2, 0, 0.2, 4.4], [2.2, 0, 0.2, 4.4]]) {
    level._box('manorGlass', [10 + dx, F_CEIL + 0.94, -0.5 + dz], [sx, 1.4, sz], { tile: 1 });
  }
  level._box('slateRoof', [10, F_CEIL + 1.78, -0.5], [4.8, 0.28, 4.8], { tile: 1.2 });

  // Dormers on both slopes: a box body with its glass on the front face.
  for (const [dx, dz, front] of [[-11, -8.6, -9.62], [-4, -8.6, -9.62], [3, -8.6, -9.62],
    [-11, 8.6, 9.62], [-4, 8.6, 9.62], [3, 8.6, 9.62]]) {
    level._box('slateRoof', [dx, 11.2, dz], [1.9, 1.7, 2.0], { tile: 1.2 });
    level._box('manorGlass', [dx, 11.05, front], [1.4, 1.15, 0.12], { collide: false, tile: 1 });
  }

  // The chimney, carried up past the ridge.
  level._box('manorBrick', [-14.1, 6.7, 9.0], [0.8, 13.4, 3.0], { tile: 1.6 });
  level._box('limestone', [-14.1, 13.55, 9.0], [1.1, 0.3, 3.3], { collide: false, tile: 1 });
}

/* ---------------------------------------------------------------- outside */

/**
 * The garden. Nobody can reach it — the house is sealed — but the conservatory
 * is 9 x 11 m of glass and a view of nothing at all is worse than no window.
 */
function buildGarden(level) {
  // Sized to MEET the raft rather than to overlap it. Two slabs of different
  // stone crossing with their top faces on one plane is the flattest, widest
  // z-fight it is possible to build.
  level._box('limestone', [0, -0.35, -18.5], [44, 0.5, 10], { tile: 6 });
  level._box('limestone', [0, -0.35, 18.5], [44, 0.5, 10], { tile: 6 });
  level._box('limestone', [-21.5, -0.35, 0], [12, 0.5, 27], { tile: 6 });
  level._box('limestone', [21.5, -0.35, 0], [12, 0.5, 27], { tile: 6 });

  // A low boundary wall, which is what gives the view a horizon.
  for (const [x, z, sx, sz] of [[0, -22.4, 52, 0.6], [0, 22.4, 52, 0.6],
    [-25.7, 0, 0.6, 44], [25.7, 0, 0.6, 44]]) {
    level._box('manorBrick', [x, 0.75, z], [sx, 1.5, sz], { tile: 2 });
  }
  for (const [x, z] of [[-25.7, -22.4], [25.7, -22.4], [-25.7, 22.4], [25.7, 22.4]]) {
    level._box('limestone', [x, 1.05, z], [1.2, 2.1, 1.2], { tile: 1 });
  }
}

/* -------------------------------------------------------------- furniture */

function buildKitchen(level) {
  const y = 0;
  // Island: joinery base, stone top, and the range set into it. Pulled clear
  // of the sink run in z — two worktops of different stone at one height,
  // overlapping, is a seam the length of the kitchen.
  level._box('walnut', [-10.0, y + 0.45, -7.7], [3.0, 0.9, 1.3], { tile: 1 });
  level._box('limestone', [-10.0, y + 0.95, -7.7], [3.2, 0.1, 1.5], { tile: 1 });
  level._box('lampGlow', [-10.0, y + 1.03, -7.7], [1.0, 0.06, 0.55], { collide: false, tile: 1 });

  // Larder towers against the north wall.
  for (const x of [-13.5, -12.3]) {
    level._box('walnut', [x, y + 1.15, -12.2], [1.0, 2.3, 0.6], { tile: 1 });
  }
  // Dresser and sink run.
  level._box('walnut', [-14.2, y + 1.0, -9.2], [0.5, 2.0, 2.4], { tile: 1 });
  level._box('limestone', [-8.6, y + 0.43, -6.55], [4.4, 0.86, 0.7], { tile: 1 });
  level._box('emeraldTile', [-8.6, y + 1.45, -6.35], [4.4, 1.1, 0.1], { collide: false, tile: 0.6 });

  lamp(level, -10.0, G_CEIL, -9.6, 0.7, 0.8);
  lamp(level, -12.6, G_CEIL, -7.0, 0.5, 0.8);
}

function buildDining(level) {
  level._box('walnut', [-2.2, 0.39, -8.6], [3.2, 0.78, 1.4], { tile: 1 });
  for (const z of [-9.6, -7.6]) {
    for (const x of [-3.3, -2.2, -1.1]) {
      level._box('walnut', [x, 0.45, z], [0.45, 0.9, 0.45], { tile: 0.8 });
    }
  }
  level._box('walnut', [-4.0, 0.5, -12.2], [2.0, 1.0, 0.5], { tile: 1 });
  level._box('carpetOx', [-2.2, 0.025, -8.6], [4.6, 0.05, 2.8], { collide: false, tile: 2 });
  lamp(level, -2.2, G_CEIL, -8.6, 0.8, 0.9);
  portrait(level, 'z', -5.1, -10.4, 2.1, 1.4, 1.7, 1);
}

function buildLobby(level) {
  level._box('linenSoft', [1.9, 0.23, -11.4], [1.3, 0.46, 0.5], { tile: 1 });
  level._box('walnut', [1.5, 1.2, -7.2], [0.7, 2.4, 0.45], { tile: 1 });    // long-case clock
  level._box('brassTrim', [1.32, 1.8, -9.6], [0.1, 0.1, 1.8], { collide: false, tile: 0.5 });
  lamp(level, 3.0, G_CEIL, -9.4, 0.45, 0.8);
}

function buildGarage(level) {
  const cz = -9.4;
  level._box('carDuco', [11.0, 0.9, cz], [4.4, 1.1, 1.9], { tile: 1.4 });
  level._box('carDuco', [10.6, 1.8, cz], [2.2, 0.7, 1.7], { tile: 1.2 });
  for (const dx of [-1.5, 1.5]) {
    for (const dz of [-0.95, 0.95]) {
      level._box('slateRoof', [11.0 + dx, 0.375, cz + dz], [0.75, 0.75, 0.36], { tile: 0.6 });
    }
  }
  level._box('brassTrim', [13.3, 1.0, cz], [0.16, 0.16, 1.4], { collide: false, tile: 0.5 });

  // The up-and-over door, and a bench of tools along the north wall. The bench
  // stops short of the door rather than in front of it — a timber top and a
  // lead door sharing the wall face would fight along their whole overlap.
  level._box('slateRoof', [11.0, 1.3, -12.42], [4.6, 2.6, 0.16], { tile: 1.4 });
  level._box('walnut', [7.2, 0.45, -12.2], [2.8, 0.9, 0.6], { tile: 1 });
  level._box('walnut', [14.2, 1.1, -9.0], [0.5, 2.2, 3.0], { tile: 1 });
  lamp(level, 11.0, G_CEIL, -9.4, 0.5, 0.6);
}

function buildGallery(level) {
  for (const z of [-4.4, -0.5, 3.4]) {
    level._box('limestone', [-11.35, 2.0, z], [0.5, 4.0, 0.5], { tile: 1.2 });
  }
  for (const z of [-3.6, 0.0, 3.6]) {
    level._box('walnut', [-14.2, 1.2, z], [0.5, 2.4, 2.4], { tile: 1 });
  }
  level._box('carpetOx', [-9.6, 0.025, -0.5], [1.8, 0.05, 9.2], { collide: false, tile: 2 });
  for (const z of [-4.0, 0.4, 3.8]) portrait(level, 'z', -8.2, z, 2.2, 1.6, 1.3, -1);
  // Off the column line: a stem meeting the ceiling inside a column that also
  // meets the ceiling is two heads on one plane.
  lamp(level, -9.8, G_CEIL, -2.6, 0.5, 0.7);
  lamp(level, -9.8, G_CEIL, 2.0, 0.5, 0.7);
}

function buildHall(level) {
  level._box('walnut', [0.6, 0.43, -5.55], [1.8, 0.86, 0.5], { tile: 1 });
  level._box('brassTrim', [3.8, 0.95, -4.7], [0.5, 1.9, 0.45], { tile: 0.8 });   // armour
  level._box('carpetOx', [1.2, 0.025, 0.6], [4.4, 0.05, 4.4], { collide: false, tile: 2.4 });
  lamp(level, 0.0, G_CEIL, -0.5, 1.0, 0.6);
  lamp(level, 3.6, G_CEIL, 3.2, 0.5, 0.8);
  portrait(level, 'x', -5.8, 1.0, 2.4, 2.0, 1.6, 1);
}

function buildConservatory(level) {
  for (const [x, z] of [[6.5, -5.0], [6.5, 4.0], [13.6, -5.0], [13.6, 4.0]]) {
    level._box('limestone', [x, 0.35, z], [1.2, 0.7, 1.2], { tile: 1 });
    level._box('carpetOx', [x, 0.86, z], [0.9, 0.32, 0.9], { collide: false, tile: 1 });
  }
  level._box('walnut', [8.4, 0.37, 0.6], [1.4, 0.74, 1.4], { tile: 1 });
  for (const [dx, dz] of [[-0.85, 0], [0.85, 0], [0, -0.85], [0, 0.85]]) {
    level._box('walnut', [8.4 + dx, 0.44, 0.6 + dz], [0.42, 0.88, 0.42], { tile: 0.8 });
  }
  // Hung off the conservatory's glazed roof, so the double-height space has
  // something in it at head height when you cross the bridge.
  lamp(level, 10.0, F_CEIL, -3.4, 0.6, 1.8);
  lamp(level, 10.0, F_CEIL, 2.4, 0.6, 1.8);
  lamp(level, 7.0, F_CEIL, -0.5, 0.4, 5.0);
}

function buildLiving(level) {
  // Hearth and firebox, standing clear of the chimney face rather than in it.
  level._box('limestone', [-13.35, 0.06, 9.0], [0.7, 0.12, 2.0], { collide: false, tile: 1 });
  level._box('lampGlow', [-13.66, 0.6, 9.0], [0.08, 0.9, 1.1], { collide: false, tile: 1 });
  level._box('limestone', [-13.66, 1.28, 9.0], [0.24, 0.16, 1.9], { collide: false, tile: 1 });

  for (const z of [7.3, 10.7]) {
    level._box('linenSoft', [-9.6, 0.23, z], [2.6, 0.46, 1.0], { tile: 1.2 });
    level._box('linenSoft', [-9.6, 0.62, z + (z < 9 ? -0.42 : 0.42)], [2.6, 0.78, 0.24], { tile: 1.2 });
  }
  level._box('carpetOx', [-9.6, 0.025, 9.0], [5.2, 0.05, 3.4], { collide: false, tile: 2.6 });
  level._box('walnut', [-6.2, 0.63, 11.4], [1.8, 1.26, 1.5], { tile: 1 });      // the piano
  level._box('brassTrim', [-6.2, 1.31, 11.4], [1.6, 0.1, 1.3], { collide: false, tile: 0.8 });
  level._box('walnut', [-9.0, 1.1, 12.25], [3.0, 2.2, 0.5], { tile: 1 });
  lamp(level, -9.6, G_CEIL, 9.0, 0.9, 0.8);
  lamp(level, -12.6, G_CEIL, 6.2, 0.4, 1.6);
  portrait(level, 'x', 5.2, -7.0, 2.3, 1.4, 1.7, 1);
}

function buildEntrance(level) {
  level._box('walnut', [0.8, 1.3, 12.44], [1.9, 2.6, 0.12], { tile: 1 });
  level._box('stainedGlass', [0.8, 3.05, 12.45], [1.9, 0.8, 0.1], { collide: false, tile: 1 });
  level._box('brassTrim', [1.55, 1.05, 12.36], [0.12, 0.12, 0.12], { collide: false, tile: 0.4 });
  level._box('walnut', [-3.0, 0.43, 6.0], [0.5, 0.86, 1.6], { tile: 1 });
  level._box('carpetOx', [0.8, 0.025, 9.4], [2.2, 0.05, 5.4], { collide: false, tile: 2 });
  lamp(level, 0.8, G_CEIL, 9.4, 1.1, 0.7);
  portrait(level, 'z', 5.3, 7.0, 2.2, 1.5, 1.8, -1);
}

function buildStudy(level) {
  level._box('walnut', [9.2, 0.39, 10.4], [2.4, 0.78, 1.2], { tile: 1 });
  level._box('walnut', [9.2, 0.44, 11.6], [0.5, 0.88, 0.5], { tile: 0.8 });
  for (const z of [7.6, 11.2]) level._box('walnut', [14.2, 1.2, z], [0.5, 2.4, 2.8], { tile: 1 });
  level._box('walnut', [6.0, 1.2, 10.6], [0.5, 2.4, 2.8], { tile: 1 });
  level._box('carpetOx', [10.0, 0.025, 9.4], [4.6, 0.05, 4.6], { collide: false, tile: 2.4 });
  level._box('brassTrim', [12.4, 0.55, 6.4], [0.7, 1.1, 0.7], { tile: 0.8 });   // the globe
  lamp(level, 10.0, G_CEIL, 9.0, 0.8, 0.8);
  // Desk lamp: it rests on the top rather than sinking into it.
  level._box('lampGlow', [9.2, 0.86, 10.4], [0.3, 0.16, 0.3], { collide: false, tile: 1 });
}

function buildUpstairs(level) {
  const y = F_TOP;
  // Master bedroom.
  level._box('linenSoft', [-11.0, y + 0.32, -9.4], [2.2, 0.64, 2.0], { tile: 1.2 });
  level._box('walnut', [-11.0, y + 0.62, -10.6], [2.3, 1.24, 0.22], { tile: 1 });
  level._box('walnut', [-14.2, y + 1.1, -8.0], [0.5, 2.2, 2.2], { tile: 1 });
  level._box('carpetOx', [-10.4, y + 0.025, -7.4], [4.0, 0.05, 3.0], { collide: false, tile: 2 });
  lamp(level, -11.0, F_CEIL, -9.4, 0.6, 0.7);

  // Second bedroom.
  level._box('linenSoft', [-2.4, y + 0.32, -9.6], [1.8, 0.64, 1.9], { tile: 1.2 });
  level._box('walnut', [-2.4, y + 0.62, -10.7], [1.9, 1.24, 0.22], { tile: 1 });
  lamp(level, -2.4, F_CEIL, -8.6, 0.5, 0.7);

  // Bathroom, over the garage: the loudest colour in the house.
  level._box('linenSoft', [12.6, y + 0.34, -8.0], [1.8, 0.68, 0.9], { tile: 1 });
  level._box('emeraldTile', [12.6, y + 0.78, -8.0], [1.9, 0.2, 1.0], { collide: false, tile: 0.6 });
  level._box('emeraldTile', [8.0, y + 1.2, -12.35], [4.0, 2.4, 0.1], { collide: false, tile: 0.6 });
  level._box('limestone', [7.4, y + 0.45, -6.55], [1.2, 0.9, 0.6], { tile: 1 });
  lamp(level, 10.0, F_CEIL, -9.0, 0.7, 0.7);

  // The long landing over the gallery.
  level._box('carpetOx', [-10.6, y + 0.025, 0.4], [1.8, 0.05, 8.0], { collide: false, tile: 2 });
  /*
   * The landing press stands SOUTH OF THE DOORWAY — south is +z here — flush
   * with its jamb, and that is not a nicety. At z = -4.4 it sat across 1.0 m of
   * the 1.4 m door in the x = -8.0 wall and left 0.40 m, half what a 0.70 m
   * player plus the controller's 0.02 a side needs. That sealed the west
   * landing's door onto the central landing outright, and the header two
   * hundred lines up counts that door as one of the three ways off the landing.
   * z = -3.4 puts the press's north face on the jamb at z = -4.2 exactly, so
   * the door is clear and there is no 200 mm slot beside it either.
   */
  level._box('walnut', [-8.36, y + 1.1, -3.4], [0.5, 2.2, 1.6], { tile: 1 });
  lamp(level, -10.6, F_CEIL, -0.6, 0.5, 0.7);
  lamp(level, -10.6, F_CEIL, 3.2, 0.5, 0.7);

  // The stair landing, and the way onto the galleries.
  level._box('carpetOx', [-1.0, y + 0.025, 1.0], [4.0, 0.05, 4.0], { collide: false, tile: 2.4 });
  lamp(level, -1.0, F_CEIL, -1.0, 0.8, 0.7);
  lamp(level, 3.0, F_CEIL, 2.6, 0.5, 0.7);

  // Guest bedroom and the upper hall.
  level._box('linenSoft', [-10.0, y + 0.32, 8.0], [2.2, 0.64, 2.0], { tile: 1.2 });
  level._box('walnut', [-10.0, y + 0.62, 6.8], [2.3, 1.24, 0.22], { tile: 1 });
  level._box('carpetOx', [-9.0, y + 0.025, 10.4], [4.4, 0.05, 3.0], { collide: false, tile: 2 });
  lamp(level, -10.0, F_CEIL, 8.6, 0.6, 0.7);
  /*
   * The press and the hall lamp both used to stand where the box-room stair
   * now climbs, and both were moved rather than deleted.
   *
   * THE PRESS HAS BEEN MOVED TWICE AND THE SECOND MOVE IS THE ONE TO READ,
   * because the first one looked right and was not. Standing it clear of the
   * flight is not enough. At [-3.4, 11.3] its north-east corner was 0.78 m from
   * the flight's south-west corner — but the two rectangles do not overlap in
   * z, so that 0.78 m is a diagonal between two corners rather than a gap you
   * can walk down. A player is 0.70 m across and the controller adds 0.02 a
   * side, so the free band for a capsule centre was 0.03 m wide and two thirds
   * of a metre long: a slot, threaded round two corners, in the middle of what
   * looks like an open 1.42 m walk-around. The failure mode is not being slowed
   * down, it is stopping dead in visible floor and having to go the long way.
   *
   * It is now flat against the south wall in the SOUTH-WEST corner of the room,
   * 2.0 m clear of the flight in z and out of the walk-around entirely, laid
   * out like the living room's press directly below it. It gives the south band
   * the cover it had none of, and it is nowhere near the only crossing at this
   * end of the flight.
   *
   * The lamp hung off ceiling the stairwell removes, and its shade sat at chest
   * height in the middle of the climb.
   */
  level._box('walnut', [-2.6, y + 1.1, 12.25], [2.4, 2.2, 0.5], { tile: 1 });
  lamp(level, 0.8, F_CEIL, 11.4, 0.7, 0.7);
  // And a second fitting, because the flight cuts the room in two and the
  // NORTH band — z 5.2..8.6, north being -z here — is the side both arch gaps
  // open into. One lamp for two rooms would leave the busier of them dark.
  lamp(level, 1.4, F_CEIL, 6.8, 0.7, 0.7);

  // Nursery, over the study.
  level._box('linenSoft', [12.4, y + 0.3, 10.4], [1.6, 0.6, 1.8], { tile: 1.2 });
  level._box('walnut', [7.0, y + 1.1, 10.0], [0.5, 2.2, 2.4], { tile: 1 });
  level._box('carpetOx', [10.4, y + 0.025, 8.0], [3.6, 0.05, 3.0], { collide: false, tile: 2 });
  lamp(level, 10.4, F_CEIL, 9.0, 0.6, 0.7);
}

function buildAttic(level) {
  const y = A_TOP;
  /*
   * Trusses. Collars rather than full rafters: the pitch is a ramp, and a
   * collar is the piece you actually duck under crossing the attic.
   */
  for (const z of [-10.5, -7.0, -3.5, 3.5, 7.0, 10.5]) {
    level._box('rafterOak', [-4.6, 11.0, z], [19.6, 0.3, 0.34], { collide: false, tile: 1 });
    for (const x of [-12.0, 2.6]) {
      level._box('rafterOak', [x, 10.55, z], [0.3, 1.2, 0.34], { collide: false, tile: 1 });
    }
  }
  level._box('rafterOak', [-4.6, 12.6, 0], [19.6, 0.34, 0.4], { collide: false, tile: 1 });

  /*
   * THE PARTY WALL, and it is the whole reason the attic's two heads are two
   * positions rather than one.
   *
   * Without it the top storey is 19.8 x 25.0 m of open boards with nothing in
   * it taller than a 1.1 m sheet, and that made the second stair decorative: a
   * player standing one step off the loft stair saw the loft opening at his
   * feet, the box-room head 18.0 m away and BOTH armours inside a fifty-degree
   * cone, every one of them with clear line of sight. Half a screen. An
   * attacker who had paid the long route's whole price — great stair, central
   * landing, arch gap, the length of the upper hall, 7.68 m of climb — stepped
   * off the top tread already inside the defender's field of view without the
   * defender having turned his head. Two ways in that one pair of eyes covers
   * is one way in with a longer walk attached.
   *
   * IT IS AN L, AND THE L IS THE PLAN OF THE MASONRY BELOW IT. The house has
   * exactly two internal walls that run through both storeys as walls rather
   * than as partitions: the gallery/hall spine at x = -8.0, and the arch screen
   * at z = 5.0, which is manorBrick on both faces on the ground floor. They
   * meet at (-8.0, 5.0). This carries that corner into the roof — so the collar
   * ties land on something that goes to the ground, and nothing here is a block
   * dropped into the middle of a room.
   *
   * Both ends of the spine leg are pinned. 4.8 is where the wall below stops
   * and the screen takes over. 1.4 is as far north as it can come without
   * burying the armour at (-8.0, 0.0) — `test/maps.mjs` would catch that as a
   * pickup inside the geometry, and a player would only ever meet it as a
   * pickup that cannot be taken.
   *
   * THE RETURN IS NOT DECORATION AND IS NOT REDUNDANT. The spine leg alone
   * leaves half of the boards within three metres of the loft opening still
   * looking straight at the box-room head — two metres either way along the
   * west wall and you see round the end of it. With the return, of 233
   * standable samples within 2.5 m of the top of the loft stair, NONE has line
   * of sight to the other head. That is the whole claim in the header, and it
   * is the return that makes it true, so do not shorten it past x = -4.0
   * without re-running that count.
   *
   * Both legs stop at 10.85 — the underside of the collar ties — so where a
   * collar crosses the spine at z = 3.5 it bears on the wall rather than
   * passing through it, and the two only touch. The 1.0 to 1.8 m of open air
   * left between the head of the wall and the roof slope sits 2.45 m above the
   * boards: too high to reach, look through or shoot along. The attic stays one
   * connected room, round the north end of the spine and round both ends of the
   * return — 6.3 m of clear boards west of it and 9.3 m east.
   */
  level._box('manorBrick', [-8.0, (A_TOP + 10.85) / 2, 3.1],
    [0.4, 10.85 - A_TOP, 3.4], { tile: 1.6 });
  level._box('manorBrick', [-6.1, (A_TOP + 10.85) / 2, 5.0],
    [4.2, 10.85 - A_TOP, 0.4], { tile: 1.6 });

  /*
   * Sheeted furniture and a cold-water tank: cover, in a room with none.
   *
   * The last of them is at the head of the box-room stair and is not scenery.
   * Everything else solid on these boards was 4.8 m or more from where the top
   * tread lands, and the nearest prop is the chest 5.8 m east with the well in
   * between — so a player who had just paid the long route's price stepped off
   * it into the open and had nothing to break line of sight against in any
   * direction. This is 1.1 m north-west of the tread: one sidestep. It stops at
   * z = 8.2, clear of the well's brass kerb at 8.48, so neither the two faces
   * nor the 0.28 m between them is close enough to fight.
   */
  for (const [x, z] of [[-8.0, -10.0], [-5.0, -9.2], [-9.5, 6.4], [1.5, 5.0],
    [-3.3, 7.6]]) {
    level._box('linenSoft', [x, y + 0.55, z], [1.6, 1.1, 1.2], { tile: 1.2 });
  }
  level._box('slateRoof', [3.4, y + 0.7, -4.0], [1.6, 1.4, 1.6], { tile: 1 });
  level._box('walnut', [-12.6, y + 0.6, -8.6], [1.4, 1.2, 1.0], { tile: 1 });
  level._box('walnut', [-13.0, y + 0.5, 7.0], [1.2, 1.0, 2.2], { tile: 1 });

  lamp(level, -6.0, 11.4, -6.0, 0.4, 2.4);
  lamp(level, -6.0, 11.4, 4.0, 0.4, 2.4);
  lamp(level, 1.0, 11.4, -1.0, 0.4, 2.4);
}

/* ------------------------------------------------------------------ props */

function buildProps(level) {
  const chestGeo = level.assets.ownGeometry(new THREE.BoxGeometry(0.8, 0.8, 0.8));

  const chests = [
    [3.0, -11.6, 0], [2.4, -10.7, 0], [13.0, -11.8, 0],
    [7.0, -7.0, 0], [-13.6, -6.9, 0], [12.0, 3.6, 0],
    [-6.0, A_TOP, -8.0], [-4.9, A_TOP, -8.7], [0.2, A_TOP, -5.0],
    // This one stood at [2.0, A_TOP, 9.0], which the box-room stairwell has
    // since taken out of the boards — it would have spawned over the void and
    // fallen four metres onto the treads. Moved SOUTH of the well. It is not
    // the cover at the head — that is the sheeted piece in `buildAttic`, 1.1 m
    // off the top tread. This is 5.8 m east along the south lip and the
    // straight line to it crosses the void, so it is somewhere to fall back to
    // rather than somewhere to duck. Being pushable, it is also something a
    // player can put into the well behind them.
    [-10.0, A_TOP, 2.6], [3.2, A_TOP, 10.9],
  ];
  for (const [x, base, z] of chests) {
    const s = randRange(0.78, 0.95);
    level._spawnProp({
      geometry: chestGeo,
      material: 'walnut',
      position: new THREE.Vector3(x, base + s / 2 + 0.02, z),
      shape: 'box',
      half: { x: s / 2, y: s / 2, z: s / 2 },
      mass: 16 * s,
      surface: SURFACE.WOOD,
      rotY: randRange(-0.5, 0.5),
    });
  }

  /*
   * Gas bottles — the house's explosives, and deliberately wearing the same
   * livery every other map's barrels wear.
   *
   * A player has to read "this detonates" in a quarter of a second from across
   * a dark room. Inventing a manor-specific look for it would be prettier and
   * would get people killed by scenery they did not recognise.
   *
   * The blast is 4.5 m against the yard's 7.5. A country-house room is five
   * metres across; the warehouse radius would take the room next door as well,
   * which turns a considered shot into a coin flip.
   */
  const bottleGeo = level.assets.ownGeometry(new THREE.CylinderGeometry(0.28, 0.28, 0.84, 14));
  for (const [x, base, z] of [
    [13.9, 0, -12.0], [13.3, 0, -11.6],
    [4.6, 0, -7.2],
    [6.4, 0, 3.9],
    [-14.0, 0, -11.9],
    [-11.6, A_TOP, -11.4], [4.0, A_TOP, -2.4],
  ]) {
    level._spawnProp({
      geometry: bottleGeo,
      material: 'explosiveBarrel',
      position: new THREE.Vector3(x, base + 0.44, z),
      shape: 'cylinder',
      // A cylinder is HEIGHT and RADIUS. Passing {x,y,z} leaves the radius
      // undefined, and one non-finite collider disables every raycast on the
      // map — see the guard in PhysicsWorld.
      half: { y: 0.42, r: 0.28 },
      mass: 32,
      surface: SURFACE.METAL,
      kind: TAG_KIND.EXPLOSIVE,
      explosive: { health: 40, radius: 4.5, damage: 90, force: 300 },
    });
  }
}

/**
 * Where the pickups sit.
 *
 * Armour is in the ATTIC, at the end of the longest climb in the house, and
 * every route back down from it is a drop. Health is spread across the ground
 * floor where the respawns are, and one sits on the conservatory bridge — the
 * most overlooked square metre on the map, which is exactly what a contested
 * pickup should be.
 *
 * NEITHER ARMOUR SITS ON A LANDING, and now that there are two stairs into the
 * attic that has to be deliberate. The second one used to be at (-2.0, 8.0),
 * which the box-room stair would have left 0.6 m off its top tread: one step
 * off the flight, so the new route would have been strictly the fastest way to
 * armour in the house and the loft stair would never have been worth taking
 * again. Six metres of open boards out from each head is the tax both climbs
 * pay — the loft stair is about seven from the one at (-8.0, 0.0) — and six
 * metres of boards carrying one waist-high sheet is a long way to be looked at.
 * The cover `buildAttic` puts at the box-room head is deliberately BEHIND that
 * walk rather than on it: it buys you the first second off the tread, and then
 * you are in the open like everybody else.
 */
function buildPickups(level) {
  level.pickupSpots = [
    { type: 'armor', pos: new THREE.Vector3(-8.0, A_TOP + 0.6, 0.0) },
    { type: 'armor', pos: new THREE.Vector3(-8.2, A_TOP + 0.6, 10.2) },
    { type: 'health', pos: new THREE.Vector3(10.2, F_TOP + 0.6, -0.5) },
    { type: 'health', pos: new THREE.Vector3(-12.6, 0.6, -6.9) },
    { type: 'health', pos: new THREE.Vector3(0.0, 0.6, 8.2) },
    { type: 'health', pos: new THREE.Vector3(-2.2, 0.6, 2.2) },
    { type: 'ammo', pos: new THREE.Vector3(2.2, 0.6, -9.8) },
    { type: 'ammo', pos: new THREE.Vector3(12.8, 0.6, -7.2) },
    { type: 'ammo', pos: new THREE.Vector3(12.6, 0.6, 1.6) },
    { type: 'ammo', pos: new THREE.Vector3(-13.0, 0.6, 3.4) },
    { type: 'ammo', pos: new THREE.Vector3(2.0, F_TOP + 0.6, -1.4) },
    { type: 'ammo', pos: new THREE.Vector3(-11.2, F_TOP + 0.6, 3.0) },
  ];
}

/* ------------------------------------------------------------- definition */

export const manorMap = Object.freeze({
  id: 'manor',
  name: 'MANOR',
  tagline: 'Sealed country house',
  description:
    'Three storeys of rooms, doorways and lamplight, with one glazed hall '
    + 'running the full height of it. Four ways up. Nine ways down.',

  scale: 'SMALL',
  span: '30 m',
  players: '2-8',
  accent: '#c89a4e',
  swatch: ['#8c4a33', '#4e3320', '#1d4f3c'],

  /** Top-down sketch for the map card — the ten ground-floor rooms. */
  plan: [
    [-10.1, -9.35, 8.8, 6.3], [-2.25, -9.35, 6.1, 6.3],
    [3.25, -9.35, 4.1, 6.3], [10.1, -9.35, 8.8, 6.3],
    [-11.35, -0.5, 6.3, 10.6], [-1.25, -0.5, 13.1, 10.6], [10.1, -0.5, 8.8, 10.6],
    [-9.35, 8.85, 10.3, 7.3], [0.75, 8.85, 9.1, 7.3], [10.1, 8.85, 8.8, 7.3],
  ],

  /** Where the map card's photograph is taken from. See warehouse.js. */
  thumbCam: { pos: [30, 16, 30], look: [0, 5, 0], fov: 50 },
  playerSpawn: [0.0, 1.1, 9.6],
  playerSpawnYaw: 0,
  /*
   * The HOUSE, exactly — not the garden outside the glass.
   *
   * The picker draws this rectangle to the same scale on every card, so it is
   * what a player compares the three maps by. Padding it out to include the
   * lawn nobody can walk on would draw MANOR the size of the outpost and lie
   * about the only thing the card is for.
   */
  bounds: { min: [-15, 0, -13], max: [15, 18, 13] },

  /**
   * Dawn, and the house is SEALED.
   *
   * The sun is at 8 degrees and due east, so what it actually lights is the
   * conservatory and nothing else — every other room is lamplight, hemisphere
   * and bounce. That is a deliberate constraint rather than a compromise: it
   * is what makes the one glazed room read as somewhere you are exposed.
   *
   * `ambient` is kept LOW on purpose. Raising it is the obvious fix for a dark
   * interior and the wrong one — it flattens the lamps into stickers and blows
   * out the four rooms that do have daylight. The fix for a dark room here is
   * a light fitting; see the note on `lampGlow` in AssetManager.
   *
   * The shadow bias is slacker again than the outpost's. An 8-degree sun
   * spreads each shadow texel across several metres of floor, and the outpost's
   * figures — themselves several times the warehouse's — still left acne
   * crawling across the hall. See Level._configureSunShadow.
   */
  env: {
    sky: { turbidity: 4.2, rayleigh: 2.6, mie: 0.005, mieG: 0.84,
           elevation: 8, azimuth: 88 },
    envIntensity: 0.34,
    fog: { color: 0xc0a091, density: 0.0140 },
    sun: {
      color: 0xffc08a, intensity: 2.4, shadowHalf: 24, shadowFar: 130,
      bias: -0.0038, normalBias: 0.16,
    },
    hemi: { sky: 0xd8c2b6, ground: 0x2e2620, intensity: 0.72 },
    ambient: { color: 0x2c2830, intensity: 0.20 },
    // Warm bounce out of the east, so the rooms off the conservatory pick up
    // some of its light instead of going to black.
    bounce: { color: 0xffb383, intensity: 0.55 },
  },

  build(level) {
    buildGarden(level);
    buildShell(level);
    buildConservatoryWall(level);
    buildFloors(level);
    buildGroundWalls(level);
    buildBeams(level);
    buildFirstFloorWalls(level);
    buildStairs(level);
    buildBalustrades(level);
    buildRoof(level);

    buildKitchen(level);
    buildDining(level);
    buildLobby(level);
    buildGarage(level);
    buildGallery(level);
    buildHall(level);
    buildConservatory(level);
    buildLiving(level);
    buildEntrance(level);
    buildStudy(level);
    buildUpstairs(level);
    buildAttic(level);
    level._flush();

    buildProps(level);
    buildPickups(level);
  },
});

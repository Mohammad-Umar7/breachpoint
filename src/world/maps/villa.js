/**
 * VILLA — a modern hillside house at golden hour, built around one hole.
 *
 * WHAT IT IS
 * ----------
 * Twenty-six metres by twenty-two, three storeys, and every one of them is a
 * balcony looking down into the same double-height room. There is a swimming
 * pool at the bottom of it. That is the entire design, and everything else in
 * this file is in service of it.
 *
 * WHY THIS SHAPE, AND NOT THE LAST ONE
 * ------------------------------------
 * The house this replaces was a country manor: ten rooms a floor, joined by
 * doorways, in eleven shades of brown. It was a faithful house and a poor map,
 * and the three complaints about it were all the same complaint. You could not
 * tell where you were, because every room looked like the last one. You could
 * not tell where anyone else was, because walls stopped at the ceiling and
 * sightlines died at every door. And the fights were a series of ambushes in
 * corridors, because a corridor is what a realistic floor plan is mostly made
 * of.
 *
 * So this one is built the other way round. Instead of rooms joined by doors,
 * it is ONE VOLUME with rooms hung off it:
 *
 *   THE ATRIUM is 8 m square and 10.8 m tall, open from the pool to a glass
 *   roof. Stand anywhere on any floor and you can see into it, and through it,
 *   and across it to the far side two storeys up. It is the map's clock: you
 *   always know where the fight is because you can hear it and see it in the
 *   middle of the house.
 *
 *   THE RINGS are the first and second floors — balconies all the way round the
 *   atrium, railed in GLASS. You can see through the railing and you can shoot
 *   through it, and you cannot walk through it. That is the trade the whole map
 *   runs on: standing at a rail gives you the whole house and gives the whole
 *   house you.
 *
 *   THE POOL is what makes it churn. It is 0.4 m deep — under a player's
 *   autostep, so you walk in and out of it without a thought — and dropping
 *   into it from either ring costs nothing, because 7.2 m is half of the 14.08 m
 *   a fall needs to hurt. There is therefore ALWAYS a way down, from anywhere,
 *   instantly. A player who has lost a fight upstairs is never trapped, and a
 *   player who has won one cannot hold a floor by standing on the only stair.
 *
 * WHY YOU ALWAYS KNOW WHERE YOU ARE
 * ---------------------------------
 * Each wing is a different material and a different colour, and they are chosen
 * to be told apart at a glance and under fire:
 *
 *   WEST   kitchen and service — white plaster, steel, chequered marble
 *   EAST   living and master   — walnut, ox-blood carpet, brass
 *   NORTH  garage and gym      — bare concrete, hazard stripes, green tile
 *   SOUTH  entrance and study  — limestone and a two-storey wall of glass
 *   MIDDLE the atrium          — white, teal water, brass rails
 *
 * "He is in the brown room" and "he is above the pool" are things a player can
 * say after half a match. That is the whole point of colour-coding a map, and
 * it is what the manor never had.
 *
 * THE THREE WAYS UP, AND WHY THEY ARE DIFFERENT
 * --------------------------------------------
 *   THE FEATURE STAIR climbs the atrium's west face, open-tread, ground to
 *   first. It is the fastest way up and the most exposed — everybody in the
 *   house can see you on it.
 *
 *   THE SERVICE STAIR is enclosed in the north-west corner and reaches all
 *   three floors. It is the safe way and the slow way: no sightlines out of it,
 *   which means none into it either.
 *
 *   THE GYM RUN is a stack of plant and ductwork in the north-east that you can
 *   climb, first floor to second. It is a shortcut for somebody who knows the
 *   house, and invisible to somebody who does not.
 *
 * Three routes, three characters, and no floor sealable by holding one of them.
 *
 * SEALED, BUT NOT BLIND
 * ---------------------
 * The house is closed — the glass is glass, not a doorway, and the roof is a
 * roof. What the glass buys is that being sealed does not mean being unable to
 * see: the south wall is two storeys of it, the sun comes through it at 14
 * degrees, and it throws the map's long shadows across the atrium floor.
 */

import * as THREE from 'three';
import { SURFACE } from '../../core/AssetManager.js';
import { TAG_KIND } from '../../physics/PhysicsWorld.js';

/* ------------------------------------------------------------- dimensions */

/** Half-extents of the shell. 26 m by 22 m — a house, not a compound. */
const HX = 13, HZ = 11;

/**
 * Storey heights, and the one number they are all derived from.
 *
 * 3.6 m is chosen against the player, not against architecture: a 1.9 m player
 * needs 1.4 m of clearance to stand, a 0.3 m floor plate eats into it, and a
 * drop of one storey has to stay far under the 14.08 m that starts hurting.
 * Every floor level below is `n * STOREY`, so changing this moves the whole
 * house rather than breaking the relationship between any two parts of it.
 */
const STOREY = 3.6;
const F0 = 0;                    // ground
const F1 = STOREY;               // first ring
const F2 = STOREY * 2;           // second ring
const PLATE = 0.3;               // floor plate thickness
const CEIL = 10.8;               // underside of the glass roof

/**
 * The atrium: 8 m square, dead centre.
 *
 * Square on purpose. A rectangular void has a long axis, and a long axis has a
 * best place to stand; a square one is equally good and equally bad from all
 * four rings, so no corner of the house owns it.
 */
const A = 4.0;                   // half-width of the void

/** The pool sits inside the atrium with a metre of deck all round. */
const POOL = 3.0;
const POOL_DEPTH = 0.4;          // under the 0.45 m autostep: walk in, walk out

/** Where the ring's glass railing stands, and how tall. */
const RAIL_H = 1.05;
const RAIL_T = 0.06;
/*
 * How far in from the void's edge the glass stands.
 *
 * Not zero, which is where it wants to be: a rail whose face sits on the floor
 * plate's own edge, or a few centimetres off the partition behind it, is a pair
 * of near-coplanar faces in different materials, and that shimmers. 0.35 m
 * clears the plate edge, the partitions and both stair heads at once, and it
 * reads as a rail set back off the drop rather than hung over it.
 */
const RAIL_IN = 0.35;

/* ----------------------------------------------------------------- shell */

function buildShell(level) {
  /*
   * The ground slab, one metre thick.
   *
   * Thick rather than thin because it is also the thing that stops anything
   * falling out of the world: a seam in a 0.1 m slab is a hole, and a seam in
   * a 1 m slab is nothing at all.
   */
  level._box('screedFloor', [0, -0.5, 0], [HX * 2, 1, HZ * 2],
    { tile: 5, surface: SURFACE.CONCRETE });

  // Exterior walls. Solid on three sides; the south is glass, below.
  /*
   * The three solid walls OVERLAP each other and run up into the roof slab.
   *
   * Nothing here is flush with anything: the side walls are longer than the
   * house so their ends bury inside the north wall and the south glazing, and
   * all three stand 0.3 m proud of the ceiling so their top faces end up inside
   * the roof rather than level with it. Two coplanar faces of different
   * materials are what shimmers, and a shell is where they are easiest to
   * create by accident — every one of these was doing it.
   */
  const T = 0.5;
  const WALL_H = CEIL + 0.3;
  level._box('plasterCream', [-HX, WALL_H / 2, 0], [T, WALL_H, HZ * 2 + 1.0], { tile: 3 });
  level._box('plasterCream', [HX, WALL_H / 2, 0], [T, WALL_H, HZ * 2 + 1.0], { tile: 3 });
  level._box('plasterCream', [0, WALL_H / 2, -HZ], [HX * 2, WALL_H, T], { tile: 3 });

  /*
   * THE SOUTH WALL IS GLASS, floor to roof, and it is the reason the house is
   * lit at all.
   *
   * It is a wall: you can see through it and shoot through it and you cannot
   * leave through it. Mullions every 3.25 m break it up so it reads as glazing
   * rather than as a missing wall, and so there is something to line a shot up
   * against.
   */
  const GLASS_H = CEIL - 0.2;
  level._box('manorGlass', [0, GLASS_H / 2, HZ], [HX * 2 - 0.6, GLASS_H, 0.12],
    { tile: 4, surface: SURFACE.GLASS });
  // Mullions shorter again, so the brass never shares a top face with the pane.
  const MULL_H = CEIL - 0.7;
  for (let x = -HX + 3.25; x < HX; x += 3.25) {
    level._box('brassTrim', [x, MULL_H / 2, HZ], [0.14, MULL_H, 0.3], { tile: 1 });
  }
  level._box('brassTrim', [0, 0.24, HZ], [HX * 2 - 1.6, 0.48, 0.34], { tile: 2 });
  level._box('brassTrim', [0, GLASS_H - 0.40, HZ], [HX * 2 - 1.6, 0.48, 0.34], { tile: 2 });

  /*
   * The roof, and the skylight over the atrium.
   *
   * Glass over the void so the house stays sealed while the middle of it stays
   * the brightest thing in the map — the shaft of light down the atrium is what
   * makes the pool readable from the top floor.
   */
  // Oversailing on every side: a roof whose edge lands exactly on the wall
  // below it puts two materials on one plane along the full length of the house.
  level._box('concreteDark', [0, CEIL + 0.25, 0], [HX * 2 + 1.4, 0.5, HZ * 2 + 1.4],
    { tile: 5 });
  level._box('manorGlass', [0, CEIL + 0.05, 0], [A * 2, 0.1, A * 2],
    { collide: false, tile: 2 });
}

/* ---------------------------------------------------------------- floors */

/**
 * One ring of floor: the whole storey minus the atrium void.
 *
 * Four slabs rather than one with a hole, because a hole is not a thing the box
 * builder can make. Written from A and the shell half-extents so the void stays
 * square and centred no matter what those become.
 */
function ring(level, y, material, tile = 3) {
  const yc = y - PLATE / 2;
  /*
   * The bands run INTO the walls, not up to them.
   *
   * A floor slab whose end face lands exactly on a wall's inner face is two
   * coplanar surfaces facing opposite ways, which is z-fighting — the depth
   * buffer picks a different winner per pixel per frame and the join shimmers.
   * The exterior walls are 0.5 m thick and centred on the half-extents, so
   * their inner faces are at 12.75 and 10.75; ending the bands at 12.85 and
   * 11.0 buries each edge inside the wall with nothing coincident and no gap
   * left to see daylight through.
   */
  const EX = HX - 0.15;
  const EZ = HZ;
  level._box(material, [0, yc, (-EZ + -A) / 2], [EX * 2, PLATE, EZ - A], { tile });
  level._box(material, [0, yc, (EZ + A) / 2], [EX * 2, PLATE, EZ - A], { tile });
  level._box(material, [(-EX + -A) / 2, yc, 0], [EX - A, PLATE, A * 2], { tile });
  level._box(material, [(EX + A) / 2, yc, 0], [EX - A, PLATE, A * 2], { tile });
}

/**
 * The glass railing round a ring, with the stair head left open.
 *
 * `openWest` cuts the length of the west rail the feature stair arrives
 * through — a rail across the top of a staircase is a staircase that goes
 * nowhere, and it is the kind of thing that is invisible until somebody walks
 * up it in a match.
 */
function railing(level, y, { openWest = null } = {}) {
  const h = y + RAIL_H / 2;
  const cap = y + RAIL_H;
  const seg = (mat, pos, size, opts) => level._box(mat, pos, size, opts);

  const R = A - RAIL_IN;
  // North and south rails, full width of the void.
  for (const z of [-R, R]) {
    seg('manorGlass', [0, h, z], [R * 2, RAIL_H, RAIL_T],
      { tile: 2, surface: SURFACE.GLASS });
    seg('brassTrim', [0, cap, z], [R * 2 + 0.1, 0.07, RAIL_T + 0.06], { tile: 1 });
  }
  // East rail, whole.
  seg('manorGlass', [R, h, 0], [RAIL_T, RAIL_H, R * 2],
    { tile: 2, surface: SURFACE.GLASS });
  seg('brassTrim', [R, cap, 0], [RAIL_T + 0.06, 0.07, R * 2 + 0.1], { tile: 1 });

  // West rail, in two pieces around the stair head when there is one.
  if (openWest) {
    const [gz0, gz1] = openWest;
    for (const [z0, z1] of [[-R, gz0], [gz1, R]]) {
      if (z1 - z0 < 0.15) continue;
      seg('manorGlass', [-R, h, (z0 + z1) / 2], [RAIL_T, RAIL_H, z1 - z0],
        { tile: 2, surface: SURFACE.GLASS });
      seg('brassTrim', [-R, cap, (z0 + z1) / 2], [RAIL_T + 0.06, 0.07, z1 - z0], { tile: 1 });
    }
  } else {
    seg('manorGlass', [-R, h, 0], [RAIL_T, RAIL_H, R * 2],
      { tile: 2, surface: SURFACE.GLASS });
    seg('brassTrim', [-R, cap, 0], [RAIL_T + 0.06, 0.07, R * 2 + 0.1], { tile: 1 });
  }
}

/* ------------------------------------------------------------ the atrium */

function buildAtrium(level) {
  /*
   * The pool. A basin 0.4 m deep, which is the number that matters here.
   *
   * A player's autostep is 0.45 m, so a 0.4 m lip is climbed without jumping,
   * without slowing, and without any code knowing about it. Deeper would need
   * steps, a ladder or an exception in the character controller; this needs
   * nothing, and it still reads as a pool because of what is in it.
   */
  const d = POOL_DEPTH;
  level._box('marbleChequer', [0, -d - 0.15, 0], [POOL * 2, 0.3, POOL * 2], { tile: 3 });
  // Four walls of the basin, standing on the slab.
  for (const [x, z, sx, sz] of [
    [0, -POOL, POOL * 2 + 0.4, 0.4], [0, POOL, POOL * 2 + 0.4, 0.4],
    [-POOL, 0, 0.4, POOL * 2], [POOL, 0, 0.4, POOL * 2],
  ]) {
    // Topping out 60 mm BELOW the deck, not flush with it: the coping laid
    // over the join is what the player sees, and a tile lip level with the
    // slab is two materials on one plane.
    level._box('emeraldTile', [x, -d / 2 - 0.03, z], [sx, d - 0.06, sz], { tile: 1.5 });
  }
  /*
   * The water: a single pane just under the coping, drawn and not collided.
   *
   * Not collided because the basin below it already is — a solid surface here
   * would put the water's top face where the player walks, and they would
   * stride across the pool as if it were a floor.
   */
  level._box('paintedTeal', [0, -0.20, 0], [POOL * 2 - 0.3, 0.02, POOL * 2 - 0.3],
    { collide: false, tile: 2.5 });

  // Coping round the pool, a hand's width proud of the deck.
  for (const [x, z, sx, sz] of [
    [0, -POOL - 0.25, POOL * 2 + 1.0, 0.5], [0, POOL + 0.25, POOL * 2 + 1.0, 0.5],
    [-POOL - 0.25, 0, 0.5, POOL * 2], [POOL + 0.25, 0, 0.5, POOL * 2],
  ]) {
    level._box('limestone', [x, 0.20, z], [sx, 0.16, sz], { tile: 1.5 });
  }

  /*
   * THE FEATURE STAIR, ground to first, climbing the atrium's west face.
   *
   * 0.225 m rise over 0.30 m run is 36.9 degrees — steep for a house and well
   * inside the player's 52 degree limit. It is deliberately the steepest thing
   * in the building: it is the short way up, and the price of the short way is
   * being on it, in the open, in the middle of the map.
   */
  /*
   * The top tread stops 40 mm SHORT of the floor it arrives at.
   *
   * A tread whose top face is exactly the landing's is two materials on one
   * plane across the full width of the stair — the most visible shimmer a house
   * can have, because it is under your feet every time you go up. 40 mm is far
   * inside the 0.45 m autostep, so it is walked over without being felt.
   */
  const steps = 16;
  const LAND = 0.04;
  // Started at 3.85 rather than 3.90 so the tread boundaries fall at 3.55,
  // 3.25 and 2.95 — 50 mm clear of the pool coping's edges at 3.5 and 3.0,
  // instead of landing exactly on them.
  level._stairs('walnut', [-A + 0.30, F0, 3.85], [0, -1], steps, (F1 - LAND) / steps, 0.30, 2.0);
  // A brass rail following the pitch, on the open side.
  level._ramp('brassTrim',
    [-A + 1.2, F1 / 2 + 0.95, 3.6 - (steps * 0.30) / 2],
    0.08, steps * 0.30, F1, { rotY: Math.PI, thickness: 0.08, surface: SURFACE.METAL });

  /*
   * A pendant cluster down the middle of the void.
   *
   * Unlit geometry with an emissive material rather than real lights: it is
   * three storeys of vertical space and a light per floor would be three more
   * shadow-casting sources for something nobody looks at directly.
   */
  for (const y of [3.0, 5.4, 7.8]) {
    level._box('brassTrim', [0.6, y + 1.2, -0.4], [0.05, 2.4, 0.05], { collide: false });
    level._box('lampGlow', [0.6, y, -0.4], [0.5, 0.16, 0.5], { collide: false });
  }
}

/* ------------------------------------------------------------ the stairs */

function buildStairs(level) {
  /*
   * THE SERVICE STAIR, north-west, and the only thing that reaches the top.
   *
   * Enclosed on three sides, which is the whole character of it: nothing can
   * see in, so nothing can see out. It is 0.20 over 0.28 — 35.5 degrees, near
   * enough the feature stair's pitch that neither is the "slow" one to climb.
   * What makes it slow is that it is in a corner and goes nowhere interesting.
   */
  const run = 0.28;
  const rise1 = (F1 - 0.04) / 18;   // short of the landing — see above
  level._stairs('concrete', [-11.0, F0, -5.0], [0, -1], 18, rise1, run, 1.6);
  level._stairs('concrete', [-11.0, F1, -10.0], [0, 1], 18, rise1, run, 1.6);

  // The shaft walls, with the two landings left open.
  // Stopping at 9.2 rather than at the ceiling: a shaft wall whose top face is
  // level with the second-floor partitions is two materials on one plane, and
  // the shaft has no reason to reach the roof — it serves two landings.
  const SHAFT_H = 9.2;
  level._box('concreteDark', [-12.1, SHAFT_H / 2, -7.5], [0.3, SHAFT_H, 5.6], { tile: 3 });
  level._box('concreteDark', [-9.6, SHAFT_H / 2, -7.5], [0.3, SHAFT_H, 5.6], { tile: 3 });

  /*
   * THE GYM RUN, first to second, north-east.
   *
   * Not a staircase — a stack of plant: a compressor, a duct, a crate. Every
   * step is inside the 0.45 m autostep, so it is climbed by walking at it, and
   * a player who has not noticed it will never find it by looking for stairs.
   * That is the point of it: the house has a shortcut only its residents know.
   */
  const base = F1;
  level._box('metalPanel', [11.4, base + 0.22, -8.6], [2.4, 0.44, 1.6], { tile: 1 });
  level._box('metalPanel', [11.4, base + 0.66, -7.2], [2.4, 0.44, 1.4], { tile: 1 });
  level._box('crate', [10.4, base + 1.10, -6.0], [1.6, 0.44, 1.4], { tile: 1 });
  level._box('metalPanel', [9.0, base + 1.54, -5.2], [1.8, 0.44, 1.6], { tile: 1 });
  level._box('metalPanel', [9.0, base + 1.98, -3.9], [1.8, 0.44, 1.2], { tile: 1 });
  // ...and the last step onto the second ring, which is 3.6 - 1.98 = 1.62 up.
  // Too tall to walk, so it is a proper flight of four.
  level._stairs('metalPanel', [9.0, base + 1.98, -3.3], [0, 1], 6, (1.62 - 0.04) / 6, 0.30, 1.8);
}

/* ------------------------------------------------------- ground floor */

function buildGround(level) {
  const H = 3.3;                 // ceiling of this storey (underside of the plate)
  const P = (axis, at, from, to, gaps, mat) =>
    level._wallWithGaps(mat, axis, at, from, to, H, 0.28, gaps, { baseY: F0, doorH: 2.3 });

  /*
   * The ground floor is FOUR ROOMS AROUND THE ATRIUM and nothing else. No
   * corridors: a corridor is a place where two players meet with no choice
   * about it, and a house full of them is a house full of coin flips.
   */
  // Kitchen (west) from the entrance hall (south).
  P('z', 4.0, -HX, -A, [[-9.5, -7.5]], 'plasterCream');
  // Living (east) from the entrance hall.
  P('z', 4.0, A, HX, [[7.5, 9.5]], 'walnut');
  // The north wall, dividing garage and gym from the atrium deck.
  P('z', -4.0, -HX, -1.0, [[-8.0, -6.0]], 'concrete');
  P('z', -4.0, -1.0, HX, [[3.0, 5.0]], 'concrete');
  // Garage from gym.
  P('x', -1.0, -HZ, -4.0, [[-8.0, -6.2]], 'concrete');

  // --- kitchen: white, steel, and an island to fight around -----------------
  level._box('marbleChequer', [-8.5, 0.05, 0], [9, 0.04, 8], { collide: false, tile: 3 });
  level._box('metalPanel', [-8.5, 0.45, 0], [3.4, 0.9, 1.4], { tile: 1.2 });   // island
  level._box('limestone', [-8.5, 0.93, 0], [3.6, 0.08, 1.6], { tile: 1 });     // worktop
  level._box('metalPanel', [-12.3, 1.1, -2.0], [1.2, 2.2, 2.4], { tile: 1.2 }); // fridge
  level._box('metalPanel', [-8.5, 0.45, 3.2], [6.0, 0.9, 0.7], { tile: 1.2 });  // run
  level._box('limestone', [-8.5, 0.93, 3.2], [6.2, 0.08, 0.8], { tile: 1 });

  // --- living (east): warm, low cover, the map's quiet corner ---------------
  level._box('oakFloor', [8.5, 0.05, 0], [9, 0.04, 8], { collide: false, tile: 3 });
  level._box('carpetOx', [8.5, 0.10, 0], [5.5, 0.03, 4.5], { collide: false, tile: 2 });
  level._box('linenSoft', [8.5, 0.35, 2.4], [3.6, 0.7, 0.9], { tile: 1 });     // sofa
  level._box('linenSoft', [8.5, 0.35, -2.4], [3.6, 0.7, 0.9], { tile: 1 });
  level._box('walnut', [8.5, 0.22, 0], [1.8, 0.44, 1.0], { tile: 1 });         // table
  level._box('concreteDark', [12.4, 1.3, 0], [0.8, 2.6, 3.0], { tile: 1.5 });  // hearth

  // --- garage (north-west): concrete, stripes, and a car -------------------
  level._box('concrete', [-7.0, 0.05, -7.5], [11.5, 0.04, 6.5], { collide: false, tile: 4 });
  for (const z of [-5.0, -10.0]) {
    level._box('hazard', [-7.0, 0.11, z], [11.5, 0.05, 0.3], { collide: false, tile: 4 });
  }
  level._box('carDuco', [-7.0, 0.75, -7.6], [4.6, 1.1, 2.0], { tile: 1 });     // body
  level._box('manorGlass', [-7.0, 1.45, -7.6], [2.6, 0.5, 1.9],
    { tile: 1, surface: SURFACE.GLASS });                                       // cabin
  level._box('metalPanel', [-11.6, 1.0, -10.2], [1.6, 2.0, 0.7], { tile: 1 });  // lockers

  // --- gym (north-east): green tile, plant, and the run up ------------------
  level._box('emeraldTile', [6.5, 0.05, -7.5], [12, 0.04, 6.5], { collide: false, tile: 4 });
  level._box('metalPanel', [11.6, 0.6, -9.6], [2.2, 1.2, 1.6], { tile: 1 });   // rack
  level._box('crate', [4.0, 0.5, -9.8], [1.2, 1.0, 1.2], { tile: 1 });
  level._box('metalPanel', [2.0, 0.35, -6.0], [1.6, 0.7, 2.4], { tile: 1 });   // bench

  // --- entrance hall (south): limestone under two storeys of glass ---------
  level._box('limestone', [0, 0.05, 7.5], [HX * 2 - 1, 0.04, 6.5], { collide: false, tile: 4 });
  level._box('limestone', [-4.5, 0.5, 8.0], [1.0, 1.0, 1.0], { tile: 1 });     // planters
  level._box('limestone', [4.5, 0.5, 8.0], [1.0, 1.0, 1.0], { tile: 1 });
}

/* --------------------------------------------------------- the first ring */

function buildFirst(level) {
  ring(level, F1, 'oakFloor', 3);
  railing(level, F1, { openWest: [1.4, 3.9] });

  const H = F1 + 3.3;
  const P = (axis, at, from, to, gaps, mat) =>
    level._wallWithGaps(mat, axis, at, from, to, 3.3, 0.28, gaps, { baseY: F1, doorH: 2.3 });

  // Master (east), two bedrooms (west), bathroom (north), study (south).
  P('z', 4.0, A, HX, [[6.0, 8.0]], 'walnut');
  P('z', -4.0, A, HX, [[6.0, 8.0]], 'plasterCream');
  P('z', 4.0, -HX, -A, [[-8.0, -6.0]], 'plasterCream');
  P('z', -4.0, -HX, -A, [[-7.0, -5.0]], 'plasterCream');
  P('x', -8.0, 4.5, HZ, [[7.5, 9.5]], 'plasterCream');
  P('x', 4.0, -HZ, -4.5, [[-8.5, -6.5]], 'emeraldTile');

  // --- master bedroom (east) ----------------------------------------------
  level._box('carpetOx', [8.5, F1 + 0.06, 7.2], [8, 0.04, 5.5], { collide: false, tile: 3 });
  level._box('linenSoft', [9.5, F1 + 0.3, 7.6], [2.6, 0.6, 2.0], { tile: 1 });  // bed
  level._box('walnut', [12.2, F1 + 0.35, 5.0], [1.0, 0.7, 1.6], { tile: 1 });

  // --- bedrooms (west) ----------------------------------------------------
  level._box('oakFloor', [-8.5, F1 + 0.06, 7.2], [8, 0.04, 5.5], { collide: false, tile: 3 });
  level._box('linenSoft', [-11.0, F1 + 0.3, 8.2], [2.0, 0.6, 1.8], { tile: 1 });
  level._box('oakFloor', [-8.5, F1 + 0.06, -7.2], [8, 0.04, 5.5], { collide: false, tile: 3 });
  level._box('linenSoft', [-11.0, F1 + 0.3, -8.2], [2.0, 0.6, 1.8], { tile: 1 });

  // --- bathroom (north-east): the one room with no line into the atrium ----
  level._box('emeraldTile', [8.5, F1 + 0.06, -7.2], [8, 0.04, 5.5], { collide: false, tile: 3 });
  level._box('marbleChequer', [11.2, F1 + 0.40, -5.6], [1.6, 0.8, 2.4], { tile: 1 });

  // --- study (south), under the glass -------------------------------------
  level._box('walnut', [0, F1 + 0.4, 7.0], [3.0, 0.8, 1.2], { tile: 1 });      // desk
  level._box('walnut', [-2.6, F1 + 0.9, 9.6], [2.0, 1.8, 0.5], { tile: 1 });   // shelves
}

/* -------------------------------------------------------- the second ring */

function buildSecond(level) {
  ring(level, F2, 'concrete', 3);
  railing(level, F2);

  const P = (axis, at, from, to, gaps, mat) =>
    level._wallWithGaps(mat, axis, at, from, to, CEIL - F2, 0.28, gaps,
      { baseY: F2, doorH: 2.3 });

  /*
   * The top floor is deliberately the OPENEST, which is the reverse of the
   * usual instinct.
   *
   * Height is already an advantage; giving the high ground walls to hide behind
   * as well is how a top floor becomes a camping spot nobody can dig out. Up
   * here there are two partitions and no doors — everything is sightline, from
   * the rail or across the void, and anyone standing on it can be shot at from
   * the opposite side of the house.
   */
  P('x', -6.0, -HZ, -4.5, [[-8.5, -6.5]], 'concrete');
  P('x', 6.0, 4.5, HZ, [[6.5, 8.5]], 'concrete');

  // A roof lounge: low seating, planters, and the plant the gym run arrives at.
  level._box('carpetOx', [8.0, F2 + 0.06, 6.5], [7, 0.04, 6], { collide: false, tile: 3 });
  level._box('linenSoft', [8.0, F2 + 0.3, 8.5], [4.0, 0.6, 0.9], { tile: 1 });
  level._box('limestone', [10.1, F2 + 0.4, 5.2], [1.0, 0.8, 3.0], { tile: 1 });
  level._box('limestone', [-9.0, F2 + 0.4, 6.0], [3.0, 0.8, 1.0], { tile: 1 });
  level._box('limestone', [-9.0, F2 + 0.4, -6.0], [3.0, 0.8, 1.0], { tile: 1 });
  level._box('metalPanel', [11.0, F2 + 0.55, -7.0], [2.4, 1.1, 2.0], { tile: 1 });
}

/* ------------------------------------------------------------------ props */

function buildProps(level) {
  /*
   * Two barrels, both on the ground floor and both away from a spawn.
   *
   * Fields set through the ATOMIC `explosive` option. Setting them piecemeal
   * leaves `blastRadius` undefined, `dist > undefined` is false, and every
   * dynamic body in the level takes a NaN impulse — which is how players ended
   * up falling through the world the last time this was done by hand.
   */
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.1, 14);
  for (const [x, z] of [[-12.0, -4.8], [12.0, -9.8]]) {
    level._spawnProp({
      geometry: barrelGeo,
      material: 'explosiveBarrel',
      position: new THREE.Vector3(x, 0.56, z),
      shape: 'cylinder',
      // HEIGHT and RADIUS, never three half-extents: {x,y,z} here leaves the
      // radius undefined, and one non-finite collider disables Rapier's entire
      // query pipeline — see the guard in PhysicsWorld.
      half: { y: 0.55, r: 0.35 },
      mass: 40,
      surface: SURFACE.METAL,
      kind: TAG_KIND.EXPLOSIVE,
      /*
       * A tighter blast than the yard's 7.5 m, because this is a house: at 6 m
       * one barrel in the garage would otherwise reach the kitchen through a
       * wall, and a room you can be killed in from a room you cannot see is
       * not a room anybody will use.
       */
      explosive: { radius: 6.0, damage: 90, force: 320 },
    });
  }

  const crateGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  for (const [x, z] of [[3.6, -10.0], [-4.4, 9.6], [11.0, 3.2]]) {
    level._spawnProp({
      geometry: crateGeo,
      material: 'crate',
      position: new THREE.Vector3(x, 0.42, z),
      shape: 'box',
      half: { x: 0.4, y: 0.4, z: 0.4 },
      mass: 24,
      surface: SURFACE.WOOD,
    });
  }
}

/**
 * Pickups, placed to pull players OFF the rings and back down the house.
 *
 * Armour is the prize and it is at the bottom, in the water, in the most
 * overlooked spot on the map — the one place every rail can see. Health is in
 * the two rooms with no line into the atrium, so a hurt player has somewhere to
 * go that is not simply "away".
 */
function buildPickups(level) {
  level.pickupSpots = [
    { type: 'armor', pos: new THREE.Vector3(0, 0.4, 0) },
    { type: 'armor', pos: new THREE.Vector3(8.5, F2 + 0.6, 6.5) },
    { type: 'health', pos: new THREE.Vector3(8.5, F1 + 0.6, -7.2) },
    { type: 'health', pos: new THREE.Vector3(-3.0, 0.6, -6.0) },
    { type: 'health', pos: new THREE.Vector3(0, F1 + 0.6, 8.6) },
    { type: 'ammo', pos: new THREE.Vector3(-12.0, 0.6, 2.5) },
    { type: 'ammo', pos: new THREE.Vector3(8.5, 0.6, 0) },
    { type: 'ammo', pos: new THREE.Vector3(-8.0, F1 + 0.6, 8.5) },
    { type: 'ammo', pos: new THREE.Vector3(-8.0, F1 + 0.6, -8.5) },
    { type: 'ammo', pos: new THREE.Vector3(0, 0.6, 8.4) },
    { type: 'ammo', pos: new THREE.Vector3(-11.0, F2 + 0.6, 3.0) },
  ];
}

/* ------------------------------------------------------------- definition */

export const villaMap = Object.freeze({
  id: 'villa',
  name: 'VILLA',
  tagline: 'Hillside house, golden hour',
  description:
    'Three floors of balcony around one glass-roofed atrium with a pool at the '
    + 'bottom. Every rail sees the whole house — and the whole house sees you.',
  scale: 'SMALL',
  span: '26 m',
  players: '2-10',
  accent: '#f2a25c',
  swatch: ['#f2e3d0', '#2e9b8f', '#c46a33'],

  /** Top-down sketch for the map card — see drawPlan in MenuManager. */
  plan: [
    [0, -7.5, 26, 7],
    [-8.5, 0, 9, 8], [8.5, 0, 9, 8],
    [0, 7.5, 25, 6],
    [0, 0, 6, 6],
  ],

  thumbCam: { pos: [17, 14, 21], look: [0, 3, 0], fov: 55 },
  playerSpawn: [0, 1.1, 8.4],
  playerSpawnYaw: Math.PI,
  bounds: { min: [-14, 0, -12], max: [14, 12, 12] },

  /**
   * Golden hour, and the sun is low on purpose.
   *
   * 14 degrees is the whole lighting design: it rakes through two storeys of
   * south glass, throws the mullions across the atrium floor as long bars, and
   * leaves the north rooms in shadow. A high sun would light the house evenly
   * and it would look like every other interior.
   *
   * The shadow bias is set for that elevation rather than for a midday sun —
   * a low sun stretches each shadow across many more texels, and the
   * warehouse's midday figure leaves acne crawling over every wall here.
   */
  env: {
    sky: { turbidity: 4.2, rayleigh: 2.4, mie: 0.005, mieG: 0.86,
           elevation: 14, azimuth: 168 },
    envIntensity: 0.72,
    fog: { color: 0xe9b98a, density: 0.008 },
    sun: {
      color: 0xffc27a, intensity: 3.1, shadowHalf: 22, shadowFar: 120,
      bias: -0.0024, normalBias: 0.10,
    },
    hemi: { sky: 0xf0d8c0, ground: 0x4a4038, intensity: 0.85 },
    ambient: { color: 0x6b5c50, intensity: 0.5 },
    // Cool bounce off the water and the pale plaster, so the shadow side reads
    // blue against all that orange rather than going muddy brown.
    bounce: { color: 0x86b6c8, intensity: 0.6 },
  },

  build(level) {
    buildShell(level);
    buildGround(level);
    buildAtrium(level);
    buildFirst(level);
    buildSecond(level);
    buildStairs(level);
    level._flush();

    buildProps(level);
    buildPickups(level);
  },
});

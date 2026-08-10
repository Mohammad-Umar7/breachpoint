/**
 * LODGE — a two-storey house, built deliberately small.
 *
 * WHY THIS ONE IS SIMPLER THAN THE LAST TWO
 * -----------------------------------------
 * MANOR was ten rooms a floor joined by 1.4 m doorways: unreadable, and a
 * corridor duel every time. VILLA answered that with three storeys, a
 * double-height atrium and three different kinds of route, and was unplayable —
 * a partition standing across the main staircase, a climbable stack that read
 * as slabs hanging in mid-air, and a spawn you had to jump out of.
 *
 * Neither failed because of its theme. Both failed because they were more house
 * than could be checked. So this is the smallest thing that is still a house
 * and still worth fighting in:
 *
 *   TWO floors, not three.
 *   ONE staircase, wide, central, in full view.
 *   FOUR rooms a floor around one hall, and every room has TWO ways out.
 *   Openings 2.6 m wide, so no doorway is a coin toss.
 *
 * THE SHAPE
 * ---------
 * A 24 x 18 shell. The middle 7 m is a hall running the full depth; its
 * southern two-thirds is open to the roof, lit by full-height glazing, with the
 * stair climbing straight up the middle of the void. The upper floor is a deep
 * landing across the north end plus two rooms a side, and its edge onto the
 * void is the way back down — 3.6 m, which is a quarter of the 14.08 m a fall
 * needs to hurt. So holding the stair does not hold the floor.
 */

import * as THREE from 'three';
import { SURFACE } from '../../core/AssetManager.js';
import { TAG_KIND } from '../../physics/PhysicsWorld.js';

/* ------------------------------------------------------------- dimensions */

const HX = 12, HZ = 9;           // the shell: 24 m by 18 m
const F1 = 3.6;                  // upper floor level
const PLATE = 0.3;               // how thick that floor is
const CEIL = 7.2;                // underside of the roof
const WALL_T = 0.3;
const DOOR_W = 2.6;
const DOOR_H = 2.4;

/** Half-width of the hall, and so the x of both hall walls. */
const HALL = 3.6;
/** Where the plate stops beside the hall: 0.2 m proud of the wall centre. */
const EDGE = 3.4;
/** The double-height part of the hall, in z. */
const VOID_Z0 = 1.0;

/** Every opening in the house, centred on `c`. */
const door = (c) => [c - DOOR_W / 2, c + DOOR_W / 2];

/* ------------------------------------------------------------------ walls
 *
 * TWO NAMED HELPERS, and this is the entire reason they exist.
 *
 * `_wallWithGaps(material, axis, fixed, from, to, ...)` takes the axis a wall
 * RUNS ALONG plus the coordinate it stands at. Read those two the other way
 * round and every partition in the house is built at ninety degrees to intent —
 * the wall meant to divide the kitchen from the hall ends up across the foot of
 * the staircase instead. The map still builds. Nothing shimmers. Every spawn is
 * still in open air. It is simply not a house any more.
 *
 * That is not hypothetical; it is exactly what happened to the last one. So the
 * axis is never spelled at a call site again: `wallAlongX` takes the z it
 * stands at, `wallAlongZ` takes the x, and confusing them is now a mistake a
 * reader can see rather than a silent transposition.
 */
function wallAlongX(level, mat, z, x0, x1, gaps, o = {}) {
  const { baseY = 0, height = CEIL } = o;
  level._wallWithGaps(mat, 'x', z, x0, x1, height, WALL_T, gaps, { baseY, doorH: DOOR_H });
}
function wallAlongZ(level, mat, x, z0, z1, gaps, o = {}) {
  const { baseY = 0, height = CEIL } = o;
  level._wallWithGaps(mat, 'z', x, z0, z1, height, WALL_T, gaps, { baseY, doorH: DOOR_H });
}

/* ----------------------------------------------------------------- shell */

function buildShell(level) {
  // One slab under everything, thick enough that no seam in it can be a hole.
  level._box('screedFloor', [0, -0.5, 0], [HX * 2 + 2, 1, HZ * 2 + 2],
    { tile: 5, surface: SURFACE.CONCRETE });

  /*
   * Walls run PAST each other at the corners and up INTO the roof.
   *
   * Two coplanar faces in different materials is what shimmers, and the shell
   * is where they are easiest to make by accident — a wall whose top is level
   * with the ceiling, a side wall ending exactly on the end wall's face. So the
   * side walls are longer than the house and every wall is taller than the
   * ceiling, and all six of those joins end up buried out of sight.
   *
   * They are also all DIFFERENT heights, which matters as much as the plan.
   * Cream plaster and brick topping out at exactly 7.6 m share a horizontal
   * plane down the whole length of both corners, and a shared plane between two
   * materials is the flicker itself. 0.3 m of difference is an order of
   * magnitude over the 0.035 m the depth buffer can resolve.
   */
  const H = CEIL + 0.4;
  level._box('plasterCream', [-HX, H / 2, 0], [WALL_T * 2, H, HZ * 2 + 1.2], { tile: 3 });
  level._box('plasterCream', [HX, H / 2, 0], [WALL_T * 2, H, HZ * 2 + 1.2], { tile: 3 });
  level._box('manorBrick', [0, (H + 0.3) / 2, -HZ], [HX * 2, H + 0.3, WALL_T * 2], { tile: 3 });

  /*
   * The south wall is glass above waist height: you can see and shoot through
   * it and you cannot leave through it. It is what lights the hall, and it is
   * why the void is at the south end rather than the middle.
   */
  level._box('manorBrick', [0, 0.55, HZ], [HX * 2, 1.1, WALL_T * 2], { tile: 3 });

  /*
   * THREE windows and four piers, not one unbroken sheet of glass.
   *
   * The first version glazed the whole 24 m, and from inside it read as a blank
   * white wall: this glass is opacity 0.42 with an envMap intensity of 2.2, so
   * against a bright sky it saturates and you cannot tell a window from
   * plaster. Breaking it into three openings — one per room, aligned on their
   * centres — means the same white now reads as WINDOWS, because there is solid
   * wall beside it to read them against.
   *
   * Each opening runs 0.1 m into its piers so there is no hairline to see
   * daylight through, and the piers are the same cream as the side walls so no
   * new material boundary is created along the whole south elevation.
   */
  const WIN = [[-7.7, 4.8], [0, 5.2], [7.7, 4.8]];   // centre, width
  for (const [cx, w] of WIN) {
    level._box('manorGlass', [cx, (CEIL + 1.1) / 2, HZ], [w + 0.2, CEIL - 1.1, 0.14],
      { tile: 4, surface: SURFACE.GLASS });
    // One mullion down the middle of each, run up past the head into the roof:
    // two materials must never share a top face, here least of all.
    level._box('brassTrim', [cx, (CEIL + 0.5 + 1.1) / 2, HZ],
      [0.16, CEIL + 0.5 - 1.1, 0.34], { tile: 1 });
  }
  /*
   * These MUST reach the glass, and for a long time they did not.
   *
   * The comment above promises each opening runs 0.1 m into its piers. The
   * numbers did the opposite: glass spanned to ±10.2 and ±2.7 while the piers
   * started at ±10.4 and ±2.9, leaving four 0.2 m slots of nothing at
   * x ≈ ±2.8 and ±10.3 — open from the sill at 1.1 all the way to the ceiling
   * at 7.2. You could see the sky through them from the hall, and a bullet
   * fired into one left the house without leaving a mark.
   *
   * Each pier now overlaps its glass by the intended 0.1 m on every edge, and
   * the faces stay 0.23 m clear of the glass faces — well past the coincident
   * -face threshold `test/maps.mjs` enforces, so no new shimmer.
   */
  const PIER = [[-11.05, 1.9], [-3.95, 2.7], [3.95, 2.7], [11.05, 1.9]];
  for (const [cx, w] of PIER) {
    level._box('plasterCream', [cx, (H + 1.1) / 2, HZ], [w, H - 1.1, WALL_T * 2], { tile: 3 });
  }

  // Roof, oversailing every wall under it.
  level._box('concreteDark', [0, CEIL + 0.3, 0], [HX * 2 + 2.4, 0.6, HZ * 2 + 2.4], { tile: 5 });

  /*
   * A plaster soffit UNDER that roof.
   *
   * The roof slab is dark aggregate concrete, which is right for a roof seen
   * from outside and quite wrong seen from underneath — over a double-height
   * hall it reads as a road surface hanging above the room. The soffit is a
   * separate skin, non-colliding, hung 80 mm below the slab.
   *
   * Both of those clearances are deliberate. Its top face must NOT be level
   * with the head of the glazing, or the two share a plane across all three
   * windows; and its edges must not be level with the outside of the walls, or
   * they share one with the brick. The 80 mm void it leaves is buried inside
   * the walls at every edge, so there is nowhere to see it from.
   */
  // The 0.5 on z rather than 0.4 clears the mullions, which stand 0.17 proud of
  // the glass line: at 0.4 the soffit edge landed 30 mm from their front face,
  // inside the 35 mm the depth buffer can still tell apart.
  level._box('plasterCream', [0, CEIL - 0.12, 0], [HX * 2 + 0.4, 0.08, HZ * 2 + 0.5],
    { collide: false, tile: 4 });
}

/* --------------------------------------------------------------- the stair
 *
 * ONE flight, 2.6 m wide, dead centre of the hall, climbing north through the
 * void with 2.1 m of clear floor either side of it.
 *
 * Wide because a narrow stair is a duel nobody chose. Straight because a turn
 * hands the defender a blind half-landing. Free-standing in the middle of a
 * double-height room because that is the trade for it being the only way up:
 * whoever is climbing it can be seen, and shot, from anywhere in the hall.
 *
 * `_stairs` builds each tread as a box from y=0 up, so the flight is solid —
 * there is no space beneath it to hide in and no thin shell to fall through.
 */
const STEPS = 18;
const RUN = 0.34;
const STAIR_Z0 = 6.9;                       // the bottom tread's south face

function buildStair(level) {
  /*
   * The top tread stops 40 mm BELOW the landing and reaches 220 mm UNDER it.
   *
   * Below, because a tread whose top face is exactly the floor's is two
   * materials on one plane, and it would be underfoot every single time anyone
   * goes upstairs. Under, because a flight that merely arrives level with the
   * floor's edge leaves a hairline seam to catch on — and a flight that stops
   * short of the edge is the villa bug exactly: eighteen steps up to a 1.16 m
   * gap you had to jump.
   *
   * 18 x 0.34 = 6.12 m of run from z=6.9 ends at z=0.78, and the landing
   * begins at VOID_Z0 = 1.0. Change either number and check that sign again.
   */
  level._stairs('walnut', [0, 0, STAIR_Z0], [0, -1], STEPS, (F1 - 0.04) / STEPS, RUN, 2.6);
}

/* ------------------------------------------------------------ upper floor */

function buildPlate(level) {
  const y = F1 - PLATE / 2;
  const EX = HX - 0.15;          // run into the exterior walls, not up to them

  /*
   * Three bands that BUTT, never overlap. Two slabs overlapping share a top
   * face at exactly the same height, which z-fights whether or not they are the
   * same material; two slabs meeting edge to edge hide the join between two
   * solids, where backface culling never draws it.
   */
  level._box('oakFloor', [(-EX - EDGE) / 2, y, 0], [EX - EDGE, PLATE, HZ * 2], { tile: 3 });
  level._box('oakFloor', [(EX + EDGE) / 2, y, 0], [EX - EDGE, PLATE, HZ * 2], { tile: 3 });
  level._box('limestone', [0, y, (-HZ + VOID_Z0) / 2], [EDGE * 2, PLATE, HZ + VOID_Z0],
    { tile: 3 });

  /*
   * A glass balustrade round the void, INSET 0.6 m from the drop.
   *
   * Inset rather than flush because the edge sits directly above the hall
   * walls, and a rail on the same plane as a wall face shimmers along its whole
   * length. 0.6 m also leaves a ledge outside it of 0.56 m — narrower than the
   * 0.8 m a player occupies, so nobody can stand out there.
   *
   * It is 1.0 m tall: under the 1.30 m jump apex and over the 0.45 m autostep.
   * You cannot walk off the balcony by accident, and you can always choose to.
   * That choice is the second route down.
   */
  const RH = 1.0;
  const rail = (x, z, sx, sz) => {
    level._box('manorGlass', [x, F1 + RH / 2, z], [sx, RH, sz],
      { tile: 2, surface: SURFACE.GLASS });
    level._box('brassTrim', [x, F1 + RH + 0.05, z], [sx + 0.1, 0.1, sz + 0.1], { tile: 1 });
  };
  rail(-(EDGE + 0.6), 5.0, 0.08, 7.6);
  rail(EDGE + 0.6, 5.0, 0.08, 7.6);
  // The north rail stops either side of the stair head. A continuous one here
  // would fence off the top of the only staircase in the house.
  rail(-2.35, VOID_Z0 - 0.4, 1.3, 0.08);
  rail(2.35, VOID_Z0 - 0.4, 1.3, 0.08);
}

/* ------------------------------------------------------------- the rooms */

function buildGround(level) {
  const H = F1 - PLATE;          // 3.3 m: the cross walls meet the plate exactly

  /*
   * Four rooms, and every one has TWO ways in: one to the hall, one to its
   * neighbour. A room with a single door is a room you can be cornered in, and
   * a floor of them is what made the last house miserable to play.
   *
   * The hall walls are 0.15 m TALLER than the cross walls that run into them.
   * Where a walnut wall and a cream one top out at the same height they share a
   * horizontal plane at every junction, which flickers; and since the plate
   * covers this whole line anyway, the extra 0.15 m is buried inside it and
   * costs nothing to look at.
   *
   * They also run 0.2 m PAST the shell at both ends. Stopping at ±9 would put
   * their end faces on exactly the plane where the floor plate above stops,
   * which is the same fault one axis over — and it would be four seams running
   * the full height of the hall.
   */
  wallAlongZ(level, 'plasterCream', -HALL, -HZ - 0.2, HZ + 0.2, [door(-4.9), door(4.3)],
    { height: H + 0.15 });
  wallAlongZ(level, 'walnut', HALL, -HZ - 0.2, HZ + 0.2, [door(-4.9), door(4.3)],
    { height: H + 0.15 });
  wallAlongX(level, 'plasterCream', -1.0, -HX, -HALL, [door(-7.7)], { height: H });
  wallAlongX(level, 'plasterCream', -1.0, HALL, HX, [door(7.7)], { height: H });

  // --- kitchen, north-west: white, steel, and a hard corner to hold --------
  level._box('marbleChequer', [-7.7, 0.05, -4.9], [7.9, 0.04, 7.5], { collide: false, tile: 3 });
  level._box('metalPanel', [-8.0, 0.45, -5.0], [3.0, 0.9, 1.3], { tile: 1.2 });
  level._box('limestone', [-8.0, 0.94, -5.0], [3.3, 0.09, 1.6], { tile: 1 });
  level._box('metalPanel', [-11.0, 1.1, -7.6], [1.1, 2.2, 2.0], { tile: 1.2 });

  // --- living, south-west: timber and wool, the softest room in the house --
  level._box('oakFloor', [-7.7, 0.05, 3.9], [7.9, 0.04, 9.5], { collide: false, tile: 3 });
  level._box('carpetOx', [-7.7, 0.11, 4.5], [5.4, 0.04, 5.4], { collide: false, tile: 2 });
  level._box('linenSoft', [-8.0, 0.35, 2.2], [3.2, 0.7, 0.9], { tile: 1 });
  level._box('walnut', [-8.0, 0.24, 4.6], [1.6, 0.48, 0.9], { tile: 1 });

  // --- garage, north-east: concrete, and a car to fight around ------------
  level._box('concrete', [7.7, 0.05, -4.9], [7.9, 0.04, 7.5], { collide: false, tile: 4 });
  level._box('hazard', [7.7, 0.12, -1.6], [7.9, 0.05, 0.3], { collide: false, tile: 4 });
  level._box('carDuco', [8.2, 0.75, -5.4], [4.4, 1.1, 1.9], { tile: 1 });
  level._box('manorGlass', [8.2, 1.5, -5.4], [2.5, 0.5, 1.8], { tile: 1, surface: SURFACE.GLASS });

  // --- den, south-east: the one saturated colour in the house --------------
  level._box('emeraldTile', [7.7, 0.05, 3.9], [7.9, 0.04, 9.5], { collide: false, tile: 3 });
  level._box('crate', [10.4, 0.45, 7.2], [1.0, 0.9, 1.0], { tile: 1 });
  level._box('metalPanel', [11.2, 0.4, 2.0], [1.0, 0.8, 2.4], { tile: 1 });

  /*
   * --- and the hall itself -------------------------------------------------
   *
   * The stone floor goes AROUND the staircase in four pieces rather than one
   * slab across the whole hall.
   *
   * One slab is what it was, and because `_stairs` builds every tread as a box
   * rising from y=0, a 40 mm overlay floating at 50 mm slices horizontally
   * through the face of every single step. It is not subtle — the flight had a
   * grey stone band ruled across it from bottom to top, and you can see it in
   * any screenshot taken from the hall. The stair occupies x -1.3..1.3 over
   * z 0.78..6.9, so the stone stops clear of that on all four sides.
   */
  level._box('limestone', [0, 0.05, -4.05], [6.9, 0.04, 9.5], { collide: false, tile: 4 });
  level._box('limestone', [0, 0.05, 7.9], [6.9, 0.04, 1.8], { collide: false, tile: 4 });
  level._box('limestone', [-2.43, 0.05, 3.85], [2.05, 0.04, 6.3], { collide: false, tile: 4 });
  level._box('limestone', [2.43, 0.05, 3.85], [2.05, 0.04, 6.3], { collide: false, tile: 4 });
  level._box('carpetOx', [0, 0.11, 8.0], [4.6, 0.04, 1.2], { collide: false, tile: 2 });
}

function buildUpper(level) {
  const H = CEIL - F1;           // 3.6 m upstairs

  /*
   * Upstairs the two NORTH rooms open onto the landing through doors, and the
   * two SOUTH rooms open straight onto the balcony rail. So the north pair is
   * reached the slow way and left the slow way, the south pair is one vault
   * from the hall floor, and each pair is joined to the other — so neither is
   * a dead end.
   */
  // Same 0.15 m again, and the same reason — except up here the hall walls go
  // UP into the roof slab rather than into a floor plate.
  wallAlongZ(level, 'plasterCream', -HALL, -HZ, VOID_Z0, [door(-4.9)],
    { baseY: F1, height: H + 0.15 });
  wallAlongZ(level, 'walnut', HALL, -HZ, VOID_Z0, [door(-4.9)],
    { baseY: F1, height: H + 0.15 });
  wallAlongX(level, 'plasterCream', VOID_Z0, -HX, -EDGE, [door(-7.7)], { baseY: F1, height: H });
  wallAlongX(level, 'plasterCream', VOID_Z0, EDGE, HX, [door(7.7)], { baseY: F1, height: H });

  // --- two bedrooms west ---------------------------------------------------
  level._box('oakFloor', [-7.7, F1 + 0.06, -4.9], [7.9, 0.04, 7.5], { collide: false, tile: 3 });
  level._box('linenSoft', [-10.6, F1 + 0.3, -6.4], [2.0, 0.6, 1.9], { tile: 1 });
  level._box('carpetOx', [-7.6, F1 + 0.06, 5.0], [7.7, 0.04, 7.2], { collide: false, tile: 3 });
  level._box('linenSoft', [-10.6, F1 + 0.3, 5.6], [2.0, 0.6, 1.9], { tile: 1 });

  // --- bathroom and study east ---------------------------------------------
  level._box('emeraldTile', [7.7, F1 + 0.06, -4.9], [7.9, 0.04, 7.5], { collide: false, tile: 3 });
  level._box('marbleChequer', [11.0, F1 + 0.45, -6.6], [1.4, 0.9, 2.0], { tile: 1 });
  level._box('oakFloor', [7.6, F1 + 0.06, 5.0], [7.7, 0.04, 7.2], { collide: false, tile: 3 });
  level._box('walnut', [11.0, F1 + 0.4, 3.0], [1.0, 0.8, 2.4], { tile: 1 });

  // --- the landing ---------------------------------------------------------
  level._box('limestone', [0, F1 + 0.06, -4.2], [6.4, 0.04, 9.0], { collide: false, tile: 3 });
}

/* ------------------------------------------------------------------ props */

function buildProps(level) {
  /*
   * Explosive fields go in through the ATOMIC `explosive` option. Setting them
   * one at a time leaves `blastRadius` undefined, `dist > undefined` is false,
   * every dynamic body takes a NaN impulse, and one non-finite collider then
   * disables every raycast on the map.
   */
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.1, 14);
  for (const [x, z] of [[11.0, -2.6], [-11.0, 1.4]]) {
    level._spawnProp({
      geometry: barrelGeo,
      material: 'explosiveBarrel',
      position: new THREE.Vector3(x, 0.56, z),
      shape: 'cylinder',
      // HEIGHT and RADIUS. Passing {x,y,z} here leaves the radius undefined,
      // which is the non-finite collider described above.
      half: { y: 0.55, r: 0.35 },
      mass: 40,
      surface: SURFACE.METAL,
      kind: TAG_KIND.EXPLOSIVE,
      // 5.5 m, not the yard's 7.5. This is a house: any wider and one barrel
      // kills through a wall, from a room the victim could not have seen.
      explosive: { radius: 5.5, damage: 85, force: 300 },
    });
  }
  const crateGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  for (const [x, z] of [[-2.3, -7.4], [2.3, -4.6], [2.5, 7.9]]) {
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

/** Spread so no room holds two, and the armour is worth the climb. */
function buildPickups(level) {
  level.pickupSpots = [
    { type: 'armor', pos: new THREE.Vector3(0, F1 + 0.6, -6.0) },
    { type: 'armor', pos: new THREE.Vector3(0, 0.6, 6.0) },
    { type: 'health', pos: new THREE.Vector3(-6.0, 0.6, -7.5) },
    { type: 'health', pos: new THREE.Vector3(8.0, 0.6, 7.5) },
    // Moved north out of the south-west bedroom's far end: blue's CTF base
    // stands at (-8.5, 6.5) up here, and a health pack 1.4 m from a flag is
    // one pickup prompt fighting another every time anyone defends it.
    { type: 'health', pos: new THREE.Vector3(-7.5, F1 + 0.6, 3.0) },
    { type: 'ammo', pos: new THREE.Vector3(-6.0, 0.6, 3.0) },
    { type: 'ammo', pos: new THREE.Vector3(6.0, 0.6, -2.6) },
    { type: 'ammo', pos: new THREE.Vector3(7.5, F1 + 0.6, 4.0) },
    { type: 'ammo', pos: new THREE.Vector3(-7.5, F1 + 0.6, -3.0) },
    { type: 'ammo', pos: new THREE.Vector3(0, 0.6, -7.8) },
  ];
}

/* ------------------------------------------------------------- definition */

export const lodgeMap = Object.freeze({
  id: 'lodge',
  name: 'LODGE',
  tagline: 'Two floors, one hall',
  description:
    'A house with nothing clever in it: four rooms a floor around a hall you '
    + 'can see clean across, one wide stair up through the middle of it, and a '
    + 'balcony to drop back down.',
  scale: 'SMALL',
  span: '24 m',
  players: '2-8',
  accent: '#d9a05b',
  swatch: ['#efe6d6', '#8c5a34', '#2f7f76'],

  plan: [
    [-7.7, -4.9, 7.9, 7.5], [7.7, -4.9, 7.9, 7.5],
    [-7.7, 3.9, 7.9, 9.5], [7.7, 3.9, 7.9, 9.5],
    [0, 0, 6.9, 17.6],
  ],

  /**
   * NO light column over the CTF bases. This is the only indoor map.
   *
   * The default 15 m beam assumes open sky. Here the bases stand in corner
   * rooms with the upper floor 3.3 m overhead, so the column would pass
   * through the ceiling and stand in an upstairs bedroom, marking a flag that
   * is neither in that room nor reachable from it. The floor ring and plinth
   * do the job instead — in a 24 m house you are never more than a room away.
   */
  ctfBeamHeight: 0,

  thumbCam: { pos: [15, 12, 20], look: [0, 2.4, 1], fov: 55 },
  playerSpawn: [0, 1.1, 7.6],
  playerSpawnYaw: Math.PI,
  bounds: { min: [-14, -2, -11], max: [14, 12, 11] },

  /**
   * Late afternoon, straight through the south glazing.
   *
   * The sun sits at 24 degrees: low enough to rake the hall floor and throw the
   * mullions across it, high enough that nobody in the north rooms is aiming
   * into it. Shadow bias is set for that elevation rather than for midday,
   * because a low sun stretches every shadow over far more texels.
   */
  env: {
    sky: { turbidity: 4.0, rayleigh: 2.0, mie: 0.005, mieG: 0.84,
           elevation: 24, azimuth: 172 },
    envIntensity: 0.7,
    fog: { color: 0xe4c39c, density: 0.006 },
    sun: {
      color: 0xffd39a, intensity: 3.0, shadowHalf: 20, shadowFar: 110,
      bias: -0.0022, normalBias: 0.09,
    },
    hemi: { sky: 0xecd9c0, ground: 0x4a4038, intensity: 0.82 },
    ambient: { color: 0x6a5a4c, intensity: 0.5 },
    bounce: { color: 0x8fb2c4, intensity: 0.55 },
  },

  build(level) {
    buildShell(level);
    buildGround(level);
    buildStair(level);
    buildPlate(level);
    buildUpper(level);
    level._flush();

    buildProps(level);
    buildPickups(level);
  },
});

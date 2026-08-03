/**
 * OUTPOST — a sandstone trading post, late afternoon.
 *
 * Fifty metres across against the warehouse's seventy, so it is meaningfully
 * tighter without being cramped: about half the floor area, and every part of
 * it is walkable. Where the yard is grey steel under a midday sun, this is warm
 * cut stone with a low golden light raking across it and dust in the air.
 *
 * HOW IT PLAYS
 * ------------
 * Four two-storey blocks around a central market square, with roofs you can
 * actually take. The shape is a ring, and the fighting happens on three levels
 * at once:
 *
 *   GROUND   the square, cut up by market stalls and low walls. Fast, close,
 *            and the only place the pickups worth having are.
 *   ROOFS    reached by outside stair runs at the four corners. Long looks
 *            across the square, but completely exposed from the other roofs —
 *            taking height here buys you sightlines, not safety.
 *   ARCADE   a covered colonnade around the inside of the square, at ground
 *            level. Cover from above, which is what stops the roofs dominating.
 *
 * That last one is the piece that makes it work. Without it a map this size
 * with accessible roofs turns into everyone sitting on a roof; the arcade means
 * the ground has somewhere to be that the roofs cannot see into.
 *
 * The striped canopies over the stalls are DECORATION, not cover — they block
 * the view from above without stopping a round, so they slow a roof player's
 * read of the square without giving anyone a safe square to stand in.
 *
 * Layout is written with the toolkit on `Level`; see maps/warehouse.js for the
 * note on what lives where.
 */

import * as THREE from 'three';
import { SURFACE } from '../../core/AssetManager.js';
import { TAG_KIND } from '../../physics/PhysicsWorld.js';
import { randRange } from '../../core/MathUtils.js';

/** Half-extent of the compound. The outer wall stands on this. */
const R = 24;
/**
 * The four blocks sit in the CORNERS, leaving a cross of open ground.
 *
 * Centre and half-size are stated together because they have to agree: the
 * blocks span `BLOCK_C +/- BLOCK_H`, so the square in the middle runs to
 * `BLOCK_C - BLOCK_H` and the open arms out to the walls are everything
 * narrower than that. Getting this wrong is not subtle — the first version had
 * the blocks overlapping the market and half the spawn points, which put
 * players inside a building at ground level.
 */
const BLOCK_C = 16;
const BLOCK_H = 5.5;
/** Where the central square ends and the corner blocks begin. */
const SQUARE = BLOCK_C - BLOCK_H;   // 10.5
/** Walkable roof height on the four blocks. */
const ROOF_Y = 5.0;
/** Height of the arcade roof — head clearance underneath, cover from above. */
const ARCADE_Y = 3.2;

/* --------------------------------------------------------------- geometry */

function buildGround(level) {
  // Compound floor, one metre thick so nothing falls through a seam.
  level._box('sandstone', [0, -0.5, 0], [R * 2 + 8, 1, R * 2 + 8],
    { tile: 6, surface: SURFACE.CONCRETE });

  // A worn dirt apron round the edges, where the paving gives out.
  for (const [px, pz, sx, sz] of [
    [-18, 18, 14, 12], [18, -18, 14, 12], [18, 18, 12, 10], [-18, -18, 12, 10],
  ]) {
    level._box('dirt', [px, 0.012, pz], [sx, 0.02, sz],
      { collide: false, tile: 5, surface: SURFACE.DIRT });
  }

  /*
   * A terracotta mosaic in the middle of the square.
   *
   * Purely visual, and it earns its place: the map is close to symmetrical, so
   * a strong centre mark is what tells you which way you are facing the moment
   * you spawn.
   */
  /*
   * Each ring sits clearly ABOVE the one beneath, never sharing a plane.
   *
   * All three originally had their underside at exactly y = 0, which is the
   * floor's top face — three surfaces on one plane, which shimmers as the
   * depth buffer picks a different winner per pixel per frame. Sub-centimetre
   * steps are invisible underfoot and make the ordering unambiguous.
   */
  level._box('terracotta', [0, 0.035, 0], [11, 0.05, 11], { collide: false, tile: 3 });
  level._box('paintedTeal', [0, 0.085, 0], [7.4, 0.05, 7.4], { collide: false, tile: 2 });
  level._box('terracotta', [0, 0.135, 0], [4, 0.05, 4], { collide: false, tile: 1.5 });
}

/** The compound wall, with a gateway on each side. */
function buildPerimeter(level) {
  const H = 8;
  const T = 1.2;
  // Gateways are wide enough to fight through and narrow enough to hold.
  level._wallWithGaps('adobe', 'x', -R, -R, R, H, T, [[-3.5, 3.5]]);
  level._wallWithGaps('adobe', 'x', R, -R, R, H, T, [[-3.5, 3.5]]);
  level._wallWithGaps('adobe', 'z', -R, -R, R, H, T, [[-3.5, 3.5]]);
  level._wallWithGaps('adobe', 'z', R, -R, R, H, T, [[-3.5, 3.5]]);

  // Terracotta coping along the top, which is what stops the wall reading as
  // a flat brown band across the horizon.
  for (const [x, z, sx, sz] of [
    [0, -R, R * 2 + T, T + 0.5], [0, R, R * 2 + T, T + 0.5],
    [-R, 0, T + 0.5, R * 2 + T], [R, 0, T + 0.5, R * 2 + T],
  ]) {
    level._box('terracotta', [x, H + 0.2, z], [sx, 0.4, sz], { collide: false, tile: 2 });
  }

  /*
   * Buttresses, breaking up the long runs and giving the wall some depth.
   *
   * The two axes use DIFFERENT offsets. The blocks' outside stair runs climb
   * alongside the east and west walls, between 14.5 m and 20.5 m out from the
   * centre, so a buttress at 17 there stood in the middle of a staircase —
   * geometry intersecting geometry, not merely a seam.
   */
  const ALONG_X = [-17, -8.5, 8.5, 17];
  const ALONG_Z = [-11, -5.5, 5.5, 11];
  for (const o of ALONG_X) {
    level._box('adobe', [o, 2.6, -R + T], [1.4, 5.2, 1.0], { tile: 1.5 });
    level._box('adobe', [o, 2.6, R - T], [1.4, 5.2, 1.0], { tile: 1.5 });
  }
  for (const o of ALONG_Z) {
    level._box('adobe', [-R + T, 2.6, o], [1.0, 5.2, 1.4], { tile: 1.5 });
    level._box('adobe', [R - T, 2.6, o], [1.0, 5.2, 1.4], { tile: 1.5 });
  }
}

/**
 * One of the four corner blocks: two storeys, a walkable roof and a stair run.
 *
 * @param {number} sx  -1 or 1, which side of the square along X
 * @param {number} sz  -1 or 1, along Z
 */
function buildBlock(level, sx, sz) {
  const w = BLOCK_H * 2, d = BLOCK_H * 2;
  const cx = sx * BLOCK_C;
  const cz = sz * BLOCK_C;
  const t = 0.7;
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;

  /*
   * Doorways always face the SQUARE.
   *
   * Every route in and out therefore crosses the middle, which is what keeps
   * the fighting there rather than around the outside of the compound.
   */
  const innerX = sx < 0 ? x1 : x0;
  const innerZ = sz < 0 ? z1 : z0;

  level._wallWithGaps('sandstone', 'z', x0, z0, z1, ROOF_Y, t,
    innerX === x0 ? [[cz - 1.8, cz + 1.8]] : []);
  level._wallWithGaps('sandstone', 'z', x1, z0, z1, ROOF_Y, t,
    innerX === x1 ? [[cz - 1.8, cz + 1.8]] : []);
  level._wallWithGaps('sandstone', 'x', z0, x0, x1, ROOF_Y, t,
    innerZ === z0 ? [[cx - 1.8, cx + 1.8]] : []);
  level._wallWithGaps('sandstone', 'x', z1, x0, x1, ROOF_Y, t,
    innerZ === z1 ? [[cx - 1.8, cx + 1.8]] : []);

  // Roof slab.
  level._box('sandstone', [cx, ROOF_Y + 0.2, cz], [w + 0.5, 0.4, d + 0.5], { tile: 3 });

  /*
   * Each roof edge gets EITHER a parapet or a lip, never both.
   *
   * The parapet goes on the two OUTWARD faces — chest-high cover facing the
   * compound wall, nothing at all facing the square. A roof therefore gives a
   * commanding view of the middle and no protection while you use it, which is
   * the trade that stops height being strictly better.
   *
   * The other two edges get a low terracotta lip so the drop is readable from
   * above and the roofline is readable from below.
   *
   * They were originally BOTH applied to all four edges: a 0.5 m lip and a
   * 0.45 m parapet centred on the same line, overlapping in height, with their
   * outer faces 25 mm apart. Two near-coplanar surfaces at that distance
   * z-fight, which is the shimmer that was visible along every roof.
   */
  /*
   * The X pieces stand 0.1 proud of the Z pieces, so the corners INTERSECT.
   *
   * Without the offset the two parapets meet at each corner with their outer
   * faces 25 mm apart — two front-facing surfaces that the depth buffer cannot
   * separate, which shimmers exactly like the lip-and-parapet overlap did.
   * Overlapping solids never fight; only near-parallel faces do.
   */
  const CORNER_PROUD = 0.1;

  /*
   * Trim stands PROUD of the slab, never flush with it.
   *
   * The roof slab overhangs the walls by OVERHANG. Sizing the lip so its outer
   * face landed exactly on that overhang put two different materials on one
   * plane, overlapping through a 15 cm band along the whole building — which
   * is the flickering orange roofline that was reported. Standing the trim a
   * little further out makes the ordering unambiguous and reads as a moulding
   * rather than a seam.
   */
  const OVERHANG = 0.25;
  const PROUD = 0.14;
  const outEdgeZ = cz + sz * (d / 2 + OVERHANG);
  const outEdgeX = cx + sx * (w / 2 + OVERHANG);
  const inEdgeZ = cz - sz * (d / 2 + OVERHANG);
  const inEdgeX = cx - sx * (w / 2 + OVERHANG);

  /*
   * At each corner one run passes THROUGH and the other butts into it.
   *
   * The Z run spans the full slab; the X run stops at the Z run's centre line,
   * so it is buried 0.225 inside rather than ending flush alongside. Two runs
   * that both reach the corner leave their end faces a couple of centimetres
   * apart, which is the same shimmer in a different axis — and it appeared the
   * moment the first one was fixed.
   */
  /*
   * Both runs are LONGER than the slab as well as standing proud of it, so no
   * face of the trim shares a plane with any face of the slab — not the front,
   * and not the ends either. Aligning the ends was the last seam left: the
   * lip's x-extent matched the slab's exactly, so the two flickered along the
   * short edges after the front faces had been fixed.
   *
   * The two runs of the same material overlap each other at the corners, which
   * is fine and invisible: identical surfaces on one plane have nothing to
   * flicker between.
   */
  const py = ROOF_Y + 0.9;   // sunk 0.1 into the slab, so the two intersect
  const pT = 0.45;
  // Parapet and lip overhang by DIFFERENT amounts. Both were 2 * PROUD, which
  // fixed them against the slab and then aligned their ends with each other —
  // a seam simply moves if every piece is offset by the same figure.
  const overP = 0.48;
  const overL = 0.28;
  level._box('sandstone', [cx, py, outEdgeZ + sz * (PROUD - pT / 2)],
    [w + 0.5 + overP, 1.2, pT], { tile: 1.5 });
  level._box('sandstone', [outEdgeX + sx * (PROUD - pT / 2), py, cz],
    [pT, 1.2, d + 0.5 + overP], { tile: 1.5 });

  /*
   * The lip runs the OPEN edges and stops well short of the parapet.
   *
   * Running it the full length put its end cap exactly on the parapet's outer
   * face — the seam had simply moved from the slab to the parapet. It also
   * makes more sense: the lip marks the edges you can walk off, so it has no
   * business continuing behind a wall you cannot.
   */
  const lT = 0.5;
  const STOP = 0.8;                      // clearance from the parapet
  const lLen = w + 0.5 + overL - STOP;
  const lOff = (STOP + overL) / 2;
  level._box('terracotta',
    [cx - sx * lOff, ROOF_Y + 0.5, inEdgeZ + sz * (lT / 2 - PROUD)],
    [lLen, lT, lT], { tile: 1.5 });
  level._box('terracotta',
    [inEdgeX + sx * (lT / 2 - PROUD), ROOF_Y + 0.5, cz - sz * lOff],
    [lT, lT, lLen], { tile: 1.5 });

  // Interior pillar, so the ground floor is a room to fight in and not a box.
  level._box('adobe', [cx, ROOF_Y / 2, cz], [1.6, ROOF_Y, 1.6], { tile: 1.5 });

  // Shuttered windows facing the square, in painted teal.
  const shutter = (x, z, horiz) => {
    level._box('paintedTeal', [x, 2.7, z], horiz ? [2.2, 1.6, 0.16] : [0.16, 1.6, 2.2],
      { collide: false, tile: 1 });
  };
  if (innerZ === z0) { shutter(cx - 4, z0, true); shutter(cx + 4, z0, true); }
  if (innerZ === z1) { shutter(cx - 4, z1, true); shutter(cx + 4, z1, true); }
  if (innerX === x0) { shutter(x0, cz - 4, false); shutter(x0, cz + 4, false); }
  if (innerX === x1) { shutter(x1, cz - 4, false); shutter(x1, cz + 4, false); }

  /*
   * Outside stairs at the far corner, climbing the OUTWARD face.
   *
   * Outward on purpose: taking a roof means leaving the square and being
   * exposed on the way up, rather than popping onto height from cover.
   */
  const stairX = cx + sx * (w / 2 + 1.7);
  const steps = 15;
  const rise = ROOF_Y / steps + 0.028;
  const run = 0.40;
  const fromZ = cz + sz * (d / 2 - 1.0);
  level._stairs('sandstone', [stairX, 0, fromZ], [0, -sz], steps, rise, run, 2.4);

  // Landing bridging the top step onto the roof.
  level._box('sandstone', [cx + sx * (w / 2 + 1.2), ROOF_Y + 0.2, fromZ - sz * steps * run],
    [3.4, 0.4, 2.6], { tile: 2 });
  // Teal handrail down the outside of the run, so the route is obvious.
  level._box('paintedTeal', [stairX + sx * 1.25, 1.5, fromZ - sz * steps * run * 0.5],
    [0.14, 1.0, steps * run], { collide: false, tile: 1 });
}

/**
 * The arcade: a covered colonnade running the inside edge of the square.
 *
 * This is the map's most important piece. Roofs overlook everything, and
 * without a roofed route at ground level the correct play would always be to
 * take height and stay there. The arcade gives the ground a way to move that
 * the roofs simply cannot see into.
 */
function buildArcade(level) {
  // Just inside the square's edge, so the colonnade hugs the blocks without
  // intersecting them.
  const inner = SQUARE - 2.6;
  const depth = 2.4;

  const run = (along, fixed, horiz) => {
    // Roof slab over the walkway.
    if (horiz) {
      level._box('sandstone', [0, ARCADE_Y, fixed], [along * 2, 0.3, depth],
        { tile: 2.5, surface: SURFACE.CONCRETE });
      level._box('terracotta', [0, ARCADE_Y + 0.28, fixed], [along * 2, 0.3, depth + 0.4],
        { collide: false, tile: 2 });
    } else {
      level._box('sandstone', [fixed, ARCADE_Y, 0], [depth, 0.3, along * 2],
        { tile: 2.5, surface: SURFACE.CONCRETE });
      level._box('terracotta', [fixed, ARCADE_Y + 0.28, 0], [depth + 0.4, 0.3, along * 2],
        { collide: false, tile: 2 });
    }

    // Columns and the arches between them.
    for (let i = -2; i <= 2; i++) {
      const o = i * (along / 2.5);
      const px = horiz ? o : fixed;
      const pz = horiz ? fixed : o;
      level._box('sandstone', [px, ARCADE_Y / 2, pz], [0.62, ARCADE_Y, 0.62], { tile: 1.2 });
      // A lintel between neighbours, which is what makes it read as an arcade
      // rather than a row of posts holding up a slab.
      if (i < 2) {
        const midO = o + (along / 5);
        const mx = horiz ? midO : fixed;
        const mz = horiz ? fixed : midO;
        level._box('sandstone', [mx, ARCADE_Y - 0.45, mz],
          horiz ? [along / 2.5 - 0.62, 0.5, 0.5] : [0.5, 0.5, along / 2.5 - 0.62],
          { collide: false, tile: 1 });
      }
    }
  };

  run(SQUARE - 1, -inner - depth / 2, true);
  run(SQUARE - 1, inner + depth / 2, true);
  run(SQUARE - 1, -inner - depth / 2, false);
  run(SQUARE - 1, inner + depth / 2, false);
}

/** Market stalls and low walls that cut the square into lanes. */
function buildMarket(level) {
  /*
   * Stall canopies are DECORATION — no collider.
   *
   * They break a roof player's view of the square without giving anyone below
   * a safe square to stand in. Cover you can be shot through is what keeps a
   * map with height advantages honest.
   */
  const stall = (x, z, rotY) => {
    level._box('canopy', [x, 2.5, z], [4.2, 0.1, 3.0], { collide: false, rotY, tile: 1 });
    // Poles, which DO collide — a thin thing to hide a shoulder behind.
    for (const [dx, dz] of [[-1.9, -1.3], [1.9, -1.3], [-1.9, 1.3], [1.9, 1.3]]) {
      const c = Math.cos(rotY), s = Math.sin(rotY);
      level._box('paintedTeal', [x + dx * c - dz * s, 1.25, z + dx * s + dz * c],
        [0.16, 2.5, 0.16], { tile: 1 });
    }
    // The counter itself: crouch cover.
    level._box('outpostCrate', [x, 0.5, z], [3.4, 1.0, 1.1], { rotY, tile: 1.2 });
  };

  stall(-6.6, 0, Math.PI / 2);
  stall(6.6, 0, Math.PI / 2);
  stall(0, -6.6, 0);
  stall(0, 6.6, 0);

  // Low walls and planters, off-axis so no lane runs straight through.
  const lowWall = (x, z, sx, sz, rotY = 0) =>
    level._box('adobe', [x, 0.6, z], [sx, 1.2, sz], { rotY, tile: 1.4 });

  lowWall(-4.2, -4.2, 4.2, 1.0, 0.6);
  lowWall(4.2, 4.2, 4.2, 1.0, 0.6);
  lowWall(4.2, -4.2, 1.0, 4.2, -0.6);
  lowWall(-4.2, 4.2, 1.0, 4.2, -0.6);

  // Planters at the gateways, so the entrances are not clean sightlines.
  for (const [x, z] of [[-4, -20], [4, 20], [-20, 4], [20, -4]]) {
    level._box('terracotta', [x, 0.55, z], [2.6, 1.1, 2.6], { tile: 1 });
    level._box('paintedTeal', [x, 1.16, z], [2.8, 0.16, 2.8], { collide: false, tile: 1 });
  }
}

/** A well in the middle of the square: the one piece of hard cover at centre. */
function buildWell(level) {
  level._box('sandstone', [0, 0.65, 0], [3.0, 1.3, 3.0], { tile: 1.2 });
  level._box('terracotta', [0, 1.36, 0], [3.4, 0.22, 3.4], { collide: false, tile: 1 });
  // Frame and beam over it — a landmark visible from every roof.
  for (const dx of [-1.3, 1.3]) {
    level._box('paintedTeal', [dx, 2.6, 0], [0.22, 2.6, 0.22], { tile: 1 });
  }
  level._box('paintedTeal', [0, 3.95, 0], [3.2, 0.24, 0.24], { collide: false, tile: 1 });
  level._box('outpostCrate', [0, 3.55, 0], [0.7, 0.55, 0.7], { collide: false, tile: 1 });
}

/** Awnings, crates and clutter along the walls. */
function buildDecoration(level) {
  // Lean-to awnings against the compound wall, breaking up its length.
  for (const [x, z, rotY] of [
    [-22, -4, Math.PI / 2], [22, 4, Math.PI / 2],
    [-4, 22, 0], [4, -22, 0],
  ]) {
    level._box('canopy', [x, 3.0, z], [5.0, 0.1, 2.6], { collide: false, rotY, tile: 1 });
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (const dx of [-2.3, 2.3]) {
      level._box('paintedTeal', [x + dx * c - 1.2 * s, 1.5, z + dx * s + 1.2 * c],
        [0.16, 3.0, 0.16], { tile: 1 });
    }
  }

  // Roof details, so the tops are not four empty slabs.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = sx * BLOCK_C, cz = sz * BLOCK_C;
    level._box('outpostCrate', [cx - sx * 2.4, ROOF_Y + 0.9, cz - sz * 2.4],
      [1.6, 1.0, 1.6], { tile: 1 });
    level._box('terracotta', [cx + sx * 2.2, ROOF_Y + 0.75, cz + sz * 2.2],
      [1.2, 0.7, 1.2], { tile: 1 });
  }
}

function buildProps(level) {
  // `_spawnProp` resolves the material by NAME, so hand it the name.
  const crateGeo = level.assets.ownGeometry(new THREE.BoxGeometry(1, 1, 1));

  // All inside the open cross or the square — never where a block stands.
  const crates = [
    [-3, -20], [-3.8, -20.7], [3, 20], [3.8, 20.7],
    [-20, 3], [-20.7, 3.8], [20, -3], [20.7, -3.8],
    [-7.5, -2], [7.5, 2], [-2, 7.5], [2, -7.5],
    [0, -14], [0, 14], [-14, 0], [14, 0],
  ];
  for (const [x, z] of crates) {
    const s = randRange(0.8, 1.05);
    level._spawnProp({
      geometry: crateGeo,
      material: 'outpostCrate',
      position: new THREE.Vector3(x, s / 2 + 0.02, z),
      shape: 'box',
      half: { x: s / 2, y: s / 2, z: s / 2 },
      mass: 18 * s,
      surface: SURFACE.WOOD,
      rotY: randRange(-0.5, 0.5),
    });
  }

  /*
   * Explosive barrels at the four gateways and beside the well.
   *
   * The gateways are the choke points, so a barrel there is a real tool: it
   * changes whether pushing an entrance is worth it, rather than being scenery
   * that occasionally goes off.
   */
  const barrelGeo = level.assets.ownGeometry(new THREE.CylinderGeometry(0.35, 0.35, 1.1, 14));
  for (const [x, z] of [
    [-2.6, -20], [2.6, 20], [-20, 2.6], [20, -2.6],
    [-3.2, -3.2], [3.2, 3.2],
  ]) {
    level._spawnProp({
      geometry: barrelGeo,
      material: 'explosiveBarrel',
      position: new THREE.Vector3(x, 0.56, z),
      shape: 'cylinder',
      // A cylinder is HEIGHT and RADIUS, not three half-extents. Passing
      // {x,y,z} leaves the radius undefined, and one NaN collider disables
      // Rapier's whole query pipeline — see the guard in PhysicsWorld.
      half: { y: 0.55, r: 0.35 },
      mass: 40,
      surface: SURFACE.METAL,
      kind: TAG_KIND.EXPLOSIVE,
      /*
       * A slightly tighter blast than the yard's 7.5 m.
       *
       * The whole map is 50 m across and these sit in the gateways, so the
       * warehouse radius would reach most of an arm and make pushing an
       * entrance a coin flip rather than a decision.
       */
      explosive: { radius: 6.5, damage: 95, force: 340 },
    });
  }
}

/**
 * Where the pickups sit.
 *
 * Armour is on two opposite ROOFS, so height has to be earned and left. Health
 * is under the arcade, which is the one place the roofs cannot watch — a hurt
 * player has a route to recover that does not mean crossing open ground.
 */
function buildPickups(level) {
  level.pickupSpots = [
    { type: 'armor', pos: new THREE.Vector3(-BLOCK_C, ROOF_Y + 1.0, -BLOCK_C) },
    { type: 'armor', pos: new THREE.Vector3(BLOCK_C, ROOF_Y + 1.0, BLOCK_C) },
    { type: 'health', pos: new THREE.Vector3(-7.6, 0.6, -7.6) },
    { type: 'health', pos: new THREE.Vector3(7.6, 0.6, 7.6) },
    { type: 'health', pos: new THREE.Vector3(0, 0.6, 21) },
    { type: 'ammo', pos: new THREE.Vector3(-7.6, 0.6, 7.6) },
    { type: 'ammo', pos: new THREE.Vector3(7.6, 0.6, -7.6) },
    { type: 'ammo', pos: new THREE.Vector3(0, 0.6, -21) },
    { type: 'ammo', pos: new THREE.Vector3(-21, 0.6, 0) },
    { type: 'ammo', pos: new THREE.Vector3(21, 0.6, 0) },
  ];
}

/* ------------------------------------------------------------ definition */

export const outpostMap = Object.freeze({
  id: 'outpost',
  name: 'OUTPOST',
  tagline: 'Desert trading post',
  description:
    'Warm stone and striped canopies around a market square. Take a roof for '
    + 'the long looks, or the shaded arcade below where the roofs cannot see.',
  scale: 'MEDIUM',
  span: '50 m',
  players: '2-10',
  accent: '#e0a860',
  swatch: ['#c9a878', '#b4633c', '#2e8b86'],

  /** Top-down sketch for the map card — see drawPlan in MenuManager. */
  plan: [
    [-16, -16, 11, 11], [16, -16, 11, 11],
    [-16, 16, 11, 11], [16, 16, 11, 11],
    [0, 0, 3, 3],
    [-6.6, 0, 1.4, 4.2], [6.6, 0, 1.4, 4.2],
    [0, -6.6, 4.2, 1.4], [0, 6.6, 4.2, 1.4],
  ],

  /** Where the map card's photograph is taken from. See warehouse.js. */
  thumbCam: { pos: [26, 19, 32], look: [0, 3, 0], fov: 52 },
  playerSpawn: [0, 1.1, 19],
  playerSpawnYaw: 0,
  bounds: { min: [-25, 0, -25], max: [25, 16, 25] },

  /**
   * Late afternoon. A low sun rakes across the stone, which is what gives the
   * blocks their long shadows and the map its warmth.
   *
   * Elevation is 20 degrees rather than the warehouse's 42 — low enough to
   * model golden hour, still high enough that you are not aiming into it from
   * any normal position. The haze is warm and denser than the yard's, because
   * fifty metres of clear air shows nothing at all.
   */
  env: {
    sky: { turbidity: 5.5, rayleigh: 1.6, mie: 0.004, mieG: 0.80,
           elevation: 20, azimuth: 112 },
    envIntensity: 0.60,
    fog: { color: 0xd8b184, density: 0.0105 },
    sun: {
      color: 0xffd8a0, intensity: 2.9, shadowHalf: 30, shadowFar: 170,
      // A 20-degree sun rakes shadows a long way across each texel, so the
      // warehouse's midday bias leaves acne crawling over every wall. See
      // Level._configureSunShadow.
      bias: -0.0022, normalBias: 0.09,
    },
    hemi: { sky: 0xdcc6a4, ground: 0x6b4a30, intensity: 0.80 },
    ambient: { color: 0x6a5540, intensity: 0.42 },
    // Cool bounce out of the shaded side, so shadows read blue against the
    // warm stone instead of going muddy.
    bounce: { color: 0x8fb4c8, intensity: 0.55 },
  },

  build(level) {
    buildGround(level);
    buildPerimeter(level);
    buildBlock(level, -1, -1);
    buildBlock(level, 1, -1);
    buildBlock(level, -1, 1);
    buildBlock(level, 1, 1);
    buildArcade(level);
    buildMarket(level);
    buildWell(level);
    buildDecoration(level);
    level._flush();

    buildProps(level);
    buildPickups(level);
  },
});

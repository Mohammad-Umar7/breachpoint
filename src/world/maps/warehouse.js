/**
 * WAREHOUSE — the original arena.
 *
 * A fenced industrial yard: a central warehouse with a mezzanine and internal
 * corridors, two flanking outbuildings with climbable roofs for long sightlines,
 * a north catwalk, shipping-container lanes and scattered hard cover. Roughly
 * 70 m across, and built for twelve.
 *
 * WHAT LIVES HERE AND WHAT LIVES IN Level
 * --------------------------------------
 * This file is LAYOUT. `Level` is the toolkit that layouts are written with —
 * `_box`, `_ramp`, `_stairs`, `_wallWithGaps`, the merge pass, prop spawning,
 * lighting and teardown. None of that is specific to this map, and all of it is
 * what a second map needs too.
 *
 * The split matters because it is what makes another map a new FILE rather than
 * a new branch inside an existing one. See `maps/index.js`.
 *
 * Spawn points and arena bounds are NOT here — they live in `src/net/arena.js`,
 * because the server needs them and must not import THREE.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACE } from '../../core/AssetManager.js';
import { TAG_KIND } from '../../physics/PhysicsWorld.js';
import { randRange } from '../../core/MathUtils.js';
import { UP, scaleBoxUVs } from '../Level.js';
import { DEFAULT_MAP_ID } from '../../net/arena.js';

// ----------------------------------------------------------------- ground
function buildGround(level) {
  // The playfield floor. One big box so it also acts as the collider.
  level._box('floorTile', [0, -0.5, 0], [72, 1, 72], { tile: 4, surface: SURFACE.CONCRETE });

  // Dirt patches around the edges for visual variety (no collider needed —
  // they sit flush on top of the floor).
  const patches = [
    [-26, 26, 16, 14], [24, -26, 18, 16], [-28, -8, 12, 20], [10, 30, 26, 10],
  ];
  for (const [px, pz, sx, sz] of patches) {
    level._box('dirt', [px, 0.01, pz], [sx, 0.02, sz], { collide: false, tile: 5, surface: SURFACE.DIRT });
  }
}

function buildPerimeter(level) {
  const H = 9;
  const T = 1.5;
  const R = 36;
  // Four walls; slightly overlapping at the corners.
  level._box('concreteDark', [0, H / 2, -R], [R * 2 + T, H, T], { tile: 3 });
  level._box('concreteDark', [0, H / 2, R], [R * 2 + T, H, T], { tile: 3 });
  level._box('concreteDark', [-R, H / 2, 0], [T, H, R * 2 + T], { tile: 3 });
  level._box('concreteDark', [R, H / 2, 0], [T, H, R * 2 + T], { tile: 3 });

  // Hazard stripe kerb along the base of each wall.
  level._box('hazard', [0, 0.25, -R + 1.1], [R * 2, 0.5, 0.5], { collide: false, tile: 1 });
  level._box('hazard', [0, 0.25, R - 1.1], [R * 2, 0.5, 0.5], { collide: false, tile: 1 });
}

// -------------------------------------------------------------- warehouse
function buildWarehouse(level) {
  const W = { x0: -13, x1: 13, z0: -17, z1: 1, h: 6.5, t: 0.6 };
  const mat = 'metalPanel';

  // --- South wall with a 6m main doorway ---
  level._wallWithGaps(mat, 'x', W.z1, W.x0, W.x1, W.h, W.t, [[-3, 3]]);
  // --- North wall with a service door ---
  level._wallWithGaps(mat, 'x', W.z0, W.x0, W.x1, W.h, W.t, [[4, 9]]);
  // --- West wall with a side entrance ---
  level._wallWithGaps(mat, 'z', W.x0, W.z0, W.z1, W.h, W.t, [[-12, -8]]);
  // --- East wall with a side entrance ---
  level._wallWithGaps(mat, 'z', W.x1, W.z0, W.z1, W.h, W.t, [[-7, -3]]);

  // --- Roof, split so two skylight gaps let sun shafts in ---
  const roofY = W.h + 0.2;
  level._box(mat, [0, roofY, -15.5], [26, 0.4, 3], { tile: 3 });
  level._box(mat, [0, roofY, -10.5], [26, 0.4, 5], { tile: 3 });
  level._box(mat, [0, roofY, -4.5], [26, 0.4, 5], { tile: 3 });
  level._box(mat, [0, roofY, 0], [26, 0.4, 2], { tile: 3 });
  level._box(mat, [-11, roofY, -7.75], [4, 0.4, 1.5], { tile: 3 });
  level._box(mat, [11, roofY, -7.75], [4, 0.4, 1.5], { tile: 3 });
  level._box(mat, [-11, roofY, -13], [4, 0.4, 2], { tile: 3 });
  level._box(mat, [11, roofY, -13], [4, 0.4, 2], { tile: 3 });

  // --- Support pillars ---
  for (const px of [-7, 7]) {
    for (const pz of [-13, -3]) {
      level._box('concrete', [px, W.h / 2, pz], [0.7, W.h, 0.7], { tile: 1.5 });
    }
  }

  // --- Mezzanine platform (north-east quarter) ---
  const mz = { x0: 2.5, x1: 12.7, z0: -16.7, z1: -9, y: 3.2 };
  const mw = mz.x1 - mz.x0;
  const md = mz.z1 - mz.z0;
  level._box('metal', [(mz.x0 + mz.x1) / 2, mz.y, (mz.z0 + mz.z1) / 2], [mw, 0.4, md], { tile: 2, surface: SURFACE.METAL });
  // Under-platform bracing
  for (const px of [4, 8, 12]) {
    level._box('metal', [px, mz.y / 2, mz.z1 - 0.3], [0.35, mz.y, 0.35], { tile: 1, surface: SURFACE.METAL });
  }

  // --- Stairs up to the mezzanine (runs along -Z next to the east wall) ---
  //
  // Same total rise (3.4 m) and footprint (3.6 m) as before, but split into
  // 20 fine steps instead of 10 coarse ones.
  //
  // The old 0.34 m rise meant the character controller had to autostep the
  // player up a third of a metre at a time, which reads as a lurch on every
  // single step — the "sluggish going up" complaint. At 0.17 m per step the
  // climb is smooth. The staircase is still steep at 43 degrees; what
  // changed is the granularity, so it costs no extra floor space.
  level._stairs('metal', [10.9, 0, -5.4], [0, -1], 20, 0.17, 0.18, 1.6);
  // Landing joining the top step to the platform
  level._box('metal', [10.9, 3.2, -9.4], [1.6, 0.3, 1.0], { tile: 1, surface: SURFACE.METAL });

  // --- Mezzanine railings (instanced posts + rails handled in decoration) ---
  level.mezzanine = mz;

  // --- Interior partition making a corridor along the west wall ---
  level._wallWithGaps('concrete', 'z', -7.5, -16.5, -2.5, 3.4, 0.5, [[-11, -9]]);

  // --- Interior light panels (emissive, no shadow cost) ---
  for (const pz of [-14, -8, -2]) {
    level._box('lightPanel', [0, W.h - 0.25, pz], [5, 0.14, 0.9], { collide: false, tile: 1 });
  }
}

/**
 * A 10x10 blockhouse with a walkable roof. Access is a flight of stairs on
 * the OUTWARD side (away from the arena centre) leading onto an apron slab
 * that bridges onto the roof, with a matching gap left in the parapet.
 *
 * @param {'west'|'east'} side which flank this building is on
 */
function buildOutbuilding(level, cx, cz, side) {
  const w = 10, d = 10, h = 4.2, t = 0.5;
  const mat = 'concrete';
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const roofY = h + 0.2;            // slab centre; walkable surface = h + 0.4
  const outward = side === 'west' ? -1 : 1;

  // --- Walls; the ground-floor doorway faces the arena centre ---
  level._wallWithGaps(mat, 'x', z0, x0, x1, h, t, [[cx - 1.5, cx + 1.5]]);
  level._wallWithGaps(mat, 'x', z1, x0, x1, h, t, []);
  level._wallWithGaps(mat, 'z', x0, z0, z1, h, t, side === 'west' ? [] : [[cz - 1.5, cz + 1.5]]);
  level._wallWithGaps(mat, 'z', x1, z0, z1, h, t, side === 'west' ? [[cz - 1.5, cz + 1.5]] : []);

  // --- Roof slab ---
  level._box('concrete', [cx, roofY, cz], [w + 0.4, 0.4, d + 0.4], { tile: 2.5 });

  // --- Stair access on the outward face, climbing toward -Z ---
  const stairX = cx + outward * (w / 2 + 1.6);
  const stairTopZ = cz + d / 2 - 1.0;      // z where the top step lands
  const steps = 13;
  const rise = 0.36;
  const run = 0.44;
  level._stairs('concrete', [stairX, 0, stairTopZ + steps * run], [0, -1], steps, rise, run, 2.4);

  // Apron slab bridging the top step onto the roof.
  const apronX = cx + outward * (w / 2 + 1.2);
  level._box('concrete', [apronX, roofY, stairTopZ - 0.8], [3.6, 0.4, 2.4], { tile: 2 });

  // --- Parapet, with a gap where the apron meets the roof ---
  const py = h + 0.4 + 0.35;
  level._box('concrete', [cx, py, z0 - 0.1], [w + 0.4, 0.7, 0.3], { tile: 1.5 });
  level._box('concrete', [cx, py, z1 + 0.1], [w + 0.4, 0.7, 0.3], { tile: 1.5 });
  // Inward-facing parapet: continuous.
  level._box('concrete', [cx - outward * (w / 2 + 0.1), py, cz], [0.3, 0.7, d + 0.4], { tile: 1.5 });
  // Outward-facing parapet: split around the access gap.
  const gapMin = stairTopZ - 2.0;
  const gapMax = stairTopZ + 0.4;
  const segA = [z0 - 0.2, gapMin];
  const segB = [gapMax, z1 + 0.2];
  for (const [s, e] of [segA, segB]) {
    const len = e - s;
    if (len <= 0.1) continue;
    level._box('concrete', [cx + outward * (w / 2 + 0.1), py, (s + e) / 2], [0.3, 0.7, len], { tile: 1.5 });
  }

  level[`${side}Roof`] = { x: cx, y: h + 0.4, z: cz };
}

// ---------------------------------------------------------------- catwalk
function buildCatwalk(level) {
  const y = 3.6;
  // Deck running east–west across the north end.
  level._box('metal', [-8, y, -27], [40, 0.35, 3.4], { tile: 2, surface: SURFACE.METAL });
  // Support columns
  for (let x = -26; x <= 10; x += 9) {
    level._box('metal', [x, y / 2, -27], [0.4, y, 0.4], { tile: 1, surface: SURFACE.METAL });
  }
  // Ramp climbing from the arena floor (east, +X) up to the deck's east end
  // at x = 12. `rotY = -PI/2` puts the ramp's high end on the -X side.
  level._ramp('metal', [16.75, y / 2, -27], 2.6, 9.5, y - 0.1, {
    rotY: -Math.PI / 2, surface: SURFACE.METAL, thickness: 0.4,
  });

  level.catwalk = { y, z: -27, x0: -28, x1: 12 };
}

// ------------------------------------------------------------- containers
function buildContainers(level) {
  // Shipping containers form corridors and elevated firing positions.
  const defs = [
    // [x, y, z, rotY]
    [-22, 1.3, -6, 0],
    [-22, 3.9, -6, 0],
    [-22, 1.3, 1.5, 0],
    [22, 1.3, -8, 0],
    [22, 3.9, -8, Math.PI],
    [22, 1.3, -0.5, 0],
    [-6, 1.3, 22, Math.PI / 2],
    [6, 1.3, 16, Math.PI / 2],
    [-15, 1.3, 30, 0],
    [15, 1.3, 30, Math.PI],
    [0, 1.3, -31, Math.PI / 2],
  ];
  for (const [x, y, z, rotY] of defs) {
    level._box('metalPanel', [x, y, z], [6.1, 2.6, 2.5], { rotY, tile: 2.2, surface: SURFACE.METAL });
  }

  // A ramp onto the west container stack.
  level._ramp('metal', [-22, 0.65, -0.6], 2.2, 3.6, 1.3, { surface: SURFACE.METAL });
}

// ------------------------------------------------------------ hard cover
function buildCoverBlocks(level) {
  const blocks = [
    [-4, 8], [5, 9], [-10, 14], [11, 13], [0, 18], [-18, 6], [18, 5],
    [-8, -21], [9, -22], [-16, -24], [16, -25], [-3, -24], [26, -14], [-26, -14],
    [17, 20], [-17, 20], [3, -6], [-4, -12],
  ];
  for (const [x, z] of blocks) {
    const rotY = ((x * 31 + z * 17) % 7) * 0.22;
    level._box('concrete', [x, 0.55, z], [2.4, 1.1, 0.8], { rotY, tile: 1.4 });
    level._box('hazard', [x, 1.14, z], [2.4, 0.08, 0.8], { rotY, collide: false, tile: 1 });
  }
}

// ------------------------------------------------------------- decoration
function buildDecoration(level) {
  // --- Pipes running along the perimeter walls (InstancedMesh) ---
  const pipeGeo = new THREE.CylinderGeometry(0.16, 0.16, 8, 8, 1, true);
  pipeGeo.rotateZ(Math.PI / 2);
  const pipeMat = level.assets.getMaterial('rustMetal');
  const pipeCount = 32;
  const pipes = new THREE.InstancedMesh(pipeGeo, pipeMat, pipeCount);
  pipes.castShadow = true;
  pipes.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  let i = 0;
  for (const [axis, fixed, sign] of [['x', -34.5, 1], ['x', 34.5, 1], ['z', -34.5, 1], ['z', 34.5, 1]]) {
    for (let k = -3; k <= 3 && i < pipeCount; k++) {
      const along = k * 9;
      if (axis === 'x') {
        p.set(along, 6.4 + (k % 2) * 0.5, fixed);
        q.identity();
      } else {
        p.set(fixed, 6.4 + (k % 2) * 0.5, along);
        q.setFromAxisAngle(UP, Math.PI / 2);
      }
      m.compose(p, q, s);
      pipes.setMatrixAt(i++, m);
    }
  }
  pipes.count = i;
  pipes.instanceMatrix.needsUpdate = true;
  level.scene.add(pipes);
  level.objects.push(pipes);
  level.instancedMeshes = [pipes];

  // --- Railings on the mezzanine and catwalk (InstancedMesh of posts) ---
  const postGeo = new THREE.BoxGeometry(0.08, 1.0, 0.08);
  const railMat = level.assets.getMaterial('metal');
  const railSpecs = [];
  // Mezzanine south edge
  for (let x = 3; x <= 12.5; x += 1.2) railSpecs.push([x, 3.9, level.mezzanine.z1, 0]);
  // Catwalk both edges
  for (let x = -27; x <= 11; x += 1.4) {
    railSpecs.push([x, 4.3, -25.4, 0]);
    railSpecs.push([x, 4.3, -28.6, 0]);
  }
  const posts = new THREE.InstancedMesh(postGeo, railMat, railSpecs.length);
  posts.castShadow = true;
  for (let k = 0; k < railSpecs.length; k++) {
    const [x, y, z] = railSpecs[k];
    p.set(x, y, z);
    q.identity();
    m.compose(p, q, s);
    posts.setMatrixAt(k, m);
  }
  posts.instanceMatrix.needsUpdate = true;
  level.scene.add(posts);
  level.objects.push(posts);
  level.instancedMeshes.push(posts);

  // Continuous top rails (merged static geometry, no collision needed).
  level._box('metal', [7.75, 4.4, level.mezzanine.z1], [9.5, 0.08, 0.08], { collide: false, tile: 1 });
  level._box('metal', [-8, 4.8, -25.4], [38, 0.08, 0.08], { collide: false, tile: 1 });
  level._box('metal', [-8, 4.8, -28.6], [38, 0.08, 0.08], { collide: false, tile: 1 });

  // Low guard rail as an actual collider so players can't walk off.
  level._box('metal', [7.75, 4.0, level.mezzanine.z1], [9.5, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
  level._box('metal', [-8, 4.4, -25.4], [38, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
  level._box('metal', [-8, 4.4, -28.6], [38, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
}

/**
 * Glazed windows.
 *
 * Frames are queued into the normal merged opaque batches (they are static
 * metal); every glass pane is merged into a *single* transparent mesh. Left
 * as individual meshes these 48 objects cost ~9 ms a frame across the world,
 * shadow and scope passes — merged, they cost two draw calls.
 *
 * Each pane still gets its own thin collider tagged GLASS, so bullets
 * produce shattering particles and the distinctive impact sound.
 *
 * Must run before `_flush()` so the frames join the merge.
 */
function buildWindows(level) {
  const panes = [
    // Warehouse clerestory windows, above the doors on the south face.
    { pos: [-8.5, 4.6, 1], size: [4.4, 1.6, 0.06] },
    { pos: [8.5, 4.6, 1], size: [4.4, 1.6, 0.06] },
    // West and east warehouse walls.
    { pos: [-13, 4.4, -13.5], size: [0.06, 1.5, 4.0] },
    { pos: [13, 4.4, -13.5], size: [0.06, 1.5, 4.0] },
    // Outbuilding windows facing the yard.
    { pos: [-25, 2.6, 6], size: [3.2, 1.3, 0.06] },
    { pos: [25, 2.6, 6], size: [3.2, 1.3, 0.06] },
    { pos: [-30, 2.6, 11], size: [0.06, 1.3, 3.2] },
    { pos: [30, 2.6, 11], size: [0.06, 1.3, 3.2] },
  ];

  const glassGeos = [];

  for (const { pos, size } of panes) {
    const [x, y, z] = pos;
    const [sx, sy, sz] = size;

    const geo = new THREE.BoxGeometry(sx, sy, sz);
    geo.translate(x, y, z);
    glassGeos.push(geo);

    level._staticCollider(
      { x, y, z },
      { x: sx / 2, y: sy / 2, z: sz / 2 },
      null,
      { kind: TAG_KIND.WORLD, surface: SURFACE.GLASS },
      0.4
    );

    // Frame: bars around the pane plus a centre mullion, queued into the
    // shared merged batch rather than drawn individually.
    const t = 0.09;
    const horizontal = sx > sz;
    const frames = horizontal
      ? [
          [x, y + sy / 2 + t / 2, z, sx + t * 2, t, sz + 0.02],
          [x, y - sy / 2 - t / 2, z, sx + t * 2, t, sz + 0.02],
          [x - sx / 2 - t / 2, y, z, t, sy, sz + 0.02],
          [x + sx / 2 + t / 2, y, z, t, sy, sz + 0.02],
          [x, y, z, t * 0.7, sy, sz + 0.02],
        ]
      : [
          [x, y + sy / 2 + t / 2, z, sx + 0.02, t, sz + t * 2],
          [x, y - sy / 2 - t / 2, z, sx + 0.02, t, sz + t * 2],
          [x, y, z - sz / 2 - t / 2, sx + 0.02, sy, t],
          [x, y, z + sz / 2 + t / 2, sx + 0.02, sy, t],
          [x, y, z, sx + 0.02, sy, t * 0.7],
        ];

    for (const [fx, fy, fz, fw, fh, fd] of frames) {
      level._box('frame', [fx, fy, fz], [fw, fh, fd], { collide: false, tile: 1 });
    }
  }

  // One merged, transparent mesh for every pane in the level.
  if (glassGeos.length) {
    const merged = mergeGeometries(glassGeos, false);
    for (const gg of glassGeos) gg.dispose();
    if (merged) {
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, level.assets.getMaterial('glass'));
      mesh.castShadow = false;    // transparent glass casting shadows looks wrong
      mesh.receiveShadow = false;
      mesh.renderOrder = 4;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'level_glass';
      level.scene.add(mesh);
      level.objects.push(mesh);
    }
  }
}

// ------------------------------------------------------------------ props
function buildProps(level) {
  // --- Wooden crates: light, very pushable ---
  const cratePositions = [
    [-6.5, 6.5], [-5.2, 7.6], [-6.0, 8.9], [7.5, 7.0], [8.6, 8.1],
    [-9.5, -3.0], [-10.6, -4.1], [2.0, -14.5], [3.1, -15.6], [4.0, -13.4],
    [19.5, 3.0], [-19.5, 3.0], [12.5, 24.0], [-12.5, 24.0], [0.5, -20.0],
    [24.0, -20.0], [-24.0, -20.0], [6.0, 4.0],
  ];
  const crateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  scaleBoxUVs(crateGeo, 0.9, 0.9, 0.9, 0.9);
  level.assets.ownGeometry(crateGeo);
  for (const [x, z] of cratePositions) {
    const stack = Math.random() < 0.35 ? 2 : 1;
    for (let k = 0; k < stack; k++) {
      level._spawnProp({
        geometry: crateGeo,
        material: 'crate',
        position: new THREE.Vector3(x + randRange(-0.06, 0.06), 0.46 + k * 0.92, z + randRange(-0.06, 0.06)),
        shape: 'box',
        half: { x: 0.45, y: 0.45, z: 0.45 },
        mass: 18,
        surface: SURFACE.WOOD,
        rotY: randRange(-0.4, 0.4),
      });
    }
  }

  // --- Steel barrels ---
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.1, 16, 1);
  level.assets.ownGeometry(barrelGeo);
  const barrelPositions = [
    [-2.5, 10.5], [-1.4, 11.4], [10.0, 11.0], [-13.0, 9.0], [13.5, -1.5],
    [-11.5, -14.0], [21.0, 12.0], [-21.0, 12.0], [4.5, -25.0], [-6.0, -28.0],
    [28.0, 2.0], [-28.0, 2.0],
  ];
  for (const [x, z] of barrelPositions) {
    level._spawnProp({
      geometry: barrelGeo,
      material: 'barrelBlue',
      position: new THREE.Vector3(x, 0.56, z),
      shape: 'cylinder',
      half: { y: 0.55, r: 0.35 },
      mass: 34,
      surface: SURFACE.METAL,
    });
  }

  // --- Explosive barrels: destructible, chain-reacting ---
  // Several are placed in touching pairs so a single well-aimed round sets
  // off a chain reaction.
  const explosivePositions = [
    [-7.5, 12.5], [-8.4, 13.1],
    [8.5, 13.5],
    [-16.0, -6.0], [-16.8, -6.7],
    [16.0, -12.0],
    [0.0, -9.5],
    [-24.0, 8.0], [24.0, 8.0],
    [2.5, 28.0], [3.4, 28.6],
    [-20.0, -28.0],
  ];
  for (const [x, z] of explosivePositions) {
    level._spawnProp({
      geometry: barrelGeo,
      material: 'explosiveBarrel',
      position: new THREE.Vector3(x, 0.56, z),
      shape: 'cylinder',
      half: { y: 0.55, r: 0.35 },
      mass: 40,
      surface: SURFACE.METAL,
      kind: TAG_KIND.EXPLOSIVE,
      // Configured in one place rather than set field by field afterwards.
      // Doing it by hand is how the outpost's barrels ended up with no blast
      // radius at all — see the note on _spawnProp.
      explosive: { health: 45, radius: 7.5, damage: 95, force: 340 },
    });
  }
}

// ------------------------------------------------------------- navigation
function buildNavData(level) {
  // --- Pickup spots ---
  level.pickupSpots = [
    { type: 'health', pos: new THREE.Vector3(-11.5, 0.6, 5.5) },
    { type: 'health', pos: new THREE.Vector3(11.5, 0.6, 5.5) },
    { type: 'health', pos: new THREE.Vector3(7.5, 3.9, -13.5) },  // mezzanine
    // Was at z = -29, which is inside a shipping container and therefore
    // unreachable — nobody has ever been able to pick this one up.
    { type: 'health', pos: new THREE.Vector3(5.5, 0.6, -29) },
    { type: 'armor', pos: new THREE.Vector3(-25, 5.2, 11) },      // west roof
    { type: 'armor', pos: new THREE.Vector3(25, 5.2, 11) },       // east roof
    { type: 'ammo', pos: new THREE.Vector3(-4.5, 0.6, 20) },
    { type: 'ammo', pos: new THREE.Vector3(4.5, 0.6, 20) },
    { type: 'ammo', pos: new THREE.Vector3(-9, 0.6, -11) },
    { type: 'ammo', pos: new THREE.Vector3(9, 0.6, -6) },
    { type: 'ammo', pos: new THREE.Vector3(-20, 4.3, -27) },      // catwalk
    { type: 'ammo', pos: new THREE.Vector3(20, 0.6, -20) },
    { type: 'ammo', pos: new THREE.Vector3(-28, 0.6, 24) },
    { type: 'ammo', pos: new THREE.Vector3(28, 0.6, 24) },
  ];
}

/* ------------------------------------------------------------ definition */

export const warehouseMap = Object.freeze({
  id: DEFAULT_MAP_ID,
  name: 'WAREHOUSE',
  tagline: 'Industrial yard',
  description:
    'Concrete, steel and sightlines. A central warehouse with a mezzanine, '
    + 'two roofs worth climbing and container lanes to flank through.',
  /** Menu copy. Kept next to the layout so they cannot disagree. */
  scale: 'LARGE',
  span: '70 m',
  players: '2-12',
  /** Card colours in the map picker — sampled from the map's own palette. */
  accent: '#7fb2d8',
  swatch: ['#6e7176', '#8a7a5e', '#4a5057'],

  /**
   * Top-down sketch for the map card: [x, z, width, depth] in world metres.
   * A dozen boxes, not the real geometry — see drawPlan in MenuManager.
   */
  plan: [
    [0, -8, 26, 18],        // the warehouse
    [-25, 11, 10, 10],      // west outbuilding
    [25, 11, 10, 10],       // east outbuilding
    [0, -26, 30, 2.4],      // north catwalk
    [-18, -2, 6, 2.5], [18, -2, 6, 2.5],   // container lanes
    [-8, 20, 4, 4], [8, 20, 4, 4],         // yard cover
  ],
  /**
   * Where the map card's photograph is taken from.
   *
   * A real render beats any drawing of a plan: it shows the materials, the
   * light and the scale all at once, which is most of what a player is
   * choosing between. Regenerate with `npm run thumbs` after changing a
   * layout — see scripts/thumbs.mjs.
   */
  thumbCam: { pos: [34, 24, 46], look: [0, 3, -4], fov: 52 },
  playerSpawn: [0, 1.1, 26],
  playerSpawnYaw: 0,          // looking down -Z, toward the warehouse
  bounds: { min: [-35, 0, -35], max: [35, 20, 35] },

  /**
   * Sky, sun and fog. Midday, high contrast, long readable shadows.
   *
   * `elevation` is kept well above the eyeline deliberately: lower and you
   * spend half the match aiming into the sun.
   */
  env: {
    sky: { turbidity: 2.2, rayleigh: 0.62, mie: 0.0015, mieG: 0.66,
           elevation: 42, azimuth: 128 },
    envIntensity: 0.55,
    fog: { color: 0x8fa2b0, density: 0.0060 },
    sun: { color: 0xfff0d8, intensity: 2.6, shadowHalf: 42, shadowFar: 220 },
    hemi: { sky: 0xbcd8ee, ground: 0x4a4038, intensity: 0.85 },
    ambient: { color: 0x40505c, intensity: 0.35 },
    bounce: { color: 0x7fa8c8, intensity: 0.45 },
  },

  build(level) {
    buildGround(level);
    buildPerimeter(level);
    buildWarehouse(level);
    buildOutbuilding(level, -25, 11, 'west');
    buildOutbuilding(level, 25, 11, 'east');
    buildCatwalk(level);
    buildContainers(level);
    buildCoverBlocks(level);
    buildDecoration(level);
    // Window frames are queued into the merge, so this must precede the flush.
    buildWindows(level);
    level._flush();

    buildProps(level);
    buildNavData(level);
  },
});

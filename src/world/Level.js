/**
 * Level — the combat arena.
 *
 * Everything is built from data at boot:
 *   - Static geometry is declared as axis-aligned (optionally Y-rotated) boxes.
 *     Boxes sharing a material are merged into ONE `BufferGeometry` with
 *     `mergeGeometries`, so the ~300 boxes that make up the arena collapse
 *     into one draw call per material (about eight in total).
 *     Each box also gets a matching Rapier fixed cuboid collider.
 *   - Repeated decorative elements (pipes, railings) use `InstancedMesh`.
 *   - Dynamic props (crates, barrels) are individual meshes driven by physics.
 *
 * Layout: a fenced industrial yard with a central warehouse (interior fighting,
 * mezzanine, corridors), two flanking outbuildings with accessible roofs
 * (long-range positions), a north catwalk, shipping-container corridors and
 * scattered hard cover.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { SURFACE } from '../core/AssetManager.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { randRange } from '../core/MathUtils.js';

const SHADOW_SIZES = { off: 0, low: 1024, medium: 2048, high: 4096 };

export class Level {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   * @param {import('../core/AssetManager.js').AssetManager} assets
   * @param {import('../core/Settings.js').Settings} settings
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, physics, assets, settings, renderer) {
    this.scene = scene;
    this.physics = physics;
    this.assets = assets;
    this.settings = settings;
    this.renderer = renderer;

    /** Pending geometry, grouped by material name, merged in `_flush()`. */
    this._pending = new Map();
    /** @type {THREE.Object3D[]} everything we added to the scene */
    this.objects = [];
    /** @type {Array} dynamic props: crates, barrels, explosive barrels */
    this.props = [];
    /** @type {Array} explosive barrels only */
    this.explosives = [];

    this.playerSpawn = new THREE.Vector3(0, 1.1, 26);
    this.playerSpawnYaw = 0; // looking down -Z, toward the warehouse
    /** @type {THREE.Vector3[]} */
    /** @type {{pos:THREE.Vector3, links:number[]}[]} */
    /** @type {THREE.Vector3[]} */
    /** @type {Array} pickup definitions consumed by PickupManager */
    this.pickupSpots = [];
    /** Top-down footprints of everything solid, for the minimap. See _box. */
    this.mapShapes = [];

    this.bounds = { min: new THREE.Vector3(-35, 0, -35), max: new THREE.Vector3(35, 20, 35) };
  }

  // ==================================================================== build
  build() {
    this._buildSkyAndLights();
    this._buildGround();
    this._buildPerimeter();
    this._buildWarehouse();
    this._buildOutbuilding(-25, 11, 'west');
    this._buildOutbuilding(25, 11, 'east');
    this._buildCatwalk();
    this._buildContainers();
    this._buildCoverBlocks();
    this._buildDecoration();
    this._buildWindows();   // queues frames into the merge, must precede _flush
    this._flush();

    this._buildProps();
    this._buildNavData();
    return this;
  }

  // ------------------------------------------------------------ sky & light
  _buildSkyAndLights() {
    // --- Procedural sky (Preetham model shipped with three.js examples) ---
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    // Clear, low-haze air. `turbidity` and `mieCoefficient` are what create
    // the enormous white halo around the sun — at the old values (6.5 / 0.006)
    // the glare blew out the middle of the screen whenever you faced the sun.
    u.turbidity.value = 2.2;
    u.rayleigh.value = 0.62;
    u.mieCoefficient.value = 0.0015;
    u.mieDirectionalG.value = 0.66;

    // Sun high enough to sit above the normal eyeline, so you are not staring
    // into it while aiming. Still angled enough for long, readable shadows.
    const elevation = 42;
    const azimuth = 128;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDirection = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);
    this.scene.add(sky);
    this.objects.push(sky);
    this.sky = sky;

    // --- Image-based lighting generated from the sky ---
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      const envScene = new THREE.Scene();
      const skyClone = new Sky();
      skyClone.scale.setScalar(20000);
      const cu = skyClone.material.uniforms;
      cu.turbidity.value = u.turbidity.value;
      cu.rayleigh.value = u.rayleigh.value;
      cu.mieCoefficient.value = u.mieCoefficient.value;
      cu.mieDirectionalG.value = u.mieDirectionalG.value;
      cu.sunPosition.value.copy(this.sunDirection);
      envScene.add(skyClone);
      this.envRT = pmrem.fromScene(envScene, 0.04);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.55;
      skyClone.geometry.dispose();
      skyClone.material.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn('[Level] Environment map generation failed; using lights only.', err);
    }

    // --- Fog: atmospheric depth, tuned to the arena size ---
    this.scene.fog = new THREE.FogExp2(0x8fa2b0, 0.0060);

    // --- Sun ---
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    sun.position.copy(this.sunDirection).multiplyScalar(90);
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun.target);
    this._configureSunShadow(sun);
    this.scene.add(sun);
    this.objects.push(sun, sun.target);
    this.sun = sun;

    this.settings.onChange('shadowQuality', () => this._configureSunShadow(this.sun));

    // --- Fill lighting ---
    const hemi = new THREE.HemisphereLight(0xbcd8ee, 0x4a4038, 0.85);
    this.scene.add(hemi);
    this.objects.push(hemi);

    const ambient = new THREE.AmbientLight(0x40505c, 0.35);
    this.scene.add(ambient);
    this.objects.push(ambient);

    // A cool bounce from the opposite side keeps shadowed faces readable.
    const bounce = new THREE.DirectionalLight(0x7fa8c8, 0.45);
    bounce.position.set(-this.sunDirection.x * 60, 30, -this.sunDirection.z * 60);
    bounce.castShadow = false;
    this.scene.add(bounce);
    this.objects.push(bounce);
  }

  _configureSunShadow(sun) {
    const size = SHADOW_SIZES[this.settings.get('shadowQuality')] ?? 2048;
    if (size === 0) {
      sun.castShadow = false;
      return;
    }
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    const half = 42;
    const cam = sun.shadow.camera;
    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = 220;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 1.5;
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }

  // ----------------------------------------------------------------- pieces
  /**
   * Queue a static box: a merged mesh chunk + a physics collider.
   * @param {string} material material name in AssetManager
   * @param {number[]} pos    [x, y, z] centre
   * @param {number[]} size   [sx, sy, sz] full extents
   * @param {object} [opts]
   */
  _box(material, pos, size, opts = {}) {
    const {
      rotY = 0,
      collide = true,
      surface = null,
      tile = 2.0,
      friction = 0.95,
    } = opts;

    const [x, y, z] = pos;
    const [sx, sy, sz] = size;

    const geo = new THREE.BoxGeometry(sx, sy, sz);
    scaleBoxUVs(geo, sx, sy, sz, tile);
    if (rotY) geo.rotateY(rotY);
    geo.translate(x, y, z);

    if (!this._pending.has(material)) this._pending.set(material, []);
    this._pending.get(material).push(geo);

    /*
     * Footprint for the minimap.
     *
     * Collected HERE because _box is the single funnel every wall, container
     * and crate goes through — anywhere else and the map would drift out of
     * agreement with the level the moment somebody added a building.
     *
     * Only things that block you and stand high enough to matter: floor slabs
     * and the painted hazard strips on top of cover are solid or thin, and
     * drawing them would fill the map with rectangles that mean nothing.
     */
    if (collide && sy >= 0.7) {
      this.mapShapes.push({ x, z, hx: sx / 2, hz: sz / 2, rotY, height: sy });
    }

    if (collide) {
      const quat = rotY ? new THREE.Quaternion().setFromAxisAngle(UP, rotY) : null;
      this.physics.createStaticBox(
        { x, y, z },
        { x: sx / 2, y: sy / 2, z: sz / 2 },
        quat,
        { kind: TAG_KIND.WORLD, surface: surface ?? surfaceForMaterial(material) },
        friction
      );
    }
    return this;
  }

  /** A sloped box (ramp). `rise` over `run`, centred on `pos`. */
  _ramp(material, pos, width, run, rise, opts = {}) {
    const { rotY = 0, thickness = 0.5, surface = null } = opts;
    const angle = Math.atan2(rise, run);
    const length = Math.hypot(run, rise);

    const geo = new THREE.BoxGeometry(width, thickness, length);
    scaleBoxUVs(geo, width, thickness, length, 2.0);
    const q = new THREE.Quaternion()
      .setFromAxisAngle(UP, rotY)
      .multiply(new THREE.Quaternion().setFromAxisAngle(RIGHT, -angle));
    geo.applyQuaternion(q);
    geo.translate(pos[0], pos[1], pos[2]);

    const mat = material;
    if (!this._pending.has(mat)) this._pending.set(mat, []);
    this._pending.get(mat).push(geo);

    this.physics.createStaticBox(
      { x: pos[0], y: pos[1], z: pos[2] },
      { x: width / 2, y: thickness / 2, z: length / 2 },
      q,
      { kind: TAG_KIND.WORLD, surface: surface ?? surfaceForMaterial(material) },
      0.98
    );
    return this;
  }

  /** A flight of stairs made of individual steps (climbable via autostep). */
  _stairs(material, startPos, dir, steps, stepRise, stepRun, width) {
    const [dx, dz] = dir;
    for (let i = 0; i < steps; i++) {
      const h = stepRise * (i + 1);
      const cx = startPos[0] + dx * stepRun * (i + 0.5);
      const cz = startPos[2] + dz * stepRun * (i + 0.5);
      const sx = dx !== 0 ? stepRun : width;
      const sz = dz !== 0 ? stepRun : width;
      this._box(material, [cx, startPos[1] + h / 2, cz], [sx, h, sz], { tile: 1.2 });
    }
  }

  // ----------------------------------------------------------------- ground
  _buildGround() {
    // The playfield floor. One big box so it also acts as the collider.
    this._box('floorTile', [0, -0.5, 0], [72, 1, 72], { tile: 4, surface: SURFACE.CONCRETE });

    // Dirt patches around the edges for visual variety (no collider needed —
    // they sit flush on top of the floor).
    const patches = [
      [-26, 26, 16, 14], [24, -26, 18, 16], [-28, -8, 12, 20], [10, 30, 26, 10],
    ];
    for (const [px, pz, sx, sz] of patches) {
      this._box('dirt', [px, 0.01, pz], [sx, 0.02, sz], { collide: false, tile: 5, surface: SURFACE.DIRT });
    }
  }

  _buildPerimeter() {
    const H = 9;
    const T = 1.5;
    const R = 36;
    // Four walls; slightly overlapping at the corners.
    this._box('concreteDark', [0, H / 2, -R], [R * 2 + T, H, T], { tile: 3 });
    this._box('concreteDark', [0, H / 2, R], [R * 2 + T, H, T], { tile: 3 });
    this._box('concreteDark', [-R, H / 2, 0], [T, H, R * 2 + T], { tile: 3 });
    this._box('concreteDark', [R, H / 2, 0], [T, H, R * 2 + T], { tile: 3 });

    // Hazard stripe kerb along the base of each wall.
    this._box('hazard', [0, 0.25, -R + 1.1], [R * 2, 0.5, 0.5], { collide: false, tile: 1 });
    this._box('hazard', [0, 0.25, R - 1.1], [R * 2, 0.5, 0.5], { collide: false, tile: 1 });
  }

  // -------------------------------------------------------------- warehouse
  _buildWarehouse() {
    const W = { x0: -13, x1: 13, z0: -17, z1: 1, h: 6.5, t: 0.6 };
    const mat = 'metalPanel';

    // --- South wall with a 6m main doorway ---
    this._wallWithGaps(mat, 'x', W.z1, W.x0, W.x1, W.h, W.t, [[-3, 3]]);
    // --- North wall with a service door ---
    this._wallWithGaps(mat, 'x', W.z0, W.x0, W.x1, W.h, W.t, [[4, 9]]);
    // --- West wall with a side entrance ---
    this._wallWithGaps(mat, 'z', W.x0, W.z0, W.z1, W.h, W.t, [[-12, -8]]);
    // --- East wall with a side entrance ---
    this._wallWithGaps(mat, 'z', W.x1, W.z0, W.z1, W.h, W.t, [[-7, -3]]);

    // --- Roof, split so two skylight gaps let sun shafts in ---
    const roofY = W.h + 0.2;
    this._box(mat, [0, roofY, -15.5], [26, 0.4, 3], { tile: 3 });
    this._box(mat, [0, roofY, -10.5], [26, 0.4, 5], { tile: 3 });
    this._box(mat, [0, roofY, -4.5], [26, 0.4, 5], { tile: 3 });
    this._box(mat, [0, roofY, 0], [26, 0.4, 2], { tile: 3 });
    this._box(mat, [-11, roofY, -7.75], [4, 0.4, 1.5], { tile: 3 });
    this._box(mat, [11, roofY, -7.75], [4, 0.4, 1.5], { tile: 3 });
    this._box(mat, [-11, roofY, -13], [4, 0.4, 2], { tile: 3 });
    this._box(mat, [11, roofY, -13], [4, 0.4, 2], { tile: 3 });

    // --- Support pillars ---
    for (const px of [-7, 7]) {
      for (const pz of [-13, -3]) {
        this._box('concrete', [px, W.h / 2, pz], [0.7, W.h, 0.7], { tile: 1.5 });
      }
    }

    // --- Mezzanine platform (north-east quarter) ---
    const mz = { x0: 2.5, x1: 12.7, z0: -16.7, z1: -9, y: 3.2 };
    const mw = mz.x1 - mz.x0;
    const md = mz.z1 - mz.z0;
    this._box('metal', [(mz.x0 + mz.x1) / 2, mz.y, (mz.z0 + mz.z1) / 2], [mw, 0.4, md], { tile: 2, surface: SURFACE.METAL });
    // Under-platform bracing
    for (const px of [4, 8, 12]) {
      this._box('metal', [px, mz.y / 2, mz.z1 - 0.3], [0.35, mz.y, 0.35], { tile: 1, surface: SURFACE.METAL });
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
    this._stairs('metal', [10.9, 0, -5.4], [0, -1], 20, 0.17, 0.18, 1.6);
    // Landing joining the top step to the platform
    this._box('metal', [10.9, 3.2, -9.4], [1.6, 0.3, 1.0], { tile: 1, surface: SURFACE.METAL });

    // --- Mezzanine railings (instanced posts + rails handled in decoration) ---
    this.mezzanine = mz;

    // --- Interior partition making a corridor along the west wall ---
    this._wallWithGaps('concrete', 'z', -7.5, -16.5, -2.5, 3.4, 0.5, [[-11, -9]]);

    // --- Interior light panels (emissive, no shadow cost) ---
    for (const pz of [-14, -8, -2]) {
      this._box('lightPanel', [0, W.h - 0.25, pz], [5, 0.14, 0.9], { collide: false, tile: 1 });
    }
  }

  /**
   * Build a wall along an axis with rectangular gaps (doorways).
   * @param {'x'|'z'} axis  the axis the wall RUNS along
   * @param {number} fixed  the other axis' coordinate
   * @param {number} from   start along `axis`
   * @param {number} to     end along `axis`
   * @param {number[][]} gaps  [[start,end], ...] along `axis`
   */
  _wallWithGaps(material, axis, fixed, from, to, height, thickness, gaps) {
    const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
    let cursor = from;
    const segments = [];
    for (const [gs, ge] of sorted) {
      if (gs > cursor) segments.push([cursor, gs]);
      cursor = Math.max(cursor, ge);
      // Lintel above each doorway so the wall reads as continuous.
      const doorH = 3.0;
      const lintelH = height - doorH;
      if (lintelH > 0.1) {
        const c = (gs + ge) / 2;
        const len = ge - gs;
        if (axis === 'x') this._box(material, [c, doorH + lintelH / 2, fixed], [len, lintelH, thickness], { tile: 2 });
        else this._box(material, [fixed, doorH + lintelH / 2, c], [thickness, lintelH, len], { tile: 2 });
      }
    }
    if (cursor < to) segments.push([cursor, to]);

    for (const [s, e] of segments) {
      const len = e - s;
      if (len <= 0.01) continue;
      const c = (s + e) / 2;
      if (axis === 'x') this._box(material, [c, height / 2, fixed], [len, height, thickness], { tile: 2 });
      else this._box(material, [fixed, height / 2, c], [thickness, height, len], { tile: 2 });
    }
  }

  // ------------------------------------------------------------ outbuildings
  /**
   * A 10x10 blockhouse with a walkable roof. Access is a flight of stairs on
   * the OUTWARD side (away from the arena centre) leading onto an apron slab
   * that bridges onto the roof, with a matching gap left in the parapet.
   *
   * @param {'west'|'east'} side which flank this building is on
   */
  _buildOutbuilding(cx, cz, side) {
    const w = 10, d = 10, h = 4.2, t = 0.5;
    const mat = 'concrete';
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const roofY = h + 0.2;            // slab centre; walkable surface = h + 0.4
    const outward = side === 'west' ? -1 : 1;

    // --- Walls; the ground-floor doorway faces the arena centre ---
    this._wallWithGaps(mat, 'x', z0, x0, x1, h, t, [[cx - 1.5, cx + 1.5]]);
    this._wallWithGaps(mat, 'x', z1, x0, x1, h, t, []);
    this._wallWithGaps(mat, 'z', x0, z0, z1, h, t, side === 'west' ? [] : [[cz - 1.5, cz + 1.5]]);
    this._wallWithGaps(mat, 'z', x1, z0, z1, h, t, side === 'west' ? [[cz - 1.5, cz + 1.5]] : []);

    // --- Roof slab ---
    this._box('concrete', [cx, roofY, cz], [w + 0.4, 0.4, d + 0.4], { tile: 2.5 });

    // --- Stair access on the outward face, climbing toward -Z ---
    const stairX = cx + outward * (w / 2 + 1.6);
    const stairTopZ = cz + d / 2 - 1.0;      // z where the top step lands
    const steps = 13;
    const rise = 0.36;
    const run = 0.44;
    this._stairs('concrete', [stairX, 0, stairTopZ + steps * run], [0, -1], steps, rise, run, 2.4);

    // Apron slab bridging the top step onto the roof.
    const apronX = cx + outward * (w / 2 + 1.2);
    this._box('concrete', [apronX, roofY, stairTopZ - 0.8], [3.6, 0.4, 2.4], { tile: 2 });

    // --- Parapet, with a gap where the apron meets the roof ---
    const py = h + 0.4 + 0.35;
    this._box('concrete', [cx, py, z0 - 0.1], [w + 0.4, 0.7, 0.3], { tile: 1.5 });
    this._box('concrete', [cx, py, z1 + 0.1], [w + 0.4, 0.7, 0.3], { tile: 1.5 });
    // Inward-facing parapet: continuous.
    this._box('concrete', [cx - outward * (w / 2 + 0.1), py, cz], [0.3, 0.7, d + 0.4], { tile: 1.5 });
    // Outward-facing parapet: split around the access gap.
    const gapMin = stairTopZ - 2.0;
    const gapMax = stairTopZ + 0.4;
    const segA = [z0 - 0.2, gapMin];
    const segB = [gapMax, z1 + 0.2];
    for (const [s, e] of [segA, segB]) {
      const len = e - s;
      if (len <= 0.1) continue;
      this._box('concrete', [cx + outward * (w / 2 + 0.1), py, (s + e) / 2], [0.3, 0.7, len], { tile: 1.5 });
    }

    this[`${side}Roof`] = { x: cx, y: h + 0.4, z: cz };
  }

  // ---------------------------------------------------------------- catwalk
  _buildCatwalk() {
    const y = 3.6;
    // Deck running east–west across the north end.
    this._box('metal', [-8, y, -27], [40, 0.35, 3.4], { tile: 2, surface: SURFACE.METAL });
    // Support columns
    for (let x = -26; x <= 10; x += 9) {
      this._box('metal', [x, y / 2, -27], [0.4, y, 0.4], { tile: 1, surface: SURFACE.METAL });
    }
    // Ramp climbing from the arena floor (east, +X) up to the deck's east end
    // at x = 12. `rotY = -PI/2` puts the ramp's high end on the -X side.
    this._ramp('metal', [16.75, y / 2, -27], 2.6, 9.5, y - 0.1, {
      rotY: -Math.PI / 2, surface: SURFACE.METAL, thickness: 0.4,
    });

    this.catwalk = { y, z: -27, x0: -28, x1: 12 };
  }

  // ------------------------------------------------------------- containers
  _buildContainers() {
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
      this._box('metalPanel', [x, y, z], [6.1, 2.6, 2.5], { rotY, tile: 2.2, surface: SURFACE.METAL });
    }

    // A ramp onto the west container stack.
    this._ramp('metal', [-22, 0.65, -0.6], 2.2, 3.6, 1.3, { surface: SURFACE.METAL });
  }

  // ------------------------------------------------------------ hard cover
  _buildCoverBlocks() {
    const blocks = [
      [-4, 8], [5, 9], [-10, 14], [11, 13], [0, 18], [-18, 6], [18, 5],
      [-8, -21], [9, -22], [-16, -24], [16, -25], [-3, -24], [26, -14], [-26, -14],
      [17, 20], [-17, 20], [3, -6], [-4, -12],
    ];
    for (const [x, z] of blocks) {
      const rotY = ((x * 31 + z * 17) % 7) * 0.22;
      this._box('concrete', [x, 0.55, z], [2.4, 1.1, 0.8], { rotY, tile: 1.4 });
      this._box('hazard', [x, 1.14, z], [2.4, 0.08, 0.8], { rotY, collide: false, tile: 1 });
    }
  }

  // ------------------------------------------------------------- decoration
  _buildDecoration() {
    // --- Pipes running along the perimeter walls (InstancedMesh) ---
    const pipeGeo = new THREE.CylinderGeometry(0.16, 0.16, 8, 8, 1, true);
    pipeGeo.rotateZ(Math.PI / 2);
    const pipeMat = this.assets.getMaterial('rustMetal');
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
    this.scene.add(pipes);
    this.objects.push(pipes);
    this.instancedMeshes = [pipes];

    // --- Railings on the mezzanine and catwalk (InstancedMesh of posts) ---
    const postGeo = new THREE.BoxGeometry(0.08, 1.0, 0.08);
    const railMat = this.assets.getMaterial('metal');
    const railSpecs = [];
    // Mezzanine south edge
    for (let x = 3; x <= 12.5; x += 1.2) railSpecs.push([x, 3.9, this.mezzanine.z1, 0]);
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
    this.scene.add(posts);
    this.objects.push(posts);
    this.instancedMeshes.push(posts);

    // Continuous top rails (merged static geometry, no collision needed).
    this._box('metal', [7.75, 4.4, this.mezzanine.z1], [9.5, 0.08, 0.08], { collide: false, tile: 1 });
    this._box('metal', [-8, 4.8, -25.4], [38, 0.08, 0.08], { collide: false, tile: 1 });
    this._box('metal', [-8, 4.8, -28.6], [38, 0.08, 0.08], { collide: false, tile: 1 });

    // Low guard rail as an actual collider so players can't walk off.
    this._box('metal', [7.75, 4.0, this.mezzanine.z1], [9.5, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
    this._box('metal', [-8, 4.4, -25.4], [38, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
    this._box('metal', [-8, 4.4, -28.6], [38, 0.9, 0.12], { collide: true, tile: 1, surface: SURFACE.METAL });
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
  _buildWindows() {
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

      this.physics.createStaticBox(
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
        this._box('frame', [fx, fy, fz], [fw, fh, fd], { collide: false, tile: 1 });
      }
    }

    // One merged, transparent mesh for every pane in the level.
    if (glassGeos.length) {
      const merged = mergeGeometries(glassGeos, false);
      for (const gg of glassGeos) gg.dispose();
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, this.assets.getMaterial('glass'));
        mesh.castShadow = false;    // transparent glass casting shadows looks wrong
        mesh.receiveShadow = false;
        mesh.renderOrder = 4;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = 'level_glass';
        this.scene.add(mesh);
        this.objects.push(mesh);
      }
    }
  }

  /** Merge every queued geometry into one mesh per material. */
  _flush() {
    for (const [matName, geos] of this._pending) {
      if (!geos.length) continue;
      let merged;
      try {
        merged = mergeGeometries(geos, false);
      } catch (err) {
        console.error(`[Level] Merge failed for "${matName}"; drawing separately.`, err);
        merged = null;
      }
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, this.assets.getMaterial(matName));
        mesh.castShadow = matName !== 'floorTile' && matName !== 'lightPanel';
        mesh.receiveShadow = matName !== 'lightPanel';
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = `level_${matName}`;
        this.scene.add(mesh);
        this.objects.push(mesh);
        for (const g of geos) g.dispose();
      } else {
        for (const g of geos) {
          const mesh = new THREE.Mesh(g, this.assets.getMaterial(matName));
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.scene.add(mesh);
          this.objects.push(mesh);
        }
      }
    }
    this._pending.clear();
  }

  // ------------------------------------------------------------------ props
  _buildProps() {
    // --- Wooden crates: light, very pushable ---
    const cratePositions = [
      [-6.5, 6.5], [-5.2, 7.6], [-6.0, 8.9], [7.5, 7.0], [8.6, 8.1],
      [-9.5, -3.0], [-10.6, -4.1], [2.0, -14.5], [3.1, -15.6], [4.0, -13.4],
      [19.5, 3.0], [-19.5, 3.0], [12.5, 24.0], [-12.5, 24.0], [0.5, -20.0],
      [24.0, -20.0], [-24.0, -20.0], [6.0, 4.0],
    ];
    const crateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    scaleBoxUVs(crateGeo, 0.9, 0.9, 0.9, 0.9);
    this.assets.ownGeometry(crateGeo);
    for (const [x, z] of cratePositions) {
      const stack = Math.random() < 0.35 ? 2 : 1;
      for (let k = 0; k < stack; k++) {
        this._spawnProp({
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
    this.assets.ownGeometry(barrelGeo);
    const barrelPositions = [
      [-2.5, 10.5], [-1.4, 11.4], [10.0, 11.0], [-13.0, 9.0], [13.5, -1.5],
      [-11.5, -14.0], [21.0, 12.0], [-21.0, 12.0], [4.5, -25.0], [-6.0, -28.0],
      [28.0, 2.0], [-28.0, 2.0],
    ];
    for (const [x, z] of barrelPositions) {
      this._spawnProp({
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
      const prop = this._spawnProp({
        geometry: barrelGeo,
        material: 'explosiveBarrel',
        position: new THREE.Vector3(x, 0.56, z),
        shape: 'cylinder',
        half: { y: 0.55, r: 0.35 },
        mass: 40,
        surface: SURFACE.METAL,
        kind: TAG_KIND.EXPLOSIVE,
      });
      prop.explosive = true;
      prop.health = 45;
      prop.blastRadius = 7.5;
      prop.blastDamage = 95;
      // Impulse in N·s — see PhysicsWorld.applyExplosion. At the epicentre
      // this throws an 18 kg crate at roughly 19 m/s.
      prop.blastForce = 340;
      prop.exploded = false;
      this.explosives.push(prop);
    }
  }

  _spawnProp({ geometry, material, position, shape, half, mass, surface, rotY = 0, kind = TAG_KIND.PROP }) {
    const mesh = new THREE.Mesh(geometry, this.assets.getMaterial(material));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(position);
    this.scene.add(mesh);

    const prop = { mesh, explosive: false, health: Infinity, surface };
    const tag = { kind, surface, prop };

    if (shape === 'box') {
      const quat = rotY ? new THREE.Quaternion().setFromAxisAngle(UP, rotY) : null;
      const { body, collider } = this.physics.createDynamicBox(position, half, {
        mass, tag, mesh, quat, friction: 0.75, restitution: 0.05,
      });
      prop.body = body;
      prop.collider = collider;
    } else {
      const { body, collider } = this.physics.createDynamicCylinder(position, half.y, half.r, {
        mass, tag, mesh, friction: 0.6, restitution: 0.12,
      });
      prop.body = body;
      prop.collider = collider;
    }

    this.props.push(prop);
    return prop;
  }

  // ------------------------------------------------------------- navigation
  _buildNavData() {
    // --- Pickup spots ---
    this.pickupSpots = [
      { type: 'health', pos: new THREE.Vector3(-11.5, 0.6, 5.5) },
      { type: 'health', pos: new THREE.Vector3(11.5, 0.6, 5.5) },
      { type: 'health', pos: new THREE.Vector3(7.5, 3.9, -13.5) },  // mezzanine
      { type: 'health', pos: new THREE.Vector3(0, 0.6, -29) },
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

  /** Restore every prop and explosive barrel to its starting state. */
  reset() {
    for (const prop of this.props) {
      if (prop.exploded) {
        prop.mesh.visible = true;
        prop.exploded = false;
      }
      if (prop.explosive) prop.health = 45;
      if (prop.body && prop.startPos) {
        prop.body.setTranslation(prop.startPos, true);
        prop.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        prop.body.setLinvel(ZERO, true);
        prop.body.setAngvel(ZERO, true);
      }
    }
  }

  /** Snapshot current prop transforms as the reset state. Call after build. */
  captureResetState() {
    for (const prop of this.props) {
      const t = prop.body.translation();
      prop.startPos = { x: t.x, y: t.y, z: t.z };
    }
  }

  dispose() {
    for (const obj of this.objects) {
      this.scene.remove(obj);
      if (obj.isMesh || obj.isInstancedMesh) {
        obj.geometry?.dispose();
      }
    }
    for (const prop of this.props) {
      this.scene.remove(prop.mesh);
    }
    this.sky?.material.dispose();
    this.sky?.geometry.dispose();
    this.envRT?.dispose();
    this.scene.environment = null;
    this.scene.fog = null;
    this.objects.length = 0;
    this.props.length = 0;
    this.explosives.length = 0;
  }
}

/* ------------------------------------------------------------------ helpers */

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const ZERO = { x: 0, y: 0, z: 0 };

/**
 * Rescale a BoxGeometry's UVs so the texture tiles at a constant world size
 * instead of stretching to fit each face.
 *
 * BoxGeometry emits faces in the order +X, -X, +Y, -Y, +Z, -Z, four vertices
 * each (with the default 1x1x1 segmentation).
 */
function scaleBoxUVs(geo, sx, sy, sz, tile) {
  const uv = geo.attributes.uv;
  if (!uv) return;
  const arr = uv.array;
  const scales = [
    [sz / tile, sy / tile], // +X
    [sz / tile, sy / tile], // -X
    [sx / tile, sz / tile], // +Y
    [sx / tile, sz / tile], // -Y
    [sx / tile, sy / tile], // +Z
    [sx / tile, sy / tile], // -Z
  ];
  for (let face = 0; face < 6; face++) {
    const [us, vs] = scales[face];
    for (let v = 0; v < 4; v++) {
      const i = (face * 4 + v) * 2;
      arr[i] *= us;
      arr[i + 1] *= vs;
    }
  }
  uv.needsUpdate = true;
}

/** Default impact surface for a material name. */
function surfaceForMaterial(name) {
  switch (name) {
    case 'metal':
    case 'metalPanel':
    case 'rustMetal':
    case 'hazard':
    case 'frame':
      return SURFACE.METAL;
    case 'wood':
    case 'crate':
      return SURFACE.WOOD;
    case 'dirt':
      return SURFACE.DIRT;
    default:
      return SURFACE.CONCRETE;
  }
}

export { scaleBoxUVs };

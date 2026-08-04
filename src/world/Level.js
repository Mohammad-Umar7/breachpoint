/**
 * Level — the toolkit that a map is BUILT WITH, and the world it builds into.
 *
 * This class owns none of the layout. It owns the machinery every layout needs:
 *   - Static geometry declared as axis-aligned (optionally Y-rotated) boxes.
 *     Boxes sharing a material are merged into ONE `BufferGeometry` with
 *     `mergeGeometries`, so the hundreds of boxes making up an arena collapse
 *     into one draw call per material. Each box also gets a matching Rapier
 *     fixed cuboid collider.
 *   - Ramps, stairs and walls-with-doorways built out of those boxes.
 *   - Dynamic props (crates, barrels) driven by physics.
 *   - Sky, sun, fog and fill lighting, configured per map.
 *   - Teardown complete enough to build a DIFFERENT map into the same world.
 *
 * The layouts themselves live one per file in `maps/`, and a map definition is
 * what this is constructed with. That is the whole reason for the split: adding
 * an arena is adding a file, not adding a branch to an existing one.
 *
 * WHY TEARDOWN IS NOT AN AFTERTHOUGHT
 * -----------------------------------
 * Switching maps means unbuilding one and building another into a live physics
 * world. Colliders that outlive their meshes are invisible and permanent — you
 * would walk into a wall that is not there, on a map that never had one — so
 * every static body is tracked from the moment it is made. See `_box`.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { SURFACE } from '../core/AssetManager.js';
import { TAG_KIND } from '../physics/PhysicsWorld.js';
import { randRange } from '../core/MathUtils.js';

const SHADOW_SIZES = { off: 0, low: 1024, medium: 2048, high: 4096 };

/**
 * Merged batches that must NOT cast a shadow.
 *
 * Two different reasons, and both look like a rendering bug when ignored:
 *   - An EMISSIVE surface that casts a shadow reads as broken. A ceiling light
 *     is meant to be the source of the light in the room, and one that throws
 *     a black rectangle onto the floor beneath itself is the single most
 *     obvious wrong thing on a lit interior map.
 *   - GLAZING should throw the pattern of its bars and reveals, not a solid
 *     slab of shade. The manor's conservatory is 9 x 11 m of glass; casting
 *     from the panes put the whole wing in the dark at dawn.
 * `floorTile` is here for neither: a floor can only ever shadow itself, and
 * self-shadowing a flat plane is pure acne.
 */
const NO_SHADOW_CAST = new Set([
  'floorTile', 'lightPanel', 'lampGlow', 'stainedGlass', 'manorGlass',
]);

export class Level {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   * @param {import('../core/AssetManager.js').AssetManager} assets
   * @param {import('../core/Settings.js').Settings} settings
   * @param {THREE.WebGLRenderer} renderer
   */
  /**
   * @param {object} map  a definition from `maps/` — see maps/index.js
   */
  constructor(scene, physics, assets, settings, renderer, map) {
    this.scene = scene;
    this.physics = physics;
    this.assets = assets;
    this.settings = settings;
    this.renderer = renderer;
    this.map = map;

    /** Pending geometry, grouped by material name, merged in `_flush()`. */
    this._pending = new Map();
    /** @type {THREE.Object3D[]} everything we added to the scene */
    this.objects = [];
    /** @type {Array} dynamic props: crates, barrels, explosive barrels */
    this.props = [];
    /** @type {Array} explosive barrels only */
    this.explosives = [];
    /**
     * Every static physics body this level created.
     *
     * Tracked so `dispose()` can take them out again. A collider left behind
     * when the map is swapped is invisible and permanent — an unmarked wall in
     * the middle of the next arena — and nothing in the renderer would show it.
     */
    this.staticBodies = [];

    this.playerSpawn = new THREE.Vector3(...map.playerSpawn);
    this.playerSpawnYaw = map.playerSpawnYaw ?? 0;
    /** @type {Array} pickup definitions consumed by PickupManager */
    this.pickupSpots = [];
    /** Top-down footprints of everything solid, for the minimap. See _box. */
    this.mapShapes = [];

    this.bounds = {
      min: new THREE.Vector3(...map.bounds.min),
      max: new THREE.Vector3(...map.bounds.max),
    };
  }

  /** Identifier of the map currently built, for anything that has to care. */
  get mapId() { return this.map.id; }

  // ==================================================================== build
  build() {
    this._buildSkyAndLights(this.map.env);
    // Everything below the sky is the map's own. It is expected to call
    // `_flush()` itself, because only the layout knows when it has finished
    // queueing geometry — window frames, for instance, must go in before it.
    this.map.build(this);
    return this;
  }

  // ------------------------------------------------------------ sky & light
  /**
   * Sky, sun, fog and fill light, entirely from the map's `env` block.
   *
   * This is most of what makes two maps feel like different places. Geometry
   * decides how a map PLAYS; the light decides what it IS — the same boxes
   * under a midday sun and under magenta night lighting do not read as the
   * same location at all.
   */
  _buildSkyAndLights(env) {
    // --- Procedural sky (Preetham model shipped with three.js examples) ---
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    // `turbidity` and `mieCoefficient` are what create the enormous white halo
    // around the sun — at the old warehouse values (6.5 / 0.006) the glare blew
    // out the middle of the screen whenever you faced it.
    u.turbidity.value = env.sky.turbidity;
    u.rayleigh.value = env.sky.rayleigh;
    u.mieCoefficient.value = env.sky.mie;
    u.mieDirectionalG.value = env.sky.mieG;

    // Elevation is kept above the normal eyeline on every map, or you spend
    // half the match aiming into the light.
    const elevation = env.sky.elevation;
    const azimuth = env.sky.azimuth;
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
      this.scene.environmentIntensity = env.envIntensity;
      skyClone.geometry.dispose();
      skyClone.material.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn('[Level] Environment map generation failed; using lights only.', err);
    }

    // --- Fog: atmospheric depth, tuned to the arena size ---
    // A small map wants DENSER fog, not less: the distances are shorter, so a
    // density tuned for 70 m does nothing at all across 35 m.
    this.scene.fog = new THREE.FogExp2(env.fog.color, env.fog.density);

    // --- Sun ---
    const sun = new THREE.DirectionalLight(env.sun.color, env.sun.intensity);
    sun.position.copy(this.sunDirection).multiplyScalar(90);
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun.target);
    this._configureSunShadow(sun);
    this.scene.add(sun);
    this.objects.push(sun, sun.target);
    this.sun = sun;

    this.settings.onChange('shadowQuality', () => this._configureSunShadow(this.sun));

    // --- Fill lighting ---
    const hemi = new THREE.HemisphereLight(
      env.hemi.sky, env.hemi.ground, env.hemi.intensity);
    this.scene.add(hemi);
    this.objects.push(hemi);

    const ambient = new THREE.AmbientLight(env.ambient.color, env.ambient.intensity);
    this.scene.add(ambient);
    this.objects.push(ambient);

    // A bounce from the opposite side keeps shadowed faces readable.
    const bounce = new THREE.DirectionalLight(env.bounce.color, env.bounce.intensity);
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
    /*
     * The shadow camera has to cover the WHOLE map, because a directional
     * light's does not follow the player. Sized per map: using the warehouse's
     * 42 m half-extent on a 35 m arena would spend three quarters of every
     * shadow texel on empty space outside it.
     */
    const half = this.map.env.sun.shadowHalf;
    const cam = sun.shadow.camera;
    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = this.map.env.sun.shadowFar;
    cam.updateProjectionMatrix();
    /*
     * Depth bias, per map, because it depends on the SUN ANGLE.
     *
     * A shallow sun spreads each shadow texel across far more surface, so the
     * depth stored for a texel diverges further from the depth of the pixel
     * being shaded — which is shadow acne: a shimmering stipple that crawls as
     * the camera moves. The warehouse's figures were tuned against a 42-degree
     * midday sun; the outpost's is at 20 and needs several times the slack.
     */
    sun.shadow.bias = this.map.env.sun.bias ?? -0.0008;
    sun.shadow.normalBias = this.map.env.sun.normalBias ?? 0.035;
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
      // `y` is the CENTRE, so a reader can work out what a shape actually
      // occupies vertically. Without it a floor slab and a wall are
      // indistinguishable — both are "something solid at these coordinates" —
      // and a check for "is this spawn inside geometry" says yes to every
      // point on the map, because they are all above the floor.
      // `mat` is carried so a tool can tell a visible seam from an invisible
      // one: two identical surfaces meeting on a plane look like one surface,
      // whereas terracotta meeting sandstone on that plane flickers between
      // two colours. See the shimmer check in test/maps.mjs.
      this.mapShapes.push({ x, y, z, hx: sx / 2, hz: sz / 2, rotY, height: sy, mat: material });
    }

    if (collide) {
      const quat = rotY ? new THREE.Quaternion().setFromAxisAngle(UP, rotY) : null;
      const made = this.physics.createStaticBox(
        { x, y, z },
        { x: sx / 2, y: sy / 2, z: sz / 2 },
        quat,
        { kind: TAG_KIND.WORLD, surface: surface ?? surfaceForMaterial(material) },
        friction
      );
      // Held so dispose() can take it out again. Without this, switching maps
      // leaves the old arena's collision standing invisibly inside the new one.
      if (made?.body) this.staticBodies.push(made.body);
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

    const made = this.physics.createStaticBox(
      { x: pos[0], y: pos[1], z: pos[2] },
      { x: width / 2, y: thickness / 2, z: length / 2 },
      q,
      { kind: TAG_KIND.WORLD, surface: surface ?? surfaceForMaterial(material) },
      0.98
    );
    // Tracked for teardown, exactly as in _box — a ramp left behind after a
    // map swap is a slope in mid-air that you can walk up and cannot see.
    if (made?.body) this.staticBodies.push(made.body);

    /*
     * Ramps are footprints on the minimap too.
     *
     * `_box` collects these for everything solid, and a ramp is not built out
     * of `_box`, so without this the four routes onto NEON's centre platform
     * are simply missing from the map.
     */
    this.mapShapes.push({
      x: pos[0], y: pos[1], z: pos[2],
      hx: width / 2, hz: length / 2, rotY, height: rise, mat: material,
    });
    return this;
  }

  /**
   * Collision with no mesh — for geometry drawn some other way.
   *
   * Window panes are the case: they are merged into one transparent mesh for
   * drawing, but each needs its own collider. Going straight to the physics
   * world for that left the bodies untracked, and they survived `dispose()` —
   * eight invisible sheets of glass standing in the middle of the next map.
   * Anything creating static collision outside `_box` goes through here.
   */
  _staticCollider(pos, half, quat, tag, friction = 0.9) {
    const made = this.physics.createStaticBox(pos, half, quat, tag, friction);
    if (made?.body) this.staticBodies.push(made.body);
    return made;
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




  /**
   * Build a wall along an axis with rectangular gaps (doorways).
   * @param {'x'|'z'} axis  the axis the wall RUNS along
   * @param {number} fixed  the other axis' coordinate
   * @param {number} from   start along `axis`
   * @param {number} to     end along `axis`
   * @param {number[][]} gaps  [[start,end], ...] along `axis`
   * @param {object} [opts]
   *   `baseY`  the floor this wall stands on, default 0
   *   `doorH`  head height of every gap, default 3.0
   *   `tile`   texture repeat, default 2
   *
   * WHY `baseY` AND `doorH` EXIST
   * -----------------------------
   * Both were constants: the wall was always centred at `height / 2` and the
   * lintel always sat at exactly 3.0. That is fine for a single-storey compound
   * and a blocker for anything else — a first-floor partition built with it
   * appeared at ground level, through the floor slab, and every interior door
   * in a house came out as a 3 m hangar arch. The two existing maps pass eight
   * arguments and get the old behaviour unchanged.
   */
  _wallWithGaps(material, axis, fixed, from, to, height, thickness, gaps, opts = {}) {
    const { baseY = 0, doorH = 3.0, tile = 2 } = opts;
    const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
    let cursor = from;
    const segments = [];
    for (const [gs, ge] of sorted) {
      if (gs > cursor) segments.push([cursor, gs]);
      cursor = Math.max(cursor, ge);
      // Lintel above each doorway so the wall reads as continuous.
      const lintelH = height - doorH;
      if (lintelH > 0.1) {
        const c = (gs + ge) / 2;
        const len = ge - gs;
        const ly = baseY + doorH + lintelH / 2;
        if (axis === 'x') this._box(material, [c, ly, fixed], [len, lintelH, thickness], { tile });
        else this._box(material, [fixed, ly, c], [thickness, lintelH, len], { tile });
      }
    }
    if (cursor < to) segments.push([cursor, to]);

    for (const [s, e] of segments) {
      const len = e - s;
      if (len <= 0.01) continue;
      const c = (s + e) / 2;
      const wy = baseY + height / 2;
      if (axis === 'x') this._box(material, [c, wy, fixed], [len, height, thickness], { tile });
      else this._box(material, [fixed, wy, c], [thickness, height, len], { tile });
    }
  }

  // ------------------------------------------------------------ outbuildings






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
        mesh.castShadow = !NO_SHADOW_CAST.has(matName);
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


  /**
   * A pushable prop, and optionally an explosive one.
   *
   * `explosive` takes the whole blast configuration at once, with defaults,
   * rather than leaving a map to set four fields on the returned object by
   * hand. It was by hand, and the outpost's barrels set two of the four — so
   * `blastRadius` was undefined, `dist > undefined` was false for EVERY
   * dynamic body in the world, and detonating one barrel applied a NaN impulse
   * to every crate on the map. The player fell through the floor.
   *
   * Half-configuring it is now impossible: ask for `explosive` and you get all
   * of it, or do not and it is inert.
   */
  _spawnProp({
    geometry, material, position, shape, half, mass, surface,
    rotY = 0, kind = TAG_KIND.PROP, explosive = null,
  }) {
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

    if (explosive) {
      prop.explosive = true;
      prop.health = explosive.health ?? 45;
      prop.blastRadius = explosive.radius ?? 7.5;
      prop.blastDamage = explosive.damage ?? 95;
      // Impulse in N·s — see PhysicsWorld.applyExplosion. 340 at the epicentre
      // throws an 18 kg crate at roughly 19 m/s.
      prop.blastForce = explosive.force ?? 340;
      prop.exploded = false;
      this.explosives.push(prop);
    }

    this.props.push(prop);
    return prop;
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

  /**
   * Take the whole map back out — meshes, lights, props AND collision.
   *
   * The physics half is the part that matters. Colliders are invisible, so a
   * map left half-disposed does not look wrong: it plays wrong, in a way that
   * looks like a bug in movement. Every static body is tracked in `_box` for
   * exactly this moment, and the dynamic props take their own bodies with them.
   */
  dispose() {
    for (const obj of this.objects) {
      this.scene.remove(obj);
      if (obj.isMesh || obj.isInstancedMesh) {
        obj.geometry?.dispose();
      }
    }
    for (const prop of this.props) {
      this.scene.remove(prop.mesh);
      prop.mesh?.geometry?.dispose();
      if (prop.body) this.physics.removeBody(prop.body);
    }
    for (const body of this.staticBodies) this.physics.removeBody(body);

    this.sky?.material.dispose();
    this.sky?.geometry.dispose();
    this.envRT?.dispose();
    this.scene.environment = null;
    this.scene.fog = null;
    this.objects.length = 0;
    this.props.length = 0;
    this.explosives.length = 0;
    this.staticBodies.length = 0;
    this.mapShapes.length = 0;
    this.pickupSpots.length = 0;
    this._pending.clear();
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
    // The outpost is cut stone and mud-brick, which behave like concrete;
    // only its painted woodwork and packing crates sound like timber.
    case 'paintedTeal':
    case 'outpostCrate':
    case 'canopy':
      return SURFACE.WOOD;
    case 'sandstone':
    case 'adobe':
    case 'terracotta':
      return SURFACE.CONCRETE;
    /*
     * The manor is a house, so what you walk on changes room to room and you
     * hear it: bare boards and joinery are timber, the treads of both back
     * stairs are timber, and even the soft furnishings you vault over sound
     * like the wood frame under them rather than like stone.
     */
    case 'walnut':
    case 'oakFloor':
    case 'atticBoard':
    case 'pineStep':
    case 'rafterOak':
    case 'linenSoft':
    case 'carpetOx':
      return SURFACE.WOOD;
    // The car, the brass you grab hold of, and the lead-and-slate roof.
    case 'carDuco':
    case 'brassTrim':
    case 'slateRoof':
      return SURFACE.METAL;
    case 'manorGlass':
    case 'stainedGlass':
      return SURFACE.GLASS;
    default:
      return SURFACE.CONCRETE;
  }
}

/*
 * Exported for map modules to author geometry with.
 *
 * These are part of the toolkit, not internals: `UP` is what a Y-rotation is
 * built around and `scaleBoxUVs` is how a custom geometry gets the same
 * constant-world-size tiling every `_box` does. A map that needed either and
 * could not reach it would end up with its own subtly different copy.
 */
export { scaleBoxUVs, UP, RIGHT, surfaceForMaterial };

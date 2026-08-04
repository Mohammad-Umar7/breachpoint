/**
 * AssetManager — procedural texture & material library.
 *
 * The game intentionally ships with **no binary assets**. Every texture is
 * painted into an offscreen `<canvas>` at boot and converted into a
 * `CanvasTexture`, and normal maps are derived from a grayscale height pass
 * with a Sobel filter. That guarantees the project runs from a clean
 * `npm install` with no downloads, no CORS issues and no missing-file errors.
 *
 * If you later drop real PBR textures into `public/textures/`, call
 * `tryLoadExternal()` — it falls back to the procedural set on any failure.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeRng } from './MathUtils.js';

/**
 * Optional authored models. Each is a progressive enhancement: if the file is
 * missing or fails to parse, the weapon falls back to its procedural model and
 * the game still runs from a clean checkout with no assets at all.
 */
export const MODEL_MANIFEST = [
  // Weapon view models. `kind: 'weapon'` gets the view-model treatment:
  // shadows off, frustum culling off, optic glass swapped for an additive
  // coating. Each is referenced by a weapon definition's `modelId`.
  { id: 'ar15', url: 'models/ar15.glb', kind: 'weapon' },
  { id: 'pistol', url: 'models/pistol.glb', kind: 'weapon' },
  { id: 'deagle', url: 'models/deagle.glb', kind: 'weapon' },
  { id: 'burst', url: 'models/burst.glb', kind: 'weapon' },
  { id: 'smg', url: 'models/smg.glb', kind: 'weapon' },
  { id: 'shotgun', url: 'models/shotgun.glb', kind: 'weapon' },
  { id: 'autoshotgun', url: 'models/autoshotgun.glb', kind: 'weapon' },
  { id: 'sniper', url: 'models/sniper.glb', kind: 'weapon' },
  { id: 'marksman', url: 'models/marksman.glb', kind: 'weapon' },
  { id: 'lmg', url: 'models/lmg.glb', kind: 'weapon' },
  { id: 'knife', url: 'models/knife.glb', kind: 'weapon' },
  { id: 'grenade', url: 'models/grenade.glb', kind: 'weapon' },

  // Player character, exported as separately named body parts rather than one
  // merged mesh so RemotePlayers can animate, tint and toggle them.
  { id: 'soldier', url: 'models/soldier.glb', kind: 'character' },
];

/**
 * Joint pivots for the authored soldier, in metres from the feet.
 *
 * The model is exported in a single world space (boots on y=0, facing -Z),
 * which is easy to author but wrong to rotate: spinning a limb whose geometry
 * sits 1.4 m up swings it around the character's feet. So each part's
 * geometry is translated by -pivot once at load, and the mesh is placed back
 * at the pivot — after which `legL.rotation.x` bends at the hip, exactly as
 * it does for the procedural boxes this replaces.
 *
 * Values match the pivots the model was authored around; changing one here
 * without changing it there will visibly dislocate the limb.
 */
export const SOLDIER_PIVOTS = Object.freeze({
  legL: [-0.13, 0.86, 0], bootL: [-0.13, 0.86, 0],
  legR: [0.13, 0.86, 0], bootR: [0.13, 0.86, 0],
  // Shoulders are 0.25 out, not 0.30. Narrowed with the model redesign: with
  // 0.562 m of arm, shoulders 0.60 m apart left the support hand unable to
  // reach across to a weapon held on the other side. Must match SHOULDER_X in
  // builds/soldier.py — a mismatch detaches the arms from the body.
  armL: [-0.25, 1.42, 0],
  armR: [0.25, 1.42, 0],
  // Forearms pivot at the ELBOW and hang off the upper arm, giving a real
  // two-bone chain (shoulder -> elbow -> wrist). Without that the hand can
  // only ever lie on a sphere around the shoulder, which is not enough to put
  // both hands on a weapon at once — see the note in builds/soldier.py.
  // The gloves ride the forearm, so they share its pivot.
  foreL: [-0.25, 1.148, 0], gloveL: [-0.25, 1.148, 0],
  foreR: [0.25, 1.148, 0], gloveR: [0.25, 1.148, 0],
  // Head, helmet and visor share one pivot so the helmet can parent to the
  // head and nod with it instead of the head rotating inside a static shell.
  head: [0, 1.535, 0], helmet: [0, 1.535, 0], visor: [0, 1.535, 0],
});

/** Surface categories drive impact particles, decals and footstep sounds. */
export const SURFACE = Object.freeze({
  CONCRETE: 'concrete',
  METAL: 'metal',
  WOOD: 'wood',
  DIRT: 'dirt',
  GLASS: 'glass',
  FLESH: 'flesh',
  EXPLOSIVE: 'explosive',
});

export class AssetManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;

    /** @type {Map<string, THREE.Material>} */
    this.materials = new Map();
    /** @type {Map<string, THREE.Texture>} */
    this.textures = new Map();
    /** @type {Map<string, THREE.Object3D>} loaded glTF scenes, keyed by id */
    this.models = new Map();
    /** @type {THREE.BufferGeometry[]} geometries we own and must dispose */
    this._geometries = [];
    this.loadErrors = [];
  }

  /**
   * Build every material. `onProgress(fraction, label)` is optional.
   */
  async build(onProgress = null) {
    const steps = [
      ['Pouring concrete', () => this._buildConcrete()],
      ['Welding steel', () => this._buildMetals()],
      ['Milling timber', () => this._buildWood()],
      ['Painting hazards', () => this._buildHazard()],
      ['Glazing windows', () => this._buildGlass()],
      ['Quarrying sandstone', () => this._buildOutpost()],
      ['Papering the manor', () => this._buildManor()],
      ['Rigging soldiers', () => this._buildCharacterMaterials()],
      ['Generating sprites', () => this._buildSprites()],
    ];

    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      onProgress?.((i / steps.length) * 0.85, label);
      try {
        fn();
      } catch (err) {
        // A failed texture must never stop the game booting — fall back to a
        // flat coloured material so the level is still playable.
        console.error(`[AssetManager] "${label}" failed:`, err);
        this.loadErrors.push(`${label}: ${err.message}`);
      }
      // Yield so the loading bar can actually paint.
      await new Promise((r) => setTimeout(r, 0));
    }

    onProgress?.(0.88, 'Loading weapon models');
    await this.loadModels();
    onProgress?.(1, 'Ready');
  }

  /**
   * Load the optional authored models. Every failure is caught and logged —
   * a missing or broken file must only cost that weapon its detailed model,
   * never the ability to start the game.
   */
  async loadModels() {
    const loader = new GLTFLoader();
    const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

    /**
     * Cache buster, stamped at build time.
     *
     * Models live in `public/`, so unlike the bundle their filenames are not
     * fingerprinted — `models/soldier.glb` today and `models/soldier.glb` after
     * a rebuild are the same URL with different bytes behind it. Browsers hold
     * them for a day (see public/_headers), so a player who had already loaded
     * the game kept the OLD model.
     *
     * That is not a cosmetic problem. When the soldier gained forearm bones,
     * anyone still on the cached version had a rig with pieces missing, and the
     * animation code that expects them silently did nothing — leaving a
     * character with its arms hanging down and a rifle floating at its waist.
     *
     * A version in the query string makes each build a distinct URL, so a
     * rebuilt model always reaches everyone on their next load.
     */
    const version = (typeof __ASSET_VERSION__ !== 'undefined' && __ASSET_VERSION__) || 'dev';

    for (const entry of MODEL_MANIFEST) {
      const url = `${base.replace(/\/?$/, '/')}${entry.url}?v=${version}`;
      try {
        const gltf = await loader.loadAsync(url);
        const scene = gltf.scene;
        scene.name = `model_${entry.id}`;

        if (entry.kind === 'character') {
          this._prepareCharacter(scene);
          this.models.set(entry.id, scene);
          continue;
        }

        // Authored materials arrive as MeshStandardMaterial. Tune them for the
        // view-model pass: no shadows, no depth-writing glass (it would occlude
        // the reticle drawn inside the optic).
        scene.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = false;

          const first = Array.isArray(o.material) ? o.material[0] : o.material;

          // Optic lenses: you have to be able to SEE THROUGH them.
          //
          // Any *lit* transparent surface veils what is behind it — it gets
          // shaded by the view-model lights and reflects the sky through the
          // environment map, so even at 5% opacity the glass reads as a milky
          // disc. An additive coating can only ever ADD a faint blue sheen, so
          // the sight picture stays clear.
          if (first && /glass|lens/i.test(first.name || '')) {
            const coating = new THREE.MeshBasicMaterial({
              name: 'lensCoating',
              color: 0x0c1c28,
              blending: THREE.AdditiveBlending,
              transparent: true,
              depthWrite: false,
              side: THREE.FrontSide,
              toneMapped: false,
            });
            first.dispose();
            o.material = coating;
            o.renderOrder = 24;
            return;
          }

          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
            m.envMapIntensity = 1.1;
            if (m.transparent) {
              m.depthWrite = false;
              m.side = THREE.DoubleSide;
            }
          }
        });

        this.models.set(entry.id, scene);
      } catch (err) {
        console.warn(
          `[AssetManager] Model "${entry.id}" could not be loaded from ${url} — ` +
          'falling back to the procedural view model.', err
        );
        this.loadErrors.push(`model ${entry.id}: ${err.message ?? err}`);
      }
    }
  }

  /**
   * Re-pivot an authored character so its limbs rotate at their joints.
   *
   * Runs once per load, not once per body: the translation is baked into the
   * shared BufferGeometry, so every player in the match reuses the same 16
   * geometries and only clones materials. With a full lobby that is the
   * difference between 16 buffers and ~190.
   */
  _prepareCharacter(scene) {
    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;

      const pivot = SOLDIER_PIVOTS[o.name];
      if (pivot) {
        o.geometry = o.geometry.clone();
        o.geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
        o.userData.pivot = pivot;
      } else {
        o.userData.pivot = [0, 0, 0];
      }
      o.position.set(0, 0, 0);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      o.geometry.computeBoundingSphere();
    });
  }

  /** @returns {THREE.Object3D|null} the loaded scene, or null if unavailable */
  getModel(id) {
    return this.models.get(id) ?? null;
  }

  /**
   * Look up one named part of an authored character.
   * @returns {{geometry: THREE.BufferGeometry, pivot: number[]}|null}
   */
  getCharacterPart(id, name) {
    const scene = this.models.get(id);
    if (!scene) return null;
    const mesh = scene.getObjectByName(name);
    if (!mesh?.isMesh) return null;
    return { geometry: mesh.geometry, pivot: mesh.userData.pivot ?? [0, 0, 0] };
  }

  // ------------------------------------------------------------- public API
  /** @returns {THREE.Material} */
  getMaterial(name) {
    const m = this.materials.get(name);
    if (m) return m;
    console.warn(`[AssetManager] Unknown material "${name}", using fallback.`);
    return this._fallbackMaterial();
  }

  getTexture(name) {
    return this.textures.get(name) ?? null;
  }

  /** Registers a geometry so `dispose()` cleans it up. */
  ownGeometry(geo) {
    this._geometries.push(geo);
    return geo;
  }

  _fallbackMaterial() {
    if (!this.materials.has('__fallback')) {
      this.materials.set(
        '__fallback',
        new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.9, metalness: 0.0 })
      );
    }
    return this.materials.get('__fallback');
  }

  // ------------------------------------------------------- texture plumbing
  /**
   * Paint a colour map + a height map, derive a normal map, and register a
   * `MeshStandardMaterial`.
   */
  _register(name, opts) {
    const {
      size = 256,
      paintColor,
      paintHeight = null,
      paintRoughness = null,
      roughness = 0.9,
      metalness = 0.0,
      normalScale = 1.0,
      color = 0xffffff,
      emissive = 0x000000,
      emissiveIntensity = 1,
      envMapIntensity = 1,
      side = THREE.FrontSide,
      transparent = false,
      opacity = 1,
    } = opts;

    const colorTex = this._canvasTexture(`${name}_map`, size, paintColor, true);

    let normalTex = null;
    if (paintHeight) {
      const heightCanvas = makeCanvas(size);
      paintHeight(heightCanvas.getContext('2d'), size, makeRng(hashString(name)));
      normalTex = this._normalFromHeight(`${name}_normal`, heightCanvas, size, normalScale);
    }

    let roughTex = null;
    if (paintRoughness) {
      roughTex = this._canvasTexture(`${name}_rough`, size, paintRoughness, false);
    }

    const mat = new THREE.MeshStandardMaterial({
      color,
      map: colorTex,
      normalMap: normalTex,
      roughnessMap: roughTex,
      roughness,
      metalness,
      emissive,
      emissiveIntensity,
      envMapIntensity,
      side,
      transparent,
      opacity,
    });
    if (normalTex) mat.normalScale = new THREE.Vector2(normalScale, normalScale);
    mat.name = name;
    this.materials.set(name, mat);
    return mat;
  }

  _canvasTexture(key, size, paint, srgb) {
    const canvas = makeCanvas(size);
    paint(canvas.getContext('2d'), size, makeRng(hashString(key)));
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = Math.min(8, this.maxAnisotropy);
    tex.needsUpdate = true;
    this.textures.set(key, tex);
    return tex;
  }

  /** Sobel height → tangent-space normal map. */
  _normalFromHeight(key, heightCanvas, size, strength) {
    const ctx = heightCanvas.getContext('2d');
    const src = ctx.getImageData(0, 0, size, size).data;
    const out = new Uint8ClampedArray(size * size * 4);

    const at = (x, y) => {
      const xx = (x + size) % size;
      const yy = (y + size) % size;
      return src[(yy * size + xx) * 4] / 255;
    };

    const scale = 4 * strength;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

        let nx = -dx * scale;
        let ny = -dy * scale;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len;
        const nzn = nz / len;

        const i = (y * size + x) * 4;
        out[i] = (nx * 0.5 + 0.5) * 255;
        out[i + 1] = (ny * 0.5 + 0.5) * 255;
        out[i + 2] = (nzn * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }

    const canvas = makeCanvas(size);
    canvas.getContext('2d').putImageData(new ImageData(out, size, size), 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = Math.min(8, this.maxAnisotropy);
    tex.needsUpdate = true;
    this.textures.set(key, tex);
    return tex;
  }

  // -------------------------------------------------------------- materials
  _buildConcrete() {
    this._register('concrete', {
      size: 256,
      roughness: 0.94,
      metalness: 0.02,
      normalScale: 0.85,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#6e7176');
        speckle(ctx, s, rng, 5200, ['#5d6065', '#7b7e84', '#828287', '#54575c'], 0.9, 2.4);
        // Faint pour lines
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 6; i++) {
          const y = rng() * s;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(s, y + (rng() - 0.5) * 12);
          ctx.stroke();
        }
        blotches(ctx, s, rng, 26, 'rgba(40,44,48,0.14)', 8, 34);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 4200, ['#6a6a6a', '#9a9a9a', '#5a5a5a'], 0.8, 2.2);
        blotches(ctx, s, rng, 18, 'rgba(60,60,60,0.35)', 6, 26);
      },
      paintRoughness: (ctx, s, rng) => {
        fill(ctx, s, '#e0e0e0');
        blotches(ctx, s, rng, 30, 'rgba(150,150,150,0.5)', 8, 30);
      },
    });

    this._register('concreteDark', {
      size: 256,
      roughness: 0.96,
      metalness: 0.02,
      normalScale: 0.8,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#4b4e53');
        speckle(ctx, s, rng, 4200, ['#3f4247', '#585b60', '#44474c'], 0.9, 2.2);
        blotches(ctx, s, rng, 22, 'rgba(20,22,26,0.18)', 8, 30);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 3600, ['#6e6e6e', '#949494'], 0.8, 2);
      },
    });

    // Floor: large tiled slabs with grouting, tiled 4x per 8m in the level.
    this._register('floorTile', {
      size: 256,
      roughness: 0.88,
      metalness: 0.05,
      normalScale: 1.1,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#5f6469');
        const cells = 2;
        const cs = s / cells;
        for (let y = 0; y < cells; y++) {
          for (let x = 0; x < cells; x++) {
            const shade = 88 + Math.floor(rng() * 22);
            ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 8})`;
            ctx.fillRect(x * cs + 3, y * cs + 3, cs - 6, cs - 6);
          }
        }
        speckle(ctx, s, rng, 3200, ['rgba(0,0,0,0.16)', 'rgba(255,255,255,0.07)'], 0.8, 2.1);
        // grout
        ctx.strokeStyle = 'rgba(28,30,34,0.85)';
        ctx.lineWidth = 5;
        for (let i = 0; i <= cells; i++) {
          ctx.beginPath(); ctx.moveTo(i * cs, 0); ctx.lineTo(i * cs, s); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, i * cs); ctx.lineTo(s, i * cs); ctx.stroke();
        }
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#b0b0b0');
        const cs = s / 2;
        ctx.strokeStyle = '#404040';
        ctx.lineWidth = 6;
        for (let i = 0; i <= 2; i++) {
          ctx.beginPath(); ctx.moveTo(i * cs, 0); ctx.lineTo(i * cs, s); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, i * cs); ctx.lineTo(s, i * cs); ctx.stroke();
        }
      },
    });

    this._register('dirt', {
      size: 256,
      roughness: 1.0,
      metalness: 0.0,
      normalScale: 1.0,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#6b5b45');
        speckle(ctx, s, rng, 6000, ['#5b4c39', '#7c6a51', '#4e4133', '#8a7659'], 0.9, 2.6);
        blotches(ctx, s, rng, 30, 'rgba(50,42,32,0.2)', 6, 28);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 6000, ['#666', '#999', '#555'], 0.9, 2.6);
      },
    });
  }

  _buildMetals() {
    this._register('metal', {
      size: 256,
      roughness: 0.42,
      metalness: 0.92,
      normalScale: 0.6,
      color: 0xb9c2c9,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#8c949c');
        brushed(ctx, s, rng, 900, 'rgba(255,255,255,0.06)', 'rgba(0,0,0,0.08)');
        blotches(ctx, s, rng, 14, 'rgba(70,60,45,0.16)', 6, 26); // light rust
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        brushed(ctx, s, rng, 700, 'rgba(255,255,255,0.10)', 'rgba(0,0,0,0.10)');
      },
      paintRoughness: (ctx, s, rng) => {
        fill(ctx, s, '#6a6a6a');
        blotches(ctx, s, rng, 22, 'rgba(200,200,200,0.45)', 8, 30);
      },
    });

    this._register('metalPanel', {
      size: 256,
      roughness: 0.5,
      metalness: 0.85,
      normalScale: 1.4,
      color: 0x9aa4ac,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#77808a');
        // corrugated container ribs
        for (let x = 0; x < s; x += 16) {
          const g = ctx.createLinearGradient(x, 0, x + 16, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.22)');
          g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
          g.addColorStop(1, 'rgba(0,0,0,0.22)');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, 16, s);
        }
        speckle(ctx, s, rng, 1400, ['rgba(60,40,25,0.25)', 'rgba(0,0,0,0.12)'], 0.8, 3);
        // rivets along the edges
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        for (let y = 8; y < s; y += 32) {
          ctx.beginPath(); ctx.arc(6, y, 2.2, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(s - 6, y, 2.2, 0, 7); ctx.fill();
        }
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#808080');
        for (let x = 0; x < s; x += 16) {
          const g = ctx.createLinearGradient(x, 0, x + 16, 0);
          g.addColorStop(0, '#3a3a3a');
          g.addColorStop(0.5, '#d8d8d8');
          g.addColorStop(1, '#3a3a3a');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, 16, s);
        }
      },
    });

    this._register('rustMetal', {
      size: 256,
      roughness: 0.78,
      metalness: 0.55,
      normalScale: 1.0,
      color: 0xa87a55,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#7a5a3e');
        blotches(ctx, s, rng, 40, 'rgba(120,68,32,0.35)', 5, 30);
        blotches(ctx, s, rng, 24, 'rgba(52,44,40,0.35)', 4, 20);
        speckle(ctx, s, rng, 3000, ['#8a6440', '#5f462f', '#a07049'], 0.9, 2.4);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        blotches(ctx, s, rng, 40, 'rgba(40,40,40,0.35)', 5, 26);
        speckle(ctx, s, rng, 3000, ['#6a6a6a', '#9a9a9a'], 0.8, 2.2);
      },
    });

    this._register('gunMetal', {
      size: 128,
      roughness: 0.36,
      metalness: 0.95,
      normalScale: 0.5,
      color: 0x8d959c,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#3d4247');
        brushed(ctx, s, rng, 500, 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.12)');
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        brushed(ctx, s, rng, 400, 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.08)');
      },
    });

    this._register('gunPolymer', {
      size: 128,
      roughness: 0.68,
      metalness: 0.05,
      normalScale: 0.7,
      color: 0x2b2f33,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#25292d');
        speckle(ctx, s, rng, 2600, ['#1d2124', '#31363a'], 0.6, 1.6);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 2600, ['#6e6e6e', '#929292'], 0.6, 1.6);
      },
    });
  }

  _buildWood() {
    this._register('wood', {
      size: 256,
      roughness: 0.86,
      metalness: 0.0,
      normalScale: 0.9,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#9a6f42');
        grain(ctx, s, rng, 120, 'rgba(90,60,30,0.30)');
        grain(ctx, s, rng, 60, 'rgba(190,150,100,0.16)');
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        grain(ctx, s, rng, 120, 'rgba(40,40,40,0.35)');
      },
    });

    // Crate: planks + diagonal bracing + a stencil.
    this._register('crate', {
      size: 256,
      roughness: 0.88,
      metalness: 0.0,
      normalScale: 1.3,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#a9793f');
        grain(ctx, s, rng, 140, 'rgba(95,63,28,0.28)');
        // horizontal planks
        ctx.strokeStyle = 'rgba(50,32,14,0.6)';
        ctx.lineWidth = 4;
        for (let i = 1; i < 4; i++) {
          const y = (i * s) / 4;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
        }
        // frame
        ctx.strokeStyle = 'rgba(74,48,22,0.9)';
        ctx.lineWidth = 14;
        ctx.strokeRect(7, 7, s - 14, s - 14);
        // diagonal brace
        ctx.strokeStyle = 'rgba(74,48,22,0.55)';
        ctx.lineWidth = 12;
        ctx.beginPath(); ctx.moveTo(14, 14); ctx.lineTo(s - 14, s - 14); ctx.stroke();
        // stencil
        ctx.fillStyle = 'rgba(230,225,210,0.35)';
        ctx.font = 'bold 30px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('AMMO', s / 2, s / 2 + 10);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#909090');
        grain(ctx, s, rng, 120, 'rgba(60,60,60,0.3)');
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = 4;
        for (let i = 1; i < 4; i++) {
          const y = (i * s) / 4;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
        }
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 14;
        ctx.strokeRect(7, 7, s - 14, s - 14);
        ctx.strokeStyle = '#d0d0d0';
        ctx.lineWidth = 12;
        ctx.beginPath(); ctx.moveTo(14, 14); ctx.lineTo(s - 14, s - 14); ctx.stroke();
      },
    });
  }

  _buildHazard() {
    this._register('hazard', {
      size: 256,
      roughness: 0.7,
      metalness: 0.2,
      normalScale: 0.4,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#e2b021');
        ctx.save();
        ctx.strokeStyle = '#1b1b1b';
        ctx.lineWidth = 26;
        for (let i = -s; i < s * 2; i += 52) {
          ctx.beginPath(); ctx.moveTo(i, -10); ctx.lineTo(i + s, s + 10); ctx.stroke();
        }
        ctx.restore();
        speckle(ctx, s, rng, 1600, ['rgba(0,0,0,0.16)', 'rgba(255,255,255,0.06)'], 0.7, 2);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 1600, ['#6d6d6d', '#949494'], 0.7, 2);
      },
    });

    // Explosive barrel skin — red with a warning triangle.
    this._register('explosiveBarrel', {
      size: 256,
      roughness: 0.55,
      metalness: 0.6,
      normalScale: 1.0,
      color: 0xff6a55,
      emissive: 0x330000,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#b5301f');
        for (let y = 0; y < s; y += 8) {
          ctx.fillStyle = y % 16 === 0 ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.05)';
          ctx.fillRect(0, y, s, 4);
        }
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillRect(0, s * 0.36, s, s * 0.06);
        ctx.fillRect(0, s * 0.58, s, s * 0.06);
        // hazard triangle
        ctx.fillStyle = '#f5d21e';
        ctx.beginPath();
        ctx.moveTo(s / 2, s * 0.44);
        ctx.lineTo(s / 2 + 26, s * 0.56);
        ctx.lineTo(s / 2 - 26, s * 0.56);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#191919';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('!', s / 2, s * 0.545);
        blotches(ctx, s, rng, 16, 'rgba(60,30,20,0.25)', 4, 18);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#808080');
        for (let y = 0; y < s; y += 8) {
          ctx.fillStyle = y % 16 === 0 ? '#606060' : '#a0a0a0';
          ctx.fillRect(0, y, s, 4);
        }
      },
    });

    this._register('barrelBlue', {
      size: 256,
      roughness: 0.6,
      metalness: 0.5,
      normalScale: 1.0,
      color: 0x6fa8d6,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#2f5f86');
        for (let y = 0; y < s; y += 8) {
          ctx.fillStyle = y % 16 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.05)';
          ctx.fillRect(0, y, s, 4);
        }
        ctx.fillStyle = 'rgba(10,20,28,0.7)';
        ctx.fillRect(0, s * 0.34, s, s * 0.05);
        ctx.fillRect(0, s * 0.61, s, s * 0.05);
        blotches(ctx, s, rng, 20, 'rgba(90,60,40,0.25)', 4, 20);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#808080');
        for (let y = 0; y < s; y += 8) {
          ctx.fillStyle = y % 16 === 0 ? '#606060' : '#a0a0a0';
          ctx.fillRect(0, y, s, 4);
        }
      },
    });
  }

  _buildGlass() {
    // Dirty industrial glazing.
    //
    // Deliberately a plain MeshStandardMaterial rather than a physical
    // material with `transmission`: transmission forces three.js to re-render
    // the whole opaque scene into a separate buffer (and mipmap it) every
    // frame, which measured at 25 ms here — more than the entire frame budget.
    // Alpha blending plus a strong environment reflection is visually
    // indistinguishable for thin, grimy panes and costs nothing.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9fbcc6,
      roughness: 0.10,
      metalness: 0.1,
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
      envMapIntensity: 2.4,
      depthWrite: false,
      name: 'glass',
    });
    this.materials.set('glass', mat);

    // Window frames.
    this.materials.set(
      'frame',
      new THREE.MeshStandardMaterial({ color: 0x4a5057, roughness: 0.55, metalness: 0.7, name: 'frame' })
    );
  }


  /**
   * The OUTPOST palette — warm sandstone, terracotta and painted teal.
   *
   * Its own step, sharing nothing with the industrial set above, because that
   * is the entire point of a second map. The warehouse is grey concrete and
   * steel under a midday sun; this is sun-bleached stone late in the
   * afternoon. Reusing `concrete` and tinting it would have produced a
   * recolour of the same place rather than somewhere else.
   *
   * The teal earns its place: it is the only cool colour here, so doors,
   * shutters and railings read instantly against the stone. That is what makes
   * a symmetrical map navigable — you learn a building by its doorway.
   */
  _buildOutpost() {
    // Sun-bleached sandstone: the bulk of every wall.
    this._register('sandstone', {
      size: 256,
      roughness: 0.92,
      metalness: 0.0,
      normalScale: 0.95,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#c9a878');
        blotches(ctx, s, rng, 30, 'rgba(168, 132, 88, 0.30)', 12, 44);
        blotches(ctx, s, rng, 16, 'rgba(226, 202, 165, 0.35)', 10, 34);
        // Coursed joints — what makes stone read as masonry rather than beige.
        ctx.strokeStyle = 'rgba(120, 92, 60, 0.35)';
        ctx.lineWidth = 2;
        for (let r = 1; r < 4; r++) {
          const y = (s / 4) * r;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
          // Stagger the verticals row to row, like real coursing.
          const off = (r % 2) * (s / 8);
          for (let c = 0; c < 4; c++) {
            const x = off + (s / 4) * c;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - s / 4); ctx.stroke();
          }
        }
        speckle(ctx, s, rng, 3000, ['#b89a68', '#d8bc90', '#a98d62'], 0.8, 2.2);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        ctx.strokeStyle = '#4e4e4e';
        ctx.lineWidth = 3;
        for (let r = 1; r < 4; r++) {
          const y = (s / 4) * r;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
          const off = (r % 2) * (s / 8);
          for (let c = 0; c < 4; c++) {
            const x = off + (s / 4) * c;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - s / 4); ctx.stroke();
          }
        }
        speckle(ctx, s, rng, 2200, ['#9a9a9a', '#787878'], 0.8, 2.4);
      },
    });

    // Darker mud-brick, for lower storeys and shaded mass.
    this._register('adobe', {
      size: 256,
      roughness: 0.96,
      metalness: 0.0,
      normalScale: 0.85,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#9c7550');
        blotches(ctx, s, rng, 26, 'rgba(126, 92, 58, 0.35)', 12, 40);
        blotches(ctx, s, rng, 12, 'rgba(190, 156, 116, 0.28)', 10, 30);
        // Straw flecks — what separates mud-brick from plain brown.
        ctx.strokeStyle = 'rgba(214, 186, 130, 0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 120; i++) {
          const x = rng() * s, y = rng() * s, a = rng() * Math.PI;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
          ctx.stroke();
        }
        speckle(ctx, s, rng, 2000, ['#8a6544', '#ab8460'], 0.8, 2.0);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#828282');
        blotches(ctx, s, rng, 30, 'rgba(90,90,90,0.5)', 8, 26);
        speckle(ctx, s, rng, 2600, ['#909090', '#707070'], 0.9, 2.6);
      },
    });

    // Terracotta: roof edges, steps and planters.
    this._register('terracotta', {
      size: 256,
      roughness: 0.78,
      metalness: 0.0,
      normalScale: 0.9,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#b4633c');
        blotches(ctx, s, rng, 20, 'rgba(140, 70, 40, 0.35)', 12, 38);
        // Barrel-tile ribbing.
        for (let i = 0; i < 8; i++) {
          const x = (s / 8) * i;
          const g = ctx.createLinearGradient(x, 0, x + s / 8, 0);
          g.addColorStop(0, 'rgba(80, 36, 20, 0.28)');
          g.addColorStop(0.5, 'rgba(255, 180, 140, 0.16)');
          g.addColorStop(1, 'rgba(80, 36, 20, 0.28)');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, s / 8, s);
        }
        speckle(ctx, s, rng, 1400, ['#9d5334', '#c87550'], 0.7, 2.0);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#808080');
        for (let i = 0; i < 8; i++) {
          const x = (s / 8) * i;
          const g = ctx.createLinearGradient(x, 0, x + s / 8, 0);
          g.addColorStop(0, '#5a5a5a');
          g.addColorStop(0.5, '#c0c0c0');
          g.addColorStop(1, '#5a5a5a');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, s / 8, s);
        }
      },
    });

    // Painted teal woodwork: doors, shutters, railings, beams.
    this._register('paintedTeal', {
      size: 128,
      roughness: 0.55,
      metalness: 0.05,
      normalScale: 0.7,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#2e8b86');
        ctx.strokeStyle = 'rgba(18, 62, 60, 0.55)';
        ctx.lineWidth = 2;
        for (let i = 1; i < 6; i++) {
          const x = (s / 6) * i;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke();
        }
        // Paint worn back to the wood beneath.
        blotches(ctx, s, rng, 14, 'rgba(150, 110, 70, 0.30)', 4, 14);
        speckle(ctx, s, rng, 700, ['#37a09a', '#256e6a'], 0.6, 1.8);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#8c8c8c');
        ctx.strokeStyle = '#5a5a5a';
        ctx.lineWidth = 3;
        for (let i = 1; i < 6; i++) {
          const x = (s / 6) * i;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke();
        }
      },
    });

    // Market canopies: warm striped cloth, and the map's only strong colour.
    this._register('canopy', {
      size: 128,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#e8d5b0');
        const stripes = ['#c4552f', '#e8d5b0', '#2e8b86', '#e8d5b0'];
        for (let i = 0; i < 8; i++) {
          ctx.fillStyle = stripes[i % stripes.length];
          ctx.fillRect((s / 8) * i, 0, s / 8, s);
        }
        blotches(ctx, s, rng, 10, 'rgba(255, 244, 220, 0.28)', 8, 26);
        speckle(ctx, s, rng, 900, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.10)'], 0.6, 1.6);
      },
    });

    // Packing crates: sun-bleached and rope-bound, not the yard's plywood.
    this._register('outpostCrate', {
      size: 128,
      roughness: 0.80,
      metalness: 0.0,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#b08b57');
        ctx.strokeStyle = 'rgba(92, 66, 38, 0.75)';
        ctx.lineWidth = 5;
        ctx.strokeRect(5, 5, s - 10, s - 10);
        // Rope banding rather than the yard's steel strapping.
        ctx.strokeStyle = 'rgba(214, 190, 148, 0.85)';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(0, s * 0.32); ctx.lineTo(s, s * 0.32); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, s * 0.68); ctx.lineTo(s, s * 0.68); ctx.stroke();
        speckle(ctx, s, rng, 500, ['#9d7a4a', '#c49c66'], 0.7, 2.0);
      },
    });
  }

  /**
   * The MANOR palette — a lived-in country house, inside.
   *
   * Twenty materials, sharing nothing with either outdoor map, and the reason
   * there are twenty rather than six is that this map is INTERIOR. The
   * warehouse and the outpost are read at 30-70 m, where four masonry tones
   * carry the whole place; a house is read at 3-8 m, where every surface is
   * within arm's reach and a room built out of one grey plaster reads as a
   * corridor set rather than a kitchen.
   *
   * Two of them do navigational work and must not be quietly recoloured:
   *   - `emeraldTile` is the only saturated colour in the house, so it is what
   *     tells you at a glance that the room ahead is a bathroom, the kitchen or
   *     the guest WC. It is doing the outpost teal's job.
   *   - `brassTrim` is used ONLY on things you touch or climb — balustrade
   *     caps, glazing bars, stair rods, thresholds. A player learns within one
   *     match that brass means a route.
   *
   * `lampGlow` and `stainedGlass` are emissive because the house is SEALED.
   * A closed building lit only by a sun that cannot get in is a black box, and
   * the fix for a dark room here is a light fitting, never more ambient —
   * ambient blows out the four rooms that do have daylight.
   */
  _buildManor() {
    // Warm lime plaster: the bulk of every interior wall in the house.
    this._register('plasterCream', {
      size: 256,
      roughness: 0.95,
      metalness: 0.0,
      normalScale: 0.45,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#e8dfd0');
        blotches(ctx, s, rng, 26, 'rgba(206, 192, 170, 0.30)', 14, 48);
        blotches(ctx, s, rng, 14, 'rgba(250, 246, 238, 0.40)', 12, 38);
        // Trowel drag. Without it a flat cream fill reads as painted card.
        ctx.strokeStyle = 'rgba(198, 184, 162, 0.22)';
        for (let i = 0; i < 40; i++) {
          const y = rng() * s;
          ctx.lineWidth = 1 + rng() * 3;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(s, y + (rng() - 0.5) * 10);
          ctx.stroke();
        }
        speckle(ctx, s, rng, 1200, ['#ded4c4', '#f2ece0'], 0.6, 1.8);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#858585');
        blotches(ctx, s, rng, 30, 'rgba(120,120,120,0.35)', 10, 34);
        speckle(ctx, s, rng, 1600, ['#8e8e8e', '#7c7c7c'], 0.6, 1.8);
      },
    });

    /*
     * Floral wallpaper — the single material that proves this is not a grey
     * box, and the one that makes a bedroom read as a bedroom from the doorway.
     */
    this._register('wallpaperRose', {
      size: 128,
      roughness: 0.88,
      metalness: 0.0,
      normalScale: 0.30,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#d8c3c0');
        // Faint vertical stripe under the print, as papers of this era have.
        ctx.fillStyle = 'rgba(226, 210, 206, 0.55)';
        for (let i = 0; i < 8; i += 2) ctx.fillRect((s / 8) * i, 0, s / 8, s);
        // A small repeat on a half-drop grid: four rosettes and their leaves.
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < 4; gx++) {
            const cx = (s / 4) * (gx + 0.5) + (gy % 2 ? s / 8 : 0);
            const cy = (s / 4) * (gy + 0.5);
            ctx.fillStyle = 'rgba(150, 96, 104, 0.55)';
            for (let p = 0; p < 5; p++) {
              const a = (p / 5) * Math.PI * 2;
              ctx.beginPath();
              ctx.ellipse(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4, 3.4, 2.4, a, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.fillStyle = 'rgba(112, 130, 100, 0.55)';
            ctx.beginPath();
            ctx.ellipse(cx - 8, cy + 7, 5, 2.2, -0.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(cx + 8, cy + 7, 5, 2.2, 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        blotches(ctx, s, rng, 8, 'rgba(180, 160, 150, 0.18)', 8, 24);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#888888');
        speckle(ctx, s, rng, 900, ['#8e8e8e', '#828282'], 0.5, 1.4);
      },
    });

    // Wide oak boards: the reception rooms and the whole first floor.
    this._register('oakFloor', {
      size: 256,
      roughness: 0.62,
      metalness: 0.0,
      normalScale: 0.7,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#9c6f42');
        // Four boards across, with the joints staggered end to end.
        for (let i = 0; i < 4; i++) {
          const y = (s / 4) * i;
          ctx.fillStyle = ['#a4764a', '#94693c', '#a87c50', '#8f6438'][i];
          ctx.fillRect(0, y, s, s / 4);
          ctx.strokeStyle = 'rgba(58, 36, 18, 0.75)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
          const jx = ((i * 97) % s);
          ctx.beginPath(); ctx.moveTo(jx, y); ctx.lineTo(jx, y + s / 4); ctx.stroke();
        }
        grain(ctx, s, rng, 90, 'rgba(70, 44, 22, 0.30)');
        speckle(ctx, s, rng, 700, ['#8a5f36', '#b0855a'], 0.6, 2.0);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8c8c8c');
        ctx.strokeStyle = '#4a4a4a';
        ctx.lineWidth = 3;
        for (let i = 0; i < 4; i++) {
          const y = (s / 4) * i;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
        }
        grain(ctx, s, rng, 60, 'rgba(110,110,110,0.5)');
      },
    });

    /*
     * Pale dusty attic boarding, laid with gaps.
     *
     * Deliberately the loudest change of floor in the house: you know you have
     * reached the top storey the instant you step on it, without looking down.
     */
    this._register('atticBoard', {
      size: 256,
      roughness: 0.94,
      metalness: 0.0,
      normalScale: 0.9,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#c3ab86');
        for (let i = 0; i < 5; i++) {
          const y = (s / 5) * i;
          ctx.fillStyle = ['#c8b08c', '#bda481', '#cbb590', '#b89e79', '#c5ad88'][i];
          ctx.fillRect(0, y, s, s / 5);
          // The gap between boards — daylight from the storey below.
          ctx.fillStyle = 'rgba(40, 28, 16, 0.65)';
          ctx.fillRect(0, y, s, 3);
        }
        grain(ctx, s, rng, 70, 'rgba(96, 70, 42, 0.28)');
        blotches(ctx, s, rng, 12, 'rgba(150, 130, 100, 0.25)', 8, 26);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#909090');
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = '#3c3c3c';
          ctx.fillRect(0, (s / 5) * i, s, 4);
        }
        grain(ctx, s, rng, 50, 'rgba(120,120,120,0.5)');
      },
    });

    // Dark oiled joinery: doors, skirtings, balustrades, bookcases, the piano.
    this._register('walnut', {
      size: 256,
      roughness: 0.42,
      metalness: 0.0,
      normalScale: 0.55,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#4e3320');
        grain(ctx, s, rng, 130, 'rgba(28, 16, 8, 0.40)');
        grain(ctx, s, rng, 50, 'rgba(120, 82, 48, 0.30)');
        // Panel moulding, so a door reads as a door and not a brown slab.
        ctx.strokeStyle = 'rgba(24, 14, 6, 0.6)';
        ctx.lineWidth = 4;
        ctx.strokeRect(s * 0.14, s * 0.10, s * 0.72, s * 0.34);
        ctx.strokeRect(s * 0.14, s * 0.56, s * 0.72, s * 0.34);
        speckle(ctx, s, rng, 500, ['#452c1b', '#5c3d26'], 0.6, 1.8);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        ctx.strokeStyle = '#565656';
        ctx.lineWidth = 5;
        ctx.strokeRect(s * 0.14, s * 0.10, s * 0.72, s * 0.34);
        ctx.strokeRect(s * 0.14, s * 0.56, s * 0.72, s * 0.34);
        grain(ctx, s, rng, 60, 'rgba(110,110,110,0.45)');
      },
    });

    // Black-and-white chequer: the entrance hall, the stair hall, the baths.
    this._register('marbleChequer', {
      size: 256,
      roughness: 0.28,
      metalness: 0.02,
      normalScale: 0.25,
      paintColor: (ctx, s, rng) => {
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < 4; gx++) {
            ctx.fillStyle = (gx + gy) % 2 ? '#2b2b30' : '#ddd8d0';
            ctx.fillRect((s / 4) * gx, (s / 4) * gy, s / 4, s / 4);
          }
        }
        // Veining, drawn across the joints so it does not read as printed tile.
        ctx.strokeStyle = 'rgba(140, 140, 148, 0.35)';
        for (let i = 0; i < 26; i++) {
          ctx.lineWidth = 0.6 + rng() * 1.6;
          let x = rng() * s, y = rng() * s;
          ctx.beginPath(); ctx.moveTo(x, y);
          for (let k = 0; k < 5; k++) {
            x += (rng() - 0.5) * 30; y += (rng() - 0.5) * 30;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(90, 88, 92, 0.5)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i <= 4; i++) {
          const p = (s / 4) * i;
          ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
        }
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#909090');
        ctx.strokeStyle = '#4a4a4a';
        ctx.lineWidth = 3;
        for (let i = 0; i <= 4; i++) {
          const p = (s / 4) * i;
          ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
        }
      },
    });

    // Deep green 100 mm glazed tile — the map's signature colour. See the note
    // above: this is the wayfinding material, not decoration.
    this._register('emeraldTile', {
      size: 128,
      roughness: 0.18,
      metalness: 0.04,
      normalScale: 0.6,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#1d4f3c');
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < 4; gx++) {
            const shade = ['#2f6d55', '#28604a', '#357760', '#2b6650'][(gx + gy * 3) % 4];
            ctx.fillStyle = shade;
            ctx.fillRect((s / 4) * gx + 2, (s / 4) * gy + 2, s / 4 - 4, s / 4 - 4);
            // Glaze highlight in the top-left of each tile.
            const g = ctx.createLinearGradient(
              (s / 4) * gx, (s / 4) * gy, (s / 4) * (gx + 1), (s / 4) * (gy + 1));
            g.addColorStop(0, 'rgba(190, 240, 220, 0.30)');
            g.addColorStop(0.5, 'rgba(255,255,255,0.03)');
            g.addColorStop(1, 'rgba(0, 30, 20, 0.22)');
            ctx.fillStyle = g;
            ctx.fillRect((s / 4) * gx + 2, (s / 4) * gy + 2, s / 4 - 4, s / 4 - 4);
          }
        }
        speckle(ctx, s, rng, 240, ['rgba(255,255,255,0.08)'], 0.5, 1.4);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#3a3a3a');
        ctx.fillStyle = '#c8c8c8';
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < 4; gx++) {
            ctx.fillRect((s / 4) * gx + 3, (s / 4) * gy + 3, s / 4 - 6, s / 4 - 6);
          }
        }
      },
    });

    // Warm red-brown brick: the conservatory piers, the arch screen, and the
    // chimney breast that repeats at the same x,z on all three floors.
    this._register('manorBrick', {
      size: 256,
      roughness: 0.90,
      metalness: 0.0,
      normalScale: 1.0,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#c8c0b0');   // lime mortar shows between the bricks
        const rows = 8, cols = 4;
        const bh = s / rows, bw = s / cols;
        for (let r = 0; r < rows; r++) {
          const off = (r % 2) * (bw / 2);
          for (let c = -1; c < cols; c++) {
            const x = off + bw * c;
            ctx.fillStyle = ['#8c4a33', '#7d4029', '#96543c', '#834530', '#a05c42'][
              ((r * 7 + c * 3) % 5 + 5) % 5];
            ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
          }
        }
        blotches(ctx, s, rng, 14, 'rgba(60, 30, 20, 0.22)', 8, 28);
        speckle(ctx, s, rng, 1400, ['#7a3f2b', '#a4614a'], 0.6, 2.0);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#4c4c4c');
        const rows = 8, cols = 4;
        const bh = s / rows, bw = s / cols;
        ctx.fillStyle = '#c4c4c4';
        for (let r = 0; r < rows; r++) {
          const off = (r % 2) * (bw / 2);
          for (let c = -1; c < cols; c++) {
            ctx.fillRect(off + bw * c + 3, r * bh + 3, bw - 6, bh - 6);
          }
        }
      },
    });

    // Pale cut stone: garden steps, sills, thresholds, hearths.
    this._register('limestone', {
      size: 256,
      roughness: 0.88,
      metalness: 0.0,
      normalScale: 0.6,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#cfc6b2');
        blotches(ctx, s, rng, 22, 'rgba(174, 165, 146, 0.30)', 12, 40);
        blotches(ctx, s, rng, 10, 'rgba(232, 226, 212, 0.35)', 10, 30);
        ctx.strokeStyle = 'rgba(140, 132, 114, 0.40)';
        ctx.lineWidth = 2;
        for (let r = 1; r < 3; r++) {
          const y = (s / 3) * r;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
        }
        speckle(ctx, s, rng, 2000, ['#c2b9a4', '#dbd3c0'], 0.6, 1.8);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        ctx.strokeStyle = '#5a5a5a';
        ctx.lineWidth = 3;
        for (let r = 1; r < 3; r++) {
          const y = (s / 3) * r;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
        }
        speckle(ctx, s, rng, 2200, ['#949494', '#7e7e7e'], 0.7, 2.2);
      },
    });

    // Brass. Metallic and smooth so it catches the dawn — which is the point:
    // it marks every route, and a route you can see from across a room is one
    // you can plan around.
    this._register('brassTrim', {
      size: 128,
      roughness: 0.24,
      metalness: 0.88,
      normalScale: 0.4,
      envMapIntensity: 1.6,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#b08a3c');
        brushed(ctx, s, rng, 160, 'rgba(232, 200, 130, 0.55)', 'rgba(110, 82, 30, 0.45)');
        blotches(ctx, s, rng, 8, 'rgba(80, 66, 30, 0.25)', 4, 14);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        brushed(ctx, s, rng, 120, '#9a9a9a', '#7a7a7a');
      },
    });

    // Dark stained structural timber: the attic trusses and exposed beams.
    this._register('rafterOak', {
      size: 256,
      roughness: 0.86,
      metalness: 0.0,
      normalScale: 0.85,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#3d2c1c');
        grain(ctx, s, rng, 150, 'rgba(20, 12, 6, 0.45)');
        grain(ctx, s, rng, 40, 'rgba(96, 72, 44, 0.30)');
        // Adze marks — hand-cut timber, not sawn stock.
        ctx.strokeStyle = 'rgba(18, 10, 4, 0.35)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 18; i++) {
          const y = rng() * s;
          ctx.beginPath();
          ctx.moveTo(rng() * s, y);
          ctx.lineTo(rng() * s, y + (rng() - 0.5) * 8);
          ctx.stroke();
        }
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#7e7e7e');
        grain(ctx, s, rng, 80, 'rgba(110,110,110,0.5)');
      },
    });

    // Pale soft furnishing: sofas, beds, dust sheets, the laundry heap.
    this._register('linenSoft', {
      size: 128,
      roughness: 0.98,
      metalness: 0.0,
      normalScale: 0.35,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#ddd6c6');
        blotches(ctx, s, rng, 18, 'rgba(198, 190, 176, 0.35)', 8, 26);
        // A loose weave, so it does not read as painted plaster.
        ctx.strokeStyle = 'rgba(210, 202, 188, 0.5)';
        ctx.lineWidth = 1;
        for (let i = 0; i < s; i += 4) {
          ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
        }
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#888888');
        speckle(ctx, s, rng, 1400, ['#929292', '#7e7e7e'], 0.8, 2.2);
      },
    });

    // Oxblood carpet with a woven border: stair runners, landings, rugs.
    this._register('carpetOx', {
      size: 128,
      roughness: 0.99,
      metalness: 0.0,
      normalScale: 0.5,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#6a2622');
        blotches(ctx, s, rng, 16, 'rgba(48, 16, 14, 0.35)', 8, 26);
        // The border, which is what makes a runner read as a runner.
        ctx.strokeStyle = 'rgba(196, 162, 96, 0.55)';
        ctx.lineWidth = 3;
        ctx.strokeRect(6, 6, s - 12, s - 12);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(12, 12, s - 24, s - 24);
        speckle(ctx, s, rng, 2400, ['#7a2e28', '#5a1e1a', '#8a3a30'], 0.7, 2.0);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        speckle(ctx, s, rng, 3000, ['#7a7a7a', '#9a9a9a'], 0.9, 2.6);
      },
    });

    /*
     * Architectural glazing — and unlike the warehouse's grimy `glass` this
     * one WRITES DEPTH.
     *
     * The yard has eight small panes that never overlap, so blending them
     * without depth is free. The manor stacks a conservatory wall, a pitched
     * conservatory roof, a lantern and four dormers along the same sightline,
     * and transparent surfaces without depth-write sort by object rather than
     * by pixel — the lantern drew through the roof it sits behind. Depth-write
     * plus a higher opacity is the correct trade for thick, clean glass.
     */
    this.materials.set(
      'manorGlass',
      new THREE.MeshStandardMaterial({
        color: 0xc6dbe4,
        roughness: 0.05,
        metalness: 0.08,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        envMapIntensity: 2.2,
        depthWrite: true,
        name: 'manorGlass',
      })
    );

    // Polished concrete: the garage, the utility, and every structural slab.
    this._register('screedFloor', {
      size: 256,
      roughness: 0.55,
      metalness: 0.03,
      normalScale: 0.45,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#6b6862');
        blotches(ctx, s, rng, 26, 'rgba(84, 82, 78, 0.35)', 14, 46);
        blotches(ctx, s, rng, 10, 'rgba(30, 26, 22, 0.30)', 6, 22);   // oil
        speckle(ctx, s, rng, 3000, ['#605d58', '#77746e', '#565350'], 0.7, 2.2);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#868686');
        speckle(ctx, s, rng, 2400, ['#8e8e8e', '#7c7c7c'], 0.7, 2.0);
      },
    });

    // Bare softwood treads. The service and loft stairs are the unglamorous
    // routes and they are meant to LOOK unglamorous — you should be able to
    // tell which staircase you are on from a screenshot of the step.
    this._register('pineStep', {
      size: 256,
      roughness: 0.90,
      metalness: 0.0,
      normalScale: 0.7,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#c2a170');
        grain(ctx, s, rng, 100, 'rgba(140, 104, 60, 0.30)');
        // Knots, which is most of what says "softwood" rather than "oak".
        for (let i = 0; i < 4; i++) {
          const x = rng() * s, y = rng() * s, r = 4 + rng() * 5;
          ctx.strokeStyle = 'rgba(112, 78, 40, 0.55)';
          for (let k = 0; k < 3; k++) {
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.ellipse(x, y, r - k * 1.2, (r - k * 1.2) * 0.62, 0.4, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        speckle(ctx, s, rng, 700, ['#b4935f', '#cdae80'], 0.6, 1.8);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#8a8a8a');
        grain(ctx, s, rng, 70, 'rgba(112,112,112,0.5)');
      },
    });

    // The car in the garage. Deep green automotive paint: smooth and glossy,
    // which is what makes it read as a car rather than a green crate.
    this._register('carDuco', {
      size: 128,
      roughness: 0.16,
      metalness: 0.55,
      normalScale: 0.2,
      envMapIntensity: 1.4,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#1f3a2c');
        blotches(ctx, s, rng, 8, 'rgba(60, 96, 76, 0.30)', 10, 34);
        blotches(ctx, s, rng, 6, 'rgba(10, 20, 16, 0.35)', 8, 24);
        speckle(ctx, s, rng, 300, ['rgba(255,255,255,0.05)'], 0.5, 1.2);
      },
    });

    // Blue-grey slate and lead: the roof slopes, the dormer cheeks, the
    // up-and-over garage door.
    this._register('slateRoof', {
      size: 256,
      roughness: 0.72,
      metalness: 0.10,
      normalScale: 0.9,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#3a4048');
        for (let r = 0; r < 6; r++) {
          const off = (r % 2) * (s / 8);
          for (let c = -1; c < 4; c++) {
            ctx.fillStyle = ['#454c55', '#3c434b', '#4d545e', '#404750'][(r + c + 8) % 4];
            ctx.fillRect(off + (s / 4) * c + 1, (s / 6) * r + 1, s / 4 - 2, s / 6 - 2);
          }
        }
        speckle(ctx, s, rng, 1600, ['#333941', '#525a64'], 0.6, 2.0);
      },
      paintHeight: (ctx, s) => {
        fill(ctx, s, '#5a5a5a');
        ctx.fillStyle = '#b4b4b4';
        for (let r = 0; r < 6; r++) {
          const off = (r % 2) * (s / 8);
          for (let c = -1; c < 4; c++) {
            ctx.fillRect(off + (s / 4) * c + 2, (s / 6) * r + 2, s / 4 - 4, s / 6 - 4);
          }
        }
      },
    });

    /*
     * Warm emissive amber — every pendant, sconce, chandelier, hearth, the
     * range, the TV and the fridge interior.
     *
     * This is the material that makes a sealed house playable. It is emissive
     * rather than lit because a hundred real point lights would cost the frame
     * budget several times over, and because a glowing fitting reads as the
     * source of the light in a room even when the actual illumination is
     * coming from `hemi` and `bounce`. It is exempted from shadow casting in
     * Level._flush for the obvious reason.
     */
    this._register('lampGlow', {
      size: 128,
      roughness: 0.35,
      metalness: 0.0,
      emissive: 0xffb45a,
      emissiveIntensity: 2.6,
      paintColor: (ctx, s, rng) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
        g.addColorStop(0, '#fff4d8');
        g.addColorStop(0.55, '#ffcc7a');
        g.addColorStop(1, '#e08a34');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        speckle(ctx, s, rng, 200, ['rgba(255,255,255,0.18)'], 0.6, 1.6);
      },
    });

    // The fanlight over the front door and the half-landing window. Emissive
    // for the same reason as the lamps: it has to throw its colour into the
    // hall at dawn, when there is barely any sun to transmit.
    this._register('stainedGlass', {
      size: 128,
      roughness: 0.15,
      metalness: 0.0,
      emissive: 0xff6a4a,
      emissiveIntensity: 1.3,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      paintColor: (ctx, s) => {
        fill(ctx, s, '#8c2a24');
        // Leaded quarries: red and blue, with the came between them.
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < 4; gx++) {
            ctx.fillStyle = (gx + gy) % 3 === 0 ? '#2a4a8c'
              : (gx + gy) % 3 === 1 ? '#a83028' : '#d8b040';
            ctx.fillRect((s / 4) * gx + 3, (s / 4) * gy + 3, s / 4 - 6, s / 4 - 6);
          }
        }
        ctx.strokeStyle = '#2c2c30';
        ctx.lineWidth = 3;
        for (let i = 0; i <= 4; i++) {
          const p = (s / 4) * i;
          ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
        }
      },
    });
  }

  _buildCharacterMaterials() {
    this._register('soldierFatigues', {
      size: 128,
      roughness: 0.92,
      metalness: 0.0,
      normalScale: 0.6,
      paintColor: (ctx, s, rng) => {
        fill(ctx, s, '#454e3a');
        blotches(ctx, s, rng, 26, 'rgba(38,44,32,0.75)', 6, 22);
        blotches(ctx, s, rng, 20, 'rgba(90,88,60,0.5)', 5, 18);
        blotches(ctx, s, rng, 14, 'rgba(28,30,26,0.6)', 4, 14);
      },
      paintHeight: (ctx, s, rng) => {
        fill(ctx, s, '#808080');
        speckle(ctx, s, rng, 2000, ['#707070', '#909090'], 0.6, 1.5);
      },
    });

    // Generic dark matte: a soldier's vest, a gun's furniture, a grenade body.
    // Named for what it IS rather than the first thing that used it — the
    // reverse is how `enemyFatigues` came to be quietly holding up multiplayer.
    this.materials.set(
      'darkGear',
      new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.75, metalness: 0.15, name: 'darkGear' })
    );
    this.materials.set(
      'soldierSkin',
      new THREE.MeshStandardMaterial({ color: 0xa07a5c, roughness: 0.78, metalness: 0.0, name: 'soldierSkin' })
    );
    this.materials.set(
      'soldierHelmet',
      new THREE.MeshStandardMaterial({ color: 0x3b4235, roughness: 0.6, metalness: 0.25, name: 'soldierHelmet' })
    );
    // Eye glow doubles as a cheap "is this thing alive/alerted" tell.
    this.materials.set(
      'soldierVisor',
      new THREE.MeshBasicMaterial({ color: 0xff5533, toneMapped: false, name: 'soldierVisor' })
    );

    this.materials.set(
      'pickupHealth',
      new THREE.MeshStandardMaterial({
        color: 0x2fbf5f, emissive: 0x0e7a34, emissiveIntensity: 1.2,
        roughness: 0.35, metalness: 0.2, name: 'pickupHealth',
      })
    );
    this.materials.set(
      'pickupAmmo',
      new THREE.MeshStandardMaterial({
        color: 0x3a8fbf, emissive: 0x0d5c86, emissiveIntensity: 1.2,
        roughness: 0.35, metalness: 0.3, name: 'pickupAmmo',
      })
    );
    this.materials.set(
      'pickupArmor',
      new THREE.MeshStandardMaterial({
        color: 0xc9d3da, emissive: 0x33506b, emissiveIntensity: 0.9,
        roughness: 0.3, metalness: 0.6, name: 'pickupArmor',
      })
    );
    this.materials.set(
      'lightPanel',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xfff0d0, emissiveIntensity: 2.4,
        roughness: 0.4, metalness: 0.0, name: 'lightPanel',
      })
    );
  }

  _buildSprites() {
    // Radial glow — muzzle flash core, explosion core, light halos.
    this.textures.set('glow', this._spriteTexture('glow', 128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0.0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,236,170,0.85)');
      g.addColorStop(0.55, 'rgba(255,150,50,0.32)');
      g.addColorStop(1.0, 'rgba(255,120,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }));

    // Star-shaped muzzle flash.
    this.textures.set('flash', this._spriteTexture('flash', 128, (ctx, s) => {
      const cx = s / 2, cy = s / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.28);
      g.addColorStop(0, 'rgba(255,255,240,1)');
      g.addColorStop(0.5, 'rgba(255,214,120,0.75)');
      g.addColorStop(1, 'rgba(255,150,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.28, 0, 7); ctx.fill();

      ctx.translate(cx, cy);
      for (let i = 0; i < 6; i++) {
        ctx.rotate((Math.PI * 2) / 6);
        const len = i % 2 === 0 ? s * 0.48 : s * 0.3;
        const lg = ctx.createLinearGradient(0, 0, len, 0);
        lg.addColorStop(0, 'rgba(255,240,190,0.95)');
        lg.addColorStop(1, 'rgba(255,140,30,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.045);
        ctx.lineTo(len, 0);
        ctx.lineTo(0, s * 0.045);
        ctx.closePath();
        ctx.fill();
      }
    }));

    // Soft smoke puff.
    this.textures.set('smoke', this._spriteTexture('smoke', 128, (ctx, s) => {
      const rng = makeRng(99);
      for (let i = 0; i < 26; i++) {
        const r = 12 + rng() * 26;
        const x = s / 2 + (rng() - 0.5) * 46;
        const y = s / 2 + (rng() - 0.5) * 46;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.22)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
    }));

    // Bullet hole: dark pit + radial cracks + dusty rim.
    this.textures.set('bulletHole', this._spriteTexture('bulletHole', 128, (ctx, s) => {
      const rng = makeRng(7);
      const cx = s / 2, cy = s / 2;
      const rim = ctx.createRadialGradient(cx, cy, s * 0.06, cx, cy, s * 0.46);
      rim.addColorStop(0, 'rgba(20,18,16,1)');
      rim.addColorStop(0.32, 'rgba(46,42,38,0.6)');
      rim.addColorStop(0.62, 'rgba(120,114,105,0.2)');
      rim.addColorStop(1, 'rgba(140,134,126,0)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, s, s);

      ctx.strokeStyle = 'rgba(24,22,20,0.75)';
      for (let i = 0; i < 12; i++) {
        const a = rng() * Math.PI * 2;
        const len = s * (0.14 + rng() * 0.3);
        ctx.lineWidth = 1 + rng() * 1.6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * s * 0.07, cy + Math.sin(a) * s * 0.07);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(8,8,8,1)';
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.09, 0, 7); ctx.fill();
    }));

    // Blood splat decal.
    this.textures.set('bloodSplat', this._spriteTexture('bloodSplat', 128, (ctx, s) => {
      const rng = makeRng(31);
      const cx = s / 2, cy = s / 2;
      for (let i = 0; i < 16; i++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * s * 0.34;
        const r = 4 + rng() * 15;
        const g = ctx.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0,
          cx + Math.cos(a) * d, cy + Math.sin(a) * d, r);
        g.addColorStop(0, 'rgba(120,10,10,0.9)');
        g.addColorStop(1, 'rgba(90,6,6,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, 7); ctx.fill();
      }
    }));

    // Soft round particle used for sparks and dust.
    this.textures.set('spark', this._spriteTexture('spark', 64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,230,160,0.6)');
      g.addColorStop(1, 'rgba(255,180,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }));
  }

  _spriteTexture(key, size, paint) {
    const canvas = makeCanvas(size);
    paint(canvas.getContext('2d'), size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(4, this.maxAnisotropy);
    tex.needsUpdate = true;
    this.textures.set(key, tex);
    return tex;
  }

  /**
   * Optional: try to upgrade a material with real texture files. Any failure
   * (404, CORS, decode error) is logged and the procedural texture is kept.
   * @param {string} materialName
   * @param {{map?:string, normalMap?:string, roughnessMap?:string}} urls
   */
  async tryLoadExternal(materialName, urls) {
    const mat = this.materials.get(materialName);
    if (!mat) return false;
    const loader = new THREE.TextureLoader();
    const load = (url) =>
      new Promise((resolve) => {
        loader.load(url, resolve, undefined, () => {
          console.warn(`[AssetManager] Optional texture "${url}" not found — keeping procedural.`);
          resolve(null);
        });
      });

    let changed = false;
    for (const [slot, url] of Object.entries(urls)) {
      const tex = await load(url);
      if (!tex) continue;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = Math.min(8, this.maxAnisotropy);
      if (slot === 'map') tex.colorSpace = THREE.SRGBColorSpace;
      mat[slot]?.dispose?.();
      mat[slot] = tex;
      changed = true;
    }
    if (changed) mat.needsUpdate = true;
    return changed;
  }

  dispose() {
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    for (const geo of this._geometries) geo.dispose();
    for (const scene of this.models.values()) {
      scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m?.dispose();
      });
    }
    this.models.clear();
    this.textures.clear();
    this.materials.clear();
    this._geometries.length = 0;
  }
}

/* ------------------------------------------------------------------ canvas
   Small painting primitives shared by the material builders. */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function fill(ctx, s, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, s, s);
}

function speckle(ctx, s, rng, count, colors, minR, maxR) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rng() * colors.length) | 0];
    const r = minR + rng() * (maxR - minR);
    ctx.fillRect(rng() * s, rng() * s, r, r);
  }
}

function blotches(ctx, s, rng, count, color, minR, maxR) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rng() * s;
    const y = rng() * s;
    const r = minR + rng() * (maxR - minR);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + rng()), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

function brushed(ctx, s, rng, count, light, dark) {
  for (let i = 0; i < count; i++) {
    ctx.strokeStyle = rng() < 0.5 ? light : dark;
    ctx.lineWidth = rng() < 0.8 ? 1 : 2;
    const y = rng() * s;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y + (rng() - 0.5) * 3);
    ctx.stroke();
  }
}

function grain(ctx, s, rng, count, color) {
  ctx.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    const y = rng() * s;
    const amp = 2 + rng() * 7;
    ctx.lineWidth = 0.6 + rng() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= s; x += 16) {
      ctx.lineTo(x, y + Math.sin((x / s) * Math.PI * (1 + rng() * 2)) * amp);
    }
    ctx.stroke();
  }
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

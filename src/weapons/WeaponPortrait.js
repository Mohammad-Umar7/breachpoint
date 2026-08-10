/**
 * WeaponPortrait — the photograph on a loadout card.
 *
 * WHY THE GAME TAKES ITS OWN
 * --------------------------
 * The same argument `MapThumbnail` makes for maps, and it matters more here: a
 * loadout is a comparison, and an icon standing in for a weapon compares
 * nothing. A render shows the real silhouette, the real optic, the real length
 * and the real furniture — which is most of what somebody is actually choosing
 * between — and it is a picture of the gun THIS BUILD hands you rather than an
 * asset somebody has to remember to re-export after moving a rail.
 *
 * It also cannot be wrong. A drawn icon of the AR-15 stays a drawing of the
 * AR-15 after the model is replaced; this does not.
 *
 * ONE SCENE, NOT THE GAME'S
 * -------------------------
 * Deliberately its own little studio rather than a render of the world: a
 * loadout card wants an even three-point key/fill/rim on a transparent
 * background, not whatever the map's sun happens to be doing. The background
 * really is transparent — PNG, not JPEG — because the card behind it is glass
 * and a black rectangle would sit on top of the blur.
 *
 * Cached in localStorage and keyed by build, exactly as the map photographs
 * are, so this costs a few milliseconds once per weapon per browser.
 */

import * as THREE from 'three';

const WIDTH = 560;
const HEIGHT = 300;

/** Bumped with the build, so a re-modelled weapon is re-photographed. */
const VERSION = (typeof __ASSET_VERSION__ !== 'undefined' && __ASSET_VERSION__) || 'dev';
const keyFor = (id) => `breachpoint.gun.${VERSION}.${id}`;

/** In-memory cache, so a re-render of the list does not touch storage at all. */
const memo = new Map();

/** The stored photograph for a weapon, or null if it has never been taken. */
export function getPortrait(weaponId) {
  if (memo.has(weaponId)) return memo.get(weaponId);
  try {
    const url = localStorage.getItem(keyFor(weaponId));
    if (url) memo.set(weaponId, url);
    return url;
  } catch {
    // Private browsing can refuse storage. A missing photo is cosmetic — the
    // card falls back to the weapon's silhouette.
    return null;
  }
}

/**
 * A small studio: key, fill, rim, and nothing else.
 *
 * Rebuilt per capture rather than kept around. Twelve weapons photographed once
 * per browser is not worth holding three lights and a scene alive for the rest
 * of the session.
 */
function buildStudio() {
  const scene = new THREE.Scene();
  // Key, high and to the camera's left — this is what shapes the barrel.
  const key = new THREE.DirectionalLight(0xffffff, 3.1);
  key.position.set(-4, 5, 6);
  scene.add(key);
  // Fill from the opposite side, weak, so the shadow side is readable rather
  // than black. Cards are read at a glance; an unlit half is a lost half.
  const fill = new THREE.DirectionalLight(0xbfd8ff, 0.85);
  fill.position.set(5, 1.5, 3);
  scene.add(fill);
  // Rim from behind, which is what separates a dark weapon from a dark card.
  const rim = new THREE.DirectionalLight(0x99e6ff, 2.2);
  rim.position.set(2, 3, -6);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  return scene;
}

/**
 * Render one weapon model into a transparent PNG.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} model the authored view model, cloned before use
 * @returns {string|null} a PNG data URL, or null if anything went wrong
 */
export function capturePortrait(renderer, model) {
  if (!renderer || !model) return null;

  let rt = null;
  const previousTarget = renderer.getRenderTarget();
  const previousAlpha = renderer.getClearAlpha();
  try {
    const scene = buildStudio();
    const gun = model.clone(true);

    /*
     * Back onto layer 0 and out of the view-model's.
     *
     * These are first-person models: they live on the weapon layer so the world
     * camera cannot see them. A studio camera is a world camera, so a portrait
     * of a weapon left on its own layer is a photograph of nothing.
     */
    gun.traverse((o) => {
      o.layers.set(0);
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
    });
    gun.position.set(0, 0, 0);
    gun.rotation.set(0, 0, 0);
    gun.scale.set(1, 1, 1);
    scene.add(gun);

    /*
     * Frame it from its OWN bounding box rather than a fixed distance.
     *
     * The arsenal runs from a 0.33 m knife to a 1.24 m sniper rifle. One
     * camera distance for all of them either crops the rifle or leaves the
     * knife as a speck, and both look like a mistake on a card meant for
     * comparison.
     */
    const box = new THREE.Box3().setFromObject(gun);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    gun.position.sub(centre);                       // origin at the gun's middle

    // Three-quarter view: along the barrel is a line, square-on is a plank.
    gun.rotation.y = -Math.PI * 0.30;
    gun.rotation.x = Math.PI * 0.045;

    const camera = new THREE.PerspectiveCamera(32, WIDTH / HEIGHT, 0.01, 100);
    // The longest axis decides the distance, with headroom for the rotation
    // above swinging a corner towards the lens.
    const reach = Math.max(size.x, size.y, size.z);
    const fitH = (reach / 2) / Math.tan((camera.fov * Math.PI) / 360);
    const fitW = fitH / camera.aspect;
    camera.position.set(0, 0.06 * reach, Math.max(fitH, fitW) * 1.32);
    camera.lookAt(0, 0, 0);
    camera.layers.set(0);

    rt = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { colorSpace: THREE.SRGBColorSpace });
    renderer.setRenderTarget(rt);
    renderer.setClearAlpha(0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, WIDTH, HEIGHT, pixels);

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(WIDTH, HEIGHT);
    // readRenderTargetPixels returns rows bottom-up; a canvas wants top-down.
    for (let y = 0; y < HEIGHT; y++) {
      const from = (HEIGHT - 1 - y) * WIDTH * 4;
      image.data.set(pixels.subarray(from, from + WIDTH * 4), y * WIDTH * 4);
    }
    ctx.putImageData(image, 0, 0);
    // PNG, not JPEG: the card behind this is frosted glass and JPEG has no
    // alpha, so the weapon would arrive glued to a black rectangle.
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[WeaponPortrait] capture failed; the card keeps its silhouette.', err);
    return null;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setClearAlpha(previousAlpha);
  }
}

/**
 * Photograph every weapon that has never been photographed.
 *
 * Called once the models are loaded. Weapons whose model is missing are simply
 * skipped — the AR-15's glTF is already optional (the rifle falls back to a
 * procedural build), so a portrait has to be optional for the same reason.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {{getModel: (id: string) => THREE.Object3D|null}} assets
 * @param {Array<{id: string, modelId?: string}>} defs
 */
export function ensurePortraits(renderer, assets, defs) {
  for (const def of defs) {
    if (getPortrait(def.id)) continue;
    const model = def.modelId ? assets.getModel?.(def.modelId) : null;
    if (!model) continue;
    const url = capturePortrait(renderer, model);
    if (!url) continue;
    memo.set(def.id, url);
    try {
      localStorage.setItem(keyFor(def.id), url);
      // Drop portraits from previous builds, or a long-lived browser slowly
      // fills its quota with pictures of guns that no longer look like that.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith('breachpoint.gun.') && !k.startsWith(`breachpoint.gun.${VERSION}.`)) {
          localStorage.removeItem(k);
        }
      }
    } catch {
      /* Quota or private browsing. The portrait lives in memory for this
         session only, which is still better than not having it. */
    }
  }
}

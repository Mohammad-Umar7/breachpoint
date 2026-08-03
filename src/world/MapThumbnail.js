/**
 * MapThumbnail — the photograph on a map card.
 *
 * WHY THE GAME TAKES ITS OWN
 * --------------------------
 * A drawn plan tells you the shape of a map. A render tells you the shape, the
 * materials, the light and the scale at once, which is most of what somebody is
 * actually choosing between — and it cannot go stale, because it is a picture
 * of the level that this build produces rather than an asset somebody has to
 * remember to re-export after moving a wall.
 *
 * It is one render of the world layer into a small offscreen target: about five
 * milliseconds, once, the first time a map is built. The result is cached in
 * localStorage, so it happens once per map per browser and never again.
 *
 * KEYED BY MAP AND BY BUILD
 * -------------------------
 * The cache key carries the asset version, so a rebuilt game takes fresh
 * photographs rather than showing last month's layout. That is the whole reason
 * this is not a checked-in PNG: nobody has to notice.
 */

import * as THREE from 'three';

const WIDTH = 448;
const HEIGHT = 280;
const QUALITY = 0.72;

/** Bumped with the build, so a changed layout is re-photographed. */
const VERSION = (typeof __ASSET_VERSION__ !== 'undefined' && __ASSET_VERSION__) || 'dev';
const keyFor = (mapId) => `breachpoint.thumb.${VERSION}.${mapId}`;

/** The stored photograph for a map, or null if it has never been taken. */
export function getThumbnail(mapId) {
  try {
    return localStorage.getItem(keyFor(mapId));
  } catch {
    // Private browsing can refuse storage entirely. A missing photo is a
    // cosmetic loss; the card falls back to its drawn plan.
    return null;
  }
}

/**
 * Render one frame of `scene` from the map's own thumbnail camera.
 *
 * Layer 0 only — the view-model layer holds the first-person weapon, which
 * would otherwise hang across the middle of every map card.
 *
 * @returns {string|null} a JPEG data URL, or null if anything went wrong
 */
export function captureThumbnail(renderer, scene, map) {
  const cam = map.thumbCam;
  if (!renderer || !scene || !cam) return null;

  let rt = null;
  const previousTarget = renderer.getRenderTarget();
  try {
    const camera = new THREE.PerspectiveCamera(cam.fov, WIDTH / HEIGHT, 0.5, 400);
    camera.position.set(...cam.pos);
    camera.lookAt(new THREE.Vector3(...cam.look));
    camera.layers.set(0);

    rt = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { colorSpace: THREE.SRGBColorSpace });
    renderer.setRenderTarget(rt);
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
    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch (err) {
    console.warn('[Thumbnail] capture failed; the card keeps its plan.', err);
    return null;
  } finally {
    renderer.setRenderTarget(previousTarget);
    rt?.dispose();
  }
}

/** Take the photo if this map has never been photographed, and remember it. */
export function ensureThumbnail(renderer, scene, map) {
  if (getThumbnail(map.id)) return;
  const url = captureThumbnail(renderer, scene, map);
  if (!url) return;
  try {
    localStorage.setItem(keyFor(map.id), url);
    // Drop photographs from previous builds, or a long-lived browser slowly
    // fills its quota with pictures of maps that no longer look like that.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('breachpoint.thumb.') && !k.startsWith(`breachpoint.thumb.${VERSION}.`)) {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* Quota or private browsing. The photo is simply not cached. */
  }
}

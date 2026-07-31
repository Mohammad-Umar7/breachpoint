/**
 * HardwareProfile — pick a sensible quality preset for the machine, and step
 * it down if the machine turns out to disagree.
 *
 * Defaulting everyone to High is the wrong default. Most people play browser
 * games on a laptop with integrated graphics, where High means shadows, bloom,
 * antialiasing and full render scale on a GPU sharing memory with the CPU. The
 * result is a frame rate low enough to be unpleasant — and, until it was
 * fixed, low enough to make the recoil springs diverge and spin the view.
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 *   1. A guess up front from what the browser will tell us about the GPU. Cheap
 *      and instant, but the renderer string is often masked or vague.
 *   2. Measurement once running. Slower to react but it is ground truth, and it
 *      catches everything the guess missed — a hot laptop, a busy machine, a
 *      GPU nobody has heard of.
 *
 * Detection only ever applies on a first run, so a deliberate choice in the
 * settings menu is never overruled.
 */

/**
 * GPUs that cannot carry the High preset at a comfortable frame rate.
 *
 * Matched loosely on the renderer string, which is the only hardware signal a
 * browser exposes. Intel's integrated parts are the overwhelming majority of
 * laptops; the rest are older or low-power discrete parts and software
 * rasterisers. A miss here is not serious — the measured pass below catches it.
 */
const WEAK_GPU = /(intel|uhd|hd graphics|iris|mesa|swiftshader|llvmpipe|microsoft basic|adreno|mali|powervr|apple a[0-9])/i;

/** Parts that are integrated but genuinely capable — do not force these down. */
const CAPABLE_INTEGRATED = /(iris xe|arc|apple m[0-9])/i;

/**
 * Read the GPU's renderer string.
 *
 * Behind WEBGL_debug_renderer_info, which some browsers omit or mask for
 * fingerprinting reasons — hence returning null rather than pretending.
 *
 * @returns {string|null}
 */
export function gpuRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    // Release the context immediately; browsers cap how many can exist at once
    // and leaking one here could cost the game its real renderer.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Best guess at a quality preset for this machine.
 *
 * Takes its inputs as optional arguments so the decision table can be tested
 * against real renderer strings without needing a GPU to produce them.
 *
 * @param {{renderer?: string|null, cores?: number, memory?: number}} [probe]
 * @returns {{quality: 'low'|'medium'|'high', reason: string, renderer: string|null}}
 */
export function detectQuality(probe = {}) {
  const renderer = probe.renderer !== undefined ? probe.renderer : gpuRenderer();
  const cores = probe.cores ?? navigator.hardwareConcurrency ?? 4;
  const memory = probe.memory ?? navigator.deviceMemory ?? 8;

  // A software rasteriser cannot run this at any setting worth having.
  if (renderer && /(swiftshader|llvmpipe|microsoft basic)/i.test(renderer)) {
    return { quality: 'low', reason: 'software rendering', renderer };
  }
  if (cores <= 2 || memory <= 2) {
    return { quality: 'low', reason: `${cores} cores, ${memory} GB`, renderer };
  }
  if (renderer && WEAK_GPU.test(renderer) && !CAPABLE_INTEGRATED.test(renderer)) {
    return { quality: 'medium', reason: 'integrated graphics', renderer };
  }
  if (cores <= 4) {
    return { quality: 'medium', reason: `${cores} cores`, renderer };
  }
  return { quality: 'high', reason: 'discrete or unknown GPU', renderer };
}

const ORDER = ['low', 'medium', 'high', 'ultra'];

/**
 * Watches the frame rate and steps quality down if the machine is struggling.
 *
 * Deliberately conservative. It samples over several seconds, ignores the
 * opening moments while assets and shaders settle, and steps down at most
 * twice — a game that keeps quietly changing its own settings is worse than one
 * that runs a little slow. Once it drops, it never raises again in the same
 * session, because oscillating between presets is the most annoying outcome
 * available.
 */
export class PerformanceGovernor {
  /**
   * @param {import('./Settings.js').Settings} settings
   * @param {(quality: string, fps: number) => void} [onAdjust] told about drops
   */
  constructor(settings, onAdjust = null) {
    this.settings = settings;
    this.onAdjust = onAdjust;
    this.enabled = true;
    this.drops = 0;
    this._frames = 0;
    this._elapsed = 0;
    this._grace = 4;        // seconds ignored while the game settles
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (!this.enabled || this.drops >= 2) return;

    if (this._grace > 0) {
      this._grace -= dt;
      return;
    }

    // A single long frame means nothing; a sustained low average means a lot.
    this._frames++;
    this._elapsed += dt;
    if (this._elapsed < 5) return;

    const fps = this._frames / this._elapsed;
    this._frames = 0;
    this._elapsed = 0;

    if (fps >= 45) return;

    const current = this.settings.get('quality');
    const idx = ORDER.indexOf(current);
    if (idx <= 0) { this.enabled = false; return; }   // already at low

    const next = ORDER[idx - 1];
    this.settings.set('quality', next);
    this.drops++;
    this._grace = 6;        // let the new preset settle before judging again
    this.onAdjust?.(next, fps);
  }
}

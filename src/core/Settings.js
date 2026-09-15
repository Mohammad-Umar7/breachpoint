/**
 * Settings — persistent user preferences.
 *
 * Values are stored in localStorage under a single key. Systems subscribe with
 * `onChange(key, cb)` (or `onAny(cb)`) so that e.g. the renderer can rebuild
 * its post-processing chain the moment a quality option flips.
 *
 * Sensitivity note: `sensitivity` is a human-friendly 0.1 – 5.0 dial with a
 * default of 1.0. It is converted to radians-per-pixel by SensitivityManager,
 * never used raw.
 */

const STORAGE_KEY = 'breachpoint.settings.v2';

export const DEFAULT_SETTINGS = Object.freeze({
  // ---------------------------------------------------------------- mouse
  sensitivity: 1.0,          // 0.1 .. 5.0
  sensitivityX: 1.0,         // per-axis trim
  sensitivityY: 1.0,
  // Aim multipliers. 1.0 means "the crosshair crosses the screen at the same
  // speed as hip fire" — zoom compensation already handles magnification, so
  // these are taste, not correction. The scope value REPLACES the ADS value
  // while looking through a scope; they do not stack.
  adsSensitivity: 1.0,       // while aiming down sights
  scopeSensitivity: 1.4,     // while looking through a sniper scope
  // How much magnification slows the view. 1 = physically correct (a 9x scope
  // turns 9x slower); 0 = magnification is ignored entirely. Partial by
  // default because full compensation reads as sluggish in an arcade shooter.
  zoomCompensation: 0.5,
  mouseSmoothing: false,
  mouseAcceleration: false,
  invertY: false,
  aimMode: 'hold',           // 'hold' | 'toggle'
  leanMode: 'hold',          // 'hold' | 'toggle'

  // ---------------------------------------------------------------- audio
  masterVolume: 0.85,
  musicVolume: 0.45,
  sfxVolume: 0.9,
  voiceVolume: 0.8,
  menuVolume: 0.7,

  // -------------------------------------------------------------- graphics
  quality: 'high',           // low | medium | high | ultra
  fov: 85,                   // 60 .. 120
  weaponFov: 65,             // view-model camera FOV (separate from world)
  exposure: 1.0,             // scene brightness — the main glare control
  bloomStrength: 0.22,       // 0 disables the bloom pass entirely
  renderScale: 1.0,
  textureQuality: 'high',    // low | medium | high | ultra  (anisotropy)
  shadowQuality: 'medium',   // off | low | medium | high
  antialias: true,
  bloom: true,
  ssao: false,
  motionBlur: false,
  depthOfField: false,
  colorGrade: true,
  vignette: true,
  vsync: true,
  maxFps: 0,                 // 0 = unlimited (only used when vsync is off)
  particleDensity: 1.0,

  // -------------------------------------------------------------- gameplay
  /** Shown above your body to other players, and on the scoreboard. */
  playerName: '',            // empty => 'OPERATOR'
  /**
   * Which arena to play. Remembered, so PLAY goes where you last went.
   *
   * Validated on use rather than on load — an id saved by a newer build, or
   * one whose map was removed, falls back to the default instead of leaving
   * the game with nothing to build. See world/maps/index.js.
   */
  mapId: 'warehouse',
  /**
   * The mode to ASK for. Not necessarily the one being played — joining a
   * room by code puts you in that room's mode, and the room decides. Same
   * fallback rule as mapId. See net/modes.js.
   */
  modeId: 'ffa',
  loadoutPrimary: 'rifle',
  loadoutSecondary: 'pistol',
  // Scales every weapon's recoil pattern. The authored patterns are the
  // "realistic" reference; the default sits well below them so the game is
  // fun to pick up rather than something you have to train for.
  recoilScale: 0.5,
  viewBob: true,
  damageNumbers: true,
  crosshairSize: 1.0,
  screenShake: 0.8,
  showHitDirection: true,
  reticleStyle: 'auto',      // auto | duplex | mildot | german | chevron | crosshair | dot
});

/** Quality presets applied when the user picks a preset from the dropdown. */
export const QUALITY_PRESETS = Object.freeze({
  low: {
    shadowQuality: 'off',
    textureQuality: 'low',
    bloom: false,
    antialias: false,
    ssao: false,
    motionBlur: false,
    depthOfField: false,
    colorGrade: false,
    vignette: false,
    renderScale: 0.75,
    particleDensity: 0.45,
  },
  medium: {
    shadowQuality: 'low',
    textureQuality: 'medium',
    bloom: false,
    antialias: true,
    ssao: false,
    motionBlur: false,
    depthOfField: false,
    colorGrade: true,
    vignette: true,
    renderScale: 0.9,
    particleDensity: 0.75,
  },
  high: {
    shadowQuality: 'medium',
    textureQuality: 'high',
    bloom: true,
    antialias: true,
    ssao: false,
    motionBlur: false,
    // Off by default at High: depth of field costs a full extra depth pass
    // and the gain over a crisp image is marginal at this art style.
    depthOfField: false,
    colorGrade: true,
    vignette: true,
    renderScale: 1.0,
    particleDensity: 1.0,
  },
  ultra: {
    shadowQuality: 'high',
    textureQuality: 'ultra',
    bloom: true,
    antialias: true,
    ssao: true,
    motionBlur: true,
    depthOfField: true,
    colorGrade: true,
    vignette: true,
    renderScale: 1.0,
    particleDensity: 1.3,
  },
});

/** Keys governed by a quality preset — used to detect a "custom" setup. */
export const PRESET_KEYS = Object.keys(QUALITY_PRESETS.high);

/**
 * The range each numeric setting is allowed to take, matching the sliders.
 *
 * Saved values are CLAMPED to these on load. localStorage is editable by
 * anyone with dev tools and by any older build with different limits, and a
 * value outside the slider is not merely odd — a sensitivity of 0 is a mouse
 * that does nothing, a FOV of 0 is a camera that renders nothing, and neither
 * can be fixed from a settings screen the player cannot aim at.
 */
const RANGES = Object.freeze({
  sensitivity: [0.1, 5], sensitivityX: [0.5, 1.5], sensitivityY: [0.5, 1.5],
  adsSensitivity: [0.2, 2], scopeSensitivity: [0.2, 4], zoomCompensation: [0, 1],
  masterVolume: [0, 1], musicVolume: [0, 1], sfxVolume: [0, 1],
  voiceVolume: [0, 1], menuVolume: [0, 1],
  fov: [60, 120], weaponFov: [45, 95], exposure: [0.5, 1.6], bloomStrength: [0, 1],
  renderScale: [0.5, 1], maxFps: [0, 240], particleDensity: [0.2, 1.5],
  recoilScale: [0, 1.5], crosshairSize: [0.5, 2], screenShake: [0, 2],
});

/** Settings that are one of a fixed set of words. Anything else is dropped. */
const CHOICES = Object.freeze({
  quality: Object.keys(QUALITY_PRESETS),
  textureQuality: ['low', 'medium', 'high', 'ultra'],
  shadowQuality: ['off', 'low', 'medium', 'high'],
  aimMode: ['hold', 'toggle'],
  leanMode: ['hold', 'toggle'],
});

/**
 * A saved value made safe to use, or undefined if it cannot be.
 *
 * Exported for the test; nothing else needs it.
 */
export function sanitizeSetting(key, value) {
  const fallback = DEFAULT_SETTINGS[key];
  if (value === undefined || typeof value !== typeof fallback) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const range = RANGES[key];
    return range ? Math.min(range[1], Math.max(range[0], value)) : value;
  }
  if (CHOICES[key] && !CHOICES[key].includes(value)) return undefined;
  return value;
}

export class Settings {
  constructor() {
    this.values = { ...DEFAULT_SETTINGS };
    this._listeners = new Map(); // key -> Set<cb>
    this._anyListeners = new Set();
    // Cleared by load() if anything was saved. Auto-detected quality is only
    // applied on a first run, so it can never overrule a deliberate choice.
    this._firstRun = true;
    this.load();
  }

  get(key) {
    return this.values[key];
  }

  /**
   * Set a value and notify listeners. Selecting a `quality` preset also
   * rewrites the individual video options it governs.
   */
  set(key, value, { silent = false } = {}) {
    if (this.values[key] === value) return;
    this.values[key] = value;

    if (key === 'quality' && QUALITY_PRESETS[value]) {
      for (const [k, v] of Object.entries(QUALITY_PRESETS[value])) {
        if (this.values[k] !== v) {
          this.values[k] = v;
          if (!silent) this._emit(k, v);
        }
      }
    }

    if (!silent) this._emit(key, value);
    this.save();
  }

  /** True when the individual video options still match the chosen preset. */
  matchesPreset() {
    const preset = QUALITY_PRESETS[this.values.quality];
    if (!preset) return false;
    return Object.entries(preset).every(([k, v]) => this.values[k] === v);
  }

  /** Replace every stored value with the shipped defaults. */
  resetToDefaults() {
    const changed = [];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (this.values[k] !== v) {
        this.values[k] = v;
        changed.push(k);
      }
    }
    this.save();
    for (const k of changed) this._emit(k, this.values[k]);
  }

  /** Reset just one section (used by the per-tab reset buttons). */
  resetSection(keys) {
    const changed = [];
    for (const k of keys) {
      if (this.values[k] !== DEFAULT_SETTINGS[k]) {
        this.values[k] = DEFAULT_SETTINGS[k];
        changed.push(k);
      }
    }
    this.save();
    for (const k of changed) this._emit(k, this.values[k]);
  }

  onChange(key, cb) {
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(cb);
    return () => this._listeners.get(key)?.delete(cb);
  }

  onAny(cb) {
    this._anyListeners.add(cb);
    return () => this._anyListeners.delete(cb);
  }

  _emit(key, value) {
    const set = this._listeners.get(key);
    if (set) for (const cb of set) safeCall(cb, value, key);
    for (const cb of this._anyListeners) safeCall(cb, value, key);
  }

  /** True until the player has settings saved — i.e. this is their first run. */
  get isFirstRun() { return this._firstRun; }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('saved settings are not an object');
      }
      // Only a blob that actually PARSED counts as a previous run. This used
      // to be set before the parse, so a corrupt store — which is exactly the
      // case the catch below exists for — meant every default including the
      // High preset, with the hardware detection that would have corrected
      // it switched off.
      this._firstRun = false;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const value = sanitizeSetting(key, parsed[key]);
        if (value !== undefined) this.values[key] = value;
      }
    } catch (err) {
      // Corrupt or unavailable storage must never block the game booting.
      console.warn('[Settings] Could not read saved settings, using defaults.', err);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch (err) {
      console.warn('[Settings] Could not persist settings.', err);
    }
  }
}

function safeCall(cb, value, key) {
  try {
    cb(value, key);
  } catch (err) {
    console.error(`[Settings] listener for "${key}" threw:`, err);
  }
}

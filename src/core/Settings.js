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

export class Settings {
  constructor() {
    this.values = { ...DEFAULT_SETTINGS };
    this._listeners = new Map(); // key -> Set<cb>
    this._anyListeners = new Set();
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

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (parsed[key] !== undefined && typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) {
          this.values[key] = parsed[key];
        }
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

/**
 * AudioManager — 100% procedural Web Audio.
 *
 * There are no sound files in this project. Every effect is synthesised at
 * play time from noise bursts, oscillators, envelopes and filters. That keeps
 * the repo asset-free and means nothing can 404, but the API is written so
 * you can swap in real buffers later: `registerBuffer(name, audioBuffer)`
 * makes `play(name)` use the sample instead of the synth.
 *
 * Routing:  source -> [panner] -> busGain(sfx|music) -> masterGain -> out
 *
 * Positional sounds use a `PannerNode`; UI/first-person sounds are played
 * dry (no panner) so they always sit centred and loud.
 */

const MAX_VOICES = 48;

export class AudioManager {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.voices = 0;
    /** @type {Map<string, AudioBuffer>} optional real samples */
    this.buffers = new Map();
    this._noiseCache = new Map();
    this._ambience = null;
    this._muffled = false;

    this._onSettingsChange = () => this._applyVolumes();
    for (const key of ['masterVolume', 'sfxVolume', 'musicVolume', 'voiceVolume', 'menuVolume']) {
      settings.onChange(key, this._onSettingsChange);
    }
  }

  /**
   * Must be called from a user gesture (the DEPLOY button) — browsers block
   * AudioContext creation/resumption otherwise.
   */
  init() {
    if (this.ready) return true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API unavailable');
      this.ctx = new Ctor({ latencyHint: 'interactive' });

      this.master = this.ctx.createGain();
      // A gentle limiter keeps a room full of gunfire from clipping.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;

      this.sfxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.voiceBus = this.ctx.createGain();
      this.menuBus = this.ctx.createGain();

      // "Muffled" filter engaged while paused, for a nice pause feel.
      this.muffle = this.ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 22050;

      this.sfxBus.connect(this.muffle);
      this.musicBus.connect(this.muffle);
      this.voiceBus.connect(this.muffle);
      // Menu audio bypasses the muffle filter so it stays crisp while paused.
      this.menuBus.connect(this.limiter);
      this.muffle.connect(this.limiter);
      this.limiter.connect(this.master);
      this.master.connect(this.ctx.destination);

      this._applyVolumes();
      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[Audio] Disabled — could not create AudioContext:', err);
      this.enabled = false;
      return false;
    }
  }

  async resume() {
    if (!this.ready) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[Audio] resume() failed:', err);
      }
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  _applyVolumes() {
    if (!this.ready) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.get('masterVolume'), t, 0.02);
    this.sfxBus.gain.setTargetAtTime(s.get('sfxVolume'), t, 0.02);
    this.musicBus.gain.setTargetAtTime(s.get('musicVolume') * 0.9, t, 0.05);
    this.voiceBus.gain.setTargetAtTime(s.get('voiceVolume'), t, 0.02);
    this.menuBus.gain.setTargetAtTime(s.get('menuVolume'), t, 0.02);
  }

  /** Low-pass everything (used while the pause menu is up). */
  setMuffled(on) {
    if (!this.ready || this._muffled === on) return;
    this._muffled = on;
    this.muffle.frequency.setTargetAtTime(on ? 620 : 22050, this.ctx.currentTime, 0.06);
  }

  // ------------------------------------------------------------- listener
  /**
   * Sync the Web Audio listener with the camera.
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} forward
   * @param {THREE.Vector3} up
   */
  updateListener(pos, forward, up) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.01);
      l.positionY.setTargetAtTime(pos.y, t, 0.01);
      l.positionZ.setTargetAtTime(pos.z, t, 0.01);
      l.forwardX.setTargetAtTime(forward.x, t, 0.01);
      l.forwardY.setTargetAtTime(forward.y, t, 0.01);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      l.upX.setTargetAtTime(up.x, t, 0.01);
      l.upY.setTargetAtTime(up.y, t, 0.01);
      l.upZ.setTargetAtTime(up.z, t, 0.01);
    } else if (l.setPosition) {
      // Legacy Safari path
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  // ------------------------------------------------------------ plumbing
  _now() {
    return this.ctx.currentTime;
  }

  _canPlay() {
    return this.enabled && this.ready && this.ctx.state !== 'closed' && this.voices < MAX_VOICES;
  }

  /** Creates (or reuses) a white-noise buffer of the given length. */
  _noise(seconds) {
    const key = seconds.toFixed(2);
    let buf = this._noiseCache.get(key);
    if (buf) return buf;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseCache.set(key, buf);
    return buf;
  }

  /**
   * Build the destination chain for one voice.
   * @returns {{input: GainNode, out: AudioNode}}
   */
  _dest(bus, position, refDistance = 6, maxDistance = 90) {
    const g = this.ctx.createGain();
    if (position) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = refDistance;
      panner.maxDistance = maxDistance;
      panner.rolloffFactor = 1.1;
      if (panner.positionX) {
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z;
      } else if (panner.setPosition) {
        panner.setPosition(position.x, position.y, position.z);
      }
      g.connect(panner);
      panner.connect(bus);
      return { input: g, tail: panner };
    }
    g.connect(bus);
    return { input: g, tail: g };
  }

  _trackVoice(node, duration) {
    this.voices++;
    const clear = () => {
      this.voices = Math.max(0, this.voices - 1);
      try { node.disconnect(); } catch { /* already gone */ }
    };
    node.onended = clear;
    // Safety net in case `onended` never fires.
    setTimeout(clear, (duration + 0.4) * 1000);
  }

  /** Play a noise burst shaped by a filter envelope. */
  _burst(bus, position, o) {
    const {
      duration = 0.2, gain = 0.6, type = 'lowpass', freq = 2000,
      freqEnd = null, q = 1, attack = 0.001, curve = 3, refDistance = 6,
      playbackRate = 1,
    } = o;

    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(Math.max(0.06, duration));
    src.playbackRate.value = playbackRate;

    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;

    const t = this._now();
    filt.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) filt.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t + duration);

    const { input, tail } = this._dest(bus, position, refDistance);
    input.gain.setValueAtTime(0.0001, t);
    input.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    input.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filt);
    filt.connect(input);
    src.start(t);
    src.stop(t + duration + 0.02);
    this._trackVoice(tail === input ? input : tail, duration);
    return { src, filt, gain: input };
  }

  /** Play a shaped oscillator tone. */
  _tone(bus, position, o) {
    const {
      type = 'sine', freq = 220, freqEnd = null, duration = 0.2,
      gain = 0.3, attack = 0.004, refDistance = 6, detune = 0,
    } = o;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;

    const t = this._now();
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);

    const { input, tail } = this._dest(bus, position, refDistance);
    input.gain.setValueAtTime(0.0001, t);
    input.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    input.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(input);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    this._trackVoice(tail === input ? input : tail, duration);
    return { osc, gain: input };
  }

  // ------------------------------------------------------------ public API
  /** Register an optional decoded sample to override a synth sound. */
  registerBuffer(name, buffer) {
    this.buffers.set(name, buffer);
  }

  /**
   * Play a named sound.
   * @param {string} name
   * @param {{position?:{x,y,z}, volume?:number, rate?:number}} [opts]
   */
  play(name, opts = {}) {
    if (!this._canPlay()) return;
    try {
      const sample = this.buffers.get(name);
      if (sample) return this._playSample(sample, opts);
      const fn = SYNTHS[name];
      if (!fn) {
        console.warn(`[Audio] Unknown sound "${name}"`);
        return;
      }
      fn(this, opts);
    } catch (err) {
      console.warn(`[Audio] "${name}" failed:`, err);
    }
  }

  _playSample(buffer, { position = null, volume = 1, rate = 1 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const { input, tail } = this._dest(this.sfxBus, position);
    input.gain.value = volume;
    src.connect(input);
    src.start();
    this._trackVoice(tail, buffer.duration / rate);
  }

  // ------------------------------------------------------------- ambience
  /** Continuous wind + industrial drone on the music bus. */
  startAmbience() {
    if (!this.ready || this._ambience) return;
    const t = this._now();

    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = this._noise(4);
    windSrc.loop = true;

    const windFilt = this.ctx.createBiquadFilter();
    windFilt.type = 'bandpass';
    windFilt.frequency.value = 420;
    windFilt.Q.value = 0.7;

    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.05;

    // Slow LFO so the wind breathes instead of sitting flat.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 230;
    lfo.connect(lfoGain);
    lfoGain.connect(windFilt.frequency);

    const droneA = this.ctx.createOscillator();
    droneA.type = 'sawtooth';
    droneA.frequency.value = 41.2; // E1
    const droneB = this.ctx.createOscillator();
    droneB.type = 'sawtooth';
    droneB.frequency.value = 41.9;
    const droneFilt = this.ctx.createBiquadFilter();
    droneFilt.type = 'lowpass';
    droneFilt.frequency.value = 190;
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.035;

    windSrc.connect(windFilt);
    windFilt.connect(windGain);
    windGain.connect(this.musicBus);
    droneA.connect(droneFilt);
    droneB.connect(droneFilt);
    droneFilt.connect(droneGain);
    droneGain.connect(this.musicBus);

    windSrc.start(t);
    lfo.start(t);
    droneA.start(t);
    droneB.start(t);

    this._ambience = { windSrc, lfo, droneA, droneB, nodes: [windFilt, windGain, lfoGain, droneFilt, droneGain] };
  }

  stopAmbience() {
    if (!this._ambience) return;
    const a = this._ambience;
    for (const s of [a.windSrc, a.lfo, a.droneA, a.droneB]) {
      try { s.stop(); } catch { /* already stopped */ }
      try { s.disconnect(); } catch { /* noop */ }
    }
    for (const n of a.nodes) {
      try { n.disconnect(); } catch { /* noop */ }
    }
    this._ambience = null;
  }

  /** Rising tension sting used when a wave begins. */
  playWaveSting(waveIndex) {
    if (!this._canPlay()) return;
    const base = 110 * Math.pow(2, Math.min(waveIndex, 5) / 12);
    this._tone(this.musicBus, null, { type: 'sawtooth', freq: base, freqEnd: base * 1.5, duration: 1.1, gain: 0.16, attack: 0.15 });
    this._tone(this.musicBus, null, { type: 'square', freq: base * 2, freqEnd: base * 3, duration: 0.9, gain: 0.05, attack: 0.2 });
    this._burst(this.musicBus, null, { duration: 1.4, gain: 0.1, type: 'bandpass', freq: 300, freqEnd: 1800, q: 0.8, attack: 0.4 });
  }

  dispose() {
    this.stopAmbience();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.ready = false;
    this._noiseCache.clear();
    this.buffers.clear();
  }
}

/* =========================================================================
   Synth definitions. Each receives (audioManager, opts).
   Keeping them in one table makes it trivial to audition/tweak a sound.
   ========================================================================= */
const SYNTHS = {
  // ------------------------------------------------------------- weapons
  shootPistol(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.16, gain: 0.75 * volume, type: 'bandpass', freq: 2400, freqEnd: 500, q: 0.8, refDistance: 10 });
    a._burst(bus, position, { duration: 0.05, gain: 0.55 * volume, type: 'highpass', freq: 4200, refDistance: 10 });
    a._tone(bus, position, { type: 'sine', freq: 190, freqEnd: 62, duration: 0.13, gain: 0.5 * volume, refDistance: 10 });
  },

  shootRifle(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.2, gain: 0.85 * volume, type: 'bandpass', freq: 1700, freqEnd: 320, q: 0.7, refDistance: 12 });
    a._burst(bus, position, { duration: 0.045, gain: 0.7 * volume, type: 'highpass', freq: 5200, refDistance: 12 });
    a._tone(bus, position, { type: 'sine', freq: 150, freqEnd: 48, duration: 0.17, gain: 0.62 * volume, refDistance: 12 });
    // Tail: the room answering back.
    a._burst(bus, position, { duration: 0.5, gain: 0.13 * volume, type: 'lowpass', freq: 900, freqEnd: 240, attack: 0.03, refDistance: 14 });
  },

  shootShotgun(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.34, gain: 0.95 * volume, type: 'lowpass', freq: 2600, freqEnd: 220, q: 0.5, refDistance: 14 });
    a._burst(bus, position, { duration: 0.07, gain: 0.8 * volume, type: 'highpass', freq: 3200, refDistance: 14 });
    a._tone(bus, position, { type: 'sine', freq: 110, freqEnd: 34, duration: 0.3, gain: 0.85 * volume, refDistance: 14 });
    a._burst(bus, position, { duration: 0.7, gain: 0.16 * volume, type: 'lowpass', freq: 700, freqEnd: 160, attack: 0.04, refDistance: 16 });
  },

  shootMagnum(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.3, gain: 1.0 * volume, type: 'bandpass', freq: 1500, freqEnd: 260, q: 0.6, refDistance: 16 });
    a._burst(bus, position, { duration: 0.06, gain: 0.8 * volume, type: 'highpass', freq: 4600, refDistance: 16 });
    a._tone(bus, position, { type: 'sine', freq: 120, freqEnd: 36, duration: 0.26, gain: 0.95 * volume, refDistance: 16 });
    a._burst(bus, position, { duration: 0.7, gain: 0.17 * volume, type: 'lowpass', freq: 800, freqEnd: 180, attack: 0.04, refDistance: 20 });
  },

  shootBurst(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.16, gain: 0.8 * volume, type: 'bandpass', freq: 2100, freqEnd: 400, q: 0.9, refDistance: 12 });
    a._burst(bus, position, { duration: 0.035, gain: 0.65 * volume, type: 'highpass', freq: 5800, refDistance: 12 });
    a._tone(bus, position, { type: 'sine', freq: 165, freqEnd: 54, duration: 0.14, gain: 0.55 * volume, refDistance: 12 });
  },

  shootSmg(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.13, gain: 0.72 * volume, type: 'bandpass', freq: 2300, freqEnd: 520, q: 0.85, refDistance: 10 });
    a._burst(bus, position, { duration: 0.03, gain: 0.55 * volume, type: 'highpass', freq: 6000, refDistance: 10 });
    a._tone(bus, position, { type: 'sine', freq: 175, freqEnd: 62, duration: 0.11, gain: 0.42 * volume, refDistance: 10 });
  },

  shootLmg(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.24, gain: 0.9 * volume, type: 'bandpass', freq: 1400, freqEnd: 280, q: 0.6, refDistance: 15 });
    a._burst(bus, position, { duration: 0.05, gain: 0.7 * volume, type: 'highpass', freq: 4800, refDistance: 15 });
    a._tone(bus, position, { type: 'sine', freq: 128, freqEnd: 42, duration: 0.2, gain: 0.72 * volume, refDistance: 15 });
    a._burst(bus, position, { duration: 0.55, gain: 0.15 * volume, type: 'lowpass', freq: 820, freqEnd: 200, attack: 0.03, refDistance: 18 });
  },

  shootSniper(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.42, gain: 1.0 * volume, type: 'lowpass', freq: 3400, freqEnd: 180, q: 0.5, refDistance: 24 });
    a._burst(bus, position, { duration: 0.05, gain: 0.9 * volume, type: 'highpass', freq: 5200, refDistance: 24 });
    a._tone(bus, position, { type: 'sine', freq: 96, freqEnd: 28, duration: 0.38, gain: 1.0 * volume, refDistance: 24 });
    // Long crack rolling off the buildings.
    a._burst(bus, position, { duration: 1.5, gain: 0.24 * volume, type: 'lowpass', freq: 900, freqEnd: 120, attack: 0.06, refDistance: 30 });
  },

  shootMarksman(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.28, gain: 0.88 * volume, type: 'bandpass', freq: 1600, freqEnd: 300, q: 0.65, refDistance: 18 });
    a._burst(bus, position, { duration: 0.045, gain: 0.72 * volume, type: 'highpass', freq: 5000, refDistance: 18 });
    a._tone(bus, position, { type: 'sine', freq: 118, freqEnd: 40, duration: 0.24, gain: 0.8 * volume, refDistance: 18 });
    a._burst(bus, position, { duration: 0.9, gain: 0.16 * volume, type: 'lowpass', freq: 760, freqEnd: 150, attack: 0.05, refDistance: 22 });
  },

  shootEnemy(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._burst(bus, position, { duration: 0.18, gain: 0.62 * volume, type: 'bandpass', freq: 1350, freqEnd: 300, q: 0.9, refDistance: 8 });
    a._tone(bus, position, { type: 'sine', freq: 130, freqEnd: 46, duration: 0.14, gain: 0.4 * volume, refDistance: 8 });
  },

  dryFire(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.05, gain: 0.35 * volume, type: 'highpass', freq: 2600, q: 2 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 900, freqEnd: 420, duration: 0.04, gain: 0.12 * volume });
  },

  // ------------------------------------------------------------- reloads
  magOut(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.09, gain: 0.35 * volume, type: 'bandpass', freq: 1500, q: 2.5 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 320, freqEnd: 180, duration: 0.07, gain: 0.1 * volume });
  },
  magIn(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.12, gain: 0.42 * volume, type: 'bandpass', freq: 1050, q: 2 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 210, freqEnd: 120, duration: 0.1, gain: 0.13 * volume });
  },
  boltRelease(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.11, gain: 0.4 * volume, type: 'highpass', freq: 2100, q: 1.4 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 640, freqEnd: 260, duration: 0.07, gain: 0.1 * volume });
  },
  shellInsert(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.08, gain: 0.32 * volume, type: 'bandpass', freq: 1800, q: 3 });
  },
  weaponSwitch(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.1, gain: 0.28 * volume, type: 'bandpass', freq: 1300, q: 1.6 });
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 520, freqEnd: 300, duration: 0.09, gain: 0.09 * volume });
  },
  adsIn(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.07, gain: 0.16 * volume, type: 'bandpass', freq: 900, q: 2 });
  },

  /** Heavy bolt being worked: extract, eject, chamber. */
  boltCycle(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.11, gain: 0.4 * volume, type: 'bandpass', freq: 1250, q: 2.2 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 260, freqEnd: 150, duration: 0.09, gain: 0.11 * volume });
    setTimeout(() => a._canPlay() && a._burst(a.sfxBus, null, { duration: 0.13, gain: 0.42 * volume, type: 'bandpass', freq: 850, q: 1.8 }), 170);
  },

  pumpAction(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.1, gain: 0.4 * volume, type: 'bandpass', freq: 1500, q: 2.4 });
    setTimeout(() => a._canPlay() && a._burst(a.sfxBus, null, { duration: 0.12, gain: 0.44 * volume, type: 'bandpass', freq: 1000, q: 2.0 }), 130);
  },

  // ------------------------------------------------------------- optics
  scopeIn(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.16, gain: 0.16 * volume, type: 'lowpass', freq: 1400, freqEnd: 380, attack: 0.02 });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 240, freqEnd: 150, duration: 0.14, gain: 0.06 * volume });
  },
  scopeOut(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.14, gain: 0.13 * volume, type: 'lowpass', freq: 500, freqEnd: 1300, attack: 0.02 });
  },
  scopeZoom(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.09, gain: 0.22 * volume, type: 'bandpass', freq: 1900, q: 3.2 });
    a._tone(a.sfxBus, null, { type: 'square', freq: 700, freqEnd: 980, duration: 0.07, gain: 0.05 * volume });
  },
  breathIn(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.42, gain: 0.13 * volume, type: 'bandpass', freq: 620, freqEnd: 1100, q: 0.8, attack: 0.14 });
  },
  breathOut(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.55, gain: 0.16 * volume, type: 'bandpass', freq: 950, freqEnd: 380, q: 0.7, attack: 0.06 });
  },

  // -------------------------------------------------------------- melee
  knifeSwing(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.16, gain: 0.22 * volume, type: 'bandpass', freq: 900, freqEnd: 2600, q: 1.1, attack: 0.03 });
  },
  knifeHit(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.13, gain: 0.5 * volume, type: 'lowpass', freq: 1100, freqEnd: 220, refDistance: 6 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 190, freqEnd: 70, duration: 0.12, gain: 0.3 * volume, refDistance: 6 });
  },
  knifeHitWall(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.09, gain: 0.3 * volume, type: 'highpass', freq: 3200, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'triangle', freq: 2800, freqEnd: 900, duration: 0.18, gain: 0.14 * volume, refDistance: 5 });
  },

  grenadeThrow(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.2, gain: 0.2 * volume, type: 'bandpass', freq: 700, freqEnd: 1800, q: 0.9, attack: 0.04 });
    a._burst(a.sfxBus, null, { duration: 0.07, gain: 0.2 * volume, type: 'bandpass', freq: 2400, q: 3 });
  },

  // ------------------------------------------------------------- glass
  impactGlass(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.06, gain: 0.42 * volume, type: 'highpass', freq: 5200, refDistance: 6 });
    for (let i = 0; i < 4; i++) {
      const f = 2600 + Math.random() * 4200;
      a._tone(a.sfxBus, position, {
        type: 'triangle', freq: f, freqEnd: f * 0.45,
        duration: 0.18 + Math.random() * 0.25, gain: 0.1 * volume, refDistance: 6,
      });
    }
  },

  // -------------------------------------------------------------- menus
  menuHover(a, { volume = 1 } = {}) {
    a._tone(a.menuBus ?? a.sfxBus, null, { type: 'sine', freq: 880, freqEnd: 1100, duration: 0.05, gain: 0.05 * volume });
  },
  menuSelect(a, { volume = 1 } = {}) {
    a._tone(a.menuBus ?? a.sfxBus, null, { type: 'square', freq: 640, freqEnd: 960, duration: 0.08, gain: 0.08 * volume });
    a._burst(a.menuBus ?? a.sfxBus, null, { duration: 0.09, gain: 0.06 * volume, type: 'bandpass', freq: 2200, q: 2 });
  },
  menuBack(a, { volume = 1 } = {}) {
    a._tone(a.menuBus ?? a.sfxBus, null, { type: 'square', freq: 720, freqEnd: 420, duration: 0.09, gain: 0.07 * volume });
  },

  // ------------------------------------------------------------- impacts
  impactConcrete(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.12, gain: 0.5 * volume, type: 'bandpass', freq: 1500, freqEnd: 500, q: 1.1, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 220, freqEnd: 90, duration: 0.08, gain: 0.2 * volume, refDistance: 5 });
  },
  impactMetal(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.09, gain: 0.4 * volume, type: 'highpass', freq: 3000, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'triangle', freq: 2400 + Math.random() * 900, freqEnd: 700, duration: 0.22, gain: 0.22 * volume, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 3600, freqEnd: 1500, duration: 0.16, gain: 0.1 * volume, refDistance: 5 });
  },
  impactWood(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.13, gain: 0.45 * volume, type: 'lowpass', freq: 1600, freqEnd: 380, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 300, freqEnd: 120, duration: 0.1, gain: 0.2 * volume, refDistance: 5 });
  },
  impactDirt(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.16, gain: 0.4 * volume, type: 'lowpass', freq: 700, freqEnd: 180, refDistance: 5 });
  },
  impactFlesh(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.11, gain: 0.5 * volume, type: 'lowpass', freq: 900, freqEnd: 200, refDistance: 6 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 160, freqEnd: 60, duration: 0.1, gain: 0.3 * volume, refDistance: 6 });
  },
  ricochet(a, { position = null, volume = 1 } = {}) {
    const f = 1800 + Math.random() * 2200;
    a._tone(a.sfxBus, position, { type: 'sawtooth', freq: f, freqEnd: f * 0.25, duration: 0.3, gain: 0.16 * volume, refDistance: 6 });
  },

  // ---------------------------------------------------------- explosions
  explosion(a, { position = null, volume = 1 } = {}) {
    const bus = a.sfxBus;
    a._tone(bus, position, { type: 'sine', freq: 90, freqEnd: 22, duration: 0.9, gain: 1.0 * volume, refDistance: 22 });
    a._burst(bus, position, { duration: 0.55, gain: 0.9 * volume, type: 'lowpass', freq: 3200, freqEnd: 180, refDistance: 22 });
    a._burst(bus, position, { duration: 1.6, gain: 0.28 * volume, type: 'lowpass', freq: 1100, freqEnd: 90, attack: 0.08, refDistance: 26 });
    a._burst(bus, position, { duration: 0.09, gain: 0.7 * volume, type: 'highpass', freq: 4200, refDistance: 22 });
  },

  // ------------------------------------------------------------ movement
  footstepConcrete(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.075, gain: 0.2 * volume, type: 'bandpass', freq: 900 + Math.random() * 400, q: 1.2, refDistance: 4 });
  },
  footstepMetal(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.08, gain: 0.2 * volume, type: 'highpass', freq: 2200, refDistance: 4 });
    a._tone(a.sfxBus, position, { type: 'triangle', freq: 1200 + Math.random() * 600, freqEnd: 600, duration: 0.1, gain: 0.07 * volume, refDistance: 4 });
  },
  footstepWood(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.08, gain: 0.2 * volume, type: 'lowpass', freq: 1100, freqEnd: 420, refDistance: 4 });
  },
  footstepDirt(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.1, gain: 0.18 * volume, type: 'lowpass', freq: 620, freqEnd: 200, refDistance: 4 });
  },
  jump(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.1, gain: 0.13 * volume, type: 'bandpass', freq: 700, q: 0.8 });
  },
  land(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.16, gain: 0.34 * volume, type: 'lowpass', freq: 1000, freqEnd: 180, refDistance: 5 });
    a._tone(a.sfxBus, position, { type: 'sine', freq: 130, freqEnd: 50, duration: 0.14, gain: 0.25 * volume, refDistance: 5 });
  },

  // ---------------------------------------------------------------- enemy
  enemyAlert(a, { position = null, volume = 1 } = {}) {
    // Two formant-ish tones read as a distant shout without a voice sample.
    const f0 = 150 + Math.random() * 40;
    a._tone(a.sfxBus, position, { type: 'sawtooth', freq: f0, freqEnd: f0 * 1.35, duration: 0.28, gain: 0.3 * volume, refDistance: 12 });
    a._tone(a.sfxBus, position, { type: 'square', freq: 640, freqEnd: 900, duration: 0.24, gain: 0.06 * volume, refDistance: 12 });
    a._burst(a.sfxBus, position, { duration: 0.3, gain: 0.09 * volume, type: 'bandpass', freq: 1400, q: 1.5, refDistance: 12 });
  },
  enemyHurt(a, { position = null, volume = 1 } = {}) {
    const f0 = 190 + Math.random() * 70;
    a._tone(a.sfxBus, position, { type: 'sawtooth', freq: f0, freqEnd: f0 * 0.6, duration: 0.22, gain: 0.26 * volume, refDistance: 10 });
    a._burst(a.sfxBus, position, { duration: 0.16, gain: 0.1 * volume, type: 'bandpass', freq: 1100, q: 1.2, refDistance: 10 });
  },
  enemyDeath(a, { position = null, volume = 1 } = {}) {
    const f0 = 160 + Math.random() * 40;
    a._tone(a.sfxBus, position, { type: 'sawtooth', freq: f0, freqEnd: 55, duration: 0.7, gain: 0.28 * volume, refDistance: 12 });
    a._burst(a.sfxBus, position, { duration: 0.5, gain: 0.12 * volume, type: 'lowpass', freq: 1200, freqEnd: 200, refDistance: 12 });
  },
  bodyFall(a, { position = null, volume = 1 } = {}) {
    a._burst(a.sfxBus, position, { duration: 0.24, gain: 0.34 * volume, type: 'lowpass', freq: 800, freqEnd: 120, refDistance: 8 });
  },

  // ---------------------------------------------------------------- player
  playerHurt(a, { volume = 1 } = {}) {
    a._burst(a.sfxBus, null, { duration: 0.2, gain: 0.34 * volume, type: 'lowpass', freq: 700, freqEnd: 130 });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 96, freqEnd: 52, duration: 0.24, gain: 0.3 * volume });
  },
  playerDeath(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'sine', freq: 160, freqEnd: 32, duration: 1.6, gain: 0.5 * volume, attack: 0.02 });
    a._burst(a.sfxBus, null, { duration: 1.8, gain: 0.2 * volume, type: 'lowpass', freq: 900, freqEnd: 70, attack: 0.05 });
  },
  hitmarker(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'square', freq: 1500, freqEnd: 1200, duration: 0.045, gain: 0.11 * volume });
  },
  hitmarkerHead(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'square', freq: 2100, freqEnd: 1500, duration: 0.06, gain: 0.14 * volume });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 3000, freqEnd: 2200, duration: 0.05, gain: 0.08 * volume });
  },
  killConfirm(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'square', freq: 880, freqEnd: 1320, duration: 0.12, gain: 0.12 * volume });
  },
  pickupHealth(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'sine', freq: 660, duration: 0.09, gain: 0.16 * volume });
    setTimeout(() => a._canPlay() && a._tone(a.sfxBus, null, { type: 'sine', freq: 990, duration: 0.14, gain: 0.16 * volume }), 70);
  },
  pickupAmmo(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 420, duration: 0.08, gain: 0.16 * volume });
    setTimeout(() => a._canPlay() && a._tone(a.sfxBus, null, { type: 'triangle', freq: 620, duration: 0.12, gain: 0.14 * volume }), 60);
  },
  pickupArmor(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'square', freq: 520, duration: 0.07, gain: 0.11 * volume });
    setTimeout(() => a._canPlay() && a._tone(a.sfxBus, null, { type: 'square', freq: 780, duration: 0.13, gain: 0.1 * volume }), 60);
  },

  // ------------------------------------------------------------------- UI
  uiClick(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'square', freq: 720, freqEnd: 540, duration: 0.05, gain: 0.08 * volume });
  },
  waveComplete(a, { volume = 1 } = {}) {
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((f, i) =>
      setTimeout(() => a._canPlay() && a._tone(a.musicBus, null, { type: 'triangle', freq: f, duration: 0.28, gain: 0.16 * volume }), i * 110)
    );
  },
  victory(a, { volume = 1 } = {}) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) =>
      setTimeout(() => a._canPlay() && a._tone(a.musicBus, null, { type: 'triangle', freq: f, duration: 0.5, gain: 0.2 * volume }), i * 160)
    );
  },
  defeat(a, { volume = 1 } = {}) {
    const notes = [392, 349.23, 293.66, 196];
    notes.forEach((f, i) =>
      setTimeout(() => a._canPlay() && a._tone(a.musicBus, null, { type: 'sawtooth', freq: f, duration: 0.7, gain: 0.16 * volume }), i * 240)
    );
  },
};

/** Maps a surface tag to its footstep sound name. */
export function footstepSoundFor(surface) {
  switch (surface) {
    case 'metal': return 'footstepMetal';
    case 'wood': return 'footstepWood';
    case 'dirt': return 'footstepDirt';
    case 'glass': return 'footstepMetal';
    default: return 'footstepConcrete';
  }
}

/** Maps a surface tag to its bullet-impact sound name. */
export function impactSoundFor(surface) {
  switch (surface) {
    case 'metal': return 'impactMetal';
    case 'wood': return 'impactWood';
    case 'dirt': return 'impactDirt';
    case 'glass': return 'impactGlass';
    case 'flesh': return 'impactFlesh';
    default: return 'impactConcrete';
  }
}

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

// Raised from 48 when weapons gained a transient and an action layer: an LMG
// at full rate now holds roughly four more voices at once, and overshooting
// this ceiling drops whole sounds rather than degrading them.
const MAX_VOICES = 64;

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

      /**
       * Saturation on the weapon bus.
       *
       * Real gunfire is recorded far into a microphone's clipping range, and
       * that soft-clipped edge is most of what the ear reads as "loud". Pure
       * synthesised noise through a filter is clean, and clean reads as weak
       * and toy-like no matter how much gain you add. A tanh-shaped curve adds
       * the harmonics that give a shot its crack.
       */
      this.shotShaper = this.ctx.createWaveShaper();
      this.shotShaper.curve = this._saturationCurve(1.6);
      this.shotShaper.oversample = '4x';
      this.shotDrive = this.ctx.createGain();
      this.shotDrive.gain.value = 1.15;     // into the curve
      this.shotTrim = this.ctx.createGain();
      this.shotTrim.gain.value = 0.9;       // back down after it

      /**
       * Convolution reverb, fed by a send.
       *
       * This is the single biggest step towards sounding like a real space.
       * The previous "tail" was a filtered noise burst played alongside the
       * shot — it decays, but it carries no sense of the room, because every
       * shot's tail is identical regardless of where it happened. A real
       * impulse response smears the shot across a plausible set of early
       * reflections instead, which is what makes gunfire sound like it is
       * happening *in* the industrial yard rather than in a vacuum.
       *
       * The impulse is generated, not sampled, so nothing has to be shipped.
       *
       * Kept SHORT and fairly dry on purpose. An open industrial yard is not a
       * concert hall: a long wet tail on every round makes rapid fire smear
       * into continuous mush and pushes the gun away from the listener, which
       * is the opposite of what a weapon should feel like. The punch has to
       * come from the shot itself — the reverb only places it somewhere.
       */
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this._makeImpulse(0.85, 3.4, 2600);
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.085;
      this.reverbReturn = this.ctx.createGain();
      this.reverbReturn.gain.value = 0.8;

      this.shotDrive.connect(this.shotShaper);
      this.shotShaper.connect(this.shotTrim);
      this.shotTrim.connect(this.sfxBus);
      this.shotTrim.connect(this.reverbSend);
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.reverbReturn);
      this.reverbReturn.connect(this.sfxBus);

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
    // A non-finite camera transform makes setTargetAtTime throw, and this is
    // called from the middle of the frame update — so one NaN would take out
    // movement, weapons and rendering for every frame after it. Skipping the
    // update instead costs nothing: the listener simply stays where it was.
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)
      || !Number.isFinite(forward.x) || !Number.isFinite(forward.y) || !Number.isFinite(forward.z)
      || !Number.isFinite(up.x) || !Number.isFinite(up.y) || !Number.isFinite(up.z)) {
      return;
    }
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

  /**
   * tanh-shaped soft clipper for the WaveShaper.
   *
   * Soft rather than hard clipping: a hard clip generates harsh odd harmonics
   * that sound like digital breakup, whereas tanh rounds the knee and reads as
   * an overdriven microphone, which is what a gunshot recording actually is.
   */
  _saturationCurve(drive = 2.5, samples = 2048) {
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    return curve;
  }

  /**
   * Synthesise a reverb impulse response.
   *
   * Exponentially decaying noise, low-passed more heavily as it decays (high
   * frequencies are absorbed faster by real surfaces), with a handful of
   * discrete early reflections stamped in. Those early reflections are what
   * convey room SIZE — without them a decaying noise tail sounds like a
   * generic wash rather than a specific space.
   *
   * @param {number} seconds  tail length
   * @param {number} decay    higher = faster fall-off
   * @param {number} damping  starting brightness in Hz
   */
  _makeImpulse(seconds = 1.6, decay = 2.4, damping = 3800) {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = this.ctx.createBuffer(2, length, rate);

    // Early reflections: delay in ms and relative level. Spaced irregularly so
    // they do not comb-filter into an audible pitch.
    const early = [[11, 0.5], [19, 0.42], [27, 0.34], [41, 0.28], [58, 0.2], [79, 0.15]];

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        // One-pole low-pass that closes as the tail decays.
        const cutoff = Math.min(1, (damping * (1 - t * 0.85)) / (rate * 0.5));
        lp += cutoff * ((Math.random() * 2 - 1) - lp);
        data[i] = lp * env;
      }
      // Stamp the early reflections in, offset per channel for width.
      for (const [ms, level] of early) {
        const idx = Math.floor((ms + (ch ? 3.5 : 0)) * 0.001 * rate);
        if (idx < length) data[idx] += level * (ch ? -1 : 1);
      }
    }
    return buffer;
  }

  /**
   * The initial crack: a single-sample impulse, high-passed.
   *
   * A real muzzle blast rises to peak in well under a millisecond. No gain
   * envelope can do that — even the shortest exponential ramp takes several
   * milliseconds and reads as a "whump" rather than a "crack". Writing the
   * impulse straight into a buffer is the only way to get an edge that sharp.
   */
  _transient(bus, position, { gain = 0.8, freq = 1800, refDistance = 12 } = {}) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.ceil(rate * 0.012), rate);
    const d = buf.getChannelData(0);
    d[0] = 1;
    // A few samples of dense noise behind the spike, decaying fast, so it has
    // body rather than sounding like a click track.
    for (let i = 1; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filt = this.ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = freq;
    filt.Q.value = 0.7;

    const t = this._now();
    const { input, tail } = this._dest(bus, position, refDistance);
    input.gain.setValueAtTime(gain, t);
    src.connect(filt);
    filt.connect(input);
    src.start(t);
    src.stop(t + 0.03);
    this._trackVoice(tail === input ? input : tail, 0.05);
  }

  /**
   * Bolt, spring and brass — the mechanical layer.
   *
   * Two quick metallic ticks a few milliseconds apart (bolt back, bolt home)
   * over a band-passed noise scrape. Delayed behind the muzzle report because
   * that is the real order of events, and hearing them separately is what
   * makes a weapon read as a mechanism rather than a sound effect.
   */
  _mech(bus, position, { delay = 0.04, gain = 0.15, freq = 3000, refDistance = 12 } = {}) {
    const t0 = this._now() + delay;
    for (const [offset, level, f] of [[0, 1, freq], [0.026, 0.7, freq * 0.72]]) {
      const rate = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, Math.ceil(rate * 0.02), rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 9);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const filt = this.ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = f;
      filt.Q.value = 3.2;      // narrow — reads as metal, not as noise

      const t = t0 + offset;
      const { input, tail } = this._dest(bus, position, refDistance);
      input.gain.setValueAtTime(gain * level, t);
      src.connect(filt);
      filt.connect(input);
      src.start(t);
      src.stop(t + 0.05);
      this._trackVoice(tail === input ? input : tail, delay + offset + 0.08);
    }
  }

  /**
   * A complete gunshot, built the way a real one is built.
   *
   * The previous version layered three or four noise bursts of 200–500 ms.
   * That is the classic synthesised-gun mistake: a real muzzle report is
   * mostly *over* in about 60 ms, and stretching it turns a bang into a
   * "whoosh". Everything after those 60 ms should be the environment
   * answering, not the gun still going.
   *
   * So the model here is four separate physical events:
   *
   *   1. CRACK     — the pressure spike. Sub-millisecond, broadband.
   *   2. BLAST     — the muzzle report proper. Short, loud, sweeping downward
   *                  as the gas ball expands and cools.
   *   3. THUMP     — the low-frequency punch you feel in the chest. A fast
   *                  downward pitch sweep; this is what carries "power", and
   *                  its absence is most of why the old shots sounded weak.
   *   4. SLAPBACK  — two or three DISCRETE reflections off nearby surfaces.
   *                  Outdoor gunfire is instantly recognisable by these; a
   *                  smooth reverb tail alone never sounds like a gunshot
   *                  outdoors, it sounds like a gunshot in a hall.
   *
   * @param {object} spec
   *   bore     Hz, the thump's starting pitch — bigger calibre, lower number
   *   crack    Hz, high-pass corner of the initial spike
   *   blast    Hz, centre of the muzzle report
   *   bodyMs   length of the report
   *   power    overall level
   *   ref      panner reference distance (how far it carries)
   *   slaps    [[delayMs, level], ...] discrete reflections
   *   roll     optional {ms, gain, freq} — the long rolling decay of a big gun
   */
  _shot(bus, position, spec) {
    const {
      bore = 220, crack = 2000, blast = 1100, bodyMs = 55,
      power = 1, ref = 12, slaps = [[34, 0.26], [73, 0.16], [121, 0.09]],
      roll = null,
    } = spec;
    const body = bodyMs / 1000;

    // 1. CRACK
    this._transient(bus, position, { gain: 0.85 * power, freq: crack, refDistance: ref });

    // 2. BLAST — two bands. The low band is the report; the high band is the
    // edge that makes it read as close by rather than distant.
    this._burst(bus, position, {
      duration: body, gain: 1.0 * power, type: 'bandpass',
      freq: blast, freqEnd: blast * 0.22, q: 0.55, curve: 5, refDistance: ref,
    });
    this._burst(bus, position, {
      duration: body * 0.45, gain: 0.55 * power, type: 'highpass',
      freq: blast * 3.2, curve: 6, refDistance: ref,
    });

    // 3. THUMP — sweeps down roughly two octaves in well under a tenth of a
    // second. Slower than that and it turns into an audible pitch drop rather
    // than a hit.
    this._tone(bus, position, {
      type: 'triangle', freq: bore, freqEnd: bore * 0.24,
      duration: body * 1.35, gain: 0.9 * power, attack: 0.002, refDistance: ref,
    });

    // 4. SLAPBACK — progressively darker and quieter with each bounce, the way
    // air and surfaces actually absorb.
    //
    // These are kept deliberately FAINT and SHORT. Measured against the old
    // sound, the first attempt at this held the signal at about -30 dB for a
    // quarter of a second instead of letting it fall away — a flat shelf of
    // noise after the bang, which is audibly worse than no reflections at all.
    // A gunshot's envelope has to keep dropping; reflections are punctuation,
    // not sustain.
    for (let i = 0; i < slaps.length; i++) {
      const [ms, level] = slaps[i];
      this._echo(bus, position, {
        delay: ms / 1000,
        gain: level * 0.4 * power,
        freq: blast * Math.pow(0.62, i + 1),
        duration: body * 0.5,
        refDistance: ref * 1.4,
      });
    }

    // 5. THE ROLL — only for the big guns.
    //
    // This is what separates a sniper rifle from a carbine to the ear, and it
    // is not loudness: it is that the report keeps going. A .338 is audible
    // rolling off buildings and terrain for the better part of a second after
    // the crack has gone, swelling slightly before it dies as sound arrives
    // back from further and further away. A carbine has none of this.
    //
    // Slow attack on purpose — the roll should arrive after the shot, not
    // alongside it, or it just thickens the report instead of following it.
    if (roll) {
      this._burst(bus, position, {
        duration: roll.ms / 1000,
        gain: roll.gain * power,
        type: 'lowpass',
        freq: roll.freq,
        freqEnd: roll.freq * 0.3,
        attack: Math.min(0.12, roll.ms / 9000),
        curve: 2,
        refDistance: ref * 1.8,
      });
    }
  }

  /** One discrete reflection: a short, dark copy of the report, delayed. */
  _echo(bus, position, { delay = 0.04, gain = 0.2, freq = 700, duration = 0.06, refDistance = 16 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(Math.max(0.06, duration));

    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = Math.max(120, freq);
    filt.Q.value = 0.7;

    const t = this._now() + delay;
    const { input, tail } = this._dest(bus, position, refDistance);
    input.gain.setValueAtTime(0.0001, t);
    input.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.002);
    input.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filt);
    filt.connect(input);
    src.start(t);
    src.stop(t + duration + 0.02);
    this._trackVoice(tail === input ? input : tail, delay + duration);
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
   * Load real recorded sounds from `public/audio/` and let them replace the
   * synths.
   *
   * Synthesis has a ceiling. A gunshot is a supersonic pressure wave clipping
   * a microphone, and no arrangement of oscillators and filters is going to be
   * mistaken for a recording of one. This is the escape hatch: drop a file
   * named after a sound — `public/audio/shootRifle.wav` — and `play()` will
   * use it instead, because `play()` checks `this.buffers` before `SYNTHS`.
   *
   * Every file is optional and every failure is silent. A missing or broken
   * file just means that sound keeps using its synth, so the game always has
   * working audio and files can be added one at a time.
   *
   * @param {string[]} names sound names to look for
   * @param {string} [dir]
   * @returns {Promise<string[]>} the names that were actually loaded
   */
  async loadSamples(names, dir = 'audio/') {
    if (!this.ready) return [];
    const loaded = [];
    await Promise.all(names.map(async (name) => {
      for (const ext of ['ogg', 'wav', 'mp3']) {
        try {
          const res = await fetch(`${dir}${name}.${ext}`);
          // A dev server happily returns index.html for a missing file, so
          // check the content type rather than trusting the status code.
          if (!res.ok || !/audio|octet-stream/.test(res.headers.get('content-type') ?? '')) continue;
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.registerBuffer(name, buf);
          loaded.push(name);
          return;
        } catch { /* try the next extension, then fall back to the synth */ }
      }
    }));
    if (loaded.length) console.info(`[Audio] Using recorded samples for: ${loaded.join(', ')}`);
    return loaded;
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

  _playSample(buffer, { position = null, volume = 1, rate = 1, refDistance = 12 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    // 12 m rather than the 6 m default: recorded samples are overwhelmingly
    // used for weapons here, and gunfire has to stay audible across the map.
    const { input, tail } = this._dest(this.sfxBus, position, refDistance);
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
  // 9 mm: sharp and light. Little bore, so the thump sits high and short.
  shootPistol(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 150, crack: 2600, blast: 1500, bodyMs: 42, power: 0.78 * volume, ref: 10,
        slaps: [[29, 0.22], [64, 0.13], [104, 0.07]] });
    a._mech(bus, position, { delay: 0.045, gain: 0.13 * volume, freq: 3200, refDistance: 10 });
  },

  // 5.56 carbine: the reference shot. Hard crack, tight body, real punch.
  shootRifle(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 165, crack: 2200, blast: 1150, bodyMs: 55, power: 1.0 * volume, ref: 13,
        slaps: [[34, 0.26], [73, 0.16], [121, 0.09]] });
    a._mech(bus, position, { delay: 0.038, gain: 0.16 * volume, freq: 2800, refDistance: 13 });
  },

  // 12 gauge: no crack to speak of, all bore. Wide, low, and slow to leave.
  shootShotgun(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 98, crack: 1300, blast: 620, bodyMs: 88, power: 1.15 * volume, ref: 15,
        slaps: [[38, 0.3], [82, 0.19], [138, 0.11]] });
  },

  // .44 revolver: enormous for its size — long barrel, huge charge.
  shootMagnum(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 120, crack: 1900, blast: 900, bodyMs: 72, power: 1.2 * volume, ref: 17,
        slaps: [[36, 0.32], [79, 0.2], [132, 0.12]] });
  },

  // Burst rifle: same round as the carbine, shorter barrel — snappier, less body.
  shootBurst(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 172, crack: 2700, blast: 1400, bodyMs: 44, power: 0.86 * volume, ref: 12,
        slaps: [[31, 0.23], [68, 0.14], [112, 0.08]] });
    a._mech(bus, position, { delay: 0.030, gain: 0.12 * volume, freq: 3400, refDistance: 12 });
  },

  // SMG: pistol round, high rate. Deliberately the lightest report here so
  // sustained fire never turns into mud.
  shootSmg(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 158, crack: 3000, blast: 1600, bodyMs: 34, power: 0.7 * volume, ref: 10,
        slaps: [[27, 0.18], [59, 0.1]] });
    a._mech(bus, position, { delay: 0.026, gain: 0.11 * volume, freq: 3600, refDistance: 10 });
  },

  // LMG: belt-fed 7.62. Heavier bore than the carbine and a much louder action.
  shootLmg(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 132, crack: 1900, blast: 950, bodyMs: 66, power: 1.08 * volume, ref: 16,
        slaps: [[36, 0.28], [77, 0.18], [128, 0.1]] });
    a._mech(bus, position, { delay: 0.042, gain: 0.2 * volume, freq: 2500, refDistance: 16 });
  },

  // Anti-materiel rifle: the biggest thing on the map. Deep bore, hard crack,
  // and slaps that carry much further because it is genuinely that loud.
  shootSniper(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 92, crack: 3000, blast: 1050, bodyMs: 58, power: 1.35 * volume, ref: 28,
        slaps: [[52, 0.34], [118, 0.26], [201, 0.18], [312, 0.11], [455, 0.06]],
        roll: { ms: 1100, gain: 0.2, freq: 520 } });
    // The bolt being worked, a beat after the shot — a sniper is the one
    // weapon here where you hear the action as a separate event.
    a._mech(bus, position, { delay: 0.34, gain: 0.13 * volume, freq: 2100, refDistance: 20 });
  },

  // Semi-auto marksman rifle: between the carbine and the sniper.
  shootMarksman(a, { position = null, volume = 1 } = {}) {
    // Through the saturated, reverb-sent weapon chain — see init().
    const bus = a.shotDrive ?? a.sfxBus;
    a._shot(bus, position, { bore: 112, crack: 2000, blast: 880, bodyMs: 74, power: 1.12 * volume, ref: 19,
        slaps: [[38, 0.3], [83, 0.19], [138, 0.11]] });
    a._mech(bus, position, { delay: 0.048, gain: 0.15 * volume, freq: 2600, refDistance: 19 });
  },

  // AI weapon: same model, pulled back so a firefight full of them does not
  // drown out the player’s own gun.

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

  // ---------------------------------------------------------------- player
  playerHurt(a, { volume = 1 } = {}) {
    // Taking a round: a hard slap on the plate, then the thud underneath it.
    // The slap is what makes it register instantly; the low end is what makes
    // it feel like it landed on you rather than near you.
    a._transient(a.sfxBus, null, { gain: 0.62 * volume, freq: 900, refDistance: 1 });
    a._burst(a.sfxBus, null, { duration: 0.09, gain: 0.55 * volume, type: 'bandpass', freq: 1100, freqEnd: 320, q: 1.1 });
    a._burst(a.sfxBus, null, { duration: 0.26, gain: 0.30 * volume, type: 'lowpass', freq: 620, freqEnd: 120, attack: 0.012 });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 128, freqEnd: 46, duration: 0.28, gain: 0.5 * volume, attack: 0.002 });
  },
  playerDeath(a, { volume = 1 } = {}) {
    a._tone(a.sfxBus, null, { type: 'sine', freq: 160, freqEnd: 32, duration: 1.6, gain: 0.5 * volume, attack: 0.02 });
    a._burst(a.sfxBus, null, { duration: 1.8, gain: 0.2 * volume, type: 'lowpass', freq: 900, freqEnd: 70, attack: 0.05 });
  },
  /*
   * Hit confirmation sounds.
   *
   * These have to be heard THROUGH the weapon that caused them, which is the
   * constraint that decides their whole design. The previous versions were a
   * single thin square tone each and measured about a tenth the level of a
   * gunshot — during a burst they simply were not audible, so landing hits
   * gave no feedback at all.
   *
   * Each is now a transient plus a short band-limited body: the transient
   * survives being masked by the shot because it occupies the first few
   * milliseconds after it, and the narrow band keeps it distinct from the
   * broadband report rather than fighting it for the same frequencies.
   *
   * Kept under 100 ms so a fast weapon does not turn them into a drone.
   */
  hitmarker(a, { volume = 1 } = {}) {
    // Body hit: a dry, percussive tick.
    a._transient(a.sfxBus, null, { gain: 0.5 * volume, freq: 2600, refDistance: 1 });
    a._burst(a.sfxBus, null, { duration: 0.05, gain: 0.36 * volume, type: 'bandpass', freq: 2400, freqEnd: 1500, q: 2.4 });
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 1650, freqEnd: 1150, duration: 0.055, gain: 0.30 * volume, attack: 0.001 });
  },
  hitmarkerHead(a, { volume = 1 } = {}) {
    // Headshot: brighter, with a ringing overtone that reads as "better".
    a._transient(a.sfxBus, null, { gain: 0.6 * volume, freq: 3600, refDistance: 1 });
    a._burst(a.sfxBus, null, { duration: 0.045, gain: 0.34 * volume, type: 'bandpass', freq: 3600, freqEnd: 2400, q: 3 });
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 2450, freqEnd: 1800, duration: 0.07, gain: 0.34 * volume, attack: 0.001 });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 3700, freqEnd: 3100, duration: 0.09, gain: 0.20 * volume, attack: 0.002 });
  },
  killConfirm(a, { volume = 1 } = {}) {
    // A kill is the one thing you must never miss, so it is the longest of the
    // three and the only one that rises — two notes a fifth apart, which reads
    // as a resolution rather than as another hit.
    a._transient(a.sfxBus, null, { gain: 0.55 * volume, freq: 2200, refDistance: 1 });
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 780, freqEnd: 940, duration: 0.07, gain: 0.34 * volume, attack: 0.001 });
    a._tone(a.sfxBus, null, { type: 'triangle', freq: 1180, freqEnd: 1420, duration: 0.16, gain: 0.30 * volume, attack: 0.055 });
    a._tone(a.sfxBus, null, { type: 'sine', freq: 2360, freqEnd: 2840, duration: 0.18, gain: 0.14 * volume, attack: 0.06 });
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

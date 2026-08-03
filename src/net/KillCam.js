/**
 * KillCam — see the kill from the other end.
 *
 * WHAT IT IS
 * ----------
 * When somebody kills you, the seconds leading up to it are replayed from
 * behind THEIR eyes: where they were standing, where they were looking, when
 * they fired, and you walking into it. Not a live camera on them — a replay of
 * what they actually saw at the moment they killed you.
 *
 * WHY IT IS ITS OWN SUBSYSTEM
 * ---------------------------
 * The obvious implementation is a few fields on Game and a branch in the
 * camera code, and it would work. It would also be the only way this ever
 * works: a spectator mode, watching the match leader, a highlight at the end
 * of a round and a demo recording are all the SAME two capabilities —
 * *remember what the world was doing*, and *put the camera in somebody's head*
 * — and none of them would be reachable from a special case wired into death.
 *
 * So this owns those two things and nothing else. It does not know what a kill
 * is. `watch(id)` takes any player and any moment; the fact that we currently
 * call it with the person who just shot you is a decision Game makes, in one
 * line, in one place.
 *
 * IT RECORDS THE WORLD, NOT THE SCREEN
 * ------------------------------------
 * A ring buffer of positions and orientations for everyone, sampled at 30 Hz,
 * plus a track of gunfire events. Playing back means interpolating between two
 * recorded frames and handing the result to whatever draws players — which is
 * the same RemotePlayers that draws them live, so a replayed body walks,
 * leans, aims and reloads exactly as it did the first time. Nothing is
 * duplicated to support this; the renderer cannot tell the difference.
 *
 * YOU ARE IN THE RECORDING TOO
 * ----------------------------
 * `NetworkClient.sample()` deliberately skips you — it never interpolates the
 * player it belongs to. That is right for normal play and completely wrong
 * here: a kill cam without the victim in it is a video of somebody looking at
 * an empty corridor. `record()` takes your own state separately and writes it
 * into the frame alongside everyone else, so the replay contains the one body
 * the whole thing is about.
 */

import * as THREE from 'three';
import { MATCH_RULES, FLAG } from './protocol.js';
import { EYE_ABOVE_CENTRE_STAND, EYE_ABOVE_CENTRE_CROUCH } from '../player/Player.js';

/**
 * Sampling rate and depth of the recording.
 *
 * 30 Hz matches the server's tick, so recording faster would store
 * interpolated frames between snapshots that carry no new information.
 *
 * The buffer holds slightly more than the longest replay the rules allow, so
 * the clamp in `watch()` is what limits the window — not the buffer quietly
 * running out underneath it. That distinction matters: one is a decision, the
 * other is a replay that mysteriously starts late on a busy frame.
 */
const RECORD_HZ = 30;
const HISTORY_SEC = MATCH_RULES.killCamMaxSec + MATCH_RULES.killCamLeadSec + 1;
const FRAMES = Math.ceil(RECORD_HZ * HISTORY_SEC);
const RECORD_INTERVAL_MS = 1000 / RECORD_HZ;

/** Gunfire events kept alongside the frames, sized to the same window. */
const EVENT_CAP = 256;

/** A replay of somebody standing still is not worth taking the camera for. */
const MIN_REPLAY_SEC = 0.6;

/*
 * WHERE THE CAMERA SITS RELATIVE TO THE KILLER'S EYE
 *
 * Strictly behind and slightly above and to the right — over their shoulder.
 * The first version put it exactly AT the eye and hid their body, which is
 * literally their point of view and was unwatchable:
 *
 *   - no body and no weapon, so it read as a camera flying through the map
 *     rather than as a person, and
 *   - their own muzzle flashes were drawn 0.85 m from the lens, because that
 *     is where a muzzle is relative to an eye. Twenty-two world-scale flashes
 *     going off on the camera over one replay.
 *
 * Pulled back, all of that becomes the point instead of the problem: you see
 * the man, you see his gun, you see it fire, and you see yourself walk into
 * it. Every shipped kill cam is framed this way, and this is why.
 *
 * The orientation is still exactly theirs, so it remains what they were
 * looking at. Set all three to zero for a true first-person view.
 */
const CAMERA_BACK = 1.5;
const CAMERA_UP = 0.32;
const CAMERA_RIGHT = 0.42;

/** Never put the camera through a wall — see the clearance probe. */
const CAMERA_SKIN = 0.25;

export class KillCam {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} opts.camera  driven while a replay runs
   * @param {(event: object) => void} [opts.onEvent]
   *   Called when a recorded event's moment comes round again during playback.
   *   Gunfire, currently — it is what makes the replay show you being shot at
   *   rather than merely aimed at.
   * @param {() => void} [opts.onEnd]  the replay reached its end on its own
   * @param {((ox:number, oy:number, oz:number, dx:number, dy:number, dz:number,
   *   max:number) => number|null)} [opts.clearanceProbe]
   *   How far the camera can be pulled back from the eye before it would be
   *   inside something. Optional — without it the camera can end up behind a
   *   wall when the killer had their back to one, which is most doorways.
   */
  constructor({ camera, onEvent = null, onEnd = null, clearanceProbe = null }) {
    this.camera = camera;
    this.onEvent = onEvent;
    this.onEnd = onEnd;
    this.clearanceProbe = clearanceProbe;
    /** Off means watch() refuses and nothing is recorded. A settings toggle. */
    this.enabled = true;

    /*
     * The ring buffer, allocated once and written in place.
     *
     * This runs 30 times a second for the whole match, so anything that
     * allocates here allocates forever. Rows are reused and `n` says how many
     * of them are live this frame — a shorter array would mean a fresh one
     * every time somebody leaves.
     */
    this._frames = Array.from({ length: FRAMES }, () => ({ t: 0, n: 0, rows: [] }));
    this._head = -1;          // index of the newest frame, -1 while empty
    this._count = 0;
    this._lastRecordAt = 0;

    this._events = [];
    this._eventHead = 0;

    /**
     * id -> when they first hurt us THIS LIFE.
     *
     * This is what anchors the replay to the fight rather than to the clock:
     * a duel that ran eight seconds is shown from its opening shot, and a
     * headshot from across the map is not padded out with the ten seconds of
     * walking that preceded it. Cleared on respawn — see forgetEngagements.
     */
    this._engagedAt = new Map();

    /** @type {number|null} who we are watching */
    this.subjectId = null;
    this._playAt = 0;         // recorder time currently being shown
    this._endAt = 0;
    this._emittedUpTo = 0;

    // Playback output, reused. remotes.sync() wants a Map of the same shape
    // NetworkClient.sample() produces.
    this._out = new Map();
    this._pool = new Map();

    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  get active() { return this.subjectId !== null; }

  /** The world state to draw this frame, or null when nothing is being replayed. */
  get sample() { return this.active ? this._out : null; }

  /**
   * Take a copy of what everyone is doing right now.
   *
   * @param {Map<number, object>} sample  interpolated remotes, from NetworkClient
   * @param {object|null} self  our own row — see the note at the top about why
   *   this arrives separately: `sample()` never contains us
   * @param {number} nowMs
   */
  record(sample, self, nowMs) {
    if (!this.enabled) return;
    // Recording DURING a replay would overwrite the very frames being played,
    // and the live positions it captured would be wrong anyway.
    if (this.active) return;
    if (nowMs - this._lastRecordAt < RECORD_INTERVAL_MS) return;
    this._lastRecordAt = nowMs;

    this._head = (this._head + 1) % FRAMES;
    this._count = Math.min(this._count + 1, FRAMES);
    const frame = this._frames[this._head];
    frame.t = nowMs;

    let i = 0;
    if (sample) for (const [id, s] of sample) i = this._writeRow(frame, i, id, s);
    if (self) i = this._writeRow(frame, i, self.id, self);
    frame.n = i;
  }

  _writeRow(frame, i, id, s) {
    const row = frame.rows[i] ?? (frame.rows[i] = {
      id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, weapon: 'rifle', hp: 100,
    });
    row.id = id;
    row.x = s.x; row.y = s.y; row.z = s.z;
    row.yaw = s.yaw; row.pitch = s.pitch;
    row.flags = s.flags; row.weapon = s.weapon; row.hp = s.hp;
    return i + 1;
  }

  /**
   * Note something that happened, to be replayed at the same moment.
   *
   * Deliberately shapeless — it stores whatever it is given and hands the same
   * object back during playback. Gunfire is the only caller today; an
   * explosion or a grenade landing would need no change here.
   */
  note(event, nowMs) {
    if (!this.enabled || this.active) return;
    const slot = this._events[this._eventHead] ?? (this._events[this._eventHead] = {});
    slot.t = nowMs;
    slot.data = event;
    this._eventHead = (this._eventHead + 1) % EVENT_CAP;
  }

  /**
   * Note that `id` has hurt us, so a replay can start where the fight did.
   *
   * Only the FIRST one counts: a ten-second exchange should be replayed from
   * its opening round, not from the last one that happened to land.
   */
  markAggressor(id, nowMs) {
    if (!this.enabled || id == null) return;
    if (!this._engagedAt.has(id)) this._engagedAt.set(id, nowMs);
  }

  /** A new life, a clean slate. Called on respawn. */
  forgetEngagements() { this._engagedAt.clear(); }

  /**
   * How long a replay of `subjectId`'s fight with us would run, in seconds.
   *
   * The fight starts when they first hurt us, plus a lead-in so they are on
   * screen before the first round rather than arriving with it. Clamped at
   * both ends: nothing worth watching below the minimum, and nothing worth
   * WAITING for above the maximum.
   */
  windowFor(subjectId, endAtMs = performance.now()) {
    const began = this._engagedAt.get(subjectId);
    const fought = began == null
      ? MATCH_RULES.killCamMinSec
      : (endAtMs - began) / 1000 + MATCH_RULES.killCamLeadSec;
    return Math.min(MATCH_RULES.killCamMaxSec,
      Math.max(MATCH_RULES.killCamMinSec, fought));
  }

  /**
   * Replay the fight leading to `endAtMs` from `subjectId`'s point of view.
   *
   * @returns {number} how many seconds it will play for, or 0 when there is
   *   nothing worth showing — the subject left, or was never recorded, or
   *   there is not enough history yet. The caller then carries on as though no
   *   kill cam existed, which is what should happen when somebody blows
   *   themselves up.
   */
  watch(subjectId, { endAtMs = performance.now(), seconds = null } = {}) {
    if (!this.enabled || subjectId == null || this._count < 2) return 0;

    const want = seconds ?? this.windowFor(subjectId, endAtMs);
    const newest = this._frames[this._head].t;
    const oldest = this._frames[(this._head - this._count + 1 + FRAMES) % FRAMES].t;
    const to = Math.min(endAtMs, newest);
    const from = Math.max(oldest, to - want * 1000);
    if (to - from < MIN_REPLAY_SEC * 1000) return 0;

    // The subject has to actually be in the frames we are about to play, or
    // the camera would have nowhere to sit. Somebody who joined a moment ago
    // and killed you immediately falls out here.
    if (!this._rowAt(this._nearestFrame(to), subjectId)) return 0;

    this.subjectId = subjectId;
    this._playAt = from;
    this._endAt = to;
    this._emittedUpTo = from;
    return (to - from) / 1000;
  }

  /** Give the camera back and forget who we were watching. */
  stop() {
    this.subjectId = null;
    this._out.clear();
  }

  /** Drop the whole recording — on leaving a match, so it cannot leak into the next. */
  clear() {
    this.stop();
    this._head = -1;
    this._count = 0;
    this._events.length = 0;
    this._eventHead = 0;
    this._lastRecordAt = 0;
    this._engagedAt.clear();
  }

  /**
   * Advance the replay, rebuild the world state and aim the camera.
   *
   * Must run BEFORE whatever draws players, so `sample` is this frame's.
   */
  update(dt) {
    if (!this.active) return;

    this._playAt += dt * 1000;
    if (this._playAt >= this._endAt) {
      this._playAt = this._endAt;
      this._build(this._playAt);
      this._aim();
      this._emit(this._playAt);
      const done = this.onEnd;
      this.stop();
      done?.();
      return;
    }

    this._build(this._playAt);
    this._aim();
    this._emit(this._playAt);
  }

  // ------------------------------------------------------------- internals

  /** Index of the recorded frame nearest `t`, searching newest-first. */
  _nearestFrame(t) {
    let best = this._head;
    let bestGap = Infinity;
    for (let k = 0; k < this._count; k++) {
      const i = (this._head - k + FRAMES) % FRAMES;
      const gap = Math.abs(this._frames[i].t - t);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  }

  _rowAt(frameIndex, id) {
    const f = this._frames[frameIndex];
    for (let i = 0; i < f.n; i++) if (f.rows[i].id === id) return f.rows[i];
    return null;
  }

  /** The two frames bracketing `t`, as indices, plus the blend between them. */
  _bracket(t) {
    let older = null, newer = null;
    for (let k = 0; k < this._count; k++) {
      const i = (this._head - k + FRAMES) % FRAMES;
      if (this._frames[i].t <= t) {
        older = i;
        newer = k === 0 ? null : (this._head - (k - 1) + FRAMES) % FRAMES;
        break;
      }
    }
    if (older === null) {
      older = (this._head - this._count + 1 + FRAMES) % FRAMES;
      newer = this._count > 1 ? (older + 1) % FRAMES : null;
    }
    const a = this._frames[older];
    const b = newer === null ? null : this._frames[newer];
    const span = b ? b.t - a.t : 0;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    return { a, b, k };
  }

  /**
   * Rebuild the world at time `t` into `this._out`.
   *
   * Same shape NetworkClient.sample() produces, and the same reuse discipline:
   * entries are pooled by id so a replay does not allocate a Map's worth of
   * objects every frame.
   */
  _build(t) {
    const { a, b, k } = this._bracket(t);
    this._out.clear();

    for (let i = 0; i < a.n; i++) {
      const ra = a.rows[i];
      let rb = null;
      if (b) {
        for (let j = 0; j < b.n; j++) if (b.rows[j].id === ra.id) { rb = b.rows[j]; break; }
      }

      let e = this._pool.get(ra.id);
      if (!e) { e = { id: ra.id, moving: 0 }; this._pool.set(ra.id, e); }

      if (rb) {
        e.x = ra.x + (rb.x - ra.x) * k;
        e.y = ra.y + (rb.y - ra.y) * k;
        e.z = ra.z + (rb.z - ra.z) * k;
        // Shortest way round, or a body spins the long way through a wrap.
        e.yaw = ra.yaw + shortestAngle(ra.yaw, rb.yaw) * k;
        e.pitch = ra.pitch + (rb.pitch - ra.pitch) * k;
      } else {
        e.x = ra.x; e.y = ra.y; e.z = ra.z;
        e.yaw = ra.yaw; e.pitch = ra.pitch;
      }
      // Flags and weapon are states, not quantities — take the earlier frame's
      // rather than inventing a value halfway between "crouched" and "not".
      e.flags = ra.flags;
      e.weapon = ra.weapon;
      e.hp = ra.hp;
      this._out.set(ra.id, e);
    }

    /*
     * The killer IS drawn, and that is the point.
     *
     * An earlier version deleted them, because the camera sat exactly at their
     * eye and their own head filled the screen. With the camera over their
     * shoulder instead they are the subject of the shot: you watch the person
     * who killed you raise a weapon you can identify and fire it at you. A
     * replay with them missing is just a corridor.
     */
  }

  /** Put the camera in the subject's head, looking where they were looking. */
  _aim() {
    const { a, b, k } = this._bracket(this._playAt);
    let ra = null, rb = null;
    for (let i = 0; i < a.n; i++) if (a.rows[i].id === this.subjectId) { ra = a.rows[i]; break; }
    if (!ra) return;
    if (b) for (let j = 0; j < b.n; j++) if (b.rows[j].id === this.subjectId) { rb = b.rows[j]; break; }

    const x = rb ? ra.x + (rb.x - ra.x) * k : ra.x;
    const y = rb ? ra.y + (rb.y - ra.y) * k : ra.y;
    const z = rb ? ra.z + (rb.z - ra.z) * k : ra.z;
    const yaw = rb ? ra.yaw + shortestAngle(ra.yaw, rb.yaw) * k : ra.yaw;
    const pitch = rb ? ra.pitch + (rb.pitch - ra.pitch) * k : ra.pitch;

    // The snapshot reports the capsule CENTRE, so the eye is that plus the
    // offset Player derives from the same capsule. Crouching lowers it by
    // nearly forty centimetres, which is the difference between seeing over a
    // crate and seeing the crate.
    const eye = (ra.flags & FLAG.CROUCH) !== 0
      ? EYE_ABOVE_CENTRE_CROUCH : EYE_ABOVE_CENTRE_STAND;
    const ex = x, ey = y + eye, ez = z;

    // Orientation is exactly theirs — this is still what they were looking at.
    // Same convention as Player's own camera: (pitch, yaw, roll) in YXZ.
    this._euler.set(pitch, yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);

    /*
     * Then step back along their own view direction, over their shoulder.
     *
     * Derived from the orientation rather than from yaw alone, so looking up
     * or down swings the camera the way the shot is framed instead of sliding
     * it along the floor.
     */
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Forward for a YXZ (pitch, yaw) camera looking down -Z.
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    // Right is the horizontal perpendicular; no roll, so this is exact.
    const rx = cy, rz = -sy;

    // How far back we can actually go before hitting something behind them.
    let back = CAMERA_BACK;
    if (this.clearanceProbe) {
      const hit = this.clearanceProbe(ex, ey, ez, -fx, -fy, -fz, CAMERA_BACK + CAMERA_SKIN);
      if (typeof hit === 'number' && hit >= 0) {
        back = Math.max(0, Math.min(CAMERA_BACK, hit - CAMERA_SKIN));
      }
    }
    // Shoulder offsets scale with it, so a camera pinned against a wall
    // collapses to their eye rather than sliding sideways into the geometry.
    const k2 = CAMERA_BACK > 0 ? back / CAMERA_BACK : 0;

    this.camera.position.set(
      ex - fx * back + rx * CAMERA_RIGHT * k2,
      ey - fy * back + CAMERA_UP * k2,
      ez - fz * back + rz * CAMERA_RIGHT * k2,
    );
  }

  /** Fire off anything recorded between the last frame's time and this one's. */
  _emit(t) {
    if (!this.onEvent) { this._emittedUpTo = t; return; }
    for (const slot of this._events) {
      if (!slot || slot.t <= this._emittedUpTo || slot.t > t) continue;
      this.onEvent(slot.data);
    }
    this._emittedUpTo = t;
  }
}

/** Signed shortest way from a to b around the circle. */
function shortestAngle(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

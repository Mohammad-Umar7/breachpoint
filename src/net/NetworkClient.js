/**
 * NetworkClient — the browser half of multiplayer.
 *
 * Owns the WebSocket, the snapshot buffer, and the clock relationship with the
 * server. Deliberately knows nothing about THREE, the player, or the HUD: it
 * emits events and answers "where was everyone at time T", and Game wires that
 * into the world. That keeps the netcode testable and stops network concerns
 * leaking through the whole codebase.
 *
 * THE THREE HARD PARTS, and why each is done this way
 * --------------------------------------------------
 * 1. CLOCK. Snapshots are stamped with the server's clock, which has no fixed
 *    relationship to `performance.now()`. Rather than trying to synchronise
 *    properly (NTP-style), we track the offset that makes the newest snapshot
 *    land "now" and only ever let it jump forward — see `_syncClock`. Drifting
 *    backwards would make time run backwards for interpolation, which shows up
 *    as remote players stuttering.
 *
 * 2. INTERPOLATION. Rendering the newest snapshot the instant it arrives means
 *    stuttering on every late packet, because they arrive every ~33 ms and the
 *    network jitters. Instead we render INTERP_DELAY_MS in the past, where
 *    there is almost always a snapshot on either side to interpolate between.
 *
 * 3. SELF. Your own player is NOT interpolated from snapshots — that would add
 *    a round-trip of input lag to your own movement, which feels awful. You
 *    simulate locally and immediately; the server only intervenes to correct
 *    you (`onCorrection`) if it rejects a position.
 */

import {
  MSG, FLAG, PROTOCOL_VERSION, INTERP_DELAY_MS, INPUT_HZ,
  MATCH_STATE, sanitizeName,
} from './protocol.js';

/** Snapshots kept for interpolation. At 30 Hz this is ~1 s of history. */
const SNAPSHOT_BUFFER = 32;

/** Shortest-path angle interpolation — a yaw crossing ±PI must not spin. */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export const NET_STATE = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
});

export class NetworkClient {
  constructor({ url } = {}) {
    /**
     * Server URL. Set VITE_SERVER_URL at build time for production; in dev it
     * falls back to the same host on the server's default port, which is what
     * `npm run dev` alongside `cd server && npm start` gives you.
     */
    this.url = url
      || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SERVER_URL)
      || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787`;

    this.state = NET_STATE.OFFLINE;
    this.socket = null;
    this.selfId = null;
    this.room = null;
    this.name = 'OPERATOR';
    this.ping = 0;
    this.lastError = null;

    /** Server-reported roster: id -> { id, name, kills, deaths, ping, alive } */
    this.players = new Map();
    this.match = { state: MATCH_STATE.WARMUP, timeLeft: 0, killTarget: 0, winnerId: null };

    /** @type {Array<{ts:number, at:number, players:Map}>} newest last */
    this.snapshots = [];
    this._clockOffset = null;   // serverTime - localTime
    this._inputSeq = 0;
    this._lastInputAt = 0;
    this._pingSentAt = 0;
    this._pingTimer = null;

    // --- callbacks, assigned by Game -------------------------------------
    this.onStateChange = null;   // (netState, detail)
    this.onWelcome = null;       // ({ id, room, spawn, players, match })
    this.onJoined = null;        // (playerSummary)
    this.onLeft = null;          // (id)
    this.onHit = null;           // ({ victim, attacker, damage, part, hp })
    this.onKill = null;          // ({ victim, attacker, weapon, headshot })
    this.onScore = null;         // (rosterArray)
    this.onMatch = null;         // (matchState)
    this.onCorrection = null;    // ([x,y,z])  server rejected our position
    this.onRespawn = null;       // ([x,y,z])
    this.onDenied = null;        // (reason)
    this.onProgress = null;      // (message) slow-connect progress, for the lobby
  }

  get connected() { return this.state === NET_STATE.CONNECTED; }

  /** True when this client is the only one present, so nothing scores yet. */
  get isWarmup() { return this.match.state === MATCH_STATE.WARMUP; }

  // -------------------------------------------------------------- lifecycle
  /**
   * @param {{name?:string, room?:string|null}} opts
   * @returns {Promise<object>} resolves with the WELCOME payload
   */
  connect({ name, room = null } = {}) {
    this.disconnect();
    this.name = sanitizeName(name, 'OPERATOR');
    this._setState(NET_STATE.CONNECTING);
    this.lastError = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        this.lastError = why;
        this._setState(NET_STATE.FAILED, why);
        reject(new Error(why));
      };

      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        fail(`could not reach the server (${err.message})`);
        return;
      }
      this.socket = socket;

      // A server that is down often leaves the socket "connecting" rather than
      // erroring, so without this the menu would hang on JOINING forever.
      //
      // The window is generous because free hosting sleeps. Render's free tier
      // spins a service down after 15 minutes idle and takes about a minute to
      // wake, so the first person to join after a quiet spell waits far longer
      // than a warm server would need. An 8-second timeout — the first value
      // here — made the free tier look permanently broken to whoever arrived
      // first. Progress is reported so the wait can be explained rather than
      // just endured.
      const slowAt = setTimeout(() => {
        if (!settled) {
          this.onProgress?.('Waking the server — this can take up to a minute '
            + 'if nobody has played recently.');
        }
      }, 3500);
      const timeout = setTimeout(() => {
        if (!settled) {
          try { socket.close(); } catch { /* noop */ }
          fail('the server did not respond');
        }
      }, 75000);
      const clearTimers = () => { clearTimeout(slowAt); clearTimeout(timeout); };

      socket.onopen = () => {
        this._send(MSG.JOIN, { n: this.name, r: room || undefined, v: PROTOCOL_VERSION });
      };

      socket.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === MSG.WELCOME && !settled) {
          settled = true;
          clearTimers();
          this._handleWelcome(msg);
          resolve(msg);
          return;
        }
        if (msg.t === MSG.DENIED && !settled) {
          clearTimers();
          fail(msg.why || 'the server refused the connection');
          try { socket.close(); } catch { /* noop */ }
          return;
        }
        this._handle(msg);
      };

      socket.onerror = () => {
        clearTimers();
        fail('could not reach the server — is it running?');
      };

      socket.onclose = (ev) => {
        clearTimers();
        this._stopPing();
        if (!settled) {
          fail(ev.reason || 'the connection closed before joining');
          return;
        }
        if (this.state === NET_STATE.CONNECTED) {
          this._setState(NET_STATE.OFFLINE, ev.reason || 'disconnected');
        }
        this.socket = null;
      };
    });
  }

  disconnect() {
    this._stopPing();
    if (this.socket) {
      // Drop the handlers first so the close does not fire a "disconnected"
      // state change for a teardown we asked for.
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      try { this.socket.close(1000, 'left'); } catch { /* already gone */ }
      this.socket = null;
    }
    this.players.clear();
    this.snapshots.length = 0;
    this.selfId = null;
    this.room = null;
    this._clockOffset = null;
    if (this.state !== NET_STATE.OFFLINE) this._setState(NET_STATE.OFFLINE);
  }

  // ------------------------------------------------------------- outbound
  /**
   * Report our locally simulated state. Throttled to INPUT_HZ — sending one per
   * render frame would trip the server's flood protection at high frame rates
   * and buys nothing, since the server only ticks 30 times a second.
   */
  sendInput({ position, yaw, pitch, flags, weaponId }, nowMs = performance.now()) {
    if (!this.connected) return;
    if (nowMs - this._lastInputAt < 1000 / INPUT_HZ) return;
    this._lastInputAt = nowMs;
    this._send(MSG.INPUT, {
      q: ++this._inputSeq,
      p: [round2(position.x), round2(position.y), round2(position.z)],
      y: round3(yaw),
      a: round3(pitch),
      f: flags,
      w: weaponId,
    });
  }

  /**
   * Claim a shot. We send WHO we hit and WHERE, never how much damage — the
   * server derives that from the weapon definition itself, so a tampered
   * client cannot inflate it.
   */
  sendShot({ origin, direction, weaponId, hits }) {
    if (!this.connected || !hits?.length) return;
    this._send(MSG.SHOT, {
      q: ++this._inputSeq,
      o: [round2(origin.x), round2(origin.y), round2(origin.z)],
      d: [round3(direction.x), round3(direction.y), round3(direction.z)],
      w: weaponId,
      h: hits.map((h) => ({ v: h.victimId, pt: h.part })),
    });
  }

  requestRespawn() { if (this.connected) this._send(MSG.RESPAWN, {}); }

  setName(name) {
    this.name = sanitizeName(name, this.name);
    if (this.connected) this._send(MSG.NAME, { n: this.name });
  }

  _send(type, payload) {
    if (this.socket?.readyState !== 1) return;
    try { this.socket.send(JSON.stringify({ t: type, ...payload })); } catch { /* closing */ }
  }

  // -------------------------------------------------------------- inbound
  _handleWelcome(msg) {
    this.selfId = msg.id;
    this.room = msg.r;
    this.players.clear();
    for (const p of msg.ps ?? []) this._upsert(p);
    if (msg.you) this._upsert(msg.you);
    if (msg.mt) this._applyMatch(msg.mt);
    this._setState(NET_STATE.CONNECTED);
    this._startPing();
    this.onWelcome?.({
      id: msg.id,
      room: msg.r,
      spawn: Array.isArray(msg.sp) ? msg.sp : null,
      players: [...this.players.values()],
      match: this.match,
    });
  }

  _handle(msg) {
    switch (msg.t) {
      case MSG.SNAPSHOT: this._handleSnapshot(msg); break;

      case MSG.JOINED:
        if (msg.p) { this._upsert(msg.p); this.onJoined?.(msg.p); }
        break;

      case MSG.LEFT:
        this.players.delete(msg.id);
        // Purge from history too, or the leaver's body hangs in the world for
        // as long as the interpolation buffer holds them.
        for (const s of this.snapshots) s.players.delete(msg.id);
        this.onLeft?.(msg.id);
        break;

      case MSG.HIT: {
        const victim = this.players.get(msg.v);
        if (victim) victim.hp = msg.hp;
        this.onHit?.({
          victim: msg.v, attacker: msg.a, damage: msg.d, part: msg.pt, hp: msg.hp,
          isSelfVictim: msg.v === this.selfId, isSelfAttacker: msg.a === this.selfId,
        });
        break;
      }

      case MSG.KILL: {
        const victim = this.players.get(msg.v);
        if (victim) { victim.alive = false; victim.hp = 0; }
        this.onKill?.({
          victim: msg.v, attacker: msg.a, weapon: msg.w, headshot: !!msg.hs,
          victimName: this.nameOf(msg.v), attackerName: this.nameOf(msg.a),
          isSelfVictim: msg.v === this.selfId, isSelfAttacker: msg.a === this.selfId,
        });
        break;
      }

      case MSG.SCORE:
        for (const [id, name, kills, deaths, ping] of msg.ps ?? []) {
          const p = this._upsert({ id, n: name });
          p.kills = kills; p.deaths = deaths; p.ping = ping;
        }
        // Drop anyone the server no longer lists, so a missed LEFT cannot leave
        // a ghost on the scoreboard forever.
        {
          const live = new Set((msg.ps ?? []).map((r) => r[0]));
          for (const id of [...this.players.keys()]) {
            if (!live.has(id)) this.players.delete(id);
          }
        }
        this.onScore?.(this.roster());
        break;

      case MSG.MATCH:
        this._applyMatch(msg);
        // A MATCH carrying `sp` is the server placing us: either our first
        // spawn, a respawn, or a correction after rejecting our position.
        if (Array.isArray(msg.sp)) {
          const self = this.players.get(this.selfId);
          const wasDead = self && !self.alive;
          if (self) { self.alive = true; self.hp = 100; }
          if (wasDead) this.onRespawn?.(msg.sp);
          else this.onCorrection?.(msg.sp);
        }
        this.onMatch?.(this.match);
        break;

      case MSG.PONG: {
        // Measure only — do NOT answer.
        //
        // Replying to a PONG with another PING is a closed loop: the server
        // answers every PING with a PONG, so the two bounce at network speed
        // and trip the server's flood protection in well under a second. The
        // measured RTT is instead carried on the NEXT scheduled ping, two
        // seconds later, which costs nothing and cannot run away.
        const rtt = Math.round(performance.now() - this._pingSentAt);
        if (this._pingSentAt && rtt >= 0 && rtt < 5000) {
          this.ping = this.ping ? Math.round(this.ping * 0.7 + rtt * 0.3) : rtt;
        }
        break;
      }

      case MSG.DENIED:
        this.lastError = msg.why;
        this.onDenied?.(msg.why);
        break;

      default: break;
    }
  }

  _handleSnapshot(msg) {
    const now = performance.now();
    this._syncClock(msg.ts, now);

    const players = new Map();
    for (const row of msg.p ?? []) {
      const [id, x, y, z, yaw, pitch, flags, weapon, hp] = row;
      players.set(id, { id, x, y, z, yaw, pitch, flags, weapon, hp });
      const known = this.players.get(id);
      if (known) {
        known.hp = hp;
        known.alive = (flags & FLAG.DEAD) === 0;
        known.weapon = weapon;
      }
    }

    this.snapshots.push({ ts: msg.ts, at: now, players });
    if (this.snapshots.length > SNAPSHOT_BUFFER) this.snapshots.shift();
  }

  /**
   * Track serverTime - localTime.
   *
   * Only ever allowed to jump FORWARD, then it eases back slowly. If the offset
   * were allowed to follow every sample it would follow the jitter, and any
   * backward step makes render time move backwards — which reads as remote
   * players twitching. Taking the optimistic (largest) offset means we track
   * the fastest-arriving packets and treat slow ones as late, which is what the
   * interpolation delay is there to absorb.
   */
  _syncClock(serverTs, localNow) {
    const sample = serverTs - localNow;
    if (this._clockOffset === null || sample > this._clockOffset) {
      this._clockOffset = sample;
    } else {
      this._clockOffset += (sample - this._clockOffset) * 0.02;
    }
  }

  /** Server-clock time we should be rendering other players at. */
  renderTime(nowMs = performance.now()) {
    if (this._clockOffset === null) return null;
    return nowMs + this._clockOffset - INTERP_DELAY_MS;
  }

  /**
   * Interpolated state of every OTHER player at the current render time.
   *
   * @returns {Map<number, {x,y,z,yaw,pitch,flags,weapon,hp,moving:number}>}
   */
  sample(nowMs = performance.now(), out = new Map()) {
    out.clear();
    const target = this.renderTime(nowMs);
    if (target === null || this.snapshots.length === 0) return out;

    const snaps = this.snapshots;
    let older = null;
    let newer = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].ts <= target) { older = snaps[i]; newer = snaps[i + 1] ?? null; break; }
    }
    // Target is older than everything we hold (a long stall) — use the oldest.
    if (!older) { older = snaps[0]; newer = snaps[1] ?? null; }

    const span = newer ? newer.ts - older.ts : 0;
    const k = span > 0 ? Math.min(1, Math.max(0, (target - older.ts) / span)) : 0;

    for (const [id, a] of older.players) {
      if (id === this.selfId) continue;         // never interpolate ourselves
      const b = newer?.players.get(id);
      if (!b) {
        out.set(id, { ...a, moving: 0 });
        continue;
      }
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      out.set(id, {
        id,
        x: a.x + dx * k,
        y: a.y + (b.y - a.y) * k,
        z: a.z + dz * k,
        yaw: lerpAngle(a.yaw, b.yaw, k),
        pitch: a.pitch + (b.pitch - a.pitch) * k,
        // Newest authoritative values rather than interpolated ones: blending a
        // flag bitfield or an integer HP produces nonsense.
        flags: b.flags,
        weapon: b.weapon,
        hp: b.hp,
        // Horizontal speed, for driving the walk cycle on remote bodies.
        moving: span > 0 ? Math.hypot(dx, dz) / (span / 1000) : 0,
      });
    }
    return out;
  }

  // ----------------------------------------------------------------- roster
  _upsert(summary) {
    const id = summary.id;
    let p = this.players.get(id);
    if (!p) {
      p = { id, name: summary.n ?? `PLAYER ${id}`, kills: 0, deaths: 0, ping: 0, hp: 100, alive: true };
      this.players.set(id, p);
    }
    if (summary.n) p.name = summary.n;
    if (typeof summary.k === 'number') p.kills = summary.k;
    if (typeof summary.d === 'number') p.deaths = summary.d;
    if (typeof summary.hp === 'number') p.hp = summary.hp;
    if (typeof summary.a === 'boolean') p.alive = summary.a;
    if (summary.w) p.weapon = summary.w;
    return p;
  }

  nameOf(id) {
    if (id === this.selfId) return this.name;
    return this.players.get(id)?.name ?? 'SOMEONE';
  }

  /** Scoreboard order: kills desc, then fewest deaths, then name. */
  roster() {
    return [...this.players.values()].sort((a, b) =>
      b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  }

  _applyMatch(m) {
    if (m.st) this.match.state = m.st;
    if (typeof m.tl === 'number') this.match.timeLeft = m.tl;
    if (typeof m.kt === 'number') this.match.killTarget = m.kt;
    this.match.winnerId = m.w ?? null;
  }

  _setState(state, detail = null) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state, detail);
  }

  _startPing() {
    this._stopPing();
    const beat = () => {
      if (!this.connected) return;
      this._pingSentAt = performance.now();
      // The previous round's measurement rides along, so the server can show
      // everyone's ping on the scoreboard without a second message type.
      this._send(MSG.PING, { c: Math.round(this._pingSentAt), rtt: this.ping || undefined });
    };
    beat();
    this._pingTimer = setInterval(beat, 2000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  dispose() { this.disconnect(); }
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Build an invite URL for a room, for the "copy link" button. */
export function inviteUrl(room) {
  const u = new URL(location.href);
  u.searchParams.set('room', room);
  u.hash = '';
  return u.toString();
}

/** Room code from the current URL, if someone followed an invite. */
export function roomFromUrl() {
  try {
    const r = new URL(location.href).searchParams.get('room');
    return r ? r.toUpperCase() : null;
  } catch { return null; }
}

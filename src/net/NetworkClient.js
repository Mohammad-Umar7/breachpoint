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
  MATCH_STATE, SP_KIND, PLAYER_MAX_HEALTH, sanitizeName,
} from './protocol.js';
import { DEFAULT_MAP_ID, isValidMapId } from './arena.js';
import {
  TEAM, DEFAULT_MODE_ID, isValidModeId, getMode,
} from './modes.js';

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
     * Where the game server lives, resolved in order of specificity:
     *
     *   VITE_SERVER_URL   a full url, e.g. wss://my-server.onrender.com
     *   VITE_SERVER_HOST  a bare hostname; wss:// is added
     *   (neither)         same host on port 8787, which is what running
     *                     `npm run dev` alongside `cd server && npm start`
     *                     gives you locally
     *
     * VITE_SERVER_HOST exists for Render's blueprint, which can inject another
     * service's hostname automatically but cannot prepend a scheme to it. That
     * one variable is what makes deployment need no manual wiring at all.
     */
    const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
    // `globalThis.location`, not `location`: read bare and unconditionally,
    // this threw in node and made the whole class impossible to unit test —
    // including the spawn/correction routing that caused the void flicker.
    const loc = globalThis.location;
    const secure = loc?.protocol === 'https:';
    this.url = url
      || env.VITE_SERVER_URL
      || (env.VITE_SERVER_HOST && `${secure ? 'wss' : 'ws'}://${env.VITE_SERVER_HOST}`)
      || `${secure ? 'wss' : 'ws'}://${loc?.hostname ?? 'localhost'}:8787`;

    /** Region actually chosen by pickRegion(), for the menu to display. */
    this.region = null;

    this.state = NET_STATE.OFFLINE;
    this.socket = null;
    this.selfId = null;
    this.room = null;
    /** The map the room we are in is playing. See _handleWelcome. */
    this.mapId = DEFAULT_MAP_ID;
    /** And which game is being played on it. */
    this.modeId = DEFAULT_MODE_ID;
    /** Our own team. TEAM.NONE in a free-for-all — see modes.js. */
    this.team = TEAM.NONE;
    /** team -> captures, or null outside a team mode. */
    this.teamScores = null;
    /** Both flags, as last reported. Empty in a free-for-all. */
    this.flags = [];
    this.name = 'OPERATOR';
    this.ping = 0;
    this.lastError = null;
    /** Diagnostics: how often the server has moved us against our will. */
    this.shotsClaimed = 0;
    this.hitsConfirmed = 0;
    this.corrections = 0;
    this.respawns = 0;

    /** Server-reported roster: id -> { id, name, kills, deaths, ping, alive } */
    this.players = new Map();
    /**
     * Our own flag bits, straight off the last snapshot. See _handleSnapshot —
     * `sample()` skips our row, so this is the only place they survive.
     */
    this.selfFlags = 0;
    this.match = { state: MATCH_STATE.WARMUP, timeLeft: 0, killTarget: 0, winnerId: null };

    /** @type {Array<{ts:number, at:number, players:Map}>} newest last */
    this.snapshots = [];
    this._clockOffset = null;   // serverTime - localTime
    /** Recent snapshot arrival gaps, for sizing the interpolation buffer. */
    this._gaps = [];
    this._lastArrivalAt = 0;
    /** Current interpolation delay in ms — adaptive, see _updateInterpDelay. */
    this.interpDelay = INTERP_DELAY_MS;
    this._inputSeq = 0;
    this._lastInputAt = 0;
    this._pingSentAt = 0;
    this._pingTimer = null;

    // --- callbacks, assigned by Game -------------------------------------
    this.onStateChange = null;   // (netState, detail)
    this.onWelcome = null;       // ({ id, room, spawn, players, match })
    this.onJoined = null;        // (playerSummary)
    this.onLeft = null;          // (id, name) — name captured before removal
    this.onHit = null;           // ({ victim, attacker, damage, part, hp, armor })
    this.onFire = null;          // ({ shooter, origin, direction, weapon })
    this.onKill = null;          // ({ victim, attacker, weapon, headshot })
    this.onScore = null;         // (rosterArray)
    this.onMatch = null;         // (matchState)
    this.onCorrection = null;    // ([x,y,z])  server rejected our position
    this.onRespawn = null;       // ([x,y,z])
    this.onSpawnPoint = null;    // ([x,y,z])  where we will come back, sent at death
    this.onFlags = null;         // ({ flags, event, by, byName, team, isSelf })
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
  /**
   * Choose the server to play on by measuring, not by guessing.
   *
   * This is how matchmakers pick a region: race a tiny request against every
   * candidate and keep the one that answers first. Round-trip time is the
   * thing that actually matters to a shooter, and it already accounts for
   * geography, routing and whether a server is awake — none of which can be
   * inferred from the player's timezone or IP with any reliability.
   *
   * Regions come from `public/regions.json`. If that file is absent — which is
   * the normal single-server case — this does nothing at all and the default
   * URL stands. Nothing depends on it succeeding.
   *
   * @returns {Promise<{name: string, url: string, ms: number}|null>}
   */
  /**
   * Who is playing what, right now, before we have a socket.
   *
   * Deliberately over plain HTTP and deliberately failure-tolerant: this feeds
   * a nice-to-have line on the map cards, and a menu that refused to open
   * because a stats request timed out would be a far worse bug than a missing
   * player count. Every failure path returns null and the caller shows nothing.
   *
   * @returns {Promise<{maps: object, publicPlayers: number}|null>}
   */
  async fetchPopulation(timeoutMs = 2000) {
    const http = String(this.url).replace(/^ws/, 'http');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${http}/health`, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      // An older server has no `maps` key at all. Treat that as "no data"
      // rather than as an empty server, which would claim every map is dead.
      if (!body || typeof body.maps !== 'object' || body.maps === null) return null;
      return { maps: body.maps, publicPlayers: body.publicPlayers ?? 0 };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async pickRegion(timeoutMs = 2500) {
    let regions;
    try {
      const res = await fetch('regions.json', { cache: 'no-store' });
      if (!res.ok) return null;
      regions = await res.json();
    } catch { return null; }
    if (!Array.isArray(regions) || regions.length === 0) return null;

    const probe = async (r) => {
      // /health is plain HTTP, so it can be timed before committing to a
      // WebSocket. wss:// maps to https:// on the same host.
      const http = String(r.url).replace(/^ws/, 'http');
      const started = performance.now();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${http}/health`, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error('unhealthy');
        return { name: r.name, url: r.url, ms: performance.now() - started };
      } finally {
        clearTimeout(t);
      }
    };

    const results = await Promise.allSettled(regions.map(probe));
    const alive = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!alive.length) return null;

    alive.sort((a, b) => a.ms - b.ms);
    const best = alive[0];
    this.url = best.url;
    this.region = best;
    return best;
  }

  connect({ name, room = null, quick = false, mapId = DEFAULT_MAP_ID,
    modeId = DEFAULT_MODE_ID } = {}) {
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
        this._send(MSG.JOIN, {
          n: this.name,
          r: room || undefined,
          // Quick match: let the server pick a public game with people in it,
          // rather than opening yet another empty private one.
          q: quick || undefined,
          // The map we WANT. An existing room keeps its own and tells us in
          // WELCOME, so this is a request, not an instruction.
          m: isValidMapId(mapId) ? mapId : DEFAULT_MAP_ID,
          g: isValidModeId(modeId) ? modeId : DEFAULT_MODE_ID,
          v: PROTOCOL_VERSION,
        });
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
    // Or the chassis from the last match is still in the registry the next one
    // syncs against
    // the room we have joined.
    this.snapshots.length = 0;
    this.selfId = null;
    this.selfFlags = 0;
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
    // A shot that hit NOTHING is still sent. The server relays gunfire to the
    // room from this message, so refusing to send a miss meant a missed shot
    // produced no muzzle flash, no tracer and no report for anyone else.
    if (!this.connected || !hits) return;
    // Counted so the F3 panel can separate "my client never claimed a hit"
    // (a local aiming / raycast problem) from "I claimed it and the server
    // refused" (a validation problem). Without that split, "my shots do
    // nothing" is unactionable.
    this.shotsClaimed++;
    this._send(MSG.SHOT, {
      q: ++this._inputSeq,
      o: [round2(origin.x), round2(origin.y), round2(origin.z)],
      d: [round3(direction.x), round3(direction.y), round3(direction.z)],
      w: weaponId,
      h: hits.map((h) => ({ v: h.victimId, pt: h.part })),
    });
  }

  requestRespawn() { if (this.connected) this._send(MSG.RESPAWN, {}); }

  /**
   * Ask to put a carried flag down.
   *
   * Nothing is changed locally. The flag's state comes back as a FLAG message
   * like every other change to it, so a refused drop — dead, not carrying,
   * wrong mode — simply does nothing rather than desyncing the world.
   */
  dropFlag() { if (this.connected) this._send(MSG.DROPFLAG, {}); }

  /**
   * Tell the server we picked up a health pack.
   *
   * Necessary because health is server-owned: healing only the local copy
   * lasted until the next authoritative update and no longer, so packs did
   * nothing in a match. The server clamps and rate-limits the amount.
   */
  /** @param kind 'health' | 'armor' — which pool the pickup tops up. */
  claimHeal(amount, kind = 'health') {
    if (this.connected && amount > 0) {
      this._send(MSG.HEAL, { a: Math.round(amount), k: kind });
    }
  }



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
    /*
     * The map the ROOM is playing, which may not be the one we asked for.
     *
     * Joining a friend's code means playing their map. The client has usually
     * built a world by now, so this is what tells it whether that world is the
     * right one — see Game._connect.
     */
    this.mapId = isValidMapId(msg.mp) ? msg.mp : DEFAULT_MAP_ID;
    this.modeId = isValidModeId(msg.gm) ? msg.gm : DEFAULT_MODE_ID;
    this.team = msg.you?.tm ?? TEAM.NONE;
    if (Array.isArray(msg.fl)) this.flags = msg.fl;
    this.players.clear();
    for (const p of msg.ps ?? []) this._upsert(p);
    if (msg.you) this._upsert(msg.you);
    if (msg.mt) this._applyMatch(msg.mt);
    this._setState(NET_STATE.CONNECTED);
    this._startPing();
    this.onWelcome?.({
      id: msg.id,
      room: msg.r,
      mapId: this.mapId,
      modeId: this.modeId,
      team: this.team,
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

      /*
       * Flags moved. Only ever sent on a CHANGE — a flag on its stand is
       * stationary and a carried one rides a body already in the snapshot, so
       * there is nothing to stream.
       */
      case MSG.FLAG:
        this.flags = Array.isArray(msg.f) ? msg.f : [];
        this.onFlags?.({
          flags: this.flags,
          event: msg.ev ?? null,
          by: msg.by ?? null,
          byName: msg.by != null ? this.nameOf(msg.by) : null,
          team: msg.tm ?? TEAM.NONE,
          isSelf: msg.by != null && msg.by === this.selfId,
        });
        break;

      case MSG.LEFT: {
        // Read the name BEFORE the delete below: a listener that wants to say
        // who left cannot look it up afterwards, and nameOf() would give it
        // the "SOMEONE" fallback.
        const goneName = this.nameOf(msg.id);
        this.players.delete(msg.id);
        // Purge from history too, or the leaver's body hangs in the world for
        // as long as the interpolation buffer holds them.
        for (const s of this.snapshots) s.players.delete(msg.id);
        this.onLeft?.(msg.id, goneName);
        break;
      }

      case MSG.HIT: {
        if (msg.a === this.selfId) this.hitsConfirmed++;
        const victim = this.players.get(msg.v);
        if (victim) victim.hp = msg.hp;
        this.onHit?.({
          victim: msg.v, attacker: msg.a, damage: msg.d, part: msg.pt, hp: msg.hp,
          // Absent on older servers, hence the null rather than a default — the
          // HUD leaves the bar alone rather than wiping it to zero.
          armor: typeof msg.ar === 'number' ? msg.ar : null,
          isSelfVictim: msg.v === this.selfId, isSelfAttacker: msg.a === this.selfId,
        });
        break;
      }

      /*
       * Somebody else fired. The server does not send this back to the
       * shooter, so anything arriving here belongs to another player.
       */
      case MSG.FIRE:
        this.onFire?.({
          shooter: msg.id,
          origin: msg.o,
          direction: msg.d,
          weapon: msg.w,
        });
        break;

      case MSG.KILL: {
        const victim = this.players.get(msg.v);
        if (victim) { victim.alive = false; victim.hp = 0; }
        this.onKill?.({
          victim: msg.v, attacker: msg.a, weapon: msg.w, headshot: !!msg.hs,
          victimName: this.nameOf(msg.v), attackerName: this.nameOf(msg.a),
          isSelfVictim: msg.v === this.selfId, isSelfAttacker: msg.a === this.selfId,
          // Streak state, counted by the server. Defaulted rather than left
          // undefined so an older server simply produces no announcements
          // instead of "undefined KILL STREAK".
          streak: typeof msg.st === 'number' ? msg.st : 0,
          multiKill: typeof msg.mk === 'number' ? msg.mk : 0,
          endedStreak: typeof msg.es === 'number' ? msg.es : 0,
        });
        break;
      }

      case MSG.SCORE:
        for (const [id, name, kills, deaths, ping, team, captures] of msg.ps ?? []) {
          const p = this._upsert({ id, n: name });
          p.kills = kills; p.deaths = deaths; p.ping = ping;
          p.team = team ?? TEAM.NONE;
          p.captures = captures ?? 0;
          if (id === this.selfId) this.team = p.team;
        }
        this.teamScores = msg.ts ?? null;
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
          /*
           * WHICH KIND OF PLACEMENT IS THIS? THE SERVER SAYS. WE DO NOT GUESS.
           *
           * A spawn and an anti-cheat correction arrive as the same message
           * shape and mean opposite things — see SP_KIND in protocol.js. This
           * used to be inferred from "did we think we were dead?", and falling
           * out of the world makes that true, so a refusal mid-fall was
           * executed as a respawn: the player was stood up, ALIVE, at the last
           * position the server had accepted, which is a point in open air off
           * the side of the map. Then they fell again. That is the flicker.
           *
           * The fallback keeps the old inference for a client talking to a
           * server that predates `spk`, so a half-rolled deployment is no
           * worse than it is today rather than newly broken.
           */
          const self = this.players.get(this.selfId);
          const kind = msg.spk ?? (
            (self && !self.alive) || this.isSelfDead?.() === true
              ? SP_KIND.SPAWN : SP_KIND.CORRECTION
          );

          if (kind === SP_KIND.SPAWN) {
            if (self) { self.alive = true; self.hp = PLAYER_MAX_HEALTH; }
            this.respawns++;
            this.onRespawn?.(msg.sp);
          } else {
            // Deliberately does NOT mark the roster alive. A correction is
            // about where you are, never about whether you are.
            this.corrections++;
            this.onCorrection?.(msg.sp);
          }
        }
        this.onMatch?.(this.match);
        break;

      case MSG.SPAWNPOINT:
        // Where we will come back, sent the moment we died so the countdown
        // can be spent at the spawn rather than over our own corpse.
        if (Array.isArray(msg.sp)) this.onSpawnPoint?.(msg.sp);
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
    this._updateInterpDelay(now);
    // The match clock. It arrives here rather than only on MSG.MATCH because
    // this is the message that actually repeats — see the note on the server's
    // snapshot. Guarded so a server that predates the field leaves the last
    // known value alone instead of blanking the HUD to undefined.
    if (typeof msg.tl === 'number') this.match.timeLeft = msg.tl;

    const players = new Map();
    for (const row of msg.p ?? []) {
      const [id, x, y, z, yaw, pitch, flags, weapon, hp] = row;
      players.set(id, { id, x, y, z, yaw, pitch, flags, weapon, hp });
      // Our own row, which sample() deliberately skips — it never interpolates
      // us — but which is the only authoritative word on flags the SERVER
      // grants rather than the client claiming, spawn protection being the one
      // that exists. Working it out locally from a timer would be a guess that
      // disagrees with the server exactly when it matters.
      if (id === this.selfId) this.selfFlags = flags;
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

  /**
   * Size the interpolation buffer from the network we actually have.
   *
   * The buffer only has to be large enough to cover the worst gap between
   * snapshot arrivals — that is the whole job. Every millisecond beyond that is
   * pure added lag on top of ping, because it is how far in the past other
   * players are drawn.
   *
   * A fixed 110 ms was the first implementation and it was badly mis-sized.
   * Measured against the deployed server: snapshots arrive every 33 ms with a
   * worst-case gap of 52 ms and only ~7 ms of jitter. So 110 ms was roughly
   * 60 ms of self-inflicted lag, on top of a 129 ms ping — the difference
   * between seeing an opponent 175 ms in the past and 120 ms.
   *
   * Tracking it instead means a good connection feels responsive while a bad
   * one still gets the cushion it needs. Deliberately quick to grow and slow
   * to shrink: under-buffering makes remote players freeze and jump, which is
   * far more objectionable than a little extra delay.
   */
  _updateInterpDelay(arrivedAt) {
    if (this._lastArrivalAt) {
      this._gaps.push(arrivedAt - this._lastArrivalAt);
      if (this._gaps.length > 40) this._gaps.shift();
    }
    this._lastArrivalAt = arrivedAt;
    if (this._gaps.length < 8) return;

    // Worst recent gap, not the mean: the buffer exists for the worst case.
    let worst = 0;
    for (const g of this._gaps) if (g > worst) worst = g;
    // 1.6x the worst gap, plus a small floor for decode and render timing.
    const want = Math.max(45, Math.min(220, worst * 1.6 + 10));
    this.interpDelay = want > this.interpDelay
      ? want                                             // grow immediately
      : this.interpDelay + (want - this.interpDelay) * 0.02;   // shrink gently
  }

  /** Server-clock time we should be rendering other players at. */
  renderTime(nowMs = performance.now()) {
    if (this._clockOffset === null) return null;
    return nowMs + this._clockOffset - this.interpDelay;
  }

  /**
   * The two snapshots either side of the render time, and how far between.
   *
   * Extracted so the bracket search has one implementation.
   * A second copy of this would agree with the first today and drift the first
   * time either was touched, and the symptom of two interpolators that
   *
   * @returns {{older: object, newer: object|null, span: number, k: number}|null}
   */
  _bracket(nowMs) {
    const target = this.renderTime(nowMs);
    if (target === null || this.snapshots.length === 0) return null;

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
    return { older, newer, span, k };
  }

  /**
   * Interpolated state of every OTHER player at the current render time.
   *
   * @returns {Map<number, {x,y,z,yaw,pitch,flags,weapon,hp,moving:number}>}
   */
  sample(nowMs = performance.now(), out = new Map()) {
    out.clear();
    const at = this._bracket(nowMs);
    if (!at) return out;
    const { older, newer, span, k } = at;

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
      p = {
        id, name: summary.n ?? `PLAYER ${id}`,
        kills: 0, deaths: 0, ping: 0, hp: 100, alive: true, team: TEAM.NONE,
      };
      this.players.set(id, p);
    }
    if (summary.n) p.name = summary.n;
    if (typeof summary.k === 'number') p.kills = summary.k;
    if (typeof summary.d === 'number') p.deaths = summary.d;
    if (typeof summary.hp === 'number') p.hp = summary.hp;
    if (typeof summary.a === 'boolean') p.alive = summary.a;
    if (summary.w) p.weapon = summary.w;
    if (typeof summary.tm === 'number') p.team = summary.tm;
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
    if (m.gm && isValidModeId(m.gm)) this.modeId = m.gm;
    if (m.ts !== undefined) this.teamScores = m.ts;
    this.match.modeId = this.modeId;
    this.match.teamScores = this.teamScores;
  }

  /** The mode definition for the room we are in. Never null. */
  get mode() { return getMode(this.modeId); }

  /** The flag a given team DEFENDS, or null outside a team mode. */
  flagOf(team) { return this.flags.find((f) => f.t === team) ?? null; }

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

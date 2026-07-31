/**
 * Breachpoint game server — free-for-all deathmatch.
 *
 * WHAT THIS IS
 * ------------
 * A relay with teeth. Each browser simulates its own player (same Rapier code
 * it used in single-player) and reports where it ended up; this server checks
 * the report is not absurd, owns everything that must not be client-decided,
 * and fans state out to the room 30 times a second.
 *
 * The server is the sole authority over:
 *   health, damage, who died, who killed whom, score, respawn timing,
 *   match state, and which spawn point you get.
 *
 * The client is trusted (with validation) about:
 *   its own position, orientation and animation flags.
 *
 * That split is the whole design. It means no headless physics is needed to
 * get a playable game, while the things players actually argue about — "I shot
 * first", "my score is wrong" — are decided in one place. Moving position
 * authority here later does not change the wire protocol; see protocol.js.
 *
 * RUNNING IT
 *   cd server && npm install && npm start        # ws://localhost:8787
 *   PORT=8787 node index.js
 *
 * Deployment notes are in server/README.md.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

import {
  MSG, FLAG, TICK_MS, MATCH_STATE, MATCH_RULES, LIMITS, PLAYER_MAX_HEALTH,
  PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
  isValidRoomCode, sanitizeName, damageFor,
} from '../src/net/protocol.js';
import { pickSpawn, isInsideArena } from '../src/net/arena.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';

const PORT = Number(process.env.PORT || 8787);

/**
 * Weapon lookup for validation, derived from the SAME definitions the client
 * uses. A hand-maintained copy here would drift the moment a weapon was
 * rebalanced, and the failure mode is legitimate hits being silently rejected.
 */
const WEAPON_BY_ID = new Map(WEAPON_DEFS.map((w) => [w.id, w]));

/** Shortest interval between shots this weapon could legitimately produce. */
function minFireInterval(weapon) {
  const rpm = weapon.rpm ?? 600;
  return (60 / rpm) * LIMITS.fireIntervalSlack;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
let nextPlayerId = 1;

class Player {
  constructor(socket, name) {
    this.id = nextPlayerId++;
    this.socket = socket;
    this.name = name;
    this.room = null;

    this.x = 0; this.y = 0; this.z = 0;
    this.yaw = 0; this.pitch = 0;
    this.flags = 0;
    this.weapon = 'rifle';

    this.hp = PLAYER_MAX_HEALTH;
    this.alive = false;          // false until the first spawn
    this.respawnAt = 0;
    this.kills = 0;
    this.deaths = 0;
    this.ping = 0;

    this.lastInputSeq = -1;
    this.lastInputAt = 0;
    /** Movement token bucket, in metres. See LIMITS.moveBurstMetres. */
    this.moveBudget = LIMITS.moveBurstMetres;
    /** weaponId -> { tokens, at } fire-rate bucket. See LIMITS.shotBurst. */
    this.shotBudget = new Map();
    /** Spawn point held from death until respawn. See Room.reserveSpawn. */
    this.reservedSpawn = null;
    this.lastSeenAt = Date.now();
    this.lastPongAt = 0;

    // Rolling rate counters, reset every second by the room tick.
    this.msgCount = 0;
    this.inputCount = 0;

    /** Short history of past positions, for rewinding shot validation. */
    this.history = [];
  }

  summary() {
    return {
      id: this.id, n: this.name, k: this.kills, d: this.deaths,
      hp: this.hp, a: this.alive, w: this.weapon,
    };
  }

  send(type, payload) {
    if (this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify({ t: type, ...payload }));
    } catch {
      /* a send failure means the socket is going away; the close handler
         will clean up. Nothing useful to do here. */
    }
  }

  /**
   * Record a position sample so a shot can be judged against where the victim
   * actually was when the shooter fired, not where they are now. The client
   * renders everyone INTERP_DELAY_MS in the past, so without this every shot
   * at a moving target would be judged against a position the shooter never
   * saw.
   */
  pushHistory(now) {
    this.history.push({ t: now, x: this.x, y: this.y, z: this.z });
    // ~1 s is far more than enough to cover interpolation delay plus RTT.
    const cutoff = now - 1000;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }

  /** Interpolated position at a past time, for lag-compensated hit checks. */
  positionAt(when) {
    const h = this.history;
    if (!h.length) return { x: this.x, y: this.y, z: this.z };
    if (when >= h[h.length - 1].t) return h[h.length - 1];
    if (when <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= when && when <= h[i].t) {
        const a = h[i - 1], b = h[i];
        const span = b.t - a.t || 1;
        const k = (when - a.t) / span;
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
        };
      }
    }
    return h[h.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
class Room {
  constructor(code) {
    this.code = code;
    /**
     * Public rooms are the pool Quick Match draws from. Rooms made by CREATE
     * MATCH stay private, so sharing a code still means only the people you
     * gave it to can turn up.
     */
    this.isPublic = false;
    this.players = new Map();
    this.state = MATCH_STATE.WARMUP;
    this.endsAt = 0;
    this.restartAt = 0;
    this.winnerId = null;
    this.startedAt = Date.now();
    this.rateWindowAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  get size() { return this.players.size; }

  add(player) {
    player.room = this;
    this.players.set(player.id, player);
    // Spawn quietly: WELCOME carries the position itself. Emitting a separate
    // MATCH before WELCOME meant a joining client received its spawn point
    // before it even knew its own id, and had nowhere to put it.
    this.spawn(player, { announce: false });

    player.send(MSG.WELCOME, {
      id: player.id,
      r: this.code,
      you: player.summary(),
      ps: [...this.players.values()].filter((p) => p !== player).map((p) => p.summary()),
      mt: this.matchPayload(),
      sp: [player.x, player.y, player.z],
      hz: 1000 / TICK_MS,
    });
    this.broadcast(MSG.JOINED, { p: player.summary() }, player);
    this.evaluateMatchState();
    this.broadcastScore();
  }

  remove(player) {
    if (!this.players.delete(player.id)) return;
    player.room = null;
    this.broadcast(MSG.LEFT, { id: player.id });
    this.evaluateMatchState();
    this.broadcastScore();
  }

  broadcast(type, payload, except = null) {
    // `payload` must never contain a key called `t` — it would overwrite the
    // message type and the frame would arrive unroutable. Cheap to assert, and
    // the failure it prevents is near-invisible from the client side.
    if (payload && Object.hasOwn(payload, 't')) {
      throw new Error(`broadcast(${type}): payload key "t" would shadow the message type`);
    }
    const frame = JSON.stringify({ t: type, ...payload });
    for (const p of this.players.values()) {
      if (p === except || p.socket.readyState !== 1) continue;
      try { p.socket.send(frame); } catch { /* closing */ }
    }
  }

  matchPayload() {
    const tl = this.state === MATCH_STATE.LIVE
      ? Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000))
      : MATCH_RULES.timeLimitSec;
    return { st: this.state, tl, kt: MATCH_RULES.killTarget, w: this.winnerId };
  }

  broadcastScore() {
    this.broadcast(MSG.SCORE, {
      ps: [...this.players.values()].map((p) => [p.id, p.name, p.kills, p.deaths, p.ping]),
    });
  }

  /** A match needs two people. Below that it idles in warmup so a lone player
   *  can still move around and shoot without the clock running. */
  evaluateMatchState() {
    const live = this.size >= 2;
    if (this.state === MATCH_STATE.WARMUP && live) {
      this.state = MATCH_STATE.LIVE;
      this.endsAt = Date.now() + MATCH_RULES.timeLimitSec * 1000;
      for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
      this.broadcast(MSG.MATCH, this.matchPayload());
    } else if (this.state === MATCH_STATE.LIVE && !live) {
      this.state = MATCH_STATE.WARMUP;
      this.winnerId = null;
      this.broadcast(MSG.MATCH, this.matchPayload());
    }
  }

  /**
   * Pick where a player will come back, without moving them yet.
   *
   * Reserved at the moment of death so the victim can be told immediately and
   * stand at their spawn during the countdown, rather than at the corpse.
   */
  reserveSpawn(player) {
    const at = pickSpawn(
      [...this.players.values()]
        .filter((p) => p !== player)
        .map((p) => ({ x: p.x, z: p.z, alive: p.alive })),
    );
    player.reservedSpawn = at;
    return at;
  }

  spawn(player, { announce = true } = {}) {
    // Honour the point reserved at death, so the player comes back exactly
    // where they have been waiting rather than being moved a second time.
    const at = player.reservedSpawn ?? this.reserveSpawn(player);
    player.reservedSpawn = null;
    player.x = at.x; player.y = at.y; player.z = at.z;
    player.hp = PLAYER_MAX_HEALTH;
    player.alive = true;
    player.flags = 0;
    player.respawnAt = 0;
    player.history.length = 0;
    // The jump to the spawn point is the server's own doing, so it must not be
    // charged to the player. Clearing lastInputAt skips the check entirely on
    // their next input, and refills the bucket for the run back into the map.
    player.lastInputAt = 0;
    player.moveBudget = LIMITS.moveBurstMetres;
    if (announce) {
      player.send(MSG.MATCH, { ...this.matchPayload(), sp: [at.x, at.y, at.z] });
    }
  }

  /**
   * Apply damage. The server decides everything here — the client only ever
   * claims "I hit player N in the head with weapon W", never how much it hurt.
   */
  applyDamage(victim, attacker, weapon, part, distance = null) {
    if (!victim.alive || this.state === MATCH_STATE.OVER) return;
    if (victim === attacker) return;

    const raw = damageFor(weapon, part, distance);
    const dmg = Math.min(raw, LIMITS.maxDamagePerHit);
    victim.hp -= dmg;

    const headshot = part === 'head';
    if (victim.hp > 0) {
      this.broadcast(MSG.HIT, {
        v: victim.id, a: attacker.id, d: Math.round(dmg), pt: part, hp: Math.round(victim.hp),
      });
      return;
    }

    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = Date.now() + MATCH_RULES.respawnDelaySec * 1000;
    if (this.state === MATCH_STATE.LIVE) attacker.kills++;

    this.broadcast(MSG.KILL, {
      v: victim.id, a: attacker.id, w: weapon.id, hs: headshot,
    });

    // Tell the victim — and only the victim — where they will come back, so
    // they can wait out the countdown standing at their spawn instead of at
    // the place they were shot. See MSG.SPAWNPOINT.
    const at = this.reserveSpawn(victim);
    victim.send(MSG.SPAWNPOINT, { sp: [at.x, at.y, at.z] });

    this.broadcastScore();

    if (this.state === MATCH_STATE.LIVE && attacker.kills >= MATCH_RULES.killTarget) {
      this.endMatch(attacker.id);
    }
  }

  endMatch(winnerId) {
    this.state = MATCH_STATE.OVER;
    this.winnerId = winnerId;
    this.restartAt = Date.now() + MATCH_RULES.postMatchSec * 1000;
    this.broadcast(MSG.MATCH, this.matchPayload());
  }

  restartMatch() {
    this.winnerId = null;
    this.state = MATCH_STATE.WARMUP;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0;
      this.spawn(p);
    }
    this.evaluateMatchState();
    this.broadcastScore();
  }

  tick() {
    const now = Date.now();

    // Drop connections that have gone quiet, and reset the per-second rate
    // counters used for flood protection.
    const windowElapsed = now - this.rateWindowAt >= 1000;
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeenAt > LIMITS.timeoutSec * 1000) {
        p.send(MSG.DENIED, { why: 'timed out' });
        try { p.socket.close(4000, 'timeout'); } catch { /* already gone */ }
        this.remove(p);
        continue;
      }
      if (windowElapsed) { p.msgCount = 0; p.inputCount = 0; }
      if (p.alive) p.pushHistory(now);
      if (!p.alive && p.respawnAt && now >= p.respawnAt) this.spawn(p);
    }
    if (windowElapsed) this.rateWindowAt = now;

    if (this.state === MATCH_STATE.LIVE && now >= this.endsAt) {
      let best = null;
      for (const p of this.players.values()) {
        if (!best || p.kills > best.kills) best = p;
      }
      this.endMatch(best ? best.id : null);
    } else if (this.state === MATCH_STATE.OVER && now >= this.restartAt) {
      this.restartMatch();
    }

    if (!this.size) return;

    // Snapshot. Positions are rounded to centimetres and angles to ~0.06 deg:
    // beyond that is noise the player cannot see, and it costs bandwidth 30
    // times a second per player.
    const r2 = (v) => Math.round(v * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.broadcast(MSG.SNAPSHOT, {
      ts: now,
      p: [...this.players.values()].map((p) => [
        p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch),
        p.flags | (p.alive ? 0 : FLAG.DEAD), p.weapon, Math.round(p.hp),
      ]),
    });
  }

  dispose() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------
// Room registry
// ---------------------------------------------------------------------------
const rooms = new Map();

function makeRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Astronomically unlikely with 32^5 codes, but never loop forever.
  return `R${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

/**
 * Quick match: drop the player into a public game with other people in it.
 *
 * Deliberately fills the FULLEST room that still has room, rather than
 * spreading players evenly. Even distribution is the intuitive choice and it
 * is wrong — it produces several half-empty matches where everyone is alone,
 * which is the failure mode that kills a small game's population. Packing them
 * together means the first two people to click Play end up in the same match.
 *
 * A room is only a candidate while it is worth joining: not full, not over,
 * and not already deep into its round.
 */
function findPublicRoom() {
  let best = null;
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    if (room.size >= MATCH_RULES.maxPlayers) continue;
    if (room.state === MATCH_STATE.OVER) continue;
    if (!best || room.size > best.size) best = room;
  }
  return best;
}

function getOrCreateRoom(requested, quick = false) {
  if (requested) {
    const code = requested.toUpperCase();
    if (!isValidRoomCode(code)) return { error: 'that room code is not valid' };
    const existing = rooms.get(code);
    if (existing) {
      if (existing.size >= MATCH_RULES.maxPlayers) return { error: 'that match is full' };
      return { room: existing };
    }
    // Joining a code that does not exist yet creates it, so an invite link
    // works whether or not the host got there first.
    const room = new Room(code);
    rooms.set(code, room);
    return { room };
  }

  if (quick) {
    const open = findPublicRoom();
    if (open) return { room: open };
    // Nobody to join — open a public one so the next person to press Play
    // lands here rather than starting yet another empty match.
    const room = new Room(makeRoomCode());
    room.isPublic = true;
    rooms.set(room.code, room);
    return { room };
  }

  // CREATE MATCH: private by definition — you get a code to share, and quick
  // match will never drop a stranger into it.
  const room = new Room(makeRoomCode());
  rooms.set(room.code, room);
  return { room };
}

function reapRoom(room) {
  if (room.size > 0) return;
  room.dispose();
  rooms.delete(room.code);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleInput(player, msg) {
  const room = player.room;
  if (!room) return;

  // Stale or duplicate input: UDP-style reordering does not happen over a
  // WebSocket, but a reconnect can replay, so sequence is still checked.
  if (typeof msg.q === 'number' && msg.q <= player.lastInputSeq) return;

  const p = msg.p;
  if (!Array.isArray(p) || p.length !== 3) return;
  const [x, y, z] = p;
  if (![x, y, z].every(Number.isFinite)) return;

  /**
   * Every rejection tells the client where it actually is.
   *
   * Silently dropping a bad input is worse than it sounds: the browser keeps
   * simulating forward from a position the server never accepted, so the two
   * diverge without limit and the player rubber-bands with no idea why. One
   * authoritative snap-back costs a single message and resynchronises them.
   */
  const reject = () => {
    player.send(MSG.MATCH, {
      ...room.matchPayload(), sp: [player.x, player.y, player.z],
    });
  };

  // Outside the arena by a wide margin — impossible through normal play.
  if (!isInsideArena(x, y, z)) { reject(); return; }

  const now = Date.now();
  if (player.alive && player.lastInputAt) {
    const dt = Math.max(0.001, (now - player.lastInputAt) / 1000);
    const dxz = Math.hypot(x - player.x, z - player.z);

    // Refill the movement bucket for the time that actually elapsed, then
    // charge this step against it.
    //
    // This deliberately does NOT compute dxz/dt. Arrival times are not send
    // times: the network bunches packets, so two perfectly legal steps can
    // land microseconds apart and read as an impossible speed. Budgeting over
    // real elapsed time is immune to that, because the time a delayed packet
    // spent in flight is credited to the bucket it then spends. Sustained
    // cheating still drains the bucket and gets caught.
    player.moveBudget = Math.min(
      LIMITS.moveBurstMetres,
      player.moveBudget + LIMITS.maxHorizontalSpeed * dt,
    );

    // The teleport check stays per-step, but has to scale with the gap: after
    // a one-second stall a sprinting player has legitimately covered 8.9 m,
    // which a fixed 8 m ceiling would reject.
    const allowedStep = Math.max(
      LIMITS.maxStepDistance,
      LIMITS.maxHorizontalSpeed * dt * 1.5,
    );
    if (dxz > allowedStep || dxz > player.moveBudget) { reject(); return; }
    player.moveBudget -= dxz;
  }

  player.lastInputSeq = typeof msg.q === 'number' ? msg.q : player.lastInputSeq;
  player.lastInputAt = now;
  player.x = x; player.y = y; player.z = z;
  if (Number.isFinite(msg.y)) player.yaw = msg.y;
  if (Number.isFinite(msg.a)) player.pitch = msg.a;
  if (Number.isFinite(msg.f)) player.flags = msg.f & 0x1ff;
  if (typeof msg.w === 'string' && WEAPON_BY_ID.has(msg.w)) player.weapon = msg.w;
}

function handleShot(player, msg) {
  const room = player.room;
  if (!room || !player.alive) return;
  if (room.state === MATCH_STATE.OVER) return;

  const weapon = WEAPON_BY_ID.get(typeof msg.w === 'string' ? msg.w : player.weapon);
  if (!weapon) return;

  // Rate limit per weapon, so switching weapons cannot be used to fire faster
  // than any single one allows.
  //
  // A token bucket, NOT a minimum gap between arrivals. The server has no way
  // to know when the trigger was actually pulled — only when the message got
  // here — and a network that briefly delays one packet delivers it together
  // with the next. Judged on arrival gaps that reads as firing too fast, and
  // the round is dropped with nothing sent back, so the shooter sees their
  // bullets pass through the target and do nothing. See LIMITS.shotBurst.
  const now = Date.now();
  const rec = player.shotBudget.get(weapon.id) ?? { tokens: LIMITS.shotBurst, at: now };
  const elapsed = Math.max(0, (now - rec.at) / 1000);
  const allowedPerSec = 1 / minFireInterval(weapon);
  rec.tokens = Math.min(LIMITS.shotBurst, rec.tokens + allowedPerSec * elapsed);
  rec.at = now;
  if (rec.tokens < 1) { player.shotBudget.set(weapon.id, rec); return; }
  rec.tokens -= 1;
  player.shotBudget.set(weapon.id, rec);

  const hits = Array.isArray(msg.h) ? msg.h.slice(0, 12) : [];
  if (!hits.length) return;

  // Judge against where victims were when the shooter fired, allowing for the
  // fact that the shooter was rendering them INTERP_DELAY_MS in the past.
  const rewindTo = now - Math.min(400, player.ping + 110);
  const origin = Array.isArray(msg.o) && msg.o.length === 3 ? msg.o : null;

  const claimed = new Set();
  for (const hit of hits) {
    const victimId = hit && hit.v;
    const victim = room.players.get(victimId);
    if (!victim || victim === player || !victim.alive) continue;
    // One shot may not damage the same victim twice (a pellet spread claims
    // several hits, but each is checked and capped by weapon damage anyway).
    if (weapon.pellets === undefined || weapon.pellets <= 1) {
      if (claimed.has(victimId)) continue;
      claimed.add(victimId);
    }

    const part = hit.pt === 'head' || hit.pt === 'limb' ? hit.pt : 'torso';

    // How far away the victim actually was. Used twice: to reject impossible
    // claims, and to scale the damage — the distance was already being
    // measured here and then thrown away, which is why nothing had falloff.
    let dist = null;
    if (origin) {
      const was = victim.positionAt(rewindTo);
      dist = Math.hypot(origin[0] - was.x, origin[1] - was.y, origin[2] - was.z);
      const maxRange = (weapon.range ?? 150) * LIMITS.rangeSlack;
      if (dist > maxRange) continue;
    }

    room.applyDamage(victim, player, weapon, part, dist);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  // A health endpoint so Fly.io (or any host) can tell the process is alive,
  // and so you can eyeball live rooms from a browser.
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
      uptimeSec: Math.round(process.uptime()),
    }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });

wss.on('connection', (socket) => {
  let player = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;   // malformed frames are ignored, not fatal
    }
    if (!msg || typeof msg.t !== 'string') return;

    // Flood protection before anything else touches game state.
    if (player) {
      player.lastSeenAt = Date.now();
      if (++player.msgCount > LIMITS.maxMessageHz) {
        player.send(MSG.DENIED, { why: 'too many messages' });
        socket.close(4001, 'flood');
        return;
      }
    }

    switch (msg.t) {
      case MSG.JOIN: {
        if (player) return;                       // already joined
        if (msg.v !== PROTOCOL_VERSION) {
          socket.send(JSON.stringify({
            t: MSG.DENIED,
            why: 'your game is out of date — reload the page',
          }));
          socket.close(4002, 'version');
          return;
        }
        const { room, error } = getOrCreateRoom(
          typeof msg.r === 'string' && msg.r ? msg.r : null,
          msg.q === true,          // quick match
        );
        if (error) {
          socket.send(JSON.stringify({ t: MSG.DENIED, why: error }));
          socket.close(4003, 'join refused');
          return;
        }
        player = new Player(socket, sanitizeName(msg.n));
        room.add(player);
        break;
      }

      case MSG.INPUT:
        if (!player) return;
        if (++player.inputCount > LIMITS.maxInputHz) return;   // throttle, don't kick
        handleInput(player, msg);
        break;

      case MSG.SHOT:
        if (player) handleShot(player, msg);
        break;

      case MSG.RESPAWN:
        if (player && player.room && !player.alive && Date.now() >= player.respawnAt) {
          player.room.spawn(player);
        }
        break;

      case MSG.NAME:
        if (player) {
          player.name = sanitizeName(msg.n, player.name);
          player.room?.broadcastScore();
        }
        break;

      case MSG.PING:
        if (player) {
          // Round-trip is measured by the client; the server just echoes and
          // records the client's own estimate for the scoreboard.
          if (Number.isFinite(msg.rtt)) player.ping = Math.min(999, Math.round(msg.rtt));
          // Answer at most twice a second. A client that replies to our PONG
          // with another PING creates a closed loop that saturates the socket —
          // which is exactly the bug the first version of the browser client
          // had. Never let a client's mistake become the server's problem.
          const nowMs = Date.now();
          if (nowMs - (player.lastPongAt ?? 0) >= 500) {
            player.lastPongAt = nowMs;
            player.send(MSG.PONG, { c: msg.c, s: nowMs });
          }
        }
        break;

      default:
        break;
    }
  });

  socket.on('close', () => {
    if (!player) return;
    const room = player.room;
    if (room) { room.remove(player); reapRoom(room); }
    player = null;
  });

  socket.on('error', () => { /* close will follow */ });
});

httpServer.listen(PORT, () => {
  console.log(`[breachpoint] listening on :${PORT}  (protocol v${PROTOCOL_VERSION})`);
  console.log(`[breachpoint] ${WEAPON_BY_ID.size} weapons loaded from WeaponDefinitions.js`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[breachpoint] ${sig} — closing`);
    for (const room of rooms.values()) room.dispose();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

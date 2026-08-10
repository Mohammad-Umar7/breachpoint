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
  PLAYER_MAX_ARMOR, PLAYER_START_ARMOR, ARMOR_ABSORB,
  PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
  MULTIKILL_WINDOW_MS, STREAK_ANNOUNCE_AT, SP_KIND,
  isValidRoomCode, sanitizeName, damageFor,
} from '../src/net/protocol.js';
import {
  pickSpawn, isInsideArena, isValidMapId, DEFAULT_MAP_ID, arenaFor, baseSpot,
  voidRescueY,
} from '../src/net/arena.js';
import {
  TEAM, PLAYING_TEAMS, TEAM_NAME, opposingTeam, sameTeam,
  FLAG_STATE, FLAG_EVENT, DEFAULT_MODE_ID, isValidModeId, getMode,
} from '../src/net/modes.js';
import { WEAPON_DEFS, HAZARD_DEFS } from '../src/weapons/WeaponDefinitions.js';

/** Looked up once: the kill plane is checked on every input from every player. */
const VOID_HAZARD = HAZARD_DEFS.find((h) => h.id === 'void');

/**
 * How long one fall stays one fall. See Room.recoverFromVoid.
 *
 * It only has to outlast a round trip, because a client that got its rescue
 * reports itself above the plane and clears the latch outright — this is what
 * happens when it did NOT get it. A second is far longer than any playable ping
 * and short enough that a genuinely stranded client is retried while they are
 * still wondering what happened rather than after they have given up.
 */
const VOID_RESCUE_COOLDOWN_MS = 1000;

const PORT = Number(process.env.PORT || 8787);

/**
 * Weapon lookup for validation, derived from the SAME definitions the client
 * uses. A hand-maintained copy here would drift the moment a weapon was
 * rebalanced, and the failure mode is legitimate hits being silently rejected.
 */
const WEAPON_BY_ID = new Map(
  [...WEAPON_DEFS, ...HAZARD_DEFS].map((w) => [w.id, w]),
);

/** The subset a player may actually be holding — hazards are not carryable. */
const HELD_WEAPON_IDS = new Set(WEAPON_DEFS.map((w) => w.id));

/**
 * How long after a DELIBERATE drop the dropper is ignored by their own flag.
 *
 * Long enough to walk off it, short enough that a pass that goes wrong is not
 * a punishment. Only ever applies to the player who pressed the key.
 */
const FLAG_DROP_LOCKOUT_MS = 2000;

/** Centimetre rounding. Beyond this is noise nobody can see, and it is sent
 *  thirty times a second per player. */
const r2 = (v) => Math.round(v * 100) / 100;
/** And ~0.06 degrees for angles, for the same reason. */
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Shortest interval between shots this weapon could legitimately produce. */
function minFireInterval(weapon) {
  const rpm = weapon.rpm ?? 600;
  return (60 / rpm) * LIMITS.fireIntervalSlack;
}

// ---------------------------------------------------------------------------
// Lag compensation, for anything with an { x, y, z, history }
// ---------------------------------------------------------------------------
/*
 * Free functions rather than methods, because they are shared by everything
 * at and both have to be judged against where they were when the trigger was
 * pulled. Two copies of this would be two rewind windows that agree today and
 * drift the first time either is touched — and the symptom of a rewind that is
 * subtly wrong is not an error, it is bullets that pass through a target the
 * shooter watched themselves hit.
 */

/**
 * Record a position sample so a shot can be judged against where the victim
 * actually was when the shooter fired, not where they are now. The client
 * renders everyone INTERP_DELAY_MS in the past, so without this every shot at
 * a moving target would be judged against a position the shooter never saw.
 */
function pushHistory(entity, now) {
  entity.history.push({ t: now, x: entity.x, y: entity.y, z: entity.z });
  // ~1 s is far more than enough to cover interpolation delay plus RTT.
  const cutoff = now - 1000;
  while (entity.history.length && entity.history[0].t < cutoff) entity.history.shift();
}

/** Interpolated position at a past time, for lag-compensated hit checks. */
function positionAt(entity, when) {
  const h = entity.history;
  if (!h.length) return { x: entity.x, y: entity.y, z: entity.z };
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
    this.armor = PLAYER_START_ARMOR;
    this.alive = false;          // false until the first spawn
    /** Earliest a RESPAWN request is honoured. See MATCH_RULES.respawnDelaySec. */
    this.respawnAt = 0;
    /**
     * And when we put them back whether they ask or not.
     *
     * Separate from `respawnAt` because the client is the one that decides its
     * own death sequence is finished and asks. This is only the backstop for a
     * client that never says anything at all.
     */
    this.forceRespawnAt = 0;
    this.kills = 0;
    this.deaths = 0;
    /** Flags carried home. Zero in a mode without flags, and reported anyway
     *  so the scoreboard never has to ask which mode it is in. */
    this.captures = 0;
    this.ping = 0;
    /**
     * TEAM.NONE in a free-for-all, and that is a value rather than a gap —
     * see the note on TEAM. Assigned once on join and kept for the session, so
     * a player is not shuffled between sides mid-match.
     */
    this.team = TEAM.NONE;
    /**
     * Server time until which this player cannot be hurt. Set on spawn, and
     * cleared the moment they pull a trigger. See MATCH_RULES.spawnProtectSec.
     */
    this.protectedUntil = 0;
    /** Kills without dying. Reset by death and by a match restart. */
    this.streak = 0;
    /** Kills inside MULTIKILL_WINDOW_MS, and when the last one landed. */
    this.multiKill = 0;
    this.lastKillAt = 0;

    this.lastInputSeq = -1;
    this.lastInputAt = 0;
    /** Movement token bucket, in metres. See LIMITS.moveBurstMetres. */
    this.moveBudget = LIMITS.moveBurstMetres;
    /** weaponId -> { tokens, at } fire-rate bucket. See LIMITS.shotBurst. */
    this.shotBudget = new Map();
    /** Spawn point held from death until respawn. See Room.reserveSpawn. */
    this.reservedSpawn = null;
    /**
     * When we last pulled this player out of the void. See Room.recoverFromVoid.
     *
     * A fall is ONE event, but the client reports it about sixty times a second
     * for a whole round trip before it can possibly know we have moved it.
     * Without this, every one of those reports was a fresh rescue to a fresh
     * random spawn point.
     */
    this.voidRescuedAt = 0;
    /** Pickup claim timestamps, one per pool. See handleHeal. */
    this.lastHealAt = 0;
    this.lastArmorAt = 0;
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
      hp: this.hp, a: this.alive, w: this.weapon, tm: this.team,
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

  pushHistory(now) { pushHistory(this, now); }

  positionAt(when) { return positionAt(this, when); }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
class Room {
  constructor(code, mapId = DEFAULT_MAP_ID, modeId = DEFAULT_MODE_ID) {
    this.code = code;
    /**
     * Which map this room is playing.
     *
     * Fixed for the life of the room and set by whoever opened it. Spawn
     * points and arena bounds both come from it, so it cannot change under a
     * match in progress without teleporting everybody into geometry.
     */
    this.mapId = isValidMapId(mapId) ? mapId : DEFAULT_MAP_ID;
    /**
     * Public rooms are the pool Quick Match draws from. Rooms made by CREATE
     * MATCH stay private, so sharing a code still means only the people you
     * gave it to can turn up.
     */
    /**
     * What winning means here. Fixed for the life of the room, like the map:
     * changing it mid-match would rescore a game already in progress.
     */
    this.modeId = isValidModeId(modeId) ? modeId : DEFAULT_MODE_ID;
    this.mode = getMode(this.modeId);
    /** team -> captures. Only meaningful in a team mode. */
    this.teamScores = { [TEAM.RED]: 0, [TEAM.BLUE]: 0 };
    /**
     * team -> flag. Keyed by the team that OWNS it, so `flags.get(TEAM.RED)`
     * is the flag Red defends and Blue is trying to take.
     */
    this.flags = new Map();

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

  /**
   * Put a joiner on the smaller side, breaking ties toward RED.
   *
   * Balanced by HEAD COUNT rather than by score: a team that is losing badly
   * is not helped by being handed the next arrival, and shuffling people to
   * even out a scoreline is how you end up switching somebody's team while
   * they are carrying a flag.
   */
  assignTeam(player) {
    if (!this.mode.teamBased) { player.team = TEAM.NONE; return; }
    const count = { [TEAM.RED]: 0, [TEAM.BLUE]: 0 };
    for (const p of this.players.values()) {
      if (p !== player && count[p.team] !== undefined) count[p.team]++;
    }
    player.team = count[TEAM.BLUE] < count[TEAM.RED] ? TEAM.BLUE : TEAM.RED;
  }

  /**
   * Get a player out from under the map. NEVER FAILS, whatever the match is
   * doing.
   *
   * The first two attempts at this both routed the fall through
   * `applyDamage`, and both left the player hanging in the void — because
   * that function opens with `if (!victim.alive || this.state ===
   * MATCH_STATE.OVER) return;`. Alone in a room the match never runs, so the
   * damage was discarded in silence: the server still had them alive and
   * standing under the world, while their own client had zeroed its health
   * from the fall and was showing WAITING for a death the server never
   * agreed had happened. Nothing was going to break that, ever.
   *
   * So the death is now the OPTIONAL half and getting out is the guaranteed
   * one. If a match is genuinely running the fall costs a life, which is what
   * it should cost; if it is not, there is no life to take and they are
   * simply put back. Either way they end up somewhere they can stand, which
   * is the only part the player actually cares about.
   */
  recoverFromVoid(player) {
    /*
     * ONE FALL IS ONE RESCUE. This guard is the whole of that.
     *
     * A fall is a single event to the player and a stream of events to us: the
     * client reports its position about sixty times a second, and for one full
     * round trip after it goes under the plane every one of those reports is
     * still the old falling position, because the message that moves it has
     * not arrived yet. Each was treated as a brand new fall — so a single step
     * off the edge of OUTPOST ran this five to fifteen times, and `spawn`
     * picks the point furthest from the living each time it is asked, which
     * with nobody else in the room means a different one almost every time.
     *
     * The player saw exactly what that is: put back on a spawn, then flung
     * across the map, then another, then finally still. It reads as "I am back,
     * no I am somewhere else, now I am back again", and it lasts as long as the
     * round trip does — a fifth of a second on a LAN and about a second on a
     * hosted server, which is where it was reported from.
     *
     * Worse in a live match, where it is not only cosmetic: the rescue that
     * finds a LIVE player takes a life. Alternating spawn and kill down this
     * path charged several deaths for one fall.
     *
     * Cleared the instant the client reports itself above the plane — see
     * `handleInput` — so a second genuine fall is answered immediately and this
     * timeout is only ever the backstop for a client whose rescue went missing.
     */
    const now = Date.now();
    if (now - player.voidRescuedAt < VOID_RESCUE_COOLDOWN_MS) return;
    player.voidRescuedAt = now;

    /*
     * Take the life ONLY if there is a running match to take it in, and only
     * if it actually killed them — then stop, because the ordinary respawn
     * flow owns them from that point and putting them back here as well would
     * cut their death short.
     */
    if (player.alive && this.state === MATCH_STATE.LIVE) {
      this.applyDamage(player, player, VOID_HAZARD, 'body');
      if (!player.alive) return;
    }
    /*
     * AND PUT THEM BACK, WHATEVER STATE THEY ARE IN. No `alive` check.
     *
     * That check is what broke the version before this one. A player alone in
     * a room has never formally spawned, so `alive` is FALSE the whole time
     * they are wandering around in warmup — and guarding on it meant the one
     * player who reported this bug was the exact one it did nothing for.
     *
     * `spawn` is announced, which is also not optional: `announce: false`
     * skips the MATCH carrying `sp`, and that message is the ONLY thing that
     * moves a client. Suppressing it teleports a player who, on their own
     * screen, is still hanging under the map — the bug, recreated by its fix.
     */
    player.reservedSpawn = null;
    this.spawn(player);
  }

  /** Put both flags on their stands. Called at match start and on restart. */
  resetFlags() {
    this.flags.clear();
    if (!this.mode.teamBased) return;
    const arena = arenaFor(this.mapId);
    if (!arena.ctf?.bases) return;
    for (const team of PLAYING_TEAMS) {
      // Its OWN height, not the arena's: bases are no longer all on one floor.
      const spot = baseSpot(arena, team);
      if (!spot) continue;
      this.flags.set(team, {
        team,
        state: FLAG_STATE.AT_BASE,
        x: spot.x, y: spot.y, z: spot.z,
        carrier: null,
        returnAt: 0,
        /**
         * Who may not pick this up yet, and until when.
         *
         * Only ever the player who just put it down deliberately, and only for
         * a moment. Without it, dropping a flag you are standing on hands it
         * straight back to you on the next tick and the key does nothing at
         * all. Everybody else can take it the same instant, which is the point
         * — a manual drop is a pass.
         */
        noPickupBy: 0,
        noPickupUntil: 0,
      });
    }
  }

  flagPayload() {
    return [...this.flags.values()].map((f) => ({
      t: f.team, s: f.state, x: r2(f.x), y: r2(f.y), z: r2(f.z), c: f.carrier,
    }));
  }

  broadcastFlags(ev = null, by = null, tm = TEAM.NONE) {
    if (!this.mode.teamBased) return;
    this.broadcast(MSG.FLAG, { f: this.flagPayload(), ev, by, tm });
  }

  add(player) {
    player.room = this;
    this.players.set(player.id, player);
    this.assignTeam(player);
    if (this.mode.teamBased && !this.flags.size) this.resetFlags();
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
      // The ROOM's map and mode, which are not necessarily the ones this
      // client asked for: joining a code means playing what that room plays.
      mp: this.mapId,
      gm: this.modeId,
      fl: this.mode.teamBased ? this.flagPayload() : null,
    });
    this.broadcast(MSG.JOINED, { p: player.summary() }, player);
    this.evaluateMatchState();
    this.broadcastScore();
  }

  remove(player) {
    // Drop first: a carrier who disconnects while holding a flag would
    // otherwise take it out of the world entirely, and no one could score.
    this.dropFlagFrom(player);
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
    return {
      st: this.state, tl, kt: this.mode.scoreTarget, w: this.winnerId,
      gm: this.modeId,
      ts: this.mode.teamBased
        ? { [TEAM.RED]: this.teamScores[TEAM.RED], [TEAM.BLUE]: this.teamScores[TEAM.BLUE] }
        : null,
    };
  }

  broadcastScore() {
    this.broadcast(MSG.SCORE, {
      ps: [...this.players.values()].map((p) =>
        [p.id, p.name, p.kills, p.deaths, p.ping, p.team, p.captures]),
      ts: this.mode.teamBased
        ? { [TEAM.RED]: this.teamScores[TEAM.RED], [TEAM.BLUE]: this.teamScores[TEAM.BLUE] }
        : null,
    });
  }

  /** A match needs two people. Below that it idles in warmup so a lone player
   *  can still move around and shoot without the clock running. */
  evaluateMatchState() {
    const live = this.size >= 2;
    if (this.state === MATCH_STATE.WARMUP && live) {
      this.state = MATCH_STATE.LIVE;
      this.endsAt = Date.now() + MATCH_RULES.timeLimitSec * 1000;
      for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.captures = 0; }
      // Warmup is a sandbox — flags can be carried and captured there so a
      // lone player can see how the mode works. Everything it did is wiped
      // here, so nothing done before the match counts towards it.
      this.teamScores[TEAM.RED] = 0;
      this.teamScores[TEAM.BLUE] = 0;
      this.resetFlags();
      /*
       * AND TELL THEM, which `restartMatch` remembers to do and this did not.
       *
       * `resetFlags` puts both flags back on their stands server-side, but a
       * MATCH message carries no flag state — MSG.FLAG is the only thing that
       * moves a flag on a client. So a player who picked the enemy flag up
       * during warmup kept carrying a phantom when the match started: the HUD
       * held CARRYING, the flag still rode their back on everyone else's
       * screen, and running it home scored nothing, because the server had
       * long since put it back.
       */
      this.broadcastFlags();
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
      Math.random,
      this.mapId,
      player.team,
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
    player.armor = PLAYER_START_ARMOR;
    player.alive = true;
    player.flags = 0;
    player.respawnAt = 0;
    player.forceRespawnAt = 0;
    player.history.length = 0;
    /*
     * A moment of grace on arrival.
     *
     * The clearance rule above keeps a spawn away from everyone who is alive
     * RIGHT NOW, which is all it can do — it cannot stop somebody rounding the
     * corner a second later, and being killed before you have even worked out
     * which way you are facing is the least recoverable thing that can happen
     * in a match.
     *
     * Ends the instant they shoot. See handleShot.
     */
    player.protectedUntil = Date.now() + MATCH_RULES.spawnProtectSec * 1000;
    // The jump to the spawn point is the server's own doing, so it must not be
    // charged to the player. Clearing lastInputAt skips the check entirely on
    // their next input, and refills the bucket for the run back into the map.
    player.lastInputAt = 0;
    player.moveBudget = LIMITS.moveBurstMetres;
    if (announce) {
      // TAGGED AS A SPAWN. The client mirrors everything set above — alive,
      // full health, full armour, this position — in one revive. See SP_KIND.
      player.send(MSG.MATCH, {
        ...this.matchPayload(), sp: [at.x, at.y, at.z], spk: SP_KIND.SPAWN,
      });
    }
  }

  /**
   * Apply damage. The server decides everything here — the client only ever
   * claims "I hit player N in the head with weapon W", never how much it hurt.
   */
  applyDamage(victim, attacker, weapon, part, distance = null) {
    if (!victim.alive || this.state === MATCH_STATE.OVER) return;
    // Self-harm reaches here only for throwables — handleShot gates it. Blowing
    // yourself up is a legitimate thing to do to yourself; being shot by
    // yourself is not.
    const now = Date.now();
    const selfInflicted = victim === attacker;
    if (selfInflicted && weapon.selfHarm !== true) return;

    /*
     * Spawn protection.
     *
     * Checked here rather than in handleShot so it covers every route damage
     * can arrive by — bullets, blast radius, a barrel somebody shot near the
     * spawn — instead of only the one that was in mind when it was written.
     *
     * Your OWN explosive still hurts you while protected: it is a decision you
     * made about yourself, and a grenade you can survive by having spawned
     * recently is a strange thing to have to reason about.
     */
    if (!selfInflicted && now < victim.protectedUntil) return;

    /*
     * You cannot shoot your own team.
     *
     * Refused outright rather than reduced: with friendly fire on, one player
     * can hand the match to the other side, and in Capture the Flag they can
     * do it by killing their own carrier. `sameTeam` is false for two players
     * on TEAM.NONE, so a free-for-all is untouched by this.
     */
    if (!selfInflicted && sameTeam(victim.team, attacker.team)) return;

    const raw = damageFor(weapon, part, distance);
    const dmg = Math.min(raw, LIMITS.maxDamagePerHit);

    // Armour takes its share first, and only what it has left to give. The
    // client used to do this itself, which meant it did nothing: the server
    // owns health, so its next update overwrote whatever armour had "saved".
    const absorbed = Math.min(victim.armor, dmg * ARMOR_ABSORB);
    victim.armor -= absorbed;
    victim.hp -= dmg - absorbed;

    const headshot = part === 'head';
    if (victim.hp > 0) {
      this.broadcast(MSG.HIT, {
        v: victim.id, a: attacker.id, d: Math.round(dmg), pt: part, hp: Math.round(victim.hp),
        ar: Math.round(victim.armor),
      });
      return;
    }

    victim.hp = 0;
    victim.armor = 0;
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = now + MATCH_RULES.respawnDelaySec * 1000;
    victim.forceRespawnAt = now + MATCH_RULES.respawnBackstopSec * 1000;
    // Protection does not survive the life it was granted to. Without this a
    // corpse stays flagged through the whole countdown, and the body draws its
    // shield while lying dead.
    victim.protectedUntil = 0;
    /*
     * A carrier who dies DROPS the flag where they fell.
     *
     * Not destroyed and not sent home: the scramble over the body is most of
     * what the mode is, and either alternative removes it.
     */
    this.dropFlagFrom(victim);
    // Blowing yourself up costs a death and earns nothing. Without this guard
    // the suicide would credit a kill to the person who committed it.
    if (this.state === MATCH_STATE.LIVE && !selfInflicted) attacker.kills++;

    /*
     * Streaks.
     *
     * Read the victim's run BEFORE clearing it, so the message can say that
     * this kill is what ended it. Killing yourself ends your own streak and
     * starts nobody's — which is the whole reason the two are handled apart
     * rather than as one "the attacker gained, the victim lost".
     */
    const endedStreak = victim.streak >= STREAK_ANNOUNCE_AT ? victim.streak : 0;
    victim.streak = 0;
    victim.multiKill = 0;

    if (!selfInflicted && this.state === MATCH_STATE.LIVE) {
      attacker.streak++;
      // Consecutive kills stack only while they keep landing inside the
      // window; the first one outside it starts counting again from one.
      attacker.multiKill = now - attacker.lastKillAt <= MULTIKILL_WINDOW_MS
        ? attacker.multiKill + 1
        : 1;
      attacker.lastKillAt = now;
    }

    this.broadcast(MSG.KILL, {
      v: victim.id, a: attacker.id, w: weapon.id, hs: headshot,
      st: attacker.streak, mk: attacker.multiKill, es: endedStreak,
    });

    /*
     * A kill puts you back on your feet.
     *
     * Winning a fight on 20 health and then dying to the next person who
     * walks round the corner is the least satisfying way to play, and it
     * rewards whoever arrives second rather than whoever shot better. Full
     * health, and the plates back to their starting level.
     *
     * Sent as a HEAL — the same negative-damage HIT the pickups use — so the
     * client's health flows through exactly one authoritative path.
     */
    if (!selfInflicted && attacker.alive) {
      const healed = PLAYER_MAX_HEALTH - attacker.hp;
      const plated = Math.max(0, PLAYER_START_ARMOR - attacker.armor);
      if (healed > 0 || plated > 0) {
        attacker.hp = PLAYER_MAX_HEALTH;
        attacker.armor = Math.max(attacker.armor, PLAYER_START_ARMOR);
        this.broadcast(MSG.HIT, {
          v: attacker.id, a: attacker.id,
          d: -Math.round(healed || plated), pt: 'killreward',
          hp: Math.round(attacker.hp), ar: Math.round(attacker.armor),
        });
      }
    }

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

  /** The flag this player is carrying, if any. */
  carriedBy(player) {
    for (const f of this.flags.values()) if (f.carrier === player.id) return f;
    return null;
  }

  /** Put a carried flag on the ground where its carrier is. */
  /**
   * Put a carried flag on the ground.
   *
   * `deliberate` is a drop the player asked for, which is the only case that
   * needs the brief pick-up lockout: they are standing on it. A death drop
   * needs no lockout because the carrier is dead, and locking them out would
   * mean the flag ignored them for two seconds after they respawned somewhere
   * else entirely.
   */
  dropFlagFrom(player, deliberate = false) {
    const flag = this.carriedBy(player);
    if (!flag) return false;
    flag.state = FLAG_STATE.DROPPED;
    flag.carrier = null;
    flag.x = player.x; flag.y = player.y; flag.z = player.z;
    flag.returnAt = Date.now() + this.mode.flagReturnSec * 1000;
    flag.noPickupBy = deliberate ? player.id : 0;
    flag.noPickupUntil = deliberate ? Date.now() + FLAG_DROP_LOCKOUT_MS : 0;
    this.broadcastFlags(FLAG_EVENT.DROPPED, player.id, flag.team);
    return true;
  }

  sendFlagHome(flag, by = null) {
    const spot = baseSpot(arenaFor(this.mapId), flag.team);
    flag.state = FLAG_STATE.AT_BASE;
    flag.carrier = null;
    flag.x = spot.x; flag.y = spot.y; flag.z = spot.z;
    flag.returnAt = 0;
    flag.noPickupBy = 0;
    flag.noPickupUntil = 0;
    this.broadcastFlags(FLAG_EVENT.RETURNED, by, flag.team);
  }

  /**
   * Capture the Flag, once per tick.
   *
   * Everything here is proximity: the server never trusts a client to say it
   * touched anything, it just checks where everyone is against where the flags
   * are. That is the same bounded trust the rest of this server uses, and it
   * means a modified client cannot capture from across the map.
   */
  tickCTF(now) {
    /*
     * Runs in WARMUP as well as LIVE.
     *
     * A room needs two people before a match starts, so gating this on LIVE
     * meant the first player to arrive walked over both flags and nothing
     * whatsoever happened — the mode looked broken to everybody testing it
     * alone, which is how most people first see it. evaluateMatchState wipes
     * anything done in warmup the moment the match begins.
     */
    if (!this.mode.teamBased || this.state === MATCH_STATE.OVER) return;
    const arena = arenaFor(this.mapId);
    if (!arena.ctf) return;
    const touch = this.mode.flagTouchRadius;
    const lift = this.mode.flagTouchHeight;
    /*
     * A CYLINDER, not a circle on the floor.
     *
     * The height test is the whole point — see `flagTouchHeight`. Without it
     * this is a column of infinite height, and on a house map that column
     * passes through every floor above the flag.
     */
    const near = (p, o) => Math.hypot(p.x - o.x, p.z - o.z) < touch
      && Math.abs(p.y - o.y) < lift;

    for (const flag of this.flags.values()) {
      // A flag nobody has touched goes home, so one punted into a corner
      // cannot freeze the match.
      if (flag.state === FLAG_STATE.DROPPED && now >= flag.returnAt) {
        this.sendFlagHome(flag, null);
        continue;
      }
      if (flag.state === FLAG_STATE.CARRIED) continue;

      for (const p of this.players.values()) {
        if (!p.alive || p.team === TEAM.NONE) continue;
        if (!near(p, flag)) continue;

        /*
         * BREAK ONLY WHEN THE FLAG ACTUALLY MOVED.
         *
         * This used to break unconditionally at the end of the loop, on the
         * first player merely STANDING near the flag — so one defender parked
         * on their own flag ate the whole tick and nobody else in the radius
         * was even looked at. An attacker could stand on the enemy flag
         * indefinitely and never pick it up; the only cure was killing the
         * camper, because `!p.alive` skips them before the break.
         *
         * It also broke the documented `F` pass outright. The dropper is
         * skipped by their own two-second lockout below, and the break then
         * discarded the teammate standing right there — so the flag sat until
         * the lockout expired and the dropper, being earlier in the Map,
         * simply took it back. README's "anyone else can take it the same
         * instant, which is what makes it a pass rather than a fumble" could
         * not happen.
         *
         * Still at most one player per flag per tick — the break lives inside
         * both acting branches now, so two enemies cannot take the same flag
         * on the same tick. Deleting it outright would allow exactly that.
         */
        if (p.team === flag.team) {
          // Your own flag. On the ground it is RETURNED by touching it; on its
          // stand there is nothing to do, which is what stops a defender
          // picking up their own flag and walking off with it.
          if (flag.state === FLAG_STATE.DROPPED) {
            this.sendFlagHome(flag, p.id);
            break;
          }
        } else if (!this.carriedBy(p)
          && !(p.id === flag.noPickupBy && now < flag.noPickupUntil)) {
          // The enemy takes it, from the stand or off the ground. One flag per
          // player: without that check a single runner could hold both and end
          // the match by walking home.
          flag.state = FLAG_STATE.CARRIED;
          flag.carrier = p.id;
          flag.returnAt = 0;
          flag.noPickupBy = 0;
          flag.noPickupUntil = 0;
          this.broadcastFlags(FLAG_EVENT.TAKEN, p.id, flag.team);
          break;
        }
      }
    }

    // --- captures -----------------------------------------------------------
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const carried = this.carriedBy(p);
      if (!carried) continue;

      const base = baseSpot(arena, p.team);
      if (Math.hypot(p.x - base.x, p.z - base.z) > this.mode.captureRadius) continue;
      /*
       * And on the BASE'S floor, which is its own and not the arena's ground.
       *
       * Same reasoning as `near` above: without a height test, the landing
       * over your base scores exactly as well as the base does. Reading that
       * height off the arena was correct only while every base sat on the
       * ground. With one upstairs it would mean blue can never score at their
       * own flag, and CAN score by standing in the living room underneath it.
       */
      if (Math.abs(p.y - base.y) > this.mode.flagTouchHeight) continue;

      /*
       * YOUR OWN FLAG MUST BE HOME.
       *
       * This one clause is the mode. Without it both teams simply run past
       * each other and the game is a footrace; with it, a team that has lost
       * its flag cannot score until it wins it back, which is what turns
       * Capture the Flag into a game about defending as well as running.
       */
      const own = this.flags.get(p.team);
      if (!own || own.state !== FLAG_STATE.AT_BASE) continue;

      this.teamScores[p.team]++;
      p.captures = (p.captures ?? 0) + 1;
      this.sendFlagHome(carried, null);
      this.broadcastFlags(FLAG_EVENT.CAPTURED, p.id, carried.team);
      this.broadcastScore();

      if (this.teamScores[p.team] >= this.mode.scoreTarget) {
        this.endMatch(p.id);
        return;
      }
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
    this.teamScores[TEAM.RED] = 0;
    this.teamScores[TEAM.BLUE] = 0;
    this.resetFlags();
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.captures = 0;
      // Streaks belong to a match. Carrying one across a restart would have
      // somebody announced as UNSTOPPABLE on the first kill of a fresh game.
      p.streak = 0; p.multiKill = 0; p.lastKillAt = 0;
      // And so does the redeploy cooldown, for the same reason: starting a
      // fresh game already twelve seconds into a timer is a punishment
      // carried over from a match that is finished.

      /*
       * DROP THE RESERVED SPAWN BEFORE RESPAWNING THEM.
       *
       * `spawn()` honours `player.reservedSpawn` if one is set — that is what
       * lets a dead player stand at their own spawn during the countdown
       * instead of at their corpse. It is reserved at the MOMENT OF DEATH, so
       * anyone who died in the closing seconds of a match carries that
       * reservation across the restart and is put back on it, chosen against
       * the old game's state rather than the new one's.
       *
       * In Capture the Flag that is not a cosmetic difference: a reservation
       * made before a team change, or on a previous map, or against the old
       * scores, is how blue players ended up starting a fresh round standing
       * in red's base. Clearing it forces `reserveSpawn` to pick again from
       * the team's OWN list, which is the only thing that can be right.
       */
      p.reservedSpawn = null;
      this.spawn(p);
    }
    this.broadcastFlags();
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
      // The BACKSTOP, not the schedule — a live client asks for itself when
      // its countdown ends, and one that has gone quiet gets put back here
      // rather than lying dead in the room forever.
      if (!p.alive && p.forceRespawnAt && now >= p.forceRespawnAt) this.spawn(p);
      /*
       * AND SWEEP UP ANYONE LEFT UNDER THE WORLD, asking or not.
       *
       * Every other route out of the void needs the client to do something —
       * keep falling, or keep asking. A frozen, throttled or silent one does
       * neither, and that is exactly the client this bug produces. This is the
       * one rescue that depends on nothing but the position we already hold.
       */
      else if (p.alive && p.y < voidRescueY(this.mapId)) this.recoverFromVoid(p);
    }
    if (windowElapsed) this.rateWindowAt = now;

    this.tickCTF(now);

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
    this.broadcast(MSG.SNAPSHOT, {
      ts: now,
      /*
       * THE MATCH CLOCK RIDES HERE, because this is the only message that goes
       * out on its own schedule.
       *
       * `tl` otherwise exists solely on MSG.MATCH, which is sent on state
       * changes and on spawn — so the HUD's TIME panel was written once when
       * the match went live and then never again. It read 10:00 for ten
       * minutes, lurching forward only when you happened to respawn, and the
       * match ended with no countdown and no 0:00.
       *
       * Deliberately NOT a periodic MSG.MATCH rebroadcast: `onMatch` is an
       * edge handler on the client and re-fires the "X WINS" banner and the
       * whole scoreboard every time it lands.
       */
      tl: this.state === MATCH_STATE.LIVE
        ? Math.max(0, Math.ceil((this.endsAt - now) / 1000))
        : MATCH_RULES.timeLimitSec,
      p: [...this.players.values()].map((p) => [
        p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch),
        p.flags
          | (p.alive ? 0 : FLAG.DEAD)
          // Added by the server, never read off the input: a client cannot
          // declare itself invulnerable.
          | (p.alive && now < p.protectedUntil ? FLAG.PROTECTED : 0),
        p.weapon, Math.round(p.hp),
      ]),
    });
  }

  dispose() {
    clearInterval(this.timer);
    // The timer is what would have expired these. With it gone they are just
    // objects holding a position history nobody will ever read again.
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
/**
 * The fullest open public room ON THE REQUESTED MAP.
 *
 * Filtering by map is what makes quick match honour the choice made in the
 * menu. Without it, pressing PLAY on one map would drop you into whichever
 * public room happened to be busiest — somewhere else entirely, with the
 * client having already built the wrong world.
 */
function findPublicRoom(mapId, modeId) {
  let best = null;
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    if (room.mapId !== mapId) continue;
    // A mode is as much "which game is this" as the map is. Dropping a player
    // who picked Capture the Flag into a deathmatch would be arriving in a
    // different game entirely.
    if (room.modeId !== modeId) continue;
    if (room.size >= MATCH_RULES.maxPlayers) continue;
    if (room.state === MATCH_STATE.OVER) continue;
    if (!best || room.size > best.size) best = room;
  }
  return best;
}

function getOrCreateRoom(requested, quick = false, mapId = DEFAULT_MAP_ID,
  modeId = DEFAULT_MODE_ID) {
  if (requested) {
    const code = requested.toUpperCase();
    if (!isValidRoomCode(code)) return { error: 'that room code is not valid' };
    const existing = rooms.get(code);
    if (existing) {
      if (existing.size >= MATCH_RULES.maxPlayers) return { error: 'that match is full' };
      // An existing room keeps its own map: whoever opened it chose, everyone
      // arriving on the code plays that, and WELCOME says which.
      return { room: existing };
    }
    // Joining a code that does not exist yet creates it, so an invite link
    // works whether or not the host got there first.
    const room = new Room(code, mapId, modeId);
    rooms.set(code, room);
    return { room };
  }

  if (quick) {
    const open = findPublicRoom(mapId, modeId);
    if (open) return { room: open };
    // Nobody to join — open a public one so the next person to press Play
    // lands here rather than starting yet another empty match.
    const room = new Room(makeRoomCode(), mapId, modeId);
    room.isPublic = true;
    rooms.set(room.code, room);
    return { room };
  }

  // CREATE MATCH: private by definition — you get a code to share, and quick
  // match will never drop a stranger into it.
  const room = new Room(makeRoomCode(), mapId, modeId);
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
    /*
     * TAGGED AS A CORRECTION, which is not a formality.
     *
     * This message and the one `spawn` sends are the same shape, and the
     * client used to tell them apart by asking itself whether it thought it
     * was dead. Falling out of the world makes that true, so a refusal sent
     * to a falling player was read as "you have respawned" and stood them up,
     * alive, at `[player.x, player.y, player.z]` — the last position we
     * accepted, which out here is a point in open air beside the map.
     */
    player.send(MSG.MATCH, {
      ...room.matchPayload(),
      sp: [player.x, player.y, player.z],
      spk: SP_KIND.CORRECTION,
    });
  };

  /*
   * FALLING OUT OF THE WORLD KILLS YOU. It must not merely be refused.
   *
   * Rejecting is right for a position that cannot be reached by playing, and
   * catastrophically wrong for the one that CAN: a player who goes over the
   * edge falls past the floor of the arena, the server refuses the position
   * and snaps them back to the last one it accepted — which is in mid-air, a
   * few metres higher. They fall again. It refuses again. That is the loop,
   * and from inside it you are stuck in the sky over the map with the ground
   * jittering below you and no way out but to close the tab.
   *
   * So the underside of the arena is a kill plane, checked BEFORE the general
   * rejection and at exactly the height that rejection starts — leaving no
   * band where a player is out of bounds but not yet dead. Death runs the
   * ordinary path from there: killfeed, respawn timer, back on a spawn point.
   */
  /*
   * The RESCUE plane, which sits deliberately ABOVE the client's death plane.
   * See `voidRescueY` in arena.js — reading `bounds.minY` here instead is what
   * left a two-metre band the client froze inside and the server never saw.
   */
  const floorY = voidRescueY(room.mapId);
  if (y < floorY) {
    /*
     * KILL THEM, THEN SAY NOTHING.
     *
     * The snap-back must NOT be sent here, and that is the whole of why the
     * first version of this did not work: a MATCH carrying `sp` IS the
     * respawn signal. NetworkClient reads one that arrives while it believes
     * it is dead as "you are back", sets itself alive on the spot and calls
     * `onRespawn`. So rejecting a dead player tells them they have respawned
     * when they have not — the client stands up at the spawn while the server
     * still has them dead, their next input comes from under the floor again,
     * and they are pinned in the void on WAITING with no health and no
     * countdown that ever ends.
     *
     * A dead player has nothing to correct. Their position stops mattering
     * the moment they die, and the ONE message that should move them is the
     * real respawn — from their own request, or from the backstop in `tick`.
     */
    /*
     * RECORD IT FIRST, or the two backstops below are dead code.
     *
     * `tick`'s sweep and the MSG.RESPAWN fallback both ask `player.y <
     * voidRescueY`, and the only writers of `player.y` are `spawn` and the
     * accepted-input line at the bottom of this function — which this `return`
     * skips. So the server's stored y could never be under the rescue plane,
     * and neither backstop could ever fire. They looked like belt and braces
     * and were painted on. Storing the reported position makes them real for
     * the client this bug actually produces: one that has gone quiet down
     * there and is not going to ask again.
     */
    player.x = x; player.y = y; player.z = z;
    room.recoverFromVoid(player);
    return;
  }

  /*
   * ABOVE THE PLANE: the fall is over, so the next one is a new event.
   *
   * This is the fast half of the one-fall-one-rescue rule in
   * `Room.recoverFromVoid` — a client that is telling us it is back in the
   * world has plainly received its rescue, and there is nothing left to
   * suppress. Without it the cooldown would also be a dead time in which a
   * player who fell, landed and immediately fell again went unrescued.
   *
   * Deliberately BEFORE the two rejections below rather than down with the
   * accepted input: being above the plane ends the fall whether or not the
   * position turns out to be otherwise legal.
   */
  player.voidRescuedAt = 0;

  /*
   * OUTSIDE THE ARENA IS A RESCUE, NOT A REJECTION.
   *
   * Snapping a player back to the last position the server accepted is only
   * sane if that position is one they can recover FROM. Off the side of
   * OUTPOST it never is: the floor slab reaches 28 and the bounds reach 44, so
   * a player who walks off the edge keeps drifting out until every input is
   * refused — and the last accepted position is then a point in open air
   * beside the map. They are put back there every single frame, forever,
   * alive and unable to fall, and no kill plane below the map can help because
   * they are never allowed to reach it.
   *
   * That is the "stuck in the air" report, and it survived four fixes aimed at
   * the fall itself because falling was never the part that was broken. Being
   * outside the world at all is the problem, whichever direction it happened
   * in, so it gets the same answer as going under it: put them on a spawn.
   */
  if (!isInsideArena(x, y, z, room.mapId)) { reject(); return; }

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
  // HELD_WEAPON_IDS, not WEAPON_BY_ID: that map also carries hazards so the
  // server can price a barrel blast, and nobody gets to walk around holding a
  // barrel.
  if (typeof msg.w === 'string' && HELD_WEAPON_IDS.has(msg.w)) player.weapon = msg.w;
}

/**
 * A health pickup.
 *
 * Health is server-owned, so a pickup that only healed the client was purely
 * cosmetic — the bar rose and the next authoritative update put it straight
 * back. Health packs did nothing at all in a match.
 *
 * The amount is clamped and the rate limited rather than trusted, which is the
 * same bounded trust this protocol already places in position and hit claims.
 * The worst a tampered client gets is the healing an honest one could collect
 * by running between the packs, and it cannot exceed the health cap.
 */
function handleHeal(player, msg) {
  if (!player?.room || !player.alive) return;

  // Armour plates and medkits come down the same path; they differ only in
  // which pool they top up and how much of it a single pickup may grant.
  const armorPack = msg.k === 'armor';
  const cap = armorPack ? PLAYER_MAX_ARMOR : PLAYER_MAX_HEALTH;
  const limit = armorPack ? LIMITS.maxArmorAmount : LIMITS.maxHealAmount;
  const current = armorPack ? player.armor : player.hp;
  if (current >= cap) return;

  // Rate-limit the two pools separately. Sharing one timer meant that walking
  // over a medkit and a plate together — or over two loot drops from the same
  // firefight — silently threw the second one away.
  const stamp = armorPack ? 'lastArmorAt' : 'lastHealAt';
  const now = Date.now();
  if (now - (player[stamp] ?? 0) < LIMITS.minHealInterval * 1000) return;
  player[stamp] = now;

  const asked = Number(msg.a);
  if (!Number.isFinite(asked) || asked <= 0) return;
  const amount = Math.min(asked, limit);

  const after = Math.min(cap, current + amount);
  const gained = after - current;
  if (gained <= 0) return;
  if (armorPack) player.armor = after; else player.hp = after;

  // Reuses HIT so every client updates the same way it does for damage; a
  // negative `d` is the signal that it went the other way.
  player.room.broadcast(MSG.HIT, {
    v: player.id, a: player.id, d: -Math.round(gained),
    pt: armorPack ? 'armor' : 'heal',
    hp: Math.round(player.hp), ar: Math.round(player.armor),
  });
}



function handleShot(player, msg) {
  const room = player.room;
  if (!room || !player.alive) return;
  if (room.state === MATCH_STATE.OVER) return;
  const weapon = WEAPON_BY_ID.get(typeof msg.w === 'string' ? msg.w : player.weapon);
  if (!weapon) return;

  /*
   * Pulling the trigger gives up spawn protection.
   *
   * Deliberately ABOVE the rate limiter: the decision to shoot is what ends
   * it, not whether the round was allowed through. Otherwise a player could
   * spray at the fire-rate ceiling and keep the shots the server dropped from
   * costing them anything, which is a strange thing to have to think about
   * and an obvious one to exploit.
   *
   * The whole point is that invulnerability and being a threat are mutually
   * exclusive. You may take a moment to get your bearings, or you may start
   * shooting — not both.
   */
  player.protectedUntil = 0;

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
  /*
   * The budget is in MESSAGES, and a projectile weapon honestly sends two per
   * trigger pull: the shot itself, which is what the room sees and hears, and
   * the impact frames later, which carries the damage claim.
   *
   * Budgeting one message per shot made a bolt-action sniper — 45 rpm against
   * a 0.94/s allowance — spend 1.5/s and drain its own bucket, so after the
   * opening burst it started dropping the very messages that do the damage.
   * The ceiling still tracks each weapon's real rate; it just counts the
   * messages that rate actually produces.
   */
  const perShot = weapon.projectile ? 2 : 1;
  const allowedPerSec = perShot / minFireInterval(weapon);
  rec.tokens = Math.min(LIMITS.shotBurst, rec.tokens + allowedPerSec * elapsed);
  rec.at = now;
  if (rec.tokens < 1) { player.shotBudget.set(weapon.id, rec); return; }
  rec.tokens -= 1;
  player.shotBudget.set(weapon.id, rec);

  /*
   * Tell everyone else the trigger was pulled.
   *
   * This sits ABOVE the "no hits, nothing to do" return on purpose: a missed
   * shot is exactly the one you most need to see and hear, and returning early
   * meant the only shots anyone witnessed were the ones that had already hurt
   * somebody. Above the hit loop, too, so a flash never waits on validation.
   *
   * Rate limiting is already done by the token bucket above, so this cannot be
   * used to flood the room with flashes.
   */
  const org = Array.isArray(msg.o) && msg.o.length === 3 && msg.o.every(Number.isFinite)
    ? msg.o : null;
  if (org) {
    const dir = Array.isArray(msg.d) && msg.d.length === 3 && msg.d.every(Number.isFinite)
      ? msg.d : [0, 0, -1];
    room.broadcast(MSG.FIRE, {
      id: player.id,
      o: org.map((n) => Math.round(n * 100) / 100),
      d: dir.map((n) => Math.round(n * 1000) / 1000),
      w: weapon.id,
    }, player);   // not back to the shooter — they drew their own already
  }

  const hits = Array.isArray(msg.h) ? msg.h.slice(0, 12) : [];
  if (!hits.length) return;

  // Judge against where victims were when the shooter fired, allowing for the
  // fact that the shooter was rendering them INTERP_DELAY_MS in the past.
  const rewindTo = now - Math.min(400, player.ping + 110);
  const origin = Array.isArray(msg.o) && msg.o.length === 3 ? msg.o : null;

  /*
   * Your own explosives can hurt you, and nothing else can.
   *
   * Self-damage was refused outright, so a grenade dropped at your own feet
   * did nothing: the client reduced its own health locally, the server never
   * heard about it, and the next snapshot put the health straight back. You
   * could not kill yourself with a grenade however hard you tried.
   *
   * Allowed only for throwables. A client claiming to have shot ITSELF with a
   * rifle is meaningless, and letting that through would put a path into the
   * damage code that no legitimate client ever uses.
   */
  const selfHarmAllowed = weapon.selfHarm === true;

  const claimed = new Set();
  for (const hit of hits) {
    const victimId = hit && hit.v;
    const victim = room.players.get(victimId);
    if (!victim || !victim.alive) continue;
    if (victim === player && !selfHarmAllowed) continue;
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
      /*
       * Rewind OTHER people, never yourself.
       *
       * The rewind exists because the shooter sees everyone else
       * INTERP_DELAY_MS in the past, so the server has to judge the shot
       * against what they actually saw. None of that applies to your own
       * body: you see yourself live, with no interpolation, so the position
       * to price your own blast against is where you are NOW.
       *
       * Rewinding it meant a grenade at your feet was measured against where
       * you stood up to 400 ms earlier — 3.5 m away at a sprint. A blast
       * radius of 7.5 m that falls off to ZERO at the edge turns that error
       * into no damage at all, which is exactly how "the grenade doesn't hurt
       * me" was reported: it did, whenever you happened to be standing still,
       * and did nothing whenever you were moving.
       */
      const was = victim === player
        ? { x: victim.x, y: victim.y, z: victim.z }
        : victim.positionAt(rewindTo);
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
    /*
     * WHO IS PLAYING WHAT, broken down by map and by mode.
     *
     * On /health rather than as a WebSocket message, because the menu needs it
     * BEFORE it has a socket — the whole point is to answer "where are the
     * people" while the player is still choosing. It is plain HTTP, cacheless,
     * and already the endpoint the region probe hits, so the menu gets the
     * populations and the latency measurement from one request.
     *
     * Public rooms only. A private room is somebody's match with their friends
     * and its population is not the lobby's business — advertising it would
     * also leak that a given code is live, which is halfway to guessing one.
     */
    const maps = {};
    let publicPlayers = 0;
    for (const room of rooms.values()) {
      if (!room.isPublic || !room.size) continue;
      publicPlayers += room.size;
      const entry = maps[room.mapId] ?? (maps[room.mapId] = { players: 0, rooms: 0, modes: {} });
      entry.players += room.size;
      entry.rooms += 1;
      entry.modes[room.modeId] = (entry.modes[room.modeId] ?? 0) + room.size;
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      // The menu polls this while the picker is open, and a cached answer
      // showing an empty server is worse than no answer at all.
      'cache-control': 'no-store',
      // Read cross-origin: the page is served by a static host and the game
      // server is a different origin in every deployment there has ever been.
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
      publicPlayers,
      maps,
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
          isValidMapId(msg.m) ? msg.m : DEFAULT_MAP_ID,
          isValidModeId(msg.g) ? msg.g : DEFAULT_MODE_ID,
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
        if (player && player.room) {
          if (!player.alive && Date.now() >= player.respawnAt) {
            player.room.spawn(player);
          } else if (player.y < voidRescueY(player.room.mapId)) {
            /*
             * ASKED FOR BY SOMEBODY THE SERVER STILL THINKS IS ALIVE.
             *
             * Normally that is refused, and rightly — respawning on demand is
             * an escape from any fight you are losing. But a client only ever
             * sends this after killing itself, and out under the world it has
             * ALSO stopped simulating, so it will never fall far enough for us
             * to notice on our own. Refusing it there is a deadlock: they ask,
             * we say no, and nothing else in the system is going to move them.
             *
             * Gated on being under the rescue plane, which is not a place any
             * fight happens, so it cannot be used to duck one.
             */
            player.room.recoverFromVoid(player);
          }
        }
        break;

      /*
       * "Put the flag down." Only meaningful while alive and carrying, and
       * both are checked here rather than trusted — a client that could drop
       * a flag it was not holding could plant one anywhere on the map.
       */
      case MSG.DROPFLAG:
        if (player?.room?.mode.teamBased && player.alive) {
          player.room.dropFlagFrom(player, true);
        }
        break;

      case MSG.HEAL:
        handleHeal(player, msg);
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

/**
 * protocol.js — the wire contract, shared verbatim by the browser and the
 * server.
 *
 * This file is imported by BOTH `src/net/NetworkClient.js` and
 * `server/index.js`. It must therefore stay free of any browser or Node
 * dependency — no THREE, no `window`, no `fs`. If the two sides ever disagree
 * about a message shape, the bug is invisible and maddening, so there is
 * exactly one definition of it and both sides read this.
 *
 * ARCHITECTURE (and why it is this way)
 * ------------------------------------
 * This is a RELAY server with validation, not a fully authoritative one.
 * Each browser simulates its own player with the same Rapier code it already
 * used in single-player, and reports the result. The server sanity-checks
 * those reports, owns the things that must not be client-decided (health,
 * score, who died, when you respawn), and fans state out to everyone else.
 *
 * The alternative — the server running the physics itself — is more
 * cheat-proof and is where this is heading. What matters is that the move
 * does not invalidate this file: the message set, the room model and the
 * snapshot format are identical either way. Only who computes `pos` changes.
 * Nothing here is throwaway.
 *
 * Message keys are single characters because a snapshot goes out 30 times a
 * second to every player, and `{"t":"S","p":[...]}` is a third the size of the
 * spelled-out version. It is still plain JSON — readable in devtools, easy to
 * debug. Swapping to a binary encoding later is a change to two functions and
 * needs no protocol redesign.
 */

/** Bumped on any breaking change. Mismatched clients are rejected at join. */
export const PROTOCOL_VERSION = 1;

/** Snapshots per second. 30 is plenty for a shooter this size; the client
 *  interpolates between them, so the visual result is smooth at any FPS. */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * How far in the past the client renders other players.
 *
 * Snapshots arrive every ~33 ms and the network jitters, so rendering the
 * newest one immediately means stuttering whenever a packet is late. Holding a
 * ~100 ms buffer means there is almost always a snapshot on both sides of the
 * render time, so remote players can be interpolated smoothly. The cost is
 * that you see everyone ~100 ms in the past, which is why the server has to
 * rewind when it validates a shot.
 */
export const INTERP_DELAY_MS = 110;

/** Client input sends per second. Higher is smoother for others but costs
 *  bandwidth; 30 matches the tick and is imperceptible in practice. */
export const INPUT_HZ = 30;

export const MSG = Object.freeze({
  // ---- client -> server ----
  JOIN: 'j',      // { n: name, r: room|null, v: PROTOCOL_VERSION }
  INPUT: 'i',     // { q: seq, p: [x,y,z], y: yaw, a: pitch, f: flagBits, w: weaponId }
  SHOT: 's',      // { q: seq, o: [x,y,z], d: [x,y,z], w: weaponId, h: [hits] }
  RESPAWN: 'r',   // {}
  PING: 'p',      // { c: clientClockMs }
  NAME: 'm',      // { n: name }

  // ---- server -> client ----
  WELCOME: 'W',   // { id, r: room, you: {...}, ps: [players], mt: matchState, sp: [x,y,z] }
  // NOTE `ts`, not `t`, for the timestamp. The envelope is built as
  // `{ t: type, ...payload }`, so a payload field called `t` silently
  // overwrites the message type and every snapshot goes out unlabelled —
  // which is exactly what happened, and it looked like the tick was dead.
  SNAPSHOT: 'S',  // { ts: serverTimeMs, p: [[id, x,y,z, yaw, pitch, flags, weapon, hp]] }
  JOINED: 'J',    // { p: playerSummary }
  LEFT: 'L',      // { id }
  HIT: 'H',       // { v: victimId, a: attackerId, d: damage, pt: part, hp }
  KILL: 'K',      // { v: victimId, a: attackerId, w: weaponId, hs: headshot }
  SCORE: 'C',     // { ps: [[id, kills, deaths, ping]] }
  MATCH: 'M',     // { st: state, tl: timeLeftSec, kt: killTarget, w: winnerId|null }
  PONG: 'P',      // { c: echoedClientClock, s: serverTimeMs }
  DENIED: 'E',    // { why: string }
});

/** Bit flags packed into the input/snapshot `f` field. */
export const FLAG = Object.freeze({
  CROUCH: 1 << 0,
  SPRINT: 1 << 1,
  AIRBORNE: 1 << 2,
  ADS: 1 << 3,
  DEAD: 1 << 4,
  FIRING: 1 << 5,
  RELOADING: 1 << 6,
  LEAN_L: 1 << 7,
  LEAN_R: 1 << 8,
});

export const MATCH_STATE = Object.freeze({
  WARMUP: 'warmup',   // fewer than 2 players; nobody can score
  LIVE: 'live',
  OVER: 'over',
});

/**
 * Starting health, shared by both sides.
 *
 * Lives here rather than in Player.js because in a match the SERVER owns
 * health — it subtracts damage and reports the result. If the two disagreed,
 * the HUD bar would not match the number that actually kills you.
 *
 * Raised from 100: at 100, a rifle's 24 damage killed in 5 rounds and fights
 * were over before either player could react. 150 makes it 7, which leaves
 * room to take cover and shoot back without dragging fights out.
 */
export const PLAYER_MAX_HEALTH = 150;

/** Free-for-all rules. */
export const MATCH_RULES = Object.freeze({
  killTarget: 25,
  timeLimitSec: 600,
  // 12, so a group of ten can all get in with headroom. The arena has 13 spawn
  // points, which is the real ceiling — beyond that players would start
  // spawning on top of each other.
  maxPlayers: 12,
  respawnDelaySec: 2.5,
  /** Match restarts this long after it ends, so a lobby never gets stuck. */
  postMatchSec: 12,
  /** Spawn at least this far from the nearest living player. */
  spawnClearance: 12,
});

/**
 * Server-side sanity limits.
 *
 * Deliberately generous. These exist to reject the *absurd* — a player 400 m
 * from where they were a frame ago, or a pistol doing 900 damage — not to
 * police every edge case. A limit tight enough to catch a subtle cheat is also
 * tight enough to kick a legitimate player on a lag spike, and being wrongly
 * kicked is far worse than someone speedhacking in a game with your friends.
 *
 * Real anti-cheat arrives with the authoritative-server upgrade, where the
 * client simply cannot assert its own position at all.
 */
export const LIMITS = Object.freeze({
  /** SPEED_SPRINT is 8.9 m/s in Player.js. Slack covers slopes, explosion
   *  knockback, falling, and a frame or two of accumulated jitter. */
  maxHorizontalSpeed: 8.9 * 1.6,
  maxVerticalSpeed: 60,
  /** A single input may not move you further than this, regardless of dt. */
  maxStepDistance: 8.0,
  /**
   * Movement allowance the server lets a player bank up, in metres.
   *
   * Movement is checked as a token bucket rather than as instantaneous speed,
   * because instantaneous speed cannot be measured from arrival times. Inputs
   * go out every 33 ms, but the internet delivers them in bursts: a packet is
   * held up, then it and the next one arrive together. The server sees two
   * legitimate 0.30 m steps 8 ms apart and computes 37 m/s.
   *
   * That is what made hosted play rubber-band — sprinting only passed the old
   * check if consecutive packets arrived at least 21 ms apart, which over a
   * real network they frequently do not. On a LAN there is no jitter, so it
   * never showed up there.
   *
   * A bucket fixes it because the budget accrued while a packet was delayed
   * is exactly what pays for the burst when it finally lands. Sustained speed
   * is still capped at maxHorizontalSpeed, so a speed hack is caught within
   * about a second — it just cannot be fooled by packet timing.
   */
  moveBurstMetres: 14.24,
  /** Hard ceiling on any one damage application. */
  maxDamagePerHit: 400,
  /** Fire-rate allowance: 0.8 lets a client be 20% early, absorbing timer
   *  jitter without permitting a meaningful rate hack. */
  fireIntervalSlack: 0.8,
  /** Beyond a weapon's range * this, a hit claim is discarded. */
  rangeSlack: 1.25,
  /** Inputs per second above which a client is throttled. */
  maxInputHz: 90,
  /** Messages per second above which a client is disconnected. */
  maxMessageHz: 200,
  nameMaxLength: 16,
  /** No traffic for this long and the connection is dropped. */
  timeoutSec: 15,
});

/** Room codes: unambiguous alphabet — no O/0, I/1, so they survive being read
 *  out loud or typed from a screenshot. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export function isValidRoomCode(code) {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code.toUpperCase()) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Strip anything that would break layout or impersonate another player. */
export function sanitizeName(raw, fallback = 'OPERATOR') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    // Control characters, then zero-width and bidi-override characters.
    // The second group matters because those can make one name render as
    // another player's — impersonation, not merely ugly text.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, LIMITS.nameMaxLength);
  return cleaned.length ? cleaned : fallback;
}

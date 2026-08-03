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
  JOIN: 'j',      // { n: name, r: room|null, q: quickMatch?, v: PROTOCOL_VERSION }
  INPUT: 'i',     // { q: seq, p: [x,y,z], y: yaw, a: pitch, f: flagBits, w: weaponId }
  SHOT: 's',      // { q: seq, o: [x,y,z], d: [x,y,z], w: weaponId, h: [hits] }
  RESPAWN: 'r',   // {}
  /**
   * "I picked up a health pack." { a: amount }
   *
   * Health is server-owned, so a pickup that only healed the client was
   * cosmetic: the bar went up and the next authoritative update put it
   * straight back. Health packs did nothing at all in a match.
   *
   * The server clamps the amount and rate-limits it rather than trusting the
   * figure, which is the same bounded trust the rest of this protocol uses
   * for position and hit claims.
   */
  HEAL: 'h',      // { a: amount, k: 'health' | 'armor' }
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
  HIT: 'H',       // { v: victimId, a: attackerId, d: damage, pt: part, hp, ar: armour }
  /**
   * Somebody else pulled a trigger — muzzle flash, tracer and the report.
   *
   * A shot used to be told to the server and to nobody else, so the only
   * evidence that another player was firing at you was your own health going
   * down. No flash, no tracer, and no gunshot: players reported not knowing
   * they were being shot at, or even that anyone nearby was shooting.
   *
   * Deliberately thin. It carries where the round started and which way it
   * went, and the receiving client draws the rest from its own weapon
   * definitions — the same ones it uses for its own gun.
   */
  FIRE: 'F',      // { id: shooterId, o: [x,y,z], d: [x,y,z], w: weaponId }
  /**
   * Somebody died.
   *
   * `st`, `mk` and `es` carry the streak state so the client never has to
   * count kills for itself. It could — it sees every KILL — but then two
   * clients that joined at different times would disagree about how long
   * somebody's run has been, and the server is the only party that knows.
   *
   *   st  the killer's streak INCLUDING this kill (1 for a fresh one)
   *   mk  kills inside the multi-kill window, 1 unless they are stacking up
   *   es  the victim's streak, but only when it was long enough to announce.
   *       0 otherwise, so "X ENDED Y'S RAMPAGE" needs no lookup.
   */
  KILL: 'K',      // { v, a, w: weaponId, hs: headshot, st: streak, mk: multi, es: endedStreak }
  /**
   * Where the victim will come back, sent to THEM ONLY the moment they die.
   *
   * Without it a dead player stands at the spot they were killed for the whole
   * countdown and is teleported at the end, which reads as respawning where
   * you died. Knowing the point up front lets the client move them there
   * immediately and run the counter at the spawn.
   *
   * Private on purpose: broadcasting it would hand everyone else the location
   * of a player who cannot yet defend it.
   */
  SPAWNPOINT: 'sx', // { sp: [x, y, z] }
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
  /**
   * Freshly spawned and not yet shootable. Server -> client only; an input
   * claiming it is ignored, since the server is the one that grants it.
   *
   * On the wire so it can be DRAWN. Invulnerability that nobody can see is
   * indistinguishable from broken hit registration — you land four rounds on
   * someone and nothing happens — and that is a bug report, not a mechanic.
   */
  PROTECTED: 1 << 9,
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

/**
 * Armour, which soaks a share of incoming damage before health is touched.
 *
 * These live here rather than on the client because the server has to be the
 * one applying them: it owns health, so armour that only existed on the client
 * absorbed nothing at all — the plates were decorative, and picking one up did
 * precisely nothing in a match.
 */
/*
 * You spawn with half a bar and a plate grants the other half, so a plate is
 * worth crossing the map for the moment you have taken any fire at all. Making
 * the two equal would have been simpler and quietly useless: you would respawn
 * capped, and every plate on the level would be scenery.
 */
export const PLAYER_MAX_ARMOR = 100;
export const PLAYER_START_ARMOR = 50;
/** Share of a hit that armour takes on the chin, while any of it remains. */
export const ARMOR_ABSORB = 0.6;

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
  /**
   * How long a freshly spawned player cannot be hurt.
   *
   * `spawnClearance` already keeps spawns away from anyone alive, but it can
   * only account for where people are at that instant — it cannot stop someone
   * walking round the corner half a second later. With thirteen spawn points
   * and up to twelve players, that happens.
   *
   * Two seconds is enough to get your bearings and start moving, and short
   * enough that it is never a way to hold ground. FIRING ENDS IT IMMEDIATELY
   * (see handleShot), so it cannot be used to trade a fight for free — the
   * moment you become a threat you also become a target.
   */
  spawnProtectSec: 2,
});

/**
 * Kill streaks.
 *
 * Two separate things, deliberately, because they reward different play:
 *
 *   STREAK      kills without dying. A slow, cumulative reward for staying
 *               alive, and the reason the whole room is told about it — a
 *               player on a long run should have everybody hunting them.
 *   MULTI-KILL  kills in quick succession. A burst reward for winning a
 *               fight against several people at once, which a streak alone
 *               does not distinguish from killing three people over a minute.
 *
 * Shared with the client so both ends name them the same. The client could
 * hold its own table, and then a server change would silently rename nothing.
 */
export const STREAK_TIERS = Object.freeze([
  [3, 'KILLING SPREE'],
  [5, 'RAMPAGE'],
  [7, 'DOMINATING'],
  [10, 'UNSTOPPABLE'],
  [15, 'GODLIKE'],
]);

/** Kills closer together than this stack into a multi-kill. */
export const MULTIKILL_WINDOW_MS = 3500;

const MULTIKILL_NAMES = Object.freeze([null, null, 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL']);

/** The name for a streak of exactly `n`, or null if `n` is not a milestone. */
export function streakName(n) {
  for (const [at, name] of STREAK_TIERS) if (n === at) return name;
  return null;
}

/** The name for `n` kills inside the multi-kill window, or null below two. */
export function multiKillName(n) {
  if (n < 2) return null;
  return MULTIKILL_NAMES[n] ?? 'MULTI KILL';
}

/**
 * Streaks at or above this are worth telling the room about — both when they
 * are reached and when somebody ends them.
 */
export const STREAK_ANNOUNCE_AT = STREAK_TIERS[0][0];

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
/**
 * Damage for one hit, accounting for where it landed and how far away it was.
 *
 * Lives here rather than in the server so it can be imported without starting
 * one — server/index.js opens a listening socket the moment it is loaded, so a
 * test that wanted this one pure function was booting a whole game server to
 * get it.
 *
 * The distance term is the whole reason a shotgun feels like a shotgun. Every
 * weapon carries falloffStart, falloffEnd and falloffMinScale and the client
 * had always modelled them, but the server — which owns damage — ignored all
 * three and applied it flat, so the ranges the weapons were balanced around
 * did not exist in a real match.
 *
 * Damage is full out to falloffStart, then falls linearly to falloffMinScale
 * by falloffEnd. For the shotgun that is 135 across nine pellets inside 9 m,
 * decaying to 27 past 30 m.
 *
 * @param {object} weapon  a definition from WeaponDefinitions.js
 * @param {string} part    'head' | 'limb' | 'torso'
 * @param {number} [distance]  metres; omit to apply no falloff
 */
export function damageFor(weapon, part, distance = null) {
  const base = weapon.damage ?? 20;

  let scale = 1;
  if (distance !== null && Number.isFinite(distance)) {
    const start = weapon.falloffStart ?? Infinity;
    const end = weapon.falloffEnd ?? Infinity;
    const min = weapon.falloffMinScale ?? 1;
    if (distance >= end) scale = min;
    else if (distance > start && end > start) {
      scale = 1 + (min - 1) * ((distance - start) / (end - start));
    }
  }

  const partMul = part === 'head' ? (weapon.headMul ?? 2)
    : part === 'limb' ? (weapon.limbMul ?? 0.85)
      : 1;
  return base * partMul * scale;
}

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
  /**
   * Rounds a player may bank, per weapon.
   *
   * Fire rate is a token bucket for the same reason movement is: the server
   * cannot see when you pulled the trigger, only when the message reached it,
   * and networks deliver in bursts. Comparing arrival gaps against the weapon's
   * minimum interval throws away real shots — measured at a legitimate 720 RPM,
   * evenly delivered fire registered 5 of 5 rounds while the same fire arriving
   * in pairs registered 1 of 5.
   *
   * That is what "my bullets go straight through him" was. It is asymmetric
   * between players because it depends on each one's own path to the server,
   * so whoever had the steadier connection appeared to land shots while the
   * other appeared to be shooting blanks.
   *
   * Five rounds of burst covers realistic bunching. Sustained rate is still
   * capped, so the worst a rate hack achieves is five rounds early and then
   * the legitimate rate for as long as it keeps firing.
   */
  shotBurst: 5,
  /** Largest heal a single pickup can grant — matches PickupManager. */
  maxHealAmount: 35,
  /** Largest armour top-up a single plate can grant — matches PickupManager. */
  maxArmorAmount: 50,
  /** Shortest gap between accepted heals, in seconds. */
  minHealInterval: 1.5,
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
/**
 * The name shown when somebody has not chosen one.
 *
 * Exported so it can be recognised as 'unset' rather than as a real choice.
 * It used to be an inline literal, and the quick-match button passed it to
 * connect() as a fallback — which SAVED it. From then on the player had a
 * stored name of 'OPERATOR', every 'have you picked a name yet' check said
 * yes, and they could never be asked again.
 */
export const DEFAULT_NAME = 'OPERATOR';

/** True when this is a real choice rather than the placeholder. */
export function hasRealName(name) {
  return typeof name === 'string' && name.trim().length > 0
    && name.trim().toUpperCase() !== DEFAULT_NAME;
}

export function sanitizeName(raw, fallback = DEFAULT_NAME) {
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

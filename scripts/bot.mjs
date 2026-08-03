/**
 * A practice bot — a second player, without a second computer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most of what makes multiplayer feel right can only be judged by standing in
 * the game and watching another body do something: whether a footstep lands on
 * the visible footfall, whether a spawn shield reads as protection or as broken
 * hit registration, whether a name tag sits at the right height.
 *
 * None of that is testable from a server suite, and testing it by hand meant
 * finding another person. This joins a room, walks a patrol, sprints one way,
 * crouch-walks back, reloads, and fires — which between them exercise every
 * branch of the remote-player code — so any of it can be checked in ten
 * seconds, alone.
 *
 *   npm run bot                 # joins room BUDDY
 *   npm run bot -- ABCDE        # joins a specific room
 *   npm run bot -- ABCDE 3      # three of them, so a match goes LIVE
 *   npm run bot -- ABCDE 1 hunt # and it comes after you, and shoots
 *
 * `hunt` is what you want for anything that only happens when you DIE — the
 * kill cam, the respawn sequence, the damage direction indicator. Without it
 * they patrol and fire at nothing, which is right for looking at movement and
 * listening to footsteps but will never kill you.
 *
 * Room codes must be spellable in ROOM_CODE_ALPHABET, which excludes 0, 1, O
 * and I so a code survives being read aloud. 'BOTS1' is not a legal room.
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, FLAG, MATCH_RULES, isValidRoomCode,
} from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const ROOM = (process.argv[2] || 'BUDDY').toUpperCase();
const COUNT = Math.max(1, Math.min(8, Number(process.argv[3] || 1)));
const HUNT = process.argv.includes('hunt');
/*
 * Which mode to ASK for, if this bot is the one that creates the room.
 *
 * Only has an effect on an empty room — joining an existing one adopts that
 * room's mode, same as a real client. `npm run bot -- ROOM 3 ctf`.
 */
const MODE = process.argv.includes('ctf') ? 'ctf' : 'ffa';

/** Metres per 50 ms tick while hunting — about 5 m/s, inside the move budget. */
const CHASE_STEP = 0.25;
/** Close enough to shoot. Well inside every weapon's range. */
const ENGAGE_RANGE = 22;
/** Rounds per second while engaging — slower than the rifle, so never limited. */
const SHOT_INTERVAL_SEC = 0.35;

if (!isValidRoomCode(ROOM)) {
  console.error(`"${ROOM}" is not a valid room code (no 0, 1, O or I).`);
  process.exit(1);
}

const NAMES = ['WALKER', 'PACER', 'ROVER', 'SCOUT', 'DRIFTER', 'RANGER', 'NOMAD', 'TRACER'];

function spawnBot(name, index) {
  const ws = new WebSocket(URL);
  let spawn = null, seq = 0, at = null, id = null;
  let snapshot = [];
  let lastShotT = 0;
  let dead = false;
  // Staggered, so several bots do not move in lockstep like a chorus line.
  let t = index * 3.7;

  ws.on('open', () => ws.send(JSON.stringify({
    t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: ROOM, g: MODE,
  })));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case MSG.WELCOME:
        id = m.id;
        spawn = m.sp;
        at = { x: spawn[0], y: spawn[1], z: spawn[2] };
        console.log(`${name} joined ${ROOM} at `
          + `${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}`
          + (HUNT ? ' — hunting' : ''));
        patrol();
        break;
      case MSG.SNAPSHOT: snapshot = m.p ?? []; break;
      case MSG.KILL:
        if (m.v === id) {
          dead = true;
          // Come back the way a real client does: by asking, once the death
          // sequence would have finished. The server's own timer is only a
          // backstop for clients that have gone away.
          setTimeout(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: MSG.RESPAWN }));
          }, MATCH_RULES.respawnDelaySec * 1000 + 200);
        }
        break;
      case MSG.DENIED:
        console.error(`${name} denied: ${m.why}`);
        process.exitCode = 1;
        break;
      // Both of these are the server placing us; adopt it or the next input
      // claims a position it has already rejected.
      case MSG.MATCH:
        if (m.sp) { spawn = m.sp; at = { x: m.sp[0], y: m.sp[1], z: m.sp[2] }; dead = false; }
        break;
      case MSG.SPAWNPOINT: spawn = m.sp; at = { x: m.sp[0], y: m.sp[1], z: m.sp[2] }; break;
      default: break;
    }
  });

  ws.on('error', (e) => console.error(`${name}: ${e.message}`));

  /**
   * Pace back and forth over about nine metres: sprinting one way, crouching
   * part of the way back, reloading periodically, firing occasionally.
   *
   * 20 Hz rather than the client's 30 — this only has to look like movement,
   * and a bot that saturates its input allowance would be testing the rate
   * limiter rather than the thing you are trying to look at.
   */
  /**
   * The nearest living player who is not us, straight off the snapshot.
   *
   * Rows are [id, x, y, z, yaw, pitch, flags, weapon, hp] — the same order the
   * server packs them in, which is why this reads them positionally.
   */
  function nearestTarget() {
    let best = null, bestD = Infinity;
    for (const r of snapshot) {
      if (r[0] === id) continue;
      if ((r[6] & FLAG.DEAD) !== 0) continue;
      // Shooting somebody who cannot be hurt only wastes the fire-rate budget.
      if ((r[6] & FLAG.PROTECTED) !== 0) continue;
      const d = Math.hypot(r[1] - at.x, r[3] - at.z);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best ? { row: best, dist: bestD } : null;
  }

  /** Walk towards a target and shoot it. Only when `hunt` was asked for. */
  function hunt() {
    const found = nearestTarget();
    if (!found) return false;
    const { row, dist } = found;

    const dx = row[1] - at.x, dz = row[3] - at.z;
    const yaw = Math.atan2(dx, dz) + Math.PI;      // world yaw 0 faces -Z

    if (dist > 6) {
      const step = Math.min(CHASE_STEP, dist - 5);
      at.x += (dx / dist) * step;
      at.z += (dz / dist) * step;
    }
    at.y = spawn[1];

    ws.send(JSON.stringify({
      t: MSG.INPUT, q: ++seq,
      p: [at.x, at.y, at.z], y: yaw, a: 0,
      f: FLAG.SPRINT, w: 'rifle',
    }));

    if (dist <= ENGAGE_RANGE && t - lastShotT >= SHOT_INTERVAL_SEC) {
      lastShotT = t;
      const len = Math.hypot(dx, dz) || 1;
      ws.send(JSON.stringify({
        t: MSG.SHOT,
        o: [at.x, at.y, at.z],
        d: [dx / len, 0, dz / len],
        w: 'rifle',
        h: [{ v: row[0], pt: 'torso' }],
      }));
    }
    return true;
  }

  function patrol() {
    setInterval(() => {
      if (!at) return;
      t += 0.05;
      // Dead bots hold still; the respawn request above brings them back.
      if (dead) return;
      // Hunting takes over whenever there is somebody to hunt, and falls back
      // to the patrol when the room is empty.
      if (HUNT && hunt()) return;
      const leg = Math.sin(t * 1.1);
      const sprinting = leg > 0;
      const crouched = !sprinting && Math.cos(t * 1.1) > 0.3;

      // Amplitude and rate chosen together to give about 5 m/s sprinting and
      // 2 m/s crouched — real movement speeds, so the stride cadence the
      // remote audio derives is the one a player would actually produce.
      at.z = spawn[2] + leg * 4.5;
      at.x = spawn[0] + Math.sin(t * 0.56) * 2.0;
      // A hop every five seconds. Airborne on the way up, grounded again on
      // the way down, which is what produces a landing thud for everyone
      // nearby — the give-away when somebody drops off a container.
      const hop = t % 5;
      const airborne = hop < 0.65;
      at.y = spawn[1] + (airborne ? Math.sin((hop / 0.65) * Math.PI) * 1.1 : 0);

      let flags = 0;
      if (sprinting) flags |= FLAG.SPRINT;
      if (crouched) flags |= FLAG.CROUCH;
      if (airborne) flags |= FLAG.AIRBORNE;
      // A reload every six seconds, held two, so the rising edge is obvious.
      if (t % 6 < 2) flags |= FLAG.RELOADING;

      ws.send(JSON.stringify({
        t: MSG.INPUT, q: ++seq,
        p: [at.x, at.y, at.z],
        y: Math.sin(t * 0.3) * Math.PI, a: 0,
        f: flags, w: 'rifle',
      }));

      // A shot every two seconds, at nothing in particular — enough to keep
      // the gunfire relay and the minimap blip exercised.
      if (Math.round(t * 20) % 40 === 0) {
        ws.send(JSON.stringify({
          t: MSG.SHOT, o: [at.x, at.y, at.z], d: [0, 0, -1], w: 'rifle', h: [],
        }));
      }
    }, 50);
  }

  return ws;
}

const bots = Array.from({ length: COUNT }, (_, i) => spawnBot(NAMES[i % NAMES.length], i));
console.log(`${COUNT} bot${COUNT > 1 ? 's' : ''} joining ${ROOM} on ${URL}. Ctrl-C to stop.`);

process.on('SIGINT', () => {
  for (const ws of bots) { try { ws.close(); } catch { /* already gone */ } }
  process.exit(0);
});

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
 *
 * Room codes must be spellable in ROOM_CODE_ALPHABET, which excludes 0, 1, O
 * and I so a code survives being read aloud. 'BOTS1' is not a legal room.
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, FLAG, isValidRoomCode } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const ROOM = (process.argv[2] || 'BUDDY').toUpperCase();
const COUNT = Math.max(1, Math.min(8, Number(process.argv[3] || 1)));

if (!isValidRoomCode(ROOM)) {
  console.error(`"${ROOM}" is not a valid room code (no 0, 1, O or I).`);
  process.exit(1);
}

const NAMES = ['WALKER', 'PACER', 'ROVER', 'SCOUT', 'DRIFTER', 'RANGER', 'NOMAD', 'TRACER'];

function spawnBot(name, index) {
  const ws = new WebSocket(URL);
  let spawn = null, seq = 0, at = null;
  // Staggered, so several bots do not move in lockstep like a chorus line.
  let t = index * 3.7;

  ws.on('open', () => ws.send(JSON.stringify({
    t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: ROOM,
  })));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case MSG.WELCOME:
        spawn = m.sp;
        at = { x: spawn[0], y: spawn[1], z: spawn[2] };
        console.log(`${name} joined ${ROOM} at `
          + `${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}`);
        patrol();
        break;
      case MSG.DENIED:
        console.error(`${name} denied: ${m.why}`);
        process.exitCode = 1;
        break;
      // Both of these are the server placing us; adopt it or the next input
      // claims a position it has already rejected.
      case MSG.MATCH: if (m.sp) { spawn = m.sp; at = { x: m.sp[0], y: m.sp[1], z: m.sp[2] }; } break;
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
  function patrol() {
    setInterval(() => {
      if (!at) return;
      t += 0.05;
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

/**
 * Fall out of the world, come back on a spawn point.
 *
 * THE BUG, AND WHY IT SURVIVED THREE FIXES
 * ----------------------------------------
 * Reported from play, on OUTPOST: go over the edge and you hang in the air
 * with your health gone, and nothing ever brings you back.
 *
 * The first fix made the floor of the arena fatal, which was right, and routed
 * it through `applyDamage`, which was not: that function opens with
 * `if (!victim.alive || this.state === MATCH_STATE.OVER) return;`. Alone in a
 * room the match never runs, so the damage was dropped in silence — the server
 * still had the player alive under the world while their own client had zeroed
 * its health from the fall and sat on WAITING for a death the server had never
 * agreed happened.
 *
 * The second sent a position correction, which a client that believes it is
 * dead reads as "you have respawned" — so it stood up at the spawn while the
 * server still had it dead, and dropped straight back in.
 *
 * The third moved the player server-side with the announce suppressed, so the
 * one message that actually moves a client was never sent at all.
 *
 * Every one of those was found by a person and missed by this file, because
 * the earlier versions joined TWO players and asserted on the KILL. The player
 * was ALONE, and dying was never the point.
 *
 * So this joins alone, like the report, and asserts the only thing that
 * matters: after going under the floor you are standing on one of the map's
 * own spawn points. Whether it cost a life is the mode's business.
 */

import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { arenaFor, DEFAULT_MAP_ID } from '../src/net/arena.js';

const URL = process.env.URL || 'ws://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); } else {
    failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};

function join(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = { ws, id: null, at: null, seq: 0 };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.at = m.sp; resolve(s); }
      // Where the server says we are. This is the ONLY thing that moves a
      // client, and one whole version of the bug was it never arriving.
      else if (m.t === MSG.MATCH && Array.isArray(m.sp)) s.at = m.sp;
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room,
    })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

async function main() {
  const arena = arenaFor(DEFAULT_MAP_ID);
  const floorY = arena.bounds.minY;
  const onASpawn = ([x, , z]) =>
    arena.spawnPoints.some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.01);

  // ALONE. The match never leaves warmup, which is the case that broke.
  const a = await join('FALLER', 'VDFAL');
  await sleep(600);

  const [sx, , sz] = a.at;

  /*
   * A control first, or this suite would pass just as happily against a server
   * that teleported everyone on every input. The plane has to be a plane.
   */
  send(a, { t: MSG.INPUT, q: ++a.seq, p: [sx + 1, floorY + 4, sz], y: 0, a: 0, f: 0 });
  await sleep(350);
  check('a position above the floor of the arena leaves you where you are',
    a.at[1] > floorY, `y=${a.at[1].toFixed(1)}`);

  // ...and now over the edge.
  send(a, { t: MSG.INPUT, q: ++a.seq, p: [sx, floorY - 8, sz], y: 0, a: 0, f: 0 });
  await sleep(400);
  check('falling under the floor puts you back on a spawn point',
    a.at[1] > floorY && onASpawn(a.at),
    `ended at ${a.at.map((v) => v.toFixed(1)).join(', ')} (floor is ${floorY})`);

  /*
   * And it keeps working. One that frees you once and wedges you on the second
   * fall is not a fix, and "still stuck" is how this came back every time.
   */
  let recovered = 0;
  for (let i = 0; i < 3; i++) {
    send(a, { t: MSG.INPUT, q: ++a.seq, p: [sx, floorY - 20, sz], y: 0, a: 0, f: 0 });
    await sleep(400);
    if (a.at[1] > floorY && onASpawn(a.at)) recovered++;
  }
  check('and it recovers every time, not just the first',
    recovered === 3, `${recovered}/3 falls recovered`);

  a.ws.close();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

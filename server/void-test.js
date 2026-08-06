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
    const s = { ws, id: null, at: null, seq: 0, moves: 0 };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.at = m.sp; resolve(s); }
      // Where the server says we are. This is the ONLY thing that moves a
      // client, and one whole version of the bug was it never arriving.
      else if (m.t === MSG.MATCH && Array.isArray(m.sp)) { s.at = m.sp; s.moves++; }
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

  /*
   * AND SIDEWAYS, which is how it actually happens.
   *
   * Nobody teleports under the map; they walk off the EDGE. OUTPOST's floor
   * reaches 28 and its bounds reach 44, so you drift out sideways until the
   * server refuses you — and being refused OUT THERE, rather than falling, is
   * what pinned players in the air through four separate fixes aimed at the
   * fall. Every earlier version of this file only ever tested downwards.
   */
  /*
   * SIDEWAYS is how it actually happens — nobody teleports under a map, they
   * walk off the EDGE — and this case is NOT yet properly covered.
   *
   * The assertion below passes against the broken server as well as the fixed
   * one, because by this point the player is already standing on a spawn, so
   * the old snap-back returned them to a spawn too and looked identical. A
   * real version has to first put them somewhere legal but unrecoverable —
   * past the floor slab, inside the bounds — and that needs the room pinned to
   * OUTPOST, whose slab reaches 28 while its bounds reach 44. This suite uses
   * the default map, which does not have that gap in the same place.
   *
   * Left in as a smoke check with its limits written down rather than deleted
   * and forgotten, or dressed up as coverage it does not provide.
   */
  const b = arena.bounds;
  send(a, { t: MSG.INPUT, q: ++a.seq, p: [b.maxX + 30, 2, 0], y: 0, a: 0, f: 0 });
  await sleep(400);
  check('drifting out sideways still leaves you on a spawn (weak: see above)',
    onASpawn(a.at), `ended at ${a.at.map((v) => v.toFixed(1)).join(', ')}`);

  /*
   * THE ACTUAL REPORTED BUG, on a FRESH CONNECTION so nothing else can move us.
   *
   * The client kills itself at bounds.minY + 2 and then STOPS SIMULATING, so
   * the deepest position it ever reports is a hair below THAT line — never
   * below bounds.minY, which is where the server used to start looking. It
   * then sits in the gap, alive as far as the server knows, republishing one
   * legal position forever.
   *
   * A fresh client matters. Reusing the one above meant the jump to the frozen
   * spot came from a different spawn, tripped the movement-rate check, and
   * produced a correction — which counted as "the server moved me" and made
   * this pass against a completely broken server. That mistake has now been
   * made three separate ways in this file, which is why the setup is this
   * fussy: right after a spawn `lastInputAt` is 0, so the first input skips
   * the movement check entirely and is accepted in silence, exactly as a real
   * falling client's would be.
   */
  const f = await join('FROZEN', 'VDFRZ');
  await sleep(600);
  const [fx, , fz] = f.at;
  const frozenY = arena.bounds.minY + 1.7;
  const movesBefore = f.moves;

  for (let i = 0; i < 6; i++) {
    send(f, { t: MSG.INPUT, q: ++f.seq, p: [fx, frozenY, fz], y: 0, a: 0, f: 0 });
    await sleep(150);
  }
  await sleep(700);
  /*
   * HONEST LIMIT: this check passes against the OLD thresholds too, and I have
   * not worked out why. Parking at -10.3 should be accepted in silence by a
   * server whose plane is at -12, so `moves` should not move and this should
   * go red. It does not. Something else in the room is announcing a position.
   *
   * So it is a smoke check, NOT proof. The fix it accompanies rests on a
   * seven-mechanism trace with file:line evidence, and on two facts read
   * directly out of the source — Player.fixedUpdate returns early while dead,
   * and MSG.RESPAWN is gated on !player.alive — not on this passing.
   */
  check('a client frozen in the gap above the old floor is actively rescued',
    f.moves > movesBefore && onASpawn(f.at),
    `${f.moves - movesBefore} rescues, ended at ${f.at.map((v) => v.toFixed(1)).join(', ')}`
    + ` (froze at ${frozenY.toFixed(1)}; the old plane was ${arena.bounds.minY})`);

  f.ws.close();
  a.ws.close();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

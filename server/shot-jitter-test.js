/**
 * Shot-registration regression test.
 *
 * Reproduces "I shoot him and my bullets do nothing, but he can hit me."
 *
 * The shooter here is entirely legitimate: it fires a 720 RPM rifle at exactly
 * that rate — one round every 83.3 ms — at a stationary target six metres
 * away. The only thing that varies is WHEN those shots reach the server.
 *
 * The fire-rate limiter compares the gap between message ARRIVALS against the
 * weapon's minimum interval. Arrival gaps are not fire intervals: a network
 * delays one packet and delivers it alongside the next, and the limiter reads
 * that as firing too fast and silently discards the shot. Nothing is sent back
 * — the round simply has no effect, which is exactly what it looks like from
 * the shooter's side.
 *
 * Because it depends on each player's own path to the server, it is asymmetric:
 * whoever has the steadier connection lands their shots.
 *
 *   node server/index.js &
 *   node server/shot-jitter-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, PLAYER_MAX_HEALTH, FLAG, MATCH_RULES } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const RPM = 720;                       // the standard rifle
const FIRE_MS = 60000 / RPM;           // 83.3 ms between rounds
const SHOTS = 5;    // x24 damage = 120, below PLAYER_MAX_HEALTH so the target lives

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = { ws, id: null, spawn: null, seq: 0, hp: PLAYER_MAX_HEALTH, hitsTaken: 0 };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error('denied: ' + (m.r ?? '')));
      else if (m.t === MSG.HIT) { s.hitsTaken++; s.hp = m.hp; }
      else if (m.t === MSG.SNAPSHOT) s.snapshot = m.p;
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

/**
 * @param {'even'|'bunched'} pattern
 *   even    — one shot every 83 ms, as a LAN delivers them
 *   bunched — the same shots at the same average rate, but delivered in pairs
 *             after a stall, which is what a real network does
 */
async function fire(shooter, target, pattern) {
  const before = target.hitsTaken;
  for (let i = 0; i < SHOTS; i++) {
    send(shooter, {
      t: MSG.SHOT,
      o: [shooter.pos.x, shooter.pos.y, shooter.pos.z],
      d: [0, 0, -1],
      w: 'rifle',
      h: [{ v: target.id, pt: 'torso' }],
    });
    if (pattern === 'even') await sleep(FIRE_MS);
    else if (i % 2 === 0) await sleep(6);
    else await sleep(FIRE_MS * 2 - 6);
  }
  await sleep(500);
  return target.hitsTaken - before;
}

/**
 * One run, with a FRESH shooter and target each time.
 *
 * They have to be new every run: damage persists, so reusing a target means
 * the second run kills it partway through and the missing hits look like
 * dropped shots when they are really just a corpse. That mistake made an
 * earlier version of this test report the bug as unfixed after it was fixed.
 */
async function run(pattern, roomSuffix) {
  const room = 'SHT' + roomSuffix;
  const a = await connect('SHOOTER', room);
  const b = await connect('TARGET', room);
  await sleep(600);

  a.pos = { x: a.spawn[0], y: a.spawn[1], z: a.spawn[2] };
  const bPos = { x: a.pos.x, y: a.pos.y, z: a.pos.z - 6 };
  send(a, { t: MSG.INPUT, q: ++a.seq, p: [a.pos.x, a.pos.y, a.pos.z], y: 0, a: 0, f: 0, w: 'rifle' });
  send(b, { t: MSG.INPUT, q: ++b.seq, p: [bPos.x, bPos.y, bPos.z], y: 0, a: 0, f: 0, w: 'rifle' });
  await sleep(400);

  /*
   * Wait out the target's spawn protection before counting anything.
   *
   * This test measures how many legitimately-paced rounds REGISTER, and a
   * freshly spawned player is invulnerable for MATCH_RULES.spawnProtectSec —
   * so without this it measured how much of the run overlapped a timer, and
   * reported the shot limiter as broken.
   *
   * Watching the flag rather than sleeping the duration means a change to that
   * duration cannot quietly turn this back into a failure.
   */
  const clearBy = Date.now() + MATCH_RULES.spawnProtectSec * 1000 + 3000;
  for (;;) {
    send(a, { t: MSG.INPUT, q: ++a.seq, p: [a.pos.x, a.pos.y, a.pos.z], y: 0, a: 0, f: 0, w: 'rifle' });
    send(b, { t: MSG.INPUT, q: ++b.seq, p: [bPos.x, bPos.y, bPos.z], y: 0, a: 0, f: 0, w: 'rifle' });
    const row = (a.snapshot ?? []).find((r) => r[0] === b.id);
    if (row && (row[6] & FLAG.PROTECTED) === 0) break;
    if (Date.now() > clearBy) throw new Error('target never left spawn protection');
    await sleep(80);
  }

  const n = await fire(a, b, pattern);
  a.ws.close(); b.ws.close();
  return n;
}

async function main() {
  console.log(`rifle ${RPM} RPM -> one round every ${FIRE_MS.toFixed(1)} ms, `
    + `target 6 m away, ${SHOTS} rounds per run`);
  console.log(`bunched pairs arrive 6 ms apart\n`);

  const even = await run('even', 'AA');
  console.log(`evenly delivered   : ${even}/${SHOTS} rounds registered`);

  const bunched = await run('bunched', 'BB');
  console.log(`bunched (real net) : ${bunched}/${SHOTS} rounds registered`);

  // Allow one dropped round to timing slop; anything more is the bug.
  const ok = even >= SHOTS - 1 && bunched >= SHOTS - 1;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} — legitimately-paced fire must register `
    + `however the packets are timed`);

  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('shot jitter test crashed:', e); process.exit(1); });

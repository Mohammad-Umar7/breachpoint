/**
 * Rubber-band regression test.
 *
 * Reproduces the hosted-play complaint: "I go forward but then it goes
 * backwards, like it's resisting." That is the server rejecting a position and
 * snapping the client back.
 *
 * The player here is entirely legitimate — it sprints in a straight line at
 * exactly the speed the game allows, sending inputs at the normal 30 Hz. The
 * only thing that varies is WHEN those inputs reach the server. On a LAN they
 * arrive evenly spaced; over the internet they bunch, because a delayed packet
 * is followed immediately by the one behind it.
 *
 * A correctness check that divides distance by arrival gap cannot tell those
 * two cases apart, which is why this passed on a LAN and failed on Render.
 *
 *   node server/index.js &
 *   node server/jitter-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, LIMITS, INPUT_HZ } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const SPRINT = 8.9;             // SPEED_SPRINT in Player.js
const STEP_MS = 1000 / INPUT_HZ;
const STEP_M = SPRINT * (STEP_MS / 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = { ws, id: null, spawn: null, corrections: 0, seq: 0 };
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === MSG.WELCOME) {
        state.id = msg.id; state.spawn = msg.sp;
        resolve(state);
      } else if (msg.t === MSG.DENIED) {
        reject(new Error('join denied: ' + (msg.r ?? JSON.stringify(msg))));
      } else if (msg.t === MSG.MATCH && Array.isArray(msg.sp)) {
        // A MATCH carrying a spawn position is the server snapping us back.
        state.corrections++;
        state.lastCorrection = msg.sp;
      }
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('socket closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room,
    })));
  });
}

const send = (s, obj) => s.ws.send(JSON.stringify(obj));

/**
 * Walk in a straight line, delivering inputs with a given arrival pattern.
 *
 * @param {'even'|'bunched'} pattern
 *   even    — inputs arrive one every 33 ms, as a LAN would deliver them
 *   bunched — the same inputs, but delivered in pairs after a stall, which is
 *             what a real network does whenever a packet is briefly delayed
 */
async function walk(state, steps, pattern, speedMul = 1) {
  let [x, y, z] = state.spawn;
  const before = state.corrections;

  for (let i = 0; i < steps; i++) {
    z -= STEP_M * speedMul;                       // straight line, legal speed
    send(state, { t: MSG.INPUT, q: ++state.seq, p: [+x.toFixed(2), y, +z.toFixed(2)], y: 0, a: 0, f: 0, w: 'rifle' });

    if (pattern === 'even') {
      await sleep(STEP_MS);
    } else {
      // Two inputs back to back, then the stall they were waiting through.
      // Same average rate, same distance, same real elapsed time.
      if (i % 2 === 0) await sleep(4);
      else await sleep(STEP_MS * 2 - 4);
    }
  }
  await sleep(400);
  return { corrections: state.corrections - before, endZ: z };
}

async function main() {
  const room = 'JTTER';   // no I/O/0/1 — ROOM_CODE_ALPHABET excludes them
  const a = await connect('MOVER', room);
  const b = await connect('OTHER', room);   // second player to leave warmup
  await sleep(600);

  console.log(`step: ${STEP_M.toFixed(3)} m every ${STEP_MS.toFixed(1)} ms `
    + `(sprint ${SPRINT} m/s, server cap ${LIMITS.maxHorizontalSpeed.toFixed(2)} m/s)`);
  console.log(`bunched pairs arrive 4 ms apart -> apparent speed `
    + `${(STEP_M / 0.004).toFixed(0)} m/s if measured by arrival gap\n`);

  const even = await walk(a, 40, 'even');
  console.log(`evenly delivered   : ${even.corrections} corrections in 40 inputs`);

  a.spawn = [a.spawn[0], a.spawn[1], even.endZ];
  const bunched = await walk(a, 40, 'bunched');
  console.log(`bunched (real net) : ${bunched.corrections} corrections in 40 inputs`);

  // The other half of the contract: loosening the check must not open a hole.
  // A sustained speed hack drains the bucket and has to be caught.
  a.spawn = [a.spawn[0], a.spawn[1], bunched.endZ];
  const cheat = await walk(a, 40, 'even', 3);
  console.log(`speed hack (3x)    : ${cheat.corrections} corrections in 40 inputs`);

  const legitOk = even.corrections === 0 && bunched.corrections === 0;
  const cheatOk = cheat.corrections > 0;
  const ok = legitOk && cheatOk;
  console.log(`\n${legitOk ? 'PASS' : 'FAIL'} — legitimate movement is never `
    + `corrected, however the packets are timed`);
  console.log(`${cheatOk ? 'PASS' : 'FAIL'} — a sustained speed hack is still caught`);

  a.ws.close(); b.ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('jitter test crashed:', err); process.exit(1); });

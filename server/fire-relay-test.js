/**
 * Gunfire-relay test.
 *
 * A shot was reported to the server and to nobody else. The server validated
 * it, applied the damage and said nothing, so the only evidence that another
 * player was firing at you was your own health going down — no muzzle flash,
 * no tracer, no gunshot. Players could not tell they were being shot at, or
 * that anyone nearby was shooting at all.
 *
 * The important case is the MISS: a shot that hits nobody produced no HIT
 * either, so a player being shot at and missed had literally no signal of any
 * kind. That is the one this pins down hardest.
 *
 *   node server/index.js &
 *   node server/fire-relay-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

function join(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = { ws, id: null, spawn: null, seq: 0, fires: [], hits: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.FIRE) s.fires.push(m);
      else if (m.t === MSG.HIT) s.hits.push(m);
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

async function main() {
  const room = 'FLASH';
  const a = await join('SHOOTER', room);
  const b = await join('WATCHER', room);
  await sleep(900);

  // --- a shot that hits nothing at all -------------------------------------
  a.fires.length = 0; b.fires.length = 0; b.hits.length = 0;
  send(a, {
    t: MSG.SHOT, o: [a.spawn[0], a.spawn[1] + 1.6, a.spawn[2]], d: [0, 0, -1],
    w: 'rifle', h: [],
  });
  await sleep(400);

  const seen = b.fires[0];
  check('a MISSED shot still reaches the other player', !!seen,
    seen ? `from ${seen.id}` : 'nothing relayed — a miss is invisible and silent');
  check('and it says who fired', !!seen && seen.id === a.id,
    seen ? `id ${seen.id}, shooter is ${a.id}` : '');
  check('and which weapon, so the right report plays',
    !!seen && seen.w === 'rifle', seen ? `w=${seen.w}` : '');
  check('and where from, for the flash',
    !!seen && Array.isArray(seen.o) && seen.o.length === 3 && seen.o.every(Number.isFinite),
    seen ? `o=[${seen.o}]` : '');
  check('and which way it went, for the tracer',
    !!seen && Array.isArray(seen.d) && seen.d.length === 3 && seen.d.every(Number.isFinite),
    seen ? `d=[${seen.d}]` : '');
  check('no HIT was sent, so this was the only signal', b.hits.length === 0,
    `${b.hits.length} hits`);

  // --- the shooter is not told about their own shot -------------------------
  check('the shooter does not get their own shot back', a.fires.length === 0,
    `${a.fires.length} echoed — they already drew it locally`);

  // --- a hit relays exactly one flash, not one per pellet -------------------
  b.fires.length = 0;
  send(a, {
    t: MSG.SHOT, o: [a.spawn[0], a.spawn[1] + 1.6, a.spawn[2]], d: [0, 0, -1],
    w: 'shotgun',
    h: Array.from({ length: 9 }, () => ({ v: b.id, pt: 'torso' })),
  });
  await sleep(400);
  check('a nine-pellet blast is one flash, not nine',
    b.fires.length === 1, `${b.fires.length} relayed`);

  // --- the rate limiter still bounds it ------------------------------------
  // Otherwise a client could flood every screen in the room with flashes.
  b.fires.length = 0;
  for (let i = 0; i < 40; i++) {
    send(a, {
      t: MSG.SHOT, o: [a.spawn[0], a.spawn[1] + 1.6, a.spawn[2]], d: [0, 0, -1],
      w: 'rifle', h: [],
    });
  }
  await sleep(500);
  check('flash spam is bounded by the same limiter as damage',
    b.fires.length > 0 && b.fires.length <= 8,
    `${b.fires.length} of 40 instant shots relayed`);

  // --- a garbage origin is dropped rather than relayed ----------------------
  b.fires.length = 0;
  await sleep(1200);                     // let the bucket refill
  send(a, { t: MSG.SHOT, o: [NaN, 'x', null], d: [0, 0, -1], w: 'rifle', h: [] });
  await sleep(400);
  check('a nonsense origin is not relayed', b.fires.length === 0,
    `${b.fires.length} relayed`);

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('fire relay test crashed:', e); process.exit(1); });

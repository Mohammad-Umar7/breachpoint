/**
 * A rename is a roster broadcast to the whole room, so it has to be paced.
 *
 * NAME was accepted at the general flood ceiling — 199 a second — and every
 * one fanned a full SCORE out to everybody present. One client could make the
 * server send two thousand scoreboards a second without tripping any limit.
 *
 *   node server/index.js &
 *   node server/rename-flood-test.js
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
    const s = { ws, id: null, scores: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.SCORE) s.scores.push(m);
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));
const nameOf = (score, id) => score.ps.find((r) => r[0] === id)?.[1];

async function main() {
  const a = await join('ALPHA', 'RNAME');
  const b = await join('BRAVO', 'RNAME');
  await sleep(600);

  // --- one rename goes through ------------------------------------------
  b.scores.length = 0;
  send(a, { t: MSG.NAME, n: 'ALPHA2' });
  await sleep(300);
  check('a rename reaches the room', b.scores.some((s) => nameOf(s, a.id) === 'ALPHA2'),
    `${b.scores.length} score broadcasts`);

  // --- a burst of forty inside the window is not forty broadcasts --------
  b.scores.length = 0;
  for (let i = 0; i < 40; i++) send(a, { t: MSG.NAME, n: `SPAM${i}` });
  await sleep(400);
  check('a burst of renames is paced, not relayed one for one',
    b.scores.length <= 1, `${b.scores.length} broadcasts for 40 renames`);

  // --- the same name again is not a broadcast at all ---------------------
  await sleep(2100);
  b.scores.length = 0;
  const current = nameOf(b.scores[0] ?? { ps: [] }, a.id);
  send(a, { t: MSG.NAME, n: 'ALPHA2' });        // whatever it is now, set it once
  await sleep(300);
  const settled = b.scores.at(-1) ? nameOf(b.scores.at(-1), a.id) : current;
  b.scores.length = 0;
  await sleep(2100);
  send(a, { t: MSG.NAME, n: settled });         // and again, unchanged
  await sleep(300);
  check('renaming to the name you already have sends nothing', b.scores.length === 0,
    `${b.scores.length} broadcasts`);

  // --- and after the window a real rename works again --------------------
  await sleep(2100);
  b.scores.length = 0;
  send(a, { t: MSG.NAME, n: 'ALPHA3' });
  await sleep(300);
  check('a rename after the window goes through', b.scores.some((s) => nameOf(s, a.id) === 'ALPHA3'));

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('rename flood test crashed:', e); process.exit(1); });

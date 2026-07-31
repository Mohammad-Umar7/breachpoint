/**
 * Quick match test.
 *
 * The point of the PLAY button is that two strangers who press it end up in
 * the SAME game. The obvious implementation — hand each player a fresh room —
 * gives everyone a private empty match and looks identical from the outside
 * until you notice nobody ever meets anyone.
 *
 * Also checks the other half of the contract: CREATE MATCH must stay private,
 * so a code you share is not somewhere quick match can drop a stranger.
 *
 *   node server/index.js &
 *   node server/quickmatch-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, MATCH_RULES } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}

/** @param {{quick?: boolean, room?: string|null}} opts */
function join(name, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = { ws, id: null, room: null, players: new Set() };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.room = m.r; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.JOINED) s.players.add(m.p?.id);
    });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: name,
      r: opts.room ?? undefined,
      q: opts.quick || undefined,
    })));
  });
}

async function main() {
  // --- two Play presses land together --------------------------------------
  const a = await join('ALPHA', { quick: true });
  await sleep(300);
  const b = await join('BRAVO', { quick: true });
  await sleep(500);
  check('two quick-match players share a room', a.room === b.room,
    `${a.room} / ${b.room}`);
  check('each sees the other arrive', a.players.has(b.id) || b.players.has(a.id));

  // --- a third joins the same one, rather than opening another -------------
  const c = await join('CHARLIE', { quick: true });
  await sleep(400);
  check('a third player joins the same match', c.room === a.room, c.room);

  // --- CREATE MATCH stays private ------------------------------------------
  const host = await join('HOST', {});                // no quick flag
  await sleep(300);
  check('create-match gets its own room', host.room !== a.room,
    `${host.room} vs ${a.room}`);

  const stranger = await join('STRANGER', { quick: true });
  await sleep(400);
  check('quick match never drops a stranger into a private room',
    stranger.room !== host.room, `${stranger.room} vs private ${host.room}`);

  // --- an invite code still works ------------------------------------------
  const invited = await join('FRIEND', { room: host.room });
  await sleep(300);
  check('an invited friend can still join by code', invited.room === host.room,
    invited.room);

  for (const s of [a, b, c, host, stranger, invited]) s.ws.close();
  await sleep(200);

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('quick match test crashed:', e); process.exit(1); });

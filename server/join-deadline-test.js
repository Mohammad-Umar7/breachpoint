/**
 * A socket that never joins is closed by the server.
 *
 * Idle players are timed out by the room tick; a socket that never sent JOIN
 * has no player and no room, so nothing ever looked at it again. Each one
 * was a handle and a buffer held for the life of the process, and a loop
 * could open thousands. The deadline is ten seconds, so this test waits it
 * out — it is the one suite that is slow on purpose.
 *
 *   node server/index.js &
 *   node server/join-deadline-test.js
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

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = { ws, closed: false, code: 0, welcomed: false };
    ws.on('open', () => resolve(s));
    ws.on('close', (code) => { s.closed = true; s.code = code; });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) s.welcomed = true;
    });
    ws.on('error', reject);
  });
}

async function main() {
  const silent = await open();
  const joiner = await open();
  // A client that joins late — but inside the window — is fine.
  await sleep(2000);
  joiner.ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: 'LATE', r: 'JNDLN' }));

  await sleep(4000);
  check('a silent socket is still open before the deadline', !silent.closed);
  check('a client that joined inside the window was welcomed', joiner.welcomed);

  await sleep(6500);
  check('a socket that never joins is closed once the deadline passes', silent.closed,
    silent.closed ? `close code ${silent.code}` : 'still open after 12.5 s');
  check('with the "no join" code', silent.code === 4004, `code ${silent.code}`);
  check('the client that joined is still connected', !joiner.closed);

  joiner.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('join deadline test crashed:', e); process.exit(1); });

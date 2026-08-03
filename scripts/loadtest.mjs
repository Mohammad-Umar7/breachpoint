/**
 * Load test — how many people does ONE server process actually hold?
 *
 * Not a pass/fail suite. It fills the server with simulated players and
 * reports the numbers you need to choose a host and a plan: bandwidth per
 * player, memory, and — the one that matters — whether the 30 Hz tick is
 * still on time under load. A server whose tick has slipped to 20 Hz feels
 * like lag to everybody in every room, however much CPU headroom is left.
 *
 *   node server/index.js &
 *   node scripts/loadtest.mjs 120        # 120 concurrent players
 *
 * Each fake client behaves like a real one: joins a room, streams position at
 * INPUT_HZ, and fires occasionally. Rooms fill to MATCH_RULES.maxPlayers
 * before a new one opens, exactly as quick match does.
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, MATCH_RULES, INPUT_HZ, TICK_HZ } from '../src/net/protocol.js';

const URL = process.env.URL || 'ws://localhost:8787';
const TOTAL = Number(process.argv[2] || 60);
const SECONDS = Number(process.argv[3] || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = (n) => {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[(n * 7 + i * 13) % ALPHABET.length];
  return s;
};

const clients = [];
let bytesIn = 0;
let snapshots = 0;
/** Snapshot arrival times for ONE client, to measure the real tick rate. */
const tickGaps = [];
let lastTickAt = 0;

function spawn(i) {
  return new Promise((resolve) => {
    const room = roomCode(Math.floor(i / MATCH_RULES.maxPlayers));
    const ws = new WebSocket(URL);
    const c = { ws, id: null, seq: 0, at: [0, 1.1, 0], alive: false };
    ws.on('message', (raw) => {
      bytesIn += raw.length;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { c.id = m.id; c.at = [...m.sp]; c.alive = true; resolve(c); }
      else if (m.t === MSG.SNAPSHOT) {
        snapshots++;
        if (i === 0) {                       // one client's view of the tick
          const now = performance.now();
          if (lastTickAt) tickGaps.push(now - lastTickAt);
          lastTickAt = now;
        }
      } else if (m.t === MSG.DENIED) { resolve(null); }
    });
    ws.on('error', () => resolve(null));
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: `BOT${i}`, r: room,
    })));
  });
}

async function main() {
  console.log(`Filling ${TOTAL} players into rooms of ${MATCH_RULES.maxPlayers}, `
    + `then running ${SECONDS}s at ${INPUT_HZ} Hz input / ${TICK_HZ} Hz tick.\n`);

  const before = await health();
  for (let i = 0; i < TOTAL; i++) {
    const c = await spawn(i);
    if (c) clients.push(c);
    await sleep(15);                          // stagger, as real joins are
  }
  console.log(`${clients.length} of ${TOTAL} connected`
    + (clients.length < TOTAL ? '  (the rest were refused)' : ''));

  // Everyone moves and shoots like a real player.
  bytesIn = 0; snapshots = 0; tickGaps.length = 0; lastTickAt = 0;
  const started = performance.now();
  const driver = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) continue;
      c.at[0] += Math.sin(c.id + performance.now() / 900) * 0.12;
      c.at[2] += Math.cos(c.id + performance.now() / 900) * 0.12;
      c.ws.send(JSON.stringify({
        t: MSG.INPUT, q: ++c.seq, p: c.at, y: 0, a: 0, f: 0, w: 'rifle',
      }));
      // Roughly one shot a second each, which is a busy room.
      if (Math.random() < 1 / INPUT_HZ) {
        c.ws.send(JSON.stringify({
          t: MSG.SHOT, o: c.at, d: [0, 0, -1], w: 'rifle', h: [],
        }));
      }
    }
  }, 1000 / INPUT_HZ);

  await sleep(SECONDS * 1000);
  clearInterval(driver);
  const elapsed = (performance.now() - started) / 1000;
  const after = await health();

  // --- the numbers ---------------------------------------------------------
  const perPlayerKbps = (bytesIn / elapsed / clients.length) * 8 / 1000;
  const totalMbps = (bytesIn / elapsed) * 8 / 1e6;
  const gaps = tickGaps.slice().sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? 0;
  const worst = gaps[gaps.length - 1] ?? 0;
  const effectiveHz = median > 0 ? 1000 / median : 0;

  console.log('');
  console.log(`players connected      ${clients.length}`);
  console.log(`rooms                  ${after?.rooms ?? '?'}`);
  console.log(`downstream per player  ${perPlayerKbps.toFixed(1)} kbit/s`);
  console.log(`downstream total       ${totalMbps.toFixed(2)} Mbit/s`);
  console.log(`snapshots received     ${snapshots}`);
  console.log('');
  console.log(`tick target            ${(1000 / TICK_HZ).toFixed(1)} ms  (${TICK_HZ} Hz)`);
  console.log(`tick median            ${median.toFixed(1)} ms  -> ${effectiveHz.toFixed(1)} Hz`);
  console.log(`tick 95th percentile   ${p95.toFixed(1)} ms`);
  console.log(`tick worst             ${worst.toFixed(1)} ms`);
  const healthy = effectiveHz >= TICK_HZ * 0.9 && p95 < (1000 / TICK_HZ) * 2;
  console.log('');
  console.log(healthy
    ? `VERDICT: comfortable at ${clients.length} players — the tick is on time.`
    : `VERDICT: STRUGGLING at ${clients.length} players — the tick has slipped, `
      + 'which every player feels as lag.');

  for (const c of clients) { try { c.ws.close(); } catch { /* going away */ } }
  await sleep(300);
  process.exit(0);
}

async function health() {
  try {
    const res = await fetch(URL.replace(/^ws/, 'http') + '/health');
    return await res.json();
  } catch { return null; }
}

main().catch((e) => { console.error(e); process.exit(1); });

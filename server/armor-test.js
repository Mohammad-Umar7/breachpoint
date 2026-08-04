/**
 * Armour test.
 *
 * Armour existed only on the client. The server owns health, so the client's
 * absorption maths was overwritten by the very next authoritative update:
 * plates soaked nothing, and picking one up in a match did literally nothing.
 * The HUD showed a protection stat that did not protect you.
 *
 * Worse, the two sides disagreed about the numbers — the client capped armour
 * at 100 while a plate grants 50, and opened at 100 health against a maximum
 * of 150.
 *
 * The checks below read the server's own HIT messages and verify the
 * arithmetic between consecutive ones, so they hold at any range and do not
 * have to hardcode a damage figure that weapon balancing would invalidate.
 *
 *   node server/index.js &
 *   node server/armor-test.js
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, PLAYER_MAX_HEALTH, PLAYER_MAX_ARMOR,
  PLAYER_START_ARMOR, ARMOR_ABSORB, MATCH_RULES,
} from '../src/net/protocol.js';

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
    const s = { ws, id: null, spawn: null, seq: 0, hits: [], died: false };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.HIT) s.hits.push(m);
      else if (m.t === MSG.KILL && m.v === s.id) { s.died = true; askToRespawn(s); }
      else if (m.t === MSG.SNAPSHOT) s.lastSnapshot = m.p;
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

/**
 * Come back the way a real client does — by asking.
 *
 * The server's own timer is only a BACKSTOP: the client is the side that knows
 * when its own death sequence has finished, and it asks. A test that just
 * waits gets the backstop, several seconds later, and reads as "respawning is
 * broken".
 */
function askToRespawn(s) {
  setTimeout(() => {
    if (s.ws.readyState === 1) send(s, { t: MSG.RESPAWN });
  }, MATCH_RULES.respawnDelaySec * 1000 + 150);
}

/** Long enough for askToRespawn to have fired and the server to have acted. */
const waitRespawn = () => sleep(MATCH_RULES.respawnDelaySec * 1000 + 900);

async function main() {
  const room = 'ARMRS';
  const a = await join('SHOOTER', room);
  const b = await join('TARGET', room);
  // The second join takes the room live, which respawns everyone — anything
  // positioned before that is silently overwritten.
  await sleep(900);

  // Walk the target to a fixed 10 m in front of the shooter. Teleporting is
  // refused by the movement budget, quite rightly, so it has to walk.
  const origin = { x: a.spawn[0], y: a.spawn[1], z: a.spawn[2] };
  const target = { x: origin.x, y: origin.y, z: origin.z - 10 };
  const STEP = 0.6;
  for (let i = 0; i < 400; i++) {
    const row = (a.lastSnapshot ?? []).find((r) => r[0] === b.id);
    const at = row ? { x: row[1], y: row[2], z: row[3] } : { ...origin };
    const dx = target.x - at.x, dz = target.z - at.z;
    const dist = Math.hypot(dx, dz);
    const next = dist <= STEP
      ? { x: target.x, z: target.z }
      : { x: at.x + (dx / dist) * STEP, z: at.z + (dz / dist) * STEP };
    send(a, { t: MSG.INPUT, q: ++a.seq, p: [origin.x, origin.y, origin.z], y: 0, a: 0, f: 0, w: 'rifle' });
    send(b, { t: MSG.INPUT, q: ++b.seq, p: [next.x, target.y, next.z], y: 0, a: 0, f: 0, w: 'rifle' });
    await sleep(50);
    if (dist <= STEP && row) break;
  }
  await sleep(500);                     // outlast the 400 ms rewind window

  const shoot = () => send(a, {
    t: MSG.SHOT,
    o: [origin.x, origin.y, origin.z],
    d: [0, 0, -1],
    w: 'rifle',
    h: [{ v: b.id, pt: 'torso' }],
  });

  // --- armour takes its share --------------------------------------------
  b.hits.length = 0;
  shoot();
  await sleep(350);
  const first = b.hits.find((h) => h.v === b.id);
  check('the server reports an armour figure at all', !!first && typeof first.ar === 'number',
    first ? `ar=${first.ar}` : 'no hit registered');

  if (first) {
    const armorLost = PLAYER_START_ARMOR - first.ar;
    const hpLost = PLAYER_MAX_HEALTH - first.hp;
    check('armour absorbs its share of the hit',
      Math.abs(armorLost - first.d * ARMOR_ABSORB) <= 1.5,
      `${armorLost.toFixed(1)} absorbed of ${first.d} damage (${ARMOR_ABSORB * 100}%)`);
    check('and health takes only the remainder',
      Math.abs(hpLost - (first.d - armorLost)) <= 1.5,
      `${hpLost} hp lost, ${first.d} damage, ${armorLost.toFixed(1)} absorbed`);
    check('so a plated player loses less health than the damage dealt',
      hpLost < first.d, `${hpLost} < ${first.d}`);
  }

  // --- and runs out, after which health takes everything -------------------
  b.hits.length = 0;
  for (let i = 0; i < 14 && !b.died; i++) { shoot(); await sleep(140); }
  await sleep(300);
  const armorGone = b.hits.filter((h) => h.v === b.id && h.ar === 0);
  check('armour runs out under sustained fire', armorGone.length > 0,
    `${armorGone.length} hits landed on bare health`);

  // Once armour is gone, health must take the full damage of a hit. Compare
  // consecutive messages so this holds whatever the weapon happens to do.
  let bareOk = null;
  const seq = b.hits.filter((h) => h.v === b.id);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i - 1].ar === 0 && seq[i].ar === 0) {
      bareOk = Math.abs((seq[i - 1].hp - seq[i].hp) - seq[i].d) <= 1.5;
      if (bareOk) break;
    }
  }
  check('with no armour left, health takes the whole hit', bareOk === true,
    bareOk === null ? 'no consecutive unarmoured pair to compare' : '');

  // --- a plate is claimed through the server ------------------------------
  await waitRespawn();                  // wait out the respawn
  b.hits.length = 0;
  send(b, { t: MSG.HEAL, a: 25, k: 'armor' });   // a partial top-up
  await sleep(400);
  const plate = b.hits.find((h) => h.v === b.id && h.d < 0);
  check('an armour plate is applied by the server', !!plate,
    plate ? `+${-plate.d} armour, now ${plate.ar}` : 'no plate registered');
  check('and it tops up armour, not health',
    !!plate && plate.pt === 'armor' && plate.hp === PLAYER_MAX_HEALTH,
    plate ? `pt=${plate.pt}, hp untouched at ${plate.hp}` : '');

  // --- but cannot be stacked past the cap ---------------------------------
  b.hits.length = 0;
  await sleep(1700);                    // clear the rate limit
  send(b, { t: MSG.HEAL, a: 9999, k: 'armor' });
  await sleep(400);
  const over = b.hits.find((h) => h.d < 0);
  check('armour never exceeds its cap',
    !over || over.ar <= PLAYER_MAX_ARMOR,
    over ? `asked 9999, ended at ${over.ar} of ${PLAYER_MAX_ARMOR}` : 'refused');

  // --- and respawning restores the plates ---------------------------------
  b.hits.length = 0;
  for (let i = 0; i < 20 && !b.died; i++) { shoot(); await sleep(140); }
  check('sustained fire still kills through armour', b.died, b.died ? '' : 'survived 20 rounds');
  await waitRespawn();
  b.hits.length = 0; b.died = false;
  shoot();
  await sleep(400);
  const afterRespawn = b.hits.find((h) => h.v === b.id && h.d > 0);
  check('respawning restores armour',
    !!afterRespawn && afterRespawn.ar > 0,
    afterRespawn ? `ar=${afterRespawn.ar} after the first hit` : 'no hit after respawn');

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('armour test crashed:', e); process.exit(1); });

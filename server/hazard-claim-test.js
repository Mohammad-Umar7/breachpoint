/**
 * Which "weapons" a client is allowed to claim a hit with.
 *
 * The server prices every hit from a definition, and the lookup it priced
 * from held the hazards as well as the guns — including THE VOID, the kill
 * plane's own damage source: 1000 damage, a 1000 m range, self-harm permitted.
 * A SHOT message naming it, with a hit list of everybody in the room, killed
 * all of them at once from anywhere on the map. No honest client ever sends
 * one, so the only clients that would are the ones this test pretends to be.
 *
 * A barrel stays claimable: it goes off in the client's world and the server
 * prices the blast, which is the documented path.
 *
 *   node server/index.js &
 *   node server/hazard-claim-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { HAZARD_DEFS } from '../src/weapons/WeaponDefinitions.js';

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
    const s = { ws, id: null, spawn: null, seq: 0, hits: [], kills: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      else if (m.t === MSG.MATCH && m.sp) s.spawn = m.sp;
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.HIT) s.hits.push(m);
      else if (m.t === MSG.KILL) s.kills.push(m);
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

async function main() {
  const room = 'HAZRD';
  const cheat = await join('CHEAT', room);
  const mark = await join('MARK', room);
  await sleep(900);

  // The definition has to SAY it is the server's, or nothing downstream can
  // know. A void with the flag dropped would be claimable again silently.
  const voidDef = HAZARD_DEFS.find((h) => h.id === 'void');
  check('the void hazard is marked server-only in its definition',
    voidDef?.serverOnly === true);
  const serverOnly = HAZARD_DEFS.filter((h) => h.serverOnly).map((h) => h.id);
  check('a barrel is not server-only (clients shoot them and report the blast)',
    !serverOnly.includes('barrel'), `server-only: ${serverOnly.join(', ')}`);

  // --- the exploit: "I hit everyone with the void" ---------------------------
  mark.hits.length = 0; mark.kills.length = 0;
  send(cheat, {
    t: MSG.SHOT, o: cheat.spawn, d: [0, 0, -1], w: 'void',
    h: [{ v: mark.id, pt: 'torso' }, { v: cheat.id, pt: 'torso' }],
  });
  await sleep(450);
  check('a claimed void hit on another player is refused',
    !mark.hits.some((h) => h.v === mark.id) && !mark.kills.some((k) => k.v === mark.id),
    `${mark.hits.length} hits, ${mark.kills.length} kills seen`);
  check('a claimed void hit on yourself is refused too',
    !mark.hits.some((h) => h.v === cheat.id) && !mark.kills.some((k) => k.v === cheat.id));

  // --- and an id that is not a weapon at all -------------------------------
  mark.hits.length = 0;
  send(cheat, { t: MSG.SHOT, o: cheat.spawn, d: [0, 0, -1], w: 'nuke', h: [{ v: mark.id, pt: 'head' }] });
  await sleep(350);
  check('an unknown weapon id is refused', mark.hits.length === 0, `${mark.hits.length} hits seen`);

  // --- the legitimate paths still work -------------------------------------
  mark.hits.length = 0;
  send(cheat, { t: MSG.SHOT, o: cheat.spawn, d: [0, 0, -1], w: 'barrel', h: [{ v: cheat.id, pt: 'torso' }] });
  await sleep(350);
  check('a barrel blast is still priced and applied',
    mark.hits.some((h) => h.v === cheat.id && h.a === cheat.id),
    `${mark.hits.length} hits seen`);

  cheat.ws.close(); mark.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('hazard claim test crashed:', e); process.exit(1); });

/**
 * Self-damage and health-pickup test.
 *
 * A grenade dropped at your own feet did nothing. Self-damage was refused
 * outright by the server, and the client's own health figure is not
 * authoritative in a match — it reduced its health locally, the server never
 * heard about it, and the next authoritative update put it straight back. You
 * could not kill yourself with a grenade however hard you tried.
 *
 * Your own explosives can now hurt you. Bullets still cannot: a client
 * claiming to have shot ITSELF with a rifle is meaningless, and allowing it
 * would open a path into the damage code that no honest client uses.
 *
 *   node server/index.js &
 *   node server/selfdamage-test.js
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, PLAYER_MAX_HEALTH, MATCH_RULES,
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
    const s = { ws, id: null, spawn: null, seq: 0, hits: [], kills: [], scores: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      // Respawning moves you, so keep track — a blast claimed at a stale
      // position would be scaled down by distance falloff.
      else if (m.t === MSG.MATCH && m.sp) s.spawn = m.sp;
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.HIT) s.hits.push(m);
      else if (m.t === MSG.KILL) {
        s.kills.push(m);
        if (m.v === s.id) askToRespawn(s);
      }
      else if (m.t === MSG.SCORE) s.scores.push(m);
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
 * when its own death sequence has finished, and it asks. A test that merely
 * waits gets the backstop many seconds later, which reads as "respawning is
 * broken".
 */
function askToRespawn(s) {
  setTimeout(() => {
    if (s.ws.readyState === 1) send(s, { t: MSG.RESPAWN });
  }, MATCH_RULES.respawnDelaySec * 1000 + 150);
}

/** Long enough for askToRespawn to have fired and the server to have acted. */
const waitRespawn = () => sleep(MATCH_RULES.respawnDelaySec * 1000 + 900);


/** Claim a hit on yourself with the given weapon, from your own position. */
function blowSelfUp(s, weaponId) {
  send(s, {
    t: MSG.SHOT,
    o: [s.spawn[0], s.spawn[1], s.spawn[2]],
    d: [0, 0, -1],
    w: weaponId,
    h: [{ v: s.id, pt: 'torso' }],
  });
}

/*
 * A barrel is a barrel, not a grenade.
 *
 * The server prices every hit from a definition, so a barrel blast had to
 * claim to BE something the server recognised — and it claimed to be a
 * grenade. Barrels therefore hit for the frag's 130 rather than their own 95,
 * and a barrel kill was credited to a frag nobody had thrown.
 *
 * Its own room and its own pair, because a barrel leaves the player wounded
 * and the grenade checks below need someone at full health to survive.
 */
async function barrelChecks() {
  const a = await join('BARREL', 'SELFB');
  const b = await join('BYSTANDER', 'SELFB');
  await sleep(900);

  a.hits.length = 0;
  blowSelfUp(a, 'barrel');
  await sleep(400);
  const barrel = a.hits.find((h) => h.v === a.id && h.a === a.id);
  check('a barrel going off in your face hurts', !!barrel,
    barrel ? `${barrel.d} damage` : 'no hit registered');
  check('and for its own damage, not the grenade\'s',
    !!barrel && barrel.d > 60 && barrel.d < 110,
    barrel ? `${barrel.d} — a frag would be 130` : '');

  /*
   * And you cannot walk around holding one.
   *
   * Hazards share the lookup the server prices weapons from, which would
   * otherwise let a client equip a barrel through an ordinary input. Claiming
   * a hit on YOURSELF is the tell: a barrel permits self-harm and a rifle does
   * not, so a hit landing here would mean the swap had been accepted.
   */
  a.hits.length = 0;
  send(a, { t: MSG.INPUT, q: ++a.seq, p: a.spawn, y: 0, a: 0, f: 0, w: 'barrel' });
  await sleep(250);
  send(a, { t: MSG.SHOT, o: a.spawn, d: [0, 0, -1], h: [{ v: a.id, pt: 'torso' }] });
  await sleep(400);
  check('a barrel cannot be equipped as a weapon',
    !a.hits.some((h) => h.v === a.id && h.a === a.id),
    `${a.hits.length} hits seen`);

  a.ws.close(); b.ws.close();
  await sleep(150);
}

async function main() {
  const room = 'SELFA';
  const a = await join('BOOM', room);
  const b = await join('BYSTANDER', room);
  await sleep(900);

  send(a, { t: MSG.INPUT, q: ++a.seq, p: a.spawn, y: 0, a: 0, f: 0, w: 'grenade' });
  await sleep(300);

  await barrelChecks();

  // --- a grenade at your own feet hurts ------------------------------------
  a.hits.length = 0;
  blowSelfUp(a, 'grenade');
  await sleep(400);
  const selfHit = a.hits.find((h) => h.v === a.id && h.a === a.id);
  check('your own grenade damages you', !!selfHit,
    selfHit ? `${selfHit.d} damage, ${selfHit.hp} hp left` : 'no hit registered');
  check('and it takes a real bite out of the bar',
    !!selfHit && selfHit.d >= PLAYER_MAX_HEALTH * 0.4,
    selfHit ? `${selfHit.d} of ${PLAYER_MAX_HEALTH}` : '');

  // --- a rifle claim against yourself is still refused ----------------------
  a.hits.length = 0;
  blowSelfUp(a, 'rifle');
  await sleep(400);
  check('you still cannot shoot yourself with a rifle',
    !a.hits.some((h) => h.v === a.id && h.a === a.id),
    `${a.hits.length} hits seen`);

  // --- enough grenades kill you, and it is not a kill for anyone ------------
  a.kills.length = 0; a.scores.length = 0;
  for (let i = 0; i < 4; i++) { blowSelfUp(a, 'grenade'); await sleep(260); }
  await sleep(500);
  const suicide = a.kills.find((k) => k.v === a.id);
  check('enough of them kills you', !!suicide, suicide ? `killed by ${suicide.a}` : 'survived');

  const score = a.scores.at(-1);
  const rowA = score?.ps?.find((r) => r[0] === a.id);
  check('a suicide costs a death', !!rowA && rowA[3] >= 1, rowA ? `deaths=${rowA[3]}` : 'no score row');
  check('a suicide does NOT award a kill', !!rowA && rowA[2] === 0,
    rowA ? `kills=${rowA[2]}, deaths=${rowA[3]}` : 'no score row');

  // --- health packs actually heal in a match -----------------------------
  // Health is server-owned, so a pickup that only healed the client was undone
  // by the next authoritative update: packs did nothing at all.
  a.hits.length = 0;
  await waitRespawn();                                 // wait out the respawn
  blowSelfUp(a, 'grenade');                            // take a chunk off first
  await sleep(500);
  const hurt = a.hits.filter((h) => h.v === a.id).at(-1);

  a.hits.length = 0;
  send(a, { t: MSG.HEAL, a: 35 });
  await sleep(400);
  const healed = a.hits.find((h) => h.v === a.id && h.d < 0);
  check('a health pack heals you', !!healed,
    healed ? `+${-healed.d} hp, now ${healed.hp}` : 'no heal registered');
  check('and the server owns the figure', !!healed && !!hurt && healed.hp > hurt.hp,
    healed && hurt ? `${hurt.hp} -> ${healed.hp}` : '');

  // --- but it cannot be spammed -----------------------------------------
  a.hits.length = 0;
  for (let i = 0; i < 8; i++) { send(a, { t: MSG.HEAL, a: 35 }); await sleep(40); }
  await sleep(400);
  check('heal spam is rate limited', a.hits.filter((h) => h.d < 0).length <= 1,
    `${a.hits.filter((h) => h.d < 0).length} of 8 attempts accepted`);

  // --- and an inflated amount is clamped ---------------------------------
  a.hits.length = 0;
  await sleep(1700);
  send(a, { t: MSG.HEAL, a: 9999 });
  await sleep(400);
  const huge = a.hits.find((h) => h.d < 0);
  check('an inflated heal is clamped', !huge || -huge.d <= 35,
    huge ? `asked 9999, got ${-huge.d}` : 'refused');
  check('and never exceeds the health cap', !huge || huge.hp <= PLAYER_MAX_HEALTH,
    huge ? `hp ${huge.hp} of ${PLAYER_MAX_HEALTH}` : '');

  /*
   * --- a blast at your feet hurts while you are MOVING ---------------------
   *
   * Standing still is the easy case and was already covered above. This is
   * the one that gets reported: you throw a grenade, you keep moving, and it
   * seems to do nothing.
   *
   * The server judges a claim against its own copy of the victim, and for
   * everyone EXCEPT you that copy is rewound ~110 ms to match what the
   * shooter saw. Rewinding your own body is wrong — you see yourself live —
   * and handleShot no longer does it. In practice the two positions differ by
   * only centimetres at realistic speeds, so this check cannot isolate the
   * rewind on its own; what it does pin down is the symptom, that a blast at
   * your feet while moving still takes most of the bar.
   */
  a.hits.length = 0;
  await waitRespawn();                                 // come back alive
  const at = [...a.spawn];
  for (let i = 0; i < 40; i++) {
    at[0] += 0.15;                                     // ~7.5 m/s, inside the budget
    send(a, { t: MSG.INPUT, q: ++a.seq, p: at, y: 0, a: 0, f: 0, w: 'grenade' });
    await sleep(20);
  }
  send(a, { t: MSG.SHOT, o: at, d: [0, 0, -1], w: 'grenade', h: [{ v: a.id, pt: 'torso' }] });
  await sleep(450);
  const onTheMove = a.hits.find((h) => h.v === a.id && h.a === a.id);
  const FULL = 130;                                    // the frag's point-blank damage
  check('a blast at your feet hurts even while you are moving', !!onTheMove,
    onTheMove ? `${onTheMove.d} damage` : 'no hit registered');
  check('and takes most of the bar rather than a sliver',
    !!onTheMove && onTheMove.d >= FULL * 0.85,
    onTheMove ? `${onTheMove.d} of ${FULL}` : '');

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('self damage test crashed:', e); process.exit(1); });

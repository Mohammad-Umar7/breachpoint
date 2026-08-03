/**
 * Spawn protection and kill streaks.
 *
 * Both are server-owned, and both are the sort of rule that is easy to write
 * and easy to get subtly wrong in a way no one notices for weeks:
 *
 *   - protection that never ends, or that ends on the wrong event
 *   - protection that is invisible, which reads as broken hit registration
 *   - a streak that survives your own death, so somebody is announced as
 *     UNSTOPPABLE on their first kill back
 *   - a multi-kill window that never closes, so every kill in a match stacks
 *
 * Everything below is read off the server's own messages — HIT, KILL and the
 * snapshot flags — rather than from anything the test computes itself.
 *
 *   node server/index.js &
 *   node server/streak-protect-test.js
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, FLAG, MATCH_RULES, MULTIKILL_WINDOW_MS,
  STREAK_TIERS, streakName, multiKillName,
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
    const s = {
      ws, name, id: null, spawn: null, seq: 0,
      hits: [], kills: [], snapshot: null,
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case MSG.WELCOME: s.id = m.id; s.spawn = m.sp; resolve(s); break;
        case MSG.DENIED: reject(new Error(m.why || 'denied')); break;
        case MSG.HIT: s.hits.push(m); break;
        case MSG.KILL: s.kills.push(m); break;
        case MSG.SNAPSHOT: s.snapshot = m.p; break;
        case MSG.SPAWNPOINT: s.spawn = m.sp; break;
        case MSG.MATCH: if (m.sp) s.spawn = m.sp; break;
        default: break;
      }
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

/** Keep both players standing where they are, so neither trips the move budget. */
function hold(a, aPos, b, bPos) {
  send(a, { t: MSG.INPUT, q: ++a.seq, p: aPos, y: 0, a: 0, f: 0, w: 'rifle' });
  send(b, { t: MSG.INPUT, q: ++b.seq, p: bPos, y: 0, a: 0, f: 0, w: 'rifle' });
}

const rowFor = (who, id) => (who.snapshot ?? []).find((r) => r[0] === id);
const isProtected = (who, id) => {
  const row = rowFor(who, id);
  return !!row && (row[6] & FLAG.PROTECTED) !== 0;
};

/** Hold position until `id` is out of spawn protection, or give up. */
async function waitUnprotected(a, aPos, b, bPos, id, label) {
  const by = Date.now() + MATCH_RULES.spawnProtectSec * 1000 + 4000;
  while (Date.now() < by) {
    hold(a, aPos, b, bPos);
    if (rowFor(a, id) && !isProtected(a, id)) return true;
    await sleep(80);
  }
  console.log(`      (gave up waiting for ${label} to leave spawn protection)`);
  return false;
}

async function main() {
  const room = 'STRKS';
  const a = await join('HUNTER', room);
  const b = await join('QUARRY', room);
  // The second join takes the room LIVE, which respawns everyone — so any
  // position or protection state from before this point is overwritten.
  await sleep(900);

  const aPos = [a.spawn[0], a.spawn[1], a.spawn[2]];
  const bPos = [aPos[0], aPos[1], aPos[2] - 7];

  // --- it is granted on spawn, and it is VISIBLE ---------------------------
  // Checked before anything else, because it lasts two seconds and getting
  // into position costs about that long.
  check('a freshly spawned player is flagged protected on the wire',
    isProtected(a, b.id),
    `flags ${rowFor(a, b.id)?.[6] ?? '(no row)'}`);

  // Walk the target into place rather than teleporting; the movement budget
  // quite rightly refuses a 7 m jump. Protection expires along the way, which
  // is what the next check wants.
  for (let i = 0; i < 40; i++) {
    const t = Math.min(1, (i + 1) / 18);
    hold(a, aPos, b, [aPos[0], aPos[1], aPos[2] - 7 * t]);
    await sleep(50);
  }

  const shoot = (part = 'torso') => send(a, {
    t: MSG.SHOT, o: aPos, d: [0, 0, -1], w: 'rifle',
    h: [{ v: b.id, pt: part }],
  });

  // --- it expires on its own -----------------------------------------------
  const cleared = await waitUnprotected(a, aPos, b, bPos, b.id, 'QUARRY');
  check('protection expires by itself', cleared,
    cleared ? `within ${MATCH_RULES.spawnProtectSec}s` : 'still protected');

  a.hits.length = 0;
  shoot();
  await sleep(300);
  check('and afterwards the same shot lands',
    a.hits.some((h) => h.v === b.id && h.d > 0),
    a.hits.map((h) => `${h.d} dmg`).join(', ') || 'still nothing');

  /*
   * --- the refusal itself, on a controlled respawn -------------------------
   *
   * Done here rather than at the start of the match because the two players
   * are now already in position: `hold` puts the target back at seven metres
   * on the first input after the respawn, so the SAME shot that just landed
   * can be fired again inside the protection window. Anything it does now is
   * the protection rule and nothing else — not a range check, not a rewind
   * miss, not the target having wandered off.
   */
  a.kills.length = 0;
  for (let i = 0; i < 14 && !a.kills.some((k) => k.v === b.id); i++) {
    hold(a, aPos, b, bPos);
    shoot('head');
    await sleep(140);
  }
  check('the target can be killed at all',
    a.kills.some((k) => k.v === b.id), `${a.kills.length} kills seen`);

  const backBy = Date.now() + MATCH_RULES.respawnDelaySec * 1000 + 5000;
  let backProtected = false;
  while (Date.now() < backBy && !backProtected) {
    hold(a, aPos, b, bPos);
    await sleep(80);
    backProtected = isProtected(a, b.id);
  }
  check('respawning grants it again', backProtected,
    backProtected ? '' : 'came back unprotected');

  if (backProtected) {
    a.hits.length = 0; b.hits.length = 0;
    shoot();
    await sleep(300);
    check('and it refuses damage while it lasts',
      a.hits.length === 0 && b.hits.length === 0,
      a.hits.length ? `${a.hits[0].d} damage got through` : 'no damage, as intended');

    // B pulls a trigger — at nothing in particular. That alone should end it.
    send(b, { t: MSG.SHOT, o: bPos, d: [0, 0, 1], w: 'rifle', h: [] });
    await sleep(250);
    hold(a, aPos, b, bPos);
    await sleep(160);
    check('firing gives up protection immediately',
      !isProtected(a, b.id),
      isProtected(a, b.id) ? 'still protected after shooting' : 'dropped on the trigger pull');

    a.hits.length = 0;
    shoot();
    await sleep(300);
    check('and a player who has fired can be hurt again',
      a.hits.some((h) => h.v === b.id && h.d > 0),
      a.hits.map((h) => `${h.d} dmg`).join(', ') || 'no damage');
  }

  // --- streaks --------------------------------------------------------------
  /*
   * Kill the target repeatedly, waiting out the respawn AND the protection
   * each time, and read the streak straight off the KILL messages.
   */
  const killOnce = async () => {
    await waitUnprotected(a, aPos, b, bPos, b.id, 'QUARRY');
    const before = a.kills.length;
    for (let i = 0; i < 16 && a.kills.length === before; i++) {
      hold(a, aPos, b, bPos);
      shoot('head');
      await sleep(130);
    }
    return a.kills.at(-1) ?? null;
  };

  a.kills.length = 0;
  const streaks = [];
  for (let i = 0; i < 3; i++) {
    const k = await killOnce();
    if (k) streaks.push(k.st);
    // Let the respawn happen before the next round.
    await sleep(MATCH_RULES.respawnDelaySec * 1000 + 300);
  }

  check('a streak counts up across kills',
    streaks.length === 3 && streaks[1] === streaks[0] + 1 && streaks[2] === streaks[1] + 1,
    streaks.join(' -> ') || 'no kills recorded');

  check('the third kill reaches the first milestone',
    streaks.at(-1) >= STREAK_TIERS[0][0]
      && streakName(STREAK_TIERS[0][0]) === STREAK_TIERS[0][1],
    `streak ${streaks.at(-1)}, first tier ${STREAK_TIERS[0][0]} = ${STREAK_TIERS[0][1]}`);

  // --- dying ends the streak, and the killer is told ------------------------
  const streakBefore = streaks.at(-1) ?? 0;
  b.kills.length = 0;
  await waitUnprotected(a, aPos, b, bPos, a.id, 'HUNTER');
  for (let i = 0; i < 20 && !b.kills.some((k) => k.v === a.id); i++) {
    hold(a, aPos, b, bPos);
    send(b, { t: MSG.SHOT, o: bPos, d: [0, 0, 1], w: 'rifle', h: [{ v: a.id, pt: 'head' }] });
    await sleep(130);
  }
  const revenge = b.kills.find((k) => k.v === a.id);
  check('being killed reports the run that just ended',
    !!revenge && revenge.es === streakBefore,
    revenge ? `es=${revenge.es}, was on ${streakBefore}` : 'never died');

  // And the next kill by the person whose streak was broken starts at one.
  await sleep(MATCH_RULES.respawnDelaySec * 1000 + 400);
  a.kills.length = 0;
  const fresh = await killOnce();
  check('and the streak restarts from one after dying',
    !!fresh && fresh.st === 1,
    fresh ? `st=${fresh.st}` : 'no kill after respawning');

  // --- the multi-kill window closes ----------------------------------------
  /*
   * Two kills separated by more than MULTIKILL_WINDOW_MS must NOT stack. The
   * respawn delay alone is shorter than the window, so this is a real risk:
   * without the timestamp check every kill in a match would read as one long
   * multi-kill.
   */
  check('a single kill is not a multi-kill',
    !!fresh && fresh.mk === 1 && multiKillName(fresh.mk) === null,
    fresh ? `mk=${fresh.mk}` : '');

  await sleep(MULTIKILL_WINDOW_MS + 400);
  a.kills.length = 0;
  const later = await killOnce();
  check('a kill after the window starts a new multi-kill count',
    !!later && later.mk === 1,
    later ? `mk=${later.mk} after a ${MULTIKILL_WINDOW_MS} ms gap` : 'no kill');
  check('while the streak keeps climbing across the same gap',
    !!later && later.st > 1,
    later ? `st=${later.st}` : '');

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('streak/protection test crashed:', e); process.exit(1); });

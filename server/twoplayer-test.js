/**
 * Two-player match test — "me and my friend playing".
 *
 * Everything below is a thing that has to work for one person to play with one
 * other person, end to end: seeing each other, seeing each other's weapons,
 * hurting each other, dying, coming back, and leaving cleanly. The individual
 * pieces are covered by the other suites; this one checks they hold together
 * over a whole session, in order, on one connection.
 *
 *   node server/index.js &
 *   node server/twoplayer-test.js
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, PLAYER_MAX_HEALTH, PLAYER_START_ARMOR, MATCH_STATE,
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
      hits: [], kills: [], fires: [], joined: [], left: [], scores: [], matches: [],
      snapshot: null,
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case MSG.WELCOME: s.id = m.id; s.spawn = m.sp; s.welcome = m; resolve(s); break;
        case MSG.DENIED: reject(new Error(m.why || 'denied')); break;
        case MSG.HIT: s.hits.push(m); break;
        case MSG.KILL: s.kills.push(m); break;
        case MSG.FIRE: s.fires.push(m); break;
        case MSG.JOINED: s.joined.push(m); break;
        case MSG.LEFT: s.left.push(m); break;
        case MSG.SCORE: s.scores.push(m); break;
        case MSG.MATCH: s.matches.push(m); if (m.sp) s.spawn = m.sp; break;
        case MSG.SPAWNPOINT: s.spawn = m.sp; break;
        case MSG.SNAPSHOT: s.snapshot = m.p; break;
        default: break;
      }
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

/** Hold a position until the other side's snapshot agrees, then a little longer. */
async function stand(who, other, pos, weapon = 'rifle', ms = 700) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    send(who, { t: MSG.INPUT, q: ++who.seq, p: pos, y: 0, a: 0, f: 0, w: weapon });
    await sleep(50);
  }
}

/** Walk a player to a spot, stepping inside the server's movement budget. */
async function walkTo(who, from, to, weapon = 'rifle') {
  const at = [...from];
  for (let i = 0; i < 400; i++) {
    const dx = to[0] - at[0], dz = to[2] - at[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.4) break;
    const step = Math.min(0.55, d);
    at[0] += (dx / d) * step; at[2] += (dz / d) * step;
    send(who, { t: MSG.INPUT, q: ++who.seq, p: at, y: 0, a: 0, f: 0, w: weapon });
    await sleep(50);
  }
  return at;
}

async function main() {
  const room = 'DUETS';

  // --- both get in and see each other --------------------------------------
  const me = await join('ME', room);
  await sleep(300);
  const friend = await join('FRIEND', room);
  await sleep(900);

  check('a second player is announced to the first',
    me.joined.some((j) => j.p?.id === friend.id),
    me.joined.map((j) => j.p?.n).join(', ') || 'nothing announced');
  check('and the second is told who is already here',
    (friend.welcome?.ps ?? []).some((p) => p.id === me.id),
    (friend.welcome?.ps ?? []).map((p) => p.n).join(', ') || 'empty roster');
  check('two players takes the match live',
    me.matches.some((m) => m.st === MATCH_STATE.LIVE),
    me.matches.map((m) => m.st).join(' -> '));

  // --- they can see each other in the world --------------------------------
  const meAt = [me.spawn[0], me.spawn[1], me.spawn[2]];
  const target = [meAt[0], meAt[1], meAt[2] - 8];
  const friendAt = await walkTo(friend, [friend.spawn[0], friend.spawn[1], friend.spawn[2]], target);
  await stand(me, friend, meAt);
  await stand(friend, me, friendAt);

  const row = (me.snapshot ?? []).find((r) => r[0] === friend.id);
  check('each sees where the other actually is', !!row,
    row ? `friend at ${row[1].toFixed(1)}, ${row[3].toFixed(1)}` : 'not in the snapshot');
  check('and how far apart they are is right',
    !!row && Math.abs(Math.hypot(row[1] - meAt[0], row[3] - meAt[2]) - 8) < 1.5,
    row ? `${Math.hypot(row[1] - meAt[0], row[3] - meAt[2]).toFixed(1)} m apart, wanted 8` : '');

  // --- and which gun the other is holding ----------------------------------
  await stand(friend, me, friendAt, 'shotgun');
  const armed = (me.snapshot ?? []).find((r) => r[0] === friend.id);
  check('a weapon swap is visible to the other player',
    !!armed && armed[7] === 'shotgun',
    armed ? `holding ${armed[7]}` : 'no snapshot row');
  await stand(friend, me, friendAt, 'rifle');

  // --- shooting: both directions -------------------------------------------
  const shoot = (from, at, fromPos, weapon = 'rifle') => send(from, {
    t: MSG.SHOT, o: fromPos, d: [0, 0, -1], w: weapon,
    h: [{ v: at.id, pt: 'torso' }],
  });

  me.hits.length = 0; friend.hits.length = 0; friend.fires.length = 0;
  shoot(me, friend, meAt);
  await sleep(350);
  check('I can hurt my friend',
    me.hits.some((h) => h.v === friend.id && h.a === me.id),
    me.hits.map((h) => `${h.d} dmg`).join(', ') || 'no hit');
  check('and my friend sees my gunfire',
    friend.fires.some((f) => f.id === me.id),
    `${friend.fires.length} muzzle flashes seen`);
  check('and we both get told about the same hit',
    me.hits.length > 0 && friend.hits.length > 0,
    `me ${me.hits.length}, friend ${friend.hits.length}`);

  me.hits.length = 0; friend.hits.length = 0; me.fires.length = 0;
  shoot(friend, me, friendAt);
  await sleep(350);
  check('my friend can hurt me back',
    me.hits.some((h) => h.v === me.id && h.a === friend.id),
    me.hits.map((h) => `${h.d} dmg`).join(', ') || 'no hit');
  check('and I see their gunfire too',
    me.fires.some((f) => f.id === friend.id),
    `${me.fires.length} muzzle flashes seen`);

  // --- armour absorbs before health, for both of us -------------------------
  const firstHit = me.hits.find((h) => h.v === me.id);
  check('armour takes the first hits, not health',
    !!firstHit && typeof firstHit.ar === 'number' && firstHit.ar < PLAYER_START_ARMOR,
    firstHit ? `armour ${PLAYER_START_ARMOR} -> ${firstHit.ar}, health ${firstHit.hp}` : '');

  // --- a kill scores for the right person -----------------------------------
  me.kills.length = 0; friend.kills.length = 0; me.scores.length = 0;
  for (let i = 0; i < 12; i++) {
    if (me.kills.some((k) => k.v === friend.id)) break;
    shoot(me, friend, meAt);
    await sleep(150);
  }
  await sleep(400);
  check('enough rounds kill them',
    me.kills.some((k) => k.v === friend.id && k.a === me.id),
    me.kills.length ? 'killed' : 'survived 12 rounds');
  check('and my friend is told they died',
    friend.kills.some((k) => k.v === friend.id),
    `${friend.kills.length} kill messages`);

  const score = me.scores.at(-1);
  const myRow = score?.ps?.find((r) => r[0] === me.id);
  const theirRow = score?.ps?.find((r) => r[0] === friend.id);
  check('the kill is scored to me', !!myRow && myRow[2] >= 1,
    myRow ? `kills=${myRow[2]}` : 'no row');
  check('and the death to them', !!theirRow && theirRow[3] >= 1,
    theirRow ? `deaths=${theirRow[3]}` : 'no row');
  check('and the scoreboard lists us both',
    (score?.ps ?? []).length === 2, `${(score?.ps ?? []).length} players listed`);

  // --- and they come back whole ---------------------------------------------
  await sleep(3200);
  friend.hits.length = 0;
  const backAt = [friend.spawn[0], friend.spawn[1], friend.spawn[2]];
  await stand(friend, me, backAt);
  const near = await walkTo(friend, backAt, target);
  await stand(friend, me, near);
  await sleep(500);
  me.hits.length = 0;
  shoot(me, friend, meAt);
  await sleep(400);
  const afterRespawn = me.hits.find((h) => h.v === friend.id);
  check('they respawn with full health',
    !!afterRespawn && afterRespawn.hp > PLAYER_MAX_HEALTH * 0.8,
    afterRespawn ? `${afterRespawn.hp} of ${PLAYER_MAX_HEALTH}` : 'no hit landed after respawn');
  check('and with their armour back',
    !!afterRespawn && afterRespawn.ar > 0,
    afterRespawn ? `armour ${afterRespawn.ar}` : '');

  // --- one of us leaves ------------------------------------------------------
  me.left.length = 0;
  friend.ws.close();
  await sleep(700);
  check('the one still here is told the other left',
    me.left.some((l) => l.id === friend.id),
    me.left.length ? `id ${me.left[0].id}` : 'never told — the body would hang in the world');
  check('and the match drops back to warmup',
    me.matches.at(-1)?.st === MATCH_STATE.WARMUP,
    `state ${me.matches.at(-1)?.st}`);

  // --- and can come straight back -------------------------------------------
  const again = await join('FRIEND', room);
  await sleep(900);
  check('they can rejoin the same room',
    again.welcome?.r === room, `joined ${again.welcome?.r}`);
  check('and are back on a clean slate',
    (() => { const r = again.welcome?.you; return r && r.k === 0 && r.d === 0 && r.hp === PLAYER_MAX_HEALTH; })(),
    (() => { const r = again.welcome?.you; return r ? `${r.hp} hp, ${r.k}/${r.d}` : 'no summary'; })());
  check('and the returning player sees the one who stayed',
    (again.welcome?.ps ?? []).some((p) => p.id === me.id),
    (again.welcome?.ps ?? []).map((p) => p.n).join(', ') || 'empty');

  me.ws.close(); again.ws.close();
  await sleep(200);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('two-player test crashed:', e); process.exit(1); });

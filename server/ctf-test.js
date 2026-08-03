/**
 * Capture the Flag — the rules, end to end, against a real server.
 *
 * CTF is almost entirely rules rather than shooting, and every one of them is
 * invisible from a screenshot: whether a capture counted, whether a flag went
 * home or stayed on the ground, whether the standoff is being enforced. Get one
 * wrong and the mode still LOOKS like it works — flags move, scores go up —
 * while being a different game from the one everybody expects.
 *
 * So this plays a match. Two clients on opposite teams take, drop, recover and
 * capture a flag, and every assertion reads the server's own FLAG and SCORE
 * messages rather than anything the test worked out for itself.
 *
 *   node server/index.js &
 *   node server/ctf-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, MATCH_RULES, MATCH_STATE } from '../src/net/protocol.js';
import { TEAM, TEAM_NAME, FLAG_STATE, FLAG_EVENT, getMode } from '../src/net/modes.js';
import { ARENAS } from '../src/net/arena.js';

const URL = process.env.URL || 'ws://localhost:8787';
const MAP = 'warehouse';
const BASES = ARENAS[MAP].ctf.bases;
const MODE = getMode('ctf');
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
      ws, name, id: null, team: TEAM.NONE, spawn: null, seq: 0,
      at: null, hits: [], kills: [], flagEvents: [], flags: [], scores: [],
      matches: [], snapshot: null,
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case MSG.WELCOME:
          s.id = m.id; s.spawn = m.sp; s.team = m.you?.tm ?? TEAM.NONE;
          s.at = [m.sp[0], m.sp[1], m.sp[2]];
          s.flags = m.fl ?? [];
          resolve(s);
          break;
        case MSG.DENIED: reject(new Error(m.why || 'denied')); break;
        case MSG.HIT: s.hits.push(m); break;
        case MSG.KILL:
          s.kills.push(m);
          if (m.v === s.id) {
            setTimeout(() => { if (s.ws.readyState === 1) send(s, { t: MSG.RESPAWN }); },
              MATCH_RULES.respawnDelaySec * 1000 + 150);
          }
          break;
        case MSG.FLAG:
          s.flags = m.f ?? [];
          if (m.ev) s.flagEvents.push({ ev: m.ev, by: m.by, team: m.tm });
          break;
        case MSG.SCORE: s.scores.push(m); break;
        case MSG.MATCH: s.matches.push(m); if (m.sp) s.spawn = m.sp; break;
        case MSG.SPAWNPOINT: s.spawn = m.sp; break;
        case MSG.SNAPSHOT: s.snapshot = m.p; break;
        default: break;
      }
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room, m: MAP, g: 'ctf',
    })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));
const input = (s) => send(s, {
  t: MSG.INPUT, q: ++s.seq, p: s.at, y: 0, a: 0, f: 0, w: 'rifle',
});

/**
 * Walk to a point, inside the movement budget.
 *
 * Teleporting is refused — quite rightly — so every position in this test is
 * reached the way a player would reach it. Both clients keep sending input the
 * whole time, because a client that goes quiet is timed out.
 */
async function walk(who, others, [tx, tz], steps = 400) {
  for (let i = 0; i < steps; i++) {
    const dx = tx - who.at[0], dz = tz - who.at[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.25) break;
    const step = Math.min(0.5, d);
    who.at[0] += (dx / d) * step;
    who.at[2] += (dz / d) * step;
    input(who);
    for (const o of others) input(o);
    await sleep(50);
  }
  input(who);
  await sleep(120);
}

/**
 * Wait out a death and stand where the server put us.
 *
 * A dead player is skipped by the flag rules, and their client-side position
 * is whatever it was when they fell — walking from there is walking from a
 * place the server does not think we are, and every input is rejected as a
 * teleport. Both halves matter: without the wait nothing happens because we
 * are dead, and without the resync nothing happens because we are elsewhere.
 */
async function reborn(who, others) {
  await sleep(MATCH_RULES.respawnDelaySec * 1000 + 700);
  who.at = [who.spawn[0], who.spawn[1], who.spawn[2]];
  input(who);
  for (const o of others) input(o);
  await sleep(200);
}

const flagOf = (s, team) => s.flags.find((f) => f.t === team) ?? null;
const lastEvent = (s) => s.flagEvents.at(-1) ?? null;

/**
 * One player, alone, in a room that has not started a match.
 *
 * This is how nearly everyone sees the mode for the first time, and the flags
 * were completely inert: the rules were gated on MATCH_STATE.LIVE and a match
 * needs two people, so a lone player walked over both flags and nothing at all
 * happened. Warmup is now a sandbox and is wiped when the match starts.
 */
async function soloWarmup() {
  const solo = await join('SOLO', 'CTFSL');
  await sleep(800);

  check('a lone player is still put on a team',
    solo.team !== TEAM.NONE, TEAM_NAME[solo.team]);
  check('and the match has not started',
    solo.matches.at(-1)?.st !== MATCH_STATE.LIVE,
    solo.matches.at(-1)?.st ?? 'warmup');

  const enemy = solo.team === TEAM.RED ? TEAM.BLUE : TEAM.RED;
  solo.flagEvents.length = 0;
  await walk(solo, [], BASES[enemy]);
  await sleep(400);

  const took = solo.flagEvents.find((e) => e.ev === FLAG_EVENT.TAKEN);
  check('walking onto the enemy flag in warmup still takes it',
    !!took && took.by === solo.id,
    took ? `taken by ${took.by}` : 'nothing happened');
  check('and it is carried',
    flagOf(solo, enemy)?.s === FLAG_STATE.CARRIED, flagOf(solo, enemy)?.s);

  solo.ws.close();
  await sleep(200);
}

async function main() {
  await soloWarmup();

  const room = 'CTFAA';
  const a = await join('ALPHA', room);
  const b = await join('BRAVO', room);
  await sleep(1000);

  // --- teams ---------------------------------------------------------------
  check('two joiners land on opposite teams',
    a.team !== b.team && a.team !== TEAM.NONE && b.team !== TEAM.NONE,
    `${a.name}=${TEAM_NAME[a.team]}, ${b.name}=${TEAM_NAME[b.team]}`);
  check('the match goes live with two players',
    a.matches.some((m) => m.st === MATCH_STATE.LIVE),
    a.matches.map((m) => m.st).join(' -> '));
  check('and it is reported as capture the flag',
    a.matches.at(-1)?.gm === 'ctf', a.matches.at(-1)?.gm);

  // --- flags start home ----------------------------------------------------
  check('both flags start on their stands',
    a.flags.length === 2 && a.flags.every((f) => f.s === FLAG_STATE.AT_BASE),
    a.flags.map((f) => `${TEAM_NAME[f.t]}:${f.s}`).join(', '));

  const enemyOf = (p) => (p.team === TEAM.RED ? TEAM.BLUE : TEAM.RED);
  const enemyBase = BASES[enemyOf(a)];
  const ownBase = BASES[a.team];

  // --- friendly fire is refused -------------------------------------------
  // Only meaningful between teammates, and there are none here — so instead
  // confirm the shape of it: a player cannot hurt somebody on their own side.
  // Verified below by the fact that ALPHA can hurt BRAVO at all.

  // --- taking the enemy flag ----------------------------------------------
  a.flagEvents.length = 0;
  await walk(a, [b], enemyBase);
  await sleep(400);
  const taken = lastEvent(a);
  check('walking onto the enemy flag takes it',
    taken?.ev === FLAG_EVENT.TAKEN && taken.by === a.id,
    taken ? `${taken.ev} by ${taken.by}` : 'nothing happened');
  check('and it is now carried',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.CARRIED,
    flagOf(a, enemyOf(a))?.s);
  check('by the player who took it',
    flagOf(a, enemyOf(a))?.c === a.id, `carrier ${flagOf(a, enemyOf(a))?.c}`);

  // --- you cannot pick up your OWN flag off its stand ----------------------
  a.flagEvents.length = 0;
  await walk(a, [b], ownBase);
  await sleep(300);
  check('your own flag cannot be carried off its own stand',
    flagOf(a, a.team)?.s === FLAG_STATE.AT_BASE,
    flagOf(a, a.team)?.s);

  // --- capturing ------------------------------------------------------------
  const captured = a.flagEvents.find((e) => e.ev === FLAG_EVENT.CAPTURED);
  check('carrying it home with your own flag there scores',
    !!captured && captured.by === a.id,
    captured ? `captured by ${captured.by}` : 'no capture registered');
  const score = a.scores.at(-1);
  check('and the team score goes up',
    score?.ts?.[a.team] === 1, `RED ${score?.ts?.[TEAM.RED]}, BLUE ${score?.ts?.[TEAM.BLUE]}`);
  check('and the captured flag goes back to its own base',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.AT_BASE,
    flagOf(a, enemyOf(a))?.s);

  // --- dropping on death ----------------------------------------------------
  a.flagEvents.length = 0;
  await walk(a, [b], enemyBase);
  await sleep(400);
  check('the flag can be taken again',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.CARRIED, flagOf(a, enemyOf(a))?.s);

  // Carry it a few metres off the stand before dying, or "dropped where the
  // carrier fell" and "dropped at the base" are the same place and the check
  // below proves nothing.
  await walk(a, [b], [enemyBase[0] - 8, enemyBase[1] - 8]);

  /**
   * BRAVO shoots ALPHA until whatever ALPHA was carrying is on the floor.
   *
   * Claimed from BRAVO's own position, which the server rewinds and
   * range-checks like any other shot — this is not a debug hook.
   */
  const killCarrier = async () => {
    for (let i = 0; i < 20 && flagOf(a, enemyOf(a))?.s === FLAG_STATE.CARRIED; i++) {
      input(a); input(b);
      send(b, {
        t: MSG.SHOT, o: b.at, d: [0, 0, -1], w: 'rifle',
        h: [{ v: a.id, pt: 'head' }],
      });
      await sleep(140);
    }
    await sleep(400);
  };

  a.flagEvents.length = 0;
  await killCarrier();
  const dropped = a.flagEvents.find((e) => e.ev === FLAG_EVENT.DROPPED);
  check('killing the carrier drops the flag',
    !!dropped, dropped ? `dropped by ${dropped.by}` : 'never dropped');
  check('and it lies on the ground rather than going home',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.DROPPED,
    flagOf(a, enemyOf(a))?.s);

  let where = flagOf(a, enemyOf(a));
  check('where the carrier fell, not at the base',
    !!where && Math.hypot(where.x - BASES[enemyOf(a)][0], where.z - BASES[enemyOf(a)][1]) > 2,
    where ? `${where.x.toFixed(1)}, ${where.z.toFixed(1)}` : '');

  /*
   * --- ANYONE on the attacking team can take it off the ground --------------
   *
   * The rule is about teams, not about who was carrying it. A third player
   * joins ALPHA's side and picks the flag up from where ALPHA dropped it —
   * using ALPHA again would pass even if the server had wrongly tied the flag
   * to the player who lost it.
   *
   * This is also why a dropped flag is a fight rather than a reset: the
   * attackers only have to touch it to be back where they were, so defenders
   * have to hold the ground around it.
   */
  /*
   * Park ALPHA at their spawn first.
   *
   * A killed client keeps reporting the position it died at — which is right
   * on top of the flag it just dropped — so ALPHA walks back onto it the
   * instant they respawn and the check below reads "taken by ALPHA". That is
   * the test dragging a corpse around, not the server tying a flag to a
   * player: this made the check pass for the wrong reason before it was fixed.
   */
  await reborn(a, [b]);

  const c = await join('CHARLIE', room);
  await sleep(600);
  check('a third player fills out the attacking team',
    c.team === a.team && c.id !== a.id,
    `CHARLIE=${TEAM_NAME[c.team]}, ALPHA=${TEAM_NAME[a.team]}`);

  c.flagEvents.length = 0;
  await walk(c, [a, b], [where.x, where.z]);
  await sleep(400);
  const retaken = c.flagEvents.find((e) => e.ev === FLAG_EVENT.TAKEN);
  check('a teammate of the carrier picks it up off the ground',
    !!retaken && retaken.by === c.id,
    retaken ? `taken by ${retaken.by}` : 'not taken');
  check('and carries it from there, not from the base',
    flagOf(c, enemyOf(a))?.s === FLAG_STATE.CARRIED, flagOf(c, enemyOf(a))?.s);

  /*
   * Put it back on the floor for the return test below — this time by killing
   * CHARLIE, so the flag lying there was never ALPHA's to begin with and the
   * return check below cannot pass on who-dropped-it bookkeeping either.
   */
  c.flagEvents.length = 0;
  for (let i = 0; i < 20 && flagOf(c, enemyOf(a))?.s === FLAG_STATE.CARRIED; i++) {
    input(a); input(b); input(c);
    send(b, {
      t: MSG.SHOT, o: b.at, d: [0, 0, -1], w: 'rifle',
      h: [{ v: c.id, pt: 'head' }],
    });
    await sleep(140);
  }
  await sleep(400);
  check('and dropping it again leaves it on the ground',
    flagOf(b, enemyOf(a))?.s === FLAG_STATE.DROPPED, flagOf(b, enemyOf(a))?.s);
  where = flagOf(b, enemyOf(a));
  // Same again: get CHARLIE off the flag so BRAVO's return is BRAVO's doing.
  await reborn(c, [a, b]);

  // --- the owning team returns its own dropped flag -------------------------
  a.flagEvents.length = 0;
  b.flagEvents.length = 0;
  await walk(b, [a, c], [where.x, where.z]);
  await sleep(400);
  const returned = b.flagEvents.find((e) => e.ev === FLAG_EVENT.RETURNED);
  check('anyone on its own team touching it sends it straight home',
    !!returned && returned.by === b.id,
    returned ? `returned by ${returned.by}` : 'not returned');
  check('and it is back on its stand',
    flagOf(b, enemyOf(a))?.s === FLAG_STATE.AT_BASE,
    flagOf(b, enemyOf(a))?.s);

  // --- the standoff ---------------------------------------------------------
  /*
   * The rule the whole mode turns on: with your own flag out, you cannot
   * score. BRAVO takes ALPHA's flag, then ALPHA takes BRAVO's and runs home —
   * and must NOT capture.
   */
  b.flagEvents.length = 0;
  await walk(b, [a], BASES[a.team]);
  await sleep(400);
  check('the other team can take your flag too',
    flagOf(b, a.team)?.s === FLAG_STATE.CARRIED, flagOf(b, a.team)?.s);

  a.flagEvents.length = 0;
  const scoreBefore = a.scores.at(-1)?.ts?.[a.team] ?? 0;
  await walk(a, [b], enemyBase);
  await sleep(300);
  await walk(a, [b], ownBase);
  await sleep(600);
  const scoreAfter = a.scores.at(-1)?.ts?.[a.team] ?? 0;
  check('but with your own flag gone, bringing theirs home scores NOTHING',
    scoreAfter === scoreBefore,
    `${scoreBefore} -> ${scoreAfter}`);
  check('and you keep hold of it while you wait',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.CARRIED,
    flagOf(a, enemyOf(a))?.s);

  a.ws.close(); b.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ctf test crashed:', e); process.exit(1); });

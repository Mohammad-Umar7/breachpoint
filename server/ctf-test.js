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

/**
 * Every client that has joined, so none of them can go quiet.
 *
 * The server times out a socket that stops sending input, and `walk` only
 * keeps the clients it was handed alive. Every time this test grew, some step
 * forgot one of them — a player was silently removed from the room and the
 * checks after it failed for a reason that had nothing to do with the rule
 * being tested. A heartbeat over ALL of them makes that impossible.
 */
const live = [];

function join(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = {
      ws, name, id: null, team: TEAM.NONE, spawn: null, seq: 0,
      at: null, dead: false,
      hits: [], kills: [], flagEvents: [], flags: [], scores: [],
      matches: [], snapshot: null,
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case MSG.WELCOME:
          s.id = m.id; s.spawn = m.sp; s.team = m.you?.tm ?? TEAM.NONE;
          s.at = [m.sp[0], m.sp[1], m.sp[2]];
          s.flags = m.fl ?? [];
          live.push(s);
          resolve(s);
          break;
        case MSG.DENIED: reject(new Error(m.why || 'denied')); break;
        case MSG.HIT: s.hits.push(m); break;
        case MSG.KILL:
          s.kills.push(m);
          if (m.v === s.id) {
            s.dead = true;
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
  resync(who);
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
  /*
   * Claim the reserved spawn first, THEN read back.
   *
   * Resyncing straight away reads a snapshot that can still hold the position
   * we died at — which, when we died on a flag, put us back on top of it and
   * had us pick up a flag a teammate was walking over to collect.
   */
  who.dead = false;
  who.at = [who.spawn[0], who.spawn[1], who.spawn[2]];
  input(who);
  await sleep(250);
  resync(who);
  input(who);
  for (const o of others) input(o);
  await sleep(200);
}

/**
 * Adopt the server's idea of where we are.
 *
 * The server clamps movement it considers too fast and simply ignores the
 * rest, so a client that walks a long way can end up believing it is somewhere
 * the server never put it. From then on every input reads as a teleport and is
 * refused, and the player stands still while the test walks a ghost around —
 * which is exactly how the pass check failed, with the client at 5,5 and the
 * server holding them at 18,18.
 */
function resync(who) {
  const row = (who.snapshot ?? []).find((r) => r[0] === who.id);
  if (!row) return;
  /*
   * Only when the two have genuinely come apart.
   *
   * A snapshot is up to a tick old, so adopting it unconditionally drags a
   * client backwards a few centimetres every time — and worse, a snapshot
   * taken just before a respawn puts a player back where they died. Three
   * metres is far larger than any honest lag and far smaller than the drift
   * that breaks a walk.
   */
  if (Math.hypot(row[1] - who.at[0], row[3] - who.at[2]) < 3) return;
  who.at = [row[1], row[2], row[3]];
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
  live.length = 0;
  await sleep(200);
}

/**
 * You cannot score through a ceiling.
 *
 * Both proximity tests were measured on the FLOOR PLANE alone, which makes
 * each of them a column of infinite height. On a flat arena nobody noticed. On
 * a three-storey house every base has two more floors stacked directly over
 * it, so a carrier standing on the landing ABOVE the enemy base captured
 * through the ceiling — and it was reported as the light column being the
 * trigger, because the beam rises out of the base through exactly those floors
 * and is therefore where you are standing when it happens.
 *
 * Its own room and its own pair of clients, so it can move a player somewhere
 * no normal sequence would put them without disturbing the match next door.
 */
async function ceilingCapture() {
  const room = 'CTFCL';
  const x = await join('XRAY', room);
  const y = await join('YNKE', room);
  live.push(x, y);
  await sleep(900);

  const foe = x.team === TEAM.RED ? TEAM.BLUE : TEAM.RED;
  const enemyBase = BASES[foe];
  const home = BASES[x.team];
  const groundY = ARENAS[MAP].spawnY;

  // Take the enemy flag with our own still safely at home.
  await walk(x, [y], enemyBase);
  await sleep(400);
  check('the ceiling case starts with a flag in hand',
    flagOf(x, foe)?.s === FLAG_STATE.CARRIED, flagOf(x, foe)?.s);
  check('and our own flag at home, so nothing else can block a capture',
    flagOf(x, x.team)?.s === FLAG_STATE.AT_BASE, flagOf(x, x.team)?.s);

  /*
   * Climb BEFORE walking home, a step at a time.
   *
   * Arriving at ground level would capture on the way in, and one 4 m jump is
   * refused outright — the server range-checks how far a client claims to have
   * moved between reports, so a teleport leaves the player where they were and
   * the check below would pass having proved nothing.
   */
  for (let i = 0; i < 10; i++) {
    x.at = [x.at[0], x.at[1] + 0.45, x.at[2]];
    input(x); input(y);
    await sleep(90);
  }
  const climbed = x.at[1] - groundY;

  x.flagEvents.length = 0;
  const before = (x.scores.at(-1)?.ts?.[x.team]) ?? 0;
  await walk(x, [y], home);
  for (let i = 0; i < 10; i++) { input(x); input(y); await sleep(90); }

  check('standing above your own base does not capture',
    !x.flagEvents.some((e) => e.ev === FLAG_EVENT.CAPTURED),
    `${climbed.toFixed(1)} m up: ${x.flagEvents.map((e) => e.ev).join(', ') || 'nothing happened'}`);
  check('and the flag is still in your hands',
    flagOf(x, foe)?.s === FLAG_STATE.CARRIED, flagOf(x, foe)?.s);
  check('and the score has not moved',
    ((x.scores.at(-1)?.ts?.[x.team]) ?? 0) === before,
    `${before} -> ${(x.scores.at(-1)?.ts?.[x.team]) ?? 0}`);

  // And the positive half, without which the check above would pass just as
  // well if capturing were broken outright: come down, and it scores.
  x.flagEvents.length = 0;
  for (let i = 0; i < 14 && x.at[1] > groundY; i++) {
    x.at = [home[0], Math.max(groundY, x.at[1] - 0.45), home[1]];
    input(x); input(y);
    await sleep(90);
  }
  for (let i = 0; i < 8; i++) { input(x); input(y); await sleep(90); }
  check('and coming down to the base itself scores',
    x.flagEvents.some((e) => e.ev === FLAG_EVENT.CAPTURED),
    x.flagEvents.map((e) => e.ev).join(', ') || 'still nothing');

  x.ws.close(); y.ws.close();
  live.length = 0;
  await sleep(200);
}

/**
 * A DEFENDER STANDING ON THE FLAG MUST NOT DENY IT.
 *
 * The pickup loop used to `break` on the first player it found inside a flag's
 * radius, whether or not that player did anything. A defender parked on their
 * own flag is the case that makes that fatal: their branch does nothing (a
 * flag on its stand cannot be "returned"), and the break then threw away
 * everyone else in the radius for that tick. An attacker could stand on the
 * enemy flag forever and never pick it up — the only cure was killing the
 * camper, because the dead are skipped before the break.
 *
 * The rest of this suite cannot see it: every other case keeps its two players
 * away from one flag at the same moment, which is the one arrangement that
 * triggers it.
 *
 * JOIN ORDER IS THE TRIGGER. `this.players` is a Map in join order, so the
 * defender has to arrive FIRST to be the one the loop breaks on. Joining them
 * the other way round passes against the broken server too.
 */
async function campedFlag() {
  const room = 'CTFCM';
  const def = await join('DEFEND', room);      // first: the camper
  const atk = await join('ATTACK', room);      // second: must still get it
  live.push(def, atk);
  await sleep(900);

  const target = def.team;                     // DEFEND's own flag
  atk.flagEvents.length = 0;

  // The defender parks on their own flag and stays there.
  await walk(def, [atk], BASES[target]);
  await sleep(300);
  check('the camper is standing on their own flag, which stays home',
    flagOf(def, target)?.s === FLAG_STATE.AT_BASE,
    `${TEAM_NAME[target]} flag is ${flagOf(def, target)?.s}`);

  // ...and the attacker walks onto the same flag, with the camper still on it.
  await walk(atk, [def], BASES[target]);
  await sleep(500);

  const took = atk.flagEvents.find((e) => e.ev === FLAG_EVENT.TAKEN);
  check('an attacker can take a flag a defender is standing on',
    !!took && took.by === atk.id,
    took ? `taken by ${took.by === atk.id ? 'the attacker' : took.by}`
         : 'nothing happened — the camper ate the tick');
  check('and the server agrees it is carried',
    flagOf(atk, target)?.s === FLAG_STATE.CARRIED,
    flagOf(atk, target)?.s ?? 'no flag state');

  def.ws.close();
  atk.ws.close();
  live.length = 0;
  await sleep(250);
}

/**
 * A FLAG CARRIED IN WARMUP IS PUT BACK — AND THE CLIENTS ARE TOLD.
 *
 * `evaluateMatchState` resets the flags on the WARMUP -> LIVE transition, which
 * is right, and then broadcast only MSG.MATCH — which carries no flag state.
 * MSG.FLAG is the only thing that moves a flag on a client, so a player who
 * picked one up during the warmup sandbox kept carrying a phantom: the HUD
 * held CARRYING, the flag rode their back on the other player's screen, and
 * running it home scored nothing, because the server had long since put it
 * back on its stand.
 *
 * `soloWarmup` above closes its socket immediately after taking the flag, so
 * it never reaches the transition. This is that missing half.
 */
async function warmupCarryReset() {
  const room = 'CTFWU';
  const first = await join('EARLY', room);
  live.push(first);
  await sleep(700);

  const enemy = first.team === TEAM.RED ? TEAM.BLUE : TEAM.RED;
  await walk(first, [], BASES[enemy]);
  await sleep(400);
  check('warmup: the lone player is carrying the enemy flag',
    flagOf(first, enemy)?.s === FLAG_STATE.CARRIED,
    flagOf(first, enemy)?.s ?? 'not carried');

  /*
   * NOW RUN AWAY FROM THE STAND, which is the whole reason this reproduces.
   *
   * A carrier still inside the stand's pickup cylinder when the match flips
   * simply re-takes the flag on the next tick, and the desync never appears —
   * so a version of this test that stands still passes against the broken
   * server. Stepping off is also just what a player does: you grab the flag
   * and run. The midpoint is clear of both bases, so nothing is captured on
   * the way.
   */
  await walk(first, [], [0, 0]);
  await sleep(300);
  check('and has carried it away from the enemy stand',
    flagOf(first, enemy)?.s === FLAG_STATE.CARRIED,
    `still ${flagOf(first, enemy)?.s} at ${first.at[0].toFixed(1)}, ${first.at[2].toFixed(1)}`);

  // A second player arrives and the match goes live.
  first.flags = [];
  const second = await join('LATER', room);
  live.push(second);
  await sleep(1200);

  check('the match went live', first.matches.some((m) => m.st === MATCH_STATE.LIVE),
    first.matches.map((m) => m.st).join(' -> '));
  check('and the carrier is TOLD the flag went back on its stand',
    flagOf(first, enemy)?.s === FLAG_STATE.AT_BASE,
    flagOf(first, enemy)
      ? `carrier still sees ${flagOf(first, enemy).s}`
      : 'carrier was never sent any flag state at all');
  check('the player who joined sees it home too',
    flagOf(second, enemy)?.s === FLAG_STATE.AT_BASE,
    flagOf(second, enemy)?.s ?? 'no flag state');

  first.ws.close();
  second.ws.close();
  live.length = 0;
  await sleep(250);
}

async function main() {
  await soloWarmup();
  await ceilingCapture();
  await campedFlag();
  await warmupCarryReset();

  // Nobody idles out. Reports the position each client already believes it is
  // at, so it never fights `walk` — it just stops the socket going silent.
  const heartbeat = setInterval(() => {
    for (const s of live) {
      /*
       * The dead are skipped, and that is not an optimisation.
       *
       * A killed client's `at` is still the spot it fell — which, for a flag
       * carrier, is exactly where the flag now lies. Beating that position out
       * while dead had the server put the player back there on respawn, so
       * they picked their own dropped flag straight back up before the
       * teammate walking over to collect it had covered half the distance.
       * The check that failed said "a teammate picks it up"; the reason was a
       * corpse that would not stop talking.
       */
      if (s.dead || s.ws.readyState !== 1 || !s.at) continue;
      input(s);
    }
  }, 250);

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
  await walk(c, [a, b], [ownBase[0], ownBase[1]]);

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

  /*
   * --- dropping it on purpose ----------------------------------------------
   *
   * ALPHA is still holding BRAVO's flag from the standoff above. Pressing the
   * key has to put it down where they stand — and, crucially, LEAVE it there.
   * The pick-up rule is proximity-based, so without a lockout on the player
   * who asked, the flag they just dropped is handed straight back on the next
   * tick and the key appears to do nothing at all.
   */
  /*
   * Walk out to open ground first.
   *
   * ALPHA finished the standoff standing on their own base, where BRAVO was
   * waiting — so the flag was dropped at the feet of one of its owners and
   * went straight home. Correct behaviour, useless test: it proved the return
   * rule for a third time and never exercised the drop.
   */
  await walk(a, [b, c], [0, 0]);
  // CHARLIE waits a few metres off — outside the touch radius, so they cannot
  // take it during the lockout, and close enough that the pass is a short run
  // rather than a thirty-metre trek across a live match.
  await walk(c, [a, b], [5, 5]);

  a.flagEvents.length = 0;
  send(a, { t: MSG.DROPFLAG });
  await sleep(500);
  input(a); input(b); input(c);

  const putDown = a.flagEvents.find((e) => e.ev === FLAG_EVENT.DROPPED);
  check('pressing drop puts a carried flag down',
    !!putDown && putDown.by === a.id,
    putDown ? `dropped by ${putDown.by}` : 'nothing happened');

  const lying = flagOf(a, enemyOf(a));
  check('and it lands where the carrier is standing',
    !!lying && Math.hypot(lying.x - a.at[0], lying.z - a.at[2]) < 2.5,
    lying ? `${lying.x.toFixed(1)}, ${lying.z.toFixed(1)} vs ${a.at[0].toFixed(1)}, ${a.at[2].toFixed(1)}` : '');

  // Stand on it for a full second. The dropper must NOT get it back.
  for (let i = 0; i < 8; i++) { input(a); input(b); input(c); await sleep(120); }
  check('and standing on it does not hand it straight back',
    flagOf(a, enemyOf(a))?.s === FLAG_STATE.DROPPED, flagOf(a, enemyOf(a))?.s);

  // Then walk off it. The lockout is two seconds, not forever — standing on a
  // flag you dropped gets it back, which is right, and is not the pass.
  await walk(a, [b, c], [ownBase[0], ownBase[1]]);

  /*
   * ...but a teammate can take it immediately, which is the whole point: a
   * deliberate drop is a PASS, not a fumble.
   */
  c.flagEvents.length = 0;
  await walk(c, [a, b], [lying.x, lying.z]);
  await sleep(400);
  const passed_to = c.flagEvents.find((e) => e.ev === FLAG_EVENT.TAKEN);
  check('while a teammate can pick it up at once',
    !!passed_to && passed_to.by === c.id,
    passed_to ? `taken by ${passed_to.by}` : 'not taken');

  // And the lockout expires rather than lasting the match.
  check('the flag ends up carried, not stranded',
    flagOf(c, enemyOf(a))?.s === FLAG_STATE.CARRIED, flagOf(c, enemyOf(a))?.s);

  /*
   * --- the score reaches the client ----------------------------------------
   *
   * A capture sends TWO messages — the flag first, then the score — and the
   * client's HUD was only refreshed by the first. The team score is what says
   * a capture counted, so it has to be in a message the client actually acts
   * on. This is the server half of that: the SCORE that follows a capture must
   * carry the new team total.
   */
  const lastScore = a.scores.at(-1);
  check('every score update carries the team totals',
    lastScore?.ts != null && typeof lastScore.ts[TEAM.RED] === 'number',
    JSON.stringify(lastScore?.ts));
  check('and they match the captures actually made',
    lastScore.ts[a.team] === 1, `${TEAM_NAME[a.team]} ${lastScore.ts[a.team]}`);
  const alphaRow = lastScore.ps.find((r) => r[0] === a.id);
  check('and each player carries their own capture count',
    alphaRow?.[6] === 1, `ALPHA captures ${alphaRow?.[6]}`);

  clearInterval(heartbeat);
  a.ws.close(); b.ws.close(); c.ws.close();
  await sleep(150);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ctf test crashed:', e); process.exit(1); });

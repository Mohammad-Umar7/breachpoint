/**
 * The scout drone's server authority, end to end, against a real server.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything the drone is made of is a RULE, and every one of them is
 * invisible from a screenshot. Whether a drone exists at all, whether a drive
 * report was inside its envelope, whether a robot being blown up quietly
 * awarded somebody a kill — get any of them wrong and the feature still LOOKS
 * like it works. A drone appears, it drives, it can be shot. It just also ends
 * matches, or leaves a free sensor standing in a doorway belonging to a player
 * who went home ten minutes ago.
 *
 * So this plays it. Real sockets, and every assertion reads the server's own
 * DRONESTATE and SNAPSHOT frames rather than anything the test worked out for
 * itself — because what is being tested is precisely whether the server agrees
 * with what the client believes.
 *
 *   node server/index.js &
 *   node server/drone-test.js
 */
import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, MATCH_STATE, MATCH_RULES, LIMITS,
  DRONE, DRONE_CMD, DRONE_EVENT, droneIdFor, damageFor,
} from '../src/net/protocol.js';
import { ARENAS, MAP_IDS } from '../src/net/arena.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';

const URL = process.env.URL || 'ws://localhost:8787';

/**
 * Which map to fly on is DISCOVERED, never spelled out.
 *
 * The whole gate is that a map declares the drone for itself — `drone: true`
 * on the map module, mirrored as `ARENAS[id].drone` for the server, which
 * cannot import THREE. Naming 'house' here would be a second declaration of
 * the same fact and would go stale the day a second map gets one. It also
 * makes the negative case honest: PLAIN_MAP is not "the warehouse", it is
 * "any map that did not ask for this".
 */
const DRONE_MAP = MAP_IDS.find((id) => ARENAS[id].drone);
const PLAIN_MAP = MAP_IDS.find((id) => !ARENAS[id].drone);

const RIFLE = WEAPON_DEFS.find((w) => w.id === 'rifle');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/**
 * Every client that has joined, so none of them can go quiet.
 *
 * The server drops a socket that stops sending, and it despawns a drone whose
 * pilot stops driving — two separate deadlines, and this heartbeat is what
 * keeps both at bay for clients that are not the subject of the current check.
 * Without it, half the assertions below would fail for reasons that have
 * nothing whatever to do with the rule being tested, which is exactly the trap
 * `ctf-test.js` records having fallen into every time it grew.
 */
const live = [];

function join(name, room, mapId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s = {
      ws, name, id: null, at: null, spawn: null, seq: 0, dseq: 0,
      /** Our own drone as WE believe it: what the heartbeat re-reports. */
      drone: null,
      /** Cleared to stop the drive reports without silencing the socket. */
      driving: true,
      droneEvents: [], hits: [], fires: [], kills: [], scores: [], matches: [],
      /** Newest snapshot: player rows, and drone rows or null when there is
       *  no `d` key at all — which is what "no drones in this room" is. */
      snapshot: null, droneRows: null, dKeyCount: 0,
      /**
       * DRONESTATE and LEFT in arrival order, which is the only way to see an
       * ORDERING rule from outside: a drone must leave the room before its
       * owner is removed from it, and both are broadcasts.
       */
      log: [],
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case MSG.WELCOME:
          s.id = m.id; s.spawn = m.sp; s.at = [m.sp[0], m.sp[1], m.sp[2]];
          live.push(s);
          resolve(s);
          break;
        case MSG.DENIED: reject(new Error(m.why || 'denied')); break;
        case MSG.DRONESTATE:
          s.droneEvents.push({ ...m, at: Date.now() });
          s.log.push({ kind: 'drone', ev: m.ev, o: m.o, id: m.id });
          break;
        case MSG.LEFT: s.log.push({ kind: 'left', id: m.id }); break;
        case MSG.HIT: s.hits.push(m); break;
        case MSG.FIRE: s.fires.push(m); break;
        case MSG.KILL:
          s.kills.push(m);
          if (m.v === s.id) {
            setTimeout(() => { if (s.ws.readyState === 1) send(s, { t: MSG.RESPAWN }); },
              MATCH_RULES.respawnDelaySec * 1000 + 200);
          }
          break;
        case MSG.SCORE: s.scores.push(m); break;
        case MSG.MATCH:
          s.matches.push(m);
          // A MATCH carrying `sp` is the server PLACING us — a respawn, or a
          // correction after it refused a position. Adopting it is what a real
          // client does; not adopting it means every later input reads as a
          // teleport and is refused, and the test then walks a ghost around.
          if (m.sp) { s.spawn = m.sp; s.at = [m.sp[0], m.sp[1], m.sp[2]]; }
          break;
        case MSG.SPAWNPOINT: s.spawn = m.sp; break;
        case MSG.SNAPSHOT:
          s.snapshot = m.p;
          s.droneRows = m.d ?? null;
          if (m.d !== undefined) s.dKeyCount++;
          break;
        default: break;
      }
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({
      t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room, m: mapId, g: 'ffa',
    })));
  });
}

const send = (s, o) => { if (s.ws.readyState === 1) s.ws.send(JSON.stringify(o)); };
const input = (s) => send(s, {
  t: MSG.INPUT, q: ++s.seq, p: s.at, y: 0, a: 0, f: 0, w: 'rifle',
});
const drive = (s, p, yaw = 0) => send(s, {
  t: MSG.DRONE, c: DRONE_CMD.DRIVE, q: ++s.dseq, p, y: yaw,
});
const deploy = (s) => send(s, { t: MSG.DRONE, c: DRONE_CMD.DEPLOY });
const pilot = (s, on) => send(s, { t: MSG.DRONE, c: DRONE_CMD.PILOT, on: on ? 1 : 0 });
const recall = (s) => send(s, { t: MSG.DRONE, c: DRONE_CMD.RECALL });
const shoot = (s, victimId, part = 'head') => send(s, {
  t: MSG.SHOT, q: ++s.seq, o: s.at, d: [0, 0, -1], w: 'rifle',
  h: [{ v: victimId, pt: part }],
});

/** The snapshot row for a drone id, or null. */
const rowOf = (s, droneId) => (s.droneRows ?? []).find((r) => r[0] === droneId) ?? null;
const eventOf = (s, ev) => s.droneEvents.find((e) => e.ev === ev) ?? null;
const scoreRow = (score, id) => (score?.ps ?? []).find((r) => r[0] === id) ?? null;

/**
 * Poll until something is true, rather than sleeping a guessed interval.
 *
 * Everything here crosses a 30 Hz tick and a socket, so "wait 300 ms and look"
 * is a coin toss that comes up tails on a loaded machine and fails a rule that
 * is perfectly correct.
 */
async function waitFor(pred, ms = 2500, step = 50) {
  const until = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() >= until) return pred();
    await sleep(step);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`drone map: ${DRONE_MAP ?? '(none registered yet)'}   `
    + `plain map: ${PLAIN_MAP ?? '(none)'}`);

  /*
   * Nobody idles out, and nobody's drone goes stale.
   *
   * Reports the position each client already believes it is at, and re-reports
   * its drone where it already is — a zero-length step, which is always inside
   * the budget. So this never fights a check that is deliberately moving
   * something; it only stops the two silence deadlines firing.
   */
  const heartbeat = setInterval(() => {
    for (const s of live) {
      if (s.ws.readyState !== 1 || !s.at) continue;
      input(s);
      if (s.drone && s.driving) drive(s, s.drone.p, s.drone.yaw);
    }
  }, 200);

  // --- a map that never asked for this -------------------------------------
  console.log('\n--- the map decides ---');
  {
    const w = await join('PLAIN', 'DRNPL', PLAIN_MAP);
    await sleep(600);
    deploy(w);
    const denied = await waitFor(() => eventOf(w, DRONE_EVENT.DENIED));
    check('deploying on a map that does not declare a drone is refused',
      !!denied, denied ? `"${denied.why}"` : 'nothing came back');
    check('and the refusal says why, because silence reads as a broken key',
      typeof denied?.why === 'string' && denied.why.length > 0, denied?.why);
    check('a room with no drones never sends a `d` key at all',
      w.dKeyCount === 0, `${w.dKeyCount} snapshots carried one`);
    w.ws.close();
    live.length = 0;
    await sleep(200);
  }

  if (!DRONE_MAP) {
    clearInterval(heartbeat);
    console.log('\n!!  PENDING — no registered map declares `drone`, so everything below');
    console.log('!!  this line examined nothing and was NOT run: deploy, drive, the');
    console.log('!!  drive envelope, hit registration, and all five despawn paths.');
    console.log('!!  This suite becomes a real proof the moment a map lands with');
    console.log('!!  `drone: true` and a matching ARENAS[id].drone block.');
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }

  const arena = ARENAS[DRONE_MAP];
  const { maxY, leash } = arena.drone;
  const bounds = arena.bounds;
  const inBounds = ([x, y, z]) => x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY
    && z >= bounds.minZ && z <= bounds.maxZ;

  /*
   * The battery is ninety seconds, and it is the one server-side timer nothing
   * else in the feature can prove. So it runs in its OWN ROOM, from here, in
   * the background: ECHO deploys, pilots, and the heartbeat keeps driving it
   * for the whole run. Because the drive reports never stop, the ONLY thing
   * that can despawn it is the battery — the stale deadline is ruled out by
   * construction rather than by hoping the timing worked out.
   *
   * A separate room so its drone never appears in any `d` array the checks
   * below read.
   */
  const e = await join('ECHO', 'DRNBT', DRONE_MAP);
  await sleep(500);
  deploy(e);
  const eDeployed = await waitFor(() => eventOf(e, DRONE_EVENT.DEPLOYED));
  e.drone = { id: eDeployed?.id, p: eDeployed?.p ?? e.at, yaw: eDeployed?.y ?? 0 };
  pilot(e, true);
  const batteryStartedAt = Date.now();

  const a = await join('ALPHA', 'DRNAA', DRONE_MAP);
  const b = await join('BRAVO', 'DRNAA', DRONE_MAP);
  await sleep(1000);

  // --- deploying ------------------------------------------------------------
  console.log('\n--- creation is a server event ---');
  const droneA = droneIdFor(a.id);
  check('a room with nobody piloting sends no `d` key either',
    a.dKeyCount === 0, `${a.dKeyCount} snapshots carried one`);

  a.droneEvents.length = 0;
  b.droneEvents.length = 0;
  deploy(a);
  const deployed = await waitFor(() => eventOf(a, DRONE_EVENT.DEPLOYED));
  check('deploying on a map that declares a drone is accepted', !!deployed);
  check("the drone's wire id is minus its owner's",
    deployed?.id === droneA, `${deployed?.id} for player ${a.id}`);
  check('and the OTHER player is told, because creation is broadcast rather than predicted',
    !!(await waitFor(() => b.droneEvents.find((x) =>
      x.ev === DRONE_EVENT.DEPLOYED && x.o === a.id))));

  a.drone = { id: droneA, p: [...(deployed?.p ?? a.at)], yaw: deployed?.y ?? 0 };
  const deployAt = [...a.drone.p];

  const rowA = await waitFor(() => rowOf(a, droneA));
  const rowB = await waitFor(() => rowOf(b, droneA));
  check('both clients see it in the snapshot', !!rowA && !!rowB);
  check('the row names the owner, so nobody has to know the id convention',
    rowA?.[6] === a.id, `owner ${rowA?.[6]}`);
  check('and it starts on full chassis health',
    rowA?.[5] === DRONE.maxHealth, `${rowA?.[5]} of ${DRONE.maxHealth}`);
  check('placed at the pilot — the deploy message carries no point of its own',
    !!rowA && Math.hypot(rowA[1] - a.at[0], rowA[3] - a.at[2]) < 1.5,
    rowA ? `${rowA[1].toFixed(1)},${rowA[3].toFixed(1)} vs pilot `
      + `${a.at[0].toFixed(1)},${a.at[2].toFixed(1)}` : '');

  a.droneEvents.length = 0;
  deploy(a);
  const second = await waitFor(() => eventOf(a, DRONE_EVENT.DENIED));
  check('a second deploy by the same player is refused', !!second,
    second ? `"${second.why}"` : 'nothing came back');
  check('and there is still exactly one drone in the room',
    (a.droneRows ?? []).length === 1, `${(a.droneRows ?? []).length} rows`);

  pilot(a, true);
  await sleep(250);

  // --- driving --------------------------------------------------------------
  console.log('\n--- the drive envelope ---');
  const moveTo = [deployAt[0] + 1, deployAt[1], deployAt[2]];
  a.drone.p = moveTo;
  drive(a, moveTo, 0.5);
  const movedRow = await waitFor(() => {
    const r = rowOf(b, droneA);
    return r && Math.abs(r[1] - moveTo[0]) < 0.25 ? r : null;
  });
  check('a drive report inside the envelope moves the row for everyone',
    !!movedRow, movedRow ? `x ${movedRow[1]}` : `still at ${rowOf(b, droneA)?.[1]}`);

  /**
   * Send one deliberately illegal position and prove three things at once:
   * the server answers rather than dropping it, the answer carries the pose it
   * still holds, and the world did not move.
   *
   * The answer is the part that matters. A refused report that is silently
   * discarded leaves the browser simulating forward from a position the server
   * never accepted, and the two then diverge without limit.
   */
  const refuses = async (label, badPos, detail = '') => {
    a.droneEvents.length = 0;
    const before = rowOf(b, droneA);
    drive(a, badPos, 0.5);
    const corrected = await waitFor(() => eventOf(a, DRONE_EVENT.CORRECT));
    check(`${label} is refused, and answered`, !!corrected, detail);
    check(`${label} — the answer carries the pose the server still holds`,
      !!corrected && !!before
      && Math.hypot(corrected.p[0] - before[1], corrected.p[2] - before[3]) < 0.05,
      corrected ? `told ${corrected.p[0]},${corrected.p[2]}` : '');
    const after = rowOf(b, droneA);
    check(`${label} — and the drone did not move`,
      !!after && !!before && Math.hypot(after[1] - before[1], after[3] - before[3]) < 0.05,
      after ? `${after[1]},${after[3]}` : '');
  };

  // Outside the leash, in whichever direction is still inside the arena — the
  // bounds check runs first, and a target that failed BOTH would prove nothing
  // about the leash.
  const outsideLeash = [
    [deployAt[0] + leash + 2, moveTo[1], deployAt[2]],
    [deployAt[0] - leash - 2, moveTo[1], deployAt[2]],
    [deployAt[0], moveTo[1], deployAt[2] + leash + 2],
    [deployAt[0], moveTo[1], deployAt[2] - leash - 2],
  ].find(inBounds);
  if (outsideLeash) {
    await refuses('a drive beyond the leash', outsideLeash, `leash ${leash} m`);
  } else {
    check('a drive beyond the leash is refused', false,
      `every direction ${leash + 2} m from the deploy point is already outside `
      + 'the arena bounds — the leash cannot be tested apart from them');
  }

  const tooHigh = Math.min(maxY + 2, bounds.maxY - 0.5);
  if (tooHigh > maxY) {
    await refuses('a drive above the ceiling', [moveTo[0], tooHigh, moveTo[2]],
      `${tooHigh} m against a ceiling of ${maxY} m`);
  } else {
    check('a drive above the ceiling is refused', false,
      `the drone ceiling ${maxY} m is not below the arena's own ${bounds.maxY} m`);
  }

  const jump = [moveTo[0] + LIMITS.droneMaxStep + 0.5, moveTo[1], moveTo[2]];
  const jumpFits = inBounds(jump)
    && Math.hypot(jump[0] - deployAt[0], jump[2] - deployAt[2]) < leash;
  if (jumpFits) {
    await refuses('a single step past LIMITS.droneMaxStep', jump,
      `${(LIMITS.droneMaxStep + 0.5).toFixed(1)} m in one report, `
      + `banked budget or not`);
  } else {
    check('a single step past LIMITS.droneMaxStep is refused', false,
      `a ${LIMITS.droneMaxStep + 0.5} m jump does not fit inside a ${leash} m leash, `
      + 'so the step ceiling cannot be told apart from it');
  }

  /*
   * THE LEASH IS MEASURED FROM WHERE THE SERVER PUT IT, never from the last
   * position it accepted.
   *
   * One illegal jump is the easy half, and it is checked above. The half that
   * matters is the client that CREEPS: forty perfectly legal steps, every one
   * of them inside the step ceiling and inside the budget, walking the drone
   * out of the building and into the enemy spawn. A leash measured against the
   * last accepted position would wave all forty of them through.
   *
   * Every step is taken from the position the SNAPSHOT reports rather than the
   * one the test asked for, so a refused step is retried rather than skipped —
   * otherwise this would stop early having run out of movement budget and pass
   * without ever reaching the leash at all. The assertion below insists it got
   * there, for exactly that reason.
   */
  {
    a.driving = false;
    const stride = 0.45;   // below the budget refill rate, so it is sustainable
    const steps = Math.min(90, Math.ceil((leash + 3) / stride));
    for (let i = 0; i < steps; i++) {
      const r = rowOf(b, droneA);
      if (!r) break;
      const next = [r[1] + stride, r[2], r[3]];
      if (!inBounds(next)) break;
      drive(a, next, 0.5);
      await sleep(150);
    }
    await sleep(300);
    const crept = rowOf(b, droneA);
    const out = crept
      ? Math.hypot(crept[1] - deployAt[0], crept[3] - deployAt[2]) : 0;
    check('a client that creeps out one legal step at a time is stopped AT the leash',
      !!crept && out <= leash + 0.5 && out >= leash - 1.5,
      `${out.toFixed(1)} m from the deploy point against a ${leash} m leash — `
      + 'the lower bound is there so this cannot pass by running out of budget');
    if (crept) a.drone.p = [crept[1], crept[2], crept[3]];
    a.driving = true;
  }

  /*
   * A REFUSED report is not a SILENT one.
   *
   * DRONE.staleMs despawns a client that has stopped talking. A pilot leaning
   * on a direction at the edge of the leash is talking constantly and having
   * every word refused — so if the staleness clock were reset only on an
   * ACCEPTED report, holding a direction for three seconds against a wall
   * would delete your own drone. The heartbeat is turned off here on purpose:
   * its zero-length drives would be accepted and would hide exactly that.
   */
  if (outsideLeash) {
    a.driving = false;
    a.droneEvents.length = 0;
    const until = Date.now() + DRONE.staleMs + 700;
    while (Date.now() < until) {
      drive(a, outsideLeash, 0.5);
      await sleep(120);
    }
    check('a pilot whose every report is refused still has a drone',
      !!rowOf(b, droneA) && !eventOf(a, DRONE_EVENT.LOST),
      `${DRONE.staleMs + 700} ms of nothing but refusals`);
    a.driving = true;
  }

  // --- a pilot cannot fight -------------------------------------------------
  console.log('\n--- piloting and fighting are exclusive ---');
  b.hits.length = 0;
  b.fires.length = 0;
  shoot(a, b.id);
  await sleep(600);
  check('a shot from a player who is piloting does not damage anyone',
    !b.hits.some((h) => h.a === a.id && h.d > 0), `${b.hits.length} hits seen`);
  check('and is not even relayed as gunfire — it was never taken',
    !b.fires.some((f) => f.id === a.id), `${b.fires.length} shots heard`);

  // --- shooting the drone ---------------------------------------------------
  console.log('\n--- hit registration ---');
  // Let the rewind window fill with a stationary drone, so the distance below
  // is the one the server measures rather than a place it used to be.
  await sleep(900);
  const target = rowOf(b, droneA);
  const dist = Math.hypot(b.at[0] - target[1], b.at[1] - target[2], b.at[2] - target[3]);

  a.droneEvents.length = 0;
  b.droneEvents.length = 0;
  shoot(b, droneA, 'head');
  const marker = await waitFor(() => eventOf(b, DRONE_EVENT.HIT));
  check('a hit claimed against a negative id resolves to the drone', !!marker);
  check('and the hitmarker is private to whoever fired',
    !eventOf(a, DRONE_EVENT.HIT), 'the pilot is not told they were shot at');

  const hurt = await waitFor(() => {
    const r = rowOf(b, droneA);
    return r && r[5] < DRONE.maxHealth ? r : null;
  });
  check('the chassis loses health in the snapshot', !!hurt, `hp ${hurt?.[5]}`);

  const asTorso = DRONE.maxHealth - damageFor(RIFLE, 'torso', dist);
  check('and a claimed HEADSHOT on a robot is priced as a torso hit',
    !!hurt && Math.abs(hurt[5] - asTorso) <= 2,
    `hp ${hurt?.[5]}, torso leaves ${asTorso.toFixed(0)}; a head hit would have `
    + `done ${damageFor(RIFLE, 'head', dist).toFixed(0)} to ${DRONE.maxHealth} `
    + 'and destroyed it outright');

  // A fresh scoreboard to compare against. NAME is the cheapest message that
  // makes the server re-broadcast one, and reading the server's own numbers
  // twice is the only way "nothing changed" means anything at all.
  const before = await freshScore(b);

  b.droneEvents.length = 0;
  a.droneEvents.length = 0;
  for (let i = 0; i < 6 && rowOf(b, droneA); i++) {
    shoot(b, droneA, 'torso');
    await sleep(180);
  }
  const destroyed = await waitFor(() => eventOf(b, DRONE_EVENT.DESTROYED));
  check('enough rounds destroy it', !!destroyed);
  check('and the whole room is told, not just the shooter',
    !!eventOf(a, DRONE_EVENT.DESTROYED));
  check('credited to whoever shot it', destroyed?.by === b.id, `by ${destroyed?.by}`);
  check('and it leaves the snapshot entirely, `d` key and all',
    !!(await waitFor(() => (a.droneRows === null || a.droneRows.length === 0) || null)),
    `${(a.droneRows ?? []).length} rows left`);

  const after = await freshScore(b);
  check('destroying a drone credits no kill',
    scoreRow(after, b.id)?.[2] === scoreRow(before, b.id)?.[2],
    `${scoreRow(before, b.id)?.[2]} -> ${scoreRow(after, b.id)?.[2]}`);
  check('and costs its owner no death',
    scoreRow(after, a.id)?.[3] === scoreRow(before, a.id)?.[3],
    `${scoreRow(before, a.id)?.[3]} -> ${scoreRow(after, a.id)?.[3]}`);
  check('and cannot end the match',
    a.matches.at(-1)?.st !== MATCH_STATE.OVER && a.matches.at(-1)?.w == null,
    a.matches.at(-1)?.st ?? 'no match message');

  /*
   * The latch. `piloting` is what stops a pilot shooting, and it is cleared
   * inside despawnDrone rather than at any of its call sites — because a path
   * that forgot would leave the player whose drone was shot out from under
   * them unable to fire for the rest of the match, with nothing logged.
   */
  b.hits.length = 0;
  shoot(a, b.id, 'torso');
  check('losing a drone hands the pilot their gun back',
    !!(await waitFor(() => b.hits.find((h) => h.a === a.id && h.d > 0))),
    'piloting is cleared by the despawn itself, not by its callers');

  // --- the despawn paths ----------------------------------------------------
  console.log('\n--- a drone outlives nothing ---');

  // 1. the pilot dies
  b.droneEvents.length = 0;
  deploy(b);
  const bDeployed = await waitFor(() => eventOf(b, DRONE_EVENT.DEPLOYED));
  b.drone = { id: bDeployed?.id, p: [...(bDeployed?.p ?? b.at)], yaw: bDeployed?.y ?? 0 };
  check('a second player can have one out at the same time',
    !!bDeployed && !!(await waitFor(() => rowOf(a, droneIdFor(b.id)))),
    `${(a.droneRows ?? []).length} drones in the room`);

  b.droneEvents.length = 0;
  for (let i = 0; i < 10 && !b.kills.some((k) => k.v === b.id); i++) {
    shoot(a, b.id, 'head');
    await sleep(170);
  }
  check('killing the pilot takes their drone with them',
    !!(await waitFor(() => eventOf(b, DRONE_EVENT.LOST))),
    'a drone you keep by dying inverts the whole cost of using one');
  check('and no row is left behind',
    !!(await waitFor(() => !rowOf(a, droneIdFor(b.id)) || null)));
  b.drone = null;

  // 2. the pilot disconnects
  const c = await join('CHARLIE', 'DRNAA', DRONE_MAP);
  await sleep(700);
  deploy(c);
  const cDeployed = await waitFor(() => eventOf(c, DRONE_EVENT.DEPLOYED));
  c.drone = { id: cDeployed?.id, p: [...(cDeployed?.p ?? c.at)], yaw: 0 };
  await waitFor(() => rowOf(a, droneIdFor(c.id)));

  a.log.length = 0;
  c.ws.close();
  await sleep(900);
  const iDrone = a.log.findIndex((x) => x.kind === 'drone' && x.o === c.id);
  const iLeft = a.log.findIndex((x) => x.kind === 'left' && x.id === c.id);
  check('a disconnecting player takes their drone with them', iDrone >= 0);
  check('and it goes BEFORE they are removed from the room',
    iDrone >= 0 && iLeft >= 0 && iDrone < iLeft,
    `drone at ${iDrone}, LEFT at ${iLeft} — no client is ever told a player `
    + 'has gone while still holding a chassis attributed to them');
  check('leaving no row behind', !rowOf(a, droneIdFor(c.id)));

  // 3. the pilot goes quiet
  const d = await join('DELTA', 'DRNAA', DRONE_MAP);
  await sleep(700);
  deploy(d);
  const dDeployed = await waitFor(() => eventOf(d, DRONE_EVENT.DEPLOYED));
  d.drone = { id: dDeployed?.id, p: [...(dDeployed?.p ?? d.at)], yaw: 0 };
  await waitFor(() => rowOf(a, droneIdFor(d.id)));

  d.droneEvents.length = 0;
  // The socket keeps talking; only the DRIVE reports stop. That distinction is
  // the whole rule — this is not a timeout, it is an abandoned drone.
  d.driving = false;
  const wentQuietAt = Date.now();
  const stale = await waitFor(() => eventOf(d, DRONE_EVENT.LOST), DRONE.staleMs + 3000);
  check('a drone whose pilot stops reporting is despawned', !!stale,
    stale ? `after ${stale.at - wentQuietAt} ms` : `nothing in ${DRONE.staleMs + 3000} ms`);
  check('and not before the deadline — a few dropped reports are not abandonment',
    !!stale && stale.at - wentQuietAt >= DRONE.staleMs - 250,
    `deadline ${DRONE.staleMs} ms`);
  check('the pilot is still connected, so this was the drone and not the socket',
    d.ws.readyState === 1);
  d.drone = null;

  // 4. the pilot asks
  const f = await join('FOXTROT', 'DRNAA', DRONE_MAP);
  await sleep(700);
  deploy(f);
  const fDeployed = await waitFor(() => eventOf(f, DRONE_EVENT.DEPLOYED));
  f.drone = { id: fDeployed?.id, p: [...(fDeployed?.p ?? f.at)], yaw: 0 };
  await waitFor(() => rowOf(a, droneIdFor(f.id)));
  f.droneEvents.length = 0;
  recall(f);
  check('recalling it puts it away', !!(await waitFor(() => eventOf(f, DRONE_EVENT.RECALLED))));
  check('and the room is told', !!(await waitFor(() =>
    f.droneEvents.length && !rowOf(a, droneIdFor(f.id)) ? true : null)));
  f.drone = null;

  f.droneEvents.length = 0;
  deploy(f);
  const cooling = await waitFor(() => eventOf(f, DRONE_EVENT.DENIED));
  check('and redeploying at once is refused while the cooldown runs', !!cooling,
    cooling ? `"${cooling.why}"` : 'nothing came back');

  // 5. the battery, started at the top of this run
  console.log('\n--- the battery ---');
  const remaining = DRONE.batteryMs - (Date.now() - batteryStartedAt) + 2000;
  if (remaining > 0) {
    console.log(`      (waiting ${Math.round(remaining / 1000)}s for a `
      + `${DRONE.batteryMs / 1000}s battery to run out)`);
    await sleep(remaining);
  }
  const expired = eventOf(e, DRONE_EVENT.EXPIRED);
  check('a piloted drone expires when its battery does', !!expired,
    expired ? `after ${expired.at - batteryStartedAt} ms` : 'still flying');
  check('and it was the BATTERY, not the stale deadline — it was driven throughout',
    !!expired && !eventOf(e, DRONE_EVENT.LOST),
    `${e.droneEvents.map((x) => x.ev).join(',')}`);
  check('and the room it was in is empty of drones again',
    e.droneRows === null || e.droneRows.length === 0);

  clearInterval(heartbeat);
  for (const s of live) { try { s.ws.close(); } catch { /* already gone */ } }
  await sleep(200);
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

/**
 * Make the server say the scoreboard again, and wait for it.
 *
 * Destroying a drone does not broadcast a score — quite rightly, nothing about
 * it changed — so comparing "the last SCORE before" with "the last SCORE
 * after" would be comparing one message with itself and passing whatever
 * happened. NAME is the cheapest message that forces a fresh one.
 */
async function freshScore(s) {
  const had = s.scores.length;
  send(s, { t: MSG.NAME, n: s.name });
  return waitFor(() => (s.scores.length > had ? s.scores.at(-1) : null));
}

main().catch((e) => { console.error('drone test crashed:', e); process.exit(1); });

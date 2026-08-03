/**
 * Headless smoke test for the game server.
 *
 * Runs two fake clients through a whole match cycle — join, move, shoot, kill,
 * respawn — and asserts the server behaves. Deliberately checks the *hostile*
 * paths too (speed hacks, fire-rate spam, self-damage, damage claims for
 * absurd amounts), because those are the parts that are easy to get wrong and
 * impossible to notice by playing.
 *
 *   cd server && npm start          # in one terminal
 *   node smoke-test.js             # in another
 */

import { WebSocket } from 'ws';
import {
  MSG, PROTOCOL_VERSION, MATCH_STATE, MATCH_RULES, LIMITS, PLAYER_MAX_HEALTH,
  PLAYER_START_ARMOR, ARMOR_ABSORB, FLAG,
} from '../src/net/protocol.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';

const URL = process.env.URL || 'ws://localhost:8787';
// Must be spellable in ROOM_CODE_ALPHABET, which excludes 0/1/O/I so codes
// survive being read aloud or typed off a screenshot. 'TEST1' is NOT valid.
const ROOM = 'TESTA';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

class FakeClient {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.id = null;
    this.seq = 0;
    this.pos = [0, 1.1, 0];
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.send(MSG.JOIN, { n: name, r: ROOM, v: PROTOCOL_VERSION });
      });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.inbox.push(m);
        if (m.t === MSG.WELCOME) {
          this.id = m.id;
          this.room = m.r;
          if (Array.isArray(m.sp)) this.pos = m.sp;
          resolve(m);
        }
        // Reject loudly on refusal. Without this the harness waits forever for
        // a WELCOME that will never come, the socket closes, no handles are
        // left, and node exits 0 having printed nothing at all — which is
        // exactly how an invalid room code cost half an hour to find.
        if (m.t === MSG.DENIED) reject(new Error(`server refused ${name}: ${m.why}`));
        if (m.t === MSG.MATCH && Array.isArray(m.sp)) this.pos = m.sp;
      });
      this.ws.on('error', reject);
      this.ws.on('close', () => reject(new Error(`${name} socket closed before WELCOME`)));
    });
  }

  send(t, payload) { this.ws.send(JSON.stringify({ t, ...payload })); }

  input(pos = this.pos, extra = {}) {
    this.pos = pos;
    this.send(MSG.INPUT, { q: ++this.seq, p: pos, y: 0, a: 0, f: 0, w: 'rifle', ...extra });
  }

  shootAt(victimId, part = 'torso', weapon = 'rifle') {
    this.send(MSG.SHOT, {
      q: ++this.seq, o: this.pos, d: [0, 0, -1], w: weapon,
      h: [{ v: victimId, pt: part }],
    });
  }

  drain(type) { return this.inbox.filter((m) => m.t === type); }
  last(type) { const all = this.drain(type); return all[all.length - 1]; }
  clear() { this.inbox.length = 0; }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = new FakeClient('ALPHA');
  const welcomeA = await a.ready;
  check('client joins and receives WELCOME', !!welcomeA.id, `id=${welcomeA.id}`);
  check('joined the requested room', welcomeA.r === ROOM, welcomeA.r);
  check('WELCOME carries a spawn position', Array.isArray(welcomeA.sp),
    JSON.stringify(welcomeA.sp));
  check('single player stays in warmup', welcomeA.mt?.st === MATCH_STATE.WARMUP,
    welcomeA.mt?.st);

  const b = new FakeClient('BRAVO');
  await b.ready;
  await sleep(200);
  check('second player triggers LIVE match',
    a.last(MSG.MATCH)?.st === MATCH_STATE.LIVE, a.last(MSG.MATCH)?.st);
  check('existing player is told about the joiner',
    a.drain(MSG.JOINED).some((m) => m.p.n === 'BRAVO'));
  check('joiner sees the existing player',
    (welcomeA.ps?.length ?? 0) === 0 && b.inbox.find((m) => m.t === MSG.WELCOME).ps.length === 1);

  // --- snapshots -----------------------------------------------------------
  a.clear();
  await sleep(1000);
  const snaps = a.drain(MSG.SNAPSHOT);
  check('snapshots arrive at roughly the tick rate',
    snaps.length >= 22 && snaps.length <= 38, `${snaps.length}/s`);
  check('snapshot contains both players',
    (snaps.at(-1)?.p?.length ?? 0) === 2, `${snaps.at(-1)?.p?.length} entries`);

  // --- legitimate movement -------------------------------------------------
  a.clear();
  const start = [...a.pos];
  for (let i = 0; i < 10; i++) { a.input([start[0] + i * 0.1, start[1], start[2]]); await sleep(33); }
  await sleep(120);
  const moved = a.drain(MSG.SNAPSHOT).at(-1)?.p?.find((row) => row[0] === a.id);
  check('legitimate movement is accepted',
    Math.abs(moved[1] - (start[0] + 0.9)) < 0.2, `x=${moved?.[1]} expected~${start[0] + 0.9}`);

  // --- speed hack ----------------------------------------------------------
  a.clear();
  const before = [...a.pos];
  a.input([before[0] + 50, before[1], before[2] + 50]);   // 70 m in one frame
  await sleep(200);
  const correction = a.drain(MSG.MATCH).find((m) => Array.isArray(m.sp));
  const afterSnap = a.drain(MSG.SNAPSHOT).at(-1)?.p?.find((row) => row[0] === a.id);
  check('teleport is rejected and position corrected', !!correction,
    correction ? `snapped to ${JSON.stringify(correction.sp)}` : 'no correction sent');
  check('server did not adopt the teleported position',
    afterSnap && Math.hypot(afterSnap[1] - before[0], afterSnap[3] - before[2]) < 5,
    `server has x=${afterSnap?.[1]} z=${afterSnap?.[3]}`);

  // --- damage and kill ----------------------------------------------------
  a.pos = [...before];
  a.input(a.pos);
  b.clear(); a.clear();

  /*
   * Damage now falls off with range, so the expectation has to account for how
   * far apart these two actually are — about 64 m at their spawns, past the
   * rifle's 40 m falloff start.
   *
   * Simply standing the shooter next to the victim does not work: that move is
   * itself a 60 m teleport and the server correctly rejects it, which is what
   * the check immediately above this one exists to prove.
   */
  const RIFLE = WEAPON_DEFS.find((w) => w.id === 'rifle');
  const range = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
  const falloff = range >= RIFLE.falloffEnd ? RIFLE.falloffMinScale
    : range <= RIFLE.falloffStart ? 1
      : 1 + (RIFLE.falloffMinScale - 1)
        * ((range - RIFLE.falloffStart) / (RIFLE.falloffEnd - RIFLE.falloffStart));
  const expectBody = RIFLE.damage * falloff;
  const expectHead = RIFLE.damage * RIFLE.headMul * falloff;
  /*
   * Shots to kill, ARMOUR INCLUDED.
   *
   * Against health alone this came to exactly the number of rounds fired, so
   * the check sat on the boundary: one round lost to ordinary timing jitter
   * left the victim alive on a sliver of health and the whole death-and-
   * respawn section failed. Armour soaks its share until it runs out, which is
   * worth an extra couple of rounds — walk the same arithmetic the server does
   * rather than assume a figure that weapon balancing would invalidate.
   */
  let simHp = PLAYER_MAX_HEALTH, simArmor = PLAYER_START_ARMOR, rifleShotsToKill = 0;
  while (simHp > 0 && rifleShotsToKill < 60) {
    const absorbed = Math.min(simArmor, expectBody * ARMOR_ABSORB);
    simArmor -= absorbed;
    simHp -= expectBody - absorbed;
    rifleShotsToKill++;
  }
  for (let i = 0; i < rifleShotsToKill + 2; i++) {
    a.shootAt(b.id, 'torso');
    await sleep(130);        // rifle rpm allows ~8.3/s; stay under it
  }
  await sleep(250);
  const hits = a.drain(MSG.HIT);
  const kills = a.drain(MSG.KILL);
  check('hits are registered and broadcast', hits.length > 0, `${hits.length} hits`);
  check('hit damage matches the weapon definition at this range',
    hits.length > 0 && Math.abs(hits[0].d - expectBody) <= 1.5,
    `dealt ${hits[0]?.d}, expected ${expectBody.toFixed(0)} at ${range.toFixed(0)} m`);
  check('victim dies after enough damage', kills.length === 1, `${kills.length} kills`);
  check('kill is attributed to the shooter',
    kills[0]?.a === a.id && kills[0]?.v === b.id);

  const score = a.drain(MSG.SCORE).at(-1);
  const rowA = score?.ps?.find((r) => r[0] === a.id);
  const rowB = score?.ps?.find((r) => r[0] === b.id);
  check('scoreboard credits the kill', rowA?.[2] === 1, `kills=${rowA?.[2]}`);
  check('scoreboard records the death', rowB?.[3] === 1, `deaths=${rowB?.[3]}`);

  // --- respawn -------------------------------------------------------------
  /*
   * Asked for, not waited for.
   *
   * The server's own timer is a BACKSTOP: the kill cam runs for as long as the
   * fight did, so only the client knows when its death sequence has finished
   * and it is the client that asks. Sitting and waiting here would get the
   * backstop many seconds later and read as "respawning is broken".
   */
  b.clear();
  await sleep(MATCH_RULES.respawnDelaySec * 1000 + 200);
  b.send(MSG.RESPAWN, {});
  await sleep(400);
  const respawn = b.drain(MSG.MATCH).find((m) => Array.isArray(m.sp));
  check('victim respawns when the client asks', !!respawn,
    respawn ? `at ${JSON.stringify(respawn.sp)}` : 'never respawned');
  const bAlive = b.drain(MSG.SNAPSHOT).at(-1)?.p?.find((r) => r[0] === b.id);
  // Against the shared constant, not a literal — client and server both read
  // PLAYER_MAX_HEALTH, so the test has to move with them or it goes stale.
  check('respawned player is back to full health', bAlive?.[8] === PLAYER_MAX_HEALTH, `hp=${bAlive?.[8]}`);

  // --- fire-rate limiting --------------------------------------------------
  a.clear();
  for (let i = 0; i < 40; i++) a.shootAt(b.id, 'torso');   // no delay at all
  await sleep(400);
  const spamHits = a.drain(MSG.HIT).length + a.drain(MSG.KILL).length;
  // Fire rate is a token bucket, so a burst of up to LIMITS.shotBurst rounds is
  // allowed through before the sustained rate takes over — that headroom is
  // what stops a jittery connection losing legitimate shots. What must NOT
  // happen is 40 rounds landing at once.
  check('fire-rate spam is throttled', spamHits <= LIMITS.shotBurst + 1,
    `${spamHits} of 40 instant shots registered (burst allowance ${LIMITS.shotBurst})`);

  // --- self damage ---------------------------------------------------------
  a.clear();
  a.shootAt(a.id, 'head');
  await sleep(200);
  check('cannot damage yourself', a.drain(MSG.HIT).length === 0);

  /*
   * --- headshot multiplier -----------------------------------------------
   *
   * B has to be at FULL health for this, and getting them there means killing
   * them and letting them respawn. Fire until the server actually says they
   * died rather than assuming a round count: how many it takes depends on the
   * range, and the two spawn points are not always the same distance apart.
   *
   * A fixed six rounds killed B at 58 m and left them on 17 hp at 84 m. The
   * headshot then finished them off, the server sent a KILL instead of a HIT,
   * and the check read the missing HIT as a broken multiplier — a green suite
   * on close spawns and a red one on far spawns, for a multiplier that was
   * never wrong. The server log said `ACCEPT rifle head ... victimHp 17`.
   *
   * Both clients keep sending throughout. A real one does — this is the
   * position stream — and the server drops anyone silent for LIMITS.timeoutSec.
   */
  const DEAD_FLAG = 1 << 4;
  a.clear();
  let bDied = false;
  for (let i = 0; i < 40 && !bDied; i++) {
    a.shootAt(b.id, 'torso');
    a.input(a.pos);
    b.input(b.pos);
    await sleep(110);
    bDied = a.drain(MSG.KILL).some((k) => k.v === b.id);
  }
  check('the target can be killed at this range', bDied,
    bDied ? `at ${range.toFixed(0)} m` : 'never died — check falloff');

  /*
   * Then wait for them to come back whole AND SHOOTABLE, watching the snapshot
   * rather than sleeping a span tuned to damage numbers that balancing will
   * change.
   *
   * The protection check is not decoration. A respawned player is invulnerable
   * for MATCH_RULES.spawnProtectSec, so the next check below — which fires one
   * round and reads the damage — got no HIT at all and reported the headshot
   * multiplier as `undefined`. Waiting on the flag rather than on a duration
   * means changing that duration cannot silently break this test again.
   */
  const respawnBy = Date.now() + MATCH_RULES.respawnDelaySec * 1000
    + MATCH_RULES.spawnProtectSec * 1000 + 6000;
  const askAt = Date.now() + MATCH_RULES.respawnDelaySec * 1000 + 200;
  let asked = false;
  let bWhole = false;
  while (Date.now() < respawnBy && !bWhole) {
    a.input(a.pos);
    b.input(b.pos);
    // The client asks; the server's timer is only a backstop. See above.
    if (!asked && Date.now() >= askAt) { asked = true; b.send(MSG.RESPAWN, {}); }
    await sleep(100);
    const row = a.drain(MSG.SNAPSHOT).at(-1)?.p?.find((r) => r[0] === b.id);
    bWhole = !!row && (row[6] & DEAD_FLAG) === 0 && row[8] >= PLAYER_MAX_HEALTH
      && (row[6] & FLAG.PROTECTED) === 0;
  }
  check('and comes back at full health, out of spawn protection', bWhole,
    bWhole ? '' : 'never returned to full health and shootable');

  a.clear();
  a.shootAt(b.id, 'head');
  await sleep(250);
  const hs = a.drain(MSG.HIT)[0];
  check('headshot applies the weapon multiplier',
    hs && Math.abs(hs.d - expectHead) <= 2,
    `head hit dealt ${hs?.d}, expected ${expectHead.toFixed(0)} (${RIFLE.damage} x${RIFLE.headMul} at ${range.toFixed(0)} m)`);

  // --- protocol version gate ---------------------------------------------
  const stale = new WebSocket(URL);
  const denied = await new Promise((resolve) => {
    stale.on('open', () => stale.send(JSON.stringify({
      t: MSG.JOIN, n: 'OLD', r: ROOM, v: PROTOCOL_VERSION + 99,
    })));
    stale.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    setTimeout(() => resolve(null), 1500);
  });
  check('out-of-date client is refused', denied?.t === MSG.DENIED, denied?.why);

  // --- leave ---------------------------------------------------------------
  a.clear();
  b.close();
  await sleep(400);
  check('remaining player is told about the leaver',
    a.drain(MSG.LEFT).some((m) => m.id === b.id));
  check('match drops back to warmup when alone',
    a.last(MSG.MATCH)?.st === MATCH_STATE.WARMUP, a.last(MSG.MATCH)?.st);

  a.close();
  await sleep(200);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});

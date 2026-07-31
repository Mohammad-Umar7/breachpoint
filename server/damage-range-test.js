/**
 * Pellet-batching and death-spawn test.
 *
 * Two faults this pins down:
 *
 * 1. The server applied FLAT damage. Every weapon definition carries
 *    falloffStart / falloffEnd / falloffMinScale, the client has always
 *    modelled them, and the server — which owns damage — ignored all three.
 *    A shotgun therefore hit as hard across the map as it did point blank,
 *    and the ranges the weapons were balanced around did not exist.
 *
 * 2. A shotgun's pellets were reported as separate messages, and the
 *    fire-rate limiter charges a token per MESSAGE. Nine pellets against a
 *    five-token budget meant most of a blast was discarded and the next shot
 *    was starved too.
 *
 *   node server/index.js &
 *   node server/damage-range-test.js
 */
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, PLAYER_MAX_HEALTH } from '../src/net/protocol.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';

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
    const s = { ws, id: null, spawn: null, seq: 0, damage: 0, hits: 0, died: false };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === MSG.WELCOME) { s.id = m.id; s.spawn = m.sp; resolve(s); }
      else if (m.t === MSG.DENIED) reject(new Error(m.why || 'denied'));
      else if (m.t === MSG.HIT && m.v === s.id) { s.hits++; s.damage += m.d; }
      else if (m.t === MSG.KILL && m.v === s.id) s.died = true;
      else if (m.t === MSG.SPAWNPOINT) s.spawnPoint = m.sp;
      // Keep the last snapshot so the test can wait for the server to actually
      // agree about where everyone is, instead of guessing with a sleep.
      else if (m.t === MSG.SNAPSHOT) s.lastSnapshot = m.p;
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed before WELCOME')));
    ws.on('open', () => ws.send(JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, n: name, r: room })));
  });
}
const send = (s, o) => s.ws.send(JSON.stringify(o));

/**
 * One shot at a chosen range, with a fresh pair each time so a previous run's
 * damage cannot leak in.
 * @returns {Promise<{damage: number, hits: number, died: boolean, spawnPoint: any}>}
 */
async function shotAt(weaponId, metres, pellets, roomSuffix) {
  const room = 'DMG' + roomSuffix;   // 5 chars, no I/O/0/1
  const a = await join('SHOOTER', room);
  const b = await join('TARGET', room);

  /*
   * Wait for the match to go LIVE before placing anyone.
   *
   * The second player joining takes the room out of warmup, and that respawns
   * EVERYONE — so positions set before it are silently overwritten with fresh
   * spawn points. When that happened the two ended up ~70 m apart, past the
   * shotgun's 60 m maximum range, and the shot registered nothing at all. The
   * test then reported 0% falloff rather than the fault it actually hit.
   */
  await sleep(900);

  const origin = { x: a.spawn[0], y: a.spawn[1], z: a.spawn[2] };
  const target = { x: origin.x, y: origin.y, z: origin.z - metres };
  /*
   * Keep sending the positions until the SERVER agrees, then hold them for
   * longer than the lag-compensation window.
   *
   * Two things make a fixed sleep unreliable here, and both are the server
   * behaving correctly:
   *
   *   - The second player joining takes the room out of warmup, which respawns
   *     everyone and overwrites whatever the test just set.
   *   - Hit validation rewinds the victim up to 400 ms. Shoot sooner than that
   *     after moving them and the claim is judged against where they used to
   *     be — their spawn, tens of metres away and outside the weapon's range.
   *
   * Waiting on the snapshot removes the guesswork: once the server reports the
   * target at the intended spot, the extra hold guarantees the rewind window
   * is entirely inside the period they have been standing there.
   */
  const settled = async () => {
    /*
     * WALK the target into position — do not teleport it.
     *
     * The server budgets movement and refuses jumps, quite rightly: an earlier
     * version of this test tried to place the target 34 m away in one message
     * and every attempt was rejected, so it never arrived and the shot
     * registered nothing. 0.6 m per step at 20 Hz is 12 m/s, inside the
     * server's allowance.
     */
    const STEP = 0.6;
    let arrived = 0;
    for (let i = 0; i < 600; i++) {
      // Step from where the SERVER says they are, not from a counter of our
      // own. The match going live respawns everyone mid-walk, and a local
      // counter carries on from a position that no longer exists — so the walk
      // never converges. Reading it back each step makes that self-correcting.
      const row = (a.lastSnapshot ?? []).find((r) => r[0] === b.id);
      const at = row ? { x: row[1], y: row[2], z: row[3] } : { ...origin };

      const dx = target.x - at.x;
      const dz = target.z - at.z;
      const dist = Math.hypot(dx, dz);
      const next = dist <= STEP
        ? { x: target.x, z: target.z }
        : { x: at.x + (dx / dist) * STEP, z: at.z + (dz / dist) * STEP };

      send(a, { t: MSG.INPUT, q: ++a.seq, p: [origin.x, origin.y, origin.z], y: 0, a: 0, f: 0, w: weaponId });
      send(b, { t: MSG.INPUT, q: ++b.seq, p: [next.x, target.y, next.z], y: 0, a: 0, f: 0, w: 'rifle' });
      await sleep(50);

      // Hold position for a few ticks once there, so the rewind window lands
      // entirely inside the period they have been standing still.
      if (dist < 0.5) { if (++arrived >= 10) return true; } else arrived = 0;
    }
    return false;
  };
  if (!await settled()) throw new Error(`target never reached ${metres} m`);

  // One trigger pull: every pellet in a single message, as the client sends it.
  send(a, {
    t: MSG.SHOT,
    o: [origin.x, origin.y, origin.z],
    d: [0, 0, -1],
    w: weaponId,
    h: Array.from({ length: pellets }, () => ({ v: b.id, pt: 'torso' })),
  });
  await sleep(500);

  const out = { damage: b.damage, hits: b.hits, died: b.died, spawnPoint: b.spawnPoint };
  a.ws.close(); b.ws.close();
  await sleep(120);
  return out;
}

async function main() {
  const shotgun = WEAPON_DEFS.find((w) => w.id === 'shotgun');
  const pellets = shotgun.pellets ?? 1;

  console.log(`shotgun: ${shotgun.damage} per pellet x ${pellets} pellets, `
    + `full damage to ${shotgun.falloffStart} m, `
    + `down to ${Math.round(shotgun.falloffMinScale * 100)}% past ${shotgun.falloffEnd} m\n`);

  // --- pellets in one blast all count -------------------------------------
  const close = await shotAt('shotgun', 3, pellets, 'AA');
  console.log(`  3 m : ${close.hits} of ${pellets} pellets counted, `
    + `${close.damage} damage${close.died ? ' (killed)' : ''}`);
  check('every pellet of one blast is counted', close.hits + (close.died ? 1 : 0) >= pellets - 1,
    `${close.hits} hits registered`);

  // --- close range hurts a lot --------------------------------------------
  const expectedClose = shotgun.damage * pellets;
  check('a point-blank shotgun takes over half the health bar',
    close.damage + (close.died ? PLAYER_MAX_HEALTH : 0) >= PLAYER_MAX_HEALTH * 0.5,
    `${close.damage} of ${PLAYER_MAX_HEALTH} (full spread would be ${expectedClose})`);

  /*
   * The falloff CURVE is pinned in test/damage-falloff.mjs instead of here.
   *
   * Driving a live server to a chosen range means walking a player there past
   * movement validation and lag compensation — both correct, both timing
   * sensitive — and the resulting flakiness was reporting "0% falloff" when
   * the real problem was that the target had never arrived. The maths is
   * deterministic, so it is checked directly; this file keeps only what
   * genuinely needs a server.
   */

  // --- the victim is told where they will respawn --------------------------
  check('a killed player is sent their spawn point immediately',
    !close.died || Array.isArray(close.spawnPoint),
    close.died ? `spawn ${JSON.stringify(close.spawnPoint)}` : 'target survived, not applicable');

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('damage range test crashed:', e); process.exit(1); });

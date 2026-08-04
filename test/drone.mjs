/**
 * The drone's shared vocabulary.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/net/protocol.js` is the one file the browser and the server both read,
 * and the drone adds three things to it that are only wrong at runtime, in a
 * match, on somebody else's machine.
 *
 * The first is the ID CONVENTION. A drone's wire id is minus its owner's, which
 * works only because player ids start at 1 and never go negative. Nothing in
 * the language enforces that. If it ever stopped being true — or if one of the
 * three helpers were "simplified" to `id <= 0`, which reads as equivalent and
 * is not — then a hit claim aimed at a drone would resolve to a player, or a
 * player id of 0 would be read as a drone. Neither throws. Both would present
 * as bullets that sometimes do nothing.
 *
 * The second is the ENUMS. `DRONE_CMD` and `DRONE_EVENT` cross the wire as bare
 * integers, so a duplicated value is not a name clash the build can see; it is
 * two different events that the receiving end cannot tell apart.
 *
 * The third is the DRIVE BUDGET. `LIMITS.droneBurstMetres` is what stops a
 * legitimately-driving client being rejected by packet bunching, and
 * `LIMITS.droneMaxStep` is what stops a banked budget being spent as a
 * teleport. The two pull in opposite directions, so a number chosen for one can
 * silently break the other — and the symptom, rubber-banding under jitter, only
 * appears over a real network. It never shows up on a LAN, which is the lesson
 * `moveBurstMetres` already records.
 *
 *   node test/drone.mjs
 */
import {
  DRONE, DRONE_CMD, DRONE_EVENT, LIMITS, INPUT_HZ,
  droneIdFor, ownerOfDroneId, isDroneId,
} from '../src/net/protocol.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

console.log('--- the id convention ---');
{
  /*
   * Ten thousand ids, not three. A room holds twelve players, but ids are
   * handed out by a counter that never resets, so a long-lived server reaches
   * five figures in an afternoon and the convention has to hold there too.
   */
  const N = 10000;
  const broken = [];
  for (let id = 1; id <= N; id++) {
    const d = droneIdFor(id);
    if (ownerOfDroneId(d) !== id) broken.push(`${id} -> ${d} -> ${ownerOfDroneId(d)}`);
  }
  check('a drone id round-trips back to its owner', broken.length === 0,
    broken.slice(0, 3).join(', ') || `ids 1..${N}`);

  const notDrones = [];
  for (let id = 1; id <= N; id++) if (!isDroneId(droneIdFor(id))) notDrones.push(id);
  check('every drone id reads as a drone', notDrones.length === 0,
    notDrones.slice(0, 3).join(', ') || `ids 1..${N}`);

  const misread = [];
  for (let id = 1; id <= N; id++) if (isDroneId(id)) misread.push(id);
  check('and no player id ever does', misread.length === 0,
    misread.slice(0, 3).join(', ') || `ids 1..${N}`);

  /*
   * The decisive property, stated directly rather than inferred from the two
   * checks above: the two id spaces cannot overlap. This is what lets the
   * per-shot dedupe Set key on `v` alone, with no discriminator field and no
   * composite key.
   */
  const players = new Set();
  for (let id = 1; id <= N; id++) players.add(id);
  const collided = [];
  for (let id = 1; id <= N; id++) if (players.has(droneIdFor(id))) collided.push(id);
  check('the drone and player id spaces are disjoint', collided.length === 0,
    collided.slice(0, 3).join(', ') || `${N} ids each way`);

  /*
   * Zero belongs to NEITHER space, and this is the check that fails if
   * `isDroneId` is ever written as `id <= 0`. `nextPlayerId` starts at 1, so 0
   * is not a player — but it is not a drone either, and a lookup that treated
   * it as one would resolve `ownerOfDroneId(0)` to 0 and find nothing, quietly.
   */
  check('zero is not a drone id', isDroneId(0) === false, 'isDroneId(0)');

  // A message arrives as parsed JSON, so `v` can be anything at all. Every one
  // of these must answer false rather than throw or coerce.
  const junk = [undefined, null, NaN, '-1', '', 'abc', {}, [], [-1], true, false, -Infinity];
  const wrong = junk.filter((v) => isDroneId(v) !== (typeof v === 'number' && v < 0));
  check('non-numbers are not drone ids', wrong.length === 0,
    wrong.length ? JSON.stringify(wrong.map(String)) : `${junk.length} junk values rejected`);
  check('and -Infinity, which IS a number, is not mistaken for a real one',
    isDroneId(-Infinity) === true && !Number.isFinite(ownerOfDroneId(-Infinity)),
    'reads as a drone, resolves to a non-finite owner the registry cannot hold');
}

console.log('\n--- the enums ---');
for (const [name, table] of [['DRONE_CMD', DRONE_CMD], ['DRONE_EVENT', DRONE_EVENT]]) {
  const values = Object.values(table);
  check(`${name} is frozen`, Object.isFrozen(table), `${values.length} entries`);
  check(`${name} values are unique`, new Set(values).size === values.length,
    new Set(values).size === values.length ? values.join(', ')
      : `${values.length} entries, ${new Set(values).size} distinct`);
  /*
   * Contiguous from zero, so the set can be range-checked with one comparison
   * on the server rather than by a lookup that has to be kept in step.
   */
  const sorted = [...values].sort((a, b) => a - b);
  check(`${name} values are contiguous from 0`,
    sorted.every((v, i) => v === i), `0..${sorted[sorted.length - 1]}`);
}

console.log('\n--- the tuning is usable ---');
{
  const numbers = Object.entries(DRONE).filter(([, v]) => !Array.isArray(v));
  const bad = numbers.filter(([, v]) => !Number.isFinite(v) || v <= 0);
  check('every DRONE number is finite and positive', bad.length === 0,
    bad.map(([k, v]) => `${k}=${v}`).join(', ') || `${numbers.length} values`);

  check('DRONE is frozen, and so is its hit box',
    Object.isFrozen(DRONE) && Object.isFrozen(DRONE.hitHalf),
    'a mutable shared constant is two ends disagreeing later');

  check('the hit box has three half-extents, all finite and positive',
    DRONE.hitHalf.length === 3 && DRONE.hitHalf.every((h) => Number.isFinite(h) && h > 0),
    JSON.stringify(DRONE.hitHalf));

  /*
   * A single non-finite number in a Rapier collider silently disables EVERY
   * raycast on the map, so the dimensions the chassis is built from are checked
   * here, in the shared file, before anything can build one out of them.
   */
  check('and is a box a person could hit but not a barn door',
    DRONE.hitHalf.every((h) => h < 0.5), `${(DRONE.hitHalf[0] * 2).toFixed(2)} m wide`);

  // The camera has to be low enough to be the point of the feature.
  check('the camera sits below knee height', DRONE.camHeight < 0.4,
    `${DRONE.camHeight} m`);
}

console.log('\n--- the drive budget ---');
{
  /*
   * One report's worth of honest travel: reports go out at INPUT_HZ, so this is
   * how far a client driving flat out legitimately moves between two of them.
   */
  const perTick = DRONE.speed * (1000 / INPUT_HZ) / 1000;

  check('the drive budget can be parsed at all',
    Number.isFinite(LIMITS.droneBurstMetres) && Number.isFinite(LIMITS.droneMaxStep),
    `burst ${LIMITS.droneBurstMetres} m, step ${LIMITS.droneMaxStep} m`);

  /*
   * The margin, not merely the inequality. A bucket only a tick or two deep is
   * arithmetically "bigger than one step" and still rejects any client whose
   * packets arrive in pairs — which over a real network they frequently do.
   * Ten reports of banked travel is the same order of slack `moveBurstMetres`
   * gives a player.
   */
  check('the burst bucket covers a comfortable run of bunched reports',
    LIMITS.droneBurstMetres > perTick * 10,
    `${LIMITS.droneBurstMetres} m is ${(LIMITS.droneBurstMetres / perTick).toFixed(0)} `
    + `reports at ${DRONE.speed} m/s`);

  // And it must not be so deep that a drone can bank its way across a house.
  check('but not so deep it is a free repositioning',
    LIMITS.droneBurstMetres < 12, `${LIMITS.droneBurstMetres} m`);

  check('one report may move further than one tick of honest travel',
    LIMITS.droneMaxStep > perTick * 2,
    `${LIMITS.droneMaxStep} m vs ${perTick.toFixed(3)} m per report`);

  /*
   * The step ceiling is the teleport catch, so it has to bite BEFORE the bucket
   * runs out — otherwise a full bucket is spendable as one jump and the ceiling
   * is decorative.
   */
  check('and the step ceiling bites before the bucket empties',
    LIMITS.droneMaxStep < LIMITS.droneBurstMetres,
    `${LIMITS.droneMaxStep} m step inside a ${LIMITS.droneBurstMetres} m bucket`);

  check('a single report cannot cross a room',
    LIMITS.droneMaxStep <= 4, `${LIMITS.droneMaxStep} m`);

  /*
   * Staleness has to outlast a handful of dropped reports, or an ordinary
   * packet loss burst despawns a drone somebody is still driving.
   */
  check('the stale deadline outlasts a real packet-loss burst',
    DRONE.staleMs > (1000 / INPUT_HZ) * 20,
    `${DRONE.staleMs} ms is ${Math.round(DRONE.staleMs / (1000 / INPUT_HZ))} missed reports`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

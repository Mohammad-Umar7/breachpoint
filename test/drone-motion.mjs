/**
 * The drone's motion integrator, hammered.
 *
 * WHY THIS EXISTS
 * ---------------
 * This is the riskiest arithmetic in the drone, and every failure it can have
 * is silent. `setNextKinematicTranslation` accepts a NaN without complaint. The
 * void net downstream of it reads `y < -12`, and `NaN < -12` is FALSE, so a
 * poisoned position passes it. What the value reaches is Rapier's broad phase,
 * where ONE non-finite number disables every raycast on the map — no ground, no
 * walls, no hit registration — while the level goes on rendering perfectly.
 *
 * `stepDroneMotion` is a pure function of plain numbers precisely so that this
 * file can exist: no Rapier, no THREE, no DOM, no renderer, a few milliseconds.
 * It feeds the integrator every degenerate input that has historically poisoned
 * this codebase's broad phase and asserts the two halves of its contract:
 *
 *   1. the returned numbers are ALWAYS finite — never a mix of good and bad —
 *      and `ok` is what says whether they mean anything;
 *   2. the drone cannot outrun `DRONE.speed`, which is the rate the server
 *      refills its drive budget at. A client that could would be corrected
 *      every few reports, and a correction is indistinguishable from lag.
 *
 *   node test/drone-motion.mjs
 */
import { DRONE } from '../src/net/protocol.js';
import { stepDroneMotion } from '../src/drone/droneMotion.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const FIELDS = ['x', 'z', 'yaw', 'vx', 'vz'];
const allFinite = (r) => !!r && FIELDS.every((k) => Number.isFinite(r[k]));
const rest = (over = {}) => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, ...over });
const still = { throttle: 0, steer: 0 };
const DT = 1 / 60;

console.log('--- the shape of the answer ---');
{
  const r = stepDroneMotion(rest(), { throttle: 1, steer: 0 }, DT);
  check('a plain step returns every field, all finite, and ok',
    allFinite(r) && r.ok === true && typeof r.ok === 'boolean',
    JSON.stringify(r));

  // The keys themselves, because a caller reads `next.yaw` and a missing key is
  // `undefined`, and `undefined` written into a rotation is a chassis facing
  // nowhere with nothing thrown.
  const keys = Object.keys(r).sort().join(',');
  check('and exactly the fields the caller reads', keys === 'ok,vx,vz,x,yaw,z', keys);
}

console.log('\n--- driving ---');
{
  // Yaw 0 faces -Z, the same convention Player.js uses for its forward vector.
  let s = rest();
  for (let i = 0; i < 200; i++) s = stepDroneMotion(s, { throttle: 1, steer: 0 }, DT);
  check('full throttle drives along the chassis forward axis',
    s.ok && s.z < -1 && Math.abs(s.x) < 1e-9,
    `x=${s.x.toFixed(6)} z=${s.z.toFixed(3)}`);

  check('and settles at exactly the shared top speed',
    Math.abs(Math.hypot(s.vx, s.vz) - DRONE.speed) < 1e-9,
    `${Math.hypot(s.vx, s.vz).toFixed(6)} vs ${DRONE.speed} m/s`);

  // Reverse being slower is what stops every pilot driving backwards out of
  // every room they are seen in.
  let b = rest();
  for (let i = 0; i < 200; i++) b = stepDroneMotion(b, { throttle: -1, steer: 0 }, DT);
  check('reverse is slower than forward',
    Math.hypot(b.vx, b.vz) < DRONE.speed - 0.2 && b.z > 0,
    `${Math.hypot(b.vx, b.vz).toFixed(3)} m/s backwards`);

  // Steering alone must not translate: a tracked robot turns on the spot, and
  // a chassis that crept while turning would drift out of the server's leash
  // without the pilot ever touching the throttle.
  let t = rest();
  for (let i = 0; i < 120; i++) t = stepDroneMotion(t, { throttle: 0, steer: 1 }, DT);
  check('steering alone turns on the spot',
    t.ok && Math.abs(t.x) < 1e-9 && Math.abs(t.z) < 1e-9 && Math.abs(t.yaw) > 0.5,
    `moved ${Math.hypot(t.x, t.z).toExponential(1)} m, yaw ${t.yaw.toFixed(2)}`);

  // Coasting to a stop must reach EXACTLY zero, not an asymptote: a velocity
  // that never quite dies is a drone that never quite stops reporting movement,
  // and it spends the server's drive budget doing nothing.
  let c = rest({ vx: 0, vz: -DRONE.speed });
  for (let i = 0; i < 200; i++) c = stepDroneMotion(c, still, DT);
  check('releasing the throttle stops the drone dead, not asymptotically',
    c.vx === 0 && c.vz === 0, `vx=${c.vx} vz=${c.vz}`);

  const p = stepDroneMotion(rest(), still, DT);
  check('and a parked drone does not drift', p.ok && p.x === 0 && p.z === 0 && p.yaw === 0,
    JSON.stringify([p.x, p.z, p.yaw]));
}

console.log('\n--- the speed ceiling ---');
{
  /*
   * The property the server actually enforces, proved over a long random walk
   * rather than at a couple of chosen inputs. Ten thousand steps of arbitrary
   * throttle and steering, and the drone must never have travelled further than
   * DRONE.speed * elapsed. If it can, the server's budget refuses honest
   * driving and the pilot rubber-bands.
   */
  const rng = mulberry32(0xd0e5);
  let s = rest();
  let ok = true;
  let worst = 0;
  let pathLength = 0;
  const steps = 10000;
  for (let i = 0; i < steps; i++) {
    const prevX = s.x, prevZ = s.z;
    const next = stepDroneMotion(s, { throttle: rng() * 2 - 1, steer: rng() * 2 - 1 }, DT);
    if (!next.ok || !allFinite(next)) { ok = false; break; }
    pathLength += Math.hypot(next.x - prevX, next.z - prevZ);
    worst = Math.max(worst, Math.hypot(next.vx, next.vz));
    s = next;
  }
  check('a 10000-step random walk never returns a non-finite field', ok,
    ok ? `${steps} steps` : 'a step went bad');

  check('and never exceeds the shared top speed',
    ok && worst <= DRONE.speed + 1e-9,
    `peak ${worst.toFixed(6)} of ${DRONE.speed} m/s`);

  const elapsed = steps * DT;
  check('so the distance driven cannot outrun the server\'s refill rate',
    ok && pathLength <= DRONE.speed * elapsed + 1e-6,
    `${pathLength.toFixed(2)} m in ${elapsed.toFixed(1)} s, budget ${(DRONE.speed * elapsed).toFixed(2)} m`);

  /*
   * The same bound again, driven flat out.
   *
   * The walk above averages its throttle to nearly nothing, so it clears the
   * budget by a mile and would still clear it if the cap were twice what it
   * should be — a check that passes while examining nothing. This one holds the
   * throttle down for the whole run and only steers, so the distance driven
   * sits right against the ceiling, and the lower bound below is what proves it
   * is actually pressed against it rather than idling short of it.
   */
  let f = rest();
  let hard = 0;
  let hardOk = true;
  const hardSteps = 4000;
  for (let i = 0; i < hardSteps; i++) {
    const prevX = f.x, prevZ = f.z;
    const next = stepDroneMotion(f, { throttle: 1, steer: rng() * 2 - 1 }, DT);
    if (!next.ok || !allFinite(next)) { hardOk = false; break; }
    hard += Math.hypot(next.x - prevX, next.z - prevZ);
    f = next;
  }
  const budget = DRONE.speed * hardSteps * DT;
  check('and flat out it presses right up against that budget without crossing it',
    hardOk && hard <= budget + 1e-6 && hard > budget * 0.95,
    `${hard.toFixed(3)} m of a ${budget.toFixed(3)} m budget`);

  /*
   * An absurd but perfectly finite velocity, which is what the ceiling is
   * really for. It must be clamped TO top speed — not merely left below it,
   * which is why the assertion is an equality and not another `<=`.
   *
   * That distinction is the whole check. Written as `<=`, a clamp that
   * collapsed the velocity to zero would pass. `Math.sqrt(vx*vx + vz*vz)` is
   * exactly such a clamp: at this magnitude the squares overflow to Infinity,
   * the scale becomes speed/Infinity = 0, and the drone silently stops dead
   * with nothing thrown and nothing logged. `Math.hypot` does not.
   */
  const huge = stepDroneMotion(rest({ vx: 1e200, vz: 1e200 }), { throttle: 1, steer: 0 }, DT);
  const hugeSpeed = Math.hypot(huge.vx, huge.vz);
  check('an absurd finite velocity is clamped down TO top speed, not to zero',
    allFinite(huge) && huge.ok && Math.abs(hugeSpeed - DRONE.speed) < 1e-9,
    `${hugeSpeed.toFixed(6)} m/s, ok=${huge.ok}`);

  // Nudged past the cap by a hair — the boundary, where an off-by-one in the
  // comparison lives.
  const edge = stepDroneMotion(rest({ vx: 0, vz: -DRONE.speed * 1.0001 }), { throttle: 1, steer: 0 }, DT);
  check('and so is one a hair over it',
    edge.ok && Math.hypot(edge.vx, edge.vz) <= DRONE.speed + 1e-9,
    `${Math.hypot(edge.vx, edge.vz).toFixed(6)} m/s`);
}

console.log('\n--- degenerate input ---');
{
  /*
   * Every field, every poison, one at a time. `x > undefined` is false and
   * `NaN < -12` is false, so none of these fails loudly anywhere downstream —
   * they fail as a map that has quietly stopped answering raycasts.
   */
  const POISONS = [NaN, Infinity, -Infinity, undefined, null, '3', {}, []];
  const bad = [];
  for (const field of FIELDS) {
    for (const poison of POISONS) {
      const r = stepDroneMotion(rest({ [field]: poison }), { throttle: 1, steer: 0.5 }, DT);
      if (r.ok !== false || !allFinite(r)) bad.push(`state.${field}=${String(poison)}`);
    }
  }
  check('a poisoned state field is refused, and the answer is still all finite',
    bad.length === 0,
    bad.slice(0, 4).join(', ') || `${FIELDS.length * POISONS.length} combinations`);

  const badIn = [];
  for (const field of ['throttle', 'steer']) {
    for (const poison of POISONS) {
      const r = stepDroneMotion(rest(), { throttle: 0, steer: 0, [field]: poison }, DT);
      if (r.ok !== false || !allFinite(r)) badIn.push(`input.${field}=${String(poison)}`);
    }
  }
  check('so is a poisoned input field', badIn.length === 0,
    badIn.slice(0, 4).join(', ') || `${2 * POISONS.length} combinations`);

  const missing = [
    stepDroneMotion(undefined, { throttle: 1, steer: 0 }, DT),
    stepDroneMotion(rest(), undefined, DT),
    stepDroneMotion(null, null, DT),
    stepDroneMotion({}, {}, DT),
  ];
  check('and a missing state or input object entirely, without throwing',
    missing.every((r) => r.ok === false && allFinite(r)),
    `${missing.length} calls`);

  const dts = [0, -DT, -1, NaN, Infinity, -Infinity, undefined, null, '0.016', 1e9, 0.5];
  const badDt = dts.filter((dt) => {
    const r = stepDroneMotion(rest(), { throttle: 1, steer: 0 }, dt);
    return r.ok !== false || !allFinite(r);
  });
  check('every unusable dt — zero, negative, non-finite, or a whole stalled tab',
    badDt.length === 0, badDt.map(String).join(', ') || `${dts.length} values refused`);

  /*
   * And the decisive property of a refusal: it hands back the pose the caller
   * came in with, not zeros. A caller that ignored `ok` would otherwise
   * teleport a drone that had been driving happily across the map to the world
   * origin, the first time one frame arrived with a bad dt.
   */
  const held = stepDroneMotion(rest({ x: 7.5, z: -3.25, yaw: 1.1, vx: NaN }), still, DT);
  check('a refusal holds the caller\'s own pose rather than resetting to zero',
    held.ok === false && held.x === 7.5 && held.z === -3.25 && held.yaw === 1.1
    && held.vx === 0 && held.vz === 0,
    JSON.stringify(held));
}

console.log('\n--- angles ---');
{
  // A yaw that has been integrated for a long session, then handed back in.
  // The wrap has to be a modulo: the `while (a > PI) a -= 2PI` spelling this is
  // usually written as never returns for an input this large, and a test that
  // hangs is indistinguishable from one that is slow.
  const started = Date.now();
  const r = stepDroneMotion(rest({ yaw: 1e300 }), { throttle: 0, steer: 1 }, DT);
  const took = Date.now() - started;
  check('an enormous but finite yaw returns promptly and inside [-PI, PI]',
    r.ok && Math.abs(r.yaw) <= Math.PI + 1e-12 && took < 1000,
    `yaw ${r.yaw.toFixed(4)} in ${took} ms`);

  let s = rest();
  let inRange = true;
  for (let i = 0; i < 5000; i++) {
    s = stepDroneMotion(s, { throttle: 0, steer: 1 }, DT);
    if (!(Math.abs(s.yaw) <= Math.PI + 1e-12)) { inRange = false; break; }
  }
  check('and spinning for 80 seconds never lets yaw drift out of range', inRange,
    `yaw ${s.yaw.toFixed(4)}`);

  // Out-of-range sticks are clamped rather than refused: a stuck key and a
  // hostile client look identical from here, and neither may move the drone
  // further than an honest one.
  const wild = stepDroneMotion(rest(), { throttle: 1e6, steer: -1e6 }, DT);
  const sane = stepDroneMotion(rest(), { throttle: 1, steer: -1 }, DT);
  check('sticks past their stops are clamped, not obeyed and not refused',
    wild.ok && FIELDS.every((k) => wild[k] === sane[k]),
    `throttle 1e6 lands on ${wild.vz.toFixed(4)} m/s, same as full stick`);
}

console.log('\n--- purity ---');
{
  /*
   * The caller passes a REUSED scratch object every fixed step, so writing back
   * into it would make the integrator's output depend on how many times it had
   * been called — untestable, and a source of drift nobody could reproduce.
   */
  const state = rest({ x: 1, z: 2, yaw: 0.5, vx: 0.25, vz: -0.75 });
  const before = JSON.stringify(state);
  const input = { throttle: 0.6, steer: -0.4 };
  const inputBefore = JSON.stringify(input);
  const a = stepDroneMotion(state, input, DT);
  const b = stepDroneMotion(state, input, DT);
  check('the integrator mutates neither argument',
    JSON.stringify(state) === before && JSON.stringify(input) === inputBefore,
    'state and input unchanged');
  check('and the same call twice gives the same answer',
    FIELDS.every((k) => a[k] === b[k]) && a !== b,
    'deterministic, and a fresh object each time');
}

/** mulberry32 — the same generator MathUtils uses, inlined to keep this pure. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

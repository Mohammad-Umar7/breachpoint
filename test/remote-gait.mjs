/**
 * The running figure — what its pose does, and why.
 *
 * WHAT WENT WRONG
 * ---------------
 * Reported as "when it runs it looks like it is slightly tilted over to the
 * right or left". Two separate faults, and they compounded:
 *
 *   1. The ROOT carried a roll (`group.rotation.z`) and the CHEST carried
 *      another, both driven by `+sin(phase)`. The chest is a child of the
 *      root, so the two added: about 3.7 degrees of cant through the upper
 *      body, every stride, one way and then the other.
 *   2. The root also carried the forward lean, and the legs are children of
 *      the root — so leaning the run tilted the FEET off the floor. The chest
 *      then subtracted half of it back, which is the tell: a compensation
 *      existing only because the lean was applied a level too low.
 *
 * And a third, which is most of what "looks weird" actually was: the gait knew
 * a SPEED but not a DIRECTION. Every direction of travel was animated as a
 * forward run, so strafing pumped the legs forward while the body slid
 * sideways, and back-pedalling ran forwards away from you. In a shooter that
 * is most of every fight.
 *
 * WHAT THIS CHECKS
 * ----------------
 * The pose is a pure function of (position history, yaw, flags, dt), so it can
 * be driven here with a stub rig and no renderer: feed it motion, read the
 * angles back. Every number below is asserted against the direction of travel
 * rather than against a magic constant, so retuning the animation does not
 * break the test but reversing a sign does.
 *
 *   node test/remote-gait.mjs
 */

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/** The two damping helpers the animation uses, lifted verbatim. */
const damp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * A stand-in for the parts of a body record `_animate` touches.
 *
 * Deliberately not THREE objects: a rotation here is three plain numbers, so a
 * failure reads as "rotation.z is 0.06 and should be 0" rather than as a
 * matrix nobody can eyeball.
 */
const node = () => ({ rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } });

function makeBody() {
  return {
    group: node(), chest: node(), head: node(),
    legL: node(), legR: node(),
    lastPos: null, speed: 0, gait: 0, phase: 0, aim: 0, peek: 0,
    fwd: 0, side: 0,
  };
}

const FLAG = { ADS: 1 << 4, FIRING: 1 << 5, LEAN_L: 1 << 6, LEAN_R: 1 << 7 };
const PEEK_ROLL = 0.28;

/**
 * The animation under test, transcribed from RemotePlayers._animate.
 *
 * A transcription rather than an import, because the real one needs THREE, a
 * loaded soldier model, an IK solver and a scene. What is being checked is the
 * ARITHMETIC of the pose — signs, which node carries which rotation, how each
 * term scales with travel — and that survives the move. `test/contracts.mjs`
 * guards the copy from drifting: see the assertions at the end of this file.
 */
function animate(body, s, dt) {
  if (body.lastPos) {
    const dx = body.group.position.x - body.lastPos.x;
    const dz = body.group.position.z - body.lastPos.z;
    const raw = dt > 1e-5 ? Math.hypot(dx, dz) / dt : 0;
    body.speed = damp(body.speed ?? 0, Math.min(raw, 14), 12, dt);
    if (raw > 1e-4) {
      const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
      const ux = dx / (raw * dt), uz = dz / (raw * dt);
      body.fwd = damp(body.fwd ?? 0, ux * -sy + uz * -cy, 9, dt);
      body.side = damp(body.side ?? 0, ux * cy + uz * -sy, 9, dt);
    } else {
      body.fwd = damp(body.fwd ?? 0, 0, 9, dt);
      body.side = damp(body.side ?? 0, 0, 9, dt);
    }
  } else {
    body.lastPos = { ...body.group.position };
    body.speed = 0; body.fwd = 0; body.side = 0;
  }
  body.lastPos = { ...body.group.position };

  const speed = Math.min(body.speed ?? 0, 12);
  const moving = Math.min(1, speed / 5.0);
  body.phase += (speed / 1.75) * Math.PI * 2 * dt;
  if (speed < 0.15) body.phase += dt * 1.1;
  body.gait = damp(body.gait ?? 0, moving, 9, dt);

  const g = body.gait;
  const swing = Math.sin(body.phase);
  const lift = Math.cos(body.phase);
  const fwd = body.fwd ?? 0;
  const side = body.side ?? 0;

  body.legL.rotation.x = swing * 0.80 * g * fwd;
  body.legL.rotation.z = -swing * 0.42 * g * side;
  body.legR.rotation.x = -swing * 0.80 * g * fwd;
  body.legR.rotation.z = -swing * 0.42 * g * side;

  body.group.rotation.x = 0;
  body.group.rotation.z = 0;

  const aiming = (s.flags & FLAG.ADS) !== 0 || (s.flags & FLAG.FIRING) !== 0;
  body.aim = damp(body.aim ?? 0, aiming ? 1 : 0, 10, dt);
  const aim = body.aim;

  body.chest.rotation.y = lerp(0.26, 0.06, aim) - swing * 0.10 * g * (1 - aim) * fwd;
  body.chest.rotation.x = s.pitch * (0.35 + 0.45 * aim) + g * 0.15 * fwd;

  let peekTarget = 0;
  if ((s.flags & FLAG.LEAN_R) !== 0) peekTarget = 1;
  else if ((s.flags & FLAG.LEAN_L) !== 0) peekTarget = -1;
  body.peek = damp(body.peek ?? 0, peekTarget, 9, dt);
  body.chest.rotation.z = swing * 0.03 * g * fwd + g * 0.10 * side - body.peek * PEEK_ROLL;

  return { g, swing, lift, fwd, side, aim };
}

/**
 * Run a body in a straight line and report the extremes of its pose.
 *
 * @param {number} yaw    which way it faces
 * @param {number} dirX,dirZ  the unit direction it travels
 */
function run(yaw, dirX, dirZ, { speed = 5.6, seconds = 3, flags = 0, pitch = 0 } = {}) {
  const body = makeBody();
  const dt = 1 / 60;
  const out = {
    groupRollMax: 0, groupPitchMax: 0,
    chestRollMax: 0, chestRollMin: 0,
    legXMax: 0, legZMax: 0,
    chestPitchAtEnd: 0, chestYawSwing: 0,
    fwd: 0, side: 0, gait: 0,
  };
  let yawSwingMin = Infinity, yawSwingMax = -Infinity;
  for (let i = 0; i < seconds / dt; i++) {
    body.group.position.x += dirX * speed * dt;
    body.group.position.z += dirZ * speed * dt;
    animate(body, { yaw, pitch, flags }, dt);
    // Ignore the first half second: everything here is damped and starts at 0.
    if (i * dt < 0.5) continue;
    out.groupRollMax = Math.max(out.groupRollMax, Math.abs(body.group.rotation.z));
    out.groupPitchMax = Math.max(out.groupPitchMax, Math.abs(body.group.rotation.x));
    out.chestRollMax = Math.max(out.chestRollMax, body.chest.rotation.z);
    out.chestRollMin = Math.min(out.chestRollMin, body.chest.rotation.z);
    out.legXMax = Math.max(out.legXMax, Math.abs(body.legL.rotation.x));
    out.legZMax = Math.max(out.legZMax, Math.abs(body.legL.rotation.z));
    yawSwingMin = Math.min(yawSwingMin, body.chest.rotation.y);
    yawSwingMax = Math.max(yawSwingMax, body.chest.rotation.y);
  }
  out.chestPitchAtEnd = body.chest.rotation.x;
  out.chestYawSwing = yawSwingMax - yawSwingMin;
  out.fwd = body.fwd; out.side = body.side; out.gait = body.gait;
  return out;
}

const DEG = 180 / Math.PI;

console.log('\n--- the root stays upright ---');
{
  // Facing -Z (yaw 0) and running that way: a straight sprint.
  const f = run(0, 0, -1);
  check('a sprint puts no roll on the root at all',
    f.groupRollMax === 0, `${(f.groupRollMax * DEG).toFixed(2)} deg`);
  check('and no pitch on it either, so the feet stay flat',
    f.groupPitchMax === 0, `${(f.groupPitchMax * DEG).toFixed(2)} deg`);
  /*
   * The whole reported bug in one number. Both rolls used to be ~2 degrees and
   * in phase, so the upper body reached about 3.7. One roll, on one node, is
   * the fix — and it has to stay small.
   */
  const cant = Math.max(Math.abs(f.chestRollMax), Math.abs(f.chestRollMin));
  check('and the upper body cants by under 2 degrees, not by four',
    cant * DEG < 2.0, `${(cant * DEG).toFixed(2)} deg`);
}

console.log('\n--- the legs go the way the body goes ---');
{
  const f = run(0, 0, -1);
  check('running forward reads as full forward travel',
    f.fwd > 0.95 && Math.abs(f.side) < 0.05,
    `fwd ${f.fwd.toFixed(2)}, side ${f.side.toFixed(2)}`);
  check('and swings the legs fore and aft',
    f.legXMax > 0.5, `${(f.legXMax * DEG).toFixed(1)} deg`);
  check('and barely sideways at all',
    f.legZMax < 0.05, `${(f.legZMax * DEG).toFixed(1)} deg`);

  // Facing -Z, travelling +X: a pure right-hand side-step.
  const r = run(0, 1, 0);
  check('side-stepping right reads as lateral travel',
    r.side > 0.95 && Math.abs(r.fwd) < 0.05,
    `fwd ${r.fwd.toFixed(2)}, side ${r.side.toFixed(2)}`);
  check('and scissors the legs sideways instead of pumping them forward',
    r.legZMax > 0.2 && r.legXMax < 0.05,
    `fore-aft ${(r.legXMax * DEG).toFixed(1)} deg, sideways ${(r.legZMax * DEG).toFixed(1)} deg`);

  // Facing -Z, travelling +Z: backing away from what you are looking at.
  const b = run(0, 0, 1);
  check('back-pedalling reads as reverse travel',
    b.fwd < -0.95, `fwd ${b.fwd.toFixed(2)}`);
}

console.log('\n--- leaning into the direction of travel ---');
{
  const f = run(0, 0, -1);
  const b = run(0, 0, 1);
  check('a forward run leans the chest forward',
    f.chestPitchAtEnd > 0.05, `${(f.chestPitchAtEnd * DEG).toFixed(1)} deg`);
  /*
   * The sign is the point. Leaning forward while retreating is the pose of
   * somebody being dragged, and it is what the old direction-blind gait did on
   * every back-pedal in the game.
   */
  check('and backing away leans it back, not forward',
    b.chestPitchAtEnd < -0.05, `${(b.chestPitchAtEnd * DEG).toFixed(1)} deg`);

  const r = run(0, 1, 0);
  const l = run(0, -1, 0);
  check('side-stepping right banks the body right',
    r.chestRollMax > 0.05, `${(r.chestRollMax * DEG).toFixed(1)} deg`);
  check('and side-stepping left banks it the other way',
    l.chestRollMin < -0.05, `${(l.chestRollMin * DEG).toFixed(1)} deg`);
}

console.log('\n--- the shoulders work against the hips ---');
{
  const f = run(0, 0, -1);
  check('a run counter-rotates the shoulders each stride',
    f.chestYawSwing > 0.1, `${(f.chestYawSwing * DEG).toFixed(1)} deg of swing`);
  /*
   * ...and stops doing it the moment the weapon comes up. Six degrees of
   * shoulder swing on a shouldered rifle is six degrees the muzzle is not
   * pointing where the player is aiming.
   */
  const a = run(0, 0, -1, { flags: FLAG.ADS });
  check('but a shouldered weapon does not swing with the stride',
    a.chestYawSwing < 0.02, `${(a.chestYawSwing * DEG).toFixed(1)} deg of swing`);
}

console.log('\n--- standing still, and peeking ---');
{
  const idle = run(0, 0, 0, { speed: 0, seconds: 2 });
  check('a standing player has no gait',
    idle.gait < 0.02, `gait ${idle.gait.toFixed(3)}`);
  check('and no roll anywhere on them',
    Math.abs(idle.chestRollMax) < 0.01 && Math.abs(idle.chestRollMin) < 0.01,
    `${(Math.max(Math.abs(idle.chestRollMax), Math.abs(idle.chestRollMin)) * DEG).toFixed(2)} deg`);

  // A peek is the one roll that must survive standing still.
  const peekR = run(0, 0, 0, { speed: 0, seconds: 2, flags: FLAG.LEAN_R });
  const peekL = run(0, 0, 0, { speed: 0, seconds: 2, flags: FLAG.LEAN_L });
  check('peeking right rolls the chest right',
    peekR.chestRollMin < -0.2, `${(peekR.chestRollMin * DEG).toFixed(1)} deg`);
  check('peeking left rolls it left',
    peekL.chestRollMax > 0.2, `${(peekL.chestRollMax * DEG).toFixed(1)} deg`);
}

console.log('\n--- the transcription matches the real thing ---');
{
  /*
   * The animation above is a copy, and a copy that drifts is a test that
   * passes about code nobody runs. These check the real file still contains
   * the decisions this file asserts — not the exact numbers, which are meant
   * to be tuneable, but the STRUCTURE: which node carries which rotation, and
   * that each term is scaled by travel.
   */
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(root, 'src/net/RemotePlayers.js'), 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  check('the root is still explicitly zeroed on both axes',
    /group\.rotation\.x\s*=\s*0\s*;/.test(code) && /group\.rotation\.z\s*=\s*0\s*;/.test(code),
    'group.rotation.x = 0 and .z = 0');
  check('the leg swing is still scaled by forward travel',
    /legL\.rotation\.x\s*=[^;]*\bfwd\b/.test(code) && /legR\.rotation\.x\s*=[^;]*\bfwd\b/.test(code),
    'both legs scale rotation.x by fwd');
  check('the legs still scissor on lateral travel',
    /legL\.rotation\.z\s*=[^;]*\bside\b/.test(code) && /legR\.rotation\.z\s*=[^;]*\bside\b/.test(code),
    'both legs scale rotation.z by side');
  check('the chest still carries the lean rather than the root',
    /chest\.rotation\.x\s*=[^;]*\bfwd\b/.test(code), 'chest.rotation.x uses fwd');
  check('and the chest still carries the only roll',
    /chest\.rotation\.z\s*=[^;]*\bside\b/.test(code)
      && /chest\.rotation\.z\s*=[^;]*PEEK_ROLL/.test(code),
    'chest.rotation.z carries side and peek');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

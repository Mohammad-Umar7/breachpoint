/**
 * RemoteAudio — what the other players sound like.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ----------------------------
 * Every other multiplayer test here talks to the server. None of them touch a
 * line of client code, and this project has already shipped a change where all
 * 159 checks passed while multiplayer was completely broken on the client —
 * the callbacks were never wired, and nothing looked.
 *
 * Sound is the worst possible candidate for that failure mode. A silent bug is
 * literally silent: no exception, no visual, nothing on screen. It would be
 * found by somebody being shot in the back and asking why they heard nothing.
 *
 * So RemoteAudio takes its audio manager as a constructor argument, which
 * makes it testable with a recorder instead of a sound card. Everything below
 * drives the same `update()` the game calls, with the same shapes, and reads
 * back what would have been played.
 */
import { RemoteAudio } from '../src/net/RemoteAudio.js';
import { FLAG } from '../src/net/protocol.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/** Stands in for AudioManager, recording instead of making a noise. */
function recorder() {
  const played = [];
  return {
    played,
    play(name, opts = {}) { played.push({ name, ...opts }); },
    clear() { played.length = 0; },
    names() { return played.map((p) => p.name); },
    count(prefix) { return played.filter((p) => p.name.startsWith(prefix)).length; },
  };
}

/**
 * A stand-in for a RemotePlayers body record — only the three fields
 * RemoteAudio actually reads. `contracts.mjs` checks those three still exist
 * on the real thing, so this staying in step is enforced rather than hoped for.
 */
const makeBody = (x = 0, y = 0, z = 0) => ({
  phase: 0,
  speed: 0,
  group: { position: { x, y, z } },
});

const sample = (flags = 0, weapon = 'rifle') => ({ flags, weapon });

/** Squared distance that is comfortably inside every range cut-off. */
const NEAR = 4 * 4;

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------- footsteps
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 4;

  // First call adopts the phase without playing, or every player who walks
  // into view cracks out a step as they appear.
  ra.update(1, body, sample(), NEAR);
  check('a body makes no sound on the frame it appears',
    audio.played.length === 0, audio.names().join(', ') || 'silent');

  /*
   * One full stride cycle is 2π and contains TWO footfalls, one per leg — the
   * gait's vertical bob is |cos(phase)|, lowest (weight fully on the planted
   * foot) at π/2 and again at 3π/2.
   */
  audio.clear();
  for (let i = 1; i <= 60; i++) {
    body.phase = (i / 60) * Math.PI * 2;
    ra.update(1, body, sample(), NEAR);
  }
  check('one stride cycle produces exactly two footfalls',
    audio.count('footstep') === 2, `${audio.count('footstep')} steps over 2π`);

  // And they land ON the footfall, not somewhere in between. The phase
  // continues forward from wherever the last block left it — it only ever
  // increases in the game, and winding it back would fire a spurious step.
  audio.clear();
  const at = [];
  const from = body.phase;
  for (let i = 1; i <= 400; i++) {
    body.phase = from + (i / 100) * Math.PI * 2;     // four more cycles
    const before = audio.played.length;
    ra.update(1, body, sample(), NEAR);
    if (audio.played.length > before) at.push(body.phase % Math.PI);
  }
  const offBeat = at.filter((p) => Math.abs(p - HALF_PI) > 0.12);
  check('every footfall lands at the bottom of the gait bob',
    at.length === 8 && offBeat.length === 0,
    `${at.length} steps over four cycles, ${offBeat.length} off-beat`);
}

// ------------------------------------------------------------------- stance
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 4;

  const volumeFor = (flags) => {
    audio.clear();
    // Fresh id each time so the first-frame rule does not swallow the step.
    const id = Math.round(flags) + 1000;
    const b = makeBody();
    b.speed = 4;
    ra.update(id, b, sample(flags), NEAR);
    b.phase = Math.PI;                          // crosses one footfall
    ra.update(id, b, sample(flags), NEAR);
    return audio.played.find((p) => p.name.startsWith('footstep'))?.volume ?? null;
  };

  const walk = volumeFor(0);
  const crouch = volumeFor(FLAG.CROUCH);
  const sprint = volumeFor(FLAG.SPRINT);

  check('crouching is quieter than walking, and walking than sprinting',
    crouch !== null && walk !== null && sprint !== null
    && crouch < walk && walk < sprint,
    `crouch ${crouch}, walk ${walk}, sprint ${sprint}`);

  // The whole risk/reward of moving slowly only works if a crouching enemy is
  // as quiet to you as you are to them.
  check('a crouched player is at most half as loud as a sprinting one',
    crouch <= sprint / 2, `${crouch} vs ${sprint}`);

  // Barely-moving bodies must not tick. Interpolation jitter alone would set
  // a standing player's measured speed slightly above zero.
  audio.clear();
  body.speed = 0.4;
  ra.update(7, body, sample(), NEAR);
  for (let i = 1; i <= 40; i++) {
    body.phase = (i / 20) * Math.PI * 2;
    ra.update(7, body, sample(), NEAR);
  }
  check('a body shuffling below walking pace makes no footsteps',
    audio.count('footstep') === 0, `${audio.count('footstep')} steps at 0.4 m/s`);
}

// ------------------------------------------------------------------ landing
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 4;

  ra.update(2, body, sample(FLAG.AIRBORNE), NEAR);   // first frame, adopts
  audio.clear();

  // Airborne: the legs are not touching anything, so no steps however fast
  // the phase advances.
  for (let i = 1; i <= 40; i++) {
    body.phase = (i / 20) * Math.PI * 2;
    ra.update(2, body, sample(FLAG.AIRBORNE), NEAR);
  }
  check('a player in the air makes no footsteps',
    audio.count('footstep') === 0, `${audio.count('footstep')} while airborne`);

  audio.clear();
  ra.update(2, body, sample(0), NEAR);              // AIRBORNE falls away
  check('and thuds on the way down', audio.names().includes('land'),
    audio.names().join(', ') || 'nothing');

  audio.clear();
  ra.update(2, body, sample(0), NEAR);
  check('but only once per landing', !audio.names().includes('land'),
    audio.names().join(', ') || 'silent, as intended');
}

// ------------------------------------------------------------------ reloads
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();

  ra.update(3, body, sample(0), NEAR);
  audio.clear();

  ra.update(3, body, sample(FLAG.RELOADING), NEAR);
  const reload = audio.played[0];
  check('a reload is heard when it starts', !!reload,
    reload ? `${reload.name}` : 'nothing');
  check('and it is positional — the point is knowing WHERE',
    !!reload?.position, reload?.position ? 'has a world position' : 'unpanned');

  audio.clear();
  for (let i = 0; i < 20; i++) ra.update(3, body, sample(FLAG.RELOADING), NEAR);
  check('and not once per frame for as long as it lasts',
    audio.played.length === 0, `${audio.played.length} repeats over 20 frames`);

  // A different weapon reports its own sound, so a shotgun being topped up and
  // a rifle mag being dropped are distinguishable.
  audio.clear();
  ra.update(3, body, sample(0), NEAR);
  ra.update(3, body, sample(FLAG.RELOADING, 'shotgun'), NEAR);
  check('an unknown weapon still reloads audibly rather than throwing',
    audio.played.length === 1, audio.names().join(', '));

  audio.clear();
  ra.update(4, body, sample(0), NEAR);
  ra.update(4, body, sample(FLAG.RELOADING, 'no-such-weapon'), NEAR);
  check('and a weapon id nothing recognises falls back instead of crashing',
    audio.played.length === 1, audio.names().join(', ') || 'silent');
}

// -------------------------------------------------------------------- range
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 5;

  const FAR = 200 * 200;
  ra.update(5, body, sample(FLAG.AIRBORNE), FAR);
  audio.clear();
  for (let i = 1; i <= 20; i++) {
    body.phase = (i / 10) * Math.PI * 2;
    ra.update(5, body, sample(0), FAR);
  }
  ra.update(5, body, sample(FLAG.RELOADING), FAR);
  check('nothing is built for a player far out of earshot',
    audio.played.length === 0,
    audio.played.length ? audio.names().join(', ') : 'silent across the arena');

  // Range must gate the SOUND without losing track of the player, or the
  // first step after they come back into range would be a stale one.
  audio.clear();
  body.phase += Math.PI;
  ra.update(5, body, sample(0), NEAR);
  check('and coming back into earshot does not replay what was missed',
    audio.count('footstep') <= 1, `${audio.count('footstep')} steps on return`);
}

// --------------------------------------------------------------------- dead
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 5;

  ra.update(6, body, sample(0), NEAR);
  audio.clear();
  for (let i = 1; i <= 20; i++) {
    body.phase = (i / 10) * Math.PI * 2;
    ra.update(6, body, sample(FLAG.DEAD | FLAG.AIRBORNE), NEAR);
  }
  check('a corpse is silent', audio.played.length === 0,
    audio.names().join(', ') || 'silent');

  /*
   * And respawning must not thud. The body is moved to its spawn point while
   * dead, so without resetting the state on death the AIRBORNE flag falling
   * away on the first live frame reads as a landing.
   */
  audio.clear();
  ra.update(6, body, sample(0), NEAR);
  check('and coming back does not thud or crack out a step',
    audio.played.length === 0, audio.names().join(', ') || 'silent');
}

// ------------------------------------------------------------ housekeeping
{
  const audio = recorder();
  const ra = new RemoteAudio({ audio });
  const body = makeBody();
  body.speed = 4;

  for (let i = 0; i < 5; i++) ra.update(i, body, sample(), NEAR);
  check('state is kept per player', ra._state.size === 5, `${ra._state.size} tracked`);

  ra.forget(2);
  check('leaving drops that player', ra._state.size === 4, `${ra._state.size} left`);

  ra.clear();
  check('and clear() drops everyone', ra._state.size === 0, `${ra._state.size} left`);

  /*
   * A body rebuilt under the same id must not crack out a phantom step.
   *
   * RemotePlayers._create picks a RANDOM starting phase, so a player who drops
   * out of the interpolation buffer for a moment and comes back resumes at a
   * different point in their stride. Against a stale footfall index that reads
   * as a footstep — and one phantom step behind you is worse than none,
   * because it is a player who is not there. RemotePlayers.sync calls forget()
   * when it destroys a body; this is what makes that call load-bearing.
   */
  audio.clear();
  const rejoin = makeBody();
  rejoin.speed = 4;
  rejoin.phase = 5.9;
  ra.update(11, rejoin, sample(), NEAR);
  ra.update(11, rejoin, sample(), NEAR);
  ra.forget(11);                       // what sync() does when the body goes
  rejoin.phase = 0.2;                  // rebuilt, with a fresh random phase
  ra.update(11, rejoin, sample(), NEAR);
  check('a rebuilt body does not invent a footstep',
    audio.count('footstep') === 0,
    `${audio.count('footstep')} steps after a rejoin`);

  // Disabling must stop the sound without stopping the bookkeeping falling
  // over — it is reached from a settings toggle, mid-match.
  audio.clear();
  ra.enabled = false;
  for (let i = 1; i <= 20; i++) {
    body.phase = (i / 10) * Math.PI * 2;
    ra.update(9, body, sample(), NEAR);
  }
  check('disabling it silences everything', audio.played.length === 0,
    audio.names().join(', ') || 'silent');

  // And with no audio manager at all it must simply do nothing.
  const headless = new RemoteAudio({ audio: null });
  let threw = null;
  try { headless.update(1, body, sample(), NEAR); } catch (e) { threw = e.message; }
  check('and it survives having no audio manager', threw === null, threw ?? 'no throw');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

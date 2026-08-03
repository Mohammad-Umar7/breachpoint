/**
 * KillCam — the recording, the playback, and the camera.
 *
 * This is a subsystem with a ring buffer and a timeline, which is the kind of
 * code that fails quietly and plausibly: a replay that is a second off, a
 * camera inside the wrong head, an event fired twice, a buffer that wraps and
 * starts serving frames from the future. None of that throws. All of it looks
 * like "the kill cam is a bit weird".
 *
 * It takes its camera as a constructor argument and reads its world state from
 * plain objects, so all of it is checkable here with no renderer, no socket
 * and no browser.
 */
import * as THREE from 'three';
import { KillCam } from '../src/net/KillCam.js';
import { FLAG, MATCH_RULES } from '../src/net/protocol.js';
import {
  EYE_ABOVE_CENTRE_STAND, EYE_ABOVE_CENTRE_CROUCH,
} from '../src/player/Player.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

const camera = () => new THREE.PerspectiveCamera(75, 1, 0.1, 100);

const row = (id, x, z, extra = {}) => ({
  id, x, y: 1.1, z, yaw: 0, pitch: 0, flags: 0, weapon: 'rifle', hp: 100, ...extra,
});

/** A recording of `frames` frames, 33 ms apart, starting at t=1000. */
function recorded(kc, frames, build) {
  let t = 1000;
  for (let i = 0; i < frames; i++) {
    const { sample, self } = build(i);
    kc.record(sample, self, t);
    t += 34;
  }
  return t - 34;               // the timestamp of the last frame written
}

/** Killer (id 2) walks towards a stationary victim (id 1, us). */
const walkTowards = (i) => ({
  sample: new Map([[2, row(2, 0, 20 - i * 0.2, { yaw: Math.PI })]]),
  self: row(1, 0, 0),
});

// ------------------------------------------------------------------ recording
{
  const kc = new KillCam({ camera: camera() });
  // Six calls inside a single 33 ms window must produce one frame, or the
  // buffer holds a fraction of a second of history at 60 fps.
  for (let i = 0; i < 6; i++) kc.record(new Map(), row(1, 0, 0), 1000 + i * 4);
  check('recording is throttled to its own rate, not the frame rate',
    kc._count === 1, `${kc._count} frames from 6 calls in 24 ms`);

  const kc2 = new KillCam({ camera: camera() });
  recorded(kc2, 40, walkTowards);
  check('and keeps a frame per interval after that', kc2._count === 40,
    `${kc2._count} frames`);

  /*
   * We must be IN our own recording. NetworkClient.sample() never contains the
   * local player, and a kill cam without the victim is a video of somebody
   * looking at an empty corridor.
   */
  const f = kc2._frames[kc2._head];
  const ids = [];
  for (let i = 0; i < f.n; i++) ids.push(f.rows[i].id);
  check('the local player is recorded alongside everyone else',
    ids.includes(1) && ids.includes(2), `frame holds ${ids.join(', ')}`);
}

// ------------------------------------------------------------------- refusals
{
  const kc = new KillCam({ camera: camera() });
  check('nothing to replay yet, so it refuses', kc.watch(2) === 0, 'empty buffer');

  const end = recorded(kc, 250, walkTowards);
  check('an unrecorded player cannot be watched',
    kc.watch(404, { endAtMs: end }) === 0, 'unknown id');
  check('and neither can nobody', kc.watch(null, { endAtMs: end }) === 0, 'null id');

  kc.enabled = false;
  check('turning it off refuses outright',
    kc.watch(2, { endAtMs: end }) === 0, 'disabled');
  kc.enabled = true;

  // A quarter of a second of history is not worth taking the camera for.
  const brief = new KillCam({ camera: camera() });
  recorded(brief, 8, walkTowards);
  check('too little history to be worth showing is refused',
    brief.watch(2, { endAtMs: 1000 + 7 * 34 }) === 0,
    `${((8 * 34) / 1000).toFixed(2)}s recorded`);

  const len = kc.watch(2, { endAtMs: end });
  check('but a real one is accepted, and says how long it will run',
    len > 0, `${len.toFixed(2)}s`);
  check('and it is then active', kc.active === true);
  check('watching the right person', kc.subjectId === 2);
}

// ----------------------------------------------------- the window is the fight
{
  /*
   * The whole point of anchoring to the engagement rather than the clock: a
   * long duel is replayed from its opening round, and a one-shot kill is not
   * padded out with ten seconds of somebody walking down a corridor.
   */
  const kc = new KillCam({ camera: camera() });
  const end = recorded(kc, 300, walkTowards);

  const instant = kc.windowFor(2, end);
  check('a kill with no prior damage gets the minimum window',
    near(instant, MATCH_RULES.killCamMinSec, 0.01),
    `${instant.toFixed(2)}s, floor is ${MATCH_RULES.killCamMinSec}s`);

  // A four-second exchange.
  kc.markAggressor(2, end - 4000);
  const duel = kc.windowFor(2, end);
  check('a four-second fight is replayed from where it started',
    near(duel, 4 + MATCH_RULES.killCamLeadSec, 0.01),
    `${duel.toFixed(2)}s = 4s of fighting + ${MATCH_RULES.killCamLeadSec}s lead-in`);
  check('so a longer fight really does get a longer replay',
    duel > instant, `${duel.toFixed(2)}s vs ${instant.toFixed(2)}s`);

  // Only the FIRST round from an attacker counts, or a drawn-out exchange
  // would keep resetting to its most recent hit and show only the end.
  kc.markAggressor(2, end - 500);
  check('and later hits do not shorten it back down',
    near(kc.windowFor(2, end), duel, 0.01), `${kc.windowFor(2, end).toFixed(2)}s`);

  // But there is a ceiling, or you are watching television instead of playing.
  kc.markAggressor(3, end - 45000);
  check('an absurdly long fight is capped',
    near(kc.windowFor(3, end), MATCH_RULES.killCamMaxSec, 0.01),
    `45s fight -> ${kc.windowFor(3, end).toFixed(2)}s, ceiling ${MATCH_RULES.killCamMaxSec}s`);

  kc.forgetEngagements();
  check('and a new life forgets the last one\'s fights',
    near(kc.windowFor(2, end), MATCH_RULES.killCamMinSec, 0.01),
    `${kc.windowFor(2, end).toFixed(2)}s`);
}

// ------------------------------------------------- the window is really used
{
  const kc = new KillCam({ camera: camera() });
  const end = recorded(kc, 300, walkTowards);
  kc.markAggressor(2, end - 3500);
  const promised = kc.watch(2, { endAtMs: end });
  check('watch() plays the window the fight earned, not a fixed one',
    near(promised, 3.5 + MATCH_RULES.killCamLeadSec, 0.05),
    `${promised.toFixed(2)}s`);

  let elapsed = 0;
  for (let i = 0; i < 2000 && kc.active; i++) { kc.update(1 / 60); elapsed += 1 / 60; }
  check('and runs for exactly that long', near(elapsed, promised, 0.1),
    `ran ${elapsed.toFixed(2)}s, promised ${promised.toFixed(2)}s`);

  // The recording has to be deep enough that the CLAMP is what limits the
  // window, not the buffer quietly running out underneath it.
  const deep = new KillCam({ camera: camera() });
  const dEnd = recorded(deep, 400, walkTowards);
  deep.markAggressor(2, dEnd - MATCH_RULES.killCamMaxSec * 1000);
  const longest = deep.watch(2, { endAtMs: dEnd });
  check('the buffer holds the longest replay the rules allow',
    near(longest, MATCH_RULES.killCamMaxSec, 0.15),
    `${longest.toFixed(2)}s of a ${MATCH_RULES.killCamMaxSec}s ceiling`);
}

// -------------------------------------------------------------- what is drawn
{
  const kc = new KillCam({ camera: camera() });
  const end = recorded(kc, 120, walkTowards);
  kc.watch(2, { endAtMs: end });
  kc.update(0.016);

  const drawn = kc.sample;
  check('the replay draws the victim — the whole point of the shot',
    drawn.has(1), [...drawn.keys()].join(', '));
  /*
   * And it draws the KILLER, which is what makes it legible.
   *
   * The first version deleted them, because the camera sat at their eye and
   * their own head filled the screen. The result had no body and no weapon
   * anywhere in frame, and was reported as "I see my own POV facing the wrong
   * way" — with nothing on screen belonging to anybody, there was no way to
   * tell it was somebody else's view at all.
   */
  check('and the killer, so it reads as a person rather than a loose camera',
    drawn.has(2), drawn.has(2) ? 'subject drawn' : 'SUBJECT MISSING');

  // The world state has to be the same shape live play produces, or
  // RemotePlayers would need to know a replay from the real thing.
  const v = drawn.get(1);
  const shape = ['id', 'x', 'y', 'z', 'yaw', 'pitch', 'flags', 'weapon', 'hp']
    .filter((k) => v[k] === undefined);
  check('and every row is the shape RemotePlayers already reads',
    shape.length === 0, shape.length ? `missing ${shape.join(', ')}` : 'complete');
}

// ---------------------------------------------------------------- the camera
{
  const cam = camera();
  const kc = new KillCam({ camera: cam });
  // The killer stands still, looking south-west and slightly down.
  const YAW = 2.1, PITCH = -0.3;
  const end = recorded(kc, 120, () => ({
    sample: new Map([[2, row(2, 7, -3, { yaw: YAW, pitch: PITCH })]]),
    self: row(1, 0, 0),
  }));
  kc.watch(2, { endAtMs: end });
  kc.update(0.016);

  const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
  check('the camera looks exactly where the killer was looking',
    near(e.y, YAW) && near(e.x, PITCH),
    `yaw ${e.y.toFixed(2)} want ${YAW}, pitch ${e.x.toFixed(2)} want ${PITCH}`);

  const eye = new THREE.Vector3(7, 1.1 + EYE_ABOVE_CENTRE_STAND, -3);
  const back = cam.position.distanceTo(eye);
  check('and sits behind their head rather than inside it',
    back > 1 && back < 2.2,
    `${back.toFixed(2)} m from the eye`);
  check('and above it, so the shot looks down over the shoulder',
    cam.position.y > eye.y, `camera y ${cam.position.y.toFixed(2)} vs eye ${eye.y.toFixed(2)}`);

  /*
   * The killer must actually be ON SCREEN. This is the check that would have
   * caught the original framing: everything else about it was correct — right
   * position, right orientation, right world state — and the one thing that
   * mattered, being able to see the person who killed you, was not true.
   */
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const toSubject = eye.clone().sub(cam.position).normalize();
  const dot = fwd.dot(toSubject);
  check('and the killer is in front of the camera, not behind it',
    dot > 0.85, `alignment ${dot.toFixed(3)} (1.0 is dead centre)`);

  // Crouching still lowers the whole rig — the difference between seeing over
  // a crate and seeing the crate.
  const cam2 = camera();
  const kc2 = new KillCam({ camera: cam2 });
  const end2 = recorded(kc2, 120, () => ({
    sample: new Map([[2, row(2, 7, -3, { flags: FLAG.CROUCH })]]),
    self: row(1, 0, 0),
  }));
  kc2.watch(2, { endAtMs: end2 });
  kc2.update(0.016);

  const cam3 = camera();
  const kc3 = new KillCam({ camera: cam3 });
  const end3 = recorded(kc3, 120, () => ({
    sample: new Map([[2, row(2, 7, -3)]]),
    self: row(1, 0, 0),
  }));
  kc3.watch(2, { endAtMs: end3 });
  kc3.update(0.016);
  check('a crouching killer is watched from a crouching height',
    near(cam2.position.y, cam3.position.y
      - (EYE_ABOVE_CENTRE_STAND - EYE_ABOVE_CENTRE_CROUCH), 0.02),
    `crouched ${cam2.position.y.toFixed(2)} vs standing ${cam3.position.y.toFixed(2)}`);
}

// ------------------------------------------------------- staying out of walls
{
  /*
   * Pulling the camera back is only safe if something stops it going through
   * whatever the killer had their back to — which, in a shooter, is usually a
   * wall, because that is where people fight from.
   */
  const cam = camera();
  const hits = [];
  const kc = new KillCam({
    camera: cam,
    // A wall 0.6 m behind them.
    clearanceProbe: (ox, oy, oz, dx, dy, dz, max) => { hits.push(max); return 0.6; },
  });
  const end = recorded(kc, 120, () => ({
    sample: new Map([[2, row(2, 7, -3)]]),
    self: row(1, 0, 0),
  }));
  kc.watch(2, { endAtMs: end });
  kc.update(0.016);

  const eye = new THREE.Vector3(7, 1.1 + EYE_ABOVE_CENTRE_STAND, -3);
  const back = cam.position.distanceTo(eye);
  check('a wall behind the killer pulls the camera in instead of through it',
    hits.length > 0 && back < 0.6,
    `probe said 0.6 m, camera sits ${back.toFixed(2)} m back`);

  // With no probe at all it still works — it just cannot avoid geometry.
  const camB = camera();
  const kcB = new KillCam({ camera: camB });
  const endB = recorded(kcB, 120, () => ({
    sample: new Map([[2, row(2, 7, -3)]]),
    self: row(1, 0, 0),
  }));
  kcB.watch(2, { endAtMs: endB });
  kcB.update(0.016);
  check('and with no probe it falls back to the full offset',
    camB.position.distanceTo(eye) > 1,
    `${camB.position.distanceTo(eye).toFixed(2)} m back`);
}

// ------------------------------------------------------------- interpolation
{
  const cam = camera();
  const kc = new KillCam({ camera: cam });
  const end = recorded(kc, 120, (i) => ({
    sample: new Map([[2, row(2, i, 0)]]),        // 1 metre per recorded frame
    self: row(1, 0, 0),
  }));
  kc.watch(2, { endAtMs: end });

  kc.update(0.016);
  const first = cam.position.x;
  // Advance well short of a whole frame; the camera must still move.
  kc.update(0.008);
  const second = cam.position.x;
  check('the camera moves between recorded frames rather than stepping',
    second > first && second - first < 1,
    `${first.toFixed(3)} -> ${second.toFixed(3)} over 8 ms`);
}

// --------------------------------------------------------------- yaw wrapping
{
  const cam = camera();
  const kc = new KillCam({ camera: cam });
  // Turning through the ±π seam. Interpolating naively sends the view spinning
  // all the way round the other way, which is unmissable and very silly.
  const end = recorded(kc, 120, (i) => ({
    sample: new Map([[2, row(2, 0, 0, { yaw: i % 2 ? -3.10 : 3.10 })]]),
    self: row(1, 0, 0),
  }));
  kc.watch(2, { endAtMs: end });

  let worst = 0;
  let prev = null;
  for (let i = 0; i < 60; i++) {
    kc.update(0.016);
    if (!kc.active) break;
    const y = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;
    if (prev !== null) {
      let d = Math.abs(y - prev);
      if (d > Math.PI) d = Math.PI * 2 - d;      // compare on the circle
      worst = Math.max(worst, d);
    }
    prev = y;
  }
  check('turning through the ±π seam does not spin the long way round',
    worst < 0.6, `largest step ${worst.toFixed(3)} rad`);
}

// -------------------------------------------------------------- the timeline
{
  let ended = 0;
  const kc = new KillCam({ camera: camera(), onEnd: () => ended++ });
  const end = recorded(kc, 150, walkTowards);
  kc.watch(2, { endAtMs: end });

  // Recording during playback would overwrite the frames being played.
  const before = kc._count;
  kc.record(new Map([[2, row(2, 99, 99)]]), row(1, 5, 5), end + 500);
  check('recording is suspended while a replay runs',
    kc._count === before, `${before} -> ${kc._count}`);

  let elapsed = 0;
  for (let i = 0; i < 900 && kc.active; i++) { kc.update(1 / 60); elapsed += 1 / 60; }
  check('the replay ends by itself', !kc.active, `after ${elapsed.toFixed(2)}s`);
  check('and says so exactly once', ended === 1, `${ended} callbacks`);

  /*
   * The DEATH SEQUENCE has to fit together: replay, then countdown, then back
   * in the map. Two rules make that hold however the numbers are retuned.
   */
  check('the shortest death still leaves room for the whole countdown',
    near(MATCH_RULES.respawnDelaySec,
      MATCH_RULES.killCamMinSec + MATCH_RULES.respawnCountdownSec, 0.001),
    `floor ${MATCH_RULES.respawnDelaySec}s = ${MATCH_RULES.killCamMinSec}`
    + ` + ${MATCH_RULES.respawnCountdownSec}`);
  check('and the backstop outlasts even the longest one',
    MATCH_RULES.respawnBackstopSec
      > MATCH_RULES.killCamMaxSec + MATCH_RULES.respawnCountdownSec,
    `backstop ${MATCH_RULES.respawnBackstopSec}s vs longest sequence `
    + `${MATCH_RULES.killCamMaxSec + MATCH_RULES.respawnCountdownSec}s`);
}

// ------------------------------------------------------------------- events
{
  const seen = [];
  const kc = new KillCam({ camera: camera(), onEvent: (e) => seen.push(e.tag) });

  // Three shots spread through the run-up, and one far enough back that the
  // replay never reaches it.
  let t = 1000;
  for (let i = 0; i < 200; i++) {
    kc.record(new Map([[2, row(2, 0, 20 - i * 0.1)]]), row(1, 0, 0), t);
    if (i === 5) kc.note({ tag: 'ancient' }, t);
    // The fight starts here, which is what sizes the window — so every shot
    // from this point on has to appear in the replay.
    if (i === 120) { kc.markAggressor(2, t); kc.note({ tag: 'first' }, t); }
    if (i === 160) kc.note({ tag: 'second' }, t);
    if (i === 198) kc.note({ tag: 'killing-shot' }, t);
    t += 34;
  }
  const end = t - 34;
  kc.watch(2, { endAtMs: end });
  for (let i = 0; i < 600 && kc.active; i++) kc.update(1 / 60);

  check('recorded gunfire plays back at the moment it happened',
    seen.includes('first') && seen.includes('second') && seen.includes('killing-shot'),
    seen.join(', ') || 'nothing replayed');
  check('each shot fires exactly once',
    seen.length === new Set(seen).size, `${seen.length} events, ${new Set(seen).size} distinct`);
  check('and shots from before the run-up stay in the past',
    !seen.includes('ancient'),
    seen.includes('ancient') ? 'replayed an event outside the window' : 'correctly skipped');
}

// -------------------------------------------------------------- housekeeping
{
  const cam = camera();
  const kc = new KillCam({ camera: cam });
  const end = recorded(kc, 120, walkTowards);
  kc.watch(2, { endAtMs: end });
  kc.update(0.016);

  kc.stop();
  check('stopping gives the camera back', !kc.active && kc.sample === null,
    `active ${kc.active}`);

  kc.clear();
  check('and clearing drops the whole recording',
    kc._count === 0 && kc.watch(2, { endAtMs: end }) === 0,
    `${kc._count} frames left`);

  /*
   * A ring buffer that wraps must not start serving frames from the future.
   * Recording for longer than it can hold is the normal case in any match
   * lasting more than a few seconds, so this is the path that always runs.
   */
  const wrapped = new KillCam({ camera: camera() });
  let wt = 1000;
  for (let i = 0; i < 900; i++) {           // far more than the buffer holds
    wrapped.record(new Map([[2, row(2, i, 0)]]), row(1, 0, 0), wt);
    wt += 34;
  }
  const wend = wt - 34;
  check('a wrapped buffer still replays', wrapped.watch(2, { endAtMs: wend }) > 0,
    `${wrapped._count} frames held of 900 recorded`);
  wrapped.update(0.016);
  const x = camera() && wrapped._frames[wrapped._head].rows[0].x;
  check('and holds the most recent frames, not the oldest',
    x > 800, `newest recorded x = ${x}`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

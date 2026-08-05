/**
 * The objective marker: which flags get one, and where it goes on screen.
 *
 * WHY THIS IS WORTH A SUITE
 * -------------------------
 * A marker pinned to the WRONG edge of the screen looks completely normal. It
 * is a small correct-looking pill in a plausible place; nothing about a
 * screenshot gives it away. The only symptom is that everybody who follows it
 * runs the opposite way to the flag, and that is indistinguishable from people
 * being bad at the game.
 *
 * The mirroring is the specific hazard. `Vector3.project` returns normalised
 * device coordinates, and a point BEHIND the camera comes back with z > 1 and
 * its x and y negated — so the naive version puts a carrier who is behind your
 * left shoulder off the RIGHT edge of the screen. That is the bug this exists
 * to catch, and it is why `markerScreenPos` is a pure exported function rather
 * than eight lines inside a DOM update loop.
 */

import * as THREE from 'three';
import { markerScreenPos } from '../src/ui/UIManager.js';
import { FlagObjects } from '../src/net/FlagObjects.js';
import { FLAG_STATE, TEAM } from '../src/net/modes.js';
import { ARENAS } from '../src/net/arena.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); } else {
    failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};

/* ------------------------------------------------- where it goes on screen */
console.log('--- the marker lands on the right side of the screen ---');

{
  // Dead ahead, middle of the view.
  const front = markerScreenPos({ x: 0, y: 0, z: 0.5 });
  check('a carrier in front of you is not pinned to an edge',
    !front.edge && Math.abs(front.x) < 0.01, `x=${front.x.toFixed(2)}`);

  // In view, off to the left.
  const left = markerScreenPos({ x: -0.5, y: 0.1, z: 0.5 });
  check('a carrier to your left draws to the left',
    left.x < 0 && !left.edge, `x=${left.x.toFixed(2)}`);

  /*
   * THE ONE THAT MATTERS. Behind you and to your left: `project` reports it
   * mirrored, at POSITIVE x. If the sign is not undone, this pill goes to the
   * right edge and points everyone the wrong way.
   */
  const behindLeft = markerScreenPos({ x: 0.6, y: 0.1, z: 1.4 });
  check('a carrier BEHIND your left shoulder draws to the LEFT edge',
    behindLeft.x < 0 && behindLeft.edge, `x=${behindLeft.x.toFixed(2)}`);

  const behindRight = markerScreenPos({ x: -0.6, y: 0.1, z: 1.4 });
  check('and behind your right shoulder draws to the RIGHT edge',
    behindRight.x > 0 && behindRight.edge, `x=${behindRight.x.toFixed(2)}`);

  // Off the top of the screen but in front.
  const above = markerScreenPos({ x: 0.1, y: 3.0, z: 0.5 });
  check('a carrier above the top of the view is pinned to the top',
    above.edge && above.y > 0.8, `y=${above.y.toFixed(2)}`);

  /*
   * Directly behind, dead centre — x and y are both zero, and pushing a
   * zero-length bearing out to the screen edge divides by its own magnitude.
   */
  const dead = markerScreenPos({ x: 0, y: 0, z: 2.0 });
  check('a carrier directly behind you does not produce NaN',
    Number.isFinite(dead.x) && Number.isFinite(dead.y),
    `x=${dead.x}, y=${dead.y}`);

  // Every result has to stay on screen, or the pill hangs off the edge.
  const extremes = [
    { x: 40, y: -90, z: 0.2 }, { x: -0.001, y: 0.001, z: 8 },
    { x: -12, y: 12, z: 1.001 }, { x: 0.99, y: -0.99, z: 0.99 },
  ].map(markerScreenPos);
  check('nothing is ever placed off the edge of the screen',
    extremes.every((p) => Math.abs(p.x) <= 0.94 && Math.abs(p.y) <= 0.88),
    extremes.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('  '));
}

/* ------------------------------------------------------ which flags get one */
console.log('\n--- only the flags worth marking get a marker ---');

{
  const scene = new THREE.Scene();
  const fo = new FlagObjects(scene, () => null);
  fo.build(ARENAS.lodge, 0);
  fo.selfId = 11;

  const red = fo.flags.get(TEAM.RED);
  const blue = fo.flags.get(TEAM.BLUE);
  const ids = (list) => list.map((m) => m.team).sort().join(',');

  red.state = FLAG_STATE.AT_BASE;
  blue.state = FLAG_STATE.AT_BASE;
  check('two flags safely at base produce nothing',
    fo.markers().length === 0, `${fo.markers().length} markers`);

  red.state = FLAG_STATE.CARRIED;
  red.carrier = 7;
  check('an enemy carrying the red flag gets one',
    ids(fo.markers()) === String(TEAM.RED), ids(fo.markers()));

  /*
   * Our own carried flag must NOT be marked. The camera is inside the body
   * holding it, so the pill would sit permanently in the crosshair.
   */
  red.carrier = fo.selfId;
  check('but the flag WE are carrying does not, it would sit in the crosshair',
    fo.markers().length === 0, `${fo.markers().length} markers`);

  red.carrier = 7;
  blue.state = FLAG_STATE.DROPPED;
  check('a dropped flag gets one too, so it can be found again',
    ids(fo.markers()) === [TEAM.RED, TEAM.BLUE].sort().join(','), ids(fo.markers()));
  check('and it is reported as dropped rather than as a carry',
    fo.markers().find((m) => m.team === TEAM.BLUE)?.carrier === null,
    JSON.stringify(fo.markers().find((m) => m.team === TEAM.BLUE)?.state));

  /*
   * A carrier who has left the interpolation buffer is hidden by `update()`
   * rather than drawn at a stale position. The marker has to follow, or it
   * points at where somebody was when they disconnected.
   */
  red.group.visible = false;
  check('a carrier who has dropped out of the buffer is not marked at a stale spot',
    fo.markers().every((m) => m.team !== TEAM.RED), ids(fo.markers()));

  const m = fo.markers()[0];
  check('markers carry a position the HUD can project',
    m && Number.isFinite(m.pos.x) && Number.isFinite(m.pos.y) && Number.isFinite(m.pos.z),
    m ? `${m.pos.x.toFixed(1)},${m.pos.y.toFixed(1)},${m.pos.z.toFixed(1)}` : 'none');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

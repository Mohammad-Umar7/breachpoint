/**
 * Damage-direction test.
 *
 * The indicator that tells you where you are being shot from was MIRRORED: a
 * shooter on your right painted the arc on your left, and vice versa. Straight
 * ahead and directly behind looked fine, which is exactly why it survived —
 * those are the two bearings where a left/right mirror is invisible.
 *
 * A direction indicator that points the wrong way is worse than not having
 * one, because players act on it and turn into the fire.
 *
 * The cause is a mismatch of conventions that is easy to reintroduce:
 *
 *   - The game's bearing is measured anticlockwise, in radians, 0 = ahead.
 *   - CSS rotate() turns CLOCKWISE.
 *
 * so the angle has to be negated on its way into the transform. This test
 * pins the whole chain — bearing maths through to painted position — at all
 * eight compass points.
 *
 *   node test/damage-direction.mjs
 */

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/**
 * The bearing Game.js computes for a hit, given where both players are.
 * Kept identical to the expression in Game.js `net.onHit`.
 */
function bearingToShooter(player, shooter, yaw) {
  return Math.atan2(shooter.x - player.x, shooter.z - player.z) - (yaw + Math.PI);
}

/**
 * Where UIManager paints the mark, as a screen bearing (0 = up, clockwise).
 *
 * UIManager applies `rotate(-angle)`, and the chevron is authored directly
 * ABOVE the origin, so the painted position is that offset run through the
 * rotation matrix.
 */
function paintedScreenBearing(angleRad) {
  const css = -angleRad;                       // the negation under test
  // CSS rotate(t): x' = x cos t - y sin t, y' = x sin t + y cos t, +y is DOWN.
  const local = { x: 0, y: -360 };
  const px = local.x * Math.cos(css) - local.y * Math.sin(css);
  const py = local.x * Math.sin(css) + local.y * Math.cos(css);
  return Math.atan2(px, -py);                  // 0 = up, clockwise
}

const NAMES = ['ahead', 'front-right', 'right', 'back-right',
  'behind', 'back-left', 'left', 'front-left'];

console.log('shooter bearing vs where the mark is painted\n');
let worst = 0;

// Checked from several player headings, because a sign error can hide at yaw 0.
for (const yaw of [0, 0.9, -2.1, Math.PI]) {
  for (let i = 0; i < 8; i++) {
    const bearing = (i / 8) * Math.PI * 2;
    const player = { x: 4, z: -7 };
    /*
     * Place the shooter at that bearing relative to the player's heading.
     *
     * The player's forward is (-sin yaw, -cos yaw) and their right is
     * (cos yaw, -sin yaw), so a target at bearing t (clockwise from straight
     * ahead) sits at:
     *
     *     x = px + d * sin(t - yaw)
     *     z = pz - d * cos(t - yaw)
     *
     * Note it is MINUS yaw. Both signs here are easy to get backwards and
     * neither shows up at yaw 0, because sin(0) is 0 — which is why the
     * headings below are swept rather than assumed.
     */
    const world = bearing - yaw;
    const shooter = { x: player.x + Math.sin(world) * 5, z: player.z - Math.cos(world) * 5 };

    const angle = bearingToShooter(player, shooter, yaw);
    const painted = paintedScreenBearing(angle);

    let err = ((painted - bearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    err = Math.abs(err * 180 / Math.PI);
    worst = Math.max(worst, err);

    if (yaw === 0) {
      console.log(`  shooter ${NAMES[i].padEnd(12)} -> mark at `
        + `${String(Math.round(((painted * 180 / Math.PI) + 360) % 360)).padStart(3)} deg  `
        + `(want ${String(Math.round(bearing * 180 / Math.PI)).padStart(3)})  err ${err.toFixed(1)}`);
    }
  }
}

console.log('');
check('every direction paints where the shooter actually is', worst < 0.5,
  `worst error ${worst.toFixed(2)} deg across 8 bearings x 4 player headings`);

// The specific regression: right must not read as left.
const player = { x: 0, z: 0 };
const right = paintedScreenBearing(bearingToShooter(player, { x: 5, z: 0 }, 0));
const left = paintedScreenBearing(bearingToShooter(player, { x: -5, z: 0 }, 0));
check('a shooter on the RIGHT paints on the right', Math.sin(right) > 0.9,
  `screen x ${Math.sin(right).toFixed(2)}`);
check('a shooter on the LEFT paints on the left', Math.sin(left) < -0.9,
  `screen x ${Math.sin(left).toFixed(2)}`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

/**
 * Damage falloff test.
 *
 * The server owns damage and, until this was fixed, applied it FLAT: every
 * weapon carries falloffStart, falloffEnd and falloffMinScale, the client had
 * always modelled them, and the server ignored all three. A shotgun hit as
 * hard across the map as it did point blank.
 *
 * This exercises the curve directly rather than over a socket. The end-to-end
 * path is covered by server/damage-range-test.js, but driving a live server to
 * a chosen range is inherently timing-sensitive — the server validates
 * movement and rewinds for lag compensation, both correctly — so the exact
 * numbers are pinned here where they are deterministic.
 *
 *   node test/damage-falloff.mjs
 */
import { damageFor } from '../src/net/protocol.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';
import { PLAYER_MAX_HEALTH } from '../src/net/protocol.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const byId = (id) => WEAPON_DEFS.find((w) => w.id === id);
const shotgun = byId('shotgun');
const rifle = byId('rifle');
const sniper = byId('sniper');

// --- the curve itself ------------------------------------------------------
console.log('shotgun damage per pellet by range\n');
for (const d of [0, 5, 9, 15, 20, 30, 45]) {
  const dmg = damageFor(shotgun, 'torso', d);
  console.log(`  ${String(d).padStart(2)} m  ${dmg.toFixed(1).padStart(5)} per pellet`
    + `  ->  ${(dmg * shotgun.pellets).toFixed(0).padStart(3)} for the full spread`);
}

check('full damage inside falloffStart',
  Math.abs(damageFor(shotgun, 'torso', shotgun.falloffStart - 1) - shotgun.damage) < 0.01,
  `${damageFor(shotgun, 'torso', 0).toFixed(1)} at point blank`);

check('minimum damage past falloffEnd',
  Math.abs(damageFor(shotgun, 'torso', shotgun.falloffEnd + 10)
    - shotgun.damage * shotgun.falloffMinScale) < 0.01,
  `${damageFor(shotgun, 'torso', 45).toFixed(1)} per pellet`);

const mid = (shotgun.falloffStart + shotgun.falloffEnd) / 2;
const midExpected = shotgun.damage * (1 + (shotgun.falloffMinScale - 1) * 0.5);
check('halfway between is halfway down', Math.abs(damageFor(shotgun, 'torso', mid) - midExpected) < 0.01,
  `${damageFor(shotgun, 'torso', mid).toFixed(1)} at ${mid} m`);

check('damage never increases with distance',
  Array.from({ length: 60 }, (_, i) => damageFor(shotgun, 'torso', i))
    .every((v, i, arr) => i === 0 || v <= arr[i - 1] + 1e-9));

// --- what it means in a fight ----------------------------------------------
console.log('');
const closeSpread = damageFor(shotgun, 'torso', 3) * shotgun.pellets;
const farSpread = damageFor(shotgun, 'torso', 34) * shotgun.pellets;
check('a point-blank shotgun takes over half the health bar',
  closeSpread >= PLAYER_MAX_HEALTH * 0.5,
  `${closeSpread.toFixed(0)} of ${PLAYER_MAX_HEALTH}`);
check('a distant shotgun is a chip hit', farSpread <= PLAYER_MAX_HEALTH * 0.25,
  `${farSpread.toFixed(0)} of ${PLAYER_MAX_HEALTH}`);
check('close is at least three times far', closeSpread / farSpread >= 3,
  `${(closeSpread / farSpread).toFixed(1)}x`);

// --- other weapons keep their character -------------------------------------
console.log('');
check('a rifle stays effective at range',
  damageFor(rifle, 'torso', 60) >= rifle.damage * 0.7,
  `${damageFor(rifle, 'torso', 60).toFixed(1)} of ${rifle.damage} at 60 m`);
check('a sniper barely falls off at all',
  damageFor(sniper, 'torso', 80) >= sniper.damage * 0.85,
  `${damageFor(sniper, 'torso', 80).toFixed(1)} of ${sniper.damage} at 80 m`);

// --- part multipliers still apply, and compose with range -------------------
console.log('');
check('headshots multiply on top of falloff',
  Math.abs(damageFor(rifle, 'head', 60) - damageFor(rifle, 'torso', 60) * rifle.headMul) < 0.01,
  `${damageFor(rifle, 'head', 60).toFixed(1)} vs torso ${damageFor(rifle, 'torso', 60).toFixed(1)}`);
check('limb hits reduce on top of falloff',
  Math.abs(damageFor(rifle, 'limb', 60) - damageFor(rifle, 'torso', 60) * rifle.limbMul) < 0.01);
check('omitting the distance applies no falloff',
  Math.abs(damageFor(rifle, 'torso') - rifle.damage) < 0.01,
  'so a weapon with no range information is unaffected');

// --- every weapon is sane ---------------------------------------------------
console.log('');
// Throwables are excluded on purpose: their curve models a BLAST RADIUS, so
// reaching exactly zero past falloffEnd is correct rather than broken.
const broken = WEAPON_DEFS.filter((w) => {
  if (w.melee || w.throwable || !(w.damage > 0)) return false;
  const near = damageFor(w, 'torso', 0);
  const far = damageFor(w, 'torso', 200);
  return !(Number.isFinite(near) && Number.isFinite(far) && far <= near && far > 0);
});
check('every weapon has a sane falloff curve', broken.length === 0,
  broken.map((w) => w.id).join(', ') || `${WEAPON_DEFS.length} checked`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

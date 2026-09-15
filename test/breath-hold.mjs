/**
 * Breath hold — the scoped rifle's steadying mechanic.
 *
 * The case that matters is the one nobody tests by hand: keeping Shift down
 * AFTER the lungs run out. Without hysteresis the meter sat on the threshold
 * and the hold flapped every other frame, playing breathIn and breathOut in a
 * gasping loop for as long as the key stayed down.
 *
 * ADSSystem imports three.js for a Vector2, which loads fine in node.
 *
 *   node test/breath-hold.mjs
 */
import { ADSSystem } from '../src/weapons/ADSSystem.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const played = [];
const audio = { play: (name) => played.push(name) };
const settings = { get: (k) => ({ aimMode: 'hold' })[k] };
const input = { mouseWasPressed: () => false, isMouseDown: () => true };
const sniper = {
  def: {
    adsTime: 0.2,
    optic: { scoped: true, breathHold: true, holdDuration: 3.5, holdRecovery: 5, swayAmplitude: 0.01 },
  },
};

const ads = new ADSSystem(settings, input, audio);
const dt = 1 / 60;

// Shoulder the rifle fully so the scope is engaged.
for (let i = 0; i < 120; i++) ads.update(dt, sniper, true, { holdBreathPressed: false, moving: 0 });
check('the scope is engaged before the test starts', ads.scopeProgress > 0.9, ads.scopeProgress.toFixed(2));

// Hold Shift for twelve seconds straight: 3.5 s of breath, then 8.5 s of
// somebody still leaning on the key with empty lungs.
played.length = 0;
for (let i = 0; i < 12 * 60; i++) ads.update(dt, sniper, true, { holdBreathPressed: true, moving: 0 });

const ins = played.filter((n) => n === 'breathIn').length;
const outs = played.filter((n) => n === 'breathOut').length;
check('one breath in for one press of the key', ins === 1, `${ins} breathIn`);
check('one breath out when the lungs run dry', outs === 1, `${outs} breathOut`);
check('the hold is released once the breath is spent', ads.holding === false);
check('the system remembers it is winded', ads.winded === true);

// Let go for a moment, then press again before recovery: still refused.
for (let i = 0; i < 30; i++) ads.update(dt, sniper, true, { holdBreathPressed: false, moving: 0 });
played.length = 0;
for (let i = 0; i < 30; i++) ads.update(dt, sniper, true, { holdBreathPressed: true, moving: 0 });
check('a hold asked for before recovering is refused silently',
  played.length === 0 && ads.holding === false, `${played.length} sounds`);

// Recover fully, then the hold works again.
for (let i = 0; i < 6 * 60; i++) ads.update(dt, sniper, true, { holdBreathPressed: false, moving: 0 });
check('breath recovers while the key is up', ads.breath > 0.9 && ads.winded === false,
  ads.breath.toFixed(2));
played.length = 0;
for (let i = 0; i < 30; i++) ads.update(dt, sniper, true, { holdBreathPressed: true, moving: 0 });
check('a fresh hold after recovering is honoured',
  ads.holding === true && played.filter((n) => n === 'breathIn').length === 1);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

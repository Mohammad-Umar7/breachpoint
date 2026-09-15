/**
 * Saved-settings hygiene.
 *
 * localStorage is writable by anyone with dev tools and by every older build
 * of this game, so what comes back out of it is INPUT, not state. A value the
 * sliders could never have produced must be pulled back into range rather
 * than handed to the systems that read it: a sensitivity of 0 is a mouse that
 * does nothing, and a FOV of 0 is a camera that renders nothing — neither can
 * be fixed from a settings screen the player cannot aim at.
 *
 *   node test/settings.mjs
 */
import { DEFAULT_SETTINGS, sanitizeSetting } from '../src/core/Settings.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

console.log('numbers are clamped to their slider\n');
check('sensitivity 0 comes back to the slider floor', sanitizeSetting('sensitivity', 0) === 0.1);
check('sensitivity 99 comes back to the slider ceiling', sanitizeSetting('sensitivity', 99) === 5);
check('fov 0 cannot reach the camera', sanitizeSetting('fov', 0) === 60);
check('fov 400 cannot reach the camera', sanitizeSetting('fov', 400) === 120);
check('a value inside its range is untouched', sanitizeSetting('fov', 95) === 95);
check('render scale above 1 is capped', sanitizeSetting('renderScale', 4) === 1);
check('a negative volume is silenced, not inverted', sanitizeSetting('masterVolume', -1) === 0);
check('NaN is refused outright', sanitizeSetting('exposure', NaN) === undefined);
check('Infinity is refused outright', sanitizeSetting('maxFps', Infinity) === undefined);
check('a number where a string belongs is refused', sanitizeSetting('quality', 3) === undefined);
check('a string where a number belongs is refused', sanitizeSetting('fov', '90') === undefined);

console.log('\nwords have to be one of the words\n');
check('an unknown quality preset is refused', sanitizeSetting('quality', 'insane') === undefined);
check('a known quality preset passes', sanitizeSetting('quality', 'low') === 'low');
check('an unknown shadow level is refused', sanitizeSetting('shadowQuality', 'extreme') === undefined);
check('an unknown aim mode is refused', sanitizeSetting('aimMode', 'sometimes') === undefined);
check('free text like a callsign passes through', sanitizeSetting('playerName', 'GHOST') === 'GHOST');
check('a boolean passes through', sanitizeSetting('vsync', false) === false);
check('a missing key is undefined, not the default', sanitizeSetting('vsync', undefined) === undefined);

// Every shipped default must survive its own sanitiser, or a fresh install
// would be "corrected" on the first load.
const mangled = Object.entries(DEFAULT_SETTINGS)
  .filter(([k, v]) => sanitizeSetting(k, v) !== v)
  .map(([k]) => k);
check('every default is inside its own range', mangled.length === 0,
  mangled.join(', ') || `${Object.keys(DEFAULT_SETTINGS).length} defaults checked`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

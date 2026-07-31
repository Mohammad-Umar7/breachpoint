/**
 * Frame-rate stability test.
 *
 * Reproduces "when he tried to shoot, the whole screen went crazy, spinning".
 *
 * Recoil and weapon kick are springs, integrated with explicit Euler:
 *
 *     vel += (-x * stiffness - vel * damping) * dt
 *     x   += vel * dt
 *
 * That is only stable while `damping * dt < 2`. Past it the damping term
 * overshoots zero and flips the velocity's sign with a magnitude GREATER than
 * it started with, so each frame amplifies the last and the value explodes
 * within a few frames. Camera recoil is added straight onto the player's aim,
 * so an exploding recoil spring is literally a spinning view.
 *
 * With damping 26 the limit is dt = 2/26 = 77 ms, i.e. about 13 fps. A weak
 * laptop hits that easily the moment it starts firing — muzzle flash, particles
 * and audio all land on the same frame — which is why it happened on shooting
 * and to one player rather than another.
 *
 * The fix is to sub-step the integration, so a long frame is integrated as
 * several short ones and the spring never sees a dt it cannot handle.
 *
 *   node test/framerate-stability.mjs
 */
import { RecoilSystem } from '../src/weapons/RecoilSystem.js';
import { WEAPON_DEFS } from '../src/weapons/WeaponDefinitions.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const settings = { get: (k) => (k === 'recoilScale' ? 1 : 1) };
const rifle = WEAPON_DEFS.find((w) => w.id === 'rifle') ?? WEAPON_DEFS[0];

/**
 * Fire a burst, then let the springs settle, at a fixed frame time.
 * @returns {{peakPitch: number, peakKick: number, finite: boolean}}
 */
function simulate(fps, seconds = 3) {
  const dt = 1 / fps;
  const r = new RecoilSystem(settings);
  let peakPitch = 0, peakKick = 0, finite = true;

  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) {
    // Hold the trigger for the first second.
    if (i * dt < 1.0 && i % Math.max(1, Math.round(0.1 / dt)) === 0) r.fire(rifle, {});
    r.update(dt);

    const pitch = Math.abs(r.currentPitch);
    const kick = Math.abs(r.kickZ) + Math.abs(r.kickPitch);
    if (!Number.isFinite(pitch) || !Number.isFinite(kick)) { finite = false; break; }
    peakPitch = Math.max(peakPitch, pitch);
    peakKick = Math.max(peakKick, kick);
  }
  return { peakPitch, peakKick, finite };
}

// A rifle's recoil pattern climbs a few degrees. Anything beyond a quarter
// turn is the spring diverging, not the weapon kicking.
const SANE_PITCH = 0.8;   // radians (~46 degrees)
const SANE_KICK = 2.0;

console.log('firing a rifle for one second, then settling, at each frame rate\n');
const rows = [];
for (const fps of [144, 60, 30, 20, 15, 12, 10, 8, 6]) {
  const r = simulate(fps);
  rows.push({ fps, ...r });
  const ok = r.finite && r.peakPitch < SANE_PITCH && r.peakKick < SANE_KICK;
  console.log(
    `${String(fps).padStart(4)} fps (dt ${(1000 / fps).toFixed(0).padStart(3)} ms)  `
    + `peak recoil ${r.finite ? r.peakPitch.toFixed(3).padStart(9) : '  INFINITE'} rad  `
    + `peak kick ${r.finite ? r.peakKick.toFixed(3).padStart(9) : '  INFINITE'}  `
    + `${ok ? 'ok' : '<-- BLOWS UP'}`,
  );
}

console.log('');
for (const r of rows) {
  check(`stable at ${r.fps} fps`,
    r.finite && r.peakPitch < SANE_PITCH && r.peakKick < SANE_KICK,
    r.finite ? `peak ${r.peakPitch.toFixed(2)} rad` : 'diverged to infinity');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

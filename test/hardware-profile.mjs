/**
 * Quality auto-detection test.
 *
 * The renderer strings below are the real ones these machines report through
 * WEBGL_debug_renderer_info, so this checks the decision the game will actually
 * make rather than a paraphrase of it.
 *
 * What matters most: a laptop with integrated graphics must not start on High.
 * That is the common case for a browser game, and it is where the frame rate
 * gets low enough to be unpleasant.
 *
 *   node test/hardware-profile.mjs
 */
import { detectQuality, PerformanceGovernor } from '../src/core/HardwareProfile.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const MACHINES = [
  // --- should NOT start on high ------------------------------------------
  { label: 'Intel UHD laptop', expect: ['low', 'medium'], cores: 4, memory: 8,
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { label: 'Intel HD Graphics 4000', expect: ['low', 'medium'], cores: 4, memory: 4,
    renderer: 'ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { label: 'Intel Iris Plus', expect: ['low', 'medium'], cores: 4, memory: 8,
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { label: 'software rasteriser', expect: ['low'], cores: 8, memory: 8,
    renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' },
  { label: 'llvmpipe (no GPU driver)', expect: ['low'], cores: 8, memory: 8,
    renderer: 'Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)' },
  { label: 'dual-core netbook', expect: ['low'], cores: 2, memory: 4,
    renderer: 'ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { label: 'low-memory device', expect: ['low'], cores: 8, memory: 2,
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, D3D11)' },
  { label: 'Android phone (Adreno)', expect: ['low', 'medium'], cores: 8, memory: 4,
    renderer: 'Adreno (TM) 640' },
  { label: 'masked renderer, 4 cores', expect: ['medium'], cores: 4, memory: 8, renderer: null },

  // --- should start on high ----------------------------------------------
  { label: 'RTX 4070 laptop', expect: ['high'], cores: 16, memory: 16,
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU, D3D11)' },
  { label: 'Radeon RX 6700', expect: ['high'], cores: 12, memory: 16,
    renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { label: 'Apple M2', expect: ['high'], cores: 8, memory: 16, renderer: 'Apple M2' },
  { label: 'Intel Iris Xe (capable integrated)', expect: ['high', 'medium'], cores: 8, memory: 16,
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

console.log('quality chosen on a first run\n');
for (const m of MACHINES) {
  const got = detectQuality({ renderer: m.renderer, cores: m.cores, memory: m.memory });
  check(`${m.label} -> ${got.quality}`, m.expect.includes(got.quality),
    `${got.reason}${m.expect.includes(got.quality) ? '' : `, expected one of ${m.expect.join('/')}`}`);
}

// A laptop with integrated graphics must never be handed High. This is the
// case the whole feature exists for.
const integrated = MACHINES.filter((m) => /intel|adreno|mali|swiftshader|llvmpipe/i.test(m.renderer ?? ''))
  .filter((m) => !/iris xe/i.test(m.renderer ?? ''));
const anyHigh = integrated.filter((m) =>
  detectQuality({ renderer: m.renderer, cores: m.cores, memory: m.memory }).quality === 'high');
check('no integrated-graphics machine starts on high', anyHigh.length === 0,
  anyHigh.map((m) => m.label).join(', ') || `${integrated.length} checked`);

// --- the governor ---------------------------------------------------------
console.log('\nperformance governor');
function governorRun(fps, seconds = 40) {
  const values = { quality: 'high' };
  const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; } };
  const gov = new PerformanceGovernor(settings);
  const dt = 1 / fps;
  for (let i = 0; i < seconds / dt; i++) gov.update(dt);
  return { quality: values.quality, drops: gov.drops };
}
const struggling = governorRun(22);
check('a machine stuck at 22 fps gets stepped down', struggling.quality !== 'high',
  `high -> ${struggling.quality} after ${struggling.drops} step(s)`);
check('it stops stepping rather than falling to the floor', struggling.drops <= 2,
  `${struggling.drops} steps`);
const healthy = governorRun(90);
check('a machine running at 90 fps is left alone', healthy.quality === 'high' && healthy.drops === 0);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

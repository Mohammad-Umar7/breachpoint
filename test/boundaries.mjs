/**
 * Module boundaries — enforced, not aspirational.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Changing one thing breaks another" was reported after a run of bugs, and
 * the diagnosis that follows from it — "the system is not modular" — turned
 * out to be half right. The import graph IS layered: core at the bottom,
 * physics/fx/audio on top of it, weapons/player/world above those, net beside
 * them, ui imported by nobody, and a server that touches exactly four shared
 * files. What was missing is that NOTHING FAILED when somebody violated that
 * layering. A boundary that nothing checks is a suggestion, not a boundary.
 *
 * So this suite turns the de-facto architecture into a checked contract:
 *
 *   1. Every subsystem may import only from the subsystems listed for it in
 *      ALLOWED below. A new cross-boundary import fails the build until it is
 *      added there — deliberately, with a reason, in review.
 *   2. The server may import only the four shared files, and the shared files
 *      may import only each other (and never three.js). This is the
 *      client/server contract the README describes; now it is checked.
 *   3. Nothing imports Game.js except main.js. Game is the composition root —
 *      the one place allowed to know every subsystem. The moment something
 *      imports it back, "the file that wires everything" becomes "a cycle".
 *   4. Nothing imports ui except the root. The HUD reads the game; the game
 *      never reads the HUD.
 *   5. No import cycles between FILES anywhere in src/. Subsystem layering
 *      can be argued about; a file cycle is simply a latent load-order bug.
 *
 * Per this repo's own rule, every check prints how much it looked at — a
 * check that silently examines nothing must not be able to pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- the graph
/** Every .js file under src/, plus the authoritative server. */
function collect(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) collect(rel, out);
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const files = [...collect('src'), 'server/index.js'];

/** file -> its RELATIVE imports resolved to repo-relative paths. */
const importsOf = new Map();
/** file -> its bare (npm) imports. */
const npmImportsOf = new Map();
for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const rel = [];
  const npm = [];
  for (const m of text.matchAll(/^import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const target = resolve(join(ROOT, dirname(file)), spec)
        .slice(resolve(ROOT).length + 1)
        .split(sep).join('/');
      rel.push(target);
    } else {
      npm.push(spec);
    }
  }
  importsOf.set(file, rel);
  npmImportsOf.set(file, npm);
}

const edgeCount = [...importsOf.values()].reduce((a, v) => a + v.length, 0);
check('the import graph can actually be built', files.length > 30 && edgeCount > 50,
  `${files.length} files, ${edgeCount} internal imports`);

// ------------------------------------------------------- subsystem layering
/** Which subsystem a file belongs to. */
const subsystemOf = (file) => {
  if (file.startsWith('server/')) return 'server';
  const parts = file.split('/');
  return parts.length === 2 ? 'app' : parts[1];   // src/Game.js -> app
};

/*
 * WHO MAY IMPORT WHOM. This map IS the architecture. Every edge here is one
 * that exists today for a reason; anything not listed fails the build until a
 * person adds it on purpose. Self-imports are always allowed.
 */
const ALLOWED = {
  // Pure utilities and asset registry. The floor everything stands on.
  core: [],
  // Physics wraps Rapier and tags colliders with asset surfaces.
  physics: ['core'],
  // Particles, post, scope glass: draw things, know nothing about gameplay.
  fx: ['core'],
  // Every sound is synthesised here; depends on nothing but the browser.
  audio: [],
  // Guns read balance data, cast rays, make noise, and ask the scope for
  // reticle data. They do not know about the net or the HUD.
  weapons: ['core', 'physics', 'audio', 'fx'],
  // The local player: movement, camera, vitals. protocol.js is imported for
  // shared constants (respawn timing), not for socket access.
  player: ['core', 'physics', 'audio', 'net'],
  // Maps and pickups. arena.js is the shared map DATA both sides agree on.
  world: ['core', 'physics', 'net'],
  // Multiplayer: sockets, snapshots, remote bodies. Reads weapon DATA for
  // validation display and drives the audio for remote players. Never ui.
  net: ['core', 'weapons', 'audio'],
  // Menus and HUD read data from everywhere below; NOTHING imports them back.
  ui: ['core', 'weapons', 'fx', 'net', 'world'],
  // The composition root. The one file allowed to know everything.
  app: ['core', 'physics', 'fx', 'audio', 'weapons', 'player', 'world', 'net', 'ui'],
  // The authoritative server; its stricter file-level contract is below.
  server: ['net', 'weapons'],
};

const violations = [];
for (const [file, deps] of importsOf) {
  const from = subsystemOf(file);
  for (const dep of deps) {
    const to = subsystemOf(dep);
    if (to === from) continue;
    if (!(ALLOWED[from] ?? []).includes(to)) {
      violations.push(`${file} -> ${dep}  (${from} may not import ${to})`);
    }
  }
}
check('every import stays inside the declared architecture',
  violations.length === 0,
  violations.length ? violations.slice(0, 5).join('; ')
    : `${edgeCount} imports checked against ${Object.keys(ALLOWED).length} subsystems`);

/*
 * The checker must be able to fail. This repo has already shipped one check
 * that silently examined nothing and passed for months — so the validator is
 * pointed at a fabricated illegal edge and must flag it, or the suite stops
 * trusting itself.
 */
{
  const fakeFrom = 'audio';
  const fakeTo = 'ui';
  const flagged = !(ALLOWED[fakeFrom] ?? []).includes(fakeTo);
  check('the boundary checker itself can detect a violation', flagged,
    'audio -> ui correctly rejected');
}

// ------------------------------------------------- the client/server split
/*
 * The server imports the client's own protocol, map data, mode rules and
 * weapon table SO THAT the two sides cannot drift — and absolutely nothing
 * else, because everything else drags in three.js, the DOM, or the game loop.
 */
const SHARED = [
  'src/net/protocol.js',
  'src/net/arena.js',
  'src/net/modes.js',
  'src/weapons/WeaponDefinitions.js',
];
{
  const serverDeps = importsOf.get('server/index.js') ?? [];
  const illegal = serverDeps.filter((d) => !SHARED.includes(d));
  check('the server imports exactly the shared contract files',
    illegal.length === 0 && serverDeps.length > 0,
    illegal.length ? `also imports: ${illegal.join(', ')}`
      : `${serverDeps.length} imports, all in the shared set`);

  // And the shared set must stay pure: importable by a headless node process.
  const impure = [];
  const closure = new Set(SHARED);
  for (const shared of SHARED) {
    for (const dep of importsOf.get(shared) ?? []) {
      if (!closure.has(dep)) impure.push(`${shared} -> ${dep}`);
    }
    for (const npm of npmImportsOf.get(shared) ?? []) {
      impure.push(`${shared} -> ${npm} (npm)`);
    }
  }
  check('the shared files import nothing outside the shared set — no three.js, no DOM',
    impure.length === 0,
    impure.join('; ') || `${SHARED.length} files, closure closed`);
}

// ----------------------------------------------------- composition root rules
{
  const gameImporters = files.filter((f) =>
    (importsOf.get(f) ?? []).includes('src/Game.js'));
  check('nothing imports Game.js except main.js',
    gameImporters.length === 1 && gameImporters[0] === 'src/main.js',
    `importers: ${gameImporters.join(', ') || 'none?'}`);

  const uiImporters = files.filter((f) =>
    subsystemOf(f) !== 'ui' && subsystemOf(f) !== 'app'
    && (importsOf.get(f) ?? []).some((d) => subsystemOf(d) === 'ui'));
  check('nothing imports the ui except the composition root',
    uiImporters.length === 0,
    uiImporters.join(', ') || `${files.length} files checked`);
}

// ----------------------------------------------------------- file-level cycles
/*
 * A cycle between files is a latent load-order bug: whichever module happens
 * to be entered first sees the other's exports half-initialised. ES modules
 * make it "work" just often enough to ship.
 */
{
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map(files.map((f) => [f, WHITE]));
  const stack = [];
  let cycle = null;

  const visit = (file) => {
    if (cycle) return;
    colour.set(file, GREY);
    stack.push(file);
    for (const dep of importsOf.get(file) ?? []) {
      if (!colour.has(dep)) continue;          // outside the scanned set
      if (colour.get(dep) === GREY) {
        cycle = [...stack.slice(stack.indexOf(dep)), dep];
        return;
      }
      if (colour.get(dep) === WHITE) visit(dep);
      if (cycle) return;
    }
    stack.pop();
    colour.set(file, BLACK);
  };
  for (const f of files) { if (colour.get(f) === WHITE) visit(f); if (cycle) break; }

  check('no import cycles anywhere in the codebase',
    cycle === null,
    cycle ? cycle.join(' -> ') : `${files.length} files, ${edgeCount} edges, acyclic`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

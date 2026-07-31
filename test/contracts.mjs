/**
 * Contract tests — the cross-file promises nothing else enforces.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most of this codebase is joined together by NAMES, not by imports: a DOM id
 * in a string, a sound looked up by name, a weapon pointing at a model id, a
 * message type the server sends and the client switches on. None of that is
 * checked by the build. Rename an element in index.html and the JS carries on
 * compiling perfectly, then hands you a null at runtime — maybe immediately,
 * maybe only when somebody opens the settings menu three screens in.
 *
 * That is the "I changed one thing and something far away broke, silently"
 * problem, and the fix is not to be more careful. It is to make every one of
 * those promises checkable, and check them all in a second.
 *
 * Everything here reads the SOURCE rather than importing it, because most of
 * these files need a browser to import at all. Crude, but it means a contract
 * can be checked without booting a renderer.
 *
 *   node test/contracts.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/** Every .js under a directory, recursively. */
function sources(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SRC = sources('src');
const ALL_SRC = SRC.map((f) => ({ file: f, text: read(f) }));
const HTML = read('index.html');

/** Every distinct capture of `re` across the source tree, with its file. */
function collect(re, files = ALL_SRC) {
  const found = new Map();
  for (const { file, text } of files) {
    for (const m of text.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

console.log('\n--- the DOM ---');

/*
 * Every id the JS looks up must exist in the markup.
 *
 * This is the biggest silent-failure surface in the project: 70-odd ids
 * spelled out in strings, none of them checked by anything.
 */
const usedIds = collect(/\bid\('([a-zA-Z0-9-]+)'\)/g);
const htmlIds = new Set([...HTML.matchAll(/\bid="([a-zA-Z0-9-]+)"/g)].map((m) => m[1]));
const missingIds = [...usedIds].filter(([id]) => !htmlIds.has(id));
check('every element id used in JS exists in index.html',
  missingIds.length === 0,
  missingIds.length ? missingIds.map(([id, f]) => `${id} (${f})`).join(', ')
                    : `${usedIds.size} ids checked`);

// Screens are switched by id too, and a typo just shows a blank page.
const screenIds = collect(/showScreen\('([a-zA-Z0-9-]+)'\)/g);
const badScreens = [...screenIds].filter(([id]) => !htmlIds.has(id));
check('every screen switched to exists', badScreens.length === 0,
  badScreens.length ? badScreens.map(([id]) => id).join(', ') : `${screenIds.size} screens`);

// And the list a MenuManager uses to hide the others has to agree with reality.
const screenList = read('src/ui/MenuManager.js')
  .match(/const SCREENS = \[([\s\S]*?)\];/)?.[1] ?? '';
const listed = [...screenList.matchAll(/'([a-zA-Z0-9-]+)'/g)].map((m) => m[1]);
const staleListed = listed.filter((id) => !htmlIds.has(id));
check('the screen list has no entries the markup dropped',
  staleListed.length === 0, staleListed.join(', ') || `${listed.length} listed`);

console.log('\n--- audio ---');

/*
 * A sound is played by name and resolved at runtime; a typo warns to the
 * console and plays silence, which is easy to never notice.
 */
const audioSrc = read('src/audio/AudioManager.js');
const synths = new Set([...audioSrc.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*)\(a, /gm)].map((m) => m[1]));
const playedNames = collect(/(?:audio|this\.audio)\.play\('([a-zA-Z][a-zA-Z0-9]*)'/g);
const missingSounds = [...playedNames].filter(([n]) => !synths.has(n));
check('every sound played has a synth to play it',
  missingSounds.length === 0,
  missingSounds.length ? missingSounds.map(([n, f]) => `${n} (${f})`).join(', ')
                       : `${playedNames.size} names checked against ${synths.size} synths`);

/*
 * Weapon definitions name their own sounds, and nothing checks those either.
 * Reload audio is a TIMELINE — `reloadSounds: [[0.05, 'magOut'], ...]` — so the
 * names have to be read out of the pairs, not off a `reloadSound:` key. Missing
 * that is how the sample list ended up asking for a 'reload' file that no
 * weapon has ever named.
 */
const weaponSrc = read('src/weapons/WeaponDefinitions.js');
const defSounds = new Set([
  ...[...weaponSrc.matchAll(/(?:fire|switch|empty)Sound: '([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
  ...[...weaponSrc.matchAll(/\[\s*[\d.]+\s*,\s*'([a-zA-Z0-9]+)'\s*\]/g)].map((m) => m[1]),
]);
const missingDefSounds = [...defSounds].filter((n) => !synths.has(n));
check('every sound named by a weapon definition exists',
  missingDefSounds.length === 0, missingDefSounds.join(', ') || `${defSounds.size} checked`);

// Samples are optional downloads that REPLACE a synth, so a name with no synth
// behind it would be silent whenever the download failed.
const sampleList = read('src/Game.js').match(/loadSamples\?\.\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
const samples = [...sampleList.matchAll(/'([a-zA-Z0-9]+)'/g)].map((m) => m[1]);
const orphanSamples = samples.filter((n) => !synths.has(n));
check('every requested audio sample has a synth to fall back on',
  orphanSamples.length === 0, orphanSamples.join(', ') || `${samples.length} samples`);

console.log('\n--- weapons ---');

const assetSrc = read('src/core/AssetManager.js');
const modelIds = new Set([...assetSrc.matchAll(/\{ id: '([a-zA-Z0-9]+)', url:/g)].map((m) => m[1]));
const usedModels = [...weaponSrc.matchAll(/modelId: '([a-zA-Z0-9]+)'/g)].map((m) => m[1]);
const missingModels = [...new Set(usedModels)].filter((m) => !modelIds.has(m));
check('every weapon resolves to a model that is actually loaded',
  missingModels.length === 0, missingModels.join(', ') || `${new Set(usedModels).size} models`);

/*
 * Fields the damage maths reads without guarding. A weapon added without one
 * of these does not crash — it silently produces NaN damage, which the server
 * then clamps to something arbitrary.
 */
/*
 * Fields the damage maths reads without guarding. A weapon missing one does
 * not crash — it silently produces NaN damage, which the server then clamps to
 * something arbitrary.
 *
 * Split on the `  {` that opens each entry, tolerating either line ending: the
 * first version of this matched "\n  {\n", found nothing at all in a CRLF
 * file, and passed having examined zero weapons. A check that silently
 * examines nothing is worse than no check, because it reads as a green tick —
 * hence the separate assertion that the parse found anything.
 */
const entriesOf = (text) => text.split(/\r?\n {2}\{\r?\n/).slice(1)
  .map((b) => ({ id: b.match(/id: '([a-zA-Z0-9]+)'/)?.[1], body: b.split(/\r?\n {2}\},/)[0] }))
  .filter((e) => e.id);

// Hazards are held to a different contract: a barrel has no slot to be carried
// in and no trigger to make a noise, but its damage is priced the same way.
const hazardAt = weaponSrc.indexOf('export const HAZARD_DEFS');
const weaponEntries = entriesOf(weaponSrc.slice(0, hazardAt === -1 ? undefined : hazardAt));
const hazardEntries = hazardAt === -1 ? [] : entriesOf(weaponSrc.slice(hazardAt));

const DAMAGE_FIELDS = ['damage', 'headMul', 'limbMul', 'range',
  'falloffStart', 'falloffEnd', 'falloffMinScale'];
const CARRY_FIELDS = ['rpm', 'fireSound', 'category', 'slot'];

const shortOf = (entries, fields) => entries
  .map(({ id, body }) => {
    const missing = fields.filter((k) => !new RegExp(`\\b${k}:`).test(body));
    return missing.length ? `${id} lacks ${missing.join('/')}` : null;
  })
  .filter(Boolean);

check('the weapon tables can actually be parsed',
  weaponEntries.length >= 12 && hazardEntries.length >= 1,
  `${weaponEntries.length} weapons, ${hazardEntries.length} hazards`);

const incomplete = [
  ...shortOf(weaponEntries, [...DAMAGE_FIELDS, ...CARRY_FIELDS]),
  ...shortOf(hazardEntries, DAMAGE_FIELDS),
];
check('every definition carries the fields damage maths reads',
  incomplete.length === 0 && weaponEntries.length > 0,
  incomplete.join('; ') || `${weaponEntries.length + hazardEntries.length} definitions checked`);

console.log('\n--- the network protocol ---');

/*
 * Adding a message means editing four files. Nothing connects them, so a
 * message the server sends and the client never handles is invisible until
 * you notice a feature quietly not working.
 */
const protoSrc = read('src/net/protocol.js');
const serverSrc = read(join('server', 'index.js'));
const clientSrc = read('src/net/NetworkClient.js');

/*
 * Scoped to the MSG block specifically. Reading every SHOUTY key in the file
 * swept up MATCH_STATE's WARMUP/LIVE/OVER and reported them as unused message
 * types, which is the sort of false alarm that gets a whole check ignored.
 */
const msgBlock = protoSrc.match(/export const MSG = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
const declared = [...msgBlock.matchAll(/^  ([A-Z][A-Z_]*): '/gm)].map((m) => m[1]);

const serverSends = new Set([...serverSrc.matchAll(/(?:broadcast|send)\((?:MSG\.)([A-Z_]+)/g)].map((m) => m[1]));
const clientSends = new Set([...clientSrc.matchAll(/_send\(MSG\.([A-Z_]+)/g)].map((m) => m[1]));
const serverHandles = new Set([...serverSrc.matchAll(/case MSG\.([A-Z_]+)/g)].map((m) => m[1]));
// Both forms count as handling: WELCOME is matched with an `if` during the
// connect handshake rather than in the main switch.
const clientHandles = new Set([
  ...[...clientSrc.matchAll(/case MSG\.([A-Z_]+)/g)].map((m) => m[1]),
  ...[...clientSrc.matchAll(/msg\.t === MSG\.([A-Z_]+)/g)].map((m) => m[1]),
]);

const unheardServer = [...serverSends].filter((m) => !clientHandles.has(m));
check('every message the server sends, the client handles',
  unheardServer.length === 0, unheardServer.join(', ') || `${serverSends.size} checked`);

const unheardClient = [...clientSends].filter((m) => !serverHandles.has(m));
check('every message the client sends, the server handles',
  unheardClient.length === 0, unheardClient.join(', ') || `${clientSends.size} checked`);

const unused = declared.filter((m) => !serverSends.has(m) && !clientSends.has(m)
  && !serverHandles.has(m) && !clientHandles.has(m));
check('no message type is declared and then never used',
  unused.length === 0, unused.join(', ') || `${declared.length} declared`);

console.log('\n--- the world ---');

// Pickup types the level places must be types the manager knows how to grant.
const levelSrc = read('src/world/Level.js');
const pickupSrc = read('src/world/PickupManager.js');
const knownTypes = new Set([...pickupSrc.matchAll(/^  ([a-z]+): \{ material:/gm)].map((m) => m[1]));
const placedTypes = new Set([...levelSrc.matchAll(/\{ type: '([a-z]+)'/g)].map((m) => m[1]));
const unknownPickups = [...placedTypes].filter((t) => !knownTypes.has(t));
check('every pickup the level places is one the manager can grant',
  unknownPickups.length === 0,
  unknownPickups.join(', ') || `${placedTypes.size} types placed, ${knownTypes.size} known`);

/*
 * Materials are fetched by name too, and a missing one throws mid-frame.
 * Registered two ways — through the _register helper and by writing to the map
 * directly — and counting only the first reported five perfectly good
 * materials as missing.
 */
const registered = new Set([
  ...[...assetSrc.matchAll(/_register\(\s*'([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
  ...[...assetSrc.matchAll(/materials\.set\(\s*'([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
]);
const fetched = collect(/getMaterial\('([a-zA-Z0-9]+)'\)/g);
const missingMats = [...fetched].filter(([n]) => !registered.has(n));
check('every material fetched by name is registered',
  missingMats.length === 0,
  missingMats.length ? missingMats.map(([n, f]) => `${n} (${f})`).join(', ')
                     : `${fetched.size} fetched, ${registered.size} registered`);

console.log('\n--- shared ownership ---');

/*
 * Assets fetched BY NAME from more than one area of the codebase.
 *
 * This is the check that would have saved the most time. The player-body
 * materials were called `enemyFatigues`, `enemyVest`, `enemySkin` — nothing
 * anywhere said they were also what every multiplayer body is built from, and
 * the names implied the opposite. Deleting the AI would have silently taken
 * multiplayer's player models with it.
 *
 * Sharing is legitimate, so this does not ban it. It bans sharing that nobody
 * decided on: a new cross-area name fails until it is listed here, which
 * forces the question "who owns this, and who else breaks if it changes?" to
 * be answered once, in writing, rather than rediscovered by grep a year later.
 */
const SHARED_BY_DESIGN = {
  'texture:flash': 'muzzle flashes, drawn by fx for both the view model and other players',
  'texture:glow': 'the soft halo under pickups and on weapon sights',
  'material:darkGear': 'generic dark matte — vests, gun furniture, grenade bodies',
};

const NAMED_LOOKUPS = [
  [/getMaterial\('([a-zA-Z0-9]+)'\)/g, 'material'],
  [/getModel\??\.?\('([a-zA-Z0-9]+)'\)/g, 'model'],
  [/getTexture\('([a-zA-Z0-9]+)'\)/g, 'texture'],
  [/getCharacterPart\('([a-zA-Z0-9]+)'/g, 'character'],
];
const areaOf = (file) => file.split('/').slice(0, 2).join('/');
const byName = new Map();
for (const { file, text } of ALL_SRC) {
  for (const [re, kind] of NAMED_LOOKUPS) {
    for (const m of text.matchAll(re)) {
      const key = `${kind}:${m[1]}`;
      if (!byName.has(key)) byName.set(key, new Set());
      byName.get(key).add(areaOf(file));
    }
  }
}
const shared = [...byName].filter(([, areas]) => areas.size > 1);
const undeclared = shared.filter(([key]) => !(key in SHARED_BY_DESIGN));
check('every cross-area shared asset is one somebody decided on',
  undeclared.length === 0,
  undeclared.length
    ? undeclared.map(([k, a]) => `${k} used by ${[...a].join(' + ')} — add it to SHARED_BY_DESIGN`).join('; ')
    : `${shared.length} shared, all declared`);

// And the reverse: an entry left behind after the sharing stopped is a stale
// note that will mislead the next person reading it.
const staleShared = Object.keys(SHARED_BY_DESIGN).filter((k) => !shared.some(([n]) => n === k));
check('no stale entry in the shared-asset list', staleShared.length === 0,
  staleShared.join(', ') || `${Object.keys(SHARED_BY_DESIGN).length} entries`);

console.log('\n--- documentation ---');

/*
 * The README's project tree has to list every source file, and list nothing
 * that has been deleted.
 *
 * Documentation that describes code which no longer exists is worse than none:
 * the README still had a whole section on the enemy AI's twelve-state machine
 * and four difficulty tiers long after the last of it was unreachable, which
 * is exactly the sort of thing that sends somebody hunting for a feature the
 * game does not have.
 */
const readme = read('README.md');
const tree = readme.split('## Project structure')[1]?.split('```')[1] ?? '';
const realSrc = SRC.map((f) => f.split('/').pop());
const undocumented = realSrc.filter((n) => !tree.includes(n));
check('every source file appears in the README tree',
  undocumented.length === 0, undocumented.join(', ') || `${realSrc.length} files`);

// The lookbehind skips glob patterns: the tree legitimately says `*-test.js`,
// and without it that reads as a phantom file called "test.js".
const namedInTree = [...new Set(
  [...tree.matchAll(/(?<![-*.\w])([A-Za-z][A-Za-z0-9]*\.m?js)\b/g)].map((m) => m[1]),
)];
const phantom = namedInTree.filter((n) => {
  const hit = [...SRC, 'src/main.js', 'server/index.js', 'scripts/test.mjs',
    'scripts/deps.mjs', 'scripts/lan.mjs', 'vite.config.js'];
  return !hit.some((f) => f.endsWith(`/${n}`) || f === n);
});
check('the README tree names no file that was deleted',
  phantom.length === 0, phantom.join(', ') || `${namedInTree.length} named`);

console.log('\n--- hygiene ---');

// A dangling import is a crash on load, and the build only catches some.
const badImports = [];
for (const { file, text } of ALL_SRC) {
  for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
    const target = join(ROOT, dirname(file), m[1]);
    try { statSync(target); } catch { badImports.push(`${file} -> ${m[1]}`); }
  }
}
check('every relative import points at a file that exists',
  badImports.length === 0, badImports.join('; ') || `${ALL_SRC.length} files scanned`);

// Deleting a feature tends to leave its callbacks assigned and never fired.
const declaredHooks = collect(/^\s*this\.(on[A-Z][a-zA-Z]*) = null;/gm);
const orphanHooks = [];
for (const [hook] of declaredHooks) {
  const invoked = ALL_SRC.some(({ text }) =>
    new RegExp(`${hook}\\?\\.\\(|${hook}\\(`).test(text));
  if (!invoked) orphanHooks.push(hook);
}
check('no callback hook is declared but never invoked',
  orphanHooks.length === 0, orphanHooks.join(', ') || `${declaredHooks.size} hooks`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

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

console.log('\n--- the keyboard ---');

/*
 * Every action the game asks about has to be one the keyboard actually binds.
 *
 * `isDown`/`wasPressed`/`wasReleased` all look their argument up in
 * `KEY_BINDINGS` and RETURN FALSE for a name that is not there. No throw, no
 * warning — the key simply never does anything, for ever. That is the same
 * silent-lookup failure as a missing DOM id or a missing sound, and it is worse
 * for anything hung off a single key: a typo or a dropped binding takes the
 * whole feature away while every one of its own tests still passes.
 *
 * The table is also FROZEN and `BOUND_KEYS` is derived from it once at module
 * load, so a binding cannot be added at runtime to paper over this — it would
 * throw in strict mode and, before that, miss its `preventDefault`.
 */
const inputSrc = read('src/core/InputManager.js');
const bindingBlock = inputSrc
  .match(/export const KEY_BINDINGS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
const boundActions = [...bindingBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \[/gm)].map((m) => m[1]);

// The parse first: a regex that quietly matched nothing would report zero
// unbound actions and read as a green tick.
check('the key binding table can actually be parsed', boundActions.length > 10,
  `${boundActions.length} actions bound`);

const queriedActions = collect(/\b(?:isDown|wasPressed|wasReleased)\('([a-zA-Z][a-zA-Z0-9]*)'\)/g);
const unboundActions = [...queriedActions].filter(([a]) => !boundActions.includes(a));
check('every action the game asks about is one the keyboard binds',
  unboundActions.length === 0 && boundActions.length > 10,
  unboundActions.length ? unboundActions.map(([a, f]) => `${a} (${f})`).join(', ')
                        : `${queriedActions.size} actions queried`);

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

/*
 * Everything imported FROM protocol.js has to be exported BY protocol.js.
 *
 * It is the one file both ends share, so a name that only exists on one side
 * is the most expensive kind of typo here: the client build fails loudly, but
 * the SERVER is plain Node with no bundler, and an import of something that
 * does not exist there fails at start-up in a hosted environment nobody is
 * watching.
 */
const protoExports = new Set(
  [...protoSrc.matchAll(/export (?:const|function|class) ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
);
const protoImporters = [...ALL_SRC, { file: 'server/index.js', text: serverSrc }];
const badProtoImports = [];
for (const { file, text } of protoImporters) {
  // `[^}]` rather than a lazy `[\s\S]*?`: lazy still happily crosses earlier
  // import statements to reach the first protocol.js one, which reported
  // `WebSocketServer` as a missing protocol export.
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*protocol\.js'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !protoExports.has(name)) badProtoImports.push(`${name} (${file})`);
    }
  }
}
check('every name imported from protocol.js is exported by it',
  badProtoImports.length === 0,
  badProtoImports.join(', ') || `${protoExports.size} exports, ${protoImporters.length} files checked`);

/*
 * And the other direction: every protocol name USED is one the file imported.
 *
 * The check above only proves the import list is honest. It says nothing about
 * a file that reaches for `MATCH_RULES` without importing it — which is not a
 * build error, because to a bundler that is simply a global that might exist
 * at runtime. It does not, so the first frame to reach that line throws a
 * ReferenceError and takes the rest of the update loop with it.
 *
 * That shipped. Game.js used MATCH_RULES.respawnCountdownSec in the death
 * sequence without importing it, and the symptom was not an error message but
 * a respawn countdown that never appeared and a player who came back eight
 * seconds late — the exception was thrown past the end of a frame, where
 * nothing was watching.
 *
 * Comment lines are stripped first: a name mentioned in prose is explaining
 * the code, not calling it. So are string literals — CTF's banner text reads
 * 'YOUR FLAG HAS BEEN TAKEN', and FLAG happens to be a protocol export, so a
 * check that treats quoted prose as code reports two files for a word nobody
 * ever called.
 *
 * Template literals keep their ${...} interpolations, which ARE code, and lose
 * the prose around them. Nesting is handled one level deep; a use buried two
 * levels into a template would be missed, which errs towards a quiet check
 * rather than a false alarm.
 */
const strip = (text) => text
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, (lit) =>
    [...lit.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]).join(';'));

const undeclaredUses = [];
for (const { file, text } of protoImporters) {
  if (file.endsWith('protocol.js')) continue;
  const imported = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*protocol\.js'/g)) {
    for (const raw of m[1].split(',')) {
      const bit = raw.trim().split(/\s+as\s+/);
      imported.add((bit[1] ?? bit[0]).trim());
    }
  }
  const code = strip(text);
  for (const name of protoExports) {
    if (imported.has(name)) continue;
    // A bare identifier — not `foo.NAME`, not part of a longer word, and not
    // a key being declared in an object literal.
    if (new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`).test(code)) {
      undeclaredUses.push(`${name} (${file})`);
    }
  }
}
check('every protocol name a file uses is one it imported',
  undeclaredUses.length === 0,
  undeclaredUses.join(', ') || `${protoImporters.length} files checked`);

/*
 * Flag bits are the other half of the wire format, and unlike MSG they are
 * read with a bitwise AND rather than a switch — so a bit that exists on one
 * side and not the other produces no error at all, just behaviour that never
 * happens.
 */
const flagBlock = protoSrc.match(/export const FLAG = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
const flagNames = [...flagBlock.matchAll(/^ {2}([A-Z][A-Z_]*): 1 << /gm)].map((m) => m[1]);
check('the flag table can actually be parsed', flagNames.length > 0,
  `${flagNames.length} flags declared`);

const flagUses = new Set(protoImporters.flatMap(({ text }) =>
  [...text.matchAll(/FLAG\.([A-Z_]+)/g)].map((m) => m[1])));
const undeclaredFlags = [...flagUses].filter((f) => !flagNames.includes(f));
check('every FLAG bit referenced is declared in protocol.js',
  undeclaredFlags.length === 0,
  undeclaredFlags.join(', ') || `${flagUses.size} bits referenced`);

const remotePlayersSrc = read('src/net/RemotePlayers.js');
const gameSrcForFlags = read('src/Game.js');

/*
 * A BIT THAT IS READ MUST BE A BIT THAT IS SENT.
 *
 * The check above proves both sides agree the bit EXISTS. It says nothing
 * about whether anybody ever sets it, and that gap hid a whole feature for the
 * life of the project: `FLAG.RELOADING` was read by RemoteAudio, relayed by
 * the server, declared in the protocol and covered by a passing test — and
 * never once written by `_playerFlags`, which is the only producer there is.
 * No human player has ever heard another one reload. Nothing failed, because
 * a bit that is never set simply means the branch never runs.
 *
 * `scripts/bot.mjs` DOES set it, which is what made the feature look alive
 * whenever anybody went looking.
 *
 * So: every bit the remote-body code consumes has to be one the local player
 * actually sends. Server-authored bits are the documented exception — they are
 * added on the way through and a client must not be able to claim them.
 */
const SERVER_AUTHORED_FLAGS = new Set([
  'PROTECTED',   // invulnerability is the server's to grant, never claimed
  'DEAD',        // sent by us too, but the server's copy is the authority
]);
const remoteAudioSrc = read('src/net/RemoteAudio.js');
const playerFlagsBody = gameSrcForFlags.match(/_playerFlags\(\)\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
check('the _playerFlags body can actually be parsed', playerFlagsBody.length > 0,
  `${playerFlagsBody.split('\n').length} lines`);

const bitsRead = new Set([
  ...[...remotePlayersSrc.matchAll(/FLAG\.([A-Z_]+)/g)].map((m) => m[1]),
  ...[...remoteAudioSrc.matchAll(/FLAG\.([A-Z_]+)/g)].map((m) => m[1]),
]);
const neverSent = [...bitsRead]
  .filter((f) => !SERVER_AUTHORED_FLAGS.has(f))
  .filter((f) => !playerFlagsBody.includes(`FLAG.${f}`));
check('every flag bit the remote bodies read is one _playerFlags sends',
  neverSent.length === 0,
  neverSent.length ? `read but never sent: ${neverSent.join(', ')}`
                   : `${bitsRead.size} bits read, all accounted for`);

/*
 * Spawn protection has to be sent AND drawn.
 *
 * Invulnerability nobody can see is indistinguishable from broken hit
 * registration — you land four rounds on somebody and nothing happens. That
 * exact confusion has shipped here twice already, with armour and with the
 * barrel, so the visible half is a requirement rather than a nicety.
 */
const protectedIn = {
  'server sends': /FLAG\.PROTECTED/.test(serverSrc),
  'bodies draw': /FLAG\.PROTECTED/.test(remotePlayersSrc),
  'HUD shows': /FLAG\.PROTECTED/.test(gameSrcForFlags),
};
const protectedMissing = Object.entries(protectedIn).filter(([, ok]) => !ok).map(([k]) => k);
check('spawn protection is sent by the server, drawn on bodies, and shown on the HUD',
  protectedMissing.length === 0,
  protectedMissing.length ? `missing: ${protectedMissing.join(', ')}`
                          : Object.keys(protectedIn).join(', '));

/*
 * RemoteAudio reads fields off RemotePlayers' body records.
 *
 * That is a deliberate, documented coupling — footsteps have to come off the
 * same gait phase the legs are drawn from, or the sound does not land on the
 * visible footfall — but it is a coupling by NAME across two files. Renaming
 * `phase` in the animation code would silence every player in the game and
 * break nothing that any other test looks at.
 */
// `remoteAudioSrc` is already read above, for the flag-bit check.
const audioReadsFields = [...new Set(
  [...remoteAudioSrc.matchAll(/\bbody\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]),
)];
const absentFields = audioReadsFields.filter((f) =>
  // Either assigned outright, or present in the record literal in _create.
  !new RegExp(`body\\.${f}\\s*=|\\b${f}\\s*[,:]`).test(remotePlayersSrc));
check('every body field RemoteAudio reads is one RemotePlayers sets',
  absentFields.length === 0,
  absentFields.join(', ') || `${audioReadsFields.length} fields: ${audioReadsFields.join(', ')}`);

console.log('\n--- maps ---');

/*
 * A map is only real if BOTH registries know about it.
 *
 * Geometry lives in `world/maps/`; spawn points and bounds live in
 * `net/arena.js`, because the server needs them and must not import THREE. A
 * map in one and not the other is not a build error — it is players spawning
 * at the origin, inside whatever is built there. `test/maps.mjs` proves this
 * by building every map for real; this catches it in a second without one.
 */
const mapsIndexSrc = read('src/world/maps/index.js');
const arenaSrc = read('src/net/arena.js');
const geometryIds = [...mapsIndexSrc.matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]);
const arenaBlock = arenaSrc.match(/export const ARENAS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
const arenaIds = [...arenaBlock.matchAll(/^ {2}(\w+): Object\.freeze\(\{/gm)].map((m) => m[1]);
const lonely = [
  ...geometryIds.filter((id) => !arenaIds.includes(id)).map((id) => `${id} has geometry but no arena`),
  ...arenaIds.filter((id) => !geometryIds.includes(id)).map((id) => `${id} has an arena but no geometry`),
];
check('every map has both geometry and spawn points',
  lonely.length === 0 && geometryIds.length > 0,
  lonely.join(', ') || `${geometryIds.length} maps: ${geometryIds.join(', ')}`);

/*
 * And the picker has to be GENERATED.
 *
 * The whole point of the registry is that a third map needs no UI work. A card
 * written by hand in the markup would work for the two that exist and silently
 * not appear for the next one.
 */
const hardCoded = geometryIds.filter((id) => new RegExp(`data-map-id="${id}"`, 'i').test(HTML));
check('the map picker is built from the registry, not written in HTML',
  hardCoded.length === 0 && /id="map-grid"/.test(HTML),
  hardCoded.length ? `hard-coded: ${hardCoded.join(', ')}`
                   : 'one empty grid, filled from MAPS');

console.log('\n--- the world ---');

/*
 * Pickup types the level places must be types the manager knows how to grant.
 *
 * Read off the REGISTRY rather than a list of filenames. It was the list, and
 * the list said warehouse and outpost — so the third map's pickups were not
 * checked by this at all, silently, from the moment it landed.
 */
const levelSrc = geometryIds.map((id) => read(`src/world/maps/${id}.js`)).join('\n');
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
/*
 * The set of real files is GLOBBED, not listed.
 *
 * It used to be a hardcoded array of the non-src entries — every scripts/ file
 * spelled out by hand — which meant adding a script and documenting it failed
 * this check until somebody also remembered to edit the list here. A check that
 * has to be updated whenever the thing it checks is correct is just a second
 * place to be wrong.
 */
const realFiles = [
  ...SRC,
  ...readdirSync(join(ROOT, 'scripts')).filter((n) => /\.m?js$/.test(n)).map((n) => `scripts/${n}`),
  ...readdirSync(join(ROOT, 'server')).filter((n) => /\.m?js$/.test(n)).map((n) => `server/${n}`),
  ...readdirSync(join(ROOT, 'test')).filter((n) => /\.m?js$/.test(n)).map((n) => `test/${n}`),
  'vite.config.js',
];
const phantom = namedInTree.filter((n) =>
  !realFiles.some((f) => f.endsWith(`/${n}`) || f === n));
check('the README tree names no file that was deleted',
  phantom.length === 0, phantom.join(', ') || `${namedInTree.length} named`);

console.log('\n--- the callsign ---');

/*
 * Nothing may persist the placeholder as if it were a chosen name.
 *
 * connect() saves whatever name it is handed, and quick match used to hand it
 * `settings.get('playerName') || 'OPERATOR'`. So the first press of PLAY wrote
 * the literal string OPERATOR into the player's settings for good: every later
 * 'have they picked a name?' test said yes, the prompt never appeared again,
 * and they were stuck with the default permanently with no way to change it.
 */
const gameSrc = read('src/Game.js');
const menuSrc = read('src/ui/MenuManager.js');

/** Source lines, minus anything that is only a comment. */
const codeLines = (text) => text
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

// The GUARD is what matters, not the set call. Checking for the set call
// alone matched correct code too, and failed it.
const saveLines = codeLines(gameSrc)
  .filter((l) => l.includes("settings.set(\'playerName\', name)"));
const unguarded = saveLines.filter((l) => !l.includes('hasRealName'));
check('the stored callsign is only ever a real choice',
  saveLines.length > 0 && unguarded.length === 0,
  unguarded.length ? 'Game.js saves `name` unguarded — use hasRealName()'
    : saveLines.length ? 'guarded by hasRealName' : 'no save found — has it moved?');

// Only in CODE — the same word inside a comment is explaining the bug, not
// repeating it.
const literals = [gameSrc, menuSrc]
  .flatMap(codeLines)
  .filter((l) => l.includes("\'OPERATOR\'")).length;
check('the default name is a shared constant, not a literal', literals === 0,
  literals ? `${literals} hardcoded 'OPERATOR' left — import DEFAULT_NAME`
           : 'DEFAULT_NAME used');

check('quick match asks when no real name has been chosen',
  /hasRealName\(this\.settings\.get\('playerName'\)\)/.test(menuSrc),
  'PLAY opens the callsign step');


console.log('\n--- the physics guards ---');

/*
 * Every factory that puts a collider into the broad phase has to check its
 * numbers BEFORE it does.
 *
 * One non-finite dimension does not misplace one collider. It poisons Rapier's
 * broad phase, and from then on every raycast on that map returns nothing — no
 * ground under anyone's feet, no walls, no hit registration — with nothing
 * thrown, nothing logged, and the level still rendering perfectly. That has
 * already cost an afternoon here once, which is why `assertFinite` exists.
 *
 * It is checked from the SOURCE and derived from the code rather than from a
 * list, so a sixth factory added later is covered the day it is written. A
 * hand-maintained list would simply not mention it.
 */
const physicsSrc = read('src/physics/PhysicsWorld.js');
const physicsMethods = [...physicsSrc.matchAll(/^ {2}([a-zA-Z_]\w*)\([^\n]*\) \{\n([\s\S]*?)\n {2}\}/gm)]
  .map((m) => ({ name: m[1], body: m[2] }));
const colliderFactories = physicsMethods.filter((m) => m.body.includes('this.world.createCollider('));

// The parse first, because a regex that quietly matched nothing would report
// zero unguarded factories and read as a green tick.
check('the physics factories can actually be parsed',
  physicsMethods.length > 10 && colliderFactories.length >= 5,
  `${colliderFactories.length} of ${physicsMethods.length} methods build a collider: `
  + colliderFactories.map((m) => m.name).join(', '));

const unguardedFactories = colliderFactories.filter(({ body }) => {
  const guard = body.indexOf('assertFinite');
  const world = body.indexOf('this.world');
  return guard === -1 || guard > world;
});
check('every collider factory guards its dimensions before touching the world',
  unguardedFactories.length === 0 && colliderFactories.length >= 5,
  unguardedFactories.map((m) => m.name).join(', ')
  || `${colliderFactories.length} factories guarded`);

/*
 * And the dead NPC controller is gone for good.
 *
 * It was tuning left behind by the removed enemy stack — a 0.4 m autostep and a
 * 0.2 m minimum tread width, against a mezzanine whose stairs have a 0.18 m
 * run, so it could not have climbed them. Unreferenced scaffolding like that
 * gets reused by the next person who needs "a controller that already exists",
 *
 */
const npcLeftovers = [...ALL_SRC, { file: 'server/index.js', text: serverSrc }]
  .filter(({ text }) => /npcController/.test(text))
  .map(({ file }) => file);
check('the dead NPC character controller is gone, not lying around to be reused',
  npcLeftovers.length === 0,
  npcLeftovers.join(', ') || 'no npcController in src/ or server/');

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

/*
 * And the other way round: a hook that IS fired but that nothing listens to.
 *
 * `onJoined` was declared by NetworkClient and called on every arrival, and no
 * one had ever assigned it — so a friend joining your match produced no notice
 * at all. Nothing failed, nothing warned; the feature simply was not there.
 * That is the quietest kind of missing wiring, and the only way to see it is
 * to look for the gap deliberately.
 */
const unheardHooks = [];
for (const [hook, declaredIn] of declaredHooks) {
  const listenedTo = ALL_SRC.some(({ file, text }) =>
    file !== declaredIn && new RegExp(`\\.${hook}\\s*=`).test(text));
  if (listenedTo) continue;
  const fired = ALL_SRC.some(({ file, text }) =>
    file === declaredIn && new RegExp(`${hook}\\?\\.\\(`).test(text));
  if (fired) unheardHooks.push(`${hook} (${declaredIn})`);
}
check('no callback is fired that nothing listens to',
  unheardHooks.length === 0, unheardHooks.join(', ') || `${declaredHooks.size} hooks`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

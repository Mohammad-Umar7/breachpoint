/**
 * Blast radius — `npm run deps <thing>`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deleting the wave system was slow and nervous work, and not because the code
 * was hard. It was because the couplings were INVISIBLE. Nothing anywhere said
 * that the materials named `enemyFatigues`, `enemyVest`, `enemySkin` were also
 * what every multiplayer body is built from — the names implied the opposite.
 * Delete them with the AI and multiplayer quietly loses its player models.
 *
 * The only way to know was to grep for each name, one at a time, and read
 * every hit. That is exactly the "go everywhere looking, being careful" tax
 * this file removes.
 *
 * Ask before you cut:
 *
 *   npm run deps src/world/PickupManager.js    who imports this file
 *   npm run deps enemyFatigues                 who uses this name
 *   npm run deps onShotResolved                who reads or writes this hook
 *   npm run deps --unused                      what nothing references at all
 *
 * It reads text, so it sees names in strings — which is the whole point, since
 * most of this project's coupling is by name rather than by import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'public']);
const EXT = new Set(['.js', '.mjs', '.html', '.css', '.json']);

function walk(dir = '.', out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP.has(name)) continue;
    const rel = dir === '.' ? name : `${dir}/${name}`;
    const full = join(ROOT, rel);
    if (statSync(full).isDirectory()) walk(rel, out);
    else if (EXT.has(extname(name))) out.push(rel);
  }
  return out;
}

const FILES = walk().map((f) => ({ file: f, text: readFileSync(join(ROOT, f), 'utf8') }));

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run deps <file|name>   or   npm run deps --unused');
  process.exit(1);
}

/* ------------------------------------------------------------------ unused */
if (arg === '--unused') {
  console.log('Files that nothing else imports:\n');
  let n = 0;
  for (const { file } of FILES) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const stem = basename(file).replace(/\.m?js$/, '');
    // Entry points and test suites are meant to have no importer.
    if (/^(main|index|test|.*-test|.*\.test)$/.test(stem)) continue;
    if (file.startsWith('test/') || file.startsWith('scripts/')) continue;
    const importers = FILES.filter((o) => o.file !== file
      && new RegExp(`from '[^']*${stem}\\.js'`).test(o.text));
    if (!importers.length) { console.log(`  ${file}`); n++; }
  }
  console.log(n ? `\n${n} orphan(s). Check each before deleting — an entry point looks the same.`
                : '  none');
  process.exit(0);
}

/* ------------------------------------------------- a file, or a plain name */
const asPath = join(ROOT, arg);
let isFile = false;
try { isFile = statSync(asPath).isFile(); } catch { /* it is a name */ }

console.log('');
if (isFile) {
  const rel = relative(ROOT, asPath).replace(/\\/g, '/');
  const stem = basename(rel).replace(/\.m?js$/, '');
  console.log(`${rel}\n`);

  const importers = [];
  for (const { file, text } of FILES) {
    if (file === rel) continue;
    for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
      const target = resolve(ROOT, dirname(file), m[1]).replace(/\\/g, '/');
      if (target === asPath.replace(/\\/g, '/')) {
        // Which symbols they take, so you can see what is actually depended on.
        const line = text.slice(0, m.index).split('\n').length;
        const stmt = text.split('\n')[line - 1]?.trim() ?? '';
        importers.push({ file, stmt });
      }
    }
  }

  if (!importers.length) {
    console.log('  Nothing imports it. Safe to delete, unless it is an entry point.');
  } else {
    console.log(`  IMPORTED BY ${importers.length} file(s) — each one breaks if you delete it:`);
    for (const i of importers) console.log(`    ${i.file}\n      ${i.stmt}`);
  }

  // Exported names used elsewhere, which is the coupling an import list hides.
  const own = readFileSync(asPath, 'utf8');
  const exported = [...own.matchAll(/^export (?:const|function|class|let)\s+(\w+)/gm)].map((m) => m[1]);
  if (exported.length) {
    console.log(`\n  EXPORTS (${exported.length}):`);
    for (const sym of exported) {
      const users = FILES.filter((o) => o.file !== rel && new RegExp(`\\b${sym}\\b`).test(o.text));
      console.log(`    ${sym.padEnd(24)} ${users.length ? users.map((u) => u.file).join(', ') : 'unused elsewhere'}`);
    }
  }
  process.exit(0);
}

/* --------------------------------------------------------------- a name ---*/
const name = arg;
console.log(`"${name}"\n`);
const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
const hits = [];
for (const { file, text } of FILES) {
  const lines = text.split('\n');
  const matched = [];
  lines.forEach((l, i) => { if (rx.test(l)) matched.push({ n: i + 1, line: l.trim() }); });
  if (matched.length) hits.push({ file, matched });
}

if (!hits.length) {
  console.log('  Not referenced anywhere.');
  process.exit(0);
}

console.log(`  Referenced in ${hits.length} file(s):\n`);
for (const h of hits) {
  console.log(`  ${h.file}  (${h.matched.length})`);
  for (const m of h.matched.slice(0, 4)) {
    console.log(`      ${String(m.n).padStart(4)}  ${m.line.slice(0, 96)}`);
  }
  if (h.matched.length > 4) console.log(`      ... ${h.matched.length - 4} more`);
}

/*
 * The warning that matters. A name used across unrelated areas is shared
 * whether or not anybody meant it to be, and that is precisely what makes a
 * deletion dangerous — as `enemyFatigues`, owned by nothing and used by
 * multiplayer, demonstrated.
 */
const areas = new Set(hits.map((h) => h.file.split('/').slice(0, 2).join('/')));
if (areas.size > 1) {
  console.log(`\n  SHARED across ${areas.size} areas: ${[...areas].join(', ')}`);
  console.log('  Removing it affects all of them. Check each before you cut.');
}

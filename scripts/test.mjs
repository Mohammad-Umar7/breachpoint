/**
 * Test runner — `npm test`.
 *
 * WHY THIS EXISTS
 * ---------------
 * There were thirteen suites and no way to run them. You had to know which
 * ones needed a game server, start it yourself, run each file by hand, read
 * thirteen outputs and remember to kill the server afterwards. In practice
 * that means they get run when someone remembers, which is not a safety net.
 *
 * This starts the server if a suite needs one, runs everything, prints one
 * summary and exits non-zero if anything failed. Adding a suite means dropping
 * a file into test/ or server/*-test.js — the lists below are globbed, not
 * hand-maintained, so a new test cannot be forgotten.
 *
 *   npm test              everything
 *   npm test -- contracts run only suites whose name contains "contracts"
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const filter = process.argv[2] ?? '';

/** Suites that talk to a live game server, and those that do not. */
const networked = readdirSync(join(ROOT, 'server'))
  .filter((f) => f.endsWith('-test.js'))
  .map((f) => ({ name: f.replace(/\.js$/, ''), path: `server/${f}`, needsServer: true }));

const standalone = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ name: f.replace(/\.mjs$/, ''), path: `test/${f}`, needsServer: false }));

// Contracts first: they are instant, and they catch the class of mistake that
// makes every other suite fail in a confusing way.
const suites = [...standalone, ...networked]
  .sort((a, b) => (a.name === 'contracts' ? -1 : b.name === 'contracts' ? 1 : 0))
  .filter((s) => !filter || s.name.includes(filter));

if (!suites.length) {
  console.error(`No suite matches "${filter}".`);
  process.exit(1);
}

const run = (path) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // Long enough for the slowest suite (twoplayer walks a whole match), short
  // enough that a hang fails the run rather than blocking it forever.
  const timer = setTimeout(() => { child.kill(); resolve({ code: 124, out: `${out}\nTIMED OUT` }); },
    5 * 60 * 1000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

/** Wait for the server to answer, rather than sleeping and hoping. */
async function waitForServer(ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let server = null;
async function startServer() {
  // Reuse one already running rather than fighting it for the port.
  if (await waitForServer(300)) {
    console.log(`Using the game server already listening on :${PORT}\n`);
    return true;
  }
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) },
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  const up = await waitForServer();
  if (!up) console.error(`Game server never came up on :${PORT}.`);
  else console.log(`Started a game server on :${PORT}\n`);
  return up;
}

async function main() {
  if (suites.some((s) => s.needsServer) && !(await startServer())) process.exit(1);

  const results = [];
  for (const suite of suites) {
    process.stdout.write(`${suite.name.padEnd(24)} `);
    const { code, out } = await run(suite.path);
    // Each suite prints its own "N/M passed"; pull it out for the summary.
    const tally = out.match(/(\d+)\/(\d+) passed/);
    const passLines = (out.match(/^PASS/gm) ?? []).length;
    const label = tally ? `${tally[1]}/${tally[2]}`
      : passLines ? `${passLines} checks` : '—';
    console.log(code === 0 ? `ok    ${label}` : `FAIL  ${label}`);
    results.push({ ...suite, code, out, label });
  }

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length) {
    console.log('\n' + '='.repeat(64));
    for (const f of failed) {
      console.log(`\n--- ${f.name} ---`);
      // Only the failures; a full replay of every suite buries them.
      const lines = f.out.split('\n').filter((l) => /^FAIL|TIMED OUT|Error|crashed/.test(l));
      console.log(lines.length ? lines.join('\n') : f.out.trim().slice(-1500));
    }
  }

  const total = results.reduce((n, r) => n + (Number(r.label.split('/')[1]) || 0), 0);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed`
    + (total ? `  (${total} checks)` : ''));
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { server?.kill(); process.exit(code); })
  .catch((e) => { server?.kill(); console.error(e); process.exit(1); });

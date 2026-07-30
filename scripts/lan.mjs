/**
 * `npm run lan` — play with people on the same Wi-Fi, with no hosting at all.
 *
 * Starts the game server and the dev server together, works out this machine's
 * address on the local network, and prints the one link to share.
 *
 * WHY THIS BEATS A HOSTED SERVER FOR PEOPLE IN THE SAME ROOM
 * ---------------------------------------------------------
 * A hosted free server put two players sitting next to each other on a 129 ms
 * round trip, because every position update travelled to Frankfurt and back.
 * Over a LAN that becomes 1-3 ms. Nothing else in the game moves the feel of it
 * anywhere near as much.
 *
 * WHY IT MUST SERVE THE GAME LOCALLY TOO, not just the game server
 * ---------------------------------------------------------------
 * Tempting shortcut: keep loading the game from the hosted site and only run
 * the game server here. Browsers refuse it. A page served over https may not
 * open a plaintext ws:// socket — it is blocked as mixed content, silently in
 * some browsers. Serving the page over plain http from this machine keeps both
 * halves on http/ws and sidesteps the whole problem.
 *
 * NetworkClient needs no configuration for this: with no VITE_SERVER_URL set it
 * derives the server from the page's own hostname, so a guest loading
 * http://192.168.1.50:5173 automatically talks to ws://192.168.1.50:8787.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const GAME_PORT = 5173;
const SERVER_PORT = 8787;

/**
 * Best guess at this machine's address on the local network.
 *
 * Private ranges are preferred and ranked, because a machine often has several
 * addresses — virtual adapters from VirtualBox/WSL/Docker, VPN tunnels — and
 * handing out the wrong one produces a link that simply does not load. The
 * 192.168.x.x range is what a home router almost always hands out, so it wins.
 */
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let rank = 3;
      if (a.address.startsWith('192.168.')) rank = 0;
      else if (a.address.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) rank = 2;
      // Adapters that are usually NOT the one a phone or laptop can reach.
      if (/virtual|vmware|vbox|docker|wsl|loopback|hyper-v/i.test(name)) rank += 10;
      out.push({ name, address: a.address, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const addresses = localAddresses();
const best = addresses[0];

const bar = '='.repeat(64);
console.log(`\n${bar}`);
console.log('  BREACHPOINT — local network match');
console.log(bar);

if (!best) {
  console.log('\n  Could not find a network address. Are you connected to Wi-Fi?');
  console.log('  The game will still work on this machine at');
  console.log(`  http://localhost:${GAME_PORT}\n`);
} else {
  console.log('\n  SHARE THIS LINK with anyone on the same Wi-Fi:\n');
  console.log(`      http://${best.address}:${GAME_PORT}\n`);
  console.log(`  On this machine you can also use  http://localhost:${GAME_PORT}`);
  if (addresses.length > 1) {
    console.log('\n  If that link does not load for them, try one of these instead:');
    for (const a of addresses.slice(1, 4)) {
      console.log(`      http://${a.address}:${GAME_PORT}   (${a.name})`);
    }
  }
  console.log('\n  Expect 1-3 ms ping instead of ~130 ms through a hosted server.');
  console.log('\n  If their browser cannot reach it, it is almost always the');
  console.log('  firewall: Windows asks to allow Node the first time — say yes,');
  console.log(`  and make sure "Private networks" is ticked. Ports ${SERVER_PORT} and ${GAME_PORT}.`);
}
console.log(`\n${bar}\n`);

// --- start both halves -----------------------------------------------------
const children = [];
function start(label, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',   // npm/npx need a shell on Windows
  });
  const tag = (line) => `[${label}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(tag(line));
    });
  }
  child.on('exit', (code) => {
    console.log(tag(`exited (${code})`));
    // If either half dies the other is useless, so take both down rather than
    // leaving a half-working setup that looks like a game bug.
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 250);
}

start('server', 'node', ['server/index.js']);
start('game', 'npx', ['vite', '--host']);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

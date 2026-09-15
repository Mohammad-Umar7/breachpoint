/**
 * What the banner says when a match ends.
 *
 * The wire carries a WINNER ID because a free-for-all has a winner. A team
 * mode has a winning SIDE, and naming its top scorer to the whole room told
 * four people who had just won that a stranger had. The banner has to be
 * built from the team scores the same message carries.
 *
 *   node test/match-over.mjs
 */
import { matchOverHeadline } from '../src/net/wireNetwork.js';
import { TEAM } from '../src/net/modes.js';

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const names = { 1: 'GHOST', 2: 'VIPER', 3: 'ME' };
const me = (team) => ({ selfId: 3, team, nameOf: (id) => names[id] ?? 'SOMEONE' });

console.log('free-for-all\n');
check('I won', matchOverHeadline(me(TEAM.NONE), { modeId: 'ffa', winnerId: 3 }) === 'YOU WIN');
check('somebody else won', matchOverHeadline(me(TEAM.NONE), { modeId: 'ffa', winnerId: 1 }) === 'GHOST WINS');
check('nobody scored is a draw, not "SOMEONE WINS"',
  matchOverHeadline(me(TEAM.NONE), { modeId: 'ffa', winnerId: null }) === 'DRAW');

console.log('\ncapture the flag\n');
const ctf = (red, blue, winnerId) => ({
  modeId: 'ctf', winnerId, teamScores: { [TEAM.RED]: red, [TEAM.BLUE]: blue },
});
check('my side won — even though a teammate got the capture',
  matchOverHeadline(me(TEAM.RED), ctf(3, 1, 1)) === 'YOUR TEAM WINS');
check('the other side won — named as a team, not a person',
  matchOverHeadline(me(TEAM.BLUE), ctf(3, 1, 1)) === 'RED WINS');
check('blue can win too', matchOverHeadline(me(TEAM.RED), ctf(0, 2, 2)) === 'BLUE WINS');
check('level on the whistle is a draw whoever the wire names',
  matchOverHeadline(me(TEAM.RED), ctf(2, 2, 1)) === 'DRAW');
check('missing team scores do not crash it',
  matchOverHeadline(me(TEAM.RED), { modeId: 'ctf', winnerId: 1 }) === 'DRAW');

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

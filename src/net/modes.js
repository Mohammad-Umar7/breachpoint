/**
 * modes.js — what winning means, shared by the browser and the server.
 *
 * Dependency-free (no THREE, no Node) because the server imports it directly,
 * exactly like `arena.js`. The server decides who scored and when a match is
 * over, so the rules have to live somewhere both ends agree on: the client
 * needs them to label the HUD and the scoreboard, and the two disagreeing
 * would show a player a score that is not the one deciding the match.
 *
 * ADDING A MODE
 * -------------
 *   1. Add a definition to `MODES` below.
 *   2. Give the server a branch for whatever it scores — see `Room.tick`.
 *   3. If it is team-based, add team spawns and any objective positions to
 *      `arena.js` for every map.
 *
 * The mode picker builds itself from this file, so there is no UI step.
 */

/**
 * Teams.
 *
 * NONE is a real value, not a null: in a free-for-all everybody is on NONE,
 * which means "no team" rather than "team not decided yet". Code that asks
 * `sameTeam(a, b)` must say NO for two players in a deathmatch, and a nullable
 * field invites that check to be written as `a.team === b.team` — which is
 * true for two nulls, and would make everyone immune to everyone.
 */
export const TEAM = Object.freeze({
  NONE: 0,
  RED: 1,
  BLUE: 2,
});

export const TEAM_NAME = Object.freeze({
  [TEAM.NONE]: 'NONE',
  [TEAM.RED]: 'RED',
  [TEAM.BLUE]: 'BLUE',
});

/** Display colours, shared so the HUD, name tags and bodies cannot disagree. */
export const TEAM_COLOR = Object.freeze({
  [TEAM.NONE]: 0xbfcbd4,
  [TEAM.RED]: 0xe1553f,
  [TEAM.BLUE]: 0x4a90d9,
});

export const TEAM_CSS = Object.freeze({
  [TEAM.NONE]: '#bfcbd4',
  [TEAM.RED]: '#e1553f',
  [TEAM.BLUE]: '#4a90d9',
});

/** The two playing teams, in a fixed order. NONE is not one of them. */
export const PLAYING_TEAMS = Object.freeze([TEAM.RED, TEAM.BLUE]);

export const opposingTeam = (team) =>
  (team === TEAM.RED ? TEAM.BLUE : team === TEAM.BLUE ? TEAM.RED : TEAM.NONE);

/** True only when both are on the SAME PLAYING team. See the note on TEAM. */
export function sameTeam(a, b) {
  return a !== TEAM.NONE && a === b;
}

/**
 * A flag is always in exactly one of three states.
 *
 * DROPPED is the one that carries the mode. Without it, killing a carrier
 * either destroys the flag or teleports it home, and both remove the scramble
 * over a loose flag that is most of what makes the mode work.
 */
export const FLAG_STATE = Object.freeze({
  AT_BASE: 'base',
  CARRIED: 'carried',
  DROPPED: 'dropped',
});

/** What just happened to a flag, so the client can say so. */
export const FLAG_EVENT = Object.freeze({
  TAKEN: 'taken',
  DROPPED: 'dropped',
  RETURNED: 'returned',
  CAPTURED: 'captured',
});

export const DEFAULT_MODE_ID = 'ffa';

/**
 * CAPTURE THE FLAG, as the mode is actually played.
 *
 * Each team has a flag on a stand at its base. You score by carrying the
 * ENEMY flag back to YOUR base and touching your own — and that last clause is
 * the whole game:
 *
 *   - Your own flag must be HOME for a capture to count. If both flags are out,
 *     neither team can score until somebody's flag is recovered, which is the
 *     "standoff" every CTF match turns on. Without it the mode collapses into
 *     two teams running past each other in opposite directions.
 *   - Killing a carrier DROPS the flag where they fell. It is not destroyed and
 *     it does not go home, so the fight over the body is the real fight.
 *   - Your own dropped flag is RETURNED instantly by any of your team touching
 *     it. The enemy has to guard it; you have to reach it.
 *   - A flag nobody touches goes home on a timer, so a flag punted into a
 *     corner cannot freeze the match.
 */
export const MODES = Object.freeze({
  ffa: Object.freeze({
    id: 'ffa',
    name: 'FREE-FOR-ALL',
    short: 'FFA',
    tagline: 'Everyone for themselves',
    description:
      'No teams, no objective. Most eliminations when the clock runs out, or '
      + 'first to the target.',
    teamBased: false,
    /** What the HUD counts, and what the scoreboard sorts by. */
    scoreLabel: 'KILLS',
    scoreTarget: 25,
    targetLabel: 'FIRST TO 25',
    timeLimitSec: 600,
    accent: '#66ddff',
  }),

  ctf: Object.freeze({
    id: 'ctf',
    name: 'CAPTURE THE FLAG',
    short: 'CTF',
    tagline: 'Red versus Blue',
    description:
      'Take the enemy flag to your own base to score — but only while your '
      + 'flag is still home. Kill the carrier and it drops where they fall.',
    teamBased: true,
    scoreLabel: 'CAPTURES',
    scoreTarget: 3,
    targetLabel: 'FIRST TO 3 CAPTURES',
    timeLimitSec: 600,
    accent: '#e1553f',

    /** A dropped flag nobody touches goes home after this long. */
    flagReturnSec: 30,
    /** How close you must be to take, return or capture a flag. */
    flagTouchRadius: 1.9,
    /** How close to your own base the capture is registered. */
    captureRadius: 2.4,
    /**
     * ...and how far above or below it you may be. THIS IS NOT OPTIONAL.
     *
     * Both radii above are measured on the FLOOR PLANE, which is a fair
     * description of a flat arena and a completely wrong one for a house. On a
     * three-storey map every base has two more floors stacked directly over it,
     * so a carrier standing on the landing above the enemy base — or in the
     * attic above that — was inside the capture radius and scored through the
     * ceiling. Players read the light column rising out of the base as the
     * thing they were touching; the beam is innocent, the missing Y is not.
     *
     * 1.8 m is chosen against the two numbers that bracket it: a jump apex is
     * about 1.3 m, so you can still take a flag by vaulting over it, and the
     * manor's storeys are 4.0 m apart, so the floor above is nowhere near.
     */
    flagTouchHeight: 1.8,
  }),
});

export const MODE_IDS = Object.freeze(Object.keys(MODES));

export function isValidModeId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODES, id);
}

/**
 * A mode by id, falling back rather than throwing.
 *
 * An unknown id means a client on a different build, or a hand-edited message.
 * Dropping them into the default mode is better than refusing to run the room.
 */
export function getMode(id) {
  return MODES[id] ?? MODES[DEFAULT_MODE_ID];
}

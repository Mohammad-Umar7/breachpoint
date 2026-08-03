/**
 * RemoteAudio — what the OTHER players sound like.
 *
 * WHY THIS EXISTS
 * ---------------
 * `RemotePlayers` never called the audio system once. Not a footstep, not a
 * landing, not a reload. The only sound another player made was gunfire, and
 * only because the FIRE relay plays it from `wireNetwork`.
 *
 * So somebody could sprint up behind you across metal decking in complete
 * silence. In a shooter that is not a missing polish detail — hearing the
 * person round the corner IS the game. It is what makes holding an angle a
 * decision instead of a coin flip, and it is the entire reason crouch-walking
 * is worth the speed you give up.
 *
 * NOTHING NEW GOES OVER THE WIRE
 * ------------------------------
 * Every sound here is derived from data the snapshot already carries — the
 * interpolated position, and the SPRINT / CROUCH / AIRBORNE / RELOADING flags.
 * No new message, no extra bandwidth, no server change. What was missing was
 * never the information; it was the listener.
 *
 * FOOTSTEPS COME OFF THE ANIMATION, NOT A DISTANCE COUNTER
 * -------------------------------------------------------
 * The local player counts metres travelled and steps every `stride` of them
 * (see Player.js), which is right for a body you cannot see. For a body you CAN
 * see, a sound that does not land on the visible footfall reads as broken.
 *
 * `RemotePlayers._animate` already runs a gait phase, and its vertical bob is
 * `|cos(phase)|` — lowest, meaning weight fully on the planted foot, whenever
 * `cos(phase)` crosses zero. So a footfall is exactly `phase = π/2 + nπ`, twice
 * per stride cycle, one per leg. Counting those crossings puts the sound on the
 * frame the foot lands, for free, and it stays in sync automatically if the
 * gait is ever retuned.
 *
 * WHAT IT READS FROM A BODY RECORD
 * --------------------------------
 * `phase` and `speed` (from `_animate`) and `group.position`. That is the whole
 * contract with RemotePlayers, and `test/contracts.mjs` checks those three
 * still exist — renaming one would otherwise silence every player quietly.
 */

import { footstepSoundFor } from '../audio/AudioManager.js';
import { getWeaponDef } from '../weapons/WeaponDefinitions.js';
import { FLAG } from './protocol.js';

/**
 * Ranges past which a sound is not built at all.
 *
 * These are not taste — they follow the synths. Footsteps use `refDistance: 4`
 * and landings `5`, so by 24 m a step is some forty times quieter than it is
 * underfoot: inaudible, but still a dozen Web Audio nodes built and torn down.
 * With twelve players running around, that is the difference between a handful
 * of voices and a hundred.
 */
const FOOTSTEP_RANGE_SQ = 24 * 24;
const LAND_RANGE_SQ = 30 * 30;
/** A reload is a close-quarters tell — "push him now" — so it carries less far. */
const RELOAD_RANGE_SQ = 20 * 20;

/** Below this the body is shuffling in place, not walking. */
const MIN_STEP_SPEED = 1.0;

/**
 * Loudness by stance, matching the local player's own figures in Player.js so
 * a crouching enemy is as quiet to you as you are to them. This is the whole
 * risk/reward of moving slowly, and it only works if both ends agree.
 */
const VOLUME_CROUCH = 0.32;
const VOLUME_WALK = 0.68;
const VOLUME_SPRINT = 1.0;

const HALF_PI = Math.PI / 2;

export class RemoteAudio {
  /**
   * @param {object} opts
   * @param {import('../audio/AudioManager.js').AudioManager} opts.audio
   * @param {((x:number, y:number, z:number) => string|null)|null} [opts.surfaceProbe]
   *   What is under a player's feet, for concrete vs metal vs wood. Optional:
   *   without it everyone walks on concrete, which is what most of the arena
   *   is. Called at most once per footstep, and only for audible ones, so it
   *   costs about two raycasts a second per nearby player.
   */
  constructor({ audio, surfaceProbe = null }) {
    this.audio = audio;
    this.surfaceProbe = surfaceProbe;
    this.enabled = true;
    /** @type {Map<number, {step:number, air:boolean, reloading:boolean, started:boolean}>} */
    this._state = new Map();
  }

  /** Drop one player's state — on leaving, so a rejoin starts clean. */
  forget(id) { this._state.delete(id); }

  /** Drop everyone, on leaving a match or losing the connection. */
  clear() { this._state.clear(); }

  /**
   * One player, one frame. Called from RemotePlayers.sync after the body has
   * been positioned and animated, so `phase` and `speed` are this frame's.
   *
   * @param {number} id
   * @param {object} body     RemotePlayers body record; reads phase, speed, group
   * @param {object} s        snapshot sample: flags, weapon
   * @param {number} distSq   squared distance to the listener
   */
  update(id, body, s, distSq) {
    if (!this.enabled || !this.audio) return;

    let st = this._state.get(id);
    if (!st) {
      st = { step: 0, air: false, reloading: false, started: false };
      this._state.set(id, st);
    }

    const dead = (s.flags & FLAG.DEAD) !== 0;
    if (dead) {
      // A corpse makes no noise, and must not fire a landing sound when the
      // body is moved to its spawn point for the respawn countdown.
      st.started = false;
      st.air = false;
      st.reloading = false;
      return;
    }

    const airborne = (s.flags & FLAG.AIRBORNE) !== 0;
    const crouched = (s.flags & FLAG.CROUCH) !== 0;
    const sprinting = (s.flags & FLAG.SPRINT) !== 0;
    const reloading = (s.flags & FLAG.RELOADING) !== 0;
    const pos = body.group.position;

    /*
     * Footfall detection.
     *
     * The index is recomputed every frame whether or not it will be played,
     * because the idle sway keeps the phase advancing while a player stands
     * still. Tracking it only while moving would leave a stale index behind,
     * and the first frame of them walking again would fire a step that had
     * already happened.
     */
    const idx = Math.floor((body.phase - HALF_PI) / Math.PI);
    const stepped = idx !== st.step;
    st.step = idx;

    // First frame for this player: adopt the current phase without playing.
    // Otherwise every arriving body cracks out a footstep as it appears.
    if (!st.started) {
      st.started = true;
      st.air = airborne;
      st.reloading = reloading;
      return;
    }

    if (stepped && !airborne && (body.speed ?? 0) > MIN_STEP_SPEED
        && distSq < FOOTSTEP_RANGE_SQ) {
      const surface = this.surfaceProbe?.(pos.x, pos.y, pos.z) ?? null;
      this.audio.play(footstepSoundFor(surface), {
        position: pos,
        volume: crouched ? VOLUME_CROUCH : sprinting ? VOLUME_SPRINT : VOLUME_WALK,
      });
    }

    // Landing: the falling edge of AIRBORNE. Loud on purpose — dropping off a
    // container behind somebody should give you away.
    if (st.air && !airborne && distSq < LAND_RANGE_SQ) {
      this.audio.play('land', { position: pos, volume: 0.75 });
    }
    st.air = airborne;

    /*
     * Reloading: the rising edge of RELOADING.
     *
     * The single most actionable sound in a shooter — it says the person
     * behind that wall cannot shoot back for the next two seconds. Plays the
     * weapon's OWN first reload sound, so a shotgun being topped up and a
     * rifle mag being dropped are distinguishable.
     */
    if (reloading && !st.reloading && distSq < RELOAD_RANGE_SQ) {
      const def = getWeaponDef(s.weapon);
      const name = def?.reloadSounds?.[0]?.[1] ?? 'magOut';
      this.audio.play(name, { position: pos, volume: 0.9 });
    }
    st.reloading = reloading;
  }
}

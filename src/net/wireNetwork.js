/**
 * wireNetwork — everything the multiplayer client does to the game.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * This was a 301-line method inside Game.js, which is the file every feature
 * already has to touch. Multiplayer behaviour lives in `src/net/` with the
 * protocol, the socket and the remote bodies, so it belongs here rather than
 * in the middle of the class that also owns the render loop and the menus.
 *
 * It is deliberately a plain function taking the game rather than a class:
 * there is no state of its own to hold, it runs exactly once, and a function
 * makes it obvious that this is wiring rather than a system with a lifetime.
 *
 * Everything here is a CALLBACK ASSIGNMENT. NetworkClient decodes the wire
 * format and calls these; nothing in this file talks to a socket.
 */
import * as THREE from 'three';

import { getWeaponDef } from '../weapons/WeaponDefinitions.js';
import { MATCH_STATE } from './protocol.js';
import { NET_STATE } from './NetworkClient.js';
import { clamp } from '../core/MathUtils.js';

/*
 * Range limits for OTHER players' gunfire — see game.net.onFire below.
 *
 * The arena is 120 m across, so a shot from the far corner is both inaudible
 * and unlit. Both of these bound the per-shot cost of a busy match, where
 * every trigger pull in the room reaches this client.
 */
const FIRE_AUDIBLE_RANGE_SQ = 85 * 85;
const FIRE_LIGHT_RANGE_SQ = 22 * 22;

/*
 * Scratch for drawing another player's gunfire, reused every shot.
 *
 * Module-level rather than fields on the game: nothing outside this file
 * touches them, and hanging them off Game meant two more members on a class
 * that already has plenty. Safe to share because the only reader is the
 * synchronous onFire handler below.
 */
const _dir = new THREE.Vector3();
const _tip = new THREE.Vector3();

/** @param {import('../Game.js').Game} game */
export function wireNetwork(game) {
  const net = game.net;

  net.onWelcome = ({ spawn }) => {
    // The server owns spawn points, so adopt the one it gave us rather than
    // the single-player start.
    //
    // Held as well as applied, because startGame() runs shortly afterwards
    // and its _resetWorld() respawns the player at Level.playerSpawn — which
    // silently put every player on the same tile.
    game._pendingSpawn = spawn;
    if (spawn) game._placePlayer(spawn);
  };

  net.onCorrection = (pos) => {
    // The server rejected where we said we were. Snap, do not smooth: easing
    // toward a corrected position keeps feeding it rejected inputs.
    game._placePlayer(pos);
  };

  /*
   * Dying moves you to your spawn straight away.
   *
   * The server reserves the point at the moment of death and tells only us,
   * so the whole countdown is spent standing where we will come back rather
   * than over our own corpse. Previously you stayed at the place you were
   * killed for the full three seconds and were teleported at the end, which
   * reads exactly like respawning where you died.
   *
   * Movement and weapons are already inert while `player.alive` is false, so
   * being placed early costs nothing — it just puts the camera somewhere
   * that makes sense.
   */
  net.onSpawnPoint = (pos) => {
    game._pendingSpawn = pos;
    game._placePlayer(pos);
    game.player.velocity.set(0, 0, 0);
  };

  net.onRespawn = (pos) => {
    game.viewModel.holder.visible = true;      // gun back in hand
    game._pendingSpawn = pos;
    game._placePlayer(pos);
    game.player.velocity.set(0, 0, 0);
    game.player.health = game.player.maxHealth;
    game.player.alive = true;
    game.ui.hideRespawn?.();
    game._respawnAt = 0;
    game.input.requestPointerLock?.();
  };

  net.onHit = (h) => {
    /*
     * A HEAL arrives on the same message as damage, with a negative amount.
     *
     * Reusing HIT keeps health flowing through exactly one authoritative
     * path, but everything below this point assumes damage — the red flash,
     * the direction arc, the camera kick, the "damage taken" tally. Running
     * any of that for a health pack would flash the screen red for picking
     * one up.
     */
    if (h.damage < 0) {
      if (h.isSelfVictim) {
        game.player.health = h.hp;
        if (h.armor !== null) game.player.armor = h.armor;
        game.ui.showHeal?.();
      }
      return;
    }

    if (h.isSelfVictim) {
      // Health and armour are both server-owned; mirror them rather than
      // subtracting locally. The client's own absorption maths would fight
      // the server's and lose on the very next update.
      game.player.health = h.hp;
      if (h.armor !== null) game.player.armor = h.armor;
      game.stats.damageTaken += h.damage;

      // Point the damage arc at whoever shot us. Without a direction you
      // have no idea where the fire is coming from, which is the single most
      // disorienting thing about being shot at in a shooter.
      //
      // The attacker's position comes from the interpolated sample, which is
      // where they were drawn when the shot landed — so the arc agrees with
      // what was on screen. Same angle convention as the single-player path
      // above: world bearing, then rotated into the player's own frame.
      let angle = null;
      const shooter = game._netSample?.get(h.attacker);
      if (shooter) {
        game._tmpA.set(shooter.x, shooter.y, shooter.z).sub(game.player.position);
        angle = Math.atan2(game._tmpA.x, game._tmpA.z) - (game.player.yaw + Math.PI);
      }
      game.ui.showDamage(clamp(h.damage / 45, 0.12, 0.6), angle);
      game.audio.play('playerHurt', { volume: 0.8 });
      // Jolt the view away from the shooter, so the round is felt as well as
      // seen. View-only — it never moves where the player is actually aiming.
      if (angle !== null) {
        game.player.kickFromHit(angle, clamp(h.damage / 40, 0.2, 1));
      }
    } else {
      game.remotes.flash(h.victim);
    }
    // showHitmarker(kill, headshot) — the headshot flag has to go in the
    // SECOND slot. Passing it first drew every headshot as a kill marker and
    // meant the headshot marker never appeared at all.
    if (h.isSelfAttacker) {
      game.ui.showHitmarker(false, h.part === 'head');
      // The number floats off the body you hit, so you can read exactly what
      // landed mid-fight instead of guessing from a health bar.
      game._showDamageNumberAt(h.victim, h.damage, { headshot: h.part === 'head' });
    }
  };

  /*
   * Somebody else fired: muzzle flash, tracer and the report.
   *
   * None of this existed. A shot was reported to the server and to nobody
   * else, so the only sign another player was shooting at you was your own
   * health dropping — no flash, no tracer, and complete silence. Players
   * could not tell they were under fire, or that anyone nearby was firing at
   * all, which is most of the information an FPS conveys.
   *
   * The message is deliberately thin — who, from where, which way, with
   * what — and everything below is drawn from the weapon definition this
   * client already has. It is the same data the shooter used for their own
   * flash, so both ends show the same thing.
   */
  net.onFire = (f) => {
    /*
     * Firing puts you on everyone else's map for a couple of seconds.
     *
     * The map deliberately does not show people all the time — in a
     * free-for-all that would remove any reason to be careful. Showing a
     * shooter is the convention most shooters settled on, and it costs
     * nothing here because this relay already exists for the muzzle flash.
     */
    game.minimap?.noteShot(f.shooter);

    const def = getWeaponDef(f.weapon);
    if (!def || !Array.isArray(f.origin)) return;

    // The server relays the shooter's CAMERA position, which is inside their
    // head. Prefer the muzzle of the gun in their hands, so the flash is on
    // the barrel rather than hanging in front of their face.
    game._tmpA.set(f.origin[0], f.origin[1], f.origin[2]);
    const hasBody = game.remotes?.muzzleWorldPosition(f.shooter, game._tmpB);
    const from = hasBody ? game._tmpB : game._tmpA;

    /*
     * How far away it happened decides how much of this is worth building.
     *
     * Every shot in the room now arrives here, and a lobby of players on
     * automatics is a lot of shots — each gunshot is a synthesised graph of
     * a dozen Web Audio nodes, built and torn down. Spending that on someone
     * firing from the far corner of a 120 m arena buys nothing audible.
     */
    const distSq = game._tmpA.distanceToSquared(game.player.position);

    const dir = Array.isArray(f.direction)
      ? _dir.set(f.direction[0], f.direction[1], f.direction[2])
      : _dir.set(0, 0, -1);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();

    // Throwables and hazards have no barrel to flash: a frag going off is an
    // explosion, and drawing a muzzle flash at the blast centre would be
    // nonsense. Their own FX are already driven by the damage they do.
    const silentMuzzle = def.category === 'throwable' || def.category === 'hazard';
    if (!silentMuzzle && def.category !== 'melee') {
      /*
       * The dynamic light only reaches about 12 m, so past that it lights
       * nothing — and there are only six in the pool. Letting a shot from
       * across the map take one would rob a nearby explosion of its flash.
       */
      const lit = distSq < FIRE_LIGHT_RANGE_SQ;
      game.fx.spawnMuzzleFlash(from, dir, def.muzzleScale ?? 1, lit);

      /*
       * A tracer, so a shot that MISSES is still visible — which is the one
       * you most need to see, because it tells you someone is shooting and
       * roughly from where. Traced to the weapon's own range rather than to
       * an impact point: the server does not say what was hit, and a round
       * that hit nothing has no impact point to trace to.
       */
      _tip.copy(dir).multiplyScalar(Math.min(def.range ?? 80, 90)).add(from);
      game.fx.spawnTracer(from, _tip, { width: 0.03 });
    }

    // Positional, so it carries a direction and a distance — the whole point
    // is knowing WHERE the shooting is coming from. Skipped entirely beyond
    // the range at which it would be inaudible anyway; see above.
    if (def.fireSound && distSq < FIRE_AUDIBLE_RANGE_SQ) {
      game.audio.play(def.fireSound, { position: from, volume: 0.85 });
    }
  };

  net.onKill = (k) => {
    game.ui.addKillFeed?.(
      k.attackerName + ' \u2192 ' + k.victimName + (k.headshot ? '  HS' : ''),
      k.isSelfAttacker,
    );
    if (k.isSelfAttacker) {
      game.stats.kills++;
      if (k.headshot) game.stats.headshots++;
      // 'killConfirm' — there is no synth called 'hitConfirm', so this was
      // silently warning to the console and playing nothing on every kill.
      game.audio.play('killConfirm', { volume: 1 });
      // A headshot gets a second, higher note stacked on top, so the two read
      // differently without needing a separate sound.
      if (k.headshot) {
        setTimeout(() => game.audio.play('hitmarkerHead', { volume: 0.9 }), 70);
      }
      // The kill marker is a distinct shape and colour from a hit, because
      // "they are dead" is the one piece of information you must not miss.
      game.ui.showHitmarker(true, k.headshot);
      // Says who, and that the kill put you back on your feet — the health
      // arrives separately as a HEAL from the server.
      game.ui.showBanner?.(
        `${k.headshot ? 'HEADSHOT' : 'ELIMINATED'}  ${k.victimName}`, 1.6);
    }
    if (k.isSelfVictim) {
      game.stats.deaths++;
      game.player.alive = false;
      game.player.health = 0;
      game._respawnAt = performance.now() + 2500;
      game.ui.showRespawn?.(k.attackerName);
      /*
       * Put the gun away while you are dead.
       *
       * The view model kept running its idle and walk sway through the whole
       * countdown, so a corpse stood at the spawn point jogging on the spot
       * with a rifle bobbing in front of it. Nothing else says 'you are dead'
       * as loudly as the weapon simply not being there.
       */
      game.viewModel.holder.visible = false;
      // Anything still in flight belongs to the life that just ended.
      game.weapons?.clearGrenades?.();
      // Deliberately does NOT release pointer lock. Doing so fires
      // onPointerLockChange(false), which pauses the game — so every death
      // threw up the PAUSE menu with a RESUME button, in the middle of a
      // match, for both the victim and after every kill. You stay locked in
      // and watch the respawn counter, which is what a shooter should do.
    }
  };

  net.onScore = (roster) => game.ui.setScoreboard?.(roster, net.selfId, net.match);
  net.onMatch = (match) => {
    game.ui.setScoreboard?.(net.roster(), net.selfId, match);
    if (match.state === MATCH_STATE.OVER) {
      const winner = net.nameOf(match.winnerId);
      game.ui.showBanner((match.winnerId === net.selfId ? 'YOU WIN' : winner + ' WINS'), 4);
      game.ui.setScoreboardVisible?.(true);
    } else if (match.state === MATCH_STATE.LIVE) {
      game.ui.setScoreboardVisible?.(false);
    }
  };

  // Take the body out at once rather than waiting for them to age out of the
  // interpolation buffer, which left a corpse standing for a moment after
  // they had gone — and, until RemotePlayers.remove existed, one that shots
  // still registered against.
  /*
   * Who is coming and going.
   *
   * onJoined was declared by NetworkClient and fired on every arrival, and
   * nothing had ever listened to it — so a friend joining your match produced
   * no notice whatsoever. The scoreboard filled in silently and that was the
   * only clue anyone else was there.
   */
  net.onJoined = (p) => {
    if (p?.n) game.ui.addKillFeed?.(`${p.n} JOINED`);
  };

  net.onLeft = (id, name) => {
    game.remotes.remove(id);
    if (name) game.ui.addKillFeed?.(`${name} LEFT`);
  };

  net.onStateChange = (state, detail) => {
    if (state === NET_STATE.OFFLINE || state === NET_STATE.FAILED) {
      /*
       * Clear the other players when the connection goes, not just when the
       * player chooses to leave.
       *
       * _updateNetwork returns early once the socket is gone, so nothing was
       * ever syncing the bodies again — everyone in the match froze mid-
       * stride and stood there permanently, solid enough to be shot at and
       * never hit. leaveMatch() did clear them, so this only ever happened on
       * a connection actually dropping, which is precisely when the player
       * most needs the world to make sense.
       */
      game.remotes?.clear();
      game.weapons.remoteHitTest = null;
      game.weapons.onShotResolved = null;
    }
    if (state === NET_STATE.OFFLINE && game.hasActiveRun) {
      game.ui.showNetWarning?.(detail || 'Disconnected from the match.');
    }
  };

  net.onDenied = (why) => game.ui.showNetWarning?.(why);

  // Hit registration: the weapon asks who is on the ray, and reports claims.
  game.weapons.remoteHitTest = (origin, dir, maxDist) =>
    (net.connected ? game.remotes.raycast(origin, dir, maxDist) : null);
  game.weapons.onShotResolved = (claims, weaponId) => {
    /*
     * One message per trigger pull, hit or miss.
     *
     * A shotgun reports its whole spread in one message: the server charges
     * one fire-rate token per MESSAGE, so nine pellets sent separately spend
     * nine tokens against a five-token budget and most of the blast is
     * discarded.
     *
     * A MISS is sent too, with an empty claim list. The server relays
     * gunfire to the rest of the room off the back of this message, and
     * while it was only sent on a hit, a shot that missed produced no muzzle
     * flash, no tracer and no report for anybody else — being shot at and
     * missed was completely silent.
     */
    /*
     * The origin has to be where the shot came FROM.
     *
     * It used to send the impact point, which sits on the victim — so the
     * distance the server measured was always about zero. That was harmless
     * while the server only used it to reject impossible ranges, but damage
     * falloff is computed from the same number, and a shot that always looks
     * point-blank never falls off at all.
     *
     * getWorldPosition, not `.position`: the camera is parented, so its
     * local position is not where it is in the world.
     */
    game.camera.getWorldPosition(game._tmpA);
    net.sendShot({
      origin: game._tmpA,
      direction: game._camForward,
      weaponId,
      hits: claims.map((c) => ({ victimId: c.victimId, part: c.part })),
    });
  };
}

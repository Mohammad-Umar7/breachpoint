/**
 * UIManager — the in-game HUD and screen effects.
 *
 * Menus live in `MenuManager`; this class only deals with what is on screen
 * while you are playing. It never reads game state directly — `Game` pushes a
 * small state object into `updateHud()` each frame.
 *
 * Note on the crosshair: the arm gap is derived from the weapon's real spread
 * cone, projected through the camera's FOV into pixels — so what you see is
 * literally where your bullets can go. It fades out as the sights come up,
 * because at that point the weapon's own sight picture is the aiming aid.
 */

import { clamp } from '../core/MathUtils.js';
import {
  TEAM, TEAM_CSS, TEAM_NAME, PLAYING_TEAMS, FLAG_STATE,
  DEFAULT_MODE_ID, getMode,
} from '../net/modes.js';

const SLOT_KEYS = ['1', '2', '3', '4'];

export class UIManager {
  /** @param {import('../core/Settings.js').Settings} settings */
  constructor(settings) {
    this.settings = settings;

    this._killFeed = [];
    this._damageNumbers = [];
    this._toastCount = 0;
    this._bannerTimer = 0;
    this._damageFlash = 0;
    this.statsVisible = false;
    this._slotEls = [];
    this._slotSignature = '';
    this._mode = getMode(DEFAULT_MODE_ID);
    this._teamScores = { [TEAM.RED]: 0, [TEAM.BLUE]: 0 };

    this._cache();
  }

  _cache() {
    const id = (x) => document.getElementById(x);
    this.el = {
      hud: id('hud'),
      crosshair: id('crosshair'),
      hitmarker: id('hitmarker'),
      time: id('hud-time'),
      leader: id('hud-leader'),
      leaderLabel: id('hud-leader-label'),
      room: id('hud-room'),
      ping: id('hud-ping'),
      scoreboard: id('scoreboard'),
      sbRows: id('sb-rows'),
      sbTitle: id('sb-title'),
      sbSub: id('sb-sub'),
      sbHint: id('sb-hint'),
      respawnOverlay: id('respawn-overlay'),
      respawnCount: id('ro-count'),
      respawnKiller: id('ro-killer'),
      killCamTag: id('killcam-tag'),
      killCamName: id('killcam-name'),
      netWarning: id('net-warning'),
      netWarningText: id('net-warning-text'),
      score: id('hud-score'),
      fps: id('hud-fps'),
      statsPanel: id('hud-stats'),
      drawCalls: id('hud-draws'),
      killFeed: id('kill-feed'),
      clickToPlay: id('click-to-play'),
      ctfBar: id('ctf-bar'),
      ctfCarrying: id('ctf-carrying'),
      ctfScore: { 1: id('ctf-red-score'), 2: id('ctf-blue-score') },
      ctfFlag: { 1: id('ctf-red-flag'), 2: id('ctf-blue-flag') },
      ctfYou: { 1: id('ctf-red-you'), 2: id('ctf-blue-you') },
      ctfSide: { 1: id('ctf-red'), 2: id('ctf-blue') },
      banner: id('banner'),
      bannerText: id('banner-text'),
      callsign: id('hud-callsign'),
      spawnShield: id('spawn-shield'),
      healthFill: id('health-fill'),
      healthNum: id('health-num'),
      armorFill: id('armor-fill'),
      armorNum: id('armor-num'),
      breathRow: id('breath-row'),
      breathFill: id('breath-fill'),
      leanIndicator: id('lean-indicator'),
      weaponName: id('weapon-name'),
      ammoMag: id('ammo-mag'),
      ammoReserve: id('ammo-reserve'),
      fireMode: id('fire-mode'),
      zoomTag: id('zoom-tag'),
      reloadHint: id('reload-hint'),
      weaponSlots: id('weapon-slots'),
      reloadRing: id('reload-ring'),
      reloadRingFg: document.querySelector('#reload-ring .ring-fg'),
      pickupToast: id('pickup-toast'),
      damageDirs: id('damage-dirs'),
      damageVignette: id('damage-vignette'),
      hitFlash: id('hit-flash'),
      healFlash: id('heal-flash'),
      lowHealth: id('low-health-pulse'),
      breathVignette: id('breath-vignette'),
    };
    this._leanPips = Array.from(this.el.leanIndicator.querySelectorAll('.lean-pip'));
  }

  // ------------------------------------------------------------------ show
  showHud(visible) {
    this.el.hud.classList.toggle('hidden', !visible);
  }

  /** F3: show/hide the frame-rate and draw-call readout. */
  toggleStats() {
    this.statsVisible = !this.statsVisible;
    this.el.statsPanel.classList.toggle('hidden', !this.statsVisible);
    return this.statsVisible;
  }

  /** Rebuild the weapon slot strip when the loadout changes. */
  buildSlots(slots) {
    const signature = slots.map((s) => s.short).join('|');
    if (signature === this._slotSignature) return;
    this._slotSignature = signature;

    this.el.weaponSlots.innerHTML = '';
    this._slotEls = slots.map((s, i) => {
      const div = document.createElement('div');
      div.className = 'slot';
      div.innerHTML = `<b>${SLOT_KEYS[i] ?? ''}</b>${s.short}`;
      this.el.weaponSlots.appendChild(div);
      return div;
    });
  }

  // =================================================================== HUD
  /**
   * @param {object} s  the frame's HUD state
   * @param {number} dt
   */
  updateHud(s, dt) {
    // --- vitals ---
    const hp = clamp(s.health / s.maxHealth, 0, 1);
    this.el.healthFill.style.width = `${hp * 100}%`;
    this.el.healthFill.classList.toggle('low', hp < 0.3);
    this.el.healthNum.textContent = Math.ceil(s.health);

    /*
     * Your own callsign, so you can see what the rest of the room sees you
     * as. Names hang over every OTHER player and appeared nowhere for
     * yourself, so there was no way to tell whether your own had taken.
     *
     * Only written when it changes: updateHud runs every frame and setting
     * textContent unconditionally would dirty the layout 60 times a second
     * for a string that changes about once a session.
     */
    if (this.el.callsign && s.callsign && this._shownCallsign !== s.callsign) {
      this._shownCallsign = s.callsign;
      this.el.callsign.textContent = s.callsign;
    }

    // Spawn protection. Same once-on-change rule as the callsign above, for
    // the same reason — this toggles twice a life, not sixty times a second.
    if (this.el.spawnShield && this._shownShield !== !!s.spawnProtected) {
      this._shownShield = !!s.spawnProtected;
      this.el.spawnShield.hidden = !s.spawnProtected;
    }

    const ap = clamp(s.armor / s.maxArmor, 0, 1);
    this.el.armorFill.style.width = `${ap * 100}%`;
    this.el.armorNum.textContent = Math.ceil(s.armor);

    /*
     * The low-health pulse describes OUR condition, and during a kill cam the
     * screen is not ours.
     *
     * Dead means zero health, which means this sat at full strength for the
     * whole replay: the entire kill cam was watched through a throbbing red
     * vignette at up to 0.43 opacity. It read as a broken or half-rendered
     * picture rather than as somebody else's view — measured, not guessed.
     */
    this.el.lowHealth.style.opacity =
      (hp < 0.3 && !s.spectating)
        ? String(0.25 + Math.sin(performance.now() / 240) * 0.18 * (1 - hp / 0.3))
        : '0';

    // Same reasoning for the crosshair: it is aiming OUR weapon, and during a
    // replay there is nothing of ours on screen to aim.
    if (this.el.crosshair) {
      this.el.crosshair.style.visibility = s.spectating ? 'hidden' : '';
    }

    // "Click to take control". Assigned only on a change: this runs every
    // frame, and writing `hidden` sixty times a second invalidates style on an
    // element that has not moved.
    if (this.el.clickToPlay && this.el.clickToPlay.hidden === !!s.needsClick) {
      this.el.clickToPlay.hidden = !s.needsClick;
    }

    // --- weapon / ammo ---
    const w = s.weapon;
    this.buildSlots(w.slots);
    this.el.weaponName.textContent = w.name;
    this.el.ammoMag.textContent = w.magazine;
    this.el.ammoReserve.textContent = w.reserve;
    this.el.fireMode.textContent = w.mode;
    const magLow = Number.isFinite(w.magSize) && w.magazine > 0 && w.magazine <= Math.ceil(w.magSize * 0.25);
    this.el.ammoMag.classList.toggle('low', magLow);
    this.el.ammoMag.classList.toggle('empty', w.magazine === 0);
    this.el.reloadHint.classList.toggle('hidden', !(w.needsReload && !w.reloading));

    for (let i = 0; i < this._slotEls.length; i++) {
      this._slotEls[i].classList.toggle('active', i === w.slot);
      this._slotEls[i].classList.toggle('empty', !!w.slots[i]?.empty);
    }

    // --- optic zoom badge ---
    const showZoom = w.scope > 0.3 && w.zoom > 1.5;
    this.el.zoomTag.classList.toggle('hidden', !showZoom);
    if (showZoom) {
      this.el.zoomTag.textContent = `${w.zoom}×${w.zoomSteps > 1 ? ' [B]' : ''}`;
    }

    // --- breath meter (scoped rifles only) ---
    const showBreath = w.scope > 0.35;
    this.el.breathRow.classList.toggle('hidden', !showBreath);
    if (showBreath) {
      this.el.breathFill.style.width = `${clamp(w.breath, 0, 1) * 100}%`;
      this.el.breathVignette.style.opacity = String((1 - w.breath) * 0.85 * w.scope);
    } else {
      this.el.breathVignette.style.opacity = '0';
    }

    // --- lean indicator ---
    const leaning = Math.abs(s.lean) > 0.02;
    this.el.leanIndicator.classList.toggle('active', leaning);
    this._leanPips[0].classList.toggle('on', s.lean < -0.1);
    this._leanPips[1].classList.toggle('on', s.lean > 0.1);

    // --- reload ring ---
    if (w.reloading) {
      this.el.reloadRing.classList.remove('hidden');
      this.el.reloadRingFg.style.strokeDashoffset = String(100 - w.reloadProgress * 100);
    } else {
      this.el.reloadRing.classList.add('hidden');
    }

    // --- crosshair: gap in pixels from the true spread cone ---
    const halfH = window.innerHeight / 2;
    const tanHalfFov = Math.tan((s.fov * Math.PI) / 180 / 2);
    const px = (Math.tan(w.spread) / tanHalfFov) * halfH;
    const scale = this.settings.get('crosshairSize');
    const gap = clamp(px, 3, 110) * scale;
    const style = this.el.crosshair.style;
    style.setProperty('--gap', `${gap.toFixed(1)}px`);
    style.setProperty('--len', `${((6 + gap * 0.14) * scale).toFixed(1)}px`);
    // Fade out as the sights come up; hide entirely inside a scope.
    style.opacity = String(clamp(1 - w.ads * 1.6, 0, 1) * (w.scope > 0.2 ? 0 : 1));

    // --- counters ---
    this.el.score.textContent = String(s.score ?? 0);

    // Match state. Everything here is server-owned, so it simply mirrors
    // whatever the last snapshot said rather than counting locally.
    if (s.match) {
      const secs = Math.max(0, s.match.timeLeft | 0);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      this.el.time.textContent = s.match.state === 'warmup' ? '--:--' : mm + ':' + ss;
      if (s.leader) {
        this.el.leaderLabel.textContent = 'LEADER';
        // 'YOU' when it is you, so the panel reads as a standing rather than
        // as a name badge — which is how it read when it showed a stranger.
        this.el.leader.textContent =
          (s.leader.isSelf ? 'YOU' : s.leader.name) + '  ' + s.leader.kills;
      } else {
        this.el.leaderLabel.textContent = 'STATUS';
        this.el.leader.textContent = 'WAITING';
      }
      this.el.room.textContent = s.room ?? '-----';
      this.el.ping.textContent = s.ping ? String(s.ping) : '--';
    } else {
      this.el.time.textContent = '--:--';
      this.el.leaderLabel.textContent = 'STATUS';
      this.el.leader.textContent = 'OFFLINE';
      this.el.room.textContent = '-----';
      this.el.ping.textContent = '--';
    }

    if (this.statsVisible) {
      this.el.fps.textContent = Math.round(s.fps);
      // Second line carries the multiplayer diagnostics too. `bodies` should
      // match the number of other players; `built` climbing while nobody joins
      // means bodies are being rebuilt every frame, which recompiles shaders
      // and stutters. That distinction is the difference between a network
      // problem and a rendering one, and it is not guessable from feel.
      const net = s.netDebug;
      this.el.drawCalls.textContent =
        `${s.drawCalls} draws · ${(s.triangles / 1000).toFixed(1)}k tris`
        + (net ? ` · ${net.bodies}b buf:${net.interp}ms hit:${net.confirmed}/${net.claimed}` : '');
    }

    // --- damage vignette decay ---
    if (this._damageFlash > 0) {
      this._damageFlash = Math.max(0, this._damageFlash - dt * 1.6);
      this.el.damageVignette.style.opacity = String(this._damageFlash);
    }

    // --- banner ---
    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.el.banner.classList.remove('show');
    }

    this._updateKillFeed(dt);
    this._updateDamageNumbers(dt, s.camera);
  }

  // ------------------------------------------------------------ HUD events
  showHitmarker(kill = false, headshot = false) {
    const hm = this.el.hitmarker;
    hm.classList.remove('show');
    // Three states, three colours — a body hit, a headshot and a kill mean
    // different things and you react to them differently. `head` is a class
    // now rather than an inline drop-shadow so the marker can also change
    // size and stroke, not just glow.
    hm.classList.toggle('kill', kill);
    hm.classList.toggle('head', headshot && !kill);
    void hm.offsetWidth; // force a reflow so rapid hits re-trigger the anim
    hm.classList.add('show');
    hm.style.filter = '';
  }

  addKill(text, points, headshot) {
    const div = document.createElement('div');
    div.className = `kill-entry${headshot ? ' headshot' : ''}`;
    div.innerHTML = `${text}<span class="pts">+${points}</span>`;
    this.el.killFeed.appendChild(div);
    this._killFeed.push({ el: div, life: 4.5 });
    while (this._killFeed.length > 6) {
      const old = this._killFeed.shift();
      old.el.remove();
    }
  }

  _updateKillFeed(dt) {
    for (let i = this._killFeed.length - 1; i >= 0; i--) {
      const k = this._killFeed[i];
      k.life -= dt;
      if (k.life < 0.6) k.el.classList.add('fade');
      if (k.life <= 0) {
        k.el.remove();
        this._killFeed.splice(i, 1);
      }
    }
  }

  showBanner(text, seconds = 2.4, danger = false) {
    this.el.bannerText.textContent = text;
    this.el.banner.classList.toggle('danger', danger);
    this.el.banner.classList.add('show');
    this._bannerTimer = seconds;
  }

  showToast(text, cls = '') {
    if (this._toastCount > 4) return;
    const div = document.createElement('div');
    div.className = `toast ${cls}`;
    div.textContent = text;
    this.el.pickupToast.appendChild(div);
    this._toastCount++;
    setTimeout(() => {
      div.remove();
      this._toastCount--;
    }, 1450);
  }

  /** Red screen edge + a directional arc pointing at the attacker. */
  /**
   * Run once the browser has painted, with a timer as a backstop.
   *
   * The flash effects work by disabling their CSS transition for a single
   * frame so they snap on, then re-enabling it so they fade. If the
   * re-enabling never runs, the flash stays at full opacity — a solid red
   * screen.
   *
   * requestAnimationFrame alone is not safe for that: it stops entirely while
   * a tab is in the background, so being shot and then switching away left the
   * screen stuck red until the next hit. The timer guarantees the cleanup
   * happens either way.
   */
  _afterPaint(fn) {
    let done = false;
    const once = () => { if (done) return; done = true; fn(); };
    requestAnimationFrame(once);
    setTimeout(once, 60);
  }

  showDamage(intensity, angleRad = null) {
    /*
     * Snap ON, fade OUT.
     *
     * The vignette's opacity transition runs in both directions, so setting it
     * on a hit used to RAMP UP over a quarter second — and at any real rate of
     * fire the next hit arrived first, so it never got near full strength.
     * Being shot looked like a faint blush and players could not tell it was
     * happening. Disabling the transition for one frame makes the hit land
     * immediately; re-enabling it lets the recovery stay smooth.
     */
    this._damageFlash = clamp(this._damageFlash + intensity, 0, 0.85);
    const v = this.el.damageVignette;
    v.classList.add('instant');
    v.style.opacity = String(this._damageFlash);
    // Next frame, hand it back to CSS so the decay animates.
    this._afterPaint(() => v.classList.remove('instant'));

    // The sharp part: a hard flash proportional to the round that landed.
    const flash = this.el.hitFlash;
    if (flash) {
      flash.classList.add('instant');
      flash.style.opacity = String(clamp(0.34 + intensity * 0.8, 0.34, 0.95));
      this._afterPaint(() => {
        flash.classList.remove('instant');
        flash.style.opacity = '0';
      });
    }

    if (angleRad !== null && this.settings.get('showHitDirection')) {
      const div = document.createElement('div');
      div.className = 'dmg-dir';
      /*
       * NEGATED, and it matters: CSS rotate() is clockwise while the world
       * bearing here runs anticlockwise, so passing it straight through
       * MIRRORED the indicator. Measured: a shooter on the right painted the
       * arc on the left and vice versa, while ahead and behind — the two
       * directions where a mirror is invisible — looked fine.
       *
       * An indicator pointing the wrong way is worse than none at all, because
       * players turn the wrong way and act on it.
       */
      div.style.transform = `rotate(${-angleRad}rad)`;
      this.el.damageDirs.appendChild(div);
      setTimeout(() => div.remove(), 1150);
    }
  }


  showHeal() {
    this.el.healFlash.style.opacity = '0.75';
    setTimeout(() => { this.el.healFlash.style.opacity = '0'; }, 90);
  }

  addDamageNumber(worldPos, amount, kind = '') {
    if (!this.settings.get('damageNumbers')) return;
    if (this._damageNumbers.length > 18) return;
    const div = document.createElement('div');
    div.className = `dmg-num ${kind}`;
    div.textContent = Math.round(amount);
    this.el.hud.appendChild(div);
    this._damageNumbers.push({ el: div, pos: worldPos.clone(), life: 0.8 });
  }

  _updateDamageNumbers(dt, camera) {
    if (!camera) return;
    for (let i = this._damageNumbers.length - 1; i >= 0; i--) {
      const d = this._damageNumbers[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.el.remove();
        this._damageNumbers.splice(i, 1);
        continue;
      }
      const p = d.pos.clone().project(camera);
      if (p.z > 1) { d.el.style.display = 'none'; continue; }
      d.el.style.display = '';
      d.el.style.left = `${(p.x * 0.5 + 0.5) * window.innerWidth}px`;
      d.el.style.top = `${(-p.y * 0.5 + 0.5) * window.innerHeight}px`;
    }
  }

  /** Clear every transient HUD element (used on restart). */

  // =========================================================== multiplayer
  /**
   * Kill feed line. Distinct from addKill(), which carries a score bonus that
   * deathmatch does not have.
   */
  addKillFeed(text, byMe = false) {
    const div = document.createElement('div');
    div.className = 'kill-entry' + (byMe ? ' headshot' : '');
    div.textContent = text;
    this.el.killFeed.appendChild(div);
    this._killFeed.push({ el: div, life: 5 });
    while (this._killFeed.length > 6) this._killFeed.shift().el.remove();
  }

  /** Convenience wrapper so Game can flash damage without knowing the shape. */
  flashDamage(intensity) { this.showDamage(clamp(intensity, 0.05, 0.85)); }

  setScoreboard(roster, selfId, match) {
    this._roster = roster;
    this._selfId = selfId;
    if (match) {
      this.el.sbSub.textContent = match.killTarget
        ? `FIRST TO ${match.killTarget} ${this._mode.scoreLabel}` : '';
      this.el.sbTitle.textContent = this._mode.name;
    }
    if (!this.el.scoreboard.classList.contains('hidden')) this._renderScoreboard();
  }

  setScoreboardVisible(visible) {
    this.el.scoreboard.classList.toggle('hidden', !visible);
    if (visible) this._renderScoreboard();
  }

  _renderScoreboard() {
    const rows = this._roster ?? [];
    this.el.sbRows.innerHTML = '';

    /*
     * In a team mode the question a player asks the scoreboard is "how is MY
     * SIDE doing", not "where am I in a list of eight". So the rows are split
     * into two blocks under team headers — the ordering within a team still
     * comes from the server, which already sorted the roster.
     */
    if (this._mode.teamBased) {
      for (const team of PLAYING_TEAMS) {
        const mine = rows.filter((p) => p.team === team);
        const head = document.createElement('tr');
        head.className = 'sb-team';
        const th = document.createElement('td');
        th.colSpan = 5;
        th.style.color = TEAM_CSS[team];
        th.textContent = `${TEAM_NAME[team]}  —  ${this._teamScores[team] ?? 0} ${this._mode.scoreLabel}`;
        head.appendChild(th);
        this.el.sbRows.appendChild(head);
        mine.forEach((p, i) => this.el.sbRows.appendChild(this._scoreRow(p, i + 1, team)));
        if (!mine.length) {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 5;
          td.textContent = 'No players';
          tr.appendChild(td);
          this.el.sbRows.appendChild(tr);
        }
      }
      return;
    }

    rows.forEach((p, i) => this.el.sbRows.appendChild(this._scoreRow(p, i + 1)));
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Waiting for players...';
      tr.appendChild(td);
      this.el.sbRows.appendChild(tr);
    }
  }

  /** One scoreboard row. Shared by the flat and the team-grouped layouts. */
  _scoreRow(p, rank, team = null) {
    const tr = document.createElement('tr');
    if (p.id === this._selfId) tr.classList.add('self');
    if (p.alive === false) tr.classList.add('dead');
    if (team) tr.style.borderLeft = `2px solid ${TEAM_CSS[team]}`;
    const score = this._mode.teamBased ? (p.captures ?? 0) : p.kills;
    for (const v of [rank, p.name, score, p.deaths, p.ping || 0]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.appendChild(td);
    }
    return tr;
  }

  /**
   * Switch the HUD between modes.
   *
   * Called once when a match is joined, not per frame: what a mode shows is
   * fixed for the life of a room.
   */
  setMode(modeId) {
    this._mode = getMode(modeId);
    const team = this._mode.teamBased;
    if (this.el.ctfBar) this.el.ctfBar.hidden = !team;
    if (!team && this.el.ctfCarrying) this.el.ctfCarrying.hidden = true;
    /*
     * The leader panel is left alone in both modes.
     *
     * It is written every frame by the connected-HUD block below, so anything
     * set here is overwritten before it is ever seen — and "who has the most
     * kills" is worth knowing in CTF too.
     */
    this.el.sbTitle.textContent = this._mode.name;
    // The KILLS column keeps its meaning in FFA and becomes CAPTURES in CTF.
    const header = document.querySelector('#scoreboard thead th:nth-child(3)');
    if (header) header.textContent = this._mode.scoreLabel;
  }

  /**
   * Both flag states, both team scores, and which side is ours.
   *
   * One call rather than three, because they are read as one thing: "we are
   * two-one up and our flag is out" is a single decision. Called on every
   * flag event AND on every score update — the score arrives in a separate
   * message that lands after the flag one, so a capture that only refreshed
   * this from the flag event showed the old score until something else
   * happened. That was the score appearing not to count.
   *
   * @param {Array} flags       flag payloads: { t, s, c }
   * @param {object} teamScores { [team]: captures }
   * @param {number} carryingTeam  the team whose flag WE hold, or null
   * @param {number} selfTeam   our own team
   */
  setFlags(flags, teamScores, carryingTeam = null, selfTeam = TEAM.NONE) {
    this._teamScores = teamScores ?? this._teamScores;
    for (const team of PLAYING_TEAMS) {
      const el = this.el.ctfScore[team];
      if (el) el.textContent = String(this._teamScores[team] ?? 0);

      /*
       * WHICH ONE IS MINE.
       *
       * Without this the bar reads "HOME / HOME" — perfectly accurate, and
       * useless: it says where both flags are and nothing about which one you
       * are defending. The side you are on is marked and brightened, so the
       * whole strip can be read at a glance during a fight.
       */
      const mine = team === selfTeam;
      if (this.el.ctfYou[team]) this.el.ctfYou[team].hidden = !mine;
      this.el.ctfSide[team]?.classList.toggle('mine', mine);
    }
    for (const f of flags ?? []) {
      const el = this.el.ctfFlag[f.t];
      if (!el) continue;
      el.textContent = f.s === FLAG_STATE.CARRIED ? 'TAKEN'
        : f.s === FLAG_STATE.DROPPED ? 'DROPPED' : 'HOME';
      el.classList.toggle('taken', f.s === FLAG_STATE.CARRIED);
      el.classList.toggle('dropped', f.s === FLAG_STATE.DROPPED);
    }
    if (this.el.ctfCarrying) {
      this.el.ctfCarrying.hidden = !this._mode.teamBased || carryingTeam == null;
    }
    if (!this.el.scoreboard.classList.contains('hidden')) this._renderScoreboard();
  }

  showRespawn(killerName) {
    this.el.respawnKiller.innerHTML = killerName
      ? 'KILLED BY <b>' + escapeHtml(killerName) + '</b>' : 'YOU DIED';
    this.el.respawnOverlay.classList.remove('hidden');
  }

  updateRespawn(seconds) {
    this.el.respawnCount.textContent = String(Math.max(0, seconds));
  }

  hideRespawn() { this.el.respawnOverlay.classList.add('hidden'); }

  /**
   * Say whose eyes we are looking through, or null to take the label away.
   *
   * A viewport that has silently become somebody else's reads as a bug — the
   * camera having come loose, or the game having lost track of you. The label
   * is the difference between "why am I over here" and "oh, that is how he
   * got me".
   */
  setKillCam(name) {
    if (!this.el.killCamTag) return;
    this.el.killCamTag.hidden = !name;
    if (name) this.el.killCamName.textContent = name;
  }

  showNetWarning(text) {
    this.el.netWarningText.textContent = text;
    this.el.netWarning.classList.remove('hidden');
  }

  hideNetWarning() { this.el.netWarning.classList.add('hidden'); }
  resetHud() {
    for (const k of this._killFeed) k.el.remove();
    this._killFeed.length = 0;
    for (const d of this._damageNumbers) d.el.remove();
    this._damageNumbers.length = 0;
    this.el.pickupToast.innerHTML = '';
    this.el.damageDirs.innerHTML = '';
    this._toastCount = 0;
    this._damageFlash = 0;
    this.el.damageVignette.style.opacity = '0';
    this.el.healFlash.style.opacity = '0';
    this.el.lowHealth.style.opacity = '0';
    this.el.breathVignette.style.opacity = '0';
    this.el.banner.classList.remove('show');
    this._bannerTimer = 0;
  }
}

/**
 * Player names are supplied by other clients, so they must never reach
 * innerHTML raw. protocol.sanitizeName strips control and bidi characters
 * server-side, but it does not strip angle brackets — this does.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

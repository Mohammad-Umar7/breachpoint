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
      netWarning: id('net-warning'),
      netWarningText: id('net-warning-text'),
      score: id('hud-score'),
      fps: id('hud-fps'),
      statsPanel: id('hud-stats'),
      drawCalls: id('hud-draws'),
      killFeed: id('kill-feed'),
      banner: id('banner'),
      bannerText: id('banner-text'),
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

    const ap = clamp(s.armor / s.maxArmor, 0, 1);
    this.el.armorFill.style.width = `${ap * 100}%`;
    this.el.armorNum.textContent = Math.ceil(s.armor);

    this.el.lowHealth.style.opacity =
      hp < 0.3 ? String(0.25 + Math.sin(performance.now() / 240) * 0.18 * (1 - hp / 0.3)) : '0';

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
        this.el.leader.textContent = s.leader.name + '  ' + s.leader.kills;
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
    hm.classList.toggle('kill', kill);
    void hm.offsetWidth; // force a reflow so rapid hits re-trigger the anim
    hm.classList.add('show');
    hm.style.filter = headshot ? 'drop-shadow(0 0 4px #ffb43a)' : '';
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
  showDamage(intensity, angleRad = null) {
    this._damageFlash = clamp(this._damageFlash + intensity, 0, 0.85);
    this.el.damageVignette.style.opacity = String(this._damageFlash);

    if (angleRad !== null && this.settings.get('showHitDirection')) {
      const div = document.createElement('div');
      div.className = 'dmg-dir';
      div.style.transform = `rotate(${angleRad}rad)`;
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
      this.el.sbSub.textContent = match.killTarget ? 'FIRST TO ' + match.killTarget : '';
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
    rows.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (p.id === this._selfId) tr.classList.add('self');
      if (p.alive === false) tr.classList.add('dead');
      for (const v of [i + 1, p.name, p.kills, p.deaths, p.ping || 0]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      }
      this.el.sbRows.appendChild(tr);
    });
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Waiting for players...';
      tr.appendChild(td);
      this.el.sbRows.appendChild(tr);
    }
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

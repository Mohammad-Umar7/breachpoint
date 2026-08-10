/**
 * MenuManager — every screen that isn't the HUD.
 *
 * Screens are declarative:
 *   - The loadout browser is generated from `WEAPON_DEFS`, including stat bars
 *     computed from the same numbers the game actually uses.
 *   - The settings panel is generated from `SETTINGS_SCHEMA` below, so adding
 *     an option is a one-line change and can never drift from the markup.
 *
 * Everything writes straight through to `Settings`, which persists to
 * localStorage and notifies the live systems, so changes apply immediately —
 * including while paused mid-firefight.
 */

import { WEAPON_DEFS, CATEGORY_LABELS, opticMagnification } from '../weapons/WeaponDefinitions.js';
import { getPortrait } from '../weapons/WeaponPortrait.js';

/**
 * "Go back to the match", as opposed to going back to a screen.
 *
 * `openLoadout` takes the screen its BACK button should return to, and opening
 * it from inside a match has no screen to name — the answer is "the game".
 * A sentinel rather than null, because null already means the main menu.
 */
export const RESUME_MATCH = '__resume_match__';
import { DEFAULT_SETTINGS } from '../core/Settings.js';
import { RETICLE_STYLES } from '../fx/ScopeRenderer.js';
import { effectiveAimSpeed } from '../core/SensitivityManager.js';
import { clamp } from '../core/MathUtils.js';
import { sanitizeName, hasRealName, DEFAULT_NAME } from '../net/protocol.js';
import { MAPS, getMap, DEFAULT_MAP_ID } from '../world/maps/index.js';
import { MODES, getMode, DEFAULT_MODE_ID } from '../net/modes.js';
import { getThumbnail } from '../world/MapThumbnail.js';

const SCREENS = [
  'screen-loading', 'screen-menu', 'screen-modes', 'screen-maps', 'screen-lobby', 'screen-loadout',
  'screen-controls', 'screen-credits', 'screen-pause', 'screen-settings',
  'screen-gameover', 'screen-error',
];

/** Percentage formatter for 0..1 volume-style values. */
/*
 * A drawn diagram per mode.
 *
 * Drawn rather than photographed because a mode is not a place — a screenshot
 * of CTF and a screenshot of FFA on the same map look identical. What differs
 * is the SHAPE of the game: everybody against everybody, or two sides and two
 * objectives. Keyed by mode id, so a mode without art still gets a card.
 */
const MODE_ART = Object.freeze({
  ffa: `<svg viewBox="0 0 120 72" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="60" cy="36" r="11"/><path d="M60 19v-7M60 60v-7M43 36h-7M84 36h-7"/>
    </g>
    <g fill="currentColor">
      <circle cx="21" cy="18" r="4"/><circle cx="99" cy="20" r="4"/>
      <circle cx="17" cy="55" r="4"/><circle cx="103" cy="54" r="4"/>
      <circle cx="60" cy="8"  r="4"/><circle cx="60" cy="64" r="4"/>
    </g>
    <g stroke="currentColor" stroke-width="1" opacity="0.4">
      <path d="M25 21 55 33M95 23 65 33M21 52 55 40M99 51 65 40M60 12v13M60 60V47"/>
    </g>
  </svg>`,
  ctf: `<svg viewBox="0 0 120 72" aria-hidden="true">
    <g stroke="#e1553f" stroke-width="1.6" fill="none">
      <path d="M18 56V20"/><path d="M18 20h16l-4 6 4 6H18z" fill="#e1553f"/>
      <ellipse cx="18" cy="57" rx="12" ry="4"/>
    </g>
    <g stroke="#4a90d9" stroke-width="1.6" fill="none">
      <path d="M102 56V20"/><path d="M102 20H86l4 6-4 6h16z" fill="#4a90d9"/>
      <ellipse cx="102" cy="57" rx="12" ry="4"/>
    </g>
    <g fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.75">
      <path d="M34 34c14-10 38-10 52 0" stroke-dasharray="4 3"/>
      <path d="M86 34l-6-3M86 34l-5 5"/>
      <path d="M86 48c-14 10-38 10-52 0" stroke-dasharray="4 3"/>
      <path d="M34 48l6 3M34 48l5-5"/>
    </g>
  </svg>`,
});

const pct = (v) => `${Math.round(v * 100)}`;
const two = (v) => v.toFixed(2);
const int = (v) => `${Math.round(v)}`;

const SETTINGS_SCHEMA = {
  mouse: {
    label: 'MOUSE & AIM',
    groups: [
      {
        title: 'Look sensitivity',
        items: [
          { key: 'sensitivity', label: 'Look sensitivity', help: '0.1 slow — 5.0 twitchy', type: 'range', min: 0.1, max: 5, step: 0.05, fmt: two },
          { key: 'sensitivityX', label: 'Horizontal trim', type: 'range', min: 0.5, max: 1.5, step: 0.01, fmt: two },
          { key: 'sensitivityY', label: 'Vertical trim', type: 'range', min: 0.5, max: 1.5, step: 0.01, fmt: two },
        ],
      },
      {
        title: 'Aiming & sniper scopes',
        items: [
          {
            key: 'adsSensitivity',
            label: 'Aim-down-sights speed',
            help: 'Iron sights, red dots and holographics. 1.0 matches hip fire.',
            type: 'range', min: 0.2, max: 2.0, step: 0.01, fmt: two,
          },
          {
            key: 'scopeSensitivity',
            label: 'SNIPER SCOPE speed',
            help: 'Used instead of the value above whenever you look through a sniper scope (AWM, SR-25). Raise this if scoped aiming feels sluggish.',
            type: 'range', min: 0.2, max: 4.0, step: 0.01, fmt: two,
          },
          {
            key: 'zoomCompensation',
            label: 'Zoom slowdown',
            help: '1.0 = magnification slows the view proportionally (a 9× scope turns 9× slower). 0.0 = magnification is ignored and scoped aim turns as fast as hip fire.',
            type: 'range', min: 0, max: 1, step: 0.01, fmt: two,
          },
          {
            type: 'readout',
            label: 'Effective turn speed',
            help: 'How fast the view actually turns compared with hip fire, once every multiplier and the zoom slowdown are applied.',
            compute: (settings) => {
              const sniper = WEAPON_DEFS.find((w) => w.id === 'sniper');
              const rifle = WEAPON_DEFS.find((w) => w.id === 'rifle');
              const ads = effectiveAimSpeed(settings, 'ads', rifle?.adsSensitivity ?? 1,
                opticMagnification(rifle));
              const s5 = effectiveAimSpeed(settings, 'scope', sniper?.adsSensitivity ?? 1, 5);
              const s9 = effectiveAimSpeed(settings, 'scope', sniper?.adsSensitivity ?? 1, 9);
              return `ADS ${ads.toFixed(2)}× · scope 5× ${s5.toFixed(2)}× · 9× ${s9.toFixed(2)}×`;
            },
          },
        ],
      },
      {
        title: 'Behaviour',
        items: [
          { key: 'mouseSmoothing', label: 'Mouse smoothing', help: 'Steadier aim, slightly more latency', type: 'toggle' },
          { key: 'mouseAcceleration', label: 'Mouse acceleration', help: 'Fast flicks travel further', type: 'toggle' },
          { key: 'invertY', label: 'Invert vertical axis', type: 'toggle' },
          { key: 'aimMode', label: 'Aim mode', type: 'select', options: [['hold', 'Hold right mouse'], ['toggle', 'Toggle right mouse']] },
          { key: 'leanMode', label: 'Lean mode', type: 'select', options: [['hold', 'Hold Q / E'], ['toggle', 'Toggle Q / E']] },
        ],
      },
    ],
  },

  graphics: {
    label: 'GRAPHICS',
    groups: [
      {
        title: 'Preset',
        items: [
          { key: 'quality', label: 'Graphics quality', help: 'Sets every option below', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']] },
        ],
      },
      {
        title: 'View',
        items: [
          { key: 'fov', label: 'Field of view', type: 'range', min: 60, max: 120, step: 1, fmt: int },
          { key: 'weaponFov', label: 'Weapon FOV', help: 'Higher makes the view model appear smaller', type: 'range', min: 45, max: 95, step: 1, fmt: int },
          { key: 'renderScale', label: 'Resolution scale', type: 'range', min: 0.5, max: 1, step: 0.05, fmt: two },
        ],
      },
      {
        title: 'Brightness & glare',
        items: [
          {
            key: 'exposure', label: 'Exposure',
            help: 'Overall brightness. Lower this if the sky is washing out.',
            type: 'range', min: 0.5, max: 1.6, step: 0.01, fmt: two,
          },
          {
            key: 'bloomStrength', label: 'Glare / bloom amount',
            help: '0 removes the glow around bright highlights entirely.',
            type: 'range', min: 0, max: 1.0, step: 0.01, fmt: two,
          },
        ],
      },
      {
        title: 'Detail',
        items: [
          { key: 'textureQuality', label: 'Texture quality', help: 'Anisotropic filtering level', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']] },
          { key: 'shadowQuality', label: 'Shadow quality', type: 'select', options: [['off', 'Off'], ['low', 'Low (1024)'], ['medium', 'Medium (2048)'], ['high', 'High (4096)']] },
          { key: 'particleDensity', label: 'Particle density', type: 'range', min: 0.2, max: 1.5, step: 0.05, fmt: two },
        ],
      },
      {
        title: 'Post-processing',
        items: [
          { key: 'antialias', label: 'Anti-aliasing', type: 'toggle' },
          { key: 'bloom', label: 'Bloom', type: 'toggle' },
          { key: 'ssao', label: 'Ambient occlusion', help: 'Costly — Ultra only by default', type: 'toggle' },
          { key: 'motionBlur', label: 'Motion blur', type: 'toggle' },
          { key: 'depthOfField', label: 'Depth of field', help: 'Focuses on whatever you are aiming at', type: 'toggle' },
          { key: 'colorGrade', label: 'Colour correction', type: 'toggle' },
          { key: 'vignette', label: 'Vignette', type: 'toggle' },
        ],
      },
      {
        title: 'Frame pacing',
        items: [
          { key: 'vsync', label: 'V-sync', help: 'Present on every display refresh', type: 'toggle' },
          {
            key: 'maxFps', label: 'Frame rate limit', help: 'Only used when V-sync is off',
            type: 'select', parse: Number,
            options: [[0, 'Unlimited'], [30, '30'], [60, '60'], [75, '75'], [120, '120'], [144, '144'], [240, '240']],
          },
        ],
      },
    ],
  },

  audio: {
    label: 'AUDIO',
    groups: [
      {
        title: 'Levels',
        items: [
          { key: 'masterVolume', label: 'Master', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
          { key: 'sfxVolume', label: 'Sound effects', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
          { key: 'musicVolume', label: 'Music & ambience', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
          { key: 'voiceVolume', label: 'Voice', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
          { key: 'menuVolume', label: 'Menu', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
        ],
      },
    ],
  },

  gameplay: {
    label: 'GAMEPLAY',
    groups: [
      {
        title: 'Challenge',
        items: [
        ],
      },
      {
        title: 'Optics',
        items: [
          {
            key: 'reticleStyle', label: 'Scope reticle',
            help: 'Overrides the reticle every sniper scope uses',
            type: 'select', options: RETICLE_STYLES,
          },
        ],
      },
      {
        title: 'Feel',
        items: [
          {
            key: 'recoilScale', label: 'Recoil intensity',
            help: '0.5 is the relaxed default. 1.0 is the full authored pattern — heavy, but learnable.',
            type: 'range', min: 0, max: 1.5, step: 0.05, fmt: two,
          },
          { key: 'viewBob', label: 'View bobbing', type: 'toggle' },
          { key: 'screenShake', label: 'Screen shake', type: 'range', min: 0, max: 2, step: 0.05, fmt: two },
          { key: 'crosshairSize', label: 'Crosshair size', type: 'range', min: 0.5, max: 2, step: 0.05, fmt: two },
          { key: 'damageNumbers', label: 'Damage numbers', type: 'toggle' },
          { key: 'showHitDirection', label: 'Damage direction indicator', type: 'toggle' },
        ],
      },
    ],
  },
};

export class MenuManager {
  /**
   * @param {import('../core/Settings.js').Settings} settings
   * @param {import('../audio/AudioManager.js').AudioManager} audio
   */
  constructor(settings, audio) {
    this.settings = settings;
    this.audio = audio;
    this.currentScreen = 'screen-loading';
    this.settingsReturnScreen = 'screen-menu';
    this.controlsReturnScreen = 'screen-menu';
    this.activeSettingsTab = 'mouse';
    this.loadoutSlot = 'primary';
    this.selectedWeaponId = settings.get('loadoutPrimary');
    this._controls = [];

    // --- callbacks ---
    this.onCreateMatch = null;   // () -> Promise, resolves when connected
    this.onJoinMatch = null;     // (code) -> Promise
    this.onQuickMatch = null;    // (name) -> Promise, joins a public game
    this.onContinue = null;
    this.onResume = null;
    this.onRestart = null;
    this.onQuitToMenu = null;
    this.onLoadoutChanged = null;
    /** (mapId) -> void — the player picked a map; Game rebuilds the world. */
    this.onMapChosen = null;
    /**
     * What pressing a map card should do next: go straight into a quick match,
     * open the create-match lobby, or nothing at all when the picker was
     * opened from the menu just to browse.
     */
    this._mapIntent = 'browse';

    this._cache();
    this._buildSettingsTabs();
    this._bind();
    this._hookButtonSounds();
    this.refreshTags();
  }

  _cache() {
    const id = (x) => document.getElementById(x);
    this.el = {
      overlay: id('overlay'),
      menuFx: id('menu-fx'),
      loaderBar: id('loader-bar'),
      loaderText: id('loader-text'),
      settingsTabs: id('settings-tabs'),
      settingsBody: id('settings-body'),
      weaponList: id('weapon-list'),
      weaponDetail: id('weapon-detail'),
      menuNameInput: id('menu-name-input'),
      lobbyTitle: id('lobby-title'),
      lobbyStatus: id('lobby-status'),
      lobbyCode: id('lobby-code'),
      lobbyJoinBlock: id('lobby-join-block'),
      lobbyInviteBlock: id('lobby-invite-block'),
      lobbyGoBtn: id('btn-lobby-go'),
      inputName: id('input-name'),
      inputRoom: id('input-room'),
      menuMapTag: id('menu-map-tag'),
      mapGrid: id('map-grid'),
      mapsSub: id('maps-sub'),
      modeGrid: id('mode-grid'),
      modesSub: id('modes-sub'),
      menuPrimaryTag: id('menu-primary-tag'),
      menuSecondaryTag: id('menu-secondary-tag'),
      loadoutPrimaryTag: id('loadout-primary-tag'),
      loadoutSecondaryTag: id('loadout-secondary-tag'),
      continueBtn: id('btn-continue'),
      gameoverStats: id('gameover-stats'),
      errorText: id('error-text'),
    };
  }

  // ---------------------------------------------------------------- screens
  showScreen(name) {
    for (const s of SCREENS) {
      document.getElementById(s)?.classList.toggle('active', s === name);
    }
    this.currentScreen = name;
    // The population poll belongs to the two pickers and nothing else. Left
    // running it would keep hitting the server for the whole match.
    if (name !== 'screen-maps' && name !== 'screen-modes') this._stopPopulationPolling();
    this.el.overlay.classList.remove('hidden');
    this.el.menuFx.style.display = name === 'screen-menu' ? '' : 'none';

    // Focus the first control so keyboard navigation just works.
    const first = document.querySelector(`#${name} button:not(.hidden)`);
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }

  hideOverlay() {
    this._stopPopulationPolling();
    this.el.overlay.classList.add('hidden');
    for (const s of SCREENS) document.getElementById(s)?.classList.remove('active');
    this.currentScreen = null;
  }

  setLoadingProgress(fraction, label) {
    this.el.loaderBar.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
    if (label) this.el.loaderText.textContent = label;
  }

  showError(message) {
    this.el.errorText.textContent = message;
    this.showScreen('screen-error');
  }

  /** Show or hide the CONTINUE entry depending on whether a run is paused. */
  setCanContinue(can) {
    this.el.continueBtn.classList.toggle('hidden', !can);
  }

  showResults(stats) {
    this.el.gameoverStats.innerHTML = stats
      .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
      .join('');
    this.showScreen('screen-gameover');
  }

  // ---------------------------------------------------------------- binding
  _bind() {
    const click = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    click('btn-continue', () => this.onContinue?.());
    click('btn-resume', () => this.onResume?.());
    click('btn-restart-over', () => this.onRestart?.());
    click('btn-quit', () => this.onQuitToMenu?.());
    click('btn-menu-over', () => this.onQuitToMenu?.());
    click('btn-error-reload', () => window.location.reload());

    /*
     * The callsign has to be saved as it is typed.
     *
     * PLAY reads `playerName` from settings, and the only thing that ever wrote
     * it was the CREATE/JOIN lobby. Anyone who only pressed PLAY was called
     * OPERATOR to everyone else no matter what they did.
     */
    this.el.menuNameInput?.addEventListener('input', () => {
      this.settings.set('playerName', sanitizeName(this.el.menuNameInput.value, ''));
    });

    /*
     * Choosing a map is a STEP OF STARTING A MATCH, not a menu of its own.
     *
     * PLAY and CREATE open the picker; picking a card goes straight in. There
     * is deliberately no way to sit on the picker doing nothing, because a
     * screen you can reach and then have to back out of is a dead end.
     *
     * JOIN skips it entirely: joining a code means playing whatever that room
     * is playing, so offering a choice would be a lie the server overrides a
     * second later.
     */
    click('btn-play', () => this.openModePicker('quick'));
    click('btn-create', () => this.openModePicker('create'));
    click('btn-join', () => this.openLobby('join'));
    click('btn-lobby-go', () => this._lobbyGo());
    click('btn-copy-invite', () => this._copyInvite());
    click('btn-credits', () => this.showScreen('screen-credits'));
    click('btn-loadout', () => this.openLoadout('screen-menu'));
    click('btn-loadout-pause', () => this.openLoadout('screen-pause'));
    /*
     * BACK from the loadout goes wherever it was opened FROM, and one of those
     * places is the match itself — B opens it mid-game, so its BACK has to put
     * the player back in the game rather than into a pause menu they never
     * asked for. That is what the sentinel means.
     */
    click('btn-loadout-back', () => {
      if (this.loadoutReturnScreen === RESUME_MATCH) { this.onResumeFromLoadout?.(); return; }
      this.showScreen(this.loadoutReturnScreen || 'screen-menu');
    });
    click('btn-controls', () => { this.controlsReturnScreen = 'screen-menu'; this.showScreen('screen-controls'); });
    click('btn-controls-pause', () => { this.controlsReturnScreen = 'screen-pause'; this.showScreen('screen-controls'); });

    click('btn-settings-menu', () => this.openSettings('screen-menu'));
    click('btn-settings-pause', () => this.openSettings('screen-pause'));
    click('btn-settings-back', () => this.showScreen(this.settingsReturnScreen));
    click('btn-reset-settings', () => {
      this.settings.resetToDefaults();
      this.renderSettings();
      this.refreshTags();
    });
    click('btn-reset-section', () => {
      const keys = this._tabKeys(this.activeSettingsTab);
      this.settings.resetSection(keys);
      this.renderSettings();
      this.refreshTags();
    });

    for (const btn of document.querySelectorAll('[data-back]')) {
      btn.addEventListener('click', () => {
        const target = btn.dataset.back === 'screen-menu' && this.currentScreen === 'screen-controls'
          ? this.controlsReturnScreen
          : btn.dataset.back;
        this.showScreen(target);
      });
    }

    for (const tab of document.querySelectorAll('[data-loadout-slot]')) {
      tab.addEventListener('click', () => {
        this.loadoutSlot = tab.dataset.loadoutSlot;
        for (const t of document.querySelectorAll('[data-loadout-slot]')) {
          t.classList.toggle('active', t === tab);
        }
        this.selectedWeaponId = this.settings.get(
          this.loadoutSlot === 'primary' ? 'loadoutPrimary' : 'loadoutSecondary'
        );
        this.renderLoadout();
      });
    }
  }

  /** Hover / click feedback on every button in the overlay. */
  _hookButtonSounds() {
    this.el.overlay.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('button, .diff-card, .weapon-row');
      if (btn && !btn.disabled) this.audio?.play('menuHover');
    });
    this.el.overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('button, .diff-card, .weapon-row');
      if (!btn || btn.disabled) return;
      /*
       * WAKE THE AUDIO HERE. This is the first user gesture there is.
       *
       * The AudioContext was only ever created inside `startGame`, which is
       * reached from a network handshake rather than from a click — so the
       * entire front end was mute until you had been in a match, and a player
       * who never connected heard nothing all session. Every sound above was
       * being played into a context that did not exist yet and dropped.
       *
       * Both calls are idempotent, and a click IS the user activation a
       * context needs. Creating one at construction time instead would look
       * equivalent and fail differently: it would start `suspended`, and
       * `_canPlay` only rejects `closed`, so every sound would be scheduled
       * into a dead context and silently lost.
       *
       * The very first HOVER is still silent — `mouseover` is not a user
       * activation, so nothing can legally start a context there.
       */
      this.audio?.init?.();
      this.audio?.resume?.();
      const back = btn.classList.contains('back-btn') || btn.dataset.back;
      this.audio?.play(back ? 'menuBack' : 'menuSelect');
    });
  }

  // --------------------------------------------------------------- loadout
  /**
   * @param {string} [returnScreen] where BACK goes — the pause menu when this
   *   was opened mid-match, so changing weapons never means leaving the game.
   */
  openLoadout(returnScreen = 'screen-menu') {
    this.loadoutReturnScreen = returnScreen;
    this.loadoutSlot = 'primary';
    for (const t of document.querySelectorAll('[data-loadout-slot]')) {
      t.classList.toggle('active', t.dataset.loadoutSlot === 'primary');
    }
    this.selectedWeaponId = this.settings.get('loadoutPrimary');
    this.renderLoadout();
    this.showScreen('screen-loadout');
  }

  renderLoadout() {
    const slot = this.loadoutSlot;
    const equippedId = this.settings.get(slot === 'primary' ? 'loadoutPrimary' : 'loadoutSecondary');
    const options = WEAPON_DEFS.filter((w) => w.slot === slot);

    // --- list ---
    this.el.weaponList.innerHTML = '';
    for (const def of options) {
      const row = document.createElement('button');
      row.className = 'weapon-row';
      row.classList.toggle('selected', def.id === this.selectedWeaponId);
      // The photograph the game took of this weapon, if it has one. A missing
      // portrait leaves the slot empty rather than substituting a stand-in —
      // an icon that is not the gun is worse than no picture at all.
      const shot = getPortrait(def.id);
      row.innerHTML = `
        <span class="wshot">${shot ? `<img src="${shot}" alt="" draggable="false">` : ''}</span>
        <span class="wtext">
          <span class="wname">${def.name}</span>
          <span class="wcat">${CATEGORY_LABELS[def.category] ?? def.category}</span>
        </span>
        ${def.id === equippedId ? '<span class="equipped">EQUIPPED</span>' : ''}
      `;
      row.addEventListener('click', () => {
        this.selectedWeaponId = def.id;
        this.settings.set(slot === 'primary' ? 'loadoutPrimary' : 'loadoutSecondary', def.id);
        this.renderLoadout();
        this.refreshTags();
        this.onLoadoutChanged?.();
      });
      this.el.weaponList.appendChild(row);
    }

    // --- detail ---
    const def = options.find((w) => w.id === this.selectedWeaponId) ?? options[0];
    if (!def) return;
    const s = weaponStats(def);
    const mag = opticMagnification(def);
    const tags = [
      CATEGORY_LABELS[def.category] ?? def.category,
      def.burstCount > 1 ? `${def.burstCount}-RND BURST` : def.automatic ? 'FULL AUTO' : 'SEMI AUTO',
      def.optic?.scoped ? `SCOPE ${mag}×` : def.optic?.type === 'reddot' ? 'RED DOT'
        : def.optic?.type === 'holo' ? 'HOLOGRAPHIC' : 'IRON SIGHTS',
      def.pellets > 1 ? `${def.pellets} PELLETS` : null,
      def.projectile ? 'BULLET DROP' : null,
      def.boltTime ? 'BOLT ACTION' : null,
      def.reloadType === 'shells' ? 'SHELL RELOAD' : null,
    ].filter(Boolean);

    const hero = getPortrait(def.id);
    this.el.weaponDetail.innerHTML = `
      <div class="wstage${hero ? '' : ' empty'}">
        ${hero ? `<img src="${hero}" alt="${def.name}" draggable="false">` : ''}
        <span class="wstage-cat">${CATEGORY_LABELS[def.category] ?? def.category}</span>
      </div>
      <h4>${def.name}</h4>
      <div class="detail-tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>
      <p class="desc">${def.description ?? ''}</p>
      ${statBar('DAMAGE', s.damage, s.damageText)}
      ${statBar('FIRE RATE', s.rate, `${def.rpm} rpm`)}
      ${statBar('ACCURACY', s.accuracy, `${def.spreadBase.toFixed(2)}°`)}
      ${statBar('RANGE', s.range, `${Math.round(def.falloffEnd)} m`)}
      ${statBar('CONTROL', s.control, s.controlText)}
      ${statBar('MOBILITY', s.mobility, `${Math.round((def.moveSpeedMul ?? 1) * 100)}%`)}
      ${statBar('ADS SPEED', s.adsSpeed, `${Math.round(def.adsTime * 1000)} ms`)}
      <div class="stat-row"><span>MAGAZINE</span><span class="track"></span>
        <span class="val">${Number.isFinite(def.magSize) ? def.magSize : '∞'}</span></div>
    `;

    this.el.loadoutPrimaryTag.textContent = shortName(this.settings.get('loadoutPrimary'));
    this.el.loadoutSecondaryTag.textContent = shortName(this.settings.get('loadoutSecondary'));
  }

  // -------------------------------------------------------------- settings
  openSettings(returnTo) {
    this.settingsReturnScreen = returnTo;
    this.renderSettings();
    this.showScreen('screen-settings');
  }

  _buildSettingsTabs() {
    const host = this.el.settingsTabs;
    host.innerHTML = '';
    for (const [key, section] of Object.entries(SETTINGS_SCHEMA)) {
      const tab = document.createElement('button');
      tab.className = 'tab';
      tab.textContent = section.label;
      tab.dataset.tab = key;
      tab.addEventListener('click', () => {
        this.activeSettingsTab = key;
        this.renderSettings();
      });
      host.appendChild(tab);
    }
  }

  _tabKeys(tab) {
    const section = SETTINGS_SCHEMA[tab];
    if (!section) return [];
    // `readout` rows are display-only and have no key.
    return section.groups.flatMap((g) => g.items.map((i) => i.key).filter(Boolean));
  }

  /** Re-evaluate every computed display row in the open tab. */
  _refreshReadouts() {
    for (const c of this._controls) {
      if (c.item.type === 'readout') c.out.textContent = c.item.compute(this.settings);
    }
  }

  /** Rebuild the settings panel for the active tab. */
  renderSettings() {
    for (const tab of this.el.settingsTabs.children) {
      tab.classList.toggle('active', tab.dataset.tab === this.activeSettingsTab);
    }

    const section = SETTINGS_SCHEMA[this.activeSettingsTab];
    const body = this.el.settingsBody;
    body.innerHTML = '';
    this._controls.length = 0;

    for (const group of section.groups) {
      const wrap = document.createElement('div');
      wrap.className = 'settings-group';
      const h = document.createElement('h3');
      h.textContent = group.title;
      wrap.appendChild(h);

      for (const item of group.items) wrap.appendChild(this._buildControl(item));
      body.appendChild(wrap);
    }
  }

  _buildControl(item) {
    const row = document.createElement('label');
    row.className = 'setting';

    const labelWrap = document.createElement('span');
    labelWrap.className = 's-label';
    const title = document.createElement('span');
    title.textContent = item.label;
    labelWrap.appendChild(title);
    if (item.help) {
      const help = document.createElement('span');
      help.className = 's-help';
      help.textContent = item.help;
      labelWrap.appendChild(help);
    }
    row.appendChild(labelWrap);

    const out = document.createElement('output');
    const value = this.settings.get(item.key);

    if (item.type === 'readout') {
      // Display-only row: no control, just a computed value that tracks the
      // sliders above it.
      row.classList.add('readout');
      const spacer = document.createElement('span');
      row.appendChild(spacer);
      out.textContent = item.compute(this.settings);
      out.classList.add('wide');
      row.appendChild(out);
      this._controls.push({ item, input: null, out });
      return row;
    }

    if (item.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = item.min;
      input.max = item.max;
      input.step = item.step;
      input.value = value;
      const fmt = item.fmt ?? two;
      out.textContent = fmt(value);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.settings.set(item.key, v);
        out.textContent = fmt(v);
        this._refreshReadouts();
      });
      row.appendChild(input);
      this._controls.push({ item, input, out });
    } else if (item.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => {
        this.settings.set(item.key, input.checked);
        // Toggling a governed option moves the preset to "custom".
        if (this.activeSettingsTab === 'graphics') this._refreshQualitySelect();
      });
      row.appendChild(input);
      this._controls.push({ item, input, out });
    } else {
      const select = document.createElement('select');
      for (const [val, label] of item.options) {
        const opt = document.createElement('option');
        opt.value = String(val);
        opt.textContent = label;
        select.appendChild(opt);
      }
      select.value = String(value);
      select.addEventListener('change', () => {
        const parsed = item.parse ? item.parse(select.value) : select.value;
        this.settings.set(item.key, parsed);
        // A preset change rewrites its governed options — redraw the tab.
        if (item.key === 'quality') this.renderSettings();
      });
      row.appendChild(select);
      this._controls.push({ item, input: select, out });
    }

    row.appendChild(out);
    return row;
  }

  _refreshQualitySelect() {
    const ctrl = this._controls.find((c) => c.item.key === 'quality');
    if (!ctrl) return;
    ctrl.out.textContent = this.settings.matchesPreset() ? '' : 'custom';
  }

  // ----------------------------------------------------------------- lobby
  /**
   * @param {'create'|'join'} mode
   * @param {string} [prefillCode] room code lifted from an invite link
   */
  /**
   * @param mode 'create' | 'join' | 'quick'
   *
   * 'quick' is the callsign step in front of PLAY, shown only to somebody who
   * has never set one. The name field used to live exclusively on the
   * create/join screens, so anyone who pressed PLAY — the button most people
   * press — went into the match as OPERATOR with nowhere obvious to change it.
   */
  openLobby(mode, prefillCode = '') {
    this.lobbyMode = mode;
    this.el.lobbyTitle.textContent = mode === 'create' ? 'CREATE MATCH'
      : mode === 'quick' ? 'YOUR CALLSIGN' : 'JOIN MATCH';
    this.el.lobbyGoBtn.textContent = mode === 'create' ? 'CREATE'
      : mode === 'quick' ? 'PLAY' : 'JOIN';
    this.el.lobbyJoinBlock.classList.toggle('hidden', mode !== 'join');
    this.el.lobbyInviteBlock.classList.add('hidden');
    this.setLobbyStatus('');
    this.el.inputName.value = hasRealName(this.settings.get('playerName'))
      ? this.settings.get('playerName') : '';
    if (prefillCode) this.el.inputRoom.value = prefillCode;
    this.showScreen('screen-lobby');
    // Focus whichever field the player still has to fill in.
    const focusTarget = mode === 'join' && !prefillCode ? this.el.inputRoom : this.el.inputName;
    setTimeout(() => focusTarget?.focus({ preventScroll: true }), 40);
  }

  setLobbyStatus(text, kind = '') {
    const el = this.el.lobbyStatus;
    if (!el) return;
    el.textContent = text;
    el.className = `lobby-status ${kind}`;
  }

  /** Show the code and invite link once a match exists. */
  showInvite(room) {
    this.el.lobbyCode.textContent = room;
    this.el.lobbyInviteBlock.classList.remove('hidden');
    this.el.lobbyJoinBlock.classList.add('hidden');
  }

  async _lobbyGo() {
    const name = this.el.inputName.value.trim();
    if (name) this.settings.set('playerName', name);
    this.refreshTags();

    if (this.lobbyMode === 'quick') {
      this.setLobbyStatus('Finding a match…');
      this.el.lobbyGoBtn.disabled = true;
      try {
        await this.onQuickMatch?.(name || DEFAULT_NAME, (t) => this.setLobbyStatus(t));
      } catch (err) {
        this.setLobbyStatus(err?.message ? String(err.message).slice(0, 60) : 'could not connect', 'error');
      } finally { this.el.lobbyGoBtn.disabled = false; }
      return;
    }

    if (this.lobbyMode === 'join') {
      const code = this.el.inputRoom.value.trim().toUpperCase();
      if (code.length !== 5) {
        this.setLobbyStatus('A match code is 5 characters.', 'error');
        return;
      }
      this.setLobbyStatus('Connecting…');
      this.el.lobbyGoBtn.disabled = true;
      try { await this.onJoinMatch?.(code, name); }
      finally { this.el.lobbyGoBtn.disabled = false; }
      return;
    }

    this.setLobbyStatus('Creating match…');
    this.el.lobbyGoBtn.disabled = true;
    try { await this.onCreateMatch?.(name); }
    finally { this.el.lobbyGoBtn.disabled = false; }
  }

  // =============================================================== map picker
  /**
   * Show the maps and let the player choose one.
   *
   * The cards are BUILT FROM THE REGISTRY, never written in the markup. A
   * third map is a file in `world/maps/` and a line in `maps/index.js`, and
   * this screen picks it up with no changes at all — which is the whole reason
   * the registry exists.
   *
   * @param {'quick'|'create'|'browse'} intent  what selecting a map does next
   */
  /**
   * Choose the mode, then the map.
   *
   * Mode first because it is the bigger decision: it changes the objective,
   * whether there are teams at all, and what winning means. A player who picks
   * a map first has chosen scenery before knowing the game.
   */
  openModePicker(intent = 'browse') {
    this._mapIntent = intent;
    if (this.el.modesSub) {
      this.el.modesSub.textContent = intent === 'create'
        ? 'Pick a mode, then a map — your friends join with the code.'
        : 'Pick a mode, then a map.';
    }
    this._renderModeCards();
    this.showScreen('screen-modes');
    this._startPopulationPolling();
  }

  _renderModeCards() {
    const grid = this.el.modeGrid;
    if (!grid) return;
    const current = this.settings.get('modeId') ?? DEFAULT_MODE_ID;
    grid.innerHTML = '';

    for (const mode of Object.values(MODES)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mode-card' + (mode.id === current ? ' selected' : '');
      card.style.setProperty('--mode-accent', mode.accent);
      card.dataset.modeId = mode.id;

      const art = document.createElement('div');
      art.className = 'mode-art';
      art.innerHTML = MODE_ART[mode.id] ?? '';

      const body = document.createElement('div');
      body.className = 'mode-body';
      body.innerHTML =
        `<h3>${escapeHtml(mode.name)}</h3>`
        + `<p class="mode-tagline">${escapeHtml(mode.tagline)}</p>`
        + `<p class="mode-desc">${escapeHtml(mode.description)}</p>`
        + `<div class="mode-stats">`
        + `<span><b>${mode.teamBased ? 'TEAMS' : 'SOLO'}</b>sides</span>`
        + `<span><b>${mode.scoreTarget}</b>to win</span>`
        + `</div>`;

      /*
       * How many are playing THIS MODE, across every map.
       *
       * Summed here rather than served pre-aggregated: the server reports by
       * map with a mode breakdown inside, which is the shape the map cards
       * need, and rolling it up the other way is two lines.
       */
      const pop = this._population;
      if (pop) {
        const total = Object.values(pop.maps ?? {})
          .reduce((sum, m) => sum + (m.modes?.[mode.id] ?? 0), 0);
        const badge = document.createElement('span');
        badge.className = 'mode-pop' + (total ? ' live' : '');
        badge.textContent = total ? `${total} PLAYING` : 'NOBODY PLAYING';
        art.appendChild(badge);
      }

      const cta = document.createElement('span');
      cta.className = 'mode-cta';
      cta.textContent = mode.id === current ? 'SELECTED' : 'SELECT';

      card.append(art, body, cta);
      card.addEventListener('click', () => this._chooseMode(mode.id));
      grid.appendChild(card);
    }
  }

  _chooseMode(modeId) {
    this.settings.set('modeId', getMode(modeId).id);
    this.audio?.play?.('menuSelect', { volume: 0.6 });
    this.refreshTags();
    this.openMapPicker(this._mapIntent);
  }

  openMapPicker(intent = 'browse') {
    this._deploying = false;
    this._mapIntent = intent;
    if (this.el.mapsSub) {
      this.el.mapsSub.textContent = intent === 'browse'
        ? 'Choose where to fight. Your pick is remembered.'
        : intent === 'create'
          ? 'Pick a map, then share the code with your friends.'
          : 'Pick a map and drop straight into a match.';
    }
    this._renderMapCards();
    this.showScreen('screen-maps');
    this._startPopulationPolling();
    // Going back from the map picker should undo one step, not all of them.
    const back = document.querySelector('#screen-maps [data-back]');
    if (back) back.dataset.back = intent === 'browse' ? 'screen-menu' : 'screen-modes';
  }

  /**
   * Who is playing where, refreshed while a picker is open.
   *
   * Polled rather than pushed because the menu has no socket yet — that is the
   * whole point of showing it here, so a player can see where the people are
   * before committing to a map. Ten seconds is slow enough to be free and fast
   * enough that a match filling up is visible while you are still deciding.
   *
   * Every failure is silent and simply shows nothing. A count is a
   * nice-to-have, and a menu that broke because a stats request timed out
   * would be a far worse bug than a missing line of text.
   */
  _startPopulationPolling() {
    this._stopPopulationPolling();
    const tick = async () => {
      const data = await this.onPopulation?.();
      // Ignore a reply that arrives after the player has left the picker —
      // otherwise a slow response repaints a screen nobody is looking at.
      if (!this._popTimer) return;
      this._population = data;
      if (this.currentScreen === 'screen-maps') this._renderMapCards();
      else if (this.currentScreen === 'screen-modes') this._renderModeCards();
    };
    this._popTimer = setInterval(tick, 10000);
    tick();
  }

  _stopPopulationPolling() {
    if (this._popTimer) clearInterval(this._popTimer);
    this._popTimer = 0;
  }

  /**
   * The "N PLAYING" line for one map, or null when there is nothing to say.
   *
   * Null rather than "0 PLAYING" when the server could not be reached: an
   * empty server and an unreachable one look identical to a player, and
   * claiming a map is dead when the truth is that we do not know is the one
   * outcome worth avoiding — it would talk people out of the map they picked.
   */
  _populationFor(mapId) {
    const pop = this._population;
    if (!pop) return null;
    const entry = pop.maps?.[mapId];
    const players = entry?.players ?? 0;
    // Filter to the mode being chosen, when one has been: "3 playing" is
    // misleading if all three are in a game type you are not about to join.
    const modeId = this.settings.get('modeId');
    const inMode = entry?.modes?.[modeId];
    return {
      players,
      rooms: entry?.rooms ?? 0,
      inMode: typeof inMode === 'number' ? inMode : null,
      modeId,
    };
  }

  _renderMapCards() {
    const grid = this.el.mapGrid;
    if (!grid) return;
    const current = this.settings.get('mapId') ?? DEFAULT_MAP_ID;
    grid.innerHTML = '';

    for (const map of MAPS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'map-card' + (map.id === current ? ' selected' : '');
      // The map's own accent drives the card, so a new map brings its palette
      // with it rather than needing a stylesheet edit.
      card.style.setProperty('--map-accent', map.accent);
      card.dataset.mapId = map.id;

      const art = document.createElement('div');
      art.className = 'map-art';
      art.style.background =
        `linear-gradient(135deg, ${map.swatch[0]} 0%, ${map.swatch[1]} 55%, ${map.swatch[2]} 100%)`;

      /*
       * A real photograph of the map if the game has taken one, otherwise the
       * drawn plan.
       *
       * The photo is far more use — it shows materials, light and scale, not
       * just footprints — but it only exists once that map has been built at
       * least once in this browser. See world/MapThumbnail.js.
       */
      const shot = getThumbnail(map.id);
      if (shot) {
        const img = document.createElement('img');
        img.className = 'map-shot';
        img.src = shot;
        img.alt = `${map.name} seen from above`;
        art.appendChild(img);
      } else {
        const plan = document.createElement('canvas');
        plan.className = 'map-plan';
        plan.width = 200;
        plan.height = 200;
        drawPlan(plan, map);
        art.appendChild(plan);
      }

      const scale = document.createElement('span');
      scale.className = 'map-scale';
      scale.textContent = map.scale;
      art.appendChild(scale);

      /*
       * A live population badge, top-left of the art so it reads against the
       * photograph rather than competing with the stats row below.
       */
      const pop = this._populationFor(map.id);
      if (pop) {
        const badge = document.createElement('span');
        badge.className = 'map-pop' + (pop.players ? ' live' : '');
        badge.textContent = pop.players
          ? `${pop.players} PLAYING${pop.inMode != null && pop.inMode !== pop.players
              ? ` · ${pop.inMode} IN ${getMode(pop.modeId).short}` : ''}`
          : 'EMPTY';
        badge.title = pop.players
          ? `${pop.players} player${pop.players === 1 ? '' : 's'} across ${pop.rooms} public match${pop.rooms === 1 ? '' : 'es'}`
          : 'No public matches running on this map';
        art.appendChild(badge);
      }

      const body = document.createElement('div');
      body.className = 'map-body';
      body.innerHTML =
        `<h3>${escapeHtml(map.name)}</h3>`
        + `<p class="map-tagline">${escapeHtml(map.tagline)}</p>`
        + `<p class="map-desc">${escapeHtml(map.description)}</p>`
        + `<div class="map-stats">`
        + `<span><b>${escapeHtml(map.span)}</b>across</span>`
        + `<span><b>${escapeHtml(map.players)}</b>players</span>`
        + `</div>`;

      const cta = document.createElement('span');
      cta.className = 'map-cta';
      cta.textContent = this._mapIntent === 'browse'
        ? (map.id === current ? 'SELECTED' : 'SELECT')
        : this._mapIntent === 'create' ? 'CREATE HERE' : 'DEPLOY';

      card.append(art, body, cta);
      card.addEventListener('click', () => this._chooseMap(map.id));
      grid.appendChild(card);
    }
  }

  /**
   * Commit to a map, then do whatever the picker was opened to do.
   *
   * The rebuild happens BEFORE connecting, on purpose. Building the world is
   * the slow part, and doing it after the socket is up means arriving in a
   * live match and then freezing for a second while the arena appears.
   */
  async _chooseMap(mapId) {
    if (this._deploying) return;
    const map = getMap(mapId);
    this.settings.set('mapId', map.id);
    this.onMapChosen?.(map.id);
    this.refreshTags();

    if (this._mapIntent === 'create') { this.openLobby('create'); return; }
    if (this._mapIntent === 'quick') { await this._quickMatch(map.id); return; }
    // Browsing: stay put and show the new selection.
    this._renderMapCards();
  }

  /**
   * Lock the picker while a match is being joined, and say what is happening.
   *
   * Connecting is not instant and can be very slow — a free-tier server that
   * has gone to sleep takes the better part of a minute to answer its first
   * request. Left as it was, the map screen sat there fully interactive: the
   * card you clicked looked unchanged, the other card was still clickable, and
   * BACK still worked. People clicked again, or went back and forth, and every
   * one of those started ANOTHER connection attempt behind the first.
   *
   * So: one card holds the status, everything else stops responding, and there
   * is no way out until it succeeds or fails. Failure unlocks it and says why.
   */
  _setDeploying(mapId, busy) {
    this._deploying = busy;
    this.el.mapGrid?.classList.toggle('busy', busy);
    const back = document.querySelector('#screen-maps [data-back]');
    if (back) back.disabled = busy;

    for (const card of this.el.mapGrid?.querySelectorAll('.map-card') ?? []) {
      const chosen = card.dataset.mapId === mapId;
      card.classList.toggle('deploying', busy && chosen);
      card.classList.toggle('waiting', busy && !chosen);
      // `disabled` rather than a click guard, so it is unfocusable and reads as
      // unavailable to a screen reader too.
      card.disabled = busy;
    }
  }

  /** Write progress onto the card that is being deployed to. */
  _deployStatus(mapId, text) {
    const card = this.el.mapGrid
      ?.querySelector(`.map-card[data-map-id="${mapId}"] .map-cta`);
    if (card) card.textContent = text;
  }

  /**
   * PLAY — straight into a game with other people, no code to type.
   *
   * The button reports what it is doing while it works, because the two slow
   * steps are genuinely slow: measuring the regions takes up to a couple of
   * seconds, and a sleeping free-tier server can take a minute to wake. A
   * button that just sits there during that reads as broken.
   */
  async _quickMatch(mapId = null) {
    const btn = document.getElementById('btn-play');
    const sub = document.getElementById('play-sub');
    if (btn?.disabled || this._deploying) return;
    const restore = () => {
      if (btn) btn.disabled = false;
      if (sub) sub.textContent = 'quick match';
      if (mapId) {
        this._setDeploying(mapId, false);
        this._renderMapCards();
      }
    };

    /*
     * Everything the player sees goes to BOTH places.
     *
     * The status used to be written only to the sub-label under the PLAY
     * button — on the main menu, which by this point is two screens behind.
     * The player is looking at the map card they just clicked, so that is
     * where the progress has to appear.
     */
    const say = (text) => {
      if (sub) sub.textContent = text;
      if (mapId) this._deployStatus(mapId, text.toUpperCase());
    };

    /*
     * Ask for a callsign once, if there is not one yet.
     *
     * Otherwise a first-time player goes straight in as OPERATOR and every
     * other person in the match sees that, with no hint that a name was ever
     * an option. Anybody who has set one is never asked again.
     */
    if (!hasRealName(this.settings.get('playerName'))) {
      this.openLobby('quick');
      return;
    }

    const name = this.settings.get('playerName') || DEFAULT_NAME;
    if (btn) btn.disabled = true;
    if (mapId) this._setDeploying(mapId, true);
    say('finding a server…');

    /*
     * After a few seconds, say what is probably happening.
     *
     * A free instance that has scaled to zero takes 30-60 s to answer its
     * first request, and during that time there is nothing to report — no
     * error, no progress, just a wait far longer than anyone assumes a game
     * menu can take. Naming it is the difference between "it is broken" and
     * "it is coming".
     */
    const slow = setTimeout(() => say('waking the server — up to a minute…'), 4000);
    const slower = setTimeout(() => say('still waking it — nearly there…'), 20000);

    try {
      await this.onQuickMatch?.(name, say);
    } catch (err) {
      clearTimeout(slow); clearTimeout(slower);
      const why = err?.message ? String(err.message).slice(0, 60) : 'could not connect';
      say(why);
      // Unlocked on failure, and only on failure — otherwise a player who
      // could not connect is stranded on a screen with no way back.
      if (mapId) this._setDeploying(mapId, false);
      setTimeout(restore, 4000);
      return;
    }
    clearTimeout(slow); clearTimeout(slower);
    restore();
  }

  async _copyInvite() {
    const link = this.inviteLink;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.setLobbyStatus('Invite link copied — send it to your friends.', 'ok');
    } catch {
      // Clipboard access needs a secure context and can be refused; showing the
      // link is a worse experience than copying it but far better than silence.
      this.setLobbyStatus(link, 'ok');
    }
  }

  // ------------------------------------------------------------------ tags
  /** Keep the summary chips on the main menu in sync. */
  refreshTags() {
    // Only overwrite while it is not being typed in, or the caret jumps.
    if (this.el.menuNameInput && document.activeElement !== this.el.menuNameInput) {
      this.el.menuNameInput.value = hasRealName(this.settings.get('playerName'))
      ? this.settings.get('playerName') : '';
    }
    if (this.el.menuMapTag) {
      this.el.menuMapTag.textContent = getMap(this.settings.get('mapId')).name;
    }
    if (this.el.menuPrimaryTag) this.el.menuPrimaryTag.textContent = shortName(this.settings.get('loadoutPrimary'));
    if (this.el.menuSecondaryTag) this.el.menuSecondaryTag.textContent = shortName(this.settings.get('loadoutSecondary'));
  }
}

/* ------------------------------------------------------------------ helpers */

function shortName(id) {
  return WEAPON_DEFS.find((w) => w.id === id)?.short ?? id;
}


function statBar(label, value01, text) {
  const pctv = Math.round(clamp(value01, 0.03, 1) * 100);
  return `<div class="stat-row"><span>${label}</span><span class="track"><span class="fill" style="width:${pctv}%"></span></span><span class="val">${text}</span></div>`;
}

/** Normalise a weapon's numbers into 0..1 bars for the loadout screen. */
function weaponStats(def) {
  const perShot = def.damage * (def.pellets ?? 1);
  const avgPitch =
    def.recoil.pattern.reduce((a, p) => a + p[0], 0) / def.recoil.pattern.length;
  return {
    damage: clamp(perShot / 140, 0, 1),
    damageText: def.pellets > 1 ? `${def.damage}×${def.pellets}` : `${def.damage}`,
    rate: clamp(def.rpm / 1000, 0, 1),
    accuracy: clamp(1 - def.spreadBase / 3.6, 0, 1),
    range: clamp(def.falloffEnd / 260, 0, 1),
    control: clamp(1 - avgPitch / 6.5, 0, 1),
    controlText: `${avgPitch.toFixed(1)}°`,
    mobility: clamp(((def.moveSpeedMul ?? 1) - 0.75) / 0.36, 0, 1),
    adsSpeed: clamp(1 - (def.adsTime - 0.12) / 0.26, 0, 1),
  };
}

export { SETTINGS_SCHEMA, DEFAULT_SETTINGS };

/* -------------------------------------------------------------- map cards */

/** Map copy is player-authored nowhere, but escaping it costs nothing. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A top-down sketch of a map, drawn from its own `plan` rectangles.
 *
 * Deliberately a HAND-DRAWN handful of boxes rather than the real geometry.
 * The real footprints only exist once a map has been built, and building both
 * maps to draw two thumbnails would cost more than the rest of the menu put
 * together. A dozen rectangles gives an honest impression of the shape and the
 * scale, and lives beside the layout so it is easy to keep truthful.
 */
function drawPlan(canvas, map) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);

  const half = (map.bounds.max[0] - map.bounds.min[0]) / 2;
  // Both maps are drawn to the SAME scale, so the size difference between the
  // cards is the real size difference between the arenas.
  const worldHalf = 36;
  const k = (S * 0.5) / worldHalf;
  const cx = S / 2;

  // The arena footprint.
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.fillRect(cx - half * k, cx - half * k, half * 2 * k, half * 2 * k);
  ctx.strokeStyle = map.accent;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - half * k, cx - half * k, half * 2 * k, half * 2 * k);
  ctx.globalAlpha = 1;

  for (const [x, z, w, d] of map.plan ?? []) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(cx + (x - w / 2) * k, cx + (z - d / 2) * k, w * k, d * k);
  }
}

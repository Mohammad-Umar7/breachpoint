/**
 * MenuManager — every screen that isn't the HUD.
 *
 * Screens are declarative:
 *   - Difficulty cards are generated from `DIFFICULTIES`.
 *   - The loadout browser is generated from `WEAPON_DEFS`, including stat bars
 *     computed from the same numbers the game actually uses.
 *   - The settings panel is generated from `SETTINGS_SCHEMA` below, so adding
 *     an option is a one-line change and can never drift from the markup.
 *
 * Everything writes straight through to `Settings`, which persists to
 * localStorage and notifies the live systems, so changes apply immediately —
 * including while paused mid-firefight.
 */

import { DIFFICULTIES, DIFFICULTY_ORDER } from '../core/Difficulty.js';
import { WEAPON_DEFS, CATEGORY_LABELS, opticMagnification } from '../weapons/WeaponDefinitions.js';
import { DEFAULT_SETTINGS } from '../core/Settings.js';
import { RETICLE_STYLES } from '../fx/ScopeRenderer.js';
import { effectiveAimSpeed } from '../core/SensitivityManager.js';
import { clamp } from '../core/MathUtils.js';

const SCREENS = [
  'screen-loading', 'screen-menu', 'screen-difficulty', 'screen-loadout',
  'screen-controls', 'screen-credits', 'screen-pause', 'screen-settings',
  'screen-gameover', 'screen-victory', 'screen-error',
];

/** Percentage formatter for 0..1 volume-style values. */
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
          {
            key: 'difficulty', label: 'Difficulty', type: 'select',
            options: DIFFICULTY_ORDER.map((id) => [id, DIFFICULTIES[id].label]),
          },
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
    this.onPlay = null;
    this.onContinue = null;
    this.onResume = null;
    this.onRestart = null;
    this.onQuitToMenu = null;
    this.onLoadoutChanged = null;

    this._cache();
    this._buildDifficultyCards();
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
      difficultyCards: id('difficulty-cards'),
      settingsTabs: id('settings-tabs'),
      settingsBody: id('settings-body'),
      weaponList: id('weapon-list'),
      weaponDetail: id('weapon-detail'),
      menuDifficultyTag: id('menu-difficulty-tag'),
      menuPrimaryTag: id('menu-primary-tag'),
      menuSecondaryTag: id('menu-secondary-tag'),
      loadoutPrimaryTag: id('loadout-primary-tag'),
      loadoutSecondaryTag: id('loadout-secondary-tag'),
      continueBtn: id('btn-continue'),
      gameoverStats: id('gameover-stats'),
      victoryStats: id('victory-stats'),
      errorText: id('error-text'),
    };
  }

  // ---------------------------------------------------------------- screens
  showScreen(name) {
    for (const s of SCREENS) {
      document.getElementById(s)?.classList.toggle('active', s === name);
    }
    this.currentScreen = name;
    this.el.overlay.classList.remove('hidden');
    this.el.menuFx.style.display = name === 'screen-menu' ? '' : 'none';

    // Focus the first control so keyboard navigation just works.
    const first = document.querySelector(`#${name} button:not(.hidden)`);
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }

  hideOverlay() {
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

  showResults(screen, stats) {
    const target = screen === 'victory' ? this.el.victoryStats : this.el.gameoverStats;
    target.innerHTML = stats
      .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
      .join('');
    this.showScreen(screen === 'victory' ? 'screen-victory' : 'screen-gameover');
  }

  // ---------------------------------------------------------------- binding
  _bind() {
    const click = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    click('btn-play', () => this.onPlay?.());
    click('btn-continue', () => this.onContinue?.());
    click('btn-resume', () => this.onResume?.());
    click('btn-restart-pause', () => this.onRestart?.());
    click('btn-restart-over', () => this.onRestart?.());
    click('btn-restart-win', () => this.onRestart?.());
    click('btn-quit', () => this.onQuitToMenu?.());
    click('btn-menu-over', () => this.onQuitToMenu?.());
    click('btn-menu-win', () => this.onQuitToMenu?.());
    click('btn-error-reload', () => window.location.reload());

    click('btn-difficulty', () => this.showScreen('screen-difficulty'));
    click('btn-credits', () => this.showScreen('screen-credits'));
    click('btn-loadout', () => this.openLoadout());
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
      const back = btn.classList.contains('back-btn') || btn.dataset.back;
      this.audio?.play(back ? 'menuBack' : 'menuSelect');
    });
  }

  // ------------------------------------------------------------ difficulty
  _buildDifficultyCards() {
    const host = this.el.difficultyCards;
    host.innerHTML = '';
    for (const id of DIFFICULTY_ORDER) {
      const d = DIFFICULTIES[id];
      const card = document.createElement('button');
      card.className = 'diff-card';
      card.dataset.difficulty = id;
      card.innerHTML = `
        <h4>${d.label}</h4>
        <p>${d.blurb}</p>
        ${meter('Accuracy', d.accuracyMul / 1.5)}
        ${meter('Reactions', 1 - (d.reactionMul - 0.48) / 1.3)}
        ${meter('Tactics', d.coverSkill)}
        ${meter('Health', (d.healthMul - 0.8) / 0.5)}
      `;
      card.addEventListener('click', () => {
        this.settings.set('difficulty', id);
        this._markDifficulty();
        this.refreshTags();
      });
      host.appendChild(card);
    }
    this._markDifficulty();
  }

  _markDifficulty() {
    const current = this.settings.get('difficulty');
    for (const card of this.el.difficultyCards.children) {
      card.classList.toggle('selected', card.dataset.difficulty === current);
    }
  }

  // --------------------------------------------------------------- loadout
  openLoadout() {
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
      row.innerHTML = `
        <span class="wname">${def.name}</span>
        <span class="wcat">${CATEGORY_LABELS[def.category] ?? def.category}</span>
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

    this.el.weaponDetail.innerHTML = `
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
        if (item.key === 'difficulty') { this._markDifficulty(); this.refreshTags(); }
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

  // ------------------------------------------------------------------ tags
  /** Keep the summary chips on the main menu in sync. */
  refreshTags() {
    const diff = DIFFICULTIES[this.settings.get('difficulty')] ?? DIFFICULTIES.normal;
    if (this.el.menuDifficultyTag) this.el.menuDifficultyTag.textContent = diff.label;
    if (this.el.menuPrimaryTag) this.el.menuPrimaryTag.textContent = shortName(this.settings.get('loadoutPrimary'));
    if (this.el.menuSecondaryTag) this.el.menuSecondaryTag.textContent = shortName(this.settings.get('loadoutSecondary'));
  }
}

/* ------------------------------------------------------------------ helpers */

function shortName(id) {
  return WEAPON_DEFS.find((w) => w.id === id)?.short ?? id;
}

function meter(label, value01) {
  const pctv = Math.round(clamp(value01, 0.04, 1) * 100);
  return `<div class="diff-meter"><span>${label}</span><span class="track"><span class="fill" style="width:${pctv}%"></span></span></div>`;
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

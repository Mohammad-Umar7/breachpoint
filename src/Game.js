/**
 * Game — bootstraps every system, owns the main loop and the game state
 * machine, and wires the systems to each other through callbacks.
 *
 * Rendering is layered:
 *   LAYER_WORLD      the arena, enemies, props, particles
 *   LAYER_VIEWMODEL  the first-person weapon only
 *
 * The world camera and the scope camera see only LAYER_WORLD; a dedicated
 * view-model camera draws the weapon on top with its own FOV and near plane.
 * That single decision is what stops the gun clipping through walls and makes
 * it impossible for weapon geometry to appear inside a sniper scope.
 *
 * Frame order (this order matters):
 *   1. mouse look                — so movement uses this frame's facing
 *   2. fixed physics steps       — player + AI movement, then world.step
 *   3. sync dynamic meshes       — interpolated between the last two steps
 *   4. camera transform          — bob / recoil / lean / shake
 *   5. weapons                   — needs the final camera transform
 *   6. enemies, pickups, particles, UI
 *   7. scope render-to-texture, main render, scope overlay
 *
 * States: loading -> menu -> playing <-> paused -> gameover | victory
 */

import * as THREE from 'three';

import { Settings } from './core/Settings.js';
import { InputManager } from './core/InputManager.js';
import { AssetManager } from './core/AssetManager.js';
import { SensitivityManager } from './core/SensitivityManager.js';
import { detectQuality, PerformanceGovernor } from './core/HardwareProfile.js';
import { PhysicsWorld, initRapier, TAG_KIND } from './physics/PhysicsWorld.js';
import { Level } from './world/Level.js';
import { PickupManager } from './world/PickupManager.js';
import { Player } from './player/Player.js';
import { LeanSystem } from './player/LeanSystem.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
import { getWeaponDef } from './weapons/WeaponDefinitions.js';
import { WeaponViewModel } from './weapons/WeaponViewModel.js';
import { ADSSystem } from './weapons/ADSSystem.js';
import { EnemyManager } from './enemies/EnemyManager.js';
import { NavigationSystem } from './enemies/NavigationSystem.js';
import { ParticleManager } from './fx/ParticleManager.js';
import { PostFX } from './fx/PostFX.js';
import { ScopeRenderer, LAYER_WORLD } from './fx/ScopeRenderer.js';
import { AudioManager } from './audio/AudioManager.js';
import { UIManager } from './ui/UIManager.js';
import { MenuManager } from './ui/MenuManager.js';
import { NetworkClient, NET_STATE, inviteUrl, roomFromUrl } from './net/NetworkClient.js';
import { RemotePlayers } from './net/RemotePlayers.js';
import { FLAG, MATCH_STATE } from './net/protocol.js';
import { clamp, damp, randRange } from './core/MathUtils.js';

export const GAME_STATE = Object.freeze({
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
  VICTORY: 'victory',
});

const ANISOTROPY = { low: 1, medium: 4, high: 8, ultra: 16 };

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.state = GAME_STATE.LOADING;
    this.disposed = false;
    this.hasActiveRun = false;

    this.settings = new Settings();

    /*
     * Pick a starting quality for THIS machine, on a first run only.
     *
     * Shipping everyone High is wrong: most people play browser games on a
     * laptop with integrated graphics, and High there means shadows, bloom,
     * antialiasing and full render scale on a GPU sharing memory with the CPU.
     * Someone who has already chosen a setting keeps it — isFirstRun is false
     * the moment anything has been saved.
     */
    if (this.settings.isFirstRun) {
      const detected = detectQuality();
      if (detected.quality !== this.settings.get('quality')) {
        this.settings.set('quality', detected.quality);
        console.info(
          `[Quality] Starting on "${detected.quality}" — ${detected.reason}`
          + `${detected.renderer ? ` (${detected.renderer})` : ''}. `
          + 'Change it any time in Settings.',
        );
      }
    }

    /*
     * And keep watching, because the guess above is only a guess: the browser
     * often masks the renderer string, and a machine that benchmarks fine can
     * still be thermally throttled or busy. If the frame rate stays low the
     * governor steps the preset down and says so.
     */
    this.governor = new PerformanceGovernor(this.settings, (quality, fps) => {
      console.info(`[Quality] ${Math.round(fps)} fps — dropping to "${quality}".`);
      this.ui?.showBanner?.(`GRAPHICS SET TO ${quality.toUpperCase()}`, 3);
    });

    this.audio = new AudioManager(this.settings);
    this.ui = new UIManager(this.settings);
    this.menus = new MenuManager(this.settings, this.audio);
    this.input = new InputManager(canvas);
    this.sens = new SensitivityManager(this.settings);

    this.clock = { last: 0, fpsAccum: 0, fpsFrames: 0, fps: 60, frameBudget: 0 };
    this.stats = this._blankStats();
    this._pendingExplosions = [];
    this._menuTime = 0;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    // Scratch for drawing other players' gunfire — see net.onFire.
    this._tmpC = new THREE.Vector3();
    this._tmpD = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._focusRayDir = new THREE.Vector3();

    this._bindUi();
    this._bindWindow();
  }

  _blankStats() {
    return {
      score: 0, kills: 0, deaths: 0, headshots: 0, waveReached: 1,
      startTime: 0, elapsed: 0, damageTaken: 0,
    };
  }

  // ==================================================================== boot
  async init() {
    try {
      this.menus.showScreen('screen-loading');
      this.menus.setLoadingProgress(0.02, 'Starting renderer');

      this._createRenderer();
      this._createScene();

      this.menus.setLoadingProgress(0.1, 'Loading physics engine');
      await initRapier();
      this.physics = new PhysicsWorld();

      this.menus.setLoadingProgress(0.2, 'Generating materials');
      this.assets = new AssetManager(this.renderer);
      await this.assets.build((f, label) => this.menus.setLoadingProgress(0.2 + f * 0.36, label));
      this._applyTextureQuality();

      this.menus.setLoadingProgress(0.58, 'Building arena');
      this.level = new Level(this.scene, this.physics, this.assets, this.settings, this.renderer);
      this.level.build();
      this.level.captureResetState();
      this.nav = new NavigationSystem(this.level, this.physics);

      // Multiplayer. The client is created but idle until a match is joined,
      // so a failed or absent server never blocks the game from booting.
      this.net = new NetworkClient();

      this.menus.setLoadingProgress(0.72, 'Spawning effects');
      this.fx = new ParticleManager(this.scene, this.assets, this.settings);
      this.remotes = new RemotePlayers({ scene: this.scene, assets: this.assets });

      this.menus.setLoadingProgress(0.78, 'Arming player');
      this.lean = new LeanSystem(this.input, this.settings, this.physics);
      this.player = new Player(
        this.camera, this.physics, this.input, this.settings,
        this.audio, this.fx, this.sens, this.lean
      );
      this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);

      this.viewModel = new WeaponViewModel(this.scene, this.camera, this.settings);
      this.adsSystem = new ADSSystem(this.settings, this.input, this.audio);
      this.weapons = new WeaponSystem({
        camera: this.camera,
        player: this.player,
        physics: this.physics,
        fx: this.fx,
        audio: this.audio,
        settings: this.settings,
        input: this.input,
        assets: this.assets,
        viewModel: this.viewModel,
        adsSystem: this.adsSystem,
      });

      this.menus.setLoadingProgress(0.86, 'Briefing hostiles');
      this.enemies = new EnemyManager({
        scene: this.scene,
        physics: this.physics,
        assets: this.assets,
        audio: this.audio,
        fx: this.fx,
        level: this.level,
        player: this.player,
        nav: this.nav,
        settings: this.settings,
      });

      this.pickups = new PickupManager({
        scene: this.scene,
        assets: this.assets,
        audio: this.audio,
        player: this.player,
        weaponSystem: this.weapons,
      });
      this.pickups.buildFromLevel(this.level);

      this.menus.setLoadingProgress(0.93, 'Grinding lenses');
      this.scope = new ScopeRenderer(this.renderer, this.scene, this.settings);

      this.menus.setLoadingProgress(0.96, 'Compiling shaders');
      this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.settings, this.viewModel.camera);
      this._applyExposure();

      this._wireCallbacks();
      this.renderer.compile(this.scene, this.camera);

      this.menus.setLoadingProgress(1, 'Ready');
      this._setState(GAME_STATE.MENU);
      this.menus.showScreen('screen-menu');
      this.menus.setCanContinue(false);

      this.clock.last = performance.now() / 1000;
      this._loop = this._loop.bind(this);
      this.rafId = requestAnimationFrame(this._loop);

      if (this.assets.loadErrors.length) {
        console.warn('[Game] Some assets fell back to defaults:', this.assets.loadErrors);
      }
    } catch (err) {
      console.error('[Game] Fatal error during initialisation:', err);
      this.menus.showError(`${err?.message ?? err}\n\n${err?.stack ?? ''}`);
      throw err;
    }
  }

  _createRenderer() {
    const gl2 = document.createElement('canvas').getContext('webgl2');
    if (!gl2) {
      throw new Error('WebGL 2 is not available in this browser. Try Chrome, Edge or Firefox with hardware acceleration enabled.');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,     // AA is handled by the post-processing chain
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this._applyResolution();
    this.settings.onChange('renderScale', () => this._applyResolution());
    this.settings.onChange('exposure', () => this._applyExposure());
    this.settings.onChange('quality', () => this._applyExposure());
    this.settings.onChange('textureQuality', () => this._applyTextureQuality());
    this.settings.onChange('shadowQuality', (v) => {
      this.renderer.shadowMap.enabled = v !== 'off';
      this.renderer.shadowMap.needsUpdate = true;
    });
  }

  _applyResolution() {
    const scale = this.settings.get('renderScale');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.postfx?.setSize();
    // Reads the drawing-buffer size itself — see ScopeRenderer.setSize().
    this.scope?.setSize();
  }

  /**
   * Route exposure to whichever stage will actually honour it.
   *
   * With the post chain running, the grade pass scales linear radiance before
   * OutputPass tone-maps it, and the renderer's own exposure is pinned to 1 so
   * the two can't compound. Without the chain (the Low preset) there is no
   * grade pass, so the renderer's exposure is the only lever available.
   */
  _applyExposure() {
    const v = this.settings.get('exposure');
    if (this.postfx?.enabled) {
      this.renderer.toneMappingExposure = 1.0;
      this.postfx.setExposure(v);
    } else {
      this.postfx?.setExposure(1.0);
      this.renderer.toneMappingExposure = v;
    }
  }

  /** Texture quality maps to anisotropic filtering across every texture. */
  _applyTextureQuality() {
    if (!this.assets) return;
    const want = ANISOTROPY[this.settings.get('textureQuality')] ?? 8;
    const max = this.renderer.capabilities.getMaxAnisotropy();
    const level = Math.min(want, max);
    for (const tex of this.assets.textures.values()) {
      if (tex.anisotropy !== level) {
        tex.anisotropy = level;
        tex.needsUpdate = true;
      }
    }
  }

  _createScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.settings.get('fov'),
      window.innerWidth / window.innerHeight,
      0.05,
      600
    );
    this.camera.rotation.order = 'YXZ';
    // The world camera never sees the view-model layer.
    this.camera.layers.set(LAYER_WORLD);
    this.scene.add(this.camera);
  }

  // ============================================================== callbacks
  _bindUi() {
    // Someone following an invite link lands straight on the join screen with
    // the code already filled in, so the link is one click rather than "now
    // type these five characters".
    const invited = roomFromUrl();
    if (invited) {
      this.menus.openLobby('join', invited);
      // Drop it from the address bar so a later reload does not silently
      // rejoin a match that has long since ended.
      try {
        const clean = new URL(location.href);
        clean.searchParams.delete('room');
        history.replaceState(null, '', clean.toString());
      } catch { /* non-fatal */ }
    }

    this.menus.onCreateMatch = (name) => this._connect({ name, room: null });
    this.menus.onJoinMatch = (code, name) => this._connect({ name, room: code });
    this.menus.onQuickMatch = async (name, status) => {
      // Pick the closest region by measurement before connecting. Silent and
      // optional — with a single server there is nothing to choose and this
      // returns immediately.
      const region = await this.net?.pickRegion?.();
      status?.(region ? `joining ${region.name} · ${Math.round(region.ms)} ms` : 'joining…');
      return this._connect({ name, room: null, quick: true });
    };
    this.menus.onContinue = () => this.resume();
    this.menus.onResume = () => this.resume();
    this.menus.onRestart = () => this.restart();
    this.menus.onQuitToMenu = () => this.quitToMenu();
    this.menus.onLoadoutChanged = () => {
      if (!this.weapons) return;
      /*
       * Applies straight away, including from the pause menu mid-match — you
       * should never have to leave a game to change weapons.
       *
       * `preserveAmmo` matters here: without it, re-picking the gun already in
       * your hands would refill the magazine, making the pause menu a free
       * instant reload. Weapons you did not have arrive loaded, as they should.
       *
       * Nothing extra is needed to tell anyone else: the weapon id rides on
       * every input packet, so other players see the new gun on their next
       * snapshot.
       */
      const inMatch = this.hasActiveRun;
      this.weapons.applyLoadout(
        this.settings.get('loadoutPrimary'),
        this.settings.get('loadoutSecondary'),
        { preserveAmmo: inMatch },
      );
    };
  }

  _bindWindow() {
    this._onResize = () => {
      const aspect = window.innerWidth / window.innerHeight;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.viewModel?.setSize(aspect);
      this._applyResolution();
    };
    window.addEventListener('resize', this._onResize);

    this._onVisibility = () => {
      if (document.hidden && this.state === GAME_STATE.PLAYING) this.pause();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this.input.onPauseRequested = () => {
      if (this.state === GAME_STATE.PLAYING) this.pause();
      else if (this.state === GAME_STATE.PAUSED && this.menus.currentScreen === 'screen-pause') this.resume();
    };

    this.input.onPointerLockChange = (locked) => {
      if (!locked && this.state === GAME_STATE.PLAYING) this.pause();
      if (locked) this.sens.reset();
    };
  }

  _wireCallbacks() {
    // ---------------------------------------------------------- the player
    this.player.onDamage = (amount, sourcePos) => {
      this.stats.damageTaken += amount;
      let angle = null;
      if (sourcePos) {
        this._tmpA.subVectors(sourcePos, this.player.position);
        const worldAngle = Math.atan2(this._tmpA.x, this._tmpA.z);
        angle = worldAngle - (this.player.yaw + Math.PI);
      }
      this.ui.showDamage(clamp(amount / 45, 0.12, 0.6), angle);
    };
    this.player.onHeal = () => this.ui.showHeal();
    // In a match the server owns life and death, and dying just means waiting
    // to respawn. The single-player GAME OVER screen must not appear.
    this.player.onDeath = () => {
      if (this.net?.connected) return;
      this._gameOver();
    };
    // Sprinting is loud — nearby soldiers will come and look.
    this.player.onFootstep = (loudness) =>
      this.enemies.alertNear(this.player.position, loudness, 'footstep');

    // --------------------------------------------------------- the weapons
    this.weapons.onHit = (info) => {
      this.ui.showHitmarker(info.killed, info.headshot);
      if (info.point) {
        this.ui.addDamageNumber(
          info.point,
          info.damage,
          info.killed ? 'kill' : info.headshot ? 'head' : ''
        );
      }
    };
    this.weapons.onShotFired = (pos, loudness) => this.enemies.alertNear(pos, loudness, 'gunfire');
    this.weapons.onPropHit = (prop, dmg, point, dir) => this._damageProp(prop, dmg, point, dir);
    this.weapons.onGrenadeExplode = (pos, def) => {
      this._detonate(pos, def.blastRadius, def.damage, 420, true);
    };

    // --------------------------------------------------------- the enemies
    this.enemies.onPlayerDamaged = (amount, from) => this.player.applyDamage(amount, from, 'bullet');
    this.enemies.onPropHit = (prop, dmg, point, dir) => this._damageProp(prop, dmg, point, dir);
    this.enemies.onEnemyKilled = (enemy, headshot) => {
      const source = enemy.lastDamageSource === 'player' ? 'gun' : 'explosion';
      this._registerKill(enemy, headshot, source);
    };
    this.enemies.onDrop = (type, pos) => this.pickups.drop(type, pos);
    this.enemies.onWaveStart = (index, cfg) => {
      this.stats.waveReached = index + 1;
      this.ui.showBanner(cfg.label, 2.6);
      this.audio.playWaveSting(index);
    };
    this.enemies.onWaveCleared = (index, wasLast) => {
      if (wasLast) return;
      const bonus = 250 * (index + 1);
      this.stats.score += bonus;
      this.ui.showBanner(`WAVE CLEAR  +${bonus}`, 2.4);
      this.audio.play('waveComplete');
      this.enemies.beginIntermission(6);
      setTimeout(() => {
        if (this.state === GAME_STATE.PLAYING) this.ui.showBanner('REINFORCEMENTS INBOUND', 2.0, true);
      }, 2800);
    };
    this.enemies.onAllWavesCleared = () => this._victory();

    // --------------------------------------------------------- the pickups
    this.pickups.onCollect = (type, label, cls, amount) => {
      this.ui.showToast(label, cls);
      // Health and armour are both server-owned in a match, so a pack that
      // only topped up the local copy was undone by the next authoritative
      // update — pickups did nothing at all. Claim them so the server applies
      // the real thing. Ammunition is not server-owned, so it needs no claim.
      if (type === 'health' || type === 'armor') {
        this.net?.claimHeal?.(amount, type);
      }
    };
  }

  /** Central scoring path for every kill, however it happened. */
  _registerKill(enemy, headshot, source) {
    const base = enemy.scoreValue ?? 100;
    const points = Math.round(headshot ? base * 1.5 : base);
    this.stats.score += points;
    this.stats.kills++;
    if (headshot) this.stats.headshots++;

    const typeLabel = enemy.stats?.label ?? 'HOSTILE';
    const tag = source === 'explosion' ? ' <b>[BLAST]</b>' : headshot ? ' <b>[HEADSHOT]</b>' : '';
    this.ui.addKill(`${typeLabel.toUpperCase()} DOWN${tag}`, points, headshot);
    this.audio.play('killConfirm');
  }

  // ============================================================== explosives
  _damageProp(prop, damage, point, dir) {
    if (!prop || !prop.explosive || prop.exploded) return;
    prop.health -= damage;
    if (prop.health <= 0) this._explode(prop);
  }

  _explode(prop) {
    if (prop.exploded) return;
    prop.exploded = true;

    const pos = prop.mesh.position.clone();
    prop.mesh.visible = false;
    this.physics.setBodyEnabled(prop.body, false);

    this._detonate(pos, prop.blastRadius, prop.blastDamage, prop.blastForce, false, 'barrel');

    // Chain reaction into every other explosive in range.
    for (const other of this.level.explosives) {
      if (other === prop || other.exploded || other.__queued) continue;
      if (other.mesh.position.distanceTo(pos) < prop.blastRadius * 1.15) {
        other.__queued = true;
        this._pendingExplosions.push({ prop: other, delay: randRange(0.14, 0.4) });
      }
    }
  }

  /**
   * Shared blast: physics impulse, line-of-sight damage to the player and
   * every enemy, knockback, full FX and a scorch mark.
   */
  /**
   * @param sourceId  weapon or hazard id the blast is reported to the server
   *                  as. A barrel used to claim to be a grenade, so barrels hit
   *                  for the frag's 130 rather than their own 95 in a match and
   *                  the kill feed credited a grenade nobody had thrown.
   */
  _detonate(pos, radius, damage, force, fromPlayer, sourceId = 'grenade') {
    this.physics.applyExplosion(pos, radius, force);
    this.enemies.applyExplosionDamage(pos, radius, damage, fromPlayer ? 'player' : 'explosion');

    this._tmpB.copy(this.player.position);
    this._tmpB.y += 0.3;
    const pd = this._tmpB.distanceTo(pos);
    const caughtInBlast = pd < radius && this.physics.hasLineOfSight(pos, this._tmpB);
    if (caughtInBlast) {
      const falloff = 1 - pd / radius;
      /*
       * The HEALTH loss is applied locally only outside a match.
       *
       * In multiplayer the server owns health, and it uses its own falloff
       * curve — so applying a different number here would disagree with the
       * authoritative one, and could drop us to zero locally while the server
       * still had us alive. That leaves a player dead on their own screen and
       * walking around on everyone else's. The claim sent below is what
       * actually hurts us; the server's reply sets the real figure.
       *
       * The kick and the shake stay local either way: they are feel, not
       * state, and waiting a round-trip for them would make an explosion at
       * your feet land late.
       */
      if (!this.net?.connected) {
        // Your own grenades hurt, but less than a barrel going off in your face.
        const selfScale = fromPlayer ? 0.5 : 0.75;
        this.player.applyDamage(damage * falloff * falloff * selfScale, pos, 'explosion');
      }
      const kick = this._tmpB.clone().sub(pos).normalize().multiplyScalar(10 * falloff);
      kick.y = Math.abs(kick.y) + 5 * falloff;
      this.player.applyImpulse(kick);
      this.player.addShake(0.9 * falloff);
    } else if (pd < radius * 2.2) {
      this.player.addShake(0.35 * (1 - pd / (radius * 2.2)));
    }

    /*
     * Other players, which nothing here used to touch.
     *
     * Explosions only ever damaged AI enemies and the local player, so in a
     * deathmatch a grenade landing at someone's feet did nothing at all — the
     * one weapon in the loadout that could not hurt anybody.
     *
     * Reported as ordinary hit claims so the server stays the authority on
     * damage. The origin sent is the BLAST CENTRE rather than the camera,
     * which is what makes the server's falloff measure the right distance: a
     * grenade's curve is a blast radius, reaching zero at 7.5 m, so measuring
     * from the thrower would have it do full damage to someone standing next
     * to them and nothing to the person it landed on.
     */
    if (this.net?.connected && this.remotes) {
      const claims = [];
      for (const [id, body] of this.remotes.bodies) {
        this._tmpB.copy(body.group.position);
        this._tmpB.y += 0.9;
        if (this._tmpB.distanceTo(pos) >= radius) continue;
        if (!this.physics.hasLineOfSight(pos, this._tmpB)) continue;
        claims.push({ victimId: id, part: 'torso' });
      }

      /*
       * And OURSELVES, if we are inside our own blast.
       *
       * The local applyDamage above already reduced our health, but health is
       * server-owned in a match: the server knew nothing about it, so the
       * figure was cosmetic and the next authoritative update put it straight
       * back. Dropping a grenade at your own feet did nothing at all, and you
       * could not kill yourself with one however hard you tried.
       */
      if (caughtInBlast && this.player.alive) {
        claims.push({ victimId: this.net.selfId, part: 'torso' });
      }

      if (claims.length) {
        this.net.sendShot({
          origin: pos, direction: this._camForward, weaponId: sourceId, hits: claims,
        });
      }
    }

    this.fx.spawnExplosion(pos, radius * 0.75);
    this.audio.play('explosion', { position: pos, volume: 1 });
    this._tmpB.set(0, 1, 0);
    this.fx.addDecal({ x: pos.x, y: 0.02, z: pos.z }, this._tmpB, 'blood', radius * 0.5);

    this.enemies.alertNear(pos, 60, 'gunfire');
  }

  _updatePendingExplosions(dt) {
    for (let i = this._pendingExplosions.length - 1; i >= 0; i--) {
      const p = this._pendingExplosions[i];
      p.delay -= dt;
      if (p.delay <= 0) {
        this._pendingExplosions.splice(i, 1);
        p.prop.__queued = false;
        this._explode(p.prop);
      }
    }
  }

  // ============================================================ state flow
  _setState(state) {
    this.state = state;
  }

  /**
   * Build the effect shaders up front, once per session.
   *
   * Deliberately not awaited: it runs alongside the opening seconds of the
   * match rather than delaying the start, and every shot fired before it
   * finishes simply compiles as it always would. See ParticleManager.warmup
   * for why this exists at all.
   */
  _warmShaders() {
    if (this._shadersWarmed) return;
    this._shadersWarmed = true;
    this.fx?.warmup?.(this.renderer, this.camera)
      .catch(() => { /* an optimisation, never a requirement */ });
  }

  /**
   * Pick up any recorded sound files the project has been given.
   *
   * Fire-and-forget and entirely optional — see AudioManager.loadSamples.
   * Nothing waits on it, so a slow or missing file never delays the match;
   * whatever finishes loading simply starts being used from that point on.
   * Runs once per session.
   */
  _loadAudioSamples() {
    if (this._samplesRequested) return;
    this._samplesRequested = true;
    this.audio.loadSamples?.([
      'shootRifle', 'shootPistol', 'shootShotgun', 'shootMagnum', 'shootBurst',
      'shootSmg', 'shootLmg', 'shootSniper', 'shootMarksman', 'shootEnemy',
      'reload', 'reloadEmpty', 'explosion', 'hitmarker', 'killConfirm',
    ]).catch(() => { /* optional by design */ });
  }

  startGame() {
    this.audio.init();
    this.audio.resume();
    this.audio.startAmbience();
    this._loadAudioSamples();
    this._warmShaders();

    this._resetWorld();
    this.stats = this._blankStats();
    this.stats.startTime = performance.now() / 1000;
    this.hasActiveRun = true;

    this.menus.hideOverlay();
    this.ui.showHud(true);
    this.ui.resetHud();
    this._setState(GAME_STATE.PLAYING);
    this.input.clearAll();
    this.input.requestPointerLock();

    // Re-apply the server's spawn. _resetWorld() above puts the player back at
    // Level.playerSpawn, which in a match would drop everyone onto one tile.
    if (this.net?.connected && this._pendingSpawn) this._placePlayer(this._pendingSpawn);

    // Deathmatch: opponents are other players, so no AI wave is started.
    // EnemyManager stays wired up but idle, ready for a future PvE mode.
    this.ui.showBanner(
      this.net?.connected && this.net.isWarmup
        ? 'WAITING FOR PLAYERS' : 'FIGHT',
      2.4,
    );
  }

  restart() {
    this.startGame();
  }

  pause() {
    if (this.state !== GAME_STATE.PLAYING) return;
    this._setState(GAME_STATE.PAUSED);
    this.input.exitPointerLock();
    this.input.clearAll();
    this.audio.setMuffled(true);
    this.menus.showScreen('screen-pause');
  }

  resume() {
    if (this.state !== GAME_STATE.PAUSED) return;
    this.audio.setMuffled(false);
    this.menus.hideOverlay();
    this.ui.showHud(true);
    this._setState(GAME_STATE.PLAYING);
    this.input.clearAll();
    this.input.requestPointerLock();
    this.clock.last = performance.now() / 1000;
  }

  quitToMenu() {
    this.leaveMatch();
    this.audio.setMuffled(false);
    this._setState(GAME_STATE.MENU);
    this.hasActiveRun = false;
    this.input.exitPointerLock();
    this.ui.showHud(false);
    this.menus.setCanContinue(false);
    this.menus.refreshTags();
    this.menus.showScreen('screen-menu');
    this._resetWorld();
  }

  _gameOver() {
    if (this.state !== GAME_STATE.PLAYING) return;
    this._setState(GAME_STATE.GAMEOVER);
    this.hasActiveRun = false;
    this.input.exitPointerLock();
    this.audio.setMuffled(true);
    this.audio.play('defeat');
    setTimeout(() => {
      if (this.state !== GAME_STATE.GAMEOVER) return;
      this.menus.showResults('gameover', this._buildStatLines());
      this.ui.showHud(false);
    }, 1400);
  }

  _victory() {
    if (this.state !== GAME_STATE.PLAYING) return;
    this._setState(GAME_STATE.VICTORY);
    this.hasActiveRun = false;
    this.stats.score += 2000;
    this.input.exitPointerLock();
    this.audio.setMuffled(true);
    this.audio.play('victory');
    this.ui.showBanner('AREA SECURED', 3);
    setTimeout(() => {
      if (this.state !== GAME_STATE.VICTORY) return;
      this.menus.showResults('victory', this._buildStatLines());
      this.ui.showHud(false);
    }, 2200);
  }

  _buildStatLines() {
    const t = this.stats.elapsed;
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60).toString().padStart(2, '0');
    const acc = this.weapons.shotsFired > 0
      ? Math.round((this.weapons.shotsHit / this.weapons.shotsFired) * 100)
      : 0;
    /*
     * Leftovers from the wave mode that this game no longer has: THREAT LEVEL
     * read a `difficulty` setting that was deleted (so it silently showed the
     * default, "VETERAN", to everyone) and WAVE REACHED counted waves that are
     * never started in a deathmatch — it read "0 / 12" every time.
     *
     * Replaced with the numbers a free-for-all actually produces.
     */
    const kd = this.stats.deaths > 0
      ? (this.stats.kills / this.stats.deaths).toFixed(2)
      : String(this.stats.kills);

    return [
      ['ELIMINATIONS', this.stats.kills],
      ['DEATHS', this.stats.deaths ?? 0],
      ['K/D', kd],
      ['HEADSHOTS', this.stats.headshots],
      ['ACCURACY', `${acc}%`],
      ['DAMAGE TAKEN', Math.round(this.stats.damageTaken)],
      ['TIME', `${mins}:${secs}`],
    ];
  }

  /** Put the world back to its starting state without reloading the page. */
  _resetWorld() {
    this.enemies.reset();
    this.pickups.reset();
    this.fx.reset();
    this.weapons.reset();
    this.lean.reset();
    this.adsSystem.reset();
    this.nav.clearClaims();
    this._pendingExplosions.length = 0;

    for (const prop of this.level.explosives) {
      prop.__queued = false;
      if (prop.exploded) {
        prop.exploded = false;
        prop.mesh.visible = true;
        this.physics.setBodyEnabled(prop.body, true, prop.startPos);
      }
      prop.health = 45;
    }
    this.level.reset();

    this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
    this.postfx.setDamage(0);
  }

  // ================================================================== loop
  _loop(timeMs) {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this._loop);

    const now = timeMs / 1000;
    let dt = now - this.clock.last;

    // Frame limiter: only used when V-sync is disabled.
    if (!this.settings.get('vsync')) {
      const cap = this.settings.get('maxFps');
      if (cap > 0 && dt < 1 / cap - 0.0005) return;
    }

    this.clock.last = now;
    dt = Math.min(dt, 0.1);

    this._updateFps(dt);
    this.governor?.update(dt);

    // endFrame() clears the one-frame press edges, and it MUST run even if
    // something above it throws.
    //
    // It used to be the last statement after _render(). When a renderer
    // exception started firing every frame, endFrame() was skipped every frame
    // with it — so `keysPressed` and `mousePressed` were never cleared and every
    // edge latched permanently: weapon switching stuck on whichever slot was
    // pressed first, and semi-auto fire and ADS toggles misbehaved. The visible
    // symptom was "the controls are stuck", which points nowhere near a
    // rendering bug. A `finally` makes that failure mode impossible.
    try {
      if (this.state === GAME_STATE.PLAYING) {
        this._updatePlaying(dt);
      } else {
        this._updateIdle(dt);
      }
      this._render(dt);
    } finally {
      this.input.endFrame();
    }
  }

  _updateFps(dt) {
    this.clock.fpsAccum += dt;
    this.clock.fpsFrames++;
    if (this.clock.fpsAccum >= 0.5) {
      this.clock.fps = this.clock.fpsFrames / this.clock.fpsAccum;
      this.clock.fpsAccum = 0;
      this.clock.fpsFrames = 0;
    }
  }

  _updatePlaying(dt) {
    this.stats.elapsed = performance.now() / 1000 - this.stats.startTime;

    if (this.input.wasPressed('stats')) this.ui.toggleStats();

    // Scoreboard is held, not toggled. Forced open when the match is over so
    // everyone sees the final standings without having to reach for Tab.
    if (this.net?.connected) {
      const forced = this.net.match.state === MATCH_STATE.OVER;
      const want = forced || this.input.isDown('scoreboard');
      if (want !== this._scoreboardShown) {
        this._scoreboardShown = want;
        this.ui.setScoreboardVisible(want);
      }
    }

    // 1. Look first: movement should use this frame's facing.
    this.player.updateLook(dt);

    // 2. Fixed-step simulation.
    const ctx = { player: this.player };
    this.physics.step(dt, (fdt) => {
      this.player.fixedUpdate(fdt);
      this.enemies.fixedUpdate(fdt, ctx);
    });

    // 3. Dynamic meshes follow their bodies (interpolated).
    this.physics.syncMeshes();

    // 4. Camera (bob, recoil, lean, shake).
    this.player.update(dt, this.physics.alpha);

    // 5. Weapons need the final camera transform for accurate raycasts.
    this.weapons.update(dt);
    this.viewModel.syncCamera();
    this._updateNetwork(dt);

    // 6. Everything else.
    this.enemies.update(dt, this.physics.alpha);
    this.pickups.update(dt, this.camera);
    this._updatePendingExplosions(dt);
    this.fx.update(dt, this.camera);
    this._updateScope(dt);
    this._updateFocus(dt);

    // Audio listener follows the camera.
    this.camera.getWorldDirection(this._camForward);
    this._camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.updateListener(this.camera.position, this._camForward, this._camUp);

    // Damage tint driven by how recently we were hit.
    const sinceHit = performance.now() / 1000 - this.player.lastDamageTime;
    const hurt = clamp(1 - this.player.health / this.player.maxHealth, 0, 1);
    const flash = clamp(1 - sinceHit / 0.6, 0, 1) * 0.5 + (hurt > 0.7 ? (hurt - 0.7) * 0.9 : 0);
    this.postfx.setDamage(clamp(flash, 0, 0.8));

    this._pushHud(dt);
  }

  /** Menus and post-game: keep the world alive but frozen for the player. */
  _updateIdle(dt) {
    if (this.state === GAME_STATE.GAMEOVER || this.state === GAME_STATE.VICTORY) {
      const ctx = { player: this.player };
      this.physics.step(dt, (fdt) => {
        this.player.fixedUpdate(fdt);
        this.enemies.fixedUpdate(fdt, ctx);
      });
      this.physics.syncMeshes();
      this.player.update(dt, this.physics.alpha);
      this.viewModel.syncCamera();
      this.enemies.update(dt, this.physics.alpha);
      this.fx.update(dt, this.camera);
      this._updatePendingExplosions(dt);
      this._updateScope(dt);
    } else if (this.state === GAME_STATE.PAUSED) {
      // Frozen, but keep the view model glued to the camera so nothing drifts.
      this.viewModel.syncCamera();
    } else {
      this._updateMenuCamera(dt);
      this.fx.update(dt, this.camera);
    }
  }

  /**
   * Live 3D main-menu background: a slow crane shot orbiting the warehouse.
   */
  _updateMenuCamera(dt) {
    this._menuTime += dt;
    const t = this._menuTime * 0.055;
    const radius = 30 + Math.sin(this._menuTime * 0.08) * 5;
    const height = 8.5 + Math.sin(this._menuTime * 0.11) * 2.2;

    this.camera.position.set(
      Math.sin(t) * radius,
      height,
      Math.cos(t) * radius - 4
    );
    this._tmpA.set(Math.sin(t * 1.4) * 3, 2.6, -6);
    this.camera.lookAt(this._tmpA);

    const targetFov = this.settings.get('fov') - 12;
    this.camera.fov = damp(this.camera.fov, targetFov, 3, dt);
    this.camera.updateProjectionMatrix();
    this.viewModel.syncCamera();
  }

  /** Feed the scope renderer this frame's optic state. */
  _updateScope(dt) {
    const hud = this.weapons.current;
    const progress = this.adsSystem.scopeProgress;
    if (progress <= 0.002) {
      this.scope.update(this.camera, 0, {});
      return;
    }
    const mag = this.adsSystem.magnification(hud);
    const baseFov = this.settings.get('fov');
    this.scope.update(this.camera, progress, {
      fov: (Math.atan(Math.tan((baseFov * Math.PI) / 360) / mag) * 360) / Math.PI,
      reticle: hud.def.optic?.reticle ?? 'duplex',
      magnification: mag,
      breath: this.adsSystem.breath,
      time: this._menuTime + this.stats.elapsed,
      sway: this.adsSystem.sway,
    });
  }

  /** Depth of field focuses on whatever the crosshair is over. */
  _updateFocus(dt) {
    if (!this.postfx.bokehPass) return;
    this.camera.getWorldPosition(this._tmpA);
    this.player.getAimDirection(this._focusRayDir);
    const hit = this.physics.raycast(this._tmpA, this._focusRayDir, 120, {
      excludeCollider: this.player.collider,
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
    });
    this.postfx.setFocus(hit ? hit.distance : 60, dt);
  }


  // ============================================================ multiplayer
  /**
   * Join or create a match, then drop straight into it.
   *
   * Resolves either way — a failure is reported in the lobby rather than
   * thrown, because this is called from a button handler and an unhandled
   * rejection would leave the UI stuck on "Connecting...".
   */
  async _connect({ name, room, quick = false }) {
    if (name) this.settings.set('playerName', name);
    this._wireNet();
    // Free hosting sleeps, so a first connection can legitimately take up to a
    // minute. Surface that instead of leaving the player staring at
    // "Connecting..." wondering whether it is broken.
    this.net.onProgress = (msg) => this.menus.setLobbyStatus(msg);
    try {
      const welcome = await this.net.connect({
        name: name || this.settings.get('playerName') || 'OPERATOR',
        room,
        quick,
      });
      this.menus.inviteLink = inviteUrl(welcome.r);
      this.menus.showInvite(welcome.r);
      this.menus.setLobbyStatus(
        room ? 'Joined. Dropping in...' : 'Match created. Dropping in...', 'ok',
      );
      // Quick match drops in immediately: there is no code to read, because
      // the player never asked for one. Creating a match holds for a moment so
      // the invite link is legible before the overlay goes.
      const hold = quick ? 250 : room ? 350 : 1400;
      setTimeout(() => { if (this.net.connected) this.startGame(); }, hold);
    } catch (err) {
      this.menus.setLobbyStatus(err.message || 'Could not connect.', 'error');
      if (quick) throw err;      // the PLAY button reports its own failures
    }
  }

  /**
   * Float a damage number off a remote player's body.
   *
   * Uses the same `addDamageNumber` the single-player path does rather than a
   * parallel implementation. That one tracks the world position every frame,
   * so the number stays on the target as they move, and it honours the
   * `damageNumbers` setting — a second implementation ignored the setting, so
   * turning them off did nothing in multiplayer.
   *
   * Anchored at chest height, because a body's origin is between its feet and
   * the number would otherwise rise out of the floor.
   *
   * @param {number} victimId
   * @param {number} damage
   * @param {{headshot?: boolean, kill?: boolean}} [kind]
   */
  _showDamageNumberAt(victimId, damage, kind = {}) {
    const body = this.remotes?.bodies?.get(victimId);
    if (!body || !this.ui?.addDamageNumber) return;
    this._tmpA.copy(body.group.position);
    this._tmpA.y += 1.35;
    this.ui.addDamageNumber(
      this._tmpA,
      damage,
      kind.kill ? 'kill' : kind.headshot ? 'head' : '',
    );
  }

  /** Attach handlers once; connect() may be called repeatedly. */
  _wireNet() {
    if (this._netWired) return;
    this._netWired = true;
    const net = this.net;

    net.onWelcome = ({ spawn }) => {
      // The server owns spawn points, so adopt the one it gave us rather than
      // the single-player start.
      //
      // Held as well as applied, because startGame() runs shortly afterwards
      // and its _resetWorld() respawns the player at Level.playerSpawn — which
      // silently put every player on the same tile.
      this._pendingSpawn = spawn;
      if (spawn) this._placePlayer(spawn);
    };

    net.onCorrection = (pos) => {
      // The server rejected where we said we were. Snap, do not smooth: easing
      // toward a corrected position keeps feeding it rejected inputs.
      this._placePlayer(pos);
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
      this._pendingSpawn = pos;
      this._placePlayer(pos);
      this.player.velocity.set(0, 0, 0);
    };

    net.onRespawn = (pos) => {
      this._pendingSpawn = pos;
      this._placePlayer(pos);
      this.player.velocity.set(0, 0, 0);
      this.player.health = this.player.maxHealth;
      this.player.alive = true;
      this.ui.hideRespawn?.();
      this._respawnAt = 0;
      this.input.requestPointerLock?.();
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
          this.player.health = h.hp;
          if (h.armor !== null) this.player.armor = h.armor;
          this.ui.showHeal?.();
        }
        return;
      }

      if (h.isSelfVictim) {
        // Health and armour are both server-owned; mirror them rather than
        // subtracting locally. The client's own absorption maths would fight
        // the server's and lose on the very next update.
        this.player.health = h.hp;
        if (h.armor !== null) this.player.armor = h.armor;
        this.stats.damageTaken += h.damage;

        // Point the damage arc at whoever shot us. Without a direction you
        // have no idea where the fire is coming from, which is the single most
        // disorienting thing about being shot at in a shooter.
        //
        // The attacker's position comes from the interpolated sample, which is
        // where they were drawn when the shot landed — so the arc agrees with
        // what was on screen. Same angle convention as the single-player path
        // above: world bearing, then rotated into the player's own frame.
        let angle = null;
        const shooter = this._netSample?.get(h.attacker);
        if (shooter) {
          this._tmpA.set(shooter.x, shooter.y, shooter.z).sub(this.player.position);
          angle = Math.atan2(this._tmpA.x, this._tmpA.z) - (this.player.yaw + Math.PI);
        }
        this.ui.showDamage(clamp(h.damage / 45, 0.12, 0.6), angle);
        this.audio.play('playerHurt', { volume: 0.8 });
        // Jolt the view away from the shooter, so the round is felt as well as
        // seen. View-only — it never moves where the player is actually aiming.
        if (angle !== null) {
          this.player.kickFromHit(angle, clamp(h.damage / 40, 0.2, 1));
        }
      } else {
        this.remotes.flash(h.victim);
      }
      // showHitmarker(kill, headshot) — the headshot flag has to go in the
      // SECOND slot. Passing it first drew every headshot as a kill marker and
      // meant the headshot marker never appeared at all.
      if (h.isSelfAttacker) {
        this.ui.showHitmarker(false, h.part === 'head');
        // The number floats off the body you hit, so you can read exactly what
        // landed mid-fight instead of guessing from a health bar.
        this._showDamageNumberAt(h.victim, h.damage, { headshot: h.part === 'head' });
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
      const def = getWeaponDef(f.weapon);
      if (!def || !Array.isArray(f.origin)) return;

      // The server relays the shooter's CAMERA position, which is inside their
      // head. Prefer the muzzle of the gun in their hands, so the flash is on
      // the barrel rather than hanging in front of their face.
      this._tmpA.set(f.origin[0], f.origin[1], f.origin[2]);
      const hasBody = this.remotes?.muzzleWorldPosition(f.shooter, this._tmpB);
      const from = hasBody ? this._tmpB : this._tmpA;

      const dir = Array.isArray(f.direction)
        ? this._tmpC.set(f.direction[0], f.direction[1], f.direction[2])
        : this._tmpC.set(0, 0, -1);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();

      // Throwables and hazards have no barrel to flash: a frag going off is an
      // explosion, and drawing a muzzle flash at the blast centre would be
      // nonsense. Their own FX are already driven by the damage they do.
      const silentMuzzle = def.category === 'throwable' || def.category === 'hazard';
      if (!silentMuzzle && def.category !== 'melee') {
        this.fx.spawnMuzzleFlash(from, dir, def.muzzleScale ?? 1, true);

        /*
         * A tracer, so a shot that MISSES is still visible — which is the one
         * you most need to see, because it tells you someone is shooting and
         * roughly from where. Traced to the weapon's own range rather than to
         * an impact point: the server does not say what was hit, and a round
         * that hit nothing has no impact point to trace to.
         */
        this._tmpD.copy(dir).multiplyScalar(Math.min(def.range ?? 80, 90)).add(from);
        this.fx.spawnTracer(from, this._tmpD, { width: 0.03 });
      }

      // Positional, so it carries a direction and a distance — the whole point
      // is knowing WHERE the shooting is coming from.
      if (def.fireSound) {
        this.audio.play(def.fireSound, { position: from, volume: 0.85 });
      }
    };

    net.onKill = (k) => {
      this.ui.addKillFeed?.(
        k.attackerName + ' \u2192 ' + k.victimName + (k.headshot ? '  HS' : ''),
        k.isSelfAttacker,
      );
      if (k.isSelfAttacker) {
        this.stats.kills++;
        if (k.headshot) this.stats.headshots++;
        // 'killConfirm' — there is no synth called 'hitConfirm', so this was
        // silently warning to the console and playing nothing on every kill.
        this.audio.play('killConfirm', { volume: 0.9 });
        // The kill marker is a distinct shape and colour from a hit, because
        // "they are dead" is the one piece of information you must not miss.
        this.ui.showHitmarker(true, k.headshot);
      }
      if (k.isSelfVictim) {
        this.stats.deaths++;
        this.player.alive = false;
        this.player.health = 0;
        this._respawnAt = performance.now() + 2500;
        this.ui.showRespawn?.(k.attackerName);
        // Anything still in flight belongs to the life that just ended.
        this.weapons?.clearGrenades?.();
        // Deliberately does NOT release pointer lock. Doing so fires
        // onPointerLockChange(false), which pauses the game — so every death
        // threw up the PAUSE menu with a RESUME button, in the middle of a
        // match, for both the victim and after every kill. You stay locked in
        // and watch the respawn counter, which is what a shooter should do.
      }
    };

    net.onScore = (roster) => this.ui.setScoreboard?.(roster, net.selfId, net.match);
    net.onMatch = (match) => {
      this.ui.setScoreboard?.(net.roster(), net.selfId, match);
      if (match.state === MATCH_STATE.OVER) {
        const winner = net.nameOf(match.winnerId);
        this.ui.showBanner((match.winnerId === net.selfId ? 'YOU WIN' : winner + ' WINS'), 4);
        this.ui.setScoreboardVisible?.(true);
      } else if (match.state === MATCH_STATE.LIVE) {
        this.ui.setScoreboardVisible?.(false);
      }
    };

    net.onLeft = (id) => this.remotes.bodies.has(id) && this.remotes.sync(
      new Map([...(this.remotes._lastSample ?? [])].filter(([k]) => k !== id)),
      new Map(), 0,
    );

    net.onStateChange = (state, detail) => {
      if (state === NET_STATE.OFFLINE && this.hasActiveRun) {
        this.ui.showNetWarning?.(detail || 'Disconnected from the match.');
      }
    };

    net.onDenied = (why) => this.ui.showNetWarning?.(why);

    // Hit registration: the weapon asks who is on the ray, and reports claims.
    this.weapons.remoteHitTest = (origin, dir, maxDist) =>
      (net.connected ? this.remotes.raycast(origin, dir, maxDist) : null);
    this.weapons.onRemoteHit = (hit) => {
      // A shotgun reports its whole spread as one claim, so this may be an
      // array. Sending it as a single message matters: the server charges one
      // fire-rate token per MESSAGE, so nine pellets sent separately spend
      // nine tokens and most of the blast is discarded.
      const claims = Array.isArray(hit) ? hit : [hit];
      if (!claims.length) return;
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
      this.camera.getWorldPosition(this._tmpA);
      net.sendShot({
        origin: this._tmpA,
        direction: this._camForward,
        weaponId: claims[0].weaponId,
        hits: claims.map((c) => ({ victimId: c.victimId, part: c.part })),
      });
    };
  }

  /** Put the local player exactly where the server says, physics included. */
  _placePlayer(pos) {
    this.player.position.set(pos[0], pos[1], pos[2]);
    this._syncPlayerBody();
  }

  /** Keep the physics body in step after the server moves us. */
  _syncPlayerBody() {
    this.player.body?.setTranslation?.(
      { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
      true,
    );
    this.player.prevPosition.copy(this.player.position);
    this.player.renderPosition.copy(this.player.position);
  }

  /** Pack the local player's animation state for the wire. */
  _playerFlags() {
    let f = 0;
    const p = this.player;
    if (p.crouching) f |= FLAG.CROUCH;
    if (p.sprinting) f |= FLAG.SPRINT;
    if (!p.grounded) f |= FLAG.AIRBORNE;
    if (this.weapons.ads.progress > 0.5) f |= FLAG.ADS;
    if (this.weapons.fireBuffer > 0) f |= FLAG.FIRING;
    if (!p.alive) f |= FLAG.DEAD;
    if (this.lean.amount < -0.3) f |= FLAG.LEAN_L;
    if (this.lean.amount > 0.3) f |= FLAG.LEAN_R;
    return f;
  }

  /** Send our state, then draw everyone else. */
  _updateNetwork(dt) {
    const net = this.net;
    if (!net?.connected) return;

    net.sendInput({
      position: this.player.position,
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      flags: this._playerFlags(),
      weaponId: this.weapons.current?.def?.id ?? 'rifle',
    });

    this._netSample = net.sample(performance.now(), this._netSample);
    // net.players is already a Map of exactly what sync() wants. Rebuilding it
    // here was allocating an array and a Map on every single frame for nothing.
    this.remotes.sync(this._netSample, net.players, dt);

    // Dead: hold still and offer a respawn once the server's timer is up.
    if (!this.player.alive && this._respawnAt) {
      const left = Math.max(0, this._respawnAt - performance.now());
      this.ui.updateRespawn?.(Math.ceil(left / 1000));
      if (left <= 0) net.requestRespawn();
    }
  }

  leaveMatch() {
    this.net?.disconnect();
    this.remotes?.clear();
    this.weapons.remoteHitTest = null;
    this.weapons.onRemoteHit = null;
    this._respawnAt = 0;
    this.ui.hideRespawn?.();
    this.ui.hideNetWarning?.();
  }

  _pushHud(dt) {
    this.ui.updateHud(
      {
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        armor: this.player.armor,
        maxArmor: this.player.maxArmor,
        weapon: this.weapons.hudState(),
        lean: this.lean.amount,
        match: this.net?.connected ? this.net.match : null,
        room: this.net?.room ?? null,
        ping: this.net?.ping ?? 0,
        leader: this.net?.connected ? (this.net.roster()[0] ?? null) : null,
        score: this.stats.kills,
        fps: this.clock.fps,
        netDebug: this.net?.connected ? {
          bodies: this.remotes?.bodies.size ?? 0,
          built: this.remotes?.created ?? 0,
          interp: Math.round(this.net.interpDelay),
          claimed: this.net.shotsClaimed,
          confirmed: this.net.hitsConfirmed,
        } : null,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        fov: this.camera.fov,
        camera: this.camera,
      },
      dt
    );
  }

  _render(dt) {
    // Reset here rather than at the top of the frame: `info.render` then
    // holds the *previous* frame's totals when the HUD reads it.
    this.renderer.info.reset();

    // The scope's view is rendered first, into its own texture, by a camera
    // restricted to the world layer — so the weapon can never appear in it.
    this.scope.renderTexture();
    this.postfx.render(dt);
    this.scope.renderOverlay();
  }

  // ================================================================ cleanup
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);

    this.input?.dispose();
    this.audio?.dispose();
    this.scope?.dispose();
    this.postfx?.dispose();
    this.pickups?.dispose();
    this.enemies?.dispose();
    this.weapons?.dispose();
    this.viewModel?.dispose();
    this.player?.dispose();
    this.fx?.dispose();
    this.level?.dispose();
    this.assets?.dispose();
    this.physics?.dispose();
    this.renderer?.dispose();
  }
}

export { TAG_KIND };

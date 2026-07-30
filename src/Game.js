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
import { getDifficulty } from './core/Difficulty.js';
import { PhysicsWorld, initRapier, TAG_KIND } from './physics/PhysicsWorld.js';
import { Level } from './world/Level.js';
import { PickupManager } from './world/PickupManager.js';
import { Player } from './player/Player.js';
import { LeanSystem } from './player/LeanSystem.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
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
    this._camForward = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._focusRayDir = new THREE.Vector3();

    this._bindUi();
    this._bindWindow();
  }

  _blankStats() {
    return {
      score: 0, kills: 0, headshots: 0, waveReached: 1,
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
    this.menus.onPlay = () => this.startGame();
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
    this.menus.onContinue = () => this.resume();
    this.menus.onResume = () => this.resume();
    this.menus.onRestart = () => this.restart();
    this.menus.onQuitToMenu = () => this.quitToMenu();
    this.menus.onLoadoutChanged = () => {
      // Applies immediately so the change is visible next time you deploy.
      if (this.weapons && this.state !== GAME_STATE.PLAYING) {
        this.weapons.applyLoadout(
          this.settings.get('loadoutPrimary'),
          this.settings.get('loadoutSecondary')
        );
      }
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
    this.player.onDeath = () => this._gameOver();
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
    this.pickups.onCollect = (type, label, cls) => this.ui.showToast(label, cls);
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

    this._detonate(pos, prop.blastRadius, prop.blastDamage, prop.blastForce, false);

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
  _detonate(pos, radius, damage, force, fromPlayer) {
    this.physics.applyExplosion(pos, radius, force);
    this.enemies.applyExplosionDamage(pos, radius, damage, fromPlayer ? 'player' : 'explosion');

    this._tmpB.copy(this.player.position);
    this._tmpB.y += 0.3;
    const pd = this._tmpB.distanceTo(pos);
    if (pd < radius && this.physics.hasLineOfSight(pos, this._tmpB)) {
      const falloff = 1 - pd / radius;
      // Your own grenades hurt, but less than a barrel going off in your face.
      const selfScale = fromPlayer ? 0.5 : 0.75;
      this.player.applyDamage(damage * falloff * falloff * selfScale, pos, 'explosion');
      const kick = this._tmpB.clone().sub(pos).normalize().multiplyScalar(10 * falloff);
      kick.y = Math.abs(kick.y) + 5 * falloff;
      this.player.applyImpulse(kick);
      this.player.addShake(0.9 * falloff);
    } else if (pd < radius * 2.2) {
      this.player.addShake(0.35 * (1 - pd / (radius * 2.2)));
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

  startGame() {
    this.audio.init();
    this.audio.resume();
    this.audio.startAmbience();

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
    return [
      ['SCORE', this.stats.score.toLocaleString()],
      ['THREAT LEVEL', getDifficulty(this.settings.get('difficulty')).label],
      ['WAVE REACHED', `${this.stats.waveReached} / ${this.enemies.totalWaves}`],
      ['ELIMINATIONS', this.stats.kills],
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

    if (this.state === GAME_STATE.PLAYING) {
      this._updatePlaying(dt);
    } else {
      this._updateIdle(dt);
    }

    this._render(dt);
    this.input.endFrame();
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
  async _connect({ name, room }) {
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
      });
      this.menus.inviteLink = inviteUrl(welcome.r);
      this.menus.showInvite(welcome.r);
      this.menus.setLobbyStatus(
        room ? 'Joined. Dropping in...' : 'Match created. Dropping in...', 'ok',
      );
      // Brief pause so the code and invite link are actually readable before
      // the overlay disappears.
      setTimeout(() => { if (this.net.connected) this.startGame(); }, room ? 350 : 1400);
    } catch (err) {
      this.menus.setLobbyStatus(err.message || 'Could not connect.', 'error');
    }
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

    net.onRespawn = (pos) => {
      this._pendingSpawn = pos;
      this._placePlayer(pos);
      this.player.health = this.player.maxHealth;
      this.player.alive = true;
      this.ui.hideRespawn?.();
      this._respawnAt = 0;
      this.input.requestPointerLock?.();
    };

    net.onHit = (h) => {
      if (h.isSelfVictim) {
        // Health is server-owned; mirror it rather than subtracting locally.
        this.player.health = h.hp;
        this.player.onDamaged?.(h.damage);
        this.ui.flashDamage?.(h.damage / 60);
        this.audio.play('playerHurt', { volume: 0.8 });
      } else {
        this.remotes.flash(h.victim);
      }
      if (h.isSelfAttacker) this.ui.showHitmarker(h.part === 'head');
    };

    net.onKill = (k) => {
      this.ui.addKillFeed?.(
        k.attackerName + ' \u2192 ' + k.victimName + (k.headshot ? '  HS' : ''),
        k.isSelfAttacker,
      );
      if (k.isSelfAttacker) {
        this.stats.kills++;
        if (k.headshot) this.stats.headshots++;
        this.audio.play('hitConfirm', { volume: 0.9 });
      }
      if (k.isSelfVictim) {
        this.player.alive = false;
        this.player.health = 0;
        this._respawnAt = performance.now() + 2500;
        this.ui.showRespawn?.(k.attackerName);
        this.input.exitPointerLock?.();
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
      net.sendShot({
        origin: hit.point, direction: this._camForward,
        weaponId: hit.weaponId,
        hits: [{ victimId: hit.victimId, part: hit.part }],
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

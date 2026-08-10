/**
 * Game — bootstraps every system, owns the main loop and the game state
 * machine, and wires the systems to each other through callbacks.
 *
 * Rendering is layered:
 *   LAYER_WORLD      the arena, other players, props, particles
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
 *   6. pickups, particles, UI
 *   7. scope render-to-texture, main render, scope overlay
 *
 * States: loading -> menu -> playing <-> paused -> gameover
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
import { WeaponViewModel } from './weapons/WeaponViewModel.js';
import { ADSSystem } from './weapons/ADSSystem.js';
import { ParticleManager } from './fx/ParticleManager.js';
import { PostFX } from './fx/PostFX.js';
import { ScopeRenderer, LAYER_WORLD } from './fx/ScopeRenderer.js';
import { AudioManager } from './audio/AudioManager.js';
import { UIManager } from './ui/UIManager.js';
import { MenuManager, RESUME_MATCH } from './ui/MenuManager.js';
import { Minimap } from './ui/Minimap.js';
import { NetworkClient, inviteUrl, roomFromUrl } from './net/NetworkClient.js';
import { MAPS, getMap, DEFAULT_MAP_ID } from './world/maps/index.js';
import { ensureThumbnail, getThumbnail } from './world/MapThumbnail.js';
import { ensurePortraits } from './weapons/WeaponPortrait.js';
import { WEAPON_DEFS } from './weapons/WeaponDefinitions.js';
import { RemotePlayers } from './net/RemotePlayers.js';
import { RemoteAudio } from './net/RemoteAudio.js';
import { FlagObjects } from './net/FlagObjects.js';
import { arenaFor, voidDeathY } from './net/arena.js';
import { TEAM, DEFAULT_MODE_ID, getMode } from './net/modes.js';
import { wireNetwork } from './net/wireNetwork.js';
import {
  FLAG, MATCH_STATE, MATCH_RULES, DEFAULT_NAME, hasRealName,
} from './net/protocol.js';
import { clamp, damp, randRange } from './core/MathUtils.js';

export const GAME_STATE = Object.freeze({
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
});

const ANISOTROPY = { low: 1, medium: 4, high: 8, ultra: 16 };

/**
 * How far out of an exploding object a blast's line-of-sight test begins.
 *
 * Large enough to clear a grenade (14 cm) or a barrel, small enough that a
 * wall pressed against one still blocks it.
 */
const BLAST_SKIP = 0.35;

/**
 * A barrel that has already gone off does not block anything.
 *
 * Disabling a Rapier body does NOT take its collider out of raycasts, so an
 * exploding barrel was stopping its own blast: the sight test starts at the
 * barrel's centre and hit that same collider at distance zero. BLAST_SKIP
 * alone cannot cover it — a barrel is 0.55 m half-height, so stepping 0.35 m
 * along the ray is still inside it, and a skip big enough to clear a barrel
 * would let blasts see through thin walls.
 *
 * This is also right for chain reactions: the barrel that set this one off is
 * invisible and gone, and should not shield anybody.
 */
const notAlreadyBlownUp = (tag) => !(tag.prop && tag.prop.exploded);


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
    /** Straight down, for ground probes. Constant — never write to it. */
    this._down = new THREE.Vector3(0, -1, 0);
    // Its own scratch rather than _tmpA. The surface probe runs in the middle
    // of remotes.sync(), and sharing a scratch across a call that deep is how
    // you get a bug that only shows up with several players on screen.
    this._probeAt = new THREE.Vector3();
    this._probeDir = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._focusRayDir = new THREE.Vector3();

    this._bindUi();
    this._bindWindow();
  }

  _blankStats() {
    return {
      score: 0, kills: 0, deaths: 0, headshots: 0,
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

      /*
       * Both flags and their bases. Empty until a map is built, and created
       * BEFORE the first build — _buildLevel is what populates it, so a
       * flagObjects made later than the arena is a flagObjects that misses the
       * only build that ever happens in a session where the map never changes.
       */
      this.flagObjects = new FlagObjects(this.scene, () => this._netSample);

      this.menus.setLoadingProgress(0.58, 'Building arena');
      this._buildLevel(this.settings.get('mapId') ?? DEFAULT_MAP_ID);

      // Multiplayer. The client is created but idle until a match is joined,
      // so a failed or absent server never blocks the game from booting.
      this.net = new NetworkClient();

      this.menus.setLoadingProgress(0.72, 'Spawning effects');
      this.fx = new ParticleManager(this.scene, this.assets, this.settings);
      /*
       * The other players become audible here.
       *
       * Footsteps, landings and reloads, all derived from the snapshot the
       * client already receives — see net/RemoteAudio.js. The surface probe is
       * what makes a catwalk ring and concrete thud; without it everyone walks
       * on concrete, which is most of this arena anyway.
       */
      this.remotes = new RemotePlayers({
        scene: this.scene,
        assets: this.assets,
        audio: new RemoteAudio({
          audio: this.audio,
          surfaceProbe: (x, y, z) => this._surfaceUnder(x, y, z),
        }),
      });

      /** Death sequence: who did it, and whether the countdown is up yet. */
      this._killedBy = null;
      this._respawnShown = false;
      /** When we last asked to come back. See the throttle in _updateNetwork. */
      this._respawnAskedAt = 0;


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

      /*
       * Photograph the maps nobody has played yet, now, while the menu is up.
       *
       * Deliberately not awaited: the game is already interactive and this is
       * a background nicety. A failure costs nothing but a drawn plan on a
       * card.
       */
      this.primeMapThumbnails().catch(() => { /* the cards fall back to plans */ });

      /*
       * And photograph the arsenal, for the same reason and at the same moment.
       *
       * Twelve small offscreen renders, once per browser, cached exactly as the
       * map photographs are. A weapon whose model failed to load is skipped and
       * its card keeps its silhouette — the AR-15's glTF is already optional,
       * so a portrait has to be.
       */
      try {
        ensurePortraits(this.renderer, this.assets, WEAPON_DEFS);
      } catch (err) {
        console.warn('[Game] Weapon portraits unavailable.', err);
      }

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
    /*
     * The menu asks who is playing where. Game owns the network client, so it
     * is the one place that can answer without MenuManager learning about
     * sockets, regions or environment variables.
     */
    this.menus.onPopulation = () => this.net?.fetchPopulation?.() ?? null;

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
    // BACK out of a loadout opened with B goes straight back into the match.
    this.menus.onResumeFromLoadout = () => this.resume();
    this.menus.onRestart = () => this.restart();
    this.menus.onQuitToMenu = () => this.quitToMenu();
    /*
     * The player picked a map. Build it now, before any connecting happens.
     *
     * Building the world is the slow part of starting a match, and doing it
     * after the socket is up means arriving in a live game and then freezing
     * for a second while the arena appears around you.
     */
    this.menus.onMapChosen = (mapId) => this.setMap(mapId);

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
    // --------------------------------------------------------- the weapons
    /*
     * ONE PRODUCER EACH: the marker is local, the number is the server's.
     *
     * Both used to be fired from here AND again from the HIT message a round
     * trip later, so every shot on a player drew two damage numbers — and on a
     * headshot they DISAGREED, because only the server applies the part
     * multiplier. An AR-15 headshot read "24" here and "48" there, about a
     * fifth of a second apart, on the same bullet.
     *
     * They are split by what each is for rather than both going one way. The
     * marker answers "did that land?" and is worthless late, so it stays here,
     * instant and predicted. The number answers "how much?" and is worthless
     * wrong, so it comes from the only side that knows — see the HIT handler in
     * wireNetwork.js, which no longer draws a marker.
     */
    this.weapons.onHit = (info) => {
      this.ui.showHitmarker(info.killed, info.headshot);
    };
    this.weapons.onPropHit = (prop, dmg, point, dir) => this._damageProp(prop, dmg, point, dir);
    this.weapons.onGrenadeExplode = (pos, def) => {
      this._detonate(pos, def.blastRadius, def.damage, 420, true);
    };

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
   * every player in range, knockback, full FX and a scorch mark.
   */
  /**
   * @param sourceId  weapon or hazard id the blast is reported to the server
   *                  as. A barrel used to claim to be a grenade, so barrels hit
   *                  for the frag's 130 rather than their own 95 in a match and
   *                  the kill feed credited a grenade nobody had thrown.
   */
  _detonate(pos, radius, damage, force, fromPlayer, sourceId = 'grenade') {
    this.physics.applyExplosion(pos, radius, force);

    this._tmpB.copy(this.player.position);
    this._tmpB.y += 0.3;
    const pd = this._tmpB.distanceTo(pos);
    /*
     * BLAST_SKIP steps the sight test past whatever produced the blast.
     *
     * The ray starts at the centre of the exploding object, so it hit that
     * object's own collider at distance zero and reported no line of sight to
     * anybody — a grenade at your feet did nothing to you at all.
     */
    const caughtInBlast = pd < radius
      && this.physics.hasLineOfSight(pos, this._tmpB, notAlreadyBlownUp, BLAST_SKIP);
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
     * Explosions only ever damaged the local player, so in a deathmatch a
     * grenade landing at someone's feet did nothing at all — the one weapon in
     * the loadout that could not hurt anybody.
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
        if (!this.physics.hasLineOfSight(pos, this._tmpB, notAlreadyBlownUp, BLAST_SKIP)) continue;
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
      'shootSmg', 'shootLmg', 'shootSniper', 'shootMarksman',
      'explosion', 'hitmarker', 'killConfirm',
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

  /**
   * Straight from the match into the loadout, on one key.
   *
   * Everything `pause` does, because a menu with the pointer still locked and
   * the world still simulating is how you come back to the game having been
   * shot by somebody you could not see. The only difference is the screen it
   * lands on and where its BACK goes — see RESUME_MATCH.
   */
  openLoadoutFromMatch() {
    if (this.state !== GAME_STATE.PLAYING) return;
    this._setState(GAME_STATE.PAUSED);
    this.input.exitPointerLock();
    this.input.clearAll();
    this.audio.setMuffled(true);
    this.menus.openLoadout(RESUME_MATCH);
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
      this.menus.showResults(this._buildStatLines());
      this.ui.showHud(false);
    }, 1400);
  }

  _buildStatLines() {
    const t = this.stats.elapsed;
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60).toString().padStart(2, '0');
    const acc = this.weapons.shotsFired > 0
      ? Math.round((this.weapons.shotsHit / this.weapons.shotsFired) * 100)
      : 0;
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
    // Before the weapon reset: aborting hands the player's weapon back, and
    // doing it after would put the handset in their hands for the new round.
    this.pickups.reset();
    this.fx.reset();
    this.weapons.reset();
    this.lean.reset();
    this.adsSystem.reset();
    /*
     * And the scope with it, or it stays drawn over the main menu.
     *
     * `_updateScope` only runs from the PLAYING and GAMEOVER arms of the loop,
     * but `_render` calls the scope's two draw passes in EVERY state. So
     * leaving a match while scoped — Esc, LEAVE MATCH, or the results screen's
     * own button — froze `active` at true and left the menu's live 3D
     * background replaced by a magnified view inside a black tube, reticle and
     * all, until the next match started.
     *
     * Zeroing it here rather than reviving `_updateScope` in the menu arms is
     * deliberate: the other way keeps `active` true and pays for a full extra
     * scene render behind the menu on every frame.
     */
    this.scope?.update(this.camera, 0, {});
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
    /*
     * Clamped at BOTH ends.
     *
     * The upper bound stops a long stall being integrated as one enormous
     * step. The lower bound guards a negative dt, which sounds impossible —
     * performance.now() is monotonic — but arrives the moment anything else
     * drives this loop alongside the animation frame, and a single negative
     * step is unrecoverable rather than merely wrong: it puts NaN into a
     * position, every damp() and hypot() downstream propagates it, and the
     * player never comes back. Found exactly that way, driving the loop from a
     * timer to test remote players in a hidden tab.
     */
    dt = Math.min(Math.max(dt, 0), 0.1);

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

    /*
     * B opens the loadout straight from the match.
     *
     * Changing a gun used to be Esc, read the pause menu, find LOADOUT, click
     * — four steps and a menu you did not want, for the one thing people
     * change most often.
     *
     * NOT while scoped: B is the magnification toggle there, and that reading
     * has to win. `WeaponSystem` only consumes it above scopeProgress 0.4, so
     * the two never both fire — outside a scope the key was doing nothing at
     * all, which is exactly why it was free to take.
     */
    if (this.input.wasPressed('loadout') && this.adsSystem.scopeProgress <= 0.4) {
      this.openLoadoutFromMatch();
      return;
    }

    // Put the flag down, for handing it to someone in better shape to run it.
    // Sent unconditionally in a team mode: the server decides whether there is
    // anything to drop, and it is the only party that knows.
    if (this.input.wasPressed('dropFlag') && this.net?.connected
        && getMode(this.modeId).teamBased) {
      this.net.dropFlag();
    }

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
    this.physics.step(dt, (fdt) => this.player.fixedUpdate(fdt));

    // 3. Dynamic meshes follow their bodies (interpolated).
    this.physics.syncMeshes();

    // 4. Camera (bob, recoil, lean, shake).
    this.player.update(dt, this.physics.alpha);

    // 5. Weapons need the final camera transform for accurate raycasts.
    this.weapons.update(dt);
    this.viewModel.syncCamera();
    this._rescueOffline();
    this._updateNetwork(dt);

    // 6. Everything else.
    this.pickups.update(dt, this.camera);
    // After the sample: a carried flag rides its carrier, read from exactly
    // the numbers that drew the carrier's body this frame.
    if (this.net?.connected && getMode(this.modeId).teamBased) {
      this.flagObjects.selfId = this.net.selfId;
      this.flagObjects.update(dt);
    }
    this.minimap?.update(dt, this.player, this._netSample);
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
    if (this.state === GAME_STATE.GAMEOVER) {
      this.physics.step(dt, (fdt) => this.player.fixedUpdate(fdt));
      this.physics.syncMeshes();
      this.player.update(dt, this.physics.alpha);
      this.viewModel.syncCamera();
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
    /*
     * Sized to the map on screen, not to the warehouse. See `Level.menuOrbit`
     * — the three numbers that used to be here were measured against one map
     * and left the camera in the void beside the other two.
     */
    const shot = this.level?.menuOrbit ?? { radius: 30, height: 8.5, target: { x: 0, y: 2.6, z: 0 } };
    const radius = shot.radius * (1 + Math.sin(this._menuTime * 0.08) * 0.09);
    const height = shot.height * (1 + Math.sin(this._menuTime * 0.11) * 0.12);

    this.camera.position.set(
      Math.sin(t) * radius,
      height,
      Math.cos(t) * radius
    );
    // Drift the aim across the middle of the map rather than a fixed point six
    // metres behind it, which on a small map was behind the camera entirely.
    this._tmpA.set(
      shot.target.x + Math.sin(t * 1.4) * (shot.radius * 0.08),
      shot.target.y,
      shot.target.z,
    );
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

  /**
   * What another player is standing on, so their footsteps sound like it.
   *
   * Called from RemoteAudio, at most once per audible footstep — roughly two
   * raycasts a second per nearby player, and none at all for the ones too far
   * away to hear. Cheap enough not to need throttling of its own, unlike the
   * local player's equivalent which runs every frame and therefore does.
   *
   * @returns {string|null} a SURFACE tag, or null to fall back to concrete
   */
  // ================================================================== maps
  /**
   * Build a map, replacing whatever is standing.
   *
   * Everything downstream of the level is rebuilt with it, because everything
   * downstream of the level is ABOUT it: the minimap draws the level's own
   * footprints, the pickups sit at its spots, and the player starts at its
   * spawn. Rebuilding the world and leaving those pointed at the last one is
   * how you get a map that reads as the wrong place.
   *
   * @param {string} mapId
   */
  _buildLevel(mapId) {
    const map = getMap(mapId);

    // Out with the old — meshes, lights AND collision. See Level.dispose.
    if (this.level) {
      this.pickups?.clear?.();
      this.level.dispose();
    }

    this.level = new Level(
      this.scene, this.physics, this.assets, this.settings, this.renderer, map);
    this.level.build();
    this.level.captureResetState();

    /*
     * The minimap is rebuilt rather than told to refresh.
     *
     * It draws the static level ONCE into an offscreen canvas at construction,
     * which is the whole reason it is cheap. Keeping the old instance would
     * leave the previous arena's outline under the new one's players.
     */
    const mapCanvas = document.getElementById('minimap');
    if (mapCanvas) this.minimap = new Minimap(mapCanvas, this.level);

    // Pickups exist by the time a map is SWAPPED, but not on first boot —
    // Game builds the level before it builds them.
    this.pickups?.buildFromLevel?.(this.level);

    /*
     * Flags and bases belong to the MAP, so they are rebuilt with it.
     *
     * Built for every map whether or not the current mode uses them, and
     * hidden when it does not — the alternative is rebuilding the world when
     * the mode changes, and the mode is fixed for a room anyway.
     */
    const ctf = arenaFor(map.id).ctf;
    // `ctfBeamHeight` is the map's, because only the map knows whether there is
    // sky above its bases or a bedroom floor. Absent means outdoors.
    this.flagObjects?.build(arenaFor(map.id), map.ctfBeamHeight);
    this._applyModeVisibility();
    // The minimap is rebuilt above, so this has to be re-attached every time.
    if (this.minimap) {
      this.minimap.flags = getMode(this.modeId).teamBased ? this.flagObjects : null;
    }

    /*
     * Photograph the map the first time it is ever built.
     *
     * One render into a small offscreen target, cached in localStorage, so it
     * costs about five milliseconds once per map per browser and the card
     * shows the real place rather than a sketch of it.
     */
    ensureThumbnail(this.renderer, this.scene, map);

    /*
     * Tell the player where THIS map's world ends. Player.js cannot know — it
     * used to guess with a -12 baked in and guessed wrong on every map but the
     * warehouse it was written for. Set on every build so a map change cannot
     * leave it stale.
     *
     * It is NOT told where to land any more. Knowing a destination is what
     * tempted it into placing itself, and a client that places itself while
     * connected gets its next input refused as a teleport — the mid-air frame
     * in the flicker. Placement belongs to the server, or to `_rescueOffline`.
     */
    if (this.player) this.player.voidY = voidDeathY(map.id);
    this.player?.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
    return this.level;
  }

  /** The map currently built. */
  get mapId() { return this.level?.mapId ?? DEFAULT_MAP_ID; }

  /** The mode the room is playing, or the local default outside a match. */
  get modeId() {
    return this.net?.connected ? this.net.modeId
      : (this.settings.get('modeId') ?? DEFAULT_MODE_ID);
  }

  /**
   * Flags and bases exist only in a team mode.
   *
   * Hidden rather than destroyed: a room's mode never changes, so this runs
   * once per match, and rebuilding geometry to toggle visibility would be
   * work for nothing.
   */
  _applyModeVisibility() {
    const teamMode = getMode(this.modeId).teamBased;
    for (const f of this.flagObjects?.flags?.values() ?? []) f.group.visible = teamMode;
    for (const b of this.flagObjects?.bases ?? []) b.visible = teamMode;
    if (this.minimap) this.minimap.flags = teamMode ? this.flagObjects : null;
  }

  /**
   * Make sure every map has a photograph, once, while the player reads the menu.
   *
   * Building a map takes about a second, so this would be unacceptable at any
   * other moment — but at boot nothing is running, and doing it here is what
   * lets the picker show a real render of a map you have never played. It
   * happens once per build per browser; afterwards every photo is cached and
   * this returns immediately.
   */
  async primeMapThumbnails() {
    const missing = MAPS.filter((m) => !getThumbnail(m.id) && m.id !== this.mapId);
    if (!missing.length) return;
    const restore = this.mapId;
    for (const m of missing) {
      this._buildLevel(m.id);
      // Yield so the menu keeps painting rather than freezing mid-photograph.
      await new Promise((r) => setTimeout(r, 0));
    }
    this._buildLevel(restore);
  }

  /**
   * Switch maps, doing nothing if it is already the one standing.
   *
   * Called from the menu when the player picks one, and from `_connect` when
   * the server says the room is playing something else.
   */
  setMap(mapId) {
    const wanted = getMap(mapId).id;
    if (this.level && this.level.mapId === wanted) return false;
    this._buildLevel(wanted);
    return true;
  }

  _surfaceUnder(x, y, z) {
    this._probeAt.set(x, y + 0.35, z);
    const hit = this.physics.raycast(this._probeAt, this._down, 1.4, {
      filter: (tag) => !!tag && tag.kind !== TAG_KIND.PLAYER,
    });
    return hit?.tag?.surface ?? null;
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
    /*
     * Only a REAL choice is remembered.
     *
     * This used to save whatever it was handed, and quick match handed it the
     * 'OPERATOR' placeholder as a fallback — so the first press of PLAY wrote
     * 'OPERATOR' into the player's settings for good. Every later 'has this
     * person picked a name?' check then said yes, the callsign prompt never
     * appeared again, and they were stuck with the default permanently.
     */
    if (hasRealName(name)) this.settings.set('playerName', name);
    this._wireNet();
    // Free hosting sleeps, so a first connection can legitimately take up to a
    // minute. Surface that instead of leaving the player staring at
    // "Connecting..." wondering whether it is broken.
    this.net.onProgress = (msg) => this.menus.setLobbyStatus(msg);
    try {
      const welcome = await this.net.connect({
        name: name || this.settings.get('playerName') || DEFAULT_NAME,
        room,
        quick,
        mapId: this.mapId,
        modeId: this.settings.get('modeId') ?? DEFAULT_MODE_ID,
      });

      /*
       * The ROOM decides which map, not us.
       *
       * Joining a friend's code means playing their map, and quick match can
       * legitimately put us in a room that already exists. Rebuilding here is
       * the difference between arriving in the right place and walking around
       * an arena whose collision belongs to a different one.
       */
      if (welcome.mapId && welcome.mapId !== this.mapId) {
        this.menus.setLobbyStatus(
          `This match is on ${getMap(welcome.mapId).name}. Loading it…`);
        this.setMap(welcome.mapId);
      }
      // The room's mode is equally not ours to choose — flags and bases have
      // to appear or disappear to match it.
      this._applyModeVisibility();
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
  /** All multiplayer wiring — see src/net/wireNetwork.js. */
  _wireNet() {
    if (this._netWired) return;
    this._netWired = true;
    wireNetwork(this);
  }

  /**
   * MOVE the local player to where the server says, and change nothing else.
   *
   * This is the CORRECTION half of the pair. It does not touch aliveness,
   * health or the void latch — a correction is the server saying "you are not
   * where you claimed", which is true whether you are alive or dead and says
   * nothing about either. Reviving is `_revivePlayer`, and the two are kept
   * apart on purpose: conflating them is how an anti-cheat snap-back ended up
   * standing a dead player up in mid-air.
   */
  _placePlayer(pos) {
    this.player.position.set(pos[0], pos[1], pos[2]);
    // `_syncPlayerBody` snaps the render history as well as the body — a
    // teleport has no history to slide from, and leaving `prevPosition` out in
    // the air makes the camera GLIDE in from there instead of cutting.
    this._syncPlayerBody();
  }

  /**
   * The server has SPAWNED us. Mirror that exactly, through the one door.
   *
   * `Room.spawn` sets alive, full health, full armour and a spawn point on its
   * side; `Player.revive` is the client's matching statement, and it is the
   * only thing in the client allowed to say `alive = true`. Before this, the
   * respawn handler set three of those fields inline and left `fellOutOfWorld`
   * latched — so the guard below killed the player again one frame later and
   * they could not move for the rest of the match.
   */
  _revivePlayer(pos) {
    this._tmpA.set(pos[0], pos[1], pos[2]);
    this.player.revive(this._tmpA);
  }

  /** Keep the physics body in step after the server moves us. */
  _syncPlayerBody() {
    const p = this.player.position;
    this.player.body?.setTranslation?.({ x: p.x, y: p.y, z: p.z }, true);
    // Retarget as well as move — see the note in `Player.revive`. A kinematic
    // body that has been moved but not retargeted still owes the controller
    // the destination it was last given.
    this.player.body?.setNextKinematicTranslation?.({ x: p.x, y: p.y, z: p.z });
    this.player.prevPosition.copy(p);
    this.player.renderPosition.copy(p);
  }

  /**
   * Pack the local player's animation state for the wire.
   *
   * This is the SOLE producer of the flag word — there is no second sender to
   * fall back on, so a bit missed here is a bit that does not exist in the
   * game. Two were, and both failed silently because the receiving halves were
   * complete and well tested against hand-fed input:
   *
   * RELOADING was never sent at all, so no human player has ever heard another
   * one reload; `RemoteAudio`'s whole reload branch was unreachable, and only
   * `scripts/bot.mjs` ever set the bit — which is exactly why it looked as
   * though the feature worked.
   *
   * FIRING was read off `fireBuffer`, which is spent before this runs, so it
   * was false for every semi-automatic shot ever fired. See `firingNow`.
   */
  _playerFlags() {
    let f = 0;
    const p = this.player;
    if (p.crouching) f |= FLAG.CROUCH;
    if (p.sprinting) f |= FLAG.SPRINT;
    if (!p.grounded) f |= FLAG.AIRBORNE;
    if (this.weapons.ads.progress > 0.5) f |= FLAG.ADS;
    if (this.weapons.firingNow) f |= FLAG.FIRING;
    if (this.weapons.reloading) f |= FLAG.RELOADING;
    if (!p.alive) f |= FLAG.DEAD;
    if (this.lean.amount < -0.3) f |= FLAG.LEAN_L;
    if (this.lean.amount > 0.3) f |= FLAG.LEAN_R;
    return f;
  }

  /**
   * Put a player who fell out of the world back, when there is no server to do
   * it.
   *
   * THE OTHER HALF OF THE INVARIANT: exactly one authority places a fallen
   * player. Online that is the server, and this must not run — a second
   * opinion is what produced the base/air/base flicker. Offline there is no
   * server, so it is this, once, through the same `revive` the network path
   * uses.
   *
   * Offline used to be silently the worst case of all: `_updateNetwork`
   * returns immediately when disconnected, so the only code that noticed the
   * latch never ran. Single-player, walking off OUTPOST left you dead and
   * frozen at the spawn with no death screen, no countdown and no way back
   * short of reloading the page — and no test or trace looked at it, because
   * every report came from a match.
   *
   * It costs no health: falling out of the world is not an injury, and there
   * is nobody to take a life for it.
   */
  _rescueOffline() {
    if (this.net?.connected) return;
    if (!this.player?.fellOutOfWorld || !this.level) return;
    this.player.revive(this.level.playerSpawn, { yaw: this.level.playerSpawnYaw });
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
    /*
     * Which side WE are on, read fresh each frame from the server's roster.
     *
     * Not cached at join: teams are rebalanced when players come and go, and a
     * stale value here would mark the wrong half of the room as friendly —
     * which is worse than marking nobody, because it is confidently wrong
     * about the one call you cannot take back.
     */
    this.remotes.selfTeam = net.players?.get(net.selfId)?.team ?? TEAM.NONE;
    this.remotes.sync(this._netSample, net.players, dt, this.player.position);

    /*
     * Dead: stand at your own spawn and watch the counter.
     *
     * You are moved to the spawn point at the moment of death rather than at
     * the end of the wait — see the SPAWNPOINT message — so the countdown runs
     * where you are about to be standing rather than over your own corpse.
     */
    if (!this.player.alive && this._respawnAt) {
      const left = Math.max(0, this._respawnAt - performance.now());
      if (left <= MATCH_RULES.respawnCountdownSec * 1000) {
        if (!this._respawnShown) {
          this._respawnShown = true;
          this.ui.showRespawn?.(this._killedBy);
        }
        this.ui.updateRespawn?.(Math.ceil(left / 1000));
      }
      /*
       * Ask — but no more than four times a second.
       *
       * The server refuses anything before its own floor, and that floor and
       * this countdown are now the SAME figure, so whether our ask lands before
       * or after it comes down to clock skew and latency. When it lands early
       * it is refused, and an unthrottled retry then sends one message per
       * frame until the floor passes. At 200 messages a second the server does
       * not throttle a client, it DISCONNECTS it — so the failure mode is
       * being kicked out of the match for the crime of dying on a fast machine.
       *
       * Four a second is far below anything that could trip it and far above
       * anything a player could notice.
       */
      if (left <= 0 && performance.now() - this._respawnAskedAt > 250) {
        this._respawnAskedAt = performance.now();
        net.requestRespawn();
      }
    }

    /*
     * FELL OUT OF THE WORLD. Handled HERE, on the client, and not only on the
     * server.
     *
     * OUTPOST's floor slab is 56 m across — it reaches x and z of 28 — while
     * its arena bounds reach 44. That leaves a sixteen-metre band all the way
     * round the map with nothing under it, and walking into it is not a bug a
     * player can be expected to avoid.
     *
     * The server has a kill plane for this, but it can only fire on positions
     * the client actually sends, and it sits twelve metres down. Everything
     * between the floor and that plane is time spent falling out of the world
     * with no answer coming, which is what "stuck in the air" has been.
     *
     * So the side that KNOWS it is falling deals with it: one death, at once,
     * no repeated fall damage on the way down, and a respawn asked for
     * immediately. The server's plane stays as the backstop for a client that
     * has stopped talking.
     */
    /*
     * KILL ON POSITION. ASK ON THE LATCH. NEVER THE OTHER WAY ROUND.
     *
     * These two used to share one `if`, and that is what turned a stale flag
     * into a player who could not move: `fellOutOfWorld` survived a network
     * respawn, so the block fired again while the player stood on the spawn,
     * and it killed them there. Every frame. Forever.
     *
     * Split, the flag cannot kill anybody. The worst a stale one can now do is
     * send a redundant RESPAWN four times a second, which the server ignores.
     * That is the difference between a bug you notice in a log and a bug that
     * ends the match for whoever hit it.
     */
    const belowTheWorld = this.player.position.y < voidDeathY(this.mapId);

    /*
     * Dying is done ONCE, and only for actually being out of the world.
     *
     * An older version gated this on `alive`, cleared that flag inside it and
     * so could only ever run one time — then sent its single request through
     * the throttle below, so a fall within 250 ms of any earlier ask sent
     * nothing at all. One dropped message and the player stayed out there.
     */
    if (this.player.alive && belowTheWorld) {
      this.player.velocity.set(0, 0, 0);
      this.player.fallSpeed = 0;
      // Straight to zero rather than through applyDamage: falling out of the
      // world is not an injury you can be saved from by armour.
      this.player.health = 0;
      this.player.alive = false;
      this.player.fellOutOfWorld = true;
    }

    // Asking to come back is done UNTIL IT WORKS — and only while we are still
    // down. A revive clears the latch, which is what ends this.
    if (this.player.fellOutOfWorld || (belowTheWorld && !this.player.alive)) {
      if (performance.now() - this._respawnAskedAt > 250) {
        this._respawnAskedAt = performance.now();
        net.requestRespawn();
      }
    }
  }

  leaveMatch() {
    this.net?.disconnect();
    this.remotes?.clear();
    // Or last match's shooters would still be on the map in the next one.
    this.minimap?.clear();
    this.weapons.remoteHitTest = null;
    this.weapons.onShotResolved = null;
    this._respawnAt = 0;
    this._respawnShown = false;
    this._respawnAskedAt = 0;
    this._killedBy = null;
    this.ui.hideRespawn?.();
    this.ui.hideNetWarning?.();
  }

  /** The player actually in front, or null while the match is still scoreless. */
  _currentLeader() {
    if (!this.net?.connected) return null;
    const top = this.net.roster()[0];
    if (!top || !(top.kills > 0)) return null;
    return { ...top, isSelf: top.id === this.net.selfId };
  }

  _pushHud(dt) {
    this.ui.updateHud(
      {
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        armor: this.player.armor,
        // What everybody else sees over your head. In a match that is the
        // server's copy, which is the one that actually counts.
        callsign: this.net?.connected
          ? this.net.nameOf(this.net.selfId)
          : (this.settings.get('playerName') || DEFAULT_NAME),
        maxArmor: this.player.maxArmor,
        // Read off the server's own snapshot rather than run down a local
        // timer, so the readout cannot claim protection the server has already
        // taken away — which is precisely the moment it would matter.
        spawnProtected: this.net?.connected
          && (this.net.selfFlags & FLAG.PROTECTED) !== 0,
        // The mouse is not ours yet. Worth saying out loud rather than leaving
        // the player to work out why looking around does nothing.
        needsClick: this.state === GAME_STATE.PLAYING && !this.input.pointerLocked,
        /*
         * Objective markers. Built HERE rather than in UIManager because the
         * carrier's name lives on the network client, and gated on the mode
         * because `flags` is built from the map's arena whether or not the
         * mode uses it — in deathmatch there is no carrier to point at.
         */
        flagMarkers: getMode(this.modeId).teamBased
          ? this.flagObjects?.markers().map((m) => ({
            ...m, name: m.carrier != null ? this.net?.nameOf(m.carrier) : null,
          }))
          : null,
        weapon: this.weapons.hudState(),
        lean: this.lean.amount,
        match: this.net?.connected ? this.net.match : null,
        room: this.net?.room ?? null,
        ping: this.net?.ping ?? 0,
        /*
         * Nobody leads a match nobody has scored in.
         *
         * roster() sorts by kills, then deaths, then NAME — so before anyone
         * had a kill the top entry was just whoever came first in the
         * alphabet, and every player in the room was shown that same stranger
         * labelled LEADER. It read as a name badge that had somehow got the
         * wrong name on it.
         */
        leader: this._currentLeader(),
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

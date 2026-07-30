/**
 * EnemyManager — spawning, waves, difficulty and squad-level coordination.
 *
 * Enemies are pooled: `MAX_ENEMIES` instances are created once (meshes,
 * materials and physics bodies included) and recycled for the whole session,
 * so no wave transition ever allocates.
 *
 * Squad coordination lives here rather than in the individual AI:
 *
 *   - **Attacker budget**: only a difficulty-dependent number of soldiers may
 *     engage head-on at once. The rest are told to flank or hold, which stops
 *     the "conga line into the crosshair" failure mode and makes fights feel
 *     deliberate.
 *   - **Noise routing**: gunfire, deaths, footsteps and explosions are
 *     broadcast to everyone in earshot with a falloff.
 *   - **Spawn placement**: never in front of the player, never too close.
 */

import * as THREE from 'three';
import { Enemy, STATE } from './Enemy.js';
import { pickEnemyType, scaleForDifficulty, ENEMY_TYPES } from './EnemyTypes.js';
import { getDifficulty } from '../core/Difficulty.js';
import { randRange, randInt, clamp } from '../core/MathUtils.js';

const MAX_ENEMIES = 18;

/**
 * Wave table. Counts and pacing only — health, accuracy and tactics come from
 * the archetype (EnemyTypes) crossed with the difficulty (Difficulty).
 */
export const WAVES = [
  { label: 'WAVE 1', total: 6, concurrent: 4, spawnInterval: 1.7 },
  { label: 'WAVE 2', total: 8, concurrent: 5, spawnInterval: 1.5 },
  { label: 'WAVE 3', total: 11, concurrent: 6, spawnInterval: 1.3 },
  { label: 'WAVE 4', total: 14, concurrent: 7, spawnInterval: 1.15 },
  { label: 'FINAL WAVE', total: 18, concurrent: 8, spawnInterval: 1.0 },
];

export class EnemyManager {
  constructor({ scene, physics, assets, audio, fx, level, player, nav, settings }) {
    this.scene = scene;
    this.physics = physics;
    this.level = level;
    this.player = player;
    this.audio = audio;
    this.nav = nav;
    this.settings = settings;

    this.difficulty = getDifficulty(settings.get('difficulty'));
    settings.onChange('difficulty', (v) => { this.difficulty = getDifficulty(v); });

    /** @type {Enemy[]} */
    this.pool = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = new Enemy({ scene, physics, assets, audio, fx, level, nav });
      e.onDeath = (enemy, headshot) => this._handleDeath(enemy, headshot);
      e.onShoot = (pos) => this.alertNear(pos, 26, 'gunfire');
      e.onDamagePlayer = (amount, from) => this.onPlayerDamaged?.(amount * this.difficulty.playerDamageTakenMul, from);
      e.onPropHit = (prop, dmg, point, dir) => this.onPropHit?.(prop, dmg, point, dir);
      this.pool.push(e);
    }

    this.waveIndex = -1;
    this.waveConfig = null;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.spawnTimer = 0;
    this.waveActive = false;
    this.intermission = 0;
    this.finished = false;
    this.attackerBudget = 3;

    this._tmp = new THREE.Vector3();
    this._live = [];
    this._ctx = { player, squad: this._live, attackerBudget: 3 };

    // --- callbacks (wired by Game) ---
    this.onEnemyKilled = null;
    this.onWaveStart = null;
    this.onWaveCleared = null;
    this.onAllWavesCleared = null;
    this.onPlayerDamaged = null;
    this.onDrop = null;
    this.onPropHit = null;
  }

  get activeEnemies() {
    return this.pool.filter((e) => e.active && e.alive);
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.pool) if (e.active && e.alive) n++;
    return n;
  }

  get remainingThisWave() {
    if (!this.waveConfig) return 0;
    return this.waveConfig.total - this.killedThisWave;
  }

  get totalWaves() {
    return WAVES.length;
  }

  // ------------------------------------------------------------------ waves
  reset() {
    for (const e of this.pool) e.despawn();
    this.nav.clearClaims();
    this.difficulty = getDifficulty(this.settings.get('difficulty'));
    this.waveIndex = -1;
    this.waveConfig = null;
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.waveActive = false;
    this.intermission = 0;
    this.finished = false;
  }

  startNextWave() {
    this.waveIndex++;
    if (this.waveIndex >= WAVES.length) {
      this.finished = true;
      this.onAllWavesCleared?.();
      return;
    }
    this.waveConfig = WAVES[this.waveIndex];
    this.spawnedThisWave = 0;
    this.killedThisWave = 0;
    this.spawnTimer = 0.8;
    this.waveActive = true;
    this.onWaveStart?.(this.waveIndex, this.waveConfig);
  }

  beginIntermission(seconds = 6) {
    this.waveActive = false;
    this.intermission = seconds;
  }

  // =============================================================== updating
  /** AI + movement; runs inside the fixed physics step. */
  fixedUpdate(dt, ctx) {
    // Rebuild the live list once per step rather than per enemy.
    this._live.length = 0;
    for (const e of this.pool) if (e.active && e.alive) this._live.push(e);

    this._ctx.player = ctx.player;
    this._ctx.squad = this._live;

    // Attacker budget: how many may press the frontal assault right now.
    const cap = this.difficulty.maxConcurrentAttackers;
    let engaging = 0;
    for (const e of this._live) {
      if (e.state === STATE.ATTACK && e.canSeePlayer) engaging++;
    }
    this.attackerBudget = cap - engaging;
    this._ctx.attackerBudget = this.attackerBudget;

    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i];
      if (e.active) e.fixedUpdate(dt, this._ctx);
    }
  }

  /** Spawning, wave bookkeeping and mesh animation; runs per render frame. */
  update(dt, alpha) {
    if (this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) this.startNextWave();
    }

    if (this.waveActive && this.waveConfig) {
      this.spawnTimer -= dt;
      const cfg = this.waveConfig;
      if (
        this.spawnTimer <= 0 &&
        this.spawnedThisWave < cfg.total &&
        this.aliveCount < cfg.concurrent
      ) {
        if (this._spawnOne()) {
          this.spawnedThisWave++;
          this.spawnTimer = cfg.spawnInterval * randRange(0.8, 1.25);
        } else {
          this.spawnTimer = 0.5;
        }
      }

      if (this.killedThisWave >= cfg.total && this.aliveCount === 0) {
        this.waveActive = false;
        const wasLast = this.waveIndex >= WAVES.length - 1;
        this.onWaveCleared?.(this.waveIndex, wasLast);
        if (wasLast) {
          this.finished = true;
          this.onAllWavesCleared?.();
        }
      }
    }

    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i];
      if (e.active) e.update(dt, alpha);
    }
  }

  _spawnOne() {
    const enemy = this.pool.find((e) => !e.active);
    if (!enemy) return false;

    const spot = this._pickSpawnPoint();
    if (!spot) return false;

    const type = pickEnemyType(this.waveIndex);
    enemy.configure(scaleForDifficulty(type, this.difficulty));
    enemy.spawn(spot);

    // Reinforcements were briefed on roughly where you were, but they still
    // have to actually see you before they will open fire.
    enemy.lastKnownPosition.copy(this.player.position);
    enemy.awareness = 0.45;
    return true;
  }

  /**
   * Prefer spawn points far from the player and out of sight, so nobody pops
   * into existence in front of the crosshair.
   */
  _pickSpawnPoint() {
    const spawns = this.level.enemySpawns;
    if (!spawns.length) return null;

    const eye = this._tmp.copy(this.player.position);
    eye.y += 0.6;

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      const candidate = spawns[randInt(0, spawns.length - 1)];
      const dist = candidate.distanceTo(this.player.position);
      if (dist < 20) continue;

      // Behind the player is better than in front of them.
      const dx = candidate.x - this.player.position.x;
      const dz = candidate.z - this.player.position.z;
      const fwdX = -Math.sin(this.player.yaw);
      const fwdZ = -Math.cos(this.player.yaw);
      const facing = (dx * fwdX + dz * fwdZ) / Math.max(0.001, dist);

      const visible = this.physics.hasLineOfSight(eye, candidate);
      let score = dist * (visible ? 0.2 : 1) - Math.max(0, facing) * 18 + Math.random() * 6;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }

    if (!best) {
      let far = -Infinity;
      for (const s of spawns) {
        const d = s.distanceTo(this.player.position);
        if (d > far) { far = d; best = s; }
      }
    }
    return best;
  }

  _handleDeath(enemy, headshot) {
    this.killedThisWave++;
    this.onEnemyKilled?.(enemy, headshot);

    // Loot: keeps the player pushing forward instead of camping. Extreme
    // difficulty deliberately starves you of resources.
    const resourceMul = this.difficulty.resourceMul ?? 1;
    const roll = Math.random();
    if (roll < 0.30 * resourceMul) {
      this.onDrop?.('ammo', enemy.position.clone());
    } else if (roll < 0.48 * resourceMul) {
      this.onDrop?.('health', enemy.position.clone());
    }

    // Squadmates react to a nearby death.
    this.alertNear(enemy.position, 20, 'death');
  }

  /** Propagate a noise event (gunfire, footsteps, explosion) to nearby AI. */
  alertNear(position, radius, kind = 'gunfire') {
    for (const e of this.pool) {
      if (e.active && e.alive) e.onNoise(position, radius, kind);
    }
  }

  /** Explosions damage enemies and make survivors scatter. */
  applyExplosionDamage(center, radius, maxDamage, source = 'explosion') {
    for (const e of this.pool) {
      if (!e.active || !e.alive) continue;
      this._tmp.copy(e.position);
      this._tmp.y += 0.4;
      const dist = this._tmp.distanceTo(center);
      if (dist > radius) continue;
      if (!this.physics.hasLineOfSight(center, this._tmp)) continue;

      const falloff = 1 - dist / radius;
      const dmg = maxDamage * falloff * falloff;
      const dir = this._tmp.clone().sub(center).normalize();
      const killed = e.takeDamage(dmg, {
        part: 'torso',
        direction: dir,
        force: 8 * falloff,
        armorPen: 0.85,
        source,
      });
      if (!killed) e.onExplosion(center, radius);
    }
  }

  countInState(state) {
    let n = 0;
    for (const e of this.pool) if (e.active && e.alive && e.state === state) n++;
    return n;
  }

  /** Snapshot of the squad's tactical state — used by the HUD threat meter. */
  threatSummary() {
    let engaging = 0;
    let flanking = 0;
    let searching = 0;
    for (const e of this.pool) {
      if (!e.active || !e.alive) continue;
      if (e.state === STATE.ATTACK) engaging++;
      else if (e.state === STATE.FLANK) flanking++;
      else if (e.state === STATE.SEARCH || e.state === STATE.INVESTIGATE) searching++;
    }
    return { engaging, flanking, searching };
  }

  dispose() {
    for (const e of this.pool) e.dispose();
    this.pool.length = 0;
  }
}

export { ENEMY_TYPES, STATE };

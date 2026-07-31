/**
 * Weapon — one gun: ammo, timing, the fire/reload/bolt state machine, and the
 * procedural view model.
 *
 * Animation is *not* done here — `WeaponViewModel` owns the pose so that sway,
 * bob, lean, recoil and ADS blend consistently across every weapon. This class
 * exposes the values that pose needs (`reloadCurve`, `isBusy`, and the `sight`
 * anchor) and otherwise concerns itself with state.
 *
 * Every model carries a **`sight` anchor** placed at the exact centre of its
 * aperture, dot or eyepiece. `WeaponViewModel` translates the whole weapon so
 * that anchor lands on the camera axis, which is what makes the ADS sight
 * picture correct and unobstructed on every weapon without hand-tuning.
 */

import * as THREE from 'three';
import { clamp, damp, lerp, randRange, DEG2RAD } from '../core/MathUtils.js';
import { LAYER_VIEWMODEL } from '../fx/ScopeRenderer.js';

export const WEAPON_STATE = Object.freeze({
  IDLE: 'idle',
  RELOADING: 'reloading',
  SWITCHING: 'switching',
  CYCLING: 'cycling',     // bolt / pump action between shots
  MELEE: 'melee',
  THROWING: 'throwing',
});

export class Weapon {
  /**
   * @param {object} def  entry from WEAPON_DEFS
   * @param {import('../core/AssetManager.js').AssetManager} assets
   */
  constructor(def, assets) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.assets = assets;

    // --- ammo ---
    this.magazine = def.magSize;
    this.reserve = def.startReserve;

    // --- timing ---
    this.fireInterval = 60 / def.rpm;
    this.cooldown = 0;
    this.state = WEAPON_STATE.IDLE;
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    this.reloadPhase = null;
    this.cycleTimer = 0;
    this.meleeTimer = 0;
    this.meleeHitDone = false;
    this._pendingSounds = [];
    this._shellsLoaded = 0;
    this._shellsWanted = 0;

    // --- burst ---
    this.burstRemaining = 0;
    this.burstTimer = 0;

    // --- accuracy ---
    this.spreadBonus = 0;      // degrees, accumulates per shot

    // --- animation feed ---
    this.switchProgress = 1;   // 1 = fully raised
    this.reloadCurve = 0;

    // --- radians conversions ---
    this.headMul = def.headMul ?? 2;
    this.limbMul = def.limbMul ?? 0.85;

    this.group = new THREE.Group();
    this.group.name = `viewmodel_${def.id}`;
    this.group.visible = false;

    /** True when an authored glTF model was used instead of primitives. */
    this.usingAuthoredModel = buildViewModel(this.group, def, assets);

    this.muzzle = this.group.getObjectByName('muzzle') ?? new THREE.Object3D();
    if (!this.muzzle.parent) this.group.add(this.muzzle);
    this.ejectPort = this.group.getObjectByName('eject') ?? this.muzzle;
    this.sight = this.group.getObjectByName('sight') ?? this.muzzle;

    // The sight anchor may be nested several levels inside an imported scene,
    // so its `.position` is local to its own parent, not to the weapon group.
    // Resolve it into group space once — this is what the ADS pose is built
    // from, and getting it wrong throws the sight picture off centre.
    this._sightLocal = new THREE.Vector3();
    this.group.updateMatrixWorld(true);
    this.sight.getWorldPosition(this._sightLocal);
    this.group.worldToLocal(this._sightLocal);

    this._sightWorld = new THREE.Vector3();
    this._buildMuzzleFlash();
    this._buildReticle();
  }

  /**
   * The illuminated reticle inside a tube optic.
   *
   * Drawn as real geometry parked just behind the front lens rather than as a
   * screen-space overlay, so the tube walls occlude it from off-axis exactly
   * like a real red dot — you only see it when your eye is behind the sight.
   */
  _buildReticle() {
    const anchor = this.group.getObjectByName('reticle');
    if (!anchor) {
      this.reticle = null;
      return;
    }

    const g = new THREE.Group();
    const mkMat = (opacity) => new THREE.MeshBasicMaterial({
      color: 0xff2d18,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    // Circle-dot. Kept deliberately restrained: additive red over a bright
    // sky saturates the red channel while green and blue stay high, so an
    // over-bright emitter reads as a white blob rather than a red dot.
    //
    // The ring stroke is 0.8 mm at a ~15 mm radius — a 1:19 stroke-to-radius
    // ratio, matching a real 65 MOA / 2 MOA circle-dot. A fatter ring covers
    // the target at distance, which is exactly what you don't want from an
    // optic. Segment count is raised to 64 so the thin stroke stays round
    // instead of reading as a polygon.
    this.reticleMat = mkMat(0.95);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.01455, 0.01535, 64), this.reticleMat);

    this.reticleDotMat = mkMat(0.85);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 20), this.reticleDotMat);

    // A small halo, just enough for the bloom pass to catch.
    this.reticleGlowMat = mkMat(0.055);
    this.reticleGlowMat.map = this.assets.getTexture('glow');
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.015, 0.015), this.reticleGlowMat);

    // Drawn after the muzzle flash so the dot stays readable through it —
    // a real emitter doesn't get washed out by your own muzzle blast.
    for (const m of [glow, ring, dot]) {
      m.renderOrder = 34;
      g.add(m);
    }
    // Sit a couple of millimetres inside the front lens.
    g.position.copy(anchor.position);
    g.position.z += 0.004;
    anchor.parent.add(g);
    this.reticle = g;
  }

  _buildMuzzleFlash() {
    if (this.def.melee || this.def.throwable) {
      this.flashGroup = new THREE.Group();
      this.flashGroup.visible = false;
      this.muzzle.add(this.flashGroup);
      this.flashMat = new THREE.MeshBasicMaterial({ visible: false });
      this.flashLight = new THREE.PointLight(0xffffff, 0, 1, 2);
      this.flashLight.visible = false;
      this.flashTime = 0;
      return;
    }

    const tex = this.assets.getTexture('flash');
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth testing ON. With it off the flash painted straight over the
      // optic housing and wiped out the whole sight picture on every shot;
      // with it on, the tube occludes it exactly like real geometry and you
      // only see the flash through the aperture, where it belongs.
      depthTest: true,
      toneMapped: false,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.flashMat = mat;
    this.flashBaseSize = 0.17 * this.def.muzzleFlashScale;

    // Two crossed quads give the flash volume from any angle.
    this.flashGroup = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const q = new THREE.Mesh(
        new THREE.PlaneGeometry(this.flashBaseSize, this.flashBaseSize), mat
      );
      q.rotation.z = i * Math.PI * 0.5;
      q.renderOrder = 30;
      this.flashGroup.add(q);
    }
    this.flashGroup.position.set(0, 0, -0.02);
    this.flashGroup.visible = false;
    this.muzzle.add(this.flashGroup);

    // Lights the *view model* only — world illumination comes from a pooled
    // world-layer light so the two layers stay properly separated.
    this.flashLight = new THREE.PointLight(0xffc46a, 0, 1.4, 2);
    this.flashLight.castShadow = false;
    this.flashLight.visible = false;
    this.flashLight.layers.set(LAYER_VIEWMODEL);
    this.muzzle.add(this.flashLight);
    this.flashTime = 0;
  }

  // ------------------------------------------------------------------ ammo
  get isEmpty() { return this.magazine <= 0; }
  get isFull() { return this.magazine >= this.def.magSize; }
  get hasAmmo() { return this.magazine > 0 || this.def.magSize === Infinity; }
  get canReload() {
    return (
      this.def.reloadType !== 'none' &&
      this.reserve > 0 &&
      !this.isFull &&
      this.state !== WEAPON_STATE.SWITCHING
    );
  }

  get isBusy() {
    return (
      this.state === WEAPON_STATE.RELOADING ||
      this.state === WEAPON_STATE.SWITCHING ||
      this.state === WEAPON_STATE.CYCLING ||
      this.state === WEAPON_STATE.MELEE
    );
  }

  /** Blocks ADS: you can't aim mid-bolt or mid-reload. */
  get blocksAds() {
    return this.state === WEAPON_STATE.RELOADING || this.state === WEAPON_STATE.SWITCHING;
  }

  addReserve(amount) {
    if (!Number.isFinite(this.def.maxReserve) || this.def.maxReserve <= 0) return 0;
    const before = this.reserve;
    this.reserve = Math.min(this.def.maxReserve, this.reserve + amount);
    return this.reserve - before;
  }

  resetAmmo() {
    this.magazine = this.def.magSize;
    this.reserve = this.def.startReserve;
    this.state = WEAPON_STATE.IDLE;
    this.cooldown = 0;
    this.cycleTimer = 0;
    this.burstRemaining = 0;
    this.spreadBonus = 0;
    this.reloadCurve = 0;
    this.switchProgress = 1;
  }

  // ---------------------------------------------------------------- firing
  /** Can this weapon fire *right now*? */
  canFire() {
    if (this.state === WEAPON_STATE.SWITCHING) return false;
    if (this.state === WEAPON_STATE.CYCLING) return false;
    if (this.state === WEAPON_STATE.MELEE) return false;
    if (this.cooldown > 0) return false;
    if (this.switchProgress < 0.5) return false;
    if (this.def.melee) return true;
    return this.magazine > 0;
  }

  /** Deduct a round and start the fire-rate cooldown. */
  consumeShot() {
    if (Number.isFinite(this.def.magSize)) this.magazine--;
    this.cooldown = this.fireInterval;
    this.spreadBonus = Math.min(this.def.spreadMax, this.spreadBonus + this.def.spreadPerShot);

    // Bolt-action / pump-action weapons must cycle before the next shot.
    const cycle = this.def.boltTime ?? this.def.pumpTime ?? 0;
    if (cycle > 0 && this.magazine > 0) {
      this.state = WEAPON_STATE.CYCLING;
      this.cycleTimer = cycle;
    }

    this.flashTime = 0.055;
    if (this.flashGroup.children.length) {
      this.flashGroup.visible = true;
      // Random roll and size per shot so a burst never looks like the same
      // frame stamped repeatedly.
      this.flashGroup.rotation.z = Math.random() * Math.PI * 2;
      this.flashJitter = randRange(0.82, 1.2);
      this.flashLight.visible = true;
    }

    // Firing cancels a shell-by-shell reload (pump-action behaviour).
    if (this.state === WEAPON_STATE.RELOADING && this.def.reloadType === 'shells') {
      this._finishShellReload();
    }
  }

  /**
   * Total spread cone half-angle in radians.
   * @param {{moving:number, airborne:boolean, crouching:boolean, adsSpreadMul:number}} state
   */
  getSpread(state) {
    const d = this.def;
    let deg = d.spreadBase + this.spreadBonus;
    deg += d.spreadMoving * clamp(state.moving, 0, 1);
    if (state.airborne) deg += d.spreadJumping;
    if (state.crouching) deg += d.spreadCrouch;
    deg *= state.adsSpreadMul ?? 1;
    return Math.max(0.0, deg) * DEG2RAD;
  }

  /** Damage after distance falloff. */
  damageAtRange(distance) {
    const d = this.def;
    if (distance <= d.falloffStart) return d.damage;
    if (distance >= d.falloffEnd) return d.damage * d.falloffMinScale;
    const t = (distance - d.falloffStart) / (d.falloffEnd - d.falloffStart);
    return d.damage * lerp(1, d.falloffMinScale, t);
  }

  // --------------------------------------------------------------- reloads
  /** @returns {boolean} true if a reload actually started */
  startReload() {
    if (!this.canReload || this.state === WEAPON_STATE.RELOADING) return false;
    if (this.state === WEAPON_STATE.MELEE) return false;

    // A reload interrupts a bolt cycle — the round gets chambered anyway.
    if (this.state === WEAPON_STATE.CYCLING) {
      this.state = WEAPON_STATE.IDLE;
      this.cycleTimer = 0;
    }
    this.burstRemaining = 0;

    if (this.def.reloadType === 'shells') {
      this.state = WEAPON_STATE.RELOADING;
      this.reloadPhase = 'start';
      this.reloadTimer = 0;
      this.reloadDuration = this.def.reloadStartTime;
      this._shellsLoaded = 0;
      this._shellsWanted = Math.min(this.def.magSize - this.magazine, this.reserve);
      return true;
    }

    this.state = WEAPON_STATE.RELOADING;
    this.reloadPhase = 'mag';
    this.reloadTimer = 0;
    this.reloadDuration = this.isEmpty ? this.def.reloadEmptyTime : this.def.reloadTime;
    const scale = this.reloadDuration / Math.max(0.01, this.def.reloadEmptyTime);
    this._pendingSounds = (this.def.reloadSounds ?? []).map(([t, name]) => ({
      time: t * scale,
      name,
      done: false,
    }));
    return true;
  }

  cancelReload() {
    if (this.state === WEAPON_STATE.RELOADING) {
      this.state = WEAPON_STATE.IDLE;
      this.reloadPhase = null;
      this._pendingSounds.length = 0;
    }
  }

  _finishShellReload() {
    this.state = WEAPON_STATE.IDLE;
    this.reloadPhase = null;
    this.cooldown = Math.max(this.cooldown, this.def.reloadEndTime ?? 0.3);
  }

  /** @returns {number} 0..1 reload progress for the HUD ring */
  get reloadProgress() {
    if (this.state !== WEAPON_STATE.RELOADING) return 0;
    if (this.def.reloadType === 'shells') {
      if (!this._shellsWanted) return 1;
      return clamp(this._shellsLoaded / this._shellsWanted, 0, 1);
    }
    return clamp(this.reloadTimer / this.reloadDuration, 0, 1);
  }

  // --------------------------------------------------------------- equip
  onEquip() {
    this.group.visible = true;
    this.state = WEAPON_STATE.SWITCHING;
    this.switchProgress = 0;
    this.cooldown = Math.max(this.cooldown, this.def.switchTime * 0.55);
    this.spreadBonus = 0;
    this.burstRemaining = 0;
  }

  onHolster() {
    this.cancelReload();
    this.group.visible = false;
    this.state = WEAPON_STATE.IDLE;
    this.burstRemaining = 0;
    this.flashGroup.visible = false;
    this.flashLight.visible = false;
    if (this.flashMat.opacity !== undefined) this.flashMat.opacity = 0;
  }

  // ------------------------------------------------------------------ melee
  startMelee() {
    if (this.state === WEAPON_STATE.MELEE) return false;
    this.state = WEAPON_STATE.MELEE;
    this.meleeTimer = 0;
    this.meleeHitDone = false;
    return true;
  }

  // ================================================================= update
  /**
   * @param {number} dt
   * @param {(name:string, opts?:object) => void} playSound
   * @param {number} adsProgress 0..1 — the flash is tamed as the sights come up
   */
  update(dt, playSound, adsProgress = 0) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.spreadBonus = Math.max(0, this.spreadBonus - this.def.spreadRecovery * dt);

    // --- switch (raise) animation ---
    if (this.switchProgress < 1) {
      this.switchProgress = Math.min(1, this.switchProgress + dt / Math.max(0.05, this.def.switchTime));
    }
    // Checked unconditionally: if anything sets `switchProgress` to 1 without
    // going through the ramp, the weapon must still leave the SWITCHING state
    // — otherwise it would be permanently unable to aim or fire.
    if (this.switchProgress >= 1 && this.state === WEAPON_STATE.SWITCHING) {
      this.state = WEAPON_STATE.IDLE;
    }

    // --- bolt / pump cycle ---
    if (this.state === WEAPON_STATE.CYCLING) {
      this.cycleTimer -= dt;
      if (this.cycleTimer <= 0.5 && !this._cycleSoundPlayed) {
        this._cycleSoundPlayed = true;
        playSound?.(this.def.boltTime ? 'boltCycle' : 'pumpAction');
      }
      if (this.cycleTimer <= 0) {
        this.state = WEAPON_STATE.IDLE;
        this._cycleSoundPlayed = false;
      }
    } else {
      this._cycleSoundPlayed = false;
    }

    // --- melee swing ---
    if (this.state === WEAPON_STATE.MELEE) {
      this.meleeTimer += dt;
      if (this.meleeTimer >= (this.def.swingTime ?? 0.4)) {
        this.state = WEAPON_STATE.IDLE;
        this.cooldown = 0.1;
      }
    }

    // --- reload state machine ---
    if (this.state === WEAPON_STATE.RELOADING) this._updateReload(dt, playSound);

    // --- reload animation curve (fed to the view model) ---
    let target = 0;
    if (this.state === WEAPON_STATE.RELOADING) {
      const p = this.def.reloadType === 'shells'
        ? (this.reloadPhase === 'insert' ? this.reloadTimer / this.def.reloadTime : 0.25)
        : clamp(this.reloadTimer / this.reloadDuration, 0, 1);
      target = Math.sin(clamp(p, 0, 1) * Math.PI);
    } else if (this.state === WEAPON_STATE.CYCLING) {
      const cycle = this.def.boltTime ?? this.def.pumpTime ?? 1;
      target = Math.sin(clamp(1 - this.cycleTimer / cycle, 0, 1) * Math.PI) * 0.55;
    } else if (this.state === WEAPON_STATE.MELEE) {
      const t = clamp(this.meleeTimer / (this.def.swingTime ?? 0.4), 0, 1);
      target = Math.sin(t * Math.PI) * 0.9;
    }
    this.reloadCurve = damp(this.reloadCurve, target, 22, dt);

    // --- muzzle flash decay ---
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const t = clamp(this.flashTime / 0.055, 0, 1);
      // Shrink and dim while aiming: at ADS the muzzle sits just inside the
      // sight cone, so a full-size flash would still swamp the picture.
      const adsTame = 1 - adsProgress * 0.55;
      this.flashGroup.scale.setScalar(adsTame * (this.flashJitter ?? 1));
      if (this.flashMat.opacity !== undefined) {
        this.flashMat.opacity = t * (1 - adsProgress * 0.45);
      }
      this.flashLight.intensity = t * 2.2 * this.def.muzzleFlashScale * adsTame;
      if (this.flashTime <= 0) {
        this.flashGroup.visible = false;
        this.flashLight.visible = false;
        if (this.flashMat.opacity !== undefined) this.flashMat.opacity = 0;
        this.flashLight.intensity = 0;
      }
    }
  }

  _updateReload(dt, playSound) {
    const d = this.def;
    this.reloadTimer += dt;

    if (d.reloadType === 'shells') {
      if (this.reloadPhase === 'start' && this.reloadTimer >= d.reloadStartTime) {
        this.reloadPhase = 'insert';
        this.reloadTimer = 0;
      } else if (this.reloadPhase === 'insert' && this.reloadTimer >= d.reloadTime) {
        this.reloadTimer = 0;
        this.magazine++;
        this.reserve--;
        this._shellsLoaded++;
        playSound?.('shellInsert');
        if (this.isFull || this.reserve <= 0) this.reloadPhase = 'end';
      } else if (this.reloadPhase === 'end' && this.reloadTimer >= d.reloadEndTime) {
        playSound?.('pumpAction');
        this._finishShellReload();
      }
      return;
    }

    for (const s of this._pendingSounds) {
      if (!s.done && this.reloadTimer >= s.time) {
        s.done = true;
        playSound?.(s.name);
      }
    }

    if (this.reloadTimer >= this.reloadDuration) {
      const needed = d.magSize - this.magazine;
      const take = Math.min(needed, this.reserve);
      this.magazine += take;
      this.reserve -= take;
      this.state = WEAPON_STATE.IDLE;
      this.reloadPhase = null;
      this._pendingSounds.length = 0;
    }
  }

  // ------------------------------------------------------------- accessors
  /** Sight anchor position in the weapon group's local space. */
  getSightLocalPosition(out) {
    return out.copy(this._sightLocal);
  }

  getMuzzleWorldPosition(out) {
    this.muzzle.getWorldPosition(out);
    return out;
  }

  getEjectWorldPosition(out) {
    this.ejectPort.getWorldPosition(out);
    return out;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
    });
    this.flashMat?.dispose();
    this.reticleMat?.dispose();
    this.reticleDotMat?.dispose();
    this.reticleGlowMat?.dispose();
  }
}

/* ========================================================================
   Procedural view models.
   Built from primitives with the shared material library. Each ends with a
   `sight` anchor at the exact aim point, a `muzzle` anchor at the barrel tip
   and an `eject` anchor at the ejection port.
   ======================================================================== */

/**
 * @returns {boolean} true when an authored glTF model was used
 */
function buildViewModel(group, def, assets) {
  // --- authored model, when one exists for this weapon --------------------
  const authored = def.modelId ? assets.getModel(def.modelId) : null;
  if (authored) {
    authored.position.set(0, 0, 0);
    authored.rotation.set(0, 0, 0);
    group.add(authored);
    group.scale.setScalar(def.scale ?? 1);
    return true;
  }

  const metal = assets.getMaterial('gunMetal');
  const poly = assets.getMaterial('gunPolymer');
  const wood = assets.getMaterial('wood');
  const dark = assets.getMaterial('darkGear');

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.renderOrder = 20;
    group.add(mesh);
    return mesh;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (r1, r2, h, seg = 12, open = false) =>
    new THREE.CylinderGeometry(r1, r2, h, seg, 1, open);
  const anchor = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    group.add(o);
    return o;
  };

  /** Open-centre optic ring: nothing behind the glass to block the view. */
  const opticRing = (y, z, radius, depth, mat) => {
    const ring = new THREE.Mesh(cyl(radius, radius, depth, 18, true), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, y, z);
    ring.renderOrder = 20;
    group.add(ring);
    const hood = new THREE.Mesh(cyl(radius * 1.12, radius * 1.12, depth * 0.35, 18, true), mat);
    hood.rotation.x = Math.PI / 2;
    hood.position.set(0, y, z - depth * 0.45);
    group.add(hood);
    return ring;
  };

  /** Emissive aiming dot, drawn on the view-model layer only. */
  const redDot = (y, z, size = 0.0055, color = 0xff3322) => {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(size, 8, 6),
      new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 })
    );
    dot.position.set(0, y, z);
    dot.renderOrder = 26;
    group.add(dot);
    return dot;
  };

  /** Front post + rear notch at a shared height => a clean sight picture. */
  const ironSights = (y, frontZ, rearZ, width = 0.03) => {
    add(box(0.006, 0.016, 0.006), metal, 0, y - 0.006, frontZ);            // front post
    add(box(0.007, 0.010, 0.008), metal, -width / 2, y - 0.004, rearZ);    // rear left
    add(box(0.007, 0.010, 0.008), metal, width / 2, y - 0.004, rearZ);     // rear right
    return anchor('sight', 0, y, rearZ);
  };

  switch (def.modelClass) {
    /* ------------------------------------------------------------ pistols */
    case 'pistol': {
      add(box(0.048, 0.062, 0.24), metal, 0, 0.012, -0.06);
      add(box(0.042, 0.03, 0.20), poly, 0, -0.03, -0.05);
      add(box(0.038, 0.11, 0.055), poly, 0, -0.085, 0.032, 0.28);
      add(box(0.012, 0.03, 0.02), metal, 0, -0.052, -0.005);
      add(box(0.044, 0.012, 0.06), poly, 0, -0.052, 0.005);
      add(cyl(0.011, 0.011, 0.05), metal, 0, 0.012, -0.185, Math.PI / 2);
      ironSights(0.052, -0.16, 0.05, 0.028);
      anchor('muzzle', 0, 0.012, -0.215);
      anchor('eject', 0.03, 0.03, -0.02);
      break;
    }

    case 'heavyPistol': {
      add(box(0.058, 0.078, 0.30), metal, 0, 0.014, -0.08);
      add(box(0.05, 0.034, 0.24), poly, 0, -0.034, -0.07);
      add(box(0.044, 0.12, 0.062), poly, 0, -0.095, 0.045, 0.30);
      add(box(0.05, 0.014, 0.07), poly, 0, -0.058, 0.0);
      add(cyl(0.017, 0.017, 0.08), metal, 0, 0.014, -0.245, Math.PI / 2);
      add(box(0.03, 0.014, 0.09), metal, 0, 0.056, -0.14);          // barrel rib
      ironSights(0.068, -0.20, 0.06, 0.034);
      anchor('muzzle', 0, 0.014, -0.285);
      anchor('eject', 0.036, 0.034, -0.03);
      break;
    }

    /* ------------------------------------------------------------ assault */
    case 'rifle': {
      add(box(0.052, 0.075, 0.30), poly, 0, 0, -0.02);
      add(box(0.046, 0.05, 0.26), poly, 0, -0.005, -0.29);
      add(cyl(0.010, 0.010, 0.34), metal, 0, 0.008, -0.36, Math.PI / 2);
      add(cyl(0.017, 0.014, 0.05), metal, 0, 0.008, -0.53, Math.PI / 2);
      add(box(0.036, 0.115, 0.055), poly, 0, -0.09, 0.055, 0.30);
      add(box(0.042, 0.10, 0.05), metal, 0, -0.085, -0.055, -0.06);
      add(box(0.05, 0.062, 0.20), poly, 0, -0.005, 0.20);
      add(box(0.04, 0.016, 0.24), metal, 0, 0.046, -0.10);          // top rail
      opticRing(0.078, -0.05, 0.021, 0.075, dark);
      add(box(0.012, 0.028, 0.012), dark, 0, 0.062, -0.05);         // optic mount
      redDot(0.078, -0.075);
      anchor('sight', 0, 0.078, -0.05);
      anchor('muzzle', 0, 0.008, -0.56);
      anchor('eject', 0.032, 0.02, 0.0);
      break;
    }

    case 'burstRifle': {
      add(box(0.05, 0.072, 0.32), poly, 0, 0, -0.03);
      add(box(0.044, 0.046, 0.24), metal, 0, -0.004, -0.30);
      add(cyl(0.0095, 0.0095, 0.30), metal, 0, 0.008, -0.38, Math.PI / 2);
      add(cyl(0.015, 0.013, 0.045), metal, 0, 0.008, -0.52, Math.PI / 2);
      add(box(0.034, 0.11, 0.052), poly, 0, -0.088, 0.05, 0.30);
      add(box(0.04, 0.095, 0.048), metal, 0, -0.082, -0.06, -0.05);
      add(box(0.048, 0.058, 0.22), poly, 0, -0.006, 0.21);
      add(box(0.04, 0.014, 0.22), metal, 0, 0.044, -0.10);
      // Holographic window: an open frame, nothing behind the glass.
      add(box(0.006, 0.05, 0.006), dark, -0.026, 0.076, -0.05);
      add(box(0.006, 0.05, 0.006), dark, 0.026, 0.076, -0.05);
      add(box(0.058, 0.006, 0.006), dark, 0, 0.101, -0.05);
      add(box(0.058, 0.008, 0.03), dark, 0, 0.052, -0.05);
      redDot(0.076, -0.062, 0.004, 0xff4433);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.016, 0.0014, 6, 20),
        new THREE.MeshBasicMaterial({ color: 0xff4433, toneMapped: false, transparent: true, opacity: 0.75, depthTest: false })
      );
      ring.position.set(0, 0.076, -0.062);
      ring.renderOrder = 26;
      group.add(ring);
      anchor('sight', 0, 0.076, -0.05);
      anchor('muzzle', 0, 0.008, -0.55);
      anchor('eject', 0.03, 0.018, -0.01);
      break;
    }

    case 'smg': {
      add(box(0.046, 0.07, 0.24), poly, 0, 0, -0.02);
      add(box(0.04, 0.042, 0.16), poly, 0, -0.004, -0.20);
      add(cyl(0.0085, 0.0085, 0.20), metal, 0, 0.006, -0.26, Math.PI / 2);
      add(box(0.032, 0.10, 0.048), poly, 0, -0.082, 0.03, 0.28);
      add(box(0.034, 0.13, 0.042), metal, 0, -0.095, -0.06, -0.04);
      add(box(0.03, 0.03, 0.13), metal, 0, -0.002, 0.16);           // folding stock
      add(box(0.034, 0.012, 0.16), metal, 0, 0.042, -0.06);
      ironSights(0.058, -0.24, 0.06, 0.026);
      anchor('muzzle', 0, 0.006, -0.37);
      anchor('eject', 0.028, 0.016, -0.005);
      break;
    }

    /* ----------------------------------------------------------- shotguns */
    case 'shotgun': {
      add(box(0.056, 0.08, 0.26), metal, 0, 0, -0.02);
      add(cyl(0.016, 0.016, 0.46), metal, 0, 0.026, -0.36, Math.PI / 2);
      add(cyl(0.013, 0.013, 0.40), metal, 0, -0.006, -0.33, Math.PI / 2);
      add(box(0.05, 0.045, 0.11), wood, 0, -0.004, -0.27);
      add(box(0.038, 0.11, 0.05), wood, 0, -0.085, 0.06, 0.32);
      add(box(0.052, 0.07, 0.22), wood, 0, -0.012, 0.20);
      add(box(0.006, 0.012, 0.006), metal, 0, 0.045, -0.56);        // bead
      anchor('sight', 0, 0.051, -0.56);
      anchor('muzzle', 0, 0.026, -0.60);
      anchor('eject', 0.034, 0.02, -0.02);
      break;
    }

    case 'autoShotgun': {
      add(box(0.058, 0.084, 0.30), metal, 0, 0, -0.03);
      add(cyl(0.015, 0.015, 0.40), metal, 0, 0.028, -0.36, Math.PI / 2);
      add(cyl(0.012, 0.012, 0.34), metal, 0, -0.004, -0.33, Math.PI / 2);
      add(box(0.046, 0.052, 0.18), poly, 0, 0.004, -0.28);          // heat shield
      add(box(0.038, 0.11, 0.052), poly, 0, -0.088, 0.05, 0.30);
      add(box(0.046, 0.12, 0.055), metal, 0, -0.09, -0.06, -0.05);  // box mag
      add(box(0.05, 0.066, 0.20), poly, 0, -0.008, 0.20);
      // Ghost ring rear sight: large aperture, nothing inside it.
      const ghost = new THREE.Mesh(
        new THREE.TorusGeometry(0.014, 0.0022, 6, 16),
        metal
      );
      ghost.position.set(0, 0.064, 0.05);
      group.add(ghost);
      add(box(0.005, 0.014, 0.005), metal, 0, 0.058, -0.50);
      anchor('sight', 0, 0.064, 0.05);
      anchor('muzzle', 0, 0.028, -0.55);
      anchor('eject', 0.034, 0.022, -0.03);
      break;
    }

    /* ---------------------------------------------------------- precision */
    case 'sniper': {
      add(box(0.056, 0.08, 0.34), poly, 0, 0, -0.02);
      add(cyl(0.011, 0.011, 0.52), metal, 0, 0.004, -0.44, Math.PI / 2);
      add(cyl(0.019, 0.016, 0.07), metal, 0, 0.004, -0.70, Math.PI / 2);  // brake
      add(box(0.04, 0.12, 0.06), poly, 0, -0.094, 0.06, 0.30);
      add(box(0.046, 0.09, 0.05), metal, 0, -0.082, -0.07, -0.05);
      add(box(0.056, 0.09, 0.28), poly, 0, -0.012, 0.25);
      add(box(0.04, 0.03, 0.05), poly, 0, 0.038, 0.20);                   // cheek rest
      add(box(0.018, 0.03, 0.10), metal, 0.045, 0.01, 0.02, 0, 0, -0.5);  // bolt handle
      // Scope: open tube, nothing between the eyepiece and the objective.
      const tube = new THREE.Mesh(cyl(0.024, 0.024, 0.30, 20, true), metal);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.088, -0.12);
      group.add(tube);
      add(cyl(0.031, 0.031, 0.05, 18, true), metal, 0, 0.088, -0.27, Math.PI / 2); // objective bell
      add(cyl(0.029, 0.029, 0.045, 18, true), metal, 0, 0.088, 0.02, Math.PI / 2); // eyepiece
      add(box(0.026, 0.03, 0.026), metal, 0, 0.055, -0.06);
      add(box(0.026, 0.03, 0.026), metal, 0, 0.055, -0.20);
      add(cyl(0.012, 0.012, 0.022), metal, 0.026, 0.10, -0.13, 0, 0, Math.PI / 2); // windage turret
      add(cyl(0.012, 0.012, 0.022), metal, 0, 0.114, -0.13);                        // elevation turret
      anchor('sight', 0, 0.088, 0.02);
      anchor('muzzle', 0, 0.004, -0.74);
      anchor('eject', 0.04, 0.02, -0.02);
      break;
    }

    case 'marksman': {
      add(box(0.052, 0.078, 0.32), poly, 0, 0, -0.02);
      add(box(0.046, 0.05, 0.24), poly, 0, -0.004, -0.30);
      add(cyl(0.010, 0.010, 0.40), metal, 0, 0.006, -0.40, Math.PI / 2);
      add(cyl(0.016, 0.014, 0.05), metal, 0, 0.006, -0.62, Math.PI / 2);
      add(box(0.036, 0.115, 0.055), poly, 0, -0.09, 0.055, 0.30);
      add(box(0.044, 0.11, 0.05), metal, 0, -0.09, -0.06, -0.05);
      add(box(0.05, 0.07, 0.24), poly, 0, -0.008, 0.22);
      const tube = new THREE.Mesh(cyl(0.021, 0.021, 0.24, 18, true), metal);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.082, -0.10);
      group.add(tube);
      add(cyl(0.026, 0.026, 0.04, 16, true), metal, 0, 0.082, -0.22, Math.PI / 2);
      add(cyl(0.025, 0.025, 0.04, 16, true), metal, 0, 0.082, 0.01, Math.PI / 2);
      add(box(0.024, 0.028, 0.024), metal, 0, 0.052, -0.04);
      add(box(0.024, 0.028, 0.024), metal, 0, 0.052, -0.16);
      anchor('sight', 0, 0.082, 0.01);
      anchor('muzzle', 0, 0.006, -0.65);
      anchor('eject', 0.034, 0.02, -0.01);
      break;
    }

    /* ------------------------------------------------------------ support */
    case 'lmg': {
      add(box(0.064, 0.09, 0.36), poly, 0, 0, -0.02);
      add(cyl(0.012, 0.012, 0.44), metal, 0, 0.01, -0.42, Math.PI / 2);
      add(cyl(0.019, 0.016, 0.06), metal, 0, 0.01, -0.65, Math.PI / 2);
      add(box(0.05, 0.05, 0.20), metal, 0, 0.028, -0.30);                 // handguard
      add(box(0.04, 0.12, 0.06), poly, 0, -0.10, 0.06, 0.30);
      add(box(0.10, 0.11, 0.13), dark, 0, -0.095, -0.06);                 // belt box
      add(box(0.056, 0.08, 0.24), poly, 0, -0.012, 0.24);
      add(box(0.03, 0.05, 0.10), metal, 0, -0.09, -0.30, 0.5);            // bipod stub
      add(box(0.05, 0.016, 0.26), metal, 0, 0.056, -0.12);                // carry handle rail
      ironSights(0.078, -0.44, 0.02, 0.03);
      anchor('muzzle', 0, 0.01, -0.69);
      anchor('eject', 0.042, 0.016, -0.02);
      break;
    }

    /* -------------------------------------------------------------- melee */
    case 'knife': {
      add(box(0.026, 0.02, 0.10), poly, 0, -0.01, 0.06);                  // grip
      add(box(0.032, 0.012, 0.016), metal, 0, 0.0, 0.005);                // guard
      const blade = add(box(0.006, 0.038, 0.20), metal, 0, 0.004, -0.10);
      blade.rotation.x = 0.02;
      add(box(0.003, 0.014, 0.16), assets.getMaterial('gunMetal'), 0.0035, 0.016, -0.10); // edge bevel
      anchor('sight', 0, 0.0, -0.1);
      anchor('muzzle', 0, 0.004, -0.20);
      anchor('eject', 0, 0, 0);
      break;
    }

    /* ---------------------------------------------------------- throwable */
    case 'grenade':
    default: {
      const body = add(new THREE.SphereGeometry(0.042, 14, 10), dark, 0, -0.01, -0.02);
      body.scale.set(1, 1.15, 1);
      add(cyl(0.014, 0.014, 0.03), metal, 0, 0.042, -0.02);               // fuse
      add(box(0.008, 0.05, 0.006), metal, 0.016, 0.03, -0.02, 0, 0, 0.2); // spoon
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0022, 6, 12), metal);
      ring.position.set(-0.018, 0.045, -0.02);
      ring.rotation.y = Math.PI / 2;
      group.add(ring);
      anchor('sight', 0, 0, -0.02);
      anchor('muzzle', 0, 0, -0.06);
      anchor('eject', 0, 0, 0);
      break;
    }
  }

  group.scale.setScalar(def.scale ?? 1);
  return false;
}

export { buildViewModel };

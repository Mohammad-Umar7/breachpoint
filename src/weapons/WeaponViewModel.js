/**
 * WeaponViewModel — the floating first-person weapon and everything that
 * makes it feel attached to a body that isn't drawn.
 *
 * Layer separation
 * ----------------
 * The view model lives on `LAYER_VIEWMODEL` and is drawn by its own camera
 * with its own FOV and a 1 cm near plane. The world camera and the scope
 * camera both render `LAYER_WORLD` only. Consequences, all of them wanted:
 *
 *   - The weapon can never clip into walls (it isn't in the world depth pass).
 *   - The weapon can never appear inside a sniper scope.
 *   - Changing the world FOV (or zooming an optic) doesn't warp the gun.
 *
 * ADS alignment
 * -------------
 * Every weapon model carries a `sight` anchor placed at the exact centre of
 * its aperture / dot / glass. The ADS pose is *computed* from that anchor
 * rather than hand-tuned: the holder is translated so the sight anchor lands
 * precisely on the camera's forward axis. That is what guarantees the sight
 * picture is centred and unobstructed on every weapon, including new ones.
 *
 * Pose layers, applied in order onto the base pose:
 *   ads      hip pose  ->  computed sight-aligned pose
 *   sway     lags behind mouse movement
 *   bob      walk / sprint figure-of-eight
 *   idle     slow breathing drift
 *   lean     follows the camera lean
 *   crouch   settles the weapon slightly
 *   air      rises on jump, dips on landing
 *   sprint   lowered and angled away
 *   recoil   kick from RecoilSystem
 *   states   equip / holster / reload / inspect
 *   wall     pulls back when the muzzle is about to poke through geometry
 */

import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/MathUtils.js';
import { smootherStep } from './ADSSystem.js';
import { LAYER_WORLD, LAYER_VIEWMODEL } from '../fx/ScopeRenderer.js';

export { LAYER_WORLD, LAYER_VIEWMODEL };

export class WeaponViewModel {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} worldCamera
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(scene, worldCamera, settings) {
    this.scene = scene;
    this.worldCamera = worldCamera;
    this.settings = settings;

    // --- dedicated view-model camera ------------------------------------
    this.camera = new THREE.PerspectiveCamera(
      settings.get('weaponFov'),
      worldCamera.aspect,
      0.01,
      12
    );
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.set(LAYER_VIEWMODEL);
    scene.add(this.camera);

    // Ambient + key light dedicated to the view model, so the gun reads
    // clearly regardless of where the player is standing in the world.
    this.vmAmbient = new THREE.AmbientLight(0xb9c9d6, 1.15);
    this.vmAmbient.layers.set(LAYER_VIEWMODEL);
    this.camera.add(this.vmAmbient);

    this.vmKey = new THREE.DirectionalLight(0xfff2dd, 2.0);
    this.vmKey.position.set(0.6, 0.8, 0.4);
    this.vmKey.layers.set(LAYER_VIEWMODEL);
    this.camera.add(this.vmKey);
    this.camera.add(this.vmKey.target);
    this.vmKey.target.position.set(0, -0.2, -1);

    this.vmFill = new THREE.DirectionalLight(0x7fa8c8, 0.7);
    this.vmFill.position.set(-0.8, -0.2, 0.3);
    this.vmFill.layers.set(LAYER_VIEWMODEL);
    this.camera.add(this.vmFill);

    // --- holder: every weapon group hangs off this ----------------------
    this.holder = new THREE.Group();
    this.holder.name = 'viewmodel_holder';
    this.camera.add(this.holder);

    // --- pose state ------------------------------------------------------
    this.sway = new THREE.Vector2();
    this.swayRot = new THREE.Vector2();
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.idlePhase = Math.random() * 100;
    this.airOffset = 0;
    this.airVel = 0;
    this.crouchBlend = 0;
    this.sprintBlend = 0;
    this.leanBlend = 0;
    this.wallPush = 0;
    this.equipBlend = 1;      // 1 = fully raised
    this.holsterBlend = 0;    // 1 = fully lowered (weapon swap out)
    this.inspectTime = -1;
    this.inspectDuration = 2.4;

    // --- scratch ---------------------------------------------------------
    this._hipPos = new THREE.Vector3();
    this._adsPos = new THREE.Vector3();
    this._basePos = new THREE.Vector3();
    this._sightLocal = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    /**
     * The view-model camera narrows as the sights come up. This is how an
     * optic ends up filling the screen the way it does in a real sight picture
     * without having to model an absurdly oversized sight — and because the
     * sight anchor sits exactly on the camera axis, zooming cannot push it
     * off centre.
     */
    this.adsFovScale = 0.62;
    this._onWeaponFov = (v) => {
      this.camera.fov = v;
      this.camera.updateProjectionMatrix();
    };
    settings.onChange('weaponFov', this._onWeaponFov);
  }

  /** Put an object (and all descendants) on the view-model layer. */
  static assignLayer(object3d) {
    object3d.traverse((o) => {
      o.layers.set(LAYER_VIEWMODEL);
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
  }

  /** Register a weapon's group with the holder. */
  addWeapon(weapon) {
    WeaponViewModel.assignLayer(weapon.group);
    // Tagged so the visibility invariant in update() can tell weapon groups
    // apart from anything else that might later be parented to the holder.
    weapon.group.userData.isWeaponGroup = true;
    this.holder.add(weapon.group);
  }

  removeWeapon(weapon) {
    this.holder.remove(weapon.group);
  }

  setSize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Show or hide the first-person weapon.
   *
   * Used by the kill cam. The view-model camera copies the world camera every
   * frame, so when the world camera moves into somebody else's head OUR gun
   * goes with it — drawn at a rifle's offset from a lens that is now theirs.
   * With both players holding a rifle the two overlapped almost exactly and it
   * looked correct; it was two guns in the same place, and picking up a
   * different weapon would have made a liar of the replay.
   */
  setVisible(visible) {
    this.holder.visible = visible;
  }

  /** Copy the world camera's transform so the gun tracks the view exactly. */
  syncCamera() {
    this.worldCamera.getWorldPosition(this.camera.position);
    this.worldCamera.getWorldQuaternion(this.camera.quaternion);
  }

  /** Start the inspect animation (does nothing if one is already playing). */
  startInspect() {
    if (this.inspectTime >= 0) return false;
    this.inspectTime = 0;
    return true;
  }

  cancelInspect() {
    this.inspectTime = -1;
  }

  get inspecting() {
    return this.inspectTime >= 0;
  }

  /**
   * Compute and apply the pose.
   *
   * @param {number} dt
   * @param {object} ctx
   * @param {import('./Weapon.js').Weapon} ctx.weapon
   * @param {number} ctx.adsProgress
   * @param {number} ctx.scopeProgress
   * @param {import('./RecoilSystem.js').RecoilSystem} ctx.recoil
   * @param {THREE.Vector2} ctx.lookDelta   smoothed mouse delta
   * @param {number} ctx.speed01            0..1 horizontal speed
   * @param {boolean} ctx.sprinting
   * @param {boolean} ctx.crouching
   * @param {boolean} ctx.grounded
   * @param {number} ctx.verticalVelocity
   * @param {number} ctx.lean               -1..1
   * @param {number} ctx.wallProximity      0..1
   * @param {number} ctx.reloadCurve        0..1 from the weapon's reload anim
   * @param {number} ctx.equip              0..1 raise progress
   */
  update(dt, ctx) {
    const weapon = ctx.weapon;
    if (!weapon) return;

    const def = weapon.def;
    const ads = ctx.adsProgress;
    const adsEase = smootherStep(ads);
    const bobEnabled = this.settings.get('viewBob');

    // ---------------------------------------------------------- vm zoom
    const baseVmFov = this.settings.get('weaponFov');
    const wantFov = lerp(baseVmFov, baseVmFov * this.adsFovScale, adsEase);
    if (Math.abs(this.camera.fov - wantFov) > 0.005) {
      this.camera.fov = wantFov;
      this.camera.updateProjectionMatrix();
    }

    // ---------------------------------------------------------------- base
    this._hipPos.set(def.viewOffset[0], def.viewOffset[1], def.viewOffset[2]);
    this._computeAdsPose(weapon, this._adsPos);
    this._basePos.lerpVectors(this._hipPos, this._adsPos, adsEase);

    // ---------------------------------------------------------------- sway
    // The gun lags the camera. Damped so it never snaps, clamped so a fast
    // flick can't fling it across the screen.
    const swayScale = lerp(1, 0.22, adsEase);
    const targetSwayX = clamp(-ctx.lookDelta.x * 0.00040, -0.045, 0.045) * swayScale;
    const targetSwayY = clamp(ctx.lookDelta.y * 0.00040, -0.045, 0.045) * swayScale;
    this.sway.x = damp(this.sway.x, targetSwayX, 12, dt);
    this.sway.y = damp(this.sway.y, targetSwayY, 12, dt);
    this.swayRot.x = damp(this.swayRot.x, targetSwayY * 5.0, 11, dt);
    this.swayRot.y = damp(this.swayRot.y, targetSwayX * 5.0, 11, dt);

    // ----------------------------------------------------------------- bob
    const targetBob = ctx.grounded ? clamp(ctx.speed01, 0, 1.3) : 0;
    this.bobAmount = damp(this.bobAmount, targetBob, 9, dt);
    const bobRate = ctx.sprinting ? 12.8 : 9.4;
    this.bobPhase += dt * bobRate * Math.max(0.001, this.bobAmount);
    const bobScale = (bobEnabled ? 1 : 0) * lerp(1, 0.16, adsEase) * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.0145 * bobScale;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * -0.0115 * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * 0.020 * bobScale;

    // ---------------------------------------------------------------- idle
    // Never fully still: a slow breathing drift, strongest when standing.
    this.idlePhase += dt;
    const idleScale = lerp(1, 0.25, adsEase) * (1 - clamp(ctx.speed01, 0, 1));
    const idleX = Math.sin(this.idlePhase * 0.62) * 0.0032 * idleScale;
    const idleY = Math.sin(this.idlePhase * 0.94 + 1.1) * 0.0028 * idleScale;
    const idleRot = Math.sin(this.idlePhase * 0.51 + 0.4) * 0.010 * idleScale;

    // ----------------------------------------------------------------- air
    // Rises a little when leaving the ground, dips on impact.
    const airTarget = ctx.grounded ? 0 : clamp(ctx.verticalVelocity * 0.010, -0.055, 0.055);
    this.airVel += ((airTarget - this.airOffset) * 130 - this.airVel * 17) * dt;
    this.airOffset += this.airVel * dt;
    this.airOffset = clamp(this.airOffset, -0.12, 0.09);

    // -------------------------------------------------------------- crouch
    this.crouchBlend = damp(this.crouchBlend, ctx.crouching ? 1 : 0, 11, dt);

    // -------------------------------------------------------------- sprint
    // Lowered and rotated away — the classic "not ready to fire" pose.
    // Asymmetric on purpose: the weapon eases *into* the sprint carry, but
    // snaps back up in about 0.13 s so shooting out of a run feels immediate.
    const wantSprint = ctx.sprinting && ads < 0.05 && !weapon.isBusy;
    this.sprintBlend = damp(this.sprintBlend, wantSprint ? 1 : 0, wantSprint ? 8 : 23, dt);
    const sp = smootherStep(this.sprintBlend);

    // ---------------------------------------------------------------- lean
    this.leanBlend = damp(this.leanBlend, ctx.lean, 12, dt);

    // Lean styling has to fade out as you aim, exactly like sway, bob, idle
    // and wall push above — and for a much sharper reason than "it looks
    // better".
    //
    // `_computeAdsPose` positions the holder so the sight anchor lands
    // precisely on the camera axis. Every term added to holder.position or
    // holder.rotation afterwards pushes it back off that axis, and the bullet
    // does NOT follow: it leaves along the world camera's forward vector, the
    // screen centre. So an unscaled lean offset means the reticle stops
    // marking the point of impact.
    //
    // Measured before this fix, AR-15 at full ADS: the dot sat 0.41deg off
    // axis standing still, and 22.36deg off at full lean — a 10.3 m miss at
    // 25 m. The bullet was going where the crosshair was; the red dot simply
    // was not there any more. Peeking a corner while aimed was unusable.
    //
    // The gun still visibly leans with the player, because LeanSystem rolls
    // the whole camera 13deg and the view model is drawn by a camera that
    // follows it. What goes away here is only the extra stylistic offset the
    // view model was stacking on top of that.
    const leanStyle = this.leanBlend * (1 - adsEase);

    // ---------------------------------------------------------------- wall
    this.wallPush = damp(this.wallPush, ctx.wallProximity, 15, dt);
    const push = this.wallPush * (1 - adsEase * 0.6);

    // -------------------------------------------------------------- equip
    this.equipBlend = damp(this.equipBlend, ctx.equip, 16, dt);
    const eq = 1 - smootherStep(this.equipBlend);

    // ------------------------------------------------------------- inspect
    let insPos = 0;
    let insYaw = 0;
    let insRoll = 0;
    if (this.inspectTime >= 0) {
      this.inspectTime += dt;
      const t = this.inspectTime / this.inspectDuration;
      if (t >= 1 || ads > 0.05 || weapon.isBusy) {
        this.inspectTime = -1;
      } else {
        const e = Math.sin(Math.PI * clamp(t, 0, 1));
        insPos = e * 0.08;
        insYaw = Math.sin(t * Math.PI * 2) * 0.9 * e;
        insRoll = Math.sin(t * Math.PI * 3 + 0.6) * 0.5 * e;
      }
    }

    // -------------------------------------------------------------- reload
    const rl = ctx.reloadCurve ?? 0;

    // ------------------------------------------------------------ compose
    const recoil = ctx.recoil;
    const holder = this.holder;

    holder.position.set(
      this._basePos.x + this.sway.x + bobX + idleX
        + leanStyle * -0.035
        + sp * 0.075
        + insPos * 0.55
        - push * 0.045,
      this._basePos.y + this.sway.y + bobY + idleY
        + this.airOffset
        + this.crouchBlend * -0.012
        + sp * -0.085
        + rl * -0.10
        + eq * -0.26
        + insPos * 0.35
        - push * 0.055,
      this._basePos.z
        + recoil.kickZ * 0.55
        + sp * 0.045
        + rl * 0.02
        + eq * 0.10
        + push * 0.155
    );

    this._euler.set(
      this.swayRot.x + recoil.kickPitch + rl * 0.52 + sp * 0.34 + eq * 0.85 - insPos * 1.2 + push * 0.42,
      this.swayRot.y + insYaw * 0.35 + sp * 0.55 + leanStyle * 0.10,
      bobRoll + idleRot + recoil.kickRoll + rl * -0.30 + sp * -0.42 + insRoll * 0.5
        + leanStyle * 0.16 + push * 0.22,
      'YXZ'
    );
    holder.rotation.copy(this._euler);

    // Exactly one weapon may be visible, stated as an invariant over all of
    // them rather than as a toggle on the current one.
    //
    // The toggle it replaces read `if (group.visible === hideForScope) flip
    // it` — which, applied to a weapon that had just been holstered, turned
    // it back ON. Nothing else in the frame ever hid a non-current group, so
    // the resurrected weapon stayed on screen for good and they accumulated
    // as the player cycled slots. Asserting the invariant costs twelve cheap
    // comparisons a frame and cannot get into that state at all.
    //
    // When fully scoped the model is entirely behind the scope overlay;
    // hiding it saves a pass and removes any chance of a stray edge.
    const hideForScope = ctx.scopeProgress > 0.985;
    for (const group of this.holder.children) {
      if (!group.userData.isWeaponGroup) continue;
      const want = group === weapon.group && !hideForScope;
      if (group.visible !== want) group.visible = want;
    }
  }

  /**
   * Derive the ADS pose from the weapon's `sight` anchor so the aperture lands
   * exactly on the camera axis. `def.adsOffset[2]` is reused as the distance
   * the sight should sit in front of the eye.
   */
  _computeAdsPose(weapon, out) {
    const depth = weapon.def.adsOffset?.[2] ?? -0.24;
    weapon.getSightLocalPosition(this._sightLocal);
    // desiredSightPosition (0, 0, depth) = holderPos + sightLocal
    out.set(-this._sightLocal.x, -this._sightLocal.y, depth - this._sightLocal.z);
  }

  reset() {
    this.sway.set(0, 0);
    this.swayRot.set(0, 0);
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.airOffset = 0;
    this.airVel = 0;
    this.crouchBlend = 0;
    this.sprintBlend = 0;
    this.leanBlend = 0;
    this.wallPush = 0;
    this.equipBlend = 1;
    this.inspectTime = -1;
  }

  dispose() {
    this.camera.remove(this.holder);
    this.scene.remove(this.camera);
  }
}

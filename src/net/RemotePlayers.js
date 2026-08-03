/**
 * RemotePlayers — draws the other people in the match.
 *
 * Built from the authored soldier model (`public/models/soldier.glb`, 16 named
 * parts), assembled around the joint pivots baked into it so the walk cycle and
 * head aim work from the same numbers the model was authored with.
 *
 * Geometry is shared across every body — `AssetManager._prepareCharacter` has
 * already baked the joint offsets into it — so eight players cost eight sets of
 * *materials*, not eight sets of meshes. Materials are per-player because each
 * body needs its own hit flash and identifying tint.
 *
 * Positions come from NetworkClient.sample(), which is already interpolated
 * ~110 ms in the past. This class does no smoothing of its own: doing it in two
 * places compounds the delay and makes remote players feel like they are
 * skating.
 */

import * as THREE from 'three';
import { damp } from '../core/MathUtils.js';
import { getWeaponDef } from '../weapons/WeaponDefinitions.js';
import { FLAG, PLAYER_MAX_HEALTH } from './protocol.js';

/** Parts that make up a body, and which material role each takes. */
const BODY_PARTS = [
  ['torso', 'body'], ['vest', 'gear'],
  ['legL', 'body'], ['legR', 'body'], ['bootL', 'gear'], ['bootR', 'gear'],
  ['armL', 'body'], ['armR', 'body'], ['foreL', 'body'], ['foreR', 'body'],
  ['gloveL', 'gear'], ['gloveR', 'gear'],
  ['head', 'skin'], ['helmet', 'helmet'], ['visor', 'visor'],
];

/**
 * Identifying tints, applied to each player's fatigues.
 *
 * Free-for-all means you must be able to tell instantly that the shape ahead is
 * a different person from the one behind you. Deliberately desaturated so
 * bodies still read as soldiers rather than as coloured markers.
 */
const PLAYER_TINTS = [
  0x6f7f8c, 0x8c6f6f, 0x6f8c74, 0x8c866f,
  0x7a6f8c, 0x6f8a8c, 0x8c7a6f, 0x77778c,
  0x8c8c6f, 0x6f7c8c, 0x836f7f, 0x748c8c,
];

const NAME_SCALE = 0.55;
/** Height of the chest joint above the feet. Also the fallback muzzle height. */
const CHEST_Y = 1.05;

/**
 * Past this range a player stops casting a shadow. 28 m is roughly half the
 * arena, so a firefight at any normal engagement distance keeps its shadows
 * and the far side of the map stops costing anything.
 */
const SHADOW_CUTOFF_SQ = 28 * 28;

/**
 * Past this range a player's WEAPON stops drawing — nine of their twenty-four
 * meshes. 38 m is far beyond any range at which the gun is more than a few
 * pixels, and the body, the name tag and the hitbox are all untouched.
 */
const WEAPON_CUTOFF_SQ = 38 * 38;

/*
 * How far a peek moves the body, split between a roll and a sideways shift.
 *
 * The local player's camera travels 0.48 m at full lean (LeanSystem's
 * MAX_OFFSET). Matching that with roll alone would need about 60 degrees,
 * which looks like a fall rather than a peek; the pair below put the head
 * roughly where the peeker's own camera is while still reading as a lean.
 */
const PEEK_ROLL = 25 * (Math.PI / 180);
// Measured, not guessed: with the roll above, 0.28 puts the head 0.48 m out —
// the same distance the peeker's own camera travelled. Anything less and they
// see round the corner further than their body admits to.
const PEEK_SHIFT = 0.28;

export class RemotePlayers {
  constructor({ scene, assets }) {
    this.scene = scene;
    this.assets = assets;
    /** @type {Map<number, object>} id -> body record */
    this.bodies = new Map();
    this._available = assets.getModel?.('soldier') != null;
    this._tmp = new THREE.Vector3();
    // Scratch for the IK solver — allocating these per arm per player per
    // frame would churn the heap for no reason.
    this._ikGoal = new THREE.Vector3();
    this._ikTmp = new THREE.Vector3();
    this._ikPole = new THREE.Vector3();
    this._ikX = new THREE.Vector3();
    this._ikY = new THREE.Vector3();
    this._ikZ = new THREE.Vector3();
    this._ikArm = new THREE.Vector3();
    this._ikMat = new THREE.Matrix4();
    this._handL = new THREE.Vector3();
    this._handR = new THREE.Vector3();
    this._aimQ = new THREE.Quaternion();
    this._aimM = new THREE.Matrix4();
    this._ikZero = new THREE.Vector3(0, 0, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    /** @type {Map<number, object>|null} last interpolated sample, for raycast */
    this._lastSample = null;

    /**
     * Lifetime counters, surfaced in the F3 panel.
     *
     * `created` should equal the number of people who have joined. If it keeps
     * climbing while nobody is joining, bodies are being destroyed and rebuilt
     * — and since each build clones five materials, that forces a shader
     * recompile every time, which stutters badly. Cheap to count, and it turns
     * "it feels laggy" into a number.
     */
    this.created = 0;
    this.destroyed = 0;
  }

  /** False when soldier.glb failed to load; Game falls back to plain capsules. */
  get available() { return this._available; }

  /**
   * @param {Map<number, object>} sample  from NetworkClient.sample()
   * @param {Map<number, object>} roster  id -> { name, hp, kills }
   * @param {number} dt
   * @param {THREE.Vector3} [viewer]  where the camera is, for distance culling.
   *   Omitted, everyone casts a shadow — correct, just more expensive.
   */
  sync(sample, roster, dt, viewer = null) {
    // Held for raycast(), so hit registration tests the exact positions that
    // were drawn this frame rather than a separately-sampled set.
    this._lastSample = sample;

    // Remove bodies for players no longer in the sample.
    for (const [id, body] of this.bodies) {
      if (!sample.has(id)) { this._destroy(body); this.bodies.delete(id); }
    }

    for (const [id, s] of sample) {
      let body = this.bodies.get(id);
      if (!body) {
        body = this._create(id, roster.get(id)?.name ?? `PLAYER ${id}`);
        if (!body) continue;
        this.bodies.set(id, body);
      }

      const dead = (s.flags & FLAG.DEAD) !== 0;
      body.group.visible = !dead;
      if (dead) continue;

      body.group.position.set(s.x, s.y - body.footOffset, s.z);
      body.group.rotation.y = s.yaw;
      // Head follows aim, clamped so a straight-up look does not snap the neck.
      body.head.rotation.x = THREE.MathUtils.clamp(-s.pitch, -0.7, 0.7);

      this._setWeapon(body, s.weapon);
      this._animate(body, s, dt);
      this._updateTag(body, s, roster.get(id));
      if (viewer) this._cullShadow(body, viewer);
    }
  }

  /**
   * Stop distant players casting shadows.
   *
   * A body is fifteen meshes, and a shadow caster is drawn a second time for
   * the shadow map — so a full lobby spends a hundred and twenty draw calls
   * per frame on shadows, most of them for players nowhere near the camera.
   * A directional light's shadow camera covers the whole arena, so this is not
   * saved by ordinary frustum culling: someone standing behind you is still
   * drawn into the shadow map every frame.
   *
   * Beyond the cutoff their shadow is a handful of pixels under a body you can
   * barely make out. The body itself keeps drawing — only the shadow goes.
   */
  _cullShadow(body, viewer) {
    const d2 = body.group.position.distanceToSquared(viewer);

    const far = d2 > SHADOW_CUTOFF_SQ;
    if (far !== body.shadowCulled) {           // only walk the tree on a change
      body.shadowCulled = far;
      for (const mesh of body.shadowCasters) mesh.castShadow = !far;
    }

    /*
     * Past WEAPON_CUTOFF the gun itself stops drawing.
     *
     * A weapon model is nine meshes — more than a third of everything a player
     * costs — and at this range it covers a couple of pixels. The BODY keeps
     * drawing, so the silhouette you aim at is unchanged, and hit registration
     * never looked at these meshes anyway: RemotePlayers.raycast tests the
     * interpolated capsule, not the geometry.
     */
    const gunGone = d2 > WEAPON_CUTOFF_SQ;
    if (gunGone !== body.weaponCulled) {
      body.weaponCulled = gunGone;
      body.weaponGroup.visible = !gunGone;
    }
  }

  /**
   * Ray test against the other players, for hit registration.
   *
   * Remote bodies deliberately have NO physics colliders. Creating and
   * destroying a Rapier body per player per snapshot would be pure churn, and
   * the collider would always lag the interpolated visual anyway — so the shot
   * would not match what the shooter saw. Testing directly against the
   * interpolated positions means the hit check uses exactly the geometry that
   * was on screen.
   *
   * The capsule is treated as a vertical segment plus a radius, which is what
   * the player's own collider is.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir      normalised
   * @param {number} maxDist        usually the distance to the nearest wall
   * @returns {{id:number, part:string, distance:number, point:THREE.Vector3}|null}
   */
  raycast(origin, dir, maxDist) {
    const RADIUS = 0.35;
    const HALF = 0.60;          // capsule cylinder half-height, standing
    let best = null;

    for (const [id, s] of this._lastSample ?? []) {
      if ((s.flags & FLAG.DEAD) !== 0) continue;

      // Capsule segment endpoints around the reported centre.
      const crouched = (s.flags & FLAG.CROUCH) !== 0;
      const half = crouched ? 0.22 : HALF;
      const ax = s.x, ay = s.y - half, az = s.z;
      const bx = s.x, by = s.y + half, bz = s.z;

      const hit = raySegmentDistance(origin, dir, ax, ay, az, bx, by, bz, maxDist);
      if (!hit || hit.dist > RADIUS) continue;
      if (hit.t <= 0.05 || hit.t > maxDist) continue;
      if (best && hit.t >= best.distance) continue;

      // Which part, from where up the body the ray passed. Matches the bands
      // the local player's own capsule uses, so damage reads consistently.
      const hitY = origin.y + dir.y * hit.t;
      const frac = (hitY - (s.y - half - RADIUS)) / (half * 2 + RADIUS * 2);
      const part = frac > 0.82 ? 'head' : frac < 0.34 ? 'limb' : 'torso';

      best = {
        id,
        part,
        distance: hit.t,
        point: this._tmp.copy(dir).multiplyScalar(hit.t).add(origin).clone(),
      };
    }
    return best;
  }

  /**
   * Take one player out of the world, immediately.
   *
   * Called when someone leaves rather than waiting for them to fall out of the
   * interpolation buffer, so their body does not stand around for a further
   * couple of hundred milliseconds after they have gone.
   */
  remove(id) {
    const body = this.bodies.get(id);
    if (!body) return false;
    this._destroy(body);
    this.bodies.delete(id);
    // Also out of the sample raycast() tests against, or shots would keep
    // registering on a player who is no longer here.
    this._lastSample?.delete(id);
    return true;
  }

  /** Brief red flash when this player takes damage. */
  flash(id) {
    const body = this.bodies.get(id);
    if (body) body.flash = 1;
  }

  setName(id, name) {
    const body = this.bodies.get(id);
    if (body && body.name !== name) {
      body.name = name;
      this._drawTag(body);
    }
  }

  /**
   * Where this player's barrel is right now, for drawing their muzzle flash.
   *
   * The server reports the shot's origin as the shooter's CAMERA, which sits
   * inside their head — a flash drawn there hangs in front of their face
   * rather than at the end of the gun. This reads the muzzle empty out of the
   * weapon model instead, so the flash tracks the animated arms.
   *
   * @returns {boolean} false when that player has no body to read, in which
   *   case `out` is untouched and the caller should fall back to the origin
   *   the server gave.
   */
  muzzleWorldPosition(id, out) {
    const body = this.bodies.get(id);
    if (!body) return false;
    if (body.muzzle) {
      // The matrix has to be current: the arms moved this frame, and the
      // muzzle hangs off the end of them.
      body.muzzle.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(body.muzzle.matrixWorld);
      return true;
    }
    // No model (procedural weapon, or the glTF is still loading) — chest
    // height in front of them is far closer than the camera position.
    out.copy(body.group.position);
    out.y += CHEST_Y;
    return true;
  }

  // ------------------------------------------------------------------ build
  _create(id, name) {
    if (!this._available) return null;

    const tint = PLAYER_TINTS[(id - 1) % PLAYER_TINTS.length];
    const mats = {
      body: this.assets.getMaterial('soldierFatigues').clone(),
      gear: this.assets.getMaterial('darkGear').clone(),
      skin: this.assets.getMaterial('soldierSkin').clone(),
      helmet: this.assets.getMaterial('soldierHelmet').clone(),
      visor: this.assets.getMaterial('soldierVisor').clone(),
    };
    mats.body.color.setHex(tint);

    /**
     * Materials that can take a hit flash — i.e. that actually have an
     * emissive channel.
     *
     * This MUST NOT include the visor. `soldierVisor` is a MeshBasicMaterial, which
     * has no emissive uniform, and assigning `.emissive` to one is catastrophic
     * rather than merely useless: three.js's refreshUniformsCommon does
     *
     *     if ( material.emissive ) uniforms.emissive.value.copy( ... )
     *
     * so bolting the property on makes it take that branch, then dereference a
     * uniform that does not exist. The result is a TypeError thrown inside the
     * renderer on every frame for every visor mesh — nearly 12,000 of them in
     * one session — which ground the game to a halt the moment a second player
     * appeared, on LAN and hosted alike. The eye is excluded from the flash
     * list for exactly that reason.
     */
    const flashable = [mats.body, mats.gear, mats.skin, mats.helmet]
      .filter((m) => m.emissive !== undefined);

    const group = new THREE.Group();
    group.name = `remote_${id}`;

    const record = {
      id, name, group, mats, flashMats: flashable, flash: 0, phase: Math.random() * 6.28,
      head: null, legL: null, legR: null, armL: null, armR: null,
      // The model stands with its feet at y=0, but the server reports the
      // player's CAPSULE CENTRE. Without this offset every body floats.
      footOffset: 0.9,
      tag: null, tagCanvas: null, tagTexture: null,
      // Gathered once at build so distance culling can flip them without
      // walking the object tree every frame. See _cullShadow.
      shadowCasters: [], shadowCulled: false, weaponCulled: false,
    };

    const limb = (partName, role) => {
      const part = this.assets.getCharacterPart('soldier', partName);
      if (!part) return null;
      const mesh = new THREE.Mesh(part.geometry, mats[role]);
      // Named so limbs can be found by name rather than by position in the
      // child list, which changes as the rig grows.
      mesh.name = partName;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      record.shadowCasters.push(mesh);
      return mesh;
    };

    /**
     * A chest joint, carrying everything above the waist.
     *
     * Shooters layer the aim pose onto the locomotion "per bone, from the
     * spine up": the legs keep running level while the upper body turns and
     * pitches to point the weapon. Without a spine there is nowhere to put
     * that, so aiming had to be faked by rotating individual limbs, and the
     * torso could never blade toward the target.
     *
     * Blading matters mechanically here, not just cosmetically. Squared up,
     * the support hand has to cross the whole chest to reach the handguard —
     * measured at 67 cm from a shoulder with only 56 cm of arm, so the IK
     * could never reach and the left arm locked out straight. Turning the
     * chest brings that shoulder forward and puts the weapon in range.
     */
    const chest = new THREE.Group();
    chest.position.set(0, CHEST_Y, 0);
    group.add(chest);
    record.chest = chest;

    // Joint groups, matching the pivots baked into the model's geometry.
    // Legs stay on the body so they are unaffected by aiming; arms hang off
    // the chest so they inherit the aim pose.
    const joints = {};
    for (const key of ['legL', 'legR', 'armL', 'armR']) {
      const part = this.assets.getCharacterPart('soldier', key);
      if (!part) continue;
      const j = new THREE.Group();
      const onChest = key === 'armL' || key === 'armR';
      j.position.set(part.pivot[0], part.pivot[1] - (onChest ? CHEST_Y : 0), part.pivot[2]);
      (onChest ? chest : group).add(j);
      joints[key] = j;
      record[key] = j;
    }

    /*
     * Forearms hang off the upper arms, so the chain is shoulder -> elbow ->
     * wrist and the elbow can actually bend. Positioned by the DIFFERENCE
     * between the two pivots, because a child's position is relative to its
     * parent, not to the body.
     *
     * The joints are created WHETHER OR NOT the model supplies forearm meshes,
     * and that matters more than it looks. When the soldier gained forearms,
     * anyone still holding a cached copy of the older model had none — and the
     * posing code, which required them, did nothing at all. The result was a
     * character standing with its arms straight down and a rifle floating at
     * its waist.
     *
     * Missing geometry must never take the animation with it. With the joints
     * always present the rig still poses; `record.hasForearms` just tells the
     * solver to treat the arm as one bone so it does not bend a limb whose
     * mesh cannot follow.
     */
    const ELBOW_DROP = 0.272;      // shoulder to elbow, from the authored model
    record.hasForearms = true;
    for (const [foreKey, armKey] of [['foreL', 'armL'], ['foreR', 'armR']]) {
      if (!joints[armKey]) continue;
      const fore = this.assets.getCharacterPart('soldier', foreKey);
      const arm = this.assets.getCharacterPart('soldier', armKey);
      const j = new THREE.Group();
      if (fore && arm) {
        j.position.set(
          fore.pivot[0] - arm.pivot[0],
          fore.pivot[1] - arm.pivot[1],
          fore.pivot[2] - arm.pivot[2],
        );
        record.upperLen = Math.abs(arm.pivot[1] - fore.pivot[1]);
      } else {
        j.position.set(0, -ELBOW_DROP, 0);
        record.hasForearms = false;
      }
      joints[armKey].add(j);
      joints[foreKey] = j;
      record[foreKey] = j;
    }
    record.upperLen = record.upperLen || ELBOW_DROP;
    // Elbow to the centre of the palm — the glove sits at z 0.858 in the
    // authored model, the elbow at 1.148.
    record.foreLen = 0.29;

    for (const [partName, role] of BODY_PARTS) {
      const mesh = limb(partName, role);
      if (!mesh) continue;
      const part = this.assets.getCharacterPart('soldier', partName);

      if (partName === 'head') {
        // On the chest, so it turns with the upper body when aiming.
        const headGroup = new THREE.Group();
        headGroup.position.set(part.pivot[0], part.pivot[1] - CHEST_Y, part.pivot[2]);
        headGroup.add(mesh);
        chest.add(headGroup);
        record.head = headGroup;
      } else if (partName === 'helmet' || partName === 'visor') {
        record.head?.add(mesh);          // nods with the head
      } else if (joints[partName]) {
        joints[partName].add(mesh);      // limb mesh sits at its joint origin
      } else if (partName === 'bootL') {
        joints.legL?.add(mesh);
      } else if (partName === 'bootR') {
        joints.legR?.add(mesh);
      } else if (partName === 'gloveL' || partName === 'gloveR') {
        // Hands ride the FOREARM, not the shoulder — that is the whole point
        // of the split. Falls back to the upper arm if an older soldier.glb
        // without forearms is loaded, so nothing detaches.
        const fore = partName === 'gloveL' ? 'foreL' : 'foreR';
        const arm = partName === 'gloveL' ? 'armL' : 'armR';
        (joints[fore] ?? joints[arm])?.add(mesh);
      } else {
        // Torso and vest belong to the upper body, so they turn with the
        // chest — otherwise the arms would swing away from a body that stayed
        // squared up. Their geometry is authored in world space and carries no
        // pivot, so cancel the chest offset to leave them where they were.
        mesh.position.set(part.pivot[0], part.pivot[1] - CHEST_Y, part.pivot[2]);
        chest.add(mesh);
      }
    }

    /**
     * The weapon is placed FROM the hands, every frame.
     *
     * It used to be parented to the body and moved between a hip pose and a
     * shouldered pose by hand-tuned constants, with the arms posed separately.
     * That can be made to look right from one angle and is wrong from all the
     * others, because nothing connects the gun to the hands — they are two
     * independent animations kept in agreement by eye.
     *
     * Now both hands are driven to targets by IK and the grip is put exactly
     * where the right hand ended up, with the barrel running along the line to
     * the left hand. The weapon is held in both hands by construction.
     *
     * It lives on the CHEST rather than on the hand so it shares one space
     * with the hand targets, and so it inherits the aim pitch directly.
     */
    record.weaponGroup = new THREE.Group();
    chest.add(record.weaponGroup);
    record.weaponId = null;

    this._buildTag(record);
    this.scene.add(group);
    this.created++;
    return record;
  }

  /**
   * Put the weapon the player is actually holding into their hands.
   *
   * Clones the real authored view model rather than approximating it with boxes,
   * so the silhouette you see across the map is the same gun you would be
   * holding. `Object3D.clone()` shares geometry AND materials with the original,
   * so this costs a handful of Mesh objects and no GPU memory — and because the
   * materials are shared, it triggers no shader recompilation either.
   *
   * Rebuilt only when the weapon changes, which is a deliberate player action
   * and therefore rare.
   */
  _setWeapon(body, weaponId) {
    if (body.weaponId === weaponId) return;
    body.weaponId = weaponId;

    // Drop the previous one. Geometry and materials belong to the shared source
    // model, so nothing here may be disposed — only detached.
    for (const child of [...body.weaponGroup.children]) body.weaponGroup.remove(child);
    // Belongs to the model being removed, so it must not outlive it.
    body.muzzle = null;

    // The snapshot carries the WEAPON id ('rifle'), which is not the MODEL id
    // ('ar15') — most match, the carbine does not. Looking the model up by
    // weapon id silently produced an empty weapon group, so the gun was
    // "there" with zero meshes in it.
    const modelId = getWeaponDef(weaponId)?.modelId ?? weaponId;
    const source = this.assets.getModel?.(modelId);
    if (!source) return;          // procedural-only weapon, or model missing

    const model = source.clone(true);
    model.traverse((o) => {
      if (!o.isMesh) return;
      /*
       * The gun does NOT cast a shadow.
       *
       * A weapon model is nine separate meshes, and every shadow caster is a
       * second draw call in the shadow pass. Nine per player, times a full
       * lobby, is seventy-odd draw calls spent on a shadow the size of a
       * pencil that nobody has ever noticed. The body still casts, which is
       * what actually grounds a player in the scene.
       */
      o.castShadow = false;
      o.receiveShadow = false;
      // The source is a view model on the weapon layer, which the world camera
      // cannot see. A gun in a remote player's hands is world geometry.
      o.layers.set(0);
      o.frustumCulled = true;
    });
    // Anchors (sight/muzzle/reticle empties) come along in the clone and are
    // harmless, but the reticle would draw a floating red dot in mid-air.
    for (const name of ['reticle', 'sight', 'eject']) {
      const anchor = model.getObjectByName(name);
      if (anchor) anchor.visible = false;
    }
    /*
     * Keep the muzzle empty, which is where another player's shots visibly
     * come from. Hidden like the rest — it is a reference point, not geometry —
     * but kept in the tree so its world matrix stays up to date as the arms
     * move, giving a flash that sits on the barrel through the whole animation.
     */
    const muzzle = model.getObjectByName('muzzle');
    if (muzzle) { muzzle.visible = false; body.muzzle = muzzle; }
    body.weaponGroup.add(model);
  }

  _buildTag(record) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      // Drawn without tone mapping so the label stays legible at any exposure.
      toneMapped: false,
    }));
    sprite.scale.set(NAME_SCALE * 4, NAME_SCALE, 1);
    sprite.position.set(0, 2.08, 0);
    record.group.add(sprite);

    record.tag = sprite;
    record.tagCanvas = canvas;
    record.tagTexture = texture;
    this._drawTag(record);
  }

  _drawTag(record, hp = PLAYER_MAX_HEALTH) {
    const c = record.tagCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    ctx.font = 'bold 30px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Outline first so the name survives against a bright sky or a pale wall.
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(2, 8, 14, 0.92)';
    ctx.strokeText(record.name, c.width / 2, 22);
    ctx.fillStyle = '#dbe9f4';
    ctx.fillText(record.name, c.width / 2, 22);

    // Health bar under the name.
    const barW = 168;
    const x = (c.width - barW) / 2;
    // Against the real maximum, not a hardcoded 100. Health is 150, so the bar
    // read full anywhere from 100 up and every wound above that was invisible.
    const frac = Math.max(0, Math.min(1, hp / PLAYER_MAX_HEALTH));
    ctx.fillStyle = 'rgba(2, 8, 14, 0.85)';
    ctx.fillRect(x - 2, 44, barW + 4, 12);
    ctx.fillStyle = frac > 0.5 ? '#63d19a' : frac > 0.25 ? '#e0b64f' : '#e05f52';
    ctx.fillRect(x, 46, barW * frac, 8);

    record.tagTexture.needsUpdate = true;
    record.tagHp = hp;
  }

  _updateTag(body, s, rosterEntry) {
    const name = rosterEntry?.name;
    if (name && name !== body.name) { body.name = name; this._drawTag(body, s.hp); return; }
    // Only redraw when the bar would visibly move — this is a canvas upload.
    if (Math.abs((body.tagHp ?? PLAYER_MAX_HEALTH) - s.hp) >= 4) this._drawTag(body, s.hp);
  }

  // -------------------------------------------------------------- animation
  _animate(body, s, dt) {
    /* ------------------------------------------------------------- gait
     * Speed is measured from the body's OWN drawn motion, not from the
     * `moving` figure on the snapshot.
     *
     * The snapshot value is a delta between two server frames divided by the
     * gap between them, and it aliases badly: the client's send rate and the
     * server's tick rate are both 30 Hz and drift against each other, so a
     * given interval contains one step or two more or less at random.
     * Measured while running at 5.6 m/s it reported about 2.4 — 43% of the
     * truth — so the gait blend never rose above half and the legs only ever
     * half-swung. The character shuffled instead of running.
     *
     * Differentiating the interpolated position is both more accurate and
     * self-consistent: it is the speed the body is ACTUALLY being drawn
     * moving at, which is exactly the number the stride has to match if the
     * feet are not to slide.
     */
    if (body.lastPos) {
      // HORIZONTAL only. The vertical bob is added to this same position at
      // the end of this function, so including y would feed the walk's own
      // bounce back in as speed.
      const dx = body.group.position.x - body.lastPos.x;
      const dz = body.group.position.z - body.lastPos.z;
      const raw = dt > 1e-5 ? Math.hypot(dx, dz) / dt : 0;
      // Smoothed, because interpolation makes the per-frame delta jittery;
      // fast enough to react inside a single step.
      body.speed = damp(body.speed ?? 0, Math.min(raw, 14), 12, dt);
    } else {
      body.lastPos = body.group.position.clone();
      body.speed = 0;
    }
    body.lastPos.copy(body.group.position);

    // Stride frequency comes from ground speed and stride length: at 5.6 m/s
    // with a 1.75 m stride the legs cycle 3.2 times a second, so the planted
    // foot stays under the hip instead of skating.
    const speed = Math.min(body.speed ?? 0, 12);
    const moving = Math.min(1, speed / 5.0);
    const STRIDE = 1.75;
    body.phase += (speed / STRIDE) * Math.PI * 2 * dt;
    // Idle sway so a standing player is never perfectly frozen.
    if (speed < 0.15) body.phase += dt * 1.1;

    // Blend the whole gait in and out rather than snapping between poses,
    // otherwise a player who taps a movement key twitches.
    body.gait = damp(body.gait ?? 0, moving, 9, dt);
    const g = body.gait;

    const swing = Math.sin(body.phase);
    const lift = Math.cos(body.phase);

    // ---------------------------------------------------------------- legs
    // Knees are not separate joints in this model, so the illusion comes from
    // swinging the leg and lifting the body — the classic low-poly walk.
    if (body.legL) body.legL.rotation.x = swing * 0.80 * g;
    if (body.legR) body.legR.rotation.x = -swing * 0.80 * g;

    // ---------------------------------------------------------------- torso
    // Vertical bob at twice stride frequency (one rise per footfall), plus a
    // slight forward lean into the run and a roll onto the planted foot.
    // These three are most of what separates "walking" from "gliding".
    const bob = Math.abs(lift) * 0.055 * g;
    const lean = g * 0.13;
    body.group.rotation.x = lean;
    body.group.rotation.z = swing * 0.035 * g;

    // ----------------------------------------------------------------- arms
    // The right arm holds the weapon and the left arm is SOLVED to reach it.
    //
    // This is the arrangement shooters use, and it is the only one that holds
    // up from every angle: the gun is socketed to the right hand, so the grip
    // is correct by construction, and the support hand is then driven onto a
    // socket on the weapon by inverse kinematics. Nothing has to be kept in
    // agreement by eye, because there is only one thing being posed.
    //
    // What it replaces was two independent poses — an arm pose and a weapon
    // pose — tuned against each other by hand. That can be made to look right
    // in one screenshot and is wrong everywhere else, which is exactly how it
    // looked.
    //
    // POSITIVE rotation.x swings an arm FORWARD (towards -z). Counter-
    // intuitive, and it was wrong here once already.
    const aiming = (s.flags & FLAG.ADS) !== 0 || (s.flags & FLAG.FIRING) !== 0;
    body.aim = damp(body.aim ?? 0, aiming ? 1 : 0, 10, dt);
    const aim = body.aim;
    const jog = swing * 0.09 * g * (1 - aim);   // suppressed while aiming

    // --- chest: the aim layer ---------------------------------------------
    // Pitches to the player's real aim while the legs below keep running
    // level. This is the "blend from the spine up" that lets someone sprint
    // and aim at once without the two poses fighting.
    if (body.chest) {
      // Bladed when carrying, squared up when aiming. Shouldered, the blade
      // has to come off: it adds directly to the barrel's cant, and a player
      // aiming at you whose muzzle points 20 degrees past your shoulder reads
      // as not aiming at you at all.
      body.chest.rotation.y = THREE.MathUtils.lerp(0.26, 0.06, aim);
      // POSITIVE rotation.x tips the chest's -Z (its forward) UPWARD, and
      // negative pitch means looking down, so the two share a sign. Negating
      // it here pointed the weapon up whenever the player aimed down.
      body.chest.rotation.x = s.pitch * (0.35 + 0.45 * aim) - lean * 0.5;

      /*
       * --- peeking ------------------------------------------------------
       *
       * LEAN_L and LEAN_R have always been on the wire and nothing had ever
       * read them, so a player peeking round a corner looked exactly like a
       * player standing squarely behind it. Their camera had cleared the
       * corner and their body had not moved an inch, which is both a
       * disorienting thing to be shot by and an unfair one — the peeker gained
       * the angle and gave away nothing.
       *
       * Tilted from the CHEST rather than the feet: a peek is a body leaning
       * out over planted feet, and rotating the whole figure would slide the
       * boots sideways through the floor.
       *
       * Damped because the flags are binary and arrive at snapshot rate;
       * applied raw they would snap between upright and full lean.
       */
      let peekTarget = 0;
      if ((s.flags & FLAG.LEAN_R) !== 0) peekTarget = 1;
      else if ((s.flags & FLAG.LEAN_L) !== 0) peekTarget = -1;
      body.peek = damp(body.peek ?? 0, peekTarget, 9, dt);

      // NEGATIVE rotation about z tips the top of the body towards +x, and +x
      // is the character's right (armR sits at +0.25). Getting this backwards
      // would show them peeking out of the opposite side of the wall, which is
      // worse than not showing it at all.
      body.chest.rotation.z = swing * 0.03 * g - body.peek * PEEK_ROLL;
      // Some of the travel comes from shifting the whole upper body, which is
      // what actually clears the corner. Roll alone needs a comical angle to
      // move the head as far as the camera really goes.
      body.chest.position.x = body.peek * PEEK_SHIFT;
    }

    /*
     * --- hands, then weapon ---------------------------------------------
     *
     * Both hands are driven to explicit targets and the weapon is then placed
     * FROM the hands: the grip goes exactly where the right hand is, and the
     * barrel runs along the line to the left hand. So the gun is held in both
     * hands by construction, at every angle, with nothing to keep in sync by
     * eye.
     *
     * Targets are in CHEST space, so they inherit the aim pitch for free —
     * pitch the chest and the whole hold follows, weapon included.
     *
     * They are also chosen to be REACHABLE. This figure has 0.60 m between its
     * shoulders and 0.56 m of arm, so a rifle held square to the chest simply
     * cannot be gripped by both hands — an earlier attempt put the support
     * target 0.67 m from a 0.56 m arm and the elbow locked out straight,
     * pointing at nothing. Held across the body, both hands reach.
     */
    const carry = (readyX, readyY, readyZ, adsX, adsY, adsZ, out) => out.set(
      THREE.MathUtils.lerp(readyX, adsX, aim),
      THREE.MathUtils.lerp(readyY, adsY, aim) + jog * 0.25,
      THREE.MathUtils.lerp(readyZ, adsZ, aim),
    );

    if (body.armR && body.foreR && body.armL && body.foreL) {
      /*
       * Ready is a cross-body carry, shouldered brings the weapon centre and
       * levels the barrel. Both sets are constrained by reach: shoulders here
       * are 0.60 m apart with 0.56 m of arm, which is a stockier build than a
       * person, so the support hand cannot cross as far as a real shooter's.
       * Shouldered therefore keeps the grip near the centreline rather than at
       * the right shoulder, which is what lets the barrel come round to only
       * about 17 degrees of cant instead of 30.
       */
      /*
       * Hand heights are measured, not guessed. Before this the shouldered
       * muzzle sat 25 cm BELOW the head — a man aiming at the floor — and the
       * ready carry hung at navel height. Both are lifted so the weapon rides
       * where a person actually holds one: at the ready just under the
       * shoulder, and shouldered with the sight line near the eye.
       */
      //                      ready                    shouldered
      const tR = carry(0.165, 0.105, -0.215,   0.020, 0.345, -0.215, this._handR);
      const tL = carry(-0.055, 0.170, -0.405, -0.016, 0.360, -0.450, this._handL);

      // Pole hints push each elbow outward, away from the chest.
      body.outOfReachR = this._solveArmIK(body, body.armR, body.foreR, tR, 0.8);
      body.outOfReachL = this._solveArmIK(body, body.armL, body.foreL, tL, -0.8);

      // Weapon: grip at the right hand, barrel toward the left hand. -Z is
      // the weapon's forward axis, so the basis is built to look that way.
      if (body.weaponGroup) {
        body.weaponGroup.position.copy(tR);
        this._ikTmp.copy(tL).sub(tR).normalize();          // grip -> handguard
        // Matrix4.lookAt(eye, target, up) builds +Z pointing from target back
        // to eye, so with the eye at the origin its -Z lands along the target
        // direction — which is already the axis weapons are authored down. No
        // flip is needed, and adding one points the barrel at the shooter.
        this._aimM.lookAt(this._ikZero, this._ikTmp, this._up);
        body.weaponGroup.quaternion.setFromRotationMatrix(this._aimM);
      }
    }

    // --------------------------------------------------------------- crouch
    const crouch = (s.flags & FLAG.CROUCH) !== 0 ? 1 : 0;
    body.crouch = damp(body.crouch ?? 0, crouch, 8, dt);
    body.group.position.y += bob - body.crouch * 0.34;

    // ---------------------------------------------------------------- flash
    if (body.flash > 0) {
      // Faster decay than before (5 -> 7.5) with a brighter peak. A long, dim
      // fade reads as lighting; a short, hot one reads as an impact, which is
      // the whole point of the effect.
      body.flash = Math.max(0, body.flash - dt * 7.5);
      const k = body.flash;
      // Sharpened so the first instant is by far the brightest part.
      const e = k * k;
      // flashMats only — see the note in _create. Iterating every material here
      // would dereference `.emissive` on the visor's MeshBasicMaterial.
      for (const m of body.flashMats) m.emissive.setRGB(1.5 * e, 0.22 * e, 0.16 * e);

      // A hit also rocks the body slightly, so a target you are landing rounds
      // on visibly reacts rather than walking on unmoved.
      if (body.chest) body.chest.rotation.x -= e * 0.16;
    }
  }

  /**
   * Two-bone IK: point an arm so its hand lands on a target.
   *
   * The standard law-of-cosines solve, the same one an engine's Two Bone IK
   * node performs. Given the shoulder position, a target, and the two bone
   * lengths, there is exactly one elbow angle that puts the hand on the
   * target:
   *
   *     cos(elbow) = (upper^2 + fore^2 - distance^2) / (2 * upper * fore)
   *
   * The shoulder is then aimed down the line to the target and tilted back by
   * the other interior angle of the same triangle, so the hand lands on it.
   *
   * Targets out of reach clamp to a straight arm rather than failing, so the
   * hand stretches toward the weapon instead of snapping or inverting.
   *
   * @param {object} body
   * @param {THREE.Object3D} upper   shoulder joint
   * @param {THREE.Object3D} fore    elbow joint, a child of upper
   * @param {THREE.Object3D} target  the point to reach
   * @param {number} jog             residual walk sway
   */
  _solveArmIK(body, upper, fore, targetLocal, poleX) {
    // With no forearm mesh the arm is one rigid piece, so it must not bend at
    // a joint its geometry knows nothing about. Solving it as a single bone of
    // the full length still points the hand at the target — the hold is
    // stiffer, but the weapon is in it.
    const twoBone = body.hasForearms !== false;
    const L1 = twoBone ? (body.upperLen || 0.272) : (body.upperLen || 0.272) + (body.foreLen || 0.29);
    const L2 = twoBone ? (body.foreLen || 0.29) : 0;

    // Solve in the shoulder's PARENT space (the chest), so the result does not
    // depend on whatever rotation the arm is already carrying.
    const goal = this._ikGoal.copy(targetLocal).sub(upper.position);
    const reach = (L1 + L2) * 0.999;
    const raw = goal.length();
    if (raw < 1e-4) return 0;
    const dist = Math.min(raw, reach);

    // A single bone has no triangle to solve: it just points at the target,
    // with no elbow and no tilt off the line. Running the two-bone maths with
    // L2 = 0 divides by zero, and the clamp turns that into a 180-degree
    // elbow — the arm folded back on itself.
    let bend = 0;
    let tilt = 0;
    if (L2 > 1e-4) {
      // How far the forearm folds back from straight.
      const cosElbow = THREE.MathUtils.clamp(
        (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1,
      );
      bend = Math.PI - Math.acos(cosElbow);

      // Angle between the upper arm and the straight line to the target.
      const cosShoulder = THREE.MathUtils.clamp(
        (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1,
      );
      tilt = Math.acos(cosShoulder);
    }

    const dir = goal.divideScalar(raw);

    /*
     * Build the shoulder's orientation as a full basis rather than as Euler
     * terms.
     *
     * The previous version decomposed the direction into an independent x and
     * z rotation and set them together. That is not how rotations compose —
     * applying two Euler terms does not aim a bone at a point except for small
     * angles — so the arm pointed somewhere near the target and the hand
     * missed it by tens of centimetres.
     *
     * The bend axis is chosen from a pole hint so the elbow ends up behind and
     * outside the arm, the way a human elbow does, instead of inverting
     * through the chest.
     */
    const pole = this._ikPole.set(poleX, 0.15, 1).normalize();
    const xAxis = this._ikX.crossVectors(dir, pole);
    if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
    xAxis.normalize();

    // Upper arm direction: the line to the target, tilted off it by the
    // triangle's shoulder angle, rotating in the bend plane.
    const armDir = this._ikArm.copy(dir).applyAxisAngle(xAxis, tilt);

    // The bone hangs down its own -Y, so local +Y is the opposite of armDir.
    const yAxis = this._ikY.copy(armDir).negate();
    // Re-orthogonalise: the tilt moved armDir, so xAxis is no longer exactly
    // perpendicular to it.
    xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis)).normalize();
    const zAxis = this._ikZ.crossVectors(xAxis, yAxis);

    this._ikMat.makeBasis(xAxis, yAxis, zAxis);
    upper.quaternion.setFromRotationMatrix(this._ikMat);
    // The forearm inherits that basis, so bending about its local X folds it
    // in the same plane, back onto the target.
    fore.rotation.set(-bend, 0, 0);

    return Math.max(0, raw - reach);   // how far out of reach, for diagnostics
  }

  // ----------------------------------------------------------------- teardown
  _destroy(body) {
    this.destroyed++;
    this.scene.remove(body.group);
    // Geometry is SHARED with every other remote body — disposing it here
    // would blank out all of them. Only the per-player materials and this
    // body's own name-tag texture are ours to free.
    for (const m of Object.values(body.mats)) m.dispose();
    body.tag?.material?.dispose();
    body.tagTexture?.dispose();
  }

  clear() {
    for (const body of this.bodies.values()) this._destroy(body);
    this.bodies.clear();
  }

  dispose() { this.clear(); }
}

/**
 * Closest approach between a ray and a line segment.
 *
 * Returns the distance along the RAY (`t`) and the perpendicular distance
 * between the two lines (`dist`). A capsule is hit when `dist <= radius`.
 * Standard closest-point-between-two-lines, with the degenerate parallel case
 * handled explicitly — without that guard a shot fired exactly along a
 * player's vertical axis divides by zero and registers as a hit at t=0.
 */
function raySegmentDistance(origin, dir, ax, ay, az, bx, by, bz, maxT) {
  const ux = dir.x, uy = dir.y, uz = dir.z;             // ray direction (unit)
  const vx = bx - ax, vy = by - ay, vz = bz - az;       // segment direction
  const wx = origin.x - ax, wy = origin.y - ay, wz = origin.z - az;

  const a = ux * ux + uy * uy + uz * uz;                // = 1, dir is normalised
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;

  const denom = a * c - b * b;
  let t;   // along the ray
  let s;   // along the segment, clamped to [0,1]

  if (Math.abs(denom) < 1e-8) {
    // Parallel: pick the segment start and project onto the ray.
    s = 0;
    t = -d;
  } else {
    t = (b * e - c * d) / denom;
    s = (a * e - b * d) / denom;
    if (s < 0) { s = 0; t = -d; }
    else if (s > 1) { s = 1; t = b - d; }
  }

  if (t < 0) t = 0;
  if (t > maxT) return null;

  const cx = origin.x + ux * t - (ax + vx * s);
  const cy = origin.y + uy * t - (ay + vy * s);
  const cz = origin.z + uz * t - (az + vz * s);
  return { t, dist: Math.sqrt(cx * cx + cy * cy + cz * cz) };
}

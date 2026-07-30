/**
 * RemotePlayers — draws the other people in the match.
 *
 * Reuses the authored soldier model (`public/models/soldier.glb`, 16 named
 * parts) that the AI enemies use, assembled around the same joint pivots so the
 * walk cycle and head aim work identically. Nothing new had to be modelled.
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
import { FLAG } from './protocol.js';

/** Parts that make up a body, and which material role each takes. */
const BODY_PARTS = [
  ['torso', 'body'], ['vest', 'gear'],
  ['legL', 'body'], ['legR', 'body'], ['bootL', 'gear'], ['bootR', 'gear'],
  ['armL', 'body'], ['armR', 'body'], ['gloveL', 'gear'], ['gloveR', 'gear'],
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
];

const NAME_SCALE = 0.55;

export class RemotePlayers {
  constructor({ scene, assets }) {
    this.scene = scene;
    this.assets = assets;
    /** @type {Map<number, object>} id -> body record */
    this.bodies = new Map();
    this._available = assets.getModel?.('soldier') != null;
    this._tmp = new THREE.Vector3();
    /** @type {Map<number, object>|null} last interpolated sample, for raycast */
    this._lastSample = null;
  }

  /** False when soldier.glb failed to load; Game falls back to plain capsules. */
  get available() { return this._available; }

  /**
   * @param {Map<number, object>} sample  from NetworkClient.sample()
   * @param {Map<number, object>} roster  id -> { name, hp, kills }
   * @param {number} dt
   */
  sync(sample, roster, dt) {
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

      this._animate(body, s, dt);
      this._updateTag(body, s, roster.get(id));
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
      // the AI enemies use so damage feels consistent between the two.
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

  // ------------------------------------------------------------------ build
  _create(id, name) {
    if (!this._available) return null;

    const tint = PLAYER_TINTS[(id - 1) % PLAYER_TINTS.length];
    const mats = {
      body: this.assets.getMaterial('enemyFatigues').clone(),
      gear: this.assets.getMaterial('enemyVest').clone(),
      skin: this.assets.getMaterial('enemySkin').clone(),
      helmet: this.assets.getMaterial('enemyHelmet').clone(),
      visor: this.assets.getMaterial('enemyEye').clone(),
    };
    mats.body.color.setHex(tint);
    for (const m of Object.values(mats)) m.emissive = new THREE.Color(0x000000);

    const group = new THREE.Group();
    group.name = `remote_${id}`;

    const record = {
      id, name, group, mats, flash: 0, phase: Math.random() * 6.28,
      head: null, legL: null, legR: null, armL: null, armR: null,
      // The model stands with its feet at y=0, but the server reports the
      // player's CAPSULE CENTRE. Without this offset every body floats.
      footOffset: 0.9,
      tag: null, tagCanvas: null, tagTexture: null, hpBar: null,
    };

    const limb = (partName, role) => {
      const part = this.assets.getCharacterPart('soldier', partName);
      if (!part) return null;
      const mesh = new THREE.Mesh(part.geometry, mats[role]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    // Joint groups, matching Enemy's pivots so the same animation maths works.
    const joints = {};
    for (const key of ['legL', 'legR', 'armL', 'armR']) {
      const part = this.assets.getCharacterPart('soldier', key);
      if (!part) continue;
      const j = new THREE.Group();
      j.position.fromArray(part.pivot);
      group.add(j);
      joints[key] = j;
      record[key] = j;
    }

    for (const [partName, role] of BODY_PARTS) {
      const mesh = limb(partName, role);
      if (!mesh) continue;
      const part = this.assets.getCharacterPart('soldier', partName);

      if (partName === 'head') {
        const headGroup = new THREE.Group();
        headGroup.position.fromArray(part.pivot);
        headGroup.add(mesh);
        group.add(headGroup);
        record.head = headGroup;
      } else if (partName === 'helmet' || partName === 'visor') {
        record.head?.add(mesh);          // nods with the head
      } else if (joints[partName]) {
        joints[partName].add(mesh);      // limb mesh sits at its joint origin
      } else if (partName === 'bootL' || partName === 'gloveL') {
        joints[partName === 'bootL' ? 'legL' : 'armL']?.add(mesh);
      } else if (partName === 'bootR' || partName === 'gloveR') {
        joints[partName === 'bootR' ? 'legR' : 'armR']?.add(mesh);
      } else {
        mesh.position.fromArray(part.pivot);
        group.add(mesh);
      }
    }

    this._buildTag(record);
    this.scene.add(group);
    return record;
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

  _drawTag(record, hp = 100) {
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
    const frac = Math.max(0, Math.min(1, hp / 100));
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
    if (Math.abs((body.tagHp ?? 100) - s.hp) >= 4) this._drawTag(body, s.hp);
  }

  // -------------------------------------------------------------- animation
  _animate(body, s, dt) {
    // Walk cycle driven by the speed the interpolator measured, so a remote
    // player's legs match how fast they are actually crossing the ground.
    const speed = Math.min(s.moving ?? 0, 10);
    const walk = Math.min(1.3, speed / 5.6);
    body.phase += dt * (4.4 + walk * 4.5) * Math.max(0.12, walk);

    const swing = Math.sin(body.phase) * 0.72 * walk;
    if (body.legL) body.legL.rotation.x = swing;
    if (body.legR) body.legR.rotation.x = -swing;

    // Arms come up when aiming, otherwise counter-swing with the legs.
    const aiming = (s.flags & FLAG.ADS) !== 0 || (s.flags & FLAG.FIRING) !== 0;
    const aim = aiming ? 1 : 0;
    if (body.armR) {
      body.armR.rotation.x = THREE.MathUtils.lerp(-swing * 0.55, -1.45, aim);
      body.armR.rotation.z = THREE.MathUtils.lerp(0, -0.15, aim);
    }
    if (body.armL) {
      body.armL.rotation.x = THREE.MathUtils.lerp(swing * 0.55, -1.3, aim);
      body.armL.rotation.z = THREE.MathUtils.lerp(0, 0.45, aim);
    }

    // Crouch: drop the body and shorten the stride.
    const crouch = (s.flags & FLAG.CROUCH) !== 0 ? 1 : 0;
    body.crouch = damp(body.crouch ?? 0, crouch, 8, dt);
    body.group.position.y -= body.crouch * 0.34;

    if (body.flash > 0) {
      body.flash = Math.max(0, body.flash - dt * 5);
      const k = body.flash;
      for (const m of Object.values(body.mats)) m.emissive.setRGB(0.9 * k, 0.15 * k, 0.12 * k);
    }
  }

  // ----------------------------------------------------------------- teardown
  _destroy(body) {
    this.scene.remove(body.group);
    // Geometry is SHARED with the AI enemies and every other remote body —
    // disposing it here would blank out all of them. Only the per-player
    // materials and this body's own name-tag texture are ours to free.
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

/**
 * DroneObjects — every chassis in the world, and every shot that hits one.
 *
 * ONE PATH, INCLUDING YOUR OWN
 * ----------------------------
 * This draws and hit-tests EVERY drone in the room from the interpolated
 * snapshot sample, the local player's own included. There is no `selfId` branch
 * in creation, in interpolation, or in the raycast.
 *
 * The obvious alternative — draw your own drone from `DroneActor`'s local
 * prediction and everyone else's from the sample — needs that branch in all
 * three, and buys a robot that is in a different place for its pilot than for
 * the person shooting at it. The moment the server refuses a drive report, the
 * pilot watches their own chassis sitting in a doorway while everybody else
 * shoots at one a metre away, and neither of them is wrong. Predicting only
 * MOVEMENT and drawing only from the sample means the box everybody shoots at is
 * the box everybody sees, and the pilot is just another observer of it.
 *
 * The single concession is `hiddenOwnerId`: while you are piloting, your own
 * chassis is not drawn, because the camera is inside it. That is the existing
 * `RemotePlayers.headlessId` precedent, one line, and it deliberately does NOT
 * reach the hit test — you can destroy your own robot, and there is exactly one
 * raycast for everybody.
 *
 * NO PHYSICS COLLIDERS
 * --------------------
 * Same reasoning as `RemotePlayers`: creating and destroying a Rapier body per
 * drone per snapshot is pure churn, and the collider would lag the interpolated
 * visual anyway, so the shot would not match what the shooter saw. The pilot's
 * own drone does have a collider, but that one exists to bump into walls and is
 * tagged PLAYER precisely so no bullet raycast ever consults it.
 */

import * as THREE from 'three';
import { DRONE } from '../net/protocol.js';

/**
 * Hull and track colours. Deliberately dark and matte: the drone's job is to
 * see without being seen, and a bright chassis would give the whole thing away
 * from across a room.
 */
const HULL_COLOR = 0x3d444b;
const TRACK_COLOR = 0x1b1e21;

/**
 * The lens, which is the one part that IS meant to be seen.
 *
 * A drone with no self-lit part is invisible in an unlit interior, and a robot
 * that cannot be spotted is a free permanent sensor rather than a gadget with a
 * counter-play. Two colours because knowing whether the thing under the table is
 * yours decides whether you shoot it.
 */
const EYE_OWN = 0x66e0ff;
const EYE_OTHER = 0xffb14a;

/** How long the white hit flash takes to fade, in seconds. */
const FLASH_FADE = 0.18;

/** Radius of the destruction blast. Small — it is a footstool, not a car. */
const EXPLODE_RADIUS = 1.4;

/**
 * A ray against one drone's oriented hit box.
 *
 * Pure arithmetic on plain numbers, exported on its own so `test/drone-raycast`
 * can hammer it with no scene, no renderer and no engine. The box is ORIENTED —
 * `DRONE.hitHalf` is in the chassis' own axes, because a robot broadside is a
 * much wider target than one facing you and an axis-aligned box would make that
 * depend on which way the room happens to be built.
 *
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} dir  normalised
 * @param {{x:number,y:number,z:number,yaw:number}} drone  centre and heading
 * @param {number} maxDist
 * @returns {number|null} distance along `dir`, or null for a miss
 */
export function rayDroneBox(origin, dir, drone, maxDist) {
  const ox = origin?.x, oy = origin?.y, oz = origin?.z;
  const dx = dir?.x, dy = dir?.y, dz = dir?.z;
  const cx = drone?.x, cy = drone?.y, cz = drone?.z;
  const yaw = drone?.yaw;
  /*
   * Everything is checked before any of it is used, because this runs on
   * numbers that arrived over a socket. A NaN here would not throw: it would
   * make every comparison below false, `tmin` would stay NaN, and the test
   * would silently answer "miss" for a drone standing in front of the muzzle —
   * a robot nobody in the room can shoot, with nothing logged.
   */
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)
    || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)
    || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    || !Number.isFinite(yaw) || !Number.isFinite(maxDist) || maxDist <= 0) {
    return null;
  }

  // Into the chassis' own frame. Yaw 0 faces -Z, matching `stepDroneMotion` and
  // the mesh's `rotation.y`, so local -Z is the nose and local +X is its right.
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const wx = ox - cx;
  const wz = oz - cz;
  const px = cos * wx - sin * wz;
  const py = oy - cy;
  const pz = sin * wx + cos * wz;
  const vx = cos * dx - sin * dz;
  const vy = dy;
  const vz = sin * dx + cos * dz;

  const half = DRONE.hitHalf;
  let tmin = 0;
  let tmax = maxDist;

  // The slab test, one axis at a time. `slab` narrows [tmin, tmax] and returns
  // false the moment the interval closes.
  const slab = (p, v, h) => {
    if (Math.abs(v) < 1e-9) return p >= -h && p <= h;   // parallel: in or out
    const t1 = (-h - p) / v;
    const t2 = (h - p) / v;
    const lo = t1 < t2 ? t1 : t2;
    const hi = t1 < t2 ? t2 : t1;
    if (lo > tmin) tmin = lo;
    if (hi < tmax) tmax = hi;
    return tmin <= tmax;
  };

  if (!slab(px, vx, half[0])) return null;
  if (!slab(py, vy, half[1])) return null;
  if (!slab(pz, vz, half[2])) return null;

  /*
   * `tmin` starts at 0 rather than -Infinity, so a ray whose origin is INSIDE
   * the box answers 0 rather than a negative distance. That is the honest
   * answer — the muzzle is touching it — and it is the one the caller can use:
   * a negative distance compares as nearer than every real hit and would win
   * every "which did I hit first" contest for the rest of the frame.
   */
  return tmin;
}

export class DroneObjects {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {() => (Map<number, object>|null)} opts.sampleSource
   *   Where to read the interpolated drone sample from. A FUNCTION, never the
   *   Map itself: `Game._netDroneSample` is cleared and refilled every frame, so
   *   a held reference would be emptied under this class between the frame it
   *   was taken and the frame it was read. That is the same reason
   *   `FlagObjects` takes its sample source as a closure.
   * @param {import('../fx/ParticleManager.js').ParticleManager} [opts.fx]
   *   Optional so this class works headless — `test/drone-raycast.mjs`
   *   constructs it with neither a real scene nor an FX manager.
   */
  constructor({ scene, sampleSource, fx = null }) {
    this.scene = scene;
    this.sampleSource = sampleSource;
    this.fx = fx;

    /** @type {Map<number, object>} droneId -> chassis record */
    this.chassis = new Map();

    /**
     * Whose chassis not to draw, because the camera is inside it.
     *
     * Set to the local player's id while they are piloting and cleared the
     * moment they are not — the `RemotePlayers.headlessId` precedent, and
     * cleared on the same line that stops the flight for the same reason: a
     * drone that stays hidden after the pilot has surfaced is an invisible robot
     * that everyone else can see and shoot.
     *
     * Read ONLY by `sync`. `raycast` ignores it deliberately, so the pilot can
     * destroy their own drone and so there is one hit path for everybody.
     */
    this.hiddenOwnerId = null;

    /** Whose drone gets the friendly lens colour. Set by Game from `net.selfId`. */
    this.selfId = null;

    // Shared across every chassis — a drone is nine meshes, and per-drone
    // geometry would be nine BufferGeometries per robot for nine identical
    // shapes. Materials stay per-chassis, because each one needs its own hit
    // flash and its own lens colour.
    this.geo = null;

    this._tmp = new THREE.Vector3();
  }

  // ==================================================================== draw
  /**
   * Bring the chassis in the world into line with the newest sample.
   *
   * Membership of the sample is the ONLY thing that creates or destroys a
   * chassis — the `RemotePlayers.sync` pattern, and for a stronger reason here:
   * the snapshot's `d` array is the only channel the server expresses a drone's
   * existence through, so a chassis built from anything else would be one the
   * server does not think is there.
   *
   * @param {number} dt frame delta, for the hit flash
   */
  sync(dt) {
    const sample = this.sampleSource?.() ?? null;

    for (const [id, c] of this.chassis) {
      if (!sample?.has(id)) {
        this._destroy(c);
        this.chassis.delete(id);
      }
    }
    if (!sample) return;

    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;

    for (const [id, s] of sample) {
      let c = this.chassis.get(id);
      if (!c) {
        c = this._create(id, s.ownerId);
        this.chassis.set(id, c);
      }

      c.group.visible = s.ownerId !== this.hiddenOwnerId;
      c.group.position.set(s.x, s.y, s.z);
      c.group.rotation.y = s.yaw;

      /*
       * The lens colour is settled HERE rather than at creation, and only on a
       * change — the `RemotePlayers` team-tint idiom, for the same reason plus
       * one. `selfId` is assigned by Game once the server welcomes us, and a
       * colour baked in at creation would be whatever `selfId` happened to be
       * then; a reconnect that rebuilds the sample before the welcome lands
       * would leave the pilot's own drone lit as an enemy's for its whole life.
       */
      const own = s.ownerId === this.selfId;
      if (own !== c.own) {
        c.own = own;
        c.mats.eye.emissive.setHex(own ? EYE_OWN : EYE_OTHER);
      }

      if (c.flash > 0) {
        c.flash = Math.max(0, c.flash - step / FLASH_FADE);
        // The hull glows rather than changing colour: a matte dark chassis has
        // almost no diffuse response in a dark interior, so tinting it red
        // would have been a hit marker only the well-lit half of the map got.
        c.mats.hull.emissiveIntensity = c.flash * 1.6;
      }
    }
  }

  /** Somebody's round landed on this drone. */
  flash(droneId) {
    const c = this.chassis.get(droneId);
    if (c) c.flash = 1;
  }

  /**
   * It has been destroyed. Purely presentation — the chassis itself goes when
   * its row leaves the sample, which is the server's word rather than this one.
   */
  explode(position) {
    if (!position || !this.fx) return;
    this._tmp.set(position.x ?? position[0], position.y ?? position[1], position.z ?? position[2]);
    if (!Number.isFinite(this._tmp.x) || !Number.isFinite(this._tmp.y)
      || !Number.isFinite(this._tmp.z)) return;
    this.fx.spawnExplosion(this._tmp, EXPLODE_RADIUS);
  }

  // ================================================================ hit test
  /**
   * The nearest drone on this ray, for hit registration.
   *
   * Tests EVERY row without exception — including the local player's own drone,
   * and including one that `sync` is currently hiding. Adding a `selfId` skip
   * here is the one change that would quietly break the whole design: the pilot
   * would be the only person in the match who could not shoot a drone they were
   * looking straight at, and nothing would say so.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir     normalised
   * @param {number} maxDist        usually the distance to the nearest wall
   * @returns {{id:number, kind:string, part:string, distance:number,
   *            point:THREE.Vector3}|null}
   */
  raycast(origin, dir, maxDist) {
    const sample = this.sampleSource?.() ?? null;
    if (!sample) return null;

    let bestId = null;
    let bestT = Infinity;
    for (const [id, s] of sample) {
      const t = rayDroneBox(origin, dir, s, maxDist);
      if (t === null || t >= bestT) continue;
      bestT = t;
      bestId = id;
    }
    if (bestId === null) return null;

    return {
      id: bestId,
      kind: 'drone',
      // A drone has no head, and the server forces this to 'torso' for one
      // anyway — see `handleShot`. Claiming anything else would be overruled
      // silently, leaving the hitmarker as the only thing that lied.
      part: 'torso',
      distance: bestT,
      point: this._tmp.copy(dir).multiplyScalar(bestT).add(origin).clone(),
    };
  }

  // ================================================================ chassis
  /**
   * A small tracked robot, procedural.
   *
   * Procedural rather than authored on purpose: the whole feature would
   * otherwise be waiting on a .glb, and a drone that fails to load is one that
   * cannot be seen or shot while remaining perfectly able to see.
   */
  _create(id, ownerId) {
    if (!this.geo) this.geo = buildDroneGeometry();
    const g = this.geo;

    const mats = {
      hull: new THREE.MeshStandardMaterial({
        color: HULL_COLOR, roughness: 0.62, metalness: 0.55,
        emissive: 0xff3020, emissiveIntensity: 0,
      }),
      track: new THREE.MeshStandardMaterial({
        color: TRACK_COLOR, roughness: 0.95, metalness: 0.1,
      }),
      eye: new THREE.MeshStandardMaterial({
        color: 0x101418,
        emissive: ownerId === this.selfId ? EYE_OWN : EYE_OTHER,
        emissiveIntensity: 2.4,
        roughness: 0.3, metalness: 0,
      }),
    };

    const group = new THREE.Group();
    const add = (geometry, material, x, y, z) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.castShadow = true;
      group.add(m);
      return m;
    };

    /*
     * Everything is placed around the drone's REPORTED position, which is the
     * centre of its capsule — so the mesh, the capsule and the hit box all share
     * an origin. Offsetting the mesh to "sit on the floor" instead would put the
     * thing you see a few centimetres from the thing you shoot at, which is the
     * kind of miss nobody ever manages to describe.
     */
    add(g.track, mats.track, -0.16, -0.135, 0);
    add(g.track, mats.track, 0.16, -0.135, 0);
    add(g.hull, mats.hull, 0, -0.02, 0);
    add(g.deck, mats.hull, 0, 0.06, 0);
    add(g.mast, mats.hull, 0, 0.125, 0.02);
    /*
     * The sensor head sits at exactly `DRONE.camHeight`, because that is where
     * the feed is rendered from. Anyone looking at the robot can therefore read
     * what it can see off the thing itself, which is the only warning a player
     * gets that they are on somebody's screen.
     */
    add(g.head, mats.hull, 0, DRONE.camHeight, -0.02);
    add(g.eye, mats.eye, 0, DRONE.camHeight, -0.05).castShadow = false;

    this.scene?.add(group);
    return { id, ownerId, group, mats, flash: 0 };
  }

  _destroy(c) {
    this.scene?.remove(c.group);
    // Materials only. The geometry is shared by every chassis and belongs to
    // this instance — disposing it here would leave the next drone drawing from
    // buffers that have already been freed.
    for (const m of Object.values(c.mats)) m.dispose();
  }

  /** Take every chassis out at once — a map switch, or leaving the match. */
  clear() {
    for (const c of this.chassis.values()) this._destroy(c);
    this.chassis.clear();
  }

  dispose() {
    this.clear();
    if (this.geo) {
      for (const geometry of Object.values(this.geo)) geometry.dispose();
      this.geo = null;
    }
  }
}

/**
 * The nine shapes a drone is made of, built once per DroneObjects.
 *
 * Sized to `DRONE.hitHalf` rather than to taste: 0.40 m across the tracks and
 * 0.42 m nose to tail against a 0.40 x 0.48 box. The box is a shade longer on
 * purpose, so a shot that visibly clips the front of the chassis registers —
 * the other way round is a robot people miss while looking straight at it.
 */
function buildDroneGeometry() {
  return {
    track: new THREE.BoxGeometry(0.075, 0.12, 0.42),
    hull: new THREE.BoxGeometry(0.30, 0.11, 0.34),
    deck: new THREE.BoxGeometry(0.17, 0.05, 0.15),
    mast: new THREE.CylinderGeometry(0.014, 0.018, 0.12, 6),
    head: new THREE.BoxGeometry(0.09, 0.06, 0.06),
    eye: new THREE.SphereGeometry(0.026, 10, 8),
  };
}

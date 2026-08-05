/**
 * FlagObjects — the two flags, and the bases they belong on.
 *
 * WHAT IT DRAWS AND WHAT IT DOES NOT
 * ----------------------------------
 * Everything here is presentation. Where a flag IS, who has it and whether a
 * capture counted are decided entirely by the server; this renders whatever it
 * was last told and nothing else. There is deliberately no client-side "am I
 * close enough to pick it up" — that check exists on the server, and a second
 * copy here would eventually disagree with it and show a player taking a flag
 * they had not taken.
 *
 * A CARRIED FLAG HAS NO POSITION OF ITS OWN
 * -----------------------------------------
 * The server sends a flag's position when it changes hands, not every tick. A
 * carried flag would therefore be frozen wherever it was picked up — so a
 * carried flag is drawn on its CARRIER, read from the same interpolated sample
 * that draws the carrier's body. That also makes it correct for free: the flag
 * moves exactly as smoothly as the person holding it, because it is the same
 * number.
 */

import * as THREE from 'three';
import { TEAM, TEAM_COLOR, FLAG_STATE } from './modes.js';
import { baseSpot } from './arena.js';

/** How high the flag rides above a carrier's feet. Clear of the head. */
const CARRY_HEIGHT = 2.05;
/** Pole height when planted. */
const POLE_HEIGHT = 2.4;
/** How far the base marker throws light upward. */
const BEAM_HEIGHT = 15;
/**
 * Where the beam starts, in metres off the floor.
 *
 * Clear of the flag on purpose. A beam that reaches the ground is drawn ON TOP
 * of the thing it exists to point at — additive over a lit flag washes the
 * cloth out to white, so from any distance you could see the marker but not
 * whether the flag was still under it.
 */
const BEAM_BASE_Y = 3.1;

export class FlagObjects {
  /**
   * @param {THREE.Scene} scene
   * @param {() => (Map<number, object>|null)} sampleSource
   *   Where to read interpolated player positions from, for carried flags.
   *   A function rather than the Map itself because the Map is rebuilt every
   *   frame and a stale reference would freeze every carried flag in place.
   */
  constructor(scene, sampleSource) {
    this.scene = scene;
    this.sampleSource = sampleSource;
    /** @type {Map<number, object>} owning team -> { group, cloth, ... } */
    this.flags = new Map();
    /** @type {THREE.Object3D[]} base markers, rebuilt with the map */
    this.bases = [];
    this.selfId = null;
    this._t = 0;
  }

  /**
   * Build the two flags and their base markers for a map.
   *
   * @param {object} arena  the arena entry, NOT its `bases` — the height of a
   *   base is the base's own business now that they are not all on one floor,
   *   and `baseSpot` in arena.js is the single place that knows how to read it.
   *   Passing `bases` alone is what made every marker sit on the ground.
   * @param {number} beamHeight  how tall the marker column is, or 0 for none.
   *   INDOOR MAPS MUST PASS 0. The default assumes open sky above the base;
   *   inside a house the floor above is 3.3 m up, so a 15 m column spears
   *   straight through it and stands in the middle of an upstairs bedroom,
   *   marking a flag that is not in that room and cannot be reached from it.
   *   The ring and plinth on the floor are the marker indoors, and they are
   *   enough — you are never more than a room away from a base in a house.
   */
  build(arena, beamHeight = BEAM_HEIGHT) {
    this.dispose();
    if (!arena?.ctf?.bases) return;

    for (const team of [TEAM.RED, TEAM.BLUE]) {
      const spot = baseSpot(arena, team);
      if (!spot) continue;
      const colour = TEAM_COLOR[team];

      // --- the base: a ring on the floor and a low plinth --------------------
      const base = new THREE.Group();
      base.position.set(spot.x, spot.y - 1.05, spot.z);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.1, 2.5, 40),
        new THREE.MeshBasicMaterial({
          color: colour, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      base.add(ring);

      const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.7, 0.25, 16),
        new THREE.MeshStandardMaterial({
          color: colour, roughness: 0.45, metalness: 0.3,
          emissive: colour, emissiveIntensity: 0.25,
        }),
      );
      plinth.position.y = 0.12;
      base.add(plinth);

      /*
       * A tall, thin beam of light over each base.
       *
       * Unlit and additive, so it reads from across the map through fog and
       * around corners. In a mode whose entire objective is "get to that
       * place", being able to see where that place is from anywhere is not a
       * luxury — without it every new player spends the first match lost.
       *
       * The alpha is a VERTEX GRADIENT, strongest at the floor and gone by the
       * top. A constant-alpha additive column against a bright sky saturates
       * to white — it stopped reading as a red or blue marker, and it stood in
       * front of the flag it was supposed to be advertising. Fading it out
       * keeps the "look over there" signal and gives the top back to the sky.
       */
      const beamGeo = new THREE.CylinderGeometry(0.26, 0.5, beamHeight, 14, 6, true);
      const c = new THREE.Color(colour);
      const beamPos = beamGeo.attributes.position;
      const beamCol = new Float32Array(beamPos.count * 4);
      for (let i = 0; i < beamPos.count; i++) {
        // y runs -H/2..+H/2 on a cylinder, so this is 0 at the floor, 1 at the top.
        const up = beamPos.getY(i) / beamHeight + 0.5;
        beamCol[i * 4 + 0] = c.r;
        beamCol[i * 4 + 1] = c.g;
        beamCol[i * 4 + 2] = c.b;
        beamCol[i * 4 + 3] = 0.22 * Math.pow(1 - up, 1.8);
      }
      beamGeo.setAttribute('color', new THREE.BufferAttribute(beamCol, 4));

      const beam = new THREE.Mesh(
        beamGeo,
        new THREE.MeshBasicMaterial({
          vertexColors: true, transparent: true,
          side: THREE.DoubleSide, depthWrite: false,
          blending: THREE.AdditiveBlending, toneMapped: false,
        }),
      );
      beam.position.y = BEAM_BASE_Y + beamHeight / 2;
      if (beamHeight > 0) base.add(beam);

      this.scene.add(base);
      this.bases.push(base);

      // --- the flag itself ---------------------------------------------------
      const group = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, POLE_HEIGHT, 8),
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.4, metalness: 0.6 }),
      );
      pole.position.y = POLE_HEIGHT / 2;
      group.add(pole);

      /*
       * The cloth is deliberately oversized and self-lit.
       *
       * A physically sensible flag is about 60 cm tall and, seen from the far
       * side of a 70 m arena in shadow, is a couple of dark pixels. This one is
       * the thing the entire mode is about, so it is scaled and given emissive
       * so it stays legible at range and indoors.
       */
      const cloth = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.95, 10, 1),
        new THREE.MeshStandardMaterial({
          color: colour, roughness: 0.85, metalness: 0,
          side: THREE.DoubleSide,
          emissive: colour, emissiveIntensity: 0.55,
        }),
      );
      cloth.position.set(0.78, POLE_HEIGHT - 0.58, 0);
      group.add(cloth);
      // Keep the base geometry so `dispose` can free it — the cloth is
      // deformed per frame and must not be shared between the two flags.
      group.userData.clothGeo = cloth.geometry;

      this.scene.add(group);
      this.flags.set(team, {
        team, group, cloth, pole,
        state: FLAG_STATE.AT_BASE,
        carrier: null,
        home: new THREE.Vector3(spot.x, spot.y - 1.05, spot.z),
        at: new THREE.Vector3(spot.x, spot.y - 1.05, spot.z),
        /** Scratch, handed to the HUD each frame by `markers()`. */
        mark: new THREE.Vector3(),
      });
    }
  }

  /** Adopt the server's report. Called on every MSG.FLAG. */
  apply(flagStates) {
    for (const s of flagStates ?? []) {
      const f = this.flags.get(s.t);
      if (!f) continue;
      f.state = s.s;
      f.carrier = s.c ?? null;
      f.at.set(s.x, s.y - 1.05, s.z);
    }
  }

  /**
   * Which flags deserve an on-screen marker, and where they are right now.
   *
   * ONLY CARRIED AND DROPPED FLAGS. A flag on its own stand is not marked: it
   * is where it has been all match, both teams already know, and a permanent
   * pair of icons burnt into the HUD is clutter rather than information. The
   * two states worth interrupting someone for are "an enemy is running off
   * with it" and "it is lying somewhere on the floor".
   *
   * Our OWN carried flag is excluded too — the camera is inside the body
   * holding it, so the marker would sit in the middle of the crosshair. The
   * carrying banner says it instead.
   *
   * Read AFTER `update()`, because it returns the group's live position: for a
   * carried flag that is the interpolated position of whoever is holding it,
   * which is the whole point.
   */
  markers() {
    const out = [];
    for (const f of this.flags.values()) {
      if (!f.group.visible) continue;
      if (f.state === FLAG_STATE.AT_BASE) continue;
      if (f.state === FLAG_STATE.CARRIED && f.carrier === this.selfId) continue;
      out.push({
        team: f.team,
        state: f.state,
        carrier: f.state === FLAG_STATE.CARRIED ? f.carrier : null,
        // Chest height rather than the group's origin, which is down at the
        // carrier's feet — a marker at ankle level reads as being behind them.
        pos: f.mark.set(f.group.position.x, f.group.position.y + 0.7,
          f.group.position.z),
      });
    }
    return out;
  }

  /**
   * Place and animate both flags.
   *
   * @param {number} dt
   */
  update(dt) {
    this._t += dt;
    const sample = this.sampleSource?.() ?? null;

    for (const f of this.flags.values()) {
      let x = f.at.x, y = f.at.y, z = f.at.z;
      let carried = false;

      if (f.state === FLAG_STATE.CARRIED && f.carrier != null) {
        if (f.carrier === this.selfId) {
          /*
           * Our own carried flag is not drawn.
           *
           * It would be a pole through the middle of the screen, since the
           * camera is inside the body holding it. The HUD says we have it
           * instead — see UIManager.
           */
          f.group.visible = false;
          continue;
        }
        const p = sample?.get(f.carrier);
        if (p) {
          x = p.x; y = p.y - 1.05 + CARRY_HEIGHT - POLE_HEIGHT / 2; z = p.z;
          carried = true;
        } else {
          // The carrier is not in the sample this frame — they have just left,
          // or dropped out of the interpolation buffer. Hide rather than draw
          // the flag at a stale position, which would read as a second flag.
          f.group.visible = false;
          continue;
        }
      }

      f.group.visible = true;
      f.group.position.set(x, y, z);

      // A dropped flag lies at an angle, so it reads differently from one on
      // its stand at a glance.
      f.group.rotation.z = f.state === FLAG_STATE.DROPPED ? 1.15 : 0;
      // Carried flags stream backwards; planted ones turn slowly so they are
      // never edge-on and invisible.
      f.group.rotation.y = carried ? f.group.rotation.y : this._t * 0.5;

      // Cheap cloth: a travelling wave along the free edge.
      const pos = f.cloth.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i);
        const k = (px + 0.75) / 1.5;       // 0 at the pole, 1 at the free edge
        pos.setZ(i, Math.sin(this._t * 6 + k * 5) * 0.13 * k);
      }
      pos.needsUpdate = true;
    }
  }

  /** True when this player is carrying a flag, for the HUD. */
  carriedBy(playerId) {
    for (const f of this.flags.values()) {
      if (f.state === FLAG_STATE.CARRIED && f.carrier === playerId) return f.team;
    }
    return null;
  }

  dispose() {
    for (const f of this.flags.values()) {
      this.scene.remove(f.group);
      f.group.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); }
      });
    }
    this.flags.clear();
    for (const b of this.bases) {
      this.scene.remove(b);
      b.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); }
      });
    }
    this.bases.length = 0;
  }
}

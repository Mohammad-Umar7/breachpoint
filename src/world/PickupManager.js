/**
 * PickupManager — health, armour and ammunition pickups.
 *
 * Pickups are placed by the level and respawn on a timer after collection.
 *
 * Pickups are plain meshes (no physics bodies) collected by a simple distance
 * check, which is cheaper and far more reliable than sensor colliders for
 * something the player brushes past at 8 m/s.
 */

import * as THREE from 'three';
import { randRange } from '../core/MathUtils.js';

const PICKUP_RADIUS = 1.35;
const RESPAWN_DELAY = 26;

const TYPES = {
  health: { material: 'pickupHealth', amount: 35, sound: 'pickupHealth', label: '+35 HEALTH', toastClass: '' },
  armor: { material: 'pickupArmor', amount: 50, sound: 'pickupArmor', label: '+50 ARMOUR', toastClass: '' },
  ammo: { material: 'pickupAmmo', amount: 0.35, sound: 'pickupAmmo', label: 'AMMO RESUPPLY', toastClass: 'ammo' },
};

export class PickupManager {
  constructor({ scene, assets, audio, player, weaponSystem }) {
    this.scene = scene;
    this.assets = assets;
    this.audio = audio;
    this.player = player;
    this.weapons = weaponSystem;

    this.group = new THREE.Group();
    this.group.name = 'pickups';
    scene.add(this.group);

    // Shared geometry — one allocation for every pickup in the game.
    this.geoHealth = new THREE.BoxGeometry(0.42, 0.3, 0.28);
    this.geoAmmo = new THREE.BoxGeometry(0.46, 0.26, 0.32);
    this.geoArmor = new THREE.OctahedronGeometry(0.28, 0);
    this.geoCross = new THREE.BoxGeometry(0.1, 0.22, 0.02);
    this.glowGeo = new THREE.PlaneGeometry(1.1, 1.1);
    this.glowMat = new THREE.MeshBasicMaterial({
      map: assets.getTexture('glow'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.45,
      toneMapped: false,
    });

    /** @type {Array} */
    this.pickups = [];
    this.time = 0;

    this.onCollect = null; // (type, amount) => void
  }

  // ------------------------------------------------------------------ build
  buildFromLevel(level) {
    for (const spot of level.pickupSpots) {
      this._create(spot.type, spot.pos);
    }
  }

  _create(type, position) {
    const def = TYPES[type];
    if (!def) {
      console.warn(`[Pickups] Unknown pickup type "${type}"`);
      return null;
    }

    const holder = new THREE.Group();
    holder.position.copy(position);

    const mat = this.assets.getMaterial(def.material);
    let geo;
    if (type === 'health') geo = this.geoHealth;
    else if (type === 'ammo') geo = this.geoAmmo;
    else geo = this.geoArmor;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    holder.add(mesh);

    // A white cross / stripe detail so types read at a glance.
    if (type === 'health') {
      const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const a = new THREE.Mesh(this.geoCross, white);
      a.position.z = 0.15;
      const b = new THREE.Mesh(this.geoCross, white);
      b.position.z = 0.15;
      b.rotation.z = Math.PI / 2;
      holder.add(a, b);
      holder.userData.extraMaterials = [white];
    }

    const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
    glow.renderOrder = 5;
    holder.add(glow);

    this.group.add(holder);

    const entry = {
      type,
      def,
      holder,
      glow,
      basePos: position.clone(),
      active: true,
      respawnTimer: 0,
      phase: randRange(0, Math.PI * 2),
    };
    this.pickups.push(entry);
    return entry;
  }

  // ================================================================= update
  update(dt, camera) {
    this.time += dt;
    const playerPos = this.player.position;

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];

      // --- respawn ---
      if (!p.active) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) {
          p.active = true;
          p.holder.visible = true;
        }
        continue;
      }

      // --- idle animation ---
      p.holder.rotation.y += dt * 1.5;
      p.holder.position.y = p.basePos.y + Math.sin(this.time * 2.2 + p.phase) * 0.09;
      p.glow.quaternion.copy(camera.quaternion);
      p.glow.material.opacity = 0.32 + Math.sin(this.time * 3 + p.phase) * 0.1;

      // --- collection ---
      const dx = p.holder.position.x - playerPos.x;
      const dy = p.holder.position.y - playerPos.y;
      const dz = p.holder.position.z - playerPos.z;
      if (dx * dx + dy * dy + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
        if (this._tryCollect(p)) {
          p.active = false;
          p.holder.visible = false;
          p.respawnTimer = RESPAWN_DELAY;
        }
      }
    }
  }

  /** @returns {boolean} true when the pickup was actually consumed */
  _tryCollect(p) {
    const player = this.player;
    let label = p.def.label;
    // How much was ACTUALLY gained, which is not the pack's nominal value when
    // the player was nearly topped up. Passed to onCollect so a match can tell
    // the server the real figure.
    let gainedAmount = 0;

    switch (p.type) {
      case 'health': {
        if (player.health >= player.maxHealth) return false;
        const gained = player.heal(p.def.amount);
        gainedAmount = gained;
        label = `+${Math.round(gained)} HEALTH`;
        break;
      }
      case 'armor': {
        if (player.armor >= player.maxArmor) return false;
        const gained = player.addArmor(p.def.amount);
        gainedAmount = gained;
        label = `+${Math.round(gained)} ARMOUR`;
        break;
      }
      case 'ammo': {
        if (!this.weapons.needsAmmo()) return false;
        const added = this.weapons.addAmmo(p.def.amount);
        if (added <= 0) return false;
        gainedAmount = added;
        label = `+${added} ROUNDS`;
        break;
      }
      default:
        return false;
    }

    this.audio.play(p.def.sound);
    // `gained` is passed on so a match can tell the server what was actually
    // collected rather than the pack's nominal value.
    this.onCollect?.(p.type, label, p.def.toastClass, gainedAmount);
    return true;
  }

  _destroy(index) {
    const p = this.pickups[index];
    this.group.remove(p.holder);
    for (const m of p.holder.userData.extraMaterials ?? []) m.dispose();
    this.pickups.splice(index, 1);
  }

  /** Restore every pickup (used on restart). */
  reset() {
    for (const p of this.pickups) {
      p.active = true;
      p.holder.visible = true;
      p.respawnTimer = 0;
    }
  }

  dispose() {
    for (let i = this.pickups.length - 1; i >= 0; i--) this._destroy(i);
    this.scene.remove(this.group);
    this.geoHealth.dispose();
    this.geoAmmo.dispose();
    this.geoArmor.dispose();
    this.geoCross.dispose();
    this.glowGeo.dispose();
    this.glowMat.dispose();
  }
}

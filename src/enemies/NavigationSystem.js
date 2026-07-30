/**
 * NavigationSystem — pathfinding and tactical position queries for the AI.
 *
 * The level ships a hand-placed waypoint graph where every edge is a verified
 * clear straight line. This system turns that into:
 *
 *   - **A\*** shortest paths (distance-weighted, unlike a plain BFS).
 *   - **Cover queries**: the nearest position that genuinely breaks line of
 *     sight from a threat, with reservation so two soldiers never pile into
 *     the same doorway.
 *   - **Flank queries**: a route node well off the threat's current facing,
 *     used when a squadmate is already engaging from the front.
 *   - **Crowding checks**: soldiers actively spread out instead of clumping.
 *
 * Paths are also smoothed: if a later node is directly visible, the
 * intermediate ones are skipped, so soldiers cut corners like people rather
 * than tracing the graph node by node.
 */

import * as THREE from 'three';
import { TAG_KIND } from '../physics/PhysicsWorld.js';

const EYE = 0.95;

export class NavigationSystem {
  /**
   * @param {import('../world/Level.js').Level} level
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   */
  constructor(level, physics) {
    this.level = level;
    this.physics = physics;

    const n = level.waypoints.length;
    this._gScore = new Float32Array(n);
    this._fScore = new Float32Array(n);
    this._cameFrom = new Int16Array(n);
    this._closed = new Uint8Array(n);
    this._open = [];

    /** coverIndex -> enemy id that has claimed it. */
    this.coverClaims = new Map();
    /** Cached "is this cover point currently safe" results, refreshed lazily. */
    this._coverCheckIndex = 0;

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  // ------------------------------------------------------------------ A*
  /**
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @returns {THREE.Vector3[]} waypoints then the destination, smoothed
   */
  findPath(from, to) {
    const wps = this.level.waypoints;
    const n = wps.length;
    if (n === 0) return [to.clone()];

    const start = this.level.nearestWaypoint(from);
    const goal = this.level.nearestWaypoint(to);
    if (start === goal) return this._smooth(from, [wps[goal].pos.clone(), to.clone()]);

    this._gScore.fill(Infinity);
    this._fScore.fill(Infinity);
    this._cameFrom.fill(-1);
    this._closed.fill(0);
    this._open.length = 0;

    this._gScore[start] = 0;
    this._fScore[start] = wps[start].pos.distanceTo(wps[goal].pos);
    this._open.push(start);

    let found = false;
    let guard = 0;
    while (this._open.length && guard++ < n * 4) {
      // Small graph: a linear scan for the lowest f is faster than a heap.
      let bestIdx = 0;
      for (let i = 1; i < this._open.length; i++) {
        if (this._fScore[this._open[i]] < this._fScore[this._open[bestIdx]]) bestIdx = i;
      }
      const current = this._open.splice(bestIdx, 1)[0];
      if (current === goal) { found = true; break; }
      this._closed[current] = 1;

      for (const next of wps[current].links) {
        if (next < 0 || next >= n || this._closed[next]) continue;
        const tentative = this._gScore[current] + wps[current].pos.distanceTo(wps[next].pos);
        if (tentative >= this._gScore[next]) continue;
        this._cameFrom[next] = current;
        this._gScore[next] = tentative;
        this._fScore[next] = tentative + wps[next].pos.distanceTo(wps[goal].pos);
        if (!this._open.includes(next)) this._open.push(next);
      }
    }

    if (!found) return [to.clone()];

    const path = [];
    let node = goal;
    let g2 = 0;
    while (node !== -1 && g2++ < n) {
      path.push(wps[node].pos.clone());
      if (node === start) break;
      node = this._cameFrom[node];
    }
    path.reverse();
    path.push(to.clone());
    return this._smooth(from, path);
  }

  /** Drop nodes we can already see past, so movement cuts corners naturally. */
  _smooth(from, path) {
    if (path.length <= 2) return path;
    this._a.copy(from);
    this._a.y += EYE;

    let i = 0;
    while (i < path.length - 1) {
      // Find the furthest node with a clear line from the current position.
      let furthest = i;
      for (let j = path.length - 1; j > i; j--) {
        this._b.copy(path[j]);
        this._b.y += EYE;
        if (this.physics.hasLineOfSight(this._a, this._b)) { furthest = j; break; }
      }
      if (furthest > i + 1) path.splice(i + 1, furthest - i - 1);
      break; // one pass from the start is enough and keeps this cheap
    }
    return path;
  }

  // --------------------------------------------------------------- cover
  /**
   * Find a cover position that actually blocks line of sight from `threat`.
   *
   * @param {THREE.Vector3} from      the soldier's position
   * @param {THREE.Vector3} threat    the position to hide from
   * @param {object} opts
   * @param {number} [opts.maxRange]
   * @param {number} [opts.minRange]
   * @param {string} [opts.claimant]  id used to reserve the spot
   * @param {boolean} [opts.preferForward] bias toward cover nearer the threat
   * @returns {{point:THREE.Vector3, index:number}|null}
   */
  findCover(from, threat, opts = {}) {
    const {
      maxRange = 24,
      minRange = 1.0,
      claimant = null,
      preferForward = false,
    } = opts;

    const points = this.level.coverPoints;
    this._b.copy(threat);
    this._b.y += EYE;

    let best = null;
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const d = from.distanceTo(p);
      if (d > maxRange || d < minRange) continue;

      // Already taken by a squadmate?
      const owner = this.coverClaims.get(i);
      if (owner && owner !== claimant) continue;

      this._a.copy(p);
      this._a.y += EYE;
      if (this.physics.hasLineOfSight(this._a, this._b)) continue; // exposed

      const threatDist = p.distanceTo(threat);
      // Cheap to reach, and either close to the fight or far from it.
      let score = d;
      score += preferForward ? threatDist * 0.35 : -threatDist * 0.12;
      // Discourage cover that is basically on top of the threat.
      if (threatDist < 4) score += 30;

      if (score < bestScore) {
        bestScore = score;
        best = p;
        bestIndex = i;
      }
    }

    if (best && claimant !== null) this.claimCover(bestIndex, claimant);
    return best ? { point: best, index: bestIndex } : null;
  }

  claimCover(index, claimant) {
    if (index < 0) return;
    this.coverClaims.set(index, claimant);
  }

  releaseCover(claimant) {
    for (const [idx, owner] of this.coverClaims) {
      if (owner === claimant) this.coverClaims.delete(idx);
    }
  }

  clearClaims() {
    this.coverClaims.clear();
  }

  // --------------------------------------------------------------- flank
  /**
   * A waypoint that approaches the threat from well off its current facing.
   *
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} threat
   * @param {number} threatYaw   the direction the threat is looking
   * @param {number} side        -1 = left, +1 = right
   */
  findFlankPosition(from, threat, threatYaw, side) {
    const wps = this.level.waypoints;
    // The threat's forward and right vectors.
    const fx = -Math.sin(threatYaw);
    const fz = -Math.cos(threatYaw);
    const rx = Math.cos(threatYaw);
    const rz = -Math.sin(threatYaw);

    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < wps.length; i++) {
      const p = wps[i].pos;
      const dx = p.x - threat.x;
      const dz = p.z - threat.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 7 || dist > 30) continue;

      const nx = dx / dist;
      const nz = dz / dist;
      const forwardDot = nx * fx + nz * fz;     // +1 = in front of the threat
      const rightDot = nx * rx + nz * rz;       // +1 = to the threat's right

      // Want: well to the chosen side, and not straight ahead of them.
      let score = rightDot * side * 2.2 - Math.max(0, forwardDot) * 1.6;
      // Prefer positions we don't have to cross the whole map to reach.
      score -= from.distanceTo(p) * 0.045;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /**
   * A position near the threat's last known spot to sweep during a search.
   */
  findSearchPoint(around, radius, avoid = null) {
    const wps = this.level.waypoints;
    const candidates = [];
    for (const wp of wps) {
      const d = wp.pos.distanceTo(around);
      if (d <= radius && (!avoid || wp.pos.distanceTo(avoid) > 4)) candidates.push(wp.pos);
    }
    if (!candidates.length) return null;
    return candidates[(Math.random() * candidates.length) | 0];
  }

  // ------------------------------------------------------------ crowding
  /**
   * True when `pos` is uncomfortably close to another squadmate — used to
   * make soldiers spread out rather than bunch up in a doorway.
   */
  isCrowded(pos, others, self, radius = 3.0) {
    const r2 = radius * radius;
    for (const o of others) {
      if (o === self || !o.active || !o.alive) continue;
      if (o.position.distanceToSquared(pos) < r2) return true;
    }
    return false;
  }

  /** A short sidestep away from the nearest squadmate. */
  spreadVector(out, self, others, radius = 2.6) {
    out.set(0, 0, 0);
    let count = 0;
    for (const o of others) {
      if (o === self || !o.active || !o.alive) continue;
      const d = self.position.distanceTo(o.position);
      if (d > radius || d < 0.001) continue;
      out.x += (self.position.x - o.position.x) / d;
      out.z += (self.position.z - o.position.z) / d;
      count++;
    }
    if (count > 0) out.multiplyScalar(1 / count);
    return out;
  }

  /**
   * Is a squadmate standing in this soldier's line of fire?
   * Enemies hold fire rather than shooting each other in the back.
   */
  friendlyInLine(from, to, others, self, radius = 0.55) {
    this._dir.subVectors(to, from);
    const len = this._dir.length();
    if (len < 0.01) return false;
    this._dir.divideScalar(len);

    for (const o of others) {
      if (o === self || !o.active || !o.alive) continue;
      this._a.subVectors(o.position, from);
      const along = this._a.dot(this._dir);
      if (along <= 0.5 || along >= len) continue;
      // Perpendicular distance from the line.
      this._b.copy(this._dir).multiplyScalar(along).add(from);
      if (this._b.distanceTo(o.position) < radius) return true;
    }
    return false;
  }
}

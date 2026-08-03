/**
 * ParticleManager — every transient visual effect in the game.
 *
 * Everything here is **pooled** and drawn with `InstancedMesh`, so firing a
 * 900 RPM rifle for a minute allocates nothing and costs a handful of draw
 * calls. Each system is a flat array of structs updated with plain maths;
 * dead entries are swapped to the end and their instance is scaled to zero.
 *
 * Systems
 *   sparks      additive billboards        muzzle sparks, ricochets
 *   smoke       alpha billboards           dust puffs, explosion smoke
 *   debris      lit instanced cubes        concrete/wood chunks
 *   tracers     additive stretched quads   bullet trails
 *   shells      lit instanced cylinders    ejected casings (bounce physics)
 *   decals      alpha quads (ring buffer)  bullet holes + blood
 *   flashes     additive quads + lights    muzzle flashes, explosions
 *   dust        THREE.Points               ambient atmosphere motes
 */

import * as THREE from 'three';
import { SURFACE } from '../core/AssetManager.js';
import { randRange, randSign, clamp } from '../core/MathUtils.js';

/* ---------------------------------------------------------------- shaders */

const BILLBOARD_VERT = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const BILLBOARD_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D( uMap, vUv );
    gl_FragColor = vec4( vColor * tex.rgb, tex.a * vAlpha );
    if ( gl_FragColor.a < 0.003 ) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Builds an instanced billboard system with per-instance colour + alpha. */
function makeBillboardSystem(count, texture, blending) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: texture } },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: BILLBOARD_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false; // instances move every frame; culling by the
                              // shared bounding sphere would be wrong.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 10;
  return mesh;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class ParticleManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../core/AssetManager.js').AssetManager} assets
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(scene, assets, settings) {
    this.scene = scene;
    this.assets = assets;
    this.settings = settings;
    this.density = settings.get('particleDensity');
    settings.onChange('particleDensity', (v) => (this.density = v));

    // Scratch objects reused every frame — zero allocation in the hot path.
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._c = new THREE.Color();
    this._basis = new THREE.Matrix4();
    // Scratch for keeping a decal glued to a body that moves. See addDecal.
    this._bodyMat = new THREE.Matrix4();
    this._bodyQuat = new THREE.Quaternion();
    this._unitScale = new THREE.Vector3(1, 1, 1);
    this._impactBody = null;

    this._buildSparks();
    this._buildSmoke();
    this._buildDebris();
    this._buildTracers();
    this._buildShells();
    this._buildDecals();
    this._buildFlashes();
    this._buildAmbientDust();
  }

  // ================================================================ sparks
  _buildSparks() {
    this.SPARK_MAX = 640;
    this.sparkMesh = makeBillboardSystem(this.SPARK_MAX, this.assets.getTexture('spark'), THREE.AdditiveBlending);
    this.scene.add(this.sparkMesh);
    this.sparks = [];
    for (let i = 0; i < this.SPARK_MAX; i++) {
      this.sparks.push({
        alive: false, idx: i,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 0.05, drag: 2.4, gravity: -14,
        color: new THREE.Color(1, 1, 1), bounce: 0,
      });
      this.sparkMesh.setMatrixAt(i, HIDDEN);
    }
    this.sparkCount = 0;
  }

  /** @returns {object|null} a free spark, recycling the oldest if needed */
  _getSpark() {
    if (this.sparkCount < this.SPARK_MAX) return this.sparks[this.sparkCount++];
    // Recycle the oldest live particle (index 0 is the oldest survivor).
    return this.sparks[0];
  }

  // ================================================================= smoke
  _buildSmoke() {
    this.SMOKE_MAX = 260;
    this.smokeMesh = makeBillboardSystem(this.SMOKE_MAX, this.assets.getTexture('smoke'), THREE.NormalBlending);
    this.smokeMesh.renderOrder = 9;
    this.scene.add(this.smokeMesh);
    this.smokes = [];
    for (let i = 0; i < this.SMOKE_MAX; i++) {
      this.smokes.push({
        alive: false, idx: i,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 0.5, growth: 0.8, roll: 0, spin: 0,
        color: new THREE.Color(1, 1, 1), peakAlpha: 0.5,
      });
      this.smokeMesh.setMatrixAt(i, HIDDEN);
    }
    this.smokeCount = 0;
  }

  _getSmoke() {
    if (this.smokeCount < this.SMOKE_MAX) return this.smokes[this.smokeCount++];
    return this.smokes[0];
  }

  // ================================================================ debris
  _buildDebris() {
    this.DEBRIS_MAX = 240;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.05 });
    this.debrisMesh = new THREE.InstancedMesh(geo, mat, this.DEBRIS_MAX);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = false;
    this.debrisMesh.receiveShadow = false;
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.DEBRIS_MAX * 3).fill(1), 3
    );
    this.scene.add(this.debrisMesh);

    this.debris = [];
    for (let i = 0; i < this.DEBRIS_MAX; i++) {
      this.debris.push({
        alive: false, idx: i,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Euler(), spin: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 0.05,
      });
      this.debrisMesh.setMatrixAt(i, HIDDEN);
    }
    this.debrisCount = 0;
  }

  _getDebris() {
    if (this.debrisCount < this.DEBRIS_MAX) return this.debris[this.debrisCount++];
    return this.debris[0];
  }

  // =============================================================== tracers
  _buildTracers() {
    this.TRACER_MAX = 96;
    this.tracerMesh = makeBillboardSystem(this.TRACER_MAX, this.assets.getTexture('spark'), THREE.AdditiveBlending);
    this.tracerMesh.renderOrder = 11;
    this.scene.add(this.tracerMesh);
    this.tracers = [];
    for (let i = 0; i < this.TRACER_MAX; i++) {
      this.tracers.push({
        alive: false, idx: i,
        start: new THREE.Vector3(), end: new THREE.Vector3(),
        head: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
        total: 0, travelled: 0, speed: 340, width: 0.05,
        life: 0, maxLife: 0.12, color: new THREE.Color(1, 0.86, 0.55),
        trail: 6,
      });
      this.tracerMesh.setMatrixAt(i, HIDDEN);
    }
    this.tracerCount = 0;
  }

  _getTracer() {
    if (this.tracerCount < this.TRACER_MAX) return this.tracers[this.tracerCount++];
    return this.tracers[0];
  }

  // ================================================================ shells
  _buildShells() {
    this.SHELL_MAX = 72;
    const geo = new THREE.CylinderGeometry(0.011, 0.012, 0.045, 6, 1);
    geo.rotateZ(Math.PI / 2); // lie along local X so it tumbles nicely
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8a441, roughness: 0.35, metalness: 0.95 });
    this.shellMesh = new THREE.InstancedMesh(geo, mat, this.SHELL_MAX);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
    this.scene.add(this.shellMesh);

    this.shells = [];
    for (let i = 0; i < this.SHELL_MAX; i++) {
      this.shells.push({
        alive: false, idx: i,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Euler(), spin: new THREE.Vector3(),
        life: 0, maxLife: 6, groundY: 0, bounces: 0, scale: 1,
      });
      this.shellMesh.setMatrixAt(i, HIDDEN);
    }
    this.shellCount = 0;
  }

  _getShell() {
    if (this.shellCount < this.SHELL_MAX) return this.shells[this.shellCount++];
    return this.shells[0];
  }

  // ================================================================ decals
  _buildDecals() {
    this.DECAL_MAX = 180;
    this.decalMesh = makeBillboardSystem(this.DECAL_MAX, this.assets.getTexture('bulletHole'), THREE.NormalBlending);
    this.decalMesh.renderOrder = 2;
    this.decalMesh.material.depthWrite = false;
    // Polygon offset stops z-fighting with the surface the decal sits on.
    this.decalMesh.material.polygonOffset = true;
    this.decalMesh.material.polygonOffsetFactor = -4;
    this.decalMesh.material.polygonOffsetUnits = -4;
    this.scene.add(this.decalMesh);

    this.BLOOD_MAX = 64;
    this.bloodMesh = makeBillboardSystem(this.BLOOD_MAX, this.assets.getTexture('bloodSplat'), THREE.NormalBlending);
    this.bloodMesh.renderOrder = 3;
    this.bloodMesh.material.depthWrite = false;
    this.bloodMesh.material.polygonOffset = true;
    this.bloodMesh.material.polygonOffsetFactor = -5;
    this.bloodMesh.material.polygonOffsetUnits = -5;
    this.scene.add(this.bloodMesh);

    const mkDecals = (n) => {
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push({
          idx: i, alive: false, life: 0, maxLife: 26,
          matrix: new THREE.Matrix4(), alpha: 1,
          // Set when the decal landed on something that can MOVE. See
          // _fadeDecalList: the mark rides the object instead of hanging in
          // the air where the object used to be.
          body: null, local: new THREE.Matrix4(),
        });
      }
      return arr;
    };
    this.decals = mkDecals(this.DECAL_MAX);
    this.bloods = mkDecals(this.BLOOD_MAX);
    this.decalCursor = 0;
    this.bloodCursor = 0;
    for (let i = 0; i < this.DECAL_MAX; i++) this.decalMesh.setMatrixAt(i, HIDDEN);
    for (let i = 0; i < this.BLOOD_MAX; i++) this.bloodMesh.setMatrixAt(i, HIDDEN);
  }

  // =============================================================== flashes
  _buildFlashes() {
    this.FLASH_MAX = 24;
    this.flashMesh = makeBillboardSystem(this.FLASH_MAX, this.assets.getTexture('flash'), THREE.AdditiveBlending);
    this.flashMesh.renderOrder = 12;
    this.scene.add(this.flashMesh);
    this.flashes = [];
    for (let i = 0; i < this.FLASH_MAX; i++) {
      this.flashes.push({
        alive: false, idx: i, pos: new THREE.Vector3(),
        life: 0, maxLife: 0.06, size: 0.4, roll: 0,
        color: new THREE.Color(1, 0.9, 0.65),
      });
      this.flashMesh.setMatrixAt(i, HIDDEN);
    }
    this.flashCount = 0;

    // Expanding fireball shells for explosions.
    this.FIREBALL_MAX = 6;
    this.fireballs = [];
    const fbGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < this.FIREBALL_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const mesh = new THREE.Mesh(fbGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 13;
      this.scene.add(mesh);
      this.fireballs.push({ mesh, mat, alive: false, life: 0, maxLife: 0.5, radius: 3 });
    }

    // A small pool of dynamic point lights. Shadow casting is off — one
    // shadow-casting light (the sun) is all we can afford at 60 FPS.
    //
    // These stay visible for the entire session and are silenced with
    // intensity 0, NEVER with `visible = false`. That looks like a pointless
    // distinction and is in fact the single worst stall in the game.
    //
    // three.js bakes the number of active lights into every shader as
    // NUM_POINT_LIGHTS. Toggling a light's visibility changes that number,
    // which invalidates the programs of every lit material in the scene and
    // recompiles them — synchronously, in the middle of a frame. Measured on
    // the first exploding barrel: 20 programs rebuilt, two frames of 1540 ms
    // and 1751 ms against a 2.1 ms baseline. That is the one-off freeze people
    // hit the first time something blows up, and it recurs at every new peak
    // number of simultaneous lights.
    //
    // Holding the count constant at LIGHT_MAX costs a few always-on light
    // evaluations per fragment and removes the recompilation entirely.
    this.LIGHT_MAX = 6;
    this.lights = [];
    for (let i = 0; i < this.LIGHT_MAX; i++) {
      const light = new THREE.PointLight(0xffc070, 0, 24, 2);
      light.castShadow = false;
      light.visible = true;      // deliberate — see above
      light.intensity = 0;
      this.scene.add(light);
      this.lights.push({ light, alive: false, life: 0, maxLife: 0.1, peak: 10 });
    }
  }

  _getFlash() {
    if (this.flashCount < this.FLASH_MAX) return this.flashes[this.flashCount++];
    return this.flashes[0];
  }

  /**
   * Compile every effect's shader before the match starts.
   *
   * WebGL builds a shader program the first time an object is actually drawn,
   * and that build blocks the frame it happens on. Anything hidden until it is
   * needed therefore pays for itself at the worst possible moment — the
   * fireball shells are invisible until something explodes, so the first
   * explosion compiled its programs mid-fight and froze the game for over a
   * second.
   *
   * Making them briefly visible and asking the renderer to compile moves that
   * cost into loading, where a pause is expected and free.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   */
  async warmup(renderer, camera) {
    const hidden = [];
    for (const fb of this.fireballs) {
      if (!fb.mesh.visible) {
        hidden.push(fb.mesh);
        fb.mesh.visible = true;
        // Zero opacity keeps it off-screen visually while still being drawn,
        // so nothing flashes up during loading.
        fb.mat.opacity = 0;
      }
    }
    try {
      if (renderer.compileAsync) await renderer.compileAsync(this.scene, camera);
      else renderer.compile(this.scene, camera);
    } catch (err) {
      // Warmup is an optimisation, never a requirement.
      console.warn('[FX] Shader warmup skipped:', err);
    } finally {
      for (const mesh of hidden) mesh.visible = false;
    }
  }

  /** Briefly light the world from a point (muzzle flash, explosion). */
  pulseLight(pos, color, intensity, distance, duration) {
    for (const entry of this.lights) {
      if (entry.alive) continue;
      entry.alive = true;
      entry.life = 0;
      entry.maxLife = duration;
      entry.peak = intensity;
      entry.light.color.set(color);
      entry.light.distance = distance;
      entry.light.position.copy(pos);
      entry.light.intensity = intensity;
      return entry;
    }
    return null;
  }

  // ========================================================== ambient dust
  _buildAmbientDust() {
    const N = 700;
    const positions = new Float32Array(N * 3);
    this.dustVel = new Float32Array(N * 3);
    this.DUST_BOX = 34;
    for (let i = 0; i < N; i++) {
      positions[i * 3] = randRange(-this.DUST_BOX, this.DUST_BOX);
      positions[i * 3 + 1] = randRange(0.2, 14);
      positions[i * 3 + 2] = randRange(-this.DUST_BOX, this.DUST_BOX);
      this.dustVel[i * 3] = randRange(-0.16, 0.16);
      this.dustVel[i * 3 + 1] = randRange(-0.05, 0.09);
      this.dustVel[i * 3 + 2] = randRange(-0.16, 0.16);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.055,
      map: this.assets.getTexture('spark'),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      color: 0xcfe3ee,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 8;
    this.scene.add(this.dust);
    this.dustCount = N;
  }

  // ============================================================ spawn APIs

  /**
   * Full impact effect for a bullet hitting a surface.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {string} surface  one of SURFACE.*
   * @param {number} [intensity] 1 = a rifle round
   */
  /**
   * @param {object} [attachTo] the rigid body that was hit, when it is one
   *   that can move. A bullet hole on a crate has to travel with the crate:
   *   shoot one, knock it over, and the holes used to stay hanging in mid-air
   *   exactly where the crate had been.
   */
  spawnImpact(point, normal, surface, intensity = 1, attachTo = null) {
    this._impactBody = attachTo;
    const d = this.density * intensity;

    switch (surface) {
      case SURFACE.METAL: {
        this._sparkBurst(point, normal, Math.round(14 * d), {
          speed: [3.5, 11], life: [0.18, 0.5], size: [0.02, 0.055],
          color: [1.0, 0.85, 0.45], gravity: -16, bounce: 0.25,
        });
        this._smokePuff(point, normal, Math.round(1 * d), 0.16, 0.2, 0xb8bcc2);
        this.addDecal(point, normal, 'bullet', randRange(0.04, 0.065));
        break;
      }
      case SURFACE.WOOD: {
        this._sparkBurst(point, normal, Math.round(4 * d), {
          speed: [1.5, 4], life: [0.15, 0.3], size: [0.015, 0.03],
          color: [1.0, 0.7, 0.35], gravity: -18, bounce: 0,
        });
        this._debrisBurst(point, normal, Math.round(7 * d), 0x8a5f30, [0.015, 0.05]);
        this._smokePuff(point, normal, Math.round(2 * d), 0.26, 0.45, 0x9a7a52);
        this.addDecal(point, normal, 'bullet', randRange(0.045, 0.07));
        break;
      }
      case SURFACE.DIRT: {
        this._debrisBurst(point, normal, Math.round(8 * d), 0x6b5b45, [0.015, 0.045]);
        this._smokePuff(point, normal, Math.round(3 * d), 0.4, 0.6, 0x8a7a60);
        this.addDecal(point, normal, 'bullet', randRange(0.06, 0.095));
        break;
      }
      case SURFACE.GLASS: {
        // Bright, fast shards plus a fine glittering dust.
        this._sparkBurst(point, normal, Math.round(16 * d), {
          speed: [3, 10], life: [0.3, 0.8], size: [0.012, 0.035],
          color: [0.78, 0.94, 1.0], gravity: -20, bounce: 0.15, spreadCos: 0.4,
        });
        this._debrisBurst(point, normal, Math.round(9 * d), 0xbfe0ea, [0.012, 0.04], 8, 0.35);
        this.addDecal(point, normal, 'bullet', randRange(0.05, 0.075));
        break;
      }
      case SURFACE.FLESH: {
        this._sparkBurst(point, normal, Math.round(10 * d), {
          speed: [1.5, 5], life: [0.2, 0.45], size: [0.02, 0.05],
          color: [0.75, 0.06, 0.06], gravity: -22, bounce: 0,
        });
        this._smokePuff(point, normal, Math.round(1 * d), 0.2, 0.35, 0x7a1414);
        break;
      }
      default: {
        // Concrete / generic
        this._sparkBurst(point, normal, Math.round(5 * d), {
          speed: [2, 6], life: [0.12, 0.3], size: [0.015, 0.035],
          color: [1.0, 0.8, 0.5], gravity: -18, bounce: 0.1,
        });
        this._debrisBurst(point, normal, Math.round(6 * d), 0x8b8f95, [0.012, 0.04]);
        this._smokePuff(point, normal, Math.round(3 * d), 0.34, 0.55, 0xa8adb3);
        this.addDecal(point, normal, 'bullet', randRange(0.045, 0.07));
        break;
      }
    }
  }

  /** Blood spray + a wall splat behind the target. */
  spawnBloodBurst(point, dir, amount = 1) {
    const d = this.density * amount;
    this._sparkBurst(point, dir, Math.round(12 * d), {
      speed: [2, 7], life: [0.25, 0.55], size: [0.025, 0.07],
      color: [0.62, 0.04, 0.04], gravity: -24, bounce: 0,
    });
  }

  /**
   * Bullet tracer travelling from `start` to `end`.
   * Tracers are drawn as a short stretched quad that flies along the line,
   * which reads far better than a static full-length streak.
   */
  spawnTracer(start, end, opts = {}) {
    const t = this._getTracer();
    t.alive = true;
    t.start.copy(start);
    t.end.copy(end);
    t.dir.subVectors(end, start);
    t.total = t.dir.length();
    if (t.total < 0.001) { t.alive = false; return; }
    t.dir.divideScalar(t.total);
    t.travelled = 0;
    t.speed = opts.speed ?? 420;
    t.width = opts.width ?? 0.035;
    t.trail = opts.trail ?? Math.min(9, 2 + t.total * 0.18);
    t.life = 0;
    t.maxLife = t.total / t.speed + 0.04;
    t.color.set(opts.color ?? 0xffd899);
    t.head.copy(start);
  }

  /** World-space muzzle flash, for other players' weapons. */
  spawnMuzzleFlash(pos, dir, scale = 1, withLight = true) {
    const f = this._getFlash();
    f.alive = true;
    f.life = 0;
    f.maxLife = randRange(0.035, 0.06);
    f.pos.copy(pos);
    f.size = randRange(0.3, 0.5) * scale;
    f.roll = Math.random() * Math.PI * 2;
    f.color.setRGB(1, 0.88, 0.6);

    this._sparkBurst(pos, dir, Math.round(4 * this.density), {
      speed: [3, 9], life: [0.06, 0.16], size: [0.015, 0.04],
      color: [1, 0.82, 0.4], gravity: -6, bounce: 0, spreadCos: 0.85,
    });
    this._smokePuff(pos, dir, Math.round(1 * this.density), 0.22, 0.28, 0xbfc4c9, 0.28);

    if (withLight) this.pulseLight(pos, 0xffc070, 9 * scale, 12 * scale, 0.055);
  }

  /** Ejected cartridge case with cheap bounce physics. */
  spawnShell(pos, velocity, groundY = 0, scale = 1) {
    if (this.density < 0.3) return;
    const s = this._getShell();
    s.alive = true;
    s.life = 0;
    s.maxLife = randRange(5, 8);
    s.pos.copy(pos);
    s.vel.copy(velocity);
    s.rot.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    s.spin.set(randRange(-18, 18), randRange(-14, 14), randRange(-18, 18));
    s.groundY = groundY;
    s.bounces = 0;
    s.scale = scale;
  }

  /** Big explosion: fireball, light, smoke column, sparks, debris. */
  spawnExplosion(position, radius = 4.5) {
    const d = this.density;

    // Fireball shell
    for (const fb of this.fireballs) {
      if (fb.alive) continue;
      fb.alive = true;
      fb.life = 0;
      fb.maxLife = 0.42;
      fb.radius = radius * 0.7;
      fb.mesh.position.copy(position);
      fb.mesh.scale.setScalar(0.35);
      fb.mesh.visible = true;
      fb.mat.opacity = 1;
      break;
    }

    this.pulseLight(position, 0xffa040, 240, radius * 6, 0.55);

    this._sparkBurst(position, UP, Math.round(60 * d), {
      speed: [6, 26], life: [0.35, 1.0], size: [0.04, 0.13],
      color: [1.0, 0.72, 0.28], gravity: -16, bounce: 0.3, spreadCos: -1,
    });
    this._debrisBurst(position, UP, Math.round(26 * d), 0x4a4a4a, [0.04, 0.13], 16, -1);

    for (let i = 0; i < Math.round(18 * d); i++) {
      const s = this._getSmoke();
      s.alive = true;
      s.life = 0;
      s.maxLife = randRange(1.4, 2.8);
      s.pos.copy(position).add(
        this._v.set(randRange(-1, 1), randRange(-0.6, 1.2), randRange(-1, 1)).multiplyScalar(radius * 0.35)
      );
      s.vel.set(randRange(-2.2, 2.2), randRange(1.2, 4.2), randRange(-2.2, 2.2));
      s.size = randRange(1.0, 2.2);
      s.growth = randRange(1.4, 2.6);
      s.roll = Math.random() * 6.28;
      s.spin = randRange(-0.8, 0.8);
      const k = randRange(0.16, 0.34);
      s.color.setRGB(k, k * 0.95, k * 0.9);
      s.peakAlpha = randRange(0.5, 0.85);
    }

    // A short-lived burning core rendered as bright smoke
    for (let i = 0; i < Math.round(8 * d); i++) {
      const s = this._getSmoke();
      s.alive = true;
      s.life = 0;
      s.maxLife = randRange(0.25, 0.5);
      s.pos.copy(position).add(
        this._v.set(randRange(-1, 1), randRange(-0.5, 1), randRange(-1, 1)).multiplyScalar(radius * 0.3)
      );
      s.vel.set(randRange(-1.5, 1.5), randRange(1, 3), randRange(-1.5, 1.5));
      s.size = randRange(0.9, 1.8);
      s.growth = 2.2;
      s.roll = Math.random() * 6.28;
      s.spin = randRange(-1.4, 1.4);
      s.color.setRGB(1.5, 0.75, 0.28);
      s.peakAlpha = 0.9;
    }
  }

  /** Ground-hugging dust kicked up by landing. */
  spawnLandingDust(position, strength = 1) {
    const n = Math.round(6 * this.density * strength);
    for (let i = 0; i < n; i++) {
      const s = this._getSmoke();
      s.alive = true;
      s.life = 0;
      s.maxLife = randRange(0.5, 1.0);
      const a = Math.random() * Math.PI * 2;
      const r = randRange(0.1, 0.55);
      s.pos.set(position.x + Math.cos(a) * r, position.y + 0.06, position.z + Math.sin(a) * r);
      s.vel.set(Math.cos(a) * randRange(0.6, 1.6), randRange(0.2, 0.7), Math.sin(a) * randRange(0.6, 1.6));
      s.size = randRange(0.25, 0.5);
      s.growth = 1.1;
      s.roll = Math.random() * 6.28;
      s.spin = randRange(-1, 1);
      s.color.setRGB(0.55, 0.52, 0.47);
      s.peakAlpha = 0.32 * strength;
    }
  }

  /**
   * Add a decal quad on a surface.
   * @param {'bullet'|'blood'} type
   */
  /**
   * Stamp a mark on a surface.
   *
   * `size` is the WHOLE sprite across, and the sprite is mostly soft halo
   * around a small dark core. These used to be 10-24 cm each, so every round
   * left a dark smudge the size of a saucer; a magazine of automatic fire
   * covered the ground and the crates in overlapping black blobs. A real
   * rifle strike marks a few centimetres.
   */
  addDecal(point, normal, type = 'bullet', size = 0.06) {
    const isBlood = type === 'blood';
    const list = isBlood ? this.bloods : this.decals;
    const mesh = isBlood ? this.bloodMesh : this.decalMesh;
    const cursorKey = isBlood ? 'bloodCursor' : 'decalCursor';

    const entry = list[this[cursorKey]];
    this[cursorKey] = (this[cursorKey] + 1) % list.length;

    entry.alive = true;
    entry.life = 0;
    entry.maxLife = isBlood ? 22 : 28;
    entry.alpha = 1;

    // Orient the quad so its +Z faces along the surface normal, with a random
    // roll so repeated hits don't look stamped.
    this._v.copy(normal).normalize();
    const upRef = Math.abs(this._v.y) > 0.95 ? FORWARD : UP;
    this._v2.crossVectors(upRef, this._v).normalize();
    this._v3.crossVectors(this._v, this._v2).normalize();
    this._basis.makeBasis(this._v2, this._v3, this._v);
    this._q.setFromRotationMatrix(this._basis);
    this._q.multiply(this._tmpRoll(Math.random() * Math.PI * 2));

    this._v2.copy(point).addScaledVector(this._v, 0.014);
    entry.matrix.compose(this._v2, this._q, this._tmpScale(size));

    /*
     * If it landed on something movable, remember WHERE ON THAT THING it
     * landed rather than where it was in the world, and rebuild the world
     * matrix each frame from wherever the object has got to.
     */
    entry.body = this._impactBody ?? null;
    if (entry.body) {
      const t = entry.body.translation();
      const r = entry.body.rotation();
      this._bodyMat.compose(
        this._v3.set(t.x, t.y, t.z),
        this._bodyQuat.set(r.x, r.y, r.z, r.w),
        this._unitScale,
      );
      entry.local.copy(this._bodyMat).invert().multiply(entry.matrix);
    }
    mesh.setMatrixAt(entry.idx, entry.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    this._setInstanceAlpha(mesh, entry.idx, 1);
    this._setInstanceColor(mesh, entry.idx, 1, 1, 1);
  }

  // ----------------------------------------------------------- spawn utils
  _sparkBurst(origin, dir, count, o) {
    const [sMin, sMax] = o.speed;
    const [lMin, lMax] = o.life;
    const [zMin, zMax] = o.size;
    const spreadCos = o.spreadCos ?? 0.15;
    for (let i = 0; i < count; i++) {
      const p = this._getSpark();
      p.alive = true;
      p.life = 0;
      p.maxLife = randRange(lMin, lMax);
      p.pos.copy(origin);
      randomCone(this._v, dir, spreadCos);
      p.vel.copy(this._v).multiplyScalar(randRange(sMin, sMax));
      p.size = randRange(zMin, zMax);
      p.gravity = o.gravity ?? -16;
      p.drag = o.drag ?? 1.6;
      p.bounce = o.bounce ?? 0;
      p.color.setRGB(o.color[0], o.color[1], o.color[2]);
    }
  }

  _debrisBurst(origin, dir, count, colorHex, sizeRange, speed = 6, spreadCos = 0.2) {
    this._c.set(colorHex);
    for (let i = 0; i < count; i++) {
      const p = this._getDebris();
      p.alive = true;
      p.life = 0;
      p.maxLife = randRange(0.8, 2.0);
      p.pos.copy(origin);
      randomCone(this._v, dir, spreadCos);
      p.vel.copy(this._v).multiplyScalar(randRange(speed * 0.3, speed));
      p.rot.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      p.spin.set(randRange(-12, 12), randRange(-12, 12), randRange(-12, 12));
      p.size = randRange(sizeRange[0], sizeRange[1]);
      this.debrisMesh.setColorAt?.(p.idx, this._c);
      const arr = this.debrisMesh.instanceColor.array;
      arr[p.idx * 3] = this._c.r;
      arr[p.idx * 3 + 1] = this._c.g;
      arr[p.idx * 3 + 2] = this._c.b;
      this.debrisMesh.instanceColor.needsUpdate = true;
    }
  }

  _smokePuff(origin, dir, count, size, life, colorHex, alpha = 0.42) {
    this._c.set(colorHex);
    for (let i = 0; i < count; i++) {
      const s = this._getSmoke();
      s.alive = true;
      s.life = 0;
      s.maxLife = randRange(life * 0.7, life * 1.4);
      s.pos.copy(origin);
      randomCone(this._v, dir, 0.1);
      s.vel.copy(this._v).multiplyScalar(randRange(0.4, 1.6));
      s.vel.y += 0.5;
      s.size = randRange(size * 0.7, size * 1.3);
      s.growth = randRange(0.8, 1.8);
      s.roll = Math.random() * 6.28;
      s.spin = randRange(-2, 2);
      s.color.copy(this._c);
      s.peakAlpha = alpha;
    }
  }

  // ================================================================ update
  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    this._camQuat = camera.quaternion;
    camera.getWorldPosition(this._camPos ?? (this._camPos = new THREE.Vector3()));

    this._updateSparks(dt);
    this._updateSmoke(dt);
    this._updateDebris(dt);
    this._updateTracers(dt);
    this._updateShells(dt);
    this._updateFlashes(dt);
    this._updateDecals(dt);
    this._updateLights(dt);
    this._updateDust(dt);
  }

  _updateSparks(dt) {
    const mesh = this.sparkMesh;
    const alphaAttr = mesh.geometry.getAttribute('aAlpha');
    const colorAttr = mesh.geometry.getAttribute('aColor');

    for (let i = 0; i < this.sparkCount; i++) {
      const p = this.sparks[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        mesh.setMatrixAt(p.idx, HIDDEN);
        alphaAttr.array[p.idx] = 0;
        this._swapDead(this.sparks, i, --this.sparkCount);
        i--;
        continue;
      }

      const drag = Math.max(0, 1 - p.drag * dt);
      p.vel.multiplyScalar(drag);
      p.vel.y += p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);

      // Very cheap floor bounce keeps sparks from sinking through the ground.
      if (p.bounce > 0 && p.pos.y < 0.02 && p.vel.y < 0) {
        p.pos.y = 0.02;
        p.vel.y = -p.vel.y * p.bounce;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
      }

      const t = p.life / p.maxLife;
      const fade = 1 - t * t;
      const size = p.size * (0.6 + 0.4 * (1 - t));

      this._q.copy(this._camQuat);
      this._m.compose(p.pos, this._q, this._tmpScale(size));
      mesh.setMatrixAt(p.idx, this._m);
      alphaAttr.array[p.idx] = fade;
      colorAttr.array[p.idx * 3] = p.color.r;
      colorAttr.array[p.idx * 3 + 1] = p.color.g;
      colorAttr.array[p.idx * 3 + 2] = p.color.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  _updateSmoke(dt) {
    const mesh = this.smokeMesh;
    const alphaAttr = mesh.geometry.getAttribute('aAlpha');
    const colorAttr = mesh.geometry.getAttribute('aColor');

    for (let i = 0; i < this.smokeCount; i++) {
      const s = this.smokes[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        mesh.setMatrixAt(s.idx, HIDDEN);
        alphaAttr.array[s.idx] = 0;
        this._swapDead(this.smokes, i, --this.smokeCount);
        i--;
        continue;
      }

      s.vel.multiplyScalar(Math.max(0, 1 - 1.4 * dt));
      s.vel.y += 0.55 * dt; // buoyancy
      s.pos.addScaledVector(s.vel, dt);
      s.roll += s.spin * dt;

      const t = s.life / s.maxLife;
      // Quick fade-in, long fade-out.
      const alpha = s.peakAlpha * Math.min(1, t * 8) * (1 - t) * (1 - t);
      const size = s.size * (1 + s.growth * t);

      this._q.copy(this._camQuat).multiply(this._tmpRoll(s.roll));
      this._m.compose(s.pos, this._q, this._tmpScale(size));
      mesh.setMatrixAt(s.idx, this._m);
      alphaAttr.array[s.idx] = alpha;
      colorAttr.array[s.idx * 3] = s.color.r;
      colorAttr.array[s.idx * 3 + 1] = s.color.g;
      colorAttr.array[s.idx * 3 + 2] = s.color.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  _updateDebris(dt) {
    const mesh = this.debrisMesh;
    for (let i = 0; i < this.debrisCount; i++) {
      const p = this.debris[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        mesh.setMatrixAt(p.idx, HIDDEN);
        this._swapDead(this.debris, i, --this.debrisCount);
        i--;
        continue;
      }
      p.vel.y += -20 * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02 && p.vel.y < 0) {
        p.pos.y = 0.02;
        p.vel.y = -p.vel.y * 0.28;
        p.vel.x *= 0.55;
        p.vel.z *= 0.55;
        p.spin.multiplyScalar(0.6);
      }
      p.rot.x += p.spin.x * dt;
      p.rot.y += p.spin.y * dt;
      p.rot.z += p.spin.z * dt;

      const t = p.life / p.maxLife;
      const scale = p.size * (t > 0.75 ? 1 - (t - 0.75) * 4 : 1);
      this._q.setFromEuler(p.rot);
      this._m.compose(p.pos, this._q, this._tmpScale(Math.max(0, scale)));
      mesh.setMatrixAt(p.idx, this._m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  _updateTracers(dt) {
    const mesh = this.tracerMesh;
    const alphaAttr = mesh.geometry.getAttribute('aAlpha');
    const colorAttr = mesh.geometry.getAttribute('aColor');

    for (let i = 0; i < this.tracerCount; i++) {
      const t = this.tracers[i];
      t.life += dt;
      t.travelled += t.speed * dt;

      if (t.life >= t.maxLife) {
        mesh.setMatrixAt(t.idx, HIDDEN);
        alphaAttr.array[t.idx] = 0;
        this._swapDead(this.tracers, i, --this.tracerCount);
        i--;
        continue;
      }

      const head = Math.min(t.travelled, t.total);
      const tail = Math.max(0, head - t.trail);
      const len = Math.max(0.05, head - tail);
      const mid = (head + tail) * 0.5;

      t.head.copy(t.start).addScaledVector(t.dir, mid);

      // Build a basis whose X runs along the tracer and whose Z faces camera.
      this._v.copy(this._camPos).sub(t.head);
      this._v.addScaledVector(t.dir, -this._v.dot(t.dir)); // perpendicular part
      if (this._v.lengthSq() < 1e-6) this._v.set(0, 1, 0);
      this._v.normalize();
      this._v2.crossVectors(this._v, t.dir).normalize();
      this._basis.makeBasis(t.dir, this._v2, this._v);
      this._q.setFromRotationMatrix(this._basis);

      this._m.compose(t.head, this._q, this._v3.set(len, t.width, 1));
      mesh.setMatrixAt(t.idx, this._m);

      const fade = head >= t.total ? Math.max(0, 1 - (t.life - t.total / t.speed) / 0.04) : 1;
      alphaAttr.array[t.idx] = fade;
      colorAttr.array[t.idx * 3] = t.color.r;
      colorAttr.array[t.idx * 3 + 1] = t.color.g;
      colorAttr.array[t.idx * 3 + 2] = t.color.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  _updateShells(dt) {
    const mesh = this.shellMesh;
    for (let i = 0; i < this.shellCount; i++) {
      const s = this.shells[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        mesh.setMatrixAt(s.idx, HIDDEN);
        this._swapDead(this.shells, i, --this.shellCount);
        i--;
        continue;
      }
      s.vel.y += -22 * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.pos.y <= s.groundY + 0.012 && s.vel.y < 0) {
        s.pos.y = s.groundY + 0.012;
        s.vel.y = -s.vel.y * 0.38;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.spin.multiplyScalar(0.5);
        s.bounces++;
        if (s.bounces > 3) { s.vel.set(0, 0, 0); s.spin.set(0, 0, 0); }
      }
      s.rot.x += s.spin.x * dt;
      s.rot.y += s.spin.y * dt;
      s.rot.z += s.spin.z * dt;

      const t = s.life / s.maxLife;
      const shrink = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      this._q.setFromEuler(s.rot);
      this._m.compose(s.pos, this._q, this._tmpScale(s.scale * Math.max(0, shrink)));
      mesh.setMatrixAt(s.idx, this._m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  _updateFlashes(dt) {
    const mesh = this.flashMesh;
    const alphaAttr = mesh.geometry.getAttribute('aAlpha');
    const colorAttr = mesh.geometry.getAttribute('aColor');

    for (let i = 0; i < this.flashCount; i++) {
      const f = this.flashes[i];
      f.life += dt;
      if (f.life >= f.maxLife) {
        mesh.setMatrixAt(f.idx, HIDDEN);
        alphaAttr.array[f.idx] = 0;
        this._swapDead(this.flashes, i, --this.flashCount);
        i--;
        continue;
      }
      const t = f.life / f.maxLife;
      this._q.copy(this._camQuat).multiply(this._tmpRoll(f.roll));
      this._m.compose(f.pos, this._q, this._tmpScale(f.size * (1 + t * 0.5)));
      mesh.setMatrixAt(f.idx, this._m);
      alphaAttr.array[f.idx] = 1 - t;
      colorAttr.array[f.idx * 3] = f.color.r;
      colorAttr.array[f.idx * 3 + 1] = f.color.g;
      colorAttr.array[f.idx * 3 + 2] = f.color.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;

    for (const fb of this.fireballs) {
      if (!fb.alive) continue;
      fb.life += dt;
      if (fb.life >= fb.maxLife) {
        fb.alive = false;
        fb.mesh.visible = false;
        continue;
      }
      const t = fb.life / fb.maxLife;
      fb.mesh.scale.setScalar(fb.radius * (0.35 + t * 1.1));
      fb.mat.opacity = (1 - t) * (1 - t) * 0.95;
      fb.mat.color.setRGB(1, 0.72 - t * 0.35, 0.32 - t * 0.28);
    }
  }

  _updateDecals(dt) {
    this._fadeDecalList(this.decals, this.decalMesh, dt);
    this._fadeDecalList(this.bloods, this.bloodMesh, dt);
  }

  _fadeDecalList(list, mesh, dt) {
    const alphaAttr = mesh.geometry.getAttribute('aAlpha');
    let dirty = false;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.alive) continue;
      d.life += dt;
      if (d.life >= d.maxLife) {
        d.alive = false;
        mesh.setMatrixAt(d.idx, HIDDEN);
        alphaAttr.array[d.idx] = 0;
        mesh.instanceMatrix.needsUpdate = true;
        dirty = true;
        continue;
      }
      // A mark stuck to something that moves has to move with it.
      if (d.body) {
        const bt = d.body.translation();
        const br = d.body.rotation();
        this._bodyMat.compose(
          this._v3.set(bt.x, bt.y, bt.z),
          this._bodyQuat.set(br.x, br.y, br.z, br.w),
          this._unitScale,
        );
        d.matrix.multiplyMatrices(this._bodyMat, d.local);
        mesh.setMatrixAt(d.idx, d.matrix);
        mesh.instanceMatrix.needsUpdate = true;
        dirty = true;
      }

      // Only fade over the last 25% of the lifetime.
      const t = d.life / d.maxLife;
      const a = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
      if (Math.abs(alphaAttr.array[d.idx] - a) > 0.01) {
        alphaAttr.array[d.idx] = a;
        dirty = true;
      }
    }
    if (dirty) alphaAttr.needsUpdate = true;
  }

  _updateLights(dt) {
    for (const e of this.lights) {
      if (!e.alive) continue;
      e.life += dt;
      if (e.life >= e.maxLife) {
        e.alive = false;
        e.light.intensity = 0;   // NOT visible=false — see the light pool note
        continue;
      }
      const t = e.life / e.maxLife;
      e.light.intensity = e.peak * (1 - t) * (1 - t);
    }
  }

  _updateDust(dt) {
    const pos = this.dust.geometry.getAttribute('position');
    const arr = pos.array;
    const cx = this._camPos.x;
    const cz = this._camPos.z;
    const B = this.DUST_BOX;
    for (let i = 0; i < this.dustCount; i++) {
      const i3 = i * 3;
      arr[i3] += this.dustVel[i3] * dt;
      arr[i3 + 1] += this.dustVel[i3 + 1] * dt;
      arr[i3 + 2] += this.dustVel[i3 + 2] * dt;

      // Wrap the field around the camera so motes are always nearby.
      if (arr[i3] - cx > B) arr[i3] -= B * 2;
      else if (arr[i3] - cx < -B) arr[i3] += B * 2;
      if (arr[i3 + 2] - cz > B) arr[i3 + 2] -= B * 2;
      else if (arr[i3 + 2] - cz < -B) arr[i3 + 2] += B * 2;
      if (arr[i3 + 1] > 15) arr[i3 + 1] = 0.2;
      else if (arr[i3 + 1] < 0.1) arr[i3 + 1] = 14;
    }
    pos.needsUpdate = true;
  }

  // --------------------------------------------------------------- helpers
  /** Swap a dead entry with the last live one so the live range stays dense. */
  _swapDead(arr, i, lastIndex) {
    if (i !== lastIndex) {
      const tmp = arr[i];
      arr[i] = arr[lastIndex];
      arr[lastIndex] = tmp;
    }
    arr[lastIndex].alive = false;
  }

  _tmpScale(s) {
    return (this.__scaleVec ?? (this.__scaleVec = new THREE.Vector3())).set(s, s, s);
  }

  _tmpRoll(angle) {
    return (this.__rollQuat ?? (this.__rollQuat = new THREE.Quaternion())).setFromAxisAngle(FORWARD, angle);
  }

  _setInstanceAlpha(mesh, idx, v) {
    const a = mesh.geometry.getAttribute('aAlpha');
    a.array[idx] = v;
    a.needsUpdate = true;
  }

  _setInstanceColor(mesh, idx, r, g, b) {
    const a = mesh.geometry.getAttribute('aColor');
    a.array[idx * 3] = r;
    a.array[idx * 3 + 1] = g;
    a.array[idx * 3 + 2] = b;
    a.needsUpdate = true;
  }

  /** Clear every live effect (used on restart). */
  reset() {
    const hideAll = (mesh, list, countKey) => {
      for (const p of list) {
        p.alive = false;
        mesh.setMatrixAt(p.idx, HIDDEN);
      }
      mesh.instanceMatrix.needsUpdate = true;
      const a = mesh.geometry.getAttribute('aAlpha');
      if (a) { a.array.fill(0); a.needsUpdate = true; }
      if (countKey) this[countKey] = 0;
    };
    hideAll(this.sparkMesh, this.sparks, 'sparkCount');
    hideAll(this.smokeMesh, this.smokes, 'smokeCount');
    hideAll(this.debrisMesh, this.debris, 'debrisCount');
    hideAll(this.tracerMesh, this.tracers, 'tracerCount');
    hideAll(this.shellMesh, this.shells, 'shellCount');
    hideAll(this.flashMesh, this.flashes, 'flashCount');
    hideAll(this.decalMesh, this.decals, null);
    hideAll(this.bloodMesh, this.bloods, null);
    for (const fb of this.fireballs) { fb.alive = false; fb.mesh.visible = false; }
    for (const l of this.lights) { l.alive = false; l.light.intensity = 0; }
  }

  dispose() {
    const kill = (mesh) => {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    };
    kill(this.sparkMesh);
    kill(this.smokeMesh);
    kill(this.debrisMesh);
    kill(this.tracerMesh);
    kill(this.shellMesh);
    kill(this.decalMesh);
    kill(this.bloodMesh);
    kill(this.flashMesh);
    kill(this.dust);
    for (const fb of this.fireballs) {
      this.scene.remove(fb.mesh);
      fb.mat.dispose();
    }
    this.fireballs[0]?.mesh.geometry.dispose();
    for (const l of this.lights) this.scene.remove(l.light);
  }
}

/* ------------------------------------------------------------------ utils */

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Random unit vector inside a cone around `axis`.
 * `minCos = -1` gives a full sphere, `0.9` a tight cone.
 */
function randomCone(out, axis, minCos) {
  const cosT = minCos + Math.random() * (1 - minCos);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = Math.random() * Math.PI * 2;

  // Build an orthonormal basis around the axis.
  let ax = axis.x, ay = axis.y, az = axis.z;
  const len = Math.hypot(ax, ay, az) || 1;
  ax /= len; ay /= len; az /= len;

  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ay) > 0.95) { ux = 1; uy = 0; uz = 0; }
  // t = normalize(cross(u, a))
  let tx = uy * az - uz * ay;
  let ty = uz * ax - ux * az;
  let tz = ux * ay - uy * ax;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // b = cross(a, t)
  const bx = ay * tz - az * ty;
  const by = az * tx - ax * tz;
  const bz = ax * ty - ay * tx;

  const c = Math.cos(phi) * sinT;
  const s = Math.sin(phi) * sinT;
  out.set(ax * cosT + tx * c + bx * s, ay * cosT + ty * c + by * s, az * cosT + tz * c + bz * s);
  return out;
}

export { randomCone, randSign, clamp };

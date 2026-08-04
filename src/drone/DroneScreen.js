/**
 * DroneScreen — the panel on the field terminal that the feed is shown on.
 *
 * WHERE IT LIVES, AND WHY THAT EXACT PLACE
 * ----------------------------------------
 * A 4:3 quad parented to the `screen` anchor INSIDE the terminal's weapon
 * group, which makes it a GRANDCHILD of `WeaponViewModel.holder` rather than a
 * direct child. That is not tidiness. The holder's visibility invariant
 * iterates its DIRECT children only and `continue`s past anything without
 * `isWeaponGroup`, so a grandchild is never touched and the panel shows and
 * hides with the terminal for free — no `isWeaponGroup` special case, and no
 * fourth writer of `holder.visible` to fight the three that already exist.
 *
 * THE LAYER IS LOAD-BEARING
 * -------------------------
 * The quad is put on `LAYER_VIEWMODEL` here, explicitly, rather than relying on
 * `WeaponViewModel.assignLayer`. That runs once when a weapon is REGISTERED,
 * and this quad is parented in afterwards, so it would keep `LAYER_WORLD` and
 * two things would go wrong at once: the world camera would draw a floating
 * panel in the middle of the map, and the drone's POV camera — which is
 * `layers.set(LAYER_WORLD)` — would see the very surface its own output is
 * being drawn onto, giving a texture-feedback tunnel. With the layers set as
 * they are, that loop is structurally impossible and no hide-the-mesh dance is
 * ever needed.
 *
 * THE COLOUR TRANSFORM IS NOT DONE HERE
 * -------------------------------------
 * This is the one thing deliberately NOT copied from `ScopeRenderer`. That
 * class transforms the captured image inside its own fragment shader because it
 * is composited straight to the canvas after the composer has finished, where
 * nothing else would ever do it. This quad is ordinary view-model geometry:
 *
 *   - with the composer on, `ViewModelPass` draws it into a render target, so
 *     three compiles this material with tone mapping off and a pass-through
 *     encode, and `OutputPass` transforms the finished frame;
 *   - on the Low preset the composer is skipped and `PostFX` draws to the
 *     canvas, where three's own transform applies.
 *
 * Both paths are already correct, which is why the two `#include`s at the end
 * of the shader are the whole of it: they resolve to nothing in the first case
 * and to three's own curve and encode in the second. Writing the maths by hand
 * would apply it twice in the second path, and the scope's own comment records
 * what that costs — a 2-4x brightness error that no exposure control affects.
 * The shader's own overlay constants are authored in the same linear space the
 * feed is captured in, for the same reason.
 */

import * as THREE from 'three';
import { DRONE, DRONE_EVENT } from '../net/protocol.js';
import { LAYER_VIEWMODEL } from '../fx/ScopeRenderer.js';
import { clamp } from '../core/MathUtils.js';

/** Panel size in metres, sized to sit inside the terminal's 0.176 x 0.132 bezel. */
const PANEL_W = 0.168;
const PANEL_H = PANEL_W * 0.75;

/** Seconds for the raster to come up after a drone arrives. */
const BOOT_SEC = 0.55;
/** Seconds for the picture to collapse into static after the drone goes. */
const LOSS_SEC = 0.35;
/** Seconds the red edge and the image shake last after the pilot's body is hit. */
const ALERT_SEC = 0.6;

/**
 * Distance at which the range strip reads full.
 *
 * A display maximum, NOT the leash: the leash is `ARENAS[map].drone.leash` and
 * lives on the server, which is the only party that enforces it. A client-side
 * copy would be a second number to keep in step for the sake of one bar.
 */
const DISPLAY_RANGE_M = 40;

const SCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SCREEN_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uFeed;
  uniform vec2      uFeedSize;   // SOURCE pixels — the scanline pitch comes from this
  uniform sampler2D uLabel;      // the SIGNAL LOST caption, alpha only
  uniform float     uTime;
  uniform float     uBoot;       // 0 = dark, 1 = raster fully up
  uniform float     uSignal;     // 1 = live picture, 0 = static
  uniform float     uHarsh;      // 1 = shot out of the air, 0 = brought home
  uniform float     uAlert;      // 0..1 red edge, the pilot's body is being shot at
  uniform vec2      uJolt;       // image displacement, same event
  uniform float     uBattery;    // 0..1
  uniform float     uHp;         // 0..1
  uniform float     uRange;      // 0..1 of DISPLAY_RANGE_M
  uniform float     uSweep;      // glass highlight position

  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  /** 1 inside an axis-aligned rectangle, 0 outside. */
  float rect(vec2 p, vec2 lo, vec2 hi) {
    vec2 s = step(lo, p) * step(p, hi);
    return s.x * s.y;
  }

  void main() {
    vec2 c = vUv - 0.5;

    // Slight pincushion, so the image reads as sitting behind glass rather
    // than being printed on the front of the slab.
    vec2 uv = vUv + c * dot(c, c) * 0.05 + uJolt;
    float onScreen = rect(uv, vec2(0.0), vec2(1.0));

    vec3 col = texture2D(uFeed, clamp(uv, 0.0, 1.0)).rgb * onScreen;

    // ---- chroma-only noise ------------------------------------------------
    // Pushed into the red/blue difference, which cancels in luma. A cheap radio
    // link loses its colour long before its brightness, and luma noise on a
    // panel that only refreshes 20 times a second reads as the whole picture
    // flickering rather than as a weak signal.
    float grain = (hash(floor(uv * uFeedSize) + floor(uTime * 24.0)) - 0.5)
                * mix(0.10, 0.02, uSignal);
    col.r += grain;
    col.b -= grain;

    // ---- scanlines, one per SOURCE row ------------------------------------
    // uFeedSize, not a constant: the target is 480 lines tall at High and 192
    // at Low, and a fixed pitch would beat against the smaller image and turn
    // the picture into a moire the moment the governor stepped the preset down.
    float line = 0.5 + 0.5 * cos(uv.y * uFeedSize.y * 6.2831853);
    col *= mix(1.0, 0.80, line);

    // ---- boot: the raster opens from the centre line ----------------------
    float open = smoothstep(0.0, 1.0, clamp(uBoot, 0.0, 1.0));
    float fromMid = abs(vUv.y - 0.5) * 2.0;
    col *= step(fromMid, open);
    // The opening edge glows. Without it this is a wipe; with it, it reads as a
    // raster coming up.
    col += vec3(0.16, 0.55, 0.30)
         * smoothstep(0.04, 0.0, abs(fromMid - open)) * (1.0 - open);

    // ---- signal loss ------------------------------------------------------
    float sig = clamp(uSignal, 0.0, 1.0);
    float snow = hash(floor(vUv * uFeedSize * 0.5) + floor(uTime * 30.0));
    float tear = step(0.985 - 0.05 * uHarsh, fract(vUv.y * 3.0 + uTime * 1.7));
    vec3 dead = vec3(snow) * mix(0.05, 0.30, uHarsh) + vec3(tear) * 0.12;
    col = mix(dead, col, sig);

    // The caption, drawn into its own band so it cannot creep over the bars.
    vec2 luv = (vUv - vec2(0.5, 0.54)) / vec2(0.82, 0.17) + 0.5;
    float blink = 0.55 + 0.45 * step(0.5, fract(uTime * 1.6));
    col = mix(col, vec3(0.95, 0.16, 0.11),
              texture2D(uLabel, clamp(luv, 0.0, 1.0)).a
              * rect(luv, vec2(0.0), vec2(1.0)) * (1.0 - sig) * blink);

    // ---- burned-in HUD ----------------------------------------------------
    // After the static mix on purpose: it is etched into the panel's own
    // overlay, not carried on the radio link, so it survives the drone.
    vec3 ink = vec3(0.10, 0.42, 0.22);
    float bat = clamp(uBattery, 0.0, 1.0);
    float hp  = clamp(uHp, 0.0, 1.0);

    float trackB = rect(vUv, vec2(0.06, 0.055), vec2(0.36, 0.085));
    float fillB  = rect(vUv, vec2(0.06, 0.055), vec2(0.06 + 0.30 * bat, 0.085));
    // Health drains from the right, so the two bars empty toward each other and
    // a glance at the bottom of the panel reads as one gauge, not two.
    float trackH = rect(vUv, vec2(0.64, 0.055), vec2(0.94, 0.085));
    float fillH  = rect(vUv, vec2(0.94 - 0.30 * hp, 0.055), vec2(0.94, 0.085));

    col += ink * (trackB * 0.22 + fillB * 1.0);
    col += mix(vec3(0.42, 0.05, 0.03), ink, smoothstep(0.25, 0.60, hp))
         * (trackH * 0.22 + fillH * 1.0);

    // A low battery pulses. It is the only warning a pilot gets before the
    // server takes the drone away on its own.
    col += vec3(0.40, 0.08, 0.04) * fillB
         * (1.0 - step(0.2, bat)) * (0.5 + 0.5 * sin(uTime * 8.0));

    // Range: a tick strip across the top, lit as far as the drone has gone.
    float ticks = rect(vUv, vec2(0.34, 0.918), vec2(0.66, 0.944))
                * step(0.55, fract((vUv.x - 0.34) * 16.0));
    col += ink * ticks * (0.20 + 1.0 * step((vUv.x - 0.34) / 0.32, clamp(uRange, 0.0, 1.0)));

    // ---- glass ------------------------------------------------------------
    col += vec3(0.05, 0.055, 0.065)
         * smoothstep(0.30, 0.0, abs((vUv.x + vUv.y * 0.55) - uSweep));

    // The 4:3 correction keeps the corner falloff round rather than oval.
    float edge = smoothstep(0.30, 0.52, max(abs(c.x), abs(c.y) * 1.3333));
    col *= 1.0 - edge * 0.35;
    col = mix(col, vec3(0.60, 0.02, 0.02), edge * clamp(uAlert, 0.0, 1.0) * 0.9);

    gl_FragColor = vec4(max(col, 0.0), 1.0);

    // Three's own transform, and only three's. Resolves to nothing inside the
    // composer and to the full curve and encode when PostFX draws to the canvas
    // on the Low preset — see the header.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class DroneScreen {
  constructor() {
    this._labelTexture = buildLabelTexture();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFeed: { value: null },
        // Never zero, even before a feed is attached: the scanline term divides
        // the panel by this, and a zero pitch is a NaN across the whole quad.
        uFeedSize: { value: new THREE.Vector2(640, 480) },
        uLabel: { value: this._labelTexture },
        uTime: { value: 0 },
        uBoot: { value: 0 },
        uSignal: { value: 0 },
        uHarsh: { value: 0 },
        uAlert: { value: 0 },
        uJolt: { value: new THREE.Vector2() },
        uBattery: { value: 1 },
        uHp: { value: 1 },
        uRange: { value: 0 },
        uSweep: { value: 0 },
      },
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
      // Opaque, and depth-tested like any other piece of the handset: the quad
      // stands 2.5 mm proud of the bezel, so depth alone keeps the two apart.
      // Transparency would have cost a sort and bought nothing.
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), this.material);
    this.mesh.name = 'droneScreen';
    /*
     * Explicitly, here. `WeaponViewModel.assignLayer` traverses a weapon's group
     * when the weapon is REGISTERED, and this quad is parented in long
     * afterwards — so without this line it stays on the world layer, the world
     * camera draws a panel floating in the map, and the drone's own POV camera
     * sees the surface it is being drawn onto. See the header.
     */
    this.mesh.layers.set(LAYER_VIEWMODEL);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Matches the terminal's own pieces, which are all renderOrder 20, so the
    // panel is drawn in the same band as the slab it is set into.
    this.mesh.renderOrder = 21;

    /** @type {THREE.Object3D|null} the `screen` anchor we are parented to. */
    this.anchor = null;

    this._time = 0;
    this._boot = 0;
    this._signal = 0;
    this._harsh = 0;
    this._alert = 0;
  }

  /**
   * Parent the panel into a built terminal.
   *
   * @param {THREE.Object3D} weaponGroup the terminal weapon's `group`
   * @returns {boolean} false if the model has no `screen` anchor
   */
  attach(weaponGroup) {
    this.detach();
    const anchor = weaponGroup?.getObjectByName?.('screen') ?? null;
    if (!anchor) {
      // Loudly, because the failure is otherwise a terminal that is simply
      // blank: the anchor is found BY NAME, so renaming it in
      // `buildViewModel` breaks this with nothing thrown anywhere.
      console.warn('[DroneScreen] The terminal model has no "screen" anchor; the panel will not appear.');
      return false;
    }
    anchor.add(this.mesh);
    this.anchor = anchor;
    return true;
  }

  detach() {
    this.mesh.parent?.remove(this.mesh);
    this.anchor = null;
  }

  /**
   * @param {number} dt frame delta
   * @param {object|null} state `DroneSystem.hudState()`, optionally with a
   *   `distance` in metres from the pilot to the chassis
   */
  update(dt, state) {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this._time += step;

    const live = !!state?.deployed;

    // The boot animation restarts on every deploy, and is what the panel shows
    // while the deploy round trip is still in the air.
    this._boot = live ? Math.min(1, this._boot + step / BOOT_SEC) : 0;
    // Signal is instant on arrival — the boot wipe is the reveal — and fades on
    // the way out, so the last frame the drone ever sent stays up for a moment
    // and then dissolves rather than cutting to black.
    this._signal = live ? 1 : Math.max(0, this._signal - step / LOSS_SEC);
    /*
     * How violent the loss looked.
     *
     * DESTROYED and LOST are things that HAPPENED to the drone, and they get
     * the torn static. RECALLED and EXPIRED are the pilot's own decision and
     * the battery running out — both are orderly shutdowns, and dressing them
     * up as a kill would tell the player they were shot when they were not.
     */
    const loss = state?.lastLoss ?? null;
    this._harsh = (loss === DRONE_EVENT.DESTROYED || loss === DRONE_EVENT.LOST) ? 1 : 0;

    this._alert = Math.max(0, this._alert - step / ALERT_SEC);

    const u = this.material.uniforms;
    u.uTime.value = this._time;
    u.uBoot.value = this._boot;
    u.uSignal.value = this._signal;
    u.uHarsh.value = this._harsh;
    u.uAlert.value = this._alert;
    u.uBattery.value = clamp(state?.battery ?? 0, 0, 1);
    u.uHp.value = clamp((state?.hp ?? 0) / (state?.maxHp || DRONE.maxHealth), 0, 1);
    u.uRange.value = clamp((state?.distance ?? 0) / DISPLAY_RANGE_M, 0, 1);
    // A slow crawl rather than a real reflection: the honest version needs the
    // panel's world normal against a light, and a handset held in two hands
    // barely turns. This is enough to stop the glass reading as a flat sticker.
    u.uSweep.value = (this._time * 0.11) % 1.6 - 0.3;

    const jolt = this._alert * 0.012;
    u.uJolt.value.set(Math.sin(this._time * 61) * jolt, Math.cos(this._time * 47) * jolt * 0.75);
    /*
     * The slab itself shakes a third as much, and ONLY in its own plane.
     *
     * z is left at exactly zero because the anchor's 2.5 mm standoff from the
     * bezel is the whole reason the two faces do not z-fight — shaking it in z
     * would push the quad back into the bezel plane on half the cycle and the
     * panel would shimmer at precisely the moment the player is being told to
     * pay attention.
     */
    this.mesh.position.set(u.uJolt.value.x * 0.35, u.uJolt.value.y * 0.35, 0);
  }

  /**
   * The pilot's own body is being shot at.
   *
   * A committed pilot is blind, deaf and immobile, and telling them nothing is
   * unfair rather than tense. This says "something is happening to you" and
   * deliberately does not say what or from where — that is what standing up and
   * looking is for.
   *
   * @param {number} strength 0..1
   */
  alert(strength = 1) {
    this._alert = Math.max(this._alert, clamp(strength, 0, 1));
  }

  dispose() {
    this.detach();
    // Dropped, not disposed — `DroneFeed` owns the render target this points
    // at and may well still be rendering into it.
    this.material.uniforms.uFeed.value = null;
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._labelTexture?.dispose();
    this._labelTexture = null;
  }
}

/**
 * The SIGNAL LOST caption, as a texture rather than as glyphs in the shader.
 *
 * A packed bitmap font would need bitwise operators, which GLSL ES 1.00 — what
 * three compiles a `ShaderMaterial` to — does not have, so it would compile on
 * some machines and not others. A canvas draws it once, at boot, and costs one
 * 512x96 texture. Same idiom as the player name tags.
 */
function buildLabelTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 58px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('SIGNAL LOST', canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  // Only the alpha is read; the shader supplies the colour, so it never has to
  // be decoded from a colour space at all.
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

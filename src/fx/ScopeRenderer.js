/**
 * ScopeRenderer — true optical scopes via a dedicated render-to-texture camera.
 *
 * How it works
 * ------------
 * 1. A second `PerspectiveCamera` (`scopeCamera`) is placed at exactly the
 *    main camera's world transform, with a narrow FOV derived from the optic's
 *    magnification, and an **aspect of 1** so the image it produces is square.
 * 2. That camera is restricted to the WORLD layer. The first-person view model
 *    lives on the VIEWMODEL layer, so it is physically impossible for the
 *    weapon, barrel, magazine or any other geometry to appear inside the scope.
 * 3. The square texture is composited by a full-screen shader that masks it to
 *    a circle, draws the scope tube, a vector reticle with an illuminated
 *    centre dot, an eye-relief shadow, and darkens the periphery.
 *
 * Because the source is square and the mask is a circle sampled with matched
 * radial UVs, the sight picture is never stretched at any aspect ratio.
 *
 * RESOLUTION UNITS — the subtle one
 * ---------------------------------
 * The shader positions the circle from `gl_FragCoord`, which is measured in
 * **drawing-buffer pixels**, not CSS pixels. Feeding it the CSS size puts the
 * scope at `devicePixelRatio` times off-centre (a 1.5x display pushed it into
 * the lower-left quadrant). `setSize()` therefore reads the drawing buffer
 * size from the renderer itself and takes no arguments, so it cannot be
 * handed the wrong units.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils.js';

/** Rendering layers. Keep in sync with Game/WeaponViewModel. */
export const LAYER_WORLD = 0;
export const LAYER_VIEWMODEL = 1;

export const RETICLE_IDS = {
  none: 0,
  crosshair: 1,
  mildot: 2,
  chevron: 3,
  dot: 4,
  holo: 5,
  duplex: 6,
  german: 7,
};

/** Reticle styles the player can force from the settings menu. */
export const RETICLE_STYLES = [
  ['auto', 'Match the optic'],
  ['duplex', 'Duplex + dot'],
  ['mildot', 'Mil-dot'],
  ['german', 'German #4'],
  ['chevron', 'Chevron'],
  ['crosshair', 'Fine crosshair'],
  ['dot', 'Illuminated dot'],
];

const SCOPE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const SCOPE_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uScope;
  uniform vec2  uResolution;   // DRAWING BUFFER pixels, not CSS pixels
  uniform float uProgress;     // 0 = hidden, 1 = fully scoped
  uniform float uRadius;       // glass radius, in min-dimension units
  uniform int   uReticle;
  uniform vec3  uReticleColor;
  uniform vec3  uDotColor;
  uniform float uDotIntensity;
  uniform float uBreath;       // 1 = rested, 0 = out of breath
  uniform float uTime;
  uniform vec2  uEyeOffset;    // sway-driven eye-relief shift

  varying vec2 vUv;

  // ------------------------------------------------------- output transform
  // The sight picture has to be tone mapped and sRGB-encoded HERE, because
  // nothing else will do it.
  //
  // three.js only applies renderer.toneMapping and renderer.outputColorSpace
  // when the bound render target is null (WebGLPrograms.getParameters gates
  // both on exactly that). ScopeRenderer draws the world into a real render
  // target, so every material in it compiles with NoToneMapping and
  // LinearSRGBColorSpace, and the HalfFloat target ends up holding raw
  // unclamped linear radiance. The main frame is rescued by OutputPass at the
  // end of the composer; the scope overlay is a raw ShaderMaterial drawn
  // straight to the canvas afterwards, so it had no equivalent.
  //
  // The result was a sight picture 2-4x too dark with clipped highlights:
  // linear 0.18 reached the screen as 46/255 where the unscoped view showed
  // 127/255. Exposure and colour grade had no effect inside the circle either.
  //
  // All the shader maths above stays in linear — glass tint, eye relief, rim,
  // reticle mix — and only the final colour is transformed, which is exactly
  // the order the main pipeline uses. Constants are three's ACESFilmic chunk
  // verbatim, including the /0.6 pre-scale, so the two views match.
  vec3 acesFilmic(vec3 color) {
    const mat3 ACESInput = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 ACESOutput = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );
    color = ACESInput * (color / 0.6);
    color = (color * (color + 0.0245786) - 0.000090537)
          / (color * (0.983729 * color + 0.4329510) + 0.238081);
    return clamp(ACESOutput * color, 0.0, 1.0);
  }

  vec3 linearToSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055,
               step(vec3(0.0031308), c));
  }

  // ---------------------------------------------------------------- helpers
  // pxq is one drawing-buffer pixel expressed in reticle space, so every
  // stroke below is specified in pixels and stays crisp at any resolution.
  float bar(float dist, float halfWidth, float pxq) {
    return 1.0 - smoothstep(halfWidth - pxq, halfWidth + pxq, abs(dist));
  }
  float disc(vec2 p, float r, float pxq) {
    return 1.0 - smoothstep(r - pxq, r + pxq, length(p));
  }
  float ring(vec2 p, float r, float halfWidth, float pxq) {
    return 1.0 - smoothstep(halfWidth - pxq, halfWidth + pxq, abs(length(p) - r));
  }
  // A stroke along an axis, limited to a span: |other| in [from, to]
  float seg(float across, float along, float halfWidth, float from, float to, float pxq) {
    float m = bar(across, halfWidth, pxq);
    m *= step(from, abs(along)) * step(abs(along), to);
    return m;
  }

  /** Returns the reticle ink coverage, 0..1. */
  float reticle(vec2 q, float pxq) {
    float ink = 0.0;
    float fine = pxq * 1.0;    // ~2 px wide hairline
    float post = pxq * 3.4;    // ~7 px wide heavy post

    if (uReticle == 1) {                       // fine crosshair
      ink = max(ink, seg(q.y, q.x, fine, 0.035, 0.95, pxq));
      ink = max(ink, seg(q.x, q.y, fine, 0.035, 0.95, pxq));
    } else if (uReticle == 2) {                // mil-dot
      ink = max(ink, seg(q.y, q.x, fine, 0.03, 0.62, pxq));
      ink = max(ink, seg(q.x, q.y, fine, 0.03, 0.62, pxq));
      ink = max(ink, seg(q.y, q.x, post, 0.62, 0.98, pxq));
      ink = max(ink, seg(q.x, q.y, post, 0.62, 0.98, pxq));
      for (int i = 1; i <= 5; i++) {
        float d = float(i) * 0.105;
        float r = pxq * 2.2;
        ink = max(ink, disc(q - vec2( d, 0.0), r, pxq));
        ink = max(ink, disc(q - vec2(-d, 0.0), r, pxq));
        ink = max(ink, disc(q - vec2(0.0,  d), r, pxq));
        ink = max(ink, disc(q - vec2(0.0, -d), r, pxq));
      }
    } else if (uReticle == 3) {                // chevron + stem
      vec2 a = vec2(abs(q.x), q.y);
      float chev = bar(a.y - a.x * 0.9 + 0.015, pxq * 1.6, pxq);
      chev *= step(a.x, 0.085) * step(-0.10, q.y) * step(q.y, 0.03);
      ink = max(ink, chev);
      ink = max(ink, seg(q.x, q.y, fine, 0.12, 0.60, pxq) * step(q.y, 0.0));
      for (int i = 1; i <= 3; i++) {
        float d = -0.15 - float(i) * 0.11;
        ink = max(ink, disc(q - vec2(0.0, d), pxq * 2.0, pxq));
      }
      ink = max(ink, seg(q.y, q.x, fine, 0.16, 0.58, pxq));
      ink = max(ink, seg(q.y, q.x, post, 0.62, 0.98, pxq));
    } else if (uReticle == 4) {                // illuminated dot + witness ring
      ink = max(ink, ring(q, 0.34, pxq * 1.1, pxq) * 0.55);
    } else if (uReticle == 6) {                // DUPLEX: fine centre, heavy posts
      ink = max(ink, seg(q.y, q.x, fine, 0.028, 0.52, pxq));
      ink = max(ink, seg(q.x, q.y, fine, 0.028, 0.52, pxq));
      ink = max(ink, seg(q.y, q.x, post, 0.52, 0.98, pxq));
      ink = max(ink, seg(q.x, q.y, post, 0.52, 0.98, pxq));
    } else if (uReticle == 7) {                // GERMAN #4: three posts + hairline
      ink = max(ink, seg(q.y, q.x, post, 0.30, 0.98, pxq));          // left + right
      ink = max(ink, seg(q.x, q.y, post, 0.30, 0.98, pxq) * step(q.y, 0.0)); // bottom
      ink = max(ink, seg(q.x, q.y, fine, 0.045, 0.75, pxq) * step(0.0, q.y)); // fine top
      ink = max(ink, seg(q.y, q.x, fine, 0.045, 0.30, pxq));
    }
    return clamp(ink, 0.0, 1.0);
  }

  void main() {
    if (uProgress <= 0.001) discard;

    float minDim = min(uResolution.x, uResolution.y);
    vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / minDim;

    // The glass grows very slightly as the scope settles — reads as the eye
    // coming to the eyepiece rather than a hard cut.
    float radius = uRadius * mix(0.86, 1.0, smoothstep(0.0, 1.0, uProgress));
    float d = length(p);

    float aa = 1.5 / minDim;
    float inside = 1.0 - smoothstep(radius - aa, radius + aa, d);

    // ---- outside the glass: the scope tube --------------------------------
    if (inside <= 0.001) {
      // A solid tube wall hugging the glass.
      float tube = 1.0 - smoothstep(radius, radius * 1.34, d);
      // Fully opaque once scoped. This used to be mix(0.955, 1.0, tube),
      // which left 4.5% of the finished main frame bleeding through the
      // surround — and inverted, so the *largest* region was the leakiest.
      // Over a sunlit corrugated wall that read as a faint striped smear
      // that shimmered with the view, because it was a live un-anti-aliased
      // copy of it. A scope tube is opaque steel; it shows nothing.
      float alpha = uProgress;
      // Faint bevel highlight on the inner lip of the tube.
      float lip = (1.0 - smoothstep(radius, radius * 1.06, d)) * (1.0 - tube * 0.0);
      vec3 col = vec3(0.012, 0.014, 0.016) + vec3(0.05, 0.055, 0.06) * lip * 0.35;
      gl_FragColor = vec4(col, alpha);
      return;
    }

    // ---- sight picture ---------------------------------------------------
    vec2 q = p / radius;                 // normalised scope space, |q| <= 1
    float r2 = dot(q, q);

    // Gentle barrel distortion + chromatic fringe toward the rim.
    vec2 warp = q * (1.0 + 0.05 * r2);
    vec2 baseUv = warp * 0.5 + 0.5;
    float fringe = 0.0026 * r2;
    vec3 col;
    col.r = texture2D(uScope, baseUv + warp * fringe).r;
    col.g = texture2D(uScope, baseUv).g;
    col.b = texture2D(uScope, baseUv - warp * fringe).b;

    // Convert the captured world from linear radiance to display space right
    // here, before any of the overlay is composited over it. Everything below
    // — glass tint, eye relief, rim shading, reticle ink, dot glow, and the
    // tube colour in the branch above — was authored against display-space
    // values, back when the raw linear texel was (incorrectly) being written
    // straight to the canvas. Transforming at this point fixes the world
    // image's brightness without shifting the look of a single hand-tuned
    // overlay constant.
    col = linearToSRGB(acesFilmic(col));

    // Coated-glass tint and a soft lens glint.
    col = mix(col, col * vec3(0.94, 0.98, 1.07), 0.4);
    col += smoothstep(0.9, 0.25, length(q - vec2(-0.44, 0.46))) * 0.045;

    // ---- eye relief: a dark crescent when the eye is off the optical axis -
    float eye = length(q - uEyeOffset * 2.2);
    col *= 1.0 - smoothstep(0.55, 1.06, eye) * 0.92;

    // Rim shading so the glass has depth.
    col *= 1.0 - smoothstep(0.86, 1.0, length(q)) * 0.6;

    // ---- reticle ---------------------------------------------------------
    float pxq = 1.0 / (minDim * radius);
    float ink = reticle(q, pxq);
    col = mix(col, uReticleColor, ink * 0.97);

    // Illuminated centre dot — always drawn, on top of every reticle style.
    float dotR = pxq * 2.6;
    float dot = disc(q, dotR, pxq);
    float glow = 1.0 - smoothstep(dotR, dotR * 4.5, length(q));
    col += uDotColor * (dot * 1.5 + glow * 0.22) * uDotIntensity;

    // Out of breath: a red pulse at the rim warns the player.
    float gasp = (1.0 - uBreath) * (0.5 + 0.5 * sin(uTime * 9.0));
    col.r += gasp * smoothstep(0.5, 1.0, length(q)) * 0.14;

    gl_FragColor = vec4(col, uProgress);
  }
`;

export class ScopeRenderer {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(renderer, scene, settings) {
    this.renderer = renderer;
    this.scene = scene;
    this.settings = settings;

    this.active = false;
    this.progress = 0;

    this.scopeCamera = new THREE.PerspectiveCamera(12, 1, 0.1, 900);
    this.scopeCamera.layers.set(LAYER_WORLD);
    this.scopeCamera.rotation.order = 'YXZ';

    this._bufferSize = new THREE.Vector2();

    this._createTarget();
    this._createOverlay();
    this.setSize();

    this._onQuality = () => { this._createTarget(); this.setSize(); };
    settings.onChange('quality', this._onQuality);
    settings.onChange('renderScale', this._onQuality);
  }

  _createTarget() {
    this.target?.dispose();
    const q = this.settings.get('quality');
    const size = q === 'low' ? 512 : q === 'medium' ? 768 : q === 'ultra' ? 1536 : 1024;
    this.target = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: q === 'low' ? 0 : 4,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    if (this.material) this.material.uniforms.uScope.value = this.target.texture;
  }

  _createOverlay() {
    this.overlayScene = new THREE.Scene();
    this.overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScope: { value: this.target.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uProgress: { value: 0 },
        uRadius: { value: 0.42 },
        uReticle: { value: RETICLE_IDS.duplex },
        uReticleColor: { value: new THREE.Color(0x07090b) },
        uDotColor: { value: new THREE.Color(0xff3b26) },
        uDotIntensity: { value: 1 },
        uBreath: { value: 1 },
        uTime: { value: 0 },
        uEyeOffset: { value: new THREE.Vector2() },
      },
      vertexShader: SCOPE_VERT,
      fragmentShader: SCOPE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.overlayScene.add(quad);
    this.quad = quad;
  }

  /**
   * Resolve which reticle to draw: the player's forced style, or the optic's
   * own when set to "auto".
   */
  _resolveReticle(opticReticle) {
    const style = this.settings.get('reticleStyle') ?? 'auto';
    if (style !== 'auto' && RETICLE_IDS[style] !== undefined) return RETICLE_IDS[style];
    return RETICLE_IDS[opticReticle] ?? RETICLE_IDS.duplex;
  }

  /**
   * Prepare the scope for this frame.
   *
   * @param {THREE.PerspectiveCamera} camera  the main world camera
   * @param {number} progress   ADSSystem.scopeProgress
   * @param {object} opts       { fov, reticle, breath, time, sway }
   */
  update(camera, progress, opts) {
    this.progress = progress;
    this.active = progress > 0.002;
    if (!this.active) return;

    camera.getWorldPosition(this.scopeCamera.position);
    camera.getWorldQuaternion(this.scopeCamera.quaternion);
    this.scopeCamera.fov = opts.fov;
    this.scopeCamera.near = camera.near;
    this.scopeCamera.far = camera.far;
    this.scopeCamera.updateProjectionMatrix();

    const u = this.material.uniforms;
    u.uProgress.value = progress;
    u.uReticle.value = this._resolveReticle(opts.reticle);
    u.uBreath.value = clamp(opts.breath ?? 1, 0, 1);
    u.uTime.value = opts.time ?? 0;
    // Eye relief drifts with the optic sway; it settles as the scope steadies.
    const sway = opts.sway;
    if (sway) u.uEyeOffset.value.set(sway.x * 22, sway.y * 22);
    else u.uEyeOffset.value.set(0, 0);
  }

  /** Render the scope's view into its texture. Call before the main render. */
  renderTexture() {
    if (!this.active) return;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.scopeCamera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
  }

  /** Composite the scope overlay on top of the finished frame. */
  renderOverlay() {
    if (!this.active) return;
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.overlayScene, this.overlayCamera);
    this.renderer.autoClear = prevAutoClear;
  }

  /**
   * Sync the shader's idea of the screen size.
   *
   * Takes no arguments on purpose: `gl_FragCoord` is in drawing-buffer pixels,
   * so this must read the drawing buffer size, never the CSS size.
   */
  setSize() {
    this.renderer.getDrawingBufferSize(this._bufferSize);
    this.material.uniforms.uResolution.value.copy(this._bufferSize);
  }

  dispose() {
    this.target?.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

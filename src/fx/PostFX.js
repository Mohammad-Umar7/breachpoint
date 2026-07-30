/**
 * PostFX — the optional EffectComposer chain, plus the first-person
 * view-model pass.
 *
 * Pass order (each is optional except Render / ViewModel / Output):
 *
 *   Render(world)  ->  [SSAO]  ->  [DOF]  ->  ViewModel  ->  [Bloom]
 *                  ->  Grade+Vignette  ->  [Motion blur]  ->  [SMAA/FXAA]
 *                  ->  Output
 *
 * The **ViewModelPass** is the important one: it clears only the depth buffer
 * and re-renders the scene through the weapon camera, which is restricted to
 * the view-model layer. That draws the gun on top of the world without it
 * ever participating in world depth — so it cannot clip into walls, and the
 * scope camera (world layer only) can never see it.
 *
 * On the *low* preset the composer is skipped entirely and the renderer draws
 * straight to the canvas — the view model is then composited with a manual
 * depth clear, which is measurably faster on integrated GPUs.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { clamp, damp } from '../core/MathUtils.js';

/**
 * Draws the first-person weapon over the world.
 *
 * Written by hand rather than reusing `RenderPass({clearDepth:true})` because
 * that clears the depth of whatever target was bound *before* it binds its
 * own — which silently clears the wrong buffer inside a composer chain.
 */
class ViewModelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAutoClear;
  }
}

/**
 * Combined colour-grade + vignette + damage-tint pass.
 * Doing all three in one pass avoids two extra full-screen blits.
 */
const GradeVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uVignette: { value: 1.0 },
    uVignetteStrength: { value: 0.9 },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.1 },
    uLift: { value: new THREE.Vector3(0.005, 0.008, 0.016) },
    uGain: { value: new THREE.Vector3(1.02, 1.0, 0.97) },
    uDamage: { value: 0.0 },
    uGrade: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uVignette;
    uniform float uVignetteStrength;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uDamage;
    uniform float uGrade;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D( tDiffuse, vUv );
      // Exposure is applied here rather than through renderer.toneMappingExposure:
      // OutputPass owns that uniform and does not reliably re-upload it when the
      // value changes mid-session, which made the setting silently inert.
      // Scaling linear radiance before OutputPass tone-maps it is equivalent.
      vec3 c = texel.rgb * uExposure;

      if ( uGrade > 0.5 ) {
        c = c * uGain + uLift;
        c = ( c - 0.5 ) * uContrast + 0.5;
        float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
        c = mix( vec3( l ), c, uSaturation );
      }

      if ( uVignette > 0.5 ) {
        vec2 d = vUv - 0.5;
        float v = 1.0 - dot( d, d ) * uVignetteStrength * 1.9;
        c *= clamp( v, 0.0, 1.0 );
      }

      if ( uDamage > 0.001 ) {
        float edge = smoothstep( 0.15, 0.75, length( vUv - 0.5 ) );
        c = mix( c, vec3( 0.62, 0.03, 0.03 ), edge * uDamage * 0.85 );
      }

      gl_FragColor = vec4( clamp( c, 0.0, 8.0 ), texel.a );
    }
  `,
};

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {import('../core/Settings.js').Settings} settings
   * @param {THREE.Camera} [viewModelCamera]
   */
  constructor(renderer, scene, camera, settings, viewModelCamera = null) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;
    this.viewModelCamera = viewModelCamera;

    this.composer = null;
    this.enabled = false;
    this.gradePass = null;
    this.bloomPass = null;
    this.fxaaPass = null;
    this.ssaoPass = null;
    this.bokehPass = null;
    this.afterimagePass = null;
    this.damage = 0;
    this.focusDistance = 12;

    this._size = new THREE.Vector2();
    this.rebuild();

    for (const key of [
      'quality', 'bloom', 'antialias', 'ssao', 'colorGrade',
      'vignette', 'renderScale', 'motionBlur', 'depthOfField',
    ]) {
      settings.onChange(key, () => this.rebuild());
    }
    // Bloom strength and exposure are live — no chain rebuild needed.
    settings.onChange('bloomStrength', (v) => {
      if (this.bloomPass) this.bloomPass.strength = v;
      else this.rebuild();
    });
    settings.onChange('exposure', (v) => this.setExposure(v));
  }

  /** Scene brightness, applied in the grade pass. */
  setExposure(v) {
    if (this.gradePass) this.gradePass.uniforms.uExposure.value = v;
  }

  /** Called once the view model exists (it is built after PostFX). */
  setViewModelCamera(camera) {
    this.viewModelCamera = camera;
    this.rebuild();
  }

  /** Tear down and recreate the pass chain from current settings. */
  rebuild() {
    this.dispose(false);

    const s = this.settings;
    const quality = s.get('quality');
    const wantBloom = s.get('bloom') && s.get('bloomStrength') > 0.001;
    const wantAA = s.get('antialias');
    const wantSSAO = s.get('ssao');
    const wantGrade = s.get('colorGrade');
    const wantVignette = s.get('vignette');
    const wantMotionBlur = s.get('motionBlur');
    const wantDof = s.get('depthOfField');

    const anyEffect =
      wantBloom || wantAA || wantSSAO || wantGrade || wantVignette || wantMotionBlur || wantDof;
    if (quality === 'low' || !anyEffect) {
      this.enabled = false;
      return;
    }

    this.renderer.getDrawingBufferSize(this._size);
    const w = Math.max(1, Math.floor(this._size.x));
    const h = Math.max(1, Math.floor(this._size.y));

    try {
      const target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples: 0,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.setSize(w, h);

      this.composer.addPass(new RenderPass(this.scene, this.camera));

      if (wantSSAO) {
        this.ssaoPass = new SSAOPass(this.scene, this.camera, w, h);
        // kernelRadius is in view-space metres, but minDistance/maxDistance
        // are NOT — SSAOShader compares them against depth normalised over
        // (far - near). Feeding them metres made maxDistance 0.1 mean 60 m,
        // far outside the 0.5 m kernel, so every sample counted as occluded
        // and the pass drew broad dark halos around silhouettes instead of
        // contact shadows. Derive them from metres explicitly, and keep
        // maxDistance inside the kernel radius.
        const depthRange = this.camera.far - this.camera.near;
        this.ssaoPass.kernelRadius = 0.5;
        this.ssaoPass.minDistance = 0.005 / depthRange;
        this.ssaoPass.maxDistance = 0.4 / depthRange;
        this.composer.addPass(this.ssaoPass);
      }

      if (wantDof) {
        // Deliberately gentle: enough to separate the target from the
        // background when aiming, never enough to look like a photo filter.
        //
        // The numbers that matter here are the RATIO, not the aperture alone.
        // three's BokehShader computes `factor = focus - distance` in METRES,
        // then `clamp(factor * aperture, -maxblur, maxblur)` — so the blur
        // saturates at maxblur/aperture metres of defocus, and the ramp is
        // linear in metres regardless of how far away the focal plane is.
        //
        // The previous 0.00035 / 0.006 saturated at just 17.1 m, in an arena
        // spanning 1.8 m of floor to a 600 m sky. Measured on the Ultra
        // preset with focus on the far wall, 98% of the frame sat pinned at
        // maximum blur — a flat ~9 px disc over everything, with no depth
        // gradient left to read as depth of field. Whole-frame sharpness went
        // 36.74 on High to 12.45 on Ultra, and back to 36.72 with only this
        // pass disabled. It got worse when aiming for the obvious reason:
        // ADS is exactly when you point at something distant, so the entire
        // near and mid field went to the clamp at once.
        //
        // 0.0025 / 0.00003 gives an 83 m band, which keeps the arena readable
        // and softens only genuinely distant geometry. Lowering maxblur alone
        // would not have helped — the frame would still be fully clamped,
        // just less strongly.
        this.bokehPass = new BokehPass(this.scene, this.camera, {
          focus: 12,
          aperture: 0.00003,
          maxblur: 0.0025,
        });
        this.composer.addPass(this.bokehPass);
      }

      if (wantMotionBlur) {
        // Frame-accumulation blur: cheap, and reads as camera motion trails.
        //
        // Placed BEFORE the view model on purpose. AfterimagePass is a
        // ping-pong feedback loop — `max(newFrame, oldFrame * damp)` — so
        // anything drawn before it gets smeared across subsequent frames.
        // Sitting after the view model and the grade pass, it was trailing
        // the first-person weapon (which is rigidly locked to the camera and
        // can never have real motion blur) along with the vignette and the
        // damage tint. It was also what produced the orange smear beside the
        // gun: the muzzle-flash bloom held on screen for ~10 frames.
        //
        // The damp is re-normalised against 60 Hz every frame in render(),
        // because the shader's decay is per-FRAME. Left fixed, the trail
        // lasted longer in wall-clock time the lower the frame rate — worst
        // exactly where it hurts most.
        this.afterimagePass = new AfterimagePass(0.4);
        this.composer.addPass(this.afterimagePass);
      }

      // The weapon is drawn after world effects so it stays crisp.
      if (this.viewModelCamera) {
        this.composer.addPass(new ViewModelPass(this.scene, this.viewModelCamera));
      }

      if (wantBloom) {
        // Threshold well above 1.0 so only genuinely blown-out highlights
        // bloom. At the old 0.86 the whole sky qualified and the sun turned
        // into a screen-filling white smear.
        this.bloomPass = new UnrealBloomPass(
          new THREE.Vector2(w, h), s.get('bloomStrength'), 0.45, 1.15
        );
        this.composer.addPass(this.bloomPass);
      }

      this.gradePass = new ShaderPass(GradeVignetteShader);
      this.gradePass.uniforms.uGrade.value = wantGrade ? 1 : 0;
      this.gradePass.uniforms.uVignette.value = wantVignette ? 1 : 0;
      this.gradePass.uniforms.uExposure.value = s.get('exposure');
      this.composer.addPass(this.gradePass);

      if (wantAA) {
        if (quality === 'ultra' || quality === 'high') {
          this.composer.addPass(new SMAAPass(w, h));
        } else {
          this.fxaaPass = new ShaderPass(FXAAShader);
          this.fxaaPass.material.uniforms.resolution.value.set(1 / w, 1 / h);
          this.composer.addPass(this.fxaaPass);
        }
      }

      this.composer.addPass(new OutputPass());
      this.enabled = true;
    } catch (err) {
      console.error('[PostFX] Could not build composer — falling back to direct rendering.', err);
      this.composer = null;
      this.enabled = false;
    }
  }

  setSize() {
    this.renderer.getDrawingBufferSize(this._size);
    const width = Math.max(1, Math.floor(this._size.x));
    const height = Math.max(1, Math.floor(this._size.y));
    if (this.composer) {
      this.composer.setSize(width, height);
      if (this.fxaaPass) this.fxaaPass.material.uniforms.resolution.value.set(1 / width, 1 / height);
      if (this.bloomPass) this.bloomPass.setSize(width, height);
      if (this.ssaoPass) this.ssaoPass.setSize(width, height);
      if (this.bokehPass) this.bokehPass.setSize?.(width, height);
    }
  }

  /** 0..1 red screen tint driven by the player taking damage. */
  setDamage(v) {
    this.damage = v;
    if (this.gradePass) this.gradePass.uniforms.uDamage.value = v;
  }

  /**
   * Drive depth of field from what the player is actually looking at, so the
   * focal plane sits on the target rather than at an arbitrary distance.
   */
  setFocus(distance, dt) {
    this.focusDistance = damp(this.focusDistance, clamp(distance, 1.5, 200), 6, dt);
    if (this.bokehPass) {
      this.bokehPass.uniforms.focus.value = this.focusDistance;
    }
  }

  render(dt) {
    if (this.afterimagePass) {
      // AfterimageShader decays per FRAME, not per second, so a fixed damp
      // makes the trail last longer in wall-clock time at low frame rates.
      // Re-normalise against a 60 Hz reference so a trail is the same length
      // in seconds at 30 fps and at 144 fps. dt is capped so a single long
      // frame (alt-tab, asset hitch) cannot wipe the buffer to black.
      this.afterimagePass.uniforms.damp.value = Math.pow(0.4, Math.min(dt, 0.1) * 60);
    }
    if (this.enabled && this.composer) {
      this.composer.render(dt);
      return;
    }

    // Direct path (low preset): world, then the weapon over a cleared depth.
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
    if (this.viewModelCamera) {
      const oldAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.viewModelCamera);
      this.renderer.autoClear = oldAutoClear;
    }
  }

  dispose(full = true) {
    if (this.composer) {
      for (const pass of this.composer.passes) {
        pass.dispose?.();
        pass.material?.dispose?.();
      }
      this.composer.renderTarget1?.dispose();
      this.composer.renderTarget2?.dispose();
      this.composer = null;
    }
    this.gradePass = null;
    this.bloomPass = null;
    this.fxaaPass = null;
    this.ssaoPass = null;
    this.bokehPass = null;
    this.afterimagePass = null;
    if (full) this.enabled = false;
  }
}

export { ViewModelPass };

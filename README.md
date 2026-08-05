# BREACHPOINT

A complete browser-based first-person shooter built with **Three.js**, **Rapier 3D** physics and **Vite**.

Twelve weapons, true optical scopes, learnable recoil patterns, tactical leaning, seven enemy
archetypes with a twelve-state tactical AI, four difficulty tiers, and a full menu / loadout /
settings suite.

**Almost everything is generated at runtime.** Textures are painted into offscreen canvases (with
normal maps derived by a Sobel pass), models are built from primitives, and all sound is
synthesised with the Web Audio API. The single exception is the AR-15, which ships as a 340 KB
glTF model — and even that is optional: delete it and the rifle falls back to its procedural
version. A clean `npm install` is the only setup step.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open **http://localhost:5173** and click **DEPLOY**.

Production build:

```bash
npm run build
```

```bash
npm run preview
```

Requirements: a WebGL 2 browser (Chrome, Edge, Firefox, Safari 16+) and Node 18+.

---

## Game modes

Picked before the map — a mode changes the objective, the sides and what
winning means, so it is the first choice, not a variant of a map. Both are
defined in one place, `src/net/modes.js`, which the client and the server both
import; adding a third needs no new markup and no second copy of the rules.

**Free-for-all** — no teams, no objective. First to 25 eliminations, or the
most when the clock runs out.

**Capture the Flag** — red against blue, first to 3 captures. Each side has a
flag on a stand at its base:

- Walk onto the enemy flag to pick it up, carry it to your own base, and touch
  your own flag to score.
- **Your flag must be home for a capture to count.** With both flags out,
  neither side can score until one is recovered — the standoff every CTF match
  turns on. Without it the mode is two teams running past each other.
- Kill the carrier and the flag drops *where they fell*. It is not destroyed
  and it does not go home.
- A dropped flag is returned instantly by anyone on the team that owns it, and
  picked straight back up by anyone on the team that wants it. The rule is
  about teams, never about who was carrying it.
- A flag nobody touches goes home after 30 seconds, so one punted into a corner
  cannot freeze the match.
- **`F` drops the flag on purpose**, for handing it to someone in better shape
  to run it. The dropper is ignored by it for two seconds — otherwise you are
  standing on it and it comes straight back — while anyone else can take it
  the same instant, which is what makes it a pass rather than a fumble.

Friendly fire is off; a base is marked by a ring, a plinth and a light column
you can see from across the map, and both flags are drawn on the minimap —
pinned to the rim with their bearing when they are out of range.

The rules live on the server (`server/index.js`, `tickCTF`) and are proven by
`server/ctf-test.js`, which plays a full match over real sockets: taking,
capturing, dying with the flag, a teammate recovering it, and the standoff.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint — **hold breath** while scoped |
| `Space` | Jump |
| `Ctrl` / `C` | Crouch |
| `Q` / `E` | **Lean left / right** (hold or toggle) |
| Mouse | Look / aim |
| Left click | Fire |
| Right click | Aim down sights (hold or toggle) |
| `R` | Reload |
| `1` `2` `3` `4` | Primary / secondary / knife / frag |
| Mouse wheel | Cycle weapons — **zoom** while scoped |
| `X` | Previous weapon |
| `V` / `G` | Quick melee / quick grenade |
| `F` | **Drop the flag** you are carrying (Capture the Flag) |
| `B` | Toggle scope magnification |
| `T` | Inspect weapon |
| `Esc` / `P` | Pause |
| `F3` | FPS / draw-call readout |

---

## The arsenal

| Weapon | Class | Damage | Rate | Mag | Optic | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| M9 Sidearm | Pistol | 28 | 380 | 15 | Iron | Fast draw, forgiving |
| .50 Magnum | Pistol | 62 | 200 | 7 | Iron | Two-shot body, brutal kick |
| AR-15 Carbine | Assault | 24 | 720 | 30 | Red dot | Climb-then-drift spray |
| BR-3 Burst | Assault | 30 | 900 | 30 | Holographic | 3-round burst |
| MP-9 SMG | SMG | 17 | 1000 | 35 | Iron | Owns close quarters |
| M870 Breacher | Shotgun | 15 × 9 | 78 | 7 | Iron | Pump action, shell-by-shell reload |
| SPAS-12 Auto | Shotgun | 11 × 8 | 190 | 8 | Iron | Semi-auto |
| AWM | Sniper | 115 | 45 | 5 | **Scope 5× / 9×** | Bolt action, bullet drop |
| SR-25 Marksman | Sniper | 62 | 200 | 12 | **Scope 3.5×** | Semi-auto DMR |
| M249 SAW | LMG | 22 | 800 | 100 | Iron | Endless suppression |
| Combat Knife | Melee | 65 | — | — | — | ×3 backstab |
| M67 Frag | Throwable | 130 | — | 1 | — | 7.5 m blast, chain-reacts barrels |

You carry a primary + secondary (chosen in the loadout menu), plus the knife and grenades always.
All balance numbers live in `src/weapons/WeaponDefinitions.js`; angles are authored in degrees and
converted once at construction.

---

## Aiming, scopes and recoil

### Layer separation — why the scope is clean

The original scope bug (weapon geometry appearing inside the sight picture) is fixed at the root
rather than patched. There are two render layers:

```
LAYER_WORLD      arena, enemies, props, particles
LAYER_VIEWMODEL  the first-person weapon, and nothing else
```

The world camera and the scope camera are both restricted to `LAYER_WORLD`. A dedicated
view-model camera with its own FOV and a 1 cm near plane draws the weapon on top, via a custom
`ViewModelPass` that clears only the depth buffer. Consequences, all of them wanted:

- The weapon **cannot** clip into walls — it is not in the world depth pass.
- The weapon **cannot** appear inside a scope — the scope camera physically cannot see that layer.
- Changing world FOV or zooming an optic doesn't warp the gun.

*Verified: 137 view-model meshes, all on layer 1; `worldCanSeeGun: false`, `scopeCanSeeGun: false`.*

### Sniper scopes

A second `PerspectiveCamera` with **aspect 1** renders the world into a square texture at the
optic's magnification. A full-screen shader masks it to a circle with matched radial UVs (so the
sight picture is never stretched at any aspect ratio) and draws a full optic: a solid black tube
wall, an eye-relief shadow that drifts with the sway, barrel distortion, chromatic fringing at the
rim, lens shading, a coating glint, a vector reticle and an **illuminated red centre dot**. The
periphery is darkened rather than blacked out, so you keep some situational awareness.

Scope glass only fades in once the rifle is essentially shouldered (`scopeProgress` engages at 86%
of the ADS blend), so you never see the scope picture while the weapon is still swinging up.

Reticles are selectable in Settings → Gameplay → Optics: duplex + dot, mil-dot, German #4,
chevron, fine crosshair, or a bare illuminated dot. Strokes are specified in pixels and stay crisp
at any resolution.

Also included: adjustable zoom (5× / 9× on the AWM, cycled with the wheel or `B`), idle optical
sway, and a **breath-hold** on `Shift` that nearly stops the sway for ~3.4 s with a tunnel-vision
tell as it runs out.

> **Units matter here.** The shader positions the circle from `gl_FragCoord`, which is measured in
> *drawing-buffer* pixels. Feeding it the CSS size put the scope `devicePixelRatio`× off-centre —
> on a 1.5× display the circle sat in the lower-left quadrant and the crosshair fell outside it
> entirely. `ScopeRenderer.setSize()` now takes **no arguments** and reads the drawing buffer size
> from the renderer itself, so it cannot be handed the wrong units. *Verified centred to 0 px at
> pixel ratios from 0.5× to 3×, with the glass disc measuring 169.5–170 px across all four
> diagonals (0.5 px spread).*

### The authored assets

Every weapon and the enemy soldier are modelled in Blender and exported as glTF into
`public/models/`. **13 files, 2.0 MB, 45,580 triangles** in total:

| Asset | Tris | KB | Asset | Tris | KB |
|---|---:|---:|---|---:|---:|
| `sniper` (AWM chassis) | 8,300 | 369 | `shotgun` (M870) | 4,200 | 176 |
| `marksman` (SR-25) | 6,904 | 317 | `autoshotgun` (SPAS-12) | 4,284 | 175 |
| `ar15` (carbine) | 8,396 | 340 | `lmg` (M249) | 4,128 | 190 |
| `burst` (bullpup) | 2,988 | 158 | `grenade` (M67) | 1,992 | 71 |
| `smg` (MP-9) | 3,012 | 157 | `deagle` (.50) | 1,756 | 93 |
| `soldier` (16 parts) | 5,300 | 158 | `pistol` (M9) | 1,700 | 92 |
| | | | `knife` | 1,016 | 56 |

The sources live in `assets/blender/` — `gunlib.py` is a shared modelling library (primitives,
picatinny rails with real slots, M-LOK cut-outs, tapered forms, a parametric tactical scope, and
the merge/export pipeline) and `builds/<asset>.py` describes one asset each. `breachpoint_assets.blend`
holds the whole scene. Rebuilding is `exec` of the library plus a build script; every build returns
measured triangle counts, bounds and anchor positions rather than asking to be trusted.

Each weapon carries named empties that the engine reads: **`sight`** (the optical axis),
**`muzzle`**, **`eject`**, and — on the red-dot and holographic optics only — **`reticle`**.
Modelled with the barrel along Blender's `+Y` so the exporter's `(x,y,z) → (x,z,−y)` mapping lands
it on `−Z` forward. Verified in-engine: all 12 resolve their own `sight` node (none falls back to
the muzzle, the silent failure that would align ADS onto the wrong point) and every sight sits at
exactly `x = 0`.

Weapons merge by material into 3–6 meshes; the soldier merges by **part** instead, because
`Enemy.js` addresses `head`, `legL`, `armorPlate` and the rest by name to animate, tint,
hit-flash and toggle them. Its 16 parts each carry exactly one material — the export refuses to
run otherwise — so the engine can swap in its per-enemy cloned materials by part name.

**These are a progressive enhancement, not a dependency.** If a file is missing or fails to parse,
`AssetManager` logs a warning and that weapon silently falls back to its procedural model; if any
soldier part is missing, the enemy falls back to primitive boxes as a whole rather than wearing a
Blender torso on box legs. The game still boots from a checkout with an empty `public/` directory.

Three things had to be got right for the sight picture:

- **The optic is oversized and the view-model camera narrows on ADS** (65° → 40°). Real red dots
  fill your view because your eye is ~10 cm behind them; a 1:1-scale sight at a comfortable
  view-model FOV occupies about 14% of the screen and reads as "just a floating dot". At the
  shipped values the clear aperture spans **52%** of screen height and the hood **72%**.
- **The lens is an additive coating, not transparent glass.** Any *lit* transparent surface gets
  shaded by the view-model lights and mirrors the sky through the environment map, so even at 5%
  opacity it veils the target. Measured: a standard transparent lens preserved only **69%** of the
  world's contrast and lifted mean brightness by 0.16 — a milky disc. An additive coating can only
  add a faint blue sheen: **93% contrast retained**, brightness lift 0.02.
- **The muzzle flash depth-tests.** With depth testing off it painted straight over the optic
  housing and wiped out the whole sight on every shot. With it on, the tube occludes it and you see
  the flash only through the aperture. It also shrinks 45% and dims 45% while aimed, and the
  reticle draws after it so the dot stays readable. Blown-out area inside the aperture at peak
  flash: **8.2%**, down from near-total.

### ADS alignment is computed, not hand-tuned

Every weapon model carries a `sight` anchor at the exact centre of its aperture, dot or eyepiece.
`WeaponViewModel` translates the whole weapon so that anchor lands on the camera's forward axis.

*Verified across all ten aimable weapons: the sight anchor settles within **1 mm** of the camera
axis (|x|, |y| < 0.001) at the intended depth.* Adding a new weapon needs no ADS tuning at all.

### Recoil

Per-weapon **learnable patterns**: a list of `[pitch, yaw]` offsets indexed by shot number, with
only a small jitter on top. The AR-15 climbs for six rounds, drifts right, then snaps left. Recoil
is *additive to your own aim*, so dragging the mouse down mid-spray permanently lowers your pitch
and the crosshair settles below where it started — which is exactly what makes a pattern learnable.

*Measured on the AR-15: 0.55° → 8.71° climb over 12 rounds with the yaw drifting +1.96° then
pulling back, full recovery to 0.000°.*

Situational multipliers, all *measured* against a 0.942° hip-fire baseline:

| State | Per-shot pitch |
| --- | --- |
| Hip, still | 0.942° |
| Aiming | 0.657° (−30%) |
| Crouched | 0.799° (−15%) |
| Moving | 1.260° (+34%) |
| Airborne | 1.424° (+51%) |

View-model kick (Z push, pitch, roll) is sprung separately from camera recoil, so the gun jolts
without the crosshair snapping.

---

## Leaning

`Q` / `E` slide the camera up to 0.48 m sideways with a 13° roll. Because the *camera* moves, the
bullet origin and aim direction follow automatically — you really can shoot around the corner you
are peeking past. Movement drops to 58% while leaning, and sprinting is disabled.

Wall safety: a ray is cast along the lean direction every frame and the permitted distance is
clamped to the actual clearance, smoothed so sliding along a wall eases the lean rather than
snapping it.

*Verified: leaning into a perimeter wall clamps to 77% of full travel and the camera never ends up
inside geometry.*

---

## Menus and settings

A dark tactical theme over a **live 3D background** — the game camera flies a slow crane shot
around the warehouse while you're in the menu. Hover sweeps, click sounds, screen transitions,
keyboard focus, and a responsive layout down to phone widths.

Screens: main menu, difficulty (four cards with tactical meters), **loadout** (weapon browser with
stat bars computed from the real balance numbers), settings, controls, credits, pause, results.

**37 settings across four tabs**, generated from a schema in `MenuManager.js` so the markup can
never drift from the data:

- **Mouse** — sensitivity (0.1 – 5.0, default 1.0), horizontal/vertical trim, ADS multiplier,
  sniper multiplier, smoothing, acceleration, invert Y, aim hold/toggle, lean hold/toggle.
- **Graphics** — quality preset, FOV, weapon FOV, resolution scale, texture quality, shadow
  quality, particle density, AA, bloom, SSAO, motion blur, depth of field, colour grading,
  vignette, V-sync, frame-rate cap.
- **Audio** — master, SFX, music, voice, menu.
- **Gameplay** — difficulty, view bob, screen shake, crosshair size, damage numbers, hit direction.

Everything applies immediately, persists to `localStorage`, and has both a per-tab and a global
reset.

### Brightness and glare

The sun's Mie halo (`mieCoefficient`) and sky scattering (`rayleigh`) are what create screen-filling
white-out when you face the sun. Measured through the real composer chain, facing the sun's
azimuth: the original setup blew out **32%** of the frame; the shipped values blow out **10%**, and
0% in every other direction. The sun also sits at 42° elevation rather than 16°, so it is above the
normal eyeline while still casting long shadows.

Two live sliders in Settings → Graphics → Brightness & glare: **Exposure** and **Glare / bloom
amount** (set it to 0 to remove the glow entirely).

> Exposure is applied inside the grade pass, not through `renderer.toneMappingExposure`.
> `OutputPass` owns that uniform and does not re-upload it when the value changes mid-session, so
> the setting was silently inert. Scaling linear radiance before the tone-map is equivalent and
> actually works. *Verified: exposure 0.6 / 0.92 / 1.3 now produce 12.3% / 23.3% / 28.7% blown-out
> area.*

### How aim sensitivity is built

Four things used to multiply together — the global ADS multiplier, the global scope multiplier,
the weapon's own trim, and zoom compensation. On a 5× scope that compounded to **2.8% of hip-fire
speed**, which is why scoped aiming felt broken. The model is now:

```
turn rate = base × userMultiplier × zoomCompensation × weaponTrim
```

- **`zoomCompensation`** raises the FOV ratio to a power, so you choose how much magnification is
  allowed to slow the view. `1.0` is physically correct (a 9× scope turns 9× slower); `0.0` ignores
  magnification entirely. Full compensation is *right* but reads as sluggish, so the default is
  **0.5** — exposed as the **Zoom slowdown** slider.
- **`userMultiplier`** is one value, not two: the **Aim-down-sights speed** slider for iron sights,
  red dots and holographics; the **Sniper scope speed** slider *instead of it* whenever you are
  looking through a scope. They no longer stack. Scope defaults to **1.40**.
- **`weaponTrim`** is a light per-weapon touch (0.92 – 1.0), not a second big cut.

Net result on the AWM: scoped view turns at **0.58× hip-fire speed at 5×** and 0.43× at 9× —
against **0.18×** before, i.e. roughly three times faster. The Mouse tab shows a live
**Effective turn speed** readout so the numbers explain themselves.

### Recoil intensity

The authored patterns are the "realistic" reference, but the game defaults to **0.5× recoil** so it
is fun to pick up rather than something you have to train for. The AR-15 climbs 4.3° over twelve
rounds instead of 8.7°. Settings → Gameplay → **Recoil intensity** goes up to 1.5× if you want the
full learnable spray back.

ADS is also faster and less punishing than it was: transition times are ~30% shorter across the
arsenal and the movement penalty while aiming is smaller.

### Firing out of a sprint

Sprinting stows the weapon. Pulling the trigger now *ends the sprint* and the shot is held until
the weapon is actually shouldered (~0.13 s), instead of firing from a lowered gun. A semi-auto
click that lands mid-raise is buffered rather than swallowed, so the shot still comes out.

---

## Five bugs worth recording

Each of these was found by measuring rather than by reading, and in two cases the measurement
overturned a confident and plausible-sounding diagnosis. Numbers are from the running game.

**Leaning while aimed sent the bullet somewhere else.** `_computeAdsPose` places the sight anchor
exactly on the camera axis, and the bullet leaves along that axis — so any term added to
`holder.position`/`rotation` afterwards moves the reticle off the point of impact. Sway, bob, idle
and wall-push all faded out on ADS; lean did not, applying an unscaled X offset, yaw and roll. The
AR-15's dot sat **22.36° off axis at full lean — a 10.3 m miss at 25 m**. Now `leanStyle =
leanBlend * (1 - adsEase)`, and the induced error is ≤0.26° on every weapon. The camera still rolls
its full 13°, so peeking looks identical; only the view model's extra styling is suppressed.

**Selecting the knife left the sniper on screen.** `WeaponSystem.update()` captured
`const w = this.current` *above* `_handleSwitching()`, then handed that stale weapon to the view
model at the end of the same frame — where a `visible === hideForScope` toggle flipped the group
`onHolster()` had just hidden back ON. Every switch resurrected the outgoing weapon permanently.
Reading `this.current` after the switch fixes it; visibility is now asserted as an invariant over
all twelve groups rather than toggled on one, so it cannot re-enter that state.

**A third of all corpses stood up.** A 0.56 m square-based, 1.4 m, 78 kg box on a flat face is
*statically stable* — toppling it needs 1.85 rad/s at the tipping edge. `body.applyImpulse` applies
at the centre of mass and so contributes **zero** turning moment, and a face-on four-corner landing
at friction 0.85 ate what little the random torque produced. Measured **35% upright with a rifle,
15% with a sniper**. Fixed with an off-centre impulse at chest height, a guaranteed spin about the
tip axis, and a 32° pre-tilt away from the shot: now **2.4%**, and 38 of 41 land fully flat.
Deliberately *not* spawned flat at 90° — that reaches 0% but makes the corpse snap prone in a
single frame, trading an intermittent bug for a constant one.

**Ultra blurred the whole screen, and so did aiming the pistol.** Same bug. three's `BokehShader`
blurs linearly in *metres* of defocus and saturates at `maxblur / aperture`; at `0.006 / 0.00035`
that was **17.1 m**, in an arena spanning 1.8 m of floor to a 600 m sky. **98% of the frame sat
pinned at maximum blur** — a flat disc with no depth gradient left to read as depth of field.
Whole-frame sharpness measured 36.74 on High, 12.45 on Ultra, and 36.72 with only this pass off.
Now `0.0025 / 0.00003` for an **83 m band**. The orange smear beside the gun was separate: the
`AfterimagePass` sat *after* the view model and grade passes, trailing the weapon's own muzzle
bloom for ~10 frames. It now runs before the view model at damp 0.4, re-normalised against 60 Hz
each frame because the shader's decay is per-frame — left fixed, trails lasted *longer* the lower
the frame rate.

**The scope was 2.5× too dark.** three.js only applies `toneMapping` and `outputColorSpace` when
the bound render target is `null`. `ScopeRenderer` draws the world into a real target, so its
HalfFloat buffer held raw unclamped linear radiance — and unlike the main frame, which `OutputPass`
rescues, the overlay is a raw `ShaderMaterial` drawn straight to the canvas. Measured inside the
glass: midtones **0.222 → 0.557**, shadows 0.063 → 0.140, and highlights came off the clip at
1.000 → 0.955. ACES + sRGB is applied immediately after the texture fetch, so every hand-tuned
overlay constant below it keeps the look it was authored for. The surround was also only
95.5% opaque, bleeding a faint striped copy of the live main frame through the "black" tube; it is
now fully opaque.

---

## Performance

Measured on a mid-range desktop with 8 enemies on the final wave, firing continuously
(p50 per frame):

| Preset | Simulation | Render | Total | Draw calls |
| --- | --- | --- | --- | --- |
| Low | 1.0 ms | 1.7 ms | **2.7 ms** | 269 |
| High (hip fire) | 1.8 ms | 3.0 ms | **4.8 ms** | 483 |
| High (scoped) | 1.1 ms | 2.1 ms | **3.2 ms** | 613 |
| Ultra | 1.4 ms | 4.8 ms | **6.2 ms** | 1398 |

All comfortably inside the 16.6 ms budget for 60 FPS, with headroom for 144 Hz. The scope's extra
full-scene render pass costs almost nothing.

Techniques: object pooling for every transient effect, `InstancedMesh` for particles/decals/shells,
merged static geometry (one draw call per material), one shadow-casting light, fixed-timestep
physics with render interpolation, throttled and phase-offset AI sensing, and hard lifetime caps on
particles and decals.

> **A note on glass:** the windows were originally `MeshPhysicalMaterial` with `transmission`. That
> forces three.js to re-render the entire opaque scene into a separate buffer every frame — it
> measured at **25 ms**, more than the whole frame budget. They are now alpha-blended standard
> material with a strong environment reflection (visually indistinguishable for thin, grimy panes),
> and all panes are merged into a single mesh. Total saving: **~34 ms per frame.**

---

## Project structure

```
assets/blender/
├── gunlib.py                   Shared modelling library + merge/export pipeline
├── builds/<asset>.py           One build script per asset (12 weapons + soldier)
└── breachpoint_assets.blend    The Blender scene, one collection per asset
public/
└── models/*.glb                13 authored assets (optional — fallbacks exist for all)
src/
├── main.js                     Entry point, global error handling, HMR disposal
├── Game.js                     System wiring, state machine, main loop, render order
├── core/
│   ├── InputManager.js         Keyboard, mouse, Pointer Lock, edge detection
│   ├── AssetManager.js         Procedural textures, materials, sprite atlas
│   ├── Settings.js             Persistent settings + quality presets
│   ├── SensitivityManager.js   Mouse delta -> camera rotation, zoom compensation
│   ├── HardwareProfile.js      Quality auto-detection + the frame-rate governor
│   └── MathUtils.js            clamp / lerp / damp / RNG helpers
├── physics/PhysicsWorld.js     Rapier wrapper: fixed step, raycasts, explosions
├── world/
│   ├── Level.js                The toolkit maps are built with, and teardown
│   ├── maps/index.js           Map registry — add a map here and nowhere else
│   ├── maps/warehouse.js       WAREHOUSE layout: industrial yard, 70 m
│   ├── maps/outpost.js         OUTPOST layout: desert trading post, 50 m
│   ├── maps/villa.js           VILLA layout: sealed modern house, 26 m, 3 storeys
│   ├── MapThumbnail.js         The game photographs its own maps for the picker
│   └── PickupManager.js        Health / armour / ammo pickups and drops
├── player/
│   ├── Player.js               Character controller, camera, vitals
│   └── LeanSystem.js           Wall-clamped tactical peeking
├── weapons/
│   ├── WeaponDefinitions.js    Balance data for all 12 weapons
│   ├── Weapon.js               Per-gun state machine + procedural view model
│   ├── WeaponSystem.js         Loadout, hitscan, projectiles, melee, grenades
│   ├── WeaponViewModel.js      View-model camera, layers, pose composition
│   ├── ADSSystem.js            Aim blend, zoom, scope engagement, breath hold
│   └── RecoilSystem.js         Pattern-driven camera and view-model kick
├── net/
│   ├── protocol.js             Wire format — SHARED with the server
│   ├── NetworkClient.js        Socket, interpolation, prediction
│   ├── RemotePlayers.js        Other players' bodies, IK, lean, name tags
│   ├── RemoteAudio.js          Other players' footsteps, landings, reloads
│   ├── wireNetwork.js          Every multiplayer callback, wired to the game
│   ├── FlagObjects.js          CTF flags and bases — presentation only
│   ├── modes.js                Game modes and teams — SHARED with the server
│   └── arena.js                Bounds, spawn points, flag bases
├── fx/
│   ├── ParticleManager.js      Sparks, smoke, debris, tracers, shells, decals
│   ├── ScopeRenderer.js        Scope camera, RTT, circular mask, reticles
│   └── PostFX.js               Composer chain + the view-model pass
├── audio/AudioManager.js       Fully synthesised, positional Web Audio
└── ui/
    ├── UIManager.js            HUD and screen effects
    ├── MenuManager.js          Every menu, schema-driven settings
    └── Minimap.js              Overhead corner map, drawn as flat 2D
server/
├── index.js                    Authoritative server: damage, kills, score, spawns
└── *-test.js                   Suites that need a live server
test/*.mjs                      Suites that do not
scripts/
├── test.mjs                    `npm test` — runs every suite, starts the server
├── deps.mjs                    `npm run deps` — blast radius before you cut
├── loadtest.mjs                `npm run loadtest` — how many players a box holds
├── lan.mjs                     `npm run lan` — serve to other machines
└── bot.mjs                     `npm run bot` — a practice player, to test alone
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for what each module owns, which
things are shared between areas, and step-by-step recipes for adding a weapon,
a network message, a sound or a HUD element.

---

## Using real assets instead

Everything is procedural, but the seams are in place:

- `AssetManager.tryLoadExternal(materialName, { map, normalMap, roughnessMap })` swaps in real
  texture files and silently keeps the procedural fallback on any failure.
- `AudioManager.registerBuffer(name, audioBuffer)` makes `play(name)` use a decoded sample instead
  of the synth for that sound.

## Debugging

The game instance is exposed as `window.__game`:

```js
__game.player.position
__game.enemies.activeEnemies.map(e => [e.typeId, e.state, e.awareness.toFixed(2)])
__game.weapons.recoil            // live recoil accumulators
__game.adsSystem                 // progress, scopeProgress, zoom, breath
__game.renderer.info.render      // draw calls / triangles for the whole frame
__game.settings.set('difficulty', 'extreme')
```

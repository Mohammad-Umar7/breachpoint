"""SOLDIER — enemy character, exported as separately named body parts.

ORIENTATION: faces +Y in Blender, which the exporter maps to -Z in three.js —
the direction Enemy.js already points its weapon and eye strip. Up is +Z,
boots on z=0, so part coordinates read directly as height off the ground.


WHY THIS LOOKS THE WAY IT DOES
------------------------------
The first version was built entirely from boxes, and boxes are exactly what
makes a low-poly figure read as a toy: every limb was a rectangular prism with
a 2 mm bevel, joined by a smaller cube standing in for the joint. That is the
Lego/Roblox silhouette, and no amount of texturing hides it.

Three changes do most of the work here:

  1. LIMBS ARE TAPERED CYLINDERS, not boxes. An arm that is round in section
     and narrower at the wrist than the elbow reads as an arm at any distance.
     This is the single biggest difference.
  2. JOINTS ARE SPHERES. A ball at the shoulder, elbow, hip and knee lets the
     limb rotate without a corner ever poking through, and removes the
     stacked-block look where two prisms meet.
  3. THE HEAD IS A HEAD. Smaller relative to the body (a blocky figure is
     usually 5 heads tall; this is now closer to 7), rounded, with a jaw that
     tapers rather than a second cube under the first.

Silhouette matters more than surface detail at gameplay range, so the gear —
plate carrier, pouches, helmet — is shaped to break up the outline rather than
to be admired up close.


PROPORTIONS ARE NOT FREE
------------------------
The engine animates fixed pivots and derives hitboxes from height fractions,
so these landmarks are load-bearing. Changing one means changing
SOLDIER_PIVOTS in AssetManager.js and re-solving the weapon-hold targets in
RemotePlayers.js to match:

    boots   z 0.00-0.12      hip pivot      z 0.86,  x +/-0.13
    torso   z 0.87-1.45      shoulder pivot z 1.42,  x +/-0.25
    head    z 1.45-1.69      elbow pivot    z 1.148, x +/-0.25
    helmet  z 1.60-1.76      hand centre    z 0.858
    total height 1.80 m

SHOULDER WIDTH was 0.30 per side and is now 0.25. That is a look change and a
mechanical one: with 0.562 m of arm and shoulders 0.60 m apart, the support
hand could not comfortably reach across to a weapon held on the other side —
the IK solver ran out of arm. Narrower shoulders both look less like a slab
and give the hold room to work.

Each part carries exactly one material so the engine can swap in its
per-enemy cloned material by part name and keep hit-flash and type tinting
working. Detail therefore comes from geometry, never from extra materials.
"""

begin("soldier")
m = mats()
# Palette maps 1:1 onto the engine's cloned materials:
#   fatigues -> matBody   gear -> matVest   skin -> matSkin
#   helmet   -> matHelmet armour -> matArmor  visor -> enemyEye
FAT = M("S_Fatigues", (0.052, 0.056, 0.048), 0.00, 0.82)
GEAR = M("S_Gear",    (0.030, 0.031, 0.030), 0.00, 0.74)
SKIN = M("S_Skin",    (0.240, 0.150, 0.105), 0.00, 0.66)
HELM = M("S_Helmet",  (0.040, 0.043, 0.040), 0.10, 0.62)
ARMR = M("S_Armor",   (0.150, 0.160, 0.175), 0.85, 0.44)
VISR = M("S_Visor",   (0.400, 0.060, 0.045), 0.00, 0.25, emit=(1.0, 0.16, 0.10), emit_str=2.0)

SHOULDER_X = 0.25          # must match SOLDIER_PIVOTS.armR in AssetManager.js
HIP_X = 0.13

# =========================================================================
#  HEAD  (matSkin)
#  Rounded cranium plus a tapering jaw. The old version was two stacked
#  cubes, which is most of why the figure read as a toy from the front.
# =========================================================================
sphere("head__skull", 0.093, (0, 0.004, 1.598), SKIN, 20, 14)
tbox("head__brow", 0.150, 0.150, 0.052, (0, 0.026, 1.622), mat=SKIN, bev=0.020, bev_seg=3,
     sx2=0.128, sz2=0.040)
tbox("head__jaw", 0.128, 0.150, 0.090, (0, 0.014, 1.522), mat=SKIN, bev=0.026, bev_seg=3,
     sx2=0.088, sz2=0.052)
cyl("head__neck", 0.048, 0.095, (0, -0.006, 1.448), 'Z', SKIN, 14, r2=0.055)
for sx in (-1, 1):
    sphere("head__ear%d" % sx, 0.024, (sx * 0.086, -0.008, 1.588), SKIN, 10, 7)

# =========================================================================
#  HELMET  (matHelmet) — modern high-cut ballistic shell
# =========================================================================
sphere("helmet__dome", 0.116, (0, 0.004, 1.634), HELM, 22, 14)
tbox("helmet__brim", 0.226, 0.078, 0.026, (0, 0.096, 1.626), mat=HELM, bev=0.011, bev_seg=2,
     sx2=0.180, sz2=0.020)
for sx in (-1, 1):
    # high-cut side rails, the current-issue silhouette
    box("helmet__rail%d" % sx, 0.012, 0.140, 0.024, (sx * 0.114, 0.005, 1.622),
        mat=HELM, bev=0.006, bev_seg=2)
    tbox("helmet__ear%d" % sx, 0.020, 0.098, 0.070, (sx * 0.110, -0.012, 1.582),
         mat=HELM, bev=0.014, bev_seg=2, sx2=0.014, sz2=0.050)
    box("helmet__strap%d" % sx, 0.012, 0.018, 0.086, (sx * 0.094, 0.010, 1.522),
        rot=(0, sx * 0.18, 0), mat=HELM, bev=0.004)
# NVG shroud on the brow and a counterweight pouch at the back: the two
# details that separate a modern helmet from a WWII one at 20 m.
box("helmet__shroud", 0.046, 0.044, 0.028, (0, 0.112, 1.676), mat=HELM, bev=0.008, bev_seg=2)
box("helmet__nvgarm", 0.024, 0.056, 0.022, (0, 0.140, 1.690), rot=(-0.35, 0, 0), mat=HELM, bev=0.005)
tbox("helmet__cwt", 0.128, 0.064, 0.072, (0, -0.114, 1.632), mat=HELM, bev=0.018, bev_seg=2,
     sx2=0.092, sz2=0.046)
ribs("helmet__velcro", 3, 0.148, 0.013, 0.005, (0, 0.052, 1.716), (0, -0.052, -0.013), HELM)

# =========================================================================
#  VISOR  (enemyEye) — the glowing strip that reads as "hostile"
# =========================================================================
tbox("visor__strip", 0.132, 0.020, 0.032, (0, 0.096, 1.586), mat=VISR, bev=0.007, bev_seg=2,
     sx2=0.108, sz2=0.024)

# =========================================================================
#  TORSO  (matBody)
#  Chest tapers down into a narrower waist rather than two equal slabs, and
#  the deltoids are spheres so the arm can swing without a corner appearing.
# =========================================================================
tbox("torso__chest", 0.348, 0.212, 0.330, (0, 0, 1.288), mat=FAT, bev=0.048, bev_seg=3,
     sx2=0.318, sz2=0.196)
tbox("torso__waist", 0.286, 0.184, 0.268, (0, 0, 1.000), mat=FAT, bev=0.044, bev_seg=3,
     sx2=0.330, sz2=0.206)
tbox("torso__hips", 0.310, 0.196, 0.110, (0, 0, 0.892), mat=FAT, bev=0.038, bev_seg=3,
     sx2=0.286, sz2=0.100)
for sx in (-1, 1):
    sphere("torso__delt%d" % sx, 0.086, (sx * (SHOULDER_X - 0.028), 0, 1.392), FAT, 16, 11)
cyl("torso__collar", 0.082, 0.062, (0, 0, 1.452), 'Z', FAT, 16, r2=0.070)

# =========================================================================
#  VEST  (matVest) — plate carrier. Enemy.js keeps a handle on this one as
#  `vestMesh`, so it stays a single part.
# =========================================================================
tbox("vest__front", 0.292, 0.070, 0.352, (0, 0.116, 1.248), mat=GEAR, bev=0.016, bev_seg=2,
     sx2=0.256, sz2=0.318)
tbox("vest__back", 0.292, 0.066, 0.360, (0, -0.114, 1.252), mat=GEAR, bev=0.016, bev_seg=2,
     sx2=0.256, sz2=0.326)
for sx in (-1, 1):
    tbox("vest__cummer%d" % sx, 0.052, 0.212, 0.176, (sx * 0.168, 0, 1.188), mat=GEAR,
         bev=0.014, bev_seg=2, sx2=0.040, sz2=0.150)
    box("vest__strap%d" % sx, 0.070, 0.188, 0.036, (sx * 0.094, 0, 1.428), mat=GEAR, bev=0.011, bev_seg=2)
# three rifle magazine pouches across the front, plus admin and radio
for i, sx in enumerate((-1.0, 0.0, 1.0)):
    tbox("vest__mag%d" % i, 0.074, 0.058, 0.128, (sx * 0.080, 0.158, 1.178), mat=GEAR,
         bev=0.012, bev_seg=2, sx2=0.062, sz2=0.118)
    box("vest__magflap%d" % i, 0.078, 0.028, 0.034, (sx * 0.080, 0.154, 1.250), mat=GEAR, bev=0.007)
tbox("vest__radio", 0.080, 0.064, 0.112, (-0.120, -0.144, 1.292), mat=GEAR, bev=0.014, bev_seg=2,
     sx2=0.066, sz2=0.096)
cyl("vest__antenna", 0.006, 0.165, (-0.120, -0.152, 1.428), 'Z', GEAR, 8, r2=0.0026)
tbox("vest__admin", 0.116, 0.042, 0.088, (0.094, 0.150, 1.332), mat=GEAR, bev=0.012, bev_seg=2,
     sx2=0.100, sz2=0.074)
box("vest__belt", 0.336, 0.216, 0.054, (0, 0, 0.930), mat=GEAR, bev=0.016, bev_seg=2)
box("vest__buckle", 0.062, 0.046, 0.044, (0, 0.110, 0.930), mat=GEAR, bev=0.009)
tbox("vest__dump", 0.098, 0.068, 0.122, (-0.150, -0.050, 0.892), mat=GEAR, bev=0.016, bev_seg=2,
     sx2=0.082, sz2=0.100)
tbox("vest__holster", 0.076, 0.068, 0.152, (0.156, 0.018, 0.858), mat=GEAR, bev=0.014, bev_seg=2,
     sx2=0.062, sz2=0.120)
# Thigh rig — breaks up the leg outline, which is otherwise a plain column.
box("vest__thighrig", 0.104, 0.078, 0.132, (0.168, 0.052, 0.700), rot=(0, 0.06, 0),
    mat=GEAR, bev=0.014, bev_seg=2)

# =========================================================================
#  ARMOUR  (matArmor) — hidden unless the enemy type is armoured, and hidden
#  again once the plate breaks, so it must not be fused to the vest.
# =========================================================================
# Sits *on* the carrier, not in front of it.
tbox("armorPlate__front", 0.300, 0.042, 0.376, (0, 0.140, 1.244), mat=ARMR, bev=0.014, bev_seg=2,
     sx2=0.262, sz2=0.336)
tbox("armorPlate__back", 0.300, 0.040, 0.376, (0, -0.138, 1.244), mat=ARMR, bev=0.014, bev_seg=2,
     sx2=0.262, sz2=0.336)
ribs("armorPlate__rib", 3, 0.306, 0.013, 0.013, (0, 0.158, 1.342), (0, 0, -0.096), ARMR)
for sx in (-1, 1):
    tag = "shoulderL" if sx < 0 else "shoulderR"
    # A curved pauldron rather than a slab: half a flattened sphere reads as
    # armour following the shoulder instead of a plank bolted to it.
    sphere(f"{tag}__cap", 0.098, (sx * (SHOULDER_X - 0.010), 0, 1.402), ARMR, 16, 11)
    ribs(f"{tag}__lame", 2, 0.118, 0.170, 0.014, (sx * (SHOULDER_X - 0.004), 0, 1.336),
         (0, 0, -0.044), ARMR)

# =========================================================================
#  ARMS  (matBody) — authored in world space; the engine offsets each mesh by
#  its shoulder pivot (+/-0.25, 1.42, 0) so rotation happens at the joint.
# =========================================================================
# The forearm is a SEPARATE part from the upper arm, and that separation is
# the whole reason the character can hold a weapon convincingly.
#
# With one rigid arm mesh there is no elbow, so the hand can only ever sit on
# the surface of a sphere around the shoulder. A weapon needs both hands at
# specific points at the same time, which that cannot do — the gun ends up
# floating near a hand rather than held in it.
#
# Split here, the engine gets a real two-bone chain (shoulder -> elbow ->
# wrist) and can solve IK: the right hand holds the grip, the left hand is
# driven onto the handguard, and the elbows bend wherever they have to.
#
# The elbow BALL stays with the upper arm so it sits exactly at the pivot and
# the forearm rotates around it — that is what stops a visible seam opening
# when the arm bends.
for sx in (-1, 1):
    tag = "armL" if sx < 0 else "armR"
    fore = "foreL" if sx < 0 else "foreR"
    X = sx * SHOULDER_X
    # Upper arm: thicker at the shoulder, narrowing to the elbow.
    cyl(f"{tag}__upper", 0.062, 0.272, (X, 0, 1.286), 'Z', FAT, 16, r2=0.050)
    sphere(f"{tag}__elbow", 0.052, (X, 0.002, 1.148), FAT, 14, 10)
    box(f"{tag}__sleeve", 0.116, 0.116, 0.070, (X, 0, 1.372), mat=FAT, bev=0.026, bev_seg=3)
    # Forearm: narrows again into the wrist.
    cyl(f"{fore}__arm", 0.050, 0.240, (X, 0, 1.020), 'Z', FAT, 16, r2=0.040)
    box(f"{fore}__pad", 0.074, 0.028, 0.082, (X, 0.052, 1.134), mat=FAT, bev=0.012, bev_seg=2)

for sx in (-1, 1):
    tag = "gloveL" if sx < 0 else "gloveR"
    X = sx * SHOULDER_X
    # Hand centre stays at z 0.858 — RemotePlayers measures the grip against it.
    tbox(f"{tag}__palm", 0.070, 0.086, 0.096, (X, 0.004, 0.858), mat=GEAR, bev=0.024, bev_seg=3,
         sx2=0.062, sz2=0.078)
    tbox(f"{tag}__fingers", 0.066, 0.066, 0.044, (X, 0.040, 0.820), rot=(0.35, 0, 0),
         mat=GEAR, bev=0.016, bev_seg=2, sx2=0.056, sz2=0.034)
    box(f"{tag}__thumb", 0.024, 0.046, 0.030, (X - sx * 0.034, 0.030, 0.876),
        rot=(0.2, 0, sx * 0.3), mat=GEAR, bev=0.008)
    cyl(f"{tag}__cuff", 0.048, 0.036, (X, 0, 0.916), 'Z', GEAR, 14, r2=0.043)

# =========================================================================
#  LEGS  (matBody) — same deal, offset by the hip pivot (+/-0.13, 0.86, 0).
# =========================================================================
for sx in (-1, 1):
    tag = "legL" if sx < 0 else "legR"
    X = sx * HIP_X
    # Thigh top runs above the 0.86 hip pivot and into the torso: at 0.86
    # exactly there is a daylight gap between leg and body that opens further
    # the moment the walk cycle swings the leg.
    cyl(f"{tag}__thigh", 0.090, 0.440, (X, 0, 0.668), 'Z', FAT, 18, r2=0.072)
    sphere(f"{tag}__knee", 0.074, (X, 0.004, 0.452), FAT, 16, 11)
    box(f"{tag}__kneepad", 0.112, 0.044, 0.116, (X, 0.070, 0.454), mat=FAT, bev=0.020, bev_seg=2)
    cyl(f"{tag}__calf", 0.072, 0.330, (X, -0.004, 0.245), 'Z', FAT, 18, r2=0.052)
    # blousing over the boot top
    cyl(f"{tag}__blouse", 0.064, 0.056, (X, -0.004, 0.128), 'Z', FAT, 16, r2=0.070)

for sx in (-1, 1):
    tag = "bootL" if sx < 0 else "bootR"
    X = sx * HIP_X
    tbox(f"{tag}__ankle", 0.112, 0.128, 0.086, (X, -0.004, 0.098), mat=GEAR, bev=0.022, bev_seg=3,
         sx2=0.100, sz2=0.070)
    tbox(f"{tag}__foot", 0.112, 0.248, 0.066, (X, 0.030, 0.048), mat=GEAR, bev=0.020, bev_seg=3,
         sx2=0.092, sz2=0.046)
    box(f"{tag}__sole", 0.120, 0.262, 0.026, (X, 0.030, 0.014), mat=GEAR, bev=0.009, bev_seg=2)
    ribs(f"{tag}__lace", 3, 0.088, 0.014, 0.009, (X, 0.078, 0.112), (0, -0.010, -0.026), GEAR)

PARTS = [
    "head", "helmet", "visor", "torso", "vest",
    "armorPlate", "shoulderL", "shoulderR",
    "armL", "armR", "foreL", "foreR", "gloveL", "gloveR",
    "legL", "legR", "bootL", "bootR",
]
RESULT = finish_parts("soldier", order=PARTS)

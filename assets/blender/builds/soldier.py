"""SOLDIER — enemy character, exported as separately named body parts.

ORIENTATION: faces +Y in Blender, which the exporter maps to -Z in three.js —
the direction Enemy.js already points its weapon and eye strip. Up is +Z,
boots on z=0, so part coordinates read directly as height off the ground.

PROPORTIONS ARE NOT FREE. Enemy.js derives hitboxes from height fractions of
a capsule and animates fixed pivots (hips at 0.86, shoulders at 1.42). Every
landmark below matches the procedural figure it replaces:

    boots   z 0.00-0.12      hip pivot      z 0.86
    torso   z 0.87-1.45      shoulder pivot z 1.42
    head    z 1.45-1.69      eye strip      z 1.58
    helmet  z 1.60-1.76      total height   1.80 m

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

# =========================================================================
#  HEAD  (matSkin)
# =========================================================================
tbox("head__skull", 0.200, 0.215, 0.150, (0, 0, 1.600), mat=SKIN, bev=0.022, bev_seg=2)
tbox("head__jaw", 0.165, 0.185, 0.085, (0, 0.008, 1.500), mat=SKIN, bev=0.018, bev_seg=2,
     sx2=0.120, sz2=0.070)
box("head__neck", 0.105, 0.105, 0.090, (0, -0.005, 1.440), mat=SKIN, bev=0.020, bev_seg=2)
for sx in (-1, 1):
    box("head__ear%d" % sx, 0.022, 0.048, 0.062, (sx * 0.100, -0.010, 1.585), mat=SKIN, bev=0.008)

# =========================================================================
#  HELMET  (matHelmet) — modern high-cut ballistic shell
# =========================================================================
sphere("helmet__dome", 0.128, (0, 0.004, 1.628), HELM, 18, 12)
# Flatten the sphere into a helmet shell and clip everything below the brow.
box("helmet__brim", 0.262, 0.085, 0.030, (0, 0.108, 1.628), mat=HELM, bev=0.010)
for sx in (-1, 1):
    # high-cut side rails, the current-issue silhouette
    box("helmet__rail%d" % sx, 0.014, 0.150, 0.028, (sx * 0.128, 0.005, 1.618),
        mat=HELM, bev=0.006)
    box("helmet__ear%d" % sx, 0.020, 0.105, 0.070, (sx * 0.122, -0.012, 1.580),
        mat=HELM, bev=0.012)
    box("helmet__strap%d" % sx, 0.014, 0.020, 0.090, (sx * 0.104, 0.010, 1.520),
        rot=(0, sx * 0.18, 0), mat=HELM, bev=0.004)
# NVG shroud on the brow and a counterweight pouch at the back: the two
# details that separate a modern helmet from a WWII one at 20 m.
box("helmet__shroud", 0.052, 0.048, 0.030, (0, 0.128, 1.672), mat=HELM, bev=0.008)
box("helmet__nvgarm", 0.026, 0.060, 0.024, (0, 0.158, 1.686), rot=(-0.35, 0, 0), mat=HELM, bev=0.005)
tbox("helmet__cwt", 0.150, 0.070, 0.080, (0, -0.128, 1.630), mat=HELM, bev=0.016,
     sx2=0.110, sz2=0.055)
ribs("helmet__velcro", 3, 0.170, 0.014, 0.006, (0, 0.060, 1.716), (0, -0.058, -0.014), HELM)

# =========================================================================
#  VISOR  (enemyEye) — the glowing strip that reads as "hostile"
# =========================================================================
box("visor__strip", 0.150, 0.022, 0.038, (0, 0.108, 1.582), mat=VISR, bev=0.006)

# =========================================================================
#  TORSO  (matBody)
# =========================================================================
tbox("torso__chest", 0.430, 0.235, 0.330, (0, 0, 1.285), mat=FAT, bev=0.030, bev_seg=2,
     sx2=0.395, sz2=0.215)
tbox("torso__waist", 0.360, 0.205, 0.260, (0, 0, 1.000), mat=FAT, bev=0.026, bev_seg=2,
     sx2=0.420, sz2=0.230)
for sx in (-1, 1):
    box("torso__delt%d" % sx, 0.105, 0.190, 0.150, (sx * 0.212, 0, 1.395), mat=FAT, bev=0.030, bev_seg=2)
box("torso__collar", 0.185, 0.170, 0.070, (0, 0, 1.452), mat=FAT, bev=0.018)

# =========================================================================
#  VEST  (matVest) — plate carrier. Enemy.js keeps a handle on this one as
#  `vestMesh`, so it stays a single part.
# =========================================================================
tbox("vest__front", 0.330, 0.075, 0.360, (0, 0.128, 1.245), mat=GEAR, bev=0.014,
     sx2=0.300, sz2=0.330)
tbox("vest__back", 0.330, 0.070, 0.370, (0, -0.126, 1.250), mat=GEAR, bev=0.014,
     sx2=0.300, sz2=0.340)
for sx in (-1, 1):
    box("vest__cummer%d" % sx, 0.060, 0.235, 0.185, (sx * 0.196, 0, 1.185), mat=GEAR, bev=0.012)
    box("vest__strap%d" % sx, 0.078, 0.210, 0.040, (sx * 0.108, 0, 1.432), mat=GEAR, bev=0.010)
# three rifle magazine pouches across the front, plus admin and radio
for i, sx in enumerate((-1.0, 0.0, 1.0)):
    box("vest__mag%d" % i, 0.082, 0.062, 0.135, (sx * 0.090, 0.176, 1.175), mat=GEAR, bev=0.010)
    box("vest__magflap%d" % i, 0.086, 0.030, 0.038, (sx * 0.090, 0.172, 1.252), mat=GEAR, bev=0.006)
box("vest__radio", 0.090, 0.070, 0.120, (-0.135, -0.160, 1.290), mat=GEAR, bev=0.012)
cyl("vest__antenna", 0.007, 0.170, (-0.135, -0.168, 1.430), 'Z', GEAR, 8, r2=0.003)
box("vest__admin", 0.130, 0.045, 0.095, (0.105, 0.168, 1.330), mat=GEAR, bev=0.010)
box("vest__belt", 0.400, 0.245, 0.058, (0, 0, 0.930), mat=GEAR, bev=0.014)
box("vest__buckle", 0.070, 0.050, 0.048, (0, 0.124, 0.930), mat=GEAR, bev=0.008)
box("vest__dump", 0.110, 0.075, 0.130, (-0.170, -0.055, 0.895), mat=GEAR, bev=0.014)
box("vest__holster", 0.085, 0.075, 0.165, (0.176, 0.020, 0.860), mat=GEAR, bev=0.012)

# =========================================================================
#  ARMOUR  (matArmor) — hidden unless the enemy type is armoured, and hidden
#  again once the plate breaks, so it must not be fused to the vest.
# =========================================================================
# Sits *on* the carrier, not in front of it: the vest front face is already
# at y=0.166, so a plate centred at 0.170 stood 8 cm off the chest.
tbox("armorPlate__front", 0.360, 0.045, 0.400, (0, 0.152, 1.240), mat=ARMR, bev=0.012,
     sx2=0.320, sz2=0.360)
tbox("armorPlate__back", 0.360, 0.042, 0.400, (0, -0.150, 1.240), mat=ARMR, bev=0.012,
     sx2=0.320, sz2=0.360)
ribs("armorPlate__rib", 3, 0.370, 0.014, 0.014, (0, 0.172, 1.340), (0, 0, -0.100), ARMR)
for sx in (-1, 1):
    tag = "shoulderL" if sx < 0 else "shoulderR"
    tbox(f"{tag}__cap", 0.130, 0.200, 0.130, (sx * 0.238, 0, 1.400), mat=ARMR, bev=0.022, bev_seg=2,
         sx2=0.105, sz2=0.100)
    ribs(f"{tag}__lame", 2, 0.135, 0.190, 0.016, (sx * 0.240, 0, 1.330), (0, 0, -0.048), ARMR)

# =========================================================================
#  ARMS  (matBody) — authored in world space; the engine offsets each mesh by
#  its shoulder pivot (±0.30, 1.42, 0) so rotation happens at the joint.
# =========================================================================
for sx in (-1, 1):
    tag = "armL" if sx < 0 else "armR"
    tbox(f"{tag}__upper", 0.115, 0.125, 0.270, (sx * 0.298, 0, 1.288), mat=FAT,
         bev=0.026, bev_seg=2, sx2=0.098, sz2=0.105)
    box(f"{tag}__elbow", 0.105, 0.118, 0.075, (sx * 0.298, 0.006, 1.148), mat=FAT, bev=0.024, bev_seg=2)
    tbox(f"{tag}__fore", 0.098, 0.108, 0.235, (sx * 0.298, 0, 1.020), mat=FAT,
         bev=0.022, bev_seg=2, sx2=0.082, sz2=0.090)
    box(f"{tag}__pad", 0.086, 0.030, 0.090, (sx * 0.298, 0.062, 1.148), mat=FAT, bev=0.010)

for sx in (-1, 1):
    tag = "gloveL" if sx < 0 else "gloveR"
    box(f"{tag}__palm", 0.088, 0.100, 0.105, (sx * 0.298, 0.004, 0.858), mat=GEAR, bev=0.018, bev_seg=2)
    box(f"{tag}__fingers", 0.082, 0.075, 0.048, (sx * 0.298, 0.044, 0.818), rot=(0.35, 0, 0),
        mat=GEAR, bev=0.012)
    box(f"{tag}__cuff", 0.098, 0.104, 0.038, (sx * 0.298, 0, 0.914), mat=GEAR, bev=0.010)

# =========================================================================
#  LEGS  (matBody) — same deal, offset by the hip pivot (±0.13, 0.86, 0).
# =========================================================================
for sx in (-1, 1):
    tag = "legL" if sx < 0 else "legR"
    # Thigh top runs to z=0.885, above the 0.86 hip pivot and into the torso.
    # At 0.86 exactly there is a 19 mm daylight gap between leg and body that
    # opens further the moment the walk cycle swings the leg.
    tbox(f"{tag}__thigh", 0.168, 0.185, 0.430, (sx * 0.132, 0, 0.670), mat=FAT,
         bev=0.030, bev_seg=2, sx2=0.140, sz2=0.155)
    box(f"{tag}__knee", 0.148, 0.170, 0.090, (sx * 0.132, 0.008, 0.452), mat=FAT, bev=0.026, bev_seg=2)
    box(f"{tag}__kneepad", 0.130, 0.048, 0.130, (sx * 0.132, 0.086, 0.452), mat=FAT, bev=0.016)
    tbox(f"{tag}__calf", 0.140, 0.160, 0.330, (sx * 0.132, -0.004, 0.245), mat=FAT,
         bev=0.026, bev_seg=2, sx2=0.100, sz2=0.115)
    # blousing over the boot top
    box(f"{tag}__blouse", 0.128, 0.150, 0.055, (sx * 0.132, -0.004, 0.128), mat=FAT, bev=0.014)

for sx in (-1, 1):
    tag = "bootL" if sx < 0 else "bootR"
    box(f"{tag}__ankle", 0.132, 0.150, 0.090, (sx * 0.132, -0.004, 0.098), mat=GEAR, bev=0.018)
    tbox(f"{tag}__foot", 0.128, 0.265, 0.070, (sx * 0.132, 0.030, 0.048), mat=GEAR, bev=0.016,
         sx2=0.110, sz2=0.052)
    box(f"{tag}__sole", 0.138, 0.278, 0.028, (sx * 0.132, 0.030, 0.014), mat=GEAR, bev=0.008)
    ribs(f"{tag}__lace", 3, 0.100, 0.016, 0.010, (sx * 0.132, 0.088, 0.112), (0, -0.010, -0.028), GEAR)

PARTS = [
    "head", "helmet", "visor", "torso", "vest",
    "armorPlate", "shoulderL", "shoulderR",
    "armL", "armR", "gloveL", "gloveR",
    "legL", "legR", "bootL", "bootR",
]
RESULT = finish_parts("soldier", order=PARTS)

"""AWM BOLT-ACTION — modern chassis precision rifle.

Bore on z=0, muzzle towards +Y. ~1.27 m overall.

Shape notes, because the first pass got these wrong and they are what separate
a real-looking gun from an extruded rectangle:
  * The receiver, chassis and handguard are three *visibly separate* volumes
    with step changes between them, not one continuous slab.
  * The chassis forend tapers, so the underside is a line rather than a plane.
  * M-LOK slots are real gaps in the facets over a dark liner.
  * The optic sits 84 mm over bore. Higher than that and the rings read as
    stilts; this is roughly a modern 1.5" mount.
"""

begin("sniper")
m = mats()
# LIVERY — flat dark earth chassis, black furniture, blued barrel. The optic
# stays neutral tungsten (not FDE) so it reads as a bolt-on component rather
# than dissolving into the chassis it sits on.
m["alu"] = m["tungsten"]        # picked up by scope() for tubes and turrets
ST, AL, PL, OP, GL = m["steel"], m["fde"], m["poly"], m["optic"], m["glass"]
TUN = m["tungsten"]

RX_TOP = 0.0380        # receiver flat top -> receiver rail base
RAIL_TOP = RX_TOP + 0.0050 + 0.0055
SCOPE_Z = 0.0840       # optical axis over bore
HG_R = 0.0300          # handguard facet radius
HG_TOP = HG_R + 0.0035  # handguard top surface -> forward rail base

# ---- receiver + bolt ----------------------------------------------------
box("rx_body", 0.0460, 0.3000, 0.0580, (0, 0.0400, 0.0060), mat=ST, bev=0.0035)
box("rx_flat", 0.0420, 0.3000, 0.0080, (0, 0.0400, 0.0340), mat=ST, bev=0.0015)
# rear bolt shroud, stepping down to the firing-pin housing
cyl("rx_shroud", 0.0168, 0.0520, (0, -0.1280, 0.0180), 'Y', ST, 18)
cyl("rx_shroud2", 0.0125, 0.0200, (0, -0.1620, 0.0180), 'Y', ST, 16)
cyl("rx_pin", 0.0060, 0.0120, (0, -0.1740, 0.0180), 'Y', AL, 12)
# Bolt handle swept back and down with a ball knob — the silhouette that
# reads "bolt action" instantly at view-model distance.
box("bolt_arm", 0.0470, 0.0130, 0.0120, (0.0395, -0.0750, 0.0120),
    rot=(0, 0.42, 0), mat=ST, bev=0.0025)
sphere("bolt_knob", 0.0132, (0.0625, -0.0750, -0.0080), ST, 14, 8)
box("rx_port", 0.0080, 0.0680, 0.0250, (0.0235, 0.0150, 0.0190), mat=PL)
box("rx_defl", 0.0090, 0.0180, 0.0200, (0.0235, -0.0350, 0.0230),
    rot=(0, -0.35, 0), mat=ST, bev=0.0020)
box("rx_recoil", 0.0400, 0.0180, 0.0140, (0, 0.1650, -0.0300), mat=ST, bev=0.0022)

# ---- chassis: under the action only, tapering forward -------------------
# Keeping the chassis short is what opens the silhouette up; running it the
# full length of the barrel is what made the first pass look like a plank.
tbox("ch_body", 0.0500, 0.2900, 0.0450, (0, -0.0100, -0.0455), mat=AL, bev=0.0040,
     sx2=0.0430, sz2=0.0280, z_pivot=0.0225)
box("ch_flare", 0.0600, 0.1000, 0.0270, (0, -0.0480, -0.0660), mat=AL, bev=0.0055)
box("ch_nose", 0.0440, 0.0500, 0.0300, (0, 0.1300, -0.0330), mat=AL, bev=0.0035)
# lightening cuts down the chassis flank
ribs("ch_cut", 3, 0.0520, 0.0380, 0.0200, (0, -0.0450, -0.0430), (0, 0.0500, 0), PL)
cyl("ch_qd", 0.0070, 0.0540, (0, 0.0900, -0.0400), 'X', ST, 10)

box("mag_body", 0.0300, 0.0860, 0.0980, (0, -0.0480, -0.1150), mat=PL, bev=0.0035)
box("mag_plate", 0.0380, 0.0960, 0.0140, (0, -0.0480, -0.1700), mat=PL, bev=0.0045)
ribs("mag_wit", 3, 0.0308, 0.0060, 0.0035, (0, -0.0720, -0.0920), (0, 0, -0.0240), AL)
box("mag_catch", 0.0140, 0.0180, 0.0150, (0, -0.0890, -0.0770), mat=ST, bev=0.0020)

# ---- trigger group ------------------------------------------------------
box("tg_bottom", 0.0110, 0.0600, 0.0100, (0, -0.1150, -0.0940), mat=AL, bev=0.0022)
box("tg_front", 0.0110, 0.0100, 0.0360, (0, -0.0880, -0.0790), mat=AL, bev=0.0022)
box("tg_rear", 0.0110, 0.0100, 0.0360, (0, -0.1420, -0.0790), mat=AL, bev=0.0022)
box("trigger", 0.0075, 0.0095, 0.0260, (0, -0.1080, -0.0780), rot=(0.16, 0, 0), mat=ST, bev=0.0015)
box("safety", 0.0090, 0.0220, 0.0090, (0.0230, -0.1250, -0.0400), mat=ST, bev=0.0018)

# ---- pistol grip --------------------------------------------------------
tbox("grip", 0.0350, 0.0510, 0.1080, (0, -0.1720, -0.0950), rot=(0.20, 0, 0), mat=PL,
     bev=0.0060, sx2=0.0320, sz2=0.0930)
box("grip_tail", 0.0300, 0.0420, 0.0180, (0, -0.1620, -0.0380), mat=PL, bev=0.0045)
box("grip_cap", 0.0330, 0.0400, 0.0110, (0, -0.1930, -0.1480), mat=PL, bev=0.0035)
ribs("grip_tex", 5, 0.0357, 0.0055, 0.0135, (0, -0.1470, -0.0680), (0, -0.0055, -0.0170), PL,
     rot=(0.20, 0, 0))

# ---- free-float handguard ----------------------------------------------
cyl("hg_nut", 0.0355, 0.0300, (0, 0.2000, 0), 'Y', AL, 20)
knurl("hg_nutk", 0.0355, 0.0280, (0, 0.2000, 0), ST, n=16, axis='Y', tooth=0.0035, deep=0.0022)
# offset_deg=0 -> flat facets at 12/3/6/9 so the rail and M-LOK have
# somewhere real to sit. Slots cut through facets 2 and 6 (the two flanks).
octa_handguard("hg", 0.2140, 0.5400, HG_R, AL, facet_w=0.0248, thick=0.0070,
               offset_deg=0.0, slot_facets=(2, 6),
               slot_ys=[0.250 + 0.055 * i for i in range(5)],
               slot_len=0.0320, liner_mat=PL)
rail("hgrail", 0.2150, 0.5300, HG_TOP, AL, w=0.0200)
# ARCA-Swiss dovetail underneath — the current precision-rifle look.
box("arca", 0.0340, 0.1900, 0.0080, (0, 0.3250, -0.0375), mat=AL, bev=0.0014)
box("arca_l", 0.0070, 0.1900, 0.0070, (-0.0190, 0.3250, -0.0368), rot=(0, 0.70, 0), mat=AL)
box("arca_r", 0.0070, 0.1900, 0.0070, (0.0190, 0.3250, -0.0368), rot=(0, -0.70, 0), mat=AL)

# ---- barrel -------------------------------------------------------------
cyl("bl_shank", 0.0160, 0.0850, (0, 0.2275, 0), 'Y', ST, 20)
cyl("bl_main", 0.0122, 0.5450, (0, 0.5175, 0), 'Y', ST, 20, r2=0.0114)
# Six flutes dressed as raised ridges: a boolean groove costs far more
# geometry and reads identically at view-model distance. Placed on the
# *exposed* run past the handguard (which ends at 0.540) — inside it they
# would be 600 invisible triangles.
for i in range(6):
    a = math.radians(60.0) * i
    cyl("bl_flute%d" % i, 0.0033, 0.2050, (0.0126 * math.sin(a), 0.6750, 0.0126 * math.cos(a)),
        'Y', ST, 8)
cyl("bl_thread", 0.0116, 0.0240, (0, 0.7990, 0), 'Y', ST, 16)

# ---- muzzle brake: three baffles, open ports, side blast plates ---------
# The core deliberately overlaps the barrel end (0.790) so there is no gap.
cyl("mb_core", 0.0122, 0.1000, (0, 0.8450, 0), 'Y', ST, 18)
for i, y in enumerate((0.8080, 0.8360, 0.8640)):
    cyl("mb_baffle%d" % i, 0.0210, 0.0085, (0, y, 0), 'Y', ST, 20)
tube("mb_cap", 0.0210, 0.0128, 0.0200, (0, 0.8860, 0), 'Y', ST, 20)
tube("mb_crown", 0.0170, 0.0112, 0.0060, (0, 0.8990, 0), 'Y', ST, 18)
for sx in (-1, 1):
    box("mb_plate%d" % sx, 0.0040, 0.0880, 0.0290, (sx * 0.0207, 0.8430, 0.0055), mat=ST, bev=0.0012)

# ---- bipod, folded forward under the handguard --------------------------
# Deployed legs look wrong on a rifle carried at the shoulder, so it ships
# folded, and the legs stop inside the handguard footprint rather than
# hanging in open air past the end of it.
box("bp_mount", 0.0280, 0.0380, 0.0180, (0, 0.4550, -0.0410), mat=AL, bev=0.0030)
cyl("bp_hub", 0.0110, 0.0420, (0, 0.4550, -0.0500), 'X', ST, 14)
for sx in (-1, 1):
    box("bp_leg%d" % sx, 0.0110, 0.1050, 0.0110, (sx * 0.0300, 0.5100, -0.0430), mat=AL, bev=0.0022)
    box("bp_foot%d" % sx, 0.0150, 0.0220, 0.0130, (sx * 0.0300, 0.5730, -0.0430), mat=PL, bev=0.0032)

# ---- stock: skeletonised folding chassis --------------------------------
box("st_spine", 0.0280, 0.1900, 0.0360, (0, -0.2050, -0.0080), mat=AL, bev=0.0035)
box("st_upper", 0.0200, 0.2100, 0.0120, (0, -0.2250, 0.0240), mat=AL, bev=0.0025)
box("st_lower", 0.0200, 0.1600, 0.0120, (0, -0.2050, -0.0460), mat=AL, bev=0.0025)
box("st_brace", 0.0150, 0.0110, 0.0760, (0, -0.2780, -0.0160), rot=(0.55, 0, 0), mat=AL, bev=0.0022)
box("st_plate", 0.0320, 0.0160, 0.1100, (0, -0.3180, -0.0120), mat=AL, bev=0.0035)
box("st_pad", 0.0360, 0.0140, 0.0980, (0, -0.3320, -0.0120), mat=PL, bev=0.0060)
cyl("st_lop", 0.0120, 0.0140, (0, -0.3050, -0.0540), 'X', AL, 14)
cyl("st_qd", 0.0070, 0.0110, (0.0250, -0.2650, -0.0080), 'X', ST, 10)
box("st_mono", 0.0180, 0.0260, 0.0300, (0, -0.2950, -0.0560), rot=(0.25, 0, 0), mat=PL, bev=0.0035)
# adjustable cheek riser, sitting clear under the ocular bell
box("ck_pad", 0.0380, 0.1400, 0.0240, (0, -0.2000, 0.0380), mat=PL, bev=0.0055)
for sx in (-1, 1):
    for y in (-0.1600, -0.2450):
        cyl("ck_post", 0.0048, 0.0300, (sx * 0.0105, y, 0.0200), 'Z', ST, 10)
cyl("ck_knob", 0.0085, 0.0125, (0, -0.2450, 0.0320), 'X', AL, 12)

# ---- receiver rail + optic ---------------------------------------------
rail("rail", -0.0850, 0.1900, RX_TOP, AL, w=0.0210)
_parts, sight_pos = scope("sc", m, y_ocular=-0.1320, axis_z=SCOPE_Z)
scope_mount("mnt", (-0.0200, 0.1200), SCOPE_Z, RAIL_TOP, TUN)

# ---- anchors ------------------------------------------------------------
anchor("sight", sight_pos)                 # centre of the ocular lens
anchor("muzzle", (0.0, 0.9030, 0.0))       # crown of the brake
anchor("eject", (0.0285, 0.0150, 0.0190))  # ejection port lip
# No `reticle` empty: the optic is magnified, so ScopeRenderer owns the sight
# picture and a geometry dot would double up on it.

RESULT = finish("sniper")

"""BR-3 BURST — modern bullpup with a holographic sight. ~0.73 m.

Deliberately the odd one out in the rack: magazine *behind* the trigger,
grip well forward, no separate stock. That silhouette is doing real work —
it is how the player tells at a glance that they have the burst rifle and
not the carbine.

Carries a `reticle` anchor, so Weapon._buildReticle draws a real emitter
inside the hood. The holo window is a genuine pane of W_Glass, which
AssetManager swaps for an additive coating at load.
"""

begin("burst")
m = mats()
# LIVERY — olive drab shell over black furniture. PL stays black because this
# build uses it for BOTH furniture and every recessed cut (ports, scallops,
# muzzle slots, the M-LOK liner); tinting it would light up all the recesses
# too. The shell panels take OD explicitly instead.
ST, AL, PL, OP, GL, FDE = m["steel"], m["alu"], m["poly"], m["optic"], m["glass"], m["fde"]
OD = m["od"]

RAIL_Z = 0.0450
RAIL_TOP = RAIL_Z + 0.0050 + 0.0055
HOLO_Z = RAIL_TOP + 0.0340      # optical axis of the holo window

# ---- shell: one continuous polymer chassis, stock integral -------------
box("sh_body", 0.0460, 0.4600, 0.0740, (0, 0.0100, 0.0060), mat=OD, bev=0.0060)
box("sh_comb", 0.0400, 0.2600, 0.0180, (0, -0.0800, 0.0470), mat=OD, bev=0.0045)
box("sh_pad", 0.0430, 0.0170, 0.0820, (0, -0.2280, 0.0090), mat=PL, bev=0.0070)
box("sh_plate", 0.0390, 0.0130, 0.0740, (0, -0.2160, 0.0090), mat=AL, bev=0.0030)
box("sh_nose", 0.0400, 0.0900, 0.0520, (0, 0.2750, 0.0010), mat=OD, bev=0.0050)
cyl("sh_qd", 0.0068, 0.0500, (0, -0.1600, -0.0230), 'X', ST, 10)
# rear ejection port with a brass deflector — the bullpup's identifying detail
box("sh_port", 0.0085, 0.0620, 0.0250, (0.0225, -0.1250, 0.0140), mat=PL)
box("sh_defl", 0.0100, 0.0190, 0.0210, (0.0225, -0.1600, 0.0180), rot=(0, -0.34, 0), mat=AL, bev=0.0022)
# lightening scallops along the flank
ribs("sh_cut", 4, 0.0468, 0.0420, 0.0230, (0, -0.0350, -0.0100), (0, 0.0560, 0), PL)

# ---- magazine, behind the grip -----------------------------------------
box("mw_body", 0.0390, 0.0700, 0.0320, (0, -0.1150, -0.0430), mat=OD, bev=0.0040)
box("mag_body", 0.0280, 0.0640, 0.0900, (0, -0.1150, -0.0930), mat=PL, bev=0.0035)
box("mag_plate", 0.0330, 0.0720, 0.0110, (0, -0.1150, -0.1440), mat=PL, bev=0.0035)
ribs("mag_rib", 3, 0.0286, 0.0045, 0.0032, (0, -0.1350, -0.0680), (0, 0, -0.0230), AL)
box("mag_rel", 0.0110, 0.0150, 0.0160, (0, -0.0760, -0.0400), mat=AL, bev=0.0020)

# ---- trigger group + grip, well forward --------------------------------
box("tg_bottom", 0.0110, 0.0500, 0.0090, (0, 0.0400, -0.0500), mat=PL, bev=0.0020)
box("tg_front", 0.0110, 0.0090, 0.0260, (0, 0.0610, -0.0360), mat=PL, bev=0.0020)
box("tg_rear", 0.0110, 0.0090, 0.0260, (0, 0.0180, -0.0360), mat=PL, bev=0.0020)
box("trigger", 0.0070, 0.0090, 0.0220, (0, 0.0430, -0.0370), rot=(0.15, 0, 0), mat=ST, bev=0.0013)
tbox("grip", 0.0335, 0.0480, 0.0980, (0, -0.0060, -0.0560), rot=(0.20, 0, 0), mat=PL,
     bev=0.0055, sx2=0.0308, sz2=0.0870)
box("grip_cap", 0.0305, 0.0370, 0.0095, (0, -0.0280, -0.1030), mat=PL, bev=0.0028)
ribs("grip_tex", 4, 0.0341, 0.0050, 0.0125, (0, 0.0140, -0.0330), (0, -0.0050, -0.0165), AL,
     rot=(0.20, 0, 0))

# ---- forend + barrel ----------------------------------------------------
octa_handguard("hg", 0.3200, 0.4500, 0.0270, AL, facet_w=0.0222, thick=0.0062,
               offset_deg=0.0, slot_facets=(2, 6),
               slot_ys=[0.348 + 0.045 * i for i in range(3)],
               slot_len=0.0270, liner_mat=PL)
box("hg_stop", 0.0230, 0.0260, 0.0210, (0, 0.4100, -0.0400), rot=(-0.28, 0, 0), mat=PL, bev=0.0042)
cyl("bl_main", 0.0108, 0.2700, (0, 0.3900, 0), 'Y', ST, 18, r2=0.0100)
cyl("bl_thread", 0.0104, 0.0180, (0, 0.5150, 0), 'Y', ST, 16)
# four-port compensator
cyl("mz_body", 0.0155, 0.0520, (0, 0.5420, 0), 'Y', ST, 18)
for i, y in enumerate((0.5270, 0.5450)):
    for sx in (-1, 1):
        box("mz_port%d%d" % (i, sx), 0.0065, 0.0100, 0.0150, (sx * 0.0115, y, 0.0000), mat=PL)
tube("mz_crown", 0.0155, 0.0098, 0.0060, (0, 0.5710, 0), 'Y', ST, 18)

# ---- full-length top rail ----------------------------------------------
rail("rail", -0.2000, 0.4400, RAIL_Z, AL, w=0.0205)

# ---- holographic sight --------------------------------------------------
# An open hood over a single upright pane: two side walls and a roof, and
# nothing at all on the optical axis in front of or behind the glass.
#
# The first pass put a full-width front plate and a tall rear housing on that
# axis, which turned the sight into a solid block — you cannot aim through a
# holographic sight whose window is bricked up at both ends. Everything solid
# now lives strictly *below* the window: the electronics housing tops out at
# RAIL_TOP+0.017 and the pane starts at RAIL_TOP+0.019.
GLASS_H = 0.0300
GLASS_BOT = HOLO_Z - GLASS_H * 0.5           # = RAIL_TOP + 0.019
box("ho_base", 0.0300, 0.1150, 0.0110, (0, 0.0750, RAIL_TOP + 0.0055), mat=OP, bev=0.0022)
# electronics / battery housing, capped below the sight line
box("ho_rear", 0.0330, 0.0330, 0.0170, (0, 0.0330, RAIL_TOP + 0.0085), mat=OP, bev=0.0025)
for sx in (-1, 1):
    box("ho_btn%d" % sx, 0.0070, 0.0085, 0.0085, (sx * 0.0092, 0.0200, RAIL_TOP + 0.0090),
        mat=AL, bev=0.0013)
cyl("ho_batt", 0.0080, 0.0250, (0.0235, 0.0560, RAIL_TOP + 0.0090), 'X', OP, 14)
# open hood: uprights either side of the window plus a roof spanning them
for sx in (-1, 1):
    box("ho_wall%d" % sx, 0.0042, 0.0680, 0.0360, (sx * 0.0182, 0.0830, HOLO_Z + 0.0010),
        mat=OP, bev=0.0018)
box("ho_roof", 0.0405, 0.0680, 0.0050, (0, 0.0830, HOLO_Z + 0.0215), mat=OP, bev=0.0018)
# front lip only — a thin brow, not a plate across the aperture
box("ho_brow", 0.0405, 0.0090, 0.0075, (0, 0.1195, HOLO_Z + 0.0205), mat=OP, bev=0.0015)
# the pane itself, upright and square-on to the shooter
box("ho_glass", 0.0300, 0.0022, GLASS_H, (0, 0.1055, HOLO_Z), mat=GL)
box("ho_frame_b", 0.0330, 0.0060, 0.0040, (0, 0.1055, GLASS_BOT - 0.0018), mat=OP, bev=0.0010)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, 0.0300, HOLO_Z))     # eye side of the hood
anchor("reticle", (0.0, 0.1045, HOLO_Z))   # on the pane, 74 mm ahead
anchor("muzzle", (0.0, 0.5750, 0.0))
anchor("eject", (0.0260, -0.1250, 0.0140))

RESULT = finish("burst")

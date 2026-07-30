"""M870 BREACHER — short pump-action with a standoff muzzle. ~0.80 m.

The reads that matter at view-model distance: a vented heat shield over the
barrel, a grooved forend sitting on the magazine tube, a castellated breacher
standoff, and a side saddle of live shells. The shells are the single best
detail on the gun — brass heads and red hulls give the eye somewhere to land
on an otherwise all-black weapon.
"""

begin("shotgun")
m = mats()
# LIVERY — FDE receiver over black furniture, against a blued barrel and the
# brass-and-red side saddle that was always this gun's best feature.
ST, AL, PL, BR, HU, TR = m["steel"], m["fde"], m["poly"], m["brass"], m["hull"], m["tritium"]

RAIL_Z = 0.0330
RAIL_TOP = RAIL_Z + 0.0050 + 0.0055
SIGHT_Z = RAIL_TOP + 0.0175

# ---- receiver -----------------------------------------------------------
box("rx_body", 0.0440, 0.1900, 0.0580, (0, 0.0250, 0.0030), mat=AL, bev=0.0045)
box("rx_top", 0.0400, 0.1900, 0.0070, (0, 0.0250, 0.0295), mat=AL, bev=0.0018)
box("rx_port", 0.0080, 0.0800, 0.0250, (0.0215, 0.0300, 0.0060), mat=PL)
box("rx_liftgate", 0.0300, 0.0700, 0.0090, (0, 0.0300, -0.0250), mat=PL, bev=0.0018)
box("rx_safety", 0.0230, 0.0130, 0.0130, (0, -0.0600, -0.0180), mat=ST, bev=0.0020)
box("rx_slidelock", 0.0100, 0.0180, 0.0150, (-0.0210, -0.0520, -0.0210), mat=AL, bev=0.0018)

# ---- barrel, magazine tube, vented heat shield -------------------------
cyl("bl_main", 0.0148, 0.4000, (0, 0.3150, 0), 'Y', ST, 20)
cyl("mt_tube", 0.0132, 0.3400, (0, 0.2850, -0.0300), 'Y', ST, 18)
cyl("mt_cap", 0.0150, 0.0230, (0, 0.4600, -0.0300), 'Y', AL, 18)
box("bl_lug", 0.0230, 0.0400, 0.0230, (0, 0.1350, -0.0160), mat=ST, bev=0.0030)
# Heat shield: a run of ribs with real gaps rather than a solid sleeve, so
# the barrel shows through and it silhouettes as a cage.
for i in range(9):
    y = 0.1900 + 0.0330 * i
    tube("hs_rib%d" % i, 0.0215, 0.0175, 0.0180, (0, y, 0), 'Y', ST, 18)
for sx in (-1, 1):
    box("hs_spine%d" % sx, 0.0060, 0.2900, 0.0090, (sx * 0.0190, 0.3200, 0.0000), mat=ST, bev=0.0012)
box("hs_top", 0.0130, 0.2900, 0.0060, (0, 0.3200, 0.0200), mat=ST, bev=0.0012)

# ---- breacher standoff: castellated teeth ------------------------------
tube("bz_body", 0.0210, 0.0150, 0.0420, (0, 0.5350, 0), 'Y', ST, 20)
for i in range(6):
    a = math.radians(60.0) * i
    box("bz_tooth%d" % i, 0.0085, 0.0055, 0.0300,
        (0.0180 * math.sin(a), 0.5640, 0.0180 * math.cos(a)), rot=(0, a, 0), mat=ST, bev=0.0010)
box("bz_vent", 0.0300, 0.0220, 0.0110, (0, 0.5300, 0.0195), mat=PL)

# ---- pump forend: grooved, riding the magazine tube --------------------
box("pu_body", 0.0390, 0.1300, 0.0350, (0, 0.2900, -0.0330), mat=PL, bev=0.0055)
ribs("pu_groove", 7, 0.0396, 0.0075, 0.0230, (0, 0.2400, -0.0330), (0, 0.0165, 0), AL)
box("pu_stop", 0.0330, 0.0230, 0.0210, (0, 0.2200, -0.0420), rot=(-0.30, 0, 0), mat=PL, bev=0.0040)

# ---- grip, trigger, collapsing stock -----------------------------------
box("tg_bottom", 0.0110, 0.0490, 0.0090, (0, -0.0400, -0.0450), mat=AL, bev=0.0020)
box("tg_front", 0.0110, 0.0090, 0.0250, (0, -0.0180, -0.0310), mat=AL, bev=0.0020)
box("tg_rear", 0.0110, 0.0090, 0.0250, (0, -0.0620, -0.0310), mat=AL, bev=0.0020)
box("trigger", 0.0070, 0.0090, 0.0220, (0, -0.0360, -0.0320), rot=(0.15, 0, 0), mat=ST, bev=0.0013)
tbox("grip", 0.0340, 0.0490, 0.1020, (0, -0.0870, -0.0530), rot=(0.22, 0, 0), mat=PL,
     bev=0.0055, sx2=0.0312, sz2=0.0900)
box("grip_cap", 0.0310, 0.0380, 0.0095, (0, -0.1110, -0.1020), mat=PL, bev=0.0028)
ribs("grip_tex", 4, 0.0346, 0.0050, 0.0125, (0, -0.0690, -0.0300), (0, -0.0050, -0.0170), AL,
     rot=(0.22, 0, 0))
cyl("st_tube", 0.0195, 0.1500, (0, -0.1450, 0.0060), 'Y', AL, 18)
box("st_body", 0.0380, 0.1100, 0.0620, (0, -0.1750, 0.0020), mat=PL, bev=0.0060)
box("st_pad", 0.0400, 0.0160, 0.0800, (0, -0.2380, 0.0020), mat=PL, bev=0.0070)
box("st_plate", 0.0350, 0.0120, 0.0700, (0, -0.2270, 0.0020), mat=AL, bev=0.0030)
cyl("st_qd", 0.0068, 0.0100, (0.0210, -0.1300, -0.0180), 'X', ST, 10)

# ---- side saddle: five live shells on the left flank -------------------
for i in range(5):
    y = -0.0450 + 0.0300 * i
    cyl("ss_hull%d" % i, 0.0093, 0.0480, (-0.0290, y, 0.0060), 'X', HU, 14)
    cyl("ss_head%d" % i, 0.0097, 0.0110, (-0.0475, y, 0.0060), 'X', BR, 14)
box("ss_plate", 0.0060, 0.1600, 0.0300, (-0.0245, 0.0150, 0.0060), mat=AL, bev=0.0025)

# ---- rail + ghost ring sights ------------------------------------------
rail("rail", -0.0550, 0.1100, RAIL_Z, AL, w=0.0200, base_h=0.0050,
     rib_h=0.0055, pitch=0.0120, slot=0.0053)
box("rs_base", 0.0220, 0.0150, 0.0130, (0, -0.0350, RAIL_TOP + 0.0065), mat=AL, bev=0.0020)
tube("rs_ring", 0.0088, 0.0055, 0.0055, (0, -0.0350, SIGHT_Z), 'Y', ST, 16)
box("fs_base", 0.0230, 0.0170, 0.0130, (0, 0.4750, 0.0215), mat=ST, bev=0.0020)
box("fs_post", 0.0042, 0.0052, 0.0170, (0, 0.4750, SIGHT_Z - 0.0085), mat=ST, bev=0.0008)
cyl("fs_dot", 0.0018, 0.0022, (0, 0.4718, SIGHT_Z - 0.0080), 'Y', TR, 10)
for sx in (-1, 1):
    box("fs_ear%d" % sx, 0.0038, 0.0170, 0.0195, (sx * 0.0090, 0.4750, SIGHT_Z - 0.0095),
        mat=ST, bev=0.0008)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0350, SIGHT_Z))
anchor("muzzle", (0.0, 0.5800, 0.0))
anchor("eject", (0.0250, 0.0300, 0.0060))

RESULT = finish("shotgun")

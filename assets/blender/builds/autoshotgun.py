"""SPAS-12 AUTO — gas-operated combat shotgun. ~0.87 m.

Has to be readable as *not* the pump gun at a glance, so it differs in
silhouette rather than in decoration: a fat gas cylinder slung under the
barrel instead of a sliding forend, a full ribbed shroud, a side-folding
skeleton stock left extended, and a duckbill muzzle.
"""

begin("autoshotgun")
m = mats()
# LIVERY — tungsten receiver with oxblood accents on the controls and the
# shoulder hook. Reads as the exotic sibling of the FDE pump gun without
# repeating its colour.
ST, AL, PL, BR, HU, TR = m["steel"], m["tungsten"], m["poly"], m["brass"], m["hull"], m["tritium"]
CRM = m["crimson"]

RAIL_Z = 0.0360
RAIL_TOP = RAIL_Z + 0.0050 + 0.0055
SIGHT_Z = RAIL_TOP + 0.0180

# ---- receiver: deeper and squarer than the pump gun --------------------
box("rx_body", 0.0470, 0.2200, 0.0640, (0, 0.0300, 0.0040), mat=AL, bev=0.0050)
box("rx_top", 0.0430, 0.2200, 0.0070, (0, 0.0300, 0.0325), mat=AL, bev=0.0018)
box("rx_port", 0.0085, 0.0850, 0.0260, (0.0230, 0.0450, 0.0070), mat=PL)
box("rx_defl", 0.0100, 0.0200, 0.0220, (0.0230, -0.0050, 0.0110), rot=(0, -0.33, 0), mat=AL, bev=0.0024)
# side charging handle, the semi-auto tell
box("ch_arm", 0.0280, 0.0150, 0.0100, (-0.0300, 0.1150, 0.0180), mat=AL, bev=0.0018)
cyl("ch_knob", 0.0085, 0.0190, (-0.0430, 0.1150, 0.0180), 'X', CRM, 12)
box("rx_safety", 0.0240, 0.0140, 0.0140, (0, -0.0620, -0.0180), mat=ST, bev=0.0020)
ribs("rx_cut", 3, 0.0478, 0.0400, 0.0240, (0, -0.0250, -0.0060), (0, 0.0540, 0), PL)

# ---- barrel, gas system, full ribbed shroud ----------------------------
cyl("bl_main", 0.0152, 0.4300, (0, 0.3550, 0), 'Y', ST, 20)
cyl("gs_tube", 0.0165, 0.3600, (0, 0.3200, -0.0345), 'Y', ST, 18)
cyl("gs_cap", 0.0180, 0.0260, (0, 0.5120, -0.0345), 'Y', AL, 18)
cyl("gs_block", 0.0195, 0.0350, (0, 0.1500, -0.0345), 'Y', ST, 18)
for i in range(11):
    y = 0.1800 + 0.0320 * i
    tube("hs_rib%d" % i, 0.0222, 0.0180, 0.0170, (0, y, 0), 'Y', ST, 18)
for sx in (-1, 1):
    box("hs_spine%d" % sx, 0.0060, 0.3400, 0.0090, (sx * 0.0196, 0.3400, 0.0000), mat=ST, bev=0.0012)
box("hs_top", 0.0140, 0.3400, 0.0060, (0, 0.3400, 0.0206), mat=ST, bev=0.0012)

# ---- duckbill muzzle ----------------------------------------------------
tube("dk_body", 0.0210, 0.0155, 0.0380, (0, 0.5550, 0), 'Y', ST, 20)
for sz in (-1, 1):
    box("dk_lip%d" % sz, 0.0330, 0.0300, 0.0060, (0, 0.5880, sz * 0.0140),
        rot=(sz * 0.20, 0, 0), mat=ST, bev=0.0012)
box("dk_vent", 0.0300, 0.0200, 0.0110, (0, 0.5480, 0.0200), mat=PL)

# ---- grip, trigger, side-folding skeleton stock ------------------------
box("tg_bottom", 0.0110, 0.0500, 0.0090, (0, -0.0420, -0.0480), mat=AL, bev=0.0020)
box("tg_front", 0.0110, 0.0090, 0.0260, (0, -0.0190, -0.0340), mat=AL, bev=0.0020)
box("tg_rear", 0.0110, 0.0090, 0.0260, (0, -0.0650, -0.0340), mat=AL, bev=0.0020)
box("trigger", 0.0070, 0.0090, 0.0230, (0, -0.0380, -0.0350), rot=(0.15, 0, 0), mat=ST, bev=0.0013)
tbox("grip", 0.0345, 0.0500, 0.1050, (0, -0.0900, -0.0570), rot=(0.22, 0, 0), mat=PL,
     bev=0.0055, sx2=0.0316, sz2=0.0930)
box("grip_cap", 0.0315, 0.0390, 0.0095, (0, -0.1150, -0.1080), mat=PL, bev=0.0028)
ribs("grip_tex", 4, 0.0351, 0.0050, 0.0130, (0, -0.0710, -0.0330), (0, -0.0050, -0.0175), AL,
     rot=(0.22, 0, 0))
# skeleton stock: two struts and a hooked shoulder plate
box("st_block", 0.0400, 0.0320, 0.0480, (0, -0.0900, 0.0080), mat=AL, bev=0.0035)
box("st_upper", 0.0230, 0.1600, 0.0130, (0, -0.1750, 0.0250), mat=AL, bev=0.0025)
box("st_lower", 0.0230, 0.1500, 0.0130, (0, -0.1700, -0.0180), mat=AL, bev=0.0025)
box("st_brace", 0.0170, 0.0120, 0.0470, (0, -0.2250, 0.0040), rot=(0.42, 0, 0), mat=AL, bev=0.0022)
box("st_plate", 0.0330, 0.0140, 0.0900, (0, -0.2530, 0.0040), mat=AL, bev=0.0030)
box("st_pad", 0.0370, 0.0150, 0.0820, (0, -0.2660, 0.0040), mat=PL, bev=0.0065)
box("st_hook", 0.0330, 0.0400, 0.0140, (0, -0.2380, -0.0390), mat=CRM, bev=0.0025)
cyl("st_qd", 0.0068, 0.0100, (0.0215, -0.1300, -0.0180), 'X', ST, 10)

# ---- side saddle --------------------------------------------------------
for i in range(4):
    y = -0.0300 + 0.0300 * i
    cyl("ss_hull%d" % i, 0.0093, 0.0480, (-0.0310, y, 0.0080), 'X', HU, 14)
    cyl("ss_head%d" % i, 0.0097, 0.0110, (-0.0495, y, 0.0080), 'X', BR, 14)
box("ss_plate", 0.0060, 0.1300, 0.0300, (-0.0265, 0.0150, 0.0080), mat=AL, bev=0.0025)

# ---- rail + ghost ring sights ------------------------------------------
rail("rail", -0.0650, 0.1350, RAIL_Z, AL, w=0.0200, base_h=0.0050,
     rib_h=0.0055, pitch=0.0120, slot=0.0053)
box("rs_base", 0.0220, 0.0150, 0.0135, (0, -0.0400, RAIL_TOP + 0.0068), mat=AL, bev=0.0020)
tube("rs_ring", 0.0090, 0.0056, 0.0055, (0, -0.0400, SIGHT_Z), 'Y', ST, 16)
box("fs_base", 0.0235, 0.0170, 0.0130, (0, 0.5000, 0.0220), mat=ST, bev=0.0020)
box("fs_post", 0.0042, 0.0052, 0.0175, (0, 0.5000, SIGHT_Z - 0.0088), mat=ST, bev=0.0008)
cyl("fs_dot", 0.0018, 0.0022, (0, 0.4968, SIGHT_Z - 0.0082), 'Y', TR, 10)
for sx in (-1, 1):
    box("fs_ear%d" % sx, 0.0038, 0.0170, 0.0200, (sx * 0.0092, 0.5000, SIGHT_Z - 0.0098),
        mat=ST, bev=0.0008)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0400, SIGHT_Z))
anchor("muzzle", (0.0, 0.6000, 0.0))
anchor("eject", (0.0265, 0.0450, 0.0070))

RESULT = finish("autoshotgun")

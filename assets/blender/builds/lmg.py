"""M249 SAW — belt-fed squad automatic. ~1.03 m.

The mass is the point. A deep receiver, a hinged feed-tray cover carrying the
rail, a plastic ammo box hanging off the right side with a short run of
exposed belt and brass, a carry handle over a vented barrel, and a folded
bipod. It should look heavier than everything else in the rack.
"""

begin("lmg")
m = mats()
# LIVERY — olive drab receiver and feed cover. Reads as issued kit rather than
# a boutique build, which suits the one belt-fed in the rack.
ST, AL, PL, BR, TR = m["steel"], m["od"], m["poly"], m["brass"], m["tritium"]

RAIL_Z = 0.0480
RAIL_TOP = RAIL_Z + 0.0050 + 0.0055
SIGHT_Z = RAIL_TOP + 0.0190

# ---- receiver + feed tray cover ----------------------------------------
box("rx_body", 0.0560, 0.3200, 0.0800, (0, 0.0400, 0.0060), mat=AL, bev=0.0050)
box("rx_cover", 0.0520, 0.2600, 0.0180, (0, 0.0700, 0.0400), mat=AL, bev=0.0035)
ribs("rx_covrib", 4, 0.0524, 0.0110, 0.0130, (0, 0.0000, 0.0430), (0, 0.0480, 0), PL)
cyl("rx_hinge", 0.0075, 0.0500, (0, 0.1950, 0.0420), 'X', ST, 12)
box("rx_latch", 0.0180, 0.0160, 0.0150, (0, -0.0680, 0.0410), mat=AL, bev=0.0022)
box("rx_port", 0.0090, 0.0900, 0.0300, (0.0270, 0.0300, -0.0060), mat=PL)
box("rx_chute", 0.0180, 0.0700, 0.0260, (0, 0.0500, -0.0430), mat=AL, bev=0.0025)
box("ch_arm", 0.0300, 0.0170, 0.0110, (0.0330, 0.0900, 0.0000), mat=AL, bev=0.0018)
cyl("ch_knob", 0.0090, 0.0200, (0.0480, 0.0900, 0.0000), 'X', PL, 12)
ribs("rx_cut", 3, 0.0568, 0.0420, 0.0260, (0, -0.0300, -0.0060), (0, 0.0560, 0), PL)

# ---- ammo box + exposed belt -------------------------------------------
box("ab_body", 0.0720, 0.1450, 0.1250, (0.0080, 0.0150, -0.0980), mat=PL, bev=0.0070)
box("ab_lid", 0.0740, 0.1470, 0.0130, (0.0080, 0.0150, -0.0330), mat=PL, bev=0.0035)
box("ab_handle", 0.0180, 0.0700, 0.0130, (0.0080, 0.0150, -0.0210), mat=PL, bev=0.0030)
ribs("ab_rib", 3, 0.0724, 0.0110, 0.0900, (0.0080, -0.0300, -0.1050), (0, 0.0300, 0), AL)
# a short run of belt climbing from the box into the feed tray
for i in range(5):
    z = -0.0300 + 0.0130 * i
    y = 0.0150 + 0.0060 * i
    cyl("belt_rd%d" % i, 0.0048, 0.0330, (0.0180, y, z), 'X', BR, 10)
    box("belt_lk%d" % i, 0.0130, 0.0090, 0.0080, (0.0180, y, z), mat=ST, bev=0.0010)

# ---- barrel: vented sleeve, gas tube, carry handle ---------------------
cyl("bl_shank", 0.0195, 0.0700, (0, 0.2250, 0), 'Y', ST, 18)
cyl("bl_main", 0.0125, 0.3800, (0, 0.4200, 0), 'Y', ST, 18, r2=0.0115)
cyl("gas_tube", 0.0088, 0.3200, (0, 0.3800, -0.0270), 'Y', ST, 12)
cyl("gas_block", 0.0140, 0.0330, (0, 0.5450, -0.0270), 'Y', ST, 14)
for i in range(7):
    y = 0.2650 + 0.0320 * i
    tube("bs_rib%d" % i, 0.0190, 0.0150, 0.0150, (0, y, 0), 'Y', ST, 16)
for sx in (-1, 1):
    box("bs_spine%d" % sx, 0.0055, 0.2100, 0.0085, (sx * 0.0166, 0.3600, 0.0000), mat=ST, bev=0.0012)
# carry handle, folded down along the barrel
box("ca_base", 0.0260, 0.0400, 0.0180, (0, 0.2500, 0.0180), mat=AL, bev=0.0030)
box("ca_bar", 0.0150, 0.1600, 0.0130, (0, 0.3250, 0.0250), mat=PL, bev=0.0035)
box("ca_grip", 0.0190, 0.0800, 0.0170, (0, 0.3400, 0.0260), mat=PL, bev=0.0045)
cyl("bl_thread", 0.0118, 0.0200, (0, 0.6150, 0), 'Y', ST, 16)
# long-pronged flash hider
tube("fh_body", 0.0165, 0.0125, 0.0450, (0, 0.6400, 0), 'Y', ST, 18)
for i in range(3):
    a = math.radians(120.0) * i + math.radians(60.0)
    box("fh_prong%d" % i, 0.0070, 0.0380, 0.0040,
        (0.0143 * math.sin(a), 0.6810, 0.0143 * math.cos(a)), rot=(0, a, 0), mat=ST)
tube("fh_ring", 0.0165, 0.0128, 0.0055, (0, 0.7000, 0), 'Y', ST, 18)

# ---- bipod, folded back under the barrel -------------------------------
box("bp_mount", 0.0320, 0.0420, 0.0200, (0, 0.5100, -0.0430), mat=AL, bev=0.0030)
cyl("bp_hub", 0.0125, 0.0480, (0, 0.5100, -0.0510), 'X', ST, 14)
for sx in (-1, 1):
    box("bp_leg%d" % sx, 0.0120, 0.1500, 0.0120, (sx * 0.0330, 0.4300, -0.0470), mat=AL, bev=0.0022)
    box("bp_foot%d" % sx, 0.0170, 0.0250, 0.0140, (sx * 0.0330, 0.3450, -0.0470), mat=PL, bev=0.0032)

# ---- grip, trigger, stock ----------------------------------------------
box("tg_bottom", 0.0120, 0.0540, 0.0100, (0, -0.0900, -0.0560), mat=AL, bev=0.0022)
box("tg_front", 0.0120, 0.0100, 0.0290, (0, -0.0650, -0.0400), mat=AL, bev=0.0022)
box("tg_rear", 0.0120, 0.0100, 0.0290, (0, -0.1150, -0.0400), mat=AL, bev=0.0022)
box("trigger", 0.0075, 0.0095, 0.0250, (0, -0.0860, -0.0410), rot=(0.15, 0, 0), mat=ST, bev=0.0014)
tbox("grip", 0.0360, 0.0520, 0.1080, (0, -0.1420, -0.0640), rot=(0.22, 0, 0), mat=PL,
     bev=0.0060, sx2=0.0330, sz2=0.0950)
box("grip_cap", 0.0330, 0.0400, 0.0100, (0, -0.1670, -0.1160), mat=PL, bev=0.0030)
ribs("grip_tex", 4, 0.0366, 0.0055, 0.0135, (0, -0.1200, -0.0400), (0, -0.0052, -0.0180), AL,
     rot=(0.22, 0, 0))
tbox("st_body", 0.0400, 0.1900, 0.0760, (0, -0.1950, 0.0060), mat=PL, bev=0.0065,
     sx2=0.0340, sz2=0.0600)
box("st_pad", 0.0400, 0.0170, 0.0900, (0, -0.2980, 0.0020), mat=PL, bev=0.0070)
box("st_plate", 0.0350, 0.0130, 0.0800, (0, -0.2860, 0.0020), mat=AL, bev=0.0030)
box("st_rest", 0.0300, 0.0700, 0.0160, (0, -0.2500, -0.0350), rot=(-0.18, 0, 0), mat=PL, bev=0.0035)
box("st_comb", 0.0300, 0.1400, 0.0140, (0, -0.2050, 0.0480), mat=PL, bev=0.0035)
cyl("st_qd", 0.0072, 0.0110, (0.0245, -0.1300, -0.0180), 'X', ST, 10)

# ---- rail + irons -------------------------------------------------------
rail("rail", -0.0500, 0.1850, RAIL_Z, AL, w=0.0210)
box("rs_base", 0.0230, 0.0160, 0.0140, (0, -0.0280, RAIL_TOP + 0.0070), mat=AL, bev=0.0020)
for sx in (-1, 1):
    box("rs_wing%d" % sx, 0.0062, 0.0095, 0.0160, (sx * 0.0078, -0.0280, SIGHT_Z - 0.0080),
        mat=ST, bev=0.0010)
box("fs_base", 0.0240, 0.0180, 0.0150, (0, 0.5900, 0.0180), mat=ST, bev=0.0022)
box("fs_post", 0.0044, 0.0054, 0.0180, (0, 0.5900, SIGHT_Z - 0.0090), mat=ST, bev=0.0008)
cyl("fs_dot", 0.0019, 0.0023, (0, 0.5866, SIGHT_Z - 0.0085), 'Y', TR, 10)
for sx in (-1, 1):
    box("fs_ear%d" % sx, 0.0040, 0.0180, 0.0205, (sx * 0.0095, 0.5900, SIGHT_Z - 0.0100),
        mat=ST, bev=0.0008)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0280, SIGHT_Z))
anchor("muzzle", (0.0, 0.7050, 0.0))
anchor("eject", (0.0310, 0.0300, -0.0060))

RESULT = finish("lmg")

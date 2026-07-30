"""SR-25 MARKSMAN — AR-10 pattern semi-auto DMR.

Shares the AR family language with the carbine (same magwell geometry, same
charging handle, same monolithic top rail running unbroken from the upper
receiver across the handguard) but scaled up for 7.62 and wearing a fixed
3.5x optic — so the two read as siblings rather than reskins. ~1.15 m.

Heights are chosen so the handguard top surface lands exactly on the receiver
rail base: an AR's defining line is that unbroken rail, and a step there is
the first thing that makes one look wrong.
"""

begin("marksman")
m = mats()
# LIVERY — tungsten receiver under an FDE handguard: the two-tone build that
# distinguishes a DMR from the carbine it shares a family with.
m["alu"] = m["tungsten"]
ST, AL, PL, OP, GL, FDE = m["steel"], m["tungsten"], m["poly"], m["optic"], m["glass"], m["fde"]

RAIL_Z = 0.0365                          # receiver flat top
RAIL_TOP = RAIL_Z + 0.0050 + 0.0055
SCOPE_Z = 0.0810
HG_R = 0.0330                            # -> HG top = HG_R + 0.0035 = RAIL_Z

# ---- upper receiver -----------------------------------------------------
box("up_body", 0.0420, 0.2600, 0.0480, (0, 0.1000, 0.0125), mat=AL, bev=0.0035)
box("up_top", 0.0400, 0.2600, 0.0070, (0, 0.1000, 0.0330), mat=AL, bev=0.0015)
# forward assist and brass deflector: the two details that say "AR" at a glance
cyl("up_fa", 0.0088, 0.0200, (0.0225, 0.0120, 0.0090), 'Y', AL, 12)
cyl("up_fa2", 0.0060, 0.0090, (0.0225, -0.0020, 0.0090), 'Y', AL, 10)
box("up_defl", 0.0110, 0.0220, 0.0230, (0.0220, -0.0060, 0.0150), rot=(0, -0.32, 0), mat=AL, bev=0.0025)
box("up_port", 0.0080, 0.0700, 0.0240, (0.0210, 0.0300, 0.0100), mat=PL)
box("up_dust", 0.0060, 0.0680, 0.0200, (0.0240, 0.0300, 0.0090), mat=AL, bev=0.0018)
box("ch_handle", 0.0560, 0.0180, 0.0100, (0, -0.0350, 0.0300), mat=AL, bev=0.0022)
box("ch_latch", 0.0140, 0.0130, 0.0085, (-0.0250, -0.0420, 0.0300), mat=AL, bev=0.0018)

# ---- lower receiver, magwell, magazine ---------------------------------
box("lo_body", 0.0380, 0.1900, 0.0520, (0, 0.0100, -0.0260), mat=AL, bev=0.0040)
box("lo_well", 0.0450, 0.0760, 0.0580, (0, -0.0100, -0.0520), mat=AL, bev=0.0055)
box("lo_pin_f", 0.0430, 0.0100, 0.0100, (0, 0.0700, -0.0120), mat=AL, bev=0.0018)
box("lo_pin_r", 0.0430, 0.0100, 0.0100, (0, -0.0800, -0.0120), mat=AL, bev=0.0018)
# 20-round 7.62 magazine: the pronounced curve staged as two sections
box("mag_a", 0.0290, 0.0740, 0.0880, (0, -0.0130, -0.1180), rot=(-0.10, 0, 0), mat=PL, bev=0.0040)
box("mag_b", 0.0280, 0.0720, 0.0600, (0, -0.0020, -0.1840), rot=(-0.22, 0, 0), mat=PL, bev=0.0040)
box("mag_plate", 0.0330, 0.0790, 0.0110, (0, 0.0110, -0.2160), rot=(-0.22, 0, 0), mat=PL, bev=0.0035)
ribs("mag_rib", 4, 0.0298, 0.0050, 0.0035, (0, -0.0470, -0.0900), (0, 0.0015, -0.0205), AL)
box("mag_rel", 0.0130, 0.0150, 0.0140, (0.0230, -0.0330, -0.0340), mat=AL, bev=0.0020)
box("bolt_rel", 0.0120, 0.0300, 0.0125, (-0.0230, -0.0290, -0.0300), mat=AL, bev=0.0020)

# ---- trigger group + grip ----------------------------------------------
box("tg_bottom", 0.0110, 0.0560, 0.0100, (0, -0.0760, -0.0740), mat=AL, bev=0.0022)
box("tg_front", 0.0110, 0.0100, 0.0320, (0, -0.0510, -0.0600), mat=AL, bev=0.0022)
box("tg_rear", 0.0110, 0.0100, 0.0320, (0, -0.1010, -0.0600), mat=AL, bev=0.0022)
box("trigger", 0.0075, 0.0090, 0.0240, (0, -0.0700, -0.0600), rot=(0.16, 0, 0), mat=ST, bev=0.0015)
box("safety", 0.0230, 0.0170, 0.0085, (0, -0.0980, -0.0250), mat=AL, bev=0.0018)
tbox("grip", 0.0348, 0.0500, 0.1050, (0, -0.1220, -0.0760), rot=(0.24, 0, 0), mat=PL,
     bev=0.0060, sx2=0.0318, sz2=0.0900)
box("grip_beaver", 0.0300, 0.0400, 0.0160, (0, -0.1120, -0.0240), mat=PL, bev=0.0045)
box("grip_cap", 0.0320, 0.0380, 0.0100, (0, -0.1480, -0.1270), mat=PL, bev=0.0030)
ribs("grip_tex", 5, 0.0355, 0.0050, 0.0125, (0, -0.0980, -0.0500), (0, -0.0052, -0.0160), PL,
     rot=(0.24, 0, 0))

# ---- buffer tube + adjustable precision stock ---------------------------
cyl("bf_tube", 0.0188, 0.2000, (0, -0.1550, 0.0080), 'Y', AL, 18)
cyl("bf_ring", 0.0228, 0.0140, (0, -0.0640, 0.0080), 'Y', AL, 18)
tbox("st_body", 0.0355, 0.1600, 0.0680, (0, -0.1930, -0.0040), mat=PL, bev=0.0060,
     sx2=0.0300, sz2=0.0520)
box("st_spine", 0.0270, 0.1450, 0.0140, (0, -0.1880, 0.0320), mat=PL, bev=0.0035)
box("st_plate", 0.0320, 0.0150, 0.0860, (0, -0.2660, -0.0040), mat=AL, bev=0.0035)
box("st_pad", 0.0370, 0.0160, 0.0950, (0, -0.2790, -0.0040), mat=PL, bev=0.0070)
box("ck_pad", 0.0360, 0.1150, 0.0220, (0, -0.1930, 0.0510), mat=PL, bev=0.0055)
cyl("ck_wheel", 0.0105, 0.0115, (0, -0.2400, 0.0390), 'X', AL, 14)
cyl("lop_wheel", 0.0105, 0.0115, (0, -0.2520, -0.0300), 'X', AL, 14)
cyl("st_qd", 0.0068, 0.0110, (0.0225, -0.1400, -0.0250), 'X', ST, 10)
box("st_hook", 0.0190, 0.0400, 0.0310, (0, -0.2400, -0.0430), rot=(0.30, 0, 0), mat=PL, bev=0.0045)

# ---- handguard: flush with the receiver rail ---------------------------
cyl("hg_nut", 0.0348, 0.0280, (0, 0.2350, 0), 'Y', AL, 20)
octa_handguard("hg", 0.2470, 0.5600, HG_R, FDE, facet_w=0.0272, thick=0.0070,
               offset_deg=0.0, slot_facets=(2, 6),
               slot_ys=[0.290 + 0.052 * i for i in range(5)],
               slot_len=0.0300, liner_mat=PL)
# hand stop, so the support hand has something to read as "held"
box("hg_stop", 0.0240, 0.0270, 0.0220, (0, 0.3400, -0.0430), rot=(-0.25, 0, 0), mat=PL, bev=0.0045)
cyl("hg_qd", 0.0068, 0.0110, (0.0300, 0.2900, -0.0140), 'X', ST, 10)

# ---- barrel, gas block, flash hider ------------------------------------
cyl("bl_shank", 0.0150, 0.0700, (0, 0.2720, 0), 'Y', ST, 18)
cyl("bl_main", 0.0115, 0.5050, (0, 0.5450, 0), 'Y', ST, 18, r2=0.0108)
box("gas_block", 0.0240, 0.0330, 0.0230, (0, 0.5250, 0.0040), mat=ST, bev=0.0025)
cyl("bl_thread", 0.0112, 0.0200, (0, 0.8000, 0), 'Y', ST, 16)
# Three-prong flash hider: an open cage, so it silhouettes as a cage.
tube("fh_body", 0.0140, 0.0104, 0.0320, (0, 0.8080, 0), 'Y', ST, 18)
for i in range(3):
    a = math.radians(120.0) * i + math.radians(60.0)
    box("fh_prong%d" % i, 0.0060, 0.0300, 0.0035,
        (0.0122 * math.sin(a), 0.8380, 0.0122 * math.cos(a)), rot=(0, a, 0), mat=ST)
tube("fh_ring", 0.0140, 0.0107, 0.0050, (0, 0.8510, 0), 'Y', ST, 18)

# ---- one unbroken rail, receiver through handguard ----------------------
rail("rail", -0.0300, 0.5550, RAIL_Z, AL, w=0.0205)
_parts, sight_pos = scope("sc", m, y_ocular=-0.1150, axis_z=SCOPE_Z,
                          obj_r=0.0260, length=0.72, sunshade=False)
scope_mount("mnt", (-0.0050, 0.1000), SCOPE_Z, RAIL_TOP, AL)
# 45-degree offset backup iron: the giveaway that this is a fighting DMR
box("bu_base", 0.0180, 0.0260, 0.0120, (0.0290, 0.3700, 0.0290), rot=(0, -0.79, 0), mat=AL, bev=0.0020)
box("bu_post", 0.0050, 0.0050, 0.0230, (0.0355, 0.3700, 0.0410), rot=(0, -0.79, 0), mat=ST)

# ---- anchors ------------------------------------------------------------
anchor("sight", sight_pos)
anchor("muzzle", (0.0, 0.8560, 0.0))
anchor("eject", (0.0255, 0.0300, 0.0100))

RESULT = finish("marksman")

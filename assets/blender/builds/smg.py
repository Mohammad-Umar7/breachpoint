"""MP-9 SMG — modern roller-delayed PDW. ~0.50 m with the stock collapsed.

Silhouette job: short slab receiver, magazine well ahead of the trigger,
stubby M-LOK handguard, three-lug compensator, and a two-rail collapsing
stock. Low-profile folding irons sit on the rail rather than a red dot,
because this weapon's optic type is `iron`.
"""

begin("smg")
m = mats()
# LIVERY — midnight anodised receiver. The one cool-toned weapon in the rack,
# so it reads instantly against the FDE and bronze builds.
ST, AL, PL, TR = m["steel"], m["navy"], m["poly"], m["tritium"]

RAIL_Z = 0.0320
SIGHT_Z = RAIL_Z + 0.0050 + 0.0055 + 0.0180   # folding irons stand off the rail
HG_R = 0.0285

# ---- receiver -----------------------------------------------------------
box("rx_body", 0.0440, 0.2400, 0.0520, (0, 0.0450, 0.0060), mat=AL, bev=0.0035)
box("rx_top", 0.0400, 0.2400, 0.0070, (0, 0.0450, 0.0285), mat=AL, bev=0.0015)
box("rx_port", 0.0075, 0.0520, 0.0210, (0.0215, 0.0700, 0.0120), mat=PL)
box("rx_defl", 0.0090, 0.0170, 0.0190, (0.0215, 0.0400, 0.0160), rot=(0, -0.32, 0), mat=AL, bev=0.0022)
# non-reciprocating charging handle on the left, the modern PDW arrangement
box("ch_arm", 0.0300, 0.0140, 0.0090, (-0.0290, 0.1250, 0.0180), mat=AL, bev=0.0018)
cyl("ch_knob", 0.0080, 0.0180, (-0.0420, 0.1250, 0.0180), 'X', PL, 12)
box("safety", 0.0230, 0.0160, 0.0080, (0, -0.0350, -0.0100), mat=AL, bev=0.0016)

# ---- magazine well + magazine (ahead of the trigger) --------------------
box("mw_body", 0.0380, 0.0620, 0.0420, (0, -0.0050, -0.0400), mat=AL, bev=0.0045)
box("mag_body", 0.0265, 0.0540, 0.1250, (0, -0.0050, -0.1150), mat=PL, bev=0.0035)
box("mag_plate", 0.0320, 0.0620, 0.0110, (0, -0.0050, -0.1830), mat=PL, bev=0.0035)
ribs("mag_rib", 5, 0.0272, 0.0045, 0.0032, (0, -0.0280, -0.0700), (0, 0, -0.0210), AL)
box("mag_rel", 0.0110, 0.0140, 0.0170, (0, -0.0430, -0.0330), mat=AL, bev=0.0020)

# ---- trigger group + grip ----------------------------------------------
box("tg_bottom", 0.0110, 0.0470, 0.0090, (0, -0.0620, -0.0430), mat=AL, bev=0.0020)
box("tg_front", 0.0110, 0.0090, 0.0250, (0, -0.0400, -0.0290), mat=AL, bev=0.0020)
box("tg_rear", 0.0110, 0.0090, 0.0250, (0, -0.0840, -0.0290), mat=AL, bev=0.0020)
box("trigger", 0.0070, 0.0085, 0.0210, (0, -0.0580, -0.0300), rot=(0.15, 0, 0), mat=ST, bev=0.0013)
tbox("grip", 0.0330, 0.0470, 0.0960, (0, -0.1020, -0.0470), rot=(0.22, 0, 0), mat=PL,
     bev=0.0055, sx2=0.0305, sz2=0.0840)
box("grip_cap", 0.0300, 0.0360, 0.0095, (0, -0.1250, -0.0930), mat=PL, bev=0.0028)
ribs("grip_tex", 4, 0.0336, 0.0050, 0.0120, (0, -0.0840, -0.0250), (0, -0.0050, -0.0160), PL,
     rot=(0.22, 0, 0))

# ---- handguard + barrel -------------------------------------------------
cyl("hg_nut", 0.0300, 0.0230, (0, 0.1700, 0), 'Y', AL, 18)
octa_handguard("hg", 0.1800, 0.3400, HG_R, AL, facet_w=0.0235, thick=0.0065,
               offset_deg=0.0, slot_facets=(2, 6),
               slot_ys=[0.213 + 0.048 * i for i in range(3)],
               slot_len=0.0280, liner_mat=PL)
rail("hgrail", 0.1820, 0.3350, HG_R + 0.0033, AL, w=0.0190, base_h=0.0040,
     rib_h=0.0050, pitch=0.0120, slot=0.0052)
# angled foregrip: the shape that says "held with two hands"
box("hg_afg", 0.0230, 0.0330, 0.0430, (0, 0.2650, -0.0490), rot=(-0.42, 0, 0), mat=PL, bev=0.0050)
cyl("hg_qd", 0.0062, 0.0100, (0.0270, 0.2000, -0.0110), 'X', ST, 10)

cyl("bl_main", 0.0095, 0.2000, (0, 0.2600, 0), 'Y', ST, 16)
cyl("bl_thread", 0.0092, 0.0160, (0, 0.3560, 0), 'Y', ST, 14)
# three-lug compensator with two pairs of side ports
cyl("mz_body", 0.0140, 0.0420, (0, 0.3770, 0), 'Y', ST, 16)
for i, y in enumerate((0.3660, 0.3820)):
    for sx in (-1, 1):
        box("mz_port%d%d" % (i, sx), 0.0060, 0.0090, 0.0130, (sx * 0.0105, y, 0.0000), mat=PL)
tube("mz_crown", 0.0140, 0.0090, 0.0055, (0, 0.4000, 0), 'Y', ST, 16)

# ---- collapsing two-rail stock -----------------------------------------
box("st_block", 0.0400, 0.0300, 0.0420, (0, -0.0800, 0.0080), mat=AL, bev=0.0035)
for sx in (-1, 1):
    cyl("st_rod%d" % sx, 0.0072, 0.1400, (sx * 0.0150, -0.1600, 0.0110), 'Y', ST, 12)
box("st_pad", 0.0430, 0.0170, 0.0720, (0, -0.2320, 0.0060), mat=PL, bev=0.0060)
box("st_plate", 0.0380, 0.0130, 0.0620, (0, -0.2210, 0.0060), mat=AL, bev=0.0030)
box("st_latch", 0.0180, 0.0200, 0.0140, (0, -0.2050, -0.0230), mat=PL, bev=0.0025)

# ---- folding irons on the rail, tops coplanar at SIGHT_Z ---------------
rail("rxrail", -0.0650, 0.1600, RAIL_Z, AL, w=0.0200, base_h=0.0050,
     rib_h=0.0055, pitch=0.0120, slot=0.0053)
box("rs_base", 0.0210, 0.0140, 0.0120, (0, -0.0350, RAIL_Z + 0.0165), mat=AL, bev=0.0018)
for sx in (-1, 1):
    box("rs_wing%d" % sx, 0.0060, 0.0090, 0.0150, (sx * 0.0075, -0.0350, SIGHT_Z - 0.0075),
        mat=ST, bev=0.0010)
box("fs_base", 0.0200, 0.0140, 0.0120, (0, 0.1400, RAIL_Z + 0.0165), mat=AL, bev=0.0018)
box("fs_post", 0.0038, 0.0048, 0.0150, (0, 0.1400, SIGHT_Z - 0.0075), mat=ST, bev=0.0008)
cyl("fs_dot", 0.0017, 0.0020, (0, 0.1372, SIGHT_Z - 0.0072), 'Y', TR, 10)
for sx in (-1, 1):   # protective ears either side of the front post
    box("fs_ear%d" % sx, 0.0035, 0.0090, 0.0170, (sx * 0.0082, 0.1400, SIGHT_Z - 0.0080),
        mat=AL, bev=0.0008)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0350, SIGHT_Z))
anchor("muzzle", (0.0, 0.4040, 0.0))
anchor("eject", (0.0245, 0.0700, 0.0120))

RESULT = finish("smg")

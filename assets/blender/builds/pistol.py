"""M9 SIDEARM — modern optic-ready striker-fired service pistol. ~0.215 m.

Iron sights, so the `sight` anchor sits in the rear notch and the front blade
is built to exactly the same height above bore. That coplanar relationship is
the whole trick: WeaponViewModel drops the notch onto the camera axis, and
the front post lands there for free.
"""

begin("pistol")
m = mats()
# LIVERY — brushed stainless slide over a black polymer frame, the classic
# duty two-tone. Sights stay black (see below) so they contrast against it.
ST, AL, PL, TR = m["stainless"], m["tungsten"], m["poly"], m["tritium"]
BLK = m["poly"]

SIGHT_Z = 0.0300      # top of both sights, above bore

# ---- slide --------------------------------------------------------------
box("sl_body", 0.0275, 0.1800, 0.0320, (0, 0.0300, 0.0100), mat=ST, bev=0.0030)
box("sl_top", 0.0225, 0.1800, 0.0060, (0, 0.0300, 0.0255), mat=ST, bev=0.0015)
# Rear cocking serrations plus a shorter forward set — the modern giveaway.
ribs("sl_ser_r", 7, 0.0285, 0.0045, 0.0270, (0, -0.0480, 0.0095), (0, 0.0080, 0), PL)
ribs("sl_ser_f", 5, 0.0285, 0.0042, 0.0230, (0, 0.0760, 0.0090), (0, 0.0075, 0), PL)
# ejection port + extractor, right side
box("sl_port", 0.0075, 0.0420, 0.0175, (0.0140, 0.0320, 0.0130), mat=PL)
box("sl_extr", 0.0060, 0.0230, 0.0090, (0.0135, 0.0230, 0.0140), mat=ST, bev=0.0012)
# optic cut-out with a blanking plate: reads "RMR ready" without an optic
box("sl_optic", 0.0210, 0.0330, 0.0040, (0, -0.0170, 0.0270), mat=AL, bev=0.0010)

# ---- barrel + muzzle ----------------------------------------------------
cyl("bl_main", 0.0078, 0.0260, (0, 0.1050, 0), 'Y', ST, 16)
tube("bl_crown", 0.0078, 0.0048, 0.0050, (0, 0.1155, 0), 'Y', ST, 16)
box("bl_lug", 0.0150, 0.0300, 0.0090, (0, 0.0700, -0.0110), mat=ST, bev=0.0015)

# ---- frame --------------------------------------------------------------
box("fr_dust", 0.0250, 0.1000, 0.0230, (0, 0.0550, -0.0230), mat=PL, bev=0.0030)
box("fr_body", 0.0270, 0.0780, 0.0330, (0, -0.0120, -0.0210), mat=PL, bev=0.0035)
rail("fr_rail", 0.0300, 0.0980, -0.0355, AL, w=0.0180, base_h=0.0035,
     rib_h=0.0040, pitch=0.0110, slot=0.0050)
box("fr_beaver", 0.0250, 0.0330, 0.0110, (0, -0.0480, -0.0035), rot=(-0.22, 0, 0), mat=PL, bev=0.0030)
# Backstrap tang. The frame ends at y=-0.051 but the rotated grip's top face
# runs back to y=-0.087, so without this the grip hangs in mid-air behind the
# frame with ~17 mm of daylight under the beavertail.
box("fr_tang", 0.0265, 0.0420, 0.0330, (0, -0.0560, -0.0290), mat=PL, bev=0.0035)
box("fr_takedown", 0.0300, 0.0110, 0.0110, (0, 0.0180, -0.0290), mat=ST, bev=0.0018)
box("fr_slidestop", 0.0075, 0.0380, 0.0080, (-0.0155, 0.0000, -0.0220), mat=ST, bev=0.0012)
box("fr_magrel", 0.0080, 0.0130, 0.0130, (0.0150, -0.0290, -0.0300), mat=ST, bev=0.0018)

# Trigger guard: squared front with a high undercut. It has to close on all
# four sides — bottom bar, front post, and a rear web that actually reaches
# back to the grip, or it renders as loose bars hanging under the frame.
box("tg_bottom", 0.0100, 0.0470, 0.0075, (0, -0.0055, -0.0530), mat=PL, bev=0.0018)
box("tg_front", 0.0100, 0.0080, 0.0250, (0, 0.0140, -0.0400), mat=PL, bev=0.0018)
box("tg_rear", 0.0100, 0.0180, 0.0230, (0, -0.0330, -0.0430), rot=(0.26, 0, 0), mat=PL, bev=0.0018)
box("tg_web", 0.0230, 0.0150, 0.0130, (0, -0.0330, -0.0330), mat=PL, bev=0.0025)
box("trigger", 0.0065, 0.0080, 0.0210, (0, -0.0090, -0.0400), rot=(0.14, 0, 0), mat=PL, bev=0.0012)
box("trig_safety", 0.0022, 0.0045, 0.0180, (0, -0.0110, -0.0400), rot=(0.14, 0, 0), mat=ST)

# ---- grip ---------------------------------------------------------------
tbox("grip", 0.0300, 0.0470, 0.0980, (0, -0.0520, -0.0700), rot=(0.26, 0, 0), mat=PL,
     bev=0.0055, sx2=0.0282, sz2=0.0900)
box("grip_back", 0.0250, 0.0110, 0.0900, (0, -0.0740, -0.0680), rot=(0.26, 0, 0), mat=PL, bev=0.0035)
box("mag_plate", 0.0310, 0.0520, 0.0110, (0, -0.0290, -0.1180), rot=(0.26, 0, 0), mat=PL, bev=0.0030)
# stippling: four bands a side, angled with the grip
for sx in (-1, 1):
    ribs("grip_tex%d" % sx, 4, 0.0035, 0.0300, 0.0130,
         (sx * 0.0152, -0.0430, -0.0480), (0, -0.0035, -0.0165), AL, rot=(0.26, 0, 0))

# ---- iron sights: both tops coplanar at SIGHT_Z -------------------------
# rear: two blades either side of a square notch. Black on the stainless
# slide — sights must contrast with what they are mounted to.
for sx in (-1, 1):
    box("rs_blade%d" % sx, 0.0075, 0.0075, 0.0110, (sx * 0.0072, -0.0480, SIGHT_Z - 0.0055),
        mat=BLK, bev=0.0010)
    cyl("rs_dot%d" % sx, 0.0016, 0.0020, (sx * 0.0072, -0.0518, SIGHT_Z - 0.0060), 'Y', TR, 10)
box("rs_base", 0.0210, 0.0075, 0.0045, (0, -0.0480, SIGHT_Z - 0.0125), mat=BLK, bev=0.0010)
# front: single blade with a tritium lamp
box("fs_blade", 0.0045, 0.0055, 0.0115, (0, 0.0830, SIGHT_Z - 0.0058), mat=BLK, bev=0.0009)
cyl("fs_dot", 0.0019, 0.0022, (0, 0.0800, SIGHT_Z - 0.0055), 'Y', TR, 10)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0480, SIGHT_Z))
anchor("muzzle", (0.0, 0.1190, 0.0))
anchor("eject", (0.0180, 0.0320, 0.0130))

RESULT = finish("pistol")

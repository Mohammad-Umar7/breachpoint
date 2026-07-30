"""\.50 MAGNUM — gas-operated hand cannon. ~0.275 m.

Everything about this one is scale and mass: a slab-sided slide with a
triangular section, a gas cylinder slung under a ported barrel, and a grip
big enough to need both hands. Brass accents on the trigger, hammer and
safety so it doesn't disappear into the same grey as everything else.
"""

begin("deagle")
m = mats()
# LIVERY — titanium-nitride gold slide and barrel on a tungsten frame with
# brass controls. Deliberately the loudest weapon in the game: it is the hand
# cannon, and a gold one is the single most recognisable pistol silhouette
# there is. Gold is a METAL here, so the tint holds through the ACES roll-off
# instead of blowing out the way a bright diffuse yellow would.
ST, AL, PL, BR, TR = m["gold"], m["tungsten"], m["poly"], m["brass"], m["tritium"]
BLK = m["poly"]

SIGHT_Z = 0.0430

# ---- slide: slab sides, flat top, longitudinal grooves ------------------
box("sl_body", 0.0320, 0.2150, 0.0400, (0, 0.0400, 0.0180), mat=ST, bev=0.0035)
box("sl_top", 0.0270, 0.2150, 0.0080, (0, 0.0400, 0.0380), mat=ST, bev=0.0018)
# The scope-base ribs down the top flat are the shape everyone recognises.
ribs("sl_groove", 3, 0.0055, 0.2100, 0.0035, (-0.0090, 0.0400, 0.0428), (0.0090, 0, 0), PL)
ribs("sl_ser", 9, 0.0330, 0.0055, 0.0350, (0, -0.0480, 0.0175), (0, 0.0090, 0), PL)
box("sl_port", 0.0085, 0.0520, 0.0210, (0.0165, 0.0500, 0.0190), mat=PL)
box("sl_extr", 0.0070, 0.0280, 0.0100, (0.0160, 0.0380, 0.0200), mat=ST, bev=0.0014)

# ---- barrel: ported, with the gas tube slung underneath -----------------
cyl("bl_main", 0.0112, 0.0620, (0, 0.1650, 0), 'Y', ST, 18)
tube("bl_crown", 0.0112, 0.0068, 0.0060, (0, 0.1930, 0), 'Y', ST, 18)
# two pairs of muzzle-brake ports cut through the top of the barrel
for i, y in enumerate((0.1520, 0.1720)):
    for sx in (-1, 1):
        box("bl_port%d%d" % (i, sx), 0.0055, 0.0130, 0.0130, (sx * 0.0060, y, 0.0090), mat=PL)
cyl("gas_tube", 0.0080, 0.1450, (0, 0.1150, -0.0170), 'Y', ST, 14)
cyl("gas_block", 0.0110, 0.0220, (0, 0.1830, -0.0170), 'Y', ST, 14)

# ---- frame --------------------------------------------------------------
box("fr_body", 0.0300, 0.1250, 0.0380, (0, 0.0250, -0.0180), mat=AL, bev=0.0040)
box("fr_dust", 0.0280, 0.0850, 0.0220, (0, 0.1050, -0.0180), mat=AL, bev=0.0030)
rail("fr_rail", 0.0700, 0.1400, -0.0300, AL, w=0.0200, base_h=0.0035,
     rib_h=0.0045, pitch=0.0115, slot=0.0052)
box("fr_beaver", 0.0280, 0.0380, 0.0130, (0, -0.0450, 0.0080), rot=(-0.20, 0, 0), mat=AL, bev=0.0035)
# Backstrap tang: same fix as the sidearm. The frame stops at y=-0.038 while
# the raked grip's top face reaches y=-0.091, leaving the grip unsupported.
box("fr_tang", 0.0300, 0.0520, 0.0380, (0, -0.0580, -0.0230), mat=AL, bev=0.0040)
box("safety", 0.0090, 0.0300, 0.0130, (0.0180, -0.0320, 0.0180), mat=BR, bev=0.0018)
box("hammer", 0.0080, 0.0140, 0.0230, (0, -0.0560, 0.0180), rot=(-0.35, 0, 0), mat=BR, bev=0.0020)
box("fr_magrel", 0.0090, 0.0150, 0.0150, (0.0165, -0.0180, -0.0300), mat=ST, bev=0.0018)

box("tg_bottom", 0.0110, 0.0480, 0.0090, (0, 0.0060, -0.0530), mat=AL, bev=0.0020)
box("tg_front", 0.0110, 0.0090, 0.0260, (0, 0.0290, -0.0390), mat=AL, bev=0.0020)
box("trigger", 0.0075, 0.0090, 0.0240, (0, -0.0060, -0.0380), rot=(0.14, 0, 0), mat=BR, bev=0.0014)

# ---- grip: oversized, slab-sided ---------------------------------------
tbox("grip", 0.0345, 0.0560, 0.1120, (0, -0.0500, -0.0740), rot=(0.24, 0, 0), mat=PL,
     bev=0.0060, sx2=0.0325, sz2=0.1050)
box("grip_back", 0.0290, 0.0120, 0.1050, (0, -0.0760, -0.0720), rot=(0.24, 0, 0), mat=PL, bev=0.0040)
box("mag_plate", 0.0350, 0.0600, 0.0120, (0, -0.0230, -0.1330), rot=(0.24, 0, 0), mat=PL, bev=0.0035)
for sx in (-1, 1):
    ribs("grip_tex%d" % sx, 5, 0.0040, 0.0350, 0.0140,
         (sx * 0.0174, -0.0390, -0.0470), (0, -0.0038, -0.0165), AL, rot=(0.24, 0, 0))

# ---- iron sights, coplanar at SIGHT_Z ----------------------------------
# Black sights on a gold slide. Sights have to contrast with what they sit on
# or they vanish — gold-on-gold would be unusable.
for sx in (-1, 1):
    box("rs_blade%d" % sx, 0.0080, 0.0080, 0.0120, (sx * 0.0080, -0.0470, SIGHT_Z - 0.0060),
        mat=BLK, bev=0.0010)
    cyl("rs_dot%d" % sx, 0.0017, 0.0022, (sx * 0.0080, -0.0512, SIGHT_Z - 0.0065), 'Y', TR, 10)
box("rs_base", 0.0250, 0.0080, 0.0050, (0, -0.0470, SIGHT_Z - 0.0140), mat=BLK, bev=0.0010)
box("fs_ramp", 0.0100, 0.0180, 0.0090, (0, 0.1420, SIGHT_Z - 0.0130), mat=BLK, bev=0.0014)
box("fs_blade", 0.0048, 0.0058, 0.0120, (0, 0.1420, SIGHT_Z - 0.0060), mat=BLK, bev=0.0009)
cyl("fs_dot", 0.0020, 0.0024, (0, 0.1388, SIGHT_Z - 0.0058), 'Y', TR, 10)

# ---- anchors ------------------------------------------------------------
anchor("sight", (0.0, -0.0470, SIGHT_Z))
anchor("muzzle", (0.0, 0.1970, 0.0))
anchor("eject", (0.0210, 0.0500, 0.0190))

RESULT = finish("deagle")

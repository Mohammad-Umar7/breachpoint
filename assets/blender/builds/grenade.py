"""M67 FRAG — fragmentation grenade. ~0.115 m tall.

Oriented like every other weapon: +Y is "forward", which for a thrown object
is the direction it leaves the hand. The body therefore sits at the origin
with the fuse pointing up (+Z), so the throw animation can pitch it about X
without the pivot drifting.
"""

begin("grenade")
m = mats()
# LIVERY — olive drab body with a safety-yellow band and a bare alloy fuse.
# That yellow stripe is the single most identifiable marking on a frag, and
# it is the only reason this reads as ordnance rather than a rock at a glance.
ST, AL, PL, FDE = m["steel"], m["alu"], m["poly"], m["od"]
YEL = m["yellow"]

BODY_R = 0.0300

# ---- body ---------------------------------------------------------------
sphere("gr_body", BODY_R, (0, 0, 0), FDE, 20, 14)
# Segmentation bands. The real M67 is smooth-walled with an internal
# fragmentation coil, but a banded body is what reads as "grenade" instantly,
# and at 60 mm across nothing else on it will register.
for i in range(3):
    z = -0.0130 + 0.0130 * i
    r = math.sqrt(max(BODY_R ** 2 - z ** 2, 1e-6)) + 0.0009
    tube("gr_band%d" % i, r, r - 0.0026, 0.0038, (0, 0, z), 'Z', ST, 22)
for i in range(6):
    a = math.radians(60.0) * i
    box("gr_rib%d" % i, 0.0034, 0.0034, 0.0560,
        (BODY_R * 0.97 * math.sin(a), BODY_R * 0.97 * math.cos(a), 0),
        rot=(0, 0, -a), mat=ST)

# ---- fuse assembly ------------------------------------------------------
cyl("fz_collar", 0.0125, 0.0110, (0, 0, 0.0285), 'Z', AL, 16)
cyl("fz_body", 0.0098, 0.0170, (0, 0, 0.0400), 'Z', AL, 16)
knurl("fz_knurl", 0.0098, 0.0150, (0, 0, 0.0400), ST, n=12, axis='Z', tooth=0.0026, deep=0.0016)
cyl("fz_cap", 0.0110, 0.0055, (0, 0, 0.0505), 'Z', AL, 16)
# striker lever pivot
cyl("fz_pivot", 0.0040, 0.0230, (0, 0, 0.0470), 'X', ST, 10)

# ---- safety lever (spoon), clamped down the side -----------------------
box("sp_top", 0.0130, 0.0230, 0.0042, (0, 0.0060, 0.0500), rot=(0.28, 0, 0), mat=AL, bev=0.0010)
box("sp_body", 0.0130, 0.0055, 0.0480, (0, 0.0245, 0.0270), rot=(0.10, 0, 0), mat=AL, bev=0.0010)
box("sp_tail", 0.0130, 0.0060, 0.0330, (0, 0.0270, -0.0010), rot=(-0.16, 0, 0), mat=AL, bev=0.0010)
box("sp_lip", 0.0130, 0.0110, 0.0090, (0, 0.0235, -0.0180), rot=(-0.55, 0, 0), mat=AL, bev=0.0012)
ribs("sp_rib", 3, 0.0134, 0.0038, 0.0300, (0, 0.0262, 0.0140), (0, 0.0010, -0.0130), ST,
     rot=(0.10, 0, 0))

# ---- pull ring + pin ----------------------------------------------------
cyl("pn_shaft", 0.0021, 0.0230, (0, -0.0020, 0.0470), 'X', ST, 8)
# the ring itself: eight short links around a circle, cheaper than a torus
for i in range(8):
    a = math.radians(45.0) * i
    box("pn_ring%d" % i, 0.0026, 0.0075, 0.0026,
        (-0.0175, 0.0125 * math.sin(a), 0.0470 + 0.0125 * math.cos(a)),
        rot=(-a, 0, 0), mat=ST)

# ---- markings -----------------------------------------------------------
# painted band: the yellow-on-olive stripe every frag grenade carries
tube("mk_band", BODY_R + 0.0011, BODY_R - 0.0014, 0.0060, (0, 0, 0.0195), 'Z', YEL, 22)

# ---- anchors ------------------------------------------------------------
# `muzzle` is the release point used for the throw origin — just ahead of and
# above the body, roughly where it leaves the fingertips.
anchor("sight", (0.0, 0.0000, 0.0300))
anchor("muzzle", (0.0, 0.0340, 0.0120))
anchor("eject", (0.0, 0.0000, 0.0000))

RESULT = finish("grenade")

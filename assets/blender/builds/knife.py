"""COMBAT KNIFE — clip-point fighting knife. ~0.30 m.

Modelled along the same +Y axis as the guns so the view-model, swing
animation and `muzzle` anchor (used here as the FX/trace origin at the point)
all behave exactly as they do for a firearm. Nothing special-cases the knife.
"""

begin("knife")
m = mats()
# LIVERY — burnt bronze guard, tang and pommel against black G10 scales and a
# blued blade. Warm fittings are what stop a mono-black knife reading flat.
ST, AL, PL = m["steel"], m["bronze"], m["poly"]

# ---- blade --------------------------------------------------------------
# Flat stock tapering to the edge, with a swedge ground into the spine and a
# clip towards the point. Built from three tapered slabs rather than a
# profile extrusion, which keeps it under 400 triangles.
tbox("bl_body", 0.0055, 0.1500, 0.0330, (0, 0.1150, 0.0020), mat=ST, bev=0.0008,
     sx2=0.0042, sz2=0.0270)
tbox("bl_clip", 0.0044, 0.0560, 0.0270, (0, 0.2050, 0.0020), mat=ST, bev=0.0007,
     sx2=0.0016, sz2=0.0075, z_pivot=-0.0135)
tbox("bl_edge", 0.0030, 0.1500, 0.0090, (0, 0.1150, -0.0165), mat=ST, bev=0.0004,
     sx2=0.0016, sz2=0.0060)
box("bl_fuller", 0.0062, 0.0950, 0.0075, (0, 0.1050, 0.0040), mat=PL, bev=0.0008)
# spine serrations: six teeth, back half only
for i in range(6):
    box("bl_saw%d" % i, 0.0056, 0.0075, 0.0060, (0, 0.0620 + 0.0130 * i, 0.0175),
        rot=(0, 0, 0), mat=ST, bev=0.0006)
box("bl_ricasso", 0.0068, 0.0180, 0.0300, (0, 0.0480, 0.0020), mat=ST, bev=0.0010)

# ---- guard --------------------------------------------------------------
box("gd_cross", 0.0330, 0.0110, 0.0260, (0, 0.0350, 0.0010), mat=AL, bev=0.0022)
box("gd_hook", 0.0120, 0.0130, 0.0170, (0, 0.0300, -0.0210), rot=(-0.30, 0, 0), mat=AL, bev=0.0020)
cyl("gd_pin", 0.0032, 0.0350, (0, 0.0350, 0.0010), 'X', ST, 10)

# ---- handle: G10 scales over a skeletonised tang -----------------------
tbox("hd_core", 0.0170, 0.0900, 0.0250, (0, -0.0150, 0.0000), mat=AL, bev=0.0030,
     sx2=0.0150, sz2=0.0215)
for sx in (-1, 1):
    tbox("hd_scale%d" % sx, 0.0055, 0.0880, 0.0245, (sx * 0.0105, -0.0150, 0.0000),
         mat=PL, bev=0.0035, sx2=0.0042, sz2=0.0210)
    # finger grooves, cut across the scale — dark, so they read as grooves
    # rather than as raised light-coloured ribs
    ribs("hd_groove%d" % sx, 4, 0.0064, 0.0060, 0.0250,
         (sx * 0.0112, -0.0430, 0.0000), (0, 0.0180, 0), PL)
for i in range(2):
    cyl("hd_rivet%d" % i, 0.0038, 0.0230, (0, -0.0420 + 0.0520 * i, 0.0000), 'X', ST, 10)
cyl("hd_lanyard", 0.0030, 0.0180, (0, -0.0570, 0.0000), 'X', ST, 8)

# ---- pommel: tungsten glass-breaker ------------------------------------
box("pm_body", 0.0170, 0.0200, 0.0230, (0, -0.0700, 0.0000), mat=AL, bev=0.0030)
cyl("pm_spike", 0.0055, 0.0180, (0, -0.0880, 0.0000), 'Y', ST, 10, r2=0.0016)

# ---- anchors ------------------------------------------------------------
# `muzzle` is the point of the blade: it is where WeaponSystem originates
# trace and impact FX, so it must sit on the tip rather than at the guard.
anchor("sight", (0.0, 0.0000, 0.0200))
anchor("muzzle", (0.0, 0.2340, -0.0040))
anchor("eject", (0.0, 0.0350, 0.0010))

RESULT = finish("knife")

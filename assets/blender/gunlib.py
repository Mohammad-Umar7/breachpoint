"""
Breachpoint asset library — shared Blender modelling helpers.

Loaded by every build script with:

    exec(open(r"...\gunlib.py").read(), globals())

The Blender MCP bridge keeps no state between calls, so this file *is* the
state: helpers, materials and the export pipeline all live here and each
build script only describes the shape of one asset.

CONVENTIONS (must match the AR-15 that already ships)
-----------------------------------------------------
* Blender axes: +Y is the muzzle direction, +Z is up, +X is the shooter's
  right.  The glTF exporter's Y-up conversion maps (x, y, z) -> (x, z, -y),
  so +Y forward in Blender lands as -Z forward in three.js, which is what the
  view-model expects.
* The bore sits on z = 0 so every weapon shares one reference line.
* Geometry is baked into the mesh at creation time and every object keeps an
  identity transform.  Joining meshes is then a pure data merge with no
  transform maths, which is where hand-built kitbashes usually go wrong.
* Each asset exports as one GLB containing meshes merged per material plus
  the empties `sight`, `muzzle`, `eject` and (iron/red-dot sights only)
  `reticle`.
"""

import bpy
import bmesh
import math
import os
from mathutils import Vector, Euler, Matrix

PROJECT = r"C:\Users\omerj\threejs-fps"
OUT_DIR = os.path.join(PROJECT, "public", "models")

# The collection the current build writes into. Set by `begin()`.
COLL = None


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
# Deliberately few: every extra material is another draw call in the engine,
# and merging by material is what keeps these models at 4-6 meshes each.
#
# NOTE: AssetManager swaps any material whose name matches /glass|lens/i for a
# purely additive coating, because a *lit* transparent surface in front of the
# view-model camera picks up the env map and turns the sight picture milky.
# The name `W_Glass` is therefore load-bearing, not decorative.

def M(name, base, metallic, rough, alpha=1.0, emit=None, emit_str=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (base[0], base[1], base[2], alpha)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if alpha < 1.0:
        try:
            b.inputs["Alpha"].default_value = alpha
        except Exception:
            pass
        for attr, val in (("blend_method", 'BLEND'), ("surface_render_method", 'BLENDED')):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    if emit is not None:
        for key in ("Emission Color", "Emission"):
            if key in b.inputs:
                b.inputs[key].default_value = (emit[0], emit[1], emit[2], 1.0)
                break
        if "Emission Strength" in b.inputs:
            b.inputs["Emission Strength"].default_value = emit_str
    return m


def mats():
    """The shared palette. Returns a dict so build scripts read clearly.

    COLOUR IS CALIBRATED TO THE VIEW-MODEL RIG, NOT TO A BLENDER RENDER.
    In game the gun is lit by its own three lights (WeaponViewModel): a cool
    ambient 0xb9c9d6 at 1.15, a warm key 0xfff2dd at 2.0 and a cool fill
    0x7fa8c8 at 0.7, then ACES tone mapping at exposure 1.0. A lit surface
    therefore receives roughly 2.5-3x irradiance, and ACES desaturates as it
    rolls off, so anything saturated *and* bright washes toward white.

    The consequence: identity colours live in the 0.06-0.25 albedo band, and
    the strongly coloured finishes are METALS — for a metal the base colour is
    the specular tint, which survives the roll-off far better than a bright
    diffuse does.

    Finishes are real cerakote/anodising options rather than invented colours,
    which is what keeps twelve distinctly coloured weapons reading as
    firearms instead of as toys.
    """
    return {
        # --- structural ---------------------------------------------------
        # Cold blued steel — barrels, bolts, fasteners, blades.
        "steel":   M("W_Steel",   (0.078, 0.082, 0.092), 1.00, 0.31),
        # Hard-anodised aluminium — the neutral receiver finish.
        "alu":     M("W_Alu",     (0.105, 0.108, 0.116), 0.90, 0.43),
        # Matte injection-moulded polymer — grips, stocks, magazines, and
        # every recessed cut (ports, serrations, slots, M-LOK liners).
        #
        # A dielectric has full diffuse response where a metal has almost
        # none, so a mid-grey polymer lit next to steel renders *brighter*
        # than the steel — which turned every recess into a raised pale panel
        # in an early pass. This value reads as gun-black furniture while
        # still staying darker than the metal a recess is cut into.
        "poly":    M("W_Polymer", (0.026, 0.027, 0.029), 0.00, 0.70),
        # Optic bodies: darker and glossier than the receiver so they read as
        # a separate bolt-on component rather than part of the gun.
        "optic":   M("W_Optic",   (0.030, 0.031, 0.035), 0.55, 0.26),
        # Lens. Name must keep matching /glass|lens/i — AssetManager swaps it
        # for an additive coating so the sight picture stays clear.
        "glass":   M("W_Glass",   (0.045, 0.085, 0.115), 0.00, 0.05, alpha=0.30),

        # --- identity finishes, one lead colour per weapon ----------------
        # Flat dark earth: the default modern rifle furniture colour.
        "fde":       M("W_FDE",       (0.240, 0.176, 0.106), 0.10, 0.60),
        # Olive drab, for the belt-fed and the bullpup.
        "od":        M("W_OD",        (0.098, 0.122, 0.070), 0.08, 0.64),
        # Tungsten grey anodising — reads as a distinctly lighter receiver
        # without introducing a hue, so it can sit under FDE furniture.
        "tungsten":  M("W_Tungsten",  (0.168, 0.174, 0.184), 0.85, 0.37),
        # Burnt bronze cerakote. A metal, so the warm tint holds through the
        # ACES roll-off instead of blowing out to white like a bright diffuse.
        "bronze":    M("W_Bronze",    (0.178, 0.102, 0.052), 0.80, 0.38),
        # Midnight anodised blue — cool identity against all the warm ones.
        "navy":      M("W_Navy",      (0.062, 0.084, 0.126), 0.80, 0.35),
        # Brushed stainless, for a two-tone slide.
        "stainless": M("W_Stainless", (0.320, 0.328, 0.338), 1.00, 0.22),
        # Titanium-nitride gold. Loud on purpose — it belongs to exactly one
        # weapon and is the whole point of that weapon.
        "gold":      M("W_Gold",      (0.620, 0.458, 0.160), 1.00, 0.21),
        # Oxblood, used only as small accents (levers, hooks, index marks).
        "crimson":   M("W_Crimson",   (0.215, 0.032, 0.028), 0.20, 0.44),
        # Safety-yellow stencilling.
        "yellow":    M("W_Yellow",    (0.480, 0.360, 0.045), 0.00, 0.52),

        # --- consumables ---------------------------------------------------
        "brass":   M("W_Brass",   (0.520, 0.360, 0.115), 1.00, 0.28),
        # Plastic shotgun hulls in a side saddle.
        "hull":    M("W_Hull",    (0.240, 0.032, 0.030), 0.00, 0.55),
        # Tritium / fibre-optic inserts and painted index marks.
        "tritium": M("W_Tritium", (0.020, 0.500, 0.230), 0.00, 0.35,
                     emit=(0.10, 1.00, 0.42), emit_str=3.0),
    }


# ---------------------------------------------------------------------------
# Primitive builders
# ---------------------------------------------------------------------------
# All of them bake `rot` then `loc` straight into the vertices and hand back
# an object sitting at the world origin.

def _finish_bm(name, bm, loc, rot, mat, bev, bev_seg=1):
    if bev and bev > 0.0:
        try:
            bmesh.ops.bevel(
                bm,
                geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                offset=bev, segments=bev_seg, affect='EDGES',
                profile=0.62, clamp_overlap=True,
            )
        except Exception:
            pass
    if rot and any(rot):
        bmesh.ops.transform(bm, matrix=Euler(rot).to_matrix().to_4x4(), verts=bm.verts)
    if loc and any(loc):
        bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    COLL.objects.link(ob)
    return ob


def _cone_bm(bm, r1, r2, h, segs):
    """create_cone changed its argument names across Blender versions."""
    try:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              radius1=r1, radius2=r2, depth=h)
    except TypeError:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                              diameter1=r1 * 2.0, diameter2=r2 * 2.0, depth=h)


_AXIS_ROT = {
    'Z': None,
    'Y': Matrix.Rotation(math.radians(90.0), 4, 'X'),
    'X': Matrix.Rotation(math.radians(90.0), 4, 'Y'),
}


def box(name, sx, sy, sz, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bev=0.0, bev_seg=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    # A bevel wider than the thinnest wall inverts the geometry.
    bev = min(bev, min(sx, sy, sz) * 0.34)
    return _finish_bm(name, bm, loc, rot, mat, bev, bev_seg)


def cyl(name, r, h, loc=(0, 0, 0), axis='Y', mat=None, verts=16, rot=(0, 0, 0),
        r2=None, bev=0.0):
    bm = bmesh.new()
    _cone_bm(bm, r, r if r2 is None else r2, h, verts)
    m = _AXIS_ROT[axis]
    if m is not None:
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return _finish_bm(name, bm, loc, rot, mat, min(bev, min(r, h) * 0.30))


def tube(name, r_out, r_in, h, loc=(0, 0, 0), axis='Y', mat=None, verts=20, rot=(0, 0, 0)):
    """A real open-ended tube. Used wherever the player can see down a bore:
    sunshades, suppressor bodies, scope rings, flash hiders."""
    bm = bmesh.new()
    for r in (r_out, r_in):
        try:
            bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=verts,
                                  radius1=r, radius2=r, depth=h)
        except TypeError:
            bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=verts,
                                  diameter1=r * 2.0, diameter2=r * 2.0, depth=h)
    # Bridge the two rims into flat annuli. Splitting by sign of z keeps the
    # pairing deterministic instead of relying on bridge_loops guessing.
    for sign in (1, -1):
        rim = [e for e in bm.edges
               if e.is_boundary and (e.verts[0].co.z * sign) > 0]
        if rim:
            bmesh.ops.bridge_loops(bm, edges=rim)
    m = _AXIS_ROT[axis]
    if m is not None:
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return _finish_bm(name, bm, loc, rot, mat, 0.0)


def sphere(name, r, loc=(0, 0, 0), mat=None, u=14, v=8, rot=(0, 0, 0)):
    bm = bmesh.new()
    try:
        bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    except TypeError:
        bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, diameter=r * 2.0)
    return _finish_bm(name, bm, loc, rot, mat, 0.0)


# ---------------------------------------------------------------------------
# Compound details
# ---------------------------------------------------------------------------

def rail(name, y0, y1, z, mat, w=0.0210, base_h=0.0050, rib_h=0.0055,
         pitch=0.01250, slot=0.0055):
    """MIL-STD-1913 rail built as a base plate plus discrete ribs, so the
    slots are real gaps you can see light through rather than a texture."""
    out = [box(name + "_base", w, y1 - y0, base_h,
               (0, (y0 + y1) * 0.5, z + base_h * 0.5), mat=mat)]
    rib_len = pitch - slot
    y = y0 + rib_len * 0.5 + 0.001
    while y < y1 - rib_len * 0.5:
        out.append(box(name + "_rib", w, rib_len, rib_h,
                       (0, y, z + base_h + rib_h * 0.5), mat=mat))
        y += pitch
    return out


def tbox(name, sx, sy, sz, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, bev=0.0,
         sx2=None, sz2=None, z_pivot=None, bev_seg=1):
    """A box whose +Y face is scaled — the tapered/wedge form that stops
    receivers, chassis and stocks reading as extruded rectangles.

    `z_pivot` in local units picks what stays put while the section shrinks:
    +sz/2 keeps the top flat and lifts the underside (a chassis forend),
    None (default) tapers symmetrically about the centreline.
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    if sx2 is not None or sz2 is not None:
        fx = (sx2 / sx) if sx2 is not None else 1.0
        fz = (sz2 / sz) if sz2 is not None else 1.0
        zp = 0.0 if z_pivot is None else z_pivot
        for v in bm.verts:
            if v.co.y > 0.0:
                v.co.x *= fx
                v.co.z = zp + (v.co.z - zp) * fz
    bev = min(bev, min(sx, sy, sz) * 0.34)
    return _finish_bm(name, bm, loc, rot, mat, bev, bev_seg)


def octa_handguard(name, y0, y1, radius, mat, facet_w=0.028, thick=0.0075,
                   facets=8, bev=0.0012, slot_facets=(), slot_ys=(),
                   slot_len=0.030, liner_mat=None, offset_deg=None):
    """Free-float handguard as N flat facets around the bore. Reads as a
    machined octagonal tube and costs a fraction of a lofted cylinder.

    Facets listed in `slot_facets` (by index) are broken into segments with
    real gaps at `slot_ys`, backed by a dark liner tube — so the M-LOK slots
    are voids you can see into. Sinking a dark plate *under* the surface, the
    obvious cheap trick, renders as nothing at all: the facet occludes it.
    """
    out = []
    ln = y1 - y0
    yc = (y0 + y1) * 0.5
    step = 360.0 / facets
    # offset_deg=0 puts flat facets at 12, 3, 6 and 9 o'clock, which is what
    # you want when a rail sits on top and M-LOK runs down the sides. The
    # default half-step offset leaves a ridge at 12 o'clock and makes the
    # handguard read as a plain tube.
    off = (step * 0.5) if offset_deg is None else offset_deg

    for i in range(facets):
        a = math.radians(step * i + off)
        px, pz = radius * math.sin(a), radius * math.cos(a)

        if i in slot_facets and slot_ys:
            # Walk the facet, emitting solid runs between the slot cut-outs.
            cuts = sorted((y - slot_len * 0.5, y + slot_len * 0.5) for y in slot_ys)
            edge = y0
            spans = []
            for c0, c1 in cuts:
                if c0 > edge:
                    spans.append((edge, c0))
                edge = max(edge, c1)
            if edge < y1:
                spans.append((edge, y1))
            for k, (s0, s1) in enumerate(spans):
                if s1 - s0 < 0.0015:
                    continue
                out.append(box(f"{name}_f{i}s{k}", facet_w, s1 - s0, thick,
                               (px, (s0 + s1) * 0.5, pz), rot=(0, a, 0),
                               mat=mat, bev=bev))
        else:
            out.append(box(f"{name}_f{i}", facet_w, ln, thick,
                           (px, yc, pz), rot=(0, a, 0), mat=mat, bev=bev))

    if slot_facets and liner_mat is not None:
        out.append(cyl(f"{name}_liner", radius - thick * 0.5 - 0.0015, ln,
                       (0, yc, 0), 'Y', liner_mat, 16))
    return out


def knurl(name, r, h, loc, mat, n=12, axis='Z', tooth=0.0035, deep=0.0022):
    """Grip teeth around a turret or ring."""
    out = []
    for i in range(n):
        a = math.radians(360.0 / n) * i
        if axis == 'Z':
            p = (loc[0] + r * math.cos(a), loc[1] + r * math.sin(a), loc[2])
            out.append(box(f"{name}_k{i}", tooth, deep, h, p, rot=(0, 0, a), mat=mat))
        elif axis == 'X':
            p = (loc[0], loc[1] + r * math.cos(a), loc[2] + r * math.sin(a))
            out.append(box(f"{name}_k{i}", h, tooth, deep, p, rot=(a, 0, 0), mat=mat))
        else:  # 'Y'
            p = (loc[0] + r * math.sin(a), loc[1], loc[2] + r * math.cos(a))
            out.append(box(f"{name}_k{i}", tooth, h, deep, p, rot=(0, a, 0), mat=mat))
    return out


def ribs(name, n, sx, sy, sz, start, step, mat, rot=(0, 0, 0)):
    """A run of evenly spaced ribs — grip texturing, heat-shield fins,
    magazine witness marks."""
    return [box(f"{name}_r{i}", sx, sy, sz,
                (start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i),
                rot=rot, mat=mat) for i in range(n)]


def scope(prefix, mats_, y_ocular, axis_z, tube_r=0.0170, obj_r=0.0315,
          length=1.0, sunshade=True):
    """A modern first-focal-plane tactical scope, laid out from the ocular
    lens backwards so the `sight` anchor always lands on the glass the player
    actually looks through.

    Returns (parts, sight_position).
    """
    o, a, g, al = mats_["optic"], mats_["alu"], mats_["glass"], mats_["alu"]
    p = []
    y = y_ocular

    # --- ocular assembly ---------------------------------------------------
    p.append(cyl(prefix + "_ocl", tube_r * 1.21, 0.0030, (0, y + 0.0015, axis_z),
                 'Y', g, 24))                                  # ocular lens
    p.append(tube(prefix + "_ocbell", tube_r * 1.44, tube_r * 1.19, 0.055,
                  (0, y + 0.0295, axis_z), 'Y', o, 24))        # eyepiece bell
    p += knurl(prefix + "_diop", tube_r * 1.47, 0.014, (0, y + 0.052, axis_z),
               o, n=16, axis='Y', tooth=0.0030, deep=0.0016)
    p.append(cyl(prefix + "_octap", tube_r * 1.44, 0.020, (0, y + 0.067, axis_z),
                 'Y', o, 24, r2=tube_r * 1.50))                # taper to mag ring

    # --- magnification ring + throw lever ----------------------------------
    ymag = y + 0.092
    p.append(cyl(prefix + "_mag", tube_r * 1.50, 0.030, (0, ymag, axis_z), 'Y', o, 24))
    p += knurl(prefix + "_magk", tube_r * 1.50, 0.028, (0, ymag, axis_z),
               al, n=18, axis='Y', tooth=0.0026, deep=0.0016)
    p.append(box(prefix + "_lever", 0.0090, 0.0150, 0.0420,
                 (0.0175, ymag, axis_z + 0.0300), rot=(0, 0.32, 0), mat=al, bev=0.0018))

    # --- main tube + turret saddle ----------------------------------------
    ytube = ymag + 0.0155
    tube_len = 0.185 * length
    p.append(cyl(prefix + "_tube", tube_r, tube_len,
                 (0, ytube + tube_len * 0.5, axis_z), 'Y', o, 24))
    ysad = ytube + tube_len * 0.46
    p.append(box(prefix + "_saddle", 0.0500, 0.0560, 0.0440,
                 (0, ysad, axis_z), mat=o, bev=0.0035))
    # elevation (top), windage (right), parallax (left)
    p.append(cyl(prefix + "_elev", 0.0205, 0.0400, (0, ysad, axis_z + 0.0400), 'Z', al, 20))
    p += knurl(prefix + "_elevk", 0.0205, 0.0360, (0, ysad, axis_z + 0.0400), o, n=14, axis='Z')
    p.append(cyl(prefix + "_elevcap", 0.0215, 0.0060, (0, ysad, axis_z + 0.0625), 'Z', o, 20))
    p.append(cyl(prefix + "_wind", 0.0180, 0.0320, (0.0380, ysad, axis_z), 'X', al, 20))
    p += knurl(prefix + "_windk", 0.0180, 0.0290, (0.0380, ysad, axis_z), o, n=14, axis='X')
    p.append(cyl(prefix + "_par", 0.0190, 0.0300, (-0.0380, ysad, axis_z), 'X', al, 20))
    p += knurl(prefix + "_park", 0.0190, 0.0270, (-0.0380, ysad, axis_z), o, n=14, axis='X')
    p.append(cyl(prefix + "_parcap", 0.0200, 0.0050, (-0.0545, ysad, axis_z), 'X', o, 20))

    # --- objective ---------------------------------------------------------
    yfront = ytube + tube_len
    p.append(cyl(prefix + "_objtap", tube_r, 0.030, (0, yfront + 0.015, axis_z),
                 'Y', o, 24, r2=obj_r))
    p.append(tube(prefix + "_objbell", obj_r, obj_r - 0.0035, 0.080,
                  (0, yfront + 0.070, axis_z), 'Y', o, 28))
    p.append(cyl(prefix + "_objl", obj_r - 0.0032, 0.0030,
                 (0, yfront + 0.104, axis_z), 'Y', g, 28))     # objective lens
    if sunshade:
        p.append(tube(prefix + "_sun", obj_r + 0.0010, obj_r - 0.0025, 0.060,
                      (0, yfront + 0.140, axis_z), 'Y', o, 28))

    return p, (0.0, y_ocular + 0.0005, axis_z)


def scope_mount(prefix, ys, axis_z, rail_top, mat, ring_r=0.0170):
    """Two-piece ring mount bridging the rail up to the scope axis."""
    p = []
    for i, y in enumerate(ys):
        p.append(tube(f"{prefix}_ring{i}", ring_r + 0.0075, ring_r, 0.0260,
                      (0, y, axis_z), 'Y', mat, 22))
        base_h = (axis_z - ring_r - 0.0010) - rail_top
        p.append(box(f"{prefix}_base{i}", 0.0250, 0.0280, base_h,
                     (0, y, rail_top + base_h * 0.5), mat=mat, bev=0.0020))
        # clamp bolts, one either side
        for sx in (-1, 1):
            p.append(cyl(f"{prefix}_bolt{i}{sx}", 0.0032, 0.0060,
                         (sx * 0.0135, y, axis_z - ring_r - 0.0035), 'Z', mat, 10))
    return p


# ---------------------------------------------------------------------------
# Build lifecycle
# ---------------------------------------------------------------------------

def begin(asset_id):
    """Start (or restart) a build. Wipes any previous version of this asset so
    re-running a build script is idempotent."""
    global COLL
    cname = f"{asset_id.upper()}_EXPORT"
    old = bpy.data.collections.get(cname)
    if old:
        for ob in list(old.objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data and data.users == 0:
                if isinstance(data, bpy.types.Mesh):
                    bpy.data.meshes.remove(data)
        bpy.data.collections.remove(old)
    COLL = bpy.data.collections.new(cname)
    bpy.context.scene.collection.children.link(COLL)
    return COLL


def anchor(name, loc, rot=(0, 0, 0), size=0.02):
    """Weapon.js resolves anchors by exact name (`getObjectByName('sight')`),
    but Blender object names are unique scene-wide, so a second weapon would
    silently get `sight.001` and the ADS pose would fall back to the muzzle.

    Empties therefore live under a collection-scoped name and only claim the
    bare name for the duration of the export — see `_claim_anchor_names`.
    """
    e = bpy.data.objects.new(f"{COLL.name}__{name}", None)
    e["anchor"] = name
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = size
    e.location = loc
    e.rotation_euler = Euler(rot)
    COLL.objects.link(e)
    return e


def _claim_anchor_names(coll):
    """Temporarily rename this collection's empties to their bare glTF names,
    evicting whichever asset currently holds them. Returns a restore list."""
    claimed = []
    for e in [o for o in coll.objects if o.type == 'EMPTY']:
        base = e.get("anchor")
        if not base:
            continue
        squatter = bpy.data.objects.get(base)
        if squatter is not None and squatter is not e:
            owner = squatter.users_collection[0].name if squatter.users_collection else "orphan"
            squatter.name = f"{owner}__{base}"
        e.name = base
        if e.name != base:
            raise RuntimeError(f"could not claim anchor name '{base}' (got '{e.name}')")
        claimed.append(e)
    return claimed


def _release_anchor_names(coll, claimed):
    for e in claimed:
        e.name = f"{coll.name}__{e['anchor']}"


def _deselect_all():
    """`bpy.ops.object.select_all` needs a poll-able context, which the MCP
    bridge does not always have. The data API always works."""
    for o in bpy.context.view_layer.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass


def _shade(me, angle=35.0):
    """Auto-smooth without the operator: smooth every face, then mark any
    edge past the crease angle sharp. Blender derives split normals from
    exactly this, and the glTF exporter carries them through."""
    thresh = math.radians(angle)
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            try:
                e.smooth = e.calc_face_angle(0.0) <= thresh
            except Exception:
                e.smooth = False
        else:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()


def finish(asset_id, prefix=None):
    """Merge by material, weld, shade, export. Returns a measurement dict —
    every build script prints it so the numbers can be checked against the
    engine rather than trusted."""
    prefix = prefix or asset_id.upper()
    meshes = [o for o in COLL.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f"{asset_id}: nothing to export")

    groups = {}
    for o in meshes:
        key = o.data.materials[0].name if o.data.materials else "W_None"
        groups.setdefault(key, []).append(o)

    # Every primitive was baked at the origin with an identity transform, so
    # merging is a straight bmesh append — no matrix maths, nothing to get
    # wrong, and no dependency on operator context.
    merged = []
    for mname, objs in sorted(groups.items()):
        bm = bmesh.new()
        for o in objs:
            bm.from_mesh(o.data)
        # 0.05 mm: welds genuinely coincident verts from abutting primitives
        # without pulling separate details into each other.
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00005)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

        name = f"{prefix}_{mname.replace('W_', '')}"
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(bpy.data.materials[mname])
        _shade(me)

        ob = bpy.data.objects.new(name, me)
        COLL.objects.link(ob)
        merged.append(ob)

        for o in objs:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if data.users == 0:
                bpy.data.meshes.remove(data)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{asset_id}.glb")
    _deselect_all()
    for o in COLL.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = merged[0]

    claimed = _claim_anchor_names(COLL)
    exported_anchors = {e.name: [round(v, 4) for v in e.location] for e in claimed}
    kw = dict(filepath=out, export_format='GLB', use_selection=True,
              export_apply=True, export_yup=True, export_animations=False,
              export_cameras=False, export_lights=False)
    try:
        try:
            bpy.ops.export_scene.gltf(**kw)
        except TypeError:
            kw.pop("export_lights", None)
            kw.pop("export_cameras", None)
            bpy.ops.export_scene.gltf(**kw)
    finally:
        _release_anchor_names(COLL, claimed)

    tris = 0
    for o in merged:
        try:
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
        except Exception:
            tris += sum(max(0, len(p.vertices) - 2) for p in o.data.polygons)
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in merged:
        for c in o.bound_box:
            v = o.matrix_world @ Vector(c)
            lo = Vector((min(lo[i], v[i]) for i in range(3)))
            hi = Vector((max(hi[i], v[i]) for i in range(3)))

    return {
        "asset": asset_id,
        "glb": out,
        "kb": round(os.path.getsize(out) / 1024.0, 1),
        "tris": tris,
        "meshes": [o.name for o in merged],
        # Names exactly as they landed in the GLB, so a `.001` suffix is
        # visible here rather than discovered as a null-anchor crash in game.
        "anchors": exported_anchors,
        # Blender-space extents. length_m is the full silhouette along the bore.
        "length_m": round(hi.y - lo.y, 4),
        "height_m": round(hi.z - lo.z, 4),
        "width_m": round(hi.x - lo.x, 4),
    }


def preview(asset_ids, out_png, res=(1100, 620), yaw=-36.0, pitch=-16.0, pad=1.18,
            energy_mul=1.0, transform='Standard', stack=0.24, game_rig=False):
    """Studio-render the named assets so the result can be *looked at* rather
    than inferred from vertex counts. Lays them out in a vertical stack,
    frames a camera on the lot and renders with EEVEE."""
    scene = bpy.context.scene
    if isinstance(asset_ids, str):
        asset_ids = [asset_ids]

    # Isolate: everything not being previewed is hidden for the render.
    targets = [bpy.data.collections[f"{a.upper()}_EXPORT"] for a in asset_ids]
    for c in bpy.data.collections:
        c.hide_render = c not in targets
    for ob in bpy.context.scene.objects:
        if not any(ob.name in c.objects for c in targets):
            ob.hide_render = True

    # Every asset is modelled at the origin, so previewing several at once
    # renders them stacked inside one another. Fan them out along Z for the
    # duration of the render and put them back afterwards.
    moved = []
    if len(targets) > 1:
        for k, c in enumerate(targets):
            dz = (k - (len(targets) - 1) * 0.5) * -stack
            for ob in c.objects:
                ob.location = (ob.location.x, ob.location.y, ob.location.z + dz)
                moved.append((ob, dz))
    bpy.context.view_layer.update()

    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for c in targets:
        for ob in c.objects:
            if ob.type != 'MESH':
                continue
            ob.hide_render = False
            for corner in ob.bound_box:
                v = ob.matrix_world @ Vector(corner)
                lo = Vector((min(lo[i], v[i]) for i in range(3)))
                hi = Vector((max(hi[i], v[i]) for i in range(3)))
    centre = (lo + hi) * 0.5
    radius = max((hi - lo).length * 0.5, 0.05)

    # World + light colours. `game_rig` mirrors WeaponViewModel's three-light
    # setup (cool ambient 0xb9c9d6, warm key 0xfff2dd, cool fill 0x7fa8c8) so
    # a palette can be judged under what the player will actually see rather
    # than under neutral studio light, where warm metals flatter themselves.
    world = bpy.data.worlds.get("PreviewWorld") or bpy.data.worlds.new("PreviewWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = ((0.500, 0.596, 0.678, 1.0) if game_rig
                                  else (0.045, 0.048, 0.055, 1.0))
    bg.inputs[1].default_value = 0.28 if game_rig else 1.0
    scene.world = world
    TINT = {
        "key": (1.000, 0.949, 0.867) if game_rig else (1.0, 1.0, 1.0),
        "fill": (0.498, 0.659, 0.784) if game_rig else (1.0, 1.0, 1.0),
        "rim": (0.780, 0.850, 1.000) if game_rig else (1.0, 1.0, 1.0),
    }

    for old in [o for o in bpy.data.objects if o.name.startswith("__prev")]:
        bpy.data.objects.remove(old, do_unlink=True)

    cam_data = bpy.data.cameras.new("__prevcam")
    cam_data.lens = 70.0
    cam = bpy.data.objects.new("__prevcam", cam_data)
    scene.collection.objects.link(cam)
    ry, rp = math.radians(yaw), math.radians(pitch)
    dist = radius * pad / math.tan(math.radians(18.0))
    cam.location = centre + Vector((
        math.sin(ry) * math.cos(rp), -math.cos(ry) * math.cos(rp), -math.sin(rp))) * dist
    d = (centre - cam.location).normalized()
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    # Three-point rig: key high-left, fill low-right, rim from behind.
    for nm, loc, energy, size in (
        ("key", (-1.6, -1.4, 1.9), 900.0, 2.2),
        ("fill", (1.9, -1.1, -0.5), 260.0, 3.0),
        ("rim", (0.6, 2.2, 1.4), 700.0, 2.0),
    ):
        ld = bpy.data.lights.new("__prev" + nm, 'AREA')
        ld.energy = energy * max(radius, 0.25) * energy_mul
        ld.size = size * max(radius, 0.25)
        ld.color = TINT[nm]
        lo_ = bpy.data.objects.new("__prev" + nm, ld)
        scene.collection.objects.link(lo_)
        lo_.location = centre + Vector(loc) * dist * 0.55
        lo_.rotation_euler = (centre - lo_.location).to_track_quat('-Z', 'Y').to_euler()

    scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in \
        [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] \
        else 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    try:
        scene.view_settings.view_transform = transform
        scene.view_settings.look = 'None'
    except Exception:
        pass
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)

    for old in [o for o in bpy.data.objects if o.name.startswith("__prev")]:
        bpy.data.objects.remove(old, do_unlink=True)
    for c in bpy.data.collections:
        c.hide_render = False
    for ob, dz in moved:
        ob.location = (ob.location.x, ob.location.y, ob.location.z - dz)
    return out_png


def finish_parts(asset_id, order=None):
    """Export merged by PART instead of by material.

    Weapons merge by material because nothing addresses them individually.
    The soldier is the opposite case: Enemy.js looks up `head`, `legL`,
    `armorPlate` and so on by name to animate, tint, hit-flash and toggle
    them, so each part has to survive as its own mesh.

    Objects are tagged with a `part__detail` naming convention and grouped on
    the prefix. A part must use exactly one material — the engine replaces
    GLB materials with its own per-enemy clones keyed by part name, and a
    multi-material part would have no single clone to map to.
    """
    meshes = [o for o in COLL.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f"{asset_id}: nothing to export")

    groups = {}
    for o in meshes:
        groups.setdefault(o.name.split("__")[0], []).append(o)

    merged = []
    for part in (order or sorted(groups)):
        objs = groups.get(part)
        if not objs:
            raise RuntimeError(f"{asset_id}: part '{part}' has no geometry")
        names = {o.data.materials[0].name for o in objs if o.data.materials}
        if len(names) != 1:
            raise RuntimeError(f"{asset_id}: part '{part}' spans materials {sorted(names)}")

        bm = bmesh.new()
        for o in objs:
            bm.from_mesh(o.data)
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00005)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        me = bpy.data.meshes.new(part)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(bpy.data.materials[names.pop()])
        _shade(me, 40.0)

        ob = bpy.data.objects.new(part, me)
        COLL.objects.link(ob)
        merged.append(ob)
        for o in objs:
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if data.users == 0:
                bpy.data.meshes.remove(data)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{asset_id}.glb")
    _deselect_all()
    for o in COLL.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = merged[0]
    kw = dict(filepath=out, export_format='GLB', use_selection=True,
              export_apply=True, export_yup=True, export_animations=False,
              export_cameras=False, export_lights=False)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop("export_lights", None)
        kw.pop("export_cameras", None)
        bpy.ops.export_scene.gltf(**kw)

    stats = {}
    for o in merged:
        try:
            o.data.calc_loop_triangles()
            t = len(o.data.loop_triangles)
        except Exception:
            t = sum(max(0, len(p.vertices) - 2) for p in o.data.polygons)
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        # Reported in three.js space (x right, y up, -z forward) because that
        # is the frame the engine positions these parts in.
        stats[o.name] = {
            "tris": t,
            "y": [round(min(v.z for v in bb), 3), round(max(v.z for v in bb), 3)],
            "x": [round(min(v.x for v in bb), 3), round(max(v.x for v in bb), 3)],
        }
    return {"asset": asset_id, "glb": out,
            "kb": round(os.path.getsize(out) / 1024.0, 1),
            "tris": sum(s["tris"] for s in stats.values()),
            "parts": stats}


def save_blend():
    path = os.path.join(PROJECT, "assets", "blender", "breachpoint_assets.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path)
    return path

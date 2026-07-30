"""AR-15 CARBINE — recolour and re-export pass.

The carbine was modelled before this library existed, so unlike the other
eleven weapons it has no build script: all that survives is the merged meshes
in AR15_EXPORT carrying their own AR_* materials. Re-modelling it just to
change its colour would be wasteful and would risk moving anchors that are
already verified in-engine, so this reassigns the shared palette onto the
existing geometry and re-exports it untouched otherwise.

LIVERY — burnt bronze metalwork over black polymer furniture. Bronze is a
metal here, so its warm tint survives the ACES roll-off; a bright diffuse
brown would wash to grey under the view-model key light.
"""

import bpy

coll = bpy.data.collections.get("AR15_EXPORT")
if coll is None:
    raise RuntimeError(
        "AR15_EXPORT collection is missing — the carbine cannot be recoloured "
        "without re-modelling it. Check breachpoint_assets.blend is loaded."
    )
COLL = coll
m = mats()

REMAP = {
    "AR_Metal": m["bronze"],
    "AR_Polymer": m["poly"],
    "AR_Optic": m["optic"],
    "AR_Glass": m["glass"],
}

swapped = []
for ob in [o for o in coll.objects if o.type == 'MESH']:
    for i in range(len(ob.data.materials)):
        old = ob.data.materials[i]
        if old is not None and old.name in REMAP:
            swapped.append(f"{ob.name}: {old.name} -> {REMAP[old.name].name}")
            ob.data.materials[i] = REMAP[old.name]

# This collection predates the anchor-naming scheme, so its empties carry no
# `anchor` custom property and finish() would export them under whatever
# collection-scoped name they were evicted to — silently breaking the ADS
# pose. Tag them from their base name before exporting.
for e in [o for o in coll.objects if o.type == 'EMPTY']:
    e["anchor"] = e.name.split("__")[-1]

RESULT = finish("ar15")
RESULT["swapped"] = swapped

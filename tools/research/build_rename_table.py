"""Build app/core/data/renames.json from the pixel comparison report plus a
small curated supplement. Only texture *names* are written.

Usage: python tools/research/build_rename_table.py <renames-report.json> <out.json> [.minecraft]
"""

import json
import os
import sys
import zipfile

TEX = "assets/minecraft/textures/"
COLORS = ["black", "blue", "brown", "cyan", "gray", "green", "light_blue", "lime", "magenta",
          "orange", "pink", "purple", "red", "silver", "white", "yellow"]


def new_color(c):
    return "light_gray" if c == "silver" else c


def main():
    report = json.load(open(sys.argv[1], encoding="utf-8"))
    out_path = sys.argv[2]
    root = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.environ.get("APPDATA", ""), ".minecraft")

    flat = {}
    source = {}

    def put(old, new, src):
        if old in flat and flat[old] != new:
            print("CONFLICT", old, flat[old], "(%s)" % source[old], "vs", new, "(%s)" % src, file=sys.stderr)
            if src != "curated":
                return
        flat[old] = new
        source[old] = src

    # 1. machine-verified: identical pixels under another name (blocks/items only)
    for old, new in report["flattening"]["renamed"].items():
        if old.startswith(("blocks/", "items/")):
            put(old, new, "pixels")

    # 2. curated: ambiguous pixel matches, textures redrawn before 1.13, and
    #    targets that were renamed again after 1.13 (must point at the 1.13 name)
    cur = {
        "blocks/leaves_acacia": "block/acacia_leaves", "blocks/leaves_big_oak": "block/dark_oak_leaves",
        "blocks/leaves_birch": "block/birch_leaves", "blocks/leaves_oak": "block/oak_leaves",
        "blocks/melon_stem_connected": "block/attached_melon_stem",
        "blocks/melon_stem_disconnected": "block/melon_stem",
        "blocks/pumpkin_stem_connected": "block/attached_pumpkin_stem",
        "blocks/pumpkin_stem_disconnected": "block/pumpkin_stem",
        "blocks/noteblock": "block/note_block", "blocks/tallgrass": "block/grass",
        "items/potion_bottle_drinkable": "item/potion", "items/potion_bottle_empty": "item/glass_bottle",
        "blocks/double_plant_paeonia_top": "block/peony_top",
        "blocks/redstone_dust_cross": "block/redstone_dust_dot",
        "blocks/redstone_dust_line": "block/redstone_dust_line0",
        "items/boat": "item/oak_boat",
        "items/book_enchanted": "item/enchanted_book", "items/clock": "item/clock_00",
        "items/compass": "item/compass_00", "items/fish_clownfish_raw": "item/tropical_fish",
        "items/fish_cod_cooked": "item/cooked_cod", "items/fish_cod_raw": "item/cod",
        "items/fish_pufferfish_raw": "item/pufferfish", "items/fish_salmon_cooked": "item/cooked_salmon",
        "items/fish_salmon_raw": "item/salmon", "items/map_empty": "item/map",
        "items/map_filled": "item/filled_map", "items/porkchop_cooked": "item/cooked_porkchop",
        # 1.13 names (renamed again in 1.14, see the 1.14 step)
        "items/dye_powder_red": "item/rose_red", "items/dye_powder_green": "item/cactus_green",
        "items/dye_powder_yellow": "item/dandelion_yellow", "items/sign": "item/sign",
        "blocks/stone_slab_side": "block/stone_slab_side", "blocks/stone_slab_top": "block/stone_slab_top",
    }
    for stage in range(3):
        cur["blocks/carrots_stage_%d" % stage] = "block/carrots_stage%d" % stage
        cur["blocks/potatoes_stage_%d" % stage] = "block/potatoes_stage%d" % stage
    for wood_old, wood_new in (("acacia", "acacia"), ("birch", "birch"), ("dark_oak", "dark_oak"), ("jungle", "jungle")):
        cur["blocks/door_%s_lower" % wood_old] = "block/%s_door_bottom" % wood_new
        cur["blocks/door_%s_upper" % wood_old] = "block/%s_door_top" % wood_new
    for c in COLORS:
        cur["blocks/wool_colored_" + c] = "block/%s_wool" % new_color(c)
    for old, new in cur.items():
        put(old, new, "curated")

    # 3. textures added in 1.9-1.12 (no local jar): Minecraft Wiki,
    #    "Java Edition 1.13/Resource pack changes"
    wiki = {
        "blocks/end_bricks": "block/end_stone_bricks", "blocks/observer_back_lit": "block/observer_back_on",
        "blocks/red_nether_brick": "block/red_nether_bricks",
        "items/chorus_fruit_popped": "item/popped_chorus_fruit",
        "items/potion_bottle_lingering": "item/lingering_potion", "items/totem": "item/totem_of_undying",
    }
    for stage in range(4):
        wiki["blocks/beetroots_stage_%d" % stage] = "block/beetroots_stage%d" % stage
    for c in COLORS:
        n = new_color(c)
        wiki["blocks/concrete_" + c] = "block/%s_concrete" % n
        wiki["blocks/concrete_powder_" + c] = "block/%s_concrete_powder" % n
        wiki["blocks/glazed_terracotta_" + c] = "block/%s_glazed_terracotta" % n
        wiki["blocks/shulker_top_" + c] = "block/%s_shulker_box" % n
    for old, new in wiki.items():
        if old not in flat:
            put(old, new, "wiki")

    # drop identities (covered by the folder rule)
    def identity(old, new):
        return old.replace("blocks/", "block/", 1).replace("items/", "item/", 1) == new

    files = {o: n for o, n in sorted(flat.items()) if not identity(o, n)}

    removed = ["blocks/bed_feet_end", "blocks/bed_feet_side", "blocks/bed_feet_top", "blocks/bed_head_end",
               "blocks/bed_head_side", "blocks/bed_head_top", "blocks/command_block", "blocks/flower_paeonia",
               "items/banner_base", "items/banner_overlay", "items/bed", "items/quiver"]

    # ---- later steps
    steps_by_pair = {(s["from"], s["to"]): s["renamed_same_pixels"] for s in report["steps"]}
    r_2105 = {k: v for k, v in steps_by_pair.get(("1.21.1", "1.21.5"), {}).items() if isinstance(v, str)}
    step_1_21_5 = {k: v for k, v in r_2105.items() if k == "entity/chicken"}
    step_1_21_4 = {k: v for k, v in r_2105.items() if k == "item/broken_elytra"}
    step_1_21_2 = {k: v for k, v in r_2105.items() if k not in step_1_21_5 and k not in step_1_21_4}
    r_2111 = {k: v for k, v in steps_by_pair.get(("1.21.8", "1.21.11"), {}).items() if isinstance(v, str)}
    step_1_21_9 = {k: v for k, v in r_2111.items() if k.endswith("/chain")}
    step_1_21_11 = {k: v for k, v in r_2111.items() if k not in step_1_21_9}

    data = {
        "schema": 1,
        "about": "Texture renames between Minecraft Java versions. Paths are relative to assets/minecraft/textures, "
                 "without .png. A step applies when crossing from a version below 'version' to that version or above.",
        "steps": [
            {"id": "flattening", "version": "1.13",
             "folders": {"blocks": "block", "items": "item"},
             "files": files, "removed": removed,
             "sources": {"pixels": sum(1 for o in files if source[o] == "pixels"),
                         "curated": sum(1 for o in files if source[o] == "curated"),
                         "wiki": sum(1 for o in files if source[o] == "wiki")}},
            {"id": "1.14", "version": "1.14", "verified": "knowledge", "files": {
                "item/cactus_green": "item/green_dye", "item/dandelion_yellow": "item/yellow_dye",
                "item/rose_red": "item/red_dye", "item/sign": "item/oak_sign",
                "block/stone_slab_side": "block/smooth_stone_slab_side", "block/stone_slab_top": "block/smooth_stone",
                "entity/sign": "entity/signs/oak"}},
            {"id": "1.17", "version": "1.17", "verified": "knowledge", "files": {
                "block/grass_path_side": "block/dirt_path_side", "block/grass_path_top": "block/dirt_path_top"}},
            {"id": "1.20.3", "version": "1.20.3", "verified": "pixels 1.20.1 vs 1.20.4",
             "files": {"block/grass": "block/short_grass"}},
            {"id": "1.20.5", "version": "1.20.5", "verified": "pixels 1.20.4 vs 1.21.1",
             "files": {"item/scute": "item/turtle_scute"}},
            {"id": "1.21.2", "version": "1.21.2", "verified": "pixels 1.21.1 vs 1.21.5 (exact version from knowledge)",
             "files": dict(sorted(step_1_21_2.items()))},
            {"id": "1.21.4", "version": "1.21.4", "verified": "pixels 1.21.1 vs 1.21.5 (exact version from knowledge)",
             "files": step_1_21_4},
            {"id": "1.21.5", "version": "1.21.5", "verified": "pixels 1.21.1 vs 1.21.5", "files": step_1_21_5},
            {"id": "1.21.9", "version": "1.21.9", "verified": "pixels 1.21.8 vs 1.21.11 (exact version from knowledge)",
             "files": step_1_21_9},
            {"id": "1.21.11", "version": "1.21.11", "verified": "pixels 1.21.8 vs 1.21.11", "files": step_1_21_11},
        ],
    }

    # ---- sanity check against real name lists (names only)
    names = {}
    vdir = os.path.join(root, "versions")
    for v in ("1.20.1", "1.21.11"):
        jar = os.path.join(vdir, v, v + ".jar")
        if os.path.isfile(jar):
            with zipfile.ZipFile(jar) as z:
                names[v] = {n[len(TEX):-4] for n in z.namelist() if n.startswith(TEX) and n.endswith(".png")}
    if "1.20.1" in names:
        later = {}
        for st in data["steps"][1:]:
            later.update(st["files"])
        missing = []
        for old, new in files.items():
            cur_name = new
            for _ in range(4):
                cur_name = later.get(cur_name, cur_name) if cur_name not in names["1.20.1"] else cur_name
            if cur_name not in names["1.20.1"]:
                missing.append((old, new, source[old]))
        print("flattening entries:", len(files), data["steps"][0]["sources"], file=sys.stderr)
        print("targets not found in 1.20.1 (after later steps):", missing, file=sys.stderr)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()

"""Stage 0 research: read facts straight out of the installed Minecraft jars.

Nothing is extracted to disk and no texture is copied anywhere. The script only
prints names, sizes, counts and small JSON snippets, as one JSON document.

Usage:  python tools/research/inspect_jars.py [path-to-.minecraft] > facts.json
"""

import json
import os
import struct
import sys
import zipfile
from collections import Counter

TEX = "assets/minecraft/textures/"


def png_size(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return [w, h]


def inspect(jar_path):
    out = {}
    with zipfile.ZipFile(jar_path) as z:
        names = z.namelist()
        nameset = set(names)

        # 1. version.json
        if "version.json" in nameset:
            v = json.loads(z.read("version.json"))
            out["version_json"] = {
                k: v.get(k)
                for k in ("id", "name", "pack_version", "world_version", "protocol_version", "java_version")
            }
        else:
            out["version_json"] = None

        # 2. texture folders
        tex = [n for n in names if n.startswith(TEX) and not n.endswith("/")]
        pngs = [n for n in tex if n.endswith(".png")]
        top = Counter()
        for n in pngs:
            rest = n[len(TEX):]
            top[rest.split("/")[0] if "/" in rest else "(root)"] += 1
        out["texture_png_count"] = len(pngs)
        out["texture_top_folders"] = dict(sorted(top.items()))
        out["other_texture_files"] = dict(Counter(os.path.splitext(n)[1] for n in tex if not n.endswith(".png")))

        # 3. GUI
        gui = [n for n in pngs if n.startswith(TEX + "gui/")]
        sprites = [n for n in gui if n.startswith(TEX + "gui/sprites/")]
        out["gui_png_count"] = len(gui)
        out["gui_sprites_png_count"] = len(sprites)
        sub = Counter(n[len(TEX + "gui/sprites/"):].split("/")[0] for n in sprites)
        out["gui_sprites_subfolders"] = dict(sorted(sub.items()))
        gui_meta = [n for n in tex if n.startswith(TEX + "gui/") and n.endswith(".mcmeta")]
        types = Counter()
        examples = {}
        keys_seen = Counter()
        for n in gui_meta:
            try:
                m = json.loads(z.read(n))
            except Exception as e:  # noqa: BLE001
                types["(unreadable)"] += 1
                continue
            for k in m:
                keys_seen[k] += 1
            sc = (m.get("gui") or {}).get("scaling") or {}
            t = sc.get("type", "(none)")
            types[t] += 1
            for k in sc:
                keys_seen["gui.scaling." + k] += 1
            b = sc.get("border")
            kind = t + (":border-object" if isinstance(b, dict) else ":border-int" if isinstance(b, int) else "")
            if kind not in examples:
                examples[kind] = {"file": n[len(TEX):], "json": m}
        out["gui_mcmeta_count"] = len(gui_meta)
        out["gui_scaling_types"] = dict(types)
        out["gui_mcmeta_keys"] = dict(keys_seen)
        out["gui_mcmeta_examples"] = examples
        out["gui_non_sprite_examples"] = sorted(n[len(TEX):] for n in gui if "/sprites/" not in n)[:400]
        for probe in ("gui/widgets.png", "gui/icons.png", "gui/container/inventory.png"):
            p = TEX + probe
            out.setdefault("gui_probe", {})[probe] = png_size(z.read(p)) if p in nameset else None

        # 4. particles
        pj = [n for n in names if n.startswith("assets/minecraft/particles/") and n.endswith(".json")]
        out["particle_json_count"] = len(pj)
        pj_examples = {}
        for want in ("smoke", "flame", "explosion", "enchant", "portal", "campfire_cosy_smoke", "heart", "note", "bubble"):
            p = "assets/minecraft/particles/%s.json" % want
            if p in nameset:
                pj_examples[want] = json.loads(z.read(p))
        out["particle_json_examples"] = pj_examples
        ppng = sorted(n[len(TEX):] for n in pngs if n.startswith(TEX + "particle/"))
        out["particle_png_count"] = len(ppng)
        out["particle_png_first"] = ppng[:12]
        sheet = TEX + "particle/particles.png"
        out["particles_png_size"] = png_size(z.read(sheet)) if sheet in nameset else None
        for probe in ("entity/explosion.png", "particle/footprint.png", "misc/enchanting_table_glyph.png", "font/ascii_sga.png"):
            p = TEX + probe
            out.setdefault("particle_probe", {})[probe] = png_size(z.read(p)) if p in nameset else None

        # 5. animations
        anim_meta = [n for n in tex if n.endswith(".png.mcmeta") and not n.startswith(TEX + "gui/")]
        anim = []
        akeys = Counter()
        frame_kinds = Counter()
        for n in anim_meta:
            try:
                m = json.loads(z.read(n))
            except Exception:  # noqa: BLE001
                continue
            for k in m:
                akeys[k] += 1
            a = m.get("animation")
            if a is None:
                continue
            for k in a:
                akeys["animation." + k] += 1
            for f in a.get("frames", []) or []:
                frame_kinds["object" if isinstance(f, dict) else "int"] += 1
            png = n[: -len(".mcmeta")]
            anim.append({"file": png[len(TEX):], "size": png_size(z.read(png)) if png in nameset else None, "animation": a})
        out["animated_count"] = len(anim)
        out["non_gui_mcmeta_keys"] = dict(akeys)
        out["animation_frame_entry_kinds"] = dict(frame_kinds)
        pick = {}
        for a in anim:
            base = a["file"].split("/")[-1]
            if base in ("prismarine.png", "prismarine_rough.png", "magma.png", "magma_block.png", "water_still.png",
                        "lava_still.png", "fire_0.png", "fire_layer_0.png", "sea_lantern.png", "clock_00.png",
                        "campfire_fire.png", "kelp.png"):
                pick[a["file"]] = a
        out["animation_examples"] = pick
        out["animated_by_folder"] = dict(Counter(a["file"].split("/")[0] for a in anim))
        # tall PNGs without mcmeta (height multiple of width, > width)
        metas = set(anim_meta)
        tall = []
        for n in pngs:
            if not (n.startswith(TEX + "block") or n.startswith(TEX + "item")):
                continue
            s = png_size(z.read(n))
            if s and s[1] > s[0] and s[1] % s[0] == 0 and (n + ".mcmeta") not in metas:
                tall.append([n[len(TEX):], s])
        out["tall_without_mcmeta"] = tall[:20]

        # pack.mcmeta in the jar, models, misc
        out["has_pack_mcmeta"] = "pack.mcmeta" in nameset
        if out["has_pack_mcmeta"]:
            try:
                out["pack_mcmeta"] = json.loads(z.read("pack.mcmeta"))
            except Exception:  # noqa: BLE001
                out["pack_mcmeta"] = "(unreadable)"
        out["model_block_count"] = sum(1 for n in names if n.startswith("assets/minecraft/models/block/") and n.endswith(".json"))
        out["blockstates_count"] = sum(1 for n in names if n.startswith("assets/minecraft/blockstates/") and n.endswith(".json"))
        out["items_defs_count"] = sum(1 for n in names if n.startswith("assets/minecraft/items/") and n.endswith(".json"))
        out["atlases"] = sorted(n for n in names if n.startswith("assets/minecraft/atlases/"))
        out["block_size_histogram"] = dict(
            Counter(
                "%dx%d" % tuple(png_size(z.read(n)))
                for n in pngs
                if n.startswith(TEX + "block/") or n.startswith(TEX + "blocks/")
            ).most_common(8)
        )
    return out


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("APPDATA", ""), ".minecraft")
    versions_dir = os.path.join(root, "versions")
    result = {"minecraft_dir_exists": os.path.isdir(root), "versions": {}, "no_jar": []}
    if os.path.isdir(versions_dir):
        for name in sorted(os.listdir(versions_dir)):
            jar = os.path.join(versions_dir, name, name + ".jar")
            if os.path.isfile(jar):
                try:
                    result["versions"][name] = inspect(jar)
                except Exception as e:  # noqa: BLE001
                    result["versions"][name] = {"error": repr(e)}
            elif os.path.isdir(os.path.join(versions_dir, name)):
                result["no_jar"].append(name)
    json.dump(result, sys.stdout, indent=1)


if __name__ == "__main__":
    main()

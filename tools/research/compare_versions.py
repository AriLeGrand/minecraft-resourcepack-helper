"""Stage 0 research: find texture renames by comparing pixels between versions.

Reads textures in memory only (nothing is written except a JSON report of
*names*). Two comparisons:

1. 1.8.9 jar (old names)  vs  the "Programmer Art" pack that the launcher
   downloads (old pixels, post-1.13 names) plus a modern jar. A texture whose
   pixels are identical under a different name is a rename.
2. Each pair of adjacent installed versions: a name that disappears while a
   new name appears with identical pixels is a rename.

Usage: python tools/research/compare_versions.py [.minecraft] > renames-report.json
"""

import json
import os
import sys
import zipfile
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from pngmini import pixel_hash  # noqa: E402

TEX = "assets/minecraft/textures/"


def load_zip(path, max_bytes=200_000):
    """name (without .png, relative to textures/) -> pixel hash"""
    out = {}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            n = info.filename
            if not (n.startswith(TEX) and n.endswith(".png")):
                continue
            rel = n[len(TEX):-4]
            if info.file_size > max_bytes:
                out[rel] = None
                continue
            try:
                out[rel] = pixel_hash(z.read(n))
            except Exception:  # noqa: BLE001
                out[rel] = None
    return out


def find_programmer_art(root):
    """Return the paths of every programmer_art.zip the launcher has downloaded."""
    found = {}
    idx_dir = os.path.join(root, "assets", "indexes")
    if not os.path.isdir(idx_dir):
        return found
    for f in sorted(os.listdir(idx_dir)):
        try:
            with open(os.path.join(idx_dir, f), encoding="utf-8") as fh:
                objs = json.load(fh)["objects"]
        except Exception:  # noqa: BLE001
            continue
        o = objs.get("minecraft/resourcepacks/programmer_art.zip")
        if o:
            p = os.path.join(root, "assets", "objects", o["hash"][:2], o["hash"])
            if os.path.isfile(p):
                found[f] = p
    return found


def version_key(name):
    parts = []
    for p in name.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    return parts


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("APPDATA", ""), ".minecraft")
    vdir = os.path.join(root, "versions")
    jars = {}
    for name in os.listdir(vdir):
        jar = os.path.join(vdir, name, name + ".jar")
        if os.path.isfile(jar):
            with zipfile.ZipFile(jar) as z:
                vid = name
                if "version.json" in z.namelist():
                    vid = json.loads(z.read("version.json")).get("id", name)
            jars.setdefault(vid, jar)
    order = sorted(jars, key=version_key)
    tex = {v: load_zip(jars[v]) for v in order}
    report = {"versions": order, "counts": {v: len(tex[v]) for v in order}}

    # ---- 1. flattening: 1.8.9 -> programmer art / modern names
    old_v = order[0]
    old = tex[old_v]
    pa_paths = find_programmer_art(root)
    report["programmer_art_indexes"] = sorted(pa_paths)
    by_hash = defaultdict(set)
    pa_names = set()
    for _idx, p in pa_paths.items():
        for n, h in load_zip(p).items():
            pa_names.add(n)
            if h:
                by_hash[h].add(n)
    modern_names = set()
    for v in order[1:]:
        for n, h in tex[v].items():
            modern_names.add(n)
            if h:
                by_hash[h].add(n)
    first_modern = tex[order[1]] if len(order) > 1 else {}

    def flat_candidates(old_name):
        """Old folder -> where it may have gone."""
        folder = old_name.split("/")[0]
        return {"blocks": ("block/",), "items": ("item/",)}.get(folder, (folder + "/",))

    renamed, same, unmatched, ambiguous = {}, [], [], {}
    for n, h in sorted(old.items()):
        folder, _, rest = n.partition("/")
        prefixes = flat_candidates(n)
        new_same = prefixes[0] + rest if folder in ("blocks", "items") else n
        cands = sorted(c for c in by_hash.get(h, ()) if h and c.startswith(prefixes))
        if new_same in cands or (not cands and (new_same in pa_names or new_same in modern_names)):
            if new_same in cands:
                same.append(n)
            else:
                unmatched.append({"old": n, "note": "same name exists in a newer version, pixels differ"})
            continue
        if len(cands) == 1:
            renamed[n] = cands[0]
        elif len(cands) > 1:
            ambiguous[n] = cands
        else:
            # look anywhere (texture moved to another folder)
            anywhere = sorted(by_hash.get(h, ())) if h else []
            if anywhere:
                ambiguous[n] = anywhere
            else:
                unmatched.append({"old": n, "note": "no pixel match and no same-name file"})
    report["flattening"] = {
        "from": old_v,
        "same_name_count": len(same),
        "renamed": renamed,
        "ambiguous": ambiguous,
        "unmatched": unmatched,
    }
    report["first_modern_names_not_reached"] = None  # filled by curate step

    # ---- 2. adjacent modern versions
    steps = []
    for a, b in zip(order[1:], order[2:]):
        ta, tb = tex[a], tex[b]
        removed = sorted(set(ta) - set(tb))
        added = sorted(set(tb) - set(ta))
        added_by_hash = defaultdict(list)
        for n in added:
            if tb[n]:
                added_by_hash[tb[n]].append(n)
        ren, gone = {}, []
        for n in removed:
            c = added_by_hash.get(ta[n], []) if ta[n] else []
            if len(c) == 1:
                ren[n] = c[0]
            elif len(c) > 1:
                ren[n] = c
            else:
                gone.append(n)
        steps.append({"from": a, "to": b, "renamed_same_pixels": ren, "removed_no_match": gone,
                      "added_count": len(added), "added": added})
    report["steps"] = steps
    json.dump(report, sys.stdout, indent=1)


if __name__ == "__main__":
    main()

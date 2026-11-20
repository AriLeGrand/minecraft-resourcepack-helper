"""Find where the modern separate GUI sprites (1.20.2+) sit inside the old
shared images (gui/widgets.png, gui/icons.png) by comparing pixels.

Usage (developer only; reads the extracted game cache, prints JSON):

    python tools/research/find_gui_regions.py app/target/devdata/cache/vanilla \
        1.21.11 1.20.1 1.8.9 > gui-regions-report.json

For every sprite of the modern version (widget/, hud/, hud/heart/, boss_bar/,
icon/) the script looks for an exact pixel match (fully transparent pixels are
normalised) at every position of each shared image of each old version.
Sprites that are fully transparent are skipped. The result lists every match,
so a sprite found at the same rectangle in several versions is confirmed in
each of them. Nothing here is copied anywhere: only names and rectangles.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import pngmini  # noqa: E402

GROUPS = ["widget", "hud", "hud/heart", "boss_bar", "icon"]
SHARED = ["gui/widgets", "gui/icons", "gui/bars"]


def load(path):
    with open(path, "rb") as f:
        d = pngmini.decode(f.read())
    if d is None:
        return None
    w, h, px = d
    px = bytearray(px)
    for i in range(3, len(px), 4):
        if px[i] == 0:
            px[i - 3] = px[i - 2] = px[i - 1] = 0
    return w, h, bytes(px)


def rows(img):
    w, h, px = img
    return [px[y * w * 4:(y + 1) * w * 4] for y in range(h)]


def find(sprite, sheet):
    sw, sh, _ = sprite
    W, H, _ = sheet
    if sw > W or sh > H:
        return []
    srows = rows(sprite)
    hrows = rows(sheet)
    # the most opaque row is the key that is searched first
    key = max(range(sh), key=lambda y: sum(1 for i in range(3, len(srows[y]), 4) if srows[y][i]))
    if not any(srows[key][3::4]):
        return None  # fully transparent: anything would match
    out = []
    for y in range(0, H - sh + 1):
        line = hrows[y + key]
        start = 0
        while True:
            i = line.find(srows[key], start)
            if i < 0:
                break
            start = i + 1
            if i % 4:
                continue
            x = i // 4
            if x + sw > W:
                continue
            if all(hrows[y + r][x * 4:(x + sw) * 4] == srows[r] for r in range(sh)):
                out.append([x, y])
    return out


def main():
    cache, modern, *old = sys.argv[1:]
    tex = lambda v: os.path.join(cache, v, "assets", "minecraft", "textures")  # noqa: E731
    sheets = {}
    for v in old:
        for s in SHARED:
            p = os.path.join(tex(v), *s.split("/")) + ".png"
            if os.path.isfile(p):
                sheets[(v, s)] = load(p)
    report = {"modern": modern, "sheets": {f"{v}:{s}": [img[0], img[1]] for (v, s), img in sheets.items()}, "found": {}, "not_found": [], "transparent": []}
    for g in GROUPS:
        d = os.path.join(tex(modern), "gui", "sprites", *g.split("/"))
        for f in sorted(os.listdir(d)):
            if not f.endswith(".png"):
                continue
            name = f"{g}/{f[:-4]}"
            sprite = load(os.path.join(d, f))
            hits = {}
            transparent = False
            for (v, s), sheet in sheets.items():
                r = find(sprite, sheet)
                if r is None:
                    transparent = True
                    break
                if r:
                    hits[f"{v}:{s}"] = r
            if transparent:
                report["transparent"].append(name)
            elif hits:
                report["found"][name] = {"size": [sprite[0], sprite[1]], "at": hits}
            else:
                report["not_found"].append(name)
    json.dump(report, sys.stdout, indent=1)


if __name__ == "__main__":
    main()

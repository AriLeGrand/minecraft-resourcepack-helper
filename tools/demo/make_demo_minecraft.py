#!/usr/bin/env python3
"""Builds a FAKE Minecraft folder for demos and README screenshots.

    python tools/demo/make_demo_minecraft.py app/target/devdata/demo/.minecraft

Everything inside is drawn by this script: no file of the real game is read,
copied or traced. The two "game jars" (1.21.11 and 1.8.9) are plain zip files
with the same folder layout as the real ones, so Pack Creator can find and
extract them like real versions. The only files of this repository it reads
are Pack Creator's own position tables (particle sheet cells and old GUI
rectangles), which hold names and numbers only.

Standard library only (zlib + struct for the PNGs, zipfile for the jars).
"""

import json
import math
import shutil
import struct
import sys
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "app" / "core" / "data"
ZIP_TIME = (2026, 1, 1, 12, 0, 0)

# --------------------------------------------------------------------------
# Images


def hexc(s, a=255):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)


CLEAR = (0, 0, 0, 0)


class Img:
    def __init__(self, w, h, fill=CLEAR):
        self.w, self.h = w, h
        self.px = [fill] * (w * h)

    def set(self, x, y, c):
        if c is not None and 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = c

    def get(self, x, y):
        return self.px[y * self.w + x]

    def rect(self, x, y, w, h, c):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.set(xx, yy, c)

    def frame(self, x, y, w, h, c):
        for xx in range(x, x + w):
            self.set(xx, y, c)
            self.set(xx, y + h - 1, c)
        for yy in range(y, y + h):
            self.set(x, yy, c)
            self.set(x + w - 1, yy, c)

    def blit(self, other, ox, oy):
        for y in range(other.h):
            for x in range(other.w):
                c = other.get(x, y)
                if c[3]:
                    self.set(ox + x, oy + y, c)

    def outline(self, c):
        """Puts `c` on every clear pixel that touches a drawn one (4 sides)."""
        add = []
        for y in range(self.h):
            for x in range(self.w):
                if self.get(x, y)[3]:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < self.w and 0 <= ny < self.h and self.get(nx, ny)[3] and self.get(nx, ny) != c:
                        add.append((x, y))
                        break
        for x, y in add:
            self.set(x, y, c)
        return self

    def png(self):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)
            for x in range(self.w):
                raw.extend(self.px[y * self.w + x])

        def chunk(kind, body):
            return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )


def stack(frames):
    """Vertical strip of equal frames (an animated texture)."""
    out = Img(frames[0].w, frames[0].h * len(frames))
    for i, f in enumerate(frames):
        out.blit(f, 0, i * f.h)
    return out


def art(rows, pal):
    """Small pixel art from text rows; '.' is clear, other letters index `pal`."""
    w = max(len(r) for r in rows)
    img = Img(w, len(rows))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                img.set(x, y, hexc(pal[ch]))
    return img


def recolor(img, mapping):
    out = Img(img.w, img.h)
    m = {hexc(k): hexc(v) for k, v in mapping.items()}
    out.px = [m.get(c, c) for c in img.px]
    return out


# --------------------------------------------------------------------------
# Noise (deterministic, tileable)


def hash01(x, y, seed):
    n = (x * 374761393 + y * 668265263 + seed * 982451653) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n ^= n >> 16
    return (n & 0xFFFFFF) / 0x1000000


def vnoise(x, y, cell, period, seed):
    gx, gy = x / cell, y / cell
    x0, y0 = math.floor(gx), math.floor(gy)
    fx, fy = gx - x0, gy - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)

    def v(i, j):
        return hash01(i % period, j % period, seed)

    a, b, c, d = v(x0, y0), v(x0 + 1, y0), v(x0, y0 + 1), v(x0 + 1, y0 + 1)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy


def fbm(x, y, n, seed):
    """Three octaves of value noise that tile over an n x n texture."""
    return (
        0.5 * vnoise(x, y, n / 2, 2, seed)
        + 0.3 * vnoise(x, y, n / 4, 4, seed + 1)
        + 0.2 * vnoise(x, y, n / 8, 8, seed + 2)
    )


def pick(pal, v):
    v = min(0.999, max(0.0, v))
    return hexc(pal[int(v * len(pal))])


def stretch(v, lo=0.25, hi=0.75):
    return (v - lo) / (hi - lo)


# --------------------------------------------------------------------------
# Blocks

N = 16

STONE = ["#5d5f66", "#6c6e75", "#7a7c83", "#878990", "#94969c"]
ANDESITE = ["#5f6466", "#6f7577", "#80878a", "#90979a", "#a4abad"]
GRANITE = ["#7a4b3b", "#8f5a46", "#a26a53", "#b47c63", "#c99079"]
DIORITE = ["#8f8f93", "#a9a9ad", "#c1c1c4", "#d5d5d8", "#ececee"]
DEEPSLATE = ["#2b2b31", "#36363d", "#414149", "#4d4d56", "#5a5a63"]
DIRT = ["#5a3d27", "#6b4a30", "#7c573a", "#8d6646", "#9c7552"]
SAND = ["#c9b27a", "#d6bf86", "#e0ca92", "#e9d59f", "#f2e1b0"]
OAK = ["#6e5130", "#9a7444", "#a8834f", "#b48b55", "#c49a62"]
BARK = ["#3b2a17", "#4a3520", "#5a4128", "#6b4e31"]
TEAL = ["#2e5e55", "#3c7468", "#4f8f82", "#63a597", "#7fc3b4"]
BRICK = ["#7e3b2c", "#934634", "#a5523d", "#b65f47"]
GREYS = ["#6f6f6f", "#808080", "#929292", "#a4a4a4", "#b6b6b6", "#c8c8c8"]


def noisy(pal, seed, grain=0.12, contrast=1.0):
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            v = fbm(x, y, N, seed)
            v = 0.5 + (stretch(v) - 0.5) * contrast + (hash01(x, y, seed + 9) - 0.5) * grain * 2
            img.set(x, y, pick(pal, v))
    return img


def stone(pal, seed):
    img = noisy(pal, seed, grain=0.18)
    # a few darker flecks
    for i in range(6):
        x, y = int(hash01(i, 1, seed) * N), int(hash01(i, 2, seed) * N)
        img.set(x, y, hexc(pal[0]))
        if hash01(i, 3, seed) < 0.5:
            img.set((x + 1) % N, y, hexc(pal[0]))
    return img


def cobblestone(seed=31):
    pts = [(hash01(i, 0, seed) * N, hash01(i, 1, seed) * N) for i in range(9)]
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            ds = []
            for i, (px, py) in enumerate(pts):
                dx = min(abs(x + 0.5 - px), N - abs(x + 0.5 - px))
                dy = min(abs(y + 0.5 - py), N - abs(y + 0.5 - py))
                ds.append((math.hypot(dx, dy), i))
            ds.sort()
            (d1, i1), (d2, _) = ds[0], ds[1]
            if d2 - d1 < 1.1:
                img.set(x, y, hexc("#4a4b50"))
            else:
                base = 0.3 + hash01(i1, 7, seed) * 0.45
                light = 0.18 if (d1 < 2.2 and (y + 0.5) < pts[i1][1]) else 0
                v = base + light - d1 * 0.03 + (hash01(x, y, seed + 3) - 0.5) * 0.2
                img.set(x, y, pick(STONE, v))
    return img


def planks(pal=OAK, seed=9):
    img = Img(N, N)
    band = N // 4
    for y in range(N):
        row = y // band
        seam = int(N * 0.3) if row % 2 == 0 else int(N * 0.75)
        for x in range(N):
            if y % band == band - 1:
                c = pal[0]
            elif x == seam:
                c = pal[1]
            else:
                g = vnoise(x, y * 4, 8, 2, seed + row) * 0.6 + hash01(x, y, seed) * 0.4
                c = pal[1 + min(3, int(g * 4))]
                if y % band == 0:
                    c = pal[min(4, pal.index(c) + 1)]
            img.set(x, y, hexc(c))
    return img


def log_side(seed=5):
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            v = vnoise(x * 3, y, 8, 6, seed) * 0.75 + hash01(x, y, seed) * 0.25
            if x % 4 == 0 and hash01(x, y // 3, seed + 1) < 0.6:
                v *= 0.5
            img.set(x, y, pick(BARK, v))
    return img


def log_top():
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            if x in (0, N - 1) or y in (0, N - 1):
                img.set(x, y, hexc(BARK[1 + (x + y) % 2]))
                continue
            d = max(abs(x - 7.5), abs(y - 7.5))
            ring = int(d + hash01(x, y, 4) * 0.6)
            img.set(x, y, hexc(OAK[1 if ring % 2 else 3]))
    return img


def glass():
    img = Img(N, N)
    img.frame(0, 0, N, N, hexc("#dcecf2"))
    for i in range(1, N - 1):
        img.set(i, N - 1, hexc("#9fb8c2"))
        img.set(N - 1, i, hexc("#9fb8c2"))
    for t in range(4):
        img.set(3 + t, 6 - t, hexc("#ffffff", 200))
        img.set(4 + t, 6 - t, hexc("#ffffff", 120))
    for t in range(3):
        img.set(10 + t, 13 - t, hexc("#ffffff", 160))
    return img


def bricks():
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            row = y // 4
            off = 0 if row % 2 == 0 else 4
            if y % 4 == 3 or (x + off) % 8 == 7:
                img.set(x, y, hexc("#a79a8c") if (x + y) % 3 else hexc("#968a7d"))
            else:
                v = 0.35 + hash01((x + off) // 8, row, 3) * 0.4 + (hash01(x, y, 4) - 0.5) * 0.3
                if y % 4 == 0:
                    v += 0.25
                img.set(x, y, pick(BRICK, v))
    return img


def grass_top():
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            v = fbm(x, y, N, 21) * 0.5 + hash01(x, y, 22) * 0.5
            img.set(x, y, pick(GREYS, stretch(v, 0.2, 0.8)))
    return img


def grass_edge(x):
    return 3 + int(hash01(x, 0, 23) * 2.6)


def grass_side():
    img = noisy(DIRT, 12, grain=0.2)
    green = ["#5b8a32", "#6b9c3a", "#7cae44", "#8cbd52"]
    for x in range(N):
        for y in range(grass_edge(x)):
            img.set(x, y, pick(green, hash01(x, y, 24)))
    return img


def grass_overlay():
    img = Img(N, N)
    for x in range(N):
        for y in range(grass_edge(x)):
            img.set(x, y, pick(GREYS, hash01(x, y, 24)))
    return img


def short_grass():
    img = Img(N, N)
    for i in range(7):
        x = 1 + int(hash01(i, 0, 40) * 14)
        h = 6 + int(hash01(i, 1, 40) * 9)
        lean = -1 if hash01(i, 2, 40) < 0.5 else 1
        for t in range(h):
            xx = x + (lean if t > h * 0.6 else 0)
            img.set(xx, N - 1 - t, pick(GREYS, 0.3 + t / h * 0.7))
    return img


def poppy():
    img = Img(N, N)
    for y in range(8, N):
        img.set(7, y, hexc("#3f7a2c"))
    for p in [(5, 11), (6, 10), (9, 12), (8, 11)]:
        img.set(*p, hexc("#5e9c3c"))
    petals = art(
        ["..rRr..", ".rRRRr.", "rRRyRRr", ".rRRRd.", "..rdd.."],
        {"r": "#c2232e", "R": "#e2404a", "y": "#2b1a12", "d": "#8e1820"},
    )
    img.blit(petals, 4, 3)
    return img


def leaves():
    img = Img(N, N)
    for y in range(N):
        for x in range(N):
            v = fbm(x, y, N, 50) * 0.6 + hash01(x, y, 51) * 0.4
            if hash01(x, y, 52) < 0.12:
                continue
            img.set(x, y, pick(GREYS[:5], stretch(v, 0.2, 0.8)))
    return img


def prismarine_frames(count=4):
    frames = []
    for f in range(count):
        img = Img(N, N)
        for y in range(N):
            for x in range(N):
                cx, cy = x // 4, y // 4
                base = 1 + int(hash01(cx, cy, 11) * 3)
                phase = hash01(cx, cy, 12) * math.tau
                k = base + round(math.sin(f / count * math.tau + phase) * 1.2)
                k += 1 if hash01(x, y, 13 + f) < 0.2 else 0
                if x % 8 == 0 or y % 8 == 0:
                    k = 0
                img.set(x, y, hexc(TEAL[max(0, min(4, k))]))
        frames.append(img)
    return frames


def sea_lantern_frames(count=5):
    pal = ["#5d8f86", "#8fbfb4", "#b9e0d6", "#d9f2ec", "#f4fffb"]
    frames = []
    for f in range(count):
        img = Img(N, N)
        for y in range(N):
            for x in range(N):
                if x in (0, N - 1) or y in (0, N - 1):
                    img.set(x, y, hexc(pal[1]))
                elif x in (7, 8) or y in (7, 8):
                    img.set(x, y, hexc(pal[2]))
                else:
                    q = (x > 7) + 2 * (y > 7)
                    glow = 0.5 + 0.5 * math.sin((f / count + q * 0.25) * math.tau)
                    d = max(abs((x % 8) - 3.5), abs((y % 8) - 3.5)) / 3.5
                    img.set(x, y, pick(pal, 0.45 + glow * 0.5 - d * 0.35))
        frames.append(img)
    return frames


# --------------------------------------------------------------------------
# Items


def gem(pal):
    rows = [
        "................",
        "................",
        "....oooooooo....",
        "...oWCCcCCcCo...",
        "..oWCCcCCCCcCo..",
        ".oCCCcCCCCCCcdo.",
        ".oooooooooooooo.",
        "..ocCCCCCCCCdo..",
        "...ocCCCCCCdo...",
        "....ocCCCCdo....",
        ".....ocCCdo.....",
        "......ocdo......",
        ".......oo.......",
    ]
    return art(rows + ["." * 16] * (16 - len(rows)), pal)


def emerald():
    rows = [
        "................",
        "......oooo......",
        ".....oWCCco.....",
        "....oWCCCcco....",
        "...oWCCCCccdo...",
        "...oCCCCCccdo...",
        "...oCCCCCccdo...",
        "...oCCCCCccdo...",
        "...oCCCCCccdo...",
        "...ocCCCCcddo...",
        "....ocCCcddo....",
        ".....occddo.....",
        "......oooo......",
    ]
    pal = {"o": "#0e3b1f", "W": "#d6ffe3", "C": "#3fd27a", "c": "#22a85a", "d": "#137a3e"}
    return art(rows + ["." * 16] * (16 - len(rows)), pal)


APPLE_PAL = {"o": "#3b0d12", "R": "#cf2f3b", "h": "#ff9f9f", "r": "#9e1c27", "d": "#6e1019", "s": "#5a3a1e", "l": "#4f9a3a", "L": "#79c25a"}


def apple(pal=APPLE_PAL):
    rows = [
        "................",
        "........s.......",
        ".......s..ll....",
        ".......s.lLLl...",
        "....ooosollo....",
        "...oRRRsRRRoo...",
        "..oRhhRRRRRRro..",
        "..oRhRRRRRRRro..",
        "..oRRRRRRRRRro..",
        "..oRRRRRRRRrro..",
        "..oRRRRRRRRrro..",
        "...oRRRRRRrro...",
        "...ordRRRrrdo...",
        "....oddooddo....",
        ".....oo..oo.....",
        "................",
    ]
    return art(rows, pal)


def sword(blade=("#f2f4f7", "#b9c0c9", "#7d8591"), guard=("#d9b048", "#8a6a1f")):
    img = Img(16, 16)
    light, mid, dark = (hexc(c) for c in blade)
    for t in range(9):
        x, y = 14 - t, 1 + t
        img.set(x, y, mid)
        img.set(x - 1, y, light)
        img.set(x, y + 1, dark)
    for i, (x, y) in enumerate([(3, 8), (4, 9), (5, 10), (6, 11), (7, 12)]):
        img.set(x, y, hexc(guard[i % 2]))
    for x, y in [(4, 11), (3, 12), (2, 13)]:
        img.set(x, y, hexc("#6b4423"))
    img.set(1, 14, hexc(guard[0]))
    return img.outline(hexc("#16161c"))


def stick():
    img = Img(16, 16)
    for t in range(10):
        img.set(12 - t, 3 + t, hexc("#8a6237"))
        img.set(13 - t, 3 + t, hexc("#5e3f1f"))
    img.set(12, 3, hexc("#a77a48"))
    return img.outline(hexc("#2a1a0c"))


def ingot(pal):
    rows = [
        "................",
        "................",
        "................",
        "................",
        "......oooooooo..",
        ".....oWLLLLLLdo.",
        "....oWLLLLLLLdo.",
        "...oLLLLLLLLddo.",
        "..oLLLLLLLLddo..",
        ".oLLLLLLLLddo...",
        ".odddddddddo....",
        "..ooooooooo.....",
    ]
    return art(rows + ["." * 16] * 4, pal)


IRON = {"o": "#2d2f35", "W": "#ffffff", "L": "#d8dce2", "d": "#9aa1ab"}
GOLD = {"o": "#4a3208", "W": "#fff6b0", "L": "#f2c94c", "d": "#c08a1e"}


# --------------------------------------------------------------------------
# Entities, paintings, environment


def chest_entity():
    img = Img(64, 64)
    wood = ["#5b3a1e", "#6e4826", "#83582f", "#946639"]
    for (x, y, w, h) in [(0, 0, 56, 19), (0, 19, 56, 33)]:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                v = vnoise(xx * 2, yy, 8, 32, 61) * 0.7 + hash01(xx, yy, 62) * 0.3
                img.set(xx, yy, pick(wood, v))
        img.frame(x, y, w, h, hexc("#2e1c0d"))
    img.rect(0, 0, 6, 5, hexc("#cfd3d8"))
    img.frame(0, 0, 6, 5, hexc("#4b4f57"))
    return img


def sheep_entity():
    img = Img(64, 32)
    wool = ["#c9c4bc", "#d9d5ce", "#e8e5df", "#f5f3ef"]
    for y in range(32):
        for x in range(64):
            if x < 28 and y < 16:
                v = fbm(x, y, 32, 70)
                img.set(x, y, pick(["#7b6f66", "#8c8076", "#a09389", "#b3a79c"], stretch(v)))
            elif y >= 8:
                v = hash01(x, y, 71) * 0.5 + fbm(x, y, 32, 72) * 0.5
                img.set(x, y, pick(wool, stretch(v, 0.2, 0.8)))
    for x, y in [(8, 10), (14, 10)]:
        img.rect(x, y, 2, 1, hexc("#1d1a18"))
    return img


def painting_sea():
    img = Img(32, 16)
    for y in range(16):
        for x in range(32):
            if y < 6:
                c = ["#f6d7a7", "#f3c08a", "#ee9f72"][min(2, y // 2)]
            else:
                wave = math.sin(x / 3 + y) * 0.5 + 0.5
                c = pick(["#173f5f", "#20639b", "#3caea3", "#7fd1c7"], (16 - y) / 12 * 0.7 + wave * 0.3)
                img.set(x, y, c)
                continue
            img.set(x, y, hexc(c))
    for x in range(22, 27):
        img.set(x, 5, hexc("#fff3d1"))
    img.frame(0, 0, 32, 16, hexc("#5b3a1e"))
    return img


def sun():
    img = Img(32, 32)
    for y in range(32):
        for x in range(32):
            d = math.hypot(x - 15.5, y - 15.5)
            if d < 8:
                img.set(x, y, hexc("#fff4c2" if d < 5 else "#ffe27a"))
            elif d < 11 and (x + y) % 2 == 0:
                img.set(x, y, hexc("#ffd04d", 160))
    return img


def effect_icon():
    img = Img(18, 18)
    for i, (cx, cy, r) in enumerate([(6, 11, 4), (12, 6, 3), (13, 13, 2)]):
        for y in range(18):
            for x in range(18):
                d = math.hypot(x - cx, y - cy)
                if r - 1 <= d < r:
                    img.set(x, y, hexc("#bfe9ff"))
                elif d < r - 1:
                    img.set(x, y, hexc("#3f8fd2", 140))
        img.set(cx - 1, cy - r + 1, hexc("#ffffff"))
    return img


# --------------------------------------------------------------------------
# Interface pieces. Each drawer paints into an image at (ox, oy) with the
# piece's size, so the same code makes the separate sprites of new versions
# and the shared sheets (widgets.png, icons.png, bars.png) of old ones.


def button(img, ox, oy, w, h, kind="normal"):
    if kind == "disabled":
        fill, top, bot, edge = "#2f2f33", "#3b3b40", "#26262a", "#000000"
    else:
        fill, top, bot = "#717176", "#a6a6ac", "#4e4e53"
        edge = "#ffffff" if kind == "highlighted" else "#000000"
    for y in range(h):
        for x in range(w):
            v = hash01(x // 2, y // 2, 80)
            c = hexc(fill)
            if kind != "disabled" and v < 0.25:
                c = hexc("#6a6a6f")
            img.set(ox + x, oy + y, c)
    img.rect(ox + 1, oy + 1, w - 2, 1, hexc(top))
    img.rect(ox + 1, oy + 1, 1, h - 3, hexc(top))
    img.rect(ox + 1, oy + h - 3, w - 2, 2, hexc(bot))
    img.rect(ox + w - 2, oy + 1, 1, h - 3, hexc(bot))
    img.frame(ox, oy, w, h, hexc(edge))


def text_field(img, ox, oy, w, h, highlighted=False):
    img.rect(ox, oy, w, h, hexc("#000000"))
    img.frame(ox, oy, w, h, hexc("#ffffff" if highlighted else "#a0a0a0"))


def checkbox(img, ox, oy, w, h, selected=False):
    text_field(img, ox, oy, w, h)
    img.rect(ox + 2, oy + 2, w - 4, h - 4, hexc("#1c1c20"))
    if selected:
        for x, y in [(5, 10), (6, 11), (7, 12), (8, 13), (9, 12), (10, 11), (11, 10), (12, 9), (13, 8), (14, 7)]:
            img.rect(ox + x, oy + y, 2, 2, hexc("#7fe08a"))


HEART = [
    ".ooo.ooo.",
    "oRhRoRRRo",
    "oRhRRRRRo",
    "oRRRRRRRo",
    ".oRRRRRo.",
    "..oRRRo..",
    "...oRo...",
    "....o....",
    ".........",
]
HEART_COLORS = {
    "red": ("#d8232f", "#ff8c8c"),
    "poisoned": ("#7a9a24", "#c6e070"),
    "withered": ("#2b2b2b", "#6b6b6b"),
    "absorbing": ("#e3b52b", "#fff09a"),
    "frozen": ("#79c6f0", "#e4f7ff"),
    "vehicle": ("#e07a2b", "#ffc48c"),
}


def heart(img, ox, oy, w, h, fill="full", colors="red", blink=False):
    red, hi = HEART_COLORS[colors]
    edge = "#ffffff" if blink else "#1a0b0b"
    for y, row in enumerate(HEART):
        for x, ch in enumerate(row):
            if ch == "o":
                img.set(ox + x, oy + y, hexc(edge))
            elif ch in "Rh":
                inside = fill == "full" or (fill == "half" and x <= 4)
                if fill == "container":
                    img.set(ox + x, oy + y, hexc("#3a1416", 200))
                elif inside:
                    img.set(ox + x, oy + y, hexc(hi if (ch == "h" or blink) else red))


FOOD = [
    "....ooo..",
    "...oBBBo.",
    "..oBbBBBo",
    "..oBBBBbo",
    ".ooBBBBo.",
    "oWoooBo..",
    "oWWo.o...",
    ".oo......",
    ".........",
]


def food(img, ox, oy, w, h, fill="full", hunger=False):
    meat = ("#7d8c2c", "#a6b84a") if hunger else ("#a4562c", "#d98a4e")
    for y, row in enumerate(FOOD):
        for x, ch in enumerate(row):
            if ch == "o":
                img.set(ox + x, oy + y, hexc("#24120a"))
            elif ch in "Bb":
                if fill == "empty" or (fill == "half" and x < 4):
                    img.set(ox + x, oy + y, hexc("#3a2418", 200))
                else:
                    img.set(ox + x, oy + y, hexc(meat[1] if ch == "b" else meat[0]))
            elif ch == "W":
                img.set(ox + x, oy + y, hexc("#f2ead8" if fill != "empty" else "#5a5048"))


def armor(img, ox, oy, w, h, fill="full"):
    rows = ["oo...oo..", "oAoooAo..", "oAAAAAo..", ".oAAAo...", ".oAAAo...", ".oAAAo...", ".ooooo..."]
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "o":
                img.set(ox + x + 1, oy + y + 1, hexc("#1d1f24"))
            elif ch == "A":
                on = fill == "full" or (fill == "half" and x < 4)
                img.set(ox + x + 1, oy + y + 1, hexc("#d6dbe2" if on else "#3b3e45"))


def bubble(img, ox, oy, w, h, popped=False):
    for y in range(9):
        for x in range(9):
            d = math.hypot(x - 4, y - 4)
            if 3 <= d < 4.2:
                img.set(ox + x, oy + y, hexc("#9fdcff", 120 if popped else 255))
            elif d < 3 and not popped:
                img.set(ox + x, oy + y, hexc("#2f79c4", 120))
    if not popped:
        img.set(ox + 3, oy + 2, hexc("#ffffff"))


def crosshair(img, ox, oy, w, h):
    for i in range(15):
        if abs(i - 7) > 1:
            img.set(ox + i, oy + 7, hexc("#ffffff", 230))
            img.set(ox + 7, oy + i, hexc("#ffffff", 230))
    img.set(ox + 7, oy + 7, hexc("#ffffff", 230))


def bar(img, ox, oy, w, h, color, progress=False):
    img.rect(ox, oy, w, h, hexc("#1b1b1f"))
    if progress:
        img.rect(ox + 1, oy + 1, w - 2, h - 2, hexc(color))
        img.rect(ox + 1, oy + 1, w - 2, 1, hexc("#ffffff", 120))
    else:
        img.rect(ox + 1, oy + 1, w - 2, h - 2, hexc("#3a3a42"))


def notches(img, ox, oy, w, h, count, progress=False):
    for i in range(1, count):
        x = ox + round(i * (w - 1) / count)
        img.rect(x, oy, 1, h, hexc("#ffffff" if progress else "#5a5a64", 180))


def hotbar(img, ox, oy, w, h):
    img.rect(ox, oy, w, h, hexc("#2b2c31", 220))
    img.frame(ox, oy, w, h, hexc("#0f0f12"))
    for i in range(9):
        x = ox + 1 + i * 20
        img.frame(x, oy + 1, 20, 20, hexc("#8a8b93"))
        img.frame(x + 1, oy + 2, 18, 18, hexc("#4a4b52"))


def hotbar_selection(img, ox, oy, w, h):
    img.frame(ox, oy, w, h - 1, hexc("#0f0f12"))
    img.frame(ox + 1, oy + 1, w - 2, h - 3, hexc("#ffffff"))
    img.frame(ox + 2, oy + 2, w - 4, h - 5, hexc("#cfd2da"))


def offhand(img, ox, oy, w, h):
    img.rect(ox, oy + 1, 22, 22, hexc("#2b2c31", 220))
    img.frame(ox, oy + 1, 22, 22, hexc("#0f0f12"))
    img.frame(ox + 1, oy + 2, 20, 20, hexc("#8a8b93"))


def lock_button(img, ox, oy, w, h, locked=True, kind="normal"):
    button(img, ox, oy, w, h, kind)
    col = hexc("#e8e8ee" if kind != "disabled" else "#6a6a70")
    img.rect(ox + 6, oy + 9, 8, 6, col)
    img.frame(ox + 7, oy + 4, 6, 6, col)
    if not locked:
        img.rect(ox + 11, oy + 7, 2, 2, CLEAR)


def lang_button(img, ox, oy, w, h, kind="normal"):
    button(img, ox, oy, w, h, kind)
    for y in range(20):
        for x in range(20):
            d = math.hypot(x - 9.5, y - 9.5)
            if 5 <= d < 6 or (d < 6 and (abs(x - 9.5) < 0.6 or abs(y - 9.5) < 0.6)):
                img.set(ox + x, oy + y, hexc("#e8e8ee"))


def attack_indicator(img, ox, oy, w, h, progress=False):
    img.rect(ox, oy, w, h, hexc("#1b1b1f", 200))
    img.frame(ox, oy, w, h, hexc("#8a8b93"))
    if progress:
        img.rect(ox + 2, oy + 2, w - 4, h - 4, hexc("#e8e8ee"))


def panel(img, ox, oy, w, h):
    img.rect(ox + 1, oy + 1, w - 2, h - 2, hexc("#c6c6c6"))
    img.rect(ox + 1, oy + 1, w - 3, 2, hexc("#ffffff"))
    img.rect(ox + 1, oy + 1, 2, h - 3, hexc("#ffffff"))
    img.rect(ox + 3, oy + h - 3, w - 4, 2, hexc("#555555"))
    img.rect(ox + w - 3, oy + 3, 2, h - 4, hexc("#555555"))
    img.rect(ox + 1, oy, w - 2, 1, hexc("#000000"))
    img.rect(ox + 1, oy + h - 1, w - 2, 1, hexc("#000000"))
    img.rect(ox, oy + 1, 1, h - 2, hexc("#000000"))
    img.rect(ox + w - 1, oy + 1, 1, h - 2, hexc("#000000"))


def slot(img, x, y, size=18):
    img.rect(x, y, size, size, hexc("#8b8b8b"))
    img.rect(x, y, size - 1, 1, hexc("#373737"))
    img.rect(x, y, 1, size - 1, hexc("#373737"))
    img.rect(x + 1, y + size - 1, size - 1, 1, hexc("#ffffff"))
    img.rect(x + size - 1, y + 1, 1, size - 1, hexc("#ffffff"))


def inventory_container():
    img = Img(256, 256)
    panel(img, 0, 0, 176, 166)
    for r in range(3):
        for c in range(9):
            slot(img, 7 + c * 18, 83 + r * 18)
    for c in range(9):
        slot(img, 7 + c * 18, 141)
    for r in range(4):
        slot(img, 7, 7 + r * 18)
    slot(img, 76, 61)
    for r in range(2):
        for c in range(2):
            slot(img, 97 + c * 18, 17 + r * 18)
    slot(img, 153, 27)
    img.rect(25, 7, 52, 72, hexc("#000000"))
    for t in range(6):
        img.rect(138 + t, 33 + t // 2 * 0, 1, 1, CLEAR)
    for x in range(135, 149):
        img.set(x, 35, hexc("#8b8b8b"))
    return img


def chest_container():
    img = Img(256, 256)
    panel(img, 0, 0, 176, 222)
    for r in range(6):
        for c in range(9):
            slot(img, 7 + c * 18, 17 + r * 18)
    for r in range(3):
        for c in range(9):
            slot(img, 7 + c * 18, 139 + r * 18)
    for c in range(9):
        slot(img, 7 + c * 18, 197)
    return img


def slot_highlight(img, ox, oy, w, h, front=False):
    img.frame(ox, oy, w, h, hexc("#ffffff", 200 if front else 90))
    if not front:
        img.rect(ox + 1, oy + 1, w - 2, h - 2, hexc("#ffffff", 50))


def recipe_button(img, ox, oy, w, h):
    button(img, ox, oy, w, h)
    img.rect(ox + 5, oy + 4, w - 10, h - 8, hexc("#3fae5a"))


# piece id (as in gui_regions.json) -> drawer(img, x, y, w, h)
GUI_PIECES = {
    "hotbar": hotbar,
    "hotbar_selection": hotbar_selection,
    "hotbar_offhand_left": offhand,
    "hotbar_offhand_right": offhand,
    "button_disabled": lambda i, x, y, w, h: button(i, x, y, w, h, "disabled"),
    "button": button,
    "button_highlighted": lambda i, x, y, w, h: button(i, x, y, w, h, "highlighted"),
    "language_button": lang_button,
    "language_button_highlighted": lambda i, x, y, w, h: lang_button(i, x, y, w, h, "highlighted"),
    "locked_button": lock_button,
    "locked_button_highlighted": lambda i, x, y, w, h: lock_button(i, x, y, w, h, True, "highlighted"),
    "locked_button_disabled": lambda i, x, y, w, h: lock_button(i, x, y, w, h, True, "disabled"),
    "unlocked_button": lambda i, x, y, w, h: lock_button(i, x, y, w, h, False),
    "unlocked_button_highlighted": lambda i, x, y, w, h: lock_button(i, x, y, w, h, False, "highlighted"),
    "unlocked_button_disabled": lambda i, x, y, w, h: lock_button(i, x, y, w, h, False, "disabled"),
    "crosshair": crosshair,
    "heart_container": lambda i, x, y, w, h: heart(i, x, y, w, h, "container"),
    "heart_container_blinking": lambda i, x, y, w, h: heart(i, x, y, w, h, "container", blink=True),
    "heart_full": heart,
    "heart_half": lambda i, x, y, w, h: heart(i, x, y, w, h, "half"),
    "heart_full_blinking": lambda i, x, y, w, h: heart(i, x, y, w, h, "full", blink=True),
    "heart_half_blinking": lambda i, x, y, w, h: heart(i, x, y, w, h, "half", blink=True),
    "armor_empty": lambda i, x, y, w, h: armor(i, x, y, w, h, "empty"),
    "armor_half": lambda i, x, y, w, h: armor(i, x, y, w, h, "half"),
    "armor_full": armor,
    "air": bubble,
    "air_bursting": lambda i, x, y, w, h: bubble(i, x, y, w, h, popped=True),
    "food_empty": lambda i, x, y, w, h: food(i, x, y, w, h, "empty"),
    "food_full": food,
    "food_half": lambda i, x, y, w, h: food(i, x, y, w, h, "half"),
    "food_full_hunger": lambda i, x, y, w, h: food(i, x, y, w, h, "full", True),
    "food_half_hunger": lambda i, x, y, w, h: food(i, x, y, w, h, "half", True),
    "food_empty_hunger": lambda i, x, y, w, h: food(i, x, y, w, h, "empty", True),
    "hardcore_container": lambda i, x, y, w, h: heart(i, x, y, w, h, "container"),
    "hardcore_full": lambda i, x, y, w, h: heart(i, x, y, w, h, "full", "withered"),
    "hardcore_half": lambda i, x, y, w, h: heart(i, x, y, w, h, "half", "withered"),
    "experience_bar_background": lambda i, x, y, w, h: bar(i, x, y, w, h, "#7ed957"),
    "experience_bar_progress": lambda i, x, y, w, h: bar(i, x, y, w, h, "#7ed957", True),
    "boss_bar_background": lambda i, x, y, w, h: bar(i, x, y, w, h, "#e05aa8"),
    "boss_bar_progress": lambda i, x, y, w, h: bar(i, x, y, w, h, "#e05aa8", True),
    "jump_bar_background": lambda i, x, y, w, h: bar(i, x, y, w, h, "#4f8fff"),
    "jump_bar_progress": lambda i, x, y, w, h: bar(i, x, y, w, h, "#4f8fff", True),
    "hotbar_attack_indicator_background": attack_indicator,
    "hotbar_attack_indicator_progress": lambda i, x, y, w, h: attack_indicator(i, x, y, w, h, True),
    "crosshair_attack_indicator_background": attack_indicator,
    "crosshair_attack_indicator_progress": lambda i, x, y, w, h: attack_indicator(i, x, y, w, h, True),
    "crosshair_attack_indicator_full": lambda i, x, y, w, h: attack_indicator(i, x, y, w, h, True),
}
for kind, colors in [("poisoned", "poisoned"), ("withered", "withered"), ("absorbing", "absorbing"), ("frozen", "frozen"), ("vehicle", "vehicle")]:
    GUI_PIECES[f"{kind}_full"] = lambda i, x, y, w, h, c=colors: heart(i, x, y, w, h, "full", c)
    GUI_PIECES[f"{kind}_half"] = lambda i, x, y, w, h, c=colors: heart(i, x, y, w, h, "half", c)
GUI_PIECES["vehicle_container"] = GUI_PIECES["heart_container"]
BOSS = {"pink": "#e05aa8", "blue": "#4f8fff", "red": "#e0453a", "green": "#5fd35a", "yellow": "#f0d23c", "purple": "#a35ae0", "white": "#f0f0f0"}
for name, col in BOSS.items():
    GUI_PIECES[f"{name}_background"] = lambda i, x, y, w, h, c=col: bar(i, x, y, w, h, c)
    GUI_PIECES[f"{name}_progress"] = lambda i, x, y, w, h, c=col: bar(i, x, y, w, h, c, True)
for n in (6, 10, 12, 20):
    GUI_PIECES[f"notched_{n}_background"] = lambda i, x, y, w, h, n=n: notches(i, x, y, w, h, n)
    GUI_PIECES[f"notched_{n}_progress"] = lambda i, x, y, w, h, n=n: notches(i, x, y, w, h, n, True)

# Sprites of new versions that have no rectangle in the old sheets.
EXTRA_SPRITES = {
    "widget/slider": (200, 20, lambda i, x, y, w, h: button(i, x, y, w, h, "disabled")),
    "widget/slider_highlighted": (200, 20, lambda i, x, y, w, h: (button(i, x, y, w, h, "disabled"), i.frame(x, y, w, h, hexc("#ffffff")))),
    "widget/slider_handle": (8, 20, button),
    "widget/slider_handle_highlighted": (8, 20, lambda i, x, y, w, h: button(i, x, y, w, h, "highlighted")),
    "widget/text_field": (200, 20, text_field),
    "widget/text_field_highlighted": (200, 20, lambda i, x, y, w, h: text_field(i, x, y, w, h, True)),
    "widget/checkbox": (20, 20, checkbox),
    "widget/checkbox_selected": (20, 20, lambda i, x, y, w, h: checkbox(i, x, y, w, h, True)),
    "widget/checkbox_highlighted": (20, 20, lambda i, x, y, w, h: (checkbox(i, x, y, w, h), i.frame(x, y, w, h, hexc("#ffffff")))),
    "hud/air_empty": (9, 9, lambda i, x, y, w, h: bubble(i, x, y, w, h, popped=True)),
    "container/slot_highlight_back": (24, 24, slot_highlight),
    "container/slot_highlight_front": (24, 24, lambda i, x, y, w, h: slot_highlight(i, x, y, w, h, True)),
    "recipe_book/button": (20, 18, recipe_button),
}

# The game's nine-slice rules for the widgets (same shape as the real files).
NINE_SLICE = {
    "widget/button": (200, 20, 3),
    "widget/button_highlighted": (200, 20, 3),
    "widget/button_disabled": (200, 20, 1),
    "widget/slider": (200, 20, 3),
    "widget/slider_highlighted": (200, 20, 3),
    "widget/slider_handle": (8, 20, {"left": 2, "top": 2, "right": 2, "bottom": 3}),
    "widget/slider_handle_highlighted": (8, 20, {"left": 2, "top": 2, "right": 2, "bottom": 3}),
    "widget/text_field": (200, 20, 1),
    "widget/text_field_highlighted": (200, 20, 1),
    "widget/locked_button": (20, 20, 3),
    "widget/unlocked_button": (20, 20, 3),
}


# --------------------------------------------------------------------------
# Particles (8x8 cells unless said otherwise)


def puff(img, ox, oy, r, base="#e8e8ec"):
    for y in range(8):
        for x in range(8):
            d = math.hypot(x - 3.5, y - 3.5)
            if d <= r:
                v = 1 - d / (r + 0.01)
                img.set(ox + x, oy + y, hexc("#ffffff" if v > 0.6 else base if v > 0.25 else "#b9b9c0"))


def flame(img, ox, oy, soul=False):
    pal = {"o": "#3a7bd5", "y": "#bff3ff", "r": "#2456a8"} if soul else {"o": "#ff8a1f", "y": "#fff27a", "r": "#d8401c"}
    rows = ["...o....", "..oo....", "..oyo...", ".oyyo.o.", ".oyyyoo.", "royyyyor", "rooyyoor", ".rroorr."]
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                img.set(ox + x, oy + y, hexc(pal[ch]))


def small_heart(img, ox, oy):
    rows = [".rr.rr..", "rhRrRRr.", "rhRRRRr.", "rRRRRRr.", ".rRRRr..", "..rRr...", "...r....", "........"]
    pal = {"r": "#8e1018", "R": "#e8303c", "h": "#ff9a9a"}
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != ".":
                img.set(ox + x, oy + y, hexc(pal[ch]))


def angry(img, ox, oy):
    puff(img, ox, oy, 3.2, "#6b6b74")
    for x, y in [(2, 3), (3, 4), (5, 3), (4, 4)]:
        img.set(ox + x, oy + y, hexc("#e0303a"))


def note(img, ox, oy):
    for y in range(1, 6):
        img.set(ox + 5, oy + y, hexc("#f0f0f0"))
    img.set(ox + 6, oy + 1, hexc("#f0f0f0"))
    img.set(ox + 7, oy + 2, hexc("#f0f0f0"))
    img.rect(ox + 2, oy + 5, 3, 2, hexc("#f0f0f0"))


def bubble_p(img, ox, oy):
    for y in range(8):
        for x in range(8):
            d = math.hypot(x - 3.5, y - 3.5)
            if 2.2 <= d < 3.4:
                img.set(ox + x, oy + y, hexc("#bfe9ff"))
    img.set(ox + 2, oy + 2, hexc("#ffffff"))


def star(img, ox, oy, size, col):
    c = 3
    for t in range(-size, size + 1):
        img.set(ox + c + t, oy + c, hexc(col))
        img.set(ox + c, oy + c + t, hexc(col))
    if size > 1:
        for t in (-1, 1):
            img.set(ox + c + t, oy + c + t, hexc(col, 160))
            img.set(ox + c + t, oy + c - t, hexc(col, 160))


def drop(img, ox, oy, stage):
    col = "#5aa0ff"
    if stage == 0:
        img.rect(ox + 3, oy + 0, 2, 2, hexc(col))
    elif stage == 1:
        img.rect(ox + 3, oy + 2, 2, 3, hexc(col))
        img.set(ox + 3, oy + 2, hexc("#cfe4ff"))
    else:
        img.rect(ox + 1, oy + 6, 6, 1, hexc(col))
        img.set(ox + 0, oy + 5, hexc(col))
        img.set(ox + 7, oy + 5, hexc(col))


def splash(img, ox, oy, i):
    for k in range(3 + i):
        x = int(hash01(k, i, 90) * 7)
        y = int(hash01(k, i, 91) * 7)
        img.set(ox + x, oy + y, hexc("#9fd0ff"))
        img.set(ox + x, oy + y + 1, hexc("#4f8fe0"))


def swirl(img, ox, oy, i, col):
    r = 1 + i * 0.35
    for a in range(0, 360, 30):
        x = 3.5 + math.cos(math.radians(a + i * 40)) * r * (a / 360)
        y = 3.5 + math.sin(math.radians(a + i * 40)) * r * (a / 360)
        img.set(ox + round(x), oy + round(y), hexc(col))


def glyph(img, ox, oy, k):
    for y in range(1, 7):
        for x in range(1, 4):
            if hash01(x, y, 200 + k) < 0.45:
                img.set(ox + x, oy + y, hexc("#f0f0f8"))
                img.set(ox + 7 - x - 1, oy + y, hexc("#f0f0f8"))


def explosion_frame(img, ox, oy, size, i):
    t = i / 15
    r = size * (0.15 + 0.35 * t)
    for y in range(size):
        for x in range(size):
            d = math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) + (hash01(x, y, 300 + i) - 0.5) * size * 0.12
            if d < r:
                v = d / r
                if t < 0.35:
                    col = "#fff7c2" if v < 0.5 else "#ffc94d" if v < 0.8 else "#ff7a2b"
                elif t < 0.7:
                    col = "#ffd36b" if v < 0.3 else "#c9c9cf" if v < 0.75 else "#8e8e96"
                else:
                    col = "#b4b4bb" if v < 0.6 else "#7e7e86"
                img.set(ox + x, oy + y, hexc(col, 255 if t < 0.8 else 200))


def particle_drawers():
    d = {}
    for i in range(8):
        d[f"generic_{i}"] = lambda img, x, y, i=i: puff(img, x, y, 3.7 - i * 0.45)
        d[f"effect_{i}"] = lambda img, x, y, i=i: swirl(img, x, y, 7 - i, "#e8e8ff")
        d[f"spell_{i}"] = lambda img, x, y, i=i: swirl(img, x, y, 7 - i, "#ffffff")
        d[f"spark_{i}"] = lambda img, x, y, i=i: star(img, x, y, max(0, 3 - i // 2), "#ffffff")
        d[f"glitter_{i}"] = lambda img, x, y, i=i: star(img, x, y, max(0, 2 - i // 3), "#fff2b0")
    for i in range(4):
        d[f"splash_{i}"] = lambda img, x, y, i=i: splash(img, x, y, i)
    for i in range(26):
        d[f"sga_{chr(97 + i)}"] = lambda img, x, y, i=i: glyph(img, x, y, i)
    d.update({
        "flame": flame,
        "soul_fire_flame": lambda img, x, y: flame(img, x, y, soul=True),
        "lava": lambda img, x, y: puff(img, x, y, 2.4, "#ff8a1f"),
        "bubble": bubble_p,
        "note": note,
        "critical_hit": lambda img, x, y: star(img, x, y, 3, "#f0f0f0"),
        "enchanted_hit": lambda img, x, y: star(img, x, y, 3, "#c9a7ff"),
        "damage": lambda img, x, y: star(img, x, y, 2, "#8e1820"),
        "heart": small_heart,
        "angry": angry,
        "glint": lambda img, x, y: star(img, x, y, 2, "#9ff0ff"),
        "drip_hang": lambda img, x, y: drop(img, x, y, 0),
        "drip_fall": lambda img, x, y: drop(img, x, y, 1),
        "drip_land": lambda img, x, y: drop(img, x, y, 2),
    })
    return d


MODERN_PARTICLES = {
    "smoke": [f"generic_{i}" for i in range(7, -1, -1)],
    "large_smoke": [f"generic_{i}" for i in range(7, -1, -1)],
    "poof": [f"generic_{i}" for i in range(7, -1, -1)],
    "cloud": [f"generic_{i}" for i in range(7, -1, -1)],
    "white_smoke": [f"generic_{i}" for i in range(7, -1, -1)],
    "flame": ["flame"],
    "soul_fire_flame": ["soul_fire_flame"],
    "lava": ["lava"],
    "heart": ["heart"],
    "angry_villager": ["angry"],
    "explosion": [f"explosion_{i}" for i in range(16)],
    "bubble": ["bubble"],
    "note": ["note"],
    "crit": ["critical_hit"],
    "enchanted_hit": ["enchanted_hit"],
    "damage_indicator": ["damage"],
    "effect": [f"effect_{i}" for i in range(7, -1, -1)],
    "witch": [f"spell_{i}" for i in range(7, -1, -1)],
    "firework": [f"spark_{i}" for i in range(7, -1, -1)],
    "glow": [f"glitter_{i}" for i in range(7, -1, -1)],
    "splash": [f"splash_{i}" for i in range(4)],
    "rain": [f"splash_{i}" for i in range(4)],
    "dripping_water": ["drip_hang"],
    "falling_water": ["drip_fall"],
    "enchant": [f"sga_{chr(97 + i)}" for i in range(26)],
}


# --------------------------------------------------------------------------
# Block models (written here; same JSON shapes as the game uses)


def faces(tex, sides=("down", "up", "north", "south", "west", "east"), tint=None, cull=True):
    out = {}
    for s in sides:
        f = {"texture": tex[s] if isinstance(tex, dict) else tex}
        if cull:
            f["cullface"] = s
        if tint is not None and (tint is True or s in tint):
            f["tintindex"] = 0
        out[s] = f
    return out


def cross_model(tinted):
    def face(s):
        f = {"uv": [0, 0, 16, 16], "texture": "#cross"}
        if tinted:
            f["tintindex"] = 0
        return f

    rot = {"origin": [8, 8, 8], "axis": "y", "angle": 45, "rescale": True}
    return {
        "ambientocclusion": False,
        "textures": {"particle": "#cross"},
        "elements": [
            {"from": [0.8, 0, 8], "to": [15.2, 16, 8], "rotation": rot, "shade": False, "faces": {"north": face("north"), "south": face("south")}},
            {"from": [8, 0, 0.8], "to": [8, 16, 15.2], "rotation": rot, "shade": False, "faces": {"west": face("west"), "east": face("east")}},
        ],
    }


def base_models():
    side = {s: "#" + s for s in ("down", "up", "north", "south", "west", "east")}
    return {
        "block": {"gui_light": "side", "display": {"gui": {"rotation": [30, 225, 0], "translation": [0, 0, 0], "scale": [0.625, 0.625, 0.625]}}},
        "cube": {"parent": "block/block", "elements": [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces(side)}]},
        "cube_all": {"parent": "block/cube", "textures": {"particle": "#all", **{s: "#all" for s in side}}},
        "cube_column": {"parent": "block/cube", "textures": {"particle": "#side", "down": "#end", "up": "#end", "north": "#side", "south": "#side", "west": "#side", "east": "#side"}},
        "leaves": {"parent": "block/block", "textures": {"particle": "#all"}, "elements": [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces("#all", tint=True)}]},
        "stairs": {
            "parent": "block/block",
            "textures": {"particle": "#side"},
            "elements": [
                {"from": [0, 0, 0], "to": [16, 8, 16], "faces": faces({"down": "#bottom", "up": "#top", "north": "#side", "south": "#side", "west": "#side", "east": "#side"})},
                {"from": [8, 8, 0], "to": [16, 16, 16], "faces": faces({"up": "#top", "north": "#side", "south": "#side", "west": "#side", "east": "#side"}, sides=("up", "north", "south", "west", "east"))},
            ],
        },
        "slab": {
            "parent": "block/block",
            "textures": {"particle": "#side"},
            "elements": [{"from": [0, 0, 0], "to": [16, 8, 16], "faces": faces({"down": "#bottom", "up": "#top", "north": "#side", "south": "#side", "west": "#side", "east": "#side"})}],
        },
        "cross": cross_model(False),
        "tinted_cross": cross_model(True),
    }


def grass_block_model(top, side, overlay, bottom):
    return {
        "parent": "block/block",
        "textures": {"particle": bottom, "bottom": bottom, "top": top, "side": side, "overlay": overlay},
        "elements": [
            {"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces({"down": "#bottom", "up": "#top", "north": "#side", "south": "#side", "west": "#side", "east": "#side"}, tint=("up",))},
            {"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces("#overlay", sides=("north", "south", "west", "east"), tint=True)},
        ],
    }


# --------------------------------------------------------------------------
# The two versions


def blocks(new):
    """name in this version -> image (or list of frames, with an .mcmeta)."""
    n = (lambda modern, old: modern) if new else (lambda modern, old: old)
    out = {
        n("stone", "stone"): stone(STONE, 1),
        n("andesite", "stone_andesite"): stone(ANDESITE, 2),
        n("granite", "stone_granite"): stone(GRANITE, 3),
        n("diorite", "stone_diorite"): stone(DIORITE, 4),
        n("cobblestone", "cobblestone"): cobblestone(),
        n("dirt", "dirt"): noisy(DIRT, 12, grain=0.2),
        n("sand", "sand"): noisy(SAND, 14, grain=0.25),
        n("oak_planks", "planks_oak"): planks(),
        n("oak_log", "log_oak"): log_side(),
        n("oak_log_top", "log_oak_top"): log_top(),
        n("glass", "glass"): glass(),
        n("bricks", "brick"): bricks(),
        n("grass_block_top", "grass_top"): grass_top(),
        n("grass_block_side", "grass_side"): grass_side(),
        n("grass_block_side_overlay", "grass_side_overlay"): grass_overlay(),
        n("short_grass", "tallgrass"): short_grass(),
        n("poppy", "flower_rose"): poppy(),
        n("oak_leaves", "leaves_oak"): leaves(),
        n("prismarine", "prismarine_rough"): (prismarine_frames(), {"animation": {"frametime": 20, "interpolate": True}}),
        n("sea_lantern", "sea_lantern"): (sea_lantern_frames(), {"animation": {"frametime": 5}}),
    }
    if new:
        out["deepslate"] = stone(DEEPSLATE, 5)
    return out


def items(new):
    n = (lambda modern, old: modern) if new else (lambda modern, old: old)
    gold_apple = dict(APPLE_PAL, R="#f2c94c", h="#fff6b0", r="#c08a1e", d="#8a6212", o="#4a3208")
    return {
        "diamond": gem({"o": "#0f3d3e", "W": "#e8fffb", "C": "#4fe0d0", "c": "#2bb3a8", "d": "#16807a"}),
        "emerald": emerald(),
        n("prismarine_shard", "prismarine_shard"): gem({"o": "#173a35", "W": "#d9fff6", "C": "#7fc3b4", "c": "#4f8f82", "d": "#2e5e55"}),
        "apple": apple(),
        n("golden_apple", "apple_golden"): apple(gold_apple),
        "iron_sword": sword(),
        n("golden_sword", "gold_sword"): sword(("#fff6b0", "#f2c94c", "#c08a1e"), ("#8b8f99", "#5d616b")),
        "diamond_sword": sword(("#e8fffb", "#4fe0d0", "#16807a")),
        "stick": stick(),
        "iron_ingot": ingot(IRON),
        "gold_ingot": ingot(GOLD),
    }


def block_models(new):
    p = "minecraft:block/" if new else "blocks/"
    t = (lambda modern, old: p + modern) if new else (lambda modern, old: p + old)
    models = {k: v for k, v in base_models().items()}
    if not new:
        # 1.8.9 model files name their parents without "minecraft:"
        models["cube"]["parent"] = "block/block"
    planks_tex = t("oak_planks", "planks_oak")
    all_tex = {
        "stone": t("stone", "stone"),
        "cobblestone": t("cobblestone", "cobblestone"),
        "dirt": t("dirt", "dirt"),
        "sand": t("sand", "sand"),
        "glass": t("glass", "glass"),
        "oak_planks": planks_tex,
        "prismarine": t("prismarine", "prismarine_rough"),
        "sea_lantern": t("sea_lantern", "sea_lantern"),
        "andesite": t("andesite", "stone_andesite"),
        "granite": t("granite", "stone_granite"),
        "diorite": t("diorite", "stone_diorite"),
        "bricks" if new else "brick": t("bricks", "brick"),
    }
    for name, tex in all_tex.items():
        models[name] = {"parent": "block/cube_all", "textures": {"all": tex}}
    models["oak_log"] = {"parent": "block/cube_column", "textures": {"end": t("oak_log_top", "log_oak_top"), "side": t("oak_log", "log_oak")}}
    models["oak_leaves" if new else "leaves_oak"] = {"parent": "block/leaves", "textures": {"all": t("oak_leaves", "leaves_oak")}}
    models["oak_stairs"] = {"parent": "block/stairs", "textures": {"bottom": planks_tex, "top": planks_tex, "side": planks_tex}}
    models["oak_slab" if new else "half_slab_oak"] = {"parent": "block/slab", "textures": {"bottom": planks_tex, "top": planks_tex, "side": planks_tex}}
    models["grass_block" if new else "grass_normal"] = grass_block_model(
        t("grass_block_top", "grass_top"), t("grass_block_side", "grass_side"), t("grass_block_side_overlay", "grass_side_overlay"), t("dirt", "dirt")
    )
    models["short_grass" if new else "tall_grass"] = {"parent": "block/tinted_cross", "textures": {"cross": t("short_grass", "tallgrass")}}
    models["poppy" if new else "rose"] = {"parent": "block/cross", "textures": {"cross": t("poppy", "flower_rose")}}
    if new:
        models["deepslate"] = {"parent": "block/cube_all", "textures": {"all": p + "deepslate"}}
        for m in models.values():
            if isinstance(m.get("parent"), str) and not m["parent"].startswith("minecraft:"):
                m["parent"] = "minecraft:" + m["parent"]
    return models


def jar_files(new):
    """All files of one fake jar: path inside the jar -> bytes."""
    files = {}
    tex = "assets/minecraft/textures/"
    bdir, idir = ("block", "item") if new else ("blocks", "items")

    def put_png(path, img):
        files[tex + path + ".png"] = img.png()

    def put_json(path, obj):
        files[path] = (json.dumps(obj, indent=2) + "\n").encode()

    for name, img in blocks(new).items():
        if isinstance(img, tuple):
            frames, meta = img
            put_png(f"{bdir}/{name}", stack(frames))
            put_json(f"{tex}{bdir}/{name}.png.mcmeta", meta)
        else:
            put_png(f"{bdir}/{name}", img)
    for name, img in items(new).items():
        put_png(f"{idir}/{name}", img)

    put_png("entity/chest/normal", chest_entity())
    put_png("entity/sheep/sheep", sheep_entity())
    put_png("environment/sun", sun())
    put_png("painting/wanderer" if new else "painting/paintings_kristoffer_zetterstrand", painting_sea())
    if new:
        put_png("mob_effect/water_breathing", effect_icon())
    put_png("gui/container/inventory", inventory_container())
    put_png("gui/container/generic_54", chest_container())

    regions = json.loads((DATA / "gui_regions.json").read_text(encoding="utf-8"))
    draw_p = particle_drawers()
    if new:
        for image in regions["images"]:
            for piece in image["pieces"]:
                modern, drawer = piece.get("modern"), GUI_PIECES.get(piece["id"])
                if not modern or not drawer:
                    continue
                w, h = piece["rect"][2], piece["rect"][3]
                img = Img(w, h)
                drawer(img, 0, 0, w, h)
                files[tex + modern + ".png"] = img.png()
        for name, (w, h, drawer) in EXTRA_SPRITES.items():
            img = Img(w, h)
            drawer(img, 0, 0, w, h)
            put_png("gui/sprites/" + name, img)
        for name, (w, h, border) in NINE_SLICE.items():
            put_json(f"{tex}gui/sprites/{name}.png.mcmeta", {"gui": {"scaling": {"type": "nine_slice", "width": w, "height": h, "border": border}}})

        used = sorted({s for frames in MODERN_PARTICLES.values() for s in frames})
        for s in used:
            if s.startswith("explosion_"):
                img = Img(16, 16)
                explosion_frame(img, 0, 0, 16, int(s.split("_")[1]))
            else:
                img = Img(8, 8)
                draw_p[s](img, 0, 0)
            put_png("particle/" + s, img)
        for pid, frames in MODERN_PARTICLES.items():
            put_json(f"assets/minecraft/particles/{pid}.json", {"textures": ["minecraft:" + f for f in frames]})
    else:
        for image in regions["images"]:
            if image.get("since"):  # bars.png is 1.9+
                continue
            sheet = Img(*image["size"])
            for piece in image["pieces"]:
                if piece.get("since"):
                    continue
                drawer = GUI_PIECES.get(piece["id"])
                if drawer:
                    x, y, w, h = piece["rect"]
                    drawer(sheet, x, y, w, h)
            put_png(image["file"], sheet)

        sheet_map = json.loads((DATA / "particle_sheet.json").read_text(encoding="utf-8"))
        grid, size = sheet_map["grid"], sheet_map["vanilla_size"]
        cell = size // grid
        sheet = Img(size, size)
        for sprite, idx in sheet_map["sprites"].items():
            if sprite in sheet_map.get("sprites_since", {}):
                continue
            if sprite in draw_p:
                draw_p[sprite](sheet, (idx % grid) * cell, (idx // grid) * cell)
        hook = sheet_map["not_particles"][0]["cells"][0]
        hx, hy = (hook % grid) * cell, (hook // grid) * cell
        sheet.rect(hx + 3, hy + 1, 2, 5, hexc("#d8d8d8"))
        sheet.rect(hx + 2, hy + 2, 4, 2, hexc("#c8303a"))
        put_png("particle/particles", sheet)
        foot = Img(8, 8)
        for x, y in [(2, 1), (3, 1), (2, 2), (3, 2), (4, 4), (5, 4), (4, 5), (5, 5)]:
            foot.set(x, y, hexc("#3a3a40", 180))
        put_png("particle/footprint", foot)
        explosion = Img(128, 128)
        for i in range(16):
            explosion_frame(explosion, (i % 4) * 32, (i // 4) * 32, 32, i)
        put_png("entity/explosion", explosion)

    for name, model in block_models(new).items():
        put_json(f"assets/minecraft/models/block/{name}.json", model)

    if new:
        put_json(
            "version.json",
            {
                "id": "1.21.11",
                "name": "1.21.11",
                "world_version": 4671,
                "series_id": "main",
                "protocol_version": 774,
                "pack_version": {"resource_major": 75, "resource_minor": 0, "data_major": 94, "data_minor": 1},
                "build_time": "2026-01-01T12:00:00+00:00",
                "java_component": "java-runtime-delta",
                "java_version": 21,
                "stable": True,
                "use_editor": False,
                "_demo": "Fake game made by tools/demo/make_demo_minecraft.py for screenshots. Not Minecraft.",
            },
        )
    files["README_DEMO.txt"] = b"Demo data drawn by tools/demo/make_demo_minecraft.py. Not Minecraft. No game file was used.\n"
    return files


def write_jar(path, files):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    root = Path(sys.argv[1]).resolve()
    if root.name != ".minecraft":
        print("The target folder must be named .minecraft (for example app/target/devdata/demo/.minecraft).")
        sys.exit(2)
    if (root / "versions").exists():
        shutil.rmtree(root / "versions")
    for version, new in (("1.21.11", True), ("1.8.9", False)):
        jar = root / "versions" / version / f"{version}.jar"
        files = jar_files(new)
        write_jar(jar, files)
        print(f"{jar}  ({len(files)} files)")
    (root / "resourcepacks").mkdir(parents=True, exist_ok=True)
    (root / "assets" / "indexes").mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    main()

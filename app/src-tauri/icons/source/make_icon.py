"""Draws Blockwright's pixel-art icon (32x32 grid) and writes it as a PNG.

Usage: python make_icon.py out.png [scale]
Pure Python (zlib + struct), no image library needed.
The icon is an original design: an isometric block whose faces are a pixel
grid, with a pencil drawing on it.
"""
import struct, sys, zlib

N = 32
img = [[(0, 0, 0, 0)] * N for _ in range(N)]

def inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c

def hexrgb(h, a=255):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), a)

TOP = [(16, 3), (28.5, 9.5), (16, 16), (3.5, 9.5)]
LEFT = [(3.5, 9.5), (16, 16), (16, 29), (3.5, 22.5)]
RIGHT = [(16, 16), (28.5, 9.5), (28.5, 22.5), (16, 29)]
shades = {
    "top": ("#7fb4ff", "#6aa3f5"),
    "left": ("#3f78e0", "#346bd0"),
    "right": ("#24489a", "#1e3f8a"),
}
for y in range(N):
    for x in range(N):
        px, py = x + 0.5, y + 0.5
        # isometric cell coordinates: 4x4 texture cells on every face
        if inside(TOP, px, py):
            u = (px - 16) / 12.5 + (py - 3) / 6.5
            v = -(px - 16) / 12.5 + (py - 3) / 6.5
            a, b = shades["top"]
            img[y][x] = hexrgb(a if (int(u * 2) + int(v * 2)) % 2 == 0 else b)
        elif inside(LEFT, px, py):
            u = (px - 3.5) / 12.5
            v = (py - 9.5 - (px - 3.5) * 6.5 / 12.5) / 13
            a, b = shades["left"]
            img[y][x] = hexrgb(a if (int(u * 4) + int(v * 4)) % 2 == 0 else b)
        elif inside(RIGHT, px, py):
            u = (px - 16) / 12.5
            v = (py - 16 + (px - 16) * 6.5 / 12.5) / 13
            a, b = shades["right"]
            img[y][x] = hexrgb(a if (int(u * 4) + int(v * 4)) % 2 == 0 else b)

# outline: any transparent pixel next to the block becomes dark
dark = hexrgb("#0f1626")
solid = [[img[y][x][3] > 0 for x in range(N)] for y in range(N)]
for y in range(N):
    for x in range(N):
        if not solid[y][x] and any(
            0 <= x + dx < N and 0 <= y + dy < N and solid[y + dy][x + dx]
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        ):
            img[y][x] = dark
# light front edge
for y in range(17, 29):
    img[y][16] = hexrgb("#9cc6ff") if y < 18 else hexrgb("#2a56b0")

# pencil going down-right to its tip on the top face
pencil = [
    ((27, 2), "#0f1626"), ((28, 3), "#0f1626"),
    ((26, 3), "#ff8fa3"), ((27, 4), "#ff8fa3"), ((26, 2), "#0f1626"), ((28, 4), "#0f1626"),
    ((25, 4), "#c9ccd6"), ((26, 5), "#c9ccd6"), ((25, 3), "#0f1626"), ((27, 5), "#0f1626"),
]
for i, (x0, y0) in enumerate([(24, 5), (23, 6), (22, 7), (21, 8)]):
    pencil += [((x0, y0), "#ffc23d"), ((x0 + 1, y0 + 1), "#e89a12"),
               ((x0 - 1, y0), "#0f1626"), ((x0 + 2, y0 + 1), "#0f1626")]
pencil += [((20, 9), "#f2d7b0"), ((21, 10), "#f2d7b0"), ((19, 9), "#0f1626"), ((22, 10), "#0f1626"),
           ((19, 10), "#f2d7b0"), ((20, 10), "#f2d7b0"), ((19, 11), "#0f1626"), ((18, 11), "#0f1626"),
           ((20, 11), "#0f1626"), ((18, 12), "#ffffff")]
for (x, y), c in pencil:
    img[y][x] = hexrgb(c)

scale = int(sys.argv[2]) if len(sys.argv) > 2 else 32
W = N * scale
raw = bytearray()
for y in range(W):
    raw.append(0)
    row = img[y // scale]
    for x in range(W):
        raw += bytes(row[x // scale])
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, W, 8, 6, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)

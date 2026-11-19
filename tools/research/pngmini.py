"""Tiny pure-Python PNG reader (no dependencies) used by the research scripts.

Decodes non-interlaced PNGs of any colour type / bit depth to 8-bit RGBA so
that two textures can be compared by their pixels instead of their file bytes
(the same image is often re-compressed between game versions).
"""

import hashlib
import struct
import zlib


def decode(data):
    """Return (width, height, rgba_bytes) or None if unsupported."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos = 8
    idat = []
    plte = None
    trns = None
    w = h = depth = ctype = interlace = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            w, h, depth, ctype, _c, _f, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            plte = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if interlace or w is None:
        return None
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    bpp_bits = channels * depth
    bpp = max(1, bpp_bits // 8)
    stride = (w * bpp_bits + 7) // 8
    raw = zlib.decompress(b"".join(idat))
    out = bytearray()
    prev = bytearray(stride)
    p = 0
    rows = []
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(line)
        prev = line

    def samples(line):
        if depth == 8:
            return list(line)
        if depth == 16:
            return [line[i] for i in range(0, len(line), 2)]  # high byte only
        vals = []
        mask = (1 << depth) - 1
        need = w * channels
        for byte in line:
            for shift in range(8 - depth, -1, -depth):
                vals.append((byte >> shift) & mask)
                if len(vals) == need:
                    return vals
        return vals

    scale = {1: 255, 2: 85, 4: 17, 8: 1, 16: 1}[depth]
    for line in rows:
        s = samples(line)
        if ctype == 6:
            out += bytes(s)
        elif ctype == 2:
            key = None
            if trns and len(trns) >= 6:
                key = (trns[1], trns[3], trns[5]) if depth == 8 else None
            for i in range(0, len(s), 3):
                r, g, b = s[i], s[i + 1], s[i + 2]
                out += bytes((r, g, b, 0 if key == (r, g, b) else 255))
        elif ctype == 0:
            key = None
            if trns and len(trns) >= 2:
                key = struct.unpack(">H", trns[:2])[0]
            for v in s:
                g = v * scale if depth < 8 else v
                out += bytes((g, g, g, 0 if (key is not None and v == key) else 255))
        elif ctype == 4:
            for i in range(0, len(s), 2):
                out += bytes((s[i], s[i], s[i], s[i + 1]))
        elif ctype == 3:
            for v in s:
                r, g, b = plte[v * 3:v * 3 + 3]
                a = trns[v] if (trns and v < len(trns)) else 255
                out += bytes((r, g, b, a))
    return w, h, bytes(out)


def pixel_hash(data):
    """Hash of the decoded pixels; fully transparent pixels are normalised."""
    d = decode(data)
    if d is None:
        return None
    w, h, px = d
    norm = bytearray(px)
    for i in range(3, len(norm), 4):
        if norm[i] == 0:
            norm[i - 3] = norm[i - 2] = norm[i - 1] = 0
    return hashlib.sha1(struct.pack(">II", w, h) + bytes(norm)).hexdigest()

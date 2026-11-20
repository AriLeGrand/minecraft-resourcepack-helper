import { describe, expect, it } from "vitest";
import {
  applyInk, base64ToBytes, blurPoints, brushOffsets, bytesToBase64, clearArea, cloneBuf, combineMasks, composite,
  copyClip, cropFrame, curvePoints, ellipsePoints, extractPalette, fit, floodMask, getPx, gradient, hexToRgba, hsvToRgb,
  jumblePoints, linePoints, maskBounds, maskPoints, mirror, newBuf, over, paint, pasteClip, pathPoints, pixelPerfect,
  pointsMask, polygonPoints, rectPoints, rgbaToHex, rgbToHsv, rng, scaleNearest, setPx, shiftMask, sprayPoints,
  stackFrames, stamp, type Buf, type Pt, type Rgba,
} from "./pixels";

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** Draws a buffer as text: '#' = opaque, '+' = partly transparent, '.' = empty. */
function art(b: Buf): string[] {
  const rows: string[] = [];
  for (let y = 0; y < b.h; y++) {
    let s = "";
    for (let x = 0; x < b.w; x++) {
      const a = getPx(b, x, y)[3];
      s += a === 0 ? "." : a === 255 ? "#" : "+";
    }
    rows.push(s);
  }
  return rows;
}

function plot(w: number, h: number, pts: Pt[]): string[] {
  const b = newBuf(w, h);
  paint(b, fit(pts, w, h, false), { color: RED, ink: "simple", opacity: 100 });
  return art(b);
}

const sortPts = (p: Pt[]) => [...p].sort((a, b) => a[1] - b[1] || a[0] - b[0]);

describe("colours", () => {
  it("converts hex both ways", () => {
    expect(rgbaToHex([127, 195, 180, 255])).toBe("#7fc3b4");
    expect(rgbaToHex([255, 0, 0, 128])).toBe("#ff000080");
    expect(hexToRgba("#7FC3B4")).toEqual([127, 195, 180, 255]);
    expect(hexToRgba("f00")).toEqual([255, 0, 0, 255]);
    expect(hexToRgba("#ff000080")).toEqual([255, 0, 0, 128]);
    expect(hexToRgba("nope")).toBeNull();
    expect(hexToRgba("#12345")).toBeNull();
  });
  it("converts HSV both ways (mockup colour: #7FC3B4 = H168 S35 V76)", () => {
    expect(rgbToHsv(127, 195, 180)).toEqual([167, 35, 76]);
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 100, 100]);
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hsvToRgb(0, 100, 100)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 100, 50)).toEqual([0, 128, 0]);
    expect(hsvToRgb(240, 50, 100)).toEqual([128, 128, 255]);
    for (const c of [[12, 200, 99], [255, 255, 255], [90, 90, 90], [1, 2, 3]]) {
      const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
      const back = hsvToRgb(h, s, v);
      back.forEach((n, i) => expect(Math.abs(n - c[i])).toBeLessThanOrEqual(3));
    }
  });
  it("blends with straight alpha", () => {
    expect(over(BLUE, RED)).toEqual(RED);
    expect(over(BLUE, CLEAR)).toEqual(BLUE);
    expect(over(CLEAR, [255, 0, 0, 128])).toEqual([255, 0, 0, 128]);
    expect(over([0, 0, 255, 255], [255, 0, 0, 128])).toEqual([128, 0, 127, 255]);
  });
});

describe("inks", () => {
  it("simple replaces, also with a transparent colour", () => {
    expect(applyInk(BLUE, RED, "simple", 100)).toEqual(RED);
    expect(applyInk(BLUE, CLEAR, "simple", 100)).toEqual(CLEAR);
    expect(applyInk(BLUE, RED, "simple", 50)).toEqual([128, 0, 128, 255]);
    expect(applyInk(CLEAR, RED, "simple", 50)).toEqual([255, 0, 0, 128]);
  });
  it("alpha paints over", () => {
    expect(applyInk(BLUE, [255, 0, 0, 128], "alpha", 100)).toEqual([128, 0, 127, 255]);
    expect(applyInk(CLEAR, RED, "alpha", 100)).toEqual(RED);
  });
  it("lock alpha only touches existing pixels and keeps their transparency", () => {
    expect(applyInk(CLEAR, RED, "lock", 100)).toEqual(CLEAR);
    expect(applyInk([0, 0, 255, 100], RED, "lock", 100)).toEqual([255, 0, 0, 100]);
  });
  it("erase removes", () => {
    expect(applyInk(RED, RED, "erase", 100)).toEqual(CLEAR);
    expect(applyInk(RED, RED, "erase", 50)).toEqual([255, 0, 0, 128]);
  });
  it("shading changes brightness only on existing pixels", () => {
    const mid: Rgba = [100, 150, 140, 255];
    const lighter = applyInk(mid, RED, "lighten", 100);
    const darker = applyInk(mid, RED, "darken", 100);
    expect(rgbToHsv(lighter[0], lighter[1], lighter[2])[2]).toBeGreaterThan(rgbToHsv(mid[0], mid[1], mid[2])[2]);
    expect(rgbToHsv(darker[0], darker[1], darker[2])[2]).toBeLessThan(rgbToHsv(mid[0], mid[1], mid[2])[2]);
    expect(lighter[3]).toBe(255);
    expect(applyInk(CLEAR, RED, "lighten", 100)).toEqual(CLEAR);
  });
});

describe("lines and paths", () => {
  it("draws straight and diagonal lines with both ends", () => {
    expect(linePoints(0, 0, 3, 0)).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(linePoints(2, 2, 0, 0)).toEqual([[2, 2], [1, 1], [0, 0]]);
    expect(linePoints(1, 1, 1, 1)).toEqual([[1, 1]]);
    expect(plot(6, 3, linePoints(0, 0, 5, 2))).toEqual(["##....", "..##..", "....##"]);
  });
  it("joins mouse stops without gaps or doubles", () => {
    expect(pathPoints([[0, 0], [2, 0], [2, 2]])).toEqual([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]);
    expect(pathPoints([])).toEqual([]);
  });
  it("pixel-perfect removes L corners", () => {
    const corner: Pt[] = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]];
    expect(pixelPerfect(corner)).toEqual([[0, 0], [1, 1], [2, 2]]);
    // straight lines and real turns of more than one pixel are kept
    const straight: Pt[] = [[0, 0], [1, 0], [2, 0]];
    expect(pixelPerfect(straight)).toEqual(straight);
    const long: Pt[] = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]];
    expect(pixelPerfect(long)).toEqual([[0, 0], [1, 0], [2, 1], [2, 2]]);
  });
});

describe("brush", () => {
  it("has the right footprint", () => {
    expect(brushOffsets(1)).toEqual([[0, 0]]);
    expect(sortPts(brushOffsets(2))).toEqual([[-1, -1], [0, -1], [-1, 0], [0, 0]]);
    expect(plot(5, 5, stamp([[2, 2]], 3))).toEqual([".....", ".###.", ".###.", ".###.", "....."]);
    expect(plot(7, 7, stamp([[3, 3]], 5))).toEqual([".......", "..###..", ".#####.", ".#####.", ".#####.", "..###..", "......."]);
  });
  it("stamps along a path without duplicates", () => {
    const pts = stamp([[1, 1], [2, 1]], 2);
    expect(pts.length).toBe(6);
  });
});

describe("shapes", () => {
  it("rectangle outline and filled, any corner order", () => {
    expect(plot(5, 4, rectPoints(3, 2, 0, 0, false))).toEqual(["####.", "#..#.", "####.", "....."]);
    expect(plot(3, 3, rectPoints(0, 0, 2, 2, true))).toEqual(["###", "###", "###"]);
    expect(rectPoints(1, 1, 1, 1, false)).toEqual([[1, 1]]);
  });
  it("ellipse outline and filled", () => {
    expect(plot(7, 7, ellipsePoints(0, 0, 6, 6, false))).toEqual([
      "..###..",
      ".#...#.",
      "#.....#",
      "#.....#",
      "#.....#",
      ".#...#.",
      "..###..",
    ]);
    expect(plot(6, 4, ellipsePoints(0, 0, 5, 3, true))).toEqual([".####.", "######", "######", ".####."]);
    expect(ellipsePoints(2, 2, 2, 2, true)).toEqual([[2, 2]]);
  });
  it("polygon outline and filled", () => {
    const tri: Pt[] = [[0, 0], [4, 0], [0, 4]];
    expect(plot(5, 5, polygonPoints(tri, true))).toEqual(["#####", "####.", "###..", "##...", "#...."]);
    expect(plot(5, 5, polygonPoints(tri, false))).toEqual(["#####", "#..#.", "#.#..", "##...", "#...."]);
    expect(polygonPoints([], true)).toEqual([]);
  });
  it("curve starts and ends on the given points and stays connected", () => {
    const pts = curvePoints([0, 6], [3, -4], [6, 6]);
    expect(pts[0]).toEqual([0, 6]);
    expect(pts[pts.length - 1]).toEqual([6, 6]);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1);
    }
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThan(3);
  });
  it("spray stays inside its radius and is repeatable", () => {
    const a = sprayPoints(10, 10, 4, 50, rng(7));
    const b = sprayPoints(10, 10, 4, 50, rng(7));
    expect(a).toEqual(b);
    for (const [x, y] of a) expect(Math.hypot(x - 10, y - 10)).toBeLessThanOrEqual(4.8);
  });
});

describe("symmetry and tiled mode", () => {
  it("mirrors across the middle", () => {
    expect(sortPts(mirror([[0, 0]], 4, 4, "x"))).toEqual([[0, 0], [3, 0]]);
    expect(sortPts(mirror([[0, 0]], 4, 4, "y"))).toEqual([[0, 0], [0, 3]]);
    expect(sortPts(mirror([[0, 1]], 4, 4, "both"))).toEqual([[0, 1], [3, 1], [0, 2], [3, 2]]);
    expect(mirror([[1, 1]], 4, 4, "none")).toEqual([[1, 1]]);
    // a point on the axis of an odd image is not doubled
    expect(mirror([[1, 0]], 3, 3, "x")).toEqual([[1, 0]]);
  });
  it("clips outside points, or wraps them in tiled mode", () => {
    const pts: Pt[] = [[-1, 0], [0, 0], [4, 3], [2, -1]];
    expect(fit(pts, 4, 4, false)).toEqual([[0, 0]]);
    expect(sortPts(fit(pts, 4, 4, true))).toEqual([[0, 0], [3, 0], [0, 3], [2, 3]]);
  });
});

describe("paint and selection", () => {
  it("only paints inside the selection", () => {
    const b = newBuf(3, 1);
    const mask = pointsMask([[1, 0]], 3, 1);
    paint(b, [[0, 0], [1, 0], [2, 0]], { color: RED, ink: "simple", opacity: 100, mask });
    expect(art(b)).toEqual([".#."]);
  });
  it("combines selections", () => {
    const a = pointsMask([[0, 0], [1, 0]], 3, 1);
    const b = pointsMask([[1, 0], [2, 0]], 3, 1);
    expect(Array.from(combineMasks(a, b, "replace")!)).toEqual([0, 1, 1]);
    expect(Array.from(combineMasks(a, b, "add")!)).toEqual([1, 1, 1]);
    expect(Array.from(combineMasks(a, b, "subtract")!)).toEqual([1, 0, 0]);
    expect(combineMasks(a, a, "subtract")).toBeNull();
    expect(combineMasks(null, b, "add")).toEqual(b);
    expect(combineMasks(null, b, "subtract")).toBeNull();
  });
  it("finds bounds and shifts", () => {
    const m = pointsMask([[1, 1], [2, 3]], 4, 4);
    expect(maskBounds(m, 4)).toEqual({ x: 1, y: 1, w: 2, h: 3 });
    expect(maskBounds(new Uint8Array(16), 4)).toBeNull();
    expect(maskPoints(shiftMask(m, 4, 4, 1, 0)!, 4)).toEqual([[2, 1], [3, 3]]);
    expect(maskPoints(shiftMask(m, 4, 4, 2, 0)!, 4)).toEqual([[3, 1]]);
    expect(shiftMask(m, 4, 4, 9, 9)).toBeNull();
  });
});

describe("bucket and magic wand", () => {
  const img = () => {
    const b = newBuf(5, 3);
    // a red wall at x = 2 splits the image
    for (let y = 0; y < 3; y++) setPx(b, 2, y, RED);
    setPx(b, 4, 1, BLUE);
    return b;
  };
  it("fills only the connected area", () => {
    const b = img();
    const m = floodMask(b, 0, 0, 0, true);
    expect(maskPoints(m, 5).length).toBe(6);
    paint(b, maskPoints(m, 5), { color: BLUE, ink: "simple", opacity: 100 });
    expect(getPx(b, 1, 2)).toEqual(BLUE);
    expect(getPx(b, 3, 0)).toEqual(CLEAR);
    expect(getPx(b, 2, 0)).toEqual(RED);
  });
  it("non-contiguous takes every matching pixel", () => {
    const m = floodMask(img(), 0, 0, 0, false);
    expect(maskPoints(m, 5).length).toBe(11);
  });
  it("tolerance widens the match and outside clicks select nothing", () => {
    const b = newBuf(3, 1);
    setPx(b, 0, 0, [100, 100, 100, 255]);
    setPx(b, 1, 0, [110, 100, 100, 255]);
    setPx(b, 2, 0, [200, 100, 100, 255]);
    expect(Array.from(floodMask(b, 0, 0, 0, true))).toEqual([1, 0, 0]);
    expect(Array.from(floodMask(b, 0, 0, 16, true))).toEqual([1, 1, 0]);
    expect(Array.from(floodMask(b, 9, 9, 0, true))).toEqual([0, 0, 0]);
  });
});

describe("gradient, blur, jumble", () => {
  it("gradient goes from one colour to the other", () => {
    const b = newBuf(5, 1);
    gradient(b, [0, 0], [4, 0], RED, BLUE, null);
    expect(getPx(b, 0, 0)).toEqual(RED);
    expect(getPx(b, 4, 0)).toEqual(BLUE);
    expect(getPx(b, 2, 0)).toEqual([128, 0, 128, 255]);
    const masked = newBuf(5, 1);
    gradient(masked, [0, 0], [4, 0], RED, BLUE, pointsMask([[0, 0]], 5, 1));
    expect(art(masked)).toEqual(["#...."]);
  });
  it("blur softens an edge without inventing colour in empty areas", () => {
    const src = newBuf(3, 3);
    setPx(src, 1, 1, [200, 0, 0, 255]);
    const b = cloneBuf(src);
    blurPoints(b, src, [[1, 1], [0, 0]], null);
    expect(getPx(b, 1, 1)[3]).toBeLessThan(255);
    expect(getPx(b, 1, 1)[0]).toBe(200);
    expect(getPx(b, 0, 0)[3]).toBeGreaterThan(0);
    expect(getPx(b, 0, 0)[0]).toBe(200);
  });
  it("jumble only moves pixels around", () => {
    const b = newBuf(4, 4);
    for (let i = 0; i < 16; i++) setPx(b, i % 4, Math.floor(i / 4), [i * 10, 0, 0, 255]);
    const before = Array.from(b.data.filter((_, i) => i % 4 === 0)).sort((x, y) => x - y);
    jumblePoints(b, maskPoints(new Uint8Array(16).fill(1), 4), null, rng(3));
    const after = Array.from(b.data.filter((_, i) => i % 4 === 0)).sort((x, y) => x - y);
    expect(after).toEqual(before);
  });
});

describe("copy, paste, move", () => {
  it("copies the selection and pastes it elsewhere", () => {
    const b = newBuf(4, 2);
    setPx(b, 0, 0, RED);
    setPx(b, 1, 0, BLUE);
    const clip = copyClip(b, pointsMask([[0, 0], [1, 0]], 4, 2))!;
    expect([clip.x, clip.y, clip.buf.w, clip.buf.h]).toEqual([0, 0, 2, 1]);
    clearArea(b, pointsMask([[0, 0], [1, 0]], 4, 2));
    expect(art(b)).toEqual(["....", "...."]);
    pasteClip(b, clip.buf, 2, 1);
    expect(getPx(b, 2, 1)).toEqual(RED);
    expect(getPx(b, 3, 1)).toEqual(BLUE);
  });
  it("paste clips at the edge, or wraps in tiled mode", () => {
    const clip = newBuf(2, 1);
    setPx(clip, 0, 0, RED);
    setPx(clip, 1, 0, BLUE);
    const a = newBuf(3, 1);
    pasteClip(a, clip, 2, 0);
    expect(art(a)).toEqual(["..#"]);
    const t = newBuf(3, 1);
    pasteClip(t, clip, 2, 0, true);
    expect(getPx(t, 0, 0)).toEqual(BLUE);
    expect(getPx(t, 2, 0)).toEqual(RED);
  });
  it("copy with nothing selected takes the whole image; empty selection gives nothing", () => {
    const b = newBuf(2, 2);
    expect(copyClip(b, null)!.buf.w).toBe(2);
    expect(copyClip(b, new Uint8Array(4))).toBeNull();
  });
});

describe("layers", () => {
  const layer = (c: Rgba, visible = true, opacity = 100) => {
    const b = newBuf(1, 1);
    setPx(b, 0, 0, c);
    return { buf: b, visible, opacity };
  };
  it("flattens bottom to top with visibility and opacity", () => {
    expect(getPx(composite(1, 1, [layer(BLUE), layer(RED)]), 0, 0)).toEqual(RED);
    expect(getPx(composite(1, 1, [layer(BLUE), layer(RED, false)]), 0, 0)).toEqual(BLUE);
    expect(getPx(composite(1, 1, [layer(BLUE), layer(RED, true, 50)]), 0, 0)).toEqual([128, 0, 128, 255]);
    expect(getPx(composite(1, 1, [layer(RED, true, 50)]), 0, 0)).toEqual([255, 0, 0, 128]);
    expect(getPx(composite(1, 1, []), 0, 0)).toEqual(CLEAR);
  });
  it("a single full layer is returned unchanged (what gets saved is what was drawn)", () => {
    const b = newBuf(2, 2);
    setPx(b, 0, 0, [13, 77, 255, 128]);
    setPx(b, 1, 1, [1, 2, 3, 1]);
    expect(composite(2, 2, [{ buf: b, visible: true, opacity: 100 }]).data).toEqual(b.data);
  });
});

describe("palette, scaling, frames, base64", () => {
  it("extracts distinct colours, dark to light", () => {
    const b = newBuf(4, 1);
    setPx(b, 0, 0, [200, 200, 200, 255]);
    setPx(b, 1, 0, [10, 10, 10, 255]);
    setPx(b, 2, 0, [10, 10, 10, 255]);
    expect(extractPalette(b)).toEqual([[10, 10, 10, 255], [200, 200, 200, 255]]);
    expect(extractPalette(newBuf(2, 2))).toEqual([]);
  });
  it("scales with hard pixels", () => {
    const b = newBuf(2, 1);
    setPx(b, 0, 0, RED);
    setPx(b, 1, 0, BLUE);
    const big = scaleNearest(b, 4, 2);
    expect([getPx(big, 0, 0), getPx(big, 1, 1), getPx(big, 2, 0), getPx(big, 3, 1)]).toEqual([RED, RED, BLUE, BLUE]);
  });
  it("splits and stacks animation frames", () => {
    const f0 = newBuf(2, 2);
    const f1 = newBuf(2, 2);
    setPx(f0, 0, 0, RED);
    setPx(f1, 1, 1, BLUE);
    const strip = stackFrames([f0, f1]);
    expect([strip.w, strip.h]).toEqual([2, 4]);
    expect(getPx(strip, 1, 3)).toEqual(BLUE);
    expect(cropFrame(strip, 2, 1).data).toEqual(f1.data);
    expect(cropFrame(strip, 2, 0).data).toEqual(f0.data);
  });
  it("base64 round trip", () => {
    const bytes = new Uint8ClampedArray([0, 1, 2, 250, 255, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    const big = new Uint8ClampedArray(100_000).map((_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});

describe("review fixes: shading and tiled edges", () => {
  it("shading keeps a grey grey (no red cast), however often it is applied", () => {
    const darker = applyInk([128, 128, 128, 255], RED, "darken", 100);
    expect(darker[0]).toBe(darker[1]);
    expect(darker[1]).toBe(darker[2]);
    expect(darker[0]).toBeLessThan(128);
    const lighter = applyInk([200, 200, 200, 255], RED, "lighten", 100);
    expect([lighter[0] === lighter[1], lighter[1] === lighter[2], lighter[0] > 200]).toEqual([true, true, true]);
    let c: Rgba = [180, 180, 180, 77];
    for (let i = 0; i < 12; i++) c = applyInk(c, RED, "darken", 100);
    expect([c[0] === c[1] && c[1] === c[2], c[3]]).toEqual([true, 77]);
  });
  it("shading with nothing to do changes nothing, and a pass does not drift the hue", () => {
    expect(applyInk([123, 77, 31, 255], RED, "darken", 0)).toEqual([123, 77, 31, 255]);
    expect(applyInk([123, 77, 31, 255], RED, "lighten", 0)).toEqual([123, 77, 31, 255]);
    const start: Rgba = [123, 77, 31, 255];
    let c = start;
    for (let i = 0; i < 3; i++) c = applyInk(c, RED, "lighten", 100);
    for (let i = 0; i < 3; i++) c = applyInk(c, RED, "darken", 100);
    const hue = (p: Rgba) => rgbToHsv(p[0], p[1], p[2])[0];
    expect(Math.abs(hue(c) - hue(start))).toBeLessThanOrEqual(2);
    // a coloured pixel still gets the small saturation shift
    const dark = applyInk([100, 150, 140, 255], RED, "darken", 100);
    expect(rgbToHsv(dark[0], dark[1], dark[2])[1]).toBeGreaterThan(rgbToHsv(100, 150, 140)[1]);
  });
  it("tiled: an area continues across the edges for the wand and the bucket", () => {
    // '#' at both ends of the row are one area when the texture repeats
    const b = newBuf(4, 1);
    setPx(b, 0, 0, RED);
    setPx(b, 3, 0, RED);
    expect(Array.from(floodMask(b, 0, 0, 0, true))).toEqual([1, 0, 0, 0]);
    expect(Array.from(floodMask(b, 0, 0, 0, true, true))).toEqual([1, 0, 0, 1]);
    // top and bottom too
    const col = newBuf(1, 4);
    setPx(col, 0, 0, BLUE);
    setPx(col, 0, 3, BLUE);
    expect(Array.from(floodMask(col, 0, 3, 0, true, true))).toEqual([1, 0, 0, 1]);
  });
  it("tiled: blur at an edge mixes with the pixels across it, so a repeating texture gets no seam", () => {
    const src = newBuf(4, 1);
    setPx(src, 3, 0, [200, 0, 0, 255]);
    const plain = cloneBuf(src);
    blurPoints(plain, src, [[0, 0]], null);
    expect(getPx(plain, 0, 0)).toEqual(CLEAR);
    const tiled = cloneBuf(src);
    blurPoints(tiled, src, [[0, 0]], null, true);
    expect(getPx(tiled, 0, 0)[0]).toBe(200);
    expect(getPx(tiled, 0, 0)[3]).toBeGreaterThan(0);
    // the same blur in the middle of a wide image and at the edge of a repeating one agree
    const wide = newBuf(5, 3);
    for (let y = 0; y < 3; y++) setPx(wide, 1, y, [200, 0, 0, 255]);
    const mid = cloneBuf(wide);
    blurPoints(mid, wide, [[2, 1]], null);
    const rep = newBuf(4, 1);
    setPx(rep, 3, 0, [200, 0, 0, 255]);
    const edge = cloneBuf(rep);
    blurPoints(edge, rep, [[0, 0]], null, true);
    expect(getPx(edge, 0, 0)).toEqual(getPx(mid, 2, 1));
  });
  it("tiled: jumble swaps across the edges and still only moves pixels around", () => {
    const b = newBuf(2, 1);
    setPx(b, 0, 0, RED);
    // a neighbour to the left of column 0 is column 1 when the texture repeats
    jumblePoints(b, [[0, 0]], null, () => 0, true);
    expect(art(b)).toEqual([".#"]);
    const plain = newBuf(2, 1);
    setPx(plain, 0, 0, RED);
    jumblePoints(plain, [[0, 0]], null, () => 0);
    expect(art(plain)).toEqual(["#."]);
  });
});

import { describe, expect, it } from "vitest";
import { getPx, newBuf, setPx, type Buf, type Rgba } from "../editor/pixels";
import type { Scaling } from "../lib/api";
import {
  alphaAt, autoGuiScale, blitQuads, demoWidths, guiSize, hitTest, imageScale, rectAt, renderSprite, sameScaling,
  scaleRect, scalingLabel, spriteQuads, tiledQuads, toGui, type Placed,
} from "./slice";

/** A synthetic sprite where every pixel says where it is: (x*10, y*10, 7). */
function coords(w: number, h: number): Buf {
  const b = newBuf(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPx(b, x, y, [x * 10, y * 10, 7, 255]);
  return b;
}
/** Which source pixel every output pixel came from, as "x,y". */
function origins(b: Buf): string[][] {
  const rows: string[][] = [];
  for (let y = 0; y < b.h; y++) {
    const r: string[] = [];
    for (let x = 0; x < b.w; x++) {
      const p = getPx(b, x, y);
      r.push(p[3] === 0 ? "." : `${p[0] / 10},${p[1] / 10}`);
    }
    rows.push(r);
  }
  return rows;
}
const nine = (w: number, h: number, b: number, stretchInner = false): Scaling =>
  ({ type: "nine_slice", width: w, height: h, border: { left: b, top: b, right: b, bottom: b }, stretch_inner: stretchInner });

describe("stretch", () => {
  it("scales the whole image, nearest", () => {
    const out = renderSprite(coords(3, 2), [3, 2], { type: "stretch" }, 6, 2);
    expect(origins(out)).toEqual([
      ["0,0", "0,0", "1,0", "1,0", "2,0", "2,0"],
      ["0,1", "0,1", "1,1", "1,1", "2,1", "2,1"],
    ]);
  });
  it("shrinks by sampling pixel centres", () => {
    const out = renderSprite(coords(4, 1), [4, 1], { type: "stretch" }, 2, 1);
    expect(origins(out)).toEqual([["1,0", "3,0"]]);
  });
});

describe("tile", () => {
  it("repeats from the top-left and cuts the last tile", () => {
    const out = renderSprite(coords(3, 2), [3, 2], { type: "tile", width: 3, height: 2 }, 7, 3);
    expect(origins(out)).toEqual([
      ["0,0", "1,0", "2,0", "0,0", "1,0", "2,0", "0,0"],
      ["0,1", "1,1", "2,1", "0,1", "1,1", "2,1", "0,1"],
      ["0,0", "1,0", "2,0", "0,0", "1,0", "2,0", "0,0"],
    ]);
  });
  it("plans whole tiles and one cut tile per direction", () => {
    expect(tiledQuads(0, 0, 5, 2, 0, 0, 2, 2).map((q) => [q.dx, q.dw])).toEqual([[0, 2], [2, 2], [4, 1]]);
    expect(tiledQuads(0, 0, 0, 2, 0, 0, 2, 2)).toEqual([]);
  });
});

describe("nine-slice", () => {
  it("keeps corners, tiles edges and centre (the game's default)", () => {
    // 6×6 with border 2: corners 2×2, the inner part is 2×2 and repeats
    const out = renderSprite(coords(6, 6), [6, 6], nine(6, 6, 2), 9, 7);
    const o = origins(out);
    const expected = (x: number, y: number) => {
      const sx = x < 2 ? x : x >= 7 ? x - 3 : 2 + ((x - 2) % 2);
      const sy = y < 2 ? y : y >= 5 ? y - 1 : 2 + ((y - 2) % 2);
      return `${sx},${sy}`;
    };
    for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) expect(o[y][x], `${x},${y}`).toBe(expected(x, y));
  });

  it("stretches the inner parts with stretch_inner", () => {
    const out = renderSprite(coords(6, 6), [6, 6], nine(6, 6, 2, true), 10, 6);
    // 6 rows high = the sprite's height: three slices across, the middle 2 columns stretched to 6
    expect(origins(out)[0]).toEqual(["0,0", "1,0", "2,0", "2,0", "2,0", "3,0", "3,0", "3,0", "4,0", "5,0"]);
  });

  it("draws the sprite whole at its own size", () => {
    expect(spriteQuads(nine(6, 6, 2), [6, 6], 6, 6)).toEqual([{ su: 0, sv: 0, sw: 6, sh: 6, dx: 0, dy: 0, dw: 6, dh: 6 }]);
  });

  it("is three slices when only one direction changes", () => {
    const q = spriteQuads(nine(6, 4, 1), [6, 4], 9, 4);
    expect(q.map((x) => [x.dx, x.dw, x.dh])).toEqual([[0, 1, 4], [1, 4, 4], [5, 3, 4], [8, 1, 4]]);
    const v = spriteQuads(nine(4, 6, 1), [4, 6], 4, 8);
    expect(v.map((x) => [x.dy, x.dh, x.dw])).toEqual([[0, 1, 4], [1, 4, 4], [5, 2, 4], [7, 1, 4]]);
  });

  it("cuts borders to half the size when the target is small", () => {
    const o = origins(renderSprite(coords(6, 6), [6, 6], nine(6, 6, 2), 3, 3));
    expect(o).toEqual([
      ["0,0", "1,0", "5,0"],
      ["0,1", "1,1", "5,1"],
      ["0,5", "1,5", "5,5"],
    ]);
  });

  it("follows separate borders", () => {
    const s: Scaling = { type: "nine_slice", width: 5, height: 3, border: { left: 1, top: 0, right: 2, bottom: 0 }, stretch_inner: false };
    expect(origins(renderSprite(coords(5, 3), [5, 3], s, 8, 3))[0]).toEqual(["0,0", "1,0", "2,0", "1,0", "2,0", "1,0", "3,0", "4,0"]);
  });

  it("draws each GUI pixel as k×k real pixels", () => {
    const o = origins(renderSprite(coords(6, 6), [6, 6], nine(6, 6, 2), 7, 6, 2));
    expect(o.length).toBe(12);
    expect(o[0].slice(0, 8)).toEqual(["0,0", "0,0", "1,0", "1,0", "2,0", "2,0", "3,0", "3,0"]);
    expect(o[1][0]).toBe("0,0");
    expect(o[2][0]).toBe("0,1");
  });

  it("reads a 2× image at its GUI size", () => {
    // 12×12 pixels for a 6×6 sprite: one GUI pixel samples the centre of each 2×2 block
    const o = origins(renderSprite(coords(12, 12), [6, 6], nine(6, 6, 2), 8, 6));
    expect(o[0]).toEqual(["1,1", "3,1", "5,1", "7,1", "5,1", "7,1", "9,1", "11,1"]);
    // at 2× the real pixels are used one to one
    const o2 = origins(renderSprite(coords(12, 12), [6, 6], { type: "stretch" }, 6, 6, 2));
    expect(o2[0]).toEqual(Array.from({ length: 12 }, (_, i) => `${i},0`));
  });
});

describe("compositing", () => {
  it("blends over what is already drawn and keeps transparent pixels out", () => {
    const out = newBuf(4, 1);
    const bg: Buf = newBuf(4, 1);
    for (let x = 0; x < 4; x++) setPx(bg, x, 0, [0, 0, 255, 255]);
    blitQuads(out, bg, [4, 1], [{ su: 0, sv: 0, sw: 4, sh: 1, dx: 0, dy: 0, dw: 4, dh: 1 }], 0, 0, 1);
    const fg = newBuf(2, 1);
    setPx(fg, 0, 0, [255, 0, 0, 255]);
    setPx(fg, 1, 0, [255, 0, 0, 0]);
    blitQuads(out, fg, [2, 1], [{ su: 0, sv: 0, sw: 2, sh: 1, dx: 0, dy: 0, dw: 2, dh: 1 }], 1, 0, 1);
    const px = (x: number): Rgba => getPx(out, x, 0);
    expect([px(0), px(1), px(2), px(3)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
  });
});

describe("GUI scale", () => {
  it("picks the game's automatic scale", () => {
    expect(autoGuiScale(1920, 1080)).toBe(4);
    expect(autoGuiScale(1280, 720)).toBe(3);
    expect(autoGuiScale(854, 480)).toBe(2);
    expect(autoGuiScale(640, 480)).toBe(2);
    expect(autoGuiScale(639, 480)).toBe(1);
    expect(autoGuiScale(1920, 1080, 2)).toBe(2);
  });
  it("converts between real and GUI pixels", () => {
    expect(guiSize(1921, 1080, 2)).toEqual([961, 540]);
    expect(toGui(5, 9, 3)).toEqual([1, 3]);
  });
});

describe("hit-testing", () => {
  const placed: Placed[] = [
    { index: 0, piece: "window", x: 0, y: 0, w: 100, h: 100 },
    { index: 1, piece: "frame", x: 10, y: 10, w: 10, h: 10 },
    { index: 2, piece: "overlay", x: 0, y: 0, w: 100, h: 100 },
  ];
  it("takes the topmost visible piece", () => {
    // the overlay is see-through except its border
    const opaque = (p: Placed, lx: number, ly: number) => p.piece !== "overlay" || lx < 2 || ly < 2;
    expect(hitTest(placed, 12, 12, opaque)?.piece).toBe("frame");
    expect(hitTest(placed, 50, 50, opaque)?.piece).toBe("window");
    expect(hitTest(placed, 1, 50, opaque)?.piece).toBe("overlay");
    expect(hitTest(placed, 12, 12)?.piece).toBe("overlay");
    expect(hitTest(placed, 120, 12)).toBeNull();
  });
  it("falls back to the topmost rectangle when nothing is visible there", () => {
    expect(hitTest(placed, 50, 50, () => false)?.piece).toBe("overlay");
  });
  it("finds the smallest shared-image rectangle under a pixel", () => {
    const pieces = [{ id: "a", rect: [0, 0, 20, 20] as [number, number, number, number] }, { id: "b", rect: [5, 5, 4, 4] as [number, number, number, number] }, { id: "c", rect: null }];
    expect(rectAt(pieces, 6, 6)?.id).toBe("b");
    expect(rectAt(pieces, 1, 1)?.id).toBe("a");
    expect(rectAt(pieces, 30, 1)).toBeNull();
  });
  it("scales rectangles to the pack's image size", () => {
    expect(scaleRect([0, 66, 200, 20], 2)).toEqual([0, 132, 400, 40]);
    expect(imageScale([512, 512], [256, 256])).toBe(2);
    expect(imageScale([256, 256], [256, 256])).toBe(1);
    expect(imageScale([384, 384], [256, 256])).toBeNull();
    expect(imageScale([512, 256], [256, 256])).toBeNull();
    expect(imageScale([128, 128], [256, 256])).toBeNull();
  });
});

describe("panel helpers", () => {
  it("chooses three widths that fit", () => {
    expect(demoWidths([200, 20])).toEqual({ widths: [100, 200, 280], k: 1 });
    expect(demoWidths([20, 20])).toEqual({ widths: [10, 20, 30], k: 2 });
    expect(demoWidths([8, 20])).toEqual({ widths: [4, 8, 12], k: 2 });
  });
  it("names and compares rules", () => {
    expect(scalingLabel(nine(200, 20, 3))).toBe("Nine-slice (border 3)");
    expect(scalingLabel({ type: "tile", width: 4, height: 2 })).toBe("Tile (4×2)");
    expect(sameScaling(nine(2, 2, 1), { type: "nine_slice", width: 2, height: 2, border: { bottom: 1, right: 1, top: 1, left: 1 }, stretch_inner: false })).toBe(true);
    expect(sameScaling(nine(2, 2, 1), nine(2, 2, 1, true))).toBe(false);
  });
});

describe("alpha under the pointer", () => {
  it("samples the drawn piece like the renderer", () => {
    const img = newBuf(4, 4);
    setPx(img, 0, 0, [1, 2, 3, 255]);
    setPx(img, 3, 3, [1, 2, 3, 128]);
    const s: Scaling = { type: "nine_slice", width: 4, height: 4, border: { left: 1, top: 1, right: 1, bottom: 1 }, stretch_inner: false };
    const q = spriteQuads(s, [4, 4], 10, 10);
    expect(alphaAt(img, [4, 4], q, 0, 0)).toBe(255);
    expect(alphaAt(img, [4, 4], q, 9, 9)).toBe(128);
    expect(alphaAt(img, [4, 4], q, 5, 5)).toBe(0);
    expect(alphaAt(img, [4, 4], q, 12, 5)).toBe(0);
    const out = renderSprite(img, [4, 4], s, 10, 10);
    expect(getPx(out, 9, 9)[3]).toBe(128);
  });
});

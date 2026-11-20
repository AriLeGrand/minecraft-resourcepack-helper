import { describe, expect, it } from "vitest";
import { addColour, fillFrom, MAX_PACK_COLOURS, moveColour, nearestIndex, oklab, removeColour, snapChanged, snapColor, snapPalette } from "./packPalette";
import { cloneBuf, getPx, newBuf, setPx } from "./pixels";
import { defaultOptions, applyStroke, growStroke } from "./tools";

describe("OKLab", () => {
  it("matches the reference values", () => {
    const w = oklab(255, 255, 255);
    expect(w[0]).toBeCloseTo(1, 3);
    expect(Math.abs(w[1])).toBeLessThan(1e-3);
    expect(Math.abs(w[2])).toBeLessThan(1e-3);
    const r = oklab(255, 0, 0);
    expect(r[0]).toBeCloseTo(0.6279, 3);
    expect(r[1]).toBeCloseTo(0.2249, 3);
    expect(r[2]).toBeCloseTo(0.1258, 3);
    expect(oklab(0, 0, 0).every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });
});

describe("snapping", () => {
  const pal = snapPalette(["#000000", "#808080", "#ffffff", "#c83232"])!;
  it("finds the perceptually nearest colour", () => {
    // a dark blue is nearer to black than to grey in OKLab (plain RGB distance says grey)
    expect(nearestIndex(pal, 20, 20, 60)).toBe(0);
    expect(nearestIndex(pal, 128, 128, 128)).toBe(1);
    expect(nearestIndex(pal, 250, 250, 250)).toBe(2);
    expect(nearestIndex(pal, 220, 40, 40)).toBe(3);
    // the answer is cached and stays the same
    expect(nearestIndex(pal, 20, 20, 60)).toBe(0);
  });
  it("keeps alpha", () => {
    expect(snapColor(pal, [210, 60, 60, 128])).toEqual([200, 50, 50, 128]);
  });
  it("is null for an empty or invalid list", () => {
    expect(snapPalette([])).toBeNull();
    expect(snapPalette(["nope"])).toBeNull();
  });
  it("snaps only changed, visible pixels", () => {
    const before = newBuf(3, 1);
    setPx(before, 0, 0, [1, 2, 3, 255]);
    const after = cloneBuf(before);
    setPx(after, 1, 0, [130, 120, 125, 200]);
    setPx(after, 2, 0, [255, 0, 255, 0]);
    snapChanged(after, before, pal);
    expect(getPx(after, 0, 0)).toEqual([1, 2, 3, 255]); // untouched
    expect(getPx(after, 1, 0)).toEqual([128, 128, 128, 200]);
    expect(getPx(after, 2, 0)).toEqual([255, 0, 255, 0]); // transparent stays
  });
});

describe("drawing with snap", () => {
  const pal = snapPalette(["#102030", "#f0e0d0"])!;
  const base = () => newBuf(4, 4);
  it("a pencil stroke uses only palette colours, also at half opacity", () => {
    for (const opacity of [100, 50]) {
      const out = applyStroke({
        tool: "pencil", snapshot: base(), points: [[0, 0], [3, 3]], button: 0, fg: [20, 30, 50, 255], bg: [0, 0, 0, 255],
        mask: null, seed: 1, options: { ...defaultOptions, opacity }, snap: pal,
      });
      for (let i = 0; i < 4; i++) {
        const p = getPx(out, i, i);
        expect(p.slice(0, 3)).toEqual([16, 32, 48]);
        expect(p[3]).toBe(opacity === 100 ? 255 : 128);
      }
    }
  });
  it("the incremental stroke gives the same pixels", () => {
    const s = {
      tool: "pencil" as const, snapshot: base(), points: [[0, 0], [3, 0], [3, 3]] as [number, number][], button: 0 as const,
      fg: [230, 220, 200, 255] as [number, number, number, number], bg: [0, 0, 0, 255] as [number, number, number, number],
      mask: null, seed: 1, options: { ...defaultOptions, size: 2 }, snap: pal,
    };
    const whole = applyStroke(s);
    const grown = growStroke(s, null).buf;
    expect(Array.from(grown.data)).toEqual(Array.from(whole.data));
    expect(getPx(whole, 3, 0)).toEqual([240, 224, 208, 255]);
  });
  it("the eraser is never snapped", () => {
    const snap = newBuf(2, 1);
    setPx(snap, 0, 0, [77, 77, 77, 255]);
    const out = applyStroke({
      tool: "eraser", snapshot: snap, points: [[0, 0]], button: 0, fg: [0, 0, 0, 255], bg: [0, 0, 0, 255],
      mask: null, seed: 1, options: { ...defaultOptions, opacity: 50 }, snap: pal,
    });
    expect(getPx(out, 0, 0).slice(0, 3)).toEqual([77, 77, 77]);
  });
  it("without a palette nothing changes", () => {
    const out = applyStroke({
      tool: "pencil", snapshot: base(), points: [[1, 1]], button: 0, fg: [1, 2, 3, 255], bg: [0, 0, 0, 255],
      mask: null, seed: 1, options: defaultOptions, snap: null,
    });
    expect(getPx(out, 1, 1)).toEqual([1, 2, 3, 255]);
  });
});

describe("editing the pack palette", () => {
  it("adds without repeats, removes and moves", () => {
    let l = addColour([], [255, 0, 0, 128]);
    expect(l).toEqual(["#ff0000"]);
    l = addColour(l, [255, 0, 0, 255]);
    expect(l).toEqual(["#ff0000"]);
    l = addColour(addColour(l, [0, 255, 0, 255]), [0, 0, 255, 255]);
    expect(moveColour(l, "#0000FF", -1)).toEqual(["#ff0000", "#0000ff", "#00ff00"]);
    expect(moveColour(l, "#ff0000", -1)).toBe(l);
    expect(moveColour(l, "#0000ff", 1)).toBe(l);
    expect(removeColour(l, "#00FF00")).toEqual(["#ff0000", "#0000ff"]);
  });
  it("stops at the limit", () => {
    let l: string[] = [];
    for (let i = 0; i < MAX_PACK_COLOURS + 5; i++) l = addColour(l, [i, 0, 0, 255]);
    expect(l.length).toBe(MAX_PACK_COLOURS);
  });
  it("fills from a texture's colours", () => {
    expect(fillFrom([[1, 2, 3, 255], [1, 2, 3, 100], [0, 0, 0, 0], [9, 9, 9, 255]])).toEqual(["#010203", "#090909"]);
  });
});

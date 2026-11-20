import { describe, expect, it } from "vitest";
import {
  centerView, clampZoom, fitView, GRID_ZOOM, maskEdges, MAX_ZOOM, MIN_ZOOM, panBy, pixelToScreen, pointEdges,
  screenToPixel, stepZoom, zoomAbout, zoomLabel, ZOOM_STEPS, type View,
} from "./view";

const v: View = { zoom: 16, panX: 100, panY: 40 };

describe("screen and pixel positions", () => {
  it("converts both ways", () => {
    expect(screenToPixel(v, 100, 40)).toEqual([0, 0]);
    expect(screenToPixel(v, 115.9, 55.9)).toEqual([0, 0]);
    expect(screenToPixel(v, 116, 56)).toEqual([1, 1]);
    expect(screenToPixel(v, 292, 152)).toEqual([12, 7]);
    expect(pixelToScreen(v, 12, 7)).toEqual([292, 152]);
    expect(screenToPixel(v, ...pixelToScreen(v, 31, 31))).toEqual([31, 31]);
  });
  it("gives positions outside the image too (tiled drawing and shapes need them)", () => {
    expect(screenToPixel(v, 99, 39)).toEqual([-1, -1]);
    expect(screenToPixel(v, 0, 0)).toEqual([-7, -3]);
    expect(screenToPixel({ zoom: 0.5, panX: 0, panY: 0 }, 9, 3)).toEqual([18, 6]);
  });
});

describe("zoom", () => {
  it("keeps the point under the cursor in place", () => {
    const cursor: [number, number] = [292, 152];
    const before = screenToPixel(v, ...cursor);
    for (const z of [1, 4, 8, 32, 64]) {
      const next = zoomAbout(v, z, ...cursor);
      expect(next.zoom).toBe(z);
      expect(screenToPixel(next, ...cursor)).toEqual(before);
    }
    // and exactly: the same fraction of the pixel stays under the cursor
    const next = zoomAbout(v, 32, 108, 48);
    expect([next.panX, next.panY]).toEqual([92, 32]);
  });
  it("steps through fixed levels and stops at the ends", () => {
    expect(stepZoom(16, 1)).toBe(20);
    expect(stepZoom(16, -1)).toBe(12);
    expect(stepZoom(1, -1)).toBe(0.5);
    expect(stepZoom(7, 1)).toBe(8);
    expect(stepZoom(7, -1)).toBe(6);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(zoomAbout(v, 1000, 0, 0).zoom).toBe(MAX_ZOOM);
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS);
  });
  it("labels zoom like the mockup", () => {
    expect(zoomLabel(16)).toBe("1600%");
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(0.5)).toBe("50%");
    expect(GRID_ZOOM).toBe(4);
  });
});

describe("fit and pan", () => {
  it("fits the whole image at the largest step and centres it", () => {
    // 32×32 in a 900×600 area with 24 px margins: 552 / 32 = 17.25 → 16×
    const f = fitView(32, 32, 900, 600);
    expect(f).toEqual({ zoom: 16, panX: 194, panY: 44 });
    expect(fitView(16, 16, 900, 600).zoom).toBe(32);
    // a tall strip is limited by its height
    expect(fitView(16, 512, 900, 600).zoom).toBe(1);
    // bigger than the window: the smallest step, never zero
    expect(fitView(4096, 4096, 300, 300).zoom).toBe(MIN_ZOOM);
    expect(fitView(16, 16, 0, 0).zoom).toBe(MIN_ZOOM);
  });
  it("centres at a given zoom and pans by screen pixels", () => {
    expect(centerView(10, 20, 100, 100, 2)).toEqual({ zoom: 2, panX: 40, panY: 30 });
    expect(panBy(v, -30, 12)).toEqual({ zoom: 16, panX: 70, panY: 52 });
  });
});

describe("outlines", () => {
  const segs = (flat: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < flat.length; i += 4) out.push(flat.slice(i, i + 4).join(","));
    return out.sort();
  };
  it("outlines one pixel with four edges", () => {
    const m = new Uint8Array(9);
    m[4] = 1;
    expect(segs(maskEdges(m, 3, 3))).toEqual(["1,1,1,2", "1,1,2,1", "1,2,2,2", "2,1,2,2"]);
  });
  it("leaves out edges between two selected pixels, and closes at the image border", () => {
    const m = new Uint8Array([1, 1, 0, 0]);
    expect(segs(maskEdges(m, 2, 2))).toEqual(["0,0,0,1", "0,0,1,0", "0,1,1,1", "1,0,2,0", "1,1,2,1", "2,0,2,1"]);
    expect(maskEdges(new Uint8Array(4), 2, 2)).toEqual([]);
    // a full mask is just the frame: 2 edges per border pixel side
    expect(maskEdges(new Uint8Array(4).fill(1), 2, 2).length / 4).toBe(8);
  });
  it("outlines loose points, also outside the image (brush cursor)", () => {
    expect(segs(pointEdges([[-1, 0], [0, 0]]))).toEqual(["-1,0,-1,1", "-1,0,0,0", "-1,1,0,1", "0,0,1,0", "0,1,1,1", "1,0,1,1"]);
    expect(pointEdges([])).toEqual([]);
  });
});

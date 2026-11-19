// "Edit only these cells": every tool, fill, paste, move, clear and the
// eraser is clipped to the particle's cells, and a save never changes a pixel
// outside them. Synthetic pixels only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rust = vi.hoisted(() => ({
  editorOpen: vi.fn(),
  editorSave: vi.fn(),
  loadTextures: vi.fn(),
  closePack: vi.fn(),
  bootstrap: vi.fn(),
  getPack: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: rust,
  images: {},
  toError: (e: unknown) =>
    e && typeof e === "object" && "message" in e
      ? { kind: "error", message: String((e as { message: unknown }).message), hint: null }
      : { kind: "error", message: String(e), hint: null },
}));

import type { PackState } from "../lib/api";
import { cellsMask } from "../particles/cells";
import { useApp } from "../store";
import { pointerDown, pointerMove, pointerUp, resetController, setPreviewScheduler, sprayTick } from "./controller";
import { activeCel, flatStrip, fromRaw } from "./doc";
import { activeTab, openForTest, useEditor, type CellsRequest } from "./editorStore";
import { base64ToBytes, newBuf, setPx, type Buf, type Pt } from "./pixels";
import { andMask, cellsRegion, clipToMask, editMask } from "./region";
import { BLUE, opened, RED } from "./testutil";
import { defaultOptions, type ToolId } from "./tools";

const ed = () => useEditor.getState();
const tab = () => activeTab(ed())!;
const cel = () => activeCel(tab().doc);
const at = (p: Pt, button = 0) => ({ p, button, shift: false, alt: false });

function drag(points: Pt[], button = 0) {
  pointerDown(at(points[0], button));
  for (const p of points.slice(1)) pointerMove(at(p, button));
  pointerUp(at(points[points.length - 1], button));
}

const PACK = { dir: "/pack", project: { name: "Test pack", version_dir: "1.8.9" }, version: null } as unknown as PackState;

/** A 32×32 "sheet" (16×16 cells of 2×2 px) where every pixel has its own colour. */
function sheet(size = 32): Buf {
  const b = newBuf(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) setPx(b, x, y, [(x * 7) % 256, (y * 11) % 256, (x * y) % 256, 255]);
  return b;
}

// heart = cell 80 (column 0, row 5); smoke = cells 0–7 (the top row, left half)
const HEART: CellsRequest = { particle: "heart", cells: [80], shared: [], grid: 16 };
const SMOKE: CellsRequest = { particle: "smoke", cells: [7, 6, 5, 4, 3, 2, 1, 0], shared: ["poof", "portal"], grid: 16 };

function openSheet(req = HEART, size = 32) {
  const t = openForTest(fromRaw(opened([[sheet(size)]], { path: "particle/particles" })));
  const region = cellsRegion(t.doc, req)!;
  useEditor.setState({ tabs: ed().tabs.map((x) => (x.id === t.id ? { ...x, region } : x)) });
  return { original: sheet(size), mask: region.mask };
}

/** Number of pixels outside the mask that differ from `before`, and inside. */
function changes(before: Buf, after: Buf, mask: Uint8Array) {
  let outside = 0;
  let inside = 0;
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const diff = [0, 1, 2, 3].some((k) => before.data[o + k] !== after.data[o + k]);
    if (!diff) continue;
    if (mask[i]) inside++;
    else outside++;
  }
  return { outside, inside };
}

const ACROSS: Pt[] = [[0, 0], [31, 31], [0, 31], [31, 0], [5, 12], [20, 10], [1, 11]];

beforeEach(() => {
  resetController();
  setPreviewScheduler(null);
  Object.values(rust).forEach((f) => f.mockReset());
  rust.loadTextures.mockResolvedValue({ rows: [], summary: null });
  rust.editorSave.mockResolvedValue(undefined);
  useApp.setState({ pack: { ...PACK, vanilla_ready: true } as PackState, rows: [], modal: null, toasts: [], screen: "editor" });
  useEditor.setState({ tabs: [], activeId: null, tool: "pencil", options: defaultOptions, fg: RED, bg: BLUE, clipboard: null, text: null });
});

describe("mask helpers", () => {
  it("clips a buffer to the mask and reuses it when nothing outside changed", () => {
    const prev = sheet();
    const mask = cellsMask([80], 32, 32);
    const inside = sheet();
    setPx(inside, 0, 10, RED);
    expect(clipToMask(inside, prev, mask)).toBe(inside);
    const outside = sheet();
    setPx(outside, 5, 5, RED);
    setPx(outside, 1, 11, RED);
    const c = clipToMask(outside, prev, mask);
    expect(c).not.toBe(outside);
    expect(changes(prev, c, mask)).toEqual({ outside: 0, inside: 1 });
  });

  it("limits a selection to the region and keeps the same object for the same inputs", () => {
    const region = cellsRegion(fromRaw(opened([[sheet()]])), HEART)!;
    expect(editMask(null, region)).toBe(region.mask);
    const sel = new Uint8Array(32 * 32).fill(1);
    sel[10 * 32] = 0;
    const m = editMask(sel, region)!;
    expect(editMask(sel, region)).toBe(m);
    expect([...m].filter(Boolean).length).toBe(3);
    expect(andMask(null, region.mask)).toBe(region.mask);
    expect(editMask(sel, null)).toBe(sel);
  });

  it("refuses a sheet that does not fit the grid", () => {
    expect(cellsRegion(fromRaw(opened([[newBuf(30, 30)]])), HEART)).toBeNull();
    expect(cellsRegion(fromRaw(opened([[newBuf(32, 64)]])), HEART)).toBeNull();
    // a 4× sheet: the heart cell is 8×8 px at (0, 40)
    const big = cellsRegion(fromRaw(opened([[newBuf(128, 128)]])), HEART)!;
    expect(big.rects).toEqual([{ x: 0, y: 40, w: 8, h: 8 }]);
  });
});

describe("tools never touch pixels outside the cells", () => {
  const strokes: ToolId[] = ["pencil", "eraser", "spray", "blur", "shade"];
  for (const tool of strokes) {
    it(`${tool} dragged across the whole sheet`, () => {
      const { original, mask } = openSheet();
      useEditor.setState({ tool, options: { ...defaultOptions, size: 4 } });
      pointerDown(at(ACROSS[0]));
      for (const p of ACROSS.slice(1)) {
        pointerMove(at(p));
        // the preview on screen is clipped as well
        const shown = tab().preview?.cel;
        if (shown) expect(changes(original, shown, mask).outside).toBe(0);
        if (tool === "spray") sprayTick();
      }
      pointerUp(at(ACROSS[ACROSS.length - 1]));
      const c = changes(original, cel(), mask);
      expect(c.outside).toBe(0);
      if (tool === "pencil" || tool === "eraser") expect(c.inside).toBeGreaterThan(0);
    });
  }

  const shapes: ToolId[] = ["line", "rect", "ellipse", "gradient"];
  for (const tool of shapes) {
    it(`${tool} from corner to corner`, () => {
      const { original, mask } = openSheet();
      useEditor.setState({ tool, options: { ...defaultOptions, filled: true, size: 3 } });
      drag([[0, 0], [16, 16], [31, 31]]);
      expect(changes(original, cel(), mask).outside).toBe(0);
    });
  }

  it("bucket fill inside and outside the cells", () => {
    const { original, mask } = openSheet();
    useEditor.setState({ tool: "bucket", options: { ...defaultOptions, tolerance: 255, contiguous: false } });
    drag([[20, 20]]);
    expect(changes(original, cel(), mask)).toEqual({ outside: 0, inside: 4 });
    drag([[0, 10]]);
    expect(changes(original, cel(), mask).outside).toBe(0);
  });

  it("polygon and curve", () => {
    const { original, mask } = openSheet();
    useEditor.setState({ tool: "polygon", options: { ...defaultOptions, filled: true } });
    drag([[0, 0], [31, 5], [16, 31], [0, 20]]);
    useEditor.setState({ tool: "curve" });
    drag([[0, 0], [31, 31]]);
    drag([[0, 31]]);
    expect(changes(original, cel(), mask).outside).toBe(0);
  });

  it("select all + delete, cut and paste", () => {
    const { original, mask } = openSheet();
    ed().selectAll();
    ed().deleteSelection();
    expect(changes(original, cel(), mask)).toEqual({ outside: 0, inside: 4 });
    ed().deselect();
    ed().copy();
    ed().cut();
    ed().paste();
    expect(changes(original, cel(), mask).outside).toBe(0);
  });

  it("delete with nothing selected clears only the cells", () => {
    const { original, mask } = openSheet(SMOKE);
    ed().deleteSelection();
    expect(changes(original, cel(), mask)).toEqual({ outside: 0, inside: 8 * 4 });
  });

  it("move lifts only the cells' pixels and never drops them outside", () => {
    const { original, mask } = openSheet(SMOKE);
    useEditor.setState({ tool: "move" });
    drag([[3, 1], [10, 12], [13, 14]]);
    const c = changes(original, cel(), mask);
    expect(c.outside).toBe(0);
    expect(c.inside).toBeGreaterThan(0);
    // a selection reaching outside does not let the move take pixels from there
    ed().selectAll();
    drag([[20, 20], [2, 0]]);
    expect(changes(original, cel(), mask).outside).toBe(0);
  });

  it("frames cannot be added while only cells are edited", () => {
    openSheet();
    ed().newFrame();
    ed().duplicateFrame();
    expect(tab().doc.frames.length).toBe(1);
  });
});

describe("saving", () => {
  it("writes the whole sheet with every pixel outside the cells as it was", async () => {
    const { original, mask } = openSheet(SMOKE);
    useEditor.setState({ tool: "pencil", options: { ...defaultOptions, size: 8 } });
    drag(ACROSS);
    // layer changes are not clipped while drawing, but a save still is
    ed().addLayer();
    ed().patchLayer(0, { visible: false });
    expect(await ed().save()).toBe(true);
    const [path, , flat] = rust.editorSave.mock.calls[0];
    expect(path).toBe("particle/particles");
    const saved: Buf = { w: 32, h: 32, data: base64ToBytes(flat) };
    const c = changes(original, saved, mask);
    expect(c.outside).toBe(0);
    expect(c.inside).toBeGreaterThan(0);
  });

  it("leaving the mode makes the whole sheet editable again", () => {
    const { original, mask } = openSheet();
    ed().leaveRegion();
    expect(tab().region).toBeNull();
    useEditor.setState({ tool: "pencil" });
    drag([[0, 0], [31, 31]]);
    expect(changes(original, cel(), mask).outside).toBeGreaterThan(0);
  });

  it("opens the sheet from the pack with the cells as the region", async () => {
    rust.editorOpen.mockResolvedValue(opened([[sheet(64)]], { path: "particle/particles" }));
    await ed().openCells("particle/particles", SMOKE);
    const r = tab().region!;
    expect(r.particle).toBe("smoke");
    expect(r.rects).toHaveLength(8);
    expect(r.rects[0]).toEqual({ x: 28, y: 0, w: 4, h: 4 });
    expect(flatStrip(tab().doc).data).toEqual(r.base.data);
    expect(useApp.getState().status).toContain("Editing only smoke (cells 0–7)");
  });

  it("explains a sheet that does not fit the grid and leaves it unrestricted", async () => {
    rust.editorOpen.mockResolvedValue(opened([[newBuf(100, 100)]], { path: "particle/particles" }));
    await ed().openCells("particle/particles", HEART);
    expect(tab().region).toBeNull();
    expect(useApp.getState().modal?.title ?? JSON.stringify(useApp.getState().toasts)).toMatch(/cells could not be selected/i);
  });
});

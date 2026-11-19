// The editor driven the way the canvas drives it: pointer input in texture
// pixels, the real stores, a fake Rust side.
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
      ? { kind: "error", message: String((e as { message: unknown }).message), hint: (e as { hint?: string }).hint ?? null }
      : { kind: "error", message: String(e), hint: null },
}));

import type { PackState, TextureRow } from "../lib/api";
import { useApp } from "../store";
import { cancelPending, commitPending, isBusy, pointerDown, pointerMove, pointerUp, resetController, sprayTick, updateText } from "./controller";
import { activeCel, flatStrip, fromRaw, patchLayer } from "./doc";
import { activeTab, openForTest, shownDoc, useEditor } from "./editorStore";
import { base64ToBytes, getPx, type Pt } from "./pixels";
import { art, BLUE, bufFrom, GREEN, maskArt, opened, RED, solid } from "./testutil";
import { defaultOptions } from "./tools";

const ed = () => useEditor.getState();
const tab = () => activeTab(ed())!;
const cel = () => activeCel(tab().doc);
const at = (p: Pt, mods: { button?: number; shift?: boolean; alt?: boolean } = {}) => ({ p, button: mods.button ?? 0, shift: !!mods.shift, alt: !!mods.alt });

function drag(points: Pt[], mods: { button?: number; shift?: boolean; alt?: boolean } = {}) {
  pointerDown(at(points[0], mods));
  for (const p of points.slice(1)) pointerMove(at(p, mods));
  pointerUp(at(points[points.length - 1], mods));
}

const PACK = { dir: "/pack", project: { name: "Test pack", version_dir: "1.21.4" }, version: null } as unknown as PackState;

/** Presses a button of the open question, the way the modal does. */
function answer(label: string) {
  const modal = useApp.getState().modal;
  if (!modal) throw new Error("no question is open");
  const b = modal.buttons.find((x) => x.label === label);
  if (!b) throw new Error(`no button "${label}" in: ${modal.buttons.map((x) => x.label).join(", ")}`);
  useApp.getState().closeModal();
  b.run?.();
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function row(path: string, modified_ms: number): TextureRow {
  return { path, mine: { path, modified_ms, file_size: 10 } } as unknown as TextureRow;
}

beforeEach(() => {
  resetController();
  Object.values(rust).forEach((f) => f.mockReset());
  rust.loadTextures.mockResolvedValue({ rows: [], summary: null });
  rust.editorSave.mockResolvedValue(undefined);
  rust.closePack.mockResolvedValue(undefined);
  rust.bootstrap.mockResolvedValue(null);
  useApp.setState({ pack: { ...PACK, vanilla_ready: true } as PackState, rows: [], modal: null, toasts: [], screen: "editor" });
  useEditor.setState({ tabs: [], activeId: null, tool: "pencil", options: defaultOptions, fg: RED, bg: BLUE, clipboard: null, text: null });
});

function open(rows: string[], path = "block/test") {
  return openForTest(fromRaw(opened([[bufFrom(rows)]], { path })));
}

describe("drawing", () => {
  it("shows the stroke while dragging and makes one undo step on release", () => {
    open(["....", "...."]);
    pointerDown(at([0, 0]));
    pointerMove(at([3, 0]));
    // not committed yet: the document is unchanged, the preview shows it
    expect(art(cel())).toEqual(["....", "...."]);
    expect(art(activeCel(shownDoc(tab())))).toEqual(["####", "...."]);
    expect(tab().doc.dirty).toBe(false);
    pointerUp(at([3, 0]));
    expect(art(cel())).toEqual(["####", "...."]);
    expect([tab().doc.dirty, tab().history.undo.length, tab().preview]).toEqual([true, 1, null]);
    expect(tab().history.undo[0].label).toBe("Pencil");
    ed().undo();
    expect(art(cel())).toEqual(["....", "...."]);
    ed().redo();
    expect(art(cel())).toEqual(["####", "...."]);
  });

  it("paints with the background colour on the right button, and ignores other buttons", () => {
    open([".."]);
    drag([[0, 0]], { button: 2 });
    expect(getPx(cel(), 0, 0)).toEqual(BLUE);
    drag([[1, 0]], { button: 1 });
    expect(art(cel())).toEqual(["#."]);
  });

  it("refuses to draw on a locked or hidden layer and says why", () => {
    const t = open(["...."]);
    useEditor.setState({ tabs: [{ ...t, doc: patchLayer(t.doc, 0, { locked: true }) }] });
    drag([[0, 0], [3, 0]]);
    expect(art(cel())).toEqual(["...."]);
    expect(tab().history.undo.length).toBe(0);
    expect(useApp.getState().status).toMatch(/locked/);
    useEditor.setState({ tabs: [{ ...t, doc: patchLayer(t.doc, 0, { visible: false }) }] });
    ed().setTool("bucket");
    drag([[0, 0]]);
    expect(art(cel())).toEqual(["...."]);
    ed().deleteSelection();
    expect(tab().history.undo.length).toBe(0);
    // selecting is still allowed
    ed().setTool("marquee");
    drag([[0, 0], [1, 0]]);
    expect(maskArt(tab().doc.selection, 4)).toEqual(["##.."]);
  });

  it("draws shapes from the image as it was, whatever the pointer did on the way", () => {
    open(["....", "....", "....", "...."]);
    ed().setTool("rect");
    drag([[0, 0], [3, 3], [1, 1], [2, 2]]);
    expect(art(cel())).toEqual(["###.", "#.#.", "###.", "...."]);
    expect(tab().history.undo.length).toBe(1);
    // Shift makes it square
    ed().undo();
    drag([[0, 0], [3, 1]], { shift: true });
    expect(art(cel())).toEqual(["####", "#..#", "#..#", "####"]);
  });

  it("fills with one click", () => {
    open(["#..", "#.."]);
    ed().setTool("bucket");
    drag([[2, 0]], { button: 2 });
    expect(getPx(cel(), 1, 1)).toEqual(BLUE);
    expect(getPx(cel(), 0, 0)).toEqual(RED);
    expect(tab().history.undo[0].label).toBe("Paint bucket");
  });

  it("bends a curve in two steps: drag the line, then click where it should bulge", () => {
    open([".....", ".....", "....."]);
    ed().setTool("curve");
    pointerDown(at([0, 0]));
    pointerMove(at([4, 0]));
    pointerUp(at([4, 0]));
    expect(isBusy()).toBe(true);
    expect(art(cel())).toEqual([".....", ".....", "....."]);
    pointerMove(at([2, 4]));
    expect(art(activeCel(shownDoc(tab())))[2][2]).toBe("#");
    pointerDown(at([2, 4]));
    pointerUp(at([2, 4]));
    expect(isBusy()).toBe(false);
    expect(art(cel())[2][2]).toBe("#");
    expect(tab().history.undo.map((c) => c.label)).toEqual(["Curve"]);
  });

  it("builds a polygon click by click and closes it with Enter", () => {
    open([".....", ".....", ".....", ".....", "....."]);
    ed().setTool("polygon");
    ed().setOptions({ filled: true });
    for (const p of [[0, 0], [4, 0], [4, 4]] as Pt[]) {
      pointerDown(at(p));
      pointerUp(at(p));
    }
    expect(isBusy()).toBe(true);
    expect(tab().history.undo.length).toBe(0);
    commitPending();
    expect(art(cel())).toEqual(["#####", ".####", "..###", "...##", "....#"]);
    expect(tab().history.undo.map((c) => c.label)).toEqual(["Contour / polygon"]);
  });

  it("draws a freehand contour in one drag", () => {
    open(["....", "....", "....", "...."]);
    ed().setTool("polygon");
    drag([[0, 0], [3, 0], [3, 3], [0, 3]]);
    expect(isBusy()).toBe(false);
    expect(art(cel())).toEqual(["####", "#..#", "#..#", "####"]);
  });

  it("drops a half-made shape with Escape and finishes it when the tool changes", () => {
    open(["...", "...", "..."]);
    ed().setTool("polygon");
    pointerDown(at([0, 0]));
    pointerUp(at([0, 0]));
    pointerDown(at([2, 0]));
    pointerUp(at([2, 0]));
    expect(cancelPending()).toBe(true);
    expect([art(cel()), tab().preview, tab().history.undo.length]).toEqual([["...", "...", "..."], null, 0]);
    expect(cancelPending()).toBe(false);
    pointerDown(at([0, 2]));
    pointerUp(at([0, 2]));
    pointerDown(at([2, 2]));
    pointerUp(at([2, 2]));
    ed().setTool("pencil");
    expect(art(cel())).toEqual(["...", "...", "###"]);
    expect(isBusy()).toBe(false);
  });

  it("keeps spraying while the pointer is held still", () => {
    open(new Array(12).fill("............"));
    ed().setTool("spray");
    pointerDown(at([6, 6]));
    const count = () => art(activeCel(shownDoc(tab()))).join("").split("#").length - 1;
    const first = count();
    for (let i = 0; i < 20; i++) sprayTick();
    expect(count()).toBeGreaterThan(first);
    pointerUp(at([6, 6]));
    expect(tab().history.undo.length).toBe(1);
  });

  it("commits typed text as pixels", () => {
    open(["....", "....", "...."]);
    ed().setTool("text");
    pointerDown(at([1, 1]));
    pointerUp(at([1, 1]));
    expect(ed().text).toEqual({ at: [1, 1], value: "" });
    updateText("hi", { w: 2, h: 2, data: new Uint8Array([1, 1, 1, 0]) });
    expect(ed().text?.value).toBe("hi");
    expect(art(activeCel(shownDoc(tab())))).toEqual(["....", ".##.", ".#.."]);
    expect(art(cel())).toEqual(["....", "....", "...."]);
    commitPending();
    expect(art(cel())).toEqual(["....", ".##.", ".#.."]);
    expect([ed().text, tab().history.undo[0].label]).toEqual([null, "Text"]);
  });
});

describe("colours", () => {
  it("picks with the eyedropper: left sets the foreground, right the background", () => {
    openForTest(fromRaw(opened([[bufFrom(["ab"], { a: GREEN, b: [9, 8, 7, 255] })]])));
    ed().setTool("picker");
    drag([[0, 0]]);
    expect(ed().fg).toEqual(GREEN);
    drag([[1, 0]], { button: 2 });
    expect(ed().bg).toEqual([9, 8, 7, 255]);
    expect(tab().history.undo.length).toBe(0);
  });
  it("picks with Alt+click while another tool is active, without drawing", () => {
    openForTest(fromRaw(opened([[solid(2, 1, GREEN)]])));
    drag([[0, 0]], { alt: true });
    expect(ed().fg).toEqual(GREEN);
    expect(getPx(cel(), 0, 0)).toEqual(GREEN);
    expect(tab().doc.dirty).toBe(false);
  });
  it("swaps the two colours", () => {
    ed().swapColors();
    expect([ed().fg, ed().bg]).toEqual([BLUE, RED]);
  });
});

describe("selection, clipboard and move", () => {
  it("selects by dragging; Shift adds, Alt takes away, a click clears", () => {
    open(["....", "....", "....", "...."]);
    ed().setTool("marquee");
    drag([[0, 0], [1, 1]]);
    expect(maskArt(tab().doc.selection, 4)).toEqual(["##..", "##..", "....", "...."]);
    drag([[3, 3], [3, 2]], { shift: true });
    expect(maskArt(tab().doc.selection, 4)).toEqual(["##..", "##..", "...#", "...#"]);
    drag([[0, 0], [3, 0]], { alt: true });
    expect(maskArt(tab().doc.selection, 4)).toEqual(["....", "##..", "...#", "...#"]);
    expect(tab().doc.dirty).toBe(false);
    drag([[2, 2]]);
    expect(tab().doc.selection).toBeNull();
    ed().undo();
    expect(maskArt(tab().doc.selection, 4)).toEqual(["....", "##..", "...#", "...#"]);
    ed().selectAll();
    expect(maskArt(tab().doc.selection, 4)).toEqual(["####", "####", "####", "####"]);
    ed().deselect();
    expect(tab().doc.selection).toBeNull();
  });

  it("selects with the lasso and the magic wand", () => {
    open(["##..", "##..", "....", "...."]);
    ed().setTool("wand");
    drag([[0, 0]]);
    expect(maskArt(tab().doc.selection, 4)).toEqual(["##..", "##..", "....", "...."]);
    ed().setTool("lasso");
    drag([[0, 0], [3, 0], [0, 3]]);
    expect(maskArt(tab().doc.selection, 4)).toEqual(["####", "###.", "##..", "#..."]);
  });

  it("draws only inside the selection and deletes it with Delete", () => {
    open(["####"]);
    ed().setTool("marquee");
    drag([[1, 0], [2, 0]]);
    ed().setTool("pencil");
    ed().setColor("fg", GREEN);
    drag([[0, 0], [3, 0]]);
    expect([0, 1, 2, 3].map((x) => getPx(cel(), x, 0)[1])).toEqual([0, 255, 255, 0]);
    ed().deleteSelection();
    expect(art(cel())).toEqual(["#..#"]);
  });

  it("moves the selected pixels; moving again does not damage what was under them", () => {
    openForTest(fromRaw(opened([[bufFrom(["ab.."], { a: RED, b: BLUE })]])));
    ed().setTool("marquee");
    drag([[0, 0], [0, 0], [0, 0]]);
    // a click clears; select the first pixel with a real drag
    pointerDown(at([0, 0]));
    pointerMove(at([1, 0]));
    pointerMove(at([0, 0]));
    pointerUp(at([0, 0]));
    expect(maskArt(tab().doc.selection, 4)).toEqual(["#..."]);
    ed().setTool("move");
    drag([[0, 0], [1, 0]]);
    expect(getPx(cel(), 1, 0)).toEqual(RED); // on top of the blue pixel
    expect(maskArt(tab().doc.selection, 4)).toEqual([".#.."]);
    drag([[1, 0], [3, 0]]);
    expect(art(cel())).toEqual([".#.#"]);
    expect(getPx(cel(), 1, 0)).toEqual(BLUE); // still there
    expect(getPx(cel(), 3, 0)).toEqual(RED);
    expect(maskArt(tab().doc.selection, 4)).toEqual(["...#"]);
    // each drag is one undo step, pixels and selection together
    ed().undo();
    expect(getPx(cel(), 1, 0)).toEqual(RED);
    expect(maskArt(tab().doc.selection, 4)).toEqual([".#.."]);
    ed().undo();
    expect(art(cel())).toEqual(["##.."]);
    expect(getPx(cel(), 1, 0)).toEqual(BLUE);
  });

  it("moves the whole layer when nothing is selected, wrapping in tiled mode", () => {
    open(["#..", "...", "..."]);
    ed().setTool("move");
    drag([[0, 0], [1, 1]]);
    expect(art(cel())).toEqual(["...", ".#.", "..."]);
    ed().setOptions({ tiled: true });
    drag([[1, 1], [3, 1]]);
    expect(art(cel())).toEqual(["...", "#..", "..."]);
    // a click without moving is not an undo step
    drag([[0, 0]]);
    expect(tab().history.undo.length).toBe(2);
  });

  it("copies, cuts and pastes; the pasted pixels can be dragged into place", () => {
    openForTest(fromRaw(opened([[bufFrom(["ab..", "...."], { a: RED, b: BLUE })]])));
    ed().paste();
    expect(tab().history.undo.length).toBe(0);
    ed().setTool("marquee");
    drag([[0, 0], [1, 0]]);
    ed().cut();
    expect(art(cel())).toEqual(["....", "...."]);
    expect([ed().clipboard!.buf.w, ed().clipboard!.x]).toEqual([2, 0]);
    ed().paste();
    expect(art(cel())).toEqual(["##..", "...."]);
    expect(ed().tool).toBe("move");
    expect(maskArt(tab().doc.selection, 4)).toEqual(["##..", "...."]);
    drag([[0, 0], [2, 1]]);
    expect(art(cel())).toEqual(["....", "..##"]);
    expect(getPx(cel(), 3, 1)).toEqual(BLUE);
    // paste again into another texture: the clipboard is shared between tabs
    open(["....", "...."], "block/other");
    ed().paste();
    expect(art(cel())).toEqual(["##..", "...."]);
    // copy alone changes nothing
    const steps = tab().history.undo.length;
    expect(ed().copy()).toBe(true);
    expect(tab().history.undo.length).toBe(steps);
  });
});

describe("layers through the store", () => {
  it("adds, reorders and deletes as undo steps; deleting a drawn layer asks first", () => {
    open(["#."]);
    ed().addLayer();
    expect(tab().doc.layers.map((l) => l.name)).toEqual(["Base", "Layer 2"]);
    ed().setColor("fg", GREEN);
    drag([[1, 0]]);
    ed().moveLayer(1, -1);
    expect(tab().doc.layers.map((l) => l.name)).toEqual(["Layer 2", "Base"]);
    ed().deleteLayer(0);
    expect(useApp.getState().modal?.title).toMatch(/Delete the layer/);
    answer("Cancel");
    expect(tab().doc.layers.length).toBe(2);
    ed().deleteLayer(0);
    answer("Delete layer");
    expect(tab().doc.layers.map((l) => l.name)).toEqual(["Base"]);
    ed().undo();
    expect(tab().doc.layers.map((l) => l.name)).toEqual(["Layer 2", "Base"]);
    expect(getPx(tab().doc.frames[0].cels[0], 1, 0)).toEqual(GREEN);
    // the last layer stays
    ed().undo();
    ed().undo();
    ed().undo();
    expect(tab().doc.layers.map((l) => l.name)).toEqual(["Base"]);
    ed().deleteLayer(0);
    expect(useApp.getState().modal).toBeNull();
    expect(tab().doc.layers.length).toBe(1);
  });

  it("an empty layer is deleted without a question; a lock is not an unsaved change", () => {
    open(["#."]);
    ed().addLayer();
    ed().undo();
    expect(tab().doc.layers.length).toBe(1);
    ed().redo();
    ed().deleteLayer(1);
    expect(useApp.getState().modal).toBeNull();
    expect(tab().doc.layers.length).toBe(1);
    const t = open([".."], "block/locks");
    ed().patchLayer(0, { locked: true });
    expect([tab().doc.layers[0].locked, tab().doc.dirty]).toEqual([true, false]);
    ed().patchLayer(0, { opacity: 40 });
    expect(tab().doc.dirty).toBe(true);
    expect(t.id).toBe(tab().id);
  });
});

describe("saving and closing", () => {
  it("saves the document's own path with raw pixels and clears the unsaved mark", async () => {
    open(["...."], "block/first");
    drag([[0, 0]]);
    open(["...."], "block/second");
    drag([[3, 0]]);
    const first = ed().tabs[0];
    // saving the tab that is NOT on screen must still write its own texture
    expect(await ed().save(first.id)).toBe(true);
    expect(rust.editorSave).toHaveBeenCalledTimes(1);
    const [path, doc, flat] = rust.editorSave.mock.calls[0];
    expect(path).toBe("block/first");
    expect([...base64ToBytes(flat)]).toEqual([...flatStrip(first.doc).data]);
    expect([...base64ToBytes(doc.frames[0].cels[0])].slice(0, 4)).toEqual(RED);
    expect(doc.layers).toEqual([{ name: "Base", visible: true, locked: false, opacity: 100 }]);
    expect(ed().tabs.map((t) => t.doc.dirty)).toEqual([false, true]);
    expect(rust.loadTextures).toHaveBeenCalled();
    expect(useApp.getState().modal).toBeNull(); // no success popup
    expect(useApp.getState().status).toBe("Saved first.png to the pack");
  });

  it("keeps the unsaved mark and the tab when saving fails", async () => {
    open(["."]);
    drag([[0, 0]]);
    rust.editorSave.mockRejectedValue({ kind: "io", message: "The disk is full.", hint: "Free some space." });
    expect(await ed().save()).toBe(false);
    expect(tab().doc.dirty).toBe(true);
    expect(useApp.getState().modal?.text).toBe("The disk is full.");
    expect(useApp.getState().modal?.hint).toBe("Free some space.");
  });

  it("refuses to save into a different pack than the one the texture came from", async () => {
    open(["."]);
    drag([[0, 0]]);
    useApp.setState({ pack: { ...PACK, dir: "/other" } as PackState });
    expect(await ed().save()).toBe(false);
    expect(rust.editorSave).not.toHaveBeenCalled();
    expect(tab().doc.dirty).toBe(true);
    expect(useApp.getState().modal?.hint).toMatch(/\/pack/);
  });

  it("closes a clean tab at once and asks Save / Discard / Cancel for an edited one", async () => {
    const clean = open(["."], "block/clean");
    expect(await ed().closeTab(clean.id)).toBe(true);
    expect(ed().tabs.length).toBe(0);

    const t = open(["."], "block/edited");
    drag([[0, 0]]);
    // Cancel: nothing happens
    let closing = ed().closeTab(t.id);
    expect(useApp.getState().modal?.title).toBe("Save changes to edited.png?");
    expect(useApp.getState().modal?.buttons.map((b) => b.label)).toEqual(["Cancel", "Discard", "Save"]);
    answer("Cancel");
    expect(await closing).toBe(false);
    expect([ed().tabs.length, tab().doc.dirty]).toEqual([1, true]);
    // Escape (the question is closed without a button) is Cancel too
    closing = ed().closeTab(t.id);
    useApp.getState().closeModal();
    expect(await closing).toBe(false);
    expect(ed().tabs.length).toBe(1);
    // Save: written, then closed
    closing = ed().closeTab(t.id);
    answer("Save");
    expect(await closing).toBe(true);
    expect(rust.editorSave.mock.calls[0][0]).toBe("block/edited");
    expect(ed().tabs.length).toBe(0);
  });

  it("discards only when told to, and keeps the tab when the save fails", async () => {
    const t = open(["."]);
    drag([[0, 0]]);
    rust.editorSave.mockRejectedValue({ message: "Read-only folder." });
    let closing = ed().closeTab(t.id);
    answer("Save");
    expect(await closing).toBe(false);
    expect([ed().tabs.length, tab().doc.dirty]).toEqual([1, true]);
    useApp.getState().closeModal();
    closing = ed().closeTab(t.id);
    answer("Discard");
    expect(await closing).toBe(true);
    expect(ed().tabs.length).toBe(0);
    expect(rust.editorSave).toHaveBeenCalledTimes(1);
  });

  it("finishes a half-made shape before saving, so it is not lost", async () => {
    open(["...", "...", "..."]);
    ed().setTool("polygon");
    pointerDown(at([0, 0]));
    pointerUp(at([0, 0]));
    pointerDown(at([2, 0]));
    pointerUp(at([2, 0]));
    expect(await ed().save()).toBe(true);
    expect([...base64ToBytes(rust.editorSave.mock.calls[0][2])].slice(0, 4)).toEqual(RED);
    expect(tab().doc.dirty).toBe(false);
  });

  it("asks before the pack is closed and before another pack is opened", async () => {
    open(["."], "block/a");
    drag([[0, 0]]);
    open(["."], "block/b");
    drag([[0, 0]]);
    // closing the pack: Cancel keeps everything
    let leaving = useApp.getState().closePack();
    expect(useApp.getState().modal?.title).toBe("Save changes to 2 textures?");
    expect(useApp.getState().modal?.text).toMatch(/a\.png\nb\.png/);
    answer("Cancel");
    expect(await leaving).toBe(false);
    expect(rust.closePack).not.toHaveBeenCalled();
    expect([ed().tabs.length, useApp.getState().pack?.dir]).toEqual([2, "/pack"]);
    // opening another pack: the question comes before Rust switches packs
    const openOther = vi.fn(async () => ({ ...PACK, dir: "/other", vanilla_ready: true }) as PackState);
    const entering = useApp.getState().enterPack(openOther);
    expect(openOther).not.toHaveBeenCalled();
    answer("Save all");
    expect(await entering).toBe(true);
    expect(rust.editorSave.mock.calls.map((c) => c[0])).toEqual(["block/a", "block/b"]);
    expect(rust.editorSave.mock.invocationCallOrder[1]).toBeLessThan(openOther.mock.invocationCallOrder[0]);
    expect([ed().tabs.length, useApp.getState().pack?.dir]).toEqual([0, "/other"]);
    // closing with nothing unsaved asks nothing
    leaving = useApp.getState().closePack();
    expect(await leaving).toBe(true);
    expect(useApp.getState().pack).toBeNull();
  });

  it("opens a texture once, on its own tab", async () => {
    rust.editorOpen.mockResolvedValue(opened([[bufFrom(["#."])]], { path: "block/stone", origin: "vanilla" }));
    useApp.setState({ screen: "textures" });
    await ed().openTexture("block/stone");
    await ed().openTexture("block/stone");
    expect(rust.editorOpen).toHaveBeenCalledTimes(1);
    expect([ed().tabs.length, tab().doc.path, tab().packDir, useApp.getState().screen]).toEqual([1, "block/stone", "/pack", "editor"]);
    expect(tab().doc.palette).toEqual(["#ff0000"]);
    rust.editorOpen.mockRejectedValue({ message: "There is no texture called block/nope in the pack or in the game." });
    await ed().openTexture("block/nope");
    expect(ed().tabs.length).toBe(1);
    expect(useApp.getState().modal?.title).toBe("The texture could not be opened");
  });
});

describe("files changed by another program", () => {
  it("reloads a tab without unsaved edits and keeps the edits of one that has some", async () => {
    useApp.setState({ rows: [row("block/clean", 1), row("block/edited", 1)] });
    const clean = open(["#."], "block/clean");
    const edited = open([".."], "block/edited");
    drag([[1, 0]]);
    await ed().syncWithDisk();
    expect(rust.editorOpen).not.toHaveBeenCalled();

    useApp.setState({ rows: [row("block/clean", 2), row("block/edited", 2)] });
    rust.editorOpen.mockResolvedValue(opened([[bufFrom([".#"], { "#": GREEN })]], { path: "block/clean" }));
    await ed().syncWithDisk();
    expect(rust.editorOpen.mock.calls.map((c) => c[0])).toEqual(["block/clean"]);
    const [a, b] = ed().tabs;
    expect([a.id, b.id]).toEqual([clean.id, edited.id]);
    expect(getPx(activeCel(a.doc), 1, 0)).toEqual(GREEN);
    expect(a.doc.dirty).toBe(false);
    expect(art(activeCel(b.doc))).toEqual([".#"]);
    expect(b.doc.dirty).toBe(true);
    expect(useApp.getState().toasts.some((t) => t.kind === "warn" && /edited\.png was changed by another program/.test(t.text))).toBe(true);
    // told once, not on every later refresh
    const toasts = useApp.getState().toasts.length;
    await ed().syncWithDisk();
    expect(useApp.getState().toasts.length).toBe(toasts);
    expect(rust.editorOpen).toHaveBeenCalledTimes(1);
  });

  it("does not take its own save for a change from outside", async () => {
    useApp.setState({ rows: [row("block/mine", 1)] });
    open(["."], "block/mine");
    drag([[0, 0]]);
    rust.loadTextures.mockResolvedValue({ rows: [row("block/mine", 5)], summary: null });
    await ed().save();
    await ed().syncWithDisk();
    await tick();
    expect(rust.editorOpen).not.toHaveBeenCalled();
    expect(useApp.getState().toasts.every((t) => t.kind === "ok")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  activeCel, addLayer, deleteLayer, duplicateLayer, editBlock, flatStrip, flatten, frameTicks, fromRaw, isAnimated,
  layerHasPixels, moveLayer, patchLayer, pickColor, sameMask, setCel, structureOf, targetLabel, toRaw, uniqueLayerName,
  viewLayers, withStructure,
} from "./doc";
import { base64ToBytes, bytesToBase64, composite, getPx, newBuf, setPx } from "./pixels";
import { art, BLUE, bufFrom, CLEAR, docFrom, GREEN, opened, RED, solid } from "./testutil";

describe("opening", () => {
  it("builds layers, frames and state from what Rust sends", () => {
    const a = bufFrom(["#.", ".."]);
    const b = bufFrom(["..", ".#"], { "#": BLUE });
    const doc = fromRaw(opened([[a, b], [b, a]], { path: "block/prismarine", layerNames: ["Base", "Highlights"] }));
    expect([doc.width, doc.height, doc.layers.length, doc.frames.length]).toEqual([2, 2, 2, 2]);
    expect(doc.layers.map((l) => [l.id, l.name])).toEqual([[1, "Base"], [2, "Highlights"]]);
    expect(doc.activeLayer).toBe(1);
    expect([doc.frameIndex, doc.dirty, doc.selection, doc.nextLayerId]).toEqual([0, false, null, 3]);
    expect(getPx(doc.frames[0].cels[0], 0, 0)).toEqual(RED);
    expect(getPx(doc.frames[1].cels[0], 1, 1)).toEqual(BLUE);
    expect(isAnimated(doc)).toBe(true);
    expect(frameTicks(doc)).toBe(2);
    expect(targetLabel(doc)).toBe("textures/block/prismarine.png + prismarine.png.mcmeta");
    expect(targetLabel(docFrom(["#"]))).toBe("textures/block/test.png");
  });

  it("refuses pixel data of the wrong size", () => {
    const o = opened([[newBuf(2, 2)]]);
    o.doc.frames[0].cels[0] = bytesToBase64(new Uint8Array(8));
    expect(() => fromRaw(o)).toThrow();
  });

  it("makes the reference from the first vanilla frame, enlarged with hard pixels", () => {
    // a 2×4 vanilla strip (two 2×2 frames); the document is 4×4
    const strip = newBuf(2, 4);
    setPx(strip, 0, 0, RED);
    setPx(strip, 1, 1, BLUE);
    setPx(strip, 0, 2, GREEN); // second frame: must not appear
    const doc = fromRaw(opened([[newBuf(4, 4)]], {
      vanilla: { width: 2, height: 4, rgba: bytesToBase64(strip.data) }, vanilla_frames: 2,
    }));
    expect([doc.vanilla!.w, doc.vanilla!.h]).toEqual([2, 2]);
    expect([doc.reference!.w, doc.reference!.h]).toEqual([4, 4]);
    expect(art(doc.reference!)).toEqual(["##..", "##..", "..##", "..##"]);
    expect(getPx(doc.reference!, 1, 1)).toEqual(RED);
    expect(getPx(doc.reference!, 3, 2)).toEqual(BLUE);
    expect(doc.referenceVisible).toBe(false);
    // no vanilla texture: no reference
    expect(fromRaw(opened([[newBuf(4, 4)]])).reference).toBeNull();
  });
});

describe("flatten and save data", () => {
  it("never puts the reference into the texture, even when it is shown", () => {
    const vanilla = solid(2, 2, GREEN);
    let doc = fromRaw(opened([[bufFrom(["#.", ".."])]], { vanilla: { width: 2, height: 2, rgba: bytesToBase64(vanilla.data) }, vanilla_frames: 1 }));
    doc = { ...doc, referenceVisible: true };
    expect(art(flatten(doc))).toEqual(["#.", ".."]);
    expect(getPx(flatten(doc), 1, 1)).toEqual(CLEAR);
    // the canvas does show it: at 30%, under the drawing
    const view = viewLayers(doc);
    expect(view.length).toBe(2);
    expect([view[0].opacity, view[0].buf]).toEqual([30, doc.reference]);
    const shown = composite(2, 2, view);
    expect(getPx(shown, 0, 0)).toEqual(RED);
    expect(getPx(shown, 1, 1)).toEqual([0, 255, 0, 77]);
    expect(viewLayers({ ...doc, referenceVisible: false }).length).toBe(1);
    expect(toRaw(doc).layers.map((l) => l.name)).toEqual(["Base"]);
  });

  it("composites layers with visibility and opacity", () => {
    let doc = fromRaw(opened([[solid(2, 1, BLUE), bufFrom(["#."])]]));
    expect(getPx(flatten(doc), 0, 0)).toEqual(RED);
    expect(getPx(flatten(doc), 1, 0)).toEqual(BLUE);
    doc = patchLayer(doc, 1, { opacity: 50 });
    expect(getPx(flatten(doc), 0, 0)).toEqual([128, 0, 128, 255]);
    doc = patchLayer(doc, 1, { visible: false });
    expect(getPx(flatten(doc), 0, 0)).toEqual(BLUE);
    expect(doc.dirty).toBe(true);
  });

  it("keeps a single plain layer untouched, including colours under full transparency", () => {
    const b = newBuf(2, 1);
    setPx(b, 0, 0, [200, 100, 50, 0]);
    setPx(b, 1, 0, [201, 101, 51, 1]);
    const doc = fromRaw(opened([[b]]));
    expect([...flatten(doc).data]).toEqual([200, 100, 50, 0, 201, 101, 51, 1]);
    expect(flatten(doc)).not.toBe(activeCel(doc));
  });

  it("stacks every frame for the PNG and sends raw RGBA back", () => {
    const doc = fromRaw(opened([[bufFrom(["#."])], [bufFrom([".#"], { "#": BLUE })]]));
    const strip = flatStrip(doc);
    expect([strip.w, strip.h]).toEqual([2, 2]);
    expect(art(strip)).toEqual(["#.", ".#"]);
    expect(getPx(strip, 1, 1)).toEqual(BLUE);
    const raw = toRaw(doc);
    expect([raw.width, raw.height, raw.frames.length]).toEqual([2, 1, 2]);
    expect([...base64ToBytes(raw.frames[1].cels[0])]).toEqual([0, 0, 0, 0, 0, 0, 255, 255]);
    expect(raw.animation?.frametime).toBe(2);
    // a round trip gives the same document
    const again = fromRaw({ path: doc.path, origin: "work_file", doc: raw, vanilla: null, vanilla_frames: 0 });
    expect(again.frames.map((f) => [...f.cels[0].data])).toEqual(doc.frames.map((f) => [...f.cels[0].data]));
  });
});

describe("layers", () => {
  const two = () => fromRaw(opened([[bufFrom(["#."]), bufFrom([".#"], { "#": BLUE })], [bufFrom([".."]), bufFrom(["##"], { "#": GREEN })]], { layerNames: ["Base", "Top"] }));

  it("adds an empty layer above the active one in every frame", () => {
    let doc = { ...two(), activeLayer: 0 };
    doc = addLayer(doc);
    expect(doc.layers.map((l) => l.name)).toEqual(["Base", "Layer 3", "Top"]);
    expect(doc.layers[1].id).toBe(3);
    expect([doc.activeLayer, doc.dirty, doc.nextLayerId]).toEqual([1, true, 4]);
    expect(doc.frames.map((f) => f.cels.length)).toEqual([3, 3]);
    expect(art(doc.frames[1].cels[1])).toEqual([".."]);
    expect(getPx(doc.frames[1].cels[2], 0, 0)).toEqual(GREEN);
    expect(layerHasPixels(doc, 1)).toBe(false);
    expect(layerHasPixels(doc, 2)).toBe(true);
  });

  it("duplicates with its pixels, as an independent copy", () => {
    const doc = duplicateLayer(two(), 0);
    expect(doc.layers.map((l) => l.name)).toEqual(["Base", "Base copy", "Top"]);
    expect(doc.activeLayer).toBe(1);
    expect(getPx(doc.frames[0].cels[1], 0, 0)).toEqual(RED);
    expect(doc.frames[0].cels[1]).not.toBe(doc.frames[0].cels[0]);
    expect(uniqueLayerName(doc, "Base copy")).toBe("Base copy 2");
  });

  it("deletes a layer but never the last one", () => {
    let doc = deleteLayer(two(), 1);
    expect(doc.layers.map((l) => l.name)).toEqual(["Base"]);
    expect(doc.frames.map((f) => f.cels.length)).toEqual([1, 1]);
    expect(doc.activeLayer).toBe(0);
    const same = deleteLayer(doc, 0);
    expect(same).toBe(doc);
    doc = deleteLayer({ ...two(), activeLayer: 1 }, 0);
    expect([doc.layers[0].name, doc.activeLayer]).toEqual(["Top", 0]);
  });

  it("reorders layers and their pixels together", () => {
    const doc = moveLayer(two(), 0, 1);
    expect(doc.layers.map((l) => l.name)).toEqual(["Top", "Base"]);
    expect(getPx(doc.frames[0].cels[1], 0, 0)).toEqual(RED);
    expect(getPx(doc.frames[1].cels[0], 0, 0)).toEqual(GREEN);
    expect(doc.activeLayer).toBe(0); // "Top" was active and is now at index 0
    expect(moveLayer(doc, 1, 1)).toBe(doc);
    expect(moveLayer(doc, 0, -1)).toBe(doc);
  });

  it("renames, locks and hides; a locked or hidden layer refuses edits", () => {
    let doc = two();
    expect(editBlock(doc)).toBeNull();
    doc = patchLayer(doc, 1, { name: "  Shine  " });
    expect(doc.layers[1].name).toBe("Shine");
    expect(patchLayer(doc, 1, { name: "   " }).layers[1].name).toBe("Shine");
    expect(patchLayer(doc, 1, { opacity: 100 })).toBe(doc);
    expect(patchLayer(doc, 1, { opacity: 250 }).layers[1].opacity).toBe(100);
    expect(editBlock(patchLayer(doc, 1, { locked: true }))).toMatch(/locked/);
    expect(editBlock(patchLayer(doc, 1, { visible: false }))).toMatch(/hidden/);
  });

  it("restores a layer list for undo", () => {
    const before = two();
    const after = deleteLayer(before, 0);
    const back = withStructure(after, structureOf(before));
    expect(back.layers).toBe(before.layers);
    expect(back.frames[1].cels[1]).toBe(before.frames[1].cels[1]);
    expect(back.activeLayer).toBe(before.activeLayer);
  });
});

describe("small helpers", () => {
  it("replaces one image without touching the others", () => {
    const doc = docFrom(["#."]);
    const next = setCel(doc, 0, 0, bufFrom([".#"]));
    expect(art(activeCel(next))).toEqual([".#"]);
    expect(art(activeCel(doc))).toEqual(["#."]);
  });
  it("picks the colour of the drawing, then of the shown reference", () => {
    const vanilla = solid(2, 1, GREEN);
    const doc = fromRaw(opened([[bufFrom(["#."])]], { vanilla: { width: 2, height: 1, rgba: bytesToBase64(vanilla.data) }, vanilla_frames: 1 }));
    expect(pickColor(doc, 0, 0)).toEqual(RED);
    expect(pickColor(doc, 1, 0)).toEqual(CLEAR);
    expect(pickColor({ ...doc, referenceVisible: true }, 1, 0)).toEqual(GREEN);
    expect(pickColor(doc, 5, 0)).toBeNull();
  });
  it("compares masks", () => {
    expect(sameMask(null, null)).toBe(true);
    expect(sameMask(new Uint8Array([1, 0]), new Uint8Array([1, 0]))).toBe(true);
    expect(sameMask(new Uint8Array([1, 0]), new Uint8Array([0, 1]))).toBe(false);
    expect(sameMask(new Uint8Array([1, 0]), null)).toBe(false);
  });
});

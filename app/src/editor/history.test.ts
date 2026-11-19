import { describe, expect, it } from "vitest";
import { activeCel, addLayer, deleteLayer, duplicateLayer, fromRaw, moveLayer, patchLayer, setCel, type EditorDoc } from "./doc";
import {
  applyCommand, applyPatch, diffPatch, editCommand, emptyHistory, HISTORY_CAP, push, pushMerged, stepRedo, stepUndo, structureCommand,
  type Command, type History,
} from "./history";
import { cloneBuf, getPx, setPx } from "./pixels";
import { art, BLUE, bufFrom, docFrom, GREEN, opened, RED } from "./testutil";

describe("patches", () => {
  it("stores only the rectangle that changed", () => {
    const before = bufFrom(["....", "....", "...."]);
    const after = cloneBuf(before);
    setPx(after, 1, 1, RED);
    setPx(after, 2, 2, BLUE);
    const p = diffPatch(before, after)!;
    expect([p.x, p.y, p.w, p.h]).toEqual([1, 1, 2, 2]);
    expect(p.before.length).toBe(16);
    expect([...p.before]).toEqual(new Array(16).fill(0));
    expect([...p.after]).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255]);
    expect(diffPatch(before, cloneBuf(before))).toBeNull();
    expect(() => diffPatch(before, bufFrom(["."]))).toThrow();
  });

  it("sees a change of colour under the same alpha, and of alpha alone", () => {
    const before = bufFrom(["#"]);
    expect(diffPatch(before, bufFrom(["#"], { "#": BLUE }))).not.toBeNull();
    expect(diffPatch(before, bufFrom(["#"], { "#": [255, 0, 0, 254] }))).not.toBeNull();
  });

  it("applies either side without changing the source", () => {
    const before = bufFrom(["#...", "....", "...."]);
    const after = cloneBuf(before);
    setPx(after, 3, 2, GREEN);
    setPx(after, 0, 0, BLUE);
    const p = diffPatch(before, after)!;
    const redone = applyPatch(before, p, "after");
    expect([...redone.data]).toEqual([...after.data]);
    expect(getPx(before, 0, 0)).toEqual(RED);
    const undone = applyPatch(after, p, "before");
    expect([...undone.data]).toEqual([...before.data]);
  });
});

/** A tiny editor: document + history, driven the way the store drives them. */
function session(start: EditorDoc) {
  let doc = start;
  let history: History = emptyHistory();
  return {
    get doc() { return doc; },
    get history() { return history; },
    paint(x: number, y: number, c = RED, label = "Pencil") {
      const cel = cloneBuf(activeCel(doc));
      setPx(cel, x, y, c);
      const cmd = editCommand(label, doc, { cel })!;
      history = push(history, cmd);
      doc = setCel(doc, doc.frameIndex, doc.activeLayer, cel);
    },
    structure(label: string, fn: (d: EditorDoc) => EditorDoc) {
      const next = fn(doc);
      history = push(history, structureCommand(label, doc, next));
      doc = next;
    },
    undo() {
      const s = stepUndo(history);
      if (!s) return false;
      history = s.history;
      doc = applyCommand(doc, s.command, "undo");
      return true;
    },
    redo() {
      const s = stepRedo(history);
      if (!s) return false;
      history = s.history;
      doc = applyCommand(doc, s.command, "redo");
      return true;
    },
  };
}

describe("undo and redo", () => {
  it("walks pixel edits back and forth exactly", () => {
    const s = session(docFrom(["...", "..."]));
    s.paint(0, 0);
    s.paint(2, 1, BLUE);
    expect(art(activeCel(s.doc))).toEqual(["#..", "..#"]);
    expect(s.undo()).toBe(true);
    expect(art(activeCel(s.doc))).toEqual(["#..", "..."]);
    expect(s.undo()).toBe(true);
    expect(art(activeCel(s.doc))).toEqual(["...", "..."]);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(true);
    expect(s.redo()).toBe(true);
    expect(getPx(activeCel(s.doc), 2, 1)).toEqual(BLUE);
    expect(s.redo()).toBe(false);
  });

  it("drops the redo list after a new edit", () => {
    const s = session(docFrom(["..."]));
    s.paint(0, 0);
    s.paint(1, 0);
    s.undo();
    s.paint(2, 0);
    expect(s.history.redo.length).toBe(0);
    expect(s.redo()).toBe(false);
    expect(art(activeCel(s.doc))).toEqual(["#.#"]);
  });

  it("caps the stack and keeps the newest commands", () => {
    let h = emptyHistory();
    const cmd = (n: number): Command => ({ label: String(n), cels: [] });
    for (let i = 0; i < HISTORY_CAP + 25; i++) h = push(h, cmd(i));
    expect(h.undo.length).toBe(HISTORY_CAP);
    expect(h.undo[0].label).toBe("25");
    expect(h.undo[h.undo.length - 1].label).toBe(String(HISTORY_CAP + 24));
    expect(push(emptyHistory(), cmd(1), 1).undo.length).toBe(1);
  });

  it("makes no command when nothing changed", () => {
    const doc = docFrom(["#."]);
    expect(editCommand("Pencil", doc, { cel: cloneBuf(activeCel(doc)) })).toBeNull();
    expect(editCommand("Pencil", doc, { cel: activeCel(doc) })).toBeNull();
    expect(editCommand("Deselect", doc, { selection: null })).toBeNull();
    expect(editCommand("Nothing", doc, {})).toBeNull();
  });

  it("undoes selection changes, alone or together with pixels", () => {
    let doc = docFrom(["#."]);
    const sel = new Uint8Array([1, 0]);
    const select = editCommand("Rectangle select", doc, { selection: sel })!;
    expect(select.cels.length).toBe(0);
    doc = applyCommand(doc, select, "redo");
    expect(doc.selection).toBe(sel);
    // a move changes both
    const moved = bufFrom([".#"]);
    const move = editCommand("Move", doc, { cel: moved, selection: new Uint8Array([0, 1]) })!;
    doc = applyCommand(setCel(doc, 0, 0, moved), { ...move, cels: [] }, "redo");
    expect([...doc.selection!]).toEqual([0, 1]);
    doc = applyCommand(doc, move, "undo");
    expect(art(activeCel(doc))).toEqual(["#."]);
    expect(doc.selection).toBe(sel);
    doc = applyCommand(doc, select, "undo");
    expect(doc.selection).toBeNull();
  });

  it("puts a patch on the right frame and layer even after the layers moved", () => {
    const start = fromRaw(opened([[bufFrom([".."]), bufFrom([".."])], [bufFrom([".."]), bufFrom([".."])]], { layerNames: ["Base", "Top"] }));
    const s = session({ ...start, frameIndex: 1, activeLayer: 1 });
    s.paint(1, 0);
    expect(s.history.undo[0].cels[0]).toMatchObject({ frame: 1, layerId: 2 });
    s.structure("Move layer down", (d) => moveLayer(d, 1, -1));
    expect(s.doc.layers.map((l) => l.name)).toEqual(["Top", "Base"]);
    s.undo(); // the reorder
    s.undo(); // the pixel
    expect(art(s.doc.frames[1].cels[1])).toEqual([".."]);
    s.redo();
    expect(art(s.doc.frames[1].cels[1])).toEqual([".#"]);
    expect(art(s.doc.frames[0].cels[1])).toEqual([".."]);
  });

  it("undoes add, duplicate, delete and reorder of layers", () => {
    const s = session(docFrom(["#."]));
    s.structure("Add layer", (d) => addLayer(d));
    s.paint(1, 0, BLUE);
    s.structure("Duplicate layer", (d) => duplicateLayer(d, 1));
    s.structure("Move layer down", (d) => moveLayer(d, 2, -2));
    s.structure("Delete layer", (d) => deleteLayer(d, 1));
    expect(s.doc.layers.map((l) => l.name)).toEqual(["Layer 2 copy", "Layer 2"]);
    const names: string[][] = [];
    while (s.undo()) names.push(s.doc.layers.map((l) => l.name));
    expect(names).toEqual([
      ["Layer 2 copy", "Base", "Layer 2"],
      ["Base", "Layer 2", "Layer 2 copy"],
      ["Base", "Layer 2"],
      ["Base", "Layer 2"], // the pixel edit
      ["Base"],
    ]);
    expect(s.doc.frames[0].cels.length).toBe(1);
    expect(art(s.doc.frames[0].cels[0])).toEqual(["#."]);
    // and all the way forward again
    while (s.redo()) { /* keep going */ }
    expect(s.doc.layers.map((l) => l.name)).toEqual(["Layer 2 copy", "Layer 2"]);
    expect(getPx(s.doc.frames[0].cels[0], 1, 0)).toEqual(BLUE);
    expect(getPx(s.doc.frames[0].cels[1], 1, 0)).toEqual(BLUE);
    expect(s.doc.layers.length).toBe(s.doc.frames[0].cels.length);
  });
});

describe("review fixes: layer properties as undo steps", () => {
  it("folds steps with the same key into one, from the first start to the last end", () => {
    const d0 = docFrom(["#."]);
    const d1 = patchLayer(d0, 0, { opacity: 80 });
    const d2 = patchLayer(d1, 0, { opacity: 55 });
    const d3 = patchLayer(d2, 0, { opacity: 20 });
    const step = (a: EditorDoc, b: EditorDoc, key?: string): Command => ({ ...structureCommand("Layer opacity", a, b), mergeKey: key });
    let h = push(emptyHistory(), step(d0, d1, "opacity:1"));
    h = pushMerged(h, step(d1, d2, "opacity:1"));
    h = pushMerged(h, step(d2, d3, "opacity:1"));
    expect(h.undo.length).toBe(1);
    expect(applyCommand(d3, h.undo[0], "undo").layers[0].opacity).toBe(100);
    expect(applyCommand(d0, h.undo[0], "redo").layers[0].opacity).toBe(20);
    // another key, no key, or something that can be redone: a step of its own
    expect(pushMerged(h, step(d3, d0, "opacity:2")).undo.length).toBe(2);
    expect(pushMerged(h, step(d3, d0)).undo.length).toBe(2);
    const undone = stepUndo(push(h, step(d3, d0, "opacity:1")))!.history;
    expect(pushMerged(undone, step(d3, d2, "opacity:1")).undo.length).toBe(2);
    expect(pushMerged(emptyHistory(), step(d0, d1, "opacity:1")).undo.length).toBe(1);
  });

  it("undoes a layer change in order with the layer steps around it, without losing it", () => {
    // the case from the review: add a layer, set Base to 40%, delete the layer, set Base to 80% and rename it
    let doc = docFrom(["#."]);
    let h = emptyHistory();
    const run = (label: string, fn: (d: EditorDoc) => EditorDoc) => {
      const next = fn(doc);
      h = push(h, structureCommand(label, doc, next));
      doc = next;
    };
    run("Add layer", (d) => addLayer(d));
    run("Layer opacity", (d) => patchLayer(d, 0, { opacity: 40 }));
    run("Delete layer", (d) => deleteLayer(d, 1));
    run("Layer opacity", (d) => patchLayer(d, 0, { opacity: 80 }));
    run("Rename layer", (d) => patchLayer(d, 0, { name: "Stone" }));
    const seen: [string, number, number][] = [];
    for (let s = stepUndo(h); s; s = stepUndo(h)) {
      doc = applyCommand(doc, s.command, "undo");
      h = s.history;
      seen.push([doc.layers[0].name, doc.layers[0].opacity, doc.layers.length]);
    }
    expect(seen).toEqual([["Base", 80, 1], ["Base", 40, 1], ["Base", 40, 2], ["Base", 100, 2], ["Base", 100, 1]]);
    for (let s = stepRedo(h); s; s = stepRedo(h)) {
      doc = applyCommand(doc, s.command, "redo");
      h = s.history;
    }
    expect([doc.layers[0].name, doc.layers[0].opacity, doc.layers.length]).toEqual(["Stone", 80, 1]);
  });
});

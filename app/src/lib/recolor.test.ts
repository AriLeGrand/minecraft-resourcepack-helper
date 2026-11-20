import { describe, expect, it } from "vitest";
import type { TextureRow } from "./api";
import { addToFamily, changesNothing, familyOf, NO_ADJUST, pickTextures, splitUnsaved, writeSummary } from "./recolor";

const row = (path: string, extra = false, mine = false): TextureRow => ({
  path, category: path.startsWith("block/") ? "blocks" : "items", width: 16, height: 16, animated: false, frames: 1,
  has_thumb: true, status: mine ? "done" : "todo", wrong_size: false, renamed: false, extra,
  mine: mine ? { path, width: 16, height: 16, modified_ms: 1, has_mcmeta: false, animated: false, frames: 1, file_size: 10 } : null,
});

const ALL = [
  "block/oak_planks", "block/spruce_planks", "block/birch_planks", "block/bamboo_planks", "block/crimson_planks",
  "block/oak_log", "block/oak_log_top", "block/stripped_oak_log", "block/stripped_spruce_log", "block/spruce_log",
  "block/white_wool", "block/stone", "item/oak_boat", "item/spruce_boat", "block/cobblestone",
];

describe("picking textures", () => {
  const rows = [row("block/oak_planks"), row("block/spruce_planks"), row("item/oak_boat"), row("block/my_planks", true, true), row("block/old_planks", true)];
  it("by search and category", () => {
    expect(pickTextures(rows, "planks", "blocks").map((r) => r.path)).toEqual(["block/oak_planks", "block/spruce_planks", "block/my_planks"]);
    expect(pickTextures(rows, "oak", "all").map((r) => r.path)).toEqual(["block/oak_planks", "item/oak_boat"]);
    expect(pickTextures(rows, "", "items").map((r) => r.path)).toEqual(["item/oak_boat"]);
  });
  it("skips textures with unsaved changes", () => {
    const r = splitUnsaved(["a", "b", "c"], new Set(["b"]));
    expect(r.ok).toEqual(["a", "c"]);
    expect(r.skipped).toEqual([{ path: "b", reason: "it has unsaved changes in the editor: save or close it first" }]);
  });
});

describe("recolour", () => {
  it("knows when nothing changes", () => {
    expect(changesNothing({ kind: "adjust", ...NO_ADJUST })).toBe(true);
    expect(changesNothing({ kind: "adjust", ...NO_ADJUST, hue: 360 })).toBe(true);
    expect(changesNothing({ kind: "adjust", ...NO_ADJUST, contrast: 5 })).toBe(false);
    expect(changesNothing({ kind: "map", pairs: [{ from: "#AABBCC", to: "#aabbcc" }], tolerance: 0 })).toBe(true);
    expect(changesNothing({ kind: "map", pairs: [{ from: "#aabbcc", to: "#000000" }], tolerance: 0 })).toBe(false);
  });
  it("summarises a write", () => {
    const report = { stamp: 1, replaced: ["a"], created: ["b", "c"], created_mcmeta: [], failed: [{ path: "d", message: "x" }] };
    expect(writeSummary("Recoloured", report, 2)).toBe("Recoloured 3 textures, 1 earlier file is in the pack's trash, 2 skipped (unsaved in the editor), 1 failed.");
    expect(writeSummary("Made", { ...report, replaced: [], failed: [], created: ["b"] }, 0)).toBe("Made 1 texture.");
  });
});

describe("families for variants", () => {
  it("same last word, same number of words, same folder", () => {
    expect(familyOf("block/oak_planks", ALL)).toEqual(["block/bamboo_planks", "block/birch_planks", "block/crimson_planks", "block/spruce_planks"]);
    expect(familyOf("block/stripped_oak_log", ALL)).toEqual(["block/stripped_spruce_log"]);
    expect(familyOf("block/oak_log", ALL)).toEqual(["block/spruce_log"]);
    expect(familyOf("item/oak_boat", ALL)).toEqual(["item/spruce_boat"]);
  });
  it("falls back to the first word, and is empty for single words", () => {
    expect(familyOf("block/oak_log_top", ALL)).toEqual([]);
    expect(familyOf("block/white_wool", ALL)).toEqual([]);
    expect(familyOf("block/stone", ALL)).toEqual([]);
    expect(familyOf("block/oak_thing", ["block/oak_thing", "block/oak_other"])).toEqual(["block/oak_other"]);
  });
  it("adds typed names", () => {
    const list = ["block/spruce_planks"];
    expect(addToFamily(list, "birch_planks", ALL, "block/oak_planks").list).toEqual([...list, "block/birch_planks"]);
    expect(addToFamily(list, "block/stone.png", ALL, "block/oak_planks").list).toEqual([...list, "block/stone"]);
    expect(addToFamily(list, "spruce_planks", ALL, "block/oak_planks")).toEqual({ list, error: null });
    expect(addToFamily(list, "nothing", ALL, "block/oak_planks").error).toBe("No texture called nothing in this version.");
    expect(addToFamily(list, "oak_planks", ALL, "block/oak_planks").error).toBe("That is the texture the variants are made from.");
  });
});

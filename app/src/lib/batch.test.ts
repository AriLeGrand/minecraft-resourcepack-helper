import { describe, expect, it } from "vitest";
import type { BatchItemResult, BatchRow } from "./api";
import {
  checkAll, clashingTargets, countRows, effectiveStatus, initialChoices, planImport, resultSummary, setChecked, setFrames,
  setTarget,
} from "./batch";

let nextId = 0;
const row = (rel: string, extra: Partial<BatchRow> = {}): BatchRow => {
  const target = extra.target === undefined ? `block/${rel.replace(/\.png$/, "")}` : extra.target;
  return {
    id: nextId++, rel, source: `D:/in/${rel}`, target,
    candidates: target ? [{ path: target, in_pack: false }] : [],
    renamed_from: null, rule: "file_name", status: "new", duplicate: false, width: 32, height: 32,
    expected: [32, 32], wrong_size: false, has_mcmeta: false, strip_frames: null, frames_default: false,
    accept: true, problem: null,
    ...extra,
  };
};

function sample() {
  nextId = 0;
  return [
    row("stone.png"),
    row("dirt.png", { status: "replaces", candidates: [{ path: "block/dirt", in_pack: true }] }),
    row("sand.png", { status: "same", accept: false }),
    row("holiday.png", { target: null, status: "unknown", accept: false, rule: "none" }),
    row("button.png", {
      target: null, status: "ambiguous", accept: false,
      candidates: [{ path: "gui/sprites/widget/button", in_pack: true }, { path: "gui/sprites/recipe_book/button", in_pack: false }],
    }),
    row("a/creeper.png", { target: "entity/creeper/creeper", duplicate: true, accept: false }),
    row("b/creeper.png", { target: "entity/creeper/creeper", duplicate: true, accept: false }),
    row("water.png", { target: "block/water_still", strip_frames: 4, frames_default: true, height: 128 }),
    row("broken.png", { problem: "Not a PNG image this app can read.", accept: false }),
  ];
}

describe("batch review", () => {
  it("starts from Rust's suggestions", () => {
    const rows = sample();
    const c = initialChoices(rows);
    expect(rows.filter((r) => c[r.id].checked).map((r) => r.rel)).toEqual(["stone.png", "dirt.png", "water.png"]);
    expect(c[7].frames).toBe(true);
    const n = countRows(rows, c);
    expect(n).toMatchObject({ total: 9, new: 4, replaces: 1, same: 1, unknown: 2, ambiguous: 1, duplicates: 2, checked: 3 });
  });

  it("two files for one texture: ticking one unticks the other", () => {
    const rows = sample();
    let c = initialChoices(rows);
    expect(clashingTargets(rows, c)).toEqual(new Set(["entity/creeper/creeper"]));
    c = setChecked(rows, c, 5, true);
    expect([c[5].checked, c[6].checked]).toEqual([true, false]);
    c = setChecked(rows, c, 6, true);
    expect([c[5].checked, c[6].checked]).toEqual([false, true]);
  });

  it("unknown and unreadable rows cannot be ticked", () => {
    const rows = sample();
    const c = initialChoices(rows);
    expect(setChecked(rows, c, 3, true)[3].checked).toBe(false);
    expect(setChecked(rows, c, 8, true)[8].checked).toBe(false);
    expect(setChecked(rows, c, 4, true)[4].checked).toBe(false); // ambiguous, nothing picked yet
  });

  it("an ambiguous row is ticked once a texture is picked, and shows what it will do", () => {
    const rows = sample();
    let c = initialChoices(rows);
    expect(effectiveStatus(rows[4], c[4])).toBe("ambiguous");
    c = setTarget(rows, c, 4, "gui/sprites/widget/button");
    expect(c[4]).toMatchObject({ target: "gui/sprites/widget/button", checked: true });
    expect(effectiveStatus(rows[4], c[4])).toBe("replaces");
    c = setTarget(rows, c, 4, "gui/sprites/recipe_book/button");
    expect(effectiveStatus(rows[4], c[4])).toBe("new");
    c = setTarget(rows, c, 4, null);
    expect(c[4].checked).toBe(false);
  });

  it("picking a texture another row already uses takes it over", () => {
    const rows = sample();
    let c = initialChoices(rows);
    rows[4].candidates.push({ path: "block/stone", in_pack: false });
    c = setTarget(rows, c, 4, "block/stone");
    expect([c[0].checked, c[4].checked]).toEqual([false, true]);
  });

  it("select all skips identical files and unresolved duplicates; none clears", () => {
    const rows = sample();
    let c = checkAll(rows, initialChoices(rows), false);
    expect(countRows(rows, c).checked).toBe(0);
    c = checkAll(rows, c, true);
    expect(rows.filter((r) => c[r.id].checked).map((r) => r.rel)).toEqual(["stone.png", "dirt.png", "water.png"]);
  });

  it("plans the import, skipping textures with unsaved editor changes", () => {
    const rows = sample();
    let c = initialChoices(rows);
    c = setFrames(c, 7, false);
    c = setChecked(rows, c, 2, true); // same pixels, ticked anyway
    const plan = planImport(rows, c, new Set(["block/dirt"]));
    expect(plan.items).toEqual([
      { id: 0, target: "block/stone", frames: false },
      { id: 2, target: "block/sand", frames: false },
      { id: 7, target: "block/water_still", frames: false },
    ]);
    expect(plan.skipped.map((s) => s.row.rel)).toEqual(["dirt.png"]);
    expect(plan.skipped[0].reason).toMatch(/unsaved changes/);
    // frames only for strips
    const p2 = planImport(rows, setFrames(initialChoices(rows), 0, true), new Set());
    expect(p2.items.find((i) => i.id === 0)!.frames).toBe(false);
    expect(p2.items.find((i) => i.id === 7)!.frames).toBe(true);
  });

  it("sums up the result", () => {
    const r = (id: number, o: Partial<BatchItemResult>): BatchItemResult => ({
      id, target: "t", ok: true, replaced: false, wrote_mcmeta: false, unchanged: false, error: null, ...o,
    });
    expect(resultSummary([r(0, {}), r(1, { replaced: true }), r(2, { unchanged: true }), r(3, { ok: false })], 1)).toBe(
      "Imported 2 textures, not resized, 1 replaced (the old files are in the pack's trash), 1 already identical, 1 skipped, 1 failed.",
    );
    expect(resultSummary([r(0, {})], 0)).toBe("Imported 1 texture, not resized.");
  });
});

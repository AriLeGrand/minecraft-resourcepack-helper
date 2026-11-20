import { describe, expect, it } from "vitest";
import type { CompareRow, Comparison } from "./api";
import { canCopy, compareFileName, compareShareText, countCompare, filterCompare, planCopy, rowNote, tickShown } from "./compare";

const r = (id: number, status: CompareRow["status"], path: string | null, theirs: string | null, extra: Partial<CompareRow> = {}): CompareRow => ({
  id,
  path,
  theirs,
  renamed_from: null,
  status,
  their_size: theirs ? [16, 16] : null,
  my_size: status === "only_theirs" ? null : [16, 16],
  their_mcmeta: false,
  my_mcmeta: false,
  mcmeta_differs: false,
  in_game: path !== null,
  shadowed_by: null,
  ...extra,
});

const rows: CompareRow[] = [
  r(0, "different", "block/dirt", "block/dirt", { their_size: [32, 32] }),
  r(1, "only_mine", "block/oak_planks", null),
  r(2, "only_theirs", "item/red_dye", "items/dye_powder_red", { renamed_from: "items/dye_powder_red" }),
  r(3, "same", "block/stone", "block/stone"),
  r(4, "only_theirs", null, "block/my_own"),
  r(5, "only_theirs", "block/stone", "blocks/stone", { shadowed_by: "block/stone" }),
  r(6, "different", "item/diamond", "item/diamond", { mcmeta_differs: true }),
];

describe("compare helpers", () => {
  it("counts and filters", () => {
    expect(countCompare(rows)).toEqual({ all: 7, only_mine: 1, only_theirs: 3, different: 2, same: 1 });
    expect(filterCompare(rows, "different", "").map((x) => x.id)).toEqual([0, 6]);
    expect(filterCompare(rows, "all", "dye").map((x) => x.id)).toEqual([2]);
    // their old name is searchable too
    expect(filterCompare(rows, "all", "powder").map((x) => x.id)).toEqual([2]);
  });

  it("copies only rows with a file of theirs that is used for a texture of mine", () => {
    expect(rows.map(canCopy)).toEqual([true, false, true, false, false, false, true]);
    const ticked = tickShown(new Set(), rows, true);
    expect([...ticked].sort()).toEqual([0, 2, 6]);
    expect([...tickShown(ticked, rows.slice(0, 1), false)].sort()).toEqual([2, 6]);
    const plan = planCopy(rows, new Set([0, 1, 2, 6]), new Set(["item/diamond"]));
    expect(plan.ids).toEqual([0, 2]);
    expect(plan.skipped.map((s) => s.row.id)).toEqual([6]);
    expect(plan.skipped[0].reason).toContain("unsaved");
  });

  it("explains rows", () => {
    expect(rowNote(rows[0])).toBe("mine 16×16, theirs 32×32");
    expect(rowNote(rows[2])).toBe("called items/dye_powder_red in their pack");
    expect(rowNote(rows[4])).toBe("not a texture of this version");
    expect(rowNote(rows[5])).toBe("not used: block/stone is used instead");
    expect(rowNote(rows[6])).toBe("same pixels, different animation file");
  });

  it("shares the comparison as Markdown or text", () => {
    const c: Comparison = { source: "D:/x/Their.zip", name: "Their", description: null, format: null, rows, skipped_big: 0, truncated: false };
    const md = compareShareText(c, { format: "markdown", myName: "Mine", subtitle: "Java 1.21.11 · 32×", includeSame: false });
    expect(md.split("\n").slice(0, 4)).toEqual(["# Mine compared with Their", "_Java 1.21.11 · 32×_", "", "2 different · 1 only in Mine · 3 only in Their · 1 identical"]);
    expect(md).toContain("## Different (2)\n\n- `block/dirt` — mine 16×16, theirs 32×32\n");
    expect(md).toContain("## Only in Mine (1)\n\n- `block/oak_planks`\n");
    expect(md).toContain("- `block/my_own` — not a texture of this version");
    expect(md).not.toContain("## Identical");
    const txt = compareShareText(c, { format: "text", myName: "Mine", subtitle: "s", includeSame: true });
    expect(txt).toContain("Identical (1)\n  block/stone\n");
    expect(txt).toContain("  item/red_dye  (called items/dye_powder_red in their pack)");
    expect(compareFileName("Mine", "Th:eir", "markdown")).toBe("Mine vs Th_eir.md");
    expect(compareFileName("Mine", "x", "text")).toBe("Mine vs x.txt");
  });
});

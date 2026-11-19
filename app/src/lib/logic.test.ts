import { describe, expect, it } from "vitest";
import type { TextureRow } from "./api";
import {
  agoLabel, bytesLabel, countRows, dayLabel, defaultFilters, filterRows, formatLabel, joinPath, matchesElsewhere,
  matchesSearch, parseSectionCodes, safeFileName, searchWords, timeLabel, virtualWindow,
} from "./logic";

const row = (path: string, extra: Partial<TextureRow> = {}): TextureRow => ({
  path,
  category: path.startsWith("item/") ? "items" : path.startsWith("gui/") ? "gui" : "blocks",
  width: 16, height: 16, animated: false, frames: 1, has_thumb: false, status: "todo",
  mine: null, wrong_size: false, renamed: false, extra: false,
  ...extra,
});

const rows = [
  row("block/oak_planks", { status: "done", renamed: true }),
  row("block/birch_planks"),
  row("block/prismarine", { animated: true, status: "changed" }),
  row("block/stone", { status: "done", wrong_size: true }),
  row("item/oak_boat", { status: "done" }),
  row("gui/widgets"),
];

describe("search", () => {
  it("splits words and matches all of them", () => {
    expect(searchWords("  Oak  pla ")).toEqual(["oak", "pla"]);
    expect(matchesSearch("block/oak_planks", ["oak", "pla"])).toBe(true);
    expect(matchesSearch("block/oak_planks", ["oak", "stone"])).toBe(false);
    expect(matchesSearch("block/dark_oak_log", ["dark oak".split(" ")[0], "oak"])).toBe(true);
    expect(matchesSearch("anything", [])).toBe(true);
  });
  it("treats underscores like spaces", () => {
    expect(matchesSearch("block/oak_planks", ["oak planks".replace(" ", " ")].flatMap((w) => w.split(" ")))).toBe(true);
  });
});

describe("filterRows", () => {
  it("filters by category", () => {
    expect(filterRows(rows, defaultFilters).map((r) => r.path)).toEqual([
      "block/oak_planks", "block/birch_planks", "block/prismarine", "block/stone",
    ]);
    expect(filterRows(rows, { ...defaultFilters, category: "all" })).toHaveLength(6);
  });
  it("filters by status and toggles", () => {
    expect(filterRows(rows, { ...defaultFilters, status: "done" }).map((r) => r.path)).toEqual(["block/oak_planks", "block/stone"]);
    expect(filterRows(rows, { ...defaultFilters, status: "changed" })).toHaveLength(1);
    expect(filterRows(rows, { ...defaultFilters, animated: true }).map((r) => r.path)).toEqual(["block/prismarine"]);
    expect(filterRows(rows, { ...defaultFilters, renamed: true }).map((r) => r.path)).toEqual(["block/oak_planks"]);
    expect(filterRows(rows, { ...defaultFilters, wrongSize: true }).map((r) => r.path)).toEqual(["block/stone"]);
  });
  it("searches inside the category and reports matches elsewhere", () => {
    const f = { ...defaultFilters, search: "oak" };
    expect(filterRows(rows, f).map((r) => r.path)).toEqual(["block/oak_planks"]);
    expect(matchesElsewhere(rows, f)).toBe(1);
    expect(matchesElsewhere(rows, { ...f, category: "all" })).toBe(0);
    expect(filterRows(rows, { ...f, category: "all" })).toHaveLength(2);
  });
  it("an explicit list wins over everything", () => {
    const f = { ...defaultFilters, search: "zzz", only: ["gui/widgets", "block/stone"] };
    expect(filterRows(rows, f).map((r) => r.path)).toEqual(["block/stone", "gui/widgets"]);
  });
});

describe("countRows", () => {
  it("counts categories overall and statuses in the category", () => {
    const c = countRows(rows, "blocks");
    expect(c.byCategory).toEqual({ blocks: 4, items: 1, gui: 1 });
    expect(c.doneByCategory.blocks).toBe(3);
    expect(c.status).toEqual({ todo: 1, done: 2, changed: 1 });
    expect(countRows(rows, "all").status).toEqual({ todo: 2, done: 3, changed: 1 });
  });
});

describe("virtualWindow", () => {
  it("draws only what is visible, plus a margin", () => {
    const w = virtualWindow(0, 600, 40, 3500, 5);
    expect(w).toEqual({ first: 0, last: 25, padTop: 0, padBottom: (3500 - 25) * 40 });
    const mid = virtualWindow(40_000, 600, 40, 3500, 5);
    expect(mid.first).toBe(995);
    expect(mid.last).toBe(1020);
    expect(mid.padTop + (mid.last - mid.first) * 40 + mid.padBottom).toBe(3500 * 40);
  });
  it("handles the end of the list and short lists", () => {
    const end = virtualWindow(3500 * 40, 600, 40, 3500, 5);
    expect(end.last).toBe(3500);
    expect(end.padBottom).toBe(0);
    expect(virtualWindow(0, 600, 40, 3)).toMatchObject({ first: 0, last: 3, padBottom: 0 });
    expect(virtualWindow(0, 600, 40, 0)).toMatchObject({ first: 0, last: 0 });
  });
});

describe("labels", () => {
  const now = new Date(2026, 10, 19, 15, 0).getTime();
  it("days", () => {
    expect(dayLabel(new Date(2026, 10, 19, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 18, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 30).getTime(), now)).toBe("Oct 30");
    expect(dayLabel(new Date(2024, 9, 30).getTime(), now)).toBe("Oct 30, 2024");
  });
  it("times", () => {
    expect(timeLabel(new Date(2026, 10, 19, 14, 32).getTime(), now)).toBe("today 14:32");
    expect(timeLabel(new Date(2026, 10, 18, 9, 5).getTime(), now)).toBe("yesterday 09:05");
  });
  it("ago", () => {
    expect(agoLabel(now - 20_000, now)).toBe("Just now");
    expect(agoLabel(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(agoLabel(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(agoLabel(new Date(2026, 10, 18, 12).getTime(), now)).toBe("Yesterday");
    expect(agoLabel(new Date(2026, 10, 15).getTime(), now)).toBe("4 days ago");
    expect(agoLabel(new Date(2026, 10, 10).getTime(), now)).toBe("Last week");
    expect(agoLabel(new Date(2026, 9, 2).getTime(), now)).toBe("Oct 2");
  });
  it("sizes and formats", () => {
    expect(bytesLabel(512)).toBe("512 B");
    expect(bytesLabel(2048)).toBe("2.0 KB");
    expect(bytesLabel(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatLabel({ major: 46, minor: null })).toBe("46");
    expect(formatLabel({ major: 75, minor: 0 })).toBe("75.0");
    expect(formatLabel(null)).toBe("?");
  });
});

describe("parseSectionCodes", () => {
  it("reads the mockup example", () => {
    const runs = parseSectionCodes("§bOcean textures §7by Ari");
    expect(runs.map((r) => [r.text, r.color])).toEqual([["Ocean textures ", "#55ffff"], ["by Ari", "#aaaaaa"]]);
  });
  it("handles formatting, reset and stray codes", () => {
    const runs = parseSectionCodes("plain §lbold §cred§r back §z?§");
    expect(runs[0]).toMatchObject({ text: "plain ", color: "#aaaaaa", bold: false });
    expect(runs[1]).toMatchObject({ text: "bold ", bold: true });
    expect(runs[2]).toMatchObject({ text: "red", color: "#ff5555", bold: false });
    expect(runs[3]).toMatchObject({ text: " back ?§", color: "#aaaaaa" });
    expect(parseSectionCodes("")).toEqual([]);
  });
});

describe("paths", () => {
  it("joins with the right separator", () => {
    expect(joinPath("D:\\Packs", "Deep Sea Pack")).toBe("D:\\Packs\\Deep Sea Pack");
    expect(joinPath("D:\\Packs\\", "x")).toBe("D:\\Packs\\x");
    expect(joinPath("/home/ari/packs", "x")).toBe("/home/ari/packs/x");
  });
  it("makes safe file names", () => {
    expect(safeFileName("Deep Sea Pack")).toBe("Deep Sea Pack");
    expect(safeFileName('a/b:c*d?"')).toBe("a_b_c_d__");
    expect(safeFileName("  dots... ")).toBe("dots");
    expect(safeFileName(" . ")).toBe("pack");
  });
});

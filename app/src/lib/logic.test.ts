import { describe, expect, it } from "vitest";
import type { TextureRow, VersionView, WhatsNewView } from "./api";
import {
  agoLabel, bytesLabel, compareChoices, compareMc, countRows, defaultCompareVersion, realRenames, whatsNewNotice,
  whatsNewOnly, whatsNewTitle, dayLabel, defaultFilters, filterRows, formatLabel, joinPath, matchesElsewhere,
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

describe("what's new", () => {
  const ver = (dir_name: string, label: string, usable = true): VersionView => ({
    dir_name, label, id: label, has_jar: usable, format: null, format_source: null, problem: null, extracted: false, usable,
  });
  const versions = [
    ver("1.8.9", "1.8.9"), ver("1.21.11", "1.21.11"), ver("1.20.1", "1.20.1"), ver("1.21.8", "1.21.8"),
    ver("fabric-1.20.4", "1.20.4"), ver("1.21.9", "1.21.9", false), ver("fabric-1.21.11", "1.21.11"),
  ];
  const view = (older: boolean): WhatsNewView => ({
    diff: {
      this_dir: "1.21.11", other_dir: "1.20.1", this_version: "1.21.11", other_version: "1.20.1", other_is_older: older,
      added: ["block/crafter_top", "block/copper_bulb"],
      removed: ["item/old"],
      renamed: [
        { from: "block/grass", to: "block/short_grass", folder_only: false },
        { from: "blocks/stone", to: "block/stone", folder_only: true },
      ],
      changed: [{ path: "block/dirt", other_path: "block/dirt", width: 16, height: 16, other_width: 16, other_height: 16 }],
      matched: 10,
    },
    changed_in_pack: [],
    millis: 5,
  });

  it("compares version numbers", () => {
    expect(compareMc("1.21.11", "1.21.8")).toBeGreaterThan(0);
    expect(compareMc("1.8.9", "1.20.1")).toBeLessThan(0);
    expect(compareMc("1.21", "1.21.0")).toBe(0);
  });
  it("offers the other usable versions, newest first, and picks the newest older one", () => {
    const c = compareChoices(versions, "1.21.11", "1.21.11");
    expect(c.map((v) => v.dir_name)).toEqual(["1.21.8", "fabric-1.20.4", "1.20.1", "1.8.9"]);
    expect(defaultCompareVersion(c, "1.21.11")).toBe("1.21.8");
    // a pack on the oldest version gets the oldest newer one
    const c2 = compareChoices(versions, "1.8.9", "1.8.9");
    expect(defaultCompareVersion(c2, "1.8.9")).toBe("1.20.1");
    expect(defaultCompareVersion([], "1.8.9")).toBeNull();
  });
  it("lists the textures of each mode, leaving folder-only renames out", () => {
    const w = view(true);
    expect(whatsNewOnly(w, "new")).toEqual(["block/crafter_top", "block/copper_bulb"]);
    expect(whatsNewOnly(w, "changed")).toEqual(["block/dirt"]);
    expect(whatsNewOnly(w, "renamed")).toEqual(["block/short_grass"]);
    expect(realRenames(w)).toHaveLength(1);
  });
  it("titles and summary say what the list is", () => {
    expect(whatsNewTitle(view(true), "new")).toBe("New in 1.21.11 since 1.20.1");
    expect(whatsNewTitle(view(true), "changed")).toBe("Changed by Mojang since 1.20.1");
    expect(whatsNewTitle(view(false), "changed")).toBe("Redrawn by Mojang in 1.20.1");
    expect(whatsNewNotice(view(true), 1)).toBe(
      "2 textures are new in 1.21.11 since 1.20.1 · 1 changed by Mojang (1 in your pack) · 1 renamed (+1 moved to a new folder) · 1 removed",
    );
    expect(whatsNewNotice(view(false), 0)).toBe("1.20.1 adds 1 texture · redraws 1 (0 in your pack) · 1 renamed (+1 moved to a new folder) · 2 gone");
  });
  it("a what's-new list is shown through the only filter", () => {
    const f = { ...defaultFilters, only: whatsNewOnly(view(true), "changed") };
    expect(filterRows([row("block/dirt"), row("block/stone")], f).map((r) => r.path)).toEqual(["block/dirt"]);
  });
});

import { describe, expect, it } from "vitest";
import type { TextureNote, TextureRow } from "./api";
import { formatShareList, groupForShare, shareFileName, type ShareOptions } from "./share";

const row = (path: string, extra: Partial<TextureRow> = {}): TextureRow => ({
  path,
  category: path.startsWith("item/") ? "items" : path.startsWith("gui/") ? "gui" : "blocks",
  width: 16, height: 16, animated: false, frames: 1, has_thumb: false, status: "todo",
  mine: null, wrong_size: false, renamed: false, extra: false,
  ...extra,
});

const mine = (w: number, h: number) => ({ path: "", width: w, height: h, modified_ms: 0, has_mcmeta: false, animated: false, frames: 1, file_size: 1 });

const rows: TextureRow[] = [
  row("item/apple"),
  row("block/stone", { status: "done", mine: mine(32, 32) }),
  row("block/andesite"),
  row("block/prismarine", { animated: true, frames: 4, status: "changed", mine: mine(32, 128) }),
  row("blocks/planks_oak", { extra: true, status: "done" }),
];

const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const opts = (o: Partial<ShareOptions> = {}): ShareOptions => ({
  format: "checklist", includeDone: true, packName: "Deep Sea Pack", subtitle: "Java 1.21.11 · 32×", now: NOW, ...o,
});

describe("groupForShare", () => {
  it("groups by category in the app's order, sorted, without files the game does not use", () => {
    const g = groupForShare(rows, true);
    expect(g.map((x) => x.label)).toEqual(["Blocks", "Items"]);
    expect(g[0].rows.map((r) => r.path)).toEqual(["block/andesite", "block/prismarine", "block/stone"]);
  });
  it("can leave finished textures out", () => {
    const g = groupForShare(rows, false);
    expect(g.flatMap((x) => x.rows.map((r) => r.path))).toEqual(["block/andesite", "item/apple"]);
  });
});

describe("formatShareList", () => {
  it("checklist with ticks, counts and notes", () => {
    expect(formatShareList(rows, opts())).toBe(
      [
        "# Deep Sea Pack: to-do list",
        "Java 1.21.11 · 32× · 2 / 4 done, 2 to do · 2026-11-20",
        "",
        "## Blocks (1 to do, 2 done)",
        "- [ ] andesite: `textures/block/andesite.png`",
        "- [x] prismarine: `textures/block/prismarine.png` (animated, 4 frames, changed since export)",
        "- [x] stone: `textures/block/stone.png`",
        "",
        "## Items (1 to do, 0 done)",
        "- [ ] apple: `textures/item/apple.png`",
        "",
      ].join("\n"),
    );
  });
  it("to-do only, plain text", () => {
    const t = formatShareList(rows, opts({ format: "text", includeDone: false }));
    expect(t.split("\n")).toEqual([
      "Deep Sea Pack: to-do list",
      "Java 1.21.11 · 32× · 2 / 4 done, 2 to do · 2026-11-20",
      "",
      "Blocks (1 to do)",
      "[ ] andesite  textures/block/andesite.png",
      "",
      "Items (1 to do)",
      "[ ] apple  textures/item/apple.png",
      "",
    ]);
  });
  it("says so when nothing is left", () => {
    const t = formatShareList([row("block/stone", { status: "done" })], opts({ includeDone: false }));
    expect(t).toContain("Nothing left to do.");
  });
  it("spreadsheet with proper quoting", () => {
    const csv = formatShareList([...rows, row("block/odd,name\"x")], opts({ format: "csv" }));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("category,texture,file,status,size,animated,frames,details,note,tags,assigned_to");
    expect(lines).toContain('Blocks,prismarine,textures/block/prismarine.png,done,32×128,yes,4,"animated, 4 frames; changed since export",,,');
    expect(lines).toContain('Blocks,"odd,name""x","textures/block/odd,name""x.png",to do,16×16,no,1,,,,');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

const team: Record<string, TextureNote> = {
  "block/andesite": { note: "darker edges\nless noise", tags: ["needs redo"], assignee: "Sam", updated_ms: 1 },
  "item/apple": { note: "", tags: ["waiting feedback", "food"], assignee: "alex", updated_ms: 1 },
  "block/stone": { note: "ok, final", tags: [], assignee: "Alex", updated_ms: 1 },
};

describe("notes, tags and who does it", () => {
  it("follow each texture in the checklist", () => {
    const t = formatShareList(rows, opts({ notes: team }));
    expect(t).toContain("- [ ] andesite: `textures/block/andesite.png` · tags: needs redo · assigned to Sam · note: darker edges / less noise");
    expect(t).toContain("- [x] stone: `textures/block/stone.png` · assigned to Alex · note: ok, final");
    expect(t).toContain("- [ ] apple: `textures/item/apple.png` · tags: waiting feedback, food · assigned to alex");
  });
  it("group by person: names A→Z (any case), Unassigned last, no repeated name", () => {
    const t = formatShareList(rows, opts({ format: "text", notes: team, byPerson: true }));
    expect(t.split("\n")).toEqual([
      "Deep Sea Pack: to-do list",
      "Java 1.21.11 · 32× · 2 / 4 done, 2 to do · 2026-11-20",
      "",
      "Alex (1 to do, 1 done)",
      "[x] stone  textures/block/stone.png · note: ok, final",
      "[ ] apple  textures/item/apple.png · tags: waiting feedback, food",
      "",
      "Sam (1 to do, 0 done)",
      "[ ] andesite  textures/block/andesite.png · tags: needs redo · note: darker edges / less noise",
      "",
      "Unassigned (0 to do, 1 done)",
      "[x] prismarine  textures/block/prismarine.png (animated, 4 frames, changed since export)",
      "",
    ]);
  });
  it("CSV gets note, tags and assigned_to columns", () => {
    const lines = formatShareList(rows, opts({ format: "csv", notes: team })).split("\r\n");
    expect(lines).toContain('Blocks,andesite,textures/block/andesite.png,to do,16×16,no,1,,"darker edges\nless noise",needs redo,Sam');
    expect(lines).toContain("Items,apple,textures/item/apple.png,to do,16×16,no,1,,,waiting feedback; food,alex");
  });
  it("grouping by person keeps the category column right in CSV", () => {
    const lines = formatShareList(rows, opts({ format: "csv", notes: team, byPerson: true })).split("\r\n");
    expect(lines[1].startsWith("Blocks,stone,")).toBe(true);
    expect(lines[2].startsWith("Items,apple,")).toBe(true);
  });
});

describe("shareFileName", () => {
  it("is safe for Windows and has the right extension", () => {
    expect(shareFileName("Deep Sea Pack", "checklist")).toBe("Deep Sea Pack to-do list.md");
    expect(shareFileName("a/b:c?", "csv")).toBe("a_b_c_ to-do list.csv");
    expect(shareFileName(" . ", "text")).toBe("pack to-do list.txt");
  });
});

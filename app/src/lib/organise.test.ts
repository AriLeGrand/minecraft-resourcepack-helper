// Notes / tags / assignee filters, progress stats and the notes helpers.
import { describe, expect, it } from "vitest";
import type { TextureNote, TextureRow } from "./api";
import { defaultFilters, filterRows, matchesElsewhere, progressOf, progressStats, stampLabel, startOfWeek, type NoteCtx } from "./logic";
import { addTag, hasContent, initials, nameSuggestions, sameNote, tagSuggestions, usedTags } from "./notes";

const row = (path: string, extra: Partial<TextureRow> = {}): TextureRow => ({
  path,
  category: path.startsWith("item/") ? "items" : path.startsWith("gui/") ? "gui" : "blocks",
  width: 16, height: 16, animated: false, frames: 1, has_thumb: false, status: "todo",
  mine: null, wrong_size: false, renamed: false, extra: false,
  ...extra,
});

const mine = (modified_ms: number) => ({ path: "", width: 16, height: 16, modified_ms, has_mcmeta: false, animated: false, frames: 1, file_size: 1 });
const note = (o: Partial<TextureNote>): TextureNote => ({ note: "", tags: [], assignee: "", updated_ms: 1, ...o });

const notes: Record<string, TextureNote> = {
  "block/stone": note({ note: "darker", tags: ["needs redo"], assignee: "Alex" }),
  "block/dirt": note({ tags: ["Needs Redo", "waiting feedback"], assignee: "sam" }),
  "block/sand": note({ assignee: "alex" }),
  "item/apple": note({ note: "shine", tags: ["waiting feedback"] }),
};
const ctx: NoteCtx = { notes, me: "Alex" };
const rows = ["block/stone", "block/dirt", "block/sand", "block/gravel", "item/apple"].map((p) => row(p));
const paths = (f: Partial<typeof defaultFilters>, c: NoteCtx | undefined = ctx) =>
  filterRows(rows, { ...defaultFilters, category: "all", ...f }, c).map((r) => r.path);

describe("note filters", () => {
  it("by tag, without case", () => {
    expect(paths({ tag: "needs redo" })).toEqual(["block/stone", "block/dirt"]);
    expect(paths({ tag: "WAITING FEEDBACK" })).toEqual(["block/dirt", "item/apple"]);
  });
  it("by assignee: mine, unassigned, a name", () => {
    expect(paths({ assignee: { kind: "mine" } })).toEqual(["block/stone", "block/sand"]);
    expect(paths({ assignee: { kind: "none" } })).toEqual(["block/gravel", "item/apple"]);
    expect(paths({ assignee: { kind: "name", name: "Sam" } })).toEqual(["block/dirt"]);
    // "Mine" without a name of my own matches nothing
    expect(paths({ assignee: { kind: "mine" } }, { notes, me: "" })).toEqual([]);
  });
  it("has a note, and every filter together", () => {
    expect(paths({ hasNote: true })).toEqual(["block/stone", "item/apple"]);
    expect(paths({ hasNote: true, tag: "needs redo", assignee: { kind: "mine" } })).toEqual(["block/stone"]);
  });
  it("defaults let everything through, also without notes", () => {
    expect(filterRows(rows, { ...defaultFilters, category: "all" })).toHaveLength(5);
    expect(filterRows(rows, { ...defaultFilters, category: "all", tag: "needs redo" })).toEqual([]);
  });
  it("counts matches in other categories when a note filter is on", () => {
    expect(matchesElsewhere(rows, { ...defaultFilters, category: "blocks", tag: "waiting feedback" }, ctx)).toBe(1);
    expect(matchesElsewhere(rows, { ...defaultFilters, category: "blocks" }, ctx)).toBe(0);
  });
});

describe("progress", () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime(); // Friday
  const today = new Date(2026, 10, 20, 9, 0).getTime();
  const monday = new Date(2026, 10, 16, 8, 0).getTime();
  const lastWeek = new Date(2026, 10, 15, 23, 0).getTime();
  const list = [
    row("block/stone", { status: "done", mine: mine(today) }),
    row("block/dirt", { status: "changed", mine: mine(monday) }),
    row("block/sand"),
    row("item/apple", { status: "done", mine: mine(lastWeek) }),
    row("item/stick"),
    row("item/old_name", { extra: true, status: "done", mine: mine(today) }),
  ];
  it("percent is rounded down, 100 only when all is done", () => {
    expect(progressOf(199, 200).pct).toBe(99);
    expect(progressOf(2, 3).pct).toBe(66);
    expect(progressOf(3, 3).pct).toBe(100);
    expect(progressOf(0, 0).pct).toBe(0);
  });
  it("overall and per category, without files the game does not have", () => {
    const s = progressStats(list, now);
    expect(s.overall).toEqual({ done: 3, total: 5, pct: 60 });
    expect(s.categories.map((c) => [c.key, c.done, c.total, c.pct])).toEqual([["blocks", 2, 3, 66], ["items", 1, 2, 50]]);
  });
  it("today, this week (from Monday) and changed since export", () => {
    const s = progressStats(list, now);
    expect(s.today).toBe(2); // the extra file counts as work done today
    expect(s.week).toBe(3);
    expect(s.changed).toBe(1);
  });
  it("the week starts on Monday, also on a Sunday", () => {
    expect(startOfWeek(now)).toBe(new Date(2026, 10, 16).getTime());
    expect(startOfWeek(new Date(2026, 10, 22, 12).getTime())).toBe(new Date(2026, 10, 16).getTime());
    expect(startOfWeek(new Date(2026, 10, 16, 0, 0).getTime())).toBe(new Date(2026, 10, 16).getTime());
  });
  it("history dates read like 'Today 14:32'", () => {
    expect(stampLabel(new Date(2026, 10, 20, 14, 32).getTime(), now)).toBe("Today 14:32");
    expect(stampLabel(new Date(2026, 10, 19, 9, 5).getTime(), now)).toBe("Yesterday 09:05");
    expect(stampLabel(new Date(2026, 9, 30, 14, 32).getTime(), now)).toBe("Oct 30 14:32");
  });
});

describe("notes helpers", () => {
  it("initials", () => {
    expect(initials("Alex Martin")).toBe("AM");
    expect(initials("sam")).toBe("S");
    expect(initials("jean-luc picard")).toBe("JP");
    expect(initials("  ")).toBe("");
  });
  it("tag suggestions: used ones first (most used), then the defaults not used yet", () => {
    const t = tagSuggestions(notes);
    expect(t.slice(0, 2)).toEqual(["needs redo", "waiting feedback"]);
    expect(t.filter((x) => x.toLowerCase() === "needs redo")).toHaveLength(1);
    expect(t).toContain("in progress");
    expect(usedTags(notes)).toEqual(["needs redo", "waiting feedback"]);
  });
  it("name suggestions merge spellings and add my own name", () => {
    expect(nameSuggestions(notes)).toEqual(["Alex", "sam"]);
    expect(nameSuggestions(notes, "Kim")).toEqual(["Alex", "sam", "Kim"]);
    expect(nameSuggestions(notes, "ALEX")).toEqual(["Alex", "sam"]);
  });
  it("addTag ignores empty and duplicate tags", () => {
    expect(addTag(["a"], "  b  c ")).toEqual(["a", "b c"]);
    const same = ["needs redo"];
    expect(addTag(same, "Needs Redo")).toBe(same);
    expect(addTag(same, " ")).toBe(same);
  });
  it("hasContent and sameNote", () => {
    expect(hasContent(note({}))).toBe(false);
    expect(hasContent(note({ assignee: "x" }))).toBe(true);
    expect(sameNote(note({ note: "a " }), note({ note: "a" }))).toBe(true);
    expect(sameNote(note({ tags: ["a"] }), note({ tags: ["b"] }))).toBe(false);
  });
});

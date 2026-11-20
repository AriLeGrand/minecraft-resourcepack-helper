// Pure helpers (no React, no Tauri) so they can be unit-tested.
import type { Category, PackFormat, Status, TextureNote, TextureRow, VersionView, WhatsNewView } from "./api";

export const CATEGORIES: { key: Category; label: string }[] = [
  { key: "blocks", label: "Blocks" },
  { key: "items", label: "Items" },
  { key: "gui", label: "GUI" },
  { key: "entities", label: "Entities" },
  { key: "particles", label: "Particles" },
  { key: "environment", label: "Environment" },
  { key: "paintings", label: "Paintings" },
  { key: "mob_effects", label: "Mob effects" },
  { key: "armor", label: "Armor" },
  { key: "misc", label: "Misc" },
];

export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.key === c)?.label ?? c;

export interface Filters {
  category: Category | "all";
  status: Status | "all";
  animated: boolean;
  renamed: boolean;
  wrongSize: boolean;
  search: string;
  /** When set (from a check's "Show" button), only these textures are listed. */
  only: string[] | null;
  /** What `only` came from, for the notice ("from the check", "just imported"). */
  onlyLabel?: string;
  /** Heading of the list while `only` is set ("New in 1.21.11 since 1.20.1"). */
  onlyTitle?: string;
  /** Only textures with this tag (compared without case). */
  tag: string | null;
  /** Who does it: anyone, me, nobody yet, or one name. */
  assignee: AssigneeFilter;
  /** Only textures with a written note. */
  hasNote: boolean;
}

export type AssigneeFilter = { kind: "any" } | { kind: "mine" } | { kind: "none" } | { kind: "name"; name: string };

/** Notes of the open pack (texture path → note) and the user's own name, for the filters. */
export interface NoteCtx {
  notes: Record<string, TextureNote>;
  me: string;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when the texture passes the tag / assignee / note filters. */
export function passesNotes(path: string, f: Filters, ctx: NoteCtx | undefined): boolean {
  const n = ctx?.notes[path];
  if (f.hasNote && !n?.note) return false;
  if (f.tag && !n?.tags.some((t) => sameName(t, f.tag!))) return false;
  const who = n?.assignee ?? "";
  switch (f.assignee.kind) {
    case "none": return who === "";
    case "mine": return who !== "" && !!ctx?.me && sameName(who, ctx.me);
    case "name": return who !== "" && sameName(who, f.assignee.name);
    default: return true;
  }
}

export const defaultFilters: Filters = {
  category: "blocks",
  status: "all",
  animated: false,
  renamed: false,
  wrongSize: false,
  search: "",
  only: null,
  tag: null,
  assignee: { kind: "any" },
  hasNote: false,
};

/** Splits "oak pla" into words that must all appear in the path. */
export function searchWords(q: string): string[] {
  return q.toLowerCase().split(/[\s]+/).filter(Boolean);
}

export function matchesSearch(path: string, words: string[]): boolean {
  if (words.length === 0) return true;
  const p = path.toLowerCase();
  return words.every((w) => p.includes(w) || p.replace(/_/g, " ").includes(w));
}

function passesToggles(r: TextureRow, f: Filters): boolean {
  if (f.status !== "all" && r.status !== f.status) return false;
  if (f.animated && !r.animated) return false;
  if (f.renamed && !r.renamed) return false;
  if (f.wrongSize && !r.wrong_size) return false;
  return true;
}

export function filterRows(rows: TextureRow[], f: Filters, ctx?: NoteCtx): TextureRow[] {
  if (f.only) {
    const set = new Set(f.only);
    return rows.filter((r) => set.has(r.path));
  }
  const words = searchWords(f.search);
  return rows.filter(
    (r) => (f.category === "all" || r.category === f.category) && passesToggles(r, f) && passesNotes(r.path, f, ctx) && matchesSearch(r.path, words),
  );
}

/** How many textures match the search (and note filters) in the categories that are not shown. */
export function matchesElsewhere(rows: TextureRow[], f: Filters, ctx?: NoteCtx): number {
  const noteFilter = f.tag !== null || f.assignee.kind !== "any" || f.hasNote;
  if (f.category === "all" || f.only || (searchWords(f.search).length === 0 && !noteFilter)) return 0;
  const words = searchWords(f.search);
  return rows.filter((r) => r.category !== f.category && passesToggles(r, f) && passesNotes(r.path, f, ctx) && matchesSearch(r.path, words)).length;
}

export interface Counts {
  byCategory: Record<string, number>;
  doneByCategory: Record<string, number>;
  status: Record<Status, number>;
}

/** Category counts over everything; status counts inside the current category. */
export function countRows(rows: TextureRow[], category: Category | "all"): Counts {
  const c: Counts = { byCategory: {}, doneByCategory: {}, status: { todo: 0, done: 0, changed: 0 } };
  for (const r of rows) {
    c.byCategory[r.category] = (c.byCategory[r.category] ?? 0) + 1;
    if (r.status !== "todo") c.doneByCategory[r.category] = (c.doneByCategory[r.category] ?? 0) + 1;
    if (category === "all" || r.category === category) c.status[r.status] += 1;
  }
  return c;
}

/** Which rows of a long list to draw for the current scroll position. */
export function virtualWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 8) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
  const last = Math.min(count, first + visible);
  return { first, last, padTop: first * rowHeight, padBottom: Math.max(0, (count - last) * rowHeight) };
}

export const formatLabel = (f: PackFormat | null | undefined) =>
  !f ? "?" : f.minor === null || f.minor === undefined ? String(f.major) : `${f.major}.${f.minor}`;

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "Oct 30", "Oct 30, 2024". */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "today 14:32", "yesterday 09:05", "Oct 30 14:32". */
export function timeLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const day = dayLabel(ms, now);
  const prefix = day === "Today" ? "today" : day === "Yesterday" ? "yesterday" : day;
  return `${prefix} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today 14:32", "Yesterday 09:05", "Oct 30 14:32" (history thumbnails). */
export function stampLabel(ms: number, now: number): string {
  const t = timeLabel(ms, now);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "Edited 2 h ago", "Yesterday", "Last week", "Oct 2". */
export function agoLabel(ms: number, now: number): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60 && dayLabel(ms, now) === "Today") return `${Math.floor(min / 60)} h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "Last week";
  return dayLabel(ms, now);
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Minecraft "§" colour codes (pack description preview) ----

const MC_COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa", "4": "#aa0000", "5": "#aa00aa",
  "6": "#ffaa00", "7": "#aaaaaa", "8": "#555555", "9": "#5555ff", a: "#55ff55", b: "#55ffff",
  c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff",
};

export interface TextRun {
  text: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

/** Splits a description with `§` codes into styled runs, as the game shows it. */
export function parseSectionCodes(input: string): TextRun[] {
  const runs: TextRun[] = [];
  let style = { color: "#aaaaaa", bold: false, italic: false, underline: false, strike: false };
  let text = "";
  const flush = () => {
    if (text) runs.push({ text, ...style });
    text = "";
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "§" && i + 1 < input.length) {
      const code = input[i + 1].toLowerCase();
      i += 1;
      if (code in MC_COLORS) {
        flush();
        // a colour code also resets the formatting, like in the game
        style = { color: MC_COLORS[code], bold: false, italic: false, underline: false, strike: false };
      } else if (code === "l") { flush(); style = { ...style, bold: true }; }
      else if (code === "o") { flush(); style = { ...style, italic: true }; }
      else if (code === "n") { flush(); style = { ...style, underline: true }; }
      else if (code === "m") { flush(); style = { ...style, strike: true }; }
      else if (code === "r") { flush(); style = { color: "#aaaaaa", bold: false, italic: false, underline: false, strike: false }; }
      // §k (obfuscated) and unknown codes are dropped
      continue;
    }
    text += ch;
  }
  flush();
  return runs;
}

/** Joins a folder and a name with the separator the folder already uses. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** Same rule as the Rust side: characters Windows refuses in a file name. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "").trim();
  return cleaned || "pack";
}

// ---- "What's new in this version" ----

export type WhatsNewMode = "new" | "changed" | "renamed";

/** Compares "1.21.11" with "1.8.9" by their numbers (1.21.11 is newer). */
export function compareMc(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Versions the pack can be compared with: usable, not the pack's own, newest first. */
export function compareChoices(versions: VersionView[], packDir: string, packLabel: string): VersionView[] {
  return versions
    .filter((v) => v.usable && v.dir_name !== packDir && v.label !== packLabel)
    .sort((a, b) => compareMc(b.label, a.label) || a.dir_name.localeCompare(b.dir_name));
}

/** The newest version older than the pack's; else the oldest newer one. */
export function defaultCompareVersion(choices: VersionView[], packLabel: string): string | null {
  const older = choices.filter((v) => compareMc(v.label, packLabel) < 0);
  if (older.length) return older[0].dir_name;
  return choices.length ? choices[choices.length - 1].dir_name : null;
}

/** Real renames (not only a new folder name). */
export const realRenames = (w: WhatsNewView) => w.diff.renamed.filter((r) => !r.folder_only);

/** The textures of the pack's version to list for a mode. */
export function whatsNewOnly(w: WhatsNewView, mode: WhatsNewMode): string[] {
  if (mode === "new") return [...w.diff.added];
  if (mode === "changed") return w.diff.changed.map((c) => c.path);
  return realRenames(w).map((r) => r.to);
}

/** Heading of the list (and of a shared list). */
export function whatsNewTitle(w: WhatsNewView, mode: WhatsNewMode): string {
  const { this_version: me, other_version: other, other_is_older: older } = w.diff;
  if (older) {
    if (mode === "new") return `New in ${me} since ${other}`;
    if (mode === "changed") return `Changed by Mojang since ${other}`;
    return `Renamed since ${other}`;
  }
  if (mode === "new") return `In ${me}, gone in ${other}`;
  if (mode === "changed") return `Redrawn by Mojang in ${other}`;
  return `Renamed in ${other}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The summary line: "38 textures are new in 1.21.11 since 1.20.1 · 12 changed
 * by Mojang (4 in your pack) · 5 renamed · 2 removed". `inPack` = changed
 * textures the pack has its own file for.
 */
export function whatsNewNotice(w: WhatsNewView, inPack: number): string {
  const d = w.diff;
  const renamed = realRenames(w).length;
  const moved = d.renamed.length - renamed;
  const parts: string[] = [];
  if (d.other_is_older) {
    parts.push(`${plural(d.added.length, "texture")} ${d.added.length === 1 ? "is" : "are"} new in ${d.this_version} since ${d.other_version}`);
    parts.push(`${d.changed.length} changed by Mojang (${inPack} in your pack)`);
  } else {
    parts.push(`${d.other_version} adds ${plural(d.removed.length, "texture")}`);
    parts.push(`redraws ${d.changed.length} (${inPack} in your pack)`);
  }
  parts.push(`${renamed} renamed${moved ? ` (+${moved} moved to a new folder)` : ""}`);
  if (d.other_is_older) parts.push(`${d.removed.length} removed`);
  else parts.push(`${d.added.length} gone`);
  return parts.join(" · ");
}

// ---- Progress ----

export interface Progress {
  done: number;
  total: number;
  /** 0 to 100, rounded down: 100 only when everything is done. */
  pct: number;
}

export function progressOf(done: number, total: number): Progress {
  return { done, total, pct: total > 0 ? Math.floor((done * 100) / total) : 0 };
}

export interface ProgressStats {
  overall: Progress;
  /** In the app's category order; categories without textures are left out. */
  categories: ({ key: Category; label: string } & Progress)[];
  /** Pack textures last saved today / since Monday (from the file times). */
  today: number;
  week: number;
  /** Pack textures changed after the last export. */
  changed: number;
}

/** Monday 00:00 of the week of `ms`, local time. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

/**
 * Done / total per category and overall. Only the textures of the pack's
 * game version count (a pack file the game does not have is not progress).
 */
export function progressStats(rows: TextureRow[], now: number): ProgressStats {
  const per: Record<string, { done: number; total: number }> = {};
  let done = 0;
  let total = 0;
  let today = 0;
  let week = 0;
  let changed = 0;
  const day0 = startOfDay(now);
  const week0 = startOfWeek(now);
  for (const r of rows) {
    if (r.mine) {
      if (r.mine.modified_ms >= day0) today += 1;
      if (r.mine.modified_ms >= week0) week += 1;
      if (r.status === "changed") changed += 1;
    }
    if (r.extra) continue;
    const c = (per[r.category] ??= { done: 0, total: 0 });
    c.total += 1;
    total += 1;
    if (r.status !== "todo") {
      c.done += 1;
      done += 1;
    }
  }
  return {
    overall: progressOf(done, total),
    categories: CATEGORIES.filter((c) => per[c.key]).map((c) => ({ ...c, ...progressOf(per[c.key].done, per[c.key].total) })),
    today,
    week,
    changed,
  };
}

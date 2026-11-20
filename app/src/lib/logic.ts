// Pure helpers (no React, no Tauri) so they can be unit-tested.
import type { Category, PackFormat, Status, TextureRow } from "./api";

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
}

export const defaultFilters: Filters = {
  category: "blocks",
  status: "all",
  animated: false,
  renamed: false,
  wrongSize: false,
  search: "",
  only: null,
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

export function filterRows(rows: TextureRow[], f: Filters): TextureRow[] {
  if (f.only) {
    const set = new Set(f.only);
    return rows.filter((r) => set.has(r.path));
  }
  const words = searchWords(f.search);
  return rows.filter(
    (r) => (f.category === "all" || r.category === f.category) && passesToggles(r, f) && matchesSearch(r.path, words),
  );
}

/** How many textures match the search in the categories that are not shown. */
export function matchesElsewhere(rows: TextureRow[], f: Filters): number {
  if (f.category === "all" || f.only || searchWords(f.search).length === 0) return 0;
  const words = searchWords(f.search);
  return rows.filter((r) => r.category !== f.category && passesToggles(r, f) && matchesSearch(r.path, words)).length;
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

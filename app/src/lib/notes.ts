// Notes, tags and "assigned to" of a pack: pure helpers (tested). The store
// that keeps `.packcreator/notes.json` loaded is in notesStore.ts.
import type { TextureNote } from "./api";

/** Tags offered even before the pack uses any. */
export const DEFAULT_TAGS = ["needs redo", "waiting feedback", "in progress", "check in game"];

export const emptyNote = (): TextureNote => ({ note: "", tags: [], assignee: "", updated_ms: 0 });

export const hasContent = (n: TextureNote | undefined | null): n is TextureNote =>
  !!n && (n.note.trim() !== "" || n.tags.length > 0 || n.assignee.trim() !== "");

/** "Alex Martin" → "AM", "sam" → "S", "jean-luc" → "JL". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (words.length === 0) return "";
  const letters = words.length === 1 ? [words[0][0]] : [words[0][0], words[words.length - 1][0]];
  return letters.join("").toUpperCase();
}

/** Every distinct value (first spelling wins), most used first, then A→Z. */
function ranked(values: string[]): string[] {
  const seen = new Map<string, { label: string; n: number }>();
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    const e = seen.get(k);
    if (e) e.n += 1;
    else seen.set(k, { label: t, n: 1 });
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).map((e) => e.label);
}

/** Tags already used in the pack, then the default ones not used yet. */
export function tagSuggestions(notes: Record<string, TextureNote>): string[] {
  const used = ranked(Object.values(notes).flatMap((n) => n.tags));
  const lower = new Set(used.map((t) => t.toLowerCase()));
  return [...used, ...DEFAULT_TAGS.filter((t) => !lower.has(t))];
}

/** Tags used in the pack only (side bar filter), most used first. */
export const usedTags = (notes: Record<string, TextureNote>) => ranked(Object.values(notes).flatMap((n) => n.tags));

/** Names already used (plus the user's own), most used first. */
export function nameSuggestions(notes: Record<string, TextureNote>, me = ""): string[] {
  const names = ranked(Object.values(notes).map((n) => n.assignee));
  if (me.trim() && !names.some((n) => n.toLowerCase() === me.trim().toLowerCase())) names.push(me.trim());
  return names;
}

/** Adds a tag unless it is already there (any case). */
export function addTag(tags: string[], tag: string): string[] {
  const t = tag.trim().replace(/\s+/g, " ");
  if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return tags;
  return [...tags, t];
}

/** True when two notes would be stored the same. */
export function sameNote(a: TextureNote, b: TextureNote): boolean {
  return a.note.trim() === b.note.trim()
    && a.assignee.trim() === b.assignee.trim()
    && a.tags.length === b.tags.length
    && a.tags.every((t, i) => t === b.tags[i]);
}

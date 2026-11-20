// Batch import review: what the user ticked and picked, and what gets imported.
// Matching itself is done in Rust (core/src/batch.rs); this is only the review.
import type { BatchItem, BatchItemResult, BatchRow } from "./api";

export interface Choice {
  checked: boolean;
  /** The texture the row becomes (picked by the user for ambiguous rows). */
  target: string | null;
  /** "Use as animation frames" for a tall image without an .mcmeta. */
  frames: boolean;
}

export type Choices = Record<number, Choice>;

export function initialChoices(rows: BatchRow[]): Choices {
  const out: Choices = {};
  for (const r of rows) out[r.id] = { checked: r.accept, target: r.target, frames: r.frames_default };
  return out;
}

/** A row can be ticked when it has a target and a readable image. */
export const canImport = (r: BatchRow, c: Choice | undefined): boolean =>
  !r.problem && !!c?.target && r.status !== "unknown";

/**
 * Ticks or unticks a row. Two files cannot become the same texture: ticking
 * one unticks the others that point at the same texture.
 */
export function setChecked(rows: BatchRow[], choices: Choices, id: number, checked: boolean): Choices {
  const row = rows.find((r) => r.id === id);
  const c = choices[id];
  if (!row || !c || (checked && !canImport(row, c))) return choices;
  const next: Choices = { ...choices, [id]: { ...c, checked } };
  if (checked) {
    for (const r of rows) {
      const o = next[r.id];
      if (r.id !== id && o?.checked && o.target === c.target) next[r.id] = { ...o, checked: false };
    }
  }
  return next;
}

/** Picks the texture of an ambiguous row (and ticks it). */
export function setTarget(rows: BatchRow[], choices: Choices, id: number, target: string | null): Choices {
  const c = choices[id];
  if (!c) return choices;
  const next = { ...choices, [id]: { ...c, target, checked: false } };
  return target ? setChecked(rows, next, id, true) : next;
}

export function setFrames(choices: Choices, id: number, frames: boolean): Choices {
  const c = choices[id];
  return c ? { ...choices, [id]: { ...c, frames } } : choices;
}

/** Ticks every importable new / replacing row that does not clash with another. */
export function checkAll(rows: BatchRow[], choices: Choices, on: boolean): Choices {
  let next = { ...choices };
  for (const r of rows) {
    const c = next[r.id];
    if (!c) continue;
    if (!on) next[r.id] = { ...c, checked: false };
    else if (!c.checked && canImport(r, c) && r.status !== "same" && !r.duplicate) next = setChecked(rows, next, r.id, true);
  }
  return next;
}

/** Textures that more than one row points at (with the current picks). */
export function clashingTargets(rows: BatchRow[], choices: Choices): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const t = choices[r.id]?.target;
    if (t && !r.problem) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
}

/** What a row will do with the current pick: new, replaces or same. */
export function effectiveStatus(r: BatchRow, c: Choice | undefined): BatchRow["status"] {
  if (r.status !== "ambiguous") return r.status;
  if (!c?.target) return "ambiguous";
  return r.candidates.find((x) => x.path === c.target)?.in_pack ? "replaces" : "new";
}

export interface Plan {
  items: BatchItem[];
  /** Ticked rows that are not imported, and why. */
  skipped: { row: BatchRow; reason: string }[];
}

/**
 * The items to send to Rust. A texture with unsaved changes in an editor tab
 * is never replaced: that row is skipped with the reason.
 */
export function planImport(rows: BatchRow[], choices: Choices, unsaved: Set<string>): Plan {
  const plan: Plan = { items: [], skipped: [] };
  for (const r of rows) {
    const c = choices[r.id];
    if (!c?.checked || !c.target || !canImport(r, c)) continue;
    if (unsaved.has(c.target)) {
      plan.skipped.push({ row: r, reason: `${c.target} has unsaved changes in the editor. Save or close it first.` });
      continue;
    }
    plan.items.push({ id: r.id, target: c.target, frames: !!r.strip_frames && c.frames });
  }
  return plan;
}

export interface Counts {
  total: number;
  new: number;
  replaces: number;
  same: number;
  unknown: number;
  ambiguous: number;
  duplicates: number;
  wrongSize: number;
  checked: number;
}

export function countRows(rows: BatchRow[], choices: Choices): Counts {
  const n: Counts = { total: rows.length, new: 0, replaces: 0, same: 0, unknown: 0, ambiguous: 0, duplicates: 0, wrongSize: 0, checked: 0 };
  for (const r of rows) {
    const c = choices[r.id];
    if (r.problem) n.unknown++;
    else n[r.status]++;
    if (r.duplicate) n.duplicates++;
    if (r.wrong_size) n.wrongSize++;
    if (c?.checked) n.checked++;
  }
  return n;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The toast after an import. */
export function resultSummary(results: BatchItemResult[], skipped: number): string {
  const ok = results.filter((r) => r.ok && !r.unchanged);
  const same = results.filter((r) => r.ok && r.unchanged).length;
  const failed = results.filter((r) => !r.ok).length;
  const replaced = ok.filter((r) => r.replaced).length;
  const parts = [`Imported ${plural(ok.length, "texture")}, not resized`];
  if (replaced) parts.push(`${replaced} replaced (the old files are in the pack's trash)`);
  if (same) parts.push(`${same} already identical`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  return `${parts.join(", ")}.`;
}

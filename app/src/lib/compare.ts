// "Compare with another pack": filters, counts, what "Copy theirs into my
// pack" may copy, and the comparison as shareable text. Pure, so it is tested.
import type { CompareRow, CompareStatus, Comparison } from "./api";
import { baseName, matchesSearch, searchWords } from "./logic";

export type CompareFilter = CompareStatus | "all";

export const COMPARE_LABEL: Record<CompareStatus, string> = {
  only_mine: "Only in mine",
  only_theirs: "Only in theirs",
  different: "Different",
  same: "Identical",
};

/** Name of a row: the texture in my pack's version, else their file. */
export const rowName = (r: CompareRow) => r.path ?? r.theirs ?? "";

export function countCompare(rows: CompareRow[]): Record<CompareFilter, number> {
  const out: Record<CompareFilter, number> = { all: rows.length, only_mine: 0, only_theirs: 0, different: 0, same: 0 };
  for (const r of rows) out[r.status] += 1;
  return out;
}

export function filterCompare(rows: CompareRow[], filter: CompareFilter, search: string): CompareRow[] {
  const words = searchWords(search);
  return rows.filter((r) =>
    (filter === "all" || r.status === filter)
    && (words.length === 0 || matchesSearch(rowName(r), words) || (r.theirs !== null && matchesSearch(r.theirs, words))));
}

/** Their file can be copied over (or into) my pack for this row. */
export const canCopy = (r: CompareRow) =>
  r.path !== null && r.theirs !== null && r.shadowed_by === null && (r.status === "different" || r.status === "only_theirs");

export interface CopyPlan {
  ids: number[];
  /** Ticked rows that are not copied, and why. */
  skipped: { row: CompareRow; reason: string }[];
}

/** Ticked rows to copy; textures with unsaved changes in an editor tab are never replaced. */
export function planCopy(rows: CompareRow[], ticked: Set<number>, unsaved: Set<string>): CopyPlan {
  const plan: CopyPlan = { ids: [], skipped: [] };
  for (const r of rows) {
    if (!ticked.has(r.id) || !canCopy(r)) continue;
    if (unsaved.has(r.path!)) plan.skipped.push({ row: r, reason: "unsaved changes in the editor: save or close it first" });
    else plan.ids.push(r.id);
  }
  return plan;
}

/** "Tick all" for the rows shown. */
export function tickShown(ticked: Set<number>, shown: CompareRow[], on: boolean): Set<number> {
  const next = new Set(ticked);
  for (const r of shown) {
    if (!canCopy(r)) continue;
    if (on) next.add(r.id);
    else next.delete(r.id);
  }
  return next;
}

function sizeText(s: [number, number] | null): string {
  return s ? `${s[0]}×${s[1]}` : "";
}

/** One line of detail for a row ("16×16 → 32×32", "called items/x there"…). */
export function rowNote(r: CompareRow): string {
  const notes: string[] = [];
  if (r.status === "different" && r.mcmeta_differs) notes.push("same pixels, different animation file");
  else if (r.status === "different" && r.their_size && r.my_size && sizeText(r.their_size) !== sizeText(r.my_size)) {
    notes.push(`mine ${sizeText(r.my_size)}, theirs ${sizeText(r.their_size)}`);
  }
  if (r.renamed_from) notes.push(`called ${r.renamed_from} in their pack`);
  if (r.path === null) notes.push("not a texture of this version");
  if (r.shadowed_by) notes.push(`not used: ${r.shadowed_by} is used instead`);
  return notes.join(" · ");
}

export type CompareShareFormat = "markdown" | "text";

/** The comparison as text, grouped by result (identical textures left out unless asked). */
export function compareShareText(
  c: Comparison,
  opts: { format: CompareShareFormat; myName: string; subtitle: string; includeSame: boolean },
): string {
  const md = opts.format === "markdown";
  const counts = countCompare(c.rows);
  const lines: string[] = [];
  lines.push(md ? `# ${opts.myName} compared with ${c.name}` : `${opts.myName} compared with ${c.name}`);
  lines.push(md ? `_${opts.subtitle}_` : opts.subtitle);
  lines.push("");
  lines.push(
    `${counts.different} different · ${counts.only_mine} only in ${opts.myName} · ${counts.only_theirs} only in ${c.name} · ${counts.same} identical`,
  );
  const groups: [CompareStatus, string][] = [
    ["different", "Different"],
    ["only_mine", `Only in ${opts.myName}`],
    ["only_theirs", `Only in ${c.name}`],
    ["same", "Identical"],
  ];
  for (const [status, title] of groups) {
    if (status === "same" && !opts.includeSame) continue;
    const rows = c.rows.filter((r) => r.status === status);
    if (rows.length === 0) continue;
    lines.push("");
    lines.push(md ? `## ${title} (${rows.length})` : `${title} (${rows.length})`);
    if (md) lines.push("");
    for (const r of rows) {
      const note = rowNote(r);
      const name = rowName(r);
      lines.push(md ? `- \`${name}\`${note ? ` — ${note}` : ""}` : `  ${name}${note ? `  (${note})` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function compareFileName(myName: string, theirName: string, format: CompareShareFormat): string {
  // eslint-disable-next-line no-control-regex
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "") || "pack";
  return `${clean(myName)} vs ${clean(theirName)}.${format === "markdown" ? "md" : "txt"}`;
}

/** Short file name for the list (the last part of the texture name). */
export const shortName = (r: CompareRow) => baseName(rowName(r));

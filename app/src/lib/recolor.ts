// Pure helpers of "Recolour textures" and "Make variants": which textures are
// chosen, which are skipped, what the toast says. The pixel work is in Rust
// (core/src/recolor.rs).
import type { Adjust, Category, Recolor, TextureRow, WriteReport } from "./api";
import { baseName, folderOf, matchesSearch, searchWords } from "./logic";

export const NO_ADJUST: Adjust = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };

/** True when the recolour would change nothing at all. */
export function changesNothing(op: Recolor): boolean {
  if (op.kind === "adjust") return op.hue % 360 === 0 && op.saturation === 0 && op.brightness === 0 && op.contrast === 0;
  return op.pairs.every((p) => p.from.toLowerCase() === p.to.toLowerCase());
}

/**
 * Textures chosen by a search and a category ("all" = every category).
 * A texture the game does not have is only offered when the pack has it.
 */
export function pickTextures(rows: TextureRow[], search: string, category: Category | "all"): TextureRow[] {
  const words = searchWords(search);
  return rows.filter((r) => (category === "all" || r.category === category) && (!r.extra || !!r.mine) && matchesSearch(r.path, words));
}

export interface Skipped {
  path: string;
  reason: string;
}

/** Textures open with unsaved changes in the editor are never written: they are skipped with a reason. */
export function splitUnsaved(paths: string[], unsaved: Set<string>): { ok: string[]; skipped: Skipped[] } {
  const ok: string[] = [];
  const skipped: Skipped[] = [];
  for (const p of paths) {
    if (unsaved.has(p)) skipped.push({ path: p, reason: "it has unsaved changes in the editor: save or close it first" });
    else ok.push(p);
  }
  return { ok, skipped };
}

/** Toast text after a write: what changed, what was kept in the trash, what was skipped or failed. */
export function writeSummary(verb: string, report: WriteReport, skipped: number): string {
  const n = report.replaced.length + report.created.length;
  const parts = [`${verb} ${n} texture${n === 1 ? "" : "s"}`];
  if (report.replaced.length > 0) parts.push(`${report.replaced.length} earlier file${report.replaced.length === 1 ? " is" : "s are"} in the pack's trash`);
  if (skipped > 0) parts.push(`${skipped} skipped (unsaved in the editor)`);
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
  return `${parts.join(", ")}.`;
}

// ------------------------------------------------------------- variants

/**
 * Textures of the same family as `path`, offered by "Make variants":
 * the same folder and the same last word with the same number of words
 * (`oak_planks` → `spruce_planks`, `bamboo_planks`…). When there are none,
 * the same first word and number of words instead. The texture itself is
 * never in the list; the user can add and remove textures.
 */
export function familyOf(path: string, all: string[]): string[] {
  const folder = folderOf(path);
  const words = baseName(path).split("_");
  const same = all.filter((p) => p !== path && folderOf(p) === folder);
  const parts = (p: string) => baseName(p).split("_");
  if (words.length > 1) {
    const last = words[words.length - 1];
    const bySuffix = same.filter((p) => {
      const w = parts(p);
      return w.length === words.length && w[w.length - 1] === last;
    });
    if (bySuffix.length > 0) return bySuffix.sort();
    const first = words[0];
    const byPrefix = same.filter((p) => {
      const w = parts(p);
      return w.length === words.length && w[0] === first;
    });
    if (byPrefix.length > 0) return byPrefix.sort();
  }
  return [];
}

/** Adds a texture typed by the user (by full path or by name) to the list, if it exists. */
export function addToFamily(list: string[], typed: string, all: string[], source: string): { list: string[]; error: string | null } {
  const t = typed.trim().toLowerCase().replace(/\.png$/, "");
  if (!t) return { list, error: null };
  const folder = folderOf(source);
  const found = all.find((p) => p === t) ?? all.find((p) => p === `${folder}/${t}`) ?? all.find((p) => baseName(p) === t);
  if (!found) return { list, error: `No texture called ${t} in this version.` };
  if (found === source) return { list, error: "That is the texture the variants are made from." };
  if (list.includes(found)) return { list, error: null };
  return { list: [...list, found], error: null };
}

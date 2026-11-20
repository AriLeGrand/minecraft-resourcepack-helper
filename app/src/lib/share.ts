// "Share the to-do list": turns the texture list into text people can paste
// (Discord, GitHub, Notion…) or open in a spreadsheet. Pure, so it is tested.
import type { Category, TextureRow } from "./api";
import { baseName, CATEGORIES, safeFileName } from "./logic";

export type ShareFormat = "checklist" | "text" | "csv";

export interface ShareOptions {
  format: ShareFormat;
  /** Also list finished textures (ticked). Off = only what is left to do. */
  includeDone: boolean;
  packName: string;
  /** e.g. "Java 1.21.11 · 32×". */
  subtitle: string;
  now: number;
}

export const SHARE_FORMATS: { key: ShareFormat; label: string; ext: string; hint: string }[] = [
  { key: "checklist", label: "Checklist", ext: "md", hint: "Ticks show in Discord, GitHub, Notion and Obsidian" },
  { key: "text", label: "Plain text", ext: "txt", hint: "Works anywhere, one texture per line" },
  { key: "csv", label: "Spreadsheet", ext: "csv", hint: "Opens in Excel, LibreOffice or Google Sheets" },
];

/** Done in the pack (a changed texture is in the pack too). */
const isDone = (r: TextureRow) => r.status !== "todo";

function sizeOf(r: TextureRow): string {
  const w = r.mine?.width ?? r.width;
  const h = r.mine?.height ?? r.height;
  return w && h ? `${w}×${h}` : "";
}

function notes(r: TextureRow): string[] {
  const out: string[] = [];
  if (r.animated) out.push(`animated, ${r.frames} frames`);
  if (r.status === "changed") out.push("changed since export");
  if (r.wrong_size) out.push("wrong size");
  return out;
}

/** Rows to share, grouped by category in the app's order, sorted by name. */
export function groupForShare(rows: TextureRow[], includeDone: boolean): { key: Category; label: string; rows: TextureRow[] }[] {
  const kept = rows.filter((r) => !r.extra && (includeDone || !isDone(r)));
  return CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    rows: kept.filter((r) => r.category === c.key).sort((a, b) => a.path.localeCompare(b.path)),
  })).filter((g) => g.rows.length > 0);
}

/** "2026-11-20" in the computer's own time zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The shared text. `rows` is what the user chose to share (filtered or whole pack). */
export function formatShareList(rows: TextureRow[], o: ShareOptions): string {
  const groups = groupForShare(rows, o.includeDone);
  const all = rows.filter((r) => !r.extra);
  const done = all.filter(isDone).length;
  const left = all.length - done;

  if (o.format === "csv") {
    const lines = [["category", "texture", "file", "status", "size", "animated", "frames", "notes"].join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        lines.push(
          [g.label, baseName(r.path), `textures/${r.path}.png`, isDone(r) ? "done" : "to do", sizeOf(r), r.animated ? "yes" : "no", r.frames, notes(r).join("; ")]
            .map(csvCell)
            .join(","),
        );
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  const md = o.format === "checklist";
  const out: string[] = [];
  const title = `${o.packName}: to-do list`;
  out.push(md ? `# ${title}` : title);
  out.push(`${o.subtitle} · ${done} / ${all.length} done, ${left} to do · ${localDate(o.now)}`);
  if (groups.length === 0) {
    out.push("");
    out.push(o.includeDone ? "No textures in this list." : "Nothing left to do. Every texture in this list is done.");
  }
  for (const g of groups) {
    const gDone = g.rows.filter(isDone).length;
    const gLeft = g.rows.length - gDone;
    const head = o.includeDone ? `${g.label} (${gLeft} to do, ${gDone} done)` : `${g.label} (${gLeft} to do)`;
    out.push("");
    out.push(md ? `## ${head}` : head);
    for (const r of g.rows) {
      const n = notes(r);
      const extra = n.length ? ` (${n.join(", ")})` : "";
      if (md) out.push(`- [${isDone(r) ? "x" : " "}] ${baseName(r.path)}: \`textures/${r.path}.png\`${extra}`);
      else out.push(`[${isDone(r) ? "x" : " "}] ${baseName(r.path)}  textures/${r.path}.png${extra}`);
    }
  }
  return out.join("\n") + "\n";
}

/** "Deep Sea Pack to-do list.md" */
export function shareFileName(packName: string, format: ShareFormat): string {
  const ext = SHARE_FORMATS.find((f) => f.key === format)!.ext;
  return `${safeFileName(packName)} to-do list.${ext}`;
}

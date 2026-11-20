// What the Tiled preview says about seams (the measure itself is in Rust,
// core/src/seams.rs). Pure.
import type { SeamReport } from "../lib/api";

/** The note under the Tiled preview, or `null` when the texture tiles cleanly. */
export function seamMessage(r: SeamReport | null): string | null {
  if (!r) return null;
  const lr = r.columns.seam;
  const tb = r.rows.seam;
  if (lr && tb) return "Seams on the left/right and top/bottom edges";
  if (lr) return "Seam on the left/right edge";
  if (tb) return "Seam on the top/bottom edge";
  return null;
}

/** Displayed size of one tile in a `PixelView` (same rule: whole-number enlargement when it fits). */
export function tileSize(w: number, h: number, box: number, repeat: number): { tw: number; th: number } {
  const scale = Math.min(box / (w * repeat), box / (h * repeat));
  const s = scale >= 1 ? Math.floor(scale) : scale;
  return { tw: w * s, th: h * s };
}

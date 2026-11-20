// Cell maths of the shared particle sheet used before 1.14
// (`textures/particle/particles.png`): a square grid (16×16) of equal cells,
// 8×8 px each in the game's 128×128 sheet, larger in high-resolution packs.
// The same as `cell_rect` / `cell_at` in core/src/particles.rs.
import type { Mask } from "../editor/pixels";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixel rectangle of a cell in a sheet `sheetPx` wide, or `null` when it does not fit the grid. */
export function cellRect(cell: number, sheetPx: number, grid = 16): Rect | null {
  if (!Number.isInteger(cell) || cell < 0 || cell >= grid * grid || sheetPx <= 0 || sheetPx % grid !== 0) return null;
  const size = sheetPx / grid;
  return { x: (cell % grid) * size, y: Math.floor(cell / grid) * size, w: size, h: size };
}

/** The cell under a pixel, or `null` outside the sheet. */
export function cellAt(x: number, y: number, sheetPx: number, grid = 16): number | null {
  if (sheetPx <= 0 || sheetPx % grid !== 0 || x < 0 || y < 0 || x >= sheetPx || y >= sheetPx) return null;
  const size = sheetPx / grid;
  return Math.floor(y / size) * grid + Math.floor(x / size);
}

/** Every cell once, in the order given. */
export const uniqueCells = (cells: number[]) => [...new Set(cells)];

/**
 * The editable region for these cells in an image of `w`×`h` (the sheet is
 * square; a sheet that does not fit the grid gives an empty region).
 */
export function cellsMask(cells: number[], w: number, h: number, grid = 16): Mask {
  const mask = new Uint8Array(w * h);
  if (w !== h) return mask;
  for (const c of uniqueCells(cells)) {
    const r = cellRect(c, w, grid);
    if (!r) continue;
    for (let y = r.y; y < r.y + r.h; y++) mask.fill(1, y * w + r.x, y * w + r.x + r.w);
  }
  return mask;
}

/** Cells as a short list for people: "80", "0–7", "225–250", "19–22, 32". */
export function cellsLabel(cells: number[]): string {
  const sorted = uniqueCells(cells).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

// OptiFine's "compact" connected textures (method=ctm_compact), for the
// preview: which of the five tiles each quarter of a block face shows.
//
// References: the OptiFine documentation (ctm.properties: "Compact 8-way
// method, uses 5 tiles") and Continuity's CompactCtmQuadProcessor, which
// reimplements it: each face is cut into four quarters and every quarter is
// taken from one tile, chosen from the two neighbours on its sides and the
// one across its corner:
//   neither side connected            → 0 (the full border)
//   only the left/right side          → 3 (borders top and bottom)
//   only the top/bottom side          → 2 (borders left and right)
//   both sides, corner not connected  → 4 (inner corner)
//   both sides and the corner         → 1 (no border)
// "Connected" here is connect=block: the neighbour is the same block.

/** The eight neighbours of a face, as seen on the face (up = top of the texture). */
export interface Around {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  upLeft: boolean;
  upRight: boolean;
  downLeft: boolean;
  downRight: boolean;
}

/** Tile for one quarter from its horizontal side, vertical side and corner neighbour. */
export function quarterTile(side: boolean, vertical: boolean, corner: boolean): number {
  if (side && vertical) return corner ? 1 : 4;
  if (side) return 3;
  if (vertical) return 2;
  return 0;
}

/** Tiles of the four quarters: top-left, top-right, bottom-left, bottom-right. */
export function quarters(a: Around): [number, number, number, number] {
  return [
    quarterTile(a.left, a.up, a.upLeft),
    quarterTile(a.right, a.up, a.upRight),
    quarterTile(a.left, a.down, a.downLeft),
    quarterTile(a.right, a.down, a.downRight),
  ];
}

/** A wall seen from the front: `grid[row][col]` is true where the block is. */
export type Grid = boolean[][];

export function around(grid: Grid, row: number, col: number): Around {
  const at = (r: number, c: number) => grid[r]?.[c] === true;
  return {
    up: at(row - 1, col), down: at(row + 1, col), left: at(row, col - 1), right: at(row, col + 1),
    upLeft: at(row - 1, col - 1), upRight: at(row - 1, col + 1), downLeft: at(row + 1, col - 1), downRight: at(row + 1, col + 1),
  };
}

/** Parses a picture like ["##.", "#.."] into a grid. */
export function gridOf(rows: string[]): Grid {
  return rows.map((r) => [...r].map((ch) => ch === "#"));
}

/** The preview: a 4×4 wall, a gap, and an L shape (which shows the inner corner tile). */
export const PREVIEW = gridOf([
  "####.#...",
  "####.#...",
  "####.#...",
  "####.####",
]);

/** Where each quarter of each block of a grid comes from: `{row, col, quarter, tile}`. */
export function layout(grid: Grid): { row: number; col: number; quarter: number; tile: number }[] {
  const out: { row: number; col: number; quarter: number; tile: number }[] = [];
  grid.forEach((cells, row) => cells.forEach((on, col) => {
    if (!on) return;
    quarters(around(grid, row, col)).forEach((tile, quarter) => out.push({ row, col, quarter, tile }));
  }));
  return out;
}

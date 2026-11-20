// The blocks of a scene as a 3D grid, and the preset scenes. Pure, tested.
//
// x goes east, y up, z south (the game's axes); cell (x, y, z) is the block
// whose corner is at (x, y, z). Index `(y * depth + z) * width + x`, as in
// `.packcreator/scene.json` (Rust `core/src/scene.rs`).
import type { FaceDir, SceneFile } from "../lib/api";

export interface SceneGrid {
  width: number;
  depth: number;
  height: number;
  /** Block id per cell, "" = air. */
  blocks: string[];
}

export type Cell = [number, number, number];

/** Limits of the custom scene (same as Rust). */
export const MAX_WIDTH = 8;
export const MAX_DEPTH = 8;
export const MAX_HEIGHT = 4;

export const DIR_OFFSET: Record<FaceDir, Cell> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

export function makeGrid(width: number, depth: number, height: number, fill = ""): SceneGrid {
  return { width, depth, height, blocks: new Array<string>(width * depth * height).fill(fill) };
}

export const inside = (g: SceneGrid, x: number, y: number, z: number) =>
  x >= 0 && y >= 0 && z >= 0 && x < g.width && y < g.height && z < g.depth;

export const cellIndex = (g: SceneGrid, x: number, y: number, z: number) => (y * g.depth + z) * g.width + x;

export function cellOf(g: SceneGrid, i: number): Cell {
  const x = i % g.width;
  const z = Math.floor(i / g.width) % g.depth;
  const y = Math.floor(i / (g.width * g.depth));
  return [x, y, z];
}

/** The block at a cell; "" for air and for anything outside the grid. */
export function blockAt(g: SceneGrid, x: number, y: number, z: number): string {
  return inside(g, x, y, z) ? g.blocks[cellIndex(g, x, y, z)] : "";
}

/** A copy with one cell changed (cells outside are ignored). */
export function setBlock(g: SceneGrid, x: number, y: number, z: number, id: string): SceneGrid {
  if (!inside(g, x, y, z)) return g;
  const blocks = g.blocks.slice();
  blocks[cellIndex(g, x, y, z)] = id;
  return { ...g, blocks };
}

/** The block next to a cell in a direction ("" outside). */
export function neighbour(g: SceneGrid, [x, y, z]: Cell, dir: FaceDir): string {
  const [dx, dy, dz] = DIR_OFFSET[dir];
  return blockAt(g, x + dx, y + dy, z + dz);
}

/** A grid of another size; the cells that still fit keep their block. */
export function resizeGrid(g: SceneGrid, width: number, depth: number, height: number): SceneGrid {
  const w = clampInt(width, 1, MAX_WIDTH);
  const d = clampInt(depth, 1, MAX_DEPTH);
  const h = clampInt(height, 1, MAX_HEIGHT);
  const out = makeGrid(w, d, h);
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    out.blocks[cellIndex(out, x, y, z)] = blockAt(g, x, y, z);
  }
  return out;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
}

/** Every block id used, sorted, without air. */
export function usedIds(g: SceneGrid): string[] {
  return [...new Set(g.blocks.filter((b) => b !== ""))].sort();
}

export function toSceneFile(g: SceneGrid): SceneFile {
  return { version: 1, width: g.width, depth: g.depth, height: g.height, blocks: g.blocks.slice() };
}

/** A custom scene from the file, cut to the limits (a damaged size gives `null`). */
export function fromSceneFile(f: SceneFile): SceneGrid | null {
  if (f.blocks.length !== f.width * f.depth * f.height) return null;
  const g: SceneGrid = { width: f.width, depth: f.depth, height: f.height, blocks: f.blocks.slice() };
  return resizeGrid(g, f.width, f.depth, f.height);
}

// ---- presets ----

/**
 * Block ids to try for each role, newest name first (1.21, then older names
 * such as 1.8.9's). The first one the game version has is used.
 */
export const ROLES = {
  planks: ["oak_planks", "planks"],
  log: ["oak_log", "log"],
  glass: ["glass"],
  slab: ["oak_slab", "half_slab_oak", "wooden_slab"],
  grass: ["grass_block", "grass_normal", "grass"],
  dirt: ["dirt"],
  path: ["dirt_path", "grass_path", "coarse_dirt", "gravel", "dirt"],
  plant: ["short_grass", "grass", "tallgrass", "tall_grass", "fern"],
  flower: ["poppy", "rose", "red_flower"],
  flower2: ["dandelion", "yellow_flower", "poppy", "rose"],
  leaves: ["oak_leaves", "leaves_oak", "leaves"],
} as const;

export type Role = keyof typeof ROLES;

/**
 * The id for a role among the blocks the version has. "grass" is the plant
 * only where "grass_block" exists (in 1.8.9 "grass" is the grass block).
 * Falls back to the newest name, which then shows as missing.
 */
export function pickRole(role: Role, available: ReadonlySet<string>): string {
  for (const id of ROLES[role]) {
    if (role === "plant" && id === "grass" && !available.has("grass_block")) continue;
    if (role === "grass" && id === "grass" && available.has("grass_block")) continue;
    if (available.has(id)) return id;
  }
  return ROLES[role][0];
}

export type PresetId = "house" | "wall" | "garden" | "custom";

export const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: "house", label: "Little house", hint: "Planks and logs, glass windows, a door gap, a slab roof, grass and flowers" },
  { id: "wall", label: "Wall test 4×4", hint: "One block repeated: tiling and seams" },
  { id: "garden", label: "Garden", hint: "Grass, a dirt path, plants, flowers and two small trees" },
  { id: "custom", label: "Custom", hint: "Your own scene, up to 8×8×4, saved with the pack" },
];

type Pick = (role: Role) => string;

/** 9 × 9 ground, a 5 × 5 house with a log frame, windows, a door gap and a slab roof. */
export function houseScene(pick: Pick): SceneGrid {
  let g = makeGrid(9, 9, 5);
  const put = (x: number, y: number, z: number, id: string) => { g = setBlock(g, x, y, z, id); };
  for (let z = 0; z < 9; z++) for (let x = 0; x < 9; x++) put(x, 0, z, pick("grass"));
  // path from the door to the edge
  put(4, 0, 7, pick("path"));
  put(4, 0, 8, pick("path"));
  // walls: x 2..6, z 2..6, y 1..3
  for (let y = 1; y <= 3; y++) for (let z = 2; z <= 6; z++) for (let x = 2; x <= 6; x++) {
    const edgeX = x === 2 || x === 6;
    const edgeZ = z === 2 || z === 6;
    if (!edgeX && !edgeZ) continue;
    put(x, y, z, edgeX && edgeZ ? pick("log") : pick("planks"));
  }
  // windows in the middle of three walls, a door gap in the south wall
  put(4, 2, 2, pick("glass"));
  put(2, 2, 4, pick("glass"));
  put(6, 2, 4, pick("glass"));
  put(4, 1, 6, "");
  put(4, 2, 6, "");
  // roof: slabs with one block of overhang
  for (let z = 1; z <= 7; z++) for (let x = 1; x <= 7; x++) put(x, 4, z, pick("slab"));
  // outside
  put(1, 1, 7, pick("flower"));
  put(7, 1, 7, pick("flower2"));
  put(7, 1, 1, pick("plant"));
  put(0, 1, 4, pick("plant"));
  put(5, 1, 8, pick("plant"));
  put(1, 1, 1, pick("flower"));
  return g;
}

/** One block, 4 × 4, standing as a wall. */
export function wallScene(id: string): SceneGrid {
  return makeGrid(4, 1, 4, id);
}

/** 8 × 8 of grass with a dirt path, plants, flowers and two small trees. */
export function gardenScene(pick: Pick): SceneGrid {
  let g = makeGrid(8, 8, 5);
  const put = (x: number, y: number, z: number, id: string) => { g = setBlock(g, x, y, z, id); };
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) put(x, 0, z, x === 3 || (z === 5 && x > 3) ? pick("path") : pick("grass"));
  put(2, 0, 2, pick("dirt"));
  const tree = (tx: number, tz: number) => {
    for (let y = 1; y <= 3; y++) put(tx, y, tz, pick("log"));
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      put(tx + dx, 3, tz + dz, pick("leaves"));
    }
    put(tx, 4, tz, pick("leaves"));
    put(tx + 1, 4, tz, pick("leaves"));
    put(tx, 4, tz + 1, pick("leaves"));
  };
  tree(1, 6);
  tree(6, 1);
  const plants: [number, number, Role][] = [
    [0, 0, "plant"], [2, 1, "flower"], [5, 3, "plant"], [6, 4, "flower2"], [4, 7, "plant"],
    [7, 7, "flower"], [5, 6, "plant"], [0, 3, "flower2"], [2, 4, "plant"], [4, 2, "flower"],
  ];
  for (const [x, z, role] of plants) put(x, 1, z, pick(role));
  return g;
}

/** A new custom scene: 8 × 8 of grass, room for three layers above. */
export function newCustomScene(grass: string): SceneGrid {
  const g = makeGrid(MAX_WIDTH, MAX_DEPTH, MAX_HEIGHT);
  for (let i = 0; i < MAX_WIDTH * MAX_DEPTH; i++) g.blocks[i] = grass;
  return g;
}

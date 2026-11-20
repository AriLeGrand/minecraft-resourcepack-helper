// Showcase image and page text for CurseForge / Modrinth. Pure (no React, no
// Tauri): which textures to show, where every one goes on the image, and the
// Markdown text. The canvas drawing itself lives in components/Showcase.tsx.
import type { Category, TextureRow } from "./api";
import { bytesLabel, parseSectionCodes } from "./logic";

export const SHOWCASE_MAX = 24;
export const SHOWCASE_W = 1920;
export const SHOWCASE_H = 1080;

/** Image regions, in pixels of the 1920×1080 image. */
export const SHOWCASE_BOX = {
  margin: 72,
  /** Height of the header (icon, name, description). */
  header: 200,
  /** Height of the footer line ("Made for Minecraft Java …"). */
  footer: 70,
  gap: 20,
};

const FIRST: Category[] = ["blocks", "items"];

/**
 * The default choice: textures the pack has, blocks and items first, each
 * group most recently edited first.
 */
export function defaultShowcase(rows: TextureRow[], max = SHOWCASE_MAX): string[] {
  const mine = rows.filter((r) => r.mine && !r.extra);
  const recent = (a: TextureRow, b: TextureRow) => (b.mine!.modified_ms - a.mine!.modified_ms) || a.path.localeCompare(b.path);
  const first = mine.filter((r) => FIRST.includes(r.category)).sort(recent);
  const rest = mine.filter((r) => !FIRST.includes(r.category)).sort(recent);
  return [...first, ...rest].slice(0, max).map((r) => r.path);
}

/** Part of a texture to draw: the first frame of an animation strip, else all of it. */
export function sourceRect(w: number, h: number, animated: boolean): [number, number, number, number] {
  if (animated && h > w && h % w === 0) return [0, 0, w, w];
  return [0, 0, w, h];
}

export interface Tile {
  /** Cell on the image. */
  cell: [number, number, number];
  /** Where the texture is drawn: x, y, width, height (whole pixels). */
  dest: [number, number, number, number];
}

export interface GridLayout {
  cols: number;
  rows: number;
  /** Side of a square cell. */
  cell: number;
  tiles: Tile[];
}

/**
 * Places `sizes` (the drawn part of each texture) in a grid of square cells
 * filling the area `[x, y, w, h]` as well as possible. Each texture is scaled
 * by a whole number when it fits (hard pixels stay square and equal), or
 * shrunk to fit when it is bigger than its cell. Everything is centred.
 */
export function gridLayout(area: [number, number, number, number], sizes: [number, number][], gap: number): GridLayout {
  const [ax, ay, aw, ah] = area;
  const n = sizes.length;
  if (n === 0) return { cols: 0, rows: 0, cell: 0, tiles: [] };
  let best = { cols: 1, rows: n, cell: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cell = Math.floor(Math.min((aw - (cols - 1) * gap) / cols, (ah - (rows - 1) * gap) / rows));
    if (cell > best.cell) best = { cols, rows, cell };
  }
  const { cols, rows, cell } = best;
  const usedW = cols * cell + (cols - 1) * gap;
  const usedH = rows * cell + (rows - 1) * gap;
  const x0 = ax + Math.floor((aw - usedW) / 2);
  const y0 = ay + Math.floor((ah - usedH) / 2);
  const tiles = sizes.map(([w, h], i) => {
    const row = Math.floor(i / cols);
    // the last row is centred on its own
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const rowX = x0 + Math.floor(((cols - inRow) * (cell + gap)) / 2);
    const cx = rowX + (i - row * cols) * (cell + gap);
    const cy = y0 + row * (cell + gap);
    const side = Math.max(w, h, 1);
    let dw: number;
    let dh: number;
    if (side <= cell) {
      const k = Math.floor(cell / side);
      dw = w * k;
      dh = h * k;
    } else {
      dw = Math.max(1, Math.floor((w * cell) / side));
      dh = Math.max(1, Math.floor((h * cell) / side));
    }
    return {
      cell: [cx, cy, cell] as [number, number, number],
      dest: [cx + Math.floor((cell - dw) / 2), cy + Math.floor((cell - dh) / 2), dw, dh] as [number, number, number, number],
    };
  });
  return { cols, rows, cell, tiles };
}

/** The grid area of the showcase image, below the header and above the footer. */
export function showcaseArea(): [number, number, number, number] {
  const { margin, header, footer } = SHOWCASE_BOX;
  return [margin, margin + header, SHOWCASE_W - 2 * margin, SHOWCASE_H - 2 * margin - header - footer];
}

/** "Made for Minecraft Java 1.21.11, 1.8.9 · 32×". */
export function madeForLine(versions: string[], resolution: number): string {
  return `Made for Minecraft Java ${versions.join(", ")} · ${resolution}×`;
}

/** The description without its § codes. */
export function plainDescription(desc: string): string {
  return parseSectionCodes(desc).map((r) => r.text).join("").trim();
}

// ---- page text (CurseForge / Modrinth)

export interface PageInfo {
  name: string;
  description: string;
  /** Main version first, then the export copies. */
  versions: string[];
  resolution: number;
  /** Every texture of the pack's version, with the pack's file when it has one. */
  rows: TextureRow[];
  /** File name of the export, e.g. "Deep Sea Pack 1.21.11.zip". */
  zipName: string;
}

export interface PageCounts {
  total: number;
  blocks: number;
  items: number;
  gui: number;
  entities: number;
  particles: number;
  other: number;
  animated: number;
  /** Textures of each kind in the game's version. */
  gameBlocks: number;
  gameItems: number;
}

export function pageCounts(rows: TextureRow[]): PageCounts {
  const mine = rows.filter((r) => r.mine && !r.extra);
  const n = (c: Category) => mine.filter((r) => r.category === c).length;
  const counted = n("blocks") + n("items") + n("gui") + n("entities") + n("particles");
  return {
    total: mine.length,
    blocks: n("blocks"),
    items: n("items"),
    gui: n("gui"),
    entities: n("entities"),
    particles: n("particles"),
    other: mine.length - counted,
    animated: mine.filter((r) => r.mine!.animated).length,
    gameBlocks: rows.filter((r) => !r.extra && r.category === "blocks").length,
    gameItems: rows.filter((r) => !r.extra && r.category === "items").length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One short line for the summary field (Modrinth allows 256 characters). */
export function pageSummary(info: PageInfo): string {
  const desc = plainDescription(info.description);
  const base = desc || `A ${info.resolution}× resource pack`;
  const line = `${base} · ${info.resolution}× · Minecraft Java ${info.versions.join(", ")}`;
  return line.length <= 256 ? line : `${line.slice(0, 255)}…`;
}

/** The page body in Markdown (both sites accept it). */
export function pageMarkdown(info: PageInfo): string {
  const c = pageCounts(info.rows);
  const desc = plainDescription(info.description);
  const lines: string[] = [`# ${info.name}`, ""];
  if (desc) lines.push(desc, "");

  lines.push("## Supported versions", "");
  info.versions.forEach((v, i) => lines.push(`- Minecraft Java ${v}${i === 0 && info.versions.length > 1 ? " (main version)" : ""}`));
  lines.push("", `**Resolution:** ${info.resolution}×`, "");

  lines.push("## What's inside", "");
  const inside: string[] = [];
  if (c.blocks) inside.push(`${plural(c.blocks, "block")}${c.gameBlocks ? ` (of ${c.gameBlocks})` : ""}`);
  if (c.items) inside.push(`${plural(c.items, "item")}${c.gameItems ? ` (of ${c.gameItems})` : ""}`);
  if (c.gui) inside.push(plural(c.gui, "interface (GUI) texture"));
  if (c.entities) inside.push(plural(c.entities, "mob and entity texture"));
  if (c.particles) inside.push(plural(c.particles, "particle"));
  if (c.other) inside.push(plural(c.other, "other texture"));
  if (c.animated) inside.push(plural(c.animated, "animated texture"));
  if (inside.length === 0) inside.push("No textures yet");
  for (const s of inside) lines.push(`- ${s}`);
  lines.push("", `${plural(c.total, "texture")} in total.`, "");

  lines.push("## Features", "");
  const features: string[] = [`Every texture drawn at ${info.resolution}×${info.resolution} pixels per block`];
  if (c.animated) features.push("Animated textures");
  if (c.gui) features.push("Redrawn interface (menus, buttons, inventory)");
  if (info.versions.length > 1) features.push(`One pack for ${plural(info.versions.length, "Minecraft version")}: names are converted for each`);
  features.push("Only changes how things look: works with any world and server");
  for (const f of features) lines.push(`- ${f}`);
  lines.push("");

  lines.push("## How to install", "");
  lines.push(
    `1. Download \`${info.zipName}\` (do not unzip it).`,
    "2. In Minecraft, open **Options → Resource Packs → Open Pack Folder**.",
    "3. Put the .zip file in that folder.",
    `4. Back in Minecraft, move **${info.name}** to the *Selected* side and click **Done**.`,
    "",
  );
  if (info.versions.length > 1) {
    lines.push(`Use the file made for your Minecraft version (${info.versions.join(", ")}).`, "");
  }
  return lines.join("\n");
}

/** "Saved 1.2 MB (38%)" for the export toast. */
export function savingsLabel(before: number, after: number): string {
  const saved = Math.max(0, before - after);
  if (saved === 0 || before === 0) return "The PNG files were already as small as they can be.";
  const pct = Math.round((saved / before) * 100);
  return `Saved ${bytesLabel(saved)} (${pct}%) on PNG files, same pixels.`;
}

/** File name for the saved page text. */
export function pageFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "") || "pack";
  return `${cleaned} page.md`;
}

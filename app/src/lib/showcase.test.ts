import { describe, expect, it } from "vitest";
import type { Category, TextureRow } from "./api";
import {
  defaultShowcase, gridLayout, savingsLabel, madeForLine, pageCounts, pageFileName, pageMarkdown, pageSummary, plainDescription, showcaseArea,
  SHOWCASE_H, SHOWCASE_W, sourceRect,
} from "./showcase";

const row = (path: string, category: Category, modified: number | null, extra: Partial<TextureRow> = {}): TextureRow => ({
  path,
  category,
  width: 16,
  height: 16,
  animated: false,
  frames: 1,
  has_thumb: true,
  status: modified === null ? "todo" : "done",
  mine: modified === null ? null : {
    path, width: 32, height: 32, modified_ms: modified, has_mcmeta: false, animated: false, frames: 1, file_size: 100,
  },
  wrong_size: false,
  renamed: false,
  extra: false,
  ...extra,
});

describe("default choice", () => {
  it("takes blocks and items first, most recent first, only textures the pack has", () => {
    const rows = [
      row("entity/creeper/creeper", "entities", 900),
      row("block/stone", "blocks", 100),
      row("item/diamond", "items", 300),
      row("block/dirt", "blocks", 200),
      row("block/sand", "blocks", null),
      row("gui/sprites/widget/button", "gui", 50),
      row("block/my_own", "blocks", 999, { extra: true }),
    ];
    expect(defaultShowcase(rows)).toEqual(["item/diamond", "block/dirt", "block/stone", "entity/creeper/creeper", "gui/sprites/widget/button"]);
    expect(defaultShowcase(rows, 2)).toEqual(["item/diamond", "block/dirt"]);
  });
});

describe("layout", () => {
  it("shows the first frame of an animation strip", () => {
    expect(sourceRect(16, 64, true)).toEqual([0, 0, 16, 16]);
    expect(sourceRect(16, 64, false)).toEqual([0, 0, 16, 64]);
    expect(sourceRect(16, 40, true)).toEqual([0, 0, 16, 40]);
  });

  it("fills the area with whole-number scales, inside the area, centred", () => {
    const area = showcaseArea();
    const [ax, ay, aw, ah] = area;
    expect(ax + aw).toBeLessThanOrEqual(SHOWCASE_W);
    expect(ay + ah).toBeLessThanOrEqual(SHOWCASE_H);
    for (const n of [1, 2, 5, 12, 24]) {
      const sizes = Array.from({ length: n }, () => [32, 32] as [number, number]);
      const g = gridLayout(area, sizes, 20);
      expect(g.tiles).toHaveLength(n);
      expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
      for (const t of g.tiles) {
        const [x, y, w, h] = t.dest;
        expect(x).toBeGreaterThanOrEqual(ax);
        expect(y).toBeGreaterThanOrEqual(ay);
        expect(x + w).toBeLessThanOrEqual(ax + aw);
        expect(y + h).toBeLessThanOrEqual(ay + ah);
        expect(w % 32).toBe(0); // hard pixels: a whole number of screen pixels each
        expect([x, y, w, h].every(Number.isInteger)).toBe(true);
      }
      // no overlap between cells
      for (let i = 1; i < g.tiles.length; i++) {
        const [px, py] = g.tiles[i - 1].cell;
        const [cx, cy] = g.tiles[i].cell;
        expect(cy > py || cx >= px + g.cell).toBe(true);
      }
    }
  });

  it("picks the column count that gives the largest cells", () => {
    const g = gridLayout([0, 0, 1000, 500], Array.from({ length: 8 }, () => [16, 16] as [number, number]), 0);
    expect(g.cols).toBe(4); // 4×2 cells of 250 beat 8×1 of 125 and 3×3 of 166
    expect(g.cell).toBe(250);
    expect(g.tiles[0].dest).toEqual([5, 5, 240, 240]);
  });

  it("centres a short last row and shrinks textures bigger than a cell", () => {
    const sizes: [number, number][] = [[16, 16], [16, 16], [400, 100]];
    const g = gridLayout([0, 0, 300, 200], sizes, 0);
    // 2×2 and 3×1 both give 100-pixel cells: the first found (fewer columns) wins
    expect(g.cols).toBe(2);
    expect(g.cell).toBe(100);
    expect(g.tiles[0].cell).toEqual([50, 0, 100]);
    // last row: one cell, centred
    expect(g.tiles[2].cell).toEqual([100, 100, 100]);
    expect(g.tiles[2].dest).toEqual([100, 137, 100, 25]);
    expect(gridLayout([0, 0, 10, 10], [], 4).tiles).toEqual([]);
  });

  it("keeps a wide GUI texture at a whole-number scale", () => {
    const g = gridLayout([0, 0, 600, 300], [[200, 20], [16, 16]], 10);
    const [, , w, h] = g.tiles[0].dest;
    expect(w / 200).toBe(h / 20);
    expect(Number.isInteger(w / 200)).toBe(true);
  });
});

describe("text", () => {
  it("removes § codes", () => {
    expect(plainDescription("§bDeep §lSea§r pack ")).toBe("Deep Sea pack");
    expect(madeForLine(["1.21.11", "1.8.9"], 32)).toBe("Made for Minecraft Java 1.21.11, 1.8.9 · 32×");
  });

  it("counts what the pack has", () => {
    const rows = [
      row("block/stone", "blocks", 1),
      row("block/dirt", "blocks", null),
      row("item/diamond", "items", 2, { mine: { path: "item/diamond", width: 32, height: 64, modified_ms: 2, has_mcmeta: true, animated: true, frames: 2, file_size: 10 } }),
      row("gui/sprites/widget/button", "gui", 3),
      row("environment/sun", "environment", 4),
      row("block/my_own", "blocks", 5, { extra: true }),
    ];
    expect(pageCounts(rows)).toEqual({
      total: 4, blocks: 1, items: 1, gui: 1, entities: 0, particles: 0, other: 1, animated: 1, gameBlocks: 2, gameItems: 1,
    });
  });

  it("writes the page in Markdown", () => {
    const rows = [row("block/stone", "blocks", 1), row("block/dirt", "blocks", null), row("gui/sprites/widget/button", "gui", 3)];
    const md = pageMarkdown({
      name: "Deep Sea Pack", description: "§bOcean blues", versions: ["1.21.11", "1.8.9"], resolution: 32, rows, zipName: "Deep Sea Pack 1.21.11.zip",
    });
    expect(md.startsWith("# Deep Sea Pack\n\nOcean blues\n")).toBe(true);
    expect(md).toContain("- Minecraft Java 1.21.11 (main version)\n- Minecraft Java 1.8.9\n");
    expect(md).toContain("**Resolution:** 32×");
    expect(md).toContain("- 1 block (of 2)\n- 1 interface (GUI) texture\n");
    expect(md).toContain("2 textures in total.");
    expect(md).toContain("- Redrawn interface");
    expect(md).toContain("- One pack for 2 Minecraft versions");
    expect(md).toContain("1. Download `Deep Sea Pack 1.21.11.zip` (do not unzip it).");
    expect(md).toContain("Use the file made for your Minecraft version (1.21.11, 1.8.9).");
    expect(md).not.toContain("§");
    const one = pageMarkdown({ name: "X", description: "", versions: ["1.20.1"], resolution: 16, rows: [], zipName: "X.zip" });
    expect(one).toContain("- Minecraft Java 1.20.1\n");
    expect(one).toContain("- No textures yet");
    expect(one).not.toContain("Use the file made for");
  });

  it("says how much the export saved", () => {
    expect(savingsLabel(3_000_000, 1_860_000)).toBe("Saved 1.1 MB (38%) on PNG files, same pixels.");
    expect(savingsLabel(1000, 1000)).toBe("The PNG files were already as small as they can be.");
    expect(savingsLabel(0, 0)).toBe("The PNG files were already as small as they can be.");
  });

  it("makes a short summary and a file name", () => {
    const info = { name: "P", description: "§aGreen", versions: ["1.21.11"], resolution: 64, rows: [], zipName: "P.zip" };
    expect(pageSummary(info)).toBe("Green · 64× · Minecraft Java 1.21.11");
    expect(pageSummary({ ...info, description: "x".repeat(400) }).length).toBe(256);
    expect(pageFileName("A/B: pack.")).toBe("A_B_ pack page.md");
  });
});

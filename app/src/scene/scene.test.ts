import { describe, expect, it } from "vitest";
import { cubeModel } from "../editor/blockMesh";
import type { BlockModel } from "../lib/api";
import { cornerAo, hidesFace, isFullCube, occludes, quadTriangles, renderLayer, shapeOf, vertexAo } from "./cull";
import {
  blockAt, cellIndex, cellOf, fromSceneFile, gardenScene, houseScene, makeGrid, neighbour, newCustomScene, pickRole,
  resizeGrid, setBlock, toSceneFile, usedIds, wallScene,
} from "./grid";
import { blockData, buildScene, type SceneBlockData } from "./sceneMesh";

function slab(texture: string): BlockModel {
  const face = (d: string, cull: boolean) => ({ texture, uv: [0, 0, 16, 16] as [number, number, number, number], rotation: 0, tintindex: null, cullface: cull ? d : null });
  return {
    name: "block/slab", chain: [], from_pack: false, ambientocclusion: true, textures: {}, builtin: null,
    elements: [{
      from: [0, 0, 0], to: [16, 8, 16], rotation: null, shade: true,
      faces: { down: face("down", true), up: face("up", false), north: face("north", true), south: face("south", true), west: face("west", true), east: face("east", true) },
    }],
  };
}

function cross(texture: string): BlockModel {
  const f = { texture, uv: [0, 0, 16, 16] as [number, number, number, number], rotation: 0, tintindex: 0, cullface: null };
  const rot = { origin: [8, 8, 8] as [number, number, number], axis: "y" as const, angle: 45, rescale: true };
  return {
    name: "block/cross", chain: [], from_pack: false, ambientocclusion: false, textures: {}, builtin: null,
    elements: [
      { from: [0.8, 0, 8], to: [15.2, 16, 8], rotation: rot, shade: false, faces: { north: f, south: f } },
      { from: [8, 0, 0.8], to: [8, 16, 15.2], rotation: rot, shade: false, faces: { west: f, east: f } },
    ],
  };
}

const DATA: Record<string, BlockModel[]> = {
  stone: [cubeModel("block/stone")],
  dirt: [cubeModel("block/dirt")],
  glass: [cubeModel("block/glass")],
  oak_leaves: [cubeModel("block/oak_leaves")],
  oak_slab: [slab("block/oak_planks")],
  poppy: [cross("block/poppy")],
};
const dataMap = (): Map<string, SceneBlockData> => new Map(Object.entries(DATA).map(([id, m]) => [id, blockData(id, m)]));

describe("grid", () => {
  it("indexes cells like scene.json", () => {
    const g = makeGrid(3, 2, 4);
    expect(g.blocks.length).toBe(24);
    expect(cellIndex(g, 1, 0, 0)).toBe(1);
    expect(cellIndex(g, 0, 0, 1)).toBe(3);
    expect(cellIndex(g, 0, 1, 0)).toBe(6);
    for (let i = 0; i < 24; i++) expect(cellIndex(g, ...cellOf(g, i))).toBe(i);
  });

  it("sets, reads and finds neighbours; outside is air", () => {
    let g = makeGrid(2, 2, 2);
    g = setBlock(g, 1, 1, 0, "stone");
    expect(blockAt(g, 1, 1, 0)).toBe("stone");
    expect(blockAt(g, 5, 0, 0)).toBe("");
    expect(neighbour(g, [1, 0, 0], "up")).toBe("stone");
    expect(neighbour(g, [0, 1, 0], "east")).toBe("stone");
    expect(neighbour(g, [1, 1, 0], "north")).toBe("");
    expect(setBlock(g, 9, 9, 9, "dirt")).toBe(g);
    expect(usedIds(setBlock(g, 0, 0, 0, "dirt"))).toEqual(["dirt", "stone"]);
  });

  it("resizes within 8×8×4, keeping what still fits", () => {
    let g = makeGrid(2, 2, 2);
    g = setBlock(g, 1, 1, 1, "stone");
    g = setBlock(g, 0, 0, 0, "dirt");
    const big = resizeGrid(g, 20, 3, 0);
    expect([big.width, big.depth, big.height]).toEqual([8, 3, 1]);
    expect(blockAt(big, 0, 0, 0)).toBe("dirt");
    expect(usedIds(big)).toEqual(["dirt"]);
    const back = resizeGrid(g, 4, 4, 4);
    expect(blockAt(back, 1, 1, 1)).toBe("stone");
  });

  it("round-trips through the scene file", () => {
    const g = setBlock(newCustomScene("grass_block"), 3, 2, 1, "stone");
    const f = toSceneFile(g);
    expect(f).toMatchObject({ version: 1, width: 8, depth: 8, height: 4 });
    expect(fromSceneFile(f)).toEqual(g);
    expect(fromSceneFile({ ...f, blocks: f.blocks.slice(1) })).toBeNull();
    expect(usedIds(g)).toEqual(["grass_block", "stone"]);
  });

  it("picks the version's block names for the presets", () => {
    const modern = new Set(["oak_planks", "grass_block", "short_grass", "poppy", "oak_slab"]);
    expect(pickRole("plant", modern)).toBe("short_grass");
    expect(pickRole("grass", modern)).toBe("grass_block");
    // 1.13–1.20.2: "grass" is the plant
    expect(pickRole("plant", new Set(["grass_block", "grass"]))).toBe("grass");
    // 1.8.9: "grass" is the grass block, never the plant
    const old = new Set(["grass", "tallgrass", "half_slab_oak"]);
    expect(pickRole("plant", old)).toBe("tallgrass");
    expect(pickRole("grass", old)).toBe("grass");
    expect(pickRole("slab", old)).toBe("half_slab_oak");
    // nothing known: the newest name (shown as missing)
    expect(pickRole("flower", new Set())).toBe("poppy");
  });

  it("builds the presets", () => {
    const pick = (r: string) => r;
    const house = houseScene(pick as never);
    expect([house.width, house.depth, house.height]).toEqual([9, 9, 5]);
    expect(blockAt(house, 2, 1, 2)).toBe("log");
    expect(blockAt(house, 3, 1, 2)).toBe("planks");
    expect(blockAt(house, 4, 2, 2)).toBe("glass");
    expect(blockAt(house, 4, 1, 6)).toBe(""); // door gap
    expect(blockAt(house, 4, 2, 6)).toBe("");
    expect(blockAt(house, 4, 1, 4)).toBe(""); // inside
    expect(blockAt(house, 1, 4, 1)).toBe("slab");
    expect(blockAt(house, 4, 0, 8)).toBe("path");
    expect(usedIds(house)).toEqual(["flower", "flower2", "glass", "grass", "log", "path", "planks", "plant", "slab"]);
    const wall = wallScene("stone");
    expect(wall.blocks.length).toBe(16);
    expect(usedIds(wall)).toEqual(["stone"]);
    const garden = gardenScene(pick as never);
    expect(usedIds(garden)).toEqual(["dirt", "flower", "flower2", "grass", "leaves", "log", "path", "plant"]);
    expect(blockAt(garden, 1, 1, 6)).toBe("log");
    expect(blockAt(garden, 1, 3, 5)).toBe("leaves");
  });
});

describe("culling", () => {
  it("knows full blocks and render layers", () => {
    expect(isFullCube([cubeModel("x")])).toBe(true);
    expect(isFullCube([slab("x")])).toBe(false);
    expect(isFullCube([cross("x")])).toBe(false);
    expect(renderLayer("stone")).toBe("solid");
    expect(renderLayer("glass")).toBe("cutout");
    expect(renderLayer("oak_leaves")).toBe("cutout");
    expect(renderLayer("red_stained_glass")).toBe("translucent");
    expect(renderLayer("ice")).toBe("translucent");
  });

  it("hides faces against full opaque neighbours and same glass", () => {
    const stone = shapeOf("stone", DATA.stone);
    const glass = shapeOf("glass", DATA.glass);
    const leaves = shapeOf("oak_leaves", DATA.oak_leaves);
    const slabS = shapeOf("oak_slab", DATA.oak_slab);
    expect(hidesFace(stone, "up", stone)).toBe(true);
    expect(hidesFace(stone, null, stone)).toBe(false);
    expect(hidesFace(stone, "up", null)).toBe(false);
    expect(hidesFace(stone, "up", glass)).toBe(false);
    expect(hidesFace(glass, "up", stone)).toBe(true);
    expect(hidesFace(glass, "up", glass)).toBe(true);
    expect(hidesFace(leaves, "up", leaves)).toBe(false);
    expect(hidesFace(stone, "up", slabS)).toBe(false);
    expect(occludes(stone)).toBe(true);
    expect(occludes(leaves)).toBe(true);
    expect(occludes(glass)).toBe(false);
    expect(occludes(slabS)).toBe(false);
    expect(occludes(null)).toBe(false);
  });
});

describe("ambient occlusion", () => {
  it("gives the game's four steps", () => {
    expect(vertexAo(false, false, false)).toBe(1);
    expect(vertexAo(false, false, true)).toBeCloseTo(0.8);
    expect(vertexAo(true, false, false)).toBeCloseTo(0.8);
    expect(vertexAo(true, false, true)).toBeCloseTo(0.6);
    // both sides: the corner counts as blocked whatever is there
    expect(vertexAo(true, true, false)).toBeCloseTo(0.4);
    expect(vertexAo(true, true, true)).toBeCloseTo(0.4);
  });

  it("looks at the layer in front of the face", () => {
    // a wall block at (1, 1, 0): the top face of the floor block (1, 0, 1)
    // sees it in front-north, so its two north corners are darker
    const solid = new Set(["1,1,0"]);
    const occ = (x: number, y: number, z: number) => solid.has(`${x},${y},${z}`);
    expect(cornerAo([1, 0, 1], "up", [0, 16, 0], 16, occ)).toBeCloseTo(0.8);
    expect(cornerAo([1, 0, 1], "up", [16, 16, 0], 16, occ)).toBeCloseTo(0.8);
    expect(cornerAo([1, 0, 1], "up", [0, 16, 16], 16, occ)).toBe(1);
    // a slab top (plane 8) looks at its own layer
    const own = new Set(["1,0,0"]);
    const occ2 = (x: number, y: number, z: number) => own.has(`${x},${y},${z}`);
    expect(cornerAo([1, 0, 1], "up", [0, 8, 0], 8, occ2)).toBeCloseTo(0.8);
    expect(cornerAo([1, 0, 1], "up", [0, 16, 0], 16, occ2)).toBe(1);
  });

  it("splits a quad along the brighter diagonal", () => {
    expect(quadTriangles([1, 1, 1, 1])).toEqual([0, 3, 2, 0, 2, 1]);
    expect(quadTriangles([0.4, 1, 1, 1])).toEqual([1, 0, 3, 1, 3, 2]);
    expect(quadTriangles([1, 0.4, 1, 1])).toEqual([0, 3, 2, 0, 2, 1]);
  });
});

describe("scene mesh", () => {
  it("leaves out the faces between two stone blocks", () => {
    const g = setBlock(setBlock(makeGrid(2, 1, 1), 0, 0, 0, "stone"), 1, 0, 0, "stone");
    const s = buildScene(g, dataMap(), false);
    expect(s.quads).toBe(10);
    expect(s.culled).toBe(2);
    expect(s.batches.map((b) => b.key)).toEqual(["solid|block/stone"]);
    const b = s.batches[0];
    expect(b.positions.length).toBe(10 * 4 * 3);
    expect(b.indices.length).toBe(10 * 6);
    expect(b.cells.length).toBe(10);
    // the second block's quads point at cell 1
    expect(b.cells.filter((c) => c === 1).length).toBe(5);
  });

  it("a 4×4 wall keeps only its outside faces", () => {
    const s = buildScene(wallScene("stone"), dataMap(), true);
    // front + back 16 each, 4 top, 4 bottom, 4 + 4 sides
    expect(s.quads).toBe(16 + 16 + 4 + 4 + 4 + 4);
  });

  it("glass and leaves: glass hides glass, leaves do not; stone behind glass stays", () => {
    const row = (a: string, b: string) => setBlock(setBlock(makeGrid(2, 1, 1), 0, 0, 0, a), 1, 0, 0, b);
    expect(buildScene(row("glass", "glass"), dataMap(), false).culled).toBe(2);
    expect(buildScene(row("oak_leaves", "oak_leaves"), dataMap(), false).culled).toBe(0);
    const sg = buildScene(row("stone", "glass"), dataMap(), false);
    // the glass face against stone goes; the stone face against glass stays
    expect(sg.culled).toBe(1);
    expect(sg.batches.map((b) => b.key).sort()).toEqual(["cutout|block/glass", "solid|block/stone"]);
  });

  it("a slab does not hide what is under it; plants have no AO and are not culled", () => {
    let g = makeGrid(1, 1, 2);
    g = setBlock(setBlock(g, 0, 0, 0, "stone"), 0, 1, 0, "oak_slab");
    const s = buildScene(g, dataMap(), true);
    // stone up face hidden by nothing (slab not full); slab down face hidden by stone
    expect(s.culled).toBe(1);
    g = setBlock(setBlock(makeGrid(1, 1, 2), 0, 0, 0, "stone"), 0, 1, 0, "poppy");
    const p = buildScene(g, dataMap(), true);
    const poppy = p.batches.find((b) => b.texture === "block/poppy")!;
    expect(poppy.cells.length).toBe(4);
    // no AO and shade off: tinted plains green at full strength
    expect(Math.max(...poppy.colors)).toBeCloseTo(0xbd / 255);
  });

  it("AO darkens a floor next to a wall, and only when turned on", () => {
    let g = makeGrid(2, 2, 1);
    g = setBlock(setBlock(g, 0, 0, 0, "dirt"), 1, 0, 0, "dirt");
    g = resizeGrid(g, 2, 2, 2);
    g = setBlock(g, 0, 1, 0, "stone");
    const tops = (ao: boolean) => {
      const b = buildScene(g, dataMap(), ao).batches.find((x) => x.texture === "block/dirt")!;
      // the up faces have shade 1; collect the darkest corner of the up faces
      const vals: number[] = [];
      for (let q = 0; q < b.cells.length; q++) {
        const y = b.positions[q * 12 + 1];
        const flatTop = [1, 4, 7, 10].every((k) => b.positions[q * 12 + k] === y) && y === 1;
        if (flatTop) for (let k = 0; k < 4; k++) vals.push(b.colors[q * 12 + k * 3]);
      }
      return vals;
    };
    expect(Math.min(...tops(false))).toBe(1);
    expect(Math.min(...tops(true))).toBeLessThan(1);
    expect(Math.max(...tops(true))).toBe(1);
  });

  it("puts overlays after what they cover", () => {
    const grass: BlockModel = {
      ...cubeModel("block/grass_block_side"),
      elements: [cubeModel("block/grass_block_side").elements[0], { ...cubeModel("block/grass_block_side_overlay").elements[0] }],
    };
    const data = new Map([["grass_block", blockData("grass_block", [grass])]]);
    const s = buildScene(makeGrid(1, 1, 1, "grass_block"), data, false);
    expect(s.batches.map((b) => b.texture)).toEqual(["block/grass_block_side", "block/grass_block_side_overlay"]);
    expect(s.batches[1].order).toBe(1);
  });
});

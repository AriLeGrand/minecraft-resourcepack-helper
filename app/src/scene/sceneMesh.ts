// A whole scene turned into batches of textured quads, one batch per texture
// (one draw call each): hidden faces left out, corners darkened by ambient
// occlusion, tints and the game's face shading baked into vertex colours.
// No three.js here, so it can be tested.
import type { BlockModel, FaceDir } from "../lib/api";
import { elementFaces, tintFor, type MeshFace, type Vec3 } from "../editor/blockMesh";
import { cornerAo, hidesFace, occludes, quadTriangles, shapeOf, type BlockShape, type RenderLayer } from "./cull";
import { blockAt, DIR_OFFSET, type SceneGrid } from "./grid";

export interface BlockFace extends MeshFace {
  cullface: string | null;
  /** The model allows ambient occlusion and the face is axis-aligned. */
  ao: boolean;
  /** Where the face lies along its normal, 0..16 (axis-aligned faces). */
  plane: number;
  /** Element index: later elements (overlays) are drawn after earlier ones. */
  order: number;
}

export interface SceneBlockData {
  shape: BlockShape;
  faces: BlockFace[];
}

const AXIS: Record<FaceDir, 0 | 1 | 2> = { down: 1, up: 1, north: 2, south: 2, west: 0, east: 0 };

const sameDir = (n: Vec3, dir: FaceDir) => {
  const o = DIR_OFFSET[dir];
  return Math.abs(n[0] - o[0]) < 1e-6 && Math.abs(n[1] - o[1]) < 1e-6 && Math.abs(n[2] - o[2]) < 1e-6;
};

/** The faces of a block's models with what culling and AO need. */
export function blockData(id: string, models: BlockModel[]): SceneBlockData {
  const faces: BlockFace[] = [];
  for (const m of models) {
    m.elements.forEach((el, order) => {
      for (const f of elementFaces(el)) {
        const aligned = sameDir(f.normal, f.dir);
        faces.push({
          ...f,
          cullface: el.faces[f.dir]?.cullface ?? null,
          ao: m.ambientocclusion && aligned,
          plane: aligned ? f.corners[0][AXIS[f.dir]] : 8,
          order,
        });
      }
    });
  }
  return { shape: shapeOf(id, models), faces };
}

export interface Batch {
  /** `layer|texture`. */
  key: string;
  texture: string | null;
  layer: RenderLayer;
  /** Draw order (overlays after the faces under them). */
  order: number;
  /** Corner positions in block units (cell + 0..1). */
  positions: number[];
  /** UVs ready for three.js canvas textures (v up). */
  uvs: number[];
  /** Tint × face shade × AO, 0..1. */
  colors: number[];
  indices: number[];
  /** Grid cell index per quad (two triangles each), for picking. */
  cells: number[];
}

export interface BuiltScene {
  batches: Batch[];
  /** Quads drawn, and quads left out because a neighbour hides them. */
  quads: number;
  culled: number;
}

/**
 * Builds the scene. `data` has every block id of the grid (ids missing from
 * it are not drawn). `ao` turns ambient occlusion on.
 */
export function buildScene(grid: SceneGrid, data: ReadonlyMap<string, SceneBlockData>, ao: boolean): BuiltScene {
  const batches = new Map<string, Batch>();
  let quads = 0;
  let culled = 0;
  const shapeAt = (x: number, y: number, z: number) => data.get(blockAt(grid, x, y, z))?.shape ?? null;
  const occ = (x: number, y: number, z: number) => occludes(shapeAt(x, y, z));
  for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.depth; z++) for (let x = 0; x < grid.width; x++) {
    const ci = (y * grid.depth + z) * grid.width + x;
    const block = data.get(grid.blocks[ci]);
    if (!block) continue;
    for (const f of block.faces) {
      if (f.cullface) {
        const o = DIR_OFFSET[f.cullface as FaceDir];
        if (o && hidesFace(block.shape, f.cullface, shapeAt(x + o[0], y + o[1], z + o[2]))) {
          culled++;
          continue;
        }
      }
      const key = `${block.shape.layer}|${f.texture ?? ""}`;
      let b = batches.get(key);
      if (!b) {
        b = { key, texture: f.texture, layer: block.shape.layer, order: f.order, positions: [], uvs: [], colors: [], indices: [], cells: [] };
        batches.set(key, b);
      }
      b.order = Math.max(b.order, f.order);
      const tint = f.tinted ? tintFor(f.texture) : 0xffffff;
      const tr = ((tint >> 16) & 255) / 255;
      const tg = ((tint >> 8) & 255) / 255;
      const tb = (tint & 255) / 255;
      const base = b.positions.length / 3;
      const aos: [number, number, number, number] = [1, 1, 1, 1];
      for (let k = 0; k < 4; k++) {
        const p = f.corners[k];
        b.positions.push(x + p[0] / 16, y + p[1] / 16, z + p[2] / 16);
        b.uvs.push(f.uvs[k][0], 1 - f.uvs[k][1]);
        const a = ao && f.ao ? cornerAo([x, y, z], f.dir, p, f.plane, occ) : 1;
        aos[k] = a;
        const s = f.shade * a;
        b.colors.push(tr * s, tg * s, tb * s);
      }
      for (const t of quadTriangles(aos)) b.indices.push(base + t);
      b.cells.push(ci);
      quads++;
    }
  }
  const list = [...batches.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return { batches: list, quads, culled };
}

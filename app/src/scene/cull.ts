// Which faces the scene draws, and how dark their corners are. Pure, tested.
//
// Hidden faces: a face with a `cullface` is left out when the neighbour on
// that side is a full opaque block (a whole 16³ cube drawn solid), as in the
// game. Glass next to the same glass is left out too (the game does that for
// glass, stained glass and ice); leaves keep their faces (fancy graphics).
//
// Ambient occlusion: the game's smooth lighting darkens each corner of a face
// by the blocks around it in the layer in front of the face: two side
// neighbours and the corner neighbour. Each occluding block counts 0.2, a free
// one 1.0, the block in front 1.0; the corner counts as occluding when both
// sides do. The corner's value is the average of the four:
// 1.0, 0.8, 0.6 or 0.4.
import type { BlockModel, FaceDir } from "../lib/api";

export type RenderLayer = "solid" | "cutout" | "translucent";

/** How a block is drawn, from its id (the game hard-codes this per block). */
export function renderLayer(id: string): RenderLayer {
  if (/stained_glass|^ice$|frosted_ice|slime_block|honey_block|tinted_glass|^water$/.test(id)) return "translucent";
  if (/glass|leaves|spawner|_bars$|scaffolding|roots|cobweb|grate/.test(id)) return "cutout";
  return "solid";
}

/** True when the models fill the whole cell: an unrotated 0..16 box with all six faces. */
export function isFullCube(models: BlockModel[]): boolean {
  return models.some((m) => m.elements.some((e) =>
    !e.rotation
    && e.from.every((v) => v === 0) && e.to.every((v) => v === 16)
    && (["down", "up", "north", "south", "west", "east"] as FaceDir[]).every((d) => e.faces[d]),
  ));
}

export interface BlockShape {
  id: string;
  full: boolean;
  layer: RenderLayer;
}

export function shapeOf(id: string, models: BlockModel[]): BlockShape {
  return { id, full: isFullCube(models), layer: renderLayer(id) };
}

/** Glass-like blocks hide their faces against the same block. */
const selfCulling = (id: string) => /glass|ice/.test(id);

/** Does a full opaque neighbour (or the same glass) hide this face? */
export function hidesFace(self: BlockShape, cullface: string | null, neighbour: BlockShape | null): boolean {
  if (!cullface || !neighbour || !neighbour.full) return false;
  if (neighbour.layer === "solid") return true;
  return neighbour.id === self.id && selfCulling(self.id);
}

/** Does a block darken the corners of its neighbours? (full blocks, except glass) */
export function occludes(b: BlockShape | null): boolean {
  return !!b && b.full && !/glass|ice/.test(b.id);
}

/** Brightness of one face corner from its two side neighbours and the corner neighbour. */
export function vertexAo(side1: boolean, side2: boolean, corner: boolean): number {
  const v = (o: boolean) => (o ? 0.2 : 1);
  const c = side1 && side2 ? true : corner;
  return (1 + v(side1) + v(side2) + v(c)) / 4;
}

/**
 * The two triangles of a quad whose corners have these AO values. The quad
 * is split along its brighter diagonal, so a dark corner stays in its own
 * triangle instead of streaking across the face (corner order: 0 top-left,
 * 1 top-right, 2 bottom-right, 3 bottom-left; triangles counter-clockwise
 * from outside).
 */
export function quadTriangles(ao: [number, number, number, number]): number[] {
  return ao[0] + ao[2] < ao[1] + ao[3] ? [1, 0, 3, 1, 3, 2] : [0, 3, 2, 0, 2, 1];
}

const AXES: Record<FaceDir, { n: 0 | 1 | 2; s: 1 | -1 }> = {
  down: { n: 1, s: -1 }, up: { n: 1, s: 1 }, north: { n: 2, s: -1 }, south: { n: 2, s: 1 }, west: { n: 0, s: -1 }, east: { n: 0, s: 1 },
};

/**
 * AO of one face corner. `cell` is the block, `corner` the corner position in
 * 0..16 block units, `dir` the face's side, `planeAt` where the face lies
 * along its normal (0..16). `occ(x, y, z)` says whether a cell occludes.
 */
export function cornerAo(
  cell: [number, number, number], dir: FaceDir, corner: [number, number, number], planeAt: number,
  occ: (x: number, y: number, z: number) => boolean,
): number {
  const { n, s } = AXES[dir];
  // a face on the cell's side looks at the next cell; one inside (a slab top) at its own
  const onSide = s > 0 ? planeAt >= 16 - 1e-6 : planeAt <= 1e-6;
  const front: [number, number, number] = [...cell];
  if (onSide) front[n] += s;
  const [a, b] = ([0, 1, 2] as const).filter((k) => k !== n);
  const sa = corner[a] < 8 ? -1 : 1;
  const sb = corner[b] < 8 ? -1 : 1;
  const at = (da: number, db: number) => {
    const p: [number, number, number] = [...front];
    p[a] += da;
    p[b] += db;
    return occ(p[0], p[1], p[2]);
  };
  return vertexAo(at(sa, 0), at(0, sb), at(sa, sb));
}

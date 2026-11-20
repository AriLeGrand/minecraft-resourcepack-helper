// Pure geometry for the 3D block preview: a resolved block model (Rust
// `core/src/models.rs`) turned into textured quads the way the game builds
// them. No three.js here, so the maths can be tested.
//
// Coordinates are the model's own: 0..16 block units, x east, y up, z south.
// UVs are in 0..1 of one texture frame, v down from the top (as in the file).
import type { BlockModel, FaceDir, ModelElement } from "../lib/api";

export type Vec3 = [number, number, number];

export interface MeshFace {
  dir: FaceDir;
  /** Texture path, or `null` for the game's "missing" texture. */
  texture: string | null;
  /** Corners top-left, top-right, bottom-right, bottom-left as seen from outside. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** UV per corner, in the same order. */
  uvs: [[number, number], [number, number], [number, number], [number, number]];
  /** Outward normal (after the element's rotation). */
  normal: Vec3;
  /** Brightness the game gives this face (1 = full). */
  shade: number;
  tinted: boolean;
}

/** The game's directional shading of block faces. */
export const SHADE: Record<FaceDir, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

const NORMALS: Record<FaceDir, Vec3> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

export const FACE_DIRS: FaceDir[] = ["down", "up", "north", "south", "west", "east"];

/** The four corners of one face of a box, top-left first, clockwise as seen from outside. */
export function faceCorners(dir: FaceDir, from: Vec3, to: Vec3): [Vec3, Vec3, Vec3, Vec3] {
  const [fx, fy, fz] = from;
  const [tx, ty, tz] = to;
  switch (dir) {
    case "north": return [[tx, ty, fz], [fx, ty, fz], [fx, fy, fz], [tx, fy, fz]];
    case "south": return [[fx, ty, tz], [tx, ty, tz], [tx, fy, tz], [fx, fy, tz]];
    case "west": return [[fx, ty, fz], [fx, ty, tz], [fx, fy, tz], [fx, fy, fz]];
    case "east": return [[tx, ty, tz], [tx, ty, fz], [tx, fy, fz], [tx, fy, tz]];
    case "up": return [[fx, ty, fz], [tx, ty, fz], [tx, ty, tz], [fx, ty, tz]];
    case "down": return [[fx, fy, tz], [tx, fy, tz], [tx, fy, fz], [fx, fy, fz]];
  }
}

/**
 * UV per corner (top-left, top-right, bottom-right, bottom-left) for a face
 * `uv` of `[u1, v1, u2, v2]` in 0..16, turned `rotation` degrees clockwise
 * (the texture turns, the face stays).
 */
export function faceUvs(uv: [number, number, number, number], rotation: number): MeshFace["uvs"] {
  const [u1, v1, u2, v2] = uv.map((n) => n / 16);
  const base: [number, number][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]];
  const steps = ((Math.round(rotation / 90) % 4) + 4) % 4;
  // turning the texture clockwise: the corner that was top-left shows at top-right
  return [0, 1, 2, 3].map((i) => base[(i - steps + 4) % 4]) as MeshFace["uvs"];
}

/** Rotates (and, with rescale, stretches) a point the way the element's `rotation` says. */
export function rotatePoint(p: Vec3, rot: ModelElement["rotation"], scale = true): Vec3 {
  if (!rot || rot.angle === 0) return p;
  const a = (rot.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [ox, oy, oz] = rot.origin;
  const x = p[0] - ox;
  const y = p[1] - oy;
  const z = p[2] - oz;
  let r: Vec3;
  if (rot.axis === "x") r = [x, y * c - z * s, y * s + z * c];
  else if (rot.axis === "y") r = [x * c + z * s, y, -x * s + z * c];
  else r = [x * c - y * s, x * s + y * c, z];
  if (scale && rot.rescale) {
    // the game stretches the two other axes so a 45° plane still spans the block
    const k = 1 / Math.cos(Math.abs(a));
    r = [rot.axis === "x" ? r[0] : r[0] * k, rot.axis === "y" ? r[1] : r[1] * k, rot.axis === "z" ? r[2] : r[2] * k];
  }
  return [r[0] + ox, r[1] + oy, r[2] + oz];
}

function rotateNormal(n: Vec3, rot: ModelElement["rotation"]): Vec3 {
  if (!rot || rot.angle === 0) return n;
  const r = rotatePoint(n, { ...rot, origin: [0, 0, 0] }, false);
  return r.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)) as Vec3;
}

/** True when the quad has no area (the game draws nothing there). */
function flat(c: Vec3[]): boolean {
  const e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
  const e2 = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
  const x = e1[1] * e2[2] - e1[2] * e2[1];
  const y = e1[2] * e2[0] - e1[0] * e2[2];
  const z = e1[0] * e2[1] - e1[1] * e2[0];
  return Math.hypot(x, y, z) < 1e-9;
}

/** The faces of one element, in the game's face order. */
export function elementFaces(el: ModelElement): MeshFace[] {
  const out: MeshFace[] = [];
  for (const dir of FACE_DIRS) {
    const f = el.faces[dir];
    if (!f) continue;
    const box = faceCorners(dir, el.from, el.to);
    if (flat(box)) continue;
    out.push({
      dir,
      texture: f.texture,
      corners: box.map((p) => rotatePoint(p, el.rotation)) as MeshFace["corners"],
      uvs: faceUvs(f.uv, f.rotation),
      normal: rotateNormal(NORMALS[dir], el.rotation),
      shade: el.shade ? SHADE[dir] : 1,
      tinted: f.tintindex !== null && f.tintindex !== undefined,
    });
  }
  return out;
}

export function modelFaces(model: BlockModel): MeshFace[] {
  return model.elements.flatMap(elementFaces);
}

/** The plain full block with one texture on all six sides. */
export function cubeModel(texture: string): BlockModel {
  const face = { texture, uv: [0, 0, 16, 16] as [number, number, number, number], rotation: 0, tintindex: null, cullface: null };
  return {
    name: ":cube", chain: [], from_pack: false, ambientocclusion: true, textures: { all: texture }, builtin: null,
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16], rotation: null, shade: true,
      faces: Object.fromEntries(FACE_DIRS.map((d) => [d, { ...face, cullface: d }])),
    }],
  };
}

/**
 * The colour a tinted face gets in the preview (the game colours these by
 * biome; this is the plains biome). Returns 0xRRGGBB.
 */
export function tintFor(texture: string | null): number {
  const name = texture?.split("/").pop() ?? "";
  if (name.includes("water")) return 0x3f76e4;
  if (name.startsWith("birch_leaves") || name === "leaves_birch") return 0x80a755;
  if (name.startsWith("spruce_leaves") || name === "leaves_spruce") return 0x619961;
  if (name.includes("lily_pad") || name === "waterlily") return 0x208030;
  if (name.includes("leaves") || name.includes("vine")) return 0x77ab2f;
  return 0x91bd59;
}

/** Triangles of a quad as corner indexes, counter-clockwise from outside (three.js front faces). */
export const QUAD_TRIANGLES = [0, 3, 2, 0, 2, 1];

/** Is a texture path a block texture (the 3D preview only makes sense for those)? */
export function isBlockTexture(path: string): boolean {
  return path.startsWith("block/") || path.startsWith("blocks/");
}

import { describe, expect, it } from "vitest";
import type { ModelElement, ModelFace } from "../lib/api";
import {
  cubeModel, elementFaces, FACE_DIRS, faceCorners, faceUvs, isBlockTexture, modelFaces, QUAD_TRIANGLES,
  rotatePoint, SHADE, tintFor, type Vec3,
} from "./blockMesh";

const face = (p: Partial<ModelFace> = {}): ModelFace => ({
  texture: "block/test", uv: [0, 0, 16, 16], rotation: 0, tintindex: null, cullface: null, ...p,
});

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("block faces", () => {
  it("a cube has six faces whose triangles face outward", () => {
    const faces = modelFaces(cubeModel("block/stone"));
    expect(faces.map((f) => f.dir)).toEqual(FACE_DIRS);
    for (const f of faces) {
      const [a, b, c] = QUAD_TRIANGLES.slice(0, 3).map((i) => f.corners[i]);
      const n = cross(sub(b, a), sub(c, a));
      const len = Math.hypot(...n);
      close(n.map((v) => v / len), f.normal);
      expect(f.texture).toBe("block/stone");
    }
  });

  it("corners follow the texture's orientation as seen from outside", () => {
    // looking at the north face from the north, its left is east (x = 16)
    expect(faceCorners("north", [0, 0, 0], [16, 16, 16])[0]).toEqual([16, 16, 0]);
    expect(faceCorners("south", [0, 0, 0], [16, 16, 16])[0]).toEqual([0, 16, 16]);
    expect(faceCorners("west", [0, 0, 0], [16, 16, 16])[0]).toEqual([0, 16, 0]);
    expect(faceCorners("east", [0, 0, 0], [16, 16, 16])[0]).toEqual([16, 16, 16]);
    // top: north edge at the top of the texture
    expect(faceCorners("up", [0, 0, 0], [16, 16, 16])[0]).toEqual([0, 16, 0]);
    // bottom: south edge at the top of the texture
    expect(faceCorners("down", [0, 0, 0], [16, 16, 16])[0]).toEqual([0, 0, 16]);
  });

  it("maps uv rectangles to 0..1 and turns them clockwise", () => {
    expect(faceUvs([0, 8, 16, 16], 0)).toEqual([[0, 0.5], [1, 0.5], [1, 1], [0, 1]]);
    // 90°: the texture's top-left corner shows at the face's top-right
    const r90 = faceUvs([0, 0, 16, 16], 90);
    expect(r90[1]).toEqual([0, 0]);
    expect(r90[0]).toEqual([0, 1]);
    expect(faceUvs([0, 0, 16, 16], 180)[0]).toEqual([1, 1]);
    expect(faceUvs([0, 0, 16, 16], 270)[0]).toEqual([1, 0]);
    expect(faceUvs([0, 0, 16, 16], -90)).toEqual(faceUvs([0, 0, 16, 16], 270));
    // mirrored uvs (u2 < u1) stay mirrored
    expect(faceUvs([16, 0, 0, 16], 0)[0]).toEqual([1, 0]);
  });

  it("a stair's upper step uses the uv the model gives", () => {
    const el: ModelElement = {
      from: [8, 8, 0], to: [16, 16, 16], rotation: null, shade: true,
      faces: { north: face({ uv: [0, 0, 8, 8] }), up: face({ uv: [8, 0, 16, 16] }) },
    };
    const f = elementFaces(el);
    expect(f[0].dir).toBe("up");
    expect(f[0].uvs[0]).toEqual([0.5, 0]);
    expect(f[1].corners[0]).toEqual([16, 16, 0]);
    expect(f[1].uvs[2]).toEqual([0.5, 0.5]);
  });

  it("rotates elements about their origin, with the game's rescale", () => {
    const rot = { origin: [8, 8, 8] as Vec3, axis: "y" as const, angle: 45, rescale: false };
    close(rotatePoint([16, 0, 8], rot), [8 + 8 * Math.SQRT1_2, 0, 8 - 8 * Math.SQRT1_2]);
    // rescale: a cross plane from 0.8 to 15.2 reaches the block's corners again
    const p = rotatePoint([0.8, 0, 8], { ...rot, rescale: true });
    close(p, [0.8, 0, 15.2]);
    // the point on the axis does not move
    close(rotatePoint([8, 3, 8], rot), [8, 3, 8]);
    close(rotatePoint([8, 16, 8], { origin: [8, 8, 8], axis: "z", angle: 90, rescale: false }), [0, 8, 8]);
    close(rotatePoint([8, 16, 8], { origin: [8, 8, 8], axis: "x", angle: 90, rescale: false }), [8, 8, 16]);
    expect(rotatePoint([1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  it("rotated faces get rotated normals; flat faces are dropped", () => {
    const el: ModelElement = {
      from: [0.8, 0, 8], to: [15.2, 16, 8], shade: false,
      rotation: { origin: [8, 8, 8], axis: "y", angle: 45, rescale: true },
      faces: { north: face(), south: face(), east: face() },
    };
    const f = elementFaces(el);
    expect(f.map((x) => x.dir)).toEqual(["north", "south"]);
    close(f[0].normal, [-Math.SQRT1_2, 0, -Math.SQRT1_2]);
    expect(f[0].shade).toBe(1);
  });

  it("shades faces like the game and marks tinted ones", () => {
    const el: ModelElement = {
      from: [0, 0, 0], to: [16, 16, 16], rotation: null, shade: true,
      faces: { up: face({ tintindex: 0 }), down: face(), east: face() },
    };
    const f = elementFaces(el);
    expect(f.map((x) => [x.dir, x.shade, x.tinted])).toEqual([["down", 0.5, false], ["up", 1, true], ["east", 0.6, false]]);
    expect(SHADE.north).toBe(0.8);
  });

  it("picks the plains colours for tinted textures", () => {
    expect(tintFor("block/grass_block_top")).toBe(0x91bd59);
    expect(tintFor("block/short_grass")).toBe(0x91bd59);
    expect(tintFor("block/oak_leaves")).toBe(0x77ab2f);
    expect(tintFor("block/birch_leaves")).toBe(0x80a755);
    expect(tintFor("blocks/leaves_spruce")).toBe(0x619961);
    expect(tintFor("block/water_still")).toBe(0x3f76e4);
    expect(isBlockTexture("block/stone")).toBe(true);
    expect(isBlockTexture("blocks/stone")).toBe(true);
    expect(isBlockTexture("item/apple")).toBe(false);
  });
});

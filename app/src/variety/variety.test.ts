import { describe, expect, it } from "vitest";
import { around, gridOf, layout, PREVIEW, quarters, quarterTile, type Around } from "./ctm";
import { pickIndex, pickPatch, rng } from "./pick";

const none: Around = { up: false, down: false, left: false, right: false, upLeft: false, upRight: false, downLeft: false, downRight: false };

describe("ctm_compact quarters", () => {
  it("picks a tile from the two sides and the corner", () => {
    expect(quarterTile(false, false, false)).toBe(0);
    expect(quarterTile(false, false, true)).toBe(0); // a corner alone does not connect
    expect(quarterTile(true, false, false)).toBe(3);
    expect(quarterTile(false, true, true)).toBe(2);
    expect(quarterTile(true, true, false)).toBe(4);
    expect(quarterTile(true, true, true)).toBe(1);
  });

  it("a lone block is the full border, a fully surrounded one has none", () => {
    expect(quarters(none)).toEqual([0, 0, 0, 0]);
    const all: Around = { up: true, down: true, left: true, right: true, upLeft: true, upRight: true, downLeft: true, downRight: true };
    expect(quarters(all)).toEqual([1, 1, 1, 1]);
  });

  it("each quarter looks at its own sides", () => {
    // connected to the right only: right quarters horizontal, left ones full border
    expect(quarters({ ...none, right: true })).toEqual([0, 3, 0, 3]);
    // above and below: vertical everywhere
    expect(quarters({ ...none, up: true, down: true })).toEqual([2, 2, 2, 2]);
    // up and left but not up-left: the inner corner at the top-left only
    expect(quarters({ ...none, up: true, left: true })).toEqual([4, 2, 3, 0]);
    expect(quarters({ ...none, up: true, left: true, upLeft: true })).toEqual([1, 2, 3, 0]);
    // the diagonals only matter in their own corner
    expect(quarters({ ...none, up: true, down: true, left: true, right: true, downRight: true })).toEqual([4, 4, 4, 1]);
  });

  it("every combination of the eight neighbours gives tiles 0..4 consistent with the sides", () => {
    for (let m = 0; m < 256; m++) {
      const b = (i: number) => (m & (1 << i)) !== 0;
      const a: Around = { up: b(0), down: b(1), left: b(2), right: b(3), upLeft: b(4), upRight: b(5), downLeft: b(6), downRight: b(7) };
      const q = quarters(a);
      // top-left only depends on up, left and up-left
      expect(q[0]).toBe(quarterTile(a.left, a.up, a.upLeft));
      expect(q[3]).toBe(quarterTile(a.right, a.down, a.downRight));
      for (const t of q) expect(t >= 0 && t <= 4).toBe(true);
    }
  });

  it("the wall and the L shape", () => {
    const g = gridOf(["##", "##"]);
    expect(quarters(around(g, 0, 0))).toEqual([0, 3, 2, 1]);
    expect(quarters(around(g, 1, 1))).toEqual([1, 2, 3, 0]);
    // the corner of the L (up and right connected, not across): inner corner top-right
    const corner = layout(PREVIEW).filter((p) => p.row === 3 && p.col === 5);
    expect(corner.map((p) => p.tile)).toEqual([2, 4, 0, 3]);
    // 16 wall blocks + 7 L blocks, four quarters each
    expect(layout(PREVIEW).length).toBe((16 + 7) * 4);
    // the middle of the 4×4 wall has no border at all
    expect(layout(PREVIEW).filter((p) => p.row === 1 && p.col === 1).every((p) => p.tile === 1)).toBe(true);
  });
});

describe("seeded pick", () => {
  it("is repeatable and follows the weights", () => {
    expect(pickPatch([1, 1], 9, 7)).toEqual(pickPatch([1, 1], 9, 7));
    expect(pickPatch([1, 1], 50, 7)).not.toEqual(pickPatch([1, 1], 50, 8));
    expect(pickIndex([1, 3], 0)).toBe(0);
    expect(pickIndex([1, 3], 0.24)).toBe(0);
    expect(pickIndex([1, 3], 0.26)).toBe(1);
    expect(pickIndex([1, 3], 0.9999)).toBe(1);
    expect(pickIndex([0, 0], 0.5)).toBe(0);
    const r = rng(1);
    const picks = Array.from({ length: 4000 }, () => pickIndex([1, 3], r()));
    const share = picks.filter((p) => p === 1).length / picks.length;
    expect(share).toBeGreaterThan(0.7);
    expect(share).toBeLessThan(0.8);
  });
});

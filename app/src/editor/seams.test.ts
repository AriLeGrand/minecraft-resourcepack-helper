import { describe, expect, it } from "vitest";
import { seamMessage, tileSize } from "./seams";

const edge = (seam: boolean) => ({ edge: seam ? 100 : 5, inside: 5, seam });

describe("seam note", () => {
  it("names the edge", () => {
    expect(seamMessage(null)).toBeNull();
    expect(seamMessage({ columns: edge(false), rows: edge(false) })).toBeNull();
    expect(seamMessage({ columns: edge(true), rows: edge(false) })).toBe("Seam on the left/right edge");
    expect(seamMessage({ columns: edge(false), rows: edge(true) })).toBe("Seam on the top/bottom edge");
    expect(seamMessage({ columns: edge(true), rows: edge(true) })).toBe("Seams on the left/right and top/bottom edges");
  });
  it("tile size follows the preview's whole-number scaling", () => {
    expect(tileSize(16, 16, 196, 3)).toEqual({ tw: 64, th: 64 });
    expect(tileSize(32, 32, 196, 3)).toEqual({ tw: 64, th: 64 });
    const big = tileSize(256, 256, 196, 3);
    expect(big.tw).toBeCloseTo(196 / 3);
  });
});

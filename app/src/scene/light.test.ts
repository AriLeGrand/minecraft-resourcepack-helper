import { describe, expect, it } from "vitest";
import { blockLightColor, brightness, levelLabel, lightColor, skyLightColor } from "./light";

describe("light curve", () => {
  it("follows f / (4 - 3f)", () => {
    expect(brightness(0)).toBe(0);
    expect(brightness(15)).toBe(1);
    // level 7: f = 7/15, 0.4667 / 2.6
    expect(brightness(7)).toBeCloseTo(0.4667 / 2.6, 3);
    expect(brightness(8)).toBeCloseTo(0.5333 / 2.4, 3);
    // out of range and fractions are clamped / rounded
    expect(brightness(20)).toBe(1);
    expect(brightness(-3)).toBe(0);
    expect(brightness(7.4)).toBe(brightness(7));
  });

  it("rises slowly, then fast (each level brighter than the last)", () => {
    for (let l = 1; l <= 15; l++) expect(brightness(l)).toBeGreaterThan(brightness(l - 1));
    // the game's curve: level 8 is well below half
    expect(brightness(8)).toBeLessThan(0.25);
  });

  it("block light is warm: red ≥ green ≥ blue", () => {
    for (let l = 1; l <= 15; l++) {
      // above 1 the game clamps; compare what is shown
      const [r, g, b] = blockLightColor(l).map((c) => Math.min(1, c));
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThanOrEqual(b);
    }
    expect(blockLightColor(0)).toEqual([0, 0, 0]);
  });

  it("night sky is darker and bluer than day", () => {
    const day = skyLightColor("day");
    const night = skyLightColor("night");
    expect(day).toEqual([1, 1, 1]);
    expect(night[0]).toBeLessThan(0.2);
    expect(night[2]).toBeGreaterThan(night[0]);
    expect(skyLightColor("day", 0)).toEqual([0, 0, 0]);
  });

  it("the lightmap: day is nearly full, night dark, block light lifts the night", () => {
    const day = lightColor(0, "day");
    for (const c of day) expect(c).toBeGreaterThan(0.95);
    const night = lightColor(0, "night");
    expect(night[0]).toBeGreaterThan(0.25);
    expect(night[0]).toBeLessThan(0.4);
    expect(night[2]).toBeGreaterThan(night[0]);
    const torch = lightColor(7, "night");
    expect(torch[0]).toBeGreaterThan(night[0]);
    expect(torch[0]).toBeGreaterThan(torch[2]);
    const sunset = lightColor(0, "sunset");
    expect(sunset[0]).toBeLessThan(day[0]);
    expect(sunset[0]).toBeGreaterThan(night[0]);
    for (const t of ["day", "sunset", "night"] as const) {
      for (let l = 0; l <= 15; l++) for (const c of lightColor(l, t)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it("labels the level with its brightness", () => {
    expect(levelLabel(15)).toBe("15 · 100 %");
    expect(levelLabel(7)).toBe("7 · 18 %");
  });
});

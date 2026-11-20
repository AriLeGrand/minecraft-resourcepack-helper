import { describe, expect, it } from "vitest";
import { cellAt, cellRect, cellsLabel, cellsMask } from "./cells";
import {
  alphaOf, familyOf, frameIndex, frameMode, MAX_ALIVE, newSim, nextRandom, step, tintOf, type Family, type Particle, type SimState,
} from "./sim";

const run = (f: Family, seconds: number, speed = 1, seed = 7, dt = 0.05): SimState => {
  let s = newSim(seed);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) s = step(s, f, dt, speed);
  return s;
};

const part = (age: number, life: number, pick = 0): Particle => ({ x: 0, y: 0, vx: 0, vy: 0, age, life, pick });

describe("random numbers", () => {
  it("are deterministic and in [0, 1)", () => {
    let a = 1;
    let b = 1;
    for (let i = 0; i < 1000; i++) {
      const [x, sa] = nextRandom(a);
      const [y, sb] = nextRandom(b);
      expect(x).toBe(y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      a = sa;
      b = sb;
    }
  });

  it("the same seed gives the same scene", () => {
    const f = familyOf("smoke");
    expect(run(f, 3, 1, 42)).toEqual(run(f, 3, 1, 42));
    expect(run(f, 3, 1, 42)).not.toEqual(run(f, 3, 1, 43));
  });
});

describe("spawning and lifetime", () => {
  it("spawns at the family's rate", () => {
    const f = { ...familyOf("flame"), rate: 10 };
    expect(run(f, 1).spawned).toBe(10);
    expect(run(f, 2.5).spawned).toBe(25);
  });

  it("never keeps more than the maximum alive", () => {
    const f = { ...familyOf("smoke"), rate: 1000, life: [50, 50] as [number, number] };
    expect(run(f, 1).parts.length).toBe(MAX_ALIVE);
  });

  it("particles die at the end of their life", () => {
    const f = { ...familyOf("heart"), rate: 4, life: [1, 1] as [number, number] };
    const s = run(f, 0.25);
    expect(s.parts.length).toBe(1);
    const later = step(s, { ...f, rate: 0 }, 1, 1);
    expect(later.parts.length).toBe(0);
    // the state passed in is not changed
    expect(s.parts.length).toBe(1);
    for (const p of run(f, 5).parts) expect(p.age).toBeLessThan(p.life);
  });

  it("speed scales simulated time", () => {
    const f = familyOf("smoke");
    // two seconds at 2× is the same scene as four seconds at 1×
    expect(run(f, 2, 2, 7, 0.05)).toEqual(run(f, 4, 1, 7, 0.1));
    expect(run(f, 4, 0.25).spawned).toBe(run(f, 1, 1).spawned);
    expect(step(newSim(), f, 1, 0)).toEqual(newSim());
  });
});

describe("movement presets", () => {
  it("smoke rises, drips fall, portal particles are pulled in", () => {
    const smoke = run(familyOf("smoke"), 1);
    expect(smoke.parts.every((p) => p.y <= 352 + 1)).toBe(true);
    expect(smoke.parts.some((p) => p.y < 340)).toBe(true);
    const drips = run(familyOf("dripping_water"), 0.9);
    expect(drips.parts.some((p) => p.vy > 0)).toBe(true);
    const portal = familyOf("portal");
    const before = run(portal, 0.5);
    const after = step(before, { ...portal, rate: 0 }, 0.2, 1);
    const dist = (p: Particle) => Math.hypot(p.x - 310, p.y - 332);
    after.parts.forEach((p, i) => expect(dist(p)).toBeLessThan(dist(before.parts[i]) + 1e-9));
  });

  it("families and modes", () => {
    expect(familyOf("smoke").key).toBe("smoke");
    expect(familyOf("large_smoke").key).toBe("smoke");
    expect(familyOf("campfire_cosy_smoke").key).toBe("campfire");
    expect(familyOf("soul_fire_flame").key).toBe("flame");
    expect(familyOf("falling_lava").key).toBe("drip");
    expect(familyOf("enchant").key).toBe("inward");
    expect(familyOf("explosion").key).toBe("burst");
    expect(familyOf("note").key).toBe("float");
    expect(familyOf("firework").key).toBe("spark");
    expect(familyOf("cherry_leaves").key).toBe("drift");
    expect(familyOf("something_new").key).toBe("generic");
    expect(familyOf("smoke").emitter).toBe("torch");
    expect(frameMode("enchant", 26)).toBe("random");
    expect(frameMode("smoke", 8)).toBe("age");
    expect(frameMode("heart", 1)).toBe("single");
    expect(frameMode("portal", 8, "random")).toBe("random");
    expect(frameMode("dripping_water", 3, "state")).toBe("age");
    expect(tintOf("smoke")).not.toBeNull();
    expect(tintOf("heart")).toBeNull();
  });
});

describe("frames over the lifetime", () => {
  it("age mode goes from the first image to the last like the game's sprite set", () => {
    expect(frameIndex(part(0, 1), 8, "age")).toBe(0);
    expect(frameIndex(part(0.5, 1), 8, "age")).toBe(3);
    expect(frameIndex(part(0.999, 1), 8, "age")).toBe(6);
    expect(frameIndex(part(1, 1), 8, "age")).toBe(7);
    expect(frameIndex(part(5, 1), 8, "age")).toBe(7);
    const seen = new Set<number>();
    for (let i = 0; i <= 200; i++) seen.add(frameIndex(part(i / 100, 2), 12, "age"));
    expect([...seen]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("random mode keeps one image for the whole life; single is always 0", () => {
    expect(frameIndex(part(0, 1, 30), 26, "random")).toBe(4);
    expect(frameIndex(part(0.9, 1, 30), 26, "random")).toBe(4);
    expect(frameIndex(part(0.5, 1, 30), 1, "random")).toBe(0);
    expect(frameIndex(part(0.5, 1), 8, "single")).toBe(0);
  });

  it("fading families fade at the end only", () => {
    const f = familyOf("smoke");
    expect(alphaOf(part(0.1, 1), f)).toBe(1);
    expect(alphaOf(part(0.8, 1), f)).toBeCloseTo(0.5);
    expect(alphaOf(part(0.8, 1), familyOf("flame"))).toBe(1);
  });
});

describe("sheet cells", () => {
  it("cell rectangles scale with the sheet", () => {
    expect(cellRect(0, 128)).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(cellRect(33, 128)).toEqual({ x: 8, y: 16, w: 8, h: 8 });
    expect(cellRect(250, 256)).toEqual({ x: 160, y: 240, w: 16, h: 16 });
    expect(cellRect(256, 128)).toBeNull();
    expect(cellRect(0, 100)).toBeNull();
    expect(cellAt(9, 17, 128)).toBe(33);
    expect(cellAt(255, 255, 256)).toBe(255);
    expect(cellAt(128, 0, 128)).toBeNull();
  });

  it("a mask covers exactly the cells", () => {
    const m = cellsMask([80, 80, 1], 32, 32);
    expect([...m].filter(Boolean).length).toBe(8);
    expect(m[10 * 32 + 0]).toBe(1);
    expect(m[10 * 32 + 2]).toBe(0);
    expect(m[0 * 32 + 2]).toBe(1);
    expect([...cellsMask([0], 32, 16)].some(Boolean)).toBe(false);
  });

  it("labels", () => {
    expect(cellsLabel([80])).toBe("80");
    expect(cellsLabel([7, 6, 5, 4, 3, 2, 1, 0])).toBe("0–7");
    expect(cellsLabel([19, 20, 21, 22, 32])).toBe("19–22, 32");
  });
});

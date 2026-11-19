import { describe, expect, it } from "vitest";
import { cloneBuf, getPx, newBuf, setPx, type Buf, type Pt, type Rgba } from "./pixels";
import { art, BLUE, bufFrom, CLEAR, GREEN, maskArt, RED, solid } from "./testutil";
import {
  applyStroke, changesPixels, clampSize, constrainEnd, cursorPoints, defaultOptions, floatSelection, growsInPlace, growStroke,
  inkFor, lift, pasteFloating, place, select, selectAllMask, selectArea, selectMode, shiftSelection, textPoints, toolDef,
  toolForKey, TOOLS, usesFilled, usesTolerance,
  type Stroke, type StrokeRun, type ToolId, type ToolOptions,
} from "./tools";

function stroke(tool: ToolId, snapshot: Buf, points: Pt[], extra: Partial<Stroke> & { o?: Partial<ToolOptions> } = {}): Buf {
  const { o, ...rest } = extra;
  return applyStroke({
    tool, snapshot, points, button: 0, fg: RED, bg: BLUE, mask: null, seed: 7,
    options: { ...defaultOptions, ...o }, ...rest,
  });
}

describe("tool list", () => {
  it("has the 20 tools of the mockup with their labels and shortcuts", () => {
    expect(TOOLS.map((t) => t.label)).toEqual([
      "Rectangle select (M)", "Lasso (Q)", "Magic wand (W)", "Move (V)", "Pencil (B)", "Spray (Shift+B)", "Eraser (E)",
      "Eyedropper (I)", "Paint bucket (G)", "Gradient (Shift+G)", "Line (L)", "Curve (Shift+L)", "Rectangle (U)",
      "Ellipse (Shift+U)", "Contour / polygon (D)", "Shading ink (Shift+S)", "Blur / jumble (R)", "Text (T)", "Hand (H)", "Zoom (Z)",
    ]);
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(20);
    expect(new Set(TOOLS.map((t) => `${t.shift}${t.key}`)).size).toBe(20);
    expect(toolDef("pencil").name).toBe("Pencil");
  });
  it("finds a tool by its key", () => {
    expect(toolForKey("b", false)).toBe("pencil");
    expect(toolForKey("B", true)).toBe("spray");
    expect(toolForKey("g", true)).toBe("gradient");
    expect(toolForKey("l", true)).toBe("curve");
    expect(toolForKey("u", true)).toBe("ellipse");
    expect(toolForKey("s", true)).toBe("shade");
    expect(toolForKey("s", false)).toBeNull();
    expect(toolForKey("m", false)).toBe("marquee");
    expect(toolForKey("z", false)).toBe("zoom");
    expect(toolForKey("1", false)).toBeNull();
  });
  it("knows what each tool needs", () => {
    expect(TOOLS.filter((t) => !changesPixels(t.id)).map((t) => t.id)).toEqual(["marquee", "lasso", "wand", "picker", "hand", "zoom"]);
    expect(TOOLS.filter((t) => usesFilled(t.id)).map((t) => t.id)).toEqual(["rect", "ellipse", "polygon"]);
    expect(TOOLS.filter((t) => usesTolerance(t.id)).map((t) => t.id)).toEqual(["wand", "bucket"]);
    expect(inkFor("eraser", "simple", 0)).toBe("erase");
    expect(inkFor("shade", "simple", 0)).toBe("lighten");
    expect(inkFor("shade", "simple", 2)).toBe("darken");
    expect(inkFor("pencil", "shading", 2)).toBe("darken");
    expect(inkFor("pencil", "lock", 0)).toBe("lock");
    expect([clampSize(0), clampSize(3.4), clampSize(999), clampSize(NaN)]).toEqual([1, 3, 64, 1]);
  });
});

describe("pencil and eraser", () => {
  it("joins the pointer positions into one line; right button uses the background colour", () => {
    const out = stroke("pencil", newBuf(5, 3), [[0, 0], [4, 0], [4, 2]], { o: { pixelPerfect: false } });
    expect(art(out)).toEqual(["#####", "....#", "....#"]);
    expect(getPx(out, 2, 0)).toEqual(RED);
    expect(getPx(stroke("pencil", newBuf(2, 1), [[0, 0]], { button: 2 }), 0, 0)).toEqual(BLUE);
  });
  it("never writes to the snapshot", () => {
    const snap = newBuf(3, 1);
    stroke("pencil", snap, [[0, 0], [2, 0]]);
    expect(art(snap)).toEqual(["..."]);
  });
  it("applies opacity once per pixel, however often the stroke crosses it", () => {
    const snap = solid(3, 1, BLUE);
    const once = stroke("pencil", snap, [[0, 0], [2, 0]], { o: { opacity: 50 } });
    const thrice = stroke("pencil", snap, [[0, 0], [2, 0], [0, 0], [2, 0]], { o: { opacity: 50 } });
    expect(getPx(once, 1, 0)).toEqual([128, 0, 128, 255]);
    expect([...thrice.data]).toEqual([...once.data]);
  });
  it("is pixel-perfect at 1 px (no doubled corners) and not when switched off", () => {
    const corner: Pt[] = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]];
    expect(art(stroke("pencil", newBuf(3, 3), corner))).toEqual(["#..", "#..", ".##"]);
    expect(art(stroke("pencil", newBuf(3, 3), corner, { o: { pixelPerfect: false } }))).toEqual(["#..", "#..", "###"]);
  });
  it("draws with a bigger brush", () => {
    expect(art(stroke("pencil", newBuf(4, 4), [[1, 1], [2, 1]], { o: { size: 2 } }))).toEqual(["###.", "###.", "....", "...."]);
    expect(art(stroke("pencil", newBuf(5, 5), [[2, 2]], { o: { size: 3 } }))).toEqual([".....", ".###.", ".###.", ".###.", "....."]);
    expect(art(stroke("pencil", newBuf(6, 6), [[2, 2]], { o: { size: 4 } }))).toEqual([".##...", "####..", "####..", ".##...", "......", "......"]);
  });
  it("mirrors with symmetry", () => {
    expect(art(stroke("pencil", newBuf(4, 4), [[0, 0], [0, 1]], { o: { symmetry: "x" } }))).toEqual(["#..#", "#..#", "....", "...."]);
    expect(art(stroke("pencil", newBuf(4, 4), [[0, 0]], { o: { symmetry: "y" } }))).toEqual(["#...", "....", "....", "#..."]);
    expect(art(stroke("pencil", newBuf(4, 4), [[0, 0]], { o: { symmetry: "both" } }))).toEqual(["#..#", "....", "....", "#..#"]);
  });
  it("wraps around the edges in tiled mode and stops at them otherwise", () => {
    expect(art(stroke("pencil", newBuf(4, 2), [[2, 0], [5, 0]], { o: { tiled: true } }))).toEqual(["####", "...."]);
    expect(art(stroke("pencil", newBuf(4, 2), [[2, 0], [5, 0]]))).toEqual(["..##", "...."]);
    expect(art(stroke("pencil", newBuf(4, 2), [[-1, -1]], { o: { tiled: true } }))).toEqual(["....", "...#"]);
  });
  it("only touches the selection", () => {
    const mask = new Uint8Array([0, 1, 1, 0]);
    expect(art(stroke("pencil", newBuf(4, 1), [[0, 0], [3, 0]], { mask }))).toEqual([".##."]);
  });
  it("uses the chosen ink", () => {
    const snap = bufFrom(["#."], { "#": [0, 0, 255, 128] });
    // lock alpha: only existing pixels, their transparency kept
    const lock = stroke("pencil", snap, [[0, 0], [1, 0]], { o: { ink: "lock" } });
    expect(getPx(lock, 0, 0)).toEqual([255, 0, 0, 128]);
    expect(getPx(lock, 1, 0)).toEqual(CLEAR);
    // alpha: paints over
    const half: Rgba = [255, 0, 0, 128];
    const alpha = stroke("pencil", solid(1, 1, BLUE), [[0, 0]], { fg: half, o: { ink: "alpha" } });
    expect(getPx(alpha, 0, 0)).toEqual([128, 0, 127, 255]);
    // simple: replaces, transparency included
    expect(getPx(stroke("pencil", solid(1, 1, BLUE), [[0, 0]], { fg: half }), 0, 0)).toEqual(half);
    // shading: left lightens, right darkens, colour kept
    const grey = solid(1, 1, [100, 100, 100, 255]);
    const lighter = getPx(stroke("pencil", grey, [[0, 0]], { o: { ink: "shading" } }), 0, 0);
    const darker = getPx(stroke("pencil", grey, [[0, 0]], { button: 2, o: { ink: "shading" } }), 0, 0);
    expect(lighter[0]).toBeGreaterThan(100);
    expect(darker[0]).toBeLessThan(100);
    expect([lighter[3], darker[3]]).toEqual([255, 255]);
  });
  it("erases, with opacity as strength", () => {
    const snap = solid(3, 1, RED);
    expect(art(stroke("eraser", snap, [[0, 0], [1, 0]]))).toEqual(["..#"]);
    expect(getPx(stroke("eraser", snap, [[0, 0]], { o: { opacity: 50 } }), 0, 0)).toEqual([255, 0, 0, 128]);
    // the eraser ignores the ink setting and the button
    expect(art(stroke("eraser", snap, [[0, 0]], { button: 2, o: { ink: "lock" } }))).toEqual([".##"]);
  });
  it("shades with the shading tool", () => {
    const grey = solid(2, 1, [100, 100, 100, 255]);
    const out = stroke("shade", grey, [[0, 0]]);
    expect(getPx(out, 0, 0)[0]).toBeGreaterThan(100);
    expect(getPx(out, 1, 0)).toEqual([100, 100, 100, 255]);
    expect(getPx(stroke("shade", grey, [[0, 0]], { button: 2 }), 0, 0)[0]).toBeLessThan(100);
    // empty pixels stay empty
    expect(art(stroke("shade", newBuf(2, 1), [[0, 0]]))).toEqual([".."]);
  });
});

describe("spray and blur", () => {
  it("sprays dots near the pointer, the same dots for the same stroke", () => {
    const a = stroke("spray", newBuf(16, 16), [[8, 8], [8, 8], [8, 8]], { o: { size: 2 } });
    const b = stroke("spray", newBuf(16, 16), [[8, 8], [8, 8], [8, 8]], { o: { size: 2 } });
    expect([...a.data]).toEqual([...b.data]);
    let count = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (getPx(a, x, y)[3] === 0) continue;
        count++;
        expect(Math.hypot(x - 8, y - 8)).toBeLessThanOrEqual(4.8); // radius 4, rounded to pixels
      }
    }
    expect(count).toBeGreaterThan(3);
    expect(count).toBeLessThanOrEqual(12);
    // a longer stroke only adds dots: the first ones stay where they were
    const more = stroke("spray", newBuf(16, 16), [[8, 8], [8, 8], [8, 8], [3, 3]], { o: { size: 2 } });
    for (let i = 3; i < a.data.length; i += 4) if (a.data[i]) expect(more.data[i]).toBe(255);
    // another seed gives other dots
    const other = stroke("spray", newBuf(16, 16), [[8, 8], [8, 8], [8, 8]], { seed: 99, o: { size: 2 } });
    expect([...other.data]).not.toEqual([...a.data]);
  });
  it("blurs from the image as it was before the stroke", () => {
    const snap = bufFrom(["...", ".#.", "..."]);
    const out = stroke("blur", snap, [[1, 1], [0, 1]]);
    // centre: weight 4 of 12 → alpha 255·4/12 = 85; left neighbour: 1 of 9 (edge) → 28
    expect(getPx(out, 1, 1)).toEqual([255, 0, 0, 85]);
    expect(getPx(out, 0, 1)).toEqual([255, 0, 0, 28]);
    expect(getPx(out, 2, 1)).toEqual(CLEAR);
  });
  it("jumbles pixels around without changing which colours exist", () => {
    const snap = bufFrom(["#.#.", ".#.#", "#.#.", ".#.#"]);
    const out = stroke("blur", snap, [[0, 0], [3, 0], [3, 3], [0, 3]], { o: { blurMode: "jumble", size: 2 } });
    const opaque = (b: Buf) => art(b).join("").split("#").length - 1;
    expect(opaque(out)).toBe(opaque(snap));
    expect(art(out)).not.toEqual(art(snap));
  });
});

describe("shapes", () => {
  it("draws a line between two points", () => {
    expect(art(stroke("line", newBuf(4, 4), [[0, 0], [3, 3]]))).toEqual(["#...", ".#..", "..#.", "...#"]);
    expect(art(stroke("line", newBuf(4, 4), [[0, 1], [3, 1]], { o: { size: 2 } }))).toEqual(["####", "####", "....", "...."]);
  });
  it("draws a rectangle outline or filled", () => {
    expect(art(stroke("rect", newBuf(5, 4), [[3, 3], [0, 0]]))).toEqual(["####.", "#..#.", "#..#.", "####."]);
    expect(art(stroke("rect", newBuf(5, 4), [[0, 0], [3, 3]], { o: { filled: true } }))).toEqual(["####.", "####.", "####.", "####."]);
  });
  it("draws an ellipse outline or filled", () => {
    expect(art(stroke("ellipse", newBuf(5, 5), [[0, 0], [4, 4]]))).toEqual([".###.", "#...#", "#...#", "#...#", ".###."]);
    expect(art(stroke("ellipse", newBuf(5, 5), [[0, 0], [4, 4]], { o: { filled: true } }))).toEqual([".###.", "#####", "#####", "#####", ".###."]);
  });
  it("draws a curve: a line until it is bent", () => {
    expect(art(stroke("curve", newBuf(5, 3), [[0, 0], [4, 0]]))).toEqual(["#####", ".....", "....."]);
    const bent = art(stroke("curve", newBuf(5, 3), [[0, 0], [4, 0], [2, 4]]));
    expect(bent[0][0]).toBe("#");
    expect(bent[0][4]).toBe("#");
    expect(bent[2][2]).toBe("#"); // pulled down in the middle
    expect(bent[0][2]).toBe(".");
    // a bend whose lowest point falls exactly between two rows leaves no stray pixel
    expect(art(stroke("curve", newBuf(9, 5), [[0, 0], [8, 0], [4, 5]]))).toEqual(["#.......#", ".#.....#.", "..#####..", ".........", "........."]);
  });
  it("draws a polygon outline or filled (contour)", () => {
    const tri: Pt[] = [[0, 0], [4, 0], [4, 4]];
    expect(art(stroke("polygon", newBuf(5, 5), tri))).toEqual(["#####", ".#..#", "..#.#", "...##", "....#"]);
    expect(art(stroke("polygon", newBuf(5, 5), tri, { o: { filled: true } }))).toEqual(["#####", ".####", "..###", "...##", "....#"]);
    // two points are just a line
    expect(art(stroke("polygon", newBuf(3, 1), [[0, 0], [2, 0]]))).toEqual(["###"]);
  });
  it("draws a gradient from the foreground to the background colour", () => {
    const out = stroke("gradient", newBuf(5, 1), [[0, 0], [4, 0]]);
    expect(getPx(out, 0, 0)).toEqual(RED);
    expect(getPx(out, 2, 0)).toEqual([128, 0, 128, 255]);
    expect(getPx(out, 4, 0)).toEqual(BLUE);
    // right button: the other way round; a selection limits it
    const back = stroke("gradient", newBuf(5, 1), [[0, 0], [4, 0]], { button: 2, mask: new Uint8Array([1, 0, 0, 0, 1]) });
    expect(getPx(back, 0, 0)).toEqual(BLUE);
    expect(getPx(back, 2, 0)).toEqual(CLEAR);
    expect(getPx(back, 4, 0)).toEqual(RED);
  });
  it("gives every shape symmetry, wrapping and the selection too", () => {
    expect(art(stroke("line", newBuf(4, 2), [[0, 0], [0, 1]], { o: { symmetry: "x" } }))).toEqual(["#..#", "#..#"]);
    expect(art(stroke("rect", newBuf(4, 4), [[3, 3], [4, 4]], { o: { tiled: true } }))).toEqual(["#..#", "....", "....", "#..#"]);
    expect(art(stroke("rect", newBuf(3, 3), [[0, 0], [2, 2]], { mask: new Uint8Array([1, 1, 1, 0, 0, 0, 0, 0, 0]) }))).toEqual(["###", "...", "..."]);
  });
});

describe("paint bucket", () => {
  const snap = () => bufFrom(["##.", "#.#", "..#"]);
  it("fills the touching area of the same colour", () => {
    const out = stroke("bucket", snap(), [[0, 0]], { fg: GREEN });
    expect(getPx(out, 0, 0)).toEqual(GREEN);
    expect(getPx(out, 1, 0)).toEqual(GREEN);
    expect(getPx(out, 0, 1)).toEqual(GREEN);
    expect(getPx(out, 2, 1)).toEqual(RED); // not touching
    expect(getPx(out, 1, 1)).toEqual(CLEAR);
  });
  it("fills every pixel of that colour when not contiguous", () => {
    const out = stroke("bucket", snap(), [[0, 0]], { fg: GREEN, o: { contiguous: false } });
    expect(getPx(out, 2, 1)).toEqual(GREEN);
    expect(getPx(out, 2, 2)).toEqual(GREEN);
    expect(getPx(out, 1, 1)).toEqual(CLEAR);
  });
  it("fills empty areas, respects tolerance and the selection, ignores clicks outside", () => {
    expect(art(stroke("bucket", snap(), [[1, 1]]))).toEqual(["##.", "###", "###"]);
    expect(art(stroke("bucket", snap(), [[0, 2]], { mask: new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0]) }))).toEqual(["##.", "#.#", "#.#"]);
    const two = bufFrom(["ab"], { a: [100, 100, 100, 255], b: [110, 100, 100, 255] });
    expect(getPx(stroke("bucket", two, [[0, 0]]), 1, 0)).toEqual([110, 100, 100, 255]);
    expect(getPx(stroke("bucket", two, [[0, 0]], { o: { tolerance: 10 } }), 1, 0)).toEqual(RED);
    expect(art(stroke("bucket", snap(), [[9, 9]]))).toEqual(art(snap()));
    // in tiled mode a click on a neighbouring copy fills the real image
    expect(getPx(stroke("bucket", snap(), [[3, 3]], { fg: GREEN, o: { tiled: true } }), 0, 0)).toEqual(GREEN);
  });
});

describe("text", () => {
  const bitmap = { w: 3, h: 2, data: new Uint8Array([1, 0, 1, 1, 1, 1]) };
  it("turns rendered text into pixels at a position", () => {
    expect(textPoints(bitmap, 1, 1)).toEqual([[1, 1], [3, 1], [1, 2], [2, 2], [3, 2]]);
    expect(art(stroke("text", newBuf(5, 4), [[1, 1]], { bitmap }))).toEqual([".....", ".#.#.", ".###.", "....."]);
    // partly outside the image: what fits is drawn
    expect(art(stroke("text", newBuf(2, 2), [[1, 1]], { bitmap }))).toEqual(["..", ".#"]);
    // nothing typed yet
    expect(art(stroke("text", newBuf(2, 2), [[0, 0]]))).toEqual(["..", ".."]);
  });
});

describe("selection tools", () => {
  const cel = bufFrom(["##..", "##..", "...#", "...#"]);
  it("selects a rectangle between two corners, clipped to the image", () => {
    expect(maskArt(selectArea("marquee", [[1, 1], [2, 2]], cel, defaultOptions), 4)).toEqual(["....", ".##.", ".##.", "...."]);
    expect(maskArt(selectArea("marquee", [[2, 2], [9, 9]], cel, defaultOptions), 4)).toEqual(["....", "....", "..##", "..##"]);
    expect(maskArt(selectArea("marquee", [[3, 0]], cel, defaultOptions), 4)[0]).toBe("...#");
  });
  it("selects the inside of a lasso outline", () => {
    expect(maskArt(selectArea("lasso", [[0, 0], [3, 0], [0, 3]], cel, defaultOptions), 4)).toEqual(["####", "###.", "##..", "#..."]);
  });
  it("selects by colour with the wand", () => {
    expect(maskArt(selectArea("wand", [[0, 0]], cel, defaultOptions), 4)).toEqual(["##..", "##..", "....", "...."]);
    expect(maskArt(selectArea("wand", [[0, 0]], cel, { ...defaultOptions, contiguous: false }), 4)).toEqual(["##..", "##..", "...#", "...#"]);
    expect(maskArt(selectArea("wand", [[9, 9]], cel, defaultOptions), 4)).toEqual(["....", "....", "....", "...."]);
  });
  it("adds with Shift and takes away with Alt", () => {
    expect([selectMode(false, false), selectMode(true, false), selectMode(false, true), selectMode(true, true)]).toEqual(["replace", "add", "subtract", "subtract"]);
    const first = select(null, "marquee", [[0, 0], [1, 1]], cel, defaultOptions, "replace");
    const added = select(first, "marquee", [[3, 3], [3, 3]], cel, defaultOptions, "add");
    expect(maskArt(added, 4)).toEqual(["##..", "##..", "....", "...#"]);
    const less = select(added, "marquee", [[0, 0], [3, 0]], cel, defaultOptions, "subtract");
    expect(maskArt(less, 4)).toEqual(["....", "##..", "....", "...#"]);
    const replaced = select(less, "wand", [[3, 2]], cel, defaultOptions, "replace");
    expect(maskArt(replaced, 4)).toEqual(["....", "....", "...#", "...#"]);
    // taking everything away leaves no selection at all
    expect(select(first, "marquee", [[0, 0], [3, 3]], cel, defaultOptions, "subtract")).toBeNull();
    expect(selectAllMask(2, 2)).toEqual(new Uint8Array([1, 1, 1, 1]));
  });
});

describe("move", () => {
  it("moves the whole layer when nothing is selected", () => {
    const cel = bufFrom(["#..", "...", "..."]);
    const f = lift(cel, null);
    expect(art(place(f, 1, 2, false))).toEqual(["...", "...", ".#."]);
    // pixels pushed out of the image are gone, unless tiled
    expect(art(place(f, 3, 0, false))).toEqual(["...", "...", "..."]);
    expect(art(place(f, 3, 1, true))).toEqual(["...", "#..", "..."]);
    expect(art(cel)).toEqual(["#..", "...", "..."]);
  });
  it("moves only the selected pixels and leaves the rest alone", () => {
    const cel = bufFrom(["ab.", "...", "..."], { a: RED, b: BLUE });
    const mask = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const f = lift(cel, mask);
    expect(art(f.base)).toEqual([".#.", "...", "..."]);
    const out = place(f, 2, 1, false);
    expect(art(out)).toEqual([".#.", "..#", "..."]);
    expect(getPx(out, 2, 1)).toEqual(RED);
    expect(getPx(out, 1, 0)).toEqual(BLUE);
    expect(maskArt(shiftSelection(mask, 3, 3, 2, 1, false), 3)).toEqual(["...", "..#", "..."]);
  });
  it("keeps what is under the lifted pixels while they are moved again", () => {
    const cel = bufFrom(["ab."], { a: RED, b: BLUE });
    const f = lift(cel, new Uint8Array([1, 0, 0]));
    // over the blue pixel, then on to the right: blue is still there
    expect(getPx(place(f, 1, 0, false), 1, 0)).toEqual(RED);
    const out = place(f, 2, 0, false);
    expect(getPx(out, 1, 0)).toEqual(BLUE);
    expect(getPx(out, 2, 0)).toEqual(RED);
  });
  it("moves the selection with its pixels, dropping or wrapping what leaves the image", () => {
    const mask = new Uint8Array([1, 1, 0, 0]);
    expect(maskArt(shiftSelection(mask, 2, 2, 1, 0, false), 2)).toEqual([".#", ".."]);
    expect(maskArt(shiftSelection(mask, 2, 2, 1, 1, true), 2)).toEqual(["..", "##"]);
    expect(shiftSelection(mask, 2, 2, 5, 0, false)).toBeNull();
    expect(shiftSelection(null, 2, 2, 1, 0, false)).toBeNull();
  });
  it("pastes a clip where it came from, selected and ready to move", () => {
    const clip = { x: 1, y: 1, buf: bufFrom(["#.", "##"], { "#": GREEN }) };
    const cel = solid(4, 4, BLUE);
    const p = pasteFloating(cel, clip);
    expect(getPx(p.cel, 1, 1)).toEqual(GREEN);
    expect(getPx(p.cel, 2, 1)).toEqual(BLUE);
    expect(maskArt(p.selection, 4)).toEqual(["....", ".#..", ".##.", "...."]);
    // moving it afterwards does not dig a hole into the layer
    const moved = place(p.floating, 1, 1, false);
    expect(getPx(moved, 1, 1)).toEqual(BLUE);
    expect(getPx(moved, 2, 2)).toEqual(GREEN);
    // a clip from a bigger image is kept inside this one when it fits
    const far = pasteFloating(newBuf(2, 2), { x: 30, y: 30, buf: bufFrom(["#"]) });
    expect(art(far.cel)).toEqual(["..", ".#"]);
    // an empty clip selects nothing
    expect(pasteFloating(newBuf(2, 2), { x: 0, y: 0, buf: newBuf(1, 1) }).selection).toBeNull();
  });
});

describe("helpers", () => {
  it("constrains with Shift", () => {
    expect(constrainEnd("rect", [0, 0], [5, 2])).toEqual([5, 5]);
    expect(constrainEnd("ellipse", [4, 4], [1, 3])).toEqual([1, 1]);
    expect(constrainEnd("line", [0, 0], [9, 1])).toEqual([9, 0]);
    expect(constrainEnd("line", [0, 0], [1, -9])).toEqual([0, -9]);
    expect(constrainEnd("line", [0, 0], [5, 4])).toEqual([5, 5]);
    expect(constrainEnd("pencil", [0, 0], [5, 4])).toEqual([5, 4]);
  });
  it("outlines the brush for the cursor", () => {
    expect(cursorPoints("pencil", defaultOptions, [3, 4])).toEqual([[3, 4]]);
    expect(cursorPoints("pencil", { ...defaultOptions, size: 2 }, [3, 4])).toEqual([[2, 3], [3, 3], [2, 4], [3, 4]]);
    expect(cursorPoints("bucket", { ...defaultOptions, size: 9 }, [1, 1])).toEqual([[1, 1]]);
    expect(cursorPoints("spray", defaultOptions, [0, 0]).length).toBe(13);
  });
  it("leaves the snapshot alone for every tool", () => {
    const snap = bufFrom(["#.#", ".#.", "#.#"]);
    const copy = cloneBuf(snap);
    setPx(copy, 0, 0, RED);
    for (const t of TOOLS) stroke(t.id, snap, [[0, 0], [2, 2], [1, 2]], { bitmap: { w: 1, h: 1, data: new Uint8Array([1]) } });
    expect([...snap.data]).toEqual([...copy.data]);
  });
});

describe("review fixes: tiled tools, lifted selections, strokes drawn bit by bit", () => {
  it("tiled: the bucket and the wand follow an area across the edges", () => {
    const cel = bufFrom(["#..#", "...."]);
    const filled = stroke("bucket", cel, [[0, 0]], { fg: GREEN, o: { tiled: true } });
    expect([getPx(filled, 0, 0), getPx(filled, 3, 0)]).toEqual([GREEN, GREEN]);
    const plain = stroke("bucket", cel, [[0, 0]], { fg: GREEN });
    expect([getPx(plain, 0, 0), getPx(plain, 3, 0)]).toEqual([GREEN, RED]);
    expect(maskArt(selectArea("wand", [[3, 0]], cel, { ...defaultOptions, tiled: true }), 4)).toEqual(["#..#", "...."]);
    expect(maskArt(selectArea("wand", [[3, 0]], cel, defaultOptions), 4)).toEqual(["...#", "...."]);
  });
  it("tiled: blur along an edge reads the pixels across it", () => {
    const cel = bufFrom(["...#"]);
    const out = stroke("blur", cel, [[0, 0]], { o: { tiled: true } });
    expect(getPx(out, 0, 0)[3]).toBeGreaterThan(0);
    expect(getPx(stroke("blur", cel, [[0, 0]]), 0, 0)[3]).toBe(0);
  });

  it("a lifted selection stays whole while part of it hangs over the edge", () => {
    const cel = bufFrom(["##..", "##..", "...."]);
    const mask = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
    const f = lift(cel, mask);
    expect([f.mask?.w, f.mask?.h, Array.from(f.mask!.data)]).toEqual([2, 2, [1, 1, 1, 1]]);
    // one to the left: half of it is outside
    expect(maskArt(floatSelection(f, 4, 3, -1, 0, false), 4)).toEqual(["#...", "#...", "...."]);
    // put down there, then moved back: the pixels and the whole selection return
    const moved = { ...f, x: f.x - 1 };
    expect(art(place(moved, 1, 0, false))).toEqual(["##..", "##..", "...."]);
    expect(maskArt(floatSelection(moved, 4, 3, 1, 0, false), 4)).toEqual(["##..", "##..", "...."]);
    // tiled: the part that left comes in on the other side
    expect(maskArt(floatSelection(f, 4, 3, -1, 0, true), 4)).toEqual(["#..#", "#..#", "...."]);
    expect(floatSelection(f, 4, 3, 9, 9, false)).toBeNull();
    // nothing selected: the whole layer moves and nothing becomes selected
    expect(lift(cel, null).mask).toBeNull();
    expect(floatSelection(lift(cel, null), 4, 3, 1, 0, false)).toBeNull();
  });
  it("a selection keeps its empty pixels and its shape when lifted", () => {
    const cel = bufFrom(["#..", "...", "..."]);
    // an L-shaped selection, mostly over empty pixels
    const mask = new Uint8Array([1, 0, 0, 1, 1, 0, 0, 0, 0]);
    const f = lift(cel, mask);
    expect(maskArt(floatSelection(f, 3, 3, 1, 1, false), 3)).toEqual(["...", ".#.", ".##"]);
    expect(maskArt(floatSelection(f, 3, 3, 1, 1, false), 3)).toEqual(maskArt(shiftSelection(mask, 3, 3, 1, 1, false), 3));
  });

  it("a stroke drawn bit by bit gives exactly the image of the stroke drawn at once", () => {
    // a snapshot with different colours and transparency everywhere, so any pixel inked twice would show
    const snap = newBuf(12, 9);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 12; x++) setPx(snap, x, y, [x * 20, y * 25, (x * y * 7) % 256, (x + y) % 4 === 0 ? 0 : 60 + ((x * 31 + y * 17) % 190)]);
    const mask = new Uint8Array(12 * 9).fill(1);
    for (let i = 0; i < mask.length; i += 5) mask[i] = 0;
    const points: Pt[] = [[1, 1], [6, 2], [6, 2], [11, 7], [-3, 4], [4, 12], [5, 5], [5, 5], [9, 0], [2, 8]];
    const cases: { tool: ToolId; o: Partial<ToolOptions>; button?: 0 | 2; mask?: Uint8Array }[] = [
      { tool: "pencil", o: { size: 3, pixelPerfect: false } },
      { tool: "pencil", o: { size: 1, pixelPerfect: false, ink: "alpha", opacity: 40 } },
      { tool: "pencil", o: { size: 4, ink: "alpha", opacity: 55, symmetry: "both" } },
      { tool: "pencil", o: { size: 2, ink: "lock", symmetry: "x", tiled: true } },
      { tool: "pencil", o: { size: 5, ink: "shading", symmetry: "y" }, button: 2 },
      { tool: "eraser", o: { size: 3, opacity: 50, tiled: true }, mask },
      { tool: "shade", o: { size: 2, pixelPerfect: false }, mask },
      { tool: "spray", o: { size: 2, ink: "alpha", opacity: 70, symmetry: "x" } },
      { tool: "spray", o: { size: 1, tiled: true }, mask },
      { tool: "blur", o: { size: 3, tiled: true } },
      { tool: "blur", o: { size: 2, symmetry: "both" }, mask },
    ];
    for (const c of cases) {
      const options = { ...defaultOptions, ...c.o };
      expect(growsInPlace(c.tool, options), `${c.tool} ${JSON.stringify(c.o)}`).toBe(true);
      const at = (n: number): Stroke => ({
        tool: c.tool, snapshot: snap, points: points.slice(0, n), button: c.button ?? 0, fg: [250, 10, 30, 200], bg: [5, 90, 240, 255],
        options, mask: c.mask ?? null, seed: 99,
      });
      let run: StrokeRun | null = null;
      // the way the pointer delivers it: one point, then a few more, then the rest
      for (const n of [1, 2, 3, 6, 7, points.length]) {
        run = growStroke(at(n), run);
        expect(Array.from(run.buf.data), `${c.tool} ${JSON.stringify(c.o)} after ${n} points`).toEqual(Array.from(applyStroke(at(n)).data));
      }
      // the snapshot itself is never written to
      expect(run!.buf).not.toBe(snap);
    }
  });
  it("starts a bit-by-bit stroke again when what it is drawn with changes", () => {
    const snap = solid(6, 1, [10, 20, 30, 255]);
    const base = { tool: "pencil" as ToolId, snapshot: snap, button: 0 as const, fg: RED, bg: BLUE, mask: null, seed: 1 };
    const thin = { ...defaultOptions, pixelPerfect: false };
    const run = growStroke({ ...base, points: [[0, 0], [2, 0]], options: thin }, null);
    expect(getPx(run.buf, 2, 0)).toEqual(RED);
    // the colour changed in the middle of the stroke: the whole stroke takes it, as when drawn at once
    const green = { ...base, fg: GREEN, points: [[0, 0], [2, 0], [4, 0]] as Pt[], options: thin };
    const next = growStroke(green, run);
    expect(next).not.toBe(run);
    expect(Array.from(next.buf.data)).toEqual(Array.from(applyStroke(green).data));
    // what cannot grow in place is drawn again from the start by the caller
    expect(growsInPlace("pencil", defaultOptions)).toBe(false);
    expect(growsInPlace("blur", { ...defaultOptions, blurMode: "jumble" })).toBe(false);
    expect(growsInPlace("line", defaultOptions)).toBe(false);
  });
});

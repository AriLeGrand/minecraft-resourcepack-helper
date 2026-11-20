import { describe, expect, it } from "vitest";
import type { GuiPiece, GuiScreen, Scaling } from "../lib/api";
import { itemQuads, logicalSize, placeItems, ruleOf, shownPiece, switchRule, withBorder } from "./layout";

const NINE: Scaling = { type: "nine_slice", width: 200, height: 20, border: { left: 3, top: 3, right: 3, bottom: 3 }, stretch_inner: false };

function piece(id: string, over: Partial<GuiPiece> = {}): GuiPiece {
  return {
    id, name: id, path: `gui/sprites/widget/${id}`, used_on: "", size: [200, 20], pack_size: null, in_pack: false,
    in_version: true, scalable: true,
    scaling: { scaling: NINE, source: "game", vanilla: NINE, pack_has_png: false, pack_mcmeta: null, vanilla_mcmeta: null, error: null },
    rect: null, checked: [], modern: null, ...over,
  };
}

const screen: GuiScreen = {
  id: "menus", name: "Menus", folder: "gui/sprites/widget", size: [240, 100], image: null, done: 0, total: 2,
  pieces: [piece("button"), piece("button_highlighted"), piece("logo", { path: "gui/title/minecraft", scalable: false, scaling: null, size: [1024, 256] })],
  layout: [
    { text: "Game paused", x: 120, y: 4 },
    { piece: "button", x: 20, y: 20, w: 98, h: 20 },
    { piece: "button_highlighted", normal: "button", x: 122, y: 20, w: 98, h: 20 },
    { piece: "logo", x: 0, y: 50, src: [0, 0, 256, 44], tex: [256, 64] },
    { piece: "missing", x: 0, y: 0 },
  ],
};

describe("placing items", () => {
  it("places pieces in drawing order and skips text and unknown pieces", () => {
    expect(placeItems(screen, true)).toEqual([
      { index: 1, piece: "button", x: 20, y: 20, w: 98, h: 20 },
      { index: 2, piece: "button_highlighted", x: 122, y: 20, w: 98, h: 20 },
      { index: 3, piece: "logo", x: 0, y: 50, w: 256, h: 44 },
    ]);
  });
  it("shows the normal piece when hover states are hidden", () => {
    expect(placeItems(screen, false)[1].piece).toBe("button");
    expect(shownPiece(screen.layout[2], true)).toBe("button_highlighted");
  });
});

describe("sizes and rectangles", () => {
  it("knows a piece's own size", () => {
    expect(logicalSize(screen.pieces[0], null, NINE)).toEqual([200, 20]);
    expect(logicalSize(screen.pieces[2], screen.layout[3], { type: "stretch" })).toEqual([256, 64]);
    // a stretched sprite keeps the game's size even when the pack's image is bigger
    const big = piece("button", { pack_size: [400, 40] });
    expect(logicalSize(big, null, { type: "stretch" })).toEqual([200, 20]);
  });
  it("uses drafts before the saved rule", () => {
    const tile: Scaling = { type: "tile", width: 200, height: 20 };
    expect(ruleOf(screen.pieces[0], new Map([["gui/sprites/widget/button", tile]]))).toEqual(tile);
    expect(ruleOf(screen.pieces[0])).toEqual(NINE);
    expect(ruleOf(screen.pieces[2])).toEqual({ type: "stretch" });
  });
  it("draws a part of the texture as it is", () => {
    expect(itemQuads(screen.layout[3], screen.pieces[2], { type: "stretch" }, 256, 44)).toEqual([{ su: 0, sv: 0, sw: 256, sh: 44, dx: 0, dy: 0, dw: 256, dh: 44 }]);
  });
  it("draws sprites with their rule and backgrounds tiled", () => {
    expect(itemQuads(screen.layout[1], screen.pieces[0], NINE, 98, 20).length).toBe(3);
    const bg = piece("stone", { path: "gui/advancements/backgrounds/stone", scalable: false, scaling: null, size: [16, 16] });
    expect(itemQuads({ piece: "stone", x: 0, y: 0, draw: "tile" }, bg, { type: "stretch" }, 40, 16).map((q) => q.dw)).toEqual([16, 16, 8]);
    expect(itemQuads({ piece: "stone", x: 0, y: 0 }, bg, { type: "stretch" }, 40, 16)).toEqual([{ su: 0, sv: 0, sw: 16, sh: 16, dx: 0, dy: 0, dw: 40, dh: 16 }]);
  });
});

describe("editing the rule", () => {
  it("switches between rules sensibly", () => {
    expect(switchRule("tile", NINE, NINE, [200, 20])).toEqual({ type: "tile", width: 200, height: 20 });
    expect(switchRule("nine_slice", { type: "stretch" }, NINE, [200, 20])).toEqual(NINE);
    expect(switchRule("nine_slice", { type: "stretch" }, { type: "stretch" }, [8, 4])).toEqual({
      type: "nine_slice", width: 8, height: 4, border: { left: 2, top: 2, right: 2, bottom: 2 }, stretch_inner: false,
    });
    expect(switchRule("stretch", NINE, NINE, [200, 20])).toEqual({ type: "stretch" });
  });
  it("checks borders", () => {
    expect(withBorder(NINE, "left", "5")).toEqual({ rule: { ...NINE, border: { ...NINE.border, left: 5 } } });
    expect(withBorder(NINE, "top", "18")).toEqual({ error: "Top + bottom must be at most 20." });
    expect(withBorder(NINE, "left", "-1")).toHaveProperty("error");
    expect(withBorder(NINE, "left", "1.5")).toHaveProperty("error");
    expect(withBorder({ type: "stretch" }, "left", "1")).toHaveProperty("error");
  });
});

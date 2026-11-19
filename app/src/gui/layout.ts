// The assembled preview of an interface screen: where each layout item goes,
// which piece it shows, its size and the rectangles to draw. Pure functions.
import type { GuiLayoutItem, GuiPiece, GuiScreen, Scaling } from "../lib/api";
import { spriteQuads, tiledQuads, type Placed, type Quad } from "./slice";

/** The stretch rule a piece is drawn with: a draft for it when given, else the one that applies. */
export function ruleOf(piece: GuiPiece, drafts?: ReadonlyMap<string, Scaling>): Scaling {
  return drafts?.get(piece.path) ?? piece.scaling?.scaling ?? { type: "stretch" };
}

/**
 * A piece's own size in GUI pixels ("texture units"): the layout's `tex`,
 * else the rule's width and height (tile, nine-slice), else the game's image
 * size, else the pack's image size.
 */
export function logicalSize(piece: GuiPiece, item: GuiLayoutItem | null, rule: Scaling): [number, number] {
  if (item?.tex) return item.tex;
  if (rule.type !== "stretch") return [rule.width, rule.height];
  const v = piece.scaling?.vanilla;
  if (v && v.type !== "stretch") return [v.width, v.height];
  return piece.size ?? piece.pack_size ?? [1, 1];
}

/** The piece an item shows: its `normal` piece when hover states are hidden. */
export const shownPiece = (item: GuiLayoutItem, hover: boolean): string | undefined =>
  !hover && item.normal ? item.normal : item.piece;

/** Every drawn piece with its place and size, in drawing order (text items are left out). */
export function placeItems(screen: GuiScreen, hover: boolean): Placed[] {
  const byId = new Map(screen.pieces.map((p) => [p.id, p]));
  const out: Placed[] = [];
  screen.layout.forEach((item, index) => {
    const id = shownPiece(item, hover);
    const piece = id ? byId.get(id) : undefined;
    if (!id || !piece) return;
    const own = piece.size ?? piece.pack_size ?? [0, 0];
    const w = item.w ?? item.src?.[2] ?? own[0];
    const h = item.h ?? item.src?.[3] ?? own[1];
    out.push({ index, piece: id, x: item.x, y: item.y, w, h });
  });
  return out;
}

/**
 * The rectangles of one item, relative to its own corner: a part of the
 * texture (`src`) as it is, a repeated background (`draw: "tile"`), a sprite
 * with its stretch rule, or a whole image stretched to the item.
 */
export function itemQuads(item: GuiLayoutItem, piece: GuiPiece, rule: Scaling, w: number, h: number): Quad[] {
  const logical = logicalSize(piece, item, rule);
  if (item.src) {
    const [u, v, sw, sh] = item.src;
    return [{ su: u, sv: v, sw, sh, dx: 0, dy: 0, dw: w, dh: h }];
  }
  if (item.draw === "tile") return tiledQuads(0, 0, w, h, 0, 0, logical[0], logical[1]);
  if (piece.scalable) return spriteQuads(rule, logical, w, h);
  return [{ su: 0, sv: 0, sw: logical[0], sh: logical[1], dx: 0, dy: 0, dw: w, dh: h }];
}

/** The help line under the three stretch buttons. */
export const SCALING_HELP: Record<Scaling["type"], string> = {
  stretch: "The whole image is stretched to fit. Borders get thicker on wide buttons.",
  tile: "The image repeats to fill the space, like floor tiles.",
  nine_slice: "Corners stay sharp, edges and middle fill the space between them. Best for buttons and panels.",
};

/** A rule of another type for a piece, starting from what makes sense for it. */
export function switchRule(type: Scaling["type"], current: Scaling, vanilla: Scaling, logical: [number, number]): Scaling {
  const [w, h] = logical;
  if (type === "stretch") return { type: "stretch" };
  if (type === "tile") return { type: "tile", width: w, height: h };
  if (current.type === "nine_slice") return current;
  if (vanilla.type === "nine_slice") return vanilla;
  const b = Math.max(0, Math.min(3, Math.floor(Math.min(w, h) / 2)));
  return { type: "nine_slice", width: w, height: h, border: { left: b, top: b, right: b, bottom: b }, stretch_inner: false };
}

export type Side = "left" | "top" | "right" | "bottom";

/**
 * A nine-slice rule with one border changed, or an error to show. Borders
 * must be whole numbers and leave room: left + right ≤ width, top + bottom ≤ height.
 */
export function withBorder(rule: Scaling, side: Side, text: string): { rule: Scaling } | { error: string } {
  if (rule.type !== "nine_slice") return { error: "Borders exist only for nine-slice." };
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { error: "A border is a whole number of pixels (0 or more)." };
  const n = Number(t);
  const border = { ...rule.border, [side]: n };
  if (border.left + border.right > rule.width) return { error: `Left + right must be at most ${rule.width}.` };
  if (border.top + border.bottom > rule.height) return { error: `Top + bottom must be at most ${rule.height}.` };
  return { rule: { ...rule, border } };
}

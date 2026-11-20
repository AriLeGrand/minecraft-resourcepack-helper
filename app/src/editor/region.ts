// "Edit only these cells": a fixed editable region of a document (the cells
// of one particle on the shared particle sheet, or the rectangle of one
// interface piece on a shared GUI image before 1.20.2). Every change of
// pixels is clipped to it, so the pixels outside never change. Pure functions.
import { cellRect, cellsMask, uniqueCells, type Rect } from "../particles/cells";
import { flatStrip, type EditorDoc } from "./doc";
import type { Buf, Mask } from "./pixels";

export interface Region {
  /** 1 = may change. Same size as the document. */
  mask: Mask;
  /** The cells as rectangles, for drawing. */
  rects: Rect[];
  /** `cells`: a particle's cells on the particle sheet; `rect`: an interface piece's rectangle. */
  kind: "cells" | "rect";
  /** What is being edited, for the banner: the particle's id or the interface piece's name. */
  particle: string;
  cells: number[];
  /** Other particles drawn from the same cells. */
  shared: string[];
  /** The whole image (every frame flattened) when the mode began: a save keeps it outside the region. */
  base: Buf;
}

/**
 * `next` with every pixel outside `mask` taken from `prev`. Returns `next`
 * itself when nothing outside differs (no copy).
 */
export function clipToMask(next: Buf, prev: Buf, mask: Mask): Buf {
  if (next.w !== prev.w || next.h !== prev.h || mask.length !== next.w * next.h) return prev;
  const a = next.data;
  const b = prev.data;
  let out: Uint8ClampedArray | null = null;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    const o = i * 4;
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3]) continue;
    if (!out) out = new Uint8ClampedArray(a);
    out[o] = b[o];
    out[o + 1] = b[o + 1];
    out[o + 2] = b[o + 2];
    out[o + 3] = b[o + 3];
  }
  return out ? { w: next.w, h: next.h, data: out } : next;
}

/** The user's selection limited to the region (no selection = the whole region). */
export function andMask(selection: Mask | null, region: Mask): Mask {
  if (!selection || selection.length !== region.length) return region;
  const out = new Uint8Array(region.length);
  for (let i = 0; i < region.length; i++) out[i] = selection[i] && region[i] ? 1 : 0;
  return out;
}

// the combined mask is asked for on every pointer move: the same inputs give
// the same object, so a stroke in progress can keep growing in place
let cache: { sel: Mask | null; region: Mask; out: Mask } | null = null;

/** The mask the tools work with: the selection, limited to the region when there is one. */
export function editMask(selection: Mask | null, region: Region | null): Mask | null {
  if (!region) return selection;
  if (cache && cache.sel === selection && cache.region === region.mask) return cache.out;
  const out = andMask(selection, region.mask);
  cache = { sel: selection, region: region.mask, out };
  return out;
}

/**
 * The region of a particle's cells on a sheet document, or `null` when the
 * document is not one square image that fits the grid.
 */
export function cellsRegion(doc: EditorDoc, req: { particle: string; cells: number[]; shared: string[]; grid: number }): Region | null {
  const mask = cellsMask(req.cells, doc.width, doc.height, req.grid);
  if (doc.frames.length !== 1 || !mask.some((v) => v === 1)) return null;
  const rects = uniqueCells(req.cells).map((c) => cellRect(c, doc.width, req.grid)).filter((r): r is Rect => r !== null);
  return { kind: "cells", mask, rects, particle: req.particle, cells: req.cells, shared: req.shared, base: flatStrip(doc) };
}

export interface RectRequest {
  /** The piece's name, for the banner. */
  piece: string;
  /** The rectangle [x, y, w, h] in the game's image. */
  rect: [number, number, number, number];
  /** The game's image size; the document may be a whole multiple of it (a 2× pack). */
  imageSize: [number, number];
}

/**
 * The region of one rectangle of a shared image, scaled to the document's
 * size, or `null` when the document is not one image with the game's shape
 * at a whole multiple of its size.
 */
export function rectRegion(doc: EditorDoc, req: RectRequest): Region | null {
  const [gw, gh] = req.imageSize;
  if (doc.frames.length !== 1 || gw <= 0 || gh <= 0) return null;
  if (doc.width % gw !== 0 || doc.width * gh !== doc.height * gw || doc.width < gw) return null;
  const s = doc.width / gw;
  const [x, y, w, h] = req.rect.map((v) => v * s);
  if (w <= 0 || h <= 0 || x + w > doc.width || y + h > doc.height) return null;
  const mask = new Uint8Array(doc.width * doc.height);
  for (let r = y; r < y + h; r++) mask.fill(1, r * doc.width + x, r * doc.width + x + w);
  return { kind: "rect", mask, rects: [{ x, y, w, h }], particle: req.piece, cells: [], shared: [], base: flatStrip(doc) };
}

// Drawing of the editor canvas. This is the only editor module that needs a
// browser. Canvases are used for display only: pixels that get saved never
// pass through one (a canvas premultiplies alpha and would damage them).
import type { Rect } from "../particles/cells";
import { flatten, onionFrames, viewLayers, type EditorDoc, type Layer } from "./doc";
import { composite, type Buf, type Mask, type Pt, type Symmetry } from "./pixels";
import type { Bitmap } from "./tools";
import { GRID_ZOOM, maskEdges, pointEdges, type View } from "./view";

const BG = "#0d0e10";
const CHECK_A = "#1a1b1f";
const CHECK_B = "#23242a";
const FRAME = "#2a2b30";
const ACCENT = "#5b8cff";

/** Puts a pixel buffer on a canvas of exactly its size (for display). */
export function bufToCanvas(buf: Buf, target?: HTMLCanvasElement): HTMLCanvasElement {
  const c = target ?? document.createElement("canvas");
  if (c.width !== buf.w) c.width = buf.w;
  if (c.height !== buf.h) c.height = buf.h;
  const ctx = c.getContext("2d");
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), 0, 0);
  return c;
}

let checker: HTMLCanvasElement | null = null;
function checkerTile(): HTMLCanvasElement {
  if (checker) return checker;
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = CHECK_A;
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = CHECK_B;
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillRect(8, 8, 8, 8);
  checker = c;
  return c;
}

const edgeCache = new WeakMap<Mask, number[]>();
function selectionEdges(mask: Mask, w: number, h: number): number[] {
  let e = edgeCache.get(mask);
  if (!e) {
    e = maskEdges(mask, w, h);
    edgeCache.set(mask, e);
  }
  return e;
}

function strokeEdges(ctx: CanvasRenderingContext2D, edges: number[], v: View) {
  ctx.beginPath();
  for (let i = 0; i < edges.length; i += 4) {
    ctx.moveTo(Math.round(v.panX + edges[i] * v.zoom) + 0.5, Math.round(v.panY + edges[i + 1] * v.zoom) + 0.5);
    ctx.lineTo(Math.round(v.panX + edges[i + 2] * v.zoom) + 0.5, Math.round(v.panY + edges[i + 3] * v.zoom) + 0.5);
  }
  ctx.stroke();
}

export interface Scene {
  doc: EditorDoc;
  view: View;
  /** Size of the canvas in CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  tiled: boolean;
  symmetry: Symmetry;
  /** Onion skin: the frames before and after are shown faintly under the drawing. */
  onion: boolean;
  /** Pixels the brush would touch at the pointer, or `null` when the pointer is elsewhere. */
  cursor: Pt[] | null;
  /** "Edit only these cells": the editable rectangles; everything else is dimmed. */
  region?: Rect[] | null;
}

// A neighbour frame flattened for the onion skin, kept while that frame and
// the layer list stay the same (drawing on the current frame does not touch it).
const flatCache = new WeakMap<Buf[], { layers: Layer[]; buf: Buf }>();
/** One frame flattened, kept while its images and the layer list stay the same. */
export function flatFrame(doc: EditorDoc, index: number): Buf {
  const cels = doc.frames[index].cels;
  const hit = flatCache.get(cels);
  if (hit && hit.layers === doc.layers) return hit.buf;
  const buf = flatten(doc, index);
  flatCache.set(cels, { layers: doc.layers, buf });
  return buf;
}

let scratch: HTMLCanvasElement | null = null;
let scratchKey: unknown[] = [];

/**
 * The layers put together, as a canvas of the texture's size. Putting them
 * together is the expensive part, so it is only done again when something
 * that shows has changed: moving the pointer, panning and zooming reuse it.
 */
function sceneImage(doc: EditorDoc, onion: boolean): HTMLCanvasElement {
  const skin = onion ? onionFrames(doc).map((i) => flatFrame(doc, i)) : [];
  const layers = viewLayers(doc, doc.frameIndex, skin);
  const key: unknown[] = [doc.width, doc.height];
  for (const l of layers) key.push(l.buf, l.visible, l.opacity);
  if (scratch && key.length === scratchKey.length && key.every((k, i) => k === scratchKey[i])) return scratch;
  scratch = bufToCanvas(composite(doc.width, doc.height, layers), scratch ?? undefined);
  scratchKey = key;
  return scratch;
}

export function drawScene(canvas: HTMLCanvasElement, s: Scene) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { doc, view: v } = s;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, s.width, s.height);

  const W = doc.width * v.zoom;
  const H = doc.height * v.zoom;
  const image = sceneImage(doc, s.onion);
  ctx.imageSmoothingEnabled = false;

  const pattern = ctx.createPattern(checkerTile(), "repeat");
  const tiles = s.tiled ? [-1, 0, 1] : [0];
  for (const ty of tiles) {
    for (const tx of tiles) {
      const x = v.panX + tx * W;
      const y = v.panY + ty * H;
      if (x > s.width || y > s.height || x + W < 0 || y + H < 0) continue;
      ctx.save();
      ctx.translate(x, y);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.drawImage(image, 0, 0, W, H);
      if (tx !== 0 || ty !== 0) {
        // the copies around the image are dimmed so the real one stands out
        ctx.fillStyle = "rgba(13, 14, 16, 0.5)";
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    }
  }

  // pixel grid
  if (v.zoom >= GRID_ZOOM) {
    const span = s.tiled ? 1 : 0;
    const gx0 = Math.max(-span * doc.width, Math.floor(-v.panX / v.zoom));
    const gx1 = Math.min((1 + span) * doc.width, Math.ceil((s.width - v.panX) / v.zoom));
    const gy0 = Math.max(-span * doc.height, Math.floor(-v.panY / v.zoom));
    const gy1 = Math.min((1 + span) * doc.height, Math.ceil((s.height - v.panY) / v.zoom));
    ctx.strokeStyle = "rgba(8, 9, 11, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x++) {
      const sx = Math.round(v.panX + x * v.zoom) + 0.5;
      ctx.moveTo(sx, v.panY + gy0 * v.zoom);
      ctx.lineTo(sx, v.panY + gy1 * v.zoom);
    }
    for (let y = gy0; y <= gy1; y++) {
      const sy = Math.round(v.panY + y * v.zoom) + 0.5;
      ctx.moveTo(v.panX + gx0 * v.zoom, sy);
      ctx.lineTo(v.panX + gx1 * v.zoom, sy);
    }
    ctx.stroke();
  }

  // "edit only these cells": the rest of the image is dimmed, the cells outlined
  if (s.region && s.region.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.panX, v.panY, W, H);
    for (const r of s.region) ctx.rect(v.panX + r.x * v.zoom, v.panY + r.y * v.zoom, r.w * v.zoom, r.h * v.zoom);
    ctx.fillStyle = "rgba(13, 14, 16, 0.62)";
    ctx.fill("evenodd");
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    for (const r of s.region) {
      ctx.strokeRect(Math.round(v.panX + r.x * v.zoom) + 0.5, Math.round(v.panY + r.y * v.zoom) + 0.5, Math.round(r.w * v.zoom) - 1, Math.round(r.h * v.zoom) - 1);
    }
    ctx.restore();
  }

  // frame around the real image
  // (in tiled mode it is the only thing telling the real image from its copies)
  ctx.strokeStyle = s.tiled ? ACCENT : FRAME;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(v.panX) - 0.5, Math.round(v.panY) - 0.5, Math.round(W) + 1, Math.round(H) + 1);

  // symmetry axes
  if (s.symmetry !== "none") {
    ctx.strokeStyle = ACCENT;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    if (s.symmetry === "x" || s.symmetry === "both") {
      const x = Math.round(v.panX + W / 2) + 0.5;
      ctx.moveTo(x, v.panY - 8);
      ctx.lineTo(x, v.panY + H + 8);
    }
    if (s.symmetry === "y" || s.symmetry === "both") {
      const y = Math.round(v.panY + H / 2) + 0.5;
      ctx.moveTo(v.panX - 8, y);
      ctx.lineTo(v.panX + W + 8, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // selection: a black line with white dashes on top reads on any colour
  if (doc.selection) {
    const edges = selectionEdges(doc.selection, doc.width, doc.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000000";
    strokeEdges(ctx, edges, v);
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([4, 4]);
    strokeEdges(ctx, edges, v);
    ctx.setLineDash([]);
  }

  // brush cursor
  if (s.cursor && s.cursor.length > 0) {
    const edges = pointEdges(s.cursor);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000000";
    strokeEdges(ctx, edges, v);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#ffffff";
    strokeEdges(ctx, edges, v);
  }
}

/**
 * Text as a 1-bit image. The browser draws the letters, then every pixel
 * that is at least half covered counts as ink (hard pixels, no soft edges).
 */
export function rasterText(text: string, size: number): Bitmap | null {
  if (!text) return null;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const font = `${size}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.font = font;
  const w = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const h = Math.max(1, Math.ceil(size * 1.3));
  c.width = w;
  c.height = h;
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000000";
  ctx.fillText(text, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return { w, h, data };
}

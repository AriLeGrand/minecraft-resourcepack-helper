// Zoom and pan maths of the canvas. Pure functions: screen positions are CSS
// pixels relative to the canvas element, "pixel" positions are texture pixels.
import type { Mask, Pt } from "./pixels";

export interface View {
  /** Screen pixels per texture pixel (16 = 1600%). */
  zoom: number;
  /** Screen position of the texture's top-left corner. */
  panX: number;
  panY: number;
}

export const ZOOM_STEPS = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** The pixel grid is drawn from this zoom up (400%). */
export const GRID_ZOOM = 4;

/** Texture pixel under a screen position (may be outside the image). */
export function screenToPixel(v: View, sx: number, sy: number): Pt {
  return [Math.floor((sx - v.panX) / v.zoom), Math.floor((sy - v.panY) / v.zoom)];
}

/** Screen position of the top-left corner of a texture pixel. */
export function pixelToScreen(v: View, x: number, y: number): Pt {
  return [v.panX + x * v.zoom, v.panY + y * v.zoom];
}

export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Changes the zoom while the texture point under (sx, sy) stays where it is. */
export function zoomAbout(v: View, zoom: number, sx: number, sy: number): View {
  const z = clampZoom(zoom);
  const px = (sx - v.panX) / v.zoom;
  const py = (sy - v.panY) / v.zoom;
  return { zoom: z, panX: Math.round(sx - px * z), panY: Math.round(sy - py * z) };
}

/** Next zoom step up (`dir` 1) or down (-1). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > zoom + 1e-9) ?? MAX_ZOOM;
  const lower = ZOOM_STEPS.filter((s) => s < zoom - 1e-9);
  return lower.length ? lower[lower.length - 1] : MIN_ZOOM;
}

/** The largest zoom step at which the whole image fits, centred. */
export function fitView(w: number, h: number, viewW: number, viewH: number, margin = 24): View {
  const availW = Math.max(1, viewW - margin * 2);
  const availH = Math.max(1, viewH - margin * 2);
  const max = Math.min(availW / w, availH / h);
  const fitting = ZOOM_STEPS.filter((s) => s <= max);
  const zoom = fitting.length ? fitting[fitting.length - 1] : MIN_ZOOM;
  return centerView(w, h, viewW, viewH, zoom);
}

export function centerView(w: number, h: number, viewW: number, viewH: number, zoom: number): View {
  return { zoom, panX: Math.round((viewW - w * zoom) / 2), panY: Math.round((viewH - h * zoom) / 2) };
}

export const panBy = (v: View, dx: number, dy: number): View => ({ zoom: v.zoom, panX: v.panX + dx, panY: v.panY + dy });

/** "1600%" */
export const zoomLabel = (zoom: number) => `${Math.round(zoom * 100)}%`;

/**
 * Outline of the selected pixels as line segments in pixel coordinates
 * (x0, y0, x1, y1 per segment, flat). Used for the selection and the brush cursor.
 */
export function maskEdges(mask: Mask, w: number, h: number): number[] {
  const out: number[] = [];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!on(x, y - 1)) out.push(x, y, x + 1, y);
      if (!on(x, y + 1)) out.push(x, y + 1, x + 1, y + 1);
      if (!on(x - 1, y)) out.push(x, y, x, y + 1);
      if (!on(x + 1, y)) out.push(x + 1, y, x + 1, y + 1);
    }
  }
  return out;
}

/** Outline of a set of points (they may lie outside any image), same format as `maskEdges`. */
export function pointEdges(pts: Pt[]): number[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Set(pts.map(([x, y]) => key(x, y)));
  const out: number[] = [];
  for (const [x, y] of pts) {
    if (!set.has(key(x, y - 1))) out.push(x, y, x + 1, y);
    if (!set.has(key(x, y + 1))) out.push(x, y + 1, x + 1, y + 1);
    if (!set.has(key(x - 1, y))) out.push(x, y, x, y + 1);
    if (!set.has(key(x + 1, y))) out.push(x + 1, y, x + 1, y + 1);
  }
  return out;
}

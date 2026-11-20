// How the game draws an interface sprite at any size (1.20.2+), the GUI
// scale maths and hit-testing of the assembled preview. Pure functions,
// nearest-neighbour like the game.
//
// Sizes: a sprite has a size in GUI pixels ("logical": the stretch rule's
// width / height, else the game's image size); its image may have more
// pixels (a 2× pack). On screen every GUI pixel is `k` real pixels.
import type { Buf } from "../editor/pixels";
import { newBuf } from "../editor/pixels";
import type { Scaling } from "../lib/api";

/** One textured rectangle: `s*` in texture units (GUI pixels of the sprite), `d*` in GUI pixels. */
export interface Quad {
  su: number;
  sv: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const quad = (su: number, sv: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): Quad =>
  ({ su, sv, sw, sh, dx, dy, dw, dh });

/**
 * The game's tiled draw: the source part repeats from the top-left corner of
 * the area, the last tile in each direction cut short (never squeezed).
 */
export function tiledQuads(dx: number, dy: number, dw: number, dh: number, su: number, sv: number, tw: number, th: number): Quad[] {
  const out: Quad[] = [];
  if (dw <= 0 || dh <= 0 || tw <= 0 || th <= 0) return out;
  for (let i = 0; i < dw; i += tw) {
    const cw = Math.min(tw, dw - i);
    for (let j = 0; j < dh; j += th) {
      const ch = Math.min(th, dh - j);
      out.push(quad(su, sv, cw, ch, dx + i, dy + j, cw, ch));
    }
  }
  return out;
}

/** An inner part of a nine-slice: tiled, or stretched with `stretch_inner`. */
function inner(stretch: boolean, dx: number, dy: number, dw: number, dh: number, su: number, sv: number, sw: number, sh: number): Quad[] {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return [];
  return stretch ? [quad(su, sv, sw, sh, dx, dy, dw, dh)] : tiledQuads(dx, dy, dw, dh, su, sv, sw, sh);
}

/**
 * The rectangles the game draws for a sprite with this stretch rule at
 * `w`×`h` GUI pixels (origin 0, 0). `logical` is the sprite's own size in
 * GUI pixels (for tile and nine-slice it is the rule's width and height).
 * The same steps as the game's `blitSprite` / `blitTiledSprite` /
 * `blitNineSlicedSprite`: borders are cut to half the size when the target
 * is small; a target as wide (or tall) as the sprite keeps that direction whole.
 */
export function spriteQuads(scaling: Scaling, logical: [number, number], w: number, h: number): Quad[] {
  if (w <= 0 || h <= 0) return [];
  const [lw, lh] = logical;
  if (scaling.type === "stretch") return [quad(0, 0, lw, lh, 0, 0, w, h)];
  if (scaling.type === "tile") return tiledQuads(0, 0, w, h, 0, 0, scaling.width, scaling.height);
  const sw = scaling.width;
  const sh = scaling.height;
  const b = scaling.border;
  const s = scaling.stretch_inner;
  const left = Math.min(b.left, Math.floor(w / 2));
  const right = Math.min(b.right, Math.floor(w / 2));
  const top = Math.min(b.top, Math.floor(h / 2));
  const bottom = Math.min(b.bottom, Math.floor(h / 2));
  if (w === sw && h === sh) return [quad(0, 0, sw, sh, 0, 0, w, h)];
  if (h === sh) {
    return [
      quad(0, 0, left, h, 0, 0, left, h),
      ...inner(s, left, 0, w - right - left, h, left, 0, sw - right - left, sh),
      quad(sw - right, 0, right, h, w - right, 0, right, h),
    ].filter((q) => q.dw > 0 && q.dh > 0);
  }
  if (w === sw) {
    return [
      quad(0, 0, w, top, 0, 0, w, top),
      ...inner(s, 0, top, w, h - bottom - top, 0, top, sw, sh - bottom - top),
      quad(0, sh - bottom, w, bottom, 0, h - bottom, w, bottom),
    ].filter((q) => q.dw > 0 && q.dh > 0);
  }
  const iw = w - left - right;
  const ih = h - top - bottom;
  const isw = sw - left - right;
  const ish = sh - top - bottom;
  return [
    quad(0, 0, left, top, 0, 0, left, top),
    ...inner(s, left, 0, iw, top, left, 0, isw, top),
    quad(sw - right, 0, right, top, w - right, 0, right, top),
    ...inner(s, 0, top, left, ih, 0, top, left, ish),
    ...inner(s, left, top, iw, ih, left, top, isw, ish),
    ...inner(s, w - right, top, right, ih, sw - right, top, right, ish),
    quad(0, sh - bottom, left, bottom, 0, h - bottom, left, bottom),
    ...inner(s, left, h - bottom, iw, bottom, left, sh - bottom, isw, bottom),
    quad(sw - right, sh - bottom, right, bottom, w - right, h - bottom, right, bottom),
  ].filter((q) => q.dw > 0 && q.dh > 0 && q.sw > 0 && q.sh > 0);
}

/**
 * Copies one rectangle into `out` (pixels, `k` per GUI pixel), sampling the
 * image at pixel centres, nearest. `density` = image pixels per texture unit.
 * `ox` / `oy`: where GUI pixel 0, 0 is in `out`, in GUI pixels.
 */
export function drawQuad(out: Buf, img: Buf, density: [number, number], q: Quad, k: number, ox = 0, oy = 0, blend = false): void {
  const x0 = Math.round((ox + q.dx) * k);
  const y0 = Math.round((oy + q.dy) * k);
  const pw = Math.round(q.dw * k);
  const ph = Math.round(q.dh * k);
  if (pw <= 0 || ph <= 0 || img.w === 0 || img.h === 0) return;
  for (let py = 0; py < ph; py++) {
    const y = y0 + py;
    if (y < 0 || y >= out.h) continue;
    const v = q.sv + ((py + 0.5) / ph) * q.sh;
    const iy = Math.min(img.h - 1, Math.max(0, Math.floor(v * density[1])));
    for (let px = 0; px < pw; px++) {
      const x = x0 + px;
      if (x < 0 || x >= out.w) continue;
      const u = q.su + ((px + 0.5) / pw) * q.sw;
      const ix = Math.min(img.w - 1, Math.max(0, Math.floor(u * density[0])));
      const s = (iy * img.w + ix) * 4;
      const d = (y * out.w + x) * 4;
      if (blend) over(out.data, d, img.data, s);
      else {
        out.data[d] = img.data[s];
        out.data[d + 1] = img.data[s + 1];
        out.data[d + 2] = img.data[s + 2];
        out.data[d + 3] = img.data[s + 3];
      }
    }
  }
}

/** Source-over of one straight-alpha pixel. */
function over(dst: Uint8ClampedArray, d: number, src: Uint8ClampedArray, s: number): void {
  const sa = src[s + 3] / 255;
  if (sa === 0) return;
  if (sa === 1) {
    dst[d] = src[s];
    dst[d + 1] = src[s + 1];
    dst[d + 2] = src[s + 2];
    dst[d + 3] = 255;
    return;
  }
  const da = dst[d + 3] / 255;
  const a = sa + da * (1 - sa);
  for (let c = 0; c < 3; c++) dst[d + c] = Math.round((src[s + c] * sa + dst[d + c] * da * (1 - sa)) / a);
  dst[d + 3] = Math.round(a * 255);
}

/** Image pixels per texture unit. */
export const densityOf = (img: Buf, logical: [number, number]): [number, number] =>
  [img.w / Math.max(1, logical[0]), img.h / Math.max(1, logical[1])];

/** The sprite drawn at `w`×`h` GUI pixels with its stretch rule, `k` real pixels per GUI pixel. */
export function renderSprite(img: Buf, logical: [number, number], scaling: Scaling, w: number, h: number, k = 1): Buf {
  const out = newBuf(Math.max(0, w * k), Math.max(0, h * k));
  const d = densityOf(img, logical);
  for (const q of spriteQuads(scaling, logical, w, h)) drawQuad(out, img, d, q, k);
  return out;
}

/** Draws quads into a larger picture at GUI position `x`, `y` (blended over what is there). */
export function blitQuads(out: Buf, img: Buf, logical: [number, number], quads: Quad[], x: number, y: number, k: number): void {
  const d = densityOf(img, logical);
  for (const q of quads) drawQuad(out, img, d, q, k, x, y, true);
}

// ------------------------------------------------------------ GUI scale

/**
 * The game's automatic GUI scale for a window (`Window.calculateScale`): the
 * largest scale that keeps at least 320×240 GUI pixels, capped by `max`
 * (0 = no cap, as "Auto").
 */
export function autoGuiScale(winW: number, winH: number, max = 0): number {
  let i = 1;
  while (i !== max && i < winW && i < winH && winW / (i + 1) >= 320 && winH / (i + 1) >= 240) i++;
  return i;
}

/** The screen size in GUI pixels at a scale (rounded up, like the game). */
export const guiSize = (winW: number, winH: number, scale: number): [number, number] =>
  [Math.ceil(winW / scale), Math.ceil(winH / scale)];

/** The GUI pixel under a real pixel. */
export const toGui = (px: number, py: number, scale: number): [number, number] =>
  [Math.floor(px / scale), Math.floor(py / scale)];

// ------------------------------------------------------------ hit-testing

export interface Placed {
  /** Index of the layout item. */
  index: number;
  piece: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The piece under a GUI pixel: the topmost (last drawn) whose pixel there is
 * not transparent, else the topmost whose rectangle holds the point.
 * `opaque(p, lx, ly)` tells whether a piece is visible at a point inside it.
 */
export function hitTest(placed: Placed[], gx: number, gy: number, opaque?: (p: Placed, lx: number, ly: number) => boolean): Placed | null {
  let fallback: Placed | null = null;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (gx < p.x || gy < p.y || gx >= p.x + p.w || gy >= p.y + p.h) continue;
    if (!opaque || opaque(p, gx - p.x, gy - p.y)) return p;
    fallback ??= p;
  }
  return fallback;
}

/** The rectangle of a shared-image piece under a pixel: the smallest that holds it. */
export function rectAt<T extends { rect: [number, number, number, number] | null }>(pieces: T[], x: number, y: number): T | null {
  let best: T | null = null;
  for (const p of pieces) {
    if (!p.rect) continue;
    const [rx, ry, rw, rh] = p.rect;
    if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) continue;
    if (!best || rw * rh < best.rect![2] * best.rect![3]) best = p;
  }
  return best;
}

/** A shared-image rectangle in an image `scale` times the game's size. */
export const scaleRect = (r: [number, number, number, number], scale: number): [number, number, number, number] =>
  [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale];

/**
 * How many times bigger the pack's shared image is than the game's, or
 * `null` when it is not a whole multiple with the same shape.
 */
export function imageScale(pack: [number, number], game: [number, number]): number | null {
  const [pw, ph] = pack;
  const [gw, gh] = game;
  if (gw <= 0 || gh <= 0 || pw % gw !== 0 || pw * gh !== ph * gw) return null;
  const s = pw / gw;
  return s >= 1 ? s : null;
}

// ------------------------------------------------------------ the panel

/** Widths (GUI pixels) and the pixel scale of the "preview at 3 widths" strip. */
export function demoWidths(logical: [number, number], room = 280, tall = 40): { widths: number[]; k: number } {
  const [lw, lh] = logical;
  const want = [Math.max(1, Math.round(lw / 2)), lw, Math.round(lw * 1.5)];
  const k = Math.max(1, Math.floor(Math.min(room / want[2], tall / Math.max(1, lh))));
  const max = Math.floor(room / k);
  return { widths: want.map((w) => Math.min(w, max)), k };
}

/** The rule as people say it, for the status line. */
export function scalingLabel(s: Scaling): string {
  if (s.type === "stretch") return "Stretch";
  if (s.type === "tile") return `Tile (${s.width}×${s.height})`;
  const b = s.border;
  const same = b.left === b.top && b.top === b.right && b.right === b.bottom;
  return `Nine-slice (border ${same ? b.left : `${b.left}/${b.top}/${b.right}/${b.bottom}`}${s.stretch_inner ? ", inner stretched" : ""})`;
}

export const sameScaling = (a: Scaling, b: Scaling) => JSON.stringify(normal(a)) === JSON.stringify(normal(b));

function normal(s: Scaling): Scaling {
  if (s.type === "nine_slice") {
    const { left, top, right, bottom } = s.border;
    return { type: "nine_slice", width: s.width, height: s.height, border: { left, top, right, bottom }, stretch_inner: s.stretch_inner };
  }
  if (s.type === "tile") return { type: "tile", width: s.width, height: s.height };
  return { type: "stretch" };
}

/**
 * Alpha (0–255) of a drawn piece at a point inside it (GUI pixels from its
 * corner), sampled like `drawQuad` at that pixel's centre; 0 where no
 * rectangle covers the point.
 */
export function alphaAt(img: Buf, logical: [number, number], quads: Quad[], lx: number, ly: number): number {
  const [dxs, dys] = densityOf(img, logical);
  for (const q of quads) {
    if (lx < q.dx || ly < q.dy || lx >= q.dx + q.dw || ly >= q.dy + q.dh) continue;
    const u = q.su + ((lx - q.dx + 0.5) / q.dw) * q.sw;
    const v = q.sv + ((ly - q.dy + 0.5) / q.dh) * q.sh;
    const ix = Math.min(img.w - 1, Math.max(0, Math.floor(u * dxs)));
    const iy = Math.min(img.h - 1, Math.max(0, Math.floor(v * dys)));
    return img.data[(iy * img.w + ix) * 4 + 3];
  }
  return 0;
}

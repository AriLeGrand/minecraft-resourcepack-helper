// What each tool does to pixels. Pure functions over `pixels.ts`: a stroke
// (positions + options) goes in, a new image comes out. Nothing here knows
// about the mouse, the canvas or React.
import {
  blurPoints, brushOffsets, clearArea, cloneBuf, combineMasks, copyClip, curvePoints, dedupe, ellipsePoints, fit,
  floodMask, getPx, gradient, jumblePoints, linePoints, maskPoints, mirror, newBuf, paint, pasteClip, pathPoints,
  pixelPerfect, pointsMask, polygonPoints, rectPoints, rng, sprayPoints, stamp,
  type Buf, type Clip, type Ink, type Mask, type Pt, type Rgba, type SelectMode, type Symmetry,
} from "./pixels";

export type ToolId =
  | "marquee" | "lasso" | "wand" | "move" | "pencil" | "spray" | "eraser" | "picker" | "bucket" | "gradient"
  | "line" | "curve" | "rect" | "ellipse" | "polygon" | "shade" | "blur" | "text" | "hand" | "zoom";

export interface ToolDef {
  id: ToolId;
  /** "Pencil" */
  name: string;
  /** "Pencil (B)": tooltip, same wording as the mockup. */
  label: string;
  /** Lower-case key of the shortcut. */
  key: string;
  shift: boolean;
  /** Icon path on the 24-unit grid (stroke only). */
  icon: string;
}

const def = (id: ToolId, name: string, shortcut: string, icon: string): ToolDef => ({
  id, name, label: `${name} (${shortcut})`, key: shortcut.replace("Shift+", "").toLowerCase(), shift: shortcut.startsWith("Shift+"), icon,
});

/** The 20 tools, in the order of the tool column. */
export const TOOLS: ToolDef[] = [
  def("marquee", "Rectangle select", "M", "M4 4h4M12 4h4M20 4v4M20 12v4M20 20h-4M12 20H8M4 20v-4M4 12V8"),
  def("lasso", "Lasso", "Q", "M12 4c5 0 8 2.5 8 5.5S16 15 12 15s-8-2.5-8-5.5S7 4 12 4zM7 14c-1 2 0 4 2 5l-1 2"),
  def("wand", "Magic wand", "W", "M4 20L15 9M14 3v2M19 8h2M17 5l1.5-1.5M18 11l1.5 1.5"),
  def("move", "Move", "V", "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"),
  def("pencil", "Pencil", "B", "M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3"),
  def("spray", "Spray", "Shift+B", "M9 10h6v10H9zM10 10V7h4v3M17 5h1M19 3h1M19 7h1"),
  def("eraser", "Eraser", "E", "M8 20h12M5 15l9-9 5 5-7 7H8z"),
  def("picker", "Eyedropper", "I", "M4 20l2-1 8-8-2-2-8 8-1 2zM13 7l4-4 4 4-4 4"),
  def("bucket", "Paint bucket", "G", "M5 11l7-7 7 7-7 7zM5 11h14M20 15c0 1.5 1 2.5 1 3.5a1 1 0 0 1-2 0c0-1 1-2 1-3.5"),
  def("gradient", "Gradient", "Shift+G", "M4 4h16v16H4zM4 20L20 4"),
  def("line", "Line", "L", "M5 19L19 5"),
  def("curve", "Curve", "Shift+L", "M4 18C8 4 16 20 20 6"),
  def("rect", "Rectangle", "U", "M5 6h14v12H5z"),
  def("ellipse", "Ellipse", "Shift+U", "M4 12a8 6 0 1 0 16 0a8 6 0 1 0-16 0"),
  def("polygon", "Contour / polygon", "D", "M12 4l8 6-3 10H7L4 10z"),
  def("shade", "Shading ink", "Shift+S", "M12 4a8 8 0 1 0 0 16zM12 4a8 8 0 0 1 0 16"),
  def("blur", "Blur / jumble", "R", "M12 4c3 4 6 7 6 10a6 6 0 0 1-12 0c0-3 3-6 6-10z"),
  def("text", "Text", "T", "M5 6V4h14v2M12 4v16M9 20h6"),
  def("hand", "Hand", "H", "M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-3 7-6 7s-5-2-7-5l-1-2a1.5 1.5 0 0 1 2.5-1.5L8 13"),
  def("zoom", "Zoom", "Z", "M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM14.5 14.5L20 20"),
];

export const toolDef = (id: ToolId): ToolDef => TOOLS.find((t) => t.id === id)!;

/** Tool for a plain key press (no Ctrl / Alt), or `null`. */
export function toolForKey(key: string, shift: boolean): ToolId | null {
  const k = key.toLowerCase();
  return TOOLS.find((t) => t.key === k && t.shift === shift)?.id ?? null;
}

/** Inks offered in the options bar. "Shading" lightens with the left button and darkens with the right. */
export type InkChoice = "simple" | "alpha" | "lock" | "shading";
export const INKS: { key: InkChoice; label: string }[] = [
  { key: "simple", label: "Simple" },
  { key: "alpha", label: "Alpha" },
  { key: "lock", label: "Lock alpha" },
  { key: "shading", label: "Shading" },
];

export interface ToolOptions {
  /** Brush size in pixels. */
  size: number;
  ink: InkChoice;
  /** 0 to 100. */
  opacity: number;
  pixelPerfect: boolean;
  symmetry: Symmetry;
  /** Drawing wraps around the edges and the canvas shows the image 3×3. */
  tiled: boolean;
  /** Stored only; used by the animation stage. */
  onionSkin: boolean;
  /** Rectangle, ellipse and polygon are filled. */
  filled: boolean;
  /** Bucket and wand only spread to touching pixels. */
  contiguous: boolean;
  /** Bucket and wand: how different a colour may be (0 to 255). */
  tolerance: number;
  blurMode: "blur" | "jumble";
  /** Text height in pixels. */
  textSize: number;
}

export const defaultOptions: ToolOptions = {
  size: 1, ink: "simple", opacity: 100, pixelPerfect: true, symmetry: "none", tiled: false, onionSkin: false,
  filled: false, contiguous: true, tolerance: 0, blurMode: "blur", textSize: 8,
};

export const MAX_BRUSH = 64;
export const clampSize = (n: number) => Math.max(1, Math.min(MAX_BRUSH, Math.round(n) || 1));

export const FREEHAND: ToolId[] = ["pencil", "eraser", "shade", "spray", "blur"];
export const DRAG_SHAPES: ToolId[] = ["line", "rect", "ellipse", "gradient"];
export const SELECT_TOOLS: ToolId[] = ["marquee", "lasso", "wand"];
/** Tools that change the pixels of the active layer. */
export const changesPixels = (t: ToolId) => !SELECT_TOOLS.includes(t) && t !== "picker" && t !== "hand" && t !== "zoom";
export const usesFilled = (t: ToolId) => t === "rect" || t === "ellipse" || t === "polygon";
export const usesTolerance = (t: ToolId) => t === "bucket" || t === "wand";
export const usesBrush = (t: ToolId) => FREEHAND.includes(t) || t === "line" || t === "curve" || t === "rect" || t === "ellipse" || t === "polygon";

/** The ink a tool paints with. */
export function inkFor(tool: ToolId, ink: InkChoice, button: 0 | 2): Ink {
  if (tool === "eraser") return "erase";
  if (tool === "shade" || ink === "shading") return button === 2 ? "darken" : "lighten";
  return ink;
}

/** 1-bit image of rendered text (1 = ink). */
export interface Bitmap {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface Stroke {
  tool: ToolId;
  /** The layer image when the stroke started. It is never written to. */
  snapshot: Buf;
  /**
   * Freehand tools: the positions the pointer went through.
   * Line, rectangle, ellipse, gradient: start and end.
   * Curve: start, end and (once bent) the control point.
   * Polygon: the corners. Bucket and text: one position.
   */
  points: Pt[];
  /** 0 = left (foreground colour), 2 = right (background colour). */
  button: 0 | 2;
  fg: Rgba;
  bg: Rgba;
  options: ToolOptions;
  /** Selection: only these pixels may change. */
  mask: Mask | null;
  /** For spray and jumble, so a stroke looks the same each time it is redrawn. */
  seed: number;
  bitmap?: Bitmap;
}

const wrap = (n: number, size: number) => ((n % size) + size) % size;

/** Points mirrored (symmetry) and brought inside the image (wrapped in tiled mode). */
function placed(pts: Pt[], buf: Buf, o: ToolOptions): Pt[] {
  return fit(mirror(pts, buf.w, buf.h, o.symmetry), buf.w, buf.h, o.tiled);
}

/** Outline thickened by the brush, plus the fill when there is one. */
function shape(outline: Pt[], fill: Pt[] | null, size: number): Pt[] {
  const edge = stamp(outline, size);
  return fill ? dedupe([...edge, ...fill]) : edge;
}

/** Pixels a freehand stroke covers before symmetry and wrapping. */
export function freehandPoints(points: Pt[], o: ToolOptions): Pt[] {
  let path = pathPoints(points);
  if (o.pixelPerfect && o.size <= 1) path = pixelPerfect(path);
  return stamp(path, o.size);
}

export const sprayRadius = (size: number) => Math.max(1, size) * 2;

/** Pixels a shape tool covers before symmetry and wrapping. */
export function shapePoints(tool: ToolId, points: Pt[], o: ToolOptions): Pt[] {
  const [a, b, c] = points;
  if (!a) return [];
  const end = b ?? a;
  switch (tool) {
    case "line":
      return stamp(linePoints(a[0], a[1], end[0], end[1]), o.size);
    case "curve":
      // the control point is nudged a hair so the top of the bend never lands exactly
      // between two pixels (that left one stray pixel sticking out of the curve)
      return stamp(c ? curvePoints(a, [c[0] - 1e-3, c[1] - 1e-3], end) : linePoints(a[0], a[1], end[0], end[1]), o.size);
    case "rect":
      return shape(rectPoints(a[0], a[1], end[0], end[1], false), o.filled ? rectPoints(a[0], a[1], end[0], end[1], true) : null, o.size);
    case "ellipse":
      return shape(ellipsePoints(a[0], a[1], end[0], end[1], false), o.filled ? ellipsePoints(a[0], a[1], end[0], end[1], true) : null, o.size);
    case "polygon":
      return shape(polygonPoints(points, false), o.filled ? polygonPoints(points, true) : null, o.size);
    default:
      return [];
  }
}

/** Top-left positions of the pixels of rendered text. */
export function textPoints(bitmap: Bitmap, x: number, y: number): Pt[] {
  const out: Pt[] = [];
  for (let by = 0; by < bitmap.h; by++) {
    for (let bx = 0; bx < bitmap.w; bx++) if (bitmap.data[by * bitmap.w + bx]) out.push([x + bx, y + by]);
  }
  return out;
}

/**
 * The layer image after the stroke. Always drawn from the snapshot, so a
 * pixel gets the ink exactly once however often the pointer crossed it.
 */
export function applyStroke(s: Stroke): Buf {
  const buf = cloneBuf(s.snapshot);
  const o = s.options;
  const color = s.button === 2 ? s.bg : s.fg;
  const other = s.button === 2 ? s.fg : s.bg;
  const ink = inkFor(s.tool, o.ink, s.button);
  const draw = (pts: Pt[]) => paint(buf, placed(pts, buf, o), { color, ink, opacity: o.opacity, mask: s.mask });
  if (s.points.length === 0) return buf;

  switch (s.tool) {
    case "pencil":
    case "eraser":
    case "shade":
      draw(freehandPoints(s.points, o));
      break;
    case "spray": {
      const random = rng(s.seed);
      const radius = sprayRadius(o.size);
      const dots: Pt[] = [];
      for (const [x, y] of s.points) dots.push(...sprayPoints(x, y, radius, 2 + o.size, random));
      draw(dedupe(dots));
      break;
    }
    case "blur": {
      const pts = placed(stamp(pathPoints(s.points), o.size), buf, o);
      if (o.blurMode === "blur") blurPoints(buf, s.snapshot, pts, s.mask);
      else jumblePoints(buf, pts, s.mask, rng(s.seed));
      break;
    }
    case "line":
    case "curve":
    case "rect":
    case "ellipse":
    case "polygon":
      draw(shapePoints(s.tool, s.points, o));
      break;
    case "gradient": {
      const a = s.points[0];
      const b = s.points[1] ?? a;
      gradient(buf, a, b, color, other, s.mask, o.opacity);
      break;
    }
    case "bucket": {
      let [x, y] = s.points[0];
      if (o.tiled) {
        x = wrap(x, buf.w);
        y = wrap(y, buf.h);
      }
      const area = floodMask(s.snapshot, x, y, o.tolerance, o.contiguous);
      paint(buf, maskPoints(area, buf.w), { color, ink, opacity: o.opacity, mask: s.mask });
      break;
    }
    case "text":
      if (s.bitmap) draw(textPoints(s.bitmap, s.points[0][0], s.points[0][1]));
      break;
    default:
      break;
  }
  return buf;
}

// --------------------------------------------------------------- selection

/** Shift adds to the selection, Alt takes away from it. */
export function selectMode(shift: boolean, alt: boolean): SelectMode {
  return alt ? "subtract" : shift ? "add" : "replace";
}

/** The area a selection tool describes (before it is combined with the current selection). */
export function selectArea(tool: ToolId, points: Pt[], cel: Buf, o: ToolOptions): Mask {
  const [a, b] = points;
  if (!a) return new Uint8Array(cel.w * cel.h);
  if (tool === "marquee") {
    const end = b ?? a;
    return pointsMask(rectPoints(a[0], a[1], end[0], end[1], true), cel.w, cel.h);
  }
  if (tool === "lasso") return pointsMask(polygonPoints(points, true), cel.w, cel.h);
  let [x, y] = a;
  if (o.tiled) {
    x = wrap(x, cel.w);
    y = wrap(y, cel.h);
  }
  return floodMask(cel, x, y, o.tolerance, o.contiguous);
}

export function select(current: Mask | null, tool: ToolId, points: Pt[], cel: Buf, o: ToolOptions, mode: SelectMode): Mask | null {
  return combineMasks(current, selectArea(tool, points, cel, o), mode);
}

export function selectAllMask(w: number, h: number): Mask {
  return new Uint8Array(w * h).fill(1);
}

// -------------------------------------------------------------------- move

/** Pixels lifted off a layer: they can be put down anywhere without damaging what is under them. */
export interface Floating {
  /** The layer without the lifted pixels. */
  base: Buf;
  clip: Buf;
  /** Where the clip currently sits. */
  x: number;
  y: number;
}

/** Lifts the selected pixels (or the whole layer when nothing is selected). */
export function lift(cel: Buf, mask: Mask | null): Floating {
  const clip = copyClip(cel, mask);
  if (!clip) return { base: cloneBuf(cel), clip: newBuf(1, 1), x: 0, y: 0 };
  const base = mask ? cloneBuf(cel) : newBuf(cel.w, cel.h);
  if (mask) clearArea(base, mask);
  return { base, clip: clip.buf, x: clip.x, y: clip.y };
}

/** The layer with the lifted pixels put down `dx`, `dy` away from where they sit. */
export function place(f: Floating, dx: number, dy: number, tiled: boolean): Buf {
  const out = cloneBuf(f.base);
  pasteClip(out, f.clip, f.x + dx, f.y + dy, tiled);
  return out;
}

/** The selection moved along with its pixels (wrapping in tiled mode). */
export function shiftSelection(mask: Mask | null, w: number, h: number, dx: number, dy: number, tiled: boolean): Mask | null {
  if (!mask) return null;
  const out = new Uint8Array(mask.length);
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    let x = (i % w) + dx;
    let y = Math.floor(i / w) + dy;
    if (tiled) {
      x = wrap(x, w);
      y = wrap(y, h);
    } else if (x < 0 || y < 0 || x >= w || y >= h) continue;
    out[y * w + x] = 1;
    any = true;
  }
  return any ? out : null;
}

/** Pasting: the clip lands where it was copied from (kept inside the image when it fits). */
export function pasteFloating(cel: Buf, clip: Clip): { floating: Floating; cel: Buf; selection: Mask | null } {
  const x = Math.max(0, Math.min(clip.x, cel.w - clip.buf.w));
  const y = Math.max(0, Math.min(clip.y, cel.h - clip.buf.h));
  const floating: Floating = { base: cel, clip: clip.buf, x, y };
  const sel = new Uint8Array(cel.w * cel.h);
  let any = false;
  for (let cy = 0; cy < clip.buf.h; cy++) {
    for (let cx = 0; cx < clip.buf.w; cx++) {
      const px = x + cx;
      const py = y + cy;
      if (px < 0 || py < 0 || px >= cel.w || py >= cel.h) continue;
      if (getPx(clip.buf, cx, cy)[3] === 0) continue;
      sel[py * cel.w + px] = 1;
      any = true;
    }
  }
  return { floating, cel: place(floating, 0, 0, false), selection: any ? sel : null };
}

// ----------------------------------------------------------------- helpers

/** Shift while dragging: lines snap to 45° steps, rectangles and ellipses become square. */
export function constrainEnd(tool: ToolId, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  if (tool === "rect" || tool === "ellipse" || tool === "marquee") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + sx * d, a[1] + sy * d];
  }
  if (tool === "line" || tool === "curve" || tool === "gradient") {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay * 2) return [b[0], a[1]];
    if (ay > ax * 2) return [a[0], b[1]];
    const d = Math.max(ax, ay);
    return [a[0] + sx * d, a[1] + sy * d];
  }
  return b;
}

/** Pixels the cursor outline surrounds for a tool at a position. */
export function cursorPoints(tool: ToolId, o: ToolOptions, p: Pt): Pt[] {
  if (tool === "spray") {
    const r = sprayRadius(o.size);
    const out: Pt[] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) out.push([p[0] + dx, p[1] + dy]);
    return out;
  }
  if (usesBrush(tool)) return brushOffsets(o.size).map(([dx, dy]) => [p[0] + dx, p[1] + dy] as Pt);
  return [p];
}

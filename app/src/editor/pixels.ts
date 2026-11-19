// Pixel logic of the editor. Pure functions over RGBA buffers: no DOM, no
// React, so every tool can be unit-tested with exact pixels.

export interface Buf {
  w: number;
  h: number;
  /** RGBA, straight (not premultiplied) alpha. */
  data: Uint8ClampedArray;
}

export type Rgba = [number, number, number, number];
export type Pt = [number, number];
/** Selection: 1 = selected. `null` everywhere means "no selection" (all editable). */
export type Mask = Uint8Array;

export const newBuf = (w: number, h: number): Buf => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });
export const cloneBuf = (b: Buf): Buf => ({ w: b.w, h: b.h, data: new Uint8ClampedArray(b.data) });
export const inside = (b: { w: number; h: number }, x: number, y: number) => x >= 0 && y >= 0 && x < b.w && y < b.h;

export function getPx(b: Buf, x: number, y: number): Rgba {
  const i = (y * b.w + x) * 4;
  return [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]];
}

export function setPx(b: Buf, x: number, y: number, c: Rgba) {
  const i = (y * b.w + x) * 4;
  b.data[i] = c[0];
  b.data[i + 1] = c[1];
  b.data[i + 2] = c[2];
  b.data[i + 3] = c[3];
}

export const sameColor = (a: Rgba, b: Rgba) =>
  a[3] === b[3] && (a[3] === 0 || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]));

// ------------------------------------------------------------------ colours

export function rgbaToHex(c: Rgba): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] < 255 ? h(c[3]) : ""}`;
}

export function hexToRgba(hex: string): Rgba | null {
  const s = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length === 3) return [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16)).concat(255) as Rgba;
  if (s.length === 6 || s.length === 8) {
    const n = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
    return [n[0], n[1], n[2], s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255];
  }
  return null;
}

/** h 0-360, s and v 0-100. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(max === 0 ? 0 : (d / max) * 100), Math.round((max / 255) * 100)];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const sv = s / 100;
  const vv = v / 100;
  const c = vv * sv;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = vv - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** `src` over `dst`, straight alpha. */
export function over(dst: Rgba, src: Rgba): Rgba {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  const ch = (i: number) => Math.round((src[i] * sa + dst[i] * da * (1 - sa)) / oa);
  return [ch(0), ch(1), ch(2), Math.round(oa * 255)];
}

// --------------------------------------------------------------------- inks

/**
 * simple: replace the pixel (opacity mixes towards the new colour);
 * alpha: paint over like real paint; lock: only on existing pixels, keeping
 * their transparency; erase: remove; lighten / darken: shading.
 */
export type Ink = "simple" | "alpha" | "lock" | "erase" | "lighten" | "darken";

const SHADE_STEP = 10; // percent of brightness per stroke

export function applyInk(dst: Rgba, color: Rgba, ink: Ink, opacity: number): Rgba {
  const o = Math.max(0, Math.min(100, opacity)) / 100;
  switch (ink) {
    case "simple": {
      if (o >= 1) return [color[0], color[1], color[2], color[3]];
      const mix = (i: number) => Math.round(dst[i] + (color[i] - dst[i]) * o);
      // mixing with a fully transparent pixel keeps the new colour, only alpha fades
      if (dst[3] === 0) return [color[0], color[1], color[2], Math.round(color[3] * o)];
      return [mix(0), mix(1), mix(2), mix(3)];
    }
    case "alpha":
      return over(dst, [color[0], color[1], color[2], Math.round(color[3] * o)]);
    case "lock": {
      if (dst[3] === 0) return dst;
      const c = over([dst[0], dst[1], dst[2], 255], [color[0], color[1], color[2], Math.round(color[3] * o)]);
      return [c[0], c[1], c[2], dst[3]];
    }
    case "erase": {
      const a = Math.round(dst[3] * (1 - o));
      return a === 0 ? [0, 0, 0, 0] : [dst[0], dst[1], dst[2], a];
    }
    case "lighten":
    case "darken": {
      if (dst[3] === 0) return dst;
      const [h, s, v] = rgbToHsv(dst[0], dst[1], dst[2]);
      const step = SHADE_STEP * o * (ink === "lighten" ? 1 : -1);
      const nv = Math.max(0, Math.min(100, v + step));
      // a little saturation shift keeps shades from looking washed out
      const ns = Math.max(0, Math.min(100, s - step * 0.4));
      const [r, g, b] = hsvToRgb(h, ns, nv);
      return [r, g, b, dst[3]];
    }
  }
}

// ------------------------------------------------------------------- shapes

/** Bresenham line, both ends included. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}

/** Joins mouse positions into one continuous path. */
export function pathPoints(stops: Pt[]): Pt[] {
  if (stops.length === 0) return [];
  const out: Pt[] = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const seg = linePoints(stops[i - 1][0], stops[i - 1][1], stops[i][0], stops[i][1]);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  }
  return out;
}

/** Removes the corner pixel of every "L" in a 1-pixel path (pixel-perfect drawing). */
export function pixelPerfect(path: Pt[]): Pt[] {
  if (path.length < 3) return path.slice();
  const out: Pt[] = [path[0]];
  let i = 1;
  while (i < path.length - 1) {
    const prev = out[out.length - 1];
    const cur = path[i];
    const next = path[i + 1];
    const corner =
      (prev[0] === cur[0] || prev[1] === cur[1]) &&
      (next[0] === cur[0] || next[1] === cur[1]) &&
      prev[0] !== next[0] &&
      prev[1] !== next[1];
    if (corner) {
      out.push(next);
      i += 2;
    } else {
      out.push(cur);
      i += 1;
    }
  }
  if (i === path.length - 1) out.push(path[i]);
  return out;
}

/** Offsets covered by a brush of `size` pixels (round from 3 px up). */
export function brushOffsets(size: number): Pt[] {
  const s = Math.max(1, Math.round(size));
  const start = -Math.floor(s / 2);
  const out: Pt[] = [];
  const r = s / 2;
  const c = start + (s - 1) / 2;
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      const x = start + dx;
      const y = start + dy;
      if (s < 3 || (x - c) ** 2 + (y - c) ** 2 <= r * r) out.push([x, y]);
    }
  }
  return out;
}

/** Every pixel touched when a brush follows a path (no duplicates, path order kept). */
export function stamp(path: Pt[], size: number): Pt[] {
  if (size <= 1) return dedupe(path);
  const offs = brushOffsets(size);
  const out: Pt[] = [];
  for (const [x, y] of path) for (const [dx, dy] of offs) out.push([x + dx, y + dy]);
  return dedupe(out);
}

export function dedupe(pts: Pt[]): Pt[] {
  const seen = new Set<number>();
  const out: Pt[] = [];
  for (const p of pts) {
    const k = (p[1] + 32768) * 65536 + (p[0] + 32768);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

export function rectPoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Pt[] {
  const [l, r] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [t, b] = y0 < y1 ? [y0, y1] : [y1, y0];
  const out: Pt[] = [];
  for (let y = t; y <= b; y++) {
    for (let x = l; x <= r; x++) {
      if (filled || y === t || y === b || x === l || x === r) out.push([x, y]);
    }
  }
  return out;
}

/** Ellipse inscribed in the rectangle between the two corners. */
export function ellipsePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Pt[] {
  const [l, r] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [t, b] = y0 < y1 ? [y0, y1] : [y1, y0];
  const w = r - l + 1;
  const h = b - t + 1;
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  const rx = w / 2;
  const ry = h / 2;
  // a pixel is inside when its centre is inside the ellipse
  const isIn = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  const out: Pt[] = [];
  for (let y = t; y <= b; y++) {
    for (let x = l; x <= r; x++) {
      if (!isIn(x, y)) continue;
      if (filled) out.push([x, y]);
      else if (!isIn(x - 1, y) || !isIn(x + 1, y) || !isIn(x, y - 1) || !isIn(x, y + 1)) out.push([x, y]);
    }
  }
  return out;
}

/** Outline through the points (closed), optionally filled (even-odd scanline). */
export function polygonPoints(pts: Pt[], filled: boolean): Pt[] {
  if (pts.length === 0) return [];
  const outline = pathPoints([...pts, pts[0]]);
  if (!filled || pts.length < 3) return dedupe(outline);
  const ys = pts.map((p) => p[1]);
  const out: Pt[] = [...outline];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    const xs: number[] = [];
    const yc = y + 0.5;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const [a0, a1] = [ay + 0.5, by + 0.5];
      if ((a0 <= yc && a1 > yc) || (a1 <= yc && a0 > yc)) xs.push(ax + 0.5 + ((yc - a0) / (a1 - a0)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i] - 0.5); x <= Math.floor(xs[i + 1] - 0.5); x++) out.push([x, y]);
    }
  }
  return dedupe(out);
}

/** Quadratic curve from `a` to `b`, pulled towards `c`. */
export function curvePoints(a: Pt, c: Pt, b: Pt): Pt[] {
  const steps = Math.max(8, Math.ceil((Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1])) * 2));
  const stops: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t ** 2 * b[0];
    const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t ** 2 * b[1];
    const p: Pt = [Math.round(x), Math.round(y)];
    const last = stops[stops.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) stops.push(p);
  }
  return dedupe(pathPoints(stops));
}

/** Small deterministic random generator (so spray and jumble can be tested). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Random dots inside a circle. */
export function sprayPoints(cx: number, cy: number, radius: number, count: number, random: () => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * radius;
    out.push([Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r)]);
  }
  return out;
}

// ------------------------------------------------- symmetry, wrap, selection

export type Symmetry = "none" | "x" | "y" | "both";

/** Mirrors points across the middle of the image. */
export function mirror(pts: Pt[], w: number, h: number, mode: Symmetry): Pt[] {
  if (mode === "none") return pts;
  const out: Pt[] = [...pts];
  for (const [x, y] of pts) {
    if (mode === "x" || mode === "both") out.push([w - 1 - x, y]);
    if (mode === "y" || mode === "both") out.push([x, h - 1 - y]);
    if (mode === "both") out.push([w - 1 - x, h - 1 - y]);
  }
  return dedupe(out);
}

/** Keeps points inside the image; in tiled mode they wrap around instead. */
export function fit(pts: Pt[], w: number, h: number, tiled: boolean): Pt[] {
  if (!tiled) return pts.filter(([x, y]) => x >= 0 && y >= 0 && x < w && y < h);
  return dedupe(pts.map(([x, y]) => [((x % w) + w) % w, ((y % h) + h) % h] as Pt));
}

export interface PaintOptions {
  color: Rgba;
  ink: Ink;
  opacity: number;
  mask?: Mask | null;
}

/** Applies an ink once to each point (points must already be inside the image). */
export function paint(buf: Buf, pts: Pt[], o: PaintOptions) {
  for (const [x, y] of pts) {
    if (o.mask && !o.mask[y * buf.w + x]) continue;
    setPx(buf, x, y, applyInk(getPx(buf, x, y), o.color, o.ink, o.opacity));
  }
}

// --------------------------------------------------------------- fill, wand

/** Pixels reachable from (x, y) with a similar colour (or all similar pixels when not contiguous). */
export function floodMask(buf: Buf, x: number, y: number, tolerance: number, contiguous: boolean): Mask {
  const mask = new Uint8Array(buf.w * buf.h);
  if (!inside(buf, x, y)) return mask;
  const target = getPx(buf, x, y);
  const close = (i: number) => {
    const d = buf.data;
    const a = d[i * 4 + 3];
    if (a === 0 && target[3] === 0) return true;
    return (
      Math.abs(d[i * 4] - target[0]) <= tolerance &&
      Math.abs(d[i * 4 + 1] - target[1]) <= tolerance &&
      Math.abs(d[i * 4 + 2] - target[2]) <= tolerance &&
      Math.abs(a - target[3]) <= tolerance
    );
  };
  if (!contiguous) {
    for (let i = 0; i < mask.length; i++) if (close(i)) mask[i] = 1;
    return mask;
  }
  const stack = [y * buf.w + x];
  mask[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const px = i % buf.w;
    const py = (i - px) / buf.w;
    const tryAt = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= buf.w || ny >= buf.h) return;
      const j = ny * buf.w + nx;
      if (!mask[j] && close(j)) {
        mask[j] = 1;
        stack.push(j);
      }
    };
    tryAt(px + 1, py);
    tryAt(px - 1, py);
    tryAt(px, py + 1);
    tryAt(px, py - 1);
  }
  return mask;
}

export function maskPoints(mask: Mask, w: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push([i % w, Math.floor(i / w)]);
  return out;
}

export function pointsMask(pts: Pt[], w: number, h: number): Mask {
  const m = new Uint8Array(w * h);
  for (const [x, y] of pts) if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = 1;
  return m;
}

export type SelectMode = "replace" | "add" | "subtract";

export function combineMasks(current: Mask | null, next: Mask, mode: SelectMode): Mask | null {
  let out: Mask;
  if (mode === "replace" || !current) {
    out = mode === "subtract" ? new Uint8Array(next.length) : next.slice();
  } else {
    out = current.slice();
    for (let i = 0; i < out.length; i++) {
      if (mode === "add") out[i] = out[i] | next[i];
      else if (next[i]) out[i] = 0;
    }
  }
  return out.some((v) => v) ? out : null;
}

export function maskBounds(mask: Mask, w: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ------------------------------------------------------- gradient, blur, text

/** Linear gradient from `c0` at `a` to `c1` at `b`, on the masked area (or everywhere). */
export function gradient(buf: Buf, a: Pt, b: Pt, c0: Rgba, c1: Rgba, mask: Mask | null, opacity = 100) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  for (let y = 0; y < buf.h; y++) {
    for (let x = 0; x < buf.w; x++) {
      if (mask && !mask[y * buf.w + x]) continue;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
      const c: Rgba = [0, 1, 2, 3].map((i) => Math.round(c0[i] + (c1[i] - c0[i]) * t)) as Rgba;
      setPx(buf, x, y, applyInk(getPx(buf, x, y), c, "alpha", opacity));
    }
  }
}

/** Soft blur of the given pixels, reading from `source` (the image before the stroke). */
export function blurPoints(buf: Buf, source: Buf, pts: Pt[], mask: Mask | null) {
  for (const [x, y] of pts) {
    if (mask && !mask[y * buf.w + x]) continue;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inside(source, nx, ny)) continue;
        const p = getPx(source, nx, ny);
        const wgt = (dx === 0 && dy === 0 ? 4 : 1) * (p[3] / 255);
        r += p[0] * wgt;
        g += p[1] * wgt;
        b += p[2] * wgt;
        a += p[3] * (dx === 0 && dy === 0 ? 4 : 1);
        n += dx === 0 && dy === 0 ? 4 : 1;
      }
    }
    const wsum = a / 255;
    setPx(buf, x, y, wsum === 0 ? [0, 0, 0, 0] : [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum), Math.round(a / n)]);
  }
}

/** Jumble: swaps each pixel with a random neighbour. */
export function jumblePoints(buf: Buf, pts: Pt[], mask: Mask | null, random: () => number) {
  for (const [x, y] of pts) {
    const nx = x + Math.round(random() * 2 - 1);
    const ny = y + Math.round(random() * 2 - 1);
    if (!inside(buf, nx, ny)) continue;
    if (mask && (!mask[y * buf.w + x] || !mask[ny * buf.w + nx])) continue;
    const a = getPx(buf, x, y);
    setPx(buf, x, y, getPx(buf, nx, ny));
    setPx(buf, nx, ny, a);
  }
}

// ------------------------------------------------------ clips, move, layers

export interface Clip {
  x: number;
  y: number;
  buf: Buf;
}

/** Copies the selected pixels (or the whole image) into a clip. */
export function copyClip(buf: Buf, mask: Mask | null): Clip | null {
  const bounds = mask ? maskBounds(mask, buf.w) : { x: 0, y: 0, w: buf.w, h: buf.h };
  if (!bounds) return null;
  const out = newBuf(bounds.w, bounds.h);
  for (let y = 0; y < bounds.h; y++) {
    for (let x = 0; x < bounds.w; x++) {
      const sx = bounds.x + x;
      const sy = bounds.y + y;
      if (mask && !mask[sy * buf.w + sx]) continue;
      setPx(out, x, y, getPx(buf, sx, sy));
    }
  }
  return { x: bounds.x, y: bounds.y, buf: out };
}

/** Clears the selected pixels (or everything). */
export function clearArea(buf: Buf, mask: Mask | null) {
  for (let i = 0; i < buf.w * buf.h; i++) {
    if (mask && !mask[i]) continue;
    buf.data.fill(0, i * 4, i * 4 + 4);
  }
}

/** Draws a clip at (x, y); transparent clip pixels leave the image alone. */
export function pasteClip(buf: Buf, clip: Buf, x: number, y: number, tiled = false) {
  for (let cy = 0; cy < clip.h; cy++) {
    for (let cx = 0; cx < clip.w; cx++) {
      const c = getPx(clip, cx, cy);
      if (c[3] === 0) continue;
      let dx = x + cx;
      let dy = y + cy;
      if (tiled) {
        dx = ((dx % buf.w) + buf.w) % buf.w;
        dy = ((dy % buf.h) + buf.h) % buf.h;
      } else if (!inside(buf, dx, dy)) continue;
      setPx(buf, dx, dy, over(getPx(buf, dx, dy), c));
    }
  }
}

/** A mask moved by (dx, dy); parts leaving the image are dropped. */
export function shiftMask(mask: Mask, w: number, h: number, dx: number, dy: number): Mask | null {
  const out = new Uint8Array(mask.length);
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = (i % w) + dx;
    const y = Math.floor(i / w) + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    out[y * w + x] = 1;
    any = true;
  }
  return any ? out : null;
}

export interface LayerView {
  buf: Buf;
  visible: boolean;
  /** 0 to 100. */
  opacity: number;
}

/** Flattens layers (bottom first) into one image. */
export function composite(w: number, h: number, layers: LayerView[]): Buf {
  const out = newBuf(w, h);
  for (const l of layers) {
    if (!l.visible || l.opacity <= 0) continue;
    const o = l.opacity / 100;
    const s = l.buf.data;
    const d = out.data;
    for (let i = 0; i < w * h * 4; i += 4) {
      const sa = (s[i + 3] / 255) * o;
      if (sa === 0) continue;
      const da = d[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      d[i] = Math.round((s[i] * sa + d[i] * da * (1 - sa)) / oa);
      d[i + 1] = Math.round((s[i + 1] * sa + d[i + 1] * da * (1 - sa)) / oa);
      d[i + 2] = Math.round((s[i + 2] * sa + d[i + 2] * da * (1 - sa)) / oa);
      d[i + 3] = Math.round(oa * 255);
    }
  }
  return out;
}

/** Distinct visible colours, most used first (at most `max`). */
export function extractPalette(buf: Buf, max = 48): Rgba[] {
  const counts = new Map<number, number>();
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => [(k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255] as Rgba)
    .sort((a, b) => {
      const [ha, , va] = rgbToHsv(a[0], a[1], a[2]);
      const [hb, , vb] = rgbToHsv(b[0], b[1], b[2]);
      return va - vb || ha - hb;
    });
}

/** Nearest-neighbour resize (used for the vanilla reference layer). */
export function scaleNearest(src: Buf, w: number, h: number): Buf {
  const out = newBuf(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor((x * src.w) / w));
      setPx(out, x, y, getPx(src, sx, sy));
    }
  }
  return out;
}

/** Cuts one frame out of a vertical strip. */
export function cropFrame(strip: Buf, frameH: number, index: number): Buf {
  const out = newBuf(strip.w, frameH);
  const start = index * frameH * strip.w * 4;
  out.data.set(strip.data.subarray(start, start + strip.w * frameH * 4));
  return out;
}

/** Stacks frames vertically (the format the game expects for animations). */
export function stackFrames(frames: Buf[]): Buf {
  const w = frames[0].w;
  const h = frames[0].h;
  const out = newBuf(w, h * frames.length);
  frames.forEach((f, i) => out.data.set(f.data, i * w * h * 4));
  return out;
}

// ------------------------------------------------------------------- base64

export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8ClampedArray {
  const s = atob(b64);
  const out = new Uint8ClampedArray(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

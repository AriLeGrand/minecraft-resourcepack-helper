// The pack palette: colours shared by the whole pack (kept in the project
// file by Rust). Nearest colours are found in OKLab, the same perceptual
// space as the export check in `core/src/palette.rs`. Pure, no DOM.
import { hexToRgba, rgbaToHex, type Buf, type Rgba } from "./pixels";

/** Most colours a pack palette holds (Rust refuses more). */
export const MAX_PACK_COLOURS = 64;
/** A pack palette usually has this many colours or more. */
export const SUGGESTED_MIN = 16;

const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB (8 bit) → OKLab (Björn Ottosson's reference matrices). */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** A palette prepared for nearest-colour lookups. */
export interface SnapPalette {
  rgb: [number, number, number][];
  lab: [number, number, number][];
  /** Colour key (r<<16|g<<8|b) → index of the nearest palette colour. */
  cache: Map<number, number>;
}

/** `null` when the list has no valid colour. */
export function snapPalette(hexes: string[]): SnapPalette | null {
  const rgb: [number, number, number][] = [];
  for (const h of hexes) {
    const c = hexToRgba(h);
    if (c) rgb.push([c[0], c[1], c[2]]);
  }
  if (rgb.length === 0) return null;
  return { rgb, lab: rgb.map(([r, g, b]) => oklab(r, g, b)), cache: new Map() };
}

/** Index of the palette colour nearest to (r, g, b) in OKLab. */
export function nearestIndex(p: SnapPalette, r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const hit = p.cache.get(key);
  if (hit !== undefined) return hit;
  const [L, A, B] = oklab(r, g, b);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < p.lab.length; i++) {
    const q = p.lab[i];
    const d = (q[0] - L) ** 2 + (q[1] - A) ** 2 + (q[2] - B) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  p.cache.set(key, best);
  return best;
}

/** The colour with its RGB snapped to the palette; alpha is kept. */
export function snapColor(p: SnapPalette, c: Rgba): Rgba {
  const [r, g, b] = p.rgb[nearestIndex(p, c[0], c[1], c[2])];
  return [r, g, b, c[3]];
}

/** Snaps one pixel in place (fully transparent pixels are left alone). */
export function snapPixel(buf: Buf, x: number, y: number, p: SnapPalette) {
  const i = (y * buf.w + x) * 4;
  const d = buf.data;
  if (d[i + 3] === 0) return;
  const [r, g, b] = p.rgb[nearestIndex(p, d[i], d[i + 1], d[i + 2])];
  d[i] = r;
  d[i + 1] = g;
  d[i + 2] = b;
}

/** Snaps every pixel of `buf` that differs from `before` (what a tool just drew). */
export function snapChanged(buf: Buf, before: Buf, p: SnapPalette) {
  const a = buf.data;
  const b = before.data;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
    const px = i / 4;
    snapPixel(buf, px % buf.w, Math.floor(px / buf.w), p);
  }
}

// --------------------------------------------------- editing the list

const norm = (hex: string) => {
  const c = hexToRgba(hex);
  return c ? rgbaToHex([c[0], c[1], c[2], 255]) : null;
};

/** Adds a colour at the end (alpha is dropped); unchanged when already there or full. */
export function addColour(list: string[], c: Rgba): string[] {
  const hex = rgbaToHex([c[0], c[1], c[2], 255]);
  if (list.includes(hex) || list.length >= MAX_PACK_COLOURS) return list;
  return [...list, hex];
}

export function removeColour(list: string[], hex: string): string[] {
  const n = norm(hex);
  return list.filter((h) => h !== n);
}

/** Moves a colour one place to the left (-1) or right (1). */
export function moveColour(list: string[], hex: string, delta: -1 | 1): string[] {
  const i = list.indexOf(norm(hex) ?? "");
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** "Fill from this texture": the texture's most used colours (alpha dropped, no repeats). */
export function fillFrom(colours: Rgba[]): string[] {
  const out: string[] = [];
  for (const c of colours) {
    if (c[3] === 0) continue;
    const hex = rgbaToHex([c[0], c[1], c[2], 255]);
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= MAX_PACK_COLOURS) break;
  }
  return out;
}

// Helpers shared by the editor tests. Synthetic pixels only.
import type { OpenedRaw } from "../lib/api";
import { fromRaw, type EditorDoc } from "./doc";
import { bytesToBase64, getPx, newBuf, setPx, type Buf, type Rgba } from "./pixels";

export const RED: Rgba = [255, 0, 0, 255];
export const GREEN: Rgba = [0, 255, 0, 255];
export const BLUE: Rgba = [0, 0, 255, 255];
export const CLEAR: Rgba = [0, 0, 0, 0];

/** Draws a buffer as text: '#' = opaque, '+' = partly transparent, '.' = empty. */
export function art(b: Buf): string[] {
  const rows: string[] = [];
  for (let y = 0; y < b.h; y++) {
    let s = "";
    for (let x = 0; x < b.w; x++) {
      const a = getPx(b, x, y)[3];
      s += a === 0 ? "." : a === 255 ? "#" : "+";
    }
    rows.push(s);
  }
  return rows;
}

/** A mask as text: '#' = selected. */
export function maskArt(mask: Uint8Array | null, w: number): string[] {
  if (!mask) return [];
  const rows: string[] = [];
  for (let i = 0; i < mask.length; i += w) rows.push([...mask.subarray(i, i + w)].map((v) => (v ? "#" : ".")).join(""));
  return rows;
}

/** A buffer from rows of characters; `colors` maps a character to a colour ('.' is empty). */
export function bufFrom(rows: string[], colors: Record<string, Rgba> = { "#": RED }): Buf {
  const b = newBuf(rows[0].length, rows.length);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (colors[ch]) setPx(b, x, y, colors[ch]); }));
  return b;
}

export function solid(w: number, h: number, c: Rgba): Buf {
  const b = newBuf(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPx(b, x, y, c);
  return b;
}

/** What `editor_open` would return for a document made of these layers (bottom first), one frame each list. */
export function opened(frames: Buf[][], extra: Partial<OpenedRaw> & { layerNames?: string[] } = {}): OpenedRaw {
  const first = frames[0][0];
  const names = extra.layerNames ?? frames[0].map((_, i) => (i === 0 ? "Base" : `Layer ${i + 1}`));
  return {
    path: extra.path ?? "block/test",
    origin: extra.origin ?? "pack_png",
    doc: {
      width: first.w,
      height: first.h,
      layers: names.map((name) => ({ name, visible: true, locked: false, opacity: 100 })),
      frames: frames.map((cels) => ({ cels: cels.map((c) => bytesToBase64(c.data)), time: null })),
      animation: frames.length > 1 ? { frametime: 2, interpolate: false, frames: null, width: null, height: null } : null,
      palette: [],
      ...extra.doc,
    },
    vanilla: extra.vanilla ?? null,
    vanilla_frames: extra.vanilla_frames ?? 0,
  };
}

export function docFrom(rows: string[], colors?: Record<string, Rgba>): EditorDoc {
  return fromRaw(opened([[bufFrom(rows, colors)]]));
}

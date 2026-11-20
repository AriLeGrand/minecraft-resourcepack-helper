import type { Buf } from "./pixels";

/**
 * Pixels of the texture being edited, shared with the 3D view without React:
 * `set` paints the canvas and tells the view, which uploads it again.
 * Kept apart from `BlockPreview.tsx` so that three.js is only loaded when a 3D
 * view is shown.
 */
export class LiveTexture {
  readonly canvas = document.createElement("canvas");
  private listeners = new Set<() => void>();
  set(buf: Buf) {
    const c = this.canvas;
    if (c.width !== buf.w) c.width = buf.w;
    if (c.height !== buf.h) c.height = buf.h;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), 0, 0);
    for (const fn of this.listeners) fn();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

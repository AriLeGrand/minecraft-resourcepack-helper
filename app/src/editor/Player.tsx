// Plays an animation at the game's speed (1 tick = 50 ms) on one or more
// canvases. The clock runs on requestAnimationFrame and paints the canvases
// directly: React does not render again while it plays, and a canvas is only
// painted again when what it shows has changed.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { blendFrames, docOrder, entryStart, frameAt, frametimeOf, TICK_MS, type At, type Entry } from "./anim";
import type { EditorDoc } from "./doc";
import type { Buf } from "./pixels";
import { flatFrame } from "./render";

export interface PlayerOptions {
  playing: boolean;
  loop: boolean;
  /** A play without loop reached its end. */
  onEnded?: () => void;
  /** What is shown changed (called outside React rendering; update the DOM directly). */
  onShow?: (at: At, entries: Entry[]) => void;
}

function paint(canvas: HTMLCanvasElement, buf: Buf) {
  if (canvas.width !== buf.w) canvas.width = buf.w;
  if (canvas.height !== buf.h) canvas.height = buf.h;
  const ctx = canvas.getContext("2d");
  // a canvas is for display only: the saved pixels never pass through one
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), 0, 0);
}

/**
 * Returns `slot(i)`: a ref callback for the i-th canvas that shows the
 * animation. Stops by itself when the component goes away.
 */
export function useAnimPlayer(doc: EditorDoc, opts: PlayerOptions) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const slots = useRef(new Map<number, (c: HTMLCanvasElement | null) => void>());
  const slot = useCallback((i: number) => {
    let fn = slots.current.get(i);
    if (!fn) {
      fn = (c) => {
        canvases.current[i] = c;
      };
      slots.current.set(i, fn);
    }
    return fn;
  }, []);

  const images = useMemo(
    () => doc.frames.map((_, i) => flatFrame(doc, i)),
    // the flattened frames only depend on the images and the layer list
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.frames, doc.layers, doc.width, doc.height],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => docOrder(doc), [doc.animation, doc.frames]);
  const live = useRef({ images, entries, frametime: 1, interpolate: false, loop: opts.loop, frameIndex: 0, opts });
  live.current = {
    images, entries, frametime: frametimeOf(doc.animation), interpolate: doc.animation?.interpolate ?? false,
    loop: opts.loop, frameIndex: doc.frameIndex, opts,
  };

  const show = useCallback((at: At) => {
    const { images: imgs, entries: list, opts: o } = live.current;
    const cur = imgs[at.image] ?? imgs[0];
    if (!cur) return;
    const next = at.next !== null ? imgs[at.next] : undefined;
    const buf = next ? blendFrames(cur, next, at.sub, at.ticks) : cur;
    for (const c of canvases.current) if (c) paint(c, buf);
    o.onShow?.(at, list);
  }, []);

  // paused: the frame being edited, as it is now
  const { playing } = opts;
  useEffect(() => {
    if (playing) return;
    const { entries: list, frametime } = live.current;
    const first = Math.max(0, list.findIndex((e) => e.index === doc.frameIndex));
    show({ entry: first, image: doc.frameIndex, sub: 0, ticks: Math.max(1, list[first]?.time ?? frametime), next: null, ended: false });
  }, [playing, images, entries, doc.frameIndex, show]);

  // playing: from the first entry that shows the frame being edited
  useEffect(() => {
    if (!playing) return;
    const s = live.current;
    const first = Math.max(0, s.entries.findIndex((e) => e.index === s.frameIndex));
    const start = performance.now() - entryStart(s.entries, s.frametime, first) * TICK_MS;
    let raf = 0;
    let last = "";
    let lastImages: Buf[] | null = null;
    const step = (now: number) => {
      const c = live.current;
      const tick = Math.floor((now - start) / TICK_MS);
      const at = frameAt(c.entries, c.frametime, tick, c.loop, c.interpolate);
      const key = `${at.entry}:${at.image}:${at.next === null ? -1 : at.sub}:${at.next}`;
      if (key !== last || lastImages !== c.images) {
        last = key;
        lastImages = c.images;
        show(at);
      }
      if (at.ended) {
        c.opts.onEnded?.();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, show]);

  return slot;
}

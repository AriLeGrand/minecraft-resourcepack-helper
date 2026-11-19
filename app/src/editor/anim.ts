// Animation: play order, timing, frame operations that keep the play order
// consistent, and splitting an imported strip into frames. Pure (no DOM).
//
// Words used here:
// - image: one frame of the document (one picture, all layers). The strip on
//   disk is the images stacked top to bottom.
// - entry: one step of the play order (`animation.frames` in the `.mcmeta`).
//   Entries point at an image by its place in the strip (from 0) and may
//   repeat images and carry their own duration.
import type { AnimFrame, Animation } from "../lib/api";
import type { EditorDoc, Frame } from "./doc";
import { cropFrame, newBuf, scaleNearest, type Buf } from "./pixels";

/** One game tick. The game runs at 20 ticks a second. */
export const TICK_MS = 50;
/** Frame time given to a texture that becomes animated here (as in the design). */
export const DEFAULT_FRAMETIME = 2;
/** Upper limit for durations typed in by hand (about 8 minutes). */
export const MAX_TICKS = 9999;

export type Entry = AnimFrame;
export type OrderKind = "inOrder" | "pingPong" | "custom";

export const defaultAnimation = (): Animation => ({
  frametime: DEFAULT_FRAMETIME, interpolate: false, frames: null, width: null, height: null,
});

/** True when there is something to play: more than one entry in the play order. */
export const isPlayable = (doc: Pick<EditorDoc, "animation" | "frames">): boolean => docOrder(doc).length > 1;

/** The animation's frame time; the game's default is 1 tick. */
export const frametimeOf = (a: Animation | null): number => Math.max(1, a?.frametime ?? 1);

/** Per-image durations as stored with the images (used when there is no explicit order). */
export const imageTimes = (doc: Pick<EditorDoc, "frames">): (number | null)[] => doc.frames.map((f) => f.time);

/**
 * The play order the game uses: the explicit list, or every image top to
 * bottom with the images' own durations.
 */
export function playOrder(animation: Animation | null, times: (number | null)[]): Entry[] {
  if (animation?.frames) return animation.frames.map((e) => ({ index: e.index, time: e.time }));
  return times.map((time, index) => ({ index, time }));
}

export const docOrder = (doc: Pick<EditorDoc, "animation" | "frames">): Entry[] => playOrder(doc.animation, imageTimes(doc));

/** How long an entry is shown, in ticks (never less than 1). */
export const entryTicks = (e: Entry, frametime: number): number => Math.max(1, e.time ?? frametime);

export function loopTicks(entries: Entry[], frametime: number): number {
  let sum = 0;
  for (const e of entries) sum += entryTicks(e, frametime);
  return sum;
}

/** "0.10" for 2 ticks. */
export const secondsLabel = (ticks: number): string => ((ticks * TICK_MS) / 1000).toFixed(2);

/** "1.0" for 20 ticks: loop lengths are shown with one decimal (two when shorter than a second). */
export function loopLabel(ticks: number): string {
  const s = (ticks * TICK_MS) / 1000;
  return s < 1 ? s.toFixed(2) : s.toFixed(1);
}

// ---- presets

/** 0, 1, …, n-1, then back n-2 … 1 (the last and first are not shown twice). */
export function pingPong(n: number): number[] {
  if (n <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  for (let i = n - 2; i >= 1; i--) out.push(i);
  return out;
}

const sameIndexes = (entries: Entry[], list: number[]) =>
  entries.length === list.length && entries.every((e, i) => e.index === list[i]);

/** Which preset an order is (an explicit 0..n-1 list counts as "in order"). */
export function orderKind(animation: Animation | null, count: number): OrderKind {
  const list = animation?.frames;
  if (!list) return "inOrder";
  if (sameIndexes(list, Array.from({ length: count }, (_, i) => i))) return "inOrder";
  if (count > 1 && sameIndexes(list, pingPong(count))) return "pingPong";
  return "custom";
}

/** The order as typed in the custom field: "0, 1, 0, 2:5" (`:5` = own duration in ticks). */
export const formatOrder = (entries: Entry[]): string =>
  entries.map((e) => (e.time === null ? String(e.index) : `${e.index}:${e.time}`)).join(", ");

export type Parsed = { ok: true; entries: Entry[] } | { ok: false; error: string };

/** Reads a typed order. Numbers count from 0, like in the file. */
export function parseOrder(text: string, count: number): Parsed {
  const parts = text.split(/[\s,;]+/).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "Type at least one frame number, for example 0, 1, 2." };
  const entries: Entry[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?::(\d+))?$/);
    if (!m) return { ok: false, error: `“${part}” is not a frame number. Use numbers like 0, 1, 2 (or 2:5 for 5 ticks).` };
    const index = Number(m[1]);
    if (index >= count) {
      return {
        ok: false,
        error: `There is no frame ${index}: this texture has ${count} frame${count === 1 ? "" : "s"}, numbered 0 to ${count - 1}.`,
      };
    }
    let time: number | null = null;
    if (m[2] !== undefined) {
      time = Number(m[2]);
      if (time < 1 || time > MAX_TICKS) return { ok: false, error: `“${part}”: a duration must be 1 to ${MAX_TICKS} ticks.` };
    }
    entries.push({ index, time });
  }
  return { ok: true, entries };
}

// ---- timing

export interface At {
  /** Entry of the play order being shown. */
  entry: number;
  /** Image of that entry. */
  image: number;
  /** Whole ticks already spent in this entry. */
  sub: number;
  /** Length of this entry in ticks. */
  ticks: number;
  /** Image being blended in (interpolation), or `null`. */
  next: number | null;
  /** True once a non-looping play has reached its end (the last entry stays shown). */
  ended: boolean;
}

/**
 * What the game shows `tick` ticks after the animation started. With `loop`
 * off the last entry stays once the end is reached. With `interpolate` on the
 * image of the next entry is blended in (the game blends into the first entry
 * after the last one, as it loops).
 */
export function frameAt(entries: Entry[], frametime: number, tick: number, loop: boolean, interpolate: boolean): At {
  if (entries.length === 0) return { entry: 0, image: 0, sub: 0, ticks: 1, next: null, ended: true };
  const total = loopTicks(entries, frametime);
  const t0 = Math.max(0, Math.floor(tick));
  const ended = !loop && t0 >= total;
  let t = ended ? total - 1 : t0 % total;
  let i = 0;
  for (; i < entries.length; i++) {
    const len = entryTicks(entries[i], frametime);
    if (t < len) break;
    t -= len;
  }
  const e = entries[i];
  const ticks = entryTicks(e, frametime);
  const nextImage = entries[(i + 1) % entries.length].index;
  const next = interpolate && !ended && nextImage !== e.index ? nextImage : null;
  return { entry: i, image: e.index, sub: t, ticks, next, ended };
}

/** First tick of an entry (where playing from that entry starts). */
export function entryStart(entries: Entry[], frametime: number, entry: number): number {
  let t = 0;
  for (let i = 0; i < entry && i < entries.length; i++) t += entryTicks(entries[i], frametime);
  return t;
}

/**
 * The game's interpolation: colour channels are mixed with
 * `d = 1 - sub / ticks` of the current image and the rest of the next one,
 * cut to whole numbers; the alpha of the current image is kept.
 */
export function blendFrames(cur: Buf, next: Buf, sub: number, ticks: number): Buf {
  const d = 1.0 - sub / ticks;
  const out = new Uint8ClampedArray(cur.data.length);
  const a = cur.data;
  const b = next.data;
  for (let i = 0; i < a.length; i += 4) {
    out[i] = Math.trunc(d * a[i] + (1.0 - d) * b[i]);
    out[i + 1] = Math.trunc(d * a[i + 1] + (1.0 - d) * b[i + 1]);
    out[i + 2] = Math.trunc(d * a[i + 2] + (1.0 - d) * b[i + 2]);
    out[i + 3] = a[i + 3];
  }
  return { w: cur.w, h: cur.h, data: out };
}

// ---- durations per image

/** The image's own duration: the first entry showing it, or the image's stored time. `null` = frame time. */
export function imageTime(doc: Pick<EditorDoc, "animation" | "frames">, image: number): number | null {
  const list = doc.animation?.frames;
  if (list) return list.find((e) => e.index === image)?.time ?? null;
  return doc.frames[image]?.time ?? null;
}

/** Ticks the image is shown for (its first entry). */
export function imageTicks(doc: Pick<EditorDoc, "animation" | "frames">, image: number): number {
  return Math.max(1, imageTime(doc, image) ?? frametimeOf(doc.animation));
}

/**
 * The document with a new play order. Durations travel with it: going from
 * "every image in order" to a list gives each entry its image's duration,
 * going back gives each image the duration of its first entry. `null` or an
 * empty list means every image in order.
 */
export function withOrder(doc: EditorDoc, entries: Entry[] | null): EditorDoc {
  const anim = doc.animation ?? defaultAnimation();
  if (!entries || entries.length === 0) {
    const list = anim.frames;
    const frames = list
      ? doc.frames.map((f, i) => ({ ...f, time: list.find((e) => e.index === i)?.time ?? null }))
      : doc.frames;
    return { ...doc, frames, animation: { ...anim, frames: null } };
  }
  const own = (i: number) => imageTime(doc, i);
  const list = entries.map((e) => ({ index: e.index, time: e.time ?? (anim.frames ? null : own(e.index)) }));
  return { ...doc, frames: doc.frames.map((f) => (f.time === null ? f : { ...f, time: null })), animation: { ...anim, frames: list } };
}

/** Sets how long one image is shown (`null` = the frame time), wherever the order shows it. */
export function setImageTime(doc: EditorDoc, image: number, time: number | null): EditorDoc {
  if (!doc.frames[image]) return doc;
  const t = time === null ? null : Math.max(1, Math.min(MAX_TICKS, Math.round(time)));
  const anim = doc.animation ?? defaultAnimation();
  if (anim.frames) {
    if (!anim.frames.some((e) => e.index === image)) return doc;
    return { ...doc, animation: { ...anim, frames: anim.frames.map((e) => (e.index === image ? { ...e, time: t } : e)) } };
  }
  return { ...doc, animation: anim, frames: doc.frames.map((f, i) => (i === image ? { ...f, time: t } : f)) };
}

// ---- frame operations

/** A play order that was a ping-pong stays one; durations come along by image. */
function rebuildPingPong(doc: EditorDoc, times: Map<number, number | null>): EditorDoc {
  const anim = doc.animation ?? defaultAnimation();
  const list = pingPong(doc.frames.length).map((index) => ({ index, time: times.get(index) ?? null }));
  return { ...doc, animation: { ...anim, frames: doc.frames.length > 1 ? list : null } };
}

/** Image durations of a ping-pong order, by image (first entry wins). */
function timesByImage(entries: Entry[]): Map<number, number | null> {
  const m = new Map<number, number | null>();
  for (const e of entries) if (!m.has(e.index)) m.set(e.index, e.time);
  return m;
}

/** An animation for a document that now has more than one image. */
function ensureAnimation(doc: EditorDoc): EditorDoc {
  return doc.animation || doc.frames.length < 2 ? doc : { ...doc, animation: defaultAnimation() };
}

/**
 * Inserts an image at `at`. Entries pointing at images from `at` on move up
 * by one. A custom order plays the new image right after the last entry of
 * the image before it (or at the end); a ping-pong is built again.
 */
export function insertFrame(doc: EditorDoc, at: number, frame: Frame): EditorDoc {
  const pos = Math.max(0, Math.min(doc.frames.length, at));
  const kind = orderKind(doc.animation, doc.frames.length);
  const frames = [...doc.frames.slice(0, pos), frame, ...doc.frames.slice(pos)];
  let out: EditorDoc = { ...doc, frames, frameIndex: pos, dirty: true };
  const list = doc.animation?.frames;
  if (list) {
    if (kind === "pingPong") {
      const times = timesByImage(list.map((e) => ({ ...e, index: e.index >= pos ? e.index + 1 : e.index })));
      times.set(pos, frame.time);
      out = rebuildPingPong(out, times);
      out = { ...out, frames: out.frames.map((f) => (f.time === null ? f : { ...f, time: null })) };
    } else {
      const moved = list.map((e) => ({ ...e, index: e.index >= pos ? e.index + 1 : e.index }));
      const entry = { index: pos, time: frame.time };
      if (kind === "inOrder") {
        moved.splice(pos, 0, entry);
      } else {
        let after = -1;
        moved.forEach((e, i) => { if (e.index === pos - 1) after = i; });
        moved.splice(after < 0 ? moved.length : after + 1, 0, entry);
      }
      out = { ...out, animation: { ...doc.animation!, frames: moved }, frames: out.frames.map((f) => (f.time === null ? f : { ...f, time: null })) };
    }
  }
  return ensureAnimation(out);
}

/** A new empty image right after the current one; it becomes the current one. */
export function newFrame(doc: EditorDoc): EditorDoc {
  const cels = doc.layers.map(() => newBuf(doc.width, doc.height));
  return insertFrame(doc, doc.frameIndex + 1, { cels, time: null });
}

/** A copy of an image (all layers, same duration) right after it; the copy becomes current. */
export function duplicateFrame(doc: EditorDoc, image = doc.frameIndex): EditorDoc {
  const src = doc.frames[image];
  if (!src) return doc;
  // pixel buffers are never written to, so the copy may share them
  return insertFrame(doc, image + 1, { cels: src.cels.slice(), time: imageTime(doc, image) });
}

/**
 * Removes an image. Its entries leave the play order and later ones are
 * renumbered; an order left empty becomes "every image in order". The last
 * image cannot be removed.
 */
export function deleteFrame(doc: EditorDoc, image = doc.frameIndex): EditorDoc {
  const n = doc.frames.length;
  if (n <= 1 || !doc.frames[image]) return doc;
  const kind = orderKind(doc.animation, n);
  const frames = doc.frames.filter((_, i) => i !== image);
  const frameIndex = Math.min(frames.length - 1, doc.frameIndex > image ? doc.frameIndex - 1 : doc.frameIndex);
  let out: EditorDoc = { ...doc, frames, frameIndex, dirty: true };
  const list = doc.animation?.frames;
  if (list) {
    const left = list.filter((e) => e.index !== image).map((e) => ({ ...e, index: e.index > image ? e.index - 1 : e.index }));
    if (kind === "pingPong") out = rebuildPingPong(out, timesByImage(left));
    else if (left.length === 0) out = withOrder({ ...out, animation: { ...doc.animation!, frames: null } }, null);
    else out = { ...out, animation: { ...doc.animation!, frames: left } };
  }
  return out;
}

/**
 * Moves an image one place left (-1) or right (+1) in the strip. Entries keep
 * showing the same picture (their numbers are swapped); a ping-pong is built
 * again so it still plays the strip forward and back.
 */
export function moveFrame(doc: EditorDoc, image: number, delta: -1 | 1): EditorDoc {
  const to = image + delta;
  if (!doc.frames[image] || to < 0 || to >= doc.frames.length) return doc;
  const kind = orderKind(doc.animation, doc.frames.length);
  const frames = doc.frames.slice();
  [frames[image], frames[to]] = [frames[to], frames[image]];
  const swap = (i: number) => (i === image ? to : i === to ? image : i);
  const frameIndex = swap(doc.frameIndex);
  let out: EditorDoc = { ...doc, frames, frameIndex, dirty: true };
  const list = doc.animation?.frames;
  if (list) {
    const moved = list.map((e) => ({ ...e, index: swap(e.index) }));
    if (kind === "pingPong") out = rebuildPingPong(out, timesByImage(moved));
    else if (kind === "inOrder") {
      // "every image in order" stays that: the strip order is the play order
      const times = timesByImage(moved);
      out = { ...out, animation: { ...doc.animation!, frames: frames.map((_, index) => ({ index, time: times.get(index) ?? null })) } };
    } else out = { ...out, animation: { ...doc.animation!, frames: moved } };
  }
  return out;
}

// ---- strips

export type Split = { ok: true; frames: Buf[]; frameHeight: number } | { ok: false; error: string };

/**
 * Cuts a vertical strip into frames of `frameHeight` rows (by default as
 * tall as the image is wide). Refuses when the height is not a whole number
 * of frames. The pixels are never resized.
 */
export function splitStrip(img: Buf, frameHeight = img.w): Split {
  const fh = Math.round(frameHeight);
  if (!Number.isFinite(fh) || fh < 1) return { ok: false, error: "The frame height must be at least 1 pixel." };
  if (fh > img.h) {
    return { ok: false, error: `The image is only ${img.h} pixels tall, so it cannot hold a ${fh}-pixel frame.` };
  }
  if (img.h % fh !== 0) {
    const fits = Math.floor(img.h / fh);
    return {
      ok: false,
      error:
        `The image is ${img.w}×${img.h}: its height is not a whole number of ${fh}-pixel frames ` +
        `(${fits} frames use ${fits * fh} rows, ${img.h - fits * fh} are left over). ` +
        `Make the image a multiple of ${fh} pixels tall, or choose another frame height.`,
    };
  }
  const count = img.h / fh;
  const frames: Buf[] = [];
  for (let i = 0; i < count; i++) frames.push(cropFrame(img, fh, i));
  return { ok: true, frames, frameHeight: fh };
}

/**
 * Imported frames of the document's own size go into the active layer, frame
 * by frame; frames are added when the strip has more. Other layers of the
 * added frames are empty.
 */
export function importSameSize(doc: EditorDoc, images: Buf[]): EditorDoc {
  if (images.length === 0) return doc;
  const layer = doc.activeLayer;
  let out = doc;
  const extra = images.length - doc.frames.length;
  for (let k = 0; k < extra; k++) {
    out = insertFrame(out, out.frames.length, { cels: doc.layers.map(() => newBuf(doc.width, doc.height)), time: null });
  }
  const frames = out.frames.map((f, i) => (images[i] ? { ...f, cels: f.cels.map((c, li) => (li === layer ? images[i] : c)) } : f));
  return ensureAnimation({ ...out, frames, frameIndex: Math.min(doc.frameIndex, frames.length - 1), dirty: true });
}

/**
 * Imported frames of another size replace every frame and layer: one layer,
 * one image per frame, at the strip's size (never resized). The play order is
 * kept when it still fits, otherwise it becomes "every image in order".
 */
export function importReplacing(doc: EditorDoc, images: Buf[], layerName = "Imported"): EditorDoc {
  if (images.length === 0) return doc;
  const { w, h } = images[0];
  const kind = orderKind(doc.animation, doc.frames.length);
  let animation = doc.animation;
  if (animation) {
    animation = { ...animation, width: null, height: null };
    const list = animation.frames;
    if (kind === "pingPong") animation = { ...animation, frames: images.length > 1 ? pingPong(images.length).map((index) => ({ index, time: null })) : null };
    else if (list && list.some((e) => e.index >= images.length)) animation = { ...animation, frames: null };
  }
  const id = doc.nextLayerId;
  const out: EditorDoc = {
    ...doc,
    width: w,
    height: h,
    layers: [{ id, name: layerName, visible: true, locked: false, opacity: 100 }],
    frames: images.map((buf) => ({ cels: [buf], time: null })),
    animation,
    activeLayer: 0,
    frameIndex: 0,
    selection: null,
    nextLayerId: id + 1,
    reference: doc.vanilla ? (doc.vanilla.w === w && doc.vanilla.h === h ? doc.vanilla : scaleNearest(doc.vanilla, w, h)) : null,
    dirty: true,
  };
  return ensureAnimation(out);
}

// The editor's document: layers, frames, selection. Pure data and pure
// functions (no DOM, no React). A document is never changed in place: every
// function returns a new one, and pixel buffers are replaced, not written to.
import type { Animation, OpenedRaw, Origin, RawDoc } from "../lib/api";
import {
  base64ToBytes, bytesToBase64, cloneBuf, composite, cropFrame, getPx, newBuf, scaleNearest, stackFrames,
  type Buf, type LayerView, type Mask, type Rgba,
} from "./pixels";

/** The vanilla reference is always shown at this opacity. */
export const REFERENCE_OPACITY = 30;
/** Onion skin: the neighbouring frames are shown at this opacity. */
export const ONION_OPACITY = 25;
/**
 * "Texture path" of the pack icon (`pack.png` in the pack folder). Not a valid
 * texture name, so it cannot collide with one. The Rust side knows the same value.
 */
export const PACK_ICON = ":pack-icon";

export interface Layer {
  /** Stable for the life of the open document (undo uses it). */
  id: number;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0 to 100. */
  opacity: number;
}

export interface Frame {
  /** One image per layer, same order as `layers` (bottom first). */
  cels: Buf[];
  /** Own duration in ticks; `null` = the animation's frame time. */
  time: number | null;
}

export interface EditorDoc {
  /** Texture path without extension, e.g. `block/stone`. Saving always writes here. */
  path: string;
  origin: Origin;
  width: number;
  height: number;
  /** Bottom to top. */
  layers: Layer[];
  frames: Frame[];
  animation: Animation | null;
  /** Hex colours. */
  palette: string[];
  frameIndex: number;
  /** Index into `layers`. */
  activeLayer: number;
  selection: Mask | null;
  dirty: boolean;
  /** First frame of the game's texture at its own size ("Original" preview, palette). */
  vanilla: Buf | null;
  /** The same, enlarged to the document size: the locked reference layer. Never saved. */
  reference: Buf | null;
  referenceVisible: boolean;
  nextLayerId: number;
}

/** What undo needs to restore after a layer was added, removed or moved. */
export interface Structure {
  layers: Layer[];
  /** Per frame, per layer. */
  cels: Buf[][];
  activeLayer: number;
}

const clampOpacity = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function fromRaw(o: OpenedRaw): EditorDoc {
  const { width, height } = o.doc;
  const size = width * height * 4;
  let layers: Layer[] = o.doc.layers.map((l, i) => ({
    id: i + 1, name: l.name, visible: l.visible, locked: l.locked, opacity: clampOpacity(l.opacity),
  }));
  let frames: Frame[] = o.doc.frames.map((f) => ({
    time: f.time ?? null,
    cels: f.cels.map((c) => {
      const data = base64ToBytes(c);
      if (data.length !== size) throw new Error("The texture data does not match its size.");
      return { w: width, h: height, data };
    }),
  }));
  if (layers.length === 0) layers = [{ id: 1, name: "Base", visible: true, locked: false, opacity: 100 }];
  if (frames.length === 0) frames = [{ time: null, cels: [] }];
  // every frame must have one image per layer
  frames = frames.map((f) => ({
    time: f.time,
    cels: layers.map((_, i) => f.cels[i] ?? newBuf(width, height)),
  }));

  let vanilla: Buf | null = null;
  let reference: Buf | null = null;
  if (o.vanilla && o.vanilla.width > 0 && o.vanilla.height > 0) {
    const data = base64ToBytes(o.vanilla.rgba);
    if (data.length === o.vanilla.width * o.vanilla.height * 4) {
      const strip: Buf = { w: o.vanilla.width, h: o.vanilla.height, data };
      const count = Math.max(1, o.vanilla_frames);
      const frameH = Math.max(1, Math.floor(strip.h / count));
      vanilla = count > 1 ? cropFrame(strip, frameH, 0) : strip;
      reference = vanilla.w === width && vanilla.h === height ? vanilla : scaleNearest(vanilla, width, height);
    }
  }
  return {
    path: o.path,
    origin: o.origin,
    width,
    height,
    layers,
    frames,
    animation: o.doc.animation ?? null,
    palette: o.doc.palette ?? [],
    frameIndex: 0,
    activeLayer: layers.length - 1,
    selection: null,
    dirty: false,
    vanilla,
    reference,
    referenceVisible: false,
    nextLayerId: layers.length + 1,
  };
}

/** The document as the Rust side stores it. The reference layer is not part of it. */
export function toRaw(doc: EditorDoc): RawDoc {
  return {
    width: doc.width,
    height: doc.height,
    layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, locked: l.locked, opacity: clampOpacity(l.opacity) })),
    frames: doc.frames.map((f) => ({ cels: f.cels.map((c) => bytesToBase64(c.data)), time: f.time })),
    animation: doc.animation,
    palette: doc.palette,
  };
}

/**
 * One frame as it goes into the pack: visible layers only, never the
 * reference. With a single plain layer the pixels are returned untouched
 * (even colours hidden under full transparency).
 */
export function flatten(doc: EditorDoc, frameIndex = doc.frameIndex): Buf {
  const cels = doc.frames[frameIndex].cels;
  const shown = doc.layers.map((l, i) => ({ l, i })).filter(({ l }) => l.visible && l.opacity > 0);
  if (shown.length === 1 && shown[0].l.opacity >= 100) return cloneBuf(cels[shown[0].i]);
  return composite(doc.width, doc.height, shown.map(({ l, i }) => ({ buf: cels[i], visible: true, opacity: l.opacity })));
}

/** Every frame flattened and stacked vertically: the PNG the game reads. */
export function flatStrip(doc: EditorDoc): Buf {
  return stackFrames(doc.frames.map((_, i) => flatten(doc, i)));
}

/**
 * The frames an onion skin shows around a frame: the one before and the one
 * after (an animation loops, so the first and the last frame are neighbours).
 */
export function onionFrames(doc: EditorDoc, frameIndex = doc.frameIndex): number[] {
  const n = doc.frames.length;
  if (n < 2) return [];
  const prev = (frameIndex - 1 + n) % n;
  const next = (frameIndex + 1) % n;
  return prev === next ? [prev] : [prev, next];
}

/**
 * Layers for the canvas: the reference (when shown) and the onion skin
 * (flattened neighbour frames, display only) under the drawing.
 */
export function viewLayers(doc: EditorDoc, frameIndex = doc.frameIndex, onion: Buf[] = []): LayerView[] {
  const out: LayerView[] = [];
  if (doc.reference && doc.referenceVisible) out.push({ buf: doc.reference, visible: true, opacity: REFERENCE_OPACITY });
  for (const buf of onion) out.push({ buf, visible: true, opacity: ONION_OPACITY });
  const cels = doc.frames[frameIndex].cels;
  doc.layers.forEach((l, i) => out.push({ buf: cels[i], visible: l.visible, opacity: l.opacity }));
  return out;
}

export const activeCel = (doc: EditorDoc): Buf => doc.frames[doc.frameIndex].cels[doc.activeLayer];
export const isAnimated = (doc: EditorDoc) => doc.animation !== null || doc.frames.length > 1;

/** Ticks the frame is shown for. */
export function frameTicks(doc: EditorDoc, frameIndex = doc.frameIndex): number {
  return doc.frames[frameIndex].time ?? doc.animation?.frametime ?? 1;
}

/** Why the active layer cannot be drawn on, or `null` when it can. */
export function editBlock(doc: EditorDoc): string | null {
  const l = doc.layers[doc.activeLayer];
  if (!l) return "There is no layer to draw on. Add one in the Layers panel.";
  if (l.locked) return `The layer “${l.name}” is locked. Unlock it in the Layers panel to change it.`;
  if (!l.visible) return `The layer “${l.name}” is hidden. Show it in the Layers panel to change it.`;
  return null;
}

/** Replaces one image. */
export function setCel(doc: EditorDoc, frameIndex: number, layerIndex: number, buf: Buf): EditorDoc {
  const frames = doc.frames.map((f, fi) =>
    fi !== frameIndex ? f : { ...f, cels: f.cels.map((c, li) => (li === layerIndex ? buf : c)) },
  );
  return { ...doc, frames };
}

export function uniqueLayerName(doc: EditorDoc, base: string): string {
  const names = new Set(doc.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!names.has(name)) return name;
  }
}

/** A new empty layer just above the active one; it becomes the active layer. */
export function addLayer(doc: EditorDoc, name?: string): EditorDoc {
  const at = Math.min(doc.layers.length, doc.activeLayer + 1);
  const layer: Layer = {
    id: doc.nextLayerId, name: name ?? uniqueLayerName(doc, `Layer ${doc.layers.length + 1}`),
    visible: true, locked: false, opacity: 100,
  };
  const layers = [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)];
  const frames = doc.frames.map((f) => ({
    ...f, cels: [...f.cels.slice(0, at), newBuf(doc.width, doc.height), ...f.cels.slice(at)],
  }));
  return { ...doc, layers, frames, activeLayer: at, nextLayerId: doc.nextLayerId + 1, dirty: true };
}

/** A copy of the layer (all frames) just above it; the copy becomes active. */
export function duplicateLayer(doc: EditorDoc, index: number): EditorDoc {
  const src = doc.layers[index];
  if (!src) return doc;
  const layer: Layer = { ...src, id: doc.nextLayerId, name: uniqueLayerName(doc, `${src.name} copy`), locked: false };
  const at = index + 1;
  const layers = [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)];
  const frames = doc.frames.map((f) => ({
    ...f, cels: [...f.cels.slice(0, at), cloneBuf(f.cels[index]), ...f.cels.slice(at)],
  }));
  return { ...doc, layers, frames, activeLayer: at, nextLayerId: doc.nextLayerId + 1, dirty: true };
}

/** Removes a layer. The last remaining layer cannot be removed. */
export function deleteLayer(doc: EditorDoc, index: number): EditorDoc {
  if (doc.layers.length <= 1 || !doc.layers[index]) return doc;
  const layers = doc.layers.filter((_, i) => i !== index);
  const frames = doc.frames.map((f) => ({ ...f, cels: f.cels.filter((_, i) => i !== index) }));
  const activeLayer = Math.max(0, Math.min(layers.length - 1, doc.activeLayer > index ? doc.activeLayer - 1 : doc.activeLayer === index ? index - 1 : doc.activeLayer));
  return { ...doc, layers, frames, activeLayer, dirty: true };
}

/** Moves a layer up (`delta` 1) or down (-1) in the stack. */
export function moveLayer(doc: EditorDoc, index: number, delta: number): EditorDoc {
  const to = index + delta;
  if (!doc.layers[index] || to < 0 || to >= doc.layers.length || delta === 0) return doc;
  const swap = <T,>(list: T[]) => {
    const out = list.slice();
    const [item] = out.splice(index, 1);
    out.splice(to, 0, item);
    return out;
  };
  const activeLayer =
    doc.activeLayer === index ? to
    : doc.activeLayer === to ? index
    : doc.activeLayer;
  return { ...doc, layers: swap(doc.layers), frames: doc.frames.map((f) => ({ ...f, cels: swap(f.cels) })), activeLayer, dirty: true };
}

export type LayerPatch = Partial<Pick<Layer, "name" | "visible" | "locked" | "opacity">>;

/** Name, visibility, lock or opacity of one layer. Lock alone does not change the texture. */
export function patchLayer(doc: EditorDoc, index: number, patch: LayerPatch): EditorDoc {
  const old = doc.layers[index];
  if (!old) return doc;
  const next: Layer = { ...old, ...patch };
  if (patch.opacity !== undefined) next.opacity = clampOpacity(patch.opacity);
  if (patch.name !== undefined) next.name = patch.name.trim() || old.name;
  if (next.name === old.name && next.visible === old.visible && next.locked === old.locked && next.opacity === old.opacity) return doc;
  return { ...doc, layers: doc.layers.map((l, i) => (i === index ? next : l)), dirty: true };
}

/** True when the layer has at least one visible pixel in any frame. */
export function layerHasPixels(doc: EditorDoc, index: number): boolean {
  return doc.frames.some((f) => {
    const d = f.cels[index]?.data;
    if (!d) return false;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false;
  });
}

export function structureOf(doc: EditorDoc): Structure {
  return { layers: doc.layers, cels: doc.frames.map((f) => f.cels), activeLayer: doc.activeLayer };
}

/**
 * The document with a stored layer list put back. A lock is editor state and
 * not an undo step, so layers that still exist keep the lock they have now.
 */
export function withStructure(doc: EditorDoc, s: Structure): EditorDoc {
  const now = new Map(doc.layers.map((l) => [l.id, l]));
  let relocked = false;
  const merged = s.layers.map((l) => {
    const cur = now.get(l.id);
    if (!cur || cur.locked === l.locked) return l;
    relocked = true;
    return { ...l, locked: cur.locked };
  });
  const layers = relocked ? merged : s.layers;
  return {
    ...doc,
    layers,
    frames: doc.frames.map((f, i) => ({ ...f, cels: s.cels[i] ?? f.cels })),
    activeLayer: Math.max(0, Math.min(s.layers.length - 1, s.activeLayer)),
  };
}

/** Colour under a pixel: the drawing first, then the reference when it is shown. */
export function pickColor(doc: EditorDoc, x: number, y: number): Rgba | null {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  const c = getPx(flatten(doc), x, y);
  if (c[3] > 0) return c;
  if (doc.reference && doc.referenceVisible) {
    const r = getPx(doc.reference, x, y);
    if (r[3] > 0) return r;
  }
  return [0, 0, 0, 0];
}

/** "stone.png" for `block/stone`. */
export function fileLabel(path: string): string {
  return path === PACK_ICON ? "pack.png" : `${path.slice(path.lastIndexOf("/") + 1)}.png`;
}

/** Where saving writes, relative to the pack's `assets/minecraft` folder (the icon: to the pack folder). */
export function targetLabel(doc: EditorDoc): string {
  if (doc.path === PACK_ICON) return "pack.png";
  const name = doc.path.slice(doc.path.lastIndexOf("/") + 1);
  return `textures/${doc.path}.png${isAnimated(doc) ? ` + ${name}.png.mcmeta` : ""}`;
}

export function sameMask(a: Mask | null, b: Mask | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

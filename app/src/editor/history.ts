// Undo / redo: a stack of commands. Pixel edits are stored as the smallest
// rectangle that changed (before and after), per frame and layer. Layer
// add / delete / duplicate / reorder store the layer list before and after
// (the pixel buffers are shared, not copied).
import { sameMask, setCel, structureOf, withStructure, type EditorDoc, type Structure } from "./doc";
import type { Buf, Mask } from "./pixels";

export const HISTORY_CAP = 200;

export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGBA of the rectangle, `w * h * 4` bytes each. */
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

export interface CelPatch {
  frame: number;
  layerId: number;
  patch: Patch;
}

export interface Command {
  label: string;
  cels: CelPatch[];
  selection?: { before: Mask | null; after: Mask | null };
  structure?: { before: Structure; after: Structure };
}

export interface History {
  /** Oldest first; the last one is undone next. */
  undo: Command[];
  /** The last one is redone next. */
  redo: Command[];
}

export const emptyHistory = (): History => ({ undo: [], redo: [] });

function cut(buf: Buf, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * buf.w + x) * 4;
    out.set(buf.data.subarray(start, start + w * 4), row * w * 4);
  }
  return out;
}

/** The smallest rectangle holding every pixel that differs, or `null` when nothing changed. */
export function diffPatch(before: Buf, after: Buf): Patch | null {
  if (before.w !== after.w || before.h !== after.h) throw new Error("diffPatch: sizes differ");
  const a = before.data;
  const b = after.data;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < before.h; y++) {
    for (let x = 0; x < before.w; x++) {
      const i = (y * before.w + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  return { x: x0, y: y0, w, h, before: cut(before, x0, y0, w, h), after: cut(after, x0, y0, w, h) };
}

/** A copy of `buf` with one side of the patch written into it. */
export function applyPatch(buf: Buf, p: Patch, side: "before" | "after"): Buf {
  const out: Buf = { w: buf.w, h: buf.h, data: new Uint8ClampedArray(buf.data) };
  const src = p[side];
  for (let row = 0; row < p.h; row++) {
    out.data.set(src.subarray(row * p.w * 4, (row + 1) * p.w * 4), ((p.y + row) * buf.w + p.x) * 4);
  }
  return out;
}

/** Adds a command; anything that was undone can no longer be redone. */
export function push(h: History, cmd: Command, cap = HISTORY_CAP): History {
  const undo = [...h.undo, cmd];
  return { undo: undo.length > cap ? undo.slice(undo.length - cap) : undo, redo: [] };
}

export function stepUndo(h: History): { history: History; command: Command } | null {
  const command = h.undo[h.undo.length - 1];
  if (!command) return null;
  return { history: { undo: h.undo.slice(0, -1), redo: [...h.redo, command] }, command };
}

export function stepRedo(h: History): { history: History; command: Command } | null {
  const command = h.redo[h.redo.length - 1];
  if (!command) return null;
  return { history: { undo: [...h.undo, command], redo: h.redo.slice(0, -1) }, command };
}

/** The document with a command undone or redone. */
export function applyCommand(doc: EditorDoc, cmd: Command, dir: "undo" | "redo"): EditorDoc {
  const side = dir === "undo" ? "before" : "after";
  let out = doc;
  // layers first when redoing an added layer, pixels first when undoing: either
  // way the patches must meet the layers they were made on
  const structure = () => {
    if (cmd.structure) out = withStructure(out, cmd.structure[side]);
  };
  const pixels = () => {
    for (const c of cmd.cels) {
      const li = out.layers.findIndex((l) => l.id === c.layerId);
      const cel = out.frames[c.frame]?.cels[li];
      if (li < 0 || !cel) continue;
      out = setCel(out, c.frame, li, applyPatch(cel, c.patch, side));
    }
  };
  if (dir === "undo") {
    pixels();
    structure();
  } else {
    structure();
    pixels();
  }
  if (cmd.selection) out = { ...out, selection: cmd.selection[side] };
  return out;
}

/**
 * Command for a change of one image and / or the selection.
 * Returns `null` when nothing changed.
 */
export function editCommand(
  label: string,
  doc: EditorDoc,
  next: { cel?: Buf; selection?: Mask | null },
): Command | null {
  const cels: CelPatch[] = [];
  if (next.cel) {
    const before = doc.frames[doc.frameIndex].cels[doc.activeLayer];
    const patch = before === next.cel ? null : diffPatch(before, next.cel);
    if (patch) cels.push({ frame: doc.frameIndex, layerId: doc.layers[doc.activeLayer].id, patch });
  }
  const selChanged = next.selection !== undefined && !sameMask(doc.selection, next.selection);
  if (cels.length === 0 && !selChanged) return null;
  const cmd: Command = { label, cels };
  if (selChanged) cmd.selection = { before: doc.selection, after: next.selection ?? null };
  return cmd;
}

/** Command for a change of the layer list (add, delete, duplicate, reorder). */
export function structureCommand(label: string, before: EditorDoc, after: EditorDoc): Command {
  return { label, cels: [], structure: { before: structureOf(before), after: structureOf(after) } };
}

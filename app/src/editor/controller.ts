// Turns pointer input (already converted to texture pixels by the canvas)
// into tool sessions: start, preview while dragging, finish as one undo step.
// No DOM here, so the whole interaction can be tested.
import { activeCel, pickColor } from "./doc";
import { activeTab, setPendingFlush, useEditor, type Tab } from "./editorStore";
import type { Buf, Pt, SelectMode } from "./pixels";
import { editMask } from "./region";
import {
  applyStroke, constrainEnd, DRAG_SHAPES, floatSelection, FREEHAND, growsInPlace, growStroke, lift, place, select, selectMode,
  SELECT_TOOLS, toolDef, type Bitmap, type Floating, type Stroke, type StrokeRun, type ToolId,
} from "./tools";

export interface PointerInfo {
  /** Texture pixel under the pointer; may lie outside the image. */
  p: Pt;
  /** 0 = left, 2 = right. Other buttons are handled by the canvas (panning). */
  button: number;
  shift: boolean;
  alt: boolean;
}

type Session =
  | { kind: "stroke"; tool: ToolId; snapshot: Buf; points: Pt[]; button: 0 | 2; seed: number; run: StrokeRun | null }
  | { kind: "shape"; tool: ToolId; snapshot: Buf; a: Pt; b: Pt; button: 0 | 2 }
  | { kind: "curve"; snapshot: Buf; a: Pt; b: Pt; c: Pt | null; phase: 1 | 2; button: 0 | 2 }
  | { kind: "poly"; snapshot: Buf; points: Pt[]; cursor: Pt; button: 0 | 2; down: boolean; dragged: boolean }
  | { kind: "select"; tool: ToolId; points: Pt[]; mode: SelectMode; moved: boolean }
  | { kind: "move"; floating: Floating; start: Pt; dx: number; dy: number }
  | { kind: "text"; snapshot: Buf; at: Pt; button: 0 | 2; bitmap: Bitmap | null }
  | { kind: "pick"; button: 0 | 2 };

let session: Session | null = null;
let seeds = 1;

const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const store = () => useEditor.getState();

// While the pointer moves, the preview is not drawn for every single event:
// the canvas asks for it once per screen refresh. Tests (and anything without
// a screen) draw it at once.
type Scheduler = (run: () => void) => void;
const atOnce: Scheduler = (run) => run();
let schedule: Scheduler = atOnce;
/** `null` = draw previews at once. */
export const setPreviewScheduler = (fn: Scheduler | null) => {
  schedule = fn ?? atOnce;
};

/** A tool is in the middle of its work. */
export const isBusy = () => session !== null;
export const sessionKind = () => session?.kind ?? null;

function strokeOf(tab: Tab, s: { tool: ToolId; snapshot: Buf; points: Pt[]; button: 0 | 2; seed?: number; bitmap?: Bitmap }): Stroke {
  const st = store();
  return {
    tool: s.tool, snapshot: s.snapshot, points: s.points, button: s.button, fg: st.fg, bg: st.bg,
    options: st.options, mask: editMask(tab.doc.selection, tab.region), seed: s.seed ?? 1, bitmap: s.bitmap,
  };
}

/** The image the session would produce right now, or `null` when it draws nothing. */
function render(tab: Tab, s: Session): Buf | null {
  switch (s.kind) {
    case "stroke": {
      const stroke = strokeOf(tab, s);
      if (!growsInPlace(s.tool, stroke.options)) return applyStroke(stroke);
      // only the new piece of the stroke is painted, not the whole stroke again
      s.run = growStroke(stroke, s.run);
      // a new object each time (same pixels underneath), so whatever shows it sees a change
      return { w: s.run.buf.w, h: s.run.buf.h, data: s.run.buf.data };
    }
    case "shape":
      return applyStroke(strokeOf(tab, { tool: s.tool, snapshot: s.snapshot, points: [s.a, s.b], button: s.button }));
    case "curve":
      return applyStroke(strokeOf(tab, { tool: "curve", snapshot: s.snapshot, points: s.c ? [s.a, s.b, s.c] : [s.a, s.b], button: s.button }));
    case "poly": {
      const pts = s.down || same(s.cursor, s.points[s.points.length - 1]) ? s.points : [...s.points, s.cursor];
      return applyStroke(strokeOf(tab, { tool: "polygon", snapshot: s.snapshot, points: pts, button: s.button }));
    }
    case "text":
      return s.bitmap ? applyStroke(strokeOf(tab, { tool: "text", snapshot: s.snapshot, points: [s.at], button: s.button, bitmap: s.bitmap })) : null;
    case "move":
      return place(s.floating, s.dx, s.dy, store().options.tiled);
    default:
      return null;
  }
}

function preview(tab: Tab) {
  const s = session;
  if (!s) return;
  if (s.kind === "select") {
    const st = store();
    store().setPreview({ selection: select(tab.doc.selection, s.tool, s.points, activeCel(tab.doc), st.options, s.mode) });
    return;
  }
  const cel = render(tab, s);
  if (!cel) {
    store().setPreview(null);
    return;
  }
  if (s.kind === "move") {
    const o = store().options;
    store().setPreview({ cel, selection: floatSelection(s.floating, cel.w, cel.h, s.dx, s.dy, o.tiled) });
  } else {
    store().setPreview({ cel });
  }
}

/** Asks for the preview of the session as it is by then (see `setPreviewScheduler`). */
function requestPreview() {
  schedule(() => {
    const tab = activeTab(store());
    if (session && tab) preview(tab);
  });
}

function pick(tab: Tab, p: Pt, button: 0 | 2) {
  let [x, y] = p;
  if (store().options.tiled) {
    // the copies around the image are the image: picking works on them too
    x = ((x % tab.doc.width) + tab.doc.width) % tab.doc.width;
    y = ((y % tab.doc.height) + tab.doc.height) % tab.doc.height;
  }
  const c = pickColor(tab.doc, x, y);
  if (c) store().setColor(button === 2 ? "bg" : "fg", c);
}

/** Finishes the session as one undo step. */
function finish() {
  const s = session;
  const tab = activeTab(store());
  session = null;
  if (!s || !tab) {
    store().setPreview(null);
    return;
  }
  const cel = render(tab, s);
  switch (s.kind) {
    case "stroke":
    case "shape":
    case "curve":
      store().applyEdit(toolDef(s.kind === "curve" ? "curve" : s.tool).name, cel ? { cel } : {});
      break;
    case "poly":
      store().applyEdit(toolDef("polygon").name, cel ? { cel } : {});
      break;
    case "text":
      store().setText(null);
      store().applyEdit(toolDef("text").name, cel ? { cel } : {});
      break;
    case "move": {
      if (!cel || (s.dx === 0 && s.dy === 0)) {
        store().setPreview(null);
        break;
      }
      const o = store().options;
      // the selection comes from the lifted pixels, not from the selection on
      // screen: a part that hung over the edge comes back together with its pixels
      store().applyEdit(toolDef("move").name, {
        cel,
        selection: floatSelection(s.floating, cel.w, cel.h, s.dx, s.dy, o.tiled),
        float: { ...s.floating, x: s.floating.x + s.dx, y: s.floating.y + s.dy },
      });
      break;
    }
    case "select": {
      const st = store();
      // a click without dragging clears the selection, as in other editors
      const next = !s.moved && s.mode === "replace" ? null : select(tab.doc.selection, s.tool, s.points, activeCel(tab.doc), st.options, s.mode);
      st.applyEdit(next ? toolDef(s.tool).name : "Deselect", { selection: next });
      break;
    }
    case "pick":
      store().setPreview(null);
      break;
  }
}

/** Enter, a double click, or anything that must not run under a half-finished tool. */
export function commitPending() {
  if (session) finish();
}

/** Escape: drops what the tool was doing. Returns `false` when there was nothing to drop. */
export function cancelPending(): boolean {
  if (!session) return false;
  session = null;
  store().setText(null);
  store().setPreview(null);
  return true;
}

setPendingFlush(commitPending);

export function pointerDown(i: PointerInfo) {
  if (i.button !== 0 && i.button !== 2) return;
  const button = i.button as 0 | 2;

  // tools that wait for more clicks
  if (session?.kind === "curve" && session.phase === 2) {
    session.c = i.p;
    finish();
    return;
  }
  if (session?.kind === "poly") {
    const s = session;
    if (s.points.length >= 3 && same(i.p, s.points[0])) {
      finish();
      return;
    }
    if (!same(i.p, s.points[s.points.length - 1])) s.points.push(i.p);
    s.cursor = i.p;
    s.down = true;
    s.dragged = false;
    const t = activeTab(store());
    if (t) preview(t);
    return;
  }
  if (session) {
    // text being typed, or a stray second button: finish what is there first
    finish();
    return;
  }

  const st = store();
  const tab = activeTab(st);
  if (!tab) return;
  const tool = st.tool;
  const doc = tab.doc;

  if (tool === "hand" || tool === "zoom") return;

  // Alt+click picks a colour with any tool; on selection tools Alt means "take away"
  if (tool === "picker" || (i.alt && !SELECT_TOOLS.includes(tool))) {
    session = { kind: "pick", button };
    pick(tab, i.p, button);
    return;
  }

  if (tool === "wand") {
    const next = select(doc.selection, "wand", [i.p], activeCel(doc), st.options, selectMode(i.shift, i.alt));
    st.applyEdit(toolDef("wand").name, { selection: next });
    return;
  }
  if (tool === "marquee" || tool === "lasso") {
    session = { kind: "select", tool, points: [i.p], mode: selectMode(i.shift, i.alt), moved: false };
    return;
  }

  // everything below changes pixels
  if (st.blocked()) return;
  const snapshot = activeCel(doc);

  if (tool === "move") {
    const f = tab.float;
    const valid = f && f.result === snapshot && f.selection === doc.selection;
    // in "edit only these cells" only the region's pixels are lifted
    session = { kind: "move", floating: valid ? f.floating : lift(snapshot, editMask(doc.selection, tab.region)), start: i.p, dx: 0, dy: 0 };
    return;
  }
  if (tool === "bucket") {
    st.applyEdit(toolDef("bucket").name, { cel: applyStroke(strokeOf(tab, { tool, snapshot, points: [i.p], button })) });
    return;
  }
  if (tool === "text") {
    session = { kind: "text", snapshot, at: i.p, button, bitmap: null };
    st.setText({ at: i.p, value: "" });
    return;
  }
  if (FREEHAND.includes(tool)) {
    session = { kind: "stroke", tool, snapshot, points: [i.p], button, seed: (seeds++ * 2654435761) >>> 0, run: null };
  } else if (DRAG_SHAPES.includes(tool)) {
    session = { kind: "shape", tool, snapshot, a: i.p, b: i.p, button };
  } else if (tool === "curve") {
    session = { kind: "curve", snapshot, a: i.p, b: i.p, c: null, phase: 1, button };
  } else if (tool === "polygon") {
    session = { kind: "poly", snapshot, points: [i.p], cursor: i.p, button, down: true, dragged: false };
  }
  // the gradient only shows once it has a direction
  if (session && tool !== "gradient") preview(tab);
}

export function pointerMove(i: PointerInfo) {
  const s = session;
  const tab = activeTab(store());
  if (!s || !tab) return;
  switch (s.kind) {
    case "stroke":
      if (same(i.p, s.points[s.points.length - 1])) return;
      s.points.push(i.p);
      break;
    case "shape":
      s.b = i.shift ? constrainEnd(s.tool, s.a, i.p) : i.p;
      break;
    case "curve":
      if (s.phase === 1) s.b = i.shift ? constrainEnd("curve", s.a, i.p) : i.p;
      else s.c = i.p;
      break;
    case "poly":
      if (s.down) {
        // dragging draws a freehand outline
        if (same(i.p, s.points[s.points.length - 1])) return;
        s.points.push(i.p);
        s.dragged = true;
      }
      s.cursor = i.p;
      break;
    case "select":
      if (s.tool === "marquee") {
        if (same(i.p, s.points[1] ?? s.points[0])) return;
        s.points = [s.points[0], i.p];
      } else {
        if (same(i.p, s.points[s.points.length - 1])) return;
        s.points.push(i.p);
      }
      // "moved" = the pointer left the pixel it started on at least once
      s.moved = true;
      break;
    case "move": {
      const dx = i.p[0] - s.start[0];
      const dy = i.p[1] - s.start[1];
      if (dx === s.dx && dy === s.dy) return;
      s.dx = dx;
      s.dy = dy;
      break;
    }
    case "pick":
      pick(tab, i.p, s.button);
      return;
    case "text":
      return;
  }
  requestPreview();
}

export function pointerUp(_i?: PointerInfo) {
  const s = session;
  if (!s) return;
  switch (s.kind) {
    case "curve":
      if (s.phase === 2) return;
      if (same(s.a, s.b)) {
        cancelPending();
        return;
      }
      // the line is placed: the next pointer position bends it, a click fixes it
      s.phase = 2;
      return;
    case "poly":
      s.down = false;
      // a dragged outline is a finished contour; single clicks keep adding corners
      if (s.dragged && s.points.length > 2) finish();
      return;
    case "shape":
      if (s.tool === "gradient" && same(s.a, s.b)) {
        cancelPending();
        return;
      }
      finish();
      return;
    case "text":
      return;
    default:
      finish();
  }
}

/** Spray keeps adding paint while the button is held still. */
export function sprayTick() {
  const s = session;
  const tab = activeTab(store());
  if (!s || !tab || s.kind !== "stroke" || s.tool !== "spray") return;
  s.points.push(s.points[s.points.length - 1]);
  requestPreview();
}

/** Text typed so far, with its rendered pixels (`null` = nothing to draw). */
export function updateText(value: string, bitmap: Bitmap | null) {
  const s = session;
  const tab = activeTab(store());
  if (!s || s.kind !== "text" || !tab) return;
  s.bitmap = bitmap;
  store().setText({ at: s.at, value });
  preview(tab);
}

/** Test hook. */
export function resetController() {
  session = null;
}

// State of the pixel editor: open textures (tabs), the current tool and its
// options, colours and the clipboard. The pixel work itself is in the pure
// modules (doc, tools, history, pixels); this file only wires them to the app.
import { create } from "zustand";
import { api } from "../lib/api";
import { registerPackGuard, useApp } from "../store";
import {
  deleteFrame, duplicateFrame, importReplacing, importSameSize, MAX_TICKS, moveFrame, newFrame, setImageTime, withOrder, type Entry,
} from "./anim";
import {
  activeCel, addLayer, deleteLayer, duplicateLayer, editBlock, fileLabel, flatStrip, flatten, fromRaw, layerHasPixels, moveLayer,
  patchLayer, setCel, toRaw, type EditorDoc, type LayerPatch,
} from "./doc";
import {
  applyCommand, editCommand, emptyHistory, framesCommand, push, pushMerged, stepRedo, stepUndo, structureCommand, type History,
} from "./history";
import {
  bytesToBase64, clearArea, cloneBuf, copyClip, extractPalette, rgbaToHex,
  type Buf, type Clip, type Mask, type Pt, type Rgba,
} from "./pixels";
import { clampSize, defaultOptions, pasteFloating, selectAllMask, toolDef, type Floating, type ToolId, type ToolOptions } from "./tools";
import { centerView, fitView, stepZoom, zoomAbout, type View } from "./view";
import { cellsLabel, uniqueCells } from "../particles/cells";
import { cellsRegion, clipToMask, rectRegion, type RectRequest, type Region } from "./region";

/** Lifted pixels that the Move tool can keep moving without damaging what is under them. */
export interface Float {
  floating: Floating;
  /** Only valid while the layer image and the selection are still these exact objects. */
  result: Buf;
  selection: Mask | null;
}

/** What is shown while a tool is in use, before it becomes an undo step. */
export interface Preview {
  cel?: Buf;
  selection?: Mask | null;
}

export interface Tab {
  id: number;
  /** Folder of the pack this texture belongs to. Saving anywhere else is refused. */
  packDir: string;
  doc: EditorDoc;
  history: History;
  preview: Preview | null;
  float: Float | null;
  /** `null` = fit to the window. */
  view: View | null;
  /** Size and time of the file in the pack when it was opened or last saved. */
  disk: string;
  saving: boolean;
  /** Goes up with every change of the pixels (a save only clears "unsaved" when nothing changed meanwhile). */
  edits: number;
  paletteSource: "vanilla" | "image" | "saved";
  /** "Edit only these cells": pixels outside this region never change. `null` = the whole image. */
  region: Region | null;
}

/** What "Edit only these cells" needs to know about the particle. */
export interface CellsRequest {
  particle: string;
  cells: number[];
  shared: string[];
  grid: number;
}

export type PreviewTab = "3d" | "tiled" | "original" | "animated";

export interface TextEdit {
  at: Pt;
  value: string;
}

interface EditorState {
  tabs: Tab[];
  activeId: number | null;
  tool: ToolId;
  options: ToolOptions;
  fg: Rgba;
  bg: Rgba;
  /** Which colour the colour picker edits. */
  colorTarget: "fg" | "bg";
  clipboard: Clip | null;
  /** Texture pixel under the pointer. */
  cursor: Pt | null;
  viewport: { w: number; h: number };
  /** `null` until one is picked: 3D for block textures, else Tiled. */
  previewTab: PreviewTab | null;
  /** Text being typed with the Text tool. */
  text: TextEdit | null;

  openTexture: (path: string) => Promise<void>;
  /** Opens the shared particle sheet with only these cells editable. */
  openCells: (path: string, req: CellsRequest) => Promise<void>;
  /** Opens a shared interface image (before 1.20.2) with only one piece's rectangle editable. */
  openRect: (path: string, req: RectRequest) => Promise<void>;
  /** Back to editing the whole image. */
  leaveRegion: (id?: number) => void;
  activate: (id: number) => void;
  closeTab: (id: number) => Promise<boolean>;
  save: (id?: number) => Promise<boolean>;
  confirmLeave: () => Promise<boolean>;
  dropTabsOutside: (packDir: string | null) => void;
  syncWithDisk: () => Promise<void>;

  setTool: (tool: ToolId) => void;
  setOptions: (patch: Partial<ToolOptions>) => void;
  setColor: (target: "fg" | "bg", color: Rgba) => void;
  setColorTarget: (target: "fg" | "bg") => void;
  swapColors: () => void;
  setCursor: (p: Pt | null) => void;
  setViewport: (w: number, h: number) => void;
  setView: (view: View | null) => void;
  zoomStep: (dir: 1 | -1) => void;
  setPreviewTab: (t: PreviewTab) => void;
  setText: (t: TextEdit | null) => void;

  setPreview: (p: Preview | null) => void;
  applyEdit: (label: string, next: { cel?: Buf; selection?: Mask | null; float?: Floating }) => void;
  undo: () => void;
  redo: () => void;

  setActiveLayer: (index: number) => void;
  addLayer: () => void;
  duplicateLayer: (index: number) => void;
  deleteLayer: (index: number) => void;
  moveLayer: (index: number, delta: number) => void;
  patchLayer: (index: number, patch: LayerPatch) => void;
  toggleReference: () => void;
  stepFrame: (delta: number) => void;
  selectFrame: (index: number) => void;

  // frames and animation settings: each one undo step
  newFrame: () => void;
  duplicateFrame: () => void;
  deleteFrame: () => void;
  moveFrame: (delta: -1 | 1) => void;
  /** Own duration of one frame in ticks; `null` = the animation's frame time. */
  setFrameTime: (index: number, ticks: number | null) => void;
  setFrametime: (ticks: number) => void;
  setInterpolate: (on: boolean) => void;
  /** `null` = every frame in order. */
  setOrder: (entries: Entry[] | null, label?: string) => void;
  /** Frames cut from an imported strip (see `splitStrip`). Asks first when their size is not the texture's. */
  importFrames: (frames: Buf[], source: string) => void;

  selectAll: () => void;
  deselect: () => void;
  deleteSelection: () => void;
  copy: () => boolean;
  cut: () => void;
  paste: () => void;
  loadPalette: (source: "vanilla" | "image") => void;
  /** Tells the user why nothing happens when the layer cannot be edited. `true` = blocked. */
  blocked: () => boolean;
}

let nextTabId = 1;
const opening = new Set<string>();

// A tool in the middle of its work (a polygon being placed, text being typed).
// It is finished before anything that would otherwise run under it: undo, save,
// switching tabs or tools.
let flush: () => void = () => {};
export const setPendingFlush = (fn: () => void) => {
  flush = fn;
};
export const flushPending = () => flush();

export const activeTab = (s: { tabs: Tab[]; activeId: number | null }): Tab | null =>
  s.tabs.find((t) => t.id === s.activeId) ?? null;

/** A document with a tool's preview on top. */
export function withPreview(doc: EditorDoc, p: Preview | null): EditorDoc {
  if (!p) return doc;
  if (p.cel) doc = setCel(doc, doc.frameIndex, doc.activeLayer, p.cel);
  if (p.selection !== undefined) doc = { ...doc, selection: p.selection };
  return doc;
}

/** The document as it should be drawn: with the tool's preview on top. */
export const shownDoc = (tab: Tab): EditorDoc => withPreview(tab.doc, tab.preview);

/** The current view, or the fitted one when the user has not zoomed or panned yet. */
export function viewOf(tab: Tab, viewport: { w: number; h: number }): View {
  return tab.view ?? fitView(tab.doc.width, tab.doc.height, viewport.w, viewport.h);
}

function diskStamp(path: string): string {
  const mine = useApp.getState().rows.find((r) => r.path === path)?.mine;
  return mine ? `${mine.modified_ms}:${mine.file_size}` : "";
}

export const fileName = (path: string) => fileLabel(path);

function paletteFrom(doc: EditorDoc, source: "vanilla" | "image"): string[] {
  const buf = source === "vanilla" && doc.vanilla ? doc.vanilla : flatten(doc);
  return extractPalette(buf, 48).map(rgbaToHex);
}

function newTab(doc: EditorDoc, packDir: string): Tab {
  let paletteSource: Tab["paletteSource"] = "saved";
  if (doc.palette.length === 0) {
    paletteSource = doc.vanilla ? "vanilla" : "image";
    doc = { ...doc, palette: paletteFrom(doc, paletteSource) };
  }
  return {
    id: nextTabId++, packDir, doc, history: emptyHistory(), preview: null, float: null, view: null,
    disk: diskStamp(doc.path), saving: false, edits: 0, paletteSource, region: null,
  };
}

/** True when two documents have the same animation settings and frame durations. */
function sameAnimation(a: EditorDoc, b: EditorDoc): boolean {
  return JSON.stringify(a.animation) === JSON.stringify(b.animation) && a.frames.length === b.frames.length
    && a.frames.every((f, i) => f.time === b.frames[i].time);
}

let lastWarn = { text: "", at: 0 };
/** A warning toast, not repeated while the user keeps clicking. */
function warn(text: string) {
  const now = Date.now();
  if (lastWarn.text === text && now - lastWarn.at < 2500) return;
  lastWarn = { text, at: now };
  useApp.getState().toast(text, "warn");
}

/** Opacity changes on one layer this close together are one undo step (a slider being dragged). */
const SLIDE_MS = 1000;
let lastSlide = { key: "", at: 0 };

type Answer = "save" | "discard" | "cancel";

/** Save / Discard / Cancel. Closing the question with Escape counts as Cancel. */
function askUnsaved(tabs: Tab[]): Promise<Answer> {
  return new Promise((resolve) => {
    const app = useApp.getState();
    let answered = false;
    const answer = (a: Answer) => {
      if (answered) return;
      answered = true;
      resolve(a);
    };
    const one = tabs.length === 1 ? tabs[0] : null;
    const modal = {
      title: one ? `Save changes to ${fileName(one.doc.path)}?` : `Save changes to ${tabs.length} textures?`,
      text: one
        ? "This texture has changes that are not in the pack yet."
        : `These textures have changes that are not in the pack yet:\n${tabs.map((t) => fileName(t.doc.path)).join("\n")}`,
      hint: "Save writes them into the pack. Discard throws the changes away for good.",
      buttons: [
        { label: "Cancel", run: () => answer("cancel") },
        { label: "Discard", danger: true, run: () => answer("discard") },
        { label: one ? "Save" : "Save all", primary: true, run: () => answer("save") },
      ],
    };
    app.ask(modal);
    const off = useApp.subscribe((s) => {
      if (s.modal === modal) return;
      off();
      // a button's own answer comes right after the modal closes: let it win
      setTimeout(() => answer("cancel"), 0);
    });
  });
}

export const useEditor = create<EditorState>((set, get) => {
  const update = (id: number, fn: (t: Tab) => Tab) => set({ tabs: get().tabs.map((t) => (t.id === id ? fn(t) : t)) });
  const current = () => activeTab(get());

  /** A change of the layer list, as one undo step. */
  const structural = (label: string, fn: (d: EditorDoc) => EditorDoc) => {
    flushPending();
    const tab = current();
    if (!tab) return;
    const doc = fn(tab.doc);
    if (doc === tab.doc) return;
    update(tab.id, (t) => ({
      ...t, doc, history: push(t.history, structureCommand(label, tab.doc, doc)), preview: null, float: null, edits: t.edits + 1,
    }));
  };

  /** A change of the frames or the animation, as one undo step. `true` = something changed. */
  const framesEdit = (label: string, fn: (d: EditorDoc) => EditorDoc, tabId?: number): boolean => {
    flushPending();
    const tab = tabId === undefined ? current() : get().tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    if (tab.region) {
      warn(tab.region.kind === "rect"
        ? `Frames cannot change while only ${tab.region.particle} is being edited: the image is one picture. Choose “Edit the whole image” first.`
        : `Frames cannot change while only the cells of ${tab.region.particle} are being edited: the sheet is one image. Choose “Edit the whole sheet” first.`);
      return false;
    }
    const doc = fn(tab.doc);
    if (doc === tab.doc) return false;
    const resized = doc.width !== tab.doc.width || doc.height !== tab.doc.height;
    update(tab.id, (t) => ({
      ...t, doc: { ...doc, dirty: true }, history: push(t.history, framesCommand(label, tab.doc, doc)),
      preview: null, float: null, edits: t.edits + 1, view: resized ? null : t.view,
    }));
    return true;
  };

  const removeTab = (id: number) => {
    const tabs = get().tabs;
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const left = tabs.filter((t) => t.id !== id);
    const activeId = get().activeId === id ? (left[Math.min(i, left.length - 1)]?.id ?? null) : get().activeId;
    set({ tabs: left, activeId, text: null });
  };

  /** Asks about the given tabs and saves them when asked to. `true` = they may be closed. */
  const resolveUnsaved = async (ids: number[]): Promise<boolean> => {
    for (;;) {
      flushPending();
      const dirty = get().tabs.filter((t) => ids.includes(t.id) && t.doc.dirty);
      if (dirty.length === 0) return true;
      const answer = await askUnsaved(dirty);
      if (answer === "cancel") return false;
      if (answer === "discard") return true;
      for (const t of dirty) {
        // a failed save keeps everything open: the error says what to do
        if (!(await get().save(t.id))) return false;
      }
      // The canvas stays usable while the files are being written. Whatever was
      // drawn meanwhile is not in the pack: go round again and ask about it.
    }
  };

  return {
    tabs: [],
    activeId: null,
    tool: "pencil",
    options: defaultOptions,
    fg: [0, 0, 0, 255],
    bg: [255, 255, 255, 255],
    colorTarget: "fg",
    clipboard: null,
    cursor: null,
    viewport: { w: 800, h: 600 },
    previewTab: null,
    text: null,

    openTexture: async (path) => {
      const app = useApp.getState();
      // the pack is noted before the file is read: Rust refuses when another pack
      // is open by then, and the tab can only ever be saved into this one
      const packDir = app.pack?.dir;
      const existing = get().tabs.find((t) => t.doc.path === path && t.packDir === packDir);
      if (existing) {
        get().activate(existing.id);
        app.go("editor");
        return;
      }
      if (!packDir || opening.has(path)) return;
      opening.add(path);
      try {
        const opened = await api.editorOpen(path, packDir);
        // the pack was closed or switched while the file was being read
        if (useApp.getState().pack?.dir !== packDir) return;
        const tab = newTab(fromRaw(opened), packDir);
        flushPending();
        set({ tabs: [...get().tabs, tab], activeId: tab.id, text: null });
        app.go("editor");
        app.setStatus(
          opened.origin === "vanilla" ? `${fileName(path)}: the game's texture as a starting point. Nothing is written until you save.`
          : opened.origin === "blank" ? `${fileName(path)}: a new empty image. Nothing is written until you save.`
          : opened.origin === "work_file" ? `Opened ${fileName(path)} with its layers`
          : `Opened ${fileName(path)} from the pack`,
        );
      } catch (e) {
        app.showError(e, "The texture could not be opened");
      } finally {
        opening.delete(path);
      }
    },

    openCells: async (path, req) => {
      const app = useApp.getState();
      await get().openTexture(path);
      const packDir = app.pack?.dir;
      const tab = get().tabs.find((t) => t.doc.path === path && t.packDir === packDir);
      if (!tab) return;
      const { doc } = tab;
      const label = `cell${uniqueCells(req.cells).length === 1 ? "" : "s"} ${cellsLabel(req.cells)}`;
      const region = cellsRegion(doc, req);
      if (!region) {
        app.showError(
          {
            message: `${fileName(path)} is ${doc.width}×${doc.height}${doc.frames.length > 1 ? ` with ${doc.frames.length} frames` : ""}, so the cells of ${req.particle} cannot be found on it.`,
            hint: `The sheet must be one square image whose size is a multiple of ${req.grid} (128×128 in the game). It is open as a whole image; be careful with the other particles' cells.`,
          },
          "Only these cells could not be selected",
        );
        return;
      }
      flushPending();
      update(tab.id, (t) => ({ ...t, region, preview: null, float: null }));
      app.setStatus(`Editing only ${req.particle} (${label}). Everything else on the sheet stays as it is.`);
    },

    openRect: async (path, req) => {
      const app = useApp.getState();
      await get().openTexture(path);
      const packDir = app.pack?.dir;
      const tab = get().tabs.find((t) => t.doc.path === path && t.packDir === packDir);
      if (!tab) return;
      const { doc } = tab;
      const region = rectRegion(doc, req);
      if (!region) {
        app.showError(
          {
            message: `${fileName(path)} is ${doc.width}×${doc.height}${doc.frames.length > 1 ? ` with ${doc.frames.length} frames` : ""}, so the rectangle of ${req.piece} cannot be found on it.`,
            hint: `The image must be one picture of ${req.imageSize[0]}×${req.imageSize[1]} (the game's size) or a whole multiple of it, such as ${req.imageSize[0] * 2}×${req.imageSize[1] * 2}. It is open as a whole image; be careful with the other pieces.`,
          },
          "Only this piece could not be selected",
        );
        return;
      }
      flushPending();
      update(tab.id, (t) => ({ ...t, region, preview: null, float: null }));
      const r = region.rects[0];
      app.setStatus(`Editing only ${req.piece} (${r.w}×${r.h} px at ${r.x}, ${r.y}). Everything else in ${fileName(path)} stays as it is.`);
    },

    leaveRegion: (id) => {
      const tab = id === undefined ? current() : get().tabs.find((t) => t.id === id);
      if (!tab?.region) return;
      flushPending();
      update(tab.id, (t) => ({ ...t, region: null, preview: null, float: null }));
      useApp.getState().setStatus(`Editing the whole of ${fileName(tab.doc.path)}`);
    },

    activate: (id) => {
      if (get().activeId === id) return;
      flushPending();
      set({ activeId: id, text: null });
    },

    closeTab: async (id) => {
      if (!(await resolveUnsaved([id]))) return false;
      removeTab(id);
      return true;
    },

    save: async (id) => {
      flushPending();
      const tab = get().tabs.find((t) => t.id === (id ?? get().activeId));
      if (!tab || tab.saving) return false;
      const app = useApp.getState();
      const name = fileName(tab.doc.path);
      if (!app.pack || app.pack.dir !== tab.packDir) {
        app.showError(
          { message: `${name} belongs to a pack that is not open any more, so it cannot be saved from here.`, hint: `Open the pack in ${tab.packDir} again, then save.` },
          `${name} was not saved`,
        );
        return false;
      }
      const doc = tab.doc;
      const serial = tab.edits;
      update(tab.id, (t) => ({ ...t, saving: true }));
      try {
        // always the document's own path: never the path of whatever is on screen
        // ... and only into its own pack: Rust checks the folder again before it writes
        let flat = flatStrip(doc);
        // only the region may differ from the image as it was when the mode began
        if (tab.region) flat = clipToMask(flat, tab.region.base, tab.region.mask);
        await api.editorSave(doc.path, toRaw(doc), bytesToBase64(flat.data), tab.packDir);
      } catch (e) {
        update(tab.id, (t) => ({ ...t, saving: false }));
        app.showError(e, `${name} could not be saved`);
        return false;
      }
      update(tab.id, (t) => (t.edits === serial ? { ...t, doc: { ...t.doc, dirty: false } } : t));
      await app.reload(true);
      update(tab.id, (t) => ({ ...t, saving: false, disk: diskStamp(doc.path) }));
      app.toast(`Saved ${name} to the pack`);
      return true;
    },

    confirmLeave: () => resolveUnsaved(get().tabs.map((t) => t.id)),

    dropTabsOutside: (packDir) => {
      const tabs = get().tabs.filter((t) => t.packDir === packDir);
      if (tabs.length === get().tabs.length) return;
      const activeId = tabs.some((t) => t.id === get().activeId) ? get().activeId : (tabs[0]?.id ?? null);
      set({ tabs, activeId, text: null });
    },

    syncWithDisk: async () => {
      const app = useApp.getState();
      const find = (id: number) => get().tabs.find((t) => t.id === id);
      for (const id of get().tabs.map((t) => t.id)) {
        let tab = find(id);
        if (!tab || tab.saving || tab.packDir !== app.pack?.dir) continue;
        const stamp = diskStamp(tab.doc.path);
        if (stamp === tab.disk) continue;
        const name = fileName(tab.doc.path);
        // A tool in the middle of its work (a stroke, a polygon, typed text) is not
        // in the document yet. Finish it first, so it counts as the unsaved edit it is.
        if (id === get().activeId) flushPending();
        tab = find(id);
        if (!tab) continue;
        if (tab.doc.dirty) {
          update(id, (t) => ({ ...t, disk: stamp }));
          app.toast(`${name} was changed by another program. Your unsaved edits are kept; saving will replace that file.`, "warn");
          continue;
        }
        try {
          const opened = await api.editorOpen(tab.doc.path, tab.packDir);
          const fresh = fromRaw(opened);
          // edits made while the file was being read win (the next refresh tells about the file)
          if (id === get().activeId) flushPending();
          const still = find(id);
          if (!still || still.doc.dirty || still.saving) continue;
          update(id, (t) => {
            const next = newTab(fresh, t.packDir);
            const sameSize = fresh.width === t.doc.width && fresh.height === t.doc.height;
            return {
              ...next, id: t.id, disk: stamp, view: sameSize ? t.view : null,
              // the cells stay the only editable part; the file as it is now is what they protect
              region: t.region && sameSize && next.doc.frames.length === 1 ? { ...t.region, base: flatStrip(next.doc) } : null,
              doc: { ...next.doc, frameIndex: Math.min(t.doc.frameIndex, next.doc.frames.length - 1), referenceVisible: t.doc.referenceVisible },
            };
          });
          app.setStatus(`${name} changed on disk and was loaded again`);
        } catch {
          // the file may be half-written or gone: keep what is open
          update(id, (t) => ({ ...t, disk: stamp }));
        }
      }
    },

    setTool: (tool) => {
      if (get().tool === tool) return;
      flushPending();
      set({ tool });
      useApp.getState().setStatus(toolDef(tool).label);
    },
    setOptions: (patch) => {
      const next = { ...get().options, ...patch };
      next.size = clampSize(next.size);
      next.opacity = Math.max(0, Math.min(100, Math.round(next.opacity) || 0));
      next.tolerance = Math.max(0, Math.min(255, Math.round(next.tolerance) || 0));
      next.textSize = Math.max(4, Math.min(64, Math.round(next.textSize) || 8));
      set({ options: next });
    },
    setColor: (target, color) => set(target === "fg" ? { fg: color } : { bg: color }),
    setColorTarget: (colorTarget) => set({ colorTarget }),
    swapColors: () => set({ fg: get().bg, bg: get().fg }),
    setCursor: (p) => {
      const c = get().cursor;
      if (c === p || (c && p && c[0] === p[0] && c[1] === p[1])) return;
      set({ cursor: p });
    },
    setViewport: (w, h) => {
      const v = get().viewport;
      if (v.w !== w || v.h !== h) set({ viewport: { w, h } });
    },
    setView: (view) => {
      const tab = current();
      if (tab) update(tab.id, (t) => ({ ...t, view }));
    },
    zoomStep: (dir) => {
      const tab = current();
      if (!tab) return;
      const vp = get().viewport;
      const v = viewOf(tab, vp);
      const zoom = stepZoom(v.zoom, dir);
      // when the whole image is in view keep it centred, otherwise zoom about the middle
      const inView = tab.view === null;
      get().setView(inView ? centerView(tab.doc.width, tab.doc.height, vp.w, vp.h, zoom) : zoomAbout(v, zoom, vp.w / 2, vp.h / 2));
    },
    setPreviewTab: (previewTab) => set({ previewTab }),
    setText: (text) => set({ text }),

    setPreview: (preview) => {
      const tab = current();
      if (!tab || (tab.preview === null && preview === null)) return;
      if (preview?.cel && tab.region) preview = { ...preview, cel: clipToMask(preview.cel, activeCel(tab.doc), tab.region.mask) };
      update(tab.id, (t) => ({ ...t, preview }));
    },

    applyEdit: (label, next) => {
      const tab = current();
      if (!tab) return;
      // "Edit only these cells": whatever a tool did outside the region is taken back
      if (next.cel && tab.region) next = { ...next, cel: clipToMask(next.cel, activeCel(tab.doc), tab.region.mask) };
      const cmd = editCommand(label, tab.doc, next);
      let doc = tab.doc;
      if (cmd?.cels.length && next.cel) doc = { ...setCel(doc, doc.frameIndex, doc.activeLayer, next.cel), dirty: true };
      if (cmd?.selection) doc = { ...doc, selection: cmd.selection.after };
      const float: Float | null = next.float
        ? { floating: next.float, result: activeCel(doc), selection: doc.selection }
        : cmd ? null : tab.float;
      update(tab.id, (t) => ({
        ...t, doc, preview: null, float,
        history: cmd ? push(t.history, cmd) : t.history,
        edits: cmd?.cels.length ? t.edits + 1 : t.edits,
      }));
    },

    undo: () => {
      flushPending();
      const tab = current();
      if (!tab) return;
      const step = stepUndo(tab.history);
      if (!step) {
        useApp.getState().setStatus("Nothing to undo");
        return;
      }
      const changes = step.command.cels.length > 0 || !!step.command.structure || !!step.command.frames;
      let doc = applyCommand(tab.doc, step.command, "undo");
      doc = { ...doc, dirty: doc.dirty || changes, frameIndex: step.command.cels[0]?.frame ?? doc.frameIndex };
      // a size change (import strip) fits the new size in the window
      const resized = doc.width !== tab.doc.width || doc.height !== tab.doc.height;
      update(tab.id, (t) => ({ ...t, doc, history: step.history, preview: null, float: null, edits: t.edits + 1, view: resized ? null : t.view }));
      useApp.getState().setStatus(`Undid: ${step.command.label}`);
    },

    redo: () => {
      flushPending();
      const tab = current();
      if (!tab) return;
      const step = stepRedo(tab.history);
      if (!step) {
        useApp.getState().setStatus("Nothing to redo");
        return;
      }
      const changes = step.command.cels.length > 0 || !!step.command.structure || !!step.command.frames;
      let doc = applyCommand(tab.doc, step.command, "redo");
      doc = { ...doc, dirty: doc.dirty || changes, frameIndex: step.command.cels[0]?.frame ?? doc.frameIndex };
      // a size change (import strip) fits the new size in the window
      const resized = doc.width !== tab.doc.width || doc.height !== tab.doc.height;
      update(tab.id, (t) => ({ ...t, doc, history: step.history, preview: null, float: null, edits: t.edits + 1, view: resized ? null : t.view }));
      useApp.getState().setStatus(`Redid: ${step.command.label}`);
    },

    setActiveLayer: (index) => {
      const tab = current();
      if (!tab || tab.doc.activeLayer === index || !tab.doc.layers[index]) return;
      flushPending();
      update(tab.id, (t) => ({ ...t, doc: { ...t.doc, activeLayer: index }, preview: null }));
    },
    addLayer: () => structural("Add layer", (d) => addLayer(d)),
    duplicateLayer: (index) => structural("Duplicate layer", (d) => duplicateLayer(d, index)),
    deleteLayer: (index) => {
      const tab = current();
      const layer = tab?.doc.layers[index];
      if (!tab || !layer) return;
      if (tab.doc.layers.length <= 1) {
        warn("A texture needs at least one layer. Add another layer before deleting this one.");
        return;
      }
      const run = () => structural("Delete layer", (d) => deleteLayer(d, index));
      if (!layerHasPixels(tab.doc, index)) {
        run();
        return;
      }
      useApp.getState().ask({
        title: `Delete the layer “${layer.name}”?`,
        text: "Everything drawn on this layer is removed from the texture.",
        hint: "You can bring it back with Undo (Ctrl+Z) as long as the texture stays open.",
        buttons: [{ label: "Cancel" }, { label: "Delete layer", danger: true, run }],
      });
    },
    moveLayer: (index, delta) => structural(delta > 0 ? "Move layer up" : "Move layer down", (d) => moveLayer(d, index, delta)),
    patchLayer: (index, patch) => {
      flushPending();
      const keys = Object.keys(patch);
      const tab = current();
      const layer = tab?.doc.layers[index];
      if (!tab || !layer) return;
      const doc = patchLayer(tab.doc, index, patch);
      if (doc === tab.doc) return;
      if (keys.every((k) => k === "locked")) {
        // a lock is editor state, not part of the texture: no unsaved change, no undo step
        update(tab.id, (t) => ({ ...t, doc: { ...doc, dirty: tab.doc.dirty } }));
        return;
      }
      // name, visibility and opacity change what is saved: each is an undo step
      const label = patch.name !== undefined ? "Rename layer"
        : patch.visible !== undefined ? (patch.visible ? "Show layer" : "Hide layer")
        : "Layer opacity";
      const cmd = structureCommand(label, tab.doc, doc);
      // a slider being dragged sends many values: together they are one step
      const sliding = keys.length === 1 && keys[0] === "opacity";
      const key = sliding ? `opacity:${tab.id}:${layer.id}` : "";
      const now = Date.now();
      const merge = sliding && lastSlide.key === key && now - lastSlide.at < SLIDE_MS;
      lastSlide = { key, at: now };
      if (sliding) cmd.mergeKey = key;
      update(tab.id, (t) => ({
        ...t, doc, preview: null, edits: t.edits + 1,
        history: merge ? pushMerged(t.history, cmd) : push(t.history, cmd),
      }));
    },
    toggleReference: () => {
      const tab = current();
      if (!tab || !tab.doc.reference) return;
      update(tab.id, (t) => ({ ...t, doc: { ...t.doc, referenceVisible: !t.doc.referenceVisible } }));
    },
    stepFrame: (delta) => {
      const tab = current();
      if (!tab || tab.doc.frames.length < 2) return;
      flushPending();
      const n = tab.doc.frames.length;
      const frameIndex = (((tab.doc.frameIndex + delta) % n) + n) % n;
      update(tab.id, (t) => ({ ...t, doc: { ...t.doc, frameIndex }, preview: null }));
    },
    selectFrame: (index) => {
      const tab = current();
      if (!tab || tab.doc.frameIndex === index || !tab.doc.frames[index]) return;
      flushPending();
      update(tab.id, (t) => ({ ...t, doc: { ...t.doc, frameIndex: index }, preview: null }));
    },

    newFrame: () => {
      if (framesEdit("New frame", (d) => newFrame(d))) useApp.getState().setStatus("Added an empty frame after the current one");
    },
    duplicateFrame: () => {
      if (framesEdit("Duplicate frame", (d) => duplicateFrame(d))) useApp.getState().setStatus("Duplicated the frame");
    },
    deleteFrame: () => {
      flushPending();
      const tab = current();
      if (!tab) return;
      if (tab.doc.frames.length <= 1) {
        warn("A texture needs at least one frame. Add another frame before deleting this one.");
        return;
      }
      const index = tab.doc.frameIndex;
      const run = () => {
        if (framesEdit("Delete frame", (d) => deleteFrame(d, index), tab.id)) useApp.getState().setStatus(`Deleted frame ${index + 1}`);
      };
      const drawn = tab.doc.frames[index].cels.some((c) => {
        for (let i = 3; i < c.data.length; i += 4) if (c.data[i] !== 0) return true;
        return false;
      });
      if (!drawn) {
        run();
        return;
      }
      useApp.getState().ask({
        title: `Delete frame ${index + 1}?`,
        text: "Its pixels (all layers) are removed from the animation, and the frame order no longer plays it.",
        hint: "You can bring it back with Undo (Ctrl+Z) as long as the texture stays open.",
        buttons: [{ label: "Cancel" }, { label: "Delete frame", danger: true, run }],
      });
    },
    moveFrame: (delta) => {
      framesEdit(delta < 0 ? "Move frame left" : "Move frame right", (d) => moveFrame(d, d.frameIndex, delta));
    },
    setFrameTime: (index, ticks) => {
      framesEdit("Frame duration", (d) => {
        const next = setImageTime(d, index, ticks);
        return sameAnimation(next, d) ? d : next;
      });
    },
    setFrametime: (ticks) => {
      if (!Number.isFinite(ticks)) return;
      const n = Math.max(1, Math.min(MAX_TICKS, Math.round(ticks)));
      framesEdit("Frame time", (d) => {
        const a = d.animation;
        if (a && a.frametime === n) return d;
        return { ...d, animation: { ...(a ?? { interpolate: false, frames: null, width: null, height: null }), frametime: n } };
      });
    },
    setInterpolate: (on) => {
      framesEdit(on ? "Smooth between frames" : "No smoothing between frames", (d) => {
        const a = d.animation;
        if ((a?.interpolate ?? false) === on) return d;
        return { ...d, animation: { ...(a ?? { frametime: 1, frames: null, width: null, height: null }), interpolate: on } };
      });
    },
    setOrder: (entries, label = "Frame order") => {
      framesEdit(label, (d) => {
        const next = withOrder(d, entries);
        return sameAnimation(next, d) ? d : next;
      });
    },
    importFrames: (frames, source) => {
      flushPending();
      const tab = current();
      if (!tab || frames.length === 0) return;
      const { w, h } = frames[0];
      const n = frames.length;
      const what = `${n} frame${n === 1 ? "" : "s"} of ${w}×${h}`;
      if (w === tab.doc.width && h === tab.doc.height) {
        if (get().blocked()) return;
        const layer = tab.doc.layers[tab.doc.activeLayer].name;
        if (framesEdit("Import strip", (d) => importSameSize(d, frames), tab.id)) {
          useApp.getState().setStatus(`Imported ${what} from ${source} into the layer “${layer}”`);
        }
        return;
      }
      const run = () => {
        if (framesEdit("Import strip", (d) => importReplacing(d, frames), tab.id)) {
          useApp.getState().setStatus(`Imported ${what} from ${source}. The texture is now ${w}×${h}.`);
        }
      };
      useApp.getState().ask({
        title: `Replace the frames with ${w}×${h} frames?`,
        text:
          `The frames in ${source} are ${w}×${h}, but ${fileName(tab.doc.path)} is ${tab.doc.width}×${tab.doc.height}. ` +
          `Importing replaces every frame and layer of this texture with the ${n} imported frame${n === 1 ? "" : "s"}, at ${w}×${h}. ` +
          "The imported pixels are not resized.",
        hint: "You can undo this with Ctrl+Z as long as the texture stays open. Nothing is written until you save.",
        buttons: [{ label: "Cancel" }, { label: "Replace frames", primary: true, run }],
      });
    },

    selectAll: () => {
      flushPending();
      const tab = current();
      if (tab) get().applyEdit("Select all", { selection: selectAllMask(tab.doc.width, tab.doc.height) });
    },
    deselect: () => {
      flushPending();
      if (current()?.doc.selection) get().applyEdit("Deselect", { selection: null });
    },
    deleteSelection: () => {
      flushPending();
      const tab = current();
      if (!tab || get().blocked()) return;
      const cel = cloneBuf(activeCel(tab.doc));
      clearArea(cel, tab.doc.selection);
      get().applyEdit("Delete", { cel });
    },
    copy: () => {
      flushPending();
      const tab = current();
      if (!tab) return false;
      const clip = copyClip(activeCel(tab.doc), tab.doc.selection);
      if (!clip) return false;
      set({ clipboard: clip });
      useApp.getState().setStatus(`Copied ${clip.buf.w}×${clip.buf.h} pixels`);
      return true;
    },
    cut: () => {
      // a tool still at work is finished first: the copy and the cleared area
      // must both come from the document as it is after that
      flushPending();
      if (!current() || get().blocked()) return;
      if (!get().copy()) return;
      const tab = current();
      if (!tab) return;
      const cel = cloneBuf(activeCel(tab.doc));
      clearArea(cel, tab.doc.selection);
      get().applyEdit("Cut", { cel });
    },
    paste: () => {
      flushPending();
      const tab = current();
      const clip = get().clipboard;
      if (!tab) return;
      if (!clip) {
        useApp.getState().setStatus("Nothing to paste yet. Copy something first with Ctrl+C.");
        return;
      }
      if (get().blocked()) return;
      const p = pasteFloating(activeCel(tab.doc), clip);
      get().applyEdit("Paste", { cel: p.cel, selection: p.selection, float: p.floating });
      // the pasted pixels stay lifted: drag them into place with the Move tool
      set({ tool: "move" });
      useApp.getState().setStatus("Pasted. Drag to move it into place.");
    },
    loadPalette: (source) => {
      const tab = current();
      if (!tab) return;
      update(tab.id, (t) => ({ ...t, paletteSource: source, doc: { ...t.doc, palette: paletteFrom(t.doc, source) } }));
    },
    blocked: () => {
      const tab = current();
      if (!tab) return true;
      const why = editBlock(tab.doc);
      if (why) warn(why);
      return why !== null;
    },
  };
});

// Leaving a pack asks about unsaved textures first (see store.ts).
registerPackGuard({
  confirmLeave: () => useEditor.getState().confirmLeave(),
  packChanged: (dir) => useEditor.getState().dropTabsOutside(dir),
});

/** Test hook: an editor with one open document. */
export function openForTest(doc: EditorDoc, packDir = "/pack"): Tab {
  const tab = newTab(doc, packDir);
  useEditor.setState({ tabs: [...useEditor.getState().tabs, tab], activeId: tab.id });
  return tab;
}

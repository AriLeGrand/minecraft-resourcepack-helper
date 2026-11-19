// State of the pixel editor: open textures (tabs), the current tool and its
// options, colours and the clipboard. The pixel work itself is in the pure
// modules (doc, tools, history, pixels); this file only wires them to the app.
import { create } from "zustand";
import { api } from "../lib/api";
import { baseName } from "../lib/logic";
import { registerPackGuard, useApp } from "../store";
import {
  activeCel, addLayer, deleteLayer, duplicateLayer, editBlock, flatStrip, flatten, fromRaw, layerHasPixels, moveLayer,
  patchLayer, setCel, toRaw, type EditorDoc, type LayerPatch,
} from "./doc";
import { applyCommand, editCommand, emptyHistory, push, stepRedo, stepUndo, structureCommand, type History } from "./history";
import {
  bytesToBase64, clearArea, cloneBuf, copyClip, extractPalette, rgbaToHex,
  type Buf, type Clip, type Mask, type Pt, type Rgba,
} from "./pixels";
import { clampSize, defaultOptions, pasteFloating, selectAllMask, toolDef, type Floating, type ToolId, type ToolOptions } from "./tools";
import { centerView, fitView, stepZoom, zoomAbout, type View } from "./view";

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
}

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
  previewTab: "tiled" | "original";
  /** Text being typed with the Text tool. */
  text: TextEdit | null;

  openTexture: (path: string) => Promise<void>;
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
  setPreviewTab: (t: "tiled" | "original") => void;
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

/** The document as it should be drawn: with the tool's preview on top. */
export function shownDoc(tab: Tab): EditorDoc {
  const p = tab.preview;
  if (!p) return tab.doc;
  let doc = tab.doc;
  if (p.cel) doc = setCel(doc, doc.frameIndex, doc.activeLayer, p.cel);
  if (p.selection !== undefined) doc = { ...doc, selection: p.selection };
  return doc;
}

/** The current view, or the fitted one when the user has not zoomed or panned yet. */
export function viewOf(tab: Tab, viewport: { w: number; h: number }): View {
  return tab.view ?? fitView(tab.doc.width, tab.doc.height, viewport.w, viewport.h);
}

function diskStamp(path: string): string {
  const mine = useApp.getState().rows.find((r) => r.path === path)?.mine;
  return mine ? `${mine.modified_ms}:${mine.file_size}` : "";
}

export const fileName = (path: string) => `${baseName(path)}.png`;

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
    disk: diskStamp(doc.path), saving: false, edits: 0, paletteSource,
  };
}

let lastWarn = { text: "", at: 0 };
/** A warning toast, not repeated while the user keeps clicking. */
function warn(text: string) {
  const now = Date.now();
  if (lastWarn.text === text && now - lastWarn.at < 2500) return;
  lastWarn = { text, at: now };
  useApp.getState().toast(text, "warn");
}

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
    flushPending();
    const dirty = get().tabs.filter((t) => ids.includes(t.id) && t.doc.dirty);
    if (dirty.length === 0) return true;
    const answer = await askUnsaved(dirty);
    if (answer === "cancel") return false;
    if (answer === "save") {
      for (const t of dirty) {
        // a failed save keeps everything open: the error says what to do
        if (!(await get().save(t.id))) return false;
      }
    }
    return true;
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
    previewTab: "tiled",
    text: null,

    openTexture: async (path) => {
      const app = useApp.getState();
      const existing = get().tabs.find((t) => t.doc.path === path);
      if (existing) {
        get().activate(existing.id);
        app.go("editor");
        return;
      }
      if (!app.pack || opening.has(path)) return;
      opening.add(path);
      try {
        const opened = await api.editorOpen(path);
        const packDir = useApp.getState().pack?.dir;
        if (!packDir) return;
        const tab = newTab(fromRaw(opened), packDir);
        flushPending();
        set({ tabs: [...get().tabs, tab], activeId: tab.id, text: null });
        app.go("editor");
        app.setStatus(
          opened.origin === "vanilla" ? `${fileName(path)}: the game's texture as a starting point. Nothing is written until you save.`
          : opened.origin === "work_file" ? `Opened ${fileName(path)} with its layers`
          : `Opened ${fileName(path)} from the pack`,
        );
      } catch (e) {
        app.showError(e, "The texture could not be opened");
      } finally {
        opening.delete(path);
      }
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
        await api.editorSave(doc.path, toRaw(doc), bytesToBase64(flatStrip(doc).data));
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
      for (const tab of get().tabs) {
        if (tab.saving || tab.packDir !== app.pack?.dir) continue;
        const stamp = diskStamp(tab.doc.path);
        if (stamp === tab.disk) continue;
        const name = fileName(tab.doc.path);
        if (tab.doc.dirty) {
          update(tab.id, (t) => ({ ...t, disk: stamp }));
          app.toast(`${name} was changed by another program. Your unsaved edits are kept; saving will replace that file.`, "warn");
          continue;
        }
        try {
          const opened = await api.editorOpen(tab.doc.path);
          const fresh = fromRaw(opened);
          const still = get().tabs.find((t) => t.id === tab.id);
          // edits made while the file was being read win
          if (!still || still.doc.dirty || still.saving) continue;
          if (tab.id === get().activeId) flushPending();
          update(tab.id, (t) => {
            const next = newTab(fresh, t.packDir);
            const sameSize = fresh.width === t.doc.width && fresh.height === t.doc.height;
            return {
              ...next, id: t.id, disk: stamp, view: sameSize ? t.view : null,
              doc: { ...next.doc, frameIndex: Math.min(t.doc.frameIndex, next.doc.frames.length - 1), referenceVisible: t.doc.referenceVisible },
            };
          });
          app.setStatus(`${name} changed on disk and was loaded again`);
        } catch {
          // the file may be half-written or gone: keep what is open
          update(tab.id, (t) => ({ ...t, disk: stamp }));
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
      update(tab.id, (t) => ({ ...t, preview }));
    },

    applyEdit: (label, next) => {
      const tab = current();
      if (!tab) return;
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
      const changes = step.command.cels.length > 0 || !!step.command.structure;
      let doc = applyCommand(tab.doc, step.command, "undo");
      doc = { ...doc, dirty: doc.dirty || changes, frameIndex: step.command.cels[0]?.frame ?? doc.frameIndex };
      update(tab.id, (t) => ({ ...t, doc, history: step.history, preview: null, float: null, edits: t.edits + 1 }));
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
      const changes = step.command.cels.length > 0 || !!step.command.structure;
      let doc = applyCommand(tab.doc, step.command, "redo");
      doc = { ...doc, dirty: doc.dirty || changes, frameIndex: step.command.cels[0]?.frame ?? doc.frameIndex };
      update(tab.id, (t) => ({ ...t, doc, history: step.history, preview: null, float: null, edits: t.edits + 1 }));
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
      const lockOnly = Object.keys(patch).every((k) => k === "locked");
      const tab = current();
      if (!tab) return;
      const doc = patchLayer(tab.doc, index, patch);
      if (doc === tab.doc) return;
      // a lock is editor state, not part of the texture: it does not count as an unsaved change
      update(tab.id, (t) => ({ ...t, doc: lockOnly ? { ...doc, dirty: tab.doc.dirty } : doc, edits: t.edits + 1 }));
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
      const tab = current();
      if (!tab || get().blocked()) return;
      if (!get().copy()) return;
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

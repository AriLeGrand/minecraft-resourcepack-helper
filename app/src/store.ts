// App state. Screens read from here and call these actions; the actions call Rust.
import { create } from "zustand";
import { api, toError, type Bootstrap, type CoreError, type PackState, type PackSummary, type TextureRow, type WhatsNewView } from "./lib/api";
import { defaultFilters, type Filters } from "./lib/logic";

export type Screen =
  | "home"
  | "textures"
  | "editor"
  | "interface"
  | "particles"
  | "animation"
  | "models"
  | "export"
  | "settings";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "warn";
  action?: { label: string; run: () => void };
}

export interface Modal {
  title: string;
  text: string;
  hint?: string | null;
  buttons: { label: string; primary?: boolean; danger?: boolean; run?: () => void }[];
}

/**
 * The editor registers itself here, so that leaving a pack (closing it,
 * opening another one, quitting) can never drop unsaved textures.
 */
export interface PackGuard {
  /** Asks Save / Discard / Cancel when textures have unsaved edits. `false` = stay. */
  confirmLeave: () => Promise<boolean>;
  /** The open pack changed: editor tabs of any other pack are closed. */
  packChanged: (dir: string | null) => void;
}

let guard: PackGuard = { confirmLeave: async () => true, packChanged: () => {} };
export const registerPackGuard = (g: PackGuard) => {
  guard = g;
};

interface State {
  boot: Bootstrap | null;
  pack: PackState | null;
  screen: Screen;
  rows: TextureRow[];
  summary: PackSummary | null;
  loading: boolean;
  /** Bumped on every reload so images of changed files are fetched again. */
  stamp: number;
  selected: string | null;
  filters: Filters;
  view: "list" | "grid";
  toasts: Toast[];
  modal: Modal | null;
  palette: boolean;
  status: string;
  busy: { text: string; done: number; total: number } | null;
  /** The last "What's new since…" comparison of the open pack. */
  whatsNew: WhatsNewView | null;

  init: () => Promise<void>;
  go: (s: Screen) => void;
  setBoot: (b: Bootstrap) => void;
  setPack: (p: PackState | null) => void;
  /**
   * Makes a pack the open one. Pass a function when the pack still has to be
   * opened or created: unsaved editor work is then asked about first, and
   * nothing is switched when the answer is Cancel. Returns `false` in that case.
   */
  enterPack: (p: PackState | (() => Promise<PackState>)) => Promise<boolean>;
  /** Returns `false` when the user chose to stay (unsaved editor work). */
  closePack: () => Promise<boolean>;
  /** Save / Discard / Cancel for unsaved editor work. `true` = fine to leave. */
  confirmLeave: () => Promise<boolean>;
  reload: (quiet?: boolean) => Promise<void>;
  ensureExtracted: (dirName: string, label: string) => Promise<boolean>;
  select: (path: string | null) => void;
  setFilters: (f: Partial<Filters>) => void;
  setView: (v: "list" | "grid") => void;
  toast: (text: string, kind?: "ok" | "warn", action?: Toast["action"]) => void;
  dismissToast: (id: number) => void;
  showError: (e: unknown, title?: string) => void;
  ask: (m: Modal) => void;
  closeModal: () => void;
  setPalette: (open: boolean) => void;
  setStatus: (s: string) => void;
  setBusy: (b: State["busy"]) => void;
  setWhatsNew: (w: WhatsNewView | null) => void;
}

let toastId = 1;

export const useApp = create<State>((set, get) => ({
  boot: null,
  pack: null,
  screen: "home",
  rows: [],
  summary: null,
  loading: false,
  stamp: 1,
  selected: null,
  filters: defaultFilters,
  view: "list",
  toasts: [],
  modal: null,
  palette: false,
  status: "Ready",
  busy: null,
  whatsNew: null,

  init: async () => {
    try {
      const boot = await api.bootstrap();
      set({ boot });
      const last = boot.settings.last_pack;
      if (last) {
        try {
          await get().enterPack(await api.openPack(last));
        } catch {
          // the folder may have been moved or deleted: stay on the start screen
          get().toast("The last pack could not be reopened. It may have been moved.", "warn");
        }
      }
    } catch (e) {
      get().showError(e, "Pack Creator could not start");
    }
  },

  go: (screen) => set({ screen }),
  setBoot: (boot) => set({ boot }),
  setPack: (pack) => set({ pack }),

  enterPack: async (next) => {
    let pack: PackState;
    if (typeof next === "function") {
      // ask before Rust switches packs: afterwards a save would land in the wrong pack
      if (!(await guard.confirmLeave())) return false;
      pack = await next();
    } else {
      pack = next;
    }
    guard.packChanged(pack.dir);
    set({ pack, rows: [], summary: null, selected: null, filters: defaultFilters, screen: "textures", whatsNew: null });
    api.bootstrap().then((boot) => set({ boot })).catch(() => {});
    await get().reload();
    return true;
  },

  closePack: async () => {
    if (!(await guard.confirmLeave())) return false;
    await api.closePack().catch(() => {});
    const boot = await api.bootstrap().catch(() => get().boot);
    guard.packChanged(null);
    set({ pack: null, rows: [], summary: null, selected: null, screen: "home", status: "Ready", boot, whatsNew: null });
    return true;
  },

  confirmLeave: () => guard.confirmLeave(),

  ensureExtracted: async (dirName, label) => {
    set({ busy: { text: `Extracting textures from Minecraft ${label}…`, done: 0, total: 0 } });
    try {
      await api.extractVersion(dirName);
      return true;
    } catch (e) {
      get().showError(e, `Minecraft ${label} could not be read`);
      return false;
    } finally {
      set({ busy: null });
    }
  },

  reload: async (quiet = false) => {
    const pack = get().pack;
    if (!pack) return;
    if (!quiet) set({ loading: true });
    try {
      const label = pack.version?.label ?? pack.project.version_dir;
      if (!pack.vanilla_ready) {
        const ok = await get().ensureExtracted(pack.project.version_dir, label);
        if (!ok) {
          set({ loading: false, status: "Game textures not available" });
          return;
        }
        set({ pack: await api.getPack() });
      }
      const { rows, summary } = await api.loadTextures();
      const selected = get().selected;
      set({
        rows,
        summary,
        loading: false,
        stamp: get().stamp + 1,
        // a quiet refresh (file watcher, after a save) leaves the last message alone
        status: quiet ? get().status : `Vanilla ${label} loaded`,
        selected: selected && rows.some((r) => r.path === selected) ? selected : null,
      });
    } catch (e) {
      set({ loading: false });
      if (!quiet) get().showError(e, "The textures could not be loaded");
    }
  },

  select: (selected) => set({ selected }),
  // a new `only` list without its own label gets the default notice
  // a new `only` list without its own label / title gets the default notice and heading
  setFilters: (f) => set({
    filters: {
      ...get().filters,
      ...("only" in f && !("onlyLabel" in f) ? { onlyLabel: undefined } : {}),
      ...("only" in f && !("onlyTitle" in f) ? { onlyTitle: undefined } : {}),
      ...f,
    },
  }),
  setView: (view) => set({ view }),

  toast: (text, kind = "ok", action) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind, action }], status: text });
    setTimeout(() => get().dismissToast(id), action ? 9000 : 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  showError: (e, title = "That did not work") => {
    const err: CoreError = toError(e);
    set({ modal: { title, text: err.message, hint: err.hint, buttons: [{ label: "OK", primary: true }] } });
  },
  ask: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setPalette: (palette) => set({ palette }),
  setStatus: (status) => set({ status }),
  setBusy: (busy) => set({ busy }),
  setWhatsNew: (whatsNew) => set({ whatsNew }),
}));

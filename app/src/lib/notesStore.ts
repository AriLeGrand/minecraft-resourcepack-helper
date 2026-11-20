// The notes of the open pack (`.packcreator/notes.json`), loaded once per pack
// and saved one texture at a time through Rust.
import { create } from "zustand";
import { api, type TextureNote } from "./api";
import { emptyNote, hasContent, sameNote } from "./notes";
import { useApp } from "../store";

// ---- "Mine": the user's own name, kept on this computer only ----

const ME_KEY = "packcreator.myName";

export function loadMyName(): string {
  try {
    return localStorage.getItem(ME_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeMyName(name: string) {
  try {
    localStorage.setItem(ME_KEY, name);
  } catch {
    // private storage refused: the name only lasts for this session
  }
}

// ---- store ----

interface NotesState {
  /** Pack folder the notes belong to. */
  dir: string | null;
  notes: Record<string, TextureNote>;
  me: string;
  load: (dir: string) => Promise<void>;
  /** Saves one texture's note; the status bar says so (no toast). */
  save: (path: string, note: TextureNote) => Promise<void>;
  setMe: (name: string) => void;
}

export const useNotes = create<NotesState>((set, get) => ({
  dir: null,
  notes: {},
  me: loadMyName(),

  load: async (dir) => {
    set({ dir, notes: {} });
    try {
      const r = await api.notesLoad(dir);
      if (get().dir !== dir) return;
      set({ notes: r.notes.textures });
      if (r.damaged_kept) {
        useApp.getState().toast(`The notes file of this pack was damaged. It was kept as ${r.damaged_kept}; new notes start empty.`, "warn");
      }
    } catch (e) {
      useApp.getState().showError(e, "The notes of this pack could not be read");
    }
  },

  save: async (path, note) => {
    const dir = get().dir;
    if (!dir) return;
    const before = get().notes[path];
    if (sameNote(before ?? emptyNote(), note)) return;
    try {
      const stored = await api.notesSet(path, note, dir);
      if (get().dir !== dir) return;
      const notes = { ...get().notes };
      if (hasContent(stored)) notes[path] = stored;
      else delete notes[path];
      set({ notes });
      const name = path.slice(path.lastIndexOf("/") + 1);
      useApp.getState().setStatus(hasContent(stored) ? `Saved the notes of ${name}` : `Removed the notes of ${name}`);
    } catch (e) {
      useApp.getState().showError(e, "The note could not be saved");
    }
  },

  setMe: (name) => {
    const me = name.trim().replace(/\s+/g, " ");
    storeMyName(me);
    set({ me });
  },
}));

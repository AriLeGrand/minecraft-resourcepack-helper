// Typed wrappers around the Rust commands. The UI never touches files itself.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface CoreError {
  kind: string;
  message: string;
  hint: string | null;
}

export interface PackFormat {
  major: number;
  minor: number | null;
}

export interface Settings {
  minecraft_dir: string | null;
  external_editor: string | null;
  export_dir: string | null;
  packs_dir: string | null;
  recent: RecentPack[];
  last_pack: string | null;
  export_kind_folder: boolean;
  export_install: boolean;
  export_only_changed: boolean;
}

export interface RecentPack {
  path: string;
  name: string;
  version: string;
  resolution: number;
  opened_ms: number;
  done: number;
  total: number;
}

export interface VersionView {
  dir_name: string;
  id: string | null;
  has_jar: boolean;
  format: PackFormat | null;
  format_source: "game_files" | "table" | "guess" | null;
  problem: string | null;
  extracted: boolean;
  usable: boolean;
  label: string;
}

export interface Bootstrap {
  app_version: string;
  settings: Settings;
  minecraft_dir: string | null;
  minecraft_error: CoreError | null;
  versions: VersionView[];
  default_packs_dir: string;
}

export interface Project {
  name: string;
  description: string;
  version_dir: string;
  version_id: string | null;
  format: PackFormat;
  resolution: number;
  created_ms: number;
  last_export_ms: number | null;
  also_export: string[];
}

export interface PackState {
  dir: string;
  project: Project;
  version: VersionView | null;
  vanilla_ready: boolean;
  export_dir: string;
}

export type Category =
  | "blocks"
  | "items"
  | "gui"
  | "entities"
  | "particles"
  | "environment"
  | "paintings"
  | "mob_effects"
  | "armor"
  | "misc";

export type Status = "todo" | "done" | "changed";

export interface PackTexture {
  path: string;
  width: number;
  height: number;
  modified_ms: number;
  has_mcmeta: boolean;
  animated: boolean;
  frames: number;
  file_size: number;
}

export interface TextureRow {
  path: string;
  category: Category;
  width: number;
  height: number;
  animated: boolean;
  frames: number;
  has_thumb: boolean;
  status: Status;
  mine: PackTexture | null;
  wrong_size: boolean;
  renamed: boolean;
  extra: boolean;
}

export interface PackSummary {
  textures: number;
  animated: number;
  bytes: number;
  done: number;
  total: number;
}

export interface TextureEntry {
  path: string;
  width: number;
  height: number;
  animated: boolean;
  frames: number;
  frametime: number;
  interpolate: boolean;
  used_by: string[];
  used_by_more: number;
}

export interface NameEra {
  label: string;
  name: string;
  current: boolean;
}

export interface TextureDetail {
  entry: TextureEntry | null;
  eras: NameEra[];
  pack_file: string;
}

export interface ImageInfo {
  width: number;
  height: number;
  is_png: boolean;
  strip_frames: number | null;
}

export interface ImportResult {
  info: ImageInfo;
  converted: boolean;
  replaced: boolean;
  wrote_mcmeta: boolean;
}

export interface Check {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  fix: string | null;
  paths: string[];
}

export interface ExportOutput {
  version: string;
  path: string;
  files: number;
  renamed: number;
  skipped: string[];
  installed_to: string | null;
}

// ---- editor (raw RGBA pixels as base64; PNG coding happens in Rust)

export interface AnimFrame {
  index: number;
  time: number | null;
}

export interface Animation {
  frametime: number;
  interpolate: boolean;
  frames: AnimFrame[] | null;
  width: number | null;
  height: number | null;
}

export interface LayerMeta {
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0 to 100. */
  opacity: number;
}

export interface RawFrame {
  /** One RGBA buffer per layer, base64, `width * height * 4` bytes each. */
  cels: string[];
  time: number | null;
}

export interface RawDoc {
  width: number;
  height: number;
  layers: LayerMeta[];
  frames: RawFrame[];
  animation: Animation | null;
  palette: string[];
}

export interface RawImage {
  width: number;
  height: number;
  rgba: string;
}

export type Origin = "work_file" | "pack_png" | "vanilla";

export interface OpenedRaw {
  path: string;
  origin: Origin;
  doc: RawDoc;
  /** The game's texture (whole file, frames stacked) or `null` when the game has none. */
  vanilla: RawImage | null;
  vanilla_frames: number;
}

export interface SettingsPatch {
  minecraft_dir?: string | null;
  external_editor?: string | null;
  export_dir?: string | null;
  packs_dir?: string | null;
  export_kind_folder?: boolean;
  export_install?: boolean;
  export_only_changed?: boolean;
}

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  updateSettings: (patch: SettingsPatch) => invoke<Bootstrap>("update_settings", { patch }),
  forgetRecent: (path: string) => invoke<Bootstrap>("forget_recent", { path }),
  extractVersion: (dirName: string) => invoke<number>("extract_version", { dirName }),
  clearCache: (dirName: string) => invoke<void>("clear_cache", { dirName }),
  createPack: (input: { name: string; version_dir: string; resolution: number; location: string }) =>
    invoke<PackState>("create_pack", { input }),
  openPack: (path: string) => invoke<PackState>("open_pack", { path }),
  importZip: (zip: string, dest: string) => invoke<PackState>("import_zip", { zip, dest }),
  closePack: () => invoke<void>("close_pack"),
  getPack: () => invoke<PackState>("get_pack"),
  updateProject: (patch: { name?: string; description?: string; also_export?: string[]; resolution?: number }) =>
    invoke<PackState>("update_project", { patch }),
  loadTextures: () => invoke<{ rows: TextureRow[]; summary: PackSummary }>("load_textures"),
  textureDetail: (path: string) => invoke<TextureDetail>("texture_detail", { path }),
  inspectImage: (path: string) => invoke<ImageInfo>("inspect_image", { path }),
  importTexture: (path: string, source: string, frametime: number | null) =>
    invoke<ImportResult>("import_texture", { path, source, frametime }),
  openExternal: (path: string) => invoke<string>("open_external", { path }),
  editorOpen: (path: string) => invoke<OpenedRaw>("editor_open", { path }),
  /** `flat` is every frame flattened and stacked vertically, base64 RGBA. */
  editorSave: (path: string, doc: RawDoc, flat: string) => invoke<void>("editor_save", { path, doc, flat }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  revertTexture: (path: string) => invoke<boolean>("revert_texture", { path }),
  setPackIcon: (source: string) => invoke<void>("set_pack_icon", { source }),
  editPackIcon: () => invoke<void>("edit_pack_icon"),
  runChecks: () => invoke<Check[]>("run_checks"),
  applyFix: (id: string) => invoke<string>("apply_fix", { id }),
  exportPack: (request: { folder: boolean; install: boolean; only_changed: boolean; also: string[] }) =>
    invoke<{ outputs: ExportOutput[]; pack: PackState }>("export_pack", { request }),
};

/** Turns anything thrown by a command into a `CoreError`. */
export function toError(e: unknown): CoreError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as Partial<CoreError>;
    return { kind: o.kind ?? "error", message: String(o.message), hint: o.hint ?? null };
  }
  return { kind: "error", message: String(e), hint: null };
}

// Image URLs served by the Rust `pcimg` protocol (cache and open pack only).
const img = (path: string) => convertFileSrc(path, "pcimg");

export const images = {
  vanillaThumb: (dirName: string, tex: string) => img(`vanilla/${dirName}/thumb/${tex}`),
  vanillaFull: (dirName: string, tex: string) => img(`vanilla/${dirName}/full/${tex}`),
  packFull: (tex: string, stamp: number) => `${img(`pack/full/${tex}`)}?v=${stamp}`,
  packIcon: (stamp: number) => `${img("pack/icon")}?v=${stamp}`,
  recentIcon: (dir: string) => `${img("packicon")}?dir=${encodeURIComponent(dir)}`,
};

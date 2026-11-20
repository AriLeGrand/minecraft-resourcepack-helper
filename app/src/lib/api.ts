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
  /** "Make PNG files smaller (same pixels)". */
  export_optimize: boolean;
  /** How a game texture is enlarged when a texture is started from it (32× and more). */
  upscale: Upscale;
  /** The first-start welcome window was closed. */
  welcome_seen: boolean;
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
  /** The pack palette: `#rrggbb`, at most 64. */
  pack_palette: string[];
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

/** Note, tags and "assigned to" of one texture (`.packcreator/notes.json`). */
export interface TextureNote {
  note: string;
  tags: string[];
  /** "" = nobody yet. */
  assignee: string;
  updated_ms: number;
}

export interface LoadedNotes {
  notes: { schema: number; textures: Record<string, TextureNote> };
  /** Set when a damaged notes file was moved aside (where it is now). */
  damaged_kept: string | null;
}

/** An earlier version of a texture (`.packcreator/history` or `.packcreator/trash`). */
export interface HistoryVersion {
  id: string;
  kind: "history" | "trash";
  replaced_ms: number;
  made_ms: number;
  width: number;
  height: number;
  bytes: number;
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

// ---- batch import (core/src/batch.rs)

export type BatchStatus = "new" | "replaces" | "same" | "unknown" | "ambiguous";
export type BatchRule = "pack_path" | "texture_path" | "file_name" | "none";

export interface BatchCandidate {
  path: string;
  /** The pack already has a file for it. */
  in_pack: boolean;
}

export interface BatchRow {
  id: number;
  /** Path relative to the chosen folder, with "/". */
  rel: string;
  source: string;
  target: string | null;
  candidates: BatchCandidate[];
  renamed_from: string | null;
  rule: BatchRule;
  status: BatchStatus;
  duplicate: boolean;
  width: number;
  height: number;
  expected: [number, number] | null;
  wrong_size: boolean;
  has_mcmeta: boolean;
  strip_frames: number | null;
  frames_default: boolean;
  accept: boolean;
  problem: string | null;
}

export interface BatchScan {
  folder: string;
  rows: BatchRow[];
  truncated: boolean;
  skipped_pack: boolean;
}

export interface BatchItem {
  id: number;
  target: string;
  frames: boolean;
}

export interface BatchItemResult {
  id: number;
  target: string;
  ok: boolean;
  replaced: boolean;
  wrote_mcmeta: boolean;
  unchanged: boolean;
  error: CoreError | null;
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
  /** PNG bytes in the pack, and as written (smaller with "Make PNG files smaller"). */
  png_bytes_before: number;
  png_bytes_after: number;
}

// ---- compare with another pack (core/src/compare.rs)

export type CompareStatus = "only_mine" | "only_theirs" | "different" | "same";

export interface CompareRow {
  id: number;
  /** The texture in the open pack's version (`null` when their file matches none). */
  path: string | null;
  /** Their file, relative to assets/minecraft/textures, without ".png". */
  theirs: string | null;
  renamed_from: string | null;
  status: CompareStatus;
  their_size: [number, number] | null;
  my_size: [number, number] | null;
  their_mcmeta: boolean;
  my_mcmeta: boolean;
  /** Same pixels, different .mcmeta. */
  mcmeta_differs: boolean;
  in_game: boolean;
  /** Another of their files is used for this texture (this one is not). */
  shadowed_by: string | null;
}

export interface Comparison {
  source: string;
  name: string;
  description: string | null;
  format: PackFormat | null;
  rows: CompareRow[];
  skipped_big: number;
  truncated: boolean;
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

export type Origin = "work_file" | "pack_png" | "vanilla" | "blank";

export interface OpenedRaw {
  path: string;
  origin: Origin;
  doc: RawDoc;
  /** The game's texture (whole file, frames stacked) or `null` when the game has none. */
  vanilla: RawImage | null;
  vanilla_frames: number;
}

/** Block model types (Rust `core/src/models.rs`); coordinates in 0..16 block units. */
export type FaceDir = "down" | "up" | "north" | "south" | "west" | "east";

export interface ModelFace {
  /** Texture path such as `block/oak_planks`, `null` when its variable leads nowhere. */
  texture: string | null;
  /** `[u1, v1, u2, v2]` in 0..16 texture units. */
  uv: [number, number, number, number];
  /** 0, 90, 180 or 270, clockwise. */
  rotation: number;
  tintindex: number | null;
  cullface: string | null;
}

export interface ModelElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation: { origin: [number, number, number]; axis: "x" | "y" | "z"; angle: number; rescale: boolean } | null;
  shade: boolean;
  faces: Partial<Record<FaceDir, ModelFace>>;
}

export interface BlockModel {
  name: string;
  chain: string[];
  from_pack: boolean;
  ambientocclusion: boolean;
  textures: Record<string, string>;
  elements: ModelElement[];
  /** Set when there is nothing to draw (`builtin/entity`, `builtin/generated`, `none`). */
  builtin: string | null;
}

export interface ModelChoice {
  name: string;
  label: string;
}

/** Scene screen (Rust `core/src/scene.rs`). */
export interface SceneBlock {
  id: string;
  /** Models of the block's default state (several for a multipart block). */
  models: BlockModel[];
  error: string | null;
}

export interface SceneFile {
  version: number;
  width: number;
  depth: number;
  height: number;
  /** Block id per cell, "" = air; index `(y * depth + z) * width + x`. */
  blocks: string[];
}

/** Particle viewer (Rust `core/src/particle_list.rs`). */
export type ParticleLayout = "separate" | "sheet";
export type ParticleStatus = "todo" | "partly" | "done";

export interface ParticleInfo {
  id: string;
  /** Separate: frame texture paths in order. Sheet: the texture with the cells (or the particle's own file). */
  textures: string[];
  in_pack: boolean[];
  status: ParticleStatus;
  size: [number, number] | null;
  json_from_pack: boolean;
  json: string | null;
  skipped: string[];
  /** Sheet only: "age", "random", "single" or "state". */
  mode: string | null;
  /** Sheet only: cell indexes in play order. */
  cells: number[];
  shared_with: string[];
  /** Sheet only: columns of the frame grid in the particle's own file (explosion: 4). */
  grid: number;
  in_version: boolean;
}

export interface ParticleList {
  layout: ParticleLayout;
  particles: ParticleInfo[];
  done: number;
  total: number;
  sheet: string | null;
  sheet_grid: number;
}

/** Interface editor (Rust `core/src/gui.rs`, `core/src/gui_screens.rs`). */
export interface Border {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A sprite's stretch rule (`gui.scaling` of its `.mcmeta`). Sizes are GUI pixels. */
export type Scaling =
  | { type: "stretch" }
  | { type: "tile"; width: number; height: number }
  | { type: "nine_slice"; width: number; height: number; border: Border; stretch_inner: boolean };

/** `pack`: the pack's .mcmeta; `pack_png_only`: the pack's PNG without one (stretched); `game`: the game's. */
export type ScalingSource = "pack" | "pack_png_only" | "game";

export interface ScalingState {
  scaling: Scaling;
  source: ScalingSource;
  vanilla: Scaling;
  pack_has_png: boolean;
  pack_mcmeta: string | null;
  vanilla_mcmeta: string | null;
  error: string | null;
}

export interface GuiLayoutItem {
  piece?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Part of the texture [u, v, w, h] in texture units, drawn without the stretch rule. */
  src?: [number, number, number, number];
  /** Size of the whole texture in texture units (when not its pixel size). */
  tex?: [number, number];
  draw?: "tile";
  /** The piece shown instead when hover states are off. */
  normal?: string;
  text?: string;
  color?: string;
  align?: "left" | "center" | "right";
  shadow?: boolean;
  outline?: boolean;
}

export interface GuiPiece {
  id: string;
  name: string;
  path: string;
  used_on: string;
  size: [number, number] | null;
  pack_size: [number, number] | null;
  in_pack: boolean;
  in_version: boolean;
  scalable: boolean;
  scaling: ScalingState | null;
  /** Shared images (before 1.20.2): the rectangle [x, y, w, h] in the game's image. */
  rect: [number, number, number, number] | null;
  checked: string[];
  modern: string | null;
}

export interface GuiScreen {
  id: string;
  name: string;
  folder: string;
  size: [number, number];
  pieces: GuiPiece[];
  layout: GuiLayoutItem[];
  /** Shared images: the texture path of the image. */
  image: string | null;
  done: number;
  total: number;
}

export interface GuiOverview {
  layout: "sprites" | "shared";
  screens: GuiScreen[];
  done: number;
  total: number;
}

export interface MetaChange {
  before: string | null;
  after: string | null;
}

export interface AddedFrame {
  texture: string;
  json: string;
}

export interface SettingsPatch {
  minecraft_dir?: string | null;
  external_editor?: string | null;
  export_dir?: string | null;
  packs_dir?: string | null;
  export_kind_folder?: boolean;
  export_install?: boolean;
  export_only_changed?: boolean;
  export_optimize?: boolean;
  upscale?: Upscale;
  welcome_seen?: boolean;
}

export interface RenamedTexture {
  /** Name in the other version. */
  from: string;
  /** Name in the pack's version. */
  to: string;
  /** Only the folder changed (`blocks/stone` → `block/stone`). */
  folder_only: boolean;
}

export interface ChangedTexture {
  /** Name in the pack's version. */
  path: string;
  /** Name in the other version (the same unless renamed). */
  other_path: string;
  width: number;
  height: number;
  other_width: number;
  other_height: number;
}

/** The pack's game version compared with another installed one. */
export interface VersionDiff {
  this_dir: string;
  other_dir: string;
  this_version: string;
  other_version: string;
  other_is_older: boolean;
  /** In the pack's version, not in the other one (after renames). */
  added: string[];
  /** In the other version, not in the pack's. */
  removed: string[];
  renamed: RenamedTexture[];
  /** Same texture, pixels redrawn by Mojang. */
  changed: ChangedTexture[];
  matched: number;
}

export interface WhatsNewView {
  diff: VersionDiff;
  /** Changed textures the pack has its own file for (when compared). */
  changed_in_pack: string[];
  millis: number;
}

// ---- Variety: random variants and connected textures (core/src/variants.rs, ctm.rs)

export interface BlockEntry {
  name: string;
  /** Built from parts: random variants are refused. */
  multipart: boolean;
  has_variants: boolean;
  in_pack: boolean;
}

export interface VariantChoice {
  weight: number;
  rotate: boolean;
}

export interface VariantView {
  n: number;
  texture: string;
  models: string[];
  weight: number;
  rotate: boolean;
  texture_in_pack: boolean;
}

export interface PreviewEntry {
  model: string;
  x: number;
  y: number;
  weight: number;
}

export interface VariantsInfo {
  block: string;
  legacy: boolean;
  keys: string[];
  textures: string[];
  texture: string | null;
  models: string[];
  original: VariantChoice;
  variants: VariantView[];
  has_rotations: boolean;
  base_from_pack: boolean;
  blockstate: string | null;
  preview_key: string;
  preview: PreviewEntry[];
}

export interface CtmTile {
  path: string;
  file: string;
  exists: boolean;
}

export interface CtmInfo {
  block: string;
  legacy: boolean;
  textures: string[];
  default_match: string;
  properties: string | null;
  properties_file: string;
  tiles: CtmTile[];
}

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  updateSettings: (patch: SettingsPatch) => invoke<Bootstrap>("update_settings", { patch }),
  forgetRecent: (path: string) => invoke<Bootstrap>("forget_recent", { path }),
  extractVersion: (dirName: string) => invoke<number>("extract_version", { dirName }),
  /** The pack's version compared with another one (extracted first if needed; cached per pair of jars). */
  whatsNew: (otherDirName: string, packDir: string) => invoke<WhatsNewView>("whats_new", { otherDirName, packDir }),
  clearCache: (dirName: string) => invoke<void>("clear_cache", { dirName }),
  createPack: (input: { name: string; version_dir: string; resolution: number; location: string }) =>
    invoke<PackState>("create_pack", { input }),
  openPack: (path: string) => invoke<PackState>("open_pack", { path }),
  importZip: (zip: string, dest: string) => invoke<PackState>("import_zip", { zip, dest }),
  closePack: () => invoke<void>("close_pack"),
  getPack: () => invoke<PackState>("get_pack"),
  updateProject: (patch: { name?: string; description?: string; also_export?: string[]; resolution?: number; pack_palette?: string[] }) =>
    invoke<PackState>("update_project", { patch }),
  loadTextures: () => invoke<{ rows: TextureRow[]; summary: PackSummary }>("load_textures"),
  textureDetail: (path: string) => invoke<TextureDetail>("texture_detail", { path }),
  inspectImage: (path: string) => invoke<ImageInfo>("inspect_image", { path }),
  importTexture: (path: string, source: string, frametime: number | null) =>
    invoke<ImportResult>("import_texture", { path, source, frametime }),
  openExternal: (path: string) => invoke<string>("open_external", { path }),
  /**
   * `packDir` is the pack the editor tab belongs to. Rust refuses when a
   * different pack is open, so a texture can never be read from or written
   * into the wrong pack while packs are being switched.
   */
  editorOpen: (path: string, packDir: string) => invoke<OpenedRaw>("editor_open", { path, packDir }),
  /** `flat` is every frame flattened and stacked vertically, base64 RGBA. */
  editorSave: (path: string, doc: RawDoc, flat: string, packDir: string) =>
    invoke<void>("editor_save", { path, doc, flat, packDir }),
  /**
   * The exact `.mcmeta` text a save would write for this animation (merged
   * with the pack's current file). Fails with kind "bad_frames" when the play
   * order uses a frame that does not exist.
   */
  animationMcmeta: (path: string, animation: Animation | null, times: (number | null)[], packDir: string) =>
    invoke<string>("animation_mcmeta", { path, animation, times, packDir }),
  /** A block model resolved for the 3D preview (the pack's model files win over the game's). */
  blockModel: (name: string, packDir: string) => invoke<BlockModel>("block_model", { name, packDir }),
  /** Models to offer for a texture: the cube (`name` ":cube") first, then block models using it. */
  modelsForTexture: (path: string, packDir: string) => invoke<ModelChoice[]>("models_for_texture", { path, packDir }),
  /** Scene: the blocks, each resolved to the models of its default state. */
  sceneBlocks: (ids: string[], packDir: string) => invoke<SceneBlock[]>("scene_blocks", { ids, packDir }),
  /** Scene: every block id that can be placed. */
  sceneBlockList: (packDir: string) => invoke<string[]>("scene_block_list", { packDir }),
  /** Scene: the custom scene saved in `.packcreator/scene.json` (`null` = none yet). */
  sceneLoad: (packDir: string) => invoke<SceneFile | null>("scene_load", { packDir }),
  sceneSave: (scene: SceneFile, packDir: string) => invoke<void>("scene_save", { scene, packDir }),
  /** Every particle of the pack's version (the pack's files win over the game's). */
  particleList: (packDir: string) => invoke<ParticleList>("particle_list", { packDir }),
  /** Copies the particle's last frame into a new image and appends it to the pack's particle file. */
  particleAddFrame: (id: string, packDir: string) => invoke<AddedFrame>("particle_add_frame", { id, packDir }),
  /** Every interface screen and piece for the pack's version, with status. */
  guiOverview: (packDir: string) => invoke<GuiOverview>("gui_overview", { packDir }),
  /** The exact `.mcmeta` text the pack would have with this stretch rule (`null` = no file). */
  guiScalingPreview: (path: string, scaling: Scaling, packDir: string) =>
    invoke<string | null>("gui_scaling_preview", { path, scaling, packDir }),
  /** Writes a sprite's stretch rule into the pack; returns the file before and after. */
  guiSetScaling: (path: string, scaling: Scaling, packDir: string) =>
    invoke<MetaChange>("gui_set_scaling", { path, scaling, packDir }),
  /** Undo: the pack's `.mcmeta` of a sprite exactly as it was (`null` removes it). */
  guiRestoreMcmeta: (path: string, text: string | null, packDir: string) =>
    invoke<void>("gui_restore_mcmeta", { path, text, packDir }),
  /** Any image file as raw RGBA, pixel-exact ("Import strip"). */
  readImageRaw: (path: string) => invoke<RawImage>("read_image_raw", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  saveShareList: (path: string, text: string) => invoke<void>("save_share_list", { path, text }),
  /** Matches every PNG of a folder (or dropped files and folders) to the pack's textures. Writes nothing. */
  batchScan: (paths: string[], packDir: string) => invoke<BatchScan>("batch_scan", { paths, packDir }),
  /** Imports accepted rows of the last scan; one result per item, failures do not stop the rest. */
  batchImport: (items: BatchItem[], packDir: string) => invoke<BatchItemResult[]>("batch_import", { items, packDir }),
  revertTexture: (path: string) => invoke<boolean>("revert_texture", { path }),
  setPackIcon: (source: string) => invoke<void>("set_pack_icon", { source }),
  editPackIcon: () => invoke<void>("edit_pack_icon"),
  runChecks: () => invoke<Check[]>("run_checks"),
  applyFix: (id: string) => invoke<string>("apply_fix", { id }),
  notesLoad: (packDir: string) => invoke<LoadedNotes>("notes_load", { packDir }),
  notesSet: (path: string, note: TextureNote, packDir: string) => invoke<TextureNote>("notes_set", { path, note, packDir }),
  textureHistory: (path: string, packDir: string) => invoke<HistoryVersion[]>("texture_history", { path, packDir }),
  restoreVersion: (path: string, id: string, packDir: string) => invoke<{ kept: string | null }>("restore_version", { path, id, packDir }),
  /** Every block with a block state file (game or pack). */
  varietyBlocks: (packDir: string) => invoke<BlockEntry[]>("variety_blocks", { packDir }),
  variantsInfo: (block: string, packDir: string) => invoke<VariantsInfo>("variants_info", { block, packDir }),
  /** Next random variant: texture copy, models and block state written; returns the new texture. */
  variantsAdd: (block: string, texture: string, packDir: string) =>
    invoke<{ info: VariantsInfo; texture: string }>("variants_add", { block, texture, packDir }),
  /** `n` 1 is the original. */
  variantsSet: (block: string, n: number, weight: number, rotate: boolean, packDir: string) =>
    invoke<VariantsInfo>("variants_set", { block, n, weight, rotate, packDir }),
  variantsRemove: (block: string, n: number, packDir: string) => invoke<VariantsInfo>("variants_remove", { block, n, packDir }),
  ctmInfo: (block: string, packDir: string) => invoke<CtmInfo>("ctm_info", { block, packDir }),
  ctmCreate: (block: string, texture: string, faces: string, matchBlocks: string, packDir: string) =>
    invoke<CtmInfo>("ctm_create", { block, texture, faces, matchBlocks, packDir }),
  ctmRemove: (block: string, packDir: string) => invoke<CtmInfo>("ctm_remove", { block, packDir }),
  exportPack: (request: { folder: boolean; install: boolean; only_changed: boolean; also: string[]; optimize_png?: boolean }) =>
    invoke<{ outputs: ExportOutput[]; pack: PackState }>("export_pack", { request }),
  /** Writes the showcase image (raw RGBA, base64) as a PNG; only .png paths. Returns the file size. */
  saveShowcase: (path: string, width: number, height: number, rgba: string) =>
    invoke<number>("save_showcase", { path, width, height, rgba }),
  /** Compares the open pack with a .zip or a folder. Writes nothing in either pack. */
  comparePacks: (source: string, packDir: string) => invoke<Comparison>("compare_packs", { source, packDir }),
  /** "Copy theirs into my pack" for rows of the last comparison (byte for byte, old files to the trash). */
  compareCopy: (ids: number[], packDir: string) => invoke<BatchItemResult[]>("compare_copy", { ids, packDir }),
  // drawing helpers: recolour a set, make variants, seams
  /** Before / after thumbnails of a recolour (the first 240 textures). Writes nothing. */
  recolorPreview: (paths: string[], op: Recolor, packDir: string) =>
    invoke<RecolorPreview[]>("recolor_preview", { paths, op, packDir }),
  /** Recolours and writes into the pack; replaced files go to the trash. */
  recolorApply: (paths: string[], op: Recolor, packDir: string) => invoke<WriteReport>("recolor_apply", { paths, op, packDir }),
  /** Takes a recolour (or variants) back; returns how many textures were put back. */
  recolorUndo: (report: WriteReport, packDir: string) => invoke<number>("recolor_undo", { report, packDir }),
  variantsPreview: (source: string, targets: string[], packDir: string) =>
    invoke<RecolorPreview[]>("variants_preview", { source, targets, packDir }),
  variantsApply: (source: string, targets: string[], packDir: string) =>
    invoke<WriteReport>("variants_apply", { source, targets, packDir }),
  /** Seams of one frame when it tiles (raw RGBA, base64). */
  seamMeasure: (width: number, height: number, rgba: string) => invoke<SeamReport>("seam_measure", { width, height, rgba }),
};

// ------------------------------------------------------ drawing helpers

export type Upscale = "nearest" | "smooth";

export interface Adjust {
  hue: number;
  saturation: number;
  brightness: number;
  contrast: number;
}

export interface MapPair {
  from: string;
  to: string;
}

export type Recolor = ({ kind: "adjust" } & Adjust) | { kind: "map"; pairs: MapPair[]; tolerance: number };

export interface RecolorPreview {
  path: string;
  /** PNG data URLs of the first frame. */
  before: string | null;
  after: string | null;
  in_pack: boolean;
  error: string | null;
}

export interface WriteReport {
  stamp: number;
  replaced: string[];
  created: string[];
  created_mcmeta: string[];
  failed: { path: string; message: string }[];
}

export interface SeamEdge {
  edge: number;
  /** Average difference between neighbours inside. */
  inside: number;
  /** Second largest difference between neighbours inside. */
  peak: number;
  seam: boolean;
}

export interface SeamReport {
  /** Last column against the first (left / right edge). */
  columns: SeamEdge;
  /** Last row against the first (top / bottom edge). */
  rows: SeamEdge;
}

/** Turns anything thrown by a command into a `CoreError`. */
export function toError(e: unknown): CoreError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as Partial<CoreError>;
    return { kind: o.kind ?? "error", message: String(o.message), hint: o.hint ?? null };
  }
  return { kind: "error", message: String(e), hint: null };
}

// Image URLs served by the Rust `pcimg` protocol (cache, open pack, last batch scan only).
const img = (path: string) => convertFileSrc(path, "pcimg");

export const images = {
  vanillaThumb: (dirName: string, tex: string) => img(`vanilla/${dirName}/thumb/${tex}`),
  vanillaFull: (dirName: string, tex: string) => img(`vanilla/${dirName}/full/${tex}`),
  packFull: (tex: string, stamp: number) => `${img(`pack/full/${tex}`)}?v=${stamp}`,
  packIcon: (stamp: number) => `${img("pack/icon")}?v=${stamp}`,
  /** A connected-texture tile by its editor path (`:optifine/ctm/glass/0`). */
  packOptifine: (editorPath: string, stamp: number) => `${img(`pack/optifine/${editorPath.replace(/^:optifine\//, "")}`)}?v=${stamp}`,
  recentIcon: (dir: string) => `${img("packicon")}?dir=${encodeURIComponent(dir)}`,
  /** A file of the last batch-import scan (small thumbnail). */
  batchThumb: (id: number, scan: number) => `${img(`batch/${id}`)}?s=${scan}`,
  /** An earlier version of the texture whose history was listed last. */
  historyVersion: (id: string, tex: string) => img(`history/${id}/${tex}`),
  /** The other pack's PNG of a row of the last comparison (full size). */
  compareTheirs: (id: number, stamp: number) => `${img(`compare/${id}`)}?s=${stamp}`,
};

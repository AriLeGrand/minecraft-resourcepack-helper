# Pack Creator — Design

Date: 2026-11-19
Status: approved direction (mockups validated by the project owner)
Replaces: the Aseprite plugin "Minecraft Resource Pack Helper" (Lua, this repository)

## 1. Intent

The current tool is an Aseprite plugin that extracts vanilla textures from the
Minecraft `.jar`, lets you pick a texture in a dropdown, opens it upscaled in
Aseprite and exports it to the right folder of a resource pack.

The owner wants to turn this "helper" into a **creator**: one professional
desktop application that makes building a Minecraft Java resource pack
**easier and faster for every pack maker**, whatever editor they use
(Aseprite is paid, so it can no longer be a requirement).

The app is **standalone**, includes its **own pixel-art editor strongly inspired
by Aseprite**, and can still hand a texture to an external editor.

### Pain points it must solve (from the owner)

1. Finding the right texture in a long dropdown; no preview of the original;
   no way to see which textures are already done.
2. Texture names and folders change between versions (e.g. `planks_oak` →
   `oak_planks` at 1.13, GUI split into `gui/sprites/` at 1.20.2); `pack_format`
   changes almost every release.
3. Animated textures are hard to make (vertical strip + `.mcmeta`).
4. `.mcmeta` files have no preview.
5. You must launch the game to see how a block looks in 3D.
6. Imported images get resized / animated strips get broken by the current plugin.
7. Interface (GUI) textures are hard to work on (many pieces, stretch rules).
8. Particles: you can't see them without the game; in old versions all
   particles share one sheet (`particles.png`) with other things, so you must
   only touch the right cells.
9. Custom 3D models — acknowledged, **deferred** (see non-goals).

## 2. Goals, non-goals, anti-goals

**Goals**
- Standalone desktop app (Windows first — most users launch Minecraft and
  Aseprite from Windows/Steam — plus macOS and Linux).
- Look and feel of a professional creative tool (see §6 Visual direction).
- Full Aseprite-class pixel editor for textures (layers, frames, all tools).
- Version-aware: correct folders, names and `pack_format` for every supported
  version; port a pack between versions.
- Live previews: tiled, 3D block, animation at in-game speed, particles, GUI.
- Works on files: everything ends up as a normal resource-pack folder or `.zip`.

**Non-goals (for now)**
- Editing 3D block/item models (that is Blockbench's job). Possible later
  integration: open a model's texture from Blockbench, or show models read-only.
- Bedrock Edition packs.
- Data packs, shaders (OptiFine/Iris), sounds, languages.

**Anti-goals (failure even if it "works")**
- Shipping or redistributing Mojang's vanilla textures. Vanilla assets are
  **only ever extracted from the user's own installed game `.jar`** at runtime
  and cached locally.
- Silently resizing or altering a user's imported image.
- Losing work: no texture switch / close / export may drop unsaved edits.
- A cluttered "hobby script" UI; a UI that only works for Aseprite owners.

## 3. Approaches considered

| Approach | Trade-offs | Decision |
|---|---|---|
| Keep and improve the Aseprite Lua plugin | Least work, live updates on every stroke, native timeline. But Aseprite-only (paid), limited dialog widgets, no real 3D, slow with thousands of thumbnails. | Rejected: the tool must serve every pack maker. |
| **Tauri 2 (Rust core + web UI)** | Rust does the heavy/file work; UI in TypeScript/HTML lets the mockups be built almost as drawn; three.js makes the 3D preview easy; small binaries, cross-platform. Cost: two languages. | **Chosen.** |
| Pure Rust GUI (egui + wgpu) | One language, very fast; but polished UI and the 3D preview are much more manual work. | Rejected. |
| Electron | Not Rust, much heavier. | Rejected. |

## 4. Technology (decided)

- **Shell:** Tauri 2, Rust stable.
- **Rust core** (suggested crates — builder may adjust): `zip` (read the game
  `.jar` directly — no more `unzip`/`tar` shell calls), `image` (PNG I/O),
  `serde`/`serde_json`, `notify` (watch files edited externally), `walkdir`,
  `directories` (app data/cache dirs), `thiserror`.
- **Front-end:** TypeScript + Vite. Framework is the builder's call; suggestion:
  React + a small store (e.g. Zustand). 3D previews with **three.js**.
  Pixel canvas: custom renderer on HTML canvas (textures are small: 16–512 px).
- Keep logic that must be correct (paths, versions, mcmeta, sheet cells) in Rust
  with unit tests; keep the UI thin.

## 5. Domain facts the app relies on

Builder: verify each against real game files before relying on it.
Verified in stage 0: see `docs/research/domain-facts.md`.

- Vanilla textures live in the client jar at `assets/minecraft/textures/...`.
  The jar is at `<.minecraft>/versions/<v>/<v>.jar`. Default `.minecraft`:
  Windows `%APPDATA%\.minecraft`, macOS `~/Library/Application Support/minecraft`,
  Linux `~/.minecraft`.
- Jars from 1.14 contain `version.json` with `pack_version` — read it instead
  of hard-coding. *(Corrected in stage 0, D-001:)* it is not one number: a plain
  number in 1.14–1.16, `{resource, data}` up to 1.21.8, and
  `{resource_major, resource_minor, …}` from 1.21.9. Older jars (e.g. 1.8.9)
  have no `version.json`: use the fallback table. From format 65 (1.21.9)
  `pack.mcmeta` uses `min_format`/`max_format` (D-005).
- Folder renames at 1.13 ("Flattening"): `blocks/`→`block/`, `items/`→`item/`,
  and many file renames (`planks_oak`→`oak_planks`, `grass_top`→`grass_block_top`, …).
  A **rename table between versions** is required data (research/build it; keep it as
  versioned JSON in the repo, with tests).
- GUI: from 1.20.2 most interface elements are separate sprites under
  `textures/gui/sprites/…`, with optional `<name>.png.mcmeta` containing
  `{"gui":{"scaling":{"type":"stretch"|"tile"|"nine_slice", ...}}}`
  (`tile`/`nine_slice` take `width`, `height`; `nine_slice` takes `border`).
  *(Corrected, D-003:)* `border` is a number or `{left, top, right, bottom}`;
  newer versions add `stretch_inner`; no file means "stretch".
- Animation: frames stacked vertically in one PNG + `<name>.png.mcmeta` with
  `{"animation":{"frametime":N,"interpolate":bool,"frames":[...]}}`.
  1 tick = 1/20 s. *(Corrected, D-004:)* `frames` is optional, entries may be
  `{index, time}` objects, `height`/`width` exist, and `.mcmeta` files may hold
  other sections (`texture`, `villager`) that must be kept.
- Particles: 1.14+ have one image per frame in `textures/particle/` plus
  `assets/minecraft/particles/<name>.json` (`{"textures":[...]}`) listing frames.
  Older versions use a single shared sheet `textures/particle/particles.png`
  (*corrected, D-002:* 128×128, a 16×16 grid of 8×8-pixel cells; the fishing
  bobber is on it too; explosion and footprint are separate files) where each
  particle owns fixed cells, some shared
  (e.g. generic smoke cells). The app must know each particle's cells per version
  and **only edit those cells**. A resource pack changes how particles look, not
  how they move — say so in the UI.
- GUI and entity textures are not square/16-based; the old plugin's separate
  "GUI/entity scale" concept must survive (per-category scale).

## 6. Visual direction (decided)

Dense, dark, professional creative-tool look. Reference mockups (in this repo,
`docs/mockups/*.dc.html`, and in the owner's private design canvas
"Texture Browser Mockups" → page "Standalone app"):

- Neutral greys (`#111214` app bg, `#18191c` bars, `#151619` panels,
  `#2a2b30` dividers), text `#ececf0` / secondary `#9b9ca4`.
- One accent blue `#5b8cff`; success `#3ecf8e`; warning `#f5a524`.
- Inter for UI (12–13 px), JetBrains Mono for paths/file names.
- One stroke icon style (1.6 px). Thin dividers, 6–10 px radii.
- Pixel art appears only in content (textures), never as UI decoration.
- Layout shell on every screen: top bar (breadcrumb, Ctrl+K command search,
  version chip, primary action) · left section bar (Home, Textures, Editor,
  Interface, Particles, Animation, Models (later), Pack & export, Settings) ·
  status bar.

The name "Pack Creator" is a placeholder.

## 7. Screens

Mockup file in brackets.

1. **Start** [`Welcome`] — create a pack (name, installed version with
   detected `pack_format`, resolution 16×–256×, location), recent packs with
   progress, installed versions (extracted or not), Open folder, Import `.zip`,
   Port to another version.
2. **Texture browser** [`Browser`] — chosen layout "B: list + compare".
   Categories with counts (Blocks, Items, GUI, Entities, Particles, Environment,
   Paintings, Mob effects, Armor, Misc). Status filter (All / To do / Done /
   Changed since export). Filters: animated, renamed in this version, wrong size.
   Table (thumbnail, name, size, animated, status, edited). Inspector: vanilla vs
   yours side by side, status, "used by" models, **name across versions**, actions
   Edit / Import image / Open externally / Revert. Search across all categories.
   Selecting a row only previews; Edit (or double-click) opens.
3. **Editor** [`AppEditor`] — Aseprite-inspired: tool column (rect select,
   lasso, magic wand, move, pencil, spray, eraser, eyedropper, bucket, gradient,
   line, curve, rectangle, ellipse, contour/polygon, shading ink, blur/jumble,
   text, hand, zoom; Aseprite-like shortcuts), tool options bar (size, ink,
   opacity, pixel-perfect, symmetry, tiled, onion skin), canvas with pixel grid,
   preview panel tabs **3D / Tiled / Original / Animated**, palette ("from vanilla"),
   layers incl. a locked semi-transparent **vanilla reference** layer, timeline.
   Undo/redo. Open-file tabs with unsaved markers.
4. **Animation** [`Animation`] — large frame view with onion skin, frame strip
   with per-frame duration, play/loop, new/duplicate frame, **import strip**,
   in-game preview (flat + 3D cube) at real speed, `.mcmeta` settings
   (frametime, interpolate, frame order), generated file shown; exported as one
   vertical strip.
5. **Pack & export** [`Export`] — icon (draw/import), name, description with
   `§` colour preview, main version + "also export for" older versions (auto
   rename), **checks with one-click fixes** (wrong size, frames without
   `.mcmeta`, old names, pack files), export `.zip`/folder, install into
   `.minecraft/resourcepacks`, only changed textures.
6. **Interface editor** [`GuiEditor`] — screens list (menus & buttons,
   inventory, HUD, title, recipe book, advancements, boss bars), pieces on the
   screen with status, assembled in-game preview at GUI scale 1×/2×/3×, select a
   piece by clicking it, stretch mode Stretch/Tile/Nine-slice with borders and a
   3-width preview, generated `.mcmeta`. Pre-1.20.2: one big GUI image per screen.
7. **Particle viewer** [`Particles`] — particle list, live scene (night / day /
   underwater, speed ¼×/1×/2×, your pack vs vanilla), particles only by default
   (source object optional). Two layouts: **1.12.2-style shared sheet**
   (`particles.png` shown with the selected particle's cells highlighted, "only
   this particle" view, edit only these cells, shared-cell warnings) and
   **1.14+ separate images** (frames + `particles/<name>.json`).

## 8. Behaviour rules

- Imported images are kept **pixel-exact**; a tall image whose height is a
  multiple of its width is offered as animation frames.
- Never close/switch away from a modified texture without Save / Discard /
  Cancel. (The old plugin has a bug here: choosing "Save and Export" while
  switching saves the *old* image under the *new* name — do not port that logic.)
- No modal popups for success; status bar / toasts instead. Errors may be modal.
- Settings, recent packs and per-pack state persist across restarts.
- Working files (layers, frames, editor state) live in a hidden folder inside
  the pack (suggestion: `.packcreator/`), excluded from export; the pack itself
  always contains plain flattened PNG + JSON.
- External editor link: "Open externally" launches the configured editor
  (Aseprite path or system default) on the PNG; the app watches the file and
  refreshes previews on save.
- Texture status: **Done** = file exists in the pack; **Changed since export** =
  working copy newer than last export; otherwise **To do**.

## 9. Build stages

Each stage ends usable and shippable.

1. **Foundation + browser** — Tauri app skeleton with the shell and visual
   system; detect `.minecraft`, list installed versions, extract textures from
   the jar in Rust into an app cache; read `pack_format` from the jar; create /
   open pack, recent packs, persisted settings; texture index + browser screen
   (search, categories, status, compare inspector); import image (pixel-exact);
   open externally + file watching; export to folder / `.zip` / resourcepacks with
   `pack.mcmeta` and `pack.png`; version data model + rename table (at least the
   1.13 Flattening) with tests.
2. **Pixel editor** — canvas, all tools, palette, layers, undo/redo, zoom/grid,
   tiled preview, vanilla reference layer, save to pack.
3. **Animation** — timeline, onion skin, playback, strip import/export, `.mcmeta`.
4. **Game previews** — 3D block preview (three.js, full cubes first, then model
   JSON shapes) and the particle viewer (both layouts).
5. **Interface editor** — GUI sprites, scaling `.mcmeta`, assembled screens.
6. **Later** — Blockbench link / read-only models, more checks, version porting UI.

## 10. Repository layout

- Build the new app in `app/` (Tauri project). Leave the existing Lua plugin
  (`main.lua`, `modules/`, `package.json`) untouched until stage 1 ships; it is
  reference for detection, version and folder logic.
- Specs in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`,
  mockups in `docs/mockups/`.

## 11. Left to the builder

- Front-end framework and state library; exact crate choices.
- Internal format of working files.
- Source and format of the rename table and per-version particle-sheet cell map.
- Exact `pack_format` handling for the newest versions.
- Packaging/installer and auto-update.

### Calls made during design (owner may revisit)

- Windows first; Tauri; three.js; React suggested.
- "Done" means "file exists in the pack".
- Particle viewer shows only particles by default.
- Interface and particle editors come after editor, animation and 3D preview.

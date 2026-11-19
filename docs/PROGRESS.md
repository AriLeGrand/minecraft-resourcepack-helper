# Progress

Read this first when resuming. Kickoff instructions: `docs/superpowers/kickoff-prompt.md`.
Design: `docs/superpowers/specs/2026-11-19-pack-creator-design.md`.
Decisions: `docs/DECISIONS.md`. Facts: `docs/research/domain-facts.md`.

## Current stage

**Stage 3: animation** — starting. Plan: `docs/superpowers/plans/stage-3.md`.

**Stage 2: pixel editor** — complete (2026-11-19). Plan: `docs/superpowers/plans/stage-2.md`.
Re-verified after the review fixes with real mouse/keyboard input in `tauri dev`:
pencil, undo/redo, rectangle, bucket, line, select + move, add layer, Ctrl+S
(pixels checked in the PNG on disk), close-tab Save/Discard/Cancel, reopen with
layers, frame stepping on a 6-frame texture, tiled mode. Screenshots:
`app/target/devdata/screenshots/5*-editor*.png`, `6-editor-tiled.png` (git-ignored).
Differences from the mockup that are intended: the bottom timeline and the 3D /
Animated preview tabs belong to stages 3 and 4.

Done so far in stage 2:
- `app/core/src/workfile.rs` (working files with layers and frames, pixel-exact
  raw RGBA open/save) and the commands `editor_open` / `editor_save` in
  `app/src-tauri/src/lib.rs` (plan steps 1-2, Rust part).
- `app/src/editor/pixels.ts` + `pixels.test.ts`: all pure pixel logic (inks,
  line, pixel-perfect, brush, rectangle, ellipse, polygon, curve, spray,
  symmetry, tiled wrap, flood fill / wand, gradient, blur, jumble, selection
  masks, copy/paste, layer compositing, palette, frames, base64). 38 tests pass.

- The editor UI (plan steps 2-11), all in `app/src/editor/` plus
  `app/src/screens/Editor.tsx`:
  - pure, tested modules: `doc.ts` (document: layers, frames, flatten, the
    vanilla reference), `history.ts` (undo / redo patches), `view.ts` (zoom and
    pan maths), `tools.ts` (the 20 tools), `shortcuts.ts`, `controller.ts`
    (pointer input → tool sessions → undo steps);
  - `editorStore.ts` (tabs, tool, options, colours, clipboard, open / save /
    close with Save / Discard / Cancel, reload when a file changes on disk);
  - browser-only: `render.ts`, `Canvas.tsx`, `Panels.tsx` (preview, palette,
    layers), `ColorPicker.tsx`.
  - "Edit texture" and double-click in the browser open the built-in editor;
    "Open externally" is unchanged. Ctrl+K lists the tools while a texture is
    open. Closing the pack, opening another pack and quitting ask about unsaved
    textures (`registerPackGuard` in `store.ts`, `onCloseRequested` in `App.tsx`).
  - Checked in the real app with real mouse and keyboard input
    (`tools/shot.mjs` has `--drag`, `--rdrag`, `--move`, `--wheel`, `--key`):
    open from the browser, draw, shapes, selection, move, copy / paste, layers,
    tiled mode, wheel zoom, text, gradient, bucket, spray, palette and colour
    picker, frames of an animated texture, save (PNG pixels checked on disk,
    `.mcmeta` kept), reopening with layers, the close-tab and quit questions,
    outside changes to open files, quitting with nothing unsaved.

- Review fixes (2026-11-19, D-034 to D-046): layer name / visibility / opacity
  as undo steps; a tool in progress is never loaded or closed over; all-or-nothing
  save with layers matched by content; the editor commands check their pack;
  tiled mode for every tool; onion skin; "Draw" for the pack icon in the
  built-in editor; palette refresh button; copy / paste / selection commands
  in Ctrl+K and the options bar; keyboard access (file tabs, colour picker,
  Enter / Space, Ctrl+S from fields); drawing work cut down (composite cache,
  one preview per screen refresh, strokes painted piece by piece).
  107 core tests and 206 front-end tests pass.

Not done in stage 2 (see D-032): adding / removing frames (stage 3), 3D and
Animated preview tabs (stages 3-4).

Stage 1 is complete (2026-11-19): installer built at
`app/target/release/bundle/nsis/Pack Creator_0.1.0_x64-setup.exe` (2.5 MB) and
the release build was run and checked (images, fonts, security policy).

## Done

- **Setup** (2026-11-19): git, Rust 1.99 (MSVC), Node 22 + npm, VS 2022 C++
  tools and WebView2 were already installed. Nothing had to be installed.
  Minecraft found in `%APPDATA%\.minecraft`; jars for 1.8.9, 1.20.1, 1.20.4
  (Fabric), 1.21.1, 1.21.5, 1.21.8, 1.21.11.
- **Stage 0** (2026-11-19): facts checked against the real jars
  (`docs/research/domain-facts.md`), design corrected (D-001…D-006), version
  data in `app/core/data/` (pack formats, rename table, particle sheet).
- **Stage 1** (2026-11-19):
  - `app/core` (pure Rust, 93 tests): `minecraft` (find game, list versions),
    `extract` (jar → cache, atomic), `textures` (categories, index, thumbnails),
    `mcmeta` (animation files), `pack` (create/open/scan/status), `import`
    (pixel-exact import, start from vanilla, trash), `export` (checks, fixes,
    zip/folder, install, copies for other versions, zip import), `rows`
    (browser list, name history), `settings`.
  - `app/src-tauri`: commands (`src/lib.rs`), `pcimg` image protocol
    (`images.rs`), file watcher (`watch.rs`).
  - `app/src`: shell (`components/Shell.tsx`), overlays (toasts, modal,
    Ctrl+K), screens `Welcome`, `Browser`, `Export`, `Settings`; pure helpers
    with tests in `lib/logic.ts`.
  - Verified in the real app: create pack, extraction with progress, list of
    3518 textures (35 rows in the DOM, ~10 ms per scroll frame), grid view,
    search, inspector, import (incl. frames), file watching, revert to trash,
    checks and fixes, export for 1.21.11 + 1.20.1 + 1.8.9 with renames,
    reopening the last pack after restart, no-Minecraft and read-only errors.

## Known issues / notes

- Drive C: has little free space (about 5 GB). Build output is on D:.
- No 1.12.2 / 1.13 jar installed: part of the rename table is not verified
  locally (D-006).
- `pack.mcmeta` for 1.21.9+ should be checked once in-game (D-005).
- "Install into Minecraft's resourcepacks folder" is covered by unit tests on
  a fake game folder only; it was deliberately not run against the real one.
- Debug builds extract slowly (about 25 s for 1.21.11); release builds are fast.
- The file `minecraft-resourcepack-helper..aseprite-extension` in the repo
  root is the owner's untracked build of the old plugin; leave it alone.
- Screenshots contain game textures: never commit them (D-018).

## How to run

```
cd app
npm install            # once
npm run tauri dev      # run the app (first build takes a few minutes)
npx tauri build        # Windows installer in target/release/bundle/nsis/
```

To drive the running app and take screenshots (developer only):

```
# Git Bash, from app/
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
export PACKCREATOR_CONFIG_DIR=$PWD/target/devdata/config PACKCREATOR_CACHE_DIR=$PWD/target/devdata/cache
npx tauri dev
# in another shell, from the repo root
node tools/shot.mjs --size 1440x900 --wait 500 --shot app/target/devdata/screenshots/x.png
```

## Checks before each commit that ends a step

```
cd app
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
npm run check          # typecheck + lint + vitest
```

## Research scripts (developer only)

```
python tools/research/inspect_jars.py > facts.json
python tools/research/compare_versions.py > renames-report.json
python tools/research/build_rename_table.py renames-report.json app/core/data/renames.json
```

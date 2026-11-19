# Progress

Read this first when resuming. Kickoff instructions: `docs/superpowers/kickoff-prompt.md`.
Design: `docs/superpowers/specs/2026-11-19-pack-creator-design.md`.
Decisions: `docs/DECISIONS.md`. Facts: `docs/research/domain-facts.md`.

## Current stage

**Stage 2: pixel editor** — in progress. Plan: `docs/superpowers/plans/stage-2.md`.

Done so far in stage 2:
- `app/core/src/workfile.rs` (working files with layers and frames, pixel-exact
  raw RGBA open/save) and the commands `editor_open` / `editor_save` in
  `app/src-tauri/src/lib.rs` (plan steps 1-2, Rust part). 101 core tests pass.
- `app/src/editor/pixels.ts` + `pixels.test.ts`: all pure pixel logic (inks,
  line, pixel-perfect, brush, rectangle, ellipse, polygon, curve, spray,
  symmetry, tiled wrap, flood fill / wand, gradient, blur, jumble, selection
  masks, copy/paste, layer compositing, palette, frames, base64). 38 tests pass.

Next (nothing of this exists yet): `editor/history.ts` (undo patches),
the editor store (tabs, document model built from `editor_open`), `Canvas.tsx`
(zoom, pan, grid, tool interaction), tool column and options bar, layers /
palette / colour picker / preview panels, save with Save / Discard / Cancel,
shortcuts, then wire "Edit texture" in `screens/Browser.tsx` (currently opens
the external editor) and the `editor` screen in `App.tsx` (currently a
placeholder). Then screenshots vs `docs/mockups/AppEditor.dc.html`.

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

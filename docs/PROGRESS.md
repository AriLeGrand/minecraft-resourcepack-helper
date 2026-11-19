# Progress

Read this first when resuming. Kickoff instructions: `docs/superpowers/kickoff-prompt.md`.
Design: `docs/superpowers/specs/2026-11-19-pack-creator-design.md`.
Decisions: `docs/DECISIONS.md`. Facts: `docs/research/domain-facts.md`.

## Current stage

**All stages complete** (2026-11-19). The project is feature-complete for the
kickoff scope; see `docs/LIMITATIONS.md` for known limits and the "later" list.

Release: `app/target/release/bundle/nsis/Pack Creator_0.1.0_x64-setup.exe`
(2.8 MB, built 2026-11-19). The release build was run against the demo game:
textures load through the image protocol, the editor opens, and the lazily
loaded 3D preview renders (WebGL) under the app's security policy.
Full test pass at release: cargo fmt / clippy clean, 147 Rust tests, 319
front-end tests, typecheck and lint clean.

Possible next steps (not started): the items in `docs/LIMITATIONS.md` "Later",
checking a 1.21.9+ pack in-game (D-005), opening a pull request to `main`.

Done in the final stage:
- `README.md` rewritten for Pack Creator (what it is, screens, install, quick
  start, where files go, building from source, the old plugin, not affiliated
  with Mojang / Microsoft). `docs/LIMITATIONS.md`: known limitations and the
  "later" list.
- `tools/demo/make_demo_minecraft.py`: builds a fake `.minecraft` (1.21.11 and
  1.8.9 "jars" whose every file is drawn or written by the script: textures,
  animations, GUI sprites with nine-slice files, old `widgets.png` /
  `icons.png` / `particles.png` sheets at the app's own rectangles and cells,
  particle JSON, block models). It reads no game file.
- README screenshots `docs/screenshots/*.png` (committed: demo content only,
  D-018) taken with the demo game, separate config and cache under
  `app/target/devdata/demo/`, pack "Deep Sea Pack" (1.21.11, 32×): start,
  texture browser, editor with the 3D stairs, animation, particles, interface
  (button redrawn in teal), pack and export (zip + 1.8.9 copy exported).
- The 3D preview (three.js) is loaded on demand (`editor/LazyBlockPreview.tsx`,
  `LiveTexture` moved to `editor/liveTexture.ts`): main bundle 383 kB instead
  of over 500 kB, no Vite size warning. Checked in `tauri dev`: editor 3D tab
  (cube, oak_stairs) and the Animation screen's cube.
- All checks pass: fmt, clippy, 147 Rust tests, typecheck, lint, 319
  front-end tests, `npm run build`.

To run the app on the demo game (Git Bash, from `app/`):

```
python ../tools/demo/make_demo_minecraft.py target/devdata/demo/.minecraft
# write target/devdata/demo/config/settings.json with "minecraft_dir" set to that folder
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
export PACKCREATOR_CONFIG_DIR=$PWD/target/devdata/demo/config PACKCREATOR_CACHE_DIR=$PWD/target/devdata/demo/cache
npx tauri dev
```

**Stage 5: interface editor** — complete (2026-11-19). Plan: `docs/superpowers/plans/stage-5.md`.
Decisions D-065 to D-071.

- Rust `app/core/src/gui.rs` (11 tests): read / write `gui.scaling`
  (stretch / tile / nine_slice, border number or sides, `stretch_inner`, every
  other key kept, stretch removes the section and an empty file), which rule
  applies with a pack (D-065), `set_scaling` / `preview` / `put_mcmeta` (Undo),
  `keep_vanilla_scaling` for new sprites; round trip over the 125 GUI `.mcmeta`
  files of the extracted versions (developer-only).
- `app/core/src/gui_screens.rs` (7 tests) + `core/data/gui_screens.json`
  (7 screens, 76 pieces, layouts) + `core/data/gui_regions.json` (widgets /
  icons / bars rectangles before 1.20.2; 120 version/rectangle pairs checked
  against the modern sprites' pixels, developer-only test; every piece path
  checked against the 1.21.11 index, developer-only test).
- Commands `gui_overview`, `gui_scaling_preview`, `gui_set_scaling`,
  `gui_restore_mcmeta` (all `own_pack`; stretch rules refused before 1.20.2
  and outside `gui/sprites/`); `editor_save` copies the game's rule for a new
  sprite.
- `app/src/gui/slice.ts` + `layout.ts` (30 tests, exact pixels): the game's
  stretch / tile / nine-slice drawing, GUI scale maths, hit-testing, layout
  placement. Editor: `rectRegion` / `openRect` (edit one rectangle of a shared
  image; 3 tests) next to the particle cells.
- `app/src/screens/Interface.tsx`: the screen as in the mockup.
- Checked in the real app (`tauri dev`, `tools/shot.mjs`): Deep Sea Pack
  (1.21.11) — all 7 screens drawn with the real sprites at 1× / 2× / 3×;
  button → Tile (file on disk = tile 200×20), Stretch (file removed on disk,
  warning that the game stretches the pack's PNG), Nine-slice (border 3 on
  disk), left border 6 (object border on disk) and back to 3; drew two lines on
  widget/button through "Draw this piece", saved, the lines show tiled across
  every button of the pause and title screens; drew button_highlighted (new in
  the pack) and its `.mcmeta` got the game's nine-slice. Legacy Test (1.8.9) —
  Buttons and hotbar / HUD icons, button selected, "Draw this piece" opened
  widgets.png limited to 0,66 200×20, strokes across the whole canvas, Ctrl+S;
  on disk 61536 pixels outside the rectangle byte-identical to the game's
  1.8.9 widgets.png, 0 changed, 656 of 4000 inside changed. Screenshots
  `app/target/devdata/screenshots/10-*.png` (git-ignored).

Known limits of stage 5:
- Layouts are approximations of the game's screens; text uses JetBrains Mono.
- Animated GUI sprites are drawn as their whole image (none of the listed
  pieces is animated).
- The width / height of a tile or nine-slice rule are not editable (always the
  piece's GUI size); only the borders and `stretch_inner` are.
- Legacy rectangles are checked against 1.20.1 and 1.8.9 only; versions in
  between are assumed to use the same places.

**Stage 4: game previews** — complete (2026-11-19). Plan: `docs/superpowers/plans/stage-4.md`.

**Part B: particle viewer** — done (2026-11-19). Decisions D-061 to D-064.
- Rust `app/core/src/particle_list.rs` (7 tests, synthetic files): the list
  for the pack's version (separate images from 1.14, the shared sheet before),
  status per particle, `write_frames` (only when the list changes, other keys
  kept), `add_frame`. Commands `particle_list` and `particle_add_frame`
  (checked with `own_pack`). `editor_open` enlarges the legacy sheet to the
  pack resolution like blocks.
- `app/src/particles/sim.ts` + `cells.ts` (14 tests): deterministic scene
  simulation, families, frame index over age / random, tints; cell maths.
- `app/src/editor/region.ts` (+ `region.test.ts`, 22 tests): "edit only these
  cells" — tools, fill, paste, move, delete and the eraser clipped; a save keeps
  every pixel outside the cells; banner in the editor, dimmed sheet outside the
  cells on the canvas; frame operations refused in that mode.
- `app/src/screens/Particles.tsx`: the screen as in the mockup (list with
  search, swatches and counts, scene Night / Day / Underwater, ¼× / 1× / 2×,
  Your pack / Vanilla, torch / block toggle, frames grid, Edit frames, Add
  frame, particle file; legacy: sheet with the cells highlighted, only this
  particle, shared-cell warning, Edit only these cells; the movement warning).
- Checked in the real app (`tauri dev`, `tools/shot.mjs`): Deep Sea Pack
  (1.21.11): 104 particles; smoke, flame, campfire_cosy_smoke, explosion,
  heart, enchant and bubble play with their real images; scenes, speeds,
  Vanilla, torch shown; Edit frames opened `particle/generic_7`, a drawn and
  saved frame made smoke "partly" done; Add frame on heart wrote
  `particles/heart.json` (heart, heart_1) and `heart_1.png` (byte copy of the
  game's heart.png). New pack "Legacy Test" (1.8.9, 16×) made through the app:
  35 particles (31 in 1.8.9), smoke shows cells 0–7 and the shared-with list,
  explosion its own 4×4 file; heart → Edit only these cells, strokes across the
  whole canvas, select all + Delete, a stroke in the cell, Ctrl+S. On disk:
  128×128, 16320 pixels outside cell 80 identical to the game's sheet, 0
  changed; 42 of the 64 cell pixels changed. Screenshots
  `app/target/devdata/screenshots/9-*.png` (git-ignored).

Known limits of Part B:
- Movement, sizes and tints are approximations per family, not the game's code.
- A legacy sheet particle counts as done when the pack has `particles.png`.
- The scene shows saved files; unsaved editor changes appear after saving.
- Particles without images (block, item, dust pillars…) show grey squares.

**Part A: 3D block preview** — done (2026-11-19). Decisions D-056 to D-060.
- Rust `app/core/src/models.rs` (11 tests, synthetic model files): resolves a
  block model (pack first, then the extracted game), parents with a depth
  limit, loop and missing-parent errors, texture merging and `#variable`
  chains, nearest `elements`, default UVs, face rotation / tint / cullface,
  element rotation, `ambientocclusion`, built-in models reported;
  `models_for_texture` (cube + models that use the texture, most useful
  first, at most 24). Commands `block_model` and `models_for_texture` (both
  checked with `own_pack`), wrappers in `app/src/lib/api.ts`. Checked against
  the real extracted folders once (not in the tests): all 2390 1.21.11 and
  1080 1.8.9 block models resolve without an error.
- `app/src/editor/blockMesh.ts` (+ 8 tests): face corners, UVs, face and
  element rotation, rescale, shade, tint colours.
- `app/src/editor/BlockPreview.tsx`: three.js 0.170.0 view with a model
  picker, drag / wheel / double-click, reset, light background; the edited
  texture comes live from the document (`LiveTexture`), the others from the
  pack or the game. Editor preview tab "3D" (default for block textures, a
  note for others); the Animation screen's CSS cube is replaced by it, fed by
  the existing player (`onPaint` in `Player.tsx`).
- Checked in the real app (`tauri dev`, `tools/shot.mjs`): block/oak_planks
  (cube, 24 models in the picker incl. stairs / slab / fence), drawing two
  lines showed on the block at once (then undone), stairs and fence turned
  by dragging, light background, grass_block_top (grass_block chosen, top and
  side overlay tinted green), short_grass (cross, cut-out, tinted), torch and
  wall_torch (tilted element), item/apple (Tiled by default, note on 3D),
  block/andesite in the Animation screen (cube and flat view change frame
  together, interpolation visible). Screenshots
  `app/target/devdata/screenshots/8-*.png` (git-ignored).

Known limits of Part A:
- No ambient occlusion, no cull-face removal, no blockstate rotations (the
  model as it is in the file), no item models; one biome colour (plains).
- The model list is not cached (about 150 ms per texture in a debug build,
  more on a slow disk); the picker shows only "Cube" until it arrives.
- Models from other namespaces (mods) are refused.

**Stage 3: animation** — complete (2026-11-19). Plan: `docs/superpowers/plans/stage-3.md`.
Decisions D-047 to D-055.
- Rust: `animation_mcmeta` (the exact `.mcmeta` a save writes, merged with the
  pack's file, "bad_frames" for an order using a missing frame),
  `read_image_raw`, vanilla `.mcmeta` round-trip test (steps 1-3).
- `app/src/editor/anim.ts` (+ `anim.test.ts`, 28 tests): play order, presets
  (in order / ping-pong / custom with `2:5` durations), timing (entry and image
  at a tick, loop or stop, loop length), the game's interpolation, durations per
  frame, frame operations that renumber the order, strip splitting.
- `history.ts`: frames commands (frames, layers, size, animation); editor store:
  new / duplicate / delete / move frame, frame duration, frame time,
  interpolate, frame order, import strip, each an undo step that marks the tab
  unsaved (`animStore.test.ts`, 8 tests).
- `app/src/editor/Player.tsx`: playback hook at 1 tick = 50 ms on
  requestAnimationFrame, painting canvases directly.
- `app/src/screens/Animation.tsx`: the screen as in the mockup (editable big
  frame with onion skin, toolbar, frame strip with durations, in-game preview
  flat + CSS cube, settings, generated file, status bar). Editor: "Open
  animation view" link and a working "Animated" preview tab.
- Checked in the real app (`tauri dev`, real mouse / keyboard via
  `tools/shot.mjs`): block/andesite (1 frame) → duplicate ×2, new frame, a
  different line drawn on each frame, ping-pong, frame time 3, interpolate,
  frame 2 at 6 ticks, an invalid custom order (error shown), playback timing
  sampled (3 / 6 tick entries at ~150 / ~300 ms), interpolated colours seen,
  loop off stops, import of synthetic strips (bad height refused, same size into
  the layer, other size asked then replaced, both undone), Ctrl+S: PNG on disk
  32×128 with the right line per frame, `.mcmeta` identical to the generated
  text; closed and reopened: 4 frames, order and durations back. Prismarine
  (6 frames) still opens. Screenshots `app/target/devdata/screenshots/7-*.png`.

Known issues / limits of stage 3:
- Durations of a ping-pong are kept by frame when the order is rebuilt; an
  import that replaces the size rebuilds a ping-pong without durations.
- After undoing back to the saved state the tab still counts as unsaved (as in
  stage 2).
- Frames are reordered with buttons, not by dragging.

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
- Screenshots contain game textures: never commit them (D-018). The only
  committed screenshots are `docs/screenshots/*.png`, taken with the demo game.

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

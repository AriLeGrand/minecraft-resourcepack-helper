# Decisions

Calls made while building, and corrections to the design document.
Newest at the bottom.

## Stage 0 (2026-11-19)

**D-001 · `pack_version` is not a single field.** The design says newer jars
contain a `pack_version` field. In real jars it is an object
(`{resource, data}`), and from 1.21.9 `{resource_major, resource_minor, …}`;
1.14–1.16 used a plain number. The core reads all three. Design §5 corrected.

**D-002 · Particle sheet geometry.** The design says "grid of 8×8 cells at 16×".
The real 1.8.9 sheet is 128×128: a 16×16 grid of 8×8-pixel cells. The
enchanting glyphs are cells 225–250 (the mockup shows 224–249). The fishing
bobber also lives on the sheet (cell 33). Explosion and footprint are separate
files. Design §5 corrected.

**D-003 · GUI scaling `border`.** It can be a number or an object with
`left/top/right/bottom`; newer versions add `stretch_inner`. Vanilla only
writes `nine_slice` files; no file means "stretch". Design §5 corrected. The
interface editor (stage 5) must offer four separate borders, as the mockup does.

**D-004 · Animation `.mcmeta` has more keys.** `height`/`width`, optional
`frames`, frame entries as objects, and non-animation sections (`texture`,
`villager`). The app must keep keys it does not edit. Design §5 corrected.

**D-005 · `pack.mcmeta` for 1.21.9+.** From format 65 the app writes
`min_format`/`max_format` (a number, or `[major, minor]` when the minor is not
0) and no `pack_format`. When a pack also targets older formats it writes
`pack_format` + `supported_formats` as well. This follows the Minecraft Wiki;
the client jar has no `pack.mcmeta` to compare with, so **please check once
in-game that a pack exported for 1.21.11 shows as compatible.**

**D-006 · Rename table sources.** Built by comparing pixels between the
installed 1.8.9 jar, the launcher's Programmer Art pack and the modern jars
(293 entries), plus 61 hand-set entries and 74 from the Minecraft Wiki for
textures added in 1.9–1.12 (no local jar to verify). The 1.14 and 1.17 steps
are from memory. Exact versions of the 1.21.2 / 1.21.4 / 1.21.9 steps are from
memory (the local jars only prove "between 1.21.1 and 1.21.5", etc.). Entity
texture reorganisations are out of scope. Installing 1.12.2 and 1.13.2 once
would let `tools/research/compare_versions.py` verify the rest.

**D-007 · Repository layout.** `app/` is a Cargo workspace: `app/core`
(pure Rust, no Tauri, all correctness-critical logic and data, fast tests) and
`app/src-tauri` (the desktop shell, thin commands). The UI is in `app/src`.

**D-008 · Version identity.** A version folder is identified by the `id` in
its jar's `version.json` when present (so Fabric/Forge profiles map to their
real game version), otherwise by a release number found in the folder name.
Snapshots that cannot be parsed are placed on the version line by their pack
format.

**D-009 · Research scripts are Python** (`tools/research/`, standard library
only). They are developer tools, not part of the app, and never write textures.

## Stage 1 (2026-11-19)

**D-010 · UI stack.** React 18 + Zustand + Vite 6 + TypeScript 5.6, plain CSS
with the design tokens as variables (`app/src/styles.css`). Fonts (Inter,
JetBrains Mono) are bundled so the app works offline. Versions are pinned to
ones known to work together rather than the very newest.

**D-011 · Images in the UI.** Textures are shown through a custom `pcimg`
protocol served by Rust. It can only read the vanilla cache, the open pack and
`pack.png` of recent packs, so the web view has no general access to the disk.

**D-012 · Thumbnails.** Small still textures are shown directly (the file is
the thumbnail). A separate thumbnail is only generated for animated strips
(first frame) and images larger than 64 px.

**D-013 · Extraction also keeps model, blockstate, particle and atlas JSON.**
Small files, needed for "used by" now and for the 3D and particle previews
later. Class files and everything else in the jar are never extracted.

**D-014 · "Edit texture" before the editor exists.** Until stage 2, "Edit
texture" and double-click open the texture in the external editor. The working
file starts as the game's texture enlarged to the pack resolution with hard
pixels (blocks and items only; GUI and entities keep their size).

**D-015 · Nothing the user made is deleted.** Revert, re-import and icon
replacement move the previous file to `.packcreator/trash/<time>/` in the pack.
Export refuses to replace a folder that is not a previous export.

**D-016 · "All textures" entry and wording.** The category list has an extra
"All textures" row. The filter "Renamed in this version" is labelled "Renamed
in other versions" (it lists textures whose file name differs in some other
version, which is what matters when porting).

**D-017 · "Port to another version" (start screen).** It opens the pack and
goes to Pack and export, where "Also export a copy for" does the renaming. A
dedicated porting screen is listed under "Later" in the design.

**D-018 · Screenshots are not committed.** Screenshots of the real app show
game textures, so they are saved under `app/target/devdata/screenshots/`
(ignored by git). README screenshots (final stage) must be taken with a
synthetic game folder.

**D-019 · Test hooks.** `PACKCREATOR_CONFIG_DIR` and `PACKCREATOR_CACHE_DIR`
point the app at scratch folders; `tools/shot.mjs` drives the real window
through the WebView2 debugging port.

**D-020 · Old names with the new folder are not auto-fixed.** A file such as
`block/grass_top.png` (old name, new folder) is reported as "not used by this
version" rather than renamed, because that path never existed in any version.

## Stage 2 (2026-11-19)

**D-021 · Pixels never pass through a browser canvas on their way to disk.**
The editor keeps every layer as raw RGBA in memory and sends raw RGBA (base64)
to Rust, which writes the PNG. Canvases are used for display only, because a
canvas stores colours multiplied by their transparency and would damage them.
A texture with one plain layer is saved byte-for-byte as it is in memory, even
colours hidden under full transparency.

**D-022 · Editor code layout.** Everything that decides pixels is pure
TypeScript with tests: `pixels.ts` (primitives), `tools.ts` (what each tool
does), `doc.ts` (layers, frames, flatten), `history.ts` (undo), `view.ts`
(zoom / pan maths), `shortcuts.ts` (key → action). `controller.ts` turns
pointer input, already converted to texture pixels, into tool sessions; it has
no DOM, so whole interactions (drag, undo, save, close) are tested against the
real stores with a fake Rust side. Only `render.ts`, `Canvas.tsx` and the
panels need a browser.

**D-023 · A document is never changed in place.** Every edit produces a new
document and replaces the layer image that changed. A tool in use only shows a
*preview*; the document changes once, when the mouse is released, as one undo
step. Undo keeps the smallest changed rectangle per frame and layer (before
and after), found by comparing with the image from the start of the stroke.
Layer add / delete / duplicate / reorder keep the layer list before and after.
The stack holds 200 steps. Not undoable: layer name, visibility, lock, opacity.

**D-024 · "Unsaved" and the three ways out.** A tab is unsaved after any
change of pixels, layers, layer name, visibility or opacity (a lock alone does
not count). Undoing back to the saved state still counts as unsaved (safe
side). Closing a tab, closing the pack, opening or creating another pack and
quitting ask Save / Discard / Cancel; Escape means Cancel; a failed save keeps
everything open. Just *looking at* the Home screen does not ask, because the
pack and the tabs stay open (the Editor button in the section bar shows an
orange dot while something is unsaved).

**D-025 · Saving can only ever write the document's own texture.** Each tab
remembers its texture path and the pack folder it came from. Save uses that
path, never "the texture on screen" (the old plugin's bug), and refuses when a
different pack is open. `enterPack` now takes the "open / create the pack"
step as a function, so the question about unsaved work is asked *before* Rust
switches packs.

**D-026 · Vanilla reference layer.** It is the first frame of the game's
texture, enlarged with hard pixels to the document size, drawn at 30% under the
drawing. It is not a layer of the document at all, so it cannot end up in the
saved texture. Hidden by default (as in the mockup), one click on its eye
shows it. The eyedropper reads it when the drawing is empty at that pixel.

**D-027 · Alt.** Alt+click picks a colour with every drawing tool. On the
three selection tools Alt means "take away from the selection" (Shift adds),
and on the Zoom tool it zooms out. A plain click with Rectangle select or
Lasso clears the selection.

**D-028 · Moving and pasting.** Moved or pasted pixels stay "lifted": as long
as nothing else is done, the Move tool keeps moving them without damaging what
is under them. Any other edit puts them down. Paste switches to the Move tool
and lands where the pixels were copied from. The clipboard is the app's own
(shared between tabs), not the Windows clipboard.

**D-029 · Tool details that the design left open.**
- Curve: drag the line, then move the mouse to bend it and click to fix it.
- Contour / polygon: drag = freehand outline closed on release; single clicks
  = corners, closed with Enter, a double click or a click on the first corner.
  Escape drops a half-made shape; switching tool, saving or undo finishes it.
- Blur / jumble: one tool, the mode is chosen in the options bar.
- Shading: the Shading tool, or ink "Shading" on the pencil. Left button
  lightens, right button darkens, 10% per stroke.
- Spray keeps adding dots while the button is held still.
- Text is drawn by the browser on a scratch canvas, then every pixel at least
  half covered becomes one hard pixel in the current colour (JetBrains Mono,
  height set in the options bar). This is the one place a canvas feeds pixels,
  and it only decides "ink or no ink".
- Shift while dragging: square / circle, lines in 45° steps.
- Extra options appear in the options bar only for the tools that use them
  (Filled, Touching only, Tolerance, Mode, Text height).
- Extra shortcuts: Ctrl+0 fit, ← / → previous / next frame, Enter / Escape
  finish / drop the shape in progress.

**D-030 · Palette.** A new texture gets the colours of the game's texture
("From vanilla", up to 48, most used); "From image" takes them from the
drawing. The palette is stored in the working file with the layers. Changing
it does not count as an unsaved change.

**D-031 · Files changed by another program.** After each refresh from the file
watcher, an open tab whose PNG changed on disk is loaded again if it has no
unsaved edits; a tab with unsaved edits keeps them and a warning says that
saving will replace the file. The editor's own save is not mistaken for an
outside change.

**D-032 · Not in stage 2.** "Draw" for the pack icon still opens the external
editor (the icon is not a texture path; the editor commands only open
textures). Onion skin is a stored option without effect until the animation
stage. The 3D and Animated preview tabs are shown disabled. Frames can be
edited one by one (previous / next) but not added, removed or retimed until
stage 3.

**D-033 · Window close permission.** Asking before quitting needs the web view
to close the window itself afterwards, so the capability
`core:window:allow-destroy` was added. Nothing else was opened up.

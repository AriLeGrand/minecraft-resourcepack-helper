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
The stack holds 200 steps. Not undoable: a layer's lock (see D-034 for name,
visibility and opacity, which became undo steps after the review).

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

**D-032 · Not in stage 2.** The 3D and Animated preview tabs are shown
disabled. Frames can be edited one by one (previous / next) but not added,
removed or retimed until stage 3. ("Draw" for the pack icon and the onion skin
were first left out too; both were added after the review, see D-039 and
D-040.)

**D-033 · Window close permission.** Asking before quitting needs the web view
to close the window itself afterwards, so the capability
`core:window:allow-destroy` was added. Nothing else was opened up.

## Stage 2 review fixes (2026-11-19)

**D-034 · Layer name, visibility and opacity are undo steps.** They change
what is saved, so each change is one step ("Rename layer", "Hide layer",
"Layer opacity"). Opacity changes on the same layer less than a second apart
are one step (one drag of the slider). A lock stays editor state: it is not a
step, and undo / redo of other steps keep the lock a layer has now.

**D-035 · A tool in the middle of its work counts as unsaved.** Before the
editor decides whether a tab "has no unsaved edits" (a file changed on disk,
cut, save, close), the stroke, shape or text in progress is finished first. A
refresh that does not concern the tab's file leaves the tool alone. When
something is drawn while the answer "Save" is still being written, the
question is asked again instead of closing over it.

**D-036 · Saving is all-or-nothing.** The PNG, the `.mcmeta` and the working
file are all written to temporary files first; only then are they renamed
over the old ones (a rename replaces the old file, nothing is deleted first).
The old working file is set aside until the PNG is in place and is put back
when that fails. A rename that is refused is tried again for a moment (virus
scanners). Temporary files are removed on every failure.

**D-037 · Layers belong to a PNG by its content.** The working file records a
fingerprint (FNV-1a, 64 bit) of the flattened PNG next to its size and time.
Same size and time: accepted at once. Same size, other time (the pack was
copied, restored, synced, checked out): accepted when the fingerprint matches.
Layers that do not belong to the PNG on disk are moved to
`.packcreator/trash/<time>/` by the next save instead of being overwritten.

**D-038 · The editor commands name their pack.** `editor_open` and
`editor_save` get the pack folder the tab belongs to and refuse, under the
state lock, when another pack is open. A tab is labelled with the folder that
was noted before the file was read.

**D-039 · The pack icon in the editor.** "Draw" on the export screen opens
`pack.png` on an editor tab under the reserved name `:pack-icon` (not a valid
texture name, so it cannot collide). Its layers are kept in
`.packcreator/icon.work.json`. A pack without an icon gets an empty 64×64
image; nothing is written until it is saved. "Open externally" is still there.
The icon is not in the texture list, so a change of `pack.png` by another
program while it is open in the editor is not noticed.

**D-040 · Onion skin.** With the option on, an animated texture shows the
frame before and the frame after (the first and last frame are neighbours:
animations loop) at 25% under the drawing. Display only: never saved, never
picked by the eyedropper.

**D-041 · An animation whose height is not a whole number of frames is not
opened.** Saving writes whole frames only, so the leftover rows would be cut
off without a word. The error says the size and what to correct.

**D-042 · Tiled mode wraps every tool.** Blur, jumble, the bucket, the wand
and the eyedropper treat the edges as joined, like the brush already did.

**D-043 · Moved pixels carry their selection.** The lifted pixels keep the
selection they were lifted with (at their own size). What is shown and
committed is cut to the image, but the lifted selection stays whole, so moving
a selection over the edge and back brings all of it back.

**D-044 · Shading keeps greys grey.** Lighten / darken work on unrounded
hue / saturation / brightness, leave the saturation of a grey at zero and
change nothing at all when the step is zero.

**D-045 · Drawing cost.** The layers are put together again only when
something that shows has changed (pointer moves, panning and zooming reuse the
last result). While a tool is dragged the preview is worked out once per
screen refresh; brush, eraser, shading, spray and blur strokes only paint the
new piece (1-pixel pixel-perfect lines and jumble are drawn again from the
start, which is cheap). The side preview follows with low priority.

**D-046 · Keys and focus.** A slider owns the arrow keys. A button, checkbox
or tab that was reached with the keyboard owns Enter and Space; after a mouse
click they stay with the editor (Space pans, Enter finishes a shape). Ctrl+S
works from any field (the field is left first, which applies its value).
Number fields apply on Enter or when left, Escape puts the old value back.
Copy, cut, paste and the selection commands are also in Ctrl+K and, with the
selection and Move tools, in the options bar.

## Stage 3

**D-047 · Where durations live.** While the play order is "every frame in
order" (no `frames` list), a frame's own duration is stored with the frame
(Rust turns per-frame times into a `frames` list on save). As soon as there is
an explicit list, durations live on its entries and the frames' own times are
cleared, because Rust ignores them then. Switching between the two carries the
durations over (list → in order: each frame takes its first entry's time). The
duration shown under a thumbnail is that of the frame's first entry; changing
it changes every entry of that frame.

**D-048 · Frame operations keep the play order consistent.** Inserting or
deleting a frame renumbers the entries; deleting removes that frame's entries
and an order left empty becomes "in order" (`null`). A custom order plays a new
frame right after the last entry of the frame before it. A ping-pong order stays
a ping-pong (it is built again for the new count, durations kept by frame).
Moving a frame in a custom order keeps every entry pointing at the same
picture; with "in order" or ping-pong the strip order is the play order.

**D-049 · New animations.** A still texture that gets a second frame (new,
duplicate, import) gets `{"frametime": 2}` as in the design. Deleting back to
one frame keeps the animation (the `.mcmeta` is still written); a still image
without an animation shows no settings and gets no `.mcmeta`.

**D-050 · Frame order is typed as in the file.** The chips and the custom field
count from 0, like `animation.frames` (thumbnails are numbered from 1, and the
tooltips say both). `2:5` means frame 2 for 5 ticks. The list is checked against
the frame count while typing; Apply is only possible when it is valid. Presets:
In order, Ping-pong (0..n-1 then n-2..1), Custom.

**D-051 · Playback.** The preview runs on `requestAnimationFrame`, 1 tick =
50 ms, and paints its canvases directly (no React render per frame; the "frame
N / M" label and the lit order chip are changed in the DOM). Interpolation is
the game's: per whole tick, colour = trunc(d·current + (1−d)·next) with
d = 1 − sub/ticks, alpha of the current frame, the last entry blends into the
first. Paused, the preview shows the frame being edited. "Loop" off stops on the
last entry (the game always loops). Playing only affects the preview: the big
frame stays on the frame being edited, which can be drawn on with the editor's
current tool at any time. The 3D cube is CSS only; the real 3D view is stage 4.

**D-052 · Import strip.** The file is read pixel-exact by Rust
(`read_image_raw`). An import bar shows the frame height (default: the image
width; the texture's own frame height when the width matches and the width does
not divide the height) and refuses heights that are not a whole number of
frames, with the size and what to change. Frames of the texture's size go into
the active layer of frames 0..k-1 (frames are added when the strip has more;
extra frames of the texture are kept). Frames of another size replace all frames
and layers (one layer "Imported") only after a question; nothing is ever
resized. Either way it is one undo step and nothing is written until save.

**D-053 · Frame changes as undo steps.** A new command kind stores the frames,
layers, size, animation and current frame before and after (pixel buffers
shared, not copied). Undo keeps current layer locks (as for layer steps) and
fits the view again when the size changed. Deleting a frame with pixels asks
first (like deleting a layer).

**D-054 · Animation screen works on the editor's tab.** Same document, same
history, same Save / Discard / Cancel guards; the pack icon cannot be animated
(the screen says so). The generated file is the text of `animation_mcmeta`,
refreshed 120 ms after a change, with Rust's error shown when it refuses.

**D-055 · Development hook for Import strip.** The native file dialog cannot be
driven by `tools/shot.mjs`, and Tauri's `invoke` cannot be replaced from the
page. In development builds only, `window.__packCreatorDev.importStrip(path)`
runs the import from a path (the same code after the dialog). It is not in
release builds.

## Stage 4

**D-056 · Block models are resolved in Rust.** `core/src/models.rs` reads the
model files (the pack's `assets/minecraft/models/` first, then the extracted
game folder), follows `parent` (at most 32 steps, loops and missing parents
are refused with the chain in the message), merges `textures` from the root
down (children win), takes `elements` from the nearest model that has them and
follows `#variable` chains to texture paths without `minecraft:`. Faces
without `uv` get the game's default from `from` / `to`; face rotation is
rounded to 0/90/180/270; `tintindex` < 0 counts as none. Names may be
`minecraft:block/x`, `block/x` or a bare `x` (taken as `block/x`); other
namespaces are refused. A chain ending in `builtin/…`, or one without any
elements (chests, beds, signs in 1.21), is reported in `builtin` and drawn as
the plain cube with a note.

**D-057 · Which models are offered.** "Cube" always comes first. Then every
block model file (pack and game, the pack's wins by name) whose text contains
the texture's file name is resolved, and kept when one of its faces uses the
texture (a texture used only as `particle` does not count). Order: the block
named like the texture (also `planks_oak` ↔ `oak_planks` for 1.8.9), then
stairs, slab, wall, fence, pane, everything else; corner and part variants
(`_inner`, `_outer`, `_top`, `_post`, `_side`, 1.8.9 `_n` / `_ne`…) after all
of those; at most 24. The scan takes about 150 ms in a debug build for
1.21.11 (2390 files) and is not cached.

**D-058 · 3D preview drawing.** three.js 0.170.0 (pinned, bundled by Vite, no
network). Geometry is built in `editor/blockMesh.ts` (pure, tested): face
corners in the game's orientation, UVs per corner, face rotation clockwise,
element rotation about its origin with `rescale` = 1/cos(angle) on the two
other axes, shade per face direction (up 1.0, down 0.5, north/south 0.8,
east/west 0.6, none with `shade: false`). Colours are passed through without
colour management (texture `NoColorSpace`, linear output), so a pixel shows as
the game would before lighting. Nearest filtering, no mip-maps, `alphaTest`
0.1 with blending for translucent pixels. Faces with no area are dropped.
Tinted faces get the plains colours: grass #91BD59, leaves and vines #77AB2F,
birch #80A755, spruce #619961, water #3F76E4, lily pad #208030. Orthographic
camera, drag to turn, wheel to zoom, double-click or the reset button to go
back, light / dark background (kept for the session). The scene is drawn only
when something changes; GPU objects are freed when the model changes and the
WebGL context when the view goes away. No ambient occlusion and no cull-face
removal (one block alone shows all its faces).

**D-059 · Live textures.** The texture being edited comes from the document:
the editor's 3D tab gets the current frame with visible layers (the same
deferred composite the other preview tabs use) through a `LiveTexture` canvas
that the three.js texture re-uploads (`needsUpdate`, a new GPU texture only when
the size changes). Other textures of the model come from the pack when it has
the file, else from the game (first frame of a strip). In the Animation screen
the 3D view takes the pictures the existing player paints (`onPaint` in
`Player.tsx`), so the cube plays on the same 50 ms tick clock, interpolation
included.

**D-060 · Where 3D shows.** The editor's preview tab is chosen
automatically until one is clicked: 3D for block textures (`block/…`,
`blocks/…`), Tiled for everything else; a non-block texture on the 3D tab shows
a short note. The model shown first is the most useful model of the list (the
block of the same name, so grass_block for grass_block_top); the Animation
screen starts with the plain cube. The pick is remembered per texture for the
session. The Animation screen's CSS cube is gone; non-block textures show only
the flat preview there.

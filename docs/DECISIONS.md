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
(shared between tabs); since D-076 copies also go to the Windows clipboard.

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

**D-061 · Particle list.** `core/src/particle_list.rs`. 1.14 and newer: every
`particles/<id>.json` of the game and of the pack (the pack's file wins, a
pack-only id is listed too); frame names lose `minecraft:` and live in
`textures/particle/`; names from another namespace are listed as "skipped" and
left alone. Status per particle: done when the pack has every frame image,
partly when some. A broken JSON file in the pack is an error that names the
file. 1.13.2 and older (`ParticleSheet::applies_to`): every particle of the
sheet map plus the particles with their own file (explosion, footstep);
particles added in a later version are listed but dimmed and not counted. A
sheet particle counts as done when the pack has `particles.png` (the sheet is
one file; the app cannot tell which cells were redrawn).

**D-062 · Particle files are written only when the frame list changes.**
`write_frames` merges into the file that applies now (the pack's, else the
game's), keeps every other key and their order, and writes nothing when the
list is the same. "Add frame" copies the last frame (the pack's image, else the
game's) to the next free name (`generic_7` → the next number no file uses,
`heart` → `heart_1`) and appends it; if the list cannot be written the new
image is removed again.

**D-063 · "Edit only these cells".** The editor tab gets a fixed region (the
particle's cells, scaled to the sheet's real size; the sheet must be one square
image whose width is a multiple of 16). Three guards: the tools' mask is the
user's selection limited to the region (`editMask`, also what Move lifts);
every pixel change (`applyEdit`, the live preview) is clipped back to the
pixels outside the region; and a save writes the flattened sheet with every
pixel outside the region taken from the sheet as it was when the mode began
(so hidden layers or layer opacity cannot change other particles either).
Frame operations are refused in this mode (the sheet is one image). A banner
names the particle, its cells and the particles that share them, with "Edit
the whole sheet" to leave the mode. When the pack has no `particles.png` the
game's sheet is the start, enlarged to the pack resolution with hard pixels
(the sheet now follows the pack scale like blocks and items; other particle
textures keep their own size).

**D-064 · Particle scene.** `src/particles/sim.ts`, pure and deterministic
(mulberry32 RNG, fixed-step `step(state, family, dt, speed)`). Movement presets
per family chosen from the id (smoke, campfire, flame, drip, splash, bubble,
inward, burst, float, spark, drift, generic), clearly approximate. Images are
the real ones: the pack's file when "Your pack" is shown and the pack has it,
else the game's; for old versions the cells are cut from the sheet (or the 4×4
grid of `entity/explosion.png`). Frames: "age" uses the game's sprite-set rule
`index = age × (n − 1) / lifetime`; "random" keeps one image picked at birth
(enchant, portal, splash, rain, nautilus… and the sheet map's `random`).
Some ids get the game's colour tint (grey smoke, purple portal, blue water
drops), drawn by multiplying the image. Nearest-neighbour drawing, at most 120
particles. The layout follows the pack's version; the mockup's "Pack" toggle is
shown read-only. "Save to pack" in the top bar shows only when an editor tab of
this particle's images has unsaved changes.

## Stage 5

**D-065 · Which `.mcmeta` the game reads for a sprite.** The game looks for a
sprite's `.mcmeta` in the packs from the top down to the pack that provides
the PNG. So a pack's `.mcmeta` alone overrides the game's one, but a pack PNG
without its own `.mcmeta` is **stretched** (the game's nine-slice below it is
never read). `core/src/gui.rs::effective` reports the rule that applies and
where it comes from (pack file / pack PNG only / game); the screen warns when a
pack PNG lost the game's nine-slice this way.

**D-066 · Writing stretch rules.** `gui.scaling` is rebuilt in the game's key
order (`type`, `width`, `height`, `border`, `stretch_inner`), unknown keys in
`scaling` and `gui` and every other section are kept. Four equal borders are
written as one number (as the game does); `stretch_inner` is written when on,
or kept when the file already had the key. "Stretch" removes the section, and
the file when nothing is left; but when the pack does not have the PNG and the
game's rule is not stretch, `{"type": "stretch"}` is written instead, since an
absent section would let the game's file decide. When the pack has neither the
file nor the PNG, the base for the new file is the game's file (so its other
sections, e.g. an animation, still apply), and a result equal to the game's
file is no file at all. Width and height are always the piece's GUI size (the
game's rule, else the game's image size), never the pack image's pixels.
Rules that cannot work (borders wider than the sprite, sizes outside 1–4096)
are refused in Rust.

**D-067 · Stretch rules are saved at once, with Undo.** Choosing Stretch / Tile
/ Nine-slice, ticking "stretch the inside" or leaving a border field (blur or
Enter) writes the `.mcmeta` immediately; the toast says what happened
(written / updated / removed) and has Undo, which puts the exact previous text
back (or removes the file). While a border is typed the preview and the
generated file follow it as a draft; Escape drops it. So there is never unsaved
layout work to lose, and "Save to pack" in the top bar is shown only when an
editor tab of one of this screen's pieces has unsaved pixels (as on the
Particles screen). Revert = back to the game's own rule for the piece (also
with Undo); it never deletes the pack's image.

**D-068 · A new sprite keeps the game's rule.** When a save in the editor
first adds `gui/sprites/…png` to the pack and the pack has no `.mcmeta` for it,
the game's `gui` section is copied (`gui::keep_vanilla_scaling`, called from
`editor_save`). Without it, drawing a button would make the game stretch it.

**D-069 · Screens and layouts are data.** `core/data/gui_screens.json` lists 7
screens (76 pieces) with a simple layout in GUI pixels: the pause menu of the
mockup, a chest + survival inventory, the HUD, the title screen, the recipe
book, advancements and boss bars. They are faithful-looking approximations of
the game's positions, not every screen. Layout items can draw a part of a
texture as it is (`src`, like the game's partial draws: the experience and
boss bar fill, the containers), a background tiled (`draw: "tile"`), a
texture whose units differ from its pixels (`tex`: the logo), and a `normal`
piece shown when "Show hover states" is off. Pieces outside `gui/sprites/`
(containers, the logo, the advancements window) have no stretch rule. Text is
drawn with JetBrains Mono, not the game's font.

**D-070 · Drawing like the game.** `src/gui/slice.ts` follows the game's
`blitSprite` / `blitTiledSprite` / `blitNineSlicedSprite`: borders cut to half
the target when it is small, a target as wide (or tall) as the sprite keeps
that direction whole, edges and centre tiled from their top-left corner with
the last tile cut (stretched with `stretch_inner`), nearest sampling at pixel
centres, an image larger than its GUI size read at its density. The preview is
composited in a pixel buffer at GUI scale 1–3 (source-over), then text and
outlines on the canvas. Click picks the topmost piece whose pixel is not
transparent there (else the topmost rectangle); double-click opens it in the
editor. The mockup's nine-slice help said edges "stretch"; by default the game
repeats them, so the text says "fill" and the stretch-inside box explains it.

**D-071 · Before 1.20.2: rectangles of shared images.**
`core/data/gui_regions.json` holds 15 pieces of `gui/widgets.png`, 43 of
`gui/icons.png` and 22 of `gui/bars.png` (1.9+). 80 of them were found by
searching the 1.21.11 sprites' exact pixels in the 1.20.1 and 1.8.9 images
(`tools/research/find_gui_regions.py`), and a developer-only test checks those
120 version/rectangle pairs again; the two language-button rectangles come from
the game's drawing code. Sliders reuse the button images then (track =
disabled button, knob cut from the button), so they are not separate pieces.
The screen lists the images as screens, shows the shared image with the
selected rectangle (the rest dimmed), and "Draw this piece" opens the image in
the editor's region mode limited to that rectangle (scaled when the pack's
image is a whole multiple of 256; any other size opens unrestricted with an
explanation). A shared image in the pack counts as done for all its pieces.
There are no stretch rules before 1.20.2: the panel says so, and the Rust
commands refuse them for such packs.

## Final stage

**D-072 · Demo game for README screenshots.** `tools/demo/make_demo_minecraft.py`
draws a fake `.minecraft` (1.21.11 and 1.8.9) entirely from code: no game file
is read, copied or traced. It reads only the app's own position tables
(`particle_sheet.json`, `gui_regions.json`) to put old-sheet pieces in the
right places. Screenshots taken with it (`docs/screenshots/`) are the only
committed screenshots (D-018 still holds for everything else).

**D-073 · three.js is loaded on demand.** The 3D view is imported lazily
(`editor/LazyBlockPreview.tsx`); `LiveTexture` lives in its own file so the
editor and Animation screen do not pull three.js into the main bundle. The
first 3D view shows an empty box for a moment while the chunk loads.

## After the final stage (2026-11-20)

**D-074 · Sharing the to-do list.** The texture browser's "Share list" turns
the texture list (with its To do / Done status) into text: a Markdown
checklist (ticks render in Discord, GitHub, Notion, Obsidian), plain text, or
CSV for spreadsheets; for the current view (category, search and filters) or
the whole pack; finished textures listed as ticked or left out. It is copied
or saved as a file; there is no online sharing or live sync (that would need
an account and a server). Copy uses Tauri's clipboard plugin: the browser
clipboard API is refused when the window is not focused, and an earlier
version then wrongly reported success. Saving goes through Rust
(`core/src/share.rs`), which only writes `.md`, `.txt` or `.csv` files.
Formatting is pure TypeScript (`src/lib/share.ts`, tested), since it is
presentation, not pack data.

**D-075 · Batch import: matching rules, review, and what it may read.** A
folder (or files and folders dropped on the browser) is scanned in Rust
(`core/src/batch.rs`): PNG files only, hidden folders and the pack itself left
out, at most 5000 files. The target is decided in this order: a path containing
`assets/minecraft/textures/` (a pack or an export), then a texture path inside
the relative path (`block/x.png`, `blocks/x.png`, `gui/…`; the first folders
are those of the version's names), then the file name against the version's
texture list (unique = match, several = the user picks). Old and newer names
come from the rename table: every texture's `history` gives the names it had in
other versions, so `planks_oak.png` finds `block/oak_planks` in a 1.21 pack and
`item/red_dye.png` finds `items/dye_powder_red` in a 1.8.9 pack ("renamed
from …"). Each row has a status (new, replaces, same pixels, unknown, choose)
plus warnings (duplicate target, wrong size for the pack resolution, frames?).
"Same pixels" compares decoded pixels, not bytes, and is unticked by default;
two files for one texture start unticked and ticking one unticks the other.
Importing copies each PNG byte for byte through `import::import_image` (never
resized), copies a `<name>.png.mcmeta` next to it byte for byte, moves replaced
files (PNG and `.mcmeta`) to `.packcreator/trash`, skips files identical to
the pack, and carries on after a failure with one result per file. A texture
with unsaved changes in an editor tab is never replaced: the row is skipped and
the reason shown. The scan's file list is kept in Rust: `batch_import` only
takes row ids of the last scan with one of that row's matched textures, and the
`pcimg://localhost/batch/<id>` route serves only those files (as a small
thumbnail), so the web view still cannot read arbitrary files. Both commands
check `own_pack`. Dropping uses Tauri's window drag-drop event, so dragging
inside the page (HTML drag and drop) stays unused.

**D-076 · Editor copy / paste through the Windows clipboard.** Copy and Cut
in the pixel editor still fill the app's own clipboard (exact pixels and
where they came from, shared between tabs, D-028) and also put the copied
pixels on the Windows clipboard as an image, so other programs can paste
them. Paste takes the Windows image when it is not the one Pack Creator left
there itself (the app remembers the exact pixels it last wrote and compares);
otherwise it pastes the app's own clipboard where it was copied from. An image
from another program lands at the top-left texture pixel in view (0,0 when
the whole texture is visible), lifted for the Move tool, never resized, as one
undo step, clipped by "Edit only these cells"; when it is bigger than the
texture, only the part over the texture is kept and the status line says so.
Images go through Tauri's clipboard plugin as raw RGBA, never through a
browser canvas (which would change semi-transparent pixels): writing passes
`{rgba, width, height}` (`tauri::image::JsImage::Rgba`, no Cargo image
feature needed) and the plugin (arboard) puts both a "PNG" format and a
CF_DIBV5 bitmap with alpha on the clipboard; reading takes "PNG" when present
(exact, with alpha), else CF_DIBV5. A bitmap whose alpha bytes are all 0 is
taken as opaque (programs that write 24-bit or "alpha unused" bitmaps).
Bitmaps with premultiplied alpha are not detected: semi-transparent pixels
from such a program come out darker. If Windows refuses the copy, the pixels
stay in the app's clipboard, a warning says so, and the image already on the
Windows clipboard no longer counts as newer. The logic is in
`src/editor/sysClipboard.ts` (tested with a fake plugin).

**D-077 · "What's new since…": comparing the pack's version with another.**
The texture browser's side bar ("Only show") compares the pack's game version
with another installed, usable version, older or newer (default: the newest
older one). Rust (`core/src/whats_new.rs`) walks the pack's version index and
maps every texture to the other version through the rename table
(`RenameTable::map` in the right direction; when the table gives no name the
other version has, the same name counts as the same texture). No match =
**added**; a match under another name = **renamed** (folder-only renames such
as `blocks/` → `block/` are marked and left out of the "Renamed" list);
textures of the other version that nothing maps to = **removed**. Matched
pairs are compared on the extracted files: equal bytes are equal, otherwise
both PNGs are decoded to RGBA with every fully transparent pixel set to
0,0,0,0 (its colour is invisible); a different size counts as **changed**.
Animation `.mcmeta` changes are not compared. The work runs on up to 8
threads and sends the usual `extract-progress` events. The result is cached
as JSON in `<cache>/whats_new/<this>__vs__<other>.json`, valid only for the
same two jar stamps and schema, so the second time is instant (about 20 ms
instead of 3–6 s in a debug build). Command `whats_new(otherDirName,
packDir)` checks `own_pack`, extracts the other version first if needed, and
adds which changed textures the pack has its own file for. The UI reuses the
`only` filter with a new `onlyTitle` (the list heading, also the share list's
subtitle, e.g. "New in 1.21.11 since 1.20.1"); the notice line gives all the
counts; removed textures (not in the pack's version) are listed only in the
side bar. Changed textures the pack has are tagged "redrawn by Mojang" in the
list; the inspector shows both game versions side by side for any changed
texture, and "New in …" / "Called … in …" for added and renamed ones.

## Ideas added after the final stage (2026-11-20)

### Drawing helpers

**D-078 · Pack palette.** A list of up to 64 colours (`#rrggbb`) stored in the
project file as `pack_palette` (serde default, so older `project.json` files
load unchanged). It is edited from the editor's palette panel, source "Pack
palette": Add (the foreground colour), Remove and move left / right (the
selected colour is the foreground colour when it is in the list), and "Fill
from this texture" (its most used colours, replacing the list; the toast offers
Undo). Under the other sources the pack palette is shown as a small strip.
Saving goes through `update_project` (`palette::normalise`: lower case, no
repeats, at most 64; anything else is refused). 16 to 64 colours is suggested,
not enforced, so a palette can be built up one colour at a time.

**D-079 · Snap to pack palette.** A tool option. Every pixel a tool changes gets
the RGB of the nearest pack colour in OKLab (Björn Ottosson's matrices, same
numbers in `src/editor/packPalette.ts` and `core/src/palette.rs`); alpha is
kept, fully transparent pixels are left alone, the eraser is never snapped. It
works for every drawing tool (pencil, shapes, bucket, gradient, spray, blur,
text) because it runs after the stroke on the pixels that differ from the
snapshot; the incremental stroke snaps the same pixels, so both give identical
images (tested). Paste and Move are not snapped: they place existing pixels.

**D-080 · Palette export check.** `core/src/palette.rs::check`, called from
`run_checks`: when the pack palette is not empty, every pack PNG is read and a
texture counts when a visible pixel (alpha > 0) is further than 0.02 in OKLab
from every pack colour (about one 8-bit step; near-identical colours do not
count). Warning "N textures use colours outside the pack palette", fix "Show".

**D-081 · Recolour a set.** Dialog from Ctrl+K "Recolour textures…" and the
browser's "Recolour…" button: textures chosen by search text + category
(starting from the browser's current search and category; pack-only textures
are offered when the pack has them), an adjustment (hue ±180°, saturation,
brightness, contrast ±100) or a colour map (up to 8 from → to pairs, a
tolerance 0–128 as the largest channel difference; a colour inside the
tolerance keeps its small difference from the "from" colour, so shading
survives), before/after thumbnails of the first 240 textures. Rust does the
pixels (`core/src/recolor.rs`): the result depends only on the colour (exact,
a cache per colour), alpha is never changed, fully transparent pixels keep
their bytes. Writing: a texture not in the pack starts from the game's texture
at the pack resolution (with the chosen enlargement, and the game's `.mcmeta`
copied as start-from-vanilla does); a replaced pack file goes to
`.packcreator/trash/<stamp>/`. The command returns a report (stamp, replaced,
created, created `.mcmeta`, failures); the toast's Undo sends it back to
`recolor_undo`, which puts replaced files back from the trash and moves new
files (and their copied `.mcmeta`) to the trash; the recoloured files are kept
in the trash too. Textures open with unsaved changes in the editor are skipped
and listed with the reason. One failure does not stop the others.

**D-082 · Make variants: gradient map.** From the texture inspector. The source
is the pack's texture (or the game's at the pack resolution); its first frame
is used. For each target, the visible colours of the target's game texture
(first frame, every pixel, so frequent colours weigh more) are sorted by
luminance (Rec. 709, integer) into a ramp; each visible source pixel takes the
ramp colour at its own luminance rank among the source pixels (mid-rank for
ties, so equal source colours stay equal and the source's shading structure is
kept). Alpha comes from the source. The family is offered by name: same
folder, same last word and number of words (`oak_planks` → every `*_planks`),
else the same first word; the list is editable (remove chips, add by name).
Each target shows before/after and can be unticked; writing, trash and Undo
are those of "Recolour".

**D-083 · Smooth start (Scale2x / Scale3x).** Setting `upscale` ("nearest" by
default, or "smooth"), in Settings → Editing. It applies when a texture is
started from the game's texture with an enlargement (32× packs and up): the
editor opening a texture the pack does not have yet, "Open externally" (the
browser's start-from-vanilla) and the recolour/variants of textures not yet in
the pack. Scale2x is EPX / AdvMAME2x and Scale3x is AdvMAME3x, exactly as the
Scale2x project defines them; 4× = Scale2x twice, 8× = three times, 6× =
Scale2x then Scale3x; past 8× the rest is hard pixels (a 256× pack: Scale2x ×3,
then 2× nearest). Animation strips are enlarged frame by frame. Block textures
are treated as tiling (neighbours wrap around the edges, so a seamless texture
stays seamless); other textures repeat their border pixel. Only colours of the
original are used (tested). A pack file is never rescaled.

**D-084 · Seam check.** `core/src/seams.rs`. For a block texture, the average
colour difference across the wrap edge (last column vs first, last row vs
first; RGB weighted by alpha, plus alpha) is compared with the average
difference between neighbouring columns (rows) inside. A seam is flagged when
the edge is more than 2× the inside average, more than 1.25× the second strongest
line inside (the strongest alone is left out, so a line drawn next to the edge
does not hide the seam it makes), and at least 12 (out of 441): flat textures with a faint edge
pass, and striped textures (planks, bricks) whose edge line is just another
line of their pattern pass too. Animation frames are measured one by one. The
editor's Tiled preview of a block texture asks Rust (`seam_measure`, the
flattened frame) 300 ms after the drawing stops changing, and shows "Seam on
the left/right edge" (or top/bottom) with the edge outlined between the tiles.
The export check warns "N block textures show a visible seam when tiled" with
"Show".

### 3D scene and lighting

**D-085 · Scene: blocks by id, default state, no rotations.** A scene cell holds a
block id (`oak_planks`). Rust (`core/src/scene.rs`) reads
`blockstates/<id>.json` (the pack's first) and takes the variant closest to the
game's default state: `""` / 1.8.9's `normal` when present, else the key with
the most default property values (`axis=y`, `facing=north`, `half=bottom`,
`type=bottom`, `shape=straight`, `snowy=false`, …), first on ties. A weighted
list takes its first model; a multipart block takes the parts without `when`.
The variant's `x` / `y` rotation is ignored (stairs face east, as in their
model file). Without a blockstate file (hand-made or demo game folders) the
model of the same name is used, and the block list falls back to the block
models that are complete blocks (every face has a texture, so templates like
`cube_all` are left out). Presets name each role with a list of ids, newest
first (`oak_slab`, `half_slab_oak`, …), and take the first the version has;
"grass" is the plant only when `grass_block` exists (1.13–1.20.2) and the grass
block in 1.8.9.

**D-086 · Scene: hidden faces and render layers.** A face with a `cullface` is
dropped when the neighbour on that side is a full opaque block: an unrotated
0..16 box with all six faces whose render layer is solid. Glass-like blocks
(glass, stained glass, ice) also drop faces against the same block, as the
game does; leaves keep them (fancy graphics). The render layer comes from the
block id (the game hard-codes it per block): stained glass, ice, slime, honey
and water are translucent (blended, drawn last, no depth write), glass, leaves,
bars, spawner and similar are cut-out, the rest solid. All faces using one
texture are merged into one mesh (one draw call); the grass side overlay is
drawn after the side under it (meshes ordered by element index).

**D-087 · Light: the game's lightmap.** `app/src/scene/light.ts` follows
`LightTexture.updateLightTexture` (1.19–1.21) as remembered:
brightness(level) = f / (4 − 3f) with f = level / 15 (1.8.9's brightness table
gives the same curve); sky colour = lerp((s, s, 1), white, 0.35) · s with
s = skyDarken · 0.95 + 0.05 and skyDarken 1 (day), 0.6 (sunset, about tick
11 500) or 0.2 (night); block light b = brightness · 1.5 (the torch flicker at
its average) coloured (b, b·((0.6b + 0.4)·0.6 + 0.4), b·(0.6b² + 0.4)); sum,
lerp 4 % to grey 0.75, clamp, the default Brightness 50 % (lerp halfway to
1 − (1 − c)⁴), lerp 4 % to grey, clamp. The result multiplies every face (the
material colour), so changing the light never rebuilds geometry. Sky light is
15 everywhere and the block light the same on every face: there are no light
sources, propagation or shadows. Sky colours are approximations (plains day
`#78a7ff`). The time and level are one session setting shared by the Scene and
the editor / animation 3D previews.

**D-088 · Ambient occlusion.** Per vertex, like the game's smooth lighting: the
layer in front of the face (the next cell for a face on the cell's side, the
cell itself for a face inside it, such as a slab top) gives two side
neighbours and a corner neighbour; an occluder counts 0.2, a free cell 1.0, the
corner counts as occluded when both sides are, and the vertex gets the average
of those three and the front (1.0): 1, 0.8, 0.6 or 0.4. Occluders are full
blocks except glass-like ones (leaves count, as their collision shape is
full). Models with `ambientocclusion: false` (plants) and rotated faces get
none. Quads are split along their brighter diagonal. The single-block previews
have no neighbours, so they have no AO control.

**D-089 · Live textures in the Scene.** The scene subscribes to the editor store:
every open editor tab of the same pack whose texture the scene uses is
flattened (current frame, visible layers, the tool preview included) into a
canvas texture, on the next animation frame after each change. Closing the tab
puts the file back (pack file, else the game's). A label says how many unsaved
textures are shown.

**D-090 · Custom scene file.** `.packcreator/scene.json` (never exported):
`{"version": 1, "width", "depth", "height", "blocks": [...]}`, ids per cell
(`""` = air), index `(y · depth + z) · width + x`, at most 8 × 8 × 4. Rust
checks sizes, cell count and block names before writing, and writes through a
temporary file and a rename. It is saved 400 ms after the last change (and when
leaving the screen). A damaged file is reported with what to do (delete it; no
texture is affected) and a new scene is shown.

### Organising a pack

**D-091 · Notes, tags and "assigned to" per texture.**
Each texture can have a free-text note, tags (free words) and the name of
who does it. They live in `.packcreator/notes.json` (`core/src/notes.rs`),
never exported: `{"schema":1,"textures":{"block/stone":{"note","tags","assignee","updated_ms"}}}`,
keys sorted so the file diffs well when a team shares the pack in git.
Every change is read-modify-write under a process-wide lock and written in
one step (temporary file + rename). Rust cleans what it stores: text trimmed,
note cut at 4000 characters, tags and names on one line (40 characters),
duplicate tags dropped regardless of case (the first spelling wins), at most
12 tags, an empty entry removed. A missing file is an empty list; unknown
fields and invalid texture keys are ignored; a file that is not valid JSON is
renamed to `notes.damaged-<time>.json` (never deleted) and the pack starts an
empty list, which the UI reports once with a warning toast. Commands
`notes_load(packDir)` and `notes_set(path, note, packDir)` check `own_pack`.
The export check's "Rename" fix carries a texture's note (and its history
folder) to the new name; a note already on the new name is kept. In the UI
(`src/lib/notesStore.ts`) the notes are loaded once per pack. The inspector's
**Notes** section saves the note and the assignee when the field loses focus
and a tag as soon as it is added or removed; the status bar says "Saved the
notes of stone" (no toast). Tag suggestions are the tags already used (most
used first) followed by "needs redo", "waiting feedback", "in progress",
"check in game"; name suggestions are the names already used. List rows show
a note mark (with the number of tags; tooltip shows tags and note) and the
assignee's initials. The side bar's **Team** group filters by tag, by who
("Anyone / Mine / Unassigned / each name", names compared without case) and
"Has a note"; these filters combine with the others and count in "N more
matches in other categories". "Mine" needs the user's own name, typed in the
side bar ("I am") and kept on this computer only (browser storage, per
viewer, not in the pack), because the pack may be shared by several people.

**D-092 · Share list: notes, tags, assignee, group by person.**
Checklist and plain text add `· tags: a, b · assigned to Alex · note: …`
after each texture (a note's line breaks become " / "). "Group by person" in
the share dialog makes one part per assignee (A→Z, any case, "Unassigned"
last) and then leaves out "assigned to". The CSV gets the columns `note`,
`tags` (joined with "; ") and `assigned_to`; the existing column that held
the automatic remarks (animated, changed since export, wrong size) was
renamed from `notes` to `details` so it is not confused with `note`. The CSV
`category` column is now the texture's own category, also when grouped by
person.

**D-093 · Pack history: every replaced texture can be found and restored.**
`core/src/history.rs` lists the earlier versions of one texture from two
places: `.packcreator/trash/<time>/assets/minecraft/textures/<texture>.png`
(import, batch import, revert and any tool using `import::move_to_trash`
already put replaced files there) and a new
`.packcreator/history/<texture>/<time>.png` (`history-icon/` for the pack
icon). The editor's save (`workfile::save`) now copies the PNG it is about to
replace into the history folder during the staging step (only when the bytes
differ; a PNG that cannot be read stops the save instead of being lost). The
copy keeps the file time of the old version, so the list shows when each
version was *made* ("Today 14:32"). If the save fails, the copy is removed
again; the all-or-nothing logic is otherwise unchanged. **Restore** reads
the chosen version, writes it to a temporary file, moves the current PNG into
the history folder, then renames the temporary file into place (any failure
puts the current file back), so a restore can always be undone; the version
restored from stays where it was. Only the PNG is restored: the `.mcmeta`
stays, and the editor's layers no longer match the PNG so the editor opens
the restored PNG as one layer (its layers go to the trash on the next save,
as before). Restoring identical bytes changes nothing. Cap: the history
folder of one texture keeps at most **50 files and 20 MB**; above that the
oldest files are deleted after each save or restore, the newest is always
kept. The trash is never pruned by the app. Version ids are `h-<file>` /
`t-<trash folder>` (letters, digits, `-`, `_` only), resolved only inside the
texture's own history folder or the texture's own place in one trash folder.
Commands: `texture_history(path, packDir)` and `restore_version(path, id, packDir)`.
The `pcimg` protocol gets `pcimg://localhost/history/<id>/<texture>`, served
only for the texture whose history was listed last (remembered in the app
state) and only through `history::version_file`. Inspector: **History**
section with thumbnails and dates, click one to see it large next to the
current file, "Restore this version"; the toast after a restore has an
**Undo** button (restores the file that was just moved into the history).

**D-094 · Progress stats.**
Pure helpers in `src/lib/logic.ts` (`progressStats`, `progressOf`,
`startOfWeek`): done / total overall and per category count only the
textures of the pack's game version (pack files the game does not have are
not progress); percent is rounded down (100 % only when everything is done).
"Saved today" and "this week" (from Monday 00:00, local time) count the
pack's files by their file time; "changed since export" is the status count.
Side bar: a Progress card at the top (percent, bar, "N / M done · K today")
that opens the Progress summary (overall, three counters, one bar per
category, "Show" lists the changed textures); each category row has a thin
progress bar. The Home screen's recent-pack bar is unchanged. The list
heading says "N of M textures" while a team filter is on.

### Publishing and comparing

**D-095 · "Make PNG files smaller (same pixels)".** An export option (remembered
in the settings as `export_optimize`). Only the exported copy is touched, never
the pack's own files. `core/src/pngopt.rs` re-encodes every PNG of the export
with oxipng 10 (`default-features = false`: no CLI, no zopfli, no rayon; it
uses libdeflate, which builds with MSVC), preset 4, at most 8 s per file, on up
to 8 threads, once per source file even when copies for other versions are
exported too. The new file is kept only when it is smaller **and** both files
decode (image crate) to exactly the same pixels: same size and the same RGBA
at 16 bits per channel (an 8-bit value v counts as v × 257, so a 16-bit image
may only become 8-bit when nothing is lost). Nothing is normalised: the colour
under a fully transparent pixel must match too (`optimize_alpha` and
`scale_16` are off). Chunks that do not change how the image looks (text,
time, physical size…) are dropped (`StripChunks::Safe`); colour chunks are
kept. Minecraft reads only the pixels. A file oxipng cannot read is written as
it is. The export reports the PNG bytes before and after; the toast says
"Saved 1.2 MB (38%) on PNG files, same pixels."

**D-096 · Showcase image.** Pack and export has a "Showcase" card: a 1920×1080
image with the pack icon, name, description (§ colours, bold, italic,
underline, strike drawn like the preview), up to 24 textures in dark cells and
"Made for Minecraft Java <main and export-copy versions> · <resolution>×".
Default textures: the pack's own textures, blocks and items first, each group
most recently edited first; "Choose textures…" picks others (search, order of
picking, "Back to the default"). The choice is kept per pack while the app
runs. Textures are drawn with hard pixels: scaled by a whole number when they
fit a cell (shrunk only when bigger than the cell); animation strips show
their first frame. The image is drawn on a canvas in the web view (the
bundled Inter and JetBrains Mono fonts; images through `pcimg`, which sends
`Access-Control-Allow-Origin`, so the canvas stays readable) and the raw RGBA
goes to Rust (`core/src/showcase.rs`), which encodes a lossless PNG (passed
through the PNG optimiser) and writes only absolute `.png` paths chosen in the
save dialog. Layout maths is pure TypeScript (`src/lib/showcase.ts`, tested).

**D-097 · Page text for CurseForge / Modrinth.** "Page text…" makes Markdown
(both sites take it): name, description without § codes, supported versions
(main + export copies), resolution, what is inside (blocks "of" the game's
count, items, GUI, entities, particles, other, animated), a features list
built from those counts, and install steps naming the exported .zip. A
one-line summary (at most 256 characters, Modrinth's limit) has its own Copy.
The text is editable before Copy (Tauri clipboard plugin) or "Save as .md…"
(the share-list command, which only writes .md/.txt/.csv).

**D-098 · Compare with another pack.** In Pack and export and Ctrl+K. The other
pack is a `.zip` or a folder (two buttons, since one native dialog cannot pick
both). Rust (`core/src/compare.rs`): a zip is unpacked into
`<cache>/compare/<time>/` (earlier comparison folders are removed first):
only `pack.mcmeta`, `pack.png` and PNG / `.png.mcmeta` files under
`assets/minecraft/textures/`, only safe relative paths (`enclosed_name` and
the texture-path check), files over 16 MB left out and counted, at most
50 000 entries, refused above 1 GB unpacked. The pack root is where
`pack.mcmeta` is (or where `assets/` starts); a folder may also hold the pack
one level down. A folder is read where it is; the open pack itself is refused.
Their textures are matched with the batch-import matcher (`Matcher::match_rel`,
now public), so old or newer names are understood; when two of their files map
to one texture, the one named for this version wins and the other is listed as
"not used". A file that is no texture of this version still matches the pack's
file of the same path. Each row is Only in mine / Only in theirs / Different /
Identical; "Identical" compares decoded RGBA (like batch import) and the
`.mcmeta` bytes, so same pixels with another animation file is "Different".
The dialog lists the rows (filters, search, virtual list) with a large
side-by-side view of theirs, mine and the game's texture. Their images are
served by `pcimg://localhost/compare/<row id>` for the rows of the last
comparison of the open pack only. "Copy theirs into my pack" copies ticked
rows through `batch::import_one` (PNG and `.mcmeta` byte for byte, replaced
files to the trash); `compare_copy` only takes row ids of the last comparison
that have a file of theirs used for a texture; rows whose texture has unsaved
editor changes are skipped and listed. Afterwards the comparison runs again.
"Share list…" turns the comparison into Markdown or plain text (identical
textures optional), copied or saved as .md/.txt.

**D-099 · Development hook for Compare.** Like D-055: in development builds
only, `window.__packCreatorDev.compare(path)` runs the comparison from a path
(the same code that runs after the native dialog), so `tools/shot.mjs` can
drive it. The Animation screen's `importStrip` hook now shares the same object
instead of replacing it. Not in release builds.

### Variety: random variants and connected textures

**D-100 · Random variants are generated from the base block state, with the options in `.packcreator/variants/`.**
The pack's `blockstates/<block>.json` is always generated, never written by hand: from the pack's own block state when it has one, else from the game's file of the pack's version (pre-1.13 files included: same JSON shapes, the `normal` state, model names without folder such as `"stone"`). The options (which texture, weight 1–100 and "turn at random" for the original and each variant) and the base are kept in `.packcreator/variants/<block>.json` (excluded from export). Every state whose models show the texture becomes a weighted list `[{model: original}, {model: original_2}, …]` keeping each entry's `x`, `y`, `uvlock`; states that do not show it are left alone. Weights: each look's share is proportional to its weight (a look turned at random is four entries; all weights are scaled to whole numbers and reduced by their common divisor). When the pack's file was edited by hand after the app wrote it, the edited states become the new base (without the app's own `_n` entries); states added by hand are kept. Every file the app replaces or removes goes to `.packcreator/trash` first. Removing the last variant writes the pack's original file back, or removes the pack's file when the base came from the game. Code: `core/src/variants.rs` (13 tests on synthetic files).

**D-101 · One varied texture per block, variant files named `<name>_<n>`.**
Variant `n` (the smallest free number from 2, checked in the pack and the game) creates `textures/<texture>_n.png` (a copy of the pack's texture, else the game's enlarged to the pack resolution; its `.mcmeta` too) and, for every model of the block that shows the texture, `models/<model>_n.json`: a copy of the model's own file (the pack's when it has one) with each texture reference to the original replaced; when the texture is only set by a parent model, every texture variable that ends at it is overridden in the copy. A block varies one texture at a time (remove its variants to vary another one).

**D-102 · Multipart blocks are refused.**
Blocks built from parts (`"multipart"`: fences, walls, panes, redstone…) are listed but marked "parts"; picking one shows why random variants cannot be added. Random parts would need per-part lists and a different preview; not worth it for the first version.

**D-103 · Connected textures: OptiFine's compact method, five tiles made from the block's texture.**
`assets/minecraft/optifine/ctm/<block>/0.png … 4.png` and `<block>.properties` (`matchBlocks=<block id>`, `method=ctm_compact`, `tiles=0-4`, `faces=all` / `sides` / `top bottom`, `connect=block`). The same folder and block ids (the version's block state file names, e.g. `glass`) are used before 1.13; `matchBlocks` is editable. Tile meanings follow Continuity's `CompactCtmQuadProcessor` (which reimplements OptiFine's compact method; OptiFine's own `ctm.properties` documentation only says "Compact 8-way method, uses 5 tiles"): 0 no connection, 1 connected everywhere, 2 up and down, 3 left and right, 4 connected on all sides but not across the corners. Each face is cut in four quarters; a quarter takes its tile from its horizontal side, vertical side and the corner neighbour (`app/src/variety/ctm.ts`, Vitest). Starting tiles (`core/src/ctm.rs`): border width b = texture width / 16 (at least 1); removing a side copies the band of b pixels just inside it over the border band; tile 0 = the texture, 1 = all four sides removed, 2 = top and bottom removed, 3 = left and right removed, 4 = tile 1 with the texture's four b×b corners put back. The first frame is used for animated textures. Old tiles go to the trash when made again.

**D-104 · CTM tiles open in the built-in editor through `:optifine/<path>` editor paths.**
`workfile` maps an editor path `:optifine/ctm/glass/0` to `assets/minecraft/optifine/ctm/glass/0.png` (layers in `.packcreator/optifine-work/`), like the pack icon's `:pack-icon`. The image protocol serves them as `pcimg://localhost/pack/optifine/<path>`.

**D-105 · Copies for other versions keep models and CTM files working.**
`export::for_version` (called from the export plan for copies only): texture references in the pack's `models/**/*.json` (texture variables, `{"sprite"}` objects, face textures that are paths) and texture paths in OptiFine `.properties` keys `matchTiles` / `tiles` / `connectTiles` follow the renamed textures (`minecraft:block/stone_2` → `minecraft:blocks/stone_2` for 1.8.9). Block state files are left out of a copy on the other side of 1.13 (their states and model names changed; the game would show missing models) and listed as left out. Textures the main version's game does not have (the pack's own new textures, such as variants) are no longer skipped from copies for being absent from the other version. The "file not used by this version" check no longer counts textures named by the pack's own model files.

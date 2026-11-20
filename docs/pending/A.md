# Package A · Drawing helpers

## Decisions

**D-? · Pack palette.** A list of up to 64 colours (`#rrggbb`) stored in the
project file as `pack_palette` (serde default, so older `project.json` files
load unchanged). It is edited from the editor's palette panel, source "Pack
palette": Add (the foreground colour), Remove and move left / right (the
selected colour is the foreground colour when it is in the list), and "Fill
from this texture" (its most used colours, replacing the list; the toast offers
Undo). Under the other sources the pack palette is shown as a small strip.
Saving goes through `update_project` (`palette::normalise`: lower case, no
repeats, at most 64; anything else is refused). 16 to 64 colours is suggested,
not enforced, so a palette can be built up one colour at a time.

**D-? · Snap to pack palette.** A tool option. Every pixel a tool changes gets
the RGB of the nearest pack colour in OKLab (Björn Ottosson's matrices, same
numbers in `src/editor/packPalette.ts` and `core/src/palette.rs`); alpha is
kept, fully transparent pixels are left alone, the eraser is never snapped. It
works for every drawing tool (pencil, shapes, bucket, gradient, spray, blur,
text) because it runs after the stroke on the pixels that differ from the
snapshot; the incremental stroke snaps the same pixels, so both give identical
images (tested). Paste and Move are not snapped: they place existing pixels.

**D-? · Palette export check.** `core/src/palette.rs::check`, called from
`run_checks`: when the pack palette is not empty, every pack PNG is read and a
texture counts when a visible pixel (alpha > 0) is further than 0.02 in OKLab
from every pack colour (about one 8-bit step; near-identical colours do not
count). Warning "N textures use colours outside the pack palette", fix "Show".

**D-? · Recolour a set.** Dialog from Ctrl+K "Recolour textures…" and the
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

**D-? · Make variants: gradient map.** From the texture inspector. The source
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

**D-? · Smooth start (Scale2x / Scale3x).** Setting `upscale` ("nearest" by
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

**D-? · Seam check.** `core/src/seams.rs`. For a block texture, the average
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

## README

**Drawing helpers.** A pack palette shared by every texture (built in the
editor's palette panel, with "Snap to pack palette" to keep every drawn colour
inside it and an export check for colours outside it); "Recolour…" in the
texture browser (or Ctrl+K) to shift hue, saturation, brightness or contrast,
or map colours, for a whole set of textures at once, with before/after
previews and Undo; "Make variants…" in the inspector to recolour a texture to
look like the rest of its family (oak planks → spruce, birch, cherry…
planks); a smooth Scale2x / Scale3x start for 32× packs and up (Settings); and
a seam warning in the Tiled preview and the export checks when a block
texture's edges show.

## Limitations

- The recolour preview shows the first 240 chosen textures and the first frame
  of animations; all chosen textures are written.
- Make variants uses the first frame of the source and of each target; an
  animated target gets a still image (its game `.mcmeta` is copied when the
  target was not in the pack, so it plays as one frame).
- Undo of a recolour or variants is offered in the toast only (about 9
  seconds); afterwards the earlier files are still in `.packcreator/trash`.
  Undo puts back the files as they were before the write, even if one was
  edited again in between (that edit then goes to the trash too).
- Snap to pack palette does not apply to Paste, Move or imported images, and
  the foreground colour itself is not changed (only the drawn pixels).
- The seam measure is a heuristic: a texture with a deliberate strong line at
  its border (a frame, a brick edge on the last column) can be flagged.
- The pack palette check reads every pack PNG at each check run; with
  thousands of large textures this takes a moment.
- The smooth start is a global setting, not per pack; changing it does not
  change textures already started or already open in an editor tab.

# Package D: publishing and comparing

## Decisions

**D-? · "Make PNG files smaller (same pixels)".** An export option (remembered
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

**D-? · Showcase image.** Pack and export has a "Showcase" card: a 1920×1080
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

**D-? · Page text for CurseForge / Modrinth.** "Page text…" makes Markdown
(both sites take it): name, description without § codes, supported versions
(main + export copies), resolution, what is inside (blocks "of" the game's
count, items, GUI, entities, particles, other, animated), a features list
built from those counts, and install steps naming the exported .zip. A
one-line summary (at most 256 characters, Modrinth's limit) has its own Copy.
The text is editable before Copy (Tauri clipboard plugin) or "Save as .md…"
(the share-list command, which only writes .md/.txt/.csv).

**D-? · Compare with another pack.** In Pack and export and Ctrl+K. The other
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

**D-? · Development hook for Compare.** Like D-055: in development builds
only, `window.__packCreatorDev.compare(path)` runs the comparison from a path
(the same code that runs after the native dialog), so `tools/shot.mjs` can
drive it. The Animation screen's `importStrip` hook now shares the same object
instead of replacing it. Not in release builds.

## README

**Pack and export** also makes the PNG files of an export smaller without
changing a single pixel (option "Make PNG files smaller (same pixels)"), draws
a 1920×1080 **showcase image** of the pack (icon, coloured description and up
to 24 textures with hard pixels) and writes the **page text** for CurseForge or
Modrinth (Markdown with versions, counts, features and install steps).
**Compare with another pack…** (also in Ctrl+K) lists what differs from
another pack's .zip or folder, even one made for another Minecraft version,
shows theirs, yours and the game's texture side by side, copies the textures
you tick into your pack (old files kept in the trash), and shares the
comparison as text.

## Limitations

- The PNG optimiser works per file and does not use zopfli (slower, a few %
  smaller); a file that takes more than 8 s keeps oxipng's best result so far.
  Text and other metadata chunks inside exported PNG files are dropped.
- The showcase layout is fixed (one style, 1920×1080); the description is one
  line and is cut at the image edge; textures that fail to load are left out.
- Page text is generated in English from counts only; there is no image
  upload or direct publishing to CurseForge / Modrinth.
- Compare: identical means same decoded pixels and same `.mcmeta` bytes; other
  pack files (models, sounds, fonts, `pack.png`) are not compared. A zip is
  unpacked into the cache each time (no reuse between comparisons). Textures of
  other namespaces (mods) are ignored.
- "Copy theirs into my pack" copies whole files; it does not convert sizes or
  merge animations, and it does not copy textures their pack has under a name
  this version does not know.

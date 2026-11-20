# Known limitations and ideas for later

Pack Creator 0.1.0. This list is collected from `docs/DECISIONS.md` (the
numbers in brackets) and `docs/PROGRESS.md`. Nothing here loses work; these
are the places where the app is less complete or less certain than it looks.

## Game versions and data

- **Some renames are not checked against real files.** The rename table used
  when exporting copies for other versions was built by comparing the pixels of
  the installed 1.8.9 and modern jars. The textures added in 1.9–1.12 come from
  the Minecraft Wiki, and the 1.14 and 1.17 renames, plus the exact versions of
  the 1.21.2 / 1.21.4 / 1.21.9 steps, are from memory. Installing 1.12.2 and
  1.13.2 once would let `tools/research/compare_versions.py` check them (D-006).
- **Some reorganisations are not converted.** Entity textures that changed
  layout (horses, chests, banners, villagers…) and the old single sheets
  (paintings, mob effect icons, GUI icons) are different layouts, not renames.
  An export for another version does not convert them.
- **`pack.mcmeta` for 1.21.9 and newer** uses `min_format` / `max_format`
  following the Minecraft Wiki. The game jar has no example to compare with:
  check once in-game that a pack exported for 1.21.11 shows as compatible
  (D-005).
- **"Install into Minecraft's resourcepacks folder"** is covered by tests on a
  fake game folder only; it was not run against a real one.
- A file with an old name in the new folder (for example
  `block/grass_top.png`) is reported as "not used by this version", not renamed
  (D-020).
- Versions between 1.9 and 1.13 were never installed on the build computer, so
  they are only covered by the rules above, not by a real test.
- Models and textures from other namespaces (mods) are not supported.

## Editor and animation

- After undoing back to the saved state, the tab still counts as unsaved (the
  safe side) (D-024).
- Copy / paste with other programs goes through the Windows clipboard as an
  image. Semi-transparent pixels from a program that puts only a
  premultiplied bitmap (no PNG) on the clipboard come out darker; a program
  that puts only a bitmap without alpha pastes opaque (D-076).
- A layer's lock is not an undo step (D-023).
- The Text tool draws with JetBrains Mono, not the game's font (D-029).
- Frames are reordered with buttons, not by dragging.
- The durations of a ping-pong order are kept per frame when the order is
  rebuilt; an import that replaces the size rebuilds a ping-pong without
  durations.
- "Loop" off only affects the preview: the game always loops (D-051).
- An animation whose height is not a whole number of frames is not opened; the
  message says what to correct (D-041).
- If another program changes `pack.png` while it is open in the editor, the
  change is not noticed (D-039).

## 3D block preview

- No ambient occlusion and no removal of hidden faces: one block alone shows
  all its faces (D-058).
- The model is shown as it is in its file: no blockstate rotations or
  variants, no multipart blocks.
- No item models in 3D (items use the flat previews).
- One biome colour (plains) for grass, leaves and water.
- Blocks drawn by the game's code (chests, beds, signs in 1.21) are shown as a
  plain cube with a note (D-056).
- The list of models for a texture is not cached: about 150 ms per texture in a
  debug build, more on a slow disk; the picker shows only "Cube" until it
  arrives (D-057).

## Particles

- Movement, sizes and colours are approximations per kind of particle, not the
  game's code. The screen says so (D-064).
- Before 1.14 all particles share one image, so a particle counts as "done" as
  soon as the pack has `particles.png`; the app cannot tell which cells were
  redrawn (D-061).
- The scene shows saved files; unsaved editor changes appear after saving.
- Particles without their own images (block, item, dust pillar…) show grey
  squares.

## Interface (GUI)

- The 7 screens are faithful-looking approximations of the game's layouts, not
  every screen of the game. Text uses JetBrains Mono (D-069).
- Animated GUI sprites are drawn as their whole image (none of the listed
  pieces is animated).
- The width and height of a Tile or Nine-slice rule are not editable (always
  the piece's GUI size); only the borders and "stretch the inside" are
  (D-066).
- Before 1.20.2: the rectangles of the shared images were checked against
  1.20.1 and 1.8.9 only; the versions in between are assumed to use the same
  places. A shared image in the pack counts as done for all its pieces. "Draw
  this piece" limits drawing to the piece only when the pack's image is a whole
  multiple of 256 pixels wide (D-071).

## Batch import

- Only PNG files are taken (the single "Import image" also converts JPEG, BMP
  and GIF). At most 5000 files per scan (D-075).
- Only textures of the pack's version are matched: a file the version does not
  have (an OptiFine / CTM file, a modded texture) is listed as unknown and not
  imported.
- A file whose name the game uses twice (for example `button.png`) needs a
  choice; two files for the same texture need a pick. Another target cannot be
  typed in for a duplicate: rename the file or use "Import image" on the
  texture.
- A tall image without an `.mcmeta` gets frame time 2 when "frames?" is
  ticked; replacing a texture keeps the pack's existing `.mcmeta` unless the
  imported file has its own (as the single import does).
- The summary chips at the top count the scan's statuses, not the picks made
  afterwards.

## Platform

- Built and tested on Windows 10/11 only.
- The installer is not code-signed, so Windows SmartScreen may warn the first
  time ("More info" → "Run anyway").
- No automatic updates: install a new version over the old one.

## Later

Ideas for after 0.1.0, roughly in order of usefulness:

- **Blockbench link**: open a model's textures from Blockbench, and show custom
  models read-only in the 3D preview (design §2, non-goals).
- **Models section** in the left bar (shown as "later" today).
- **A dedicated "Port to another version" screen**: today it opens the pack in
  Pack and export, where "Also export a copy for" does the renaming (D-017).
- **More checks with fixes** on the export screen (for example GUI sprites that
  lost the game's nine-slice, unused files, very large images).
- **Item models in 3D**, and **blockstate rotations / multipart** blocks.
- **Biome colours**: choose the biome for grass, leaves and water tints.
- **Ambient occlusion and hidden-face removal** in the 3D view.
- **Particle movement** closer to the game for more particle kinds.
- **More GUI screens** (furnace, crafting table, villager trading…) and the
  game's own font for the text.
- **Converting the old single sheets** (paintings, GUI icons) when porting a
  pack between old and new versions.
- **Drag to reorder frames**.
- **Auto-update** of the app.
- **macOS and Linux builds** (Tauri supports both; not built or tested yet).
- **Code signing** of the Windows installer.

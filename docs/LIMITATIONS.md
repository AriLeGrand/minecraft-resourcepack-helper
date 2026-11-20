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

## What's new since…

- Only pixels are compared: a texture whose animation file (`.mcmeta`) changed
  but whose image did not is not reported (D-077).
- Textures are matched through the rename table; layout changes (entity
  sheets, old single GUI / painting sheets) show as "new" and "removed", not
  as redrawn.
- Removed textures are listed in the side bar only, since the list shows the
  pack's version.

## Drawing helpers

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

## 3D scene and lighting

- Scene blocks show their default state only: no blockstate rotations, no
  other variants, multipart blocks show only their unconditional parts (a fence
  is its post).
- Light is the same on every face: full sky light everywhere and one block
  light level for the whole scene (no torches, light spreading or shadows,
  inside the house is as bright as outside).
- Render layers (solid / cut-out / translucent) come from a list of block-name
  patterns, not the game's table; unusual blocks may be drawn with the wrong
  one. Translucent faces are not sorted against each other.
- AO is an approximation of the game's smooth lighting (no light-level
  blending, and partial blocks such as slabs do not darken their neighbours).
- One biome colour (plains) for grass and leaves. Sky colours are approximate.
- Animated textures show their first frame (an open editor tab shows its
  current frame).
- Blocks drawn by the game's code (chests, beds, signs) are left out of the
  scene and listed as "Not drawn".
- The lightmap formula was written from memory of the game's code (1.19–1.21);
  it was not checked against the game's output pixel by pixel.

## Organising a pack

- Restoring an earlier version restores the PNG only, not its `.mcmeta`; restoring an animation with a different number of frames may need its animation settings checked.
- The history folder of each texture is capped at 50 versions / 20 MB (oldest deleted first); the trash folder is not capped and not cleaned by the app.
- Versions of a texture saved under an old name before an export "Rename" fix are not listed under the new name when they are in the trash (the history folder and the notes do follow the rename).
- "Mine" uses a name kept in this computer's browser storage, not in the pack: it must be typed once per computer.
- Notes are not merged when two people edit `notes.json` at the same time on different computers (last save of the file wins; git shows the conflict).
- "Saved today / this week" come from file times, so copying or syncing a pack (which can change file times) changes these counts.
- The pack icon's history (`.packcreator/history-icon/`) is kept on disk but not shown in the app.

## Publishing and comparing

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

## Variety: random variants and connected textures

- One texture per block can have random variants at a time; multipart blocks (fences, walls, panes, redstone…) are refused.
- The 3×3 preview picks with its own seeded generator, not the game's per-position hash: the proportions match, the arrangement does not. Face culling, `uvlock` and ambient occlusion are not shown.
- "Turn at random" only adds turns around the vertical axis; for blocks that already turn their model (logs, furnaces) it may point them the wrong way (a hint says so; the choice is left to the user).
- In copies for another version, block state files are left out when crossing 1.13 (so random variants do not work in a 1.8.9 copy of a 1.21 pack; their models and textures are still copied with renamed references). Model *names* and parents are not renamed between versions, only texture references.
- Connected textures: only the compact method (5 tiles); no full 47-tile `ctm`, overlays, `connectTiles` UI, or per-state `matchBlocks` editing beyond the text field. Before 1.13 the block id is taken from the block state file name; blocks whose old id differs (e.g. coloured glass, which is `stained_glass` with a colour state) need `matchBlocks` edited by hand. Not checked in game with OptiFine or Continuity; whether old OptiFine versions for 1.8.9 support `ctm_compact` and read `optifine/ctm/` (rather than `mcpatcher/ctm/`) was not verified.
- Starting tiles are a mechanical first draft (border bands removed); they need drawing for most textures.
- Checked only on the demo game (`tools/demo/make_demo_minecraft.py` now also writes block states, including one multipart block); not on a real game.

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
  The texture browser's "What's new since…" (D-077) already lists what a port
  needs: new textures to draw, textures Mojang redrew that the pack has, and
  renames.
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

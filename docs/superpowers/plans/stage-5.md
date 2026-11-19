# Stage 5 plan: interface editor

Screen: 6 (Interface, mockup `docs/mockups/GuiEditor.dc.html`).

## Facts (checked in the extracted jars)

- 1.20.2 and newer: interface pieces are separate sprites under
  `textures/gui/sprites/<group>/<name>.png` (groups: widget, hud, container,
  advancements, boss_bar, recipe_book, toast, icon, …). A piece may have
  `<name>.png.mcmeta` with `{"gui":{"scaling":{…}}}`; vanilla only writes
  `nine_slice` (e.g. `widget/button`: width 200, height 20, border 3);
  `border` is a number or `{left, top, right, bottom}`; `stretch_inner` exists
  from 1.21.5; no file means "stretch". Big screens (`gui/container/*.png`) are
  still single 256×256 images.
- Before 1.20.2: pieces live at fixed rectangles inside shared images
  (`gui/widgets.png`, `gui/icons.png`, …).

## Steps and how each is tested

| # | Step | Test |
|---|---|---|
| 1 | Rust `gui.rs`: read and write the `gui.scaling` section of a sprite's `.mcmeta` (stretch / tile / nine_slice, border number or object, `stretch_inner`), keeping every other key; writing "stretch" removes the section (or the file when it becomes empty) | unit tests incl. round-trip over every vanilla GUI `.mcmeta` in the extracted cache |
| 2 | Data `core/data/gui_screens.json`: the screens (Menus and buttons, Inventory and chests, HUD, Title screen, Recipe book, Advancements, Boss bars) with their pieces (sprite paths), the piece "used on" text, and a simple layout per screen for the assembled preview (positions in GUI pixels); per piece the version range | tests: every sprite path exists in the 1.21.11 index (dev-only test when the cache exists), no duplicate ids |
| 3 | Data `core/data/gui_regions.json`: for pre-1.20.2 versions, the rectangle of each piece inside the shared images (`widgets.png`, `icons.png`), verified by comparing pixels with the modern separate sprites (as done for the particle sheet) | tests: rectangles inside the image, no overlap within an image; research note in `docs/research/domain-facts.md` |
| 4 | Commands: list screens/pieces with status for the pack's version, read/write scaling | cargo test |
| 5 | Pure TS: nine-slice / tile / stretch rendering of a sprite to any size (exactly like the game: corners kept, edges and centre tiled or stretched), GUI scale maths, hit-testing pieces on the assembled screen | Vitest with exact pixels |
| 6 | Interface screen as in the mockup: screens list, pieces with status, Pixels/Layout toggle, GUI scale 1×/2×/3×, background, piece outlines, the assembled in-game preview drawn with the real sprites (pack's or game's) and the chosen scaling, click to select / double-click to draw; right panel: piece name and path, big preview with slice guides, vanilla size / size in the pack / used on, How it stretches (Stretch / Tile / Nine-slice, four borders, help text, preview at 3 widths), generated `.mcmeta`, "Draw this piece" (editor), Revert | Vitest for state; screenshot vs mockup |
| 7 | Pre-1.20.2 fallback: the same screen shows the shared images with the selected piece's rectangle; "Draw this piece" edits only that rectangle (reuse the editor's region mode from stage 4) | real app on the 1.8.9 test pack + disk check that pixels outside the rectangle are unchanged |
| 8 | Verify in the real app (1.21.11 and 1.8.9 test packs), screenshots | real app + disk checks |

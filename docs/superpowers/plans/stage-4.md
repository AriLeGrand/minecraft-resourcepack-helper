# Stage 4 plan: game previews

Screens: Editor and Animation preview tabs (3D), Particle viewer (screen 7,
mockup `docs/mockups/Particles.dc.html`). Built in two parts, one after the other.

## Part A: 3D block preview

Facts (checked in the extracted jars): block models live in
`assets/minecraft/models/block/*.json`, with `parent` chains
(`oak_stairs` → `block/stairs` → `block/block`), `textures` variables
(`#side`), and `elements` (`from`, `to`, `rotation`, `faces` with `uv`,
`texture`, `rotation`, `tintindex`, `cullface`). 1.8.9 uses the same format
with old texture names (`blocks/planks_oak`) and no `minecraft:` prefix.
A pack may override models, so the pack's own model files win over vanilla.

| # | Step | Test |
|---|---|---|
| A1 | Rust `core/src/models.rs`: resolve a block model (pack first, then vanilla): follow parents (with a depth limit and loop detection), merge `textures`, take the nearest `elements`, resolve `#variables` to texture paths, default face UVs from `from`/`to`, keep face rotation, tint index and element rotation | unit tests with synthetic model files: parent chain, overrides, missing parent, loop, default UVs, 1.8.9-style names |
| A2 | Rust: which models to offer for a texture: "Cube" plus the block models that use it (index `used_by` + direct search), sorted with the most useful first (the block of the same name, stairs, slab, wall, fence…); models without elements (built-in, e.g. chests) are left out | unit tests |
| A3 | Commands `block_model(name)` and `models_for_texture(path)` | cargo test |
| A4 | Front-end `BlockPreview` with three.js: model elements to boxes with per-face UVs (pixel-exact, NearestFilter, no mip-maps), element rotation, simple directional shading like the game (top bright, sides darker), transparent textures (alpha cut-out), grass/foliage tint shown as the default plains green; drag to rotate, light and dark backgrounds, model picker | Vitest for the geometry maths (UV mapping, face rotation, element rotation); screenshot |
| A5 | Live update: the texture being edited is taken from the open document (current frame, all visible layers) on every change; other textures of the model come from the pack if it has them, else from the game. Animated textures play at game speed in the Animation screen's preview | manual run |
| A6 | Wire the "3D" tab in the Editor preview and replace the CSS cube in the Animation preview | screenshot vs mockups |

## Part B: particle viewer

Facts: from 1.14 each particle has `assets/minecraft/particles/<id>.json`
listing frame images in `textures/particle/`. Before 1.14 all particles share
`textures/particle/particles.png` (16×16 grid of 8×8 cells); the cell map is
`core/data/particle_sheet.json` (`core/src/particles.rs`). Explosion uses
`entity/explosion.png` (4×4 grid), footsteps `particle/footprint.png`.

| # | Step | Test |
|---|---|---|
| B1 | Rust: particle list for the pack's version: modern = every `particles/*.json` (pack first, then vanilla), with its frame texture paths and status (done if every frame exists in the pack); legacy = the sheet map (`particles_in(version)`) with cells and shared-with lists | unit tests with synthetic files |
| B2 | Rust: a modern particle's JSON for the pack (write `particles/<id>.json` only when the frame list changes); adding a frame | unit tests |
| B3 | Editor support for "edit only these cells": open `particle/particles.png` with a fixed editable region (the particle's cells); drawing, fill, paste and move are clipped to it; a banner says which cells are shared with which particles | Vitest: clipped tools never change pixels outside the region |
| B4 | Particle viewer screen as in the mockup: list with search and frame/cell counts; scene (Night / Day / Underwater), speed ¼× / 1× / 2×, Your pack / Vanilla, optional emitter (torch / campfire / block), "N particles alive"; particles drawn with their real textures (pack or vanilla, frames over their lifetime or random as in `mode`); movement presets per particle family (rise and fade for smoke, fall for drips, burst for explosion, inward for portal/enchant, float for notes/hearts), clearly approximate; right panel: modern = frames grid, "Edit frames", "Add frame", particle file JSON; legacy = sheet with the particle's cells highlighted, "only this particle" frames, shared-cell warning, "Edit only these cells"; the warning that a pack changes how particles look, not how they move | Vitest for the simulation step and the cell maths; screenshots vs mockup |
| B5 | Section bar "Particles" opens the viewer; the browser's particle textures keep working | manual run |
| B6 | Verify in the real app with the 1.21.11 test pack and a 1.8.9 test pack (legacy sheet): edit one particle's cells, save, check on disk that pixels outside those cells are byte-identical | real app + disk check |

# Package B: 3D scene and lighting

## Decisions

**D-? · Scene: blocks by id, default state, no rotations.** A scene cell holds a
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

**D-? · Scene: hidden faces and render layers.** A face with a `cullface` is
dropped when the neighbour on that side is a full opaque block: an unrotated
0..16 box with all six faces whose render layer is solid. Glass-like blocks
(glass, stained glass, ice) also drop faces against the same block, as the
game does; leaves keep them (fancy graphics). The render layer comes from the
block id (the game hard-codes it per block): stained glass, ice, slime, honey
and water are translucent (blended, drawn last, no depth write), glass, leaves,
bars, spawner and similar are cut-out, the rest solid. All faces using one
texture are merged into one mesh (one draw call); the grass side overlay is
drawn after the side under it (meshes ordered by element index).

**D-? · Light: the game's lightmap.** `app/src/scene/light.ts` follows
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

**D-? · Ambient occlusion.** Per vertex, like the game's smooth lighting: the
layer in front of the face (the next cell for a face on the cell's side, the
cell itself for a face inside it, such as a slab top) gives two side
neighbours and a corner neighbour; an occluder counts 0.2, a free cell 1.0, the
corner counts as occluded when both sides are, and the vertex gets the average
of those three and the front (1.0): 1, 0.8, 0.6 or 0.4. Occluders are full
blocks except glass-like ones (leaves count, as their collision shape is
full). Models with `ambientocclusion: false` (plants) and rotated faces get
none. Quads are split along their brighter diagonal. The single-block previews
have no neighbours, so they have no AO control.

**D-? · Live textures in the Scene.** The scene subscribes to the editor store:
every open editor tab of the same pack whose texture the scene uses is
flattened (current frame, visible layers, the tool preview included) into a
canvas texture, on the next animation frame after each change. Closing the tab
puts the file back (pack file, else the game's). A label says how many unsaved
textures are shown.

**D-? · Custom scene file.** `.packcreator/scene.json` (never exported):
`{"version": 1, "width", "depth", "height", "blocks": [...]}`, ids per cell
(`""` = air), index `(y · depth + z) · width + x`, at most 8 × 8 × 4. Rust
checks sizes, cell count and block names before writing, and writes through a
temporary file and a rename. It is saved 400 ms after the last change (and when
leaving the screen). A damaged file is reported with what to do (delete it; no
texture is affected) and a new scene is shown.

## README

**Scene** shows a small diorama of blocks in 3D with your pack's textures (the
game's where the pack has none), including unsaved changes from any open
editor tab: a little house, a 4 × 4 wall of one block to check tiling and
seams, a garden, or your own scene of up to 8 × 8 × 4 blocks painted layer by
layer and saved with the pack. Choose day, sunset or night and a block light
level 0–15 (the game's brightness curve), turn ambient occlusion on or off,
orbit, pan, zoom or look from eye height. Click a block to see its textures and
open them in the editor. The editor and animation 3D previews have the same
time-of-day and light controls.

## Limitations

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

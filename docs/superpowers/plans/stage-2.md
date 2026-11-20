# Stage 2 plan: pixel editor

Screen: 3 (Editor). The 3D and Animated preview tabs come in stages 3 and 4.

## Design

- **Document model** (`app/src/editor/doc.ts`, pure TypeScript): width, height,
  layers (name, visible, locked, opacity, RGBA pixels), optional selection mask.
  Ready for frames (stage 3): a document holds a list of frames, each frame a
  list of layer images; stage 2 uses one frame.
- **Pixel logic** (`app/src/editor/pixels.ts`, `tools/*.ts`): every tool is a
  pure function over pixel buffers (no DOM), tested with Vitest.
- **Rendering** (`Canvas.tsx`): one HTML canvas; layers are composited at
  texture size and drawn scaled with hard pixels; pixel grid from 400% zoom;
  checkerboard for transparency; tiled mode draws the image 3×3.
- **Undo/redo** (`history.ts`): command stack of rectangular before/after
  patches per layer, plus structural commands (add/remove/reorder layer).
- **Working files** (Rust, `core/src/workfile.rs`): `.packcreator/work/<texture>.json`
  holds layers (PNG, base64) and editor state. "Save to pack" writes the
  flattened PNG into the pack and the working file. If the PNG in the pack is
  newer than the working file (edited externally), the PNG wins and is loaded
  as a single layer. Working files are never exported (already excluded).
- **Never lose work**: closing a tab, switching pack or quitting with unsaved
  changes asks Save / Discard / Cancel. The save always targets the document's
  own texture path (this is where the old plugin had its bug).

## Steps and how each is tested

| # | Step | Test |
|---|---|---|
| 1 | `workfile.rs`: load (work file, pack PNG, or vanilla enlarged), save (flat PNG + work file), stale detection | Rust unit tests in temp dirs, round-trip of layers, external-edit case |
| 2 | Commands `editor_open`, `editor_save`; frontend document model and compositing | Vitest: composite with opacity/visibility; Rust tests above |
| 3 | Canvas: zoom (wheel, Z, +/-, Fit), pan (H, space, middle mouse), grid, checkerboard, cursor preview, status bar coordinates | Vitest for view maths (screen ↔ pixel); screenshot |
| 4 | Drawing tools: pencil (size, pixel-perfect), eraser, line, rectangle, ellipse, bucket, eyedropper, spray, gradient, curve, contour/polygon, shading ink, blur/jumble, text | Vitest per tool on small buffers (exact pixels) |
| 5 | Selection: rectangle, lasso, magic wand, move, select all/none, delete, copy/cut/paste | Vitest for masks, flood select, move and paste |
| 6 | Tool options: size, ink (simple, alpha, lock alpha, shading), opacity, pixel-perfect, symmetry, tiled mode (wrap-around drawing), onion skin toggle (used in stage 3) | Vitest for symmetry, wrap and inks |
| 7 | Layers panel: add, delete, duplicate, rename, visibility, lock, opacity, reorder; locked 30% vanilla reference layer (never saved into the texture) | Vitest for layer operations and flatten (reference excluded) |
| 8 | Palette ("from vanilla", "from image") and colour picker (HSV + hex + alpha), foreground/background, X to swap | Vitest for colour maths and palette extraction |
| 9 | Undo/redo, tabs with unsaved markers, Save / Discard / Cancel on close | Vitest for the history stack; manual run |
| 10 | Preview panel: Tiled and Original tabs; Aseprite-like shortcuts | Screenshot vs `AppEditor` mockup |
| 11 | Wire "Edit texture" / double-click in the browser to the editor; "Draw" for the pack icon | Manual run: edit, save, see it in the browser and in the export |

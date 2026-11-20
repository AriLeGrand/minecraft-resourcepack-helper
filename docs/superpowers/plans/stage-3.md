# Stage 3 plan: animation

Screen: 4 (Animation, mockup `docs/mockups/Animation.dc.html`). Builds on the
stage 2 editor: an animated texture is one editor document with several frames.

## Model

- Images: the document's frames (one image per frame, all layers). Saved as
  one vertical strip (frame 0 on top), never resized.
- Play order: `animation.frames` in the `.mcmeta`. `None` = every image top to
  bottom. Entries may repeat images and may carry their own `time` (ticks).
- Timing: `frametime` ticks per entry (default 1), 1 tick = 50 ms.
  `interpolate` blends each entry into the next.
- The `.mcmeta` text is produced by Rust (`mcmeta::write_animation`), the same
  function used when saving, and keeps unknown keys and other sections.

## Steps and how each is tested

| # | Step | Test |
|---|---|---|
| 1 | Rust: command that returns the `.mcmeta` text that a save would write (merged with the pack's existing file) | unit test: unknown keys kept, frames with times, default animation |
| 2 | Rust: round-trip check of `.mcmeta` over every vanilla file in an extracted cache (dev-only test, skipped when no cache) + synthetic round-trip tests | `cargo test` |
| 3 | Rust: read any image as raw RGBA for "Import strip" (pixel-exact) | unit test with a synthetic strip |
| 4 | TS `anim.ts`: playback timeline (which entry/image at time t, loop length, interpolation weight), ping-pong order, frame ops (new, duplicate, delete, move) that keep the play order consistent, strip split | Vitest with exact numbers |
| 5 | Editor store: frame operations as undo steps; play order and settings stored on the document; dirty flag | Vitest through the controller tests |
| 6 | Animation screen: big frame view (editable with the current tool, onion skin ±1), toolbar (first/play/last, onion skin, loop, new, duplicate, import strip), frame strip with per-frame duration editing and drag/reorder buttons, in-game preview (flat + CSS 3D cube) at real speed with interpolation, `.mcmeta` settings (frametime, interpolate, frame order editor with presets: in order, ping-pong, custom), generated file panel, status bar (frames, size, loop length, target path) | screenshot vs mockup |
| 7 | Wiring: section bar "Animation" opens the active texture; "Open animation view" from the editor; editor preview tab "Animated" plays at in-game speed | manual run |
| 8 | Verify in the real app: make a 6-frame animation, ping-pong, save, check strip + `.mcmeta` on disk, reopen | real app + disk check |

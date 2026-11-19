# Stage 1 plan: foundation and texture browser

Screens: 1 (Start), 2 (Texture browser), 5 (Pack and export), plus a small Settings screen.

## Layout

- `app/core` — pure Rust, all logic, unit-tested with synthetic PNGs and jars
  built by the tests (never Mojang files).
- `app/src-tauri` — Tauri 2 shell: thin commands, image protocol, file watcher.
- `app/src` — React + TypeScript + Zustand UI. Fonts bundled (Inter, JetBrains Mono).
- `tools/shot.mjs` — takes screenshots of the real running app (WebView2 debug port).

## Steps and how each is tested

| # | Step | Test |
|---|---|---|
| 1 | `minecraft.rs`: find `.minecraft`, list versions (jar or not, real id, format) | unit tests on a fake `.minecraft` tree: no folder, no jar, corrupted jar, modded profile |
| 2 | `extract.rs`: read textures (+ `.mcmeta`, model/particle JSON) from the jar with the `zip` crate into `cache/vanilla/<version>/`; atomic; safe paths | unit tests with a synthetic jar; corrupted jar; re-run is a no-op; zip-slip entry ignored |
| 3 | `textures.rs`: categories, texture index (size, animated, frames, used-by models), thumbnails (first frame, max 64 px, nearest) | unit tests for categories, PNG header reading, index of a synthetic jar, thumbnail sizes |
| 4 | `mcmeta.rs`: read/write animation `.mcmeta`, keep unknown keys | round-trip tests incl. object frames and foreign sections |
| 5 | `pack.rs`: create/open pack (`pack.mcmeta`, placeholder `pack.png`, `.packcreator/project.json`), scan pack, statuses (to do / done / changed since export) | unit tests in temp dirs; read-only folder error |
| 6 | `import.rs`: import image pixel-exact (bytes kept for PNG), tall image offered as frames, start-from-vanilla copy, revert to trash | byte-equality tests, strip detection tests |
| 7 | `export.rs`: checks with fixes, export folder/zip, install into `resourcepacks`, copies for other versions with the rename table, only-changed option | unit tests reading the produced zip back; rename to 1.12 names; skipped textures |
| 8 | `settings.rs`: settings + recent packs in the app data folder | round-trip, corrupt file falls back to defaults |
| 9 | Tauri shell: commands, `pcimg` image protocol (only cache and open pack), `notify` watcher, external editor launch | `cargo test`, clippy; manual run |
| 10 | UI shell + visual system (top bar, section bar, status bar, toasts, Ctrl+K) | typecheck, lint, Vitest for pure helpers; screenshots vs mockups |
| 11 | Start screen | screenshot vs `Welcome` mockup; create a pack for real |
| 12 | Texture browser (virtualised list, search across categories, filters, inspector, actions) | Vitest for filtering/virtual window maths; screenshot vs `Browser`; scroll test with 3000+ rows |
| 13 | Pack and export screen (`§` preview, checks, export) | Vitest for `§` parsing; screenshot vs `Export`; real export to a scratch folder |
| 14 | Settings screen; error cases (no Minecraft, no jar, corrupted jar, read-only) | unit tests + manual with a fake `.minecraft` |
| 15 | `tauri build` Windows installer | installer file exists; app starts |

## Out of this stage

Pixel editor (stage 2): "Edit texture" opens the texture externally for now.
"Port to another version" on the start screen uses the same code as "also
export for"; a dedicated porting screen is listed for later in the design.

# Progress

Read this first when resuming. Kickoff instructions: `docs/superpowers/kickoff-prompt.md`.
Design: `docs/superpowers/specs/2026-11-19-pack-creator-design.md`.
Decisions: `docs/DECISIONS.md`. Facts: `docs/research/domain-facts.md`.

## Current stage

**Stage 1: foundation and texture browser** — starting (plan: `docs/superpowers/plans/stage-1.md`).

## Done

- **Setup** (2026-11-19): git, Rust 1.99 (MSVC), Node 22 + npm, VS 2022 C++
  tools and WebView2 were already installed. Nothing had to be installed.
  Minecraft found in `%APPDATA%\.minecraft`; jars for 1.8.9, 1.20.1, 1.20.4
  (Fabric), 1.21.1, 1.21.5, 1.21.8, 1.21.11.
- **Stage 0** (2026-11-19): design facts checked against the real jars
  (`docs/research/domain-facts.md`), design corrected (D-001…D-006),
  version data built and tested in `app/core`:
  - `data/pack_formats.json` + `src/pack_format.rs` (read `version.json`,
    fallback table, write/read `pack.mcmeta`);
  - `data/renames.json` + `src/renames.rs` (Flattening + later renames,
    both directions, name history);
  - `data/particle_sheet.json` + `src/particles.rs` (legacy sheet cells);
  - `src/version.rs` (version parsing and ordering).

## Next

Stage 1 steps, in order: see the plan file.

## Known issues / notes

- Drive C: has little free space (about 5 GB). Build output is on D:.
- No 1.12.2 / 1.13 jar installed: part of the rename table is not verified
  locally (D-006).
- `pack.mcmeta` for 1.21.9+ should be checked once in-game (D-005).
- The file `minecraft-resourcepack-helper..aseprite-extension` in the repo
  root is the owner's untracked build of the old plugin; leave it alone.

## How to run

```
cd app
cargo test            # core tests
```

(The desktop app arrives in stage 1; this section will list `npm run tauri dev`.)

## Checks before each commit that ends a step

```
cd app
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Research scripts (developer only)

```
python tools/research/inspect_jars.py > facts.json
python tools/research/compare_versions.py > renames-report.json
python tools/research/build_rename_table.py renames-report.json app/core/data/renames.json
```

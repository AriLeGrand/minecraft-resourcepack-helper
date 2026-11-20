# Contributing to Blockwright

Thanks for wanting to help! Bug reports, ideas, fixes, translations of texture
names, new GUI screens or particle data: every bit makes the app better for
pack makers.

By contributing, you agree that your work is published under the
[MIT License](LICENSE), like the rest of the project.

## Ways to help

- **Report a bug** or **suggest an idea** with the
  [issue forms](https://github.com/AriLeGrand/minecraft-resourcepack-helper/issues/new/choose).
  Please search the existing issues first.
- **Check something in the game.** Several features are verified against the
  game's files but not yet in the game itself (see
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md)). Trying an exported pack in a
  real Minecraft version and reporting what you see is very useful.
- **Send a pull request** for a bug fix or a feature. For anything larger than
  a small fix, open an issue first so we can agree on the approach.

## Ground rules

These keep the app safe for people's packs and legal to share. Pull requests
that break them cannot be merged.

1. **No Mojang files, ever.** Never commit Minecraft textures, sounds, models
   or jars, not even a single icon. Tests use synthetic images and fake jars;
   screenshots come only from the demo game (`tools/demo/make_demo_minecraft.py`).
2. **Never change the user's images behind their back.** Imported images are
   kept pixel for pixel: no resizing, no colour changes, no re-encoding that
   alters pixels.
3. **Never lose unsaved work.** Anything that closes, replaces or deletes must
   ask first or keep the old file (in the pack's `.packcreator\trash` or
   history).
4. **Logic that must be right lives in Rust, with tests.** Pack formats,
   renames, extraction, export and file writes belong in `app/core` with unit
   tests. The interface (`app/src`) stays thin.
5. **Plain words in the interface.** Write for pack makers, not programmers:
   short sentences, no jargon, say what will happen.
6. **The old Aseprite plugin is frozen.** Do not change `main.lua` or
   `modules/*.lua`.

## Getting started

You need **Rust** (stable, MSVC toolchain), **Node.js** 20+ and the
**Microsoft C++ Build Tools**. Then:

```powershell
git clone https://github.com/AriLeGrand/minecraft-resourcepack-helper.git
cd minecraft-resourcepack-helper/app
npm install
npm run tauri dev
```

To work without your real game, make the demo game and choose its folder in
Settings:

```powershell
python tools/demo/make_demo_minecraft.py app/target/devdata/demo/.minecraft
```

[docs/PROGRESS.md](docs/PROGRESS.md) ("How to run") explains how to run the
app with separate settings and cache folders, and how the screenshot tool
works.

## Before you open a pull request

Run the same checks as the GitHub build, from `app/`:

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run check
npm run build
```

Then:

- **Add or update tests** for what you changed.
- **Try it in the app**, on the demo game, and describe what you checked.
- **Write down decisions.** If you made a choice someone might later wonder
  about (a file format, a game fact, a trade-off), add an entry at the end of
  [docs/DECISIONS.md](docs/DECISIONS.md) with the next number. Update
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and the README when they change.
- **Keep it focused**: one fix or feature per pull request.

## Commits and pull requests

- Commit subjects say what changed in plain words ("Seam check ignores
  stripes that repeat inside"); the body says why.
- Never force-push a shared branch or rewrite published history.
- Never commit secrets, personal paths or screenshots of a real game.
- Pull requests target `main`. The build workflow must be green before merge.

## Where things are

| Folder | What is in it |
|---|---|
| `app/core` | Rust logic with tests; data tables (pack formats, renames, GUI regions, particles) in `app/core/data` |
| `app/src-tauri` | Desktop shell: commands, image protocol, file watcher |
| `app/src` | Interface (React + TypeScript), tests next to the code |
| `site/` | Presentation website |
| `docs/` | Decisions, progress, limitations, checked game facts |
| `tools/` | Research scripts, screenshot tool, demo game |

## Code of conduct

Be kind and patient. Assume good intent, explain instead of judging, and keep
discussions about the work. Harassment or insults are not accepted in issues,
pull requests or anywhere else in the project.

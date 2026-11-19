# Decisions

Calls made while building, and corrections to the design document.
Newest at the bottom.

## Stage 0 (2026-11-19)

**D-001 · `pack_version` is not a single field.** The design says newer jars
contain a `pack_version` field. In real jars it is an object
(`{resource, data}`), and from 1.21.9 `{resource_major, resource_minor, …}`;
1.14–1.16 used a plain number. The core reads all three. Design §5 corrected.

**D-002 · Particle sheet geometry.** The design says "grid of 8×8 cells at 16×".
The real 1.8.9 sheet is 128×128: a 16×16 grid of 8×8-pixel cells. The
enchanting glyphs are cells 225–250 (the mockup shows 224–249). The fishing
bobber also lives on the sheet (cell 33). Explosion and footprint are separate
files. Design §5 corrected.

**D-003 · GUI scaling `border`.** It can be a number or an object with
`left/top/right/bottom`; newer versions add `stretch_inner`. Vanilla only
writes `nine_slice` files; no file means "stretch". Design §5 corrected. The
interface editor (stage 5) must offer four separate borders, as the mockup does.

**D-004 · Animation `.mcmeta` has more keys.** `height`/`width`, optional
`frames`, frame entries as objects, and non-animation sections (`texture`,
`villager`). The app must keep keys it does not edit. Design §5 corrected.

**D-005 · `pack.mcmeta` for 1.21.9+.** From format 65 the app writes
`min_format`/`max_format` (a number, or `[major, minor]` when the minor is not
0) and no `pack_format`. When a pack also targets older formats it writes
`pack_format` + `supported_formats` as well. This follows the Minecraft Wiki;
the client jar has no `pack.mcmeta` to compare with, so **please check once
in-game that a pack exported for 1.21.11 shows as compatible.**

**D-006 · Rename table sources.** Built by comparing pixels between the
installed 1.8.9 jar, the launcher's Programmer Art pack and the modern jars
(293 entries), plus 61 hand-set entries and 74 from the Minecraft Wiki for
textures added in 1.9–1.12 (no local jar to verify). The 1.14 and 1.17 steps
are from memory. Exact versions of the 1.21.2 / 1.21.4 / 1.21.9 steps are from
memory (the local jars only prove "between 1.21.1 and 1.21.5", etc.). Entity
texture reorganisations are out of scope. Installing 1.12.2 and 1.13.2 once
would let `tools/research/compare_versions.py` verify the rest.

**D-007 · Repository layout.** `app/` is a Cargo workspace: `app/core`
(pure Rust, no Tauri, all correctness-critical logic and data, fast tests) and
`app/src-tauri` (the desktop shell, thin commands). The UI is in `app/src`.

**D-008 · Version identity.** A version folder is identified by the `id` in
its jar's `version.json` when present (so Fabric/Forge profiles map to their
real game version), otherwise by a release number found in the folder name.
Snapshots that cannot be parsed are placed on the version line by their pack
format.

**D-009 · Research scripts are Python** (`tools/research/`, standard library
only). They are developer tools, not part of the app, and never write textures.

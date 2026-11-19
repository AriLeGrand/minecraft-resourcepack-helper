# Domain facts, checked against real game files

Date: 2026-11-19. Checked by reading the installed client jars directly
(`tools/research/*.py`). Nothing was extracted to disk and no texture was copied
into the repository; the scripts only print names, sizes and small JSON snippets.

Jars read (`%APPDATA%\.minecraft\versions\<v>\<v>.jar`):
1.8.9, 1.20.1, 1.20.4 (Fabric profile), 1.21.1, 1.21.5, 1.21.8, 1.21.11.
The Fabric profiles (`fabric-loader-…-1.20.1`, `…-1.20.4`) contain a plain copy
of the vanilla jar; their real version is the `id` in `version.json`.
Seven version folders have no jar (never launched, or modded profiles):
they must be shown as "not available", not as errors.

No 1.12.2 or 1.13 jar is installed, so anything about 1.9–1.13 that could not
be derived from 1.8.9 or the modern jars is marked **not verified locally**.

## 1. `version.json` and `pack_format`

| Jar | `pack_version` in `version.json` |
|---|---|
| 1.8.9 | no `version.json` at all |
| 1.20.1 | `{"resource": 15, "data": 15}` |
| 1.20.4 | `{"resource": 22, "data": 26}` |
| 1.21.1 | `{"resource": 34, "data": 48}` |
| 1.21.5 | `{"resource": 55, "data": 71}` |
| 1.21.8 | `{"resource": 64, "data": 81}` |
| 1.21.11 | `{"resource_major": 75, "resource_minor": 0, "data_major": 94, "data_minor": 1}` |

- The field is **not one number**. Three shapes exist: a plain number (1.14 to
  1.16, not verified locally), `{resource, data}`, and from 1.21.9
  `{resource_major, resource_minor, …}`. The core reads all three.
- `version.json` also gives the real version `id` (useful for modded profiles)
  and `world_version`.
- The fallback table (`app/core/data/pack_formats.json`) matches every value
  read from a jar. The rest of the table comes from the Minecraft Wiki
  "Pack format" page (read 2026-11-19), including the year-based versions
  (26.1 = 84.0, 26.2 = 88.0, 26.3 = 97.1).
- `pack.mcmeta`: `supported_formats` exists from format 18 (1.20.2). From
  format 65 (1.21.9) the game uses `min_format` / `max_format`. The client jar
  has no `pack.mcmeta`, so the exact accepted shapes could not be checked
  locally (see DECISIONS).

## 2. Texture folders

Top-level folders under `assets/minecraft/textures/` (PNG counts):

| Folder | 1.8.9 | 1.20.1 | 1.21.1 | 1.21.11 |
|---|---|---|---|---|
| `blocks` / `block` | 373 (`blocks`) | 928 | 1012 | 1111 |
| `items` / `item` | 227 (`items`) | 582 | 605 | 792 |
| `entity` | 142 | 481 | 524 | 615 |
| `gui` | 43 | 86 | 476 | 523 |
| `particle` | 2 | 194 | 228 | 254 |
| `painting` | 1 (one sheet) | 31 | 51 | 52 |
| `mob_effect` | – | 33 | 39 | 40 |
| `environment` | 6 | 6 | 6 | 14 |
| `models` (armor) | 12 | 15 | 15 | – (moved in 1.21.2) |
| `trims` | – | 51 | 55 | 57 |
| `map` | 2 | 3 | 37 | 37 |
| `font` | 224 | 5 | 5 | 5 |
| `colormap`, `effect`, `misc` | yes | yes | yes | yes |
| **Total** | 1043 | 2431 | 3070 | 3517 |

- `blocks`/`items` → `block`/`item` at 1.13 is confirmed (1.8.9 vs 1.20.1).
- Block textures are not all 16×16: animated strips (16×32 … 16×512), and a
  few 32×32 textures in 1.21.8+. In 1.8.9 `water_flow`/`lava_flow` are 32 wide.
- Old versions keep things in single sheets that are separate files today:
  paintings (one sheet in 1.8.9), mob effect icons (inside `gui/container/inventory.png`),
  GUI icons, particles.

## 3. Renames

Method: decode every texture and compare **pixels** (the same image is often
re-compressed, so file bytes differ).

- 1.8.9 names vs the "Programmer Art" pack the launcher downloads (old pixels
  under post-1.13 names) and the modern jars: **293** block/item renames found
  automatically, 341 textures keep their name (folder change only).
- 61 entries were set by hand: textures redrawn before 1.13 (wool, some doors),
  ambiguous matches (several identical images, e.g. crop stages, leaves, stems),
  and targets that were renamed again later.
- 74 entries for textures added in 1.9–1.12 (concrete, glazed terracotta,
  shulker boxes, …) come from the Minecraft Wiki page
  "Java Edition 1.13/Resource pack changes". **Not verified locally.**
- Between modern versions (verified by pixels): `block/grass` → `short_grass`
  (1.20.3), `item/scute` → `turtle_scute` (1.20.5), 96 armor/equipment/slot
  moves (seen between 1.21.1 and 1.21.5; assigned to 1.21.2), `entity/chicken`
  → `entity/chicken/temperate_chicken` (1.21.5), `chain` → `iron_chain` (1.21.9),
  `environment/sun` → `environment/celestial/sun` (1.21.11).
- Known from memory only (**not verified locally**): the 1.14 renames (dyes,
  `sign` → `oak_sign`, `stone_slab_*` → `smooth_stone*`) and 1.17
  (`grass_path_*` → `dirt_path_*`).
- Not covered: entity texture reorganisations (horses, chests, banners,
  villagers…) and the old single sheets. These are different layouts, not renames.

Result: `app/core/data/renames.json` (428 Flattening entries + 113 later ones).

## 4. GUI

- 1.20.1: no `gui/sprites/` folder; `gui/widgets.png` and `gui/icons.png`
  (256×256) exist. 1.20.4 and later: `gui/sprites/` with 400–445 PNGs;
  `widgets.png` and `icons.png` are gone. So "from 1.20.2" is consistent
  (1.20.2 itself is not installed).
- Sprite sub-folders (1.21.11): advancements, boss_bar, container, dialog,
  gamemode_switcher, hud, icon, notification, pending_invite, player_list,
  popup, realm_status, recipe_book, server_list, social_interactions,
  spectator, statistics, toast, tooltip, transferable_list, widget, world_list.
- Scaling files: only `nine_slice` appears explicitly in vanilla (19 files in
  1.20.4, 37 in 1.21.11). A sprite without `.mcmeta` is stretched.
  - `border` is either one number or an object
    `{"left": 2, "top": 2, "right": 2, "bottom": 3}`.
  - From 1.21.5 a `stretch_inner` key also appears.
  - GUI sprites can be animated too (`{"animation": {"frametime": 2}}`).
- Many screens are still one big image in every version
  (`gui/container/*.png`, 256×256).

## 5. Particles

- 1.8.9: `particle/particles.png` is 128×128 = a **16×16 grid of 8×8 px cells**,
  plus `particle/footprint.png` (8×8) and `entity/explosion.png` (128×128 =
  4×4 frames of 32 px). No `particles/*.json`.
- 1.20.1+: 88–104 `assets/minecraft/particles/<name>.json` files
  (`{"textures": ["minecraft:generic_7", …]}`), one image per frame in
  `textures/particle/` (mostly 8×8, also 16×16 and 32×32).
- The cell map was verified by comparing each cell of the real 1.8.9 sheet
  with the separate 1.20.1 images: generic 0–7 → cells 0–7, splash → 19–22,
  bubble 32, flame 48, lava 49, note 64, enchanted_hit 66, heart 80, angry 81,
  glint 82, drip_hang 112, drip_fall 113, effect → 128–135, spell → 144–151,
  spark → 160–167, the 26 enchanting glyphs → **225–250**, and the 16 explosion
  frames in order. Cell 33 is the **fishing bobber**, not a particle.
- `critical_hit` (65) and `drip_land` (114) were redrawn later; their position
  comes from the neighbouring cells and the game code layout.
- `damage` (67) and `glitter` (176–183) are empty in 1.8.9; they are used from
  1.9 (**not verified locally**).
- 21 non-empty cells are not used by any particle (old leftovers).

Result: `app/core/data/particle_sheet.json`.

## 6. Animations

- Frames are stacked vertically; the frame is square by default.
  `water_still.png` is 16×512 with `{"animation": {"frametime": 2}}`.
- Keys seen in vanilla: `frametime`, `interpolate`, `frames`, `height`
  (2 files). `frames` is optional (then frames play top to bottom).
  All vanilla `frames` entries are plain numbers; the format also allows
  `{"index": n, "time": t}` objects, which the app must read and keep.
- `.png.mcmeta` files are not only animations: `{"texture": {"blur": true}}`
  and `{"villager": {...}}` also exist and must be preserved untouched.
- No vanilla block or item texture is tall without having an `.mcmeta`.
- Animated counts: 11 (1.8.9), 52 (1.20.1), 57 (1.21.11).

## 7. Corrections to the design document

See `docs/DECISIONS.md` (D-001 to D-006).

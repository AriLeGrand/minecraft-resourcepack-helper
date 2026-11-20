//! Connected textures (OptiFine, or the Continuity mod on Fabric): blocks
//! that join their neighbours, like glass without a frame between panes.
//! Without one of those mods the game ignores these files.
//!
//! The app writes the "compact" method (`method=ctm_compact`, five tiles):
//! `assets/minecraft/optifine/ctm/<block>/0.png … 4.png` and
//! `assets/minecraft/optifine/ctm/<block>/<block>.properties`. OptiFine reads
//! the same folder before 1.13; there `matchBlocks` uses the old block ids
//! (`glass`, which are the block state file names of that version).
//!
//! What each tile is (from Continuity's `CompactCtmQuadProcessor`, which
//! reimplements OptiFine's compact method):
//! * 0: no connection, the full border;
//! * 1: connected on every side (and the corners), no border;
//! * 2: connected up and down: borders left and right only;
//! * 3: connected left and right: borders top and bottom only;
//! * 4: connected on every side but not across the corners: no border except
//!   small inner corners.
//!
//! The game cuts each face in four quarters and takes each quarter from one of
//! these tiles; `app/src/variety/ctm.ts` does the same for the preview.
//!
//! Starting tiles are made from the block's texture `T` (border width
//! `b` = texture width / 16, at least 1 pixel). "Removing" a side copies the
//! band of `b` pixels just inside it over the border band, so the pattern
//! inside continues to the edge. Tile 0 = `T`; tile 1 = all four sides
//! removed; tile 2 = top and bottom removed; tile 3 = left and right removed;
//! tile 4 = tile 1 with `T`'s four `b`×`b` corners put back. The user then
//! draws them properly in the editor.

use crate::error::{CoreError, IoCtx, Result};
use crate::import::move_to_trash;
use crate::pack::now_ms;
use crate::textures::{is_safe_texture_path, texture_file};
use crate::variants::{block_textures, is_block_name, Roots};
use crate::workfile::{optifine_png, work_file_of, OPTIFINE_PREFIX};
use image::RgbaImage;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const TILES: u32 = 5;
/// The `faces` values the screen offers.
pub const FACES: [&str; 3] = ["all", "sides", "top bottom"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

/// Copies the band just inside a side over the border band of that side.
fn remove_side(img: &mut RgbaImage, side: Side, b: u32) {
    let (w, h) = img.dimensions();
    let src = img.clone();
    match side {
        Side::Left | Side::Right => {
            if w < 2 * b {
                return;
            }
            for y in 0..h {
                for i in 0..b {
                    let (x, from) = match side {
                        Side::Left => (i, i + b),
                        _ => (w - 1 - i, w - 1 - i - b),
                    };
                    img.put_pixel(x, y, *src.get_pixel(from, y));
                }
            }
        }
        Side::Top | Side::Bottom => {
            if h < 2 * b {
                return;
            }
            for x in 0..w {
                for i in 0..b {
                    let (y, from) = match side {
                        Side::Top => (i, i + b),
                        _ => (h - 1 - i, h - 1 - i - b),
                    };
                    img.put_pixel(x, y, *src.get_pixel(x, from));
                }
            }
        }
    }
}

/// Border width used for a texture of this width.
pub fn border_width(width: u32) -> u32 {
    (width / 16).max(1)
}

/// The five starting tiles made from one block texture (see the module notes).
pub fn make_tiles(texture: &RgbaImage) -> Vec<RgbaImage> {
    let b = border_width(texture.width());
    let without = |sides: &[Side]| {
        let mut t = texture.clone();
        for s in sides {
            remove_side(&mut t, *s, b);
        }
        t
    };
    let all = [Side::Left, Side::Right, Side::Top, Side::Bottom];
    let mut corners = without(&all);
    let (w, h) = texture.dimensions();
    if w >= 2 * b && h >= 2 * b {
        for (cx, cy) in [(0, 0), (w - b, 0), (0, h - b), (w - b, h - b)] {
            for y in cy..cy + b {
                for x in cx..cx + b {
                    corners.put_pixel(x, y, *texture.get_pixel(x, y));
                }
            }
        }
    }
    vec![
        texture.clone(),
        without(&all),
        without(&[Side::Top, Side::Bottom]),
        without(&[Side::Left, Side::Right]),
        corners,
    ]
}

/// `tokens` for `matchBlocks`: block ids with optional namespace and states.
pub fn is_match_blocks(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && t.len() <= 400
        && !t.contains(['\n', '\r', '\t'])
        && t.split_whitespace().all(|tok| {
            tok.chars().all(|c| {
                c.is_ascii_lowercase()
                    || c.is_ascii_digit()
                    || matches!(c, '_' | '-' | '.' | ':' | '=' | ',' | '/')
            })
        })
}

/// The `.properties` file the app writes.
pub fn properties_text(block: &str, match_blocks: &str, faces: &str) -> String {
    format!(
        "# Connected textures for {block}, made by Pack Creator.\n\
         # Needs OptiFine or the Continuity mod; without one the game ignores this folder.\n\
         # Tiles: 0 no connection, 1 connected everywhere, 2 up and down, 3 left and right,\n\
         # 4 connected on every side but not across the corners.\n\
         matchBlocks={}\n\
         method=ctm_compact\n\
         tiles=0-4\n\
         faces={faces}\n\
         connect=block\n",
        match_blocks.trim()
    )
}

fn ctm_dir(pack: &Path, block: &str) -> PathBuf {
    pack.join("assets")
        .join("minecraft")
        .join("optifine")
        .join("ctm")
        .join(block)
}

fn properties_file(pack: &Path, block: &str) -> PathBuf {
    ctm_dir(pack, block).join(format!("{block}.properties"))
}

/// Editor path of tile `i` (opens in the built-in editor).
pub fn tile_path(block: &str, i: u32) -> String {
    format!("{OPTIFINE_PREFIX}ctm/{block}/{i}")
}

fn check_block(block: &str) -> Result<()> {
    if is_block_name(block) {
        Ok(())
    } else {
        Err(CoreError::new(
            "bad_block",
            format!("\"{block}\" is not a valid block name."),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tile {
    /// Editor path, e.g. `:optifine/ctm/glass/0`.
    pub path: String,
    /// Path inside the pack, e.g. `assets/minecraft/optifine/ctm/glass/0.png`.
    pub file: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CtmInfo {
    pub block: String,
    pub legacy: bool,
    /// Textures the block shows, most used first.
    pub textures: Vec<String>,
    /// What `matchBlocks` is set to by default (the block id).
    pub default_match: String,
    /// The pack's `.properties` file as it is on disk.
    pub properties: Option<String>,
    pub properties_file: String,
    pub tiles: Vec<Tile>,
}

/// What the screen shows about one block's connected textures.
pub fn info(r: Roots, block: &str) -> Result<CtmInfo> {
    check_block(block)?;
    let textures = block_textures(r, block)?;
    let tiles = (0..TILES)
        .map(|i| {
            Ok(Tile {
                path: tile_path(block, i),
                file: format!("assets/minecraft/optifine/ctm/{block}/{i}.png"),
                exists: optifine_png(r.pack, &format!("ctm/{block}/{i}"))?.is_file(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(CtmInfo {
        block: block.to_owned(),
        legacy: r.legacy,
        textures,
        default_match: block.to_owned(),
        properties: fs::read_to_string(properties_file(r.pack, block)).ok(),
        properties_file: format!("assets/minecraft/optifine/ctm/{block}/{block}.properties"),
        tiles,
    })
}

/// The texture to start from: the pack's, else the game's enlarged by
/// `scale`; only the first frame of an animation.
fn source_image(r: Roots, texture: &str, scale: u32) -> Result<RgbaImage> {
    let mine = texture_file(r.pack, texture)?;
    let (file, scale) = if mine.is_file() {
        (mine, 1)
    } else {
        (texture_file(r.vanilla, texture)?, scale.max(1))
    };
    let img = image::open(&file)
        .map_err(|e| {
            CoreError::new(
                "bad_image",
                format!("{} could not be read: {e}", file.display()),
            )
        })?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let frame = if h > w && h % w == 0 {
        image::imageops::crop_imm(&img, 0, 0, w, w).to_image()
    } else {
        img
    };
    Ok(if scale > 1 {
        image::imageops::resize(
            &frame,
            frame.width() * scale,
            frame.height() * scale,
            image::imageops::FilterType::Nearest,
        )
    } else {
        frame
    })
}

/// Writes the five starting tiles from `texture` and the `.properties` file.
/// Files already there go to the trash first.
pub fn create(
    r: Roots,
    block: &str,
    texture: &str,
    faces: &str,
    match_blocks: &str,
    scale: u32,
) -> Result<CtmInfo> {
    check_block(block)?;
    let texture = texture.strip_prefix("minecraft:").unwrap_or(texture);
    if !is_safe_texture_path(texture) {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{texture}\" is not a valid texture name."),
        ));
    }
    if !FACES.contains(&faces) {
        return Err(CoreError::new(
            "bad_faces",
            format!("\"{faces}\" is not one of: {}.", FACES.join(", ")),
        ));
    }
    if !is_match_blocks(match_blocks) {
        return Err(CoreError::new(
            "bad_match",
            format!("\"{match_blocks}\" is not a valid list of block ids."),
        )
        .hint("Use block ids separated by spaces, such as glass or minecraft:glass."));
    }
    let src = source_image(r, texture, scale)?;
    let tiles = make_tiles(&src);
    let stamp = now_ms();
    let dir = ctm_dir(r.pack, block);
    fs::create_dir_all(&dir).ctx(&dir)?;
    for (i, t) in tiles.iter().enumerate() {
        let file = optifine_png(r.pack, &format!("ctm/{block}/{i}"))?;
        move_to_trash(r.pack, &file, stamp)?;
        t.save_with_format(&file, image::ImageFormat::Png)
            .map_err(|e| {
                CoreError::new("io", format!("Could not write {}: {e}", file.display()))
            })?;
    }
    let props = properties_file(r.pack, block);
    move_to_trash(r.pack, &props, stamp)?;
    fs::write(&props, properties_text(block, match_blocks, faces)).ctx(&props)?;
    info(r, block)
}

/// Moves the tiles, their layers and the `.properties` file to the trash.
pub fn remove(r: Roots, block: &str) -> Result<CtmInfo> {
    check_block(block)?;
    let stamp = now_ms();
    for i in 0..TILES {
        let path = tile_path(block, i);
        move_to_trash(
            r.pack,
            &optifine_png(r.pack, &format!("ctm/{block}/{i}"))?,
            stamp,
        )?;
        move_to_trash(r.pack, &work_file_of(r.pack, &path)?, stamp)?;
    }
    move_to_trash(r.pack, &properties_file(r.pack, block), stamp)?;
    let dir = ctm_dir(r.pack, block);
    if fs::read_dir(&dir).is_ok_and(|mut d| d.next().is_none()) {
        let _ = fs::remove_dir(&dir);
    }
    info(r, block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workfile;
    use image::Rgba;

    const BORDER: Rgba<u8> = Rgba([200, 200, 255, 255]);
    const CLEAR: Rgba<u8> = Rgba([0, 0, 0, 0]);
    const STREAK: Rgba<u8> = Rgba([255, 255, 255, 120]);

    /// A glass-like texture: a 1-pixel frame per 16, clear inside, one streak.
    fn glass(w: u32) -> RgbaImage {
        let b = border_width(w);
        RgbaImage::from_fn(w, w, |x, y| {
            if x < b || y < b || x >= w - b || y >= w - b {
                BORDER
            } else if x == y {
                STREAK
            } else {
                CLEAR
            }
        })
    }

    fn row_has_border(img: &RgbaImage, y: u32) -> bool {
        (0..img.width())
            .filter(|x| *img.get_pixel(*x, y) == BORDER)
            .count() as u32
            > img.width() / 2
    }

    fn col_has_border(img: &RgbaImage, x: u32) -> bool {
        (0..img.height())
            .filter(|y| *img.get_pixel(x, *y) == BORDER)
            .count() as u32
            > img.height() / 2
    }

    #[test]
    fn five_tiles_from_a_framed_texture() {
        for w in [16, 32] {
            let t = glass(w);
            let b = border_width(w);
            let tiles = make_tiles(&t);
            assert_eq!(tiles.len(), 5);
            assert_eq!(tiles[0], t);
            let edges = |img: &RgbaImage| {
                [
                    col_has_border(img, 0),
                    col_has_border(img, w - 1),
                    row_has_border(img, 0),
                    row_has_border(img, w - 1),
                ]
            };
            // [left, right, top, bottom]
            assert_eq!(edges(&tiles[0]), [true, true, true, true]);
            assert_eq!(edges(&tiles[1]), [false, false, false, false]);
            assert_eq!(
                edges(&tiles[2]),
                [true, true, false, false],
                "2: up and down → borders left and right"
            );
            assert_eq!(
                edges(&tiles[3]),
                [false, false, true, true],
                "3: left and right → borders top and bottom"
            );
            assert_eq!(edges(&tiles[4]), [false, false, false, false]);
            // tile 4: only the b×b corners are border
            for (x, y) in [(0, 0), (w - 1, 0), (0, w - 1), (w - 1, w - 1)] {
                assert_eq!(*tiles[4].get_pixel(x, y), BORDER);
                let inside = |v: u32| if v == 0 { b } else { w - 1 - b };
                assert_eq!(tiles[1].get_pixel(x, y), t.get_pixel(inside(x), inside(y)));
            }
            assert_eq!(*tiles[4].get_pixel(b, 0), *tiles[1].get_pixel(b, 0));
            // the inside is untouched
            for tile in &tiles {
                for y in b..w - b {
                    for x in b..w - b {
                        assert_eq!(tile.get_pixel(x, y), t.get_pixel(x, y));
                    }
                }
            }
            // a removed side continues the band just inside it
            assert_eq!(*tiles[1].get_pixel(0, w / 2), *t.get_pixel(b, w / 2));
        }
    }

    #[test]
    fn properties_and_match_blocks() {
        let p = properties_text("glass", "glass", "all");
        for line in [
            "matchBlocks=glass",
            "method=ctm_compact",
            "tiles=0-4",
            "faces=all",
            "connect=block",
        ] {
            assert!(p.lines().any(|l| l == line), "{line} in {p}");
        }
        assert!(is_match_blocks("glass minecraft:white_stained_glass"));
        assert!(is_match_blocks("oak_stairs:facing=east,west"));
        assert!(!is_match_blocks(""));
        assert!(!is_match_blocks("glass\nmethod=ctm"));
        assert!(!is_match_blocks("Glass"));
    }

    fn setup(legacy: bool) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("v"), tmp.path().join("p"));
        let put = |root: &Path, rel: &str, text: &str| {
            let f = rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s));
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, text).unwrap();
        };
        let (tex, model, state) = if legacy {
            (
                "blocks/glass",
                r##"{"textures": {"all": "blocks/glass"}, "elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {"up": {"texture": "#all"}}}]}"##,
                r#"{"variants": {"normal": {"model": "glass"}}}"#,
            )
        } else {
            (
                "block/glass",
                r##"{"textures": {"all": "minecraft:block/glass"}, "elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {"up": {"texture": "#all"}}}]}"##,
                r#"{"variants": {"": {"model": "minecraft:block/glass"}}}"#,
            )
        };
        put(&vanilla, "assets/minecraft/models/block/glass.json", model);
        put(&vanilla, "assets/minecraft/blockstates/glass.json", state);
        let f = texture_file(&vanilla, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        glass(16).save(&f).unwrap();
        fs::create_dir_all(&pack).unwrap();
        (tmp, vanilla, pack)
    }

    #[test]
    fn create_writes_tiles_and_properties_and_remove_trashes_them() {
        for legacy in [false, true] {
            let (_t, vanilla, pack) = setup(legacy);
            let r = Roots {
                pack: &pack,
                vanilla: &vanilla,
                legacy,
            };
            let tex = if legacy {
                "blocks/glass"
            } else {
                "block/glass"
            };
            let i = info(r, "glass").unwrap();
            assert_eq!(i.textures, [tex]);
            assert!(i.tiles.iter().all(|t| !t.exists));
            assert_eq!(i.default_match, "glass");
            assert_eq!(
                create(r, "glass", tex, "everywhere", "glass", 2)
                    .unwrap_err()
                    .kind,
                "bad_faces"
            );
            let i = create(r, "glass", tex, "all", "glass", 2).unwrap();
            assert!(i.tiles.iter().all(|t| t.exists));
            assert_eq!(i.tiles[0].path, ":optifine/ctm/glass/0");
            let dir = pack.join("assets/minecraft/optifine/ctm/glass");
            let t0 = image::open(dir.join("0.png")).unwrap().to_rgba8();
            // enlarged to the pack resolution, border 2 wide
            assert_eq!(t0.dimensions(), (32, 32));
            assert_eq!(*t0.get_pixel(1, 16), BORDER);
            let t2 = image::open(dir.join("2.png")).unwrap().to_rgba8();
            assert_eq!(*t2.get_pixel(0, 16), BORDER);
            assert_ne!(*t2.get_pixel(16, 0), BORDER);
            assert!(i.properties.unwrap().contains("matchBlocks=glass\n"));

            // a tile opens and saves in the editor through its own path
            let o = workfile::open(&pack, &vanilla, &i.tiles[1].path, 1).unwrap();
            assert_eq!((o.doc.width, o.doc.height), (32, 32));
            workfile::save(
                &pack,
                &i.tiles[1].path,
                &o.doc,
                &fs::read(dir.join("3.png")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                fs::read(dir.join("1.png")).unwrap(),
                fs::read(dir.join("3.png")).unwrap()
            );
            assert!(work_file_of(&pack, &i.tiles[1].path).unwrap().is_file());

            // making them again keeps the old ones in the trash
            std::thread::sleep(std::time::Duration::from_millis(5));
            create(r, "glass", tex, "sides", "glass", 2).unwrap();
            assert!(fs::read_to_string(dir.join("glass.properties"))
                .unwrap()
                .contains("faces=sides"));
            std::thread::sleep(std::time::Duration::from_millis(5));
            let i = remove(r, "glass").unwrap();
            assert!(i.tiles.iter().all(|t| !t.exists));
            assert!(i.properties.is_none());
            assert!(!dir.exists());
            let trash = pack.join(crate::pack::PROJECT_DIR).join("trash");
            let n = walkdir::WalkDir::new(&trash)
                .into_iter()
                .flatten()
                .filter(|e| e.file_type().is_file())
                .count();
            // 5 tiles + properties, twice, plus one working file
            assert_eq!(n, 13);
        }
    }

    #[test]
    fn bad_editor_paths_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(optifine_png(tmp.path(), "ctm/../x").is_err());
        assert!(optifine_png(tmp.path(), "ctm/glass/0.properties").is_err());
        assert!(optifine_png(tmp.path(), "ctm/glass/0").is_ok());
    }
}

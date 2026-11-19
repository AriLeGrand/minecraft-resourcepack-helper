//! The Interface editor's screens: which pieces each in-game screen is made
//! of, a simple layout to draw it, and the status of every piece in a pack.
//!
//! 1.20.2 and newer (`data/gui_screens.json`): every piece is its own image,
//! mostly `textures/gui/sprites/<group>/<name>.png`; a few big ones
//! (`gui/container/*.png`, the title logo) are still whole images.
//! Before 1.20.2 (`data/gui_regions.json`): the pieces sit at fixed
//! rectangles inside shared images (`gui/widgets.png`, `gui/icons.png`,
//! `gui/bars.png`); the rectangles were checked against the modern sprites by
//! their pixels (`tools/research/find_gui_regions.py`).

use crate::error::Result;
use crate::gui::{self, Scaling, ScalingSource};
use crate::textures::{png_file_dimensions, texture_file};
use crate::McVersion;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

// ------------------------------------------------------------ data files

#[derive(Debug, Clone, Deserialize)]
pub struct PieceDef {
    pub id: String,
    /// Texture path (`gui/sprites/widget/button`).
    pub path: String,
    pub used_on: String,
    /// Shown name; the id when absent.
    #[serde(default)]
    pub name: Option<String>,
}

/// One thing drawn on the assembled preview, in GUI pixels.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct LayoutItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub piece: Option<String>,
    pub x: i32,
    pub y: i32,
    /// Size on screen; the piece's own size when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<u32>,
    /// Part of the texture `[u, v, w, h]` (texture units): drawn as it is,
    /// without the stretch rule, like the game's partial draws.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<[u32; 4]>,
    /// Size of the whole texture in texture units, when not its pixel size (the logo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tex: Option<[u32; 2]>,
    /// `tile`: repeat a whole image that has no stretch rule (backgrounds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draw: Option<String>,
    /// The piece shown instead when hover states are off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `left`, `center` or `right`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScreenDef {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub size: [u32; 2],
    pub pieces: Vec<PieceDef>,
    pub layout: Vec<LayoutItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Screens {
    pub since: String,
    pub screens: Vec<ScreenDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegionDef {
    pub id: String,
    pub rect: [u32; 4],
    pub used_on: String,
    #[serde(default)]
    pub modern: Option<String>,
    #[serde(default)]
    pub checked: Vec<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SharedImage {
    pub id: String,
    pub name: String,
    pub file: String,
    pub size: [u32; 2],
    #[serde(default)]
    pub since: Option<String>,
    pub pieces: Vec<RegionDef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Regions {
    pub until: String,
    pub images: Vec<SharedImage>,
}

impl Screens {
    pub fn builtin() -> &'static Screens {
        static S: OnceLock<Screens> = OnceLock::new();
        S.get_or_init(|| {
            serde_json::from_str(include_str!("../data/gui_screens.json"))
                .expect("gui_screens.json is valid")
        })
    }
}

impl Regions {
    pub fn builtin() -> &'static Regions {
        static R: OnceLock<Regions> = OnceLock::new();
        R.get_or_init(|| {
            serde_json::from_str(include_str!("../data/gui_regions.json"))
                .expect("gui_regions.json is valid")
        })
    }
    /// Whether a version keeps its pieces in shared images.
    pub fn applies_to(&self, version: &McVersion) -> bool {
        *version <= McVersion::parse(&self.until).expect("valid 'until'")
    }
}

fn in_range(v: &McVersion, since: Option<&str>, until: Option<&str>) -> bool {
    since.and_then(McVersion::parse).is_none_or(|s| *v >= s)
        && until.and_then(McVersion::parse).is_none_or(|u| *v <= u)
}

// ------------------------------------------------------------ the overview

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuiLayout {
    /// 1.20.2 and newer: one image per piece, with stretch rules.
    Sprites,
    /// Before 1.20.2: pieces at fixed rectangles of shared images.
    Shared,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PieceView {
    pub id: String,
    pub name: String,
    /// Texture path of the image the piece is in.
    pub path: String,
    pub used_on: String,
    /// The game's image size in pixels (`None` when this version has no such image).
    pub size: Option<(u32, u32)>,
    /// The pack's image size, when the pack has the image.
    pub pack_size: Option<(u32, u32)>,
    pub in_pack: bool,
    /// The game of this version has the image (or, for shared images, the piece exists).
    pub in_version: bool,
    /// The piece can have a stretch rule (a sprite of 1.20.2+).
    pub scalable: bool,
    /// Stretch rule state (scalable pieces only).
    pub scaling: Option<gui::ScalingState>,
    /// Shared images: the rectangle `[x, y, w, h]` in the game's image.
    pub rect: Option<[u32; 4]>,
    /// Shared images: versions whose pixels at the rectangle equal the modern sprite.
    pub checked: Vec<String>,
    /// Shared images: the modern sprite of the same piece.
    pub modern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScreenView {
    pub id: String,
    pub name: String,
    /// Where the pieces go in the pack (`gui/sprites/widget`, or the shared image).
    pub folder: String,
    /// Size of the assembled preview (or of the shared image) in GUI pixels.
    pub size: [u32; 2],
    pub pieces: Vec<PieceView>,
    pub layout: Vec<LayoutItem>,
    /// Shared layout: the texture path of the image.
    pub image: Option<String>,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuiOverview {
    pub layout: GuiLayout,
    pub screens: Vec<ScreenView>,
    /// Over every distinct image.
    pub done: usize,
    pub total: usize,
}

fn dims(root: &Path, tex: &str) -> Option<(u32, u32)> {
    texture_file(root, tex)
        .ok()
        .and_then(|f| png_file_dimensions(&f))
}

fn sprite_piece(pack: &Path, vanilla: &Path, def: &PieceDef) -> Result<PieceView> {
    let size = dims(vanilla, &def.path);
    let pack_size = dims(pack, &def.path);
    let scalable = def.path.starts_with("gui/sprites/");
    let scaling = if scalable {
        let mut s = gui::effective(pack, vanilla, &def.path)?;
        // a game without the sprite has no rule of its own either
        if size.is_none() && s.source == ScalingSource::Game {
            s.vanilla = Scaling::Stretch;
        }
        Some(s)
    } else {
        None
    };
    Ok(PieceView {
        id: def.id.clone(),
        name: def.name.clone().unwrap_or_else(|| def.id.clone()),
        path: def.path.clone(),
        used_on: def.used_on.clone(),
        size,
        pack_size,
        in_pack: pack_size.is_some(),
        in_version: size.is_some(),
        scalable,
        scaling,
        rect: None,
        checked: Vec::new(),
        modern: None,
    })
}

fn sprites_overview(pack: &Path, vanilla: &Path) -> Result<GuiOverview> {
    let mut screens = Vec::new();
    let mut seen = std::collections::BTreeMap::new();
    for s in &Screens::builtin().screens {
        let mut pieces = Vec::new();
        for def in &s.pieces {
            let p = sprite_piece(pack, vanilla, def)?;
            if p.in_version || p.in_pack {
                seen.insert(p.path.clone(), p.in_pack);
            }
            pieces.push(p);
        }
        let counted = pieces.iter().filter(|p| p.in_version || p.in_pack);
        screens.push(ScreenView {
            id: s.id.clone(),
            name: s.name.clone(),
            folder: s.folder.clone(),
            size: s.size,
            done: counted.clone().filter(|p| p.in_pack).count(),
            total: counted.count(),
            pieces,
            layout: s.layout.clone(),
            image: None,
        });
    }
    Ok(GuiOverview {
        layout: GuiLayout::Sprites,
        done: seen.values().filter(|d| **d).count(),
        total: seen.len(),
        screens,
    })
}

fn shared_overview(pack: &Path, vanilla: &Path, version: &McVersion) -> GuiOverview {
    let mut screens = Vec::new();
    let (mut done, mut total) = (0, 0);
    for img in &Regions::builtin().images {
        if !in_range(version, img.since.as_deref(), None) {
            continue;
        }
        let size = dims(vanilla, &img.file);
        let pack_size = dims(pack, &img.file);
        let in_pack = pack_size.is_some();
        let pieces: Vec<PieceView> = img
            .pieces
            .iter()
            .map(|r| PieceView {
                id: r.id.clone(),
                name: r.id.clone(),
                path: img.file.clone(),
                used_on: r.used_on.clone(),
                size: Some((r.rect[2], r.rect[3])),
                pack_size,
                in_pack,
                in_version: in_range(version, r.since.as_deref(), r.until.as_deref()),
                scalable: false,
                scaling: None,
                rect: Some(r.rect),
                checked: r.checked.clone(),
                modern: r.modern.clone(),
            })
            .collect();
        let n = pieces.iter().filter(|p| p.in_version).count();
        total += 1;
        if in_pack {
            done += 1;
        }
        screens.push(ScreenView {
            id: img.id.clone(),
            name: img.name.clone(),
            folder: img.file.clone(),
            size: size.map(|(w, h)| [w, h]).unwrap_or(img.size),
            pieces,
            layout: Vec::new(),
            image: Some(img.file.clone()),
            done: if in_pack { n } else { 0 },
            total: n,
        });
    }
    GuiOverview {
        layout: GuiLayout::Shared,
        screens,
        done,
        total,
    }
}

/// Every screen and piece for the pack's version. `None` (unknown version)
/// is treated as a modern one.
pub fn overview(pack: &Path, vanilla: &Path, version: Option<&McVersion>) -> Result<GuiOverview> {
    if let Some(v) = version {
        if Regions::builtin().applies_to(v) {
            return Ok(shared_overview(pack, vanilla, v));
        }
    }
    sprites_overview(pack, vanilla)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil;
    use std::collections::HashSet;
    use std::fs;

    fn put(root: &Path, tex: &str, w: u32, h: u32) {
        let f = texture_file(root, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, testutil::png(w, h, 3)).unwrap();
    }

    #[test]
    fn screens_are_well_formed() {
        let s = Screens::builtin();
        assert_eq!(s.since, "1.20.2");
        assert_eq!(s.screens.len(), 7);
        let mut ids = HashSet::new();
        for screen in &s.screens {
            assert!(ids.insert(&screen.id), "duplicate screen {}", screen.id);
            let mut pieces = HashSet::new();
            for p in &screen.pieces {
                assert!(
                    pieces.insert(&p.id),
                    "{}: duplicate piece {}",
                    screen.id,
                    p.id
                );
                assert!(crate::textures::is_safe_texture_path(&p.path), "{}", p.path);
                assert!(p.path.starts_with("gui/"), "{}", p.path);
                assert!(!p.used_on.is_empty());
            }
            for it in &screen.layout {
                if let Some(id) = it.piece.as_ref().or(it.normal.as_ref()) {
                    assert!(
                        pieces.contains(id),
                        "{}: layout names unknown piece {id}",
                        screen.id
                    );
                }
                if let Some(n) = &it.normal {
                    assert!(pieces.contains(n), "{}: unknown piece {n}", screen.id);
                }
                assert!(
                    it.piece.is_some() || it.text.is_some(),
                    "{}: empty item",
                    screen.id
                );
                assert!(it.x >= 0 && it.y >= 0, "{}: item outside", screen.id);
                let w = it.w.or(it.src.map(|s| s[2])).unwrap_or(0) as i32;
                let h = it.h.or(it.src.map(|s| s[3])).unwrap_or(0) as i32;
                assert!(
                    it.x + w <= screen.size[0] as i32 && it.y + h <= screen.size[1] as i32,
                    "{}: item at {},{} goes outside the screen",
                    screen.id,
                    it.x,
                    it.y
                );
            }
            // every piece is drawn somewhere
            for p in &screen.pieces {
                assert!(
                    screen
                        .layout
                        .iter()
                        .any(|i| i.piece.as_deref() == Some(&p.id)),
                    "{}: {} is never drawn",
                    screen.id,
                    p.id
                );
            }
        }
    }

    #[test]
    fn regions_fit_and_never_overlap() {
        let r = Regions::builtin();
        assert_eq!(r.until, "1.20.1");
        assert!(r.applies_to(&McVersion::parse("1.8.9").unwrap()));
        assert!(r.applies_to(&McVersion::parse("1.20.1").unwrap()));
        assert!(!r.applies_to(&McVersion::parse("1.20.2").unwrap()));
        for img in &r.images {
            let mut ids = HashSet::new();
            for (i, a) in img.pieces.iter().enumerate() {
                assert!(ids.insert(&a.id), "{}: duplicate {}", img.id, a.id);
                let [x, y, w, h] = a.rect;
                assert!(w > 0 && h > 0, "{}", a.id);
                assert!(
                    x + w <= img.size[0] && y + h <= img.size[1],
                    "{} is outside {}",
                    a.id,
                    img.file
                );
                for b in &img.pieces[i + 1..] {
                    let [bx, by, bw, bh] = b.rect;
                    let apart = x + w <= bx || bx + bw <= x || y + h <= by || by + bh <= y;
                    assert!(apart, "{}: {} overlaps {}", img.id, a.id, b.id);
                }
                if let Some(m) = &a.modern {
                    assert!(m.starts_with("gui/sprites/"), "{m}");
                }
            }
        }
    }

    #[test]
    fn modern_status_and_scaling() {
        let d = tempfile::tempdir().unwrap();
        let (pack, game) = (d.path().join("pack"), d.path().join("game"));
        for s in &Screens::builtin().screens {
            for p in &s.pieces {
                put(&game, &p.path, 20, 20);
            }
        }
        let btn = "gui/sprites/widget/button";
        let meta = crate::textures::mcmeta_file(&texture_file(&game, btn).unwrap());
        fs::write(
            &meta,
            r#"{"gui":{"scaling":{"type":"nine_slice","width":200,"height":20,"border":3}}}"#,
        )
        .unwrap();
        put(&pack, btn, 400, 40);
        let o = overview(&pack, &game, McVersion::parse("1.21.11").as_ref()).unwrap();
        assert_eq!(o.layout, GuiLayout::Sprites);
        let menus = &o.screens[0];
        assert_eq!(
            (menus.id.as_str(), menus.done, menus.total),
            ("menus", 1, 8)
        );
        let b = &menus.pieces[0];
        assert!(b.in_pack && b.scalable);
        assert_eq!(b.pack_size, Some((400, 40)));
        let sc = b.scaling.as_ref().unwrap();
        // the pack's PNG has no .mcmeta: the game would stretch it
        assert_eq!(
            (sc.source, &sc.scaling),
            (ScalingSource::PackPngOnly, &Scaling::Stretch)
        );
        // the button is on the title screen too, but counts once
        assert_eq!(o.done, 1);
        let title = o.screens.iter().find(|s| s.id == "title").unwrap();
        let logo = title.pieces.iter().find(|p| p.id == "minecraft").unwrap();
        assert!(!logo.scalable && logo.scaling.is_none());
    }

    #[test]
    fn missing_sprites_are_not_counted() {
        let d = tempfile::tempdir().unwrap();
        let (pack, game) = (d.path().join("pack"), d.path().join("game"));
        put(&game, "gui/sprites/widget/button", 200, 20);
        let o = overview(&pack, &game, None).unwrap();
        assert_eq!((o.done, o.total), (0, 1));
        assert!(!o.screens[0].pieces[1].in_version);
    }

    #[test]
    fn shared_images_before_1_20_2() {
        let d = tempfile::tempdir().unwrap();
        let (pack, game) = (d.path().join("pack"), d.path().join("game"));
        put(&game, "gui/widgets", 256, 256);
        put(&game, "gui/icons", 256, 256);
        put(&pack, "gui/widgets", 512, 512);
        let v189 = McVersion::parse("1.8.9").unwrap();
        let o = overview(&pack, &game, Some(&v189)).unwrap();
        assert_eq!(o.layout, GuiLayout::Shared);
        // bars.png arrives in 1.9
        assert_eq!(
            o.screens.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["widgets", "icons"]
        );
        assert_eq!((o.done, o.total), (1, 2));
        let w = &o.screens[0];
        assert_eq!(w.image.as_deref(), Some("gui/widgets"));
        let b = w.pieces.iter().find(|p| p.id == "button").unwrap();
        assert_eq!(b.rect, Some([0, 66, 200, 20]));
        assert_eq!(b.pack_size, Some((512, 512)));
        assert!(b.in_pack && !b.scalable);
        let off = w
            .pieces
            .iter()
            .find(|p| p.id == "hotbar_offhand_left")
            .unwrap();
        assert!(!off.in_version);
        assert_eq!(w.total, w.pieces.len() - 2);
        let icons = &o.screens[1];
        assert!(
            icons
                .pieces
                .iter()
                .find(|p| p.id == "boss_bar_background")
                .unwrap()
                .in_version
        );
        let v1201 = McVersion::parse("1.20.1").unwrap();
        let o = overview(&pack, &game, Some(&v1201)).unwrap();
        assert_eq!(o.screens.len(), 3);
        assert!(
            !o.screens[1]
                .pieces
                .iter()
                .find(|p| p.id == "boss_bar_background")
                .unwrap()
                .in_version
        );
    }

    fn cache() -> Option<std::path::PathBuf> {
        let c = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/devdata/cache/vanilla");
        c.is_dir().then_some(c)
    }

    /// Every piece of the screens exists in the extracted 1.21.11 game
    /// (developer machines only: skipped without the extracted cache).
    #[test]
    fn every_piece_exists_in_the_extracted_1_21_11() {
        let Some(c) = cache() else { return };
        let index = c.join("1.21.11/index.json");
        let Ok(text) = fs::read_to_string(&index) else {
            return;
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let paths: HashSet<&str> = v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["path"].as_str())
            .collect();
        for s in &Screens::builtin().screens {
            for p in &s.pieces {
                assert!(
                    paths.contains(p.path.as_str()),
                    "{} is not in 1.21.11",
                    p.path
                );
            }
        }
    }

    fn rgba(path: &Path) -> Option<image::RgbaImage> {
        image::open(path).ok().map(|i| i.to_rgba8())
    }

    fn same(a: &image::RgbaImage, b: &image::RgbaImage, x: u32, y: u32) -> bool {
        let norm = |p: &image::Rgba<u8>| if p[3] == 0 { [0; 4] } else { p.0 };
        b.enumerate_pixels()
            .all(|(px, py, p)| norm(a.get_pixel(x + px, y + py)) == norm(p))
    }

    /// The rectangles marked as checked hold exactly the pixels of the
    /// modern sprite in the extracted game images (developer machines only).
    #[test]
    fn checked_rectangles_match_the_extracted_sprites() {
        let Some(c) = cache() else { return };
        let tex = |v: &str, t: &str| texture_file(&c.join(v), t).unwrap();
        let mut n = 0;
        for img in &Regions::builtin().images {
            for p in &img.pieces {
                let Some(m) = &p.modern else { continue };
                let Some(sprite) = rgba(&tex("1.21.11", m)) else {
                    continue;
                };
                assert_eq!(sprite.dimensions(), (p.rect[2], p.rect[3]), "{}", p.id);
                for v in &p.checked {
                    let Some(sheet) = rgba(&tex(v, &img.file)) else {
                        continue;
                    };
                    assert!(
                        same(&sheet, &sprite, p.rect[0], p.rect[1]),
                        "{} in {v}",
                        p.id
                    );
                    n += 1;
                }
            }
        }
        eprintln!("checked {n} rectangles against the modern sprites");
    }
}

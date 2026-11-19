//! Texture paths, categories, the vanilla texture index and thumbnails.
//!
//! A texture path is relative to `assets/minecraft/textures`, uses `/` and has
//! no extension: `block/oak_planks`.

use crate::error::{CoreError, IoCtx, Result};
use crate::mcmeta::{self, Animation};
use crate::pack_format::PackFormat;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const TEXTURES_DIR: &str = "assets/minecraft/textures";
/// Thumbnails are at most this many pixels on their longest side.
pub const THUMB_MAX: u32 = 64;
pub const INDEX_SCHEMA: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Blocks,
    Items,
    Gui,
    Entities,
    Particles,
    Environment,
    Paintings,
    MobEffects,
    Armor,
    Misc,
}

impl Category {
    pub const ALL: [Category; 10] = [
        Category::Blocks,
        Category::Items,
        Category::Gui,
        Category::Entities,
        Category::Particles,
        Category::Environment,
        Category::Paintings,
        Category::MobEffects,
        Category::Armor,
        Category::Misc,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Category::Blocks => "Blocks",
            Category::Items => "Items",
            Category::Gui => "GUI",
            Category::Entities => "Entities",
            Category::Particles => "Particles",
            Category::Environment => "Environment",
            Category::Paintings => "Paintings",
            Category::MobEffects => "Mob effects",
            Category::Armor => "Armor",
            Category::Misc => "Misc",
        }
    }

    /// Whether the pack resolution (16×, 32×…) applies. GUI, entities and
    /// the rest are not 16-based and keep their own scale.
    pub fn uses_pack_resolution(self) -> bool {
        matches!(self, Category::Blocks | Category::Items)
    }
}

/// Category of a texture path, for old and new folder names.
pub fn category_of(path: &str) -> Category {
    let mut parts = path.split('/');
    let first = parts.next().unwrap_or("");
    let second = parts.next().unwrap_or("");
    match first {
        "block" | "blocks" => Category::Blocks,
        "item" | "items" => Category::Items,
        "gui" => Category::Gui,
        "entity" if second == "equipment" => Category::Armor,
        "entity" => Category::Entities,
        "particle" => Category::Particles,
        "environment" => Category::Environment,
        "painting" => Category::Paintings,
        "mob_effect" => Category::MobEffects,
        "models" | "trims" => Category::Armor,
        _ => Category::Misc,
    }
}

/// True when `path` is a safe relative texture path (no `..`, no drive, no backslash).
pub fn is_safe_texture_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// File of a texture inside a root that contains `assets/`.
pub fn texture_file(root: &Path, path: &str) -> Result<PathBuf> {
    if !is_safe_texture_path(path) {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{path}\" is not a valid texture name."),
        ));
    }
    let mut p = root.join("assets").join("minecraft").join("textures");
    for seg in path.split('/') {
        p.push(seg);
    }
    p.set_extension("png");
    // set_extension would eat a dot inside the name ("a.b" -> "a.png")
    if path.rsplit('/').next().is_some_and(|n| n.contains('.')) {
        let mut q = root.join("assets").join("minecraft").join("textures");
        for seg in path.split('/') {
            q.push(seg);
        }
        let name = format!("{}.png", q.file_name().unwrap().to_string_lossy());
        q.set_file_name(name);
        return Ok(q);
    }
    Ok(p)
}

/// `<texture>.png.mcmeta` next to a texture file.
pub fn mcmeta_file(png: &Path) -> PathBuf {
    let mut name = png
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".mcmeta");
    png.with_file_name(name)
}

/// Width and height from a PNG header, without decoding the image.
pub fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" || &data[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// Reads only the first bytes of a file to get its PNG size.
pub fn png_file_dimensions(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut head = [0u8; 24];
    let mut f = fs::File::open(path).ok()?;
    f.read_exact(&mut head).ok()?;
    png_dimensions(&head)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextureEntry {
    pub path: String,
    pub category: Category,
    pub width: u32,
    pub height: u32,
    pub animated: bool,
    /// Frames stored in the image (1 when not animated).
    pub frames: u32,
    pub frametime: u32,
    pub interpolate: bool,
    pub has_mcmeta: bool,
    /// True when a separate thumbnail file exists (large or animated textures).
    pub has_thumb: bool,
    /// Models that use this texture (at most a few names).
    pub used_by: Vec<String>,
    /// How many more models use it beyond `used_by`.
    pub used_by_more: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VanillaIndex {
    pub schema: u32,
    pub dir_name: String,
    pub id: Option<String>,
    pub format: Option<PackFormat>,
    pub jar_size: u64,
    pub jar_modified_ms: u64,
    pub entries: Vec<TextureEntry>,
}

impl VanillaIndex {
    pub fn get(&self, path: &str) -> Option<&TextureEntry> {
        self.entries
            .binary_search_by(|e| e.path.as_str().cmp(path))
            .ok()
            .map(|i| &self.entries[i])
    }
    pub fn count_by_category(&self) -> BTreeMap<Category, usize> {
        let mut m = BTreeMap::new();
        for e in &self.entries {
            *m.entry(e.category).or_insert(0) += 1;
        }
        m
    }
}

const USED_BY_SHOWN: usize = 8;

/// texture path -> names of the models that reference it.
fn collect_model_usage(root: &Path) -> BTreeMap<String, Vec<String>> {
    let mut usage: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let models = root.join("assets").join("minecraft").join("models");
    for entry in WalkDir::new(&models).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !entry.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(tex) = v.get("textures").and_then(|t| t.as_object()) else {
            continue;
        };
        let name = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        for val in tex.values() {
            let Some(s) = val.as_str() else { continue };
            if s.starts_with('#') {
                continue;
            }
            let key = s.strip_prefix("minecraft:").unwrap_or(s);
            let list = usage.entry(key.to_owned()).or_default();
            if !list.contains(&name) {
                list.push(name.clone());
            }
        }
    }
    usage
}

/// Makes a thumbnail: the first frame only, shrunk (nearest neighbour) to fit
/// `THUMB_MAX`. Returns `None` when the original can be shown as it is.
pub fn make_thumbnail(png: &[u8], frame_height: u32) -> Option<Vec<u8>> {
    let (w, h) = png_dimensions(png)?;
    let fh = frame_height.clamp(1, h);
    if fh == h && w <= THUMB_MAX && h <= THUMB_MAX {
        return None;
    }
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let mut frame = img.crop_imm(0, 0, w, fh);
    let longest = w.max(fh);
    if longest > THUMB_MAX {
        let scale = f64::from(THUMB_MAX) / f64::from(longest);
        let nw = ((f64::from(w) * scale).round() as u32).max(1);
        let nh = ((f64::from(fh) * scale).round() as u32).max(1);
        frame = frame.resize_exact(nw, nh, image::imageops::FilterType::Nearest);
    }
    let mut out = Vec::new();
    frame
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// Thumbnail file of a texture inside an extracted version folder.
pub fn thumb_file(root: &Path, path: &str) -> PathBuf {
    let mut p = root.join("thumbs");
    for seg in path.split('/') {
        p.push(seg);
    }
    let name = format!(
        "{}.png",
        p.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    p.set_file_name(name);
    p
}

/// Reads the animation of a texture file, if it has a valid one.
pub fn read_animation(png: &Path) -> (bool, Option<Animation>) {
    let meta = mcmeta_file(png);
    match fs::read_to_string(&meta) {
        Ok(text) => (true, mcmeta::parse_animation(&text).ok().flatten()),
        Err(_) => (false, None),
    }
}

/// Scans an extracted version folder and builds its texture list, writing
/// thumbnails for large and animated textures.
pub fn build_entries(root: &Path, write_thumbs: bool) -> Result<Vec<TextureEntry>> {
    let tex_root = root.join("assets").join("minecraft").join("textures");
    let usage = collect_model_usage(root);
    let mut entries = Vec::new();
    for entry in WalkDir::new(&tex_root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !entry.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let rel = p.strip_prefix(&tex_root).unwrap_or(p).with_extension("");
        let path = rel
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let Some((width, height)) = png_file_dimensions(p) else {
            continue;
        };
        let (has_mcmeta, anim) = read_animation(p);
        let frames = if anim.is_some() {
            mcmeta::frame_count(width, height, anim.as_ref())
        } else {
            1
        };
        let mut has_thumb = false;
        if write_thumbs {
            let fh = if anim.is_some() {
                mcmeta::frame_height(width, height, anim.as_ref())
            } else {
                height
            };
            if fh != height || width > THUMB_MAX || height > THUMB_MAX {
                if let Some(bytes) = fs::read(p).ok().and_then(|data| make_thumbnail(&data, fh)) {
                    let out = thumb_file(root, &path);
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent).ctx(parent)?;
                    }
                    fs::write(&out, bytes).ctx(&out)?;
                    has_thumb = true;
                }
            }
        }
        let (used_by, used_by_more) = match usage.get(&path) {
            Some(list) => {
                let mut names = list.clone();
                names.sort();
                // the model named like the texture is not interesting
                let base = path.rsplit('/').next().unwrap_or("");
                names.retain(|n| n != base);
                let more = names.len().saturating_sub(USED_BY_SHOWN) as u32;
                names.truncate(USED_BY_SHOWN);
                (names, more)
            }
            None => (Vec::new(), 0),
        };
        entries.push(TextureEntry {
            category: category_of(&path),
            path,
            width,
            height,
            animated: anim.is_some(),
            frames,
            frametime: anim.as_ref().map(|a| a.frametime).unwrap_or(1),
            interpolate: anim.as_ref().map(|a| a.interpolate).unwrap_or(false),
            has_mcmeta,
            has_thumb,
            used_by,
            used_by_more,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;

    #[test]
    fn categories_for_old_and_new_folders() {
        for (path, cat) in [
            ("block/oak_planks", Category::Blocks),
            ("blocks/planks_oak", Category::Blocks),
            ("item/diamond", Category::Items),
            ("items/diamond", Category::Items),
            ("gui/sprites/widget/button", Category::Gui),
            ("gui/widgets", Category::Gui),
            ("entity/creeper/creeper", Category::Entities),
            ("entity/equipment/humanoid/iron", Category::Armor),
            ("models/armor/iron_layer_1", Category::Armor),
            ("trims/entity/humanoid/coast", Category::Armor),
            ("particle/flame", Category::Particles),
            ("environment/sun", Category::Environment),
            ("painting/kebab", Category::Paintings),
            ("mob_effect/speed", Category::MobEffects),
            ("misc/vignette", Category::Misc),
            ("colormap/grass", Category::Misc),
            ("font/ascii", Category::Misc),
            ("map/map_icons", Category::Misc),
        ] {
            assert_eq!(category_of(path), cat, "{path}");
        }
        assert!(Category::Blocks.uses_pack_resolution());
        assert!(!Category::Gui.uses_pack_resolution());
        assert_eq!(Category::ALL.len(), 10);
    }

    #[test]
    fn unsafe_paths_are_refused() {
        for bad in [
            "",
            "/abs",
            "../x",
            "block/../../x",
            "block\\x",
            "C:/x",
            "block//x",
            "block/.",
        ] {
            assert!(!is_safe_texture_path(bad), "{bad}");
            assert!(texture_file(Path::new("root"), bad).is_err(), "{bad}");
        }
        assert!(is_safe_texture_path("block/oak_planks"));
    }

    #[test]
    fn file_paths() {
        let f = texture_file(Path::new("pack"), "block/oak_planks").unwrap();
        assert!(f.ends_with(Path::new("assets/minecraft/textures/block/oak_planks.png")));
        assert!(mcmeta_file(&f)
            .to_string_lossy()
            .ends_with("oak_planks.png.mcmeta"));
        let f = texture_file(Path::new("pack"), "block/odd.name").unwrap();
        assert!(f.to_string_lossy().ends_with("odd.name.png"));
        assert!(thumb_file(Path::new("v"), "block/a.b")
            .to_string_lossy()
            .ends_with("a.b.png"));
    }

    #[test]
    fn reads_png_header_only() {
        assert_eq!(png_dimensions(&png(16, 64, 1)), Some((16, 64)));
        assert_eq!(png_dimensions(b"not a png at all, really not"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn thumbnails() {
        // small still image: no thumbnail needed
        assert!(make_thumbnail(&png(16, 16, 1), 16).is_none());
        assert!(make_thumbnail(&png(64, 64, 1), 64).is_none());
        // animated strip: first frame only
        let t = make_thumbnail(&png(16, 64, 2), 16).unwrap();
        assert_eq!(png_dimensions(&t), Some((16, 16)));
        // large image: shrunk to fit, keeping proportions
        let t = make_thumbnail(&png(256, 128, 3), 128).unwrap();
        assert_eq!(png_dimensions(&t), Some((64, 32)));
        let t = make_thumbnail(&png(200, 20, 3), 20).unwrap();
        assert_eq!(png_dimensions(&t), Some((64, 6)));
        assert!(make_thumbnail(b"garbage", 16).is_none());
    }
}

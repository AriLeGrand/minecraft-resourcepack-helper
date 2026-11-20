//! "What's new in this version": the pack's game version compared with another
//! installed version (older or newer).
//!
//! Textures are matched across the two versions through the rename table, so
//! a texture that was only renamed is not new. Pixels are compared on the
//! extracted files: equal bytes are equal; otherwise both images are decoded
//! and compared as RGBA, with every fully transparent pixel counted as the
//! same (its colour is invisible). A different size counts as changed.
//!
//! The result depends only on the two extracted versions, so it is cached as
//! JSON in `<cache>/whats_new/` keyed by both jar stamps.

use crate::error::{CoreError, IoCtx, Result};
use crate::extract::vanilla_dir;
use crate::minecraft::InstalledVersion;
use crate::renames::RenameTable;
use crate::textures::{texture_file, VanillaIndex};
use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Bump when the comparison rules change, so old cached results are ignored.
pub const DIFF_SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Renamed {
    /// Name in the other version.
    pub from: String,
    /// Name in the pack's version.
    pub to: String,
    /// Only the folder changed (`blocks/stone` → `block/stone`).
    pub folder_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Changed {
    /// Name in the pack's version.
    pub path: String,
    /// Name in the other version (the same unless renamed).
    pub other_path: String,
    pub width: u32,
    pub height: u32,
    pub other_width: u32,
    pub other_height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionDiff {
    pub schema: u32,
    /// The pack's version (folder name and stamp of its jar).
    pub this_dir: String,
    pub this_stamp: (u64, u64),
    pub other_dir: String,
    pub other_stamp: (u64, u64),
    /// `1.21.11`, `1.20.1`.
    pub this_version: String,
    pub other_version: String,
    pub other_is_older: bool,
    /// In the pack's version, with no equivalent in the other one.
    pub added: Vec<String>,
    /// In the other version, with no equivalent in the pack's version.
    pub removed: Vec<String>,
    /// Same texture under another name.
    pub renamed: Vec<Renamed>,
    /// Same texture (after renames), different pixels.
    pub changed: Vec<Changed>,
    /// Textures found in both versions (and compared).
    pub matched: usize,
}

fn stamp(v: &InstalledVersion) -> (u64, u64) {
    (v.jar_size, v.jar_modified_ms)
}

fn version_of(v: &InstalledVersion) -> Result<McVersion> {
    v.mc_version().ok_or_else(|| {
        CoreError::new(
            "unknown_version",
            format!(
                "The game version of {} is not known, so it cannot be compared.",
                v.dir_name
            ),
        )
    })
}

fn cache_file(cache_root: &Path, this: &InstalledVersion, other: &InstalledVersion) -> PathBuf {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    cache_root.join("whats_new").join(format!(
        "{}__vs__{}.json",
        clean(&this.dir_name),
        clean(&other.dir_name)
    ))
}

/// The cached comparison, when it is for these exact two jars.
pub fn load_cached(
    cache_root: &Path,
    this: &InstalledVersion,
    other: &InstalledVersion,
) -> Option<VersionDiff> {
    let text = fs::read_to_string(cache_file(cache_root, this, other)).ok()?;
    let d: VersionDiff = serde_json::from_str(&text).ok()?;
    (d.schema == DIFF_SCHEMA
        && d.this_dir == this.dir_name
        && d.other_dir == other.dir_name
        && d.this_stamp == stamp(this)
        && d.other_stamp == stamp(other))
    .then_some(d)
}

/// Compares the pack's version with another one, using the cache when it is
/// up to date. Both versions must already be extracted (their indexes given).
/// `progress(done, total)` may be called from several threads.
pub fn compare(
    cache_root: &Path,
    this: &InstalledVersion,
    this_index: &VanillaIndex,
    other: &InstalledVersion,
    other_index: &VanillaIndex,
    progress: &(dyn Fn(usize, usize) + Sync),
) -> Result<VersionDiff> {
    if this.dir_name == other.dir_name {
        return Err(CoreError::new(
            "same_version",
            "Pick a different version to compare with.",
        ));
    }
    if let Some(d) = load_cached(cache_root, this, other) {
        return Ok(d);
    }
    let diff = compute(
        &vanilla_dir(cache_root, &this.dir_name),
        this,
        this_index,
        &vanilla_dir(cache_root, &other.dir_name),
        other,
        other_index,
        progress,
    )?;
    let file = cache_file(cache_root, this, other);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).ctx(dir)?;
    }
    // written beside, then renamed: a crash never leaves half a file
    let tmp = file.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(&diff).expect("diff serialises")).ctx(&tmp)?;
    fs::rename(&tmp, &file).ctx(&file)?;
    Ok(diff)
}

/// Name of a texture of the pack's version in the other version, when the
/// other version has it.
fn match_in_other(
    path: &str,
    this_v: &McVersion,
    other_v: &McVersion,
    other_index: &VanillaIndex,
) -> Option<String> {
    let names = RenameTable::builtin().map(path, this_v, other_v);
    if let Some(n) = names.iter().find(|n| n.as_str() == path) {
        if other_index.get(n).is_some() {
            return Some(n.clone());
        }
    }
    if let Some(n) = names.into_iter().find(|n| other_index.get(n).is_some()) {
        return Some(n);
    }
    // the table knows nothing better: the same name is the same texture
    other_index.get(path).map(|_| path.to_owned())
}

fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn compute(
    this_root: &Path,
    this: &InstalledVersion,
    this_index: &VanillaIndex,
    other_root: &Path,
    other: &InstalledVersion,
    other_index: &VanillaIndex,
    progress: &(dyn Fn(usize, usize) + Sync),
) -> Result<VersionDiff> {
    let this_v = version_of(this)?;
    let other_v = version_of(other)?;
    let table = RenameTable::builtin();

    let mut added = Vec::new();
    let mut renamed = Vec::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut found_in_other: HashSet<String> = HashSet::new();
    for e in &this_index.entries {
        match match_in_other(&e.path, &this_v, &other_v, other_index) {
            None => added.push(e.path.clone()),
            Some(o) => {
                if o != e.path {
                    renamed.push(Renamed {
                        folder_only: base(&o) == base(&e.path),
                        from: o.clone(),
                        to: e.path.clone(),
                    });
                }
                found_in_other.insert(o.clone());
                pairs.push((e.path.clone(), o));
            }
        }
    }
    let mut removed = Vec::new();
    for e in &other_index.entries {
        if found_in_other.contains(&e.path) {
            continue;
        }
        let kept = table
            .map(&e.path, &other_v, &this_v)
            .iter()
            .any(|n| this_index.get(n).is_some())
            || this_index.get(&e.path).is_some();
        if !kept {
            removed.push(e.path.clone());
        }
    }

    // pixels, on a few threads: most files are byte-identical between close
    // versions, the rest are decoded
    let total = pairs.len();
    let done = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let chunk = total.div_ceil(threads).max(1);
    let results: Vec<Option<Changed>> = std::thread::scope(|s| {
        let handles: Vec<_> = pairs
            .chunks(chunk)
            .map(|part| {
                let done = &done;
                s.spawn(move || {
                    part.iter()
                        .map(|(p, o)| {
                            let r = compare_files(this_root, p, other_root, o);
                            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                            if n.is_multiple_of(64) {
                                progress(n, total);
                            }
                            r
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("comparison thread"))
            .collect()
    });
    progress(total, total);
    let changed: Vec<Changed> = results.into_iter().flatten().collect();

    added.sort();
    removed.sort();
    renamed.sort_by(|a, b| a.to.cmp(&b.to));
    Ok(VersionDiff {
        schema: DIFF_SCHEMA,
        this_dir: this.dir_name.clone(),
        this_stamp: stamp(this),
        other_dir: other.dir_name.clone(),
        other_stamp: stamp(other),
        this_version: this_v.to_string(),
        other_version: other_v.to_string(),
        other_is_older: other_v < this_v,
        added,
        removed,
        renamed,
        changed,
        matched: total,
    })
}

/// `Some` when the two textures look different in the game.
fn compare_files(this_root: &Path, path: &str, other_root: &Path, other: &str) -> Option<Changed> {
    let a = texture_file(this_root, path)
        .ok()
        .and_then(|f| fs::read(f).ok());
    let b = texture_file(other_root, other)
        .ok()
        .and_then(|f| fs::read(f).ok());
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        // a file that cannot be read is not reported as redrawn
        _ => return None,
    };
    if a == b {
        return None;
    }
    let (ia, ib) = (decode(&a)?, decode(&b)?);
    let differs = ia.dimensions() != ib.dimensions() || ia.as_raw() != ib.as_raw();
    differs.then(|| Changed {
        path: path.to_owned(),
        other_path: other.to_owned(),
        width: ia.width(),
        height: ia.height(),
        other_width: ib.width(),
        other_height: ib.height(),
    })
}

/// RGBA pixels with every fully transparent pixel set to 0,0,0,0.
fn decode(data: &[u8]) -> Option<image::RgbaImage> {
    let mut img = image::load_from_memory_with_format(data, image::ImageFormat::Png)
        .ok()?
        .to_rgba8();
    for p in img.pixels_mut() {
        if p[3] == 0 {
            *p = image::Rgba([0, 0, 0, 0]);
        }
    }
    Some(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::extract_version;
    use crate::minecraft::{list_versions, testutil::*};
    use std::sync::Mutex;

    const T: &str = "assets/minecraft/textures/";

    /// A PNG whose pixels are given (RGBA), written by the test.
    fn png_px(w: u32, h: u32, px: &[[u8; 4]]) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            *p = image::Rgba(px[i % px.len()]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// Same pixels as `png_px`, written with another compression level so the
    /// bytes differ.
    fn png_px_other_bytes(w: u32, h: u32, px: &[[u8; 4]]) -> Vec<u8> {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use image::ImageEncoder;
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            *p = image::Rgba(px[i % px.len()]);
        }
        let mut out = Vec::new();
        PngEncoder::new_with_quality(&mut out, CompressionType::Best, FilterType::Paeth)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    struct Setup {
        _tmp: tempfile::TempDir,
        cache: PathBuf,
        old: InstalledVersion,
        new: InstalledVersion,
        old_idx: VanillaIndex,
        new_idx: VanillaIndex,
    }

    /// Two tiny game versions: 1.20.1 and 1.21.4.
    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let red = [255, 0, 0, 255];
        let blue = [0, 0, 255, 255];
        let clear_a = [10, 20, 30, 0];
        let clear_b = [99, 99, 99, 0];
        let old = vec![
            (format!("{T}block/stone.png"), png(16, 16, 3)),
            // renamed in 1.20.3, same pixels
            (format!("{T}block/grass.png"), png(16, 16, 5)),
            // renamed in 1.20.5 and redrawn
            (format!("{T}item/scute.png"), png_px(16, 16, &[red])),
            // redrawn
            (format!("{T}block/dirt.png"), png_px(16, 16, &[red])),
            // only re-compressed
            (format!("{T}block/sand.png"), png_px(16, 16, &[red, blue])),
            // invisible colour differs only
            (
                format!("{T}block/glass.png"),
                png_px(16, 16, &[clear_a, red]),
            ),
            // bigger in the new version
            (format!("{T}block/lava.png"), png_px(16, 16, &[blue])),
            // gone in the new version
            (format!("{T}item/old_thing.png"), png(16, 16, 9)),
        ];
        let new = vec![
            (format!("{T}block/stone.png"), png(16, 16, 3)),
            (format!("{T}block/short_grass.png"), png(16, 16, 5)),
            (format!("{T}item/turtle_scute.png"), png_px(16, 16, &[blue])),
            (format!("{T}block/dirt.png"), png_px(16, 16, &[blue])),
            (
                format!("{T}block/sand.png"),
                png_px_other_bytes(16, 16, &[red, blue]),
            ),
            (
                format!("{T}block/glass.png"),
                png_px(16, 16, &[clear_b, red]),
            ),
            (format!("{T}block/lava.png"), png_px(16, 32, &[blue])),
            // new in the new version
            (format!("{T}block/crafter_top.png"), png(16, 16, 7)),
        ];
        let jar = |dir: &str, files: &[(String, Vec<u8>)]| {
            let entries: Vec<(&str, Vec<u8>)> =
                files.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
            write_jar(
                &tmp.path()
                    .join("versions")
                    .join(dir)
                    .join(format!("{dir}.jar")),
                &entries,
            );
        };
        jar("1.20.1", &old);
        jar("1.21.4", &new);
        let vs = list_versions(tmp.path()).unwrap();
        let get = |n: &str| vs.iter().find(|v| v.dir_name == n).unwrap().clone();
        let (old, new) = (get("1.20.1"), get("1.21.4"));
        let cache = tmp.path().join("cache");
        let old_idx = extract_version(&cache, &old, &mut |_, _| {}).unwrap();
        let new_idx = extract_version(&cache, &new, &mut |_, _| {}).unwrap();
        Setup {
            _tmp: tmp,
            cache,
            old,
            new,
            old_idx,
            new_idx,
        }
    }

    fn changed_paths(d: &VersionDiff) -> Vec<&str> {
        let mut v: Vec<&str> = d.changed.iter().map(|c| c.path.as_str()).collect();
        v.sort();
        v
    }

    #[test]
    fn newer_pack_compared_with_an_older_version() {
        let s = setup();
        let d = compare(&s.cache, &s.new, &s.new_idx, &s.old, &s.old_idx, &|_, _| {}).unwrap();
        assert!(d.other_is_older);
        assert_eq!(
            (d.this_version.as_str(), d.other_version.as_str()),
            ("1.21.4", "1.20.1")
        );
        assert_eq!(d.added, ["block/crafter_top"]);
        assert_eq!(d.removed, ["item/old_thing"]);
        assert_eq!(
            d.renamed,
            [
                Renamed {
                    from: "block/grass".into(),
                    to: "block/short_grass".into(),
                    folder_only: false
                },
                Renamed {
                    from: "item/scute".into(),
                    to: "item/turtle_scute".into(),
                    folder_only: false
                },
            ]
        );
        // re-compressed sand and the invisible colour of glass are not changes
        assert_eq!(
            changed_paths(&d),
            ["block/dirt", "block/lava", "item/turtle_scute"]
        );
        let scute = d
            .changed
            .iter()
            .find(|c| c.path == "item/turtle_scute")
            .unwrap();
        assert_eq!(scute.other_path, "item/scute");
        let lava = d.changed.iter().find(|c| c.path == "block/lava").unwrap();
        assert_eq!(
            (lava.width, lava.height, lava.other_width, lava.other_height),
            (16, 32, 16, 16)
        );
        assert_eq!(d.matched, 7);
    }

    #[test]
    fn older_pack_compared_with_a_newer_version() {
        let s = setup();
        let d = compare(&s.cache, &s.old, &s.old_idx, &s.new, &s.new_idx, &|_, _| {}).unwrap();
        assert!(!d.other_is_older);
        assert_eq!(d.added, ["item/old_thing"]);
        assert_eq!(d.removed, ["block/crafter_top"]);
        let pairs: Vec<(&str, &str)> = d
            .renamed
            .iter()
            .map(|r| (r.from.as_str(), r.to.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("block/short_grass", "block/grass"),
                ("item/turtle_scute", "item/scute")
            ]
        );
        assert_eq!(
            changed_paths(&d),
            ["block/dirt", "block/lava", "item/scute"]
        );
    }

    #[test]
    fn folder_only_renames_are_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let a = [
            (format!("{T}blocks/stone.png"), png(16, 16, 1)),
            (format!("{T}blocks/planks_oak.png"), png(16, 16, 2)),
        ];
        let b = [
            (format!("{T}block/stone.png"), png(16, 16, 1)),
            (format!("{T}block/oak_planks.png"), png(16, 16, 4)),
        ];
        for (dir, files) in [("1.8.9", &a), ("1.20.1", &b)] {
            let entries: Vec<(&str, Vec<u8>)> =
                files.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
            write_jar(
                &tmp.path()
                    .join("versions")
                    .join(dir)
                    .join(format!("{dir}.jar")),
                &entries,
            );
        }
        let vs = list_versions(tmp.path()).unwrap();
        let get = |n: &str| vs.iter().find(|v| v.dir_name == n).unwrap().clone();
        let cache = tmp.path().join("cache");
        let (old, new) = (get("1.8.9"), get("1.20.1"));
        let oi = extract_version(&cache, &old, &mut |_, _| {}).unwrap();
        let ni = extract_version(&cache, &new, &mut |_, _| {}).unwrap();
        let d = compare(&cache, &new, &ni, &old, &oi, &|_, _| {}).unwrap();
        assert!(d.added.is_empty() && d.removed.is_empty());
        let r: Vec<(&str, bool)> = d
            .renamed
            .iter()
            .map(|r| (r.from.as_str(), r.folder_only))
            .collect();
        assert_eq!(r, [("blocks/planks_oak", false), ("blocks/stone", true)]);
        assert_eq!(changed_paths(&d), ["block/oak_planks"]);
    }

    #[test]
    fn second_run_comes_from_the_cache_and_a_new_jar_invalidates_it() {
        let s = setup();
        let calls = Mutex::new(0);
        let count = |_: usize, _: usize| *calls.lock().unwrap() += 1;
        let a = compare(&s.cache, &s.new, &s.new_idx, &s.old, &s.old_idx, &count).unwrap();
        assert!(*calls.lock().unwrap() > 0);
        assert!(load_cached(&s.cache, &s.new, &s.old).is_some());
        // no work the second time: delete the extracted files to prove it
        fs::remove_dir_all(vanilla_dir(&s.cache, "1.20.1").join("assets")).unwrap();
        *calls.lock().unwrap() = 0;
        let b = compare(&s.cache, &s.new, &s.new_idx, &s.old, &s.old_idx, &count).unwrap();
        assert_eq!(a, b);
        assert_eq!(*calls.lock().unwrap(), 0);
        // the other direction is a separate entry
        assert!(load_cached(&s.cache, &s.old, &s.new).is_none());
        // another jar of the same version: compared again
        let mut changed = s.old.clone();
        changed.jar_modified_ms += 1;
        assert!(load_cached(&s.cache, &s.new, &changed).is_none());
    }

    #[test]
    fn same_version_is_refused() {
        let s = setup();
        let e = compare(&s.cache, &s.new, &s.new_idx, &s.new, &s.new_idx, &|_, _| {}).unwrap_err();
        assert_eq!(e.kind, "same_version");
    }
}

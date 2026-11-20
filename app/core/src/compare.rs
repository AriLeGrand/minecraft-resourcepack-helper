//! "Compare with another pack": the textures of the open pack against those
//! of another pack (a `.zip` or a folder), matched with the batch-import
//! rules, so a pack made for another version (old names) is understood.
//!
//! A `.zip` is unpacked into a scratch folder in the cache first: only
//! `pack.mcmeta`, `pack.png` and the PNG / `.png.mcmeta` files under
//! `assets/minecraft/textures/`, only safe relative paths, with size caps.
//! A folder is read where it is. Nothing of the other pack is ever changed;
//! copying a texture into the open pack goes through `batch::import_one`
//! (byte for byte, replaced files to the trash).

use crate::batch::{same_pixels, Matcher};
use crate::error::{CoreError, IoCtx, Result};
use crate::pack::{scan_pack, PackTexture};
use crate::pack_format::{read_pack_mcmeta, PackFormat};
use crate::textures::{mcmeta_file, texture_file, VanillaIndex, TEXTURES_DIR};
use crate::version::McVersion;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// At most this many entries of a `.zip` are looked at.
pub const MAX_ENTRIES: usize = 50_000;
/// Files bigger than this (unpacked) are left out.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// A `.zip` that unpacks to more than this is refused.
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareStatus {
    /// Only the open pack has this texture.
    OnlyMine,
    /// Only the other pack has it.
    OnlyTheirs,
    /// Both have it, with different pixels (or a different animation file).
    Different,
    /// Both have it with exactly the same pixels.
    Same,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompareRow {
    pub id: usize,
    /// The texture in the open pack's version (`None` when their file
    /// matches no texture of this version).
    pub path: Option<String>,
    /// Their file, relative to `assets/minecraft/textures`, without `.png`.
    pub theirs: Option<String>,
    /// Their file uses another version's name for `path`.
    pub renamed_from: Option<String>,
    pub status: CompareStatus,
    pub their_size: Option<(u32, u32)>,
    pub my_size: Option<(u32, u32)>,
    pub their_mcmeta: bool,
    pub my_mcmeta: bool,
    /// Pixels are the same but the `.mcmeta` files differ.
    pub mcmeta_differs: bool,
    /// The game has this texture (so a "game" picture can be shown).
    pub in_game: bool,
    /// Another of their files is used for the same texture (this one is not).
    pub shadowed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Comparison {
    /// The chosen `.zip` or folder.
    pub source: String,
    /// Shown name: file or folder name without `.zip`.
    pub name: String,
    pub description: Option<String>,
    pub format: Option<PackFormat>,
    pub rows: Vec<CompareRow>,
    /// Files left out because they were too big (zip only).
    pub skipped_big: usize,
    /// The zip had more entries than `MAX_ENTRIES`.
    pub truncated: bool,
}

/// Where their pack's files are on disk, plus what was left out.
pub struct TheirPack {
    pub root: PathBuf,
    pub skipped_big: usize,
    pub truncated: bool,
}

fn not_a_pack(src: &Path) -> CoreError {
    CoreError::new(
        "not_a_pack",
        format!(
            "{} does not look like a resource pack (no pack.mcmeta and no assets/minecraft/textures inside).",
            src.display()
        ),
    )
    .hint("Choose the pack's .zip file, or the folder that holds its pack.mcmeta.")
}

/// The folder of a pack: `dir` itself, or the one sub-folder (one level
/// down) that holds `pack.mcmeta` or `assets/`.
pub fn pack_root(dir: &Path) -> Result<PathBuf> {
    let looks = |d: &Path| d.join("pack.mcmeta").is_file() || d.join(TEXTURES_DIR).is_dir();
    if looks(dir) {
        return Ok(dir.to_path_buf());
    }
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .ctx(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && looks(p))
        .collect();
    if found.len() == 1 {
        return Ok(found.remove(0));
    }
    Err(not_a_pack(dir))
}

/// The part of a zip entry name to keep (relative to the pack root), or
/// `None` for anything the comparison does not need.
fn wanted(rel: &str) -> bool {
    if rel == "pack.mcmeta" || rel == "pack.png" {
        return true;
    }
    let Some(rest) = rel
        .strip_prefix(TEXTURES_DIR)
        .and_then(|r| r.strip_prefix('/'))
    else {
        return false;
    };
    let lower = rest.to_ascii_lowercase();
    lower.ends_with(".png") || lower.ends_with(".png.mcmeta")
}

/// Unpacks the parts of a pack `.zip` the comparison needs into `work`
/// (emptied first). Unsafe paths are skipped; big files are left out and counted.
pub fn unpack_zip(zip_path: &Path, work: &Path) -> Result<TheirPack> {
    let bad = || {
        CoreError::new(
            "bad_zip",
            format!("{} is not a readable .zip file.", zip_path.display()),
        )
    };
    let mut zip =
        zip::ZipArchive::new(fs::File::open(zip_path).ctx(zip_path)?).map_err(|_| bad())?;
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    // the pack root inside the zip: where pack.mcmeta is, else where assets/ starts
    let prefix = names
        .iter()
        .filter(|n| n.ends_with("pack.mcmeta") && (n.len() == 11 || n.ends_with("/pack.mcmeta")))
        .min_by_key(|n| n.len())
        .map(|n| n.trim_end_matches("pack.mcmeta").to_owned())
        .or_else(|| {
            names
                .iter()
                .filter_map(|n| n.find(TEXTURES_DIR).map(|i| n[..i].to_owned()))
                .filter(|p| p.is_empty() || p.ends_with('/'))
                .min_by_key(String::len)
        })
        .ok_or_else(|| not_a_pack(zip_path))?;
    if work.exists() {
        fs::remove_dir_all(work).ctx(work)?;
    }
    fs::create_dir_all(work).ctx(work)?;
    let mut out = TheirPack {
        root: work.to_path_buf(),
        skipped_big: 0,
        truncated: zip.len() > MAX_ENTRIES,
    };
    let mut total = 0u64;
    for i in 0..zip.len().min(MAX_ENTRIES) {
        let mut entry = zip.by_index(i).map_err(|_| bad())?;
        if entry.is_dir() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // `..`, absolute paths, drive letters
        };
        let full = enclosed
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let Some(rel) = full.strip_prefix(&prefix) else {
            continue;
        };
        if !wanted(rel) || !crate::textures::is_safe_texture_path(rel) {
            continue;
        }
        if entry.size() > MAX_FILE_BYTES {
            out.skipped_big += 1;
            continue;
        }
        let mut data = Vec::new();
        (&mut entry)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|_| bad())?;
        if data.len() as u64 > MAX_FILE_BYTES {
            out.skipped_big += 1;
            continue;
        }
        total += data.len() as u64;
        if total > MAX_TOTAL_BYTES {
            let _ = fs::remove_dir_all(work);
            return Err(CoreError::new(
                "too_big",
                format!(
                    "{} unpacks to more than {} MB of textures.",
                    zip_path.display(),
                    MAX_TOTAL_BYTES / 1024 / 1024
                ),
            )
            .hint("Unzip it yourself and compare with the folder instead."));
        }
        let dest = rel.split('/').fold(work.to_path_buf(), |p, s| p.join(s));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).ctx(parent)?;
        }
        fs::write(&dest, &data).ctx(&dest)?;
    }
    Ok(out)
}

/// Finds their pack: a `.zip` is unpacked into `work`, a folder is used where
/// it is. Refuses the open pack itself.
pub fn open_their_pack(source: &Path, my_pack: &Path, work: &Path) -> Result<TheirPack> {
    if !source.exists() {
        return Err(CoreError::new(
            "not_found",
            format!("{} was not found.", source.display()),
        ));
    }
    if source.is_file() {
        return unpack_zip(source, work);
    }
    let root = pack_root(source)?;
    let same = |a: &Path, b: &Path| match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    };
    if same(&root, my_pack) {
        return Err(CoreError::new(
            "own_pack",
            "That is the pack that is open, so there is nothing to compare.",
        )
        .hint("Choose another pack, or an export of this pack."));
    }
    Ok(TheirPack {
        root,
        skipped_big: 0,
        truncated: false,
    })
}

fn read_opt(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Compares the open pack (`my_pack`) with their pack at `their_root`.
pub fn compare(
    source: &Path,
    their: &TheirPack,
    my_pack: &Path,
    index: &VanillaIndex,
    version: Option<&McVersion>,
) -> Result<Comparison> {
    let matcher = Matcher::new(index, version);
    let mine: BTreeMap<String, PackTexture> = scan_pack(my_pack)
        .into_iter()
        .map(|t| (t.path.clone(), t))
        .collect();
    let theirs = scan_pack(&their.root);

    // their file for each texture: the file named for this version wins over a renamed one
    struct Hit {
        theirs: PackTexture,
        target: Option<String>,
        renamed_from: Option<String>,
    }
    let mut hits: Vec<Hit> = Vec::new();
    for t in theirs {
        let (_, found) = matcher.match_rel(&format!("{TEXTURES_DIR}/{}.png", t.path));
        let targets = match found {
            Some(f) if !f.targets.is_empty() => f
                .targets
                .into_iter()
                .map(|x| (Some(x), f.renamed_from.clone()))
                .collect(),
            // not a texture of this version: still the same file when the pack has it
            _ if mine.contains_key(&t.path) => vec![(Some(t.path.clone()), None)],
            _ => vec![(None, None)],
        };
        for (target, renamed_from) in targets {
            hits.push(Hit {
                theirs: t.clone(),
                target,
                renamed_from,
            });
        }
    }
    let mut winner: BTreeMap<String, usize> = BTreeMap::new();
    for (i, h) in hits.iter().enumerate() {
        let Some(t) = &h.target else { continue };
        match winner.get(t) {
            Some(&j) if hits[j].renamed_from.is_none() || h.renamed_from.is_some() => {}
            _ => {
                winner.insert(t.clone(), i);
            }
        }
    }

    let source_dims = |t: &PackTexture| Some((t.width, t.height));
    let mut rows = Vec::new();
    let mut matched: HashSet<String> = HashSet::new();
    for (i, h) in hits.iter().enumerate() {
        let their_file = texture_file(&their.root, &h.theirs.path)?;
        let mut row = CompareRow {
            id: 0,
            path: h.target.clone(),
            theirs: Some(h.theirs.path.clone()),
            renamed_from: h.renamed_from.clone(),
            status: CompareStatus::OnlyTheirs,
            their_size: source_dims(&h.theirs),
            my_size: None,
            their_mcmeta: h.theirs.has_mcmeta,
            my_mcmeta: false,
            mcmeta_differs: false,
            in_game: h.target.as_deref().is_some_and(|t| index.get(t).is_some()),
            shadowed_by: None,
        };
        if let Some(t) = &h.target {
            let w = winner[t];
            if w != i {
                row.shadowed_by = Some(hits[w].theirs.path.clone());
            } else if let Some(m) = mine.get(t) {
                matched.insert(t.clone());
                row.my_size = source_dims(m);
                row.my_mcmeta = m.has_mcmeta;
                let my_file = texture_file(my_pack, t)?;
                let pixels_same = match (read_opt(&their_file), read_opt(&my_file)) {
                    (Some(a), Some(b)) => same_pixels(&a, &b),
                    _ => false,
                };
                let meta_same =
                    read_opt(&mcmeta_file(&their_file)) == read_opt(&mcmeta_file(&my_file));
                row.mcmeta_differs = pixels_same && !meta_same;
                row.status = if pixels_same && meta_same {
                    CompareStatus::Same
                } else {
                    CompareStatus::Different
                };
            }
        }
        rows.push(row);
    }
    for (path, m) in &mine {
        if matched.contains(path) {
            continue;
        }
        rows.push(CompareRow {
            id: 0,
            path: Some(path.clone()),
            theirs: None,
            renamed_from: None,
            status: CompareStatus::OnlyMine,
            their_size: None,
            my_size: source_dims(m),
            their_mcmeta: false,
            my_mcmeta: m.has_mcmeta,
            mcmeta_differs: false,
            in_game: index.get(path).is_some(),
            shadowed_by: None,
        });
    }
    rows.sort_by(|a, b| {
        let key = |r: &CompareRow| {
            r.path
                .clone()
                .or_else(|| r.theirs.clone())
                .unwrap_or_default()
        };
        key(a)
            .cmp(&key(b))
            .then(a.shadowed_by.is_some().cmp(&b.shadowed_by.is_some()))
    });
    for (i, r) in rows.iter_mut().enumerate() {
        r.id = i;
    }
    let meta = fs::read_to_string(their.root.join("pack.mcmeta"))
        .ok()
        .and_then(|t| read_pack_mcmeta(&t).ok());
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.to_string_lossy().into_owned());
    let name = match name.len() {
        n if n > 4 && name.to_ascii_lowercase().ends_with(".zip") => name[..n - 4].to_owned(),
        _ => name,
    };
    Ok(Comparison {
        source: source.to_string_lossy().into_owned(),
        name,
        description: meta.as_ref().map(|m| m.description.clone()),
        format: meta.and_then(|m| m.format),
        rows,
        skipped_big: their.skipped_big,
        truncated: their.truncated,
    })
}

/// Their file of a row (the PNG), for showing and copying.
pub fn their_file(their_root: &Path, row: &CompareRow) -> Option<PathBuf> {
    texture_file(their_root, row.theirs.as_deref()?).ok()
}

/// Removes the scratch folders of earlier comparisons.
pub fn clear_work(work_parent: &Path) {
    if work_parent.is_dir() {
        for e in WalkDir::new(work_parent)
            .min_depth(1)
            .max_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::batch::import_one;
    use crate::minecraft::testutil::{png, write_jar};
    use crate::textures::{category_of, TextureEntry, INDEX_SCHEMA};

    fn index(paths: &[&str]) -> VanillaIndex {
        let mut entries: Vec<TextureEntry> = paths
            .iter()
            .map(|p| TextureEntry {
                path: (*p).to_owned(),
                category: category_of(p),
                width: 16,
                height: 16,
                animated: false,
                frames: 1,
                frametime: 1,
                interpolate: false,
                has_mcmeta: false,
                has_thumb: false,
                used_by: Vec::new(),
                used_by_more: 0,
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        VanillaIndex {
            schema: INDEX_SCHEMA,
            dir_name: "test".into(),
            id: None,
            format: None,
            jar_size: 0,
            jar_modified_ms: 0,
            entries,
        }
    }

    fn modern() -> VanillaIndex {
        index(&[
            "block/oak_planks",
            "block/stone",
            "block/dirt",
            "block/prismarine",
            "item/diamond",
            "item/red_dye",
        ])
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p
    }

    fn tex(name: &str) -> String {
        format!("{TEXTURES_DIR}/{name}.png")
    }

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    fn my_pack(root: &Path) -> PathBuf {
        let mine = root.join("mine");
        put(
            &mine,
            "pack.mcmeta",
            br#"{"pack":{"pack_format":46,"description":"mine"}}"#,
        );
        put(&mine, &tex("block/stone"), &png(16, 16, 1)); // same pixels
        put(&mine, &tex("block/dirt"), &png(16, 16, 2)); // different
        put(&mine, &tex("block/oak_planks"), &png(16, 16, 3)); // only mine
        put(&mine, &tex("item/diamond"), &png(16, 16, 4)); // same pixels, other mcmeta
        put(
            &mine,
            &format!("{}.mcmeta", tex("item/diamond")),
            b"{\"animation\":{}}",
        );
        mine
    }

    fn by<'a>(c: &'a Comparison, path: &str) -> &'a CompareRow {
        c.rows
            .iter()
            .find(|r| r.path.as_deref() == Some(path) && r.shadowed_by.is_none())
            .unwrap_or_else(|| panic!("no row {path}"))
    }

    fn their_zip(root: &Path) -> PathBuf {
        let zip = root.join("Their Pack.zip");
        // an image-crate re-encode of seed 1: other bytes, same pixels
        let stone = {
            let img = image::load_from_memory(&png(16, 16, 1)).unwrap();
            let mut out = Vec::new();
            img.to_rgb8()
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .unwrap();
            out
        };
        write_jar(
            &zip,
            &[
                (
                    "Their Pack/pack.mcmeta",
                    r#"{"pack":{"pack_format":15,"description":"§bTheirs"}}"#
                        .as_bytes()
                        .to_vec(),
                ),
                ("Their Pack/pack.png", png(32, 32, 9)),
                (
                    "Their Pack/assets/minecraft/textures/block/stone.png",
                    stone,
                ),
                (
                    "Their Pack/assets/minecraft/textures/block/dirt.png",
                    png(16, 16, 5),
                ),
                // an old name of item/red_dye
                (
                    "Their Pack/assets/minecraft/textures/items/dye_powder_red.png",
                    png(16, 16, 6),
                ),
                (
                    "Their Pack/assets/minecraft/textures/item/diamond.png",
                    png(16, 16, 4),
                ),
                (
                    "Their Pack/assets/minecraft/textures/block/prismarine.png",
                    png(16, 32, 7),
                ),
                (
                    "Their Pack/assets/minecraft/textures/block/prismarine.png.mcmeta",
                    br#"{"animation":{"frametime":3}}"#.to_vec(),
                ),
                (
                    "Their Pack/assets/minecraft/textures/block/my_own.png",
                    png(16, 16, 8),
                ),
                // files the comparison never unpacks
                ("Their Pack/assets/minecraft/sounds/x.ogg", b"ogg".to_vec()),
                ("Their Pack/readme.txt", b"hi".to_vec()),
                ("../escape.png", png(4, 4, 1)),
                (
                    "Their Pack/assets/minecraft/textures/../../../../evil.png",
                    png(4, 4, 1),
                ),
            ],
        );
        zip
    }

    #[test]
    fn compares_a_zip_with_old_names() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = my_pack(tmp.path());
        let zip = their_zip(tmp.path());
        let work = tmp.path().join("cache").join("compare").join("1");
        let their = open_their_pack(&zip, &mine, &work).unwrap();
        let c = compare(&zip, &their, &mine, &modern(), Some(&v("1.21.11"))).unwrap();
        assert_eq!(c.name, "Their Pack");
        assert_eq!(c.description.as_deref(), Some("§bTheirs"));
        assert_eq!(c.format, Some(PackFormat::new(15)));
        assert_eq!(by(&c, "block/stone").status, CompareStatus::Same);
        assert_eq!(by(&c, "block/dirt").status, CompareStatus::Different);
        assert_eq!(by(&c, "block/oak_planks").status, CompareStatus::OnlyMine);
        let d = by(&c, "item/diamond");
        assert_eq!(d.status, CompareStatus::Different);
        assert!(d.mcmeta_differs && d.my_mcmeta && !d.their_mcmeta);
        let red = by(&c, "item/red_dye");
        assert_eq!(red.status, CompareStatus::OnlyTheirs);
        assert_eq!(red.theirs.as_deref(), Some("items/dye_powder_red"));
        assert_eq!(red.renamed_from.as_deref(), Some("items/dye_powder_red"));
        let pr = by(&c, "block/prismarine");
        assert!(pr.their_mcmeta && pr.their_size == Some((16, 32)));
        // a file that is no texture of this version
        let own = c
            .rows
            .iter()
            .find(|r| r.theirs.as_deref() == Some("block/my_own"))
            .unwrap();
        assert_eq!(
            (own.path.as_deref(), own.status),
            (None, CompareStatus::OnlyTheirs)
        );
        assert_eq!(c.rows.len(), 7);
        // ids are positions
        assert!(c.rows.iter().enumerate().all(|(i, r)| r.id == i));
        // nothing outside the work folder, nothing but the needed files
        assert!(!tmp.path().join("escape.png").exists());
        assert!(!tmp.path().join("evil.png").exists());
        assert!(!work.join("readme.txt").exists());
        assert!(!work.join("assets/minecraft/sounds").exists());
        assert!(work.join("pack.png").is_file());
        // comparing again empties the work folder first
        fs::write(work.join("leftover.png"), b"x").unwrap();
        open_their_pack(&zip, &mine, &work).unwrap();
        assert!(!work.join("leftover.png").exists());
    }

    #[test]
    fn copying_theirs_is_byte_for_byte_and_keeps_the_old_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = my_pack(tmp.path());
        let zip = their_zip(tmp.path());
        let work = tmp.path().join("work");
        let their = open_their_pack(&zip, &mine, &work).unwrap();
        let c = compare(&zip, &their, &mine, &modern(), Some(&v("1.21.11"))).unwrap();
        let old_dirt = fs::read(texture_file(&mine, "block/dirt").unwrap()).unwrap();
        for p in ["block/dirt", "item/red_dye", "block/prismarine"] {
            let row = by(&c, p);
            let src = their_file(&their.root, row).unwrap();
            let r = import_one(&mine, &src, p, false).unwrap();
            assert!(r.ok);
            assert_eq!(
                fs::read(texture_file(&mine, p).unwrap()).unwrap(),
                fs::read(&src).unwrap(),
                "{p}"
            );
        }
        // the animation file came along, the old dirt is in the trash
        assert_eq!(
            fs::read(mcmeta_file(
                &texture_file(&mine, "block/prismarine").unwrap()
            ))
            .unwrap(),
            br#"{"animation":{"frametime":3}}"#
        );
        let trash: Vec<Vec<u8>> = WalkDir::new(mine.join(".packcreator/trash"))
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| fs::read(e.path()).unwrap())
            .collect();
        assert!(trash.contains(&old_dirt));
        // their pack is untouched
        let again = compare(&zip, &their, &mine, &modern(), Some(&v("1.21.11"))).unwrap();
        assert_eq!(by(&again, "block/dirt").status, CompareStatus::Same);
        assert_eq!(by(&again, "item/red_dye").status, CompareStatus::Same);
    }

    #[test]
    fn compares_a_folder_and_prefers_the_current_name() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = my_pack(tmp.path());
        // a folder holding the pack one level down; both an old and a new name for stone
        let outer = tmp.path().join("downloads");
        let theirs = outer.join("Other");
        put(
            &theirs,
            "pack.mcmeta",
            br#"{"pack":{"pack_format":1,"description":"old"}}"#,
        );
        put(&theirs, &tex("blocks/stone"), &png(16, 16, 7));
        put(&theirs, &tex("block/stone"), &png(16, 16, 1));
        let listing = |d: &Path| -> Vec<(PathBuf, Vec<u8>)> {
            WalkDir::new(d)
                .sort_by_file_name()
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(|e| (e.path().to_path_buf(), fs::read(e.path()).unwrap()))
                .collect()
        };
        let before = listing(&outer);
        let their = open_their_pack(&outer, &mine, &tmp.path().join("w")).unwrap();
        assert_eq!(their.root, theirs);
        let c = compare(&outer, &their, &mine, &modern(), Some(&v("1.21.11"))).unwrap();
        let stone = by(&c, "block/stone");
        assert_eq!(stone.theirs.as_deref(), Some("block/stone"));
        assert_eq!(stone.status, CompareStatus::Same);
        let old = c
            .rows
            .iter()
            .find(|r| r.theirs.as_deref() == Some("blocks/stone"))
            .unwrap();
        assert_eq!(old.shadowed_by.as_deref(), Some("block/stone"));
        // nothing was written into their folder
        assert_eq!(listing(&outer), before);
    }

    #[test]
    fn refuses_the_open_pack_non_packs_and_bad_zips() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = my_pack(tmp.path());
        let w = tmp.path().join("w");
        assert_eq!(
            open_their_pack(&mine, &mine, &w).err().unwrap().kind,
            "own_pack"
        );
        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            open_their_pack(&empty, &mine, &w).err().unwrap().kind,
            "not_a_pack"
        );
        let notzip = put(tmp.path(), "x.zip", b"nope");
        assert_eq!(
            open_their_pack(&notzip, &mine, &w).err().unwrap().kind,
            "bad_zip"
        );
        let readme = tmp.path().join("readme.zip");
        write_jar(&readme, &[("readme.txt", b"hi".to_vec())]);
        assert_eq!(
            open_their_pack(&readme, &mine, &w).err().unwrap().kind,
            "not_a_pack"
        );
        assert_eq!(
            open_their_pack(&tmp.path().join("gone.zip"), &mine, &w)
                .err()
                .unwrap()
                .kind,
            "not_found"
        );
        // a zip without pack.mcmeta but with textures still works
        let bare = tmp.path().join("bare.zip");
        write_jar(
            &bare,
            &[("assets/minecraft/textures/block/dirt.png", png(16, 16, 2))],
        );
        let their = open_their_pack(&bare, &mine, &w).unwrap();
        let c = compare(&bare, &their, &mine, &modern(), None).unwrap();
        assert_eq!(by(&c, "block/dirt").status, CompareStatus::Same);
        assert_eq!(c.description, None);
    }

    #[test]
    fn big_files_are_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = my_pack(tmp.path());
        let zip = tmp.path().join("big.zip");
        let big = vec![0u8; MAX_FILE_BYTES as usize + 1];
        write_jar(
            &zip,
            &[
                (
                    "pack.mcmeta",
                    br#"{"pack":{"pack_format":46,"description":""}}"#.to_vec(),
                ),
                ("assets/minecraft/textures/block/dirt.png", big),
                ("assets/minecraft/textures/block/stone.png", png(16, 16, 1)),
            ],
        );
        let their = open_their_pack(&zip, &mine, &tmp.path().join("w")).unwrap();
        assert_eq!(their.skipped_big, 1);
        let c = compare(&zip, &their, &mine, &modern(), None).unwrap();
        assert_eq!(c.skipped_big, 1);
        assert_eq!(by(&c, "block/dirt").status, CompareStatus::OnlyMine);
    }
}

//! Batch import: matches every PNG of a folder to a texture of the pack's
//! version, then imports the accepted ones.
//!
//! Matching, in this order:
//! 1. a path containing `assets/minecraft/textures/` (a pack or an export):
//!    the rest of the path;
//! 2. a path relative to the folder that looks like a texture path
//!    (`block/x.png`, `blocks/x.png`, `item/…`, `gui/…`, `entity/…`);
//! 3. the file name, against the version's texture list (a unique match wins,
//!    several = ambiguous, the user picks one).
//!
//! In every case an old or newer name is translated to the pack's version
//! with the rename table. Images are never resized or altered: a PNG is copied
//! byte for byte (`import::import_image`), replaced files go to the trash.

use crate::error::{CoreError, IoCtx, Result};
use crate::import::{import_image, move_to_trash};
use crate::mcmeta::{self, Animation};
use crate::pack::{expected_size, is_wrong_size, now_ms, PackTexture, PROJECT_DIR};
use crate::renames::RenameTable;
use crate::textures::{mcmeta_file, png_dimensions, texture_file, VanillaIndex};
use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// At most this many PNG files are looked at in one scan.
pub const MAX_FILES: usize = 5000;
/// Frame time written when the user ticks "use as animation frames".
pub const DEFAULT_FRAMETIME: u32 = 2;

const TEXTURES_MARKER: [&str; 3] = ["assets", "minecraft", "textures"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    /// `…/assets/minecraft/textures/<path>`
    PackPath,
    /// `block/x.png` and the like, relative to the chosen folder
    TexturePath,
    /// the file name alone
    FileName,
    /// nothing matched
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    /// The pack has no file for this texture yet.
    New,
    /// The pack has a file; it goes to the trash when imported.
    Replaces,
    /// The pack already has these exact pixels (and the same `.mcmeta`).
    Same,
    /// No texture of this version matches.
    Unknown,
    /// Several textures match; the user picks one.
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Candidate {
    pub path: String,
    /// The pack already has a file for it.
    pub in_pack: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BatchRow {
    pub id: usize,
    /// Path relative to the chosen folder, with `/`.
    pub rel: String,
    /// Full path of the source file.
    pub source: String,
    /// The texture it will become (`None` when unknown or ambiguous).
    pub target: Option<String>,
    /// Textures to choose from when ambiguous (also filled with the one
    /// target otherwise, so the UI can show whether the pack has it).
    pub candidates: Vec<Candidate>,
    /// The name the file used, when it was translated with the rename table.
    pub renamed_from: Option<String>,
    pub rule: Rule,
    pub status: RowStatus,
    /// Another file of the scan maps to the same texture.
    pub duplicate: bool,
    pub width: u32,
    pub height: u32,
    /// Size the pack resolution asks for (blocks and items only).
    pub expected: Option<(u32, u32)>,
    pub wrong_size: bool,
    /// A `<name>.png.mcmeta` sits next to the file and is imported with it.
    pub has_mcmeta: bool,
    /// Tall image without an `.mcmeta`: this many square frames ("frames?").
    pub strip_frames: Option<u32>,
    /// Suggested state of "use as animation frames" (the game's texture is animated).
    pub frames_default: bool,
    /// Suggested state of the row's checkbox.
    pub accept: bool,
    /// Why the file cannot be imported (not a readable PNG).
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BatchScan {
    /// The chosen folder, or "N dropped items".
    pub folder: String,
    pub rows: Vec<BatchRow>,
    /// More than `MAX_FILES` PNG files: only the first ones are listed.
    pub truncated: bool,
    /// Files or folders inside the pack itself were left out.
    pub skipped_pack: bool,
}

/// Looks up texture names of the pack's version, including old and newer names.
pub struct Matcher<'a> {
    index: &'a VanillaIndex,
    /// Any name a texture had in some version → current names.
    aliases: HashMap<String, Vec<String>>,
    /// Base name of a current texture → current names.
    by_base: HashMap<String, Vec<String>>,
    /// Base name of an old or newer name → (that name, current name).
    by_alias_base: HashMap<String, Vec<(String, String)>>,
    /// First folder of every known name (`block`, `blocks`, `gui`…).
    tops: HashSet<String>,
}

fn base_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// What a file name or path matched (also used by `compare`).
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub targets: Vec<String>,
    pub renamed_from: Option<String>,
}

impl<'a> Matcher<'a> {
    pub fn new(index: &'a VanillaIndex, version: Option<&McVersion>) -> Self {
        let table = RenameTable::builtin();
        let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_base: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_alias_base: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut tops = HashSet::new();
        for e in &index.entries {
            by_base
                .entry(base_of(&e.path).to_owned())
                .or_default()
                .push(e.path.clone());
            if let Some(top) = e.path.split('/').next() {
                tops.insert(top.to_owned());
            }
            let Some(v) = version else { continue };
            for (_, name) in table.history(&e.path, v) {
                if name == e.path || index.get(&name).is_some() {
                    continue;
                }
                if let Some(top) = name.split('/').next() {
                    tops.insert(top.to_owned());
                }
                let list = aliases.entry(name.clone()).or_default();
                if !list.contains(&e.path) {
                    list.push(e.path.clone());
                    by_alias_base
                        .entry(base_of(&name).to_owned())
                        .or_default()
                        .push((name.clone(), e.path.clone()));
                }
            }
        }
        Self {
            index,
            aliases,
            by_base,
            by_alias_base,
            tops,
        }
    }

    /// A full texture path (any version's name).
    fn by_path(&self, path: &str) -> Option<Found> {
        if self.index.get(path).is_some() {
            return Some(Found {
                targets: vec![path.to_owned()],
                renamed_from: None,
            });
        }
        let targets = self.aliases.get(path)?.clone();
        Some(Found {
            targets,
            renamed_from: Some(path.to_owned()),
        })
    }

    /// A file name without folder (any version's name).
    fn by_name(&self, base: &str) -> Option<Found> {
        if let Some(list) = self.by_base.get(base) {
            return Some(Found {
                targets: list.clone(),
                renamed_from: None,
            });
        }
        let list = self.by_alias_base.get(base)?;
        let targets: BTreeSet<String> = list.iter().map(|(_, t)| t.clone()).collect();
        let names: BTreeSet<&str> = list.iter().map(|(n, _)| n.as_str()).collect();
        Some(Found {
            targets: targets.into_iter().collect(),
            renamed_from: (names.len() == 1).then(|| list[0].0.clone()),
        })
    }

    /// Target of a file at `rel` (relative to the chosen folder, `/`, with
    /// `.png`). Returns the rule used and what was found.
    pub fn match_rel(&self, rel: &str) -> (Rule, Option<Found>) {
        let lower = rel.to_lowercase();
        let stem = lower.strip_suffix(".png").unwrap_or(&lower);
        let segs: Vec<&str> = stem.split('/').collect();
        // 1. inside a pack: everything after assets/minecraft/textures
        if let Some(i) = segs
            .windows(TEXTURES_MARKER.len())
            .position(|w| w == TEXTURES_MARKER)
        {
            let rest = segs[i + TEXTURES_MARKER.len()..].join("/");
            if !rest.is_empty() {
                return (Rule::PackPath, self.by_path(&rest));
            }
        }
        // 2. a texture path somewhere in the relative path
        for i in 0..segs.len().saturating_sub(1) {
            if self.tops.contains(segs[i]) {
                if let Some(f) = self.by_path(&segs[i..].join("/")) {
                    return (Rule::TexturePath, Some(f));
                }
            }
        }
        // 3. the file name
        let base = segs.last().copied().unwrap_or("");
        match self.by_name(base) {
            Some(f) => (Rule::FileName, Some(f)),
            None => (Rule::None, None),
        }
    }
}

/// True when two PNG files show exactly the same pixels.
pub fn same_pixels(a: &[u8], b: &[u8]) -> bool {
    if a == b {
        return true;
    }
    if png_dimensions(a).is_none() || png_dimensions(a) != png_dimensions(b) {
        return false;
    }
    let load = |d: &[u8]| {
        image::load_from_memory_with_format(d, image::ImageFormat::Png)
            .ok()
            .map(|i| i.to_rgba8())
    };
    match (load(a), load(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn read_opt(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

fn is_png(p: &Path) -> bool {
    p.extension().is_some_and(|x| x.eq_ignore_ascii_case("png"))
}

fn rel_of(file: &Path, root: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .iter()
        .map(|s| s.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

struct Walked {
    /// (file, path relative to the folder it was found in)
    files: Vec<(PathBuf, String)>,
    truncated: bool,
    skipped_pack: bool,
}

/// Every PNG of `sources` (folders are walked; hidden folders and the pack
/// itself are left out), at most `MAX_FILES`.
fn walk_pngs(sources: &[PathBuf], pack: Option<&Path>) -> Result<Walked> {
    let mut out = Walked {
        files: Vec::new(),
        truncated: false,
        skipped_pack: false,
    };
    let in_pack =
        |p: &Path| pack.is_some_and(|k| fs::canonicalize(p).is_ok_and(|c| c.starts_with(k)));
    for src in sources {
        if !src.exists() {
            return Err(CoreError::new(
                "not_found",
                format!("{} was not found.", src.display()),
            ));
        }
        if in_pack(src) {
            out.skipped_pack = true;
            continue;
        }
        if src.is_file() {
            if is_png(src) {
                if out.files.len() >= MAX_FILES {
                    out.truncated = true;
                    break;
                }
                let name = src
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.files.push((src.clone(), name));
            }
            continue;
        }
        let mut found = Vec::new();
        let mut skipped = false;
        let walker = WalkDir::new(src).into_iter().filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            if is_hidden(e.file_name()) {
                return false;
            }
            if in_pack(e.path()) {
                skipped = true;
                return false;
            }
            true
        });
        for e in walker.filter_map(|e| e.ok()) {
            if !e.file_type().is_file() || !is_png(e.path()) {
                continue;
            }
            if out.files.len() + found.len() >= MAX_FILES {
                out.truncated = true;
                break;
            }
            found.push(e.into_path());
        }
        out.skipped_pack |= skipped;
        found.sort();
        out.files
            .extend(found.into_iter().map(|f| (f.clone(), rel_of(&f, src))));
        if out.truncated {
            break;
        }
    }
    Ok(out)
}

/// Scans the chosen folder (or the dropped files and folders) and decides,
/// for every PNG, which texture of the pack it becomes. Nothing is written.
pub fn scan(
    sources: &[PathBuf],
    pack_dir: &Path,
    index: &VanillaIndex,
    version: Option<&McVersion>,
    resolution: u32,
) -> Result<BatchScan> {
    let pack_c = fs::canonicalize(pack_dir).ok();
    let walked = walk_pngs(sources, pack_c.as_deref())?;
    if walked.files.is_empty() && walked.skipped_pack {
        return Err(CoreError::new(
            "own_pack",
            "Those files are in this pack already, so there is nothing to import.",
        )
        .hint("Pick the folder that holds the images you want to bring in."));
    }
    let matcher = Matcher::new(index, version);
    let mut rows = Vec::with_capacity(walked.files.len());
    for (id, (file, rel)) in walked.files.iter().enumerate() {
        rows.push(scan_one(
            id, file, rel, &matcher, pack_dir, index, resolution,
        ));
    }
    // two files for one texture: the user picks one
    let mut by_target: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(t) = &r.target {
            if r.problem.is_none() {
                by_target.entry(t.clone()).or_default().push(i);
            }
        }
    }
    for list in by_target.values().filter(|l| l.len() > 1) {
        for &i in list {
            rows[i].duplicate = true;
            rows[i].accept = false;
        }
    }
    Ok(BatchScan {
        folder: match sources {
            [one] => one.to_string_lossy().into_owned(),
            _ => format!("{} dropped items", sources.len()),
        },
        rows,
        truncated: walked.truncated,
        skipped_pack: walked.skipped_pack,
    })
}

fn scan_one(
    id: usize,
    file: &Path,
    rel: &str,
    matcher: &Matcher,
    pack_dir: &Path,
    index: &VanillaIndex,
    resolution: u32,
) -> BatchRow {
    let data = read_opt(file).unwrap_or_default();
    let dims = png_dimensions(&data);
    let (width, height) = dims.unwrap_or((0, 0));
    let src_meta = mcmeta_file(file);
    let has_mcmeta = src_meta.is_file();
    let (rule, found) = matcher.match_rel(rel);
    let in_pack = |t: &str| texture_file(pack_dir, t).is_ok_and(|f| f.is_file());
    let mut row = BatchRow {
        id,
        rel: rel.to_owned(),
        source: file.to_string_lossy().into_owned(),
        target: None,
        candidates: Vec::new(),
        renamed_from: None,
        rule,
        status: RowStatus::Unknown,
        duplicate: false,
        width,
        height,
        expected: None,
        wrong_size: false,
        has_mcmeta,
        strip_frames: None,
        frames_default: false,
        accept: false,
        problem: dims
            .is_none()
            .then(|| "Not a PNG image this app can read.".to_owned()),
    };
    let Some(found) = found else { return row };
    row.renamed_from = found.renamed_from;
    row.candidates = found
        .targets
        .iter()
        .map(|t| Candidate {
            path: t.clone(),
            in_pack: in_pack(t),
        })
        .collect();
    if found.targets.len() != 1 {
        row.status = RowStatus::Ambiguous;
        return row;
    }
    let target = found.targets[0].clone();
    let entry = index.get(&target);
    let dest = texture_file(pack_dir, &target).ok();
    let pack_png = dest.as_deref().and_then(read_opt);
    let pack_meta = dest.as_deref().map(mcmeta_file);
    let pack_has_meta = pack_meta.as_deref().is_some_and(Path::is_file);
    row.status = match &pack_png {
        None => RowStatus::New,
        Some(existing) => {
            let meta_same =
                !has_mcmeta || pack_meta.as_deref().and_then(read_opt) == read_opt(&src_meta);
            if dims.is_some() && meta_same && same_pixels(&data, existing) {
                RowStatus::Same
            } else {
                RowStatus::Replaces
            }
        }
    };
    if dims.is_some() {
        if !has_mcmeta && !pack_has_meta {
            row.strip_frames = mcmeta::strip_frames(width, height);
            row.frames_default = row.strip_frames.is_some() && entry.is_some_and(|e| e.animated);
        }
        if let Some(e) = entry {
            row.expected = expected_size(e, resolution);
            let mine = PackTexture {
                path: target.clone(),
                width,
                height,
                modified_ms: 0,
                has_mcmeta,
                animated: has_mcmeta || pack_has_meta || row.strip_frames.is_some(),
                frames: 1,
                file_size: 0,
            };
            row.wrong_size = is_wrong_size(e, &mine, resolution);
        }
    }
    row.accept =
        row.problem.is_none() && matches!(row.status, RowStatus::New | RowStatus::Replaces);
    row.target = Some(target);
    row
}

/// One file to import, as accepted by the user.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BatchItem {
    pub id: usize,
    pub target: String,
    /// Write an animation `.mcmeta` (frametime 2) for a tall image without one.
    #[serde(default)]
    pub frames: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemResult {
    pub id: usize,
    pub target: String,
    pub ok: bool,
    /// The pack's previous file went to the trash.
    pub replaced: bool,
    /// An `.mcmeta` was copied or written.
    pub wrote_mcmeta: bool,
    /// The pack already had exactly this; nothing was written.
    pub unchanged: bool,
    pub error: Option<CoreError>,
}

/// Imports one file as `target`: the PNG byte for byte, its `.mcmeta` when
/// there is one next to it, or a default animation when `frames` is set.
pub fn import_one(pack_dir: &Path, src: &Path, target: &str, frames: bool) -> Result<ItemResult> {
    let dest = texture_file(pack_dir, target)?;
    let data = fs::read(src).ctx(src)?;
    let Some((w, h)) = png_dimensions(&data) else {
        return Err(CoreError::new(
            "bad_image",
            format!("{} is not a PNG image.", src.display()),
        ));
    };
    let src_meta = mcmeta_file(src);
    let meta_text = read_opt(&src_meta);
    let dest_meta = mcmeta_file(&dest);
    let frames = frames && meta_text.is_none() && mcmeta::strip_frames(w, h).is_some();
    let mut out = ItemResult {
        id: 0,
        target: target.to_owned(),
        ok: true,
        replaced: false,
        wrote_mcmeta: false,
        unchanged: false,
        error: None,
    };
    let png_same = read_opt(&dest).is_some_and(|d| d == data);
    let meta_same = meta_text.is_none() || read_opt(&dest_meta) == meta_text;
    if png_same && meta_same && !frames {
        out.unchanged = true;
        return Ok(out);
    }
    if !png_same {
        let anim = frames.then(|| Animation {
            frametime: DEFAULT_FRAMETIME,
            ..Default::default()
        });
        let r = import_image(pack_dir, target, src, anim.as_ref())?;
        out.replaced = r.replaced;
        out.wrote_mcmeta = r.wrote_mcmeta;
    } else if frames {
        let anim = Animation {
            frametime: DEFAULT_FRAMETIME,
            ..Default::default()
        };
        let existing = fs::read_to_string(&dest_meta).ok();
        let text = mcmeta::write_animation(existing.as_deref(), &anim)
            .or_else(|_| mcmeta::write_animation(None, &anim))?;
        fs::write(&dest_meta, text).ctx(&dest_meta)?;
        out.wrote_mcmeta = true;
    }
    if let Some(text) = meta_text {
        if !meta_same {
            out.replaced |= move_to_trash(pack_dir, &dest_meta, now_ms())?.is_some();
            fs::write(&dest_meta, text).ctx(&dest_meta)?;
            out.wrote_mcmeta = true;
        }
    }
    Ok(out)
}

/// Imports every item, carrying on after a failure. `sources[id]` is the file
/// of row `id`.
pub fn import_all(pack_dir: &Path, items: &[(usize, PathBuf, String, bool)]) -> Vec<ItemResult> {
    items
        .iter()
        .map(
            |(id, src, target, frames)| match import_one(pack_dir, src, target, *frames) {
                Ok(mut r) => {
                    r.id = *id;
                    r
                }
                Err(e) => ItemResult {
                    id: *id,
                    target: target.clone(),
                    ok: false,
                    replaced: false,
                    wrote_mcmeta: false,
                    unchanged: false,
                    error: Some(e),
                },
            },
        )
        .collect()
}

/// The trash folder of a pack (for messages).
pub fn trash_dir(pack_dir: &Path) -> PathBuf {
    pack_dir.join(PROJECT_DIR).join("trash")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;
    use crate::textures::{category_of, TextureEntry, INDEX_SCHEMA};

    fn entry(path: &str, w: u32, h: u32, animated: bool) -> TextureEntry {
        TextureEntry {
            path: path.to_owned(),
            category: category_of(path),
            width: w,
            height: h,
            animated,
            frames: 1,
            frametime: 1,
            interpolate: false,
            has_mcmeta: animated,
            has_thumb: false,
            used_by: Vec::new(),
            used_by_more: 0,
        }
    }

    fn index(paths: &[&str]) -> VanillaIndex {
        let mut entries: Vec<TextureEntry> = paths
            .iter()
            .map(|p| {
                entry(
                    p,
                    16,
                    if *p == "block/water_still" { 512 } else { 16 },
                    *p == "block/water_still",
                )
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
            "block/water_still",
            "block/prismarine",
            "item/red_dye",
            "item/diamond",
            "gui/sprites/widget/button",
            "gui/sprites/recipe_book/button",
            "entity/creeper/creeper",
        ])
    }

    fn legacy() -> VanillaIndex {
        index(&["blocks/planks_oak", "items/dye_powder_red", "items/diamond"])
    }

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        p
    }

    fn row<'a>(s: &'a BatchScan, rel: &str) -> &'a BatchRow {
        s.rows
            .iter()
            .find(|r| r.rel == rel)
            .unwrap_or_else(|| panic!("no row {rel}"))
    }

    #[test]
    fn the_three_rules_in_order() {
        let idx = modern();
        let m = Matcher::new(&idx, Some(&v("1.21.11")));
        let (rule, f) = m.match_rel("MyPack/assets/minecraft/textures/block/stone.png");
        assert_eq!(rule, Rule::PackPath);
        assert_eq!(f.unwrap().targets, ["block/stone"]);
        let (rule, f) = m.match_rel("art/block/stone.png");
        assert_eq!(rule, Rule::TexturePath);
        assert_eq!(f.unwrap().targets, ["block/stone"]);
        let (rule, f) = m.match_rel("loose/oak_planks.png");
        assert_eq!(rule, Rule::FileName);
        assert_eq!(f.unwrap().targets, ["block/oak_planks"]);
        // capitals in the file name are fine
        assert_eq!(
            m.match_rel("Oak_Planks.PNG").1.unwrap().targets,
            ["block/oak_planks"]
        );
        // a pack path that is not a texture of this version is unknown, not guessed
        let (rule, f) = m.match_rel("p/assets/minecraft/textures/block/nothing.png");
        assert_eq!(rule, Rule::PackPath);
        assert!(f.is_none());
        assert_eq!(m.match_rel("holiday.png"), (Rule::None, None));
    }

    #[test]
    fn same_name_in_two_folders_is_ambiguous() {
        let idx = modern();
        let m = Matcher::new(&idx, Some(&v("1.21.11")));
        let (rule, f) = m.match_rel("button.png");
        assert_eq!(rule, Rule::FileName);
        assert_eq!(
            f.unwrap().targets,
            [
                "gui/sprites/recipe_book/button",
                "gui/sprites/widget/button"
            ]
        );
        // with the folder it is not
        let (_, f) = m.match_rel("gui/sprites/widget/button.png");
        assert_eq!(f.unwrap().targets, ["gui/sprites/widget/button"]);
    }

    #[test]
    fn old_names_are_translated_to_the_pack_version() {
        let idx = modern();
        let m = Matcher::new(&idx, Some(&v("1.21.11")));
        for rel in [
            "planks_oak.png",
            "blocks/planks_oak.png",
            "old/assets/minecraft/textures/blocks/planks_oak.png",
        ] {
            let f = m.match_rel(rel).1.unwrap();
            assert_eq!(f.targets, ["block/oak_planks"], "{rel}");
            assert!(f.renamed_from.unwrap().ends_with("planks_oak"), "{rel}");
        }
        // a folder-only rename
        let f = m.match_rel("blocks/stone.png").1.unwrap();
        assert_eq!(f.targets, ["block/stone"]);
        assert_eq!(f.renamed_from.as_deref(), Some("blocks/stone"));
    }

    #[test]
    fn newer_names_are_translated_to_an_old_pack() {
        let idx = legacy();
        let m = Matcher::new(&idx, Some(&v("1.8.9")));
        let f = m.match_rel("item/red_dye.png").1.unwrap();
        assert_eq!(f.targets, ["items/dye_powder_red"]);
        assert_eq!(f.renamed_from.as_deref(), Some("item/red_dye"));
        let f = m.match_rel("red_dye.png").1.unwrap();
        assert_eq!(f.targets, ["items/dye_powder_red"]);
        let f = m.match_rel("oak_planks.png").1.unwrap();
        assert_eq!(f.targets, ["blocks/planks_oak"]);
        let f = m
            .match_rel("x/assets/minecraft/textures/block/oak_planks.png")
            .1
            .unwrap();
        assert_eq!(f.targets, ["blocks/planks_oak"]);
    }

    #[test]
    fn statuses_sizes_frames_and_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("in");
        let idx = modern();
        // the pack already has stone (same pixels) and diamond (other pixels)
        put(
            &pack,
            "assets/minecraft/textures/block/stone.png",
            &png(32, 32, 1),
        );
        put(
            &pack,
            "assets/minecraft/textures/item/diamond.png",
            &png(32, 32, 1),
        );
        put(&src, "stone.png", &png(32, 32, 1));
        put(&src, "diamond.png", &png(32, 32, 2));
        put(&src, "oak_planks.png", &png(16, 16, 3)); // wrong size for 32×
        put(&src, "holiday.png", &png(16, 16, 4));
        put(&src, "button.png", &png(200, 20, 5));
        // a strip without and with an mcmeta
        put(&src, "water_still.png", &png(32, 64, 6));
        put(&src, "prismarine.png", &png(32, 128, 7));
        put(
            &src,
            "prismarine.png.mcmeta",
            br#"{"animation":{"frametime":5}}"#,
        );
        // two files for one texture
        put(&src, "a/block/creeper.png", &png(4, 4, 1));
        put(&src, "entity/creeper/creeper.png", &png(64, 32, 8));
        put(&src, "b/creeper.png", &png(64, 32, 9));
        put(&src, "not_really.png", b"hello");
        // hidden folders are ignored
        put(&src, ".git/oak_planks.png", &png(32, 32, 1));

        let s = scan(
            std::slice::from_ref(&src),
            &pack,
            &idx,
            Some(&v("1.21.11")),
            32,
        )
        .unwrap();
        assert!(!s.truncated && !s.skipped_pack);
        assert!(!s.rows.iter().any(|r| r.rel.starts_with(".git")));

        let r = row(&s, "stone.png");
        assert_eq!(r.status, RowStatus::Same);
        assert!(!r.accept);
        let r = row(&s, "diamond.png");
        assert_eq!(r.status, RowStatus::Replaces);
        assert!(r.accept && !r.wrong_size);
        let r = row(&s, "oak_planks.png");
        assert_eq!(r.status, RowStatus::New);
        assert_eq!(r.expected, Some((32, 32)));
        assert!(r.wrong_size && r.accept, "a wrong size is only a warning");
        let r = row(&s, "holiday.png");
        assert_eq!(
            (r.status, r.rule, r.accept),
            (RowStatus::Unknown, Rule::None, false)
        );
        let r = row(&s, "button.png");
        assert_eq!(r.status, RowStatus::Ambiguous);
        assert_eq!(r.candidates.len(), 2);
        assert!(!r.accept && r.target.is_none());
        let r = row(&s, "water_still.png");
        assert_eq!(r.strip_frames, Some(2));
        assert!(r.frames_default, "the game's water is animated");
        assert!(!r.wrong_size);
        let r = row(&s, "prismarine.png");
        assert!(r.has_mcmeta && r.strip_frames.is_none());
        // a/block/creeper.png: "block/creeper" is no texture, so the file name decides
        let dups: Vec<&BatchRow> = s
            .rows
            .iter()
            .filter(|r| r.target.as_deref() == Some("entity/creeper/creeper"))
            .collect();
        assert_eq!(dups.len(), 3);
        assert!(dups.iter().all(|r| r.duplicate && !r.accept));
        let r = row(&s, "not_really.png");
        assert!(r.problem.is_some() && !r.accept);
    }

    #[test]
    fn the_pack_folder_is_left_out_or_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        put(
            &pack,
            "assets/minecraft/textures/block/stone.png",
            &png(16, 16, 1),
        );
        put(tmp.path(), "stone.png", &png(16, 16, 2));
        let idx = modern();
        let s = scan(&[tmp.path().to_path_buf()], &pack, &idx, None, 16).unwrap();
        assert!(s.skipped_pack);
        assert_eq!(s.rows.len(), 1);
        assert_eq!(s.rows[0].rel, "stone.png");
        let e = scan(std::slice::from_ref(&pack), &pack, &idx, None, 16).unwrap_err();
        assert_eq!(e.kind, "own_pack");
        let e = scan(&[tmp.path().join("nope")], &pack, &idx, None, 16).unwrap_err();
        assert_eq!(e.kind, "not_found");
        // dropped files: each by its own name; a dropped pack file is left out
        let drop = [
            tmp.path().join("stone.png"),
            texture_file(&pack, "block/stone").unwrap(),
        ];
        let s = scan(&drop, &pack, &idx, None, 16).unwrap();
        assert!(s.skipped_pack);
        assert_eq!(s.rows.len(), 1);
        assert_eq!(s.rows[0].target.as_deref(), Some("block/stone"));
        assert_eq!(s.folder, "2 dropped items");
    }

    #[test]
    fn many_files_are_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        let tiny = png(1, 1, 1);
        for i in 0..MAX_FILES + 3 {
            fs::write(src.join(format!("f{i}.png")), &tiny).unwrap();
        }
        let idx = modern();
        let s = scan(&[src], &tmp.path().join("pack"), &idx, None, 16).unwrap();
        assert!(s.truncated);
        assert_eq!(s.rows.len(), MAX_FILES);
    }

    #[test]
    fn same_pixels_ignores_how_the_png_is_compressed() {
        use image::ImageEncoder;
        let a = png(8, 8, 3);
        let img = image::load_from_memory(&a).unwrap();
        let mut b = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut b,
            image::codecs::png::CompressionType::Best,
            image::codecs::png::FilterType::Paeth,
        )
        .write_image(
            img.to_rgba8().as_raw(),
            8,
            8,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
        assert_ne!(a, b);
        assert!(same_pixels(&a, &b));
        assert!(!same_pixels(&a, &png(8, 8, 4)));
        assert!(!same_pixels(&a, &png(8, 9, 3)));
    }

    #[test]
    fn import_copies_bytes_keeps_old_files_and_carries_on() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("in");
        let old = png(16, 16, 1);
        put(&pack, "assets/minecraft/textures/item/diamond.png", &old);
        put(
            &pack,
            "assets/minecraft/textures/block/prismarine.png.mcmeta",
            br#"{"animation":{"frametime":9}}"#,
        );
        let a = put(&src, "diamond.png", &png(37, 21, 2));
        let b = put(&src, "prismarine.png", &png(16, 64, 3));
        let meta = br#"{"animation":{"frametime":5}}"#;
        put(&src, "prismarine.png.mcmeta", meta);
        let c = put(&src, "water.png", &png(16, 48, 4));
        let missing = src.join("gone.png");
        let res = import_all(
            &pack,
            &[
                (0, a.clone(), "item/diamond".into(), false),
                (1, missing, "block/stone".into(), false),
                (2, b.clone(), "block/prismarine".into(), false),
                (3, c.clone(), "block/water_still".into(), true),
                (4, a.clone(), "../evil".into(), false),
            ],
        );
        assert_eq!(res.len(), 5);
        assert!(res[0].ok && res[0].replaced);
        assert!(!res[1].ok && res[1].error.is_some());
        assert!(res[2].ok && res[2].wrote_mcmeta);
        assert!(res[3].ok && res[3].wrote_mcmeta);
        assert!(!res[4].ok);
        assert_eq!(res[3].id, 3);
        let tex = |p: &str| texture_file(&pack, p).unwrap();
        // byte for byte, never resized
        assert_eq!(
            fs::read(tex("item/diamond")).unwrap(),
            fs::read(&a).unwrap()
        );
        assert_eq!(
            fs::read(tex("block/prismarine")).unwrap(),
            fs::read(&b).unwrap()
        );
        assert_eq!(
            fs::read(mcmeta_file(&tex("block/prismarine"))).unwrap(),
            meta
        );
        let water = fs::read_to_string(mcmeta_file(&tex("block/water_still"))).unwrap();
        assert_eq!(
            mcmeta::parse_animation(&water).unwrap().unwrap().frametime,
            DEFAULT_FRAMETIME
        );
        // the old diamond and the old mcmeta are in the trash
        let kept: Vec<Vec<u8>> = WalkDir::new(trash_dir(&pack))
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| fs::read(e.path()).unwrap())
            .collect();
        assert!(kept.contains(&old));
        assert!(kept.contains(&br#"{"animation":{"frametime":9}}"#.to_vec()));
        // importing the same again writes nothing
        let again = import_one(&pack, &a, "item/diamond", false).unwrap();
        assert!(again.unchanged && !again.replaced);
    }
}

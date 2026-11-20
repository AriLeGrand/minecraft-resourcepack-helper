//! Checks before export, their one-click fixes, and the export itself
//! (folder or `.zip`, install into `resourcepacks`, copies for other versions).

use crate::error::{CoreError, IoCtx, Result};
use crate::import::{create_animation_mcmeta, move_to_trash};
use crate::mcmeta::strip_frames;
use crate::pack::{self, is_wrong_size, now_ms, safe_file_name, PackTexture, Project, PROJECT_DIR};
use crate::pack_format::{self, PackFormat};
use crate::pngopt;
use crate::renames::RenameTable;
use crate::textures::{
    category_of, mcmeta_file, png_dimensions, texture_file, Category, VanillaIndex, TEXTURES_DIR,
};
use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use walkdir::WalkDir;

// ---------------------------------------------------------------- checks

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Check {
    /// `ready`, `wrong_size`, `missing_mcmeta`, `old_names`, `unknown`, `pack_files`.
    pub id: String,
    pub ok: bool,
    pub title: String,
    pub detail: String,
    /// Label of the one-click fix, when there is one.
    pub fix: Option<String>,
    /// Textures concerned (for "Show").
    pub paths: Vec<String>,
}

fn list_names(paths: &[String], max: usize) -> String {
    let names: Vec<&str> = paths
        .iter()
        .take(max)
        .map(|p| p.rsplit('/').next().unwrap_or(p))
        .collect();
    let mut s = names.join(", ");
    if paths.len() > max {
        s.push_str(&format!(" and {} more", paths.len() - max));
    }
    s
}

/// Old-named pack files and the name they should have in `version`.
pub fn find_old_names(
    pack: &[PackTexture],
    vanilla: &VanillaIndex,
    version: &McVersion,
) -> Vec<(String, String)> {
    let table = RenameTable::builtin();
    let mut eras = vec![McVersion::parse("1.6.1").expect("valid")];
    eras.extend(table.steps().iter().map(|s| s.version.clone()));
    let mut out = Vec::new();
    for t in pack {
        if vanilla.get(&t.path).is_some() {
            continue;
        }
        for era in &eras {
            let mapped = table.map(&t.path, era, version);
            if let [new] = mapped.as_slice() {
                if *new != t.path && vanilla.get(new).is_some() {
                    out.push((t.path.clone(), new.clone()));
                    break;
                }
            }
        }
    }
    out
}

/// Runs every check. `vanilla` is the index of the pack's main version.
pub fn run_checks(
    pack_dir: &Path,
    project: &Project,
    pack: &[PackTexture],
    vanilla: Option<&VanillaIndex>,
    version: Option<&McVersion>,
) -> Vec<Check> {
    let mut checks = Vec::new();
    let version_label = project
        .version_id
        .clone()
        .unwrap_or_else(|| project.version_dir.clone());

    let old_names = match (vanilla, version) {
        (Some(v), Some(ver)) => find_old_names(pack, v, ver),
        _ => Vec::new(),
    };
    let unknown: Vec<String> = match vanilla {
        Some(v) => pack
            .iter()
            .filter(|t| v.get(&t.path).is_none() && !old_names.iter().any(|(o, _)| *o == t.path))
            .map(|t| t.path.clone())
            .collect(),
        None => Vec::new(),
    };
    let ready = pack.len() - old_names.len() - unknown.len();
    checks.push(Check {
        id: "ready".into(),
        ok: true,
        title: format!("{ready} texture{} ready", if ready == 1 { "" } else { "s" }),
        detail: if ready == 0 {
            "Nothing to export yet: edit or import a texture first".into()
        } else {
            format!("All in the right folders for {version_label}")
        },
        fix: None,
        paths: Vec::new(),
    });

    if let Some(v) = vanilla {
        let wrong: Vec<String> = pack
            .iter()
            .filter(|t| {
                v.get(&t.path)
                    .is_some_and(|e| is_wrong_size(e, t, project.resolution))
            })
            .map(|t| t.path.clone())
            .collect();
        if !wrong.is_empty() {
            checks.push(Check {
                id: "wrong_size".into(),
                ok: false,
                title: format!(
                    "{} texture{} not {}×",
                    wrong.len(),
                    if wrong.len() == 1 { " is" } else { "s are" },
                    project.resolution
                ),
                detail: format!(
                    "Your pack is {}×: {}",
                    project.resolution,
                    list_names(&wrong, 3)
                ),
                fix: Some("Show".into()),
                paths: wrong,
            });
        }
    }

    let tall: Vec<String> = pack
        .iter()
        .filter(|t| {
            !t.has_mcmeta
                && strip_frames(t.width, t.height).is_some()
                && matches!(
                    category_of(&t.path),
                    Category::Blocks | Category::Items | Category::Particles
                )
        })
        .map(|t| t.path.clone())
        .collect();
    if !tall.is_empty() {
        let first = tall[0].rsplit('/').next().unwrap_or(&tall[0]).to_owned();
        checks.push(Check {
            id: "missing_mcmeta".into(),
            ok: false,
            title: if tall.len() == 1 {
                format!("{first} has frames but no animation")
            } else {
                format!("{} textures have frames but no animation", tall.len())
            },
            detail: "Tall image without .mcmeta".into(),
            fix: Some("Create .mcmeta".into()),
            paths: tall,
        });
    }

    if !old_names.is_empty() {
        let (o, n) = &old_names[0];
        checks.push(Check {
            id: "old_names".into(),
            ok: false,
            title: format!(
                "{} file{} old names",
                old_names.len(),
                if old_names.len() == 1 {
                    " uses"
                } else {
                    "s use"
                }
            ),
            detail: format!(
                "{}.png → {}.png",
                o.rsplit('/').next().unwrap_or(o),
                n.rsplit('/').next().unwrap_or(n)
            ),
            fix: Some("Rename".into()),
            paths: old_names.iter().map(|(o, _)| o.clone()).collect(),
        });
    }

    if !unknown.is_empty() {
        checks.push(Check {
            id: "unknown".into(),
            ok: false,
            title: format!(
                "{} file{} not used by {version_label}",
                unknown.len(),
                if unknown.len() == 1 { " is" } else { "s are" }
            ),
            detail: format!("The game ignores them: {}", list_names(&unknown, 3)),
            fix: Some("Show".into()),
            paths: unknown,
        });
    }

    let icon = fs::read(pack_dir.join("pack.png"))
        .ok()
        .and_then(|d| png_dimensions(&d));
    let meta = fs::read_to_string(pack_dir.join("pack.mcmeta"))
        .ok()
        .and_then(|t| pack_format::read_pack_mcmeta(&t).ok());
    let meta_ok = meta
        .as_ref()
        .is_some_and(|m| m.format.map(|f| f.major) == Some(project.format.major));
    let icon_ok = icon.is_some_and(|(w, h)| w == h);
    if icon_ok && meta_ok {
        let (w, h) = icon.unwrap_or((0, 0));
        checks.push(Check {
            id: "pack_files".into(),
            ok: true,
            title: "pack.png and pack.mcmeta OK".into(),
            detail: format!("{w}×{h} · format {}", project.format.label()),
            fix: None,
            paths: Vec::new(),
        });
    } else {
        let detail = match (icon, meta_ok) {
            (None, _) => "pack.png is missing or not a PNG",
            (Some(_), _) if !icon_ok => "pack.png must be square",
            _ => "pack.mcmeta is missing or has another format",
        };
        checks.push(Check {
            id: "pack_files".into(),
            ok: false,
            title: "Pack files need attention".into(),
            detail: detail.into(),
            fix: Some("Repair".into()),
            paths: Vec::new(),
        });
    }
    checks
}

/// Applies the one-click fix of a check. Returns a short sentence for the status bar.
pub fn apply_fix(
    pack_dir: &Path,
    project: &Project,
    check_id: &str,
    pack: &[PackTexture],
    vanilla: Option<&VanillaIndex>,
    version: Option<&McVersion>,
) -> Result<String> {
    match check_id {
        "missing_mcmeta" => {
            let mut n = 0;
            for t in pack {
                if !t.has_mcmeta
                    && strip_frames(t.width, t.height).is_some()
                    && matches!(
                        category_of(&t.path),
                        Category::Blocks | Category::Items | Category::Particles
                    )
                {
                    create_animation_mcmeta(pack_dir, &t.path, 2)?;
                    n += 1;
                }
            }
            Ok(format!(
                "Created {n} .mcmeta file{}",
                if n == 1 { "" } else { "s" }
            ))
        }
        "old_names" => {
            let (Some(v), Some(ver)) = (vanilla, version) else {
                return Err(CoreError::new(
                    "no_vanilla",
                    "The game textures for this version are not extracted yet.",
                ));
            };
            let mut renamed = 0;
            let mut kept = 0;
            for (old, new) in find_old_names(pack, v, ver) {
                let (from, to) = (texture_file(pack_dir, &old)?, texture_file(pack_dir, &new)?);
                if to.exists() {
                    kept += 1; // never overwrite a texture that is already there
                    continue;
                }
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).ctx(parent)?;
                }
                fs::rename(&from, &to).ctx(&from)?;
                let (fm, tm) = (mcmeta_file(&from), mcmeta_file(&to));
                if fm.is_file() && !tm.exists() {
                    fs::rename(&fm, &tm).ctx(&fm)?;
                }
                // notes and earlier versions follow the texture (best effort)
                let _ = crate::notes::rename(pack_dir, &old, &new);
                let _ = crate::history::rename(pack_dir, &old, &new);
                renamed += 1;
            }
            Ok(if kept > 0 {
                format!("Renamed {renamed} file(s); {kept} left alone because the new name already exists")
            } else {
                format!(
                    "Renamed {renamed} file{}",
                    if renamed == 1 { "" } else { "s" }
                )
            })
        }
        "pack_files" => {
            let icon = pack_dir.join("pack.png");
            let square = fs::read(&icon)
                .ok()
                .and_then(|d| png_dimensions(&d))
                .is_some_and(|(w, h)| w == h);
            if !square {
                move_to_trash(pack_dir, &icon, now_ms())?;
                fs::write(&icon, pack::placeholder_icon(&project.name)).ctx(&icon)?;
            }
            pack::write_pack_mcmeta(pack_dir, project)?;
            Ok("Pack files repaired".into())
        }
        other => Err(CoreError::new(
            "no_fix",
            format!("There is no automatic fix for \"{other}\"."),
        )),
    }
}

// ---------------------------------------------------------------- export

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportKind {
    Zip,
    Folder,
}

/// Another version to export a copy for.
#[derive(Debug, Clone)]
pub struct AltTarget {
    /// Shown in file names, e.g. `1.12.2`.
    pub label: String,
    pub version: McVersion,
    pub format: PackFormat,
    /// Textures of that version when it is extracted; used to skip textures
    /// that do not exist there.
    pub index: Option<VanillaIndex>,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub kind: ExportKind,
    pub out_dir: PathBuf,
    /// `.minecraft/resourcepacks`, when the pack should be installed.
    pub install_dir: Option<PathBuf>,
    /// Skip textures whose pixels are identical to the game's.
    pub only_changed: bool,
    /// Extracted vanilla files of the main version (for `only_changed`).
    pub vanilla_root: Option<PathBuf>,
    /// "Make PNG files smaller (same pixels)": every exported PNG is
    /// re-compressed losslessly (`pngopt`); the pack's own files are untouched.
    pub optimize_png: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportOutput {
    pub version: String,
    pub path: String,
    pub files: usize,
    pub renamed: usize,
    /// Textures left out (not in that version, or unchanged).
    pub skipped: Vec<String>,
    pub installed_to: Option<String>,
    /// Total size of the PNG files as they are in the pack…
    pub png_bytes_before: u64,
    /// …and as written (smaller when `optimize_png` found savings).
    pub png_bytes_after: u64,
}

/// Name of the exported file or folder (without extension).
pub fn export_name(project: &Project, version_label: &str) -> String {
    format!(
        "{} {}",
        safe_file_name(&project.name),
        safe_file_name(version_label)
    )
}

fn pixels(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let img = image::open(path).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut raw = img.into_raw();
    for px in raw.as_chunks_mut::<4>().0 {
        if px[3] == 0 {
            *px = [0, 0, 0, 0];
        }
    }
    Some((w, h, raw))
}

/// Every file of the pack that belongs in an export: relative path (with `/`)
/// and absolute path. Hidden files and the app's own folder are left out.
fn collect_files(pack_dir: &Path, exclude: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let walker = WalkDir::new(pack_dir).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        e.depth() == 0 || !(name.starts_with('.') || e.path() == exclude)
    });
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(pack_dir).unwrap_or(entry.path());
        let rel = rel
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if rel.ends_with(".zip") && !rel.contains('/') {
            continue; // an export left in the pack folder
        }
        out.push((rel, entry.path().to_path_buf()));
    }
    out.sort();
    out
}

/// What to write for one target: destination path -> source.
enum Source {
    File(PathBuf),
    Bytes(Vec<u8>),
}

struct Plan {
    files: BTreeMap<String, Source>,
    renamed: usize,
    skipped: Vec<String>,
}

fn split_texture(rel: &str) -> Option<(&str, &str)> {
    let rest = rel.strip_prefix(TEXTURES_DIR)?.strip_prefix('/')?;
    if let Some(p) = rest.strip_suffix(".png.mcmeta") {
        Some((p, ".png.mcmeta"))
    } else {
        rest.strip_suffix(".png").map(|p| (p, ".png"))
    }
}

fn plan(
    files: &[(String, PathBuf)],
    project: &Project,
    format: PackFormat,
    main: &McVersion,
    alt: Option<&AltTarget>,
    opts: &ExportOptions,
) -> Plan {
    let table = RenameTable::builtin();
    let mut out = Plan {
        files: BTreeMap::new(),
        renamed: 0,
        skipped: Vec::new(),
    };
    // textures identical to vanilla, when asked to leave them out
    let mut unchanged: Vec<&str> = Vec::new();
    if opts.only_changed {
        if let Some(root) = &opts.vanilla_root {
            for (rel, abs) in files {
                if let Some((tex, ".png")) = split_texture(rel) {
                    let same = texture_file(root, tex)
                        .ok()
                        .filter(|v| v.is_file())
                        .is_some_and(|v| pixels(&v).is_some_and(|a| pixels(abs) == Some(a)));
                    if same {
                        unchanged.push(tex);
                        out.skipped.push(format!("{tex} (same as the game's)"));
                    }
                }
            }
        }
    }
    for (rel, abs) in files {
        if rel == "pack.mcmeta" {
            continue;
        }
        let Some((tex, ext)) = split_texture(rel) else {
            out.files.insert(rel.clone(), Source::File(abs.clone()));
            continue;
        };
        if unchanged.contains(&tex) {
            continue;
        }
        let targets = match alt {
            Some(a) => table.map(tex, main, &a.version),
            None => vec![tex.to_owned()],
        };
        if targets.is_empty() {
            if ext == ".png" {
                out.skipped.push(format!(
                    "{tex} (does not exist in {})",
                    alt.map(|a| a.label.as_str()).unwrap_or("")
                ));
            }
            continue;
        }
        for target in targets {
            if let Some(a) = alt {
                if a.index.as_ref().is_some_and(|i| i.get(&target).is_none()) {
                    if ext == ".png" {
                        out.skipped.push(format!("{tex} (not in {})", a.label));
                    }
                    continue;
                }
            }
            if target != tex && ext == ".png" {
                out.renamed += 1;
            }
            out.files.insert(
                format!("{TEXTURES_DIR}/{target}{ext}"),
                Source::File(abs.clone()),
            );
        }
    }
    out.files.insert(
        "pack.mcmeta".into(),
        Source::Bytes(
            pack_format::pack_mcmeta_text(&project.description, format, None).into_bytes(),
        ),
    );
    out.skipped.sort();
    out
}

fn read_source(src: &Source) -> Result<Vec<u8>> {
    match src {
        Source::File(p) => fs::read(p).ctx(p),
        Source::Bytes(b) => Ok(b.clone()),
    }
}

/// Re-compressed PNG files of one export, by source file: (original size,
/// bytes to write). Shared by the copies for other versions.
type PngCache = HashMap<PathBuf, Optimised>;
/// (original size, bytes to write)
type Optimised = (u64, Vec<u8>);

/// Fills `cache` for every PNG of `plan` that is not in it yet, on several threads.
fn optimise_pngs(plan: &Plan, cache: &mut PngCache) -> Result<()> {
    let mut todo: Vec<&PathBuf> = plan
        .files
        .iter()
        .filter_map(|(rel, src)| match src {
            Source::File(p) if rel.ends_with(".png") && !cache.contains_key(p) => Some(p),
            _ => None,
        })
        .collect();
    todo.sort();
    todo.dedup();
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<(PathBuf, Result<Optimised>)>> = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..threads.min(todo.len()) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(p) = todo.get(i) else { break };
                let r = fs::read(p)
                    .ctx(p)
                    .map(|d| (d.len() as u64, pngopt::smaller_png(&d)));
                done.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(((*p).clone(), r));
            });
        }
    });
    for (p, r) in done.into_inner().unwrap_or_else(|e| e.into_inner()) {
        cache.insert(p, r?);
    }
    Ok(())
}

/// Sizes of the PNG files of an output, before and after.
#[derive(Default)]
struct PngTotals {
    before: u64,
    after: u64,
}

/// The bytes to write for one file, counting PNG sizes.
fn bytes_for(rel: &str, src: &Source, cache: &PngCache, totals: &mut PngTotals) -> Result<Vec<u8>> {
    if let Source::File(p) = src {
        if let Some((len, data)) = cache.get(p) {
            totals.before += len;
            totals.after += data.len() as u64;
            return Ok(data.clone());
        }
    }
    let data = read_source(src)?;
    if rel.ends_with(".png") {
        totals.before += data.len() as u64;
        totals.after += data.len() as u64;
    }
    Ok(data)
}

fn write_zip(dest: &Path, plan: &Plan, cache: &PngCache, totals: &mut PngTotals) -> Result<()> {
    let tmp = dest.with_extension("zip.tmp");
    let result = (|| -> Result<()> {
        let mut zip = zip::ZipWriter::new(fs::File::create(&tmp).ctx(&tmp)?);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let zerr = |e: zip::result::ZipError| {
            CoreError::new("io", format!("Could not write {}: {e}", dest.display()))
        };
        for (rel, src) in &plan.files {
            zip.start_file(rel.as_str(), opts).map_err(zerr)?;
            zip.write_all(&bytes_for(rel, src, cache, totals)?)
                .ctx(&tmp)?;
        }
        zip.finish().map_err(zerr)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if dest.exists() {
        fs::remove_file(dest).ctx(dest)?;
    }
    fs::rename(&tmp, dest).ctx(dest)
}

/// A folder may only be replaced when it is empty or clearly a previous export.
fn clear_previous_folder(dest: &Path) -> Result<()> {
    if !dest.exists() {
        return Ok(());
    }
    let is_empty = fs::read_dir(dest).ctx(dest)?.next().is_none();
    if is_empty || dest.join("pack.mcmeta").is_file() {
        return fs::remove_dir_all(dest).ctx(dest);
    }
    Err(CoreError::new(
        "not_empty",
        format!(
            "{} already exists and is not a resource pack.",
            dest.display()
        ),
    )
    .hint("Rename or move that folder, or choose another export location."))
}

fn write_folder(dest: &Path, plan: &Plan, cache: &PngCache, totals: &mut PngTotals) -> Result<()> {
    clear_previous_folder(dest)?;
    for (rel, src) in &plan.files {
        let out = rel
            .split('/')
            .fold(dest.to_path_buf(), |p, seg| p.join(seg));
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).ctx(parent)?;
        }
        fs::write(&out, bytes_for(rel, src, cache, totals)?).ctx(&out)?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    for entry in WalkDir::new(from).into_iter().filter_map(|e| e.ok()) {
        let rel = entry.path().strip_prefix(from).unwrap_or(entry.path());
        let out = to.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).ctx(&out)?;
        } else {
            fs::copy(entry.path(), &out).ctx(&out)?;
        }
    }
    Ok(())
}

/// Exports the pack for its main version and for each `alt` version.
/// The caller records `last_export_ms` afterwards.
pub fn export_pack(
    pack_dir: &Path,
    project: &Project,
    main: &McVersion,
    alts: &[AltTarget],
    opts: &ExportOptions,
) -> Result<Vec<ExportOutput>> {
    fs::create_dir_all(&opts.out_dir).ctx(&opts.out_dir)?;
    if let Some(dir) = &opts.install_dir {
        if !dir.is_dir() {
            return Err(CoreError::new("no_resourcepacks", format!("{} does not exist.", dir.display()))
                .hint("Start Minecraft once so it creates its folders, or turn off \"Install into Minecraft\"."));
        }
    }
    let files = collect_files(pack_dir, &opts.out_dir);
    let _ = PROJECT_DIR; // excluded by the hidden-file rule in collect_files
    let main_label = project
        .version_id
        .clone()
        .unwrap_or_else(|| project.version_dir.clone());
    let mut targets: Vec<(String, PackFormat, Option<&AltTarget>)> =
        vec![(main_label, project.format, None)];
    for a in alts {
        targets.push((a.label.clone(), a.format, Some(a)));
    }
    let mut outputs = Vec::new();
    let mut cache = PngCache::new();
    for (label, format, alt) in targets {
        let p = plan(&files, project, format, main, alt, opts);
        if opts.optimize_png {
            optimise_pngs(&p, &mut cache)?;
        }
        let mut totals = PngTotals::default();
        let name = export_name(project, &label);
        let dest = match opts.kind {
            ExportKind::Zip => opts.out_dir.join(format!("{name}.zip")),
            ExportKind::Folder => opts.out_dir.join(&name),
        };
        match opts.kind {
            ExportKind::Zip => write_zip(&dest, &p, &cache, &mut totals)?,
            ExportKind::Folder => write_folder(&dest, &p, &cache, &mut totals)?,
        }
        let mut installed_to = None;
        if let Some(dir) = &opts.install_dir {
            let target = dir.join(dest.file_name().expect("export has a file name"));
            if target != dest {
                match opts.kind {
                    ExportKind::Zip => {
                        fs::copy(&dest, &target).ctx(&target)?;
                    }
                    ExportKind::Folder => {
                        clear_previous_folder(&target)?;
                        copy_dir(&dest, &target)?;
                    }
                }
            }
            installed_to = Some(target.to_string_lossy().into_owned());
        }
        outputs.push(ExportOutput {
            version: label,
            path: dest.to_string_lossy().into_owned(),
            files: p.files.len(),
            renamed: p.renamed,
            skipped: p.skipped,
            installed_to,
            png_bytes_before: totals.before,
            png_bytes_after: totals.after,
        });
    }
    Ok(outputs)
}

/// Unpacks a downloaded pack `.zip` into `dest` (which must be empty or new).
pub fn import_zip(zip_path: &Path, dest: &Path) -> Result<usize> {
    if dest.exists() && fs::read_dir(dest).ctx(dest)?.next().is_some() {
        return Err(CoreError::new(
            "not_empty",
            format!("{} already contains files.", dest.display()),
        )
        .hint("Choose an empty or new folder for the imported pack."));
    }
    let bad = || {
        CoreError::new(
            "bad_zip",
            format!("{} is not a readable .zip file.", zip_path.display()),
        )
    };
    let mut zip =
        zip::ZipArchive::new(fs::File::open(zip_path).ctx(zip_path)?).map_err(|_| bad())?;
    // some packs wrap everything in one top folder: find where pack.mcmeta is
    let prefix = zip
        .file_names()
        .filter(|n| n.ends_with("pack.mcmeta"))
        .min_by_key(|n| n.len())
        .map(|n| n.trim_end_matches("pack.mcmeta").to_owned())
        .ok_or_else(|| {
            CoreError::new(
                "not_a_pack",
                "This .zip is not a resource pack (no pack.mcmeta inside).",
            )
        })?;
    fs::create_dir_all(dest).ctx(dest)?;
    let mut count = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| bad())?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let Ok(rel) = rel.strip_prefix(Path::new(&prefix)) else {
            continue;
        };
        if entry.is_dir() || rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).ctx(parent)?;
        }
        let mut f = fs::File::create(&out).ctx(&out)?;
        std::io::copy(&mut entry, &mut f).map_err(|_| bad())?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::{extract_version, vanilla_dir};
    use crate::minecraft::{list_versions, testutil::*, InstalledVersion};
    use crate::pack::{create_pack, scan_pack};
    use std::io::Read;

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        mc: PathBuf,
        versions: Vec<InstalledVersion>,
        cache: PathBuf,
        pack: PathBuf,
        project: Project,
        index: VanillaIndex,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let mc = fake_minecraft(&root);
        let versions = list_versions(&mc).unwrap();
        let cache = root.join("cache");
        let modern = versions
            .iter()
            .find(|v| v.dir_name == "1.21.4")
            .unwrap()
            .clone();
        let index = extract_version(&cache, &modern, &mut |_, _| {}).unwrap();
        let pack = root.join("Deep Sea Pack");
        let project = create_pack(&pack, "Deep Sea Pack", "§bOcean", &modern, 32).unwrap();
        Fixture {
            _tmp: tmp,
            root,
            mc,
            versions,
            cache,
            pack,
            project,
            index,
        }
    }

    fn put(pack: &Path, tex: &str, data: Vec<u8>) {
        let f = texture_file(pack, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, data).unwrap();
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let z = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut v: Vec<String> = z.file_names().map(str::to_owned).collect();
        v.sort();
        v
    }

    fn zip_read(path: &Path, name: &str) -> Vec<u8> {
        let mut z = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut out = Vec::new();
        z.by_name(name).unwrap().read_to_end(&mut out).unwrap();
        out
    }

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    fn opts(f: &Fixture, kind: ExportKind) -> ExportOptions {
        ExportOptions {
            kind,
            out_dir: f.root.join("export"),
            install_dir: None,
            only_changed: false,
            vanilla_root: None,
            optimize_png: false,
        }
    }

    #[test]
    fn checks_on_a_fresh_pack() {
        let f = fixture();
        let checks = run_checks(
            &f.pack,
            &f.project,
            &scan_pack(&f.pack),
            Some(&f.index),
            Some(&v("1.21.4")),
        );
        assert_eq!(
            checks.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["ready", "pack_files"]
        );
        assert!(checks.iter().all(|c| c.ok));
        assert_eq!(checks[1].detail, "128×128 · format 46");
    }

    #[test]
    fn checks_find_every_problem_and_fixes_work() {
        let f = fixture();
        put(&f.pack, "block/oak_planks", png(32, 32, 1)); // fine
        put(&f.pack, "block/stone", png(16, 16, 2)); // wrong size for 32x
        put(&f.pack, "item/diamond", png(32, 96, 3)); // tall, no mcmeta
        put(&f.pack, "blocks/tallgrass", png(32, 32, 4)); // old name -> block/short_grass
        put(&f.pack, "block/my_own_thing", png(32, 32, 5)); // unknown
        fs::remove_file(f.pack.join("pack.png")).unwrap();
        let ver = v("1.21.4");
        let scan = scan_pack(&f.pack);
        let checks = run_checks(&f.pack, &f.project, &scan, Some(&f.index), Some(&ver));
        let by = |id: &str| {
            checks
                .iter()
                .find(|c| c.id == id)
                .unwrap_or_else(|| panic!("no check {id}"))
        };
        assert_eq!(by("ready").title, "3 textures ready");
        assert_eq!(by("wrong_size").paths, ["block/stone", "item/diamond"]);
        assert_eq!(
            by("missing_mcmeta").title,
            "diamond has frames but no animation"
        );
        assert_eq!(by("old_names").detail, "tallgrass.png → short_grass.png");
        assert_eq!(by("unknown").paths, ["block/my_own_thing"]);
        assert!(!by("pack_files").ok);

        assert_eq!(
            apply_fix(
                &f.pack,
                &f.project,
                "missing_mcmeta",
                &scan,
                Some(&f.index),
                Some(&ver)
            )
            .unwrap(),
            "Created 1 .mcmeta file"
        );
        assert_eq!(
            apply_fix(
                &f.pack,
                &f.project,
                "old_names",
                &scan,
                Some(&f.index),
                Some(&ver)
            )
            .unwrap(),
            "Renamed 1 file"
        );
        apply_fix(
            &f.pack,
            &f.project,
            "pack_files",
            &scan,
            Some(&f.index),
            Some(&ver),
        )
        .unwrap();
        assert_eq!(
            apply_fix(&f.pack, &f.project, "wrong_size", &scan, None, None)
                .unwrap_err()
                .kind,
            "no_fix"
        );

        let scan = scan_pack(&f.pack);
        assert!(scan.iter().any(|t| t.path == "block/short_grass"));
        assert!(!scan.iter().any(|t| t.path == "blocks/tallgrass"));
        let checks = run_checks(&f.pack, &f.project, &scan, Some(&f.index), Some(&ver));
        let ids: Vec<&str> = checks.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["ready", "wrong_size", "unknown", "pack_files"]);
        assert!(checks.last().unwrap().ok);
    }

    #[test]
    fn rename_fix_never_overwrites() {
        let f = fixture();
        put(&f.pack, "blocks/tallgrass", png(32, 32, 4));
        put(&f.pack, "block/short_grass", png(32, 32, 9));
        let scan = scan_pack(&f.pack);
        let msg = apply_fix(
            &f.pack,
            &f.project,
            "old_names",
            &scan,
            Some(&f.index),
            Some(&v("1.21.4")),
        )
        .unwrap();
        assert!(msg.contains("left alone"));
        assert_eq!(
            fs::read(texture_file(&f.pack, "block/short_grass").unwrap()).unwrap(),
            png(32, 32, 9)
        );
        assert!(texture_file(&f.pack, "blocks/tallgrass").unwrap().exists());
    }

    #[test]
    fn zip_export_contains_a_normal_pack_and_nothing_private() {
        let f = fixture();
        put(&f.pack, "block/oak_planks", png(32, 32, 1));
        put(&f.pack, "block/prismarine", png(32, 128, 2));
        fs::write(
            mcmeta_file(&texture_file(&f.pack, "block/prismarine").unwrap()),
            r#"{"animation":{"frametime":2}}"#,
        )
        .unwrap();
        fs::write(f.pack.join("pack.mcmeta"), "user broke this").unwrap();
        let out = export_pack(
            &f.pack,
            &f.project,
            &v("1.21.4"),
            &[],
            &opts(&f, ExportKind::Zip),
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        let zip = PathBuf::from(&out[0].path);
        assert!(zip.ends_with("export/Deep Sea Pack 1.21.4.zip"));
        assert_eq!(
            zip_names(&zip),
            [
                "assets/minecraft/textures/block/oak_planks.png",
                "assets/minecraft/textures/block/prismarine.png",
                "assets/minecraft/textures/block/prismarine.png.mcmeta",
                "pack.mcmeta",
                "pack.png",
            ]
        );
        // pixel-exact files, regenerated pack.mcmeta
        assert_eq!(
            zip_read(&zip, "assets/minecraft/textures/block/oak_planks.png"),
            png(32, 32, 1)
        );
        let meta = pack_format::read_pack_mcmeta(
            &String::from_utf8(zip_read(&zip, "pack.mcmeta")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            (meta.description.as_str(), meta.format),
            ("§bOcean", Some(PackFormat::new(46)))
        );
        // exporting again replaces the previous export
        export_pack(
            &f.pack,
            &f.project,
            &v("1.21.4"),
            &[],
            &opts(&f, ExportKind::Zip),
        )
        .unwrap();
        assert!(!zip.with_extension("zip.tmp").exists());
    }

    #[test]
    fn copy_for_an_old_version_uses_old_names_and_skips_missing_textures() {
        let f = fixture();
        put(&f.pack, "block/oak_planks", png(32, 32, 1));
        put(&f.pack, "block/short_grass", png(32, 32, 2));
        put(&f.pack, "item/red_dye", png(32, 32, 3));
        put(&f.pack, "block/stone", png(32, 32, 4));
        put(&f.pack, "block/prismarine", png(32, 32, 5)); // not in the fake 1.8.9
        let old = f.versions.iter().find(|x| x.dir_name == "1.8.9").unwrap();
        let old_index = extract_version(&f.cache, old, &mut |_, _| {}).unwrap();
        let alt = AltTarget {
            label: "1.8.9".into(),
            version: v("1.8.9"),
            format: PackFormat::new(1),
            index: Some(old_index),
        };
        let out = export_pack(
            &f.pack,
            &f.project,
            &v("1.21.4"),
            &[alt],
            &opts(&f, ExportKind::Zip),
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        let old_out = &out[1];
        assert_eq!(old_out.version, "1.8.9");
        assert_eq!(old_out.renamed, 4); // folder changes count too
        assert_eq!(old_out.skipped, ["block/prismarine (not in 1.8.9)"]);
        let names = zip_names(Path::new(&old_out.path));
        assert_eq!(
            names,
            [
                "assets/minecraft/textures/blocks/planks_oak.png",
                "assets/minecraft/textures/blocks/stone.png",
                "assets/minecraft/textures/blocks/tallgrass.png",
                "assets/minecraft/textures/items/dye_powder_red.png",
                "pack.mcmeta",
                "pack.png",
            ]
        );
        let meta = pack_format::read_pack_mcmeta(
            &String::from_utf8(zip_read(Path::new(&old_out.path), "pack.mcmeta")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta.format, Some(PackFormat::new(1)));
        // the main export keeps the new names
        assert!(zip_names(Path::new(&out[0].path))
            .contains(&"assets/minecraft/textures/block/short_grass.png".to_owned()));
    }

    #[test]
    fn folder_export_and_install() {
        let f = fixture();
        put(&f.pack, "block/oak_planks", png(32, 32, 1));
        let mut o = opts(&f, ExportKind::Folder);
        o.install_dir = Some(f.mc.join("resourcepacks"));
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        let dir = PathBuf::from(&out[0].path);
        assert!(dir.join("pack.mcmeta").is_file() && dir.join("pack.png").is_file());
        assert!(dir
            .join("assets/minecraft/textures/block/oak_planks.png")
            .is_file());
        assert!(!dir.join(PROJECT_DIR).exists());
        let installed = PathBuf::from(out[0].installed_to.as_ref().unwrap());
        assert!(installed.starts_with(f.mc.join("resourcepacks")));
        assert!(installed
            .join("assets/minecraft/textures/block/oak_planks.png")
            .is_file());
        // a second export replaces the first one; a removed texture disappears
        fs::remove_file(texture_file(&f.pack, "block/oak_planks").unwrap()).unwrap();
        export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        assert!(!installed
            .join("assets/minecraft/textures/block/oak_planks.png")
            .exists());

        let mut z = opts(&f, ExportKind::Zip);
        z.install_dir = Some(f.mc.join("resourcepacks"));
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &z).unwrap();
        assert!(Path::new(out[0].installed_to.as_ref().unwrap()).is_file());
    }

    #[test]
    fn export_never_deletes_a_foreign_folder() {
        let f = fixture();
        let precious = f.root.join("export").join("Deep Sea Pack 1.21.4");
        fs::create_dir_all(&precious).unwrap();
        fs::write(precious.join("thesis.docx"), "years of work").unwrap();
        let e = export_pack(
            &f.pack,
            &f.project,
            &v("1.21.4"),
            &[],
            &opts(&f, ExportKind::Folder),
        )
        .unwrap_err();
        assert_eq!(e.kind, "not_empty");
        assert_eq!(
            fs::read_to_string(precious.join("thesis.docx")).unwrap(),
            "years of work"
        );
    }

    #[test]
    fn missing_resourcepacks_folder_is_reported_before_writing() {
        let f = fixture();
        let mut o = opts(&f, ExportKind::Zip);
        o.install_dir = Some(f.root.join("nowhere").join("resourcepacks"));
        let e = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap_err();
        assert_eq!(e.kind, "no_resourcepacks");
        assert!(!f
            .root
            .join("export")
            .join("Deep Sea Pack 1.21.4.zip")
            .exists());
    }

    #[test]
    fn only_changed_skips_textures_identical_to_the_game() {
        let f = fixture();
        let vroot = vanilla_dir(&f.cache, "1.21.4");
        // same pixels as vanilla but a different file (re-encoded)
        let vanilla_png = texture_file(&vroot, "block/stone").unwrap();
        let img = image::open(&vanilla_png).unwrap();
        let dest = texture_file(&f.pack, "block/stone").unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        img.to_rgb8().save(&dest).unwrap();
        put(&f.pack, "block/oak_planks", png(32, 32, 1));
        let mut o = opts(&f, ExportKind::Zip);
        o.only_changed = true;
        o.vanilla_root = Some(vroot);
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        assert_eq!(out[0].skipped, ["block/stone (same as the game's)"]);
        let names = zip_names(Path::new(&out[0].path));
        assert!(names.contains(&"assets/minecraft/textures/block/oak_planks.png".to_owned()));
        assert!(!names.iter().any(|n| n.contains("stone")));
    }

    #[test]
    fn smaller_png_files_have_the_same_pixels_and_leave_the_pack_alone() {
        let f = fixture();
        // poorly compressed files: no filter, fast deflate, a long comment
        let fat = |seed: u8| {
            let raw = image::load_from_memory(&png(32, 32, seed))
                .unwrap()
                .to_rgba8();
            let mut out = Vec::new();
            {
                let mut e = ::png::Encoder::new(&mut out, 32, 32);
                e.set_color(::png::ColorType::Rgba);
                e.set_compression(::png::Compression::Fast);
                e.set_filter(::png::Filter::NoFilter);
                e.add_text_chunk("Comment".into(), "y".repeat(300)).unwrap();
                e.write_header().unwrap().write_image_data(&raw).unwrap();
            }
            out
        };
        let names = ["block/oak_planks", "item/diamond"];
        put(&f.pack, names[0], fat(1));
        put(&f.pack, names[1], fat(2));
        let before: Vec<Vec<u8>> = names
            .iter()
            .map(|t| fs::read(texture_file(&f.pack, t).unwrap()).unwrap())
            .collect();
        let old = f.versions.iter().find(|x| x.dir_name == "1.8.9").unwrap();
        let alt = AltTarget {
            label: "1.8.9".into(),
            version: v("1.8.9"),
            format: PackFormat::new(1),
            index: Some(extract_version(&f.cache, old, &mut |_, _| {}).unwrap()),
        };
        let mut o = opts(&f, ExportKind::Zip);
        o.optimize_png = true;
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[alt], &o).unwrap();
        for (o, names) in out
            .iter()
            .zip([names, ["blocks/planks_oak", "items/diamond"]])
        {
            assert!(o.png_bytes_after < o.png_bytes_before, "{o:?}");
            for (name, orig) in names.iter().zip(&before) {
                let got = zip_read(
                    Path::new(&o.path),
                    &format!("assets/minecraft/textures/{name}.png"),
                );
                assert!(got.len() < orig.len());
                assert!(pngopt::identical_pixels(&got, orig), "{name}");
            }
            let icon = zip_read(Path::new(&o.path), "pack.png");
            assert!(pngopt::identical_pixels(
                &icon,
                &fs::read(f.pack.join("pack.png")).unwrap()
            ));
        }
        // the pack's own files are never touched
        for (t, orig) in names.iter().zip(&before) {
            assert_eq!(&fs::read(texture_file(&f.pack, t).unwrap()).unwrap(), orig);
        }
        // a folder export too; without the option the sizes are unchanged
        let mut o = opts(&f, ExportKind::Folder);
        o.optimize_png = true;
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        let file = Path::new(&out[0].path).join("assets/minecraft/textures/item/diamond.png");
        assert!(pngopt::identical_pixels(
            &fs::read(file).unwrap(),
            &before[1]
        ));
        let plain = export_pack(
            &f.pack,
            &f.project,
            &v("1.21.4"),
            &[],
            &opts(&f, ExportKind::Zip),
        )
        .unwrap();
        assert_eq!(plain[0].png_bytes_before, plain[0].png_bytes_after);
        assert_eq!(plain[0].png_bytes_before, out[0].png_bytes_before);
    }

    #[test]
    fn export_inside_the_pack_folder_does_not_include_itself() {
        let f = fixture();
        put(&f.pack, "block/oak_planks", png(32, 32, 1));
        let mut o = opts(&f, ExportKind::Zip);
        o.out_dir = f.pack.join("export");
        export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        let out = export_pack(&f.pack, &f.project, &v("1.21.4"), &[], &o).unwrap();
        assert_eq!(out[0].files, 3);
    }

    #[test]
    fn imports_a_downloaded_zip_even_with_a_wrapper_folder() {
        let f = fixture();
        let zip = f.root.join("Cool Pack.zip");
        write_jar(
            &zip,
            &[
                (
                    "Cool Pack/pack.mcmeta",
                    br#"{"pack":{"pack_format":46,"description":"cool"}}"#.to_vec(),
                ),
                ("Cool Pack/pack.png", png(64, 64, 1)),
                (
                    "Cool Pack/assets/minecraft/textures/block/stone.png",
                    png(32, 32, 2),
                ),
                ("../escape.png", png(16, 16, 3)),
            ],
        );
        let dest = f.root.join("Imported");
        assert_eq!(import_zip(&zip, &dest).unwrap(), 3);
        assert!(dest.join("pack.mcmeta").is_file());
        assert!(dest
            .join("assets/minecraft/textures/block/stone.png")
            .is_file());
        assert!(!f.root.join("escape.png").exists());
        let p = crate::pack::open_pack(&dest, &f.versions).unwrap();
        assert_eq!((p.description.as_str(), p.resolution), ("cool", 32));
        // refuses to unpack over existing files, and non-packs
        assert_eq!(import_zip(&zip, &dest).unwrap_err().kind, "not_empty");
        let not_pack = f.root.join("x.zip");
        write_jar(&not_pack, &[("readme.txt", b"hi".to_vec())]);
        assert_eq!(
            import_zip(&not_pack, &f.root.join("y")).unwrap_err().kind,
            "not_a_pack"
        );
        fs::write(f.root.join("bad.zip"), "nope").unwrap();
        assert_eq!(
            import_zip(&f.root.join("bad.zip"), &f.root.join("z"))
                .unwrap_err()
                .kind,
            "bad_zip"
        );
    }
}

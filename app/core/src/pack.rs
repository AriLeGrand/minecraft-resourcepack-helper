//! A resource pack on disk: creating, opening, scanning, texture status.
//!
//! The pack folder always contains a normal resource pack (flat PNG + JSON).
//! The app's own files live in the hidden `.packcreator/` folder, which is
//! never exported.

use crate::error::{CoreError, IoCtx, Result};
use crate::mcmeta;
use crate::minecraft::InstalledVersion;
use crate::pack_format::{self, PackFormat};
use crate::textures::{
    category_of, mcmeta_file, png_file_dimensions, Category, TextureEntry, VanillaIndex,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

pub const PROJECT_DIR: &str = ".packcreator";
pub const PROJECT_FILE: &str = "project.json";
pub const RESOLUTIONS: [u32; 5] = [16, 32, 64, 128, 256];

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub schema: u32,
    pub name: String,
    pub description: String,
    /// Folder name of the installed version used as the vanilla source.
    pub version_dir: String,
    /// Real game version (`1.21.4`).
    pub version_id: Option<String>,
    pub format: PackFormat,
    /// Block/item resolution: 16, 32, 64…
    pub resolution: u32,
    pub created_ms: u64,
    pub last_export_ms: Option<u64>,
    /// Other installed versions (folder names) to export a copy for.
    #[serde(default)]
    pub also_export: Vec<String>,
    /// The pack palette (`#rrggbb`, at most 64), shared by every texture.
    #[serde(default)]
    pub pack_palette: Vec<String>,
}

fn project_file(dir: &Path) -> PathBuf {
    dir.join(PROJECT_DIR).join(PROJECT_FILE)
}

/// Removes characters Windows does not allow in a folder or file name.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "pack".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// A simple generated icon (not a game asset): a soft pixel pattern whose
/// colours depend on the pack name, so two packs look different.
pub fn placeholder_icon(name: &str) -> Vec<u8> {
    let mut seed: u32 = 2166136261;
    for b in name.bytes() {
        seed = (seed ^ u32::from(b)).wrapping_mul(16777619);
    }
    let hue = (seed % 360) as f32;
    let hsv = |h: f32, s: f32, v: f32| -> [u8; 4] {
        let c = v * s;
        let hp = (h % 360.0) / 60.0;
        let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
        let (r, g, b) = match hp as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = v - c;
        [
            ((r + m) * 255.0) as u8,
            ((g + m) * 255.0) as u8,
            ((b + m) * 255.0) as u8,
            255,
        ]
    };
    let palette = [
        hsv(hue, 0.45, 0.55),
        hsv(hue + 12.0, 0.40, 0.68),
        hsv(hue - 10.0, 0.55, 0.38),
    ];
    let mut state = seed | 1;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    let cells: Vec<usize> = (0..256)
        .map(|_| match next() % 100 {
            0..=44 => 0,
            45..=79 => 1,
            _ => 2,
        })
        .collect();
    let mut img = image::RgbaImage::new(128, 128);
    for (x, y, p) in img.enumerate_pixels_mut() {
        *p = image::Rgba(palette[cells[((y / 8) * 16 + x / 8) as usize]]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .expect("PNG encoding to memory cannot fail");
    out
}

pub fn save_project(dir: &Path, project: &Project) -> Result<()> {
    let file = project_file(dir);
    let parent = file.parent().expect("project file has a parent");
    fs::create_dir_all(parent).ctx(parent)?;
    hide_on_windows(parent);
    // write to a temporary file first so a crash never leaves a broken project
    let tmp = file.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(project).expect("project serialises"),
    )
    .ctx(&tmp)?;
    fs::rename(&tmp, &file).ctx(&file)
}

#[cfg(windows)]
fn hide_on_windows(dir: &Path) {
    use std::os::windows::process::CommandExt;
    // best effort; the folder name already starts with a dot
    let _ = std::process::Command::new("attrib")
        .arg("+h")
        .arg(dir)
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(not(windows))]
fn hide_on_windows(_dir: &Path) {}

/// Writes `pack.mcmeta` from the project (description + format).
pub fn write_pack_mcmeta(dir: &Path, project: &Project) -> Result<()> {
    let file = dir.join("pack.mcmeta");
    fs::write(
        &file,
        pack_format::pack_mcmeta_text(&project.description, project.format, None),
    )
    .ctx(&file)
}

/// Creates a new pack: the folder, `pack.mcmeta`, a placeholder `pack.png`
/// and the project file. Refuses a folder that already contains files.
pub fn create_pack(
    dir: &Path,
    name: &str,
    description: &str,
    version: &InstalledVersion,
    resolution: u32,
) -> Result<Project> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::new("bad_name", "Give the pack a name."));
    }
    if !RESOLUTIONS.contains(&resolution) {
        return Err(CoreError::new(
            "bad_resolution",
            format!("{resolution}× is not a supported resolution."),
        ));
    }
    let Some(format) = version.format else {
        return Err(CoreError::new(
            "no_format",
            format!("The pack format of {} is unknown.", version.dir_name),
        )
        .hint("Start this version once from the Minecraft launcher, then try again."));
    };
    if dir.exists() {
        let not_empty = fs::read_dir(dir).ctx(dir)?.next().is_some();
        if not_empty {
            return Err(CoreError::new("not_empty", format!("{} already contains files.", dir.display()))
                .hint("Choose an empty or new folder, or use \"Open pack folder\" to continue an existing pack."));
        }
    }
    fs::create_dir_all(dir).ctx(dir)?;
    let project = Project {
        schema: 1,
        name: name.to_owned(),
        description: description.to_owned(),
        version_dir: version.dir_name.clone(),
        version_id: version.id.clone(),
        format,
        resolution,
        created_ms: now_ms(),
        last_export_ms: None,
        also_export: Vec::new(),
        pack_palette: Vec::new(),
    };
    write_pack_mcmeta(dir, &project)?;
    let icon = dir.join("pack.png");
    fs::write(&icon, placeholder_icon(name)).ctx(&icon)?;
    let tex = dir.join("assets").join("minecraft").join("textures");
    fs::create_dir_all(&tex).ctx(&tex)?;
    save_project(dir, &project)?;
    Ok(project)
}

/// Opens a pack folder. A pack made elsewhere (no `.packcreator`) is adopted:
/// its version is guessed from `pack.mcmeta` and the installed versions.
pub fn open_pack(dir: &Path, installed: &[InstalledVersion]) -> Result<Project> {
    if !dir.is_dir() {
        return Err(CoreError::new(
            "not_found",
            format!("{} is not a folder.", dir.display()),
        ));
    }
    let file = project_file(dir);
    if file.is_file() {
        let text = fs::read_to_string(&file).ctx(&file)?;
        return serde_json::from_str(&text).map_err(|e| {
            CoreError::new(
                "bad_project",
                format!("The pack's project file is damaged: {e}"),
            )
            .hint(format!(
                "Delete {} and open the folder again; your textures are not affected.",
                file.display()
            ))
        });
    }
    let mcmeta = dir.join("pack.mcmeta");
    if !mcmeta.is_file() {
        return Err(CoreError::new(
            "not_a_pack",
            format!("{} is not a resource pack (no pack.mcmeta).", dir.display()),
        )
        .hint("Pick the folder that contains pack.mcmeta, or create a new pack."));
    }
    let text = fs::read_to_string(&mcmeta).ctx(&mcmeta)?;
    let meta = pack_format::read_pack_mcmeta(&text).map_err(|e| {
        CoreError::new(
            "bad_pack_mcmeta",
            format!("pack.mcmeta could not be read: {e}"),
        )
    })?;
    let usable: Vec<&InstalledVersion> = installed.iter().filter(|v| v.usable()).collect();
    let chosen = meta
        .format
        .and_then(|f| {
            usable
                .iter()
                .find(|v| v.format.map(|x| x.major) == Some(f.major))
                .copied()
        })
        .or_else(|| usable.first().copied());
    let Some(version) = chosen else {
        return Err(CoreError::new(
            "no_versions",
            "No installed Minecraft version can be used for this pack.",
        )
        .hint("Start a Minecraft version once from the launcher, then open the pack again."));
    };
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pack".into());
    let project = Project {
        schema: 1,
        name,
        description: meta.description,
        version_dir: version.dir_name.clone(),
        version_id: version.id.clone(),
        format: meta.format.or(version.format).unwrap_or(PackFormat::new(1)),
        resolution: guess_resolution(dir),
        created_ms: now_ms(),
        last_export_ms: None,
        also_export: Vec::new(),
        pack_palette: Vec::new(),
    };
    save_project(dir, &project)?;
    Ok(project)
}

/// Most common block texture width in the pack (16 when there is none).
fn guess_resolution(dir: &Path) -> u32 {
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for t in scan_pack(dir) {
        if category_of(&t.path) == Category::Blocks && RESOLUTIONS.contains(&t.width) {
            *counts.entry(t.width).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|&(w, n)| (n, w))
        .map(|(w, _)| w)
        .unwrap_or(16)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackTexture {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub modified_ms: u64,
    pub has_mcmeta: bool,
    pub animated: bool,
    pub frames: u32,
    pub file_size: u64,
}

/// Every PNG under the pack's `assets/minecraft/textures`, sorted by path.
pub fn scan_pack(dir: &Path) -> Vec<PackTexture> {
    let tex_root = dir.join("assets").join("minecraft").join("textures");
    let mut out = Vec::new();
    for entry in WalkDir::new(&tex_root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !entry.file_type().is_file() || p.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let Some((width, height)) = png_file_dimensions(p) else {
            continue;
        };
        let rel = p.strip_prefix(&tex_root).unwrap_or(p).with_extension("");
        let path = rel
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let meta = mcmeta_file(p);
        let anim = fs::read_to_string(&meta)
            .ok()
            .and_then(|t| mcmeta::parse_animation(&t).ok().flatten());
        out.push(PackTexture {
            path,
            width,
            height,
            modified_ms: modified_ms(p),
            has_mcmeta: meta.is_file(),
            animated: anim.is_some(),
            frames: if anim.is_some() {
                mcmeta::frame_count(width, height, anim.as_ref())
            } else {
                1
            },
            file_size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Todo,
    Done,
    /// The file changed after the last export.
    Changed,
}

/// Done = the file exists in the pack; Changed = it is newer than the last export.
pub fn status_of(texture: Option<&PackTexture>, last_export_ms: Option<u64>) -> Status {
    match (texture, last_export_ms) {
        (None, _) => Status::Todo,
        (Some(t), Some(exported)) if t.modified_ms > exported => Status::Changed,
        (Some(_), _) => Status::Done,
    }
}

/// Size a pack texture should have: the vanilla size times the pack scale
/// for blocks and items; anything proportional for the other categories.
pub fn expected_size(vanilla: &TextureEntry, resolution: u32) -> Option<(u32, u32)> {
    vanilla.category.uses_pack_resolution().then(|| {
        // vanilla blocks are 16 px wide (a few are 32); scale relative to 16
        (
            vanilla.width * resolution / 16,
            vanilla.height * resolution / 16,
        )
    })
}

/// True when a pack texture does not match the pack resolution.
/// An animated strip may have a different number of frames than vanilla, so
/// only the width (and a whole number of frames) is checked for those.
pub fn is_wrong_size(vanilla: &TextureEntry, mine: &PackTexture, resolution: u32) -> bool {
    let Some((w, h)) = expected_size(vanilla, resolution) else {
        return false;
    };
    if vanilla.animated || mine.animated {
        return mine.width != w || !mine.height.is_multiple_of(mine.width.max(1));
    }
    (mine.width, mine.height) != (w, h)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackSummary {
    pub textures: usize,
    pub animated: usize,
    pub bytes: u64,
    /// Pack textures that also exist in vanilla (the "done" count).
    pub done: usize,
    pub total: usize,
}

pub fn summarize(pack: &[PackTexture], vanilla: Option<&VanillaIndex>) -> PackSummary {
    PackSummary {
        textures: pack.len(),
        animated: pack.iter().filter(|t| t.animated).count(),
        bytes: pack.iter().map(|t| t.file_size).sum(),
        done: match vanilla {
            Some(v) => pack.iter().filter(|t| v.get(&t.path).is_some()).count(),
            None => pack.len(),
        },
        total: vanilla.map(|v| v.entries.len()).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::{list_versions, testutil::*};
    use crate::textures::{png_dimensions, texture_file};

    pub(crate) fn versions(tmp: &Path) -> Vec<InstalledVersion> {
        list_versions(&fake_minecraft(tmp)).unwrap()
    }

    fn modern(vs: &[InstalledVersion]) -> &InstalledVersion {
        vs.iter().find(|v| v.dir_name == "1.21.4").unwrap()
    }

    #[test]
    fn creates_a_complete_pack() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        let dir = tmp.path().join("Packs").join("Deep Sea Pack");
        let p = create_pack(&dir, " Deep Sea Pack ", "§bOcean", modern(&vs), 32).unwrap();
        assert_eq!(
            (p.name.as_str(), p.resolution, p.format),
            ("Deep Sea Pack", 32, PackFormat::new(46))
        );
        let meta =
            pack_format::read_pack_mcmeta(&fs::read_to_string(dir.join("pack.mcmeta")).unwrap())
                .unwrap();
        assert_eq!(
            (meta.description.as_str(), meta.format),
            ("§bOcean", Some(PackFormat::new(46)))
        );
        assert_eq!(
            png_dimensions(&fs::read(dir.join("pack.png")).unwrap()),
            Some((128, 128))
        );
        assert!(dir.join("assets/minecraft/textures").is_dir());
        assert_eq!(open_pack(&dir, &vs).unwrap(), p);
    }

    #[test]
    fn older_project_files_without_a_pack_palette_still_open() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        let dir = tmp.path().join("p");
        let mut p = create_pack(&dir, "P", "", modern(&vs), 16).unwrap();
        // a project file written before the pack palette existed
        let file = project_file(&dir);
        let mut json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("pack_palette");
        fs::write(&file, json.to_string()).unwrap();
        let opened = open_pack(&dir, &vs).unwrap();
        assert!(opened.pack_palette.is_empty());
        // and the palette survives a save
        p.pack_palette = vec!["#102030".into()];
        save_project(&dir, &p).unwrap();
        assert_eq!(open_pack(&dir, &vs).unwrap().pack_palette, vec!["#102030"]);
    }

    #[test]
    fn refuses_bad_input_and_non_empty_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        let dir = tmp.path().join("p");
        assert_eq!(
            create_pack(&dir, "  ", "", modern(&vs), 16)
                .unwrap_err()
                .kind,
            "bad_name"
        );
        assert_eq!(
            create_pack(&dir, "x", "", modern(&vs), 48)
                .unwrap_err()
                .kind,
            "bad_resolution"
        );
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("my file.txt"), "important").unwrap();
        let e = create_pack(&dir, "x", "", modern(&vs), 16).unwrap_err();
        assert_eq!(e.kind, "not_empty");
        assert_eq!(
            fs::read_to_string(dir.join("my file.txt")).unwrap(),
            "important"
        );
        // an existing empty folder is fine
        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        create_pack(&empty, "x", "", modern(&vs), 16).unwrap();
    }

    #[test]
    fn adopts_a_pack_made_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        let dir = tmp.path().join("Downloaded");
        let f = texture_file(&dir, "blocks/stone").unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, png(32, 32, 1)).unwrap();
        fs::write(
            dir.join("pack.mcmeta"),
            r#"{"pack":{"pack_format":1,"description":"Old pack"}}"#,
        )
        .unwrap();
        let p = open_pack(&dir, &vs).unwrap();
        assert_eq!(
            (p.name.as_str(), p.description.as_str()),
            ("Downloaded", "Old pack")
        );
        assert_eq!((p.version_dir.as_str(), p.resolution), ("1.8.9", 32));
        assert!(project_file(&dir).is_file());
        // the user's files are untouched
        assert_eq!(fs::read(&f).unwrap(), png(32, 32, 1));
    }

    #[test]
    fn open_errors_are_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        assert_eq!(
            open_pack(&tmp.path().join("nope"), &vs).unwrap_err().kind,
            "not_found"
        );
        let dir = tmp.path().join("random");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(open_pack(&dir, &vs).unwrap_err().kind, "not_a_pack");
        fs::create_dir_all(dir.join(PROJECT_DIR)).unwrap();
        fs::write(project_file(&dir), "{ broken").unwrap();
        let e = open_pack(&dir, &vs).unwrap_err();
        assert_eq!(e.kind, "bad_project");
        assert!(e.hint.is_some());
    }

    #[test]
    fn scan_and_status() {
        let tmp = tempfile::tempdir().unwrap();
        let vs = versions(tmp.path());
        let dir = tmp.path().join("p");
        create_pack(&dir, "p", "", modern(&vs), 32).unwrap();
        assert!(scan_pack(&dir).is_empty());
        let f = texture_file(&dir, "block/prismarine").unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, png(32, 128, 1)).unwrap();
        fs::write(mcmeta_file(&f), r#"{"animation":{"frametime":2}}"#).unwrap();
        fs::write(texture_file(&dir, "block/stone").unwrap(), png(32, 32, 2)).unwrap();
        fs::write(f.with_file_name("notes.txt"), "not a texture").unwrap();
        let scan = scan_pack(&dir);
        assert_eq!(
            scan.iter().map(|t| t.path.as_str()).collect::<Vec<_>>(),
            ["block/prismarine", "block/stone"]
        );
        assert!(scan[0].animated && scan[0].has_mcmeta);
        assert_eq!(scan[0].frames, 4);
        assert!(!scan[1].animated);

        assert_eq!(status_of(None, None), Status::Todo);
        assert_eq!(status_of(Some(&scan[1]), None), Status::Done);
        assert_eq!(
            status_of(Some(&scan[1]), Some(scan[1].modified_ms + 1000)),
            Status::Done
        );
        assert_eq!(
            status_of(Some(&scan[1]), Some(scan[1].modified_ms - 1000)),
            Status::Changed
        );
        let s = summarize(&scan, None);
        assert_eq!((s.textures, s.animated), (2, 1));
    }

    #[test]
    fn wrong_size_rules() {
        let entry = |path: &str, w, h, animated| TextureEntry {
            path: path.into(),
            category: category_of(path),
            width: w,
            height: h,
            animated,
            frames: 1,
            frametime: 1,
            interpolate: false,
            has_mcmeta: animated,
            has_thumb: false,
            used_by: vec![],
            used_by_more: 0,
        };
        let mine = |w, h, animated| PackTexture {
            path: "x".into(),
            width: w,
            height: h,
            modified_ms: 0,
            has_mcmeta: animated,
            animated,
            frames: 1,
            file_size: 0,
        };
        let block = entry("block/stone", 16, 16, false);
        assert_eq!(expected_size(&block, 32), Some((32, 32)));
        assert!(!is_wrong_size(&block, &mine(32, 32, false), 32));
        assert!(is_wrong_size(&block, &mine(16, 16, false), 32));
        assert!(!is_wrong_size(&block, &mine(16, 16, false), 16));
        // animated: any whole number of frames at the right width is fine
        let anim = entry("block/prismarine", 16, 64, true);
        assert!(!is_wrong_size(&anim, &mine(32, 192, true), 32));
        assert!(is_wrong_size(&anim, &mine(16, 64, true), 32));
        assert!(is_wrong_size(&anim, &mine(32, 100, true), 32));
        // GUI and entities have their own scale: never flagged
        assert_eq!(
            expected_size(&entry("gui/widgets", 256, 256, false), 32),
            None
        );
        assert!(!is_wrong_size(
            &entry("entity/creeper/creeper", 64, 32, false),
            &mine(64, 32, false),
            32
        ));
    }

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("Deep Sea Pack"), "Deep Sea Pack");
        assert_eq!(safe_file_name("a/b:c*d?"), "a_b_c_d_");
        assert_eq!(safe_file_name("  dots... "), "dots");
        assert_eq!(safe_file_name("???"), "___");
        assert_eq!(safe_file_name(" . "), "pack");
    }

    #[test]
    fn placeholder_icons_differ_by_name() {
        let a = placeholder_icon("Deep Sea Pack");
        assert_eq!(a, placeholder_icon("Deep Sea Pack"));
        assert_ne!(a, placeholder_icon("Autumn Village"));
    }
}

//! The particle viewer's list, and the particle files a pack can change.
//!
//! From 1.14 each particle has `assets/minecraft/particles/<id>.json` with the
//! list of its frame images (`textures/particle/<name>.png`). A pack may
//! replace the images and, with its own JSON, the list. Before 1.14 every
//! particle sits on fixed cells of one shared sheet (see [`crate::particles`]).

use crate::error::{CoreError, IoCtx, Result};
use crate::particles::ParticleSheet;
use crate::textures::{is_safe_texture_path, png_file_dimensions, texture_file};
use crate::McVersion;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    /// 1.14 and newer: one image per frame and a JSON file per particle.
    Separate,
    /// 1.13.2 and older: one shared sheet.
    Sheet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PartStatus {
    Todo,
    Partly,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParticleInfo {
    pub id: String,
    /// Separate layout: texture paths of the frames in order (`particle/generic_7`).
    /// Sheet layout: the texture holding the cells (`particle/particles`), or
    /// the particle's own file (`entity/explosion`).
    pub textures: Vec<String>,
    /// Separate layout: which frames the pack has its own image for.
    pub in_pack: Vec<bool>,
    pub status: PartStatus,
    /// Size of the first frame (the pack's image when it has one), in pixels.
    pub size: Option<(u32, u32)>,
    /// The particle file comes from the pack (separate layout).
    pub json_from_pack: bool,
    /// Text of the particle file (the pack's, else the game's).
    pub json: Option<String>,
    /// Frames that name another namespace or an invalid name (left alone).
    pub skipped: Vec<String>,
    /// Sheet layout: `age`, `random`, `single` or `state`.
    pub mode: Option<String>,
    /// Sheet layout: cell indexes in play order (16×16 grid).
    pub cells: Vec<u16>,
    /// Sheet layout: other particles drawn from at least one of these cells.
    pub shared_with: Vec<String>,
    /// Sheet layout: frames of a particle with its own file form a grid of this many columns.
    pub grid: u32,
    /// Sheet layout: false for particles added in a later version (shown dimmed).
    pub in_version: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParticleList {
    pub layout: Layout,
    pub particles: Vec<ParticleInfo>,
    pub done: usize,
    pub total: usize,
    /// Sheet layout: texture path of the shared sheet and its grid.
    pub sheet: Option<String>,
    pub sheet_grid: u32,
}

const PARTICLES_DIR: &str = "assets/minecraft/particles";

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.'))
        && !id.starts_with('.')
}

/// `<root>/assets/minecraft/particles/<id>.json`.
pub fn particle_file(root: &Path, id: &str) -> Result<PathBuf> {
    if !safe_id(id) {
        return Err(CoreError::new(
            "bad_particle",
            format!("\"{id}\" is not a valid particle name."),
        ));
    }
    let mut p = root.to_path_buf();
    for seg in PARTICLES_DIR.split('/') {
        p.push(seg);
    }
    Ok(p.join(format!("{id}.json")))
}

/// `minecraft:generic_7` (or `generic_7`) -> `particle/generic_7`. `None` for
/// another namespace or a name that is not a safe texture name.
pub fn frame_texture(name: &str) -> Option<String> {
    let bare = match name.split_once(':') {
        Some(("minecraft", rest)) => rest,
        Some(_) => return None,
        None => name,
    };
    let path = format!("particle/{bare}");
    is_safe_texture_path(&path).then_some(path)
}

/// The frame names listed in a particle file, as written.
fn texture_names(json: &Value) -> Vec<String> {
    json.get("textures")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn read_json(file: &Path) -> Result<Option<(String, Value)>> {
    if !file.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(file).ctx(file)?;
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        CoreError::new(
            "bad_json",
            format!("{} is not valid JSON: {e}", file.display()),
        )
        .hint("Fix or delete that file in the pack, then try again.")
    })?;
    Ok(Some((text, value)))
}

/// The particle file that applies: the pack's, else the game's.
/// Returns `(text, value, from_pack)`.
fn effective_json(pack: &Path, vanilla: &Path, id: &str) -> Result<Option<(String, Value, bool)>> {
    if let Some((t, v)) = read_json(&particle_file(pack, id)?)? {
        return Ok(Some((t, v, true)));
    }
    Ok(read_json(&particle_file(vanilla, id)?)?.map(|(t, v)| (t, v, false)))
}

fn json_ids(root: &Path) -> BTreeSet<String> {
    let mut dir = root.to_path_buf();
    for seg in PARTICLES_DIR.split('/') {
        dir.push(seg);
    }
    let mut out = BTreeSet::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json") {
                if safe_id(id) && e.path().is_file() {
                    out.insert(id.to_owned());
                }
            }
        }
    }
    out
}

fn status_of(have: usize, of: usize) -> PartStatus {
    if of > 0 && have == of {
        PartStatus::Done
    } else if have > 0 {
        PartStatus::Partly
    } else {
        PartStatus::Todo
    }
}

fn size_of(pack: &Path, vanilla: &Path, tex: &str) -> Option<(u32, u32)> {
    [pack, vanilla].iter().find_map(|root| {
        texture_file(root, tex)
            .ok()
            .and_then(|f| png_file_dimensions(&f))
    })
}

fn separate_info(pack: &Path, vanilla: &Path, id: &str) -> Result<Option<ParticleInfo>> {
    let Some((text, value, from_pack)) = effective_json(pack, vanilla, id)? else {
        return Ok(None);
    };
    let mut textures = Vec::new();
    let mut skipped = Vec::new();
    for n in texture_names(&value) {
        match frame_texture(&n) {
            Some(t) => textures.push(t),
            None => skipped.push(n),
        }
    }
    let in_pack: Vec<bool> = textures
        .iter()
        .map(|t| texture_file(pack, t).is_ok_and(|f| f.is_file()))
        .collect();
    let have = in_pack.iter().filter(|b| **b).count();
    Ok(Some(ParticleInfo {
        id: id.to_owned(),
        size: textures.first().and_then(|t| size_of(pack, vanilla, t)),
        status: status_of(have, textures.len()),
        textures,
        in_pack,
        json_from_pack: from_pack,
        json: Some(text),
        skipped,
        mode: None,
        cells: Vec::new(),
        shared_with: Vec::new(),
        grid: 1,
        in_version: true,
    }))
}

fn sheet_list(pack: &Path, vanilla: &Path, version: &McVersion) -> ParticleList {
    let s = ParticleSheet::builtin();
    let present: Vec<&str> = s
        .particles_in(version)
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    let sheet_tex = s.file.clone();
    let has = |tex: &str| texture_file(pack, tex).is_ok_and(|f| f.is_file());
    let sheet_done = has(&sheet_tex);
    let mut particles = Vec::new();
    for p in &s.particles {
        let in_version = present.contains(&p.id.as_str());
        particles.push(ParticleInfo {
            id: p.id.clone(),
            textures: vec![sheet_tex.clone()],
            in_pack: vec![sheet_done],
            status: if sheet_done {
                PartStatus::Done
            } else {
                PartStatus::Todo
            },
            size: size_of(pack, vanilla, &sheet_tex),
            json_from_pack: false,
            json: None,
            skipped: Vec::new(),
            mode: Some(p.mode.clone()),
            cells: s.cells_of(p),
            shared_with: s.shared_with(p).iter().map(|o| o.id.clone()).collect(),
            grid: s.grid,
            in_version,
        });
    }
    for f in &s.other_files {
        let in_version = f
            .until
            .as_deref()
            .and_then(McVersion::parse)
            .is_none_or(|u| *version <= u);
        let done = has(&f.file);
        particles.push(ParticleInfo {
            id: f.id.clone(),
            textures: vec![f.file.clone()],
            in_pack: vec![done],
            status: if done {
                PartStatus::Done
            } else {
                PartStatus::Todo
            },
            size: size_of(pack, vanilla, &f.file),
            json_from_pack: false,
            json: None,
            skipped: Vec::new(),
            mode: Some(f.mode.clone()),
            cells: Vec::new(),
            shared_with: Vec::new(),
            grid: f.grid,
            in_version,
        });
    }
    particles.sort_by(|a, b| a.id.cmp(&b.id));
    let counted = particles.iter().filter(|p| p.in_version);
    let total = counted.clone().count();
    let done = counted.filter(|p| p.status == PartStatus::Done).count();
    ParticleList {
        layout: Layout::Sheet,
        particles,
        done,
        total,
        sheet: Some(sheet_tex),
        sheet_grid: s.grid,
    }
}

/// Every particle of the pack's version. `version` = `None` (unknown) is
/// treated as a modern version.
pub fn list(pack: &Path, vanilla: &Path, version: Option<&McVersion>) -> Result<ParticleList> {
    if let Some(v) = version {
        if ParticleSheet::builtin().applies_to(v) {
            return Ok(sheet_list(pack, vanilla, v));
        }
    }
    let mut ids = json_ids(vanilla);
    ids.extend(json_ids(pack));
    let mut particles = Vec::new();
    for id in &ids {
        if let Some(p) = separate_info(pack, vanilla, id)? {
            particles.push(p);
        }
    }
    let total = particles.len();
    let done = particles
        .iter()
        .filter(|p| p.status == PartStatus::Done)
        .count();
    Ok(ParticleList {
        layout: Layout::Separate,
        particles,
        done,
        total,
        sheet: None,
        sheet_grid: 0,
    })
}

/// Writes the pack's `particles/<id>.json` with this frame list (texture
/// paths `particle/<name>`), keeping every other key of the file that applies
/// now. Nothing is written when the list is the same as now. Returns whether
/// the file was written.
pub fn write_frames(pack: &Path, vanilla: &Path, id: &str, frames: &[String]) -> Result<bool> {
    let current = effective_json(pack, vanilla, id)?;
    let mut value = match &current {
        Some((_, v, _)) => v.clone(),
        None => Value::Object(Default::default()),
    };
    let names: Vec<String> = frames
        .iter()
        .map(|f| {
            f.strip_prefix("particle/")
                .filter(|n| frame_texture(n).as_deref() == Some(f.as_str()))
                .map(|n| format!("minecraft:{n}"))
                .ok_or_else(|| {
                    CoreError::new(
                        "bad_path",
                        format!("\"{f}\" is not a particle texture (textures/particle/…)."),
                    )
                })
        })
        .collect::<Result<_>>()?;
    let now: Vec<Option<String>> = texture_names(&value)
        .iter()
        .map(|n| frame_texture(n))
        .collect();
    let wanted: Vec<Option<String>> = frames.iter().cloned().map(Some).collect();
    if current.is_some() && now == wanted {
        return Ok(false);
    }
    let Value::Object(map) = &mut value else {
        return Err(CoreError::new(
            "bad_json",
            format!("The particle file of {id} is not a JSON object."),
        ));
    };
    map.insert(
        "textures".into(),
        Value::Array(names.into_iter().map(Value::String).collect()),
    );
    let file = particle_file(pack, id)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let mut text = serde_json::to_string_pretty(&value)
        .map_err(|e| CoreError::new("bad_json", e.to_string()))?;
    text.push('\n');
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, &text).ctx(&tmp)?;
    fs::rename(&tmp, &file).ctx(&file)?;
    Ok(true)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AddedFrame {
    /// Texture path of the new image (`particle/heart_1`).
    pub texture: String,
    /// The pack's particle file after the change.
    pub json: String,
}

/// A name for the frame after `last` that neither the pack nor the game uses:
/// `generic_7` -> `generic_8`, `heart` -> `heart_1`.
fn next_frame_name(pack: &Path, vanilla: &Path, last: &str) -> Result<String> {
    let name = last.rsplit('/').next().unwrap_or(last);
    let (base, start) = match name.rsplit_once('_') {
        Some((b, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => {
            (b.to_owned(), n.parse::<u32>().unwrap_or(0) + 1)
        }
        _ => (name.to_owned(), 1),
    };
    for n in start..start + 10_000 {
        let tex = format!("particle/{base}_{n}");
        let taken = [pack, vanilla]
            .iter()
            .any(|r| texture_file(r, &tex).is_ok_and(|f| f.exists()));
        if !taken {
            return Ok(tex);
        }
    }
    Err(CoreError::new(
        "no_name",
        format!("No free name was found for a new frame of {name}."),
    ))
}

/// "Add frame": a copy of the last frame (the pack's image, else the game's)
/// becomes a new image in the pack, appended to the pack's particle file.
pub fn add_frame(pack: &Path, vanilla: &Path, id: &str) -> Result<AddedFrame> {
    let Some((_, value, _)) = effective_json(pack, vanilla, id)? else {
        return Err(CoreError::new(
            "not_found",
            format!("There is no particle called {id} in the pack or in the game."),
        ));
    };
    let mut frames: Vec<String> = Vec::new();
    for n in texture_names(&value) {
        frames.push(frame_texture(&n).ok_or_else(|| {
            CoreError::new(
                "bad_particle",
                format!("The particle file of {id} names \"{n}\", which this app cannot change."),
            )
            .hint("Edit that particle file by hand.")
        })?);
    }
    let Some(last) = frames.last().cloned() else {
        return Err(CoreError::new(
            "no_frames",
            format!("The particle {id} has no images to copy."),
        )
        .hint("Particles without images (such as block or item particles) take their look from other textures."));
    };
    let src = [pack, vanilla]
        .iter()
        .filter_map(|r| texture_file(r, &last).ok())
        .find(|f| f.is_file())
        .ok_or_else(|| {
            CoreError::new(
                "not_found",
                format!("The image {last}.png is in neither the pack nor the game."),
            )
        })?;
    let texture = next_frame_name(pack, vanilla, &last)?;
    let dest = texture_file(pack, &texture)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    fs::copy(&src, &dest).ctx(&dest)?;
    frames.push(texture.clone());
    if let Err(e) = write_frames(pack, vanilla, id, &frames) {
        // the list could not be written: do not leave a stray image behind
        let _ = fs::remove_file(&dest);
        return Err(e);
    }
    let json = fs::read_to_string(particle_file(pack, id)?).unwrap_or_default();
    Ok(AddedFrame { texture, json })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let f = root.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, bytes).unwrap();
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("vanilla"), tmp.path().join("pack"));
        let p = "assets/minecraft/particles";
        let t = "assets/minecraft/textures/particle";
        put(
            &vanilla,
            &format!("{p}/smoke.json"),
            br#"{"textures":["minecraft:generic_2","minecraft:generic_1","minecraft:generic_0"]}"#,
        );
        put(
            &vanilla,
            &format!("{p}/heart.json"),
            br#"{"textures":["minecraft:heart"]}"#,
        );
        put(&vanilla, &format!("{p}/block.json"), br#"{}"#);
        for n in ["generic_0", "generic_1", "generic_2", "heart"] {
            put(&vanilla, &format!("{t}/{n}.png"), &png(8, 8, 1));
        }
        fs::create_dir_all(&pack).unwrap();
        (tmp, vanilla, pack)
    }

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    fn find<'a>(l: &'a ParticleList, id: &str) -> &'a ParticleInfo {
        l.particles.iter().find(|p| p.id == id).unwrap()
    }

    #[test]
    fn frame_names_become_texture_paths() {
        assert_eq!(
            frame_texture("minecraft:generic_7").as_deref(),
            Some("particle/generic_7")
        );
        assert_eq!(frame_texture("heart").as_deref(), Some("particle/heart"));
        assert_eq!(frame_texture("mymod:spark"), None);
        assert_eq!(frame_texture("minecraft:../x"), None);
    }

    #[test]
    fn modern_list_and_status() {
        let (_t, vanilla, pack) = setup();
        let l = list(&pack, &vanilla, Some(&v("1.21.11"))).unwrap();
        assert_eq!(l.layout, Layout::Separate);
        assert_eq!(
            l.particles
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["block", "heart", "smoke"]
        );
        let smoke = find(&l, "smoke");
        assert_eq!(
            smoke.textures,
            [
                "particle/generic_2",
                "particle/generic_1",
                "particle/generic_0"
            ]
        );
        assert_eq!(smoke.status, PartStatus::Todo);
        assert_eq!(smoke.size, Some((8, 8)));
        assert!(!smoke.json_from_pack);
        assert!(find(&l, "block").textures.is_empty());
        assert_eq!((l.done, l.total), (0, 3));

        // one frame in the pack: partly; all of them: done
        put(
            &pack,
            "assets/minecraft/textures/particle/generic_1.png",
            &png(16, 16, 2),
        );
        let l = list(&pack, &vanilla, None).unwrap();
        let smoke = find(&l, "smoke");
        assert_eq!(smoke.status, PartStatus::Partly);
        assert_eq!(smoke.in_pack, [false, true, false]);
        put(
            &pack,
            "assets/minecraft/textures/particle/heart.png",
            &png(16, 16, 2),
        );
        let l = list(&pack, &vanilla, None).unwrap();
        assert_eq!(find(&l, "heart").status, PartStatus::Done);
        assert_eq!(
            find(&l, "heart").size,
            Some((16, 16)),
            "the pack's image wins"
        );
        assert_eq!(l.done, 1);
    }

    #[test]
    fn the_packs_particle_file_wins_and_may_add_particles() {
        let (_t, vanilla, pack) = setup();
        put(
            &pack,
            "assets/minecraft/particles/heart.json",
            br#"{"textures":["minecraft:heart","minecraft:heart_1","othermod:x"]}"#,
        );
        put(
            &pack,
            "assets/minecraft/particles/sparkle.json",
            br#"{"textures":["sparkle"]}"#,
        );
        let l = list(&pack, &vanilla, None).unwrap();
        let heart = find(&l, "heart");
        assert!(heart.json_from_pack);
        assert_eq!(heart.textures, ["particle/heart", "particle/heart_1"]);
        assert_eq!(heart.skipped, ["othermod:x"]);
        assert!(heart.json.as_deref().unwrap().contains("heart_1"));
        assert!(l.particles.iter().any(|p| p.id == "sparkle"));
    }

    #[test]
    fn a_broken_particle_file_is_a_clear_error() {
        let (_t, vanilla, pack) = setup();
        put(&pack, "assets/minecraft/particles/heart.json", b"{ nope");
        let e = list(&pack, &vanilla, None).unwrap_err();
        assert_eq!(e.kind, "bad_json");
    }

    #[test]
    fn legacy_versions_list_the_sheet() {
        let (_t, vanilla, pack) = setup();
        let l = list(&pack, &vanilla, Some(&v("1.8.9"))).unwrap();
        assert_eq!(l.layout, Layout::Sheet);
        assert_eq!(l.sheet.as_deref(), Some("particle/particles"));
        let smoke = find(&l, "smoke");
        assert_eq!(smoke.cells, [7, 6, 5, 4, 3, 2, 1, 0]);
        assert!(smoke.shared_with.contains(&"portal".to_owned()));
        assert_eq!(smoke.mode.as_deref(), Some("age"));
        let heart = find(&l, "heart");
        assert_eq!(heart.cells, [80]);
        assert!(heart.shared_with.is_empty());
        let ex = find(&l, "explosion");
        assert_eq!((ex.textures[0].as_str(), ex.grid), ("entity/explosion", 4));
        assert!(find(&l, "footstep").in_version);
        // added in 1.9: listed, but not in 1.8.9
        assert!(!find(&l, "end_rod").in_version);
        assert_eq!(l.done, 0);
        assert!(l.total < l.particles.len());

        put(
            &pack,
            "assets/minecraft/textures/particle/particles.png",
            &png(128, 128, 1),
        );
        let l = list(&pack, &vanilla, Some(&v("1.12.2"))).unwrap();
        assert_eq!(find(&l, "heart").status, PartStatus::Done);
        assert!(find(&l, "end_rod").in_version);
        assert!(!find(&l, "explosion").in_pack[0]);
        // footprints went away in 1.13
        let l13 = list(&pack, &vanilla, Some(&v("1.13.2"))).unwrap();
        assert!(!find(&l13, "footstep").in_version);
    }

    #[test]
    fn writing_frames_keeps_other_keys_and_skips_no_change() {
        let (_t, vanilla, pack) = setup();
        let same = vec!["particle/heart".to_owned()];
        assert!(!write_frames(&pack, &vanilla, "heart", &same).unwrap());
        assert!(
            !particle_file(&pack, "heart").unwrap().exists(),
            "no change, no file"
        );

        put(
            &pack,
            "assets/minecraft/particles/smoke.json",
            br#"{"note":"mine","textures":["minecraft:generic_2"]}"#,
        );
        let two = vec![
            "particle/generic_2".to_owned(),
            "particle/generic_0".to_owned(),
        ];
        assert!(write_frames(&pack, &vanilla, "smoke", &two).unwrap());
        let text = fs::read_to_string(particle_file(&pack, "smoke").unwrap()).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["note"], "mine");
        assert_eq!(
            v["textures"],
            serde_json::json!(["minecraft:generic_2", "minecraft:generic_0"])
        );
        assert!(
            text.find("note").unwrap() < text.find("textures").unwrap(),
            "key order kept"
        );
        assert!(!write_frames(&pack, &vanilla, "smoke", &two).unwrap());

        let bad = vec!["block/stone".to_owned()];
        assert_eq!(
            write_frames(&pack, &vanilla, "smoke", &bad)
                .unwrap_err()
                .kind,
            "bad_path"
        );
        assert_eq!(
            write_frames(&pack, &vanilla, "../x", &two)
                .unwrap_err()
                .kind,
            "bad_particle"
        );
    }

    #[test]
    fn add_frame_copies_the_last_frame() {
        let (_t, vanilla, pack) = setup();
        let a = add_frame(&pack, &vanilla, "heart").unwrap();
        assert_eq!(a.texture, "particle/heart_1");
        let new_png = texture_file(&pack, "particle/heart_1").unwrap();
        assert_eq!(
            fs::read(&new_png).unwrap(),
            png(8, 8, 1),
            "a copy of the game's image"
        );
        assert!(a.json.contains("minecraft:heart_1"));
        let l = list(&pack, &vanilla, None).unwrap();
        let heart = find(&l, "heart");
        assert_eq!(heart.textures, ["particle/heart", "particle/heart_1"]);
        assert_eq!(heart.in_pack, [false, true]);
        assert_eq!(heart.status, PartStatus::Partly);

        // the pack's own last frame is the one copied, and numbers continue
        put(
            &pack,
            "assets/minecraft/textures/particle/generic_0.png",
            &png(16, 16, 9),
        );
        let a = add_frame(&pack, &vanilla, "smoke").unwrap();
        // generic_1 and generic_2 exist in the game: the next free number is 3
        assert_eq!(a.texture, "particle/generic_3");
        assert_eq!(
            fs::read(texture_file(&pack, "particle/generic_3").unwrap()).unwrap(),
            png(16, 16, 9)
        );
        let a2 = add_frame(&pack, &vanilla, "smoke").unwrap();
        assert_eq!(a2.texture, "particle/generic_4");

        assert_eq!(
            add_frame(&pack, &vanilla, "block").unwrap_err().kind,
            "no_frames"
        );
        assert_eq!(
            add_frame(&pack, &vanilla, "nothing").unwrap_err().kind,
            "not_found"
        );
    }
}

//! Earlier versions of a texture, so a replaced file can always be found and
//! brought back.
//!
//! Two places hold them:
//! * `.packcreator/history/<texture>/<time>.png`: written by the editor's
//!   save (the PNG it replaces) and by [`restore`] (the current file, so a
//!   restore can be undone). The file keeps the time the version was made.
//! * `.packcreator/trash/<time>/assets/minecraft/textures/<texture>.png`:
//!   where import, batch import, revert and the other tools move a file they
//!   replace ([`crate::import::move_to_trash`]). Only read here, never pruned.
//!
//! The history folder of one texture is capped at [`MAX_VERSIONS`] files and
//! [`MAX_BYTES`] bytes; the oldest go first, the newest is always kept.

use crate::error::{CoreError, IoCtx, Result};
use crate::pack::{modified_ms, now_ms, PROJECT_DIR};
use crate::textures::{is_safe_texture_path, png_dimensions, texture_file};
use crate::workfile::{optifine_png, ICON_PATH, OPTIFINE_PREFIX};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

pub const MAX_VERSIONS: usize = 50;
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionKind {
    History,
    Trash,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Version {
    /// `h-<name>` (history folder) or `t-<trash folder>`.
    pub id: String,
    pub kind: VersionKind,
    /// When this version was replaced (moved away).
    pub replaced_ms: u64,
    /// When this version itself was last changed (its file time).
    pub made_ms: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Restored {
    /// Where the file that was current went (`None`: there was none, or it
    /// was already identical).
    pub kept: Option<String>,
}

fn bad_path(tex: &str) -> CoreError {
    CoreError::new(
        "bad_path",
        format!("\"{tex}\" is not a valid texture name."),
    )
}

/// The texture's file in the pack (`pack.png` for the pack icon).
fn current_file(pack_dir: &Path, tex: &str) -> Result<PathBuf> {
    if tex == ICON_PATH {
        return Ok(pack_dir.join("pack.png"));
    }
    if let Some(rest) = tex.strip_prefix(OPTIFINE_PREFIX) {
        return optifine_png(pack_dir, rest);
    }
    texture_file(pack_dir, tex)
}

/// `.packcreator/history/<texture>/` (the pack icon: `.packcreator/history-icon/`).
pub fn history_dir(pack_dir: &Path, tex: &str) -> Result<PathBuf> {
    let root = pack_dir.join(PROJECT_DIR);
    if tex == ICON_PATH {
        return Ok(root.join("history-icon"));
    }
    // connected-texture tiles (`:optifine/ctm/glass/0`) have their own folder
    let (root, tex) = match tex.strip_prefix(OPTIFINE_PREFIX) {
        Some(rest) => (root.join("history-optifine"), rest),
        None => (root.join("history"), tex),
    };
    if !is_safe_texture_path(tex) {
        return Err(bad_path(tex));
    }
    let mut p = root;
    for seg in tex.split('/') {
        p.push(seg);
    }
    Ok(p)
}

/// A version id part: letters, digits, `-` and `_` only (no dots, no slashes).
fn safe_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The leading number of `1712345678901-2`.
fn stamp_of(name: &str) -> Option<u64> {
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn set_time(file: &Path, ms: u64) {
    if ms == 0 {
        return;
    }
    if let Ok(f) = fs::File::options().write(true).open(file) {
        let _ = f.set_modified(UNIX_EPOCH + Duration::from_millis(ms));
    }
}

/// A new file name in `dir` for a version replaced at `stamp`.
fn new_file(dir: &Path, stamp: u64) -> PathBuf {
    let first = dir.join(format!("{stamp}.png"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|i| dir.join(format!("{stamp}-{i}.png")))
        .find(|p| !p.exists())
        .expect("a free name")
}

/// Keeps `bytes` (a version that is about to be replaced) in the texture's
/// history folder, with `made_ms` as its file time. Does not prune.
pub fn record(pack_dir: &Path, tex: &str, bytes: &[u8], made_ms: u64) -> Result<PathBuf> {
    let dir = history_dir(pack_dir, tex)?;
    fs::create_dir_all(&dir).ctx(&dir)?;
    let file = new_file(&dir, now_ms());
    fs::write(&file, bytes).ctx(&file)?;
    set_time(&file, made_ms);
    Ok(file)
}

/// Removes the oldest files of the texture's history folder above the caps.
/// Returns how many were removed.
pub fn prune(pack_dir: &Path, tex: &str) -> Result<usize> {
    prune_to(pack_dir, tex, MAX_VERSIONS, MAX_BYTES)
}

fn prune_to(pack_dir: &Path, tex: &str, max_n: usize, max_bytes: u64) -> Result<usize> {
    let dir = history_dir(pack_dir, tex)?;
    let mut files: Vec<(u64, String, PathBuf, u64)> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let stem = name.strip_suffix(".png")?.to_owned();
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                Some((stamp_of(&stem).unwrap_or(0), stem, e.path(), len))
            })
            .collect(),
        Err(_) => return Ok(0),
    };
    // newest first
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut total = 0;
    let mut removed = 0;
    for (i, (_, _, path, len)) in files.iter().enumerate() {
        total += len;
        if i > 0 && (i >= max_n || total > max_bytes) && fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn version_of(id: String, kind: VersionKind, file: &Path, replaced_ms: u64) -> Option<Version> {
    let meta = fs::metadata(file).ok().filter(|m| m.is_file())?;
    let (width, height) = crate::textures::png_file_dimensions(file).unwrap_or((0, 0));
    Some(Version {
        id,
        kind,
        replaced_ms,
        made_ms: modified_ms(file),
        width,
        height,
        bytes: meta.len(),
    })
}

/// Every earlier version of the texture found in the pack, newest first.
pub fn list(pack_dir: &Path, tex: &str) -> Result<Vec<Version>> {
    let mut out = Vec::new();
    let dir = history_dir(pack_dir, tex)?;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".png") else {
                continue;
            };
            if !safe_part(stem) {
                continue;
            }
            let path = e.path();
            let replaced = stamp_of(stem).unwrap_or_else(|| modified_ms(&path));
            if let Some(v) = version_of(format!("h-{stem}"), VersionKind::History, &path, replaced)
            {
                out.push(v);
            }
        }
    }
    let trash = pack_dir.join(PROJECT_DIR).join("trash");
    if let Ok(rd) = fs::read_dir(&trash) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if !safe_part(&name) || !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(file) = current_file(&e.path(), tex) else {
                continue;
            };
            let replaced = stamp_of(&name).unwrap_or_else(|| modified_ms(&e.path()));
            if let Some(v) = version_of(format!("t-{name}"), VersionKind::Trash, &file, replaced) {
                out.push(v);
            }
        }
    }
    out.sort_by(|a, b| {
        b.replaced_ms
            .cmp(&a.replaced_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(out)
}

/// The file of one version. Only a file inside the texture's own history
/// folder or the texture's place inside one trash folder can come out.
pub fn version_file(pack_dir: &Path, tex: &str, id: &str) -> Result<PathBuf> {
    let unknown = || {
        CoreError::new(
            "not_found",
            "That earlier version is no longer in the pack.",
        )
        .hint("The list of versions was refreshed; pick another one.")
    };
    let file = if let Some(stem) = id.strip_prefix("h-") {
        if !safe_part(stem) {
            return Err(unknown());
        }
        history_dir(pack_dir, tex)?.join(format!("{stem}.png"))
    } else if let Some(dir) = id.strip_prefix("t-") {
        if !safe_part(dir) {
            return Err(unknown());
        }
        current_file(&pack_dir.join(PROJECT_DIR).join("trash").join(dir), tex)?
    } else {
        return Err(unknown());
    };
    if file.is_file() {
        Ok(file)
    } else {
        Err(unknown())
    }
}

/// Puts an earlier version back as the texture's file. The file that was
/// current goes to the history folder first, so this can be undone; the
/// earlier version itself stays where it was. Only the PNG is restored
/// (the `.mcmeta` and the editor's layers are left as they are).
pub fn restore(pack_dir: &Path, tex: &str, id: &str) -> Result<Restored> {
    let src = version_file(pack_dir, tex, id)?;
    let bytes = fs::read(&src).ctx(&src)?;
    if png_dimensions(&bytes).is_none() {
        return Err(CoreError::new(
            "bad_image",
            format!("{} is not a PNG image.", src.display()),
        ));
    }
    let dest = current_file(pack_dir, tex)?;
    if fs::read(&dest).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(Restored { kept: None });
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let mut tmp_name = dest.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".restore.tmp");
    let tmp = dest.with_file_name(tmp_name);
    fs::write(&tmp, &bytes).ctx(&tmp)?;
    let kept = if dest.exists() {
        let dir = history_dir(pack_dir, tex)?;
        let moved = fs::create_dir_all(&dir)
            .and_then(|_| {
                let k = new_file(&dir, now_ms());
                fs::rename(&dest, &k).map(|_| k)
            })
            .map_err(|e| {
                let _ = fs::remove_file(&tmp);
                CoreError::io(&dest, &e)
            })?;
        Some(moved)
    } else {
        None
    };
    if let Err(e) = fs::rename(&tmp, &dest) {
        if let Some(k) = &kept {
            let _ = fs::rename(k, &dest);
        }
        let _ = fs::remove_file(&tmp);
        return Err(CoreError::io(&dest, &e));
    }
    let _ = prune(pack_dir, tex);
    Ok(Restored {
        kept: kept.map(|k| k.to_string_lossy().into_owned()),
    })
}

/// A texture was renamed: its history folder follows (files whose name is
/// already taken under the new name stay where they are).
pub fn rename(pack_dir: &Path, from: &str, to: &str) -> Result<usize> {
    let (a, b) = (history_dir(pack_dir, from)?, history_dir(pack_dir, to)?);
    let Ok(rd) = fs::read_dir(&a) else {
        return Ok(0);
    };
    let mut n = 0;
    for e in rd.filter_map(|e| e.ok()) {
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let target = b.join(e.file_name());
        if target.exists() {
            continue;
        }
        fs::create_dir_all(&b).ctx(&b)?;
        fs::rename(e.path(), &target).ctx(&target)?;
        n += 1;
    }
    let _ = fs::remove_dir(&a);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::{import_image, move_to_trash, revert};
    use crate::minecraft::testutil::png;

    fn put(pack: &Path, tex: &str, bytes: &[u8]) -> PathBuf {
        let f = texture_file(pack, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, bytes).unwrap();
        f
    }

    #[test]
    fn finds_versions_in_history_and_trash_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let f = put(pack, "block/stone", &png(16, 16, 1));
        move_to_trash(pack, &f, 1_000).unwrap();
        put(pack, "block/stone", &png(16, 16, 2));
        // another texture in the same trash folder is not listed
        let other = put(pack, "block/dirt", &png(16, 16, 9));
        move_to_trash(pack, &other, 1_000).unwrap();
        let h = record(pack, "block/stone", &png(32, 32, 3), 500).unwrap();
        let v = list(pack, "block/stone").unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].kind, VersionKind::History);
        assert_eq!((v[0].width, v[0].height), (32, 32));
        assert_eq!(v[0].made_ms, 500);
        assert_eq!(v[1].id, "t-1000");
        assert_eq!(v[1].replaced_ms, 1_000);
        assert_eq!(version_file(pack, "block/stone", &v[0].id).unwrap(), h);
        assert!(list(pack, "block/none").unwrap().is_empty());
    }

    #[test]
    fn import_and_revert_versions_show_up() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let (a, b) = (tmp.path().join("a.png"), tmp.path().join("b.png"));
        fs::write(&a, png(16, 16, 1)).unwrap();
        fs::write(&b, png(16, 16, 2)).unwrap();
        import_image(&pack, "item/apple", &a, None).unwrap();
        std::thread::sleep(Duration::from_millis(3));
        import_image(&pack, "item/apple", &b, None).unwrap();
        std::thread::sleep(Duration::from_millis(3));
        revert(&pack, "item/apple").unwrap();
        let v = list(&pack, "item/apple").unwrap();
        assert_eq!(v.len(), 2);
        let newest = fs::read(version_file(&pack, "item/apple", &v[0].id).unwrap()).unwrap();
        assert_eq!(newest, png(16, 16, 2));
    }

    #[test]
    fn version_ids_cannot_leave_the_texture() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        put(pack, "block/stone", &png(16, 16, 1));
        record(pack, "block/dirt", &png(16, 16, 1), 0).unwrap();
        for id in [
            "h-../dirt/1",
            "h-..",
            "t-..",
            "t-../../assets",
            "x-1",
            "",
            "h-",
            "h-1.png",
            "t-1/../2",
        ] {
            assert!(version_file(pack, "block/stone", id).is_err(), "{id}");
        }
        assert!(list(pack, "../x").is_err());
        assert!(history_dir(pack, "a/../b").is_err());
    }

    #[test]
    fn restore_keeps_the_current_file_so_it_can_be_undone() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let f = put(pack, "block/stone", &png(16, 16, 1));
        record(pack, "block/stone", &png(16, 16, 7), 0).unwrap();
        let v = list(pack, "block/stone").unwrap();
        let r = restore(pack, "block/stone", &v[0].id).unwrap();
        assert_eq!(fs::read(&f).unwrap(), png(16, 16, 7));
        let kept = PathBuf::from(r.kept.unwrap());
        assert_eq!(fs::read(&kept).unwrap(), png(16, 16, 1));
        // the restored version is still in the list, and so is the one replaced
        let v2 = list(pack, "block/stone").unwrap();
        assert_eq!(v2.len(), 2);
        // undo: restore the one that was current
        let back = v2
            .iter()
            .find(|x| version_file(pack, "block/stone", &x.id).unwrap() == kept)
            .unwrap();
        restore(pack, "block/stone", &back.id).unwrap();
        assert_eq!(fs::read(&f).unwrap(), png(16, 16, 1));
        // restoring what is already there changes nothing
        let v3 = list(pack, "block/stone").unwrap();
        let same = v3
            .iter()
            .find(|x| {
                fs::read(version_file(pack, "block/stone", &x.id).unwrap()).unwrap()
                    == png(16, 16, 1)
            })
            .unwrap();
        assert_eq!(restore(pack, "block/stone", &same.id).unwrap().kept, None);
        assert_eq!(list(pack, "block/stone").unwrap().len(), v3.len());
        // no temporary file is left
        assert!(!f.with_file_name("stone.png.restore.tmp").exists());
    }

    #[test]
    fn restore_works_when_the_texture_was_reverted() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let f = put(pack, "item/apple", &png(16, 16, 3));
        revert(pack, "item/apple").unwrap();
        assert!(!f.exists());
        let v = list(pack, "item/apple").unwrap();
        assert_eq!(restore(pack, "item/apple", &v[0].id).unwrap().kept, None);
        assert_eq!(fs::read(&f).unwrap(), png(16, 16, 3));
        // the trash copy is still there
        assert_eq!(list(pack, "item/apple").unwrap().len(), 1);
    }

    #[test]
    fn prune_drops_the_oldest_above_the_caps_and_keeps_the_newest() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let dir = history_dir(pack, "block/stone").unwrap();
        fs::create_dir_all(&dir).unwrap();
        for i in 0..6u64 {
            fs::write(dir.join(format!("{}.png", 1000 + i)), vec![0u8; 100]).unwrap();
        }
        assert_eq!(prune_to(pack, "block/stone", 4, 10_000).unwrap(), 2);
        assert!(!dir.join("1000.png").exists() && !dir.join("1001.png").exists());
        assert!(dir.join("1005.png").exists());
        // the byte cap: 250 bytes keeps two files of 100
        assert_eq!(prune_to(pack, "block/stone", 50, 250).unwrap(), 2);
        assert!(dir.join("1005.png").exists() && dir.join("1004.png").exists());
        // a single file larger than the cap is still kept
        assert_eq!(prune_to(pack, "block/stone", 50, 10).unwrap(), 1);
        assert!(dir.join("1005.png").exists());
        assert_eq!(prune(pack, "block/none").unwrap(), 0);
    }

    #[test]
    fn same_millisecond_records_do_not_overwrite_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let a = record(pack, "block/stone", b"one", 0).unwrap();
        let b = record(pack, "block/stone", b"two", 0).unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read(a).unwrap(), b"one");
        assert_eq!(fs::read(b).unwrap(), b"two");
    }

    #[test]
    fn the_pack_icon_has_its_own_history_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        fs::write(pack.join("pack.png"), png(64, 64, 1)).unwrap();
        record(pack, ICON_PATH, &png(64, 64, 2), 0).unwrap();
        assert!(history_dir(pack, ICON_PATH)
            .unwrap()
            .ends_with("history-icon"));
        let v = list(pack, ICON_PATH).unwrap();
        restore(pack, ICON_PATH, &v[0].id).unwrap();
        assert_eq!(fs::read(pack.join("pack.png")).unwrap(), png(64, 64, 2));
    }

    #[test]
    fn rename_moves_the_history_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        record(pack, "blocks/stone", b"x", 0).unwrap();
        assert_eq!(rename(pack, "blocks/stone", "block/stone").unwrap(), 1);
        assert_eq!(list(pack, "block/stone").unwrap().len(), 1);
        assert!(!history_dir(pack, "blocks/stone").unwrap().exists());
    }
}

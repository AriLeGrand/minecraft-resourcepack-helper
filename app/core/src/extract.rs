//! Extracting vanilla textures from the user's own game jar into the app cache.
//!
//! Layout: `<cache>/vanilla/<version folder>/assets/minecraft/...`, plus
//! `thumbs/` and `index.json`. Extraction happens in a temporary folder that is
//! renamed at the end, so a crash never leaves a half-extracted version.

use crate::error::{CoreError, IoCtx, Result};
use crate::minecraft::InstalledVersion;
use crate::textures::{build_entries, VanillaIndex, INDEX_SCHEMA};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Folders of the jar that are extracted (textures, and the small JSON files
/// that describe models and particles, used by later previews).
const WANTED: [(&str, &[&str]); 6] = [
    ("assets/minecraft/textures/", &["png", "mcmeta"]),
    ("assets/minecraft/models/", &["json"]),
    ("assets/minecraft/blockstates/", &["json"]),
    ("assets/minecraft/particles/", &["json"]),
    ("assets/minecraft/atlases/", &["json"]),
    ("assets/minecraft/items/", &["json"]),
];

/// Refuse absurd entries (a real texture is far below this).
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

pub fn vanilla_dir(cache_root: &Path, dir_name: &str) -> PathBuf {
    cache_root.join("vanilla").join(dir_name)
}

fn index_file(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

/// Loads the index of an extracted version. `None` when it is missing,
/// unreadable, from another app version, or the jar changed since.
pub fn load_index(cache_root: &Path, version: &InstalledVersion) -> Option<VanillaIndex> {
    if !is_extracted(cache_root, version) {
        return None;
    }
    let text = fs::read_to_string(index_file(&vanilla_dir(cache_root, &version.dir_name))).ok()?;
    let idx: VanillaIndex = serde_json::from_str(&text).ok()?;
    (idx.schema == INDEX_SCHEMA
        && idx.jar_size == version.jar_size
        && idx.jar_modified_ms == version.jar_modified_ms)
        .then_some(idx)
}

/// Small file written next to the index so "is it extracted?" does not have
/// to parse the whole index.
#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
struct Stamp {
    schema: u32,
    jar_size: u64,
    jar_modified_ms: u64,
}

fn stamp_file(dir: &Path) -> PathBuf {
    dir.join("stamp.json")
}

pub fn is_extracted(cache_root: &Path, version: &InstalledVersion) -> bool {
    let dir = vanilla_dir(cache_root, &version.dir_name);
    let want = Stamp {
        schema: INDEX_SCHEMA,
        jar_size: version.jar_size,
        jar_modified_ms: version.jar_modified_ms,
    };
    fs::read_to_string(stamp_file(&dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Stamp>(&t).ok())
        .is_some_and(|s| s == want)
        && index_file(&dir).is_file()
}

fn wanted(name: &str) -> bool {
    WANTED.iter().any(|(prefix, exts)| {
        name.starts_with(prefix) && name.rsplit('.').next().is_some_and(|e| exts.contains(&e))
    })
}

/// One lock per extracted folder, shared by every thread of the app.
fn version_lock(cache_root: &Path, dir_name: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = vanilla_dir(cache_root, dir_name);
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_default().clone()
}

/// Extracts a version (or returns the cached index when it is up to date).
/// `progress(done, total)` is called while files are written.
pub fn extract_version(
    cache_root: &Path,
    version: &InstalledVersion,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<VanillaIndex> {
    if !version.has_jar {
        return Err(CoreError::new(
            "no_jar",
            format!(
                "Minecraft {} has never been started, so its files are not on this computer.",
                version.dir_name
            ),
        )
        .hint("Open the Minecraft launcher, start this version once, then come back."));
    }
    if let Some(p) = &version.problem {
        return Err(CoreError::new(
            "corrupt_jar",
            format!("Minecraft {}: {p}", version.dir_name),
        ));
    }
    if let Some(idx) = load_index(cache_root, version) {
        return Ok(idx);
    }
    // Two requests for the same version (for example the start screen and
    // the browser at once) must not write the same temporary folder: the
    // second one waits, then uses what the first one extracted.
    let lock = version_lock(cache_root, &version.dir_name);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(idx) = load_index(cache_root, version) {
        return Ok(idx);
    }

    let jar = Path::new(&version.jar_path);
    let corrupt = || {
        CoreError::new(
            "corrupt_jar",
            format!(
                "The game file for {} is damaged and could not be read.",
                version.dir_name
            ),
        )
        .hint("Open the Minecraft launcher and start this version once so it is downloaded again.")
    };
    let file = fs::File::open(jar).ctx(jar)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| corrupt())?;

    let final_dir = vanilla_dir(cache_root, &version.dir_name);
    let parent = final_dir
        .parent()
        .expect("vanilla dir has a parent")
        .to_path_buf();
    fs::create_dir_all(&parent).ctx(&parent)?;
    let tmp_dir = parent.join(format!("{}.tmp-{}", version.dir_name, std::process::id()));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).ctx(&tmp_dir)?;
    }

    let names: Vec<usize> = (0..zip.len())
        .filter(|&i| zip.name_for_index(i).is_some_and(wanted))
        .collect();
    let total = names.len();
    let result = (|| -> Result<()> {
        for (done, &i) in names.iter().enumerate() {
            let mut entry = zip.by_index(i).map_err(|_| corrupt())?;
            // enclosed_name refuses "..", absolute paths and drive letters
            let Some(rel) = entry.enclosed_name() else {
                continue;
            };
            if entry.is_dir() || entry.size() > MAX_ENTRY_BYTES {
                continue;
            }
            let out = tmp_dir.join(rel);
            if let Some(dir) = out.parent() {
                fs::create_dir_all(dir).ctx(dir)?;
            }
            let mut f = fs::File::create(&out).ctx(&out)?;
            io::copy(&mut entry, &mut f).map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidData
                    || e.kind() == io::ErrorKind::UnexpectedEof
                {
                    corrupt()
                } else {
                    CoreError::io(&out, &e)
                }
            })?;
            if done % 64 == 0 {
                progress(done, total);
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    let entries = match build_entries(&tmp_dir, true) {
        Ok(e) => e,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(e);
        }
    };
    if entries.is_empty() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(CoreError::new(
            "no_textures",
            format!(
                "No textures were found in the game file for {}.",
                version.dir_name
            ),
        )
        .hint("Pick a vanilla version (not a mod loader profile without its own game file)."));
    }
    let index = VanillaIndex {
        schema: INDEX_SCHEMA,
        dir_name: version.dir_name.clone(),
        id: version.id.clone(),
        format: version.format,
        jar_size: version.jar_size,
        jar_modified_ms: version.jar_modified_ms,
        entries,
    };
    let idx_path = index_file(&tmp_dir);
    fs::write(
        &idx_path,
        serde_json::to_vec(&index).expect("index serialises"),
    )
    .ctx(&idx_path)?;

    let stamp = Stamp {
        schema: INDEX_SCHEMA,
        jar_size: version.jar_size,
        jar_modified_ms: version.jar_modified_ms,
    };
    let stamp_path = stamp_file(&tmp_dir);
    fs::write(
        &stamp_path,
        serde_json::to_vec(&stamp).expect("stamp serialises"),
    )
    .ctx(&stamp_path)?;

    if final_dir.exists() {
        fs::remove_dir_all(&final_dir).ctx(&final_dir)?;
    }
    fs::rename(&tmp_dir, &final_dir).ctx(&final_dir)?;
    progress(total, total);
    Ok(index)
}

/// Deletes the extracted files of one version (they can always be extracted again).
pub fn clear_version(cache_root: &Path, dir_name: &str) -> Result<()> {
    let dir = vanilla_dir(cache_root, dir_name);
    if dir.exists() {
        fs::remove_dir_all(&dir).ctx(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::{list_versions, testutil::*};
    use crate::textures::{texture_file, thumb_file, Category};

    fn setup() -> (tempfile::TempDir, PathBuf, Vec<InstalledVersion>) {
        let tmp = tempfile::tempdir().unwrap();
        let mc = fake_minecraft(tmp.path());
        let versions = list_versions(&mc).unwrap();
        let cache = tmp.path().join("cache");
        (tmp, cache, versions)
    }

    fn by_name<'a>(vs: &'a [InstalledVersion], n: &str) -> &'a InstalledVersion {
        vs.iter().find(|v| v.dir_name == n).unwrap()
    }

    #[test]
    fn extracts_textures_and_builds_the_index() {
        let (_tmp, cache, vs) = setup();
        let v = by_name(&vs, "1.21.4");
        assert!(!is_extracted(&cache, v));
        let mut calls = 0;
        let idx = extract_version(&cache, v, &mut |_, _| calls += 1).unwrap();
        assert!(calls > 0);
        assert!(is_extracted(&cache, v));
        assert_eq!(idx.entries.len(), 15);
        let root = vanilla_dir(&cache, "1.21.4");
        assert!(texture_file(&root, "block/oak_planks").unwrap().is_file());
        // class files and other jar content are never extracted
        assert!(!root.join("net").exists());
        assert!(!root.join("version.json").exists());
        assert!(root.join("assets/minecraft/particles/flame.json").is_file());

        let planks = idx.get("block/oak_planks").unwrap();
        assert_eq!(
            (planks.width, planks.height, planks.animated, planks.frames),
            (16, 16, false, 1)
        );
        assert_eq!(planks.used_by, ["oak_stairs"]);
        assert!(!planks.has_thumb);

        let prismarine = idx.get("block/prismarine").unwrap();
        assert!(prismarine.animated && prismarine.interpolate);
        assert_eq!((prismarine.frames, prismarine.frametime), (4, 300));
        assert!(prismarine.has_thumb && thumb_file(&root, "block/prismarine").is_file());

        let button = idx.get("gui/sprites/widget/button").unwrap();
        assert!(button.has_mcmeta && !button.animated);
        assert!(idx.get("gui/container/inventory").unwrap().has_thumb);

        let counts = idx.count_by_category();
        assert_eq!(counts[&Category::Blocks], 4);
        assert_eq!(counts[&Category::Armor], 1);
        assert!(idx.get("block/missing").is_none());
    }

    #[test]
    fn second_run_uses_the_cache_and_a_changed_jar_invalidates_it() {
        let (_tmp, cache, vs) = setup();
        let v = by_name(&vs, "1.8.9");
        let a = extract_version(&cache, v, &mut |_, _| {}).unwrap();
        let marker = vanilla_dir(&cache, "1.8.9").join("marker");
        fs::write(&marker, "x").unwrap();
        let b = extract_version(&cache, v, &mut |_, _| panic!("must not extract again")).unwrap();
        assert_eq!(a, b);
        assert!(marker.exists());

        let mut changed = v.clone();
        changed.jar_size += 1;
        assert!(!is_extracted(&cache, &changed));
    }

    #[test]
    fn never_launched_and_corrupted_versions_give_clear_errors() {
        let (_tmp, cache, vs) = setup();
        let e = extract_version(&cache, by_name(&vs, "1.21.9"), &mut |_, _| {}).unwrap_err();
        assert_eq!(e.kind, "no_jar");
        assert!(e.hint.unwrap().contains("launcher"));
        let e = extract_version(&cache, by_name(&vs, "1.16.5"), &mut |_, _| {}).unwrap_err();
        assert_eq!(e.kind, "corrupt_jar");
        // nothing half-written is left behind
        assert!(!vanilla_dir(&cache, "1.16.5").exists());
    }

    #[test]
    fn truncated_jar_leaves_no_partial_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp
            .path()
            .join("versions")
            .join("1.20.1")
            .join("1.20.1.jar");
        write_jar(&jar, &modern_entries());
        let bytes = fs::read(&jar).unwrap();
        fs::write(&jar, &bytes[..bytes.len() / 2]).unwrap();
        let vs = list_versions(tmp.path()).unwrap();
        let cache = tmp.path().join("cache");
        assert!(extract_version(&cache, &vs[0], &mut |_, _| {}).is_err());
        let left: Vec<_> = fs::read_dir(cache.join("vanilla"))
            .map(|d| d.collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn paths_that_escape_the_cache_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp
            .path()
            .join("versions")
            .join("1.20.1")
            .join("1.20.1.jar");
        write_jar(
            &jar,
            &[
                ("assets/minecraft/textures/block/stone.png", png(16, 16, 1)),
                (
                    "assets/minecraft/textures/../../../../evil.png",
                    png(16, 16, 2),
                ),
            ],
        );
        let vs = list_versions(tmp.path()).unwrap();
        let cache = tmp.path().join("cache");
        let idx = extract_version(&cache, &vs[0], &mut |_, _| {}).unwrap();
        assert_eq!(idx.entries.len(), 1);
        assert!(!tmp.path().join("evil.png").exists());
        assert!(!cache.join("evil.png").exists());
        assert!(!cache.join("vanilla").join("evil.png").exists());
    }

    #[test]
    fn clear_removes_the_cache() {
        let (_tmp, cache, vs) = setup();
        let v = by_name(&vs, "1.21.4");
        extract_version(&cache, v, &mut |_, _| {}).unwrap();
        clear_version(&cache, "1.21.4").unwrap();
        assert!(!is_extracted(&cache, v));
        clear_version(&cache, "1.21.4").unwrap(); // twice is fine
    }

    #[test]
    fn two_extractions_of_the_same_version_at_once_both_succeed() {
        let (_tmp, cache, vs) = setup();
        let v = by_name(&vs, "1.21.4").clone();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (cache, v) = (cache.clone(), v.clone());
                std::thread::spawn(move || extract_version(&cache, &v, &mut |_, _| {}))
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        for r in &results {
            assert_eq!(r.as_ref().unwrap(), results[0].as_ref().unwrap());
        }
        assert!(is_extracted(&cache, &v));
        let leftovers: Vec<_> = fs::read_dir(cache.join("vanilla"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }
}

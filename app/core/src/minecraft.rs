//! Finding the game folder and the installed versions.

use crate::error::{CoreError, IoCtx, Result};
use crate::pack_format::{
    fallback_format, parse_version_json, version_for_format, FormatSource, PackFormat,
};
use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Default `.minecraft` folder for this operating system, if its parent exists.
pub fn default_minecraft_dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if cfg!(target_os = "windows") {
        env("APPDATA").map(|p| p.join(".minecraft"))
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|p| {
            p.join("Library")
                .join("Application Support")
                .join("minecraft")
        })
    } else {
        env("HOME").map(|p| p.join(".minecraft"))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstalledVersion {
    /// Folder name under `versions/` (what the launcher shows).
    pub dir_name: String,
    /// Real game version, e.g. `1.20.1` for `fabric-loader-0.15.7-1.20.1`.
    pub id: Option<String>,
    pub has_jar: bool,
    pub jar_path: String,
    pub jar_size: u64,
    pub jar_modified_ms: u64,
    pub format: Option<PackFormat>,
    pub format_source: Option<FormatSource>,
    /// Set when the jar exists but cannot be used (corrupted…).
    pub problem: Option<String>,
}

impl InstalledVersion {
    /// Version used for names and folders. Snapshots fall back to the first
    /// release with the same pack format.
    pub fn mc_version(&self) -> Option<McVersion> {
        self.id
            .as_deref()
            .and_then(McVersion::parse)
            .or_else(|| self.id.as_deref().and_then(McVersion::find_in))
            .or_else(|| McVersion::find_in(&self.dir_name))
            .or_else(|| self.format.and_then(|f| version_for_format(f.major)))
    }

    pub fn usable(&self) -> bool {
        self.has_jar && self.problem.is_none()
    }
}

fn inspect_jar(jar: &Path, dir_name: &str) -> InstalledVersion {
    let meta = fs::metadata(jar).ok();
    let mut v = InstalledVersion {
        dir_name: dir_name.to_owned(),
        id: None,
        has_jar: true,
        jar_path: jar.to_string_lossy().into_owned(),
        jar_size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        jar_modified_ms: meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        format: None,
        format_source: None,
        problem: None,
    };
    let corrupted = "The game file is damaged. Open the Minecraft launcher and start this version once so it is downloaded again.";
    let file = match fs::File::open(jar) {
        Ok(f) => f,
        Err(e) => {
            v.problem = Some(CoreError::io(jar, &e).message);
            return v;
        }
    };
    let mut zip = match zip::ZipArchive::new(file) {
        Ok(z) => z,
        Err(_) => {
            v.problem = Some(corrupted.to_owned());
            return v;
        }
    };
    let mut text = String::new();
    let info = match zip.by_name("version.json") {
        Ok(mut f) => f
            .read_to_string(&mut text)
            .ok()
            .and_then(|_| parse_version_json(&text).ok()),
        Err(_) => None,
    };
    if let Some(info) = info {
        v.id = info.id.or(info.name);
        if let Some(f) = info.resource_format {
            v.format = Some(f);
            v.format_source = Some(FormatSource::GameFiles);
        }
    }
    if v.id.is_none() {
        v.id = McVersion::find_in(dir_name).map(|m| m.to_string());
    }
    if v.format.is_none() {
        if let Some((f, src)) =
            v.id.as_deref()
                .and_then(McVersion::find_in)
                .and_then(|m| fallback_format(&m))
        {
            v.format = Some(f);
            v.format_source = Some(src);
        }
    }
    let has_textures = zip
        .file_names()
        .any(|n| n.starts_with("assets/minecraft/textures/"));
    if !has_textures {
        v.problem =
            Some("This file contains no textures (it is not a vanilla game jar).".to_owned());
    }
    v
}

/// Lists every folder in `<mc_dir>/versions`, newest version first.
/// Folders without a jar are returned too (`has_jar == false`) so the UI can
/// explain that the version must be started once.
pub fn list_versions(mc_dir: &Path) -> Result<Vec<InstalledVersion>> {
    if !mc_dir.is_dir() {
        return Err(CoreError::new("no_minecraft", format!("No Minecraft folder at {}.", mc_dir.display()))
            .hint("Install Minecraft Java Edition and start it once, or choose the folder yourself in Settings."));
    }
    let versions_dir = mc_dir.join("versions");
    if !versions_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&versions_dir).ctx(&versions_dir)? {
        let entry = entry.ctx(&versions_dir)?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let jar = path.join(format!("{name}.jar"));
        if jar.is_file() {
            out.push(inspect_jar(&jar, &name));
        } else {
            out.push(InstalledVersion {
                id: McVersion::find_in(&name).map(|m| m.to_string()),
                dir_name: name,
                has_jar: false,
                jar_path: jar.to_string_lossy().into_owned(),
                jar_size: 0,
                jar_modified_ms: 0,
                format: None,
                format_source: None,
                problem: None,
            });
        }
    }
    out.sort_by(|a, b| {
        let (va, vb) = (a.mc_version(), b.mc_version());
        vb.cmp(&va)
            .then_with(|| {
                (a.id.as_deref() != Some(&a.dir_name)).cmp(&(b.id.as_deref() != Some(&b.dir_name)))
            })
            .then_with(|| a.dir_name.cmp(&b.dir_name))
    });
    Ok(out)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    /// A tiny RGBA PNG made by the test (never a game file).
    pub fn png(w: u32, h: u32, seed: u8) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgba([
                (x as u8).wrapping_mul(seed),
                (y as u8).wrapping_add(seed),
                seed,
                255,
            ]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// Writes a synthetic "game jar" with the given entries.
    pub fn write_jar(path: &Path, entries: &[(&str, Vec<u8>)]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            z.start_file(*name, opts).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    pub fn modern_entries() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("version.json", br#"{"id":"1.21.4","name":"1.21.4","pack_version":{"resource":46,"data":61}}"#.to_vec()),
            ("assets/minecraft/textures/block/oak_planks.png", png(16, 16, 3)),
            ("assets/minecraft/textures/block/stone.png", png(16, 16, 5)),
            ("assets/minecraft/textures/block/short_grass.png", png(16, 16, 6)),
            ("assets/minecraft/textures/block/prismarine.png", png(16, 64, 7)),
            (
                "assets/minecraft/textures/block/prismarine.png.mcmeta",
                br#"{"animation":{"frametime":300,"interpolate":true,"frames":[0,1,0,2]}}"#.to_vec(),
            ),
            ("assets/minecraft/textures/item/diamond.png", png(16, 16, 9)),
            ("assets/minecraft/textures/item/red_dye.png", png(16, 16, 10)),
            ("assets/minecraft/textures/gui/container/inventory.png", png(256, 256, 11)),
            ("assets/minecraft/textures/gui/sprites/widget/button.png", png(200, 20, 12)),
            (
                "assets/minecraft/textures/gui/sprites/widget/button.png.mcmeta",
                br#"{"gui":{"scaling":{"type":"nine_slice","width":200,"height":20,"border":3}}}"#.to_vec(),
            ),
            ("assets/minecraft/textures/entity/creeper/creeper.png", png(64, 32, 13)),
            ("assets/minecraft/textures/particle/flame.png", png(8, 8, 14)),
            ("assets/minecraft/textures/painting/kebab.png", png(16, 16, 15)),
            ("assets/minecraft/textures/mob_effect/speed.png", png(18, 18, 16)),
            ("assets/minecraft/textures/environment/sun.png", png(32, 32, 17)),
            ("assets/minecraft/textures/entity/equipment/humanoid/iron.png", png(64, 32, 18)),
            ("assets/minecraft/textures/misc/vignette.png", png(16, 16, 19)),
            (
                "assets/minecraft/models/block/oak_planks.json",
                br#"{"parent":"minecraft:block/cube_all","textures":{"all":"minecraft:block/oak_planks"}}"#.to_vec(),
            ),
            (
                "assets/minecraft/models/block/oak_stairs.json",
                br#"{"parent":"minecraft:block/stairs","textures":{"bottom":"block/oak_planks","top":"minecraft:block/oak_planks"}}"#.to_vec(),
            ),
            ("assets/minecraft/particles/flame.json", br#"{"textures":["minecraft:flame"]}"#.to_vec()),
            ("net/minecraft/client/Main.class", vec![0xCA, 0xFE]),
        ]
    }

    pub fn legacy_entries() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            (
                "assets/minecraft/textures/blocks/planks_oak.png",
                png(16, 16, 3),
            ),
            ("assets/minecraft/textures/blocks/stone.png", png(16, 16, 5)),
            (
                "assets/minecraft/textures/blocks/tallgrass.png",
                png(16, 16, 6),
            ),
            (
                "assets/minecraft/textures/items/diamond.png",
                png(16, 16, 9),
            ),
            (
                "assets/minecraft/textures/items/dye_powder_red.png",
                png(16, 16, 10),
            ),
            (
                "assets/minecraft/textures/particle/particles.png",
                png(128, 128, 20),
            ),
        ]
    }

    /// Builds a fake `.minecraft` with a modern version, an old one, a
    /// modded profile, a never-launched version and a corrupted jar.
    pub fn fake_minecraft(root: &Path) -> PathBuf {
        let mc = root.join(".minecraft");
        let v = mc.join("versions");
        write_jar(&v.join("1.21.4").join("1.21.4.jar"), &modern_entries());
        write_jar(&v.join("1.8.9").join("1.8.9.jar"), &legacy_entries());
        write_jar(
            &v.join("fabric-loader-0.16.0-1.21.4")
                .join("fabric-loader-0.16.0-1.21.4.jar"),
            &modern_entries(),
        );
        fs::create_dir_all(v.join("1.21.9")).unwrap();
        fs::write(v.join("1.21.9").join("1.21.9.json"), "{}").unwrap();
        fs::create_dir_all(v.join("1.16.5")).unwrap();
        fs::write(
            v.join("1.16.5").join("1.16.5.jar"),
            b"this is not a zip file",
        )
        .unwrap();
        fs::create_dir_all(mc.join("resourcepacks")).unwrap();
        mc
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn missing_minecraft_folder_is_a_clear_error() {
        let tmp = tempfile::tempdir().unwrap();
        let e = list_versions(&tmp.path().join("nope")).unwrap_err();
        assert_eq!(e.kind, "no_minecraft");
        assert!(e.hint.is_some());
    }

    #[test]
    fn folder_without_versions_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_versions(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn lists_all_kinds_of_version_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = fake_minecraft(tmp.path());
        let vs = list_versions(&mc).unwrap();
        let names: Vec<&str> = vs.iter().map(|v| v.dir_name.as_str()).collect();
        // newest first; the vanilla folder before the modded one of the same version
        assert_eq!(
            names,
            [
                "1.21.9",
                "1.21.4",
                "fabric-loader-0.16.0-1.21.4",
                "1.16.5",
                "1.8.9"
            ]
        );

        let modern = &vs[1];
        assert!(modern.usable());
        assert_eq!(modern.id.as_deref(), Some("1.21.4"));
        assert_eq!(modern.format, Some(PackFormat::new(46)));
        assert_eq!(modern.format_source, Some(FormatSource::GameFiles));

        let fabric = &vs[2];
        assert_eq!(fabric.id.as_deref(), Some("1.21.4"));
        assert!(fabric.usable());

        let never_launched = &vs[0];
        assert!(!never_launched.has_jar && !never_launched.usable());

        let corrupted = &vs[3];
        assert!(corrupted.has_jar && !corrupted.usable());
        assert!(corrupted.problem.as_deref().unwrap().contains("damaged"));

        let old = &vs[4];
        assert_eq!(old.format, Some(PackFormat::new(1)));
        assert_eq!(old.format_source, Some(FormatSource::Table));
        assert_eq!(old.mc_version().unwrap().to_string(), "1.8.9");
    }

    #[test]
    fn jar_without_textures_is_flagged() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp
            .path()
            .join("versions")
            .join("forge-1.20")
            .join("forge-1.20.jar");
        write_jar(&jar, &[("META-INF/MANIFEST.MF", b"x".to_vec())]);
        let vs = list_versions(tmp.path()).unwrap();
        assert!(!vs[0].usable());
    }
}

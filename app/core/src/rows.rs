//! The texture browser's list: vanilla textures merged with the pack's files.

use crate::pack::{is_wrong_size, status_of, PackTexture, Project, Status};
use crate::renames::RenameTable;
use crate::textures::{category_of, Category, VanillaIndex};
use crate::version::McVersion;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextureRow {
    pub path: String,
    pub category: Category,
    /// Vanilla size (0×0 for a pack file the game does not have).
    pub width: u32,
    pub height: u32,
    pub animated: bool,
    pub frames: u32,
    pub has_thumb: bool,
    pub status: Status,
    pub mine: Option<PackTexture>,
    pub wrong_size: bool,
    /// The file name is different in some other version.
    pub renamed: bool,
    /// In the pack but not in the game (unknown or old name).
    pub extra: bool,
}

/// True when the base name of a texture changed at some point in history
/// (a folder-only change such as `blocks/` → `block/` does not count).
pub fn has_other_names(path: &str, version: &McVersion) -> bool {
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_owned();
    let mine = base(path);
    RenameTable::builtin()
        .history(path, version)
        .iter()
        .any(|(_, name)| base(name) != mine)
}

pub fn build_rows(
    vanilla: &VanillaIndex,
    pack: &[PackTexture],
    project: &Project,
    version: Option<&McVersion>,
) -> Vec<TextureRow> {
    let mine: HashMap<&str, &PackTexture> = pack.iter().map(|t| (t.path.as_str(), t)).collect();
    let mut rows: Vec<TextureRow> = vanilla
        .entries
        .iter()
        .map(|e| {
            let m = mine.get(e.path.as_str()).copied();
            TextureRow {
                path: e.path.clone(),
                category: e.category,
                width: e.width,
                height: e.height,
                animated: e.animated || m.is_some_and(|t| t.animated),
                frames: m.map(|t| t.frames).unwrap_or(e.frames),
                has_thumb: e.has_thumb,
                status: status_of(m, project.last_export_ms),
                wrong_size: m.is_some_and(|t| is_wrong_size(e, t, project.resolution)),
                renamed: version.is_some_and(|v| has_other_names(&e.path, v)),
                mine: m.cloned(),
                extra: false,
            }
        })
        .collect();
    for t in pack {
        if vanilla.get(&t.path).is_none() {
            rows.push(TextureRow {
                path: t.path.clone(),
                category: category_of(&t.path),
                width: 0,
                height: 0,
                animated: t.animated,
                frames: t.frames,
                has_thumb: false,
                status: status_of(Some(t), project.last_export_ms),
                mine: Some(t.clone()),
                wrong_size: false,
                renamed: false,
                extra: true,
            });
        }
    }
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    rows
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NameEra {
    /// Human label: "1.12.2 and older", "1.13 and newer", "1.13 to 1.13.2".
    pub label: String,
    pub name: String,
    /// True for the era that contains the pack's version.
    pub current: bool,
}

/// "Name across versions" for the inspector.
pub fn name_eras(path: &str, version: &McVersion) -> Vec<NameEra> {
    let table = RenameTable::builtin();
    let hist = table.history(path, version);
    if hist.len() < 2 {
        return Vec::new();
    }
    // last release before each step, for readable labels
    let before = |v: &McVersion| -> String {
        match v.to_string().as_str() {
            "1.13" => "1.12.2".into(),
            "1.14" => "1.13.2".into(),
            "1.17" => "1.16.5".into(),
            "1.20.3" => "1.20.2".into(),
            "1.20.5" => "1.20.4".into(),
            "1.21.2" => "1.21.1".into(),
            "1.21.4" => "1.21.3".into(),
            "1.21.5" => "1.21.4".into(),
            "1.21.9" => "1.21.8".into(),
            "1.21.11" => "1.21.10".into(),
            other => format!("before {other}"),
        }
    };
    let mut out = Vec::new();
    for (i, (from, name)) in hist.iter().enumerate() {
        let next = hist.get(i + 1).and_then(|(f, _)| f.as_ref());
        let label = match (from, next) {
            (None, Some(n)) => format!("{} and older", before(n)),
            (Some(f), Some(n)) => {
                let last = before(n);
                if last == f.to_string() {
                    f.to_string()
                } else {
                    format!("{f} to {last}")
                }
            }
            (Some(f), None) => format!("{f} and newer"),
            (None, None) => "All versions".into(),
        };
        let current =
            from.as_ref().is_none_or(|f| version >= f) && next.is_none_or(|n| version < n);
        out.push(NameEra {
            label,
            name: name.clone(),
            current,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack_format::PackFormat;
    use crate::textures::TextureEntry;

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    fn entry(path: &str, w: u32, h: u32) -> TextureEntry {
        TextureEntry {
            path: path.into(),
            category: category_of(path),
            width: w,
            height: h,
            animated: false,
            frames: 1,
            frametime: 1,
            interpolate: false,
            has_mcmeta: false,
            has_thumb: false,
            used_by: vec![],
            used_by_more: 0,
        }
    }

    fn mine(path: &str, w: u32, h: u32, modified_ms: u64) -> PackTexture {
        PackTexture {
            path: path.into(),
            width: w,
            height: h,
            modified_ms,
            has_mcmeta: false,
            animated: false,
            frames: 1,
            file_size: 10,
        }
    }

    fn fixture() -> (VanillaIndex, Project) {
        let mut entries = vec![
            entry("block/oak_planks", 16, 16),
            entry("block/stone", 16, 16),
            entry("gui/widgets", 256, 256),
            entry("item/red_dye", 16, 16),
        ];
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let index = VanillaIndex {
            schema: 3,
            dir_name: "1.21.4".into(),
            id: Some("1.21.4".into()),
            format: None,
            jar_size: 0,
            jar_modified_ms: 0,
            entries,
        };
        let project = Project {
            schema: 1,
            name: "p".into(),
            description: String::new(),
            version_dir: "1.21.4".into(),
            version_id: Some("1.21.4".into()),
            format: PackFormat::new(46),
            resolution: 32,
            created_ms: 0,
            last_export_ms: Some(1000),
            also_export: vec![],
        };
        (index, project)
    }

    #[test]
    fn rows_merge_vanilla_and_pack() {
        let (index, project) = fixture();
        let pack = vec![
            mine("block/oak_planks", 32, 32, 500),  // done, exported
            mine("block/stone", 16, 16, 2000),      // changed since export, wrong size
            mine("blocks/planks_oak", 32, 32, 500), // not in this version
        ];
        let rows = build_rows(&index, &pack, &project, Some(&v("1.21.4")));
        assert_eq!(rows.len(), 5);
        let get = |p: &str| rows.iter().find(|r| r.path == p).unwrap();
        assert_eq!(get("block/oak_planks").status, Status::Done);
        assert!(!get("block/oak_planks").wrong_size);
        assert!(get("block/oak_planks").renamed);
        assert_eq!(get("block/stone").status, Status::Changed);
        assert!(get("block/stone").wrong_size);
        assert!(
            !get("block/stone").renamed,
            "a folder-only change is not a rename"
        );
        assert_eq!(get("gui/widgets").status, Status::Todo);
        assert!(get("gui/widgets").mine.is_none());
        assert!(get("blocks/planks_oak").extra);
        assert!(get("item/red_dye").renamed);
        // sorted by path
        let paths: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn eras_for_the_inspector_match_the_mockup() {
        let eras = name_eras("block/oak_planks", &v("1.21.4"));
        assert_eq!(
            eras.iter()
                .map(|e| (e.label.as_str(), e.name.as_str(), e.current))
                .collect::<Vec<_>>(),
            [
                ("1.12.2 and older", "blocks/planks_oak", false),
                ("1.13 and newer", "block/oak_planks", true)
            ]
        );
        let eras = name_eras("item/rose_red", &v("1.13.2"));
        assert_eq!(
            eras.iter()
                .map(|e| (e.label.as_str(), e.name.as_str(), e.current))
                .collect::<Vec<_>>(),
            [
                ("1.12.2 and older", "items/dye_powder_red", false),
                ("1.13 to 1.13.2", "item/rose_red", true),
                ("1.14 and newer", "item/red_dye", false)
            ]
        );
        let eras = name_eras("blocks/planks_oak", &v("1.8.9"));
        assert!(eras[0].current && !eras[1].current);
        // nothing to show for a texture that never changed
        assert!(name_eras("entity/creeper/creeper", &v("1.21.4")).is_empty());
    }
}

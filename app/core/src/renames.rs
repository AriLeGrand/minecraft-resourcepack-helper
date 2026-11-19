//! Texture renames between versions (the 1.13 "Flattening" and later ones).
//!
//! Paths are relative to `assets/minecraft/textures`, use `/` and have no
//! `.png` extension, for example `block/oak_planks`.

use crate::version::McVersion;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct FileData {
    steps: Vec<StepData>,
}

#[derive(Debug, Deserialize)]
struct StepData {
    id: String,
    version: String,
    #[serde(default)]
    folders: BTreeMap<String, String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    removed: Vec<String>,
}

/// One point on the version line where names change.
#[derive(Debug)]
pub struct Step {
    pub id: String,
    /// Names change when going from below this version to it or above.
    pub version: McVersion,
    folders: BTreeMap<String, String>,
    folders_back: BTreeMap<String, String>,
    forward: HashMap<String, String>,
    backward: HashMap<String, Vec<String>>,
    removed: HashSet<String>,
}

#[derive(Debug)]
pub struct RenameTable {
    steps: Vec<Step>,
}

fn swap_folder(path: &str, folders: &BTreeMap<String, String>) -> String {
    match path.split_once('/') {
        Some((first, rest)) => match folders.get(first) {
            Some(new) => format!("{new}/{rest}"),
            None => path.to_owned(),
        },
        None => path.to_owned(),
    }
}

impl RenameTable {
    pub fn from_json(text: &str) -> Result<Self, String> {
        let data: FileData = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let mut steps = Vec::new();
        for s in data.steps {
            let version = McVersion::parse(&s.version)
                .ok_or_else(|| format!("bad version in step {}", s.id))?;
            let mut backward: HashMap<String, Vec<String>> = HashMap::new();
            for (old, new) in &s.files {
                backward.entry(new.clone()).or_default().push(old.clone());
            }
            for v in backward.values_mut() {
                v.sort();
            }
            steps.push(Step {
                id: s.id,
                version,
                folders_back: s
                    .folders
                    .iter()
                    .map(|(a, b)| (b.clone(), a.clone()))
                    .collect(),
                folders: s.folders,
                forward: s.files.into_iter().collect(),
                backward,
                removed: s.removed.into_iter().collect(),
            });
        }
        steps.sort_by(|a, b| a.version.cmp(&b.version));
        Ok(Self { steps })
    }

    /// The table shipped with the app.
    pub fn builtin() -> &'static RenameTable {
        static T: OnceLock<RenameTable> = OnceLock::new();
        T.get_or_init(|| {
            RenameTable::from_json(include_str!("../data/renames.json"))
                .expect("renames.json is valid")
        })
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    /// Names of `path` (valid in version `from`) in version `to`.
    ///
    /// Usually one name. Empty when the texture has no equivalent (removed).
    /// More than one when going back in time and several old textures were
    /// merged into the one given.
    pub fn map(&self, path: &str, from: &McVersion, to: &McVersion) -> Vec<String> {
        let mut current = vec![path.to_owned()];
        if from < to {
            for step in self
                .steps
                .iter()
                .filter(|s| *from < s.version && s.version <= *to)
            {
                current = current
                    .into_iter()
                    .filter_map(|p| step.apply_forward(&p))
                    .collect();
            }
        } else {
            for step in self
                .steps
                .iter()
                .rev()
                .filter(|s| *to < s.version && s.version <= *from)
            {
                current = current
                    .into_iter()
                    .flat_map(|p| step.apply_backward(&p))
                    .collect();
            }
        }
        current.sort();
        current.dedup();
        current
    }

    /// True when `map` would change the name between the two versions.
    pub fn is_renamed(&self, path: &str, from: &McVersion, to: &McVersion) -> bool {
        self.map(path, from, to) != [path.to_owned()]
    }

    /// History of a texture name over time, oldest first, for the
    /// "name across versions" panel. Each entry is the first version that
    /// uses the name (`None` = from the oldest versions) and the name.
    pub fn history(&self, path: &str, version: &McVersion) -> Vec<(Option<McVersion>, String)> {
        let oldest = McVersion::parse("1.6.1").unwrap();
        let start = self
            .map(path, version, &oldest)
            .into_iter()
            .next()
            .unwrap_or_else(|| path.to_owned());
        let mut out = vec![(None, start.clone())];
        let mut current = start;
        for step in &self.steps {
            match step.apply_forward(&current) {
                Some(next) => {
                    if next != current {
                        out.push((Some(step.version.clone()), next.clone()));
                        current = next;
                    }
                }
                None => break,
            }
        }
        // If the walk forward never reaches the given name, the texture is newer
        // than the first entry: report just the given name.
        if !out.iter().any(|(_, n)| n == path) {
            return vec![(None, path.to_owned())];
        }
        out
    }
}

impl Step {
    fn apply_forward(&self, path: &str) -> Option<String> {
        if self.removed.contains(path) {
            return None;
        }
        if let Some(new) = self.forward.get(path) {
            return Some(new.clone());
        }
        Some(swap_folder(path, &self.folders))
    }

    fn apply_backward(&self, path: &str) -> Vec<String> {
        if let Some(old) = self.backward.get(path) {
            return old.clone();
        }
        vec![swap_folder(path, &self.folders_back)]
    }

    pub fn file_count(&self) -> usize {
        self.forward.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }
    fn t() -> &'static RenameTable {
        RenameTable::builtin()
    }

    #[test]
    fn flattening_examples_from_the_design() {
        assert_eq!(
            t().map("blocks/planks_oak", &v("1.12.2"), &v("1.13")),
            ["block/oak_planks"]
        );
        assert_eq!(
            t().map("blocks/grass_top", &v("1.8.9"), &v("1.21.4")),
            ["block/grass_block_top"]
        );
        assert_eq!(
            t().map("block/oak_planks", &v("1.21.4"), &v("1.12.2")),
            ["blocks/planks_oak"]
        );
        assert_eq!(
            t().map("block/grass_block_top", &v("1.20.1"), &v("1.8.9")),
            ["blocks/grass_top"]
        );
    }

    #[test]
    fn folder_only_renames() {
        assert_eq!(
            t().map("blocks/stone", &v("1.12.2"), &v("1.13")),
            ["block/stone"]
        );
        assert_eq!(
            t().map("item/diamond", &v("1.20.1"), &v("1.12.2")),
            ["items/diamond"]
        );
        assert_eq!(
            t().map("entity/creeper/creeper", &v("1.20.1"), &v("1.8.9")),
            ["entity/creeper/creeper"]
        );
        assert_eq!(
            t().map("gui/widgets", &v("1.8.9"), &v("1.12.2")),
            ["gui/widgets"]
        );
    }

    #[test]
    fn same_era_is_identity() {
        assert_eq!(
            t().map("block/oak_planks", &v("1.20.1"), &v("1.20.1")),
            ["block/oak_planks"]
        );
        assert_eq!(
            t().map("blocks/planks_oak", &v("1.8.9"), &v("1.12.2")),
            ["blocks/planks_oak"]
        );
        assert!(!t().is_renamed("block/stone", &v("1.13"), &v("1.21.11")));
        assert!(t().is_renamed("block/stone", &v("1.13"), &v("1.12.2")));
    }

    #[test]
    fn multi_step_chains() {
        // 1.12 dye -> 1.13 rose_red -> 1.14 red_dye
        assert_eq!(
            t().map("items/dye_powder_red", &v("1.12.2"), &v("1.13.2")),
            ["item/rose_red"]
        );
        assert_eq!(
            t().map("items/dye_powder_red", &v("1.12.2"), &v("1.21.4")),
            ["item/red_dye"]
        );
        assert_eq!(
            t().map("item/red_dye", &v("1.21.4"), &v("1.8.9")),
            ["items/dye_powder_red"]
        );
        // tallgrass -> grass (1.13) -> short_grass (1.20.3)
        assert_eq!(
            t().map("blocks/tallgrass", &v("1.8.9"), &v("1.20.1")),
            ["block/grass"]
        );
        assert_eq!(
            t().map("blocks/tallgrass", &v("1.8.9"), &v("1.20.4")),
            ["block/short_grass"]
        );
        assert_eq!(
            t().map("block/short_grass", &v("1.21.4"), &v("1.20.1")),
            ["block/grass"]
        );
        // grass path (1.17)
        assert_eq!(
            t().map("block/dirt_path_top", &v("1.21.4"), &v("1.16.5")),
            ["block/grass_path_top"]
        );
    }

    #[test]
    fn modern_renames_seen_in_real_jars() {
        assert_eq!(
            t().map("item/scute", &v("1.20.4"), &v("1.21.1")),
            ["item/turtle_scute"]
        );
        assert_eq!(
            t().map("models/armor/diamond_layer_1", &v("1.21.1"), &v("1.21.5")),
            ["entity/equipment/humanoid/diamond"]
        );
        assert_eq!(
            t().map("block/iron_chain", &v("1.21.11"), &v("1.21.8")),
            ["block/chain"]
        );
        assert_eq!(
            t().map(
                "entity/chicken/temperate_chicken",
                &v("1.21.5"),
                &v("1.21.4")
            ),
            ["entity/chicken"]
        );
    }

    #[test]
    fn removed_textures_map_to_nothing() {
        assert!(t()
            .map("blocks/bed_head_top", &v("1.8.9"), &v("1.13"))
            .is_empty());
        assert!(t()
            .map("items/quiver", &v("1.8.9"), &v("1.21.4"))
            .is_empty());
    }

    #[test]
    fn colours_and_silver() {
        assert_eq!(
            t().map("blocks/wool_colored_silver", &v("1.12.2"), &v("1.13")),
            ["block/light_gray_wool"]
        );
        assert_eq!(
            t().map("block/light_gray_concrete", &v("1.20.1"), &v("1.12.2")),
            ["blocks/concrete_silver"]
        );
        assert_eq!(
            t().map("blocks/hardened_clay_stained_red", &v("1.8.9"), &v("1.13")),
            ["block/red_terracotta"]
        );
        assert_eq!(
            t().map("blocks/log_big_oak", &v("1.8.9"), &v("1.13")),
            ["block/dark_oak_log"]
        );
    }

    #[test]
    fn round_trip_every_flattening_entry() {
        let flat = &t().steps()[0];
        assert_eq!(flat.id, "flattening");
        assert!(
            flat.file_count() > 400,
            "table looks truncated: {}",
            flat.file_count()
        );
        let (old_v, new_v) = (v("1.12.2"), v("1.13"));
        for (old, new) in &flat.forward {
            assert!(
                old.starts_with("blocks/") || old.starts_with("items/"),
                "{old}"
            );
            assert!(
                new.starts_with("block/") || new.starts_with("item/"),
                "{new}"
            );
            assert_eq!(t().map(old, &old_v, &new_v), std::slice::from_ref(new));
            assert!(
                t().map(new, &new_v, &old_v).contains(old),
                "{new} does not map back to {old}"
            );
        }
    }

    #[test]
    fn data_is_consistent() {
        let mut last = None;
        for s in t().steps() {
            if let Some(prev) = &last {
                assert!(
                    prev < &s.version,
                    "steps must have distinct, increasing versions"
                );
            }
            last = Some(s.version.clone());
            for (old, new) in &s.forward {
                assert_ne!(old, new, "identity entry in {}", s.id);
                assert!(!old.ends_with(".png") && !new.ends_with(".png"));
                assert!(!old.contains('\\') && !new.contains('\\'));
                assert!(
                    !s.removed.contains(old),
                    "{old} is both renamed and removed"
                );
            }
        }
        // only these new names are allowed to have several old names
        let flat = &t().steps()[0];
        let merged = ["block/redstone_dust_overlay"];
        for (new, olds) in &flat.backward {
            if merged.contains(&new.as_str()) {
                assert_eq!(olds.len(), 2);
                continue;
            }
            assert_eq!(olds.len(), 1, "{new} has several old names: {olds:?}");
        }
        // going back in time, a merged texture is written under every old name
        assert_eq!(
            t().map("block/redstone_dust_overlay", &v("1.20.1"), &v("1.8.9")),
            [
                "blocks/redstone_dust_cross_overlay",
                "blocks/redstone_dust_line_overlay"
            ]
        );
    }

    #[test]
    fn history_for_inspector() {
        let h = t().history("block/oak_planks", &v("1.21.4"));
        assert_eq!(
            h,
            vec![
                (None, "blocks/planks_oak".to_owned()),
                (Some(v("1.13")), "block/oak_planks".to_owned())
            ]
        );
        let h = t().history("item/red_dye", &v("1.21.4"));
        let names: Vec<&str> = h.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(
            names,
            ["items/dye_powder_red", "item/rose_red", "item/red_dye"]
        );
        // same texture asked from the old side gives the same history
        assert_eq!(t().history("items/dye_powder_red", &v("1.8.9")), h);
        // never renamed, only the folder changed
        let h = t().history("block/stone", &v("1.20.1"));
        assert_eq!(h.len(), 2);
        // not affected at all
        assert_eq!(t().history("entity/creeper/creeper", &v("1.20.1")).len(), 1);
    }
}

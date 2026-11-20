//! App settings and the list of recent packs, stored as JSON in the app data folder.

use crate::error::{IoCtx, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_RECENT: usize = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentPack {
    pub path: String,
    pub name: String,
    pub version: String,
    pub resolution: u32,
    pub opened_ms: u64,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// `None` = the default folder for this system.
    pub minecraft_dir: Option<String>,
    /// Program used by "Open externally". `None` = the system default for PNG.
    pub external_editor: Option<String>,
    /// Where exports go. `None` = an `export` folder next to the pack.
    pub export_dir: Option<String>,
    /// Folder suggested for new packs.
    pub packs_dir: Option<String>,
    pub recent: Vec<RecentPack>,
    pub last_pack: Option<String>,
    pub export_kind_folder: bool,
    pub export_install: bool,
    pub export_only_changed: bool,
    /// "Make PNG files smaller (same pixels)" on the export screen.
    pub export_optimize: bool,
    /// How a game texture is enlarged when a texture is started from it at
    /// 32× or more: hard pixels (default) or Scale2x / Scale3x.
    pub upscale: crate::upscale::Upscale,
    /// The welcome window shown at the first start was closed.
    pub welcome_seen: bool,
}

pub fn settings_file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Loads the settings. A missing or damaged file gives the defaults (the
/// damaged file is kept aside as `settings.broken.json`).
pub fn load(config_dir: &Path) -> Settings {
    let file = settings_file(config_dir);
    let Ok(text) = fs::read_to_string(&file) else {
        return Settings::default();
    };
    match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(_) => {
            let _ = fs::rename(&file, config_dir.join("settings.broken.json"));
            Settings::default()
        }
    }
}

pub fn save(config_dir: &Path, settings: &Settings) -> Result<()> {
    fs::create_dir_all(config_dir).ctx(config_dir)?;
    let file = settings_file(config_dir);
    let tmp = file.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(settings).expect("settings serialise"),
    )
    .ctx(&tmp)?;
    fs::rename(&tmp, &file).ctx(&file)
}

impl Settings {
    /// Puts a pack at the top of the recent list (one entry per folder).
    pub fn touch_recent(&mut self, pack: RecentPack) {
        let key = pack.path.to_lowercase();
        self.recent.retain(|r| r.path.to_lowercase() != key);
        self.last_pack = Some(pack.path.clone());
        self.recent.insert(0, pack);
        self.recent.truncate(MAX_RECENT);
    }

    pub fn forget_recent(&mut self, path: &str) {
        let key = path.to_lowercase();
        self.recent.retain(|r| r.path.to_lowercase() != key);
        if self.last_pack.as_deref().map(str::to_lowercase) == Some(key) {
            self.last_pack = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recent(path: &str, t: u64) -> RecentPack {
        RecentPack {
            path: path.into(),
            name: "n".into(),
            version: "1.21.4".into(),
            resolution: 32,
            opened_ms: t,
            done: 1,
            total: 10,
        }
    }

    #[test]
    fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("config");
        assert_eq!(load(&dir), Settings::default());
        let mut s = Settings {
            external_editor: Some("C:\\Aseprite\\Aseprite.exe".into()),
            export_install: true,
            ..Default::default()
        };
        s.touch_recent(recent("D:\\Packs\\A", 1));
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
        assert!(!settings_file(&dir).with_extension("json.tmp").exists());
    }

    #[test]
    fn damaged_file_falls_back_to_defaults_and_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(settings_file(tmp.path()), "{ not json").unwrap();
        assert_eq!(load(tmp.path()), Settings::default());
        assert!(tmp.path().join("settings.broken.json").is_file());
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            settings_file(tmp.path()),
            r#"{"external_editor":"x","from_the_future":1}"#,
        )
        .unwrap();
        let s = load(tmp.path());
        assert_eq!(s.external_editor.as_deref(), Some("x"));
        assert!(s.recent.is_empty());
    }

    #[test]
    fn recent_list_is_unique_ordered_and_capped() {
        let mut s = Settings::default();
        for i in 0..20 {
            s.touch_recent(recent(&format!("D:\\Packs\\P{i}"), i));
        }
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0].path, "D:\\Packs\\P19");
        s.touch_recent(recent("d:\\packs\\p15", 99));
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0].opened_ms, 99);
        assert_eq!(
            s.recent
                .iter()
                .filter(|r| r.path.to_lowercase() == "d:\\packs\\p15")
                .count(),
            1
        );
        assert_eq!(s.last_pack.as_deref(), Some("d:\\packs\\p15"));
        s.forget_recent("D:\\PACKS\\P15");
        assert!(s.last_pack.is_none());
        assert_eq!(s.recent.len(), MAX_RECENT - 1);
    }
}

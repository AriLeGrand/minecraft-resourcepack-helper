//! Notes, tags and "assigned to" per texture, so a team can organise a pack.
//!
//! Stored in `.packcreator/notes.json` (never exported). The file is replaced
//! in one step (temporary file + rename), so a crash never leaves half a file.
//! A missing file is an empty list; a damaged one is renamed to
//! `notes.damaged-<time>.json` (kept, never thrown away) and the pack starts
//! with an empty list, which the UI reports once.

use crate::error::{CoreError, IoCtx, Result};
use crate::pack::{now_ms, PROJECT_DIR};
use crate::textures::is_safe_texture_path;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Changes are read-modify-write: one at a time in this process.
static WRITE: Mutex<()> = Mutex::new(());

pub const NOTES_FILE: &str = "notes.json";
pub const NOTES_SCHEMA: u32 = 1;
/// Longest note kept (characters); a longer text is cut.
const MAX_NOTE: usize = 4000;
/// Longest tag or name (characters).
const MAX_WORD: usize = 40;
const MAX_TAGS: usize = 12;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextureNote {
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Who does it ("" = nobody yet).
    #[serde(default)]
    pub assignee: String,
    #[serde(default)]
    pub updated_ms: u64,
}

impl TextureNote {
    pub fn is_empty(&self) -> bool {
        self.note.is_empty() && self.tags.is_empty() && self.assignee.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotesFile {
    pub schema: u32,
    /// Texture path → its note. Sorted, so the file diffs well in git.
    #[serde(default)]
    pub textures: BTreeMap<String, TextureNote>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadedNotes {
    pub notes: NotesFile,
    /// Set when a damaged file was moved aside (where it is now).
    pub damaged_kept: Option<String>,
}

pub fn notes_file(pack_dir: &Path) -> PathBuf {
    pack_dir.join(PROJECT_DIR).join(NOTES_FILE)
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// One line, single spaces, no surrounding spaces, at most `MAX_WORD` characters.
fn clean_word(s: &str) -> String {
    cut(
        &s.split_whitespace().collect::<Vec<_>>().join(" "),
        MAX_WORD,
    )
}

/// Trims everything and drops empty / duplicate tags (case-insensitive, the
/// first spelling wins).
pub fn normalize(n: &TextureNote) -> TextureNote {
    let mut tags: Vec<String> = Vec::new();
    for t in &n.tags {
        let t = clean_word(t);
        if !t.is_empty()
            && tags.len() < MAX_TAGS
            && !tags.iter().any(|x| x.to_lowercase() == t.to_lowercase())
        {
            tags.push(t);
        }
    }
    let note = n.note.replace("\r\n", "\n");
    TextureNote {
        note: cut(note.trim(), MAX_NOTE),
        tags,
        assignee: clean_word(&n.assignee),
        updated_ms: n.updated_ms,
    }
}

/// Reads the notes of a pack. Missing file = empty; damaged file = moved aside.
pub fn load(pack_dir: &Path) -> Result<LoadedNotes> {
    let file = notes_file(pack_dir);
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedNotes {
                notes: NotesFile {
                    schema: NOTES_SCHEMA,
                    textures: BTreeMap::new(),
                },
                damaged_kept: None,
            })
        }
        Err(e) => return Err(CoreError::io(&file, &e)),
    };
    match serde_json::from_str::<NotesFile>(&text) {
        Ok(mut n) => {
            n.schema = NOTES_SCHEMA;
            n.textures = n
                .textures
                .into_iter()
                .filter(|(k, _)| is_safe_texture_path(k))
                .map(|(k, v)| (k, normalize(&v)))
                .filter(|(_, v)| !v.is_empty())
                .collect();
            Ok(LoadedNotes {
                notes: n,
                damaged_kept: None,
            })
        }
        Err(_) => {
            let kept = file.with_file_name(format!("notes.damaged-{}.json", now_ms()));
            fs::rename(&file, &kept).ctx(&file)?;
            Ok(LoadedNotes {
                notes: NotesFile {
                    schema: NOTES_SCHEMA,
                    textures: BTreeMap::new(),
                },
                damaged_kept: Some(kept.to_string_lossy().into_owned()),
            })
        }
    }
}

/// Writes the whole file in one step.
pub fn save(pack_dir: &Path, notes: &NotesFile) -> Result<()> {
    let file = notes_file(pack_dir);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let tmp = file.with_file_name(format!("{NOTES_FILE}.tmp"));
    let text = serde_json::to_string_pretty(notes).expect("notes serialise");
    fs::write(&tmp, text + "\n").ctx(&tmp)?;
    fs::rename(&tmp, &file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CoreError::io(&file, &e)
    })
}

/// Sets (or, when empty, removes) the note of one texture and saves.
/// Returns the stored note.
pub fn set(pack_dir: &Path, tex_path: &str, note: &TextureNote) -> Result<TextureNote> {
    if !is_safe_texture_path(tex_path) {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{tex_path}\" is not a valid texture name."),
        ));
    }
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut loaded = load(pack_dir)?;
    let mut n = normalize(note);
    n.updated_ms = now_ms();
    if n.is_empty() {
        loaded.notes.textures.remove(tex_path);
    } else {
        loaded.notes.textures.insert(tex_path.to_owned(), n.clone());
    }
    save(pack_dir, &loaded.notes)?;
    Ok(n)
}

/// A texture was renamed (the export check's "Rename" fix): its note follows.
/// A note already on the new name is kept (nothing is overwritten).
pub fn rename(pack_dir: &Path, from: &str, to: &str) -> Result<bool> {
    if !notes_file(pack_dir).is_file() {
        return Ok(false);
    }
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut loaded = load(pack_dir)?;
    let t = &mut loaded.notes.textures;
    if t.contains_key(to) || !t.contains_key(from) {
        return Ok(false);
    }
    let n = t.remove(from).expect("checked");
    t.insert(to.to_owned(), n);
    save(pack_dir, &loaded.notes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(text: &str, tags: &[&str], who: &str) -> TextureNote {
        TextureNote {
            note: text.into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            assignee: who.into(),
            updated_ms: 0,
        }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        let tmp = tempfile::tempdir().unwrap();
        let l = load(tmp.path()).unwrap();
        assert!(l.notes.textures.is_empty() && l.damaged_kept.is_none());
    }

    #[test]
    fn set_cleans_saves_and_removes() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let n = set(
            pack,
            "block/stone",
            &note(
                "  darker edges \r\n please ",
                &[" needs  redo", "Needs redo", "", "waiting feedback"],
                "  Alex  ",
            ),
        )
        .unwrap();
        assert_eq!(n.note, "darker edges \n please");
        assert_eq!(n.tags, vec!["needs redo", "waiting feedback"]);
        assert_eq!(n.assignee, "Alex");
        assert!(n.updated_ms > 0);
        set(pack, "item/apple", &note("", &[], "Sam")).unwrap();
        let l = load(pack).unwrap();
        assert_eq!(l.notes.textures.len(), 2);
        assert_eq!(l.notes.textures["block/stone"], n);
        assert!(!notes_file(pack).with_file_name("notes.json.tmp").exists());
        // emptying a note removes the entry
        set(pack, "item/apple", &TextureNote::default()).unwrap();
        assert_eq!(load(pack).unwrap().notes.textures.len(), 1);
        assert_eq!(
            set(pack, "../x", &note("a", &[], "")).unwrap_err().kind,
            "bad_path"
        );
    }

    #[test]
    fn a_damaged_file_is_kept_aside_not_thrown_away() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let f = notes_file(pack);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, "{ this is not json").unwrap();
        let l = load(pack).unwrap();
        assert!(l.notes.textures.is_empty());
        let kept = PathBuf::from(l.damaged_kept.unwrap());
        assert_eq!(fs::read_to_string(&kept).unwrap(), "{ this is not json");
        assert!(!f.exists());
        // the next save starts a fresh file; the damaged one stays
        set(pack, "block/dirt", &note("x", &[], "")).unwrap();
        assert!(kept.is_file() && f.is_file());
    }

    #[test]
    fn unknown_fields_and_bad_keys_are_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let f = notes_file(pack);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(
            &f,
            r#"{"schema":1,"future":true,"textures":{"block/a":{"note":"hi","colour":"red"},"../evil":{"note":"x"},"block/b":{}}}"#,
        )
        .unwrap();
        let l = load(pack).unwrap();
        assert_eq!(l.notes.textures.keys().collect::<Vec<_>>(), vec!["block/a"]);
        assert_eq!(l.notes.textures["block/a"].note, "hi");
    }

    #[test]
    fn rename_carries_the_note_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        assert!(!rename(pack, "a/x", "a/y").unwrap());
        set(pack, "blocks/stone", &note("old name", &[], "")).unwrap();
        set(pack, "blocks/dirt", &note("dirt", &[], "")).unwrap();
        set(pack, "block/dirt", &note("already here", &[], "")).unwrap();
        assert!(rename(pack, "blocks/stone", "block/stone").unwrap());
        assert!(!rename(pack, "blocks/dirt", "block/dirt").unwrap());
        let t = load(pack).unwrap().notes.textures;
        assert_eq!(t["block/stone"].note, "old name");
        assert_eq!(t["block/dirt"].note, "already here");
        assert_eq!(t["blocks/dirt"].note, "dirt");
        assert!(!t.contains_key("blocks/stone"));
    }
}

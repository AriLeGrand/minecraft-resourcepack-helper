//! Saving a shared to-do list (text the UI has formatted) to a file the user
//! picked. Only plain text formats are allowed, and the file is replaced in
//! one step so a failed write never leaves half a file.

use crate::error::{CoreError, IoCtx, Result};
use std::fs;
use std::path::Path;

const ALLOWED: [&str; 3] = ["md", "txt", "csv"];

pub fn write_list(path: &Path, text: &str) -> Result<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !path.is_absolute() || !ALLOWED.contains(&ext.as_str()) {
        return Err(CoreError::new(
            "bad_path",
            format!(
                "The list can only be saved as a .md, .txt or .csv file, not {}.",
                path.display()
            ),
        )
        .hint("Choose a file name ending in .md, .txt or .csv."));
    }
    let tmp = path.with_extension(format!("{ext}.tmp"));
    fs::write(&tmp, text.as_bytes()).ctx(&tmp)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CoreError::io(path, &e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_text_files() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("Deep Sea Pack to-do list.md");
        write_list(&f, "# one\n").unwrap();
        write_list(&f, "# two\n- [ ] stone\n").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "# two\n- [ ] stone\n");
        assert!(!f.with_extension("md.tmp").exists());
        write_list(&tmp.path().join("list.CSV"), "a,b\r\n").unwrap();
    }

    #[test]
    fn refuses_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["list.png", "list.exe", "list", "pack.mcmeta"] {
            let e = write_list(&tmp.path().join(name), "x").unwrap_err();
            assert_eq!(e.kind, "bad_path", "{name}");
        }
        assert_eq!(
            write_list(Path::new("relative.md"), "x").unwrap_err().kind,
            "bad_path"
        );
    }
}

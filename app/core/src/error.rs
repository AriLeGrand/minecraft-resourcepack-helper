//! One error type for the whole core: a clear message and what to do about it.

use serde::Serialize;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CoreError {
    /// Stable machine-readable kind, e.g. `no_jar`, `corrupt_jar`, `read_only`.
    pub kind: String,
    /// What went wrong, in plain words.
    pub message: String,
    /// What the user can do about it.
    pub hint: Option<String>,
}

pub type Result<T> = std::result::Result<T, CoreError>;

impl CoreError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            message: message.into(),
            hint: None,
        }
    }
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    /// Wraps an I/O error with the path it happened on.
    pub fn io(path: &Path, e: &io::Error) -> Self {
        let p = path.display();
        match e.kind() {
            io::ErrorKind::PermissionDenied => Self::new("read_only", format!("Windows refused access to {p}."))
                .hint("The folder may be read-only, or the file is open in another program. Close it or pick another folder, then try again."),
            io::ErrorKind::NotFound => Self::new("not_found", format!("{p} was not found.")),
            _ => Self::new("io", format!("Could not read or write {p}: {e}")),
        }
    }
}

/// `fs` call + path context in one line.
pub(crate) trait IoCtx<T> {
    fn ctx(self, path: &Path) -> Result<T>;
}

impl<T> IoCtx<T> for io::Result<T> {
    fn ctx(self, path: &Path) -> Result<T> {
        self.map_err(|e| CoreError::io(path, &e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_and_missing_files_give_clear_messages() {
        let p = Path::new("D:/Packs/x");
        let e = CoreError::io(p, &io::Error::from(io::ErrorKind::PermissionDenied));
        assert_eq!(e.kind, "read_only");
        assert!(e.hint.unwrap().contains("read-only"));
        let e = CoreError::io(p, &io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(e.kind, "not_found");
        assert!(e.message.contains("D:/Packs/x"));
    }
}

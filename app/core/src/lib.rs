//! Pack Creator core.
//!
//! Everything that must be correct lives here, with unit tests and without any
//! dependency on the UI: Minecraft versions, pack formats, texture renames,
//! the legacy particle sheet, and (in later modules) paths, `.mcmeta` files,
//! import and export.

pub mod pack_format;
pub mod particles;
pub mod renames;
pub mod version;

pub use pack_format::PackFormat;
pub use version::McVersion;

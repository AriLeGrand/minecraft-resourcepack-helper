//! Pack Creator core.
//!
//! Everything that must be correct lives here, with unit tests and without any
//! dependency on the UI: Minecraft versions, pack formats, texture renames,
//! the legacy particle sheet, jar extraction, the texture index, `.mcmeta`
//! files, packs, import and export.

pub mod batch;
pub mod error;
pub mod export;
pub mod extract;
pub mod gui;
pub mod gui_screens;
pub mod import;
pub mod mcmeta;
pub mod minecraft;
pub mod models;
pub mod pack;
pub mod pack_format;
pub mod particle_list;
pub mod particles;
pub mod renames;
pub mod rows;
pub mod settings;
pub mod share;
pub mod textures;
pub mod version;
pub mod whats_new;
pub mod workfile;
// drawing helpers: pack palette, recolouring, variants, smooth start, seams
pub mod palette;
pub mod recolor;
pub mod seams;
pub mod upscale;

pub use error::{CoreError, Result};
pub use pack_format::PackFormat;
pub use version::McVersion;

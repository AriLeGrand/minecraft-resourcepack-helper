//! Bringing images into the pack without ever altering them, and undoing.
//!
//! Rules: an imported image keeps its exact pixels (a PNG is copied byte for
//! byte); nothing the user made is ever deleted, replaced files go to
//! `.packcreator/trash/`.

use crate::error::{CoreError, IoCtx, Result};
use crate::mcmeta::{self, Animation};
use crate::pack::{now_ms, PROJECT_DIR};
use crate::textures::{category_of, mcmeta_file, png_dimensions, texture_file, Category};
use crate::upscale::{self, Upscale};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub is_png: bool,
    /// Set when the image is tall and its height is a whole multiple of its
    /// width: it can be used as animation frames.
    pub strip_frames: Option<u32>,
}

/// Looks at an image file chosen by the user, without changing anything.
pub fn inspect_image(src: &Path) -> Result<ImageInfo> {
    let data = fs::read(src).ctx(src)?;
    let (width, height, is_png) = match png_dimensions(&data) {
        Some((w, h)) => (w, h, true),
        None => {
            let img = image::load_from_memory(&data).map_err(|_| {
                CoreError::new(
                    "bad_image",
                    format!("{} is not an image this app can read.", src.display()),
                )
                .hint("Use a PNG file (JPEG, BMP and GIF also work and are converted to PNG).")
            })?;
            (img.width(), img.height(), false)
        }
    };
    Ok(ImageInfo {
        width,
        height,
        is_png,
        strip_frames: mcmeta::strip_frames(width, height),
    })
}

/// Moves a pack file into the trash folder instead of deleting it.
/// Returns where it went, or `None` when the file did not exist.
pub fn move_to_trash(pack_dir: &Path, file: &Path, stamp: u64) -> Result<Option<PathBuf>> {
    if !file.exists() {
        return Ok(None);
    }
    let rel = file
        .strip_prefix(pack_dir)
        .unwrap_or_else(|_| Path::new(file.file_name().unwrap_or_default()));
    let dest = pack_dir
        .join(PROJECT_DIR)
        .join("trash")
        .join(stamp.to_string())
        .join(rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    fs::rename(file, &dest).ctx(file)?;
    Ok(Some(dest))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportResult {
    pub info: ImageInfo,
    /// True when the source was not a PNG and was converted (same pixels).
    pub converted: bool,
    /// True when an existing pack file was moved to the trash.
    pub replaced: bool,
    /// True when an animation `.mcmeta` was written.
    pub wrote_mcmeta: bool,
}

/// Imports `src` as the texture `tex_path`. The image is never resized.
/// With `animation`, a `.png.mcmeta` is written (an existing one is kept and
/// only its animation section updated).
pub fn import_image(
    pack_dir: &Path,
    tex_path: &str,
    src: &Path,
    animation: Option<&Animation>,
) -> Result<ImportResult> {
    let info = inspect_image(src)?;
    let dest = texture_file(pack_dir, tex_path)?;
    let data = fs::read(src).ctx(src)?;
    let bytes = if info.is_png {
        data
    } else {
        let img = image::load_from_memory(&data).map_err(|_| {
            CoreError::new("bad_image", format!("{} could not be read.", src.display()))
        })?;
        let mut out = Vec::new();
        img.to_rgba8()
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| {
                CoreError::new(
                    "bad_image",
                    format!("The image could not be converted to PNG: {e}"),
                )
            })?;
        out
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let same_file = fs::canonicalize(src)
        .ok()
        .is_some_and(|s| fs::canonicalize(&dest).ok() == Some(s));
    let mut replaced = false;
    if !same_file {
        replaced = move_to_trash(pack_dir, &dest, now_ms())?.is_some();
        fs::write(&dest, &bytes).ctx(&dest)?;
    }
    let mut wrote_mcmeta = false;
    if let Some(anim) = animation {
        let meta = mcmeta_file(&dest);
        let existing = fs::read_to_string(&meta).ok();
        let text = mcmeta::write_animation(existing.as_deref(), anim)
            .or_else(|_| mcmeta::write_animation(None, anim))?;
        fs::write(&meta, text).ctx(&meta)?;
        wrote_mcmeta = true;
    }
    Ok(ImportResult {
        converted: !info.is_png,
        info,
        replaced,
        wrote_mcmeta,
    })
}

/// Makes sure the pack has a working file for `tex_path` and returns it.
/// If the pack has none yet, the vanilla texture is copied, enlarged by
/// `scale` with hard pixels (no blur) so it matches the pack resolution.
/// An existing pack file is never touched.
pub fn start_from_vanilla(
    vanilla_root: &Path,
    pack_dir: &Path,
    tex_path: &str,
    scale: u32,
) -> Result<PathBuf> {
    start_from_vanilla_with(vanilla_root, pack_dir, tex_path, scale, Upscale::Nearest)
}

/// The game's texture enlarged by `scale` with `method` (animation frames one
/// by one; block textures are treated as tiling for the smooth method).
pub fn vanilla_at_scale(
    vanilla_root: &Path,
    tex_path: &str,
    scale: u32,
    method: Upscale,
) -> Result<image::RgbaImage> {
    let src = texture_file(vanilla_root, tex_path)?;
    if !src.is_file() {
        return Err(CoreError::new(
            "not_found",
            format!("The game has no texture called {tex_path} in this version."),
        ));
    }
    let img = image::open(&src)
        .map_err(|e| CoreError::new("bad_image", format!("{}: {e}", src.display())))?
        .to_rgba8();
    let anim = fs::read_to_string(mcmeta_file(&src))
        .ok()
        .and_then(|t| mcmeta::parse_animation(&t).ok().flatten());
    let frame_h = match &anim {
        Some(a) => mcmeta::frame_height(img.width(), img.height(), Some(a)),
        None => img.height(),
    };
    let wrap = category_of(tex_path) == Category::Blocks;
    Ok(upscale::enlarge_strip(&img, frame_h, scale, method, wrap))
}

/// [`start_from_vanilla`] with a choice of enlargement: hard pixels or the
/// smooth Scale2x / Scale3x family (see [`crate::upscale`]).
pub fn start_from_vanilla_with(
    vanilla_root: &Path,
    pack_dir: &Path,
    tex_path: &str,
    scale: u32,
    method: Upscale,
) -> Result<PathBuf> {
    let dest = texture_file(pack_dir, tex_path)?;
    if dest.exists() {
        return Ok(dest);
    }
    let src = texture_file(vanilla_root, tex_path)?;
    if !src.is_file() {
        return Err(CoreError::new(
            "not_found",
            format!("The game has no texture called {tex_path} in this version."),
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    if scale <= 1 {
        fs::copy(&src, &dest).ctx(&dest)?;
    } else {
        let big = vanilla_at_scale(vanilla_root, tex_path, scale, method)?;
        big.save_with_format(&dest, image::ImageFormat::Png)
            .map_err(|e| {
                CoreError::new("io", format!("Could not write {}: {e}", dest.display()))
            })?;
    }
    let src_meta = mcmeta_file(&src);
    if src_meta.is_file() {
        let dest_meta = mcmeta_file(&dest);
        if !dest_meta.exists() {
            fs::copy(&src_meta, &dest_meta).ctx(&dest_meta)?;
        }
    }
    Ok(dest)
}

/// Removes a texture from the pack (back to vanilla). The files go to the
/// trash folder. Returns false when there was nothing to remove.
pub fn revert(pack_dir: &Path, tex_path: &str) -> Result<bool> {
    let file = texture_file(pack_dir, tex_path)?;
    let stamp = now_ms();
    let a = move_to_trash(pack_dir, &file, stamp)?.is_some();
    let b = move_to_trash(pack_dir, &mcmeta_file(&file), stamp)?.is_some();
    Ok(a || b)
}

/// Writes a default animation file for a tall texture that has none.
pub fn create_animation_mcmeta(pack_dir: &Path, tex_path: &str, frametime: u32) -> Result<PathBuf> {
    let file = texture_file(pack_dir, tex_path)?;
    if !file.is_file() {
        return Err(CoreError::new(
            "not_found",
            format!("{tex_path} is not in the pack."),
        ));
    }
    let meta = mcmeta_file(&file);
    let existing = fs::read_to_string(&meta).ok();
    let anim = Animation {
        frametime: frametime.max(1),
        ..Default::default()
    };
    fs::write(&meta, mcmeta::write_animation(existing.as_deref(), &anim)?).ctx(&meta)?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 30, 30]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        out
    }

    #[test]
    fn png_is_imported_byte_for_byte_at_any_size() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("my drawing.png");
        // deliberately "wrong" size: it must not be resized
        let bytes = png(37, 21, 4);
        fs::write(&src, &bytes).unwrap();
        let r = import_image(&pack, "block/oak_planks", &src, None).unwrap();
        assert_eq!((r.info.width, r.info.height), (37, 21));
        assert!(!r.converted && !r.replaced && !r.wrote_mcmeta);
        let dest = texture_file(&pack, "block/oak_planks").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        // the source is untouched
        assert_eq!(fs::read(&src).unwrap(), bytes);
    }

    #[test]
    fn other_formats_are_converted_without_resizing() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("photo.jpg");
        fs::write(&src, jpeg(48, 48)).unwrap();
        let r = import_image(&pack, "item/diamond", &src, None).unwrap();
        assert!(r.converted);
        let out = fs::read(texture_file(&pack, "item/diamond").unwrap()).unwrap();
        assert_eq!(png_dimensions(&out), Some((48, 48)));
    }

    #[test]
    fn tall_image_is_offered_as_frames_and_gets_an_mcmeta() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("strip.png");
        fs::write(&src, png(32, 192, 2)).unwrap();
        assert_eq!(inspect_image(&src).unwrap().strip_frames, Some(6));
        // without the user's yes, no mcmeta is created
        import_image(&pack, "block/prismarine", &src, None).unwrap();
        let dest = texture_file(&pack, "block/prismarine").unwrap();
        assert!(!mcmeta_file(&dest).exists());
        // with it, the image is still identical and the animation is written
        let anim = Animation {
            frametime: 2,
            ..Default::default()
        };
        let r = import_image(&pack, "block/prismarine", &src, Some(&anim)).unwrap();
        assert!(r.wrote_mcmeta && r.replaced);
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&src).unwrap());
        let text = fs::read_to_string(mcmeta_file(&dest)).unwrap();
        assert_eq!(
            mcmeta::parse_animation(&text).unwrap().unwrap().frametime,
            2
        );
    }

    #[test]
    fn replacing_keeps_the_old_file_in_the_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let (a, b) = (tmp.path().join("a.png"), tmp.path().join("b.png"));
        fs::write(&a, png(16, 16, 1)).unwrap();
        fs::write(&b, png(16, 16, 2)).unwrap();
        import_image(&pack, "block/stone", &a, None).unwrap();
        let r = import_image(&pack, "block/stone", &b, None).unwrap();
        assert!(r.replaced);
        let trash = pack.join(PROJECT_DIR).join("trash");
        let kept: Vec<_> = walkdir::WalkDir::new(&trash)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(kept[0].path()).unwrap(), png(16, 16, 1));
    }

    #[test]
    fn importing_a_file_onto_itself_is_harmless() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let dest = texture_file(&pack, "block/stone").unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, png(16, 16, 1)).unwrap();
        let r = import_image(&pack, "block/stone", &dest, None).unwrap();
        assert!(!r.replaced);
        assert_eq!(fs::read(&dest).unwrap(), png(16, 16, 1));
    }

    #[test]
    fn bad_inputs() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let txt = tmp.path().join("notes.txt");
        fs::write(&txt, "hello").unwrap();
        assert_eq!(
            import_image(&pack, "block/stone", &txt, None)
                .unwrap_err()
                .kind,
            "bad_image"
        );
        assert_eq!(
            import_image(&pack, "block/stone", &tmp.path().join("missing.png"), None)
                .unwrap_err()
                .kind,
            "not_found"
        );
        let ok = tmp.path().join("ok.png");
        fs::write(&ok, png(16, 16, 1)).unwrap();
        assert_eq!(
            import_image(&pack, "../outside", &ok, None)
                .unwrap_err()
                .kind,
            "bad_path"
        );
        assert!(!tmp.path().join("outside.png").exists());
    }

    #[test]
    fn start_from_vanilla_scales_with_hard_pixels_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("vanilla"), tmp.path().join("pack"));
        let v = texture_file(&vanilla, "block/prismarine").unwrap();
        fs::create_dir_all(v.parent().unwrap()).unwrap();
        fs::write(&v, png(16, 64, 3)).unwrap();
        fs::write(mcmeta_file(&v), r#"{"animation":{"frametime":300}}"#).unwrap();

        let out = start_from_vanilla(&vanilla, &pack, "block/prismarine", 2).unwrap();
        assert_eq!(png_dimensions(&fs::read(&out).unwrap()), Some((32, 128)));
        assert!(mcmeta_file(&out).is_file());
        // each vanilla pixel became a 2x2 block of the same colour
        let small = image::open(&v).unwrap().to_rgba8();
        let big = image::open(&out).unwrap().to_rgba8();
        for (x, y) in [(0, 0), (5, 9), (15, 63)] {
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                assert_eq!(big.get_pixel(x * 2 + dx, y * 2 + dy), small.get_pixel(x, y));
            }
        }
        // a second call does not touch the user's work
        fs::write(&out, png(32, 128, 9)).unwrap();
        start_from_vanilla(&vanilla, &pack, "block/prismarine", 2).unwrap();
        assert_eq!(fs::read(&out).unwrap(), png(32, 128, 9));
        // scale 1 is an exact copy
        let v2 = texture_file(&vanilla, "block/stone").unwrap();
        fs::write(&v2, png(16, 16, 4)).unwrap();
        let out2 = start_from_vanilla(&vanilla, &pack, "block/stone", 1).unwrap();
        assert_eq!(fs::read(out2).unwrap(), png(16, 16, 4));
        assert_eq!(
            start_from_vanilla(&vanilla, &pack, "block/nope", 1)
                .unwrap_err()
                .kind,
            "not_found"
        );
    }

    #[test]
    fn start_from_vanilla_smooth_uses_scale2x_per_frame() {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("vanilla"), tmp.path().join("pack"));
        let v = texture_file(&vanilla, "block/x").unwrap();
        fs::create_dir_all(v.parent().unwrap()).unwrap();
        // two 4x4 frames: a diagonal on white, then all white
        let k = image::Rgba([0, 0, 0, 255]);
        let w = image::Rgba([255, 255, 255, 255]);
        let strip = image::RgbaImage::from_fn(4, 8, |x, y| if y < 4 && x == y { k } else { w });
        strip.save(&v).unwrap();
        fs::write(mcmeta_file(&v), r#"{"animation":{}}"#).unwrap();
        let out = start_from_vanilla_with(&vanilla, &pack, "block/x", 2, Upscale::Smooth).unwrap();
        let big = image::open(&out).unwrap().to_rgba8();
        assert_eq!(big.dimensions(), (8, 16));
        let f0 = image::imageops::crop_imm(&strip, 0, 0, 4, 4).to_image();
        let expect = upscale::scale2x(&f0, true);
        assert_eq!(
            image::imageops::crop_imm(&big, 0, 0, 8, 8).to_image(),
            expect
        );
        // the smooth result differs from hard pixels on a diagonal
        assert_ne!(expect, upscale::enlarge(&f0, 2, Upscale::Nearest, true));
        // the second frame stays white: it never borrows the first frame's pixels
        assert!(image::imageops::crop_imm(&big, 0, 8, 8, 8)
            .to_image()
            .pixels()
            .all(|p| *p == w));
        assert!(mcmeta_file(&out).is_file());
    }

    #[test]
    fn revert_moves_files_to_the_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("s.png");
        fs::write(&src, png(16, 32, 1)).unwrap();
        import_image(&pack, "block/x", &src, Some(&Animation::default())).unwrap();
        assert!(revert(&pack, "block/x").unwrap());
        let dest = texture_file(&pack, "block/x").unwrap();
        assert!(!dest.exists() && !mcmeta_file(&dest).exists());
        assert!(!revert(&pack, "block/x").unwrap());
        let n = walkdir::WalkDir::new(pack.join(PROJECT_DIR).join("trash"))
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .count();
        assert_eq!(n, 2);
    }

    #[test]
    fn create_mcmeta_for_a_tall_texture() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("pack");
        let src = tmp.path().join("s.png");
        fs::write(&src, png(16, 48, 1)).unwrap();
        import_image(&pack, "block/magma", &src, None).unwrap();
        let meta = create_animation_mcmeta(&pack, "block/magma", 8).unwrap();
        let a = mcmeta::parse_animation(&fs::read_to_string(meta).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(a.frametime, 8);
        assert_eq!(
            create_animation_mcmeta(&pack, "block/none", 1)
                .unwrap_err()
                .kind,
            "not_found"
        );
    }
}

//! Saving the showcase image. The web view draws it on a canvas (fonts and
//! `§` colours are there already) and sends the raw RGBA pixels; this module
//! encodes them losslessly as PNG and writes only `.png` files.

use crate::error::{CoreError, IoCtx, Result};
use crate::pngopt;
use base64::Engine;
use std::fs;
use std::path::Path;

/// Largest width or height accepted.
pub const MAX_SIDE: u32 = 4096;

/// Encodes raw RGBA pixels as a PNG (lossless; smallest of two encodings).
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
        return Err(CoreError::new(
            "bad_image",
            format!("A showcase image of {width}×{height} pixels is not supported."),
        ));
    }
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err(CoreError::new(
            "bad_image",
            "The showcase pixels do not match the image size.",
        ));
    }
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| CoreError::new("bad_image", "The showcase pixels could not be read."))?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| CoreError::new("bad_image", format!("Could not encode the image: {e}")))?;
    Ok(pngopt::smaller_png(&out))
}

/// Writes the showcase to `path`, which must be an absolute `.png` path.
/// `rgba_b64` is the canvas pixels, base64. Returns the file size.
pub fn save(path: &Path, width: u32, height: u32, rgba_b64: &str) -> Result<u64> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !path.is_absolute() || ext.as_deref() != Some("png") {
        return Err(CoreError::new(
            "bad_path",
            format!(
                "The showcase can only be saved as a .png file, not {}.",
                path.display()
            ),
        )
        .hint("Choose a file name ending in .png."));
    }
    let rgba = base64::engine::general_purpose::STANDARD
        .decode(rgba_b64)
        .map_err(|_| CoreError::new("bad_image", "The showcase pixels could not be read."))?;
    let data = encode_png(width, height, &rgba)?;
    let tmp = path.with_extension("png.tmp");
    fs::write(&tmp, &data).ctx(&tmp)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CoreError::io(path, &e)
    })?;
    Ok(data.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| [(i % 251) as u8, (i / 7) as u8, 200, (i % 3 * 100) as u8])
            .collect()
    }

    #[test]
    fn saves_exact_pixels_as_png() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Showcase.PNG");
        let raw = pixels(40, 30);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
        let size = save(&file, 40, 30, &b64).unwrap();
        let data = fs::read(&file).unwrap();
        assert_eq!(size, data.len() as u64);
        let img = image::load_from_memory(&data).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (40, 30));
        assert_eq!(img.into_raw(), raw);
        assert!(!file.with_extension("png.tmp").exists());
        // replacing an earlier showcase works
        save(&file, 40, 30, &b64).unwrap();
    }

    #[test]
    fn refuses_other_files_and_bad_pixels() {
        let tmp = tempfile::tempdir().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(pixels(4, 4));
        for name in ["notes.txt", "pack.mcmeta", "image.png.exe", "noext"] {
            let e = save(&tmp.path().join(name), 4, 4, &b64).unwrap_err();
            assert_eq!(e.kind, "bad_path", "{name}");
            assert!(!tmp.path().join(name).exists());
        }
        assert_eq!(
            save(Path::new("relative.png"), 4, 4, &b64)
                .unwrap_err()
                .kind,
            "bad_path"
        );
        let file = tmp.path().join("x.png");
        assert_eq!(save(&file, 5, 4, &b64).unwrap_err().kind, "bad_image");
        assert_eq!(save(&file, 4, 4, "%%%").unwrap_err().kind, "bad_image");
        assert_eq!(
            encode_png(MAX_SIDE + 1, 1, &vec![0; (MAX_SIDE as usize + 1) * 4])
                .unwrap_err()
                .kind,
            "bad_image"
        );
        assert!(!file.exists());
    }
}

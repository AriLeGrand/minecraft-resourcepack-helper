//! "Make PNG files smaller (same pixels)": lossless re-compression of the PNG
//! files of an export.
//!
//! Only ever applied to the exported copy, never to the pack's own files.
//! Each PNG is re-encoded with oxipng (libdeflate, colour type / bit depth /
//! palette reductions), then both files are decoded and the new one is kept
//! only when it is smaller **and** its pixels are exactly the same: same size,
//! and the same RGBA values at 16 bits per channel (an 8-bit value v counts as
//! v × 257, so a 16-bit image that was reduced to 8 bits is only accepted when
//! no precision was lost). Nothing is normalised: the colour hidden under a
//! fully transparent pixel must match too.
//!
//! Metadata chunks that do not change how the image looks (text, time,
//! physical size…) are dropped (`StripChunks::Safe`); Minecraft reads only
//! the pixels. Colour chunks (`sRGB`, `gAMA`, `iCCP`, `cHRM`) are kept.

use std::time::Duration;

/// Larger images are left alone (a 4096×4096 RGBA image is 64 MiB decoded).
const MAX_DECODED: usize = 256 * 1024 * 1024;
/// Time oxipng may spend on one file before keeping its best result so far.
const TIMEOUT: Duration = Duration::from_secs(8);

fn options() -> oxipng::Options {
    let mut o = oxipng::Options::from_preset(4);
    o.strip = oxipng::StripChunks::Safe;
    o.optimize_alpha = false; // never change the colour under transparent pixels
    o.scale_16 = false; // never drop precision
    o.timeout = Some(TIMEOUT);
    o.max_decompressed_size = Some(MAX_DECODED);
    o
}

/// Decoded pixels as RGBA, 16 bits per channel, plus the size.
fn rgba16(data: &[u8]) -> Option<(u32, u32, Vec<u16>)> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Png).ok()?;
    let (w, h) = (img.width(), img.height());
    Some((w, h, img.into_rgba16().into_raw()))
}

/// True when both PNG files decode to exactly the same pixels.
pub fn identical_pixels(a: &[u8], b: &[u8]) -> bool {
    match (rgba16(a), rgba16(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// The bytes to write for a PNG file: a smaller re-encoding when one exists
/// and shows exactly the same pixels, otherwise the original bytes.
pub fn smaller_png(data: &[u8]) -> Vec<u8> {
    match oxipng::optimize_from_memory(data, &options()) {
        Ok(out) if out.len() < data.len() && identical_pixels(data, &out) => out,
        _ => data.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png as rgba_png;

    /// Writes a PNG with the `png` crate, so any colour type and bit depth can be made.
    fn encode(
        w: u32,
        h: u32,
        color: png::ColorType,
        depth: png::BitDepth,
        data: &[u8],
        palette: Option<(&[u8], &[u8])>,
        text: bool,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(color);
            e.set_depth(depth);
            // the worst settings, so there is something to gain
            e.set_compression(png::Compression::Fast);
            e.set_filter(png::Filter::NoFilter);
            if let Some((pal, trns)) = palette {
                e.set_palette(pal.to_vec());
                if !trns.is_empty() {
                    e.set_trns(trns.to_vec());
                }
            }
            if text {
                e.add_text_chunk("Comment".into(), "x".repeat(400)).unwrap();
            }
            let mut wr = e.write_header().unwrap();
            wr.write_image_data(data).unwrap();
        }
        out
    }

    fn check(name: &str, original: &[u8]) -> Vec<u8> {
        let out = smaller_png(original);
        assert!(out.len() <= original.len(), "{name}: never bigger");
        assert!(identical_pixels(original, &out), "{name}: same pixels");
        // independent check with the plain 8-bit decode as well
        let a = image::load_from_memory(original).unwrap();
        let b = image::load_from_memory(&out).unwrap();
        assert_eq!(a.to_rgba8(), b.to_rgba8(), "{name}");
        out
    }

    #[test]
    fn rgba_with_metadata_gets_smaller_with_the_same_pixels() {
        // 64x64 with few colours and a 400-byte comment
        let mut data = Vec::new();
        for y in 0..64u32 {
            for x in 0..64u32 {
                let c = if (x / 8 + y / 8) % 2 == 0 { 30 } else { 200 };
                data.extend_from_slice(&[c, c / 2, 255 - c, if x < 4 { 0 } else { 255 }]);
            }
        }
        let original = encode(
            64,
            64,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &data,
            None,
            true,
        );
        let out = check("rgba", &original);
        assert!(
            out.len() < original.len() / 2,
            "{} vs {}",
            out.len(),
            original.len()
        );
    }

    #[test]
    fn transparent_pixels_keep_their_hidden_colour() {
        // fully transparent pixels with different colours: nothing may be normalised
        let mut data = Vec::new();
        for i in 0..256u32 {
            data.extend_from_slice(&[i as u8, (i * 7) as u8, (i * 13) as u8, 0]);
        }
        let original = encode(
            16,
            16,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &data,
            None,
            false,
        );
        let out = check("transparent", &original);
        let raw = image::load_from_memory(&out).unwrap().to_rgba8().into_raw();
        assert_eq!(raw, data);
    }

    #[test]
    fn palette_input_with_transparency() {
        let pal = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
        let trns = [255, 128, 0, 255];
        let idx: Vec<u8> = (0..32 * 32).map(|i| ((i / 7) % 4) as u8).collect();
        let original = encode(
            32,
            32,
            png::ColorType::Indexed,
            png::BitDepth::Eight,
            &idx,
            Some((&pal, &trns)),
            true,
        );
        check("palette", &original);
    }

    #[test]
    fn grey_with_alpha_input() {
        let data: Vec<u8> = (0..24 * 24)
            .flat_map(|i| [(i % 24 * 10) as u8, if i % 5 == 0 { 0 } else { 255 }])
            .collect();
        let original = encode(
            24,
            24,
            png::ColorType::GrayscaleAlpha,
            png::BitDepth::Eight,
            &data,
            None,
            true,
        );
        check("grey+alpha", &original);
    }

    #[test]
    fn sixteen_bit_input_keeps_full_precision() {
        // real 16-bit values: reducing to 8 bits would lose precision
        let mut fine = Vec::new();
        for i in 0..16 * 16u32 {
            for c in [i * 251, i * 13 + 1, 65535 - i * 3, 65535] {
                fine.extend_from_slice(&(c as u16).to_be_bytes());
            }
        }
        let original = encode(
            16,
            16,
            png::ColorType::Rgba,
            png::BitDepth::Sixteen,
            &fine,
            None,
            true,
        );
        let out = check("16-bit", &original);
        let (_, _, a) = rgba16(&original).unwrap();
        let (_, _, b) = rgba16(&out).unwrap();
        assert_eq!(a, b);
        assert!(
            a.iter().any(|v| v % 257 != 0),
            "the test has real 16-bit values"
        );

        // 16-bit values that are exact 8-bit ones (v × 257) may become 8-bit
        let mut coarse = Vec::new();
        for i in 0..16 * 16u32 {
            for c in [(i % 256) * 257, 0, 65535, 65535] {
                coarse.extend_from_slice(&(c as u16).to_be_bytes());
            }
        }
        let original = encode(
            16,
            16,
            png::ColorType::Rgba,
            png::BitDepth::Sixteen,
            &coarse,
            None,
            false,
        );
        check("16-bit coarse", &original);
    }

    #[test]
    fn identical_pixels_is_exact() {
        let a = rgba_png(8, 8, 3);
        assert!(identical_pixels(&a, &a));
        assert!(!identical_pixels(&a, &rgba_png(8, 8, 4)));
        assert!(!identical_pixels(&a, &rgba_png(8, 9, 3)));
        // one hidden colour under a transparent pixel differs: not identical
        let mut x = image::RgbaImage::new(2, 1);
        x.put_pixel(0, 0, image::Rgba([1, 2, 3, 0]));
        let mut y = x.clone();
        y.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
        let enc = |i: &image::RgbaImage| {
            let mut out = Vec::new();
            i.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .unwrap();
            out
        };
        assert!(!identical_pixels(&enc(&x), &enc(&y)));
    }

    #[test]
    fn unreadable_files_are_kept_as_they_are() {
        assert_eq!(smaller_png(b"not a png"), b"not a png");
        let mut cut = rgba_png(16, 16, 1);
        cut.truncate(cut.len() - 20);
        assert_eq!(smaller_png(&cut), cut);
    }
}

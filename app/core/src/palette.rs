//! The pack palette: a short list of colours shared by the whole pack, kept in
//! the project file. Colours are compared in OKLab, a perceptual colour space
//! (equal distances look about equally different), the same way as the
//! editor's "Snap to pack palette" (`src/editor/packPalette.ts`).
//!
//! The export check "N textures use colours outside the pack palette" lives
//! here too and is called from [`crate::export::run_checks`].

use crate::error::{CoreError, Result};
use crate::export::Check;
use crate::pack::PackTexture;
use crate::textures::texture_file;
use std::path::Path;

/// Most colours a pack palette can hold.
pub const MAX_COLOURS: usize = 64;

/// OKLab distance under which two colours count as the same for the export
/// check (about one step of 8-bit rounding in a mid tone; well under what the
/// eye notices side by side).
pub const TOLERANCE: f32 = 0.02;

/// `#rrggbb` → RGB. Also accepts `rrggbb` and upper case.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

pub fn to_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Checks and normalises a palette sent by the UI: lower-case `#rrggbb`,
/// no repeats (the first one is kept), at most [`MAX_COLOURS`].
pub fn normalise(colours: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for c in colours {
        let rgb = parse_hex(c).ok_or_else(|| {
            CoreError::new(
                "bad_colour",
                format!("\"{c}\" is not a colour like #a0b1c2."),
            )
        })?;
        let hex = to_hex(rgb);
        if !out.contains(&hex) {
            out.push(hex);
        }
    }
    if out.len() > MAX_COLOURS {
        return Err(CoreError::new(
            "palette_full",
            format!("A pack palette holds at most {MAX_COLOURS} colours."),
        )
        .hint("Remove a colour first."));
    }
    Ok(out)
}

fn linear(c: u8) -> f32 {
    let v = f32::from(c) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB (8 bit) → OKLab (Björn Ottosson's reference matrices).
pub fn oklab(c: [u8; 3]) -> [f32; 3] {
    let (r, g, b) = (linear(c[0]), linear(c[1]), linear(c[2]));
    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

pub fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// A palette ready for nearest-colour lookups.
pub struct Lab {
    pub rgb: Vec<[u8; 3]>,
    lab: Vec<[f32; 3]>,
}

impl Lab {
    pub fn new(colours: &[String]) -> Self {
        let rgb: Vec<[u8; 3]> = colours.iter().filter_map(|c| parse_hex(c)).collect();
        let lab = rgb.iter().map(|c| oklab(*c)).collect();
        Lab { rgb, lab }
    }

    pub fn is_empty(&self) -> bool {
        self.rgb.is_empty()
    }

    /// Index of the nearest palette colour and its OKLab distance.
    pub fn nearest(&self, c: [u8; 3]) -> Option<(usize, f32)> {
        let p = oklab(c);
        self.lab
            .iter()
            .enumerate()
            .map(|(i, q)| (i, distance(p, *q)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
    }
}

/// Pixels of `img` (alpha above 0) whose colour is further than `tolerance`
/// from every palette colour. Fully transparent pixels never count.
pub fn pixels_outside(img: &image::RgbaImage, lab: &Lab, tolerance: f32) -> usize {
    if lab.is_empty() {
        return 0;
    }
    let mut seen: std::collections::HashMap<[u8; 3], bool> = std::collections::HashMap::new();
    let mut n = 0;
    for p in img.pixels() {
        if p[3] == 0 {
            continue;
        }
        let c = [p[0], p[1], p[2]];
        let out = *seen
            .entry(c)
            .or_insert_with(|| lab.nearest(c).is_none_or(|(_, d)| d > tolerance));
        if out {
            n += 1;
        }
    }
    n
}

/// Export check: textures of the pack that use colours outside the pack
/// palette. `None` when the palette is empty or every texture keeps to it.
pub fn check(pack_dir: &Path, palette: &[String], pack: &[PackTexture]) -> Option<Check> {
    let lab = Lab::new(palette);
    if lab.is_empty() {
        return None;
    }
    let mut off: Vec<String> = Vec::new();
    for t in pack {
        let Ok(file) = texture_file(pack_dir, &t.path) else {
            continue;
        };
        let Ok(img) = image::open(&file) else {
            continue;
        };
        if pixels_outside(&img.to_rgba8(), &lab, TOLERANCE) > 0 {
            off.push(t.path.clone());
        }
    }
    if off.is_empty() {
        return None;
    }
    let names: Vec<&str> = off
        .iter()
        .take(3)
        .map(|p| p.rsplit('/').next().unwrap_or(p))
        .collect();
    let more = if off.len() > 3 {
        format!(" and {} more", off.len() - 3)
    } else {
        String::new()
    };
    Some(Check {
        id: "palette".into(),
        ok: false,
        title: format!(
            "{} texture{} colours outside the pack palette",
            off.len(),
            if off.len() == 1 { " uses" } else { "s use" }
        ),
        detail: format!("{}{more}", names.join(", ")),
        fix: Some("Show".into()),
        paths: off,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use std::fs;

    #[test]
    fn hex_round_trip_and_normalise() {
        assert_eq!(parse_hex("#A0b1C2"), Some([0xa0, 0xb1, 0xc2]));
        assert_eq!(parse_hex("a0b1c2"), Some([0xa0, 0xb1, 0xc2]));
        assert_eq!(parse_hex("#abc"), None);
        assert_eq!(parse_hex("#gg0000"), None);
        assert_eq!(to_hex([1, 2, 255]), "#0102ff");
        let n = normalise(&["#FF0000".into(), "#ff0000".into(), "00ff00".into()]).unwrap();
        assert_eq!(n, vec!["#ff0000", "#00ff00"]);
        assert_eq!(normalise(&["red".into()]).unwrap_err().kind, "bad_colour");
        let many: Vec<String> = (0..65).map(|i| to_hex([i as u8, 0, 0])).collect();
        assert_eq!(normalise(&many).unwrap_err().kind, "palette_full");
    }

    #[test]
    fn oklab_reference_values() {
        // white is L=1, a=b=0; black is 0
        let w = oklab([255, 255, 255]);
        assert!((w[0] - 1.0).abs() < 1e-3 && w[1].abs() < 1e-3 && w[2].abs() < 1e-3);
        assert!(oklab([0, 0, 0]).iter().all(|v| v.abs() < 1e-6));
        // pure red, from the OKLab reference: (0.6279, 0.2249, 0.1258)
        let r = oklab([255, 0, 0]);
        assert!(
            (r[0] - 0.6279).abs() < 2e-3
                && (r[1] - 0.2249).abs() < 2e-3
                && (r[2] - 0.1258).abs() < 2e-3
        );
    }

    #[test]
    fn nearest_is_perceptual() {
        // a dark blue is nearer to black than to a mid grey in OKLab
        let lab = Lab::new(&["#000000".into(), "#808080".into(), "#ffffff".into()]);
        assert_eq!(lab.nearest([20, 20, 60]).unwrap().0, 0);
        assert_eq!(lab.nearest([128, 128, 128]).unwrap(), (1, 0.0));
        assert_eq!(lab.nearest([250, 250, 250]).unwrap().0, 2);
        assert!(Lab::new(&[]).nearest([1, 2, 3]).is_none());
    }

    #[test]
    fn outside_ignores_transparent_and_near_identical_pixels() {
        let lab = Lab::new(&["#336699".into()]);
        let mut img = RgbaImage::from_pixel(4, 4, Rgba([0x33, 0x66, 0x99, 255]));
        assert_eq!(pixels_outside(&img, &lab, TOLERANCE), 0);
        // one step off on one channel: the same colour for the check
        img.put_pixel(0, 0, Rgba([0x34, 0x66, 0x99, 255]));
        // a fully transparent pixel of any colour does not count
        img.put_pixel(1, 0, Rgba([255, 0, 0, 0]));
        assert_eq!(pixels_outside(&img, &lab, TOLERANCE), 0);
        // a red half-transparent pixel does
        img.put_pixel(2, 0, Rgba([255, 0, 0, 128]));
        img.put_pixel(3, 0, Rgba([255, 0, 0, 255]));
        assert_eq!(pixels_outside(&img, &lab, TOLERANCE), 2);
        // an empty palette never flags anything
        assert_eq!(pixels_outside(&img, &Lab::new(&[]), TOLERANCE), 0);
    }

    fn put(pack: &Path, tex: &str, img: &RgbaImage) -> PackTexture {
        let f = texture_file(pack, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        img.save(&f).unwrap();
        PackTexture {
            path: tex.into(),
            width: img.width(),
            height: img.height(),
            modified_ms: 0,
            has_mcmeta: false,
            animated: false,
            frames: 1,
            file_size: 0,
        }
    }

    #[test]
    fn export_check_lists_textures_off_the_palette() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let good = put(
            pack,
            "block/a",
            &RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255])),
        );
        let bad = put(
            pack,
            "block/b",
            &RgbaImage::from_pixel(2, 2, Rgba([200, 20, 30, 255])),
        );
        let list = vec![good, bad];
        assert!(check(pack, &[], &list).is_none());
        let c = check(pack, &["#0a141e".into()], &list).unwrap();
        assert_eq!(c.id, "palette");
        assert!(!c.ok);
        assert_eq!(c.paths, vec!["block/b"]);
        assert_eq!(c.title, "1 texture uses colours outside the pack palette");
        assert_eq!(c.fix.as_deref(), Some("Show"));
        assert!(check(pack, &["#0a141e".into(), "#c8141e".into()], &list).is_none());
    }
}

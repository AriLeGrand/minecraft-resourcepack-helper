//! Seams of tiling textures: a block texture is repeated side by side in the
//! game, so its last column touches its first column (and its last row its
//! first row). When the colours jump there much more than they do between
//! neighbouring columns inside the texture, the edge shows as a line.
//!
//! The measure compares the average colour difference across the wrap edge
//! with the average difference between neighbouring columns (rows) inside.

use crate::export::Check;
use crate::mcmeta;
use crate::pack::PackTexture;
use crate::textures::{category_of, mcmeta_file, texture_file, Category};
use image::RgbaImage;
use serde::Serialize;
use std::path::Path;

/// The wrap edge must differ this many times more than the inside…
pub const RATIO: f32 = 2.0;
/// …and by at least this much on average (RGB distance, 0 to 441), so flat
/// or nearly flat textures with a faint edge are not flagged.
pub const MIN_JUMP: f32 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
pub struct Edge {
    /// Average colour difference across the wrap edge.
    pub edge: f32,
    /// Average colour difference between neighbours inside the texture.
    pub inside: f32,
    pub seam: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
pub struct SeamReport {
    /// Last column against the first one (the left / right edge).
    pub columns: Edge,
    /// Last row against the first one (the top / bottom edge).
    pub rows: Edge,
}

impl SeamReport {
    pub fn any(&self) -> bool {
        self.columns.seam || self.rows.seam
    }
}

/// Colour difference of two pixels; colours are weighted by alpha so two
/// fully transparent pixels of different colours do not count.
fn diff(a: &image::Rgba<u8>, b: &image::Rgba<u8>) -> f32 {
    let pa = |p: &image::Rgba<u8>, i: usize| f32::from(p[i]) * f32::from(p[3]) / 255.0;
    let mut s = 0.0;
    for i in 0..3 {
        s += (pa(a, i) - pa(b, i)).powi(2);
    }
    s += (f32::from(a[3]) - f32::from(b[3])).powi(2);
    s.sqrt()
}

fn judge(edge: f32, inside: f32) -> Edge {
    Edge {
        edge,
        inside,
        seam: edge >= MIN_JUMP && edge > inside * RATIO,
    }
}

/// Measures one frame (or a still texture).
pub fn measure(img: &RgbaImage) -> SeamReport {
    let (w, h) = img.dimensions();
    if w < 3 || h < 3 {
        return SeamReport::default();
    }
    let col = |x0: u32, x1: u32| -> f32 {
        (0..h)
            .map(|y| diff(img.get_pixel(x0, y), img.get_pixel(x1, y)))
            .sum::<f32>()
            / h as f32
    };
    let row = |y0: u32, y1: u32| -> f32 {
        (0..w)
            .map(|x| diff(img.get_pixel(x, y0), img.get_pixel(x, y1)))
            .sum::<f32>()
            / w as f32
    };
    let inside_cols = (0..w - 1).map(|x| col(x, x + 1)).sum::<f32>() / (w - 1) as f32;
    let inside_rows = (0..h - 1).map(|y| row(y, y + 1)).sum::<f32>() / (h - 1) as f32;
    SeamReport {
        columns: judge(col(w - 1, 0), inside_cols),
        rows: judge(row(h - 1, 0), inside_rows),
    }
}

/// Measures raw RGBA pixels (one frame, as the editor sends it).
pub fn measure_raw(width: u32, height: u32, rgba: Vec<u8>) -> crate::Result<SeamReport> {
    let img = RgbaImage::from_raw(width, height, rgba).ok_or_else(|| {
        crate::CoreError::new("bad_image", "The editor sent an image of the wrong size.")
    })?;
    Ok(measure(&img))
}

/// Measures every frame of a strip and keeps the worst edge of each kind.
pub fn measure_strip(img: &RgbaImage, frame_h: u32) -> SeamReport {
    let (w, h) = img.dimensions();
    let frame_h = frame_h.clamp(1, h.max(1));
    if frame_h >= h || !h.is_multiple_of(frame_h) {
        return measure(img);
    }
    let mut out = SeamReport::default();
    let worse = |a: Edge, b: Edge| {
        if (b.seam && !a.seam) || (b.seam == a.seam && b.edge - b.inside > a.edge - a.inside) {
            b
        } else {
            a
        }
    };
    for i in 0..h / frame_h {
        let frame = image::imageops::crop_imm(img, 0, i * frame_h, w, frame_h).to_image();
        let r = measure(&frame);
        out.columns = if i == 0 {
            r.columns
        } else {
            worse(out.columns, r.columns)
        };
        out.rows = if i == 0 {
            r.rows
        } else {
            worse(out.rows, r.rows)
        };
    }
    out
}

/// Measures a pack texture file (animation frames one by one).
pub fn measure_file(png: &Path) -> Option<SeamReport> {
    let img = image::open(png).ok()?.to_rgba8();
    let anim = std::fs::read_to_string(mcmeta_file(png))
        .ok()
        .and_then(|t| mcmeta::parse_animation(&t).ok().flatten());
    let frame_h = mcmeta::frame_height(img.width(), img.height(), anim.as_ref());
    Some(measure_strip(
        &img,
        if anim.is_some() {
            frame_h
        } else {
            img.height()
        },
    ))
}

/// Export check: block textures of the pack whose edges show when tiled.
pub fn check(pack_dir: &Path, pack: &[PackTexture]) -> Option<Check> {
    let mut found: Vec<(String, SeamReport)> = Vec::new();
    for t in pack {
        if category_of(&t.path) != Category::Blocks {
            continue;
        }
        let Ok(file) = texture_file(pack_dir, &t.path) else {
            continue;
        };
        if let Some(r) = measure_file(&file).filter(|r| r.any()) {
            found.push((t.path.clone(), r));
        }
    }
    if found.is_empty() {
        return None;
    }
    let (first, r) = &found[0];
    let name = first.rsplit('/').next().unwrap_or(first);
    let where_ = match (r.columns.seam, r.rows.seam) {
        (true, true) => "left/right and top/bottom edges",
        (true, false) => "left/right edge",
        _ => "top/bottom edge",
    };
    let more = if found.len() > 1 {
        format!(" (and {} more)", found.len() - 1)
    } else {
        String::new()
    };
    Some(Check {
        id: "seams".into(),
        ok: false,
        title: format!(
            "{} block texture{} a visible seam when tiled",
            found.len(),
            if found.len() == 1 { " shows" } else { "s show" }
        ),
        detail: format!("{name}: seam on the {where_}{more}"),
        fix: Some("Show".into()),
        paths: found.into_iter().map(|(p, _)| p).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::fs;

    /// A seamless texture: a smooth wave that repeats exactly across the
    /// edges, plus a little noise that is periodic too.
    fn seamless(n: u32) -> RgbaImage {
        RgbaImage::from_fn(n, n, |x, y| {
            let t = std::f32::consts::TAU;
            let v = 120.0
                + 40.0 * (t * x as f32 / n as f32).sin()
                + 30.0 * (t * 2.0 * y as f32 / n as f32).cos();
            let noise = ((x * 7 + y * 13) % 5) as f32 * 3.0;
            let c = (v + noise) as u8;
            Rgba([c, c / 2, 255 - c, 255])
        })
    }

    #[test]
    fn a_seamless_texture_passes() {
        for n in [16, 32, 64] {
            let r = measure(&seamless(n));
            assert!(!r.columns.seam && !r.rows.seam, "{n}: {r:?}");
        }
        // a flat colour has no seam at all
        let flat = RgbaImage::from_pixel(16, 16, Rgba([90, 90, 90, 255]));
        assert!(!measure(&flat).any());
    }

    #[test]
    fn a_hard_edge_fails_on_the_right_side() {
        // the left half of the image gets a darker band on its first column only:
        // inside it changes once (column 0 to 1), at the wrap it jumps again
        let mut img = seamless(16);
        for y in 0..16 {
            for x in 0..2 {
                img.put_pixel(x, y, Rgba([10, 10, 10, 255]));
            }
        }
        // that alone is a band, not a seam: the inside has the same step
        // now make the last column very bright: the wrap edge jumps hard
        for y in 0..16 {
            img.put_pixel(15, y, Rgba([250, 250, 250, 255]));
        }
        let r = measure(&img);
        assert!(r.columns.seam, "{r:?}");
        assert!(!r.rows.seam, "{r:?}");
        // the same texture turned on its side has the seam on the top/bottom edge
        let turned = image::imageops::rotate90(&img);
        let r = measure(&turned);
        assert!(r.rows.seam && !r.columns.seam, "{r:?}");
    }

    #[test]
    fn a_gradient_has_a_seam_where_it_wraps() {
        // dark on the left, bright on the right: each step inside is small,
        // the wrap goes from brightest to darkest at once
        let img = RgbaImage::from_fn(16, 16, |x, _| {
            let c = (x * 16) as u8;
            Rgba([c, c, c, 255])
        });
        let r = measure(&img);
        assert!(r.columns.seam && !r.rows.seam);
        assert!(r.columns.edge > 200.0 && r.columns.inside < 30.0);
        // the same through raw pixels, as the editor sends them
        assert_eq!(measure_raw(16, 16, img.clone().into_raw()).unwrap(), r);
        assert_eq!(
            measure_raw(17, 16, img.into_raw()).unwrap_err().kind,
            "bad_image"
        );
    }

    #[test]
    fn transparent_pixels_of_any_colour_match() {
        let img = RgbaImage::from_fn(8, 8, |x, _| {
            if x == 7 {
                Rgba([255, 0, 0, 0])
            } else {
                Rgba([0, 0, 255, 0])
            }
        });
        assert!(!measure(&img).any());
    }

    #[test]
    fn export_check_only_looks_at_block_textures() {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path();
        let gradient = RgbaImage::from_fn(16, 16, |x, _| {
            let c = (x * 16) as u8;
            Rgba([c, c, c, 255])
        });
        let mut list = Vec::new();
        for (tex, img) in [
            ("block/bad", gradient.clone()),
            ("block/good", seamless(16)),
            ("item/also_gradient", gradient),
        ] {
            let f = texture_file(pack, tex).unwrap();
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            img.save(&f).unwrap();
            list.push(PackTexture {
                path: tex.into(),
                width: 16,
                height: 16,
                modified_ms: 0,
                has_mcmeta: false,
                animated: false,
                frames: 1,
                file_size: 0,
            });
        }
        let c = check(pack, &list).unwrap();
        assert_eq!(c.id, "seams");
        assert_eq!(c.paths, vec!["block/bad"]);
        assert_eq!(c.detail, "bad: seam on the left/right edge");
        assert!(check(pack, &list[1..]).is_none());
    }

    #[test]
    fn strips_are_measured_frame_by_frame() {
        // two seamless frames stacked: as one image the rows would not wrap
        let a = seamless(16);
        let mut strip = RgbaImage::new(16, 32);
        image::imageops::replace(&mut strip, &a, 0, 0);
        let dark = RgbaImage::from_pixel(16, 16, Rgba([5, 5, 5, 255]));
        image::imageops::replace(&mut strip, &dark, 0, 16);
        assert!(!measure_strip(&strip, 16).any());
    }
}

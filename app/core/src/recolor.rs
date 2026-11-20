//! Recolouring textures in Rust: adjustments (hue, saturation, brightness,
//! contrast), colour maps (from → to with a tolerance), and the gradient map
//! used by "Make variants" (a texture recoloured to look like another one of
//! its family). Alpha is always kept exactly.
//!
//! Writing follows the pack rules: a replaced pack file goes to
//! `.packcreator/trash/<stamp>/`, a texture not yet in the pack starts from
//! the game's texture at the pack resolution (like
//! [`crate::import::start_from_vanilla_with`]), and the whole operation can be
//! undone with [`undo`].

use crate::error::{CoreError, IoCtx, Result};
use crate::import::{move_to_trash, vanilla_at_scale};
use crate::mcmeta;
use crate::pack::{now_ms, PROJECT_DIR};
use crate::palette::parse_hex;
use crate::textures::{mcmeta_file, texture_file, TEXTURES_DIR};
use crate::upscale::Upscale;
use base64::Engine;
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------ operations

/// Slider values. All zero changes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Adjust {
    /// Degrees, -180 to 180.
    pub hue: f64,
    /// -100 (grey) to 100 (twice as saturated).
    pub saturation: f64,
    /// -100 (black) to 100 (white).
    pub brightness: f64,
    /// -100 (flat grey) to 100 (twice the contrast).
    pub contrast: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapPair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recolor {
    Adjust(Adjust),
    /// Colours within `tolerance` (largest channel difference, 0 to 255) of a
    /// `from` colour move to its `to` colour, keeping their small difference
    /// from it (so shading inside the tolerance survives).
    Map {
        pairs: Vec<MapPair>,
        tolerance: u8,
    },
}

fn rgb_to_hsl(c: [u8; 3]) -> (f64, f64, f64) {
    let r = f64::from(c[0]) / 255.0;
    let g = f64::from(c[1]) / 255.0;
    let b = f64::from(c[2]) / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        60.0 * ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}

fn to_u8(v: f64) -> u8 {
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.hue.rem_euclid(360.0) == 0.0
            && self.saturation == 0.0
            && self.brightness == 0.0
            && self.contrast == 0.0
    }

    /// One colour through the adjustment (alpha is not involved).
    pub fn color(&self, c: [u8; 3]) -> [u8; 3] {
        if self.is_identity() {
            return c;
        }
        let mut v = [
            f64::from(c[0]) / 255.0,
            f64::from(c[1]) / 255.0,
            f64::from(c[2]) / 255.0,
        ];
        if self.hue.rem_euclid(360.0) != 0.0 || self.saturation != 0.0 {
            let (h, s, l) = rgb_to_hsl(c);
            let s = (s * (1.0 + self.saturation.clamp(-100.0, 100.0) / 100.0)).clamp(0.0, 1.0);
            v = hsl_to_rgb(h + self.hue, s, l);
        }
        let b = self.brightness.clamp(-100.0, 100.0) / 100.0;
        let k = 1.0 + self.contrast.clamp(-100.0, 100.0) / 100.0;
        for x in v.iter_mut() {
            *x = ((*x + b).clamp(0.0, 1.0) - 0.5) * k + 0.5;
        }
        [to_u8(v[0]), to_u8(v[1]), to_u8(v[2])]
    }
}

fn map_color(pairs: &[([u8; 3], [u8; 3])], tolerance: u8, c: [u8; 3]) -> [u8; 3] {
    let mut best: Option<(u8, usize)> = None;
    for (i, (from, _)) in pairs.iter().enumerate() {
        let d = (0..3).map(|k| c[k].abs_diff(from[k])).max().unwrap_or(0);
        if d <= tolerance && best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, i));
        }
    }
    match best {
        None => c,
        Some((_, i)) => {
            let (from, to) = pairs[i];
            let mut out = [0u8; 3];
            for k in 0..3 {
                out[k] =
                    (i32::from(to[k]) + i32::from(c[k]) - i32::from(from[k])).clamp(0, 255) as u8;
            }
            out
        }
    }
}

/// Applies a recolour to every pixel. Fully transparent pixels keep their
/// colour too (they are invisible, and leaving them alone keeps the file
/// identical where nothing shows).
pub fn apply(img: &RgbaImage, op: &Recolor) -> Result<RgbaImage> {
    let f: Box<dyn Fn([u8; 3]) -> [u8; 3]> = match op {
        Recolor::Adjust(a) => {
            let a = *a;
            Box::new(move |c| a.color(c))
        }
        Recolor::Map { pairs, tolerance } => {
            let mut parsed = Vec::new();
            for p in pairs {
                let (Some(from), Some(to)) = (parse_hex(&p.from), parse_hex(&p.to)) else {
                    return Err(CoreError::new(
                        "bad_colour",
                        format!("\"{}\" → \"{}\" is not a pair of colours.", p.from, p.to),
                    ));
                };
                parsed.push((from, to));
            }
            let t = *tolerance;
            Box::new(move |c| map_color(&parsed, t, c))
        }
    };
    let mut cache: HashMap<[u8; 3], [u8; 3]> = HashMap::new();
    let mut out = img.clone();
    for p in out.pixels_mut() {
        if p[3] == 0 {
            continue;
        }
        let c = [p[0], p[1], p[2]];
        let n = *cache.entry(c).or_insert_with(|| f(c));
        *p = Rgba([n[0], n[1], n[2], p[3]]);
    }
    Ok(out)
}

// ---------------------------------------------------------- gradient map

/// Integer luminance (Rec. 709 weights × 10000), exact for sorting.
fn luma(p: &Rgba<u8>) -> u32 {
    2126 * u32::from(p[0]) + 7152 * u32::from(p[1]) + 722 * u32::from(p[2])
}

/// The first frame of a strip (a square on top when the image is a tall
/// stack of squares).
pub fn first_frame(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    if h > w && w > 0 && h.is_multiple_of(w) {
        image::imageops::crop_imm(img, 0, 0, w, w).to_image()
    } else {
        img.clone()
    }
}

/// Gradient map: the visible colours of `target` sorted by luminance form a
/// ramp; every visible pixel of `source` takes the ramp colour at its own
/// luminance rank among the source's pixels (pixels of equal luminance share
/// one rank, so the source's shading structure stays exactly as it was).
/// Alpha comes from the source. Only the target's first frame is used.
pub fn gradient_map(source: &RgbaImage, target: &RgbaImage) -> Result<RgbaImage> {
    let target = first_frame(target);
    let mut ramp: Vec<(u32, [u8; 3])> = target
        .pixels()
        .filter(|p| p[3] > 0)
        .map(|p| (luma(p), [p[0], p[1], p[2]]))
        .collect();
    if ramp.is_empty() {
        return Err(CoreError::new(
            "no_colours",
            "The texture to copy the colours from is fully transparent.",
        ));
    }
    ramp.sort();
    let mut lumas: Vec<u32> = source.pixels().filter(|p| p[3] > 0).map(luma).collect();
    if lumas.is_empty() {
        return Ok(source.clone());
    }
    lumas.sort_unstable();
    let n = lumas.len();
    // mid-rank of every distinct luminance, as a position 0..1
    let mut pos: HashMap<u32, f64> = HashMap::new();
    let mut i = 0;
    while i < n {
        let mut j = i;
        while j + 1 < n && lumas[j + 1] == lumas[i] {
            j += 1;
        }
        let mid = (i + j) as f64 / 2.0;
        pos.insert(lumas[i], if n > 1 { mid / (n - 1) as f64 } else { 0.5 });
        i = j + 1;
    }
    let m = ramp.len();
    let mut out = source.clone();
    for p in out.pixels_mut() {
        if p[3] == 0 {
            continue;
        }
        let t = pos[&luma(p)];
        let c = ramp[((t * (m - 1) as f64).round() as usize).min(m - 1)].1;
        *p = Rgba([c[0], c[1], c[2], p[3]]);
    }
    Ok(out)
}

/// "Make variants": the source's first frame gradient-mapped onto the game
/// colours of `target` (its first frame).
pub fn variant(source: &Source, vanilla_root: &Path, target: &str) -> Result<RgbaImage> {
    let file = texture_file(vanilla_root, target)?;
    let colours = image::open(&file)
        .map_err(|_| {
            CoreError::new(
                "not_found",
                format!("The game has no texture called {target} in this version."),
            )
        })?
        .to_rgba8();
    let (w, h) = source.img.dimensions();
    let first = image::imageops::crop_imm(&source.img, 0, 0, w, source.frame_h.clamp(1, h.max(1)))
        .to_image();
    gradient_map(&first, &colours)
}

// ------------------------------------------------------- reading, writing

/// The image type the commands pass around.
pub type Image = RgbaImage;

/// Where a texture's pixels come from before a recolour.
pub struct Source {
    pub img: RgbaImage,
    /// True when the pack already has this texture.
    pub in_pack: bool,
    /// Frame height of an animation strip (the image height when still).
    pub frame_h: u32,
}

/// The pack's texture, or else the game's enlarged to the pack resolution.
pub fn load(
    pack_dir: &Path,
    vanilla_root: &Path,
    tex_path: &str,
    scale: u32,
    method: Upscale,
) -> Result<Source> {
    let file = texture_file(pack_dir, tex_path)?;
    let (img, in_pack, meta) = if file.is_file() {
        let img = image::open(&file)
            .map_err(|e| {
                CoreError::new(
                    "bad_image",
                    format!("{} could not be read: {e}", file.display()),
                )
            })?
            .to_rgba8();
        (img, true, mcmeta_file(&file))
    } else {
        let img = vanilla_at_scale(vanilla_root, tex_path, scale, method)?;
        (
            img,
            false,
            mcmeta_file(&texture_file(vanilla_root, tex_path)?),
        )
    };
    let anim = fs::read_to_string(meta)
        .ok()
        .and_then(|t| mcmeta::parse_animation(&t).ok().flatten());
    let frame_h = match &anim {
        Some(a) => mcmeta::frame_height(img.width(), img.height(), Some(a)),
        None => img.height(),
    };
    Ok(Source {
        img,
        in_pack,
        frame_h,
    })
}

/// A small PNG data URL of the first frame for previews (at most 64 pixels
/// wide, hard pixels).
pub fn preview_url(img: &RgbaImage, frame_h: u32) -> String {
    let (w, h) = img.dimensions();
    let fh = frame_h.clamp(1, h.max(1));
    let mut frame = image::imageops::crop_imm(img, 0, 0, w, fh).to_image();
    let big = w.max(fh);
    if big > 64 {
        let s = big.div_ceil(64);
        frame = image::imageops::resize(
            &frame,
            (w / s).max(1),
            (fh / s).max(1),
            image::imageops::FilterType::Nearest,
        );
    }
    let mut png = Vec::new();
    let _ = frame.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png);
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub path: String,
    pub message: String,
}

/// What a write did, and everything [`undo`] needs to take it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WriteReport {
    /// Trash folder name (`.packcreator/trash/<stamp>`) of the replaced files.
    pub stamp: u64,
    /// Textures whose earlier pack file is now in the trash.
    pub replaced: Vec<String>,
    /// Textures that were not in the pack before.
    pub created: Vec<String>,
    /// New textures for which the game's `.mcmeta` was copied too.
    pub created_mcmeta: Vec<String>,
    pub failed: Vec<Failure>,
}

fn encode(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| CoreError::new("bad_image", format!("The image could not be encoded: {e}")))?;
    Ok(out)
}

fn write_one(
    pack_dir: &Path,
    vanilla_root: &Path,
    path: &str,
    img: &RgbaImage,
    stamp: u64,
    report: &mut WriteReport,
) -> Result<()> {
    let bytes = encode(img)?;
    let dest = texture_file(pack_dir, path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    if move_to_trash(pack_dir, &dest, stamp)?.is_some() {
        report.replaced.push(path.to_owned());
    } else {
        report.created.push(path.to_owned());
        // a new animated texture needs the game's .mcmeta, as when started from it
        let src_meta = mcmeta_file(&texture_file(vanilla_root, path)?);
        let dest_meta = mcmeta_file(&dest);
        if src_meta.is_file() && !dest_meta.exists() {
            fs::copy(&src_meta, &dest_meta).ctx(&dest_meta)?;
            report.created_mcmeta.push(path.to_owned());
        }
    }
    fs::write(&dest, bytes).ctx(&dest)
}

/// Writes recoloured textures into the pack. One failure does not stop the
/// others; each is reported.
pub fn write_all(
    pack_dir: &Path,
    vanilla_root: &Path,
    items: Vec<(String, RgbaImage)>,
) -> WriteReport {
    let mut report = WriteReport {
        stamp: now_ms(),
        ..Default::default()
    };
    for (path, img) in items {
        let stamp = report.stamp;
        if let Err(e) = write_one(pack_dir, vanilla_root, &path, &img, stamp, &mut report) {
            report.failed.push(Failure {
                path,
                message: e.message,
            });
        }
    }
    report
}

/// Recolours `paths` with `op` and writes them (see [`write_all`]).
pub fn recolor_and_write(
    pack_dir: &Path,
    vanilla_root: &Path,
    paths: &[String],
    op: &Recolor,
    scale_of: impl Fn(&str) -> u32,
    method: Upscale,
) -> WriteReport {
    let mut items = Vec::new();
    let mut failed = Vec::new();
    for p in paths {
        match load(pack_dir, vanilla_root, p, scale_of(p), method).and_then(|s| apply(&s.img, op)) {
            Ok(img) => items.push((p.clone(), img)),
            Err(e) => failed.push(Failure {
                path: p.clone(),
                message: e.message,
            }),
        }
    }
    let mut report = write_all(pack_dir, vanilla_root, items);
    report.failed.extend(failed);
    report
}

/// Takes a write back: replaced files come back from the trash, textures that
/// were new go to the trash (with the `.mcmeta` copied for them). The
/// recoloured files are kept in the trash too, under a new stamp. Returns the
/// number of textures put back.
pub fn undo(pack_dir: &Path, report: &WriteReport) -> Result<usize> {
    let stamp = now_ms().max(report.stamp + 1);
    let trash_root = pack_dir
        .join(PROJECT_DIR)
        .join("trash")
        .join(report.stamp.to_string());
    let mut n = 0;
    for path in &report.replaced {
        let dest = texture_file(pack_dir, path)?;
        let old: PathBuf = trash_root.join(TEXTURES_DIR).join(format!("{path}.png"));
        if !old.is_file() {
            continue;
        }
        move_to_trash(pack_dir, &dest, stamp)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).ctx(parent)?;
        }
        fs::rename(&old, &dest).ctx(&old)?;
        n += 1;
    }
    for path in &report.created {
        let dest = texture_file(pack_dir, path)?;
        if move_to_trash(pack_dir, &dest, stamp)?.is_some() {
            n += 1;
        }
        if report.created_mcmeta.contains(path) {
            move_to_trash(pack_dir, &mcmeta_file(&dest), stamp)?;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(r: u8, g: u8, b: u8, a: u8) -> Rgba<u8> {
        Rgba([r, g, b, a])
    }

    #[test]
    fn hsl_round_trip_is_exact() {
        for r in (0..=255u32).step_by(5) {
            for g in (0..=255u32).step_by(5) {
                for b in (0..=255u32).step_by(5) {
                    let c = [r as u8, g as u8, b as u8];
                    let (h, s, l) = rgb_to_hsl(c);
                    let v = hsl_to_rgb(h, s, l);
                    assert_eq!([to_u8(v[0]), to_u8(v[1]), to_u8(v[2])], c);
                }
            }
        }
    }

    #[test]
    fn zero_adjustment_and_a_full_turn_change_nothing() {
        let img = RgbaImage::from_fn(8, 8, |x, y| {
            px((x * 30) as u8, (y * 30) as u8, 77, (x * y * 4) as u8)
        });
        let zero = Recolor::Adjust(Adjust::default());
        assert_eq!(apply(&img, &zero).unwrap(), img);
        let turn = Recolor::Adjust(Adjust {
            hue: 360.0,
            ..Default::default()
        });
        assert_eq!(apply(&img, &turn).unwrap(), img);
    }

    #[test]
    fn adjustments_known_values() {
        let a = |hue, saturation, brightness, contrast| Adjust {
            hue,
            saturation,
            brightness,
            contrast,
        };
        // red turned by 120 degrees is green, by 240 is blue
        assert_eq!(a(120.0, 0.0, 0.0, 0.0).color([255, 0, 0]), [0, 255, 0]);
        assert_eq!(a(-120.0, 0.0, 0.0, 0.0).color([255, 0, 0]), [0, 0, 255]);
        // no saturation: grey of the same lightness
        assert_eq!(
            a(0.0, -100.0, 0.0, 0.0).color([200, 100, 0]),
            [100, 100, 100]
        );
        // brightness +100 is white, -100 black
        assert_eq!(a(0.0, 0.0, 100.0, 0.0).color([10, 20, 30]), [255, 255, 255]);
        assert_eq!(a(0.0, 0.0, -100.0, 0.0).color([10, 20, 30]), [0, 0, 0]);
        // contrast -100 is flat mid grey; +50 is 1.5 times the distance from the middle
        assert_eq!(
            a(0.0, 0.0, 0.0, -100.0).color([10, 200, 30]),
            [128, 128, 128]
        );
        assert_eq!(
            a(0.0, 0.0, 0.0, 50.0).color([100, 160, 128]),
            [86, 176, 128]
        );
        // brightness +20%: +51 on each channel
        assert_eq!(a(0.0, 0.0, 20.0, 0.0).color([10, 100, 250]), [61, 151, 255]);
    }

    #[test]
    fn alpha_is_kept_and_transparent_pixels_are_untouched() {
        let mut img = RgbaImage::from_pixel(2, 1, px(200, 10, 10, 128));
        img.put_pixel(1, 0, px(200, 10, 10, 0));
        let out = apply(
            &img,
            &Recolor::Adjust(Adjust {
                hue: 120.0,
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(*out.get_pixel(0, 0), px(10, 200, 10, 128));
        assert_eq!(*out.get_pixel(1, 0), px(200, 10, 10, 0));
    }

    #[test]
    fn colour_map_with_tolerance_keeps_shading() {
        let img = RgbaImage::from_fn(4, 1, |x, _| match x {
            0 => px(100, 50, 20, 255),
            1 => px(104, 50, 18, 200), // within 4 of the first colour
            2 => px(110, 50, 20, 255), // too far
            _ => px(0, 0, 255, 255),
        });
        let op = Recolor::Map {
            pairs: vec![
                MapPair {
                    from: "#643214".into(),
                    to: "#1e5a28".into(),
                },
                MapPair {
                    from: "#0000ff".into(),
                    to: "#ff0000".into(),
                },
            ],
            tolerance: 4,
        };
        let out = apply(&img, &op).unwrap();
        assert_eq!(*out.get_pixel(0, 0), px(30, 90, 40, 255));
        assert_eq!(*out.get_pixel(1, 0), px(34, 90, 38, 200));
        assert_eq!(*out.get_pixel(2, 0), px(110, 50, 20, 255));
        assert_eq!(*out.get_pixel(3, 0), px(255, 0, 0, 255));
        let bad = Recolor::Map {
            pairs: vec![MapPair {
                from: "nope".into(),
                to: "#000000".into(),
            }],
            tolerance: 0,
        };
        assert_eq!(apply(&img, &bad).unwrap_err().kind, "bad_colour");
    }

    #[test]
    fn colour_map_picks_the_closest_pair() {
        let pairs = [([10, 10, 10], [200, 0, 0]), ([14, 10, 10], [0, 200, 0])];
        assert_eq!(map_color(&pairs, 10, [13, 10, 10]), [0, 200, 0]);
        assert_eq!(map_color(&pairs, 10, [11, 10, 10]), [201, 0, 0]);
    }

    #[test]
    fn gradient_map_follows_luminance_ranks() {
        // source: 4 greys in a pattern (structure: 0 1 2 3 / 3 2 1 0)
        let greys = [20u8, 90, 160, 230];
        let source = RgbaImage::from_fn(4, 2, |x, y| {
            let g = greys[if y == 0 { x } else { 3 - x } as usize];
            px(g, g, g, if x == 3 && y == 1 { 100 } else { 255 })
        });
        // target: a ramp of 4 colours from dark to light, in shuffled order
        let ramp = [
            px(40, 10, 0, 255),
            px(90, 40, 10, 255),
            px(150, 90, 30, 255),
            px(220, 170, 90, 255),
        ];
        let target = RgbaImage::from_fn(2, 2, |x, y| ramp[[2usize, 0, 3, 1][(y * 2 + x) as usize]]);
        let out = gradient_map(&source, &target).unwrap();
        for x in 0..4 {
            let want = ramp[x as usize];
            assert_eq!(*out.get_pixel(x, 0), want);
            let back = out.get_pixel(3 - x, 1);
            assert_eq!([back[0], back[1], back[2]], [want[0], want[1], want[2]]);
        }
        // alpha comes from the source
        assert_eq!(out.get_pixel(3, 1)[3], 100);
    }

    #[test]
    fn gradient_map_keeps_structure_and_ignores_transparent_pixels() {
        let source = RgbaImage::from_fn(8, 8, |x, y| {
            if x == 0 {
                px(255, 0, 255, 0)
            } else {
                let v = ((x * 3 + y * 5) % 7 * 30) as u8;
                px(v, v / 2, v / 3, 255)
            }
        });
        let target = RgbaImage::from_fn(4, 4, |x, y| px((x * 50) as u8, (y * 40) as u8, 60, 255));
        let out = gradient_map(&source, &target).unwrap();
        // equal source colours give equal results
        let mut seen: HashMap<[u8; 4], [u8; 4]> = HashMap::new();
        for (s, o) in source.pixels().zip(out.pixels()) {
            if s[3] == 0 {
                assert_eq!(s, o, "transparent pixels stay as they are");
                continue;
            }
            let prev = seen.insert(s.0, o.0);
            assert!(prev.is_none_or(|p| p == o.0));
        }
        // only target colours are used
        let colours: std::collections::HashSet<[u8; 3]> =
            target.pixels().map(|p| [p[0], p[1], p[2]]).collect();
        assert!(out
            .pixels()
            .filter(|p| p[3] > 0)
            .all(|p| colours.contains(&[p[0], p[1], p[2]])));
        // a fully transparent target cannot be used
        let empty = RgbaImage::new(2, 2);
        assert_eq!(
            gradient_map(&source, &empty).unwrap_err().kind,
            "no_colours"
        );
    }

    #[test]
    fn gradient_map_of_a_flat_source_takes_the_middle_colour() {
        let source = RgbaImage::from_pixel(2, 2, px(5, 5, 5, 255));
        let ramp = [
            px(0, 0, 0, 255),
            px(100, 100, 100, 255),
            px(255, 255, 255, 255),
        ];
        let target = RgbaImage::from_fn(3, 1, |x, _| ramp[x as usize]);
        let out = gradient_map(&source, &target).unwrap();
        assert!(out.pixels().all(|p| *p == px(100, 100, 100, 255)));
    }

    #[test]
    fn only_the_first_frame_of_an_animated_target_is_used() {
        let target = RgbaImage::from_fn(2, 4, |_, y| {
            if y < 2 {
                px(1, 2, 3, 255)
            } else {
                px(200, 0, 0, 255)
            }
        });
        let source = RgbaImage::from_pixel(2, 2, px(50, 50, 50, 255));
        let out = gradient_map(&source, &target).unwrap();
        assert!(out.pixels().all(|p| *p == px(1, 2, 3, 255)));
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("vanilla"), tmp.path().join("pack"));
        for (tex, c) in [
            ("block/a_planks", 100u8),
            ("block/b_planks", 50),
            ("block/anim", 10),
        ] {
            let f = texture_file(&vanilla, tex).unwrap();
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            let h = if tex == "block/anim" { 4 } else { 2 };
            RgbaImage::from_pixel(2, h, px(c, c, c, 255))
                .save(&f)
                .unwrap();
            if tex == "block/anim" {
                fs::write(mcmeta_file(&f), r#"{"animation":{}}"#).unwrap();
            }
        }
        (tmp, vanilla, pack)
    }

    #[test]
    fn write_trash_and_undo() {
        let (_t, vanilla, pack) = setup();
        // the pack already has its own a_planks
        let mine = texture_file(&pack, "block/a_planks").unwrap();
        fs::create_dir_all(mine.parent().unwrap()).unwrap();
        RgbaImage::from_pixel(4, 4, px(1, 2, 3, 255))
            .save(&mine)
            .unwrap();
        let before = fs::read(&mine).unwrap();

        let op = Recolor::Adjust(Adjust {
            brightness: 20.0,
            ..Default::default()
        });
        let paths: Vec<String> = [
            "block/a_planks",
            "block/b_planks",
            "block/anim",
            "block/missing",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = recolor_and_write(&pack, &vanilla, &paths, &op, |_| 2, Upscale::Nearest);
        assert_eq!(r.replaced, vec!["block/a_planks"]);
        assert_eq!(r.created, vec!["block/b_planks", "block/anim"]);
        assert_eq!(r.created_mcmeta, vec!["block/anim"]);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].path, "block/missing");
        // the pack's own file was recoloured at its own size
        let a = image::open(&mine).unwrap().to_rgba8();
        assert_eq!(a.dimensions(), (4, 4));
        assert_eq!(*a.get_pixel(0, 0), px(52, 53, 54, 255));
        // the new one started from the game's texture at the pack resolution
        let b = image::open(texture_file(&pack, "block/b_planks").unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(b.dimensions(), (4, 4));
        assert_eq!(*b.get_pixel(3, 3), px(101, 101, 101, 255));
        // the old file is in the trash under the report's stamp
        let kept = pack
            .join(PROJECT_DIR)
            .join("trash")
            .join(r.stamp.to_string())
            .join(TEXTURES_DIR)
            .join("block/a_planks.png");
        assert_eq!(fs::read(&kept).unwrap(), before);

        // undo puts everything back as it was
        assert_eq!(undo(&pack, &r).unwrap(), 3);
        assert_eq!(fs::read(&mine).unwrap(), before);
        let b_file = texture_file(&pack, "block/b_planks").unwrap();
        assert!(!b_file.exists());
        assert!(!mcmeta_file(&texture_file(&pack, "block/anim").unwrap()).exists());
        // nothing was deleted: the recoloured files are in the trash
        let files = walkdir::WalkDir::new(pack.join(PROJECT_DIR).join("trash"))
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .count();
        assert_eq!(files, 4);
    }

    #[test]
    fn variants_take_the_target_game_colours_at_the_pack_size() {
        let (_t, vanilla, pack) = setup();
        // source: the game's a_planks at 2x (grey 100), targets: b_planks (grey 50)
        let src = load(&pack, &vanilla, "block/a_planks", 2, Upscale::Nearest).unwrap();
        assert!(!src.in_pack);
        let out = variant(&src, &vanilla, "block/b_planks").unwrap();
        assert_eq!(out.dimensions(), (4, 4));
        assert!(out.pixels().all(|p| *p == px(50, 50, 50, 255)));
        assert_eq!(
            variant(&src, &vanilla, "block/nothing").unwrap_err().kind,
            "not_found"
        );
        // written like a recolour, and undone the same way
        let r = write_all(&pack, &vanilla, vec![("block/b_planks".into(), out)]);
        assert_eq!(r.created, vec!["block/b_planks"]);
        assert_eq!(undo(&pack, &r).unwrap(), 1);
        assert!(!texture_file(&pack, "block/b_planks").unwrap().exists());
    }

    #[test]
    fn preview_is_a_small_png_of_the_first_frame() {
        let img = RgbaImage::from_pixel(128, 256, px(9, 9, 9, 255));
        let url = preview_url(&img, 128);
        let data = base64::engine::general_purpose::STANDARD
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .unwrap();
        assert_eq!(crate::textures::png_dimensions(&data), Some((64, 64)));
    }
}

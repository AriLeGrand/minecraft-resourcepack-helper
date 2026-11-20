//! Enlarging a game texture to the pack resolution when a texture is started
//! from it: hard pixels (nearest neighbour, the default) or the smooth
//! pixel-art family Scale2x / Scale3x (also known as EPX / AdvMAME2x and
//! AdvMAME3x). Both Scale algorithms only ever copy existing colours: no new
//! colour and no blur is introduced.

use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

/// How a game texture is enlarged when a pack texture is started from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Upscale {
    /// Every pixel becomes a square block of the same colour.
    #[default]
    Nearest,
    /// Scale2x / Scale3x (combined for 4× and 8×), nearest for what is left.
    Smooth,
}

/// The neighbour of (x, y) at offset (dx, dy): edges repeat the border pixel,
/// or wrap around for textures that tile (blocks).
fn at(img: &RgbaImage, x: u32, y: u32, dx: i32, dy: i32, wrap: bool) -> Rgba<u8> {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let (mut nx, mut ny) = (x as i64 + dx as i64, y as i64 + dy as i64);
    if wrap {
        nx = nx.rem_euclid(w);
        ny = ny.rem_euclid(h);
    } else {
        nx = nx.clamp(0, w - 1);
        ny = ny.clamp(0, h - 1);
    }
    *img.get_pixel(nx as u32, ny as u32)
}

/// Scale2x (EPX / AdvMAME2x). With the 3×3 neighbourhood
/// ```text
/// A B C
/// D E F
/// G H I
/// ```
/// E becomes 2×2 pixels:
/// `E0 = D==B && B!=F && D!=H ? D : E`, `E1 = B==F && B!=D && F!=H ? F : E`,
/// `E2 = D==H && D!=B && H!=F ? D : E`, `E3 = H==F && D!=H && B!=F ? F : E`.
pub fn scale2x(img: &RgbaImage, wrap: bool) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut out = RgbaImage::new(w * 2, h * 2);
    for y in 0..h {
        for x in 0..w {
            let e = *img.get_pixel(x, y);
            let b = at(img, x, y, 0, -1, wrap);
            let d = at(img, x, y, -1, 0, wrap);
            let f = at(img, x, y, 1, 0, wrap);
            let hh = at(img, x, y, 0, 1, wrap);
            let (mut e0, mut e1, mut e2, mut e3) = (e, e, e, e);
            if b != hh && d != f {
                if d == b {
                    e0 = d;
                }
                if b == f {
                    e1 = f;
                }
                if d == hh {
                    e2 = d;
                }
                if hh == f {
                    e3 = f;
                }
            }
            out.put_pixel(x * 2, y * 2, e0);
            out.put_pixel(x * 2 + 1, y * 2, e1);
            out.put_pixel(x * 2, y * 2 + 1, e2);
            out.put_pixel(x * 2 + 1, y * 2 + 1, e3);
        }
    }
    out
}

/// Scale3x (AdvMAME3x), the reference rules of the Scale2x project.
pub fn scale3x(img: &RgbaImage, wrap: bool) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut out = RgbaImage::new(w * 3, h * 3);
    for y in 0..h {
        for x in 0..w {
            let e = *img.get_pixel(x, y);
            let a = at(img, x, y, -1, -1, wrap);
            let b = at(img, x, y, 0, -1, wrap);
            let c = at(img, x, y, 1, -1, wrap);
            let d = at(img, x, y, -1, 0, wrap);
            let f = at(img, x, y, 1, 0, wrap);
            let g = at(img, x, y, -1, 1, wrap);
            let hh = at(img, x, y, 0, 1, wrap);
            let i = at(img, x, y, 1, 1, wrap);
            let mut px = [e; 9];
            if b != hh && d != f {
                px[0] = if d == b { d } else { e };
                px[1] = if (d == b && e != c) || (b == f && e != a) {
                    b
                } else {
                    e
                };
                px[2] = if b == f { f } else { e };
                px[3] = if (d == b && e != g) || (d == hh && e != a) {
                    d
                } else {
                    e
                };
                px[5] = if (b == f && e != i) || (hh == f && e != c) {
                    f
                } else {
                    e
                };
                px[6] = if d == hh { d } else { e };
                px[7] = if (d == hh && e != i) || (hh == f && e != g) {
                    hh
                } else {
                    e
                };
                px[8] = if hh == f { f } else { e };
            }
            for (k, p) in px.iter().enumerate() {
                out.put_pixel(x * 3 + (k as u32 % 3), y * 3 + (k as u32 / 3), *p);
            }
        }
    }
    out
}

/// The steps used for an enlargement by `factor`: Scale2x / Scale3x up to 8×
/// in total, then the remaining factor with hard pixels.
/// Returns (smooth steps, remaining nearest factor).
pub fn plan(factor: u32) -> (Vec<u32>, u32) {
    let mut steps = Vec::new();
    let mut rest = factor.max(1);
    let mut done = 1;
    loop {
        if rest.is_multiple_of(2) && done * 2 <= 8 {
            steps.push(2);
            done *= 2;
            rest /= 2;
        } else if rest.is_multiple_of(3) && done * 3 <= 8 {
            steps.push(3);
            done *= 3;
            rest /= 3;
        } else {
            break;
        }
    }
    (steps, rest)
}

/// Enlarges `img` by a whole `factor`. `wrap` treats the image as tiling
/// (its edges continue on the other side), used for block textures.
pub fn enlarge(img: &RgbaImage, factor: u32, method: Upscale, wrap: bool) -> RgbaImage {
    let factor = factor.max(1);
    if factor == 1 {
        return img.clone();
    }
    let nearest = |i: &RgbaImage, f: u32| {
        if f <= 1 {
            i.clone()
        } else {
            image::imageops::resize(
                i,
                i.width() * f,
                i.height() * f,
                image::imageops::FilterType::Nearest,
            )
        }
    };
    match method {
        Upscale::Nearest => nearest(img, factor),
        Upscale::Smooth => {
            let (steps, rest) = plan(factor);
            let mut cur = img.clone();
            for s in steps {
                cur = if s == 2 {
                    scale2x(&cur, wrap)
                } else {
                    scale3x(&cur, wrap)
                };
            }
            nearest(&cur, rest)
        }
    }
}

/// Enlarges an animation strip frame by frame (`frame_h` pixels each), so
/// no frame borrows pixels from its neighbour.
pub fn enlarge_strip(
    img: &RgbaImage,
    frame_h: u32,
    factor: u32,
    method: Upscale,
    wrap: bool,
) -> RgbaImage {
    let (w, h) = img.dimensions();
    let frame_h = frame_h.clamp(1, h.max(1));
    if method == Upscale::Nearest || frame_h >= h || !h.is_multiple_of(frame_h) {
        return enlarge(img, factor, method, wrap);
    }
    let factor = factor.max(1);
    let mut out = RgbaImage::new(w * factor, h * factor);
    for i in 0..h / frame_h {
        let frame = image::imageops::crop_imm(img, 0, i * frame_h, w, frame_h).to_image();
        let big = enlarge(&frame, factor, method, wrap);
        image::imageops::replace(&mut out, &big, 0, (i * frame_h * factor) as i64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: Rgba<u8> = Rgba([0, 0, 0, 255]);
    const W: Rgba<u8> = Rgba([255, 255, 255, 255]);

    /// Builds an image from rows of characters: `#` black, `.` white.
    fn pic(rows: &[&str]) -> RgbaImage {
        let h = rows.len() as u32;
        let w = rows[0].len() as u32;
        RgbaImage::from_fn(w, h, |x, y| {
            if rows[y as usize].as_bytes()[x as usize] == b'#' {
                K
            } else {
                W
            }
        })
    }

    fn rows(img: &RgbaImage) -> Vec<String> {
        (0..img.height())
            .map(|y| {
                (0..img.width())
                    .map(|x| if *img.get_pixel(x, y) == K { '#' } else { '.' })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn scale2x_rounds_a_diagonal_exactly() {
        // a 2-pixel diagonal: the classic EPX case, each step gets a filled corner
        let img = pic(&["....", ".#..", "..#.", "...."]);
        assert_eq!(
            rows(&scale2x(&img, false)),
            vec![
                "........", "........", "..##....", "..###...", "...###..", "....##..", "........",
                "........"
            ]
        );
    }

    #[test]
    fn scale2x_of_a_flat_image_and_a_single_dot_is_nearest() {
        let flat = pic(&["...", "...", "..."]);
        assert_eq!(
            scale2x(&flat, false),
            enlarge(&flat, 2, Upscale::Nearest, false)
        );
        // a lone dot has no matching neighbours: it stays a 2x2 square
        let dot = pic(&["...", ".#.", "..."]);
        assert_eq!(
            rows(&scale2x(&dot, false)),
            vec!["......", "......", "..##..", "..##..", "......", "......"]
        );
    }

    #[test]
    fn scale2x_corner_of_a_block() {
        let img = pic(&["##.", "#..", "..."]);
        assert_eq!(
            rows(&scale2x(&img, false)),
            vec!["####..", "###...", "###...", "#.....", "......", "......"]
        );
    }

    #[test]
    fn scale3x_diagonal_exactly() {
        let img = pic(&["....", ".#..", "..#.", "...."]);
        assert_eq!(
            rows(&scale3x(&img, false)),
            vec![
                "............",
                "............",
                "............",
                "...###......",
                "...###......",
                "...####.....",
                ".....####...",
                "......###...",
                "......###...",
                "............",
                "............",
                "............",
            ]
        );
    }

    #[test]
    fn scale3x_lone_dot_stays_square() {
        let dot = pic(&["...", ".#.", "..."]);
        let out = scale3x(&dot, false);
        assert_eq!(out, enlarge(&dot, 3, Upscale::Nearest, false));
    }

    #[test]
    fn only_existing_colours_are_used_and_alpha_is_kept() {
        let mut img = RgbaImage::new(4, 4);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = Rgba([
                (x * 60) as u8,
                (y * 60) as u8,
                7,
                if (x + y) % 3 == 0 { 0 } else { 255 },
            ]);
        }
        let colours: std::collections::HashSet<_> = img.pixels().copied().collect();
        for f in [2, 3, 4, 8, 16] {
            let out = enlarge(&img, f, Upscale::Smooth, true);
            assert_eq!(out.dimensions(), (4 * f, 4 * f));
            assert!(out.pixels().all(|p| colours.contains(p)), "factor {f}");
        }
    }

    #[test]
    fn plan_combines_and_leaves_the_rest_to_nearest() {
        assert_eq!(plan(2), (vec![2], 1));
        assert_eq!(plan(3), (vec![3], 1));
        assert_eq!(plan(4), (vec![2, 2], 1));
        assert_eq!(plan(8), (vec![2, 2, 2], 1));
        assert_eq!(plan(16), (vec![2, 2, 2], 2));
        assert_eq!(plan(6), (vec![2, 3], 1));
        assert_eq!(plan(5), (vec![], 5));
        assert_eq!(plan(1), (vec![], 1));
    }

    #[test]
    fn four_times_is_scale2x_twice() {
        let img = pic(&["#..", ".#.", "..#"]);
        let twice = scale2x(&scale2x(&img, false), false);
        assert_eq!(enlarge(&img, 4, Upscale::Smooth, false), twice);
    }

    #[test]
    fn wrap_is_the_middle_of_the_image_tiled_3_by_3() {
        let img = RgbaImage::from_fn(5, 4, |x, y| if (x * 7 + y * 3) % 4 == 0 { K } else { W });
        let mut tiled = RgbaImage::new(15, 12);
        for ty in 0..3 {
            for tx in 0..3 {
                image::imageops::replace(&mut tiled, &img, tx * 5, ty * 4);
            }
        }
        for (f, step) in [
            (2u32, scale2x as fn(&RgbaImage, bool) -> RgbaImage),
            (3, scale3x),
        ] {
            let big = step(&tiled, false);
            let middle = image::imageops::crop_imm(&big, 5 * f, 4 * f, 5 * f, 4 * f).to_image();
            assert_eq!(step(&img, true), middle, "factor {f}");
        }
    }

    #[test]
    fn strips_are_enlarged_frame_by_frame() {
        // two frames: a black top row in frame 0, nothing in frame 1
        let img = pic(&["##", "..", "..", ".."]);
        let out = enlarge_strip(&img, 2, 2, Upscale::Smooth, false);
        assert_eq!(out.dimensions(), (4, 8));
        let f1 = image::imageops::crop_imm(&out, 0, 4, 4, 4).to_image();
        assert!(f1.pixels().all(|p| *p == W));
    }
}

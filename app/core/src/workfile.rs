//! Editor working files.
//!
//! The pack only ever contains the flattened PNG (and `.mcmeta`). Layers,
//! frames and editor state live in `.packcreator/work/<texture>.json` and are
//! never exported. Images inside a working file are PNGs encoded as base64.

use crate::error::{CoreError, IoCtx, Result};
use crate::mcmeta::{self, Animation};
use crate::pack::{modified_ms, PROJECT_DIR};
use crate::textures::{is_safe_texture_path, mcmeta_file, png_dimensions, texture_file};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const WORK_SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayerMeta {
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    /// 0 to 100.
    pub opacity: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    /// One image per layer (same order as `layers`), base64 PNG of the frame size.
    pub cels: Vec<String>,
    /// Own duration in ticks; `None` = the animation's frame time.
    pub time: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkDoc {
    pub schema: u32,
    /// Size of one frame.
    pub width: u32,
    pub height: u32,
    /// Bottom to top.
    pub layers: Vec<LayerMeta>,
    pub frames: Vec<Frame>,
    /// Present when the texture is animated.
    pub animation: Option<Animation>,
    #[serde(default)]
    pub palette: Vec<String>,
    /// Size and time of the flattened PNG when this file was saved; used to
    /// notice that the PNG was changed by another program since.
    #[serde(default)]
    pub png_len: u64,
    #[serde(default)]
    pub png_modified_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// Layers restored from the working file.
    WorkFile,
    /// The PNG in the pack (new to the editor, or changed by another program).
    PackPng,
    /// Not in the pack yet: the game's texture, enlarged to the pack resolution.
    Vanilla,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenedDoc {
    pub path: String,
    pub doc: WorkDoc,
    pub origin: Origin,
    /// The game's texture (whole file, base64 PNG) for the reference layer and
    /// the "Original" preview. `None` when the game has no such texture.
    pub vanilla_png: Option<String>,
    pub vanilla_frames: u32,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn decode_b64(text: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| CoreError::new("bad_image", "The image data sent by the editor is damaged."))
}

pub fn work_file(pack_dir: &Path, tex_path: &str) -> Result<PathBuf> {
    if !is_safe_texture_path(tex_path) {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{tex_path}\" is not a valid texture name."),
        ));
    }
    let mut p = pack_dir.join(PROJECT_DIR).join("work");
    for seg in tex_path.split('/') {
        p.push(seg);
    }
    let name = format!(
        "{}.json",
        p.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    p.set_file_name(name);
    Ok(p)
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| CoreError::new("bad_image", format!("The image could not be encoded: {e}")))?;
    Ok(out)
}

/// Builds a one-layer document from a flattened PNG, splitting animation frames.
fn doc_from_png(png: &[u8], animation: Option<Animation>, scale: u32) -> Result<WorkDoc> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| CoreError::new("bad_image", format!("The texture could not be read: {e}")))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let frame_h = match &animation {
        Some(a) => mcmeta::frame_height(w, h, Some(a)),
        None => h,
    };
    let count = (h / frame_h.max(1)).max(1);
    let scale = scale.max(1);
    let mut frames = Vec::new();
    for i in 0..count {
        let mut frame = image::imageops::crop_imm(&img, 0, i * frame_h, w, frame_h).to_image();
        if scale > 1 {
            frame = image::imageops::resize(
                &frame,
                w * scale,
                frame_h * scale,
                image::imageops::FilterType::Nearest,
            );
        }
        frames.push(Frame {
            cels: vec![b64(&encode_png(&frame)?)],
            time: None,
        });
    }
    let mut animation = animation;
    if let Some(a) = animation.as_mut() {
        // explicit frame sizes are in pixels and must follow the enlargement
        a.width = a.width.map(|v| v * scale);
        a.height = a.height.map(|v| v * scale);
    }
    Ok(WorkDoc {
        schema: WORK_SCHEMA,
        width: w * scale,
        height: frame_h * scale,
        layers: vec![LayerMeta {
            name: "Base".into(),
            visible: true,
            locked: false,
            opacity: 100,
        }],
        frames,
        animation,
        palette: Vec::new(),
        png_len: 0,
        png_modified_ms: 0,
    })
}

fn read_animation(png: &Path) -> Option<Animation> {
    fs::read_to_string(mcmeta_file(png))
        .ok()
        .and_then(|t| mcmeta::parse_animation(&t).ok().flatten())
}

/// Opens a texture for editing. Nothing is written to disk.
///
/// `scale` enlarges the game's texture when the pack has no file yet
/// (pack resolution / 16 for blocks and items, 1 otherwise).
pub fn open(pack_dir: &Path, vanilla_root: &Path, tex_path: &str, scale: u32) -> Result<OpenedDoc> {
    let pack_png = texture_file(pack_dir, tex_path)?;
    let vanilla_file = texture_file(vanilla_root, tex_path)?;
    let vanilla_bytes = fs::read(&vanilla_file).ok();
    let vanilla_frames = match &vanilla_bytes {
        Some(b) => {
            let anim = read_animation(&vanilla_file);
            match (png_dimensions(b), &anim) {
                (Some((w, h)), Some(a)) => mcmeta::frame_count(w, h, Some(a)),
                _ => 1,
            }
        }
        None => 0,
    };
    let vanilla_png = vanilla_bytes.as_deref().map(b64);

    let (doc, origin) = if pack_png.is_file() {
        let len = fs::metadata(&pack_png).map(|m| m.len()).unwrap_or(0);
        let mtime = modified_ms(&pack_png);
        let work = fs::read_to_string(work_file(pack_dir, tex_path)?)
            .ok()
            .and_then(|t| serde_json::from_str::<WorkDoc>(&t).ok())
            .filter(|d| {
                d.schema == WORK_SCHEMA
                    && d.png_len == len
                    && d.png_modified_ms == mtime
                    && !d.frames.is_empty()
            });
        match work {
            Some(mut d) => {
                // the .mcmeta may have been edited on its own: it is the truth
                if let Some(a) = read_animation(&pack_png) {
                    d.animation = Some(a);
                }
                (d, Origin::WorkFile)
            }
            None => {
                let bytes = fs::read(&pack_png).ctx(&pack_png)?;
                (
                    doc_from_png(&bytes, read_animation(&pack_png), 1)?,
                    Origin::PackPng,
                )
            }
        }
    } else if let Some(bytes) = &vanilla_bytes {
        (
            doc_from_png(bytes, read_animation(&vanilla_file), scale)?,
            Origin::Vanilla,
        )
    } else {
        return Err(CoreError::new(
            "not_found",
            format!("There is no texture called {tex_path} in the pack or in the game."),
        ));
    };
    Ok(OpenedDoc {
        path: tex_path.to_owned(),
        doc,
        origin,
        vanilla_png,
        vanilla_frames,
    })
}

/// Saves a document: the flattened PNG (frames stacked vertically) goes into
/// the pack, the `.mcmeta` is written when the texture is animated, and the
/// layers go into the working file. Returns the document as stored.
pub fn save(pack_dir: &Path, tex_path: &str, doc: &WorkDoc, flat_png: &[u8]) -> Result<WorkDoc> {
    let Some((w, h)) = png_dimensions(flat_png) else {
        return Err(CoreError::new(
            "bad_image",
            "The editor did not produce a valid PNG.",
        ));
    };
    let expected = (doc.width, doc.height * doc.frames.len().max(1) as u32);
    if (w, h) != expected {
        return Err(CoreError::new(
            "bad_image",
            format!(
                "The flattened image is {w}×{h} but the document is {}×{}.",
                expected.0, expected.1
            ),
        ));
    }
    if doc.frames.iter().any(|f| f.cels.len() != doc.layers.len()) {
        return Err(CoreError::new(
            "bad_image",
            "Every frame must have one image per layer.",
        ));
    }
    let png = texture_file(pack_dir, tex_path)?;
    if let Some(parent) = png.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    // write next to the target, then rename: a crash never leaves half a file
    let tmp = png.with_extension("png.tmp");
    fs::write(&tmp, flat_png).ctx(&tmp)?;
    if png.exists() {
        fs::remove_file(&png).ctx(&png)?;
    }
    fs::rename(&tmp, &png).ctx(&png)?;

    let meta = mcmeta_file(&png);
    let animated = doc.animation.is_some() || doc.frames.len() > 1;
    if animated {
        let mut anim = doc.animation.clone().unwrap_or_default();
        // per-frame durations from the timeline become the frame list
        if doc.frames.iter().any(|f| f.time.is_some()) && anim.frames.is_none() {
            anim.frames = Some(
                doc.frames
                    .iter()
                    .enumerate()
                    .map(|(i, f)| mcmeta::Frame {
                        index: i as u32,
                        time: f.time,
                    })
                    .collect(),
            );
        }
        let existing = fs::read_to_string(&meta).ok();
        let text = mcmeta::write_animation(existing.as_deref(), &anim)
            .or_else(|_| mcmeta::write_animation(None, &anim))?;
        fs::write(&meta, text).ctx(&meta)?;
    }

    let mut stored = doc.clone();
    stored.schema = WORK_SCHEMA;
    stored.png_len = flat_png.len() as u64;
    stored.png_modified_ms = modified_ms(&png);
    let wf = work_file(pack_dir, tex_path)?;
    if let Some(parent) = wf.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let wtmp = wf.with_extension("json.tmp");
    fs::write(
        &wtmp,
        serde_json::to_vec(&stored).expect("work doc serialises"),
    )
    .ctx(&wtmp)?;
    if wf.exists() {
        fs::remove_file(&wf).ctx(&wf)?;
    }
    fs::rename(&wtmp, &wf).ctx(&wf)?;
    Ok(stored)
}

// ---------------------------------------------------------------- editor IPC
//
// The editor works on raw RGBA pixels so that nothing is lost in a browser
// image codec. These types carry pixels as base64 RGBA; PNG encoding and
// decoding happen here.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawFrame {
    /// One RGBA buffer per layer, base64, `width * height * 4` bytes each.
    pub cels: Vec<String>,
    pub time: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawDoc {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<LayerMeta>,
    pub frames: Vec<RawFrame>,
    pub animation: Option<Animation>,
    #[serde(default)]
    pub palette: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub rgba: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenedRaw {
    pub path: String,
    pub origin: Origin,
    pub doc: RawDoc,
    /// The game's texture (whole file) for the reference layer and previews.
    pub vanilla: Option<RawImage>,
    pub vanilla_frames: u32,
}

fn png_to_rgba(png: &[u8]) -> Result<image::RgbaImage> {
    Ok(
        image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .map_err(|e| {
                CoreError::new(
                    "bad_image",
                    format!("An image in the working file is damaged: {e}"),
                )
            })?
            .to_rgba8(),
    )
}

fn rgba_to_png(b64_rgba: &str, width: u32, height: u32) -> Result<Vec<u8>> {
    let raw = decode_b64(b64_rgba)?;
    let img = image::RgbaImage::from_raw(width, height, raw).ok_or_else(|| {
        CoreError::new("bad_image", "The editor sent an image of the wrong size.")
    })?;
    encode_png(&img)
}

/// Like [`open`], with pixels as raw RGBA for the editor.
pub fn open_raw(
    pack_dir: &Path,
    vanilla_root: &Path,
    tex_path: &str,
    scale: u32,
) -> Result<OpenedRaw> {
    let o = open(pack_dir, vanilla_root, tex_path, scale)?;
    let mut frames = Vec::new();
    for f in &o.doc.frames {
        let mut cels = Vec::new();
        for c in &f.cels {
            let img = png_to_rgba(&decode_b64(c)?)?;
            if img.dimensions() != (o.doc.width, o.doc.height) {
                return Err(CoreError::new("bad_image", "The working file does not match the texture size.")
                    .hint("Delete the .packcreator/work file of this texture; the texture itself is not affected."));
            }
            cels.push(b64(img.as_raw()));
        }
        frames.push(RawFrame { cels, time: f.time });
    }
    let vanilla = match &o.vanilla_png {
        Some(p) => {
            let img = png_to_rgba(&decode_b64(p)?)?;
            Some(RawImage {
                width: img.width(),
                height: img.height(),
                rgba: b64(img.as_raw()),
            })
        }
        None => None,
    };
    Ok(OpenedRaw {
        path: o.path,
        origin: o.origin,
        doc: RawDoc {
            width: o.doc.width,
            height: o.doc.height,
            layers: o.doc.layers,
            frames,
            animation: o.doc.animation,
            palette: o.doc.palette,
        },
        vanilla,
        vanilla_frames: o.vanilla_frames,
    })
}

/// Like [`save`], from raw RGBA. `flat_rgba` is every frame flattened and
/// stacked vertically (`width` × `height * frames`), exactly as the editor shows it.
pub fn save_raw(pack_dir: &Path, tex_path: &str, doc: &RawDoc, flat_rgba: &str) -> Result<()> {
    let count = doc.frames.len().max(1) as u32;
    let flat_png = rgba_to_png(flat_rgba, doc.width, doc.height * count)?;
    let mut frames = Vec::new();
    for f in &doc.frames {
        let mut cels = Vec::new();
        for c in &f.cels {
            cels.push(b64(&rgba_to_png(c, doc.width, doc.height)?));
        }
        frames.push(Frame { cels, time: f.time });
    }
    let work = WorkDoc {
        schema: WORK_SCHEMA,
        width: doc.width,
        height: doc.height,
        layers: doc.layers.clone(),
        frames,
        animation: doc.animation.clone(),
        palette: doc.palette.clone(),
        png_len: 0,
        png_modified_ms: 0,
    };
    save(pack_dir, tex_path, &work, &flat_png).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let (vanilla, pack) = (tmp.path().join("vanilla"), tmp.path().join("pack"));
        let v = texture_file(&vanilla, "block/stone").unwrap();
        fs::create_dir_all(v.parent().unwrap()).unwrap();
        fs::write(&v, png(16, 16, 3)).unwrap();
        let p = texture_file(&vanilla, "block/prismarine").unwrap();
        fs::write(&p, png(16, 64, 5)).unwrap();
        fs::write(
            mcmeta_file(&p),
            r#"{"animation":{"frametime":300,"interpolate":true}}"#,
        )
        .unwrap();
        (tmp, vanilla, pack)
    }

    fn cel_size(c: &str) -> (u32, u32) {
        png_dimensions(&decode_b64(c).unwrap()).unwrap()
    }

    fn flat(w: u32, h: u32, seed: u8) -> Vec<u8> {
        png(w, h, seed)
    }

    #[test]
    fn opens_the_vanilla_texture_enlarged_without_writing_anything() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!(o.origin, Origin::Vanilla);
        assert_eq!(
            (
                o.doc.width,
                o.doc.height,
                o.doc.frames.len(),
                o.doc.layers.len()
            ),
            (32, 32, 1, 1)
        );
        assert_eq!(cel_size(&o.doc.frames[0].cels[0]), (32, 32));
        assert_eq!(
            png_dimensions(&decode_b64(o.vanilla_png.as_ref().unwrap()).unwrap()),
            Some((16, 16))
        );
        assert!(!pack.exists(), "opening must not create files");
    }

    #[test]
    fn animated_vanilla_texture_is_split_into_frames() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/prismarine", 2).unwrap();
        assert_eq!((o.doc.width, o.doc.height, o.doc.frames.len()), (32, 32, 4));
        assert_eq!(o.vanilla_frames, 4);
        let a = o.doc.animation.unwrap();
        assert_eq!((a.frametime, a.interpolate), (300, true));
        // frame 2 of the document is rows 32..48 of the vanilla strip, enlarged
        let strip = image::load_from_memory(&png(16, 64, 5)).unwrap().to_rgba8();
        let f2 = image::load_from_memory(&decode_b64(&o.doc.frames[2].cels[0]).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(f2.get_pixel(6, 10), strip.get_pixel(3, 32 + 5));
    }

    #[test]
    fn save_writes_flat_png_work_file_and_mcmeta_then_reopens_with_layers() {
        let (_t, vanilla, pack) = setup();
        let mut o = open(&pack, &vanilla, "block/prismarine", 2).unwrap();
        o.doc.layers.push(LayerMeta {
            name: "Highlights".into(),
            visible: true,
            locked: false,
            opacity: 60,
        });
        for f in &mut o.doc.frames {
            let extra = f.cels[0].clone();
            f.cels.push(extra);
        }
        o.doc.palette = vec!["#7fc3b4".into()];
        let strip = flat(32, 128, 9);
        let stored = save(&pack, "block/prismarine", &o.doc, &strip).unwrap();
        let file = texture_file(&pack, "block/prismarine").unwrap();
        assert_eq!(fs::read(&file).unwrap(), strip);
        let anim = mcmeta::parse_animation(&fs::read_to_string(mcmeta_file(&file)).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!((anim.frametime, anim.interpolate), (300, true));
        assert!(work_file(&pack, "block/prismarine").unwrap().is_file());
        assert!(!file.with_extension("png.tmp").exists());

        let again = open(&pack, &vanilla, "block/prismarine", 2).unwrap();
        assert_eq!(again.origin, Origin::WorkFile);
        assert_eq!(again.doc, stored);
        assert_eq!(again.doc.layers[1].name, "Highlights");
        assert_eq!(again.doc.palette, ["#7fc3b4"]);
    }

    #[test]
    fn a_png_changed_by_another_program_wins_over_the_work_file() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).unwrap();
        // an external editor rewrites the file with different content
        let file = texture_file(&pack, "block/stone").unwrap();
        fs::write(&file, flat(32, 32, 200)).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let o2 = open(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!(o2.origin, Origin::PackPng);
        assert_eq!(
            decode_b64(&o2.doc.frames[0].cels[0])
                .map(|b| png_dimensions(&b))
                .unwrap(),
            Some((32, 32))
        );
        let px = image::load_from_memory(&decode_b64(&o2.doc.frames[0].cels[0]).unwrap())
            .unwrap()
            .to_rgba8();
        let want = image::load_from_memory(&flat(32, 32, 200))
            .unwrap()
            .to_rgba8();
        assert_eq!(px, want);
    }

    #[test]
    fn pack_png_is_opened_at_its_own_size_never_rescaled() {
        let (_t, vanilla, pack) = setup();
        let file = texture_file(&pack, "block/stone").unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, flat(37, 21, 4)).unwrap();
        let o = open(&pack, &vanilla, "block/stone", 4).unwrap();
        assert_eq!(o.origin, Origin::PackPng);
        assert_eq!((o.doc.width, o.doc.height), (37, 21));
    }

    #[test]
    fn still_texture_saves_no_mcmeta_and_per_frame_times_become_a_frame_list() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 1).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(16, 16, 1)).unwrap();
        assert!(!mcmeta_file(&texture_file(&pack, "block/stone").unwrap()).exists());

        let mut doc = o.doc.clone();
        doc.frames.push(Frame {
            cels: doc.frames[0].cels.clone(),
            time: Some(10),
        });
        save(&pack, "block/stone", &doc, &flat(16, 32, 1)).unwrap();
        let text =
            fs::read_to_string(mcmeta_file(&texture_file(&pack, "block/stone").unwrap())).unwrap();
        let a = mcmeta::parse_animation(&text).unwrap().unwrap();
        assert_eq!(
            a.frames.unwrap(),
            vec![
                mcmeta::Frame {
                    index: 0,
                    time: None
                },
                mcmeta::Frame {
                    index: 1,
                    time: Some(10)
                }
            ]
        );
    }

    #[test]
    fn save_refuses_inconsistent_data_and_keeps_the_old_file() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).unwrap();
        let file = texture_file(&pack, "block/stone").unwrap();
        assert_eq!(
            save(&pack, "block/stone", &o.doc, &flat(16, 16, 2))
                .unwrap_err()
                .kind,
            "bad_image"
        );
        assert_eq!(
            save(&pack, "block/stone", &o.doc, b"not a png")
                .unwrap_err()
                .kind,
            "bad_image"
        );
        let mut bad = o.doc.clone();
        bad.layers.push(LayerMeta {
            name: "x".into(),
            visible: true,
            locked: false,
            opacity: 100,
        });
        assert_eq!(
            save(&pack, "block/stone", &bad, &flat(32, 32, 2))
                .unwrap_err()
                .kind,
            "bad_image"
        );
        assert_eq!(fs::read(&file).unwrap(), flat(32, 32, 1));
        assert_eq!(
            open(&pack, &vanilla, "../x", 1).unwrap_err().kind,
            "bad_path"
        );
        assert_eq!(
            open(&pack, &vanilla, "block/nope", 1).unwrap_err().kind,
            "not_found"
        );
    }

    #[test]
    fn raw_round_trip_is_pixel_exact_including_transparent_colours() {
        let (_t, vanilla, pack) = setup();
        let o = open_raw(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!((o.doc.width, o.doc.height), (32, 32));
        let v = o.vanilla.as_ref().unwrap();
        assert_eq!(
            (v.width, v.height, decode_b64(&v.rgba).unwrap().len()),
            (16, 16, 16 * 16 * 4)
        );
        // pixels a browser canvas would damage: colour under zero and low alpha
        let mut px = decode_b64(&o.doc.frames[0].cels[0]).unwrap();
        px[0..4].copy_from_slice(&[200, 100, 50, 0]);
        px[4..8].copy_from_slice(&[201, 101, 51, 1]);
        px[8..12].copy_from_slice(&[13, 77, 255, 128]);
        let mut doc = o.doc.clone();
        doc.frames[0].cels[0] = b64(&px);
        save_raw(&pack, "block/stone", &doc, &b64(&px)).unwrap();
        // the PNG in the pack holds exactly these pixels
        let file = texture_file(&pack, "block/stone").unwrap();
        let on_disk = image::open(&file).unwrap().to_rgba8();
        assert_eq!(on_disk.as_raw(), &px);
        // and the editor gets them back unchanged, with its layers
        let again = open_raw(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!(again.origin, Origin::WorkFile);
        assert_eq!(decode_b64(&again.doc.frames[0].cels[0]).unwrap(), px);
        // wrong sizes are refused
        assert_eq!(
            save_raw(&pack, "block/stone", &doc, &b64(&px[..64]))
                .unwrap_err()
                .kind,
            "bad_image"
        );
    }
}

//! Editor working files.
//!
//! The pack only ever contains the flattened PNG (and `.mcmeta`). Layers,
//! frames and editor state live in `.packcreator/work/<texture>.json` and are
//! never exported. Images inside a working file are PNGs encoded as base64.

use crate::error::{CoreError, IoCtx, Result};
use crate::mcmeta::{self, Animation};
use crate::pack::{modified_ms, now_ms, PROJECT_DIR};
use crate::textures::{is_safe_texture_path, mcmeta_file, png_dimensions, texture_file};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const WORK_SCHEMA: u32 = 1;

/// Reserved "texture path" of the pack icon (`pack.png` in the pack folder).
/// It is not a valid texture name, so it can never collide with a texture.
pub const ICON_PATH: &str = ":pack-icon";
/// Editor paths starting with this name a PNG under `assets/minecraft/optifine/`
/// (connected-texture tiles), e.g. `:optifine/ctm/glass/0`.
pub const OPTIFINE_PREFIX: &str = ":optifine/";

/// The PNG of an [`OPTIFINE_PREFIX`] path (`rest` is what follows the prefix).
pub fn optifine_png(pack_dir: &Path, rest: &str) -> Result<PathBuf> {
    if !is_safe_texture_path(rest) || rest.contains('.') {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{rest}\" is not a valid OptiFine file name."),
        ));
    }
    let mut p = pack_dir.join("assets").join("minecraft").join("optifine");
    for seg in rest.split('/') {
        p.push(seg);
    }
    p.set_extension("png");
    Ok(p)
}
/// Size of a new pack icon when the pack has none.
const NEW_ICON_SIZE: u32 = 64;

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
    /// Fingerprint of the flattened PNG's bytes (0 = not recorded). The time
    /// of a file changes when a pack is copied, restored or synced; its
    /// content does not, and the layers must survive that.
    #[serde(default)]
    pub png_hash: u64,
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
    /// Not in the pack and not in the game: a new empty image (the pack icon).
    Blank,
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

/// The files one document lives in.
struct Target {
    /// The flattened image inside the pack.
    png: PathBuf,
    /// Layers and editor state (never exported).
    work: PathBuf,
    /// The game's file of the same name, when there can be one.
    vanilla: Option<PathBuf>,
}

fn target(pack_dir: &Path, vanilla_root: Option<&Path>, tex_path: &str) -> Result<Target> {
    if let Some(rest) = tex_path.strip_prefix(OPTIFINE_PREFIX) {
        let mut work = pack_dir.join(PROJECT_DIR).join("optifine-work");
        for seg in rest.split('/') {
            work.push(seg);
        }
        let png = optifine_png(pack_dir, rest)?;
        work.set_extension("json");
        return Ok(Target {
            png,
            work,
            vanilla: None,
        });
    }
    if tex_path == ICON_PATH {
        return Ok(Target {
            png: pack_dir.join("pack.png"),
            // outside `work/`, where a texture called "pack" keeps its own file
            work: pack_dir.join(PROJECT_DIR).join("icon.work.json"),
            vanilla: None,
        });
    }
    Ok(Target {
        png: texture_file(pack_dir, tex_path)?,
        work: work_file(pack_dir, tex_path)?,
        vanilla: match vanilla_root {
            Some(root) => Some(texture_file(root, tex_path)?),
            None => None,
        },
    })
}

/// FNV-1a, 64 bit: a fingerprint of a file's bytes (never 0).
pub fn content_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h.max(1)
}

/// True when the working file was saved together with exactly this PNG.
fn belongs_to(d: &WorkDoc, png: &Path) -> bool {
    let len = fs::metadata(png).map(|m| m.len()).unwrap_or(0);
    if d.png_len != len {
        return false;
    }
    if d.png_modified_ms == modified_ms(png) {
        return true;
    }
    // same size, another time: copied, restored or synced. The content decides.
    d.png_hash != 0 && fs::read(png).is_ok_and(|b| content_hash(&b) == d.png_hash)
}

fn read_work(path: &Path) -> Option<WorkDoc> {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<WorkDoc>(&t).ok())
        .filter(|d| d.schema == WORK_SCHEMA && !d.frames.is_empty())
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
    let frame_h = frame_h.max(1);
    if h % frame_h != 0 {
        // saving writes whole frames only: the leftover rows would be cut off
        return Err(CoreError::new(
            "bad_frames",
            format!(
                "This animation is {w}×{h}: its height is not a whole number of {frame_h}-pixel frames."
            ),
        )
        .hint(format!(
            "Make the image height a multiple of {frame_h}, or correct the frame size in its .mcmeta file, then open it again. Nothing was changed."
        )));
    }
    let count = (h / frame_h).max(1);
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
        png_hash: 0,
    })
}

/// A new empty one-layer document (the pack icon of a pack that has none).
fn blank_doc(size: u32) -> Result<WorkDoc> {
    let empty = image::RgbaImage::new(size, size);
    Ok(WorkDoc {
        schema: WORK_SCHEMA,
        width: size,
        height: size,
        layers: vec![LayerMeta {
            name: "Base".into(),
            visible: true,
            locked: false,
            opacity: 100,
        }],
        frames: vec![Frame {
            cels: vec![b64(&encode_png(&empty)?)],
            time: None,
        }],
        animation: None,
        palette: Vec::new(),
        png_len: 0,
        png_modified_ms: 0,
        png_hash: 0,
    })
}

fn read_animation(png: &Path) -> Option<Animation> {
    fs::read_to_string(mcmeta_file(png))
        .ok()
        .and_then(|t| mcmeta::parse_animation(&t).ok().flatten())
}

/// The working file (layers) of an editor path, for code that moves it away.
pub fn work_file_of(pack_dir: &Path, tex_path: &str) -> Result<PathBuf> {
    Ok(target(pack_dir, None, tex_path)?.work)
}

/// Opens a texture (or the pack icon, [`ICON_PATH`]) for editing. Nothing is
/// written to disk.
///
/// `scale` enlarges the game's texture when the pack has no file yet
/// (pack resolution / 16 for blocks and items, 1 otherwise).
pub fn open(pack_dir: &Path, vanilla_root: &Path, tex_path: &str, scale: u32) -> Result<OpenedDoc> {
    let t = target(pack_dir, Some(vanilla_root), tex_path)?;
    let pack_png = &t.png;
    let vanilla = t
        .vanilla
        .as_ref()
        .and_then(|file| fs::read(file).ok().map(|bytes| (file, bytes)));
    let vanilla_frames = match &vanilla {
        Some((file, b)) => {
            let anim = read_animation(file);
            match (png_dimensions(b), &anim) {
                (Some((w, h)), Some(a)) => mcmeta::frame_count(w, h, Some(a)),
                _ => 1,
            }
        }
        None => 0,
    };
    let vanilla_png = vanilla.as_ref().map(|(_, b)| b64(b));

    let (doc, origin) = if pack_png.is_file() {
        // the layers are only used when they belong to exactly this PNG;
        // a PNG changed by another program wins and opens as one layer
        match read_work(&t.work).filter(|d| belongs_to(d, pack_png)) {
            Some(mut d) => {
                // the .mcmeta may have been edited on its own: it is the truth
                if let Some(a) = read_animation(pack_png) {
                    d.animation = Some(a);
                }
                (d, Origin::WorkFile)
            }
            None => {
                let bytes = fs::read(pack_png).ctx(pack_png)?;
                (
                    doc_from_png(&bytes, read_animation(pack_png), 1)?,
                    Origin::PackPng,
                )
            }
        }
    } else if let Some((file, bytes)) = &vanilla {
        (
            doc_from_png(bytes, read_animation(file), scale)?,
            Origin::Vanilla,
        )
    } else if tex_path == ICON_PATH {
        (blank_doc(NEW_ICON_SIZE)?, Origin::Blank)
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

/// `name.ext` -> `name.ext.<suffix>`, next to the file.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

/// Renames over the target (a rename replaces an existing file on Windows
/// too). Another program (virus scanner, thumbnailer) may hold a freshly
/// written file for a moment, so a refusal is tried again a few times.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if tries >= 4 => return Err(e),
            Err(_) => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
    }
}

fn discard(files: &[&PathBuf]) {
    for f in files {
        let _ = fs::remove_file(f);
    }
}

/// Per-frame durations stored with the images (the timeline).
fn frame_times(doc: &WorkDoc) -> Vec<Option<u32>> {
    doc.frames.iter().map(|f| f.time).collect()
}

/// The animation that a save writes: per-frame times become a frame list
/// when there is no explicit play order, and the play order is checked
/// against the number of images.
pub fn effective_animation(
    animation: Option<&Animation>,
    times: &[Option<u32>],
    image_count: usize,
) -> Result<Animation> {
    let mut anim = animation.cloned().unwrap_or_default();
    if times.iter().any(Option::is_some) && anim.frames.is_none() {
        anim.frames = Some(
            times
                .iter()
                .enumerate()
                .map(|(i, t)| mcmeta::Frame {
                    index: i as u32,
                    time: *t,
                })
                .collect(),
        );
    }
    if let Some(list) = &anim.frames {
        if let Some(bad) = list.iter().find(|f| f.index as usize >= image_count) {
            return Err(CoreError::new(
                "bad_frames",
                format!(
                    "The frame order uses frame {} but the texture only has {image_count} frame(s).",
                    bad.index + 1
                ),
            )
            .hint("Edit the frame order in the animation settings so it only uses existing frames."));
        }
        if list.is_empty() {
            return Err(CoreError::new("bad_frames", "The frame order is empty.")
                .hint("Add at least one frame to the frame order, or choose \"In order\"."));
        }
    }
    Ok(anim)
}

/// The `.mcmeta` text for `anim`, keeping every other key of `existing`.
pub fn merged_mcmeta(existing: Option<&str>, anim: &Animation) -> Result<String> {
    mcmeta::write_animation(existing, anim).or_else(|_| mcmeta::write_animation(None, anim))
}

/// What a save would write into `<texture>.png.mcmeta` (shown in the
/// animation screen before saving). Uses the pack's current file, if any.
pub fn mcmeta_preview(
    pack_dir: &Path,
    tex_path: &str,
    animation: Option<&Animation>,
    times: &[Option<u32>],
    image_count: usize,
) -> Result<String> {
    let t = target(pack_dir, None, tex_path)?;
    let anim = effective_animation(animation, times, image_count)?;
    let existing = fs::read_to_string(mcmeta_file(&t.png)).ok();
    merged_mcmeta(existing.as_deref(), &anim)
}

/// Reads any image as raw RGBA, exactly (used by "Import strip").
pub fn read_image_raw(path: &Path) -> Result<RawImage> {
    let data = fs::read(path).ctx(path)?;
    let img = image::load_from_memory(&data)
        .map_err(|_| {
            CoreError::new(
                "bad_image",
                format!("{} is not an image this app can read.", path.display()),
            )
            .hint("Use a PNG file (JPEG, BMP and GIF also work).")
        })?
        .to_rgba8();
    Ok(RawImage {
        width: img.width(),
        height: img.height(),
        rgba: b64(img.as_raw()),
    })
}

/// Saves a document: the flattened PNG (frames stacked vertically) goes into
/// the pack, the `.mcmeta` is written when the texture is animated, and the
/// layers go into the working file. Returns the document as stored.
///
/// Everything is first written to temporary files next to the targets; only
/// then are they renamed over the old files. When a step fails, the old PNG
/// and the old working file are both still there and no temporary file is
/// left behind.
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
    let t = target(pack_dir, None, tex_path)?;
    let (png, wf) = (&t.png, &t.work);
    let meta = mcmeta_file(png);

    // 1. everything that can fail without touching a file
    let animated = doc.animation.is_some() || doc.frames.len() > 1;
    let meta_text = if animated {
        let anim =
            effective_animation(doc.animation.as_ref(), &frame_times(doc), doc.frames.len())?;
        let existing = fs::read_to_string(&meta).ok();
        Some(merged_mcmeta(existing.as_deref(), &anim)?)
    } else {
        None
    };
    // Layers that do not belong to the PNG on disk (it was changed outside
    // the editor, so they were not used when it was opened) are not thrown
    // away by this save: they go to the trash folder.
    let had_work = wf.is_file();
    let old_work_is_stale = had_work && !read_work(wf).is_some_and(|d| belongs_to(&d, png));

    // 2. write the new files next to the old ones
    let tmp = sibling(png, "tmp");
    let wtmp = sibling(wf, "tmp");
    let mtmp = sibling(&meta, "tmp");
    let backup = sibling(wf, "bak");
    let mut stored = doc.clone();
    let staged = (|| -> Result<()> {
        for file in [png, wf] {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).ctx(parent)?;
            }
        }
        fs::write(&tmp, flat_png).ctx(&tmp)?;
        stored.schema = WORK_SCHEMA;
        stored.png_len = flat_png.len() as u64;
        // a rename keeps the time of the file
        stored.png_modified_ms = modified_ms(&tmp);
        stored.png_hash = content_hash(flat_png);
        fs::write(
            &wtmp,
            serde_json::to_vec(&stored).expect("work doc serialises"),
        )
        .ctx(&wtmp)?;
        if let Some(text) = &meta_text {
            fs::write(&mtmp, text).ctx(&mtmp)?;
        }
        Ok(())
    })();
    if let Err(e) = staged {
        discard(&[&tmp, &wtmp, &mtmp]);
        return Err(e);
    }

    // 3. swap them in; the old working file is kept until the PNG is in place
    let committed = (|| -> Result<()> {
        if had_work {
            replace_file(wf, &backup).map_err(|e| CoreError::io(wf, &e))?;
        }
        if let Err(e) = replace_file(&wtmp, wf) {
            if had_work {
                let _ = replace_file(&backup, wf);
            }
            return Err(CoreError::io(wf, &e));
        }
        if let Err(e) = replace_file(&tmp, png) {
            let _ = fs::remove_file(wf);
            if had_work {
                let _ = replace_file(&backup, wf);
            }
            return Err(CoreError::io(png, &e));
        }
        Ok(())
    })();
    if let Err(e) = committed {
        discard(&[&tmp, &wtmp, &mtmp]);
        return Err(e);
    }
    if had_work {
        let kept = pack_dir
            .join(PROJECT_DIR)
            .join("trash")
            .join(now_ms().to_string())
            .join(wf.strip_prefix(pack_dir).unwrap_or(wf));
        let moved = old_work_is_stale
            && kept.parent().is_some_and(|p| fs::create_dir_all(p).is_ok())
            && fs::rename(&backup, &kept).is_ok();
        if !moved {
            let _ = fs::remove_file(&backup);
        }
    }
    if meta_text.is_some() {
        if let Err(e) = replace_file(&mtmp, &meta) {
            discard(&[&mtmp]);
            return Err(CoreError::io(&meta, &e));
        }
    }
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
        png_hash: 0,
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

    fn set_time(file: &Path, secs_from_now: u64) {
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(secs_from_now);
        fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(later)
            .unwrap();
    }

    fn files_named(dir: &Path, ending: &str) -> Vec<PathBuf> {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file() && e.file_name().to_string_lossy().ends_with(ending)
            })
            .map(|e| e.into_path())
            .collect()
    }

    #[test]
    fn layers_survive_a_changed_file_time_when_the_content_is_the_same() {
        let (_t, vanilla, pack) = setup();
        let mut o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        o.doc.layers[0].name = "Mine".into();
        let stored = save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).unwrap();
        assert_eq!(stored.png_hash, content_hash(&flat(32, 32, 1)));
        // copied, restored from a backup, synced, checked out: new time, same bytes
        let file = texture_file(&pack, "block/stone").unwrap();
        set_time(&file, 3600);
        let again = open(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!(again.origin, Origin::WorkFile);
        assert_eq!(again.doc.layers[0].name, "Mine");
        // a working file from before the fingerprint existed still needs the time
        let wf = work_file(&pack, "block/stone").unwrap();
        let mut old: WorkDoc = serde_json::from_str(&fs::read_to_string(&wf).unwrap()).unwrap();
        old.png_hash = 0;
        fs::write(&wf, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(
            open(&pack, &vanilla, "block/stone", 2).unwrap().origin,
            Origin::PackPng
        );
    }

    #[test]
    fn a_save_that_cannot_write_its_files_changes_nothing() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).unwrap();
        let file = texture_file(&pack, "block/stone").unwrap();
        let wf = work_file(&pack, "block/stone").unwrap();
        let layers_before = fs::read(&wf).unwrap();
        // the working file cannot be written: a folder is in the way of its temporary file
        let blocker = sibling(&wf, "tmp");
        fs::create_dir_all(blocker.join("x")).unwrap();
        assert!(save(&pack, "block/stone", &o.doc, &flat(32, 32, 2)).is_err());
        // the PNG in the pack was not replaced, the layers still belong to it
        assert_eq!(fs::read(&file).unwrap(), flat(32, 32, 1));
        assert_eq!(fs::read(&wf).unwrap(), layers_before);
        assert!(files_named(&pack, ".png.tmp").is_empty());
        assert_eq!(
            open(&pack, &vanilla, "block/stone", 2).unwrap().origin,
            Origin::WorkFile
        );
        // once the way is free the same save goes through and leaves nothing behind
        fs::remove_dir_all(&blocker).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 2)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), flat(32, 32, 2));
        assert!(files_named(&pack, ".tmp").is_empty());
        assert!(files_named(&pack, ".bak").is_empty());
    }

    #[test]
    fn a_save_whose_png_cannot_be_replaced_puts_the_old_layers_back() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        // something that cannot be renamed over sits where the PNG belongs
        let file = texture_file(&pack, "block/stone").unwrap();
        fs::create_dir_all(file.join("in the way")).unwrap();
        let wf = work_file(&pack, "block/stone").unwrap();
        fs::create_dir_all(wf.parent().unwrap()).unwrap();
        fs::write(&wf, b"the layers from before").unwrap();
        assert!(save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).is_err());
        assert_eq!(fs::read(&wf).unwrap(), b"the layers from before");
        assert!(file.is_dir());
        assert!(files_named(&pack, ".tmp").is_empty());
        assert!(files_named(&pack, ".bak").is_empty());
    }

    #[test]
    fn layers_that_were_not_used_at_open_go_to_the_trash_when_saved_over() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/stone", 2).unwrap();
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 1)).unwrap();
        let trash = pack.join(PROJECT_DIR).join("trash");
        // a normal save over its own layers keeps nothing extra
        save(&pack, "block/stone", &o.doc, &flat(32, 32, 2)).unwrap();
        assert!(files_named(&trash, ".json").is_empty());
        let wf = work_file(&pack, "block/stone").unwrap();
        let old_layers = fs::read(&wf).unwrap();
        // another program changes the PNG: the layers no longer belong to it
        let file = texture_file(&pack, "block/stone").unwrap();
        fs::write(&file, flat(32, 32, 200)).unwrap();
        set_time(&file, 5);
        let o2 = open(&pack, &vanilla, "block/stone", 2).unwrap();
        assert_eq!(o2.origin, Origin::PackPng);
        save(&pack, "block/stone", &o2.doc, &flat(32, 32, 3)).unwrap();
        let kept = files_named(&trash, "stone.json");
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(&kept[0]).unwrap(), old_layers);
        assert!(files_named(&pack, ".bak").is_empty());
    }

    #[test]
    fn an_animation_with_leftover_rows_is_not_opened_and_not_changed() {
        let (_t, vanilla, pack) = setup();
        let file = texture_file(&pack, "block/prismarine").unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        // 16×40 with 16-pixel frames: two frames and 8 rows that fit nowhere
        fs::write(&file, flat(16, 40, 7)).unwrap();
        fs::write(mcmeta_file(&file), r#"{"animation":{"frametime":2}}"#).unwrap();
        let err = open(&pack, &vanilla, "block/prismarine", 1).unwrap_err();
        assert_eq!(err.kind, "bad_frames");
        assert!(err.message.contains("16×40"));
        assert!(err.hint.unwrap().contains("multiple of 16"));
        assert_eq!(fs::read(&file).unwrap(), flat(16, 40, 7));
        // the same image without the animation file is a plain 16×40 texture
        fs::remove_file(mcmeta_file(&file)).unwrap();
        let o = open(&pack, &vanilla, "block/prismarine", 1).unwrap();
        assert_eq!((o.doc.width, o.doc.height, o.doc.frames.len()), (16, 40, 1));
        // and a whole number of frames opens as before
        fs::write(&file, flat(16, 48, 7)).unwrap();
        fs::write(mcmeta_file(&file), r#"{"animation":{"frametime":2}}"#).unwrap();
        let o = open(&pack, &vanilla, "block/prismarine", 1).unwrap();
        assert_eq!((o.doc.width, o.doc.height, o.doc.frames.len()), (16, 16, 3));
    }

    #[test]
    fn the_pack_icon_opens_and_saves_as_pack_png_with_its_own_layers() {
        let (_t, vanilla, pack) = setup();
        // no icon yet: a new empty square, nothing written
        let o = open(&pack, &vanilla, ICON_PATH, 4).unwrap();
        assert_eq!(o.origin, Origin::Blank);
        assert_eq!((o.doc.width, o.doc.height, o.doc.frames.len()), (64, 64, 1));
        assert!(o.vanilla_png.is_none());
        assert!(!pack.exists());
        save(&pack, ICON_PATH, &o.doc, &flat(64, 64, 9)).unwrap();
        assert_eq!(fs::read(pack.join("pack.png")).unwrap(), flat(64, 64, 9));
        assert!(pack.join(PROJECT_DIR).join("icon.work.json").is_file());
        assert!(!pack.join("pack.png.mcmeta").exists());
        assert!(!pack.join("assets").exists());
        assert_eq!(
            open(&pack, &vanilla, ICON_PATH, 4).unwrap().origin,
            Origin::WorkFile
        );
        // an icon made elsewhere opens at its own size, never rescaled
        fs::write(pack.join("pack.png"), flat(48, 48, 2)).unwrap();
        set_time(&pack.join("pack.png"), 5);
        let o = open(&pack, &vanilla, ICON_PATH, 4).unwrap();
        assert_eq!(o.origin, Origin::PackPng);
        assert_eq!((o.doc.width, o.doc.height), (48, 48));
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

    #[test]
    fn mcmeta_preview_matches_what_save_writes_and_checks_the_order() {
        let (_t, vanilla, pack) = setup();
        let o = open(&pack, &vanilla, "block/prismarine", 2).unwrap();
        let file = texture_file(&pack, "block/prismarine").unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            mcmeta_file(&file),
            r#"{"texture":{"blur":true},"animation":{"frametime":9}}"#,
        )
        .unwrap();
        let mut anim = o.doc.animation.clone().unwrap();
        anim.frametime = 2;
        anim.frames = Some(
            [0, 1, 2, 3, 2, 1]
                .iter()
                .map(|&i| mcmeta::Frame {
                    index: i,
                    time: None,
                })
                .collect(),
        );
        let times = vec![None; 4];
        let text = mcmeta_preview(&pack, "block/prismarine", Some(&anim), &times, 4).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["texture"]["blur"], true);
        assert_eq!(
            v["animation"]["frames"],
            serde_json::json!([0, 1, 2, 3, 2, 1])
        );
        let mut doc = o.doc.clone();
        doc.animation = Some(anim.clone());
        save(&pack, "block/prismarine", &doc, &flat(32, 128, 3)).unwrap();
        assert_eq!(fs::read_to_string(mcmeta_file(&file)).unwrap(), text);
        // an order that points past the last image is refused
        let e = mcmeta_preview(&pack, "block/prismarine", Some(&anim), &times, 3).unwrap_err();
        assert_eq!(e.kind, "bad_frames");
        doc.frames.pop();
        assert_eq!(
            save(&pack, "block/prismarine", &doc, &flat(32, 96, 3))
                .unwrap_err()
                .kind,
            "bad_frames"
        );
        assert_eq!(
            fs::read_to_string(mcmeta_file(&file)).unwrap(),
            text,
            "a refused save changes nothing"
        );
        // per-frame times without an explicit order become a frame list
        let a = effective_animation(None, &[None, Some(10)], 2).unwrap();
        assert_eq!(
            a.frames.unwrap()[1],
            mcmeta::Frame {
                index: 1,
                time: Some(10)
            }
        );
        assert!(effective_animation(None, &[None, None], 2)
            .unwrap()
            .frames
            .is_none());
    }

    #[test]
    fn read_image_raw_is_pixel_exact() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("strip.png");
        fs::write(&p, png(16, 64, 7)).unwrap();
        let r = read_image_raw(&p).unwrap();
        assert_eq!((r.width, r.height), (16, 64));
        let want = image::load_from_memory(&png(16, 64, 7)).unwrap().to_rgba8();
        assert_eq!(decode_b64(&r.rgba).unwrap(), want.into_raw());
        fs::write(tmp.path().join("x.txt"), "nope").unwrap();
        assert_eq!(
            read_image_raw(&tmp.path().join("x.txt")).unwrap_err().kind,
            "bad_image"
        );
    }
}

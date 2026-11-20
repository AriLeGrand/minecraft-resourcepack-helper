//! Texture `.png.mcmeta` files: the `animation` section.
//!
//! Other sections (`texture`, `villager`, `gui`) and unknown keys are kept
//! untouched when a file is rewritten.

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Length of one game tick in milliseconds (20 ticks per second).
pub const TICK_MS: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub index: u32,
    /// Own duration in ticks; `None` = the animation's `frametime`.
    pub time: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Animation {
    /// Ticks per frame (default 1).
    pub frametime: u32,
    pub interpolate: bool,
    /// Play order. `None` = every frame top to bottom.
    pub frames: Option<Vec<Frame>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl Default for Animation {
    fn default() -> Self {
        Self {
            frametime: 1,
            interpolate: false,
            frames: None,
            width: None,
            height: None,
        }
    }
}

fn parse_root(text: &str) -> Result<Map<String, Value>> {
    let text = text.trim_start_matches('\u{feff}');
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(CoreError::new(
            "bad_mcmeta",
            "The .mcmeta file is not a JSON object.",
        )),
        Err(e) => Err(CoreError::new(
            "bad_mcmeta",
            format!("The .mcmeta file is not valid JSON: {e}"),
        )
        .hint("Fix the file in a text editor, or delete it and create the animation again.")),
    }
}

/// Reads the `animation` section. `Ok(None)` when the file has none.
pub fn parse_animation(text: &str) -> Result<Option<Animation>> {
    let root = parse_root(text)?;
    let Some(Value::Object(a)) = root.get("animation") else {
        return Ok(None);
    };
    let num = |k: &str| {
        a.get(k)
            .and_then(Value::as_u64)
            .map(|n| n.min(u64::from(u32::MAX)) as u32)
    };
    let frames = a.get("frames").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|f| match f {
                Value::Number(n) => n.as_u64().map(|i| Frame {
                    index: i as u32,
                    time: None,
                }),
                Value::Object(o) => o.get("index").and_then(Value::as_u64).map(|i| Frame {
                    index: i as u32,
                    time: o.get("time").and_then(Value::as_u64).map(|t| t as u32),
                }),
                _ => None,
            })
            .collect::<Vec<_>>()
    });
    Ok(Some(Animation {
        frametime: num("frametime").unwrap_or(1).max(1),
        interpolate: a
            .get("interpolate")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        frames,
        width: num("width"),
        height: num("height"),
    }))
}

/// Writes the animation into `existing` (or a new file), keeping every other
/// key. Returns pretty JSON with a trailing newline.
pub fn write_animation(existing: Option<&str>, anim: &Animation) -> Result<String> {
    let mut root = match existing {
        Some(t) if !t.trim().is_empty() => parse_root(t)?,
        _ => Map::new(),
    };
    let mut a = match root.get("animation") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    if anim.frametime > 1 {
        a.insert("frametime".into(), json!(anim.frametime));
    } else {
        a.remove("frametime");
    }
    if anim.interpolate {
        a.insert("interpolate".into(), json!(true));
    } else {
        a.remove("interpolate");
    }
    match &anim.frames {
        Some(frames) => {
            let list: Vec<Value> = frames
                .iter()
                .map(|f| match f.time {
                    Some(t) => json!({"index": f.index, "time": t}),
                    None => json!(f.index),
                })
                .collect();
            a.insert("frames".into(), Value::Array(list));
        }
        None => {
            a.remove("frames");
        }
    }
    for (key, val) in [("width", anim.width), ("height", anim.height)] {
        match val {
            Some(v) => a.insert(key.into(), json!(v)),
            None => a.remove(key),
        };
    }
    root.insert("animation".into(), Value::Object(a));
    let mut s = serde_json::to_string_pretty(&Value::Object(root)).expect("mcmeta serialises");
    s.push('\n');
    Ok(s)
}

/// Number of frames stored in an image of `width`×`height`.
/// Frames are square unless the animation says otherwise.
pub fn frame_count(width: u32, height: u32, anim: Option<&Animation>) -> u32 {
    let fw = anim.and_then(|a| a.width).unwrap_or(width).max(1);
    let fh = anim.and_then(|a| a.height).unwrap_or(fw).max(1);
    (height / fh).max(1)
}

/// Height in pixels of one frame.
pub fn frame_height(width: u32, height: u32, anim: Option<&Animation>) -> u32 {
    let fw = anim.and_then(|a| a.width).unwrap_or(width).max(1);
    anim.and_then(|a| a.height)
        .unwrap_or(fw)
        .clamp(1, height.max(1))
}

/// A tall image whose height is a whole multiple of its width looks like
/// animation frames. Returns the number of frames (2 or more).
pub fn strip_frames(width: u32, height: u32) -> Option<u32> {
    (width > 0 && height > width && height.is_multiple_of(width)).then(|| height / width)
}

/// Total loop length in ticks.
pub fn loop_ticks(frames_in_image: u32, anim: &Animation) -> u64 {
    match &anim.frames {
        Some(list) => list
            .iter()
            .map(|f| u64::from(f.time.unwrap_or(anim.frametime)))
            .sum(),
        None => u64::from(frames_in_image) * u64::from(anim.frametime),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_vanilla_examples() {
        // shapes found in real jars
        let a = parse_animation(r#"{"animation":{"frametime":2}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(
            (a.frametime, a.interpolate, a.frames.clone()),
            (2, false, None)
        );
        let a = parse_animation(
            r#"{"animation":{"frametime":300,"interpolate":true,"frames":[0,1,0,2]}}"#,
        )
        .unwrap()
        .unwrap();
        assert!(a.interpolate);
        assert_eq!(
            a.frames
                .unwrap()
                .iter()
                .map(|f| f.index)
                .collect::<Vec<_>>(),
            [0, 1, 0, 2]
        );
        let a = parse_animation(r#"{"animation":{"frames":[16,17]}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(a.frametime, 1);
        let a = parse_animation(r#"{"animation":{}}"#).unwrap().unwrap();
        assert_eq!(a, Animation::default());
    }

    #[test]
    fn non_animation_files() {
        assert_eq!(
            parse_animation(r#"{"texture":{"blur":true}}"#).unwrap(),
            None
        );
        assert_eq!(
            parse_animation(r#"{"gui":{"scaling":{"type":"nine_slice"}}}"#).unwrap(),
            None
        );
        assert_eq!(parse_animation("{ nope").unwrap_err().kind, "bad_mcmeta");
        assert_eq!(parse_animation("[1]").unwrap_err().kind, "bad_mcmeta");
    }

    #[test]
    fn object_frames_are_kept() {
        let text = r#"{"animation":{"frametime":4,"frames":[0,{"index":1,"time":10},2]}}"#;
        let a = parse_animation(text).unwrap().unwrap();
        assert_eq!(
            a.frames.as_ref().unwrap()[1],
            Frame {
                index: 1,
                time: Some(10)
            }
        );
        let back = parse_animation(&write_animation(Some(text), &a).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(back, a);
        assert_eq!(loop_ticks(3, &a), 4 + 10 + 4);
    }

    #[test]
    fn round_trip_and_foreign_keys_survive() {
        let text = r#"{"texture":{"blur":true},"animation":{"frametime":2,"custom":"keep me"},"villager":{"hat":"full"}}"#;
        let mut a = parse_animation(text).unwrap().unwrap();
        a.frametime = 5;
        a.interpolate = true;
        a.frames = Some(vec![
            Frame {
                index: 0,
                time: None,
            },
            Frame {
                index: 1,
                time: None,
            },
        ]);
        let out = write_animation(Some(text), &a).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["texture"]["blur"], true);
        assert_eq!(v["villager"]["hat"], "full");
        assert_eq!(v["animation"]["custom"], "keep me");
        assert_eq!(v["animation"]["frametime"], 5);
        assert_eq!(v["animation"]["frames"], json!([0, 1]));
        assert_eq!(parse_animation(&out).unwrap().unwrap(), a);
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn new_file_is_minimal() {
        let out = write_animation(None, &Animation::default()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"animation": {}})
        );
        let out = write_animation(
            None,
            &Animation {
                frametime: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"animation": {"frametime": 2}})
        );
    }

    #[test]
    fn frame_maths() {
        assert_eq!(frame_count(16, 512, None), 32);
        assert_eq!(frame_count(16, 16, None), 1);
        let a = Animation {
            height: Some(32),
            ..Default::default()
        };
        assert_eq!(frame_count(16, 64, Some(&a)), 2);
        assert_eq!(frame_height(16, 64, Some(&a)), 32);
        assert_eq!(frame_height(16, 64, None), 16);
        assert_eq!(strip_frames(16, 64), Some(4));
        assert_eq!(strip_frames(16, 16), None);
        assert_eq!(strip_frames(16, 40), None);
        assert_eq!(strip_frames(64, 32), None);
        assert_eq!(
            loop_ticks(
                6,
                &Animation {
                    frametime: 2,
                    ..Default::default()
                }
            ),
            12
        );
    }

    /// Every `.mcmeta` of the game versions extracted on this computer reads
    /// back unchanged after being rewritten (developer machines only: skipped
    /// when there is no extracted cache).
    #[test]
    fn every_extracted_vanilla_mcmeta_round_trips() {
        let cache = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target/devdata/cache/vanilla");
        let Ok(versions) = std::fs::read_dir(&cache) else {
            return;
        };
        let mut checked = 0;
        for v in versions.flatten() {
            for e in walkdir::WalkDir::new(v.path()).into_iter().flatten() {
                if !e.file_name().to_string_lossy().ends_with(".png.mcmeta") {
                    continue;
                }
                let text = std::fs::read_to_string(e.path()).unwrap();
                let original: Value =
                    serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
                let Some(anim) = parse_animation(&text).unwrap() else {
                    continue;
                };
                let rewritten: Value =
                    serde_json::from_str(&write_animation(Some(&text), &anim).unwrap()).unwrap();
                assert_eq!(
                    parse_animation(&rewritten.to_string()).unwrap().unwrap(),
                    anim,
                    "{}",
                    e.path().display()
                );
                // nothing outside the animation section changes
                for (k, val) in original.as_object().unwrap() {
                    if k != "animation" {
                        assert_eq!(&rewritten[k], val, "{}", e.path().display());
                    }
                }
                checked += 1;
            }
        }
        eprintln!("round-tripped {checked} vanilla .mcmeta files");
    }
}

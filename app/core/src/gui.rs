//! How an interface sprite stretches: the `gui.scaling` section of
//! `textures/gui/sprites/<group>/<name>.png.mcmeta` (1.20.2 and newer).
//!
//! ```json
//! {"gui": {"scaling": {"type": "nine_slice", "width": 200, "height": 20, "border": 3}}}
//! ```
//!
//! `type` is `stretch` (also what no file means), `tile` or `nine_slice`.
//! `width` / `height` are the sprite's size in GUI pixels (a 2× image is
//! still 200×20). `border` is one number or `{left, top, right, bottom}`;
//! `stretch_inner` (1.21.5+) stretches the edges and centre instead of
//! tiling them. Every other key of the file (an `animation`, unknown keys,
//! unknown keys inside `gui` and `scaling`) is kept when the file is rewritten.
//!
//! Which file the game uses: the `.mcmeta` is looked up in the packs from the
//! top down to the pack that provides the PNG. So a pack's `.mcmeta` alone
//! overrides the game's one, but a pack PNG **without** its own `.mcmeta` is
//! stretched (the game's file below it is never read). See [`effective`].

use crate::error::{CoreError, IoCtx, Result};
use crate::textures::{mcmeta_file, texture_file};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Border {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl Border {
    pub fn all(n: u32) -> Self {
        Self {
            left: n,
            top: n,
            right: n,
            bottom: n,
        }
    }
    fn is_uniform(&self) -> bool {
        self.left == self.top && self.top == self.right && self.right == self.bottom
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Scaling {
    Stretch,
    Tile {
        width: u32,
        height: u32,
    },
    NineSlice {
        width: u32,
        height: u32,
        border: Border,
        #[serde(default)]
        stretch_inner: bool,
    },
}

fn bad(msg: impl Into<String>) -> CoreError {
    CoreError::new("bad_mcmeta", msg)
        .hint("Fix the .mcmeta file in a text editor, or pick a stretch rule again to rewrite it.")
}

fn parse_root(text: &str) -> Result<Map<String, Value>> {
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(bad("The .mcmeta file is not a JSON object.")),
        Err(e) => Err(bad(format!("The .mcmeta file is not valid JSON: {e}"))),
    }
}

fn size_of(s: &Map<String, Value>, kind: &str) -> Result<(u32, u32)> {
    let num = |k: &str| {
        s.get(k)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= u64::from(u32::MAX))
            .map(|n| n as u32)
    };
    match (num("width"), num("height")) {
        (Some(w), Some(h)) => Ok((w, h)),
        _ => Err(bad(format!(
            "The {kind} scaling needs a positive \"width\" and \"height\"."
        ))),
    }
}

fn parse_border(v: Option<&Value>) -> Result<Border> {
    let n = |v: &Value| v.as_u64().map(|n| n.min(u64::from(u32::MAX)) as u32);
    match v {
        Some(Value::Number(_)) => {
            Ok(Border::all(n(v.unwrap()).ok_or_else(|| {
                bad("The nine-slice border must be a whole number of pixels.")
            })?))
        }
        Some(Value::Object(o)) => {
            let side = |k: &str| {
                o.get(k).and_then(n).ok_or_else(|| {
                    bad(format!(
                        "The nine-slice border object needs \"left\", \"top\", \"right\" and \"bottom\" (missing \"{k}\")."
                    ))
                })
            };
            Ok(Border {
                left: side("left")?,
                top: side("top")?,
                right: side("right")?,
                bottom: side("bottom")?,
            })
        }
        _ => Err(bad("The nine-slice scaling needs a \"border\".")),
    }
}

/// The `gui.scaling` section. `Ok(None)` when the file has none (the sprite
/// is then stretched, unless a lower pack decides; see [`effective`]).
pub fn parse_scaling(text: &str) -> Result<Option<Scaling>> {
    let root = parse_root(text)?;
    let Some(Value::Object(gui)) = root.get("gui") else {
        return Ok(None);
    };
    let Some(Value::Object(s)) = gui.get("scaling") else {
        return Ok(None);
    };
    match s.get("type").and_then(Value::as_str) {
        Some("stretch") => Ok(Some(Scaling::Stretch)),
        Some("tile") => {
            let (width, height) = size_of(s, "tile")?;
            Ok(Some(Scaling::Tile { width, height }))
        }
        Some("nine_slice") => {
            let (width, height) = size_of(s, "nine-slice")?;
            Ok(Some(Scaling::NineSlice {
                width,
                height,
                border: parse_border(s.get("border"))?,
                stretch_inner: s
                    .get("stretch_inner")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }))
        }
        Some(other) => Err(bad(format!(
            "\"{other}\" is not a stretch rule the game knows (stretch, tile or nine_slice)."
        ))),
        None => Err(bad("The scaling section has no \"type\".")),
    }
}

fn is_known(key: &str) -> bool {
    matches!(
        key,
        "type" | "width" | "height" | "border" | "stretch_inner"
    )
}

/// Writes `scaling` into `existing` (or a new file), keeping every other key.
/// `Stretch` removes the section (and `gui` when it becomes empty) unless
/// `explicit_stretch` asks for `{"type": "stretch"}` to be written: that is
/// needed when a lower pack (the game) would otherwise decide. Returns
/// `None` when nothing is left, so the file should not exist; otherwise
/// pretty JSON with a trailing newline.
pub fn write_scaling(
    existing: Option<&str>,
    scaling: &Scaling,
    explicit_stretch: bool,
) -> Result<Option<String>> {
    let mut root = match existing {
        Some(t) if !t.trim().is_empty() => parse_root(t)?,
        _ => Map::new(),
    };
    let mut gui = match root.get("gui") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    let old = match gui.get("scaling") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    if *scaling == Scaling::Stretch && !explicit_stretch {
        gui.remove("scaling");
    } else {
        let mut s = Map::new();
        match scaling {
            Scaling::Stretch => {
                s.insert("type".into(), json!("stretch"));
            }
            Scaling::Tile { width, height } => {
                s.insert("type".into(), json!("tile"));
                s.insert("width".into(), json!(width));
                s.insert("height".into(), json!(height));
            }
            Scaling::NineSlice {
                width,
                height,
                border,
                stretch_inner,
            } => {
                s.insert("type".into(), json!("nine_slice"));
                s.insert("width".into(), json!(width));
                s.insert("height".into(), json!(height));
                let b = if border.is_uniform() {
                    json!(border.left)
                } else {
                    json!({"left": border.left, "top": border.top, "right": border.right, "bottom": border.bottom})
                };
                s.insert("border".into(), b);
                // written when on, or kept when the file already said it
                if *stretch_inner || old.contains_key("stretch_inner") {
                    s.insert("stretch_inner".into(), json!(stretch_inner));
                }
            }
        }
        for (k, v) in &old {
            if !is_known(k) {
                s.insert(k.clone(), v.clone());
            }
        }
        gui.insert("scaling".into(), Value::Object(s));
    }
    if gui.is_empty() {
        root.remove("gui");
    } else {
        root.insert("gui".into(), Value::Object(gui));
    }
    if root.is_empty() {
        return Ok(None);
    }
    let mut s = serde_json::to_string_pretty(&Value::Object(root)).expect("mcmeta serialises");
    s.push('\n');
    Ok(Some(s))
}

// ------------------------------------------------------------ files

/// Where the stretch rule that applies now comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScalingSource {
    /// The pack's own `.mcmeta`.
    Pack,
    /// The pack has the PNG but no `.mcmeta`: the game stretches it.
    PackPngOnly,
    /// The game's own file (or no file at all: stretch).
    Game,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScalingState {
    /// The rule the game uses with this pack.
    pub scaling: Scaling,
    pub source: ScalingSource,
    /// The game's own rule.
    pub vanilla: Scaling,
    pub pack_has_png: bool,
    /// Text of the pack's `.mcmeta` (`None` = no file).
    pub pack_mcmeta: Option<String>,
    /// Text of the game's `.mcmeta` (`None` = no file).
    pub vanilla_mcmeta: Option<String>,
    /// The pack's file could not be read as a stretch rule.
    pub error: Option<String>,
}

fn read_opt(file: &Path) -> Option<String> {
    fs::read_to_string(file).ok()
}

/// The stretch rule that applies to a sprite with this pack (see the module notes).
pub fn effective(pack: &Path, vanilla: &Path, tex: &str) -> Result<ScalingState> {
    let png = texture_file(pack, tex)?;
    let pack_has_png = png.is_file();
    let pack_mcmeta = read_opt(&mcmeta_file(&png));
    let vanilla_mcmeta = read_opt(&mcmeta_file(&texture_file(vanilla, tex)?));
    let vanilla_rule = vanilla_mcmeta
        .as_deref()
        .and_then(|t| parse_scaling(t).ok().flatten())
        .unwrap_or(Scaling::Stretch);
    let mut error = None;
    let (scaling, source) = if let Some(t) = &pack_mcmeta {
        match parse_scaling(t) {
            Ok(s) => (s.unwrap_or(Scaling::Stretch), ScalingSource::Pack),
            Err(e) => {
                error = Some(e.message);
                (Scaling::Stretch, ScalingSource::Pack)
            }
        }
    } else if pack_has_png {
        (Scaling::Stretch, ScalingSource::PackPngOnly)
    } else {
        (vanilla_rule.clone(), ScalingSource::Game)
    };
    Ok(ScalingState {
        scaling,
        source,
        vanilla: vanilla_rule,
        pack_has_png,
        pack_mcmeta,
        vanilla_mcmeta,
        error,
    })
}

fn same_json(a: &str, b: &str) -> bool {
    let p = |t: &str| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok();
    matches!((p(a), p(b)), (Some(x), Some(y)) if x == y)
}

/// The text the pack's `.mcmeta` would have with this rule (`None` = no
/// file). The base is the pack's file; when the pack has neither the file
/// nor the PNG it is the game's file, so its other sections (an animation)
/// still apply once the pack's file hides it. A result that says exactly
/// what the game's file says, for a PNG the pack does not have, is no file.
pub fn planned(state: &ScalingState, scaling: &Scaling) -> Result<Option<String>> {
    let base = match (&state.pack_mcmeta, state.pack_has_png) {
        (Some(t), _) => Some(t.as_str()),
        (None, false) => state.vanilla_mcmeta.as_deref(),
        (None, true) => None,
    };
    // removing the section only means "stretch" when nothing below decides
    let explicit = !state.pack_has_png && state.vanilla != Scaling::Stretch;
    let text = match write_scaling(base, scaling, explicit) {
        Ok(t) => t,
        // a broken file of the pack is replaced
        Err(_) if state.pack_mcmeta.is_some() => write_scaling(None, scaling, explicit)?,
        Err(e) => return Err(e),
    };
    if !state.pack_has_png {
        let same = match (&text, &state.vanilla_mcmeta) {
            (Some(t), Some(v)) => same_json(t, v),
            (None, None) => true,
            _ => false,
        };
        if same {
            return Ok(None);
        }
    }
    Ok(text)
}

/// The text the pack's `.mcmeta` would have with this rule (`None` = no file).
pub fn preview(
    pack: &Path,
    vanilla: &Path,
    tex: &str,
    scaling: &Scaling,
) -> Result<Option<String>> {
    planned(&effective(pack, vanilla, tex)?, scaling)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MetaChange {
    /// The pack's file before (`None` = there was none), for Undo.
    pub before: Option<String>,
    /// The pack's file now (`None` = removed).
    pub after: Option<String>,
}

fn check_rule(s: &Scaling) -> Result<()> {
    let tiny = |w: u32, h: u32| w == 0 || h == 0 || w > 4096 || h > 4096;
    match s {
        Scaling::Stretch => Ok(()),
        Scaling::Tile { width, height } | Scaling::NineSlice { width, height, .. }
            if tiny(*width, *height) =>
        {
            Err(CoreError::new(
                "bad_scaling",
                "The width and height must be between 1 and 4096 GUI pixels.",
            ))
        }
        Scaling::NineSlice {
            width,
            height,
            border,
            ..
        } if border.left + border.right > *width || border.top + border.bottom > *height => {
            Err(CoreError::new(
                "bad_scaling",
                format!("The borders do not fit: left + right must be at most {width} and top + bottom at most {height}."),
            )
            .hint("Make the borders smaller."))
        }
        _ => Ok(()),
    }
}

/// Writes `text` as the pack's `.mcmeta` of `tex` (`None` removes the file).
pub fn put_mcmeta(pack: &Path, tex: &str, text: Option<&str>) -> Result<()> {
    let meta = mcmeta_file(&texture_file(pack, tex)?);
    match text {
        Some(t) => {
            if let Some(dir) = meta.parent() {
                fs::create_dir_all(dir).ctx(dir)?;
            }
            let tmp = meta.with_extension("mcmeta.tmp");
            fs::write(&tmp, t).ctx(&tmp)?;
            if let Err(e) = fs::rename(&tmp, &meta) {
                let _ = fs::remove_file(&tmp);
                return Err(CoreError::io(&meta, &e));
            }
        }
        None => {
            if meta.is_file() {
                fs::remove_file(&meta).ctx(&meta)?;
            }
        }
    }
    Ok(())
}

/// Sets the stretch rule of a sprite in the pack. Returns the file before and after.
pub fn set_scaling(
    pack: &Path,
    vanilla: &Path,
    tex: &str,
    scaling: &Scaling,
) -> Result<MetaChange> {
    check_rule(scaling)?;
    let state = effective(pack, vanilla, tex)?;
    let after = planned(&state, scaling)?;
    if after != state.pack_mcmeta {
        put_mcmeta(pack, tex, after.as_deref())?;
    }
    Ok(MetaChange {
        before: state.pack_mcmeta,
        after,
    })
}

/// After a sprite's PNG is first added to the pack: when the pack has no
/// `.mcmeta` for it, the game's `gui` section is copied, so the new image
/// stretches the way the game's did (without it the game would stretch the
/// whole image). Returns whether a file was written.
pub fn keep_vanilla_scaling(pack: &Path, vanilla: &Path, tex: &str) -> Result<bool> {
    if !tex.starts_with("gui/sprites/") {
        return Ok(false);
    }
    let meta = mcmeta_file(&texture_file(pack, tex)?);
    if meta.exists() {
        return Ok(false);
    }
    let Some(text) = read_opt(&mcmeta_file(&texture_file(vanilla, tex)?)) else {
        return Ok(false);
    };
    let Ok(root) = parse_root(&text) else {
        return Ok(false);
    };
    let Some(gui) = root.get("gui") else {
        return Ok(false);
    };
    let mut s = serde_json::to_string_pretty(&json!({ "gui": gui })).expect("mcmeta serialises");
    s.push('\n');
    put_mcmeta(pack, tex, Some(&s))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil;

    fn png(w: u32, h: u32) -> Vec<u8> {
        testutil::png(w, h, 7)
    }

    fn nine(w: u32, h: u32, b: Border) -> Scaling {
        Scaling::NineSlice {
            width: w,
            height: h,
            border: b,
            stretch_inner: false,
        }
    }

    #[test]
    fn reads_the_vanilla_shapes() {
        let s = parse_scaling(
            r#"{"gui":{"scaling":{"type":"nine_slice","width":200,"height":20,"border":3}}}"#,
        )
        .unwrap();
        assert_eq!(s, Some(nine(200, 20, Border::all(3))));
        let s = parse_scaling(r#"{"gui":{"scaling":{"type":"nine_slice","width":8,"height":20,"border":{"left":2,"top":2,"right":2,"bottom":3}}}}"#).unwrap();
        assert_eq!(
            s,
            Some(nine(
                8,
                20,
                Border {
                    left: 2,
                    top: 2,
                    right: 2,
                    bottom: 3
                }
            ))
        );
        let s = parse_scaling(r#"{"gui":{"scaling":{"type":"nine_slice","width":100,"height":100,"border":10,"stretch_inner":true}}}"#).unwrap();
        assert!(matches!(
            s,
            Some(Scaling::NineSlice {
                stretch_inner: true,
                ..
            })
        ));
        assert_eq!(
            parse_scaling(r#"{"gui":{"scaling":{"type":"tile","width":16,"height":8}}}"#).unwrap(),
            Some(Scaling::Tile {
                width: 16,
                height: 8
            })
        );
        assert_eq!(
            parse_scaling(r#"{"gui":{"scaling":{"type":"stretch"}}}"#).unwrap(),
            Some(Scaling::Stretch)
        );
        assert_eq!(
            parse_scaling(r#"{"animation":{"frametime":2}}"#).unwrap(),
            None
        );
        assert_eq!(parse_scaling(r#"{"gui":{}}"#).unwrap(), None);
    }

    #[test]
    fn broken_rules_are_clear_errors() {
        for t in [
            r#"{"gui":{"scaling":{"type":"wobble"}}}"#,
            r#"{"gui":{"scaling":{"type":"tile","width":16}}}"#,
            r#"{"gui":{"scaling":{"type":"nine_slice","width":16,"height":16}}}"#,
            r#"{"gui":{"scaling":{"type":"nine_slice","width":16,"height":16,"border":{"left":1}}}}"#,
            r#"{"gui":{"scaling":{}}}"#,
            "{ nope",
            "[]",
        ] {
            assert_eq!(parse_scaling(t).unwrap_err().kind, "bad_mcmeta", "{t}");
        }
    }

    #[test]
    fn writes_like_the_game_and_keeps_other_keys() {
        let text = r#"{"animation":{"frametime":2},"gui":{"other":1,"scaling":{"type":"nine_slice","width":200,"height":20,"border":3,"note":"mine"}},"x":true}"#;
        let out = write_scaling(
            Some(text),
            &Scaling::Tile {
                width: 20,
                height: 10,
            },
            false,
        )
        .unwrap()
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["animation"]["frametime"], 2);
        assert_eq!(v["x"], true);
        assert_eq!(v["gui"]["other"], 1);
        assert_eq!(
            v["gui"]["scaling"],
            json!({"type": "tile", "width": 20, "height": 10, "note": "mine"})
        );
        assert!(out.ends_with('\n'));
        // the keys of the scaling come in the game's order
        assert!(out.find("\"type\"").unwrap() < out.find("\"width\"").unwrap());
        let out = write_scaling(
            None,
            &nine(
                8,
                20,
                Border {
                    left: 2,
                    top: 2,
                    right: 2,
                    bottom: 3,
                },
            ),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"gui": {"scaling": {"type": "nine_slice", "width": 8, "height": 20, "border": {"left": 2, "top": 2, "right": 2, "bottom": 3}}}})
        );
        // four equal borders are one number, like the game's files
        let out = write_scaling(None, &nine(200, 20, Border::all(3)), false)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"gui": {"scaling": {"type": "nine_slice", "width": 200, "height": 20, "border": 3}}})
        );
    }

    #[test]
    fn stretch_removes_the_section_and_an_empty_file() {
        let only =
            r#"{"gui":{"scaling":{"type":"nine_slice","width":200,"height":20,"border":3}}}"#;
        assert_eq!(
            write_scaling(Some(only), &Scaling::Stretch, false).unwrap(),
            None
        );
        let with_anim = r#"{"animation":{"frametime":2},"gui":{"scaling":{"type":"tile","width":2,"height":2}}}"#;
        let out = write_scaling(Some(with_anim), &Scaling::Stretch, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"animation": {"frametime": 2}})
        );
        let keep_gui = r#"{"gui":{"other":1,"scaling":{"type":"tile","width":2,"height":2}}}"#;
        let out = write_scaling(Some(keep_gui), &Scaling::Stretch, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"gui": {"other": 1}})
        );
        // when the game's file would decide, "stretch" has to be written
        let out = write_scaling(None, &Scaling::Stretch, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"gui": {"scaling": {"type": "stretch"}}})
        );
        assert_eq!(write_scaling(None, &Scaling::Stretch, false).unwrap(), None);
    }

    #[test]
    fn stretch_inner_is_kept() {
        let t = r#"{"gui":{"scaling":{"type":"nine_slice","width":100,"height":100,"border":10,"stretch_inner":true}}}"#;
        let s = parse_scaling(t).unwrap().unwrap();
        let out = write_scaling(Some(t), &s, false).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            serde_json::from_str::<Value>(t).unwrap()
        );
        // an explicit false stays explicit
        let t = r#"{"gui":{"scaling":{"type":"nine_slice","width":10,"height":10,"border":2,"stretch_inner":false}}}"#;
        let out = write_scaling(Some(t), &parse_scaling(t).unwrap().unwrap(), false)
            .unwrap()
            .unwrap();
        assert!(out.contains("\"stretch_inner\": false"));
    }

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let pack = d.path().join("pack");
        let game = d.path().join("game");
        let file = texture_file(&game, "gui/sprites/widget/button").unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, png(200, 20)).unwrap();
        fs::write(
            mcmeta_file(&file),
            r#"{"gui":{"scaling":{"type":"nine_slice","width":200,"height":20,"border":3}}}"#,
        )
        .unwrap();
        let plain = texture_file(&game, "gui/sprites/hud/hotbar").unwrap();
        fs::create_dir_all(plain.parent().unwrap()).unwrap();
        fs::write(&plain, png(182, 22)).unwrap();
        (d, pack, game)
    }

    const BTN: &str = "gui/sprites/widget/button";

    #[test]
    fn which_rule_applies() {
        let (_d, pack, game) = setup();
        let s = effective(&pack, &game, BTN).unwrap();
        assert_eq!(s.source, ScalingSource::Game);
        assert_eq!(s.scaling, nine(200, 20, Border::all(3)));
        // a pack PNG without its own .mcmeta is stretched
        let p = texture_file(&pack, BTN).unwrap();
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, png(400, 40)).unwrap();
        let s = effective(&pack, &game, BTN).unwrap();
        assert_eq!(
            (s.source, s.scaling.clone()),
            (ScalingSource::PackPngOnly, Scaling::Stretch)
        );
        assert_eq!(s.vanilla, nine(200, 20, Border::all(3)));
        // the pack's .mcmeta decides, even a broken one (reported)
        fs::write(mcmeta_file(&p), "{ nope").unwrap();
        let s = effective(&pack, &game, BTN).unwrap();
        assert_eq!(s.source, ScalingSource::Pack);
        assert!(s.error.is_some());
        let s = effective(&pack, &game, "gui/sprites/hud/hotbar").unwrap();
        assert_eq!(
            (s.source, s.scaling),
            (ScalingSource::Game, Scaling::Stretch)
        );
    }

    #[test]
    fn set_scaling_writes_and_removes_files() {
        let (_d, pack, game) = setup();
        let meta = mcmeta_file(&texture_file(&pack, BTN).unwrap());
        // no PNG in the pack: tile overrides the game's file
        let c = set_scaling(
            &pack,
            &game,
            BTN,
            &Scaling::Tile {
                width: 200,
                height: 20,
            },
        )
        .unwrap();
        assert_eq!(c.before, None);
        assert_eq!(fs::read_to_string(&meta).unwrap(), c.after.clone().unwrap());
        // stretch has to be written out, or the game's nine-slice would apply
        let c = set_scaling(&pack, &game, BTN, &Scaling::Stretch).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&c.after.unwrap()).unwrap(),
            json!({"gui": {"scaling": {"type": "stretch"}}})
        );
        // the game's own rule again: the pack needs no file
        set_scaling(&pack, &game, BTN, &nine(200, 20, Border::all(3))).unwrap();
        assert!(!meta.exists());
        // with the PNG in the pack, stretch removes the file
        let p = texture_file(&pack, BTN).unwrap();
        fs::write(&p, png(200, 20)).unwrap();
        set_scaling(&pack, &game, BTN, &nine(200, 20, Border::all(4))).unwrap();
        assert!(meta.exists());
        let c = set_scaling(&pack, &game, BTN, &Scaling::Stretch).unwrap();
        assert_eq!(c.after, None);
        assert!(!meta.exists());
        // an animation in the pack's file survives
        fs::write(&meta, r#"{"animation":{"frametime":2}}"#).unwrap();
        set_scaling(&pack, &game, BTN, &nine(200, 20, Border::all(3))).unwrap();
        set_scaling(&pack, &game, BTN, &Scaling::Stretch).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&fs::read_to_string(&meta).unwrap()).unwrap(),
            json!({"animation": {"frametime": 2}})
        );
    }

    #[test]
    fn rules_that_cannot_work_are_refused() {
        let (_d, pack, game) = setup();
        for s in [
            nine(10, 10, Border::all(6)),
            Scaling::Tile {
                width: 0,
                height: 4,
            },
            nine(
                10,
                10,
                Border {
                    left: 0,
                    top: 9,
                    right: 0,
                    bottom: 2,
                },
            ),
        ] {
            assert_eq!(
                set_scaling(&pack, &game, BTN, &s).unwrap_err().kind,
                "bad_scaling"
            );
        }
        assert!(!mcmeta_file(&texture_file(&pack, BTN).unwrap()).exists());
    }

    #[test]
    fn undo_restores_the_exact_text() {
        let (_d, pack, game) = setup();
        let meta = mcmeta_file(&texture_file(&pack, BTN).unwrap());
        fs::create_dir_all(meta.parent().unwrap()).unwrap();
        let mine = "{\"gui\":{\"scaling\":{\"type\":\"tile\",\"width\":4,\"height\":4}}}";
        fs::write(&meta, mine).unwrap();
        let c = set_scaling(&pack, &game, BTN, &nine(200, 20, Border::all(2))).unwrap();
        put_mcmeta(&pack, BTN, c.before.as_deref()).unwrap();
        assert_eq!(fs::read_to_string(&meta).unwrap(), mine);
        put_mcmeta(&pack, BTN, None).unwrap();
        assert!(!meta.exists());
    }

    #[test]
    fn a_new_pack_sprite_keeps_the_games_rule() {
        let (_d, pack, game) = setup();
        let p = texture_file(&pack, BTN).unwrap();
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, png(200, 20)).unwrap();
        assert!(keep_vanilla_scaling(&pack, &game, BTN).unwrap());
        assert_eq!(
            effective(&pack, &game, BTN).unwrap().scaling,
            nine(200, 20, Border::all(3))
        );
        // never twice, never over the pack's own file, nothing for plain sprites
        assert!(!keep_vanilla_scaling(&pack, &game, BTN).unwrap());
        assert!(!keep_vanilla_scaling(&pack, &game, "gui/sprites/hud/hotbar").unwrap());
        assert!(!keep_vanilla_scaling(&pack, &game, "block/stone").unwrap());
    }

    /// Every GUI `.mcmeta` of the game versions extracted on this computer
    /// reads back unchanged after being rewritten (developer machines only:
    /// skipped when there is no extracted cache).
    #[test]
    fn every_extracted_vanilla_gui_mcmeta_round_trips() {
        let cache = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/devdata/cache/vanilla");
        let Ok(versions) = fs::read_dir(&cache) else {
            return;
        };
        let mut checked = 0;
        for v in versions.flatten() {
            let sprites = v.path().join("assets/minecraft/textures/gui");
            for e in walkdir::WalkDir::new(&sprites).into_iter().flatten() {
                if !e.file_name().to_string_lossy().ends_with(".png.mcmeta") {
                    continue;
                }
                let text = fs::read_to_string(e.path()).unwrap();
                let original: Value =
                    serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
                let Some(rule) = parse_scaling(&text).unwrap() else {
                    continue;
                };
                let out = write_scaling(Some(&text), &rule, false).unwrap().unwrap();
                let rewritten: Value = serde_json::from_str(&out).unwrap();
                assert_eq!(
                    parse_scaling(&out).unwrap().unwrap(),
                    rule,
                    "{}",
                    e.path().display()
                );
                // the game's files come back identical, key for key
                assert_eq!(rewritten, original, "{}", e.path().display());
                checked += 1;
            }
        }
        eprintln!("round-tripped {checked} vanilla GUI .mcmeta files");
    }
}

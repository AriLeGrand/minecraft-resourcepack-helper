//! The Scene screen: the blocks of a small diorama, and the custom scene the
//! user builds (kept in `.packcreator/scene.json`, never exported).
//!
//! A block is named by its id (`oak_planks`). Its shape is the model of its
//! default blockstate: the blockstate file `blockstates/<id>.json` names the
//! model per state; the variant closest to the game's default state is taken
//! (`axis=y`, `half=bottom`, `facing=north`, …) and its `x` / `y` rotation is
//! ignored. A multipart block (fences, walls) gets the parts that always apply.
//! Without a blockstate file (old or hand-made game folders) the model of the
//! same name is used.

use crate::error::{CoreError, IoCtx, Result};
use crate::models::{self, BlockModel};
use crate::pack::PROJECT_DIR;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Largest custom scene: width × depth × height.
pub const MAX_WIDTH: u32 = 8;
pub const MAX_DEPTH: u32 = 8;
pub const MAX_HEIGHT: u32 = 4;
/// Version of `scene.json`.
pub const SCENE_VERSION: u32 = 1;
/// Most models a multipart block gets (the parts without a condition).
const MAX_PARTS: usize = 8;

/// Property values of the game's default block states, used to pick the
/// variant that a newly placed block shows.
const DEFAULT_PROPS: [&str; 18] = [
    "axis=y",
    "facing=north",
    "half=bottom",
    "half=lower",
    "type=bottom",
    "shape=straight",
    "snowy=false",
    "waterlogged=false",
    "lit=false",
    "open=false",
    "powered=false",
    "hinge=left",
    "age=0",
    "stage=0",
    "level=0",
    "persistent=false",
    "distance=7",
    "face=floor",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SceneBlock {
    pub id: String,
    /// The models drawn for this block (one, or several parts of a multipart).
    pub models: Vec<BlockModel>,
    /// Why nothing can be drawn (no model, a broken file…).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SceneFile {
    pub version: u32,
    pub width: u32,
    pub depth: u32,
    pub height: u32,
    /// Block id per cell, `""` for air; index `(y * depth + z) * width + x`.
    pub blocks: Vec<String>,
}

/// Block ids are plain lowercase names (`oak_planks`).
pub fn is_block_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn bad_block(id: &str) -> CoreError {
    CoreError::new("bad_block", format!("\"{id}\" is not a valid block name."))
        .hint("Block names look like oak_planks.")
}

fn blockstates_dir(root: &Path) -> PathBuf {
    root.join("assets").join("minecraft").join("blockstates")
}

/// Reads `blockstates/<id>.json`, the pack's first. `Ok(None)` when neither has it.
fn load_blockstate(pack: Option<&Path>, vanilla: &Path, id: &str) -> Result<Option<Value>> {
    let roots = pack.into_iter().chain(std::iter::once(vanilla));
    for root in roots {
        let file = blockstates_dir(root).join(format!("{id}.json"));
        let text = match fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(CoreError::io(&file, &e)),
        };
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| {
            CoreError::new(
                "bad_blockstate",
                format!(
                    "The blockstate file {} is not valid JSON: {e}",
                    file.display()
                ),
            )
        })?;
        return Ok(Some(v));
    }
    Ok(None)
}

/// `{"model": ...}` or a weighted list of them: the (first) model name.
fn model_of(v: &Value) -> Option<String> {
    let o = match v {
        Value::Array(a) => a.first()?,
        other => other,
    };
    o.get("model")?.as_str().map(str::to_owned)
}

/// How close a variant key (`axis=y,lit=false`) is to the default state.
fn default_score(key: &str) -> usize {
    key.split(',')
        .filter(|p| DEFAULT_PROPS.contains(&p.trim()))
        .count()
}

/// The model names a blockstate file gives the block's default state.
pub fn models_from_blockstate(state: &Value) -> Vec<String> {
    if let Some(vars) = state.get("variants").and_then(Value::as_object) {
        // "" (no properties) or 1.8.9's "normal" win; otherwise the best score, first on ties
        let exact = vars.get("").or_else(|| vars.get("normal"));
        let chosen = exact.or_else(|| {
            let mut best: Option<(&String, &Value)> = None;
            for (k, v) in vars {
                if best.is_none_or(|(bk, _)| default_score(k) > default_score(bk)) {
                    best = Some((k, v));
                }
            }
            best.map(|(_, v)| v)
        });
        return chosen.and_then(model_of).into_iter().collect();
    }
    if let Some(parts) = state.get("multipart").and_then(Value::as_array) {
        let mut out: Vec<String> = parts
            .iter()
            .filter(|p| p.get("when").is_none())
            .filter_map(|p| p.get("apply").and_then(model_of))
            .take(MAX_PARTS)
            .collect();
        if out.is_empty() {
            out.extend(
                parts
                    .first()
                    .and_then(|p| p.get("apply"))
                    .and_then(model_of),
            );
        }
        return out;
    }
    Vec::new()
}

/// The model names drawn for a block in its default state.
pub fn default_models(pack: Option<&Path>, vanilla: &Path, id: &str) -> Result<Vec<String>> {
    if !is_block_id(id) {
        return Err(bad_block(id));
    }
    match load_blockstate(pack, vanilla, id)? {
        Some(state) => {
            let names = models_from_blockstate(&state);
            if names.is_empty() {
                return Err(CoreError::new(
                    "bad_blockstate",
                    format!("The blockstate of {id} names no model."),
                ));
            }
            Ok(names)
        }
        None => Ok(vec![format!("block/{id}")]),
    }
}

/// Resolves the blocks of a scene (each id once). A block that cannot be
/// drawn comes back with an `error` instead of failing the whole scene.
pub fn scene_blocks(pack: Option<&Path>, vanilla: &Path, ids: &[String]) -> Vec<SceneBlock> {
    let unique: BTreeSet<&String> = ids.iter().filter(|i| !i.is_empty()).collect();
    unique
        .into_iter()
        .map(|id| {
            let resolved = default_models(pack, vanilla, id).and_then(|names| {
                names
                    .iter()
                    .map(|n| models::block_model(pack, vanilla, n))
                    .collect::<Result<Vec<_>>>()
            });
            match resolved {
                Ok(list) => {
                    let drawable: Vec<BlockModel> = list
                        .into_iter()
                        .filter(|m| m.builtin.is_none() && !m.elements.is_empty())
                        .collect();
                    let error = drawable.is_empty().then(|| {
                        format!("{id} is drawn by the game's code; the scene leaves it out.")
                    });
                    SceneBlock {
                        id: id.clone(),
                        models: drawable,
                        error,
                    }
                }
                Err(e) => SceneBlock {
                    id: id.clone(),
                    models: Vec::new(),
                    error: Some(e.message),
                },
            }
        })
        .collect()
}

fn json_stems(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension().and_then(|x| x.to_str()) == Some("json"))
                .then(|| p.file_stem()?.to_str().map(str::to_owned))
                .flatten()
        })
        .filter(|s| is_block_id(s))
        .collect()
}

/// Every block the scene can place, sorted: the blockstate files of the game
/// and the pack. A game folder without blockstates offers its block models
/// that are complete blocks (every face has a texture), not templates such as
/// `cube_all`.
pub fn list_blocks(pack: Option<&Path>, vanilla: &Path) -> Vec<String> {
    let roots: Vec<&Path> = pack.into_iter().chain(std::iter::once(vanilla)).collect();
    let mut out = BTreeSet::new();
    for r in &roots {
        out.extend(json_stems(&blockstates_dir(r)));
    }
    if out.is_empty() {
        for r in &roots {
            let dir = r
                .join("assets")
                .join("minecraft")
                .join("models")
                .join("block");
            for stem in json_stems(&dir) {
                let Ok(m) = models::block_model(pack, vanilla, &format!("block/{stem}")) else {
                    continue;
                };
                let complete = m.builtin.is_none()
                    && !m.elements.is_empty()
                    && m.elements
                        .iter()
                        .flat_map(|e| e.faces.values())
                        .all(|f| f.texture.is_some());
                if complete {
                    out.insert(stem);
                }
            }
        }
    }
    out.into_iter().collect()
}

fn scene_file(pack_dir: &Path) -> PathBuf {
    pack_dir.join(PROJECT_DIR).join("scene.json")
}

fn bad_scene(msg: impl Into<String>) -> CoreError {
    CoreError::new("bad_scene", msg)
        .hint("Delete .packcreator/scene.json in the pack folder to start a new custom scene; no texture is affected.")
}

/// Checks sizes, cell count and block names.
pub fn validate_scene(s: &SceneFile) -> Result<()> {
    if s.version != SCENE_VERSION {
        return Err(bad_scene(format!(
            "The custom scene was saved by another version of Pack Creator (format {}).",
            s.version
        )));
    }
    if !(1..=MAX_WIDTH).contains(&s.width)
        || !(1..=MAX_DEPTH).contains(&s.depth)
        || !(1..=MAX_HEIGHT).contains(&s.height)
    {
        return Err(bad_scene(format!(
            "The custom scene is {}×{}×{}; the most is {MAX_WIDTH}×{MAX_DEPTH}×{MAX_HEIGHT}.",
            s.width, s.depth, s.height
        )));
    }
    let cells = (s.width * s.depth * s.height) as usize;
    if s.blocks.len() != cells {
        return Err(bad_scene(format!(
            "The custom scene lists {} blocks for {cells} cells.",
            s.blocks.len()
        )));
    }
    if let Some(b) = s.blocks.iter().find(|b| !b.is_empty() && !is_block_id(b)) {
        return Err(bad_scene(format!(
            "The custom scene contains the invalid block name \"{b}\"."
        )));
    }
    Ok(())
}

/// The saved custom scene, `None` when there is none yet.
pub fn load_scene(pack_dir: &Path) -> Result<Option<SceneFile>> {
    let file = scene_file(pack_dir);
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CoreError::io(&file, &e)),
    };
    let s: SceneFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| bad_scene(format!("The custom scene file is damaged: {e}")))?;
    validate_scene(&s)?;
    Ok(Some(s))
}

/// Saves the custom scene (through a temporary file, so a crash never leaves
/// half a file).
pub fn save_scene(pack_dir: &Path, s: &SceneFile) -> Result<()> {
    validate_scene(s)?;
    let file = scene_file(pack_dir);
    let parent = file.parent().expect("scene file has a parent");
    fs::create_dir_all(parent).ctx(parent)?;
    let tmp = file.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(s).expect("scene serialises"),
    )
    .ctx(&tmp)?;
    fs::rename(&tmp, &file).ctx(&file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(root: &Path, rel: &str, text: &str) {
        let f = root.join("assets/minecraft").join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, text).unwrap();
    }

    fn game() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        put(
            r,
            "models/block/cube_all.json",
            r##"{"elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {
                "down": {"texture": "#all", "cullface": "down"}, "up": {"texture": "#all", "cullface": "up"},
                "north": {"texture": "#all", "cullface": "north"}, "south": {"texture": "#all", "cullface": "south"},
                "west": {"texture": "#all", "cullface": "west"}, "east": {"texture": "#all", "cullface": "east"}}}]}"##,
        );
        put(
            r,
            "models/block/stone.json",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/stone"}}"#,
        );
        put(
            r,
            "models/block/log_x.json",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/log_side"}}"#,
        );
        put(
            r,
            "models/block/log.json",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/log_top"}}"#,
        );
        put(
            r,
            "models/block/post.json",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/planks"}}"#,
        );
        put(
            r,
            "models/block/chest.json",
            r#"{"textures": {"particle": "block/planks"}}"#,
        );
        d
    }

    #[test]
    fn default_variant_is_picked() {
        let v = json!({"variants": {
            "axis=x": {"model": "block/log_x", "x": 90},
            "axis=y": {"model": "block/log"},
            "axis=z": {"model": "block/log_x", "x": 90, "y": 90}}});
        assert_eq!(models_from_blockstate(&v), ["block/log"]);
        let v = json!({"variants": {"": [{"model": "block/stone"}, {"model": "block/stone_mirrored"}]}});
        assert_eq!(models_from_blockstate(&v), ["block/stone"]);
        let v = json!({"variants": {"normal": {"model": "stone"}}});
        assert_eq!(models_from_blockstate(&v), ["stone"]);
        let v = json!({"variants": {
            "facing=east,half=top,shape=inner_left": {"model": "a"},
            "facing=north,half=bottom,shape=straight": {"model": "b"},
            "facing=north,half=bottom,shape=outer_left": {"model": "c"}}});
        assert_eq!(models_from_blockstate(&v), ["b"]);
        // no defaults among the keys: the first one
        let v = json!({"variants": {"color=red": {"model": "r"}, "color=blue": {"model": "b"}}});
        assert_eq!(models_from_blockstate(&v), ["r"]);
    }

    #[test]
    fn multipart_takes_the_unconditional_parts() {
        let v = json!({"multipart": [
            {"apply": {"model": "block/post"}},
            {"when": {"north": "true"}, "apply": {"model": "block/side"}}]});
        assert_eq!(models_from_blockstate(&v), ["block/post"]);
        let v =
            json!({"multipart": [{"when": {"north": "true"}, "apply": [{"model": "block/side"}]}]});
        assert_eq!(models_from_blockstate(&v), ["block/side"]);
        assert!(models_from_blockstate(&json!({})).is_empty());
    }

    #[test]
    fn blocks_resolve_through_blockstates_or_model_names() {
        let g = game();
        let r = g.path();
        put(
            r,
            "blockstates/oak_log.json",
            r#"{"variants": {"axis=x": {"model": "block/log_x"}, "axis=y": {"model": "minecraft:block/log"}}}"#,
        );
        put(
            r,
            "blockstates/chest.json",
            r#"{"variants": {"": {"model": "block/chest"}}}"#,
        );
        let ids: Vec<String> = [
            "oak_log", "stone", "", "oak_log", "chest", "nothing", "Bad/Id",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let blocks = scene_blocks(None, r, &ids);
        let names: Vec<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(names, ["Bad/Id", "chest", "nothing", "oak_log", "stone"]);
        let get = |id: &str| blocks.iter().find(|b| b.id == id).unwrap();
        assert_eq!(get("oak_log").models[0].name, "block/log");
        assert_eq!(get("oak_log").error, None);
        // no blockstate: the model of the same name
        assert_eq!(get("stone").models[0].name, "block/stone");
        assert!(get("chest")
            .error
            .as_deref()
            .unwrap()
            .contains("game's code"));
        assert!(get("nothing").error.is_some());
        assert!(get("Bad/Id").error.is_some());
    }

    #[test]
    fn the_pack_blockstate_wins() {
        let g = game();
        let pack = tempfile::tempdir().unwrap();
        put(
            g.path(),
            "blockstates/stone.json",
            r#"{"variants": {"": {"model": "block/stone"}}}"#,
        );
        put(
            pack.path(),
            "blockstates/stone.json",
            r#"{"variants": {"": {"model": "block/post"}}}"#,
        );
        assert_eq!(
            default_models(Some(pack.path()), g.path(), "stone").unwrap(),
            ["block/post"]
        );
        put(pack.path(), "blockstates/broken.json", "{ nope");
        assert_eq!(
            default_models(Some(pack.path()), g.path(), "broken")
                .unwrap_err()
                .kind,
            "bad_blockstate"
        );
    }

    #[test]
    fn block_list_from_blockstates_or_complete_models() {
        let g = game();
        // no blockstates: complete models only (not the cube_all template, not the chest)
        assert_eq!(
            list_blocks(None, g.path()),
            ["log", "log_x", "post", "stone"]
        );
        put(g.path(), "blockstates/stone.json", "{}");
        let pack = tempfile::tempdir().unwrap();
        put(pack.path(), "blockstates/my_block.json", "{}");
        put(pack.path(), "blockstates/Not A Block.json", "{}");
        assert_eq!(
            list_blocks(Some(pack.path()), g.path()),
            ["my_block", "stone"]
        );
    }

    fn scene(w: u32, d: u32, h: u32) -> SceneFile {
        SceneFile {
            version: SCENE_VERSION,
            width: w,
            depth: d,
            height: h,
            blocks: vec![String::new(); (w * d * h) as usize],
        }
    }

    #[test]
    fn scene_file_round_trip_and_checks() {
        let pack = tempfile::tempdir().unwrap();
        assert_eq!(load_scene(pack.path()).unwrap(), None);
        let mut s = scene(3, 2, 1);
        s.blocks[0] = "oak_planks".into();
        save_scene(pack.path(), &s).unwrap();
        assert!(pack.path().join(".packcreator/scene.json").is_file());
        assert!(!pack.path().join(".packcreator/scene.json.tmp").exists());
        assert_eq!(load_scene(pack.path()).unwrap(), Some(s.clone()));

        // nothing invalid is written
        let mut bad = s.clone();
        bad.blocks.pop();
        assert_eq!(save_scene(pack.path(), &bad).unwrap_err().kind, "bad_scene");
        assert_eq!(
            save_scene(pack.path(), &scene(9, 1, 1)).unwrap_err().kind,
            "bad_scene"
        );
        assert_eq!(
            save_scene(pack.path(), &scene(1, 1, 0)).unwrap_err().kind,
            "bad_scene"
        );
        let mut bad = scene(1, 1, 1);
        bad.blocks[0] = "../x".into();
        assert_eq!(save_scene(pack.path(), &bad).unwrap_err().kind, "bad_scene");
        assert_eq!(load_scene(pack.path()).unwrap(), Some(s));

        fs::write(pack.path().join(".packcreator/scene.json"), "{ broken").unwrap();
        let e = load_scene(pack.path()).unwrap_err();
        assert_eq!(e.kind, "bad_scene");
        assert!(e.hint.unwrap().contains("scene.json"));
    }
}

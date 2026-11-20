//! Block models for the 3D preview.
//!
//! A block model is a JSON file in `assets/minecraft/models/`, named like
//! `block/oak_stairs` (1.8.9: `block/stairs` too, with old texture names such
//! as `blocks/planks_oak`). It may name a `parent`; the child's `textures`
//! override the parent's, and the nearest model that has `elements` gives the
//! shape. A pack may ship its own model files: those win over the game's.
//!
//! Everything returned here is resolved: texture variables (`#side`) are
//! followed to texture paths (without `minecraft:`), and faces without `uv`
//! get the default the game works out from the element's `from` / `to`.

use crate::error::{CoreError, Result};
use crate::textures::is_safe_texture_path;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Parent chains longer than this are refused (the game's own are at most 4).
pub const MAX_DEPTH: usize = 32;
/// Most block models offered for one texture (besides the plain cube).
pub const MAX_CHOICES: usize = 24;
/// The name of the plain cube that is always offered first.
pub const CUBE: &str = ":cube";

/// The six face directions, in the order the game lists them.
pub const DIRECTIONS: [&str; 6] = ["down", "up", "north", "south", "west", "east"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ElementRotation {
    pub origin: [f64; 3],
    /// `x`, `y` or `z`.
    pub axis: String,
    /// Degrees.
    pub angle: f64,
    pub rescale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Face {
    /// Texture path such as `block/oak_planks`, or `None` when the variable
    /// leads nowhere (the game shows its "missing" texture there).
    pub texture: Option<String>,
    /// `[u1, v1, u2, v2]` in 0..16 texture units (given or the default).
    pub uv: [f64; 4],
    /// 0, 90, 180 or 270: the texture is turned clockwise on the face.
    pub rotation: u32,
    pub tintindex: Option<i64>,
    pub cullface: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Element {
    pub from: [f64; 3],
    pub to: [f64; 3],
    pub rotation: Option<ElementRotation>,
    /// `false` turns the game's directional shading off for this element.
    pub shade: bool,
    /// Keyed by direction (`down`, `up`, `north`, `south`, `west`, `east`).
    pub faces: BTreeMap<String, Face>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockModel {
    /// Normalised name, e.g. `block/oak_stairs`.
    pub name: String,
    /// The models followed, child first (`block/oak_stairs`, `block/stairs`, `block/block`).
    pub chain: Vec<String>,
    /// True when the model itself (the first of the chain) comes from the pack.
    pub from_pack: bool,
    pub ambientocclusion: bool,
    /// Texture variables after merging the chain, values resolved to paths
    /// where possible (a variable that leads nowhere keeps its `#` text).
    pub textures: BTreeMap<String, String>,
    pub elements: Vec<Element>,
    /// Set when the model has no elements to draw: `builtin/entity`,
    /// `builtin/generated` or `none` (the game draws it some other way).
    pub builtin: Option<String>,
}

impl BlockModel {
    /// Every texture the faces use, sorted, without duplicates.
    pub fn face_textures(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .elements
            .iter()
            .flat_map(|e| e.faces.values())
            .filter_map(|f| f.texture.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelChoice {
    /// What to pass to `block_model` (or [`CUBE`]).
    pub name: String,
    /// Short label for the picker.
    pub label: String,
}

fn bad_name(name: &str) -> CoreError {
    CoreError::new(
        "bad_model",
        format!("\"{name}\" is not a valid block model name."),
    )
    .hint("Model names look like block/oak_stairs.")
}

/// `minecraft:block/x` and `block/x` → `block/x`; a bare `x` → `block/x`.
pub fn normalize_name(name: &str) -> Result<String> {
    let n = name.trim();
    let n = n.strip_prefix("minecraft:").unwrap_or(n);
    if n.contains(':') {
        return Err(CoreError::new(
            "bad_model",
            format!(
                "The model \"{name}\" belongs to a mod; only Minecraft's own models can be shown."
            ),
        ));
    }
    let n = if n.contains('/') {
        n.to_owned()
    } else {
        format!("block/{n}")
    };
    if !is_safe_texture_path(&n) {
        return Err(bad_name(name));
    }
    Ok(n)
}

fn models_dir(root: &Path) -> PathBuf {
    root.join("assets").join("minecraft").join("models")
}

/// File of a model (`block/stone`) inside a root that contains `assets/`.
pub fn model_file(root: &Path, name: &str) -> PathBuf {
    let mut p = models_dir(root);
    for seg in name.split('/') {
        p.push(seg);
    }
    let file = format!(
        "{}.json",
        p.file_name().unwrap_or_default().to_string_lossy()
    );
    p.set_file_name(file);
    p
}

/// Reads one model file, the pack's first. `Ok(None)` when neither has it.
fn load_json(pack: Option<&Path>, vanilla: &Path, name: &str) -> Result<Option<(Value, bool)>> {
    let candidates = pack
        .map(|p| (model_file(p, name), true))
        .into_iter()
        .chain(std::iter::once((model_file(vanilla, name), false)));
    for (file, from_pack) in candidates {
        let text = match fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(CoreError::io(&file, &e)),
        };
        // some files start with a byte order mark
        let text = text.trim_start_matches('\u{feff}');
        let v: Value = serde_json::from_str(text).map_err(|e| {
            CoreError::new(
                "bad_model",
                format!("The model file {} is not valid JSON: {e}", file.display()),
            )
            .hint(if from_pack {
                "Fix or delete the model file in your pack."
            } else {
                "Extract the game files again from Settings."
            })
        })?;
        if !v.is_object() {
            return Err(CoreError::new(
                "bad_model",
                format!(
                    "The model file {} does not contain a JSON object.",
                    file.display()
                ),
            ));
        }
        return Ok(Some((v, from_pack)));
    }
    Ok(None)
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn vec3(v: Option<&Value>) -> Option<[f64; 3]> {
    let a = v?.as_array()?;
    if a.len() != 3 {
        return None;
    }
    Some([num(&a[0])?, num(&a[1])?, num(&a[2])?])
}

fn vec4(v: Option<&Value>) -> Option<[f64; 4]> {
    let a = v?.as_array()?;
    if a.len() != 4 {
        return None;
    }
    Some([num(&a[0])?, num(&a[1])?, num(&a[2])?, num(&a[3])?])
}

/// The UV the game uses for a face without `uv` (from the element box, so the
/// texture lines up across neighbouring blocks).
pub fn default_uv(dir: &str, from: [f64; 3], to: [f64; 3]) -> [f64; 4] {
    let [fx, fy, fz] = from;
    let [tx, ty, tz] = to;
    match dir {
        "down" => [fx, 16.0 - tz, tx, 16.0 - fz],
        "up" => [fx, fz, tx, tz],
        "south" => [fx, 16.0 - ty, tx, 16.0 - fy],
        "west" => [fz, 16.0 - ty, tz, 16.0 - fy],
        "east" => [16.0 - tz, 16.0 - ty, 16.0 - fz, 16.0 - fy],
        // north, and anything unknown (the game treats it as north)
        _ => [16.0 - tx, 16.0 - ty, 16.0 - fx, 16.0 - fy],
    }
}

/// Follows `#var` → `#other` → path. `None` when it leads nowhere or loops.
fn resolve_ref(textures: &Map<String, Value>, value: &str) -> Option<String> {
    let mut cur = value.to_owned();
    for _ in 0..=MAX_DEPTH {
        let Some(var) = cur.strip_prefix('#') else {
            let p = cur.strip_prefix("minecraft:").unwrap_or(&cur);
            return (!p.is_empty() && !p.contains(':')).then(|| p.to_owned());
        };
        let next = textures.get(var)?;
        // 1.21.4+ allows {"sprite": "..."} objects
        cur = match next {
            Value::String(s) => s.clone(),
            Value::Object(o) => o.get("sprite")?.as_str()?.to_owned(),
            _ => return None,
        };
    }
    None
}

/// A face's `texture`: normally `#var`; a bare word is taken as a variable
/// when one exists by that name (old files), else as a path.
fn face_texture(textures: &Map<String, Value>, value: &str) -> Option<String> {
    if !value.starts_with('#') && textures.contains_key(value) {
        return resolve_ref(textures, &format!("#{value}"));
    }
    resolve_ref(textures, value)
}

fn parse_rotation(v: Option<&Value>) -> Option<ElementRotation> {
    let o = v?.as_object()?;
    let axis = o.get("axis")?.as_str()?.to_ascii_lowercase();
    if !matches!(axis.as_str(), "x" | "y" | "z") {
        return None;
    }
    Some(ElementRotation {
        origin: vec3(o.get("origin")).unwrap_or([8.0, 8.0, 8.0]),
        axis,
        angle: o.get("angle").and_then(num).unwrap_or(0.0),
        rescale: o.get("rescale").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn parse_element(
    v: &Value,
    textures: &Map<String, Value>,
    model: &str,
    i: usize,
) -> Result<Element> {
    let bad = |what: &str| {
        CoreError::new(
            "bad_model",
            format!("Element {} of the model {model} has {what}.", i + 1),
        )
    };
    let o = v.as_object().ok_or_else(|| bad("no JSON object"))?;
    let from = vec3(o.get("from")).ok_or_else(|| bad("no valid \"from\""))?;
    let to = vec3(o.get("to")).ok_or_else(|| bad("no valid \"to\""))?;
    let mut faces = BTreeMap::new();
    if let Some(fs) = o.get("faces").and_then(Value::as_object) {
        for (dir, f) in fs {
            let dir = dir.to_ascii_lowercase();
            // "bottom" is an old spelling of "down"
            let dir = if dir == "bottom" {
                "down".to_owned()
            } else {
                dir
            };
            if !DIRECTIONS.contains(&dir.as_str()) {
                continue;
            }
            let Some(f) = f.as_object() else { continue };
            let uv = vec4(f.get("uv")).unwrap_or_else(|| default_uv(&dir, from, to));
            let rotation = f
                .get("rotation")
                .and_then(num)
                .map(|r| (((r / 90.0).round() as i64).rem_euclid(4) * 90) as u32)
                .unwrap_or(0);
            let texture = f
                .get("texture")
                .and_then(Value::as_str)
                .and_then(|t| face_texture(textures, t));
            faces.insert(
                dir,
                Face {
                    texture,
                    uv,
                    rotation,
                    tintindex: f
                        .get("tintindex")
                        .and_then(Value::as_i64)
                        .filter(|t| *t >= 0),
                    cullface: f.get("cullface").and_then(Value::as_str).map(str::to_owned),
                },
            );
        }
    }
    Ok(Element {
        from,
        to,
        rotation: parse_rotation(o.get("rotation")),
        shade: o.get("shade").and_then(Value::as_bool).unwrap_or(true),
        faces,
    })
}

/// Resolves a block model: parents followed, textures merged and resolved,
/// default UVs filled in. `pack` is the pack folder (its models win), `vanilla`
/// the extracted game folder.
pub fn block_model(pack: Option<&Path>, vanilla: &Path, name: &str) -> Result<BlockModel> {
    let name = normalize_name(name)?;
    let mut chain: Vec<String> = Vec::new();
    let mut jsons: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    let mut from_pack = false;
    let mut builtin = None;
    let mut cur = name.clone();
    loop {
        if !seen.insert(cur.clone()) {
            return Err(CoreError::new(
                "model_loop",
                format!(
                    "The model {name} has a parent loop: {} → {cur}.",
                    chain.join(" → ")
                ),
            )
            .hint("One of these model files names a parent that leads back to itself. Fix the \"parent\" in your pack's model."));
        }
        if chain.len() >= MAX_DEPTH {
            return Err(CoreError::new(
                "model_depth",
                format!("The model {name} has more than {MAX_DEPTH} parents."),
            ));
        }
        let Some((json, pack_file)) = load_json(pack, vanilla, &cur)? else {
            let msg = if chain.is_empty() {
                format!("There is no block model named {name}.")
            } else {
                format!(
                    "The model {} names the parent {cur}, which does not exist.",
                    chain.last().map(String::as_str).unwrap_or(&name)
                )
            };
            return Err(CoreError::new("model_missing", msg)
                .hint("Check the model name, or extract the game files again from Settings."));
        };
        if chain.is_empty() {
            from_pack = pack_file;
        }
        let parent = json
            .get("parent")
            .and_then(Value::as_str)
            .map(str::to_owned);
        chain.push(cur.clone());
        jsons.push(json);
        match parent {
            None => break,
            Some(p) => {
                let p = p.strip_prefix("minecraft:").unwrap_or(&p).to_owned();
                if p.starts_with("builtin/") {
                    builtin = Some(p);
                    break;
                }
                cur = normalize_name(&p)?;
            }
        }
    }

    // textures: from the root down, each child overriding
    let mut textures = Map::new();
    for j in jsons.iter().rev() {
        if let Some(t) = j.get("textures").and_then(Value::as_object) {
            for (k, v) in t {
                textures.insert(k.clone(), v.clone());
            }
        }
    }
    let ambientocclusion = jsons
        .iter()
        .find_map(|j| j.get("ambientocclusion").and_then(Value::as_bool))
        .unwrap_or(true);
    let owner = jsons
        .iter()
        .position(|j| j.get("elements").and_then(Value::as_array).is_some());
    let mut elements = Vec::new();
    if let Some(i) = owner {
        let list = jsons[i]["elements"].as_array().cloned().unwrap_or_default();
        for (n, e) in list.iter().enumerate() {
            elements.push(parse_element(e, &textures, &chain[i], n)?);
        }
    }
    if elements.is_empty() && builtin.is_none() {
        builtin = Some("none".to_owned());
    }
    let resolved = textures
        .iter()
        .map(|(k, v)| {
            let raw = match v {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("sprite")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                _ => String::new(),
            };
            let r = resolve_ref(&textures, &raw).unwrap_or(raw);
            (k.clone(), r)
        })
        .collect();
    Ok(BlockModel {
        name,
        chain,
        from_pack,
        ambientocclusion,
        textures: resolved,
        elements,
        builtin,
    })
}

/// Names (`block/x`) of the block models in one root, with the file text.
fn block_model_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for folder in ["block", "blocks"] {
        let dir = models_dir(root).join(folder);
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            out.push((format!("{folder}/{stem}"), p));
        }
    }
    out
}

const KINDS: [&str; 5] = ["stairs", "slab", "wall", "fence", "pane"];

/// Endings of the model variants that are less useful to look at
/// (stair corners, slab tops, wall and fence parts, 1.8.9 fence sides…).
const VARIANTS: [&str; 32] = [
    "_inner",
    "_outer",
    "_top",
    "_open",
    "_on",
    "_off",
    "_pressed",
    "_side",
    "_side_alt",
    "_side_tall",
    "_noside",
    "_noside_alt",
    "_post",
    "_post_ends",
    "_cap",
    "_cap_alt",
    "_down",
    "_attached",
    "_n",
    "_ne",
    "_ns",
    "_nse",
    "_nsew",
    "_nsw",
    "_nw",
    "_s",
    "_se",
    "_sew",
    "_sw",
    "_ew",
    "_wall",
    "_hanging",
];

/// Sort key: the block of the same name first, then stairs, slab, wall,
/// fence, pane, the rest; corner and part variants after all of those.
fn rank(label: &str, base: &str) -> (u32, String) {
    // 1.8.9 names the texture planks_oak and the block oak_planks
    let swapped = base
        .split_once('_')
        .map(|(a, b)| format!("{b}_{a}"))
        .unwrap_or_default();
    if label == base || label == swapped {
        return (0, String::new());
    }
    let pos = if label.contains("gate") {
        KINDS.len()
    } else {
        KINDS
            .iter()
            .position(|k| label.contains(k))
            .unwrap_or(KINDS.len())
    };
    let kind = pos as u32 + 1;
    let variant = VARIANTS.iter().any(|v| label.ends_with(v))
        || ["_inner", "_outer", "upper_"]
            .iter()
            .any(|v| label.contains(v));
    (kind + if variant { 10 } else { 0 }, label.to_owned())
}

/// The models to offer in the 3D preview for a texture: the plain cube first,
/// then the block models whose faces use this texture (the pack's models win
/// over the game's), most useful first, at most [`MAX_CHOICES`]. Models
/// without elements (chests, signs…) and models that only use the texture as
/// their particle are left out.
pub fn models_for_texture(pack: Option<&Path>, vanilla: &Path, texture: &str) -> Vec<ModelChoice> {
    let texture = texture.strip_prefix("minecraft:").unwrap_or(texture);
    let cube = || {
        vec![ModelChoice {
            name: CUBE.to_owned(),
            label: "Cube".to_owned(),
        }]
    };
    // not a texture path (a connected-textures tile such as ":optifine/ctm/glass/0")
    if !is_safe_texture_path(texture) {
        return cube();
    }
    let base = texture.rsplit('/').next().unwrap_or(texture);
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let roots = pack.into_iter().chain(std::iter::once(vanilla));
    for root in roots {
        for (name, file) in block_model_files(root) {
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            // cheap first filter: the texture's file name appears in the file
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            if text.contains(base) {
                names.push(name);
            }
        }
    }
    let mut found: Vec<(u32, String, String)> = Vec::new();
    for name in names {
        let Ok(m) = block_model(pack, vanilla, &name) else {
            continue;
        };
        if m.builtin.is_some() || !m.face_textures().iter().any(|t| t == texture) {
            continue;
        }
        let label = name.rsplit('/').next().unwrap_or(&name).to_owned();
        let (r, key) = rank(&label, base);
        found.push((r, key, name));
    }
    found.sort();
    let mut out = cube();
    out.extend(
        found
            .into_iter()
            .take(MAX_CHOICES)
            .map(|(_, _, name)| ModelChoice {
                label: name.rsplit('/').next().unwrap_or(&name).to_owned(),
                name,
            }),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, name: &str, json: &str) {
        let f = model_file(root, name);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, json).unwrap();
    }

    /// A small synthetic "game": block, cube_all, stairs-like and slab-like parents.
    fn game() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(
            r,
            "block/block",
            r#"{"display": {}, "ambientocclusion": true}"#,
        );
        write(
            r,
            "block/cube",
            r##"{"parent": "block/block", "textures": {"particle": "#down"},
              "elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {
                "down": {"texture": "#down", "cullface": "down"},
                "up": {"texture": "#up", "cullface": "up"},
                "north": {"texture": "#north"}, "south": {"texture": "#south"},
                "west": {"texture": "#west"}, "east": {"texture": "#east"}}}]}"##,
        );
        write(
            r,
            "block/cube_all",
            r##"{"parent": "minecraft:block/cube", "textures": {"particle": "#all",
              "down": "#all", "up": "#all", "north": "#all", "south": "#all", "west": "#all", "east": "#all"}}"##,
        );
        write(
            r,
            "block/half",
            r##"{"parent": "block/block", "elements": [{"from": [0,0,0], "to": [16,8,16], "faces": {
                "up": {"uv": [0,0,16,16], "texture": "#top", "rotation": 90, "tintindex": 0},
                "north": {"texture": "#side"}}}]}"##,
        );
        write(
            r,
            "block/stone",
            r#"{"parent": "minecraft:block/cube_all", "textures": {"all": "minecraft:block/stone"}}"#,
        );
        write(
            r,
            "block/stone_slab",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/stone"}}"#,
        );
        write(
            r,
            "block/stone_slab_top",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/stone"}}"#,
        );
        write(
            r,
            "block/stone_stairs",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/stone"}}"#,
        );
        write(
            r,
            "block/stone_wall_inventory",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/stone"}}"#,
        );
        write(
            r,
            "block/mossy",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/moss"}}"#,
        );
        write(
            r,
            "block/chest",
            r#"{"textures": {"particle": "block/stone"}}"#,
        );
        write(
            r,
            "block/only_particle",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/dirt", "particle": "block/stone"}}"#,
        );
        d
    }

    #[test]
    fn names_are_normalised() {
        assert_eq!(
            normalize_name("minecraft:block/oak_stairs").unwrap(),
            "block/oak_stairs"
        );
        assert_eq!(
            normalize_name("block/oak_stairs").unwrap(),
            "block/oak_stairs"
        );
        assert_eq!(normalize_name("stone").unwrap(), "block/stone");
        assert_eq!(normalize_name("block/../x").unwrap_err().kind, "bad_model");
        assert_eq!(normalize_name("mod:block/x").unwrap_err().kind, "bad_model");
    }

    #[test]
    fn parent_chain_textures_and_default_uvs() {
        let g = game();
        let m = block_model(None, g.path(), "minecraft:block/stone").unwrap();
        assert_eq!(
            m.chain,
            ["block/stone", "block/cube_all", "block/cube", "block/block"]
        );
        assert!(!m.from_pack);
        assert!(m.builtin.is_none());
        assert_eq!(m.elements.len(), 1);
        let e = &m.elements[0];
        assert_eq!(e.faces.len(), 6);
        for f in e.faces.values() {
            assert_eq!(f.texture.as_deref(), Some("block/stone"));
            assert_eq!(f.uv, [0.0, 0.0, 16.0, 16.0]);
        }
        assert_eq!(e.faces["down"].cullface.as_deref(), Some("down"));
        assert_eq!(m.textures["particle"], "block/stone");
        assert!(m.ambientocclusion);
    }

    #[test]
    fn default_uv_follows_the_element_box() {
        let from = [2.0, 1.0, 3.0];
        let to = [10.0, 9.0, 12.0];
        assert_eq!(default_uv("down", from, to), [2.0, 4.0, 10.0, 13.0]);
        assert_eq!(default_uv("up", from, to), [2.0, 3.0, 10.0, 12.0]);
        assert_eq!(default_uv("north", from, to), [6.0, 7.0, 14.0, 15.0]);
        assert_eq!(default_uv("south", from, to), [2.0, 7.0, 10.0, 15.0]);
        assert_eq!(default_uv("west", from, to), [3.0, 7.0, 12.0, 15.0]);
        assert_eq!(default_uv("east", from, to), [4.0, 7.0, 13.0, 15.0]);
        let g = game();
        let m = block_model(None, g.path(), "block/stone_slab").unwrap();
        let e = &m.elements[0];
        // given uv kept, missing one worked out
        assert_eq!(e.faces["up"].uv, [0.0, 0.0, 16.0, 16.0]);
        assert_eq!(e.faces["north"].uv, [0.0, 8.0, 16.0, 16.0]);
        assert_eq!(e.faces["up"].rotation, 90);
        assert_eq!(e.faces["up"].tintindex, Some(0));
        assert_eq!(e.faces["north"].tintindex, None);
    }

    #[test]
    fn child_textures_override_and_nearest_elements_win() {
        let g = game();
        let r = g.path();
        write(
            r,
            "block/override",
            r##"{"parent": "block/stone", "textures": {"all": "block/granite", "up": "block/andesite"},
              "elements": [{"from": [4,0,4], "to": [12,16,12], "faces": {"up": {"texture": "#up"}, "north": {"texture": "#all"}}}]}"##,
        );
        let m = block_model(None, r, "block/override").unwrap();
        assert_eq!(m.elements.len(), 1);
        assert_eq!(m.elements[0].from, [4.0, 0.0, 4.0]);
        assert_eq!(
            m.elements[0].faces["up"].texture.as_deref(),
            Some("block/andesite")
        );
        assert_eq!(
            m.elements[0].faces["north"].texture.as_deref(),
            Some("block/granite")
        );
        // the default uv of the north face of a 4..12 column
        assert_eq!(m.elements[0].faces["north"].uv, [4.0, 0.0, 12.0, 16.0]);
    }

    #[test]
    fn the_pack_model_wins() {
        let g = game();
        let pack = tempfile::tempdir().unwrap();
        write(
            pack.path(),
            "block/stone",
            r#"{"parent": "block/cube_all", "textures": {"all": "block/my_stone"}}"#,
        );
        let m = block_model(Some(pack.path()), g.path(), "block/stone").unwrap();
        assert!(m.from_pack);
        assert_eq!(
            m.elements[0].faces["up"].texture.as_deref(),
            Some("block/my_stone")
        );
        // a parent overridden by the pack is used as well
        write(
            pack.path(),
            "block/cube_all",
            r##"{"parent": "block/half", "textures": {"top": "#all", "side": "#all"}}"##,
        );
        let m = block_model(Some(pack.path()), g.path(), "block/stone").unwrap();
        assert_eq!(m.elements[0].to, [16.0, 8.0, 16.0]);
    }

    #[test]
    fn missing_parent_loop_and_depth_give_clear_errors() {
        let g = game();
        let r = g.path();
        write(r, "block/orphan", r#"{"parent": "block/nowhere"}"#);
        let e = block_model(None, r, "block/orphan").unwrap_err();
        assert_eq!(e.kind, "model_missing");
        assert!(e.message.contains("block/nowhere"), "{}", e.message);
        assert_eq!(
            block_model(None, r, "block/nothing").unwrap_err().kind,
            "model_missing"
        );

        write(r, "block/a", r#"{"parent": "block/b"}"#);
        write(r, "block/b", r#"{"parent": "minecraft:block/a"}"#);
        let e = block_model(None, r, "block/a").unwrap_err();
        assert_eq!(e.kind, "model_loop");
        assert!(e.message.contains("block/a → block/b"), "{}", e.message);

        for i in 0..40 {
            write(
                r,
                &format!("block/d{i}"),
                &format!(r#"{{"parent": "block/d{}"}}"#, i + 1),
            );
        }
        assert_eq!(
            block_model(None, r, "block/d0").unwrap_err().kind,
            "model_depth"
        );

        write(r, "block/broken", "{ not json");
        assert_eq!(
            block_model(None, r, "block/broken").unwrap_err().kind,
            "bad_model"
        );
    }

    #[test]
    fn models_without_elements_are_reported() {
        let g = game();
        let r = g.path();
        let m = block_model(None, r, "block/chest").unwrap();
        assert_eq!(m.builtin.as_deref(), Some("none"));
        write(
            r,
            "block/bed",
            r#"{"parent": "builtin/entity", "textures": {"particle": "block/oak_planks"}}"#,
        );
        let m = block_model(None, r, "block/bed").unwrap();
        assert_eq!(m.builtin.as_deref(), Some("builtin/entity"));
        assert!(m.elements.is_empty());
    }

    #[test]
    fn variable_chains_and_dead_ends() {
        let g = game();
        let r = g.path();
        write(
            r,
            "block/chain",
            r##"{"textures": {"a": "#b", "b": "#c", "c": "minecraft:block/end", "loop1": "#loop2", "loop2": "#loop1"},
              "elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {
                "up": {"texture": "#a"}, "down": {"texture": "#loop1"}, "north": {"texture": "#none"}, "south": {"texture": "a"}}}]}"##,
        );
        let m = block_model(None, r, "block/chain").unwrap();
        let f = &m.elements[0].faces;
        assert_eq!(f["up"].texture.as_deref(), Some("block/end"));
        assert_eq!(f["down"].texture, None);
        assert_eq!(f["north"].texture, None);
        assert_eq!(f["south"].texture.as_deref(), Some("block/end"));
        assert_eq!(m.textures["a"], "block/end");
        assert_eq!(m.textures["loop1"], "#loop2");
    }

    #[test]
    fn element_rotation_face_rotation_and_shade() {
        let g = game();
        let r = g.path();
        write(
            r,
            "block/plant",
            r##"{"ambientocclusion": false, "textures": {"cross": "block/fern"}, "elements": [
              {"from": [0.8,0,8], "to": [15.2,16,8], "shade": false,
               "rotation": {"origin": [8,8,8], "axis": "y", "angle": 45, "rescale": true},
               "faces": {"north": {"uv": [0,0,16,16], "texture": "#cross", "rotation": 270, "tintindex": 0},
                         "south": {"uv": [16,0,0,16], "texture": "#cross", "rotation": -90}}}]}"##,
        );
        let m = block_model(None, r, "block/plant").unwrap();
        assert!(!m.ambientocclusion);
        let e = &m.elements[0];
        assert!(!e.shade);
        assert_eq!(
            e.rotation,
            Some(ElementRotation {
                origin: [8.0, 8.0, 8.0],
                axis: "y".into(),
                angle: 45.0,
                rescale: true
            })
        );
        assert_eq!(e.faces["north"].rotation, 270);
        assert_eq!(e.faces["south"].rotation, 270);
        assert_eq!(e.faces["south"].uv, [16.0, 0.0, 0.0, 16.0]);
    }

    #[test]
    fn old_style_names_from_1_8_9() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "block/block", "{}");
        write(
            r,
            "block/stairs",
            r##"{"parent": "block/block", "elements": [{"from": [0,0,0], "to": [16,8,16], "faces": {
                "down": {"texture": "#bottom"}, "up": {"texture": "#top"}, "north": {"texture": "#side"}}}]}"##,
        );
        write(
            r,
            "block/oak_stairs",
            r#"{"parent": "block/stairs", "textures": {"bottom": "blocks/planks_oak", "top": "blocks/planks_oak", "side": "blocks/planks_oak"}}"#,
        );
        let planks = r#"{"parent": "block/stairs", "textures": {"bottom": "blocks/planks_oak", "top": "blocks/planks_oak", "side": "blocks/planks_oak"}}"#;
        write(r, "block/oak_inner_stairs", planks);
        write(r, "block/oak_planks", planks);
        let m = block_model(None, r, "oak_stairs").unwrap();
        assert_eq!(m.face_textures(), ["blocks/planks_oak"]);
        let list = models_for_texture(None, r, "blocks/planks_oak");
        assert_eq!(
            list.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(),
            ["Cube", "oak_planks", "oak_stairs", "oak_inner_stairs"]
        );
    }

    #[test]
    fn choices_for_a_texture_are_sorted_and_filtered() {
        let g = game();
        let list = models_for_texture(None, g.path(), "block/stone");
        let labels: Vec<&str> = list.iter().map(|c| c.label.as_str()).collect();
        // chest has no elements, only_particle only uses it as particle
        assert_eq!(
            labels,
            [
                "Cube",
                "stone",
                "stone_stairs",
                "stone_slab",
                "stone_wall_inventory",
                "mossy",
                "stone_slab_top"
            ]
        );
        assert_eq!(list[0].name, CUBE);
        assert_eq!(list[1].name, "block/stone");

        // the pack's own model counts and can drop a vanilla one
        let pack = tempfile::tempdir().unwrap();
        write(
            pack.path(),
            "block/mossy",
            r#"{"parent": "block/half", "textures": {"top": "block/moss", "side": "block/moss"}}"#,
        );
        write(
            pack.path(),
            "block/my_pillar",
            r#"{"parent": "block/half", "textures": {"top": "block/stone", "side": "block/stone"}}"#,
        );
        let labels: Vec<String> =
            models_for_texture(Some(pack.path()), g.path(), "minecraft:block/stone")
                .into_iter()
                .map(|c| c.label)
                .collect();
        assert!(labels.contains(&"my_pillar".to_owned()));
        assert!(!labels.contains(&"mossy".to_owned()));

        // capped
        for i in 0..40 {
            write(
                g.path(),
                &format!("block/stone_thing{i:02}"),
                r#"{"parent": "block/cube_all", "textures": {"all": "block/stone"}}"#,
            );
        }
        assert_eq!(
            models_for_texture(None, g.path(), "block/stone").len(),
            MAX_CHOICES + 1
        );
        // nothing uses it: just the cube
        assert_eq!(models_for_texture(None, g.path(), "block/unused").len(), 1);
    }
}

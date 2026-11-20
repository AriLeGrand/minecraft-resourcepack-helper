//! Random variants: the game picks one of several models for a block at
//! random (weighted), per block position. No mod is needed.
//!
//! A block state file (`assets/minecraft/blockstates/<block>.json`) either
//! lists `variants` (a model per state key, such as `""`, `"normal"` before
//! 1.13, or `"axis=y"`) or builds the block from `multipart` pieces. Only the
//! first kind is supported; multipart blocks are refused with a clear message.
//!
//! Adding variant `n` of a texture (for example `block/stone` → `block/stone_2`):
//! * the texture file is copied (the pack's file, else the game's enlarged
//!   to the pack resolution) to `textures/<texture>_n.png`;
//! * every model the block uses that shows the texture is copied to
//!   `models/<model>_n.json`, with each texture reference to the original
//!   replaced by the variant;
//! * the pack's block state file is generated from the base file (the pack's
//!   own file when it has one, else the game's): every state whose models show
//!   the texture becomes a weighted list `[{model: original, weight}, {model:
//!   original_n, weight}, …]`, keeping each entry's `x`, `y`, `uvlock`.
//!
//! The options (which texture, the weights, "also rotate randomly") and the
//! base the file was generated from are kept in `.packcreator/variants/<block>.json`.
//! When the pack's block state file was edited by hand after the app wrote it,
//! the edited states become the new base (merge), and every file the app
//! replaces goes to the trash first.
//!
//! Before 1.13 the shapes are the same, but model names have no folder
//! (`"model": "stone"` means `models/block/stone.json`) and textures live in
//! `blocks/`. The version's own game file is always the starting point.

use crate::error::{CoreError, IoCtx, Result};
use crate::import::move_to_trash;
use crate::models::{block_model, model_file, normalize_name};
use crate::pack::{now_ms, PROJECT_DIR};
use crate::textures::{is_safe_texture_path, mcmeta_file, texture_file};
use crate::workfile::work_file;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Highest weight the app offers (the game accepts more; 1–100 is plenty).
pub const MAX_WEIGHT: u32 = 100;
/// Highest variant number tried.
pub const MAX_N: u32 = 99;
const RECORD_SCHEMA: u32 = 1;
/// The four turns "also rotate randomly" adds.
const TURNS: [i64; 4] = [0, 90, 180, 270];

type Entry = Map<String, Value>;

/// Block names are file names: lower case letters, digits, `_`, `-`, `.`.
pub fn is_block_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.'))
}

fn check_block(block: &str) -> Result<()> {
    if is_block_name(block) {
        Ok(())
    } else {
        Err(CoreError::new(
            "bad_block",
            format!("\"{block}\" is not a valid block name."),
        ))
    }
}

/// `assets/minecraft/blockstates/<block>.json` inside a root.
pub fn blockstate_file(root: &Path, block: &str) -> PathBuf {
    root.join("assets")
        .join("minecraft")
        .join("blockstates")
        .join(format!("{block}.json"))
}

fn record_file(pack: &Path, block: &str) -> PathBuf {
    pack.join(PROJECT_DIR)
        .join("variants")
        .join(format!("{block}.json"))
}

pub(crate) fn read_json(path: &Path) -> Result<Option<Value>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CoreError::io(path, &e)),
    };
    let v = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| {
        CoreError::new(
            "bad_json",
            format!("{} is not valid JSON: {e}", path.display()),
        )
        .hint("Fix the file in a text editor, or move it out of the pack.")
    })?;
    Ok(Some(v))
}

fn write_json(path: &Path, v: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let mut text = serde_json::to_string_pretty(v).expect("JSON values always serialise");
    text.push('\n');
    fs::write(path, text).ctx(path)
}

// ------------------------------------------------------------ pure part

/// The `variants` object of a block state, or a clear refusal.
pub fn variants_of(state: &Value, block: &str) -> Result<Map<String, Value>> {
    if state.get("multipart").is_some() {
        return Err(CoreError::new(
            "multipart",
            format!("{block} is built from parts (its block state uses \"multipart\"), so random variants cannot be added to it."),
        )
        .hint("Fences, walls, panes, redstone wire and other blocks that join their neighbours are built from parts. Pick a block whose block state uses \"variants\", such as stone, dirt, sand or planks."));
    }
    match state.get("variants").and_then(Value::as_object) {
        Some(v) if !v.is_empty() => Ok(v.clone()),
        _ => Err(CoreError::new(
            "bad_blockstate",
            format!("The block state of {block} has no \"variants\"."),
        )),
    }
}

/// A state's value as a list of entries (an object is a list of one).
pub fn entries(v: &Value) -> Vec<Entry> {
    match v {
        Value::Object(o) => vec![o.clone()],
        Value::Array(a) => a.iter().filter_map(|e| e.as_object().cloned()).collect(),
        _ => Vec::new(),
    }
}

fn model_of(e: &Entry) -> Option<&str> {
    e.get("model").and_then(Value::as_str)
}

fn int_of(e: &Entry, key: &str) -> i64 {
    e.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// `minecraft:block/stone` → `minecraft:block/stone_2`; `stone` → `stone_2`.
pub fn variant_ref(model_ref: &str, n: u32) -> String {
    format!("{model_ref}_{n}")
}

/// `block/stone` → `block/stone_2`.
pub fn variant_texture(texture: &str, n: u32) -> String {
    format!("{texture}_{n}")
}

/// True when `model` is variant `n ≥ 2` of one of `models`.
fn is_ours(model: &str, models: &[String]) -> bool {
    models.iter().any(|m| {
        model
            .strip_prefix(m.as_str())
            .and_then(|r| r.strip_prefix('_'))
            .is_some_and(|d| {
                !d.is_empty()
                    && d.chars().all(|c| c.is_ascii_digit())
                    && d.parse::<u32>().is_ok_and(|n| n >= 2)
            })
    })
}

/// How the original or one variant is picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    /// 1..=100: how often, relative to the others.
    pub weight: u32,
    /// Also turn it 0/90/180/270 degrees around the vertical axis at random.
    pub rotate: bool,
}

impl Default for Choice {
    fn default() -> Self {
        Self {
            weight: 1,
            rotate: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variant {
    pub n: u32,
    pub weight: u32,
    pub rotate: bool,
}

impl Variant {
    fn choice(&self) -> Choice {
        Choice {
            weight: self.weight,
            rotate: self.rotate,
        }
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

fn lcm(a: u64, b: u64) -> u64 {
    a / gcd(a, b) * b
}

/// One entry turned by `turn` degrees more around the vertical axis.
fn turned(e: &Entry, turn: i64) -> Entry {
    let mut out = e.clone();
    let y = (int_of(e, "y") + turn).rem_euclid(360);
    if y == 0 {
        out.remove("y");
    } else {
        out.insert("y".into(), Value::from(y));
    }
    out
}

/// The entries of one group (the original, or one variant), with their
/// relative weights. `swap` replaces each of `models` by its variant `n`
/// (entries using another model are not part of a variant group).
fn group(es: &[Entry], models: &[String], swap: Option<u32>, rotate: bool) -> Vec<(Entry, u64)> {
    let mut out: Vec<(Entry, u64)> = Vec::new();
    for e in es {
        let w = e.get("weight").and_then(Value::as_u64).unwrap_or(1).max(1);
        let mut e2 = e.clone();
        e2.remove("weight");
        if let Some(n) = swap {
            match model_of(e) {
                Some(m) if models.iter().any(|x| x == m) => {
                    e2.insert("model".into(), Value::from(variant_ref(m, n)));
                }
                _ => continue,
            }
        }
        let turns: &[i64] = if rotate { &TURNS } else { &[0] };
        for t in turns {
            let r = turned(&e2, *t);
            match out.iter_mut().find(|(x, _)| *x == r) {
                Some((_, ww)) => *ww += w,
                None => out.push((r, w)),
            }
        }
    }
    out
}

/// Turns weighted entries into the JSON the game reads: an object when only
/// one is left, else a list with a `weight` on each (smallest whole numbers).
fn weighted_value(list: Vec<(Entry, u64)>) -> Value {
    let g = list.iter().fold(0, |g, (_, w)| gcd(g, *w)).max(1);
    if list.len() == 1 {
        return Value::Object(list.into_iter().next().unwrap().0);
    }
    Value::Array(
        list.into_iter()
            .map(|(mut e, w)| {
                e.insert("weight".into(), Value::from(w / g));
                Value::Object(e)
            })
            .collect(),
    )
}

/// The value of one state with the random variants: the original group and
/// one group per variant, each group's share proportional to its weight.
/// States whose entries do not use any of `models` are returned unchanged.
pub fn build_value(
    base: &Value,
    models: &[String],
    original: Choice,
    variants: &[Variant],
) -> Value {
    let es = entries(base);
    let uses = es
        .iter()
        .any(|e| model_of(e).is_some_and(|m| models.iter().any(|x| x == m)));
    if variants.is_empty() || !uses {
        return base.clone();
    }
    let mut groups: Vec<(Vec<(Entry, u64)>, u64)> = vec![(
        group(&es, models, None, original.rotate),
        u64::from(original.weight.clamp(1, MAX_WEIGHT)),
    )];
    for v in variants {
        let c = v.choice();
        groups.push((
            group(&es, models, Some(v.n), c.rotate),
            u64::from(c.weight.clamp(1, MAX_WEIGHT)),
        ));
    }
    groups.retain(|(g, _)| !g.is_empty());
    let sums: Vec<u64> = groups
        .iter()
        .map(|(g, _)| g.iter().map(|(_, w)| w).sum())
        .collect();
    let l = sums.iter().fold(1, |a, s| lcm(a, *s));
    let mut list = Vec::new();
    for ((g, share), sum) in groups.into_iter().zip(sums) {
        for (e, w) in g {
            list.push((e, w * share * (l / sum)));
        }
    }
    weighted_value(list)
}

/// [`build_value`] for every state.
pub fn build_variants(
    base: &Map<String, Value>,
    models: &[String],
    original: Choice,
    variants: &[Variant],
) -> Map<String, Value> {
    base.iter()
        .map(|(k, v)| (k.clone(), build_value(v, models, original, variants)))
        .collect()
}

/// A state's value without the app's variant entries (for a file edited by
/// hand, or written by an earlier run whose options were lost).
pub fn strip_ours(v: &Value, models: &[String]) -> Value {
    let es = entries(v);
    if !es
        .iter()
        .any(|e| model_of(e).is_some_and(|m| is_ours(m, models)))
    {
        return v.clone();
    }
    let kept: Vec<(Entry, u64)> = es
        .into_iter()
        .filter(|e| !model_of(e).is_some_and(|m| is_ours(m, models)))
        .map(|mut e| {
            let w = e.get("weight").and_then(Value::as_u64).unwrap_or(1).max(1);
            e.remove("weight");
            (e, w)
        })
        .collect();
    if kept.is_empty() {
        return v.clone();
    }
    weighted_value(kept)
}

/// The base to generate from, given the base and the file the app wrote last
/// time (`last`) and the pack's file as it is now: states the user did not
/// touch keep their base, edited states become the new base (without the
/// app's variant entries), removed states are dropped, added ones kept.
pub fn merge_base(
    record_base: &Map<String, Value>,
    last: &Map<String, Value>,
    pack: &Map<String, Value>,
    models: &[String],
) -> Map<String, Value> {
    pack.iter()
        .map(|(k, v)| {
            let base = match (last.get(k), record_base.get(k)) {
                (Some(l), Some(b)) if l == v => b.clone(),
                _ => strip_ours(v, models),
            };
            (k.clone(), base)
        })
        .collect()
}

/// A copy of a model's own JSON in which every texture reference to
/// `texture` points at `new_ref` instead. `resolved` are the model's texture
/// variables after following its parents (so a texture set by a parent is
/// overridden in the copy too).
pub fn variant_model(
    own: &Value,
    resolved: &BTreeMap<String, String>,
    texture: &str,
    new_ref: &str,
) -> Value {
    let same = |s: &str| s.strip_prefix("minecraft:").unwrap_or(s) == texture;
    let mut out = own.as_object().cloned().unwrap_or_default();
    let mut textures = out
        .get("textures")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (var, val) in resolved {
        if same(val) {
            textures.insert(var.clone(), Value::from(new_ref));
        }
    }
    for val in textures.values_mut() {
        let hit = match val {
            Value::String(s) => same(s),
            Value::Object(o) => o.get("sprite").and_then(Value::as_str).is_some_and(same),
            _ => false,
        };
        if hit {
            *val = Value::from(new_ref);
        }
    }
    if !textures.is_empty() {
        out.insert("textures".into(), Value::Object(textures));
    }
    if let Some(Value::Array(elements)) = out.get_mut("elements") {
        for el in elements {
            let Some(faces) = el.get_mut("faces").and_then(Value::as_object_mut) else {
                continue;
            };
            for f in faces.values_mut() {
                let hit = f
                    .get("texture")
                    .and_then(Value::as_str)
                    .is_some_and(|t| !t.starts_with('#') && same(t));
                if hit {
                    f["texture"] = Value::from(new_ref);
                }
            }
        }
    }
    Value::Object(out)
}

/// Model name (`block/stone`) of a block state's model reference.
/// Before 1.13 references have no folder: `stone` is `block/stone`.
pub fn model_name(model_ref: &str, legacy: bool) -> Result<String> {
    let s = model_ref.strip_prefix("minecraft:").unwrap_or(model_ref);
    if legacy && !s.starts_with("block/") {
        return normalize_name(&format!("block/{s}"));
    }
    normalize_name(s)
}

/// How a model file names a texture in this version.
pub fn texture_ref(texture: &str, legacy: bool) -> String {
    if legacy {
        texture.to_owned()
    } else {
        format!("minecraft:{texture}")
    }
}

// ------------------------------------------------------------ disk part

/// Where to read and write, and which era of names applies.
#[derive(Debug, Clone, Copy)]
pub struct Roots<'a> {
    pub pack: &'a Path,
    /// Extracted game files of the pack's version.
    pub vanilla: &'a Path,
    /// Before 1.13 (old names, `normal` state, model names without folder).
    pub legacy: bool,
}

/// What the app keeps about one block's variants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub schema: u32,
    pub block: String,
    /// The texture that has variants, e.g. `block/stone`.
    pub texture: String,
    /// Model references (as in the block state) that show the texture.
    pub models: Vec<String>,
    /// The `variants` object the file is generated from.
    pub base: Map<String, Value>,
    /// True when the base came from the pack's own block state file.
    pub base_from_pack: bool,
    pub original: Choice,
    pub variants: Vec<Variant>,
}

impl Record {
    fn generated(&self) -> Map<String, Value> {
        build_variants(&self.base, &self.models, self.original, &self.variants)
    }
}

struct Current {
    record: Option<Record>,
    base: Map<String, Value>,
    base_from_pack: bool,
    /// The pack's block state file, when it has one.
    pack_file: Option<Value>,
    /// The game's block state file.
    game_file: Option<Value>,
}

fn load_record(pack: &Path, block: &str) -> Option<Record> {
    let r: Record = serde_json::from_value(read_json(&record_file(pack, block)).ok()??).ok()?;
    (r.schema == RECORD_SCHEMA && r.block == block).then_some(r)
}

fn no_blockstate(block: &str) -> CoreError {
    CoreError::new(
        "no_blockstate",
        format!("There is no block state file for {block} in the pack or in this version of the game."),
    )
    .hint("Pick a block from the list. If the list is empty, extract the game files again from Settings.")
}

fn current(r: Roots, block: &str) -> Result<Current> {
    check_block(block)?;
    let game_file = read_json(&blockstate_file(r.vanilla, block))?;
    let pack_file = read_json(&blockstate_file(r.pack, block))?;
    let effective = pack_file
        .as_ref()
        .or(game_file.as_ref())
        .ok_or_else(|| no_blockstate(block))?;
    let now = variants_of(effective, block)?;
    let record = load_record(r.pack, block);
    let (base, base_from_pack) = match (&record, &pack_file) {
        (Some(rec), Some(_)) => {
            let merged = merge_base(&rec.base, &rec.generated(), &now, &rec.models);
            (merged, rec.base_from_pack)
        }
        (Some(rec), None) => (rec.base.clone(), rec.base_from_pack),
        (None, Some(_)) => {
            // the pack's own file: whatever it holds is the starting point
            (now.into_iter().collect(), true)
        }
        (None, None) => (now, false),
    };
    Ok(Current {
        record,
        base,
        base_from_pack,
        pack_file,
        game_file,
    })
}

/// Model references used by a `variants` object (without the app's own variants).
fn model_refs(base: &Map<String, Value>, ours: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in base.values() {
        for e in entries(v) {
            if let Some(m) = model_of(&e) {
                if !is_ours(m, ours) && !out.iter().any(|x| x == m) {
                    out.push(m.to_owned());
                }
            }
        }
    }
    out
}

/// Model references of a whole block state, `variants` or `multipart`.
fn all_model_refs(state: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |v: &Value| {
        for e in entries(v) {
            if let Some(m) = model_of(&e) {
                if !out.iter().any(|x| x == m) {
                    out.push(m.to_owned());
                }
            }
        }
    };
    if let Some(vs) = state.get("variants").and_then(Value::as_object) {
        vs.values().for_each(&mut add);
    }
    if let Some(parts) = state.get("multipart").and_then(Value::as_array) {
        for p in parts {
            if let Some(a) = p.get("apply") {
                add(a);
            }
        }
    }
    out
}

/// Textures shown by the given models, most used first.
fn textures_of_refs(r: Roots, refs: &[String]) -> Vec<String> {
    let mut count: Vec<(String, usize)> = Vec::new();
    for m in refs {
        let Ok(name) = model_name(m, r.legacy) else {
            continue;
        };
        let Ok(model) = block_model(Some(r.pack), r.vanilla, &name) else {
            continue;
        };
        for t in model.face_textures() {
            match count.iter_mut().find(|(x, _)| *x == t) {
                Some((_, c)) => *c += 1,
                None => count.push((t, 1)),
            }
        }
    }
    count.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    count.into_iter().map(|(t, _)| t).collect()
}

/// The textures a block shows (its block state's models, `variants` or
/// `multipart`), most used first. Used by connected textures too.
pub fn block_textures(r: Roots, block: &str) -> Result<Vec<String>> {
    check_block(block)?;
    let state = match read_json(&blockstate_file(r.pack, block))? {
        Some(v) => v,
        None => {
            read_json(&blockstate_file(r.vanilla, block))?.ok_or_else(|| no_blockstate(block))?
        }
    };
    Ok(textures_of_refs(r, &all_model_refs(&state)))
}

/// The models (references) among `refs` whose faces show `texture`.
fn models_using(r: Roots, refs: &[String], texture: &str) -> Vec<String> {
    refs.iter()
        .filter(|m| {
            model_name(m, r.legacy)
                .and_then(|n| block_model(Some(r.pack), r.vanilla, &n))
                .is_ok_and(|model| model.face_textures().iter().any(|t| t == texture))
        })
        .cloned()
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockEntry {
    pub name: String,
    /// Built from parts: random variants are refused.
    pub multipart: bool,
    /// The app made random variants for it.
    pub has_variants: bool,
    /// The pack has its own block state file.
    pub in_pack: bool,
}

fn json_names(dir: &Path) -> Vec<String> {
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
        .filter(|n| is_block_name(n))
        .collect()
}

/// Every block with a block state file in the game or the pack, sorted.
pub fn list_blocks(pack: &Path, vanilla: &Path) -> Vec<BlockEntry> {
    let bs = |root: &Path| root.join("assets").join("minecraft").join("blockstates");
    let mine = json_names(&bs(pack));
    let mut names = json_names(&bs(vanilla));
    names.extend(mine.iter().cloned());
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let in_pack = mine.contains(&name);
            let file = blockstate_file(if in_pack { pack } else { vanilla }, &name);
            let multipart = fs::read_to_string(&file)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
                .is_some_and(|v| v.get("multipart").is_some());
            BlockEntry {
                has_variants: record_file(pack, &name).is_file(),
                multipart,
                in_pack,
                name,
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VariantView {
    pub n: u32,
    pub texture: String,
    /// Model names of this variant (`block/stone_2`).
    pub models: Vec<String>,
    pub weight: u32,
    pub rotate: bool,
    /// The variant's texture file exists in the pack.
    pub texture_in_pack: bool,
}

/// One possible pick for the preview: a model and its turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PreviewEntry {
    /// Model name, e.g. `block/stone_2`.
    pub model: String,
    pub x: i64,
    pub y: i64,
    pub weight: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockInfo {
    pub block: String,
    pub legacy: bool,
    /// State keys of the block state (`""`, `normal`, `axis=y`…).
    pub keys: Vec<String>,
    /// Textures the block shows, most used first.
    pub textures: Vec<String>,
    /// The texture that has variants (when any).
    pub texture: Option<String>,
    /// Model names showing that texture.
    pub models: Vec<String>,
    pub original: Choice,
    pub variants: Vec<VariantView>,
    /// Some states already turn their model (`x` / `y`): random turns may look wrong.
    pub has_rotations: bool,
    /// The base came from the pack's own block state file (else the game's).
    pub base_from_pack: bool,
    /// The pack's block state file as it is on disk.
    pub blockstate: Option<String>,
    /// The state shown by the preview and its weighted picks.
    pub preview_key: String,
    pub preview: Vec<PreviewEntry>,
}

fn info_from(r: Roots, block: &str, cur: &Current) -> Result<BlockInfo> {
    let rec = cur.record.as_ref();
    let ours: &[String] = rec.map(|x| x.models.as_slice()).unwrap_or(&[]);
    let refs = model_refs(&cur.base, ours);
    let names = |refs: &[String], n: Option<u32>| -> Vec<String> {
        refs.iter()
            .filter_map(|m| {
                let m = match n {
                    Some(n) => variant_ref(m, n),
                    None => m.clone(),
                };
                model_name(&m, r.legacy).ok()
            })
            .collect()
    };
    let has_rotations = cur.base.values().any(|v| {
        entries(v)
            .iter()
            .any(|e| int_of(e, "x") != 0 || int_of(e, "y") != 0)
    });
    let generated = match rec {
        Some(rec) => build_variants(&cur.base, &rec.models, rec.original, &rec.variants),
        None => cur.base.clone(),
    };
    // the preview shows the first state that uses the varied models
    let preview_key = generated
        .iter()
        .find(|(_, v)| {
            entries(v).iter().any(|e| {
                model_of(e).is_some_and(|m| ours.iter().any(|x| x == m) || is_ours(m, ours))
            })
        })
        .or_else(|| generated.iter().next())
        .map(|(k, _)| k.clone())
        .unwrap_or_default();
    let preview = generated
        .get(&preview_key)
        .map(entries)
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            Some(PreviewEntry {
                model: model_name(model_of(e)?, r.legacy).ok()?,
                x: int_of(e, "x"),
                y: int_of(e, "y"),
                weight: e.get("weight").and_then(Value::as_u64).unwrap_or(1).max(1),
            })
        })
        .collect();
    let variants = rec
        .map(|rec| {
            rec.variants
                .iter()
                .map(|v| {
                    let tex = variant_texture(&rec.texture, v.n);
                    VariantView {
                        n: v.n,
                        texture_in_pack: texture_file(r.pack, &tex).is_ok_and(|f| f.is_file()),
                        texture: tex,
                        models: names(&rec.models, Some(v.n)),
                        weight: v.weight,
                        rotate: v.rotate,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(BlockInfo {
        block: block.to_owned(),
        legacy: r.legacy,
        keys: cur.base.keys().cloned().collect(),
        textures: textures_of_refs(r, &refs),
        texture: rec.map(|x| x.texture.clone()),
        models: rec.map(|x| names(&x.models, None)).unwrap_or_default(),
        original: rec.map(|x| x.original).unwrap_or_default(),
        variants,
        has_rotations,
        base_from_pack: cur.base_from_pack,
        blockstate: fs::read_to_string(blockstate_file(r.pack, block)).ok(),
        preview_key,
        preview,
    })
}

/// Everything the screen shows about one block. Multipart blocks are refused.
pub fn info(r: Roots, block: &str) -> Result<BlockInfo> {
    let cur = current(r, block)?;
    info_from(r, block, &cur)
}

/// Writes the pack's block state file for the record (the old file to the trash).
fn write_blockstate(r: Roots, cur: &Current, rec: &Record, stamp: u64) -> Result<()> {
    let file = blockstate_file(r.pack, &rec.block);
    let mut obj = cur
        .pack_file
        .as_ref()
        .or(cur.game_file.as_ref())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    obj.insert("variants".into(), Value::Object(rec.generated()));
    move_to_trash(r.pack, &file, stamp)?;
    write_json(&file, &Value::Object(obj))
}

fn save_record(pack: &Path, rec: &Record) -> Result<()> {
    write_json(
        &record_file(pack, &rec.block),
        &serde_json::to_value(rec).expect("records serialise"),
    )
}

/// Copies a texture (pack file, else the game's enlarged by `scale`) and its
/// `.mcmeta` to a new name in the pack.
fn copy_texture(r: Roots, from: &str, to: &str, scale: u32) -> Result<()> {
    let dest = texture_file(r.pack, to)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx(parent)?;
    }
    let mine = texture_file(r.pack, from)?;
    let src = if mine.is_file() {
        fs::copy(&mine, &dest).ctx(&dest)?;
        mine
    } else {
        let game = texture_file(r.vanilla, from)?;
        if !game.is_file() {
            return Err(CoreError::new(
                "not_found",
                format!("There is no texture {from} in the pack or in the game."),
            ));
        }
        if scale <= 1 {
            fs::copy(&game, &dest).ctx(&dest)?;
        } else {
            let img = image::open(&game)
                .map_err(|e| CoreError::new("bad_image", format!("{}: {e}", game.display())))?;
            img.resize_exact(
                img.width() * scale,
                img.height() * scale,
                image::imageops::FilterType::Nearest,
            )
            .save_with_format(&dest, image::ImageFormat::Png)
            .map_err(|e| {
                CoreError::new("io", format!("Could not write {}: {e}", dest.display()))
            })?;
        }
        game
    };
    let meta = mcmeta_file(&src);
    if meta.is_file() {
        let to_meta = mcmeta_file(&dest);
        fs::copy(&meta, &to_meta).ctx(&to_meta)?;
    }
    Ok(())
}

/// A model's own JSON: the pack's file, else the game's.
fn own_model(r: Roots, name: &str) -> Result<Value> {
    for root in [r.pack, r.vanilla] {
        if let Some(v) = read_json(&model_file(root, name))? {
            return Ok(v);
        }
    }
    Err(CoreError::new(
        "model_missing",
        format!("There is no block model named {name}."),
    ))
}

/// The smallest `n ≥ 2` free for the texture and every model, in the pack
/// and in the game.
fn next_free(r: Roots, rec: &Record) -> Result<u32> {
    'n: for n in 2..=MAX_N {
        if rec.variants.iter().any(|v| v.n == n) {
            continue;
        }
        let tex = variant_texture(&rec.texture, n);
        for root in [r.pack, r.vanilla] {
            if texture_file(root, &tex)?.exists() {
                continue 'n;
            }
            for m in &rec.models {
                if model_file(root, &model_name(&variant_ref(m, n), r.legacy)?).exists() {
                    continue 'n;
                }
            }
        }
        return Ok(n);
    }
    Err(CoreError::new(
        "too_many",
        format!(
            "{} already has the most variants this app makes.",
            rec.block
        ),
    ))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Added {
    pub info: BlockInfo,
    /// The new texture, ready to be drawn in the editor.
    pub texture: String,
}

/// Adds random variant `n` (the next free number) of `texture` to `block`.
/// `scale` enlarges the game's texture when the pack has none (resolution / 16).
pub fn add(r: Roots, block: &str, texture: &str, scale: u32) -> Result<Added> {
    let texture = texture.strip_prefix("minecraft:").unwrap_or(texture);
    if !is_safe_texture_path(texture) {
        return Err(CoreError::new(
            "bad_path",
            format!("\"{texture}\" is not a valid texture name."),
        ));
    }
    let cur = current(r, block)?;
    let mut rec = match &cur.record {
        Some(rec) if rec.texture != texture => {
            return Err(CoreError::new(
                "other_texture",
                format!("{block} already has random variants of {}.", rec.texture),
            )
            .hint("Remove those variants first to vary another of its textures."));
        }
        Some(rec) => Record {
            base: cur.base.clone(),
            base_from_pack: cur.base_from_pack,
            ..rec.clone()
        },
        None => {
            let models = models_using(r, &model_refs(&cur.base, &[]), texture);
            if models.is_empty() {
                return Err(CoreError::new(
                    "not_used",
                    format!("The models of {block} do not show {texture}."),
                )
                .hint("Pick one of the textures listed for this block."));
            }
            Record {
                schema: RECORD_SCHEMA,
                block: block.to_owned(),
                texture: texture.to_owned(),
                models,
                base: cur.base.clone(),
                base_from_pack: cur.base_from_pack,
                original: Choice::default(),
                variants: Vec::new(),
            }
        }
    };
    let n = next_free(r, &rec)?;
    let new_tex = variant_texture(texture, n);
    copy_texture(r, texture, &new_tex, scale)?;
    for m in &rec.models {
        let name = model_name(m, r.legacy)?;
        let resolved = block_model(Some(r.pack), r.vanilla, &name)?.textures;
        let json = variant_model(
            &own_model(r, &name)?,
            &resolved,
            texture,
            &texture_ref(&new_tex, r.legacy),
        );
        write_json(
            &model_file(r.pack, &model_name(&variant_ref(m, n), r.legacy)?),
            &json,
        )?;
    }
    rec.variants.push(Variant {
        n,
        weight: rec.original.weight,
        rotate: rec.original.rotate,
    });
    write_blockstate(r, &cur, &rec, now_ms())?;
    save_record(r.pack, &rec)?;
    let cur = current(r, block)?;
    Ok(Added {
        info: info_from(r, block, &cur)?,
        texture: new_tex,
    })
}

/// Changes the weight / random turns of the original (`n == 1`) or of variant `n`.
pub fn set_choice(r: Roots, block: &str, n: u32, choice: Choice) -> Result<BlockInfo> {
    if !(1..=MAX_WEIGHT).contains(&choice.weight) {
        return Err(CoreError::new(
            "bad_weight",
            format!("The weight must be between 1 and {MAX_WEIGHT}."),
        ));
    }
    let cur = current(r, block)?;
    let Some(rec) = &cur.record else {
        return Err(CoreError::new(
            "no_variants",
            format!("{block} has no random variants yet."),
        ));
    };
    let mut rec = Record {
        base: cur.base.clone(),
        base_from_pack: cur.base_from_pack,
        ..rec.clone()
    };
    if n == 1 {
        rec.original = choice;
    } else {
        let v =
            rec.variants.iter_mut().find(|v| v.n == n).ok_or_else(|| {
                CoreError::new("no_variant", format!("{block} has no variant {n}."))
            })?;
        v.weight = choice.weight;
        v.rotate = choice.rotate;
    }
    write_blockstate(r, &cur, &rec, now_ms())?;
    save_record(r.pack, &rec)?;
    info(r, block)
}

/// Removes variant `n`: its texture, `.mcmeta`, layers and models go to the
/// trash and the block state is generated again (back to the base when it
/// was the last one: the pack's own file, or no file when it came from the game).
pub fn remove(r: Roots, block: &str, n: u32) -> Result<BlockInfo> {
    let cur = current(r, block)?;
    let Some(rec) = &cur.record else {
        return Err(CoreError::new(
            "no_variants",
            format!("{block} has no random variants."),
        ));
    };
    if !rec.variants.iter().any(|v| v.n == n) {
        return Err(CoreError::new(
            "no_variant",
            format!("{block} has no variant {n}."),
        ));
    }
    let mut rec = Record {
        base: cur.base.clone(),
        base_from_pack: cur.base_from_pack,
        ..rec.clone()
    };
    let stamp = now_ms();
    let tex = variant_texture(&rec.texture, n);
    let png = texture_file(r.pack, &tex)?;
    move_to_trash(r.pack, &mcmeta_file(&png), stamp)?;
    move_to_trash(r.pack, &png, stamp)?;
    move_to_trash(r.pack, &work_file(r.pack, &tex)?, stamp)?;
    for m in &rec.models {
        let f = model_file(r.pack, &model_name(&variant_ref(m, n), r.legacy)?);
        move_to_trash(r.pack, &f, stamp)?;
    }
    rec.variants.retain(|v| v.n != n);
    if rec.variants.is_empty() {
        let file = blockstate_file(r.pack, block);
        if rec.base_from_pack {
            write_blockstate(r, &cur, &rec, stamp)?;
        } else {
            move_to_trash(r.pack, &file, stamp)?;
        }
        move_to_trash(r.pack, &record_file(r.pack, block), stamp)?;
    } else {
        write_blockstate(r, &cur, &rec, stamp)?;
        save_record(r.pack, &rec)?;
    }
    info(r, block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::minecraft::testutil::png;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn models(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn v(n: u32, weight: u32, rotate: bool) -> Variant {
        Variant { n, weight, rotate }
    }

    #[test]
    fn multipart_is_refused_and_variants_are_read() {
        let mp = json!({"multipart": [{"apply": {"model": "minecraft:block/oak_fence_post"}}]});
        let e = variants_of(&mp, "oak_fence").unwrap_err();
        assert_eq!(e.kind, "multipart");
        assert!(e.message.contains("oak_fence"));
        assert!(e.hint.unwrap().contains("variants"));
        assert_eq!(
            variants_of(&json!({}), "x").unwrap_err().kind,
            "bad_blockstate"
        );
        let ok = variants_of(
            &json!({"variants": {"": {"model": "minecraft:block/stone"}}}),
            "stone",
        )
        .unwrap();
        assert_eq!(ok.len(), 1);
    }

    #[test]
    fn one_state_becomes_a_weighted_list() {
        let base = json!({"model": "minecraft:block/stone"});
        let m = models(&["minecraft:block/stone"]);
        let out = build_value(
            &base,
            &m,
            Choice {
                weight: 3,
                rotate: false,
            },
            &[v(2, 1, false), v(3, 2, false)],
        );
        assert_eq!(
            out,
            json!([
                {"model": "minecraft:block/stone", "weight": 3},
                {"model": "minecraft:block/stone_2", "weight": 1},
                {"model": "minecraft:block/stone_3", "weight": 2}
            ])
        );
        // no variants: unchanged
        assert_eq!(build_value(&base, &m, Choice::default(), &[]), base);
    }

    #[test]
    fn several_keys_with_rotations_keep_x_y_and_uvlock() {
        let base = obj(json!({
            "axis=y": {"model": "minecraft:block/oak_log"},
            "axis=x": {"model": "minecraft:block/oak_log_horizontal", "x": 90, "y": 90},
            "axis=z": {"model": "minecraft:block/oak_log_horizontal", "x": 90, "uvlock": true},
            "other": {"model": "minecraft:block/unrelated"}
        }));
        let m = models(&[
            "minecraft:block/oak_log",
            "minecraft:block/oak_log_horizontal",
        ]);
        let out = build_variants(&base, &m, Choice::default(), &[v(2, 1, false)]);
        assert_eq!(
            out["axis=x"],
            json!([
                {"model": "minecraft:block/oak_log_horizontal", "x": 90, "y": 90, "weight": 1},
                {"model": "minecraft:block/oak_log_horizontal_2", "x": 90, "y": 90, "weight": 1}
            ])
        );
        assert_eq!(
            out["axis=z"],
            json!([
                {"model": "minecraft:block/oak_log_horizontal", "x": 90, "uvlock": true, "weight": 1},
                {"model": "minecraft:block/oak_log_horizontal_2", "x": 90, "uvlock": true, "weight": 1}
            ])
        );
        assert_eq!(out["axis=y"].as_array().unwrap().len(), 2);
        // a state that does not show the texture is left alone
        assert_eq!(out["other"], json!({"model": "minecraft:block/unrelated"}));
        // keys keep their order
        assert_eq!(
            out.keys().collect::<Vec<_>>(),
            ["axis=y", "axis=x", "axis=z", "other"]
        );
    }

    #[test]
    fn random_turns_add_four_copies_and_keep_the_shares() {
        let base = json!({"model": "stone"});
        let m = models(&["stone"]);
        // original 1 not turned, variant weight 1 turned: 4 copies of 1, original 4
        let out = build_value(&base, &m, Choice::default(), &[v(2, 1, true)]);
        assert_eq!(
            out,
            json!([
                {"model": "stone", "weight": 4},
                {"model": "stone_2", "weight": 1},
                {"model": "stone_2", "y": 90, "weight": 1},
                {"model": "stone_2", "y": 180, "weight": 1},
                {"model": "stone_2", "y": 270, "weight": 1}
            ])
        );
        // turns add to an existing y; copies that end up equal are merged
        let base = json!([{"model": "dirt"}, {"model": "dirt", "y": 90}, {"model": "dirt", "y": 180}, {"model": "dirt", "y": 270}]);
        let out = build_value(
            &base,
            &models(&["dirt"]),
            Choice {
                weight: 1,
                rotate: true,
            },
            &[v(2, 1, false)],
        );
        let a = out.as_array().unwrap();
        // original: 4 distinct turns, each 4 times → weight 4 each, total 16;
        // variant: 4 entries of 1, total 4 → scaled ×4 to match the original's share
        assert_eq!(a.len(), 8);
        let total = |prefix: &str| -> u64 {
            a.iter()
                .filter(|e| e["model"] == prefix)
                .map(|e| e["weight"].as_u64().unwrap())
                .sum()
        };
        assert_eq!(total("dirt"), total("dirt_2"));
    }

    #[test]
    fn weights_are_proportional_and_reduced() {
        let base = json!({"model": "minecraft:block/stone"});
        let m = models(&["minecraft:block/stone"]);
        let out = build_value(
            &base,
            &m,
            Choice {
                weight: 50,
                rotate: false,
            },
            &[v(2, 25, false)],
        );
        assert_eq!(out[0]["weight"], 2);
        assert_eq!(out[1]["weight"], 1);
        // an existing weighted list keeps its inner proportions
        let base = json!([{"model": "a", "weight": 3}, {"model": "b"}]);
        let out = build_value(&base, &models(&["a"]), Choice::default(), &[v(2, 1, false)]);
        assert_eq!(
            out,
            json!([
                {"model": "a", "weight": 3},
                {"model": "b", "weight": 1},
                {"model": "a_2", "weight": 4}
            ])
        );
    }

    #[test]
    fn stripping_and_merging_with_an_edited_pack_file() {
        let m = models(&["minecraft:block/stone"]);
        let base = obj(
            json!({"": {"model": "minecraft:block/stone"}, "x": {"model": "minecraft:block/other"}}),
        );
        let last = build_variants(&base, &m, Choice::default(), &[v(2, 1, false)]);
        // untouched → base; edited by hand → edited value without our entries; new key kept
        let mut pack = last.clone();
        pack.insert(
            "x".into(),
            json!([{"model": "minecraft:block/other", "weight": 5}, {"model": "minecraft:block/other_b"}]),
        );
        pack.insert("added".into(), json!({"model": "minecraft:block/stone_2"}));
        let merged = merge_base(&base, &last, &pack, &m);
        assert_eq!(merged[""], json!({"model": "minecraft:block/stone"}));
        assert_eq!(merged["x"], pack["x"]);
        // only our entries: nothing else to keep, value stays
        assert_eq!(merged["added"], json!({"model": "minecraft:block/stone_2"}));
        // a hand-edited list with our variant inside: the variant entries go
        let v2 = json!([{"model": "minecraft:block/stone", "weight": 4}, {"model": "minecraft:block/stone_2", "weight": 1}, {"model": "minecraft:block/stone_x"}]);
        assert_eq!(
            strip_ours(&v2, &m),
            json!([{"model": "minecraft:block/stone", "weight": 4}, {"model": "minecraft:block/stone_x", "weight": 1}])
        );
        let one = json!([{"model": "minecraft:block/stone", "weight": 4}, {"model": "minecraft:block/stone_2"}]);
        assert_eq!(
            strip_ours(&one, &m),
            json!({"model": "minecraft:block/stone"})
        );
    }

    #[test]
    fn variant_models_replace_every_reference() {
        let own = json!({"parent": "minecraft:block/cube_all", "textures": {"all": "minecraft:block/stone"}});
        let resolved: BTreeMap<String, String> = [
            ("all", "block/stone"),
            ("particle", "block/stone"),
            ("up", "block/stone"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect();
        let out = variant_model(&own, &resolved, "block/stone", "minecraft:block/stone_2");
        assert_eq!(out["parent"], "minecraft:block/cube_all");
        assert_eq!(out["textures"]["all"], "minecraft:block/stone_2");
        assert_eq!(out["textures"]["particle"], "minecraft:block/stone_2");
        // a texture set only by a parent is overridden too, others kept, faces with a path replaced
        let own = json!({"parent": "block/cube_column", "textures": {"end": "blocks/log_oak_top", "side": {"sprite": "blocks/log_oak"}},
            "elements": [{"faces": {"up": {"texture": "blocks/log_oak"}, "down": {"texture": "#end"}}}]});
        let resolved: BTreeMap<String, String> = [
            ("end", "blocks/log_oak_top"),
            ("side", "blocks/log_oak"),
            ("particle", "blocks/log_oak"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect();
        let out = variant_model(&own, &resolved, "blocks/log_oak", "blocks/log_oak_2");
        assert_eq!(out["textures"]["end"], "blocks/log_oak_top");
        assert_eq!(out["textures"]["side"], "blocks/log_oak_2");
        assert_eq!(out["textures"]["particle"], "blocks/log_oak_2");
        assert_eq!(
            out["elements"][0]["faces"]["up"]["texture"],
            "blocks/log_oak_2"
        );
        assert_eq!(out["elements"][0]["faces"]["down"]["texture"], "#end");
    }

    #[test]
    fn names_in_both_eras() {
        assert_eq!(
            model_name("minecraft:block/stone", false).unwrap(),
            "block/stone"
        );
        assert_eq!(model_name("stone", true).unwrap(), "block/stone");
        assert_eq!(model_name("stone_2", true).unwrap(), "block/stone_2");
        assert_eq!(texture_ref("blocks/stone_2", true), "blocks/stone_2");
        assert_eq!(
            texture_ref("block/stone_2", false),
            "minecraft:block/stone_2"
        );
        assert!(is_ours("stone_2", &models(&["stone"])));
        assert!(is_ours("stone_12", &models(&["stone"])));
        assert!(!is_ours("stone_1", &models(&["stone"])));
        assert!(!is_ours("stone_bricks", &models(&["stone"])));
        assert!(!is_block_name("../x"));
        assert!(is_block_name("oak_log"));
    }

    // ------------------------------------------------------- on disk

    struct Game {
        _tmp: tempfile::TempDir,
        vanilla: PathBuf,
        pack: PathBuf,
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let f = rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s));
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, text).unwrap();
    }

    fn put_png(root: &Path, tex: &str, w: u32, seed: u8) {
        let f = texture_file(root, tex).unwrap();
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, png(w, w, seed)).unwrap();
    }

    const M: &str = "assets/minecraft/models/block";
    const B: &str = "assets/minecraft/blockstates";

    fn game(legacy: bool) -> Game {
        let tmp = tempfile::tempdir().unwrap();
        let vanilla = tmp.path().join("vanilla");
        let pack = tmp.path().join("pack");
        let v = &vanilla;
        put(
            v,
            &format!("{M}/cube.json"),
            r##"{"elements": [{"from": [0,0,0], "to": [16,16,16], "faces": {
            "down": {"texture": "#down"}, "up": {"texture": "#up"}, "north": {"texture": "#north"},
            "south": {"texture": "#south"}, "west": {"texture": "#west"}, "east": {"texture": "#east"}}}]}"##,
        );
        put(
            v,
            &format!("{M}/cube_all.json"),
            r##"{"parent": "block/cube", "textures": {"particle": "#all", "down": "#all", "up": "#all", "north": "#all", "south": "#all", "west": "#all", "east": "#all"}}"##,
        );
        if legacy {
            put(
                v,
                &format!("{M}/stone.json"),
                r#"{"parent": "block/cube_all", "textures": {"all": "blocks/stone"}}"#,
            );
            put(
                v,
                &format!("{M}/granite.json"),
                r#"{"parent": "block/cube_all", "textures": {"all": "blocks/stone_granite"}}"#,
            );
            put(
                v,
                &format!("{B}/stone.json"),
                r#"{"variants": {"variant=stone": {"model": "stone"}, "variant=granite": {"model": "granite"}}}"#,
            );
            put(
                v,
                &format!("{M}/glass.json"),
                r#"{"parent": "block/cube_all", "textures": {"all": "blocks/glass"}}"#,
            );
            put(
                v,
                &format!("{B}/glass.json"),
                r#"{"variants": {"normal": {"model": "glass"}}}"#,
            );
            put_png(v, "blocks/stone", 16, 3);
            put_png(v, "blocks/stone_granite", 16, 4);
            put_png(v, "blocks/glass", 16, 5);
        } else {
            put(
                v,
                &format!("{M}/stone.json"),
                r#"{"parent": "minecraft:block/cube_all", "textures": {"all": "minecraft:block/stone"}}"#,
            );
            put(
                v,
                &format!("{B}/stone.json"),
                r#"{"variants": {"": {"model": "minecraft:block/stone"}}}"#,
            );
            put(
                v,
                &format!("{B}/oak_fence.json"),
                r#"{"multipart": [{"apply": {"model": "minecraft:block/stone"}}]}"#,
            );
            put_png(v, "block/stone", 16, 3);
        }
        fs::create_dir_all(&pack).unwrap();
        Game {
            _tmp: tmp,
            vanilla,
            pack,
        }
    }

    fn roots(g: &Game, legacy: bool) -> Roots<'_> {
        Roots {
            pack: &g.pack,
            vanilla: &g.vanilla,
            legacy,
        }
    }

    fn read(path: &Path) -> Value {
        read_json(path).unwrap().unwrap()
    }

    fn trash_files(pack: &Path) -> Vec<String> {
        let t = pack.join(PROJECT_DIR).join("trash");
        walkdir::WalkDir::new(&t)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn add_set_and_remove_on_disk_modern() {
        let g = game(false);
        let r = roots(&g, false);
        let info0 = info(r, "stone").unwrap();
        assert_eq!(info0.textures, ["block/stone"]);
        assert!(info0.variants.is_empty());
        assert_eq!(info(r, "oak_fence").unwrap_err().kind, "multipart");
        assert_eq!(
            add(r, "oak_fence", "block/stone", 2).unwrap_err().kind,
            "multipart"
        );

        let a = add(r, "stone", "block/stone", 2).unwrap();
        assert_eq!(a.texture, "block/stone_2");
        // texture copied at the pack resolution (16 → 32)
        let t2 = texture_file(&g.pack, "block/stone_2").unwrap();
        assert_eq!(crate::textures::png_file_dimensions(&t2), Some((32, 32)));
        let model = read(&model_file(&g.pack, "block/stone_2"));
        assert_eq!(model["textures"]["all"], "minecraft:block/stone_2");
        assert_eq!(model["parent"], "minecraft:block/cube_all");
        let bs = read(&blockstate_file(&g.pack, "stone"));
        assert_eq!(
            bs["variants"][""],
            json!([{"model": "minecraft:block/stone", "weight": 1}, {"model": "minecraft:block/stone_2", "weight": 1}])
        );
        assert_eq!(a.info.preview.len(), 2);
        assert_eq!(a.info.preview[1].model, "block/stone_2");

        let b = add(r, "stone", "block/stone", 2).unwrap();
        assert_eq!(b.texture, "block/stone_3");
        let info2 = set_choice(
            r,
            "stone",
            3,
            Choice {
                weight: 2,
                rotate: true,
            },
        )
        .unwrap();
        assert_eq!(info2.variants[1].weight, 2);
        let bs = read(&blockstate_file(&g.pack, "stone"));
        // original 1, stone_2 1, stone_3 2 split over 4 turns
        let list = bs["variants"][""].as_array().unwrap();
        assert_eq!(list.len(), 6);
        assert_eq!(
            list[0],
            json!({"model": "minecraft:block/stone", "weight": 2})
        );
        assert_eq!(
            list[2],
            json!({"model": "minecraft:block/stone_3", "weight": 1})
        );
        assert_eq!(
            list[3],
            json!({"model": "minecraft:block/stone_3", "y": 90, "weight": 1})
        );
        assert_eq!(
            set_choice(
                r,
                "stone",
                3,
                Choice {
                    weight: 0,
                    rotate: false
                }
            )
            .unwrap_err()
            .kind,
            "bad_weight"
        );
        assert_eq!(
            add(r, "stone", "block/dirt", 2).unwrap_err().kind,
            "other_texture"
        );

        // remove 2: files to the trash, block state rewritten
        let after = remove(r, "stone", 2).unwrap();
        assert_eq!(after.variants.len(), 1);
        assert!(!t2.exists());
        assert!(!model_file(&g.pack, "block/stone_2").exists());
        let trash = trash_files(&g.pack);
        assert!(trash.contains(&"stone_2.png".to_owned()));
        assert!(trash.contains(&"stone_2.json".to_owned()));
        let bs = read(&blockstate_file(&g.pack, "stone"));
        assert!(!bs.to_string().contains("stone_2"));
        // the last one: the game's file came first, so the pack's file goes
        remove(r, "stone", 3).unwrap();
        assert!(!blockstate_file(&g.pack, "stone").exists());
        assert!(!record_file(&g.pack, "stone").exists());
        assert!(info(r, "stone").unwrap().variants.is_empty());
    }

    #[test]
    fn legacy_normal_key_and_old_names() {
        let g = game(true);
        let r = roots(&g, true);
        let a = add(r, "glass", "blocks/glass", 1).unwrap();
        assert_eq!(a.texture, "blocks/glass_2");
        assert_eq!(
            read(&blockstate_file(&g.pack, "glass"))["variants"]["normal"],
            json!([{"model": "glass", "weight": 1}, {"model": "glass_2", "weight": 1}])
        );
        assert_eq!(
            read(&model_file(&g.pack, "block/glass_2"))["textures"]["all"],
            "blocks/glass_2"
        );
        // stone: only the state that shows blocks/stone gets the variant
        let a = add(r, "stone", "blocks/stone", 1).unwrap();
        let bs = read(&blockstate_file(&g.pack, "stone"));
        assert_eq!(
            bs["variants"]["variant=granite"],
            json!({"model": "granite"})
        );
        assert_eq!(bs["variants"]["variant=stone"][1]["model"], "stone_2");
        assert_eq!(a.info.preview_key, "variant=stone");
        assert_eq!(a.info.textures[0], "blocks/stone");
    }

    #[test]
    fn the_packs_own_files_are_respected() {
        let g = game(false);
        let r = roots(&g, false);
        // the pack has its own block state (with a random turn) and its own stone model and texture
        put(
            &g.pack,
            &format!("{B}/stone.json"),
            r#"{"variants": {"": [{"model": "minecraft:block/stone"}, {"model": "minecraft:block/stone", "y": 90}]}}"#,
        );
        put(
            &g.pack,
            &format!("{M}/stone.json"),
            r#"{"parent": "minecraft:block/cube_all", "textures": {"all": "minecraft:block/stone"}, "ambientocclusion": false}"#,
        );
        put_png(&g.pack, "block/stone", 64, 9);
        let a = add(r, "stone", "block/stone", 2).unwrap();
        assert!(a.info.base_from_pack);
        assert!(a.info.has_rotations);
        // the pack's texture is the starting point (64×64, not the game's enlarged)
        let t2 = texture_file(&g.pack, "block/stone_2").unwrap();
        assert_eq!(
            fs::read(&t2).unwrap(),
            fs::read(texture_file(&g.pack, "block/stone").unwrap()).unwrap()
        );
        // the pack's model is the one copied
        assert_eq!(
            read(&model_file(&g.pack, "block/stone_2"))["ambientocclusion"],
            false
        );
        let list = read(&blockstate_file(&g.pack, "stone"))["variants"][""]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(list.len(), 4);
        assert_eq!(
            list[1],
            json!({"model": "minecraft:block/stone", "y": 90, "weight": 1})
        );
        assert_eq!(
            list[3],
            json!({"model": "minecraft:block/stone_2", "y": 90, "weight": 1})
        );
        // the old file went to the trash
        assert!(trash_files(&g.pack).contains(&"stone.json".to_owned()));

        // the user edits the file by hand: a new state is added and kept on the next change
        let mut bs = read(&blockstate_file(&g.pack, "stone"));
        bs["variants"]["snowy=true"] = json!({"model": "minecraft:block/stone"});
        write_json(&blockstate_file(&g.pack, "stone"), &bs).unwrap();
        set_choice(
            r,
            "stone",
            2,
            Choice {
                weight: 3,
                rotate: false,
            },
        )
        .unwrap();
        let bs = read(&blockstate_file(&g.pack, "stone"));
        assert_eq!(
            bs["variants"]["snowy=true"][1],
            json!({"model": "minecraft:block/stone_2", "weight": 3})
        );
        assert_eq!(bs["variants"][""].as_array().unwrap().len(), 4);

        // removing the last variant writes the pack's own base back
        remove(r, "stone", 2).unwrap();
        let bs = read(&blockstate_file(&g.pack, "stone"));
        assert_eq!(
            bs["variants"][""],
            json!([{"model": "minecraft:block/stone"}, {"model": "minecraft:block/stone", "y": 90}])
        );
        assert_eq!(
            bs["variants"]["snowy=true"],
            json!({"model": "minecraft:block/stone"})
        );
    }

    #[test]
    fn listing_blocks() {
        let g = game(false);
        put(
            &g.pack,
            &format!("{B}/my_block.json"),
            r#"{"variants": {"": {"model": "minecraft:block/stone"}}}"#,
        );
        let list = list_blocks(&g.pack, &g.vanilla);
        let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["my_block", "oak_fence", "stone"]);
        assert!(list[1].multipart);
        assert!(list[0].in_pack && !list[2].in_pack);
        let r = roots(&g, false);
        assert_eq!(block_textures(r, "oak_fence").unwrap(), ["block/stone"]);
        assert_eq!(info(r, "nothing").unwrap_err().kind, "no_blockstate");
        assert_eq!(info(r, "../x").unwrap_err().kind, "bad_block");
    }
}

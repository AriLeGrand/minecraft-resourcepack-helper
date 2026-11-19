//! Resource pack formats: reading them from the game jar's `version.json`,
//! the fallback table for old versions, and writing `pack.mcmeta`.

use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

/// First format that uses `min_format` / `max_format` in `pack.mcmeta` (1.21.9).
pub const MIN_MAX_SINCE: u32 = 65;
/// First format that understands `supported_formats` (1.20.2).
pub const SUPPORTED_FORMATS_SINCE: u32 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PackFormat {
    pub major: u32,
    /// Only present from format 65 on.
    pub minor: Option<u32>,
}

impl PackFormat {
    pub fn new(major: u32) -> Self {
        Self { major, minor: None }
    }
    pub fn with_minor(major: u32, minor: u32) -> Self {
        Self {
            major,
            minor: Some(minor),
        }
    }
    /// How the format is shown to the user: `15`, `75.0`.
    pub fn label(&self) -> String {
        match self.minor {
            Some(m) => format!("{}.{}", self.major, m),
            None => self.major.to_string(),
        }
    }
    fn to_json(self) -> Value {
        match self.minor {
            Some(m) if m > 0 => json!([self.major, m]),
            _ => json!(self.major),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum VersionJsonError {
    #[error("version.json is not valid JSON: {0}")]
    Json(String),
}

/// What we need from the `version.json` found at the root of the client jar (1.14+).
#[derive(Debug, Clone, PartialEq)]
pub struct VersionInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub resource_format: Option<PackFormat>,
    pub world_version: Option<u64>,
}

/// Parses `version.json`. `pack_version` has had three shapes:
/// a number (1.14 to 1.16), `{resource, data}` (1.17 to 1.21.8) and
/// `{resource_major, resource_minor, ...}` (1.21.9+).
pub fn parse_version_json(text: &str) -> Result<VersionInfo, VersionJsonError> {
    let v: Value = serde_json::from_str(text).map_err(|e| VersionJsonError::Json(e.to_string()))?;
    let as_u32 = |x: Option<&Value>| {
        x.and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    let pv = v.get("pack_version");
    let resource_format = match pv {
        Some(Value::Number(_)) => as_u32(pv).map(PackFormat::new),
        Some(Value::Object(o)) => {
            if let Some(major) = as_u32(o.get("resource_major")) {
                Some(PackFormat::with_minor(
                    major,
                    as_u32(o.get("resource_minor")).unwrap_or(0),
                ))
            } else {
                as_u32(o.get("resource")).map(PackFormat::new)
            }
        }
        _ => None,
    };
    Ok(VersionInfo {
        id: v.get("id").and_then(Value::as_str).map(str::to_owned),
        name: v.get("name").and_then(Value::as_str).map(str::to_owned),
        resource_format,
        world_version: v.get("world_version").and_then(Value::as_u64),
    })
}

#[derive(Debug, Deserialize)]
struct TableFile {
    formats: Vec<TableRow>,
}

#[derive(Debug, Deserialize)]
struct TableRow {
    format: u32,
    minor: Option<u32>,
    from: String,
    to: String,
}

struct Row {
    format: PackFormat,
    from: McVersion,
    to: McVersion,
}

fn table() -> &'static [Row] {
    static T: OnceLock<Vec<Row>> = OnceLock::new();
    T.get_or_init(|| {
        let f: TableFile = serde_json::from_str(include_str!("../data/pack_formats.json"))
            .expect("pack_formats.json is valid");
        f.formats
            .into_iter()
            .map(|r| Row {
                format: PackFormat {
                    major: r.format,
                    minor: r.minor,
                },
                from: McVersion::parse(&r.from).expect("valid 'from' version"),
                to: McVersion::parse(&r.to).expect("valid 'to' version"),
            })
            .collect()
    })
}

/// Where a pack format came from, so the UI can say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormatSource {
    /// Read from `version.json` in the jar.
    GameFiles,
    /// From the built-in table (old versions have no `version.json`).
    Table,
    /// Version newer or unknown to the table: nearest known release below it.
    Guess,
}

/// Pack format for a release from the built-in table.
pub fn fallback_format(version: &McVersion) -> Option<(PackFormat, FormatSource)> {
    let t = table();
    if let Some(r) = t.iter().find(|r| *version >= r.from && *version <= r.to) {
        return Some((r.format, FormatSource::Table));
    }
    t.iter()
        .rev()
        .find(|r| *version > r.to)
        .map(|r| (r.format, FormatSource::Guess))
}

/// The first release that uses a given major format, if the table knows it.
pub fn first_version_with_format(major: u32) -> Option<McVersion> {
    table()
        .iter()
        .find(|r| r.format.major == major)
        .map(|r| r.from.clone())
}

/// The release range of the newest table row whose format is not above `major`.
/// Used to place a snapshot (no parsable version) on the version line.
pub fn version_for_format(major: u32) -> Option<McVersion> {
    table()
        .iter()
        .rev()
        .find(|r| r.format.major <= major)
        .map(|r| r.from.clone())
}

/// Builds the content of `pack.mcmeta`.
///
/// * formats below 18: `pack_format` only;
/// * 18 to 64: `pack_format`, plus `supported_formats` when `also_supports`
///   widens the range;
/// * 65 and above: `min_format` / `max_format` (and, when the range reaches
///   below 65, the older keys too so old games still accept the pack).
///
/// `description` is written as given (it may contain `§` colour codes).
pub fn pack_mcmeta(
    description: &str,
    target: PackFormat,
    also_supports: Option<PackFormat>,
) -> Value {
    let (lo, hi) = match also_supports {
        Some(o) if o < target => (o, target),
        Some(o) => (target, o),
        None => (target, target),
    };
    let mut pack = Map::new();
    if hi.major >= MIN_MAX_SINCE {
        if lo.major < MIN_MAX_SINCE {
            pack.insert("pack_format".into(), json!(lo.major));
            if lo.major >= SUPPORTED_FORMATS_SINCE || lo != hi {
                pack.insert("supported_formats".into(), json!([lo.major, hi.major]));
            }
        }
        pack.insert("description".into(), json!(description));
        pack.insert("min_format".into(), lo.to_json());
        pack.insert("max_format".into(), hi.to_json());
    } else {
        pack.insert("pack_format".into(), json!(target.major));
        if lo != hi && hi.major >= SUPPORTED_FORMATS_SINCE {
            pack.insert("supported_formats".into(), json!([lo.major, hi.major]));
        }
        pack.insert("description".into(), json!(description));
    }
    json!({ "pack": pack })
}

/// `pack.mcmeta` as pretty text with a trailing newline.
pub fn pack_mcmeta_text(
    description: &str,
    target: PackFormat,
    also_supports: Option<PackFormat>,
) -> String {
    let mut s = serde_json::to_string_pretty(&pack_mcmeta(description, target, also_supports))
        .expect("pack.mcmeta serialises");
    s.push('\n');
    s
}

/// What an existing `pack.mcmeta` says.
#[derive(Debug, Clone, PartialEq)]
pub struct PackMeta {
    pub description: String,
    pub format: Option<PackFormat>,
}

/// Reads an existing `pack.mcmeta` (any era). Text-component descriptions are
/// flattened to plain text.
pub fn read_pack_mcmeta(text: &str) -> Result<PackMeta, VersionJsonError> {
    // Some packs start with a UTF-8 BOM.
    let text = text.trim_start_matches('\u{feff}');
    let v: Value = serde_json::from_str(text).map_err(|e| VersionJsonError::Json(e.to_string()))?;
    let pack = v.get("pack").cloned().unwrap_or(Value::Null);
    fn flatten(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.iter().map(flatten).collect(),
            Value::Object(o) => {
                let mut s = o.get("text").map(flatten).unwrap_or_default();
                if let Some(extra) = o.get("extra") {
                    s.push_str(&flatten(extra));
                }
                s
            }
            _ => String::new(),
        }
    }
    let fmt = |x: &Value| -> Option<PackFormat> {
        match x {
            Value::Number(n) => n.as_u64().map(|n| PackFormat::new(n as u32)),
            Value::Array(a) => {
                let major = a.first()?.as_u64()? as u32;
                Some(match a.get(1).and_then(Value::as_u64) {
                    Some(m) => PackFormat::with_minor(major, m as u32),
                    None => PackFormat::new(major),
                })
            }
            _ => None,
        }
    };
    let format = pack
        .get("max_format")
        .and_then(fmt)
        .or_else(|| pack.get("pack_format").and_then(fmt));
    Ok(PackMeta {
        description: pack.get("description").map(flatten).unwrap_or_default(),
        format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    #[test]
    fn version_json_integer_shape() {
        let i = parse_version_json(
            r#"{"id":"1.14.4","name":"1.14.4","world_version":1976,"pack_version":4}"#,
        )
        .unwrap();
        assert_eq!(i.resource_format, Some(PackFormat::new(4)));
        assert_eq!(i.id.as_deref(), Some("1.14.4"));
    }

    #[test]
    fn version_json_object_shape() {
        // exactly what the 1.20.1 jar contains
        let i = parse_version_json(
            r#"{"id":"1.20.1","pack_version":{"resource":15,"data":15},"world_version":3465}"#,
        )
        .unwrap();
        assert_eq!(i.resource_format, Some(PackFormat::new(15)));
        assert_eq!(i.world_version, Some(3465));
    }

    #[test]
    fn version_json_major_minor_shape() {
        // exactly what the 1.21.11 jar contains
        let i = parse_version_json(
            r#"{"id":"1.21.11","pack_version":{"resource_major":75,"resource_minor":0,"data_major":94,"data_minor":1}}"#,
        )
        .unwrap();
        assert_eq!(i.resource_format, Some(PackFormat::with_minor(75, 0)));
        assert_eq!(i.resource_format.unwrap().label(), "75.0");
    }

    #[test]
    fn version_json_without_pack_version_or_broken() {
        assert_eq!(parse_version_json("{}").unwrap().resource_format, None);
        assert!(parse_version_json("not json").is_err());
    }

    #[test]
    fn fallback_matches_values_read_from_real_jars() {
        for (ver, fmt) in [
            ("1.20.1", 15),
            ("1.20.4", 22),
            ("1.21.1", 34),
            ("1.21.5", 55),
            ("1.21.8", 64),
            ("1.21.11", 75),
        ] {
            let (f, src) = fallback_format(&v(ver)).unwrap();
            assert_eq!(f.major, fmt, "{ver}");
            assert_eq!(src, FormatSource::Table);
        }
    }

    #[test]
    fn fallback_for_old_versions() {
        assert_eq!(fallback_format(&v("1.8.9")).unwrap().0, PackFormat::new(1));
        assert_eq!(fallback_format(&v("1.12.2")).unwrap().0, PackFormat::new(3));
        assert_eq!(fallback_format(&v("1.16.5")).unwrap().0, PackFormat::new(6));
        assert_eq!(
            fallback_format(&v("1.19.4")).unwrap().0,
            PackFormat::new(13)
        );
        assert_eq!(fallback_format(&v("1.5.2")), None);
    }

    #[test]
    fn fallback_guesses_for_unknown_newer_versions() {
        let (f, src) = fallback_format(&v("99.1")).unwrap();
        assert_eq!(src, FormatSource::Guess);
        assert!(f.major >= 97);
    }

    #[test]
    fn table_is_sorted_and_without_overlap() {
        let t = table();
        for w in t.windows(2) {
            assert!(w[0].from <= w[0].to);
            assert!(w[0].to < w[1].from, "{} overlaps {}", w[0].to, w[1].from);
            assert!(w[0].format.major < w[1].format.major);
        }
    }

    #[test]
    fn mcmeta_old_format() {
        let m = pack_mcmeta("§bOcean", PackFormat::new(3), None);
        assert_eq!(
            m,
            json!({"pack": {"pack_format": 3, "description": "§bOcean"}})
        );
    }

    #[test]
    fn mcmeta_supported_range() {
        let m = pack_mcmeta("x", PackFormat::new(34), Some(PackFormat::new(22)));
        assert_eq!(m["pack"]["pack_format"], 34);
        assert_eq!(m["pack"]["supported_formats"], json!([22, 34]));
        // a range that ends before format 18 cannot be expressed
        let m = pack_mcmeta("x", PackFormat::new(15), Some(PackFormat::new(13)));
        assert!(m["pack"].get("supported_formats").is_none());
    }

    #[test]
    fn mcmeta_min_max_format() {
        let m = pack_mcmeta("x", PackFormat::with_minor(75, 0), None);
        assert_eq!(
            m,
            json!({"pack": {"description": "x", "min_format": 75, "max_format": 75}})
        );
        let m = pack_mcmeta("x", PackFormat::with_minor(97, 1), None);
        assert_eq!(m["pack"]["max_format"], json!([97, 1]));
        let m = pack_mcmeta(
            "x",
            PackFormat::with_minor(75, 0),
            Some(PackFormat::new(64)),
        );
        assert_eq!(m["pack"]["pack_format"], 64);
        assert_eq!(m["pack"]["supported_formats"], json!([64, 75]));
        assert_eq!(m["pack"]["min_format"], 64);
    }

    #[test]
    fn mcmeta_round_trip() {
        for f in [
            PackFormat::new(1),
            PackFormat::new(46),
            PackFormat::with_minor(75, 0),
            PackFormat::with_minor(97, 1),
        ] {
            let text = pack_mcmeta_text("§bOcean textures §7by Ari", f, None);
            let back = read_pack_mcmeta(&text).unwrap();
            assert_eq!(back.description, "§bOcean textures §7by Ari");
            assert_eq!(back.format.unwrap().major, f.major);
        }
    }

    #[test]
    fn reads_text_component_description_and_bom() {
        let m = read_pack_mcmeta("\u{feff}{\"pack\":{\"pack_format\":15,\"description\":[{\"text\":\"A\"},\" B\",{\"text\":\"C\",\"extra\":[\"D\"]}]}}").unwrap();
        assert_eq!(m.description, "A BCD");
    }
}

//! Minecraft Java version numbers (`1.8.9`, `1.21.11`, `26.1`).

use std::cmp::Ordering;
use std::fmt;

/// A release version. Snapshots and pre-releases do not parse; callers fall
/// back to the pack format read from the jar for those.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct McVersion {
    parts: Vec<u32>,
}

impl McVersion {
    /// Parses a plain release id such as `1.20.1` or `26.1`.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        for p in s.split('.') {
            if p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            parts.push(p.parse().ok()?);
        }
        if parts.len() < 2 || parts.len() > 3 {
            return None;
        }
        Some(Self { parts })
    }

    /// Finds a release id inside a launcher folder name, for example
    /// `fabric-loader-0.15.7-1.20.1` gives `1.20.1` and
    /// `1.8.9-forge1.8.9-11.15.1.2318-1.8.9` gives `1.8.9`.
    /// Prefer the id from the jar's `version.json` when there is one.
    pub fn find_in(name: &str) -> Option<Self> {
        if let Some(v) = Self::parse(name) {
            return Some(v);
        }
        let mut best: Option<Self> = None;
        for token in name.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
            if let Some(v) = Self::parse(token) {
                if v.looks_like_minecraft() {
                    best = Some(v); // the last match wins: loaders put the game version last
                }
            }
        }
        best
    }

    fn looks_like_minecraft(&self) -> bool {
        match self.parts[0] {
            1 => self.parts[1] <= 21,
            n => (25..100).contains(&n),
        }
    }

    pub fn parts(&self) -> &[u32] {
        &self.parts
    }

    /// True for versions before the 1.13 "Flattening".
    pub fn is_pre_flattening(&self) -> bool {
        *self < Self::parse("1.13").unwrap()
    }
}

impl Ord for McVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        for i in 0..3 {
            let a = self.parts.get(i).copied().unwrap_or(0);
            let b = other.parts.get(i).copied().unwrap_or(0);
            match a.cmp(&b) {
                Ordering::Equal => continue,
                o => return o,
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for McVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for McVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s: Vec<String> = self.parts.iter().map(|p| p.to_string()).collect();
        f.write_str(&s.join("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> McVersion {
        McVersion::parse(s).unwrap()
    }

    #[test]
    fn parses_releases() {
        assert_eq!(v("1.8.9").parts(), &[1, 8, 9]);
        assert_eq!(v("1.13").parts(), &[1, 13]);
        assert_eq!(v("26.1").to_string(), "26.1");
    }

    #[test]
    fn rejects_snapshots_and_garbage() {
        for s in [
            "",
            "1",
            "1.21.6-pre4",
            "26.1-snapshot-6",
            "23w13a",
            "1..2",
            "a.b",
            "1.2.3.4",
        ] {
            assert!(McVersion::parse(s).is_none(), "{s}");
        }
    }

    #[test]
    fn orders_numerically() {
        assert!(v("1.8.9") < v("1.12.2"));
        assert!(v("1.12.2") < v("1.13"));
        assert!(v("1.21.8") < v("1.21.11"));
        assert!(v("1.21.11") < v("26.1"));
        assert_eq!(v("1.13").cmp(&v("1.13.0")), Ordering::Equal);
    }

    #[test]
    fn flattening_boundary() {
        assert!(v("1.12.2").is_pre_flattening());
        assert!(!v("1.13").is_pre_flattening());
        assert!(!v("26.1").is_pre_flattening());
    }

    #[test]
    fn finds_version_in_loader_names() {
        assert_eq!(
            McVersion::find_in("fabric-loader-0.15.7-1.20.1"),
            Some(v("1.20.1"))
        );
        assert_eq!(
            McVersion::find_in("1.8.9-forge1.8.9-11.15.1.2318-1.8.9"),
            Some(v("1.8.9"))
        );
        assert_eq!(McVersion::find_in("1.21.6-pre4"), Some(v("1.21.6")));
        assert_eq!(McVersion::find_in("26.4-snapshot-5"), Some(v("26.4")));
        assert_eq!(McVersion::find_in("my-profile"), None);
    }
}

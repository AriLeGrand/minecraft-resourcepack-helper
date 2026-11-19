//! The shared particle sheet used before 1.14 (`textures/particle/particles.png`).
//!
//! Each particle owns fixed cells of a 16x16 grid. The app must only ever edit
//! the cells of the particle the user picked, and warn when those cells are
//! shared with other particles.

use crate::version::McVersion;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct LegacyParticle {
    /// Modern particle id (1.13+), e.g. `large_smoke`.
    pub id: String,
    /// Name before 1.13, e.g. `largesmoke`.
    pub legacy: String,
    /// Sprite names in play order.
    pub sprites: Vec<String>,
    /// `age` (played over the lifetime), `random`, `single` or `state`.
    pub mode: String,
    #[serde(default)]
    pub since: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct NotParticle {
    pub name: String,
    pub cells: Vec<u16>,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct OtherFile {
    pub id: String,
    pub legacy: String,
    pub file: String,
    pub grid: u32,
    pub vanilla_size: u32,
    pub sprites: Vec<String>,
    pub mode: String,
    #[serde(default)]
    pub until: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParticleSheet {
    pub file: String,
    pub until: String,
    pub grid: u32,
    pub vanilla_size: u32,
    pub sprites: BTreeMap<String, u16>,
    #[serde(default)]
    pub sprites_since: BTreeMap<String, String>,
    pub not_particles: Vec<NotParticle>,
    pub unused_cells: Vec<u16>,
    pub particles: Vec<LegacyParticle>,
    pub other_files: Vec<OtherFile>,
}

/// A rectangle in pixels inside the sheet image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CellRect {
    pub x: u32,
    pub y: u32,
    pub size: u32,
}

impl ParticleSheet {
    pub fn builtin() -> &'static ParticleSheet {
        static S: OnceLock<ParticleSheet> = OnceLock::new();
        S.get_or_init(|| {
            serde_json::from_str(include_str!("../data/particle_sheet.json"))
                .expect("particle_sheet.json is valid")
        })
    }

    /// Whether a game version uses the shared sheet.
    pub fn applies_to(&self, version: &McVersion) -> bool {
        *version <= McVersion::parse(&self.until).expect("valid 'until'")
    }

    pub fn particle(&self, id_or_legacy: &str) -> Option<&LegacyParticle> {
        self.particles
            .iter()
            .find(|p| p.id == id_or_legacy || p.legacy == id_or_legacy)
    }

    /// Particles that exist in `version` (some cells were only used from 1.9 or 1.11).
    pub fn particles_in(&self, version: &McVersion) -> Vec<&LegacyParticle> {
        self.particles
            .iter()
            .filter(|p| {
                p.since
                    .as_deref()
                    .and_then(McVersion::parse)
                    .is_none_or(|s| *version >= s)
            })
            .collect()
    }

    /// Cell indexes of a particle, in play order (may repeat cells of other particles).
    pub fn cells_of(&self, particle: &LegacyParticle) -> Vec<u16> {
        particle
            .sprites
            .iter()
            .filter_map(|s| self.sprites.get(s).copied())
            .collect()
    }

    /// Other particles that use at least one of this particle's cells.
    pub fn shared_with(&self, particle: &LegacyParticle) -> Vec<&LegacyParticle> {
        let mine = self.cells_of(particle);
        self.particles
            .iter()
            .filter(|p| p.id != particle.id && self.cells_of(p).iter().any(|c| mine.contains(c)))
            .collect()
    }

    /// Pixel rectangle of a cell for a sheet that is `sheet_px` wide (128 in
    /// vanilla, larger in higher-resolution packs). `None` if the cell is out
    /// of range or the sheet width is not a multiple of the grid.
    pub fn cell_rect(&self, cell: u16, sheet_px: u32) -> Option<CellRect> {
        let cell = u32::from(cell);
        if cell >= self.grid * self.grid || sheet_px == 0 || !sheet_px.is_multiple_of(self.grid) {
            return None;
        }
        let size = sheet_px / self.grid;
        Some(CellRect {
            x: (cell % self.grid) * size,
            y: (cell / self.grid) * size,
            size,
        })
    }

    /// The cell under a pixel, to refuse edits outside the picked particle.
    pub fn cell_at(&self, x: u32, y: u32, sheet_px: u32) -> Option<u16> {
        if sheet_px == 0 || !sheet_px.is_multiple_of(self.grid) || x >= sheet_px || y >= sheet_px {
            return None;
        }
        let size = sheet_px / self.grid;
        Some(((y / size) * self.grid + x / size) as u16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn s() -> &'static ParticleSheet {
        ParticleSheet::builtin()
    }

    #[test]
    fn applies_before_1_14_only() {
        assert!(s().applies_to(&McVersion::parse("1.8.9").unwrap()));
        assert!(s().applies_to(&McVersion::parse("1.13.2").unwrap()));
        assert!(!s().applies_to(&McVersion::parse("1.14").unwrap()));
    }

    #[test]
    fn positions_checked_against_the_real_sheet() {
        // these were confirmed by comparing cells of a real 1.8.9 sheet with 1.20.1 images
        for (name, cell) in [
            ("generic_0", 0),
            ("generic_7", 7),
            ("splash_0", 19),
            ("splash_3", 22),
            ("bubble", 32),
            ("flame", 48),
            ("lava", 49),
            ("note", 64),
            ("enchanted_hit", 66),
            ("heart", 80),
            ("angry", 81),
            ("glint", 82),
            ("drip_hang", 112),
            ("drip_fall", 113),
            ("effect_0", 128),
            ("effect_7", 135),
            ("spell_0", 144),
            ("spark_0", 160),
            ("spark_6", 166),
            ("sga_a", 225),
            ("sga_z", 250),
        ] {
            assert_eq!(s().sprites[name], cell, "{name}");
        }
    }

    #[test]
    fn sprites_do_not_collide() {
        let mut seen = HashSet::new();
        for (name, cell) in &s().sprites {
            assert!(u32::from(*cell) < s().grid * s().grid, "{name}");
            assert!(
                seen.insert(*cell),
                "cell {cell} used by two sprites ({name})"
            );
        }
        for n in &s().not_particles {
            for c in &n.cells {
                assert!(seen.insert(*c), "{} overlaps a particle sprite", n.name);
            }
        }
        for c in &s().unused_cells {
            assert!(seen.insert(*c), "unused cell {c} is also assigned");
        }
    }

    #[test]
    fn every_particle_sprite_exists() {
        let mut ids = HashSet::new();
        for p in &s().particles {
            assert!(ids.insert(&p.id), "duplicate particle {}", p.id);
            assert!(!p.sprites.is_empty());
            assert_eq!(
                s().cells_of(p).len(),
                p.sprites.len(),
                "{} names an unknown sprite",
                p.id
            );
            assert!(["age", "random", "single", "state"].contains(&p.mode.as_str()));
        }
    }

    #[test]
    fn smoke_and_portal_share_cells() {
        let smoke = s().particle("smoke").unwrap();
        assert_eq!(s().cells_of(smoke), [7, 6, 5, 4, 3, 2, 1, 0]);
        let shared: Vec<&str> = s()
            .shared_with(smoke)
            .iter()
            .map(|p| p.id.as_str())
            .collect();
        assert!(shared.contains(&"portal") && shared.contains(&"large_smoke"));
        assert!(s().shared_with(s().particle("heart").unwrap()).is_empty());
        assert_eq!(s().particle("largesmoke").unwrap().id, "large_smoke");
    }

    #[test]
    fn enchant_uses_26_glyph_cells() {
        let e = s().particle("enchant").unwrap();
        let cells = s().cells_of(e);
        assert_eq!(cells.len(), 26);
        assert_eq!((cells[0], cells[25]), (225, 250));
    }

    #[test]
    fn version_gated_particles() {
        let v189 = McVersion::parse("1.8.9").unwrap();
        let v112 = McVersion::parse("1.12.2").unwrap();
        assert!(!s().particles_in(&v189).iter().any(|p| p.id == "end_rod"));
        assert!(s().particles_in(&v112).iter().any(|p| p.id == "end_rod"));
        assert!(s()
            .particles_in(&v112)
            .iter()
            .any(|p| p.id == "totem_of_undying"));
    }

    #[test]
    fn cell_rectangles_scale_with_the_sheet() {
        assert_eq!(
            s().cell_rect(0, 128),
            Some(CellRect {
                x: 0,
                y: 0,
                size: 8
            })
        );
        assert_eq!(
            s().cell_rect(33, 128),
            Some(CellRect {
                x: 8,
                y: 16,
                size: 8
            })
        );
        assert_eq!(
            s().cell_rect(250, 256),
            Some(CellRect {
                x: 160,
                y: 240,
                size: 16
            })
        );
        assert_eq!(s().cell_rect(256, 128), None);
        assert_eq!(s().cell_rect(0, 100), None);
        assert_eq!(s().cell_at(9, 17, 128), Some(33));
        assert_eq!(s().cell_at(255, 255, 256), Some(255));
        assert_eq!(s().cell_at(128, 0, 128), None);
    }

    #[test]
    fn explosion_has_its_own_file() {
        let e = s()
            .other_files
            .iter()
            .find(|f| f.id == "explosion")
            .unwrap();
        assert_eq!(e.file, "entity/explosion");
        assert_eq!((e.grid, e.sprites.len()), (4, 16));
    }
}

//! Deterministic city-map generation contracts.
pub mod field;
pub mod geom;
pub mod hydrology;
pub mod parity;
pub mod random;
pub mod shoreline;
pub mod site;
pub mod terrain;
pub mod types;
pub use geom::Point;
pub use random::{Rng, derive, mulberry};

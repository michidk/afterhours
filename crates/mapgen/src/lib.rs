//! Deterministic city-map generation contracts.
pub mod field;
pub mod geom;
pub mod parity;
pub mod random;
pub mod terrain;
pub mod types;
pub use geom::Point;
pub use random::{derive, mulberry, Rng};

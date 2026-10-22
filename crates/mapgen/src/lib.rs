//! Deterministic city-map generation contracts.
//!
//! The public data shapes mirror `mapgen/types.ts`.  The command-line entry point
//! currently delegates the large parity oracle to the TypeScript pipeline; keeping
//! these contracts in Rust first makes the eventual stage-by-stage port explicit
//! without changing the versioned artifact.

pub mod field;
pub mod geom;
pub mod hydrology;
pub mod random;
pub mod shoreline;
pub mod terrain;
pub mod types;

pub use geom::Point;
pub use random::{Rng, derive, mulberry};

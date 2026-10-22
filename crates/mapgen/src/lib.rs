//! Deterministic city-map generation contracts.
//!
//! The public data shapes mirror `mapgen/types.ts`.  The command-line entry point
//! currently delegates the large parity oracle to the TypeScript pipeline; keeping
//! these contracts in Rust first makes the eventual stage-by-stage port explicit
//! without changing the versioned artifact.

pub mod blocks;
pub mod buildings;
pub mod city;
pub mod field;
pub mod geom;
pub mod packing;
pub mod parity;
pub mod pipeline;
pub mod random;
pub mod types;
pub mod vegetation;

pub use geom::Point;
pub use random::{Rng, derive, mulberry};

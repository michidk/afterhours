//! Deterministic city-map generation contracts.
//!
//! The public data shapes mirror `mapgen/types.ts`.  The command-line entry point
//! remains disabled until the native pipeline is complete. Integration tests may
//! run the TypeScript oracle; native generation never launches it.

pub mod field;
pub mod geom;
pub mod graph;
pub mod parity;
pub mod random;
pub mod roadgeometry;
pub mod roads;
pub mod streetfit;
pub mod types;

pub use geom::Point;
pub use random::{Rng, derive, mulberry};
pub use roadgeometry::{
    bridge_decks, build_road_geometry, densify_centrelines, smooth_centrelines, solve_profiles,
    stamp_roads,
};
pub use roads::{RoadInputs, generate_roads};
pub use streetfit::{sink_under_streets, street_polygons, street_test};

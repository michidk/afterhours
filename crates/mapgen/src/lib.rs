//! Deterministic city-map generation: native stages and the version 7 city converter.
//! Integration tests may run the TypeScript oracle; native generation never launches it.

pub mod blocks;
pub mod buildings;
pub mod city;
pub mod city_geometry;
pub mod city_sink;
pub mod city_types;
pub mod features;
pub mod field;
pub mod geom;
pub mod graph;
pub mod hydrology;
pub mod js_math;
pub mod packing;
pub mod parity;
pub mod pipeline;
pub mod random;
pub mod roadgeometry;
pub mod roads;
pub mod shoreline;
pub mod site;
pub mod streetfit;
pub mod terrain;
pub mod testworld;
pub mod types;
pub mod vegetation;

pub use geom::Point;
pub use random::{Rng, derive, js_round, mulberry};
pub use roadgeometry::{
    bridge_decks, build_road_geometry, densify_centrelines, smooth_centrelines, solve_profiles,
    stamp_roads,
};
pub use roads::{RoadInputs, generate_roads};
pub use streetfit::{sink_under_streets, street_polygons, street_test};

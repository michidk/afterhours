//! Road-stage contracts. Routing is kept separate from geometry and city packing.

use crate::{
    geom::Point,
    hydrology::Hydrology,
    types::{HeightField, MapOptions, RoadGraph},
};

pub struct RoadInputs<'a> {
    pub field: &'a HeightField,
    pub hydrology: &'a Hydrology,
    pub centre: Point,
    pub options: &'a MapOptions,
}

pub fn empty_graph() -> RoadGraph {
    RoadGraph::default()
}

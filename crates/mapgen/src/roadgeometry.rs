//! Road surface contracts. The TypeScript oracle still supplies the production
//! polygons while this module establishes the Rust representation used by callers.

use crate::{geom::Point, types::RoadGraph};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    X,
    Z,
}

#[derive(Clone, Debug, Default)]
pub struct RoadGeometry {
    pub junctions: Vec<(usize, Vec<Point>)>,
    pub bands: Vec<(usize, Vec<Point>)>,
    pub trims: Vec<(f64, f64)>,
    pub phases: Vec<(Option<Phase>, Option<Phase>)>,
}

pub fn build(graph: &RoadGraph) -> RoadGeometry {
    RoadGeometry {
        trims: vec![(0.0, 0.0); graph.edges.len()],
        phases: vec![(None, None); graph.edges.len()],
        ..RoadGeometry::default()
    }
}

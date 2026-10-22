//! Terrain-conformance boundary for road profiles.

use crate::{
    geom::Point,
    types::{HeightField, RoadEdge},
};

pub fn edge_height_at(edge: &RoadEdge, point: Point) -> f64 {
    if edge.points.len() < 2 {
        return edge.heights.first().copied().unwrap_or(0.0);
    }
    let mut best = (f64::INFINITY, edge.heights[0]);
    for i in 1..edge.points.len() {
        let a = edge.points[i - 1];
        let b = edge.points[i];
        let ab = crate::geom::sub(b, a);
        let denominator = crate::geom::dot(ab, ab);
        let t = if denominator == 0.0 {
            0.0
        } else {
            crate::geom::dot(crate::geom::sub(point, a), ab) / denominator
        };
        let t = t.clamp(0.0, 1.0);
        let q = crate::geom::lerp(a, b, t);
        let distance = crate::geom::dist(point, q);
        if distance < best.0 {
            best = (
                distance,
                edge.heights.get(i - 1).copied().unwrap_or(0.0) * (1.0 - t)
                    + edge.heights.get(i).copied().unwrap_or(0.0) * t,
            );
        }
    }
    best.1
}

pub fn sink_under_streets(_field: &mut HeightField) {}

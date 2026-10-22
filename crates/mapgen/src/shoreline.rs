//! Shoreline helpers shared by water and city feature stages.

use crate::{geom::Point, types::HeightField};

pub fn water_cell(field: &HeightField, x: usize, z: usize, sea_level: f32) -> bool {
    field.data[z * field.w + x] <= sea_level
}

pub fn outline(points: &[Point]) -> Vec<Point> {
    points.to_vec()
}

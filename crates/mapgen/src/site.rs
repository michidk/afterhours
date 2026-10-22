//! Settlement-site scoring contracts.

use crate::{geom::Point, types::HeightField};

pub fn choose_centre(field: &HeightField, desirability: &[f32]) -> Point {
    let index = desirability
        .iter()
        .enumerate()
        .max_by(|(a, av), (b, bv)| av.total_cmp(bv).then(b.cmp(a)))
        .map(|(i, _)| i)
        .unwrap_or(0);
    crate::field::to_world(field, index % field.w, index / field.w)
}

pub fn desirability(field: &HeightField) -> Vec<f32> {
    field
        .data
        .iter()
        .map(|height| (1.0 - height.abs() / 200.0).clamp(0.0, 1.0))
        .collect()
}

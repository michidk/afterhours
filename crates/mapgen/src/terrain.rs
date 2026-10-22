//! Terrain-stage helpers.  The full noise composition remains in the oracle bridge
//! until the parity port reaches this stage.

use crate::{field, random::Rng, types::HeightField};

pub const LAND_FRACTION: f64 = 0.44;

pub fn thermal_erosion(field: &mut HeightField, iterations: usize, talus_angle: f64) {
    let talus = (talus_angle * field.cell) as f32;
    for _ in 0..iterations {
        for z in 1..field.h - 1 {
            for x in 1..field.w - 1 {
                let i = z * field.w + x;
                if field.data[i] <= 0.0 {
                    continue;
                }
                let mut lowest = i;
                for n in [i - 1, i + 1, i - field.w, i + field.w] {
                    if field.data[n] < field.data[lowest] {
                        lowest = n;
                    }
                }
                let difference = field.data[i] - field.data[lowest];
                if difference > talus {
                    let movement = (difference - talus) * 0.25;
                    field.data[i] -= movement;
                    field.data[lowest] += movement;
                }
            }
        }
    }
}

pub fn settle(field: &mut HeightField, radius: usize) {
    let smoothed = field::blur(&field.data, field.w, field.h, radius, 1);
    for (height, smooth) in field.data.iter_mut().zip(smoothed) {
        if *height > -0.5 {
            *height = smooth;
        }
    }
}

pub fn droplet_erosion(_field: &mut HeightField, _rng: &mut Rng, _count: usize) {
    // shortcut: the exact droplet implementation stays behind the TypeScript oracle;
    // port when the terrain parity stage is enabled.
}

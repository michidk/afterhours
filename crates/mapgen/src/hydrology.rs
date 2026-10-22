//! Hydrology contracts used by roads, zoning, and shoreline stages.

use crate::{
    geom::Point,
    types::{HeightField, Lake, River, RiverOrder},
};

#[derive(Clone, Debug, Default)]
pub struct Hydrology {
    pub rivers: Vec<River>,
    pub lakes: Vec<Lake>,
    pub flow: Vec<f32>,
}

pub fn flow_accumulation(field: &HeightField, sea_level: f32) -> Vec<f32> {
    let mut flow = field
        .data
        .iter()
        .map(|&height| if height > sea_level { 1.0 } else { 0.0 })
        .collect::<Vec<_>>();
    let mut order = (0..field.data.len()).collect::<Vec<_>>();
    order.sort_by(|&a, &b| field.data[b].total_cmp(&field.data[a]).then(a.cmp(&b)));
    for i in order {
        let x = i % field.w;
        let z = i / field.w;
        let mut target = None;
        let mut slope = 0.0_f32;
        for (dx, dz, distance) in [
            (1_i32, 0_i32, 1.0_f32),
            (-1, 0, 1.0),
            (0, 1, 1.0),
            (0, -1, 1.0),
            (1, 1, 2.0_f32.sqrt()),
            (1, -1, 2.0_f32.sqrt()),
            (-1, 1, 2.0_f32.sqrt()),
            (-1, -1, 2.0_f32.sqrt()),
        ] {
            let nx = x as i32 + dx;
            let nz = z as i32 + dz;
            if nx < 0 || nz < 0 || nx >= field.w as i32 || nz >= field.h as i32 {
                continue;
            }
            let n = nz as usize * field.w + nx as usize;
            let candidate = (field.data[i] - field.data[n]) / distance;
            if candidate > slope {
                slope = candidate;
                target = Some(n);
            }
        }
        if let Some(n) = target {
            flow[n] += flow[i];
        }
    }
    flow
}

pub fn empty() -> Hydrology {
    Hydrology::default()
}

pub fn river(points: Vec<Point>, widths: Vec<f64>) -> River {
    River {
        points,
        widths,
        order: RiverOrder::Stream,
    }
}

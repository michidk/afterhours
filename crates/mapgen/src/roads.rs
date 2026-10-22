//! Road graph generation.  The implementation keeps all sampling in f64 and all
//! candidate ordering explicit, which makes dump comparisons reproducible.
use crate::{
    field::{cell_slope, sample, to_world},
    geom::{self, Point},
    graph::GraphBuilder,
    types::{HeightField, Hydrology, RoadGraph, RoadKind},
};

#[derive(Clone, Debug)]
pub struct RoadInputs {
    pub field: HeightField,
    pub hydro: Hydrology,
    pub desirability: Vec<f32>,
    pub centre: Point,
    pub seed: i32,
    pub debug: bool,
}

fn land(f: &HeightField, p: Point) -> bool {
    sample(f, p.x, p.z) > 0.3
}
fn water_at(f: &HeightField, h: &Hydrology, p: Point) -> f32 {
    let x = ((p.x + f.size / 2.0) / f.cell).round() as isize;
    let z = ((p.z + f.size / 2.0) / f.cell).round() as isize;
    if x < 0 || z < 0 || x >= f.w as isize || z >= f.h as isize {
        return 0.0;
    }
    h.water_distance
        .get(z as usize * f.w + x as usize)
        .copied()
        .unwrap_or(0.0)
}
fn route(a: Point, b: Point, f: &HeightField, h: &Hydrology) -> Option<Vec<Point>> {
    let n = ((geom::dist(a, b) / 12.0).ceil() as usize).max(1);
    let mut p = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let q = geom::lerp(a, b, i as f64 / n as f64);
        if !land(f, q) && i > 0 && i < n && water_at(f, h, q) > 7.0 {
            return None;
        }
        p.push(q);
    }
    Some(p)
}

/// Generate the deterministic coarse road skeleton.  Subsequent geometry stages
/// are intentionally independent, so callers can feed hand-authored graphs too.
pub fn generate_roads(input: &RoadInputs, mut progress: Option<&mut dyn FnMut(&str)>) -> RoadGraph {
    if let Some(p) = progress.as_mut() {
        p("arterials");
    }
    let f = &input.field;
    let mut g = GraphBuilder::new();
    let centre = g.add_node(input.centre.x, input.centre.z);
    let mut candidates: Vec<(f32, Point)> = input
        .desirability
        .iter()
        .enumerate()
        .filter_map(|(i, &d)| {
            if d > 0.12 {
                let x = i % f.w;
                let z = i / f.w;
                Some((d, to_world(f, x, z)))
            } else {
                None
            }
        })
        .collect();
    candidates.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1.x.total_cmp(&b.1.x))
            .then_with(|| a.1.z.total_cmp(&b.1.z))
    });
    let mut used = Vec::new();
    for (_, p) in candidates.iter().copied() {
        if used.len() >= 8 {
            break;
        }
        if geom::dist(p, input.centre) < 180.0
            || used.iter().any(|q: &Point| geom::dist(*q, p) < 420.0)
            || water_at(f, &input.hydro, p) < 20.0
            || !land(f, p)
        {
            continue;
        }
        if let Some(line) = route(input.centre, p, f, &input.hydro) {
            let mut from = centre;
            for q in line.into_iter().skip(1) {
                if let Some((n, _)) = g.insert(from, q, RoadKind::Avenue, Default::default(), false)
                {
                    from = n;
                }
            }
            used.push(p);
        }
    }
    if let Some(p) = progress.as_mut() {
        p("streets");
    }
    // Fill a few desirable cells with short streets.  Stable row-major ordering is
    // the same tie rule used by the TypeScript seed queue.
    for (_, p) in candidates.iter().copied().take(48) {
        if !land(f, p) || water_at(f, &input.hydro, p) < 20.0 {
            continue;
        }
        let near = g.to_road_graph().nodes.into_iter().min_by(|a, b| {
            geom::dist(Point { x: a.x, z: a.z }, p)
                .total_cmp(&geom::dist(Point { x: b.x, z: b.z }, p))
        });
        if let Some(n) = near
            && let Some(line) = route(Point { x: n.x, z: n.z }, p, f, &input.hydro)
        {
            let mut from = n.id;
            for q in line.into_iter().skip(1) {
                if let Some((next, _)) =
                    g.insert(from, q, RoadKind::Street, Default::default(), false)
                {
                    from = next;
                }
            }
        }
    }
    if let Some(p) = progress.as_mut() {
        p("cleanup");
    }
    g.bridge_rivers(&input.hydro.rivers);
    g.to_road_graph()
}

pub fn sample_desirability(input: &RoadInputs, p: Point) -> f32 {
    let x = ((p.x + input.field.size / 2.0) / input.field.cell).round() as isize;
    let z = ((p.z + input.field.size / 2.0) / input.field.cell).round() as isize;
    if x < 0 || z < 0 || x >= input.field.w as isize || z >= input.field.h as isize {
        0.0
    } else {
        input.desirability[z as usize * input.field.w + x as usize]
    }
}
pub fn slope_at(f: &HeightField, p: Point) -> f64 {
    let e = f.cell * 2.0;
    ((sample(f, p.x + e, p.z) - sample(f, p.x - e, p.z)) / (2.0 * e))
        .hypot((sample(f, p.x, p.z + e) - sample(f, p.x, p.z - e)) / (2.0 * e))
}
pub fn _cell_slope(f: &HeightField, x: usize, z: usize) -> f64 {
    cell_slope(f, x, z)
}

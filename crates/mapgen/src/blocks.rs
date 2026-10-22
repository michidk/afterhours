use crate::{
    field::{sample, slope},
    geom::{area, centroid, inset_polygon, oriented_box},
    random::derive,
    types::{Block, HeightField, Hydrology, Lot, Point, RoadGraph, Zone},
};
const SIDEWALK: f64 = 2.0;
pub fn generate_blocks(
    graph: &RoadGraph,
    field: &HeightField,
    hydro: &Hydrology,
    centre: Point,
    seed: i32,
) -> Vec<Block> {
    let mut rng = derive(seed, "blocks");
    let mut out = Vec::new();
    for e in &graph.edges {
        if e.points.len() < 3 {
            continue;
        }
        let ring = e.points.clone();
        let a = area(&ring);
        if a < 400.0 {
            continue;
        }
        let Some((_, w, d, _)) = oriented_box(&ring) else {
            continue;
        };
        if w.max(d) > 900.0 {
            continue;
        };
        let Some(interior) = inset_polygon(&ring, e.width / 2.0 + SIDEWALK) else {
            continue;
        };
        if area(&interior) < 150.0 {
            continue;
        };
        let c = centroid(&interior);
        let z = zone(c, &interior, graph, e.id, field, hydro, centre);
        let lots = if matches!(z, Zone::Park | Zone::Rural) {
            Vec::new()
        } else {
            subdivide(&interior, z, &mut rng)
        };
        out.push(Block {
            id: out.len(),
            polygon: ring,
            interior,
            zone: z,
            lots,
        });
    }
    out
}
fn zone(
    c: Point,
    p: &[Point],
    g: &RoadGraph,
    eid: usize,
    f: &HeightField,
    h: &Hydrology,
    centre: Point,
) -> Zone {
    let mut steep: f64 = 0.;
    let mut low = f64::INFINITY;
    for q in std::iter::once(c).chain(p.iter().copied()) {
        steep = steep.max(slope(f, q.x, q.z));
        low = low.min(sample(f, q.x, q.z));
    }
    if steep > 0.42 || low < 1.2 {
        return Zone::Park;
    }
    let d = ((c.x - centre.x).powi(2) + (c.z - centre.z).powi(2)).sqrt();
    let _wet = h.water_distance.first();
    let rank = match g.edges[eid].kind {
        crate::types::RoadKind::Highway => 3,
        crate::types::RoadKind::Avenue => 2,
        _ => 1,
    };
    if d < 260.0 {
        Zone::Core
    } else if d < 520.0 && rank >= 2 {
        Zone::Commercial
    } else if d < 900.0 {
        Zone::Residential
    } else {
        Zone::Suburb
    }
}
fn subdivide(poly: &[Point], z: Zone, r: &mut crate::random::Rng) -> Vec<Lot> {
    let min = match z {
        Zone::Industrial => 2000.0,
        Zone::Suburb => 450.0,
        _ => 320.0,
    };
    let max = match z {
        Zone::Industrial => 6000.0,
        Zone::Suburb => 1000.0,
        _ => 900.0,
    };
    let a = area(poly);
    if a < min * 0.6 {
        return Vec::new();
    }
    if a <= max {
        return vec![Lot {
            polygon: poly.to_vec(),
            frontage: 0,
            area: a,
        }];
    };
    let Some((angle, w, d, c)) = oriented_box(poly) else {
        return vec![Lot {
            polygon: poly.to_vec(),
            frontage: 0,
            area: a,
        }];
    };
    let long = if w >= d {
        Point {
            x: angle.cos(),
            z: angle.sin(),
        }
    } else {
        Point {
            x: -angle.sin(),
            z: angle.cos(),
        }
    };
    let t = (*r)() - 0.5;
    let at = Point {
        x: c.x + long.x * t * w.min(d),
        z: c.z + long.z * t * w.min(d),
    };
    let (a, b) = crate::geom::split_polygon(poly, at, long);
    if a.len() < 3 || b.len() < 3 {
        return vec![Lot {
            polygon: poly.to_vec(),
            frontage: 0,
            area: area(poly),
        }];
    };
    let mut out = Vec::new();
    out.extend(subdivide(&a, z, r));
    out.extend(subdivide(&b, z, r));
    out
}

//! Terrain fitting and street surface helpers.
use crate::{
    geom::{self, Point},
    types::{RoadEdge, RoadGeometry, RoadGraph},
};

#[derive(Clone, Debug)]
pub struct TerrainGrid {
    pub heights: Vec<f32>,
    pub side: usize,
    pub step: f64,
    pub half: f64,
}
pub fn edge_height_at(e: &RoadEdge, p: Point) -> f64 {
    let mut best = f64::INFINITY;
    let mut y = e.heights.first().copied().unwrap_or(0.);
    for (i, w) in e.points.windows(2).enumerate() {
        let (q, t) = geom::closest_on_segment(p, w[0], w[1]);
        let d = geom::dist(q, p);
        if d < best {
            best = d;
            y = e.heights.get(i).copied().unwrap_or(y)
                + (e.heights.get(i + 1).copied().unwrap_or(y)
                    - e.heights.get(i).copied().unwrap_or(y))
                    * t;
        }
    }
    y
}
pub fn sink_under_streets(
    grid: &mut TerrainGrid,
    layers: &[(Vec<Vec<f32>>, f64)],
    pads: &[(f64, f64, f64, f64, f64, f64)],
) {
    for (polys, top) in layers {
        for flat in polys {
            if flat.len() < 9 {
                continue;
            }
            let mut x0 = f64::INFINITY;
            let mut x1 = f64::NEG_INFINITY;
            let mut z0 = f64::INFINITY;
            let mut z1 = f64::NEG_INFINITY;
            for i in (0..flat.len()).step_by(3) {
                x0 = x0.min(flat[i] as f64);
                x1 = x1.max(flat[i] as f64);
                z0 = z0.min(flat[i + 2] as f64);
                z1 = z1.max(flat[i + 2] as f64);
            }
            let ix0 = (((x0 + grid.half) / grid.step).floor().max(0.) as usize).min(grid.side - 1);
            let ix1 = (((x1 + grid.half) / grid.step).ceil().max(0.) as usize).min(grid.side - 1);
            let iz0 = (((z0 + grid.half) / grid.step).floor().max(0.) as usize).min(grid.side - 1);
            let iz1 = (((z1 + grid.half) / grid.step).ceil().max(0.) as usize).min(grid.side - 1);
            for z in iz0..=iz1 {
                for x in ix0..=ix1 {
                    let i = z * grid.side + x;
                    grid.heights[i] = grid.heights[i].min(*top as f32);
                }
            }
        }
    }
    for &(x, z, w, d, y, angle) in pads {
        let reach = (w * w + d * d).sqrt() / 2. + 2.;
        for gz in 0..grid.side {
            for gx in 0..grid.side {
                let dx = gx as f64 * grid.step - grid.half - x;
                let dz = gz as f64 * grid.step - grid.half - z;
                let (c, s) = (angle.cos(), angle.sin());
                if (dx * c + dz * s).abs() <= w / 2. + 2. && (-dx * s + dz * c).abs() <= d / 2. + 2.
                {
                    let _ = reach;
                    let i = gz * grid.side + gx;
                    grid.heights[i] = grid.heights[i].min(y as f32);
                }
            }
        }
    }
}
pub fn street_polygons(
    graph: &RoadGraph,
    geometry: &RoadGeometry,
) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let mut asphalt = Vec::new();
    let mut sidewalks = Vec::new();
    let flat = |pts: &[Point], e: Option<&RoadEdge>, y: f64| {
        pts.iter()
            .flat_map(|p| {
                let yy = e.map(|q| edge_height_at(q, *p)).unwrap_or(y);
                [p.x, yy, p.z]
            })
            .collect::<Vec<_>>()
    };
    for b in &geometry.bands {
        let e = &graph.edges[b.edge];
        let n = b.polygon.len() / 2;
        if n < 2 {
            asphalt.push(flat(&b.polygon, Some(e), 0.));
            continue;
        }
        for i in 1..n {
            let q = [
                b.polygon[i - 1],
                b.polygon[i],
                b.polygon[2 * n - 1 - i],
                b.polygon[2 * n - i],
            ];
            asphalt.push(flat(&q, Some(e), 0.));
        }
    }
    for j in &geometry.junctions {
        asphalt.push(flat(&j.polygon, None, graph.nodes[j.node].y));
    }
    for s in &geometry.sidewalks {
        if let Some(id) = s.edge {
            sidewalks.push(flat(&s.polygon, Some(&graph.edges[id]), 0.));
        } else if let Some(id) = s.node {
            sidewalks.push(flat(&s.polygon, None, graph.nodes[id].y));
        }
    }
    (asphalt, sidewalks)
}
pub fn street_test(geometry: &RoadGeometry, margin: f64) -> impl Fn(Point) -> bool + '_ {
    move |p| {
        geometry
            .bands
            .iter()
            .map(|b| &b.polygon)
            .chain(geometry.junctions.iter().map(|j| &j.polygon))
            .any(|poly| {
                geom::point_in_polygon(p, poly)
                    || geom::point_in_polygon(
                        Point {
                            x: p.x + margin,
                            z: p.z,
                        },
                        poly,
                    )
                    || geom::point_in_polygon(
                        Point {
                            x: p.x - margin,
                            z: p.z,
                        },
                        poly,
                    )
                    || geom::point_in_polygon(
                        Point {
                            x: p.x,
                            z: p.z + margin,
                        },
                        poly,
                    )
                    || geom::point_in_polygon(
                        Point {
                            x: p.x,
                            z: p.z - margin,
                        },
                        poly,
                    )
            })
    }
}

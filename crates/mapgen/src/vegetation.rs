//! Parks, Poisson vegetation, street trees and lamps.
use crate::{
    field::{cell_slope, sample, to_world},
    geom::{
        SpatialHash, closest_on_segment, dist, lerp, norm, perp, point_in_polygon, rotated_rect,
        sub,
    },
    random::{Noise, derive},
    types::{
        Block, BuildingPlacement, HeightField, Hydrology, Lamp, Park, ParkKind, Point, RoadGraph,
        Tree, TreeKind, Zone,
    },
};
pub fn make_parks(blocks: &[Block], hydro: &Hydrology, f: &HeightField) -> Vec<Park> {
    let mut out = Vec::new();
    for b in blocks {
        if b.zone != Zone::Park {
            continue;
        }
        let near = b.interior.iter().any(|p| {
            let x = ((p.x + f.size / 2.) / f.cell).round() as isize;
            let z = ((p.z + f.size / 2.) / f.cell).round() as isize;
            x >= 0
                && z >= 0
                && x < f.w as isize
                && z < f.h as isize
                && hydro.water_distance[z as usize * f.w + x as usize] < 30.
        });
        let steep = b.interior.iter().any(|p| {
            let x = ((p.x + f.size / 2.) / f.cell).round() as isize;
            let z = ((p.z + f.size / 2.) / f.cell).round() as isize;
            x > 0
                && z > 0
                && x < f.w as isize - 1
                && z < f.h as isize - 1
                && cell_slope(f, x as usize, z as usize) > 0.2
        });
        out.push(Park {
            polygon: b.interior.clone(),
            kind: if near {
                ParkKind::Riverside
            } else if steep {
                ParkKind::Woodland
            } else {
                ParkKind::Garden
            },
        })
    }
    out
}
#[allow(clippy::too_many_arguments)]
pub fn place_vegetation(
    f: &HeightField,
    hydro: &Hydrology,
    graph: &RoadGraph,
    blocks: &[Block],
    buildings: &[BuildingPlacement],
    desirability: &[f32],
    seed: i32,
    on_street: impl Fn(Point) -> bool,
) -> (Vec<Tree>, Vec<Lamp>) {
    let mut rng = derive(seed, "trees");
    let noise = Noise::new(&mut derive(seed, "forest"));
    let mut trees = Vec::new();
    let mut lamps = Vec::new();
    let mut placed = SpatialHash::new(32.);
    let mut cells = Vec::new();
    for z in 1..f.h - 1 {
        for x in 1..f.w - 1 {
            cells.push(z * f.w + x)
        }
    }
    for i in (1..cells.len()).rev() {
        let j = (rng() * (i as f64 + 1.)).floor() as usize;
        cells.swap(i, j)
    }
    let zone_at = |p: Point| -> Option<Zone> {
        for b in blocks {
            if point_in_polygon(p, &b.interior) {
                return Some(b.zone);
            }
        }
        None
    };
    let road_dist = road_distance(f, graph);
    for i in cells {
        let x = i % f.w;
        let z = i / f.w;
        let h = f.data[i] as f64;
        if h <= 0.5 {
            continue;
        }
        let s = cell_slope(f, x, z);
        let st = if s < 0.05 {
            0.75
        } else if s < 0.45 {
            1.
        } else {
            (1. - (s - 0.45) / 0.3).max(0.)
        };
        let wd = hydro.water_distance[i] as f64;
        let moist = if wd < 8. {
            0.
        } else if wd < 120. {
            1.
        } else {
            (1. - (wd - 120.) / 900.).max(0.35)
        };
        let rt = if road_dist[i] < 9. {
            0.
        } else {
            ((road_dist[i] - 9.) / 10.).min(1.)
        };
        let suit =
            st * moist * rt * (0.6 + 0.4 * noise.fbm(x as f64 * 0.05, z as f64 * 0.05, 2, 2., 0.5));
        if suit < 0.08 {
            continue;
        }
        let p = Point {
            x: (x as f64 + rng() - 0.5) * f.cell - f.size / 2.,
            z: (z as f64 + rng() - 0.5) * f.cell - f.size / 2.,
        };
        if sample(f, p.x, p.z) <= 0.4 {
            continue;
        }
        let zone = zone_at(p);
        if matches!(zone, Some(Zone::Core | Zone::Commercial | Zone::Industrial)) {
            continue;
        }
        let density = match zone {
            Some(Zone::Residential) => 0.22,
            Some(Zone::Suburb) => 0.5,
            Some(Zone::Park) => 1.1,
            None => 0.55 + 0.45 * (1. - desirability[i] as f64),
            _ => 1.,
        };
        let radius = (4. + (1. - suit) * 22.) / density;
        if placed
            .near(p.x, p.z, radius)
            .iter()
            .any(|t: &Tree| dist(Point { x: t.x, z: t.z }, p) < radius)
        {
            continue;
        }
        if buildings.iter().any(|b| {
            point_in_polygon(
                p,
                &rotated_rect(Point { x: b.x, z: b.z }, b.w + 6., b.d + 6., b.angle),
            )
        }) {
            continue;
        }
        if on_street(p) {
            continue;
        }
        let kind = if h < 3. && hydro.coast_distance[i] < 90. {
            TreeKind::Palm
        } else if h > 70. || s > 0.3 {
            if rng() < 0.8 {
                TreeKind::Pine
            } else {
                TreeKind::Shrub
            }
        } else if wd < 60. || rng() < 0.7 {
            TreeKind::Oak
        } else {
            TreeKind::Shrub
        };
        let ht = match kind {
            TreeKind::Shrub => 2. + rng() * 1.5,
            TreeKind::Palm => 7. + rng() * 4.,
            _ => 6. + rng() * 6.,
        };
        let t = Tree {
            x: (p.x * 10.).round() / 10.,
            z: (p.z * 10.).round() / 10.,
            h: ht,
            kind,
        };
        placed.insert(Point { x: t.x, z: t.z }, t.clone());
        trees.push(t)
    }
    for e in &graph.edges {
        if e.bridge || e.kind == crate::types::RoadKind::Highway {
            continue;
        }
        let spacing = if e.kind == crate::types::RoadKind::Avenue {
            30.
        } else {
            40.
        };
        let offset = e.width / 2. + 0.5;
        let mut along = 0.;
        let mut next_lamp = 14.;
        let mut next_tree = 24.;
        let mut side = 1.;
        let total = e.points.windows(2).map(|p| dist(p[0], p[1])).sum::<f64>();
        for ab in e.points.windows(2) {
            let a = ab[0];
            let b = ab[1];
            let d = dist(a, b);
            let t = norm(sub(b, a));
            let n = perp(t);
            while next_lamp <= along + d && next_lamp < total - 12. {
                let p = lerp(a, b, (next_lamp - along) / d);
                let q = Point {
                    x: p.x + n.x * offset * side,
                    z: p.z + n.z * offset * side,
                };
                if !on_street(q) {
                    lamps.push(Lamp {
                        x: q.x,
                        z: q.z,
                        h: 6.,
                        angle: (n.z * side).atan2(-n.x * side),
                    })
                }
                side = -side;
                next_lamp += spacing
            }
            if e.kind != crate::types::RoadKind::Lane {
                while next_tree <= along + d && next_tree < total - 14. {
                    let p = lerp(a, b, (next_tree - along) / d);
                    for sd in [-1., 1.] {
                        let q = Point {
                            x: p.x + n.x * offset * sd,
                            z: p.z + n.z * offset * sd,
                        };
                        if zone_at(q) == Some(Zone::Industrial)
                            || sample(f, q.x, q.z) <= 0.4
                            || on_street(q)
                        {
                            continue;
                        }
                        let kind = if hydro.coast_distance[cell_of(f, q)] < 120. {
                            TreeKind::Palm
                        } else {
                            TreeKind::Oak
                        };
                        trees.push(Tree {
                            x: q.x,
                            z: q.z,
                            h: if kind == TreeKind::Palm { 8. } else { 7. },
                            kind,
                        })
                    }
                    next_tree += spacing * 1.2
                }
            }
            along += d
        }
    }
    (trees, lamps)
}
fn cell_of(f: &HeightField, p: Point) -> usize {
    let x = ((p.x + f.size / 2.) / f.cell)
        .round()
        .clamp(0., (f.w - 1) as f64) as usize;
    let z = ((p.z + f.size / 2.) / f.cell)
        .round()
        .clamp(0., (f.h - 1) as f64) as usize;
    z * f.w + x
}
fn road_distance(f: &HeightField, g: &RoadGraph) -> Vec<f64> {
    let mut out: Vec<f64> = vec![1e6; f.w * f.h];
    for e in &g.edges {
        for ab in e.points.windows(2) {
            let a = ab[0];
            let b = ab[1];
            let reach = e.width / 2. + 24.;
            let x0 = ((a.x.min(b.x) - reach + f.size / 2.) / f.cell)
                .floor()
                .max(0.) as usize;
            let x1 = ((a.x.max(b.x) + reach + f.size / 2.) / f.cell)
                .ceil()
                .min((f.w - 1) as f64) as usize;
            let z0 = ((a.z.min(b.z) - reach + f.size / 2.) / f.cell)
                .floor()
                .max(0.) as usize;
            let z1 = ((a.z.max(b.z) + reach + f.size / 2.) / f.cell)
                .ceil()
                .min((f.h - 1) as f64) as usize;
            for z in z0..=z1 {
                for x in x0..=x1 {
                    let p = to_world(f, x, z);
                    out[z * f.w + x] = out[z * f.w + x].min(dist(p, closest_on_segment(p, a, b).0))
                }
            }
        }
    }
    out
}

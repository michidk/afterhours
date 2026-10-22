//! Parks, Poisson vegetation, street trees and lamps.
use crate::{
    field::{cell_slope, sample, to_world},
    geom::{SpatialHash, dist, lerp, norm, perp, point_in_polygon, rotated_rect, sub},
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
            let x = ((p.x + f.size / 2.) / f.cell).js_round() as isize;
            let z = ((p.z + f.size / 2.) / f.cell).js_round() as isize;
            x >= 0
                && z >= 0
                && x < f.w as isize
                && z < f.h as isize
                && hydro.water_distance[z as usize * f.w + x as usize] < 30.
        });
        let steep = b.interior.iter().any(|p| {
            let x = ((p.x + f.size / 2.) / f.cell).js_round() as isize;
            let z = ((p.z + f.size / 2.) / f.cell).js_round() as isize;
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
    let mut footprints = SpatialHash::new(64.);
    for b in buildings {
        footprints.insert(Point { x: b.x, z: b.z }, b.clone());
    }
    let mut block_index = SpatialHash::new(128.);
    for b in blocks {
        let mut c = Point { x: 0., z: 0. };
        for p in &b.interior {
            c.x += p.x / b.interior.len() as f64;
            c.z += p.z / b.interior.len() as f64;
        }
        block_index.insert(c, b.clone());
    }
    let zone_at = |p: Point| -> Option<Zone> {
        for b in block_index.near(p.x, p.z, 450.) {
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
        let road = f64::from(road_dist[i]);
        let rt = if road < 9. {
            0.
        } else {
            ((road - 9.) / 10.).min(1.)
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
        if footprints.near(p.x, p.z, 60.).iter().any(|b| {
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
        let h = sample(f, p.x, p.z);
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
            x: (p.x * 10. + 0.5).floor() / 10.,
            z: (p.z * 10. + 0.5).floor() / 10.,
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
                        if zone_at(q) == Some(Zone::Industrial) || sample(f, q.x, q.z) <= 0.4 {
                            continue;
                        }
                        if footprints
                            .near(q.x, q.z, 60.)
                            .iter()
                            .any(|bb| inside_rect(q, bb, 1.5))
                        {
                            continue;
                        }
                        let kind = if hydro.coast_distance[cell_of(f, q)] < 120. {
                            TreeKind::Palm
                        } else {
                            TreeKind::Oak
                        };
                        if on_street(q) {
                            continue;
                        }
                        let tree = Tree {
                            x: q.x,
                            z: q.z,
                            h: if kind == TreeKind::Palm { 8. } else { 7. },
                            kind,
                        };
                        trees.push(tree.clone());
                        placed.insert(q, tree);
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
        .js_round()
        .clamp(0., (f.w - 1) as f64) as usize;
    let z = ((p.z + f.size / 2.) / f.cell)
        .js_round()
        .clamp(0., (f.h - 1) as f64) as usize;
    z * f.w + x
}
fn road_distance(f: &HeightField, g: &RoadGraph) -> Vec<f32> {
    let mut out: Vec<f32> = vec![1e6; f.w * f.h];
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
            let dx = b.x - a.x;
            let dz = b.z - a.z;
            let l2 = dx * dx + dz * dz;
            let l2 = if l2 == 0. { 1. } else { l2 };
            for z in z0..=z1 {
                for x in x0..=x1 {
                    let p = to_world(f, x, z);
                    let t = (((p.x - a.x) * dx + (p.z - a.z) * dz) / l2).clamp(0., 1.);
                    let d = (p.x - a.x - dx * t).hypot(p.z - a.z - dz * t) - e.width / 2.;
                    let i = z * f.w + x;
                    if d < f64::from(out[i]) {
                        out[i] = d as f32;
                    }
                }
            }
        }
    }
    out
}

trait JsRound {
    fn js_round(self) -> f64;
}
impl JsRound for f64 {
    fn js_round(self) -> f64 {
        (self + 0.5).floor()
    }
}
fn inside_rect(p: Point, b: &BuildingPlacement, pad: f64) -> bool {
    point_in_polygon(
        p,
        &rotated_rect(
            Point { x: b.x, z: b.z },
            b.w + pad * 2.,
            b.d + pad * 2.,
            b.angle,
        ),
    )
}

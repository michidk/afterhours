//! Stage 4: planar faces, block interiors, zoning, and street-frontage lots.
use crate::{
    field::{sample, slope},
    geom::{
        area, centroid, clean_ring, closest_on_segment, dist, inset_polygon, oriented_box,
        signed_area, split_polygon,
    },
    random::{Rng, derive},
    types::{Block, HeightField, Hydrology, Lot, Point, RoadGraph, RoadKind, Zone},
};
use std::collections::{HashMap, HashSet};
const SIDEWALK: f64 = 2.5;
fn lot_area(zone: Zone) -> (f64, f64) {
    match zone {
        Zone::Core => (320., 900.),
        Zone::Commercial => (380., 1000.),
        Zone::Residential => (320., 850.),
        Zone::Suburb => (450., 1000.),
        Zone::Industrial => (2000., 6000.),
        Zone::Park | Zone::Rural => (1e9, 1e9),
    }
}
pub fn generate_blocks(
    graph: &RoadGraph,
    field: &HeightField,
    hydro: &Hydrology,
    centre: Point,
    seed: i32,
) -> Vec<Block> {
    let mut rng = derive(seed, "blocks");
    let faces = planar_faces(graph);
    let mut blocks = Vec::new();
    let water_distance = |p: Point| {
        let x = ((p.x + field.size / 2.) / field.cell + 0.5).floor() as isize;
        let z = ((p.z + field.size / 2.) / field.cell + 0.5).floor() as isize;
        if x < 0 || z < 0 || x >= field.w as isize || z >= field.h as isize {
            return 0.;
        }
        f64::from(hydro.water_distance[z as usize * field.w + x as usize])
    };
    for face in faces {
        let ring = clean_ring(&simplify_polyline(&face.ring, 0.35), 0.2);
        if ring.len() < 3 {
            continue;
        }
        let face_area = area(&ring);
        if !(400. ..=350_000.).contains(&face_area) {
            continue;
        }
        let (_, w, d, _) = oriented_box(&ring).expect("nonempty ring");
        if w.max(d) > 900. {
            continue;
        }
        let mut widest: f64 = 0.;
        for &id in &face.edges {
            widest = widest.max(graph.edges[id].width);
        }
        let Some(interior) = inset_polygon(&ring, widest / 2. + SIDEWALK) else {
            continue;
        };
        if area(&interior) < 150. {
            continue;
        }
        let c = centroid(&interior);
        let zone = zone_for(
            c,
            &interior,
            graph,
            &face.edges,
            centre,
            field,
            &water_distance,
        );
        let mut block = Block {
            id: blocks.len(),
            polygon: ring,
            interior,
            zone,
            lots: Vec::new(),
        };
        if zone != Zone::Park && zone != Zone::Rural {
            block.lots = subdivide(&block.interior, zone, &mut rng);
        }
        blocks.push(block);
    }
    blocks
}
#[allow(clippy::too_many_arguments)]
fn zone_for(
    c: Point,
    interior: &[Point],
    graph: &RoadGraph,
    edges: &[usize],
    centre: Point,
    f: &HeightField,
    water_distance: &impl Fn(Point) -> f64,
) -> Zone {
    let d = dist(c, centre);
    let a = area(interior);
    let mut max_slope: f64 = 0.;
    let mut min_water = f64::INFINITY;
    let mut lowest = f64::INFINITY;
    for p in std::iter::once(c).chain(interior.iter().copied()) {
        max_slope = max_slope.max(slope(f, p.x, p.z));
        min_water = min_water.min(water_distance(p));
        lowest = lowest.min(sample(f, p.x, p.z));
    }
    if max_slope > 0.42 || lowest < 1.2 || min_water < 6. {
        return Zone::Park;
    }
    if a < 500. {
        return Zone::Park;
    }
    let rank = edges
        .iter()
        .map(|&id| match graph.edges[id].kind {
            RoadKind::Highway => 3,
            RoadKind::Avenue => 2,
            _ => 1,
        })
        .max()
        .unwrap_or(0);
    if d < 260. {
        return Zone::Core;
    }
    if d < 520. {
        return if rank >= 2 {
            Zone::Commercial
        } else {
            Zone::Residential
        };
    }
    if a > 14_000. && rank >= 2 && max_slope < 0.1 && d > 700. {
        return Zone::Industrial;
    }
    if d < 900. {
        return Zone::Residential;
    }
    Zone::Suburb
}
fn subdivide(interior: &[Point], zone: Zone, rng: &mut Rng) -> Vec<Lot> {
    let (min_area, max_area) = lot_area(zone);
    let street_edges: Vec<_> = interior
        .iter()
        .enumerate()
        .map(|(i, &p)| (p, interior[(i + 1) % interior.len()]))
        .collect();
    let mut lots = Vec::new();
    fn recurse(
        poly: Vec<Point>,
        depth: usize,
        min_area: f64,
        max_area: f64,
        street_edges: &[(Point, Point)],
        rng: &mut Rng,
        lots: &mut Vec<Lot>,
    ) {
        let a = area(&poly);
        if a < min_area * 0.35 {
            return;
        }
        if a <= max_area || depth > 10 {
            if a >= min_area * 0.6 && !sliver(&poly) {
                lots.push(make_lot(poly, street_edges));
            }
            return;
        }
        let (angle, w, d, centre) = oriented_box(&poly).expect("nonempty polygon");
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
        let length = w.max(d);
        let t = (rng() - 0.5) * 0.2;
        let at = Point {
            x: centre.x + long.x * t * length,
            z: centre.z + long.z * t * length,
        };
        let perp = Point {
            x: -long.z,
            z: long.x,
        };
        let (mut p, mut q) = split_polygon(&poly, at, perp);
        if p.len() < 3
            || q.len() < 3
            || frontage_index(&p, street_edges) < 0
            || frontage_index(&q, street_edges) < 0
        {
            (p, q) = split_polygon(&poly, centre, long);
            if p.len() < 3
                || q.len() < 3
                || frontage_index(&p, street_edges) < 0
                || frontage_index(&q, street_edges) < 0
            {
                if a >= min_area * 0.6 && !sliver(&poly) {
                    lots.push(make_lot(poly, street_edges));
                }
                return;
            }
        }
        recurse(p, depth + 1, min_area, max_area, street_edges, rng, lots);
        recurse(q, depth + 1, min_area, max_area, street_edges, rng, lots);
    }
    let mut poly = interior.to_vec();
    if signed_area(interior) <= 0. {
        poly.reverse();
    }
    recurse(poly, 0, min_area, max_area, &street_edges, rng, &mut lots);
    lots
}
fn sliver(poly: &[Point]) -> bool {
    let mut perimeter = 0.;
    for i in 0..poly.len() {
        perimeter += dist(poly[i], poly[(i + 1) % poly.len()]);
    }
    area(poly) / (perimeter * perimeter) < 0.035
}
fn frontage_index(poly: &[Point], street_edges: &[(Point, Point)]) -> isize {
    let mut best = -1;
    let mut best_length = 5.;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        for &(sa, sb) in street_edges {
            let da = dist(closest_on_segment(a, sa, sb).0, a);
            let db = dist(closest_on_segment(b, sa, sb).0, b);
            if da < 0.3 && db < 0.3 {
                let l = dist(a, b);
                if l > best_length {
                    best_length = l;
                    best = i as isize;
                }
            }
        }
    }
    best
}
fn make_lot(poly: Vec<Point>, street_edges: &[(Point, Point)]) -> Lot {
    Lot {
        frontage: frontage_index(&poly, street_edges),
        area: area(&poly),
        polygon: poly,
    }
}

// These two helpers mirror the roads stage exports so this branch remains testable
// until the graph and roadgeometry ports merge.
struct Face {
    ring: Vec<Point>,
    edges: Vec<usize>,
}
#[derive(Clone)]
struct Half {
    edge: usize,
    from: usize,
    to: usize,
    points: Vec<Point>,
}
fn planar_faces(graph: &RoadGraph) -> Vec<Face> {
    let mut outgoing: Vec<(usize, Vec<Half>)> = Vec::new();
    let mut indices = HashMap::new();
    for e in &graph.edges {
        let forward = Half {
            edge: e.id,
            from: e.a,
            to: e.b,
            points: e.points.clone(),
        };
        let backward = Half {
            edge: e.id,
            from: e.b,
            to: e.a,
            points: e.points.iter().rev().copied().collect(),
        };
        for h in [forward, backward] {
            let index = *indices.entry(h.from).or_insert_with(|| {
                outgoing.push((h.from, Vec::new()));
                outgoing.len() - 1
            });
            outgoing[index].1.push(h);
        }
    }
    let angle_of = |h: &Half| (h.points[1].z - h.points[0].z).atan2(h.points[1].x - h.points[0].x);
    for (_, list) in &mut outgoing {
        list.sort_by(|a, b| (angle_of(a) - angle_of(b)).partial_cmp(&0.).unwrap());
    }
    let mut used = HashSet::new();
    let mut faces = Vec::new();
    for (_, list) in &outgoing {
        for start in list {
            if used.contains(&(start.edge, start.from)) {
                continue;
            }
            let mut ring = Vec::new();
            let mut edges = Vec::new();
            let mut h = start;
            let mut guard = 0;
            while !used.contains(&(h.edge, h.from)) && guard < 10000 {
                guard += 1;
                used.insert((h.edge, h.from));
                edges.push(h.edge);
                for i in 0..h.points.len() - 1 {
                    ring.push(h.points[i]);
                }
                let arrivals = &outgoing[indices[&h.to]].1;
                let back = h.points[h.points.len() - 2];
                let tip = h.points[h.points.len() - 1];
                let incoming = (back.z - tip.z).atan2(back.x - tip.x);
                let mut next = &arrivals[0];
                let mut best_delta = f64::INFINITY;
                for cand in arrivals {
                    let mut delta = incoming - angle_of(cand);
                    while delta <= 1e-9 {
                        delta += std::f64::consts::PI * 2.;
                    }
                    while delta > std::f64::consts::PI * 2. + 1e-9 {
                        delta -= std::f64::consts::PI * 2.;
                    }
                    if cand.edge == h.edge && arrivals.len() > 1 {
                        delta += std::f64::consts::PI * 2.;
                    }
                    if delta < best_delta {
                        best_delta = delta;
                        next = cand;
                    }
                }
                h = next;
            }
            if ring.len() >= 3 && signed_area(&ring) > 0. {
                faces.push(Face { ring, edges });
            }
        }
    }
    faces
}
fn simplify_polyline(points: &[Point], tolerance: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut worst = 0.;
        let mut index = None;
        for i in a + 1..b {
            let p = points[i];
            let pa = points[a];
            let pb = points[b];
            let ab = Point {
                x: pb.x - pa.x,
                z: pb.z - pa.z,
            };
            let l = ab.x.hypot(ab.z);
            let d = if l < 1e-6 {
                dist(p, pa)
            } else {
                (ab.x * (p.z - pa.z) - ab.z * (p.x - pa.x)).abs() / l
            };
            if d > worst {
                worst = d;
                index = Some(i);
            }
        }
        if let Some(index) = index.filter(|_| worst > tolerance) {
            keep[index] = true;
            stack.push((a, index));
            stack.push((index, b));
        }
    }
    points
        .iter()
        .enumerate()
        .filter_map(|(i, &p)| keep[i].then_some(p))
        .collect()
}

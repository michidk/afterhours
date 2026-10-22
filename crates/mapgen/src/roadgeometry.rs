//! Line-for-line port of `mapgen/roadgeometry.ts`; arithmetic stays in f64.
use crate::{
    field::sample,
    geom::{add, dist, dot, lerp as lerp_point, mul, norm, perp, polyline_length, sub},
    types::*,
};
use std::collections::HashSet;
use std::f64::consts::PI;

pub const SIDEWALK: f64 = 2.5;
fn curb_radius(kind: RoadKind) -> f64 {
    match kind {
        RoadKind::Highway => 14.,
        RoadKind::Avenue => 11.,
        RoadKind::Street => 7.,
        RoadKind::Lane => 4.,
    }
}
fn lanes(kind: RoadKind) -> usize {
    match kind {
        RoadKind::Highway | RoadKind::Avenue => 4,
        RoadKind::Street | RoadKind::Lane => 2,
    }
}
pub fn road_rank_by_kind(kind: RoadKind) -> usize {
    match kind {
        RoadKind::Highway => 3,
        RoadKind::Avenue => 2,
        RoadKind::Street => 1,
        RoadKind::Lane => 0,
    }
}

pub fn simplify_polyline(points: &[Point], tolerance: f64) -> Vec<Point> {
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
            let d = distance_to_line(points[i], points[a], points[b]);
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
        .filter_map(|(i, p)| keep[i].then_some(*p))
        .collect()
}
fn distance_to_line(p: Point, a: Point, b: Point) -> f64 {
    let ab = sub(b, a);
    let l = ab.x.hypot(ab.z);
    if l < 1e-6 {
        return dist(p, a);
    }
    (ab.x * (p.z - a.z) - ab.z * (p.x - a.x)).abs() / l
}
pub fn catmull_rom(points: &[Point], step: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut p = vec![sub(mul(points[0], 2.), points[1])];
    p.extend_from_slice(points);
    p.push(sub(
        mul(points[points.len() - 1], 2.),
        points[points.len() - 2],
    ));
    let mut out = vec![points[0]];
    let knot = |a, b| dist(a, b).max(1e-4).powf(0.5);
    for i in 1..p.len() - 2 {
        let (p0, p1, p2, p3) = (p[i - 1], p[i], p[i + 1], p[i + 2]);
        let t0 = 0.;
        let t1 = t0 + knot(p0, p1);
        let t2 = t1 + knot(p1, p2);
        let t3 = t2 + knot(p2, p3);
        let samples = (dist(p1, p2) / step).ceil().max(1.) as usize;
        for s in 1..=samples {
            let t = t1 + ((t2 - t1) * s as f64) / samples as f64;
            let a1 = lerp_point(p0, p1, (t - t0) / (t1 - t0));
            let a2 = lerp_point(p1, p2, (t - t1) / (t2 - t1));
            let a3 = lerp_point(p2, p3, (t - t2) / (t3 - t2));
            let b1 = lerp_point(a1, a2, (t - t0) / (t2 - t0));
            let b2 = lerp_point(a2, a3, (t - t1) / (t3 - t1));
            out.push(lerp_point(b1, b2, (t - t1) / (t2 - t1)));
        }
    }
    *out.last_mut().unwrap() = *points.last().unwrap();
    out
}
pub fn round_corners(points: &[Point], radius: f64, min_turn: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut out = vec![points[0]];
    for i in 1..points.len() - 1 {
        let p = points[i];
        let before = sub(points[i - 1], p);
        let after = sub(points[i + 1], p);
        let turn = PI - dot(norm(before), norm(after)).clamp(-1., 1.).acos();
        if turn < min_turn {
            out.push(p);
            continue;
        }
        let half = turn / 2.;
        let tangent = (radius * half.tan())
            .min(0.45 * before.x.hypot(before.z))
            .min(0.45 * after.x.hypot(after.z));
        let r = tangent / half.tan();
        let a = add(p, mul(norm(before), tangent));
        let b = add(p, mul(norm(after), tangent));
        let centre = add(p, mul(norm(add(norm(before), norm(after))), r / half.cos()));
        let from = (a.z - centre.z).atan2(a.x - centre.x);
        let mut to = (b.z - centre.z).atan2(b.x - centre.x);
        while to - from > PI {
            to -= PI * 2.;
        }
        while to - from < -PI {
            to += PI * 2.;
        }
        let steps = (((to - from).abs() * r) / 3.).ceil().max(2.) as usize;
        for s in 0..=steps {
            let angle = from + ((to - from) * s as f64) / steps as f64;
            out.push(Point {
                x: centre.x + angle.cos() * r,
                z: centre.z + angle.sin() * r,
            });
        }
    }
    out.push(*points.last().unwrap());
    out
}
pub fn smooth_centrelines(graph: &mut RoadGraph) {
    for e in &mut graph.edges {
        let simplified = round_corners(&simplify_polyline(&e.points, 0.9), e.width * 2., 0.4);
        e.points = if e.bridge {
            simplified
        } else {
            widen_bends(&catmull_rom(&simplified, 4.), e.width / 2. + SIDEWALK + 1.)
        };
    }
}

pub fn offset_polyline(points: &[Point], half_width: f64) -> (Vec<Point>, Vec<Point>) {
    if points.len() == 1 {
        return (vec![points[0]], vec![points[0]]);
    }
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (i, &p) in points.iter().enumerate() {
        let d_in = if i > 0 {
            norm(sub(p, points[i - 1]))
        } else {
            norm(sub(points[1], p))
        };
        let d_out = if i < points.len() - 1 {
            norm(sub(points[i + 1], p))
        } else {
            d_in
        };
        let mut n = norm(add(perp(d_in), perp(d_out)));
        let cos = n.x * perp(d_in).x + n.z * perp(d_in).z;
        let scale = (1. / cos.max(0.35)).min(2.5);
        n = mul(n, scale);
        left.push(add(p, mul(n, half_width)));
        right.push(add(p, mul(n, -half_width)));
    }
    for side in [&mut left, &mut right] {
        for i in 1..side.len() {
            if dot(sub(side[i], side[i - 1]), sub(points[i], points[i - 1])) <= 0. {
                side[i] = side[i - 1];
            }
        }
    }
    (left, right)
}
pub fn trim_polyline(points: &[Point], start_cut: f64, end_cut: f64) -> Vec<Point> {
    let total = polyline_length(points);
    if start_cut + end_cut >= total - 0.1 {
        let from = (total - end_cut).max(0.);
        let to = start_cut.min(total);
        if to - from >= 0.05 {
            let mut overlap = vec![point_at(points, from)];
            let mut along = 0.;
            for i in 1..points.len() - 1 {
                along += dist(points[i - 1], points[i]);
                if along > from + 0.5 && along < to - 0.5 {
                    overlap.push(points[i]);
                }
            }
            overlap.push(point_at(points, to));
            return overlap;
        }
        return vec![
            point_at(points, start_cut.min(total / 2. - 0.5)),
            point_at(points, (total - end_cut).max(total / 2. + 0.5)),
        ];
    }
    let mut out = vec![point_at(points, start_cut)];
    let mut s = 0.;
    for i in 1..points.len() - 1 {
        s += dist(points[i - 1], points[i]);
        if s > start_cut + 0.5 && s < total - end_cut - 0.5 {
            out.push(points[i]);
        }
    }
    out.push(point_at(points, total - end_cut));
    out
}
pub fn point_at(points: &[Point], distance: f64) -> Point {
    let mut s = 0.;
    for i in 1..points.len() {
        let d = dist(points[i - 1], points[i]);
        if s + d >= distance {
            return lerp_point(
                points[i - 1],
                points[i],
                if d != 0. { (distance - s) / d } else { 0. },
            );
        }
        s += d;
    }
    *points.last().unwrap()
}
pub fn densify_centrelines(graph: &mut RoadGraph) {
    for e in &mut graph.edges {
        let mut dense = Vec::new();
        for i in 1..e.points.len() {
            let a = e.points[i - 1];
            let b = e.points[i];
            let steps = (dist(a, b) / 8.).ceil().max(1.) as usize;
            for s in 0..steps {
                dense.push(lerp_point(a, b, s as f64 / steps as f64));
            }
        }
        dense.push(*e.points.last().unwrap());
        e.points = dense;
    }
}
pub fn bend_grades(points: &[Point], base: f64) -> Vec<f64> {
    let radius = bend_radii(points);
    (0..points.len() - 1)
        .map(|i| {
            let r = radius[i].min(radius[i + 1]);
            base * (0.4 + (0.6 * (r - 8.)) / 32.).clamp(0.4, 1.)
        })
        .collect()
}
pub fn bend_radii(points: &[Point]) -> Vec<f64> {
    let mut along = vec![0.];
    for i in 1..points.len() {
        along.push(along[i - 1] + dist(points[i - 1], points[i]));
    }
    points
        .iter()
        .enumerate()
        .map(|(i, &p)| {
            let a = point_at(points, (along[i] - 8.).max(0.));
            let c = point_at(points, (along[points.len() - 1]).min(along[i] + 8.));
            if dist(a, p) < 1e-6 || dist(p, c) < 1e-6 {
                return f64::INFINITY;
            }
            let turn = ((c.z - p.z).atan2(c.x - p.x) - (p.z - a.z).atan2(p.x - a.x)).abs();
            let angle = turn.min(PI * 2. - turn);
            if angle > 1e-3 {
                8. / angle
            } else {
                f64::INFINITY
            }
        })
        .collect()
}
pub fn widen_bends(points: &[Point], min_radius: f64) -> Vec<Point> {
    let mut out = points.to_vec();
    for _ in 0..80 {
        let radius = bend_radii(&out);
        let mut tight = Vec::new();
        let mut seen = HashSet::new();
        for (i, &r) in radius.iter().enumerate() {
            if r < min_radius && i > 0 && i < out.len() - 1 {
                for k in 1.max(i.saturating_sub(2))..=(out.len() - 2).min(i + 2) {
                    if seen.insert(k) {
                        tight.push(k);
                    }
                }
            }
        }
        if tight.is_empty() {
            break;
        }
        let mut next = out.clone();
        for i in tight {
            next[i].x = (out[i - 1].x + 2. * out[i].x + out[i + 1].x) / 4.;
            next[i].z = (out[i - 1].z + 2. * out[i].z + out[i + 1].z) / 4.;
        }
        out = next;
    }
    out
}

use crate::{field::to_world, geom};
fn kind_grade(k: RoadKind) -> f64 {
    if k == RoadKind::Highway { 0.07 } else { 0.1 }
}
pub fn build_road_geometry(graph: &RoadGraph) -> RoadGeometry {
    let mut g = RoadGeometry {
        walkways: Walkways::default(),
        ..Default::default()
    };
    for e in &graph.edges {
        let (l, r) = offset_polyline(&e.points, e.width / 2.);
        let poly = l.iter().copied().chain(r.iter().rev().copied()).collect();
        g.bands.push(Band {
            edge: e.id,
            polygon: poly,
            left: l.clone(),
            right: r.clone(),
            centre: e.points.clone(),
        });
        g.sidewalks.push(Sidewalk {
            polygon: {
                let (ol, or) = offset_polyline(&e.points, e.width / 2. + SIDEWALK);
                ol.into_iter().chain(or.into_iter().rev()).collect()
            },
            edge: Some(e.id),
            node: None,
        });
        g.trims.push((0., 0.));
        g.phases.push((None, None));
    }
    for n in &graph.nodes {
        if n.edges.len() > 2 {
            let mut poly = Vec::new();
            for &id in &n.edges {
                let e = &graph.edges[id];
                let q = if e.a == n.id {
                    e.points.get(1).copied().unwrap_or(Point {
                        x: n.x + 1.,
                        z: n.z,
                    })
                } else {
                    e.points
                        .get(e.points.len().saturating_sub(2))
                        .copied()
                        .unwrap_or(Point {
                            x: n.x - 1.,
                            z: n.z,
                        })
                };
                let d = geom::norm(geom::sub(q, Point { x: n.x, z: n.z }));
                poly.push(Point {
                    x: n.x + d.x * e.width / 2.,
                    z: n.z + d.z * e.width / 2.,
                });
            }
            g.junctions.push(Junction {
                node: n.id,
                polygon: poly,
            });
        }
    }
    g
}
pub fn solve_profiles(graph: &mut RoadGraph, f: &HeightField, trims: &[(f64, f64)]) {
    for n in &mut graph.nodes {
        let mut s = 0.;
        for dx in [-6., 0., 6.] {
            for dz in [-6., 0., 6.] {
                s += sample(f, n.x + dx, n.z + dz).max(0.6);
            }
        }
        n.y = s / 9.;
    }
    for e in &mut graph.edges {
        let len = geom::polyline_length(&e.points);
        let (t0, t1) = trims.get(e.id).copied().unwrap_or((0., 0.));
        let mut along = vec![0.];
        for w in e.points.windows(2) {
            along.push(along.last().unwrap() + geom::dist(w[0], w[1]));
        }
        let ya = graph.nodes[e.a].y;
        let yb = graph.nodes[e.b].y;
        if e.bridge {
            let span = (len - t0 - t1).max(1e-6);
            e.heights = along
                .iter()
                .map(|s| ya + (yb - ya) * ((s - t0) / span).clamp(0., 1.))
                .collect();
        } else {
            let mut h = along.iter().map(|_| 0.).collect::<Vec<_>>();
            for (i, p) in e.points.iter().enumerate() {
                h[i] = sample(f, p.x, p.z).max(0.6);
            }
            for _ in 0..2 {
                let old = h.clone();
                for i in 1..h.len() - 1 {
                    h[i] = (old[i - 2.max(i.saturating_sub(2))]
                        + old[i - 1]
                        + old[i]
                        + old[i + 1]
                        + old[(i + 2).min(h.len() - 1)])
                        / 5.;
                }
            }
            for i in 0..h.len() {
                if along[i] <= t0 + 0.05 {
                    h[i] = ya;
                } else if along[i] >= len - t1 - 0.05 {
                    h[i] = yb;
                }
            }
            let grade = kind_grade(e.kind);
            for _ in 0..60 {
                let mut changed = false;
                for i in 1..h.len() {
                    let d = (along[i] - along[i - 1]).max(1.);
                    if (h[i] - h[i - 1]).abs() > grade * d {
                        h[i] = h[i - 1] + (h[i] - h[i - 1]).signum() * grade * d;
                        changed = true;
                    }
                }
                for i in (0..h.len().saturating_sub(1)).rev() {
                    let d = (along[i + 1] - along[i]).max(1.);
                    if (h[i + 1] - h[i]).abs() > grade * d {
                        h[i] = h[i + 1] - (h[i + 1] - h[i]).signum() * grade * d;
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
            e.heights = h;
        }
    }
}
pub fn stamp_roads(f: &mut HeightField, graph: &RoadGraph, geometry: &RoadGeometry) -> Vec<f32> {
    let original = f.data.clone();
    let mut best = vec![0f32; f.data.len()];
    for e in &graph.edges {
        if e.bridge {
            continue;
        }
        for (segment, w) in e.points.windows(2).enumerate() {
            let ab = geom::sub(w[1], w[0]);
            let l2 = geom::dot(ab, ab).max(1.);
            let reach = e.width / 2. + SIDEWALK + 4.;
            for z in 0..f.h {
                for x in 0..f.w {
                    let p = to_world(f, x, z);
                    let t = (geom::dot(geom::sub(p, w[0]), ab) / l2).clamp(0., 1.);
                    let q = geom::lerp(w[0], w[1], t);
                    let d = geom::dist(p, q);
                    if d > reach {
                        continue;
                    }
                    let ya = e.heights.get(segment).copied().unwrap_or(0.);
                    let yb = e.heights.get(segment + 1).copied().unwrap_or(ya);
                    let yi = ya + (yb - ya) * t;
                    let wt = if d <= e.width / 2. + SIDEWALK + 4. {
                        1.
                    } else {
                        (1. - (d - reach) / reach).max(0.) as f32
                    };
                    let i = z * f.w + x;
                    if wt > best[i] {
                        best[i] = wt;
                        f.data[i] = original[i] + (yi as f32 - original[i]) * wt;
                    }
                }
            }
        }
    }
    let _ = geometry;
    best
}
pub fn bridge_decks(graph: &RoadGraph) -> Vec<Bridge> {
    graph
        .edges
        .iter()
        .filter(|e| e.bridge)
        .map(|e| {
            let (l, r) = offset_polyline(&e.points, e.width / 2. + 1.2);
            Bridge {
                edge: e.id,
                polygon: l.into_iter().chain(r.into_iter().rev()).collect(),
            }
        })
        .collect()
}

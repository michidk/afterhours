//! Road centreline, profile and surface geometry.
use crate::{
    field::{sample, to_world},
    geom::{self, Point},
    types::{Band, Bridge, HeightField, Junction, RoadGeometry, RoadGraph, Sidewalk, Walkways},
};
pub const SIDEWALK: f64 = 2.5;
fn kind_grade(k: crate::types::RoadKind) -> f64 {
    if k == crate::types::RoadKind::Highway {
        0.07
    } else {
        0.1
    }
}
pub fn simplify_polyline(points: &[Point], tol: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut worst = 0.;
        let mut idx = None;
        for i in a + 1..b {
            let ab = geom::sub(points[b], points[a]);
            let l = geom::len(ab);
            let d = if l < 1e-6 {
                geom::dist(points[i], points[a])
            } else {
                ((ab.x * (points[i].z - points[a].z) - ab.z * (points[i].x - points[a].x)) / l)
                    .abs()
            };
            if d > worst {
                worst = d;
                idx = Some(i);
            }
        }
        if worst > tol {
            let i = idx.unwrap();
            keep[i] = true;
            stack.push((a, i));
            stack.push((i, b));
        }
    }
    points
        .iter()
        .enumerate()
        .filter_map(|(i, p)| keep[i].then_some(*p))
        .collect()
}
pub fn catmull_rom(points: &[Point], step: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut p = Vec::with_capacity(points.len() + 2);
    p.push(geom::sub(geom::mul(points[0], 2.), points[1]));
    p.extend_from_slice(points);
    p.push(geom::sub(
        geom::mul(*points.last().unwrap(), 2.),
        points[points.len() - 2],
    ));
    let knot = |a: Point, b: Point| geom::dist(a, b).max(1e-4).powf(0.5);
    let mut out = vec![points[0]];
    for i in 1..p.len() - 2 {
        let (p0, p1, p2, p3) = (p[i - 1], p[i], p[i + 1], p[i + 2]);
        let (t0, t1, t2, t3) = (
            0.,
            knot(p0, p1),
            knot(p0, p1) + knot(p1, p2),
            knot(p0, p1) + knot(p1, p2) + knot(p2, p3),
        );
        let n = (geom::dist(p1, p2) / step).ceil().max(1.) as usize;
        for s in 1..=n {
            let t = t1 + (t2 - t1) * s as f64 / n as f64;
            let l = |a: Point, b: Point, u: f64| geom::lerp(a, b, u);
            let a1 = l(p0, p1, (t - t0) / (t1 - t0));
            let a2 = l(p1, p2, (t - t1) / (t2 - t1));
            let a3 = l(p2, p3, (t - t2) / (t3 - t2));
            let b1 = l(a1, a2, (t - t0) / (t2 - t0));
            let b2 = l(a2, a3, (t - t1) / (t3 - t1));
            out.push(l(b1, b2, (t - t1) / (t2 - t1)));
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
        let before = geom::sub(points[i - 1], p);
        let after = geom::sub(points[i + 1], p);
        let turn = std::f64::consts::PI
            - geom::dot(geom::norm(before), geom::norm(after))
                .clamp(-1., 1.)
                .acos();
        if turn < min_turn {
            out.push(p);
            continue;
        }
        let half = turn / 2.;
        let tangent = (radius * half.tan())
            .min(0.45 * geom::len(before))
            .min(0.45 * geom::len(after));
        let r = tangent / half.tan();
        let a = geom::add(p, geom::mul(geom::norm(before), tangent));
        let b = geom::add(p, geom::mul(geom::norm(after), tangent));
        let centre = geom::add(
            p,
            geom::mul(
                geom::norm(geom::add(geom::norm(before), geom::norm(after))),
                r / half.cos(),
            ),
        );
        let from = (a.z - centre.z).atan2(a.x - centre.x);
        let mut to = (b.z - centre.z).atan2(b.x - centre.x);
        while to - from > std::f64::consts::PI {
            to -= 2. * std::f64::consts::PI;
        }
        while to - from < -std::f64::consts::PI {
            to += 2. * std::f64::consts::PI;
        }
        let n = ((to - from).abs() * r / 3.).ceil().max(2.) as usize;
        for s in 0..=n {
            let q = from + (to - from) * s as f64 / n as f64;
            out.push(Point {
                x: centre.x + q.cos() * r,
                z: centre.z + q.sin() * r,
            });
        }
        let _ = b;
    }
    out.push(*points.last().unwrap());
    out
}
pub fn widen_bends(points: &[Point], min_radius: f64) -> Vec<Point> {
    let mut out = points.to_vec();
    for _ in 0..80 {
        let mut tight = Vec::new();
        for i in 1..out.len().saturating_sub(1) {
            let a = geom::norm(geom::sub(out[i - 1], out[i]));
            let b = geom::norm(geom::sub(out[i + 1], out[i]));
            let r = geom::len(geom::sub(out[i], geom::lerp(out[i - 1], out[i + 1], 0.5))) * 2.;
            if r < min_radius {
                tight.push(i);
                let _ = (a, b);
            }
        }
        if tight.is_empty() {
            break;
        }
        let old = out.clone();
        for i in tight {
            out[i] = Point {
                x: (old[i - 1].x + 2. * old[i].x + old[i + 1].x) / 4.,
                z: (old[i - 1].z + 2. * old[i].z + old[i + 1].z) / 4.,
            };
        }
    }
    out
}
pub fn smooth_centrelines(graph: &mut RoadGraph) {
    for e in &mut graph.edges {
        let p = round_corners(&simplify_polyline(&e.points, 0.9), e.width * 2., 0.4);
        e.points = if e.bridge {
            p
        } else {
            widen_bends(&catmull_rom(&p, 4.), e.width / 2. + SIDEWALK + 1.)
        };
    }
}
pub fn point_at(points: &[Point], distance: f64) -> Point {
    if points.is_empty() {
        return Point::default();
    }
    let mut d = distance.max(0.);
    for w in points.windows(2) {
        let l = geom::dist(w[0], w[1]);
        if d <= l {
            return geom::lerp(w[0], w[1], if l == 0. { 0. } else { d / l });
        }
        d -= l;
    }
    *points.last().unwrap()
}
pub fn trim_polyline(points: &[Point], start: f64, end: f64) -> Vec<Point> {
    let total = geom::polyline_length(points);
    let a = start.clamp(0., total);
    let b = (total - end).clamp(a, total);
    let mut out = vec![point_at(points, a)];
    let mut run = 0.;
    for w in points.windows(2) {
        let l = geom::dist(w[0], w[1]);
        if run + l > a && run + l < b {
            out.push(w[1]);
        }
        run += l;
    }
    if b > a {
        out.push(point_at(points, b));
    }
    out
}
pub fn offset_polyline(points: &[Point], half: f64) -> (Vec<Point>, Vec<Point>) {
    let mut l = Vec::with_capacity(points.len());
    let mut r = Vec::with_capacity(points.len());
    for i in 0..points.len() {
        let t = if i == 0 {
            geom::norm(geom::sub(points[1], points[0]))
        } else if i + 1 == points.len() {
            geom::norm(geom::sub(points[i], points[i - 1]))
        } else {
            geom::norm(geom::add(
                geom::norm(geom::sub(points[i], points[i - 1])),
                geom::norm(geom::sub(points[i + 1], points[i])),
            ))
        };
        let n = geom::perp(t);
        l.push(geom::add(points[i], geom::mul(n, half)));
        r.push(geom::add(points[i], geom::mul(n, -half)));
    }
    (l, r)
}
pub fn densify_centrelines(graph: &mut RoadGraph) {
    for e in &mut graph.edges {
        let mut out = vec![e.points[0]];
        for w in e.points.windows(2) {
            let n = (geom::dist(w[0], w[1]) / 8.).ceil() as usize;
            for i in 1..=n {
                out.push(geom::lerp(w[0], w[1], i as f64 / n as f64));
            }
        }
        e.points = out;
    }
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
pub fn bend_grades(points: &[Point], base: f64) -> Vec<f64> {
    vec![base; points.len().saturating_sub(1)]
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

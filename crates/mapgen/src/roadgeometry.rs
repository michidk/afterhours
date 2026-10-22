//! Line-for-line port of `mapgen/roadgeometry.ts`; arithmetic stays in f64.
use crate::{
    field::sample,
    geom::{
        add, dist, dot, lerp as lerp_point, line_intersection, mul, norm, perp, polyline_length,
        segment_intersection, self_intersects, signed_area, sub,
    },
    types::*,
};
use std::collections::{HashMap, HashSet};
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

#[derive(Clone)]
struct Arm {
    edge: usize,
    at_start: bool,
    dir: Point,
    heading: Point,
    hw: f64,
    ang: f64,
    cut_l: f64,
    cut_r: f64,
    limit: f64,
}
struct Arc {
    centre: Point,
    radius: f64,
    from: f64,
    to: f64,
}
#[derive(Default)]
struct Corner {
    points: Vec<Point>,
    arc: Option<Arc>,
}
#[derive(Clone, Copy, Hash, PartialEq, Eq)]
struct WalkEnd {
    edge: usize,
    at_start: bool,
    left: bool,
}
struct Turn {
    from: WalkEnd,
    to: WalkEnd,
    via: Vec<Point>,
}
#[derive(Clone, Copy)]
struct Mouth {
    cut: f64,
    l: Point,
    end_l: Point,
    end_r: Point,
}
const CROSSING_BAND: f64 = 16.;
const MARKED_END: f64 = 5.;
const SPLIT: f64 = 0.7;
const CROSSING_AT: f64 = 2.3;
const WALK: f64 = SIDEWALK / 2. + 0.35;
const PASSES: usize = 3;
fn arc_points(centre: Point, radius: f64, from: f64, to: f64, n: usize) -> Vec<Point> {
    (0..=n)
        .map(|i| {
            let a = from + ((to - from) * i as f64) / n as f64;
            Point {
                x: centre.x + a.cos() * radius,
                z: centre.z + a.sin() * radius,
            }
        })
        .collect()
}
fn signed_angle(a: Point, b: Point) -> f64 {
    (a.x * b.z - a.z * b.x).atan2(a.x * b.x + a.z * b.z)
}
fn continuation(arms: &[Arm], graph: &RoadGraph) -> bool {
    arms.len() == 2
        && graph.edges[arms[0].edge].width == graph.edges[arms[1].edge].width
        && signed_angle(arms[0].heading, mul(arms[1].heading, -1.)).abs() < 1e-4
}
fn cul_de_sac_radius(arm: &Arm, graph: &RoadGraph) -> f64 {
    arm.hw
        + if matches!(
            graph.edges[arm.edge].kind,
            RoadKind::Street | RoadKind::Lane
        ) {
            4.5
        } else {
            2.
        }
}
fn band_side(arm: &Arm, arm_left: bool) -> WalkEnd {
    WalkEnd {
        edge: arm.edge,
        at_start: arm.at_start,
        left: arm.at_start == arm_left,
    }
}
pub fn build_road_geometry(graph: &RoadGraph) -> RoadGeometry {
    let mut geometry = layout_road_geometry(graph, None);
    for _ in 0..PASSES {
        let cuts: Vec<_> = graph
            .edges
            .iter()
            .flat_map(|e| {
                let t = geometry.trims[e.id];
                [t.0, t.1]
            })
            .collect();
        geometry = layout_road_geometry(graph, Some(&cuts));
    }
    geometry
}
fn layout_road_geometry(graph: &RoadGraph, cuts: Option<&[f64]>) -> RoadGeometry {
    let mut junctions = Vec::new();
    let mut sidewalks = Vec::new();
    let mut markings = Vec::new();
    let mut trim = vec![(0., 0.); graph.edges.len()];
    let mut mouth_ends: HashMap<(usize, bool), Mouth> = HashMap::new();
    let mut junction_nodes = HashSet::new();
    let mut turns = Vec::new();
    let departing = |edge_id: usize, at_start: bool| {
        let e = &graph.edges[edge_id];
        let mut pts = e.points.clone();
        if !at_start {
            pts.reverse();
        }
        let reach = (0.45 * polyline_length(&pts))
            .min(cuts.map_or(8., |c| c[edge_id * 2 + usize::from(!at_start)]));
        let dir = norm(sub(point_at(&pts, reach.max(4.)), pts[0]));
        Arm {
            edge: edge_id,
            at_start,
            dir,
            heading: norm(sub(pts[2.min(pts.len() - 1)], pts[0])),
            hw: e.width / 2.,
            ang: dir.z.atan2(dir.x),
            cut_l: 0.,
            cut_r: 0.,
            limit: f64::INFINITY,
        }
    };
    let mut arms_at: Vec<Vec<Arm>> = graph
        .nodes
        .iter()
        .map(|n| {
            let mut arms: Vec<_> = n
                .edges
                .iter()
                .enumerate()
                .map(|(i, &id)| {
                    let e = &graph.edges[id];
                    departing(
                        id,
                        if e.a != e.b {
                            e.a == n.id
                        } else {
                            n.edges.iter().position(|&v| v == id) == Some(i)
                        },
                    )
                })
                .collect();
            arms.sort_by(|p, q| p.ang.partial_cmp(&q.ang).unwrap());
            arms
        })
        .collect();
    let mut phases = vec![(None, None); graph.edges.len()];
    for arms in &arms_at {
        if arms.len() < 3 {
            continue;
        }
        let mut pair = (0, 1);
        let mut straightest = f64::INFINITY;
        for (i, a) in arms.iter().enumerate() {
            for (j, b) in arms.iter().enumerate() {
                if i != j && dot(a.dir, b.dir) < straightest {
                    straightest = dot(a.dir, b.dir);
                    pair = (i, j);
                }
            }
        }
        for (i, a) in arms.iter().enumerate() {
            let phase = Some(if i == pair.0 || i == pair.1 {
                Phase::Z
            } else {
                Phase::X
            });
            if a.at_start {
                phases[a.edge].0 = phase;
            } else {
                phases[a.edge].1 = phase;
            }
        }
    }
    let need = |arms: &[Arm], index: usize| {
        let arm = &arms[index];
        if arms.len() == 1 {
            let r = cul_de_sac_radius(arm, graph);
            return (r * r - arm.hw * arm.hw).max(0.).sqrt();
        }
        if continuation(arms, graph) {
            return 0.;
        }
        let widest = arms
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, o)| o.hw)
            .fold(f64::NEG_INFINITY, f64::max);
        widest + curb_radius(graph.edges[arm.edge].kind) + 0.3
    };
    let mut ends = vec![Vec::new(); graph.edges.len()];
    for (n, arms) in arms_at.iter().enumerate() {
        for (i, arm) in arms.iter().enumerate() {
            ends[arm.edge].push((n, i));
        }
    }
    for e in &graph.edges {
        let arms: Vec<_> = ends[e.id]
            .iter()
            .map(|&(n, i)| ((n, i), need(&arms_at[n], i)))
            .collect();
        let length = polyline_length(&e.points);
        let room = length - CROSSING_BAND.min(length * 0.3);
        let total: f64 = arms.iter().map(|a| a.1).sum();
        if total > room {
            for ((n, i), need) in arms {
                arms_at[n][i].limit = (room * need) / total;
            }
        }
    }
    for n in &graph.nodes {
        let mut arms = arms_at[n.id].clone();
        if arms.is_empty() {
            continue;
        }
        if arms.len() == 1 {
            let arm = &arms[0];
            let radius = cul_de_sac_radius(arm, graph);
            let cut = arm
                .limit
                .min((radius * radius - arm.hw * arm.hw).max(0.).sqrt());
            if arm.at_start {
                trim[arm.edge].0 = cut;
            } else {
                trim[arm.edge].1 = cut;
            }
            continue;
        }
        if continuation(&arms, graph) {
            turns.push(Turn {
                from: band_side(&arms[0], true),
                to: band_side(&arms[1], false),
                via: vec![],
            });
            turns.push(Turn {
                from: band_side(&arms[1], true),
                to: band_side(&arms[0], false),
                via: vec![],
            });
            continue;
        }
        let count = arms.len();
        let mut corners = Vec::new();
        let node = Point { x: n.x, z: n.z };
        for k in 0..count {
            let next = (k + 1) % count;
            let a = &arms[k];
            let b = &arms[next];
            let mut turn = signed_angle(a.dir, b.dir);
            if turn <= 0. {
                turn += PI * 2.;
            }
            let n_a = perp(a.dir);
            let n_b = mul(perp(b.dir), -1.);
            let p_a = add(node, mul(n_a, a.hw));
            let p_b = add(node, mul(n_b, b.hw));
            let hit = if turn < PI - 0.12 {
                line_intersection(p_a, a.dir, p_b, b.dir)
            } else {
                None
            };
            let Some(hit) = hit else {
                corners.push(Corner::default());
                continue;
            };
            let mut t_a = dot(sub(hit, p_a), a.dir);
            let mut t_b = dot(sub(hit, p_b), b.dir);
            let max_cut = 2.4 * a.hw.max(b.hw);
            if t_a < 0. || t_b < 0. || t_a > max_cut || t_b > max_cut {
                t_a = t_a.clamp(0., max_cut);
                t_b = t_b.clamp(0., max_cut);
                corners.push(Corner {
                    points: vec![add(p_a, mul(a.dir, t_a)), add(p_b, mul(b.dir, t_b))],
                    arc: None,
                });
                arms[k].cut_l = arms[k].cut_l.max(t_a);
                arms[next].cut_r = arms[next].cut_r.max(t_b);
                continue;
            }
            let half = turn / 2.;
            let tangent = (curb_radius(graph.edges[a.edge].kind)
                .min(curb_radius(graph.edges[b.edge].kind))
                / half.tan())
            .min(14.)
            .min(a.limit - 0.3 - t_a)
            .min(b.limit - 0.3 - t_b);
            let a_dir = a.dir;
            let b_dir = b.dir;
            arms[k].cut_l = arms[k].cut_l.max(t_a + tangent.max(0.));
            arms[next].cut_r = arms[next].cut_r.max(t_b + tangent.max(0.));
            if tangent < 0.75 {
                corners.push(Corner {
                    points: vec![hit],
                    arc: None,
                });
                continue;
            }
            let r = tangent * half.tan();
            let bisector = norm(add(a_dir, b_dir));
            let centre = add(hit, mul(bisector, r / half.sin()));
            let ta = add(hit, mul(a_dir, tangent));
            let tb = add(hit, mul(b_dir, tangent));
            let from = (ta.z - centre.z).atan2(ta.x - centre.x);
            let mut to = (tb.z - centre.z).atan2(tb.x - centre.x);
            while to - from > PI {
                to -= PI * 2.;
            }
            while to - from < -PI {
                to += PI * 2.;
            }
            let steps = (((to - from).abs() * r) / 1.5).ceil().max(3.) as usize;
            corners.push(Corner {
                points: arc_points(centre, r, from, to, steps),
                arc: Some(Arc {
                    centre,
                    radius: r,
                    from,
                    to,
                }),
            });
        }
        for k in 0..count {
            let widest = arms[k].limit.min(
                0.6 * arms
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != k)
                    .map(|(_, o)| o.hw)
                    .fold(f64::NEG_INFINITY, f64::max),
            );
            arms[k].cut_l = arms[k].cut_l.max(widest);
            arms[k].cut_r = arms[k].cut_r.max(widest);
        }
        let mouths: Vec<_> = arms
            .iter()
            .enumerate()
            .map(|(k, a)| {
                let mut pts = graph.edges[a.edge].points.clone();
                if !a.at_start {
                    pts.reverse();
                }
                let length = polyline_length(&pts);
                let near: Vec<_> = corners[k]
                    .points
                    .iter()
                    .chain(&corners[(k + count - 1) % count].points)
                    .copied()
                    .collect();
                let mouth = |cut| {
                    let remaining = trim_polyline(&pts, cut, 0.);
                    let end = remaining[0];
                    let t = norm(sub(remaining[1], end));
                    (cut, end, t, perp(t))
                };
                let mut m = mouth(a.cut_l.max(a.cut_r) + 0.3);
                while m.0 < length * 0.5 && near.iter().any(|&q| dot(sub(q, m.1), m.2) > -0.2) {
                    m = mouth(m.0 + 0.25);
                }
                Mouth {
                    cut: m.0,
                    l: m.3,
                    end_l: add(m.1, mul(m.3, a.hw)),
                    end_r: add(m.1, mul(m.3, -a.hw)),
                }
            })
            .collect();
        let mut ring = Vec::new();
        for k in 0..count {
            let a = &arms[k];
            let Mouth {
                cut,
                l,
                end_l,
                end_r,
            } = mouths[k];
            ring.extend([end_r, end_l]);
            ring.extend_from_slice(&corners[k].points);
            mouth_ends.insert((a.edge, a.at_start), mouths[k]);
            if a.at_start {
                trim[a.edge].0 = cut;
            } else {
                trim[a.edge].1 = cut;
            }
            let b = &arms[(k + 1) % count];
            let end_rb = mouths[(k + 1) % count].end_r;
            let l_b = mouths[(k + 1) % count].l;
            let n_a = perp(a.dir);
            let n_b = mul(perp(b.dir), -1.);
            let corner = &corners[k];
            let first = corner.points.first().copied().unwrap_or(end_rb);
            let last = corner.points.last().copied().unwrap_or(end_l);
            let mut via = Vec::new();
            if !corner.points.is_empty() {
                if dist(end_l, first) > 0.05 {
                    sidewalks.push(Sidewalk {
                        node: Some(n.id),
                        edge: None,
                        polygon: vec![
                            first,
                            end_l,
                            add(end_l, mul(l, SIDEWALK)),
                            add(first, mul(n_a, SIDEWALK)),
                        ],
                    });
                }
                if dist(last, end_rb) > 0.05 {
                    sidewalks.push(Sidewalk {
                        node: Some(n.id),
                        edge: None,
                        polygon: vec![
                            last,
                            add(last, mul(n_b, SIDEWALK)),
                            add(end_rb, mul(l_b, -SIDEWALK)),
                            end_rb,
                        ],
                    });
                }
                if let Some(Arc {
                    centre,
                    radius,
                    from,
                    to,
                }) = corner.arc
                {
                    let steps = corner.points.len() - 1;
                    let inner = |offset, n| {
                        if radius > offset + 0.05 {
                            arc_points(centre, radius - offset, from, to, n)
                        } else {
                            vec![
                                line_intersection(
                                    add(first, mul(n_a, offset)),
                                    a.dir,
                                    add(last, mul(n_b, offset)),
                                    b.dir,
                                )
                                .unwrap_or(centre),
                            ]
                        }
                    };
                    let mut polygon = corner.points.clone();
                    polygon.extend(inner(SIDEWALK, steps).into_iter().rev());
                    sidewalks.push(Sidewalk {
                        node: Some(n.id),
                        edge: None,
                        polygon,
                    });
                    via = inner(
                        WALK,
                        ((to - from).abs() / (PI / 8.)).ceil().max(2.) as usize,
                    );
                } else if corner.points.len() == 1 {
                    let p = corner.points[0];
                    let bisector = norm(add(n_a, n_b));
                    let reach = 1. / dot(bisector, n_a).max(0.35);
                    sidewalks.push(Sidewalk {
                        node: Some(n.id),
                        edge: None,
                        polygon: vec![
                            p,
                            add(p, mul(n_b, SIDEWALK)),
                            add(p, mul(bisector, SIDEWALK * reach)),
                            add(p, mul(n_a, SIDEWALK)),
                        ],
                    });
                    via = vec![add(p, mul(bisector, WALK * reach))];
                } else {
                    let p1 = corner.points[0];
                    let p2 = corner.points[1];
                    sidewalks.push(Sidewalk {
                        node: Some(n.id),
                        edge: None,
                        polygon: vec![
                            p1,
                            p2,
                            add(p2, mul(n_b, SIDEWALK)),
                            add(p1, mul(n_a, SIDEWALK)),
                        ],
                    });
                    via = vec![add(p1, mul(n_a, WALK)), add(p2, mul(n_b, WALK))];
                }
            } else {
                sidewalks.push(Sidewalk {
                    node: Some(n.id),
                    edge: None,
                    polygon: vec![
                        end_l,
                        add(end_l, mul(l, SIDEWALK)),
                        add(end_rb, mul(l_b, -SIDEWALK)),
                        end_rb,
                    ],
                });
            }
            turns.push(Turn {
                from: band_side(a, true),
                to: band_side(b, false),
                via,
            });
        }
        junctions.push(Junction {
            node: n.id,
            polygon: remove_loops(&ring),
        });
        if count >= 3 {
            junction_nodes.insert(n.id);
        }
    }
    for n in &graph.nodes {
        if arms_at[n.id].len() == 1 {
            cul_de_sac(
                n,
                &arms_at[n.id][0],
                graph,
                &mut junctions,
                &mut sidewalks,
                &trim,
                &mut turns,
            );
        }
    }
    let mut bands = Vec::new();
    let mut walkways = Walkways::default();
    let mut walk_ends = HashMap::new();
    for e in &graph.edges {
        let pts = trim_polyline(&e.points, trim[e.id].0, trim[e.id].1);
        if pts.len() < 2 {
            continue;
        }
        let (mut left, mut right) = offset_polyline(&pts, e.width / 2.);
        let (mut outer_left, mut outer_right) = offset_polyline(&pts, e.width / 2. + SIDEWALK);
        let last = pts.len() - 1;
        for (at, at_start, flip) in [(0, true, false), (last, false, true)] {
            let Some(end) = mouth_ends.get(&(e.id, at_start)) else {
                continue;
            };
            if dist(left[at], if flip { end.end_r } else { end.end_l }) > 1. {
                continue;
            }
            let to_left = if flip { end.end_r } else { end.end_l };
            let to_right = if flip { end.end_l } else { end.end_r };
            let side = if flip { -1. } else { 1. };
            left[at] = to_left;
            right[at] = to_right;
            outer_left[at] = add(to_left, mul(end.l, SIDEWALK * side));
            outer_right[at] = add(to_right, mul(end.l, -SIDEWALK * side));
        }
        bands.push(Band {
            edge: e.id,
            polygon: left.iter().chain(right.iter().rev()).copied().collect(),
            left: left.clone(),
            right: right.clone(),
            centre: pts.clone(),
        });
        sidewalks.push(Sidewalk {
            edge: Some(e.id),
            node: None,
            polygon: left
                .iter()
                .chain(outer_left.iter().rev())
                .copied()
                .collect(),
        });
        sidewalks.push(Sidewalk {
            edge: Some(e.id),
            node: None,
            polygon: outer_right
                .iter()
                .chain(right.iter().rev())
                .copied()
                .collect(),
        });
        let length = polyline_length(&pts);
        let splits = |node: usize| {
            let arms = &arms_at[node];
            let arm = arms
                .iter()
                .position(|a| a.edge == e.id && a.at_start == (e.a == node));
            arm.is_some_and(|i| {
                arms.iter()
                    .enumerate()
                    .any(|(j, o)| j != i && dot(o.dir, arms[i].dir) > SPLIT.cos())
            })
        };
        let crossing = |node| {
            junction_nodes.contains(&node) && !e.bridge && length >= CROSSING_BAND && !splits(node)
        };
        paint_markings(e, &pts, crossing, &mut markings);
        let mut stations = vec![0., length];
        let steps = (length / 12.).ceil().max(1.) as usize;
        for i in 1..steps {
            let s = (length * i as f64) / steps as f64;
            if !stations.contains(&s) {
                stations.push(s);
            }
        }
        if crossing(e.a) && !stations.contains(&CROSSING_AT) {
            stations.push(CROSSING_AT);
        }
        if crossing(e.b) && !stations.contains(&(length - CROSSING_AT)) {
            stations.push(length - CROSSING_AT);
        }
        stations.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let offset = e.width / 2. + WALK;
        let mut side = |left: bool| {
            let ids: Vec<_> = stations
                .iter()
                .map(|&s| {
                    let p = point_at(&pts, s);
                    let d = norm(sub(
                        point_at(&pts, length.min(s + 0.5)),
                        point_at(&pts, (s - 0.5).max(0.)),
                    ));
                    let id = walkways.points.len();
                    walkways
                        .points
                        .push(add(p, mul(perp(d), if left { offset } else { -offset })));
                    id
                })
                .collect();
            for i in 1..ids.len() {
                walkways.links.push(WalkLink {
                    a: ids[i - 1],
                    b: ids[i],
                    crossing: None,
                });
            }
            walk_ends.insert(
                WalkEnd {
                    edge: e.id,
                    at_start: true,
                    left,
                },
                ids[0],
            );
            walk_ends.insert(
                WalkEnd {
                    edge: e.id,
                    at_start: false,
                    left,
                },
                *ids.last().unwrap(),
            );
            ids
        };
        let lefts = side(true);
        let rights = side(false);
        for (node, i) in [(e.a, 1), (e.b, stations.len() - 2)] {
            if crossing(node) {
                walkways.links.push(WalkLink {
                    a: lefts[i],
                    b: rights[i],
                    crossing: if node == e.a && i == 1 {
                        phases[e.id].0
                    } else {
                        phases[e.id].1
                    },
                });
            }
        }
    }
    for Turn { from, to, via } in turns {
        let (Some(&a), Some(&b)) = (walk_ends.get(&from), walk_ends.get(&to)) else {
            continue;
        };
        let mut ids = vec![a];
        for p in via {
            ids.push(walkways.points.len());
            walkways.points.push(p);
        }
        ids.push(b);
        for i in 1..ids.len() {
            walkways.links.push(WalkLink {
                a: ids[i - 1],
                b: ids[i],
                crossing: None,
            });
        }
    }
    for piece in &mut sidewalks {
        if piece.polygon.len() == 4 && self_intersects(&piece.polygon) {
            sort_around_middle(&mut piece.polygon);
        }
    }
    RoadGeometry {
        junctions,
        bands,
        sidewalks,
        markings,
        walkways,
        trims: trim,
        phases,
    }
}
fn sort_around_middle(points: &mut [Point]) {
    let c = mul(
        points.iter().copied().fold(Point { x: 0., z: 0. }, add),
        0.25,
    );
    points.sort_by(|p, q| {
        (p.z - c.z)
            .atan2(p.x - c.x)
            .partial_cmp(&(q.z - c.z).atan2(q.x - c.x))
            .unwrap()
    });
}
fn remove_loops(ring: &[Point]) -> Vec<Point> {
    let mut out = ring.to_vec();
    for _ in 0..ring.len() {
        let n = out.len();
        let mut found = None;
        'search: for i in 0..n {
            for k in i + 2..n {
                if i == 0 && k == n - 1 {
                    continue;
                }
                let a = out[i];
                let b = out[(i + 1) % n];
                if let Some((t, _)) = segment_intersection(a, b, out[k], out[(k + 1) % n]) {
                    found = Some((i, k, lerp_point(a, b, t)));
                    break 'search;
                }
            }
        }
        let Some((i, k, at)) = found else {
            return out;
        };
        let mut inner = vec![at];
        inner.extend_from_slice(&out[i + 1..k + 1]);
        let mut outer = out[..i + 1].to_vec();
        outer.push(at);
        outer.extend_from_slice(&out[k + 1..]);
        out = if signed_area(&inner).abs() > signed_area(&outer).abs() {
            inner
        } else {
            outer
        };
        if out.len() < 3 {
            return ring.to_vec();
        }
    }
    out
}
fn cul_de_sac(
    n: &RoadNode,
    arm: &Arm,
    graph: &RoadGraph,
    junctions: &mut Vec<Junction>,
    sidewalks: &mut Vec<Sidewalk>,
    trim: &[(f64, f64)],
    turns: &mut Vec<Turn>,
) {
    let cuts = trim[arm.edge];
    let mut points = trim_polyline(&graph.edges[arm.edge].points, cuts.0, cuts.1);
    if !arm.at_start {
        points.reverse();
    }
    let cut = if arm.at_start { cuts.0 } else { cuts.1 };
    let end = points[0];
    let dir = norm(sub(points[1], end));
    let l = perp(dir);
    let centre = sub(end, mul(dir, cut));
    let radius = cut.hypot(arm.hw);
    let end_r = add(end, mul(l, -arm.hw));
    let end_l = add(end, mul(l, arm.hw));
    let from = (end_l.z - centre.z).atan2(end_l.x - centre.x);
    let mut to = (end_r.z - centre.z).atan2(end_r.x - centre.x);
    while to <= from {
        to += PI * 2.;
    }
    let steps = (((to - from) * radius) / 1.5).ceil().max(8.) as usize;
    let mut arc = arc_points(centre, radius, from, to, steps);
    arc[0] = end_l;
    *arc.last_mut().unwrap() = end_r;
    let mut polygon = vec![end_r, end_l];
    polygon.extend_from_slice(&arc[1..arc.len() - 1]);
    junctions.push(Junction {
        node: n.id,
        polygon,
    });
    let outer_l = add(end_l, mul(l, SIDEWALK));
    let outer_r = add(end_r, mul(l, -SIDEWALK));
    let outer_from = (outer_l.z - centre.z).atan2(outer_l.x - centre.x);
    let mut outer_to = (outer_r.z - centre.z).atan2(outer_r.x - centre.x);
    while outer_to <= outer_from {
        outer_to += PI * 2.;
    }
    let mut outer = arc_points(
        centre,
        cut.hypot(arm.hw + SIDEWALK),
        outer_to,
        outer_from,
        steps,
    );
    outer[0] = outer_r;
    *outer.last_mut().unwrap() = outer_l;
    arc.extend(outer);
    sidewalks.push(Sidewalk {
        node: Some(n.id),
        edge: None,
        polygon: arc,
    });
    turns.push(Turn {
        from: band_side(arm, true),
        to: band_side(arm, false),
        via: arc_points(centre, cut.hypot(arm.hw + WALK), outer_from, outer_to, 16),
    });
}
fn offset_line(centre: &[Point], offset: f64) -> Vec<Point> {
    if offset.abs() < 1e-6 {
        return centre.to_vec();
    }
    let (left, right) = offset_polyline(centre, offset.abs());
    if offset > 0. { left } else { right }
}
fn paint_markings(
    e: &RoadEdge,
    centre: &[Point],
    crossing: impl Fn(usize) -> bool,
    out: &mut Vec<Marking>,
) {
    if e.kind == RoadKind::Lane {
        return;
    }
    let length = polyline_length(centre);
    if length < 6. {
        return;
    }
    let hw = e.width / 2.;
    let lane_count = lanes(e.kind);
    let lane_width = (e.width - 2.) / lane_count as f64;
    let start_cut = if crossing(e.a) { MARKED_END } else { 0.5 };
    let end_cut = if crossing(e.b) { MARKED_END } else { 0.5 };
    let lined = length - start_cut - end_cut > 2.;
    let lane = if lined {
        trim_polyline(centre, start_cut, end_cut)
    } else {
        centre.to_vec()
    };
    let lane_length = if lined {
        length - start_cut - end_cut
    } else {
        0.
    };
    let strip = |out: &mut Vec<Marking>, offset, width, color: &str| {
        if !lined {
            return;
        }
        let path = offset_line(&lane, offset);
        let (left, right) = offset_polyline(&path, width / 2.);
        out.push(Marking {
            edge: e.id,
            color: color.into(),
            polygon: left.into_iter().chain(right.into_iter().rev()).collect(),
        });
    };
    let dashes = |out: &mut Vec<Marking>, offset, width, on, off, color: &str| {
        let path = offset_line(&lane, offset);
        let mut s = 1.;
        while s + on < lane_length - 1. {
            let a = point_at(&path, s);
            let b = point_at(&path, s + on);
            let d = norm(sub(b, a));
            let nrm = mul(perp(d), width / 2.);
            out.push(Marking {
                edge: e.id,
                color: color.into(),
                polygon: vec![add(a, nrm), add(b, nrm), sub(b, nrm), sub(a, nrm)],
            });
            s += on + off;
        }
    };
    if lane_count >= 4 {
        strip(out, 0.15, 0.12, "yellow");
        strip(out, -0.15, 0.12, "yellow");
        dashes(out, lane_width, 0.12, 3., 6., "white");
        dashes(out, -lane_width, 0.12, 3., 6., "white");
        strip(out, hw - 0.5, 0.12, "white");
        strip(out, -(hw - 0.5), 0.12, "white");
    } else {
        dashes(out, 0., 0.12, 3., 6., "white");
    }
    for (node, from_start) in [(e.a, true), (e.b, false)] {
        if !crossing(node) {
            continue;
        }
        let mut path = centre.to_vec();
        if !from_start {
            path.reverse();
        }
        let origin = path[0];
        let dir = norm(sub(point_at(&path, 4.), origin));
        let side = perp(dir);
        let rect = |s0, s1, o0, o1| {
            vec![
                add(add(origin, mul(dir, s0)), mul(side, o0)),
                add(add(origin, mul(dir, s1)), mul(side, o0)),
                add(add(origin, mul(dir, s1)), mul(side, o1)),
                add(add(origin, mul(dir, s0)), mul(side, o1)),
            ]
        };
        let mut o = -hw + 0.6;
        while o + 0.5 <= hw - 0.6 {
            out.push(Marking {
                edge: e.id,
                color: "white".into(),
                polygon: rect(1., 3.6, o, o + 0.5),
            });
            o += 1.;
        }
        out.push(Marking {
            edge: e.id,
            color: "white".into(),
            polygon: rect(4.2, 4.6, 0.2, hw - 0.3),
        });
    }
}

use crate::{field::to_world, geom};
fn kind_grade(k: RoadKind) -> f64 {
    if k == RoadKind::Highway { 0.07 } else { 0.1 }
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

#![allow(clippy::chunks_exact_to_as_chunks, clippy::type_complexity)]
//! Exact street surface operations used by the artifact converter.
pub use crate::city_sink::sink_under_streets;
use crate::js_math::JsMath;
use crate::{
    geom::{closest_on_segment, dist, ear_clip, self_intersects, signed_area},
    types::{Point, RoadEdge},
};
use std::collections::{HashMap, HashSet};
pub const LIMIT: f64 = 1536.0;
pub const TERRAIN_STEP: f64 = 8.0;
pub const TERRAIN_SIDE: usize = 385;
pub const SIDEWALK: f64 = 2.5;
pub const WATER_LEVEL: f64 = -1.1;
pub const STREET_LIFT: f64 = 0.1;
pub const KERB_HEIGHT: f64 = 0.15;
pub fn js_round(v: f64) -> f64 {
    let f = v.floor();
    if v - f < 0.5 { f } else { f + 1.0 }
}
pub fn round(v: f64) -> f64 {
    js_round(v * 100.0) / 100.0 + 0.0
}
pub fn snap_cm(v: f64) -> f64 {
    js_round(v * 100.0 + 1e-4) / 100.0 + 0.0
}
pub fn terrain_height(x: f64, z: f64, h: &[f64]) -> f64 {
    if x.abs() > LIMIT || z.abs() > LIMIT {
        return -12.0;
    }
    let gx = (x + LIMIT) / TERRAIN_STEP;
    let gz = (z + LIMIT) / TERRAIN_STEP;
    let ix = (gx.floor() as usize).min(TERRAIN_SIDE - 2);
    let iz = (gz.floor() as usize).min(TERRAIN_SIDE - 2);
    let u = gx - ix as f64;
    let v = gz - iz as f64;
    let i = iz * TERRAIN_SIDE + ix;
    if u + v <= 1.0 {
        h[i] + u * (h[i + 1] - h[i]) + v * (h[i + TERRAIN_SIDE] - h[i])
    } else {
        h[i + TERRAIN_SIDE + 1]
            + (1.0 - u) * (h[i + TERRAIN_SIDE] - h[i + TERRAIN_SIDE + 1])
            + (1.0 - v) * (h[i + 1] - h[i + TERRAIN_SIDE + 1])
    }
}
pub fn edge_height_at(e: &RoadEdge, p: Point) -> f64 {
    let mut best = f64::INFINITY;
    let mut y = e.heights.first().copied().unwrap_or(0.0);
    for i in 1..e.points.len() {
        let (q, t) = closest_on_segment(p, e.points[i - 1], e.points[i]);
        let d = dist(q, p);
        if d < best {
            best = d;
            y = e.heights[i - 1] + (e.heights[i] - e.heights[i - 1]) * t;
        }
    }
    y
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
        let mut worst = 0.0;
        let mut index = None;
        for i in a + 1..b {
            let ab = crate::geom::sub(points[b], points[a]);
            let l = ab.x.js_hypot(ab.z);
            let d = if l < 1e-6 {
                dist(points[i], points[a])
            } else {
                (ab.x * (points[i].z - points[a].z) - ab.z * (points[i].x - points[a].x)).abs() / l
            };
            if d > worst {
                worst = d;
                index = Some(i);
            }
        }
        if let Some(i) = index.filter(|_| worst > tolerance) {
            keep[i] = true;
            stack.push((a, i));
            stack.push((i, b));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(&p, k)| k.then_some(p))
        .collect()
}

fn points(flat: &[f64]) -> Vec<Point> {
    flat.chunks_exact(3)
        .map(|p| Point { x: p[0], z: p[2] })
        .collect()
}
fn corner_key(flat: &[f64], i: usize) -> (i64, i64) {
    (
        js_round(snap_cm(flat[i]) * 100.0) as i64,
        js_round(snap_cm(flat[i + 2]) * 100.0) as i64,
    )
}
fn each_corner(flat: &[f64], mut visit: impl FnMut((i64, i64), bool, usize)) {
    let n = flat.len() / 3;
    for k in 0..n {
        let a = ((k + n - 1) % n) * 3;
        let b = k * 3;
        let c = ((k + 1) % n) * 3;
        let turn = (flat[b] - flat[a]) * (flat[c + 2] - flat[b + 2])
            - (flat[b + 2] - flat[a + 2]) * (flat[c] - flat[b]);
        visit(corner_key(flat, b), turn.abs() < 1e-6, b);
    }
}
type Seen = HashMap<(i64, i64), Vec<[f64; 2]>>;
fn weld_corners(rings: Vec<Vec<f64>>, seen: &mut Seen) -> Vec<Vec<f64>> {
    let mut result = Vec::new();
    for ring in rings {
        let mut out = Vec::new();
        for i in (0..ring.len()).step_by(3) {
            let cx = (ring[i] / 0.05).floor() as i64;
            let cz = (ring[i + 2] / 0.05).floor() as i64;
            let mut at = None;
            for dx in -1..=1 {
                if at.is_some() {
                    break;
                }
                for dz in -1..=1 {
                    if at.is_some() {
                        break;
                    }
                    at = seen
                        .get(&(cx + dx, cz + dz))
                        .and_then(|v| {
                            v.iter()
                                .find(|c| (c[0] - ring[i]).js_hypot(c[1] - ring[i + 2]) <= 0.05)
                        })
                        .copied();
                }
            }
            let [x, z] = at.unwrap_or([ring[i], ring[i + 2]]);
            if at.is_none() {
                seen.entry((cx, cz)).or_default().push([x, z]);
            }
            if out.len() >= 3 && out[out.len() - 3] == x && out[out.len() - 1] == z {
                continue;
            }
            out.extend([x, ring[i + 1], z]);
        }
        if out.len() >= 6 && out[0] == out[out.len() - 3] && out[2] == out[out.len() - 1] {
            out.truncate(out.len() - 3);
        }
        if out.len() >= 9 {
            result.push(out);
        }
    }
    result
}
fn close_t_junctions(rings: Vec<Vec<f64>>, layers: Option<&[usize]>) -> Vec<Vec<f64>> {
    let mut corners: HashMap<(i64, i64), Vec<([f64; 3], usize)>> = HashMap::new();
    for (r, ring) in rings.iter().enumerate() {
        for p in ring.chunks_exact(3) {
            corners
                .entry(((p[0] / 2.0).floor() as i64, (p[2] / 2.0).floor() as i64))
                .or_default()
                .push(([p[0], p[1], p[2]], layers.map_or(0, |l| l[r])));
        }
    }
    rings
        .iter()
        .enumerate()
        .map(|(r, ring)| {
            let n = ring.len() / 3;
            let mut out = Vec::new();
            for i in 0..n {
                let a = &ring[i * 3..i * 3 + 3];
                let j = (i + 1) % n;
                let b = &ring[j * 3..j * 3 + 3];
                let ux = b[0] - a[0];
                let uz = b[2] - a[2];
                let length = ux.js_hypot(uz);
                out.extend_from_slice(a);
                if length < 0.02 {
                    continue;
                }
                let mut found: Vec<((i64, i64), f64, [f64; 3])> = Vec::new();
                let mut positions = HashMap::new();
                for cx in
                    (a[0].min(b[0]) / 2.0).floor() as i64..=(a[0].max(b[0]) / 2.0).floor() as i64
                {
                    for cz in (a[2].min(b[2]) / 2.0).floor() as i64
                        ..=(a[2].max(b[2]) / 2.0).floor() as i64
                    {
                        for &(c, layer) in corners.get(&(cx, cz)).into_iter().flatten() {
                            if layer < layers.map_or(0, |l| l[r]) {
                                continue;
                            }
                            let t = ((c[0] - a[0]) * ux + (c[2] - a[2]) * uz) / length.powi(2);
                            if t * length < 0.01 || (1.0 - t) * length < 0.01 {
                                continue;
                            }
                            if ((c[0] - a[0]) * uz - (c[2] - a[2]) * ux).abs() / length > 0.09 {
                                continue;
                            }
                            let key = corner_key(&c, 0);
                            if let Some(&idx) = positions.get(&key) {
                                found[idx] = (key, t, c);
                            } else {
                                positions.insert(key, found.len());
                                found.push((key, t, c));
                            }
                        }
                    }
                }
                found.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
                for (_, _, c) in found {
                    out.extend(c);
                }
            }
            out
        })
        .collect()
}
pub fn seal_surfaces(layers: Vec<Vec<Vec<f64>>>) -> Vec<Vec<Vec<f64>>> {
    fn split(rings: Vec<Vec<f64>>, counts: &[usize]) -> Vec<Vec<Vec<f64>>> {
        let mut iter = rings.into_iter();
        counts
            .iter()
            .map(|&n| iter.by_ref().take(n).collect())
            .collect()
    }
    fn tags(l: &[Vec<Vec<f64>>]) -> Vec<usize> {
        l.iter()
            .enumerate()
            .flat_map(|(i, x)| std::iter::repeat_n(i, x.len()))
            .collect()
    }
    let closed = split(
        close_t_junctions(
            layers.iter().flatten().cloned().collect(),
            Some(&tags(&layers)),
        ),
        &layers.iter().map(Vec::len).collect::<Vec<_>>(),
    );
    let mut seen = Seen::new();
    let welded: Vec<_> = closed
        .into_iter()
        .map(|l| weld_corners(l, &mut seen))
        .collect();
    split(
        close_t_junctions(
            welded.iter().flatten().cloned().collect(),
            Some(&tags(&welded)),
        ),
        &welded.iter().map(Vec::len).collect::<Vec<_>>(),
    )
}
fn convex(poly: &[Point]) -> bool {
    let mut sign = 0.0;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let c = poly[(i + 2) % poly.len()];
        let turn = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        if turn.abs() < 1e-9 {
            continue;
        }
        if sign != 0.0 && turn.signum() != sign {
            return false;
        }
        sign = turn.signum();
    }
    true
}
fn clip(poly: &[Point], inside: impl Fn(Point) -> f64) -> Vec<Point> {
    let mut out = Vec::new();
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let da = inside(a);
        let db = inside(b);
        if da >= 0.0 {
            out.push(a);
        }
        if (da >= 0.0) != (db >= 0.0) {
            let t = da / (da - db);
            out.push(Point {
                x: a.x + (b.x - a.x) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    out
}
fn apart(a: &[Point], b: &[Point]) -> bool {
    for (p, q) in [(a, b), (b, a)] {
        for i in 0..p.len() {
            let u = p[i];
            let v = p[(i + 1) % p.len()];
            let length = (v.z - u.z).js_hypot(u.x - v.x);
            if length < 1e-12 {
                continue;
            }
            let nx = (v.z - u.z) / length;
            let nz = (u.x - v.x) / length;
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            let mut lo2 = f64::INFINITY;
            let mut hi2 = f64::NEG_INFINITY;
            for w in p {
                let d = nx * w.x + nz * w.z;
                lo = lo.min(d);
                hi = hi.max(d);
            }
            for w in q {
                let d = nx * w.x + nz * w.z;
                lo2 = lo2.min(d);
                hi2 = hi2.max(d);
            }
            if hi < lo2 + 1e-9 || hi2 < lo + 1e-9 {
                return true;
            }
        }
    }
    false
}
fn subtract_triangle(poly: Vec<Point>, tri: &[Point]) -> Vec<Vec<Point>> {
    let edge = |a: Point, b: Point, q: Point| (b.x - a.x) * (q.z - a.z) - (b.z - a.z) * (q.x - a.x);
    let centre = Point {
        x: (tri[0].x + tri[1].x + tri[2].x) / 3.0,
        z: (tri[0].z + tri[1].z + tri[2].z) / 3.0,
    };
    let v = edge(tri[0], tri[1], centre);
    let sign = if v == 0.0 { 0.0 } else { v.signum() };
    if sign == 0.0 || apart(&poly, tri) {
        return vec![poly];
    }
    let mut out = Vec::new();
    let mut rest = poly;
    for k in 0..3 {
        if rest.len() < 3 {
            break;
        }
        let a = tri[k];
        let b = tri[(k + 1) % 3];
        let outside = clip(&rest, |q| -sign * edge(a, b, q));
        if outside.len() >= 3 {
            out.push(outside);
        }
        rest = clip(&rest, |q| sign * edge(a, b, q));
    }
    out
}
fn merge_pieces(mut pieces: Vec<Vec<f64>>) -> Vec<Vec<f64>> {
    let key = |p: &[f64], i: usize| {
        (
            js_round(p[i * 3] * 100.0) as i64,
            js_round(p[i * 3 + 2] * 100.0) as i64,
        )
    };
    let union = |a: &[f64], b: &[f64]| -> Option<Vec<f64>> {
        let n = a.len() / 3;
        let m = b.len() / 3;
        for i in 0..n {
            for j in 0..m {
                if key(a, i) != key(b, (j + 1) % m) || key(a, (i + 1) % n) != key(b, j) {
                    continue;
                }
                let mut out = Vec::new();
                for k in 1..=n {
                    let at = (i + k) % n * 3;
                    out.extend_from_slice(&a[at..at + 3]);
                }
                for k in 2..m {
                    let at = (j + k) % m * 3;
                    out.extend_from_slice(&b[at..at + 3]);
                }
                if out.len() < 9 {
                    return None;
                }
                let pts = points(&out);
                let keys: HashSet<_> = pts
                    .iter()
                    .map(|q| (js_round(q.x * 100.0) as i64, js_round(q.z * 100.0) as i64))
                    .collect();
                return (keys.len() == pts.len() && !self_intersects(&pts)).then_some(out);
            }
        }
        None
    };
    loop {
        let mut merged = false;
        'search: for a in 0..pieces.len() {
            for b in a + 1..pieces.len() {
                if let Some(joined) = union(&pieces[a], &pieces[b]) {
                    pieces[a] = joined;
                    pieces.remove(b);
                    merged = true;
                    break 'search;
                }
            }
        }
        if !merged {
            break;
        }
    }
    pieces
}
pub fn drape_on_terrain(polygons: &[Vec<f64>], h: &[f64], avoid: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let step = TERRAIN_STEP;
    let side = TERRAIN_SIDE;
    let half = LIMIT;
    let mut groups: Vec<(usize, Vec<Vec<f64>>)> = Vec::new();
    let mut group_index = HashMap::new();
    let mut avoided: HashMap<usize, Vec<Vec<Point>>> = HashMap::new();
    for flat in avoid {
        let pts: Vec<_> = flat
            .chunks_exact(3)
            .map(|p| Point {
                x: (p[0] + half) / step,
                z: (p[2] + half) / step,
            })
            .collect();
        for t in ear_clip(&pts) {
            let tri = t.map(|i| pts[i]).to_vec();
            let x0 = tri
                .iter()
                .map(|q| q.x)
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let x1 = tri
                .iter()
                .map(|q| q.x)
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as usize;
            let z0 = tri
                .iter()
                .map(|q| q.z)
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let z1 = tri
                .iter()
                .map(|q| q.z)
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as usize;
            for iz in z0..=z1 {
                for ix in x0..=x1 {
                    avoided.entry(iz * side + ix).or_default().push(tri.clone());
                }
            }
        }
    }
    for flat in polygons {
        let pts = points(flat);
        let parts = if convex(&pts) {
            vec![pts]
        } else {
            ear_clip(&pts)
                .iter()
                .map(|t| t.iter().map(|&i| pts[i]).collect())
                .collect()
        };
        for part in parts {
            let xs = part.iter().map(|p| (p.x + half) / step).collect::<Vec<_>>();
            let zs = part.iter().map(|p| (p.z + half) / step).collect::<Vec<_>>();
            let x0 = xs
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let x1 = xs
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as usize;
            let z0 = zs
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.0) as usize;
            let z1 = zs
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as usize;
            for iz in z0..=z1 {
                for ix in x0..=x1 {
                    for upper in [false, true] {
                        let mut piece = part
                            .iter()
                            .map(|p| Point {
                                x: (p.x + half) / step - ix as f64,
                                z: (p.z + half) / step - iz as f64,
                            })
                            .collect::<Vec<_>>();
                        if upper {
                            piece = clip(&piece, |q| 1.0 - q.x);
                            piece = clip(&piece, |q| 1.0 - q.z);
                            piece = clip(&piece, |q| q.x + q.z - 1.0);
                        } else {
                            piece = clip(&piece, |q| q.x);
                            piece = clip(&piece, |q| q.z);
                            piece = clip(&piece, |q| 1.0 - q.x - q.z);
                        }
                        let i = iz * side + ix;
                        let y = |q: Point| {
                            if upper {
                                h[i + side + 1]
                                    + (1.0 - q.x) * (h[i + side] - h[i + side + 1])
                                    + (1.0 - q.z) * (h[i + 1] - h[i + side + 1])
                            } else {
                                h[i] + q.x * (h[i + 1] - h[i]) + q.z * (h[i + side] - h[i])
                            }
                        };
                        let mut pieces = vec![piece];
                        if let Some(tris) = avoided.get(&i) {
                            for t in tris {
                                let tri = t
                                    .iter()
                                    .map(|q| Point {
                                        x: q.x - ix as f64,
                                        z: q.z - iz as f64,
                                    })
                                    .collect::<Vec<_>>();
                                pieces = pieces
                                    .into_iter()
                                    .flat_map(|p| subtract_triangle(p, &tri))
                                    .collect();
                                if pieces.is_empty() {
                                    break;
                                }
                            }
                        }
                        for sub0 in pieces {
                            let mut sub = sub0
                                .iter()
                                .enumerate()
                                .filter(|(k, q)| {
                                    let r = sub0[(*k + 1) % sub0.len()];
                                    ((r.x - q.x) * step).js_hypot((r.z - q.z) * step) > 1e-6
                                })
                                .map(|(_, &q)| q)
                                .collect::<Vec<_>>();
                            if sub.len() < 3
                                || signed_area(&sub).abs() * step * step
                                    < if avoided.contains_key(&i) { 2e-3 } else { 1e-4 }
                            {
                                continue;
                            }
                            if signed_area(&sub) < 0.0 {
                                sub.reverse();
                            }
                            let id = i * 2 + usize::from(upper);
                            let flat = sub
                                .into_iter()
                                .flat_map(|q| {
                                    [
                                        (q.x + ix as f64) * step - half,
                                        y(q),
                                        (q.z + iz as f64) * step - half,
                                    ]
                                })
                                .collect();
                            let index = *group_index.entry(id).or_insert_with(|| {
                                groups.push((id, Vec::new()));
                                groups.len() - 1
                            });
                            groups[index].1.push(flat);
                        }
                    }
                }
            }
        }
    }
    let mut rings = groups
        .into_iter()
        .flat_map(|(_, p)| merge_pieces(p))
        .collect::<Vec<_>>();
    if !avoid.is_empty() {
        let mut holders: HashMap<(i64, i64), usize> = HashMap::new();
        for ring in &rings {
            for i in (0..ring.len()).step_by(3) {
                *holders.entry(corner_key(ring, i)).or_default() += 1;
            }
        }
        rings.retain(|ring| {
            let mut a = 0.0;
            let mut shared = false;
            for i in (0..ring.len()).step_by(3) {
                let j = (i + 3) % ring.len();
                a += ring[i] * ring[j + 2] - ring[j] * ring[i + 2];
                shared = shared || holders[&corner_key(ring, i)] > 1;
            }
            shared || a.abs() / 2.0 > 1.5
        });
    }
    let mut needed = HashSet::new();
    for ring in &rings {
        each_corner(ring, |key, straight, _| {
            if !straight {
                needed.insert(key);
            }
        });
    }
    let trimmed = rings
        .iter()
        .map(|ring| {
            let mut out = Vec::new();
            each_corner(ring, |key, _, i| {
                if needed.contains(&key) {
                    out.extend_from_slice(&ring[i..i + 3]);
                }
            });
            out
        })
        .collect();
    close_t_junctions(weld_corners(trimmed, &mut Seen::new()), None)
}

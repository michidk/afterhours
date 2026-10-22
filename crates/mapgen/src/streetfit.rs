//! Line-for-line port of `mapgen/streetfit.ts`, including surface sealing.
use crate::js_math::JsMath;
use crate::{
    geom::{
        add, closest_on_segment, cross, dist, mul, point_in_polygon, self_intersects, signed_area,
        sub,
    },
    types::{Point, RoadEdge, RoadGeometry, RoadGraph},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TerrainGrid {
    pub heights: Vec<f32>,
    pub side: usize,
    pub step: f64,
    pub half: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreetLayer {
    pub polygons: Vec<Vec<f64>>,
    pub top: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreetPad {
    pub x: f64,
    pub z: f64,
    pub w: f64,
    pub d: f64,
    pub y: Option<f64>,
    pub angle: Option<f64>,
}
pub fn edge_height_at(e: &RoadEdge, p: Point) -> f64 {
    let mut best = f64::INFINITY;
    let mut y = e.heights.first().copied().unwrap_or(0.);
    for i in 1..e.points.len() {
        let (point, t) = closest_on_segment(p, e.points[i - 1], e.points[i]);
        let d = dist(point, p);
        if d < best {
            best = d;
            y = e.heights[i - 1] + (e.heights[i] - e.heights[i - 1]) * t;
        }
    }
    y
}
// Same ear order, duplicate handling, guard, and fallback as shared/polygon.ts.
fn ear_clip(poly: &[Point]) -> Vec<[usize; 3]> {
    let n = poly.len();
    if n < 3 {
        return vec![];
    }
    let mut idx: Vec<_> = (0..n).collect();
    if signed_area(poly) < 0. {
        idx.reverse();
    }
    let mut tris = Vec::new();
    let same = |p: Point, q: Point| (p.x - q.x).abs() < 1e-6 && (p.z - q.z).abs() < 1e-6;
    let in_triangle = |p: Point, a: Point, b: Point, c: Point| {
        cross(sub(b, a), sub(p, a)) >= -1e-9
            && cross(sub(c, b), sub(p, b)) >= -1e-9
            && cross(sub(a, c), sub(p, c)) >= -1e-9
    };
    let mut guard = 0;
    while idx.len() > 3 && guard < n * n {
        guard += 1;
        let mut clipped = false;
        for i in 0..idx.len() {
            let ia = idx[(i + idx.len() - 1) % idx.len()];
            let ib = idx[i];
            let ic = idx[(i + 1) % idx.len()];
            let (a, b, c) = (poly[ia], poly[ib], poly[ic]);
            if cross(sub(b, a), sub(c, b)) <= 1e-9 {
                continue;
            }
            let mut blocked = false;
            for &j in &idx {
                if j == ia || j == ib || j == ic {
                    continue;
                }
                let p = poly[j];
                if same(p, a) || same(p, b) || same(p, c) {
                    continue;
                }
                if in_triangle(p, a, b, c) {
                    blocked = true;
                    break;
                }
            }
            if blocked {
                continue;
            }
            tris.push([ia, ib, ic]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    for i in 1..idx.len() - 1 {
        tris.push([idx[0], idx[i], idx[i + 1]]);
    }
    tris
}
#[derive(Clone, Copy)]
struct Vertex {
    x: f64,
    y: f64,
    z: f64,
}
pub fn sink_under_streets(grid: &mut TerrainGrid, layers: &[StreetLayer], pads: &[StreetPad]) {
    let heights = &mut grid.heights;
    let clearance = 0.06;
    let mut corners = Vec::new();
    let mut weights = Vec::new();
    let mut limits = Vec::new();
    let mut give = vec![1_f32; heights.len()];
    let mut constrain = |x: f64, z: f64, y: f64| {
        let gx = (x + grid.half) / grid.step;
        let gz = (z + grid.half) / grid.step;
        if gx < 0. || gz < 0. || gx > (grid.side - 1) as f64 || gz > (grid.side - 1) as f64 {
            return;
        }
        let ix = gx.floor().min((grid.side - 2) as f64) as usize;
        let iz = gz.floor().min((grid.side - 2) as f64) as usize;
        let u = gx - ix as f64;
        let v = gz - iz as f64;
        let i = iz * grid.side + ix;
        if u + v <= 1. {
            corners.extend([i, i + 1, i + grid.side]);
            weights.extend([1. - u - v, u, v]);
        } else {
            corners.extend([i + grid.side + 1, i + grid.side, i + 1]);
            weights.extend([u + v - 1., 1. - u, 1. - v]);
        }
        limits.push(y - clearance);
    };
    for StreetLayer { polygons, top } in layers {
        for flat in polygons {
            let p: Vec<_> = flat
                .as_chunks::<3>()
                .0
                .iter()
                .map(|v| Vertex {
                    x: v[0],
                    y: v[1] + top,
                    z: v[2],
                })
                .collect();
            let points: Vec<_> = p.iter().map(|p| Point { x: p.x, z: p.z }).collect();
            for [a, b, c] in ear_clip(&points) {
                let (a, b, c) = (p[a], p[b], p[c]);
                let x0 = ((a.x.min(b.x).min(c.x) + grid.half) / grid.step)
                    .floor()
                    .max(0.) as i64;
                let x1 = ((a.x.max(b.x).max(c.x) + grid.half) / grid.step)
                    .ceil()
                    .min((grid.side - 1) as f64) as i64;
                let z0 = ((a.z.min(b.z).min(c.z) + grid.half) / grid.step)
                    .floor()
                    .max(0.) as i64;
                let z1 = ((a.z.max(b.z).max(c.z) + grid.half) / grid.step)
                    .ceil()
                    .min((grid.side - 1) as f64) as i64;
                let side = |p: Point, q: Vertex, r: Vertex| {
                    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
                };
                for gz in z0..=z1 {
                    for gx in x0..=x1 {
                        let g = Point {
                            x: gx as f64 * grid.step - grid.half,
                            z: gz as f64 * grid.step - grid.half,
                        };
                        let s1 = side(g, a, b);
                        let s2 = side(g, b, c);
                        let s3 = side(g, c, a);
                        let total = s1 + s2 + s3;
                        if total.abs() < 1e-9
                            || !((s1 >= 0. && s2 >= 0. && s3 >= 0.)
                                || (s1 <= 0. && s2 <= 0. && s3 <= 0.))
                        {
                            continue;
                        }
                        give[gz as usize * grid.side + gx as usize] = 1e-4;
                        constrain(g.x, g.z, (c.y * s1 + a.y * s2 + b.y * s3) / total);
                    }
                }
                for p in [a, b, c] {
                    constrain(p.x, p.z, p.y);
                }
                for (p, q) in [(a, b), (b, c), (c, a)] {
                    let (px, pz) = ((p.x + grid.half) / grid.step, (p.z + grid.half) / grid.step);
                    let (qx, qz) = ((q.x + grid.half) / grid.step, (q.z + grid.half) / grid.step);
                    for (from, to) in [(px, qx), (pz, qz), (px + pz, qx + qz)] {
                        for k in from.min(to).ceil() as i64..=from.max(to).floor() as i64 {
                            let t = (k as f64 - from) / (to - from);
                            if t > 0. && t < 1. {
                                constrain(
                                    p.x + (q.x - p.x) * t,
                                    p.z + (q.z - p.z) * t,
                                    p.y + (q.y - p.y) * t,
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let mut floor = vec![f32::INFINITY; heights.len()];
    for (k, &limit) in limits.iter().enumerate() {
        for m in 0..3 {
            let v = corners[k * 3 + m];
            floor[v] = f64::from(floor[v]).min(limit - 0.5) as f32;
        }
    }
    for b in pads {
        let c = b.angle.unwrap_or(0.).js_cos();
        let s = b.angle.unwrap_or(0.).js_sin();
        let reach = b.w.js_hypot(b.d) / 2. + 2.;
        let z0 = ((b.z - reach + grid.half) / grid.step).floor().max(0.) as i64;
        let z1 = ((b.z + reach + grid.half) / grid.step)
            .ceil()
            .min((grid.side - 1) as f64) as i64;
        let x0 = ((b.x - reach + grid.half) / grid.step).floor().max(0.) as i64;
        let x1 = ((b.x + reach + grid.half) / grid.step)
            .ceil()
            .min((grid.side - 1) as f64) as i64;
        for gz in z0..=z1 {
            for gx in x0..=x1 {
                let dx = gx as f64 * grid.step - grid.half - b.x;
                let dz = gz as f64 * grid.step - grid.half - b.z;
                if (dx * c + dz * s).abs() > b.w / 2. + 2.
                    || (-dx * s + dz * c).abs() > b.d / 2. + 2.
                {
                    continue;
                }
                let v = gz as usize * grid.side + gx as usize;
                give[v] = 1e-4;
                floor[v] =
                    f64::from(floor[v]).min(b.y.unwrap_or(f64::from(heights[v])) - 0.3) as f32;
            }
        }
    }
    for v in 0..heights.len() {
        floor[v] = floor[v].min(heights[v]);
    }
    let sag_limit = 0.35;
    let raise = 200;
    for pass in 0..raise + 400 {
        let mut worst: f64 = 0.;
        let mut sag: f64 = 0.;
        for (k, &limit) in limits.iter().enumerate() {
            let c = k * 3;
            let mut h = 0.;
            let mut norm = 0.;
            let mut free = 0.;
            let mut free_norm = 0.;
            for m in 0..3 {
                let v = corners[c + m];
                let w = weights[c + m];
                h += w * f64::from(heights[v]);
                if heights[v] > floor[v] {
                    norm += f64::from(give[v]) * w.powi(2);
                }
                if give[v] == 1. {
                    free += w;
                    free_norm += w.powi(2);
                }
            }
            let excess = h - limit;
            if excess > 0. {
                if norm <= 0. {
                    continue;
                }
                worst = worst.max(excess);
                for m in 0..3 {
                    let v = corners[c + m];
                    if heights[v] > floor[v] {
                        heights[v] = f64::from(floor[v]).max(
                            f64::from(heights[v])
                                - (f64::from(give[v]) * weights[c + m] * excess) / norm,
                        ) as f32;
                    }
                }
                continue;
            }
            let deficit = -excess - sag_limit;
            if pass >= raise || deficit <= 0. || free < 0.15 {
                continue;
            }
            sag = sag.max(deficit);
            for m in 0..3 {
                let v = corners[c + m];
                if give[v] == 1. {
                    heights[v] =
                        (f64::from(heights[v]) + (weights[c + m] * deficit) / free_norm) as f32;
                }
            }
        }
        if worst < 0.002 && (pass >= raise || sag < 0.01) {
            break;
        }
    }
}

pub fn drape_on_terrain(
    polygons: &[Vec<f64>],
    grid: &TerrainGrid,
    avoid: &[Vec<f64>],
) -> Vec<Vec<f64>> {
    // JS Map iteration follows first insertion, which determines the merge order.
    let mut groups: Vec<(usize, Vec<Vec<f64>>)> = Vec::new();
    let mut group_index = HashMap::new();
    let TerrainGrid {
        step,
        side,
        half,
        heights: h,
    } = grid;
    let (step, side, half) = (*step, *side, *half);
    let mut avoided: HashMap<usize, Vec<Vec<Point>>> = HashMap::new();
    for flat in avoid {
        let points: Vec<_> = flat
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| Point {
                x: (p[0] + half) / step,
                z: (p[2] + half) / step,
            })
            .collect();
        for t in ear_clip(&points) {
            let tri: Vec<_> = t.iter().map(|&i| points[i]).collect();
            let z0 = tri
                .iter()
                .map(|q| q.z)
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.) as i64;
            let z1 = tri
                .iter()
                .map(|q| q.z)
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as i64;
            let x0 = tri
                .iter()
                .map(|q| q.x)
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.) as i64;
            let x1 = tri
                .iter()
                .map(|q| q.x)
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as i64;
            for iz in z0..=z1 {
                for ix in x0..=x1 {
                    let k = iz as usize * side + ix as usize;
                    avoided.entry(k).or_default().push(tri.clone());
                }
            }
        }
    }
    for flat in polygons {
        let points: Vec<_> = flat
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| Point { x: p[0], z: p[2] })
            .collect();
        let parts = if convex(&points) {
            vec![points]
        } else {
            ear_clip(&points)
                .iter()
                .map(|t| t.iter().map(|&i| points[i]).collect())
                .collect()
        };
        for part in parts {
            let xs: Vec<_> = part.iter().map(|p| (p.x + half) / step).collect();
            let zs: Vec<_> = part.iter().map(|p| (p.z + half) / step).collect();
            let x0 = xs
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.) as i64;
            let x1 = xs
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as i64;
            let z0 = zs
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
                .floor()
                .max(0.) as i64;
            let z1 = zs
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max)
                .floor()
                .min((side - 2) as f64) as i64;
            for iz in z0..=z1 {
                for ix in x0..=x1 {
                    for upper in [false, true] {
                        let mut piece: Vec<_> = part
                            .iter()
                            .map(|p| Point {
                                x: (p.x + half) / step - ix as f64,
                                z: (p.z + half) / step - iz as f64,
                            })
                            .collect();
                        if upper {
                            piece = clip(&piece, |q| 1. - q.x);
                            piece = clip(&piece, |q| 1. - q.z);
                            piece = clip(&piece, |q| q.x + q.z - 1.);
                        } else {
                            piece = clip(&piece, |q| q.x);
                            piece = clip(&piece, |q| q.z);
                            piece = clip(&piece, |q| 1. - q.x - q.z);
                        }
                        let i = iz as usize * side + ix as usize;
                        let y = |q: Point| {
                            if upper {
                                f64::from(h[i + side + 1])
                                    + (1. - q.x)
                                        * (f64::from(h[i + side]) - f64::from(h[i + side + 1]))
                                    + (1. - q.z)
                                        * (f64::from(h[i + 1]) - f64::from(h[i + side + 1]))
                            } else {
                                f64::from(h[i])
                                    + q.x * (f64::from(h[i + 1]) - f64::from(h[i]))
                                    + q.z * (f64::from(h[i + side]) - f64::from(h[i]))
                            }
                        };
                        let mut pieces = vec![piece];
                        for t in avoided.get(&i).into_iter().flatten() {
                            let triangle: Vec<_> = t
                                .iter()
                                .map(|q| Point {
                                    x: q.x - ix as f64,
                                    z: q.z - iz as f64,
                                })
                                .collect();
                            pieces = pieces
                                .into_iter()
                                .flat_map(|p| subtract_triangle(&p, &triangle))
                                .collect();
                            if pieces.is_empty() {
                                break;
                            }
                        }
                        for sub in pieces {
                            let mut sub: Vec<_> = sub
                                .iter()
                                .enumerate()
                                .filter_map(|(k, &q)| {
                                    let r = sub[(k + 1) % sub.len()];
                                    (((r.x - q.x) * step).js_hypot((r.z - q.z) * step) > 1e-6)
                                        .then_some(q)
                                })
                                .collect();
                            if sub.len() < 3
                                || signed_area(&sub).abs() * step * step
                                    < if avoided.contains_key(&i) { 2e-3 } else { 1e-4 }
                            {
                                continue;
                            }
                            if signed_area(&sub) < 0. {
                                sub.reverse();
                            }
                            let id = i * 2 + usize::from(upper);
                            let flat = sub
                                .iter()
                                .flat_map(|&q| {
                                    [
                                        (q.x + ix as f64) * step - half,
                                        y(q),
                                        (q.z + iz as f64) * step - half,
                                    ]
                                })
                                .collect();
                            let index = *group_index.entry(id).or_insert_with(|| {
                                let index = groups.len();
                                groups.push((id, Vec::new()));
                                index
                            });
                            groups[index].1.push(flat);
                        }
                    }
                }
            }
        }
    }
    let mut rings: Vec<_> = groups
        .into_iter()
        .flat_map(|(_, pieces)| merge_pieces(pieces))
        .collect();
    if !avoid.is_empty() {
        let mut holders: HashMap<_, usize> = HashMap::new();
        for ring in &rings {
            for i in (0..ring.len()).step_by(3) {
                *holders.entry(corner_key(ring, i)).or_default() += 1;
            }
        }
        rings.retain(|ring| {
            let mut area = 0.;
            let mut shared = false;
            for i in (0..ring.len()).step_by(3) {
                let j = (i + 3) % ring.len();
                area += ring[i] * ring[j + 2] - ring[j] * ring[i + 2];
                shared |= holders[&corner_key(ring, i)] > 1;
            }
            shared || area.abs() / 2. > 1.5
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
    let rings: Vec<_> = rings
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
    close_t_junctions(&weld_corners(&rings), None)
}
type WeldMap = HashMap<(i64, i64), Vec<(f64, f64)>>;
pub fn weld_corners(rings: &[Vec<f64>]) -> Vec<Vec<f64>> {
    weld_corners_with_seen(rings, &mut HashMap::new())
}
fn weld_corners_with_seen(rings: &[Vec<f64>], seen: &mut WeldMap) -> Vec<Vec<f64>> {
    let tolerance = 0.05;
    let cell = 0.05;
    let mut result = Vec::new();
    for ring in rings {
        let mut out: Vec<f64> = Vec::new();
        for i in (0..ring.len()).step_by(3) {
            let cx = (ring[i] / cell).floor() as i64;
            let cz = (ring[i + 2] / cell).floor() as i64;
            let mut at = None;
            'search: for dx in -1..=1 {
                for dz in -1..=1 {
                    if let Some(c) = seen.get(&(cx + dx, cz + dz)).and_then(|list| {
                        list.iter()
                            .find(|c| (c.0 - ring[i]).js_hypot(c.1 - ring[i + 2]) <= tolerance)
                    }) {
                        at = Some(*c);
                        break 'search;
                    }
                }
            }
            let (x, z) = at.unwrap_or((ring[i], ring[i + 2]));
            if at.is_none() {
                seen.entry((cx, cz)).or_default().push((x, z));
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
pub fn close_t_junctions(rings: &[Vec<f64>], layers: Option<&[usize]>) -> Vec<Vec<f64>> {
    let cell = 2.;
    type LayerCorner = ([f64; 3], usize);
    let mut corners: HashMap<(i64, i64), Vec<LayerCorner>> = HashMap::new();
    for (r, ring) in rings.iter().enumerate() {
        for i in (0..ring.len()).step_by(3) {
            let k = (
                (ring[i] / cell).floor() as i64,
                (ring[i + 2] / cell).floor() as i64,
            );
            corners.entry(k).or_default().push((
                [ring[i], ring[i + 1], ring[i + 2]],
                layers.map_or(0, |l| l[r]),
            ));
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
                let mut found_index = HashMap::new();
                for cx in
                    (a[0].min(b[0]) / cell).floor() as i64..=(a[0].max(b[0]) / cell).floor() as i64
                {
                    for cz in (a[2].min(b[2]) / cell).floor() as i64
                        ..=(a[2].max(b[2]) / cell).floor() as i64
                    {
                        for &(c, layer) in corners.get(&(cx, cz)).into_iter().flatten() {
                            if layer < layers.map_or(0, |l| l[r]) {
                                continue;
                            }
                            let t = ((c[0] - a[0]) * ux + (c[2] - a[2]) * uz) / length.powi(2);
                            if t * length < 0.01 || (1. - t) * length < 0.01 {
                                continue;
                            }
                            if ((c[0] - a[0]) * uz - (c[2] - a[2]) * ux).abs() / length > 0.09 {
                                continue;
                            }
                            let key = corner_key(&c, 0);
                            let index = *found_index.entry(key).or_insert_with(|| {
                                let index = found.len();
                                found.push((key, t, c));
                                index
                            });
                            found[index] = (key, t, c);
                        }
                    }
                }
                found.sort_by(|p, q| p.1.partial_cmp(&q.1).unwrap());
                for (_, _, corner) in found {
                    out.extend(corner);
                }
            }
            out
        })
        .collect()
}
pub fn seal_surfaces(layers: &[Vec<Vec<f64>>]) -> Vec<Vec<Vec<f64>>> {
    let split = |rings: Vec<Vec<f64>>, counts: Vec<usize>| {
        let mut at = 0;
        counts
            .iter()
            .map(|&n| {
                let layer = rings[at..at + n].to_vec();
                at += n;
                layer
            })
            .collect::<Vec<_>>()
    };
    let tags = |list: &[Vec<Vec<f64>>]| {
        list.iter()
            .enumerate()
            .flat_map(|(index, layer)| vec![index; layer.len()])
            .collect::<Vec<_>>()
    };
    let closed = split(
        close_t_junctions(&layers.concat(), Some(&tags(layers))),
        layers.iter().map(Vec::len).collect(),
    );
    let mut seen = HashMap::new();
    let welded: Vec<_> = closed
        .iter()
        .map(|layer| weld_corners_with_seen(layer, &mut seen))
        .collect();
    split(
        close_t_junctions(&welded.concat(), Some(&tags(&welded))),
        welded.iter().map(Vec::len).collect(),
    )
}
fn merge_pieces(mut pieces: Vec<Vec<f64>>) -> Vec<Vec<f64>> {
    let key = |f: &[f64], i: usize| {
        (
            js_round(f[i * 3] * 100.) as i64,
            js_round(f[i * 3 + 2] * 100.) as i64,
        )
    };
    let union = |a: &[f64], b: &[f64]| {
        let n = a.len() / 3;
        let m = b.len() / 3;
        for i in 0..n {
            for j in 0..m {
                if key(a, i) != key(b, (j + 1) % m) || key(a, (i + 1) % n) != key(b, j) {
                    continue;
                }
                let mut out = Vec::new();
                for k in 1..=n {
                    let at = ((i + k) % n) * 3;
                    out.extend_from_slice(&a[at..at + 3]);
                }
                for k in 2..m {
                    let at = ((j + k) % m) * 3;
                    out.extend_from_slice(&b[at..at + 3]);
                }
                if out.len() < 9 {
                    return None;
                }
                let points: Vec<_> = out
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .map(|p| Point { x: p[0], z: p[2] })
                    .collect();
                let keys: HashSet<_> = points
                    .iter()
                    .map(|q| (js_round(q.x * 100.) as i64, js_round(q.z * 100.) as i64))
                    .collect();
                return if keys.len() == points.len() && !self_intersects(&points) {
                    Some(out)
                } else {
                    None
                };
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
// Math.round chooses the upper integer at ties, including negative values.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}
pub fn snap_cm(v: f64) -> f64 {
    js_round(v * 100. + 1e-4) / 100. + 0.
}
fn corner_key(flat: &[f64], i: usize) -> (i64, i64) {
    (
        js_round(snap_cm(flat[i]) * 100.) as i64,
        js_round(snap_cm(flat[i + 2]) * 100.) as i64,
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
fn apart(a: &[Point], b: &[Point]) -> bool {
    let eps = 1e-9;
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
            if hi < lo2 + eps || hi2 < lo + eps {
                return true;
            }
        }
    }
    false
}
fn subtract_triangle(polygon: &[Point], tri: &[Point]) -> Vec<Vec<Point>> {
    let edge = |a: Point, b: Point, q: Point| (b.x - a.x) * (q.z - a.z) - (b.z - a.z) * (q.x - a.x);
    let centre = Point {
        x: (tri[0].x + tri[1].x + tri[2].x) / 3.,
        z: (tri[0].z + tri[1].z + tri[2].z) / 3.,
    };
    let value = edge(tri[0], tri[1], centre);
    let sign = if value == 0. { 0. } else { value.signum() };
    if sign == 0. || apart(polygon, tri) {
        return vec![polygon.to_vec()];
    }
    let mut out = Vec::new();
    let mut rest = polygon.to_vec();
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
fn clip(polygon: &[Point], inside: impl Fn(Point) -> f64) -> Vec<Point> {
    let mut out = Vec::new();
    for i in 0..polygon.len() {
        let a = polygon[i];
        let b = polygon[(i + 1) % polygon.len()];
        let da = inside(a);
        let db = inside(b);
        if da >= 0. {
            out.push(a);
        }
        if (da >= 0.) != (db >= 0.) {
            let t = da / (da - db);
            out.push(Point {
                x: a.x + (b.x - a.x) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    out
}
fn convex(polygon: &[Point]) -> bool {
    let mut sign = 0.;
    for i in 0..polygon.len() {
        let a = polygon[i];
        let b = polygon[(i + 1) % polygon.len()];
        let c = polygon[(i + 2) % polygon.len()];
        let turn = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
        if turn.abs() < 1e-9 {
            continue;
        }
        if sign != 0. && turn.signum() != sign {
            return false;
        }
        sign = turn.signum();
    }
    true
}
pub fn street_polygons(
    graph: &RoadGraph,
    geometry: &RoadGeometry,
) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let mut asphalt = Vec::new();
    let mut sidewalks = Vec::new();
    fn flat(points: &[Point], y: impl Fn(Point) -> f64) -> Vec<f64> {
        points.iter().flat_map(|&p| [p.x, y(p), p.z]).collect()
    }
    let quads = |polygon: &[Point], e: &RoadEdge, out: &mut Vec<Vec<f64>>| {
        let n = polygon.len() / 2;
        if !polygon.len().is_multiple_of(2) || n < 2 {
            out.push(flat(polygon, |p| edge_height_at(e, p)));
            return;
        }
        for i in 1..n {
            let mut quad = vec![
                polygon[i - 1],
                polygon[i],
                polygon[2 * n - 1 - i],
                polygon[2 * n - i],
            ];
            if self_intersects(&quad) {
                let c = mul(quad.iter().copied().fold(Point { x: 0., z: 0. }, add), 0.25);
                quad.sort_by(|a, b| {
                    (a.z - c.z)
                        .js_atan2(a.x - c.x)
                        .partial_cmp(&(b.z - c.z).js_atan2(b.x - c.x))
                        .unwrap()
                });
            }
            out.push(flat(&quad, |p| edge_height_at(e, p)));
        }
    };
    for band in &geometry.bands {
        quads(&band.polygon, &graph.edges[band.edge], &mut asphalt);
    }
    for j in &geometry.junctions {
        asphalt.push(flat(&j.polygon, |_| graph.nodes[j.node].y));
    }
    for s in &geometry.sidewalks {
        if let Some(node) = s.node {
            sidewalks.push(flat(&s.polygon, |_| graph.nodes[node].y));
        } else {
            quads(&s.polygon, &graph.edges[s.edge.unwrap()], &mut sidewalks);
        }
    }
    (asphalt, sidewalks)
}
pub fn street_test(geometry: &RoadGeometry, margin: f64) -> impl Fn(Point) -> bool + '_ {
    let cell = 32.;
    let mut grid: HashMap<(i64, i64), Vec<&[Point]>> = HashMap::new();
    for polygon in geometry
        .bands
        .iter()
        .map(|b| &b.polygon)
        .chain(geometry.junctions.iter().map(|j| &j.polygon))
    {
        let mut x0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        let mut z0 = f64::INFINITY;
        let mut z1 = f64::NEG_INFINITY;
        for p in polygon {
            x0 = x0.min(p.x);
            x1 = x1.max(p.x);
            z0 = z0.min(p.z);
            z1 = z1.max(p.z);
        }
        for x in ((x0 - margin) / cell).floor() as i64..=((x1 + margin) / cell).floor() as i64 {
            for z in ((z0 - margin) / cell).floor() as i64..=((z1 + margin) / cell).floor() as i64 {
                grid.entry((x, z)).or_default().push(polygon);
            }
        }
    }
    move |p| {
        [
            p,
            Point {
                x: p.x + margin,
                z: p.z,
            },
            Point {
                x: p.x - margin,
                z: p.z,
            },
            Point {
                x: p.x,
                z: p.z + margin,
            },
            Point {
                x: p.x,
                z: p.z - margin,
            },
        ]
        .iter()
        .any(|&q| {
            grid.get(&((q.x / cell).floor() as i64, (q.z / cell).floor() as i64))
                .into_iter()
                .flatten()
                .any(|polygon| point_in_polygon(q, polygon))
        })
    }
}

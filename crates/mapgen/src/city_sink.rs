#![allow(clippy::chunks_exact_to_as_chunks)]
//! Terrain/surface constraint solver from `mapgen/streetfit.ts`.
use crate::{city_types::Building, geom::ear_clip, types::Point};

pub type Pad = Building;

/// Clear terrain triangles below every street sample, preserving pad heights and
/// the original Float32Array storage for the solver's give and floor fields.
pub fn sink_under_streets(
    heights: &mut [f64],
    side: usize,
    step: f64,
    half: f64,
    layers: &[(&[Vec<f64>], f64)],
    pads: &[Pad],
) {
    const CLEARANCE: f64 = 0.06;
    let mut corners: Vec<usize> = Vec::new();
    let mut weights: Vec<f64> = Vec::new();
    let mut limits: Vec<f64> = Vec::new();
    let mut give = vec![1.0_f32; heights.len()];
    let mut constrain = |x: f64, z: f64, y: f64| {
        let gx = (x + half) / step;
        let gz = (z + half) / step;
        if gx < 0.0 || gz < 0.0 || gx > (side - 1) as f64 || gz > (side - 1) as f64 {
            return;
        }
        let ix = (gx.floor() as usize).min(side - 2);
        let iz = (gz.floor() as usize).min(side - 2);
        let u = gx - ix as f64;
        let v = gz - iz as f64;
        let i = iz * side + ix;
        if u + v <= 1.0 {
            corners.extend([i, i + 1, i + side]);
            weights.extend([1.0 - u - v, u, v]);
        } else {
            corners.extend([i + side + 1, i + side, i + 1]);
            weights.extend([u + v - 1.0, 1.0 - u, 1.0 - v]);
        }
        limits.push(y - CLEARANCE);
    };
    #[derive(Clone, Copy)]
    struct Vertex {
        x: f64,
        y: f64,
        z: f64,
    }
    for (polygons, top) in layers {
        for flat in *polygons {
            let p: Vec<Vertex> = flat
                .chunks_exact(3)
                .map(|q| Vertex {
                    x: q[0],
                    y: q[1] + top,
                    z: q[2],
                })
                .collect();
            let ring: Vec<Point> = p.iter().map(|q| Point { x: q.x, z: q.z }).collect();
            for [a, b, c] in ear_clip(&ring) {
                let a = p[a];
                let b = p[b];
                let c = p[c];
                let x0 = ((a.x.min(b.x).min(c.x) + half) / step).floor().max(0.0) as usize;
                let x1 = ((a.x.max(b.x).max(c.x) + half) / step)
                    .ceil()
                    .min((side - 1) as f64) as usize;
                let z0 = ((a.z.min(b.z).min(c.z) + half) / step).floor().max(0.0) as usize;
                let z1 = ((a.z.max(b.z).max(c.z) + half) / step)
                    .ceil()
                    .min((side - 1) as f64) as usize;
                let side_of = |p: Point, q: Vertex, r: Vertex| {
                    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
                };
                for gz in z0..=z1 {
                    for gx in x0..=x1 {
                        let g = Point {
                            x: gx as f64 * step - half,
                            z: gz as f64 * step - half,
                        };
                        let s1 = side_of(g, a, b);
                        let s2 = side_of(g, b, c);
                        let s3 = side_of(g, c, a);
                        let total = s1 + s2 + s3;
                        if total.abs() < 1e-9
                            || !((s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0)
                                || (s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0))
                        {
                            continue;
                        }
                        give[gz * side + gx] = 1e-4;
                        constrain(g.x, g.z, (c.y * s1 + a.y * s2 + b.y * s3) / total);
                    }
                }
                for p in [a, b, c] {
                    constrain(p.x, p.z, p.y);
                }
                for (p, q) in [(a, b), (b, c), (c, a)] {
                    let px = (p.x + half) / step;
                    let pz = (p.z + half) / step;
                    let qx = (q.x + half) / step;
                    let qz = (q.z + half) / step;
                    for (from, to) in [(px, qx), (pz, qz), (px + pz, qx + qz)] {
                        let mut k = from.min(to).ceil();
                        while k <= from.max(to).floor() {
                            let t = (k - from) / (to - from);
                            if t > 0.0 && t < 1.0 {
                                constrain(
                                    p.x + (q.x - p.x) * t,
                                    p.z + (q.z - p.z) * t,
                                    p.y + (q.y - p.y) * t,
                                );
                            }
                            k += 1.0;
                        }
                    }
                }
            }
        }
    }
    let mut floor = vec![f32::INFINITY; heights.len()];
    for k in 0..limits.len() {
        for m in 0..3 {
            let v = corners[k * 3 + m];
            floor[v] = (f64::from(floor[v]).min(limits[k] - 0.5)) as f32;
        }
    }
    for b in pads {
        let c = b.angle.unwrap_or(0.0).cos();
        let s = b.angle.unwrap_or(0.0).sin();
        let reach = b.w.hypot(b.d) / 2.0 + 2.0;
        let z0 = ((b.z - reach + half) / step).floor().max(0.0) as usize;
        let z1 = ((b.z + reach + half) / step).ceil().min((side - 1) as f64) as usize;
        let x0 = ((b.x - reach + half) / step).floor().max(0.0) as usize;
        let x1 = ((b.x + reach + half) / step).ceil().min((side - 1) as f64) as usize;
        for gz in z0..=z1 {
            for gx in x0..=x1 {
                let dx = gx as f64 * step - half - b.x;
                let dz = gz as f64 * step - half - b.z;
                if (dx * c + dz * s).abs() > b.w / 2.0 + 2.0
                    || (-dx * s + dz * c).abs() > b.d / 2.0 + 2.0
                {
                    continue;
                }
                let v = gz * side + gx;
                give[v] = 1e-4;
                floor[v] = f64::from(floor[v]).min(b.y.unwrap_or(heights[v]) - 0.3) as f32;
            }
        }
    }
    for v in 0..heights.len() {
        floor[v] = f64::from(floor[v]).min(heights[v]) as f32;
    }
    const SAG: f64 = 0.35;
    const RAISE: usize = 200;
    for pass in 0..RAISE + 400 {
        let mut worst: f64 = 0.0;
        let mut sag: f64 = 0.0;
        for (k, limit) in limits.iter().enumerate() {
            let c = k * 3;
            let (mut h, mut norm, mut free, mut free_norm) = (0.0, 0.0, 0.0, 0.0);
            for m in 0..3 {
                let v = corners[c + m];
                let w = weights[c + m];
                h += w * heights[v];
                if heights[v] > f64::from(floor[v]) {
                    norm += f64::from(give[v]) * w.powi(2);
                }
                if give[v] == 1.0 {
                    free += w;
                    free_norm += w.powi(2);
                }
            }
            let excess = h - limit;
            if excess > 0.0 {
                if norm <= 0.0 {
                    continue;
                }
                worst = worst.max(excess);
                for m in 0..3 {
                    let v = corners[c + m];
                    if heights[v] > f64::from(floor[v]) {
                        heights[v] = f64::from(floor[v]).max(
                            heights[v] - (f64::from(give[v]) * weights[c + m] * excess) / norm,
                        );
                    }
                }
                continue;
            }
            let deficit = -excess - SAG;
            if pass >= RAISE || deficit <= 0.0 || free < 0.15 {
                continue;
            }
            sag = sag.max(deficit);
            for m in 0..3 {
                let v = corners[c + m];
                if give[v] == 1.0 {
                    heights[v] += (weights[c + m] * deficit) / free_norm;
                }
            }
        }
        if worst < 0.002 && (pass >= RAISE || sag < 0.01) {
            break;
        }
    }
}

//! Small f64 geometry primitives shared by map-generation stages.

pub use crate::types::Point;

pub fn dist(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.z - b.z)
}

pub fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        z: a.z - b.z,
    }
}
pub fn add(a: Point, b: Point) -> Point {
    Point {
        x: a.x + b.x,
        z: a.z + b.z,
    }
}
pub fn mul(a: Point, s: f64) -> Point {
    Point {
        x: a.x * s,
        z: a.z * s,
    }
}
pub fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.z * b.z
}
pub fn cross(a: Point, b: Point) -> f64 {
    a.x * b.z - a.z * b.x
}
pub fn len(a: Point) -> f64 {
    a.x.hypot(a.z)
}
pub fn norm(a: Point) -> Point {
    let l = len(a);
    if l == 0.0 {
        Point { x: 0.0, z: 0.0 }
    } else {
        mul(a, 1.0 / l)
    }
}
pub fn perp(a: Point) -> Point {
    Point { x: -a.z, z: a.x }
}
pub fn lerp(a: Point, b: Point, t: f64) -> Point {
    add(a, mul(sub(b, a), t))
}

pub fn signed_area(poly: &[Point]) -> f64 {
    if poly.is_empty() {
        return 0.0;
    }
    poly.iter()
        .enumerate()
        .map(|(i, &p)| cross(poly[(i + poly.len() - 1) % poly.len()], p))
        .sum::<f64>()
        / 2.0
}
pub fn area(poly: &[Point]) -> f64 {
    signed_area(poly).abs()
}
pub fn polyline_length(points: &[Point]) -> f64 {
    points.windows(2).map(|p| dist(p[0], p[1])).sum()
}
pub fn line_intersection(p: Point, r: Point, q: Point, s: Point) -> Option<Point> {
    let d = cross(r, s);
    if d.abs() < 1e-9 {
        None
    } else {
        Some(add(p, mul(r, cross(sub(q, p), s) / d)))
    }
}
pub fn segment_intersection(a: Point, b: Point, c: Point, d: Point) -> Option<(f64, f64)> {
    let r = sub(b, a);
    let s = sub(d, c);
    let den = cross(r, s);
    if den.abs() < 1e-9 {
        return None;
    }
    let qp = sub(c, a);
    let t = cross(qp, s) / den;
    let u = cross(qp, r) / den;
    if !(-1e-9..=1.0 + 1e-9).contains(&t) || !(-1e-9..=1.0 + 1e-9).contains(&u) {
        None
    } else {
        Some((t.clamp(0.0, 1.0), u.clamp(0.0, 1.0)))
    }
}
pub fn closest_on_segment(p: Point, a: Point, b: Point) -> (Point, f64) {
    let ab = sub(b, a);
    let l2 = dot(ab, ab);
    let t = if l2 < 1e-12 {
        0.0
    } else {
        (dot(sub(p, a), ab) / l2).clamp(0.0, 1.0)
    };
    (lerp(a, b, t), t)
}
pub fn distance_to_segment(p: Point, a: Point, b: Point) -> f64 {
    dist(p, closest_on_segment(p, a, b).0)
}
pub fn centroid(poly: &[Point]) -> Point {
    let mut x = 0.0;
    let mut z = 0.0;
    let mut a = 0.0;
    for i in 0..poly.len() {
        let p = poly[(i + poly.len() - 1) % poly.len()];
        let q = poly[i];
        let f = cross(p, q);
        x += (p.x + q.x) * f;
        z += (p.z + q.z) * f;
        a += f;
    }
    if a.abs() < 1e-9 {
        let n = poly.len().max(1) as f64;
        return Point {
            x: poly.iter().map(|p| p.x).sum::<f64>() / n,
            z: poly.iter().map(|p| p.z).sum::<f64>() / n,
        };
    }
    Point {
        x: x / (3.0 * a),
        z: z / (3.0 * a),
    }
}
pub fn point_in_polygon(p: Point, poly: &[Point]) -> bool {
    let mut inside = false;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + poly.len() - 1) % poly.len()];
        if (a.z > p.z) != (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x {
            inside = !inside;
        }
    }
    inside
}
pub fn self_intersects(poly: &[Point]) -> bool {
    for i in 0..poly.len() {
        for j in i + 2..poly.len() {
            if i == 0 && j == poly.len() - 1 {
                continue;
            }
            if segment_intersection(
                poly[i],
                poly[(i + 1) % poly.len()],
                poly[j],
                poly[(j + 1) % poly.len()],
            )
            .is_some()
            {
                return true;
            }
        }
    }
    false
}
pub fn clean_ring(poly: &[Point], epsilon: f64) -> Vec<Point> {
    let mut out = Vec::new();
    for &p in poly {
        if out.last().is_none_or(|q| dist(*q, p) > epsilon) {
            out.push(p)
        }
    }
    while out.len() > 1 && dist(out[0], *out.last().unwrap()) <= epsilon {
        out.pop();
    }
    out
}
pub fn rotated_rect(c: Point, w: f64, d: f64, angle: f64) -> Vec<Point> {
    let (co, si) = (angle.cos(), angle.sin());
    [
        (-w / 2.0, -d / 2.0),
        (w / 2.0, -d / 2.0),
        (w / 2.0, d / 2.0),
        (-w / 2.0, d / 2.0),
    ]
    .into_iter()
    .map(|(x, z)| Point {
        x: c.x + x * co - z * si,
        z: c.z + x * si + z * co,
    })
    .collect()
}
pub fn convex_overlap(a: &[Point], b: &[Point]) -> bool {
    for poly in [a, b] {
        for i in 0..poly.len() {
            let axis = perp(sub(poly[(i + 1) % poly.len()], poly[i]));
            let proj = |q: &[Point]| {
                q.iter()
                    .map(|p| dot(*p, axis))
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
                        (lo.min(v), hi.max(v))
                    })
            };
            let (la, ha) = proj(a);
            let (lb, hb) = proj(b);
            if ha < lb || hb < la {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitives_follow_xz_contract() {
        let a = Point { x: 1.0, z: 2.0 };
        let b = Point { x: 4.0, z: 6.0 };
        assert_eq!(dist(a, b), 5.0);
        assert_eq!(cross(a, b), -2.0);
        assert_eq!(
            signed_area(&[
                Point { x: 0.0, z: 0.0 },
                Point { x: 1.0, z: 0.0 },
                Point { x: 1.0, z: 1.0 },
            ]),
            0.5
        );
    }
}

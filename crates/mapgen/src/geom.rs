//! Small f64 geometry primitives shared by map-generation stages.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub z: f64,
}

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

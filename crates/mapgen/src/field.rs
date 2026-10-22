//! Height-field operations used by terrain and later stages.

use crate::{geom::Point, types::HeightField};

pub fn create(size: f64, cell: f64) -> HeightField {
    let side = (size / cell).round() as usize + 1;
    HeightField {
        w: side,
        h: side,
        cell,
        size,
        data: vec![0.0; side * side],
    }
}

pub fn sample(field: &HeightField, x: f64, z: f64) -> f64 {
    let u = (x + field.size / 2.0) / field.cell;
    let v = (z + field.size / 2.0) / field.cell;
    let ix = u.floor().clamp(0.0, (field.w - 2) as f64) as usize;
    let iz = v.floor().clamp(0.0, (field.h - 2) as f64) as usize;
    let tu = (u - ix as f64).clamp(0.0, 1.0);
    let tv = (v - iz as f64).clamp(0.0, 1.0);
    let i = iz * field.w + ix;
    let top = f64::from(field.data[i]) + f64::from(field.data[i + 1] - field.data[i]) * tu;
    let bottom = f64::from(field.data[i + field.w])
        + f64::from(field.data[i + field.w + 1] - field.data[i + field.w]) * tu;
    top + (bottom - top) * tv
}

pub fn to_world(field: &HeightField, x: usize, z: usize) -> Point {
    Point {
        x: x as f64 * field.cell - field.size / 2.0,
        z: z as f64 * field.cell - field.size / 2.0,
    }
}

pub fn gradient(field: &HeightField, x: f64, z: f64) -> Point {
    Point {
        x: (sample(field, x + field.cell, z) - sample(field, x - field.cell, z))
            / (2.0 * field.cell),
        z: (sample(field, x, z + field.cell) - sample(field, x, z - field.cell))
            / (2.0 * field.cell),
    }
}

pub fn blur(data: &[f32], w: usize, h: usize, radius: usize, passes: usize) -> Vec<f32> {
    let mut a = data.to_vec();
    let mut b = vec![0.0; data.len()];
    for _ in 0..passes {
        for z in 0..h {
            for x in 0..w {
                let x0 = x.saturating_sub(radius);
                let x1 = (x + radius + 1).min(w);
                let (sum, n) = (x0..x1).fold((0.0, 0), |(s, n), xx| (s + a[z * w + xx], n + 1));
                b[z * w + x] = sum / n as f32;
            }
        }
        for x in 0..w {
            for z in 0..h {
                let z0 = z.saturating_sub(radius);
                let z1 = (z + radius + 1).min(h);
                let (sum, n) = (z0..z1).fold((0.0, 0), |(s, n), zz| (s + b[zz * w + x], n + 1));
                a[z * w + x] = sum / n as f32;
            }
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sample_is_bilinear() {
        let mut f = create(8.0, 4.0);
        f.data
            .copy_from_slice(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        assert_eq!(sample(&f, 0.0, 0.0), 4.0);
    }
}

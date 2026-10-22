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
pub fn create_field(size: f64, cell: f64) -> HeightField {
    create(size, cell)
}
pub fn clone_field(field: &HeightField) -> HeightField {
    field.clone()
}
pub fn to_cell(field: &HeightField, x: f64, z: f64) -> (f64, f64) {
    (
        (x + field.size / 2.0) / field.cell,
        (z + field.size / 2.0) / field.cell,
    )
}

pub fn sample(field: &HeightField, x: f64, z: f64) -> f64 {
    let u = (x + field.size / 2.0) / field.cell;
    let v = (z + field.size / 2.0) / field.cell;
    let ix = u.floor().clamp(0.0, (field.w - 2) as f64) as usize;
    let iz = v.floor().clamp(0.0, (field.h - 2) as f64) as usize;
    let tu = (u - ix as f64).clamp(0.0, 1.0);
    let tv = (v - iz as f64).clamp(0.0, 1.0);
    let i = iz * field.w + ix;
    let top =
        f64::from(field.data[i]) + (f64::from(field.data[i + 1]) - f64::from(field.data[i])) * tu;
    let bottom = f64::from(field.data[i + field.w])
        + (f64::from(field.data[i + field.w + 1]) - f64::from(field.data[i + field.w])) * tu;
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
pub fn slope(field: &HeightField, x: f64, z: f64) -> f64 {
    let g = gradient(field, x, z);
    g.x.hypot(g.z)
}
pub fn cell_slope(field: &HeightField, ix: usize, iz: usize) -> f64 {
    let x0 = ix.saturating_sub(1);
    let x1 = (ix + 1).min(field.w - 1);
    let z0 = iz.saturating_sub(1);
    let z1 = (iz + 1).min(field.h - 1);
    let gx = (f64::from(field.data[iz * field.w + x1]) - f64::from(field.data[iz * field.w + x0]))
        / ((x1 - x0).max(1) as f64 * field.cell);
    let gz = (f64::from(field.data[z1 * field.w + ix]) - f64::from(field.data[z0 * field.w + ix]))
        / ((z1 - z0).max(1) as f64 * field.cell);
    gx.hypot(gz)
}

pub fn distance_transform(inside: &[u8], w: usize, h: usize) -> Vec<f32> {
    const INF: f64 = 1e20;
    fn edt(src: &[f64], n: usize) -> Vec<f64> {
        let mut v = vec![0usize; n];
        let mut z = vec![0.0; n + 1];
        let mut out = vec![0.0; n];
        let mut k = 0usize;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for q in 1..n {
            let mut s = (src[q] + (q * q) as f64 - (src[v[k]] + (v[k] * v[k]) as f64))
                / (2 * (q - v[k])) as f64;
            while s <= z[k] {
                k -= 1;
                s = (src[q] + (q * q) as f64 - (src[v[k]] + (v[k] * v[k]) as f64))
                    / (2 * (q - v[k])) as f64;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for (q, value) in out.iter_mut().enumerate().take(n) {
            while z[k + 1] < q as f64 {
                k += 1;
            }
            *value = (q as f64 - v[k] as f64).powi(2) + src[v[k]];
        }
        out
    }
    let mut values = vec![INF as f32; w * h];
    for i in 0..values.len() {
        if inside[i] != 0 {
            values[i] = 0.0;
        }
    }
    let mut column = vec![0.0; h];
    let mut result = vec![0.0; h];
    for x in 0..w {
        for z in 0..h {
            column[z] = f64::from(values[z * w + x]);
        }
        result = edt(&column, h);
        for z in 0..h {
            values[z * w + x] = result[z] as f32;
        }
    }
    let mut row = vec![0.0; w];
    let mut out = vec![0.0; w];
    for z in 0..h {
        for x in 0..w {
            row[x] = f64::from(values[z * w + x]);
        }
        out = edt(&row, w);
        for x in 0..w {
            values[z * w + x] = out[x].sqrt() as f32;
        }
    }
    values
}

pub fn blur(data: &[f32], w: usize, h: usize, radius: usize, passes: usize) -> Vec<f32> {
    let mut a = data.to_vec();
    let mut b = vec![0.0; data.len()];
    for _ in 0..passes {
        for z in 0..h {
            let mut sum = 0.0;
            let mut count = 0;
            for x in 0..=radius.min(w - 1) {
                sum += f64::from(a[z * w + x]);
                count += 1;
            }
            for x in 0..w {
                b[z * w + x] = (sum / count as f64) as f32;
                if x >= radius {
                    sum -= f64::from(a[z * w + x - radius]);
                    count -= 1;
                }
                let inn = x + radius + 1;
                if inn < w {
                    sum += f64::from(a[z * w + inn]);
                    count += 1;
                }
            }
        }
        for x in 0..w {
            let mut sum = 0.0;
            let mut count = 0;
            for z in 0..=radius.min(h - 1) {
                sum += f64::from(b[z * w + x]);
                count += 1;
            }
            for z in 0..h {
                a[z * w + x] = (sum / count as f64) as f32;
                if z >= radius {
                    sum -= f64::from(b[(z - radius) * w + x]);
                    count -= 1;
                }
                let inn = z + radius + 1;
                if inn < h {
                    sum += f64::from(b[inn * w + x]);
                    count += 1;
                }
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

    #[test]
    fn samples_and_slopes_promote_float32_values_before_arithmetic() {
        let f = HeightField {
            w: 2,
            h: 2,
            size: 1.0,
            cell: 1.0,
            data: vec![100_000_000.0, 1.0, 100_000_000.0, 1.0],
        };
        assert_eq!(sample(&f, 0.0, 0.0), 50_000_000.5);
        assert_eq!(cell_slope(&f, 0, 0), 99_999_999.0);
    }

    #[test]
    fn blur_accumulates_in_f64_and_rounds_only_on_float32_array_writes() {
        assert_eq!(
            blur(&[16_777_216.0, 1.0, -16_777_216.0, 3.0], 4, 1, 1, 1),
            vec![8_388_608.0, 0.333_333_34, -5_592_404.0, -8_388_606.5],
        );
    }
}

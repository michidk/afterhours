use crate::{
    field::{blur, cell_slope, to_world},
    random::{Noise, derive},
    types::{Field, Hydrology, Point},
};

pub fn desirability_field(f: &Field, hydro: &Hydrology, seed: i32) -> Vec<f32> {
    let mut out = vec![0f32; f.w * f.h];
    let noise = Noise::new(&mut derive(seed, "desire"));
    for z in 0..f.h {
        for x in 0..f.w {
            let i = z * f.w + x;
            if f.data[i] <= 0.0 || hydro.river_mask[i] != 0 {
                continue;
            }
            let s = cell_slope(f, x, z);
            let flat = (1.0 - s / 0.14).max(0.0);
            let low = (1.0 - (f.data[i] as f64 - 12.0).max(0.0) / 70.0).max(0.0);
            let water = hydro.water_distance[i] as f64;
            let coast = hydro.coast_distance[i] as f64;
            let near_water = if water < 14.0 {
                water / 14.0
            } else {
                (1.0 - (water - 14.0) / 600.0).max(0.0)
            };
            let near_coast = (1.0 - coast / 1100.0).max(0.0);
            let edge = x.min(z).min(f.w - 1 - x).min(f.h - 1 - z) as f64 * f.cell;
            let inside = (edge / 300.0).min(1.0);
            let n = 0.85 + 0.15 * noise.fbm(x as f64 * 0.03, z as f64 * 0.03, 3, 2.0, 0.5);
            out[i] =
                (flat * low * (0.35 + 0.65 * near_water) * (0.4 + 0.6 * near_coast) * inside * n)
                    as f32;
        }
    }
    let mut blurred = blur(&out, f.w, f.h, 3, 2);
    let mut sorted = blurred.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let top = sorted[((sorted.len() as f64 * 0.995).floor() as usize).min(sorted.len() - 1)];
    let top = if top == 0.0 { 1.0 } else { top };
    for v in &mut blurred {
        *v = (*v / top).min(1.0);
    }
    blurred
}

pub fn choose_centre(f: &Field, desirability: &[f32]) -> Point {
    let radius = (220.0 / f.cell).round() as usize;
    let wide = blur(desirability, f.w, f.h, radius, 1);
    let mut best = 0usize;
    let mut best_value = -1f32;
    for i in 0..wide.len() {
        if desirability[i] > 0.05 && wide[i] > best_value {
            best_value = wide[i];
            best = i;
        }
    }
    let x = best % f.w;
    to_world(f, x, best / f.w)
}

use crate::js_math::JsMath;
use crate::{
    field::{blur, create_field, distance_transform},
    random::{Noise, Rng, clamp, derive, lerp, smoothstep},
    types::{Field, HeightmapResult, TerrainTuning},
};

pub const TERRAIN_DEFAULTS: TerrainTuning = TerrainTuning {
    land_fraction: 0.44,
    max_hill: 170.0,
    plateau: [6.0, 26.0],
    droplets: 0.8,
    thermal_iterations: 12,
};

pub fn generate_heightmap(seed: i32, size: f64, cell: f64) -> (Field, Vec<f32>) {
    generate_heightmap_with_tuning(seed, size, cell, TERRAIN_DEFAULTS).into()
}

pub fn generate_heightmap_with_tuning(
    seed: i32,
    size: f64,
    cell: f64,
    tuning: TerrainTuning,
) -> HeightmapResult {
    let mut f = create_field(size, cell);
    let warp = Noise::new(&mut derive(seed, "warp"));
    let shape = Noise::new(&mut derive(seed, "shape"));
    let erosion = Noise::new(&mut derive(seed, "erosion"));
    let ridges = Noise::new(&mut derive(seed, "ridges"));
    let detail = Noise::new(&mut derive(seed, "detail"));
    let mut rng = derive(seed, "island");
    let spin = rng() * std::f64::consts::PI * 2.0;
    let stretch = 0.8 + rng() * 0.45;
    let lobes = 2 + (rng() * 3.0).floor() as i32;
    let lobe_phase = rng() * std::f64::consts::PI * 2.0;
    let stride = 4usize;
    let cw = (f.w - 1).div_ceil(stride) + 1;
    let mut cmask = vec![0f32; cw * cw];
    let mut cflat = vec![0f32; cw * cw];
    let mut cbase = vec![0f32; cw * cw];
    let mut csea = vec![0f32; cw * cw];
    for cz in 0..cw {
        for cx in 0..cw {
            let nx = (cx * stride) as f64 / (f.w - 1) as f64 * 2.0 - 1.0;
            let nz = (cz * stride) as f64 / (f.h - 1) as f64 * 2.0 - 1.0;
            let wx = nx + 0.28 * warp.fbm(nx * 1.4 + 11.3, nz * 1.4 + 3.7, 3, 2.0, 0.5);
            let wz = nz + 0.28 * warp.fbm(nx * 1.4 - 7.1, nz * 1.4 + 19.2, 3, 2.0, 0.5);
            let rx = wx * spin.js_cos() - wz * spin.js_sin();
            let rz = (wx * spin.js_sin() + wz * spin.js_cos()) * stretch;
            let angle = rz.js_atan2(rx);
            let radius =
                rx.js_hypot(rz) * (1.0 + 0.14 * (angle * lobes as f64 + lobe_phase).js_sin());
            let coast = 0.1 * shape.fbm(nx * 3.1 + 5.0, nz * 3.1 - 2.0, 4, 2.0, 0.5);
            let mask = smoothstep(0.98, 0.42, radius + coast);
            let e = clamp(
                0.5 + 0.9 * erosion.fbm(nx * 1.3 + 2.2, nz * 1.3 - 4.4, 3, 2.0, 0.5),
                0.0,
                1.0,
            );
            let plain = smoothstep(0.5, 0.78, radius + coast * 0.5);
            let flat = smoothstep(0.28, 0.58, e).max(plain * 0.92);
            let pv = ridges.ridged(nx * 2.4 - 1.1, nz * 2.4 + 6.5, 5, 2.0, 0.5);
            let broad = 0.5 + 0.5 * shape.fbm(nx * 1.1 - 9.0, nz * 1.1 + 4.0, 3, 2.0, 0.5);
            let low = lerp(tuning.plateau[0], tuning.plateau[1], broad);
            let hills = (1.0 - flat) * tuning.max_hill * (0.3 * broad + 0.7 * pv * pv);
            let i = cz * cw + cx;
            cmask[i] = mask as f32;
            cflat[i] = flat as f32;
            cbase[i] = (low + hills) as f32;
            csea[i] = (-4.0 - 32.0 * smoothstep(0.4, 0.9, radius)) as f32;
        }
    }
    let bilinear = |g: &[f32], u: f64, v: f64| {
        let x0 = (u.floor() as usize).min(cw - 2);
        let z0 = (v.floor() as usize).min(cw - 2);
        let tu = u - x0 as f64;
        let tv = v - z0 as f64;
        let i = z0 * cw + x0;
        let top = g[i] as f64 + (g[i + 1] as f64 - g[i] as f64) * tu;
        let bot = g[i + cw] as f64 + (g[i + cw + 1] as f64 - g[i + cw] as f64) * tu;
        top + (bot - top) * tv
    };
    let mut flatness = vec![0f32; f.w * f.h];
    for z in 0..f.h {
        for x in 0..f.w {
            let nx = x as f64 / (f.w - 1) as f64 * 2.0 - 1.0;
            let nz = z as f64 / (f.h - 1) as f64 * 2.0 - 1.0;
            let u = x as f64 / stride as f64;
            let v = z as f64 / stride as f64;
            let mask = bilinear(&cmask, u, v);
            let flat = bilinear(&cflat, u, v);
            flatness[z * f.w + x] = flat as f32;
            let fine = detail.fbm(nx * 9.0 + 1.0, nz * 9.0 - 3.0, 5, 2.0, 0.5)
                * (1.2 + 9.0 * (1.0 - flat));
            let land = bilinear(&cbase, u, v) + fine;
            f.data[z * f.w + x] = lerp(bilinear(&csea, u, v), land, mask) as f32;
        }
    }
    let mut sorted = f.data.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let sea = sorted[(sorted.len() as f64 * (1.0 - tuning.land_fraction)).floor() as usize];
    for h in &mut f.data {
        *h = (*h as f64 - sea as f64) as f32;
    }
    HeightmapResult { field: f, flatness }
}

impl From<HeightmapResult> for (Field, Vec<f32>) {
    fn from(v: HeightmapResult) -> Self {
        (v.field, v.flatness)
    }
}

pub fn thermal_erosion(f: &mut Field, iterations: usize, talus_angle: f64) {
    let talus = talus_angle * f.cell;
    for _ in 0..iterations {
        for z in 1..f.h - 1 {
            for x in 1..f.w - 1 {
                let i = z * f.w + x;
                if f.data[i] <= 0.0 {
                    continue;
                }
                let mut low = i;
                for n in [i - 1, i + 1, i - f.w, i + f.w] {
                    if f.data[n] < f.data[low] {
                        low = n;
                    }
                }
                let diff = f.data[i] as f64 - f.data[low] as f64;
                if diff > talus {
                    let m = (diff - talus) * 0.25;
                    f.data[i] = (f.data[i] as f64 - m) as f32;
                    f.data[low] = (f.data[low] as f64 + m) as f32;
                }
            }
        }
    }
}

pub fn droplet_erosion(f: &mut Field, rng: &mut Rng, count: usize) {
    let (w, h) = (f.w, f.h);
    let inertia = 0.06;
    let capacity_factor = 6.0;
    let min_capacity = 0.01;
    let erode_speed = 0.3;
    let deposit_speed = 0.3;
    let evaporate = 0.012;
    let gravity = 4.0;
    let max_life = 32;
    let radius = 2;
    let mut brush = Vec::new();
    let mut total = 0.0;
    for dz in -radius..=radius {
        for dx in -radius..=radius {
            let d = (dx as f64).js_hypot(dz as f64);
            if d <= radius as f64 {
                let weight = 1.0 - d / radius as f64;
                brush.push((dx, dz, weight));
                total += weight;
            }
        }
    }
    for b in &mut brush {
        b.2 /= total;
    }
    let sample = |data: &[f32], px: f64, pz: f64| {
        let ix = px.floor() as usize;
        let iz = pz.floor() as usize;
        let u = px - ix as f64;
        let v = pz - iz as f64;
        let i = iz * w + ix;
        let nw = data[i] as f64;
        let ne = data[i + 1] as f64;
        let sw = data[i + w] as f64;
        let se = data[i + w + 1] as f64;
        (
            nw * (1.0 - u) * (1.0 - v) + ne * u * (1.0 - v) + sw * (1.0 - u) * v + se * u * v,
            (ne - nw) * (1.0 - v) + (se - sw) * v,
            (sw - nw) * (1.0 - u) + (se - ne) * u,
        )
    };
    for _ in 0..count {
        let mut px = 1.0 + rng() * (w as f64 - 3.0);
        let mut pz = 1.0 + rng() * (h as f64 - 3.0);
        if f.data[pz.floor() as usize * w + px.floor() as usize] <= 0.0 {
            continue;
        }
        let (mut dx, mut dz, mut speed, mut water, mut sediment) = (0.0, 0.0, 1.0, 1.0, 0.0);
        for _ in 0..max_life {
            let ix = px.floor() as usize;
            let iz = pz.floor() as usize;
            let u = px - ix as f64;
            let v = pz - iz as f64;
            let (here, gx, gz) = sample(&f.data, px, pz);
            dx = dx * inertia - gx * (1.0 - inertia);
            dz = dz * inertia - gz * (1.0 - inertia);
            let l = dx.js_hypot(dz);
            if l < 1e-6 {
                let angle = rng() * std::f64::consts::PI * 2.0;
                dx = angle.js_cos();
                dz = angle.js_sin();
            } else {
                dx /= l;
                dz /= l;
            }
            let nx = px + dx;
            let nz = pz + dz;
            if nx < 1.0 || nz < 1.0 || nx >= w as f64 - 2.0 || nz >= h as f64 - 2.0 {
                break;
            }
            let (next, _, _) = sample(&f.data, nx, nz);
            if next <= 0.0 {
                break;
            }
            let dh = next - here;
            let capacity = (-dh * speed * water * capacity_factor).max(min_capacity);
            if sediment > capacity || dh > 0.0 {
                let amount = if dh > 0.0 {
                    dh.min(sediment)
                } else {
                    (sediment - capacity) * deposit_speed
                };
                sediment -= amount;
                let i = iz * w + ix;
                f.data[i] = (f.data[i] as f64 + amount * (1.0 - u) * (1.0 - v)) as f32;
                f.data[i + 1] = (f.data[i + 1] as f64 + amount * u * (1.0 - v)) as f32;
                f.data[i + w] = (f.data[i + w] as f64 + amount * (1.0 - u) * v) as f32;
                f.data[i + w + 1] = (f.data[i + w + 1] as f64 + amount * u * v) as f32;
            } else {
                let amount = ((capacity - sediment) * erode_speed).min(-dh);
                for &(bdx, bdz, weight) in &brush {
                    let bx = ix as i32 + bdx;
                    let bz = iz as i32 + bdz;
                    if bx < 0 || bz < 0 || bx >= w as i32 || bz >= h as i32 {
                        continue;
                    }
                    let j = bz as usize * w + bx as usize;
                    let take = ((f.data[j] as f64) - 0.2).min(amount * weight);
                    if take > 0.0 {
                        f.data[j] = (f.data[j] as f64 - take) as f32;
                        sediment += take;
                    }
                }
            }
            speed = (speed * speed + dh * gravity).max(0.0).sqrt();
            water *= 1.0 - evaporate;
            px = nx;
            pz = nz;
        }
    }
}

pub fn settle(f: &mut Field, radius: usize) {
    let smoothed = blur(&f.data, f.w, f.h, radius, 1);
    for (i, h) in f.data.iter_mut().enumerate() {
        if *h > -0.5 {
            *h = smoothed[i];
        }
    }
}
pub fn keep_main_island(f: &mut Field, sea_level: f64) {
    let mut labels = vec![-1i32; f.data.len()];
    let mut sizes = Vec::new();
    for i in 0..f.data.len() {
        if f.data[i] as f64 <= sea_level || labels[i] >= 0 {
            continue;
        }
        let id = sizes.len() as i32;
        sizes.push(0usize);
        let mut stack = vec![i];
        labels[i] = id;
        while let Some(c) = stack.pop() {
            sizes[id as usize] += 1;
            let x = c % f.w;
            let z = c / f.w;
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = x as i32 + dx;
                let nz = z as i32 + dz;
                if nx >= 0 && nz >= 0 && nx < f.w as i32 && nz < f.h as i32 {
                    let j = nz as usize * f.w + nx as usize;
                    if f.data[j] as f64 > sea_level && labels[j] < 0 {
                        labels[j] = id;
                        stack.push(j);
                    }
                }
            }
        }
    }
    if sizes.is_empty() {
        return;
    }
    let main = (1..sizes.len()).fold(0, |a, i| if sizes[i] > sizes[a] { i } else { a });
    for (i, label) in labels.into_iter().enumerate() {
        if label >= 0 && label as usize != main {
            f.data[i] = (sea_level - 0.6 - (f.data[i] as f64 - sea_level) * 0.1) as f32;
        }
    }
}

pub fn shape_coast(f: &mut Field, sea_level: f64) {
    let mut sea = vec![0u8; f.data.len()];
    let mut land = vec![0u8; f.data.len()];
    for (i, h) in f.data.iter().enumerate() {
        if *h as f64 > sea_level {
            land[i] = 1
        } else {
            sea[i] = 1
        }
    }
    let a = distance_transform(&sea, f.w, f.h);
    let b = distance_transform(&land, f.w, f.h);
    let signed: Vec<f32> = (0..f.data.len())
        .map(|i| {
            if land[i] != 0 {
                ((a[i] as f64 - 0.5) * f.cell) as f32
            } else {
                (-(b[i] as f64 - 0.5) * f.cell) as f32
            }
        })
        .collect();
    let smooth = blur(&signed, f.w, f.h, 2, 2);
    for (i, h) in f.data.iter_mut().enumerate() {
        let m = smooth[i] as f64;
        let weight = 1.0 - smoothstep(20.0, 60.0, m.abs());
        if weight > 0.0 {
            let profile = sea_level + if m > 0.0 { 0.06 } else { 0.1 } * m;
            *h = lerp(*h as f64, profile, weight) as f32;
        }
    }
}

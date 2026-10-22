use crate::{
    field::{distance_transform, to_world},
    random::{Noise, derive},
    types::{Field, Hydrology, Lake, Point, River, RiverOrder},
};

const N: [(i32, i32, f64); 8] = [
    (1, 0, 1.0),
    (-1, 0, 1.0),
    (0, 1, 1.0),
    (0, -1, 1.0),
    (1, 1, 1.4142135623730951),
    (1, -1, 1.4142135623730951),
    (-1, 1, 1.4142135623730951),
    (-1, -1, 1.4142135623730951),
];
struct Heap {
    v: Vec<(f64, usize)>,
}
impl Heap {
    fn new() -> Self {
        Self { v: Vec::new() }
    }
    fn push(&mut self, k: f64, val: usize) {
        let mut i = self.v.len();
        self.v.push((k, val));
        while i > 0 {
            let p = (i - 1) / 2;
            if self.v[p].0 <= k {
                break;
            }
            self.v.swap(i, p);
            i = p;
        }
    }
    fn pop(&mut self) -> Option<(f64, usize)> {
        if self.v.is_empty() {
            return None;
        }
        let top = self.v[0];
        let last = self.v.pop().unwrap();
        if !self.v.is_empty() {
            let mut i = 0;
            self.v[0] = last;
            loop {
                let l = i * 2 + 1;
                if l >= self.v.len() {
                    break;
                }
                let c = if l + 1 < self.v.len() && self.v[l + 1].0 < self.v[l].0 {
                    l + 1
                } else {
                    l
                };
                if self.v[i].0 <= self.v[c].0 {
                    break;
                }
                self.v.swap(i, c);
                i = c;
            }
        }
        Some(top)
    }
}

pub fn fill_depressions(f: &mut Field, sea: f32, eps: f32) -> Vec<f32> {
    let n = f.data.len();
    let mut closed = vec![false; n];
    let mut depth = vec![0f32; n];
    let mut heap = Heap::new();
    for z in 0..f.h {
        for x in 0..f.w {
            let i = z * f.w + x;
            if f.data[i] <= sea || x == 0 || z == 0 || x == f.w - 1 || z == f.h - 1 {
                closed[i] = true;
                heap.push(f.data[i] as f64, i);
            }
        }
    }
    while let Some((_, c)) = heap.pop() {
        let cx = c % f.w;
        let cz = c / f.w;
        let hc = f.data[c];
        for &(dx, dz, _) in &N {
            let nx = cx as i32 + dx;
            let nz = cz as i32 + dz;
            if nx < 0 || nz < 0 || nx >= f.w as i32 || nz >= f.h as i32 {
                continue;
            }
            let i = nz as usize * f.w + nx as usize;
            if closed[i] {
                continue;
            }
            closed[i] = true;
            if f.data[i] < hc + eps {
                depth[i] = hc + eps - f.data[i];
                f.data[i] = hc + eps;
            }
            heap.push(f.data[i] as f64, i);
        }
    }
    depth
}

pub fn flow_accumulation(f: &Field, sea: f32) -> (Vec<i32>, Vec<f32>) {
    let n = f.data.len();
    let mut dir = vec![-1i32; n];
    let mut flux = vec![0f32; n];
    for z in 0..f.h {
        for x in 0..f.w {
            let i = z * f.w + x;
            if f.data[i] <= sea {
                continue;
            }
            let mut best = -1;
            let mut steep = 0.;
            for &(dx, dz, d) in &N {
                let nx = x as i32 + dx;
                let nz = z as i32 + dz;
                if nx < 0 || nz < 0 || nx >= f.w as i32 || nz >= f.h as i32 {
                    continue;
                }
                let j = nz as usize * f.w + nx as usize;
                let s = (f.data[i] - f.data[j]) as f64 / d;
                if s > steep {
                    steep = s;
                    best = j as i32;
                }
            }
            dir[i] = best;
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|a, b| f.data[*b].total_cmp(&f.data[*a]).then(a.cmp(b)));
    for (i, h) in f.data.iter().enumerate() {
        flux[i] = if *h > sea { 1. } else { 0. };
    }
    for i in order {
        if dir[i] >= 0 {
            flux[dir[i] as usize] += flux[i];
        }
    }
    (dir, flux)
}

fn lakes_from_fill(f: &Field, depth: &[f32], sea: f32) -> Vec<u8> {
    let n = depth.len();
    let mut cand = vec![false; n];
    for i in 0..n {
        cand[i] = depth[i] > 0.4;
    }
    let mut seen = vec![false; n];
    let mut mask = vec![0u8; n];
    for st in 0..n {
        if !cand[st] || seen[st] {
            continue;
        }
        let mut cells = Vec::new();
        let mut stack = vec![st];
        seen[st] = true;
        let mut maxd = 0f32;
        while let Some(c) = stack.pop() {
            cells.push(c);
            maxd = maxd.max(depth[c]);
            let x = c % f.w;
            let z = c / f.w;
            for (dx, dz) in [(1, -0), (-1, 0), (0, 1), (0, -1)] {
                let nx = x as i32 + dx;
                let nz = z as i32 + dz;
                if nx >= 0 && nz >= 0 && nx < f.w as i32 && nz < f.h as i32 {
                    let j = nz as usize * f.w + nx as usize;
                    if cand[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        if maxd > 3.5 && cells.len() >= 30 && f.data[cells[0]] > sea {
            for c in cells {
                mask[c] = 1;
            }
        }
    }
    mask
}
fn smooth(a: &[Point], passes: usize) -> Vec<Point> {
    let mut out = a.to_vec();
    for _ in 0..passes {
        if out.len() < 2 {
            break;
        }
        let mut n = Vec::with_capacity(out.len());
        n.push(out[0]);
        for i in 1..out.len() - 1 {
            n.push(Point {
                x: out[i - 1].x * 0.25 + out[i].x * 0.5 + out[i + 1].x * 0.25,
                z: out[i - 1].z * 0.25 + out[i].z * 0.5 + out[i + 1].z * 0.25,
            });
        }
        n.push(*out.last().unwrap());
        out = n;
    }
    out
}
fn trace_rivers(
    f: &Field,
    dir: &[i32],
    flux: &[f32],
    lake: &[u8],
    threshold: f32,
    sea: f32,
) -> Vec<River> {
    let isriver = |i: usize| flux[i] >= threshold && f.data[i] > sea && lake[i] == 0;
    let mut upstream = vec![false; f.data.len()];
    for i in 0..f.data.len() {
        if isriver(i) && dir[i] >= 0 {
            upstream[dir[i] as usize] = true;
        }
    }
    let mut src: Vec<usize> = (0..f.data.len())
        .filter(|i| isriver(*i) && !upstream[*i])
        .collect();
    src.sort_by(|a, b| flux[*a].total_cmp(&flux[*b]));
    let mut claimed = vec![-1i32; f.data.len()];
    let mut rivers = Vec::new();
    for s in src {
        let mut i = s as i32;
        let mut cells = Vec::new();
        while i >= 0 && claimed[i as usize] < 0 && f.data[i as usize] > sea && lake[i as usize] == 0
        {
            cells.push(i as usize);
            i = dir[i as usize];
        }
        if i >= 0 {
            cells.push(i as usize);
        }
        if cells.len() < 10 {
            continue;
        }
        let id = rivers.len() as i32;
        for c in &cells {
            if claimed[*c] < 0 {
                claimed[*c] = id;
            }
        }
        let pts: Vec<Point> = cells
            .iter()
            .map(|c| to_world(f, *c % f.w, *c / f.w))
            .collect();
        let widths: Vec<f64> = cells
            .iter()
            .map(|c| {
                (3.5f64 + 1.1 * ((flux[*c] as f64) / (threshold as f64)).sqrt() * 3.0).min(30.0)
            })
            .collect();
        let length = cells.len() as f64 * f.cell;
        let peak = flux[*cells
            .get(cells.len().saturating_sub(2))
            .unwrap_or(&cells[0])];
        let order = if peak > threshold * 12. {
            RiverOrder::Main
        } else if length > 900. {
            RiverOrder::River
        } else {
            RiverOrder::Stream
        };
        rivers.push(River {
            points: smooth(&pts, 2),
            widths,
            order,
        });
    }
    rivers
}

fn carve(f: &mut Field, rivers: &[River], sea: f32, seed: i32, lakes: &[u8]) {
    let noise = Noise::new(&mut derive(seed, "banks"));
    for river in rivers {
        let mut bed = f64::INFINITY;
        for (k, p) in river.points.iter().enumerate() {
            let width = river.widths[k];
            let depth = (1. + width * 0.16).min(6.);
            let ix = ((p.x + f.size / 2.) / f.cell).round() as i32;
            let iz = ((p.z + f.size / 2.) / f.cell).round() as i32;
            if ix < 1 || iz < 1 || ix >= f.w as i32 - 1 || iz >= f.h as i32 - 1 {
                continue;
            }
            let here = f.data[iz as usize * f.w + ix as usize] as f64;
            bed = (bed - 0.03).min(here - depth);
            if bed < sea as f64 - 1.5 {
                bed = sea as f64 - 1.5
            }
            let half = width / 2. + f.cell * 0.6;
            let bank = half + f.cell * 1.5;
            let rc = (bank / f.cell).ceil() as i32;
            for dz in -rc..=rc {
                for dx in -rc..=rc {
                    let x = ix + dx;
                    let z = iz + dz;
                    if x < 1 || z < 1 || x >= f.w as i32 - 1 || z >= f.h as i32 - 1 {
                        continue;
                    }
                    let d = (dx as f64 * f.cell).hypot(dz as f64 * f.cell);
                    let i = z as usize * f.w + x as usize;
                    if lakes[i] != 0 {
                        continue;
                    }
                    if d <= half {
                        let t = d / half;
                        f.data[i] = f.data[i].min((bed + depth * t * t * 0.3) as f32)
                    } else if d <= bank {
                        let t = (d - half) / (bank - half);
                        let wobble = 0.3 * noise.at(x as f64 * 0.2, z as f64 * 0.2);
                        let target =
                            bed + depth * 0.3 + (f.data[i] as f64 - bed - depth * 0.3) * t + wobble;
                        f.data[i] = f.data[i].min(target.max(bed + 0.2) as f32)
                    }
                }
            }
        }
    }
}

pub fn mask_outlines(f: &Field, mask: &[u8]) -> Vec<Vec<Point>> {
    let w = f.w;
    let h = f.h;
    let ww = w + 1;
    let at = |x: i32, z: i32| {
        if x < 0 || z < 0 || x >= w as i32 || z >= h as i32 {
            0
        } else {
            mask[z as usize * w + x as usize]
        }
    };
    let mut edges = vec![0u8; ww * (h + 1)];
    for z in 0..=h {
        for x in 0..=w {
            let inside = at(x as i32, z as i32);
            let left = at(x as i32 - 1, z as i32);
            let up = at(x as i32, z as i32 - 1);
            if inside != left {
                if inside != 0 {
                    edges[(z + 1) * ww + x] |= 1 << 3
                } else {
                    edges[z * ww + x] |= 1 << 1
                }
            }
            if inside != up {
                if inside != 0 {
                    edges[z * ww + x] |= 1
                } else {
                    edges[z * ww + x + 1] |= 1 << 2
                }
            }
        }
    }
    let steps = [(1i32, 0i32), (0, 1), (-1, 0), (0, -1)];
    let mut rings = Vec::new();
    for start in 0..edges.len() {
        while edges[start] != 0 {
            let mut ring = Vec::new();
            let mut corner = start;
            let mut dir = 31 - edges[start].leading_zeros();
            let mut guard = 0;
            loop {
                edges[corner] &= !(1 << dir);
                ring.push(Point {
                    x: ((corner % ww) as f64 - 0.5) * f.cell - f.size / 2.,
                    z: ((corner / ww) as f64 - 0.5) * f.cell - f.size / 2.,
                });
                let nx = corner as i32 + steps[dir as usize].0 + steps[dir as usize].1 * ww as i32;
                if nx == start as i32 || guard > edges.len() {
                    break;
                }
                guard += 1;
                if nx < 0 || nx >= edges.len() as i32 {
                    break;
                }
                let avail = edges[nx as usize];
                if avail == 0 {
                    break;
                }
                let order = [(dir + 3) & 3, dir, (dir + 1) & 3];
                let Some(nd) = order.into_iter().find(|d| avail & (1 << d) != 0) else {
                    break;
                };
                corner = nx as usize;
                dir = nd;
            }
            if ring.len() >= 4 {
                rings.push(ring);
            }
        }
    }
    rings
}
fn lake_outlines(f: &Field, mask: &[u8]) -> Vec<Lake> {
    mask_outlines(f, mask)
        .into_iter()
        .map(|outline| {
            let mut level = f32::NEG_INFINITY;
            for p in &outline {
                let x = ((p.x + f.size / 2.) / f.cell).round() as i32;
                let z = ((p.z + f.size / 2.) / f.cell).round() as i32;
                if x >= 0 && z >= 0 && x < f.w as i32 && z < f.h as i32 {
                    level = level.max(f.data[z as usize * f.w + x as usize]);
                }
            }
            let mut closed = outline.clone();
            closed.push(closed[0]);
            let sm = smooth(&closed, 2);
            Lake {
                outline: sm[..sm.len() - 1].to_vec(),
                level: level as f64,
            }
        })
        .collect()
}

pub fn generate_hydrology(f: &mut Field, seed: i32, sea_level: f32) -> Hydrology {
    let depth = fill_depressions(f, sea_level, 0.002);
    let lake_mask = lakes_from_fill(f, &depth, sea_level);
    let (dir, mut flux) = flow_accumulation(f, sea_level);
    let land = flux.iter().filter(|v| **v > 0.).count() as f32;
    let threshold = (land * 0.011).max(40.);
    let rivers = trace_rivers(f, &dir, &flux, &lake_mask, threshold, sea_level);
    carve(f, &rivers, sea_level, seed, &lake_mask);
    fill_depressions(f, sea_level, 0.002);
    let (_, newflux) = flow_accumulation(f, sea_level);
    flux = newflux;
    let mut river_mask = vec![0u8; f.data.len()];
    let mut water = vec![0u8; f.data.len()];
    let mut sea = vec![0u8; f.data.len()];
    for i in 0..f.data.len() {
        sea[i] = (f.data[i] <= sea_level) as u8;
        water[i] = (sea[i] != 0 || lake_mask[i] != 0) as u8;
    }
    for river in &rivers {
        for (k, p) in river.points.iter().enumerate() {
            let r = river.widths[k] / 2.;
            let cx = (p.x + f.size / 2.) / f.cell;
            let cz = (p.z + f.size / 2.) / f.cell;
            let rc = (r / f.cell).ceil() as i32;
            for dz in -rc..=rc {
                for dx in -rc..=rc {
                    let x = (cx + dx as f64).round() as i32;
                    let z = (cz + dz as f64).round() as i32;
                    if x >= 0
                        && z >= 0
                        && x < f.w as i32
                        && z < f.h as i32
                        && (dx as f64).hypot(dz as f64) * f.cell <= r + f.cell * 0.5
                    {
                        let i = z as usize * f.w + x as usize;
                        river_mask[i] = 1;
                        water[i] = 1;
                    }
                }
            }
        }
    }
    let mut water_distance = distance_transform(&water, f.w, f.h);
    let mut coast_distance = distance_transform(&sea, f.w, f.h);
    for d in &mut water_distance {
        *d *= f.cell as f32
    }
    for d in &mut coast_distance {
        *d *= f.cell as f32
    }
    let max_log = (1. + threshold as f64 * 40.).ln() as f32;
    let flow = flux
        .iter()
        .map(|v| ((1. + *v).ln() as f32 / max_log).min(1.))
        .collect();
    Hydrology {
        rivers,
        lakes: lake_outlines(f, &lake_mask),
        river_mask,
        water_distance,
        coast_distance,
        flow,
    }
}

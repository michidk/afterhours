//! Literal port of `mapgen/roads.ts`: least-cost arterials followed by tensor
//! hyperstreamlines, inserted into the same planar graph and cleaned in place.
use crate::js_math::JsMath;
use crate::{
    field::{blur, cell_slope, distance_transform, sample, to_world},
    geom::{Point, dist, hypot, lerp, norm, sub},
    graph::{CleanupOptions, GraphBuilder, SnapOptions, road_width},
    random::{Noise, Rng, derive},
    types::{HeightField, Hydrology, RoadGraph, RoadKind},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    f64::consts::PI,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoadInputs {
    pub field: HeightField,
    pub hydro: Hydrology,
    pub desirability: Vec<f32>,
    pub centre: Point,
    pub seed: i32,
    #[serde(default)]
    pub debug: bool,
}
fn round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor < 0.5 { floor } else { floor + 1.0 }
}
fn or_one(x: f64) -> f64 {
    if x == 0.0 { 1.0 } else { x }
}

const BASE_DIRECTIONS: [(isize, isize); 16] = [
    (1, 0),
    (0, 1),
    (1, 1),
    (1, -1),
    (2, 1),
    (1, 2),
    (2, -1),
    (1, -2),
    (3, 1),
    (1, 3),
    (3, -1),
    (1, -3),
    (3, 2),
    (2, 3),
    (3, -2),
    (2, -3),
];
struct CostGrid<'a> {
    f: &'a HeightField,
    w: usize,
    cell: f64,
    height: Vec<f32>,
    water: Vec<u8>,
    sea: Vec<u8>,
    blocked: Vec<u8>,
    road_distance: Vec<f32>,
    desire: Vec<f32>,
}
impl<'a> CostGrid<'a> {
    fn new(f: &'a HeightField, hydro: &Hydrology, desirability: &[f32], cell: f64) -> Self {
        let w = round(f.size / cell) as usize + 1;
        let n = w * w;
        let mut grid = Self {
            f,
            w,
            cell,
            height: vec![0.0; n],
            water: vec![0; n],
            sea: vec![0; n],
            blocked: vec![0; n],
            road_distance: vec![1e6; n],
            desire: vec![0.0; n],
        };
        for z in 0..w {
            for x in 0..w {
                let p = grid.world(x, z);
                let i = z * w + x;
                grid.height[i] = sample(f, p.x, p.z) as f32;
                let fx = round((p.x + f.size / 2.0) / f.cell);
                let fz = round((p.z + f.size / 2.0) / f.cell);
                let fi = (fz * f.w as f64 + fx).max(0.0).min((f.w * f.h - 1) as f64) as usize;
                let sea = grid.height[i] <= 0.0;
                grid.sea[i] = u8::from(sea);
                grid.water[i] =
                    u8::from(sea || hydro.river_mask[fi] != 0 || hydro.water_distance[fi] < 10.0);
                grid.blocked[i] = u8::from(sea || x < 2 || z < 2 || x >= w - 2 || z >= w - 2);
                grid.desire[i] = desirability[fi];
            }
        }
        grid
    }
    fn world(&self, x: usize, z: usize) -> Point {
        Point {
            x: x as f64 * self.cell - self.f.size / 2.0,
            z: z as f64 * self.cell - self.f.size / 2.0,
        }
    }
    fn index(&self, p: Point) -> usize {
        let x = round((p.x + self.f.size / 2.0) / self.cell);
        let z = round((p.z + self.f.size / 2.0) / self.cell);
        z.clamp(0.0, (self.w - 1) as f64) as usize * self.w
            + x.clamp(0.0, (self.w - 1) as f64) as usize
    }
    /// Rebuild the distance to existing arterials after each route.
    fn mark_roads(&mut self, polylines: &[Vec<Point>]) {
        let mut mask = vec![0; self.w * self.w];
        for line in polylines {
            for w in line.windows(2) {
                let a = w[0];
                let b = w[1];
                let steps = (dist(a, b) / (self.cell * 0.5)).ceil() as usize;
                for s in 0..=steps {
                    mask[self.index(lerp(a, b, s as f64 / steps as f64))] = 1;
                }
            }
        }
        let d = distance_transform(&mask, self.w, self.w);
        for (i, &v) in d.iter().enumerate() {
            self.road_distance[i] = (f64::from(v) * self.cell) as f32;
        }
    }
}
struct Route {
    points: Vec<Point>,
    bridges: Vec<bool>,
}
// Keep the TypeScript binary heap's strict child selection and equal-key behavior.
struct Heap {
    keys: Vec<f64>,
    vals: Vec<usize>,
}
impl Heap {
    fn push(&mut self, key: f64, val: usize) {
        let mut i = self.keys.len();
        self.keys.push(key);
        self.vals.push(val);
        while i > 0 {
            let p = (i - 1) >> 1;
            if self.keys[p] <= self.keys[i] {
                break;
            }
            self.keys.swap(p, i);
            self.vals.swap(p, i);
            i = p;
        }
    }
    fn pop(&mut self) -> usize {
        let val = self.vals[0];
        let last_key = self.keys.pop().unwrap();
        let last_val = self.vals.pop().unwrap();
        if !self.keys.is_empty() {
            self.keys[0] = last_key;
            self.vals[0] = last_val;
            let mut i = 0;
            loop {
                let mut c = i * 2 + 1;
                if c >= self.keys.len() {
                    break;
                }
                if c + 1 < self.keys.len() && self.keys[c + 1] < self.keys[c] {
                    c += 1;
                }
                if self.keys[i] <= self.keys[c] {
                    break;
                }
                self.keys.swap(c, i);
                self.vals.swap(c, i);
                i = c;
            }
        }
        val
    }
}
fn route_arterial(grid: &CostGrid<'_>, from: Point, to: Point, kind: RoadKind) -> Option<Route> {
    let w = grid.w;
    let cell = grid.cell;
    let max_grade = if kind == RoadKind::Highway { 0.07 } else { 0.1 };
    let max_bridge = 7.0 * cell;
    let start = grid.index(from);
    let goal = grid.index(to);
    let mut g = vec![f64::INFINITY; w * w];
    let mut parent = vec![-1isize; w * w];
    let mut closed = vec![false; w * w];
    let mut heap = Heap {
        keys: vec![],
        vals: vec![],
    };
    let gx = goal % w;
    let gz = (goal - gx) / w;
    let heuristic = |i: usize| {
        let x = i % w;
        let z = (i - x) / w;
        hypot(x as f64 - gx as f64, z as f64 - gz as f64) * 0.95
    };
    g[start] = 0.0;
    heap.push(heuristic(start), start);
    let move_cost = |i: usize, j: usize, length: f64| {
        // Sample along the move; water needs a bridge, steep grades are forbidden.
        let dh = f64::from(grid.height[j]) - f64::from(grid.height[i]);
        let grade = dh.abs() / (length * cell);
        if grade > max_grade {
            return f64::INFINITY;
        }
        let steps = (length * 2.0).ceil() as usize;
        let mut water = 0;
        let mut cost = 0.0;
        let ix = i % w;
        let iz = (i - ix) / w;
        let jx = j % w;
        let jz = (j - jx) / w;
        for s in 1..steps {
            let t = s as f64 / steps as f64;
            let x = round(ix as f64 + (jx as f64 - ix as f64) * t) as usize;
            let z = round(iz as f64 + (jz as f64 - iz as f64) * t) as usize;
            let k = z * w + x;
            if grid.blocked[k] != 0 {
                return f64::INFINITY;
            }
            if grid.water[k] != 0 {
                water += 1;
            } else {
                let rd = f64::from(grid.road_distance[k]);
                cost += 1.0
                    + 7.0 * (grade / max_grade).powi(2)
                    + 1.6 * (1.0 - f64::from(grid.desire[k]));
                cost += if rd < 70.0 {
                    2.5 * (1.0 - rd / 70.0)
                } else {
                    0.0
                };
                if rd < 1.5 * cell {
                    cost -= 0.6;
                }
            }
        }
        if water != 0 {
            if water > steps - 2 || length * cell > max_bridge {
                return f64::INFINITY;
            }
            cost += 26.0 * water as f64;
        }
        (cost / (steps - 1).max(1) as f64) * length
    };
    while !heap.keys.is_empty() {
        let i = heap.pop();
        if closed[i] {
            continue;
        }
        closed[i] = true;
        if i == goal {
            break;
        }
        let x = i % w;
        let z = (i - x) / w;
        for (dx, dz) in BASE_DIRECTIONS
            .into_iter()
            .flat_map(|(dx, dz)| [(dx, dz), (-dx, -dz)])
        {
            let nx = x as isize + dx;
            let nz = z as isize + dz;
            if nx < 0 || nz < 0 || nx >= w as isize || nz >= w as isize {
                continue;
            }
            let j = nz as usize * w + nx as usize;
            if closed[j] || grid.blocked[j] != 0 {
                continue;
            }
            let c = move_cost(i, j, hypot(dx as f64, dz as f64));
            if c == f64::INFINITY {
                continue;
            }
            let total = g[i] + c;
            if total < g[j] {
                g[j] = total;
                parent[j] = i as isize;
                heap.push(total + heuristic(j), j);
            }
        }
    }
    if parent[goal] < 0 && goal != start {
        return None;
    }
    let mut cells = vec![];
    let mut i = goal as isize;
    while i >= 0 {
        cells.push(i as usize);
        if i == start as isize {
            break;
        }
        i = parent[i as usize];
    }
    cells.reverse();
    Some(Route {
        points: cells.iter().map(|&i| grid.world(i % w, i / w)).collect(),
        bridges: cells.iter().map(|&i| grid.water[i] == 1).collect(),
    })
}
/// Chaikin corner cutting keeps the first and last point and softens zig-zags.
fn smooth_path(points: &[Point], passes: usize) -> Vec<Point> {
    let mut out = points.to_vec();
    for _ in 0..passes {
        if out.len() < 3 {
            break;
        }
        let mut next = vec![out[0]];
        for w in out.windows(2) {
            next.push(lerp(w[0], w[1], 0.25));
            next.push(lerp(w[0], w[1], 0.75));
        }
        next.push(*out.last().unwrap());
        out = next;
    }
    out
}
fn resample(points: &[Point], spacing: f64) -> Vec<Point> {
    let mut out = vec![points[0]];
    let mut carry = 0.0;
    for w in points.windows(2) {
        let a = w[0];
        let b = w[1];
        let d = dist(a, b);
        let mut t = spacing - carry;
        while t <= d {
            out.push(lerp(a, b, t / d));
            t += spacing;
        }
        carry = d - (t - spacing);
    }
    if dist(*out.last().unwrap(), *points.last().unwrap()) > spacing * 0.3 {
        out.push(*points.last().unwrap());
    } else {
        *out.last_mut().unwrap() = *points.last().unwrap();
    }
    out
}

pub struct TensorField<'a> {
    f: &'a HeightField,
    centre: Point,
    grid_angle: f64,
    core_radius: f64,
    boundary: Vec<f32>,
    bw: usize,
    bcell: f64,
    noise: Noise,
}
impl<'a> TensorField<'a> {
    pub fn new(
        f: &'a HeightField,
        centre: Point,
        grid_angle: f64,
        core_radius: f64,
        seed: i32,
    ) -> Self {
        let bcell = 16.0;
        let bw = round(f.size / bcell) as usize + 1;
        let noise = Noise::new(&mut derive(seed, "field-noise"));
        Self {
            f,
            centre,
            grid_angle,
            core_radius,
            boundary: vec![0.0; bw * bw * 2],
            bw,
            bcell,
            noise,
        }
    }
    /// Splat a polyline's tangents into nearby cells with a linear falloff.
    pub fn add_boundary(&mut self, line: &[Point], radius: f64, weight: f64) {
        let rc = (radius / self.bcell).ceil() as isize;
        for w in line.windows(2) {
            let a = w[0];
            let b = w[1];
            let d = dist(a, b);
            if d < 0.1 {
                continue;
            }
            let angle = (b.z - a.z).js_atan2(b.x - a.x);
            let tx = (2.0 * angle).js_cos();
            let tz = (2.0 * angle).js_sin();
            let steps = (d / self.bcell).ceil().max(1.0) as usize;
            for s in 0..steps {
                let p = lerp(a, b, s as f64 / steps as f64);
                let cx = round((p.x + self.f.size / 2.0) / self.bcell) as isize;
                let cz = round((p.z + self.f.size / 2.0) / self.bcell) as isize;
                for dz in -rc..=rc {
                    for dx in -rc..=rc {
                        let x = cx + dx;
                        let z = cz + dz;
                        if x < 0 || z < 0 || x >= self.bw as isize || z >= self.bw as isize {
                            continue;
                        }
                        let dd = hypot(dx as f64, dz as f64) * self.bcell;
                        if dd > radius {
                            continue;
                        }
                        let wgt = weight * (1.0 - dd / radius).powi(2);
                        let k = (z as usize * self.bw + x as usize) * 2;
                        self.boundary[k] = (f64::from(self.boundary[k]) + tx * wgt) as f32;
                        self.boundary[k + 1] = (f64::from(self.boundary[k + 1]) + tz * wgt) as f32;
                    }
                }
            }
        }
    }
    /// Major eigenvector direction (unit) and field magnitude at a point.
    pub fn at(&self, p: Point) -> (Point, f64) {
        let mut tx = 0.0;
        let mut tz = 0.0;
        let dc = dist(p, self.centre);
        // Grid in the core, fading out; radial rings beyond it.
        let grid_w = 1.2 * (1.0 - dc / (self.core_radius * 1.6)).max(0.0).js_pow(1.5);
        tx += grid_w * (2.0 * self.grid_angle).js_cos();
        tz += grid_w * (2.0 * self.grid_angle).js_sin();
        let rel = sub(p, self.centre);
        let radial_w = 0.45 * (dc / self.core_radius).min(1.0);
        let rl = or_one(hypot(rel.x, rel.z));
        let rr = Point {
            x: rel.x / rl,
            z: rel.z / rl,
        };
        // Ring direction is perpendicular to the radius; its tensor negates cos2θ/sin2θ.
        tx += -radial_w * (rr.x * rr.x - rr.z * rr.z);
        tz += -radial_w * (2.0 * rr.x * rr.z);
        let cx = round((p.x + self.f.size / 2.0) / self.bcell) as isize;
        let cz = round((p.z + self.f.size / 2.0) / self.bcell) as isize;
        if cx >= 0 && cz >= 0 && cx < self.bw as isize && cz < self.bw as isize {
            let k = (cz as usize * self.bw + cx as usize) * 2;
            tx += f64::from(self.boundary[k]);
            tz += f64::from(self.boundary[k + 1]);
        }
        // Contours: terraces on slopes, weighted by steepness.
        let e = self.f.cell;
        let gx = (sample(self.f, p.x + e, p.z) - sample(self.f, p.x - e, p.z)) / (2.0 * e);
        let gz = (sample(self.f, p.x, p.z + e) - sample(self.f, p.x, p.z - e)) / (2.0 * e);
        let s = hypot(gx, gz);
        if s > 0.02 {
            let cw = 1.6 * ((s - 0.02) / 0.1).min(1.0);
            let ca = gz.js_atan2(gx) + PI / 2.0;
            tx += cw * (2.0 * ca).js_cos();
            tz += cw * (2.0 * ca).js_sin();
        }
        let magnitude = hypot(tx, tz);
        let mut angle = tz.js_atan2(tx) / 2.0;
        // Organic drift outside the core.
        let organic = ((dc - self.core_radius * 0.8) / self.core_radius).clamp(0.0, 1.0);
        angle += organic
            * 0.45
            * self
                .noise
                .fbm(p.x / 260.0 + 3.0, p.z / 260.0 - 8.0, 2, 2.0, 0.5);
        (
            Point {
                x: angle.js_cos(),
                z: angle.js_sin(),
            },
            magnitude,
        )
    }
}

#[derive(Clone, Copy)]
struct Sample {
    point: Point,
    tx: f64,
    tz: f64,
    cls: i32,
}
struct SampleIndex {
    cells: HashMap<(i64, i64), Vec<Sample>>,
    cell: f64,
}
impl SampleIndex {
    fn new(cell: f64) -> Self {
        Self {
            cells: HashMap::new(),
            cell,
        }
    }
    fn add(&mut self, s: Sample) {
        let key = (
            (s.point.x / self.cell).floor() as i64,
            (s.point.z / self.cell).floor() as i64,
        );
        self.cells.entry(key).or_default().push(s);
    }
    /// Nearest sample within radius, optionally restricted to one class.
    fn nearest(&self, x: f64, z: f64, radius: f64, cls: Option<i32>) -> Option<Sample> {
        let mut best = None;
        let mut best_d = radius;
        let r = (radius / self.cell).ceil() as i64;
        let cx = (x / self.cell).floor() as i64;
        let cz = (z / self.cell).floor() as i64;
        for i in -r..=r {
            for j in -r..=r {
                let Some(list) = self.cells.get(&(cx + i, cz + j)) else {
                    continue;
                };
                for &s in list {
                    if cls.is_some_and(|cls| s.cls != cls) {
                        continue;
                    }
                    let d = hypot(s.point.x - x, s.point.z - z);
                    if d < best_d {
                        best_d = d;
                        best = Some(s);
                    }
                }
            }
        }
        best
    }
}
#[derive(Clone, Copy)]
struct TraceParams {
    dsep: f64,
    dtest: f64,
    max_length: f64,
    min_desire: f64,
    max_slope: f64,
}

struct RoadEnvironment<'a> {
    f: &'a HeightField,
    hydro: &'a Hydrology,
    desirability: &'a [f32],
}
impl RoadEnvironment<'_> {
    fn is_land(&self, p: Point) -> bool {
        sample(self.f, p.x, p.z) > 0.3
    }
    fn slope_at(&self, p: Point) -> f64 {
        // A two-cell baseline ignores single-cell roughness a road would grade over.
        let e = self.f.cell * 2.0;
        hypot(
            (sample(self.f, p.x + e, p.z) - sample(self.f, p.x - e, p.z)) / (2.0 * e),
            (sample(self.f, p.x, p.z + e) - sample(self.f, p.x, p.z - e)) / (2.0 * e),
        )
    }
    fn index(&self, p: Point) -> Option<usize> {
        let x = round((p.x + self.f.size / 2.0) / self.f.cell);
        let z = round((p.z + self.f.size / 2.0) / self.f.cell);
        if x < 0.0 || z < 0.0 || x >= self.f.w as f64 || z >= self.f.h as f64 {
            None
        } else {
            Some(z as usize * self.f.w + x as usize)
        }
    }
    fn water_distance(&self, p: Point) -> f64 {
        self.index(p)
            .map_or(0.0, |i| f64::from(self.hydro.water_distance[i]))
    }
    fn desire_at(&self, p: Point) -> f64 {
        self.index(p)
            .map_or(0.0, |i| f64::from(self.desirability[i]))
    }
}
/// Insert a polyline; snapping can sever it at existing roads. A rejected segment
/// continues from the first nearby node, exactly as in the TypeScript closure.
fn insert_polyline(
    graph: &mut GraphBuilder,
    points: &[Point],
    kind: RoadKind,
    bridges: Option<&[bool]>,
    snap: f64,
) {
    if points.len() < 2 {
        return;
    }
    let mut start_near = graph.nodes_near(points[0].x, points[0].z, snap);
    let mut from;
    if !start_near.is_empty() {
        start_near.sort_by(|&a, &b| {
            dist(graph.nodes[a].point, points[0])
                .partial_cmp(&dist(graph.nodes[b].point, points[0]))
                .unwrap()
        });
        from = start_near[0];
    } else {
        from = graph.add_node(points[0].x, points[0].z);
    }
    for i in 1..points.len() {
        let target = points[i];
        if dist(graph.nodes[from].point, target) < 6.0 && i < points.len() - 1 {
            continue;
        }
        let result = graph.insert(
            from,
            target,
            kind,
            SnapOptions {
                snap,
                ..Default::default()
            },
            bridges.map(|b| b[i]).unwrap_or(false),
        );
        let Some(result) = result else {
            let near = graph.nodes_near(target.x, target.z, snap);
            if near.is_empty() {
                return;
            }
            from = near[0];
            continue;
        };
        from = result.node;
    }
}
#[derive(Default, Debug)]
struct StreetStats {
    seeds: usize,
    blocked: usize,
    traced: usize,
    short: usize,
}
struct Level {
    params: TraceParams,
    spacing: fn(f64) -> f64,
    kind: fn(Point, Point, f64) -> RoadKind,
}

/// Stage 2: least-cost arterials between settlement anchors, then tensor-field
/// hyperstreamlines. All roads share one planar graph with snapping and cleanup.
pub fn generate_roads(input: &RoadInputs, mut progress: Option<&mut dyn FnMut(&str)>) -> RoadGraph {
    let f = &input.field;
    let hydro = &input.hydro;
    let desirability = &input.desirability;
    let centre = input.centre;
    let seed = input.seed;
    let mut rng = derive(seed, "roads");
    let mut graph = GraphBuilder::new();
    let mut grid = CostGrid::new(f, hydro, desirability, 12.0);
    let anchors = pick_anchors(f, hydro, desirability, centre, &mut rng);
    let mut arterials = vec![];
    let env = RoadEnvironment {
        f,
        hydro,
        desirability,
    };
    if let Some(p) = progress.as_mut() {
        p("arterials");
    }
    let connections = anchor_connections(&anchors, &grid);
    for (i, j, kind) in connections {
        let Some(route) = route_arterial(&grid, anchors[i], anchors[j], kind) else {
            continue;
        };
        // Keep bridge runs straight: smooth only land stretches. The oracle
        // currently smooths route.points unconditionally and derives bridge flags anew.
        let smoothed = smooth_path(&route.points, 2);
        let pts = resample(&smoothed, 26.0);
        let bridges: Vec<_> = pts
            .iter()
            .map(|&p| env.water_distance(p) < road_width(kind) / 2.0 + 2.0)
            .collect();
        // A segment is a bridge when either endpoint lies over water.
        let seg_bridge: Vec<_> = (0..pts.len())
            .map(|k| k > 0 && (bridges[k] || bridges[k - 1]))
            .collect();
        insert_polyline(&mut graph, &pts, kind, Some(&seg_bridge), 22.0);
        arterials.push(pts);
        grid.mark_roads(&arterials);
        // route.bridges is constructed by route_arterial, but unused by TS too.
        let _ = route.bridges;
    }
    if let Some(p) = progress.as_mut() {
        p("streets");
    }
    let core_radius = 420.0;
    let mut tensor = TensorField::new(f, centre, rng() * PI, core_radius, seed);
    for line in &arterials {
        tensor.add_boundary(line, 220.0, 2.2);
    }
    for river in &hydro.rivers {
        tensor.add_boundary(&river.points, 160.0, 1.4);
    }
    for ring in coastlines(f) {
        tensor.add_boundary(&ring, 200.0, 1.2);
    }
    let mut samples = SampleIndex::new(24.0);
    // Existing arterials are obstacles for both street directions.
    for line in &arterials {
        for w in line.windows(2) {
            let a = w[0];
            let b = w[1];
            let t = norm(sub(b, a));
            let steps = (dist(a, b) / 8.0).ceil() as usize;
            for s in 0..=steps {
                let p = lerp(a, b, s as f64 / steps as f64);
                samples.add(Sample {
                    point: p,
                    tx: t.x,
                    tz: t.z,
                    cls: -1,
                });
            }
        }
    }
    // Street spacing grows as desirability falls: tight core blocks, loose suburbs.
    let levels = [
        Level {
            params: TraceParams {
                dsep: 240.0,
                dtest: 80.0,
                max_length: 1600.0,
                min_desire: 0.12,
                max_slope: 0.14,
            },
            spacing: |d| 170.0 + 150.0 * (1.0 - d),
            kind: |p, c, r| {
                if dist(p, c) < r {
                    RoadKind::Avenue
                } else {
                    RoadKind::Street
                }
            },
        },
        Level {
            params: TraceParams {
                dsep: 110.0,
                dtest: 42.0,
                max_length: 1000.0,
                min_desire: 0.18,
                max_slope: 0.16,
            },
            spacing: |d| 80.0 + 95.0 * (1.0 - d),
            kind: |_, _, _| RoadKind::Street,
        },
    ];
    // Seed order: most desirable cells first, so the core fills before suburbs.
    let mut seed_order = vec![];
    let lattice = round(24.0 / f.cell).max(1.0) as usize;
    for z in (1..f.h - 1).step_by(lattice) {
        for x in (1..f.w - 1).step_by(lattice) {
            let i = z * f.w + x;
            if f64::from(desirability[i]) > 0.12 {
                seed_order.push(i);
            }
        }
    }
    seed_order.sort_by(|&a, &b| {
        desirability[b]
            .partial_cmp(&desirability[a])
            .unwrap()
            .then_with(|| a.cmp(&b))
    });
    let mut class_id = 0;
    let mut stats = StreetStats::default();
    let mut reasons = HashMap::new();
    for level in levels {
        for major in [true, false] {
            let cls = class_id;
            class_id += 1;
            // Jobard–Lefer: accepted lines propose seeds one spacing away on both
            // sides, packing lines instead of leaving twice-spacing gaps.
            let mut queue = VecDeque::new();
            let mut attempt = |seed: Point, desire: f64, queue: &mut VecDeque<Point>| {
                stats.seeds += 1;
                if desire < level.params.min_desire {
                    return false;
                }
                let dsep = (level.spacing)(desire);
                // Crossing classes/arterials only stop parallel traces; a class
                // keeps its own separation distance.
                if samples
                    .nearest(seed.x, seed.z, dsep * 0.92, Some(cls))
                    .is_some()
                {
                    stats.blocked += 1;
                    return false;
                }
                if env.water_distance(seed) < 20.0 || !env.is_land(seed) {
                    return false;
                }
                let line = trace_streamline(
                    seed,
                    major,
                    TraceParams {
                        dsep,
                        dtest: dsep * 0.45,
                        ..level.params
                    },
                    &tensor,
                    &samples,
                    cls,
                    &env,
                    &mut reasons,
                );
                let Some(line) = line.filter(|line| line.len() >= 3) else {
                    stats.short += 1;
                    return false;
                };
                stats.traced += 1;
                let kind = (level.kind)(seed, centre, core_radius);
                let pts = resample(&line, 22.0);
                for k in 0..pts.len() {
                    let p = pts[k];
                    let t = norm(sub(
                        pts[(pts.len() - 1).min(k + 1)],
                        pts[k.saturating_sub(1)],
                    ));
                    samples.add(Sample {
                        point: p,
                        tx: t.x,
                        tz: t.z,
                        cls,
                    });
                    if k % 2 == 0 {
                        for side in [-1.0, 1.0] {
                            let spacing = (level.spacing)(env.desire_at(p));
                            queue.push_back(Point {
                                x: p.x - t.z * spacing * side,
                                z: p.z + t.x * spacing * side,
                            });
                        }
                    }
                }
                insert_polyline(&mut graph, &pts, kind, None, 14.0);
                true
            };
            for &i in &seed_order {
                if f64::from(desirability[i]) < level.params.min_desire {
                    break;
                }
                let x = i % f.w;
                if !attempt(
                    to_world(f, x, (i - x) / f.w),
                    f64::from(desirability[i]),
                    &mut queue,
                ) {
                    continue;
                }
                while let Some(candidate) = queue.pop_front() {
                    attempt(candidate, env.desire_at(candidate), &mut queue);
                }
            }
        }
    }
    if input.debug {
        eprintln!(
            "streets {stats:?} {reasons:?} anchors {} edges {}",
            anchors.len(),
            graph.edges.iter().filter(|e| e.alive).count()
        );
    }
    if let Some(p) = progress.as_mut() {
        p("cleanup");
    }
    // Connectors keep to the same ground streets may be traced over.
    let can_build = |a: Point, b: Point| {
        let steps = (dist(a, b) / 4.0).ceil() as usize;
        for i in 1..steps {
            let p = lerp(a, b, i as f64 / steps as f64);
            if !env.is_land(p) || env.water_distance(p) < 12.0 || env.slope_at(p) > 0.16 {
                return false;
            }
        }
        true
    };
    graph.cleanup(CleanupOptions {
        min_edge: 12.0,
        min_stub: 65.0,
        join: Some((110.0, &can_build)),
        debug: input.debug,
    });
    graph.bridge_rivers(&hydro.rivers);
    if input.debug {
        eprintln!(
            "after cleanup {}",
            graph.edges.iter().filter(|e| e.alive).count()
        );
    }
    graph.to_road_graph()
}
/// The centre plus secondary nuclei on distinct desirable patches.
fn pick_anchors(
    f: &HeightField,
    hydro: &Hydrology,
    desirability: &[f32],
    centre: Point,
    rng: &mut Rng,
) -> Vec<Point> {
    let mut anchors = vec![centre];
    let wide = blur(desirability, f.w, f.h, round(160.0 / f.cell) as usize, 1);
    let mut order = vec![];
    for (i, &value) in wide.iter().enumerate() {
        if f64::from(value) > 0.04 {
            order.push(i);
        }
    }
    order.sort_by(|&a, &b| {
        wide[b]
            .partial_cmp(&wide[a])
            .unwrap()
            .then_with(|| a.cmp(&b))
    });
    for i in order {
        if anchors.len() >= 7 {
            break;
        }
        let x = i % f.w;
        let p = to_world(f, x, (i - x) / f.w);
        if anchors.iter().any(|&a| dist(a, p) < 620.0) {
            continue;
        }
        if hydro.water_distance[i] < 30.0 || cell_slope(f, x, (i - x) / f.w) > 0.08 {
            continue;
        }
        anchors.push(Point {
            x: p.x + (rng() - 0.5) * 20.0,
            z: p.z + (rng() - 0.5) * 20.0,
        });
    }
    anchors
}
/// Relative-neighbourhood graph on the anchors: radials plus a loose ring.
fn anchor_connections(anchors: &[Point], grid: &CostGrid<'_>) -> Vec<(usize, usize, RoadKind)> {
    let mut out = vec![];
    for i in 0..anchors.len() {
        for j in i + 1..anchors.len() {
            let d = dist(anchors[i], anchors[j]);
            let mut lune = false;
            for k in 0..anchors.len() {
                if lune {
                    break;
                }
                if k != i
                    && k != j
                    && dist(anchors[k], anchors[i]) < d
                    && dist(anchors[k], anchors[j]) < d
                {
                    lune = true;
                }
            }
            if !lune {
                out.push((
                    i,
                    j,
                    if i == 0 && d > 700.0 {
                        RoadKind::Highway
                    } else {
                        RoadKind::Avenue
                    },
                ));
            }
        }
    }
    // Route centre connections first so secondary routes can merge into them.
    out.sort_by(|a, b| {
        let pa = if a.0 == 0 { -1 } else { 0 };
        let pb = if b.0 == 0 { -1 } else { 0 };
        pa.cmp(&pb)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });
    let _ = grid;
    out
}
/// Shoreline rings so streets near the coast run parallel to it.
fn coastlines(f: &HeightField) -> Vec<Vec<Point>> {
    let mut rings = vec![];
    let step = 4;
    // Coarse row scan samples zero crossings as chains of short tangents.
    for z in (step..f.h.saturating_sub(step)).step_by(step) {
        let mut line = vec![];
        for x in 1..f.w {
            let a = f64::from(f.data[z * f.w + x - 1]);
            let b = f64::from(f.data[z * f.w + x]);
            if (a <= 0.0) != (b <= 0.0) {
                let t = a / (a - b);
                line.push(Point {
                    x: (x as f64 - 1.0 + t) * f.cell - f.size / 2.0,
                    z: z as f64 * f.cell - f.size / 2.0,
                });
            }
        }
        if line.len() > 1 {
            rings.push(line);
        }
    }
    // Vertical scan supplies tangents for north/south-facing shores as well.
    let mut out = vec![];
    for x in (step..f.w.saturating_sub(step)).step_by(step) {
        for z in 1..f.h {
            let a = f64::from(f.data[(z - 1) * f.w + x]);
            let b = f64::from(f.data[z * f.w + x]);
            if (a <= 0.0) != (b <= 0.0) {
                let p = Point {
                    x: x as f64 * f.cell - f.size / 2.0,
                    z: (z as f64 - 1.0 + a / (a - b)) * f.cell - f.size / 2.0,
                };
                let gx = f64::from(f.data[z * f.w + (f.w - 1).min(x + 1)])
                    - f64::from(f.data[z * f.w + x.saturating_sub(1)]);
                let gz = f64::from(f.data[(f.h - 1).min(z + 1) * f.w + x])
                    - f64::from(f.data[z.saturating_sub(1) * f.w + x]);
                let l = or_one(hypot(gx, gz));
                out.push(vec![
                    Point {
                        x: p.x - (gz / l) * 6.0,
                        z: p.z + (gx / l) * 6.0,
                    },
                    Point {
                        x: p.x + (gz / l) * 6.0,
                        z: p.z - (gx / l) * 6.0,
                    },
                ]);
            }
        }
    }
    for r in rings {
        for w in r.windows(2) {
            if dist(w[0], w[1]) < f.cell * 3.0 {
                out.push(w.to_vec());
            }
        }
    }
    out
}
#[allow(clippy::too_many_arguments)]
fn trace_streamline(
    seed: Point,
    major: bool,
    params: TraceParams,
    tensor: &TensorField<'_>,
    samples: &SampleIndex,
    cls: i32,
    env: &RoadEnvironment<'_>,
    reasons: &mut HashMap<&'static str, usize>,
) -> Option<Vec<Point>> {
    let step = 5.0;
    let mut stop = |why| {
        *reasons.entry(why).or_default() += 1;
    };
    let direction = |p: Point, previous: Option<Point>| {
        let (tdir, magnitude) = tensor.at(p);
        if magnitude < 0.03 {
            return None;
        }
        let mut d = if major {
            tdir
        } else {
            Point {
                x: -tdir.z,
                z: tdir.x,
            }
        };
        if previous.is_some_and(|prev| d.x * prev.x + d.z * prev.z < 0.0) {
            d = Point { x: -d.x, z: -d.z };
        }
        Some(d)
    };
    let mut trace = |sign: f64| {
        let mut out = vec![];
        let mut p = seed;
        let mut length = 0.0;
        let mut turned = 0.0;
        let Some(first) = direction(p, None) else {
            return out;
        };
        let mut prev = Point {
            x: first.x * sign,
            z: first.z * sign,
        };
        while length < params.max_length / 2.0 {
            // Midpoint integration keeps lines smooth without an RK4 budget.
            let Some(d1) = direction(p, Some(prev)) else {
                stop("degenerate");
                break;
            };
            let mid = Point {
                x: p.x + (d1.x * step) / 2.0,
                z: p.z + (d1.z * step) / 2.0,
            };
            let d2 = direction(mid, Some(d1)).unwrap_or(d1);
            let next = Point {
                x: p.x + d2.x * step,
                z: p.z + d2.z * step,
            };
            if !env.is_land(next) || env.water_distance(next) < 12.0 {
                stop("water");
                break;
            }
            if env.slope_at(next) > params.max_slope {
                stop("slope");
                break;
            }
            if env.desire_at(next) < params.min_desire * 0.6 {
                stop("desire");
                break;
            }
            turned += (d2.x * prev.z - d2.z * prev.x)
                .js_atan2(d2.x * prev.x + d2.z * prev.z)
                .abs();
            if turned > PI * 1.1 {
                stop("turned");
                break;
            }
            // Same-class lines keep separation; other roads only stop a nearly
            // parallel trace within overlapping distance, allowing crossings.
            if samples
                .nearest(next.x, next.z, params.dtest, Some(cls))
                .is_some()
            {
                out.push(next);
                stop("same-class");
                break;
            }
            if samples
                .nearest(next.x, next.z, 26.0, None)
                .is_some_and(|near| (near.tx * d2.x + near.tz * d2.z).abs() > 0.9)
            {
                out.push(next);
                stop("parallel");
                break;
            }
            out.push(next);
            length += step;
            prev = d2;
            p = next;
        }
        out
    };
    let mut forward = trace(1.0);
    let mut backward = trace(-1.0);
    // Dangling ends look ahead for a nearby road to join, as ProbableTrain does.
    for half in [&mut forward, &mut backward] {
        let Some(&tip) = half.last() else {
            continue;
        };
        if let Some(near) = samples.nearest(tip.x, tip.z, params.dtest * 1.6, None)
            && dist(near.point, tip) > 1.0
        {
            half.push(near.point);
        }
    }
    let length = forward.len() + backward.len();
    backward.reverse();
    let mut line = backward;
    line.push(seed);
    line.extend(forward);
    if length as f64 * step < params.dsep * 0.9 {
        return None;
    }
    Some(line)
}

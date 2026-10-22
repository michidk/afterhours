//! Native translation of every helper and placement stage in
//! `scripts/mapgen-features.ts`. Iteration order is part of the artifact format.
use crate::city_geometry::{
    LIMIT, SIDEWALK, TERRAIN_SIDE, TERRAIN_STEP, WATER_LEVEL, terrain_height,
};
use crate::city_types::{Airport, Building, Harbour, Marking, Racetrack, Road, Spot, TownHall};
use crate::geom::{
    closest_on_segment, convex_overlap, dist, point_in_polygon, rotated_rect, self_intersects,
};
use crate::js_math::{atan2 as js_atan2, cos as js_cos, sin as js_sin};
use crate::random::{Rng, derive};
use crate::types::{GeneratedMap, Point};
use std::f64::consts::PI;

fn js_round(v: f64) -> f64 {
    let floor = v.floor();
    if v - floor < 0.5 { floor } else { floor + 1.0 }
}
fn round(v: f64) -> f64 {
    js_round(v * 100.0) / 100.0 + 0.0
}
const TILE: f64 = 16.0;

/// Bounds captured before feature placement, exactly as in cityFromMap.
pub struct PavedRing {
    pub ring: Vec<Point>,
    pub x0: f64,
    pub x1: f64,
    pub z0: f64,
    pub z1: f64,
}
impl PavedRing {
    pub fn new(ring: Vec<Point>) -> Self {
        let (mut x0, mut x1, mut z0, mut z1) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for p in &ring {
            x0 = x0.min(p.x);
            x1 = x1.max(p.x);
            z0 = z0.min(p.z);
            z1 = z1.max(p.z);
        }
        Self {
            ring,
            x0,
            x1,
            z0,
            z1,
        }
    }
}
pub struct FeatureContext<'a> {
    pub map: &'a GeneratedMap,
    pub heights: Vec<f64>,
    pub roads: Vec<Road>,
    pub buildings: Vec<Building>,
    pub asphalt: Vec<Vec<f64>>,
    pub sidewalks: Vec<Vec<f64>>,
    pub markings: Vec<Marking>,
    pub taken: Vec<Vec<Point>>,
    pub paved_rings: Vec<PavedRing>,
    pub wet: Vec<u8>,
}
impl FeatureContext<'_> {
    pub fn paved(&self, p: Point) -> bool {
        self.paved_rings.iter().any(|a| {
            p.x >= a.x0 && p.x <= a.x1 && p.z >= a.z0 && p.z <= a.z1 && point_in_polygon(p, &a.ring)
        })
    }
    fn wet_at(&self, p: Point) -> bool {
        grid_index(p)
            .and_then(|i| self.wet.get(i))
            .is_some_and(|v| *v != 0)
    }
}
pub fn ground_at(ctx: &FeatureContext<'_>, p: Point) -> f64 {
    terrain_height(p.x, p.z, &ctx.heights)
}
fn grid_index(p: Point) -> Option<usize> {
    let i = js_round((p.z + LIMIT) / TERRAIN_STEP) * TERRAIN_SIDE as f64
        + js_round((p.x + LIMIT) / TERRAIN_STEP);
    if i >= 0.0 { Some(i as usize) } else { None }
}
fn inside_world(p: Point, margin: f64) -> bool {
    p.x.abs() < LIMIT - margin && p.z.abs() < LIMIT - margin
}

pub fn wet_mask(map: &GeneratedMap) -> Vec<u8> {
    let f = &map.shaped;
    let mut wet = vec![0; f.w * f.h];
    let mark = |wet: &mut [u8], cx: i32, cz: i32, reach: i32| {
        for dz in -reach..=reach {
            for dx in -reach..=reach {
                let x = cx + dx;
                let z = cz + dz;
                if x >= 0 && z >= 0 && (x as usize) < f.w && (z as usize) < f.h {
                    wet[z as usize * f.w + x as usize] = 1;
                }
            }
        }
    };
    for z in 0..f.h {
        for x in 0..f.w {
            let q = Point {
                x: x as f64 * f.cell - f.size / 2.0,
                z: z as f64 * f.cell - f.size / 2.0,
            };
            if map
                .lakes
                .iter()
                .any(|lake| point_in_polygon(q, &lake.outline))
            {
                mark(&mut wet, x as i32, z as i32, 3);
            }
        }
    }
    for river in &map.rivers {
        for (i, r) in river.points.iter().enumerate() {
            mark(
                &mut wet,
                js_round((r.x + f.size / 2.0) / f.cell) as i32,
                js_round((r.z + f.size / 2.0) / f.cell) as i32,
                ((river.widths[i] / 2.0 + 4.0) / f.cell).ceil() as i32,
            );
        }
    }
    wet
}
struct Frame {
    centre: Point,
    c: f64,
    s: f64,
}
fn frame(centre: Point, angle: f64) -> Frame {
    Frame {
        centre,
        c: js_cos(angle),
        s: js_sin(angle),
    }
}
impl Frame {
    fn at(&self, u: f64, v: f64) -> Point {
        Point {
            x: self.centre.x + u * self.c - v * self.s,
            z: self.centre.z + u * self.s + v * self.c,
        }
    }
    fn local(&self, p: Point) -> (f64, f64) {
        (
            (p.x - self.centre.x) * self.c + (p.z - self.centre.z) * self.s,
            -(p.x - self.centre.x) * self.s + (p.z - self.centre.z) * self.c,
        )
    }
    fn facing(&self, sign: f64) -> f64 {
        js_atan2(-self.s * sign, self.c * sign)
    }
}
fn flat(points: &[Point], y: f64) -> Vec<f64> {
    points
        .iter()
        .flat_map(|p| [round(p.x), round(y), round(p.z)])
        .collect()
}
fn tiles(f: &Frame, u0: f64, u1: f64, v0: f64, v1: f64) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    let n = ((u1 - u0) / TILE).ceil().max(1.0) as usize;
    let m = ((v1 - v0) / TILE).ceil().max(1.0) as usize;
    for i in 0..n {
        for j in 0..m {
            let a = u0 + ((u1 - u0) * i as f64) / n as f64;
            let b = u0 + ((u1 - u0) * (i + 1) as f64) / n as f64;
            let c = v0 + ((v1 - v0) * j as f64) / m as f64;
            let d = v0 + ((v1 - v0) * (j + 1) as f64) / m as f64;
            out.push(vec![f.at(a, c), f.at(b, c), f.at(b, d), f.at(a, d)]);
        }
    }
    out
}
fn near_road(roads: &[Road], ring: &[Point], pad: f64) -> bool {
    let c = ring.iter().fold(Point { x: 0.0, z: 0.0 }, |s, p| Point {
        x: s.x + p.x / ring.len() as f64,
        z: s.z + p.z / ring.len() as f64,
    });
    let reach = ring
        .iter()
        .map(|p| dist(*p, c))
        .fold(f64::NEG_INFINITY, f64::max)
        + pad;
    roads.iter().any(|r| {
        let a = Point { x: r.ax, z: r.az };
        let b = Point { x: r.bx, z: r.bz };
        if dist(closest_on_segment(c, a, b).0, c) > reach + r.width / 2.0 {
            return false;
        }
        let steps = (dist(a, b) / 4.0).ceil() as usize;
        for i in 0..=steps {
            let p = Point {
                x: a.x + ((b.x - a.x) * i as f64) / steps as f64,
                z: a.z + ((b.z - a.z) * i as f64) / steps as f64,
            };
            if point_in_polygon(p, ring) {
                return true;
            }
            for k in 0..ring.len() {
                if dist(
                    closest_on_segment(p, ring[k], ring[(k + 1) % ring.len()]).0,
                    p,
                ) < pad + r.width / 2.0
                {
                    return true;
                }
            }
        }
        false
    })
}
fn overlaps_taken(ctx: &FeatureContext<'_>, ring: &[Point]) -> bool {
    ctx.taken.iter().any(|t| convex_overlap(t, ring))
}
fn bp(b: &Building) -> Point {
    Point { x: b.x, z: b.z }
}
fn rp(r: &Road) -> Point {
    Point { x: r.x, z: r.z }
}
fn overlaps_building(ctx: &FeatureContext<'_>, ring: &[Point]) -> bool {
    ctx.buildings.iter().any(|b| {
        crate::js_math::hypot(b.x - ring[0].x, b.z - ring[0].z) < 400.0
            && convex_overlap(&rotated_rect(bp(b), b.w, b.d, b.angle.unwrap_or(0.0)), ring)
    })
}
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn stamp_rect(
    ctx: &mut FeatureContext<'_>,
    centre: Point,
    w: f64,
    d: f64,
    angle: f64,
    level: f64,
    margin: f64,
    only: Option<&dyn Fn(Point, f64) -> bool>,
) {
    let f = frame(centre, angle);
    let reach = crate::js_math::hypot(w, d) / 2.0 + margin + TERRAIN_STEP;
    let z0 = ((centre.z - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize;
    let z1 = ((centre.z + reach + LIMIT) / TERRAIN_STEP)
        .ceil()
        .min((TERRAIN_SIDE - 1) as f64) as usize;
    let x0 = ((centre.x - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize;
    let x1 = ((centre.x + reach + LIMIT) / TERRAIN_STEP)
        .ceil()
        .min((TERRAIN_SIDE - 1) as f64) as usize;
    for gz in z0..=z1 {
        for gx in x0..=x1 {
            let p = Point {
                x: gx as f64 * TERRAIN_STEP - LIMIT,
                z: gz as f64 * TERRAIN_STEP - LIMIT,
            };
            let (u, v) = f.local(p);
            let du = 0.0_f64.max(u.abs() - w / 2.0);
            let dv = 0.0_f64.max(v.abs() - d / 2.0);
            let out = crate::js_math::hypot(du, dv);
            if out > TERRAIN_STEP + margin {
                continue;
            }
            let i = gz * TERRAIN_SIDE + gx;
            if only.is_some_and(|test| !test(p, ctx.heights[i])) {
                continue;
            }
            if out > TERRAIN_STEP && ctx.paved(p) {
                continue;
            }
            let t = if out <= TERRAIN_STEP {
                1.0
            } else {
                0.0_f64.max(1.0 - (out - TERRAIN_STEP) / margin)
            };
            ctx.heights[i] = round(ctx.heights[i] + (level - ctx.heights[i]) * t);
        }
    }
}
fn interior(ring: &[Point], step: f64) -> Vec<Point> {
    let (mut x0, mut x1, mut z0, mut z1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for p in ring {
        x0 = x0.min(p.x);
        x1 = x1.max(p.x);
        z0 = z0.min(p.z);
        z1 = z1.max(p.z);
    }
    let mut out = Vec::new();
    let mut x = x0;
    while x <= x1 {
        let mut z = z0;
        while z <= z1 {
            let p = Point { x, z };
            if point_in_polygon(p, ring) {
                out.push(p);
            }
            z += step;
        }
        x += step;
    }
    out
}
pub fn place_town_hall(ctx: &mut FeatureContext<'_>) -> TownHall {
    try_place_town_hall(ctx).expect("No street-facing lot near downtown for the town hall")
}
fn try_place_town_hall(ctx: &mut FeatureContext<'_>) -> Result<TownHall, String> {
    let lot = 64.0;
    let depth = 58.0;
    let centre = ctx.map.centre;
    let mut candidates: Vec<Road> = ctx
        .roads
        .iter()
        .filter(|r| r.kind != "service" && crate::js_math::hypot(r.bx - r.ax, r.bz - r.az) > 8.0)
        .cloned()
        .collect();
    candidates.sort_by(|a, b| {
        dist(rp(a), centre)
            .partial_cmp(&dist(rp(b), centre))
            .unwrap()
    });
    candidates.truncate(600);
    for slack in [5.0, 8.0, 12.0] {
        for road in &candidates {
            for side in [1, -1] {
                let length = crate::js_math::hypot(road.bx - road.ax, road.bz - road.az);
                let t = Point {
                    x: (road.bx - road.ax) / length,
                    z: (road.bz - road.az) / length,
                };
                let angle = js_atan2(t.z, t.x) + if side < 0 { PI } else { 0.0 };
                let n = Point {
                    x: -js_sin(angle),
                    z: js_cos(angle),
                };
                let setback = road.width / 2.0 + SIDEWALK + 1.5 + depth / 2.0;
                let middle = Point {
                    x: road.x + n.x * setback,
                    z: road.z + n.z * setback,
                };
                let ring = rotated_rect(middle, lot, depth, angle);
                if !inside_world(middle, 80.0) || overlaps_taken(ctx, &ring) {
                    continue;
                }
                let same_street = |r: &Road| {
                    let len = crate::js_math::hypot(r.bx - r.ax, r.bz - r.az);
                    let l = if len == 0.0 { 1.0 } else { len };
                    let turn = (t.x * (r.bz - r.az) - t.z * (r.bx - r.ax)).abs() / l;
                    let off_line = (t.x * (r.z - road.z) - t.z * (r.x - road.x)).abs();
                    turn < 0.35 && off_line < 4.0
                };
                let other: Vec<_> = ctx
                    .roads
                    .iter()
                    .filter(|r| !same_street(r))
                    .cloned()
                    .collect();
                if near_road(&other, &ring, 2.0) {
                    continue;
                }
                let samples = interior(&ring, 4.0);
                let (mut lo, mut hi, mut fail) = (f64::INFINITY, f64::NEG_INFINITY, false);
                for p in samples {
                    let h = ground_at(ctx, p);
                    lo = lo.min(h);
                    hi = hi.max(h);
                    if ctx.paved(p) || ctx.wet_at(p) || h < WATER_LEVEL + 1.5 {
                        fail = true;
                        break;
                    }
                }
                if fail || hi - lo > slack {
                    continue;
                }
                let f = frame(middle, angle);
                let level = round(ground_at(ctx, f.at(0.0, -depth / 2.0 - 2.0)));
                stamp_rect(ctx, middle, lot, depth, angle, level, 16.0, None);
                for i in (0..ctx.buildings.len()).rev() {
                    let b = &ctx.buildings[i];
                    if dist(bp(b), middle) < 120.0
                        && convex_overlap(
                            &rotated_rect(bp(b), b.w + 4.0, b.d + 4.0, b.angle.unwrap_or(0.0)),
                            &ring,
                        )
                    {
                        ctx.buildings.remove(i);
                    }
                }
                let park_from = -depth / 2.0;
                let park_to = -9.0;
                let bay = 2.8;
                let deep = 5.5;
                let gap = 4.5;
                for tile in tiles(&f, -lot / 2.0, lot / 2.0, park_from, park_to) {
                    ctx.asphalt.push(flat(&tile, level));
                }
                for tile in tiles(&f, -lot / 2.0, lot / 2.0, park_to, -3.0) {
                    ctx.sidewalks.push(flat(&tile, level));
                }
                let mut parking = Vec::new();
                let rows = [
                    (park_from + 1.0, park_from + 1.0 + deep, -1.0, true),
                    (park_to - deep, park_to, 1.0, false),
                ];
                for (v0, v1, heading, entrance) in rows {
                    let count = ((lot - 2.0) / bay).floor() as usize;
                    let start = -(count as f64 * bay) / 2.0;
                    for k in 0..=count {
                        let u = start + k as f64 * bay;
                        if entrance && u.abs() < gap + bay / 2.0 {
                            continue;
                        }
                        ctx.markings.push(Marking {
                            color: "white".into(),
                            polygon: flat(
                                &[
                                    f.at(u - 0.07, v0),
                                    f.at(u + 0.07, v0),
                                    f.at(u + 0.07, v1),
                                    f.at(u - 0.07, v1),
                                ],
                                level,
                            ),
                        });
                        if k == count || (entrance && (u + bay / 2.0).abs() < gap + bay / 2.0) {
                            continue;
                        }
                        let spot = f.at(u + bay / 2.0, (v0 + v1) / 2.0);
                        parking.push(Spot {
                            x: round(spot.x),
                            z: round(spot.z),
                            angle: round(f.facing(heading)),
                        });
                    }
                }
                let hall = f.at(0.0, 11.0);
                ctx.buildings.push(Building {
                    x: round(hall.x),
                    z: round(hall.z),
                    w: 40.0,
                    d: 28.0,
                    y: Some(level),
                    h: round(level + 15.0),
                    angle: Some(round(js_atan2(js_sin(angle), js_cos(angle)))),
                    asset: "civic-hall".into(),
                    facing: 0.0,
                    color: "#d9cfb8".into(),
                    style: 0,
                });
                ctx.taken
                    .push(rotated_rect(middle, lot + 4.0, depth + 4.0, angle));
                let spawn = f.at(0.0, -6.0);
                return Ok(TownHall {
                    x: round(middle.x),
                    z: round(middle.z),
                    angle: round(angle),
                    spawn: Point {
                        x: round(spawn.x),
                        z: round(spawn.z),
                    },
                    parking,
                });
            }
        }
    }
    Err("No street-facing lot near downtown for the town hall".into())
}
fn closed_spline(c: &[Point], step: f64) -> Vec<Point> {
    let mut out = Vec::new();
    let n = c.len();
    for i in 0..n {
        let p0 = c[(i + n - 1) % n];
        let p1 = c[i];
        let p2 = c[(i + 1) % n];
        let p3 = c[(i + 2) % n];
        let count = (dist(p1, p2) / step).ceil().max(2.0) as usize;
        for k in 0..count {
            let t = k as f64 / count as f64;
            let (t2, t3) = (t * t, t * t * t);
            let f = |a: f64, b: f64, c: f64, d: f64| {
                0.5 * (2.0 * b
                    + (-a + c) * t
                    + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
                    + (-a + 3.0 * b - 3.0 * c + d) * t3)
            };
            out.push(Point {
                x: f(p0.x, p1.x, p2.x, p3.x),
                z: f(p0.z, p1.z, p2.z, p3.z),
            });
        }
    }
    out
}
fn resample(loop_: &[Point], step: f64) -> Vec<Point> {
    let mut lengths = vec![0.0];
    for i in 1..=loop_.len() {
        lengths.push(lengths[i - 1] + dist(loop_[i - 1], loop_[i % loop_.len()]));
    }
    let total = lengths[loop_.len()];
    let count = js_round(total / step) as usize;
    let mut out = Vec::new();
    let mut j = 0;
    for k in 0..count {
        let s = (k as f64 * total) / count as f64;
        while lengths[j + 1] < s {
            j += 1;
        }
        let a = loop_[j];
        let b = loop_[(j + 1) % loop_.len()];
        let den = lengths[j + 1] - lengths[j];
        let t = (s - lengths[j]) / if den == 0.0 { 1.0 } else { den };
        out.push(Point {
            x: a.x + (b.x - a.x) * t,
            z: a.z + (b.z - a.z) * t,
        });
    }
    out
}
fn min_radius(loop_: &[Point], span: usize) -> f64 {
    let mut r = f64::INFINITY;
    for i in 0..loop_.len() {
        let a = loop_[(i + loop_.len() - span) % loop_.len()];
        let b = loop_[i];
        let c = loop_[(i + span) % loop_.len()];
        let ab = dist(a, b);
        let bc = dist(b, c);
        let ca = dist(c, a);
        let twice = ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)).abs();
        if twice > 1e-6 {
            r = r.min((ab * bc * ca) / (2.0 * twice));
        }
    }
    r
}
fn min_separation(loop_: &[Point], step: f64, along: f64) -> f64 {
    let skip = (along / step).ceil() as usize;
    let mut best = f64::INFINITY;
    for i in (0..loop_.len()).step_by(2) {
        for j in (i + skip..loop_.len() - skip + i).step_by(2) {
            best = best.min(dist(loop_[i], loop_[j % loop_.len()]));
        }
    }
    best
}
const TRACK_WIDTH: f64 = 12.0;
pub fn place_racetrack(ctx: &mut FeatureContext<'_>) -> Racetrack {
    let mut rng = derive(ctx.map.options.seed, "racetrack");
    place_racetrack_with_rng(ctx, &mut rng)
}
pub fn place_racetrack_with_rng(ctx: &mut FeatureContext<'_>, rng: &mut Rng) -> Racetrack {
    const STEP: f64 = 2.0;
    let dry = WATER_LEVEL + 0.8;
    let layout = |site: Point, rx: f64, rz: f64, rng: &mut Rng| {
        let count = 9 + (rng() * 5.0).floor() as usize;
        let rotation = rng() * PI * 2.0;
        let mut controls = Vec::new();
        for i in 0..count {
            let theta = rotation + ((i as f64 + (rng() - 0.5) * 0.5) / count as f64) * PI * 2.0;
            let r = if rng() < 0.25 {
                0.4 + rng() * 0.2
            } else {
                0.7 + rng() * 0.3
            };
            controls.push(Point {
                x: site.x + js_cos(theta) * rx * r,
                z: site.z + js_sin(theta) * rz * r,
            });
        }
        let mut candidate = resample(&closed_spline(&controls, 1.0), 6.0);
        let mut pass = 0;
        while pass < 60 && min_radius(&candidate, 2) < 24.0 {
            candidate = candidate
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let a = candidate[(i + candidate.len() - 1) % candidate.len()];
                    let b = candidate[(i + 1) % candidate.len()];
                    Point {
                        x: p.x * 0.5 + (a.x + b.x) * 0.25,
                        z: p.z * 0.5 + (a.z + b.z) * 0.25,
                    }
                })
                .collect();
            pass += 1;
        }
        resample(&candidate, STEP)
    };
    let clear = |loop_: &[Point], roads: &[Road]| {
        loop_.iter().enumerate().all(|(i, p)| {
            if i % 2 != 0 {
                return true;
            }
            let h = ground_at(ctx, *p);
            if !inside_world(*p, 40.0)
                || h < dry
                || ctx.wet_at(*p)
                || ctx.paved(*p)
                || ctx.taken.iter().any(|ring| point_in_polygon(*p, ring))
            {
                return false;
            }
            roads.iter().all(|r| {
                dist(
                    closest_on_segment(*p, Point { x: r.ax, z: r.az }, Point { x: r.bx, z: r.bz })
                        .0,
                    *p,
                ) > TRACK_WIDTH / 2.0 + r.width / 2.0 + 8.0
            })
        }) && !ctx.buildings.iter().any(|b| {
            crate::js_math::hypot(b.x - loop_[0].x, b.z - loop_[0].z) < 600.0
                && loop_.iter().enumerate().any(|(i, p)| {
                    i % 4 == 0
                        && point_in_polygon(
                            *p,
                            &rotated_rect(
                                bp(b),
                                b.w + TRACK_WIDTH + 8.0,
                                b.d + TRACK_WIDTH + 8.0,
                                b.angle.unwrap_or(0.0),
                            ),
                        )
                })
        })
    };
    let mut selected: Option<Vec<Point>> = None;
    for (rx, rz) in [(170.0, 115.0), (140.0, 95.0), (115.0, 80.0)] {
        let mut sites: Vec<(Point, usize, f64)> = Vec::new();
        let mut z = -LIMIT + rz + 60.0;
        while z <= LIMIT - rz - 60.0 {
            let mut x = -LIMIT + rx + 60.0;
            while x <= LIMIT - rx - 60.0 {
                let c = Point { x, z };
                if dist(c, ctx.map.centre) < 300.0 {
                    x += 48.0;
                    continue;
                }
                let (mut lo, mut hi, mut dry_count, mut total) =
                    (f64::INFINITY, f64::NEG_INFINITY, 0, 0);
                let mut dz = -rz;
                while dz <= rz {
                    let mut dx = -rx;
                    while dx <= rx {
                        let p = Point {
                            x: x + dx,
                            z: z + dz,
                        };
                        let h = ground_at(ctx, p);
                        total += 1;
                        if h >= dry && !ctx.wet_at(p) {
                            dry_count += 1;
                            lo = lo.min(h);
                            hi = hi.max(h);
                        }
                        dx += 20.0;
                    }
                    dz += 20.0;
                }
                if (dry_count as f64) < total as f64 * 0.9 || hi - lo > 40.0 {
                    x += 48.0;
                    continue;
                }
                let streets = ctx
                    .roads
                    .iter()
                    .filter(|r| (r.x - x).abs() < rx + 20.0 && (r.z - z).abs() < rz + 20.0)
                    .count();
                sites.push((c, streets, hi - lo));
                x += 48.0;
            }
            z += 48.0;
        }
        sites.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.partial_cmp(&b.2).unwrap()));
        for site in sites.iter().take(30) {
            let near: Vec<_> = ctx
                .roads
                .iter()
                .filter(|r| {
                    (r.x - site.0.x).abs() < rx + 60.0 && (r.z - site.0.z).abs() < rz + 60.0
                })
                .cloned()
                .collect();
            for _attempt in 0..25 {
                if selected.is_some() {
                    break;
                }
                let candidate = layout(site.0, rx, rz, rng);
                if candidate.len() as f64 * STEP >= 2.2 * (rx + rz)
                    && min_radius(&candidate, 4) >= 20.0
                    && !self_intersects(&candidate)
                    && min_separation(&candidate, STEP, 80.0) >= TRACK_WIDTH + 30.0
                    && clear(&candidate, &near)
                {
                    selected = Some(candidate);
                }
            }
            if selected.is_some() {
                break;
            }
        }
        if selected.is_some() {
            break;
        }
    }
    let loop_ = selected.expect("Could not lay out a racetrack");
    let mut profile: Vec<f64> = loop_.iter().map(|p| ground_at(ctx, *p)).collect();
    for _ in 0..3 {
        profile = profile
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let mut sum = 0.0;
                for k in -20_i64..=20 {
                    sum += profile[(i as i64 + k + loop_.len() as i64) as usize % loop_.len()];
                }
                sum / 41.0
            })
            .collect();
    }
    let core = TRACK_WIDTH / 2.0 + 5.0;
    let feather = 22.0;
    let (mut x0, mut x1, mut z0, mut z1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for p in &loop_ {
        x0 = x0.min(p.x);
        x1 = x1.max(p.x);
        z0 = z0.min(p.z);
        z1 = z1.max(p.z);
    }
    let reach = core + feather + TERRAIN_STEP;
    let gz0 = ((z0 - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize;
    let gz1 = ((z1 + reach + LIMIT) / TERRAIN_STEP)
        .ceil()
        .min((TERRAIN_SIDE - 1) as f64) as usize;
    let gx0 = ((x0 - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize;
    let gx1 = ((x1 + reach + LIMIT) / TERRAIN_STEP)
        .ceil()
        .min((TERRAIN_SIDE - 1) as f64) as usize;
    for gz in gz0..=gz1 {
        for gx in gx0..=gx1 {
            let p = Point {
                x: gx as f64 * TERRAIN_STEP - LIMIT,
                z: gz as f64 * TERRAIN_STEP - LIMIT,
            };
            let (mut nearest, mut best) = (0, f64::INFINITY);
            for (i, q) in loop_.iter().enumerate() {
                let d = dist(p, *q);
                if d < best {
                    best = d;
                    nearest = i;
                }
            }
            if best > core + feather {
                continue;
            }
            let i = gz * TERRAIN_SIDE + gx;
            let t = if best <= core {
                1.0
            } else {
                1.0 - (best - core) / feather
            };
            ctx.heights[i] = round(ctx.heights[i] + (profile[nearest] - ctx.heights[i]) * t);
        }
    }
    let n = loop_.len();
    let normal = |i: usize| {
        let a = loop_[(i + n - 1) % n];
        let b = loop_[(i + 1) % n];
        let l = dist(a, b);
        let l = if l == 0.0 { 1.0 } else { l };
        Point {
            x: -(b.z - a.z) / l,
            z: (b.x - a.x) / l,
        }
    };
    let offset = |i: usize, d: f64| {
        let m = normal(i);
        Point {
            x: loop_[i].x + m.x * d,
            z: loop_[i].z + m.z * d,
        }
    };
    let strip = |from: usize, to: usize, a: f64, b: f64| {
        let mut out = Vec::new();
        for i in from..=to {
            let k = i % n;
            let p = offset(k, a);
            out.extend([round(p.x), round(profile[k]), round(p.z)]);
        }
        for i in (from..=to).rev() {
            let k = i % n;
            let q = offset(k, b);
            out.extend([round(q.x), round(profile[k]), round(q.z)]);
        }
        out
    };
    let piece = (TILE / STEP) as usize;
    for i in (0..n).step_by(piece) {
        let to = (i + piece).min(n);
        for k in i..to {
            ctx.asphalt
                .push(strip(k, k + 1, -TRACK_WIDTH / 2.0, TRACK_WIDTH / 2.0));
            for side in [-1.0, 1.0] {
                ctx.markings.push(Marking {
                    color: "white".into(),
                    polygon: strip(
                        k,
                        k + 1,
                        side * (TRACK_WIDTH / 2.0 - 0.5),
                        side * (TRACK_WIDTH / 2.0 - 0.8),
                    ),
                });
            }
        }
        ctx.taken.push(vec![
            offset(i % n, -core - 6.0),
            offset(to % n, -core - 6.0),
            offset(to % n, core + 6.0),
            offset(i % n, core + 6.0),
        ]);
    }
    let tangent = Point {
        x: loop_[1].x - loop_[0].x,
        z: loop_[1].z - loop_[0].z,
    };
    let tl = crate::js_math::hypot(tangent.x, tangent.z);
    let along = Point {
        x: tangent.x / tl,
        z: tangent.z / tl,
    };
    let across = normal(0);
    let square = 1.0;
    for row in 0..2 {
        for col in 0..(TRACK_WIDTH / square) as usize {
            if (row + col) % 2 != 0 {
                continue;
            }
            let a = -TRACK_WIDTH / 2.0 + col as f64 * square;
            let b = row as f64 * square - square;
            let corner = |da: f64, db: f64| Point {
                x: loop_[0].x + across.x * (a + da) + along.x * (b + db),
                z: loop_[0].z + across.z * (a + da) + along.z * (b + db),
            };
            ctx.markings.push(Marking {
                color: "white".into(),
                polygon: flat(
                    &[
                        corner(0.0, 0.0),
                        corner(square, 0.0),
                        corner(square, square),
                        corner(0.0, square),
                    ],
                    profile[0],
                ),
            });
        }
    }
    let grid = [6.0, 12.0]
        .into_iter()
        .enumerate()
        .map(|(slot, back)| {
            let k = (n - back as usize / STEP as usize) % n;
            let p = offset(k, if slot != 0 { 2.6 } else { -2.6 });
            let heading = js_atan2(along.x, along.z);
            Spot {
                x: round(p.x),
                z: round(p.z),
                angle: round(heading),
            }
        })
        .collect();
    Racetrack {
        path: loop_
            .iter()
            .flat_map(|p| [round(p.x), round(p.z)])
            .collect(),
        width: TRACK_WIDTH,
        grid,
    }
}
pub fn place_harbours(ctx: &mut FeatureContext<'_>) -> Vec<Harbour> {
    place_harbours_with_count(ctx, 3)
}
pub fn place_harbours_with_count(ctx: &mut FeatureContext<'_>, count: usize) -> Vec<Harbour> {
    let quay = 52.0;
    let apron = 30.0;
    let basin = 30.0;
    let level = round(WATER_LEVEL + 1.1);
    #[derive(Clone)]
    struct Candidate {
        at: Point,
        angle: f64,
        score: f64,
    }
    let mut found = Vec::new();
    for gz in (4..TERRAIN_SIDE - 4).step_by(2) {
        for gx in (4..TERRAIN_SIDE - 4).step_by(2) {
            let p = Point {
                x: gx as f64 * TERRAIN_STEP - LIMIT,
                z: gz as f64 * TERRAIN_STEP - LIMIT,
            };
            let h = ctx.heights[gz * TERRAIN_SIDE + gx];
            if h < WATER_LEVEL + 0.3 || h > WATER_LEVEL + 6.0 || !inside_world(p, 120.0) {
                continue;
            }
            let g = Point {
                x: ground_at(
                    ctx,
                    Point {
                        x: p.x + 24.0,
                        z: p.z,
                    },
                ) - ground_at(
                    ctx,
                    Point {
                        x: p.x - 24.0,
                        z: p.z,
                    },
                ),
                z: ground_at(
                    ctx,
                    Point {
                        x: p.x,
                        z: p.z + 24.0,
                    },
                ) - ground_at(
                    ctx,
                    Point {
                        x: p.x,
                        z: p.z - 24.0,
                    },
                ),
            };
            let gl = crate::js_math::hypot(g.x, g.z);
            if gl < 1e-3 {
                continue;
            }
            let sea = Point {
                x: -g.x / gl,
                z: -g.z / gl,
            };
            let angle = js_round(js_atan2(-sea.x, sea.z) / (PI / 2.0)) * (PI / 2.0);
            let f = frame(p, angle);
            let (mut ok, mut depth) = (true, 0.0);
            for u in [-quay / 2.0, 0.0, quay / 2.0] {
                for v in [18.0, 26.0, 36.0] {
                    let q = f.at(u, v);
                    let d = WATER_LEVEL - ground_at(ctx, q);
                    if d < 0.5 || ctx.wet_at(q) {
                        ok = false;
                    }
                    depth += d;
                }
                for v in [-4.0, -14.0, -apron + 2.0] {
                    let q = f.at(u, v);
                    let land = ground_at(ctx, q);
                    if land < WATER_LEVEL + 0.2
                        || land > WATER_LEVEL + 7.0
                        || ctx.wet_at(q)
                        || ctx.paved(q)
                    {
                        ok = false;
                    }
                }
            }
            if !ok {
                continue;
            }
            let footprint = rotated_rect(
                f.at(0.0, (basin - apron) / 2.0),
                quay + 8.0,
                apron + basin,
                angle,
            );
            if overlaps_taken(ctx, &footprint) || overlaps_building(ctx, &footprint) {
                continue;
            }
            if near_road(
                &ctx.roads,
                &rotated_rect(f.at(0.0, -apron / 2.0), quay, apron, angle),
                26.0,
            ) {
                continue;
            }
            let mut road = f64::INFINITY;
            for r in &ctx.roads {
                road = road.min(dist(
                    closest_on_segment(p, Point { x: r.ax, z: r.az }, Point { x: r.bx, z: r.bz }).0,
                    p,
                ));
            }
            found.push(Candidate {
                at: p,
                angle,
                score: depth / 9.0 - road.min(300.0) / 40.0,
            });
        }
    }
    found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    let mut chosen: Vec<Candidate> = Vec::new();
    for spacing in [700.0, 500.0, 350.0] {
        for c in &found {
            if chosen.len() >= count {
                break;
            }
            if chosen.iter().all(|o| dist(o.at, c.at) > spacing) {
                chosen.push(c.clone());
            }
        }
    }
    assert!(
        chosen.len() >= count,
        "Only {} harbour sites on the coast",
        chosen.len()
    );
    chosen
        .into_iter()
        .enumerate()
        .map(|(index, c)| {
            let f = frame(c.at, c.angle);
            stamp_rect(
                ctx,
                f.at(0.0, -apron / 2.0),
                quay,
                apron,
                c.angle,
                level,
                24.0,
                None,
            );
            stamp_rect(
                ctx,
                f.at(0.0, basin / 2.0 + 8.0),
                quay + 8.0,
                basin,
                c.angle,
                WATER_LEVEL - 4.0,
                12.0,
                Some(&|p, current| {
                    let (u, v) = f.local(p);
                    current > WATER_LEVEL - 4.0
                        && v > 6.0
                        && (u.abs() <= quay / 2.0 || current <= WATER_LEVEL)
                }),
            );
            for tile in tiles(&f, -quay / 2.0, quay / 2.0, -16.0, 5.0) {
                ctx.sidewalks.push(flat(&tile, level));
            }
            let mut u = -quay / 2.0 + 4.0;
            while u <= quay / 2.0 - 4.0 {
                ctx.markings.push(Marking {
                    color: "yellow".into(),
                    polygon: flat(
                        &[
                            f.at(u - 0.6, 4.1),
                            f.at(u + 0.6, 4.1),
                            f.at(u + 0.6, 4.5),
                            f.at(u - 0.6, 4.5),
                        ],
                        level + 0.15,
                    ),
                });
                u += 6.0;
            }
            let office = f.at(-quay / 2.0 + 9.0, -apron + 7.0);
            ctx.buildings.push(Building {
                x: round(office.x),
                z: round(office.z),
                w: 14.0,
                d: 9.0,
                y: Some(level),
                h: round(level + 6.0),
                angle: Some(round(js_atan2(js_sin(c.angle), js_cos(c.angle)))),
                asset: "warehouse".into(),
                facing: 0.0,
                color: "#b9b3a2".into(),
                style: index % 3,
            });
            ctx.taken.push(rotated_rect(
                f.at(0.0, (basin - apron) / 2.0),
                quay + 12.0,
                apron + basin + 4.0,
                c.angle,
            ));
            let berths = [-17.0, 0.0, 17.0]
                .into_iter()
                .map(|u| {
                    let p = f.at(u, 18.0);
                    Spot {
                        x: round(p.x),
                        z: round(p.z),
                        angle: round(js_atan2(js_cos(c.angle), js_sin(c.angle))),
                    }
                })
                .collect();
            let sign = f.at(0.0, -8.0);
            Harbour {
                x: round(sign.x),
                z: round(sign.z),
                angle: round(c.angle),
                berths,
            }
        })
        .collect()
}
pub fn compass(p: Point, middle: Point) -> String {
    let a = js_atan2(p.x - middle.x, p.z - middle.z);
    [
        "NORTH",
        "NORTHEAST",
        "EAST",
        "SOUTHEAST",
        "SOUTH",
        "SOUTHWEST",
        "WEST",
        "NORTHWEST",
    ][(js_round(a / (PI / 4.0)) as i32).rem_euclid(8) as usize]
        .into()
}
pub fn dress_airport(ctx: &mut FeatureContext<'_>, a: &Airport) {
    let f = frame(Point { x: a.x, z: a.z }, 0.0);
    let level = ground_at(ctx, Point { x: a.x, z: a.z });
    for (u0, u1, v0, v1) in [
        (30., 40., -90., 90.),
        (35., 95., -85., 85.),
        (11., 35., -75., -65.),
        (11., 35., 65., 75.),
        (-95., -28., -70., -30.),
    ] {
        for tile in tiles(&f, u0, u1, v0, v1) {
            ctx.asphalt.push(flat(&tile, level));
        }
    }
    for (u, v, w, d, h, asset, color) in [
        (72., -55., 36., 32., 14., "warehouse", "#93a9b6"),
        (72., 55., 36., 32., 14., "warehouse", "#a6b7bd"),
        (-62., 5., 56., 26., 10., "campus", "#d6d0b8"),
        (-87., 48., 12., 12., 25., "deco-tower", "#bdd2d3"),
    ] {
        let p = f.at(u, v);
        ctx.buildings.push(Building {
            x: p.x,
            z: p.z,
            w,
            d,
            y: Some(level),
            h: level + h,
            asset: asset.into(),
            color: color.into(),
            style: 0,
            angle: Some(0.0),
            facing: 0.0,
        });
    }
    for tile in tiles(&f, -95.0, -28.0, -28.0, -18.0) {
        ctx.sidewalks.push(flat(&tile, level));
    }
    let mut line = |u0: f64, u1: f64, v0: f64, v1: f64, color: &str| {
        ctx.markings.push(Marking {
            color: color.into(),
            polygon: flat(
                &[f.at(u0, v0), f.at(u1, v0), f.at(u1, v1), f.at(u0, v1)],
                level + 0.02,
            ),
        })
    };
    line(34.85, 35.15, -85.0, 85.0, "yellow");
    for v in [-70.0, 70.0] {
        line(11.0, 35.0, v - 0.15, v + 0.15, "yellow");
    }
    let mut u = -92.0;
    while u < -30.0 {
        line(u, u + 0.15, -68.0, -57.0, "white");
        u += 5.0;
    }
    line(-92.0, -32.0, -57.15, -57.0, "white");
}

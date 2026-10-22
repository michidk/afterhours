#![allow(clippy::chunks_exact_to_as_chunks, clippy::collapsible_if)]
//! Faithful map-to-runtime conversion from `scripts/mapgen-city.ts`.
use crate::{
    city_geometry::{
        KERB_HEIGHT, LIMIT, SIDEWALK, STREET_LIFT, TERRAIN_SIDE, TERRAIN_STEP, WATER_LEVEL,
        drape_on_terrain, edge_height_at, round, seal_surfaces, simplify_polyline,
        sink_under_streets, snap_cm, terrain_height,
    },
    city_types::{Airport, Building, Marking, Prop, Road, Surface},
    features::{
        FeatureContext, compass, dress_airport, place_harbours, place_racetrack, place_town_hall,
        wet_mask,
    },
    field::sample,
    geom::{
        add, area, closest_on_segment, convex_overlap, dist, lerp, mul, oriented_box,
        point_in_polygon, rotated_rect, self_intersects, signed_area,
    },
    types::{BuildingKind, GeneratedMap, ParkKind, Phase, Point, RoadKind, TreeKind},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
fn asset(k: BuildingKind) -> &'static str {
    match k {
        BuildingKind::Tower => "glass-tower",
        BuildingKind::Office => "deco-tower",
        BuildingKind::Apartments => "apartments",
        BuildingKind::Shop => "shop-house",
        BuildingKind::Townhouse => "townhouse",
        BuildingKind::House => "villa",
        BuildingKind::Warehouse => "warehouse",
        BuildingKind::Civic => "civic-hall",
    }
}
fn kind(k: RoadKind) -> &'static str {
    match k {
        RoadKind::Highway | RoadKind::Avenue => "avenue",
        RoadKind::Street => "street",
        RoadKind::Lane => "service",
    }
}
fn phase(p: Option<Phase>) -> Option<String> {
    p.map(|p| if p == Phase::X { "x" } else { "z" }.into())
}
fn bp(b: &Building) -> Point {
    Point { x: b.x, z: b.z }
}
fn ap(a: &Airport) -> Point {
    Point { x: a.x, z: a.z }
}
fn flat(points: &[Point], shift: f64, y: impl Fn(Point) -> f64) -> Vec<f64> {
    points
        .iter()
        .flat_map(|p| [round(p.x), round(y(*p) + shift), round(p.z)])
        .collect()
}
fn ring(flat: &[f64]) -> Vec<Point> {
    flat.chunks_exact(3)
        .map(|p| Point { x: p[0], z: p[2] })
        .collect()
}
fn pieces(left: &[Point], right: &[Point]) -> Vec<Vec<Point>> {
    if left.len() != right.len() || left.len() < 2 {
        return vec![left.iter().chain(right.iter().rev()).copied().collect()];
    }
    let mut out = Vec::new();
    for k in 1..left.len() {
        let mut q = vec![left[k - 1], left[k], right[k], right[k - 1]];
        if self_intersects(&q) {
            let c = mul(q.iter().copied().fold(Point { x: 0.0, z: 0.0 }, add), 0.25);
            q.sort_by(|a, b| {
                (a.z - c.z)
                    .atan2(a.x - c.x)
                    .total_cmp(&(b.z - c.z).atan2(b.x - c.x))
            });
        }
        if area(&q) > 0.01 {
            out.push(q)
        }
    }
    out
}
fn halves(polygon: &[Point]) -> Vec<Vec<Point>> {
    if polygon.len() <= 4 || polygon.len() % 2 == 1 {
        return vec![polygon.to_vec()];
    };
    let n = polygon.len() / 2;
    pieces(
        &polygon[..n],
        &polygon[n..].iter().rev().copied().collect::<Vec<_>>(),
    )
}
fn usable(p: &[Point]) -> bool {
    p.len() >= 3 && p.len() <= 1000
}
#[derive(Clone)]
struct Paved {
    ring: Vec<Point>,
    x0: f64,
    x1: f64,
    z0: f64,
    z1: f64,
}
fn paved_rings(polys: &[Vec<f64>]) -> Vec<Paved> {
    polys
        .iter()
        .map(|flat| {
            let mut p = Paved {
                ring: Vec::new(),
                x0: f64::INFINITY,
                x1: f64::NEG_INFINITY,
                z0: f64::INFINITY,
                z1: f64::NEG_INFINITY,
            };
            for q in flat.chunks_exact(3) {
                p.ring.push(Point { x: q[0], z: q[2] });
                p.x0 = p.x0.min(q[0]);
                p.x1 = p.x1.max(q[0]);
                p.z0 = p.z0.min(q[2]);
                p.z1 = p.z1.max(q[2]);
            }
            p
        })
        .collect()
}
fn on_paved(p: Point, rings: &[Paved]) -> bool {
    rings.iter().any(|a| {
        p.x >= a.x0 && p.x <= a.x1 && p.z >= a.z0 && p.z <= a.z1 && point_in_polygon(p, &a.ring)
    })
}

/// Convert the generator's map into runtime city JSON. Terrain is still an array;
/// the artifact writer packs its heights after this conversion.
pub fn city_from_map(map: &GeneratedMap) -> Value {
    city_from_map_with_snapshots(map, &mut |_, _| {})
}

/// The snapshot callback exposes the exact context between destination stages.
/// It is useful for comparing native stages with dumps from the TypeScript oracle.
pub fn city_from_map_with_snapshots(
    map: &GeneratedMap,
    snapshot: &mut dyn FnMut(&str, &FeatureContext<'_>),
) -> Value {
    let f = &map.shaped;
    let shift = WATER_LEVEL - map.sea_level;
    assert!(
        f.w == TERRAIN_SIDE && f.cell == TERRAIN_STEP,
        "map grid {}@{} m does not match the game terrain grid",
        f.w,
        f.cell
    );
    let mut heights: Vec<f64> = f
        .data
        .iter()
        .map(|h| round((*h as f64 + shift).clamp(-80.0, 240.0)))
        .collect();
    // Bridge embankments carry traffic at the drawn deck height.
    for e in &map.roads.edges {
        if !e.bridge {
            continue;
        };
        let core = e.width / 2.0 + SIDEWALK + 1.0;
        let reach = core + 24.0;
        let (mut x0, mut x1, mut z0, mut z1) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for p in &e.points {
            x0 = x0.min(p.x);
            x1 = x1.max(p.x);
            z0 = z0.min(p.z);
            z1 = z1.max(p.z)
        }
        for gz in (((z0 - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize)
            ..=(((z1 + reach + LIMIT) / TERRAIN_STEP)
                .ceil()
                .min((TERRAIN_SIDE - 1) as f64) as usize)
        {
            for gx in (((x0 - reach + LIMIT) / TERRAIN_STEP).floor().max(0.0) as usize)
                ..=(((x1 + reach + LIMIT) / TERRAIN_STEP)
                    .ceil()
                    .min((TERRAIN_SIDE - 1) as f64) as usize)
            {
                let q = Point {
                    x: gx as f64 * TERRAIN_STEP - LIMIT,
                    z: gz as f64 * TERRAIN_STEP - LIMIT,
                };
                let mut d = f64::INFINITY;
                for p in e.points.windows(2) {
                    d = d.min(dist(q, closest_on_segment(q, p[0], p[1]).0))
                }
                if d > reach {
                    continue;
                };
                let deck = edge_height_at(e, q) + shift - 0.05;
                let target = round(deck - (d - core).max(0.0) * 0.5);
                let i = gz * TERRAIN_SIDE + gx;
                if target > heights[i] {
                    heights[i] = target
                }
            }
        }
    }
    let mut roads = Vec::new();
    let junction: HashSet<usize> = map
        .roads
        .nodes
        .iter()
        .filter(|n| n.edges.len() >= 3)
        .map(|n| n.id)
        .collect();
    let trims = &map.geometry.trims;
    for e in &map.roads.edges {
        let pts = subdivide(&simplify_polyline(&e.points, 0.6), 24.0);
        let mut along = vec![0.0];
        for i in 1..pts.len() {
            along.push(along[i - 1] + dist(pts[i - 1], pts[i]))
        }
        let total = along[along.len() - 1];
        let stop_a = (total / 2.0).min(trims[e.id].0 + 4.4);
        let stop_b = (total / 2.0).max(total - trims[e.id].1 - 4.4);
        for i in 1..pts.len() {
            let a = pts[i - 1];
            let b = pts[i];
            let (ax, az, bx, bz) = (round(a.x), round(a.z), round(b.x), round(b.z));
            if (bx - ax).hypot(bz - az) < 0.05 {
                continue;
            };
            let signal_a = junction.contains(&e.a)
                && along[i - 1] <= stop_a
                && (stop_a < along[i] || i == pts.len() - 1);
            let signal_b =
                junction.contains(&e.b) && stop_b <= along[i] && (along[i - 1] < stop_b || i == 1);
            roads.push(Road {
                x: round((ax + bx) / 2.0),
                z: round((az + bz) / 2.0),
                ax,
                az,
                bx,
                bz,
                width: e.width.clamp(6.0, 24.0),
                kind: kind(e.kind).into(),
                phase_a: phase(map.geometry.phases[e.id].0),
                phase_b: phase(map.geometry.phases[e.id].1),
                approach_a: (i == 1 && junction.contains(&e.a)).then(|| round(stop_a)),
                approach_b: (i == pts.len() - 1 && junction.contains(&e.b))
                    .then(|| round(total - stop_b)),
                signal_a: signal_a.then_some(true),
                stop_a: signal_a.then(|| round(stop_a - along[i - 1])),
                signal_b: signal_b.then_some(true),
                stop_b: signal_b.then(|| round(along[i] - stop_b)),
                no_crate: None,
            });
        }
    }
    let g = &map.geometry;
    let mut asphalt = Vec::new();
    let mut sidewalks = Vec::new();
    let mut markings = Vec::new();
    for b in &g.bands {
        let e = &map.roads.edges[b.edge];
        for p in pieces(&b.left, &b.right) {
            if usable(&p) {
                asphalt.push(flat(&p, shift, |p| edge_height_at(e, p)))
            }
        }
    }
    for j in &g.junctions {
        let y = map.roads.nodes[j.node].y;
        if usable(&j.polygon) {
            asphalt.push(flat(&j.polygon, shift, |_| y))
        }
    }
    for s in &g.sidewalks {
        if let Some(node) = s.node {
            let y = map.roads.nodes[node].y;
            if usable(&s.polygon) {
                sidewalks.push(flat(&s.polygon, shift, |_| y))
            }
            continue;
        }
        let e = &map.roads.edges[s.edge.unwrap()];
        for p in halves(&s.polygon) {
            if usable(&p) {
                sidewalks.push(flat(&p, shift, |p| edge_height_at(e, p)))
            }
        }
    }
    for m in &g.markings {
        let e = &map.roads.edges[m.edge];
        for p in halves(&m.polygon) {
            if usable(&p) {
                markings.push(Marking {
                    color: m.color.clone(),
                    polygon: flat(&p, shift, |p| edge_height_at(e, p)),
                })
            }
        }
    }
    let weld_key = |p: &[f64], i: usize| {
        (
            crate::city_geometry::js_round(p[i] * 2.0) as i64,
            crate::city_geometry::js_round(p[i + 2] * 2.0) as i64,
        )
    };
    let mut welded = HashMap::<(i64, i64), (f64, usize)>::new();
    for p in asphalt.iter().chain(&sidewalks) {
        for i in (0..p.len()).step_by(3) {
            let key = weld_key(p, i);
            let v = welded.entry(key).or_insert((0.0, 0));
            v.0 += p[i + 1];
            v.1 += 1;
        }
    }
    for p in asphalt.iter_mut().chain(&mut sidewalks) {
        for i in (0..p.len()).step_by(3) {
            let (sum, n) = welded[&weld_key(p, i)];
            if n > 1 {
                p[i + 1] = round(sum / n as f64)
            }
        }
    }
    let mut buildings = Vec::new();
    for (i, b) in map.buildings.iter().enumerate() {
        let r = b
            .footprint
            .clone()
            .unwrap_or_else(|| rotated_rect(Point { x: b.x, z: b.z }, b.w, b.d, b.angle));
        let Some((angle, w, d, c)) = oriented_box(&r) else {
            continue;
        };
        let Some(bx) = clear_of_streets(c, w, d, angle, &roads) else {
            continue;
        };
        let y = round(b.y + shift);
        buildings.push(Building {
            x: round(bx.0.x),
            z: round(bx.0.z),
            w: round(bx.1.clamp(3.0, 256.0)),
            d: round(bx.2.clamp(3.0, 256.0)),
            y: Some(y),
            h: round((y + b.h).min(256.0)),
            angle: Some(round(crate::js_math::atan2(
                crate::js_math::sin(angle),
                crate::js_math::cos(angle),
            ))),
            asset: asset(b.kind).into(),
            facing: 0.0,
            color: b.color.to_lowercase(),
            style: i % 3,
        });
    }
    let walk_rings: Vec<Vec<Point>> = sidewalks.iter().map(|p| ring(p)).collect();
    let mut indices: Vec<usize> = (0..buildings.len()).collect();
    indices.sort_by(|&p, &q| {
        (buildings[q].w * buildings[q].d).total_cmp(&(buildings[p].w * buildings[p].d))
    });
    let mut kept: Vec<(usize, Vec<Point>)> = Vec::new();
    for i in indices {
        let b = &buildings[i];
        let r = rotated_rect(bp(b), b.w, b.d, b.angle.unwrap_or(0.0));
        let mut probes = r.clone();
        for (i, c) in r.iter().enumerate() {
            probes.push(lerp(*c, r[(i + 1) % 4], 0.5))
        }
        probes.push(bp(b));
        let reach = b.w.hypot(b.d) / 2.0;
        if walk_rings.iter().any(|w| {
            dist(w[0], bp(b)) < reach + 40.0
                && (probes.iter().any(|q| point_in_polygon(*q, w))
                    || w.iter().any(|q| point_in_polygon(*q, &r)))
        }) || kept.iter().any(|(k, kr)| {
            let kb = &buildings[*k];
            dist(bp(kb), bp(b)) < reach + kb.w.hypot(kb.d) / 2.0 && convex_overlap(kr, &r)
        }) {
            continue;
        }
        kept.push((i, r));
    }
    let keep: HashSet<usize> = kept.iter().map(|k| k.0).collect();
    buildings = buildings
        .into_iter()
        .enumerate()
        .filter(|(i, _)| keep.contains(i))
        .map(|(_, b)| b)
        .collect();
    let paved = asphalt
        .iter()
        .chain(&sidewalks)
        .cloned()
        .collect::<Vec<_>>();
    let network = (asphalt.len(), sidewalks.len(), markings.len());
    let mut features = FeatureContext {
        map,
        heights,
        roads,
        buildings,
        asphalt,
        sidewalks,
        markings,
        taken: Vec::new(),
        wet: wet_mask(map),
        paved_rings: paved
            .iter()
            .map(|p| crate::features::PavedRing::new(ring(p)))
            .collect(),
    };
    snapshot("before-town-hall", &features);
    let town_hall = place_town_hall(&mut features);
    snapshot("after-town-hall", &features);
    let mut airports = Vec::new();
    for _ in 0..2 {
        let mut found = None;
        for apart in [900.0, 600.0, 350.0] {
            if let Some(a) = place_airport(
                map,
                &features.roads,
                &features.buildings,
                shift,
                &mut features.heights,
                &features.taken,
                &airports,
                apart,
            ) {
                found = Some(a);
                break;
            }
        }
        let a = found.expect("No dry, clear site for the airport");
        airports.push(a.clone());
        dress_airport(&mut features, &a);
        features
            .taken
            .push(rotated_rect(ap(&a), a.w + 60.0, a.d + 60.0, 0.0));
    }
    snapshot("after-airports", &features);
    let airport = airports[0].clone();
    let racetrack = place_racetrack(&mut features);
    snapshot("after-racetrack", &features);
    let harbours = place_harbours(&mut features);
    snapshot("after-harbours", &features);
    let mut pads = features.buildings.clone();
    pads.extend(airports.iter().map(|a| Building {
        x: a.x,
        z: a.z,
        w: a.w,
        d: a.d,
        y: Some(terrain_height(a.x, a.z, &features.heights)),
        h: 0.0,
        angle: None,
        asset: String::new(),
        facing: 0.0,
        color: String::new(),
        style: 0,
    }));
    sink_under_streets(
        &mut features.heights,
        TERRAIN_SIDE,
        TERRAIN_STEP,
        LIMIT,
        &[
            (&features.asphalt, STREET_LIFT),
            (&features.sidewalks, STREET_LIFT + KERB_HEIGHT),
        ],
        &pads,
    );
    snapshot("after-sink", &features);
    let FeatureContext {
        mut heights,
        mut roads,
        mut buildings,
        asphalt,
        sidewalks,
        markings,
        taken,
        ..
    } = features;
    for h in &mut heights {
        *h = (*h * 100.0 + 1e-6).floor() / 100.0 + 0.0;
    }
    for i in (0..buildings.len()).rev() {
        let b = &buildings[i];
        let r = rotated_rect(bp(b), b.w, b.d, b.angle.unwrap_or(0.0));
        let mut ground = Vec::new();
        for j in 0..r.len() {
            let a = r[j];
            let c = r[(j + 1) % r.len()];
            ground.push(terrain_height(a.x, a.z, &heights));
            for (from, to) in [(a.x, c.x), (a.z, c.z), (a.x + a.z, c.x + c.z)] {
                let mut line = (from.min(to) / TERRAIN_STEP).ceil() * TERRAIN_STEP;
                while line < from.max(to) {
                    let q = lerp(a, c, (line - from) / (to - from));
                    ground.push(terrain_height(q.x, q.z, &heights));
                    line += TERRAIN_STEP
                }
            }
        }
        let (x0, x1, z0, z1) = bounds(&r);
        let mut z = (z0 / TERRAIN_STEP).ceil() * TERRAIN_STEP;
        while z <= z1 {
            let mut x = (x0 / TERRAIN_STEP).ceil() * TERRAIN_STEP;
            while x <= x1 {
                if point_in_polygon(Point { x, z }, &r) {
                    ground.push(terrain_height(x, z, &heights));
                }
                x += TERRAIN_STEP
            }
            z += TERRAIN_STEP
        }
        let low = ground.iter().copied().fold(f64::INFINITY, f64::min);
        let high = ground.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let base = (high * 100.0).ceil() / 100.0;
        if base - low > 4.4 {
            buildings.remove(i);
            continue;
        }
        buildings[i].h = round(b.h - b.y.unwrap() + base);
        buildings[i].y = Some(base);
    }
    let walkway_points: Vec<f64> = g
        .walkways
        .points
        .iter()
        .flat_map(|p| [round(p.x), round(p.z)])
        .collect();
    let walkway_links: Vec<usize> = g
        .walkways
        .links
        .iter()
        .flat_map(|l| {
            [
                l.a,
                l.b,
                match l.crossing {
                    Some(Phase::X) => 1,
                    Some(Phase::Z) => 2,
                    None => 0,
                },
            ]
        })
        .collect();
    let inside = |p: Point, pad: f64| {
        airports
            .iter()
            .any(|a| (p.x - a.x).abs() < a.w / 2.0 + pad && (p.z - a.z).abs() < a.d / 2.0 + pad)
            || taken.iter().any(|r| point_in_polygon(p, r))
    };
    let in_river = |q: Point| {
        map.rivers.iter().any(|r| {
            r.points
                .iter()
                .enumerate()
                .any(|(i, p)| (p.x - q.x).abs() < 20.0 && dist(*p, q) < r.widths[i] / 2.0 + 1.5)
        })
    };
    let mut props = Vec::new();
    let mut seen = HashSet::new();
    for t in &map.trees {
        let (x, z) = (round(t.x), round(t.z));
        let key = (x.to_bits(), z.to_bits());
        if seen.contains(&key)
            || inside(Point { x: t.x, z: t.z }, 6.0)
            || in_river(Point { x: t.x, z: t.z })
            || x.abs() > LIMIT - 2.0
            || z.abs() > LIMIT - 2.0
        {
            continue;
        }
        seen.insert(key);
        props.push(Prop {
            x,
            z,
            h: round(t.h.max(2.0)),
            kind: if t.kind == TreeKind::Palm {
                "palm"
            } else {
                "tree"
            }
            .into(),
            angle: None,
        });
    }
    for l in &map.lamps {
        let (x, z) = (round(l.x), round(l.z));
        let key = (x.to_bits(), z.to_bits());
        if seen.contains(&key)
            || inside(Point { x: l.x, z: l.z }, 6.0)
            || x.abs() > LIMIT - 2.0
            || z.abs() > LIMIT - 2.0
        {
            continue;
        }
        seen.insert(key);
        props.push(Prop {
            x,
            z,
            h: round(l.h),
            kind: "lamp".into(),
            angle: Some(round(l.angle)),
        });
    }
    let asphalt_rings = paved_rings(&asphalt);
    let on_asphalt = |p| on_paved(p, &asphalt_rings);
    let ground_at = |p: Point| terrain_height(p.x, p.z, &heights);
    let mut parks = Vec::new();
    for park in &map.parks {
        let mut best: Option<(Point, f64)> = None;
        let (x0, x1, z0, z1) = bounds(&park.polygon);
        let mut x = x0;
        while x <= x1 {
            let mut z = z0;
            while z <= z1 {
                let c = Point { x, z };
                if point_in_polygon(c, &park.polygon) {
                    let mut clear = f64::INFINITY;
                    for i in 0..park.polygon.len() {
                        clear = clear.min(dist(
                            c,
                            closest_on_segment(
                                c,
                                park.polygon[i],
                                park.polygon[(i + 1) % park.polygon.len()],
                            )
                            .0,
                        ))
                    }
                    if best.is_none_or(|b| clear > b.1) {
                        best = Some((c, clear));
                    }
                }
                z += 4.0
            }
            x += 4.0
        }
        let Some((c, _)) = best else { continue };
        let level = ground_at(c);
        let fits = |hw: f64, hd: f64| {
            let mut dx = -hw;
            while dx <= hw + 1e-6 {
                let mut dz = -hd;
                while dz <= hd + 1e-6 {
                    let q = Point {
                        x: c.x + dx,
                        z: c.z + dz,
                    };
                    if !point_in_polygon(q, &park.polygon)
                        || on_asphalt(q)
                        || ground_at(q) < WATER_LEVEL + 0.3
                        || (ground_at(q) - level).abs() > 1.0
                    {
                        return false;
                    }
                    dz += 1.0_f64.max(hd / 6.0)
                }
                dx += 1.0_f64.max(hw / 6.0)
            }
            true
        };
        let (mut hw, mut hd) = (3.0, 3.0);
        let mut grown = true;
        while grown && hw < 128.0 && hd < 128.0 {
            grown = false;
            if fits(hw + 1.0, hd) {
                hw += 1.0;
                grown = true
            }
            if fits(hw, hd + 1.0) {
                hd += 1.0;
                grown = true
            }
        }
        if !fits(hw, hd) || hw < 4.0 || hd < 4.0 {
            continue;
        }
        let slab = rotated_rect(c, hw * 2.0, hd * 2.0, 0.0);
        if taken.iter().any(|r| convex_overlap(r, &slab)) {
            continue;
        }
        let garden = park.kind != ParkKind::Woodland && hw >= 5.5 && hd >= 10.5;
        parks.push(json!({"x":round(c.x),"z":round(c.z),"w":round(hw*2.0),"d":round(hd*2.0),"kind":if garden{"garden"}else{"woodland"}}));
    }
    let spawn = g
        .walkways
        .points
        .iter()
        .copied()
        .filter(|p| !on_asphalt(*p))
        .reduce(|best, p| {
            if dist(p, map.centre) < dist(best, map.centre) {
                p
            } else {
                best
            }
        })
        .expect("no dry sidewalk spawn");
    let centre = Point {
        x: round(spawn.x),
        z: round(spawn.z),
    };
    let mut pickups: Vec<Value> = Vec::new();
    let mut pickup_points = Vec::new();
    let mut spots: Vec<Point> = g
        .walkways
        .points
        .iter()
        .copied()
        .filter(|p| !on_asphalt(*p))
        .collect();
    spots.sort_by(|a, b| dist(*a, centre).total_cmp(&dist(*b, centre)));
    for weapon in ["pistol", "bat", "pistol"] {
        let Some(spot) = spots
            .iter()
            .find(|p| pickup_points.iter().all(|q| dist(**p, *q) > 15.0))
        else {
            break;
        };
        let p = Point {
            x: round(spot.x),
            z: round(spot.z),
        };
        pickup_points.push(p);
        pickups.push(json!({"x":p.x,"z":p.z,"weapon":weapon}));
    }
    for road in &mut roads {
        for end in [false, true] {
            if if end { road.signal_b } else { road.signal_a } != Some(true) {
                continue;
            }
            let mut alone = road.clone();
            alone.signal_a = None;
            alone.signal_b = None;
            if end {
                alone.signal_b = Some(true)
            } else {
                alone.signal_a = Some(true)
            }
            if let Some(pole) = destructibles(&alone).into_iter().find(|p| p.0 == "signal") {
                if on_asphalt(pole.1) {
                    if end {
                        road.signal_b = None;
                        road.stop_b = None
                    } else {
                        road.signal_a = None;
                        road.stop_a = None
                    }
                }
            }
        }
    }
    for road in &mut roads {
        for (kind, p) in destructibles(road) {
            if kind == "crate"
                && ([-0.5, 0.5].iter().any(|dx| {
                    [-0.5, 0.5].iter().any(|dz| {
                        on_asphalt(Point {
                            x: p.x + dx,
                            z: p.z + dz,
                        })
                    })
                }) || buildings.iter().any(|b| {
                    let angle = b.angle.unwrap_or(0.0);
                    ((p.x - b.x) * crate::js_math::cos(angle)
                        + (p.z - b.z) * crate::js_math::sin(angle))
                    .abs()
                        < b.w / 2.0 + 0.6
                        && (-(p.x - b.x) * crate::js_math::sin(angle)
                            + (p.z - b.z) * crate::js_math::cos(angle))
                        .abs()
                            < b.d / 2.0 + 0.6
                }))
            {
                road.no_crate = Some(true)
            }
        }
    }
    let tallest = buildings.iter().reduce(|t, b| {
        if b.h - b.y.unwrap_or(0.0) > t.h - t.y.unwrap_or(0.0) {
            b
        } else {
            t
        }
    });
    let middle = Point { x: 0.0, z: 0.0 };
    let mut landmarks = vec![
        json!({"x":centre.x,"z":centre.z,"name":"CITY CENTRE","kind":"plaza"}),
        json!({"x":town_hall.spawn.x,"z":town_hall.spawn.z,"name":"TOWN HALL","kind":"townhall"}),
    ];
    for a in &airports {
        landmarks.push(json!({"x":a.x,"z":a.z,"name":format!("{} AIRPORT",compass(ap(a),middle)),"kind":"airport"}))
    }
    landmarks.push(
        json!({"x":racetrack.path[0],"z":racetrack.path[1],"name":"RACETRACK","kind":"racetrack"}),
    );
    for h in &harbours {
        landmarks.push(json!({"x":h.x,"z":h.z,"name":format!("{} HARBOUR",compass(Point{x:h.x,z:h.z},middle)),"kind":"harbour"}))
    }
    if let Some(t) = tallest {
        landmarks.push(json!({"x":t.x,"z":t.z,"name":"THE SPIRE","kind":"tower"}));
    }
    let water = water(map, shift, &mut heights, &asphalt_rings, &walk_rings);
    let lowest = |x: f64, z: f64, r: f64, max: bool| {
        let mut v = terrain_height(x, z, &heights);
        for dx in [-r, -r / 2.0, 0.0, r / 2.0, r] {
            for dz in [-r, -r / 2.0, 0.0, r / 2.0, r] {
                let h = terrain_height(x + dx, z + dz, &heights);
                v = if max { v.max(h) } else { v.min(h) }
            }
        }
        v
    };
    for i in (0..props.len()).rev() {
        let t = &props[i];
        if t.kind == "tree"
            && lowest(t.x, t.z, 2.75, true) > lowest(t.x, t.z, 0.4, false) + 0.52 * t.h
        {
            props.remove(i);
        }
    }
    let drape = |polygons: &[Vec<f64>], count: usize, avoid: &[Vec<f64>]| {
        let n = count.min(polygons.len());
        let mut r: Vec<Vec<f64>> = drape_on_terrain(&polygons[..n], &heights, avoid)
            .into_iter()
            .map(|p| p.into_iter().map(snap_cm).collect::<Vec<_>>())
            .filter(|p| usable3(p))
            .collect();
        r.extend(polygons[n..].iter().cloned());
        r
    };
    let sealed = seal_surfaces(vec![
        drape(&asphalt, network.0, &[]),
        drape(&sidewalks, network.1, &asphalt[..network.0]),
    ]);
    let mut final_markings = Vec::new();
    for color in ["white", "yellow"] {
        let p: Vec<Vec<f64>> = markings[..network.2]
            .iter()
            .filter(|m| m.color == color)
            .map(|m| m.polygon.clone())
            .collect();
        for polygon in drape(&p, usize::MAX, &[]) {
            final_markings.push(Marking {
                color: color.into(),
                polygon,
            });
        }
    }
    final_markings.extend(markings[network.2..].iter().cloned());
    let surface = Surface {
        asphalt: sealed[0].clone(),
        sidewalks: sealed[1].clone(),
        markings: final_markings,
    };
    json!({"seed":map.options.seed,"terrain":{"heights":heights},"centre":centre,"spawn":town_hall.spawn,"surface":crate::packing::pack_surface_chunks(&surface),"walkways":{"points":walkway_points,"links":walkway_links},"water":water,"roads":roads,"buildings":buildings,"props":props,"parks":parks,"surfaces":[],"ramps":[],"pickups":pickups,"airport":airport,"airports":airports,"townHall":town_hall,"racetrack":racetrack,"harbours":harbours,"landmarks":landmarks})
}
fn bounds(r: &[Point]) -> (f64, f64, f64, f64) {
    let (mut x0, mut x1, mut z0, mut z1) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for p in r {
        x0 = x0.min(p.x);
        x1 = x1.max(p.x);
        z0 = z0.min(p.z);
        z1 = z1.max(p.z)
    }
    (x0, x1, z0, z1)
}
fn usable3(p: &[f64]) -> bool {
    if p.len() < 9 {
        return false;
    };
    let mut sum = 0.0;
    for i in (0..p.len()).step_by(3) {
        sum = sum + p[i] * p[(i + 5) % p.len()] - p[(i + 3) % p.len()] * p[i + 2]
    }
    sum.abs() > 2e-4
}
fn clear_of_streets(
    mut centre: Point,
    mut w: f64,
    mut d: f64,
    angle: f64,
    roads: &[Road],
) -> Option<(Point, f64, f64)> {
    let near: Vec<&Road> = roads
        .iter()
        .filter(|r| {
            (r.x - centre.x).hypot(r.z - centre.z)
                < (r.bx - r.ax).hypot(r.bz - r.az) / 2.0 + r.width / 2.0 + w.hypot(d) / 2.0 + 4.0
        })
        .collect();
    for _ in 0..8 {
        let mut worst = 0.0;
        let mut push = Point { x: 0.0, z: 0.0 };
        let corners = rotated_rect(centre, w, d, angle);
        for k in 0..4 {
            let a = corners[k];
            let b = corners[(k + 1) % 4];
            let steps = (dist(a, b) / 1.5).ceil() as usize;
            for s in 0..=steps {
                let p = lerp(a, b, s as f64 / steps as f64);
                for r in &near {
                    let point = closest_on_segment(
                        p,
                        Point { x: r.ax, z: r.az },
                        Point { x: r.bx, z: r.bz },
                    )
                    .0;
                    let gap = dist(p, point);
                    let depth = r.width / 2.0 + SIDEWALK + 0.3 - gap;
                    if depth <= worst {
                        continue;
                    }
                    worst = depth;
                    let away = (centre.x - point.x).hypot(centre.z - point.z);
                    let away = if away == 0.0 { 1.0 } else { away };
                    push = Point {
                        x: (centre.x - point.x) / away,
                        z: (centre.z - point.z) / away,
                    };
                }
            }
        }
        if worst <= 0.01 {
            return Some((centre, w, d));
        }
        centre = Point {
            x: centre.x + push.x * worst * 0.5,
            z: centre.z + push.z * worst * 0.5,
        };
        let c = crate::js_math::cos(angle);
        let s = crate::js_math::sin(angle);
        w -= (push.x * c + push.z * s).abs() * worst;
        d -= (-push.x * s + push.z * c).abs() * worst;
        if w < 4.0 || d < 4.0 {
            return None;
        }
    }
    None
}
fn subdivide(points: &[Point], max_length: f64) -> Vec<Point> {
    let mut out = vec![points[0]];
    for i in 1..points.len() {
        let a = points[i - 1];
        let b = points[i];
        let n = (dist(a, b) / max_length).ceil().max(1.0) as usize;
        for s in 1..=n {
            out.push(lerp(a, b, s as f64 / n as f64));
        }
    }
    out
}
#[allow(clippy::too_many_arguments)]
fn place_airport(
    map: &GeneratedMap,
    roads: &[Road],
    buildings: &[Building],
    shift: f64,
    heights: &mut [f64],
    taken: &[Vec<Point>],
    others: &[Airport],
    apart: f64,
) -> Option<Airport> {
    let f = &map.shaped;
    let size = 220.0;
    let half = size / 2.0;
    let mut best: Option<(f64, f64, f64)> = None;
    let mut wet_cells = vec![0u8; f.w * f.h];
    let cell_of = |q: Point| {
        crate::city_geometry::js_round((q.z + f.size / 2.0) / f.cell) as isize * f.w as isize
            + crate::city_geometry::js_round((q.x + f.size / 2.0) / f.cell) as isize
    };
    for z in 0..f.h {
        for x in 0..f.w {
            let q = Point {
                x: x as f64 * f.cell - f.size / 2.0,
                z: z as f64 * f.cell - f.size / 2.0,
            };
            if map.lakes.iter().any(|l| point_in_polygon(q, &l.outline)) {
                for dz in -3..=3 {
                    for dx in -3..=3 {
                        let nx = x as isize + dx;
                        let nz = z as isize + dz;
                        if nx >= 0 && nz >= 0 && nx < (f.w as isize) && nz < (f.h as isize) {
                            wet_cells[nz as usize * f.w + nx as usize] = 1
                        }
                    }
                }
            }
        }
    }
    for river in &map.rivers {
        for (i, r) in river.points.iter().enumerate() {
            let reach = ((river.widths[i] / 2.0 + 4.0) / f.cell).ceil() as isize;
            let c = cell_of(*r);
            let cx = c % f.w as isize;
            let cz = (c - cx) / f.w as isize;
            for dz in -reach..=reach {
                for dx in -reach..=reach {
                    let nx = cx + dx;
                    let nz = cz + dz;
                    if nx >= 0 && nz >= 0 && nx < f.w as isize && nz < f.h as isize {
                        wet_cells[nz as usize * f.w + nx as usize] = 1
                    }
                }
            }
        }
    }
    for (far, rough) in [(700.0, 14.0), (450.0, 24.0), (250.0, 40.0), (150.0, 70.0)] {
        let mut z = -LIMIT + half + 40.0;
        while z <= LIMIT - half - 40.0 {
            let mut x = -LIMIT + half + 40.0;
            while x <= LIMIT - half - 40.0 {
                if (x - map.centre.x).hypot(z - map.centre.z) < far
                    || others.iter().any(|o| (x - o.x).hypot(z - o.z) < apart)
                {
                    x += 32.0;
                    continue;
                }
                let (mut min, mut max, mut sum, mut count, mut wet) =
                    (f64::INFINITY, f64::NEG_INFINITY, 0.0, 0usize, false);
                let mut dz = -half;
                while dz <= half && !wet {
                    let mut dx = -half;
                    while dx <= half {
                        let h = sample(f, x + dx, z + dz);
                        if h < 2.5 {
                            wet = true;
                            break;
                        }
                        min = min.min(h);
                        max = max.max(h);
                        sum += h;
                        count += 1;
                        dx += 16.0
                    }
                    dz += 16.0
                }
                let mut dz = -half;
                while dz <= half && !wet {
                    let mut dx = -half;
                    while dx <= half && !wet {
                        let i = cell_of(Point {
                            x: x + dx,
                            z: z + dz,
                        });
                        wet = i >= 0 && wet_cells.get(i as usize) == Some(&1);
                        dx += 8.0
                    }
                    dz += 8.0
                }
                if wet || max - min > rough {
                    x += 32.0;
                    continue;
                }
                let clear = half + 8.0;
                let occupied = buildings
                    .iter()
                    .any(|b| (b.x - x).abs() < half + 20.0 && (b.z - z).abs() < half + 20.0)
                    || roads.iter().any(|r| {
                        let steps = ((r.bx - r.ax).hypot(r.bz - r.az) / 8.0).ceil() as usize;
                        (0..=steps).any(|i| {
                            let t = i as f64 / steps as f64;
                            (r.ax + (r.bx - r.ax) * t - x).abs() < clear + r.width / 2.0
                                && (r.az + (r.bz - r.az) * t - z).abs() < clear + r.width / 2.0
                        })
                    });
                if occupied
                    || taken
                        .iter()
                        .any(|r| convex_overlap(r, &rotated_rect(Point { x, z }, size, size, 0.0)))
                {
                    x += 32.0;
                    continue;
                }
                let score = max - min + sum / count as f64 / 20.0;
                if best.is_none_or(|b| score < b.2) {
                    best = Some((x, z, score))
                }
                x += 32.0
            }
            z += 32.0
        }
        if best.is_some() {
            break;
        }
    }
    let site = best?;
    let level = sample(f, site.0, site.1) + shift;
    let margin = 24.0;
    let near_road = |px: f64, pz: f64| {
        roads.iter().any(|r| {
            let dx = r.bx - r.ax;
            let dz = r.bz - r.az;
            let t = (((px - r.ax) * dx + (pz - r.az) * dz) / (dx * dx + dz * dz)).clamp(0.0, 1.0);
            (r.ax + dx * t - px).hypot(r.az + dz * t - pz) < r.width / 2.0 + 2.5 + 8.0
        })
    };
    for z in 0..f.h {
        for x in 0..f.w {
            let px = x as f64 * f.cell - f.size / 2.0;
            let pz = z as f64 * f.cell - f.size / 2.0;
            let dx = ((px - site.0).abs() - half).max(0.0);
            let dz = ((pz - site.1).abs() - half).max(0.0);
            let d = dx.hypot(dz);
            if d > TERRAIN_STEP + margin || (d > TERRAIN_STEP && near_road(px, pz)) {
                continue;
            }
            let i = z * f.w + x;
            let t = (1.0 - (d - TERRAIN_STEP) / margin).min(1.0);
            heights[i] = round(heights[i] + (level - heights[i]) * t);
        }
    }
    Some(Airport {
        x: round(site.0),
        z: round(site.1),
        w: size,
        d: size,
    })
}
fn destructibles(road: &Road) -> Vec<(&'static str, Point)> {
    let mut result = Vec::new();
    let dx = road.bx - road.ax;
    let dz = road.bz - road.az;
    let length = dx.hypot(dz);
    if length < 15.0 && road.stop_a.is_none() && road.stop_b.is_none() {
        return result;
    }
    let nx = dz / length;
    let nz = -dx / length;
    for (end, controlled, stop) in [
        (-1.0, road.signal_a, road.stop_a),
        (1.0, road.signal_b, road.stop_b),
    ] {
        if controlled != Some(true) {
            continue;
        }
        let along = end * (length / 2.0 - stop.unwrap_or(9.0));
        let lateral = end * (road.width / 2.0 + 1.0);
        result.push((
            "signal",
            Point {
                x: road.x + nx * lateral + (dx / length) * along,
                z: road.z + nz * lateral + (dz / length) * along,
            },
        ));
    }
    if length >= 40.0 && road.kind != "coast" && road.kind != "service" {
        result.push((
            "hydrant",
            Point {
                x: road.x + nx * (road.width / 2.0 + 3.0),
                z: road.z + nz * (road.width / 2.0 + 3.0),
            },
        ));
    }
    if length >= 20.0
        && road.signal_a != Some(true)
        && road.signal_b != Some(true)
        && road.no_crate != Some(true)
        && road.kind != "coast"
        && road.kind != "service"
        && crate::city_geometry::js_round(road.x * 7.0 + road.z * 13.0).abs() % 3.0 == 0.0
    {
        result.push((
            "crate",
            Point {
                x: road.x - nx * (road.width / 2.0 + 1.3),
                z: road.z - nz * (road.width / 2.0 + 1.3),
            },
        ));
    }
    result
}
fn water(
    map: &GeneratedMap,
    shift: f64,
    heights: &mut [f64],
    asphalt: &[Paved],
    walk_rings: &[Vec<Point>],
) -> Value {
    let f = &map.shaped;
    let mut lakes = Vec::new();
    let mut rivers = Vec::new();
    let mut channel = vec![0u8; f.w * f.h];
    for river in &map.rivers {
        for (i, q) in river.points.iter().enumerate() {
            let reach = ((river.widths[i] / 2.0 + 8.0) / f.cell).ceil() as isize;
            let cx = crate::city_geometry::js_round((q.x + f.size / 2.0) / f.cell) as isize;
            let cz = crate::city_geometry::js_round((q.z + f.size / 2.0) / f.cell) as isize;
            for dz in -reach..=reach {
                for dx in -reach..=reach {
                    if cx + dx >= 0
                        && cz + dz >= 0
                        && cx + dx < f.w as isize
                        && cz + dz < f.h as isize
                    {
                        channel[(cz + dz) as usize * f.w + (cx + dx) as usize] = 1;
                    }
                }
            }
        }
    }
    let neighbours = |i: usize| {
        let i = i as isize;
        let w = f.w as isize;
        [i - 1, i + 1, i - w, i + w, i - w + 1, i + w - 1]
            .into_iter()
            .filter(move |n| {
                *n >= 0 && *n < (f.w * f.h) as isize && ((*n % w) - (i % w)).abs() <= 1
            })
            .map(|n| n as usize)
            .collect::<Vec<_>>()
    };
    for lake in &map.lakes {
        let mut basin = vec![0u8; f.w * f.h];
        for z in 0..f.h {
            for x in 0..f.w {
                if point_in_polygon(
                    Point {
                        x: x as f64 * f.cell - f.size / 2.0,
                        z: z as f64 * f.cell - f.size / 2.0,
                    },
                    &lake.outline,
                ) {
                    basin[z * f.w + x] = 1;
                }
            }
        }
        let mut spill = f64::INFINITY;
        for i in 0..basin.len() {
            if basin[i] != 0 {
                for n in neighbours(i) {
                    if basin[n] == 0 && channel[n] == 0 {
                        spill = spill.min(heights[n])
                    }
                }
            }
        }
        if !spill.is_finite() {
            continue;
        }
        let level = round(spill - 0.1);
        let mut mask = vec![0u8; f.w * f.h];
        for i in 0..basin.len() {
            if basin[i] != 0 && heights[i] < spill + 0.3 {
                mask[i] = 1;
            }
        }
        for _ in 0..3 {
            let mut dams = Vec::new();
            for i in 0..mask.len() {
                if mask[i] != 0
                    && neighbours(i)
                        .iter()
                        .any(|&n| mask[n] == 0 && heights[n] < level)
                {
                    dams.push(i)
                }
            }
            if dams.is_empty() {
                break;
            }
            for i in dams {
                mask[i] = 0;
                heights[i] = round(heights[i].max(level + 0.2));
            }
        }
        let mut r: Vec<usize> = (0..mask.len())
            .filter(|&i| mask[i] != 0 && neighbours(i).iter().any(|&n| mask[n] == 0))
            .collect();
        let mut seen = vec![0u8; f.w * f.h];
        let mut depth: f64 = 0.6;
        while !r.is_empty() {
            let mut next = Vec::new();
            for i in r {
                if seen[i] != 0 {
                    continue;
                }
                seen[i] = 1;
                heights[i] = round(heights[i].min(level - depth));
                for n in neighbours(i) {
                    if mask[n] != 0 && seen[n] == 0 {
                        next.push(n);
                    }
                }
            }
            r = next;
            depth = (depth + 0.8).min(3.0);
        }
        for outline in lake_shorelines(heights, f.w, f.cell, f.size / 2.0, &mask, level) {
            if signed_area(&outline).abs() > 1.0 {
                lakes.push(json!({"level":level,"outline":outline.iter().flat_map(|p|[round(p.x),round(p.z)]).collect::<Vec<_>>()}))
            }
        }
    }
    for river in &map.rivers {
        let mut run: Vec<f64> = Vec::new();
        let flush = |run: &mut Vec<f64>, rivers: &mut Vec<Value>| {
            if run.len() >= 8 {
                rivers.push(json!({"points":run}))
            }
            run.clear();
        };
        let mut surface = f64::INFINITY;
        for (i, q) in river.points.iter().enumerate() {
            let ground = terrain_height(q.x, q.z, heights);
            if map.lakes.iter().any(|l| point_in_polygon(*q, &l.outline))
                || ground > sample(&map.shaped, q.x, q.z) + shift + 0.8
                || q.x.abs() > LIMIT - 1.0
                || q.z.abs() > LIMIT - 1.0
            {
                flush(&mut run, &mut rivers);
                surface = f64::INFINITY;
                continue;
            }
            surface = surface.min(ground + 0.4);
            let a = river.points[i.saturating_sub(1)];
            let b = river.points[(i + 1).min(river.points.len() - 1)];
            let length = dist(a, b);
            let length = if length == 0.0 { 1.0 } else { length };
            let nx = -(b.z - a.z) / length;
            let nz = (b.x - a.x) / length;
            let mut half = river.widths[i] / 2.0;
            let hangs = |h: f64| {
                [-1.0, 1.0].iter().any(|side| {
                    surface - terrain_height(q.x + nx * h * side, q.z + nz * h * side, heights)
                        > 0.8
                })
            };
            while half > 0.75 && hangs(half) {
                half -= 0.5
            }
            let paved = [-1.0, 0.0, 1.0].iter().any(|side| {
                let e = Point {
                    x: q.x + nx * half * side,
                    z: q.z + nz * half * side,
                };
                on_paved(e, asphalt) || walk_rings.iter().any(|w| point_in_polygon(e, w))
            });
            if paved || hangs(half) {
                flush(&mut run, &mut rivers);
                continue;
            }
            if !run.is_empty() && run[run.len() - 2] - surface > 1.5 {
                flush(&mut run, &mut rivers)
            }
            run.extend([round(q.x), round(q.z), round(surface), round(half * 2.0)]);
        }
        flush(&mut run, &mut rivers);
    }
    json!({"lakes":lakes,"rivers":rivers})
}
/// Follow lake waterlines on exactly the same diagonal triangles as the terrain.
fn lake_shorelines(
    heights: &[f64],
    side: usize,
    step: f64,
    half: f64,
    seeds: &[u8],
    level: f64,
) -> Vec<Vec<Point>> {
    let mut wet = vec![0u8; heights.len()];
    let mut queue = Vec::new();
    for i in 0..seeds.len() {
        if seeds[i] != 0 && heights[i] < level {
            wet[i] = 1;
            queue.push(i)
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head];
        let x = (i % side) as isize;
        let z = (i / side) as isize;
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)] {
            let nx = x + dx;
            let nz = z + dz;
            if nx < 0 || nz < 0 || nx >= side as isize || nz >= side as isize {
                continue;
            }
            let n = nz as usize * side + nx as usize;
            if wet[n] != 0 || heights[n] >= level {
                continue;
            }
            wet[n] = 1;
            queue.push(n)
        }
        head += 1;
    }
    let mut points = HashMap::<(usize, usize), Point>::new();
    let mut links = HashMap::<(usize, usize), Vec<(usize, usize)>>::new();
    let mut order = Vec::new();
    for z in 0..side - 1 {
        for x in 0..side - 1 {
            let i = z * side + x;
            for tri in [[i, i + 1, i + side], [i + 1, i + side + 1, i + side]] {
                let mut cuts = Vec::new();
                for k in 0..3 {
                    let (mut a, mut b) = (tri[k], tri[(k + 1) % 3]);
                    if wet[a] != wet[b] {
                        if a > b {
                            std::mem::swap(&mut a, &mut b)
                        }
                        let key = (a, b);
                        points.entry(key).or_insert_with(|| {
                            let t = (level - heights[a]) / (heights[b] - heights[a]);
                            Point {
                                x: ((a % side) as f64
                                    + ((b % side) as f64 - (a % side) as f64) * t)
                                    * step
                                    - half,
                                z: ((a / side) as f64
                                    + ((b / side) as f64 - (a / side) as f64) * t)
                                    * step
                                    - half,
                            }
                        });
                        cuts.push(key)
                    }
                }
                if cuts.len() != 2 {
                    continue;
                }
                let (a, b) = (cuts[0], cuts[1]);
                if !links.contains_key(&a) {
                    order.push(a)
                }
                links.entry(a).or_default().push(b);
                if !links.contains_key(&b) {
                    order.push(b)
                }
                links.entry(b).or_default().push(a);
            }
        }
    }
    let mut rings = Vec::new();
    let mut seen = HashSet::new();
    for start in order {
        if seen.contains(&start) {
            continue;
        }
        let mut ring = Vec::new();
        let mut key = Some(start);
        while let Some(k) = key {
            if seen.contains(&k) {
                break;
            }
            seen.insert(k);
            ring.push(points[&k]);
            key = links
                .get(&k)
                .and_then(|ns| ns.iter().find(|n| !seen.contains(n)).copied());
        }
        if ring.len() >= 3 {
            rings.push(ring)
        }
    }
    rings
}

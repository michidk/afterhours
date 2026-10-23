//! A small hand-built map for testing: a flat island with a pond, a street grid for the AI to
//! live on, and room near the spawn for every vehicle and item. It runs the real road geometry
//! stages, so streets, sidewalks and walkways come out exactly as in a generated city.
use crate::{city::city_from_map, pipeline::stages, types::*};
use serde_json::{Value, json};

pub const SIZE: f64 = 3072.0;
pub const CELL: f64 = 8.0;
const SIDE: usize = 385;
/// Map-space height of the island; the game shifts every height by `WATER_LEVEL`.
const PLATEAU: f64 = 8.0;
const SEA_FLOOR: f64 = -8.0;
/// The coastal shelf, still dry and low enough for a quay.
const SHELF: f64 = 3.0;
/// Half extents of the island (m): a rounded rectangle centred on the origin.
const HALF: (f64, f64) = (950.0, 700.0);
/// The streets the AI drives and walks, east of the spawn: node spacing and extent.
pub const DISTRICT: (f64, f64, f64, usize) = (420.0, -160.0, 110.0, 4);

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn height(x: f64, z: f64) -> f64 {
    // Distance outside the rounded rectangle that is the coast (negative inside).
    let (qx, qz) = (x.abs() - (HALF.0 - 80.0), z.abs() - (HALF.1 - 80.0));
    let outside = qx.max(0.0).hypot(qz.max(0.0)) + qx.max(qz).min(0.0) - 80.0;
    // A low shelf along the coast (harbours need one), the high plateau inside, and a steep drop
    // into deep water outside.
    if outside > 0.0 {
        SHELF + (SEA_FLOOR - SHELF) * smooth(outside / 40.0)
    } else {
        SHELF + (PLATEAU - SHELF) * smooth((-outside - 60.0) / 100.0)
    }
}

fn terrain() -> HeightField {
    let mut data = Vec::with_capacity(SIDE * SIDE);
    for j in 0..SIDE {
        for i in 0..SIDE {
            data.push(height(i as f64 * CELL - SIZE / 2.0, j as f64 * CELL - SIZE / 2.0) as f32);
        }
    }
    HeightField {
        w: SIDE,
        h: SIDE,
        cell: CELL,
        size: SIZE,
        data,
    }
}

fn road_graph() -> RoadGraph {
    let (x0, z0, step, n) = DISTRICT;
    let mut graph = RoadGraph::default();
    let id = |i: usize, j: usize| j * n + i;
    for j in 0..n {
        for i in 0..n {
            graph.nodes.push(RoadNode {
                id: id(i, j),
                x: x0 + i as f64 * step,
                z: z0 + j as f64 * step,
                y: PLATEAU,
                edges: vec![],
            });
        }
    }
    let link = |graph: &mut RoadGraph, a: usize, b: usize| {
        let (pa, pb) = (
            Point {
                x: graph.nodes[a].x,
                z: graph.nodes[a].z,
            },
            Point {
                x: graph.nodes[b].x,
                z: graph.nodes[b].z,
            },
        );
        let edge = graph.edges.len();
        graph.edges.push(RoadEdge {
            id: edge,
            a,
            b,
            kind: RoadKind::Street,
            width: 12.0,
            bridge: false,
            points: vec![pa, pb],
            heights: vec![PLATEAU, PLATEAU],
        });
        graph.nodes[a].edges.push(edge);
        graph.nodes[b].edges.push(edge);
    };
    for j in 0..n {
        for i in 0..n {
            if i + 1 < n {
                link(&mut graph, id(i, j), id(i + 1, j));
            }
            if j + 1 < n {
                link(&mut graph, id(i, j), id(i, j + 1));
            }
        }
    }
    graph
}

/// The test map. Blocks, buildings, parks and vegetation are left empty on purpose.
pub fn generate_test_map() -> GeneratedMap {
    let terrain = terrain();
    let n = SIDE * SIDE;
    let mut roads = road_graph();
    let mut shaped = terrain.clone();
    stages::smooth_centrelines(&mut roads);
    stages::densify_centrelines(&mut roads);
    let geometry = stages::build_road_geometry(&roads);
    stages::solve_profiles(&mut roads, &terrain, &geometry.trims);
    stages::stamp_roads(&mut shaped, &roads, &geometry);
    let bridges = stages::bridge_decks(&roads);
    let (asphalt, sidewalks) = stages::street_polygons(&roads, &geometry);
    stages::sink_under_streets(&mut shaped, &[(&asphalt, 0.1), (&sidewalks, 0.25)], &[]);
    GeneratedMap {
        options: MapOptions {
            seed: 0,
            size: SIZE,
            cell: CELL,
            debug: false,
        },
        sea_level: 0.0,
        terrain,
        shaped,
        flow: vec![0.0; n],
        rivers: vec![],
        lakes: vec![],
        desirability: vec![0.0; n],
        centre: Point { x: 0.0, z: 0.0 },
        roads,
        geometry,
        bridges,
        blocks: vec![],
        buildings: vec![],
        parks: vec![],
        trees: vec![],
        lamps: vec![],
        timings: vec![],
    }
}

/// Metres from the spawn to the showroom's centre, along the start line's heading.
pub const AHEAD: f64 = 50.0;
/// The showroom spans this far to each side and from `BEHIND` to `FRONT` along its heading.
const SIDE_REACH: f64 = 55.0;
const BEHIND: f64 = 55.0;
const FRONT: f64 = 95.0;
/// Metres from the showroom's centre to the pond's centre, to its left or right.
pub const POND_OFFSET: f64 = 85.0;
pub const POND_RADIUS: f64 = 60.0;
/// Height of the dry island in the game's own units (the map's `PLATEAU` less `WATER_LEVEL`).
const POND_FLOOR: f64 = -5.0;

fn track_points(city: &Value) -> Vec<(f64, f64)> {
    let path = city["racetrack"]["path"].as_array().expect("a racetrack");
    path.chunks(2)
        .map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
        .collect()
}

/// The closest any track point comes to `(x, z)`.
fn track_distance(track: &[(f64, f64)], x: f64, z: f64) -> f64 {
    track
        .iter()
        .map(|&(tx, tz)| (tx - x).hypot(tz - z))
        .fold(f64::INFINITY, f64::min)
}

/// The generated city turned into the test world: the spawn is the racetrack's start line, a
/// showroom for every vehicle and item sits beside it (described by landmarks the server reads),
/// a pond for the boats is carved next to that, and the AI lives on the street grid far east.
pub fn test_world_city() -> Result<Value, String> {
    let mut city = city_from_map(&generate_test_map());
    let track = track_points(&city);
    let start = &city["racetrack"]["grid"][0];
    let (sx, sz, heading) = (
        start["x"].as_f64().ok_or("no start grid")?,
        start["z"].as_f64().ok_or("no start grid")?,
        start["angle"].as_f64().ok_or("no start grid")?,
    );
    // Forward along the start line, and to its right.
    let (fx, fz) = (heading.sin(), heading.cos());
    let (rx, rz) = (heading.cos(), -heading.sin());
    let at = |c: (f64, f64), u: f64, v: f64| (c.0 + rx * u + fx * v, c.1 + rz * u + fz * v);
    let clear = |c: (f64, f64), pond: (f64, f64)| {
        let mut ok = true;
        for u in (-(SIDE_REACH as i32)..=SIDE_REACH as i32).step_by(11) {
            for v in (-(BEHIND as i32)..=FRONT as i32).step_by(15) {
                let p = at(c, u as f64, v as f64);
                ok &= track_distance(&track, p.0, p.1) > 18.0;
            }
        }
        ok && track_distance(&track, pond.0, pond.1) > POND_RADIUS + 18.0
    };
    // Beside the start line, on whichever side has the room; further out until it fits.
    let mut found = None;
    'search: for lateral in [50.0, 70.0, 90.0, 120.0, 160.0, 220.0] {
        for side in [1.0, -1.0] {
            let base = (sx + rx * side * lateral, sz + rz * side * lateral);
            let c = (base.0 + fx * AHEAD, base.1 + fz * AHEAD);
            for pond_side in [1.0, -1.0] {
                let pond = at(c, pond_side * POND_OFFSET, 0.0);
                if clear(c, pond) {
                    found = Some((base, c, pond));
                    break 'search;
                }
            }
        }
    }
    let (spawn, centre, pond) = found.ok_or("no clear ground beside the racetrack")?;
    carve_pond(&mut city, pond);
    city["spawn"] = json!({"x": spawn.0, "z": spawn.1});
    let district = (
        DISTRICT.0 + DISTRICT.2 * (DISTRICT.3 - 1) as f64 / 2.0,
        DISTRICT.1 + DISTRICT.2 * (DISTRICT.3 - 1) as f64 / 2.0,
    );
    let landmarks = city["landmarks"].as_array_mut().unwrap();
    for (name, kind, p) in [
        ("SHOWROOM", "plaza", centre),
        ("BOAT POND", "harbour", pond),
        ("AI STREETS", "plaza", district),
    ] {
        landmarks.push(json!({"x": p.0.round(), "z": p.1.round(), "name": name, "kind": kind}));
    }
    Ok(city)
}

/// Digs the pond into the terrain heights (game units) with the same banks as the island's edge.
fn carve_pond(city: &mut Value, pond: (f64, f64)) {
    let heights = city["terrain"]["heights"]
        .as_array_mut()
        .expect("terrain heights");
    for (i, h) in heights.iter_mut().enumerate() {
        let (x, z) = (
            (i % SIDE) as f64 * CELL - SIZE / 2.0,
            (i / SIDE) as f64 * CELL - SIZE / 2.0,
        );
        let d = (x - pond.0).hypot(z - pond.1);
        if d > POND_RADIUS + 6.0 {
            continue;
        }
        let ground = h.as_f64().unwrap();
        let bowl =
            ground + (POND_FLOOR - ground) * (1.0 - smooth((d - (POND_RADIUS - 24.0)) / 26.0));
        *h = json!((ground.min(bowl) * 100.0).round() / 100.0);
    }
}

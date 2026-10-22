mod support;
use afterhours_mapgen::{
    blocks::generate_blocks,
    buildings::{place_buildings, stamp_pads},
    geom::point_in_polygon,
    types::*,
    vegetation::{make_parks, place_vegetation},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
fn get<T: DeserializeOwned>(v: &Value, key: &str) -> T {
    serde_json::from_value(v[key].clone()).unwrap_or_else(|e| panic!("input {key}: {e}"))
}
#[test]
fn blocks_match_every_ts_output_field() {
    for seed in [713, 42] {
        let v = support::fixture(seed, "blocks-input");
        let out = generate_blocks(
            &get(&v, "graph"),
            &get(&v, "field"),
            &get(&v, "hydro"),
            get(&v, "centre"),
            seed,
        );
        support::compare(
            &format!("blocks {seed}"),
            &support::fixture(seed, "blocks"),
            &json!(out),
        );
    }
}
#[test]
fn buildings_match_every_ts_output_field() {
    for seed in [713, 42] {
        let v = support::fixture(seed, "buildings-input");
        let out = place_buildings(
            &get::<Vec<Block>>(&v, "blocks"),
            &get(&v, "field"),
            get(&v, "centre"),
            seed,
        );
        support::compare(
            &format!("buildings {seed}"),
            &support::fixture(seed, "buildings"),
            &json!(out),
        );
    }
}
#[test]
fn pads_match_every_ts_output_field() {
    for seed in [713, 42] {
        let v = support::fixture(seed, "pads-input");
        let mut f = get(&v, "field");
        stamp_pads(
            &mut f,
            &get::<Vec<BuildingPlacement>>(&v, "buildings"),
            Some(&get::<Vec<f32>>(&v, "protectedCells")),
        );
        support::compare(
            &format!("pads {seed}"),
            &support::fixture(seed, "pads"),
            &json!(f),
        );
    }
}
#[test]
fn parks_match_every_ts_output_field() {
    for seed in [713, 42] {
        let v = support::fixture(seed, "parks-input");
        let out = make_parks(
            &get::<Vec<Block>>(&v, "blocks"),
            &get(&v, "hydro"),
            &get(&v, "field"),
        );
        support::compare(
            &format!("parks {seed}"),
            &support::fixture(seed, "parks"),
            &json!(out),
        );
    }
}
#[test]
fn vegetation_matches_every_ts_output_field() {
    for seed in [713, 42] {
        let v = support::fixture(seed, "vegetation-input");
        let geometry: RoadGeometry = get(&v, "geometry");
        let on_street = |p: Point| {
            [
                p,
                Point {
                    x: p.x + 0.25,
                    z: p.z,
                },
                Point {
                    x: p.x - 0.25,
                    z: p.z,
                },
                Point {
                    x: p.x,
                    z: p.z + 0.25,
                },
                Point {
                    x: p.x,
                    z: p.z - 0.25,
                },
            ]
            .iter()
            .any(|q| {
                geometry
                    .bands
                    .iter()
                    .map(|b| &b.polygon)
                    .chain(geometry.junctions.iter().map(|j| &j.polygon))
                    .any(|poly| point_in_polygon(*q, poly))
            })
        };
        let (trees, lamps) = place_vegetation(
            &get(&v, "field"),
            &get(&v, "hydro"),
            &get(&v, "graph"),
            &get::<Vec<Block>>(&v, "blocks"),
            &get::<Vec<BuildingPlacement>>(&v, "buildings"),
            &get::<Vec<f32>>(&v, "desirability"),
            seed,
            on_street,
        );
        support::compare(
            &format!("vegetation {seed}"),
            &support::fixture(seed, "vegetation"),
            &json!({"trees":trees,"lamps":lamps}),
        );
    }
}

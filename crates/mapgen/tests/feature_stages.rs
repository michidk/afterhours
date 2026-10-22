mod support;
use afterhours_mapgen::{
    city_geometry::{KERB_HEIGHT, LIMIT, STREET_LIFT, TERRAIN_SIDE, TERRAIN_STEP},
    city_sink::sink_under_streets,
    city_types::{Airport, Building},
    features::{
        FeatureContext, PavedRing, dress_airport, place_harbours, place_racetrack, place_town_hall,
    },
    types::{GeneratedMap, Point},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
fn get<T: DeserializeOwned>(v: &Value, key: &str) -> T {
    serde_json::from_value(v[key].clone()).unwrap_or_else(|e| panic!("input {key}: {e}"))
}
fn context<'a>(map: &'a GeneratedMap, input: &Value, initial: &Value) -> FeatureContext<'a> {
    let asphalt: Vec<Vec<f64>> = get(initial, "asphalt");
    let sidewalks: Vec<Vec<f64>> = get(initial, "sidewalks");
    FeatureContext {
        map,
        heights: get(input, "heights"),
        roads: get(input, "roads"),
        buildings: get(input, "buildings"),
        asphalt: get(input, "asphalt"),
        sidewalks: get(input, "sidewalks"),
        markings: get(input, "markings"),
        taken: get(input, "taken"),
        wet: get(input, "wet"),
        paved_rings: asphalt
            .iter()
            .chain(&sidewalks)
            .map(|flat| {
                PavedRing::new(
                    flat.as_chunks::<3>()
                        .0
                        .iter()
                        .map(|p| Point { x: p[0], z: p[2] })
                        .collect(),
                )
            })
            .collect(),
    }
}
fn snapshot(ctx: &FeatureContext<'_>) -> Value {
    json!({"heights":ctx.heights,"roads":ctx.roads,"buildings":ctx.buildings,"asphalt":ctx.asphalt,"sidewalks":ctx.sidewalks,"markings":ctx.markings,"taken":ctx.taken,"wet":ctx.wet})
}
#[test]
fn feature_stages_match_every_ts_output_field() {
    for seed in [713, 42] {
        let map: GeneratedMap = serde_json::from_value(support::fixture(seed, "map")).unwrap();
        let initial = support::fixture(seed, "feature-before-town-hall");
        let city = support::fixture(seed, "city");
        let mut ctx = context(&map, &initial, &initial);
        let town = place_town_hall(&mut ctx);
        support::compare(
            &format!("townhall context {seed}"),
            &support::fixture(seed, "feature-after-town-hall"),
            &snapshot(&ctx),
        );
        support::compare(
            &format!("townhall return {seed}"),
            &city["townHall"],
            &json!(town),
        );
        for i in 0..2 {
            let input = support::fixture(seed, &format!("feature-before-airport-{i}"));
            let mut ctx = context(&map, &input, &initial);
            let airport: Airport = get(&input, "airport");
            dress_airport(&mut ctx, &airport);
            support::compare(
                &format!("airport dressing {seed}/{i}"),
                &support::fixture(seed, &format!("feature-after-airport-{i}")),
                &snapshot(&ctx),
            );
        }
        let input = support::fixture(seed, "feature-after-airports");
        let mut ctx = context(&map, &input, &initial);
        let track = place_racetrack(&mut ctx);
        support::compare(
            &format!("racetrack context {seed}"),
            &support::fixture(seed, "feature-after-racetrack"),
            &snapshot(&ctx),
        );
        support::compare(
            &format!("racetrack return {seed}"),
            &city["racetrack"],
            &json!(track),
        );
        let input = support::fixture(seed, "feature-after-racetrack");
        let mut ctx = context(&map, &input, &initial);
        let harbours = place_harbours(&mut ctx);
        support::compare(
            &format!("harbours context {seed}"),
            &support::fixture(seed, "feature-after-harbours"),
            &snapshot(&ctx),
        );
        support::compare(
            &format!("harbours return {seed}"),
            &city["harbours"],
            &json!(harbours),
        );
    }
}
#[test]
fn street_sink_matches_every_ts_output_height() {
    for seed in [713, 42] {
        let map: GeneratedMap = serde_json::from_value(support::fixture(seed, "map")).unwrap();
        let initial = support::fixture(seed, "feature-before-town-hall");
        let input = support::fixture(seed, "feature-before-sink");
        let mut ctx = context(&map, &input, &initial);
        let pads: Vec<Building> = input["pads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| Building {
                x: p["x"].as_f64().unwrap(),
                z: p["z"].as_f64().unwrap(),
                w: p["w"].as_f64().unwrap(),
                d: p["d"].as_f64().unwrap(),
                h: 0.0,
                y: p["y"].as_f64(),
                angle: p["angle"].as_f64(),
                asset: String::new(),
                facing: 0.0,
                color: String::new(),
                style: 0,
            })
            .collect();
        sink_under_streets(
            &mut ctx.heights,
            TERRAIN_SIDE,
            TERRAIN_STEP,
            LIMIT,
            &[
                (&ctx.asphalt, STREET_LIFT),
                (&ctx.sidewalks, STREET_LIFT + KERB_HEIGHT),
            ],
            &pads,
        );
        support::compare(
            &format!("street sink {seed}"),
            &support::fixture(seed, "feature-after-sink"),
            &snapshot(&ctx),
        );
    }
}

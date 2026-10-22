//! Full TS oracle: MAPGEN_DUMP_ROOT=/tmp/afterhours-geometry cargo test -p
//! afterhours-mapgen --test geometry_parity -- --ignored --nocapture
use afterhours_mapgen::{roadgeometry::*, types::*};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn dump(seed: i32) -> PathBuf {
    let root = std::env::var_os("MAPGEN_DUMP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("afterhours-geometry"));
    let path = root.join(seed.to_string());
    if !path.join("street-test.json").exists() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("bun")
            .current_dir(repo)
            .args([
                "scripts/mapgen-dump.ts",
                "--geometry-stages",
                "--seed",
                &seed.to_string(),
                "--out",
            ])
            .arg(&path)
            .output()
            .expect("run bun TS oracle");
        assert!(
            output.status.success(),
            "TS oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    path
}
fn load<T: DeserializeOwned>(dir: &Path, name: &str) -> T {
    serde_json::from_reader(std::fs::File::open(dir.join(format!("{name}.json"))).unwrap()).unwrap()
}
fn compare(dir: &Path, name: &str, actual: &impl Serialize) {
    let expected: Value = load(dir, name);
    let actual = serde_json::to_value(actual).unwrap();
    compare_value(name, &expected, &actual);
}
fn compare_value(name: &str, expected: &Value, actual: &Value) {
    if let Some(d) = afterhours_mapgen::parity::first_difference(expected, actual) {
        panic!(
            "{name}: first difference at {}: expected {}, actual {}",
            d.path, d.expected, d.actual
        );
    }
    fn max_delta(a: &Value, b: &Value, max: &mut (f64, f64)) {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => {
                let a = a.as_f64().unwrap();
                let b = b.as_f64().unwrap();
                max.0 = max.0.max((a - b).abs());
                max.1 = max.1.max((a - b).abs() / a.abs().max(b.abs()).max(1.));
            }
            (Value::Array(a), Value::Array(b)) => {
                for (a, b) in a.iter().zip(b) {
                    max_delta(a, b, max);
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                for (k, a) in a {
                    max_delta(a, &b[k], max);
                }
            }
            _ => {}
        }
    }
    let mut max = (0_f64, 0_f64);
    max_delta(expected, actual, &mut max);
    eprintln!(
        "{name}: max absolute delta={:.17e}, max relative delta={:.17e}",
        max.0, max.1
    );
}
#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn centrelines_match_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let mut graph: RoadGraph = load(&dir, "input-graph");
        smooth_centrelines(&mut graph);
        compare(&dir, "smooth-graph", &graph);
        let mut graph = load(&dir, "smooth-graph");
        densify_centrelines(&mut graph);
        compare(&dir, "dense-graph", &graph);
    }
}
#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn junctions_match_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let graph = load(&dir, "dense-graph");
        compare(&dir, "geometry", &build_road_geometry(&graph));
    }
}
#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn profiles_match_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let mut graph = load(&dir, "dense-graph");
        let field = load(&dir, "input-field");
        let geometry: RoadGeometry = load(&dir, "geometry");
        solve_profiles(&mut graph, &field, &geometry.trims);
        compare(&dir, "profile-graph", &graph);
    }
}
#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn stamp_and_bridges_match_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let graph = load(&dir, "profile-graph");
        let mut field = load(&dir, "input-field");
        let geometry = load(&dir, "geometry");
        let cells = stamp_roads(&mut field, &graph, &geometry);
        compare(&dir, "stamped-field", &field);
        compare(&dir, "road-cells", &cells);
        compare(&dir, "bridges", &bridge_decks(&graph));
    }
}

#[derive(serde::Deserialize)]
struct SinkInput {
    grid: afterhours_mapgen::streetfit::TerrainGrid,
    layers: Vec<afterhours_mapgen::streetfit::StreetLayer>,
    pads: Vec<afterhours_mapgen::streetfit::StreetPad>,
}
#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn street_fit_matches_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let graph = load(&dir, "profile-graph");
        let geometry = load(&dir, "geometry");
        let actual = afterhours_mapgen::streetfit::street_polygons(&graph, &geometry);
        compare(
            &dir,
            "streets",
            &serde_json::json!({"asphalt": actual.0, "sidewalks": actual.1}),
        );
        let input: SinkInput = load(&dir, "sink-input");
        let mut grid = input.grid.clone();
        afterhours_mapgen::streetfit::sink_under_streets(&mut grid, &input.layers, &input.pads);
        let expected: HeightField = load(&dir, "sunk-field");
        compare(&dir, "sunk-field", &grid_to_field(&grid, &expected));
        let tests: serde_json::Value = load(&dir, "street-test");
        for row in tests.as_array().unwrap() {
            let margin = row["margin"].as_f64().unwrap();
            let queries = row["queries"].as_array().unwrap();
            let test = afterhours_mapgen::streetfit::street_test(&geometry, margin);
            let got: Vec<_> = queries
                .iter()
                .map(|q| {
                    test(Point {
                        x: q["x"].as_f64().unwrap(),
                        z: q["z"].as_f64().unwrap(),
                    })
                })
                .collect();
            assert_eq!(
                got,
                row["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_bool().unwrap())
                    .collect::<Vec<_>>(),
                "street test seed {seed} margin {margin}"
            );
        }
    }
}
fn grid_to_field(
    grid: &afterhours_mapgen::streetfit::TerrainGrid,
    template: &HeightField,
) -> HeightField {
    HeightField {
        w: template.w,
        h: template.h,
        cell: template.cell,
        size: template.size,
        data: grid.heights.clone(),
    }
}

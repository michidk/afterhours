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
    use std::sync::{Mutex, OnceLock};
    static DUMPS: OnceLock<Mutex<std::collections::HashMap<i32, PathBuf>>> = OnceLock::new();
    let mut dumps = DUMPS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap();
    if let Some(path) = dumps.get(&seed) {
        return path.clone();
    }
    let root = std::env::var_os("MAPGEN_DUMP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("afterhours-geometry-{}", std::process::id()))
        });
    let path = root.join(seed.to_string());
    if !path.join("street-test.json").exists() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("node")
            .current_dir(repo)
            .args([
                "--import",
                "tsx",
                "scripts/mapgen-dump.ts",
                "--geometry-stages",
                "--seed",
                &seed.to_string(),
                "--out",
            ])
            .arg(&path)
            .output()
            .expect("run the Node TS oracle");
        assert!(
            output.status.success(),
            "TS oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    dumps.insert(seed, path.clone());
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
    if let Some(d) = afterhours_mapgen::parity::first_difference_exact(expected, actual) {
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
        let tests: Value = load(&dir, "street-test");
        check_street_queries(&format!("seed {seed} street-test"), &tests, &geometry);
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

fn decode<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap()
}
fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/geometry-helpers.json")).unwrap()
}
#[test]
fn centreline_helpers_match_small_ts_fixtures() {
    let fixture = fixtures();
    for (i, row) in fixture["helpers"].as_array().unwrap().iter().enumerate() {
        let points: Vec<Point> = decode(&row["points"]);
        let check = |name: &str, got: Value| {
            compare_value(&format!("helper[{i}].{name}"), &row[name], &got)
        };
        check(
            "simplified",
            serde_json::to_value(simplify_polyline(&points, 0.9)).unwrap(),
        );
        check(
            "catmull",
            serde_json::to_value(catmull_rom(&points, 4.)).unwrap(),
        );
        check(
            "rounded",
            serde_json::to_value(round_corners(&points, 12., 0.4)).unwrap(),
        );
        let (left, right) = offset_polyline(&points, 6.);
        check("offset", serde_json::json!({"left":left,"right":right}));
        let trimmed: Vec<_> = [(0., 0.), (3., 5.), (40., 50.)]
            .iter()
            .map(|&(a, b)| trim_polyline(&points, a, b))
            .collect();
        check("trimmed", serde_json::to_value(trimmed).unwrap());
        let at: Vec<_> = [-2., 0., 3., 17., 200.]
            .iter()
            .map(|&d| point_at(&points, d))
            .collect();
        check("at", serde_json::to_value(at).unwrap());
        check("radii", serde_json::to_value(bend_radii(&points)).unwrap());
        check(
            "grades",
            serde_json::to_value(bend_grades(&points, 0.1)).unwrap(),
        );
        check(
            "widened",
            serde_json::to_value(widen_bends(&points, 14.)).unwrap(),
        );
    }
}
#[test]
fn small_graph_stages_match_ts_fixtures() {
    use afterhours_mapgen::streetfit::{TerrainGrid, sink_under_streets, street_polygons};
    let fixture = fixtures();
    let fit = &fixture["fit"];
    let check = |name: &str, got: Value| compare_value(&format!("small.{name}"), &fit[name], &got);
    // Isolate each function using the oracle's preceding output, including profiles
    // and geometry. This keeps a failure's path tied to the function under test.
    let mut graph = decode(&fit["inputGraph"]);
    smooth_centrelines(&mut graph);
    check("smooth", serde_json::to_value(graph).unwrap());
    let mut graph = decode(&fit["smooth"]);
    densify_centrelines(&mut graph);
    check("dense", serde_json::to_value(graph).unwrap());
    let mut graph = decode(&fit["dense"]);
    let geometry: RoadGeometry = decode(&fit["geometry"]);
    check(
        "geometry",
        serde_json::to_value(build_road_geometry(&graph)).unwrap(),
    );
    let field: HeightField = decode(&fit["field"]);
    solve_profiles(&mut graph, &field, &geometry.trims);
    check("profile", serde_json::to_value(graph).unwrap());
    let graph = decode(&fit["profile"]);
    let mut shaped = field.clone();
    let cells = stamp_roads(&mut shaped, &graph, &geometry);
    check("cells", serde_json::to_value(cells).unwrap());
    check("stamped", serde_json::to_value(shaped).unwrap());
    check(
        "bridges",
        serde_json::to_value(bridge_decks(&graph)).unwrap(),
    );
    let (asphalt, sidewalks) = street_polygons(&graph, &geometry);
    check(
        "streets",
        serde_json::json!({"asphalt":asphalt,"sidewalks":sidewalks}),
    );
    let input: SinkInput = decode(&fit["sinkInput"]);
    let mut grid: TerrainGrid = input.grid;
    sink_under_streets(&mut grid, &input.layers, &input.pads);
    check(
        "sunk",
        serde_json::to_value(grid_to_field(&grid, &field)).unwrap(),
    );
    check_street_queries("small.street-test", &fit["tests"], &geometry);
    for row in fixture["sampling"].as_array().unwrap() {
        let p: Point = decode(&row["p"]);
        compare_value(
            "sample",
            &row["y"],
            &serde_json::json!(afterhours_mapgen::field::sample(&field, p.x, p.z)),
        );
    }
}
fn check_street_queries(name: &str, tests: &Value, geometry: &RoadGeometry) {
    for (i, row) in tests.as_array().unwrap().iter().enumerate() {
        let test =
            afterhours_mapgen::streetfit::street_test(geometry, row["margin"].as_f64().unwrap());
        let queries: Vec<Point> = decode(&row["queries"]);
        let results: Vec<_> = queries.into_iter().map(test).collect();
        compare_value(
            &format!("{name}[{i}]"),
            &row["results"],
            &serde_json::json!(results),
        );
    }
}
#[test]
fn surface_helpers_match_small_ts_fixtures() {
    use afterhours_mapgen::streetfit::*;
    let fixture = fixtures();
    let surface = &fixture["surface"];
    let check =
        |name: &str, got: Value| compare_value(&format!("surface.{name}"), &surface[name], &got);
    let grid = decode(&surface["grid"]);
    let polygons: Vec<Vec<f64>> = decode(&surface["polygons"]);
    let avoid: Vec<Vec<f64>> = decode(&surface["avoid"]);
    check(
        "draped",
        serde_json::to_value(drape_on_terrain(&polygons, &grid, &[])).unwrap(),
    );
    check(
        "avoided",
        serde_json::to_value(drape_on_terrain(&polygons, &grid, &avoid)).unwrap(),
    );
    let input: Vec<Vec<f64>> = decode(&surface["weldInput"]);
    check(
        "welded",
        serde_json::to_value(weld_corners(&input)).unwrap(),
    );
    check(
        "closed",
        serde_json::to_value(close_t_junctions(&input, None)).unwrap(),
    );
    check(
        "tagged",
        serde_json::to_value(close_t_junctions(&input, Some(&[1, 0, 2]))).unwrap(),
    );
    check(
        "sealed",
        serde_json::to_value(seal_surfaces(&[
            decode(&surface["draped"]),
            decode(&surface["avoided"]),
        ]))
        .unwrap(),
    );
    for row in surface["snaps"].as_array().unwrap() {
        compare_value(
            "snapCm",
            &row[1],
            &serde_json::json!(snap_cm(row[0].as_f64().unwrap())),
        );
    }
}

#[test]
#[ignore = "full-size seed 713 and 42 oracle generation; see docs/rust-refactor.md"]
fn chained_geometry_matches_ts() {
    for seed in [713, 42] {
        let dir = dump(seed);
        let mut graph: RoadGraph = load(&dir, "input-graph");
        smooth_centrelines(&mut graph);
        compare(&dir, "smooth-graph", &graph);
        densify_centrelines(&mut graph);
        compare(&dir, "dense-graph", &graph);
        let geometry = build_road_geometry(&graph);
        compare(&dir, "geometry", &geometry);
        let field = load(&dir, "input-field");
        solve_profiles(&mut graph, &field, &geometry.trims);
        compare(&dir, "profile-graph", &graph);
        let mut shaped = field;
        let cells = stamp_roads(&mut shaped, &graph, &geometry);
        compare(&dir, "stamped-field", &shaped);
        compare(&dir, "road-cells", &cells);
        compare(&dir, "bridges", &bridge_decks(&graph));
        let (asphalt, sidewalks) = afterhours_mapgen::streetfit::street_polygons(&graph, &geometry);
        compare(
            &dir,
            "streets",
            &serde_json::json!({"asphalt":asphalt,"sidewalks":sidewalks}),
        );
        let tests: Value = load(&dir, "street-test");
        check_street_queries(
            &format!("chained seed {seed} street-test"),
            &tests,
            &geometry,
        );
    }
}

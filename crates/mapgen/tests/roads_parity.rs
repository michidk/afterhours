//! Run with `cargo test -p afterhours-mapgen --test roads_parity -- --nocapture`.
//! MAPGEN_ROAD_DUMP_ROOT may point at existing <seed>/ oracle dumps while debugging.
use afterhours_mapgen::{RoadInputs, generate_roads};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn dumps(seed: i32) -> PathBuf {
    if let Some(root) = std::env::var_os("MAPGEN_ROAD_DUMP_ROOT") {
        return PathBuf::from(root).join(seed.to_string());
    }
    let root = std::env::temp_dir().join(format!("afterhours-roads-{}-{seed}", std::process::id()));
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .current_dir(repo)
        .args([
            "--import",
            "tsx",
            "scripts/mapgen-dump.ts",
            "--roads-only",
            "--seed",
            &seed.to_string(),
            "--out",
        ])
        .arg(&root)
        .output()
        .expect("node with tsx is required to run the TypeScript oracle");
    assert!(
        output.status.success(),
        "oracle failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    root
}
#[derive(Default)]
struct Delta {
    absolute: f64,
    relative: f64,
}
fn compare(
    expected: &Value,
    actual: &Value,
    path: &str,
    field: &str,
    deltas: &mut BTreeMap<String, Delta>,
) -> Result<(), String> {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            // Both reference seeds match exactly, so even a sub-tolerance change
            // needs an explanation. JSON's integer/float spelling is immaterial.
            let x = a.as_f64().unwrap();
            let y = b.as_f64().unwrap();
            let delta = (x - y).abs();
            let relative = delta / x.abs().max(y.abs()).max(1.0);
            let d = deltas.entry(field.to_owned()).or_default();
            d.absolute = d.absolute.max(delta);
            d.relative = d.relative.max(relative);
            if (a.is_i64() && b.is_i64() && a != b) || delta != 0.0 {
                return Err(format!(
                    "{path}: expected {a}, actual {b}, absolute delta {delta:e}, relative delta {relative:e}"
                ));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Err(format!(
                    "{path}.length: expected {}, actual {}",
                    a.len(),
                    b.len()
                ));
            }
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                compare(a, b, &format!("{path}[{i}]"), &format!("{field}[]"), deltas)?;
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.keys().ne(b.keys()) {
                return Err(format!("{path}: object keys differ"));
            }
            for (k, a) in a {
                compare(
                    a,
                    &b[k],
                    &format!("{path}.{k}"),
                    &format!("{field}.{k}"),
                    deltas,
                )?;
            }
        }
        _ if expected == actual => {}
        _ => return Err(format!("{path}: expected {expected}, actual {actual}")),
    }
    Ok(())
}
fn check(seed: i32) {
    let root = dumps(seed);
    let inputs: RoadInputs =
        serde_json::from_slice(&fs::read(root.join("road-inputs.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_slice(&fs::read(root.join("roads-generated.json")).unwrap()).unwrap();
    let actual = generate_roads(&inputs, None);
    let actual = serde_json::to_value(actual).unwrap();
    fs::write(
        root.join("roads-rust.json"),
        serde_json::to_vec(&actual).unwrap(),
    )
    .unwrap();
    let mut deltas = BTreeMap::new();
    let result = compare(&expected, &actual, "$", "$", &mut deltas);
    for (field, d) in deltas {
        eprintln!(
            "seed {seed} {field}: max abs={:e}, max relative={:e}",
            d.absolute, d.relative
        );
    }
    if let Err(difference) = result {
        panic!(
            "seed {seed}: first difference at {difference}; dumps: {}",
            root.display()
        );
    }
    eprintln!("seed {seed}: kinds, bridge flags, array order and lengths also match exactly");
}
#[test]
fn road_graph_matches_seed_713() {
    check(713);
}
#[test]
fn road_graph_matches_seed_42() {
    check(42);
}

#[test]
fn comparator_reports_the_first_changed_coordinate_even_below_tolerance() {
    let expected = serde_json::json!({"edges": [{"points": [{"x": 1.0}]}]});
    let actual = serde_json::json!({"edges": [{"points": [{"x": 1.0000000000001}]}]});
    let difference = compare(&expected, &actual, "$", "$", &mut BTreeMap::new()).unwrap_err();
    assert!(
        difference.starts_with("$.edges[0].points[0].x:"),
        "{difference}"
    );
}

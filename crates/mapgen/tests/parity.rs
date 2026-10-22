use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

fn count_mismatches(
    expected: &Value,
    actual: &Value,
    path: &str,
    mismatches: &mut usize,
    max_number_delta: &mut f64,
) {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            if let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) {
                *max_number_delta = (*max_number_delta).max((a - b).abs());
                if (a - b).abs() > 1e-6 {
                    *mismatches += 1;
                }
            } else if a != b {
                *mismatches += 1;
            }
        }
        (Value::String(a), Value::String(b)) if a != b => *mismatches += 1,
        (Value::Bool(a), Value::Bool(b)) if a != b => *mismatches += 1,
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                *mismatches += 1;
            }
            for (index, value) in a.iter().enumerate().take(b.len()) {
                count_mismatches(
                    value,
                    &b[index],
                    &format!("{path}[{index}]"),
                    mismatches,
                    max_number_delta,
                );
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                if let Some(other) = b.get(key) {
                    count_mismatches(
                        value,
                        other,
                        &format!("{path}.{key}"),
                        mismatches,
                        max_number_delta,
                    );
                } else {
                    *mismatches += 1;
                }
            }
            for key in b.keys() {
                if !a.contains_key(key) {
                    *mismatches += 1;
                }
            }
        }
        _ => *mismatches += 1,
    }
}

#[test]
fn seed_713_artifact_is_loadable_and_parity_deltas_are_reported() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let out = std::env::temp_dir().join(format!("afterhours-mapgen-{stamp}.json"));
    let status = Command::new(env!("CARGO_BIN_EXE_generate-city"))
        .args(["--seed", "713", "--out"])
        .arg(&out)
        .status()
        .expect("run generate-city");
    assert!(status.success(), "generate-city exited with {status}");
    let actual: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_slice(&fs::read("../../data/city.json").unwrap()).unwrap();
    assert_eq!(actual["format"], "afterhours-city");
    assert_eq!(actual["version"], 7);
    assert_eq!(actual["city"]["seed"], 713);
    assert_eq!(
        actual["city"]["terrain"]["cm"].as_str().unwrap().len(),
        expected["city"]["terrain"]["cm"].as_str().unwrap().len()
    );
    let mut mismatches = 0;
    let mut max_number_delta = 0.0;
    count_mismatches(
        &expected,
        &actual,
        "$",
        &mut mismatches,
        &mut max_number_delta,
    );
    eprintln!(
        "seed 713 parity: {mismatches} differing values, max numeric delta {max_number_delta:.9}"
    );
    fs::remove_file(out).ok();
}

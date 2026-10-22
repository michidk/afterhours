#![allow(dead_code)]
use serde_json::Value;
use std::{path::PathBuf, process::Command, sync::OnceLock};
fn dump_root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        if let Some(root) = std::env::var_os("MAPGEN_DUMP_ROOT") {
            return PathBuf::from(root);
        }
        let root =
            std::env::temp_dir().join(format!("afterhours-city-parity-{}", std::process::id()));
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for seed in [713, 42] {
            let status = Command::new("node")
                .current_dir(&repo)
                .arg("--import")
                .arg("tsx")
                .arg("scripts/mapgen-dump.ts")
                .arg("--seed")
                .arg(seed.to_string())
                .arg("--out")
                .arg(root.join(seed.to_string()))
                .status()
                .expect("node and tsx must be installed to run the TypeScript parity oracle");
            assert!(status.success(), "TypeScript oracle failed for seed {seed}");
        }
        root
    })
}
pub fn fixture(seed: i32, name: &str) -> Value {
    let path = dump_root()
        .join(seed.to_string())
        .join(format!("{name}.json"));
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}
pub fn compare(label: &str, expected: &Value, actual: &Value) {
    if let Some(diff) = afterhours_mapgen::parity::first_exact_difference(expected, actual) {
        panic!(
            "{label}: first difference at {}: expected {}, actual {}",
            diff.path, diff.expected, diff.actual
        );
    }
    fn deltas(a: &Value, b: &Value, max: &mut (f64, f64)) {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => {
                let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
                let d = (a - b).abs();
                max.0 = max.0.max(d);
                max.1 = max.1.max(d / a.abs().max(b.abs()).max(1.0));
            }
            (Value::Array(a), Value::Array(b)) => {
                for (a, b) in a.iter().zip(b) {
                    deltas(a, b, max)
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                for (k, a) in a {
                    deltas(a, &b[k], max)
                }
            }
            _ => {}
        }
    }
    let mut max = (0.0, 0.0);
    deltas(expected, actual, &mut max);
    println!(
        "{label}: max absolute delta={:.17e}, max relative delta={:.17e}",
        max.0, max.1
    );
    assert!(
        max.0 == 0.0,
        "{label}: unexplained float delta abs={:.17e} rel={:.17e}",
        max.0,
        max.1
    );
}
pub fn cmp(label: &str, expected: &Value, actual: &Value) {
    compare(label, expected, actual);
}

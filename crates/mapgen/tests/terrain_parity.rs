//! Run the unchanged TypeScript stages as an oracle; production Rust never shells out.
use afterhours_mapgen::{
    derive,
    hydrology::{fill_depressions, flow_accumulation, generate_hydrology_in_place},
    parity::first_difference,
    shoreline::lake_shorelines,
    site::{choose_centre, desirability_field},
    terrain::{
        droplet_erosion, generate_heightmap, keep_main_island, settle, shape_coast, thermal_erosion,
    },
    types::Point,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Dumps {
    path: PathBuf,
    temporary: bool,
}
impl Dumps {
    fn generate(seed: i32) -> Self {
        if let Some(path) = env::var_os("MAPGEN_DUMP_ROOT") {
            return Self {
                path: PathBuf::from(path).join(seed.to_string()),
                temporary: false,
            };
        }
        let path = env::temp_dir().join(format!(
            "afterhours-terrain-parity-{}-{seed}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("node")
            .current_dir(repo)
            .args([
                "--import",
                "tsx",
                "scripts/mapgen-dump.ts",
                "--terrain-only",
                "--seed",
                &seed.to_string(),
                "--out",
            ])
            .arg(&path)
            .output()
            .expect("install Node (with the repo's tsx) to run the TypeScript parity oracle");
        assert!(
            output.status.success(),
            "oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self {
            path,
            temporary: true,
        }
    }
    fn load(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.path.join(format!("{name}.json"))).unwrap()).unwrap()
    }
}
impl Drop for Dumps {
    fn drop(&mut self) {
        if self.temporary {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn deltas(expected: &Value, actual: &Value, max: &mut (f64, f64)) {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            let a = a.as_f64().unwrap();
            let b = b.as_f64().unwrap();
            max.0 = max.0.max((a - b).abs());
            max.1 = max.1.max((a - b).abs() / a.abs().max(b.abs()).max(1.0));
        }
        (Value::Array(a), Value::Array(b)) => {
            for (a, b) in a.iter().zip(b) {
                deltas(a, b, max);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, a) in a {
                if let Some(b) = b.get(key) {
                    deltas(a, b, max);
                }
            }
        }
        _ => {}
    }
}
fn assert_stage(seed: i32, name: &str, expected: Value, actual: Value) {
    let mut max = (0.0, 0.0);
    deltas(&expected, &actual, &mut max);
    println!(
        "seed {seed} {name}: max absolute={:.17e}, max relative={:.17e}",
        max.0, max.1
    );
    if let Some(d) = first_difference(&expected, &actual) {
        panic!(
            "seed {seed} {name}: first difference {} expected={} actual={}",
            d.path, d.expected, d.actual
        );
    }
}
#[derive(Deserialize)]
struct ShorelineCase {
    name: String,
    heights: Vec<f64>,
    side: usize,
    step: f64,
    half: f64,
    seeds: Vec<u8>,
    level: f64,
    rings: Vec<Vec<Point>>,
}

fn verify(seed: i32) {
    let dumps = Dumps::generate(seed);
    let (mut field, flatness) = generate_heightmap(seed, 3072.0, 8.0);
    assert_stage(
        seed,
        "terrain",
        dumps.load("terrain"),
        json!({"field":field,"flatness":flatness}),
    );
    thermal_erosion(&mut field, 10, 0.6);
    assert_stage(
        seed,
        "thermal-1",
        dumps.load("erosion-thermal-1"),
        json!(field),
    );
    let droplets = ((field.w * field.h) as f64 * 0.7).round() as usize;
    droplet_erosion(&mut field, &mut derive(seed, "droplets"), droplets);
    assert_stage(seed, "droplet", dumps.load("erosion-droplet"), json!(field));
    thermal_erosion(&mut field, 4, 0.6);
    assert_stage(
        seed,
        "thermal-2",
        dumps.load("erosion-thermal-2"),
        json!(field),
    );
    settle(&mut field, 1);
    assert_stage(seed, "settle", dumps.load("erosion-settle"), json!(field));
    keep_main_island(&mut field, 0.0);
    assert_stage(seed, "island", dumps.load("erosion-island"), json!(field));
    shape_coast(&mut field, 0.0);
    assert_stage(seed, "coast", dumps.load("erosion"), json!(field));
    let mut filled = field.clone();
    let depth = fill_depressions(&mut filled, 0.0, 0.002);
    let (dir, flux) = flow_accumulation(&filled, 0.0);
    assert_stage(
        seed,
        "fill and D8",
        dumps.load("hydrology-fill"),
        json!({"field":filled,"depth":depth,"dir":dir,"flux":flux}),
    );
    let hydro = generate_hydrology_in_place(&mut field, seed, 0.0);
    let expected = dumps.load("hydrology");
    let mut actual = json!(hydro);
    actual
        .as_object_mut()
        .unwrap()
        .insert("field".into(), json!(field));
    for key in [
        "field",
        "flow",
        "rivers",
        "lakes",
        "riverMask",
        "waterDistance",
        "coastDistance",
    ] {
        assert_stage(
            seed,
            &format!("hydrology.{key}"),
            expected[key].clone(),
            actual[key].clone(),
        );
    }
    assert_stage(seed, "hydrology", expected, actual);
    let desirability = desirability_field(&field, &hydro, seed);
    assert_stage(
        seed,
        "site",
        dumps.load("site"),
        json!({"desirability":desirability,"centre":choose_centre(&field,&desirability)}),
    );
    let cases: Vec<ShorelineCase> = serde_json::from_value(dumps.load("shoreline")).unwrap();
    for c in cases {
        let rings = lake_shorelines(&c.heights, c.side, c.step, c.half, &c.seeds, c.level);
        assert_stage(
            seed,
            &format!("shoreline.{}", c.name),
            json!(c.rings),
            json!(rings),
        );
    }
}
#[test]
fn seed_713_matches_typescript_stages() {
    verify(713);
}
#[test]
fn seed_42_matches_typescript_stages() {
    verify(42);
}

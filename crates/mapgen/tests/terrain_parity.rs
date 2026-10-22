use afterhours_mapgen::field::clone_field;
use afterhours_mapgen::site::{choose_centre, desirability_field};
use afterhours_mapgen::{
    derive,
    hydrology::generate_hydrology,
    parity::first_difference,
    terrain::{
        TERRAIN_DEFAULTS, droplet_erosion, generate_heightmap_with_tuning, keep_main_island,
        settle, shape_coast, thermal_erosion,
    },
};
use serde_json::Value;
use std::{env, fs};
fn load(dir: &str, name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(format!("{dir}/{name}.json")).unwrap()).unwrap()
}
fn assert_stage(expected: Value, actual: Value, name: &str) {
    if let Some(d) = first_difference(&expected, &actual) {
        panic!(
            "{name}: first difference {} expected={} actual={}",
            d.path, d.expected, d.actual
        )
    }
}
#[test]
fn terrain_stages_match_oracle_dump() {
    let Ok(dir) = env::var("MAPGEN_DUMP") else {
        return;
    };
    let seed = env::var("MAPGEN_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(713);
    let result = generate_heightmap_with_tuning(seed, 3072.0, 8.0, TERRAIN_DEFAULTS);
    assert_stage(
        load(&dir, "terrain"),
        serde_json::to_value(&result).unwrap(),
        "terrain",
    );
    let mut f = clone_field(&result.field);
    thermal_erosion(&mut f, 10, 0.6);
    assert_stage(
        load(&dir, "erosion-thermal-1"),
        serde_json::to_value(&f).unwrap(),
        "thermal-1",
    );
    let droplets = ((f.w * f.h) as f64 * 0.7).round() as usize;
    droplet_erosion(&mut f, &mut derive(seed, "droplets"), droplets);
    assert_stage(
        load(&dir, "erosion-droplet"),
        serde_json::to_value(&f).unwrap(),
        "droplet",
    );
    thermal_erosion(&mut f, 4, 0.6);
    assert_stage(
        load(&dir, "erosion-thermal-2"),
        serde_json::to_value(&f).unwrap(),
        "thermal-2",
    );
    settle(&mut f, 1);
    assert_stage(
        load(&dir, "erosion-settle"),
        serde_json::to_value(&f).unwrap(),
        "settle",
    );
    keep_main_island(&mut f, 0.0);
    assert_stage(
        load(&dir, "erosion-island"),
        serde_json::to_value(&f).unwrap(),
        "island",
    );
    shape_coast(&mut f, 0.0);
    assert_stage(
        load(&dir, "erosion"),
        serde_json::to_value(&f).unwrap(),
        "coast",
    );
}
#[test]
fn hydrology_and_site_match_oracle_dump() {
    let Ok(dir) = env::var("MAPGEN_DUMP") else {
        return;
    };
    let seed = env::var("MAPGEN_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(713);
    let result = generate_heightmap_with_tuning(seed, 3072.0, 8.0, TERRAIN_DEFAULTS);
    let mut f = clone_field(&result.field);
    thermal_erosion(&mut f, 10, 0.6);
    let droplets = ((f.w * f.h) as f64 * 0.7).round() as usize;
    droplet_erosion(&mut f, &mut derive(seed, "droplets"), droplets);
    thermal_erosion(&mut f, 4, 0.6);
    settle(&mut f, 1);
    keep_main_island(&mut f, 0.0);
    shape_coast(&mut f, 0.0);
    let hydro = generate_hydrology(&mut f, seed, 0.0);
    let expected = load(&dir, "hydrology");
    let actual = serde_json::json!({"field":f,"flow":hydro.flow,"rivers":hydro.rivers,"lakes":hydro.lakes,"riverMask":hydro.river_mask,"waterDistance":hydro.water_distance,"coastDistance":hydro.coast_distance});
    assert_stage(expected, actual, "hydrology");
    let desirability = desirability_field(&f, &hydro, seed);
    let site_expected = load(&dir, "site");
    let site_actual = serde_json::json!({"desirability": desirability, "centre": choose_centre(&f, &desirability)});
    assert_stage(site_expected, site_actual, "site");
}

//! Full-pipeline acceptance is enabled when the terrain and road stages land.
mod support;
#[test]
#[ignore = "requires the merged native terrain and road stages"]
fn seed_713_artifact_matches_checked_in_city() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/city.json");
    let expected = std::fs::read(path).expect("checked-in city artifact");
    let options = afterhours_mapgen::types::MapOptions {
        seed: 713,
        size: 3072.0,
        cell: 8.0,
        debug: false,
    };
    let map = afterhours_mapgen::pipeline::generate_map(options, None);
    let city = afterhours_mapgen::city::city_from_map(&map);
    let actual = afterhours_mapgen::packing::artifact(&city).unwrap();
    let expected = serde_json::from_slice(&expected).unwrap();
    support::compare("native seed 713 artifact", &expected, &actual);
}

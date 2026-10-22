//! Full-pipeline acceptance is enabled when the terrain and road stages land.
#[test]
#[ignore = "requires the merged native terrain and road stages plus data/city.json"]
fn seed_713_artifact_matches_checked_in_city() {
    let expected = std::fs::read_to_string("data/city.json").expect("checked-in city artifact");
    let options = afterhours_mapgen::types::MapOptions {
        seed: 713,
        size: 3072.0,
        cell: 8.0,
        debug: false,
    };
    let map = afterhours_mapgen::pipeline::generate_map(options, None);
    let actual = serde_json::to_string(&afterhours_mapgen::city::city_from_map(&map)).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&expected).unwrap();
    let actual: serde_json::Value = serde_json::from_str(&actual).unwrap();
    assert!(afterhours_mapgen::parity::first_difference(&expected, &actual).is_none());
}

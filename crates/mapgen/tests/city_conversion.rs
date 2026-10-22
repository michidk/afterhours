mod support;
use afterhours_mapgen::{city::city_from_map, packing, types::GeneratedMap};
#[test]
fn complete_city_and_packed_artifact_match_typescript_inputs() {
    let results: Vec<_> = [713, 42]
        .into_iter()
        .map(|seed| {
            let map: GeneratedMap = serde_json::from_value(support::fixture(seed, "map")).unwrap();
            let actual = city_from_map(&map);
            (seed, actual)
        })
        .collect();
    for (seed, actual) in results {
        support::compare(
            &format!("city seed {seed}"),
            &support::fixture(seed, "city"),
            &actual,
        );
        support::compare(
            &format!("artifact seed {seed}"),
            &support::fixture(seed, "artifact"),
            &packing::artifact(&actual).unwrap(),
        );
    }
}
#[test]
fn terrain_packing_matches_complete_typescript_city() {
    for seed in [713, 42] {
        let city = support::fixture(seed, "city");
        support::compare(
            &format!("packing seed {seed}"),
            &support::fixture(seed, "artifact"),
            &packing::artifact(&city).unwrap(),
        );
    }
}

#[test]
fn node_seed_713_oracle_matches_checked_in_artifact() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/city.json");
    let checked_in = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    support::compare(
        "checked-in city vs Node oracle 713",
        &checked_in,
        &support::fixture(713, "artifact"),
    );
}

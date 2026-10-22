//! Full-pipeline acceptance is enabled when the terrain and road stages land.
mod support;
#[test]
#[ignore = "requires the merged native terrain and road stages"]
fn seed_713_artifact_matches_checked_in_city() {
    let expected_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/city.json");
    let expected = std::fs::read(expected_path).expect("checked-in city artifact");
    let out =
        std::env::temp_dir().join(format!("afterhours-full-city-{}.json", std::process::id()));
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_generate-city"))
        .args(["--seed", "713", "--out"])
        .arg(&out)
        .output()
        .expect("generate-city binary");
    assert!(
        result.status.success(),
        "generate-city failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let actual = std::fs::read(&out).expect("generated city artifact");
    std::fs::remove_file(out).unwrap();
    support::compare(
        "native CLI seed 713 artifact",
        &serde_json::from_slice(&expected).unwrap(),
        &serde_json::from_slice(&actual).unwrap(),
    );
}

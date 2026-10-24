use std::process::Command;
#[test]
fn rejects_missing_or_invalid_seed_without_writing_an_artifact() {
    for seed_args in [
        vec!["--seed"],
        vec!["--seed", "nope"],
        vec!["--seed", "2147483648"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_generate-city"))
            .args(seed_args)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("--seed"));
    }
}
#[test]
fn reports_pending_native_integration_without_writing_an_artifact() {
    if afterhours_mapgen::pipeline::NATIVE_STAGES_AVAILABLE {
        return;
    }
    let out = std::env::temp_dir().join(format!("afterhours-cli-{}.json", std::process::id()));
    assert!(!out.exists());
    let result = Command::new(env!("CARGO_BIN_EXE_generate-city"))
        .args(["--seed", "713", "--out"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("have not been merged"));
    assert!(!out.exists());
}

use afterhours_mapgen::{packing, testworld::test_world_city};
use std::{env, fs, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    let out = PathBuf::from(
        env::args()
            .skip_while(|a| a != "--out")
            .nth(1)
            .unwrap_or_else(|| "data/test-world.json".into()),
    );
    let city = match test_world_city() {
        Ok(city) => city,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    for (k, v) in city.as_object().unwrap() {
        let size = v
            .as_array()
            .map(|a| a.len().to_string())
            .unwrap_or_else(|| v.to_string().chars().take(80).collect());
        eprintln!("{k}: {size}");
    }
    let artifact = match packing::artifact(&city) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    fs::write(&out, serde_json::to_string(&artifact).unwrap() + "\n").unwrap();
    println!("-> {}", out.display());
    ExitCode::SUCCESS
}

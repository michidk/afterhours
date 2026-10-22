use afterhours_mapgen::{
    city::city_from_map,
    packing,
    pipeline::{NATIVE_STAGES_AVAILABLE, generate_map},
    types::MapOptions,
};
use std::{env, fs, path::PathBuf, process::ExitCode};
fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    fn option(args: &[String], name: &str, fallback: &str) -> Result<String, String> {
        let Some(i) = args.iter().position(|a| a == name) else {
            return Ok(fallback.into());
        };
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("{name} requires a value"))?;
        Ok(value.clone())
    }
    let seed = option(&args, "--seed", "713")?
        .parse::<i32>()
        .map_err(|_| "--seed must be an integer in the signed 32-bit range".to_string())?;
    let out = PathBuf::from(option(&args, "--out", "data/city.json")?);
    if !NATIVE_STAGES_AVAILABLE {
        return Err("native terrain and road integration stages have not been merged".into());
    }
    let mut progress = |stage: &str| eprintln!("  {stage}");
    let map = generate_map(
        MapOptions {
            seed,
            size: 3072.0,
            cell: 8.0,
            debug: false,
        },
        Some(&mut progress),
    );
    let city = city_from_map(&map);
    let artifact = packing::artifact(&city)?;
    if let Some(parent) = out.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(
        &out,
        serde_json::to_string(&artifact).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("{}: {e}", out.display()))?;
    println!(
        "Generated city {seed}: {} road segments, {} buildings -> {}",
        city["roads"].as_array().unwrap().len(),
        city["buildings"].as_array().unwrap().len(),
        out.display()
    );
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("generate-city: {e}");
            ExitCode::FAILURE
        }
    }
}

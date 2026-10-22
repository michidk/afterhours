//! City artifact entry point.
//!
//! The artifact is deliberately produced by the existing TypeScript oracle while
//! the Rust stages are ported.  This keeps server boots and checked-in artifacts
//! byte-for-byte stable during the migration.  Remove this bridge once the Rust
//! pipeline owns every stage and the parity test is green without it.

use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

fn usage() {
    eprintln!("usage: generate-city --seed N --out PATH");
}

fn find_root() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;
    cwd.ancestors()
        .find(|root| root.join("scripts/generate-city.ts").is_file())
        .map(Path::to_path_buf)
}

fn option(args: &[String], name: &str, default: &str) -> Result<String, String> {
    let Some(index) = args.iter().position(|arg| arg == name) else {
        return Ok(default.to_owned());
    };
    let value = args
        .get(index + 1)
        .ok_or_else(|| format!("{name} requires a value"))?;
    if value.starts_with("--") {
        return Err(format!("{name} requires a value"));
    }
    Ok(value.clone())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        usage();
        return ExitCode::SUCCESS;
    }
    let seed = match option(&args, "--seed", "713").and_then(|value| {
        value
            .parse::<i32>()
            .map_err(|_| "--seed must be an integer".to_owned())
    }) {
        Ok(seed) => seed,
        Err(error) => {
            eprintln!("error: {error}");
            usage();
            return ExitCode::from(2);
        }
    };
    let out = match option(&args, "--out", "data/city.json") {
        Ok(out) => out,
        Err(error) => {
            eprintln!("error: {error}");
            usage();
            return ExitCode::from(2);
        }
    };
    let root = match find_root() {
        Some(root) => root,
        None => {
            eprintln!("error: cannot find repository root containing scripts/generate-city.ts");
            return ExitCode::from(1);
        }
    };
    let script = env::var_os("CITY_TS_GENERATOR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("scripts/generate-city.ts"));
    if !script.is_file() {
        eprintln!(
            "error: TypeScript generator does not exist: {}",
            script.display()
        );
        return ExitCode::from(1);
    }
    // shortcut: Rust stage port is still in progress; invoke the parity oracle until
    // all stages are native, and upgrade when the parity test no longer needs TS.
    let seed_text = seed.to_string();
    let status = Command::new("bun")
        .current_dir(&root)
        .args(["--import", "tsx"])
        .arg(script)
        .args(["--seed", &seed_text, "--out", &out])
        .status();
    match status {
        Ok(status) if status.success() => ExitCode::SUCCESS,
        Ok(status) => status
            .code()
            .map_or(ExitCode::from(1), |code| ExitCode::from(code as u8)),
        Err(error) => {
            eprintln!("error: could not run bun: {error}");
            ExitCode::from(1)
        }
    }
}

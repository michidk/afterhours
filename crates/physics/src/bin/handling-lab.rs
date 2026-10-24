//! Handling lab: runs a vehicle scenario and prints the result as JSON.
//!   handling-lab --list                       named scenarios, with what each one shows
//!   handling-lab <name> [--trace]             run a named scenario (metrics only unless --trace)
//!   handling-lab --json '<scenario>' [--trace]  or the same JSON on stdin with `handling-lab -`
use afterhours_physics::lab::{PRESETS, Scenario, preset, run};
use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let trace = args.iter().any(|a| a == "--trace");
    let words: Vec<&String> = args.iter().filter(|a| *a != "--trace").collect();
    let scenario: Result<Scenario, String> = match words.as_slice() {
        [] | [_, ..] if words.first().is_some_and(|w| *w == "--list") => {
            let list: Vec<_> = PRESETS
                .iter()
                .map(|(name, about, json)| serde_json::json!({"name": name, "about": about, "scenario": serde_json::from_str::<serde_json::Value>(json).unwrap()}))
                .collect();
            println!("{}", serde_json::to_string_pretty(&list).unwrap());
            return;
        }
        [flag, json] if *flag == "--json" => serde_json::from_str(json).map_err(|e| e.to_string()),
        [dash] if *dash == "-" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).unwrap();
            serde_json::from_str(&text).map_err(|e| e.to_string())
        }
        [name] => preset(name).ok_or_else(|| format!("no scenario {name:?}; try --list")),
        _ => {
            Err("usage: handling-lab --list | handling-lab <name> [--trace] | handling-lab --json '<scenario>' | handling-lab -".into())
        }
    };
    match scenario.and_then(|s| run(&s)) {
        Ok(report) if trace => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report.metrics).unwrap()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    }
}

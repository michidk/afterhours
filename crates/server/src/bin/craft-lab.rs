//! Craft handling lab: flies one helicopter, plane or boat over flat ground and prints its trace.
//!   craft-lab '{"model":"plane","script":[{"seconds":10,"throttle":1}]}'
//! Steps: `{seconds, throttle, steer, ascend, descend, brake}`; also `height`, `start_speed`.
use afterhours_protocol::Controls;
use serde::Deserialize;

#[derive(Deserialize)]
struct Step {
    seconds: f32,
    #[serde(default)]
    throttle: f32,
    #[serde(default)]
    steer: f32,
    #[serde(default)]
    ascend: bool,
    #[serde(default)]
    descend: bool,
    #[serde(default)]
    brake: bool,
}

#[derive(Deserialize)]
struct Scenario {
    model: String,
    #[serde(default)]
    height: f32,
    #[serde(default)]
    start_speed: f32,
    script: Vec<Step>,
}

fn main() {
    let Some(json) = std::env::args().nth(1) else {
        eprintln!("usage: craft-lab '<scenario json>'");
        std::process::exit(2);
    };
    let scenario: Scenario = serde_json::from_str(&json).unwrap_or_else(|e| {
        eprintln!("bad scenario: {e}");
        std::process::exit(2);
    });
    let script: Vec<_> = scenario
        .script
        .iter()
        .map(|s| {
            (
                s.seconds,
                Controls {
                    move_x: Some(s.steer),
                    move_y: Some(s.throttle),
                    ascend: s.ascend,
                    descend: s.descend,
                    brake: s.brake,
                    ..Default::default()
                },
            )
        })
        .collect();
    match afterhours_server::craft::fly(
        &scenario.model,
        scenario.height,
        scenario.start_speed,
        &script,
    ) {
        Ok(trace) => println!("{}", serde_json::json!({ "trace": trace })),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

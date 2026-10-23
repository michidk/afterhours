//! The JSON command interface of the scene lab (`scene-lab`), driven the way a script or an
//! AI agent would: commands in, replies out, one scene across several commands.
use afterhours_server::lab::{COMMANDS, Lab};
use serde_json::{Value, json};

fn lab() -> Lab {
    Lab::boot(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/city.json"))
}

fn ok(reply: &Value) -> &Value {
    assert_eq!(reply["ok"], true, "{reply}");
    reply
}

#[test]
fn help_lists_every_command_and_unknown_ones_are_reported() {
    let mut lab = lab();
    let help = lab.exec(&json!({"cmd": "help"}));
    assert_eq!(
        ok(&help)["commands"].as_array().unwrap().len(),
        COMMANDS.len()
    );
    let bad = lab.exec(&json!({"cmd": "fly"}));
    assert_eq!(bad["ok"], false);
    assert!(bad["error"].as_str().unwrap().contains("help"));
}

#[test]
fn a_scripted_drive_reports_a_trace_and_metrics() {
    let mut lab = lab();
    ok(&lab.exec(&json!({"cmd": "track"})));
    ok(&lab.exec(&json!({"cmd": "spawn", "model": "sport"})));
    let boarded = lab.exec(&json!({"cmd": "board"}));
    assert!(ok(&boarded)["vehicle"].is_string());
    let run = lab.exec(&json!({"cmd": "drive", "ticks": 45, "throttle": 1, "every": 15}));
    let m = &ok(&run)["metrics"];
    assert!(m["top_speed"].as_f64().unwrap() > 5.0, "{m}");
    assert!(m["max_tilt"].as_f64().unwrap() < 0.4, "{m}");
    assert_eq!(run["trace"].as_array().unwrap().len(), 3);
    let stop = lab.exec(&json!({"cmd": "drive", "ticks": 300, "brake": true}));
    // The handbrake sheds the 20 m/s in about five seconds; this stretch of track is a
    // downhill, where gravity keeps a few m/s alive until the parking brake takes over.
    assert!(
        ok(&stop)["metrics"]["final_speed"].as_f64().unwrap() < 4.0,
        "{stop}"
    );
    let state = lab.exec(&json!({"cmd": "state", "radius": 20}));
    assert!(ok(&state)["vehicle"].is_string());
    let out = lab.exec(&json!({"cmd": "leave"}));
    assert_eq!(ok(&out)["on_foot"], true);
}

#[test]
fn walking_and_sprinting_on_foot_cover_the_original_paces() {
    let mut lab = lab();
    ok(&lab.exec(&json!({"cmd": "track"})));
    let walk = lab.exec(&json!({"cmd": "drive", "ticks": 90, "throttle": 1}));
    assert_eq!(ok(&walk)["on_foot"], true);
    // Three seconds from rest, easing in: close to 4.5 m/s.
    let pace = walk["metrics"]["mean_speed"].as_f64().unwrap();
    assert!((3.8..4.6).contains(&pace), "walked at {pace} m/s");
    let run = lab.exec(&json!({"cmd": "drive", "ticks": 90, "throttle": 1, "sprint": true}));
    let pace = ok(&run)["metrics"]["mean_speed"].as_f64().unwrap();
    assert!((7.0..8.2).contains(&pace), "sprinted at {pace} m/s");
}

#[test]
fn the_pursuit_bot_laps_the_track_and_bad_input_is_an_error_not_a_panic() {
    let mut lab = lab();
    ok(&lab.exec(&json!({"cmd": "track"})));
    ok(&lab.exec(&json!({"cmd": "board"})));
    let lap = lab.exec(&json!({"cmd": "follow", "ticks": 300, "speed": 10}));
    assert!(
        ok(&lap)["metrics"]["displacement"].as_f64().unwrap() > 20.0,
        "{lap}"
    );
    assert_eq!(lab.exec(&json!({"cmd": "spawn"}))["ok"], false);
    assert_eq!(lab.exec(&json!({"cmd": "debug"}))["ok"], false);
}

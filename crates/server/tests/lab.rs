//! The JSON command interface of the scene lab (`scene-lab`), driven the way a script or an
//! AI agent would: commands in, replies out, one scene across several commands.
use afterhours_server::City;
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

/// The footprint test of the original game's `insideBuilding`: local x runs along `(cos a, sin a)`.
fn inside(b: &afterhours_server::city::Building, x: f32, z: f32) -> bool {
    let (a, dx, dz) = (b.angle.unwrap_or(0.0), x - b.x, z - b.z);
    let (u, v) = (dx * a.cos() + dz * a.sin(), -dx * a.sin() + dz * a.cos());
    u.abs() < b.w / 2.0 && v.abs() < b.d / 2.0
}

/// A car driven flat out at rotated buildings of the real city stops at them. With the
/// colliders mirrored (the bug), cars drove through the drawn walls and stopped at open air.
#[test]
fn cars_driven_at_the_real_buildings_never_end_up_inside_one() {
    let city = City::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/city.json")).unwrap();
    let wide: Vec<_> = city
        .buildings
        .iter()
        .filter(|b| {
            b.w > 18.0 && b.h - b.y.unwrap_or(0.0) > 15.0 && b.angle.unwrap_or(0.0).abs() > 0.2
        })
        .collect();
    let picked: Vec<_> = wide
        .iter()
        .step_by((wide.len() / 16).max(1))
        .take(16)
        .collect();
    let (mut driven, mut stopped) = (0, 0);
    for b in picked {
        let mut lab = lab();
        lab.exec(&json!({"cmd": "teleport", "x": b.x, "z": b.z + 40.0}));
        lab.exec(&json!({"cmd": "spawn", "model": "sedan"}));
        if lab.exec(&json!({"cmd": "board"}))["ok"] != true {
            continue;
        }
        let run = lab.exec(&json!({"cmd": "drive", "ticks": 200, "throttle": 1, "every": 4}));
        let Some(trace) = run["trace"].as_array() else {
            continue;
        };
        driven += 1;
        stopped += (run["metrics"]["final_speed"].as_f64().unwrap() < 1.0) as u32;
        for t in trace {
            let (x, y, z) = (
                t["x"].as_f64().unwrap() as f32,
                t["y"].as_f64().unwrap() as f32,
                t["z"].as_f64().unwrap() as f32,
            );
            for other in &city.buildings {
                assert!(
                    !(y < other.h && y + 1.0 > other.y.unwrap_or(0.0) && inside(other, x, z)),
                    "a car drove into the building at ({}, {}): it is at ({x}, {z})",
                    other.x,
                    other.z
                );
            }
        }
    }
    assert!(driven >= 10, "only {driven} drives reached a building");
    assert!(
        stopped >= driven / 2,
        "only {stopped}/{driven} cars were stopped by a wall"
    );
}

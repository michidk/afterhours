//! Handling regressions, run through the scenario lab (`src/lab.rs`): each test is a named
//! scenario plus the numbers a well-behaved car must hit. Reproduce one by hand with
//! `cargo run -p afterhours-physics --bin handling-lab -- <name> --trace`.
use afterhours_physics::lab::{Metrics, PRESETS, preset, run};

/// (model, catalogue top speed in m/s)
const CARS: [(&str, f32); 3] = [("sedan", 42.0), ("sport", 52.0), ("van", 30.0)];

fn go(name: &str, model: &str) -> Metrics {
    let mut scenario = preset(name).unwrap_or_else(|| panic!("no preset {name}"));
    scenario.model = model.into();
    run(&scenario).unwrap().metrics
}

#[test]
fn every_preset_runs() {
    for (name, ..) in PRESETS {
        run(&preset(name).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

/// A parked car reports no velocity and sits level; a stale velocity makes clients that
/// extrapolate float it away.
#[test]
fn a_parked_car_is_still_and_level() {
    for (model, _) in CARS {
        let m = go("idle", model);
        assert!(m.final_vy.abs() < 0.02, "{model} reports vy {}", m.final_vy);
        assert!(m.top_speed < 0.02, "{model} drifts at {}", m.top_speed);
        assert!(
            m.max_pitch < 0.02 && m.max_roll < 0.02,
            "{model} rests tilted"
        );
    }
}

/// Flat out, a car levels off at its catalogue top speed instead of accelerating for ever.
#[test]
fn flat_out_levels_off_at_the_catalogue_top_speed() {
    for (model, top) in CARS {
        let m = go("flat-out", model);
        assert!(m.top_speed < top * 1.05, "{model} reached {}", m.top_speed);
        assert!(m.final_speed > top * 0.85, "{model} only {}", m.final_speed);
    }
}

/// The original game's brake is the handbrake: it locks the rear wheels, so a car sheds 20 m/s
/// over about five seconds (sedan 5.2, sport 4.4 in `scripts/compare-handling.ts`).
#[test]
fn braking_from_20_stops_like_the_original_without_diving_or_hopping() {
    for (model, _) in CARS {
        let m = go("brake-from-20", model);
        assert!(
            m.stopped_after.is_some_and(|t| (3.5..8.0).contains(&t)),
            "{model}: {:?}",
            m.stopped_after
        );
        assert!(m.max_pitch < 0.15, "{model} dived {}", m.max_pitch);
        assert!(m.max_hop < 0.5, "{model} hopped {}", m.max_hop);
    }
}

/// At 15 m/s full lock must turn inside a 40 m radius, leaning under 12 degrees.
#[test]
fn cars_turn_at_city_speeds_and_stay_level() {
    for (model, top) in CARS {
        let m = go("corner-15", model);
        assert!(
            m.mean_yaw_rate * 40.0 > m.final_speed,
            "{model} turns too wide: {m:?}"
        );
        assert!(m.max_roll < 0.21, "{model} leaned {}", m.max_roll);
        assert!(
            m.max_lateral < top * 0.1,
            "{model} slid at {}",
            m.max_lateral
        );
    }
}

#[test]
fn full_lock_at_speed_neither_flips_nor_leaves_the_ground() {
    for (model, _) in CARS {
        let m = go("full-lock-at-speed", model);
        assert!(m.max_roll < 0.5, "{model} rolled {}", m.max_roll);
        assert!(
            m.max_height < 1.6,
            "{model} left the ground: {}",
            m.max_height
        );
    }
}

/// On a hill the parking brake holds and the suspension settles instead of rocking.
#[test]
fn a_parked_car_on_a_slope_stays_put_and_stops_rocking() {
    for (model, _) in CARS {
        let m = go("park-on-slope", model);
        assert!(m.pitch_wobble < 0.02, "{model} rocks: {}", m.pitch_wobble);
        assert!(m.distance < 2.0, "{model} crept {} m", m.distance);
        assert!(
            m.final_speed < 0.1,
            "{model} still moving at {}",
            m.final_speed
        );
    }
}

#[test]
fn a_car_climbs_a_steep_slope_under_power() {
    let m = go("climb-slope", "sedan");
    assert!(m.distance > 50.0, "only climbed {} m", m.distance);
    assert!(m.max_roll < 0.1, "rolled {}", m.max_roll);
}

#[test]
fn hitting_a_wall_stops_the_car_without_launching_it() {
    for (model, _) in CARS {
        let m = go("ram-wall-20", model);
        assert!(
            m.stopped_after.is_some_and(|t| t < 6.0),
            "{model}: {:?}",
            m.stopped_after
        );
        assert!(
            m.max_height < 2.0,
            "{model} was launched to {}",
            m.max_height
        );
        assert!(
            m.max_roll < 0.3 && m.max_pitch < 0.5,
            "{model} flipped: {m:?}"
        );
    }
}

#[test]
fn kerbs_and_rumble_strips_are_bumps_not_ramps() {
    for (model, _) in CARS {
        let kerb = go("curb-at-10", model);
        assert!(
            kerb.max_height < 1.7 && kerb.max_hop < 1.0,
            "{model} kerb: {kerb:?}"
        );
        let strips = go("rumble-strips", model);
        assert!(strips.max_hop < 0.5, "{model} strips: {strips:?}");
    }
}

/// Hitting a parked car flat out is a crash, not a launch: the car may pitch and lean but
/// must not come anywhere near rolling over.
#[test]
fn hitting_a_parked_car_flat_out_does_not_roll_the_car() {
    for (model, _) in CARS {
        let m = go("ram-parked-car", model);
        assert!(m.max_roll < 0.6, "{model} rolled {}", m.max_roll);
        assert!(m.max_pitch < 0.9, "{model} pitched {}", m.max_pitch);
        assert!(
            m.max_height < 2.2,
            "{model} was launched to {}",
            m.max_height
        );
    }
}

/// Reference numbers measured on the original TypeScript game (`scripts/compare-handling.ts`,
/// sedan): coasting 30 m/s for 10 s leaves 8.3, a 15 m/s turn at full lock leaves 9.2 m/s and
/// swings at 1.0 rad/s, and full lock at 38 m/s slides sideways at 7.6 m/s down to 15.7 m/s.
#[test]
fn the_sedan_drives_like_the_original() {
    let near = |got: f32, want: f32| (got - want).abs() <= want * 0.15;
    let coast = go("coast-from-30", "sedan");
    assert!(near(coast.final_speed, 8.3), "coast {}", coast.final_speed);
    let corner = go("corner-15", "sedan");
    assert!(
        near(corner.final_speed, 9.2),
        "corner {}",
        corner.final_speed
    );
    assert!(
        near(corner.mean_yaw_rate, 1.0),
        "yaw {}",
        corner.mean_yaw_rate
    );
    let lock = go("full-lock-at-speed", "sedan");
    assert!(near(lock.max_lateral, 7.6), "slide {}", lock.max_lateral);
    assert!(near(lock.final_speed, 15.7), "lock {}", lock.final_speed);
}

/// On foot, `main` walks at 4.5 m/s and sprints at 8 (`TUNING.walk` / `TUNING.sprint`).
#[test]
fn walking_and_sprinting_match_the_original_paces() {
    let walk = |sprint: bool| {
        let scenario = serde_json::from_value(serde_json::json!({
            "model": "walker",
            "script": [{ "seconds": 3, "throttle": 1, "sprint": sprint }],
        }))
        .unwrap();
        run(&scenario).unwrap().metrics
    };
    assert!((walk(false).top_speed - 4.5).abs() < 0.1);
    assert!((walk(true).top_speed - 8.0).abs() < 0.1);
    assert!(walk(false).max_lateral < 0.2, "walked crabwise");
}

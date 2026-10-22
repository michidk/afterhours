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

#[test]
fn braking_from_20_stops_quickly_without_diving_or_hopping() {
    for (model, _) in CARS {
        let m = go("brake-from-20", model);
        assert!(
            m.stopped_after.is_some_and(|t| t < 4.0),
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

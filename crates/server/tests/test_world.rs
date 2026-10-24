//! The hand-built test world (docs/test-world.md): the spawn at the racetrack's start line, one
//! of every vehicle beside it, a pond for the boats, and streets far away where the AI lives.
use afterhours_mapgen::{packing, testworld::test_world_city};
use afterhours_server::{City, lab::Lab};
use serde_json::{Value, json};

/// The generated world, written where `Lab::boot` can read it.
fn world() -> (String, City) {
    let path =
        std::env::temp_dir().join(format!("afterhours-test-world-{}.json", std::process::id()));
    let city = test_world_city().expect("the test world generates");
    std::fs::write(
        &path,
        serde_json::to_string(&packing::artifact(&city).unwrap()).unwrap(),
    )
    .unwrap();
    let path = path.to_str().unwrap().to_string();
    (path.clone(), City::load(&path).unwrap())
}

fn landmark(city: &City, name: &str) -> (f32, f32) {
    let l = city
        .landmarks
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["name"] == name)
        .unwrap();
    (
        l["x"].as_f64().unwrap() as f32,
        l["z"].as_f64().unwrap() as f32,
    )
}

fn nearby(lab: &mut Lab, radius: f64) -> Vec<Value> {
    let state = lab.exec(&json!({"cmd": "state", "radius": radius}));
    state["nearby"].as_array().expect("nearby entities").clone()
}

#[test]
fn the_showroom_holds_every_vehicle_beside_the_spawn_and_the_boats_float() {
    let (path, city) = world();
    let mut lab = Lab::boot(&path);
    let spawn = city.spawn();
    let (pond_x, pond_z) = landmark(&city, "BOAT POND");
    let near = nearby(&mut lab, 160.0);
    let models: std::collections::BTreeSet<_> =
        near.iter().filter_map(|e| e["model"].as_str()).collect();
    for model in [
        "sedan",
        "sport",
        "van",
        "scout",
        "utility",
        "plane",
        "aerobatic",
        "boat",
        "launch",
        "jetski",
        "racer",
        "speedboat",
        "offshore",
    ] {
        assert!(
            models.contains(model),
            "no {model} within 160 m of the spawn: {models:?}"
        );
    }
    // Exactly one of each: the placeholder cars are gone, no fleet is parked on top.
    let cars = near.iter().filter(|e| e["kind"] == "car").count();
    assert_eq!(cars, 3, "{cars} cars in the showroom");
    for e in &near {
        let (x, z) = (
            e["x"].as_f64().unwrap() as f32,
            e["z"].as_f64().unwrap() as f32,
        );
        let on_water = ["boat", "jetski", "speedboat"].contains(&e["kind"].as_str().unwrap_or(""));
        let floor = city.height(x, z);
        if on_water {
            assert!(
                floor < -3.0,
                "{} floats over only {floor} m of bed",
                e["model"]
            );
            assert!(
                (x - pond_x).hypot(z - pond_z) < 40.0,
                "{} is off the pond",
                e["model"]
            );
        } else if e["kind"] != "player" {
            assert!(floor > 0.0, "{} stands in the water", e["model"]);
        }
    }
    // The spawn is close to the pond and the showroom, not a kilometre away.
    assert!((spawn[0] - pond_x).hypot(spawn[1] - pond_z) < 150.0);
}

#[test]
fn the_ai_streets_are_far_away_and_come_alive_when_you_go_there() {
    let (path, city) = world();
    let mut lab = Lab::boot(&path);
    let (sx, sz) = (city.spawn()[0], city.spawn()[1]);
    // Nothing walks or drives about at the showroom.
    lab.exec(&json!({"cmd": "idle", "ticks": 300}));
    let alive = |near: &[Value]| {
        near.iter()
            .filter(|e| e["ai"].is_boolean() || e["kind"] == "pedestrian")
            .count()
    };
    assert_eq!(alive(&nearby(&mut lab, 160.0)), 0, "AI at the showroom");
    let (ax, az) = landmark(&city, "AI STREETS");
    assert!(
        (ax - sx).hypot(az - sz) > 400.0,
        "the AI streets are not a separate area"
    );
    lab.exec(&json!({"cmd": "teleport", "x": ax, "z": az}));
    lab.exec(&json!({"cmd": "idle", "ticks": 600}));
    let near = nearby(&mut lab, 220.0);
    let walkers = near.iter().filter(|e| e["kind"] == "pedestrian").count();
    let drivers = near
        .iter()
        .filter(|e| e["kind"] == "car" && !e["ai"].is_null())
        .count();
    assert!(walkers >= 1, "nobody walks the AI streets");
    assert!(drivers >= 1, "nobody drives the AI streets");
}

//! Headless scenes on the real city: boot exactly like `main.rs`, join players, step the
//! simulation and inspect what clients would see. No sockets, no wall-clock time.
use afterhours_protocol::{Controls, Entity};
use afterhours_server::lab::{Lab, off_centre, pursue};
use std::collections::HashMap;

type Scene = Lab;

fn boot() -> Scene {
    Lab::boot(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/city.json"))
}

/// Footprint (width, length) per model, from `shared/catalog.ts`.
fn footprint(model: Option<&str>) -> (f32, f32) {
    match model {
        Some("sport") => (1.9, 4.1),
        Some("van") => (2.2, 5.0),
        _ => (2.0, 4.3),
    }
}

/// Penetration depth of two oriented footprints on the ground plane (0 when apart), by SAT.
fn overlap(a: &Entity, b: &Entity) -> f32 {
    let corners = |e: &Entity| {
        let (w, l) = footprint(e.model.as_deref());
        let (s, c) = e.angle.sin_cos();
        [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].map(|(sx, sz)| {
            (
                e.x + sx * w / 2.0 * c + sz * l / 2.0 * s,
                e.z - sx * w / 2.0 * s + sz * l / 2.0 * c,
            )
        })
    };
    let (ca, cb) = (corners(a), corners(b));
    let mut depth = f32::INFINITY;
    for e in [a, b] {
        let (s, c) = e.angle.sin_cos();
        for axis in [(c, -s), (s, c)] {
            let project = |p: &[(f32, f32); 4]| {
                p.iter()
                    .map(|q| q.0 * axis.0 + q.1 * axis.1)
                    .fold((f32::MAX, f32::MIN), |m, v| (m.0.min(v), m.1.max(v)))
            };
            let (pa, pb) = (project(&ca), project(&cb));
            depth = depth.min(pa.1.min(pb.1) - pa.0.max(pb.0));
        }
    }
    depth.max(0.0)
}

#[test]
fn parked_fleet_stays_put_and_apart() {
    let mut scene = boot();
    scene.join(1);
    // Warm up until the first snapshot lists the fleet, and remember where it was parked.
    for _ in 0..4 {
        scene.step();
    }
    let parked: HashMap<String, Entity> = scene
        .cars(1)
        .into_iter()
        .filter(|c| c.ai != Some(true))
        .map(|c| (c.id.clone(), c))
        .collect();
    assert!(
        parked.len() >= 6,
        "expected the starter fleet, saw {}",
        parked.len()
    );
    let (mut worst_move, mut worst_tilt, mut worst_overlap) = (0.0f32, 0.0f32, 0.0f32);
    for t in 0..900 {
        scene.step();
        let cars = scene.cars(1);
        let ours: Vec<&Entity> = cars.iter().filter(|c| parked.contains_key(&c.id)).collect();
        for c in &ours {
            let p = &parked[&c.id];
            let moved = (c.x - p.x).hypot(c.z - p.z);
            worst_move = worst_move.max(moved);
            worst_tilt = worst_tilt.max(c.pitch.abs()).max(c.roll.abs());
            if moved > 0.5 {
                eprintln!(
                    "t={t} {} {:?} moved {moved:.2} m to ({:.1}, {:.1})",
                    c.id, c.model, c.x, c.z
                );
            }
        }
        for (i, a) in ours.iter().enumerate() {
            for b in &ours[i + 1..] {
                let d = overlap(a, b);
                if d > 0.05 {
                    eprintln!("t={t} overlap {:.2} m between {} and {}", d, a.id, b.id);
                }
                worst_overlap = worst_overlap.max(d);
            }
        }
        // AI cars crossing the car park count too.
        for a in &ours {
            for b in cars.iter().filter(|c| !parked.contains_key(&c.id)) {
                let d = overlap(a, b);
                if d > 0.05 {
                    eprintln!("t={t} AI {} overlaps parked {} by {:.2} m", b.id, a.id, d);
                }
                worst_overlap = worst_overlap.max(d);
            }
        }
    }
    eprintln!(
        "worst move {worst_move:.2} m, tilt {worst_tilt:.2} rad, overlap {worst_overlap:.2} m"
    );
    assert!(worst_move < 0.5, "parked cars drifted {worst_move:.2} m");
    assert!(worst_tilt < 0.15, "parked cars tilted {worst_tilt:.2} rad");
    assert!(
        worst_overlap < 0.05,
        "cars interpenetrate by {worst_overlap:.2} m"
    );
}

/// The dev tool's "spawn vehicle" button, pressed a few times in a row beside the
/// player, must leave the cars apart and at rest: no stacked bodies, no fling.
#[test]
fn repeated_debug_spawns_land_apart_and_settle() {
    let mut scene = boot();
    scene.join(1);
    for _ in 0..30 {
        scene.step();
    }
    let before: Vec<String> = scene.cars(1).into_iter().map(|c| c.id).collect();
    for model in ["sport", "sport", "van", "sedan"] {
        scene.debug(1, serde_json::json!({ "kind": "spawn", "model": model }));
        for _ in 0..10 {
            scene.step();
        }
    }
    let (mut worst_overlap, mut worst_speed, mut worst_tilt, mut worst_rise) =
        (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let mut start_y: HashMap<String, f32> = HashMap::new();
    for t in 0..300 {
        scene.step();
        let cars = scene.cars(1);
        let fresh: Vec<&Entity> = cars
            .iter()
            .filter(|c| !before.contains(&c.id) && c.ai != Some(true))
            .collect();
        assert_eq!(fresh.len(), 4, "all four debug cars exist");
        for c in &fresh {
            let y0 = *start_y.entry(c.id.clone()).or_insert(c.y);
            worst_rise = worst_rise.max(c.y - y0);
            if t >= 60 {
                worst_speed = worst_speed.max((c.vx * c.vx + c.vz * c.vz).sqrt());
                worst_tilt = worst_tilt.max(c.pitch.abs()).max(c.roll.abs());
            }
        }
        for (i, a) in fresh.iter().enumerate() {
            for b in &fresh[i + 1..] {
                worst_overlap = worst_overlap.max(overlap(a, b));
            }
        }
        // And against the parked starter fleet.
        for a in &fresh {
            for b in cars.iter().filter(|c| before.contains(&c.id)) {
                worst_overlap = worst_overlap.max(overlap(a, b));
            }
        }
    }
    eprintln!(
        "debug spawns: overlap {worst_overlap:.2} m, speed {worst_speed:.2} m/s, tilt {worst_tilt:.2} rad, rise {worst_rise:.2} m"
    );
    assert!(
        worst_overlap < 0.05,
        "spawned cars interpenetrate by {worst_overlap:.2} m"
    );
    assert!(
        worst_speed < 0.3,
        "unattended cars still move at {worst_speed:.2} m/s"
    );
    assert!(worst_tilt < 0.15, "cars tilted {worst_tilt:.2} rad");
    assert!(worst_rise < 1.5, "cars were flung {worst_rise:.2} m upward");
}

/// Lap the racetrack at 12 m/s with a pure-pursuit driver, then brake to a halt. Every
/// snapshot must move the car about as far as its speed says, the car must stay on the
/// 12 m wide track, keep level, and stop under braking.
#[test]
fn laps_the_racetrack_smoothly_and_stops() {
    let mut scene = boot();
    scene.join(1);
    for _ in 0..4 {
        scene.step();
    }
    scene.go_to_track(1);
    let car = scene.board(1);
    let at = |s: &Scene| s.cars(1).into_iter().find(|c| c.id == car).unwrap();
    let path = scene.path.clone();
    let (mut prev, mut worst_jump, mut worst_tilt, mut worst_vy) =
        (at(&scene), 0.0f32, 0.0f32, 0.0f32);
    let (mut worst_off, mut top, mut travelled) = (0.0f32, 0.0f32, 0.0f32);
    for t in 0..540 {
        scene.input(1, pursue(&path, &prev, 8.0, 12.0));
        scene.step();
        scene.step();
        let now = at(&scene);
        let moved = (now.x - prev.x).hypot(now.z - prev.z);
        let expected = (prev.vx.hypot(prev.vz) + now.vx.hypot(now.vz)) / 2.0 * (2.0 / 30.0);
        worst_jump = worst_jump.max((moved - expected).abs());
        worst_tilt = worst_tilt.max(now.pitch.abs()).max(now.roll.abs());
        worst_vy = worst_vy.max(now.vy.abs());
        worst_off = worst_off.max(off_centre(&path, now.x, now.z));
        top = top.max(now.vx.hypot(now.vz));
        travelled += moved;
        if t % 30 == 0 {
            eprintln!(
                "t={t} ({:.1},{:.1}) yaw {:.2} speed {:.1} off {:.1} y {:.2}",
                now.x,
                now.z,
                now.angle,
                now.vx.hypot(now.vz),
                off_centre(&path, now.x, now.z),
                now.y
            );
        }
        prev = now;
    }
    // The handbrake of the original game takes about five seconds to shed 20 m/s.
    for _ in 0..300 {
        scene.input(
            1,
            Controls {
                brake: true,
                ..Default::default()
            },
        );
        scene.step();
    }
    let end = at(&scene);
    let speed = end.vx.hypot(end.vz);
    eprintln!(
        "lap: {travelled:.0} m, top {top:.1} m/s, off-centre {worst_off:.1} m, jump {worst_jump:.2} m, tilt {worst_tilt:.2} rad, |vy| {worst_vy:.2}, final {speed:.2} m/s"
    );
    assert!(travelled > 300.0, "the car only covered {travelled:.0} m");
    // The bot cuts one hairpin by a few metres and recovers; losing the track is far more.
    assert!(worst_off < 10.0, "left the track by {worst_off:.1} m");
    assert!(
        worst_jump < 0.3,
        "snapshot jumped {worst_jump:.2} m off the velocity"
    );
    assert!(worst_tilt < 0.4, "tilt {worst_tilt:.2} rad");
    assert!(
        worst_vy < 5.0,
        "vertical speed {worst_vy:.1} m/s on a flat track"
    );
    assert!(speed < 1.0, "still at {speed:.2} m/s after braking");
}

/// A hard drive into a parked car must not launch or flip anything.
#[test]
fn ramming_a_parked_car_does_not_launch_it() {
    let mut scene = boot();
    scene.join(1);
    for _ in 0..4 {
        scene.step();
    }
    scene.go_to_track(1);
    let ours = scene.board(1);
    // Aim at the nearest other car and floor it.
    let others = |s: &Scene| {
        s.cars(1)
            .into_iter()
            .filter(|c| c.id != ours && c.ai != Some(true))
            .collect::<Vec<_>>()
    };
    let me = scene.cars(1).into_iter().find(|c| c.id == ours).unwrap();
    let victim = others(&scene)
        .into_iter()
        .min_by(|a, b| {
            (a.x - me.x)
                .hypot(a.z - me.z)
                .total_cmp(&(b.x - me.x).hypot(b.z - me.z))
        })
        .unwrap();
    let (mut tilt, mut rise) = (0.0f32, 0.0f32);
    let y0 = victim.y;
    for _ in 0..240 {
        let now = scene.cars(1).into_iter().find(|c| c.id == ours).unwrap();
        let want = (victim.x - now.x).atan2(victim.z - now.z);
        let mut err = want - now.angle;
        err = err.sin().atan2(err.cos());
        scene.input(
            1,
            Controls {
                up: true,
                move_x: Some(err.clamp(-1.0, 1.0)),
                move_y: Some(1.0),
                ..Default::default()
            },
        );
        scene.step();
        for c in scene.cars(1) {
            if c.ai != Some(true) {
                tilt = tilt.max(c.pitch.abs()).max(c.roll.abs());
            }
        }
        if let Some(v) = others(&scene).into_iter().find(|c| c.id == victim.id) {
            rise = rise.max(v.y - y0);
        }
    }
    eprintln!("ram: tilt {tilt:.2} rad, victim rise {rise:.2} m");
    assert!(tilt < 1.0, "a car rolled to {tilt:.2} rad");
    assert!(rise < 1.0, "the struck car was launched {rise:.2} m");
}

/// Every spawnable model accelerates on tarmac, stays level and rolls to a stop on the brake.
#[test]
fn every_car_model_drives_level_and_brakes_to_a_stop() {
    for model in ["sedan", "sport", "van"] {
        let mut scene = boot();
        scene.join(1);
        for _ in 0..4 {
            scene.step();
        }
        scene.go_to_track(1);
        scene.debug(1, serde_json::json!({ "kind": "spawn", "model": model }));
        for _ in 0..30 {
            scene.step();
        }
        let ours = scene.board(1);
        let find = |s: &Scene| s.cars(1).into_iter().find(|c| c.id == ours).unwrap();
        let start = find(&scene);
        let mut tilt = 0.0f32;
        // Short burst: the open tarmac is not long enough to hold full throttle for long.
        for _ in 0..45 {
            scene.input(
                1,
                Controls {
                    up: true,
                    move_y: Some(1.0),
                    ..Default::default()
                },
            );
            scene.step();
            let c = find(&scene);
            tilt = tilt.max(c.pitch.abs()).max(c.roll.abs());
        }
        let moved = find(&scene);
        let run = (moved.x - start.x).hypot(moved.z - start.z);
        assert!(run > 6.0, "{model} only covered {run:.1} m");
        assert!(tilt < 0.4, "{model} tilted {tilt:.2} rad");
        for _ in 0..300 {
            scene.input(
                1,
                Controls {
                    brake: true,
                    ..Default::default()
                },
            );
            scene.step();
        }
        let c = find(&scene);
        assert!(
            c.vx.hypot(c.vz) < 1.0,
            "{model} still at {:.1} m/s",
            c.vx.hypot(c.vz)
        );
    }
}

/// What clients draw is positioned by `Entity.y`: the renderer treats a car as airborne unless
/// its height is the ground under its wheels, and a pedestrian's model has its feet at `y`.
/// The physics body centres sit 1.26 m and 0.91 m above that, so the wire must subtract them.
#[test]
fn cars_and_people_are_reported_at_ground_height() {
    let mut scene = boot();
    scene.join(1);
    // Long enough for traffic and pedestrians, which have their own entity builders.
    for _ in 0..240 {
        scene.step();
    }
    let ground = |e: &Entity| scene.game.ground_height(e.x, e.z);
    let mut checked = (0, 0);
    let mut ai_cars = 0;
    for e in scene.seen[&1].values() {
        match e.kind {
            afterhours_protocol::Kind::Car => {
                let above = e.y - ground(e);
                assert!(above.abs() < 0.2, "car {} floats {above:.2} m", e.id);
                assert!(e.steering.is_some(), "car {} has no wheel angle", e.id);
                ai_cars += usize::from(e.ai == Some(true));
                checked.0 += 1;
            }
            afterhours_protocol::Kind::Pedestrian | afterhours_protocol::Kind::Player => {
                let above = e.y - ground(e);
                assert!(
                    above.abs() < 0.2,
                    "{:?} {} floats {above:.2} m",
                    e.kind,
                    e.id
                );
                checked.1 += 1;
            }
            _ => {}
        }
    }
    assert!(
        checked.0 > 3 && checked.1 > 0,
        "saw {checked:?} cars and people"
    );
    assert!(ai_cars > 0, "no traffic in view to check");
}

/// `Entity.steering` turns the drawn front wheels, so it must be the wheel angle in radians
/// easing toward lock, not the raw stick: full lock from straight takes about a fifth of a
/// second to reach the sedan's 0.55 rad (halved by speed).
#[test]
fn the_front_wheels_turn_gradually_to_the_steering_lock() {
    let mut scene = boot();
    scene.join(1);
    for _ in 0..4 {
        scene.step();
    }
    scene.go_to_track(1);
    scene.debug(1, serde_json::json!({ "kind": "spawn", "model": "sedan" }));
    for _ in 0..30 {
        scene.step();
    }
    let ours = scene.board(1);
    let steering = |s: &Scene| {
        s.cars(1)
            .into_iter()
            .find(|c| c.id == ours)
            .and_then(|c| c.steering)
            .unwrap()
    };
    let mut seen = vec![steering(&scene)];
    for _ in 0..12 {
        scene.input(
            1,
            Controls {
                right: true,
                move_x: Some(1.0),
                ..Default::default()
            },
        );
        scene.step();
        seen.push(steering(&scene));
    }
    assert!(seen[0].abs() < 0.01, "starts straight: {seen:?}");
    // Snapshots repeat every other tick, so the first change shows at the third sample.
    assert!(
        seen[2] > 0.0 && seen[2] < 0.2,
        "eases in, not a jump: {seen:?}"
    );
    let last = *seen.last().unwrap();
    assert!(
        (last - 0.55).abs() < 0.02,
        "settles at the 0.55 rad lock: {seen:?}"
    );
}

use afterhours_physics::*;

fn flat_world() -> World {
    let mut w = World::new();
    w.add_box([0.0, -0.5, 0.0], [200.0, 0.5, 200.0], 0.0);
    w
}

fn yaw(q: &[f32]) -> f32 {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + z * z))
}

#[test]
fn car_drives_forward_and_stays_on_the_ground() {
    let mut w = flat_world();
    let car = w.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.0);
    for _ in 0..30 {
        w.step();
    }
    let rest = w.states()[2];
    assert!(
        rest > 0.9 && rest < 1.3,
        "car should settle on its suspension, y={rest}"
    );
    w.set_drive(
        car,
        Drive {
            throttle: 1.0,
            steer: 0.0,
            brake: false,
            occupied: true,
            ..Drive::default()
        },
    );
    for _ in 0..90 {
        w.step();
    }
    let s = w.states();
    assert!(s[3] > 10.0, "car should have moved forward, z={}", s[3]);
    assert!(s[1].abs() < 0.5, "car should drive straight, x={}", s[1]);
    assert!(
        (s[2] - rest).abs() < 0.2,
        "car should stay on the ground, y={}",
        s[2]
    );
    w.set_drive(
        car,
        Drive {
            throttle: 0.0,
            steer: 0.0,
            brake: true,
            occupied: true,
            ..Drive::default()
        },
    );
    // 7 m/s² takes about five seconds to shed the 33 m/s a three second run reaches.
    for _ in 0..180 {
        w.step();
    }
    assert!(w.states()[10].abs() < 0.2, "brakes should stop the car");
}

#[test]
fn positive_steer_turns_right() {
    let mut w = flat_world();
    let car = w.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.0);
    w.set_drive(
        car,
        Drive {
            throttle: 0.3,
            steer: 1.0,
            brake: false,
            occupied: true,
            ..Drive::default()
        },
    );
    for _ in 0..45 {
        w.step();
    }
    let s = w.states();
    assert!(yaw(&s[4..8]) > 0.2, "yaw={}", yaw(&s[4..8]));
    assert!(s[1] > 0.5, "right turn moves toward +x, x={}", s[1]);
}

#[test]
fn character_walks_stops_at_walls_and_jumps() {
    let mut w = flat_world();
    w.add_box([0.0, 1.0, 5.0], [2.0, 1.0, 0.25], 0.0);
    let c = w.spawn_character([0.0, 1.0, 0.0]);
    for _ in 0..30 {
        w.step();
    }
    let s = w.states();
    assert!(
        s[5] == 1.0 && (s[2] - 0.9).abs() < 0.05,
        "should stand on the floor, y={}",
        s[2]
    );
    w.set_move(
        c,
        Move {
            x: 0.0,
            z: 1.0,
            speed: 4.5,
            jump: false,
        },
    );
    for _ in 0..90 {
        w.step();
    }
    let z = w.states()[3];
    assert!(
        z > 4.0 && z < 4.8,
        "wall at z=4.75 should stop the walk, z={z}"
    );
    // Jump is a per-tick edge: the client sends it once, not while the key is held.
    w.set_move(
        c,
        Move {
            x: 0.0,
            z: 0.0,
            speed: 0.0,
            jump: true,
        },
    );
    w.step();
    w.set_move(c, Move::default());
    let mut peak: f32 = 0.0;
    for _ in 0..40 {
        w.step();
        peak = peak.max(w.states()[2]);
    }
    assert!(peak > 1.8, "jump peak={peak}");
    assert_eq!(w.states()[5], 1.0, "should land again");
}

#[test]
fn restore_and_replay_matches_the_continuous_run() {
    let mut a = flat_world();
    let car = a.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.3);
    let who = a.spawn_character([3.0, 1.0, 0.0]);
    let mut b = flat_world();
    b.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.3);
    b.spawn_character([3.0, 1.0, 0.0]);
    let script = |w: &mut World, i: u32| {
        w.set_drive(
            car,
            Drive {
                throttle: 1.0,
                steer: (i as f32 / 10.0).sin(),
                brake: i % 40 > 35,
                occupied: true,
                ..Drive::default()
            },
        );
        w.set_move(
            who,
            Move {
                x: 0.5,
                z: 1.0,
                speed: 4.5,
                jump: i.is_multiple_of(25),
            },
        );
    };
    for i in 0..60 {
        script(&mut a, i);
        a.step();
    }
    b.restore(&a.snapshot()).unwrap();
    for i in 60..120 {
        script(&mut a, i);
        a.step();
        script(&mut b, i);
        b.step();
    }
    assert_eq!(a.states(), b.states());
    assert!(b.restore(&[0.0]).is_err());
}

#[test]
fn removed_entities_leave_states() {
    let mut w = flat_world();
    let car = w.spawn_vehicle(VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.0);
    let c = w.spawn_character([0.0, 1.0, 0.0]);
    assert_eq!(w.counts(), (1, 1));
    assert!(w.remove_vehicle(car) && !w.remove_vehicle(car));
    assert!(w.remove_character(c));
    w.step();
    assert!(w.states().is_empty());
}

#[test]
fn ray_reports_the_body_it_hits() {
    let mut w = flat_world();
    let shooter = w.spawn_character([0.0, 1.0, 0.0]);
    let target = w.spawn_character([0.0, 1.0, 5.0]);
    let car = w.spawn_vehicle(VehicleSpec::SEDAN, [10.0, 1.0, 0.0], 0.0);
    w.step();
    let (id, t) = w
        .cast_ray([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 40.0, shooter)
        .unwrap();
    assert_eq!(id, target);
    assert!(t > 4.0 && t < 5.0, "capsule front at ~4.65 m, got {t}");
    let (id, _) = w
        .cast_ray([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], 40.0, shooter)
        .unwrap();
    assert_eq!(id, car);
    // Downwards into the slab: static geometry reports id 0.
    let (id, t) = w
        .cast_ray([3.0, 2.0, 3.0], [0.0, -1.0, 0.0], 5.0, 0)
        .unwrap();
    assert_eq!((id, t), (0, 2.0));
    assert!(
        w.cast_ray([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], 40.0, shooter)
            .is_none()
    );
    // Thrust lifts the shooter; teleport puts it back at rest.
    w.set_vertical(shooter, 10.0);
    w.step();
    assert!(w.states()[VEHICLE_STRIDE + 2] > 1.2);
    w.teleport_character(shooter, [1.0, 1.0, 1.0]);
    assert_eq!(
        &w.states()[VEHICLE_STRIDE + 1..VEHICLE_STRIDE + 4],
        &[1.0, 1.0, 1.0]
    );
}

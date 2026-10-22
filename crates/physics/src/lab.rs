//! Scenario worlds for vehicle handling: a JSON description of the ground, the car and a
//! driving script goes in, a trace and summary metrics come out. Built for scripted and AI
//! use (`cargo run -p afterhours-physics --bin handling-lab -- --list`), and used by the handling
//! tests, so a problem found by hand is one JSON file away from a regression test.
use crate::{Drive, TICK, VEHICLE_STRIDE, VehicleSpec, World};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Ground {
    /// Dead-flat tarmac.
    #[default]
    Flat,
    /// A uniform incline rising along +z.
    Slope { degrees: f32 },
    /// A full-width wall `distance` metres ahead of the start.
    Wall { distance: f32 },
    /// A full-width step `height` metres tall, `distance` metres ahead.
    Curb { distance: f32, height: f32 },
    /// A car-sized solid `distance` metres ahead and `offset` metres to the right of the
    /// start line (a parked car, as far as the physics can tell).
    Obstacle { distance: f32, offset: f32 },
    /// `count` full-width ridges `spacing` metres apart, the first `start` metres ahead.
    Bumps {
        start: f32,
        height: f32,
        spacing: f32,
        count: u32,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Step {
    pub seconds: f32,
    #[serde(default)]
    pub throttle: f32,
    #[serde(default)]
    pub steer: f32,
    #[serde(default)]
    pub brake: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Scenario {
    #[serde(default)]
    pub ground: Ground,
    /// `sedan`, `sport` or `van`.
    #[serde(default = "sedan")]
    pub model: String,
    /// Forward speed in m/s the car starts with.
    #[serde(default)]
    pub start_speed: f32,
    pub script: Vec<Step>,
    /// Keep every n-th tick in the trace (1 keeps all).
    #[serde(default = "five")]
    pub sample_every: u32,
}

fn sedan() -> String {
    "sedan".into()
}
fn five() -> u32 {
    5
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Sample {
    pub t: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    /// Horizontal speed, m/s.
    pub speed: f32,
    /// Speed along the car's nose; negative when reversing.
    pub forward: f32,
    /// Speed across the nose: the car sliding sideways.
    pub lateral: f32,
    pub vy: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Metrics {
    pub top_speed: f32,
    pub final_speed: f32,
    /// Largest nose-up/down angle in radians.
    pub max_pitch: f32,
    pub max_roll: f32,
    /// Largest vertical speed either way: bouncing and hopping.
    pub max_hop: f32,
    pub max_height: f32,
    pub max_lateral: f32,
    /// Mean turn rate in rad/s over the whole script.
    pub mean_yaw_rate: f32,
    /// Metres covered over the ground.
    pub distance: f32,
    /// Seconds from the first sample until the car was last seen under 0.3 m/s after moving.
    pub stopped_after: Option<f32>,
    pub final_vy: f32,
    /// Peak-to-peak pitch over the last two seconds: a settled car reads ~0, a rocking one not.
    pub pitch_wobble: f32,
    pub roll_wobble: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub metrics: Metrics,
    pub trace: Vec<Sample>,
}

fn spec(model: &str) -> Result<VehicleSpec, String> {
    match model {
        "sedan" => Ok(VehicleSpec::SEDAN),
        "sport" => Ok(VehicleSpec::SPORT),
        "van" => Ok(VehicleSpec::VAN),
        other => Err(format!("unknown model {other:?}; use sedan, sport or van")),
    }
}

fn build(ground: &Ground) -> Result<World, String> {
    let mut w = World::new();
    let wide = 200.0;
    match ground {
        Ground::Slope { degrees } => {
            let (rise, far) = (degrees.to_radians().tan(), 3000.0);
            let vertices = [
                [-wide, rise * -far, -far],
                [wide, rise * -far, -far],
                [-wide, rise * far, far],
                [wide, rise * far, far],
            ]
            .concat();
            w.add_trimesh(&vertices, &[0, 2, 1, 1, 2, 3])?;
        }
        _ => w.add_box([0.0, -0.5, 0.0], [wide, 0.5, 4000.0], 0.0),
    }
    match ground {
        Ground::Wall { distance } => w.add_box([0.0, 2.0, *distance], [wide, 2.0, 0.5], 0.0),
        Ground::Curb { distance, height } => w.add_box(
            [0.0, height / 2.0, *distance],
            [wide, height / 2.0, 0.5],
            0.0,
        ),
        Ground::Obstacle { distance, offset } => {
            w.add_box([*offset, 0.7, *distance], [1.0, 0.7, 2.15], 0.0)
        }
        Ground::Bumps {
            start,
            height,
            spacing,
            count,
        } => {
            for i in 0..*count {
                let z = start + spacing * i as f32;
                w.add_box([0.0, height / 2.0, z], [wide, height / 2.0, 0.15], 0.0);
            }
        }
        _ => {}
    }
    Ok(w)
}

fn euler(r: &[f32]) -> (f32, f32, f32) {
    let (x, y, z, w) = (r[4], r[5], r[6], r[7]);
    (
        (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + z * z)),
        (2.0 * (w * x - y * z)).clamp(-1.0, 1.0).asin(),
        (2.0 * (w * z + x * y)).atan2(1.0 - 2.0 * (x * x + z * z)),
    )
}

fn sample(w: &World, t: f32) -> Sample {
    let s = w.states();
    let (yaw, pitch, roll) = euler(&s[..VEHICLE_STRIDE]);
    let (sn, cs) = yaw.sin_cos();
    Sample {
        t,
        x: s[1],
        y: s[2],
        z: s[3],
        yaw,
        pitch,
        roll,
        speed: s[8].hypot(s[10]),
        forward: s[8] * sn + s[10] * cs,
        lateral: s[8] * cs - s[10] * sn,
        vy: s[9],
    }
}

fn wobble(all: &[Sample], f: fn(&Sample) -> f32) -> f32 {
    let tail = &all[all.len().saturating_sub((2.0 / TICK) as usize)..];
    let (lo, hi) = tail
        .iter()
        .map(f)
        .fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
    hi - lo
}

/// Runs a scenario: the car settles for two seconds first, so `t` starts at the first
/// scripted tick and a parked car's metrics describe the car, not its drop.
pub fn run(scenario: &Scenario) -> Result<Report, String> {
    let mut w = build(&scenario.ground)?;
    let car = w.spawn_vehicle(spec(&scenario.model)?, [0.0, 1.0, 0.0], 0.0);
    for _ in 0..60 {
        w.step();
    }
    if scenario.start_speed != 0.0 {
        w.set_vehicle_velocity(car, [0.0, 0.0, scenario.start_speed]);
    }
    let every = scenario.sample_every.max(1) as usize;
    let (mut trace, mut all, mut t) = (Vec::new(), Vec::new(), 0.0);
    for step in &scenario.script {
        w.set_drive(
            car,
            Drive {
                throttle: step.throttle,
                steer: step.steer,
                brake: step.brake,
            },
        );
        for _ in 0..(step.seconds / TICK).round() as u32 {
            w.step();
            t += TICK;
            let s = sample(&w, t);
            if all.len() % every == 0 {
                trace.push(s);
            }
            all.push(s);
        }
    }
    let first = all.first().ok_or("the script has no steps")?;
    let last = all.last().unwrap();
    let max = |f: fn(&Sample) -> f32| all.iter().map(f).fold(0.0, f32::max);
    let moved = all.iter().position(|s| s.speed > 1.0);
    let stopped_after = moved.and_then(|m| {
        all[m..]
            .iter()
            .rposition(|s| s.speed >= 0.3)
            .filter(|&i| m + i + 1 < all.len())
            .map(|i| all[m + i + 1].t - first.t)
    });
    Ok(Report {
        metrics: Metrics {
            top_speed: max(|s| s.speed),
            final_speed: last.speed,
            max_pitch: max(|s| s.pitch.abs()),
            max_roll: max(|s| s.roll.abs()),
            max_hop: max(|s| s.vy.abs()),
            max_height: all.iter().map(|s| s.y).fold(f32::MIN, f32::max),
            max_lateral: max(|s| s.lateral.abs()),
            mean_yaw_rate: (last.yaw - first.yaw).abs() / (last.t - first.t).max(TICK),
            distance: all
                .windows(2)
                .map(|p| (p[1].x - p[0].x).hypot(p[1].z - p[0].z))
                .sum(),
            stopped_after,
            final_vy: last.vy,
            pitch_wobble: wobble(&all, |s| s.pitch),
            roll_wobble: wobble(&all, |s| s.roll),
        },
        trace,
    })
}

/// Named scenarios: (name, what it shows, JSON). Also the examples for writing your own.
pub const PRESETS: &[(&str, &str, &str)] = &[
    (
        "idle",
        "Parked on flat ground for 4 s: still, level, no phantom velocity.",
        r#"{"script":[{"seconds":4}]}"#,
    ),
    (
        "flat-out",
        "Full throttle for 30 s: should level off at the catalogue top speed (sedan 42 m/s).",
        r#"{"script":[{"seconds":30,"throttle":1}]}"#,
    ),
    (
        "brake-from-20",
        "20 m/s then full brake: stops within about 3 s without nose-diving or hopping.",
        r#"{"start_speed":20,"script":[{"seconds":5,"brake":true}]}"#,
    ),
    (
        "corner-15",
        "15 m/s, then full left lock at light throttle: should turn tightly without leaning or sliding.",
        r#"{"start_speed":15,"script":[{"seconds":3,"throttle":0.3,"steer":1}]}"#,
    ),
    (
        "full-lock-at-speed",
        "Near top speed with full lock: must not roll over or leave the ground.",
        r#"{"start_speed":38,"script":[{"seconds":4,"throttle":1,"steer":1}]}"#,
    ),
    (
        "park-on-slope",
        "Parked on a 15 degree incline for 6 s: the parking brake should hold it.",
        r#"{"ground":{"kind":"slope","degrees":15},"script":[{"seconds":6}]}"#,
    ),
    (
        "climb-slope",
        "Full throttle up a 15 degree incline for 8 s.",
        r#"{"ground":{"kind":"slope","degrees":15},"script":[{"seconds":8,"throttle":1}]}"#,
    ),
    (
        "ram-wall-20",
        "Coasting at 20 m/s into a wall 30 m ahead, braking after: stops without launching or flipping.",
        r#"{"ground":{"kind":"wall","distance":30},"start_speed":20,"script":[{"seconds":2},{"seconds":4,"brake":true}]}"#,
    ),
    (
        "ram-parked-car",
        "Flat out into a car-sized block half a metre off the line, braking after: the hit must not roll the car over.",
        r#"{"ground":{"kind":"obstacle","distance":60,"offset":0.5},"script":[{"seconds":6,"throttle":1},{"seconds":4,"brake":true}]}"#,
    ),
    (
        "curb-at-10",
        "10 m/s over a 15 cm curb: a bump, not a launch.",
        r#"{"ground":{"kind":"curb","distance":20,"height":0.15},"start_speed":10,"script":[{"seconds":4,"throttle":0.3}]}"#,
    ),
    (
        "rumble-strips",
        "12 m/s over eight 6 cm ridges: shaking, but the car stays on the ground.",
        r#"{"ground":{"kind":"bumps","start":15,"height":0.06,"spacing":3,"count":8},"start_speed":12,"script":[{"seconds":4,"throttle":0.3}]}"#,
    ),
];

pub fn preset(name: &str) -> Option<Scenario> {
    PRESETS
        .iter()
        .find(|p| p.0 == name)
        .map(|p| serde_json::from_str(p.2).expect("preset JSON"))
}

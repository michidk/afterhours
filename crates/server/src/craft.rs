//! Aircraft and watercraft. Like the Node server they are kinematic: each tick the pilot's
//! controls are integrated here (no Rapier body), and seated players follow the craft.
//! Models are ported from `shared/physics/{helicopter,plane,watercraft,abandoned-aircraft}.ts`
//! with tuning from `shared/catalog.ts`.
use crate::city::{City, Spot, WATER_LEVEL};
use crate::vehicles::roadside;
use afterhours_protocol::{Controls, Entity, Flight, Kind};
use serde_json::Value;
use std::collections::HashMap;

/// Craft entity ids sit above cars (1 << 24), AI cars (2 << 24) and pedestrians (3 << 24).
const CRAFT_ID_BASE: u32 = 4 << 24;
const ENTER_RANGE: f32 = 6.0;
/// `TUNING.helicopterBoardingSeconds`.
const BOARDING_SECONDS: f32 = 1.0;
/// Rotor lift works against this (`helicopter.ts`).
const LIFT_GRAVITY: f32 = 18.0;
const SUBSTEPS: u32 = 4;
const WORLD_LIMIT: f32 = 1792.0;
/// Parachute sink rate and approach rate (`movement.ts`).
pub const PARACHUTE_FALL: f32 = 4.0;

struct Heli {
    yaw: f32,
    turn: f32,
    tilt: f32,
    tilt_rate: f32,
    bank: f32,
    vertical: f32,
    climb: f32,
    descend: f32,
    ceiling: f32,
}
struct Plane {
    thrust: f32,
    stall: f32,
    drag: f32,
    braking: f32,
    turn: f32,
    taxi_turn: f32,
    climb: f32,
    descend: f32,
    vertical: f32,
    ceiling: f32,
}
struct Boat {
    acceleration: f32,
    reverse: f32,
    drag: f32,
    lateral: f32,
    turn: f32,
    braking: f32,
}
enum Tune {
    Heli(Heli),
    Plane(Plane),
    Boat(Boat),
}
struct Spec {
    name: &'static str,
    kind: Kind,
    seats: usize,
    health: f32,
    speed: f32,
    width: f32,
    color: &'static str,
    tune: Tune,
}

const fn boat(a: f32, r: f32, d: f32, l: f32, t: f32, b: f32) -> Tune {
    Tune::Boat(Boat {
        acceleration: a,
        reverse: r,
        drag: d,
        lateral: l,
        turn: t,
        braking: b,
    })
}

/// `shared/catalog.ts` VEHICLES, aircraft and watercraft.
static SPECS: [Spec; 10] = [
    Spec {
        name: "scout",
        kind: Kind::Helicopter,
        seats: 2,
        health: 120.0,
        speed: 15.0,
        width: 3.0,
        color: "#80a177",
        tune: Tune::Heli(Heli {
            yaw: 4.0,
            turn: 1.6,
            tilt: 0.32,
            tilt_rate: 3.0,
            bank: 0.45,
            vertical: 5.0,
            climb: 9.0,
            descend: 5.0,
            ceiling: 100.0,
        }),
    },
    Spec {
        name: "utility",
        kind: Kind::Helicopter,
        seats: 6,
        health: 200.0,
        speed: 11.0,
        width: 3.6,
        color: "#e8b63f",
        tune: Tune::Heli(Heli {
            yaw: 2.6,
            turn: 1.05,
            tilt: 0.24,
            tilt_rate: 2.2,
            bank: 0.35,
            vertical: 3.2,
            climb: 6.0,
            descend: 4.0,
            ceiling: 85.0,
        }),
    },
    Spec {
        name: "plane",
        kind: Kind::Plane,
        seats: 4,
        health: 130.0,
        speed: 40.0,
        width: 9.6,
        color: "#e0b87b",
        tune: Tune::Plane(Plane {
            thrust: 17.0,
            stall: 19.0,
            drag: 0.35,
            braking: 3.0,
            turn: 0.7,
            taxi_turn: 1.0,
            climb: 6.0,
            descend: 5.0,
            vertical: 2.0,
            ceiling: 80.0,
        }),
    },
    Spec {
        name: "aerobatic",
        kind: Kind::Plane,
        seats: 2,
        health: 95.0,
        speed: 52.0,
        width: 7.2,
        color: "#e86551",
        tune: Tune::Plane(Plane {
            thrust: 23.0,
            stall: 16.0,
            drag: 0.32,
            braking: 3.8,
            turn: 1.1,
            taxi_turn: 1.3,
            climb: 8.0,
            descend: 7.0,
            vertical: 2.6,
            ceiling: 100.0,
        }),
    },
    Spec {
        name: "boat",
        kind: Kind::Boat,
        seats: 4,
        health: 140.0,
        speed: 15.0,
        width: 2.5,
        color: "#55a9b8",
        tune: boat(4.0, 2.0, 0.25, 2.5, 0.8, 1.5),
    },
    Spec {
        name: "launch",
        kind: Kind::Boat,
        seats: 6,
        health: 200.0,
        speed: 12.0,
        width: 3.2,
        color: "#ece4ce",
        tune: boat(2.8, 1.5, 0.24, 2.0, 0.55, 1.2),
    },
    Spec {
        name: "jetski",
        kind: Kind::Jetski,
        seats: 2,
        health: 80.0,
        speed: 27.0,
        width: 1.2,
        color: "#e8b63f",
        tune: boat(10.0, 3.0, 0.3, 4.0, 1.8, 2.2),
    },
    Spec {
        name: "racer",
        kind: Kind::Jetski,
        seats: 1,
        health: 65.0,
        speed: 34.0,
        width: 1.0,
        color: "#e86551",
        tune: boat(13.0, 3.5, 0.32, 5.0, 2.3, 2.8),
    },
    Spec {
        name: "speedboat",
        kind: Kind::Speedboat,
        seats: 4,
        health: 140.0,
        speed: 36.0,
        width: 2.6,
        color: "#e0b87b",
        tune: boat(9.0, 2.5, 0.24, 2.6, 0.9, 1.7),
    },
    Spec {
        name: "offshore",
        kind: Kind::Speedboat,
        seats: 2,
        health: 170.0,
        speed: 44.0,
        width: 2.8,
        color: "#80a177",
        tune: boat(11.0, 2.0, 0.23, 2.1, 0.7, 1.4),
    },
];

fn spec(name: &str) -> &'static Spec {
    SPECS.iter().find(|s| s.name == name).expect("known craft")
}

fn wrap(a: f32) -> f32 {
    a.sin().atan2(a.cos())
}

struct Craft {
    entity: u32,
    spec: &'static Spec,
    x: f32,
    y: f32,
    z: f32,
    angle: f32,
    vx: f32,
    vy: f32,
    vz: f32,
    pitch: f32,
    roll: f32,
    spin: f32,
    seats: Vec<Option<u32>>,
    flight: Flight,
    delay: Option<f32>,
    drive: Controls,
}

/// Where a player ended up after leaving a craft.
pub struct Exit {
    pub position: [f32; 3],
    /// Left a craft in the air: open a parachute.
    pub parachute: bool,
}

#[derive(Default)]
pub struct Fleet {
    craft: Vec<Craft>,
    /// Player id -> (index into `craft`, seat).
    riders: HashMap<u32, (usize, usize)>,
    /// Players descending on a parachute.
    chutes: std::collections::BTreeSet<u32>,
}

impl Fleet {
    fn add(&mut self, model: &str, x: f32, y: f32, z: f32, angle: f32) {
        let spec = spec(model);
        self.craft.push(Craft {
            entity: CRAFT_ID_BASE + self.craft.len() as u32,
            spec,
            x,
            y,
            z,
            angle,
            vx: 0.0,
            vy: 0.0,
            vz: 0.0,
            pitch: 0.0,
            roll: 0.0,
            spin: 0.0,
            seats: vec![None; spec.seats],
            flight: Flight::Grounded,
            delay: None,
            drive: Controls::default(),
        });
    }

    /// `simulation.ts` constructor: two helicopters near downtown, a plane and an
    /// aerobatic plane at every airport, and the moored boats.
    /// `ground` is the still surface (terrain or sea) at a point.
    pub fn park(&mut self, city: &City, ground: &dyn Fn(f32, f32) -> f32) {
        self.craft.clear();
        self.riders.clear();
        let mut taken = Vec::new();
        for (dx, dz, model) in [(0.0, 36.0, "scout"), (-64.0, 30.0, "utility")] {
            let s = roadside(city, city.centre.x + dx, city.centre.z + dz, &taken);
            taken.push(s);
            self.add(
                model,
                s.0 as f32,
                ground(s.0 as f32, s.1 as f32),
                s.1 as f32,
                0.0,
            );
        }
        let fields: Vec<Value> = match &city.airports {
            Value::Array(a) if !a.is_empty() => a.clone(),
            _ => vec![city.airport.clone()],
        };
        for a in fields {
            let (x, z, d) = (a["x"].as_f64(), a["z"].as_f64(), a["d"].as_f64());
            let (Some(x), Some(z), Some(d)) = (x, z, d) else {
                continue;
            };
            let z = (z - d / 2.0 + 14.0) as f32;
            self.add("plane", x as f32, ground(x as f32, z), z, 0.0);
            self.add(
                "aerobatic",
                x as f32 - 22.0,
                ground(x as f32 - 22.0, z),
                z,
                0.0,
            );
        }
        const BOATS: [&str; 6] = ["boat", "launch", "jetski", "racer", "speedboat", "offshore"];
        let berths: Vec<Spot> = city
            .harbours
            .iter()
            .flat_map(|h| h.berths.clone())
            .collect();
        if berths.is_empty() {
            for (i, m) in BOATS.iter().enumerate() {
                self.add(m, -1543.0, WATER_LEVEL, -48.0 + 16.0 * i as f32, 0.0);
            }
        }
        for (i, b) in berths.iter().enumerate() {
            self.add(
                BOATS[i % BOATS.len()],
                b.x as f32,
                WATER_LEVEL,
                b.z as f32,
                b.angle as f32,
            );
        }
    }

    /// Parked or flying craft as (model, x, z); lets scenes find ones outside a client's view.
    pub fn spots(&self) -> Vec<(&'static str, f32, f32)> {
        self.craft.iter().map(|c| (c.spec.name, c.x, c.z)).collect()
    }

    pub fn open_parachute(&mut self, player: u32) {
        self.chutes.insert(player);
    }

    pub fn close_parachute(&mut self, player: u32) {
        self.chutes.remove(&player);
    }

    pub fn chutes(&self) -> Vec<u32> {
        self.chutes.iter().copied().collect()
    }

    pub fn is_rider(&self, player: u32) -> bool {
        self.riders.contains_key(&player)
    }

    /// Seats `player` (standing at `at`) in the nearest craft with a free seat, driver first.
    pub fn enter(&mut self, player: u32, at: [f32; 3]) -> bool {
        let Some((i, _)) = self
            .craft
            .iter()
            .enumerate()
            .filter(|(_, c)| c.seats.contains(&None) && (c.y - at[1]).abs() < 6.0)
            .map(|(i, c)| (i, (c.x - at[0]).hypot(c.z - at[2])))
            .filter(|&(_, d)| d < ENTER_RANGE)
            .min_by(|a, b| a.1.total_cmp(&b.1))
        else {
            return false;
        };
        let c = &mut self.craft[i];
        let seat = c.seats.iter().position(Option::is_none).unwrap();
        c.seats[seat] = Some(player);
        if seat == 0 {
            c.drive = Controls::default();
            if c.spec.kind == Kind::Helicopter {
                c.flight = Flight::TakingOff;
                c.delay = Some(BOARDING_SECONDS);
            }
        } else if c.spec.kind == Kind::Helicopter && c.delay.is_some() {
            c.delay = c.delay.map(|d| d.max(0.5));
        }
        self.riders.insert(player, (i, seat));
        true
    }

    /// The driver's controls for this tick; passengers' controls do nothing.
    pub fn control(&mut self, player: u32, controls: &Controls) {
        if let Some(&(i, 0)) = self.riders.get(&player) {
            self.craft[i].drive = controls.clone();
        }
    }

    /// Frees the seat. An unpiloted aircraft in the air starts to fall.
    pub fn leave(&mut self, player: u32, ground: &dyn Fn(f32, f32) -> f32) -> Option<Exit> {
        let (i, seat) = self.riders.remove(&player)?;
        let c = &mut self.craft[i];
        c.seats[seat] = None;
        let aircraft = matches!(c.spec.kind, Kind::Helicopter | Kind::Plane);
        let airborne = aircraft && c.y > ground(c.x, c.z) + 0.2;
        if seat == 0 {
            c.delay = None;
            c.drive = Controls::default();
            if airborne {
                c.flight = Flight::Falling;
            } else if c.spec.kind == Kind::Helicopter {
                c.flight = Flight::Grounded;
            }
        }
        // shortcut: the first side spot, unchecked for walls or bystanders; upgrade with a
        // shape query like vehicles::leave.
        let distance = 3.0f32.max(c.spec.width + 0.9);
        let (x, z) = (
            c.x + c.angle.cos() * distance,
            c.z - c.angle.sin() * distance,
        );
        let y = if airborne { c.y } else { ground(x, z) + 1.0 };
        Some(Exit {
            position: [x, y, z],
            parachute: airborne,
        })
    }

    /// Players seated now, with where their characters should be this tick.
    pub fn rider_positions(&self) -> Vec<(u32, [f32; 3])> {
        self.riders
            .iter()
            .map(|(p, &(i, _))| {
                (
                    *p,
                    [self.craft[i].x, self.craft[i].y + 1.0, self.craft[i].z],
                )
            })
            .collect()
    }

    pub fn decorate(&self, player: u32, e: &mut Entity) {
        let Some(&(i, seat)) = self.riders.get(&player) else {
            return;
        };
        let c = &self.craft[i];
        e.vehicle = Some(c.entity.to_string());
        e.seat = Some(seat as u8);
        (e.angle, e.vx, e.vy, e.vz) = (c.angle, c.vx, c.vy, c.vz);
    }

    /// Marks a descending player.
    pub fn decorate_chute(&self, player: u32, e: &mut Entity) {
        if self.chutes.contains(&player) {
            e.parachute = Some(true);
        }
    }

    pub fn entities(&self, out: &mut HashMap<u32, Entity>) {
        for c in &self.craft {
            let aircraft = matches!(c.spec.kind, Kind::Helicopter | Kind::Plane);
            out.insert(
                c.entity,
                Entity {
                    id: c.entity.to_string(),
                    kind: c.spec.kind,
                    x: c.x,
                    y: c.y,
                    z: c.z,
                    angle: c.angle,
                    pitch: c.pitch,
                    roll: c.roll,
                    vx: c.vx,
                    vy: c.vy,
                    vz: c.vz,
                    color: c.spec.color.into(),
                    health: c.spec.health,
                    max_health: Some(c.spec.health),
                    model: Some(c.spec.name.into()),
                    seats: Some(c.seats.iter().map(|s| s.map(|id| id.to_string())).collect()),
                    driver: c.seats[0].map(|id| id.to_string()),
                    flight: aircraft.then_some(c.flight),
                    takeoff_delay: c.delay,
                    angular_velocity: Some(c.spin),
                    ..Default::default()
                },
            );
        }
    }

    /// Advances every craft by `dt` in the original's four substeps per tick (its flight
    /// models integrate with Euler steps, so the step size shows). `ground` is the still
    /// surface; `terrain` the bed.
    pub fn step(
        &mut self,
        dt: f32,
        ground: &dyn Fn(f32, f32) -> f32,
        terrain: &dyn Fn(f32, f32) -> f32,
    ) {
        for _ in 0..SUBSTEPS {
            self.substep(dt / SUBSTEPS as f32, ground, terrain);
        }
    }

    fn substep(
        &mut self,
        dt: f32,
        ground: &dyn Fn(f32, f32) -> f32,
        terrain: &dyn Fn(f32, f32) -> f32,
    ) {
        for c in &mut self.craft {
            let floor = ground(c.x, c.z);
            let piloted = c.seats[0].is_some();
            match &c.spec.tune {
                Tune::Heli(h) => {
                    if !piloted && (c.y > floor + 0.2 || c.flight == Flight::Falling) {
                        fall(c, floor, dt);
                    } else {
                        fly_heli(c, h, floor, piloted, dt);
                    }
                }
                Tune::Plane(p) => {
                    if !piloted && (c.y > floor + 0.2 || c.flight == Flight::Falling) {
                        fall(c, floor, dt);
                    } else {
                        fly_plane(c, p, floor, piloted, dt);
                        c.flight = if c.y > floor + 0.2 {
                            Flight::Cruising
                        } else {
                            Flight::Grounded
                        };
                    }
                }
                Tune::Boat(b) => float(c, b, piloted, terrain, ground, dt),
            }
            // The catalogue speed is a hard ceiling for every vehicle, as in the original.
            let speed = c.vx.hypot(c.vz);
            if speed > c.spec.speed {
                c.vx *= c.spec.speed / speed;
                c.vz *= c.spec.speed / speed;
            }
            c.x = (c.x + c.vx * dt).clamp(-WORLD_LIMIT + 1.0, WORLD_LIMIT - 1.0);
            c.z = (c.z + c.vz * dt).clamp(-WORLD_LIMIT + 1.0, WORLD_LIMIT - 1.0);
            c.angle = wrap(c.angle + c.spin * dt);
        }
    }
}

/// `abandoned-aircraft.ts` fallAircraft; shortcut: only the ground stops it, not roofs.
fn fall(c: &mut Craft, floor: f32, dt: f32) {
    c.flight = Flight::Falling;
    c.vx *= (-0.05 * dt).exp();
    c.vz *= (-0.05 * dt).exp();
    c.spin *= (-2.0 * dt).exp();
    c.vy -= 9.81 * dt;
    c.y = floor.max(c.y + c.vy * dt);
    if c.y <= floor {
        c.vy = 0.0;
        c.flight = Flight::Grounded;
    }
}

/// `helicopter.ts` flyHelicopter, piloted flight. shortcut: no roofs, bystanders or auto
/// landing; upgrade when the static city is queryable from this module.
fn fly_heli(c: &mut Craft, h: &Heli, floor: f32, piloted: bool, dt: f32) {
    let input = c.drive.clone();
    if c.flight == Flight::TakingOff
        && let Some(d) = c.delay.as_mut()
    {
        *d -= dt;
        if *d <= 0.0 || input.up || input.down || input.left || input.right || input.ascend {
            c.delay = None;
        }
    }
    if !piloted || c.flight == Flight::Grounded || c.delay.is_some_and(|d| d > 0.0) {
        let k = (-6.0 * dt).exp();
        c.vx *= k;
        c.vz *= k;
        c.spin = if (c.spin * k).abs() < 0.001 {
            0.0
        } else {
            c.spin * k
        };
        for a in [&mut c.pitch, &mut c.roll] {
            *a = if a.abs() < 0.001 { 0.0 } else { *a * k };
        }
        c.vy = 0.0;
        return;
    }
    let ceiling = floor + h.ceiling;
    let mut want = f32::from(input.ascend) * h.climb - f32::from(input.descend) * h.descend;
    if c.y >= ceiling {
        want = want.min(0.0);
    }
    c.vy += (want - c.vy) * (1.0 - (-h.vertical * dt).exp());
    c.y = floor.max(c.y + c.vy * dt);
    if c.flight == Flight::TakingOff && c.y >= floor + 9.0 {
        c.flight = Flight::Cruising;
    }
    // Attitude: W/S tilt the rotor disc, A/D yaw; tilted lift and drag set the speed.
    let (s, co) = c.angle.sin_cos();
    let forward = c.vx * s + c.vz * co;
    let right = c.vx * co - c.vz * s;
    let stick = input.y().clamp(-1.0, 1.0);
    let pedal = input.x().clamp(-1.0, 1.0);
    let turn = h
        .turn
        .min(LIFT_GRAVITY * h.bank.tan() / forward.abs().max(1.0));
    c.spin += (pedal * turn - c.spin) * (1.0 - (-h.yaw * dt).exp());
    let drift = |v: f32| (v / 4.0).clamp(-1.0, 1.0);
    let pitch_target = if stick != 0.0 {
        stick * h.tilt
    } else {
        -drift(forward) * h.tilt * 0.6
    };
    let bank_target = ((forward * c.spin).atan2(LIFT_GRAVITY) - drift(right) * h.bank * 0.6)
        .clamp(-h.bank, h.bank);
    let ease = 1.0 - (-h.tilt_rate * dt).exp();
    c.pitch += (pitch_target - c.pitch) * ease;
    c.roll += (bank_target - c.roll) * ease;
    let drag = LIFT_GRAVITY * h.tilt.tan() / c.spec.speed;
    let ahead = forward + (LIFT_GRAVITY * c.pitch.tan() - drag * forward) * dt;
    let side = right + (LIFT_GRAVITY * c.roll.tan() - drag * 2.0 * right) * dt;
    c.vx = s * ahead + co * side;
    c.vz = co * ahead - s * side;
}

/// `plane.ts` flyPlane: lift needs airspeed, climbs trade speed, dives earn it back.
fn fly_plane(c: &mut Craft, p: &Plane, floor: f32, piloted: bool, dt: f32) {
    let input = if piloted {
        c.drive.clone()
    } else {
        Controls::default()
    };
    let ceiling = floor + p.ceiling;
    let airborne = c.y > floor + 0.2;
    let (sx, sz) = c.angle.sin_cos();
    let mut speed = (c.vx * sx + c.vz * sz).max(0.0);
    let throttle = if piloted { input.y() } else { 0.0 };
    c.spin = if piloted { input.x() } else { 0.0 }
        * (speed / 8.0).min(1.0)
        * if airborne { p.turn } else { p.taxi_turn };
    speed += throttle.max(0.0) * p.thrust * dt;
    speed -= c.vy * 0.4 * dt;
    speed = (speed * (-(if throttle < 0.0 { p.braking } else { p.drag }) * dt).exp()).max(0.0);
    c.vx = sx * speed;
    c.vz = sz * speed;
    let pitch = f32::from(input.ascend) - f32::from(input.descend);
    let vertical = if speed < p.stall {
        -8.0
    } else if pitch > 0.0 {
        p.climb
    } else if pitch < 0.0 {
        -p.descend
    } else {
        0.0
    };
    c.vy += (vertical - c.vy) * (1.0 - (-p.vertical * dt).exp());
    c.y = (c.y + c.vy * dt).clamp(floor, ceiling);
    if c.y == floor || c.y == ceiling {
        c.vy = 0.0;
    }
}

/// `watercraft.ts` watercraftForces. shortcut: calm sea at WATER_LEVEL and no lakes or
/// swell; upgrade with the water module.
fn float(
    c: &mut Craft,
    b: &Boat,
    piloted: bool,
    terrain: &dyn Fn(f32, f32) -> f32,
    ground: &dyn Fn(f32, f32) -> f32,
    dt: f32,
) {
    if terrain(c.x, c.z) >= WATER_LEVEL {
        // A beached hull slides on its keel: only friction and slope (BEACHED).
        let (dx, dz) = (
            ground(c.x + 0.5, c.z) - ground(c.x - 0.5, c.z),
            ground(c.x, c.z + 0.5) - ground(c.x, c.z - 0.5),
        );
        let g = 18.0 * dt / (1.0 + dx * dx + dz * dz);
        c.vx -= g * dx;
        c.vz -= g * dz;
        let speed = c.vx.hypot(c.vz);
        let k = if speed > 0.0 {
            (speed - 5.0 * dt).max(0.0) / speed
        } else {
            0.0
        };
        c.vx *= k;
        c.vz *= k;
        c.spin *= (-4.0 * dt).exp();
        c.y = ground(c.x, c.z);
        c.vy = 0.0;
        return;
    }
    let drive = if piloted {
        c.drive.clone()
    } else {
        Controls::default()
    };
    let (throttle, steer) = (drive.y().clamp(-1.0, 1.0), drive.x().clamp(-1.0, 1.0));
    let (sx, sz) = c.angle.sin_cos();
    let mut forward = c.vx * sx + c.vz * sz;
    let mut lateral = c.vx * sz - c.vz * sx;
    forward += throttle
        * if throttle < 0.0 {
            b.reverse
        } else {
            b.acceleration
        }
        * dt;
    forward *= (-(b.drag + if drive.brake { b.braking } else { 0.0 }) * dt).exp();
    forward = forward.clamp(-c.spec.speed * 0.25, c.spec.speed);
    let slip = 0.6 * steer.abs() * (2.0 * forward / c.spec.speed).clamp(0.0, 1.0);
    lateral *= (-b.lateral * (1.0 - slip) * dt).exp();
    c.vx = sx * forward + sz * lateral;
    c.vz = sz * forward - sx * lateral;
    let target = steer * b.turn * (forward / 4.0).clamp(-1.0, 1.0);
    c.spin += (target - c.spin) * (1.0 - (-4.0 * dt).exp());
    c.y = WATER_LEVEL;
    c.vy = 0.0;
}

/// One sample of [`fly`]: the same fields the handling lab traces.
#[derive(serde::Serialize)]
pub struct Flown {
    pub t: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub speed: f32,
    pub forward: f32,
    pub lateral: f32,
    pub vy: f32,
}

/// Lab: flies one piloted craft over a flat floor at `height` (boats float on a calm sea) for
/// a script of `(seconds, controls)`, stepping at the server tick, and returns every tick.
/// `shortcut`: the bare craft physics only; boarding, roofs and the city are the scene lab's.
pub fn fly(
    model: &str,
    height: f32,
    speed: f32,
    script: &[(f32, Controls)],
) -> Result<Vec<Flown>, String> {
    if !SPECS.iter().any(|s| s.name == model) {
        return Err(format!("unknown craft {model:?}"));
    }
    let mut fleet = Fleet::default();
    let boat = matches!(spec(model).tune, Tune::Boat(_));
    fleet.add(
        model,
        0.0,
        if boat { WATER_LEVEL } else { height },
        0.0,
        0.0,
    );
    let craft = &mut fleet.craft[0];
    craft.seats[0] = Some(1);
    craft.vz = speed;
    craft.flight = if height > 0.2 {
        Flight::Cruising
    } else {
        Flight::Grounded
    };
    let dt = 1.0 / crate::TICK_RATE as f32;
    let (floor, bed) = if boat {
        (WATER_LEVEL, -50.0)
    } else {
        (0.0, 0.0)
    };
    let (mut out, mut t) = (Vec::new(), 0.0);
    for (seconds, controls) in script {
        fleet.craft[0].drive = controls.clone();
        for _ in 0..(seconds / dt).round() as u32 {
            fleet.step(dt, &|_, _| floor, &|_, _| bed);
            t += dt;
            let c = &fleet.craft[0];
            let (sn, cs) = c.angle.sin_cos();
            out.push(Flown {
                t,
                x: c.x,
                y: c.y,
                z: c.z,
                yaw: c.angle,
                speed: c.vx.hypot(c.vz),
                forward: c.vx * sn + c.vz * cs,
                lateral: c.vx * cs - c.vz * sn,
                vy: c.vy,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(_: f32, _: f32) -> f32 {
        0.0
    }

    fn fleet_with(model: &str, y: f32) -> Fleet {
        let mut f = Fleet::default();
        f.add(model, 0.0, y, 0.0, 0.0);
        f
    }

    /// `tests/aircraft-handling.test.ts`: a boarded helicopter waits out the boarding delay,
    /// then climbs under `ascend`, and an unpiloted one settles back on the ground.
    #[test]
    fn a_helicopter_climbs_when_piloted_and_falls_when_abandoned() {
        let mut f = fleet_with("scout", 0.0);
        assert!(f.enter(1, [1.0, 0.0, 1.0]));
        f.control(
            1,
            &Controls {
                ascend: true,
                ..Default::default()
            },
        );
        for _ in 0..60 {
            f.step(1.0 / 30.0, &flat, &flat);
        }
        let high = f.craft[0].y;
        assert!(high > 3.0, "climbed {high}");
        let exit = f.leave(1, &flat).unwrap();
        assert!(exit.parachute);
        for _ in 0..300 {
            f.step(1.0 / 30.0, &flat, &flat);
        }
        assert_eq!(f.craft[0].y, 0.0);
        assert_eq!(f.craft[0].flight, Flight::Grounded);
    }

    #[test]
    fn a_plane_needs_airspeed_to_leave_the_runway() {
        let mut f = fleet_with("plane", 0.0);
        assert!(f.enter(1, [0.0, 0.0, 0.0]));
        f.control(
            1,
            &Controls {
                up: true,
                ascend: true,
                ..Default::default()
            },
        );
        for _ in 0..30 {
            f.step(1.0 / 30.0, &flat, &flat);
        }
        assert_eq!(f.craft[0].y, 0.0, "below stall speed it stays down");
        for _ in 0..240 {
            f.step(1.0 / 30.0, &flat, &flat);
        }
        assert!(f.craft[0].y > 5.0, "airborne at {}", f.craft[0].y);
    }

    #[test]
    fn a_boat_accelerates_on_water_and_beaches_on_land() {
        let sea = |_: f32, _: f32| -5.0;
        let ground = |_: f32, _: f32| WATER_LEVEL;
        let mut f = fleet_with("speedboat", WATER_LEVEL);
        assert!(f.enter(1, [0.0, WATER_LEVEL, 0.0]));
        f.control(
            1,
            &Controls {
                up: true,
                ..Default::default()
            },
        );
        for _ in 0..90 {
            f.step(1.0 / 30.0, &ground, &sea);
        }
        assert!(f.craft[0].vz > 8.0, "speed {}", f.craft[0].vz);
        let land = |_: f32, _: f32| 3.0;
        for _ in 0..300 {
            f.step(1.0 / 30.0, &land, &land);
        }
        assert!(f.craft[0].vz.abs() < 0.1, "beached hull stops");
    }

    fn throttle(seconds: f32) -> Vec<(f32, Controls)> {
        vec![(
            seconds,
            Controls {
                move_y: Some(1.0),
                ..Default::default()
            },
        )]
    }

    /// Numbers measured on the original game (`scripts/compare-handling.ts`).
    #[test]
    fn craft_fly_like_the_original() {
        let top = |t: &[Flown]| t.iter().map(|s| s.speed).fold(0.0, f32::max);
        // Planes level off at the catalogue speed instead of accelerating past it.
        let plane = fly("plane", 0.0, 0.0, &throttle(15.0)).unwrap();
        assert!((top(&plane) - 40.0).abs() < 0.1, "{}", top(&plane));
        let aero = fly("aerobatic", 0.0, 0.0, &throttle(15.0)).unwrap();
        assert!((top(&aero) - 52.0).abs() < 0.1, "{}", top(&aero));
        // A helicopter and a skiff top out at their catalogue speeds too.
        let heli = fly("scout", 40.0, 0.0, &throttle(15.0)).unwrap();
        assert!((top(&heli) - 15.0).abs() < 0.2, "{}", top(&heli));
        let skiff = fly("boat", 0.0, 0.0, &throttle(15.0)).unwrap();
        assert!((top(&skiff) - 15.0).abs() < 0.2, "{}", top(&skiff));
        // The skiff swings at about 0.76 rad/s at full lock and sheds speed doing it.
        let mut turn = throttle(4.0);
        turn[0].1.move_x = Some(1.0);
        let t = fly("boat", 0.0, 8.0, &turn).unwrap();
        let yaw = (t.last().unwrap().yaw - t[0].yaw).abs() / 4.0;
        assert!((yaw - 0.76).abs() < 0.1, "yaw rate {yaw}");
        assert!(t.last().unwrap().speed < 7.0);
    }
}

//! Cars and their seats: the parked fleet, boarding, driving rights, the horn and the
//! per-car wire fields. Ported from `server/simulation.ts`, `shared/catalog.ts`,
//! `shared/seats.ts` and `shared/physics/vehicle.ts`.
use crate::city::{City, Spot};
use crate::game::{euler, rows};
use afterhours_physics::{Drive, VEHICLE_STRIDE, VehicleSpec, World, vehicle_contact_y};
use afterhours_protocol::{Entity, Kind, WorldEvent};
use std::collections::{BTreeMap, HashMap};

/// Car entity ids live above every session id.
pub const CAR_ID_BASE: u32 = 1 << 24;
/// `shared/catalog.ts` TUNING.interestRadius: how far world events carry.
pub const INTEREST_RADIUS: f32 = 220.0;
/// `server/simulation.ts` interact(): boarding reach in metres.
const ENTER_RANGE: f32 = 6.0;
/// `shared/physics/vehicle.ts` CAR: tan 15° starts a rear skid, tan 10° ends it, and the
/// tyre must slide sideways at 3 m/s (70% of that to keep skidding).
const SKID_ANGLE: f32 = 0.267_949_2;
const SKID_RELEASE: f32 = 0.176_327;
const SKID_SPEED: f32 = 3.0;
/// `FLOOD` in `shared/physics/flooding.ts`.
const FLOOD_DEPTH: f32 = 0.8;
const FLOOD_SECONDS: f32 = 10.0;

/// `shared/catalog.ts` VEHICLES, cars only.
pub struct Model {
    pub name: &'static str,
    pub spec: VehicleSpec,
    pub seats: usize,
    pub health: f32,
    pub color: &'static str,
}

pub const SEDAN: Model = Model {
    name: "sedan",
    spec: VehicleSpec::SEDAN,
    seats: 4,
    health: 100.0,
    color: "#55a9b8",
};
pub const SPORT: Model = Model {
    name: "sport",
    spec: VehicleSpec::SPORT,
    seats: 2,
    health: 85.0,
    color: "#e86551",
};
pub const VAN: Model = Model {
    name: "van",
    spec: VehicleSpec::VAN,
    seats: 2,
    health: 170.0,
    color: "#ece4ce",
};

/// `simulation.ts` starter sites around the centre when there is no town hall car park.
const STREET_SITES: [(f64, f64, &Model); 3] = [
    (4.0, 25.0, &SEDAN),
    (-4.0, 44.0, &SPORT),
    (68.0, 25.0, &VAN),
];

struct Car {
    entity: u32,
    model: &'static Model,
    /// Session ids by seat; slot zero drives.
    seats: Vec<Option<u32>>,
    steer: f32,
    /// Both rear tyres share the body's slip, so one flag covers them.
    skid: bool,
    /// Attack was held last tick: the horn sounds once per press.
    honking: bool,
    /// Seconds left before a swamped car explodes; its engine is dead meanwhile.
    flooded: Option<f32>,
    /// A wrecked car stays where it is (`shortcut`: Node removes it after 180 s).
    wreck: bool,
}

/// Every car in the world, keyed by physics id.
pub struct Vehicles {
    cars: BTreeMap<u32, Car>,
}

/// Yaw, forward speed and sideways speed of a `states()` vehicle row.
fn slip(r: &[f32; VEHICLE_STRIDE]) -> (f32, f32, f32) {
    let (yaw, _, _) = euler([r[4], r[5], r[6], r[7]]);
    let (s, c) = yaw.sin_cos();
    (yaw, r[8] * s + r[10] * c, r[8] * c - r[10] * s)
}

/// `server/simulation.ts` roadside(): nearest street lane point 3.5 m right of the
/// centreline, moved along the lane until clear of every point in `avoid`.
pub(crate) fn roadside(city: &City, x: f64, z: f64, avoid: &[(f64, f64)]) -> (f64, f64) {
    let (mut best, mut along, mut best_distance) = ((x, z), (0.0, 0.0), f64::INFINITY);
    for r in &city.roads {
        let (dx, dz) = (r.bx - r.ax, r.bz - r.az);
        let l2 = (dx * dx + dz * dz).max(f64::MIN_POSITIVE);
        let t = (((x - r.ax) * dx + (z - r.az) * dz) / l2).clamp(0.15, 0.85);
        let (px, pz) = (r.ax + dx * t, r.az + dz * t);
        let d = (px - x).hypot(pz - z);
        if d < best_distance {
            let l = l2.sqrt();
            best_distance = d;
            best = (px + (dz / l) * 3.5, pz - (dx / l) * 3.5);
            along = (dx / l, dz / l);
        }
    }
    for step in 0..12 {
        if !avoid
            .iter()
            .any(|p| (p.0 - best.0).hypot(p.1 - best.1) < 9.0)
        {
            break;
        }
        let sign = if step % 2 == 1 { -1.0 } else { 1.0 };
        let distance = 10.0 * (step / 2 + 1) as f64;
        best = (
            best.0 + along.0 * distance * sign,
            best.1 + along.1 * distance * sign,
        );
    }
    best
}

impl Vehicles {
    /// The no-city fleet: the three street sites at their raw offsets from `spawn`, as
    /// `simulation.ts` does when the city has no centre.
    pub fn new(world: &mut World, spawn: [f32; 3]) -> Self {
        let mut v = Self {
            cars: BTreeMap::new(),
        };
        for (dx, dz, m) in STREET_SITES {
            let at = [spawn[0] + dx as f32, spawn[1], spawn[2] + dz as f32];
            v.spawn(world, m, at, 0.0);
        }
        v
    }

    /// Replaces the fleet with the city's: starter cars in the town hall bays (or on the
    /// streets near the centre), plus a sport car on every racetrack grid slot.
    /// Removes every car, the no-city placeholders included.
    pub fn clear(&mut self, world: &mut World) {
        for id in std::mem::take(&mut self.cars).into_keys() {
            world.remove_vehicle(id);
        }
    }

    pub fn park(&mut self, world: &mut World, city: &City) {
        self.clear(world);
        let at = |x: f64, z: f64| [x as f32, city.height(x as f32, z as f32) + 1.0, z as f32];
        let starters = [&SEDAN, &SPORT, &VAN, &SEDAN, &SPORT, &SEDAN];
        match city.town_hall.as_ref().filter(|h| !h.parking.is_empty()) {
            Some(hall) => {
                for (i, m) in starters.into_iter().enumerate() {
                    let bay = &hall.parking[(i * 5 + 2) % hall.parking.len()];
                    self.spawn(world, m, at(bay.x, bay.z), bay.angle as f32);
                }
            }
            None => {
                let mut taken = Vec::new();
                for (dx, dz, m) in STREET_SITES {
                    let s = roadside(city, city.centre.x + dx, city.centre.z + dz, &taken);
                    taken.push(s);
                    self.spawn(world, m, at(s.0, s.1), 0.0);
                }
            }
        }
        let grid: Vec<Spot> =
            serde_json::from_value(city.racetrack["grid"].clone()).unwrap_or_default();
        for slot in grid {
            self.spawn(world, &SPORT, at(slot.x, slot.z), slot.angle as f32);
        }
    }

    fn spawn(&mut self, world: &mut World, model: &'static Model, at: [f32; 3], yaw: f32) {
        let entity = CAR_ID_BASE + self.cars.len() as u32;
        let id = world.spawn_vehicle(model.spec, at, yaw);
        self.cars.insert(
            id,
            Car {
                entity,
                model,
                seats: vec![None; model.seats],
                steer: 0.0,
                skid: false,
                honking: false,
                flooded: None,
                wreck: false,
            },
        );
    }

    /// `(physics id, entity id)` of every car.
    pub fn pairs(&self) -> Vec<(u32, u32)> {
        self.cars.iter().map(|(id, c)| (*id, c.entity)).collect()
    }

    /// Entity id of the car with physics id `car`.
    pub fn entity_of(&self, car: u32) -> Option<u32> {
        self.cars.get(&car).map(|c| c.entity)
    }

    /// Width and length of a debug-spawnable model's footprint.
    pub fn footprint(&self, model: &str) -> Result<(f32, f32), String> {
        match model {
            "sedan" => Ok((SEDAN.spec.width, SEDAN.spec.length)),
            "sport" => Ok((SPORT.spec.width, SPORT.spec.length)),
            "van" => Ok((VAN.spec.width, VAN.spec.length)),
            _ => Err(format!("Unsupported debug vehicle: {model}")),
        }
    }

    pub fn spawn_debug(
        &mut self,
        world: &mut World,
        model: &str,
        at: [f32; 3],
    ) -> Result<(), String> {
        // Debug cars are placed behind the player; face them back down the lane so
        // the first throttle input drives away from the wall at the default spawn.
        self.spawn_facing(world, model, at, std::f32::consts::PI)
    }

    /// A car of the given model standing at `at`, nose along `yaw`.
    pub fn spawn_facing(
        &mut self,
        world: &mut World,
        model: &str,
        at: [f32; 3],
        yaw: f32,
    ) -> Result<(), String> {
        let model = match model {
            "sedan" => &SEDAN,
            "sport" => &SPORT,
            "van" => &VAN,
            _ => return Err(format!("Unsupported debug vehicle: {model}")),
        };
        self.spawn(world, model, at, yaw);
        Ok(())
    }

    /// Seats `who` (on foot as physics character `body`) in the nearest car within reach
    /// that has a free seat, driver's seat first. Returns the car's physics id.
    pub fn enter(&mut self, world: &World, body: u32, who: u32) -> Option<u32> {
        let s = world.states();
        let (cars, chars) = rows(world, &s);
        let me = chars.iter().find(|r| r[0] as u32 == body)?;
        let (car, _) = cars
            .iter()
            .filter(|r| {
                self.cars
                    .get(&(r[0] as u32))
                    .is_some_and(|c| c.seats.contains(&None))
            })
            .map(|r| (r[0] as u32, (r[1] - me[1]).hypot(r[3] - me[3])))
            .filter(|&(_, d)| d < ENTER_RANGE)
            .min_by(|a, b| a.1.total_cmp(&b.1))?;
        let seats = &mut self.cars.get_mut(&car)?.seats;
        let seat = seats.iter().position(Option::is_none)?;
        seats[seat] = Some(who);
        Some(car)
    }

    /// Frees `who`'s seat and returns where they step out: `simulation.ts` exit(), the
    /// spot beside the car on its right, `max(3, width / 2 + 0.9)` metres from the centre.
    pub fn leave(&mut self, world: &mut World, car: u32, who: u32) -> [f32; 3] {
        let s = world.states();
        let row = rows(world, &s).0.iter().find(|r| r[0] as u32 == car);
        let Some(c) = self.cars.get_mut(&car) else {
            return [0.0, 1.0, 0.0];
        };
        if c.seats.first() == Some(&Some(who)) {
            c.steer = 0.0;
            c.honking = false;
            world.set_drive(car, Drive::default());
        }
        for seat in &mut c.seats {
            if *seat == Some(who) {
                *seat = None;
            }
        }
        let Some(r) = row else {
            return [0.0, 1.0, 0.0];
        };
        let (yaw, _, _) = slip(r);
        let distance = (c.model.spec.width / 2.0 + 0.9).max(3.0);
        // shortcut: the first candidate spot, unchecked for walls or bystanders; upgrade
        // with a shape query once the city's static geometry is queryable.
        [
            r[1] + yaw.cos() * distance,
            r[2],
            r[3] - yaw.sin() * distance,
        ]
    }

    /// Applies `drive` if `who` holds the wheel; passengers' controls do nothing.
    pub fn drive(&mut self, world: &mut World, car: u32, who: u32, drive: Drive) {
        if let Some(c) = self.cars.get_mut(&car)
            && c.seats.first() == Some(&Some(who))
        {
            c.steer = drive.steer.clamp(-1.0, 1.0);
            // No drive reaches the wheels of a swamped or wrecked car.
            world.set_drive(
                car,
                if c.flooded.is_some() || c.wreck {
                    Drive::default()
                } else {
                    drive
                },
            );
        }
    }

    /// The driver's attack press sounds the horn once; `server/traffic.ts` shapes the event.
    pub fn horn(&mut self, world: &World, car: u32, who: u32, attack: bool) -> Option<WorldEvent> {
        let c = self.cars.get_mut(&car)?;
        if c.seats.first() != Some(&Some(who)) {
            return None;
        }
        let press = attack && !c.honking;
        c.honking = attack;
        if !press {
            return None;
        }
        let s = world.states();
        let r = rows(world, &s).0.iter().find(|r| r[0] as u32 == car)?;
        Some(WorldEvent {
            kind: "horn".into(),
            x: r[1],
            y: r[2] + 1.0,
            z: r[3],
            angle: None,
            length: None,
            target: None,
            source: None,
            sound: Some("horn".into()),
        })
    }

    /// The car entity id and seat index `who` rides in.
    pub fn rider(&self, car: u32, who: u32) -> Option<(u32, u8)> {
        let c = self.cars.get(&car)?;
        let seat = c.seats.iter().position(|s| *s == Some(who))?;
        Some((c.entity, seat as u8))
    }

    /// Skid detection after physics: `shared/physics/vehicle.ts` rear-tyre hysteresis on
    /// the body's slip, since the shared physics core does not expose per-wheel slip.
    /// `shared/physics/flooding.ts`: a car in water deeper than FLOOD.depth floods, and
    /// FLOOD.seconds later explodes. `depth` is the water depth above the bed at a point.
    pub fn update(
        &mut self,
        world: &World,
        depth: &dyn Fn(f32, f32) -> f32,
        dt: f32,
    ) -> Vec<WorldEvent> {
        let mut events = Vec::new();
        let s = world.states();
        for r in rows(world, &s).0 {
            let Some(c) = self.cars.get_mut(&(r[0] as u32)) else {
                continue;
            };
            if c.flooded.is_none() && !c.wreck && depth(r[1], r[3]) > FLOOD_DEPTH {
                c.flooded = Some(FLOOD_SECONDS);
            }
            if let Some(t) = c.flooded.as_mut() {
                *t -= dt;
                if *t <= 0.0 {
                    c.flooded = None;
                    c.wreck = true;
                    events.push(WorldEvent {
                        kind: "explosion".into(),
                        x: r[1],
                        y: r[2],
                        z: r[3],
                        angle: None,
                        length: None,
                        target: None,
                        source: None,
                        sound: None,
                    });
                }
            }
            let (_, rolling, lateral) = slip(r);
            let sideways = lateral.abs();
            let ratio = sideways / rolling.abs().max(1.0);
            c.skid = if c.skid {
                sideways > SKID_SPEED * 0.7 && ratio > SKID_RELEASE
            } else {
                sideways > SKID_SPEED && ratio > SKID_ANGLE
            };
        }
        events
    }

    /// Adds one entity per car. Headlights follow `simulation.ts` night(): 18:00 to 06:00.
    pub fn entities(&self, world: &World, day: f32, out: &mut HashMap<u32, Entity>) {
        let s = world.states();
        for r in rows(world, &s).0 {
            let Some(c) = self.cars.get(&(r[0] as u32)) else {
                continue;
            };
            let (angle, pitch, roll) = euler([r[4], r[5], r[6], r[7]]);
            out.insert(
                c.entity,
                Entity {
                    id: c.entity.to_string(),
                    kind: Kind::Car,
                    x: r[1],
                    y: vehicle_contact_y(r[2], pitch, roll),
                    z: r[3],
                    angle,
                    pitch,
                    roll,
                    vx: r[8],
                    vy: r[9],
                    vz: r[10],
                    color: c.model.color.into(),
                    health: c.model.health,
                    max_health: Some(c.model.health),
                    model: Some(c.model.name.into()),
                    seats: Some(c.seats.iter().map(|s| s.map(|id| id.to_string())).collect()),
                    driver: c.seats[0].map(|id| id.to_string()),
                    steering: Some(world.steering(r[0] as u32)),
                    skidding: Some(c.skid),
                    wheel_skids: Some(vec![false, false, c.skid, c.skid]),
                    lights_on: Some(!(6.0..18.0).contains(&day)),
                    flooded: c.flooded,
                    wreck: c.wreck.then_some(180.0),
                    ..Default::default()
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slab() -> World {
        let mut w = World::new();
        w.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
        w
    }

    #[test]
    fn a_car_in_deep_water_floods_then_explodes_into_a_wreck() {
        let mut w = slab();
        let mut v = Vehicles::new(&mut w, [0.0, 1.0, 0.0]);
        let dry = |_: f32, _: f32| 0.0;
        let deep = |_: f32, _: f32| 2.0;
        assert!(v.update(&w, &dry, 1.0).is_empty());
        let mut booms = 0;
        for _ in 0..12 {
            booms += v.update(&w, &deep, 1.0).len();
        }
        assert_eq!(
            booms, 3,
            "each of the three starter cars explodes once, after 10 s"
        );
        let mut out = HashMap::new();
        v.entities(&w, 12.0, &mut out);
        assert!(
            out.values()
                .all(|e| e.wreck.is_some() && e.flooded.is_none())
        );
    }

    #[test]
    fn seats_fill_driver_first_and_only_the_driver_steers() {
        let mut w = slab();
        let mut v = Vehicles::new(&mut w, [0.0, 1.0, 0.0]);
        let a = w.spawn_character([4.0, 1.0, 22.0]);
        let b = w.spawn_character([4.0, 1.0, 22.0]);
        let car = v.enter(&w, a, 1).unwrap();
        assert_eq!(v.rider(car, 1), Some((CAR_ID_BASE, 0)));
        assert_eq!(v.enter(&w, b, 2), Some(car));
        assert_eq!(v.rider(car, 2), Some((CAR_ID_BASE, 1)));
        let drive = Drive {
            throttle: 1.0,
            steer: 0.5,
            brake: false,
            service_brake: 0.0,
            occupied: true,
        };
        v.drive(&mut w, car, 2, drive);
        assert_eq!(v.cars[&car].steer, 0.0);
        v.drive(&mut w, car, 1, drive);
        assert_eq!(v.cars[&car].steer, 0.5);
        assert!(v.horn(&w, car, 2, true).is_none());
        assert!(v.horn(&w, car, 1, true).is_some());
        assert!(
            v.horn(&w, car, 1, true).is_none(),
            "held, not pressed again"
        );
        let out = v.leave(&mut w, car, 1);
        assert_eq!(v.cars[&car].seats, vec![None, Some(2), None, None]);
        assert!((out[0] - 7.0).abs() < 1e-3 && (out[2] - 25.0).abs() < 1e-3);
    }

    #[test]
    fn far_away_player_finds_no_car() {
        let mut w = slab();
        let mut v = Vehicles::new(&mut w, [0.0, 1.0, 0.0]);
        let a = w.spawn_character([0.0, 1.0, 0.0]);
        assert_eq!(v.enter(&w, a, 1), None);
    }
}

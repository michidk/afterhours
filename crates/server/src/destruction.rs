//! Breakable street props and the debris they leave: a port of `server/destruction.ts`
//! and `shared/destruction.ts`. Only `City.props` (palm, tree, lamp) are breakable; park
//! benches, road signals, hydrants, crates and corpses are not ported.
use crate::city::City;
use afterhours_physics::World;
use afterhours_protocol::{DebrisState, Quat, TICK_RATE, Vec3, WorldEvent};
use serde::Serialize;
use std::collections::HashMap;

/// `shared/catalog.ts` TUNING.propDebrisSeconds.
pub const DEBRIS_SECONDS: f64 = 30.0;
/// `server/destruction.ts` maxBodies.
const MAX_BODIES: usize = 128;
/// `shared/destruction.ts` DEBRIS_LIFT.
const DEBRIS_LIFT: f32 = 0.16;
/// `server/simulation.ts`: a strike counts above this approach speed and keeps 96% of it.
const STRIKE_MIN_SPEED: f32 = 2.0;
const STRIKE_RETENTION: f32 = 0.96;

/// Mirrors the browser's `Destructible` (`shared/destruction.ts`); `y` is the ground
/// under the prop, server-only.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Destructible {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub z: f64,
    pub h: f64,
    pub w: f64,
    pub d: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
    #[serde(skip)]
    pub y: f32,
}

impl Destructible {
    /// `prop()` in `shared/destruction.ts`: trees are 0.5 m square, the rest 0.38 m.
    pub fn new(kind: &str, x: f64, z: f64, h: f64, angle: Option<f64>, y: f32) -> Self {
        let w = if kind == "tree" { 0.5 } else { 0.38 };
        Self {
            id: format!("{kind}:{x:.4},{z:.4}"),
            kind: kind.into(),
            x,
            z,
            h,
            w,
            d: w,
            angle,
            y,
        }
    }

    /// `PROP_HEALTH` in `shared/destruction.ts`.
    fn health(&self) -> f32 {
        match self.kind.as_str() {
            "palm" => 65.0,
            "tree" => 90.0,
            "lamp" => 45.0,
            "bench" => 40.0,
            "signal" => 50.0,
            "hydrant" => 45.0,
            "crate" => 35.0,
            _ => f32::INFINITY,
        }
    }

    /// `weight` in `server/destruction.ts`, kilograms.
    fn weight(&self) -> f32 {
        match self.kind.as_str() {
            "palm" => 100.0,
            "tree" => 180.0,
            "lamp" => 35.0,
            "bench" => 35.0,
            "signal" => 40.0,
            "hydrant" => 30.0,
            "crate" => 20.0,
            _ => 80.0,
        }
    }

    /// `damageProp` in `server/simulation.ts`.
    fn sound(&self) -> &'static str {
        match self.kind.as_str() {
            "palm" | "tree" | "bench" | "crate" => "impactWood",
            _ => "impact",
        }
    }

    fn half(&self) -> [f32; 3] {
        [
            self.w as f32 / 2.0,
            self.h as f32 / 2.0,
            self.d as f32 / 2.0,
        ]
    }

    fn center(&self) -> [f32; 3] {
        [self.x as f32, self.y + self.h as f32 / 2.0, self.z as f32]
    }

    fn yaw(&self) -> f32 {
        self.angle.unwrap_or(0.0) as f32
    }
}

/// `destructibles()` in `shared/destruction.ts`, props only.
pub fn destructibles(city: &City) -> Vec<Destructible> {
    city.props
        .iter()
        .map(|p| {
            Destructible::new(
                &p.kind,
                p.x,
                p.z,
                p.h,
                p.angle,
                city.height(p.x as f32, p.z as f32),
            )
        })
        .collect()
}

/// `strikeDamage` in `shared/destruction.ts`.
pub fn strike_damage(speed: f32) -> f32 {
    (speed - STRIKE_MIN_SPEED) * 14.0
}

/// `strikeVelocity`: slightly faster than the car and up, so debris leaves the bumper.
pub fn strike_velocity(vx: f32, vz: f32) -> [f32; 3] {
    [vx * 1.1, 2.5 + vx.hypot(vz) * 0.05, vz * 1.1]
}

/// `debrisSpin`: it topples the way it was pushed.
pub fn debris_spin(v: [f32; 3]) -> [f32; 3] {
    [v[2] * 0.3 + 0.7, 0.3, -v[0] * 0.3 - 0.8]
}

struct Standing {
    prop: Destructible,
    damage: f32,
}

struct Debris {
    /// `None` once retired to make room: the body is gone, `state` is frozen.
    body: Option<u32>,
    state: DebrisState,
}

#[derive(Default)]
pub struct Destruction {
    /// Standing props by physics prop id.
    standing: HashMap<u32, Standing>,
    /// Broken props in break order (oldest first), with their debris.
    debris: Vec<(Destructible, Debris)>,
    /// Lifetime of debris; tests shorten it.
    pub debris_seconds: f64,
    /// Events raised since the last broadcast; `Game::broadcast` takes them.
    pub events: Vec<WorldEvent>,
    /// Debris snapshot refreshed every step, sent in every State.
    pub states: Vec<DebrisState>,
    /// Monotonic change generation and the last generation each player heard.
    /// A generation avoids tick-order edge cases when a state is broadcast after a step.
    changed: u64,
    told: HashMap<u32, u64>,
}

impl Destruction {
    pub fn new() -> Self {
        Self {
            debris_seconds: DEBRIS_SECONDS,
            ..Default::default()
        }
    }

    /// Adds every prop as a static collider, then warms the world like Node `prepare()`:
    /// one throwaway body stepped a few times so the first live impact pays no setup cost.
    pub fn add_props(&mut self, world: &mut World, props: Vec<Destructible>) {
        for p in props {
            self.stand(world, p);
        }
        let probe = world.spawn_debris([0.0, 0.5, 0.0], [0.3; 3], 0.0, 1.0, [0.0; 3], [0.0; 3]);
        for _ in 0..4 {
            world.step();
        }
        world.remove_debris(probe);
    }

    fn stand(&mut self, world: &mut World, prop: Destructible) {
        let id = world.add_prop(prop.center(), prop.half(), prop.yaw());
        self.standing.insert(id, Standing { prop, damage: 0.0 });
    }

    pub fn broken(&self) -> Vec<String> {
        self.debris.iter().map(|(p, _)| p.id.clone()).collect()
    }

    /// The full broken list when it changed since this player last heard, or never has.
    pub fn broken_for(&mut self, player: u32, _tick: u32) -> Option<Vec<String>> {
        let previous = self.told.insert(player, self.changed);
        if previous == Some(self.changed) {
            None
        } else {
            Some(self.broken())
        }
    }

    pub fn forget(&mut self, player: u32) {
        self.told.remove(&player);
    }

    /// Runs after `world.step()`: applies this tick's vehicle strikes, expires debris, and
    /// refreshes `states`.
    pub fn step(&mut self, world: &mut World, tick: u32) {
        let time = tick as f64 / TICK_RATE as f64;
        for i in world.impacts().to_vec() {
            if i.speed <= STRIKE_MIN_SPEED {
                continue;
            }
            let Some(s) = self.standing.get_mut(&i.prop) else {
                continue;
            };
            s.damage += strike_damage(i.speed);
            if s.damage < s.prop.health() {
                continue;
            }
            let prop = self.standing.remove(&i.prop).unwrap().prop;
            world.remove_prop(i.prop);
            let [vx, vy, vz] = i.velocity;
            // The solver already stopped the car at the prop; Node lets it keep 96%.
            world.set_vehicle_velocity(
                i.vehicle,
                [vx * STRIKE_RETENTION, vy, vz * STRIKE_RETENTION],
            );
            self.events.push(WorldEvent {
                kind: "propBreak".into(),
                x: prop.x as f32,
                y: prop.y + 0.5,
                z: prop.z as f32,
                angle: None,
                length: None,
                target: None,
                source: None,
                sound: Some(prop.sound().into()),
            });
            self.spawn(world, prop, time, strike_velocity(vx, vz));
            self.changed += 1;
        }
        let mut i = 0;
        while i < self.debris.len() {
            if time < self.debris[i].1.state.expires_at {
                i += 1;
                continue;
            }
            let (prop, d) = self.debris.remove(i);
            if let Some(b) = d.body {
                world.remove_debris(b);
            }
            // Node clears the broken flag on expiry: the fixture stands again.
            self.stand(world, prop);
            self.changed += 1;
        }
        for (_, d) in &mut self.debris {
            if let Some(s) = d.body.and_then(|b| world.debris_state(b)) {
                d.state.position = Vec3 {
                    x: s[0],
                    y: s[1],
                    z: s[2],
                };
                d.state.rotation = Quat {
                    x: s[3],
                    y: s[4],
                    z: s[5],
                    w: s[6],
                };
                d.state.velocity = Vec3 {
                    x: s[7],
                    y: s[8],
                    z: s[9],
                };
                d.state.angular_velocity = Vec3 {
                    x: s[10],
                    y: s[11],
                    z: s[12],
                };
            }
        }
        self.states = self.debris.iter().map(|(_, d)| d.state.clone()).collect();
    }

    fn spawn(&mut self, world: &mut World, prop: Destructible, time: f64, v: [f32; 3]) {
        let live = self.debris.iter().filter(|(_, d)| d.body.is_some()).count();
        if live >= MAX_BODIES
            && let Some((_, d)) = self.debris.iter_mut().find(|(_, d)| d.body.is_some())
        {
            // shortcut: retired debris freezes where it is; Node also settles it to the floor.
            world.remove_debris(d.body.take().unwrap());
        }
        let mut center = prop.center();
        center[1] += DEBRIS_LIFT;
        let body = world.spawn_debris(
            center,
            prop.half(),
            prop.yaw(),
            prop.weight(),
            v,
            debris_spin(v),
        );
        let state = DebrisState {
            id: prop.id.clone(),
            source: serde_json::to_value(&prop).unwrap(),
            position: Vec3 {
                x: center[0],
                y: center[1],
                z: center[2],
            },
            rotation: Quat {
                x: 0.0,
                y: 0.0,
                z: 0.0,
                w: 1.0,
            },
            velocity: Vec3 {
                x: v[0],
                y: v[1],
                z: v[2],
            },
            angular_velocity: Vec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            broken_at: time,
            expires_at: time + self.debris_seconds,
        };
        self.debris.push((
            prop,
            Debris {
                body: Some(body),
                state,
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_browser_format() {
        let p = Destructible::new("lamp", 12.0, -3.25, 6.0, None, 0.0);
        assert_eq!(p.id, "lamp:12.0000,-3.2500");
        assert_eq!((p.w, p.d), (0.38, 0.38));
        assert_eq!(Destructible::new("tree", 0.0, 0.0, 8.0, None, 0.0).w, 0.5);
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("y").is_none() && json.get("angle").is_none());
    }

    #[test]
    fn strike_rules_match_node() {
        assert_eq!(strike_damage(5.0), 42.0);
        // One strike at 6.7 m/s is lethal for a palm (65), not for a tree (90).
        assert!(strike_damage(6.7) >= 65.0 && strike_damage(6.7) < 90.0);
        assert_eq!(strike_velocity(10.0, 0.0), [11.0, 3.0, 0.0]);
        assert_eq!(debris_spin([10.0, 0.0, 0.0]), [0.7, 0.3, -3.8]);
    }

    #[test]
    fn broken_list_goes_out_once_per_change_and_on_join() {
        let mut d = Destruction::new();
        assert_eq!(d.broken_for(1, 4), Some(vec![]));
        assert_eq!(d.broken_for(1, 6), None);
        d.changed = 1;
        assert_eq!(d.broken_for(1, 8), Some(vec![]));
        assert_eq!(d.broken_for(1, 10), None);
        assert_eq!(d.broken_for(2, 10), Some(vec![]));
    }

    #[test]
    fn a_fast_car_breaks_a_lamp_and_it_stands_again_after_expiry() {
        let mut w = World::new();
        w.add_box([0.0, -0.5, 0.0], [200.0, 0.5, 200.0], 0.0);
        let car = w.spawn_vehicle(afterhours_physics::VehicleSpec::SEDAN, [0.0, 1.0, 0.0], 0.0);
        let mut d = Destruction::new();
        d.debris_seconds = 1.0;
        d.add_props(
            &mut w,
            vec![Destructible::new("lamp", 0.0, 8.0, 6.0, None, 0.0)],
        );
        w.set_vehicle_velocity(car, [0.0, 0.0, 12.0]);
        let mut broke_at = None;
        for tick in 1..120 {
            w.step();
            d.step(&mut w, tick);
            if broke_at.is_none() && !d.debris.is_empty() {
                broke_at = Some(tick);
                assert_eq!(d.broken(), ["lamp:0.0000,8.0000"]);
                assert_eq!(d.events.len(), 1);
                assert_eq!(d.events[0].sound.as_deref(), Some("impact"));
                assert_eq!(d.states[0].expires_at, tick as f64 / 30.0 + 1.0);
            }
        }
        let broke_at = broke_at.expect("lamp broke");
        assert!(broke_at < 30, "broke at tick {broke_at}");
        assert!(
            d.debris.is_empty() && d.standing.len() == 1,
            "lamp stands again"
        );
    }
}

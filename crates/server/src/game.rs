//! The authoritative simulation: one owner task, no locks. Sessions feed it `Event`s and
//! it writes encoded `ServerMessage`s back through each session's channel.
use afterhours_physics::{CHARACTER_STRIDE, Drive, Move, VEHICLE_STRIDE, VehicleSpec, World};
use afterhours_protocol::{
    ClientMessage, Controls, Entity, Kind, ServerMessage, TICK_RATE, VERSION, encode,
};
use std::collections::{BTreeMap, HashMap, VecDeque};
use tokio::sync::mpsc::UnboundedSender;

pub const SNAPSHOT_EVERY: u32 = 2;
const HISTORY: usize = 64;
const WALK_SPEED: f32 = 4.5;
const SPRINT: f32 = 1.6;
const ENTER_RANGE: f32 = 4.0;
/// Car entity ids live above every session id.
const CAR_ID_BASE: u32 = 1 << 24;

pub enum Event {
    Connect(u32, UnboundedSender<Vec<u8>>),
    Message(u32, ClientMessage),
    Disconnect(u32),
}

struct Player {
    out: UnboundedSender<Vec<u8>>,
    name: String,
    color: String,
    character: Option<serde_json::Value>,
    /// Physics character while on foot, else the car entity id.
    body: Result<u32, u32>,
    inputs: BTreeMap<u32, Controls>,
    held: Controls,
    acked: Option<u32>,
    applied: Option<u32>,
    lead: i32,
}

pub struct Game {
    world: World,
    spawn: [f32; 3],
    tick: u32,
    players: HashMap<u32, Player>,
    pending: HashMap<u32, UnboundedSender<Vec<u8>>>,
    /// Vehicle physics id -> (entity id, driver).
    cars: HashMap<u32, (u32, Option<u32>)>,
    history: VecDeque<(u32, HashMap<u32, Entity>)>,
    /// City manifest sent in every welcome.
    pub map: serde_json::Value,
}

/// Yaw, pitch, roll (Y-X-Z) from an x, y, z, w quaternion.
fn euler(q: [f32; 4]) -> (f32, f32, f32) {
    let [x, y, z, w] = q;
    let yaw = (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + z * z));
    let pitch = (2.0 * (w * x - y * z)).clamp(-1.0, 1.0).asin();
    let roll = (2.0 * (w * z + x * y)).atan2(1.0 - 2.0 * (x * x + z * z));
    (yaw, pitch, roll)
}

/// Splits the flat physics state into vehicle and character rows.
fn rows<'a>(
    world: &World,
    s: &'a [f32],
) -> (&'a [[f32; VEHICLE_STRIDE]], &'a [[f32; CHARACTER_STRIDE]]) {
    let (v, c) = s.split_at(world.counts().0 * VEHICLE_STRIDE);
    (v.as_chunks().0, c.as_chunks().0)
}

impl Game {
    /// `world` already holds the static city; players and cars appear around `spawn`.
    pub fn new(mut world: World, spawn: [f32; 3]) -> Self {
        let mut cars = HashMap::new();
        for (i, dx) in [-6.0f32, 6.0].into_iter().enumerate() {
            let at = [spawn[0] + dx, spawn[1], spawn[2] + 6.0];
            let v = world.spawn_vehicle(VehicleSpec::SEDAN, at, 0.0);
            cars.insert(v, (CAR_ID_BASE + i as u32, None));
        }
        Self {
            world,
            spawn,
            tick: 0,
            players: HashMap::new(),
            pending: HashMap::new(),
            cars,
            history: VecDeque::new(),
            map: serde_json::Value::Null,
        }
    }

    pub fn handle(&mut self, event: Event) {
        match event {
            Event::Connect(id, out) => {
                self.pending.insert(id, out);
            }
            Event::Disconnect(id) => {
                self.pending.remove(&id);
                if let Some(p) = self.players.remove(&id) {
                    match p.body {
                        Ok(c) => {
                            self.world.remove_character(c);
                        }
                        Err(car) => self.vacate(car),
                    }
                }
            }
            Event::Message(
                id,
                ClientMessage::Join {
                    version,
                    name,
                    color,
                    character,
                },
            ) => {
                let Some(out) = self.pending.remove(&id) else {
                    return;
                };
                if version != VERSION || name.trim().is_empty() || name.len() > 18 {
                    return;
                }
                let _ = out.send(encode(&ServerMessage::Welcome {
                    version: VERSION,
                    id: id.to_string(),
                    tick: self.tick,
                    tick_rate: TICK_RATE,
                    map: self.map.clone(),
                }));
                let body = self.world.spawn_character(self.spawn);
                self.players.insert(
                    id,
                    Player {
                        out,
                        name: name.trim().to_string(),
                        color,
                        character,
                        body: Ok(body),
                        inputs: BTreeMap::new(),
                        held: Controls::default(),
                        acked: None,
                        applied: None,
                        lead: 0,
                    },
                );
            }
            Event::Message(
                id,
                ClientMessage::Input {
                    tick,
                    ack,
                    controls,
                },
            ) => {
                let now = self.tick;
                if let Some(p) = self.players.get_mut(&id) {
                    p.lead = tick as i32 - now as i32;
                    p.acked = ack;
                    if tick >= now && p.inputs.len() < 64 {
                        p.inputs.insert(tick, controls);
                    }
                }
            }
            Event::Message(id, ClientMessage::Chat { text }) => {
                let text: String = text.trim().chars().take(160).collect();
                if text.is_empty() || !self.players.contains_key(&id) {
                    return;
                }
                let msg = encode(&ServerMessage::Chat {
                    name: self.players[&id].name.clone(),
                    text,
                });
                for p in self.players.values() {
                    let _ = p.out.send(msg.clone());
                }
            }
            Event::Message(id, ClientMessage::Ping { timestamp }) => {
                let tick = self.tick;
                if let Some(p) = self.players.get(&id) {
                    let _ = p.out.send(encode(&ServerMessage::Pong { timestamp, tick }));
                }
            }
        }
    }

    pub fn step(&mut self) {
        let ids: Vec<u32> = self.players.keys().copied().collect();
        for id in ids {
            self.apply_input(id);
        }
        self.world.step();
        self.tick += 1;
        let entities = self.entities();
        if self.history.len() == HISTORY {
            self.history.pop_front();
        }
        self.history.push_back((self.tick, entities));
        if self.tick.is_multiple_of(SNAPSHOT_EVERY) {
            self.broadcast();
        }
    }

    fn apply_input(&mut self, id: u32) {
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        // Late frames are dropped: the tick they described has already been simulated.
        p.inputs = p.inputs.split_off(&tick);
        if let Some(c) = p.inputs.remove(&tick) {
            p.held = c;
            p.applied = Some(tick);
        }
        let c = p.held.clone();
        match p.body {
            Ok(body) => {
                let speed = WALK_SPEED * if c.sprint { SPRINT } else { 1.0 };
                self.world.set_move(
                    body,
                    Move {
                        x: c.x(),
                        z: c.y(),
                        speed,
                        jump: c.ascend,
                    },
                );
                if c.interact
                    && let Some((car, pos)) = self.nearest_free_car(body)
                {
                    self.world.remove_character(body);
                    self.cars.get_mut(&car).unwrap().1 = Some(id);
                    self.players.get_mut(&id).unwrap().body = Err(car);
                    let _ = pos;
                }
            }
            Err(car) => {
                self.world.set_drive(
                    car,
                    Drive {
                        throttle: c.y(),
                        steer: c.x(),
                        brake: c.brake,
                    },
                );
                if c.interact {
                    let pos = self
                        .vehicle_state(car)
                        .map(|s| [s[0] + 2.0, s[1], s[2]])
                        .unwrap_or([0.0, 1.0, 0.0]);
                    self.vacate(car);
                    let body = self.world.spawn_character(pos);
                    self.players.get_mut(&id).unwrap().body = Ok(body);
                }
            }
        }
        // Edge actions fire once per frame, never while the frame is held.
        let held = &mut self.players.get_mut(&id).unwrap().held;
        (
            held.interact,
            held.drop,
            held.reload,
            held.jetpack,
            held.equip,
        ) = (false, false, false, false, None);
    }

    fn vacate(&mut self, car: u32) {
        self.world.set_drive(car, Drive::default());
        if let Some(c) = self.cars.get_mut(&car) {
            c.1 = None;
        }
    }

    fn vehicle_state(&self, car: u32) -> Option<[f32; 3]> {
        let s = self.world.states();
        rows(&self.world, &s)
            .0
            .iter()
            .find(|r| r[0] as u32 == car)
            .map(|r| [r[1], r[2], r[3]])
    }

    fn nearest_free_car(&self, body: u32) -> Option<(u32, [f32; 3])> {
        let s = self.world.states();
        let (cars, chars) = rows(&self.world, &s);
        let me = chars.iter().find(|r| r[0] as u32 == body)?;
        cars.iter()
            .filter(|r| self.cars.get(&(r[0] as u32)).is_some_and(|c| c.1.is_none()))
            .map(|r| {
                (
                    r[0] as u32,
                    [r[1], r[2], r[3]],
                    (r[1] - me[1]).hypot(r[3] - me[3]),
                )
            })
            .filter(|&(_, _, d)| d <= ENTER_RANGE)
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .map(|(id, pos, _)| (id, pos))
    }

    fn entities(&self) -> HashMap<u32, Entity> {
        let s = self.world.states();
        let (cars, chars) = rows(&self.world, &s);
        let mut out = HashMap::new();
        let mut car_rows = HashMap::new();
        for r in cars {
            let (entity, driver) = self.cars[&(r[0] as u32)];
            car_rows.insert(r[0] as u32, r);
            let (angle, pitch, roll) = euler([r[4], r[5], r[6], r[7]]);
            out.insert(
                entity,
                Entity {
                    id: entity.to_string(),
                    kind: Kind::Car,
                    x: r[1],
                    y: r[2],
                    z: r[3],
                    angle,
                    pitch,
                    roll,
                    vx: r[8],
                    vy: r[9],
                    vz: r[10],
                    color: "#b8c0cc".into(),
                    health: 100.0,
                    name: None,
                    character: None,
                    model: Some("sedan".into()),
                    seats: Some(vec![driver.map(|d| d.to_string())]),
                    driver: driver.map(|d| d.to_string()),
                    vehicle: None,
                    seat: None,
                    steering: None,
                },
            );
        }
        let chars: HashMap<u32, _> = chars.iter().map(|r| (r[0] as u32, r)).collect();
        for (&id, p) in &self.players {
            let mut e = Entity {
                id: id.to_string(),
                kind: Kind::Player,
                x: 0.0,
                y: 0.0,
                z: 0.0,
                // shortcut: on foot, facing follows the move stick, not the aim; upgrade with aim.
                angle: p.held.x().atan2(p.held.y()),
                pitch: 0.0,
                roll: 0.0,
                vx: p.held.x() * WALK_SPEED,
                vy: 0.0,
                vz: p.held.y() * WALK_SPEED,
                color: p.color.clone(),
                health: 100.0,
                name: Some(p.name.clone()),
                character: p.character.clone(),
                model: None,
                seats: None,
                driver: None,
                vehicle: None,
                seat: None,
                steering: None,
            };
            match p.body {
                Ok(body) => {
                    if let Some(r) = chars.get(&body) {
                        (e.x, e.y, e.z, e.vy) = (r[1], r[2], r[3], r[4]);
                    }
                }
                Err(car) => {
                    let r = car_rows[&car];
                    (e.x, e.y, e.z) = (r[1], r[2], r[3]);
                    (e.angle, e.pitch, e.roll) = euler([r[4], r[5], r[6], r[7]]);
                    (e.vx, e.vy, e.vz) = (r[8], r[9], r[10]);
                    e.vehicle = Some(self.cars[&car].0.to_string());
                    e.seat = Some(0);
                }
            }
            out.insert(id, e);
        }
        out
    }

    /// Raw physics row of the body a player controls, for client restore-and-replay.
    fn you(&self, p: &Player) -> Option<Vec<f32>> {
        let s = self.world.states();
        let (cars, chars) = rows(&self.world, &s);
        let snap = self.world.snapshot();
        // `snapshot()` lays out 13 floats per vehicle then 5 per character, in `states()` order.
        let (at, len) = match p.body {
            Ok(body) => (
                cars.len() * 13 + 5 * chars.iter().position(|r| r[0] as u32 == body)?,
                5,
            ),
            Err(car) => (13 * cars.iter().position(|r| r[0] as u32 == car)?, 13),
        };
        Some(snap[at..at + len].to_vec())
    }

    fn broadcast(&self) {
        let (tick, current) = self.history.back().unwrap();
        for p in self.players.values() {
            let base = p
                .acked
                .and_then(|a| self.history.iter().find(|(t, _)| *t == a))
                .map(|(t, e)| (*t, e));
            let entities = current
                .iter()
                .filter(|(id, e)| base.is_none_or(|(_, b)| b.get(id) != Some(e)))
                .map(|(_, e)| e.clone())
                .collect();
            let removed = base
                .map(|(_, b)| {
                    b.keys()
                        .filter(|id| !current.contains_key(id))
                        .map(|id| id.to_string())
                        .collect()
                })
                .unwrap_or_default();
            let _ = p.out.send(encode(&ServerMessage::State {
                tick: *tick,
                base: base.map(|(t, _)| t),
                time: *tick as f64 / TICK_RATE as f64,
                ack: p.applied,
                lead: p.lead,
                entities,
                removed,
                you: self.you(p),
                players: self.players.len() as u32,
            }));
        }
    }
}

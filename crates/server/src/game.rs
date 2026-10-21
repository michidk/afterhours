//! The authoritative simulation: one owner task, no locks. Sessions feed it `Event`s and
//! it writes encoded `ServerMessage`s back through each session's channel.
use afterhours_physics::{CHARACTER_STRIDE, Drive, Move, VEHICLE_STRIDE, VehicleSpec, World};
use afterhours_protocol::{ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, encode};
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
    tick: u32,
    players: HashMap<u32, Player>,
    pending: HashMap<u32, UnboundedSender<Vec<u8>>>,
    /// Vehicle physics id -> (entity id, driver).
    cars: HashMap<u32, (u32, Option<u32>)>,
    history: VecDeque<(u32, HashMap<u32, Entity>)>,
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
    pub fn new() -> Self {
        let mut world = World::new();
        // shortcut: a flat 800 m slab stands in for the city until milestone 2.3 loads it.
        world.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
        let mut cars = HashMap::new();
        for (i, x) in [-6.0f32, 6.0].into_iter().enumerate() {
            let v = world.spawn_vehicle(VehicleSpec::SEDAN, [x, 1.0, 6.0], 0.0);
            cars.insert(v, (CAR_ID_BASE + i as u32, None));
        }
        Self {
            world,
            tick: 0,
            players: HashMap::new(),
            pending: HashMap::new(),
            cars,
            history: VecDeque::new(),
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
                    id,
                    tick: self.tick,
                    tick_rate: afterhours_protocol::TICK_RATE,
                }));
                let body = self.world.spawn_character([0.0, 1.0, 0.0]);
                self.players.insert(
                    id,
                    Player {
                        out,
                        name: name.trim().to_string(),
                        color,
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
        let c = p.held;
        match p.body {
            Ok(body) => {
                let speed = WALK_SPEED * if c.sprint { SPRINT } else { 1.0 };
                self.world.set_move(
                    body,
                    Move {
                        x: c.move_x,
                        z: c.move_z,
                        speed,
                        jump: c.jump,
                    },
                );
                if c.enter
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
                        throttle: c.throttle,
                        steer: c.steer,
                        brake: c.brake,
                    },
                );
                if c.enter {
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
        self.players.get_mut(&id).unwrap().held.enter = false;
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
            out.insert(
                entity,
                Entity {
                    id: entity,
                    kind: Kind::Car,
                    x: r[1],
                    y: r[2],
                    z: r[3],
                    q: [r[4], r[5], r[6], r[7]],
                    vx: r[8],
                    vy: r[9],
                    vz: r[10],
                    name: None,
                    color: None,
                    link: driver,
                },
            );
        }
        let chars: HashMap<u32, _> = chars.iter().map(|r| (r[0] as u32, r)).collect();
        for (&id, p) in &self.players {
            let mut e = Entity {
                id,
                kind: Kind::Player,
                x: 0.0,
                y: 0.0,
                z: 0.0,
                // shortcut: characters report no facing yet; the client derives it from velocity.
                q: [0.0, 0.0, 0.0, 1.0],
                vx: p.held.move_x,
                vy: 0.0,
                vz: p.held.move_z,
                name: Some(p.name.clone()),
                color: Some(p.color.clone()),
                link: None,
            };
            match p.body {
                Ok(body) => {
                    if let Some(r) = chars.get(&body) {
                        (e.x, e.y, e.z, e.vy) = (r[1], r[2], r[3], r[4]);
                    }
                }
                Err(car) => {
                    let r = car_rows[&car];
                    (e.x, e.y, e.z, e.q) = (r[1], r[2], r[3], [r[4], r[5], r[6], r[7]]);
                    (e.vx, e.vy, e.vz) = (r[8], r[9], r[10]);
                    e.link = Some(self.cars[&car].0);
                }
            }
            out.insert(id, e);
        }
        out
    }

    fn broadcast(&self) {
        let (tick, current) = self.history.back().unwrap();
        for p in self.players.values() {
            let base = p
                .acked
                .and_then(|a| self.history.iter().find(|(t, _)| *t == a))
                .map(|(t, e)| (*t, e));
            let entities = current
                .values()
                .filter(|e| base.is_none_or(|(_, b)| b.get(&e.id) != Some(e)))
                .cloned()
                .collect();
            let removed = base
                .map(|(_, b)| {
                    b.keys()
                        .filter(|id| !current.contains_key(id))
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
            let _ = p.out.send(encode(&ServerMessage::State {
                tick: *tick,
                base: base.map(|(t, _)| t),
                ack: p.applied,
                lead: p.lead,
                entities,
                removed,
            }));
        }
    }
}

impl Default for Game {
    fn default() -> Self {
        Self::new()
    }
}

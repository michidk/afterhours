//! The authoritative simulation: one owner task, no locks. Sessions feed it `Event`s and
//! it writes encoded `ServerMessage`s back through each session's channel.
use crate::city::{City, LIMIT, TERRAIN_SIDE, TERRAIN_STEP, WATER_LEVEL};
use crate::combat::Combat;
use crate::craft::{Fleet, PARACHUTE_FALL};
use crate::destruction::{Destructible, Destruction};
use crate::vehicles::{INTEREST_RADIUS, Vehicles};
use crate::{citizens::Citizens, traffic::Traffic};
use afterhours_physics::{
    CHARACTER_FEET, CHARACTER_STRIDE, Drive, Move, SNAPSHOT_VEHICLE, VEHICLE_STRIDE, World,
    vehicle_contact_y,
};
use afterhours_protocol::{
    ClientMessage, Controls, Entity, Kind, PlayerPosition, PlayerSummary, ServerMessage, TICK_RATE,
    VERSION, WorldEvent, encode,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, VecDeque};
use tokio::sync::mpsc::UnboundedSender;

pub const SNAPSHOT_EVERY: u32 = 2;
const HISTORY: usize = 64;
/// `TUNING.walk` / `TUNING.sprint` in `shared/catalog.ts`.
const WALK_SPEED: f32 = 4.5;
const SPRINT_SPEED: f32 = 8.0;

pub enum Event {
    Connect(u32, UnboundedSender<Vec<u8>>),
    Message(u32, ClientMessage),
    Disconnect(u32),
}

pub(crate) struct Player {
    out: UnboundedSender<Vec<u8>>,
    name: String,
    color: String,
    pub(crate) character: Option<serde_json::Value>,
    /// Physics character while on foot, else the car physics id.
    pub(crate) body: Result<u32, u32>,
    inputs: BTreeMap<u32, Controls>,
    held: Controls,
    acked: Option<u32>,
    applied: Option<u32>,
    lead: i32,
}

pub struct Game {
    pub(crate) diagnostics: crate::diagnostics::Diagnostics,
    world: World,
    spawn: [f32; 3],
    tick: u32,
    /// Set when a player acted (entered or left a vehicle, ...): the next snapshot goes out this
    /// tick instead of waiting for the regular cadence, so the result is not up to 66 ms late.
    urgent: bool,
    players: HashMap<u32, Player>,
    pending: HashMap<u32, UnboundedSender<Vec<u8>>>,
    vehicles: Vehicles,
    /// Hour of the day; `simulation.ts` starts at late afternoon.
    pub day: f32,
    pub day_rate: f32,
    /// World events since the last broadcast.
    events: Vec<WorldEvent>,
    history: VecDeque<(u32, HashMap<u32, Entity>)>,
    /// City manifest sent in every welcome.
    pub map: serde_json::Value,
    traffic: Traffic,
    citizens: Citizens,
    pub destruction: Destruction,
    pub combat: Combat,
    craft: Fleet,
    terrain: Option<Vec<f32>>,
}

/// Yaw, pitch, roll (Y-X-Z) from an x, y, z, w quaternion.
pub(crate) fn euler(q: [f32; 4]) -> (f32, f32, f32) {
    let [x, y, z, w] = q;
    let yaw = (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + z * z));
    let pitch = (2.0 * (w * x - y * z)).clamp(-1.0, 1.0).asin();
    let roll = (2.0 * (w * z + x * y)).atan2(1.0 - 2.0 * (x * x + z * z));
    (yaw, pitch, roll)
}

/// Splits the flat physics state into vehicle and character rows.
pub(crate) fn rows<'a>(
    world: &World,
    s: &'a [f32],
) -> (&'a [[f32; VEHICLE_STRIDE]], &'a [[f32; CHARACTER_STRIDE]]) {
    let (v, c) = s.split_at(world.counts().0 * VEHICLE_STRIDE);
    (v.as_chunks().0, c.as_chunks().0)
}

fn terrain_at(terrain: &Option<Vec<f32>>, x: f32, z: f32) -> f32 {
    let Some(h) = terrain else { return 0.0 };
    let gx = (x + LIMIT) / TERRAIN_STEP as f32;
    let gz = (z + LIMIT) / TERRAIN_STEP as f32;
    let ix = gx.floor().clamp(0.0, (TERRAIN_SIDE - 2) as f32) as usize;
    let iz = gz.floor().clamp(0.0, (TERRAIN_SIDE - 2) as f32) as usize;
    let (u, v) = (gx - ix as f32, gz - iz as f32);
    let i = iz * TERRAIN_SIDE + ix;
    if u + v <= 1.0 {
        h[i] + u * (h[i + 1] - h[i]) + v * (h[i + TERRAIN_SIDE] - h[i])
    } else {
        h[i + TERRAIN_SIDE + 1]
            + (1.0 - u) * (h[i + TERRAIN_SIDE] - h[i + TERRAIN_SIDE + 1])
            + (1.0 - v) * (h[i + 1] - h[i + TERRAIN_SIDE + 1])
    }
}

/// Walking pace: Space also sprints on foot, and the physique scales both paces.
fn walk_speed(c: &Controls, character: Option<&serde_json::Value>) -> f32 {
    let pace = if c.sprint || c.brake {
        SPRINT_SPEED
    } else {
        WALK_SPEED
    };
    pace * crate::combat::physique_speed(character)
}

impl Game {
    /// `world` already holds the static city; players and cars appear around `spawn`.
    pub fn new(mut world: World, spawn: [f32; 3]) -> Self {
        let vehicles = Vehicles::new(&mut world, spawn);
        Self {
            diagnostics: crate::diagnostics::Diagnostics::new(TICK_RATE),
            world,
            spawn,
            tick: 0,
            urgent: false,
            players: HashMap::new(),
            pending: HashMap::new(),
            vehicles,
            day: 16.5,
            day_rate: 1.0 / 75.0,
            events: Vec::new(),
            history: VecDeque::new(),
            map: serde_json::Value::Null,
            traffic: Traffic::default(),
            citizens: Citizens::default(),
            destruction: Destruction::new(),
            combat: Combat::default(),
            craft: Fleet::default(),
            terrain: None,
        }
    }

    /// Streets and sidewalks for AI traffic and pedestrians; without it there is no AI.
    pub fn set_city(&mut self, city: &City) {
        self.traffic = Traffic::new(city);
        self.citizens = Citizens::new(city);
        self.terrain = city.terrain.clone();
    }

    /// Terrain height at a point (the ground a client draws things on).
    pub fn ground_height(&self, x: f32, z: f32) -> f32 {
        terrain_at(&self.terrain, x, z)
    }

    /// Live AI counts: (cars, pedestrians).
    pub fn population(&self) -> (usize, usize) {
        (self.traffic.len(), self.citizens.len())
    }

    /// Takes an AI car away from traffic control so another owner can seat players in it;
    /// see `Traffic::vacate_car`. The vehicle stays in the physics world.
    pub fn vacate_ai_car(&mut self, car: u32) -> Option<u32> {
        self.traffic.vacate_car(car)
    }

    /// Fills the world with what the city calls for: the showroom when it carries one (the test
    /// world), otherwise the parked fleet.
    pub fn stock(&mut self, city: &City) -> Result<(), String> {
        if crate::showroom::layout(city).is_some() {
            self.showroom(city)
        } else {
            self.park(city);
            Ok(())
        }
    }

    /// Parks the city's starter fleet in place of the no-city placeholders.
    pub fn park(&mut self, city: &City) {
        self.vehicles.park(&mut self.world, city);
        let terrain = &self.terrain;
        self.craft
            .park(city, &|x, z| terrain_at(terrain, x, z).max(WATER_LEVEL));
    }

    /// The test world: one of every vehicle and item beside the spawn, in place of the parked
    /// fleet (see `showroom.rs`). Traffic and pedestrians still spawn from the streets.
    pub fn showroom(&mut self, city: &City) -> Result<(), String> {
        let layout = crate::showroom::layout(city)
            .ok_or("the city has no SHOWROOM and BOAT POND landmarks")?;
        self.vehicles.clear(&mut self.world);
        for &(model, x, z, yaw) in &layout.cars {
            let y = self.ground_height(x, z) + 1.0;
            self.vehicles
                .spawn_facing(&mut self.world, model, [x, y, z], yaw)?;
        }
        let terrain = &self.terrain;
        for &(model, x, z, yaw) in &layout.craft {
            let y = terrain_at(terrain, x, z);
            self.craft.place(model, x, y, z, yaw);
        }
        for &(model, x, z, yaw) in &layout.boats {
            self.craft.place(model, x, WATER_LEVEL, z, yaw);
        }
        self.combat
            .showcase(&layout.items, |x, z| terrain_at(terrain, x, z));
        Ok(())
    }

    /// Where each parked craft model stands; see `Fleet::spots`.
    pub fn craft_spots(&self) -> Vec<(&'static str, f32, f32)> {
        self.craft.spots()
    }

    /// Breakable props (see `destruction.rs`), added to the physics world as static boxes.
    pub fn add_props(&mut self, props: Vec<Destructible>) {
        self.destruction.add_props(&mut self.world, props);
    }

    pub fn handle(&mut self, event: Event) {
        match event {
            Event::Connect(id, out) => {
                self.pending.insert(id, out);
            }
            Event::Disconnect(id) => {
                self.pending.remove(&id);
                self.destruction.forget(id);
                self.combat.forget(id);
                let terrain = &self.terrain;
                self.craft
                    .leave(id, &|x, z| terrain_at(terrain, x, z).max(WATER_LEVEL));
                if let Some(p) = self.players.remove(&id) {
                    match p.body {
                        Ok(c) => {
                            self.world.remove_character(c);
                        }
                        Err(car) => {
                            self.vehicles.leave(&mut self.world, car, id);
                        }
                    }
                }
                self.send_roster();
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
                    debug: true,
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
                self.send_roster();
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
            Event::Message(
                id,
                ClientMessage::DebugCommand {
                    request_id,
                    command,
                },
            ) => {
                let result = self.execute_debug(id, &command);
                let message = match result {
                    Ok(state) => ServerMessage::DebugResult {
                        request_id,
                        state: Some(state),
                        error: None,
                    },
                    Err(error) => ServerMessage::DebugResult {
                        request_id,
                        state: None,
                        error: Some(error),
                    },
                };
                if let Some(p) = self.players.get(&id) {
                    let _ = p.out.send(encode(&message));
                }
            }
            Event::Message(_, ClientMessage::Debug { .. } | ClientMessage::DebugView { .. }) => {}
            Event::Message(id, ClientMessage::Ping { timestamp }) => {
                let tick = self.tick;
                if let Some(p) = self.players.get(&id) {
                    let _ = p.out.send(encode(&ServerMessage::Pong { timestamp, tick }));
                }
            }
        }
    }

    fn execute_debug(&mut self, id: u32, command: &Value) -> Result<Value, String> {
        if !self.players.contains_key(&id) {
            return Err("Not joined".to_string());
        }
        let kind = command
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "time" => {
                let hour = command
                    .get("hour")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Missing hour".to_string())?;
                if !hour.is_finite() || !(0.0..=24.0).contains(&hour) {
                    return Err("Invalid hour".into());
                }
                self.day = (hour as f32).rem_euclid(24.0);
                if let Some(rate) = command.get("rate").and_then(Value::as_f64) {
                    if !rate.is_finite() || !(0.0..=24.0).contains(&rate) {
                        return Err("Invalid day rate".into());
                    }
                    self.day_rate = rate as f32;
                }
            }
            "teleport" => {
                let x = command
                    .get("x")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Missing x".to_string())? as f32;
                let z = command
                    .get("z")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Missing z".to_string())? as f32;
                if x.abs() > 1532.0 || z.abs() > 1532.0 {
                    return Err("Teleport is outside the world".into());
                }
                let body = self
                    .players
                    .get(&id)
                    .map(|p| p.body)
                    .ok_or_else(|| "Not joined".to_string())?;
                match body {
                    Ok(character) => {
                        self.world.set_character_position(
                            character,
                            [x, self.ground_height(x, z) + 1.0, z],
                        );
                    }
                    Err(car) => {
                        let row = rows(&self.world, &self.world.states())
                            .0
                            .iter()
                            .find(|r| r[0] as u32 == car)
                            .copied()
                            .ok_or_else(|| "Vehicle not found".to_string())?;
                        self.world.set_vehicle_position(
                            car,
                            [x, self.ground_height(x, z) + 1.0, z],
                            euler([row[4], row[5], row[6], row[7]]).0,
                        );
                    }
                }
            }
            "spawn" => {
                let model = command
                    .get("model")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Missing vehicle model".to_string())?;
                let (x, z) = self.player_position(id)?;
                // Start where the first car always went, then widen the search ring by ring
                // until the footprint touches no wall, prop or other car.
                let (width, length) = self.vehicles.footprint(model)?;
                let spot = std::iter::once((8.0, -5.5))
                    .chain((1..=6).flat_map(|ring| {
                        let r = 6.0 + 4.0 * ring as f32;
                        (0..12).map(move |k| {
                            let a = k as f32 * std::f32::consts::TAU / 12.0;
                            (r * a.cos(), r * a.sin())
                        })
                    }))
                    .map(|(dx, dz)| (x + dx, z + dz))
                    .find(|&(cx, cz)| {
                        let cy = self.ground_height(cx, cz) + 1.0;
                        // Raised 0.3 m so the wheels' ground contact is not an obstacle.
                        self.world.is_clear(
                            [cx, cy + 0.3, cz],
                            [width / 2.0, 0.5, length / 2.0],
                            std::f32::consts::PI,
                        )
                    })
                    .ok_or_else(|| "No clear space near you for a vehicle".to_string())?;
                let (spawn_x, spawn_z) = spot;
                let y = self.ground_height(spawn_x, spawn_z) + 1.0;
                self.vehicles
                    .spawn_debug(&mut self.world, model, [spawn_x, y, spawn_z])?;
            }
            "gotoPlayer" | "bringPlayer" => {
                let target = command
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<u32>().ok())
                    .ok_or_else(|| "Unknown player".to_string())?;
                if target == id || !self.players.contains_key(&target) {
                    return Err("Unknown player".into());
                }
                let (anchor_x, anchor_z) = if kind == "gotoPlayer" {
                    self.player_position(target)?
                } else {
                    self.player_position(id)?
                };
                let mover = if kind == "gotoPlayer" { id } else { target };
                let body = self
                    .players
                    .get(&mover)
                    .map(|p| p.body)
                    .ok_or_else(|| "Player not found".to_string())?;
                let position = [
                    anchor_x + 3.0,
                    self.ground_height(anchor_x + 3.0, anchor_z) + 1.0,
                    anchor_z,
                ];
                if let Ok(character) = body {
                    self.world.set_character_position(character, position);
                } else {
                    return Err("Moving seated players is not supported yet".into());
                }
            }
            "destroyProp" => {
                return Err("Prop destruction is not available in the Rust debug adapter".into());
            }
            "state" | "observe" => {}
            _ => return Err(format!("Unknown debug command: {kind}")),
        }
        Ok(self.debug_state(
            id,
            kind == "observe",
            command.get("id").and_then(Value::as_str),
        ))
    }

    fn player_position(&self, id: u32) -> Result<(f32, f32), String> {
        self.entities()
            .get(&id)
            .map(|e| (e.x, e.z))
            .ok_or_else(|| "Player not found".into())
    }

    fn debug_state(&self, id: u32, inspect: bool, inspected: Option<&str>) -> Value {
        let entities = self.entities();
        let input = self
            .players
            .get(&id)
            .map(|player| player.held.clone())
            .unwrap_or_default();
        let inspection = if inspect {
            inspected
                .and_then(|target| target.parse::<u32>().ok())
                .and_then(|target| entities.get(&target))
                .and_then(|e| {
                    serde_json::to_string_pretty(e)
                        .ok()
                        .map(|data| json!({ "id": e.id, "data": data }))
                })
        } else {
            None
        };
        let server = inspect.then(|| self.diagnostics.report(self.players.len(), entities.len()));
        json!({
            "server": server,
            "playerId": id.to_string(), "time": self.tick as f64 / TICK_RATE as f64,
            "day": self.day, "dayRate": self.day_rate, "citySeed": 0,
            "entities": entities.values().collect::<Vec<_>>(), "input": input,
            "inspection": inspection, "destruction": {"brokenProps": [], "nearby": [], "debris": self.destruction.states.clone(), "maxBodies": 128},
            "traffic": {"jamCount": 0, "jammedCars": 0, "honks": 0, "respawned": 0, "pendingRespawns": 0}
        })
    }

    pub fn step(&mut self) {
        self.day = (self.day + self.day_rate / TICK_RATE as f32).rem_euclid(24.0);
        let ids: Vec<u32> = self.players.keys().copied().collect();
        for id in ids {
            self.apply_input(id);
        }
        let empty = HashMap::new();
        let last = self.history.back().map_or(&empty, |(_, e)| e);
        self.traffic.step(&mut self.world, last, self.tick);
        self.citizens.step(&mut self.world, last, self.tick);
        self.combat.step(
            &mut self.world,
            &mut self.players,
            &mut self.vehicles,
            self.spawn,
            self.tick as f64 / TICK_RATE as f64,
        );
        let terrain = &self.terrain;
        self.craft.step(
            1.0 / TICK_RATE as f32,
            &|x, z| terrain_at(terrain, x, z).max(WATER_LEVEL),
            &|x, z| terrain_at(terrain, x, z),
        );
        self.world.step();
        self.carry_riders();
        // Keep bodies on terrain when a vehicle starts inside a baked mesh seam.
        // Rapier's vehicle ray casts can miss a triangle at spawn; recover before
        // the next snapshot instead of letting a parked car fall through the city.
        let vehicle_rows = rows(&self.world, &self.world.states()).0.to_vec();
        for row in vehicle_rows {
            let ground = self.ground_height(row[1], row[3]);
            let in_world = row[1].abs() <= LIMIT - TERRAIN_STEP as f32
                && row[3].abs() <= LIMIT - TERRAIN_STEP as f32;
            let fallen = !row[2].is_finite() || row[2] < -2.0;
            if (in_world && ground > 0.0 && row[2] < ground - 0.5) || fallen || !in_world {
                let (x, z, ground) = if in_world && ground > 0.0 {
                    (row[1], row[3], ground)
                } else {
                    (
                        self.spawn[0],
                        self.spawn[2],
                        self.ground_height(self.spawn[0], self.spawn[2]),
                    )
                };
                self.world.set_vehicle_position(
                    row[0] as u32,
                    [x, ground + 1.0, z],
                    euler([row[4], row[5], row[6], row[7]]).0,
                );
            }
        }
        let terrain = &self.terrain;
        let flood = self.vehicles.update(
            &self.world,
            &|x, z| WATER_LEVEL - terrain_at(terrain, x, z),
            1.0 / TICK_RATE as f32,
        );
        self.events.extend(flood);
        self.destruction.step(&mut self.world, self.tick);
        self.tick += 1;
        let entities = self.entities();
        if self.history.len() == HISTORY {
            self.history.pop_front();
        }
        self.history.push_back((self.tick, entities));
        if self.tick.is_multiple_of(SNAPSHOT_EVERY) || std::mem::take(&mut self.urgent) {
            self.broadcast();
        }
    }

    /// Seated players' characters follow their craft; parachutists sink slowly.
    fn carry_riders(&mut self) {
        for (player, at) in self.craft.rider_positions() {
            if let Some(Ok(body)) = self.players.get(&player).map(|p| p.body) {
                self.world.set_character_position(body, at);
                self.world.set_vertical(body, 0.0);
            }
        }
        let s = self.world.states();
        let (_, chars) = rows(&self.world, &s);
        for player in self.craft.chutes() {
            let Some(Ok(body)) = self.players.get(&player).map(|p| p.body) else {
                self.craft.close_parachute(player);
                continue;
            };
            let Some(r) = chars.iter().find(|r| r[0] as u32 == body) else {
                continue;
            };
            if r[5] != 0.0 {
                self.craft.close_parachute(player);
            } else if r[4] < -PARACHUTE_FALL {
                self.world.set_vertical(body, -PARACHUTE_FALL);
            }
        }
    }

    fn apply_input(&mut self, id: u32) {
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        // Late frames are dropped: the tick they described has already been simulated.
        p.inputs = p.inputs.split_off(&tick);
        if let Some(c) = p.inputs.remove(&tick) {
            p.held = c;
        }
        // The state sent after this tick includes it whether an input arrived or the held
        // controls ran, so ack it either way. Acking only real inputs made the client replay
        // one tick too many after every held tick and one too few on the next snapshot: a
        // +-1.2 m seesaw at 18 m/s.
        p.applied = Some(tick);
        let c = p.held.clone();
        self.combat.control(id, &c, p.character.as_ref());
        match p.body {
            Ok(body) if self.craft.is_rider(id) => {
                self.craft.control(id, &c);
                self.world.set_move(body, Move::default());
                if c.interact {
                    let terrain = &self.terrain;
                    if let Some(exit) = self
                        .craft
                        .leave(id, &|x, z| terrain_at(terrain, x, z).max(WATER_LEVEL))
                    {
                        self.world.set_character_position(body, exit.position);
                        if exit.parachute {
                            self.craft.open_parachute(id);
                        }
                    }
                }
            }
            Ok(body) => {
                let speed = walk_speed(&c, p.character.as_ref());
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
                    && let Some(car) = self.vehicles.enter(&self.world, body, id)
                {
                    self.world.remove_character(body);
                    self.players.get_mut(&id).unwrap().body = Err(car);
                } else if c.interact {
                    let s = self.world.states();
                    if let Some(r) = rows(&self.world, &s).1.iter().find(|r| r[0] as u32 == body) {
                        self.craft.enter(id, [r[1], r[2], r[3]]);
                    }
                }
            }
            Err(car) => {
                self.vehicles.drive(
                    &mut self.world,
                    car,
                    id,
                    Drive {
                        throttle: c.y(),
                        steer: c.x(),
                        brake: c.brake,
                        service_brake: 0.0,
                        occupied: true,
                    },
                );
                if let Some(e) = self.vehicles.horn(&self.world, car, id, c.attack) {
                    self.events.push(e);
                }
                if c.interact {
                    let pos = self.vehicles.leave(&mut self.world, car, id);
                    let body = self.world.spawn_character(pos);
                    self.players.get_mut(&id).unwrap().body = Ok(body);
                }
            }
        }
        // Edge actions fire once per frame, never while the frame is held.
        let held = &mut self.players.get_mut(&id).unwrap().held;
        self.urgent |= held.interact || held.jetpack || held.drop;
        (
            held.interact,
            held.drop,
            held.reload,
            held.jetpack,
            held.equip,
        ) = (false, false, false, false, None);
    }

    fn entities(&self) -> HashMap<u32, Entity> {
        let s = self.world.states();
        let (cars, chars) = rows(&self.world, &s);
        let mut out = HashMap::new();
        self.vehicles.entities(&self.world, self.day, &mut out);
        self.craft.entities(&mut out);
        for (car, entity) in self.vehicles.pairs() {
            if let Some(e) = out.get_mut(&entity) {
                self.combat.car_fields(car, e);
            }
        }
        let car_rows: HashMap<u32, _> = cars.iter().map(|r| (r[0] as u32, r)).collect();
        let chars: HashMap<u32, _> = chars.iter().map(|r| (r[0] as u32, r)).collect();
        self.traffic.entities(&self.world, &car_rows, &mut out);
        self.citizens.entities(&chars, &mut out);
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
                vx: p.held.x() * walk_speed(&p.held, p.character.as_ref()),
                vy: 0.0,
                vz: p.held.y() * walk_speed(&p.held, p.character.as_ref()),
                color: p.color.clone(),
                health: 100.0,
                name: Some(p.name.clone()),
                character: p.character.clone(),
                model: None,
                seats: None,
                driver: None,
                ..Default::default()
            };
            match p.body {
                Ok(body) => {
                    if let Some(r) = chars.get(&body) {
                        (e.x, e.y, e.z, e.vy) = (r[1], r[2] - CHARACTER_FEET, r[3], r[4]);
                    }
                    self.craft.decorate(id, &mut e);
                    self.craft.decorate_chute(id, &mut e);
                }
                Err(car) => {
                    let r = car_rows[&car];
                    (e.angle, e.pitch, e.roll) = euler([r[4], r[5], r[6], r[7]]);
                    (e.x, e.y, e.z) = (r[1], vehicle_contact_y(r[2], e.pitch, e.roll), r[3]);
                    (e.vx, e.vy, e.vz) = (r[8], r[9], r[10]);
                    if let Some((vehicle, seat)) = self.vehicles.rider(car, id) {
                        e.vehicle = Some(vehicle.to_string());
                        e.seat = Some(seat);
                    }
                }
            }
            self.combat.player_fields(id, &mut e);
            out.insert(id, e);
        }
        out
    }

    /// Raw physics row of the body a player controls, for client restore-and-replay.
    fn you(&self, p: &Player) -> Option<Vec<f32>> {
        let s = self.world.states();
        let (cars, chars) = rows(&self.world, &s);
        let snap = self.world.snapshot();
        // `snapshot()` lays out SNAPSHOT_VEHICLE floats per vehicle then 5 per character, in `states()` order.
        let (at, len) = match p.body {
            Ok(body) => (
                cars.len() * SNAPSHOT_VEHICLE
                    + 5 * chars.iter().position(|r| r[0] as u32 == body)?,
                5,
            ),
            Err(car) => (
                SNAPSHOT_VEHICLE * cars.iter().position(|r| r[0] as u32 == car)?,
                SNAPSHOT_VEHICLE,
            ),
        };
        Some(snap[at..at + len].to_vec())
    }

    /// Tells everyone who is in the city; sent whenever someone joins or leaves.
    fn send_roster(&self) {
        let players: Vec<PlayerSummary> = self
            .players
            .iter()
            .map(|(id, p)| PlayerSummary {
                id: id.to_string(),
                name: p.name.clone(),
                color: p.color.clone(),
            })
            .collect();
        let bytes = encode(&ServerMessage::Roster { players });
        for p in self.players.values() {
            let _ = p.out.send(bytes.clone());
        }
    }

    fn broadcast(&mut self) {
        let mut events = std::mem::take(&mut self.events);
        events.append(&mut self.destruction.events);
        events.append(&mut self.combat.take_events());
        let (tick, current) = self.history.back().unwrap();
        // Where everyone is, whatever the interest radius: the island map draws from it.
        let positions = (*tick % 16 == 0).then(|| {
            encode(&ServerMessage::Positions {
                players: self
                    .players
                    .keys()
                    .filter_map(|id| current.get(id).map(|e| (id, e)))
                    .map(|(id, e)| PlayerPosition {
                        id: id.to_string(),
                        x: e.x,
                        z: e.z,
                        angle: e.angle,
                    })
                    .collect(),
            })
        });
        for (id, p) in &self.players {
            if let Some(bytes) = &positions {
                let _ = p.out.send(bytes.clone());
            }
            let broken = self.destruction.broken_for(*id, *tick);
            let me = current.get(id).map_or([0.0, 0.0], |e| [e.x, e.z]);
            let events = events
                .iter()
                .filter(|e| (e.x - me[0]).hypot(e.z - me[1]) < INTEREST_RADIUS)
                .cloned()
                .collect();
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
                // shortcut: no day cycle yet; `day` holds until the clock lands.
                day: self.day,
                day_rate: self.day_rate,
                events,
                pickups: self.combat.pickups_near(me[0], me[1]),
                grenades: self.combat.grenades_near(me[0], me[1]),
                debris: self.destruction.states.clone(),
                broken,
            }));
        }
    }
}

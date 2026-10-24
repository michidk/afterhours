//! Test worlds for the real server: boots the actual city and game loop in-process, joins
//! players, steps the simulation tick by tick and decodes the snapshots clients would get.
//! No sockets, no wall-clock time, fully deterministic.
//!
//! `Lab` is the Rust API (integration tests); `Lab::exec` is the same thing as JSON commands,
//! which `bin/scene-lab.rs` serves over stdin/stdout so a script or an AI agent can drive a scene
//! without a browser. See `docs/lab.md`.
use crate::{City, Event, Game, city, destruction};
use afterhours_protocol::{ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, decode};
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

pub struct Lab {
    pub game: Game,
    inbox: HashMap<u32, UnboundedReceiver<Vec<u8>>>,
    /// Latest full entity table per client.
    pub seen: HashMap<u32, HashMap<String, Entity>>,
    pub tick: u32,
    /// First racetrack grid slot (x, z): open tarmac to drive on.
    pub grid: (f32, f32),
    /// Racetrack centreline, one point every couple of metres, closed.
    pub path: Vec<(f32, f32)>,
}

impl Lab {
    /// Boots the city at `city_path` exactly like `main.rs`: same world, parked fleet, props.
    pub fn boot(city_path: &str) -> Self {
        let loaded = City::load(city_path).expect("city file");
        let world = city::world(&loaded);
        let at = loaded.spawn();
        let spawn = [at[0], loaded.height(at[0], at[1]) + 1.0, at[1]];
        let mut game = Game::new(world, spawn);
        game.set_city(&loaded);
        game.stock(&loaded).expect("city fleet");
        if std::env::var("SCENE_NO_PROPS").is_err() {
            game.add_props(destruction::destructibles(&loaded));
        }
        let slot = &loaded.racetrack["grid"][0];
        let grid = (
            slot["x"].as_f64().unwrap() as f32,
            slot["z"].as_f64().unwrap() as f32,
        );
        let path = loaded.racetrack["path"]
            .as_array()
            .unwrap()
            .chunks(2)
            .map(|p| (p[0].as_f64().unwrap() as f32, p[1].as_f64().unwrap() as f32))
            .collect();
        Self {
            game,
            inbox: HashMap::new(),
            seen: HashMap::new(),
            tick: 0,
            grid,
            path,
        }
    }

    pub fn join(&mut self, id: u32) {
        let (tx, rx) = unbounded_channel();
        self.game.handle(Event::Connect(id, tx));
        self.game.handle(Event::Message(
            id,
            ClientMessage::Join {
                version: VERSION,
                name: format!("p{id}"),
                color: "#ff0000".into(),
                character: None,
            },
        ));
        self.inbox.insert(id, rx);
        self.seen.insert(id, HashMap::new());
    }

    pub fn debug(&mut self, id: u32, command: serde_json::Value) {
        self.game.handle(Event::Message(
            id,
            ClientMessage::DebugCommand {
                request_id: self.tick,
                command,
            },
        ));
    }

    pub fn input(&mut self, id: u32, controls: Controls) {
        let tick = self.tick;
        // Land the frame on the next simulated tick, as a client with lead 1 would.
        self.game.handle(Event::Message(
            id,
            ClientMessage::Input {
                tick: tick + 1,
                ack: None,
                controls,
            },
        ));
    }

    /// One tick, then fold every snapshot the clients were sent into `seen`.
    pub fn step(&mut self) {
        self.game.step();
        self.tick += 1;
        for (id, rx) in &mut self.inbox {
            while let Ok(bytes) = rx.try_recv() {
                if let Ok(ServerMessage::State {
                    base: None,
                    entities,
                    ..
                }) = decode(&bytes)
                {
                    let table = self.seen.get_mut(id).unwrap();
                    table.clear();
                    for e in entities {
                        table.insert(e.id.clone(), e);
                    }
                }
            }
        }
    }

    /// Debug-teleport client `id` next to the racetrack grid and let it settle.
    pub fn go_to_track(&mut self, id: u32) {
        let (x, z) = self.grid;
        self.debug(
            id,
            serde_json::json!({ "kind": "teleport", "x": x + 3.0, "z": z }),
        );
        for _ in 0..10 {
            self.step();
        }
    }

    pub fn me(&self, id: u32) -> Entity {
        self.seen[&id][&id.to_string()].clone()
    }

    /// Walk client `id` to the nearest parked car and climb in; returns the car's id.
    pub fn board(&mut self, id: u32) -> String {
        self.try_board(id).expect("boarded a car")
    }

    /// [`Lab::board`] that reports failure (no car nearby, or never got in) instead of panicking.
    pub fn try_board(&mut self, id: u32) -> Option<String> {
        for i in 0..600 {
            let me = self.me(id);
            if let Some(car) = me.vehicle.clone() {
                return Some(car);
            }
            let target = self
                .cars(id)
                .into_iter()
                .filter(|c| c.ai != Some(true))
                .min_by(|a, b| {
                    (a.x - me.x)
                        .hypot(a.z - me.z)
                        .total_cmp(&(b.x - me.x).hypot(b.z - me.z))
                })?;
            let (dx, dz) = (target.x - me.x, target.z - me.z);
            let d = dx.hypot(dz).max(0.01);
            self.input(
                id,
                Controls {
                    move_x: Some(dx / d),
                    move_y: Some(dz / d),
                    interact: d < 3.0 && i % 8 == 0,
                    ..Default::default()
                },
            );
            self.step();
        }
        None
    }

    pub fn cars(&self, id: u32) -> Vec<Entity> {
        let mut v: Vec<_> = self.seen[&id]
            .values()
            .filter(|e| e.kind == Kind::Car)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }
}

/// Pure-pursuit driver: aim at the centreline point `ahead` metres past the nearest one,
/// holding `cruise` m/s.
pub fn pursue(path: &[(f32, f32)], car: &Entity, ahead: f32, cruise: f32) -> Controls {
    let near = (0..path.len())
        .min_by(|&a, &b| {
            let d = |i: usize| (path[i].0 - car.x).hypot(path[i].1 - car.z);
            d(a).total_cmp(&d(b))
        })
        .unwrap();
    let mut i = near;
    let mut run = 0.0;
    while run < ahead {
        let next = (i + 1) % path.len();
        run += (path[next].0 - path[i].0).hypot(path[next].1 - path[i].1);
        i = next;
    }
    let want = (path[i].0 - car.x).atan2(path[i].1 - car.z);
    let err = (want - car.angle).sin().atan2((want - car.angle).cos());
    let speed = car.vx.hypot(car.vz);
    // Like a human, slow for the corner: up to half the speed off when the target is 1 rad away.
    let cruise = cruise * (1.0 - 0.5 * err.abs().min(1.0));
    Controls {
        move_x: Some((err * 1.5).clamp(-1.0, 1.0)),
        move_y: Some(if speed < cruise { 1.0 } else { 0.0 }),
        brake: speed > cruise + 1.0,
        ..Default::default()
    }
}

pub fn off_centre(path: &[(f32, f32)], x: f32, z: f32) -> f32 {
    path.iter()
        .map(|p| (p.0 - x).hypot(p.1 - z))
        .fold(f32::MAX, f32::min)
}

/// What `exec` understands: (command, arguments, what it does).
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("help", "", "list the commands"),
    (
        "track",
        "",
        "teleport beside the racetrack grid: open tarmac to drive on",
    ),
    ("teleport", "x, z", "teleport to a spot on the map"),
    (
        "spawn",
        "model (sedan|sport|van)",
        "debug-spawn a car near the player",
    ),
    ("board", "", "walk to the nearest parked car and get in"),
    ("leave", "", "press interact to get out"),
    (
        "drive",
        "ticks, throttle -1..1, steer -1..1, brake, every",
        "hold these controls for `ticks` ticks (30 per second); returns the car's (or on foot the walker's) trace and metrics",
    ),
    (
        "follow",
        "ticks, speed, every",
        "let a pure-pursuit bot drive the racetrack at `speed` m/s",
    ),
    ("idle", "ticks", "let the world run with no input"),
    (
        "state",
        "radius",
        "the player plus every entity within `radius` metres (default 40)",
    ),
    (
        "debug",
        "command",
        "send a raw debug command (see shared/debug.ts)",
    ),
];

impl Lab {
    /// The car the player sits in, if any.
    fn driven(&self) -> Option<Entity> {
        let car = self.me(1).vehicle?;
        self.seen[&1].get(&car).cloned()
    }

    fn sample(&self, car: &Entity) -> Value {
        let (sn, cs) = car.angle.sin_cos();
        let r = |v: f32| (f64::from(v) * 1000.0).round() / 1000.0;
        json!({
            "tick": self.tick, "x": r(car.x), "y": r(car.y), "z": r(car.z),
            "yaw": r(car.angle), "pitch": r(car.pitch), "roll": r(car.roll),
            "speed": r(car.vx.hypot(car.vz)),
            "forward": r(car.vx * sn + car.vz * cs), "lateral": r(car.vx * cs - car.vz * sn),
            "vy": r(car.vy),
        })
    }

    /// Holds `controls` for `ticks` ticks on foot; returns the walker's trace and how far and
    /// how fast it got (`longest_step` is the biggest move in one tick).
    fn walk_ticks(&mut self, ticks: u32, every: u32, controls: Controls) -> Value {
        let (start, mut trace, mut longest) = (self.me(1), Vec::new(), 0.0f32);
        let mut last = start.clone();
        for i in 0..ticks {
            self.input(1, controls.clone());
            self.step();
            let now = self.me(1);
            longest = longest.max((now.x - last.x).hypot(now.z - last.z));
            last = now.clone();
            if i % every.max(1) == 0 {
                trace.push(self.sample(&now));
            }
        }
        let end = self.me(1);
        json!({"ok": true, "on_foot": true, "metrics": {
            "displacement": (end.x - start.x).hypot(end.z - start.z),
            "mean_speed": (end.x - start.x).hypot(end.z - start.z) / (ticks as f32 / 30.0),
            "longest_step": longest,
        }, "trace": trace})
    }

    /// Runs `ticks` ticks feeding `controls(self)` each tick; returns the driven car's trace
    /// (every `every`-th tick) and summary metrics, or the world state when on foot.
    fn run_ticks(
        &mut self,
        ticks: u32,
        every: u32,
        mut controls: impl FnMut(&Lab, &Entity) -> Controls,
    ) -> Value {
        let (mut trace, mut top, mut tilt, mut hop, mut ceiling) =
            (Vec::new(), 0.0f32, 0.0f32, 0.0f32, f32::MIN);
        let start = self.driven();
        for i in 0..ticks {
            let c = match self.driven() {
                Some(car) => controls(self, &car),
                None => Controls::default(),
            };
            self.input(1, c);
            self.step();
            if let Some(car) = self.driven() {
                top = top.max(car.vx.hypot(car.vz));
                tilt = tilt.max(car.pitch.abs()).max(car.roll.abs());
                hop = hop.max(car.vy.abs());
                ceiling = ceiling.max(car.y);
                if i % every.max(1) == 0 {
                    trace.push(self.sample(&car));
                }
            }
        }
        let Some(end) = self.driven() else {
            return json!({"ok": true, "note": "the player is on foot", "me": self.sample(&self.me(1))});
        };
        let moved = start.map_or(0.0, |s| (end.x - s.x).hypot(end.z - s.z));
        json!({"ok": true, "metrics": {
            "top_speed": top, "final_speed": end.vx.hypot(end.vz), "max_tilt": tilt,
            "max_hop": hop, "max_height": ceiling, "displacement": moved,
        }, "trace": trace})
    }

    /// One JSON command in, one JSON reply out. Player 1 is created on first use.
    pub fn exec(&mut self, command: &Value) -> Value {
        if !self.seen.contains_key(&1) {
            self.join(1);
            for _ in 0..4 {
                self.step();
            }
        }
        let f = |k: &str, d: f64| command.get(k).and_then(Value::as_f64).unwrap_or(d) as f32;
        let u = |k: &str, d: u32| command.get(k).and_then(Value::as_u64).unwrap_or(d as u64) as u32;
        let name = command.get("cmd").and_then(Value::as_str).unwrap_or("");
        match name {
            "help" => json!({"ok": true, "commands": COMMANDS.iter()
                .map(|(c, a, d)| json!({"cmd": c, "args": a, "about": d})).collect::<Vec<_>>()}),
            "track" => {
                self.go_to_track(1);
                json!({"ok": true, "me": self.sample(&self.me(1))})
            }
            "teleport" => {
                self.debug(
                    1,
                    json!({"kind": "teleport", "x": f("x", 0.0), "z": f("z", 0.0)}),
                );
                for _ in 0..10 {
                    self.step();
                }
                json!({"ok": true, "me": self.sample(&self.me(1))})
            }
            "spawn" => {
                let Some(model) = command.get("model").and_then(Value::as_str) else {
                    return json!({"ok": false, "error": "spawn needs a model"});
                };
                self.debug(1, json!({"kind": "spawn", "model": model}));
                for _ in 0..30 {
                    self.step();
                }
                json!({"ok": true, "cars_nearby": self.cars(1).len()})
            }
            "board" => match self.try_board(1) {
                Some(car) => {
                    json!({"ok": true, "vehicle": car, "car": self.driven().map(|c| self.sample(&c))})
                }
                None => {
                    json!({"ok": false, "error": "no parked car within reach; try spawn or track"})
                }
            },
            "leave" => {
                self.input(
                    1,
                    Controls {
                        interact: true,
                        ..Default::default()
                    },
                );
                self.step();
                for _ in 0..5 {
                    self.step();
                }
                json!({"ok": true, "on_foot": self.me(1).vehicle.is_none()})
            }
            "drive" => {
                let c = Controls {
                    move_y: Some(f("throttle", 0.0).clamp(-1.0, 1.0)),
                    move_x: Some(f("steer", 0.0).clamp(-1.0, 1.0)),
                    brake: command
                        .get("brake")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    up: f("throttle", 0.0) > 0.0,
                    sprint: command
                        .get("sprint")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    ..Default::default()
                };
                if self.driven().is_none() {
                    return self.walk_ticks(u("ticks", 30), u("every", 5), c);
                }
                self.run_ticks(u("ticks", 30), u("every", 5), |_, _| c.clone())
            }
            "follow" => {
                let (path, speed) = (self.path.clone(), f("speed", 12.0));
                self.run_ticks(u("ticks", 150), u("every", 10), move |_, car| {
                    pursue(&path, car, 8.0, speed)
                })
            }
            "idle" => self.run_ticks(u("ticks", 30), u("every", 5), |_, _| Controls::default()),
            "state" => {
                let (me, radius) = (self.me(1), f("radius", 40.0));
                let near: Vec<Value> = self.seen[&1]
                    .values()
                    .filter(|e| e.id != "1" && (e.x - me.x).hypot(e.z - me.z) < radius)
                    .map(|e| json!({"id": e.id, "kind": e.kind, "model": e.model, "x": e.x, "y": e.y, "z": e.z, "angle": e.angle, "speed": e.vx.hypot(e.vz), "driver": e.driver, "ai": e.ai}))
                    .collect();
                json!({"ok": true, "tick": self.tick, "me": self.sample(&me), "vehicle": me.vehicle, "nearby": near})
            }
            "debug" => {
                let Some(cmd) = command.get("command") else {
                    return json!({"ok": false, "error": "debug needs a command object"});
                };
                self.debug(1, cmd.clone());
                for _ in 0..4 {
                    self.step();
                }
                json!({"ok": true, "me": self.sample(&self.me(1))})
            }
            other => {
                json!({"ok": false, "error": format!("unknown command {other:?}; send {{\"cmd\":\"help\"}}")})
            }
        }
    }
}

//! Test worlds for every aircraft and watercraft model, on the real city: walk up, board,
//! apply the controls its pilot would, and check it does what its class should.
use afterhours_protocol::{ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, decode};
use afterhours_server::{City, Event, Game, city};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

struct World {
    game: Game,
    rx: UnboundedReceiver<Vec<u8>>,
    seen: Vec<Entity>,
    tick: u32,
}

impl World {
    fn boot() -> Self {
        let loaded = City::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/city.json"))
            .expect("data/city.json");
        let at = loaded.spawn();
        let mut game = Game::new(
            city::world(&loaded),
            [at[0], loaded.height(at[0], at[1]) + 1.0, at[1]],
        );
        game.set_city(&loaded);
        game.park(&loaded);
        let (tx, rx) = unbounded_channel();
        game.handle(Event::Connect(1, tx));
        game.handle(Event::Message(
            1,
            ClientMessage::Join {
                version: VERSION,
                name: "p".into(),
                color: "#fff".into(),
                character: None,
            },
        ));
        let mut w = Self {
            game,
            rx,
            seen: Vec::new(),
            tick: 0,
        };
        w.step(Controls::default());
        w
    }

    fn step(&mut self, controls: Controls) {
        self.tick += 1;
        self.game.handle(Event::Message(
            1,
            ClientMessage::Input {
                tick: self.tick,
                ack: None,
                controls,
            },
        ));
        self.game.step();
        while let Ok(bytes) = self.rx.try_recv() {
            if let Ok(ServerMessage::State {
                base: None,
                entities,
                ..
            }) = decode(&bytes)
            {
                self.seen = entities;
            }
        }
    }

    fn get(&self, id: &str) -> &Entity {
        self.seen.iter().find(|e| e.id == id).unwrap()
    }

    /// Teleports beside a parked craft so it falls inside the snapshot radius.
    fn go_to(&mut self, model: &str) {
        let (_, x, z) = *self
            .game
            .craft_spots()
            .iter()
            .find(|s| s.0 == model)
            .unwrap_or_else(|| panic!("no parked {model}"));
        self.game.handle(Event::Message(
            1,
            ClientMessage::DebugCommand {
                request_id: self.tick,
                command: serde_json::json!({"kind": "teleport", "x": x + 1.5, "z": z}),
            },
        ));
        for _ in 0..10 {
            self.step(Controls::default());
        }
    }

    /// The craft of this model nearest the player (a city can park several).
    fn craft(&self, model: &str) -> Entity {
        let me = self.get("1");
        self.seen
            .iter()
            .filter(|e| e.model.as_deref() == Some(model))
            .min_by(|a, b| {
                (a.x - me.x)
                    .hypot(a.z - me.z)
                    .total_cmp(&(b.x - me.x).hypot(b.z - me.z))
            })
            .unwrap_or_else(|| panic!("no parked {model}"))
            .clone()
    }

    /// Go to the craft and press interact until seated.
    fn board(&mut self, model: &str) -> String {
        self.go_to(model);
        for i in 0..40 {
            let near = self.get("1").clone();
            let c = self.craft(model);
            if near.vehicle.as_deref() == Some(c.id.as_str()) {
                return c.id;
            }
            self.step(Controls {
                interact: i % 4 == 3,
                ..Default::default()
            });
        }
        panic!("could not board {model}");
    }
}

fn drive(model: &str, controls: Controls, ticks: u32) -> (Entity, Entity) {
    let mut w = World::boot();
    w.board(model);
    for _ in 0..4 {
        w.step(Controls::default());
    }
    let before = w.craft(model);
    for _ in 0..ticks {
        w.step(controls.clone());
    }
    (before, w.craft(model))
}

fn travelled(a: &Entity, b: &Entity) -> f32 {
    (b.x - a.x).hypot(b.z - a.z)
}

#[test]
fn every_boat_powers_away_from_its_berth_and_stays_afloat() {
    for model in ["boat", "launch", "jetski", "racer", "speedboat", "offshore"] {
        let (a, b) = drive(
            model,
            Controls {
                up: true,
                ..Default::default()
            },
            150,
        );
        assert!(
            matches!(b.kind, Kind::Boat | Kind::Jetski | Kind::Speedboat),
            "{model} is {:?}",
            b.kind
        );
        assert!(
            travelled(&a, &b) > 8.0,
            "{model} moved {}",
            travelled(&a, &b)
        );
        assert!((b.y - a.y).abs() < 1.5, "{model} bobbed {} -> {}", a.y, b.y);
    }
}

#[test]
fn both_helicopters_lift_off_and_hold_a_height() {
    for model in ["scout", "utility"] {
        let (a, b) = drive(
            model,
            Controls {
                ascend: true,
                ..Default::default()
            },
            120,
        );
        assert_eq!(b.kind, Kind::Helicopter, "{model}");
        assert!(b.y > a.y + 4.0, "{model} climbed {} -> {}", a.y, b.y);
        assert!(b.y < a.y + 200.0, "{model} runaway climb {}", b.y);
    }
}

#[test]
fn both_planes_take_off_from_the_airfield() {
    for model in ["plane", "aerobatic"] {
        let (a, b) = drive(
            model,
            Controls {
                up: true,
                ascend: true,
                ..Default::default()
            },
            450,
        );
        assert_eq!(b.kind, Kind::Plane, "{model}");
        assert!(b.y > a.y + 5.0, "{model} airborne {} -> {}", a.y, b.y);
        assert!(
            travelled(&a, &b) > 40.0,
            "{model} rolled {}",
            travelled(&a, &b)
        );
    }
}

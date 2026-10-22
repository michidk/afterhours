//! Boarding a helicopter, climbing, the day clock, a parachute exit and a flooded car.
use afterhours_protocol::{ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, decode};
use afterhours_server::{City, Event, Game, World};
use std::collections::HashMap;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

fn city() -> City {
    serde_json::from_value(serde_json::json!({
        "seed": 1, "airport": {"x": 300, "z": 300, "w": 200, "d": 200}, "airports": null,
        "centre": {"x": 0, "z": 0}, "ramps": null, "racetrack": null, "landmarks": null,
        "townHall": null, "buildings": [], "parks": [], "roads": [],
    }))
    .unwrap()
}

struct Client {
    game: Game,
    rx: UnboundedReceiver<Vec<u8>>,
    seen: HashMap<String, Entity>,
    day: f32,
    tick: u32,
}

impl Client {
    fn new() -> Self {
        let mut world = World::new();
        world.add_box([0.0, -0.5, 0.0], [800.0, 0.5, 800.0], 0.0);
        let mut game = Game::new(world, [0.0, 1.0, 30.0]);
        game.park(&city());
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
        Self {
            game,
            rx,
            seen: HashMap::new(),
            day: 0.0,
            tick: 0,
        }
    }

    fn step(&mut self, controls: Controls) {
        let tick = self.tick;
        self.game.handle(Event::Message(
            1,
            ClientMessage::Input {
                tick: tick + 1,
                ack: None,
                controls,
            },
        ));
        self.game.step();
        self.tick += 1;
        while let Ok(bytes) = self.rx.try_recv() {
            if let Ok(ServerMessage::State {
                base: None,
                entities,
                day,
                ..
            }) = decode(&bytes)
            {
                self.seen = entities.into_iter().map(|e| (e.id.clone(), e)).collect();
                self.day = day;
            }
        }
    }

    fn me(&self) -> &Entity {
        &self.seen["1"]
    }

    fn craft(&self, model: &str) -> &Entity {
        self.seen
            .values()
            .find(|e| e.model.as_deref() == Some(model))
            .unwrap()
    }
}

#[test]
fn a_pilot_climbs_bails_out_and_lands_on_a_parachute() {
    let mut c = Client::new();
    for _ in 0..4 {
        c.step(Controls::default());
    }
    let day0 = c.day;
    // Walk to the scout helicopter parked 36 m from the centre and board it.
    for i in 0..400 {
        let heli = c.craft("scout").clone();
        let me = c.me().clone();
        if me.vehicle.is_some() {
            break;
        }
        let (dx, dz) = (heli.x - me.x, heli.z - me.z);
        let d = dx.hypot(dz).max(0.01);
        let near = d < 3.0;
        c.step(Controls {
            move_x: Some(dx / d),
            move_y: Some(dz / d),
            interact: near && i % 8 == 0,
            ..Default::default()
        });
    }
    let heli_id = c.craft("scout").id.clone();
    assert_eq!(
        c.me().vehicle.as_deref(),
        Some(heli_id.as_str()),
        "boarded the helicopter"
    );
    assert_eq!(c.craft("scout").driver.as_deref(), Some("1"));
    let y0 = c.craft("scout").y;
    for _ in 0..90 {
        c.step(Controls {
            ascend: true,
            ..Default::default()
        });
    }
    let high = c.craft("scout").y;
    assert!(high > y0 + 3.0, "climbed {high} from {y0}");
    assert!((c.me().y - high).abs() < 3.0, "the pilot rides along");
    assert!(c.day > day0, "the day clock advances ({day0} -> {})", c.day);
    // Bail out: the pilot is released with a parachute and the helicopter falls.
    c.step(Controls {
        interact: true,
        ..Default::default()
    });
    c.step(Controls::default());
    assert!(c.me().vehicle.is_none());
    assert_eq!(c.me().parachute, Some(true));
    assert_eq!(
        c.craft("scout").flight,
        Some(afterhours_protocol::Flight::Falling)
    );
    let mut slowest = 0.0f32;
    for _ in 0..600 {
        c.step(Controls::default());
        slowest = slowest.min(c.me().vy);
    }
    assert!(c.me().y < 3.0, "the pilot landed, y={}", c.me().y);
    assert!(
        slowest > -5.5,
        "the parachute limited the fall to {slowest}"
    );
    assert_eq!(c.me().parachute, None);
    assert_eq!(c.craft("scout").kind, Kind::Helicopter);
}

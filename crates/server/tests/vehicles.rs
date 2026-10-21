//! Ann walks to a parked car, drives it and honks; Bob rides along and gets out.
use afterhours_protocol::{
    ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, decode, encode,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut world = afterhours_server::World::new();
    world.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
    let game = afterhours_server::Game::new(world, [0.0, 1.0, 0.0]);
    let app = afterhours_server::router(game, None, "dist".into());
    tokio::spawn(afterhours_server::serve(listener, app));
    format!("ws://{addr}/ws")
}

async fn join(url: &str, name: &str) -> (Socket, String) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    send(
        &mut ws,
        &ClientMessage::Join {
            version: VERSION,
            name: name.into(),
            color: "#ff0000".into(),
            character: None,
        },
    )
    .await;
    match recv(&mut ws).await {
        ServerMessage::Welcome { id, .. } => (ws, id),
        other => panic!("expected welcome, got {other:?}"),
    }
}

async fn send(ws: &mut Socket, m: &ClientMessage) {
    ws.send(Message::Binary(encode(m).into())).await.unwrap();
}

async fn recv(ws: &mut Socket) -> ServerMessage {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Binary(b) = msg {
            return decode(&b).unwrap();
        }
    }
}

/// A client's view of the world, plus every event it was sent.
struct Client {
    ws: Socket,
    id: String,
    entities: HashMap<String, Entity>,
    events: Vec<String>,
}

impl Client {
    async fn join(url: &str, name: &str) -> Self {
        let (ws, id) = join(url, name).await;
        Self {
            ws,
            id,
            entities: HashMap::new(),
            events: Vec::new(),
        }
    }

    fn me(&self) -> &Entity {
        &self.entities[&self.id]
    }

    /// Folds a snapshot into the view; returns its tick.
    fn apply(&mut self, m: &ServerMessage) -> Option<u32> {
        let ServerMessage::State {
            tick,
            base,
            entities,
            removed,
            events,
            ..
        } = m
        else {
            return None;
        };
        if base.is_none() {
            self.entities.clear();
        }
        for id in removed {
            self.entities.remove(id);
        }
        for e in entities {
            self.entities.insert(e.id.clone(), e.clone());
        }
        self.events.extend(events.iter().map(|e| e.kind.clone()));
        Some(*tick)
    }

    /// Reads every queued snapshot, so inputs are stamped against the live tick. Queued
    /// frames arrive at once; live ones are 66 ms apart, so a short silence means caught up.
    async fn catch_up(&mut self) {
        while let Ok(Some(Ok(Message::Binary(b)))) =
            tokio::time::timeout(Duration::from_millis(10), self.ws.next()).await
        {
            self.apply(&decode(&b).unwrap());
        }
    }

    /// Takes one snapshot and answers it with `controls` for the next few ticks.
    async fn frame(&mut self, controls: impl Fn(&Entity) -> Controls) {
        let m = recv(&mut self.ws).await;
        let Some(tick) = self.apply(&m) else {
            return;
        };
        let c = controls(self.me());
        for t in tick + 1..tick + 4 {
            send(
                &mut self.ws,
                &ClientMessage::Input {
                    tick: t,
                    ack: Some(tick),
                    // Interact is an edge action: press it on one tick only.
                    controls: Controls {
                        interact: c.interact && t == tick + 1,
                        ..c.clone()
                    },
                },
            )
            .await;
        }
    }

    /// Walks towards the car and presses interact when close, until seated.
    async fn board(&mut self, car: &str) {
        for i in 0..400 {
            if self.me().vehicle.is_some() {
                return;
            }
            let (cx, cz) = (self.entities[car].x, self.entities[car].z);
            self.frame(|me| {
                let (dx, dz) = (cx - me.x, cz - me.z);
                let d = dx.hypot(dz).max(0.01);
                Controls {
                    move_x: Some(dx / d),
                    move_y: Some(dz / d),
                    interact: d < 4.0 && i % 10 == 0,
                    ..Default::default()
                }
            })
            .await;
        }
        panic!("{} never boarded", self.id);
    }

    async fn idle(&mut self, frames: usize) {
        for _ in 0..frames {
            self.frame(|_| Controls::default()).await;
        }
    }
}

#[tokio::test]
async fn driver_and_passenger_share_a_car() {
    let url = start().await;
    let mut ann = Client::join(&url, "ann").await;
    let mut bob = Client::join(&url, "bob").await;
    ann.idle(2).await;
    let car = ann
        .entities
        .values()
        .find(|e| e.kind == Kind::Car && e.model.as_deref() == Some("sedan"))
        .unwrap()
        .clone();
    assert_eq!(car.seats.as_ref().unwrap().len(), 4);
    assert_eq!(car.max_health, Some(100.0));
    assert_eq!(car.lights_on, Some(false));
    assert_eq!(car.steering, Some(0.0));
    assert_eq!(car.skidding, Some(false));

    ann.board(&car.id).await;
    assert_eq!(ann.me().vehicle.as_deref(), Some(car.id.as_str()));
    assert_eq!(ann.me().seat, Some(0));

    // Drive forward and honk once: the car moves and the horn reaches both clients.
    let start_z = ann.entities[&car.id].z;
    for i in 0..15 {
        ann.frame(|_| Controls {
            up: true,
            attack: i < 5,
            ..Default::default()
        })
        .await;
        bob.idle(1).await;
    }
    let moved = &ann.entities[&car.id];
    assert!(moved.z - start_z > 2.0, "car moved {} m", moved.z - start_z);
    assert_eq!(moved.driver.as_deref(), Some(ann.id.as_str()));
    assert_eq!(ann.me().z, moved.z, "ann rides where the car is");
    assert_eq!(ann.events.iter().filter(|k| *k == "horn").count(), 1);
    // Bob's socket trails while Ann boards; let him catch up to the horn.
    bob.catch_up().await;
    assert_eq!(bob.events.iter().filter(|k| *k == "horn").count(), 1);

    // Stop, then Bob climbs into the passenger seat.
    for _ in 0..60 {
        ann.frame(|_| Controls {
            brake: true,
            ..Default::default()
        })
        .await;
        bob.idle(1).await;
    }
    bob.catch_up().await;
    bob.board(&car.id).await;
    assert_eq!(bob.me().vehicle.as_deref(), Some(car.id.as_str()));
    assert_eq!(bob.me().seat, Some(1));
    // Bob's stick does not steer: the car stays put while only Bob pushes.
    let before = bob.entities[&car.id].z;
    for _ in 0..30 {
        bob.frame(|_| Controls {
            up: true,
            ..Default::default()
        })
        .await;
        ann.idle(1).await;
    }
    assert!((bob.entities[&car.id].z - before).abs() < 0.5);
    let seats = bob.entities[&car.id].seats.clone().unwrap();
    assert_eq!(
        seats,
        vec![Some(ann.id.clone()), Some(bob.id.clone()), None, None]
    );

    // Bob gets out beside the car; the seat frees up.
    bob.frame(|_| Controls {
        interact: true,
        ..Default::default()
    })
    .await;
    bob.idle(4).await;
    assert_eq!(bob.me().vehicle, None);
    let car_now = &bob.entities[&car.id];
    let d = (bob.me().x - car_now.x).hypot(bob.me().z - car_now.z);
    assert!((2.0..5.0).contains(&d), "bob stands {d} m from the car");
    let seats = car_now.seats.clone().unwrap();
    assert_eq!(seats, vec![Some(ann.id.clone()), None, None, None]);
}

//! AI traffic and pedestrians appear around a player, move, and leave with the last player.
use afterhours_protocol::{ClientMessage, Entity, Kind, ServerMessage, VERSION, decode, encode};
use afterhours_server::{City, Event, Game, World};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A 3 x 3 street grid 80 m apart around the origin (every inner node is a signalled
/// junction) and a square sidewalk loop 90 m out with one signalled crossing.
fn city() -> City {
    let mut roads = Vec::new();
    for i in -1..=1 {
        for j in -1..1 {
            let (a, b) = (80.0 * j as f64, 80.0 * (j + 1) as f64);
            let k = 80.0 * i as f64;
            roads.push(serde_json::json!({"ax": a, "az": k, "bx": b, "bz": k, "width": 12, "approachA": 8, "approachB": 8}));
            roads.push(serde_json::json!({"ax": k, "az": a, "bx": k, "bz": b, "width": 12, "approachA": 8, "approachB": 8}));
        }
    }
    let points: Vec<f64> = [
        (-90, -90),
        (0, -90),
        (90, -90),
        (90, 0),
        (90, 90),
        (0, 90),
        (-90, 90),
        (-90, 0),
    ]
    .iter()
    .flat_map(|&(x, z)| [x as f64, z as f64])
    .collect();
    let links: Vec<u32> = (0..8u32)
        .flat_map(|a| [a, (a + 1) % 8, (a == 1) as u32])
        .collect();
    serde_json::from_value(serde_json::json!({
        "seed": 42, "airport": null, "airports": null, "centre": {"x": 0, "z": 0},
        "ramps": null, "racetrack": null, "landmarks": null, "townHall": null, "buildings": [], "parks": [], "roads": roads,
        "walkways": {"points": points, "links": links},
    }))
    .unwrap()
}

fn game() -> Game {
    let mut world = World::new();
    world.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
    let mut game = Game::new(world, [0.0, 1.0, 0.0]);
    game.set_city(&city());
    game
}

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = afterhours_server::router(game(), None, "dist".into());
    tokio::spawn(afterhours_server::serve(listener, app));
    format!("ws://{addr}/ws")
}

fn join_message(name: &str) -> ClientMessage {
    ClientMessage::Join {
        version: VERSION,
        name: name.into(),
        color: "#ff0000".into(),
        character: None,
    }
}

async fn join(url: &str, name: &str) -> Socket {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::Binary(encode(&join_message(name)).into()))
        .await
        .unwrap();
    match recv(&mut ws).await {
        ServerMessage::Welcome { .. } => ws,
        other => panic!("expected welcome, got {other:?}"),
    }
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

/// Applies snapshots like a client: a delta against the acked base, full otherwise.
#[derive(Default)]
struct View(HashMap<String, Entity>);

impl View {
    fn apply(&mut self, m: &ServerMessage) {
        if let ServerMessage::State {
            base,
            entities,
            removed,
            ..
        } = m
        {
            if base.is_none() {
                self.0.clear();
            }
            for id in removed {
                self.0.remove(id);
            }
            for e in entities {
                self.0.insert(e.id.clone(), e.clone());
            }
        }
    }

    fn ai(&self, kind: Kind) -> Vec<&Entity> {
        self.0
            .values()
            .filter(|e| e.kind == kind && e.ai == Some(true) && e.x.hypot(e.z) <= 220.0)
            .collect()
    }
}

#[tokio::test]
async fn a_player_sees_moving_ai_cars_and_pedestrians() {
    let url = start().await;
    let mut ws = join(&url, "ann").await;
    let mut view = View::default();
    // Two seconds of snapshots: the first population sample spawns within one.
    for _ in 0..30 {
        view.apply(&recv(&mut ws).await);
    }
    let before: HashMap<String, [f32; 2]> = view
        .0
        .values()
        .filter(|e| e.ai == Some(true))
        .map(|e| (e.id.clone(), [e.x, e.z]))
        .collect();
    let car = view
        .ai(Kind::Car)
        .first()
        .cloned()
        .cloned()
        .expect("an AI car within 220 m");
    assert!(matches!(
        car.model.as_deref(),
        Some("sedan" | "sport" | "van")
    ));
    assert!(
        car.seats
            .as_ref()
            .is_some_and(|s| s.iter().all(Option::is_none))
    );
    let walker = view
        .ai(Kind::Pedestrian)
        .first()
        .cloned()
        .cloned()
        .expect("a pedestrian within 220 m");
    assert!(
        walker
            .character
            .as_ref()
            .is_some_and(|c| c["physique"].is_string())
    );
    for _ in 0..45 {
        view.apply(&recv(&mut ws).await);
    }
    let moved = |kind: Kind| {
        view.ai(kind).iter().any(|e| {
            before
                .get(&e.id)
                .is_some_and(|b| (b[0] - e.x).hypot(b[1] - e.z) > 0.5)
        })
    };
    assert!(moved(Kind::Car), "a car drove in three seconds");
    assert!(
        moved(Kind::Pedestrian),
        "a pedestrian walked in three seconds"
    );
}

#[test]
fn ai_leaves_with_the_last_player() {
    let mut game = game();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    game.handle(Event::Connect(1, tx));
    game.handle(Event::Message(1, join_message("ann")));
    for _ in 0..60 {
        game.step();
    }
    let (cars, people) = game.population();
    assert!(cars > 0 && people > 0, "cars {cars}, people {people}");
    game.handle(Event::Disconnect(1));
    // AI reads the previous tick's entities, so the empty world shows one tick late.
    game.step();
    game.step();
    assert_eq!(game.population(), (0, 0));
    for _ in 0..60 {
        game.step();
    }
    assert_eq!(game.population(), (0, 0), "nobody to spawn around");
}

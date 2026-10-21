//! A driver knocks down a lamp: the State announces it broken, carries its debris, and
//! drops both once the debris lifetime ends.
use afterhours_protocol::{
    ClientMessage, Controls, Entity, Kind, ServerMessage, VERSION, decode, encode,
};
use afterhours_server::destruction::Destructible;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const LAMP: &str = "lamp:4.0000,45.0000";

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut world = afterhours_server::World::new();
    world.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
    let mut game = afterhours_server::Game::new(world, [0.0, 1.0, 0.0]);
    // One lamp 20 m ahead of the sedan parked at spawn + (4, 25); see vehicles::STREET_SITES.
    game.add_props(vec![Destructible::new("lamp", 4.0, 45.0, 6.0, None, 0.0)]);
    game.destruction.debris_seconds = 1.0;
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

/// Receives one State, applies its entities, and sends `controls` for the next few ticks.
async fn drive(
    ws: &mut Socket,
    entities: &mut HashMap<String, Entity>,
    controls: &Controls,
) -> ServerMessage {
    let m = recv(ws).await;
    if let ServerMessage::State {
        tick,
        base,
        entities: changed,
        removed,
        ..
    } = &m
    {
        if base.is_none() {
            entities.clear();
        }
        for id in removed {
            entities.remove(id);
        }
        for e in changed {
            entities.insert(e.id.clone(), e.clone());
        }
        // Stamp inputs a few ticks ahead; `interact` is an edge, so only the first carries it.
        for t in tick + 1..tick + 4 {
            send(
                ws,
                &ClientMessage::Input {
                    tick: t,
                    ack: Some(*tick),
                    controls: Controls {
                        interact: controls.interact && t == tick + 1,
                        ..controls.clone()
                    },
                },
            )
            .await;
        }
    }
    m
}

#[tokio::test]
async fn a_driver_breaks_a_lamp_into_debris_that_expires() {
    let url = start().await;
    let (mut ws, me) = join(&url, "ann").await;
    let mut entities = HashMap::new();
    let forward = Controls {
        up: true,
        ..Default::default()
    };
    // The first State after joining carries the (empty) broken list.
    match drive(&mut ws, &mut entities, &forward).await {
        ServerMessage::State { broken, debris, .. } => {
            assert_eq!(broken, Some(vec![]));
            assert!(debris.is_empty());
        }
        other => panic!("expected state, got {other:?}"),
    }
    // Walk to the right-hand car and climb in.
    let mut entered = false;
    for i in 0..300 {
        let car = entities
            .values()
            .find(|e| e.kind == Kind::Car && e.model.as_deref() == Some("sedan"))
            .unwrap();
        let (dx, dz) = (car.x - entities[&me].x, car.z - entities[&me].z);
        let d = dx.hypot(dz).max(0.01);
        let controls = Controls {
            move_x: Some(dx / d),
            move_y: Some(dz / d),
            interact: d < 3.0 && i % 10 == 0,
            ..Default::default()
        };
        drive(&mut ws, &mut entities, &controls).await;
        if entities[&me].vehicle.is_some() {
            entered = true;
            break;
        }
    }
    assert!(entered, "ann should have entered the car");
    // Floor it into the lamp.
    let mut saw_break = None;
    let mut broke_at = None;
    for _ in 0..300 {
        if let ServerMessage::State {
            tick,
            broken,
            debris,
            events,
            ..
        } = drive(&mut ws, &mut entities, &forward).await
            && !debris.is_empty()
        {
            assert_eq!(broken.as_deref(), Some(&[LAMP.to_string()][..]));
            assert_eq!(debris.len(), 1);
            assert_eq!(debris[0].id, LAMP);
            assert_eq!(debris[0].source["kind"], "lamp");
            assert!(debris[0].position.y > 2.0, "{:?}", debris[0].position);
            assert!((debris[0].expires_at - debris[0].broken_at - 1.0).abs() < 1e-6);
            saw_break = events.iter().find(|e| e.kind == "propBreak").cloned();
            broke_at = Some(tick);
            break;
        }
    }
    let broke_at = broke_at.expect("the lamp broke");
    let event = saw_break.expect("propBreak event in the same state");
    assert_eq!(event.sound.as_deref(), Some("impact"));
    assert_eq!((event.x, event.z), (4.0, 45.0));
    // Later states leave `broken` out until the set changes again.
    let mut gone = false;
    for _ in 0..120 {
        if let ServerMessage::State {
            tick,
            broken,
            debris,
            ..
        } = drive(&mut ws, &mut entities, &Controls::default()).await
        {
            if debris.is_empty() {
                assert_eq!(broken, Some(vec![]), "the lamp stands again");
                assert!(
                    tick - broke_at >= 30,
                    "expired after {} ticks",
                    tick - broke_at
                );
                gone = true;
                break;
            }
            assert_eq!(broken, None);
        }
    }
    assert!(gone, "debris should expire after one second");
}

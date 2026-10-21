//! Two clients join, one drives, both see it move.
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
    tokio::spawn(afterhours_server::serve(listener, "dist".into()));
    format!("ws://{addr}/ws")
}

async fn join(url: &str, name: &str) -> (Socket, u32) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    send(
        &mut ws,
        &ClientMessage::Join {
            version: VERSION,
            name: name.into(),
            color: "#ff0000".into(),
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

/// Applies snapshots like a client: a delta against the acked base, full otherwise.
struct View {
    entities: HashMap<u32, Entity>,
    tick: Option<u32>,
}

impl View {
    fn apply(&mut self, m: &ServerMessage) {
        if let ServerMessage::State {
            tick,
            base,
            entities,
            removed,
            ..
        } = m
        {
            // A delta against base B is valid for any state at or after B.
            assert!(
                base.is_none_or(|b| self.tick.is_some_and(|t| b <= t)),
                "base {base:?} vs {:?}",
                self.tick
            );
            if base.is_none() {
                self.entities.clear();
            }
            for id in removed {
                self.entities.remove(id);
            }
            for e in entities {
                self.entities.insert(e.id, e.clone());
            }
            self.tick = Some(*tick);
        }
    }
}

#[tokio::test]
async fn two_players_see_each_other_drive() {
    let url = start().await;
    let (mut a, id_a) = join(&url, "ann").await;
    let (mut b, _) = join(&url, "bob").await;
    let (mut va, mut vb) = (
        View {
            entities: HashMap::new(),
            tick: None,
        },
        View {
            entities: HashMap::new(),
            tick: None,
        },
    );
    let walk = Controls {
        move_z: 1.0,
        ..Default::default()
    };
    for _ in 0..60 {
        let m = recv(&mut a).await;
        va.apply(&m);
        if let ServerMessage::State { tick, .. } = m {
            // Stamp inputs a few ticks ahead so they arrive before their tick runs.
            for t in tick + 1..tick + 4 {
                send(
                    &mut a,
                    &ClientMessage::Input {
                        tick: t,
                        ack: Some(tick),
                        controls: walk,
                    },
                )
                .await;
            }
        }
        vb.apply(&recv(&mut b).await);
    }
    let ann = &va.entities[&id_a];
    assert_eq!(ann.kind, Kind::Player);
    assert!(ann.z > 2.0, "ann walked forward, z={}", ann.z);
    assert!(
        va.entities
            .values()
            .filter(|e| e.kind == Kind::Player)
            .count()
            == 2
    );
    // Bob's socket may trail by a snapshot; catch him up to Ann's tick, then compare.
    while vb.tick < va.tick {
        vb.apply(&recv(&mut b).await);
    }
    while va.tick < vb.tick {
        va.apply(&recv(&mut a).await);
    }
    assert_eq!(va.tick, vb.tick);
    let ann = &va.entities[&id_a];
    assert_eq!(
        vb.entities[&id_a].z, ann.z,
        "bob's view of ann matches ann's own"
    );
    assert!(va.entities.values().any(|e| e.kind == Kind::Car));
    // Walk into the car and climb in.
    let car = va
        .entities
        .values()
        .find(|e| e.kind == Kind::Car && e.x > 0.0)
        .unwrap()
        .clone();
    let mut entered = false;
    for i in 0..300 {
        let m = recv(&mut a).await;
        va.apply(&m);
        let me = &va.entities[&id_a];
        if me.link.is_some() {
            entered = true;
            break;
        }
        if let ServerMessage::State { tick, .. } = m {
            let (dx, dz) = (car.x - me.x, car.z - me.z);
            let d = dx.hypot(dz).max(0.01);
            let near = d < 3.0;
            let c = Controls {
                move_x: dx / d,
                move_z: dz / d,
                enter: near && i % 10 == 0,
                ..Default::default()
            };
            send(
                &mut a,
                &ClientMessage::Input {
                    tick: tick + 2,
                    ack: Some(tick),
                    controls: c,
                },
            )
            .await;
        }
    }
    assert!(entered, "ann should have entered the car");
    assert_eq!(va.entities[&id_a].link, Some(car.id));
}

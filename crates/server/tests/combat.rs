//! Two clients: ann picks up a pistol and shoots bob down; bob respawns at spawn with full
//! health; ann drops the pistol and bob picks it up; ann throws a grenade that explodes.
use afterhours_protocol::{
    ClientMessage, Controls, Entity, PickupPayload, ServerMessage, VERSION, WeaponItem, decode,
    encode,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const SPAWN: [f32; 3] = [0.0, 1.0, 0.0];

async fn start() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut world = afterhours_server::World::new();
    world.add_box([0.0, -0.5, 0.0], [400.0, 0.5, 400.0], 0.0);
    let mut game = afterhours_server::Game::new(world, SPAWN);
    // A pistol under the spawn and grenades a step away, like a city's weapon pads.
    for (x, kind, ammo) in [(0.0, "pistol", 12), (1.0, "grenade", 3)] {
        let item = WeaponItem {
            id: format!("w-{kind}"),
            kind: kind.into(),
            ammo,
            reserve: 0,
        };
        game.combat
            .spawn_pickup([x, 1.0, 0.0], PickupPayload::Weapon { item }, f64::MAX);
    }
    let app = afterhours_server::router(game, None, "dist".into());
    tokio::spawn(afterhours_server::serve(listener, app));
    format!("ws://{addr}/ws")
}

struct Client {
    ws: Socket,
    id: String,
    entities: HashMap<String, Entity>,
    tick: Option<u32>,
}

async fn join(url: &str, name: &str) -> Client {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::Binary(
        encode(&ClientMessage::Join {
            version: VERSION,
            name: name.into(),
            color: "#ff0000".into(),
            character: Some(serde_json::json!({ "physique": "runner" })),
        })
        .into(),
    ))
    .await
    .unwrap();
    let mut c = Client {
        ws,
        id: String::new(),
        entities: HashMap::new(),
        tick: None,
    };
    match c.recv().await {
        ServerMessage::Welcome { id, .. } => c.id = id,
        other => panic!("expected welcome, got {other:?}"),
    }
    c
}

impl Client {
    async fn recv(&mut self) -> ServerMessage {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Message::Binary(b) = msg {
                return decode(&b).unwrap();
            }
        }
    }

    /// Receives one snapshot, applies it, and answers with `controls` two ticks ahead.
    async fn pump(&mut self, controls: Controls) -> ServerMessage {
        loop {
            let m = self.recv().await;
            let ServerMessage::State {
                tick,
                base,
                entities,
                removed,
                ..
            } = &m
            else {
                continue;
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
            self.tick = Some(*tick);
            self.ws
                .send(Message::Binary(
                    encode(&ClientMessage::Input {
                        tick: tick + 2,
                        ack: Some(*tick),
                        controls,
                    })
                    .into(),
                ))
                .await
                .unwrap();
            return m;
        }
    }

    fn me(&self) -> &Entity {
        &self.entities[&self.id]
    }
}

fn weapon(e: &Entity) -> &str {
    e.weapon.as_deref().unwrap_or("")
}

/// Runs both clients for `ticks` snapshots, `a` and `b` choosing each frame's controls from
/// the latest views; stops early once `done` holds.
async fn run(
    ann: &mut Client,
    bob: &mut Client,
    ticks: usize,
    mut a: impl FnMut(&Client, &Client, usize) -> Controls,
    mut b: impl FnMut(&Client, &Client, usize) -> Controls,
    mut done: impl FnMut(&Client, &Client, &ServerMessage, &ServerMessage) -> bool,
) -> bool {
    for i in 0..ticks {
        let ca = a(ann, bob, i);
        let ma = ann.pump(ca).await;
        let cb = b(ann, bob, i);
        let mb = bob.pump(cb).await;
        if done(ann, bob, &ma, &mb) {
            return true;
        }
    }
    false
}

fn idle(_: &Client, _: &Client, _: usize) -> Controls {
    Controls::default()
}

#[tokio::test]
async fn shoot_down_respawn_drop_pickup_and_grenade() {
    let url = start().await;
    let mut ann = join(&url, "ann").await;
    let mut bob = join(&url, "bob").await;
    let bob_id = bob.id.clone();
    let ann_id = ann.id.clone();

    // Runner physique: 80 health from the first snapshot, fists equipped.
    run(&mut ann, &mut bob, 4, idle, idle, |_, _, _, _| false).await;
    assert_eq!(bob.me().health, 80.0);
    assert_eq!(bob.me().max_health, Some(80.0));
    assert_eq!(weapon(bob.me()), "fists");
    assert_eq!(bob.me().inventory.as_ref().map(Vec::len), Some(1));

    // Ann grabs the pistol, then the grenades (slot 2 ends up equipped); bob walks off.
    let got = run(
        &mut ann,
        &mut bob,
        60,
        |_, _, i| Controls {
            interact: i % 10 == 0,
            ..Default::default()
        },
        |_, _, i| Controls {
            up: i < 15,
            ..Default::default()
        },
        |a, _, _, _| weapon(a.me()) == "grenade",
    )
    .await;
    assert!(
        got,
        "ann should hold the grenades: {:?}",
        ann.me().inventory
    );
    assert_eq!(ann.me().inventory.as_ref().map(Vec::len), Some(3));
    assert!(bob.me().z > 1.0, "bob walked away: {}", bob.me().z);

    // Equip the pistol and shoot bob until he drops.
    let downed = run(
        &mut ann,
        &mut bob,
        120,
        |a, b, i| {
            let (me, him) = (a.me(), &a.entities[&b.id]);
            Controls {
                equip: (i == 0).then_some(1),
                attack: i > 2,
                aim: Some((him.x - me.x).atan2(him.z - me.z)),
                ..Default::default()
            }
        },
        idle,
        |_, b, _, mb| {
            let ServerMessage::State { events, .. } = mb else {
                return false;
            };
            let me = b.me();
            me.health == 0.0
                && me.down.is_some_and(|d| d > 0.0)
                && events
                    .iter()
                    .any(|e| e.kind == "hit" && e.target.as_deref() == Some(&bob_id))
        },
    )
    .await;
    assert!(downed, "bob should be down: {:?}", bob.me());
    assert_eq!(weapon(ann.me()), "pistol");
    assert!(ann.me().inventory.as_ref().unwrap()[1].ammo < 12);

    // Three seconds later bob is back on spawn with full health.
    let respawned = run(&mut ann, &mut bob, 150, idle, idle, |_, b, _, _| {
        let me = b.me();
        me.down.is_none() && me.health == 80.0
    })
    .await;
    assert!(respawned, "bob should respawn: {:?}", bob.me());
    assert!(
        bob.me().x.hypot(bob.me().z) < 0.5,
        "at spawn: {:?}",
        bob.me()
    );

    // Ann drops the pistol in front of her; bob walks over and picks it up.
    let mut seen_pistol = false;
    let swapped = run(
        &mut ann,
        &mut bob,
        120,
        |_, _, i| Controls {
            drop: i == 0,
            aim: Some(0.0),
            ..Default::default()
        },
        |a, b, i| {
            let (me, her) = (b.me(), &b.entities[&a.id]);
            let (dx, dz) = (her.x - me.x, her.z + 0.8 - me.z);
            let d = dx.hypot(dz);
            Controls {
                move_x: Some(if d > 0.3 { dx / d } else { 0.0 }),
                move_y: Some(if d > 0.3 { dz / d } else { 0.0 }),
                interact: i > 2 && i % 5 == 0,
                ..Default::default()
            }
        },
        |a, b, _, mb| {
            // The dropped pistol lies in the snapshot until someone takes it.
            if let ServerMessage::State { pickups, .. } = mb {
                seen_pistol |= pickups.iter().any(
                    |p| matches!(&p.payload, PickupPayload::Weapon { item } if item.kind == "pistol"),
                );
            }
            weapon(a.me()) != "pistol" && weapon(b.me()) == "pistol"
        },
    )
    .await;
    assert!(seen_pistol, "the dropped pistol should lie in the snapshot");
    assert!(
        swapped,
        "bob should hold the pistol: {:?} / {:?}",
        ann.me(),
        bob.me()
    );
    assert_eq!(ann.me().inventory.as_ref().map(Vec::len), Some(2));

    // Ann throws a grenade: it shows up in the snapshot, then explodes three seconds later.
    let mut seen_grenade = false;
    let exploded = run(
        &mut ann,
        &mut bob,
        150,
        |_, _, i| Controls {
            equip: (i == 0).then_some(1),
            attack: i == 3,
            aim: Some(std::f32::consts::FRAC_PI_2),
            ..Default::default()
        },
        idle,
        |_, _, ma, _| {
            let ServerMessage::State {
                grenades, events, ..
            } = ma
            else {
                return false;
            };
            seen_grenade |= grenades.iter().any(|g| g.owner == ann_id);
            events.iter().any(|e| e.kind == "explosion")
        },
    )
    .await;
    assert!(seen_grenade, "the grenade should fly in the snapshot");
    assert!(exploded, "the grenade should explode");
}

//! Wire types shared by the Rust server and the TypeScript client. `cargo test -p
//! afterhours-protocol` regenerates `shared/generated/*.ts` through ts-rs; both sides
//! speak msgpack maps with camelCase keys.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const VERSION: u32 = 1;
pub const TICK_RATE: u32 = 30;

/// One tick of player intent: the browser's control sample plus edge actions. Edge
/// actions ride on the frame so they can never arrive out of order with its movement.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, rename_all = "camelCase")]
pub struct Controls {
    pub up: bool,
    pub down: bool,
    pub left: bool,
    pub right: bool,
    #[ts(optional)]
    pub move_x: Option<f32>,
    #[ts(optional)]
    pub move_y: Option<f32>,
    pub brake: bool,
    pub sprint: bool,
    pub ascend: bool,
    pub descend: bool,
    pub attack: bool,
    #[ts(optional)]
    pub aim: Option<f32>,
    pub interact: bool,
    pub drop: bool,
    pub reload: bool,
    pub jetpack: bool,
    #[ts(optional)]
    pub equip: Option<u8>,
}

impl Controls {
    pub fn x(&self) -> f32 {
        self.move_x
            .unwrap_or(self.right as u8 as f32 - self.left as u8 as f32)
    }
    pub fn y(&self) -> f32 {
        self.move_y
            .unwrap_or(self.up as u8 as f32 - self.down as u8 as f32)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Join {
        version: u32,
        name: String,
        color: String,
        #[ts(type = "unknown")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        character: Option<serde_json::Value>,
    },
    /// Intent for simulation tick `tick`; `ack` is the newest snapshot tick received.
    Input {
        tick: u32,
        ack: Option<u32>,
        controls: Controls,
    },
    Chat {
        text: String,
    },
    Ping {
        timestamp: f64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum Kind {
    Player,
    Car,
}

/// What the client renders. Field names match the browser's existing `Entity`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub kind: Kind,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Yaw in radians; `pitch`/`roll` complete the attitude for vehicles.
    pub angle: f32,
    pub pitch: f32,
    pub roll: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub color: String,
    pub health: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(type = "unknown")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// Vehicle occupant ids; slot zero drives. Null means vacant.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seats: Option<Vec<Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub driver: Option<String>,
    /// Vehicle this player sits in, and the seat index.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vehicle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seat: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steering: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    Welcome {
        version: u32,
        id: String,
        tick: u32,
        tick_rate: u32,
        /// The city manifest; the client validates it with `mapManifestSchema`.
        #[ts(type = "unknown")]
        map: serde_json::Value,
    },
    /// Entities that changed since `base` (every entity when `base` is null).
    State {
        tick: u32,
        base: Option<u32>,
        /// Simulation seconds, for the remote interpolation timeline.
        time: f64,
        /// Newest input tick applied for this client.
        ack: Option<u32>,
        /// How many ticks early this client's inputs arrive; negative means late.
        lead: i32,
        entities: Vec<Entity>,
        removed: Vec<String>,
        /// Raw physics row of the body this client controls, for restore-and-replay.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        you: Option<Vec<f32>>,
        players: u32,
    },
    Chat {
        name: String,
        text: String,
    },
    Pong {
        timestamp: f64,
        tick: u32,
    },
}

pub fn encode<T: Serialize>(value: &T) -> Vec<u8> {
    rmp_serde::to_vec_named(value).expect("protocol types always serialise")
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, rmp_serde::decode::Error> {
    rmp_serde::from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_as_named_maps() {
        let msg = ClientMessage::Input {
            tick: 7,
            ack: None,
            controls: Controls {
                up: true,
                ..Default::default()
            },
        };
        let bytes = encode(&msg);
        assert_eq!(decode::<ClientMessage>(&bytes).unwrap(), msg);
        // Named fields so the JS msgpack decoder produces plain objects.
        assert!(bytes.windows(5).any(|w| w == b"input"));
    }

    #[test]
    fn missing_control_fields_default() {
        let c: Controls =
            decode(&rmp_serde::to_vec_named(&serde_json::json!({"up": true})).unwrap()).unwrap();
        assert!(c.up && !c.down && c.move_x.is_none());
        assert_eq!(c.y(), 1.0);
    }
}

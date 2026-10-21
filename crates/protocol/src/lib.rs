//! Wire types shared by the Rust server and the TypeScript client. `cargo test -p
//! afterhours-protocol` regenerates `shared/generated/*.ts` through ts-rs; both sides
//! speak msgpack maps with camelCase keys.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const VERSION: u32 = 1;
pub const TICK_RATE: u32 = 30;

/// One tick of player intent. Edge actions are flags on the frame itself so they can
/// never arrive out of order with the movement they belong to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, rename_all = "camelCase")]
pub struct Controls {
    pub move_x: f32,
    pub move_z: f32,
    pub sprint: bool,
    pub jump: bool,
    pub throttle: f32,
    pub steer: f32,
    pub brake: bool,
    pub enter: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Join {
        version: u32,
        name: String,
        color: String,
    },
    /// Intent for simulation tick `tick`; `ack` is the newest snapshot tick received.
    Input {
        tick: u32,
        ack: Option<u32>,
        controls: Controls,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Entity {
    pub id: u32,
    pub kind: Kind,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Orientation quaternion.
    pub q: [f32; 4],
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// Player id driving this vehicle, or the vehicle a player sits in.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    Welcome {
        version: u32,
        id: u32,
        tick: u32,
        tick_rate: u32,
    },
    /// Entities that changed since `base` (every entity when `base` is null).
    State {
        tick: u32,
        base: Option<u32>,
        /// Newest input tick applied for this client.
        ack: Option<u32>,
        /// How many ticks early this client's inputs arrive; negative means late.
        lead: i32,
        entities: Vec<Entity>,
        removed: Vec<u32>,
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
                throttle: 1.0,
                ..Default::default()
            },
        };
        let bytes = encode(&msg);
        assert_eq!(decode::<ClientMessage>(&bytes).unwrap(), msg);
        // Named fields so the JS msgpack decoder produces plain objects.
        assert!(bytes.windows(5).any(|w| w == b"input"));
    }
}

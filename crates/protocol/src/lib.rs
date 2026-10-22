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
    /// Legacy development shortcut retained for old clients.
    Debug {
        kind: String,
    },
    /// Structured development command used by the Dev tools drawer.
    DebugCommand {
        request_id: u32,
        #[ts(type = "unknown")]
        command: serde_json::Value,
    },
    DebugView {
        #[ts(type = "{ x: number, z: number } | null")]
        center: Option<serde_json::Value>,
    },
    Ping {
        timestamp: f64,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum Kind {
    #[default]
    Player,
    Pedestrian,
    Car,
    Helicopter,
    Plane,
    Boat,
    Jetski,
    Speedboat,
}

/// What the client renders. Field names match the browser's existing `Entity`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_health: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub weapon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inventory: Option<Vec<WeaponItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub equipped: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reload_until: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cooldown: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub aim: Option<f32>,
    /// Seconds a knocked-down character stays on the ground.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub down: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub burning: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wreck: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub flooded: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lights_on: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skidding: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wheel_skids: Option<Vec<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub angular_velocity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ai: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub flight: Option<Flight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub takeoff_delay: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parachute: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub jetpack: Option<Jetpack>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum Flight {
    Grounded,
    TakingOff,
    Cruising,
    Landing,
    Falling,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Jetpack {
    pub fuel: f32,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WeaponItem {
    pub id: String,
    pub kind: String,
    pub ammo: u32,
    pub reserve: u32,
}

/// A one-shot effect for clients to draw and play; mirrors the browser's `WorldEvent`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorldEvent {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub angle: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sound: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PickupPayload {
    Weapon { item: WeaponItem },
    Ammo { ammo_kind: String, amount: u32 },
    Jetpack { fuel: f32 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct Pickup {
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: PickupPayload,
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub expires: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GrenadeState {
    pub id: String,
    pub owner: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub radius: f32,
    pub detonate_at: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

/// A broken prop's body, mirrors the browser's `DebrisState`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DebrisState {
    pub id: String,
    #[ts(type = "unknown")]
    pub source: serde_json::Value,
    pub position: Vec3,
    pub rotation: Quat,
    pub velocity: Vec3,
    pub angular_velocity: Vec3,
    pub broken_at: f64,
    pub expires_at: f64,
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
        debug: bool,
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
        /// Hour of the day, 0..24, and how fast it advances per second.
        day: f32,
        day_rate: f32,
        events: Vec<WorldEvent>,
        pickups: Vec<Pickup>,
        #[serde(default)]
        grenades: Vec<GrenadeState>,
        #[serde(default)]
        debris: Vec<DebrisState>,
        /// Prop ids broken so far, sent when the set changes; None means unchanged.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        broken: Option<Vec<String>>,
    },
    Chat {
        name: String,
        text: String,
    },
    DebugResult {
        request_id: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "import(\"../debug\").DebugState")]
        state: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
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

    #[test]
    fn debug_commands_and_results_round_trip() {
        let command = ClientMessage::DebugCommand {
            request_id: 9,
            command: serde_json::json!({ "kind": "time", "hour": 12.0, "rate": 0.0 }),
        };
        assert_eq!(decode::<ClientMessage>(&encode(&command)).unwrap(), command);
        let result = ServerMessage::DebugResult {
            request_id: 9,
            state: Some(serde_json::json!({ "day": 12.0 })),
            error: None,
        };
        assert_eq!(decode::<ServerMessage>(&encode(&result)).unwrap(), result);
    }
}

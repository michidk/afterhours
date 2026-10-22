//! Runtime city contracts used by the map-to-city conversion and feature stages.
//! These shapes intentionally follow `shared/world.ts`; keeping them here avoids
//! passing untyped JSON between the stages.
use crate::types::Point;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Road {
    pub x: f64,
    pub z: f64,
    pub ax: f64,
    pub az: f64,
    pub bx: f64,
    pub bz: f64,
    pub width: f64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_a: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_b: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_a: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_b: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_b: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approach_a: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approach_b: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_crate: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Building {
    pub x: f64,
    pub z: f64,
    pub w: f64,
    pub d: f64,
    pub h: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
    pub asset: String,
    pub facing: f64,
    pub color: String,
    pub style: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prop {
    pub x: f64,
    pub z: f64,
    pub h: f64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spot {
    pub x: f64,
    pub z: f64,
    pub angle: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Airport {
    pub x: f64,
    pub z: f64,
    pub w: f64,
    pub d: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TownHall {
    pub x: f64,
    pub z: f64,
    pub angle: f64,
    pub spawn: Point,
    pub parking: Vec<Spot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Racetrack {
    pub path: Vec<f64>,
    pub width: f64,
    pub grid: Vec<Spot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Harbour {
    pub x: f64,
    pub z: f64,
    pub angle: f64,
    pub berths: Vec<Spot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Landmark {
    pub x: f64,
    pub z: f64,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Marking {
    pub color: String,
    pub polygon: Vec<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Surface {
    pub asphalt: Vec<Vec<f64>>,
    pub sidewalks: Vec<Vec<f64>>,
    pub markings: Vec<Marking>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Walkways {
    pub points: Vec<f64>,
    pub links: Vec<i32>,
}

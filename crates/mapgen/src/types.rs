//! Serializable equivalents of every cross-stage contract in `mapgen/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapOptions {
    pub seed: i32,
    pub size: f64,
    pub cell: f64,
    #[serde(default)]
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightField {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub size: f64,
    pub data: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiverOrder {
    Stream,
    River,
    Main,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct River {
    pub points: Vec<Point>,
    pub widths: Vec<f64>,
    pub order: RiverOrder,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lake {
    pub outline: Vec<Point>,
    pub level: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hydrology {
    pub rivers: Vec<River>,
    pub lakes: Vec<Lake>,
    pub river_mask: Vec<u8>,
    pub water_distance: Vec<f32>,
    pub coast_distance: Vec<f32>,
    pub flow: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    X,
    Z,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoadKind {
    Highway,
    Avenue,
    Street,
    Lane,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoadNode {
    pub id: usize,
    pub x: f64,
    pub z: f64,
    pub y: f64,
    pub edges: Vec<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadEdge {
    pub id: usize,
    pub a: usize,
    pub b: usize,
    pub kind: RoadKind,
    pub width: f64,
    pub bridge: bool,
    pub points: Vec<Point>,
    pub heights: Vec<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RoadGraph {
    pub nodes: Vec<RoadNode>,
    pub edges: Vec<RoadEdge>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Junction {
    pub node: usize,
    pub polygon: Vec<Point>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Band {
    pub edge: usize,
    pub polygon: Vec<Point>,
    pub left: Vec<Point>,
    pub right: Vec<Point>,
    pub centre: Vec<Point>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sidewalk {
    pub polygon: Vec<Point>,
    pub edge: Option<usize>,
    pub node: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Marking {
    pub polygon: Vec<Point>,
    pub color: String,
    pub edge: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WalkLink {
    pub a: usize,
    pub b: usize,
    pub crossing: Option<Phase>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Walkways {
    pub points: Vec<Point>,
    pub links: Vec<WalkLink>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadGeometry {
    pub junctions: Vec<Junction>,
    pub bands: Vec<Band>,
    pub sidewalks: Vec<Sidewalk>,
    pub trims: Vec<(f64, f64)>,
    pub phases: Vec<(Option<Phase>, Option<Phase>)>,
    pub markings: Vec<Marking>,
    pub walkways: Walkways,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Core,
    Commercial,
    Residential,
    Suburb,
    Industrial,
    Park,
    Rural,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lot {
    pub polygon: Vec<Point>,
    pub frontage: isize,
    pub area: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Block {
    pub id: usize,
    pub polygon: Vec<Point>,
    pub interior: Vec<Point>,
    pub zone: Zone,
    pub lots: Vec<Lot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildingKind {
    Tower,
    Office,
    Apartments,
    Shop,
    Townhouse,
    House,
    Warehouse,
    Civic,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingPlacement {
    pub x: f64,
    pub z: f64,
    pub w: f64,
    pub d: f64,
    pub angle: f64,
    pub h: f64,
    pub y: f64,
    pub kind: BuildingKind,
    pub color: String,
    pub footprint: Option<Vec<Point>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeKind {
    Pine,
    Oak,
    Palm,
    Shrub,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tree {
    pub x: f64,
    pub z: f64,
    pub h: f64,
    pub kind: TreeKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lamp {
    pub x: f64,
    pub z: f64,
    pub h: f64,
    pub angle: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParkKind {
    Garden,
    Woodland,
    Riverside,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Park {
    pub polygon: Vec<Point>,
    pub kind: ParkKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bridge {
    pub edge: usize,
    pub polygon: Vec<Point>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StageTiming {
    pub stage: String,
    pub ms: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMap {
    pub options: MapOptions,
    pub sea_level: f64,
    pub terrain: HeightField,
    pub shaped: HeightField,
    pub flow: Vec<f32>,
    pub rivers: Vec<River>,
    pub lakes: Vec<Lake>,
    pub desirability: Vec<f32>,
    pub centre: Point,
    pub roads: RoadGraph,
    pub geometry: RoadGeometry,
    pub bridges: Vec<Bridge>,
    pub blocks: Vec<Block>,
    pub buildings: Vec<BuildingPlacement>,
    pub parks: Vec<Park>,
    pub trees: Vec<Tree>,
    pub lamps: Vec<Lamp>,
    pub timings: Vec<StageTiming>,
}

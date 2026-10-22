//! Rust equivalents of the generator's cross-stage contracts.

use crate::Point;

#[derive(Clone, Debug)]
pub struct MapOptions {
    pub seed: i32,
    pub size: f64,
    pub cell: f64,
}

#[derive(Clone, Debug)]
pub struct HeightField {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub size: f64,
    pub data: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiverOrder {
    Stream,
    River,
    Main,
}

#[derive(Clone, Debug)]
pub struct River {
    pub points: Vec<Point>,
    pub widths: Vec<f64>,
    pub order: RiverOrder,
}

#[derive(Clone, Debug)]
pub struct Lake {
    pub outline: Vec<Point>,
    pub level: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoadKind {
    Highway,
    Avenue,
    Street,
    Lane,
}

#[derive(Clone, Debug)]
pub struct RoadNode {
    pub id: usize,
    pub point: Point,
    pub y: f64,
    pub edges: Vec<usize>,
}

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug, Default)]
pub struct RoadGraph {
    pub nodes: Vec<RoadNode>,
    pub edges: Vec<RoadEdge>,
}

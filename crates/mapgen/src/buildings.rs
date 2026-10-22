//! Building placement contracts.

use super::blocks::Block;
use crate::geom::Point;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Debug)]
pub struct BuildingPlacement {
    pub centre: Point,
    pub width: f64,
    pub depth: f64,
    pub angle: f64,
    pub height: f64,
    pub y: f64,
    pub kind: BuildingKind,
    pub color: String,
    pub footprint: Option<Vec<Point>>,
}

pub fn place(_blocks: &[Block]) -> Vec<BuildingPlacement> {
    Vec::new()
}

//! Parks, trees, and street-fixture contracts.

use crate::geom::Point;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    Pine,
    Oak,
    Palm,
    Shrub,
}
#[derive(Clone, Debug)]
pub struct Tree {
    pub point: Point,
    pub height: f64,
    pub kind: TreeKind,
}
#[derive(Clone, Debug)]
pub struct Lamp {
    pub point: Point,
    pub height: f64,
    pub angle: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParkKind {
    Garden,
    Woodland,
    Riverside,
}
#[derive(Clone, Debug)]
pub struct Park {
    pub polygon: Vec<Point>,
    pub kind: ParkKind,
}

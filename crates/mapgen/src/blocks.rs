//! Parcel and zoning contracts.

use crate::geom::Point;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    Core,
    Commercial,
    Residential,
    Suburb,
    Industrial,
    Park,
    Rural,
}

#[derive(Clone, Debug)]
pub struct Lot {
    pub polygon: Vec<Point>,
    pub frontage: isize,
    pub area: f64,
}

#[derive(Clone, Debug)]
pub struct Block {
    pub id: usize,
    pub polygon: Vec<Point>,
    pub interior: Vec<Point>,
    pub zone: Zone,
    pub lots: Vec<Lot>,
}

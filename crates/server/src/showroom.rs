//! The test world's showroom: one of every vehicle and every item beside the spawn, so each can
//! be tried in seconds. The generator (`afterhours_mapgen::testworld`) leaves the layout in the
//! city as landmarks: SHOWROOM is the centre and BOAT POND the middle of the pond for the
//! boats; the racetrack's start line gives the heading everything faces.
use crate::city::City;

/// Cars, helicopters and planes as (model, x, z, yaw); boats float on the pond.
pub struct Layout {
    pub cars: Vec<(&'static str, f32, f32, f32)>,
    pub craft: Vec<(&'static str, f32, f32, f32)>,
    pub boats: Vec<(&'static str, f32, f32, f32)>,
    /// Where each pickup stands, in the order `Combat::showcase` takes them.
    pub items: Vec<(f32, f32)>,
}

fn landmark(city: &City, name: &str) -> Option<(f32, f32)> {
    city.landmarks
        .as_array()?
        .iter()
        .find(|l| l["name"] == name)
        .and_then(|l| Some((l["x"].as_f64()? as f32, l["z"].as_f64()? as f32)))
}

/// The showroom of this city, or `None` when it is not a test world.
pub fn layout(city: &City) -> Option<Layout> {
    let (cx, cz) = landmark(city, "SHOWROOM")?;
    let (px, pz) = landmark(city, "BOAT POND")?;
    let heading = city.racetrack["grid"][0]["angle"].as_f64()? as f32;
    let (fx, fz) = (heading.sin(), heading.cos());
    let (rx, rz) = (heading.cos(), -heading.sin());
    // `u` metres to the right of the centre and `v` metres ahead.
    let at = |u: f32, v: f32| (cx + rx * u + fx * v, cz + rz * u + fz * v);
    let row = |models: &[&'static str], v: f32, gap: f32| -> Vec<_> {
        let start = -gap * (models.len() as f32 - 1.0) / 2.0;
        models
            .iter()
            .enumerate()
            .map(|(i, &m)| {
                let p = at(start + gap * i as f32, v);
                (m, p.0, p.1, heading)
            })
            .collect()
    };
    let boats = ["boat", "launch", "jetski", "racer", "speedboat", "offshore"]
        .iter()
        .enumerate()
        .map(|(i, &m)| {
            let a = i as f32 * std::f32::consts::TAU / 6.0;
            (m, px + 22.0 * a.cos(), pz + 22.0 * a.sin(), heading)
        })
        .collect();
    Some(Layout {
        cars: row(&["sedan", "sport", "van"], 0.0, 11.0),
        craft: [
            row(&["scout", "utility"], 32.0, 30.0),
            // Planes need a long run: the island is flat for hundreds of metres ahead of them.
            row(&["plane", "aerobatic"], 70.0, 56.0),
        ]
        .concat(),
        boats,
        items: (0..13).map(|i| at(-24.0 + 4.0 * i as f32, -22.0)).collect(),
    })
}

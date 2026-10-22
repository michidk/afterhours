use crate::{
    field::{sample, slope},
    geom::{SpatialHash, convex_overlap, dist, oriented_box, rotated_rect},
    random::{derive, pick, range},
    types::{Block, BuildingKind, BuildingPlacement, HeightField, Point, Zone},
};
fn palette(k: BuildingKind) -> &'static [&'static str] {
    match k {
        BuildingKind::Tower => &["#9fb7c9", "#b9c6d0"],
        BuildingKind::Office => &["#c9c2b4", "#b7b1a6"],
        BuildingKind::Apartments => &["#d8c3a0", "#e2cdb0"],
        BuildingKind::Shop => &["#e4b98a", "#d99f7b"],
        BuildingKind::Townhouse => &["#d1a98f", "#c59a7e"],
        BuildingKind::House => &["#e7d7b7", "#d8c7a2"],
        BuildingKind::Warehouse => &["#aab4bb", "#9ca7ae"],
        BuildingKind::Civic => &["#efe1b8", "#e8d8aa"],
    }
}
fn kind_height(z: Zone, dist: f64, area: f64, r: &mut crate::random::Rng) -> (BuildingKind, f64) {
    let fall = (-dist / 420.0).exp();
    let n = range(r, -0.25, 0.3).exp();
    match z {
        Zone::Core => {
            if area > 450.0 && r() < 0.45 + fall * 0.4 {
                (BuildingKind::Tower, ((40.0 + 110.0 * fall) * n).min(200.0))
            } else {
                (
                    if r() < 0.6 {
                        BuildingKind::Office
                    } else {
                        BuildingKind::Shop
                    },
                    (16.0 + 24.0 * fall) * n,
                )
            }
        }
        Zone::Commercial => {
            let k = if r() < 0.5 {
                BuildingKind::Apartments
            } else {
                BuildingKind::Office
            };
            (k, (12.0 + 20.0 * fall) * n)
        }
        Zone::Residential => {
            let k = if r() < 0.6 {
                BuildingKind::Apartments
            } else {
                BuildingKind::Townhouse
            };
            (k, (10.0 + 10.0 * fall) * n)
        }
        Zone::Suburb => (BuildingKind::House, 5.5 * n),
        Zone::Industrial => (BuildingKind::Warehouse, 8.0 + r() * 6.0),
        _ => (BuildingKind::Civic, 10.0),
    }
}
pub fn place_buildings(
    blocks: &[Block],
    f: &HeightField,
    centre: Point,
    seed: i32,
) -> Vec<BuildingPlacement> {
    let mut r = derive(seed, "buildings");
    let mut out = Vec::new();
    let mut hash = SpatialHash::new(64.0);
    for b in blocks {
        for lot in &b.lots {
            if lot.frontage < 0 {
                continue;
            }
            let Some((ang, w, d, c)) = oriented_box(&lot.polygon) else {
                continue;
            };
            let w = w.min(44.0);
            let d = d.min(36.0);
            if w < 6.0 || d < 6.0 || slope(f, c.x, c.z) > 0.42 {
                continue;
            }
            let hs = lot
                .polygon
                .iter()
                .map(|p| sample(f, p.x, p.z))
                .collect::<Vec<_>>();
            if hs.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                - hs.iter().copied().fold(f64::INFINITY, f64::min)
                > 9.0
            {
                continue;
            }
            let (kind, h) = kind_height(b.zone, dist(c, centre), w * d, &mut r);
            let p = BuildingPlacement {
                x: (c.x * 100.0).round() / 100.0,
                z: (c.z * 100.0).round() / 100.0,
                w: (w * 10.0).round() / 10.0,
                d: (d * 10.0).round() / 10.0,
                angle: ang,
                h: (h * 10.0).round() / 10.0,
                y: ((sample(f, c.x, c.z)).max(0.8) * 100.0).round() / 100.0,
                kind,
                color: pick(&mut r, palette(kind)).unwrap().to_string(),
                footprint: None,
            };
            let ring = rotated_rect(Point { x: p.x, z: p.z }, p.w, p.d, p.angle);
            if hash
                .near(p.x, p.z, 60.0)
                .iter()
                .any(|q: &BuildingPlacement| {
                    convex_overlap(
                        &ring,
                        &rotated_rect(Point { x: q.x, z: q.z }, q.w + 1.0, q.d + 1.0, q.angle),
                    )
                })
            {
                continue;
            }
            hash.insert(Point { x: p.x, z: p.z }, p.clone());
            out.push(p)
        }
    }
    out
}
pub fn stamp_pads(f: &mut HeightField, bs: &[BuildingPlacement], protected: Option<&[f32]>) {
    for b in bs {
        let r = b.w.hypot(b.d) / 2.0 + 3.0;
        let x0 = ((b.x - r + f.size / 2.0) / f.cell).floor().max(0.0) as usize;
        let x1 = ((b.x + r + f.size / 2.0) / f.cell)
            .ceil()
            .min((f.w - 1) as f64) as usize;
        let z0 = ((b.z - r + f.size / 2.0) / f.cell).floor().max(0.0) as usize;
        let z1 = ((b.z + r + f.size / 2.0) / f.cell)
            .ceil()
            .min((f.h - 1) as f64) as usize;
        let (c, s) = ((-b.angle).cos(), (-b.angle).sin());
        for z in z0..=z1 {
            for x in x0..=x1 {
                let px = x as f64 * f.cell - f.size / 2.0 - b.x;
                let pz = z as f64 * f.cell - f.size / 2.0 - b.z;
                let dd = (0.0f64.max((px * c - pz * s).abs() - b.w / 2.0))
                    .hypot(0.0f64.max((px * s + pz * c).abs() - b.d / 2.0));
                if dd > 3.0 {
                    continue;
                }
                let i = z * f.w + x;
                if protected.is_some_and(|q| q[i] > 0.98) {
                    continue;
                }
                f.data[i] += ((b.y - f.data[i] as f64) * (1.0 - dd / 3.0)) as f32;
            }
        }
    }
}

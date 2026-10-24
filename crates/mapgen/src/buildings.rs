#![allow(clippy::manual_clamp, clippy::collapsible_if)]
trait JsRound {
    fn js_round(self) -> f64;
}
impl JsRound for f64 {
    fn js_round(self) -> f64 {
        (self + 0.5).floor()
    }
}
fn setback(zone: Zone) -> f64 {
    match zone {
        Zone::Core => 0.5,
        Zone::Commercial => 1.2,
        Zone::Residential => 2.5,
        Zone::Suburb => 4.,
        Zone::Industrial => 3.,
        Zone::Park | Zone::Rural => 0.,
    }
}
use crate::js_math::JsMath;
use crate::{
    field::{sample, slope},
    geom::{
        SpatialHash, area, centroid, convex_overlap, dist, inset_polygon, oriented_box,
        point_in_polygon, rotated_rect,
    },
    random::{Rng, derive, pick, range},
    types::{Block, BuildingKind, BuildingPlacement, HeightField, Lot, Point, Zone},
};
fn palette(k: BuildingKind) -> &'static [&'static str] {
    match k {
        BuildingKind::Tower => &["#9fb7c9", "#b9c6d0", "#d9d2c3", "#8fa3b4"],
        BuildingKind::Office => &["#c9c2b4", "#b7b1a6", "#d3cbbd", "#a8b2b9"],
        BuildingKind::Apartments => &["#d8c3a0", "#e2cdb0", "#c9b49a", "#e6d7bd"],
        BuildingKind::Shop => &["#e4b98a", "#d99f7b", "#efc9a0", "#c98f6c"],
        BuildingKind::Townhouse => &["#d1a98f", "#c59a7e", "#dcb59c", "#b98c70"],
        BuildingKind::House => &["#e7d7b7", "#d8c7a2", "#f0e2c6", "#cdbf9f"],
        BuildingKind::Warehouse => &["#aab4bb", "#9ca7ae", "#b8c0c6", "#8f9aa2"],
        BuildingKind::Civic => &["#efe1b8", "#e8d8aa", "#f5e8c8"],
    }
}
fn type_and_height(zone: Zone, dc: f64, footprint: f64, rng: &mut Rng) -> (BuildingKind, f64) {
    let falloff = (-dc / 420.).js_exp();
    let lognormal = range(rng, -0.25, 0.3).js_exp();
    let (mut kind, mut h) = match zone {
        Zone::Core => {
            if footprint > 450. && rng() < 0.45 + falloff * 0.4 {
                let mut h = (40. + 110. * falloff) * lognormal;
                if rng() < 0.08 {
                    h *= 1.5;
                }
                (BuildingKind::Tower, h)
            } else {
                (
                    if rng() < 0.6 {
                        BuildingKind::Office
                    } else {
                        BuildingKind::Shop
                    },
                    (16. + 24. * falloff) * lognormal,
                )
            }
        }
        Zone::Commercial => {
            let k = if rng() < 0.5 {
                BuildingKind::Apartments
            } else if rng() < 0.7 {
                BuildingKind::Shop
            } else {
                BuildingKind::Office
            };
            (k, (12. + 20. * falloff) * lognormal)
        }
        Zone::Residential => {
            let k = if rng() < 0.6 {
                BuildingKind::Apartments
            } else {
                BuildingKind::Townhouse
            };
            let h = if k == BuildingKind::Apartments {
                (10. + 10. * falloff) * lognormal
            } else {
                8. * lognormal
            };
            (k, h)
        }
        Zone::Suburb => {
            let k = if rng() < 0.12 {
                BuildingKind::Townhouse
            } else {
                BuildingKind::House
            };
            (
                k,
                (if k == BuildingKind::House { 5.5 } else { 8. }) * lognormal,
            )
        }
        Zone::Industrial => (
            if rng() < 0.9 {
                BuildingKind::Warehouse
            } else {
                BuildingKind::Office
            },
            (8. + rng() * 6.) * lognormal,
        ),
        Zone::Park | Zone::Rural => (BuildingKind::Civic, 10.),
    };
    if rng() < 0.03 && zone != Zone::Industrial && zone != Zone::Suburb {
        kind = BuildingKind::Civic;
        h = h.max(14.);
    }
    (kind, h.max(4.).min(200.))
}
pub fn place_buildings(
    blocks: &[Block],
    f: &HeightField,
    centre: Point,
    seed: i32,
) -> Vec<BuildingPlacement> {
    let mut rng = derive(seed, "buildings");
    let mut out = Vec::new();
    let mut hash = SpatialHash::new(64.);
    for block in blocks {
        for lot in &block.lots {
            let Some(p) = fit_lot(lot, block.zone, f, centre, &mut rng) else {
                continue;
            };
            let poly = p
                .footprint
                .clone()
                .unwrap_or_else(|| rotated_rect(Point { x: p.x, z: p.z }, p.w, p.d, p.angle));
            let clash = hash
                .near(p.x, p.z, 60.)
                .iter()
                .any(|b: &BuildingPlacement| {
                    convex_overlap(
                        &poly,
                        &b.footprint.clone().unwrap_or_else(|| {
                            rotated_rect(Point { x: b.x, z: b.z }, b.w + 1., b.d + 1., b.angle)
                        }),
                    )
                });
            if clash {
                continue;
            }
            hash.insert(Point { x: p.x, z: p.z }, p.clone());
            out.push(p);
        }
    }
    out
}
fn fit_polygon(
    lot: &Lot,
    zone: Zone,
    f: &HeightField,
    centre: Point,
    rng: &mut Rng,
) -> Option<BuildingPlacement> {
    let inset = inset_polygon(&lot.polygon, setback(zone) + 0.6)?;
    if inset.len() < 3 || area(&inset) < 60. {
        return None;
    }
    let (angle, w, d, c) = oriented_box(&inset)?;
    if w.max(d) > 60. || w.min(d) < 5. {
        return None;
    }
    let heights: Vec<_> = inset.iter().map(|p| sample(f, p.x, p.z)).collect();
    let centre_h = sample(f, c.x, c.z);
    if slope(f, c.x, c.z) > 0.42
        || heights.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b))
            - heights.iter().fold(f64::INFINITY, |a, &b| a.min(b))
            > 9.
    {
        return None;
    }
    let pad = (heights.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)) + centre_h) / 2.;
    let (kind, h) = type_and_height(zone, dist(c, centre), area(&inset), rng);
    Some(BuildingPlacement {
        x: (c.x * 100.).js_round() / 100.,
        z: (c.z * 100.).js_round() / 100.,
        w: (w * 10.).js_round() / 10.,
        d: (d * 10.).js_round() / 10.,
        angle,
        h: (h * 10.).js_round() / 10.,
        y: (pad.max(0.8) * 100.).js_round() / 100.,
        kind,
        color: pick(rng, palette(kind)).unwrap().to_string(),
        footprint: Some(
            inset
                .into_iter()
                .map(|p| Point {
                    x: (p.x * 100.).js_round() / 100.,
                    z: (p.z * 100.).js_round() / 100.,
                })
                .collect(),
        ),
    })
}
fn fit_lot(
    lot: &Lot,
    zone: Zone,
    f: &HeightField,
    centre: Point,
    rng: &mut Rng,
) -> Option<BuildingPlacement> {
    if lot.frontage < 0 {
        return None;
    }
    if zone == Zone::Core || zone == Zone::Commercial {
        if let Some(p) = fit_polygon(lot, zone, f, centre, rng) {
            return Some(p);
        }
    }
    let a = lot.polygon[lot.frontage as usize];
    let b = lot.polygon[(lot.frontage as usize + 1) % lot.polygon.len()];
    let angle = crate::js_math::atan2(b.z - a.z, b.x - a.x);
    let (c, s) = (crate::js_math::cos(-angle), crate::js_math::sin(-angle));
    let local: Vec<_> = lot
        .polygon
        .iter()
        .map(|p| Point {
            x: p.x * c - p.z * s,
            z: p.x * s + p.z * c,
        })
        .collect();
    let front = Point {
        x: a.x * c - a.z * s,
        z: a.x * s + a.z * c,
    };
    let cl = centroid(&local);
    let inward = if cl.z > front.z { 1. } else { -1. };
    let (mut min_u, mut max_u, mut max_depth) = (f64::INFINITY, f64::NEG_INFINITY, 0.0_f64);
    for p in &local {
        min_u = min_u.min(p.x);
        max_u = max_u.max(p.x);
        max_depth = max_depth.max((p.z - front.z) * inward)
    }
    let setback = match zone {
        Zone::Core => 0.5,
        Zone::Commercial => 1.2,
        Zone::Residential => 2.5,
        Zone::Suburb => 4.,
        Zone::Industrial => 3.,
        _ => 0.,
    };
    let side = if zone == Zone::Core {
        0.6
    } else if zone == Zone::Commercial {
        1.2
    } else {
        2.5
    };
    let front_len = dist(a, b);
    let ucentre = (min_u + max_u) / 2.;
    let coverage = match zone {
        Zone::Core => 0.92,
        Zone::Commercial => 0.8,
        Zone::Residential => 0.62,
        Zone::Suburb => 0.45,
        Zone::Industrial => 0.7,
        _ => 0.,
    };
    let mut w = (front_len - 2. * side).min(max_u - min_u - 2. * side)
        * (if zone == Zone::Suburb { 0.7 } else { 0.95 });
    let mut d =
        ((max_depth - setback - if zone == Zone::Core { 1. } else { 4. }) * coverage).max(6.);
    w = w.min(match zone {
        Zone::Suburb => 16.,
        Zone::Residential => 24.,
        Zone::Industrial => 60.,
        _ => 44.,
    });
    d = d.min(match zone {
        Zone::Suburb => 14.,
        Zone::Residential => 20.,
        Zone::Industrial => 50.,
        _ => 36.,
    });
    if w < 6. || d < 6. {
        return None;
    }
    let place = |_ww: f64, dd: f64| {
        let lz = front.z + inward * (setback + dd / 2.);
        let lx = ucentre;
        Point {
            x: lx * crate::js_math::cos(angle) - lz * crate::js_math::sin(angle),
            z: lx * crate::js_math::sin(angle) + lz * crate::js_math::cos(angle),
        }
    };
    let mut pos = place(w, d);
    for _ in 0..8 {
        if rotated_rect(pos, w, d, angle)
            .iter()
            .all(|p| point_in_polygon(*p, &lot.polygon))
        {
            break;
        }
        w *= 0.88;
        d *= 0.92;
        if w < 6. || d < 6. {
            return None;
        }
        pos = place(w, d)
    }
    let rect = rotated_rect(pos, w, d, angle);
    if !rect.iter().all(|p| point_in_polygon(*p, &lot.polygon)) {
        return None;
    }
    let heights: Vec<_> = rect.iter().map(|p| sample(f, p.x, p.z)).collect();
    let centre_h = sample(f, pos.x, pos.z);
    if slope(f, pos.x, pos.z) > 0.42
        || heights.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b))
            - heights.iter().fold(f64::INFINITY, |a, &b| a.min(b))
            > 9.
    {
        return None;
    }
    let pad = ((heights.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)) + centre_h) / 2.).max(0.8);
    let (kind, h) = type_and_height(zone, dist(pos, centre), w * d, rng);
    Some(BuildingPlacement {
        x: (pos.x * 100.).js_round() / 100.,
        z: (pos.z * 100.).js_round() / 100.,
        w: (w * 10.).js_round() / 10.,
        d: (d * 10.).js_round() / 10.,
        angle,
        h: (h * 10.).js_round() / 10.,
        y: (pad * 100.).js_round() / 100.,
        kind,
        color: pick(rng, palette(kind)).unwrap().to_string(),
        footprint: None,
    })
}
pub fn stamp_pads(f: &mut HeightField, buildings: &[BuildingPlacement], protected: Option<&[f32]>) {
    let (w, h) = (f.w, f.h);
    for b in buildings {
        let margin = 3.;
        let r = b.w.js_hypot(b.d) / 2. + margin;
        let x0 = (((b.x - r + f.size / 2.) / f.cell).floor().max(0.)) as usize;
        let x1 = (((b.x + r + f.size / 2.) / f.cell)
            .ceil()
            .min((w - 1) as f64)) as usize;
        let z0 = (((b.z - r + f.size / 2.) / f.cell).floor().max(0.)) as usize;
        let z1 = (((b.z + r + f.size / 2.) / f.cell)
            .ceil()
            .min((h - 1) as f64)) as usize;
        let (c, s) = ((-b.angle).js_cos(), (-b.angle).js_sin());
        for z in z0..=z1 {
            for x in x0..=x1 {
                let px = x as f64 * f.cell - f.size / 2. - b.x;
                let pz = z as f64 * f.cell - f.size / 2. - b.z;
                let lx = (px * c - pz * s).abs();
                let lz = (px * s + pz * c).abs();
                let dd = (0f64.max(lx - b.w / 2.)).js_hypot(0f64.max(lz - b.d / 2.));
                if dd > margin {
                    continue;
                }
                let i = z * w + x;
                if protected.is_some_and(|p| f64::from(p[i]) > 0.98) {
                    continue;
                }
                let t = 1. - dd / margin;
                f.data[i] = ((f.data[i] as f64) + (b.y - f.data[i] as f64) * t) as f32;
            }
        }
    }
}

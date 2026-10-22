#![allow(clippy::chunks_exact_to_as_chunks)]
//! The generator's little-endian int16 centimetre encodings, including chunk order.
use crate::city_types::Surface;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub const PACK_CHUNK_SIZE: f64 = 128.0;
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for b in bytes.chunks(3) {
        let a = b[0];
        let c = b.get(1).copied().unwrap_or(0);
        let d = b.get(2).copied().unwrap_or(0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 3) << 4) | (c >> 4)) as usize] as char);
        out.push(if b.len() > 1 {
            TABLE[(((c & 15) << 2) | (d >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if b.len() > 2 {
            TABLE[(d & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn clamp_cm(v: f64) -> i16 {
    crate::random::js_round(v * 100.0).clamp(-32768.0, 32767.0) as i16
}
/// Matches Math.round, including negative half-centimetre ties toward +infinity.
pub fn pack_heights(heights: &[f64]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(heights.len() * 2);
    for &h in heights {
        bytes.extend_from_slice(&clamp_cm(h).to_le_bytes());
    }
    bytes
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackedLayer {
    pub counts: Vec<usize>,
    pub xyz: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackedSurface {
    pub asphalt: PackedLayer,
    pub sidewalks: PackedLayer,
    pub white: PackedLayer,
    pub yellow: PackedLayer,
}
pub fn chunk_origin(key: &str) -> crate::types::Point {
    let (x, z) = key.split_once(',').expect("chunk key");
    crate::types::Point {
        x: x.parse::<f64>().unwrap() * PACK_CHUNK_SIZE,
        z: z.parse::<f64>().unwrap() * PACK_CHUNK_SIZE,
    }
}
pub fn pack_layer(polygons: &[Vec<f64>], origin: crate::types::Point) -> PackedLayer {
    let counts = polygons.iter().map(|p| p.len() / 3).collect();
    let mut bytes = Vec::with_capacity(polygons.iter().map(|p| p.len() * 2).sum());
    for polygon in polygons {
        for p in polygon.chunks_exact(3) {
            for v in [p[0] - origin.x, p[1], p[2] - origin.z] {
                bytes.extend_from_slice(&clamp_cm(v).to_le_bytes());
            }
        }
    }
    PackedLayer {
        counts,
        xyz: base64(&bytes),
    }
}
pub fn pack_surface(surface: &Surface, origin: crate::types::Point) -> PackedSurface {
    let of = |color: &str| {
        surface
            .markings
            .iter()
            .filter(|m| m.color == color)
            .map(|m| m.polygon.clone())
            .collect::<Vec<_>>()
    };
    PackedSurface {
        asphalt: pack_layer(&surface.asphalt, origin),
        sidewalks: pack_layer(&surface.sidewalks, origin),
        white: pack_layer(&of("white"), origin),
        yellow: pack_layer(&of("yellow"), origin),
    }
}
fn centroid_key(p: &[f64]) -> String {
    let mut x = 0.0;
    let mut z = 0.0;
    let n = (p.len() / 3) as f64;
    for v in p.chunks_exact(3) {
        x += v[0];
        z += v[2];
    }
    format!(
        "{},{}",
        (x / n / PACK_CHUNK_SIZE).floor() as i64,
        (z / n / PACK_CHUNK_SIZE).floor() as i64
    )
}
pub fn pack_surface_chunks(surface: &Surface) -> Value {
    let mut buckets: BTreeMap<String, Surface> = BTreeMap::new();
    for p in &surface.asphalt {
        buckets
            .entry(centroid_key(p))
            .or_default()
            .asphalt
            .push(p.clone());
    }
    for p in &surface.sidewalks {
        buckets
            .entry(centroid_key(p))
            .or_default()
            .sidewalks
            .push(p.clone());
    }
    for m in &surface.markings {
        buckets
            .entry(centroid_key(&m.polygon))
            .or_default()
            .markings
            .push(m.clone());
    }
    let mut out = serde_json::Map::new();
    for (key, surface) in buckets {
        let packed = pack_surface(&surface, chunk_origin(&key));
        out.insert(key, serde_json::to_value(packed).unwrap());
    }
    Value::Object(out)
}
/// `city_from_map` returns unpacked terrain; only the envelope packs those heights.
pub fn pack_city(city: &Value) -> Result<Value, String> {
    let heights = city
        .get("terrain")
        .and_then(|t| t.get("heights"))
        .and_then(Value::as_array)
        .ok_or("An artifact needs terrain")?;
    let heights = heights
        .iter()
        .map(|h| h.as_f64().ok_or("terrain height must be finite"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = city.clone();
    out["terrain"] = json!({"cm":base64(&pack_heights(&heights))});
    Ok(out)
}
pub fn artifact(city: &Value) -> Result<Value, String> {
    Ok(json!({"format":"afterhours-city","version":7,"city":pack_city(city)?}))
}

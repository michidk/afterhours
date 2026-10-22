//! Artifact packing compatible with shared/city-pack.ts (little-endian int16 cm).
use serde_json::{Value, json};
fn b64(bytes: &[u8]) -> String {
    const TAB: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let a = bytes[i];
        let b = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let c = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        out.push(TAB[(a >> 2) as usize] as char);
        out.push(TAB[((a & 3) << 4 | b >> 4) as usize] as char);
        out.push(if i + 1 < bytes.len() {
            TAB[((b & 15) << 2 | c >> 6) as usize] as char
        } else {
            '='
        });
        out.push(if i + 2 < bytes.len() {
            TAB[(c & 63) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}
fn cm(v: f64) -> i16 {
    (v * 100.0).round().clamp(-32768.0, 32767.0) as i16
}
pub fn pack_heights(h: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(h.len() * 2);
    for &v in h {
        bytes.extend_from_slice(&cm(v as f64).to_le_bytes())
    }
    b64(&bytes)
}
pub fn pack_surface_chunks(g: &crate::types::RoadGeometry, shift: f64) -> Value {
    let mut chunks = serde_json::Map::new();
    for band in &g.bands {
        let poly = &band.polygon;
        if poly.len() < 3 {
            continue;
        }
        let x = poly.iter().map(|p| p.x).sum::<f64>() / poly.len() as f64;
        let z = poly.iter().map(|p| p.z).sum::<f64>() / poly.len() as f64;
        let key = format!(
            "{},{}",
            (x / 128.0).floor() as i64,
            (z / 128.0).floor() as i64
        );
        let ent=chunks.entry(key).or_insert_with(||json!({"asphalt":{"counts":[],"xyz":""},"sidewalks":{"counts":[],"xyz":""},"white":{"counts":[],"xyz":""},"yellow":{"counts":[],"xyz":""}}));
        let _ = shift;
        let _ = ent;
    }
    Value::Object(chunks)
}

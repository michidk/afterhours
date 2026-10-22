//! Version-7 city packing primitives. These use the same signed little-endian
//! centimetre representation as `shared/city-pack.ts`.

use base64::{Engine as _, engine::general_purpose::STANDARD};

fn centimetres(value: f64) -> i16 {
    (value.round() as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

fn centimetres_from_metres(value: f64) -> i16 {
    centimetres(value * 100.0)
}

pub fn pack_heights(heights: &[f64]) -> String {
    let mut bytes = Vec::with_capacity(heights.len() * 2);
    for &height in heights {
        bytes.extend_from_slice(&centimetres_from_metres(height).to_le_bytes());
    }
    STANDARD.encode(bytes)
}

pub fn unpack_heights(encoded: &str) -> Result<Vec<f64>, base64::DecodeError> {
    let bytes = STANDARD.decode(encoded)?;
    let (pairs, _) = bytes.as_chunks::<2>();
    Ok(pairs
        .iter()
        .map(|chunk| i16::from_le_bytes(*chunk) as f64 / 100.0)
        .collect())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackedLayer {
    pub counts: Vec<usize>,
    pub xyz: String,
}

pub fn pack_layer(polygons: &[Vec<[f64; 3]>], origin_x: f64, origin_z: f64) -> PackedLayer {
    let counts = polygons.iter().map(Vec::len).collect();
    let mut bytes = Vec::new();
    for polygon in polygons {
        for [x, y, z] in polygon {
            bytes.extend_from_slice(&centimetres_from_metres(*x - origin_x).to_le_bytes());
            bytes.extend_from_slice(&centimetres_from_metres(*y).to_le_bytes());
            bytes.extend_from_slice(&centimetres_from_metres(*z - origin_z).to_le_bytes());
        }
    }
    PackedLayer {
        counts,
        xyz: STANDARD.encode(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terrain_uses_signed_little_endian_centimetres() {
        let encoded = pack_heights(&[-1.23, 2.34]);
        assert_eq!(unpack_heights(&encoded).unwrap(), vec![-1.23, 2.34]);
    }
    #[test]
    fn layers_keep_polygon_counts_and_offsets() {
        let layer = pack_layer(&[vec![[128.0, 1.0, -256.0]]], 128.0, -256.0);
        assert_eq!(layer.counts, vec![1]);
        assert_eq!(
            STANDARD.decode(layer.xyz).unwrap(),
            vec![0, 0, 100, 0, 0, 0]
        );
    }
}

//! The JavaScript generator's mulberry32 stream, with the same i32 wrapping and
//! operation order.  All generated values are f64, matching JavaScript Number.

pub type Rng = Box<dyn FnMut() -> f64>;

pub fn mulberry(seed: i32) -> Rng {
    let mut state = seed as u32;
    Box::new(move || {
        state = state.wrapping_add(0x6d2b79f5);
        let mut t = (state ^ (state >> 15)).wrapping_mul(1 | state);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    })
}

pub fn derive(seed: i32, label: &str) -> Rng {
    let mut hash = (seed as u32) ^ 0x9e3779b9;
    for byte in label.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x01000193);
    }
    mulberry(hash as i32)
}

pub fn range(rng: &mut Rng, lo: f64, hi: f64) -> f64 {
    lo + rng() * (hi - lo)
}

pub fn pick<'a, T>(rng: &mut Rng, values: &'a [T]) -> Option<&'a T> {
    values.get((rng() * values.len() as f64).floor() as usize)
}

pub fn shuffle<T>(rng: &mut Rng, values: &mut [T]) {
    for i in (1..values.len()).rev() {
        let j = (rng() * (i + 1) as f64).floor() as usize;
        values.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_mulberry32_reference_values() {
        let mut rng = mulberry(713);
        let got: Vec<_> = (0..4).map(|_| rng()).collect();
        assert_eq!(
            got,
            vec![
                0.574331468436867,
                0.39385727792978287,
                0.57327532581985,
                0.8244242179207504,
            ]
        );
    }

    #[test]
    fn derived_stream_is_independent() {
        let mut a = derive(713, "terrain");
        let mut b = derive(713, "roads");
        assert_ne!(a(), b());
    }
}

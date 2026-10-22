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

const GRAD: [[f64; 2]; 8] = [
    [1.0, 1.0],
    [-1.0, 1.0],
    [1.0, -1.0],
    [-1.0, -1.0],
    [1.0, 0.0],
    [-1.0, 0.0],
    [0.0, 1.0],
    [0.0, -1.0],
];
const F2: f64 = 0.3660254037844386;
const G2: f64 = 0.21132486540518713;

#[derive(Clone, Debug)]
pub struct Noise {
    perm: [u8; 512],
}

impl Noise {
    pub fn new(rng: &mut Rng) -> Self {
        let mut p: Vec<u8> = (0..=255).collect();
        shuffle(rng, &mut p);
        let mut perm = [0; 512];
        for (i, value) in perm.iter_mut().enumerate() {
            *value = p[i & 255];
        }
        Self { perm }
    }
    pub fn at(&self, x: f64, y: f64) -> f64 {
        let s = (x + y) * F2;
        let i = (x + s).floor() as i32;
        let j = (y + s).floor() as i32;
        let t = f64::from(i + j) * G2;
        let x0 = x - (f64::from(i) - t);
        let y0 = y - (f64::from(j) - t);
        let (i1, j1) = if x0 > y0 { (1, 0) } else { (0, 1) };
        let x1 = x0 - f64::from(i1) + G2;
        let y1 = y0 - f64::from(j1) + G2;
        let x2 = x0 - 1.0 + 2.0 * G2;
        let y2 = y0 - 1.0 + 2.0 * G2;
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let mut n = 0.0;
        for (dx, dy, gi) in [
            (x0, y0, self.perm[ii + self.perm[jj] as usize]),
            (
                x1,
                y1,
                self.perm[ii + i1 as usize + self.perm[jj + j1 as usize] as usize],
            ),
            (x2, y2, self.perm[ii + 1 + self.perm[jj + 1] as usize]),
        ] {
            let mut q = 0.5 - dx * dx - dy * dy;
            if q > 0.0 {
                q *= q;
                let g = GRAD[gi as usize & 7];
                n += q * q * (g[0] * dx + g[1] * dy);
            }
        }
        70.0 * n
    }
    pub fn fbm(&self, x: f64, y: f64, octaves: usize, lacunarity: f64, gain: f64) -> f64 {
        let (mut sum, mut amp, mut norm, mut frequency) = (0.0, 1.0, 0.0, 1.0);
        for _ in 0..octaves {
            sum += amp * self.at(x * frequency, y * frequency);
            norm += amp;
            amp *= gain;
            frequency *= lacunarity;
        }
        sum / norm
    }
    pub fn ridged(&self, x: f64, y: f64, octaves: usize, lacunarity: f64, gain: f64) -> f64 {
        let (mut sum, mut amp, mut norm, mut frequency, mut weight) = (0.0, 1.0, 0.0, 1.0, 1.0);
        for _ in 0..octaves {
            let mut signal = 1.0 - self.at(x * frequency, y * frequency).abs();
            signal = signal * signal * weight;
            weight = (signal * 2.0).clamp(0.0, 1.0);
            sum += amp * signal;
            norm += amp;
            amp *= gain;
            frequency *= lacunarity;
        }
        sum / norm
    }
}

pub fn smoothstep(a: f64, b: f64, value: f64) -> f64 {
    let t = ((value - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
pub fn clamp(value: f64, lo: f64, hi: f64) -> f64 {
    value.max(lo).min(hi)
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

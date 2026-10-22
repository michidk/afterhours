//! V8 fdlibm routines needed where a one-bit trigonometric difference changes
//! oriented-box tie selection and therefore the recursive lot subdivision.
unsafe extern "C" {
    fn afterhours_v8_sin(x: f64) -> f64;
    fn afterhours_v8_cos(x: f64) -> f64;
    fn afterhours_v8_atan2(y: f64, x: f64) -> f64;
    fn afterhours_v8_exp(x: f64) -> f64;
}
pub fn sin(x: f64) -> f64 {
    unsafe { afterhours_v8_sin(x) }
}
pub fn cos(x: f64) -> f64 {
    unsafe { afterhours_v8_cos(x) }
}
pub fn atan2(y: f64, x: f64) -> f64 {
    unsafe { afterhours_v8_atan2(y, x) }
}
pub fn exp(x: f64) -> f64 {
    unsafe { afterhours_v8_exp(x) }
}

/// V8 FastMathHypot's two-argument order, including its scaling rounding.
pub fn hypot(x: f64, z: f64) -> f64 {
    let a = x.abs();
    let b = z.abs();
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let m = a.max(b);
    if m == 0. {
        return 0.;
    }
    (a / m * (a / m) + b / m * (b / m)).sqrt() * m
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node26_math_keeps_oriented_box_ties() {
        assert_eq!(sin(-2.6623118036400992), -0.4611411737423962);
        assert_eq!(cos(2.18403598161692), -0.5755198258855536);
        assert_eq!(atan2(1.23456789, 9.87654321), 0.12435499342522296);
        assert_eq!(hypot(1.23456789, 9.87654321), 9.9534046262581);
        assert_eq!(exp(-0.25), 0.7788007830714049);
    }
}

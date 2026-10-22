//! V8 fdlibm routines needed where a one-bit trigonometric difference changes
//! oriented-box tie selection and therefore the recursive lot subdivision.
unsafe extern "C" {
    fn afterhours_v8_sin(x: f64) -> f64;
    fn afterhours_v8_cos(x: f64) -> f64;
    fn afterhours_v8_atan2(y: f64, x: f64) -> f64;
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

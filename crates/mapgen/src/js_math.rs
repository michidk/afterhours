//! V8 fdlibm routines needed where a one-bit trigonometric difference changes
//! oriented-box tie selection and therefore the recursive lot subdivision.
unsafe extern "C" {
    fn afterhours_v8_sin(x: f64) -> f64;
    fn afterhours_v8_cos(x: f64) -> f64;
    fn afterhours_v8_atan2(y: f64, x: f64) -> f64;
    fn afterhours_v8_exp(x: f64) -> f64;
    fn afterhours_v8_tan(x: f64) -> f64;
    fn afterhours_v8_acos(x: f64) -> f64;
    fn afterhours_v8_log1p(x: f64) -> f64;
    fn afterhours_v8_pow(x: f64, y: f64) -> f64;
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
pub fn tan(x: f64) -> f64 {
    unsafe { afterhours_v8_tan(x) }
}
pub fn acos(x: f64) -> f64 {
    unsafe { afterhours_v8_acos(x) }
}
pub fn log1p(x: f64) -> f64 {
    unsafe { afterhours_v8_log1p(x) }
}
pub fn pow(x: f64, y: f64) -> f64 {
    unsafe { afterhours_v8_pow(x, y) }
}

/// `f64` methods with V8's exact results; the generator must match Node bit for bit, and
/// the system libm differs from V8's fdlibm in the last place.
pub trait JsMath {
    fn js_sin(self) -> f64;
    fn js_cos(self) -> f64;
    fn js_tan(self) -> f64;
    fn js_acos(self) -> f64;
    fn js_exp(self) -> f64;
    fn js_log1p(self) -> f64;
    fn js_pow(self, y: f64) -> f64;
    fn js_atan2(self, x: f64) -> f64;
    fn js_hypot(self, z: f64) -> f64;
}
impl JsMath for f64 {
    fn js_sin(self) -> f64 {
        sin(self)
    }
    fn js_cos(self) -> f64 {
        cos(self)
    }
    fn js_tan(self) -> f64 {
        tan(self)
    }
    fn js_acos(self) -> f64 {
        acos(self)
    }
    fn js_exp(self) -> f64 {
        exp(self)
    }
    fn js_log1p(self) -> f64 {
        log1p(self)
    }
    fn js_pow(self, y: f64) -> f64 {
        pow(self, y)
    }
    fn js_atan2(self, x: f64) -> f64 {
        atan2(self, x)
    }
    fn js_hypot(self, z: f64) -> f64 {
        hypot(self, z)
    }
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
    }
}

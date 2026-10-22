//! Helpers for comparing native stage dumps with the TypeScript oracle.

use serde_json::Value;

#[derive(Debug, Default, PartialEq)]
pub struct Difference {
    pub path: String,
    pub expected: Value,
    pub actual: Value,
}

pub fn first_difference(expected: &Value, actual: &Value) -> Option<Difference> {
    compare(expected, actual, "$", true)
}

/// Compare every numerical value exactly, including floats parsed from TS dumps.
pub fn first_difference_exact(expected: &Value, actual: &Value) -> Option<Difference> {
    compare(expected, actual, "$", false)
}

fn compare(
    expected: &Value,
    actual: &Value,
    path: &str,
    allow_tolerance: bool,
) -> Option<Difference> {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            let af = a.as_f64()?;
            let bf = b.as_f64()?;
            let tolerance = 1e-9 * af.abs().max(bf.abs()).max(1.0);
            let integers = (a.is_i64() && b.is_i64()) || (a.is_u64() && b.is_u64());
            let equal = if integers {
                a == b
            } else {
                af == bf || (allow_tolerance && (af - bf).abs() <= tolerance)
            };
            if equal {
                None
            } else {
                Some(Difference {
                    path: path.into(),
                    expected: expected.clone(),
                    actual: actual.clone(),
                })
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(Difference {
                    path: format!("{path}.length"),
                    expected: a.len().into(),
                    actual: b.len().into(),
                });
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(i, (x, y))| compare(x, y, &format!("{path}[{i}]"), allow_tolerance))
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.len() != b.len() {
                return Some(Difference {
                    path: path.into(),
                    expected: expected.clone(),
                    actual: actual.clone(),
                });
            }
            a.iter().find_map(|(key, value)| match b.get(key) {
                Some(other) => compare(value, other, &format!("{path}.{key}"), allow_tolerance),
                None => Some(Difference {
                    path: format!("{path}.{key}"),
                    expected: value.clone(),
                    actual: Value::Null,
                }),
            })
        }
        _ if expected == actual => None,
        _ => Some(Difference {
            path: path.into(),
            expected: expected.clone(),
            actual: actual.clone(),
        }),
    }
}

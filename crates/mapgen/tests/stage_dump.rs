use afterhours_mapgen::parity::first_difference;
use serde_json::json;

#[test]
fn stage_comparator_reports_first_path_and_allows_relative_float_tolerance() {
    assert!(first_difference(&json!({"x": 100.0}), &json!({"x": 100.00000005})).is_none());
    let difference = first_difference(&json!({"x": 1, "y": 2}), &json!({"x": 1, "y": 3})).unwrap();
    assert_eq!(difference.path, "$.y");
}

#[test]
fn integer_differences_are_exact_even_at_large_magnitudes() {
    assert!(first_difference(&json!(1_000_000_000), &json!(1_000_000_001)).is_some());
    assert!(
        first_difference(
            &json!(9_007_199_254_740_992u64),
            &json!(9_007_199_254_740_993u64)
        )
        .is_some()
    );
    assert!(first_difference(&json!(1), &json!(1.0)).is_none());
}

#[test]
fn stage_comparator_keeps_integers_strings_and_lengths_exact() {
    let difference =
        first_difference(&json!({"id":1_000_000_000}), &json!({"id":1_000_000_001})).unwrap();
    assert_eq!(difference.path, "$.id");
    assert_eq!(
        first_difference(&json!(["x"]), &json!(["y"])).unwrap().path,
        "$[0]"
    );
    assert_eq!(
        first_difference(&json!([1, 2]), &json!([1])).unwrap().path,
        "$.length"
    );
}

#[test]
fn exact_comparator_rejects_one_ulp_and_preserves_large_integers() {
    use afterhours_mapgen::parity::first_difference_exact;
    assert!(
        first_difference_exact(&json!(1.0), &json!(f64::from_bits(1.0_f64.to_bits() + 1)))
            .is_some()
    );
    assert!(first_difference_exact(&json!(1), &json!(1.0)).is_none());
    let a = json!(9_007_199_254_740_992_u64);
    let b = json!(9_007_199_254_740_993_u64);
    assert!(first_difference(&a, &b).is_some());
    assert!(first_difference_exact(&a, &b).is_some());
}

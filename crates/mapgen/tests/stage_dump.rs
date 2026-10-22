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

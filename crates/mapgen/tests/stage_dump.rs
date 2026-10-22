use afterhours_mapgen::parity::first_difference;
use serde_json::json;

#[test]
fn stage_comparator_reports_first_path_and_allows_relative_float_tolerance() {
    assert!(first_difference(&json!({"x": 100.5}), &json!({"x": 100.50000005})).is_none());
    let difference = first_difference(&json!({"x": 1, "y": 2}), &json!({"x": 1, "y": 3})).unwrap();
    assert_eq!(difference.path, "$.y");
}

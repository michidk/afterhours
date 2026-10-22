use afterhours_mapgen::{city::city_from_map, pipeline::generate_map, types::MapOptions};
use std::{env, fs};
fn main() {
    let a: Vec<String> = env::args().collect();
    let seed = a
        .iter()
        .position(|x| x == "--seed")
        .and_then(|i| a.get(i + 1))
        .and_then(|x| x.parse().ok())
        .unwrap_or(713);
    let out = a
        .iter()
        .position(|x| x == "--out")
        .and_then(|i| a.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "data/city.json".into());
    let mut p = |s: &str| eprintln!("  {s}");
    let map = generate_map(
        MapOptions {
            seed,
            size: 3072.,
            cell: 8.,
            debug: false,
        },
        Some(&mut p),
    );
    let value = city_from_map(&map);
    if let Some(parent) = std::path::Path::new(&out).parent() {
        fs::create_dir_all(parent).unwrap()
    }
    fs::write(&out, serde_json::to_string_pretty(&value).unwrap() + "\n").unwrap();
    println!(
        "Generated city {seed}: {} road segments, {} buildings -> {out}",
        map.roads.edges.len(),
        map.buildings.len()
    );
}

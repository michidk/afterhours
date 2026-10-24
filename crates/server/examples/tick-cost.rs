//! Per-tick cost of the real city: boots like `main.rs`, joins one player and times `step()`
//! as debug cars pile up.   cargo run --release -p afterhours-server --example tick-cost
use afterhours_server::lab::Lab;
use std::time::Instant;

fn main() {
    let mut lab = Lab::boot(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/city.json"));
    lab.join(1);
    for _ in 0..120 {
        lab.step();
    }
    for extra in [0, 10, 30, 60] {
        for _ in 0..extra {
            lab.debug(1, serde_json::json!({ "kind": "spawn", "model": "sedan" }));
            for _ in 0..4 {
                lab.step();
            }
        }
        let start = Instant::now();
        let mut worst = 0.0f64;
        for _ in 0..90 {
            let t = Instant::now();
            lab.step();
            worst = worst.max(t.elapsed().as_secs_f64() * 1000.0);
        }
        let cars = lab.seen[&1]
            .values()
            .filter(|e| e.kind == afterhours_protocol::Kind::Car)
            .count();
        println!(
            "pop {:?} | +{extra:<3} spawned: {} entities in view ({cars} cars), {:.1} ms/tick avg, {:.1} ms worst (budget 33.3)",
            lab.game.population(),
            lab.seen[&1].len(),
            start.elapsed().as_secs_f64() * 1000.0 / 90.0,
            worst
        );
    }
}

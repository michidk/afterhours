use crate::types::Point;
use std::collections::{HashMap, HashSet, VecDeque};

pub fn lake_shorelines(
    heights: &[f64],
    side: usize,
    step: f64,
    half: f64,
    seeds: &[u8],
    level: f64,
) -> Vec<Vec<Point>> {
    let mut wet = vec![0u8; heights.len()];
    let mut queue = VecDeque::new();
    for i in 0..seeds.len() {
        if seeds[i] != 0 && heights[i] < level {
            wet[i] = 1;
            queue.push_back(i);
        }
    }
    while let Some(i) = queue.pop_front() {
        let x = i % side;
        let z = i / side;
        for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)] {
            let nx = x as i32 + dx;
            let nz = z as i32 + dz;
            if nx < 0 || nz < 0 || nx >= side as i32 || nz >= side as i32 {
                continue;
            }
            let n = nz as usize * side + nx as usize;
            if wet[n] == 0 && heights[n] < level {
                wet[n] = 1;
                queue.push_back(n);
            }
        }
    }
    let mut points: HashMap<String, Point> = HashMap::new();
    let mut links: HashMap<String, Vec<String>> = HashMap::new();
    let crossing = |a: usize, b: usize, points: &mut HashMap<String, Point>| -> String {
        let (a, b) = if a > b { (b, a) } else { (a, b) };
        let key = format!("{}:{}", a, b);
        if !points.contains_key(&key) {
            let t = (level - heights[a]) / (heights[b] - heights[a]);
            points.insert(
                key.clone(),
                Point {
                    x: ((a % side) as f64 + ((b % side) as f64 - (a % side) as f64) * t) * step
                        - half,
                    z: ((a / side) as f64 + ((b / side) as f64 - (a / side) as f64) * t) * step
                        - half,
                },
            );
        }
        key
    };
    for z in 0..side - 1 {
        for x in 0..side - 1 {
            let i = z * side + x;
            for tri in [[i, i + 1, i + side], [i + 1, i + side + 1, i + side]] {
                let mut cuts = Vec::new();
                for k in 0..3 {
                    let a = tri[k];
                    let b = tri[(k + 1) % 3];
                    if wet[a] != wet[b] {
                        cuts.push(crossing(a, b, &mut points));
                    }
                }
                if cuts.len() != 2 {
                    continue;
                }
                let a = cuts[0].clone();
                let b = cuts[1].clone();
                links.entry(a.clone()).or_default().push(b.clone());
                links.entry(b).or_default().push(a);
            }
        }
    }
    let mut rings = Vec::new();
    let mut seen = HashSet::new();
    let keys: Vec<String> = links.keys().cloned().collect();
    for start in keys {
        if seen.contains(&start) {
            continue;
        }
        let mut ring = Vec::new();
        let mut key = Some(start.clone());
        while let Some(k) = key {
            if seen.contains(&k) {
                break;
            }
            seen.insert(k.clone());
            ring.push(*points.get(&k).unwrap());
            key = links
                .get(&k)
                .and_then(|ns| ns.iter().find(|n| !seen.contains(*n)).cloned());
        }
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }
    rings
}

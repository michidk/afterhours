//! Scene lab for scripts and AI agents: boots the real city and game loop in-process and
//! answers one JSON command per line on stdin with one JSON reply per line on stdout.
//!   scene-lab [path/to/city.json]
//!   echo '{"cmd":"help"}' | scene-lab
use afterhours_server::lab::Lab;
use std::io::{BufRead, Write};

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "data/city.json".into());
    let mut lab = Lab::boot(&path);
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str(&line) {
            Ok(command) => lab.exec(&command),
            Err(e) => serde_json::json!({"ok": false, "error": e.to_string()}),
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}

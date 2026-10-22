//! Server diagnostics for the debug "Server stats" window (`ServerDiagnostics` in
//! `shared/debug.ts`): process CPU and memory from `/proc` and the cgroup, and per-tick
//! timing recorded around `Game::step`. Linux counters only; anything unreadable reports 0.
use serde_json::{Value, json};
use std::{cell::Cell, collections::VecDeque, fs, time::Instant};

const WINDOW: usize = 600;
const MIB: f64 = 1024.0 * 1024.0;

/// Wall and CPU milliseconds of the newest ticks, plus lateness totals since startup.
pub struct Diagnostics {
    budget_ms: f64,
    wall: VecDeque<f64>,
    cpu: VecDeque<f64>,
    backlog_ms: f64,
    late: u32,
    dropped_ms: f64,
    started: Cell<(Instant, f64)>,
    tick: Option<(Instant, f64)>,
}

fn read(path: &str) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Nanoseconds this thread has spent on a CPU (`schedstat`'s first field).
fn thread_cpu_ns() -> f64 {
    read("/proc/thread-self/schedstat")
        .and_then(|s| s.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0)
}

/// Seconds of CPU the whole process has used (user + system, 100 ticks per second).
fn process_cpu_s() -> f64 {
    let Some(stat) = read("/proc/self/stat") else {
        return 0.0;
    };
    // The command name may hold spaces; the fields we want follow its closing parenthesis.
    let rest = stat.rsplit_once(')').map_or("", |(_, r)| r);
    let f: Vec<&str> = rest.split_whitespace().collect();
    let ticks = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    (ticks(11) + ticks(12)) / 100.0
}

/// `Key:   1234 kB` in a `/proc` file, in MiB.
fn kb(file: &str, key: &str) -> f64 {
    read(file)
        .and_then(|s| {
            s.lines().find_map(|l| {
                l.strip_prefix(key)?
                    .trim_start_matches(':')
                    .split_whitespace()
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
        })
        .map_or(0.0, |v| v * 1024.0 / MIB)
}

fn cgroup(file: &str) -> Option<f64> {
    read(&format!("/sys/fs/cgroup/{file}"))?.trim().parse().ok()
}

fn p95(v: &VecDeque<f64>) -> f64 {
    let mut s: Vec<f64> = v.iter().copied().collect();
    s.sort_by(f64::total_cmp);
    s.get(((s.len() as f64 * 0.95).ceil() as usize).saturating_sub(1))
        .copied()
        .unwrap_or(0.0)
}

impl Diagnostics {
    pub fn new(tick_rate: u32) -> Self {
        Self {
            budget_ms: 1000.0 / tick_rate as f64,
            wall: VecDeque::new(),
            cpu: VecDeque::new(),
            backlog_ms: 0.0,
            late: 0,
            dropped_ms: 0.0,
            started: Cell::new((Instant::now(), process_cpu_s())),
            tick: None,
        }
    }

    /// Call right before a tick runs; `lag_ms` is how long after its slot the tick started.
    pub fn begin(&mut self, lag_ms: f64) {
        self.backlog_ms = lag_ms;
        // The interval delays rather than bursts, so a late tick drops that time.
        if lag_ms > self.budget_ms {
            self.late += 1;
            self.dropped_ms += lag_ms;
        }
        self.tick = Some((Instant::now(), thread_cpu_ns()));
    }

    /// Call right after the tick ran, on the same thread.
    pub fn end(&mut self) {
        let Some((start, cpu)) = self.tick.take() else {
            return;
        };
        for (window, v) in [
            (&mut self.wall, start.elapsed().as_secs_f64() * 1000.0),
            (&mut self.cpu, (thread_cpu_ns() - cpu) / 1e6),
        ] {
            if window.len() == WINDOW {
                window.pop_front();
            }
            window.push_back(v);
        }
    }

    pub fn report(&self, players: usize, entities: usize) -> Value {
        let (since, cpu_then) = self.started.get();
        let (now, cpu_now) = (Instant::now(), process_cpu_s());
        let elapsed = now.duration_since(since).as_secs_f64();
        // Average since the last report, so a window polled every second reads as the last second.
        let cpu_percent = if elapsed > 0.2 {
            self.started.set((now, cpu_now));
            100.0 * (cpu_now - cpu_then) / elapsed
        } else {
            0.0
        };
        let rss = kb("/proc/self/status", "VmRSS");
        let host = kb("/proc/meminfo", "MemTotal");
        let limit = cgroup("memory.max")
            .map_or(host, |b| b / MIB)
            .min(host.max(1.0));
        let used = cgroup("memory.current").map_or(0.0, |b| b / MIB);
        let available = (kb("/proc/meminfo", "MemAvailable")).min(if used > 0.0 {
            limit - used
        } else {
            f64::MAX
        });
        json!({
            "cpuPercent": cpu_percent,
            "memoryPercent": if limit > 0.0 { 100.0 * rss / limit } else { 0.0 },
            "memoryLimitMB": limit,
            "tickBudgetMs": self.budget_ms,
            "tickCpuP95Ms": p95(&self.cpu),
            "tickP95Ms": p95(&self.wall),
            "tickMaxMs": self.wall.iter().copied().fold(0.0, f64::max),
            "backlogMs": self.backlog_ms,
            // The tick loop delays instead of bursting, so there are never catch-up ticks.
            "catchUpTicks": 0,
            "droppedMs": self.dropped_ms,
            "late": self.late,
            "memoryMB": rss.round(),
            // The panel's "JS heap" row: here the process's anonymous (heap) memory.
            "heapUsedMB": kb("/proc/self/status", "RssAnon"),
            "heapLimitMB": limit,
            "availableMemoryMB": available.max(0.0),
            "players": players,
            "entities": entities,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field of `ServerDiagnostics` in `shared/debug.ts`, which the window formats blindly.
    const FIELDS: [&str; 17] = [
        "cpuPercent",
        "memoryPercent",
        "memoryLimitMB",
        "tickBudgetMs",
        "tickCpuP95Ms",
        "tickP95Ms",
        "tickMaxMs",
        "backlogMs",
        "catchUpTicks",
        "droppedMs",
        "late",
        "memoryMB",
        "heapUsedMB",
        "heapLimitMB",
        "availableMemoryMB",
        "players",
        "entities",
    ];

    #[test]
    fn the_report_has_every_field_the_window_reads() {
        let mut d = Diagnostics::new(30);
        for lag in [0.0, 5.0, 80.0] {
            d.begin(lag);
            let busy = Instant::now();
            while busy.elapsed().as_millis() < 2 {}
            d.end();
        }
        let r = d.report(3, 7);
        for f in FIELDS {
            assert!(r[f].as_f64().is_some_and(f64::is_finite), "{f}: {}", r[f]);
        }
        assert_eq!(
            (r["players"].as_u64(), r["entities"].as_u64()),
            (Some(3), Some(7))
        );
        assert_eq!(r["late"], 1, "only the 80 ms start was late");
        assert!(r["tickP95Ms"].as_f64().unwrap() >= 2.0);
        assert!(
            r["memoryMB"].as_f64().unwrap() > 0.0,
            "reads /proc on Linux"
        );
    }
}

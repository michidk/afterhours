# Deferred spatial rebuild experiment

Verdict: inconclusive for normal tick cost, with no measured improvement in
worst-tick time. The candidate is rejected and is not deployed.

The candidate preserved the eager grid rebuild before AI decisions and deferred
the post-movement rebuild until a snapshot or debug query read the grid. The
intended saving was to avoid rebuilding the published grid on ticks without
readers. Eighteen targeted simulation, spatial-publication, traffic, and LOD
tests passed, including movement across grid cells without snapshot readers.

The [raw summaries](lag-spatial-ab.json) retain five alternating before/after
pairs, twenty seconds per run with five real socket clients, using Node 24 on
the VibePod's x86 host. Both variants used the same saved city and profiling
script. This is a local CPU diagnostic, not production latency acceptance.
Socket clients and the profiler share the server process. Concurrent host work
remains a source of noise; one baseline run recorded one late tick. That run is
retained in the results.

| Metric                 | Original median and range | Candidate median and range |
| ---------------------- | ------------------------- | -------------------------- |
| Tick p95 wall time     | 24.8 ms, 22.9–35.3 ms     | 24.1 ms, 22.9–25.0 ms      |
| Tick p95 thread CPU    | 23.9 ms, 22.5–30.9 ms     | 23.2 ms, 22.5–24.3 ms      |
| Maximum tick wall time | 44.0 ms, 41.9–120.6 ms    | 46.2 ms, 45.5–68.8 ms      |

The small shift in p95 is within run variation. Spatial work accounted for only
about 7.6% of the earlier local profile, so skipping a fraction of its rebuilds
could not remove most server work. Neither the baseline nor the candidate
reproduced production's long scheduling gaps. Do not treat this as a lag fix.

The candidate source and test remain isolated in
`/home/vibepod/workspaces/afterhours-spatial-lag`; raw profile logs are in
`/tmp/lag-spatial-ab`. No gameplay source change from this experiment is in
main. The next diagnostic should measure the production game thread's runnable
CPU wait separately from thread CPU time and garbage collection, using its own
unprivileged scheduler counters. Average node utilization cannot establish
whether that thread was scheduled during a pause.

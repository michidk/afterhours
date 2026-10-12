# AFTERHOURS backlog

- [x] Reproduce helicopter snapback with delayed snapshots. The regression measured a 3.75 m backwards jump for Sparrow and 2.75 m for Atlas at the 250 ms prediction cutoff.
- [x] Keep prediction bounded without switching to old authority; retain input history and preserve render continuity. Both helicopters pass deterministic jitter and one-second snapshot-stall scenarios.
- [x] Verify turns, braking, acknowledged stop, and correction timing after a render stall. The 28 flight/prediction tests pass, including collision and ownership checks.
- [x] Run the complete 214-test suite, including real WebSocket transport, collision prediction, aircraft handling, and ownership tests. All pass.
- [x] Pass formatting, architecture boundaries, TypeScript, and the production build.
- [x] Deploy gameplay commit `8ce4352` to the canonical preview; local/public HTTP doctor checks pass. Shared T3 public flight verified takeoff, climb, held forward movement, release, and ordered 120/1000/120 ms added incoming delay. The delayed run reached 22 pending commands and recovered; its largest sampled backward step was 1.1 cm. Evidence: `test-results/flight-public/evidence.json` (local, ignored).
- [ ] Profile sustained server simulation cost and measure native browser performance. Production with zero connected players averaged 24.8 ticks/sec during one 20.8-second observation; five overlapping 600-tick health windows reported p95 68–77 ms against the 33.33 ms target. After reducing the CPU request to 200m to leave deployment-hook headroom, an initial check still reported p95 67.5 ms. No CPU limit is set. Moving out of the preview did not establish playable performance. Evidence is local at `/tmp/afterhours-cluster-health.json`.

- [x] Remove loading-screen island label, tagline, and neighbourhood note. Verified the production image and a 960px headless screenshot from the cluster URL.

- [x] Publish a tested AMD64/ARM64 production container on every main push and deploy one authoritative city through the sibling k8s repository. CI image `5fbdfe3` is pinned by digest; production is ready at `https://afterhours.k8s.lohr.dev` on `work.lohr.dev`, with debug disabled. HTTPS/WSS, saved city, asset delivery and reconnect checks pass. Software-rendered browser failures remain visible independently of image publication.

# AFTERHOURS backlog

- [x] Reproduce helicopter snapback with delayed snapshots. The regression measured a 3.75 m backwards jump for Sparrow and 2.75 m for Atlas at the 250 ms prediction cutoff.
- [x] Keep prediction bounded without switching to old authority; retain input history and preserve render continuity. Both helicopters pass deterministic jitter and one-second snapshot-stall scenarios.
- [x] Verify turns, braking, acknowledged stop, and correction timing after a render stall. The 28 flight/prediction tests pass, including collision and ownership checks.
- [x] Run the complete 214-test suite, including real WebSocket transport, collision prediction, aircraft handling, and ownership tests. All pass.
- [x] Pass formatting, architecture boundaries, TypeScript, and the production build.
- [x] Deploy gameplay commit `8ce4352` to the canonical preview; local/public HTTP doctor checks pass. Shared T3 public flight verified takeoff, climb, held forward movement, release, and ordered 120/1000/120 ms added incoming delay. The delayed run reached 22 pending commands and recovered; its largest sampled backward step was 1.1 cm. Evidence: `test-results/flight-public/evidence.json` (local, ignored).
- [ ] Investigate sustained server/browser slowness separately. The previous public browser check reported slow frames; this networking change does not establish a hardware performance pass.

- [ ] Remove loading-screen island label, tagline, and neighbourhood note; verify the simplified screen and deploy.

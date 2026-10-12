# AFTERHOURS backlog

- [x] Reproduce helicopter snapback with delayed snapshots. The regression measured a 3.75 m backwards jump for Sparrow and 2.75 m for Atlas at the 250 ms prediction cutoff.
- [x] Keep prediction bounded without switching to old authority; retain input history and preserve render continuity. Both helicopters pass deterministic jitter and one-second snapshot-stall scenarios.
- [x] Verify turns, braking, acknowledged stop, and correction timing after a render stall. The 28 flight/prediction tests pass, including collision and ownership checks.
- [x] Run the complete 214-test suite, including real WebSocket transport, collision prediction, aircraft handling, and ownership tests. All pass.
- [x] Pass formatting, architecture boundaries, TypeScript, and the production build.
- [ ] Deploy the fix and verify live helicopter flight.
- [ ] Investigate sustained server/browser slowness separately. The previous public browser check reported slow frames; this networking change does not establish a hardware performance pass.

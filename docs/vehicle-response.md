# Ramp and vehicle response verification

The ramp was previously visual geometry plus a speed-gated centre trigger. AI traffic targets 8 m/s, below the required 12 m/s. It now uses a shared solid wedge/slope on both authority and prediction, with no minimum launch speed. Contact prediction previously handled only static buildings/props; it now estimates nearby dynamic contacts with the same mass/angular solver while leaving final gameplay outcomes to the server.

Run `bun run test` and `bun run build`. Focused regressions are in `tests/ramps.test.ts`, `tests/prediction.test.ts`, and `tests/tyre-tracks.test.ts`:

During verification, concurrent city work migrated the schema from version 1 to version 2 before the saved artifact was regenerated. The first full rerun then failed to start its two test servers. A manual generation to a temporary artifact followed by `CITY_PATH`-selected testing passed all 84 tests, including the concurrent city regressions. After the shared saved artifact was regenerated to version 2 by that city work, the normal `bun run test` also passed all 84 tests. Formatting, import boundaries, types, and production build checks pass.

- A real AI route crosses the Paloma ramp below 12 m/s, rises above its 1.6 m lip and lands beyond it.
- Ground-level cars and pedestrians collide with solid ramp sides/back without being teleported onto the top.
- Predicted and authoritative car position/vertical velocity agree throughout ascent, jump and landing.
- Dynamic collision impulses agree with the server in a controlled two-car contact; snapshot entities remain unchanged, and only the server reduces health.
- Walking into a parked car matches authoritative movement without predicting knockdown.
- A delayed collision snapshot replays precisely the remaining input sequences and replaces provisional health with authority.
- Position/yaw corrections stay bounded, follow the short angular arc, and cannot smooth a player through a parked car.
- Rendering between input ticks leaves replay state unchanged, including wheel-slip arrays.
- First-frame slip emits rear-wheel marks without a packet. Tracks stitch by distance, reset after jumps/teleports/removal, and avoid refresh-rate-dependent mark growth.

The native browser at `http://localhost:5174` verified the actual client integration using software WebGL. The wedge renders at the shared dimensions ([screenshot](screenshots/physical-ramp.png)). A driven sedan climbed it, crossed its lip at y = 1.666 m with positive vertical velocity, and landed at y = 0. Injecting a cosmetic slip sample into the real trail renderer added two marks and uploaded one changed tile immediately with a 1/165-second update, below the former 200 ms wait. This component check uses synthetic slip and does not claim transport latency measurements.

A subsequent ordinary Comet GT handbrake drift produced 16 new marks in the driving client (18 total, including two prior component marks) and 26 visible marks in a second client observing the airfield. Both used the same server-owned vehicle; the observer generated its own tracks from remote state. Different sampling/camera timing gives different mark counts by design. Two software-rendered tabs required a 640 × 480 viewport for that interaction check; this is functional evidence, not a hardware performance result. [Raw browser observations](vehicle-response-test.json) include the ramp and drift states. An earlier observer polling attempt timed out and did not capture the drift; the successful check directly inspected the marks after the subsequent drift.

Remote future inputs, AI decisions and crowded contact chains cannot be predicted exactly. Remote cars retain their interpolation buffer; a local collision can therefore still need a correction under latency. This change does not claim full 3D suspension, stacking, continuous collision safety at arbitrary speeds, WAN testing, or a new GPU performance pass.

# Movement regression tests

Run the production browser test from a checkout that nobody else is editing:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run build
bun run test:browser
```

Playwright starts its own production server on port 4175 using the saved city. It enables debug inspection only in that process, rejects an already occupied test port, runs one browser at a time and stops the server afterward. The shared preview is untouched. CI runs this suite after the unit tests and build.

The test enters through the name form, waits for gameplay shaders and two rendered frames, holds W through real browser keyboard events, releases it, and compares server snapshots with the actual Babylon player node after each rendered frame. It checks repeated input delivery, walking distance, freezes between snapshots and stopping after release. It also opens F1, checks that ping and input acknowledgement values populate, and verifies authoritative aim and upper-body yaw against a stationary pointer while the lower body keeps its independent walking yaw, both before and after walking sideways. A second run adds 150 ms to incoming WebSocket messages. JSON attachments include sample timestamps, sequence and snapshot counters, authoritative and displayed positions, pending inputs, server health and browser errors. Failure traces and screenshots are saved in `test-results/`; view them with `bunx playwright show-report`.

The measured interval starts after shader readiness. Cold-start rendering stalls and real-device frame rates need separate checks.

Movement attachments also record prediction, reconciliation, scene-update, render and input-handler durations, plus mesh and vertex counts. Set `BROWSER_CPU_PROFILE=1` when running the suite to attach a Chrome CPU profile even when startup fails. Profiling adds overhead; use it to locate work, then rerun without it for the movement acceptance check.

For a diagnostic run on a busy host, `--timeout 300000` also extends startup's wait while reserving 30 seconds for gameplay. The default startup wait remains 90 seconds. The held-key interval and movement thresholds stay unchanged. The freeze check includes the gap before each moved frame, so a low frame rate cannot pass merely because every sampled frame moved.

These checks deliberately fail when the server cannot sustain movement. They do not replace a wall-clock failure with a longer wait for eventual movement. Inspect frame intervals and `/health` alongside movement samples to distinguish browser stalls, slow server ticks and network delay. The viewport is 640 by 450, with raster resolution halved for software WebGL. It checks movement in actual rendered frames without setting a GPU frame-rate target; deterministic prediction tests check the poses between snapshots.

For an isolated game server and containerized Chromium:

```sh
bun run test:browser:docker
```

This builds the existing Dockerfile, starts pinned headless Chromium with a loopback-only random CDP port, discovers the bridge gateway, and tears down its containers and image tag on exit. The game's test HTTP listener uses port 4175 so the browser container can reach it. This run is headless and does not appear in the shared T3 tab. No external skill helper is required. Use Docker on the shared VibePod host to keep the simulation out of the development shell's CPU-throttled cgroup.

`tests/runtime.test.ts` uses a controlled clock to reproduce a server tick taking 40 ms. It requires the runtime to yield to socket events after that tick, while permitting at most four catch-up ticks when they are cheap. `tests/input-timing.test.ts` checks actual socket input batching and acknowledgements with manually stepped authority. `tests/prediction.test.ts` covers delayed snapshots, collision agreement, bounded speculation and acknowledgement recovery without relying on machine speed.

## Managed preview runtime

`scripts/preview-docker.sh <full-commit-hash> <container-name>` builds a missing image from `git archive`, then starts that exact revision on the managed `PORT`. Set `PUBLIC_ORIGIN` to the registered HTTPS origin; `ALLOW_DEBUG=1` explicitly enables test inspection. Keep running it through `vibepod-preview run`, with the existing preview name and port. The command rebuilds after an environment restart clears Docker images, and reuses the image on ordinary restarts. It never builds uncommitted work from the shared checkout.

## Aim and traffic verification, 2026-10-12

The independent-aim build passed both browser scenarios before merging the newer traffic-population and ramp commits. On the combined revision, all 185 unit/integration tests, formatting, boundaries, types and the production build passed. Both headless scenarios then failed the unchanged real-time walking-speed assertion: approximately 2.20 and 2.59 m/s, below the 3 m/s minimum. Startup's harness wait now covers the application's separate download/render deadlines; gameplay assertions remain unchanged.

[Recorded evidence](aim-traffic-test.json) includes input timestamps, authoritative/displayed positions, server health and a separate five-sample CPU diagnostic. The server profile concentrated work in spatial queries and simulation steps. The shared host had a load average above 30 with an eight-core container quota, but CPU work also approached or exceeded the 33.33 ms tick budget in the isolated simulation samples. These results do not establish how much each contributor costs, and do not certify performance of the expanded population on hardware or WAN clients. The failing browser speed gate remains an open capacity issue.

After integrating citizen routines, particle effects and terrain, revision `835042e` passed all 206 tests in an isolated Docker build-stage image and built successfully. The final headless browser rerun still failed the walking-speed gate. Public HTTP and managed-preview diagnostics passed; the shared T3 browser loaded the character menu but blocked WSS with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. These limitations remain explicit rather than being counted as a successful end-to-end check.

The existing project headless browser harness subsequently passed a separate functional check against the authenticated canonical public URL: entry, held W delivery, sideways walking with independent mouse/upper-body aim, F1 diagnostics, and same-player reconnect. It recorded no page or HTTP errors. This uses a looser movement-distance check and does not replace the failing real-time speed gate. The horn bank also played successfully through the public sound-library page in the shared T3 browser.

## Scenery and corpse regression (2026-10-12)

A public preview could join successfully but show a frozen city with no player. The renderer threw while creating an NPC corpse: MessagePack encoded an explicitly undefined optional `character` property as null, bypassing the character builder's default argument. Snapshot encoding now omits undefined object fields while preserving explicit null entity-delta removals. The destruction-render regression sends an NPC corpse through the real encoder/decoder and verifies that it renders with the default appearance.

`bun run test:browser:docker --grep 'nighttime scenery'` checks the production build: at least 81 spawn chunks finish before entry, buildings more than 400 m away are resident, every intact loaded lamp has a nighttime ground-light pool, approaching a distant lamp leaves its pool lit, and daylight turns pools off. The 2026-10-12 headless run passed and captured both spawn and a distant street at midnight. This verifies behavior; it does not establish hardware frame-rate performance.

Local profiling subsequently found repeated whole-scene mesh scans in streamed geometry and fixture construction. Each synchronous builder now captures the appended mesh suffix, including batching replacements, rather than allocating a set of every existing mesh and filtering the scene. The ownership tests cover batching, eviction, pre-existing scenery and fixture lights. This removes work that grew with the loaded city; it does not by itself certify smooth movement or server capacity.

The subsequent unprofiled local held-W run still failed. During a 3.27-second sample it sent 60 inputs, authority advanced 6.245 m and only three rendered frames completed. Health reported a 136 ms tick p95, zero rejected messages and 241 entities. The renderer contained 10,592 meshes but only 239 active meshes. Both authority and rendering missed their timing targets. Concurrent workspace load was high, so this is a failed acceptance check, not a before/after speed comparison. All 220 unit/integration tests, the production container build, formatting, boundaries and TypeScript passed. Production promotion remains deferred.

## Bidirectional transport and scheduling

`tests/network-cadence.test.ts` runs `GameNetwork`, `Sessions`, binary snapshots and shared physics over real WebSockets. Virtual time controls ordered delivery independently in both directions, with 30–60 ms input delay and 40–70 ms snapshot delay. Client wakeups occur every 33, 50 or 80 ms. It checks sustained walking, command cadence, local freezes, bounded backward corrections and authority error, remote interpolation, aim delivery, stop convergence and bounded pending history. The city has no ambient actors or obstacles in this test, so it isolates timing; collision and flight regressions remain in their respective suites.

`tests/input-clock.test.ts` checks exact 30 Hz command production, monotonic scheduled timestamps, duplicate wakeups and suspension recovery. The real browser additionally pumps this clock before rendering. Neither deterministic test substitutes for the full-city wall-clock acceptance check above.

Startup coverage now follows the saved city's downtown reference, shared with server spawn selection. A regression checks a city centered at `(-272, 632)` and requires scenery and collision coverage at `(-261, 657)` before joining. The camera starts in that neighborhood too. The previous fixed origin forced a second scenery build after entering generated cities.

The server skips repeated static contact work only while a body's position, angle and planar velocity remain unchanged across solver passes. A local comparison against the original solver produced identical entity states at every tick of a 90-tick run of the saved city; contact, terrain and prediction regressions also cover displaced bodies. Unchanged headlight and street-light enabled states no longer trigger Babylon's whole-scene light resynchronization. The lighting regression checks both transitions and repeated updates.

Terrain uses Babylon submeshes with bounding-box frustum checks. The terrain regression verifies upward faces, unchanged vertex count, retained visible ground and exclusion of most island indices from a street-level view. This checks submitted geometry, not hardware frame rate.

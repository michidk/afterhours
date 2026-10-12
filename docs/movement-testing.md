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

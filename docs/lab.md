# Test worlds (the labs)

Two labs let you (or an AI agent) put the simulation in a known situation, apply controls,
and read back numbers. Both are deterministic, headless and need no browser or network.
Anything you reproduce by hand is a JSON snippet away from a regression test.

## Handling lab: one car, one piece of ground (`crates/physics`)

```sh
cargo run -q -p afterhours-physics --bin handling-lab -- --list          # named scenarios
cargo run -q -p afterhours-physics --bin handling-lab -- park-on-slope   # metrics as JSON
cargo run -q -p afterhours-physics --bin handling-lab -- corner-15 --trace   # + per-tick samples
cargo run -q -p afterhours-physics --bin handling-lab -- --json '{"model":"van","ground":{"kind":"curb","distance":20,"height":0.2},"start_speed":15,"script":[{"seconds":4,"throttle":0.5}]}'
```

A scenario is `{ground, model, start_speed, script, sample_every}`:

- `ground`: `flat` (default), `slope {degrees}`, `wall {distance}`, `curb {distance, height}`,
  `bumps {start, height, spacing, count}`. The car starts at the origin facing +z.
- `model`: `sedan`, `sport`, `van`. `start_speed`: m/s along the nose.
- `script`: steps of `{seconds, throttle -1..1, steer -1..1, brake}`.

Metrics: `top_speed`, `final_speed`, `max_pitch`, `max_roll` (rad), `max_hop` (largest vertical
speed), `max_height`, `max_lateral` (sideways slide), `mean_yaw_rate`, `distance`,
`stopped_after`, `final_vy`, and `pitch_wobble`/`roll_wobble` (peak-to-peak over the last
2 s: ~0 once settled). `crates/physics/tests/handling.rs` asserts these per model; add a preset to
`PRESETS` in `src/lab.rs` and a test there when you find a new problem.

### Watching it

`/lab.html` replays any scenario in the browser, in the same wasm physics the client predicts with
(`bun run build`, then open it on the running server; `bun run dev` also serves it):

- `/lab.html?scenario=corner-15&model=van` picks a named scenario and car.
- `/lab.html?json={"ground":{"kind":"wall","distance":30},"start_speed":20,"script":[{"seconds":4}]}`
  runs a custom one. The page shows the metrics next to the playback; orbit with the mouse.

The ground drawing in `client/lab.ts` mirrors `build` in `src/lab.rs`: keep them in step.

### Comparing with the original game

The car is meant to drive like the original TypeScript game on `main` (`shared/physics/vehicle.ts`).
`scripts/legacy-lab.ts` runs the same scenario JSON through that branch's own `predictStep`, and
`scripts/compare-handling.ts` prints both side by side (top speed, 0-20 time, stopping time,
coasting, turn rate, slide):

```sh
git worktree add --detach ../main-ref origin/main && ln -s "$PWD/node_modules" ../main-ref/node_modules
LEGACY_DIR=../main-ref bunx tsx scripts/compare-handling.ts
```

The same script covers walking (`"model": "walker"` in `handling-lab`; steps take `sprint`) and
helicopters, planes and boats (`craft-lab '{"model":"plane","script":[...]}'`, steps take `throttle`,
`steer`, `ascend`, `descend`, `brake`; set `CRAFT_LAB` to the built binary for the comparison).
Walking matches the original's paces (4.5 and 8 m/s, physique scaled), except that the original eases
to speed over about 0.1 s. Craft match to within a few percent; the server now steps them in the
original's four substeps per tick and caps every craft at its catalogue speed.

The Rust car applies the original's four-wheel tyre model (per-wheel rolling and lateral damping,
rate-limited steering, handbrake that locks the rear wheels, hard speed cap) to the Rapier body;
Rapier only supplies suspension, collisions and terrain. `the_sedan_drives_like_the_original` in
`crates/physics/tests/handling.rs` pins the original's numbers. Main only has flat ground, so slope,
wall and kerb scenarios have no counterpart.

## Scene lab: the real city and game loop (`crates/server`)

`scene-lab` boots `data/city.json` exactly like `main.rs` (world, parked fleet, props), joins
one player, and answers one JSON command per stdin line with one JSON line:

```sh
printf '%s\n' '{"cmd":"track"}' '{"cmd":"spawn","model":"sedan"}' '{"cmd":"board"}' \
  '{"cmd":"drive","ticks":60,"throttle":1,"every":20}' '{"cmd":"state","radius":20}' \
  | cargo run -q -p afterhours-server --bin scene-lab -- data/city.json
```

Send `{"cmd":"help"}` for the command list: `track`, `teleport`, `spawn`, `board`, `leave`,
`drive` (hold controls for N ticks, 30/s), `follow` (pursuit bot on the racetrack), `idle`,
`state`, `debug` (any raw debug command). `drive`, `follow` and `idle` reply with the car's
trace and metrics (`top_speed`, `max_tilt`, `max_hop`, `max_height`, `displacement`).
Errors come back as `{"ok":false,"error":...}`; nothing panics on bad input.

The same world is a Rust API for tests (`afterhours_server::lab::Lab`): see
`crates/server/tests/{scene,craft,lab}.rs`.

## Latency: the live lap bot

The scene lab has no latency model, so lag is measured with the real client stack against a
running server. `scripts/drive-client.ts` joins with `GameNetwork`, the predicted body and the
input clock, spawns a car, and `--pattern track` laps the racetrack in `data/city.json` with a
pure-pursuit driver while injecting one-way delay, jitter and spikes on its own socket:

```sh
bunx tsx scripts/drive-client.ts --url http://localhost:5174 --pattern track --speed 18 \
  --seconds 60 --delay 37 --jitter 20 --spike 150
```

It prints the per-second link counters and a summary: corrections (count, over 1 m, worst),
pending replay, drawn-speed error and hitches, lurches, freezes and the worst input delay. A good
lap on a 74 ms link with spikes has no corrections, a server queue of 2-3 and at most 6-8 pending
inputs. Frame-pacing numbers (hitches, freezes) move with host load; compare corrections and
pending inputs between runs.

## Known gaps

Prediction does not include props or other people, and a neighbour car's future steering is
unknown, so a head-on with a moving car can still correct. The scene lab drives one player; use
the lap bot or the socket tests in `crates/server/tests/session.rs` for latency.

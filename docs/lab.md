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

## Known gaps

The scene lab drives one player; it has no scripted second client or latency model, so
prediction/reconciliation problems still need a browser or the socket tests in
`crates/server/tests/session.rs`.

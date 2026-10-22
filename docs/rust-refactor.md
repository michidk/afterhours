# Goal: move the backend to Rust

Replace the Node server with a Rust server that owns gameplay, shares one physics
core with the browser through wasm, and generates its TypeScript protocol types.
Own as little code as possible: Rapier for physics, tokio/axum/tungstenite for
transport, serde + rmp-serde for the wire format, ts-rs for the types.

Done means: `cargo run -p afterhours-server` serves the game, the Node `server/`
directory is deleted, `bun run test` and `cargo test` pass, and the client
predicts with the same wasm physics the server runs.

## Phases

### Phase 1: physics crate (done, PR 1)

- [x] `crates/physics`: Rapier vehicles and characters, flat state export,
      snapshot/restore for replay.
- [x] wasm build (`scripts/build-physics.sh`) and native-vs-wasm parity check.

### Phase 2: server crate (in progress)

Milestone 2.1, transport and core loop:

- [x] `crates/protocol`: serde message types, ts-rs export to `shared/generated/`.
- [x] `crates/server`: axum HTTP (health, static `dist/`), WebSocket sessions,
      30 Hz tick, join/welcome, tick-stamped input queue with `lead`, delta
      snapshots against the client's acked frame, players as physics characters,
      enter/exit the two placeholder cars on a flat slab.
- [x] Integration test: two clients join, walk, see each other, enter a car.

Milestone 2.2, client on the new protocol:

- [x] `client/network` speaks the generated types; prediction uses the wasm
      physics with restore + replay; interpolation for remote entities.
- [x] Vite dev proxies `/ws`, `/health` and city routes to the Rust server
      (`bun run server` + `bun run dev`).

Milestone 2.3, gameplay parity (one PR per system, Node code deleted as each lands):

- [x] city loading and streaming (serve the prepared artifact, never generate it)
- [x] vehicles: enter/exit, seats, all catalog models
- [x] combat, inventory, pickups, grenades
- [x] destruction and debris
- [x] AI: traffic, citizens, pedestrians
- [ ] aircraft, watercraft, flooding, day/night
- [ ] debug commands and admin tools (opt-in)
- [ ] delete `server/`, port the `tests/` that cover server behaviour, update
      Dockerfile and README

### Phase 3: city generator in Rust

- [ ] port `mapgen/` and `scripts/prepare-city.ts` as `crates/mapgen`; keep the
      artifact format so the client does not change.

Step 1 foundations are committed on `t3/rust-mapgen`. The crate now has the
serializable Rust contracts for every `mapgen/types.ts` stage, the f64 mulberry
PRNG and seeded simplex noise, field sampling and distance transforms, the full
geometry primitive set, and a first-difference stage dump comparator. The
`scripts/mapgen-dump.ts` oracle writes terrain, erosion, hydrology, site, roads,
shaped terrain, blocks, buildings, parks, and vegetation snapshots. The Rust
`generate-city` binary intentionally exits until the native pipeline is complete;
it contains no TypeScript or shell bridge.

## Protocol decisions

- msgpack over WebSocket now; WebTransport is a later swap behind the same types.
- Inputs are tick-stamped (`tick`, `lead`) and carry edge events (interact, drop,
  reload, equip) in the same frame, so there is no separate event message to race.
- Snapshots are deltas against the client's last acknowledged frame; a client with
  no acked base gets a full snapshot.
- The TypeScript client never hand-mirrors server movement; it calls the wasm
  physics with the same inputs.

### Phase 3 road geometry and street fitting parity

`crates/mapgen/src/roadgeometry.rs` and `streetfit.rs` now port all functions and
helpers from the corresponding TypeScript files. The port preserves the junction
layout passes, arm and marking order, pedestrian links, profile relaxation,
Float32Array rounding at each array write, terrain triangle constraints, draping,
clipping, merging, welding, and T-junction sealing. `graph.rs` and `roads.rs` are
outside this change; tests load their inputs from the TypeScript oracle.

The default `cargo test -p afterhours-mapgen` runs committed, small TypeScript
fixtures covering each public operation and the helpers, including a ring edge,
acute junction, bridge, cul-de-sac, duplicate centreline points, crossed trims,
rotated pads, concave surfaces, avoided triangles, and layer-aware sealing.
Regenerate these fixtures with:

```sh
bun scripts/mapgen-geometry-fixtures.ts
```

The full acceptance suite uses seeds **713 and 42**, world size 3072 and cell
size 8. It compares every value of each output, reports the first differing JSON
path, and prints the maximum absolute and relative delta per output. This suite
is ignored by default because its debug run takes more than two minutes:

```sh
export PATH=$HOME/.cargo/bin:$PATH
cargo test -p afterhours-mapgen --test geometry_parity -- --ignored --nocapture
```

Without `MAPGEN_DUMP_ROOT`, the tests generate fresh TypeScript dumps into a
process-specific temporary directory. Tests within that process share each seed's
dump. To generate and inspect snapshots separately, or reuse them for a repeat
run, use:

```sh
bun scripts/mapgen-dump.ts --geometry-stages --seed 713 --out /tmp/afterhours-geometry/713
bun scripts/mapgen-dump.ts --geometry-stages --seed 42 --out /tmp/afterhours-geometry/42
MAPGEN_DUMP_ROOT=/tmp/afterhours-geometry \
  cargo test -p afterhours-mapgen --test geometry_parity -- --ignored --nocapture
```

The isolated stages compare smoothing, densification, geometry, profiles, stamped
terrain, road-cell weights, bridge decks, street polygons, fitted terrain after
real building pad stamping, and street queries at margins 0, 0.25 and 2. A chained
test also runs smoothing through street polygons directly from the input graph
without reloading intermediate graphs from TypeScript. Surface helper fixtures
compare draping, subtraction, merging, welding and sealing numerically too.

The checked Bun oracle and native debug build have **zero absolute and relative
delta for every output on both seeds**. No approximate, snapped, or reordered
comparison is used. The geometry suite uses the exact comparator for floats as well as integer
IDs, strings, lengths, and booleans. The older shared comparator still supports
`1e-9 * max(1, |a|, |b|)` for other ports. The geometry suite does not use it.

Three arithmetic details are required for that result:

- Read JSON with serde_json's `float_roundtrip` feature. Its default parser can
  move coordinates by an ULP and change which of two equally near road segments
  supplies a street polygon's height.
- Field samples subtract f32 values only after promotion to f64. Normalization
  divides each component by the length, matching JavaScript's operation order.
- Use `sqrt` for JavaScript's `Math.pow(x, 0.5)` knot calculation. The general
  Rust `powf(0.5)` path changed smoothing by up to 2.27e-13; JavaScript uses the
  square-root path, which matches exactly here.

The native `src/` code never starts Bun, Node, or tsx. Only integration tests start
the oracle, and the ordinary fixture tests require no JavaScript runtime.

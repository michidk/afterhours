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
- [x] aircraft, watercraft, flooding, day/night (kinematic craft in `craft.rs`; no
      roof or bystander collision, calm sea only, no AI boats yet)
- [x] debug commands and admin tools (the Dev tools drawer; always on, see README)
- [x] delete `server/`; gameplay tests are now Rust integration tests under
      `crates/server/tests`, the Dockerfile and README are updated

### Phase 3: city generator in Rust

- [x] port `mapgen/` and the city conversion as `crates/mapgen`; keep the
      artifact format so the client does not change. `cargo run --release -p
afterhours-mapgen --bin generate-city -- --seed 713` takes about 9 s and
      produces an artifact equal as JSON to the checked-in TypeScript output
      (`seed_713_artifact_matches_checked_in_city`); every stage also matches the
      TS oracle with zero delta (see the per-stage sections). `prepare-city.ts`
      runs the native binary (`CITY_GENERATOR`, default `cargo run`). Mesh baking
      stays in TypeScript because it renders through the client's Babylon builders.
      The TS generator stays as the parity oracle only.

      **Oracle engine matters.** Production runs on Node (V8), not Bun (JavaScriptCore).
      The two differ in the last bit of `sin`, `exp`, `pow` and `hypot`, enough to move
      lot subdivisions and river traces. The crate therefore routes every transcendental
      through `js_math` (V8's fdlibm, vendored in `src/v8_ieee754.cc`), and all parity
      tests use `node --import tsx`.

Step 1 foundations are committed on `t3/rust-mapgen`. The crate now has the
serializable Rust contracts for every `mapgen/types.ts` stage, the f64 mulberry
PRNG and seeded simplex noise, field sampling and distance transforms, the full
geometry primitive set, and a first-difference stage dump comparator. The
`scripts/mapgen-dump.ts` oracle writes terrain, erosion, hydrology, site, roads,
shaped terrain, blocks, buildings, parks, and vegetation snapshots. The Rust
`generate-city` binary intentionally exits until the native pipeline is complete;
it contains no TypeScript or shell bridge.

Step 2 is native Rust in `terrain.rs`, `hydrology.rs`, `shoreline.rs`, and
`site.rs`. Calculations use f64; buffers corresponding to TypeScript
`Float32Array` round to f32 only on writes. The field helpers preserve the
TypeScript sliding blur sums and intermediate distance-transform rounding.
Stable sorts, neighbour order, flood-heap ties, and shoreline insertion order
match the oracle.

The integration test runs unchanged TypeScript stages through
`scripts/mapgen-dump.ts --terrain-only`, then compares each checkpoint. It runs
both seeds at the full 385 × 385 runtime grid, checks integers, strings, array
lengths, and object keys exactly, and accepts float differences only within
`1e-9 * max(1, abs(expected), abs(actual))`. It reports the first differing JSON
path and maximum absolute and relative numeric deltas. JSON decoding enables
`float_roundtrip` so the comparison measures generator differences rather than
parser rounding.

Measured on this Linux worktree, in both debug and release parity tests:

| Checkpoint                                                                          | Seed 713 max absolute / relative delta | Seed 42 max absolute / relative delta |
| ----------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------- |
| Raw heightmap and flatness                                                          | 0 / 0                                  | 0 / 0                                 |
| First thermal erosion                                                               | 0 / 0                                  | 0 / 0                                 |
| Droplet erosion                                                                     | 0 / 0                                  | 0 / 0                                 |
| Second thermal erosion                                                              | 0 / 0                                  | 0 / 0                                 |
| Settle                                                                              | 0 / 0                                  | 0 / 0                                 |
| Keep main island                                                                    | 0 / 0                                  | 0 / 0                                 |
| Shape coast                                                                         | 0 / 0                                  | 0 / 0                                 |
| Priority fill: field and fill depth; D8 directions and flux                         | 0 / 0                                  | 0 / 0                                 |
| Hydrology: carved/refilled field, rivers, lakes, flow, masks, water/coast distances | 0 / 0                                  | 0 / 0                                 |
| Desirability and centre                                                             | 0 / 0                                  | 0 / 0                                 |
| Shorelines: sloping bowl, disconnected basin, and seed-specific terrain             | 0 / 0                                  | 0 / 0                                 |

No float-order exception or terrain-stage shortcut is needed for these seeds.
The tests are enabled by default and finish well below two minutes in debug.
Node (with the repo's tsx) is a test prerequisite; production `src/` never invokes it. Run:

```sh
export PATH=$HOME/.cargo/bin:$PATH
cargo test -p afterhours-mapgen --test terrain_parity -- --nocapture
cargo clippy -p afterhours-mapgen --all-targets -- -D warnings
```

To retain and reuse dumps:

```sh
node --import tsx scripts/mapgen-dump.ts --terrain-only --seed 713 --out /tmp/mapgen-dumps/713
node --import tsx scripts/mapgen-dump.ts --terrain-only --seed 42 --out /tmp/mapgen-dumps/42
export PATH=$HOME/.cargo/bin:$PATH
MAPGEN_DUMP_ROOT=/tmp/mapgen-dumps cargo test -p afterhours-mapgen --test terrain_parity -- --nocapture
```

The public `generate_heightmap(seed, size, cell)` returns `(Field, flatness)`;
`generate_heightmap_with_tuning` accepts custom tuning. The requested read-only
`generate_hydrology(&Field, seed, sea_level)` computes on a clone. The **pipeline
must call `generate_hydrology_in_place(&mut field, seed, sea_level)`** so site
scoring and roads see the filled basins and carved riverbeds, matching the
TypeScript pipeline. Both entry points use the same native implementation.
`desirability_field` and `choose_centre` consume that mutated field.

Phase 3 remains unchecked until the other stages are merged and the complete
seed 713 artifact comparison passes. Keep the TypeScript generator as the oracle;
it can be deleted when full artifact parity is trusted and equivalent fixtures
replace the oracle. `shortcut: Babylon mesh baking stays in TypeScript; upgrade
when a native mesh baker can reproduce the existing renderer's output`.

When integrating `pipeline.rs`, preserve this order from `mapgen/pipeline.ts`:

1. Heightmap; thermal erosion with 10 iterations and talus 0.6; droplets with
   `round(w * h * 0.7)` using `derive(seed, "droplets")`; thermal erosion with 4
   iterations and talus 0.6; settle radius 1; keep main island; shape coast.
2. Hydrology **in place**, with seed and sea level 0; desirability with the same
   seed; centre selection; roads using that field and hydrology.
3. Clone the field to `shaped`; smooth and densify road centrelines; build road
   geometry; solve profiles against the original field and geometry trims; stamp
   roads into `shaped`, retaining the returned road-cell mask; build bridges.
4. Blocks against `shaped`; place buildings; stamp building pads using the
   road-cell mask; sink terrain under asphalt and sidewalks, accounting for
   buildings and the shared street/kerb constants.
5. Parks against the final shaped field; vegetation with the geometry's street
   predicate. Preserve the original field as `terrain` and the modified clone as
   `shaped` in `GeneratedMap`.

Temporary stage functions that return empty/default outputs cannot be part of the
completed pipeline. The pipeline must call the native modules directly before
full artifact parity can be assessed.

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
node --import tsx scripts/mapgen-geometry-fixtures.ts
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
node --import tsx scripts/mapgen-dump.ts --geometry-stages --seed 713 --out /tmp/afterhours-geometry/713
node --import tsx scripts/mapgen-dump.ts --geometry-stages --seed 42 --out /tmp/afterhours-geometry/42
MAPGEN_DUMP_ROOT=/tmp/afterhours-geometry \
  cargo test -p afterhours-mapgen --test geometry_parity -- --ignored --nocapture
```

The isolated stages compare smoothing, densification, geometry, profiles, stamped
terrain, road-cell weights, bridge decks, street polygons, fitted terrain after
real building pad stamping, and street queries at margins 0, 0.25 and 2. A chained
test also runs smoothing through street polygons directly from the input graph
without reloading intermediate graphs from TypeScript. Surface helper fixtures
compare draping, subtraction, merging, welding and sealing numerically too.

The checked Node oracle and native debug build have **zero absolute and relative
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

The native `src/` code never starts Node or tsx. Only integration tests start
the oracle, and the ordinary fixture tests require no JavaScript runtime.

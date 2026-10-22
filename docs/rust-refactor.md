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

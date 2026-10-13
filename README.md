# AFTERHOURS

A living city. A stolen car. A story worth sharing.

A desktop browser urban sandbox: Babylon.js renders the city, and a CPU-only Node server owns gameplay in one shared world. This is a playable foundation tested with 16 local clients, not a large-scale persistent MMO.

## Run

Requires Node 24 and Bun 1.2.21 or newer.

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. A second tab or another device on your LAN joins the same city. Set `PORT` to change the port.

```sh
bun run check   # formatting, import boundaries, types
bun run test    # unit and real-WebSocket tests
bun run build   # production client
bun run start   # serve the built client and WebSocket endpoint
```

`start` runs in production mode with debug tools disabled. `ALLOW_DEBUG=1` explicitly enables them for everyone on that server, and development always enables them, so never expose dev mode publicly. See [debugging](docs/debugging.md).

Network and movement checks: `bun run test:network` (real WebSockets with delay and jitter) and `bun run test:browser` (held-key movement in Chromium). See [movement testing](docs/movement-testing.md).

## Controls

| Key                | Action                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| WASD / arrows      | Walk, swim, or fly helicopters; cars and watercraft use W/S throttle and A/D steer; planes use W throttle, S brake, A/D turn |
| Shift              | Sprint on foot; aircraft descend / enabled jetpack descent (left or right Shift)                                             |
| Space              | Sprint / car and watercraft handbrake / aircraft climb                                                                       |
| F                  | Take a seat, exit, or collect a weapon, ammo, or jetpack; airborne exits deploy a parachute                                  |
| Mouse              | Aim the upper body independently of walking; left click attacks                                                              |
| J                  | Punch / swing / fire                                                                                                         |
| 1–4                | Equip inventory slot                                                                                                         |
| G / R              | Drop active jetpack or equipped weapon / reload                                                                              |
| E / Q              | Same as Space / Shift: aircraft climb / descend; enabled jetpack thrust / descent                                            |
| B                  | Enable or disable equipped jetpack                                                                                           |
| L                  | Toggle car headlights and taillights from the driver seat                                                                    |
| Enter / H / Escape | Chat / help / close panels                                                                                                   |
| M / N / F1         | Island map / mute sound / development menu (debug-enabled servers) with tools, clock, camera and network stats               |

Standard gamepads use the left stick to move and steer, LT/RT to reverse/accelerate, A to brake or sprint, X to attack, Y to enter/exit, LB/RB to descend/ascend, B to reload, and the D-pad for inventory slots. View opens the map, Menu opens help, and the stick clicks toggle the jetpack and vehicle lights.

## What is in the city

- **Vehicles:** cars, helicopters, planes, boats and jet skis with shared multi-seat rides, plus jetpacks and parachutes.
- **Combat:** fists, bats, knives, pistols, SMGs, machine guns, flamethrowers and grenades, with server-owned inventory, ammunition and lag-compensated hits.
- **Population:** 84 AI traffic cars and 130 pedestrians with personalities, routes, signals and reactions to crime and crashes. See [traffic](docs/traffic.md).
- **Destruction:** palms, lamps, signs and hydrants can be knocked over or destroyed, then restore. See [destruction](docs/destruction.md).
- **Characters:** three builds (Runner, Regular, Tank) with customizable appearance, saved on the device.
- **Atmosphere:** day/night lighting and 149 CC0 sound clips ([credits](public/audio/CREDITS.md), [audio notes](docs/audio.md)).

## The city

The city is a versioned artifact (`data/city.json` plus baked meshes in `data/city-meshes.msgpack`). The server loads and validates both once at startup and sends the map to clients in chunks; nothing generates a city implicitly, and clients have no bundled or generated city. Set `CITY_PATH` and `CITY_MESH_PATH` to use other files.

Generation is a separate manual process:

```sh
bun run map:explore                                    # tune generation in the browser (http://localhost:5180)
bun run city:generate --seed 713 --out data/city.json  # write the city artifact
bun run city:meshes                                    # bake the static meshes
```

The generator in `mapgen/` builds an eroded island heightmap, rivers, a settlement, terrain-aware roads, blocks, lots and buildings. The checked-in seed 713 has about 4 km² of land, hills up to about 170 m and a downtown beside the main estuary. Building looks are twelve replaceable recipes in [shared/assets/buildings](shared/assets/buildings/README.md). See [city generation research](docs/city-generation-research.md) and [architecture](docs/architecture.md).

## Architecture

- `server/` owns all gameplay: movement, damage, pickups and ownership. It runs at 30 Hz and sends snapshots at 15 Hz.
- `client/` renders, plays audio and predicts local movement. Prediction is provisional and always reconciles with server snapshots.
- `shared/` holds protocol schemas, catalogs, spatial queries, navigation and the prediction-safe movement code both sides run.
- `mapgen/` and `scripts/` hold the offline city pipeline and tooling. Import boundaries between these are enforced by `bun run check`.

See [networking](docs/networking.md) and [physics](docs/physics.md).

## Hosting

```sh
docker compose up -d --build
```

This runs one non-root Node process behind Caddy with HTTPS, WebSockets, health checks and restart policies. Local defaults are https://localhost:8443 and HTTP port 8080. For a public deployment set `DOMAIN=game.example.com`, `HTTP_PORT=80` and `HTTPS_PORT=443`, with DNS pointing at the host. Behind another reverse proxy, set `PUBLIC_ORIGIN` to the browser's origin; WebSocket origin checks trust `X-Forwarded-Host` only from loopback peers.

`/health` reports tick timings, bytes, rejected messages, entity count and memory. Dynamic state (players, inventory, traffic damage, time) resets on restart, so run one replica per city. See [operations](docs/operations.md).

## Current limits

- Graphics are procedural low-poly. There are no interiors, touch controls, accounts, moderation, saves or missions.
- The urban plateau is level and building collision is rectangular. The generator does not yet place ramps or paved surfaces.
- Vehicles use a planar solver with separate altitude, not full suspension or aerodynamics.
- The server keeps up to three input commands per player and discards the oldest on larger bursts, so a new stop reaches the simulation within about 100 ms plus network transit. Stalls longer than 250 ms release controls and correct.
- Sixteen moving clients have been tested locally, never over a real WAN. Server tick time under load has exceeded the 33 ms budget in some measurements; see [operations](docs/operations.md).
- Automated browser tests use software rendering (SwiftShader), so their frame times are not hardware evidence. CI therefore skips the 250 ms frame-freeze check that local runs enforce.
- The wire protocol is versioned, so clients must refresh after a deployment.
- Fonts load from Google Fonts with local fallbacks.

## More documentation

[Architecture](docs/architecture.md) · [Networking](docs/networking.md) · [Physics](docs/physics.md) · [Traffic](docs/traffic.md) · [Water](docs/water.md) · [Destruction](docs/destruction.md) · [Audio](docs/audio.md) · [Debugging](docs/debugging.md) · [Map controls](docs/map-controls.md) · [Movement testing](docs/movement-testing.md) · [Playtesting](docs/playtesting.md) · [Operations](docs/operations.md)

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

Network and movement checks: `bun run test:network` (real WebSockets with delay and jitter), `bun run test:browser` (held-key movement in Chromium), and `bun run probe:drive -- --profile spiky` (deterministic jittered-link driving replay, profiles `none|lan|mild|moderate|spiky|wan`). `bun run bot:drive -- --url http://localhost:5173 --delay 60 --jitter 40 --spike 150` joins a running debug-enabled server as a second player with the real prediction stack, drives a car at full speed through an injected delay on its own socket only, and prints per-second networking stats plus the server health counters. See [movement testing](docs/movement-testing.md).

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
| L                  | Toggle car headlights and taillights from the driver seat; they switch on by themselves when you take the wheel after dark   |
| Enter / H / Escape | Chat / help / close panels                                                                                                   |
| M / N / F1         | Island map / mute sound / development menu (debug-enabled servers) with tools, clock, camera and network stats               |

Standard gamepads use the left stick to move and steer, LT/RT to reverse/accelerate, A to brake or sprint, X to attack, Y to enter/exit, LB/RB to descend/ascend, B to reload, and the D-pad for inventory slots. View opens the map, Menu opens help, and the stick clicks toggle the jetpack and vehicle lights.

## What is in the city

- **Vehicles:** cars, helicopters, planes, boats and jet skis with shared multi-seat rides, plus jetpacks and parachutes. Taking the driver seat of a car makes its AI driver and AI passengers get out; human passengers stay aboard.
- **Combat:** fists, bats, knives, pistols, SMGs, machine guns, flamethrowers and grenades, with server-owned inventory, ammunition and lag-compensated hits.
- **Population:** 160 AI traffic cars and 300 pedestrians with personalities, routes, signals and reactions to crime and crashes. Pedestrians follow the generated sidewalks and cross only at crosswalks when the crossed traffic has a red light; fleeing, fighting or dodging citizens may leave the sidewalk. See [traffic](docs/traffic.md).
- **Crashes:** cars take damage from the speed of an impact: a bump below 15 km/h is free, a 70 km/h wall costs about a third of a sedan's health, a 100 km/h wall leaves it running, and only harder hits set it alight, followed by an explosion six seconds later. The explosion throws everyone aboard clear alive with 25 damage; aircraft crews keep their height and open a parachute. A car driven into water deeper than 0.8 m floods: its engine and lights die, it drifts to a stop and sinks, its occupants can swim out, and it explodes 10 seconds later. Fast, sliding or handbraked turns leave rubber on streets, hills and the airfield. Tuning lives in `TUNING.crashSafeSpeed` and `TUNING.crashDamage`.
- **Destruction:** palms, lamps, signs and hydrants can be knocked over or destroyed, then restore. See [destruction](docs/destruction.md).
- **Weapon crates:** wooden crates stand at the kerb of about one in three street segments away from junctions. Two punches (or any weapon, crash or blast) break one open and drop a random weapon with a full magazine and full reserve; the crate comes back after 90 seconds.
- **Characters:** three builds (Runner, Regular, Tank) with customizable appearance, saved on the device.
- **Camera:** the follow camera dithers a building out only while that building is between the camera and the player, or the camera is inside it. A building beside you stays solid. The fade is a screen-door pattern, not transparency, so shadows and depth stay intact.
- **Atmosphere:** day/night lighting and 149 CC0 sound clips ([credits](public/audio/CREDITS.md), [audio notes](docs/audio.md)). Sounds are local: engines, tyres, fire and footsteps fade out within about 30 m, aircraft and horns within 45 m, gunfire within 55 m and explosions within 75 m, and another player's inventory or life-state cues are never heard.

## The city

The city is a versioned artifact (`data/city.json` plus baked meshes in `data/city-meshes.msgpack`). The server loads and validates both once at startup and sends the map to clients in chunks; nothing generates a city implicitly, and clients have no bundled or generated city. Set `CITY_PATH` and `CITY_MESH_PATH` to use other files.

Generation is a separate manual process:

```sh
bun run map:explore                                    # tune generation in the browser (http://localhost:5180)
bun run city:generate --seed 713 --out data/city.json  # write the city artifact
bun run city:meshes                                    # bake the static meshes
```

The generator in `mapgen/` builds an eroded island heightmap, rivers, a settlement, terrain-aware roads, blocks, lots and buildings. The checked-in seed 713 has about 4 km² of land, hills up to about 170 m and a downtown beside the main estuary. Building looks are twelve replaceable recipes in [shared/assets/buildings](shared/assets/buildings/README.md). Streets are drawn as polygons over an 8 m terrain grid; the converter lowers the grid until no terrain shows through asphalt or sidewalks. Physics still follows the terrain, so where two streets at different heights run side by side, vehicles can sit up to about half a metre below the drawn asphalt. Bridges stand on embankments built up to deck height, so boats cannot pass under them. Lakes are swimmable water at their own level; rivers are drawn only and are too shallow to swim. Boats stay on the sea. AI cars stop at each junction's stop line. Signals give the straightest pair of arms at each junction one phase and the other arms the other; at a few four-way junctions whose side arms are not opposite, those side arms are green together. See [city generation research](docs/city-generation-research.md) and [architecture](docs/architecture.md).

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

`/health` reports tick timings, bytes, rejected messages, entity count and memory. Client frame and network profiling is opt-in with `?profile=1`; see [playtesting](docs/playtesting.md). Dynamic state (players, inventory, traffic damage, time) resets on restart, so run one replica per city. See [operations](docs/operations.md).

## Current limits

- Graphics are procedural low-poly. There are no interiors, touch controls, accounts, moderation, saves or missions.
- Cars use shared tire forces, slope gravity and ballistic vertical motion. Terrain contact cannot pull them down cliffs; crests preserve launch momentum. Vehicle pitch, roll, suspension and stacking are not simulated. Building collision remains rectangular. The generator does not yet place ramps or paved surfaces.
- Vehicles use a planar solver with separate altitude, not full suspension or aerodynamics.
- The server buffers two spare input commands per player, kept there by the browser's input clock; a tick with nothing buffered repeats the last movement controls and acknowledges that slot in advance, so the late command is never stepped twice and the driver sees a correction only if it changed controls at exactly that moment. The input clock reduces its send rate as the server queue deepens, and prediction uses the exact interval scheduled for each command. Pacing adapts to sustained slowdown and drops its slow-rate estimate when the server buffer drains. An overloaded server can still slow gameplay; stalls longer than 250 ms release controls and correct.
- AI traffic and pedestrians that no player can reach within the prediction horizon are simulated at 30 Hz instead of 120 Hz, and distant pedestrians re-plan every fourth tick; everything within reach keeps full-rate physics. A debug camera moved far from every player can show them. See [networking](docs/networking.md).
- Sixteen moving clients have been tested locally, never over a real WAN. Server tick time under load has exceeded the 33 ms budget in some measurements; see [operations](docs/operations.md).
- Automated browser tests use software rendering (SwiftShader), so their frame times are not hardware evidence. CI therefore skips the 250 ms frame-freeze check that local runs enforce.
- Remote traffic uses a 100–250 ms adaptive interpolation buffer; uneven delivery adds display latency. Extrapolation remains capped at 100 ms. The client reconnects after five seconds without replies while the browser is responsive, or when outgoing traffic exceeds 4 KiB or stays queued for 250 ms.
- Protocol 8 requires a refresh after deployment. Snapshots carry the last driving controls for remote cars and boats; new input changes still need a snapshot and can cause collision corrections.
- Server stalls recover with complete world ticks, bounded to eight ticks of backlog. Longer pauses or sustained CPU overload can still cause slow motion and corrections. Contact display transitions are smoothed in both directions.
- Fonts load from Google Fonts with local fallbacks.

## More documentation

[Architecture](docs/architecture.md) · [Networking](docs/networking.md) · [Physics](docs/physics.md) · [Traffic](docs/traffic.md) · [Water](docs/water.md) · [Destruction](docs/destruction.md) · [Audio](docs/audio.md) · [Debugging](docs/debugging.md) · [Map controls](docs/map-controls.md) · [Movement testing](docs/movement-testing.md) · [Playtesting](docs/playtesting.md) · [Operations](docs/operations.md)

# AFTERHOURS

A living city. A stolen car. A story worth sharing.

A desktop browser urban sandbox: Babylon.js renders the city, and a CPU-only Node server owns gameplay in one shared world. This is a playable foundation tested with 16 local clients, not a large-scale persistent MMO.

## Run

Requires Node 24, Bun 1.2.21 or newer, stable Rust with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.129.

```sh
bun install --frozen-lockfile
scripts/build-physics.sh   # wasm physics for the client
bun run server             # Rust game server on port 5174
bun run dev                # Vite client, proxies /ws and /city to the server
```

Open http://localhost:5173. A second tab or another device on your LAN joins the same city. Set `PORT` to change the port.

```sh
bun run check   # formatting, import boundaries, types
bun run test    # unit and real-WebSocket tests
bun run build   # wasm physics and production client
bun run start   # release server serving dist/ and the WebSocket endpoint
cargo test      # physics, protocol and server tests
```

`start` runs in production mode with debug tools disabled. `ALLOW_DEBUG=1` explicitly enables them for everyone on that server, and development always enables them, so never expose dev mode publicly. See [debugging](docs/debugging.md).

The jittered-link driving probes and the Chromium movement spec were written against the retired Node netcode and are gone; `crates/server/tests` covers join, movement and vehicle entry over a real WebSocket. See [movement testing](docs/movement-testing.md).

## Controls

| Key                | Action                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WASD / arrows      | Walk or swim; cars and watercraft use W/S throttle and A/D steer; helicopters tilt forward/back with W/S and turn with A/D; planes use W throttle, S brake, A/D turn |
| Shift              | Sprint on foot; aircraft descend / enabled jetpack descent (left or right Shift)                                                                                     |
| Space              | Sprint / car and watercraft handbrake / aircraft climb                                                                                                               |
| F                  | Take a seat, exit, or collect a weapon, ammo, or jetpack; airborne exits deploy a parachute                                                                          |
| Mouse              | Aim the upper body independently of walking; left click attacks                                                                                                      |
| J                  | Punch / swing / fire                                                                                                                                                 |
| 1–4                | Equip inventory slot; the weapon strip bottom right shows all four slots with magazine / reserve ammo                                                                |
| G / R              | Drop active jetpack or equipped weapon / reload                                                                                                                      |
| E / Q              | Same as Space / Shift: aircraft climb / descend; enabled jetpack thrust / descent                                                                                    |
| B                  | Enable or disable equipped jetpack                                                                                                                                   |
| Enter / H / Escape | Chat / help / close panels                                                                                                                                           |
| M / N / F1         | Island map / mute sound / draggable Dev tools: vehicles, time, camera, networking, server stats, hover inspector and admin teleports                                 |

Local steering responds between network command ticks. Prop impacts predict the car's passage, including props dented by earlier hits, and throw the struck prop at once; when the server's debris arrives it takes over by sliding into place rather than snapping. Damage and pickups still wait for the server. Other drivers' and AI cars' future turns cannot be predicted exactly, so shared crashes can still need corrections. See [fast driving and shared collisions](docs/networking.md#fast-driving-and-shared-collisions).

Body collision height checks use the snapshot's millimeter position grid so rounding cannot drop an otherwise shared contact at the 1.8 m height boundary.

Standard gamepads use the left stick to move and steer, LT/RT to reverse/accelerate, A to brake or sprint, X to attack, Y to enter/exit, LB/RB to descend/ascend, B to reload, and the D-pad for inventory slots. View opens the map, Menu opens help, and the left stick click toggles the jetpack.

The debug Server stats window shows process CPU usage, where 100% is one core, and process memory as a percentage of the container or host memory limit. Tick CPU measures the simulation budget separately; JS heap usage also includes a percentage of its own limit.

## What is in the city

- **Vehicles:** cars, helicopters, planes, boats and jet skis with shared multi-seat rides, plus jetpacks and parachutes. Taking the driver seat of a car makes its AI driver and AI passengers get out; human passengers stay aboard. Headlights are automatic: they are on in the dark while a person or the AI is driving a car, and off for parked, wrecked or flooded cars; there is no key for them.
- **Combat:** fists, bats, knives, pistols, SMGs, machine guns, flamethrowers and grenades, with server-owned inventory, ammunition and lag-compensated hits.
- **Population:** 160 AI traffic cars and 300 pedestrians with personalities, routes, signals and reactions to crime and crashes. Former drivers retire after their reaction ends and they leave every player’s interest range. Replacement traffic waits for that retirement so repeated crashes do not grow the population. Pedestrians follow the generated sidewalks and cross only at crosswalks when the crossed traffic has a red light; fleeing, fighting or dodging citizens may leave the sidewalk. See [traffic](docs/traffic.md).
- **Crashes:** cars take damage from the speed of an impact: a bump below 15 km/h is free, a 70 km/h wall costs about a third of a sedan's health, a 100 km/h wall leaves it running, and only harder hits set it alight, followed by an explosion six seconds later. The explosion throws everyone aboard clear alive with 25 damage; aircraft crews keep their height and open a parachute. A car driven into water deeper than 0.8 m floods: its engine and lights die, it drifts to a stop and sinks, its occupants can swim out, and it explodes 10 seconds later. Empty cars keep their parking brake on, so a shove slides them to a halt instead of rolling away, and a stopped car whose driver is off the throttle holds its place on a hill. Cars grip harder at speed: the steering lock narrows as speed rises and the rear tyres hold slightly better than the fronts, so a fast corner understeers before it slides, while the handbrake still swings the tail out. Only real slides (rear tyres past about 15° of slip) squeal and leave rubber on streets, hills and the airfield; the marks stay for three minutes and fade out over the last one. Tuning lives in `TUNING.crashSafeSpeed` and `TUNING.crashDamage`.
- **Destruction:** palms, lamps, signs and hydrants can be knocked over or destroyed, then restore. See [destruction](docs/destruction.md).
- **Weapon crates:** wooden crates stand at the kerb of about one in three street segments away from junctions. Two punches (or any weapon, crash or blast) break one open and drop a random weapon with a full magazine and full reserve; the crate comes back after 90 seconds.
- **Characters:** three builds (Runner, Regular, Tank) with customizable appearance, saved on the device.
- **Camera:** the follow camera dithers a building out only when it overlaps the player silhouette, using a 0.8 m radius around the torso rather than a single center ray. Rays stop at the player’s view plane, so buildings beyond the player stay solid. Nearby buildings outside the silhouette stay solid too. Free and fly debug cameras keep all buildings solid for map inspection. The fade is a screen-door pattern, not transparency, so shadows and depth stay intact.
- **Atmosphere:** day/night lighting and 149 CC0 sound clips ([credits](public/audio/CREDITS.md), [audio notes](docs/audio.md)). Sounds are local: engines, tyres, fire and footsteps fade out within about 30 m, aircraft and horns within 45 m, gunfire within 55 m and explosions within 75 m, and another player's inventory or life-state cues are never heard.

## The city

The city is a versioned artifact (`data/city.json` plus baked meshes in `data/city-meshes.msgpack`). Every server boot regenerates both with the current generator, replacing the files on disk, then loads and validates them and sends the map to clients in chunks. Generator changes therefore always land on the next start; it takes about 25 s and up to 2 GB of memory in a separate process (mesh baking uses the client renderer, which the server must not import). `CITY_SEED` picks the seed (default 713), `CITY_PATH` and `CITY_MESH_PATH` the files, and `CITY_REGENERATE=0` serves the files already on disk. Clients have no bundled or generated city.

The steps can also run by hand:

```sh
bun run map:explore                                    # tune generation in the browser (http://localhost:5180)
bun run city:prepare                                   # generate and bake, as the server does on boot
bun run city:generate --seed 713 --out data/city.json  # write the city artifact only
bun run city:meshes                                    # bake the static meshes only
```

The generator in `mapgen/` builds an eroded island heightmap, rivers, a settlement, terrain-aware roads, blocks, lots and buildings. Building bases clear the terrain across their full footprint; sites with more than 4.4 m of relief are omitted so the existing foundations stay grounded. Static scenery, including airport runways, is baked at the terrain height. The sea coast is smoothed: the signed distance to the shore is blurred so the waterline is a clean curve, with a 6% beach above it and a 10% shelf below it, and the terrain colour blends from wet sand through sand to grass instead of switching at a height. Grass is a muted olive broken into soft lush, dry, accent and bare-mud patches by smooth noise, and steep ground and the highest ridges turn grey-brown rock, in the manner of the Craftstead ground. Lake shorelines follow the terrain triangles at water level; streets share exact junction-mouth vertices, including bends and turning circles. The checked-in seed 713 has about 4 km² of land, hills up to about 170 m and a downtown beside the main estuary. Building looks are twelve replaceable recipes in [shared/assets/buildings](shared/assets/buildings/README.md).

Every city also gets destinations, placed by `scripts/mapgen-features.ts` on land kept clear of the streets and of each other:

- **Town hall:** a civic hall on a street-facing lot near downtown with a striped car park of about forty bays in front. Players spawn on the plaza between the two, and the starter cars stand in its bays.
- **Two airports:** the flattest dry squares away from downtown, at least 600 m apart, each with a terminal, two hangars, a control tower, taxiways, parking, and a plane and an aerobatic plane at the runway threshold.
- **Racetrack:** a seeded closed circuit, 12 m wide, of Catmull-Rom curves with hairpins smoothed to a 20 m minimum radius. Its asphalt follows a smoothed profile of the land, so it climbs and falls; two sports cars wait on the grid behind the chequered line. It has no access road: drive across the fields.
- **Three harbours:** concrete quays a metre above the sea, aligned to the terrain grid so their faces are straight, on shelving stretches of coast, each with a dredged basin, three moored boats and a harbour office.

All of them are landmarks on the island map, and the debug Admin window teleports to them. The converter shapes the 8 m terrain grid to each street's profile, then drapes the streets onto the finished terrain: every asphalt, sidewalk and marking piece lies on one terrain triangle at the ground height. Streets therefore never float or show terrain through them, and people and vehicles move on the drawn surface; asphalt is drawn 0.1 m above the ground and sidewalks a 0.15 m kerb higher. A street's cross-slope follows the terrain grid, so steep side slopes tilt it. Plazas, quays, airfields and the racetrack keep their own levels. Bridges stand on embankments built up to deck height, so boats cannot pass under them. The sea uses turquoise color bands, broad moving wave accents and cream shoreline foam. It carries a swell that laps up the beaches: swimmers, boats and floating pickups ride it, and it rocks drifting boats. Lakes are swimmable water at their own level; rivers are drawn only and are too shallow to swim. Boats driven at the shore run aground and slide to a halt on land; they cannot drive there. Helicopters fly like rotorcraft: W/S tilt the rotor disc nose down or up, A/D yaw, Space/Shift climb and descend. The tilted lift accelerates them and drag sets the top speed, so they keep their momentum and take a few seconds to settle into a hover once you let go; at speed they bank into turns and the nose turns only as fast as the bank can curve the flight path. The attitude is simulated and shared, so other players see the tilt too. AI cars stop at each junction's stop line (between close junctions the two stop lines meet mid-link) and only turn back at dead ends. The street generator joins a dead end to a road up to 110 m ahead when the connector stays on dry, gentle ground and leaves a block big enough for a lot, and prunes spurs shorter than 65 m; the dead ends left face the coast, steep ground or the map edge. Each signal stands on the sidewalk to the right of the traffic it controls, at its stop line, with its lamps facing that traffic; street lamps reach out over the street. Signals give the straightest pair of arms at each junction one phase and the other arms the other; at a few four-way junctions whose side arms are not opposite, those side arms are green together. See [city generation research](docs/city-generation-research.md) and [architecture](docs/architecture.md).

## Architecture

- `server/` owns all gameplay: movement, damage, pickups and ownership. It runs at 30 Hz and sends snapshots at 15 Hz.
- `client/` renders, plays audio and predicts local movement. Prediction is provisional and always reconciles with server snapshots.
- `shared/` holds protocol schemas, catalogs, spatial queries, navigation and the prediction-safe movement code both sides run.
- `crates/physics/` is the Rust physics core (Rapier vehicles and characters) that will replace the TypeScript movement code; `scripts/build-physics.sh` builds it to wasm and `scripts/physics-parity.mjs` checks native and wasm runs match. `crates/protocol/` holds the wire types (`cargo test -p afterhours-protocol` regenerates `shared/generated/`), and `crates/server/` is the Rust server (`bun run server`, port 5174) that the client now talks to; `bun run dev` serves the client and proxies to it. The Node `server/` stays until the Rust server reaches gameplay parity; see `docs/rust-refactor.md`.
- `mapgen/` and `scripts/` hold the offline city pipeline and tooling. Import boundaries between these are enforced by `bun run check`.

See [networking](docs/networking.md) and [physics](docs/physics.md).

## Hosting

```sh
docker compose up -d --build
```

This runs one non-root Node process behind Caddy with HTTPS, WebSockets, health checks and restart policies. Local defaults are https://localhost:8443 and HTTP port 8080. For a public deployment set `DOMAIN=game.example.com`, `HTTP_PORT=80` and `HTTPS_PORT=443`, with DNS pointing at the host. Behind another reverse proxy, set `PUBLIC_ORIGIN` to the browser's origin; WebSocket origin checks trust `X-Forwarded-Host` only from loopback peers.

`/health` reports tick timings, bytes, rejected messages, entity count and memory. Client frame and network profiling is opt-in with `?profile=1`; see [playtesting](docs/playtesting.md). Dynamic state (players, inventory, traffic damage, time) resets on restart, so run one replica per city. See [operations](docs/operations.md).

## Current limits

The Rust server is the live backend and still reaches only part of the old gameplay: walking, jumping, and driving the two sedans parked at the spawn. The Node server under `server/` keeps the rest (combat, inventory, pickups, grenades, destruction, AI traffic and citizens, aircraft, watercraft, flooding, day and night, debug commands) until each system lands in Rust; see the milestone list in [the refactor goal](docs/rust-refactor.md).

- Inputs are stamped with the server tick they belong to and sent two ticks early; the client steers that lead from the `lead` the server reports in every snapshot. Late inputs are dropped, not queued, so a stall shows as a correction rather than slow motion.
- Prediction runs the same wasm physics crate the server runs natively, restoring the server's raw state and replaying unacknowledged inputs. Only terrain, water and the world floor collide on the client; buildings and props are server-only until the client gets them.
- Snapshots are deltas against the last tick the client acknowledged, with a full snapshot when the base is unknown. Remote bodies interpolate over a 100 ms buffer.
- Graphics are procedural low-poly. There are no interiors, touch controls, accounts, moderation, saves or missions.
- Fonts load from Google Fonts with local fallbacks.

## More documentation

[Architecture](docs/architecture.md) · [Networking](docs/networking.md) · [Physics](docs/physics.md) · [Traffic](docs/traffic.md) · [Water](docs/water.md) · [Destruction](docs/destruction.md) · [Audio](docs/audio.md) · [Debugging](docs/debugging.md) · [Map controls](docs/map-controls.md) · [Movement testing](docs/movement-testing.md) · [Playtesting](docs/playtesting.md) · [Operations](docs/operations.md)

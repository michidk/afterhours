# AFTERHOURS

A living city. A stolen car. A story worth sharing.

A desktop browser urban sandbox: Babylon.js renders the city, and a CPU-only Node server owns gameplay in one shared world. This release provides a playable foundation with 16-player local load-test coverage; it is not a large-scale persistent MMO.

## Run

Requires Node 24 and Bun 1.2.21 or newer.

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. A second tab or another device on your LAN joins the same city. Set `PORT` to change the port. The server must remain running.

The checked-in `data/city.json` is a ready-to-load city artifact. City generation is a **separate manual process**:

```sh
bun run city:generate --seed 713 --out data/city.json
```

The generator is under `scripts/`, outside both runtime applications. Version 3 covers a 1.632 x 1.632 km island (13.3 times the original area), with ten districts: Downtown, Little Havana, East Market, Palm Gardens, Sunset Beach, Port Paloma, Ironworks, Paloma International, University, and Northwood. Seed 713 contains 735 building instances, 30 parks/reserves and a 108 m landmark tower. A compact downtown grid opens onto winding coastal drives, radial avenues, angled industrial streets, campus loops and northern cul-de-sacs. The connected network contains 611 road segments alongside a 212 m runway and wooded reserves. Twelve replaceable building recipes live in [shared/assets/buildings](shared/assets/buildings/README.md); street-facing facades use glass ribbons, deco piers, balconies, shutters, and awnings. Seeds vary road bends and frontage buildings while preserving district connections. Arterials have wider paved shoulders than local streets; traffic follows shared lane centres. Regenerate v1/v2 artifacts with the command above. Its versioned JSON contains roads, buildings, parks, ramps, pickups, static props, airport, and landmarks. The server loads and validates that file once at startup; it never regenerates a city implicitly. Set `CITY_PATH` to use another file. Missing or incompatible files fail startup with a useful error. Restart after replacing an artifact. Add `--preview data/city-preview.html` to the generation command to write a self-contained, zoomable district/height atlas. Clients receive a small map manifest from `/city` and joining, then stream nearby 128 m geometry chunks as the player/camera moves. Distant geometry unloads. The first loading screen initializes WebGL and loads only spawn scenery before showing the character-selection menu ready to enter. After joining, collision data is prefetched beyond the 110 m snapshot range: prediction requires 142 m of complete coverage and downloads extend to 270 m. Extra collision chunks stay in memory without becoming rendered scenery. When required chunks are missing, movement uses server snapshots until prediction can safely resume. The server simulates the entire saved city continuously. Clients have no bundled city, generation code, or browser-persisted world copy. See [city format and architecture](docs/architecture.md).

```sh
bun run check
bun run test
bun run build
bun run start
```

Startup downloads the spawn chunks before building their 3D scenery, so mesh construction cannot delay the remaining downloads into a timeout. Sounds begin loading after the first frame is ready, with at most four downloads at once. Sound loading can continue after the entry screen appears.

`start` serves the built client and WebSocket endpoint. Production debug tools are disabled; `ALLOW_DEBUG=1` explicitly enables them for everyone on that server. Development enables them. Do not expose development mode publicly. See [debug commands and scenarios](docs/debugging.md) for the script and browser interfaces. When a reverse proxy rewrites Host across container NAT, set `PUBLIC_ORIGIN` to the browser's HTTP(S) origin. Other browser origins still require the existing host check; arbitrary forwarded headers are not trusted.

`bun run test:browser:docker` builds the production image and runs held-key walking tests with ordinary and delayed snapshots in disposable game/browser containers. It saves actual rendered positions, authoritative movement, server health, screenshots and failure traces. See [movement regression tests](docs/movement-testing.md) for native Chromium setup and diagnosis. A healthy HTTP endpoint alone does not establish playable movement.

## Controls

| Key                | Action                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------- |
| WASD / arrows      | Walk, swim, or fly helicopters; cars, planes, and watercraft use W/S throttle and A/D steer |
| Shift              | Sprint on foot (left or right Shift)                                                        |
| Space              | Sprint / car handbrake / aircraft and watercraft brake                                      |
| F                  | Take a seat, exit, or collect a weapon, ammo, or jetpack; airborne exits deploy a parachute |
| Mouse              | Aim on foot; left click attacks                                                             |
| J                  | Punch / swing / fire                                                                        |
| 1–4                | Equip inventory slot                                                                        |
| G / R              | Drop active jetpack or equipped weapon / reload                                             |
| E / Q              | Aircraft climb / descend; enabled jetpack thrust / descent                                  |
| B                  | Enable or disable equipped jetpack                                                          |
| L                  | Toggle car headlights and taillights from the driver seat                                   |
| Enter / H / Escape | Chat / help / close panels                                                                  |
| M / N / F1         | Island map / mute sound / development menu with tools, clock, and camera selection          |

F1 also selects an elevated free camera or first-person fly camera. Both move independently of the player: WASD/arrows move, E/Q raise/lower, Shift or Space moves faster, and the wheel zooms without fixed zoom caps. Right-drag looks around in fly mode. Escape returns to player follow and restores gameplay controls. In debug camera mode the server receives idle player controls while the city keeps simulating. [Detailed controls and recorded day/night comparisons](docs/debugging.md).

M toggles the full island map; Escape or the Close button dismisses it. Drag to pan, scroll or use +/- to zoom, and Find me recentres on your live position. Island restores the full overview. The server sends a compact road/park/landmark overview on demand, separate from 3D chunk streaming. The map shows nearby players within normal snapshot interest; it does not reveal the entire server population. Opening it releases movement/attack controls while the world continues running. N toggles sound. Both Shift keys sprint on foot without applying a vehicle handbrake.

Cars have four wheel forces, yaw-dependent contact velocities, front steering, rear handbrake grip recovery, SAT contacts, angular impulses, and fading tyre trails. Sedan, sport, and van models differ in mass, power, grip, durability, speed, and appearance. AI drivers turn their lights on from 18:00 to 06:00. Player toggles persist when parked or changing drivers; wrecks lose their lights. Headlights have visible cones and illuminate nearby surfaces. Four nearby headlight spotlights are pooled; cones are cosmetic and do not cast shadows or stop at walls. Damaged vehicles smoke, burn for six seconds, explode with nearby damage, and leave temporary wrecks.

The top-left player list shows everyone connected to the city, including distant players, with character colours and a YOU badge. Overhead names identify nearby players, including seated passengers. Both update on join/leave/reconnect.

Palms, trees, benches, lamps, signal poles and hydrants can be knocked over or destroyed with weapons/explosions. Server-owned physical debris lasts 30 seconds and fades before fixtures return to their original locations; occupied reset positions wait until clear. Broken hydrants spray water until restoration. Corpses last three minutes while players respawn after three seconds and NPCs recover after 30 seconds; exploded vehicle wrecks last three minutes. The saved map stays unchanged. See [destruction scope and timers](docs/destruction.md).

Vehicles support shared rides with server-assigned seats. The first available seat is the driver/pilot seat; later players take passenger seats. Only the driver controls movement; passengers follow the vehicle smoothly and can exit independently. The HUD shows your role and occupancy. Leaving or disconnecting frees only your seat, and explosions affect every occupant. A vacant driver seat is available to the next person boarding; existing passengers keep their seats rather than automatically taking control. Board aircraft while grounded. Helicopters wait one second for passengers before automatic takeoff; each boarding passenger gets at least another half-second, and pilot movement starts takeoff immediately.

| Vehicle                    | Seats |
| -------------------------- | ----- |
| Paloma Sedan               | 4     |
| Comet GT                   | 2     |
| Market Van                 | 2     |
| Sparrow                    | 2     |
| Atlas Utility              | 6     |
| Island Hopper              | 4     |
| Firefly Sport              | 2     |
| Harbor Skiff / Quay Launch | 4 / 6 |
| Wave Runner / Sea Dart     | 2 / 1 |
| Coast Comet / Offshore GT  | 4 / 2 |

Sparrow and Atlas helicopters automatically climb above buildings, palms, lamps, and nearby vehicles and anticipate roof edges. E/Q adjusts altitude; Space brakes horizontal flight. Sparrow responds faster than the heavier Atlas. Island Hopper and Firefly Sport planes use the airfield, need model-specific airspeed for lift, and stall when slow; Firefly accelerates and turns faster. F exits airborne aircraft and opens a panelled ram-air parachute with suspension lines and a harness. Walking off rooftops also opens it automatically. WASD steers and descent is limited to 4 m/s. Empty aircraft fall and crash on land or water. Cars climb ramps and jump from the high edge; solid sides and backs block ground-level approaches.

The coast has animated water with a flat shared collision surface. Swim offshore at 2.8 m/s and step back onto shore. Boats, jet skis, and speedboats each have two models with different acceleration, drag, steering, braking, and speed. Six idle craft wait on the west coast near x=-823, z=-48 through 32; AI craft cruise offshore routes and can be stolen. F boards from shore or water; WASD drives and Space brakes. See [water and handling](docs/water.md).

Jetpack supplies appear near existing golden pads. F equips a pack separately from the four weapon slots. B enables it; E burns up to 45 seconds of fuel for thrust and WASD steers. Q descends, and releasing thrust or exhausting fuel opens a parachute. G drops an enabled pack with its remaining fuel. Replacing a pack requires dropping the current one. Fuel, equipment, and flight remain server-owned and are predicted by the same shared movement code.

Pedestrians navigate connected sidewalks/crosswalks, wait for signals, avoid props, panic near fast cars, and recover from knockdowns. Traffic chooses reachable street destinations, follows lanes, queues behind vehicles, obeys signal phases, turns through intersections, and reverses out of jams. Players can steal traffic cars. Fists, bats, knives, pistols, SMGs, machine guns, flamethrowers, and grenades use server-owned inventory, ammunition, cooldowns, reloads, drops, and exclusive pickups. Ammo supplies refill compatible owned weapons even with all four slots occupied; surplus stays on the ground. Flamethrowers spend fuel on a short forward cone blocked by walls and fixtures. Grenades carry three charges, follow physical trajectories with bounces, and explode after a three-second fuse. New supplies are placed near existing saved-map pads at runtime without changing the city artifact; pads refill 20 seconds after collection.

Persistent traffic jams are detected on the server after 30 seconds without meaningful progress. Cleanup removes at most one unoccupied AI car every five seconds; occupied/player-controlled cars and burning vehicles are protected. Replacements appear later on clear lanes away from players, keeping traffic circulating without immediately refilling the jam. Normal red-light queues remain intact. See [traffic behavior and repeatable tests](docs/traffic.md).

Walking or sprinting into a parked car blocks/slides the character without damage or knockdown. Vehicle impacts use the vehicle's motion toward the character at the contact point; moving away, creeping, or tangential motion alone does not count as a hard strike. Cars driving into people still cause damage and knockdowns.

## Architecture and validation

`client/` separates rendering, effects, input, camera, networking/prediction, audio, and UI. `server/` separates hosting, city loading, sessions, scheduling, simulation, AI, combat, inventory, and lifecycle. `shared/` contains contracts, schemas, data catalogs, spatial queries, binary codec, navigation, and prediction-safe movement. Automated import checks enforce these boundaries.

The server steps at 30 Hz with 120 Hz contact substeps, and snapshots at 15 Hz. Inputs have sequence/timestamp metadata and acknowledgements. Clients predict local movement and contacts against private copies of nearby bodies, replay unacknowledged inputs, smooth position/yaw corrections, interpolate remote state with a 100 ms buffer, and cap extrapolation. Damage, knockdowns, combat, and ownership remain server decisions. Tyre trails are cosmetic: they follow rendered wheel slip immediately, including local prediction and remote interpolation, without waiting for server events. New marks upload in the same frame; fading stays batched and bounded. Ranged hits use footprint rays, walls, and up to 200 ms of validated target rewind.

Snapshots use MessagePack, integer pose quantization, changed-field deltas, periodic full recovery, and a 110 m interest radius. Origin/schema/payload/action/message limits, idle input release, exclusive driver ownership and seat assignment, and 15-second reconnect tokens protect session consistency.

Run `bun run bench:physics` and `bun run bench:load` to reproduce the CPU measurements. Evidence and caveats are in [physics decision](docs/physics.md), [load report](docs/load-test.json), and [playtest procedure](docs/playtesting.md). Regression tests cover motion, drift, contacts, fire/explosions, aircraft, AI, inventory, lag compensation, city artifacts, binary deltas, and multiplayer sessions. GitHub CI runs formatting, boundaries, types, tests, and build.

## Hosting

```sh
docker compose up -d --build
```

The production stack runs one non-root Node process and Caddy with HTTPS, WebSockets, health checks, structured proxy logs, and restart policies. Local defaults are https://localhost:8443 and HTTP port 8080. Caddy uses a local CA for localhost; trust that CA on your development machine before browser testing HTTPS. Public deployment uses `DOMAIN=game.example.com`, `HTTP_PORT=80`, and `HTTPS_PORT=443`, with DNS pointing to the host; Caddy then obtains a public certificate. See [operations](docs/operations.md).

WebSocket origin checks support the VibePod gateway's rewritten Host through `X-Forwarded-Host` from its loopback connection. Local proxies must overwrite that header; other peers must preserve Host. Preview HTTP 401 or a password screen requires signing in to the gateway.

`/health` reports ticks, p95/max tick duration, catch-up drops, bytes, rejected messages, entity count, and memory. City geometry persists in the artifact; dynamic players, inventory, traffic damage, and time reset on restart. Use one replica per city. Reconnects restore a session only within the same running process.

## Current limits

The graphics are procedural low-poly models; terrain remains flat and building collision volumes are rectangular. Ambient traffic/pedestrian counts remain bounded rather than scaling with map area. There are no interiors, touch controls, accounts, moderation, saves, missions, or advanced destruction. The custom solver is planar with separate altitude, not full suspension/aerodynamics. Local contact prediction estimates remote motion because other players' future inputs are unknown; authoritative corrections can still occur, especially under latency or in pileups. Nearby collision bodies now share the predicted display timeline. Prediction falls back to authority beyond 250 ms of unacknowledged simulation; input overflow discards old controls while preserving recent stops. See [networking research and tests](docs/networking.md). Cosmetic tyre trails use detailed, bounded local tiles across the whole map; they fade after 40 seconds, can differ slightly between clients, and do not persist for late arrivals. Very slow chunk downloads temporarily fall back to authoritative movement until local collision geometry arrives. Traffic recovery is local and can still produce congestion. See the measured Rapier tradeoff before increasing capacity. Sixteen moving clients have been tested locally, not across real WAN infrastructure.

The server has no GPU requirement. The automated browser uses SwiftShader: its frame times are useful for regression observations but are **not** hardware-client performance evidence. A supplied RTX 4070 sample reached ~165 FPS with rolling p95 35.2 ms; an optimized retest measured p95 9.4 ms but was invalid because the tab became hidden. The user waived further hardware profiling as an acceptance requirement; these remain observations rather than a verified full-minute performance pass. See [the recorded sample](docs/client-hardware-profile.json) and [retest](docs/client-hardware-retest.json). Fonts use Google Fonts with local fallbacks.

Audio uses 114 locally served CC0 clips across 36 sound banks with alternate takes, no immediate sample repeats, and per-bank pitch, volume, and tone variation. The jetpack bank reuses wind recordings without adding clips. The engine includes model-specific vehicle loops, nearby tyre squeals, footsteps, combat, inventory handling, boarding, parachute deployment and canopy flutter, fire, broken-hydrant water, and coastal ambience. Confirmed snapshots drive action cues; positions, damage, and ownership remain server decisions. N toggles sound. Open `/audio.html` to listen through the same engine. See the [sound inventory and limits](docs/audio.md) and [source credits](public/audio/CREDITS.md).

Audio uses at most 32 one-shot voices and six nearby active vehicles, with smooth fades and distance filtering. It has two footstep surfaces and no wall occlusion, RPM recording layers, Doppler effect, or voice dialogue. Cloth, water, and handling foley stand in for some actions. The sample checks verify headroom and loop seams. The user confirmed real-device listening on 2026-10-11 with no adjustments needed.

### Character selection

Before joining, choose a Runner, Regular, or Tank and customize headwear/hair, upper body, legs, skin tone, and shirt colour. Randomize changes the entire character. Appearance and build are saved on this device. The 3D menu preview uses the same model as gameplay.

| Build   | Health | Ground pace |
| ------- | ------ | ----------- |
| Runner  | 80     | 120%        |
| Regular | 100    | 100%        |
| Tank    | 150    | 80%         |

The server owns health and movement. Physiques affect walking and sprinting; swimming, parachutes, jetpacks, vehicles, and collision sizes are shared. Recovery restores the chosen build's health; corpses retain the chosen appearance. Reconnecting preserves the active character. To choose again, refresh and join a new session; there is no in-game wardrobe. The responsive menu works at narrow widths, but gameplay still requires a keyboard and mouse. Protocol version 4 requires clients to refresh after deployment.

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

The generator is the multi-stage pipeline in `mapgen/`, driven by `scripts/generate-city.ts`, outside both runtime applications. It builds an eroded island heightmap, fills depressions and derives rivers and lakes from flow accumulation, chooses a settlement site, routes terrain-aware arterials with bridges, traces streets from a tensor field, builds junction polygons with curb fillets and road profiles, stamps corridors and building pads into the terrain, extracts blocks and lots, places typed buildings, and scatters trees and lamps. Version 6 stores an 8 m terrain grid across the 3.072 km map envelope as packed 16-bit centimetres, the street surface as polygons with profile heights (asphalt, sidewalks, markings) packed per 128 m chunk, roads as dense straight lane segments for navigation, rotated buildings with pad and roof altitudes, props, parks, pickups, the airport and landmarks. Seed 713 has about 4 km² of land with a coastal plain and an interior of hills up to about 170 m, 18 rivers, a downtown of towers beside the main estuary, outlying suburbs, 2704 road segments and 436 buildings. Twelve replaceable building recipes live in [shared/assets/buildings](shared/assets/buildings/README.md); the generator picks a recipe per building type and the dimensions stay authoritative collision bounds. Ramps and paved surfaces are not generated yet. Explore and tune generation in the browser before regenerating:

```sh
bun run map:explore
```

Open http://localhost:5180, press Regenerate or type a seed, toggle layers, hover for per-cell details, and use the 3D view button (or V) to fly through a Babylon.js preview with WASD, drag to look, Shift fast, E/Q up and down and Escape back to the map. Generation runs in a Web Worker in a few seconds and nothing is saved; the explorer has its own Vite config and never enters the game bundle. The research and the integration notes are in [city generation research](docs/city-generation-research.md). The server loads and validates that file once at startup; it never regenerates a city implicitly. Set `CITY_PATH` to use another file. Missing or incompatible files fail startup with a useful error. Restart after replacing an artifact. Add `--preview data/city-preview.html` to the generation command to write a self-contained, zoomable district/height atlas. Clients receive a small map manifest from `/city` and on joining, download the terrain grid as raw 16-bit centimetres from `/city/terrain/<mapId>`, then stream nearby 128 m geometry chunks as the player/camera moves; each chunk carries its own packed street polygons, and every map response is pre-compressed with gzip. Buildings and street fixtures render at least 512 m around the camera focus, expanding further for wide views. Distant geometry unloads. The first loading screen initializes WebGL and loads the full 512 m spawn scenery area and collision coverage before showing the character-selection menu ready to enter. After joining, collision data is prefetched beyond the 220 m snapshot range: prediction requires 252 m of complete coverage and collision prefetch extends to 380 m even when the camera moves away. Extra collision chunks stay in memory without becoming rendered scenery. When required chunks are missing, movement uses server snapshots until prediction can safely resume. The server simulates the entire saved city continuously. Clients have no bundled city, generation code, or browser-persisted world copy. See [city format and architecture](docs/architecture.md).

```sh
bun run check
bun run test
bun run build
bun run start
```

Startup downloads the spawn chunks before building their 3D scenery, so mesh construction cannot delay the remaining downloads into a timeout. Sounds begin loading after the first frame is ready, with at most four downloads at once. Sound loading can continue after the entry screen appears.

`start` serves the built client and WebSocket endpoint. Production debug tools are disabled; `ALLOW_DEBUG=1` explicitly enables them for everyone on that server. Development enables them. Do not expose development mode publicly. See [debug commands and scenarios](docs/debugging.md) for the script and browser interfaces. When a reverse proxy rewrites Host across container NAT, set `PUBLIC_ORIGIN` to the browser's HTTP(S) origin. Other browser origins still require the existing host check; arbitrary forwarded headers are not trusted.

`bun run test:network` checks real-time walking, helicopter flight and nearby observers over actual WebSockets with delay and jitter. It uses the saved city and a separate server, without WebGL.

`bun run test:browser:docker` builds the production image and runs held-key walking tests with ordinary and delayed snapshots in disposable game/browser containers. It saves actual rendered positions, authoritative movement, server health, screenshots and failure traces. See [movement regression tests](docs/movement-testing.md) for native Chromium setup and diagnosis. A healthy HTTP endpoint alone does not establish playable movement.

After generating or changing the saved city or static rendering recipes, run `bun run city:meshes` manually. This bakes terrain, buildings, roads, parks, signs, ramps and street fixtures into the versioned `data/city-meshes.msgpack` artifact (size depends on the saved city). The server loads it on startup and sends compressed mesh buffers for nearby areas alongside collision descriptions. Browsers upload the buffers instead of generating static meshes. A missing or mismatched artifact prevents startup; use `CITY_MESH_PATH` with `CITY_PATH` for custom cities. Dynamic characters, vehicles, debris, sky, ocean, effects and sign lettering textures remain client-rendered. First-frame readiness checks the visible scene rather than every offscreen mesh; slow shader preparation reports progress and has a 60-second deadline.

## Controls

| Key                | Action                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| WASD / arrows      | Walk, swim, or fly helicopters; cars and watercraft use W/S throttle and A/D steer; planes use W throttle, S brake, A/D turn |
| Shift              | Sprint on foot; aircraft descend / enabled jetpack descent (left or right Shift)             |
| Space              | Sprint / car and watercraft handbrake / aircraft climb                                                                       |
| F                  | Take a seat, exit, or collect a weapon, ammo, or jetpack; airborne exits deploy a parachute                                  |
| Mouse              | Aim the upper body independently of walking; left click attacks                                                              |
| J                  | Punch / swing / fire                                                                                                         |
| 1–4                | Equip inventory slot                                                                                                         |
| G / R              | Drop active jetpack or equipped weapon / reload                                                                              |
| E / Q              | Same as Space / Shift: aircraft climb / descend; enabled jetpack thrust / descent                                             |
| B                  | Enable or disable equipped jetpack                                                                                           |
| L                  | Toggle car headlights and taillights from the driver seat                                                                    |
| Enter / H / Escape | Chat / help / close panels                                                                                                   |
| M / N / F1         | Island map / mute sound / development menu with tools, clock, and camera selection                                           |

Standard gamepads use the left stick to move and steer, LT/RT to reverse/accelerate, A to brake or sprint, X to attack, Y to enter/exit, LB/RB to descend/ascend, B to reload, and the D-pad for inventory slots. View opens the map, Menu opens help, and the stick clicks toggle the jetpack and vehicle lights. Analog sticks and triggers retain proportional input. Keyboard car steering builds to full lock over about a third of a second and recentres faster when released instead of snapping between extremes.

On debug-enabled servers, F1 shows a live networking panel: round-trip ping, ping variation, snapshot age/gap and rate, sent/applied input sequence numbers, applied input age, pending replay, prediction status, correction distance/yaw, visual offset, outgoing socket buffer, and resync count. Production servers require `ALLOW_DEBUG=1`.

F1 also selects an elevated free camera or first-person fly camera. Both move independently of the player at 60 m/s: WASD/arrows move, E/Space raise, Q lowers, Shift moves at 320 m/s, and the wheel zooms without fixed zoom caps. Right-drag looks around in fly mode, which renders without fog. Escape returns to player follow and restores gameplay controls. In debug camera mode the server receives idle player controls while the city keeps simulating. [Detailed controls and recorded day/night comparisons](docs/debugging.md).

M toggles the full island map; Escape or the Close button dismisses it. Drag to pan, scroll or use +/- to zoom, and Find me recentres on your live position. Island restores the full overview. The server sends a compact road/park/landmark overview on demand, separate from 3D chunk streaming. The map shows nearby players within normal snapshot interest; it does not reveal the entire server population. Opening it releases movement/attack controls while the world continues running. N toggles sound. Both Shift keys sprint on foot without applying a vehicle handbrake.

Cars have four wheel forces, yaw-dependent contact velocities, front steering, rear handbrake grip recovery, SAT contacts, angular impulses, and fading tyre trails. Sedan, sport, and van models differ in mass, power, grip, durability, speed, and appearance. AI drivers turn their lights on from 18:00 to 06:00. Player toggles persist when parked or changing drivers; wrecks lose their lights. Headlights have visible cones and illuminate nearby surfaces. Four nearby headlight spotlights are pooled; cones are cosmetic and do not cast shadows or stop at walls. Damaged vehicles smoke, burn for six seconds, explode with nearby damage, and leave temporary wrecks.

The top-left player list shows everyone connected to the city, including distant players, with character colours and a YOU badge. Overhead names identify nearby players, including seated passengers. Both update on join/leave/reconnect.

Streetlamp bulbs and soft ground illumination stay on throughout loaded scenery at night, independent of player distance. Four nearby point lights add illumination to moving bodies and facades; broken lamps go dark until restored.

Palms, trees, benches, lamps, signal poles and hydrants can be knocked over or destroyed with weapons/explosions. Server-owned physical debris lasts 30 seconds and fades before fixtures return to their original locations; occupied reset positions wait until clear. Broken hydrants spray water until restoration. Corpses last three minutes while players respawn after three seconds and NPCs recover after 30 seconds; exploded vehicle wrecks last three minutes. The saved map stays unchanged. See [destruction scope and timers](docs/destruction.md).

Vehicles support shared rides with server-assigned seats. The first available seat is the driver/pilot seat; later players take passenger seats. Only the driver controls movement; passengers follow the vehicle smoothly and can exit independently. The HUD shows your role and occupancy. Leaving or disconnecting frees only your seat, and explosions affect every occupant. A vacant driver seat is available to the next person boarding; existing passengers keep their seats rather than automatically taking control. Board aircraft while grounded. Helicopters wait one second for passengers before the pilot can lift off; each boarding passenger gets at least another half-second, and pilot input ends the pause immediately.

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

Sparrow and Atlas helicopters are flown manually: Space climbs, Shift descends, and releasing both holds altitude. WASD flies horizontally; a helicopter will not advance into a roof or wall above its altitude, so climb first. It settles gently onto roofs and people below. Sparrow responds faster than the heavier Atlas. Island Hopper and Firefly Sport planes use the airfield and fly along their nose: W throttles up, S brakes on the runway and acts as an airbrake in flight, A/D turn, Space pulls up and Shift dives. Climbing costs airspeed and diving earns it back; below model-specific stall speed the plane sinks. Firefly accelerates and turns faster. F exits airborne aircraft and opens a panelled ram-air parachute with suspension lines and a harness. Walking off rooftops also opens it automatically. WASD steers and descent is limited to 4 m/s. Empty aircraft fall and crash on land or water. Cars climb ramps and jump from the high edge; solid sides and backs block ground-level approaches.

The coast has animated water with a flat shared collision surface. Swim offshore at 2.8 m/s and step back onto shore. Boats, jet skis, and speedboats each have two models with different acceleration, drag, steering, braking, and speed. Six idle craft wait on the west coast near x=-823, z=-48 through 32; AI craft cruise offshore routes and can be stolen. F boards from shore or water; WASD drives and Space brakes. See [water and handling](docs/water.md).

Jetpack supplies appear near existing golden pads. F equips a pack separately from the four weapon slots. B enables it; E burns up to 45 seconds of fuel for thrust and WASD steers. Q descends, and releasing thrust or exhausting fuel opens a parachute. G drops an enabled pack with its remaining fuel. Replacing a pack requires dropping the current one. Fuel, equipment, and flight remain server-owned and are predicted by the same shared movement code.

Pedestrians have persistent calm, restless, timid, or aggressive personalities. They walk between home, work, and leisure stops on the sidewalk network, pause at destinations, wait for crossings, and dodge cars on a collision course. Nearby witnesses flee after someone is hurt; aggressive witnesses and victims may chase and punch the responsible actor. After a survivable crash, calm drivers continue, restless drivers flee in their cars, timid drivers stop and get out to run, and aggressive drivers get out to confront the culprit. Exits wait for a slow car and a clear space. Citizens occasionally take a short running burst; aggressive pedestrians have a small chance to start a nearby NPC fight. Reactions expire and pedestrians return to their routes. Traffic follows lanes, queues behind vehicles, obeys signal phases, turns through intersections, and reverses out of jams. Players can steal traffic cars. Melee attacks are lag-compensated like gunfire, catch targets right beside you, and play a punch and a recoil flinch on the victim; bat blows knock people down for a second. Fists, bats, knives, pistols, SMGs, machine guns, flamethrowers, and grenades use server-owned inventory, ammunition, cooldowns, reloads, drops, and exclusive pickups. Ammo supplies refill compatible owned weapons even with all four slots occupied; surplus stays on the ground. Flamethrowers spend fuel on a short forward cone blocked by walls and fixtures. Grenades carry three charges, follow physical trajectories with bounces, and explode after a three-second fuse. New supplies are placed near existing saved-map pads at runtime without changing the city artifact; pads refill 20 seconds after collection.

Blocked AI cars honk after eight seconds without meaningful progress and repeat every six seconds. Cars waiting directly at a red light stay quiet. Living traffic cars never despawn to clear a jam; congestion persists until cars can move again. Destroyed wrecks retain their separate expiry/replacement lifecycle. Traffic is simulated across the entire island, sent within 220 m, and rendered within 200 m. See [traffic behavior and repeatable tests](docs/traffic.md).

Walking or sprinting into a parked car blocks/slides the character without damage or knockdown. Vehicle impacts use the vehicle's motion toward the character at the contact point; moving away, creeping, or tangential motion alone does not count as a hard strike. Cars driving into people still cause damage and knockdowns.

## Architecture and validation

`client/` separates rendering, effects, input, camera, networking/prediction, audio, and UI. `server/` separates hosting, city loading, sessions, scheduling, simulation, AI, combat, inventory, and lifecycle. `shared/` contains contracts, schemas, data catalogs, spatial queries, binary codec, navigation, and prediction-safe movement. Automated import checks enforce these boundaries.

The server steps at 30 Hz with 120 Hz contact substeps, and snapshots at 15 Hz. AI chooses controls once per server tick and holds them across contact substeps. Inputs have sequence/timestamp metadata and acknowledgements. An elapsed-time input clock preserves 30 Hz prediction across delayed browser callbacks and resets after long stalls. Clients predict local movement and contacts against private copies of nearby bodies, replay unacknowledged inputs, smooth position/yaw corrections, interpolate remote state with a 100 ms buffer and playback matched to measured server-time cadence, and cap extrapolation. Prediction replays up to one second of pending controls, with collision coverage sized for closing speeds; longer outages hold the bounded pose until acknowledgements resume. Damage, knockdowns, combat, and ownership remain server decisions. Tyre trails are cosmetic: they follow rendered wheel slip immediately, including local prediction and remote interpolation, without waiting for server events. New marks upload in the same frame; fading stays batched and bounded. Ranged and melee hits use up to 200 ms of validated target rewind; ranged hits also use footprint rays and walls.

Snapshots use MessagePack, integer pose quantization, changed-field deltas, periodic full recovery, and a 220 m interest radius. Origin/schema/payload/action/message limits, idle input release, exclusive driver ownership and seat assignment, and 15-second reconnect tokens protect session consistency.

Run `bun run bench:physics` and `bun run bench:load` to reproduce the CPU measurements. Evidence and caveats are in [physics decision](docs/physics.md), [load report](docs/load-test.json), and [playtest procedure](docs/playtesting.md). Regression tests cover motion, drift, contacts, fire/explosions, aircraft, AI, inventory, lag compensation, city artifacts, binary deltas, and multiplayer sessions. GitHub CI runs formatting, boundaries, types, tests, and build.

## Hosting

```sh
docker compose up -d --build
```

The production stack runs one non-root Node process and Caddy with HTTPS, WebSockets, health checks, structured proxy logs, and restart policies. Local defaults are https://localhost:8443 and HTTP port 8080. Caddy uses a local CA for localhost; trust that CA on your development machine before browser testing HTTPS. Public deployment uses `DOMAIN=game.example.com`, `HTTP_PORT=80`, and `HTTPS_PORT=443`, with DNS pointing to the host; Caddy then obtains a public certificate. See [operations](docs/operations.md).

WebSocket origin checks support the VibePod gateway's rewritten Host through `X-Forwarded-Host` from its loopback connection. Local proxies must overwrite that header; other peers must preserve Host. Preview HTTP 401 or a password screen requires signing in to the gateway.

`/health` reports ticks, p95/max tick duration, catch-up drops, bytes, rejected messages, entity count, and memory. City geometry persists in the artifact; dynamic players, inventory, traffic damage, and time reset on restart. Use one replica per city. Reconnects restore a session only within the same running process.

## Current limits

The graphics are procedural low-poly models; the urban plateau stays level and building collision volumes are rectangular. Buildings that cross the line between the follow camera and the player dither out as whole objects (screen-door, no alpha blending) so the player stays visible when the camera is next to or inside a tower; their shadows remain. Rural terrain uses a shared triangulated heightfield; characters and cars follow its slopes without full suspension simulation. Ocean surrounds the island, boats stop at the coastline, and an invisible boundary beyond the water blocks players and vehicles at every altitude. Cars remain on land. The city starts with 84 AI traffic cars and 130 pedestrians; these counts remain bounded rather than scaling with map area. There are no interiors, touch controls, accounts, moderation, saves, missions, or advanced destruction. The custom solver is planar with separate altitude, not full suspension/aerodynamics. Local contact prediction estimates remote motion because other players' future inputs are unknown; authoritative corrections can still occur, especially under latency or in pileups. Nearby collision bodies now share the predicted display timeline. Prediction advances at most seven unacknowledged ticks plus one render fraction, then holds that pose until snapshots let it advance again. Up to 60 timestamped inputs remain available for bounded replay; packet bursts catch up smoothly. Server input overflow still preserves recent stops. See [networking research and tests](docs/networking.md). Cosmetic tyre trails use detailed, bounded local tiles across the whole map; they fade after 40 seconds, can differ slightly between clients, and do not persist for late arrivals. Very slow chunk downloads temporarily fall back to authoritative movement until local collision geometry arrives. Traffic recovery is local and can still produce congestion. See the measured Rapier tradeoff before increasing capacity. Sixteen moving clients have been tested locally, not across real WAN infrastructure.

Combat uses textured fire, drifting smoke, gravity-driven sparks, muzzle flashes, and layered explosions. Watercraft leave expanding foam rings and droplets; broken hydrants emit spray and mist. Effects are cosmetic and capped at 96 simultaneous transient layers plus 16 hydrant fountains. Extra layers are skipped under saturation; particles do not collide with walls or terrain.

The server has no GPU requirement. The automated browser uses SwiftShader: its frame times are useful for regression observations but are **not** hardware-client performance evidence. A supplied RTX 4070 sample reached ~165 FPS with rolling p95 35.2 ms; an optimized retest measured p95 9.4 ms but was invalid because the tab became hidden. The user waived further hardware profiling as an acceptance requirement; these remain observations rather than a verified full-minute performance pass. See [the recorded sample](docs/client-hardware-profile.json) and [retest](docs/client-hardware-retest.json). Fonts use Google Fonts with local fallbacks.

Audio uses 149 locally served CC0 clips across 53 sound banks with alternate takes, no immediate sample repeats, and per-bank pitch, volume, and tone variation. Cars blend idle, middle and high rev bands with a quieter coasting layer; load estimates and cosmetic gear changes shape the sound. Dedicated tyre screeches layer over road scrub with slip-driven pitch, intensity and recovery fades. Boats and jet skis use real watercraft motor recordings and wake textures. Nearby aircraft mix a filtered rotor/propeller texture with their motor. Camera-relative panning and bounded Doppler make passing traffic move through the mix. Confirmed snapshots drive car start/stop and action cues; positions, damage, and ownership remain server decisions. N toggles sound. Open `/audio.html` for acceleration, coast, drift and drive-by demos or individual sample auditioning. See the [sound inventory and limits](docs/audio.md) and [source credits](public/audio/CREDITS.md).

Audio uses at most 32 one-shot voices and 32 active loops across six nearby vehicles and ambient effects. Two nearby vehicles within 30 m receive detailed layers, with the player's vehicle taking priority and always keeping its full mix; farther traffic uses a simpler motor mix. RPM, gears and load are audio estimates, not simulated drivetrain state. Rev bands are edited field recordings rather than calibrated recordings across measured RPM/load; coast and aircraft layers are filtered textures. Car ignition cues share AC Cobra recordings across models. There are two footstep surfaces, no wall occlusion, and no voice dialogue. Sample checks verify headroom and loop seams. Listening acceptance from 2026-10-11 predates this vehicle mix; it still needs listening on speakers or headphones.

### Character selection

Before joining, choose a Runner, Regular, or Tank and customize headwear/hair, upper body, legs, skin tone, and shirt colour. Randomize changes the entire character. Appearance and build are saved on this device. The 3D menu preview uses the same model as gameplay.

| Build   | Health | Ground pace |
| ------- | ------ | ----------- |
| Runner  | 80     | 120%        |
| Regular | 100    | 100%        |
| Tank    | 150    | 80%         |

The server owns health and movement. Physiques affect walking and sprinting; swimming, parachutes, jetpacks, vehicles, and collision sizes are shared. Recovery restores the chosen build's health; corpses retain the chosen appearance. Reconnecting preserves the active character. To choose again, refresh and join a new session; there is no in-game wardrobe. The responsive menu works at narrow widths, and gameplay supports keyboard/mouse or a standard gamepad. Protocol version 6 requires clients to refresh after deployment.

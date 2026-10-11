# AFTERHOURS implementation plan

Open a link, choose a name/colour, and join one shared city: walk, drive different cars, fly helicopters, meet pedestrians and traffic, pick up/drop weapons, and make multiplayer stories. The CPU-only server decides gameplay outcomes; the browser renders and predicts movement.

`[x]` means implemented and verified at the foundation scope described below. `[ ]` means outstanding. Update this checklist with evidence when work lands.

## City pipeline

- [x] Generate the city in a separate, manually executed script under `scripts/`; keep generation outside both runtime applications.
- [x] Support seed/output options: `bun run city:generate --seed 713 --out data/city.json`.
- [x] Store a versioned, schema-validated JSON artifact containing buildings, props, parks, ramps, pickups, airfield, and landmarks.
- [x] Load `CITY_PATH` (default `data/city.json`) once at server startup; fail clearly for missing/invalid files without generating a replacement.
- [x] Send a saved-map identity/manifest via `/city` and joining; stream 128 m geometry chunks around the player/camera. Keep the whole city active on the server. Clients have no bundled artifact, generator, or browser-persisted city.
- [x] Deduplicate objects crossing chunk seams; prefetch collision geometry, cancel stale downloads, retry failed chunks, and dispose distant meshes/sign textures/lights. Retain the player collision neighborhood while debug cameras roam. Test map identity, eviction, stale responses, and offscreen simulation.
- [x] Restart to load a replaced artifact; reconnecting clients reload geometry when the server's city differs. Test reproducibility, validation, and startup loading.

## Technology and structure

- [x] Babylon.js/TypeScript client, Vite build, Node/WebSocket server, Zod schemas, MessagePack snapshots, and loading/name/colour entry.
- [x] Separate client rendering, input, camera, prediction/networking, UI, audio, and effects; separate server sessions, scheduling, simulation, AI, combat, inventory, and lifecycle.
- [x] Share contracts, catalogs, tuning, spatial queries, and prediction-safe movement; enforce import boundaries, formatting, and types.
- [ ] Publish the prepared GitHub CI workflow. The local `.github/workflows/ci.yml` is ready, but current GitHub credentials lack `workflow` permission and SSH authentication is unavailable; the game implementation is pushed separately.
- [x] Measure Rapier against the custom contact solver and document the decision in [physics.md](docs/physics.md). Retain the planar solver for this measured capacity; revisit before increasing density or adding advanced destruction.

## Authoritative, responsive multiplayer

- [x] One shared world, 30 Hz authoritative ticks, 120 Hz contact substeps, and 15 Hz snapshots.
- [x] Sequenced/timestamped inputs, acknowledgements, immediate local prediction, reconciliation/replay, correction smoothing, and ownership transitions.
- [x] Predict local vehicle/character contacts against private nearby bodies using the shared mass/angular solver; reconcile position and yaw, replay contacts without modifying snapshots or deciding damage, and prevent correction smoothing through obstacles. Verify delayed collision acknowledgements and parked-car walking.
- [x] Remote interpolation and bounded extrapolation; spatial queries, interest management, quantized binary deltas, and periodic full recovery.
- [x] Smooth local vehicles between input ticks; use a continuous remote render clock and velocity-aware interpolation. Regressions cover 165 Hz rendering with uneven packet arrivals.
- [x] Server-validated interactions/hits, wall occlusion, and bounded weapon lag compensation; schema/origin/payload/action limits and idle control release.
- [x] Test jitter/bursts, stale/malformed inputs, reconnects, snapshot recovery, and exclusive ownership.
- [x] Cap at 16 players based on the latest local 30-second moving-client CPU test: p95 tick 26.19 ms, no catch-up drops, about 26 KB/s per player. The worst tick was 35.40 ms; p95 alone is not a latency guarantee. See [load report](docs/load-test.json); this is not a WAN soak result.

## Playable city and vehicles

- [x] Live connected-player list at the top left, with character colours and a YOU badge; track join/leave/reconnect independently of distance and exclude reconnect ghosts.
- [x] Temporary authoritative prop destruction for palms/trees, park benches, streetlamps, signals and hydrants; impacts, weapons and blasts produce Rapier 3D debris. Preserve the saved map; restore original fixtures after 30 seconds with fading and safe occupancy checks.
- [x] Broken hydrants spray bounded water particles; stream/interpolate debris, keep broken collision masks consistent, restore lights, and dispose unloaded models/fountains.
- [x] Physical corpse bodies persist for 30 seconds, separately from player respawn; exploded vehicles persist for three minutes. Centralize lifetime/fade settings; [scope and evidence](docs/destruction.md).

- [x] Full island map on M: server-provided compact atlas, live player/nearby-player markers, districts/landmarks/ramps, zoom/pan/recentre, Escape/close controls, and idle gameplay input while browsing. Mute moves to N; [verification](docs/map-controls.md).
- [x] Left/right Shift sprint through shared authoritative/predicted movement, independently of vehicle handbrake; retain Space compatibility and update controls.
- [x] Responsive normalized walking/sprinting, acceleration/braking, wall sliding, collision recovery, elevated camera, HUD/minimap, chat, and day/night lighting.
- [x] Keep walking/sprinting into parked cars safe: collision blocking remains, while damage/knockdown requires vehicle contact-point motion toward the character. Regressions cover both entity orders, players/pedestrians, car orientations, departing/creeping cars, and genuine moving-car strikes.
- [x] Four-wheel car forces following [Pat Kerr's vehicle model](https://patkerr.co.uk/2d-vehicles/): rotational contact velocity, front steering torque, rear handbrake grip loss/recovery, and distinct sedan/sport/van tuning.
- [x] Give each vehicle model a seat capacity; support server-assigned driver/passenger seats, shared rides, passenger-safe prediction, independent exits/disconnects, and all-occupant explosion damage. Add a brief helicopter boarding pause; verify capacity/roles/airborne exits in regressions and a shared sedan ride in two browser clients.
- [x] Actual wheel-slip tyre trails with fading/bounded cost; mass/angular contact response, high-speed impacts, and damage.
- [x] Keep tyre marks detailed across the enlarged map: constant-resolution 64 m tiles, rounded rubber bands/grooves aligned to scaled visible wheel mounts, immediate uploads, and bounded GPU tile eviction. Verify distant coordinates, seams, fading, and immediate predicted marks; [browser and test evidence](docs/skid-trails.md).
- [x] Damage smoke, fire countdown, delayed explosion, blast/occupant damage, chain reactions, and wreck cleanup.
- [x] Sparrow/Atlas helicopters: automatic takeoff, WASD flight, roughly 10 m obstacle clearance with roof anticipation, and occupied emergency landing around obstacles.
- [x] Unused aircraft rotors/propellers remain stopped; helicopter ground friction settles collision yaw, and exiting before takeoff cancels lift.
- [x] Plane airspeed/lift/stall, marked airfield, climb/descent, ground braking, and car ramps/jumps. Aircraft physics remains arcade rather than full aerodynamics.
- [x] Replace speed-gated ramp triggers with shared solid wedges: ordinary AI cars climb and jump, side/back approaches collide, and prediction matches server ascent/flight/landing. Generate cosmetic tyre trails from rendered wheels and upload new rubber in the same frame. See [verification](docs/vehicle-response.md).
- [x] Airborne plane/helicopter exit deploys a visible, steerable parachute; authoritative descent, client prediction, street/roof landing, and multiplayer state cleanup verified.
- [x] Empty aircraft continue their course, fall, crash into ground/roofs, and trigger impact damage/fire/explosions; no automatic landing after exit/disconnect.
- [x] Connected traffic routes/destinations, varied cars, lanes, turns, signal queues, and jam recovery; sidewalk/crosswalk pedestrians, avoidance, panic, knockdowns, and recovery.
- [x] Detect persistent traffic jams on the server and gradually despawn unoccupied AI cars. Protect normal signal queues, player vehicles/passengers, burning cars, and wrecks; replenish traffic later on clear lanes away from players. Verify cleanup cadence, progress recovery, safe replacement, and snapshot removal in nine regressions plus a [real-physics traffic scenario](docs/traffic.md).
- [x] District building palettes/heights, parks, storefronts, palms/lamps, landmarks, runway, clear spawn positions, and reachable routes in the generated artifact.
- [x] Procedural models/held weapons, wheel/rotor/plane animation, lighting/shadows, capped particles, engine/combat audio, and development F1 spawn/heal/damage tools.
- [x] Replace synthesized audio with verified CC0 recordings and confirm engine/aircraft, weapons, reload, impact, explosion, and tyre playback. Preserve [asset sources](public/audio/CREDITS.md).

## Weapons and interactions

- [x] Fists/bat/pistol/SMG with server-owned four-slot inventory, equip, ammo, reloads, cooldowns, aiming, melee/hitscan, and combat feedback.
- [x] Actual dropped weapon entities preserve ammo; exclusive pickup, nearest-item interaction prompts, 120-second drop expiry, and 20-second supply replenishment.
- [x] Knockdown/respawn and safe vehicle entry/exit; production debug actions disabled by default.

## Verification and deployment

- [x] Regression coverage for city artifacts, movement, steering/grip, contacts, fire/explosions, AI, aircraft landing, weapons, prediction, codecs, and multiplayer sessions.
- [x] Two-browser UI playtest: shared walking/driving, sport-car drift trails, fire/explosion, automatic helicopter takeoff/flight/landing, and weapon fire/reload/drop/pickup. Record scope in [playtesting.md](docs/playtesting.md).
- [x] Production Docker/Caddy configuration with HTTPS/WSS, health/tick/bandwidth/memory metrics, restart policies, reconnect checks, and explicit dynamic-world reset policy; verified locally, not publicly deployed.
- [x] Maintain setup, controls, architecture, physics decisions, operations, known limits, and this checklist.
- [x] Obtain a real client GPU sample: RTX 4070 / Chrome 152 / 1588x1271, ~165 FPS, rolling frame p95 35.2 ms. See [hardware report](docs/client-hardware-profile.json). The server requires no GPU.
- [x] Waive the full-minute client hardware profiling acceptance requirement at the user's request. Keep the existing samples as observations: the optimized RTX 4070 [retest](docs/client-hardware-retest.json) measured p95 9.4 ms, but `valid:false`; this is not a verified performance pass. No further profiling is required to complete the foundation.

## Development tools

- [x] Implement an agent-accessible debug/test interface: `bun run debug`, reusable `AgentClient`, and `window.afterhoursDebug` inspect state, control normal gameplay input, and execute repeatable scenarios. Validated commands execute on the server; production access is explicitly opt-in. Real transport and production denial are covered by regressions. See [commands and evidence](docs/debugging.md).
- [x] Test complete authoritative and rendered day/night cycles with clock wrap, dawn/noon/dusk/midnight, and continuous transitions. Improve sky gradients, sun/moon, stars, daylight/shadows, readable night ambient light, warm occupied windows, and bounded nearby lamp lighting. Save eight comparable fixed-camera screenshots and [cycle/visual reports](docs/debugging.md#daynight-appearance-and-evidence).
- [x] Add an F1 camera selector for player-follow, elevated free movement/zoom, and first-person flight/look/zoom without fixed zoom caps. Free-camera clipping/fog follow distance. Both debug cameras suppress gameplay input without moving the player and update camera-centered snapshot interest. Browser evidence verifies unchanged player position and idle server input; Escape restores walking. See [camera report](docs/camera-test.json) and [unrestricted zoom check](docs/camera-zoom-test.json).

Further scope after this foundation: WAN/long-duration soak testing, public hosting on a chosen domain, richer art/content, moderation/accounts/persistent progress, and greater player capacity with renewed physics/network budgets.
